/* LocalMap rivers — русла рек локальной карты (Stage-8.12d, распил local-map-worker.ts).
   Модуль 3 из трёх: сегменты русел, врез (И-3.3), долина A-27 и водный маркер A-17b.
   Базовый рельеф — local-map-heightfield.ts; оркестрация — local-map-worker.ts. */

import { HEIGHTFIELD_RES, TERRAFORM_LAND_MIN, cellTangentMeters } from './local-map-heightfield.ts';
import type { BaseHeightfield } from './local-map-heightfield.ts';
import { isWaterCell } from './local-map-contract.ts';
import type { LocalMapPatch } from './local-map-contract.ts';

// ---- Русла рек ----
/** Физическая полуширина русла, м: одна и та же при любом radiusPatchM. */
export const RIVER_CHANNEL_HALF_WIDTH_M = 1600;
/** Исторический экспорт для внешних диагностик, больше НЕ множитель ширины. */
export const RIVER_HALF_WIDTH_RATIO = 0.03;

/** Исторический коэффициент оставлен для совместимости внешних импортов. */
export const RIVER_DEPTH_RATIO = 0.0025;
/** Физическая глубина, а не 0,45 % стратегического радиуса (~235 м). */
export const RIVER_CHANNEL_DEPTH_M = 10;

interface RiverSegment {
  readonly u0: number; readonly v0: number;
  readonly u1: number; readonly v1: number;
  /** Bounding box сегмента, расширенная на полуширину русла, — быстрый отсев. */
  readonly minU: number; readonly minV: number;
  readonly maxU: number; readonly maxV: number;
}

function outletIsWater(patch: LocalMapPatch): boolean {
  const outletCell = patch.river.outlet
    ? patch.cells[patch.river.outlet.slot + 1]
    : undefined;
  return outletCell !== undefined && isWaterCell(outletCell, patch.seaLevel);
}

/**
 * И-3.3: русло входит строго через грани соседей-притоков (`inlets`) и выходит
 * строго через грань `flowReceiver` центра (`outlet`) в касательном кадре.
 */
export function riverSegments(patch: LocalMapPatch, radiusM: number, halfWidthM: number): RiverSegment[] {
  const raw: Array<Omit<RiverSegment, 'minU' | 'minV' | 'maxU' | 'maxV'>> = [];
  // Устье остаётся руслом, даже если порог глобальной streamWeight обнулил
  // вес центральной ячейки. Обычный flowReceiver на сушу руслом не становится.
  const hasWaterOutlet = outletIsWater(patch);
  if (patch.river.flowsThroughCenter || patch.river.inlets.length > 0 || hasWaterOutlet) {
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
export function riverCarveFactor(wx: number, wy: number, segments: readonly RiverSegment[], halfWidthM: number): number {
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

/** Вариант для широкой долины: bbox стрежня не должен её обрезать. */
function expandedCarveFactor(
  wx: number,
  wy: number,
  segments: readonly RiverSegment[],
  halfWidthM: number,
): number {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  let best = Infinity;
  for (const seg of segments) {
    if (
      wx < Math.min(seg.u0, seg.u1) - halfWidthM
      || wx > Math.max(seg.u0, seg.u1) + halfWidthM
      || wy < Math.min(seg.v0, seg.v1) - halfWidthM
      || wy > Math.max(seg.v0, seg.v1) + halfWidthM
    ) continue;
    const d = distanceToSegment(wx, wy, seg);
    if (d < best) best = d;
  }
  if (best >= halfWidthM) return 0;
  const t = 1 - best / halfWidthM;
  return t * t * (3 - 2 * t);
}

/** Подтексельное усреднение переходной зоны убирает лестницу кромки. */
function supersampledCarveFactor(
  wx: number,
  wy: number,
  cellSize: number,
  segments: readonly RiverSegment[],
  halfWidthM: number,
): number {
  const center = expandedCarveFactor(wx, wy, segments, halfWidthM);
  // Вне перехода дополнительные выборки не меняют плоское поле и не нужны.
  if (center <= 0 || center >= 1) return center;
  const offset = cellSize / 3;
  let sum = 0;
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      sum += expandedCarveFactor(wx + sx * offset, wy + sy * offset, segments, halfWidthM);
    }
  }
  return sum / 9;
}

/** Понижает локальные пики связной маски до заданного шага между вершинами. */
function limitHeightSteps(
  heightfield: Float32Array,
  mask: Uint8Array,
  cells: readonly number[],
  resolution: number,
  maxStepM: number,
): void {
  const queued = new Uint8Array(mask);
  const queue = cells.slice();
  let head = 0;
  const enqueue = (idx: number): void => {
    if (queued[idx] === 1) return;
    queued[idx] = 1;
    queue.push(idx);
  };
  while (head < queue.length) {
    const idx = queue[head++] as number;
    queued[idx] = 0;
    const x = idx % resolution;
    const y = Math.floor(idx / resolution);
    const neighbors = [
      x > 0 ? idx - 1 : -1,
      x + 1 < resolution ? idx + 1 : -1,
      y > 0 ? idx - resolution : -1,
      y + 1 < resolution ? idx + resolution : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || mask[neighbor] !== 1) continue;
      const height = heightfield[idx] as number;
      const neighborHeight = heightfield[neighbor] as number;
      if (height - neighborHeight > maxStepM + 1e-4) {
        heightfield[idx] = neighborHeight + maxStepM;
        enqueue(idx);
      } else if (neighborHeight - height > maxStepM + 1e-4) {
        heightfield[neighbor] = height + maxStepM;
        enqueue(neighbor);
      }
    }
  }
}

/**
 * Stage-8.12d: проход вреза русла по готовому базовому рельефу.
 *
 * Врез и A-27-долина зависят только от координат текселя и отрезков русла
 * (riverCarveFactor), но не от высоты, поэтому отдельный проход даёт те же
 * числа, что прежний врез внутри цикла. Порядок операций сохранён: высота в
 * double, `height -= riverDepthM * (0.45·valley + 0.55·carve)`, запись в
 * Float32 — один раз в самом конце.
 *
 * Суша (landMask = 1): при carve >= 0.45 — стрежень: terraform_map = 1 (A-17b,
 * байт реки отличает её от океана/озера) и spawnMask = 0; иначе terraform_map
 * не ниже TERRAFORM_LAND_MIN. Вода (landMask = 0) не затрагивается.
 *
 * Мутирует base.terraformMap и spawnMask на месте; возвращает итоговый heightfield.
 */
export function applyRiverCarve(
  patch: LocalMapPatch,
  radiusM: number,
  base: BaseHeightfield,
  spawnMask: Uint8Array,
): Float32Array {
  const hfRes = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;
  const riverHalfWidthM = RIVER_CHANNEL_HALF_WIDTH_M;
  const mouthWithoutStream = !patch.river.flowsThroughCenter
    && patch.river.inlets.length === 0
    && outletIsWater(patch);
  // Физическая глубина не меняется с размером стратегического тайла.
  const riverDepthM = RIVER_CHANNEL_DEPTH_M;
  const segments = riverSegments(patch, radiusM, riverHalfWidthM);
  const terraformMap = base.terraformMap;
  const heightfield = new Float32Array(hfRes * hfRes);
  const valleyMask = mouthWithoutStream ? new Uint8Array(hfRes * hfRes) : null;
  const bankMask = mouthWithoutStream ? new Uint8Array(hfRes * hfRes) : null;
  const valleyCells: number[] = [];
  const bankCells: number[] = [];

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      let height = base.heightM[idx] as number;
      if (base.landMask[idx] === 1) {
        const wx = (x - hfRes / 2) * cellSize;
        const wy = (y - hfRes / 2) * cellSize;
        // И-3.3/Stage-8.6: плавный врез русла от входных граней к центру и к выходной грани.
        const carve = mouthWithoutStream
          ? supersampledCarveFactor(wx, wy, cellSize, segments, riverHalfWidthM)
          : riverCarveFactor(wx, wy, segments, riverHalfWidthM);
        const valley = mouthWithoutStream
          ? supersampledCarveFactor(wx, wy, cellSize, segments, riverHalfWidthM * 2.4)
          : riverCarveFactor(wx, wy, segments, riverHalfWidthM * 2.4);
        if (
          bankMask
          && expandedCarveFactor(wx, wy, segments, riverHalfWidthM * 2.4 + cellSize * 3) > 0
        ) {
          // Буфер оставляет место пологому переходу от поймы к исходной суше.
          bankMask[idx] = 1;
          bankCells.push(idx);
          spawnMask[idx] = 0;
        }
        // A-27: широкая неглубокая долина (борта/пойма) плюс прежний узкий стрежень.
        if (valley > 0) {
          height -= riverDepthM * (0.45 * valley + 0.55 * carve);
          if (valleyMask) {
            // Пойма устья не получает последующее терраформ-смешивание: оно
            // иначе возвращает шум суши уже после сглаживания кромки.
            spawnMask[idx] = 0;
            valleyMask[idx] = 1;
            valleyCells.push(idx);
          }
        }
        if (carve >= 0.45) {
          // A-17b: байт 1 отличает стрежень реки от океана/озера (байт 0).
          terraformMap[idx] = 1;
          spawnMask[idx] = 0;
        } else {
          // Stage-8.5: суша всегда отличается от воды (минимум TERRAFORM_LAND_MIN).
          terraformMap[idx] = Math.max(TERRAFORM_LAND_MIN, terraformMap[idx] as number);
        }
      }
      heightfield[idx] = height;
    }
  }

  // Природное зерно суши может сложиться с профилем вреза. Релаксация
  // понижает только локальные пики фактической поймы; второй, более свободный
  // проход гасит возможную ступень на её внешней границе. Морское дно не
  // входит ни в одну маску.
  if (valleyMask && valleyCells.length > 0) {
    limitHeightSteps(heightfield, valleyMask, valleyCells, hfRes, 1.9);
  }
  if (bankMask && bankCells.length > 0) {
    limitHeightSteps(heightfield, bankMask, bankCells, hfRes, 6);
  }
  return heightfield;
}
