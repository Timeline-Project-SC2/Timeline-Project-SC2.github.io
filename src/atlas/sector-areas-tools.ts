/* Инструменты рисования фракционных областей: чистая машина состояний.
 *
 * Модуль намеренно **без DOM, без рендера и без документа**: он знает только
 * геометрию ввода. Интерфейс передаёт сюда мировые точки и получает готовый
 * черновик фигуры, который уже можно отдать командам редактора.
 *
 * Пять видов ввода (решение владельца):
 *  - `free-line` — свободная линия перетаскиванием, остаётся открытой;
 *  - `line` — ломаная по вершинам, остаётся открытой;
 *  - `rectangle`, `ellipse` — перетаскиванием от угла до угла, замкнутые;
 *  - `polygon` — замкнутый контур по вершинам.
 *
 * Два способа ввода не смешиваются: перетаскивание и установка вершин кликами.
 * Завершение вершин — `Enter` или двойной клик, отмена незавершённого ввода —
 * `Escape`; и то, и другое документ не трогает.
 *
 * Пороги взяты из существующего контракта, а не придуманы здесь: замкнутое
 * кольцо требует минимум четыре точки (три уникальные вершины плюс замыкание),
 * открытое — минимум две. Контракт не меняется и не дублируется, площадь и
 * длину считает `sector-areas-geometry`, а не второй похожий слой.
 */

import { SECTOR_AREAS_MAP_SIZE } from './sector-areas-contract.ts';
import type { AreaPoint, AreaStroke, Ring } from './sector-areas-contract.ts';
import { ringArea, ringLength } from './sector-areas-geometry.ts';

/* ------------------------------------------------------------------ справочник */

export type ToolId = 'free-line' | 'line' | 'rectangle' | 'ellipse' | 'polygon';

/** Порядок кнопок в панели: как в классическом Paint, сверху вниз. */
export const TOOL_IDS: readonly ToolId[] = Object.freeze([
  'free-line',
  'line',
  'rectangle',
  'ellipse',
  'polygon',
]);

export const TOOL_TITLES: Readonly<Record<ToolId, string>> = Object.freeze({
  'free-line': 'Свободная линия',
  line: 'Линия по точкам',
  rectangle: 'Прямоугольник',
  ellipse: 'Эллипс',
  polygon: 'Многоугольник',
});

/** Короткие подписи кнопок панели: в ряд помещается только короткое имя. */
export const TOOL_LABELS: Readonly<Record<ToolId, string>> = Object.freeze({
  'free-line': 'Свободная',
  line: 'Линия',
  rectangle: 'Прямоугольник',
  ellipse: 'Эллипс',
  polygon: 'Многоугольник',
});

/** Как инструмент получает ввод: перетаскиванием или кликами по вершинам. */
export type ToolInput = 'drag' | 'vertices';

export const TOOL_INPUT: Readonly<Record<ToolId, ToolInput>> = Object.freeze({
  'free-line': 'drag',
  line: 'vertices',
  rectangle: 'drag',
  ellipse: 'drag',
  polygon: 'vertices',
});

/** Подсказка под кнопкой инструмента: один жест — одна строка. */
export const TOOL_HINTS: Readonly<Record<ToolId, string>> = Object.freeze({
  'free-line': 'Тяните мышью: линия останется открытой и не получит заливку.',
  line: 'Клики ставят точки; Enter или двойной клик завершают, Esc отменяет.',
  rectangle: 'Тяните от угла к углу: фигура сохранится замкнутой.',
  ellipse: 'Тяните от угла описанного прямоугольника: фигура замкнутая.',
  polygon: 'Клики ставят вершины; Enter или двойной клик замыкают, Esc отменяет.',
});

export function isToolId(value: unknown): value is ToolId {
  return typeof value === 'string' && (TOOL_IDS as readonly string[]).includes(value);
}

export function toolInput(tool: ToolId): ToolInput {
  return TOOL_INPUT[tool];
}

/** Замкнутые фигуры: только они получают площадь и, значит, заливку. */
export function toolCloses(tool: ToolId): boolean {
  return tool === 'rectangle' || tool === 'ellipse' || tool === 'polygon';
}

/** Минимум точек открытого кольца: из проверки документа, где `closed: false`. */
export const OPEN_MIN_POINTS = 2;
/** Минимум уникальных вершин замкнутого кольца: плюс замыкающая — четыре точки. */
export const CLOSED_MIN_VERTICES = 3;
/** Точек на окружность эллипса: достаточно для плавности и не раздувает документ. */
export const ELLIPSE_SEGMENTS = 32;

/* ----------------------------------------------------------------- приведение */

/** Приводит координату к карте `0…mapSize`: фигура не должна ломать разбор. */
function clampCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(SECTOR_AREAS_MAP_SIZE, value));
}

/** Точка в пределах карты: перетаскивание легко уводит курсор за край. */
export function clampPoint(point: readonly [number, number]): AreaPoint {
  return [clampCoord(point[0]), clampCoord(point[1])];
}

/* -------------------------------------------------------------------- состояние */

export type ToolPhase = 'idle' | 'drag' | 'vertices';

export interface ToolState {
  readonly tool: ToolId;
  readonly phase: ToolPhase;
  /** Точки перетаскивания: для свободной линии это и есть геометрия. */
  readonly path: readonly AreaPoint[];
  /** Кликнутые вершины: для линии и многоугольника. */
  readonly vertices: readonly AreaPoint[];
  /** Последняя точка курсора: «резиновая нить» до завершения ввода. */
  readonly cursor: AreaPoint | null;
}

export interface ShapeDraft {
  readonly tool: ToolId;
  readonly closed: boolean;
  /**
   * Уникальные точки фигуры без замыкающей копии первой: замыкание добавляет
   * `draftRing`, чтобы кольцо проходило проверку документа.
   */
  readonly points: readonly AreaPoint[];
}

export interface DraftCheck {
  readonly ok: boolean;
  /** Понятная причина отказа; `null` — фигура годится. */
  readonly reason: string | null;
}

export function createToolState(tool: ToolId = 'free-line'): ToolState {
  return { tool, phase: 'idle', path: [], vertices: [], cursor: null };
}

export function isToolInputActive(state: ToolState): boolean {
  return state.phase !== 'idle';
}

/**
 * Смена инструмента — состояние интерфейса, а не правка документа: незаконченный
 * ввод отбрасывается, в историю ничего не попадает.
 */
export function selectTool(state: ToolState, tool: ToolId): ToolState {
  if (tool === state.tool) return cancelInput(state);
  return createToolState(tool);
}

/** Отмена незавершённого ввода: документ не трогается, истории не будет. */
export function cancelInput(state: ToolState): ToolState {
  return state.phase === 'idle' ? state : createToolState(state.tool);
}

/* --------------------------------------------------------- перетаскивание */

export function beginDrag(state: ToolState, point: readonly [number, number]): ToolState {
  const start = clampPoint(point);
  return { ...state, phase: 'drag', path: [start], vertices: [], cursor: start };
}

/**
 * Шаг перетаскивания. Точки ближе `minStep` не несут формы, но раздувают
 * документ, поэтому они отбрасываются; курсор обновляется всегда.
 */
export function moveDrag(state: ToolState, point: readonly [number, number], minStep = 0): ToolState {
  if (state.phase !== 'drag') return state;
  const next = clampPoint(point);
  const last = state.path[state.path.length - 1];
  if (last === undefined) return { ...state, path: [next], cursor: next };
  const far = !(minStep > 0) || Math.hypot(next[0] - last[0], next[1] - last[1]) >= minStep;
  return { ...state, path: far ? [...state.path, next] : state.path, cursor: next };
}

/* --------------------------------------------------------------- вершины */

/**
 * Клик ставит вершину. Повторная точка в том же месте игнорируется: иначе
 * двойной клик, завершающий ввод, удваивал бы последнюю вершину.
 */
export function addVertex(state: ToolState, point: readonly [number, number]): ToolState {
  const next = clampPoint(point);
  const last = state.vertices[state.vertices.length - 1];
  if (last !== undefined && last[0] === next[0] && last[1] === next[1]) {
    return { ...state, phase: 'vertices', cursor: next };
  }
  return { ...state, phase: 'vertices', vertices: [...state.vertices, next], cursor: next };
}

export function moveCursor(state: ToolState, point: readonly [number, number]): ToolState {
  if (state.phase === 'idle') return state;
  return { ...state, cursor: clampPoint(point) };
}

/* ------------------------------------------------------------------- фигуры */

function rectangleCorners(a: AreaPoint, b: AreaPoint): AreaPoint[] {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

function ellipsePoints(a: AreaPoint, b: AreaPoint, segments = ELLIPSE_SEGMENTS): AreaPoint[] {
  const count = Math.max(CLOSED_MIN_VERTICES, Math.round(segments));
  const rx = Math.abs(b[0] - a[0]) / 2;
  const ry = Math.abs(b[1] - a[1]) / 2;
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const points: AreaPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / count) * Math.PI * 2;
    points.push(clampPoint([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]));
  }
  return points;
}

/**
 * Собирает черновик из опорных точек. Для прямоугольника и эллипса это две
 * точки перетаскивания, для остальных — сама геометрия.
 */
function buildDraft(tool: ToolId, control: readonly AreaPoint[]): ShapeDraft | null {
  const first = control[0];
  if (first === undefined) return null;
  switch (tool) {
    case 'free-line':
    case 'line':
      return { tool, closed: false, points: [...control] };
    case 'rectangle': {
      const second = control[1] ?? control[control.length - 1];
      if (second === undefined) return null;
      return { tool, closed: true, points: rectangleCorners(first, second) };
    }
    case 'ellipse': {
      const second = control[1] ?? control[control.length - 1];
      if (second === undefined) return null;
      return { tool, closed: true, points: ellipsePoints(first, second) };
    }
    case 'polygon':
      return { tool, closed: true, points: [...control] };
    default:
      return null;
  }
}

/** Черновик по текущему состоянию: для «резиновой нити» и предпросмотра. */
export function previewDraft(state: ToolState): ShapeDraft | null {
  if (state.phase === 'idle') return null;
  if (state.phase === 'vertices') {
    const control = state.cursor === null
      ? state.vertices
      : [...state.vertices, state.cursor];
    return buildDraft(state.tool, control);
  }
  const tool = state.tool;
  if (tool === 'rectangle' || tool === 'ellipse') {
    const start = state.path[0];
    const end = state.cursor ?? state.path[state.path.length - 1];
    if (start === undefined || end === undefined) return null;
    return buildDraft(tool, [start, end]);
  }
  const control = state.cursor === null ? state.path : [...state.path, state.cursor];
  return buildDraft(tool, control);
}

/** Завершение перетаскивания: черновик готов или его нет вовсе. */
export function endDrag(state: ToolState): { readonly state: ToolState; readonly draft: ShapeDraft | null } {
  if (state.phase !== 'drag') return { state, draft: null };
  const tool = state.tool;
  if (tool === 'rectangle' || tool === 'ellipse') {
    const start = state.path[0];
    const end = state.cursor ?? state.path[state.path.length - 1];
    if (start === undefined || end === undefined) return { state: createToolState(tool), draft: null };
    return { state: createToolState(tool), draft: buildDraft(tool, [start, end]) };
  }
  const draft = buildDraft(tool, state.path);
  return { state: createToolState(tool), draft };
}

/** Завершение ввода по вершинам: `Enter` или двойной клик. */
export function finishVertices(state: ToolState): { readonly state: ToolState; readonly draft: ShapeDraft | null } {
  if (state.phase !== 'vertices') return { state, draft: null };
  const draft = buildDraft(state.tool, state.vertices);
  return { state: createToolState(state.tool), draft };
}

/** Снимает последнюю вершину: откат на шаг внутри незавершённого ввода. */
export function undoVertex(state: ToolState): ToolState {
  if (state.phase !== 'vertices' || state.vertices.length === 0) return state;
  const vertices = state.vertices.slice(0, -1);
  return {
    ...state,
    phase: vertices.length === 0 ? 'idle' : 'vertices',
    vertices,
    cursor: vertices[vertices.length - 1] ?? null,
  };
}

/* --------------------------------------------------------------- проверка */

function uniqueCount(points: readonly AreaPoint[]): number {
  const seen = new Set<string>();
  for (const point of points) seen.add(`${point[0]},${point[1]}`);
  return seen.size;
}

/**
 * Проверка черновика существующими правилами контракта: замкнутому кольцу
 * нужны три уникальные вершины, открытому — две точки.
 *
 * Вырожденность ловит не самодельный перебор случаев, а существующая геометрия:
 * нулевая площадь у замкнутой фигуры и нулевая длина у открытой. Так отказ
 * получают и нулевой прямоугольник, и три точки на одной прямой — то, что
 * простой проверкой совпадающих вершин не ловится. Документ при этом не
 * портится: фигура просто не создаётся, а причина показывается администратору.
 */
export function validateDraft(draft: ShapeDraft | null): DraftCheck {
  if (draft === null) return { ok: false, reason: 'Фигура не начата: ввода не было.' };
  if (draft.closed) {
    if (draft.points.length < CLOSED_MIN_VERTICES) {
      return {
        ok: false,
        reason: `Замкнутой фигуре нужно минимум ${CLOSED_MIN_VERTICES} вершины: поставьте ещё точки.`,
      };
    }
    if (uniqueCount(draft.points) < CLOSED_MIN_VERTICES) {
      return { ok: false, reason: 'Фигура вырождена: вершины совпадают, площади нет.' };
    }
    if (ringArea(draftRing(draft), true) <= 0) {
      return { ok: false, reason: 'Фигура без площади: вершины лежат на одной линии.' };
    }
    return { ok: true, reason: null };
  }
  if (draft.points.length < OPEN_MIN_POINTS) {
    return { ok: false, reason: `Открытой линии нужно минимум ${OPEN_MIN_POINTS} точки.` };
  }
  if (ringLength(draftRing(draft), false) <= 0) {
    return { ok: false, reason: 'Открытая линия без длины: её точки совпадают.' };
  }
  return { ok: true, reason: null };
}

/** Готовое кольцо документа: замыкающая копия первой точки для замкнутых. */
export function draftRing(draft: ShapeDraft): Ring {
  const points = draft.points;
  if (!draft.closed) return [...points];
  const first = points[0];
  if (first === undefined) return [];
  const last = points[points.length - 1];
  if (last !== undefined && last[0] === first[0] && last[1] === first[1]) return [...points];
  return [...points, [first[0], first[1]]];
}

/**
 * Обновляет точки незавершённого черновика (например, после привязки к рёбрам
 * отображаемой адресной сетки), зажимая координаты в границы карты и сохраняя
 * инструмент и признак замкнутости. Документ при этом не затрагивается.
 */
export function applyDraftPoints(
  draft: ShapeDraft,
  points: readonly AreaPoint[],
): ShapeDraft {
  const clamped = points.map((point): AreaPoint => clampPoint(point));
  if (draft.closed && clamped.length >= 2) {
    const first = clamped[0]!;
    const last = clamped[clamped.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      clamped.pop();
    }
  }
  return {
    tool: draft.tool,
    closed: draft.closed,
    points: clamped,
  };
}

/** Превращает проверенный черновик фигуры в отдельный штрих `AreaStroke` документа. */
export function draftStroke(id: string, draft: ShapeDraft): AreaStroke {
  return {
    id,
    points: draft.points.map((point): AreaPoint => clampPoint(point)),
    closed: draft.closed,
  };
}
