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

import { buildBuildingSpawnMask, verifyPatchInvariants } from './local-map-contract.ts';
import type { BuildingSpawnRule, LocalMapPatch } from './local-map-contract.ts';
import type { MeshModuleId } from './local-map-mesh.ts';

// ---- Константы контракта ----
export const HEIGHTFIELD_RES = 256;
export const ZONE_RES = 64;
export const TERRAFORM_RES = 256;
export const MAX_INSTANCES = 4096;

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
  // 2D → uint32
  return pcgHash(pcgHash(ix + seed * 198491317) ^ (iy * 6542989));
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

// ---- Main Entry Point ----
export function generateLocalMap(request: LocalMapWorkerRequest): LocalMapWorkerResponse {
  const { patch, seed, placeId, radiusM } = request;
  const hfRes = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;

  // И-3: вход воркера — только валидный канонический срез 7 ячеек глобуса.
  const report = verifyPatchInvariants(patch);
  if (!report.ok) {
    throw new Error('LocalMapWorker: патч 7 ячеек нарушил инварианты И-3: ' + JSON.stringify(report.checks));
  }

  // 1. Heightfield (h_natural)
  const heightfield = new Float32Array(hfRes * hfRes);
  const noiseScale = 0.01;   // подбирается под масштаб планеты
  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;
      heightfield[y * hfRes + x] = fBm(wx * noiseScale, wy * noiseScale, seed, 6) * 80;
      // 80 = макс. перепад высот в метрах
    }
  }

  // 2. Smoothed copy + box blur
  const blurKernel = Math.max(4, Math.min(32, Math.round(radiusM / cellSize * 0.3)));
  const smoothed = boxBlurSeparable(heightfield, hfRes, hfRes, blurKernel);

  // 3. Terraform mask
  const terraformMap = generateTerraformMap();

  // 4. Mix: h_final = mix(h_natural, h_smoothed, terraform_alpha)
  for (let i = 0; i < hfRes * hfRes; i++) {
    const alpha = (terraformMap[i] as number) / 255;
    heightfield[i] = (heightfield[i] as number) * (1 - alpha) + (smoothed[i] as number) * alpha;
  }

  // 5. Zone map
  const zoneMap = generateZoneMap(seed, placeId);

  // 6. Scatter (И-3.4: маска запрета спавна отбраковывает воду/озёра/русла/склоны)
  const spawnMask = buildBuildingSpawnMask(patch, hfRes, request.spawnRule);
  const instances = scatterInstances(zoneMap, heightfield, radiusM, seed, placeId, spawnMask);
  const instanceBuffers = packInstancesByModule(instances);

  return {
    heightfield,
    zoneMap,
    terraformMap,
    instanceBuffers,
    meta: { radiusM, hfRes: HEIGHTFIELD_RES, zoneRes: ZONE_RES, tfRes: TERRAFORM_RES },
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
