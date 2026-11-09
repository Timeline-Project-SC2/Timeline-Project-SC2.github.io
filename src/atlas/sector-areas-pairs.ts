/* Слой сочетания пары областей (§6 и §8 ТЗ `SEC-AREAS-HIERARCHY`).
 *
 * Слой намеренно **без DOM и без рендера**: команды над документом, расчёт
 * зоны взаимодействия двух областей, автолиния раздела, стороны раздела для
 * отрисовки и правило «пересечение запрещено». Интерфейс и рендер вызывают
 * эти функции; данные хранятся в документе (`SectorAreasDoc.pairs`).
 *
 * ------------------------------------------------------------------ модель
 *
 * **Зона взаимодействия** — пересечение заливок двух областей. Она считается
 * на сетке по габаритам обеих областей: ячейка помечается, если её центр
 * внутри обоих колец. Разрешение сетки ограничено `PAIR_GRID_MAX_CELLS` по
 * большей стороне; точность зоны — порядка размера ячейки (документировано,
 * проверяется тестами с допуском).
 *
 * **Равноудалённая автолиния (§6.2).** Для каждой ячейки зоны считаются
 * расстояния до «вне области А» и «вне области Б» (двухпроходный шаблонный
 * расчёт по сетке, веса 1 и √2, погрешность до ~8 %). Равноудалённой линией
 * считается геометрическое место `distA = distB`: в каждой точке этой линии
 * заливка каждой области простирается вглубь на одинаковое расстояние, то есть
 * линия равноудалена от границ зоны (от «берегов» пересечения), а не от
 * центров областей. Линия извлекается marching squares по полю
 * `distA − distB` внутри зоны; при нескольких связных частях зоны берётся
 * самая длинная часть, остальные остаются в авторежиме (ограничение v1,
 * показывается в интерфейсе пары).
 *
 * **Стороны раздела.** Линия (авто или ручная) делит зону на связные части:
 * ячейки зоны, не накрытые линией, группируются поиском в ширину; часть
 * относится к области А, если среднее `distA − distB` на ней положительно
 * (заливка А там глубже), иначе к Б. Из масок сторон трассируются полигоны —
 * их использует рендер в режиме `split`: заливка А не рисуется на стороне Б
 * и наоборот, поэтому в зоне встречи нет более светлого пятна от сложения
 * полупрозрачных заливок. Обводки (настоящие контуры) не трогаются.
 *
 * **Пересечение запрещено (§6.4).** Правило пары: если до правки контуры пары
 * не пересекались, то правка, создающая пересечение, отклоняется с понятным
 * сообщением (выбор исполнителя для показа владельцу: отклонение действия,
 * без молчаливой потери данных). Уже существующие пересечения правило
 * не разрывает — оно запрещает новые.
 *
 * **Требует пересмотра (§8).** Если после ручной правки линии изменилась
 * исходная геометрия одной из областей, линия не удаляется: якоря проверяются
 * на попадание в новую зону. Всё в порядке — линия остаётся применённой;
 * якоря вне зоны или зона исчезла — пара помечается `needsReview`, исходная
 * правка сохраняется до явного решения пользователя. Автолинии просто
 * перестраиваются по новой геометрии.
 *
 * Ограничения v1 (документированы в отчёте): зона считается по первому
 * (внешнему) кольцу каждой области; многосвязная зона правится по самой
 * длинной части.
 */

import type { Area, AreaPair, AreaPoint, PairLine, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
import { bboxOf, pointInRing } from './sector-areas-geometry.ts';
import { beginLineEdit, curvePointAt, sampleLine } from './sector-areas-anchors.ts';

/* --------------------------------------------------------------- константы */

/** Предел ячеек сетки зоны по большей стороне (точность/скорость). */
export const PAIR_GRID_MAX_CELLS = 160;

/** Относительный допуск равноудалённости автолинии (доля большего расстояния). */
export const PAIR_EQUAL_TOLERANCE = 0.18;

/** Минимальное число ячеек зоны, чтобы взаимодействие считалось состоявшимся. */
export const PAIR_MIN_ZONE_CELLS = 4;

/* ------------------------------------------------------------ команды пары */

/** Нормализованный ключ пары: порядок А+Б и Б+А не создаёт дубликат. */
export function pairKey(areaA: string, areaB: string): string {
  return [areaA, areaB].sort().join('\u0000');
}

/** Сочетания документа; отсутствующее поле читается пустым списком. */
export function pairsOf(doc: SectorAreasDoc): readonly AreaPair[] {
  return doc.pairs ?? [];
}

/** Сочетание конкретной пары областей (порядок не важен); `null` — пары нет. */
export function pairBetween(doc: SectorAreasDoc, areaA: string, areaB: string): AreaPair | null {
  const key = pairKey(areaA, areaB);
  return pairsOf(doc).find((pair) => pairKey(pair.areaA, pair.areaB) === key) ?? null;
}

/** Свободный номер для `pair-N` по существующим идентификаторам. */
export function nextPairSequence(doc: SectorAreasDoc): number {
  let maximum = 0;
  for (const pair of pairsOf(doc)) {
    const match = /-(\d+)$/.exec(pair.id);
    const value = match === null ? NaN : Number(match[1]);
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return maximum + 1;
}

function withPairs(doc: SectorAreasDoc, pairs: readonly AreaPair[]): SectorAreasDoc {
  return { ...doc, pairs };
}

export interface CreatePairResult {
  readonly doc: SectorAreasDoc;
  readonly pair: AreaPair;
}

/**
 * Создаёт слой сочетания пары: режим «разделение цветов» по умолчанию,
 * явный порядок наложения, автолиния раздела, если зоны пересечение есть.
 * Дубликат пары (в любом порядке) и пары области с самой собой — `RangeError`.
 */
export function createPair(
  doc: SectorAreasDoc,
  areaA: string,
  areaB: string,
  options: { readonly id?: string; readonly forbidCrossing?: boolean } = {},
): CreatePairResult {
  if (areaA === areaB) {
    throw new RangeError('Сочетание области с самой собой не имеет смысла.');
  }
  const byId = new Map(doc.areas.map((area) => [area.id, area]));
  if (!byId.has(areaA)) throw new RangeError(`Область ${areaA} не найдена.`);
  if (!byId.has(areaB)) throw new RangeError(`Область ${areaB} не найдена.`);
  if (pairBetween(doc, areaA, areaB) !== null) {
    throw new RangeError(`Сочетание ${areaA}+${areaB} уже существует (порядок А+Б и Б+А — одна пара).`);
  }
  const id = (options.id ?? `pair-${nextPairSequence(doc)}`).trim();
  if (pairsOf(doc).some((pair) => pair.id === id)) {
    throw new RangeError(`Сочетание ${id}: идентификатор уже занят.`);
  }
  const area = byId.get(areaA);
  const other = byId.get(areaB);
  const line = area !== undefined && other !== undefined ? buildInitialPairLine(area, other) : null;
  const pair: AreaPair = {
    id,
    areaA,
    areaB,
    mode: 'split',
    order: 'a-over-b',
    forbidCrossing: options.forbidCrossing ?? false,
    transitionWidth: null,
    line,
    needsReview: false,
    note: null,
  };
  return { doc: withPairs(doc, [...pairsOf(doc), pair]), pair };
}

/** Удаляет слой сочетания. Визуальные режимы областей не трогаются. */
export function removePair(doc: SectorAreasDoc, pairId: string): SectorAreasDoc {
  if (!pairsOf(doc).some((pair) => pair.id === pairId)) {
    throw new RangeError(`Сочетание ${pairId} не найдено.`);
  }
  return withPairs(doc, pairsOf(doc).filter((pair) => pair.id !== pairId));
}

function updatePair(doc: SectorAreasDoc, pairId: string, patch: (pair: AreaPair) => AreaPair): SectorAreasDoc {
  const pairs = pairsOf(doc);
  if (!pairs.some((pair) => pair.id === pairId)) {
    throw new RangeError(`Сочетание ${pairId} не найдено.`);
  }
  return withPairs(doc, pairs.map((pair) => (pair.id === pairId ? patch(pair) : pair)));
}

/** Смена режима отображения пары. Линия раздела сохраняется (§6.3). */
export function setPairMode(doc: SectorAreasDoc, pairId: string, mode: 'split' | 'overlay'): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({ ...pair, mode }));
}

/** Явный порядок наложения для режима наложения (§6.3). */
export function setPairOrder(doc: SectorAreasDoc, pairId: string, order: 'a-over-b' | 'b-over-a'): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({ ...pair, order }));
}

/** Правило «пересечение запрещено» (§6.4) — отдельно от визуальных режимов. */
export function setPairForbidCrossing(doc: SectorAreasDoc, pairId: string, value: boolean): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({ ...pair, forbidCrossing: value }));
}

/** Ширина мягкого перехода (полуширина полосы, единицы карты); `null` — резко. */
export function setPairTransition(doc: SectorAreasDoc, pairId: string, width: number | null): SectorAreasDoc {
  if (width !== null && (!Number.isFinite(width) || width < 0)) {
    throw new RangeError('Ширина перехода должна быть неотрицательным числом.');
  }
  return updatePair(doc, pairId, (pair) => ({ ...pair, transitionWidth: width }));
}

/** Сохраняет линию раздела: `manual` — ручная правка якорями (§7). */
export function setPairLine(doc: SectorAreasDoc, pairId: string, line: PairLine, manual: boolean): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({ ...pair, line: { ...line, manual }, needsReview: false }));
}

/** Сбрасывает линию на автолинию по текущей геометрии; `null`, если зоны нет. */
export function resetPairLineToAuto(doc: SectorAreasDoc, pairId: string): SectorAreasDoc {
  const pair = pairsOf(doc).find((entry) => entry.id === pairId);
  if (pair === undefined) throw new RangeError(`Сочетание ${pairId} не найдено.`);
  const areaA = doc.areas.find((entry) => entry.id === pair.areaA);
  const areaB = doc.areas.find((entry) => entry.id === pair.areaB);
  const line = areaA !== undefined && areaB !== undefined ? buildInitialPairLine(areaA, areaB) : null;
  return updatePair(doc, pairId, (entry) => ({ ...entry, line, needsReview: false, note: null }));
}

/** Помечает (снимает пометку) «требует пересмотра» (§8). */
export function markPairNeedsReview(doc: SectorAreasDoc, pairId: string, value: boolean, note?: string): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({ ...pair, needsReview: value, note: note ?? pair.note }));
}

/* -------------------------------------------------------- зона взаимодействия */

/** Сетка зоны взаимодействия: маски принадлежности и расстояния до «вне области». */
export interface ZoneGrid {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly w: number;
  readonly h: number;
  /** Центр внутри кольца А / Б. */
  readonly inA: Uint8Array;
  readonly inB: Uint8Array;
  /** Ячейка зоны: внутри обеих областей. */
  readonly zone: Uint8Array;
  /** Расстояние (в единицах карты) до ближайшей ячейки вне области А / Б. */
  readonly distA: Float64Array;
  readonly distB: Float64Array;
  /** Число ячеек зоны. */
  readonly zoneCells: number;
}

/** Строит сетку зоны пересечения двух колец; `null` — кольца не годятся. */
export function computeZoneGrid(ringA: Ring, ringB: Ring, maxCells: number = PAIR_GRID_MAX_CELLS): ZoneGrid | null {
  if (ringA.length < 3 || ringB.length < 3) return null;
  const a = bboxOf(ringA);
  const b = bboxOf(ringB);
  const x0 = Math.min(a.minX, b.minX) - 1;
  const y0 = Math.min(a.minY, b.minY) - 1;
  const x1 = Math.max(a.maxX, b.maxX) + 1;
  const y1 = Math.max(a.maxY, b.maxY) + 1;
  const span = Math.max(x1 - x0, y1 - y0);
  if (!Number.isFinite(span) || span <= 0) return null;
  const cell = span / maxCells;
  const w = Math.min(maxCells + 2, Math.ceil((x1 - x0) / cell) + 1);
  const h = Math.min(maxCells + 2, Math.ceil((y1 - y0) / cell) + 1);
  const size = w * h;
  const inA = new Uint8Array(size);
  const inB = new Uint8Array(size);
  const zone = new Uint8Array(size);
  let zoneCells = 0;
  for (let j = 0; j < h; j += 1) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = 0; i < w; i += 1) {
      const x = x0 + (i + 0.5) * cell;
      const index = j * w + i;
      const cellA = pointInRing(ringA, x, y) ? 1 : 0;
      const cellB = pointInRing(ringB, x, y) ? 1 : 0;
      inA[index] = cellA;
      inB[index] = cellB;
      if (cellA === 1 && cellB === 1) {
        zone[index] = 1;
        zoneCells += 1;
      }
    }
  }
  const distA = distanceField(inA, w, h, cell);
  const distB = distanceField(inB, w, h, cell);
  return { x0, y0, cell, w, h, inA, inB, zone, distA, distB, zoneCells };
}

/**
 * Расстояние от каждой ячейки до ближайшей ячейки со значением 0 (двухпроходный
 * шаблон, веса 1 и √2, в единицах карты). Ячейки вне поля — «далеко».
 */
function distanceField(mask: Uint8Array, w: number, h: number, cell: number): Float64Array {
  const INF = 1e9;
  const dist = new Float64Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    dist[index] = mask[index] === 1 ? INF : 0;
  }
  const at = (i: number, j: number): number => (i < 0 || j < 0 || i >= w || j >= h ? INF : dist[j * w + i]!);
  const relax = (index: number, candidate: number): void => {
    if (candidate < dist[index]!) dist[index] = candidate;
  };
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const index = j * w + i;
      if (dist[index] === 0) continue;
      relax(index, at(i - 1, j) + cell);
      relax(index, at(i, j - 1) + cell);
      relax(index, at(i - 1, j - 1) + Math.SQRT2 * cell);
      relax(index, at(i + 1, j - 1) + Math.SQRT2 * cell);
    }
  }
  for (let j = h - 1; j >= 0; j -= 1) {
    for (let i = w - 1; i >= 0; i -= 1) {
      const index = j * w + i;
      if (dist[index] === 0) continue;
      relax(index, at(i + 1, j) + cell);
      relax(index, at(i, j + 1) + cell);
      relax(index, at(i + 1, j + 1) + Math.SQRT2 * cell);
      relax(index, at(i - 1, j + 1) + Math.SQRT2 * cell);
    }
  }
  for (let index = 0; index < dist.length; index += 1) {
    if (dist[index]! >= INF / 2) dist[index] = INF / 2;
  }
  return dist;
}

/* ------------------------------------------------------- автолиния раздела */

export interface AutoLineResult {
  /** Самая длинная связная часть равноудалённой линии (упрощённая ломаная). */
  readonly points: readonly AreaPoint[];
  /** Сколько всего связных частей линии найдено (для честной информации в UI). */
  readonly components: number;
}

/**
 * Равноудалённая автолиния: marching squares по полю `distA − distB`
 * внутри зоны, связывание отрезков в ломаные, упрощение.
 */
export function autoDivideLine(grid: ZoneGrid): AutoLineResult | null {
  if (grid.zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const { w, h, zone, distA, distB } = grid;
  const field = (i: number, j: number): number => distA[j * w + i]! - distB[j * w + i]!;
  const inZone = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < w && j < h && zone[j * w + i] === 1;
  // Точки пересечения нулевого уровня на горизонтальных и вертикальных рёбрах.
  // Ключ — уникальная точка (координаты с округлением): соседние блоки,
  // дающие crossings в одной квантованной точке хребта, склеиваются в одну
  // ломаную, а не в россыпь двухточечных обрывков.
  const pointIds = new Map<string, number>();
  const pointsById: AreaPoint[] = [];
  const crossingEdge = new Map<string, number>();
  const pointIdOf = (point: AreaPoint): number => {
    const key = `${Math.round(point[0] * 1e4)}:${Math.round(point[1] * 1e4)}`;
    const existing = pointIds.get(key);
    if (existing !== undefined) return existing;
    const id = pointsById.length;
    pointsById.push(point);
    pointIds.set(key, id);
    return id;
  };
  const edgeKey = (kind: 'h' | 'v', i: number, j: number): string => `${kind}:${i}:${j}`;
  const crossingOnH = (i: number, j: number): number | null => {
    const f1 = field(i, j);
    const f2 = field(i + 1, j);
    // Класс «не А»: f <= 0. Нулевые значения поля (хребет на квантованных
    // расстояниях) относятся к отрицательному классу, иначе уровень f = 0
    // не порождает пересечений вовсе.
    if ((f1 <= 0) === (f2 <= 0)) return null;
    const t = f1 / (f1 - f2);
    return pointIdOf([grid.x0 + (i + 0.5 + t) * grid.cell, grid.y0 + (j + 0.5) * grid.cell]);
  };
  const crossingOnV = (i: number, j: number): number | null => {
    const f1 = field(i, j);
    const f2 = field(i, j + 1);
    if ((f1 <= 0) === (f2 <= 0)) return null;
    const t = f1 / (f1 - f2);
    return pointIdOf([grid.x0 + (i + 0.5) * grid.cell, grid.y0 + (j + 0.5 + t) * grid.cell]);
  };
  const pointOf = (kind: 'h' | 'v', i: number, j: number): number | null => {
    const key = edgeKey(kind, i, j);
    const cached = crossingEdge.get(key);
    if (cached !== undefined) return cached;
    const id = kind === 'h' ? crossingOnH(i, j) : crossingOnV(i, j);
    if (id !== null) crossingEdge.set(key, id);
    return id;
  };
  // Смежности уникальных точек внутри блоков 2×2.
  const adjacency = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    const list = adjacency.get(a) ?? [];
    list.push(b);
    adjacency.set(a, list);
    const back = adjacency.get(b) ?? [];
    back.push(a);
    adjacency.set(b, back);
  };
  for (let j = 0; j + 1 < h; j += 1) {
    for (let i = 0; i + 1 < w; i += 1) {
      if (!inZone(i, j) || !inZone(i + 1, j) || !inZone(i, j + 1) || !inZone(i + 1, j + 1)) continue;
      const tl = field(i, j);
      const tr = field(i + 1, j);
      const bl = field(i, j + 1);
      const br = field(i + 1, j + 1);
      const caseIndex = (tl > 0 ? 8 : 0) | (tr > 0 ? 4 : 0) | (br > 0 ? 2 : 0) | (bl > 0 ? 1 : 0);
      if (caseIndex === 0 || caseIndex === 15) continue;
      const top = pointOf('h', i, j);
      const bottom = pointOf('h', i, j + 1);
      const left = pointOf('v', i, j);
      const right = pointOf('v', i + 1, j);
      const connect = (a: number | null, b: number | null): void => {
        if (a !== null && b !== null && a !== b) link(a, b);
      };
      switch (caseIndex) {
        case 1: case 14: connect(left, bottom); break;
        case 2: case 13: connect(bottom, right); break;
        case 3: case 12: connect(left, right); break;
        case 4: case 11: connect(top, right); break;
        case 6: case 9: connect(top, bottom); break;
        case 7: case 8: connect(top, left); break;
        case 5: connect(top, left); connect(right, bottom); break;
        case 10: connect(top, right); connect(left, bottom); break;
        default: break;
      }
    }
  }
  if (adjacency.size === 0) return null;
  // Связные ломаные: идём от точек с одной смежностью (концы) или от любых.
  const visited = new Set<number>();
  const polylines: AreaPoint[][] = [];
  for (const startId of adjacency.keys()) {
    if (visited.has(startId)) continue;
    const line: AreaPoint[] = [];
    let current: number | null = startId;
    let previous: number | null = null;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      line.push(pointsById[current]!);
      const candidates: readonly number[] = adjacency.get(current) ?? [];
      const next: number | null = candidates.find((candidate) => candidate !== previous && !visited.has(candidate))
        ?? candidates.find((candidate) => !visited.has(candidate))
        ?? null;
      previous = current;
      current = next;
    }
    if (line.length >= 2) polylines.push(line);
  }
  if (polylines.length === 0) return null;
  polylines.sort((a, b) => polylineLength(b) - polylineLength(a));
  const main = polylines[0]!;
  return { points: simplifyPolyline(main, grid.cell * 0.6), components: polylines.length };
}

function polylineLength(points: readonly AreaPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(points[index]![0] - points[index - 1]![0], points[index]![1] - points[index - 1]![1]);
  }
  return total;
}

/** Упрощение Дугласа–Пекера: убирает зубцы сетки, сохраняя форму. */
export function simplifyPolyline(points: readonly AreaPoint[], epsilon: number): AreaPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;
    const a = points[start]!;
    const b = points[end]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const norm = Math.hypot(abx, aby) || 1e-12;
    let worst = -1;
    let worstDistance = 0;
    for (let index = start + 1; index < end; index += 1) {
      const p = points[index]!;
      const distance = Math.abs((p[0] - a[0]) * aby - (p[1] - a[1]) * abx) / norm;
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worst >= 0 && worstDistance > epsilon) {
      keep[worst] = 1;
      stack.push([start, worst], [worst, end]);
    }
  }
  const result: AreaPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (keep[index] === 1) result.push(points[index]!);
  }
  return result;
}

/** Автолиния пары по текущим кольцам: `null` — зоны взаимодействия нет. */
export function buildInitialPairLine(areaA: Area, areaB: Area): PairLine | null {
  const ringA = areaA.rings[0];
  const ringB = areaB.rings[0];
  if (ringA === undefined || ringB === undefined) return null;
  const grid = computeZoneGrid(ringA, ringB);
  if (grid === null) return null;
  const auto = autoDivideLine(grid);
  if (auto === null) return null;
  // Первый набор якорей — адаптация §7: концы линии + клик в её середине
  // по длине дуги (та же механика, что при ручном первом делении открытой
  // линии). Клик — точка на кривой, а не средняя вершина: у двухточечной
  // ломаной средняя вершина — это конец линии.
  const curve = sampleLine(auto.points);
  if (curve === null) return { manual: false, points: auto.points, anchors: [] };
  const mid = curvePointAt(curve, 0.5, false);
  const opened = beginLineEdit(auto.points, mid, Number.POSITIVE_INFINITY);
  return { manual: false, points: auto.points, anchors: opened.ok ? opened.state.anchors : [] };
}

/* --------------------------------------------------------- стороны раздела */

export interface SideMasks {
  /** Ячейки зоны, отнесённые к области А (заливка А глубже). */
  readonly aSide: Uint8Array;
  /** Ячейки зоны, отнесённые к области Б. */
  readonly bSide: Uint8Array;
}

/**
 * Делит зону линией на связные части и относит их к А или Б по среднему
 * `distA − distB` (линия может быть ручной и не совпадать с хребтом).
 */
export function sideMasks(grid: ZoneGrid, linePoints: readonly AreaPoint[]): SideMasks {
  const { w, h, zone } = grid;
  const size = w * h;
  const aSide = new Uint8Array(size);
  const bSide = new Uint8Array(size);
  if (linePoints.length < 2) {
    // Линии нет: вся зона делится по знаку расстояний (автоправило).
    for (let index = 0; index < size; index += 1) {
      if (zone[index] !== 1) continue;
      if (grid.distA[index]! >= grid.distB[index]!) aSide[index] = 1;
      else bSide[index] = 1;
    }
    return { aSide, bSide };
  }
  const blocked = new Uint8Array(size);
  const reach = grid.cell * 0.75;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const index = j * w + i;
      if (zone[index] !== 1) continue;
      const x = grid.x0 + (i + 0.5) * grid.cell;
      const y = grid.y0 + (j + 0.5) * grid.cell;
      if (distanceToPolyline(linePoints, x, y) <= reach) blocked[index] = 1;
    }
  }
  const component = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  const diff = (index: number): number => grid.distA[index]! - grid.distB[index]!;
  let componentIndex = 0;
  for (let start = 0; start < size; start += 1) {
    if (zone[start] !== 1 || blocked[start] === 1 || component[start] !== -1) continue;
    // Поиск в ширину по 4-связности: одна связная часть зоны без ячеек линии.
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = componentIndex;
    let sum = diff(start);
    let count = 1;
    while (head < tail) {
      const cellIndex = queue[head++]!;
      const i = cellIndex % w;
      const j = (cellIndex - i) / w;
      const neighbours = [
        i > 0 ? cellIndex - 1 : -1,
        i + 1 < w ? cellIndex + 1 : -1,
        j > 0 ? cellIndex - w : -1,
        j + 1 < h ? cellIndex + w : -1,
      ];
      for (const neighbour of neighbours) {
        if (neighbour < 0) continue;
        if (zone[neighbour] !== 1 || blocked[neighbour] === 1 || component[neighbour] !== -1) continue;
        component[neighbour] = componentIndex;
        queue[tail++] = neighbour;
        sum += diff(neighbour);
        count += 1;
      }
    }
    const toA = sum >= 0;
    for (let index = 0; index < size; index += 1) {
      if (component[index] === componentIndex) {
        if (toA) aSide[index] = 1;
        else bSide[index] = 1;
      }
    }
    componentIndex += 1;
  }
  return { aSide, bSide };
}

function distanceToPolyline(points: readonly AreaPoint[], x: number, y: number): number {
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 <= 1e-12 ? 0 : ((x - a[0]) * abx + (y - a[1]) * aby) / len2;
    t = Math.min(1, Math.max(0, t));
    best = Math.min(best, Math.hypot(x - (a[0] + abx * t), y - (a[1] + aby * t)));
  }
  return best;
}

/* ------------------------------------------------------- полигоны сторон */

/**
 * Полигоны сторон раздела для рендера: заливка А не рисуется в `bWin`,
 * заливка Б — в `aWin`. Трассировка границы масок на сетке + упрощение.
 */
export function winPolygons(grid: ZoneGrid, masks: SideMasks): { aWin: Ring[]; bWin: Ring[] } {
  return {
    aWin: maskPolygons(grid, masks.aSide),
    bWin: maskPolygons(grid, masks.bSide),
  };
}

function maskPolygons(grid: ZoneGrid, mask: Uint8Array): Ring[] {
  const { w, h, cell, x0, y0 } = grid;
  const at = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === 1;
  // Направленные граничные рёбра: маска справа по ходу; из угла может выходить
  // до двух рёбер (диагональное касание) — обе петли корректны для заливки.
  const edges = new Map<string, string>();
  const corner = (i: number, j: number): string => `${i}:${j}`;
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      if (!at(i, j)) continue;
      if (!at(i, j - 1)) edges.set(`${corner(i, j)}|${corner(i + 1, j)}`, corner(i + 1, j));
      if (!at(i, j + 1)) edges.set(`${corner(i + 1, j + 1)}|${corner(i, j + 1)}`, corner(i, j + 1));
      if (!at(i - 1, j)) edges.set(`${corner(i, j + 1)}|${corner(i, j)}`, corner(i, j));
      if (!at(i + 1, j)) edges.set(`${corner(i + 1, j)}|${corner(i + 1, j + 1)}`, corner(i + 1, j + 1));
    }
  }
  const parseCorner = (value: string): AreaPoint => {
    const [rawI, rawJ] = value.split(':');
    return [x0 + Number(rawI) * cell, y0 + Number(rawJ) * cell];
  };
  const startsAt = new Map<string, string[]>();
  for (const edgeKey of edges.keys()) {
    const from = edgeKey.split('|')[0] ?? '';
    const list = startsAt.get(from) ?? [];
    list.push(edgeKey);
    startsAt.set(from, list);
  }
  const loops: AreaPoint[][] = [];
  for (const startKey of [...edges.keys()]) {
    if (!edges.has(startKey)) continue;
    const loop: AreaPoint[] = [];
    let edgeKey: string | null = startKey;
    while (edgeKey !== null) {
      const currentKey: string = edgeKey;
      const parts: readonly string[] = currentKey.split('|');
      const from: string = parts[0] ?? '';
      const to: string = parts[1] ?? '';
      loop.push(parseCorner(from));
      edges.delete(currentKey);
      const outgoing: readonly string[] = startsAt.get(to) ?? [];
      const nextIndex: number = outgoing.findIndex((candidate: string) => edges.has(candidate));
      edgeKey = nextIndex >= 0 ? outgoing[nextIndex]! : null;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops
    .map((loop) => simplifyPolyline(loop, cell * 0.75))
    .filter((loop) => loop.length >= 3);
}

/* ------------------------------------------------- пересечение и запрет (§6.4) */

/** Пересекаются ли два кольца: рёбра или вложенность. */
export function ringsIntersect(ringA: Ring, ringB: Ring): boolean {
  if (ringA.length < 3 || ringB.length < 3) return false;
  const countA = ringA[ringA.length - 1]![0] === ringA[0]![0] && ringA[ringA.length - 1]![1] === ringA[0]![1]
    ? ringA.length - 1
    : ringA.length;
  const countB = ringB[ringB.length - 1]![0] === ringB[0]![0] && ringB[ringB.length - 1]![1] === ringB[0]![1]
    ? ringB.length - 1
    : ringB.length;
  for (let i = 0; i < countA; i += 1) {
    const a0 = ringA[i]!;
    const a1 = ringA[(i + 1) % countA]!;
    for (let j = 0; j < countB; j += 1) {
      const b0 = ringB[j]!;
      const b1 = ringB[(j + 1) % countB]!;
      if (segmentsCross(a0, a1, b0, b1)) return true;
    }
  }
  if (pointInRing(ringB, ringA[0]![0], ringA[0]![1])) return true;
  if (pointInRing(ringA, ringB[0]![0], ringB[0]![1])) return true;
  return false;
}

function segmentsCross(a0: AreaPoint, a1: AreaPoint, b0: AreaPoint, b1: AreaPoint): boolean {
  const d1x = a1[0] - a0[0];
  const d1y = a1[1] - a0[1];
  const d2x = b1[0] - b0[0];
  const d2y = b1[1] - b0[1];
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-12) return false;
  const t = ((b0[0] - a0[0]) * d2y - (b0[1] - a0[1]) * d2x) / denominator;
  const u = ((b0[0] - a0[0]) * d1y - (b0[1] - a0[1]) * d1x) / denominator;
  return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
}

/** Кольца всех областей по ID; `null` — область не найдена. */
function ringsOfArea(doc: SectorAreasDoc, areaId: string): readonly Ring[] | null {
  const area = doc.areas.find((entry) => entry.id === areaId);
  return area === undefined ? null : area.rings;
}

/**
 * Проверка правила «пересечение запрещено» (§6.4) перед записью новых колец
 * области: возвращает пояснение, если правка создаёт **новое** пересечение
 * с парой, где правило включено. Уже существующие пересечения не считаются
 * нарушением: правило запрещает новые, а не разрывает старые молча.
 */
export function crossingViolation(
  doc: SectorAreasDoc,
  areaId: string,
  nextRings: readonly Ring[],
): string | null {
  const nextRing = nextRings[0];
  if (nextRing === undefined) return null;
  for (const pair of pairsOf(doc)) {
    if (!pair.forbidCrossing) continue;
    if (pair.areaA !== areaId && pair.areaB !== areaId) continue;
    const otherId = pair.areaA === areaId ? pair.areaB : pair.areaA;
    const otherRings = ringsOfArea(doc, otherId);
    const otherRing = otherRings?.[0];
    if (otherRing === undefined) continue;
    const nowIntersect = ringsIntersect(nextRing, otherRing);
    if (!nowIntersect) continue;
    const currentRings = ringsOfArea(doc, areaId);
    const currentRing = currentRings?.[0];
    const beforeIntersect = currentRing !== undefined && ringsIntersect(currentRing, otherRing);
    if (!beforeIntersect) {
      return `Сочетание ${pair.id} (${areaId}+${otherId}): пересечение запрещено правилом пары. Правка отклонена, контуры не изменены.`;
    }
  }
  return null;
}

/* --------------------------------------------- пересмотр после правки (§8) */

/**
 * Пересмотр сочетаний после изменения геометрии области (§8 ТЗ): ручные линии
 * **не удаляются и не перезаписываются**. Линия остаётся, если все её якоря
 * по-прежнему в зоне взаимодействия; иначе пара помечается `needsReview`.
 * Автолинии перестраиваются по новой геометрии; если взаимодействие исчезло,
 * автолиния обнуляется и пара помечается `needsReview` с пояснением.
 */
export function reviewPairsAfterGeometryChange(
  doc: SectorAreasDoc,
  changedAreaId: string,
): { doc: SectorAreasDoc; changed: readonly string[] } {
  const changed: string[] = [];
  const pairs = pairsOf(doc).map((pair) => {
    if (pair.areaA !== changedAreaId && pair.areaB !== changedAreaId) return pair;
    const areaA = doc.areas.find((entry) => entry.id === pair.areaA);
    const areaB = doc.areas.find((entry) => entry.id === pair.areaB);
    if (areaA === undefined || areaB === undefined) return pair;
    const ringA = areaA.rings[0];
    const ringB = areaB.rings[0];
    if (ringA === undefined || ringB === undefined) return pair;
    const grid = computeZoneGrid(ringA, ringB);
    if (grid === null || grid.zoneCells < PAIR_MIN_ZONE_CELLS) {
      changed.push(pair.id);
      if (pair.line === null || !pair.line.manual) {
        return { ...pair, line: null, needsReview: true, note: 'Зона взаимодействия исчезла после правки контура.' };
      }
      return { ...pair, needsReview: true, note: 'Зона взаимодействия исчезла: ручная линия сохранена, но не применяется.' };
    }
    if (pair.line === null || !pair.line.manual) {
      const rebuilt = buildInitialPairLine(areaA, areaB);
      changed.push(pair.id);
      return { ...pair, line: rebuilt, needsReview: false, note: null };
    }
    // Ручная линия: якоря должны остаться в зоне (с допуском в 2 ячейки).
    const tolerance = grid.cell * 2;
    let inside = true;
    for (const anchor of pair.line.anchors) {
      const i = Math.floor((anchor.point[0] - grid.x0) / grid.cell);
      const j = Math.floor((anchor.point[1] - grid.y0) / grid.cell);
      if (i < 0 || j < 0 || i >= grid.w || j >= grid.h || grid.zone[j * grid.w + i] !== 1) {
        // Допуск: проверяем соседние ячейки (граница зоны на сетке грубая).
        let near = false;
        for (let dj = -1; dj <= 1 && !near; dj += 1) {
          for (let di = -1; di <= 1 && !near; di += 1) {
            const ni = i + di;
            const nj = j + dj;
            if (ni >= 0 && nj >= 0 && ni < grid.w && nj < grid.h && grid.zone[nj * grid.w + ni] === 1) {
              const cx = grid.x0 + (ni + 0.5) * grid.cell;
              const cy = grid.y0 + (nj + 0.5) * grid.cell;
              if (Math.hypot(cx - anchor.point[0], cy - anchor.point[1]) <= tolerance) near = true;
            }
          }
        }
        if (!near) {
          inside = false;
          break;
        }
      }
    }
    if (!inside) {
      changed.push(pair.id);
      return { ...pair, needsReview: true, note: 'Контур области изменился: ручная линия сохранена, но вышла из зоны взаимодействия.' };
    }
    return pair;
  });
  return { doc: { ...doc, pairs }, changed };
}

/* --------------------------------------------- разделение для рендера (§6.2) */

export interface PairSplitRegions {
  readonly pairId: string;
  /** Полигоны зоны, где заливку А не рисуем (сторона Б). */
  readonly aHoles: readonly Ring[];
  /** Полигоны зоны, где заливку Б не рисуем (сторона А). */
  readonly bHoles: readonly Ring[];
}

/**
 * Области-вырезы для режима `split`: заливка каждой области не рисуется на
 * стороне другой. Для `overlay` рендер вызывает не должен. `null` — зоны нет.
 */
export function splitRegionsForPair(areaA: Area, areaB: Area, pair: AreaPair): PairSplitRegions | null {
  if (pair.mode !== 'split') return null;
  const ringA = areaA.rings[0];
  const ringB = areaB.rings[0];
  if (ringA === undefined || ringB === undefined) return null;
  const grid = computeZoneGrid(ringA, ringB);
  if (grid === null || grid.zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const linePoints = pair.line !== null && pair.line.points.length >= 2
    ? pair.line.points
    : autoDivideLine(grid)?.points ?? [];
  const masks = sideMasks(grid, linePoints);
  const polygons = winPolygons(grid, masks);
  return { pairId: pair.id, aHoles: polygons.bWin, bHoles: polygons.aWin };
}
