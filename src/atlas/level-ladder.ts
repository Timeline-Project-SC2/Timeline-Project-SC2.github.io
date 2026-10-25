import { UNITS_PER_LY, lyToUnits } from './sector-units.ts';

export type LadderFrame = 'S' | 'O';

export interface LevelSpec {
  readonly level: number;
  readonly id: string;
  readonly frame: LadderFrame;
  /** Номинальная видимая ширина уровня в единицах карты (для кадра O — в а.е.). */
  readonly visibleWidth: number;
  readonly addressLetters: 0 | 1 | 2 | 3 | 4 | 5;
  readonly markerPx: number;
  readonly frameBudgetMs: number;
}

export const LEVELS: readonly LevelSpec[] = Object.freeze([
  Object.freeze({
    level: 0,
    id: 'L0',
    frame: 'S',
    visibleWidth: 10000,
    addressLetters: 0,
    markerPx: 2.5,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 1,
    id: 'L1',
    frame: 'S',
    visibleWidth: 5000,
    addressLetters: 1,
    markerPx: 3.3,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 2,
    id: 'L2',
    frame: 'S',
    visibleWidth: 2500,
    addressLetters: 2,
    markerPx: 4.5,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 3,
    id: 'L3',
    frame: 'S',
    visibleWidth: 1250,
    addressLetters: 2,
    markerPx: 6.0,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 4,
    id: 'L4',
    frame: 'S',
    visibleWidth: 625,
    addressLetters: 3,
    markerPx: 8.0,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 5,
    id: 'L5',
    frame: 'S',
    visibleWidth: 312.5,
    addressLetters: 3,
    markerPx: 10.7,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 6,
    id: 'L6',
    frame: 'S',
    visibleWidth: 156.25,
    addressLetters: 4,
    markerPx: 14.3,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 7,
    id: 'L7',
    frame: 'S',
    visibleWidth: 78.125,
    addressLetters: 4,
    markerPx: 19.2,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 8,
    id: 'L8',
    frame: 'S',
    visibleWidth: 39.0625,
    addressLetters: 5,
    markerPx: 25.7,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 9,
    id: 'L9',
    frame: 'S',
    visibleWidth: 19.53125,
    addressLetters: 5,
    markerPx: 34.3,
    frameBudgetMs: 16,
  }),
  // L10…L12 — та же геометрия 10 000 / 2^n в единицах карты (добавлены в SW-3 до перевода
  // единиц по §17.23; таблица порогов в единицах сохраняется без изменений).
  // markerDiameter(2) = 89,5 px упирается в кламп 40 px, поэтому в таблице стоит 40.
  Object.freeze({
    level: 10,
    id: 'L10',
    frame: 'S',
    visibleWidth: 9.765625,
    addressLetters: 5,
    markerPx: 40,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 11,
    id: 'L11',
    frame: 'S',
    visibleWidth: 4.8828125,
    addressLetters: 5,
    markerPx: 40,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 12,
    id: 'L12',
    frame: 'S',
    visibleWidth: 2.44140625,
    addressLetters: 5,
    markerPx: 40,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 13,
    id: 'S0',
    frame: 'O',
    visibleWidth: 100,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 14,
    id: 'S1',
    frame: 'O',
    visibleWidth: 16,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 15,
    id: 'S2',
    frame: 'O',
    visibleWidth: 2,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
]);

export const MAX_VISIBLE_WIDTH = 10000;
export const MIN_VISIBLE_WIDTH = 16000;
export const HYSTERESIS = 0.12;

/** Самый глубокий секторный уровень лестницы: L12 (§17.15). */
export const DEEPEST_SECTOR_LEVEL = 12;

/**
 * Требование владельца (§17.15.1, §17.23): расстояние от цели до ближайшей границы кадра
 * равно 1 световому году (`1 000` единиц карты). Метрика — `edgeDistance`, а не ширина видимой области.
 */
export const TARGET_EDGE_LY = 1;

/**
 * Глубже 0,5 св.г. (`500` единиц карты) до границы начинается системный кадр: вход туда — только
 * действием (§6.1 п. 4), клампом зума он не достигается.
 */
export const MIN_CLAMP_EDGE_LY = 0.5;

export function levelSpec(level: number): LevelSpec {
  const spec = LEVELS[level];
  if (spec === undefined) {
    throw new RangeError(`Уровень вне лестницы глубины: ${level}`);
  }

  return spec;
}

export function frameOf(level: number): LadderFrame {
  return levelSpec(level).frame;
}

export function visibleWidthForLevel(level: number): number {
  return levelSpec(level).visibleWidth;
}

/** Номинальная видимая ширина уровня в световых годах (`visibleWidthForLevel(level) / 1000`). */
export function visibleWidthLyForLevel(level: number): number {
  return visibleWidthForLevel(level) / UNITS_PER_LY;
}

export function levelForWidth(visibleWidth: number, prev?: number): number {
  if (Number.isNaN(visibleWidth)) {
    throw new RangeError('Ширина кадра должна быть числом');
  }

  let rawLevel: number;
  if (visibleWidth >= MAX_VISIBLE_WIDTH) {
    rawLevel = 0;
  } else if (visibleWidth <= visibleWidthForLevel(DEEPEST_SECTOR_LEVEL)) {
    rawLevel = DEEPEST_SECTOR_LEVEL;
  } else {
    rawLevel = Math.max(
      0,
      Math.min(
        DEEPEST_SECTOR_LEVEL,
        Math.floor(Math.log2(MAX_VISIBLE_WIDTH / visibleWidth) + 1e-9),
      ),
    );
  }

  if (prev === undefined) {
    return rawLevel;
  }
  if (!Number.isInteger(prev) || prev < 0 || prev > DEEPEST_SECTOR_LEVEL) {
    throw new RangeError(
      `Секторный уровень вне диапазона 0…${DEEPEST_SECTOR_LEVEL}: ${prev}`,
    );
  }

  if (rawLevel > prev) {
    const nextLevel = prev + 1;
    const enterThreshold = visibleWidthForLevel(nextLevel) * (1 - HYSTERESIS);
    return visibleWidth <= enterThreshold ? nextLevel : prev;
  }

  if (rawLevel < prev) {
    const leaveThreshold = visibleWidthForLevel(prev) * (1 + HYSTERESIS);
    return visibleWidth >= leaveThreshold ? prev - 1 : prev;
  }

  return rawLevel;
}

export function markerDiameter(visibleWidth: number): number {
  if (Number.isNaN(visibleWidth) || visibleWidth < 0) {
    throw new RangeError('Ширина кадра для маркера не может быть отрицательной');
  }

  const diameter = 2.5 * (MAX_VISIBLE_WIDTH / visibleWidth) ** 0.42;
  return Math.max(2.5, Math.min(40, diameter));
}

/* --------------------------------------------------- метрика требования §17.15 / §17.23
 *
 * Единственная метрика глубины — `edgeDist`, расстояние от центра кадра (цели)
 * до ближайшей границы экрана в световых годах (`1 000` единиц карты = `1` св.г.):
 *
 *     edgeDist = min(viewport.w, viewport.h) / (2 · scale · UNITS_PER_LY)
 *
 * `visibleWidth` уровней задаётся в единицах карты (`0…10 000`) как протяжённость
 * мира по КОРОТКОЙ оси кадра; в световых годах ей соответствует
 * `visibleWidthLyForLevel(n) = visibleWidthForLevel(n) / 1000`, поэтому на номинале
 * уровня `edgeDist = visibleWidthLyForLevel(n) / 2`. Это та же короткая ось,
 * по которой масштабирует `fitScale()` в `canvas-renderer.ts`
 * (`min(w, h) / mapSize * fitInset`), — поэтому формула `fitScaleFor` совпадает
 * с рендерером до порядка операций.
 */

/** Размер кадра, к которому применяется масштаб. */
export interface FrameViewport {
  readonly w: number;
  readonly h: number;
}

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} должно быть положительным числом: ${String(value)}`);
  }

  return value;
}

/** Длина короткой оси кадра — та, по которой меряется глубина. */
function shortSide(viewport: FrameViewport): number {
  const frame: FrameViewport | null | undefined = viewport;
  if (frame === null || frame === undefined) {
    throw new RangeError('Кадр должен быть объектом { w, h }');
  }
  const w = requirePositive(frame.w, 'Ширина кадра (viewport.w)');
  const h = requirePositive(frame.h, 'Высота кадра (viewport.h)');

  return Math.min(w, h);
}

/** Расстояние от цели (центра кадра) до ближайшей границы экрана, в св.г. */
export function edgeDistance(viewport: FrameViewport, scale: number): number {
  const short = shortSide(viewport);
  const pixelsPerUnit = requirePositive(scale, 'Масштаб кадра (scale)');

  return short / (2 * pixelsPerUnit * UNITS_PER_LY);
}

/** Масштаб (px/ед), при котором до ближайшей границы ровно `edgeDist` св.г. */
export function scaleForEdgeDistance(viewport: FrameViewport, edgeDist: number): number {
  const short = shortSide(viewport);
  const lightYears = requirePositive(edgeDist, 'Расстояние до границы кадра (edgeDist)');

  return short / (2 * lyToUnits(lightYears));
}

/** «Вся карта» по короткой оси — формула `fitScale()` из `canvas-renderer.ts`. */
export function fitScaleFor(viewport: FrameViewport, mapSize: number, fitInset: number): number {
  const short = shortSide(viewport);
  const size = requirePositive(mapSize, 'Размер карты (mapSize)');
  const inset = requirePositive(fitInset, 'Отступ вписывания (fitInset)');

  return short / size * inset;
}

/**
 * Предел приближения по требованию (§17.17 п. 4, §17.23): масштаб точки
 * «1,00 св.г. до границы» (`1 000` единиц карты от центра до ближайшего края).
 *
 * Кламп стоит **ровно на требовании**, без запаса вниз —
 * `edgeDistance(viewport, maxScale) === 1,00` точно, то есть
 * `maxScale = min(w, h) / (2 · lyToUnits(1)) = min(w, h) / 2000` px/ед.
 *
 * Отношение к масштабу «вся карта» получается тождеством:
 *
 *     maxScale / fitScale = mapSize / (2 · UNITS_PER_LY · fitInset)
 *                         = 10 000 / 1 880 = 5,3191489… (532 %)
 *
 * (`5×` к номиналу L0 без inset `0,94`.) От viewport множитель не зависит:
 * обе величины пропорциональны `min(w, h)`. `mapSize` и `fitInset` входят
 * в контракт сигнатуры и проверяются на корректность.
 *
 * Предохранитель отдельный и только на ошибку: масштаб не глубже
 * `scaleForEdgeDistance(viewport, 0,5)` (`500` единиц до края) — ниже начинается
 * системный кадр, вход в него только действием (§6.1 п. 4).
 */
export function maxScaleForTargetEdge(
  viewport: FrameViewport,
  mapSize: number,
  fitInset: number,
): number {
  requirePositive(mapSize, 'Размер карты (mapSize)');
  requirePositive(fitInset, 'Отступ вписывания (fitInset)');

  const atRequirement = shortSide(viewport) / (2 * lyToUnits(TARGET_EDGE_LY));
  const systemFrameGuard = shortSide(viewport) / (2 * lyToUnits(MIN_CLAMP_EDGE_LY));

  return Math.min(atRequirement, systemFrameGuard);
}
