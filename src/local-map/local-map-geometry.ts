/* LocalMapGeometry — чистые геометрические хелперы локальной карты (W23).
   Главный поток импортирует каркас сцены без Wasm-ядра: только типы
   wire-протокола, никаких значимых импортов. Точная обратная exp-проекция
   позволяет сравнить одно физическое направление в двух кадрах; апофема
   задана тем же геометрическим шагом, что и шесть соседних центров. */

import type { LocalMapPatch, PatchCell, TangentFrame, Vec3 } from './local-map-contract.ts';

/** Апофема правильного гекса в долях R_patch: половина шага центров 1,15 R. */
export const CENTER_HEX_APOTHEM_RATIO = 1.15 / 2;

/** Число угловых слотов кольца юбки: 6 направлений θ_k = k·π/3. */
export const SKIRT_RING_COUNT = 6;

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

/**
 * Обратная к localPointToDirection exp-карта. Применяется для сравнения
 * ОДНОЙ физической точки в касательных кадрах двух разных патчей (m.13).
 */
export function directionToLocalPoint(patch: LocalMapPatch, dir: Vec3): { u: number; v: number } {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(origin, dir))));
  const sin = Math.sin(theta);
  const scale = sin > 1e-10 ? theta * radiusM / sin : radiusM;
  return { u: dot(dir, east) * scale, v: dot(dir, north) * scale };
}

/**
 * Каноническая дуга потока: номера from/to — ТОЛЬКО фактические flowReceiver,
 * а координаты — 3D-центры глобальной сетки, не слоты/азимуты своего Patch7.
 */
export interface WorldRiverSegment {
  readonly fromCell: number;
  readonly toCell: number;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly middle: Vec3;
  readonly normal: Vec3;
  readonly halfAngle: number;
  /** Получатель — океан/озеро; только у такого ребра есть береговой спад. */
  readonly toWater: boolean;
  /** Устье без streamWeight: глубина ограничена 10 м, не каньоном 0,0045·R. */
  readonly mouth: boolean;
  /** Подготовленный угловой отсев для повторных физических запросов той же долины. */
  readonly searchLimit?: {
    readonly maxDistanceM: number;
    readonly planetRadiusM: number;
    readonly midCos: number;
    readonly endCos: number;
  };
}

export function worldRiverSegment(
  fromCell: number, toCell: number, from: Vec3, to: Vec3, toWater = false, mouth = false,
): WorldRiverSegment {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  const nx = from[1] * to[2] - from[2] * to[1];
  const ny = from[2] * to[0] - from[0] * to[2];
  const nz = from[0] * to[1] - from[1] * to[0];
  const crossLen = Math.hypot(nx, ny, nz);
  if (crossLen < 1e-12) throw new Error(`Вырожденное русло ${fromCell}→${toCell}`);
  const mid: Vec3 = [from[0] + to[0], from[1] + to[1], from[2] + to[2]];
  const midLen = Math.hypot(...mid);
  return {
    fromCell, toCell, from, to,
    middle: [mid[0] / midLen, mid[1] / midLen, mid[2] / midLen],
    normal: [nx / crossLen, ny / crossLen, nz / crossLen],
    halfAngle: Math.atan2(crossLen, dot) / 2,
    toWater,
    mouth,
  };
}

/** Подготовка углового отсева на всю жизнь набора дуг; не меняет геометрию. */
export function prepareWorldRiverSegment(
  segment: WorldRiverSegment, planetRadiusM: number, maxDistanceM: number,
): WorldRiverSegment {
  const maxAngle = maxDistanceM / planetRadiusM;
  const prepared = { ...segment };
  Object.defineProperty(prepared, 'searchLimit', {
    value: {
      maxDistanceM, planetRadiusM,
      midCos: Math.cos(segment.halfAngle + maxAngle),
      endCos: Math.cos(maxAngle),
    },
    enumerable: false,
  });
  return prepared;
}

/** Метров до одного геодезического ребра (Infinity за физическим пределом). */
export function worldRiverDistanceM(
  dir: Vec3, segment: WorldRiverSegment, planetRadiusM: number, maxDistanceM: number,
): number {
  const { from, to, middle, normal } = segment;
  const cached = segment.searchLimit;
  const matches = cached?.maxDistanceM === maxDistanceM && cached.planetRadiusM === planetRadiusM;
  const maxAngle = matches ? 0 : maxDistanceM / planetRadiusM;
  const midDot = dir[0] * middle[0] + dir[1] * middle[1] + dir[2] * middle[2];
  if (midDot < (matches ? cached!.midCos : Math.cos(segment.halfAngle + maxAngle))) return Infinity;
  const cross = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2];
  const fromSide = (from[1] * dir[2] - from[2] * dir[1]) * normal[0]
    + (from[2] * dir[0] - from[0] * dir[2]) * normal[1]
    + (from[0] * dir[1] - from[1] * dir[0]) * normal[2];
  const toSide = (dir[1] * to[2] - dir[2] * to[1]) * normal[0]
    + (dir[2] * to[0] - dir[0] * to[2]) * normal[1]
    + (dir[0] * to[1] - dir[1] * to[0]) * normal[2];
  let distanceM: number;
  if (fromSide < 0 || toSide < 0) {
    const end = fromSide < 0 ? from : to;
    const endDot = dir[0] * end[0] + dir[1] * end[1] + dir[2] * end[2];
    if (endDot < (matches ? cached!.endCos : Math.cos(maxAngle))) return Infinity;
    distanceM = Math.acos(Math.max(-1, Math.min(1, endDot))) * planetRadiusM;
  } else {
    distanceM = Math.asin(Math.min(1, Math.abs(cross))) * planetRadiusM;
  }
  return distanceM < maxDistanceM ? distanceM : Infinity;
}

/** Одинаковый физический factor в любом касательном кадре. */
export function worldRiverCarveFactor(
  dir: Vec3,
  segments: readonly WorldRiverSegment[],
  planetRadiusM: number,
  halfWidthM: number,
): number {
  if (!(halfWidthM > 0)) return 0;
  let best = halfWidthM;
  for (const segment of segments) {
    const distanceM = worldRiverDistanceM(dir, segment, planetRadiusM, best);
    if (distanceM < best) best = distanceM;
  }
  const t = 1 - best / halfWidthM;
  return t > 0 ? t * t * (3 - 2 * t) : 0;
}

/** Кадр любого канонического центра: та же формула, что buildPatch7.frame. */
export function tangentFrameAt(origin: Vec3, radiusM: number): TangentFrame {
  const ref: Vec3 = Math.abs(origin[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const unit = (v: Vec3): Vec3 => {
    const len = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  const east = unit(cross(ref, origin));
  return { origin, east, north: unit(cross(origin, east)), radiusM };
}

/** Ландшафт назначения для подписи перехода на соседний гекс (A-17). */
export function neighborTerrainKind(cell: PatchCell, seaLevel: number): string {
  if (cell.elevation < seaLevel) return 'океан';
  if (cell.lakeWeight > 0) return 'озеро';
  // muLand — непрерывная береговая принадлежность. До 0.80 ячейка ещё несёт
  // линию берега на масштабе перехода, даже если её центр уже выше seaLevel.
  if (cell.muLand < 0.8) return 'берег';
  // Нулевой порог streamWeight маркировал почти всю дренируемую сушу рекой.
  // Оставляем верхнюю половину нормированного потока либо крупное устойчивое
  // русло с площадью стока не меньше 20 000 км².
  const meaningfulRiver = cell.streamWeight >= 0.5
    || (cell.streamWeight >= 0.35 && cell.riverAccumulation >= 20_000);
  if (meaningfulRiver) return 'река';
  return 'суша';
}
