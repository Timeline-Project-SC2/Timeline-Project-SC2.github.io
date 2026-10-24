/* PlanetElevationField — единое поле высот планеты (Stage-8.14, шаг 2).
   Планетарный гекс и гекс стратегической карты — одно и то же поле,
   разной детализации; сид задаёт всё, береговая линия и высоты сквозные.

   Реплицирует рецепт высоты PlanetGeography (c100-soft-v1) — базовый fBm,
   пластины и деталь с теми же семенами/смещениями/весами — и делает его
   полосовым: число октав обрезается шагом выборки stepM (частота выше
   Найквиста не считается). При тонком шаге и без дополнительных октав
   результат совпадает с PlanetGeography.sampleFields (extraOctaves = 0)
   в пределах округления Float32.

   sampleElevation(dir, stepM) — высота в метрахrelative к нулевому уровню
   поля (ноль ≈ береговая линия поля, не квантиль океана планеты).
   sampleElevationBoth(dir, stepM) — то же, раздельно по суше и океану.

   Шумовые генераторы создаются лениво в замыкании модуля (один на сид);
   кеш planet-geography не ломается.
*/

import PlanetGeography from './planet-geography.ts';
import PlanetNoise from './planet-noise.ts';

const EARTH_RADIUS_KM = PlanetGeography.EARTH_RADIUS_KM;
const MASTER_SEED_HEX = '0123456789abcdef';

// 1.0 нормализованной высоты = 40 км рельефа (полный диапазон поля ±40 км).
// Единица выбрана так, чтобы на 5 км площади при extraOctaves = 24 размах
// высот превышал 8 % ширины (>= 400 м) — см. критерий приёма B и отчёт.
const ELEVATION_SCALE_M = 40_000;

const BASE_FREQ = 2.15;
const PLATE_FREQ = 1.12;
const DETAIL_FREQ = 9.0;
const BASE_OCTAVES = 5;
const PLATE_OCTAVES = 3;
const DETAIL_OCTAVES = 3;
const LACUNARITY = 2.0;
const BASE_GAIN = 0.5;
const PLATE_GAIN = 0.52;
const DETAIL_GAIN = 0.55;
const WARP_FREQ = 0.85;
const WARP_AMP_NUM = 0.14;
const WARP_AMP_DEN_MIN = 0.25;

const WEIGHT_BASE = 0.74;
const WEIGHT_PLATE = 0.30;
const WEIGHT_DETAIL = 0.10;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Точное копирование planet-geography.ts:offsetVector (x256 смещения домена).
function offsetVector(seed: number): [number, number, number] {
  const rand = mulberry32(seed);
  return [(rand() * 2 - 1) * 256, (rand() * 2 - 1) * 256, (rand() * 2 - 1) * 256];
}

function unitVector(x: number, y: number, z: number): [number, number, number] {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new Error('PlanetElevationField: направление должно быть ненулевым');
  }
  return [x / len, y / len, z / len];
}

// Длина волны нулевой октавы каждого fBm на поверхности planеты в метрах.
// 2 * pi * R / (freq * R / EARTH_RADIUS_KM) — не зависит от радиуса планеты.
const BASE_LAMBDA0_M = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / BASE_FREQ;
const PLATE_LAMBDA0_M = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / PLATE_FREQ;
const DETAIL_LAMBDA0_M = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / DETAIL_FREQ;

// Число октав, чья длина волны >= 2 * stepM (порог Найквиста). Выше Найквиста
// не считается; никогда не берёт больше октав, чем задано для поля.
function octavesByNyquist(lambda0M: number, fixedOctaves: number, stepM: number): number {
  if (!(stepM > 0)) throw new Error('PlanetElevationField: stepM должен быть > 0');
  let count = 0;
  let lambda = lambda0M;
  const limit = 2 * stepM;
  while (count < fixedOctaves && lambda >= limit) {
    count++;
    lambda /= 2;
  }
  return count;
}

function fbmOctaves(
  noise: (x: number, y: number, z: number) => number,
  x: number, y: number, z: number,
  octaves: number, lacunarity: number, gain: number,
): number {
  if (octaves <= 0) return 0;
  return PlanetNoise.fbm(noise, x, y, z, octaves, lacunarity, gain);
}

interface ElevationNoise {
  elev: (x: number, y: number, z: number) => number;
  plate: (x: number, y: number, z: number) => number;
  detail: (x: number, y: number, z: number) => number;
  warp: (x: number, y: number, z: number) => number;
  offE: [number, number, number];
  offP: [number, number, number];
  offD: [number, number, number];
  offW: [number, number, number];
}

function buildNoise(masterSeedHex: string): ElevationNoise {
  const seedE = PlanetGeography.domainSeed(masterSeedHex, 'elevation');
  const seedP = PlanetGeography.domainSeed(masterSeedHex, 'plates');
  const seedD = PlanetGeography.domainSeed(masterSeedHex, 'detail');
  const seedW = PlanetGeography.domainSeed(masterSeedHex, 'warp');
  return {
    elev: PlanetNoise.makeNoise('simplex', seedE),
    plate: PlanetNoise.makeNoise('simplex', seedP),
    detail: PlanetNoise.makeNoise('simplex', seedD),
    warp: PlanetNoise.makeNoise('simplex', seedW),
    offE: offsetVector(PlanetGeography.domainSeed(masterSeedHex, 'offset:elevation')),
    offP: offsetVector(PlanetGeography.domainSeed(masterSeedHex, 'offset:plates')),
    offD: offsetVector(PlanetGeography.domainSeed(masterSeedHex, 'offset:detail')),
    offW: offsetVector(PlanetGeography.domainSeed(masterSeedHex, 'offset:warp')),
  };
}

const noise = buildNoise(MASTER_SEED_HEX);

export { ELEVATION_SCALE_M };

export interface ElevationBoth {
  /** Высота над нулевым уровнем в этой точке (0 под водой), м. */
  landM: number;
  /** Глубина под нулевым уровнем в этой точке (0 на суше), м. */
  oceanM: number;
}

/** Высота поля в метрах с ограничением октав шагом выборки stepM. */
export function sampleElevation(dir: ArrayLike<number>, stepM: number): number {
  const [nx, ny, nz] = unitVector(dir[0] as number, dir[1] as number, dir[2] as number);
  const ratio = 1; // directions — единичный вектор; длина волны поверхности не зависит от R
  const { elev, plate, detail, warp, offE, offP, offD, offW } = noise;

  // Варп тот же, что в PlanetGeography.sampleFields (касательное смещение по поверхности).
  const warpFreq = WARP_FREQ * ratio;
  const wx = warp(nx * warpFreq + offW[0], ny * warpFreq + offW[1], nz * warpFreq + offW[2]);
  const wy = warp(nx * warpFreq + offW[1], ny * warpFreq + offW[2], nz * warpFreq + offW[0]);
  const wz = warp(nx * warpFreq + offW[2], ny * warpFreq + offW[0], nz * warpFreq + offW[1]);
  const along = wx * nx + wy * ny + wz * nz;
  const warpAmp = WARP_AMP_NUM / Math.max(WARP_AMP_DEN_MIN, ratio);
  let dx = nx + (wx - along * nx) * warpAmp;
  let dy = ny + (wy - along * ny) * warpAmp;
  let dz = nz + (wz - along * nz) * warpAmp;
  const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= dlen;
  dy /= dlen;
  dz /= dlen;

  const baseOctaves = octavesByNyquist(BASE_LAMBDA0_M, BASE_OCTAVES, stepM);
  const plateOctaves = octavesByNyquist(PLATE_LAMBDA0_M, PLATE_OCTAVES, stepM);
  const detailOctaves = octavesByNyquist(DETAIL_LAMBDA0_M, DETAIL_OCTAVES, stepM);

  const base = fbmOctaves(
    elev, dx * BASE_FREQ * ratio + offE[0], dy * BASE_FREQ * ratio + offE[1], dz * BASE_FREQ * ratio + offE[2],
    baseOctaves, LACUNARITY, BASE_GAIN,
  );
  const plateValue = fbmOctaves(
    plate, nx * PLATE_FREQ * ratio + offP[0], ny * PLATE_FREQ * ratio + offP[1], nz * PLATE_FREQ * ratio + offP[2],
    plateOctaves, LACUNARITY, PLATE_GAIN,
  );
  const detailValue = fbmOctaves(
    detail, dx * DETAIL_FREQ * ratio + offD[0], dy * DETAIL_FREQ * ratio + offD[1], dz * DETAIL_FREQ * ratio + offD[2],
    detailOctaves, LACUNARITY, DETAIL_GAIN,
  );

  const rawElev = WEIGHT_BASE * base + WEIGHT_PLATE * plateValue + WEIGHT_DETAIL * detailValue;
  let elevation = rawElev;
  if (rawElev > 0.40) {
    const d = rawElev - 0.40;
    elevation = rawElev + 5.0 * d * d;
  } else if (rawElev < 0.12) {
    const d = 0.12 - rawElev;
    elevation = rawElev - 0.65 * d;
  }
  elevation = clamp(elevation, -1, 1);
  return elevation * ELEVATION_SCALE_M;
}

/** Высота поля, разделённая на сушу (>= 0) и океан (<= 0) по нулевому уровню. */
export function sampleElevationBoth(dir: ArrayLike<number>, stepM: number): ElevationBoth {
  const elevation = sampleElevation(dir, stepM);
  return {
    landM: elevation > 0 ? elevation : 0,
    oceanM: elevation < 0 ? elevation : 0,
  };
}
