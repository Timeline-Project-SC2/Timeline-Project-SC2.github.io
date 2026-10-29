/* Модель сцены сектора: примитивы для отрисовки без DOM и без canvas.
 *
 * Модуль ничего не рисует и ни к чему не подключён: на вход идут данные систем,
 * камера и размер кадра, на выход — плоский список примитивов в порядке слоёв
 * плана §8.1 (границы сектора → сетка → системы → апертура → подписи). Рантайм-проводка
 * (`canvas-renderer.ts`) — отдельный слот, поэтому здесь нет обращений к DOM,
 * графического контекста и цикла кадров.
 *
 * Все пороги глубины берутся из `level-ladder.ts` (`levelForWidth`,
 * `visibleWidthForLevel`, `levelSpec`, `markerDiameter`) — своих формул уровня
 * и размера маркера модуль не содержит (инвариант И-8, §10.3).
 *
 * Числа и их источник:
 *   — диаметр маркера — `markerDiameter(visibleWidth)` по §6.2 (кламп 2,5…40 px);
 *   — слияние ближе `1,6 · d` — §6.2 п. 3; хит-зона `d + 6 px` и `≥ 44 px`
 *     на сенсорном экране — §6.2 п. 5;
 *   — бюджет кадра уровня — `frameBudgetMs` из `LEVELS` (§6, §8.4);
 *   — границы сектора и гало `L0…L9`, сетка адресов `L0…L12` по `gridTiersFor`
 *     (два тира, `alpha 0,16`/`0,07`), апертура ровно на `L12` — §8.1, §17.3, Z-4d;
 *   — подпись на уровне — колонка «Подпись» таблицы §6.2, приоритет
 *     «столица → фракция → плотность» — §8.1;
 *   — бюджет подписей `120` — `LABEL_BUDGET` из `label-layout.ts` (§6, §8.1).
 */

import { ADDRESS_TIERS, MAP_SIZE, addressOf, formatAddress, prefixOf } from './sector-address.ts';
import type { AddressLetters } from './sector-address.ts';
import type { Point, SectorBounds } from './sector-bounds.ts';
import type { NebulaBlink } from './nebula-model.ts';
import type { LabelLayoutResult, LabelRect } from './label-layout.ts';
import { LABEL_BUDGET, LABEL_GAP, estimateLabelSize, layoutLabels } from './label-layout.ts';
import type { FrameViewport, LadderFrame } from './level-ladder.ts';
import {
  DEEPEST_SECTOR_LEVEL,
  edgeDistance,
  levelForWidth,
  levelSpec,
  markerDiameter,
  visibleWidthForLevel,
} from './level-ladder.ts';

/** Камера сектора: центр в мировых координатах и полная видимая ширина кадра. */
export interface SceneCamera {
  readonly centerX: number;
  readonly centerY: number;
  /** Полная видимая ширина мира по горизонтали кадра (`viewport.w / scale`), единицы карты. */
  readonly visibleWidth: number;
}

/** Система на входе сцены: минимум полей, остальное добавляет загрузчик данных. */
export interface SceneSystemInput {
  readonly id: string;
  readonly name: string;
  /** Мировые координаты по §10.3 (И-12): только `x`,`y` из `systems.csv`. */
  readonly x: number;
  readonly y: number;
  readonly faction?: string | null;
  readonly type?: string | null;
}

export interface SectorSceneInput {
  readonly systems: readonly SceneSystemInput[];
  readonly viewport: FrameViewport;
  readonly camera: SceneCamera;
  readonly sectorBounds?: SectorBounds | null;
  /** Сенсорный экран включает хит-зону `≥ 44 px` (§6.2 п. 5). По умолчанию мышь. */
  readonly hitTarget?: 'mouse' | 'touch';
  /** Переопределение бюджета подписей (по умолчанию `LABEL_BUDGET`). */
  readonly labelBudget?: number;
  /** `false` — подписи не раскладываются (нужно тестам и отладочному HUD). */
  readonly labels?: boolean;
}

/** Контур сектора, гало или туманности (`data/sector-bounds.json`, `L0…L9`). */
export interface SceneBounds {
  readonly kind: 'bounds';
  readonly id: string;
  readonly boundsKind: 'sector' | 'halo' | 'nebula';
  readonly label: string;
  readonly color: 'nebula' | 'tactical';
  readonly strokeWidth: number;
  readonly dash: readonly number[];
  readonly blink?: NebulaBlink;
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Линия сетки адреса (§8.1, `L0…L12`, два тира по `gridTiersFor`). */
export interface SceneGridLine {
  readonly kind: 'grid.line';
  readonly tier: string;
  readonly cellSize: number;
  /** Прозрачность линии из сцены (§17.3 п. 3): `0,16` старший тир, `0,07` вложенный. */
  readonly alpha: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Адресный префикс на грани ячейки (§8.1). */
export interface SceneGridLabel {
  readonly kind: 'grid.label';
  readonly tier: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
}

/** Маркер системы или кластера близких систем (§6.2). */
export interface SceneMarker {
  readonly kind: 'marker';
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly faction: string | null;
  readonly systemType: string;
  readonly worldX: number;
  readonly worldY: number;
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
  readonly hitRadius: number;
  /** Сколько систем слилось в маркер; `1` — одиночная система. */
  readonly clusterCount: number;
  /** Приоритет подписи по §8.1: столица → фракция → прочие. */
  readonly labelPriority: number;
}

/** Кольцо-превью системы и приглашение войти (§8.1, с `L8`). */
export interface SceneAperture {
  readonly kind: 'aperture';
  readonly systemId: string;
  readonly name: string;
  readonly address: string;
  readonly x: number;
  readonly y: number;
  /** Диаметр кольца равен диаметру маркера: глубже кламп `40 px` (§6.2 п. 2). */
  readonly ringDiameter: number;
  readonly hint: string;
}

/** Поставленная подпись. */
export interface SceneLabel extends LabelRect {
  readonly kind: 'label';
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fontSize: number;
}

export type ScenePrimitive =
  | SceneBounds
  | SceneGridLine
  | SceneGridLabel
  | SceneMarker
  | SceneAperture
  | SceneLabel;

export interface SectorScene {
  readonly level: number;
  readonly frame: LadderFrame;
  readonly visibleWidth: number;
  readonly pixelsPerLy: number;
  /** Расстояние от центра кадра до ближайшей границы, св.г. (короткая ось внутри `edgeDistance`). */
  readonly edgeDist: number;
  /** Бюджет кадра уровня из `LEVELS`, мс (§6, §8.4). */
  readonly budgetMs: number;
  readonly labels: LabelLayoutResult;
  readonly primitives: readonly ScenePrimitive[];
  readonly counts: {
    readonly bounds: number;
    readonly gridLines: number;
    readonly gridLabels: number;
    readonly markers: number;
    readonly apertures: number;
    readonly labels: number;
    /** Сколько входных систем отброшено как негодные (нет имени/координат). */
    readonly invalidSystems: number;
  };
}

/** Слияние близких маркеров: ближе `1,6 · d_px` — кластер (§6.2 п. 3). */
export const MARKER_MERGE_FACTOR = 1.6;

/** Хит-зона не меньше `d_px + 6 px` (§6.2 п. 5). */
export const MARKER_HIT_PAD = 6;

/** Минимальная хит-зона на сенсорном экране, px (§6.2 п. 5, правило Stage-8.7). */
export const TOUCH_TARGET_PX = 44;

/** Ниже этого размера сектор ничего не рисует (И-9). */
export const MIN_DRAWABLE_PX = 0.25;

/** Апертура системы активна ровно на предельном `L12`. */
export const APERTURE_FIRST_LEVEL = 12;

/** Сетка адресов живёт на `L0…L12` (G7.13): тир считает `gridTiersFor`, а не таблица. */
export const GRID_FIRST_LEVEL = 0;
export const GRID_LAST_LEVEL = 12;

/** Приоритеты подписей по §8.1: столица → фракция → плотность. */
export const LABEL_PRIORITY = Object.freeze({ capital: 100, faction: 50, system: 10 });

/** Предохранитель: больше линий сетки за кадр не строим (защита бюджета кадра). */
export const MAX_GRID_LINES = 512;

/** Предохранитель: больше адресных подписей за кадр не строим. */
export const MAX_GRID_LABELS = 64;

/** Старший тир сетки: ячейка на экране не шире `450 px` (§17.3 п. 5). */
export const GRID_CELL_MAX_PX = 450;

/** Вложенный тир сетки: его ячейка на экране не уже `16 px` (§17.3 п. 5). */
export const GRID_CELL_MIN_PX = 16;

/** Прозрачность линий старшего тира (§17.3 п. 3). */
export const GRID_LINE_ALPHA_PRIMARY = 0.16;

/** Прозрачность линий вложенного тира: глубже старшего не ярче никогда (§17.3 п. 3). */
export const GRID_LINE_ALPHA_NESTED = 0.07;

/** Пара тиров кадра: индексы в `ADDRESS_TIERS`. */
export interface GridTiers {
  /** Старший тир (подсвечен, `alpha 0,16`). */
  readonly primary: number;
  /** Вложенный тир (`alpha 0,07`); равен `primary`, когда сетка из одного тира. */
  readonly nested: number;
}

/**
 * Тир сетки от масштаба, а не от номера уровня (§17.3 п. 5, `И-8`).
 *
 * Старший тир `t` — минимальный индекс `i ≥ 1`, у которого ячейка на экране не
 * шире `GRID_CELL_MAX_PX` (450 px); вложенный — `t + 1`, пока он есть в кодеке и
 * его ячейка не уже `GRID_CELL_MIN_PX` (16 px). Если ячейка даже самого мелкого
 * тира шире кадра (масштаб за пределом `MAX_SCALE`), сетка деградирует до одного
 * тира `T7`; если вложенная ячейка мельче 16 px — до одного старшего тира.
 * В обоих случаях `nested === primary`.
 */
export function gridTiersFor(scale: number): GridTiers {
  const currentScale = requirePositive(scale, 'Масштаб сетки (scale)');
  const deepest = ADDRESS_TIERS.length - 1;

  let primary = -1;
  for (let index = 1; index <= deepest; index += 1) {
    const cellSize = ADDRESS_TIERS[index]?.cellSize ?? 0;
    if (cellSize * currentScale <= GRID_CELL_MAX_PX) {
      primary = index;
      break;
    }
  }
  if (primary < 0) primary = deepest;

  const nestedCellSize = ADDRESS_TIERS[primary + 1]?.cellSize ?? 0;
  const nested = primary + 1 <= deepest && nestedCellSize * currentScale >= GRID_CELL_MIN_PX
    ? primary + 1
    : primary;

  return { primary, nested };
}

/**
 * Режим осмотра (Z-4c §2): мельче этого размера ячейки на экране не строим тир.
 * 22 px — чтобы ячейка вмещала подпись из четырёх букв (2 + 4 · 5,4 = 23,6 px).
 */
export const LOUPE_MIN_CELL_PX = 22;

/** Отступ подписи лупы от левого верхнего угла ячейки, px (Z-4c §2, A3). */
export const LOUPE_LABEL_PAD_PX = 2;

/** Ширина знака подписи лупы: шрифт 9 px моно, px на знак (A4). */
export const LOUPE_CHAR_PX = 5.4;

/** Подпись влезает в ячейку, если `2 + 5,4 · длина ≤ cellPx` (никаких наложений). */
export function loupeLabelFits(text: string, cellPx: number): boolean {
  return LOUPE_LABEL_PAD_PX + LOUPE_CHAR_PX * text.length <= cellPx;
}

/** Окно лупы: 12 × 12 ячеек вокруг точки осмотра (радиус 6). */
export const LOUPE_WINDOW_CELLS = 12;

/** Предохранитель линий лупы: 13 + 13 (границы окна по обеим осям). */
export const MAX_LOUPE_LINES = 26;

/** Предохранитель подписей лупы: 3 × 3 ячейки вокруг точки. */
export const MAX_LOUPE_LABELS = 9;

/** Лупа не глубже базового тира уровня + этот шаг. */
export const LOUPE_MAX_TIER_STEP = 2;

/** Индекс самого мелкого тира `ADDRESS_TIERS` (`T7`, пята, версия 4.0): глубже лупа не идёт. */
const DEEPEST_ADDRESS_TIER = ADDRESS_TIERS.length - 1;

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} должно быть положительным числом: ${String(value)}`);
  }

  return value;
}

function resolveViewport(viewport: FrameViewport): FrameViewport {
  const frame: FrameViewport | null | undefined = viewport;
  if (frame === null || frame === undefined) {
    throw new RangeError('Кадр сцены должен быть объектом { w, h }');
  }

  return {
    w: requirePositive(frame.w, 'Ширина кадра сцены (viewport.w)'),
    h: requirePositive(frame.h, 'Высота кадра сцены (viewport.h)'),
  };
}

function resolveCamera(camera: SceneCamera): SceneCamera {
  const input: SceneCamera | null | undefined = camera;
  if (input === null || input === undefined) {
    throw new RangeError('Камера сцены должна быть объектом { centerX, centerY, visibleWidth }');
  }
  for (const [name, value] of [['centerX', input.centerX], ['centerY', input.centerY]] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Центр камеры (${name}) должен быть числом: ${String(value)}`);
    }
  }

  return {
    centerX: input.centerX,
    centerY: input.centerY,
    visibleWidth: requirePositive(input.visibleWidth, 'Видимая ширина камеры (visibleWidth)'),
  };
}

/** Уровень лестницы по видимой ширине — только через `levelForWidth` (И-8). */
export function sceneLevel(visibleWidth: number): number {
  return levelForWidth(requirePositive(visibleWidth, 'Видимая ширина (visibleWidth)'));
}

/** Пикселей на единицу карты: масштаб по полной ширине кадра (`viewport.w / visibleWidth`). */
export function pixelsPerLightYear(viewport: FrameViewport, camera: SceneCamera): number {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);

  return frame.w / cam.visibleWidth;
}

/**
 * Расстояние от центра кадра до ближайшей границы, св.г. Считается функцией
 * лестницы `edgeDistance` (§17.15), а не своей формулой: `visibleWidth / 2`.
 */
export function cameraEdgeDistance(viewport: FrameViewport, camera: SceneCamera): number {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = frame.w / cam.visibleWidth;

  return edgeDistance(frame, scale);
}

/** Мировые координаты → экранные пиксели кадра. */
export function worldToScreen(
  viewport: FrameViewport,
  camera: SceneCamera,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = frame.w / cam.visibleWidth;

  return {
    x: frame.w / 2 + (x - cam.centerX) * scale,
    y: frame.h / 2 + (y - cam.centerY) * scale,
  };
}

/** Экранные пиксели → мировые координаты. */
export function screenToWorld(
  viewport: FrameViewport,
  camera: SceneCamera,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = frame.w / cam.visibleWidth;

  return {
    x: cam.centerX + (x - frame.w / 2) / scale,
    y: cam.centerY + (y - frame.h / 2) / scale,
  };
}

/** Хит-зона маркера по §6.2 п. 5: `d + 6 px`, на сенсоре не меньше `44 px`. */
export function hitRadiusFor(diameter: number, hitTarget: 'mouse' | 'touch' = 'mouse'): number {
  const base = requirePositive(diameter, 'Диаметр маркера (diameter)') + MARKER_HIT_PAD;

  return hitTarget === 'touch' ? Math.max(base, TOUCH_TARGET_PX) : base;
}

/** Камера, поставленная на уровень: видимая ширина берётся из лестницы. */
export function cameraForLevel(level: number, centerX = MAP_SIZE / 2, centerY = MAP_SIZE / 2): SceneCamera {
  return { centerX, centerY, visibleWidth: visibleWidthForLevel(level) };
}

interface ProjectedSystem {
  readonly system: SceneSystemInput;
  readonly x: number;
  readonly y: number;
}

function isUsableSystem(system: SceneSystemInput): boolean {
  return typeof system.id === 'string' && system.id.length > 0
    && typeof system.name === 'string' && system.name.length > 0
    && Number.isFinite(system.x) && Number.isFinite(system.y);
}

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
}

/**
 * Слияние маркеров в кластеры (§6.2 п. 3): системы ближе `1,6 · d_px` друг к
 * другу попадают в один маркер с числом. Порядок обхода — по `id`, поэтому
 * кластеры детерминированы и не зависят от порядка `systems.csv`.
 */
export function clusterSystems(
  systems: readonly SceneSystemInput[],
  viewport: FrameViewport,
  camera: SceneCamera,
  diameter: number,
  hitTarget: 'mouse' | 'touch' = 'mouse',
): readonly SceneMarker[] {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const mergeDistance = MARKER_MERGE_FACTOR * requirePositive(diameter, 'Диаметр маркера (diameter)');
  const margin = Math.max(diameter, mergeDistance) * 2;

  const projected: ProjectedSystem[] = [];
  for (const system of systems) {
    if (!isUsableSystem(system)) continue;
    const point = worldToScreen(frame, cam, system.x, system.y);
    if (point.x < -margin || point.y < -margin || point.x > frame.w + margin || point.y > frame.h + margin) {
      continue;
    }
    projected.push({ system, x: point.x, y: point.y });
  }
  projected.sort((a, b) => byId(a.system, b.system));

  const clusters: Array<{ readonly seed: ProjectedSystem; readonly members: ProjectedSystem[] }> = [];
  for (const entry of projected) {
    let target: { readonly seed: ProjectedSystem; readonly members: ProjectedSystem[] } | undefined;
    for (const cluster of clusters) {
      if (Math.hypot(cluster.seed.x - entry.x, cluster.seed.y - entry.y) <= mergeDistance) {
        target = cluster;
        break;
      }
    }
    if (target === undefined) {
      clusters.push({ seed: entry, members: [entry] });
    } else {
      target.members.push(entry);
    }
  }

  const hitRadius = hitRadiusFor(diameter, hitTarget);

  return clusters.map((cluster) => {
    const head = cluster.members
      .slice()
      .sort((a, b) => labelPriorityOf(b.system) - labelPriorityOf(a.system) || byId(a.system, b.system))[0]!;
    const sumX = cluster.members.reduce((total, member) => total + member.x, 0);
    const sumY = cluster.members.reduce((total, member) => total + member.y, 0);
    const worldX = cluster.members.reduce((total, member) => total + member.system.x, 0) / cluster.members.length;
    const worldY = cluster.members.reduce((total, member) => total + member.system.y, 0) / cluster.members.length;

    return {
      kind: 'marker' as const,
      id: head.system.id,
      name: head.system.name,
      address: formatAddress(addressOf(head.system.x, head.system.y)),
      faction: head.system.faction ?? null,
      systemType: head.system.type ?? '',
      worldX,
      worldY,
      x: sumX / cluster.members.length,
      y: sumY / cluster.members.length,
      diameter,
      hitRadius,
      clusterCount: cluster.members.length,
      labelPriority: labelPriorityOf(head.system),
    };
  }).sort(byId);
}

function labelPriorityOf(system: SceneSystemInput): number {
  if (system.type === 'capital') return LABEL_PRIORITY.capital;
  if (system.faction !== null && system.faction !== undefined && system.faction.length > 0) {
    return LABEL_PRIORITY.faction;
  }

  return LABEL_PRIORITY.system;
}

/** Контуры границ сектора, гало и туманностей в экранных координатах кадра (`L0…L9`). */
export function boundsFor(
  sectorBounds: SectorBounds | null | undefined,
  viewport: FrameViewport,
  camera: SceneCamera,
): readonly SceneBounds[] {
  if (sectorBounds === null || sectorBounds === undefined) return [];
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  return sectorBounds.bounds.map((item) => {
    const projected: Point[] = item.points.map(([wx, wy]) => {
      const point = worldToScreen(frame, cam, wx, wy);
      return [point.x, point.y] as const;
    });

    return {
      kind: 'bounds' as const,
      id: item.id,
      boundsKind: item.kind,
      label: item.label,
      color: item.style.color,
      strokeWidth: item.style.strokeWidth,
      dash: [...item.style.dash],
      ...(item.blink ? { blink: item.blink } : {}),
      points: projected.map(([x, y]) => ({ x, y })),
    };
  });
}

/** Видимая часть мира по камере (для обхода сетки). */
function visibleWorldBounds(
  viewport: FrameViewport,
  camera: SceneCamera,
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = frame.w / cam.visibleWidth;
  const halfW = frame.w / 2 / scale;
  const halfH = frame.h / 2 / scale;

  return {
    x0: cam.centerX - halfW,
    y0: cam.centerY - halfH,
    x1: cam.centerX + halfW,
    y1: cam.centerY + halfH,
  };
}

/**
 * Линии одного тира в кадре. Геометрия — по границам ячеек `ADDRESS_TIERS` в
 * мировых координатах, проекция на экран; прозрачность берётся из правила
 * §17.3 п. 3 и приходит аргументом (сцена — единственный источник чисел).
 */
function gridLinesForTier(
  frame: FrameViewport,
  cam: SceneCamera,
  tierIndex: number,
  alpha: number,
): readonly SceneGridLine[] {
  const tierInfo = addressTierAt(tierIndex);
  if (tierInfo === undefined) return [];

  const { cellSize } = tierInfo;
  const columns = Math.round(MAP_SIZE / cellSize);
  const bounds = visibleWorldBounds(frame, cam);
  const firstCol = Math.max(0, Math.floor(bounds.x0 / cellSize));
  const lastCol = Math.min(columns - 1, Math.floor(bounds.x1 / cellSize));
  const firstRow = Math.max(0, Math.floor(bounds.y0 / cellSize));
  const lastRow = Math.min(columns - 1, Math.floor(bounds.y1 / cellSize));

  const lines: SceneGridLine[] = [];
  for (let col = firstCol; col <= lastCol + 1; col += 1) {
    const worldX = col * cellSize;
    if (worldX < 0 || worldX > MAP_SIZE) continue;
    const point = worldToScreen(frame, cam, worldX, cam.centerY);
    if (point.x < 0 || point.x > frame.w) continue;
    lines.push({
      kind: 'grid.line',
      tier: tierInfo.id,
      cellSize,
      alpha,
      x1: point.x,
      y1: 0,
      x2: point.x,
      y2: frame.h,
    });
  }
  for (let row = firstRow; row <= lastRow + 1; row += 1) {
    const worldY = row * cellSize;
    if (worldY < 0 || worldY > MAP_SIZE) continue;
    const point = worldToScreen(frame, cam, cam.centerX, worldY);
    if (point.y < 0 || point.y > frame.h) continue;
    lines.push({
      kind: 'grid.line',
      tier: tierInfo.id,
      cellSize,
      alpha,
      x1: 0,
      y1: point.y,
      x2: frame.w,
      y2: point.y,
    });
  }

  return lines;
}

/**
 * Сетка адресов уровня: линии двух тиров и адресные префиксы на гранях ячеек
 * старшего тира (§17.3 п. 2, 6). В кадре ровно два тира: `t` и `t + 1`; при
 * превышении `MAX_GRID_LINES` остаётся один старший тир (§17.3 п. 8).
 */
export function gridFor(
  viewport: FrameViewport,
  camera: SceneCamera,
  level: number,
): { readonly lines: readonly SceneGridLine[]; readonly labels: readonly SceneGridLabel[] } {
  if (level < GRID_FIRST_LEVEL || level > GRID_LAST_LEVEL) return { lines: [], labels: [] };

  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = frame.w / cam.visibleWidth;
  const tiers = gridTiersFor(scale);
  const primaryTier = addressTierAt(tiers.primary);
  if (primaryTier === undefined) return { lines: [], labels: [] };

  const primaryLines = gridLinesForTier(frame, cam, tiers.primary, GRID_LINE_ALPHA_PRIMARY);
  let lines: readonly SceneGridLine[] = primaryLines;
  if (tiers.nested !== tiers.primary) {
    const nestedLines = gridLinesForTier(frame, cam, tiers.nested, GRID_LINE_ALPHA_NESTED);
    lines = primaryLines.length + nestedLines.length <= MAX_GRID_LINES
      ? [...primaryLines, ...nestedLines]
      : primaryLines;
  }
  // Даже один тир не влез в предохранитель — сетку не рисуем вовсе.
  if (lines.length > MAX_GRID_LINES) return { lines: [], labels: [] };

  const labels: SceneGridLabel[] = [];
  const letters = tiers.primary as AddressLetters;
  const { cellSize } = primaryTier;
  const columns = Math.round(MAP_SIZE / cellSize);
  const bounds = visibleWorldBounds(frame, cam);
  const firstCol = Math.max(0, Math.floor(bounds.x0 / cellSize));
  const lastCol = Math.min(columns - 1, Math.floor(bounds.x1 / cellSize));
  const firstRow = Math.max(0, Math.floor(bounds.y0 / cellSize));
  const lastRow = Math.min(columns - 1, Math.floor(bounds.y1 / cellSize));
  const probe = estimateLabelSize(`KP·${'X'.repeat(letters)}`);
  const readable = cellSize * scale >= probe.width + LABEL_GAP * 2;
  if (letters > 0 && readable) {
    for (let row = firstRow; row <= lastRow && labels.length < MAX_GRID_LABELS; row += 1) {
      for (let col = firstCol; col <= lastCol && labels.length < MAX_GRID_LABELS; col += 1) {
        const centerX = (col + 0.5) * cellSize;
        const centerY = (row + 0.5) * cellSize;
        if (centerX >= MAP_SIZE || centerY >= MAP_SIZE) continue;
        const corner = worldToScreen(frame, cam, col * cellSize, row * cellSize);
        if (corner.x < 0 || corner.y < 0 || corner.x > frame.w || corner.y > frame.h) continue;
        labels.push({
          kind: 'grid.label',
          tier: primaryTier.id,
          text: formatAddress(prefixOf(centerX, centerY, letters)),
          x: corner.x,
          y: corner.y,
        });
      }
    }
  }

  return { lines, labels };
}

/* ------------------------------------------------------------------ режим осмотра (Z-4c) */

/** Прямоугольник окна лупы на экране, px. */
export interface LoupeBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Результат лупы: тир, размер ячейки, линии, подписи и окно. `tierIndex === null` — лупы на уровне нет. */
export interface LoupeGrid {
  /** Индекс тира в `ADDRESS_TIERS`; `null` на `L0`, где нет базовой сетки. */
  readonly tierIndex: number | null;
  /** Размер ячейки лупы в единицах карты; `0`, если тира нет. */
  readonly cellSize: number;
  /** Размер ячейки лупы на экране, px (`cellSize · w / visibleWidth`). */
  readonly cellPx: number;
  readonly lines: readonly SceneGridLine[];
  /** Короткие адреса ячеек вокруг точки (центр ячейки), px. */
  readonly labels: readonly SceneGridLabel[];
  /** Окно лупы, px: 12 × 12 ячеек, обрезанное кадром и границами карты. `null` — окна нет. */
  readonly bounds: LoupeBounds | null;
}

export interface LoupeOptions {
  /** Порог читаемости ячейки, px. По умолчанию `LOUPE_MIN_CELL_PX` (22); меняется только тестами. */
  readonly minCellPx?: number;
}

/**
 * Состояние осмотра (Z-4c §2). Экранные px; `x`/`y` равны `null`, пока точки ещё
 * не было, и тогда точка осмотра — центр кадра (прицел). `hovering` — указатель
 * над холстом: после `pointerleave` точка сохраняется, окно рисуется с alpha `0,85`.
 */
export interface InspectState {
  on: boolean;
  x: number | null;
  y: number | null;
  hovering: boolean;
}

const inspectStates = new WeakMap<object, InspectState>();

/**
 * Состояние осмотра, привязанное к объекту состояния атласа. Это `state.inspect`
 * по смыслу, но без правки общего типа состояния: отдельный слой не трогает
 * `config.ts` и `app.ts`.
 */
export function inspectOf(owner: object): InspectState {
  const existing = inspectStates.get(owner);
  if (existing !== undefined) return existing;
  const created: InspectState = { on: false, x: null, y: null, hovering: false };
  inspectStates.set(owner, created);

  return created;
}

export type InspectPointerEvent =
  | { readonly kind: 'move'; readonly x: number; readonly y: number; readonly coarse: boolean }
  | { readonly kind: 'tap'; readonly x: number; readonly y: number; readonly coarse: boolean }
  | { readonly kind: 'leave' };

/**
 * Переход состояния осмотра по событию указателя (без DOM).
 * Мышь (`coarse: false`) двигает точку перемещением; сенсор (`coarse: true`) —
 * только тапом, а перемещение пальцем точку не трогает.
 */
export function inspectOnPointer(inspect: InspectState, event: InspectPointerEvent): InspectState {
  if (event.kind === 'leave') return { ...inspect, hovering: false };
  if (event.kind === 'move') {
    if (event.coarse) return inspect;
    return { ...inspect, x: event.x, y: event.y, hovering: true };
  }
  if (!event.coarse) return inspect;

  return { ...inspect, x: event.x, y: event.y };
}

/** Точка осмотра в экранных px: последняя указанная, а до первого указания — центр кадра. */
export function inspectPointFor(
  viewport: FrameViewport,
  inspect: { readonly x: number | null; readonly y: number | null },
): { readonly x: number; readonly y: number } {
  const frame = resolveViewport(viewport);
  if (inspect.x === null || inspect.y === null) return { x: frame.w / 2, y: frame.h / 2 };

  return { x: inspect.x, y: inspect.y };
}

/** Команды отрисовки лупы: один отрезок на линию и одна подпись на подпись. */
export function loupeCommandCount(loupe: LoupeGrid): number {
  return loupe.lines.length + loupe.labels.length;
}

/**
 * Лупа на тире `tierIndex` вокруг точки. Окно — линии с индексами `col-6 … col+6`
 * по каждой оси (13 линий, 12 ячеек), обрезанные границами карты `[0, columns]`.
 * Затем экранная проекция обрезается кадром: лишние линии и подписи не строятся.
 */
function buildLoupe(
  frame: FrameViewport,
  cam: SceneCamera,
  tierIndex: number,
  point: { readonly x: number; readonly y: number },
): LoupeGrid {
  const tier = addressTierAt(tierIndex);
  if (tier === undefined) throw new RangeError(`Неизвестный тир лупы: ${String(tierIndex)}`);
  const { cellSize } = tier;
  const scale = frame.w / cam.visibleWidth;
  const cellPx = cellSize * scale;
  const columns = Math.round(MAP_SIZE / cellSize);
  const half = LOUPE_WINDOW_CELLS / 2;
  const empty: LoupeGrid = { tierIndex, cellSize, cellPx, lines: [], labels: [], bounds: null };

  const world = screenToWorld(frame, cam, point.x, point.y);
  const col = Math.floor(world.x / cellSize);
  const row = Math.floor(world.y / cellSize);
  const kx0 = Math.max(0, col - half);
  const kx1 = Math.min(columns, col + half);
  const ky0 = Math.max(0, row - half);
  const ky1 = Math.min(columns, row + half);
  if (kx1 <= kx0 || ky1 <= ky0) return empty;

  const topLeft = worldToScreen(frame, cam, kx0 * cellSize, ky0 * cellSize);
  const bottomRight = worldToScreen(frame, cam, kx1 * cellSize, ky1 * cellSize);
  const left = Math.max(0, topLeft.x);
  const top = Math.max(0, topLeft.y);
  const right = Math.min(frame.w, bottomRight.x);
  const bottom = Math.min(frame.h, bottomRight.y);
  if (!(right > left) || !(bottom > top)) return empty;

  const lines: SceneGridLine[] = [];
  for (let k = kx0; k <= kx1; k += 1) {
    const x = worldToScreen(frame, cam, k * cellSize, 0).x;
    if (x < left || x > right) continue;
    lines.push({
      kind: 'grid.line',
      tier: tier.id,
      cellSize,
      alpha: GRID_LINE_ALPHA_PRIMARY,
      x1: x,
      y1: top,
      x2: x,
      y2: bottom,
    });
  }
  for (let k = ky0; k <= ky1; k += 1) {
    const y = worldToScreen(frame, cam, 0, k * cellSize).y;
    if (y < top || y > bottom) continue;
    lines.push({
      kind: 'grid.line',
      tier: tier.id,
      cellSize,
      alpha: GRID_LINE_ALPHA_PRIMARY,
      x1: left,
      y1: y,
      x2: right,
      y2: y,
    });
  }

  // Подписи: 3 × 3 ячейки вокруг ячейки точки. Текст — только буквы адреса до тира
  // лупы (без «KP·»); якорь — левый верхний угол ячейки. Подпись, не влезшая в ячейку,
  // пропускается; центральная ячейка (точка осмотра) рисуется всегда — при нехватке
  // месте одной последней буквой.
  const labels: SceneGridLabel[] = [];
  const letters = tierIndex as AddressLetters;
  for (let dr = -1; dr <= 1; dr += 1) {
    for (let dc = -1; dc <= 1; dc += 1) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= columns || r >= columns) continue;
      if (labels.length >= MAX_LOUPE_LABELS) continue;
      const centerX = (c + 0.5) * cellSize;
      const centerY = (r + 0.5) * cellSize;
      const isCentre = dc === 0 && dr === 0;
      if (!isCentre) {
        const p = worldToScreen(frame, cam, centerX, centerY);
        if (p.x < left || p.x > right || p.y < top || p.y > bottom) continue;
      }
      const full = prefixOf(centerX, centerY, letters).letters;
      let text: string;
      if (loupeLabelFits(full, cellPx)) text = full;
      else if (isCentre) text = full.slice(-1);
      else continue;
      const corner = worldToScreen(frame, cam, c * cellSize, r * cellSize);
      labels.push({ kind: 'grid.label', tier: tier.id, text, x: corner.x, y: corner.y });
    }
  }

  return {
    tierIndex,
    cellSize,
    cellPx,
    lines: lines.slice(0, MAX_LOUPE_LINES),
    labels,
    bounds: { x0: left, y0: top, x1: right, y1: bottom },
  };
}

/**
 * Лупа режима осмотра (Z-4c §2). Тир — самый мелкий из допустимых (не глубже
 * базового + `LOUPE_MAX_TIER_STEP` и не глубже `T5`), у которого ячейка на экране
 * не меньше `LOUPE_MIN_CELL_PX`. Если таких нет, берётся базовый (самый крупный).
 * Предохранитель `MAX_LOUPE_LINES`: при превышении тир шагает на один грубее.
 * Чистая функция: DOM, таймеров и случайности нет.
 */
export function loupeGridFor(
  viewport: FrameViewport,
  camera: SceneCamera,
  /** Уровень сохранён в сигнатуре ради вызовов; тир больше не зависит от него (F3-5). */
  _level: number,
  point: { readonly x: number; readonly y: number },
  options: LoupeOptions = {},
): LoupeGrid {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError(`Точка осмотра должна быть числами: ${String(point.x)}, ${String(point.y)}`);
  }
  const minCellPx = requirePositive(options.minCellPx ?? LOUPE_MIN_CELL_PX, 'Порог ячейки лупы (minCellPx)');

  // База лупы — старший тир фактической сетки (§17.3 п. 5, решение F3-5), а не
  // удалённая таблица «уровень → тир»: на L10…L12 база тоже существует (T5/T6),
  // поэтому null-тира у лупы больше нет.
  const scale = frame.w / cam.visibleWidth;
  const base = gridTiersFor(scale).primary;
  const deepest = Math.min(base + LOUPE_MAX_TIER_STEP, DEEPEST_ADDRESS_TIER);
  let tierIndex = base;
  for (let index = deepest; index >= base; index -= 1) {
    const tier = addressTierAt(index);
    if (tier !== undefined && tier.cellSize * scale >= minCellPx) {
      tierIndex = index;
      break;
    }
  }

  let loupe = buildLoupe(frame, cam, tierIndex, point);
  while (loupe.lines.length > MAX_LOUPE_LINES && tierIndex > base) {
    tierIndex -= 1;
    loupe = buildLoupe(frame, cam, tierIndex, point);
  }

  return loupe;
}

/**
 * Тир адреса по индексу в `ADDRESS_TIERS`. Размеры ячеек берутся из кодека
 * адреса, а не переписываются в сцене руками (И-7, И-8).
 */
function addressTierAt(index: number): { readonly id: string; readonly cellSize: number } | undefined {
  const tier = ADDRESS_TIERS[index];

  return tier === undefined ? undefined : { id: tier.id, cellSize: tier.cellSize };
}

/** Текст подписи маркера по колонке «Подпись» таблицы §6.2. `null` — подписи нет. */
export function labelTextFor(marker: SceneMarker, level: number): string | null {
  if (level < 2) return null;
  const base = marker.clusterCount > 1 ? `${marker.name} +${marker.clusterCount - 1}` : marker.name;
  if (level === 2) {
    return marker.clusterCount > 1
      ? (marker.faction ?? base)
      : null;
  }
  if (level === 3) return marker.labelPriority === LABEL_PRIORITY.capital ? base : null;
  if (level === 4) {
    return marker.labelPriority >= LABEL_PRIORITY.faction ? base : null;
  }
  if (level >= 6 && marker.systemType.length > 0) {
    return `${base} · ${marker.systemType}`;
  }

  return base;
}

/** Кольцо-превью и приглашение войти: ровно на предельном `L9` (Z-4b §2). */
export function aperturesFor(
  markers: readonly SceneMarker[],
  level: number,
): readonly SceneAperture[] {
  if (level < APERTURE_FIRST_LEVEL || level > DEEPEST_SECTOR_LEVEL) return [];

  return markers.map((marker) => ({
    kind: 'aperture' as const,
    systemId: marker.id,
    name: marker.name,
    address: marker.address,
    x: marker.x,
    y: marker.y,
    ringDiameter: marker.diameter,
    hint: 'Enter — войти в систему',
  }));
}

/**
 * Собирает сцену кадра `S`: примитивы в порядке слоёв §8.1.
 *
 * Пустой список систем — валидный вход: остаются только слои, не зависящие от
 * данных (сетка адресов), остальное пусто.
 */
export function buildSectorScene(input: SectorSceneInput): SectorScene {
  const frame = resolveViewport(input.viewport);
  const cam = resolveCamera(input.camera);
  const level = sceneLevel(cam.visibleWidth);
  const spec = levelSpec(level);
  const scale = frame.w / cam.visibleWidth;
  const diameter = markerDiameter(cam.visibleWidth);
  const systems = input.systems ?? [];
  const invalidSystems = systems.filter((system) => !isUsableSystem(system)).length;

  const bounds = boundsFor(input.sectorBounds, frame, cam);
  const grid = gridFor(frame, cam, level);
  const markers = clusterSystems(systems, frame, cam, diameter, input.hitTarget ?? 'mouse');
  const apertures = aperturesFor(markers, level);

  const labelItems = [];
  for (const marker of markers) {
    const text = labelTextFor(marker, level);
    if (text === null) continue;
    labelItems.push({
      id: marker.id,
      text,
      x: marker.x,
      y: marker.y,
      priority: marker.labelPriority,
      radius: marker.diameter / 2,
    });
  }
  const layout = input.labels === false
    ? { placed: [], dropped: [], skipped: 0, overflow: 0, invalid: 0, budget: 0 }
    : layoutLabels(labelItems, frame, {
      budget: input.labelBudget ?? LABEL_BUDGET,
      obstacles: markers.map((marker) => ({
        x: marker.x - marker.diameter / 2,
        y: marker.y - marker.diameter / 2,
        width: marker.diameter,
        height: marker.diameter,
      })),
    });

  const labels: SceneLabel[] = layout.placed.map((box) => ({
    kind: 'label' as const,
    id: box.id,
    text: box.text,
    priority: box.priority,
    anchorX: box.anchorX,
    anchorY: box.anchorY,
    fontSize: box.fontSize,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }));

  const primitives: ScenePrimitive[] = [
    ...bounds,
    ...grid.lines,
    ...grid.labels,
    ...markers,
    ...apertures,
    ...labels,
  ];

  return {
    level,
    frame: spec.frame,
    visibleWidth: cam.visibleWidth,
    pixelsPerLy: scale,
    edgeDist: cameraEdgeDistance(frame, cam),
    budgetMs: spec.frameBudgetMs,
    labels: layout,
    primitives,
    counts: {
      bounds: bounds.length,
      gridLines: grid.lines.length,
      gridLabels: grid.labels.length,
      markers: markers.length,
      apertures: apertures.length,
      labels: labels.length,
      invalidSystems,
    },
  };
}
