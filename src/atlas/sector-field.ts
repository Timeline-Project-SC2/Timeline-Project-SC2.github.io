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
 * Периодичность по карте и глубокий пресет — §17.15.5 и §17.15.6.
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
 *     разрешения (не выше `1/3` линейно от `viewport · dpr`) и растягивается
 *     билинейно, готовый кадр кэшируется по состоянию вида (§17.5 п. 5).
 *     Полноразмерный и точный путь — только `renderToImageData`.
 *  7. Периодичность по карте (§17.15.6 п. 1). Все частоты шума — целое число
 *     ячеек на карту, решётка заворачивается по модулю этого числа, а центр
 *     кадра приводится по модулю `mapSize`. Поэтому `field(x, y)` побитово равен
 *     `field(x ± mapSize, y ± mapSize)`: соседний сектор — продолжение поля.
 *  8. Глубина (§17.15.5). Необязательное `edgeDist` гасит туманность и пыль
 *     монотонно: при `edgeDist ≤ 1` остаются только звёздная пыль и мягкий фон
 *     плотностью ≤ `0,02`, при `edgeDist ≥ 4` поле обычное. Без `edgeDist` —
 *     прежнее полное поле.
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
  /**
   * Расстояние от цели до ближайшей границы кадра в св.г. (§17.15.1).
   * Если задано, работает глубина: при `edgeDist ≤ 1` туманность и пыль
   * погашены полностью, остаются звёздная пыль и мягкий фон (§17.15.5).
   * Поле необязательное: без него пресет прежний, полное поле.
   */
  readonly edgeDist?: number;
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
const CHANNEL_RIDGE_FINE_2 = 24;
const CHANNEL_RIDGE_FINE_3 = 25;
const CHANNEL_DUST_2 = 26;
const CHANNEL_ENVELOPE = 14;
const CHANNEL_DETAIL_WARP_X = 12;
const CHANNEL_DETAIL_WARP_Y = 13;
const CHANNEL_DUST = 17;
const CHANNEL_STAR_PRESENCE = 19;
const CHANNEL_STAR_X = 20;
const CHANNEL_STAR_Y = 21;
const CHANNEL_STAR_BRIGHTNESS = 22;
const CHANNEL_DITHER = 23;
const CHANNEL_LIMIT = 27;

/**
 * Домен-варп двух частот: крупные изгибы облака и мелкая «рябь» филаментов.
 * Обе частоты — **целые ячейки на карту**: только тогда заворот решётки по
 * модулю числа ячеек даёт периодичное поле (§17.15.6 п. 1). `3,2` из первой
 * редакции давало шов на стыке секторов, поэтому частота округлена до `3`.
 */
const WARP_FREQ_BIG = 3;
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
const THREAD_ZOOM_TO = 12;
/** Оболочка: крупные пустоты и сгустки, частота в целых ячейках на карту. */
const ENVELOPE_FREQ = 3;
/** Мелкий варп детальной полосы: ячейка и амплитуда в этих же ячейках. */
const DETAIL_WARP_CELL_PX = 26;
const DETAIL_WARP_CELLS = 0.85;
/** Пылевые полосы (§8.1, слой `field.dust`, анизотропия 1:4), ячейка в пикселях. */
const DUST_CELL_PX = 90;
/** Анизотропия пыли по осям: вдоль `x` вчетверо реже, отсюда полосы. */
const DUST_ANISOTROPY = 4;

/* ------------------------------------------------------- глубина и стилевой долг */

/**
 * Гашение туманности на глубине (§17.15.5): при `edgeDist ≤ 1` облако и пыль
 * погашены полностью, при `edgeDist ≥ 4` поле обычное. Между ними — `smoothstep`,
 * то есть гашение монотонное, без ступеньки на границе уровня.
 */
const LOCAL_FADE_FROM = 1;
const LOCAL_FADE_TO = 4;
/**
 * Мягкий фон глубокого пресета: плотность фона не выше `0,02` (требование
 * §17.15.5 п. 3), поэтому берём `0,012` — заметно как градиент, но не как облако.
 */
const LOCAL_BACKGROUND_DENSITY = 0.012;
/**
 * Тонкие нити — три октавы `f, 2f, 4f` с весами `1 / 0,5 / 0,25` (§17.14,
 * стилевой долг `SW-2A-style`). Одиночная октава value-noise давала «отпечаток
 * пальца»: множества уровня одной октавы — вложенные кольца вокруг узлов решётки.
 * Веса берутся как есть, без деления на их сумму (`1,75`): иначе среднее нити
 * падает почти втрое и деталь на `L4/L9` проседает ниже нормы `V-2`.
 */
const RIDGE_FINE_WEIGHTS: readonly number[] = Object.freeze([1, 0.5, 0.25]);
/** Амплитуда нитей: вдвое ниже прежней — три октавы в сумме дают больше плотности. */
const THREAD_AMPLITUDE = 0.5;
/** Пыль из двух октав: полосы перестают быть одинаково «гладкими» вдоль края. */
const DUST_OCTAVE_WEIGHTS: readonly number[] = Object.freeze([0.72, 0.28]);

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

/**
 * Заворот индекса решётки по модулю числа ячеек карты (§17.15.6 п. 1).
 * Решётка становится кольцом: `field(x, y) === field(x ± mapSize, y ± mapSize)`.
 * Заворот делается на **целых** индексах, а не на координатах: `mod` по float
 * сдвигал бы узлы и рвал интерполяцию на самом стыке.
 */
function wrapIndex(index: number, period: number): number {
  if (!(period > 0)) return index;
  // Быстрый путь: почти все индексы уже лежат в одном периоде — `%` не нужен.
  if (index >= 0 && index < period) return index;
  const wrapped = index % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

/**
 * Value-noise с билинейной интерполяцией; вход — в ячейках решётки.
 * `periodX`/`periodY` — число ячеек на карту по каждой оси: индексы решётки
 * заворачиваются по модулю этих чисел, поэтому поле периодично по карте.
 */
function valueNoise(px: number, py: number, seed: number, periodX: number, periodY: number): number {
  const baseX = Math.floor(px);
  const baseY = Math.floor(py);
  const wx = smoothCurve(px - baseX);
  const wy = smoothCurve(py - baseY);
  const ix0 = wrapIndex(baseX, periodX);
  const iy0 = wrapIndex(baseY, periodY);
  const ix1 = ix0 + 1 >= periodX ? ix0 + 1 - periodX : ix0 + 1;
  const iy1 = iy0 + 1 >= periodY ? iy0 + 1 - periodY : iy0 + 1;
  const v00 = latticeValue(ix0, iy0, seed);
  const v10 = latticeValue(ix1, iy0, seed);
  const v01 = latticeValue(ix0, iy1, seed);
  const v11 = latticeValue(ix1, iy1, seed);
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
const SCREEN_PIXEL_BUDGET_NATIVE = 30000;
const SCREEN_PIXEL_BUDGET_FALLBACK = 5000;
const SCREEN_MIN_DIVISOR = 3;

/**
 * Делитель экранного буфера: не меньше `3` и не больше, чем нужно для бюджета.
 * Бюджет зависит от того, кто растягивает картинку: холст (`drawImage` на GPU,
 * почти бесплатно) или JS-фолбэк (≈ 12 мс на мегапиксель кадра), поэтому
 * в окружении без `document` буфер заметно мельче — этот путь живёт только
 * в Node (тесты, предпросмотр), в браузере растягивает холст.
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
  /**
   * Мировой центр кадра, приведённый по модулю `mapSize`. Поле периодично по
   * карте (§17.15.6 п. 1), поэтому кадр от этого не меняется, зато все координаты
   * остаются в пределах одной карты: и заворот решётки, и `float32` в шейдере
   * работают на малых числах (`R-3`).
   */
  readonly originX: number;
  readonly originY: number;
  /** Пикселей буфера на мировую единицу. */
  readonly deviceScale: number;
  readonly mapSize: number;
  readonly octaveWeights: readonly number[];
  readonly octaveNormalizer: number;
  /** Индекс мелкой активной октавы (нижняя граница облачного fBm). */
  readonly octavePeak: number;
  /** Амплитуда домен-варпа в долях нормированного поля. */
  readonly warpAmp: number;
  /**
   * Частоты слоёв в **целых ячейках на карту** — по паре на ось. Целочисленность
   * обязательна: только тогда заворот решётки по модулю даёт бесшовный стык.
   * Анизотропия выражается отношением частот по осям, а не делением координаты.
   */
  readonly octaveCellsY: readonly number[];
  readonly octaveCellsCloudX: readonly number[];
  readonly octaveCellsFineX: readonly number[];
  readonly ridgeMidX: number;
  readonly ridgeMidY: number;
  /** Базовая частота тонкой нити: октавы `f, 2f, 4f` считаются от неё. */
  readonly ridgeFineX: number;
  readonly ridgeFineY: number;
  readonly envelopeCells: number;
  readonly detailWarpCells: number;
  readonly detailWarpAmp: number;
  /** Усиление нитей с зумом: на глубоких уровнях кадр обрастает волокнами. */
  readonly threadGain: number;
  readonly dustX: number;
  readonly dustY: number;
  /** Ячейка звёздной пыли в мировых единицах и их число на карту (целое). */
  readonly starCell: number;
  readonly starCells: number;
  /** Пылевые полосы живут на `L0…L6` (§8.1) и плавно гаснут до `L9`. */
  readonly dustFade: number;
  /**
   * Гашение туманности на глубине (§17.15.5): `0` — облако и пыль погашены
   * полностью (в кадре звезда и мягкий фон), `1` — обычное поле.
   */
  readonly localFade: number;
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

/**
 * Приведение мировой координаты к одной карте. Соседний сектор отличается от
 * текущего ровно на `mapSize`, и поле периодично, поэтому кадр можно считать
 * от свёрнутого центра — картинка та же, числа меньше.
 */
function reduceToMap(value: number, mapSize: number): number {
  if (!Number.isFinite(value)) return 0;
  const wrapped = value - Math.floor(value / mapSize) * mapSize;
  if (!Number.isFinite(wrapped) || wrapped >= mapSize || wrapped < 0) return 0;
  return wrapped;
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

/** Целое число ячеек на карту: заворот решётки возможен только по целому. */
function cellsPerMap(frequency: number): number {
  return Math.max(1, Math.round(frequency));
}

/** Пара частот по осям: анизотропия задаётся отношением, обе частоты целые. */
function cellsForLayer(frequency: number, anisotropy: number): [number, number] {
  return [cellsPerMap(frequency / anisotropy), cellsPerMap(frequency)];
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

  const octaveCellsY: number[] = [];
  const octaveCellsCloudX: number[] = [];
  const octaveCellsFineX: number[] = [];
  for (let index = 0; index < MAX_OCTAVES; index++) {
    const frequency = OCTAVE_BASE_FREQ * 2 ** index;
    octaveCellsY.push(cellsPerMap(frequency));
    octaveCellsCloudX.push(cellsPerMap(frequency / CLOUD_ANISOTROPY));
    octaveCellsFineX.push(cellsPerMap(frequency / THREAD_ANISOTROPY));
  }

  const ridgeMid = cellsForLayer(OCTAVE_BASE_FREQ * 2 ** (octaves.cloudPeak - 1), CLOUD_ANISOTROPY);
  const ridgeFine = cellsForLayer(cellFreq(THREAD_CELL_PX), THREAD_ANISOTROPY);
  const dustCells = cellsForLayer(cellFreq(DUST_CELL_PX), DUST_ANISOTROPY);
  const detailWarpCells = cellsPerMap(cellFreq(DETAIL_WARP_CELL_PX));
  const starCellRaw = STAR_CELL_PX / deviceScale;
  const starCells = cellsPerMap(mapSize / starCellRaw);
  const edgeDist = state.edgeDist;
  const localFade = typeof edgeDist === 'number' && Number.isFinite(edgeDist)
    ? smoothstep(LOCAL_FADE_FROM, LOCAL_FADE_TO, edgeDist)
    : 1;

  return {
    width,
    height,
    originX: reduceToMap(centreX, mapSize),
    originY: reduceToMap(centreY, mapSize),
    deviceScale,
    mapSize,
    octaveWeights: Array.from(octaves.weights),
    octaveNormalizer: octaves.normalizer,
    octavePeak: octaves.cloudPeak,
    // Варп двигает точку на несколько ячеек облачной октавы.
    warpAmp: WARP_CELLS / OCTAVE_BASE_FREQ / 2 ** octaves.cloudPeak,
    octaveCellsY,
    octaveCellsCloudX,
    octaveCellsFineX,
    ridgeMidX: ridgeMid[0],
    ridgeMidY: ridgeMid[1],
    ridgeFineX: ridgeFine[0],
    ridgeFineY: ridgeFine[1],
    envelopeCells: cellsPerMap(ENVELOPE_FREQ),
    detailWarpCells,
    detailWarpAmp: DETAIL_WARP_CELLS / detailWarpCells,
    threadGain: THREAD_GAIN_SHALLOW
      + (THREAD_GAIN_DEEP - THREAD_GAIN_SHALLOW) * smoothstep(THREAD_ZOOM_FROM, THREAD_ZOOM_TO, zoom),
    dustX: dustCells[0],
    dustY: dustCells[1],
    starCell: mapSize / starCells,
    starCells,
    dustFade: 1 - smoothstep(40, 150, zoom),
    localFade,
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

/** Одна активная октава облака с уже разрешёнными частотами и seed. */
interface OctaveLayer {
  readonly cellsX: number;
  readonly cellsY: number;
  readonly seed: number;
  readonly amplitude: number;
  /** Облачные координаты (`true`) или детальные, с мелким варпом (`false`). */
  readonly coarse: boolean;
}

/**
 * Предвычисленные параметры прохода. Всё, что не зависит от пикселя, считается
 * один раз: на кадр 1920×1080 это два миллиона вызовов `computeDensity`, и любая
 * работа с массивами внутри стоила дороже самого шума.
 */
interface CpuPass {
  readonly frame: FrameMath;
  readonly ramp: ColorRamp;
  readonly tuning: FieldTuning;
  /** Индекс пиковой (самой мелкой активной) октавы — для шума октав. */
  readonly peak: number;
  /** Буфер цвета текущего пикселя; переиспользуется, чтобы не аллоцировать на пиксель. */
  readonly out: Float64Array;
  readonly octaveLayers: readonly OctaveLayer[];
  readonly warpCellsBig: readonly [number, number];
  readonly warpCellsSmall: readonly [number, number];
  readonly warpCellsDetail: readonly [number, number];
  readonly warpBigX: number;
  readonly warpBigY: number;
  readonly warpSmallX: number;
  readonly warpSmallY: number;
  readonly detailWarpX: number;
  readonly detailWarpY: number;
  readonly ridgeMidSeed: number;
  readonly ridgeFineSeeds: readonly number[];
  readonly envelopeSeed: number;
  readonly dust: readonly [number, number, number, number];
  readonly dustSeeds: readonly [number, number];
}

/** Сборка предвычисленных параметров прохода из кадра. */
function buildPass(
  frame: FrameMath,
  ramp: ColorRamp,
  tuning: FieldTuning,
  out: Float64Array,
): CpuPass {
  const layers: OctaveLayer[] = [];
  // Граница полос — целое, чтобы шейдер (`u_cloudPeak`, int) и CPU брали одну
  // и ту же октаву: `floor` совпадает со сравнением `index <= octavePeak`.
  const peak = Math.floor(frame.octavePeak);
  for (let index = 0; index < frame.octaveWeights.length; index++) {
    const amplitude = frame.octaveWeights[index] ?? 0;
    if (amplitude <= 0) continue;
    const coarse = index <= peak;
    layers.push({
      cellsX: (coarse ? frame.octaveCellsCloudX[index] : frame.octaveCellsFineX[index]) ?? 1,
      cellsY: frame.octaveCellsY[index] ?? 1,
      seed: CHANNEL_SEEDS[CHANNEL_OCTAVE_BASE + (index % 12)] ?? 0,
      amplitude,
      coarse,
    });
  }
  return {
    frame,
    ramp,
    tuning,
    peak,
    out,
    octaveLayers: layers,
    warpCellsBig: [WARP_FREQ_BIG, WARP_FREQ_BIG],
    warpCellsSmall: [WARP_FREQ_SMALL, WARP_FREQ_SMALL],
    warpCellsDetail: [frame.detailWarpCells, frame.detailWarpCells],
    warpBigX: CHANNEL_SEEDS[CHANNEL_WARP_BIG_X] ?? 0,
    warpBigY: CHANNEL_SEEDS[CHANNEL_WARP_BIG_Y] ?? 0,
    warpSmallX: CHANNEL_SEEDS[CHANNEL_WARP_SMALL_X] ?? 0,
    warpSmallY: CHANNEL_SEEDS[CHANNEL_WARP_SMALL_Y] ?? 0,
    detailWarpX: CHANNEL_SEEDS[CHANNEL_DETAIL_WARP_X] ?? 0,
    detailWarpY: CHANNEL_SEEDS[CHANNEL_DETAIL_WARP_Y] ?? 0,
    ridgeMidSeed: CHANNEL_SEEDS[CHANNEL_RIDGE_MID] ?? 0,
    ridgeFineSeeds: [
      CHANNEL_SEEDS[CHANNEL_RIDGE_FINE] ?? 0,
      CHANNEL_SEEDS[CHANNEL_RIDGE_FINE_2] ?? 0,
      CHANNEL_SEEDS[CHANNEL_RIDGE_FINE_3] ?? 0,
    ],
    envelopeSeed: CHANNEL_SEEDS[CHANNEL_ENVELOPE] ?? 0,
    dust: [frame.dustX, frame.dustY, frame.dustX * 2, frame.dustY * 2],
    dustSeeds: [CHANNEL_SEEDS[CHANNEL_DUST] ?? 0, CHANNEL_SEEDS[CHANNEL_DUST_2] ?? 0],
  };
}

/**
 * Плотность поля в точке мира. Порядок операций совпадает с фрагментным
 * шейдером, чтобы обе ветки давали одну композицию.
 *
 * Все координаты шума нормированы на карту (`point ∈ [0, 1]`) и умножены на
 * **целые** частоты; решётка каждого слоя завёрнута по модулю своей частоты,
 * поэтому поле периодично по карте (§17.15.6 п. 1) — стык секторов невидим.
 */
function computeDensity(pass: CpuPass, worldX: number, worldY: number): number {
  const { frame, tuning } = pass;
  const nx = worldX / frame.mapSize;
  const ny = worldY / frame.mapSize;
  const warpCellsBig = pass.warpCellsBig;
  const warpCellsSmall = pass.warpCellsSmall;

  // Домен-варп двух частот: крупные изгибы плюс мелкая рябь. Обе частоты целые.
  const warpBigX = valueNoise(
    nx * warpCellsBig[0], ny * warpCellsBig[1], pass.warpBigX, warpCellsBig[0], warpCellsBig[1],
  ) - 0.5;
  const warpBigY = valueNoise(
    nx * warpCellsBig[0], ny * warpCellsBig[1], pass.warpBigY, warpCellsBig[0], warpCellsBig[1],
  ) - 0.5;
  const warpSmallX = valueNoise(
    nx * warpCellsSmall[0], ny * warpCellsSmall[1], pass.warpSmallX, warpCellsSmall[0], warpCellsSmall[1],
  ) - 0.5;
  const warpSmallY = valueNoise(
    nx * warpCellsSmall[0], ny * warpCellsSmall[1], pass.warpSmallY, warpCellsSmall[0], warpCellsSmall[1],
  ) - 0.5;
  const shiftedX = nx + (warpBigX + 0.6 * warpSmallX) * frame.warpAmp;
  const shiftedY = ny + (warpBigY + 0.6 * warpSmallY) * frame.warpAmp;

  // Мелкий варп: размывает выравнивание мелких октав по осям решётки.
  const warpCellsDetail = pass.warpCellsDetail;
  const detailWarpX = (valueNoise(
    nx * warpCellsDetail[0], ny * warpCellsDetail[1], pass.detailWarpX,
    warpCellsDetail[0], warpCellsDetail[1],
  ) - 0.5) * frame.detailWarpAmp;
  const detailWarpY = (valueNoise(
    nx * warpCellsDetail[0], ny * warpCellsDetail[1], pass.detailWarpY,
    warpCellsDetail[0], warpCellsDetail[1],
  ) - 0.5) * frame.detailWarpAmp;
  const fineX = shiftedX + detailWarpX;
  const fineY = shiftedY + detailWarpY;

  // Облако: fBm по облачному и детальному окнам октав. Анизотропия — отношение
  // частот по осям (у облака `1,45`, у нитей `2`), обе частоты целые.
  let sum = 0;
  const layers = pass.octaveLayers;
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]!;
    sum += layer.amplitude * valueNoise(
      (layer.coarse ? shiftedX : fineX) * layer.cellsX,
      (layer.coarse ? shiftedY : fineY) * layer.cellsY,
      layer.seed,
      layer.cellsX,
      layer.cellsY,
    );
  }
  const base = sum / frame.octaveNormalizer;

  // Гребневые слои: средний филамент модулирует плотность облака, тонкая нить
  // добавляется только внутри плотных участков (иначе кадр «сереет» от соли).
  const ridgeMid = ridged(valueNoise(
    shiftedX * frame.ridgeMidX,
    shiftedY * frame.ridgeMidY,
    pass.ridgeMidSeed,
    frame.ridgeMidX,
    frame.ridgeMidY,
  ));
  const filament = ridgeMid * ridgeMid * (3 - 2 * ridgeMid);

  // Тонкая нить — три октавы `f, 2f, 4f`. Множества уровня суммы октав уже не
  // дают вложенных колец, которые читались как «отпечаток пальца» на `L4/L9`.
  let ridgeFine = 0;
  for (let octave = 0; octave < 3; octave++) {
    const scale = 1 << octave;
    const cellsX = frame.ridgeFineX * scale;
    const cellsY = frame.ridgeFineY * scale;
    ridgeFine += (RIDGE_FINE_WEIGHTS[octave] ?? 0) * ridged(valueNoise(
      fineX * cellsX,
      fineY * cellsY,
      pass.ridgeFineSeeds[octave] ?? 0,
      cellsX,
      cellsY,
    ));
  }

  // Оболочка: крупные пустоты и сгустки поверх всей карты.
  const envelope = valueNoise(
    nx * frame.envelopeCells, ny * frame.envelopeCells,
    pass.envelopeSeed, frame.envelopeCells, frame.envelopeCells,
  );
  const envelopeGain = 0.4 + 1.05 * smoothstep(0.18, 0.82, envelope);

  // Пылевые полосы (§8.1 `field.dust`, анизотропия 1:4), две октавы.
  const dust = pass.dust;
  const dustLow = valueNoise(
    shiftedX * dust[0], shiftedY * dust[1], pass.dustSeeds[0] ?? 0, dust[0], dust[1],
  );
  const dustHigh = valueNoise(
    shiftedX * dust[2], shiftedY * dust[3], pass.dustSeeds[1] ?? 0, dust[2], dust[3],
  );
  const dustValue = DUST_OCTAVE_WEIGHTS[0]! * dustLow + DUST_OCTAVE_WEIGHTS[1]! * dustHigh;
  const dustBand = smoothstep(0.52, 0.88, dustValue) * tuning.dustStrength * frame.dustFade;

  // Контраст облака: сдвиг к середине и S-кривая (только умножения).
  const shaped = clamp01(
    (base - 0.5) * tuning.cloudContrast + 0.5 + tuning.densityBias,
  ) * envelopeGain;
  const cloud = shaped * shaped * (3 - 2 * shaped);

  // Волокна: модуляция облака гребнем плюс тонкие нити внутри плотных участков.
  const weaved = cloud * (1 - tuning.ridgeStrength + tuning.ridgeStrength * filament);
  const fine = ridgeFine * ridgeFine;
  const thread = fine * tuning.fineStrength * THREAD_AMPLITUDE * frame.threadGain
    * weaved * (0.25 + 0.75 * (1 - weaved));

  return clamp01((weaved + thread - dustBand * 0.85) * tuning.densityScale);
}

/**
 * Один пиксель растра. Результат — в `pass.out` (значения в шкале `0…255`).
 *
 * Гашение на глубине применяется здесь, а не в `computeDensity`: нормировка
 * `V-3` считает среднюю плотность облака по кадру и не должна «разгонять»
 * пустой кадр глубокого пресета (§17.15.5 п. 3 — фон не выше `0,02`).
 */
function composePixel(pass: CpuPass, worldX: number, worldY: number): void {
  const { ramp, tuning, out, frame } = pass;
  const fade = frame.localFade;
  const cloud = computeDensity(pass, worldX, worldY) * frame.densityGain * fade;
  // Мягкий градиент фона глубокого пресета: плотность ≤ `LOCAL_BACKGROUND_DENSITY`.
  // Оболочку для него считаем только когда гашение реально включено.
  let background = 0;
  if (fade < 1) {
    const nx = worldX / frame.mapSize;
    const ny = worldY / frame.mapSize;
    const envelope = valueNoise(
      nx * frame.envelopeCells, ny * frame.envelopeCells,
      CHANNEL_SEEDS[CHANNEL_ENVELOPE] ?? 0, frame.envelopeCells, frame.envelopeCells,
    );
    background = (1 - fade) * LOCAL_BACKGROUND_DENSITY * (0.35 + 0.65 * envelope);
  }
  const density = clamp01(cloud + background);

  sampleRampInto(ramp, density, out);
  let r = out[0] ?? 0;
  let g = out[1] ?? 0;
  let b = out[2] ?? 0;

  // Звёздная пыль: power-law яркость, одна звезда на ячейку 3 device-пикселя.
  // Решётка звёзд тоже завёрнута по модулю их числа на карту: иначе звёзды
  // выдавали бы стык секторов даже при периодичном облаке.
  const starX = worldX / frame.starCell;
  const starY = worldY / frame.starCell;
  const cellX = wrapIndex(Math.floor(starX), frame.starCells);
  const cellY = wrapIndex(Math.floor(starY), frame.starCells);
  const insideX = starX - Math.floor(starX);
  const insideY = starY - Math.floor(starY);
  const presence = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_PRESENCE] ?? 0);
  if (presence < tuning.starPresence) {
    const starPosX = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_X] ?? 0);
    const starPosY = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_Y] ?? 0);
    const spread = latticeValue(cellX, cellY, CHANNEL_SEEDS[CHANNEL_STAR_BRIGHTNESS] ?? 0);
    // Показатель степени 4 через умножения: без `pow`, побитово одинаково везде.
    const power = spread * spread * spread * spread;
    const dx = insideX - starPosX;
    const dy = insideY - starPosY;
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
    const worldY = frame.originY + (y - halfHeight) * invDevice;
    for (let column = 0; column < STATS_GRID; column++) {
      const x = ((column + 0.5) / STATS_GRID) * frame.width;
      const worldX = frame.originX + (x - halfWidth) * invDevice;
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
  const probe = buildPass(baseFrame, buildRamp(palette), FIELD_TUNING[palette.id], new Float64Array(3));
  const frame: FrameMath = { ...baseFrame, densityGain: frameDensityGain(probe) };
  const pass = buildPass(frame, probe.ramp, probe.tuning, probe.out);
  const { width, height, originX, originY, deviceScale } = frame;
  const data = new Uint8ClampedArray(width * height * 4);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const ditherSeed = CHANNEL_SEEDS[CHANNEL_DITHER] ?? 0;
  const invDevice = 1 / deviceScale;

  for (let y = 0; y < height; y++) {
    const worldY = originY + (y + 0.5 - halfHeight) * invDevice;
    let offset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const worldX = originX + (x + 0.5 - halfWidth) * invDevice;
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
  const octaveCellsY = Array.from(
    { length: MAX_OCTAVES },
    (_unused, index) => cellsPerMap(OCTAVE_BASE_FREQ * 2 ** index),
  );
  const octaveCellsCloudX = Array.from(
    { length: MAX_OCTAVES },
    (_unused, index) => cellsPerMap((OCTAVE_BASE_FREQ * 2 ** index) / CLOUD_ANISOTROPY),
  );
  const octaveCellsFineX = Array.from(
    { length: MAX_OCTAVES },
    (_unused, index) => cellsPerMap((OCTAVE_BASE_FREQ * 2 ** index) / THREAD_ANISOTROPY),
  );
  const ramp = buildRamp(palette);
  const stops = ramp.stops.map((stop) => stop.toFixed(6));

  return `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_resolution;    // размер растра в device-пикселях
uniform vec2 u_offsetHi;      // старшая часть центра кадра, свёрнутого по карте
uniform vec2 u_offsetLo;      // младшая часть того же центра
uniform float u_deviceScale;  // device-пикселей на мировую единицу
uniform float u_mapSize;
uniform float u_starCell;     // ячейка звёздной пыли в мировых единицах
uniform float u_dustFade;     // затухание пылевых полос на глубоких уровнях
uniform float u_warpAmp;      // амплитуда домен-варпа (в долях поля)
uniform int u_envelopeCells;
uniform int u_detailWarpCells;
uniform float u_detailWarpAmp;
uniform ivec2 u_dustCells;
uniform float u_densityGain;
uniform float u_threadGain;
uniform ivec2 u_ridgeMidCells;
uniform ivec2 u_ridgeFineCells;
uniform int u_starCells;
uniform float u_localFade;
uniform float u_octaveWeight[${MAX_OCTAVES}];
uniform float u_octaveNormalizer;
uniform int u_cloudPeak;
uniform uint u_seed;

out vec4 fragColor;

// Частоты слоёв — целое число ячеек на карту. Обе таблицы собраны из тех же
// констант, что CPU-путь: заворот решётки возможен только по целому модулю.
const int OCTAVE_CELLS_Y[${MAX_OCTAVES}] = int[${MAX_OCTAVES}](${octaveCellsY.join(', ')});
const int OCTAVE_CELLS_CLOUD_X[${MAX_OCTAVES}] = int[${MAX_OCTAVES}](${octaveCellsCloudX.join(', ')});
const int OCTAVE_CELLS_FINE_X[${MAX_OCTAVES}] = int[${MAX_OCTAVES}](${octaveCellsFineX.join(', ')});
const int WARP_CELLS_BIG = ${WARP_FREQ_BIG};
const int WARP_CELLS_SMALL = ${WARP_FREQ_SMALL};
const float CLOUD_CONTRAST = ${tuning.cloudContrast.toFixed(6)};
const float DENSITY_BIAS = ${tuning.densityBias.toFixed(6)};
const float DENSITY_SCALE = ${tuning.densityScale.toFixed(6)};
const float RIDGE_STRENGTH = ${tuning.ridgeStrength.toFixed(6)};
const float FINE_STRENGTH = ${tuning.fineStrength.toFixed(6)};
const float DUST_STRENGTH = ${tuning.dustStrength.toFixed(6)};
const float DUST_TINT = ${tuning.dustTint.toFixed(6)};
const float STAR_PRESENCE = ${tuning.starPresence.toFixed(6)};
const float STAR_GAIN = ${tuning.starGain.toFixed(6)};
const float THREAD_AMPLITUDE = ${THREAD_AMPLITUDE.toFixed(6)};
const float LOCAL_BACKGROUND_DENSITY = ${LOCAL_BACKGROUND_DENSITY.toFixed(6)};
const float RIDGE_FINE_WEIGHTS[3] = float[3](${RIDGE_FINE_WEIGHTS.map((w) => w.toFixed(6)).join(', ')});
const uint RIDGE_FINE_CHANNELS[3] = uint[3](${[CHANNEL_RIDGE_FINE, CHANNEL_RIDGE_FINE_2, CHANNEL_RIDGE_FINE_3].join(', ')}u);
const float DUST_WEIGHTS[2] = float[2](${DUST_OCTAVE_WEIGHTS.map((w) => w.toFixed(6)).join(', ')});

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

// Заворот индекса решётки по модулю числа ячеек карты (§17.15.6 п. 1).
// Целые индексы, а не float-координаты: иначе на стыке рвётся интерполяция.
int wrapIndex(int index, int period) {
  int wrapped = index % period;
  return wrapped < 0 ? wrapped + period : wrapped;
}

ivec2 wrapCell(ivec2 cell, ivec2 period) {
  return ivec2(wrapIndex(cell.x, period.x), wrapIndex(cell.y, period.y));
}

// Та же решётка, что latticeValue на CPU: только умножения, сдвиги и xor.
uint latticeHash(ivec2 index, uint channel) {
  uint hash = (uint(index.x) * 0x9e3779b1u) ^ (uint(index.y) * 0x85ebca6bu) ^ (u_seed ^ (channel * 0x2545f491u));
  hash ^= hash >> 15u;
  hash *= 0x2c1b3c6du;
  hash ^= hash >> 13u;
  hash *= 0x297a2d39u;
  hash ^= hash >> 16u;
  return hash;
}

float latticeValue(ivec2 index, uint channel) {
  return float(latticeHash(index, channel)) / 4294967296.0;
}

float valueNoise(vec2 point, uint channel, ivec2 period) {
  vec2 base = floor(point);
  vec2 local = point - base;
  vec2 curve = local * local * (3.0 - 2.0 * local);
  ivec2 cell = wrapCell(ivec2(base), period);
  float v00 = latticeValue(cell, channel);
  float v10 = latticeValue(wrapCell(ivec2(base) + ivec2(1, 0), period), channel);
  float v01 = latticeValue(wrapCell(ivec2(base) + ivec2(0, 1), period), channel);
  float v11 = latticeValue(wrapCell(ivec2(base) + ivec2(1, 1), period), channel);
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

float envelopeAt(vec2 point) {
  return valueNoise(point * float(u_envelopeCells), ${CHANNEL_ENVELOPE}u,
    ivec2(u_envelopeCells, u_envelopeCells));
}

float computeDensity(vec2 point) {
  vec2 warpBig = vec2(
    valueNoise(point * float(WARP_CELLS_BIG), ${CHANNEL_WARP_BIG_X}u, ivec2(WARP_CELLS_BIG)),
    valueNoise(point * float(WARP_CELLS_BIG), ${CHANNEL_WARP_BIG_Y}u, ivec2(WARP_CELLS_BIG))
  ) - 0.5;
  vec2 warpSmall = vec2(
    valueNoise(point * float(WARP_CELLS_SMALL), ${CHANNEL_WARP_SMALL_X}u, ivec2(WARP_CELLS_SMALL)),
    valueNoise(point * float(WARP_CELLS_SMALL), ${CHANNEL_WARP_SMALL_Y}u, ivec2(WARP_CELLS_SMALL))
  ) - 0.5;
  vec2 shifted = point + (warpBig + 0.6 * warpSmall) * u_warpAmp;

  ivec2 detailPeriod = ivec2(u_detailWarpCells, u_detailWarpCells);
  vec2 detailWarp = vec2(
    valueNoise(point * float(u_detailWarpCells), ${CHANNEL_DETAIL_WARP_X}u, detailPeriod),
    valueNoise(point * float(u_detailWarpCells), ${CHANNEL_DETAIL_WARP_Y}u, detailPeriod)
  ) - 0.5;
  vec2 fine = shifted + detailWarp * u_detailWarpAmp;

  float sum = 0.0;
  for (int index = 0; index < ${MAX_OCTAVES}; index++) {
    float amplitude = u_octaveWeight[index];
    if (amplitude <= 0.0) continue;
    bool coarse = index <= u_cloudPeak;
    int cellsY = OCTAVE_CELLS_Y[index];
    int cellsX = coarse ? OCTAVE_CELLS_CLOUD_X[index] : OCTAVE_CELLS_FINE_X[index];
    vec2 coordinate = coarse ? shifted : fine;
    ivec2 period = ivec2(cellsX, cellsY);
    sum += amplitude * valueNoise(vec2(coordinate.x * float(cellsX), coordinate.y * float(cellsY)),
      ${CHANNEL_OCTAVE_BASE}u + uint(index % 12), period);
  }
  float base = sum / u_octaveNormalizer;

  float ridgeMid = ridged(valueNoise(
    vec2(shifted.x * float(u_ridgeMidCells.x), shifted.y * float(u_ridgeMidCells.y)),
    ${CHANNEL_RIDGE_MID}u, u_ridgeMidCells));
  float filament = ridgeMid * ridgeMid * (3.0 - 2.0 * ridgeMid);

  // Тонкая нить — три октавы f, 2f, 4f: сумма октав не даёт вложенных колец.
  float ridgeFine = 0.0;
  for (int octave = 0; octave < 3; octave++) {
    int scale = 1 << octave;
    ivec2 period = u_ridgeFineCells * scale;
    ridgeFine += RIDGE_FINE_WEIGHTS[octave] * ridged(valueNoise(
      vec2(fine.x * float(period.x), fine.y * float(period.y)),
      RIDGE_FINE_CHANNELS[octave], period));
  }

  float envelope = envelopeAt(point);
  float envelopeGain = 0.4 + 1.05 * smoothBand(0.18, 0.82, envelope);

  ivec2 dustPeriod = u_dustCells;
  ivec2 dustPeriodHigh = u_dustCells * 2;
  float dustLow = valueNoise(
    vec2(shifted.x * float(dustPeriod.x), shifted.y * float(dustPeriod.y)),
    ${CHANNEL_DUST}u, dustPeriod);
  float dustHigh = valueNoise(
    vec2(shifted.x * float(dustPeriodHigh.x), shifted.y * float(dustPeriodHigh.y)),
    ${CHANNEL_DUST_2}u, dustPeriodHigh);
  float dust = DUST_WEIGHTS[0] * dustLow + DUST_WEIGHTS[1] * dustHigh;
  float dustBand = smoothBand(0.52, 0.88, dust) * DUST_STRENGTH * u_dustFade;

  float shaped = clamp((base - 0.5) * CLOUD_CONTRAST + 0.5 + DENSITY_BIAS, 0.0, 1.0) * envelopeGain;
  float cloud = shaped * shaped * (3.0 - 2.0 * shaped);

  float weaved = cloud * (1.0 - RIDGE_STRENGTH + RIDGE_STRENGTH * filament);
  float fineMask = ridgeFine * ridgeFine;
  float thread = fineMask * FINE_STRENGTH * THREAD_AMPLITUDE * u_threadGain
    * weaved * (0.25 + 0.75 * (1.0 - weaved));

  return clamp((weaved + thread - dustBand * 0.85) * DENSITY_SCALE, 0.0, 1.0);
}

void main() {
  // Камеро-относительные координаты: из JS приходит только смещение от центра.
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 delta = (frag - 0.5 * u_resolution) / u_deviceScale;
  vec2 world = u_offsetHi + (u_offsetLo + delta);
  vec2 point = world / u_mapSize;

  float cloud = computeDensity(point) * u_densityGain * u_localFade;
  // Мягкий градиент фона глубокого пресета (§17.15.5 п. 1): плотность ≤ 0,02.
  float background = u_localFade < 1.0
    ? (1.0 - u_localFade) * LOCAL_BACKGROUND_DENSITY * (0.35 + 0.65 * envelopeAt(point))
    : 0.0;
  float density = clamp(cloud + background, 0.0, 1.0);
  vec3 color = rampColor(density);

  // Звёздная пыль: power-law яркость, одна звезда на ячейку. Решётка звёзд тоже
  // завёрнута по числу ячеек на карту — иначе звёзды выдают стык секторов.
  vec2 starPoint = world / u_starCell;
  ivec2 starCell = wrapCell(ivec2(floor(starPoint)), ivec2(u_starCells, u_starCells));
  vec2 inside = starPoint - floor(starPoint);
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
  float dither = (latticeValue(ivec2(floor(frag)), ${CHANNEL_DITHER}u) - 0.5) / 255.0;
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
    readonly envelopeCells: WebGLUniformLocation | null;
    readonly detailWarpCells: WebGLUniformLocation | null;
    readonly detailWarpAmp: WebGLUniformLocation | null;
    readonly threadGain: WebGLUniformLocation | null;
    readonly ridgeMidCells: WebGLUniformLocation | null;
    readonly ridgeFineCells: WebGLUniformLocation | null;
    readonly dustCells: WebGLUniformLocation | null;
    readonly starCells: WebGLUniformLocation | null;
    readonly localFade: WebGLUniformLocation | null;
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
      envelopeCells: gl.getUniformLocation(program, 'u_envelopeCells'),
      detailWarpCells: gl.getUniformLocation(program, 'u_detailWarpCells'),
      detailWarpAmp: gl.getUniformLocation(program, 'u_detailWarpAmp'),
      threadGain: gl.getUniformLocation(program, 'u_threadGain'),
      ridgeMidCells: gl.getUniformLocation(program, 'u_ridgeMidCells'),
      ridgeFineCells: gl.getUniformLocation(program, 'u_ridgeFineCells'),
      dustCells: gl.getUniformLocation(program, 'u_dustCells'),
      starCells: gl.getUniformLocation(program, 'u_starCells'),
      localFade: gl.getUniformLocation(program, 'u_localFade'),
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

/**
 * Ключ кэша экранного кадра (§17.5 п. 5): всё, от чего зависит картинка.
 * `edgeDist` — потому что глубина гасит туманность: без неё смена глубины при
 * той же камере вернула бы старый кадр из кэша.
 */
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
    finiteOr(state.edgeDist, -1),
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
    const probe = buildPass(baseFrame, buildRamp(palette), FIELD_TUNING[style], new Float64Array(3));
    const gain = frameDensityGain(probe);
    const glFrame: FrameMath = { ...baseFrame, densityGain: gain };
    const frame = glFrame;
    const { gl, program, uniforms } = current;
    const background = palette.background;

    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;

    // Центр кадра, свёрнутый по карте, разложен на старшую и младшую части
    // (§17.5 п. 1). Свёрнутый — потому что поле периодично: так и координаты
    // остаются в пределах карты, и точность `float32` на `L9` выше (`R-3`).
    const hiX = Math.fround(frame.originX);
    const hiY = Math.fround(frame.originY);
    const loX = frame.originX - hiX;
    const loY = frame.originY - hiY;

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
      gl.uniform1i(uniforms.envelopeCells, frame.envelopeCells);
      gl.uniform1i(uniforms.detailWarpCells, frame.detailWarpCells);
      gl.uniform1f(uniforms.detailWarpAmp, frame.detailWarpAmp);
      gl.uniform1f(uniforms.threadGain, frame.threadGain);
      gl.uniform2i(uniforms.ridgeMidCells, frame.ridgeMidX, frame.ridgeMidY);
      gl.uniform2i(uniforms.ridgeFineCells, frame.ridgeFineX, frame.ridgeFineY);
      gl.uniform2i(uniforms.dustCells, frame.dustX, frame.dustY);
      gl.uniform1i(uniforms.starCells, frame.starCells);
      gl.uniform1f(uniforms.localFade, frame.localFade);
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
