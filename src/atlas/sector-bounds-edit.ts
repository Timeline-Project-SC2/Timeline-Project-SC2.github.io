/* Правка линий границ сектора: ядро, якорные точки и локальная деформация
 * (этап 3 §11 части 2 плана, карточка SEC-VISUAL-EDIT).
 *
 * Слой намеренно **без DOM и без рендера**: это команды над документом
 * границ. Интерфейс (overlay-canvas, панель, хоткеи) вызывает их и сам
 * отвечает за отрисовку предпросмотра. Каждая команда возвращает новую
 * сессию: прошлое уходит в `past`, `undo`/`redo` ходят по той же истории.
 *
 * Модель деформации (точная математика, документируется здесь):
 * - сегмент между двумя соседними вершинами контура — прямая в параметре
 *   t ∈ [0, 1]: P(t) = A + t·(B − A);
 * - **5 якорей** равномерно по сегменту: t = 0,1; 0,3; 0,5; 0,7; 0,9 —
 *   опорные точки, которые **не смещаются** при движении ядра;
 * - концы сегмента — структурные вершины (сообщаются с соседними
 *   сегментами), тоже фиксированы всегда;
 * - **ядро** — отдельная точка (поставлена двойным кликом); перетаскивание
 *   тянет контур в сторону ядра;
 * - **границы влияния**: интервал между двумя якорями, которыми ядро
 *   окружено по параметру; вне интервала смещение строго ноль, на якорях
 *   и конец сегмента — ноль;
 * - функция смещения: плавный булмп (smoothstep, C1-непрерывный) с нулями
 *   на концах интервала и единицей в ядре; каждая точка смещается на
 *   (ядро − P(t_ядро)) · shape(t);
 * - результат коммита: сегмент заменяется на 16-точечную кривую, концы
 *   которой совпадают с концами исходного сегмента.
 *
 * Ограничения (документируются, не проверяются):
 * - деформация локальна: двигается только интервал ядерного влияния;
 * - короткие сегменты деформируются плавно, но эффект мал (якорной сетки
 *   не хватает);
 * - повторный двойной клик на другой сегмент заменяет правку;
 * - Escape отменяет предпросмотр (документ не трогается), Ctrl+Z — последний
 *   коммит;
 * - ядро обрезается по границам поля (0…10000), поэтому коммит всегда
 *   даёт корректный документ.
 */

import { parseBounds } from './sector-bounds.ts';
import type { BoundsPrimitive, Point, SectorBounds } from './sector-bounds.ts';

/* ------------------------------------------------------------------ типы */

/** Выбранный сегмент: какой контур, какой сегмент и параметр клика на нём. */
export interface EdgeSelection {
  readonly contourId: string;
  readonly contourIndex: number;
  /** Индекс начальной вершины сегмента в `contour.points`. */
  readonly edgeIndex: number;
  /** Параметър точки клика на сегменте (0…1). */
  readonly t: number;
}

/** Активная правка сегмента: ядро, якоря и предпросмотр деформации. */
export interface BoundsEditActive {
  readonly contourId: string;
  readonly contourIndex: number;
  readonly edgeIndex: number;
  /** Ядро — отдельная draggable точка (мировые координаты). */
  readonly core: Point;
  /** Параметър ядра на исходном сегменте. */
  readonly coreParameter: number;
  /** 5 якорей на исходном сегменте — не двигаются при движении ядра. */
  readonly anchors: readonly Point[];
  /** Границы влияния ядра: [t_left, t_right] (вне интервала — без смещения). */
  readonly interval: readonly [number, number];
  /** Предпросмотр деформированного сегмента (`BOUNDS_EDIT_EDGE_SAMPLES` точек). */
  readonly curve: readonly Point[];
}

/** Запись журнала одного коммита: что было до и после. */
export interface BoundsEditEntry {
  readonly sequence: number;
  readonly contourId: string;
  readonly contourIndex: number;
  readonly edgeIndex: number;
  readonly before: readonly Point[];
  readonly after: readonly Point[];
}

/** Сессия правки: документ, журнал, активная правка и выбор сегмента. */
export interface BoundsEditSession {
  readonly doc: SectorBounds;
  readonly past: readonly BoundsEditEntry[];
  readonly future: readonly BoundsEditEntry[];
  readonly active: BoundsEditActive | null;
  readonly selection: EdgeSelection | null;
  readonly sequence: number;
}

/* --------------------------------------------------------------- константы */

/** Число опорных точек-якорей на сегменте (равномерно по нему). */
export const BOUNDS_EDIT_ANCHOR_COUNT = 5;

/** Параметры якорей на сегменте (внутренние точки, шаг 0,2). */
export const BOUNDS_EDIT_ANCHOR_POSITIONS: readonly number[] = Object.freeze([0.1, 0.3, 0.5, 0.7, 0.9]);

/** Число точек кривой, на которую разбивается edited-сегмент при коммите. */
export const BOUNDS_EDIT_EDGE_SAMPLES = 16;

/** Эпсилон сравнения геометрии. */
export const BOUNDS_EDIT_EPSILON = 1e-6;

/** Граница поля карты (совпадает с `parseBounds`: координаты 0…10000). */
export const BOUNDS_EDIT_MAP_BOUND = 10000;

/* ---------------------------------------------------------------- утилиты */

function subtract(a: Point, b: Point): [number, number] {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Point, b: Point): [number, number] {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(a: Point, k: number): [number, number] {
  return [a[0] * k, a[1] * k];
}

function lengthOf(a: Point): number {
  return Math.hypot(a[0], a[1]);
}

function samePoint(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Плавный шаг: 0 на концах, 1 в середине, C1-непрерывный. */
function smoothstep(u: number): number {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return t * t * (3 - 2 * t);
}

/**
 * Проекция точки на отрезок: параметр (clamped), расстояние и сама точка.
 * Вырожденный отрезок трактуется как его конец.
 */
function projectOnSegment(p: Point, a: Point, b: Point): { t: number; distance: number; point: Point } {
  const ab = subtract(b, a);
  const len2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (len2 <= BOUNDS_EDIT_EPSILON * BOUNDS_EDIT_EPSILON) {
    return { t: 0, distance: lengthOf(subtract(p, a)), point: a };
  }
  let t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const point = add(a, scale(ab, t));
  return { t, distance: lengthOf(subtract(p, point)), point };
}

/** 16-точечная прямая по отрезку (базовая кривая без деформации). */
function sampleEdge(a: Point, b: Point): Point[] {
  const ab = subtract(b, a);
  const curve: Point[] = [];
  for (let i = 0; i < BOUNDS_EDIT_EDGE_SAMPLES; i += 1) {
    const u = i / (BOUNDS_EDIT_EDGE_SAMPLES - 1);
    curve.push([a[0] + ab[0] * u, a[1] + ab[1] * u] as Point);
  }
  return curve;
}

/**
 * 5 якорей равномерно по сегменту (t = 0,1; 0,3; 0,5; 0,7; 0,9).
 * Якоря — опорные точки: не смещаются при движении ядра.
 */
export function anchorsForEdge(a: Point, b: Point): Point[] {
  return BOUNDS_EDIT_ANCHOR_POSITIONS.map((t) => {
    const ab = subtract(b, a);
    return [a[0] + ab[0] * t, a[1] + ab[1] * t] as Point;
  });
}

/**
 * Границы влияния ядра: интервал между двумя якорями, которыми ядро
 * окружено по параметру (крайние интервалы огорожены концами сегмента).
 * `null` — ядро на якоре или на конце сегмента: деформации нет.
 */
export function influenceIntervalFor(t: number): [number, number] | null {
  if (!(t > BOUNDS_EDIT_EPSILON) || !(t < 1 - BOUNDS_EDIT_EPSILON)) return null;
  let left = 0;
  let right = 1;
  for (const anchor of BOUNDS_EDIT_ANCHOR_POSITIONS) {
    if (t > anchor + BOUNDS_EDIT_EPSILON) left = anchor;
    else if (t < anchor - BOUNDS_EDIT_EPSILON) {
      right = anchor;
      break;
    } else {
      return null;
    }
  }
  return [left, right];
}

/**
 * Деформированная точка сегмента в параметре `u` (0…1). Вне интервала влияния
 * — исходная прямая, внутри — плавная кривая через ядро.
 *
 * shape(t) = smoothstep((t − t_left)/(t_ядро − t_left)) ·
 *            smoothstep((t_right − t)/(t_right − t_ядро))
 *
 * Смещение каждой точки = (ядро − P(t_ядро)) · shape(t). На ядерном
 * параметре shape = 1 (контур проходит через ядро), на якорях и вне
 * интервала — 0.
 */
export function deformEdgeAt(a: Point, b: Point, core: Point, u: number): Point {
  const { t } = projectOnSegment(core, a, b);
  const interval = influenceIntervalFor(t);
  if (interval === null) return add(a, scale(subtract(b, a), u));
  const [left, right] = interval;
  const ab = subtract(b, a);
  const p = add(a, scale(ab, u));
  if (u <= left || u >= right) return p;
  const base = add(a, scale(ab, t)); // P(t_ядро) на исходной прямой
  const pull = subtract(core, base); // направленный толчок в сторону ядра
  const shape = smoothstep((u - left) / (t - left)) * smoothstep((right - u) / (right - t));
  return [p[0] + pull[0] * shape, p[1] + pull[1] * shape] as Point;
}

/**
 * Деформированный сегмент: `BOUNDS_EDIT_EDGE_SAMPLES` точек по `deformEdgeAt`.
 */
export function deformEdge(a: Point, b: Point, core: Point): Point[] {
  const curve: Point[] = [];
  for (let i = 0; i < BOUNDS_EDIT_EDGE_SAMPLES; i += 1) {
    const u = i / (BOUNDS_EDIT_EDGE_SAMPLES - 1);
    curve.push(deformEdgeAt(a, b, core, u));
  }
  return curve;
}

/** Контур по id; `null` — такого контура нет. */
export function contourOf(doc: SectorBounds, contourId: string): BoundsPrimitive | null {
  return doc.bounds.find((item) => item.id === contourId) ?? null;
}

/**
 * Вершины сегмента по индексу начальной вершины; `null` — индекс вне
 * диапазона или вырожденный сегмент (длина меньше эпсилон).
 */
export function edgePoints(contour: BoundsPrimitive, edgeIndex: number): [Point, Point] | null {
  if (edgeIndex < 0 || edgeIndex + 1 >= contour.points.length) return null;
  const a = contour.points[edgeIndex];
  const b = contour.points[edgeIndex + 1];
  if (a === undefined || b === undefined) return null;
  if (lengthOf(subtract(b, a)) <= BOUNDS_EDIT_EPSILON) return null;
  return [a, b];
}

/**
 * Выбор сегмента по клику: ближайший сегмент всех контуров в пределах
 * `tolerance` (мировые единицы). Вырожденные сегменты не выбираются.
 */
export function pickBoundsEdge(
  doc: SectorBounds,
  x: number,
  y: number,
  tolerance: number,
): EdgeSelection | null {
  const click: Point = [x, y];
  let best: EdgeSelection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [contourIndex, contour] of doc.bounds.entries()) {
    for (let edgeIndex = 0; edgeIndex + 1 < contour.points.length; edgeIndex += 1) {
      const edge = edgePoints(contour, edgeIndex);
      if (edge === null) continue;
      const projected = projectOnSegment(click, edge[0], edge[1]);
      if (projected.distance > tolerance) continue;
      if (best === null || projected.distance < bestDistance) {
        best = { contourId: contour.id, contourIndex, edgeIndex, t: projected.t };
        bestDistance = projected.distance;
      }
    }
  }
  return best;
}

/* ---------------------------------------------------------------- сессия */

/** Новая пустая сессия правки. */
export function createBoundsEditSession(doc: SectorBounds): BoundsEditSession {
  return { doc, past: [], future: [], active: null, selection: null, sequence: 0 };
}

/** Обрезка точки по границам поля (0…10000). */
function clampToMap(point: Point): Point {
  return [
    Math.min(BOUNDS_EDIT_MAP_BOUND, Math.max(0, point[0])),
    Math.min(BOUNDS_EDIT_MAP_BOUND, Math.max(0, point[1])),
  ] as Point;
}

/**
 * Открытие правки сегмента (двойный клик): ядро — в точке клика (обрезано по
 * полю), якоря — по определению, интервал влияния — по ядру. Коммит ещё не
 * сделан: предпросмотр живёт в `active`, документ не трогается.
 * Повторный двойной клик (активная правка) заменяет правку на новую.
 */
export function beginBoundsEdit(
  session: BoundsEditSession,
  contourId: string,
  edgeIndex: number,
  point: Point,
): BoundsEditSession {
  // Повторный двойной клик: текущая правка сбрасывается, открывается новая.
  const base = session.active !== null ? cancelBoundsEdit(session) : session;
  const contour = contourOf(base.doc, contourId);
  if (contour === null) return base;
  const edge = edgePoints(contour, edgeIndex);
  if (edge === null) return base;
  const contourIndex = base.doc.bounds.findIndex((item) => item.id === contourId);
  const core = clampToMap(point);
  const { t } = projectOnSegment(core, edge[0], edge[1]);
  return {
    ...base,
    active: {
      contourId,
      contourIndex,
      edgeIndex,
      core,
      coreParameter: t,
      anchors: anchorsForEdge(edge[0], edge[1]),
      interval: influenceIntervalFor(t) ?? [0, 1],
      curve: deformEdge(edge[0], edge[1], core),
    },
    selection: { contourId, contourIndex, edgeIndex, t },
  };
}

/**
 * Перетаскивание ядра: пересчитать параметр, интервал влияния и предпросмотр.
 * Ядро обрезается по полю — коммит всегда даёт корректный документ.
 */
export function moveBoundsEditCore(session: BoundsEditSession, point: Point): BoundsEditSession {
  const active = session.active;
  if (active === null) return session;
  const contour = contourOf(session.doc, active.contourId);
  if (contour === null) return session;
  const edge = edgePoints(contour, active.edgeIndex);
  if (edge === null) return session;
  const core = clampToMap(point);
  const { t } = projectOnSegment(core, edge[0], edge[1]);
  return {
    ...session,
    active: {
      ...active,
      core,
      coreParameter: t,
      interval: influenceIntervalFor(t) ?? [0, 1],
      curve: deformEdge(edge[0], edge[1], core),
    },
  };
}

/**
 * Замена сегмента кривой в контуре: кривая включает концы сегмента, поэтому
 * соседние сегменты и замыкание контура не нарушаются.
 */
function applyEdgeCurve(contour: BoundsPrimitive, edgeIndex: number, curve: readonly Point[]): Point[] | null {
  const points = contour.points;
  if (edgeIndex + 1 >= points.length) return null;
  if (curve.length < 2) return null;
  const first = points[edgeIndex];
  const last = points[edgeIndex + 1];
  if (first === undefined || last === undefined) return null;
  if (!samePoint(curve[0]!, first) || !samePoint(curve.at(-1)!, last)) return null;
  const next: Point[] = [...points.slice(0, edgeIndex + 1)];
  for (let i = 1; i < curve.length; i += 1) next.push(curve[i]!);
  for (let i = edgeIndex + 2; i < points.length; i += 1) next.push(points[i]!);
  return next;
}

/** Новый документ: в контуре заменены точки, остальное без изменений. */
function replaceContourPoints(doc: SectorBounds, contourId: string, points: readonly Point[]): SectorBounds {
  return {
    ...doc,
    bounds: doc.bounds.map((item) => (item.id === contourId ? { ...item, points } : item)),
  };
}

/**
 * Коммит правки (от release ядра): деформированный сегмент заменяет
 * исходный в контуре, запись идёт в журнал. Если ядро не сдвинулось
 * (или стоит на якоре), коммит не нужен — правка просто закрывается.
 * После коммита правка закрывается: повторный двойной клик открывает новую
 * сессию на изменённом контуре.
 */
export function commitBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const active = session.active;
  if (active === null) return session;
  const contour = contourOf(session.doc, active.contourId);
  if (contour === null) return session;
  const edge = edgePoints(contour, active.edgeIndex);
  if (edge === null) return session;
  const straight = sampleEdge(edge[0], edge[1]);
  const moved = active.curve.some((point, index) => {
    const ref = straight[index];
    return ref !== undefined && !samePoint(point, ref);
  });
  if (!moved) return { ...session, active: null, selection: null };
  const after = applyEdgeCurve(contour, active.edgeIndex, active.curve);
  if (after === null) return session;
  const before = [...contour.points];
  const nextDoc = replaceContourPoints(session.doc, contour.id, after);
  const entry: BoundsEditEntry = {
    sequence: session.sequence + 1,
    contourId: contour.id,
    contourIndex: active.contourIndex,
    edgeIndex: active.edgeIndex,
    before,
    after,
  };
  return {
    doc: nextDoc,
    past: [...session.past, entry],
    future: [],
    active: null,
    selection: null,
    sequence: entry.sequence,
  };
}

/** Отмена правки (Escape): предпросмотр теряется, документ не трогается. */
export function cancelBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  if (session.active === null) return session;
  return { ...session, active: null, selection: null };
}

/** Выбор сегмента для подсветки (UI-состояние, в журнал не идёт). */
export function selectBoundsEdge(session: BoundsEditSession, selection: EdgeSelection | null): BoundsEditSession {
  return selection === session.selection ? session : { ...session, selection };
}

/**
 * Отмена последнего коммита (Ctrl+Z): документ возвращается к `before`.
 * Активная правка сбрасывается — предпросмотр ждал бы старого состояния.
 */
export function undoBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const entry = session.past.at(-1);
  if (entry === undefined) return session;
  if (contourOf(session.doc, entry.contourId) === null) return session;
  return {
    doc: replaceContourPoints(session.doc, entry.contourId, [...entry.before]),
    past: session.past.slice(0, -1),
    future: [...session.future, entry],
    active: null,
    selection: null,
    sequence: session.sequence,
  };
}

/** Повтор отменённого коммита (Ctrl+Shift+Z). */
export function redoBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const entry = session.future.at(-1);
  if (entry === undefined) return session;
  if (contourOf(session.doc, entry.contourId) === null) return session;
  return {
    doc: replaceContourPoints(session.doc, entry.contourId, [...entry.after]),
    past: [...session.past, entry],
    future: session.future.slice(0, -1),
    active: null,
    selection: null,
    sequence: session.sequence,
  };
}

/* --------------------------------------------------------- экспорт/импорт */

/** Экспорт документа границ как JSON (та же схема, что `data/sector-bounds.json`). */
export function serializeBoundsEdit(doc: SectorBounds): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Импорт/проверка документа границ: парсер контракта без изменений.
 * Некорректные данные — `RangeError` (как в `parseBounds`).
 */
export function parseBoundsEdit(json: unknown): SectorBounds {
  return parseBounds(json);
}
