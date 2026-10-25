/* Модель сцены сектора: примитивы для отрисовки без DOM и без canvas.
 *
 * Модуль ничего не рисует и ни к чему не подключён: на вход идут данные систем,
 * камера и размер кадра, на выход — плоский список примитивов в порядке слоёв
 * плана §8.1 (территории → сетка → системы → апертура → подписи). Рантайм-проводка
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
 *   — территории `L2…L6`, сетка адресов `L1…L8`, апертура с `L8` — §8.1;
 *   — подпись на уровне — колонка «Подпись» таблицы §6.2, приоритет
 *     «столица → фракция → плотность» — §8.1;
 *   — бюджет подписей `120` — `LABEL_BUDGET` из `label-layout.ts` (§6, §8.1).
 */

import { ADDRESS_TIERS, MAP_SIZE, addressOf, formatAddress, prefixOf } from './sector-address.ts';
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

/** Камера сектора: центр в мировых координатах и видимая ширина по короткой оси. */
export interface SceneCamera {
  readonly centerX: number;
  readonly centerY: number;
  /** Видимая ширина мира по короткой оси кадра, св.г. */
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
  /** Сенсорный экран включает хит-зону `≥ 44 px` (§6.2 п. 5). По умолчанию мышь. */
  readonly hitTarget?: 'mouse' | 'touch';
  /** Переопределение бюджета подписей (по умолчанию `LABEL_BUDGET`). */
  readonly labelBudget?: number;
  /** `false` — подписи не раскладываются (нужно тестам и отладочному HUD). */
  readonly labels?: boolean;
}

/** Мягкое поле фракции (§8.1, уровни `L2…L6`). Заливку и alpha выбирает рендерер. */
export interface SceneTerritory {
  readonly kind: 'territory';
  readonly faction: string;
  readonly systems: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly x: number;
  readonly y: number;
  /** Радиус по данным: максимальное расстояние от центроида до системы, св.г. */
  readonly radius: number;
  readonly screenRadius: number;
}

/** Линия сетки адреса (§8.1, уровни `L1…L8`). */
export interface SceneGridLine {
  readonly kind: 'grid.line';
  readonly tier: string;
  readonly cellSize: number;
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
  | SceneTerritory
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
  /** Расстояние от центра кадра до границы, св.г. (§17.15: `visibleWidth / 2`). */
  readonly edgeDist: number;
  /** Бюджет кадра уровня из `LEVELS`, мс (§6, §8.4). */
  readonly budgetMs: number;
  readonly labels: LabelLayoutResult;
  readonly primitives: readonly ScenePrimitive[];
  readonly counts: {
    readonly territories: number;
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

/** Апертура системы появляется с `L8` (§8.1). Лестница продолжена до `L12` в §17.15. */
export const APERTURE_FIRST_LEVEL = 8;

/** Территории фракций живут на `L2…L6` (§8.1). */
export const TERRITORY_LEVELS: readonly number[] = Object.freeze([2, 3, 4, 5, 6]);

/** Сетка адресов живёт на `L1…L8` (§8.1). */
export const GRID_FIRST_LEVEL = 1;
export const GRID_LAST_LEVEL = 8;

/** Приоритеты подписей по §8.1: столица → фракция → плотность. */
export const LABEL_PRIORITY = Object.freeze({ capital: 100, faction: 50, system: 10 });

/** Предохранитель: больше линий сетки за кадр не строим (защита бюджета кадра). */
export const MAX_GRID_LINES = 512;

/** Предохранитель: больше адресных подписей за кадр не строим. */
export const MAX_GRID_LABELS = 64;

/**
 * Тир адресной сетки по уровню лестницы — по таблице §6:
 * `L1…L2` — квадранты `2 000`, `L3…L4` — регионы `400`, `L5…L6` — субсекторы `80`,
 * `L7` — ячейки `16`, `L8` — узлы `3,2`. На `L0` и глубже `L8` сетки нет (§8.1).
 */
export const GRID_TIER_BY_LEVEL: readonly (number | null)[] = Object.freeze([
  null, 1, 1, 2, 2, 3, 3, 4, 5, null, null, null, null,
]);

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

/** Пикселей на световой год по короткой оси кадра. */
export function pixelsPerLightYear(viewport: FrameViewport, camera: SceneCamera): number {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);

  return Math.min(frame.w, frame.h) / cam.visibleWidth;
}

/**
 * Расстояние от центра кадра до ближайшей границы, св.г. Считается функцией
 * лестницы `edgeDistance` (§17.15), а не своей формулой: `visibleWidth / 2`.
 */
export function cameraEdgeDistance(viewport: FrameViewport, camera: SceneCamera): number {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;

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
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;

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
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;

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

/** Мягкие поля фракций: центроид и радиус по системам (§8.1, `L2…L6`). */
export function territoriesFor(
  systems: readonly SceneSystemInput[],
  viewport: FrameViewport,
  camera: SceneCamera,
  level: number,
): readonly SceneTerritory[] {
  if (!TERRITORY_LEVELS.includes(level)) return [];
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;

  const groups = new Map<string, SceneSystemInput[]>();
  for (const system of systems) {
    if (!isUsableSystem(system)) continue;
    const faction = system.faction ?? '';
    if (faction.length === 0) continue;
    const bucket = groups.get(faction);
    if (bucket === undefined) groups.set(faction, [system]);
    else bucket.push(system);
  }

  const territories: SceneTerritory[] = [];
  for (const [faction, members] of groups) {
    const centerX = members.reduce((total, member) => total + member.x, 0) / members.length;
    const centerY = members.reduce((total, member) => total + member.y, 0) / members.length;
    const radius = members.reduce(
      (max, member) => Math.max(max, Math.hypot(member.x - centerX, member.y - centerY)),
      0,
    );
    const point = worldToScreen(frame, cam, centerX, centerY);

    territories.push({
      kind: 'territory',
      faction,
      systems: members.length,
      centerX,
      centerY,
      x: point.x,
      y: point.y,
      radius,
      screenRadius: radius * scale,
    });
  }

  return territories.sort((a, b) => (a.faction < b.faction ? -1 : (a.faction > b.faction ? 1 : 0)));
}

/** Видимая часть мира по камере (для обхода сетки). */
function visibleWorldBounds(
  viewport: FrameViewport,
  camera: SceneCamera,
): { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } {
  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;
  const halfW = frame.w / 2 / scale;
  const halfH = frame.h / 2 / scale;

  return {
    x0: cam.centerX - halfW,
    y0: cam.centerY - halfH,
    x1: cam.centerX + halfW,
    y1: cam.centerY + halfH,
  };
}

/** Сетка адресов уровня: линии тира и адресные префиксы на гранях ячеек (§8.1). */
export function gridFor(
  viewport: FrameViewport,
  camera: SceneCamera,
  level: number,
): { readonly lines: readonly SceneGridLine[]; readonly labels: readonly SceneGridLabel[] } {
  if (level < GRID_FIRST_LEVEL || level > GRID_LAST_LEVEL) return { lines: [], labels: [] };
  const tierIndex = GRID_TIER_BY_LEVEL[level] ?? null;
  if (tierIndex === null) return { lines: [], labels: [] };

  const frame = resolveViewport(viewport);
  const cam = resolveCamera(camera);
  const spec = levelSpec(level);
  const tierInfo = addressTierAt(tierIndex);
  if (tierInfo === undefined) return { lines: [], labels: [] };

  const { cellSize } = tierInfo;
  const columns = Math.round(MAP_SIZE / cellSize);
  const bounds = visibleWorldBounds(frame, cam);
  const firstCol = Math.max(0, Math.floor(bounds.x0 / cellSize));
  const lastCol = Math.min(columns - 1, Math.floor(bounds.x1 / cellSize));
  const firstRow = Math.max(0, Math.floor(bounds.y0 / cellSize));
  const lastRow = Math.min(columns - 1, Math.floor(bounds.y1 / cellSize));

  const lineCount = (lastCol - firstCol + 2) + (lastRow - firstRow + 2);
  if (lineCount > MAX_GRID_LINES) return { lines: [], labels: [] };

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
      x1: 0,
      y1: point.y,
      x2: frame.w,
      y2: point.y,
    });
  }

  const labels: SceneGridLabel[] = [];
  const letters = spec.addressLetters;
  const probe = estimateLabelSize(`KP·${'X'.repeat(letters)}`);
  const readable = cellSize * (Math.min(frame.w, frame.h) / cam.visibleWidth) >= probe.width + LABEL_GAP * 2;
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
          tier: tierInfo.id,
          text: formatAddress(prefixOf(centerX, centerY, letters)),
          x: corner.x,
          y: corner.y,
        });
      }
    }
  }

  return { lines, labels };
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

/** Кольцо-превью и приглашение войти: с `L8` в секторном кадре (§8.1). */
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
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;
  const diameter = markerDiameter(cam.visibleWidth);
  const systems = input.systems ?? [];
  const invalidSystems = systems.filter((system) => !isUsableSystem(system)).length;

  const territories = territoriesFor(systems, frame, cam, level);
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
    ...territories,
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
      territories: territories.length,
      gridLines: grid.lines.length,
      gridLabels: grid.labels.length,
      markers: markers.length,
      apertures: apertures.length,
      labels: labels.length,
      invalidSystems,
    },
  };
}
