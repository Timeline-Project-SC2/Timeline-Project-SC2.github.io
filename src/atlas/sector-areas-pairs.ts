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
import {
  areaFillBBox,
  bboxOf,
  distanceToAreaFillBoundary,
  pointInAreaFill,
  pointInRing,
  positiveContourRingsOf,
} from './sector-areas-geometry.ts';
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
  const info = area !== undefined && other !== undefined ? buildInitialPairLineInfo(area, other) : null;
  const line = info === null ? null : info.line;
  const extraLines = info === null ? [] : info.extraLines;
  let note: string | null = null;
  if (info !== null && info.components > 1) {
    note = multiComponentNote(info.components);
  }
  // Включение запрета на уже пересекающейся паре отклоняется в
  // `setPairForbidCrossing`; при создании пара лишь фиксирует текущее состояние
  // (пересечение могло возникнуть позже включения или из импортированного файла),
  // а правило «запрещены новые пересечения» старое не разрывает.
  const pair: AreaPair = {
    id,
    areaA,
    areaB,
    mode: 'split',
    order: 'a-over-b',
    forbidCrossing: options.forbidCrossing ?? false,
    transitionWidth: null,
    line,
    ...(extraLines.length > 0 ? { extraLines } : {}),
    needsReview: false,
    note,
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

/** Все линии пары: основная (если есть) плюс дополнительные линии компонент. */
export function pairLinesOf(pair: AreaPair): readonly PairLine[] {
  const out: PairLine[] = [];
  if (pair.line !== null) out.push(pair.line);
  if (pair.extraLines !== undefined) {
    for (const line of pair.extraLines) out.push(line);
  }
  return out;
}

function multiComponentNote(components: number): string {
  return `Зона взаимодействия состоит из ${components} частей: для каждой части поддерживается своя линия раздела.`;
}

function isAutoGeneratedPairNote(note: string | null): boolean {
  if (note === null) return false;
  return note.startsWith('Зона взаимодействия')
    || note.startsWith('Контур области изменился')
    || note.startsWith('Ручная линия');
}

/** Пересекаются ли области пары прямо сейчас (учитывает дырки и все контурные штрихи). */
export function pairCurrentlyIntersects(doc: SectorAreasDoc, pairId: string): boolean {
  const pair = pairsOf(doc).find((entry) => entry.id === pairId);
  if (pair === undefined) return false;
  const areaA = doc.areas.find((entry) => entry.id === pair.areaA);
  const areaB = doc.areas.find((entry) => entry.id === pair.areaB);
  if (areaA === undefined || areaB === undefined) return false;
  if (computeAreaZoneGrid(areaA, areaB) !== null) return true;
  const ringsA = positiveContourRingsOf(areaA);
  const ringsB = positiveContourRingsOf(areaB);
  for (const ringA of ringsA) {
    for (const ringB of ringsB) {
      if (ringBoundaryCrosses(ringA, ringB)) return true;
    }
  }
  for (const ringA of ringsA) {
    const p = ringA[0];
    if (p !== undefined && pointInAreaFill(areaB, p[0], p[1])) return true;
  }
  for (const ringB of ringsB) {
    const p = ringB[0];
    if (p !== undefined && pointInAreaFill(areaA, p[0], p[1])) return true;
  }
  return false;
}

/** Ширина мягкого перехода (полуширина полосы, единицы карты); `null` — резко. */
export function setPairTransition(doc: SectorAreasDoc, pairId: string, width: number | null): SectorAreasDoc {
  if (width !== null && (!Number.isFinite(width) || width < 0)) {
    throw new RangeError('Ширина перехода должна быть неотрицательным числом.');
  }
  return updatePair(doc, pairId, (pair) => ({ ...pair, transitionWidth: width }));
}

/** Сохраняет линию раздела (`lineIndex = 0` — основная, `> 0` — компонента в `extraLines`). */
export function setPairLine(
  doc: SectorAreasDoc,
  pairId: string,
  line: PairLine,
  manual: boolean,
  lineIndex = 0,
): SectorAreasDoc {
  const existing = pairsOf(doc).find((entry) => entry.id === pairId);
  if (existing === undefined) throw new RangeError(`Сочетание ${pairId} не найдено.`);
  const nextLine: PairLine = { ...line, manual };
  const areaA = doc.areas.find((entry) => entry.id === existing.areaA);
  const areaB = doc.areas.find((entry) => entry.id === existing.areaB);
  const grid = areaA !== undefined && areaB !== undefined ? computeAreaZoneGrid(areaA, areaB) : null;
  let nextPrimary = existing.line;
  let nextExtras = existing.extraLines ? [...existing.extraLines] : [];
  if (lineIndex <= 0) {
    nextPrimary = nextLine;
  } else {
    while (nextExtras.length < lineIndex) {
      nextExtras.push(nextLine);
    }
    nextExtras[lineIndex - 1] = nextLine;
  }
  const allNextLines: readonly PairLine[] = [
    ...(nextPrimary !== null ? [nextPrimary] : []),
    ...nextExtras,
  ];
  let needsReview = false;
  let note: string | null = isAutoGeneratedPairNote(existing.note) ? null : existing.note;
  if (grid === null || grid.zoneCells < PAIR_MIN_ZONE_CELLS) {
    needsReview = true;
    note = 'Зона взаимодействия отсутствует: ручная линия сохранена, но не применяется.';
  } else if (manual && !allManualLinesInsideZone(grid, allNextLines)) {
    needsReview = true;
    note = 'Ручная линия выходит за зону взаимодействия.';
  } else {
    const components = zoneComponentCount(grid);
    if (components > 1) note = multiComponentNote(components);
  }
  return updatePair(doc, pairId, (pair) => {
    const { extraLines: _dropped, ...rest } = pair;
    return {
      ...rest,
      line: nextPrimary,
      ...(nextExtras.length > 0 ? { extraLines: nextExtras } : {}),
      needsReview,
      note,
    };
  });
}

/** Сбрасывает все линии пары на автолинии по текущей геометрии; `null`, если зоны нет. */
export function resetPairLineToAuto(doc: SectorAreasDoc, pairId: string): SectorAreasDoc {
  const pair = pairsOf(doc).find((entry) => entry.id === pairId);
  if (pair === undefined) throw new RangeError(`Сочетание ${pairId} не найдено.`);
  const areaA = doc.areas.find((entry) => entry.id === pair.areaA);
  const areaB = doc.areas.find((entry) => entry.id === pair.areaB);
  const info = areaA !== undefined && areaB !== undefined ? buildInitialPairLineInfo(areaA, areaB) : null;
  return updatePair(doc, pairId, (entry) => {
    const { extraLines: _dropped, ...rest } = entry;
    if (info === null) {
      return { ...rest, line: null, needsReview: false, note: null };
    }
    return {
      ...rest,
      line: info.line,
      ...(info.extraLines.length > 0 ? { extraLines: info.extraLines } : {}),
      needsReview: false,
      note: info.components > 1 ? multiComponentNote(info.components) : null,
    };
  });
}

/** Помечает (снимает пометку) «требует пересмотра» (§8); снятие чистит заметку. */
export function markPairNeedsReview(doc: SectorAreasDoc, pairId: string, value: boolean, note?: string): SectorAreasDoc {
  return updatePair(doc, pairId, (pair) => ({
    ...pair,
    needsReview: value,
    note: value ? (note ?? pair.note) : (note ?? null),
  }));
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
  /**
   * `distA − distB` с точным дожимом: на квантованных плато (`f === 0` полосами,
   * например при коллинеарных границах) значение пересчитывается по точным
   * расстояниям центров ячеек до границ колец. Точные расстояния антисимметричны
   * при перестановке А и Б — автолиния перестановку пары не «перевешивает» (S3).
   */
  readonly diffField: Float64Array;
  /** Число ячеек зоны. */
  readonly zoneCells: number;
}

/**
 * Строит сетку зоны пересечения двух областей с учётом дырок (`rings[1..]`)
 * и дополнительных замкнутых штрихов (`Area.strokes`); `null` — пересечения нет.
 */
export function computeAreaZoneGrid(
  areaA: Area,
  areaB: Area,
  maxCells: number = PAIR_GRID_MAX_CELLS,
): ZoneGrid | null {
  if (areaA.closed === false || areaB.closed === false) return null;
  const simpleA = areaA.rings.length === 1 && (areaA.strokes?.length ?? 0) === 0;
  const simpleB = areaB.rings.length === 1 && (areaB.strokes?.length ?? 0) === 0;
  if (simpleA && simpleB) {
    return computeZoneGrid(areaA.rings[0]!, areaB.rings[0]!, maxCells);
  }
  const boxA = areaFillBBox(areaA);
  const boxB = areaFillBBox(areaB);
  if (boxA === null || boxB === null) return null;
  const overlapSpanX = Math.min(boxA.maxX, boxB.maxX) - Math.max(boxA.minX, boxB.minX);
  const overlapSpanY = Math.min(boxA.maxY, boxB.maxY) - Math.max(boxA.minY, boxB.minY);
  if (overlapSpanX <= 0 || overlapSpanY <= 0) return null;
  const span = Math.max(overlapSpanX, overlapSpanY);
  if (!Number.isFinite(span) || span <= 0) return null;
  const cell = span / maxCells;
  const pad = cell * 2 + 1;
  const x0 = Math.max(boxA.minX, boxB.minX) - pad;
  const y0 = Math.max(boxA.minY, boxB.minY) - pad;
  const x1 = Math.min(boxA.maxX, boxB.maxX) + pad;
  const y1 = Math.min(boxA.maxY, boxB.maxY) + pad;
  const w = Math.min(maxCells + 4, Math.ceil((x1 - x0) / cell) + 1);
  const h = Math.min(maxCells + 4, Math.ceil((y1 - y0) / cell) + 1);
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
      const cellA = pointInAreaFill(areaA, x, y) ? 1 : 0;
      const cellB = pointInAreaFill(areaB, x, y) ? 1 : 0;
      inA[index] = cellA;
      inB[index] = cellB;
      if (cellA === 1 && cellB === 1) {
        zone[index] = 1;
        zoneCells += 1;
      }
    }
  }
  if (zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const distA = distanceField(inA, w, h, cell);
  const distB = distanceField(inB, w, h, cell);
  const diffField = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const raw = distA[index]! - distB[index]!;
    if (raw !== 0 || inA[index] !== 1 || inB[index] !== 1) {
      diffField[index] = raw;
      continue;
    }
    const x = x0 + ((index % w) + 0.5) * cell;
    const y = y0 + (Math.floor(index / w) + 0.5) * cell;
    diffField[index] = distanceToAreaFillBoundary(areaA, x, y) - distanceToAreaFillBoundary(areaB, x, y);
  }
  return { x0, y0, cell, w, h, inA, inB, zone, distA, distB, diffField, zoneCells };
}

/** Полигоны всей зоны взаимодействия (учитывая все связные части, для клампа концов линии). */
export function zoneBoundaryPolygons(grid: ZoneGrid): Ring[] {
  return maskPolygons(grid, grid.zone);
}

/** Строит сетку зоны пересечения двух колец; `null` — кольца не годятся. */
export function computeZoneGrid(ringA: Ring, ringB: Ring, maxCells: number = PAIR_GRID_MAX_CELLS): ZoneGrid | null {
  if (ringA.length < 3 || ringB.length < 3) return null;
  const a = bboxOf(ringA);
  const b = bboxOf(ringB);
  // Сетка накрывает только пересечение габаритов (линзу) с запасом: ячейки вне
  // зоны не нужны маскам, а разрешение внутри линзы растёт (S3 ревью: раньше
  // шаг сетки задавала крупная область-сосед).
  const overlapSpanX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const overlapSpanY = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  // Пересечения габаритов нет хотя бы по одной оси — зоны взаимодействия нет.
  if (overlapSpanX <= 0 || overlapSpanY <= 0) return null;
  const span = Math.max(overlapSpanX, overlapSpanY);
  if (!Number.isFinite(span) || span <= 0) return null;
  const cell = span / maxCells;
  const pad = cell * 2 + 1;
  const x0 = Math.max(a.minX, b.minX) - pad;
  const y0 = Math.max(a.minY, b.minY) - pad;
  const x1 = Math.min(a.maxX, b.maxX) + pad;
  const y1 = Math.min(a.maxY, b.maxY) + pad;
  const w = Math.min(maxCells + 4, Math.ceil((x1 - x0) / cell) + 1);
  const h = Math.min(maxCells + 4, Math.ceil((y1 - y0) / cell) + 1);
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
  if (zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const distA = distanceField(inA, w, h, cell);
  const distB = distanceField(inB, w, h, cell);
  const diffField = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    const raw = distA[index]! - distB[index]!;
    if (raw !== 0 || inA[index] !== 1 || inB[index] !== 1) {
      diffField[index] = raw;
      continue;
    }
    // Плато на квантованных расстояниях: точные расстояния до границ колец.
    const x = x0 + ((index % w) + 0.5) * cell;
    const y = y0 + (Math.floor(index / w) + 0.5) * cell;
    diffField[index] = distanceToPolyline(ringA, x, y) - distanceToPolyline(ringB, x, y);
  }
  return { x0, y0, cell, w, h, inA, inB, zone, distA, distB, diffField, zoneCells };
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

export interface AutoLinesResult {
  /** Все связные части равноудалённой линии, отсортированные от длинной к короткой. */
  readonly lines: readonly (readonly AreaPoint[])[];
  /** Сколько всего связных частей линии найдено. */
  readonly components: number;
}

/**
 * Равноудалённая автолиния: marching squares по полю `distA − distB`
 * внутри зоны, связывание отрезков в ломаные, упрощение.
 */
export function autoDivideLines(grid: ZoneGrid): AutoLinesResult | null {
  if (grid.zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const { w, h, zone, diffField } = grid;
  // Каноническая ориентация поля для marching squares: первый ненулевой узел
  // зоны считается положительным, поэтому перестановка пары А/Б меняет знак
  // поля строго на противоположный, не смещая порог `<= 0` в сёдлах (S3).
  let canonicalSign = 1;
  for (let index = 0; index < w * h; index += 1) {
    if (zone[index] !== 1) continue;
    const value = diffField[index]!;
    if (value !== 0) {
      canonicalSign = value > 0 ? 1 : -1;
      break;
    }
  }
  const field = (i: number, j: number): number => canonicalSign * diffField[j * w + i]!;
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
    // Симметричная проверка пересечения нуля: нули на узлах сдвигаются в одну
    // сторону относительно знакового класса, а канонический знак обеспечивает
    // инвариантность при перестановке пары А и Б.
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
      const center = tl + tr + br + bl;
      switch (caseIndex) {
        case 1: case 14: connect(left, bottom); break;
        case 2: case 13: connect(bottom, right); break;
        case 3: case 12: connect(left, right); break;
        case 4: case 11: connect(top, right); break;
        case 6: case 9: connect(top, bottom); break;
        case 7: case 8: connect(top, left); break;
        case 5:
          if (center > 0) { connect(top, left); connect(right, bottom); }
          else { connect(top, right); connect(left, bottom); }
          break;
        case 10:
          if (center > 0) { connect(top, right); connect(left, bottom); }
          else { connect(top, left); connect(right, bottom); }
          break;
        default: break;
      }
    }
  }
  if (adjacency.size === 0) return null;
  // Связные ломаные: идём от точек с одной смежностью (концы) или от любых.
  const visited = new Set<number>();
  const polylines: AreaPoint[][] = [];
  // Обход связной ломаной из точек-пересечений. Старт может попасть в середину
  // цепи, поэтому идём в **обе** стороны: сначала против выбранного соседа
  // (в обратную сторону), затем вперёд — иначе цепь крошится на двухточечные
  // обрывки, а «самой длинной частью» становится случайный обрывок у границы.
  const walkChain = (from: number, incoming: number | null): number[] => {
    const out: number[] = [];
    let current: number | null = from;
    let previous: number | null = incoming;
    while (current !== null && !visited.has(current)) {
      visited.add(current);
      out.push(current);
      const candidates: readonly number[] = adjacency.get(current) ?? [];
      const next: number | null = candidates.find((candidate) => candidate !== previous && !visited.has(candidate))
        ?? candidates.find((candidate) => !visited.has(candidate))
        ?? null;
      previous = current;
      current = next;
    }
    return out;
  };
  for (const startId of adjacency.keys()) {
    if (visited.has(startId)) continue;
    visited.add(startId);
    const neighbours = adjacency.get(startId) ?? [];
    const backNeighbour = neighbours.find((candidate) => !visited.has(candidate));
    const prefix = backNeighbour === undefined ? [] : walkChain(backNeighbour, startId).reverse();
    const forwardNeighbour = neighbours.find((candidate) => !visited.has(candidate));
    const suffix = forwardNeighbour === undefined ? [] : walkChain(forwardNeighbour, startId);
    const chain = [...prefix, startId, ...suffix];
    if (chain.length >= 2) polylines.push(chain.map((pointId) => pointsById[pointId]!));
  }
  if (polylines.length === 0) return null;
  polylines.sort((a, b) => polylineLength(b) - polylineLength(a));
  const simplified = polylines
    .map((poly) => simplifyPolyline(poly, grid.cell * 0.6))
    .filter((poly) => poly.length >= 2);
  if (simplified.length === 0) return null;
  return { lines: simplified, components: simplified.length };
}

/** Самая длинная связная часть равноудалённой линии раздела; `null` — не найдена. */
export function autoDivideLine(grid: ZoneGrid): AutoLineResult | null {
  const result = autoDivideLines(grid);
  if (result === null || result.lines.length === 0) return null;
  return { points: result.lines[0]!, components: result.components };
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
  return buildInitialPairLineInfo(areaA, areaB)?.line ?? null;
}

function toAutoPairLine(points: readonly AreaPoint[]): PairLine {
  const curve = sampleLine(points);
  if (curve === null) return { manual: false, points, anchors: [] };
  const mid = curvePointAt(curve, 0.5, false);
  const opened = beginLineEdit(points, mid, Number.POSITIVE_INFINITY);
  return { manual: false, points, anchors: opened.ok ? opened.state.anchors : [] };
}

/** Автолинии (основная и дополнительные компоненты) плюс число частей зоны. */
export function buildInitialPairLineInfo(
  areaA: Area,
  areaB: Area,
): { line: PairLine; extraLines: readonly PairLine[]; components: number } | null {
  const grid = computeAreaZoneGrid(areaA, areaB);
  if (grid === null) return null;
  const auto = autoDivideLines(grid);
  if (auto === null || auto.lines.length === 0) return null;
  const built = auto.lines.map((pts) => toAutoPairLine(pts));
  return {
    line: built[0]!,
    extraLines: built.slice(1),
    components: auto.components,
  };
}

/* --------------------------------------------------------- стороны раздела */

export interface SideMasks {
  /** Ячейки зоны, отнесённые к области А (заливка А глубже). */
  readonly aSide: Uint8Array;
  /** Ячейки зоны, отнесённые к области Б. */
  readonly bSide: Uint8Array;
}

/**
 * Делит зону линией на связные части и относит их к А или Б по знаку
 * `distA − distB` (линия может быть ручной и не совпадать с хребтом).
 *
 * Дефекты ревью B4.1–B4.3 закрыты:
 *  - полоса двойного наложения: ячейки барьера вокруг линии **не остаются**
 *    неразделёнными — после раздела частей они раздаются ближайшей стороне
 *    (двухисточникный поиск в ширину, ничья — по знаку поля);
 *  - утечка вокруг конца ручной линии: свободный конец, внесённый внутрь
 *    зоны, запечатывается путём до границы зоны (кратчайший поиск в ширину),
 *    поэтому обхода «вокруг конца» не существует;
 *  - несколько раздельных частей зоны: часть, не накрытая линией (другая
 *    «линза» пары), делится автоматическим правилом знака поля, а не целиком
 *    отдаётся одной стороне.
 */
function normalizeLinesInput(
  linePointsOrLines: readonly AreaPoint[] | readonly (readonly AreaPoint[])[],
): readonly (readonly AreaPoint[])[] {
  if (linePointsOrLines.length === 0) return [];
  const first = linePointsOrLines[0];
  if (Array.isArray(first) && typeof first[0] === 'number') {
    return [linePointsOrLines as readonly AreaPoint[]];
  }
  return linePointsOrLines as readonly (readonly AreaPoint[])[];
}

export function sideMasks(
  grid: ZoneGrid,
  linePointsOrLines: readonly AreaPoint[] | readonly (readonly AreaPoint[])[],
): SideMasks {
  const { w, h, zone, inA, inB, diffField } = grid;
  const size = w * h;
  const aSide = new Uint8Array(size);
  const bSide = new Uint8Array(size);
  const signToA = (index: number): boolean => diffField[index]! > 0;
  const lines = normalizeLinesInput(linePointsOrLines).filter((line) => line.length >= 2);
  if (lines.length === 0) {
    // Линии нет: вся зона делится по знаку расстояний (автоправило).
    for (let index = 0; index < size; index += 1) {
      if (zone[index] !== 1) continue;
      if (signToA(index)) aSide[index] = 1;
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
      for (const linePoints of lines) {
        if (distanceToPolyline(linePoints, x, y) <= reach) {
          blocked[index] = 1;
          break;
        }
      }
    }
  }
  const cellIndexAt = (x: number, y: number): number => {
    const i = Math.round((x - grid.x0) / grid.cell - 0.5);
    const j = Math.round((y - grid.y0) / grid.cell - 0.5);
    if (i < 0 || j < 0 || i >= w || j >= h) return -1;
    return j * w + i;
  };
  // Свободные концы каждой линии внутри зоны запечатываются путём до границы зоны:
  // ячейки пути добавляются в барьер, обход «вокруг конца» становится невозможен.
  const queue = new Int32Array(size);
  for (const linePoints of lines) {
    for (const endPoint of [linePoints[0]!, linePoints[linePoints.length - 1]!]) {
      const startCell = cellIndexAt(endPoint[0], endPoint[1]);
      if (startCell < 0 || zone[startCell] !== 1) continue;
      const parent = new Int32Array(size).fill(-2);
      let head = 0;
      let tail = 0;
      queue[tail++] = startCell;
      parent[startCell] = -1;
      let boundaryCell = -1;
      while (head < tail && boundaryCell < 0) {
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
          if (zone[neighbour] !== 1 || parent[neighbour] !== -2) continue;
          const ni = neighbour % w;
          const nj = (neighbour - ni) / w;
          const onBoundary = ni === 0 || nj === 0 || ni === w - 1 || nj === h - 1
            || (ni > 0 && zone[neighbour - 1] !== 1)
            || (ni + 1 < w && zone[neighbour + 1] !== 1)
            || (nj > 0 && zone[neighbour - w] !== 1)
            || (nj + 1 < h && zone[neighbour + w] !== 1);
          parent[neighbour] = cellIndex;
          queue[tail++] = neighbour;
          if (onBoundary) {
            boundaryCell = neighbour;
            break;
          }
        }
      }
      if (boundaryCell < 0) continue;
      for (let walk = boundaryCell; walk >= 0; walk = parent[walk]!) blocked[walk] = 1;
    }
  }
  // Связные части зоны (барьер игнорируется): управляемые линиями части делятся
  // на связные куски и относятся к А/Б антисимметрично (контакт с А\Б vs Б\А
  // и поле `diffField`); прочие части делятся автоправилом.
  const component = new Int32Array(size).fill(-1);
  const diff = (index: number): number => diffField[index]!;
  let componentIndex = 0;
  for (let start = 0; start < size; start += 1) {
    if (zone[start] !== 1 || component[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = componentIndex;
    const members: number[] = [start];
    let hasLine = blocked[start] === 1;
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
        if (zone[neighbour] !== 1 || component[neighbour] !== -1) continue;
        component[neighbour] = componentIndex;
        queue[tail++] = neighbour;
        members.push(neighbour);
        if (blocked[neighbour] === 1) hasLine = true;
      }
    }
    if (!hasLine) {
      // Часть зоны без линии (вторая линза пары): честный автосplit по знаку
      // поля вместо отдачи всей части одной области (дефект B4.3).
      for (const member of members) {
        if (signToA(member)) aSide[member] = 1;
        else bSide[member] = 1;
      }
    } else {
      const partAssigned = new Uint8Array(size);
      interface PartStats {
        readonly cells: number[];
        readonly sumDiff: number;
        readonly contactA: number;
        readonly contactB: number;
      }
      const parts: PartStats[] = [];
      let totalContactA = 0;
      let totalContactB = 0;
      for (const member of members) {
        if (blocked[member] === 1 || partAssigned[member] === 1) continue;
        let head2 = 0;
        let tail2 = 0;
        queue[tail2++] = member;
        partAssigned[member] = 1;
        const part: number[] = [member];
        let sum = 0;
        let contactA = 0;
        let contactB = 0;
        while (head2 < tail2) {
          const cellIndex = queue[head2++]!;
          sum += diff(cellIndex);
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
            if (zone[neighbour] !== 1) {
              if (inA[neighbour] === 1 && inB[neighbour] === 0) contactA += 1;
              else if (inB[neighbour] === 1 && inA[neighbour] === 0) contactB += 1;
              continue;
            }
            if (component[neighbour] !== componentIndex) continue;
            if (blocked[neighbour] === 1 || partAssigned[neighbour] === 1) continue;
            partAssigned[neighbour] = 1;
            queue[tail2++] = neighbour;
            part.push(neighbour);
          }
        }
        totalContactA += contactA;
        totalContactB += contactB;
        parts.push({ cells: part, sumDiff: sum, contactA, contactB });
      }
      if (parts.length > 0) {
        const scores = parts.map((entry) => {
          const contactSum = entry.contactA + entry.contactB;
          if (contactSum > 0) {
            return (entry.contactA - entry.contactB) / contactSum;
          }
          return entry.sumDiff / entry.cells.length;
        });
        let choices = parts.map((entry, idx) => {
          if (entry.sumDiff > 0) return true;
          if (entry.sumDiff < 0) return false;
          return scores[idx]! > 0;
        });
        // Если линия смещена (например, в Т-пересечении) так, что оба остатка
        // имеют одинаковый знак `sumDiff`, при наличии контактов с обеими
        // областями делим строго антисимметрично по нормированному контакту.
        if (parts.length >= 2 && totalContactA > 0 && totalContactB > 0) {
          const allTrue = choices.every(Boolean);
          const allFalse = choices.every((value) => !value);
          if (allTrue || allFalse) {
            let maxScore = -Infinity;
            let minScore = Infinity;
            for (const s of scores) {
              if (s > maxScore) maxScore = s;
              if (s < minScore) minScore = s;
            }
            if (maxScore - minScore > 1e-9) {
              const midpoint = (maxScore + minScore) / 2;
              choices = scores.map((s) => s > midpoint);
            }
          }
        }
        for (let idx = 0; idx < parts.length; idx += 1) {
          const toA = choices[idx]!;
          for (const memberIndex of parts[idx]!.cells) {
            if (toA) aSide[memberIndex] = 1;
            else bSide[memberIndex] = 1;
          }
        }
      }
    }
    componentIndex += 1;
  }
  // Полоса барьера раздаётся ближайшей стороне: два встречных поиска в ширину
  // от уже назначенных ячеек; ничья — по знаку поля (дефект B4.1).
  const distToA = new Int32Array(size).fill(-1);
  const distToB = new Int32Array(size).fill(-1);
  const bfsFrom = (seeds: Uint8Array, target: Int32Array): void => {
    let head = 0;
    let tail = 0;
    for (let index = 0; index < size; index += 1) {
      if (seeds[index] === 1) {
        target[index] = 0;
        queue[tail++] = index;
      }
    }
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
        if (zone[neighbour] !== 1 || target[neighbour] !== -1) continue;
        target[neighbour] = target[cellIndex]! + 1;
        queue[tail++] = neighbour;
      }
    }
  };
  bfsFrom(aSide, distToA);
  bfsFrom(bSide, distToB);
  for (let index = 0; index < size; index += 1) {
    if (zone[index] !== 1) continue;
    if (aSide[index] === 1 || bSide[index] === 1) continue;
    const da = distToA[index]!;
    const db = distToB[index]!;
    let toA: boolean;
    if (da >= 0 && db >= 0 && da !== db) toA = da < db;
    else toA = signToA(index);
    if (toA) aSide[index] = 1;
    else bSide[index] = 1;
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

function ringBoundaryCrosses(ringA: Ring, ringB: Ring): boolean {
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
  return false;
}

/** Пересекаются ли два кольца: рёбра или вложенность. */
export function ringsIntersect(ringA: Ring, ringB: Ring): boolean {
  if (ringBoundaryCrosses(ringA, ringB)) return true;
  if (ringA.length < 3 || ringB.length < 3) return false;
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

/** Все положительные контуры области по ID; `[]` — не найдена или нет замкнутых единиц. */
function ringsOfArea(doc: SectorAreasDoc, areaId: string): readonly Ring[] {
  const area = doc.areas.find((entry) => entry.id === areaId);
  return area === undefined ? [] : positiveContourRingsOf(area);
}

function ringsListIntersect(ringsA: readonly Ring[], ringsB: readonly Ring[]): boolean {
  for (const ringA of ringsA) {
    for (const ringB of ringsB) {
      if (ringsIntersect(ringA, ringB)) return true;
    }
  }
  return false;
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
  const candidateRings = nextRings.filter((ring) => ring.length >= 3);
  if (candidateRings.length === 0) return null;
  for (const pair of pairsOf(doc)) {
    if (!pair.forbidCrossing) continue;
    if (pair.areaA !== areaId && pair.areaB !== areaId) continue;
    const otherId = pair.areaA === areaId ? pair.areaB : pair.areaA;
    const otherRings = ringsOfArea(doc, otherId);
    if (otherRings.length === 0) continue;
    const nowIntersect = ringsListIntersect(candidateRings, otherRings);
    if (!nowIntersect) continue;
    const currentRings = ringsOfArea(doc, areaId);
    const beforeIntersect = currentRings.length > 0 && ringsListIntersect(currentRings, otherRings);
    if (!beforeIntersect) {
      return `Сочетание ${pair.id} (${areaId}+${otherId}): пересечение запрещено правилом пары. Правка отклонена, контуры не изменены.`;
    }
  }
  return null;
}

function pointNearZoneCell(grid: ZoneGrid, pt: AreaPoint, tolerance: number): boolean {
  const i = Math.floor((pt[0] - grid.x0) / grid.cell);
  const j = Math.floor((pt[1] - grid.y0) / grid.cell);
  if (i >= 0 && j >= 0 && i < grid.w && j < grid.h && grid.zone[j * grid.w + i] === 1) return true;
  for (let dj = -2; dj <= 2; dj += 1) {
    for (let di = -2; di <= 2; di += 1) {
      const ni = i + di;
      const nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < grid.w && nj < grid.h && grid.zone[nj * grid.w + ni] === 1) {
        const cx = grid.x0 + (ni + 0.5) * grid.cell;
        const cy = grid.y0 + (nj + 0.5) * grid.cell;
        if (Math.hypot(cx - pt[0], cy - pt[1]) <= tolerance) return true;
      }
    }
  }
  return false;
}

function manualLineInsideZone(grid: ZoneGrid, line: PairLine): boolean {
  const tolerance = grid.cell * 2;
  const checkPoints: readonly AreaPoint[] = line.anchors.length > 0
    ? line.anchors.map((a) => a.point)
    : line.points;
  if (checkPoints.length === 0) return false;
  for (const pt of checkPoints) {
    if (!pointNearZoneCell(grid, pt, tolerance)) return false;
  }
  return true;
}

function allManualLinesInsideZone(grid: ZoneGrid, lines: readonly PairLine[]): boolean {
  for (const line of lines) {
    if (line.manual && !manualLineInsideZone(grid, line)) return false;
  }
  return true;
}

function zoneComponentCount(grid: ZoneGrid): number {
  const { w, h, zone } = grid;
  const size = w * h;
  const seen = new Uint8Array(size);
  const queue = new Int32Array(size);
  let count = 0;
  for (let start = 0; start < size; start += 1) {
    if (zone[start] !== 1 || seen[start] === 1) continue;
    count += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const idx = queue[head++]!;
      const i = idx % w;
      const j = (idx - i) / w;
      const neighbours = [
        i > 0 ? idx - 1 : -1,
        i + 1 < w ? idx + 1 : -1,
        j > 0 ? idx - w : -1,
        j + 1 < h ? idx + w : -1,
      ];
      for (const n of neighbours) {
        if (n >= 0 && zone[n] === 1 && seen[n] === 0) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
    }
  }
  return count;
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
    const { extraLines: _dropped, ...pairRest } = pair;
    const grid = computeAreaZoneGrid(areaA, areaB);
    if (grid === null || grid.zoneCells < PAIR_MIN_ZONE_CELLS) {
      changed.push(pair.id);
      const anyManual = Boolean(pair.line?.manual) || Boolean(pair.extraLines?.some((l) => l.manual));
      if (!anyManual) {
        return { ...pairRest, line: null, needsReview: true, note: 'Зона взаимодействия исчезла после правки контура.' };
      }
      return { ...pair, needsReview: true, note: 'Зона взаимодействия исчезла: ручная линия сохранена, но не применяется.' };
    }
    const existingLines = pairLinesOf(pair);
    const anyManual = existingLines.some((line) => line.manual);
    if (!anyManual) {
      const info = buildInitialPairLineInfo(areaA, areaB);
      changed.push(pair.id);
      if (info === null) {
        return { ...pairRest, line: null, needsReview: false, note: null };
      }
      return {
        ...pairRest,
        line: info.line,
        ...(info.extraLines.length > 0 ? { extraLines: info.extraLines } : {}),
        needsReview: false,
        note: info.components > 1 ? multiComponentNote(info.components) : null,
      };
    }
    const inside = allManualLinesInsideZone(grid, existingLines);
    const components = zoneComponentCount(grid);
    if (!inside) {
      changed.push(pair.id);
      return { ...pair, needsReview: true, note: 'Контур области изменился: ручная линия сохранена, но вышла из зоны взаимодействия.' };
    }
    const targetNote = components > 1
      ? multiComponentNote(components)
      : (pair.needsReview || isAutoGeneratedPairNote(pair.note) ? null : pair.note);
    if (pair.needsReview || pair.note !== targetNote) {
      changed.push(pair.id);
      return { ...pair, needsReview: false, note: targetNote };
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
 * стороне другой. Для `overlay` рендер вызывать не должен. `null` — зоны нет.
 */
export function splitRegionsForPair(areaA: Area, areaB: Area, pair: AreaPair): PairSplitRegions | null {
  if (pair.mode !== 'split') return null;
  const grid = computeAreaZoneGrid(areaA, areaB);
  if (grid === null || grid.zoneCells < PAIR_MIN_ZONE_CELLS) return null;
  const stored = pairLinesOf(pair)
    .map((line) => line.points)
    .filter((pts) => pts.length >= 2);
  const lineSets = stored.length > 0 ? stored : (autoDivideLines(grid)?.lines ?? []);
  const masks = sideMasks(grid, lineSets);
  const polygons = winPolygons(grid, masks);
  return { pairId: pair.id, aHoles: polygons.bWin, bHoles: polygons.aWin };
}
