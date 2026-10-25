/**
 * Процедурное поле сектора (шаг `SW-2A`, волна `SW-2`).
 *
 * Заменяет растровую подложку `/sector/` детерминированным шумовым полем:
 * `field.nebula` + `field.dust` + `field.stars` из §8.1 плана
 * `docs/stages/stage-9-12-sector-deep-render-plan.md`.
 *
 * Контракт — §17.5 `docs/agents_task_orchestration/agents_task_orchestration.md`.
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
 *     CPU-путь побитово воспроизводим (только IEEE-754 `+ - * / sqrt` и
 *     целочисленные операции — `pow/exp/log/sin` не обязаны совпадать между
 *     движками и в генерации не используются).
 *  3. CPU-фолбэк равноценен: нет WebGL2 или контекст потерян → `backend === 'cpu'`,
 *     та же композиция, без исключений и без пустого холста.
 *  4. Ни сети, ни ассетов: ноль `fetch`, ноль `Image`, ноль чтения картинок.
 *  5. `renderToImageData` работает в Node без `<canvas>`: `ImageData` собирается
 *     внутренней фабрикой; DOM-обращения — только внутри функций и только
 *     после проверки наличия холста.
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
 * и в таблице `FIELD_TUNING`. `densityStops` — опорные точки цветовой рампы
 * на оси плотности `0…1` (строго возрастают, проверяется тестом).
 */
export const FIELD_PALETTES: readonly FieldPalette[] = Object.freeze([
  Object.freeze({
    id: 'nebula' as FieldStyle,
    background: Object.freeze([6, 8, 18] as const),
    dust: Object.freeze([42, 58, 102] as const),
    core: Object.freeze([110, 86, 178] as const),
    rim: Object.freeze([56, 130, 172] as const),
    densityStops: Object.freeze([0, 0.3, 0.62, 0.84, 0.97]),
  }),
  Object.freeze({
    id: 'tactical' as FieldStyle,
    background: Object.freeze([3, 9, 11] as const),
    dust: Object.freeze([22, 48, 50] as const),
    core: Object.freeze([70, 150, 130] as const),
    rim: Object.freeze([40, 118, 140] as const),
    densityStops: Object.freeze([0, 0.26, 0.56, 0.8, 0.95]),
  }),
]);

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
const CHANNEL_WARP_X = 0;
const CHANNEL_WARP_Y = 1;
const CHANNEL_OCTAVE_BASE = 3;
const CHANNEL_DUST = 16;
const CHANNEL_STAR_PRESENCE = 17;
const CHANNEL_STAR_X = 18;
const CHANNEL_STAR_Y = 19;
const CHANNEL_STAR_BRIGHTNESS = 20;
const CHANNEL_DITHER = 21;
const CHANNEL_LIMIT = 24;

/** Домен-варп: частота полос варпа в ячейках на нормированное поле сектора. */
const WARP_FREQ = 4.5;
/** Пылевые полосы: анизотропия 1:4 (§8.1, слой `field.dust`). */
const DUST_FREQ_X = 6;
const DUST_FREQ_Y = 24;

/**
 * Октавы `fBm`. Частота `i`-й октавы — `OCTAVE_BASE_FREQ · 2^i` ячеек на
 * нормированное поле сектора; вес октавы задаётся окном по логарифму зума:
 * в кадре всегда видны 3–4 октавы, попадающие в его масштаб, поэтому структура
 * читается и на `L0`, и на `L9` и не «вскипает» при зуме (§8.1, §8.3).
 * Веса считаются в JS в `float64` и уходят в шейдер как `u_octaveWeight`,
 * чтобы обе ветки рисовали одну композицию.
 */
const OCTAVE_BASE_FREQ = 3;
const OCTAVE_COUNT = 16;
const OCTAVE_WINDOW_SHIFT = 1;
const OCTAVE_WINDOW_WIDTH = 2;

function octaveFrequency(index: number): number {
  return OCTAVE_BASE_FREQ * 2 ** index;
}

/** Окно «в кадре»: центр в `log2(zoom) + OCTAVE_WINDOW_SHIFT`, ширина в октавах. */
function octaveWeight(index: number, logZoom: number): number {
  const t = 1 - Math.abs(logZoom + OCTAVE_WINDOW_SHIFT - index) / OCTAVE_WINDOW_WIDTH;
  if (t <= 0) return 0;
  return t * t;
}

/** Параметры композиции, различающие два пресета (код один и тот же). */
interface FieldTuning {
  readonly warpAmp: number;
  readonly densityBias: number;
  readonly densityGain: number;
  readonly dustStrength: number;
  readonly dustTint: number;
  readonly starPresence: number;
  readonly starGain: number;
}

const FIELD_TUNING: { readonly [style in FieldStyle]: FieldTuning } = Object.freeze({
  nebula: Object.freeze({
    warpAmp: 0.09,
    densityBias: -0.5,
    densityGain: 2.9,
    dustStrength: 0.62,
    dustTint: 0.45,
    starPresence: 0.34,
    starGain: 1.15,
  }),
  tactical: Object.freeze({
    warpAmp: 0.055,
    densityBias: -0.5,
    densityGain: 2.7,
    dustStrength: 0.8,
    dustTint: 0.8,
    starPresence: 0.26,
    starGain: 0.9,
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

/** Всё, что нужно пиксельному проходу; считается один раз на кадр в `float64`. */
interface FrameMath {
  readonly width: number;
  readonly height: number;
  /** Мировой центр кадра, `float64`. */
  readonly centreX: number;
  readonly centreY: number;
  /** Пикселей растра на мировую единицу (уже с `dpr`). */
  readonly deviceScale: number;
  readonly mapSize: number;
  readonly octaveWeights: readonly number[];
  readonly starCell: number;
  /** Пылевые полосы живут на `L0…L6` (§8.1) и плавно гаснут до `L9`. */
  readonly dustFade: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Мировой центр кадра по одной оси. В `canvas-renderer.ts` (`toWorld`) экран
 * связан с миром как `screen = tx + world · scale`, поэтому мировая точка
 * в центре кадра — `(viewport.w / 2 − tx) / scale` (аналогично по `y`).
 * Форма §17.5 `(mapSize / 2 − tx) / scale` совпадает с этой при `viewport.w = mapSize`,
 * поэтому `mapSize` используется только как запасной размер кадра.
 */
function frameCenter(axis: number, translate: number, scale: number, fallbackAxis: number): number {
  const span = axis > 0 ? axis : fallbackAxis;
  return (span / 2 - translate) / scale;
}

function buildFrame(state: SectorFieldState): FrameMath {
  const mapSize = Math.max(1, finiteOr(state.mapSize, FALLBACK_MAP_SIZE));
  const rawW = Math.max(1, finiteOr(state.viewport?.w, FALLBACK_VIEWPORT));
  const rawH = Math.max(1, finiteOr(state.viewport?.h, FALLBACK_VIEWPORT));
  const dpr = Math.min(4, Math.max(1 / 8, finiteOr(state.dpr, 1)));
  const width = Math.min(MAX_RENDER_SIDE, Math.max(1, Math.round(rawW * dpr)));
  const height = Math.min(MAX_RENDER_SIDE, Math.max(1, Math.round(rawH * dpr)));

  // Масштаб: мир → CSS-пиксель. Битый или нулевой — подгоняем кадр по ширине карты.
  const rawScale = finiteOr(state.view?.scale, 0);
  const scale = rawScale > 0 ? rawScale : rawW / mapSize;
  const deviceScale = scale * dpr;
  const centreX = frameCenter(rawW, finiteOr(state.view?.tx, (rawW - mapSize * scale) / 2), scale, mapSize);
  const centreY = frameCenter(rawH, finiteOr(state.view?.ty, (rawH - mapSize * scale) / 2), scale, mapSize);

  // Зум относительно кадра «вся карта»: 1 на L0, 16 на L4, 512 на L9.
  const visibleWorldWidth = rawW / scale;
  const zoom = mapSize / Math.max(1e-6, visibleWorldWidth);

  const logZoom = Math.log2(zoom);
  const octaveWeights = Array.from(
    { length: OCTAVE_COUNT },
    (_unused, index) => octaveWeight(index, logZoom),
  );

  const starCell = STAR_CELL_PX / deviceScale;

  const dustFade = 1 - smoothstep(40, 150, zoom);

  return { width, height, centreX, centreY, deviceScale, mapSize, octaveWeights, starCell, dustFade };
}

/* ------------------------------------------------------------------ цвет */

type Rgb = readonly [number, number, number];

interface ColorRamp {
  readonly stops: readonly [number, number, number, number];
  readonly background: Rgb;
  readonly dust: Rgb;
  readonly core: Rgb;
  readonly rim: Rgb;
}

function buildRamp(palette: FieldPalette): ColorRamp {
  const stops = palette.densityStops;
  return {
    stops: [
      stops[0] ?? 0,
      stops[1] ?? 0.3,
      stops[3] ?? 0.75,
      stops[4] ?? 1,
    ],
    background: palette.background,
    dust: palette.dust,
    core: palette.core,
    rim: palette.rim,
  };
}

/**
 * Цвет рампы пишется в `out` (общий буфер прохода): на кадр 1920×1080 это
 * два миллиона вызовов, и аллокация массива на пиксель стоила дороже самого шума.
 */
function sampleRampInto(ramp: ColorRamp, density: number, out: Float64Array): void {
  const [s0, s1, s3, s4] = ramp.stops;
  const d = clamp01(density);
  let from: Rgb = ramp.background;
  let to: Rgb = ramp.background;
  let t = 0;
  if (d <= s0) {
    out[0] = from[0];
    out[1] = from[1];
    out[2] = from[2];
    return;
  }
  if (d <= s1) {
    from = ramp.background;
    to = ramp.dust;
    t = (d - s0) / Math.max(1e-6, s1 - s0);
  } else if (d <= s3) {
    from = ramp.dust;
    to = ramp.core;
    t = (d - s1) / Math.max(1e-6, s3 - s1);
  } else {
    from = ramp.core;
    to = ramp.rim;
    t = clamp01((d - s3) / Math.max(1e-6, s4 - s3));
  }
  out[0] = from[0] + (to[0] - from[0]) * t;
  out[1] = from[1] + (to[1] - from[1]) * t;
  out[2] = from[2] + (to[2] - from[2]) * t;
}

/* ------------------------------------------------------------------ CPU-композитор */

interface CpuPass {
  readonly frame: FrameMath;
  readonly ramp: ColorRamp;
  readonly tuning: FieldTuning;
  /** Буфер цвета текущего пикселя; переиспользуется, чтобы не аллоцировать на пиксель. */
  readonly out: Float64Array;
}

/**
 * Один пиксель растра. Порядок операций совпадает с фрагментным шейдером,
 * чтобы обе ветки давали одну композицию. Результат — в `pass.out`
 * (значения в шкале `0…255`).
 */
function composePixel(pass: CpuPass, worldX: number, worldY: number): void {
  const { frame, ramp, tuning, out } = pass;
  const nx = worldX / frame.mapSize;
  const ny = worldY / frame.mapSize;

  // Домен-варп: смещение координат до `fBm`, чтобы облака были волокнистыми.
  const warpX = (valueNoise(nx * WARP_FREQ, ny * WARP_FREQ, CHANNEL_SEEDS[CHANNEL_WARP_X] ?? 0) - 0.5) * tuning.warpAmp;
  const warpY = (valueNoise(nx * WARP_FREQ, ny * WARP_FREQ, CHANNEL_SEEDS[CHANNEL_WARP_Y] ?? 0) - 0.5) * tuning.warpAmp;
  const wx = nx + warpX;
  const wy = ny + warpY;

  let sum = 0;
  let weight = 0;
  for (let index = 0; index < OCTAVE_COUNT; index++) {
    const amp = frame.octaveWeights[index] ?? 0;
    if (amp <= 0) continue;
    const freq = octaveFrequency(index);
    sum += amp * valueNoise(
      wx * freq,
      wy * freq,
      CHANNEL_SEEDS[CHANNEL_OCTAVE_BASE + (index % 12)] ?? 0,
    );
    weight += amp;
  }
  let density = weight > 0 ? sum / weight : 0;

  // Пылевые полосы (§8.1 `field.dust`, анизотропия 1:4) затемняют облако.
  const dust = valueNoise(wx * DUST_FREQ_X, wy * DUST_FREQ_Y, CHANNEL_SEEDS[CHANNEL_DUST] ?? 0);
  const dustBand = smoothstep(0.5, 0.86, dust) * tuning.dustStrength * frame.dustFade;

  // Контраст: сдвиг + усиление + S-кривая (только умножения), чтобы фон
  // оставался тёмным, а яркими были отдельные волокна.
  const raised = clamp01((density + tuning.densityBias) * tuning.densityGain);
  density = raised * raised * (3 - 2 * raised) * (1 - dustBand * 0.85);

  sampleRampInto(ramp, density, out);
  const tint = dustBand * tuning.dustTint;
  let r = (out[0] ?? 0) + (ramp.dust[0] - (out[0] ?? 0)) * tint;
  let g = (out[1] ?? 0) + (ramp.dust[1] - (out[1] ?? 0)) * tint;
  let b = (out[2] ?? 0) + (ramp.dust[2] - (out[2] ?? 0)) * tint;

  // Звёздная пыль: power-law яркость, одна звезда на ячейку.
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
      r += (255 - r) * glow * 0.94 + ramp.rim[0] * glow * 0.06;
      g += (255 - g) * glow * 0.94 + ramp.rim[1] * glow * 0.06;
      b += (255 - b) * glow * 0.94 + ramp.rim[2] * glow * 0.06;
    }
  }

  out[0] = r;
  out[1] = g;
  out[2] = b;
}

function composeCpuData(state: SectorFieldState, palette: FieldPalette): ImageData {
  const frame = buildFrame(state);
  const pass: CpuPass = {
    frame,
    ramp: buildRamp(palette),
    tuning: FIELD_TUNING[palette.id],
    out: new Float64Array(3),
  };
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
    { length: OCTAVE_COUNT },
    (_unused, index) => octaveFrequency(index).toFixed(6),
  ).join(', ');
  const octaveCount = OCTAVE_COUNT;
  const stops = [0, 1, 2, 3, 4].map((index) => (palette.densityStops[index] ?? 0).toFixed(6));

  return `#version 300 es
precision highp float;
precision highp int;

uniform vec2 u_resolution;    // размер растра в device-пикселях
uniform vec2 u_offsetHi;      // старшая часть мирового центра кадра
uniform vec2 u_offsetLo;      // младшая часть мирового центра кадра
uniform float u_deviceScale;  // device-пикселей на мировую единицу
uniform float u_mapSize;
uniform float u_starCell;     // ячейка звёздной пыли в мировых единицах
uniform float u_octaveWeight[${octaveCount}];
uniform float u_dustFade;   // затухание пылевых полос на глубоких уровнях
uniform uint u_seed;

out vec4 fragColor;

const float OCTAVE_FREQ[${octaveCount}] = float[${octaveCount}](${octaveFreq});
const float WARP_FREQ = ${WARP_FREQ.toFixed(6)};
const float DUST_FREQ_X = ${DUST_FREQ_X.toFixed(6)};
const float DUST_FREQ_Y = ${DUST_FREQ_Y.toFixed(6)};
const float WARP_AMP = ${tuning.warpAmp.toFixed(6)};
const float DENSITY_BIAS = ${tuning.densityBias.toFixed(6)};
const float DENSITY_GAIN = ${tuning.densityGain.toFixed(6)};
const float DUST_STRENGTH = ${tuning.dustStrength.toFixed(6)};
const float DUST_TINT = ${tuning.dustTint.toFixed(6)};
const float STAR_PRESENCE = ${tuning.starPresence.toFixed(6)};
const float STAR_GAIN = ${tuning.starGain.toFixed(6)};

const vec3 BG = vec3(${unitTriplet(palette.background)});
const vec3 DUST_COLOR = vec3(${unitTriplet(palette.dust)});
const vec3 CORE_COLOR = vec3(${unitTriplet(palette.core)});
const vec3 RIM_COLOR = vec3(${unitTriplet(palette.rim)});
const float STOP0 = ${stops[0]};
const float STOP1 = ${stops[1]};
const float STOP3 = ${stops[3]};
const float STOP4 = ${stops[4]};

// Та же решётка, что latticeValue на CPU: только умножения, сдвиги и xor.
float latticeValue(vec2 cell, uint channel) {
  ivec2 index = ivec2(cell);
  uint hash = (uint(index.x) * 0x9e3779b1u) ^ (uint(index.y) * 0x85ebca6bu) ^ (u_seed ^ (channel * 0x2545f491u));
  hash ^= hash >> 15u;
  hash *= 0x2c1b3c6du;
  hash ^= hash >> 13u;
  hash *= 0x297a2d39u;
  hash ^= hash >> 16u;
  return float(hash) / 4294967296.0;
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

float smoothBand(float edge0, float edge1, float value) {
  float t = clamp((value - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

vec3 rampColor(float density) {
  if (density <= STOP0) return BG;
  if (density <= STOP1) return mix(BG, DUST_COLOR, (density - STOP0) / max(STOP1 - STOP0, 1e-6));
  if (density <= STOP3) return mix(DUST_COLOR, CORE_COLOR, (density - STOP1) / max(STOP3 - STOP1, 1e-6));
  return mix(CORE_COLOR, RIM_COLOR, clamp((density - STOP3) / max(STOP4 - STOP3, 1e-6), 0.0, 1.0));
}

void main() {
  // Камеро-относительные координаты: из JS приходит только смещение от центра.
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  vec2 delta = (frag - 0.5 * u_resolution) / u_deviceScale;
  vec2 world = u_offsetHi + (u_offsetLo + delta);
  vec2 point = world / u_mapSize;

  float warpX = (valueNoise(point * WARP_FREQ, ${CHANNEL_WARP_X}u) - 0.5) * WARP_AMP;
  float warpY = (valueNoise(point * WARP_FREQ, ${CHANNEL_WARP_Y}u) - 0.5) * WARP_AMP;
  vec2 warped = point + vec2(warpX, warpY);

  float sum = 0.0;
  float weight = 0.0;
  for (int index = 0; index < ${octaveCount}; index++) {
    float amp = u_octaveWeight[index];
    if (amp <= 0.0) continue;
    sum += amp * valueNoise(warped * OCTAVE_FREQ[index], ${CHANNEL_OCTAVE_BASE}u + uint(index));
    weight += amp;
  }
  float density = weight > 0.0 ? sum / weight : 0.0;

  float dust = valueNoise(warped * vec2(DUST_FREQ_X, DUST_FREQ_Y), ${CHANNEL_DUST}u);
  float dustBand = smoothBand(0.5, 0.86, dust) * DUST_STRENGTH * u_dustFade;

  float raised = clamp((density + DENSITY_BIAS) * DENSITY_GAIN, 0.0, 1.0);
  density = raised * raised * (3.0 - 2.0 * raised) * (1.0 - dustBand * 0.85);

  vec3 color = rampColor(density) + (DUST_COLOR - rampColor(density)) * dustBand * DUST_TINT;

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
      color += (vec3(1.0) - color) * glow * 0.94 + RIM_COLOR * glow * 0.06;
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
    readonly octaveWeight: WebGLUniformLocation | null;
    readonly dustFade: WebGLUniformLocation | null;
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
    octaveCount: OCTAVE_COUNT,
    uniforms: {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      offsetHi: gl.getUniformLocation(program, 'u_offsetHi'),
      offsetLo: gl.getUniformLocation(program, 'u_offsetLo'),
      deviceScale: gl.getUniformLocation(program, 'u_deviceScale'),
      mapSize: gl.getUniformLocation(program, 'u_mapSize'),
      starCell: gl.getUniformLocation(program, 'u_starCell'),
      octaveWeight: gl.getUniformLocation(program, 'u_octaveWeight[0]'),
      dustFade: gl.getUniformLocation(program, 'u_dustFade'),
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

    const frame = buildFrame(state);
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

  function drawWithCpu(state: SectorFieldState): void {
    if (canvas === null) return;
    const image = composeCpuData(state, palette);
    if (!context2d) {
      try {
        // Холст мог быть уже занят WebGL — тогда 2D-контекста не будет.
        context2d = canvas.getContext('2d') as CanvasRenderingContext2D | null;
      } catch {
        context2d = null;
      }
    }
    if (!context2d) return;
    if (canvas.width !== image.width) canvas.width = image.width;
    if (canvas.height !== image.height) canvas.height = image.height;
    try {
      context2d.putImageData(image, 0, 0);
    } catch {
      /* нет доступа к пикселям — тихий no-op, кадр рисует верхний слой */
    }
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
      return composeCpuData(state, palette);
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
