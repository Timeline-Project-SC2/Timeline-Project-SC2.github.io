/* Геометрия областей редактора границ (шаг 1 §11 части 2 плана).
 *
 * Мировые координаты `0…10000`; замкнутое кольцо — внешняя граница, остальные
 * кольца — дырки. Открытая линия (`closed: false`) — граница без заливки.
 * Упрощение (RDP) и сглаживание (Chaikin) сохраняют **исходный** параметр
 * вершины — долю длины пути от начала ломаной, `0…1`. Это и есть проекция на
 * исходную геометрию из §6 части 1: градиент считается по исходной ломаной и не
 * «плывёт» при панорамировании и смене LOD.
 */

import type { Area, AreaPoint, AreaStroke, Ring } from './sector-areas-contract.ts';

/** Ломаная с параметрами вершин — результат упрощения и сглаживания. */
export interface ParametrizedRing {
  readonly points: readonly AreaPoint[];
  /** Доля длины исходного пути в вершине: `0…1`, возрастает. */
  readonly params: readonly number[];
  readonly closed: boolean;
}

function isClosedRing(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined) return false;
  return first[0] === last[0] && first[1] === last[1];
}

/** Рабочая ломаная: для замкнутой области повторная конечная точка отбрасывается. */
function workRing(ring: Ring, closed: boolean): AreaPoint[] {
  const points = ring.map((point) => [point[0], point[1]] as AreaPoint);
  if (closed && isClosedRing(points) && points.length > 1) points.pop();
  return points;
}

export function ringLength(ring: Ring, closed = true): number {
  const points = workRing(ring, closed);
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  if (closed && points.length > 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    total += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return total;
}

/** Приводит кольцо к виду «ломаная + параметры вершин» без упрощения. */
export function parametrize(ring: Ring, closed = true): ParametrizedRing {
  const points = workRing(ring, closed);
  return { points, params: paramsOf(points, closed), closed };
}

function paramsOf(points: readonly AreaPoint[], closed: boolean): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [0];
  let total = 0;
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    cumulative.push(total);
  }
  if (closed) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    total += Math.hypot(last[0] - first[0], last[1] - first[1]);
  }
  if (total <= 0) return points.map(() => 0);
  return cumulative.map((value) => value / total);
}

function pointSegmentDistance(p: AreaPoint, a: AreaPoint, b: AreaPoint): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator <= 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/**
 * Упрощение Дугласа–Пекера с допуском `eps` в мировых единицах.
 * Первая и последняя вершины сохраняются всегда; у каждой выжившей вершины
 * остаётся её исходный параметр `params`.
 */
export function simplify(ring: ParametrizedRing, eps: number): ParametrizedRing {
  const { points, params } = ring;
  if (points.length <= 2 || !(eps > 0)) return ring;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (range === undefined) break;
    const [start, end] = range;
    if (end - start < 2) continue;
    const a = points[start]!;
    const b = points[end]!;
    let farthest = -1;
    let maxDistance = 0;
    for (let i = start + 1; i < end; i += 1) {
      const distance = pointSegmentDistance(points[i]!, a, b);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }
    if (farthest > 0 && maxDistance > eps) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }

  const nextPoints: AreaPoint[] = [];
  const nextParams: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i] === 1) {
      nextPoints.push(points[i]!);
      nextParams.push(params[i] ?? 0);
    }
  }
  return { points: nextPoints, params: nextParams, closed: ring.closed };
}

/**
 * Сглаживание Шайкина: `iterations` проходов, параметры вершин интерполируются
 * вместе с координатами. Catmull-Rom здесь не используется — он может выходить
 * за исходную геометрию (§7 части 2).
 */
export function smooth(ring: ParametrizedRing, iterations: number): ParametrizedRing {
  let current: ParametrizedRing = ring;
  const passes = Math.max(0, Math.min(4, Math.floor(iterations)));
  for (let pass = 0; pass < passes; pass += 1) current = chaikinPass(current);
  return current;
}

const CHAIKIN_NEAR = 0.25;
const CHAIKIN_FAR = 0.75;

function chaikinPass(ring: ParametrizedRing): ParametrizedRing {
  const { points, params, closed } = ring;
  if (points.length < 3) return ring;

  const nextPoints: AreaPoint[] = [];
  const nextParams: number[] = [];
  const last = points.length - 1;

  if (!closed) {
    nextPoints.push(points[0]!);
    nextParams.push(params[0] ?? 0);
  }
  for (let i = 0; i < last; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ta = params[i] ?? 0;
    const tb = params[i + 1] ?? 0;
    nextPoints.push([
      a[0] + (b[0] - a[0]) * CHAIKIN_NEAR,
      a[1] + (b[1] - a[1]) * CHAIKIN_NEAR,
    ]);
    nextParams.push(ta + (tb - ta) * CHAIKIN_NEAR);
    nextPoints.push([
      a[0] + (b[0] - a[0]) * CHAIKIN_FAR,
      a[1] + (b[1] - a[1]) * CHAIKIN_FAR,
    ]);
    nextParams.push(ta + (tb - ta) * CHAIKIN_FAR);
  }
  if (closed) {
    const a = points[last]!;
    const b = points[0]!;
    const ta = params[last] ?? 0;
    const tb = params[0] ?? 0;
    // Замыкающий сегмент уходит через конец пути: параметр переносится в `0…1`,
    // чтобы градиент не «прыгал» на шве цикла.
    const wrap = (value: number): number => (value > 1 ? value - 1 : value);
    nextPoints.push([a[0] + (b[0] - a[0]) * CHAIKIN_NEAR, a[1] + (b[1] - a[1]) * CHAIKIN_NEAR]);
    nextParams.push(wrap(ta + (tb - ta + 1) * CHAIKIN_NEAR));
    nextPoints.push([a[0] + (b[0] - a[0]) * CHAIKIN_FAR, a[1] + (b[1] - a[1]) * CHAIKIN_FAR]);
    nextParams.push(wrap(ta + (tb - ta + 1) * CHAIKIN_FAR));
  } else {
    nextPoints.push(points[last]!);
    nextParams.push(params[last] ?? 0);
  }

  return { points: nextPoints, params: nextParams, closed };
}

/** Площадь кольца по формуле шнурования (модуль; обход не важен). */
export function ringArea(ring: Ring, closed = true): number {
  const points = workRing(ring, closed);
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

/** Центр тяжести вершин — справочная точка области (для адреса и детализации). */
export function ringCentroid(ring: Ring, closed = true): AreaPoint {
  const points = workRing(ring, closed);
  if (points.length === 0) return [0, 0];
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point[0];
    y += point[1];
  }
  return [x / points.length, y / points.length];
}

export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function bboxOf(ring: Ring): BBox {
  const points = ring.length > 0 ? ring : [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    minY = Math.min(minY, point[1]);
    maxX = Math.max(maxX, point[0]);
    maxY = Math.max(maxY, point[1]);
  }
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Принадлежность точки кольцу: луч вправо, чётность пересечений. */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Принадлежность точки области: внешнее кольцо минус дырки. */
export function pointInArea(area: Area, x: number, y: number): boolean {
  const outer = area.rings[0];
  if (outer === undefined) return false;
  if (!pointInRing(outer, x, y)) return false;
  for (let i = 1; i < area.rings.length; i += 1) {
    const hole = area.rings[i];
    if (hole !== undefined && pointInRing(hole, x, y)) return false;
  }
  return true;
}

/** Расстояние от точки до ломаной в мировых единицах. */
export function distanceToRing(ring: Ring, x: number, y: number, closed = true): number {
  const points = workRing(ring, closed);
  if (points.length === 0) return Infinity;
  if (points.length === 1) return Math.hypot(x - points[0]![0], y - points[0]![1]);
  let min = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    min = Math.min(min, pointSegmentDistance([x, y], points[i]!, points[i + 1]!));
  }
  if (closed && points.length > 2) {
    min = Math.min(min, pointSegmentDistance([x, y], points[points.length - 1]!, points[0]!));
  }
  return min;
}

function orient(a: AreaPoint, b: AreaPoint, c: AreaPoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsCross(a1: AreaPoint, a2: AreaPoint, b1: AreaPoint, b2: AreaPoint): boolean {
  const d1 = orient(b1, b2, a1);
  const d2 = orient(b1, b2, a2);
  const d3 = orient(a1, a2, b1);
  const d4 = orient(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Число самопересечений замкнутой ломаной. По решению плана это **предупреждение**,
 * а не автоисправление: геометрия админа не переписывается сама.
 */
export function selfIntersections(ring: Ring, closed = true): number {
  const points = workRing(ring, closed);
  const segments: Array<[AreaPoint, AreaPoint]> = [];
  for (let i = 0; i < points.length - 1; i += 1) segments.push([points[i]!, points[i + 1]!]);
  if (closed && points.length > 2) segments.push([points[points.length - 1]!, points[0]!]);

  let count = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 2; j < segments.length; j += 1) {
      const isClosingPair = i === 0 && j === segments.length - 1;
      if (isClosingPair) continue;
      const first = segments[i]!;
      const second = segments[j]!;
      if (segmentsCross(first[0], first[1], second[0], second[1])) count += 1;
    }
  }
  return count;
}

/** Все вершины внутреннего кольца лежат внутри внешнего — проверка каскада. */
export function ringContainsRing(outer: Ring, inner: Ring): boolean {
  return inner.every((point) => pointInRing(outer, point[0], point[1]));
}

export function totalVertices(area: Area): number {
  return area.rings.reduce((sum, ring) => sum + ring.length, 0);
}

/** Точка на ломаной по параметру `t` (`0…1`) — для выборок градиента. */
export function pointAt(ring: ParametrizedRing, t: number): AreaPoint {
  const { points, params } = ring;
  if (points.length === 0) return [0, 0];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < points.length; i += 1) {
    const previous = params[i - 1] ?? 0;
    const next = params[i] ?? 1;
    if (clamped <= next || i === points.length - 1) {
      const span = next - previous;
      const local = span <= 0 ? 0 : (clamped - previous) / span;
      const a = points[i - 1]!;
      const b = points[i]!;
      return [a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local];
    }
  }
  return points[0]!;
}

/* ----------------------------------------------------------- геометрия штрихов */

/** Замкнутое кольцо для замкнутого штриха (для совместимости с операциями колец, например `override`). */
export function closedStrokeRing(stroke: AreaStroke): Ring {
  const vertices = workRing(stroke.points, stroke.closed);
  if (!stroke.closed || vertices.length === 0) return vertices;
  const first = vertices[0]!;
  return [...vertices, [first[0], first[1]]];
}

/** Длина отдельного штриха в мировых единицах. */
export function strokeLength(stroke: AreaStroke): number {
  return ringLength(stroke.points, stroke.closed);
}

/** Площадь отдельного штриха (`0` для незамкнутого штриха). */
export function strokeArea(stroke: AreaStroke): number {
  if (!stroke.closed) return 0;
  return ringArea(stroke.points, true);
}

/** Суммарная площадь всех замкнутых штрихов списка (не смешивается с дырками `rings`). */
export function strokesArea(strokes: readonly AreaStroke[]): number {
  let total = 0;
  for (const stroke of strokes) {
    total += strokeArea(stroke);
  }
  return total;
}

/** Центроид отдельного штриха. */
export function strokeCentroid(stroke: AreaStroke): AreaPoint {
  return ringCentroid(stroke.points, stroke.closed);
}

/** Охватывающий прямоугольник набора штрихов (`null`, если точек нет). */
export function strokesBBox(strokes: readonly AreaStroke[]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
      count += 1;
    }
  }
  if (count === 0) return null;
  return { minX, minY, maxX, maxY };
}

/** Справочный центр области по внешнему кольцу или (при пустых `rings`) по штрихам. */
export function areaCentroid(area: Area): AreaPoint | null {
  const outer = area.rings[0];
  if (outer !== undefined && outer.length > 0) {
    return ringCentroid(outer, area.closed);
  }
  const strokes = area.strokes ?? [];
  if (strokes.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const c = strokeCentroid(stroke);
    sx += c[0];
    sy += c[1];
    count += 1;
  }
  if (count === 0) return null;
  return [sx / count, sy / count];
}

/** Параметризация отдельного штриха (`0…1` вдоль исходной ломаной). */
export function parametrizeStroke(stroke: AreaStroke): ParametrizedRing {
  return parametrize(stroke.points, stroke.closed);
}

/** Упрощение и сглаживание отдельного штриха для отрисовки на заданном уровне детализации. */
export function simplifyStroke(
  stroke: AreaStroke,
  eps: number,
  roundingPasses: number = 0,
): ParametrizedRing {
  const simplified = simplify(parametrizeStroke(stroke), eps);
  return roundingPasses > 0 ? smooth(simplified, roundingPasses) : simplified;
}

/** Расстояние от точки до контура штриха в мировых единицах. */
export function distanceToStroke(stroke: AreaStroke, x: number, y: number): number {
  return distanceToRing(stroke.points, x, y, stroke.closed);
}

/**
 * Попадание точки в отдельный штрих: для замкнутого — внутри контура (или в пределах
 * `hitTolerance` от границы), для открытого — в пределах `hitTolerance` от ломаной.
 */
export function pointInStroke(
  stroke: AreaStroke,
  x: number,
  y: number,
  hitTolerance: number = 0,
): boolean {
  const vertices = workRing(stroke.points, stroke.closed);
  if (vertices.length < 2) return false;
  if (stroke.closed && vertices.length >= 3 && pointInRing(vertices, x, y)) {
    return true;
  }
  return hitTolerance > 0 && distanceToStroke(stroke, x, y) <= hitTolerance;
}

/** Число самопересечений отдельного штриха. */
export function strokeSelfIntersections(stroke: AreaStroke): number {
  return selfIntersections(stroke.points, stroke.closed);
}

/** Число точек во всех штрихах области (отдельно от `totalVertices`, считающего `rings`). */
export function strokeVertices(area: Area): number {
  return (area.strokes ?? []).reduce((sum, stroke) => sum + stroke.points.length, 0);
}

/** Попадание указателя в область: `pointInArea` по кольцам (с учётом дырок) либо попадание в любой штрих. */
export function pointHitsArea(
  area: Area,
  x: number,
  y: number,
  openStrokeTolerance: number = 0,
): boolean {
  if (pointInArea(area, x, y)) return true;
  for (const stroke of area.strokes ?? []) {
    if (pointInStroke(stroke, x, y, openStrokeTolerance)) return true;
  }
  return false;
}
