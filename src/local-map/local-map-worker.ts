/* LocalMapWorker — CPU-генератор локальной карты (Этапы 8/9, CR-01 PR 5).
   Модуль 2 из четырёх распила site/shared/temp_code_structures.js (И-5).
   --------------------------------------------------------------------------
   Архитектурный базис (LOCKED CONTRACT): worker — единственный источник
   истины: генерирует heightfield, zone_map (Uint8Array RG), terraform_map
   (Uint8Array R) и scatter-инстансы; всё отдаётся Transferable-буферами.
   Вход по И-3 — канонический срез 7 ячеек глобуса v=128 (LocalMapPatch из
   local-map-contract.ts): сэмплы полей обязаны идти через единый 3D-сэмплер
   planet-core / planet-geography, а спавн структур — через buildingSpawnMask
   (вода, озёра, русла рек, крутые склоны запрещены).

   Поля wire-протокола ниже разделяет с рендерером (local-map-renderer.ts)
   только через `import type` — у модуля есть побочный эффект регистрации
   onmessage, и value-импорт из него тащил бы его в главный поток. */

import {
  baseElevationOf,
  buildBuildingSpawnMask,
  createPatchFieldSampler,
  isWaterCell,
  localPointToDirection,
  nearestPatchCell,
  patchSpanMeters,
  samplePatchFields,
  verifyPatchInvariants,
  waterLevelOf,
} from './local-map-contract.ts';
import type { BuildingSpawnRule, LocalMapPatch, PatchCell } from './local-map-contract.ts';
import type { MeshModuleId } from './local-map-mesh.ts';
import type { FieldSampler, GeographyProfileInput } from '../../site/shared/planet-geography.ts';

// ---- Константы контракта ----
export const HEIGHTFIELD_RES = 256;
export const ZONE_RES = 64;
export const TERRAFORM_RES = 256;
export const MAX_INSTANCES = 4096;

/** Метры рельефа на единицу канонической высоты c100-soft-v2 (И-3.2). */
export const METERS_PER_ELEVATION_UNIT = 900;
/** Амплитуда локального fBm-рельефа на суше, м. */
export const LAND_FBM_AMPLITUDE_M = 80;
/** Амплитуда канала `detail` единого 3D-сэмплера, м (И-3.1). */
export const PROFILE_DETAIL_AMPLITUDE_M = 40;
/** Узлов решётки кэширования канала `detail` на сторону (65×65 опросов). */
export const DETAIL_LATTICE_STEPS = 64;
/** Полуширина русла реки в долях радиуса участка. */
export const RIVER_HALF_WIDTH_RATIO = 0.03;
/** Глубина вреза русла в долях радиуса участка. */
export const RIVER_DEPTH_RATIO = 0.0025;
/** Ёмкость LRU-кэша локальных участков (И-3, Патч 8). */
export const LOCAL_MAP_CACHE_LIMIT = 8;
/**
 * Stage-8.5: явный водный маркер `terraform_map`. Байт `0` означает
 * «вода/озеро канонической ячейки Patch7», а любая точка суши несёт минимум
 * `TERRAFORM_LAND_MIN = 2` — даже там, где терраформинга нет вовсе. Значение
 * `1` зарезервировано и на суше не встречается, поэтому потребитель карты
 * (шейдер рельефа) отличает пологую сухую равнину от воды одним сравнением,
 * а не по совпадению «нулевой альфы» с нулевой высотой.
 */
export const TERRAFORM_LAND_MIN = 2;
/** Stage-8.5: знаменатель альфы терраформинга — `255 − TERRAFORM_LAND_MIN`. */
export const TERRAFORM_ALPHA_SPAN = 253;

/** Данные инстанса: 8 float × 4 Б = 32 байта (контракт layout-а шейдера). */
export type InstanceData = readonly [
  x: number, y: number, z: number, yaw: number,
  sx: number, sy: number, sz: number, tintPacked: number,
];

export interface ScatterInstance {
  readonly moduleId: MeshModuleId;
  readonly data: InstanceData;
}

export interface InstancePack {
  readonly buffer: Float32Array;
  readonly count: number;
}

export type InstanceBuffers = Partial<Record<MeshModuleId, InstancePack>>;

export interface LocalMapMeta {
  readonly radiusM: number;
  readonly hfRes: number;
  readonly zoneRes: number;
  readonly tfRes: number;
  /** Число высаженных инстансов 3D-структур (после маски И-3.4). */
  readonly totalInstances?: number;
  /** Доля точек рельефа, где разрешён спавн (buildingSpawnMask == 1). */
  readonly buildableFraction?: number;
  /** Доля точек рельефа, попавших в воду/озёра канонических ячеек (И-3.2). */
  readonly waterFraction?: number;
  readonly minHeightM?: number;
  readonly maxHeightM?: number;
  /** Время CPU-генерации участка, мс (гейт G4: <= 150 мс). */
  readonly genMs?: number;
  /** Ключ участка (§8.8); по умолчанию строка канонического центра. */
  readonly patchKey?: string;
}

export interface LocalMapWorkerRequest {
  /** Канонический срез 7 ячеек глобуса v=128 (И-3): обязателен для воркера. */
  readonly patch: LocalMapPatch;
  readonly seed: number;
  readonly placeId: number;
  readonly radiusM: number;
  readonly centerLat?: number;
  readonly centerLon?: number;
  /** Правило маски спавна (И-3.4); по умолчанию DEFAULT_BUILDING_SPAWN_RULE. */
  readonly spawnRule?: BuildingSpawnRule;
  /** Профиль планеты для единого 3D-сэмплера полей (И-3.1); без него — только fBm. */
  readonly profile?: GeographyProfileInput;
  /** Ключ участка §8.8 — ключ LRU-кэша и метки `meta.patchKey`. */
  readonly patchKey?: string;
}

export interface LocalMapWorkerResponse {
  readonly heightfield: Float32Array;
  readonly zoneMap: Uint8Array;
  readonly terraformMap: Uint8Array;
  readonly instanceBuffers: InstanceBuffers;
  readonly meta: LocalMapMeta;
}

// ---- Детерминированный хэш (pcg-подобный) ----
function pcgHash(state: number): number {
  // PCG-XSH-RR: один раунд
  state = state >>> 0;
  state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
  const word = (((state >>> ((state >>> 28) + 4)) ^ state) * 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

function hash2(ix: number, iy: number, seed: number): number {
  // 2D → uint32: один раунд PCG по XOR-смешанным входам. Два раунда
  // (как в первой версии) давали тот же детерминизм, но вдвое дороже —
  // гейт G4 (worker-генерация <= 150 мс) оставляет запас на слабых машинах.
  const mixed = (Math.imul(ix | 0, 0x9E3779B1) ^ Math.imul(iy | 0, 0x85EBCA77) ^ Math.imul(seed | 0, 0xC2B2AE3D)) >>> 0;
  return pcgHash(mixed);
}

function hashFloat(ix: number, iy: number, seed: number): number {
  // 2D → [0, 1)
  return (hash2(ix, iy, seed) >>> 0) / 4294967296;
}

function hashFloat2(ix: number, iy: number, seed: number): [number, number] {
  // Два независимых [0,1)
  const h1 = hashFloat(ix, iy, seed);
  const h2 = hashFloat(ix, iy, seed ^ 0x9E3779B9);
  return [h1, h2];
}

// ---- fBm (value noise с хешем, 6 октав) ----
// Для краткости — простой value noise. В продакшене заменить на Simplex.
function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  // smoothstep
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hashFloat(ix, iy, seed);
  const b = hashFloat(ix + 1, iy, seed);
  const c = hashFloat(ix, iy + 1, seed);
  const d = hashFloat(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fBm(x: number, y: number, seed: number, octaves = 6, lacunarity = 2.0, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, maxAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x * freq, y * freq, seed + i * 7919) * amp;
    maxAmp += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / maxAmp;   // нормализовано в [0, 1]
}

/**
 * Stage-8.3: гребневой мультифрактал (ridged fBm) горных хребтов юбки
 * горизонта. Каждая октава складывается «гармошкой» вокруг середины шума
 * (`ridge = 1 - |2n - 1|`), возводится в квадрат для острых гребней и
 * взвешивается результатом предыдущей октавы: детали живут на гребнях,
 * а межгорные долины остаются гладкими. Нормировано в [0, 1].
 */
export function ridgedFbm(x: number, y: number, seed: number, octaves = 5): number {
  let amp = 1, freq = 1, sum = 0, maxAmp = 0, weight = 1;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise2D(x * freq, y * freq, seed + i * 7919);
    const ridge = 1 - Math.abs(2 * n - 1);
    let sharp = ridge * ridge;
    sharp *= weight;
    weight = Math.min(1, Math.max(0, sharp * 1.6));
    sum += sharp * amp;
    maxAmp += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return maxAmp > 0 ? sum / maxAmp : 0;   // нормализовано в [0, 1]
}

// ---- Box Blur (separable, 2 прохода) ----
export function boxBlurSeparable(src: Float32Array, w: number, h: number, kernelRadius: number): Float32Array {
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const k = kernelRadius;
  const d = 2 * k + 1;

  // Горизонтальный проход
  for (let row = 0; row < h; row++) {
    let sum = 0;
    // Инициализация окна для первого пикселя строки
    for (let dx = -k; dx <= k; dx++) {
      sum += src[row * w + Math.max(0, Math.min(dx, w - 1))] as number;
    }
    tmp[row * w] = sum / d;
    for (let col = 1; col < w; col++) {
      const addIdx = Math.min(col + k, w - 1);
      const remIdx = Math.max(col - k - 1, 0);
      sum += (src[row * w + addIdx] as number) - (src[row * w + remIdx] as number);
      tmp[row * w + col] = sum / d;
    }
  }

  // Вертикальный проход
  for (let col = 0; col < w; col++) {
    let sum = 0;
    for (let dy = -k; dy <= k; dy++) {
      sum += tmp[Math.max(0, Math.min(dy, h - 1)) * w + col] as number;
    }
    dst[col] = sum / d;
    for (let row = 1; row < h; row++) {
      const addIdx = Math.min(row + k, h - 1);
      const remIdx = Math.max(row - k - 1, 0);
      sum += (tmp[addIdx * w + col] as number) - (tmp[remIdx * w + col] as number);
      dst[row * w + col] = sum / d;
    }
  }

  return dst;
}

// ---- Генерация текстурных карт (CPU) ----
export function generateZoneMap(seed: number, placeId: number): Uint8Array {
  // Stage-8.3: органические поселковые кластеры и хутора в природной долине
  // вместо сплошной концентрической «мишени» до d = 0.95. Гладкий 2D-шум
  // clusterNoise вырезает компактные гроздья застройки только в долине
  // (d < 0.78): большая часть гекса остаётся природным ландшафтом
  // (zone = 0, density = 0 — луга и склоны), а внутри гроздей радиус по-прежнему
  // задаёт характер застройки (ядро → пром → жилая → периметр) и плотность,
  // достаточную для спавна зданий в scatterInstances.
  const map = new Uint8Array(ZONE_RES * ZONE_RES * 2); // RG
  const cx = ZONE_RES / 2, cy = ZONE_RES / 2;
  const maxR = ZONE_RES / 2;
  const baseSeed = seed ^ (placeId * 48611);

  for (let y = 0; y < ZONE_RES; y++) {
    for (let x = 0; x < ZONE_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / maxR;  // 0..1+
      const clusterNoise = valueNoise2D(x * 0.14, y * 0.14, baseSeed ^ 0x71C9);

      let zone = 0, density = 0;                      // Природный ландшафт
      if (d < 0.78) {
        // Порог грозди растёт к краю долины: у ядра посёлок плотнее и шире,
        // к периферии остаются лишь редкие хутора на сильных гребнях шума.
        const radialT = Math.min(1, Math.max(0, (d - 0.10) / 0.68));
        const radialSmooth = radialT * radialT * (3 - 2 * radialT);
        const threshold = 0.51 + 0.15 * radialSmooth;
        if (clusterNoise > threshold) {
          // Сила грозди: 0 на органической границе пятна, 1 в его сердцевине.
          const strength = Math.min(1, (clusterNoise - threshold) / 0.22);
          const jitter = hashFloat(x, y, baseSeed + 1) * 20;
          if (d < 0.13) {
            zone = 4; density = Math.floor(190 + strength * 55 + jitter);   // Ядро
          } else if (d < 0.32) {
            zone = 2; density = Math.floor(150 + strength * 75 + jitter);   // Пром
          } else if (d < 0.60) {
            zone = 1; density = Math.floor(120 + strength * 75 + jitter);   // Лёгкая застройка
          } else {
            zone = 3; density = Math.floor(95 + strength * 65 + jitter);    // Периметр/хутора
          }
        }
      }

      const idx = (y * ZONE_RES + x) * 2;
      map[idx] = zone;
      map[idx + 1] = Math.min(255, Math.max(0, density));
    }
  }
  return map;
}

export function generateTerraformMap(): Uint8Array {
  // Stage-8.3: мягкий гауссов спад от центра. Радиус «разутюживания» уменьшен
  // (sigma = 0.18 · рез.), а максимальная альфа ограничена 0.42 вместо 1.0 —
  // долина внутри гекса сохраняет живой природный микрорельеф холмов и ложбин,
  // а не превращается в плоский бетонный стол под застройкой.
  // Stage-8.5: гауссов профиль сохраняется, но минимальная подложка суши
  // поднята до TERRAFORM_LAND_MIN — байт суши никогда не равен 0 или 1, иначе
  // на пологой равнине в масштабах 10…1250 км шейдер принимал сухую землю за
  // водное зеркало (нулевая альфа терраформинга выглядела как маркер воды).
  const map = new Uint8Array(TERRAFORM_RES * TERRAFORM_RES);
  const cx = TERRAFORM_RES / 2, cy = TERRAFORM_RES / 2;
  const sigma = TERRAFORM_RES * 0.18;

  for (let y = 0; y < TERRAFORM_RES; y++) {
    for (let x = 0; x < TERRAFORM_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const alpha = Math.min(0.42, Math.exp(-r2 / (2 * sigma * sigma)));
      map[y * TERRAFORM_RES + x] = Math.max(TERRAFORM_LAND_MIN, Math.floor(alpha * 255));
    }
  }
  return map;
}

/**
 * И-3.2/И-3.4: вода, озёра и русла не получают зонирования. Тексели `zone_map`,
 * попавшие в водные канонические ячейки Patch7, переводятся в зону 0 (пустошь)
 * с нулевой плотностью — шейдер рельефа по `zone == 0u` и глубине ниже
 * `seaLevel` плавно тонирует их водно-бирюзовым оттенком, а `scatterInstances`
 * не ставит над ними ни одного здания. При переданном `radiusM > 0` тексель
 * проверяется и на размахе `patchSpanMeters(patch)`, и на локальном размахе
 * `2 · radiusM` — малый детальный участок не наследует зонирование сухих
 * соседей, попавших на края полного патча.
 */
export function applyWaterZoning(
  zoneMap: Uint8Array,
  patch: LocalMapPatch,
  radiusM?: number,
): Uint8Array {
  const zRes = ZONE_RES;
  const span = patchSpanMeters(patch);
  // При малом radiusM детальный участок занимает лишь центральную часть
  // patchSpanMeters, поэтому тексель проверяется ещё и на локальном размахе
  // 2 · radiusM: иначе зонирование «сухих соседей» перекрывало бы озеро.
  const localSpan = typeof radiusM === 'number' && radiusM > 0 ? 2 * radiusM : 0;
  const isWaterOrRiver = (u: number, v: number): boolean => {
    const cell = nearestPatchCell(patch, localPointToDirection(patch, u, v));
    return isWaterCell(cell, patch.seaLevel) || cell.streamWeight > 0;
  };
  for (let zy = 0; zy < zRes; zy++) {
    const v = ((zy + 0.5) / zRes - 0.5) * span;
    const vLocal = localSpan > 0 ? ((zy + 0.5) / zRes - 0.5) * localSpan : 0;
    for (let zx = 0; zx < zRes; zx++) {
      const u = ((zx + 0.5) / zRes - 0.5) * span;
      const wetOnSpan = isWaterOrRiver(u, v);
      if (!wetOnSpan) {
        if (localSpan <= 0) continue;
        const uLocal = ((zx + 0.5) / zRes - 0.5) * localSpan;
        if (!isWaterOrRiver(uLocal, vLocal)) continue;
      }
      const idx = (zy * zRes + zx) * 2;
      zoneMap[idx] = 0;
      zoneMap[idx + 1] = 0;
    }
  }
  return zoneMap;
}

// ---- ZONE_MODULES (зеркало контракта) ----
export type ZoneId = 1 | 2 | 3 | 4;

export interface ZoneModuleDef {
  readonly id: MeshModuleId;
  readonly weight: number;
  readonly scale: readonly [number, number];
  readonly hScale: readonly [number, number];
}

export const ZONE_MODULES: Readonly<Record<ZoneId, readonly ZoneModuleDef[]>> = {
  1: [
    { id: 'hab_box', weight: 0.50, scale: [0.8, 1.2], hScale: [0.8, 1.3] },
    { id: 'container', weight: 0.35, scale: [0.6, 1.0], hScale: [0.5, 1.0] },
    { id: 'comm_mast', weight: 0.15, scale: [0.9, 1.1], hScale: [1.2, 2.0] },
  ],
  2: [
    { id: 'factory', weight: 0.40, scale: [1.2, 1.8], hScale: [1.0, 1.5] },
    { id: 'silo_tank', weight: 0.30, scale: [0.9, 1.3], hScale: [1.0, 1.8] },
    { id: 'pipe_stack', weight: 0.20, scale: [1.0, 1.5], hScale: [1.5, 2.5] },
    { id: 'cargo_bay', weight: 0.10, scale: [1.0, 1.4], hScale: [0.8, 1.2] },
  ],
  3: [
    { id: 'guard_tower', weight: 0.50, scale: [0.9, 1.2], hScale: [1.4, 2.2] },
    { id: 'barrier', weight: 0.35, scale: [1.0, 1.5], hScale: [0.6, 1.0] },
    { id: 'radar_dish', weight: 0.15, scale: [1.0, 1.3], hScale: [1.2, 1.8] },
  ],
  4: [
    { id: 'hq_center', weight: 0.60, scale: [1.5, 2.2], hScale: [1.2, 1.8] },
    { id: 'dome_vault', weight: 0.40, scale: [1.2, 1.7], hScale: [1.0, 1.5] },
  ],
};

function isZoneId(value: number): value is ZoneId {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// Предвычисляем CDF для weighted random
const ZONE_CDF: Record<ZoneId, number[]> = { 1: [], 2: [], 3: [], 4: [] };
for (const zone of [1, 2, 3, 4] as ZoneId[]) {
  let cumul = 0;
  for (const m of ZONE_MODULES[zone]) {
    cumul += m.weight;
    ZONE_CDF[zone].push(cumul);
  }
}

export function pickModule(zone: ZoneId, rand01: number): ZoneModuleDef {
  const cdf = ZONE_CDF[zone];
  const modules = ZONE_MODULES[zone];
  for (let i = 0; i < cdf.length; i++) {
    if (rand01 < (cdf[i] as number)) return modules[i] as ZoneModuleDef;
  }
  return modules[modules.length - 1] as ZoneModuleDef;
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

export function packTint(r: number, g: number, b: number, a: number): number {
  const u32 = ((r & 0xFF) | ((g & 0xFF) << 8) | ((b & 0xFF) << 16) | ((a & 0xFF) << 24)) >>> 0;
  const buf = new ArrayBuffer(4);
  new Uint32Array(buf)[0] = u32;
  return new Float32Array(buf)[0] as number;
}

// ---- ПАЛИТРЫ ОТТЕНКОВ ----
export type Rgb = readonly [number, number, number];
export const TINT_PALETTES: Readonly<Record<ZoneId, readonly Rgb[]>> = {
  1: [[180, 180, 190], [160, 155, 140], [140, 150, 160]],   // серо-стальной, песочный
  2: [[200, 120, 50], [180, 160, 100], [150, 150, 150]],   // индустриальный оранж
  3: [[100, 110, 100], [120, 120, 80], [90, 100, 90]],     // камуфляж / тёмный
  4: [[200, 200, 210], [170, 190, 220], [220, 220, 230]],  // светлый штаб
};

// ---- Scatter Engine ----
export function scatterInstances(
  zoneMap: Uint8Array,
  heightfield: Float32Array,
  radiusM: number,
  seed: number,
  placeId: number,
  spawnMask?: Uint8Array | null,
): ScatterInstance[] {
  const instances: ScatterInstance[] = [];              // будет max 4096
  const hfRes = HEIGHTFIELD_RES;
  const zRes = ZONE_RES;
  const cellWorldSize = (2 * radiusM) / hfRes;         // метры на ячейку heightfield
  const baseSeed = seed ^ (placeId * 91939);

  // Jittered Grid: шаг зависит от зоны, но для простоты — фиксированный шаг
  // и фильтрация по density
  const GRID_STEP = 4;                                  // в ячейках heightfield (≈ 4 * cellWorldSize метров)

  // Пройдём по grid
  for (let gy = 0; gy < hfRes; gy += GRID_STEP) {
    for (let gx = 0; gx < hfRes; gx += GRID_STEP) {
      if (instances.length >= MAX_INSTANCES) break;

      // Jitter
      const [jx, jy] = hashFloat2(gx, gy, baseSeed);
      const px = gx + jx * GRID_STEP * 0.8;
      const py = gy + jy * GRID_STEP * 0.8;

      const pxi = Math.floor(px), pyi = Math.floor(py);
      if (pxi < 0 || pxi >= hfRes || pyi < 0 || pyi >= hfRes) continue;

      // И-3.4: buildingSpawnMask — спавн 3D-структур запрещён над водой,
      // озёрами, руслами рек и крутыми склонами (см. local-map-contract.ts).
      if (spawnMask && spawnMask[pyi * hfRes + pxi] === 0) continue;

      // Сэмплируем зону (64×64 → перемасштабируем координаты)
      const zx = Math.floor((px / hfRes) * zRes);
      const zy = Math.floor((py / hfRes) * zRes);
      const zIdx = (zy * zRes + zx) * 2;
      const zoneValue = zoneMap[zIdx] as number;
      const density = zoneMap[zIdx + 1] as number;

      if (!isZoneId(zoneValue)) continue;               // пустошь и мусор — пропуск
      const zone = zoneValue;

      // Проверка плотности
      const spawnRoll = hashFloat(gx + 1, gy + 1, baseSeed + 3);
      if (spawnRoll > density / 255) continue;

      // Inset: проверяем соседние ячейки зоны на смену зоны
      let onBorder = false;
      for (const [dx2, dy2] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const nzx = zx + dx2, nzy = zy + dy2;
        if (nzx < 0 || nzy < 0 || nzx >= zRes || nzy >= zRes) { onBorder = true; break; }
        if (zoneMap[(nzy * zRes + nzx) * 2] !== zone) { onBorder = true; break; }
      }
      if (onBorder) continue;

      // Выбираем модуль
      const moduleRoll = hashFloat(gx + 2, gy + 2, baseSeed + 7);
      const mod = pickModule(zone, moduleRoll);

      // Мировые координаты (origin = центр карты)
      const worldX = (px - hfRes / 2) * cellWorldSize;
      const worldY = (py - hfRes / 2) * cellWorldSize;
      const worldZ = heightfield[pyi * hfRes + pxi] as number;

      // Yaw
      const yaw = hashFloat(gx + 3, gy + 3, baseSeed + 11) * Math.PI * 2;

      // Scale (масштабируется к физическому окну обзора, чтобы постройки
      // были читаемы и на 1,2 км тактического участка, и на региональном обзоре)
      const sRoll = hashFloat(gx + 4, gy + 4, baseSeed + 13);
      const hRoll = hashFloat(gx + 5, gy + 5, baseSeed + 17);
      const worldScale = Math.max(1.8, radiusM / 320);
      const sx = lerp(mod.scale[0], mod.scale[1], sRoll) * worldScale;
      const sy = sx;  // квадратный footprint (или отдельный roll для sy)
      const sz = lerp(mod.hScale[0], mod.hScale[1], hRoll) * worldScale;

      // Tint
      const palette = TINT_PALETTES[zone];
      const tIdx = Math.floor(hashFloat(gx + 6, gy + 6, baseSeed + 19) * palette.length);
      const [tr, tg, tb] = palette[Math.min(tIdx, palette.length - 1)] as Rgb;
      const tintPacked = packTint(tr, tg, tb, 255);

      instances.push({
        moduleId: mod.id,
        data: [worldX, worldY, worldZ, yaw, sx, sy, sz, tintPacked],
      });
    }
    if (instances.length >= MAX_INSTANCES) break;
  }

  return instances;
}

// ---- Группировка инстансов по модулю ----
export function packInstancesByModule(instances: readonly ScatterInstance[]): InstanceBuffers {
  interface MutableGroup {
    buffer: Float32Array;
    count: number;
    offset: number;
  }
  const groups: Partial<Record<MeshModuleId, MutableGroup>> = {};
  const counts: Partial<Record<MeshModuleId, number>> = {};

  // Подсчёт
  for (const inst of instances) {
    counts[inst.moduleId] = (counts[inst.moduleId] ?? 0) + 1;
  }

  // Аллокация
  for (const id of Object.keys(counts) as MeshModuleId[]) {
    const count = counts[id] as number;
    groups[id] = { buffer: new Float32Array(count * 8), count, offset: 0 };
  }

  // Заполнение
  for (const inst of instances) {
    const g = groups[inst.moduleId] as MutableGroup;
    g.buffer.set(inst.data, g.offset * 8);
    g.offset++;
  }

  // Результат: { moduleId: { buffer: Float32Array, count: N } }
  const result: InstanceBuffers = {};
  for (const id of Object.keys(groups) as MeshModuleId[]) {
    const g = groups[id] as MutableGroup;
    result[id] = { buffer: g.buffer, count: g.count };
  }
  return result;
}

// ---------------------------------------------------------------------------
// И-3.1/И-3.3: касательный кадр патча — координаты 7 канонических ячеек в метрах
// ---------------------------------------------------------------------------

interface Tangent2D { readonly u: number; readonly v: number; }

/** Обратная exp-карта: центр канонической ячейки → (u, v) касательной плоскости, м. */
function cellTangentMeters(patch: LocalMapPatch, cell: PatchCell): Tangent2D {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a: readonly number[], b: readonly number[]): number =>
    (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number);
  const cosTheta = Math.min(1, Math.max(-1, dot(cell.center, origin)));
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  // chord = theta * R, u = chord * dot(dir, east) / sin(theta) — точный обратный exp-мап.
  const scale = sinTheta > 1e-9 ? (theta * radiusM) / sinTheta : radiusM;
  return { u: dot(cell.center, east) * scale, v: dot(cell.center, north) * scale };
}

interface RiverSegment {
  readonly u0: number; readonly v0: number;
  readonly u1: number; readonly v1: number;
  /** Bounding box сегмента, расширенная на полуширину русла, — быстрый отсев. */
  readonly minU: number; readonly minV: number;
  readonly maxU: number; readonly maxV: number;
}

/**
 * И-3.3: русло входит строго через грани соседей-притоков (`inlets`) и выходит
 * строго через грань `flowReceiver` центра (`outlet`) в касательном кадре.
 */
function riverSegments(patch: LocalMapPatch, radiusM: number, halfWidthM: number): RiverSegment[] {
  const raw: Array<Omit<RiverSegment, 'minU' | 'minV' | 'maxU' | 'maxV'>> = [];
  if (patch.river.flowsThroughCenter || patch.river.inlets.length > 0) {
    for (const edge of patch.river.inlets) {
      const cell = patch.cells[edge.slot + 1];
      if (!cell) continue;
      const inlet = cellTangentMeters(patch, cell);
      raw.push({ u0: inlet.u, v0: inlet.v, u1: 0, v1: 0 });
    }
    if (patch.river.outlet) {
      const cell = patch.cells[patch.river.outlet.slot + 1];
      if (cell) {
        const outlet = cellTangentMeters(patch, cell);
        raw.push({ u0: 0, v0: 0, u1: outlet.u, v1: outlet.v });
      }
    }
    // Русло без притоков/устья (терминальное озеро): прямой створ через центр.
    if (raw.length === 0 && patch.river.flowsThroughCenter) {
      raw.push({ u0: -2 * radiusM, v0: 0, u1: 2 * radiusM, v1: 0 });
    }
  }
  return raw.map((seg) => ({
    ...seg,
    minU: Math.min(seg.u0, seg.u1) - halfWidthM,
    minV: Math.min(seg.v0, seg.v1) - halfWidthM,
    maxU: Math.max(seg.u0, seg.u1) + halfWidthM,
    maxV: Math.max(seg.v0, seg.v1) + halfWidthM,
  }));
}

/** Расстояние от точки до отрезка в касательной плоскости, м. */
function distanceToSegment(wx: number, wy: number, seg: RiverSegment): number {
  const dx = seg.u1 - seg.u0;
  const dy = seg.v1 - seg.v0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((wx - seg.u0) * dx + (wy - seg.v0) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.u0 + dx * t;
  const py = seg.v0 + dy * t;
  return Math.hypot(wx - px, wy - py);
}

/** Плавный профиль вреза русла: 1 в стрежне, 0 за полушириной. */
function riverCarveFactor(wx: number, wy: number, segments: readonly RiverSegment[], halfWidthM: number): number {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  let best = Infinity;
  for (const seg of segments) {
    if (wx < seg.minU || wx > seg.maxU || wy < seg.minV || wy > seg.maxV) continue;
    const d = distanceToSegment(wx, wy, seg);
    if (d < best) best = d;
  }
  if (best === Infinity) return 0;
  if (best >= halfWidthM) return 0;
  const t = 1 - best / halfWidthM;
  return t * t * (3 - 2 * t);
}

/**
 * Канал `detail` единого 3D-сэмплера (И-3.1) на решётке 65×65 узлов с
 * билинейной интерполяцией: 4 225 опросов вместо 65 536 держат гейт G4
 * (генерация <= 150 мс) при сохранении непрерывности поля (И-3.1).
 */
function sampleDetailLattice(
  patch: LocalMapPatch, sampler: FieldSampler, radiusM: number,
): Float32Array {
  const nodes = DETAIL_LATTICE_STEPS + 1;
  const lattice = new Float32Array(nodes * nodes);
  const scratch = new Float32Array(8);
  for (let j = 0; j < nodes; j++) {
    const v = ((j / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
    for (let i = 0; i < nodes; i++) {
      const u = ((i / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
      const fields = samplePatchFields(patch, sampler, u, v, scratch);
      const detail = fields[5] as number;
      lattice[j * nodes + i] = detail < -1 ? -1 : detail > 1 ? 1 : detail;
    }
  }
  return lattice;
}

function sampleDetailAt(lattice: Float32Array, tx: number, ty: number): number {
  const nodes = DETAIL_LATTICE_STEPS + 1;
  const fx = Math.min(DETAIL_LATTICE_STEPS - 1e-9, Math.max(0, tx * DETAIL_LATTICE_STEPS));
  const fy = Math.min(DETAIL_LATTICE_STEPS - 1e-9, Math.max(0, ty * DETAIL_LATTICE_STEPS));
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const ax = fx - ix, ay = fy - iy;
  const i0 = iy * nodes + ix;
  const i1 = i0 + 1;
  const i2 = i0 + nodes;
  const i3 = i2 + 1;
  const top = (lattice[i0] as number) * (1 - ax) + (lattice[i1] as number) * ax;
  const bottom = (lattice[i2] as number) * (1 - ax) + (lattice[i3] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

// ---------------------------------------------------------------------------
// LRU-кэш локальных участков (до 8 записей, Патч 8)
// ---------------------------------------------------------------------------

interface LocalMapCacheEntry {
  readonly response: LocalMapWorkerResponse;
  readonly fingerprint: string;
}

const LOCAL_MAP_CACHE = new Map<string, LocalMapCacheEntry>();

/** Ключ участка: `${patchKey || centerCell}:${radiusM}:${seed}:${placeId}`. */
export function localMapCacheKey(request: LocalMapWorkerRequest): string {
  const center = request.patchKey || String(request.patch.centerCell);
  return `${center}:${request.radiusM}:${request.seed}:${request.placeId}`;
}

/** Отпечаток входных данных, влияющих на рельеф помимо ключа участка. */
function localMapFingerprint(request: LocalMapWorkerRequest): string {
  const seedHex = request.profile ? String(request.profile['masterSeedHex'] ?? '') : 'none';
  const rule = request.spawnRule
    ? `${request.spawnRule.minLand}/${request.spawnRule.maxSlope}`
    : 'default';
  return `${seedHex}|${rule}`;
}

function cloneInstanceBuffers(instanceBuffers: InstanceBuffers): InstanceBuffers {
  const copy: Record<string, InstancePack> = {};
  for (const [id, pack] of Object.entries(instanceBuffers)) {
    if (!pack) continue;
    copy[id] = { buffer: new Float32Array(pack.buffer), count: pack.count };
  }
  return copy as InstanceBuffers;
}

/** Глубокая копия ответа: кэш и Transferable-буферы вызывающего не пересекаются. */
export function cloneLocalMapResponse(response: LocalMapWorkerResponse): LocalMapWorkerResponse {
  return {
    heightfield: new Float32Array(response.heightfield),
    zoneMap: new Uint8Array(response.zoneMap),
    terraformMap: new Uint8Array(response.terraformMap),
    instanceBuffers: cloneInstanceBuffers(response.instanceBuffers),
    meta: { ...response.meta },
  };
}

function readCache(key: string, fingerprint: string | null): LocalMapWorkerResponse | undefined {
  const entry = LOCAL_MAP_CACHE.get(key);
  if (!entry) return undefined;
  if (fingerprint !== null && entry.fingerprint !== fingerprint) {
    LOCAL_MAP_CACHE.delete(key);
    return undefined;
  }
  // Освежаем порядок LRU: последняя запись — самая свежая.
  LOCAL_MAP_CACHE.delete(key);
  LOCAL_MAP_CACHE.set(key, entry);
  return cloneLocalMapResponse(entry.response);
}

function writeCache(key: string, request: LocalMapWorkerRequest, response: LocalMapWorkerResponse): void {
  LOCAL_MAP_CACHE.delete(key);
  LOCAL_MAP_CACHE.set(key, {
    response: cloneLocalMapResponse(response),
    fingerprint: localMapFingerprint(request),
  });
  while (LOCAL_MAP_CACHE.size > LOCAL_MAP_CACHE_LIMIT) {
    const oldest = LOCAL_MAP_CACHE.keys().next();
    if (oldest.done) break;
    LOCAL_MAP_CACHE.delete(oldest.value);
  }
}

/** Кэшированный участок или `undefined`; буферы всегда клонируются. */
export function getCachedLocalMap(key: string): LocalMapWorkerResponse | undefined {
  return readCache(key, null);
}

/** Полная очистка LRU-кэша участков (смена планеты/профиля). */
export function clearLocalMapCache(): void {
  LOCAL_MAP_CACHE.clear();
}

/** Текущее число записей кэша (диагностика). */
export function localMapCacheSize(): number {
  return LOCAL_MAP_CACHE.size;
}

// ---- Main Entry Point ----
export function generateLocalMap(request: LocalMapWorkerRequest): LocalMapWorkerResponse {
  const { patch, seed, placeId, radiusM } = request;
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const hfRes = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;

  // И-3: вход воркера — только валидный канонический срез 7 ячеек глобуса.
  const report = verifyPatchInvariants(patch);
  if (!report.ok) {
    throw new Error('LocalMapWorker: патч 7 ячеек нарушил инварианты И-3: ' + JSON.stringify(report.checks));
  }

  const cacheKey = localMapCacheKey(request);
  const cached = readCache(cacheKey, localMapFingerprint(request));
  if (cached) return cached;

  // 0. И-3.4: маска спавна нужна и для смешивания терраформинга, и для scatter.
  const spawnMask = buildBuildingSpawnMask(patch, hfRes, request.spawnRule);

  // 1. Heightfield (h_natural): якорь высоты — каноническая ячейка Patch7 (И-3.2),
  //    детализация — fBm и канал `detail` единого сэмплера (И-3.1), врез русла (И-3.3).
  const cellSeed = (seed ^ Math.imul((patch.centerCell + 1) >>> 0, 0x9E3779B1)) >>> 0;
  const sampler = request.profile ? createPatchFieldSampler(request.profile) : null;
  const detailLattice = sampler ? sampleDetailLattice(patch, sampler, radiusM) : null;
  const riverHalfWidthM = Math.max(cellSize * 2, radiusM * RIVER_HALF_WIDTH_RATIO);
  const riverDepthM = Math.max(6, radiusM * RIVER_DEPTH_RATIO);
  const segments = riverSegments(patch, radiusM, riverHalfWidthM);
  const noiseScale = (3.5 + Math.log2(Math.max(1, radiusM / 600)) * 0.65) / Math.max(radiusM, 1);
  const heightfield = new Float32Array(hfRes * hfRes);
  // Stage-8.5: `terraform_map` заполняется в том же проходе, что и рельеф.
  // Байт 0 ставится ТОЛЬКО на воду/озеро канонической ячейки Patch7, а любая
  // точка суши несёт минимум TERRAFORM_LAND_MIN — ложная вода на пологой суше
  // исключена на всех масштабах участка (10 км … 1250 км).
  const terraformMap = generateTerraformMap();
  let waterPoints = 0;
  let buildablePoints = 0;

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;

      // И-3.1: (u, v) → 3D-направление → ближайшая каноническая ячейка Patch7.
      const cell = nearestPatchCell(patch, localPointToDirection(patch, wx, wy));
      // И-3.2/И-3.4: маска спавна растеризуется на весь patchSpanMeters, а
      // детальный участок при малом radiusM занимает лишь его центр, поэтому
      // локальная точка воды/озера/русла гасит спавн независимо от того, куда
      // попал соответствующий тексель маски (иначе сухие соседи разрешали бы
      // застройку на континентальном озере).
      if (isWaterCell(cell, patch.seaLevel) || cell.streamWeight > 0) spawnMask[idx] = 0;
      if (spawnMask[idx] === 1) buildablePoints++;

      let height: number;
      if (isWaterCell(cell, patch.seaLevel)) {
        // И-3.2: вода/переполняющееся озеро держит зеркало waterLevelOf.
        waterPoints++;
        height = (waterLevelOf(cell, patch.seaLevel) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
        // Stage-8.5: явный водный маркер — байт 0 в `terraform_map`.
        terraformMap[idx] = 0;
      } else {
        // И-3.2: суша надёжно выше канонической высоты ячейки (берег не «ныряет»).
        const anchor = (baseElevationOf(cell) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
        const fbmM = fBm(wx * noiseScale, wy * noiseScale, cellSeed, 6) * LAND_FBM_AMPLITUDE_M;
        const detailM = detailLattice
          ? (sampleDetailAt(detailLattice, x / hfRes, y / hfRes) * 0.5 + 0.5) * PROFILE_DETAIL_AMPLITUDE_M
          : 0;
        height = anchor + fbmM + detailM;
        // И-3.3: плавный врез русла от входных граней к центру и к выходной грани.
        const carve = riverCarveFactor(wx, wy, segments, riverHalfWidthM);
        if (carve > 0) height -= riverDepthM * carve;
        // Stage-8.5: суша всегда отличается от воды (минимум TERRAFORM_LAND_MIN).
        terraformMap[idx] = Math.max(TERRAFORM_LAND_MIN, terraformMap[idx] as number);
      }

      heightfield[idx] = height;
    }
  }

  // 2. Smoothed copy + box blur (площадка терраформинга без «висящего плато»).
  const blurKernel = Math.max(3, Math.min(10, Math.round(radiusM / cellSize * 0.08)));
  const smoothed = boxBlurSeparable(heightfield, hfRes, hfRes, blurKernel);

  // 3. Mix: h_final = mix(h_natural, h_smoothed, terraform_alpha) только там, где
  //    спавн разрешён, — терраформинг базы не засыпает реки и озёра (И-3.2/И-3.3).
  //    Stage-8.5: альфа считается от подложки суши TERRAFORM_LAND_MIN, поэтому
  //    минимальный маркер «это суша» не поднимает рельеф там, где терраформинга
  //    нет (rawTf <= 2 → alpha = 0), а водные тексели (rawTf === 0) остаются
  //    зеркалом waterLevelOf без размывания берега.
  for (let i = 0; i < hfRes * hfRes; i++) {
    if (spawnMask[i] !== 1) continue;
    const rawTf = terraformMap[i] as number;
    const alpha = rawTf <= TERRAFORM_LAND_MIN ? 0 : (rawTf - TERRAFORM_LAND_MIN) / TERRAFORM_ALPHA_SPAN;
    if (alpha <= 0) continue;
    heightfield[i] = (heightfield[i] as number) * (1 - alpha) + (smoothed[i] as number) * alpha;
  }

  // 4. Zone map: вода/озёра/русла остаются без зонирования (И-3.2/И-3.4).
  //    radiusM передаётся, чтобы зонирование учитывало и локальный размах
  //    детального участка, а не только полный patchSpanMeters.
  const zoneMap = applyWaterZoning(generateZoneMap(cellSeed, placeId), patch, radiusM);

  // 5. Scatter (И-3.4: маска запрета спавна отбраковывает воду/озёра/русла/склоны)
  const instances = scatterInstances(zoneMap, heightfield, radiusM, cellSeed, placeId, spawnMask);
  const instanceBuffers = packInstancesByModule(instances);

  // Финальные границы высот после смешивания терраформинга.
  let finalMin = Infinity;
  let finalMax = -Infinity;
  for (let i = 0; i < heightfield.length; i++) {
    const h = heightfield[i] as number;
    if (h < finalMin) finalMin = h;
    if (h > finalMax) finalMax = h;
  }

  const totalPoints = hfRes * hfRes;
  const genMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;
  const response: LocalMapWorkerResponse = {
    heightfield,
    zoneMap,
    terraformMap,
    instanceBuffers,
    meta: {
      radiusM,
      hfRes: HEIGHTFIELD_RES,
      zoneRes: ZONE_RES,
      tfRes: TERRAFORM_RES,
      totalInstances: instances.length,
      buildableFraction: totalPoints > 0 ? buildablePoints / totalPoints : 0,
      waterFraction: totalPoints > 0 ? waterPoints / totalPoints : 0,
      minHeightM: finalMin === Infinity ? 0 : finalMin,
      maxHeightM: finalMax === -Infinity ? 0 : finalMax,
      genMs,
      patchKey: request.patchKey || String(patch.centerCell),
    },
  };

  writeCache(cacheKey, request, response);
  return response;
}

// ---------------------------------------------------------------------------
// Stage-8.2: непрерывная сферическая юбка горизонта вокруг выделенного
// центрального гекса активной ячейки. Единая полярная сетка 145 × 85 без
// 6 отдельных плит-лепестков и без провалов фасок: высоты воротника сшиваются
// с детальным мешем центрального гекса строго по гексагональной метрике
// `clusterHexMetric(x, y)` (бесшовный шестиугольный срез), а весь горизонт
// получает честный радиус кривизны планеты.
//
// Stage-8.2.1 (хотфикс): юбка держит зеркало континентальных озёр выше
// seaLevel (waterLevelOf вместо Math.min(0, ...)), калибрует канал `elevation`
// макро-решётки относительно канонического центра патча и гасит сухопутный
// шум у уреза воды — вместо 253-метровой шестигранной «столовой горы»
// посреди круглого кратера/рва.
// ---------------------------------------------------------------------------

/** Угловых сегментов контура горизонта: 6 секторов × 24 шагов (145 узлов с замыканием). */
export const SKIRT_ANGULAR_SEGMENTS = 144;
/** Радиальных шагов единой полярной сетки горизонта: 24 плотных + 60 до сферы (85 рядов). */
export const SKIRT_RADIAL_RINGS = 84;
/** Радиальных шагов плотного воротника: от R_inner до 1.15 · R_patch (остальные 60 — к горизонту). */
export const SKIRT_COLLAR_RINGS = 24;
/** Число соседних гексов кластера Patch7 (шестиугольное кольцо slot 0..5). */
export const SKIRT_RING_COUNT = 6;
/** √3/2 — отношение апофемы правильного шестиугольника к радиусу описанной окружности. */
export const HEX_APOTHEM_RATIO = 0.8660254037844386;
/** Доля R_patch: радиус описанной окружности выделенного центрального гекса. */
export const CENTER_HEX_RADIUS_RATIO = 0.93;
/** Доля R_patch: внутренний радиус непрерывной юбки (воротник перекрывает центральный гекс). */
export const SKIRT_INNER_RADIUS_RATIO = 0.72;
/** Доля R_patch: внешний радиус плотного воротника вокруг выделенного гекса. */
export const SKIRT_COLLAR_END_RADIUS_RATIO = 1.15;
/** Доля R_patch: шаг центров соседних гексов канонической сетки кластера Patch7. */
export const SKIRT_HEX_SPACING_RATIO = 1.15;
/** Число шагов d_hex от центра юбки до сферического горизонта (R_outer = 10.0 · d_hex). */
export const SKIRT_OUTER_SPACING_RATIO = 10.0;
/** Отношение радиуса планеты к внешнему радиусу юбки (плавная кривизна горизонта). */
export const SKIRT_PLANET_RADIUS_SPACING_RATIO = 3.6;
/** Доля апофемы центрального гекса: начало полосы смешивания высот воротника. */
export const SKIRT_COLLAR_BLEND_START_RATIO = 1.005;
/** Доля апофемы центрального гекса: конец полосы смешивания (срез + 0.345 · A). */
export const SKIRT_COLLAR_BLEND_END_RATIO = 1.35;
/** Доля R_patch: страховочная граница точной выборки heightfield (сетка res × res). */
export const SKIRT_HEIGHTFIELD_GUARD_RATIO = 0.98;
/** Число ячеек канонической сетки Голдберга v = 128: 10v² + 2. */
const GOLDBERG_V128_CELLS = 10 * 128 * 128 + 2;
/** Узлов макро-решётки 3D-сэмплера на сторону (33×33 = 1 089 опросов). */
const SKIRT_LATTICE_STEPS = 32;

/**
 * Единая гексагональная метрика кластера: точное расстояние от центра
 * шестиугольника с плоским верхом/боком до его 6 прямых граней по нормали.
 * Точка лежит внутри шестиугольника с апофемой `apothem` тогда и только
 * тогда, когда `hexMetric2D(x, y) <= apothem`; линии уровня — идеальные
 * правильные шестиугольники (вершины на лучах k·π/3, нормали граней на
 * лучах π/6 + k·π/3).
 */
export function hexMetric2D(x: number, y: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  return Math.max(ax * 0.8660254037844386 + ay * 0.5, ay);
}

/**
 * Метрика кластера Patch7: тот же гекс, повёрнутый так, что нормали его граней
 * смотрят ровно на θ_k = k·π/3 — направления центров 6 соседей. Поворот на 30°
 * для шестиугольника (симметрия 6-го порядка) эквивалентен перестановке осей,
 * поэтому контуры колец считаются через `hexMetric2D(y, x)`.
 *
 * Именно этой метрикой шейдер обрезает центральный меш 257 × 257 по контуру
 * активного гекса, поэтому воротник юбки сшивается с ним по `clusterHexMetric`,
 * а не по евклидову радиусу: `hexDist <= centerApothemM` — внутри гекса.
 */
export function clusterHexMetric(x: number, y: number): number {
  return hexMetric2D(y, x);
}

/**
 * Геометрия непрерывной сферической юбки горизонта вокруг выделенного
 * центрального гекса активной ячейки (единая полярная сетка 145 × 85).
 */
export interface HorizonSkirtData {
  /** (x, y, z) в метрах; сферическое проседание добавляет вершинный шейдер. */
  readonly positions: Float32Array;
  /** Гладкие нормали по конечным разностям полярной сетки (nx, ny, nz), nz > 0. */
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** R_inner = 0.72 · R_patch — внутреннее кольцо непрерывной юбки. */
  readonly innerRadiusM: number;
  /** R_outer = 10.0 · d_hex = 11.5 · R_patch — сферический горизонт юбки. */
  readonly outerRadiusM: number;
  /** R_planet = 3.6 · R_outer — честный радиус кривизны горизонта, м. */
  readonly planetRadiusM: number;
  /** Шаг центров гексов канонической сетки d_hex = 1.15 · R_patch, м. */
  readonly hexSpacingM: number;
  /** Число соседних гексов Patch7 (всегда 6). */
  readonly ringCount: number;
}

/** Шаг центров соседних гексов сетки Голдберга v=128: d_hex ≈ 0.009418 · R_p. */
export function hexSpacingMeters(planetRadiusM: number): number {
  return Math.sqrt(
    (8 * Math.PI * planetRadiusM * planetRadiusM) / (Math.sqrt(3) * GOLDBERG_V128_CELLS),
  );
}

/**
 * Сопоставление 6 гексов кластера (slot 0..5, направление θ_k = k·π/3) реальным
 * соседним ячейкам из `patch.cells.slice(1)` по ближайшему направлению в
 * касательном кадре: (u, v) = (dot(cell.center, east), dot(cell.center, north)).
 * Жадное сопоставление по глобальному минимуму углового расстояния даёт
 * взаимно-однозначное соответствие без дубликатов (6 слотов ↔ 6 ячеек).
 */
export function mapNeighborCellsToSlots(patch: LocalMapPatch): readonly PatchCell[] {
  const neighbors = patch.cells.slice(1);
  const { east, north } = patch.frame;
  const tangentAngle: number[] = [];
  for (const cell of neighbors) {
    const u =
      (cell.center[0] as number) * (east[0] as number)
      + (cell.center[1] as number) * (east[1] as number)
      + (cell.center[2] as number) * (east[2] as number);
    const v =
      (cell.center[0] as number) * (north[0] as number)
      + (cell.center[1] as number) * (north[1] as number)
      + (cell.center[2] as number) * (north[2] as number);
    tangentAngle.push(Math.atan2(v, u));
  }
  const pairs: Array<{ slot: number; cell: number; dist: number }> = [];
  for (let k = 0; k < SKIRT_RING_COUNT; k++) {
    const slotAngle = (k * Math.PI) / 3;
    for (let c = 0; c < neighbors.length; c++) {
      // Модуль с приведением к [0, 2π): разница углов может превысить 2π.
      let dist = Math.abs((tangentAngle[c] as number) - slotAngle) % (2 * Math.PI);
      if (dist > Math.PI) dist = 2 * Math.PI - dist;
      pairs.push({ slot: k, cell: c, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);
  const slotTaken = new Array<boolean>(SKIRT_RING_COUNT).fill(false);
  const cellTaken = new Array<boolean>(neighbors.length).fill(false);
  const result: Array<PatchCell | null> = new Array(SKIRT_RING_COUNT).fill(null);
  for (const pair of pairs) {
    if (slotTaken[pair.slot] || cellTaken[pair.cell]) continue;
    slotTaken[pair.slot] = true;
    cellTaken[pair.cell] = true;
    result[pair.slot] = neighbors[pair.cell] ?? null;
  }
  // Защита от вырожденных патчей (меньше 6 соседей): пустые слоты замыкаются на центр.
  const fallback = (patch.cells[0] ?? neighbors[0]) as PatchCell;
  return result.map((cell) => cell ?? fallback);
}

/**
 * Сферическое проседание касательной плоскости на расстоянии r от центра:
 * Δz_drop = R_p − sqrt(max(0, R_p² − r²)). При R_p ≤ 1 проседание выключено
 * (обратная совместимость с плоской локальной картой).
 */
export function planetCurvatureDropM(planetRadiusM: number, rM: number): number {
  if (!(planetRadiusM > 1)) return 0;
  return planetRadiusM - Math.sqrt(Math.max(0, planetRadiusM * planetRadiusM - rM * rM));
}

function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

function clampScalar(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Билинейная выборка детального heightfield участка (сетка res×res на радиус radiusM). */
function sampleInnerHeightfield(
  heightfield: Float32Array,
  res: number,
  radiusM: number,
  x: number,
  y: number,
): number {
  const cellSize = (2 * radiusM) / res;
  const gx = clampScalar(x / cellSize + res / 2, 0, res - 1.0001);
  const gy = clampScalar(y / cellSize + res / 2, 0, res - 1.0001);
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * res + ix;
  const i10 = i00 + 1;
  const i01 = i00 + res;
  const i11 = i01 + 1;
  const top = (heightfield[i00] as number) * (1 - ax) + (heightfield[i10] as number) * ax;
  const bottom = (heightfield[i01] as number) * (1 - ax) + (heightfield[i11] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Каналы elevation и detail единого 3D-сэмплера в узлах макро-решётки. */
interface SkirtElevationLattice {
  readonly elevation: Float32Array;
  readonly detail: Float32Array;
}

/**
 * Макро-решётка базовой высоты и детализации на квадрате [-R_skirt, +R_skirt].
 * Stage-8.3: узлы решётки опрашиваются в планетарных координатах
 * `(x · planetCoordScale, y · planetCoordScale)`, где `planetCoordScale` —
 * отношение физического шага гексов планеты (`hexSpacingMeters`, ~60 км для
 * Земли v=128) к визуальному шагу юбки (`1.15 · radiusM`). Поэтому решётка
 * 33×33 охватывает реальные 10 колец канонических ячеек вокруг активного
 * гекса при любом `radiusM`, а не крошечный пятачок в центре одной ячейки.
 */
function sampleSkirtElevationLattice(
  patch: LocalMapPatch,
  sampler: FieldSampler,
  extentM: number,
  planetCoordScale = 1,
): SkirtElevationLattice {
  const nodes = SKIRT_LATTICE_STEPS + 1;
  const elevation = new Float32Array(nodes * nodes);
  const detail = new Float32Array(nodes * nodes);
  const scratch = new Float32Array(8);
  for (let j = 0; j < nodes; j++) {
    const y = (j / SKIRT_LATTICE_STEPS - 0.5) * 2 * extentM;
    for (let i = 0; i < nodes; i++) {
      const x = (i / SKIRT_LATTICE_STEPS - 0.5) * 2 * extentM;
      const dir = localPointToDirection(patch, x * planetCoordScale, y * planetCoordScale);
      const fields = sampler.sampleFields(dir[0], dir[1], dir[2], scratch);
      const index = j * nodes + i;
      const detailValue = fields[5] as number;
      elevation[index] = fields[0] as number;
      detail[index] = detailValue < -1 ? -1 : detailValue > 1 ? 1 : detailValue;
    }
  }
  return { elevation, detail };
}

function sampleSkirtLatticeAt(lattice: Float32Array, extentM: number, x: number, y: number): number {
  const nodes = SKIRT_LATTICE_STEPS + 1;
  const gx = clampScalar((x / (2 * extentM) + 0.5) * SKIRT_LATTICE_STEPS, 0, SKIRT_LATTICE_STEPS - 1e-9);
  const gy = clampScalar((y / (2 * extentM) + 0.5) * SKIRT_LATTICE_STEPS, 0, SKIRT_LATTICE_STEPS - 1e-9);
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * nodes + ix;
  const top = (lattice[i00] as number) * (1 - ax) + (lattice[i00 + 1] as number) * ax;
  const bottom = (lattice[i00 + nodes] as number) * (1 - ax) + (lattice[i00 + nodes + 1] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

/** Плавный радиально-угловой якорь Patch7 без границ Вороного и скачков воды. */
function smoothPatchBaseElevation(
  patch: LocalMapPatch,
  neighborSlots: readonly PatchCell[],
  centerCanonElev: number,
  radiusPatchM: number,
  x: number,
  y: number,
  r: number,
): { elevation: number; water: number; waterLevel: number } {
  const center = patch.cells[0] as PatchCell;
  const collarEndM = SKIRT_COLLAR_END_RADIUS_RATIO * radiusPatchM;
  const phi = (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI);
  const slot = phi / (Math.PI / 3);
  const k0 = Math.floor(slot) % SKIRT_RING_COUNT;
  const c0 = neighborSlots[k0] as PatchCell;
  const c1 = neighborSlots[(k0 + 1) % SKIRT_RING_COUNT] as PatchCell;
  const angularBlend = smooth01(slot - Math.floor(slot));
  const neighborBlend = smooth01((r - collarEndM) / (2.4 * radiusPatchM));
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const canon = (cell: PatchCell): number => isWaterCell(cell, patch.seaLevel)
    ? waterLevelOf(cell, patch.seaLevel) : baseElevationOf(cell);
  const centerWater = isWaterCell(center, patch.seaLevel);
  // Озеро гарантированно держит зеркало до 1.8 R, затем водность меняется
  // непрерывно, а не переключается булевым флагом на границе соседней ячейки.
  const waterBlend = centerWater
    ? smooth01((r - 1.8 * radiusPatchM) / (2.4 * radiusPatchM)) : neighborBlend;
  return {
    elevation: mix(centerCanonElev, mix(canon(c0), canon(c1), angularBlend), neighborBlend),
    water: mix(Number(centerWater), mix(Number(isWaterCell(c0, patch.seaLevel)),
      Number(isWaterCell(c1, patch.seaLevel)), angularBlend), waterBlend),
    waterLevel: mix(waterLevelOf(center, patch.seaLevel),
      mix(waterLevelOf(c0, patch.seaLevel), waterLevelOf(c1, patch.seaLevel), angularBlend), waterBlend),
  };
}

/**
 * Планетарная высота точки юбки относительно seaLevel, м. Частота, seed и
 * положительный базовый уровень fBm/detail совпадают с generateLocalMap,
 * поэтому на стыке больше нет ступеньки +60 м. На первых 3–4 кольцах
 * гладкий якорь Patch7 плавно уступает непрерывной макро-решётке, а канал
 * `elevation` решётки калибруется сдвигом `elevCalibration` относительно
 * канонического центра патча (озеро выше seaLevel держит filledElevation).
 */
function skirtPlanetaryHeight(
  patch: LocalMapPatch,
  radiusPatchM: number,
  x: number,
  y: number,
  r: number,
  cellSeed: number,
  noiseScale: number,
  elevLattice: SkirtElevationLattice | null,
  elevCalibration: number,
  outerRadiusM: number,
  planetCoordScale: number,
  neighborSlots: readonly PatchCell[],
  centerCanonElev: number,
): number {
  // Stage-8.4: масштаб и опорная высота разгоняются на первых 3–4 кольцах.
  const collarEndM = SKIRT_COLLAR_END_RADIUS_RATIO * radiusPatchM;
  const coordScale = 1 + (planetCoordScale - 1)
    * smooth01((r - collarEndM) / (3.2 * radiusPatchM));
  const base = smoothPatchBaseElevation(patch, neighborSlots, centerCanonElev, radiusPatchM, x, y, r);
  const distRatio = clampScalar((r - radiusPatchM) / (outerRadiusM - radiusPatchM), 0, 1);
  const fbmNear = fBm(x * noiseScale, y * noiseScale, cellSeed, 5) * LAND_FBM_AMPLITUDE_M;
  const fbmFar = (
    0.5 + (fBm(x * noiseScale * 0.35, y * noiseScale * 0.35, cellSeed, 3) - 0.5) * 0.85
  ) * LAND_FBM_AMPLITUDE_M;
  const fbmM = fbmNear * (1 - distRatio) + fbmFar * distRatio;
  const detailFade = 1 - smooth01(distRatio);
  const detailM = (elevLattice
    ? (sampleSkirtLatticeAt(elevLattice.detail, outerRadiusM, x, y) * 0.5 + 0.5) * PROFILE_DETAIL_AMPLITUDE_M
    : 0.5 * PROFILE_DETAIL_AMPLITUDE_M) * detailFade;

  const water = base.water;
  // И-3.2: зеркало воды в ближней зоне считается ровно той же формулой, что и
  // в generateLocalMap (тождество берега), поэтому континентальное озеро выше
  // seaLevel держит свой уровень и за шестигранным воротником, не проваливаясь
  // к z = 0.
  const waterMirrorM = (base.waterLevel - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;

  // Stage-8.3: гребневые горные хребты только на суше и только за пределами
  // активного гекса (r > collarEndM). Огибающая плавно выводит рельеф из
  // природной долины в предгорья на 2.8 · R_patch и слегка (на 30%) гасит
  // пики к самому горизонту; крупномасштабная маска macroBasin разделяет
  // азимуты на выразительные хребты и открытые межгорные долины/перевалы.
  // На воде горный рельеф строго ноль — зеркало Stage-8.2.1 не трогаем.
  let mountainM = 0;
  if (water < 1 && r > collarEndM) {
    const mountainEnvelope = smooth01((r - collarEndM) / (2.8 * radiusPatchM))
      * (1 - 0.30 * smooth01((r - 6.0 * radiusPatchM) / (outerRadiusM - 6.0 * radiusPatchM)));
    const ridgeVal = ridgedFbm(x * noiseScale * 0.42, y * noiseScale * 0.42, cellSeed ^ 0x5A17C3, 5);
    const macroBasin = valueNoise2D(
      x * noiseScale * 0.14 + 3.7, y * noiseScale * 0.14 - 5.1, cellSeed ^ 0x3391B7,
    );
    const basinMask = smooth01((macroBasin - 0.34) / 0.38);
    const peakAmpM = Math.min(420, Math.max(190, radiusPatchM * 0.32));
    mountainM = peakAmpM * mountainEnvelope * basinMask * Math.pow(ridgeVal, 1.35);
  }

  const landHeight = (base.elevation - patch.seaLevel) * METERS_PER_ELEVATION_UNIT
    + fbmM + detailM + mountainM;
  const nearHeight = waterMirrorM * water + landHeight * (1 - water);
  if (r <= radiusPatchM || !elevLattice) return nearHeight;

  // Калибровка сэмпла макро-решётки относительно центра патча: непрерывное
  // поле elevation продолжает канонический якорь центральной ячейки
  // (waterLevelOf для воды, baseElevationOf для суши), а не абсолютную
  // некалиброванную высоту сэмплера.
  const elev = sampleSkirtLatticeAt(
    elevLattice.elevation, outerRadiusM, x * coordScale / planetCoordScale, y * coordScale / planetCoordScale,
  );
  const calibratedElev = elev + elevCalibration;
  const calibratedM = (calibratedElev - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
  const shoreBlend = smooth01(Math.max(0, calibratedM - waterMirrorM) / 45);
  const waterHeight = Math.max(waterMirrorM, calibratedM) + (fbmM + detailM) * shoreBlend;
  const latticeHeight = waterHeight * water + (calibratedM + fbmM + detailM + mountainM) * (1 - water);
  const latticeBlend = smooth01((r - collarEndM) / (3.4 * radiusPatchM));
  return nearHeight * (1 - latticeBlend) + latticeHeight * latticeBlend;
}

/**
 * Генерация непрерывной сферической юбки горизонта вокруг выделенного
 * центрального гекса активной ячейки (Stage-8.2, вместо кластера из 7 плит):
 *
 * - Единая полярная сетка `(SKIRT_ANGULAR_SEGMENTS + 1) × (SKIRT_RADIAL_RINGS + 1)`
 *   = 145 × 85 = 12 325 вершин и 96 × 56 × 6 = 32 256 индексов: горизонт
 *   непрерывен по всем направлениям, без 6 отдельных плит-лепестков и без
 *   физических провалов фасок `bevelDropM`.
 * - Первые `SKIRT_COLLAR_RINGS = 24` радиальных шагов — плотный воротник от
 *   `R_inner = 0.72 · R_patch` до `1.15 · R_patch`; остальные 60 шагов — от
 *   `1.15 · R_patch` до `R_outer = 10.0 · d_hex = 11.5 · R_patch` по степени
 *   `Math.pow(t, 1.35)` (сгущение линий у выделенного гекса).
 * - Гексагональная сшивка высот воротника: шейдер обрезает центральный меш
 *   257 × 257 строго по контуру `clusterHexMetric(x, y) <= A`, где
 *   `A = centerApothemM = CENTER_HEX_RADIUS_RATIO · HEX_APOTHEM_RATIO · R_patch`.
 *   При `hexDist <= 1.005 · A` высота равна ТОЧНОЙ билинейной выборке
 *   `innerHeightfield` (`blend = 0`) — на всём шестиугольном срезе нет ни
 *   ступеньки, ни щели. На полосе `1.005 · A < hexDist <= 1.20 · A` высота
 *   плавно смешивается через `smooth01` с `skirtPlanetaryHeight`.
 * - Кривизна — `R_planet = 3.6 · R_outer` (проседание касательной плоскости
 *   применяет вершинный шейдер); нормали — гладкие конечные разности полярной
 *   сетки с угловым замыканием `i % SKIRT_ANGULAR_SEGMENTS` и ориентацией `nz > 0`.
 */
export function generateHorizonSkirt(
  request: LocalMapWorkerRequest,
  innerHeightfield?: Float32Array,
): HorizonSkirtData {
  const patch = request.patch;
  const neighborSlots = mapNeighborCellsToSlots(patch);
  const radiusPatchM = request.radiusM;
  // Апофема выделенного центрального гекса: ровно тот контур, по которому шейдер
  // обрезает центральный меш 257 × 257 (hexApothem = 0.8054 · R_patch).
  const centerApothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusPatchM;
  const innerRadiusM = SKIRT_INNER_RADIUS_RATIO * radiusPatchM;
  const hexSpacingM = SKIRT_HEX_SPACING_RATIO * radiusPatchM;
  const outerRadiusM = SKIRT_OUTER_SPACING_RATIO * hexSpacingM;
  const planetRadiusM = SKIRT_PLANET_RADIUS_SPACING_RATIO * outerRadiusM;

  // Stage-8.3: физический шаг центров соседних гексов на глобусе (~60 км для
  // Земли v=128) против визуального шага юбки (690 м при radiusPatchM = 600 м).
  // Коэффициент растяжения касательных координат за пределами воротника:
  // макро-решётка и выбор соседних ячеек видят настоящую планету, а не
  // увеличенный в десятки раз центр одной-единственной ячейки.
  const planetHexSpacingM = hexSpacingMeters(patch.frame.radiusM);
  const planetCoordScale = Math.max(1, planetHexSpacingM / Math.max(hexSpacingM, 1));

  const sampler = request.profile ? createPatchFieldSampler(request.profile) : null;
  const elevLattice = sampler
    ? sampleSkirtElevationLattice(patch, sampler, outerRadiusM, planetCoordScale)
    : null;
  const cellSeed = (request.seed ^ Math.imul((patch.centerCell + 1) >>> 0, 0x9E3779B1)) >>> 0;
  const noiseScale = (3.5 + Math.log2(Math.max(1, radiusPatchM / 600)) * 0.65) / Math.max(radiusPatchM, 1);

  // И-3.2: калибровка канала `elevation` макро-решётки относительно центра
  // патча. Сэмплер c100-soft-v2 отдаёт «сырую» высоту, а канонический центр
  // держит filledElevation (вода) или baseElevationOf (суша); без сдвига
  // юбка уезжала бы от зеркала континентального озера на сотни метров.
  const centerCell = patch.cells[0] as PatchCell;
  const centerCanonElev = isWaterCell(centerCell, patch.seaLevel)
    ? waterLevelOf(centerCell, patch.seaLevel)
    : baseElevationOf(centerCell);
  const rawCenterElev = elevLattice
    ? sampleSkirtLatticeAt(elevLattice.elevation, outerRadiusM, 0, 0)
    : centerCanonElev;
  const elevCalibration = centerCanonElev - rawCenterElev;

  const innerRes = HEIGHTFIELD_RES;
  const hasCollar = !!innerHeightfield && innerHeightfield.length >= innerRes * innerRes;
  const collarHeights = hasCollar ? (innerHeightfield as Float32Array) : null;

  const angularCount = SKIRT_ANGULAR_SEGMENTS + 1;   // 145 узлов с угловым замыканием
  const radialCount = SKIRT_RADIAL_RINGS + 1;        // 85 радиальных рядов
  const vertexCount = angularCount * radialCount;    // 12 325 вершин
  const positions = new Float32Array(vertexCount * 3);

  // Радиусы рядов: 24 плотных шага воротника от R_inner до 1.15 · R_patch,
  // затем 60 шагов к горизонту по степени t^1.35.
  const collarEndM = SKIRT_COLLAR_END_RADIUS_RATIO * radiusPatchM;
  const outerSteps = SKIRT_RADIAL_RINGS - SKIRT_COLLAR_RINGS;
  const ringRadius = new Float64Array(radialCount);
  for (let j = 0; j <= SKIRT_COLLAR_RINGS; j++) {
    ringRadius[j] = innerRadiusM + (collarEndM - innerRadiusM) * (j / SKIRT_COLLAR_RINGS);
  }
  for (let j = SKIRT_COLLAR_RINGS + 1; j < radialCount; j++) {
    const t = (j - SKIRT_COLLAR_RINGS) / outerSteps;
    ringRadius[j] = collarEndM + (outerRadiusM - collarEndM) * Math.pow(t, 1.35);
  }

  const blendStartM = SKIRT_COLLAR_BLEND_START_RATIO * centerApothemM;
  const blendEndM = SKIRT_COLLAR_BLEND_END_RATIO * centerApothemM;
  const blendSpanM = blendEndM - blendStartM;
  const guardM = SKIRT_HEIGHTFIELD_GUARD_RATIO * radiusPatchM;

  for (let j = 0; j < radialCount; j++) {
    const r = ringRadius[j] as number;
    for (let i = 0; i < angularCount; i++) {
      const phi = (i / SKIRT_ANGULAR_SEGMENTS) * Math.PI * 2;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      // Гексагональная метрика кластера: внутри выделенного гекса hexDist <= A.
      const hexDist = clusterHexMetric(x, y);

      let z: number;
      if (collarHeights && hexDist <= blendEndM) {
        // Точная билинейная выборка детального heightfield участка: тот же
        // рельеф, что у обрезанного по гексу центрального меша 257 × 257.
        const innerZ = sampleInnerHeightfield(collarHeights, innerRes, radiusPatchM,
          clampScalar(x, -guardM, guardM), clampScalar(y, -guardM, guardM));
        if (hexDist <= blendStartM) {
          // Шестиугольный срез: высота совпадает 1-в-1 (blend = 0, без ступеньки).
          z = innerZ;
        } else {
          const blend = smooth01((hexDist - blendStartM) / blendSpanM);
          const planetaryZ = skirtPlanetaryHeight(
            patch, radiusPatchM, x, y, r, cellSeed, noiseScale, elevLattice, elevCalibration, outerRadiusM,
            planetCoordScale, neighborSlots, centerCanonElev,
          );
          z = innerZ + (planetaryZ - innerZ) * blend;
        }
      } else {
        z = skirtPlanetaryHeight(
          patch, radiusPatchM, x, y, r, cellSeed, noiseScale, elevLattice, elevCalibration, outerRadiusM,
          planetCoordScale, neighborSlots, centerCanonElev,
        );
      }

      const idx = (j * angularCount + i) * 3;
      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;
    }
  }

  // Индексы непрерывной полярной сетки: (144 × 84) quad'ов = 72 576 индексов.
  // Порядок обхода — CCW из +z (грань вверх), как у плоского меша рельефа.
  const indices = new Uint32Array(SKIRT_ANGULAR_SEGMENTS * SKIRT_RADIAL_RINGS * 6);
  let ptr = 0;
  for (let j = 0; j < SKIRT_RADIAL_RINGS; j++) {
    for (let i = 0; i < SKIRT_ANGULAR_SEGMENTS; i++) {
      const a = j * angularCount + i;
      const b = a + 1;
      const c = (j + 1) * angularCount + i;
      const d = c + 1;
      indices[ptr++] = a; indices[ptr++] = c; indices[ptr++] = b;
      indices[ptr++] = b; indices[ptr++] = c; indices[ptr++] = d;
    }
  }

  // Гладкие нормали по конечным разностям полярной сетки: тангенс вдоль кольца
  // (с угловым замыканием i % SKIRT_ANGULAR_SEGMENTS) и тангенс вдоль радиуса;
  // n = t_angular × t_radial, ориентация — в верхнюю полусферу (nz > 0).
  const normals = new Float32Array(vertexCount * 3);
  const vertexAt = (i: number, j: number): number => (j * angularCount + i) * 3;
  for (let j = 0; j < radialCount; j++) {
    const jPrev = j > 0 ? j - 1 : j;
    const jNext = j < radialCount - 1 ? j + 1 : j;
    for (let i = 0; i < angularCount; i++) {
      const iPrev = (i - 1 + SKIRT_ANGULAR_SEGMENTS) % SKIRT_ANGULAR_SEGMENTS;
      const iNext = (i + 1) % SKIRT_ANGULAR_SEGMENTS;
      const aPrev = vertexAt(iPrev, j);
      const aNext = vertexAt(iNext, j);
      const rPrev = vertexAt(i, jPrev);
      const rNext = vertexAt(i, jNext);
      const tax = (positions[aNext] as number) - (positions[aPrev] as number);
      const tay = (positions[aNext + 1] as number) - (positions[aPrev + 1] as number);
      const taz = (positions[aNext + 2] as number) - (positions[aPrev + 2] as number);
      const trx = (positions[rNext] as number) - (positions[rPrev] as number);
      const tryy = (positions[rNext + 1] as number) - (positions[rPrev + 1] as number);
      const trz = (positions[rNext + 2] as number) - (positions[rPrev + 2] as number);

      let nx = tay * trz - taz * tryy;
      let ny = taz * trx - tax * trz;
      let nz = tax * tryy - tay * trx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-9) {
        nx /= len;
        ny /= len;
        nz /= len;
      } else {
        nx = 0; ny = 0; nz = 1;
      }
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }

      const idx = vertexAt(i, j);
      normals[idx] = nx;
      normals[idx + 1] = ny;
      normals[idx + 2] = nz;
    }
  }

  return {
    positions,
    normals,
    indices,
    innerRadiusM,
    outerRadiusM,
    planetRadiusM,
    hexSpacingM,
    ringCount: SKIRT_RING_COUNT,
  };
}

export function localMapTransferables(response: LocalMapWorkerResponse): Transferable[] {
  const transferables: Transferable[] = [
    response.heightfield.buffer as ArrayBuffer,
    response.zoneMap.buffer as ArrayBuffer,
    response.terraformMap.buffer as ArrayBuffer,
  ];
  for (const pack of Object.values(response.instanceBuffers)) {
    if (pack) transferables.push(pack.buffer.buffer as ArrayBuffer);
  }
  return transferables;
}

// Регистрация обработчика — только при подключении файла как dedicated worker.
interface WorkerScopeLike {
  onmessage: ((event: MessageEvent<LocalMapWorkerRequest>) => void) | null;
  postMessage(message: LocalMapWorkerResponse, transfer?: Transferable[]): void;
  importScripts?: unknown;
}
const workerScope = globalThis as unknown as Partial<WorkerScopeLike> & { importScripts?: unknown };
if (typeof workerScope.postMessage === 'function' && typeof workerScope.importScripts === 'function') {
  workerScope.onmessage = (event: MessageEvent<LocalMapWorkerRequest>): void => {
    const response = generateLocalMap(event.data);
    (workerScope.postMessage as WorkerScopeLike['postMessage'])(response, localMapTransferables(response));
  };
}
