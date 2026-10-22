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
  // Простейшая радиальная зонация: ядро → пром → жилой → периметр → пустошь
  const map = new Uint8Array(ZONE_RES * ZONE_RES * 2); // RG
  const cx = ZONE_RES / 2, cy = ZONE_RES / 2;
  const maxR = ZONE_RES / 2;
  const baseSeed = seed ^ (placeId * 48611);

  for (let y = 0; y < ZONE_RES; y++) {
    for (let x = 0; x < ZONE_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / maxR;  // 0..1+
      const noise = hashFloat(x, y, baseSeed) * 0.15;    // jitter зон

      let zone: number, density: number;
      const d = dist + noise;

      if (d > 0.95) {
        zone = 0; density = 0;                            // Пустошь
      } else if (d > 0.70) {
        zone = 3; density = Math.floor((1 - d) * 400);    // Периметр
      } else if (d > 0.35) {
        zone = 1; density = Math.floor((1 - d) * 300);    // Лёгкая застройка
      } else if (d > 0.12) {
        zone = 2; density = Math.floor((1 - d) * 350);    // Пром
      } else {
        zone = 4; density = Math.floor(200 + hashFloat(x, y, baseSeed + 1) * 55); // Ядро
      }

      const idx = (y * ZONE_RES + x) * 2;
      map[idx] = zone;
      map[idx + 1] = Math.min(255, Math.max(0, density));
    }
  }
  return map;
}

export function generateTerraformMap(): Uint8Array {
  // Gaussian falloff от центра
  const map = new Uint8Array(TERRAFORM_RES * TERRAFORM_RES);
  const cx = TERRAFORM_RES / 2, cy = TERRAFORM_RES / 2;
  const sigma = TERRAFORM_RES * 0.3;

  for (let y = 0; y < TERRAFORM_RES; y++) {
    for (let x = 0; x < TERRAFORM_RES; x++) {
      const dx = x - cx, dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const alpha = Math.exp(-r2 / (2 * sigma * sigma));
      map[y * TERRAFORM_RES + x] = Math.floor(alpha * 255);
    }
  }
  return map;
}

/**
 * И-3.2/И-3.4: вода, озёра и русла не получают зонирования. Тексели `zone_map`,
 * попавшие в водные канонические ячейки Patch7, переводятся в зону 0 (пустошь)
 * с нулевой плотностью — шейдер рельефа по `zone == 0u` и глубине ниже
 * `seaLevel` плавно тонирует их водно-бирюзовым оттенком, а `scatterInstances`
 * не ставит над ними ни одного здания.
 */
export function applyWaterZoning(zoneMap: Uint8Array, patch: LocalMapPatch): Uint8Array {
  const zRes = ZONE_RES;
  const span = patchSpanMeters(patch);
  for (let zy = 0; zy < zRes; zy++) {
    const v = ((zy + 0.5) / zRes - 0.5) * span;
    for (let zx = 0; zx < zRes; zx++) {
      const u = ((zx + 0.5) / zRes - 0.5) * span;
      const cell = nearestPatchCell(patch, localPointToDirection(patch, u, v));
      if (!isWaterCell(cell, patch.seaLevel) && cell.streamWeight <= 0) continue;
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

      // Scale
      const sRoll = hashFloat(gx + 4, gy + 4, baseSeed + 13);
      const hRoll = hashFloat(gx + 5, gy + 5, baseSeed + 17);
      const sx = lerp(mod.scale[0], mod.scale[1], sRoll);
      const sy = sx;  // квадратный footprint (или отдельный roll для sy)
      const sz = lerp(mod.hScale[0], mod.hScale[1], hRoll);

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
  const sampler = request.profile ? createPatchFieldSampler(request.profile) : null;
  const detailLattice = sampler ? sampleDetailLattice(patch, sampler, radiusM) : null;
  const riverHalfWidthM = Math.max(cellSize * 2, radiusM * RIVER_HALF_WIDTH_RATIO);
  const riverDepthM = Math.max(6, radiusM * RIVER_DEPTH_RATIO);
  const segments = riverSegments(patch, radiusM, riverHalfWidthM);
  const noiseScale = 1 / Math.max(radiusM, 1);
  const heightfield = new Float32Array(hfRes * hfRes);
  let waterPoints = 0;
  let buildablePoints = 0;

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;

      // И-3.1: (u, v) → 3D-направление → ближайшая каноническая ячейка Patch7.
      const cell = nearestPatchCell(patch, localPointToDirection(patch, wx, wy));
      if (spawnMask[idx] === 1) buildablePoints++;

      let height: number;
      if (isWaterCell(cell, patch.seaLevel)) {
        // И-3.2: вода/переполняющееся озеро держит зеркало waterLevelOf.
        waterPoints++;
        height = (waterLevelOf(cell, patch.seaLevel) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
      } else {
        // И-3.2: суша надёжно выше канонической высоты ячейки (берег не «ныряет»).
        const anchor = (baseElevationOf(cell) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
        const fbmM = fBm(wx * noiseScale, wy * noiseScale, seed, 6) * LAND_FBM_AMPLITUDE_M;
        const detailM = detailLattice
          ? (sampleDetailAt(detailLattice, x / hfRes, y / hfRes) * 0.5 + 0.5) * PROFILE_DETAIL_AMPLITUDE_M
          : 0;
        height = anchor + fbmM + detailM;
        // И-3.3: плавный врез русла от входных граней к центру и к выходной грани.
        const carve = riverCarveFactor(wx, wy, segments, riverHalfWidthM);
        if (carve > 0) height -= riverDepthM * carve;
      }

      heightfield[idx] = height;
    }
  }

  // 2. Smoothed copy + box blur (площадка терраформинга без «висящего плато»).
  const blurKernel = Math.max(4, Math.min(32, Math.round(radiusM / cellSize * 0.3)));
  const smoothed = boxBlurSeparable(heightfield, hfRes, hfRes, blurKernel);

  // 3. Terraform mask
  const terraformMap = generateTerraformMap();

  // 4. Mix: h_final = mix(h_natural, h_smoothed, terraform_alpha) только там, где
  //    спавн разрешён, — терраформинг базы не засыпает реки и озёра (И-3.2/И-3.3).
  for (let i = 0; i < hfRes * hfRes; i++) {
    if (spawnMask[i] !== 1) continue;
    const alpha = (terraformMap[i] as number) / 255;
    heightfield[i] = (heightfield[i] as number) * (1 - alpha) + (smoothed[i] as number) * alpha;
  }

  // 5. Zone map: вода/озёра/русла остаются без зонирования (И-3.2/И-3.4).
  const zoneMap = applyWaterZoning(generateZoneMap(seed, placeId), patch);

  // 6. Scatter (И-3.4: маска запрета спавна отбраковывает воду/озёра/русла/склоны)
  const instances = scatterInstances(zoneMap, heightfield, radiusM, seed, placeId, spawnMask);
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
