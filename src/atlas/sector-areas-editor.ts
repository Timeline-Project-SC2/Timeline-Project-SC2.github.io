/* Операции редактора границ: кисть, секторный снап, вершины, состояния,
 * история и экспорт (шаг 3 §11 части 2 плана).
 *
 * Слой намеренно **без DOM и без рендера**: это команды над документом.
 * Интерфейс (canvas, панели, хоткеи) вызывает их и сам отвечает за отрисовку.
 * Каждая команда возвращает новую сессию: прошлое уходит в `past`, событие
 * записывается в журнал документа, `undo`/`redo` ходят по той же истории.
 *
 * Решения владельца: свободная кисть по умолчанию, секторный снап — опция;
 * мазок форс-закрашивания коммитится сразу; на один режим — несколько
 * состояний с выбором по приоритету; родитель — явный `parentId`.
 */

import { addressOf, formatAddress, prefixOf, rectOf } from './sector-address.ts';
import type { AddressLetters } from './sector-address.ts';
import { createArea, emptySectorAreasDoc, parseSectorAreas } from './sector-areas-contract.ts';
import { createOverrideStroke } from './sector-areas-force.ts';
import { ringCentroid } from './sector-areas-geometry.ts';
import { classifyArea, classifyLocation } from './sector-areas-scope.ts';
import type { ClassifyOptions, Scope } from './sector-areas-scope.ts';
import { snapStrokeToDisplayedGrid } from './sector-areas-snap.ts';
import type { FrameViewport, SceneCamera } from './sector-scene.ts';
import type {
  Area,
  AreaLocation,
  AreaPoint,
  AreaState,
  AreaStroke,
  GradientSpec,
  Mode,
  Ring,
  Rounding,
  SectorAreasDoc,
} from './sector-areas-contract.ts';
import { MAX_LEVEL, MIN_LEVEL } from './sector-areas-contract.ts';

export type SnapMode = 'free' | 'sector' | 'grid';

export interface EditorSession {
  readonly doc: SectorAreasDoc;
  readonly past: readonly SectorAreasDoc[];
  readonly future: readonly SectorAreasDoc[];
  /** Активный выбор до каждого шага `past` — восстанавливается при `undo`. */
  readonly pastSelections?: readonly (string | null)[];
  /** Активный выбор на каждом шаге `future` — восстанавливается при `redo`. */
  readonly futureSelections?: readonly (string | null)[];
  /** Режим по умолчанию для новой кисти: не меняет уже созданные состояния. */
  readonly mode: Mode;
  /** `free` — без привязки; `grid` — к рёбрам отображаемой адресной сетки; `sector` — к ячейке. */
  readonly snapMode: SnapMode;
  /** Ширина кисти в экранных пикселях; переводится в мировые по масштабу. */
  readonly brushWidthPx: number;
  readonly selection: string | null;
  readonly sequence: number;
}

/**
 * Следующий свободный номер для `area-*`, `stroke-*`, `state-*`, `ev-*` и `force-*`.
 *
 * Номер обязан продолжаться, а не начинаться заново: иначе загрузка черновика
 * и импорт документа давали бы повторяющиеся идентификаторы. Считаем по
 * числовым хвостам уже существующих идентификаторов.
 */
export function nextSequence(doc: SectorAreasDoc): number {
  let maximum = 0;
  const consider = (id: string): void => {
    const match = /-(\d+)$/.exec(id);
    if (match === null) return;
    const value = Number(match[1]);
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  };
  for (const area of doc.areas) {
    consider(area.id);
    for (const state of area.states) consider(state.id);
    for (const stroke of area.strokes ?? []) consider(stroke.id);
  }
  for (const override of doc.overrides) consider(override.id);
  for (const event of doc.events) consider(event.id);
  return maximum + 1;
}

export function createEditorSession(doc?: SectorAreasDoc): EditorSession {
  const initial = doc ?? emptySectorAreasDoc();
  return {
    doc: initial,
    past: [],
    future: [],
    pastSelections: [],
    futureSelections: [],
    mode: 'political',
    snapMode: 'free',
    brushWidthPx: 8,
    selection: null,
    sequence: nextSequence(initial),
  };
}

/* ------------------------------------------------------------------ история */

function commit(
  session: EditorSession,
  doc: SectorAreasDoc,
  event: { kind: string; areaId: string | null; mode: Mode | null; note: string },
  nextSelection?: string | null,
): EditorSession {
  const id = `ev-${session.sequence}`;
  const committedDoc: SectorAreasDoc = {
    ...doc,
    events: [...doc.events, { id, kind: event.kind, areaId: event.areaId, mode: event.mode, note: event.note }],
  };
  const pastSelections = session.pastSelections ?? session.past.map(() => null);
  return {
    ...session,
    doc: committedDoc,
    past: [...session.past, session.doc],
    pastSelections: [...pastSelections, session.selection],
    future: [],
    futureSelections: [],
    selection: nextSelection === undefined ? session.selection : nextSelection,
    sequence: Math.max(session.sequence + 1, nextSequence(committedDoc)),
  };
}

export function canUndo(session: EditorSession): boolean {
  return session.past.length > 0;
}

export function canRedo(session: EditorSession): boolean {
  return session.future.length > 0;
}

export function undo(session: EditorSession): EditorSession {
  const previous = session.past.at(-1);
  if (previous === undefined) return session;
  const pastSelections = session.pastSelections ?? [];
  const hasTrackedSelection = pastSelections.length === session.past.length;
  const fallbackSelection = session.selection !== null
    && previous.areas.some((area) => area.id === session.selection)
    ? session.selection
    : null;
  const restoredSelection = hasTrackedSelection
    ? (pastSelections.at(-1) ?? null)
    : fallbackSelection;
  return {
    ...session,
    doc: previous,
    past: session.past.slice(0, -1),
    pastSelections: hasTrackedSelection ? pastSelections.slice(0, -1) : pastSelections,
    future: [session.doc, ...session.future],
    futureSelections: [session.selection, ...(session.futureSelections ?? [])],
    selection: restoredSelection,
  };
}

export function redo(session: EditorSession): EditorSession {
  const next = session.future[0];
  if (next === undefined) return session;
  const futureSelections = session.futureSelections ?? [];
  const hasTrackedSelection = futureSelections.length === session.future.length;
  const restoredSelection = hasTrackedSelection
    ? (futureSelections[0] ?? null)
    : session.selection;
  return {
    ...session,
    doc: next,
    past: [...session.past, session.doc],
    pastSelections: [...(session.pastSelections ?? session.past.map(() => null)), session.selection],
    future: session.future.slice(1),
    futureSelections: hasTrackedSelection ? futureSelections.slice(1) : futureSelections,
    selection: restoredSelection,
  };
}

/* -------------------------------------------------------------- настройки */

export function setMode(session: EditorSession, mode: Mode): EditorSession {
  return { ...session, mode };
}

export function setSnapMode(session: EditorSession, snapMode: SnapMode): EditorSession {
  return { ...session, snapMode };
}

export function setBrushWidth(session: EditorSession, pixels: number): EditorSession {
  if (!Number.isFinite(pixels) || pixels <= 0) throw new RangeError('Ширина кисти должна быть положительным числом');
  return { ...session, brushWidthPx: pixels };
}

export function selectArea(session: EditorSession, areaId: string | null): EditorSession {
  return { ...session, selection: areaId };
}

/** Перевод ширины кисти из экранных пикселей в мировые единицы. */
export function brushWidthInWorld(session: EditorSession, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError('Масштаб кадра должен быть положительным числом');
  return session.brushWidthPx / scale;
}

/* ------------------------------------------------------------------ геометрия */

/**
 * Раздувает ломаную в контур заданной ширины: сдвиг влево по ходу пути и
 * обратно вправо. Стыки сегментов не сглаживаются (митер не строится) —
 * этого достаточно для редактора, а не для полигональной булевой операции.
 */
export function thickenStroke(points: readonly AreaPoint[], width: number, closed = true): Ring {
  if (points.length < 2 || !(width > 0)) return closed ? closeRing(points) : [...points];

  const left: AreaPoint[] = [];
  const right: AreaPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * (width / 2);
    const ny = (dx / length) * (width / 2);
    left.push([points[i]![0] + nx, points[i]![1] + ny]);
    right.push([points[i]![0] - nx, points[i]![1] - ny]);
  }

  const ring = closed
    ? [...left, ...right.reverse()]
    : [...left, ...right.reverse()];
  return closed ? closeRing(ring) : ring;
}

function closeRing(points: readonly AreaPoint[]): Ring {
  const first = points[0];
  if (first === undefined) return [];
  return [...points, [first[0], first[1]]];
}

/** Адрес по центру области: справочный, а не обязательный. */
export function addressForRing(ring: Ring, closed = true): string {
  const [x, y] = ringCentroid(ring, closed);
  const clampedX = Math.max(0, Math.min(9999.999, x));
  const clampedY = Math.max(0, Math.min(9999.999, y));
  return formatAddress(addressOf(clampedX, clampedY));
}

/* -------------------------------------------------------------- созд области */

export interface StrokeInput {
  readonly id: string;
  readonly name: string;
  readonly points: readonly AreaPoint[];
  readonly closed?: boolean;
  /** Ширина в мировых единицах; `0` — контур по центру штриха. */
  readonly width?: number;
  readonly parentId?: string | null;
  readonly source?: Area['source'];
  /**
   * Состояние, создаваемое вместе с областью. Без него область остаётся
   * невидимой: рендер показывает только области с состоянием на этом уровне.
   * Передаётся сразу, чтобы «создать» и «показать» были одной отменой.
   */
  readonly state?: AreaState;
  /**
   * Положение области. Открытая линия площади не имеет, поэтому для неё
   * передаётся `unknown`: классифицировать несуществующую площадь нельзя.
   * Без параметра поле остаётся `null`.
   */
  readonly location?: AreaLocation | null;
}

/** Свободная кисть: произвольный полигон в мировых координатах. */
export function addAreaFromStroke(session: EditorSession, input: StrokeInput): EditorSession {
  const closed = input.closed ?? true;
  const minimum = closed ? 3 : 2;
  if (input.points.length < minimum) {
    throw new RangeError(`Штрих должен содержать минимум ${minimum} точки`);
  }
  const ring = thickenStroke(input.points, input.width ?? 0, closed);
  const created = createArea({
    id: input.id,
    name: input.name,
    rings: [ring],
    parentId: input.parentId ?? null,
    address: addressForRing(ring, closed),
    closed,
    source: input.source ?? 'brush',
  });
  // `createArea` всегда создаёт область без состояний; состояние прикладываем
  // сразу, иначе область появляется в документе, но остаётся невидимой.
  const withState: Area = input.state === undefined ? created : { ...created, states: [input.state] };
  // Положение задаётся вызывающей стороной: у открытой линии нет площади,
  // поэтому её `location` — `unknown`, а не результат классификации по ней.
  const area: Area = input.location === undefined
    ? withState
    : { ...withState, location: input.location };

  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return commit(
    session,
    doc,
    { kind: 'create', areaId: area.id, mode: session.mode, note: `Создана область «${area.name}» кистью` },
    area.id,
  );
}

export interface SectorCellInput {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** Глубина адреса `0…7`; по умолчанию — пять букв (`T5`). */
  readonly letters?: AddressLetters;
  /**
   * Состояние, создаваемое вместе с областью. Без него область остаётся
   * невидимой: рендер показывает только области с состоянием на этом уровне.
   * Передаётся сразу, чтобы «создать» и «показать» были одной отменой.
   */
  readonly state?: AreaState;
}

/**
 * Секторный снап: кисть «прилипает» к ячейке текущего уровня. Адрес
 * канонический, родитель — существующая область ячейки предыдущего тира.
 */
export function addAreaFromSectorCell(session: EditorSession, input: SectorCellInput): EditorSession {
  const letters = input.letters ?? 5;
  // Прямоугольник ячейки `rectOf` берётся только из полного адреса (5–7 букв,
  // §7.2 канона адреса): более крупные тиры в секторном снапе не используются.
  if (letters < 5 || letters > 7) {
    throw new RangeError('Секторный снап работает на глубине 5…7 букв адреса');
  }
  const address = prefixOf(input.x, input.y, letters);
  const rect = rectOf(address);
  const ring: Ring = [
    [rect.x, rect.y],
    [rect.x + rect.size, rect.y],
    [rect.x + rect.size, rect.y + rect.size],
    [rect.x, rect.y + rect.size],
    [rect.x, rect.y],
  ];
  const parentAddress = letters > 1 ? formatAddress(prefixOf(input.x, input.y, (letters - 1) as AddressLetters)) : null;
  const parentId = parentAddress === null
    ? null
    : (session.doc.areas.find((area) => area.address === parentAddress)?.id ?? null);

  const created = createArea({
    id: input.id,
    name: input.name,
    rings: [ring],
    parentId,
    address: formatAddress(address),
    source: 'sector',
  });
  const area: Area = input.state === undefined ? created : { ...created, states: [input.state] };

  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return commit(
    session,
    doc,
    { kind: 'create', areaId: area.id, mode: session.mode, note: `Создана область «${area.name}» по ячейке ${area.address ?? ''}` },
    area.id,
  );
}

/* ------------------------------------------- пустая область и несколько штрихов */

export interface CreateEmptyAreaInput {
  readonly id?: string;
  readonly name?: string;
  readonly parentId?: string | null;
  readonly source?: Area['source'];
  readonly state?: AreaState;
}

/**
 * Команда «Создать новую область»: создаёт пустую область (`rings: []`, `strokes: []`)
 * и переключает активный выбор (`selection`) на её идентификатор.
 * При отмене (`undo`) пустая область удаляется и восстанавливается прежний активный ID.
 */
export function createEmptyArea(
  session: EditorSession,
  input?: CreateEmptyAreaInput,
): EditorSession {
  const id = input?.id ?? `area-${session.sequence}`;
  if (session.doc.areas.some((area) => area.id === id)) {
    throw new RangeError(`Область ${id} уже существует`);
  }
  const name = input?.name ?? `Область ${session.sequence}`;
  const created = createArea({
    id,
    name,
    rings: [],
    strokes: [],
    parentId: input?.parentId ?? null,
    address: null,
    closed: true,
    source: input?.source ?? 'brush',
  });
  const area: Area = input?.state === undefined ? created : { ...created, states: [input.state] };
  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return commit(
    session,
    doc,
    { kind: 'create', areaId: area.id, mode: session.mode, note: `Создана пустая область «${area.name}»` },
    area.id,
  );
}

function normalizeStrokeForArea(stroke: AreaStroke): AreaStroke {
  if (stroke.id.trim().length === 0) {
    throw new RangeError('Идентификатор штриха не может быть пустым');
  }
  const points = stroke.points.map((point): AreaPoint => [point[0], point[1]]);
  if (stroke.closed && points.length >= 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      points.pop();
    }
  }
  const minimum = stroke.closed ? 3 : 2;
  if (points.length < minimum) {
    throw new RangeError(`Штрих должен содержать минимум ${minimum} вершин`);
  }
  return {
    id: stroke.id,
    points,
    closed: stroke.closed,
  };
}

function strokeIdExists(doc: SectorAreasDoc, strokeId: string): boolean {
  for (const area of doc.areas) {
    for (const stroke of area.strokes ?? []) {
      if (stroke.id === strokeId) return true;
    }
  }
  return false;
}

export interface AddStrokeInput {
  readonly areaId: string;
  readonly stroke: AreaStroke;
  /** Если у целевой пустой области ещё нет состояний, прикладывает состояние в той же команде. */
  readonly stateIfEmpty?: AreaState;
}

/**
 * Добавляет один завершённый штрих в указанную область как одну команду истории,
 * не переиспользуя и не изменяя `area.rings` и отверстия.
 */
export function addStrokeToArea(session: EditorSession, input: AddStrokeInput): EditorSession {
  const normalized = normalizeStrokeForArea(input.stroke);
  if (strokeIdExists(session.doc, normalized.id)) {
    throw new RangeError(`Штрих ${normalized.id} уже существует в документе`);
  }
  const target = session.doc.areas.find((area) => area.id === input.areaId);
  if (target === undefined) {
    throw new RangeError(`Область ${input.areaId} не найдена`);
  }

  const nextAreas = session.doc.areas.map((area): Area => {
    if (area.id !== input.areaId) return area;
    const prevStrokes = area.strokes ?? [];
    const nextStrokes = [...prevStrokes, normalized];
    const nextAddress = area.address ?? addressForRing(normalized.points, normalized.closed);
    const nextStates = area.states.length === 0 && input.stateIfEmpty !== undefined
      ? [input.stateIfEmpty]
      : area.states;
    const hasClosedGeometry = (area.rings.length > 0 && area.closed)
      || nextStrokes.some((item) => item.closed);
    const nextLocation = area.scopeId === null && area.rings.length === 0
      ? (hasClosedGeometry ? null : 'unknown')
      : area.location;
    return {
      ...area,
      address: nextAddress,
      strokes: nextStrokes,
      states: nextStates,
      location: nextLocation,
    };
  });

  const doc: SectorAreasDoc = { ...session.doc, areas: nextAreas };
  return commit(
    session,
    doc,
    {
      kind: 'stroke',
      areaId: input.areaId,
      mode: session.mode,
      note: `Добавлен штрих ${normalized.id} в область «${target.name}»`,
    },
    input.areaId,
  );
}

export interface RecordStrokeInput {
  readonly stroke: AreaStroke;
  readonly areaIdIfNew?: string;
  readonly areaNameIfNew?: string;
  readonly state?: AreaState;
}

/**
 * Завершение одного штриха — ровно одна команда истории:
 * - если выбрана активная область (`selectedArea(session)`), продолжает её (`Area.strokes`);
 * - иначе создаёт новую область с этим первым штрихом и делает её активной.
 */
export function recordCompletedStroke(
  session: EditorSession,
  input: RecordStrokeInput,
): EditorSession {
  const active = selectedArea(session);
  if (active !== null) {
    return addStrokeToArea(session, {
      areaId: active.id,
      stroke: input.stroke,
      ...(input.state === undefined ? {} : { stateIfEmpty: input.state }),
    });
  }

  const normalized = normalizeStrokeForArea(input.stroke);
  if (strokeIdExists(session.doc, normalized.id)) {
    throw new RangeError(`Штрих ${normalized.id} уже существует в документе`);
  }
  const areaId = input.areaIdIfNew ?? `area-${session.sequence}`;
  const areaName = input.areaNameIfNew ?? `Область ${session.sequence}`;
  const created = createArea({
    id: areaId,
    name: areaName,
    rings: [],
    strokes: [normalized],
    address: addressForRing(normalized.points, normalized.closed),
    closed: true,
    source: 'brush',
  });
  const withState: Area = input.state === undefined ? created : { ...created, states: [input.state] };
  const area: Area = {
    ...withState,
    location: normalized.closed ? null : 'unknown',
  };
  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return commit(
    session,
    doc,
    {
      kind: 'create',
      areaId: area.id,
      mode: session.mode,
      note: `Создана область «${area.name}» со штрихом ${normalized.id}`,
    },
    area.id,
  );
}

/**
 * Привязывает точки штриха к отображаемой адресной сетке (когда `session.snapMode === 'grid'`)
 * и записывает завершённый штрих в текущую активную область одной командой истории.
 */
export function snapAndRecordStroke(
  session: EditorSession,
  input: RecordStrokeInput,
  viewport: FrameViewport,
  camera: SceneCamera,
): EditorSession {
  const stroke = session.snapMode === 'grid'
    ? {
      id: input.stroke.id,
      points: snapStrokeToDisplayedGrid(input.stroke.points, viewport, camera, {
        closed: input.stroke.closed,
      }).points,
      closed: input.stroke.closed,
    }
    : input.stroke;
  return recordCompletedStroke(session, { ...input, stroke });
}

/* ------------------------------------------------------------------ вершины */

/** Снимает замыкающую копию первой точки: работать удобнее с уникальными вершинами. */
function openRing(ring: Ring, closed: boolean): AreaPoint[] {
  const points = [...ring];
  if (closed && points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

function normalizeIndex(index: number, size: number): number {
  if (size <= 0) throw new RangeError('Кольцо пусто');
  return ((index % size) + size) % size;
}

function replaceRing(area: Area, ringIndex: number, ring: Ring): Area {
  return { ...area, rings: area.rings.map((item, index) => (index === ringIndex ? ring : item)) };
}

function syncClosure(ring: Ring, closed: boolean): Ring {
  if (!closed) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined) return ring;
  if (last !== undefined && last[0] === first[0] && last[1] === first[1]) return ring;
  return closeRing(ring);
}

function updateArea(
  session: EditorSession,
  areaId: string,
  update: (area: Area) => Area,
  note: string,
  kind = 'edit',
): EditorSession {
  const target = session.doc.areas.find((area) => area.id === areaId);
  if (target === undefined) throw new RangeError(`Область ${areaId} не найдена`);
  const next = update(target);
  const doc: SectorAreasDoc = {
    ...session.doc,
    areas: session.doc.areas.map((area) => (area.id === areaId ? next : area)),
  };
  return commit(session, doc, { kind, areaId, mode: session.mode, note });
}

export function moveVertex(
  session: EditorSession,
  areaId: string,
  ringIndex: number,
  vertexIndex: number,
  position: AreaPoint,
): EditorSession {
  return updateArea(session, areaId, (area) => {
    const ring = area.rings[ringIndex];
    if (ring === undefined) throw new RangeError(`Кольцо ${ringIndex} не найдено`);
    const base = openRing(ring, area.closed);
    const index = normalizeIndex(vertexIndex, base.length);
    const points = base.map((point, i) => (i === index ? position : point));
    return replaceRing(area, ringIndex, area.closed ? closeRing(points) : points);
  }, `Перемещена вершина ${vertexIndex} кольца ${ringIndex}`);
}


export function insertVertex(
  session: EditorSession,
  areaId: string,
  ringIndex: number,
  after: number,
  position: AreaPoint,
): EditorSession {
  return updateArea(session, areaId, (area) => {
    const ring = area.rings[ringIndex];
    if (ring === undefined) throw new RangeError(`Кольцо ${ringIndex} не найдено`);
    const base = openRing(ring, area.closed);
    const index = Math.max(0, Math.min(base.length, after + 1));
    const points = [...base.slice(0, index), position, ...base.slice(index)];
    return replaceRing(area, ringIndex, syncClosure(points, area.closed));
  }, `Добавлена вершина после ${after} кольца ${ringIndex}`);
}


export function removeVertex(
  session: EditorSession,
  areaId: string,
  ringIndex: number,
  vertexIndex: number,
): EditorSession {
  return updateArea(session, areaId, (area) => {
    const ring = area.rings[ringIndex];
    if (ring === undefined) throw new RangeError(`Кольцо ${ringIndex} не найдено`);
    const base = openRing(ring, area.closed);
    // Три уникальные вершины — минимум замкнутого полигона; ниже удалять нельзя.
    if (base.length <= 3) throw new RangeError('Нельзя удалить вершину: кольцо станет вырожденным');
    const index = normalizeIndex(vertexIndex, base.length);
    const points = [...base.slice(0, index), ...base.slice(index + 1)];
    return replaceRing(area, ringIndex, syncClosure(points, area.closed));
  }, `Удалена вершина ${vertexIndex} кольца ${ringIndex}`);
}


export function renameArea(session: EditorSession, areaId: string, name: string): EditorSession {
  return updateArea(session, areaId, (area) => ({ ...area, name }), `Область переименована в «${name}»`);
}

export function setParent(session: EditorSession, areaId: string, parentId: string | null): EditorSession {
  if (parentId === areaId) throw new RangeError('Область не может быть своим родителем');
  return updateArea(session, areaId, (area) => ({ ...area, parentId }), `Изменён родитель области на ${parentId ?? '—'}`);
}

export function removeArea(session: EditorSession, areaId: string): EditorSession {
  if (!session.doc.areas.some((area) => area.id === areaId)) throw new RangeError(`Область ${areaId} не найдена`);
  const doc: SectorAreasDoc = {
    ...session.doc,
    areas: session.doc.areas
      .filter((area) => area.id !== areaId)
      .map((area) => (area.parentId === areaId ? { ...area, parentId: null } : area)),
    overrides: session.doc.overrides.filter((override) => override.areaId !== areaId),
  };
  return commit(
    session,
    doc,
    { kind: 'remove', areaId, mode: session.mode, note: `Область ${areaId} удалена` },
    session.selection === areaId ? null : session.selection,
  );
}

/* ---------------------------------------------------------------- состояния */

/** Добавляет состояние или заменяет существующее с тем же `id`. */
export function setState(session: EditorSession, areaId: string, state: AreaState): EditorSession {
  return updateArea(session, areaId, (area) => {
    const exists = area.states.some((item) => item.id === state.id);
    return {
      ...area,
      states: exists
        ? area.states.map((item) => (item.id === state.id ? state : item))
        : [...area.states, state],
    };
  }, `Сохранено состояние ${state.id} режима ${state.mode}`);
}

export function removeState(session: EditorSession, areaId: string, stateId: string): EditorSession {
  return updateArea(session, areaId, (area) => ({
    ...area,
    states: area.states.filter((item) => item.id !== stateId),
  }), `Удалено состояние ${stateId}`);
}

/* -------------------------------------------------------------- две заливки */

export interface FillCheck {
  readonly ok: boolean;
  /** Причина отказа; `null` — заливка применима. */
  readonly reason: string | null;
}

/**
 * Годится ли область для заливки. Открытая линия площади не имеет: заливать её
 * нечем, поэтому оба действия заливки на ней отказывают, а не делают вид работы.
 */
export function canFillArea(area: Area | null): FillCheck {
  if (area === null) return { ok: false, reason: 'Область не выбрана.' };
  const hasClosedRing = area.rings.length > 0 && area.closed;
  const hasClosedStroke = (area.strokes ?? []).some((stroke) => stroke.closed);
  if (!hasClosedRing && !hasClosedStroke) {
    if (area.rings.length === 0 && (area.strokes?.length ?? 0) === 0) {
      return { ok: false, reason: 'Пустая область не заливается: добавьте замкнутый контур.' };
    }
    return { ok: false, reason: 'Открытая линия не заливается: площади у неё нет.' };
  }
  return { ok: true, reason: null };
}

export interface StateFillInput {
  readonly areaId: string;
  /**
   * Готовое состояние: его собирает интерфейс из выбранной фракции, чтобы слой
   * команд не знал про палитру. Нейтральная фракция — `factionMode: 'neutral'`.
   */
  readonly state: AreaState;
}

/**
 * Заливка замкнутой фигуры как её состояния — второе, отдельное действие.
 *
 * Отличие от форс-закрашивания принципиальное и его нельзя прятать: здесь
 * меняется `area.states`, то есть сама окраска области в документе, а слой
 * `overrides` не трогается вовсе. Форс-закрашивание делает наоборот — кладёт
 * мазок поверх и состояния сохраняет.
 */
export function fillShapeAsState(session: EditorSession, input: StateFillInput): EditorSession {
  const area = session.doc.areas.find((item) => item.id === input.areaId) ?? null;
  const check = canFillArea(area);
  if (!check.ok) throw new RangeError(check.reason ?? 'Залить фигуру нельзя.');
  return updateArea(
    session,
    input.areaId,
    (item) => {
      const exists = item.states.some((state) => state.id === input.state.id);
      return {
        ...item,
        states: exists
          ? item.states.map((state) => (state.id === input.state.id ? input.state : state))
          : [...item.states, input.state],
      };
    },
    `Заливка как состояние ${input.state.id} режима ${input.state.mode}`,
    // Вид события `state`, а не `edit`: в журнале обе заливки различимы сразу —
    // форс-закрашивание пишется видом `override` и лежит в слое `overrides`.
    'state',
  );
}

export function setGradient(session: EditorSession, areaId: string, stateId: string, gradient: GradientSpec): EditorSession {
  return updateArea(session, areaId, (area) => ({
    ...area,
    states: area.states.map((item) => (item.id === stateId ? { ...item, gradient } : item)),
  }), `Изменён градиент состояния ${stateId}`);
}

export function setLod(
  session: EditorSession,
  areaId: string,
  stateId: string,
  lod: { readonly lodBias?: number; readonly rounding?: Rounding },
): EditorSession {
  return updateArea(session, areaId, (area) => ({
    ...area,
    states: area.states.map((item) => (item.id === stateId
      ? {
        ...item,
        ...(lod.lodBias === undefined ? {} : { lodBias: lod.lodBias }),
        ...(lod.rounding === undefined ? {} : { rounding: lod.rounding }),
      }
      : item)),
  }), `Изменена детализация состояния ${stateId}`);
}

export function setVisibility(
  session: EditorSession,
  areaId: string,
  stateId: string,
  range: { readonly from?: number; readonly to?: number },
): EditorSession {
  return updateArea(session, areaId, (area) => ({
    ...area,
    states: area.states.map((item) => (item.id === stateId
      ? {
        ...item,
        visibleFrom: range.from === undefined ? item.visibleFrom : Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(range.from))),
        visibleTo: range.to === undefined ? item.visibleTo : Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(range.to))),
      }
      : item)),
  }), `Изменён диапазон глубин состояния ${stateId}`);
}

/* ------------------------------------------------------- scope и детализация */

/** Привязывает область к scope и пересчитывает детализацию по геометрии. */
export function assignScope(
  session: EditorSession,
  areaId: string,
  scope: Scope,
  options: ClassifyOptions = {},
): EditorSession {
  return updateArea(session, areaId, (area) => {
    const firstClosedStroke = (area.strokes ?? []).find((stroke) => stroke.closed);
    const location = area.rings.length > 0
      ? (classifyArea(scope, area, options) as AreaLocation)
      : (firstClosedStroke !== undefined
        ? classifyLocation(scope, firstClosedStroke.points, true, options)
        : 'unknown');
    const detail = area.detail ?? location;
    return { ...area, scopeId: scope.id, location, detail };
  }, `Область отнесена к scope ${scope.id}`);
}

export function setDetail(session: EditorSession, areaId: string, detail: string | null): EditorSession {
  return updateArea(session, areaId, (area) => ({ ...area, detail }), `Изменена детализация области на ${detail ?? '—'}`);
}

/* -------------------------------------------------------- форс-закрашивание */

/** Мазок `F` коммитится сразу: override-слой поверх состояний, состояния целы. */
export function addForceFill(
  session: EditorSession,
  input: { readonly id: string; readonly rings: readonly Ring[]; readonly color: string; readonly areaId?: string | null; readonly alpha?: number },
): EditorSession {
  const override = createOverrideStroke({
    id: input.id,
    rings: input.rings,
    color: input.color,
    areaId: input.areaId ?? null,
    mode: session.mode,
    alpha: input.alpha ?? 1,
  });
  const doc: SectorAreasDoc = { ...session.doc, overrides: [...session.doc.overrides, override] };
  return commit(session, doc, {
    kind: 'override',
    areaId: override.areaId,
    mode: session.mode,
    note: `Форс-закрашивание ${override.id} цветом ${override.color}`,
  });
}

/* ------------------------------------------------------------ экспорт/импорт */

export function exportDoc(session: EditorSession, indent = 2): string {
  return JSON.stringify(session.doc, null, indent);
}

export function importDoc(json: string | unknown): EditorSession {
  // Строку разбираем как JSON: выгрузка редактора и черновик идут текстом.
  const raw = typeof json === 'string' ? JSON.parse(json) as unknown : json;
  return createEditorSession(parseSectorAreas(raw));
}

export function selectedArea(session: EditorSession): Area | null {
  if (session.selection === null) return null;
  return session.doc.areas.find((area) => area.id === session.selection) ?? null;
}

export function areaById(session: EditorSession, areaId: string): Area | null {
  return session.doc.areas.find((area) => area.id === areaId) ?? null;
}
