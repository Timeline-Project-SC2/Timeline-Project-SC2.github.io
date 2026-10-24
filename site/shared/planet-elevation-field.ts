/* PlanetElevationField — единое поле высот планеты (Stage-8.14, шаг 2 + W28c).
   Планетарный гекс и гекс стратегической карты — одно и то же поле,
   разной детализации; сид задаёт всё, береговая линия и высоты сквозные.

   Реплицирует рецепт высоты PlanetGeography (c100-soft-v3) — базовый fBm,
   пластины и деталь с теми же семенами/смещениями/весами — и делает его
   полосовым: число октав обрезается шагом выборки stepM (частота выше
   Найквиста не считается). При тонком шаге и без дополнительных октав
   результат совпадает с PlanetGeography.sampleFields (extraOctaves = 0)
   в пределах округления Float32.

   W28c: поле параметризуемо сидом и радиусом через createElevationField(profile).
   createElevationField({masterSeedHex, radiusKm}) строит шум на этот сид и
   возвращает {sampleElevation, sampleElevationBoth} с ratio=radiusKm/EARTH_RADIUS_KM.
   Старые модульные обёртки sampleElevation(dir,stepM) и sampleElevationBoth
   оставлены как deprecated-шимы (EARTH_RADIUS_KM, MASTER_SEED_HEX) для 12 импортов,
   но карта и глобус обязаны идти через экземпляр поля из профиля.

   Вертикаль W28c: поле возвращает ЕДИНИЦЫ высоты (-1..1), метры появляются
   только на границе отображения через K=VERTICAL_SCALE_M=8570 (из
   planet-geography-constants.ts, решение владельца). ELEVATION_SCALE_M=40_000
   остаётся как deprecated для старых потребителей.
*/

import PlanetGeography from './planet-geography.ts';
import {
  CONTRAST_LAND_GAIN,
  CONTRAST_LAND_PIVOT,
  CONTRAST_OCEAN_PIVOT,
  CONTRAST_OCEAN_SCALE,
  VERTICAL_SCALE_M,
} from './planet-geography-constants.ts';
import PlanetNoise from './planet-noise.ts';

const EARTH_RADIUS_KM = PlanetGeography.EARTH_RADIUS_KM;
const MASTER_SEED_HEX = '0123456789abcdef';

// 1.0 нормализованной высоты = 40 км рельефа (полный диапазон поля ±40 км).
// Единица выбрана так, чтобы на 5 км площади при extraOctaves = 24 размах
// высот превышал 8 % ширины (>= 400 м) — см. критерий приёма B и отчёт.
// W28c: deprecated, поле теперь возвращает единицы (-1..1), метры — через VERTICAL_SCALE_M=8570 у потребителя.
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
// 2 * pi * R / (freq * R / EARTH_RADIUS_KM) — не зависит от радиуса планеты
// при ratio=1, но при ratio !=1 частота масштабируется, сохраняя метрическую
// длину волны. Для планета большего радиуса ratio>1 увеличивает частоты.
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

// Кэш шумов по сиду, чтобы не пересоздавать на каждый вызов поля с тем же профилем
const noiseCache = new Map<string, ElevationNoise>();
function getNoiseForSeed(masterSeedHex: string): ElevationNoise {
  const key = masterSeedHex.toLowerCase();
  let cached = noiseCache.get(key);
  if (!cached) {
    cached = buildNoise(masterSeedHex);
    noiseCache.set(key, cached);
  }
  return cached;
}

export { ELEVATION_SCALE_M, VERTICAL_SCALE_M };

export interface ElevationBoth {
  /** Высота над нулевым уровнем в этой точке (0 под водой), единицы поля (-1..1). Для метров — умножить на VERTICAL_SCALE_M=8570 у потребителя. */
  landM: number;
  /** Глубина под нулевым уровнем в этой точке (0 на суше), единицы поля. */
  oceanM: number;
  /** Алиасы для потребителей, ожидающих единицы: */
  landUnits?: number;
  oceanUnits?: number;
}

export interface ElevationField {
  sampleElevation(dir: ArrayLike<number>, stepM: number): number;
  sampleElevationBoth(dir: ArrayLike<number>, stepM: number): ElevationBoth;
  profile: { masterSeedHex: string; radiusKm: number };
}

/** W28c: параметризуемое поле — шум по сиду профиля, ratio по радиусу */
export function createElevationField(profile: { masterSeedHex?: string; master_seed_hex?: string; radiusKm?: number; radius_km?: number; radius?: number }): ElevationField {
  const rawSeed = (profile as any).masterSeedHex ?? (profile as any).master_seed_hex ?? MASTER_SEED_HEX;
  const masterSeedHex = String(rawSeed).toLowerCase();
  const rawRadius = (profile as any).radiusKm ?? (profile as any).radius_km ?? (profile as any).radius ?? EARTH_RADIUS_KM;
  const radiusKm = Number(rawRadius) || EARTH_RADIUS_KM;
  const ratio = radiusKm / EARTH_RADIUS_KM;
  const noise = getNoiseForSeed(masterSeedHex);

  function sampleElevationUnits(dir: ArrayLike<number>, stepM: number): number {
    const [nx, ny, nz] = unitVector(dir[0] as number, dir[1] as number, dir[2] as number);
    const { elev, plate, detail, warp, offE, offP, offD, offW } = noise;

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
      plate, nx * PLATE_FREQ + offP[0], ny * PLATE_FREQ + offP[1], nz * PLATE_FREQ + offP[2],
      plateOctaves, LACUNARITY, PLATE_GAIN,
    );
    const detailValue = fbmOctaves(
      detail, dx * DETAIL_FREQ * ratio + offD[0], dy * DETAIL_FREQ * ratio + offD[1], dz * DETAIL_FREQ * ratio + offD[2],
      detailOctaves, LACUNARITY, DETAIL_GAIN,
    );

    const rawElev = WEIGHT_BASE * base + WEIGHT_PLATE * plateValue + WEIGHT_DETAIL * detailValue;
    let elevation = rawElev;
    if (rawElev > CONTRAST_LAND_PIVOT) {
      const d = rawElev - CONTRAST_LAND_PIVOT;
      elevation = rawElev + CONTRAST_LAND_GAIN * d * d;
    } else if (rawElev < CONTRAST_OCEAN_PIVOT) {
      const d = CONTRAST_OCEAN_PIVOT - rawElev;
      elevation = rawElev - CONTRAST_OCEAN_SCALE * d;
    }
    elevation = clamp(elevation, -1, 1);
    // W28c: поле возвращает ЕДИНИЦЫ (-1..1), метры — у потребителя через VERTICAL_SCALE_M
    return elevation;
  }

  function sampleElevationBothUnits(dir: ArrayLike<number>, stepM: number): ElevationBoth {
    const elevation = sampleElevationUnits(dir, stepM);
    return {
      landM: elevation > 0 ? elevation : 0,
      oceanM: elevation < 0 ? elevation : 0,
      landUnits: elevation > 0 ? elevation : 0,
      oceanUnits: elevation < 0 ? elevation : 0,
    };
  }

  return {
    sampleElevation: sampleElevationUnits,
    sampleElevationBoth: sampleElevationBothUnits,
    profile: { masterSeedHex, radiusKm },
  };
}

// Дефолтное поле для deprecated-шимов (один раз при загрузке модуля)
const defaultField = createElevationField({ masterSeedHex: MASTER_SEED_HEX, radiusKm: EARTH_RADIUS_KM });

/** @deprecated — используйте createElevationField(profile).sampleElevation; оставлен для 12 импортов, возвращает ЕДИНИЦЫ (-1..1) с дефолтным сидом/радиусом Земли */
export function sampleElevation(dir: ArrayLike<number>, stepM: number): number {
  return defaultField.sampleElevation(dir, stepM);
}

/** @deprecated — используйте createElevationField(profile).sampleElevationBoth */
export function sampleElevationBoth(dir: ArrayLike<number>, stepM: number): ElevationBoth {
  return defaultField.sampleElevationBoth(dir, stepM);
}
