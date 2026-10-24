/* LocalMapGeometry — чистые геометрические хелперы локальной карты
   (Stage-8.10b, A-12b).
   --------------------------------------------------------------------------
   Вынесены из src/local-map/local-map-worker.ts, чтобы главный поток
   страницы мог статически импортировать каркас локальной сцены (слоты
   соседних ячеек, кривизна горизонта) БЕЗ таскания модуля генерации —
   а через него полного Wasm-ядра planet-core. Модуль не имеет значения-
   ных импортов: ни ядра, ни контракта (только типы wire-протокола).

   Публичный API и формулы сохранены дословно (побитовая эквивалентность
   generateLocalMap / generateHorizonSkirt проверяется golden-тестом в
   tests/local-map-stage8.test.mjs). */

import type { LocalMapPatch, PatchCell } from './local-map-contract.ts';

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
