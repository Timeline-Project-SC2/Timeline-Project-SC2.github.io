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

export const MAX_VISIBLE_WIDTH = 10000;
export const MIN_VISIBLE_WIDTH = 16000;
export const HYSTERESIS = 0.12;

/** Самый глубокий секторный уровень лестницы: L9 (Z-4b). */
export const DEEPEST_SECTOR_LEVEL = 9;

/**
 * Предел зума задан полной шириной кадра (Z-4b): на упоре в кадр по горизонтали
 * входит ровно `1` св.г. (`lyToUnits(1)` единиц карты) — это номинальная
 * ширина `L9`. Не расстояние до границы: та метрика (`edgeDistance`) на упоре
 * зависит от пропорций экрана и на `1920×1080` даёт `0,28` св.г.
 */
export const TARGET_WIDTH_LY = 1;

/** Номинальная полная видимая ширина секторного уровня `n`: `10000 / 10^(n/9)`, ед. карты. */
function sectorWidth(level: number): number {
  return MAX_VISIBLE_WIDTH / 10 ** (level / DEEPEST_SECTOR_LEVEL);
}

export const LEVELS: readonly LevelSpec[] = Object.freeze([
  Object.freeze({
    level: 0,
    id: 'L0',
    frame: 'S',
    visibleWidth: sectorWidth(0),
    addressLetters: 0,
    markerPx: 2.5,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 1,
    id: 'L1',
    frame: 'S',
    visibleWidth: sectorWidth(1),
    addressLetters: 1,
    markerPx: 3.3,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 2,
    id: 'L2',
    frame: 'S',
    visibleWidth: sectorWidth(2),
    addressLetters: 2,
    markerPx: 4.5,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 3,
    id: 'L3',
    frame: 'S',
    visibleWidth: sectorWidth(3),
    addressLetters: 2,
    markerPx: 6.0,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 4,
    id: 'L4',
    frame: 'S',
    visibleWidth: sectorWidth(4),
    addressLetters: 3,
    markerPx: 8.0,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 5,
    id: 'L5',
    frame: 'S',
    visibleWidth: sectorWidth(5),
    addressLetters: 3,
    markerPx: 10.7,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 6,
    id: 'L6',
    frame: 'S',
    visibleWidth: sectorWidth(6),
    addressLetters: 4,
    markerPx: 14.3,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 7,
    id: 'L7',
    frame: 'S',
    visibleWidth: sectorWidth(7),
    addressLetters: 4,
    markerPx: 19.2,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 8,
    id: 'L8',
    frame: 'S',
    visibleWidth: sectorWidth(8),
    addressLetters: 5,
    markerPx: 25.6,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 9,
    id: 'L9',
    frame: 'S',
    // Жёсткая связь с пределом зума: ширина L9 — это `lyToUnits(1)`, а не литерал.
    visibleWidth: lyToUnits(TARGET_WIDTH_LY),
    addressLetters: 5,
    markerPx: 34.3,
    frameBudgetMs: 16,
  }),
  // Системный кадр S0…S2 не тронут: те же уровни 13…15 и видимые ширины
  // 100 / 16 / 2 (а.е.). Секторных уровней 10…12 больше нет — `levelSpec(10)`
  // обязан бросать RangeError, поэтому записи ищутся по полю `level`, а не
  // по индексу массива.
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

export function levelSpec(level: number): LevelSpec {
  // Поиск по полю `level`, а не по индексу: секторная лестница кончается на
  // L9, а системные S0…S2 сохраняют свои номера 13…15 (уровней 10…12 нет).
  const spec = LEVELS.find((candidate) => candidate.level === level);
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

  const deepestWidth = visibleWidthForLevel(DEEPEST_SECTOR_LEVEL);

  let rawLevel: number;
  if (visibleWidth <= deepestWidth * (1 + 1e-9)) {
    rawLevel = DEEPEST_SECTOR_LEVEL;
  } else if (visibleWidth >= MAX_VISIBLE_WIDTH) {
    rawLevel = 0;
  } else {
    rawLevel = Math.max(
      0,
      Math.min(
        DEEPEST_SECTOR_LEVEL,
        Math.floor(DEEPEST_SECTOR_LEVEL * Math.log10(MAX_VISIBLE_WIDTH / visibleWidth) + 1e-9),
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
    // Предельный L9 — асимметрично: порог `0,88` к нему не применяется, вход
    // по номинальной ширине с допуском округления (Z-4b §2).
    const enterThreshold = nextLevel === DEEPEST_SECTOR_LEVEL
      ? deepestWidth * (1 + 1e-9)
      : visibleWidthForLevel(nextLevel) * (1 - HYSTERESIS);
    return visibleWidth <= enterThreshold ? nextLevel : prev;
  }

  if (rawLevel < prev) {
    const leaveThreshold = visibleWidthForLevel(prev) * (1 + HYSTERESIS);
    return visibleWidth >= leaveThreshold ? prev - 1 : prev;
  }

  return rawLevel;
}

/**
 * Показатель непрерывного диаметра маркера: `log10(34,3 / 2,5)` — оба конца
 * визуального ряда §6.2. Пересчитан под размах зума `10×` лестницы L0…L9
 * (Z-4b): на L9 формула даёт `34,3` px, а не `6,6` px старого показателя.
 */
export const MARKER_EXPONENT = 1.1374;

export function markerDiameter(visibleWidth: number): number {
  if (Number.isNaN(visibleWidth) || visibleWidth < 0) {
    throw new RangeError('Ширина кадра для маркера не может быть отрицательной');
  }

  const diameter = 2.5 * (MAX_VISIBLE_WIDTH / visibleWidth) ** MARKER_EXPONENT;
  return Math.max(2.5, Math.min(40, diameter));
}

/* ------------------------------------------------- затухание слоёв (Z-3.9, §8.1)
 *
 * Глубина лестницы — десять уровней `L0…L9` (Z-4b), поэтому слой сетей и мягкое
 * поле фракции живут не до `L6`, а на всей лестнице: `L2…L9`. Чтобы на глубине
 * слой не превращался в плотное пятно, его альфа убывает геометрически от `L2`
 * (полная яркость `1`) к `L6` (`0,75⁴ ≈ 0,316`) и упирается в нижнюю границу
 * `0,25`; контур гаснет медленнее заливки и ниже `0,45` не опускается.
 *
 * Функции — чистая арифметика от уровня: ни DOM, ни состояния, ни цвета. Формула
 * объявлена здесь однажды, а `faction-net.ts`, `sector-scene.ts` и
 * `canvas-renderer.ts` импортируют её отсюда (дублей в двух файлах нет).
 */

/** Шаг затухания на уровень: альфа заливки `L(n) = 0,75^(n−2)`. */
export const LAYER_FADE_STEP = 0.75;

/** Нижняя граница альфы заливки слоя: глубже `L7` слой не исчезает совсем. */
export const LAYER_FILL_ALPHA_MIN = 0.25;

/** Нижняя граница альфы линии (контур, узел, всполох): контур виден на глубине. */
export const LAYER_LINE_ALPHA_MIN = 0.45;

/** Первый уровень, на котором живут слои территорий и сетей (`L2`). */
export const DEEP_LAYER_FIRST_LEVEL = 2;

/** Альфа заливки слоя на уровне: `0` вне `L2…L9`, иначе `max(0,25; 0,75^(n−2))`. */
export function layerFillAlpha(level: number): number {
  if (!(level >= DEEP_LAYER_FIRST_LEVEL) || level > DEEPEST_SECTOR_LEVEL) return 0;

  return Math.max(LAYER_FILL_ALPHA_MIN, LAYER_FADE_STEP ** (level - DEEP_LAYER_FIRST_LEVEL));
}

/**
 * Альфа линии слоя на уровне: `0` вне `L2…L9`, иначе не меньше альфы заливки,
 * но и не меньше `0,45` — контур переживает затухание заливки.
 */
export function layerLineAlpha(level: number): number {
  if (!(level >= DEEP_LAYER_FIRST_LEVEL) || level > DEEPEST_SECTOR_LEVEL) return 0;

  return Math.max(LAYER_LINE_ALPHA_MIN, layerFillAlpha(level));
}

/* --------------------------------------------------- метрики кадра (Z-4b, §17.23)
 *
 * Уровень выбирается по полной видимой ширине кадра: `visibleWidth` уровней
 * задаётся в единицах карты (`1000…10 000`) как протяжённость мира по
 * горизонтали кадра (`viewport.w / scale`); в световых годах ей соответствует
 * `visibleWidthLyForLevel(n) = visibleWidthForLevel(n) / 1000`.
 *
 * Отдельная метрика — `edgeDist`, расстояние от центра кадра (цели) до
 * ближайшей границы экрана в световых годах:
 *
 *     edgeDist = min(viewport.w, viewport.h) / (2 · scale · UNITS_PER_LY)
 *
 * Пределом зума она больше не является (Z-4b §3): на упоре полной ширины
 * `1` св.г. она даёт `0,28` св.г. на `1920×1080` и `0,50` св.г. на
 * `390×844` — это ожидаемо, не баг.
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
 * Предел приближения по полной ширине (Z-4b §3): на упоре полная ширина
 * кадра равна `TARGET_WIDTH_LY` (`1` св.г. = `1000` единиц карты) на любом
 * экране, то есть `maxScale = viewport.w / lyToUnits(1)` px/ед:
 * `1920 → 1,92`, `1366 → 1,366`, `2560 → 2,56`, `390 → 0,39`.
 * Высота кадра на упоре — из пропорций экрана, уровень выбирается по полной
 * ширине, а не по короткой оси и не по расстоянию до границы.
 * `mapSize` и `fitInset` входят в контракт сигнатуры и проверяются на
 * корректность, как прежде.
 */
export function maxScaleForTargetWidth(
  viewport: FrameViewport,
  mapSize: number,
  fitInset: number,
): number {
  requirePositive(mapSize, 'Размер карты (mapSize)');
  requirePositive(fitInset, 'Отступ вписывания (fitInset)');
  const frame: FrameViewport | null | undefined = viewport;
  if (frame === null || frame === undefined) {
    throw new RangeError('Кадр должен быть объектом { w, h }');
  }
  const width = requirePositive(frame.w, 'Ширина кадра (viewport.w)');
  requirePositive(frame.h, 'Высота кадра (viewport.h)');

  return width / lyToUnits(TARGET_WIDTH_LY);
}
