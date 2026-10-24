/* LocalMap rivers — русла рек локальной карты (Stage-8.12d, распил local-map-worker.ts).
   Модуль 3 из трёх: сегменты русел, врез (И-3.3), долина A-27 и водный маркер A-17b.
   Базовый рельеф — local-map-heightfield.ts; оркестрация — local-map-worker.ts. */

import { HEIGHTFIELD_RES, TERRAFORM_LAND_MIN, cellTangentMeters } from './local-map-heightfield.ts';
import type { BaseHeightfield } from './local-map-heightfield.ts';
import type { LocalMapPatch } from './local-map-contract.ts';

// ---- Русла рек ----
/** Полуширина русла реки в долях радиуса участка. */
export const RIVER_HALF_WIDTH_RATIO = 0.03;

/** Глубина вреза русла в долях радиуса участка. */
export const RIVER_DEPTH_RATIO = 0.0025;

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
export function riverSegments(patch: LocalMapPatch, radiusM: number, halfWidthM: number): RiverSegment[] {
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
  const riverHalfWidthM = Math.max(cellSize * 2, radiusM * RIVER_HALF_WIDTH_RATIO);
  // Stage-8.6: русло остаётся читаемой долиной даже на региональной карте.
  const riverDepthM = Math.max(10, radiusM * RIVER_DEPTH_RATIO * 1.8);
  const segments = riverSegments(patch, radiusM, riverHalfWidthM);
  const terraformMap = base.terraformMap;
  const heightfield = new Float32Array(hfRes * hfRes);

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      let height = base.heightM[idx] as number;
      if (base.landMask[idx] === 1) {
        const wx = (x - hfRes / 2) * cellSize;
        const wy = (y - hfRes / 2) * cellSize;
        // И-3.3/Stage-8.6: плавный врез русла от входных граней к центру и к выходной грани.
        const carve = riverCarveFactor(wx, wy, segments, riverHalfWidthM);
        const valley = riverCarveFactor(wx, wy, segments, riverHalfWidthM * 2.4);
        // A-27: широкая неглубокая долина (борта/пойма) плюс прежний узкий стрежень.
        if (valley > 0) height -= riverDepthM * (0.45 * valley + 0.55 * carve);
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
  return heightfield;
}
