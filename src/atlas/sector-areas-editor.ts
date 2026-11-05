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
import { classifyArea } from './sector-areas-scope.ts';
import type { ClassifyOptions, Scope } from './sector-areas-scope.ts';
import type {
  Area,
  AreaLocation,
  AreaPoint,
  AreaState,
  GradientSpec,
  Mode,
  Ring,
  Rounding,
  SectorAreasDoc,
} from './sector-areas-contract.ts';
import { MAX_LEVEL, MIN_LEVEL } from './sector-areas-contract.ts';

export type SnapMode = 'free' | 'sector';

export interface EditorSession {
  readonly doc: SectorAreasDoc;
  readonly past: readonly SectorAreasDoc[];
  readonly future: readonly SectorAreasDoc[];
  /** Режим по умолчанию для новой кисти: не меняет уже созданные состояния. */
  readonly mode: Mode;
  /** `free` — произвольный полигон; `sector` — снап к ячейке адреса. */
  readonly snapMode: SnapMode;
  /** Ширина кисти в экранных пикселях; переводится в мировые по масштабу. */
  readonly brushWidthPx: number;
  readonly selection: string | null;
  readonly sequence: number;
}

export function createEditorSession(doc?: SectorAreasDoc): EditorSession {
  return {
    doc: doc ?? emptySectorAreasDoc(),
    past: [],
    future: [],
    mode: 'political',
    snapMode: 'free',
    brushWidthPx: 8,
    selection: null,
    sequence: 1,
  };
}

/* ------------------------------------------------------------------ история */

function commit(
  session: EditorSession,
  doc: SectorAreasDoc,
  event: { kind: string; areaId: string | null; mode: Mode | null; note: string },
): EditorSession {
  const id = `ev-${session.sequence}`;
  return {
    ...session,
    doc: { ...doc, events: [...doc.events, { id, kind: event.kind, areaId: event.areaId, mode: event.mode, note: event.note }] },
    past: [...session.past, session.doc],
    future: [],
    sequence: session.sequence + 1,
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
  return {
    ...session,
    doc: previous,
    past: session.past.slice(0, -1),
    future: [session.doc, ...session.future],
  };
}

export function redo(session: EditorSession): EditorSession {
  const next = session.future[0];
  if (next === undefined) return session;
  return {
    ...session,
    doc: next,
    past: [...session.past, session.doc],
    future: session.future.slice(1),
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
}

/** Свободная кисть: произвольный полигон в мировых координатах. */
export function addAreaFromStroke(session: EditorSession, input: StrokeInput): EditorSession {
  const closed = input.closed ?? true;
  const minimum = closed ? 3 : 2;
  if (input.points.length < minimum) {
    throw new RangeError(`Штрих должен содержать минимум ${minimum} точки`);
  }
  const ring = thickenStroke(input.points, input.width ?? 0, closed);
  const area = createArea({
    id: input.id,
    name: input.name,
    rings: [ring],
    parentId: input.parentId ?? null,
    address: addressForRing(ring, closed),
    closed,
    source: input.source ?? 'brush',
  });

  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return {
    ...commit(session, doc, { kind: 'create', areaId: area.id, mode: session.mode, note: `Создана область «${area.name}» кистью` }),
    selection: area.id,
  };
}

export interface SectorCellInput {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** Глубина адреса `0…7`; по умолчанию — пять букв (`T5`). */
  readonly letters?: AddressLetters;
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

  const area = createArea({
    id: input.id,
    name: input.name,
    rings: [ring],
    parentId,
    address: formatAddress(address),
    source: 'sector',
  });

  const doc: SectorAreasDoc = { ...session.doc, areas: [...session.doc.areas, area] };
  return {
    ...commit(session, doc, { kind: 'create', areaId: area.id, mode: session.mode, note: `Создана область «${area.name}» по ячейке ${area.address ?? ''}` }),
    selection: area.id,
  };
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

function updateArea(session: EditorSession, areaId: string, update: (area: Area) => Area, note: string): EditorSession {
  const target = session.doc.areas.find((area) => area.id === areaId);
  if (target === undefined) throw new RangeError(`Область ${areaId} не найдена`);
  const next = update(target);
  const doc: SectorAreasDoc = {
    ...session.doc,
    areas: session.doc.areas.map((area) => (area.id === areaId ? next : area)),
  };
  return commit(session, doc, { kind: 'edit', areaId, mode: session.mode, note });
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
  return {
    ...commit(session, doc, { kind: 'remove', areaId, mode: session.mode, note: `Область ${areaId} удалена` }),
    selection: session.selection === areaId ? null : session.selection,
  };
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
    const location = classifyArea(scope, area, options) as AreaLocation;
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
  return createEditorSession(parseSectorAreas(json));
}

export function selectedArea(session: EditorSession): Area | null {
  if (session.selection === null) return null;
  return session.doc.areas.find((area) => area.id === session.selection) ?? null;
}

export function areaById(session: EditorSession, areaId: string): Area | null {
  return session.doc.areas.find((area) => area.id === areaId) ?? null;
}
