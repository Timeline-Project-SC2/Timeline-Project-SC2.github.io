/**
 * Привязка контуров и штрихов к рёбрам отображаемой адресной сетки в мировых координатах.
 *
 * Правила расчёта:
 * - Источник рёбер — мельчайший отображаемый в текущем кадре ярус адресной сетки
 *   (`nested`, если виден, иначе `primary`) в мировых координатах карты `[0, 10 000]²`.
 * - Цена кандидата ребра `e` для точки эскиза `p`:
 *     `C(e) = d(p, e)² + 0,25 · s² · (1 − |u · t|)²`,
 *   где `d(p, e)` — расстояние от `p` до ближайшей точки на сегменте `e`,
 *   `u` — локальное единичное направление штриха, `t` — единичное направление ребра,
 *   `s` — размер ячейки (`cellSize`) выбранного отображаемого яруса, `λ = 0,25` фиксирован.
 * - Максимальный порог расстояния и поведенческий угловой порог не вводятся.
 * - Численный допуск сравнения цен `SNAP_COST_REL_TOLERANCE = 1e-9` безразмерен
 *   (нормируется на `max(s², minCost)`), поэтому не зависит от масштаба яруса.
 * - При равенстве цены в пределах численного допуска кандидат выбирается устойчиво
 *   по лексикографическому ключу `(tier, row, col, orientation)`.
 */

import { MAP_SIZE } from './sector-address.ts';
import type { AreaPoint } from './sector-areas-contract.ts';
import {
  displayedGridTierFor,
  gridEdgesForTierInBounds,
} from './sector-scene.ts';
import type {
  DisplayedGridTier,
  FrameViewport,
  GridEdgeOrientation,
  GridWorldEdge,
  SceneCamera,
} from './sector-scene.ts';

/** Фиксированный вес направленного штрафа `λ = 0,25` в формуле цены ребра. */
export const SNAP_DIRECTION_WEIGHT = 0.25;

/**
 * Безразмерный относительный допуск сравнения цен кандидатов (`1e-9`).
 * Два ребра считаются равноценными при `C(e) − C_min ≤ 1e-9 · max(s², C_min)`.
 */
export const SNAP_COST_REL_TOLERANCE = 1e-9;

/**
 * Безразмерное полуокно сглаживания локального направления штриха в долях `s`
 * (`±0,125 · s`, полное окно дуги `0,25 · s`). Не зависит от масштаба яруса.
 */
export const SNAP_DIRECTION_HALF_WINDOW_CELLS = 0.125;

/** Шаг разбиения длинных хорд эскиза в долях `s` для обхода соседних ячеек. */
const SNAP_SUBDIVIDE_STEP_CELLS = 0.25;

/** Радиус локального окна глобального поиска в ячейках (`3 · s` даёт запас `> 8,5 · s²`). */
const GLOBAL_SEARCH_WINDOW_CELLS = 3;

const EPSILON = 1e-12;

/** Оценка одного ребра-кандидата для точки эскиза. */
export interface GridEdgeEvaluation {
  readonly edge: GridWorldEdge;
  readonly snappedPoint: AreaPoint;
  readonly distanceSq: number;
  /** Модуль скалярного произведения `|u · t| ∈ [0, 1]`. */
  readonly alignment: number;
  readonly cost: number;
}

/** Локальный участок контура, прошедший вдоль одного ребра сетки. */
export interface SnappedEdgeRun {
  readonly edge: GridWorldEdge;
  readonly startPoint: AreaPoint;
  readonly endPoint: AreaPoint;
}

/** Итог привязки штриха к рёбрам адресной сетки. */
export interface SnappedStrokeResult {
  readonly tier: DisplayedGridTier | null;
  readonly points: readonly AreaPoint[];
  /** Последовательность выбранных рёбер по ходу контура (включая соседние ячейки). */
  readonly runs: readonly SnappedEdgeRun[];
}

/** Параметры привязки контура к явно переданному списку рёбер. */
export interface SnapToEdgesOptions {
  readonly closed?: boolean;
  readonly relTolerance?: number;
  readonly directionHalfWindowCells?: number;
}

function orientationRank(orientation: GridEdgeOrientation): number {
  return orientation === 'horizontal' ? 0 : 1;
}

/**
 * Детерминированное сравнение ключей рёбер `(tier, row, col, orientation)`.
 * Горизонтальное ребро предшествует вертикальному при совпадающих `(tier, row, col)`.
 */
export function compareGridEdgeKey(a: GridWorldEdge, b: GridWorldEdge): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.row !== b.row) return a.row - b.row;
  if (a.col !== b.col) return a.col - b.col;
  return orientationRank(a.orientation) - orientationRank(b.orientation);
}

function sameEdgeKey(a: GridWorldEdge, b: GridWorldEdge): boolean {
  return compareGridEdgeKey(a, b) === 0;
}

/** Нормализует вектор направления; для нулевого вектора возвращает `null`. */
export function normalizeDirection(dx: number, dy: number): AreaPoint | null {
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len <= EPSILON) return null;
  return [dx / len, dy / len];
}

function edgeUnitTangent(edge: GridWorldEdge): AreaPoint {
  return normalizeDirection(edge.x2 - edge.x1, edge.y2 - edge.y1) ?? [1, 0];
}

/** Ближайшая точка на отрезке `(x1, y1) → (x2, y2)` к точке `(px, py)`. */
export function nearestPointOnEdge(
  point: AreaPoint,
  edge: GridWorldEdge,
): { readonly snappedPoint: AreaPoint; readonly distanceSq: number } {
  const dx = edge.x2 - edge.x1;
  const dy = edge.y2 - edge.y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= EPSILON) {
    const ox = point[0] - edge.x1;
    const oy = point[1] - edge.y1;
    return {
      snappedPoint: [edge.x1, edge.y1],
      distanceSq: ox * ox + oy * oy,
    };
  }
  const rawT = ((point[0] - edge.x1) * dx + (point[1] - edge.y1) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const qx = edge.x1 + dx * t;
  const qy = edge.y1 + dy * t;
  const ox = point[0] - qx;
  const oy = point[1] - qy;
  return {
    snappedPoint: [qx, qy],
    distanceSq: ox * ox + oy * oy,
  };
}

/**
 * Вычисляет цену кандидата по формуле владельца:
 * `C(e) = d(p, e)² + 0,25 · s² · (1 − |u · t|)²`.
 *
 * Если локальное направление `u` вырождено (`null`, например у одиночной точки),
 * направленное расхождение считается нулевым (`|u · t| = 1`).
 */
export function evaluateGridEdgeCost(
  point: AreaPoint,
  direction: AreaPoint | null,
  edge: GridWorldEdge,
): GridEdgeEvaluation {
  const { snappedPoint, distanceSq } = nearestPointOnEdge(point, edge);
  const unitDir = direction === null ? null : normalizeDirection(direction[0], direction[1]);
  const tangent = edgeUnitTangent(edge);
  const alignment = unitDir === null
    ? 1
    : Math.min(1, Math.abs(unitDir[0] * tangent[0] + unitDir[1] * tangent[1]));
  const mismatch = 1 - alignment;
  const s = edge.cellSize;
  const cost = distanceSq + SNAP_DIRECTION_WEIGHT * s * s * mismatch * mismatch;
  return {
    edge,
    snappedPoint,
    distanceSq,
    alignment,
    cost,
  };
}

/**
 * Выбирает лучшее ребро из произвольного набора кандидатов без ограничения дальности.
 * Все кандидаты в пределах относительного допуска `relTolerance` от глобального
 * минимума разрешаются строго по ключу `(tier, row, col, orientation)`.
 */
export function pickBestGridEdge(
  point: AreaPoint,
  direction: AreaPoint | null,
  candidates: readonly GridWorldEdge[],
  relTolerance: number = SNAP_COST_REL_TOLERANCE,
): GridEdgeEvaluation | null {
  if (candidates.length === 0) return null;

  const evaluations: GridEdgeEvaluation[] = [];
  let minCost = Number.POSITIVE_INFINITY;
  let minScaleSq = Number.POSITIVE_INFINITY;

  for (const edge of candidates) {
    const evaluated = evaluateGridEdgeCost(point, direction, edge);
    evaluations.push(evaluated);
    if (evaluated.cost < minCost) minCost = evaluated.cost;
    const scaleSq = edge.cellSize * edge.cellSize;
    if (scaleSq < minScaleSq) minScaleSq = scaleSq;
  }

  const refScale = Math.max(Number.isFinite(minScaleSq) ? minScaleSq : 1, minCost, EPSILON);
  const absTolerance = Math.max(0, relTolerance) * refScale;

  let winner: GridEdgeEvaluation | null = null;
  for (const evaluated of evaluations) {
    if (evaluated.cost - minCost > absTolerance) continue;
    if (winner === null || compareGridEdgeKey(evaluated.edge, winner.edge) < 0) {
      winner = evaluated;
    }
  }
  return winner;
}

/**
 * Находит глобально оптимальное ребро указанного яруса по всему полю `[0, MAP_SIZE]²`
 * без порога максимального расстояния.
 *
 * Доказательство точности локального окна вокруг проекции `c = clamp(p, 0, MAP_SIZE)`:
 * в ячейке точки `c` всегда есть ребро с ценой `≤ ‖p − c‖² + 0,5 · s²`, тогда как любое
 * ребро вне окна `[c_x − 3s, c_x + 3s] × [c_y − 3s, c_y + 3s]` имеет `d(p, e)² ≥ ‖p − c‖² + 9 · s²`
 * и не может попасть даже близко к минимуму.
 */
export function snapPointToTierGrid(
  point: AreaPoint,
  direction: AreaPoint | null,
  tier: number,
  cellSize: number,
  relTolerance: number = SNAP_COST_REL_TOLERANCE,
): GridEdgeEvaluation | null {
  const clampedX = Math.max(0, Math.min(MAP_SIZE, point[0]));
  const clampedY = Math.max(0, Math.min(MAP_SIZE, point[1]));
  const pad = GLOBAL_SEARCH_WINDOW_CELLS * cellSize;
  const candidates = gridEdgesForTierInBounds(tier, {
    x0: clampedX - pad,
    y0: clampedY - pad,
    x1: clampedX + pad,
    y1: clampedY + pad,
  });
  return pickBestGridEdge(point, direction, candidates, relTolerance);
}

/** Привязывает одну точку и направление к мельчайшему отображаемому ярусу сетки кадра. */
export function snapPointToDisplayedGrid(
  point: AreaPoint,
  direction: AreaPoint | null,
  viewport: FrameViewport,
  camera: SceneCamera,
): GridEdgeEvaluation | null {
  const tier = displayedGridTierFor(viewport, camera);
  if (tier === null) return null;
  return snapPointToTierGrid(point, direction, tier.tier, tier.cellSize);
}

function stripClosingDuplicate(points: readonly AreaPoint[], closed: boolean): AreaPoint[] {
  const copy = points.map((p): AreaPoint => [p[0], p[1]]);
  if (!closed || copy.length < 2) return copy;
  const first = copy[0]!;
  const last = copy[copy.length - 1]!;
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) {
    copy.pop();
  }
  return copy;
}

/** Разбивает длинные хорды ломаной с шагом `≤ maxStep`, сохраняя исходные вершины. */
function densifyPolyline(
  vertices: readonly AreaPoint[],
  closed: boolean,
  maxStep: number,
): AreaPoint[] {
  if (vertices.length <= 1 || !(maxStep > EPSILON)) {
    return vertices.map((p): AreaPoint => [p[0], p[1]]);
  }

  const result: AreaPoint[] = [];
  const edgeCount = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < edgeCount; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    if (i === 0) result.push([a[0], a[1]]);
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    for (let step = 1; step <= steps; step += 1) {
      if (closed && i === edgeCount - 1 && step === steps) continue;
      const t = step / steps;
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return result;
}

interface ArcPolyline {
  readonly samples: readonly AreaPoint[];
  readonly cumulative: readonly number[];
  readonly totalLength: number;
  readonly closed: boolean;
}

function buildArcPolyline(samples: readonly AreaPoint[], closed: boolean): ArcPolyline {
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cumulative.push(total);
  }
  if (closed && samples.length >= 2) {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    total += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return { samples, cumulative, totalLength: total, closed };
}

function sampleAtArcLength(arc: ArcPolyline, rawS: number): AreaPoint {
  const n = arc.samples.length;
  if (n === 0) return [0, 0];
  if (n === 1 || arc.totalLength <= EPSILON) return arc.samples[0]!;

  let s = rawS;
  if (arc.closed) {
    s = ((rawS % arc.totalLength) + arc.totalLength) % arc.totalLength;
  } else {
    s = Math.max(0, Math.min(arc.totalLength, rawS));
  }

  const lastOpenArc = arc.cumulative[n - 1]!;
  if (s >= lastOpenArc) {
    if (!arc.closed) return arc.samples[n - 1]!;
    const segLen = arc.totalLength - lastOpenArc;
    if (segLen <= EPSILON) return arc.samples[0]!;
    const t = (s - lastOpenArc) / segLen;
    const a = arc.samples[n - 1]!;
    const b = arc.samples[0]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if ((arc.cumulative[mid] ?? 0) <= s) lo = mid;
    else hi = mid;
  }
  const s0 = arc.cumulative[lo]!;
  const s1 = arc.cumulative[hi]!;
  const segLen = s1 - s0;
  if (segLen <= EPSILON) return arc.samples[lo]!;
  const t = (s - s0) / segLen;
  const a = arc.samples[lo]!;
  const b = arc.samples[hi]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Сглаженное локальное направление в точке дуги `sCenter` с полуокном `halfWindow`. */
function smoothedDirectionAt(
  arc: ArcPolyline,
  sampleIndex: number,
  halfWindow: number,
): AreaPoint | null {
  if (arc.samples.length < 2 || arc.totalLength <= EPSILON) return null;
  const center = arc.cumulative[sampleIndex] ?? 0;
  const w = Math.max(halfWindow, arc.totalLength * 1e-6);
  const back = sampleAtArcLength(arc, center - w);
  const ahead = sampleAtArcLength(arc, center + w);
  const primary = normalizeDirection(ahead[0] - back[0], ahead[1] - back[1]);
  if (primary !== null) return primary;

  const prevIdx = sampleIndex > 0
    ? sampleIndex - 1
    : (arc.closed ? arc.samples.length - 1 : 0);
  const nextIdx = sampleIndex + 1 < arc.samples.length
    ? sampleIndex + 1
    : (arc.closed ? 0 : arc.samples.length - 1);
  const p0 = arc.samples[prevIdx]!;
  const p1 = arc.samples[nextIdx]!;
  return normalizeDirection(p1[0] - p0[0], p1[1] - p0[1]);
}

/** Группа последовательных привязанных точек, лежащих на одной прямой сетки. */
interface AxisLineGroup {
  readonly orientation: GridEdgeOrientation;
  /** Постоянная координата прямой (`y` для горизонтальной, `x` для вертикальной). */
  readonly lineCoord: number;
  readonly cellSize: number;
  points: AreaPoint[];
}

function lineCoordOf(edge: GridWorldEdge): number {
  return edge.orientation === 'horizontal' ? edge.y1 : edge.x1;
}

function axisCoord(point: AreaPoint, orientation: GridEdgeOrientation): number {
  return orientation === 'horizontal' ? point[0] : point[1];
}

function samePoint(a: AreaPoint, b: AreaPoint, eps: number = 1e-6): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps;
}

function trimOvershootBeforeCorner(
  points: readonly AreaPoint[],
  orientation: GridEdgeOrientation,
  cornerAxis: number,
  preserveFirst: boolean,
): AreaPoint[] {
  if (points.length <= 1) return [...points];
  const anchor = axisCoord(points[0]!, orientation);
  const anchorDelta = anchor - cornerAxis;
  if (Math.abs(anchorDelta) <= 1e-6) {
    return preserveFirst ? [points[0]!] : [];
  }
  const minKeep = preserveFirst ? 1 : 0;
  let end = points.length;
  while (end > minKeep) {
    const currentDelta = axisCoord(points[end - 1]!, orientation) - cornerAxis;
    if (anchorDelta * currentDelta < -1e-6) {
      end -= 1;
    } else {
      break;
    }
  }
  return points.slice(0, end);
}

function trimOvershootAfterCorner(
  points: readonly AreaPoint[],
  orientation: GridEdgeOrientation,
  cornerAxis: number,
  preserveLast: boolean,
): AreaPoint[] {
  if (points.length <= 1) return [...points];
  const anchor = axisCoord(points[points.length - 1]!, orientation);
  const anchorDelta = anchor - cornerAxis;
  if (Math.abs(anchorDelta) <= 1e-6) {
    return preserveLast ? [points[points.length - 1]!] : [];
  }
  const maxDrop = preserveLast ? points.length - 1 : points.length;
  let start = 0;
  while (start < maxDrop) {
    const currentDelta = axisCoord(points[start]!, orientation) - cornerAxis;
    if (anchorDelta * currentDelta < -1e-6) {
      start += 1;
    } else {
      break;
    }
  }
  return points.slice(start);
}

function compressCollinearPolyline(points: readonly AreaPoint[], closed: boolean): AreaPoint[] {
  const deduped: AreaPoint[] = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (prev === undefined || !samePoint(prev, point)) {
      deduped.push(point);
    }
  }
  if (closed && deduped.length >= 2 && samePoint(deduped[0]!, deduped[deduped.length - 1]!)) {
    deduped.pop();
  }
  if (deduped.length <= 2) return deduped;

  const isCollinear = (a: AreaPoint, b: AreaPoint, c: AreaPoint): boolean => {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const bcx = c[0] - b[0];
    const bcy = c[1] - b[1];
    const lenA = Math.hypot(abx, aby);
    const lenB = Math.hypot(bcx, bcy);
    if (lenA <= 1e-6 || lenB <= 1e-6) return true;
    const cross = Math.abs(abx * bcy - aby * bcx) / (lenA * lenB);
    const dot = (abx * bcx + aby * bcy) / (lenA * lenB);
    return cross <= 1e-6 && dot > 0;
  };

  const simplified: AreaPoint[] = [];
  for (const point of deduped) {
    while (
      simplified.length >= 2
      && isCollinear(simplified[simplified.length - 2]!, simplified[simplified.length - 1]!, point)
    ) {
      simplified.pop();
    }
    simplified.push(point);
  }

  if (closed && simplified.length >= 3) {
    let changed = true;
    while (changed && simplified.length >= 3) {
      changed = false;
      const first = simplified[0]!;
      const second = simplified[1]!;
      const last = simplified[simplified.length - 1]!;
      const prevLast = simplified[simplified.length - 2]!;
      if (isCollinear(prevLast, last, first)) {
        simplified.pop();
        changed = true;
      } else if (isCollinear(last, first, second)) {
        simplified.shift();
        changed = true;
      }
    }
  }

  return simplified;
}

/**
 * Собирает итоговый контур из привязанных выборок:
 * - объединяет коллинеарные соседние рёбра одной прямой сетки без обрыва на границах ячеек;
 * - на поворотах между перпендикулярными прямыми сетки начинает новый локальный сегмент
 *   через точный узел пересечения рёбер, убирая микровыброс на угле.
 */
function assembleSnappedContour(
  evaluations: readonly GridEdgeEvaluation[],
  closed: boolean,
): { readonly points: readonly AreaPoint[]; readonly runs: readonly SnappedEdgeRun[] } {
  if (evaluations.length === 0) return { points: [], runs: [] };

  const runs: SnappedEdgeRun[] = [];
  for (const item of evaluations) {
    const prev = runs[runs.length - 1];
    if (prev !== undefined && sameEdgeKey(prev.edge, item.edge)) {
      runs[runs.length - 1] = {
        edge: prev.edge,
        startPoint: prev.startPoint,
        endPoint: item.snappedPoint,
      };
    } else {
      runs.push({
        edge: item.edge,
        startPoint: item.snappedPoint,
        endPoint: item.snappedPoint,
      });
    }
  }

  const groups: AxisLineGroup[] = [];
  for (const item of evaluations) {
    const coord = lineCoordOf(item.edge);
    const prev = groups[groups.length - 1];
    if (
      prev !== undefined
      && prev.orientation === item.edge.orientation
      && Math.abs(prev.lineCoord - coord) <= 1e-6
    ) {
      prev.points.push(item.snappedPoint);
    } else {
      groups.push({
        orientation: item.edge.orientation,
        lineCoord: coord,
        cellSize: item.edge.cellSize,
        points: [item.snappedPoint],
      });
    }
  }

  if (
    closed
    && groups.length >= 2
    && groups[0]!.orientation === groups[groups.length - 1]!.orientation
    && Math.abs(groups[0]!.lineCoord - groups[groups.length - 1]!.lineCoord) <= 1e-6
  ) {
    const tail = groups.pop()!;
    groups[0]!.points = [...tail.points, ...groups[0]!.points];
  }

  if (groups.length === 1) {
    const single = groups[0]!;
    const raw = single.points.length >= 2
      ? [single.points[0]!, single.points[single.points.length - 1]!]
      : single.points;
    return {
      points: compressCollinearPolyline(raw, closed),
      runs,
    };
  }

  const cornerCount = closed ? groups.length : groups.length - 1;
  const corners: (AreaPoint | null)[] = new Array<AreaPoint | null>(cornerCount).fill(null);

  for (let i = 0; i < cornerCount; i += 1) {
    const nextIdx = (i + 1) % groups.length;
    const left = groups[i]!;
    const right = groups[nextIdx]!;
    if (left.orientation === right.orientation) continue;

    const corner: AreaPoint = left.orientation === 'horizontal'
      ? [right.lineCoord, left.lineCoord]
      : [left.lineCoord, right.lineCoord];
    const leftEnd = left.points[left.points.length - 1]!;
    const rightStart = right.points[0]!;
    const maxJoin = Math.max(left.cellSize, right.cellSize);

    if (
      Math.hypot(leftEnd[0] - corner[0], leftEnd[1] - corner[1]) <= maxJoin
      && Math.hypot(rightStart[0] - corner[0], rightStart[1] - corner[1]) <= maxJoin
    ) {
      const preserveLeftFirst = !closed && i === 0;
      const preserveRightLast = !closed && nextIdx === groups.length - 1;
      const cornerLeftAxis = axisCoord(corner, left.orientation);
      const cornerRightAxis = axisCoord(corner, right.orientation);
      left.points = trimOvershootBeforeCorner(
        left.points,
        left.orientation,
        cornerLeftAxis,
        preserveLeftFirst,
      );
      right.points = trimOvershootAfterCorner(
        right.points,
        right.orientation,
        cornerRightAxis,
        preserveRightLast,
      );
      corners[i] = corner;
    }
  }

  const assembled: AreaPoint[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]!;
    if (group.points.length === 1) {
      assembled.push(group.points[0]!);
    } else if (group.points.length >= 2) {
      assembled.push(group.points[0]!, group.points[group.points.length - 1]!);
    }
    if (i < cornerCount && corners[i] !== null) {
      assembled.push(corners[i]!);
    }
  }

  const compressed = compressCollinearPolyline(assembled, closed);
  return {
    points: compressed,
    runs,
  };
}

function alignClosedStart(points: readonly AreaPoint[], referenceStart: AreaPoint): readonly AreaPoint[] {
  if (points.length <= 1) return points;
  let bestIdx = 0;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i]!;
    const dx = p[0] - referenceStart[0];
    const dy = p[1] - referenceStart[1];
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIdx = i;
    }
  }
  if (bestIdx === 0) return points;
  return [...points.slice(bestIdx), ...points.slice(0, bestIdx)];
}

function snapPolylineWithPicker(
  points: readonly AreaPoint[],
  cellSize: number,
  pickEdge: (point: AreaPoint, direction: AreaPoint | null) => GridEdgeEvaluation | null,
  options?: SnapToEdgesOptions,
): { readonly points: readonly AreaPoint[]; readonly runs: readonly SnappedEdgeRun[] } {
  const closed = options?.closed ?? false;
  const stripped = stripClosingDuplicate(points, closed);
  if (stripped.length === 0) return { points: [], runs: [] };

  if (stripped.length === 1) {
    const single = pickEdge(stripped[0]!, null);
    if (single === null) return { points: [stripped[0]!], runs: [] };
    return {
      points: [single.snappedPoint],
      runs: [{ edge: single.edge, startPoint: single.snappedPoint, endPoint: single.snappedPoint }],
    };
  }

  const step = Math.max(cellSize * SNAP_SUBDIVIDE_STEP_CELLS, 1e-4);
  const samples = densifyPolyline(stripped, closed, step);
  const arc = buildArcPolyline(samples, closed);
  const halfWindow = Math.max(
    0,
    options?.directionHalfWindowCells ?? SNAP_DIRECTION_HALF_WINDOW_CELLS,
  ) * cellSize;

  const evaluations: GridEdgeEvaluation[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    const direction = smoothedDirectionAt(arc, i, halfWindow);
    const chosen = pickEdge(sample, direction);
    if (chosen !== null) evaluations.push(chosen);
  }

  if (evaluations.length === 0) {
    return { points: stripped, runs: [] };
  }
  const assembled = assembleSnappedContour(evaluations, closed);
  return {
    points: closed ? alignClosedStart(assembled.points, stripped[0]!) : assembled.points,
    runs: assembled.runs,
  };
}

/**
 * Привязывает ломаную или замкнутый контур к явно заданному списку мировых рёбер
 * адресной сетки (удобно для модульных проверок произвольных конфигураций рёбер).
 */
export function snapStrokeToEdges(
  points: readonly AreaPoint[],
  candidates: readonly GridWorldEdge[],
  options?: SnapToEdgesOptions,
): { readonly points: readonly AreaPoint[]; readonly runs: readonly SnappedEdgeRun[] } {
  if (candidates.length === 0) {
    return {
      points: stripClosingDuplicate(points, options?.closed ?? false),
      runs: [],
    };
  }
  const cellSize = candidates[0]!.cellSize;
  const relTolerance = options?.relTolerance ?? SNAP_COST_REL_TOLERANCE;
  return snapPolylineWithPicker(
    points,
    cellSize,
    (point, direction) => pickBestGridEdge(point, direction, candidates, relTolerance),
    options,
  );
}

/**
 * Привязывает контур к мировым рёбрам заданного яруса адресной сетки
 * (`tier`, `cellSize`) без ограничения одним прямоугольником и без порога дальности.
 */
export function snapStrokeToTierGrid(
  points: readonly AreaPoint[],
  tier: DisplayedGridTier,
  options?: SnapToEdgesOptions,
): SnappedStrokeResult {
  const relTolerance = options?.relTolerance ?? SNAP_COST_REL_TOLERANCE;
  const snapped = snapPolylineWithPicker(
    points,
    tier.cellSize,
    (point, direction) => snapPointToTierGrid(point, direction, tier.tier, tier.cellSize, relTolerance),
    options,
  );
  return {
    tier,
    points: snapped.points,
    runs: snapped.runs,
  };
}

/**
 * Привязывает контур к мельчайшему отображаемому в кадре ярусу адресной сетки
 * (`nested`, если виден, иначе `primary`). Если сетка не отображается, возвращает
 * исходные точки без изменений и `tier: null`.
 */
export function snapStrokeToDisplayedGrid(
  points: readonly AreaPoint[],
  viewport: FrameViewport,
  camera: SceneCamera,
  options?: SnapToEdgesOptions,
): SnappedStrokeResult {
  const tier = displayedGridTierFor(viewport, camera);
  if (tier === null) {
    return {
      tier: null,
      points: stripClosingDuplicate(points, options?.closed ?? false),
      runs: [],
    };
  }
  return snapStrokeToTierGrid(points, tier, options);
}
