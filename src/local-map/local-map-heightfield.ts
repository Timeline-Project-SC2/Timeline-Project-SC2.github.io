/* LocalMap heightfield — базовый рельеф локальной карты (Stage-8.12d, распил local-map-worker.ts).
   Модуль 1 из трёх: здесь fBm и канал detail (И-3.1), якорь Patch7 (И-3.2),
   гладкая интерполяция Patch7 (Stage-8.5), батиметрия океана (A-29), кольца
   соседних гексов (A-17) и терраформинг. Врез русла — local-map-rivers.ts;
   оркестрация — local-map-worker.ts. Формулы и порядок операций не меняются. */

import {
  baseElevationOf,
  isWaterCell,
  localPointToDirection,
  nearestPatchCell,
  samplePatchFields,
  waterLevelOf,
} from './local-map-contract.ts';
import type { LocalMapPatch, PatchCell, Vec3 } from './local-map-contract.ts';
import type { FieldSampler } from '../../site/shared/planet-geography.ts';
import { SKIRT_RING_COUNT, mapNeighborCellsToSlots } from './local-map-geometry.ts';

// ---- Константы рельефа и терраформинга ----
// ---- Константы контракта ----
export const HEIGHTFIELD_RES = 256;

export const TERRAFORM_RES = 256;

/** Метры рельефа на единицу канонической высоты c100-soft-v2 (И-3.2). */
export const METERS_PER_ELEVATION_UNIT = 900;

/** Амплитуда локального fBm-рельефа на суше, м. */
export const LAND_FBM_AMPLITUDE_M = 80;

/** Амплитуда канала `detail` единого 3D-сэмплера, м (И-3.1). */
export const PROFILE_DETAIL_AMPLITUDE_M = 40;

/** Узлов решётки кэширования канала `detail` на сторону (65×65 опросов). */
export const DETAIL_LATTICE_STEPS = 64;

/**
 * Stage-8.5: радиальная доля `radiusM` — ядро активного гекса, внутри которого
 * вес центральной ячейки Patch7 равен 1.0, а соседние ячейки ещё не подмешаны.
 */
export const LOCAL_HEX_CORE_RADIUS_RATIO = 0.85;

/**
 * Stage-8.5: доли настоящей границы Вороного центральной ячейки Patch7 для
 * ПОДЪЁМА к более высокому угловому слоту. Плавный вывод высоты начинается в
 * `0.62` и завершается в `1.02` от расстояния до границы по лучу, поэтому
 * макро-подъём между ячейками проходится плавно ДО границы, а не скачком на ней.
 */
export const LOCAL_PATCH_RAMP_START_RATIO = 0.62;

export const LOCAL_PATCH_RAMP_END_RATIO = 1.02;

/**
 * Stage-8.5: доли границы Вороного для СПУСКА к более низкому угловому слоту.
 * Спуск начинается ровно на границе (`1.0`) и заканчивается у центра соседней
 * ячейки (`1.85`): инвариант И-3.2 («суша не ныряет ниже канонической высоты
 * своей ячейки») запрещает опускаться до границы, поэтому склон уходит вниз
 * уже на территории низкой ячейки — обрыва на самой границе нет.
 */
export const LOCAL_PATCH_FALL_START_RATIO = 1.0;

export const LOCAL_PATCH_FALL_END_RATIO = 1.85;

/**
 * Stage-8.5: явный водный маркер `terraform_map`. Байт `0` означает
 * «вода/озеро канонической ячейки Patch7», а любая точка суши несёт минимум
 * `TERRAFORM_LAND_MIN = 2` — даже там, где терраформинга нет вовсе. Байт `1`
 * означает водный стрежень реки над/около seaLevel, поэтому потребитель карты
 * (шейдер рельефа) отличает сушу, реку и зеркало без эвристики по высоте,
 * а не по совпадению «нулевой альфы» с нулевой высотой.
 */
export const TERRAFORM_LAND_MIN = 2;

/** Stage-8.5: знаменатель альфы терраформинга — `255 − TERRAFORM_LAND_MIN`. */
export const TERRAFORM_ALPHA_SPAN = 253;

// ---- Stage-8.7: кольца соседних областей вокруг активного гекса ----
/** Уровень кольца вокруг канонического центра Patch7 (1 — ближайшие 6 соседей). */
export type RingLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Stage-8.7: ячейка кольца вокруг активного гекса. Воркер 2 читает
 * `heightfield`/`waterMask` как готовые буферы и не пересчитывает высоты.
 * `offsetM` — смещение центра ячейки в метрах в касательной плоскости участка
 * (x, y), совместимое с координатами основного heightfield.
 */
export interface LocalMapRingCell {
  /**
   * Детерминированный синтетический индекс отрисовки (порядок обхода колец).
   * НЕ канонический `cell` сетки Голдберга: кольца 2..5 строятся как плоская
   * гексагональная решётка в касательной плоскости вокруг Patch7. Для перехода
   * между гексами используйте `activePatchReady.patch.cells[1..6]` (канон).
   */
  readonly cell: number;
  readonly ring: RingLevel;
  /** 3D-центр ячейки на единичной сфере. */
  readonly center: readonly [number, number, number];
  /**
   * Видимое смещение центра в сжатой касательной плоскости, м. Канонический
   * `center` остаётся физическим направлением семплирования на сфере.
   */
  readonly offsetM: readonly [number, number];
  /** Разрешение heightfield ячейки (RING_HF_RES[ring]). */
  readonly hfRes: number;
  /** Heightfield ячейки кольца, м относительно seaLevel. */
  readonly heightfield: Float32Array;
  /** 1 — точка ниже уровня воды ячейки (море), 0 — суша. */
  readonly waterMask: Uint8Array;
  readonly minHeightM: number;
  readonly maxHeightM: number;
}

/** Максимальный уровень кольца (1..5). */
export const RING_LEVELS = 5;

/**
 * Разрешение heightfield по кольцам: [центр, 1..5]. Кольцо 1 — 64×64,
 * кольцо 5 — 4×4; разрешение падает с ростом кольца (экспоненциальный LOD
 * §15.1 матрицы оркестрации). Значения обязаны совпадать с зеркальным
 * контрактом рендерера `RING_HF_RES` в `src/local-map/local-map-renderer.ts`,
 * иначе ячейки отбрасываются как выходящие за предел слота.
 */
export const RING_HF_RES: readonly number[] = Object.freeze([256, 64, 32, 16, 8, 4]);

/** Максимум ячеек колец 1..5: центр + 6 + 12 + 18 + 24 + 30 = 91. */
export const MAX_RING_CELLS = 91;

/** √3/2 — отношение апофемы правильного шестиугольника к радиусу описанной окружности. */
export const HEX_APOTHEM_RATIO = 0.8660254037844386;

/** Доля R_patch: радиус описанной окружности выделенного центрального гекса. */
export const CENTER_HEX_RADIUS_RATIO = 0.93;

/** Доля R_patch: шаг центров соседних гексов канонической сетки кластера Patch7. */
export const SKIRT_HEX_SPACING_RATIO = 1.15;

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

export function hashFloat(ix: number, iy: number, seed: number): number {
  // 2D → [0, 1)
  return (hash2(ix, iy, seed) >>> 0) / 4294967296;
}

export function hashFloat2(ix: number, iy: number, seed: number): [number, number] {
  // Два независимых [0,1)
  const h1 = hashFloat(ix, iy, seed);
  const h2 = hashFloat(ix, iy, seed ^ 0x9E3779B9);
  return [h1, h2];
}

// ---- fBm (value noise с хешем, 6 октав) ----
// Для краткости — простой value noise. В продакшене заменить на Simplex.
export function valueNoise2D(x: number, y: number, seed: number): number {
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

export function fBm(x: number, y: number, seed: number, octaves = 6, lacunarity = 2.0, gain = 0.5): number {
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

interface Tangent2D { readonly u: number; readonly v: number; }

/** Обратная exp-карта: центр канонической ячейки → (u, v) касательной плоскости, м. */
export function cellTangentMeters(patch: LocalMapPatch, cell: PatchCell): Tangent2D {
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

// ---- Stage-8.7: обход колец вокруг активного гекса (гекс-решётка) ----
/**
 *hex-расстояние по осям (q, r): half-grid metric (|q| + |r| + |q + r|) / 2.
 * Кольцо L — ячейки ровно на расстоянии L от центра (6L ячеек).
 */
function hexDistance(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

/**
 * Stage-8.7: канонические осевые координаты (q, r) кольца L — все ячейки на
 * hex-расстоянии L от центра. Кольцо 1 — 6 соседей, кольцо 2 — 12, кольцо 5 —
 * 30 (в сумме 90 ячеек + центр = MAX_RING_CELLS). Порядок детерминированный.
 */
function hexRingAxial(ring: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  const bound = 2 * ring;
  for (let q = -bound; q <= bound; q++) {
    for (let r = -bound; r <= bound; r++) {
      if (hexDistance(q, r) === ring) result.push([q, r]);
    }
  }
  return result;
}

/**
 * Stage-8.7: билинейная интерполяция решётки L×L в сетку res×res.
 */
function bilinearLattice(lat: Float32Array, latSteps: number, fx: number, fy: number): number {
  const x = Math.min(latSteps - 1.0001, Math.max(0, fx));
  const y = Math.min(latSteps - 1.0001, Math.max(0, fy));
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ax = x - ix;
  const ay = y - iy;
  const i00 = iy * latSteps + ix;
  const i10 = i00 + 1;
  const i01 = i00 + latSteps;
  const i11 = i01 + 1;
  const top = (lat[i00] as number) * (1 - ax) + (lat[i10] as number) * ax;
  const bottom = (lat[i01] as number) * (1 - ax) + (lat[i11] as number) * ax;
  return top * (1 - ay) + bottom * ay;
}

/**
 * Stage-8.7: heightfield одной ячейки кольца через единый 3D-сэмплер Patch7.
 * Решётка L×L (L = max(2, res/4)) опрашивает сэмплер, а сетка res×res
 * получается билинейной интерполяцией — тот же паттерн, что у детального
 * решёточного канала центра (sampleDetailLattice), без новых формул рельефа.
 * waterMask = 1 там, где высота ниже уровня воды ячейки (море, seaLevel);
 * русла рек в кольцах за пределами Patch7 не детектируются — патч несёт
 * топологию рек только для кольца 0..1, а детальный центр уже вырезает русла.
 */
function buildRingCellHeightfield(
  patch: LocalMapPatch,
  sampler: FieldSampler,
  offsetX: number,
  offsetY: number,
  res: number,
  span: number,
  seaLevel: number,
  scratch: Float32Array,
): { heightfield: Float32Array; waterMask: Uint8Array } {
  const latSteps = Math.max(2, Math.min(res, Math.round(res / 5)));
  const lat = new Float32Array(latSteps * latSteps);
  for (let j = 0; j < latSteps; j++) {
    const wy = offsetY + (j / (latSteps - 1) - 0.5) * span;
    for (let i = 0; i < latSteps; i++) {
      const wx = offsetX + (i / (latSteps - 1) - 0.5) * span;
      const dir = localPointToDirection(patch, wx, wy);
      const fields = sampler.sampleFields(dir[0], dir[1], dir[2], scratch);
      lat[j * latSteps + i] = (fields[0] as number - seaLevel) * METERS_PER_ELEVATION_UNIT;
    }
  }
  const heightfield = new Float32Array(res * res);
  const waterMask = new Uint8Array(res * res);
  const cellSize = span / res;
  for (let y = 0; y < res; y++) {
    const wy = offsetY + (y - res / 2) * cellSize;
    const fy = ((wy - (offsetY - span / 2)) / span) * (latSteps - 1);
    for (let x = 0; x < res; x++) {
      const wx = offsetX + (x - res / 2) * cellSize;
      const fx = ((wx - (offsetX - span / 2)) / span) * (latSteps - 1);
      const idx = y * res + x;
      const h = bilinearLattice(lat, latSteps, fx, fy);
      heightfield[idx] = h;
      waterMask[idx] = h < 0 ? 1 : 0;
    }
  }
  return { heightfield, waterMask };
}

/**
 * Stage-8.7: обход колец 1..neighborRings от канонического центра Patch7.
 * Кольцо 1 — реальные 6 соседей Patch7 (точные центры и смещения). Кольца 2..5 —
 * плоская гексагональная решётка в касательной плоскости: 6 соседей сортируются
 * по азимуту, два смежных (N0, N1) служат базисом, ячейка кольца L в осевых
 * координатах (q, r) лежит в q·N0 + r·N1. Порядок внутри кольца — по азимуту.
 */
export function buildNeighborRingCells(
  patch: LocalMapPatch,
  sampler: FieldSampler,
  neighborRings: number,
  seaLevel: number,
  radiusPatchM: number,
): LocalMapRingCell[] {
  const normAngle = (a: number): number => (a + 2 * Math.PI) % (2 * Math.PI);
  const sorted: Array<{ cell: PatchCell; off: Tangent2D; angle: number }> = [];
  for (let k = 0; k < SKIRT_RING_COUNT; k++) {
    const cell = patch.cells[k + 1] as PatchCell;
    const off = cellTangentMeters(patch, cell);
    sorted.push({ cell, off, angle: Math.atan2(off.v, off.u) });
  }
  sorted.sort((a, b) => normAngle(a.angle) - normAngle(b.angle));
  const n0 = sorted[0] as { off: Tangent2D };
  const n1 = sorted[1] as { off: Tangent2D };
  const dHex = Math.hypot(n0.off.u, n0.off.v);   // физическое расстояние до соседа кольца 1
  // A-17: heightfield колец по-прежнему семплируется в физических координатах
  // планеты, но GPU-позиции используют тот же сжатый шаг, что юбка горизонта.
  // Раньше offsetM оставался физическим (~60 км), тогда как юбка ставила тот
  // же соседний центр на 2.875 км: две поверхности описывали разные места.
  const visualHexSpacingM = SKIRT_HEX_SPACING_RATIO * radiusPatchM;
  const visualScale = visualHexSpacingM / Math.max(1, dHex);
  const scratch = new Float32Array(8);
  const ringCells: LocalMapRingCell[] = [];
  let cellIndex = 0;
  for (let ring = 1; ring <= neighborRings; ring++) {
    const hfRes = RING_HF_RES[ring] as number;
    const entries: Array<{ x: number; y: number; center?: Vec3 }> = [];
    if (ring === 1) {
      for (const item of sorted) {
        entries.push({ x: item.off.u, y: item.off.v, center: item.cell.center });
      }
    } else {
      for (const [q, r] of hexRingAxial(ring)) {
        entries.push({ x: q * n0.off.u + r * n1.off.u, y: q * n0.off.v + r * n1.off.v });
      }
      entries.sort((a, b) => {
        const angA = normAngle(Math.atan2(a.y, a.x));
        const angB = normAngle(Math.atan2(b.y, b.x));
        if (angA !== angB) return angA - angB;
        return Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y);
      });
    }
    for (const entry of entries) {
      const center = entry.center ?? localPointToDirection(patch, entry.x, entry.y);
      const built = buildRingCellHeightfield(
        patch, sampler, entry.x, entry.y, hfRes, dHex, seaLevel, scratch,
      );
      let minH = Infinity;
      let maxH = -Infinity;
      for (let i = 0; i < built.heightfield.length; i++) {
        const h = built.heightfield[i] as number;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
      const entryScale = ring === 1
        ? visualHexSpacingM / Math.max(1, Math.hypot(entry.x, entry.y))
        : visualScale;
      ringCells.push({
        cell: cellIndex++,
        ring: ring as RingLevel,
        center,
        offsetM: [entry.x * entryScale, entry.y * entryScale],
        hfRes,
        heightfield: built.heightfield,
        waterMask: built.waterMask,
        minHeightM: minH === Infinity ? 0 : minH,
        maxHeightM: maxH === -Infinity ? 0 : maxH,
      });
    }
  }
  return ringCells;
}

/**
 * Канал `detail` единого 3D-сэмплера (И-3.1) на решётке 65×65 узлов с
 * билинейной интерполяцией: 4 225 опросов вместо 65 536 держат гейт G4
 * (генерация <= 150 мс) при сохранении непрерывности поля (И-3.1).
 */
export interface LocalFieldLattice {
  readonly elevation: Float32Array;
  readonly detail: Float32Array;
}

export function sampleDetailLattice(
  patch: LocalMapPatch, sampler: FieldSampler, radiusM: number,
): LocalFieldLattice {
  const nodes = DETAIL_LATTICE_STEPS + 1;
  const elevation = new Float32Array(nodes * nodes);
  const detailLattice = new Float32Array(nodes * nodes);
  const scratch = new Float32Array(8);
  for (let j = 0; j < nodes; j++) {
    const v = ((j / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
    for (let i = 0; i < nodes; i++) {
      const u = ((i / DETAIL_LATTICE_STEPS) - 0.5) * 2 * radiusM;
      const fields = samplePatchFields(patch, sampler, u, v, scratch);
      const index = j * nodes + i;
      const detail = fields[5] as number;
      elevation[index] = fields[0] as number;
      detailLattice[index] = detail < -1 ? -1 : detail > 1 ? 1 : detail;
    }
  }
  return { elevation, detail: detailLattice };
}

export function sampleDetailAt(lattice: Float32Array, tx: number, ty: number): number {
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

/**
 * Контекст гладкой выборки Patch7: канонические высоты центральной ячейки и
 * 6 угловых слотов (`mapNeighborCellsToSlots`), визуальные границы
 * интерполяции и таблица реальной границы Вороного центральной ячейки по
 * азимуту. Строится один раз на участок: 65 536 точек сетки не должны
 * повторно вызывать `cellTangentMeters` (гейт G4 — генерация <= 150 мс).
 */
interface SmoothPatchContext {
  /** Каноническая высота центральной ячейки, м относительно seaLevel. */
  readonly centerM: number;
  /** Радиус, до которого вес центральной ячейки равен 1.0 (0.85 · radiusM), м. */
  readonly coreRadiusM: number;
  /**
   * Бюджет локального рельефа (`LAND_FBM_AMPLITUDE_M` + `PROFILE_DETAIL_AMPLITUDE_M`
   * при переданном профиле), м: им ограничен ВИЗУАЛЬНЫЙ вывод высоты к углам
   * квадрата, чтобы инвариант И-3.2 (`anchor <= height <= anchor + бюджет`)
   * держался на участках, целиком лежащих внутри одной канонической ячейки.
   */
  readonly reliefBudgetM: number;
  /** Радиус полного доверия угловым слотам (√2 · radiusM — угол квадрата), м. */
  readonly edgeRadiusM: number;
  /**
   * Расстояние до настоящей границы Вороного центральной ячейки по азимуту
   * (720 отсчётов по 0.5°), м: половина расстояния до центра соседней ячейки,
   * приведённая к лучу. Пустой массив — вырожденный патч без соседей.
   */
  readonly voronoiBoundaryM: Float64Array;
  /**
   * Каноническая высота угловых слотов Patch7 по азимуту (те же 720 отсчётов),
   * м: сектора НАСТОЯЩЕЙ диаграммы Вороного с асимметричными smoothstep-
   * переходами через их границы (см. `buildSlotHeightTable`).
   */
  readonly slotHeightM: Float64Array;
  /** Канонические высоты всех 7 ячеек Patch7, м относительно seaLevel. */
  readonly cellHeightsM: readonly number[];
  /** Координаты центров тех же ячеек в касательной плоскости, м. */
  readonly cellU: readonly number[];
  readonly cellV: readonly number[];
  /** Радиус «плато» ячейки (вписанная окружность Вороного), м. */
  readonly plateauRadiusM: number;
  /** Естественный предел макро-уклона между ячейками, м/м. */
  readonly slopeLimit: number;
}

/** Отсчётов таблицы границы Вороного по азимуту (шаг 0.5°). */
const VORONOI_ANGLE_STEPS = 720;

/**
 * Stage-8.5: подготовка гладкой интерполяции Patch7 для участка `radiusM`.
 *
 * Ядро активного гекса (`LOCAL_HEX_CORE_RADIUS_RATIO · radiusM`) держит вес
 * центральной ячейки 1.0, а к углам квадрата `[-radiusM, +radiusM]` высота
 * плавно выводится к угловым слотам. Если участок крупнее реального шага
 * ячеек планеты (масштабы 625…1250 км, где `radiusM` переходит границу
 * Вороного центральной ячейки), радиусы интерполяции привязываются к этой
 * настоящей границе по азимуту: макро-склон между ячейками проходится плавно
 * ДО границы, а не скачком на ней, и рельеф остаётся честным продолжением
 * географии планеты, а не одной ячейкой, растянутой на всю карту.
 */
function buildSmoothPatchContext(
  patch: LocalMapPatch,
  radiusM: number,
  reliefBudgetM: number,
): SmoothPatchContext {
  const neighborSlots = mapNeighborCellsToSlots(patch);
  const canonM = (cell: PatchCell): number => (
    (isWaterCell(cell, patch.seaLevel)
      ? waterLevelOf(cell, patch.seaLevel)
      : baseElevationOf(cell)) - patch.seaLevel
  ) * METERS_PER_ELEVATION_UNIT;
  const center = patch.cells[0] as PatchCell;
  const slotAngles: number[] = [];
  const slotHalfDistancesM: number[] = [];
  for (const slotCell of neighborSlots) {
    const tangent = cellTangentMeters(patch, slotCell);
    const distance = Math.hypot(tangent.u, tangent.v);
    slotAngles.push(Math.atan2(tangent.v, tangent.u));
    slotHalfDistancesM.push(distance * 0.5);
  }
  // Все 7 ячеек Patch7 в касательной плоскости: по ним строится непрерывное
  // поле «максимума конусов» (см. smoothPatchPlanetField).
  const cellHeightsM: number[] = [];
  const cellU: number[] = [];
  const cellV: number[] = [];
  for (const cell of patch.cells) {
    const tangent = cellTangentMeters(patch, cell);
    cellHeightsM.push(canonM(cell));
    cellU.push(tangent.u);
    cellV.push(tangent.v);
  }
  const spacingM = slotHalfDistancesM.reduce((sum, half) => sum + half, 0)
    / Math.max(1, slotHalfDistancesM.length) * 2;
  const reliefM = Math.max(...cellHeightsM) - Math.min(...cellHeightsM);
  const context = {
    centerM: canonM(center),
    reliefBudgetM,
    coreRadiusM: LOCAL_HEX_CORE_RADIUS_RATIO * radiusM,
    edgeRadiusM: Math.SQRT2 * radiusM,
    voronoiBoundaryM: new Float64Array(0),
    slotHeightM: new Float64Array(0),
    cellHeightsM,
    cellU,
    cellV,
    // Вписанная окружность ячейки Голдберга: половина шага центров соседей.
    plateauRadiusM: spacingM * 0.5,
    // Реальный перепад высот патча, приведённый к шагу ячеек, — уклон макро-склона.
    slopeLimit: Math.max(1e-6, reliefM / Math.max(1, spacingM)),
  };
  const validSlots = slotHalfDistancesM.filter((distance) => distance > 0.5);
  if (validSlots.length === 0) return context;
  // Граница Вороного центральной ячейки вдоль луча φ — минимум по соседям
  // `(d_k / 2) / cos(φ − φ_k)`: пересечение перпендикулярных биссектрис
  // отрезков до центров соседних ячеек Patch7.
  const fallbackM = Math.max(...slotHalfDistancesM) * 4;
  const boundaryTable = new Float64Array(VORONOI_ANGLE_STEPS);
  for (let i = 0; i < VORONOI_ANGLE_STEPS; i++) {
    const phi = (i / VORONOI_ANGLE_STEPS) * Math.PI * 2;
    let boundaryM = fallbackM;
    for (let k = 0; k < slotAngles.length; k++) {
      const half = slotHalfDistancesM[k] as number;
      if (!(half > 0.5)) continue;
      const facing = Math.cos(phi - (slotAngles[k] as number));
      if (facing > 1e-6) boundaryM = Math.min(boundaryM, half / facing);
    }
    boundaryTable[i] = boundaryM;
  }
  // Высота угловых слотов по азимуту: сектора настоящей диаграммы Вороного
  // Patch7 на характерном радиусе (среднее расстояние до угловых слотов).
  const referenceRadiusM = (slotHalfDistancesM.reduce((sum, half) => sum + half, 0)
    / slotHalfDistancesM.length) * 2;
  const heightTable = buildSlotHeightTable(patch, canonM, context.centerM, referenceRadiusM);
  return { ...context, voronoiBoundaryM: boundaryTable, slotHeightM: heightTable };
}

/**
 * Stage-8.5: каноническая высота Patch7 по азимуту (720 отсчётов по 0.5°).
 *
 * Секторы берутся из НАСТОЯЩЕЙ диаграммы Вороного: на характерном радиусе для
 * каждого азимута определяется ближайшая каноническая ячейка Patch7. Переход
 * через границу двух соседей асимметричен, как и радиальный вывод высоты:
 * подъём к более высокой ячейке завершается ровно на границе, а спуск к более
 * низкой начинается на ней и продолжается уже внутри её сектора. Поэтому
 * жёсткий пол И-3.2 («суша не ниже канонической высоты своей ячейки») не
 * порождает ступеньку ни на одной границе: вместо прямого ребра Вороного
 * получается непрерывный склон реальной географии планеты.
 */
function buildSlotHeightTable(
  patch: LocalMapPatch,
  canonM: (cell: PatchCell) => number,
  centerM: number,
  referenceRadiusM: number,
): Float64Array {
  const steps = VORONOI_ANGLE_STEPS;
  const table = new Float64Array(steps).fill(centerM);
  const cells = patch.cells;
  if (cells.length < 2 || !(referenceRadiusM > 1)) return table;

  // 1. Владелец сектора — ближайшая каноническая ячейка на характерном радиусе.
  const ownerHeightM = new Float64Array(steps);
  const owners = new Int32Array(steps);
  for (let i = 0; i < steps; i++) {
    const phi = (i / steps) * Math.PI * 2;
    const cell = nearestPatchCell(
      patch,
      localPointToDirection(patch, referenceRadiusM * Math.cos(phi), referenceRadiusM * Math.sin(phi)),
    );
    const index = cells.indexOf(cell);
    const owner = index >= 0 ? index : 0;
    owners[i] = owner;
    ownerHeightM[i] = canonM(cells[owner] as PatchCell);
    table[i] = ownerHeightM[i] as number;
  }

  // 2. Границы секторов (азимуты, на которых меняется ближайшая ячейка).
  const boundaries: number[] = [];
  for (let i = 0; i < steps; i++) {
    if (owners[i] !== owners[(i + 1) % steps]) boundaries.push((i + 1) % steps);
  }
  if (boundaries.length === 0) return table;

  // 3. Асимметричные переходы: подъём — во второй половине предыдущего сектора,
  //    спуск — в первой половине нового (окна не пересекаются).
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b] as number;
    const end = boundaries[(b + 1) % boundaries.length] as number;
    const prevStart = boundaries[(b - 1 + boundaries.length) % boundaries.length] as number;
    const width = ((end - start + steps) % steps) || steps;
    const prevWidth = ((start - prevStart + steps) % steps) || steps;
    const hNext = ownerHeightM[start] as number;
    const hPrev = ownerHeightM[(start - 1 + steps) % steps] as number;
    const delta = hNext - hPrev;
    if (Math.abs(delta) < 1e-9) continue;
    if (delta > 0) {
      const w = Math.max(1, Math.floor(prevWidth / 2));
      for (let k = 0; k < w; k++) {
        table[(start - 1 - k + steps * 2) % steps] = hPrev + delta * smooth01((w - k) / w);
      }
    } else {
      const w = Math.max(1, Math.floor(width / 2));
      for (let k = 0; k < w; k++) {
        table[(start + k) % steps] = hPrev + delta * smooth01(k / w);
      }
    }
  }
  return table;
}

/** Выборка циклической таблицы по азимуту (720 отсчётов, линейно между ними). */
function sampleAngleTable(table: Float64Array, phi: number): number {
  if (table.length !== VORONOI_ANGLE_STEPS) return 0;
  const pos = (phi / (Math.PI * 2)) * VORONOI_ANGLE_STEPS;
  const i0 = Math.floor(pos) % VORONOI_ANGLE_STEPS;
  const i1 = (i0 + 1) % VORONOI_ANGLE_STEPS;
  const v0 = table[i0] as number;
  const v1 = table[i1] as number;
  return v0 + (v1 - v0) * (pos - Math.floor(pos));
}

/**
 * Stage-8.5: визуальный вывод высоты от центральной ячейки к угловым слотам
 * Patch7, м относительно seaLevel. Внутри ядра активного гекса
 * (`LOCAL_HEX_CORE_RADIUS_RATIO · radiusM`) вес центральной ячейки равен 1.0,
 * а к углам квадрата `[-radiusM, +radiusM]` высота плавно интерполируется к
 * угловым слотам `mapNeighborCellsToSlots(patch)`: прямые диагональные рёбра
 * Вороного, которые давал ступенчатый `nearestPatchCell`, исчезают.
 */
function smoothPatchSample(context: SmoothPatchContext, x: number, y: number): number {
  const r = Math.hypot(x, y);
  if (!(r > 0)) return context.centerM;
  const hasTables = context.voronoiBoundaryM.length === VORONOI_ANGLE_STEPS
    && context.slotHeightM.length === VORONOI_ANGLE_STEPS;
  const phi = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  // Высота углового слота по азимуту и настоящая граница Вороного по тому же лучу.
  const slotHeightM = hasTables ? sampleAngleTable(context.slotHeightM, phi) : context.centerM;
  const deltaM = slotHeightM - context.centerM;
  // Радиусы интерполяции: визуальное ядро/угол квадрата, но привязанные к
  // реальной границе Вороного. Подъём завершается на границе, спук начинается
  // на ней — так ступенька `nearestPatchCell` не возникает ни с одной стороны.
  let coreM = context.coreRadiusM;
  let edgeM = context.edgeRadiusM;
  if (hasTables) {
    const boundaryM = sampleAngleTable(context.voronoiBoundaryM, phi);
    if (deltaM >= 0) {
      coreM = Math.min(coreM, boundaryM * LOCAL_PATCH_RAMP_START_RATIO);
      edgeM = Math.max(Math.min(edgeM, boundaryM * LOCAL_PATCH_RAMP_END_RATIO), coreM + 1e-3);
    } else {
      coreM = boundaryM * LOCAL_PATCH_FALL_START_RATIO;
      edgeM = Math.max(boundaryM * LOCAL_PATCH_FALL_END_RATIO, coreM + 1e-3);
    }
  }
  if (!(r > coreM)) return context.centerM;
  const t = smooth01((r - coreM) / (edgeM - coreM));
  // Подъём к угловому слоту ограничен бюджетом локального рельефа: на участке,
  // который целиком лежит внутри одной канонической ячейки, инвариант И-3.2
  // требует `height <= anchor + бюджет`. Спуск бюджетом не ограничен — он и так
  // начинается только за настоящей границей Вороного.
  const cappedDeltaM = deltaM > context.reliefBudgetM ? context.reliefBudgetM : deltaM;
  return context.centerM + cappedDeltaM * t;
}

/**
 * Stage-8.5: непрерывное поле канонических высот Patch7 — «максимум конусов».
 *
 * Каждая ячейка держит своё каноническое плато внутри вписанной окружности
 * Вороного, а за её пределами высота уходит вниз конусом с естественным
 * уклоном `slopeLimit` (реальный перепад высот патча, делённый на шаг ячеек).
 * Максимум по всем 7 ячейкам непрерывен всюду и НИКОГДА не ниже канонической
 * высоты ближайшей ячейки, поэтому жёсткий пол И-3.2 не создаёт ступенек на
 * границах Вороного — в том числе между двумя соседями, где радиально-угловая
 * схема не работает (граница соседей не является лучом из центра участка).
 */
function smoothPatchPlanetField(context: SmoothPatchContext, x: number, y: number): number {
  const cells = context.cellHeightsM.length;
  if (cells === 0) return context.centerM;
  let best = -Infinity;
  for (let k = 0; k < cells; k++) {
    const du = x - (context.cellU[k] as number);
    const dv = y - (context.cellV[k] as number);
    const excess = Math.sqrt(du * du + dv * dv) - context.plateauRadiusM;
    const value = (context.cellHeightsM[k] as number)
      - (excess > 0 ? context.slopeLimit * excess : 0);
    if (value > best) best = value;
  }
  return Number.isFinite(best) ? best : context.centerM;
}

export function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

export function clampScalar(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Результат базового прохода рельефа: всё, что нужно проходу вреза русла. */
export interface BaseHeightfield {
  /**
   * h_natural ДО вреза русла, м, в двойной точности. Врез (и A-27 долина)
   * применяется к этой величине до округления во Float32 — как и раньше.
   */
  readonly heightM: Float64Array;
  /** 1 — точка суши канонической ячейки (не вода, не озеро и не океан), 0 — вода. */
  readonly landMask: Uint8Array;
  /**
   * terraform_map: байт 0 уже стоит на воде/океане/озере; на суше значения ещё
   * не подняты до TERRAFORM_LAND_MIN — это делает проход вреза русла.
   */
  readonly terraformMap: Uint8Array;
  /** Число точек воды (для meta.waterFraction). */
  readonly waterPoints: number;
}

/**
 * Stage-8.12d (A-31): единое полосно-ограниченное зерно сухопутного рельефа для
 * центрального участка, воротника и юбки горизонта. Октавы ограничены полосой,
 * разрешимой и сеткой heightfield (256×256), и полярным воротником (144×36):
 * перепад соседних вершин суши остаётся <= 6 м, а на шестиугольном срезе нет
 * смены зерна или бюджета амплитуд.
 */
export function sampleLandGrainT(
  ux: number,
  uy: number,
  seed: number,
  detailSigned: number | null,
): number {
  const fbmT = fBm(ux, uy, seed, 4, 2.0, 0.45);
  if (detailSigned === null) return fbmT;
  const detail01 = detailSigned * 0.5 + 0.5;
  const ridgeT = ridgedFbm(ux * 0.55, uy * 0.55, seed ^ 0x2F5A11, 3);
  return clampScalar(0.52 * fbmT + 0.30 * detail01 + 0.18 * ridgeT, 0, 1);
}

/**
 * Stage-8.12d: базовый рельеф участка БЕЗ русел. Формулы те же, что были в
 * первом проходе generateLocalMap: якорь Patch7 (И-3.2), гладкая интерполяция
 * (Stage-8.5), fBm и канал `detail` (И-3.1), батиметрия океана из канала
 * `elevation` с edgeBlend воротника (A-29). Врез русла — applyRiverCarve
 * (local-map-rivers.ts), второй проход по этому результату.
 *
 * `spawnMask` мутирует здесь: вода и тексели со streamWeight > 0 получают 0
 * (И-3.4); точки стрежня, которые врез пометит позже, тоже получат 0 вторым проходом.
 */
export function buildBaseHeightfield(
  patch: LocalMapPatch,
  radiusM: number,
  cellSeed: number,
  spawnMask: Uint8Array,
  detailLattice: LocalFieldLattice | null,
): BaseHeightfield {
  const hfRes = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;
  const noiseScale = (3.5 + Math.log2(Math.max(1, radiusM / 600)) * 0.65) / Math.max(radiusM, 1);
  // Stage-8.5: бюджет локального рельефа: без профиля — только fBm
  // (LAND_FBM_AMPLITUDE_M), с профилем (И-3.1) — плюс амплитуда канала `detail`.
  const landBudgetM = LAND_FBM_AMPLITUDE_M + (detailLattice ? PROFILE_DETAIL_AMPLITUDE_M : 0);
  const smoothContext = buildSmoothPatchContext(patch, radiusM, landBudgetM);
  const localCenterCell = patch.cells[0] as PatchCell;
  const centerApothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusM;
  const heightM = new Float64Array(hfRes * hfRes);
  const landMask = new Uint8Array(hfRes * hfRes);
  // Stage-8.5: `terraform_map` несёт явный водный маркер (байт 0 на воде).
  const terraformMap = generateTerraformMap();
  let waterPoints = 0;

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;

      // И-3.1: (u, v) → 3D-направление → ближайшая каноническая ячейка Patch7.
      const cell = nearestPatchCell(patch, localPointToDirection(patch, wx, wy));
      // И-3.2/И-3.4: локальная точка воды/озера/русла гасит спавн независимо от маски.
      if (isWaterCell(cell, patch.seaLevel) || cell.streamWeight > 0) spawnMask[idx] = 0;

      let height: number;
      if (isWaterCell(cell, patch.seaLevel)) {
        waterPoints++;
        if (cell.lakeWeight > 0) {
          // И-3.2: континентальное озеро остаётся на положительном зеркале.
          height = (waterLevelOf(cell, patch.seaLevel) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
        } else {
          // A-29: океан несёт батиметрию того же канала elevation, который
          // строит юбку. Минимум 0.035 единицы совпадает с signedCanon.
          // У грани микрополе плавно приходит к канонической высоте ячейки.
          const rawElevation = detailLattice
            ? sampleDetailAt(detailLattice.elevation, x / hfRes, y / hfRes)
            : cell.elevation;
          const rawBathymetryM = (
            Math.min(rawElevation, patch.seaLevel - 0.035) - patch.seaLevel
          ) * METERS_PER_ELEVATION_UNIT;
          const canonicalBathymetryM = (
            Math.min(localCenterCell.elevation, patch.seaLevel - 0.035) - patch.seaLevel
          ) * METERS_PER_ELEVATION_UNIT;
          const edgeBlend = smooth01(
            (clusterHexMetric(wx, wy) - centerApothemM * 0.72) / (centerApothemM * 0.18),
          );
          height = rawBathymetryM + (canonicalBathymetryM - rawBathymetryM) * edgeBlend;
        }
        // Stage-8.5: явный водный маркер — байт 0 в `terraform_map`.
        terraformMap[idx] = 0;
      } else {
        landMask[idx] = 1;
        // И-3.2: суша надёжно выше канонической высоты ячейки (берег не «ныряет»).
        const anchor = (baseElevationOf(cell) - patch.seaLevel) * METERS_PER_ELEVATION_UNIT;
        // Stage-8.5: базовая высота суши — гладкая интерполяция Patch7.
        const planetM = smoothPatchPlanetField(smoothContext, wx, wy);
        const sampleM = smoothPatchSample(smoothContext, wx, wy);
        const baseM = Math.max(anchor, planetM, sampleM);
        const tiltM = clampScalar(sampleM - planetM, 0, landBudgetM);
        // Stage-8.5 / Stage-8.12d (A-31): долину лепит единое с воротником
        // и юбкой полосно-ограниченное зерно sampleLandGrainT.
        const detailSigned = detailLattice
          ? sampleDetailAt(detailLattice.detail, x / hfRes, y / hfRes)
          : null;
        const reliefT = sampleLandGrainT(wx * noiseScale, wy * noiseScale, cellSeed, detailSigned);
        height = baseM + (landBudgetM - tiltM) * reliefT;
      }
      heightM[idx] = height;
    }
  }
  return { heightM, landMask, terraformMap, waterPoints };
}
