/**
 * Процедурное поле сектора (шаг `SW-2A`, волна `SW-2`).
 *
 * Заменяет растровую подложку `/sector/` детерминированным шумовым полем:
 * `field.nebula` + `field.dust` + `field.stars` из §8.1 плана
 * `docs/stages/stage-9-12-sector-deep-render-plan.md`.
 *
 * Контракт — §17.5 `docs/agents_task_orchestration/agents_task_orchestration.md`
 * (в редакции от 25.10.2026: центр кадра `(viewport.w / 2 − tx) / scale`,
 * бюджет `renderField` разделён с `renderToImageData`).
 * Публичные имена, порядок и модификаторы `readonly` не менять: шаг `SW-2B`
 * импортирует именно их.
 *
 * Правила, заложенные в код:
 *  1. Камеро-относительная математика. Центр кадра считается в `float64` в JS,
 *     в шейдер уходят только смещение от центра (`u_offsetHi` / `u_offsetLo`)
 *     и размеры кадра. Мировые координаты в `uniform float` не передаются:
 *     на `L9` (`scale ≈ 512`) `float32` перестаёт различать соседние пиксели.
 *  2. Детерминизм. Всё случайное — от `hashSeed(FIELD_SEED_TEXT)` (`xxHash32`).
 *     `Math.random`, `Date.now`, `performance.now` в генерации не участвуют;
 *     CPU-путь побитово воспроизводим (только IEEE-754 `+ − × ÷ sqrt` и
 *     целочисленные операции — `pow/exp/log/sin` в генерации не используются).
 *  3. CPU-фолбэк равноценен: нет WebGL2 или контекст потерян → `backend === 'cpu'`,
 *     та же композиция, без исключений и без пустого холста.
 *  4. Ни сети, ни ассетов: ноль `fetch`, ноль `Image`, ноль чтения картинок.
 *  5. `renderToImageData` работает в Node без `<canvas>`: `ImageData` собирается
 *     внутренней фабрикой; DOM-обращения — только внутри функций и только
 *     после проверки наличия холста.
 *  6. Экранный путь `renderField` на CPU считается в буфере пониженного
 *     разрешения (`SCREEN_DIVISOR` ≤ 1/3 линейно) и растягивается билинейно,
 *     готовый кадр кэшируется по состоянию вида (§17.5 п. 5). Полноразмерный
 *     и точный путь — только `renderToImageData` (предпросмотр и тесты).
 */

export type FieldStyle = 'nebula' | 'tactical';

export interface FieldPalette {
  readonly id: FieldStyle;
  readonly background: readonly [number, number, number];
  readonly dust: readonly [number, number, number];
  readonly core: readonly [number, number, number];
  readonly rim: readonly [number, number, number];
  readonly densityStops: readonly number[];
}

export interface SectorFieldState {
  readonly view: { readonly scale: number; readonly tx: number; readonly ty: number };
  readonly viewport: { readonly w: number; readonly h: number };
  readonly dpr: number;
  readonly mapSize: number;
}

export interface SectorField {
  readonly style: FieldStyle;
  readonly backend: 'webgl2' | 'cpu';
  renderField(state: SectorFieldState): void;
  renderToImageData(state: SectorFieldState): ImageData;
  dispose(): void;
}

export const FIELD_SEED_TEXT = 'KP';

/* ------------------------------------------------------------------ палитры */

/**
 * Обе палитры проходят один и тот же код композиции: различие только в цвете
 * и в таблице `FIELD_TUNING`.
 *
 * `densityStops` — пять опорных точек на оси плотности `0…1` (строго возрастают):
 * четыре отрезка рампы `background → dust → rim → core → coreHighlight`, где
 * `coreHighlight` — производный цвет (`mix(core, white)`), чтобы последний отрезок
 * уводил ядро в пересвет, а не возвращался назад по яркости.
 *
 * Порядок яркости (`0.2126R + 0.7152G + 0.0722B`), обязательный по §17.12 `V-1`:
 * `core > rim >= dust > background` — проверяется тестом.
 */
export const FIELD_PALETTES: readonly FieldPalette[] = Object.freeze([
  Object.freeze({
    id: 'nebula' as FieldStyle,
    background: Object.freeze([4, 6, 14] as const),
    dust: Object.freeze([26, 38, 74] as const),
    core: Object.freeze([186, 168, 226] as const),
    rim: Object.freeze([84, 62, 148] as const),
    densityStops: Object.freeze([0, 0.2, 0.44, 0.7, 0.92]),
  }),
  Object.freeze({
    id: 'tactical' as FieldStyle,
    background: Object.freeze([3, 7, 9] as const),
    dust: Object.freeze([18, 42, 52] as const),
    core: Object.freeze([150, 205, 214] as const),
    rim: Object.freeze([46, 104, 118] as const),
    densityStops: Object.freeze([0, 0.22, 0.5, 0.76, 0.94]),
  }),
]);

/** Доля белого в производном цвете ядра: последний отрезок рампы. */
const CORE_HIGHLIGHT_MIX = 0.55;

/* ------------------------------------------------------------------ seed */

const PRIME1 = 2654435761; // 0x9E3779B1
const PRIME2 = 2246822519; // 0x85EBCA77
const PRIME3 = 3266489917; // 0xC2B2AE3D
const PRIME4 = 668265263; // 0x27D4EB2F
const PRIME5 = 374761393; // 0x165667B1

function mul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function read32BE(bytes: Uint8Array, index: number): number {
  const b0 = bytes[index] ?? 0;
  const b1 = bytes[index + 1] ?? 0;
  const b2 = bytes[index + 2] ?? 0;
  const b3 = bytes[index + 3] ?? 0;
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

/** UTF-8 без `TextEncoder`, чтобы хэш не зависел от окружения. */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }

  return Uint8Array.from(out);
}

/**
 * `xxHash32` (seed 0) — тот же алгоритм, что в §8.3 плана: `seed = xxHash32("KP")`.
 * Возвращает беззнаковое 32-битное число.
 */
export function hashSeed(text: string): number {
  const seed = 0;
  const bytes = utf8Bytes(text);
  const length = bytes.length;
  let index = 0;
  let hash: number;

  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) >>> 0;
    let v2 = (seed + PRIME2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME1) >>> 0;
    while (index <= length - 16) {
      v1 = mul32(rotl32((v1 + mul32(read32BE(bytes, index), PRIME2)) >>> 0, 13), PRIME1);
      v2 = mul32(rotl32((v2 + mul32(read32BE(bytes, index + 4), PRIME2)) >>> 0, 13), PRIME1);
      v3 = mul32(rotl32((v3 + mul32(read32BE(bytes, index + 8), PRIME2)) >>> 0, 13), PRIME1);
      v4 = mul32(rotl32((v4 + mul32(read32BE(bytes, index + 12), PRIME2)) >>> 0, 13), PRIME1);
      index += 16;
    }
    hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    hash = (seed + PRIME5) >>> 0;
  }

  hash = (hash + length) >>> 0;
  while (index + 4 <= length) {
    hash = (hash + mul32(read32BE(bytes, index), PRIME3)) >>> 0;
    hash = mul32(rotl32(hash, 17), PRIME4);
    index += 4;
  }
  while (index < length) {
    hash = (hash + mul32(bytes[index] ?? 0, PRIME5)) >>> 0;
    hash = mul32(rotl32(hash, 11), PRIME1);
    index += 1;
  }

  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = mul32(hash, PRIME2);
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = mul32(hash, PRIME3);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash >>> 0;
}

const BASE_SEED = hashSeed(FIELD_SEED_TEXT);

/* ------------------------------------------------------------------ таблицы композиции */

/** Каналы шума: у каждого свой подseed от `BASE_SEED`, чтобы слои не коррелировали. */
const CHANNEL_WARP_BIG_X = 0;
const CHANNEL_WARP_BIG_Y = 1;
const CHANNEL_WARP_SMALL_X = 2;
const CHANNEL_WARP_SMALL_Y = 3;
const CHANNEL_OCTAVE_BASE = 4;
const CHANNEL_RIDGE_MID = 16;
const CHANNEL_RIDGE_FINE = 18;
const CHANNEL_ENVELOPE = 14;
const CHANNEL_DETAIL_WARP_X = 12;
const CHANNEL_DETAIL_WARP_Y = 13;
const CHANNEL_DUST = 17;
const CHANNEL_STAR_PRESENCE = 19;
const CHANNEL_STAR_X = 20;
const CHANNEL_STAR_Y = 21;
const CHANNEL_STAR_BRIGHTNESS = 22;
const CHANNEL_DITHER = 23;
const CHANNEL_LIMIT = 24;

/** Домен-варп двух частот: крупные изгибы облака и мелкая «рябь» филаментов. */
const WARP_FREQ_BIG = 3.2;
const WARP_FREQ_SMALL = 11;
/**
 * Амплитуда варпа задаётся в ячейках самой мелкой активной октавы кадра, а не
 * в долях карты: иначе на `L0` (видна вся карта) варп сжимает мелкие ячейки
 * в разы и добавляет деталь, которой нет на `L9` — по замеру это давало
 * просадку `edge / meanL` до `0,83 ×` (§17.12 `V-2`).
 */
const WARP_CELLS = 5.2;

/**
 * Композиция — гибрид двух компонент, и это принципиально:
 *  1) **облако** — обычный `fBm` с сильным домен-варпом: даёт силуэт, мягкие
 *     градиенты и «пустоты», то есть то, что читается как туманность;
 *  2) **волокна** — `ridged`-компонента (`1 − |2n − 1|`), которая модулирует
 *     плотность облака и добавляет тонкие нити. Сама по себе ridged-сумма даёт
 *     ячеистую «червячную» сетку, поэтому она работает только как множитель
 *     и только внутри плотных участков (§17.12 `V-5`).
 *
 * Октавы разбиты на две полосы, обе привязаны к экранному масштабу:
 *  - окно облаков — ячейка `CLOUD_CELL_PX`, несколько октав вниз по частоте;
 *  - окно детали — ячейка `DETAIL_CELL_PX` (2–4 px, требование `V-2`), которое
 *    тем заметнее, чем глубже зум. Октав мельче пикселя нет: это было бы зерно.
 */
const OCTAVE_BASE_FREQ = 3;
const MAX_OCTAVES = 18;
/** Облачное окно: ячейка ≈ 40–60 px на `L0`, носитель силуэта. */
const CLOUD_CELL_PX = 48;
const CLOUD_WINDOW_WIDTH = 2.2;
/** Подъём амплитуд вниз по частоте внутри облачного окна. */
const COARSE_GAIN = 1.35;
/** Детальное окно: ячейка 2–4 px, носитель мелкой структуры на любом зуме. */
const DETAIL_CELL_PX = 13;
const DETAIL_WINDOW_WIDTH = 1.3;
const DETAIL_AMP_SHALLOW = 0.3;
const DETAIL_AMP_DEEP = 1.25;
const DETAIL_ZOOM_FROM = 1;
const DETAIL_ZOOM_TO = 22;
/**
 * Анизотропия: частота вдоль `x` ниже, поэтому образования вытянуты — это и
 * есть волокна. Облако вытянуто слабо, нити — сильно.
 */
const CLOUD_ANISOTROPY = 1.45;
const THREAD_ANISOTROPY = 2.0;
/** Ячейка нитей в пикселях буфера и их усиление с зумом. */
const THREAD_CELL_PX = 2.8;
const THREAD_GAIN_SHALLOW = 0.5;
const THREAD_GAIN_DEEP = 1.65;
const THREAD_ZOOM_FROM = 3;
const THREAD_ZOOM_TO = 30;
/** Оболочка: крупные пустоты и сгустки, частота в ячейках на поле. */
const ENVELOPE_FREQ = 2.6;
/** Мелкий варп детальной полосы: ячейка и амплитуда в этих же ячейках. */
const DETAIL_WARP_CELL_PX = 26;
const DETAIL_WARP_CELLS = 0.85;
/** Пылевые полосы (§8.1, слой `field.dust`, анизотропия 1:4), ячейка в пикселях. */
const DUST_CELL_PX = 90;

/** Параметры композиции, различающие два пресета (код один и тот же). */
interface FieldTuning {
  /** Амплитуда домен-варпа в ячейках мелкой активной октавы. */
  readonly warpCells: number;
  /** Вклад гребневого модулятора в плотность облака. */
  readonly ridgeStrength: number;
  readonly fineStrength: number;
  readonly cloudContrast: number;
  readonly densityBias: number;
  /** Масштаб плотности перед рампой: держит среднюю яркость в полосе `V-3`. */
  readonly densityScale: number;
  readonly dustStrength: number;
  readonly dustTint: number;
  readonly starPresence: number;
  readonly starGain: number;
}

const FIELD_TUNING: { readonly [style in FieldStyle]: FieldTuning } = Object.freeze({
  nebula: Object.freeze({
    warpCells: 2.8,
    ridgeStrength: 0.85,
    fineStrength: 0.5,
    cloudContrast: 1.85,
    densityBias: -0.12,
    densityScale: 0.62,
    dustStrength: 0.5,
    dustTint: 0.55,
    starPresence: 0.34,
    starGain: 1.15,
  }),
  tactical: Object.freeze({
    warpCells: 3.6,
    // У `tactical` облако сдержанное, а волокна — основной носитель структуры:
    // тонкие холодные нити на почти чёрном фоне, без зелёных «островов».
    ridgeStrength: 0.55,
    fineStrength: 0.85,
    cloudContrast: 2.6,
    densityBias: -0.26,
    densityScale: 0.62,
    dustStrength: 0.5,
    dustTint: 0.8,
    starPresence: 0.2,
    starGain: 0.8,
  }),
});

/* ------------------------------------------------------------------ примитивы шума */

/** Подseed канала: та же формула, что `u_seed ^ (channel * 0x2545f491u)` в шейдере. */
function channelSeed(channel: number): number {
  return (BASE_SEED ^ Math.imul(channel + 1, 0x2545f491)) >>> 0;
}

const CHANNEL_SEEDS: readonly number[] = Object.freeze(
  Array.from({ length: CHANNEL_LIMIT }, (_unused, channel) => channelSeed(channel)),
);

/**
 * Значение решётки `[0, 1)` по целым координатам ячейки и подseed канала.
 * Побитово совпадает с `latticeValue` в шейдере (только `imul`/сдвиги/`xor`).
 */
function latticeValue(ix: number, iy: number, seed: number): number {
  let hash = (Math.imul(ix | 0, 0x9e3779b1) ^ Math.imul(iy | 0, 0x85ebca6b) ^ seed) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0x297a2d39) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return hash / 4294967296;
}

/** Сглаживание `3t² − 2t³`: только умножения, результат побитово стабилен. */
function smoothCurve(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value-noise с билинейной интерполяцией; вход — в ячейках решётки. */
function valueNoise(px: number, py: number, seed: number): number {
  const fx = Math.floor(px);
  const fy = Math.floor(py);
  const wx = smoothCurve(px - fx);
  const wy = smoothCurve(py - fy);
  const v00 = latticeValue(fx, fy, seed);
  const v10 = latticeValue(fx + 1, fy, seed);
  const v01 = latticeValue(fx, fy + 1, seed);
  const v11 = latticeValue(fx + 1, fy + 1, seed);
  const top = v00 + (v10 - v00) * wx;
  const bottom = v01 + (v11 - v01) * wx;
  return top + (bottom - top) * wy;
}

/** `ridged`-компонента: `1 − |2n − 1|` даёт гребень-касп вместо плавного пятна. */
function ridged(value: number): number {
  const doubled = value + value - 1;
  return 1 - (doubled < 0 ? -doubled : doubled);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  return smoothCurve(clamp01((value - edge0) / (edge1 - edge0)));
}

/* ------------------------------------------------------------------ кадр */

const FALLBACK_VIEWPORT = 1920;
const FALLBACK_MAP_SIZE = 10000;
const MAX_RENDER_SIDE = 4096;
/** Ячейка звёздной пыли в device-пикселях: звезда получается размером 1–2 px (§8.1). */
const STAR_CELL_PX = 3;
/** Целевая средняя плотность кадра для нормировки `V-3` и сетка её замера. */
const TARGET_MEAN_DENSITY = 0.13;
const STATS_GRID = 24;
const STATS_GAIN_MIN = 0.25;
const STATS_GAIN_MAX = 4;
/**
 * Понижение разрешения экранного CPU-пути (§17.5 п. 5, уточнение 25.10.2026):
 * линейно не выше `1/3` от `viewport · dpr`. Понижение берётся по бюджету
 * пикселей, а не фиксированным делителем: поле — туманность, и bilinear-растяжение
 * из буфера ≈ `SCREEN_PIXEL_BUDGET` пикселей визуально не отличимо, зато кадр
 * укладывается в бюджет `G7.4` (замер — в `npm run sector-field:preview`).
 */
const SCREEN_PIXEL_BUDGET_NATIVE = 40000;
const SCREEN_PIXEL_BUDGET_FALLBACK = 12000;
const SCREEN_MIN_DIVISOR = 3;

/**
 * Делитель экранного буфера: не меньше `3` и не больше, чем нужно для бюджета.
 * Бюджет зависит от того, кто растягивает картинку: холст (`drawImage` на GPU,
 * почти бесплатно) или JS-фолбэк (≈ 12 мс на мегапиксель), поэтому в окружении
 * без `<canvas>`/`document` буфер заметно мельче.
 */
function screenDivisor(state: SectorFieldState, nativeUpscale: boolean): number {
  const rawsW = Math.max(1, finiteOr(state.viewport?.w, FALLBACK_VIEWPORT));
  const rawsH = Math.max(1, finiteOr(state.viewport?.h, FALLBACK_VIEWPORT));
  const dpr = Math.min(4, Math.max(1 / 8, finiteOr(state.dpr, 1)));
  const budget = nativeUpscale ? SCREEN_PIXEL_BUDGET_NATIVE : SCREEN_PIXEL_BUDGET_FALLBACK;
  const byBudget = Math.sqrt((rawsW * dpr * rawsH * dpr) / budget);
  return Math.max(SCREEN_MIN_DIVISOR, byBudget);
}

/** Всё, что нужно пиксельному проходу; считается один раз на кадр в `float64`. */
interface FrameMath {
  readonly width: number;
  readonly height: number;
  /** Мировой центр кадра, `float64`. */
  readonly centreX: number;
  readonly centreY: number;
  /** Пикселей буфера на мировую единицу. */
  readonly deviceScale: number;
  readonly mapSize: number;
  readonly octaveWeights: readonly number[];
  readonly octaveNormalizer: number;
  /** Индекс мелкой активной октавы (нижняя граница облачного fBm). */
  readonly octavePeak: number;
  /** Амплитуда домен-варпа в долях нормированного поля. */
  readonly warpAmp: number;
  /** Частоты гребневых слоёв: средние филаменты и тонкие нити. */
  readonly ridgeFreqMid: number;
  readonly ridgeFreqFine: number;
  readonly envelopeFreq: number;
  /**
   * Мелкий домен-варп для детальной полосы. Без него мелкие октавы не
   * размываются крупным варпом и остаются выровненными по осям решётки —
   * на `L4…L9` это читается как «лего» из прямоугольников.
   */
  readonly detailWarpFreq: number;
  readonly detailWarpAmp: number;
  /** Усиление нитей с зумом: на глубоких уровнях кадр обрастает волокнами. */
  readonly threadGain: number;
  readonly dustFreqX: number;
  readonly dustFreqY: number;
  readonly starCell: number;
  /** Пылевые полосы живут на `L0…L6` (§8.1) и плавно гаснут до `L9`. */
  readonly dustFade: number;
  /**
   * Нормировка плотности по кадру (§17.12 `V-3`): средняя плотность кадра
   * приводится к `TARGET_MEAN_DENSITY`, поэтому `meanL` не уезжает от уровня
   * к уровню. Считается по данным кадра — грубой сетке `STATS_GRID²` точек.
   */
  readonly densityGain: number;
  readonly zoom: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Мировой центр кадра по одной оси. В `canvas-renderer.ts` (`toWorld`) экран
 * связан с миром как `screen = tx + world · scale`, поэтому мировая точка
 * в центре кадра — `(viewport.w / 2 − tx) / scale` (§17.5 п. 1 в редакции
 * от 25.10.2026); по `y` аналогично. `mapSize` — размер мира и запасной
 * размер кадра, если размеры не заданы.
 */
function frameCenter(axis: number, translate: number, scale: number, fallbackAxis: number): number {
  const span = axis > 0 ? axis : fallbackAxis;
  return (span / 2 - translate) / scale;
}

interface OctaveField {
  readonly weights: Float64Array;
  readonly normalizer: number;
  /** Пик облачного окна и пик детального окна (в индексах октав). */
  readonly cloudPeak: number;
  readonly detailPeak: number;
}

/** Вес окна: пик в `peak`, полуширина `halfWidth` октав, спад `COARSE_GAIN`. */
function windowWeight(index: number, peak: number, halfWidth: number): number {
  const t = (index - peak) / halfWidth;
  if (t <= -1 || t > 0) return 0;
  const window = (1 - t * t) * (1 - t * t);
  return window * COARSE_GAIN ** (peak - index);
}

/**
 * Окна октав для конкретного буфера. Оба пика выводятся из экранного масштаба:
 * `iₚ = log2(размер · zoom / (OCTAVE_BASE_FREQ · желаемая ячейка, px))`.
 * Поэтому при зуме в кадр приходит новое поколение частот, а не та же картинка.
 */
function buildOctaveField(width: number, height: number, zoom: number): OctaveField {
  const size = Math.sqrt(width * height);
  const cloudRaw = Math.log2((size * zoom) / (OCTAVE_BASE_FREQ * CLOUD_CELL_PX));
  const detailRaw = Math.log2((size * zoom) / (OCTAVE_BASE_FREQ * DETAIL_CELL_PX));
  const cloudPeak = Math.min(MAX_OCTAVES - 1, Math.max(0, cloudRaw));
  const detailPeak = Math.min(MAX_OCTAVES - 1, Math.max(0, detailRaw));
  const detailAmp = DETAIL_AMP_SHALLOW
    + (DETAIL_AMP_DEEP - DETAIL_AMP_SHALLOW) * smoothstep(DETAIL_ZOOM_FROM, DETAIL_ZOOM_TO, zoom);
  const weights = new Float64Array(MAX_OCTAVES);
  let sum = 0;
  for (let index = 0; index < MAX_OCTAVES; index++) {
    const amplitude = windowWeight(index, cloudPeak, CLOUD_WINDOW_WIDTH)
      + detailAmp * windowWeight(index, detailPeak, DETAIL_WINDOW_WIDTH);
    weights[index] = amplitude;
    sum += amplitude;
  }
  return { weights, normalizer: sum > 0 ? sum : 1, cloudPeak, detailPeak };
}

function buildFrame(state: SectorFieldState, divisor = 1): FrameMath {
  const mapSize = Math.max(1, finiteOr(state.mapSize, FALLBACK_MAP_SIZE));
  const rawW = Math.max(1, finiteOr(state.viewport?.w, FALLBACK_VIEWPORT));
  const rawH = Math.max(1, finiteOr(state.viewport?.h, FALLBACK_VIEWPORT));
  const dpr = Math.min(4, Math.max(1 / 8, finiteOr(state.dpr, 1)));
  const width = Math.min(MAX_RENDER_SIDE, Math.max(1, Math.round((rawW * dpr) / divisor)));
  const height = Math.min(MAX_RENDER_SIDE, Math.max(1, Math.round((rawH * dpr) / divisor)));

  // Масштаб: мир → пиксель буфера. Битый или нулевой — подгоняем кадр по ширине карты.
  const rawScale = finiteOr(state.view?.scale, 0);
  const scale = rawScale > 0 ? rawScale : rawW / mapSize;
  const deviceScale = (scale * dpr) / divisor;
  const centreX = frameCenter(
    rawW,
    finiteOr(state.view?.tx, (rawW - mapSize * scale) / 2),
    scale,
    mapSize,
  );
  const centreY = frameCenter(
    rawH,
    finiteOr(state.view?.ty, (rawH - mapSize * scale) / 2),
    scale,
    mapSize,
  );

  // Зум относительно кадра «вся карта»: 1 на L0, 16 на L4, 512 на L9.
  const visibleWorldWidth = rawW / scale;
  const zoom = mapSize / Math.max(1e-6, visibleWorldWidth);

  const octaves = buildOctaveField(width, height, zoom);
  // Частоты в ячейках на нормированное поле: ячейка ≈ N пикселей буфера.
  const cellFreq = (cellPx: number): number => (width * zoom) / cellPx;

  return {
    width,
    height,
    centreX,
    centreY,
    deviceScale,
    mapSize,
    octaveWeights: Array.from(octaves.weights),
    octaveNormalizer: octaves.normalizer,
    octavePeak: octaves.cloudPeak,
    // Варп двигает точку на несколько ячеек облачной октавы.
    warpAmp: WARP_CELLS / OCTAVE_BASE_FREQ / 2 ** octaves.cloudPeak,
    ridgeFreqMid: OCTAVE_BASE_FREQ * 2 ** (octaves.cloudPeak - 1),
    ridgeFreqFine: cellFreq(THREAD_CELL_PX),
    envelopeFreq: ENVELOPE_FREQ,
    detailWarpFreq: cellFreq(DETAIL_WARP_CELL_PX),
    detailWarpAmp: DETAIL_WARP_CELLS / (cellFreq(DETAIL_WARP_CELL_PX)),
    threadGain: THREAD_GAIN_SHALLOW
      + (THREAD_GAIN_DEEP - THREAD_GAIN_SHALLOW) * smoothstep(THREAD_ZOOM_FROM, THREAD_ZOOM_TO, zoom),
    dustFreqX: cellFreq(DUST_CELL_PX) / 4,
    dustFreqY: cellFreq(DUST_CELL_PX),
    starCell: STAR_CELL_PX / deviceScale,
    dustFade: 1 - smoothstep(40, 150, zoom),
    densityGain: 1,
    zoom,
  };
}

/* ------------------------------------------------------------------ цвет */

type Rgb = readonly [number, number, number];

interface ColorRamp {
  /** Пять опорных точек ровно из `densityStops` (§17.12 `V-1`). */
  readonly stops: readonly [number, number, number, number, number];
  /** Четыре цвета отрезков плюс производный пересвет ядра. */
  readonly colors: readonly [Rgb, Rgb, Rgb, Rgb, Rgb];
}

function mixColor(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
}

function buildRamp(palette: FieldPalette): ColorRamp {
  const stops = palette.densityStops;
  const highlight = mixColor(palette.core, [255, 255, 255], CORE_HIGHLIGHT_MIX);
  return {
    stops: [
      stops[0] ?? 0,
      stops[1] ?? 0.2,
      stops[2] ?? 0.45,
      stops[3] ?? 0.72,
      stops[4] ?? 0.95,
    ],
    colors: [palette.background, palette.dust, palette.rim, palette.core, highlight],
  };
}

/**
 * Цвет рампы пишется в `out` (общий буфер прохода): на кадр 1920×1080 это
 * два миллиона вызовов, и аллокация массива на пиксель стоила дороже самого шума.
 * Все четыре отрезка рампы используются в порядке `V-1`.
 */
function sampleRampInto(ramp: ColorRamp, density: number, out: Float64Array): void {
  const stops = ramp.stops;
  const colors = ramp.colors;
  const d = clamp01(density);
  let segment = 0;
  while (segment < 4 && d > (stops[segment + 1] ?? 1)) segment++;
  const low = stops[segment] ?? 0;
  const high = stops[segment + 1] ?? 1;
  const from = colors[segment] ?? colors[0];
  const to = colors[segment + 1] ?? colors[4];
  const t = high > low ? clamp01((d - low) / (high - low)) : 1;
  out[0] = from[0] + (to[0] - from[0]) * t;
  out[1] = from[1] + (to[1] - from[1]) * t;
  out[2] = from[2] + (to[2] - from[2]) * t;
}

/* ------------------------------------------------------------------ CPU-композитор */

interface CpuPass {
  readonly frame: FrameMath;
  readonly ramp: ColorRamp;
  readonly tuning: FieldTuning;
  /** Индекс пиковой (самой мелкой активной) октавы — для шума октав. */
  readonly peak: number;
  /** Буфер цвета текущего пикселя; переиспользуется, чтобы не аллоцировать на пиксель. */
  readonly out: Float64Array;
}

/**
 * Плотность поля в точке мира. Порядок операций совпадает с фрагментным
 * шейдером, чтобы обе ветки давали одну композицию.
 */
function computeDensity(pass: CpuPass, worldX: number, worldY: number): number {
  const { frame, tuning } = pass;
  const nx = worldX / frame.mapSize;
  const ny = worldY / frame.mapSize;

  // Домен-варп двух частот: крупные изгибы плюс мелкая рябь. Он превращает
  // гладкие пятна облака в волокна — без него `fBm` даёт «пузыри».
  const warpBigX = valueNoise(nx * WARP_FREQ_BIG, ny * WARP_FREQ_BIG, CHANNEL_SEEDS[CHANNEL_WARP_BIG_X] ?? 0) - 0.5;
  const warpBigY = valueNoise(nx * WARP_FREQ_BIG, ny * WARP_FREQ_BIG, CHANNEL_SEEDS[CHANNEL_WARP_BIG_Y] ?? 0) - 0.5;
  const warpSmallX = valueNoise(nx * WARP_FREQ_SMALL, ny * WARP_FREQ_SMALL, CHANNEL_SEEDS[CHANNEL_WARP_SMALL_X] ?? 0) - 0.5;
  const warpSmallY = valueNoise(nx * WARP_FREQ_SMALL, ny * WARP_FREQ_SMALL, CHANNEL_SEEDS[CHANNEL_WARP_SMALL_Y] ?? 0) - 0.5;
  const shiftedX = nx + (warpBigX + 0.6 * warpSmallX) * frame.warpAmp;
  const shiftedY = ny + (warpBigY + 0.6 * warpSmallY) * frame.warpAmp;
  // Облако вытянуто вдоль `x` слабо, нити — сильно (анизотропия).
  const cloudX = shiftedX / CLOUD_ANISOTROPY;
  const threadX = shiftedX / THREAD_ANISOTROPY;

  // Мелкий варп: размывает выравнивание мелких октав по осям решётки.
  const detailWarpX = (valueNoise(
    nx * frame.detailWarpFreq,
    ny * frame.detailWarpFreq,
    CHANNEL_SEEDS[CHANNEL_DETAIL_WARP_X] ?? 0,
  ) - 0.5) * frame.detailWarpAmp;
  const detailWarpY = (valueNoise(
    nx * frame.detailWarpFreq,
    ny * frame.detailWarpFreq,
    CHANNEL_SEEDS[CHANNEL_DETAIL_WARP_Y] ?? 0,
  ) - 0.5) * frame.detailWarpAmp;
  const fineX = threadX + detailWarpX;
  const fineY = shiftedY + detailWarpY;

  // Облако: fBm по облачному и детальному окнам октав.
  let sum = 0;
  const weights = frame.octaveWeights;
  for (let index = 0; index < weights.length; index++) {
    const amplitude = weights[index] ?? 0;
    if (amplitude <= 0) continue;
    const freq = OCTAVE_BASE_FREQ * 2 ** index;
    const coarse = index <= frame.octavePeak;
    sum += amplitude * valueNoise(
      (coarse ? cloudX : fineX) * freq,
      (coarse ? shiftedY : fineY) * freq,
      CHANNEL_SEEDS[CHANNEL_OCTAVE_BASE + (index % 12)] ?? 0,
    );
  }
  const base = sum / frame.octaveNormalizer;

  // Гребневые слои: средний филамент модулирует плотность облака, тонкая нить
  // добавляется только внутри плотных участков (иначе кадр «сереет» от соли).
  const ridgeMid = ridged(valueNoise(
    cloudX * frame.ridgeFreqMid,
    shiftedY * frame.ridgeFreqMid,
    CHANNEL_SEEDS[CHANNEL_RIDGE_MID] ?? 0,
  ));
  const filament = ridgeMid * ridgeMid * (3 - 2 * ridgeMid);
  const ridgeFine = ridged(valueNoise(
    fineX * frame.ridgeFreqFine,
    fineY * frame.ridgeFreqFine,
    CHANNEL_SEEDS[CHANNEL_RIDGE_FINE] ?? 0,
  ));

  // Оболочка: крупные пустоты и сгустки поверх всей карты.
  const envelope = valueNoise(nx * frame.envelopeFreq, ny * frame.envelopeFreq, CHANNEL_SEEDS[CHANNEL_ENVELOPE] ?? 0);
  const envelopeGain = 0.4 + 1.05 * smoothstep(0.18, 0.82, envelope);

  // Пылевые полосы (§8.1 `field.dust`, анизотропия 1:4) вычитаются из облака.
  const dust = valueNoise(shiftedX * frame.dustFreqX, shiftedY * frame.dustFreqY, CHANNEL_SEEDS[CHANNEL_DUST] ?? 0);
  const dustBand = smoothstep(0.52, 0.88, dust) * tuning.dustStrength * frame.dustFade;

  // Контраст облака: сдвиг к середине и S-кривая (только умножения).
  const shaped = clamp01(
    (base - 0.5) * tuning.cloudContrast + 0.5 + tuning.densityBias,
  ) * envelopeGain;
  const cloud = shaped * shaped * (3 - 2 * shaped);

  // Волокна: модуляция облака гребнем плюс тонкие нити внутри плотных участков.
  const weaved = cloud * (1 - tuning.ridgeStrength + tuning.ridgeStrength * filament);
  const fine = ridgeFine * ridgeFine;
  const thread = fine * tuning.fineStrength * frame.threadGain
    * weaved * (0.25 + 0.75 * (1 - weaved));

  return clamp01((weaved + thread - dustBand * 0.85) * tuning.densityScale);
}

/**
 * Один пиксель растра. Результат — в `pass.out` (значения в шкале `0…255`).
 */
function composePixel(pass: CpuPass, worldX: number, worldY: number): void {
  const { ramp, tuning, out, frame } = pass;
  const density = clamp01(computeDensity(pass, worldX, worldY) * frame.densityGain);

  sampleRampInto(ramp, density, out);
  let r = out[0] ?? 0;
  let g = out[1] ?? 0;
  let b = out[2] ?? 0;

  // Звёздная пыль: power-law яркость, одна звезда на ячейку 3 device-пикселя.
  const starX = worldX / frame.starCell;
  const starY = worldY / frame.starCell;
  const cellX = Math.floor(starX);
  const cellY = Math.floor(starY);
  const presence = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_PRESENCE] ?? 0);
  if (presence < tuning.starPresence) {
    const starPosX = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_X] ?? 0);
    const starPosY = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_Y] ?? 0);
    const spread = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_BRIGHTNESS] ?? 0);
    // Показатель степени 4 через умножения: без `pow`, побитово одинаково везде.
    const power = spread * spread * spread * spread;
    const dx = (starX - cellX) - starPosX;
    const dy = (starY - cellY) - starPosY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.34) {
      const falloff = 1 - distance / 0.34;
      const glow = clamp01(falloff * falloff * power * tuning.starGain);
      r += (255 - r) * glow * 0.94 + ramp.colors[3][0] * glow * 0.06;
      g += (255 - g) * glow * 0.94 + ramp.colors[3][1] * glow * 0.06;
      b += (255 - b) * glow * 0.94 + ramp.colors[3][2] * glow * 0.06;
    }
  }

  out[0] = r;
  out[1] = g;
  out[2] = b;
}

/**
 * Нормировка по кадру: плотность замеряется на грубой сетке точек кадра
 * (детерминированно, без истории между кадрами), и коэффициент подбирается так,
 * чтобы средняя плотность кадра равнялась `TARGET_MEAN_DENSITY`. Это держит
 * `meanL` в полосе `12…40` и не даёт уровню «проваливаться» в тёмную часть
 * оболочки (§17.12 `V-3`).
 */
function frameDensityGain(base: CpuPass): number {
  const { frame } = base;
  const halfWidth = frame.width / 2;
  const halfHeight = frame.height / 2;
  const invDevice = 1 / frame.deviceScale;
  let sum = 0;
  let count = 0;
  for (let row = 0; row < STATS_GRID; row++) {
    const y = ((row + 0.5) / STATS_GRID) * frame.height;
    const worldY = frame.centreY + (y - halfHeight) * invDevice;
    for (let column = 0; column < STATS_GRID; column++) {
      const x = ((column + 0.5) / STATS_GRID) * frame.width;
      const worldX = frame.centreX + (x - halfWidth) * invDevice;
      sum += computeDensity(base, worldX, worldY);
      count++;
    }
  }
  const mean = count > 0 ? sum / count : 0;
  if (!(mean > 1e-6)) return STATS_GAIN_MAX;
  return Math.min(STATS_GAIN_MAX, Math.max(STATS_GAIN_MIN, TARGET_MEAN_DENSITY / mean));
}

function composeCpuData(state: SectorFieldState, palette: FieldPalette, divisor = 1): ImageData {
  const baseFrame = buildFrame(state, divisor);
  const probe: CpuPass = {
    frame: baseFrame,
    ramp: buildRamp(palette),
    tuning: FIELD_TUNING[palette.id],
    peak: Math.ceil(baseFrame.octavePeak),
    out: new Float64Array(3),
  };
  const frame: FrameMath = { ...baseFrame, densityGain: frameDensityGain(probe) };
  const pass: CpuPass = { ...probe, frame };
  const { width, height, centreX, centreY, deviceScale } = frame;
  const data = new Uint8ClampedArray(width * height * 4);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const ditherSeed = CHANNEL_SEEDS[CHANNEL_DITHER] ?? 0;
  const invDevice = 1 / deviceScale;

  for (let y = 0; y < height; y++) {
    const worldY = centreY + (y + 0.5 - halfHeight) * invDevice;
    let offset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const worldX = centreX + (x + 0.5 - halfWidth) * invDevice;
      composePixel(pass, worldX, worldY);
      // Дизеринг ±0,5/255 (§8.3): иначе на тёмном фоне видны полосы квантования.
      const dither = (latticeValue(x, y, ditherSeed) - 0.5) / 255;
      data[offset] = Math.round((clamp01((pass.out[0] ?? 0) / 255) + dither) * 255);
      data[offset + 1] = Math.round((clamp01((pass.out[1] ?? 0) / 255) + dither) * 255);
      data[offset + 2] = Math.round((clamp01((pass.out[2] ?? 0) / 255) + dither) * 255);
      data[offset + 3] = 255;
      offset += 4;
    }
  }

  return toImageData(width, height, data);
}

/**
 * Билинейное растяжение буфера пониженного разрешения в полный кадр.
 * Арифметика в `float64` с фиксированным порядком операций — детерминирована.
 */
/**
 * Билинейное растяжение буфера пониженного разрешения в полный кадр.
 * Два прохода (по строкам, затем по столбцам) вместо четырёх выборок на пиксель:
 * на 1920 × 1080 это вдвое дешевле и всё ещё детерминировано (фиксированный
 * порядок операций, `Uint8ClampedArray` округляет одинаково везде).
 */
function upscaleBilinear(source: ImageData, width: number, height: number): ImageData {
  if (source.width === width && source.height === height) return source;
  const input = source.data;
  const srcW = source.width;
  const srcH = source.height;
  const output = new Uint8ClampedArray(width * height * 4);
  const scaleX = srcW / width;
  const scaleY = srcH / height;

  // Карты выборки по `x` считаются один раз на кадр.
  const leftMap = new Uint32Array(width);
  const rightMap = new Uint32Array(width);
  const mixMap = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const sourceX = Math.min(srcW - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
    const left = Math.floor(sourceX);
    leftMap[x] = left;
    rightMap[x] = Math.min(srcW - 1, left + 1);
    mixMap[x] = sourceX - left;
  }

  // Промежуточная строка после вертикальной интерполяции (в `float`, не в байтах).
  const row = new Float64Array(srcW * 3);

  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(srcH - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const rowTop = Math.floor(sourceY);
    const rowBottom = Math.min(srcH - 1, rowTop + 1);
    const fy = sourceY - rowTop;
    const baseTop = rowTop * srcW * 4;
    const baseBottom = rowBottom * srcW * 4;

    for (let column = 0; column < srcW; column++) {
      const top = baseTop + column * 4;
      const bottom = baseBottom + column * 4;
      const slot = column * 3;
      row[slot] = (input[top] ?? 0) + ((input[bottom] ?? 0) - (input[top] ?? 0)) * fy;
      row[slot + 1] = (input[top + 1] ?? 0) + ((input[bottom + 1] ?? 0) - (input[top + 1] ?? 0)) * fy;
      row[slot + 2] = (input[top + 2] ?? 0) + ((input[bottom + 2] ?? 0) - (input[top + 2] ?? 0)) * fy;
    }

    let offset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const from = (leftMap[x] ?? 0) * 3;
      const to = (rightMap[x] ?? 0) * 3;
      const fx = mixMap[x] ?? 0;
      const left = row[from] ?? 0;
      const right = row[to] ?? 0;
      output[offset] = left + (right - left) * fx;
      const leftG = row[from + 1] ?? 0;
      const rightG = row[to + 1] ?? 0;
      output[offset + 1] = leftG + (rightG - leftG) * fx;
      const leftB = row[from + 2] ?? 0;
      const rightB = row[to + 2] ?? 0;
      output[offset + 2] = leftB + (rightB - leftB) * fx;
      output[offset + 3] = 255;
      offset += 4;
    }
  }

  return toImageData(width, height, output);
}

/**
 * `ImageData` без зависимости от `<canvas>`: в браузере — конструктор,
 * в Node (`globalThis.ImageData` отсутствует) — структурно совместимый объект.
 */
function toImageData(width: number, height: number, data: Uint8ClampedArray<ArrayBuffer>): ImageData {
  const scope = globalThis as typeof globalThis & { ImageData?: typeof ImageData };
  const Ctor = scope.ImageData;
  if (typeof Ctor === 'function') {
    try {
      return new Ctor(data, width, height);
    } catch {
      /* конструктор есть, но не принял данные — уходим в структурный объект */
    }
  }
  return { width, height, data, colorSpace: 'srgb' } as unknown as ImageData;
}

/* ------------------------------------------------------------------ WebGL2 */

const VERTEX_SHADER = `#version 300 es
// Полноэкранный треугольник без буферов: три вершины по gl_VertexID.
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
`;

function unitTriplet(color: Rgb): string {
  return color.map((channel) => (channel / 255).toFixed(6)).join(', ');
}

/** GLSL-источник собирается из тех же таблиц, что и CPU-путь: числа не дублируются. */
function buildFragmentShader(palette: FieldPalette, tuning: FieldTuning): string {
  const octaveFreq = Array.from(
    { length: MAX_OCTAVES },
    (_unused, index) => (OCTAVE_BASE_FREQ * 2 ** index).toFixed(6),
  ).join(', ');
  const ramp = buildRamp(palette);
  const stops = ramp.stops.map((stop) => stop.toFixed(6));

  return `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_resolution;    // размер растра в device-пикселях
uniform vec2 u_offsetHi;      // старшая часть мирового центра кадра
uniform vec2 u_offsetLo;      // младшая часть мирового центра кадра
uniform float u_deviceScale;  // device-пикселей на мировую единицу
uniform float u_mapSize;
uniform float u_starCell;     // ячейка звёздной пыли в мировых единицах
uniform float u_dustFade;     // затухание пылевых полос на глубоких уровнях
uniform float u_warpAmp;      // амплитуда домен-варпа (в долях поля)
uniform float u_envelopeFreq;
uniform float u_detailWarpFreq;
uniform float u_detailWarpAmp;
uniform vec2 u_dustFreq;
uniform float u_densityGain;
uniform float u_threadGain;
uniform float u_ridgeFreqMid;
uniform float u_ridgeFreqFine;
uniform float u_octaveWeight[${MAX_OCTAVES}];
uniform float u_octaveNormalizer;
uniform int u_cloudPeak;
uniform uint u_seed;

out vec4 fragColor;

const float OCTAVE_FREQ[${MAX_OCTAVES}] = float[${MAX_OCTAVES}](${octaveFreq});
const float WARP_FREQ_BIG = ${WARP_FREQ_BIG.toFixed(6)};
const float WARP_FREQ_SMALL = ${WARP_FREQ_SMALL.toFixed(6)};
const float CLOUD_ANISOTROPY = ${CLOUD_ANISOTROPY.toFixed(6)};
const float THREAD_ANISOTROPY = ${THREAD_ANISOTROPY.toFixed(6)};
const float CLOUD_CONTRAST = ${tuning.cloudContrast.toFixed(6)};
const float DENSITY_BIAS = ${tuning.densityBias.toFixed(6)};
const float DENSITY_SCALE = ${tuning.densityScale.toFixed(6)};
const float RIDGE_STRENGTH = ${tuning.ridgeStrength.toFixed(6)};
const float FINE_STRENGTH = ${tuning.fineStrength.toFixed(6)};
const float DUST_STRENGTH = ${tuning.dustStrength.toFixed(6)};
const float DUST_TINT = ${tuning.dustTint.toFixed(6)};
const float STAR_PRESENCE = ${tuning.starPresence.toFixed(6)};
const float STAR_GAIN = ${tuning.starGain.toFixed(6)};

const vec3 RAMP0 = vec3(${unitTriplet(ramp.colors[0])});
const vec3 RAMP1 = vec3(${unitTriplet(ramp.colors[1])});
const vec3 RAMP2 = vec3(${unitTriplet(ramp.colors[2])});
const vec3 RAMP3 = vec3(${unitTriplet(ramp.colors[3])});
const vec3 RAMP4 = vec3(${unitTriplet(ramp.colors[4])});
const float STOP0 = ${stops[0]};
const float STOP1 = ${stops[1]};
const float STOP2 = ${stops[2]};
const float STOP3 = ${stops[3]};
const float STOP4 = ${stops[4]};

// Та же решётка, что latticeValue на CPU: только умножения, сдвиги и xor.
uint latticeHash(vec2 cell, uint channel) {
  ivec2 index = ivec2(cell);
  uint hash = (uint(index.x) * 0x9e3779b1u) ^ (uint(index.y) * 0x85ebca6bu) ^ (u_seed ^ (channel * 0x2545f491u));
  hash ^= hash >> 15u;
  hash *= 0x2c1b3c6du;
  hash ^= hash >> 13u;
  hash *= 0x297a2d39u;
  hash ^= hash >> 16u;
  return hash;
}

float latticeValue(vec2 cell, uint channel) {
  return float(latticeHash(cell, channel)) / 4294967296.0;
}

float valueNoise(vec2 point, uint channel) {
  vec2 cell = floor(point);
  vec2 local = point - cell;
  vec2 curve = local * local * (3.0 - 2.0 * local);
  float v00 = latticeValue(cell, channel);
  float v10 = latticeValue(cell + vec2(1.0, 0.0), channel);
  float v01 = latticeValue(cell + vec2(0.0, 1.0), channel);
  float v11 = latticeValue(cell + vec2(1.0, 1.0), channel);
  return mix(mix(v00, v10, curve.x), mix(v01, v11, curve.x), curve.y);
}

float ridged(float value) {
  return 1.0 - abs(2.0 * value - 1.0);
}

float smoothBand(float edge0, float edge1, float value) {
  float t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

vec3 rampColor(float density) {
  float d = clamp(density, 0.0, 1.0);
  if (d <= STOP1) return mix(RAMP0, RAMP1, clamp((d - STOP0) / max(STOP1 - STOP0, 1e-6), 0.0, 1.0));
  if (d <= STOP2) return mix(RAMP1, RAMP2, clamp((d - STOP1) / max(STOP2 - STOP1, 1e-6), 0.0, 1.0));
  if (d <= STOP3) return mix(RAMP2, RAMP3, clamp((d - STOP2) / max(STOP3 - STOP2, 1e-6), 0.0, 1.0));
  return mix(RAMP3, RAMP4, clamp((d - STOP3) / max(STOP4 - STOP3, 1e-6), 0.0, 1.0));
}

float computeDensity(vec2 point) {
  vec2 warpBig = vec2(
    valueNoise(point * WARP_FREQ_BIG, ${CHANNEL_WARP_BIG_X}u),
    valueNoise(point * WARP_FREQ_BIG, ${CHANNEL_WARP_BIG_Y}u)
  ) - 0.5;
  vec2 warpSmall = vec2(
    valueNoise(point * WARP_FREQ_SMALL, ${CHANNEL_WARP_SMALL_X}u),
    valueNoise(point * WARP_FREQ_SMALL, ${CHANNEL_WARP_SMALL_Y}u)
  ) - 0.5;
  vec2 shifted = point + (warpBig + 0.6 * warpSmall) * u_warpAmp;
  float cloudAxisX = shifted.x / CLOUD_ANISOTROPY;
  float threadAxisX = shifted.x / THREAD_ANISOTROPY;
  vec2 detailWarp = vec2(
    valueNoise(point * u_detailWarpFreq, ${CHANNEL_DETAIL_WARP_X}u),
    valueNoise(point * u_detailWarpFreq, ${CHANNEL_DETAIL_WARP_Y}u)
  ) - 0.5;
  vec2 fineWarped = vec2(threadAxisX, shifted.y) + detailWarp * u_detailWarpAmp;

  float sum = 0.0;
  for (int index = 0; index < ${MAX_OCTAVES}; index++) {
    float amplitude = u_octaveWeight[index];
    if (amplitude <= 0.0) continue;
    vec2 octavePoint = index <= u_cloudPeak
      ? vec2(cloudAxisX, shifted.y)
      : fineWarped;
    sum += amplitude * valueNoise(octavePoint * OCTAVE_FREQ[index], ${CHANNEL_OCTAVE_BASE}u + uint(index % 12));
  }
  float base = sum / u_octaveNormalizer;

  float ridgeMid = ridged(valueNoise(vec2(cloudAxisX, shifted.y) * u_ridgeFreqMid, ${CHANNEL_RIDGE_MID}u));
  float filament = ridgeMid * ridgeMid * (3.0 - 2.0 * ridgeMid);
  float ridgeFine = ridged(valueNoise(fineWarped * u_ridgeFreqFine, ${CHANNEL_RIDGE_FINE}u));

  float envelope = valueNoise(point * u_envelopeFreq, ${CHANNEL_ENVELOPE}u);
  float envelopeGain = 0.4 + 1.05 * smoothBand(0.18, 0.82, envelope);

  float dust = valueNoise(shifted * u_dustFreq, ${CHANNEL_DUST}u);
  float dustBand = smoothBand(0.52, 0.88, dust) * DUST_STRENGTH * u_dustFade;

  float shaped = clamp((base - 0.5) * CLOUD_CONTRAST + 0.5 + DENSITY_BIAS, 0.0, 1.0) * envelopeGain;
  float cloud = shaped * shaped * (3.0 - 2.0 * shaped);

  float weaved = cloud * (1.0 - RIDGE_STRENGTH + RIDGE_STRENGTH * filament);
  float fine = ridgeFine * ridgeFine;
  float thread = fine * FINE_STRENGTH * u_threadGain * weaved * (0.25 + 0.75 * (1.0 - weaved));

  return clamp((weaved + thread - dustBand * 0.85) * DENSITY_SCALE, 0.0, 1.0);
}

void main() {
  // Камеро-относительные координаты: из JS приходит только смещение от центра.
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 delta = (frag - 0.5 * u_resolution) / u_deviceScale;
  vec2 world = u_offsetHi + (u_offsetLo + delta);
  vec2 point = world / u_mapSize;

  float density = clamp(computeDensity(point) * u_densityGain, 0.0, 1.0);
  vec3 color = rampColor(density);

  // Звёздная пыль: power-law яркость, одна звезда на ячейку.
  vec2 starPoint = world / u_starCell;
  vec2 starCell = floor(starPoint);
  vec2 inside = starPoint - starCell;
  if (latticeValue(starCell, ${CHANNEL_STAR_PRESENCE}u) < STAR_PRESENCE) {
    vec2 starPos = vec2(
      latticeValue(starCell, ${CHANNEL_STAR_X}u),
      latticeValue(starCell, ${CHANNEL_STAR_Y}u)
    );
    float spread = latticeValue(starCell, ${CHANNEL_STAR_BRIGHTNESS}u);
    float power = spread * spread * spread * spread;
    float distance = length(inside - starPos);
    if (distance < 0.34) {
      float falloff = 1.0 - distance / 0.34;
      float glow = clamp(falloff * falloff * power * STAR_GAIN, 0.0, 1.0);
      color += (vec3(1.0) - color) * glow * 0.94 + RAMP3 * glow * 0.06;
    }
  }

  // Дизеринг ±0,5/255 на выходе. Это шум, а не сигнал: его узор между CPU и GPU
  // намеренно не совпадает (разные порядки обхода), вклад в канал ≤ 0,5/255 —
  // в допуске G7.6 между ветками.
  float dither = (latticeValue(floor(frag), ${CHANNEL_DITHER}u) - 0.5) / 255.0;
  fragColor = vec4(clamp(color + dither, 0.0, 1.0), 1.0);
}
`;
}

interface GlRuntime {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly uniforms: {
    readonly resolution: WebGLUniformLocation | null;
    readonly offsetHi: WebGLUniformLocation | null;
    readonly offsetLo: WebGLUniformLocation | null;
    readonly deviceScale: WebGLUniformLocation | null;
    readonly mapSize: WebGLUniformLocation | null;
    readonly starCell: WebGLUniformLocation | null;
    readonly dustFade: WebGLUniformLocation | null;
    readonly warpAmp: WebGLUniformLocation | null;
    readonly envelopeFreq: WebGLUniformLocation | null;
    readonly detailWarpFreq: WebGLUniformLocation | null;
    readonly detailWarpAmp: WebGLUniformLocation | null;
    readonly threadGain: WebGLUniformLocation | null;
    readonly ridgeFreqMid: WebGLUniformLocation | null;
    readonly ridgeFreqFine: WebGLUniformLocation | null;
    readonly dustFreq: WebGLUniformLocation | null;
    readonly densityGain: WebGLUniformLocation | null;
    readonly octaveWeight: WebGLUniformLocation | null;
    readonly octaveNormalizer: WebGLUniformLocation | null;
    readonly cloudPeak: WebGLUniformLocation | null;
    readonly seed: WebGLUniformLocation | null;
  };
  readonly octaveCount: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createGlRuntime(gl: WebGL2RenderingContext, style: FieldStyle): GlRuntime | null {
  const palette = FIELD_PALETTES.find((item) => item.id === style) ?? FIELD_PALETTES[0];
  if (!palette) return null;

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, buildFragmentShader(palette, FIELD_TUNING[style]));
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  return {
    gl,
    program,
    octaveCount: MAX_OCTAVES,
    uniforms: {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      offsetHi: gl.getUniformLocation(program, 'u_offsetHi'),
      offsetLo: gl.getUniformLocation(program, 'u_offsetLo'),
      deviceScale: gl.getUniformLocation(program, 'u_deviceScale'),
      mapSize: gl.getUniformLocation(program, 'u_mapSize'),
      starCell: gl.getUniformLocation(program, 'u_starCell'),
      dustFade: gl.getUniformLocation(program, 'u_dustFade'),
      warpAmp: gl.getUniformLocation(program, 'u_warpAmp'),
      envelopeFreq: gl.getUniformLocation(program, 'u_envelopeFreq'),
      detailWarpFreq: gl.getUniformLocation(program, 'u_detailWarpFreq'),
      detailWarpAmp: gl.getUniformLocation(program, 'u_detailWarpAmp'),
      threadGain: gl.getUniformLocation(program, 'u_threadGain'),
      ridgeFreqMid: gl.getUniformLocation(program, 'u_ridgeFreqMid'),
      ridgeFreqFine: gl.getUniformLocation(program, 'u_ridgeFreqFine'),
      dustFreq: gl.getUniformLocation(program, 'u_dustFreq'),
      densityGain: gl.getUniformLocation(program, 'u_densityGain'),
      octaveWeight: gl.getUniformLocation(program, 'u_octaveWeight[0]'),
      octaveNormalizer: gl.getUniformLocation(program, 'u_octaveNormalizer'),
      cloudPeak: gl.getUniformLocation(program, 'u_cloudPeak'),
      seed: gl.getUniformLocation(program, 'u_seed'),
    },
  };
}

/* ------------------------------------------------------------------ фасад */

const DEFAULT_STYLE: FieldStyle = 'nebula';

function resolveStyle(opts?: { readonly style?: FieldStyle }): FieldStyle {
  const requested = opts?.style;
  if (requested === 'tactical' || requested === 'nebula') return requested;
  // Неизвестный стиль из `?style=` не бросает исключение — падаем на дефолт.
  return DEFAULT_STYLE;
}

function paletteOf(style: FieldStyle): FieldPalette {
  return FIELD_PALETTES.find((item) => item.id === style) ?? (FIELD_PALETTES[0] as FieldPalette);
}

/** Ключ кэша экранного кадра (§17.5 п. 5): всё, от чего зависит картинка. */
function cacheKey(style: FieldStyle, state: SectorFieldState, width: number, height: number): string {
  return [
    style,
    finiteOr(state.view?.scale, 0),
    finiteOr(state.view?.tx, 0),
    finiteOr(state.view?.ty, 0),
    finiteOr(state.viewport?.w, 0),
    finiteOr(state.viewport?.h, 0),
    finiteOr(state.dpr, 1),
    finiteOr(state.mapSize, 0),
    width,
    height,
  ].join('|');
}

/**
 * Создаёт поле сектора. `canvas === null` — гарантированный CPU-путь
 * (тесты и предпросмотр в Node); при живом холсте сначала пробуем WebGL2.
 */
export function createSectorField(
  canvas: HTMLCanvasElement | null,
  opts?: { readonly style?: FieldStyle },
): SectorField {
  const style = resolveStyle(opts);
  const palette = paletteOf(style);

  let disposed = false;
  let lost = false;
  let runtime: GlRuntime | null = null;
  let context2d: CanvasRenderingContext2D | null = null;
  let cachedFrame: {
    readonly key: string;
    readonly low: ImageData;
    readonly full: ImageData | null;
  } | null = null;
  let offscreen: HTMLCanvasElement | null = null;
  let nativeScaleBroken = false;
  const cleanups: Array<() => void> = [];

  function attachContextWatchers(gl: WebGL2RenderingContext): void {
    if (canvas === null) return;
    const onLost = (event: Event): void => {
      // Контекст восстановим, но до восстановления честно сообщаем 'cpu'.
      event.preventDefault();
      lost = true;
    };
    const onRestored = (): void => {
      lost = false;
      runtime = createGlRuntime(gl, style);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    cleanups.push(() => {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    });
  }

  if (canvas !== null && typeof canvas.getContext === 'function') {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      }) as WebGL2RenderingContext | null;
      if (gl) {
        runtime = createGlRuntime(gl, style);
        if (runtime) attachContextWatchers(gl);
      }
    } catch {
      runtime = null;
    }
  }

  function drawWithGl(state: SectorFieldState): boolean {
    const current = runtime;
    if (!current || lost || disposed || canvas === null) return false;

    const baseFrame = buildFrame(state);
      const probe: CpuPass = {
      frame: baseFrame,
      ramp: buildRamp(palette),
      tuning: FIELD_TUNING[style],
      peak: Math.ceil(baseFrame.octavePeak),
      out: new Float64Array(3),
    };
    const gain = frameDensityGain(probe);
    const glFrame: FrameMath = { ...baseFrame, densityGain: gain };
    const frame = glFrame;
    const { gl, program, uniforms } = current;
    const background = palette.background;

    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;

    // Мировой центр кадра разложен на старшую и младшую части (§17.5 п. 1).
    const hiX = Math.fround(frame.centreX);
    const hiY = Math.fround(frame.centreY);
    const loX = frame.centreX - hiX;
    const loY = frame.centreY - hiY;

    try {
      // Сбрасываем старые ошибки, чтобы не принять чужую за сбой кадра.
      for (let guard = 0; guard < 4 && gl.getError() !== gl.NO_ERROR; guard++) {
        /* выбрасываем накопленные коды ошибок */
      }
      gl.viewport(0, 0, frame.width, frame.height);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(background[0] / 255, background[1] / 255, background[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, frame.width, frame.height);
      gl.uniform2f(uniforms.offsetHi, hiX, hiY);
      gl.uniform2f(uniforms.offsetLo, loX, loY);
      gl.uniform1f(uniforms.deviceScale, frame.deviceScale);
      gl.uniform1f(uniforms.mapSize, frame.mapSize);
      gl.uniform1f(uniforms.starCell, frame.starCell);
      gl.uniform1f(uniforms.dustFade, frame.dustFade);
      gl.uniform1f(uniforms.densityGain, glFrame.densityGain);
      gl.uniform1f(uniforms.warpAmp, frame.warpAmp);
      gl.uniform1f(uniforms.envelopeFreq, frame.envelopeFreq);
      gl.uniform1f(uniforms.detailWarpFreq, frame.detailWarpFreq);
      gl.uniform1f(uniforms.detailWarpAmp, frame.detailWarpAmp);
      gl.uniform1f(uniforms.threadGain, frame.threadGain);
      gl.uniform1f(uniforms.ridgeFreqMid, frame.ridgeFreqMid);
      gl.uniform1f(uniforms.ridgeFreqFine, frame.ridgeFreqFine);
      gl.uniform2f(uniforms.dustFreq, frame.dustFreqX, frame.dustFreqY);
      gl.uniform1f(uniforms.octaveNormalizer, frame.octaveNormalizer);
      gl.uniform1i(uniforms.cloudPeak, probe.peak);
      gl.uniform1ui(uniforms.seed, BASE_SEED >>> 0);
      if (uniforms.octaveWeight) {
        const weights = new Float32Array(current.octaveCount);
        for (let index = 0; index < weights.length; index++) weights[index] = frame.octaveWeights[index] ?? 0;
        gl.uniform1fv(uniforms.octaveWeight, weights);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (gl.getError() !== gl.NO_ERROR) {
        runtime = null;
        return false;
      }
      return true;
    } catch {
      runtime = null;
      return false;
    }
  }

  function context2dOrNull(): CanvasRenderingContext2D | null {
    if (canvas === null) return null;
    if (!context2d) {
      try {
        // Холст мог быть уже занят WebGL — тогда 2D-контекста не будет.
        context2d = canvas.getContext('2d') as CanvasRenderingContext2D | null;
      } catch {
        context2d = null;
      }
    }
    return context2d;
  }

  /**
   * Растяжение буфера средствами холста: `drawImage` делает это на GPU и это
   * единственный путь, укладывающийся в бюджет `G7.4` на слабом железе.
   * Доступно только при живом `<canvas>` и `document`; иначе — JS-фолбэк.
   */
  function canUpscaleNative(ctx: CanvasRenderingContext2D): boolean {
    if (nativeScaleBroken) return false;
    const scope = globalThis as typeof globalThis & {
      document?: { createElement(tag: string): unknown };
    };
    if (!scope.document || typeof ctx.drawImage !== 'function') {
      nativeScaleBroken = true;
      return false;
    }
    return true;
  }

  function upscaleNative(ctx: CanvasRenderingContext2D, low: ImageData, width: number, height: number): boolean {
    if (!canUpscaleNative(ctx)) return false;
    try {
      const scope = globalThis as typeof globalThis & {
        document?: { createElement(tag: string): HTMLCanvasElement };
      };
      const doc = scope.document;
      if (!doc || typeof ctx.drawImage !== 'function') return false;
      if (offscreen === null) offscreen = doc.createElement('canvas');
      if (offscreen.width !== low.width) offscreen.width = low.width;
      if (offscreen.height !== low.height) offscreen.height = low.height;
      const offCtx = offscreen.getContext('2d');
      if (!offCtx) {
        nativeScaleBroken = true;
        return false;
      }
      offCtx.putImageData(low, 0, 0);
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(offscreen, 0, 0, low.width, low.height, 0, 0, width, height);
      return true;
    } catch {
      nativeScaleBroken = true;
      return false;
    }
  }

  function drawWithCpu(state: SectorFieldState): void {
    if (canvas === null) return;
    const ctx = context2dOrNull();
    if (!ctx) return;

    const full = buildFrame(state);
    const key = cacheKey(style, state, full.width, full.height);
    const cached = cachedFrame !== null && cachedFrame.key === key ? cachedFrame : null;
    const nativeUpscale = canUpscaleNative(ctx);
    const low = cached
      ? cached.low
      : composeCpuData(state, palette, screenDivisor(state, nativeUpscale));

    // Нативный блит: низкое разрешение остаётся в кэше, растягивает сам холст.
    if (nativeUpscale) {
      // Размер холста сбрасывает состояние контекста — ставим его до отрисовки.
      if (canvas.width !== full.width) canvas.width = full.width;
      if (canvas.height !== full.height) canvas.height = full.height;
      if (upscaleNative(ctx, low, full.width, full.height)) {
        cachedFrame = { key, low, full: null };
        return;
      }
    }

    // JS-фолбэк: полный кадр собирается один раз и живёт в кэше.
    const image = cached?.full ?? upscaleBilinear(low, full.width, full.height);
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    try {
      ctx.putImageData(image, 0, 0);
    } catch {
      /* нет доступа к пикселям — тихий no-op, кадр рисует верхний слой */
    }
    cachedFrame = { key, low, full: image };
  }

  return {
    style,
    get backend(): 'webgl2' | 'cpu' {
      return runtime !== null && !lost && !disposed ? 'webgl2' : 'cpu';
    },
    renderField(state: SectorFieldState): void {
      if (disposed || canvas === null) return;
      if (runtime !== null) {
        drawWithGl(state);
        return;
      }
      drawWithCpu(state);
    },
    renderToImageData(state: SectorFieldState): ImageData {
      return composeCpuData(state, palette, 1);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {
          /* слушатели могли исчезнуть вместе с холстом */
        }
      }
      cleanups.length = 0;
      const current = runtime;
      runtime = null;
      context2d = null;
      cachedFrame = null;
      offscreen = null;
      if (current) {
        try {
          current.gl.deleteProgram(current.program);
          current.gl.getExtension('WEBGL_lose_context')?.loseContext();
        } catch {
          /* контекст уже потерян — освобождать нечего */
        }
      }
    },
  };
}
