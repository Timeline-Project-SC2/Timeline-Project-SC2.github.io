/* Правка линий границ сектора: участок, ядро, 5 якорей и локальная деформация.
 *
 * Слой намеренно **без DOM и без рендера**: это команды над документом границ и
 * чистая геометрия предпросмотра. Интерфейс (`sector-bounds-edit-ui.ts`) вызывает
 * команды и рисует то, что они вернули. Каждая команда возвращает новую сессию:
 * прошлое уходит в `past`, `undo`/`redo` ходят по той же истории.
 *
 * ------------------------------------------------------------------ модель
 *
 * **Участок** (`span`) — непрерывная цепочка вершин контура от «структурной»
 * вершины `spanStart` до «структурной» вершины `spanEnd`. Структурная вершина —
 * та, что пришла из `data/sector-bounds.json` и ещё не была переписана правкой;
 * вершины, вставленные прошлыми правками, помечены как «мягкие» (`soft`), и
 * выбор участка проходится сквозь них. Поэтому повторный двойной клик по уже
 * изогнутой линии снова берёт весь изогнутый участок, а не его одноминутный
 * подотрезок.
 *
 * **Видимая кривая участка** (`spanCurve`) — та же линия, которую рисует карта:
 * вершины участка скруглены тем же правилом `smoothPolyline` (квадратичные
 * кривые через середины соседних отрезков), что и в рендерере. Кривая
 * пересэмплируется равномерно **по длине дуги**: точки предпросмотра и якорей
 * лежат на видимой линии и отстоят друг от друга на равные расстояния.
 *
 * Допуск равенства расстояний: пересэмплирование идёт по ломаной из
 * `BOUNDS_EDIT_ARC_STEPS` шагов на каждый квадратичный кусок, поэтому позиция
 * точки известна с точностью порядка длины шага (для контура сектора — доли
 * единицы карты при длине участка в сотни единиц). Тесты проверяют равенство
 * шагов якорей с допуском `BOUNDS_EDIT_ARC_TOLERANCE` (0,5 % шага).
 *
 * **5 якорей** — точки на видимой кривой участка в долях длины дуги
 * `0,1; 0,3; 0,5; 0,7; 0,9`. Якоря — устойчивые опоры: они вычисляются один раз
 * при открытии правки и **не пересчитываются** при движении ядра.
 *
 * **Ядро** — отдельная точка, поставленная двойным кликом. Тяга ядра задаёт
 * смещение: каждая точка видимой кривой сдвигается на
 * `(ядро − точка в пике) · shape(f)`, где `shape` — произведение двух
 * smoothstep-функций. Пик `shape` стоит в `coreFraction`, нули — в границах
 * окна влияния `window`.
 *
 * **Окно влияния** фиксируется при открытии правки: это интервал между двумя
 * соседними якорями (у краёв участка — между якорем и концом). Окно не
 * перескакивает при движении ядра, поэтому форма не «мигает» и не схлопывается
 * в ноль. Позиция пика `coreFraction` — это проекция ядра на кривую, зажатая
 * внутрь окна на `BOUNDS_EDIT_SHAPE_MARGIN` его ширины. Отсюда два свойства:
 * - деформация никогда не нулевая, пока ядро вне линии, даже если клик пришёлся
 *   точно на якорь (прежний дефект: `t = 0,5` давал пустую правку);
 * - влияние строго локально: за пределами окна смещение равно нулю, внешние
 *   вершины контура не меняются.
 *
 * **Коммит**: внутренние вершины участка заменяются деформированными точками
 * видимой кривой (концы участка остаются на месте), поэтому соседние участки и
 * замыкание контура не повреждаются. Вставленные вершины помечаются мягкими.
 * Точность записи: рендерер скругляет новую ломаную, поэтому записанная кривая
 * отличается от предпросмотра не больше чем на «срез угла» при шаге
 * `BOUNDS_EDIT_SAMPLE_SPACING` — доли пикселя в рабочем масштабе.
 *
 * Ограничения, которые не проверяются автоматически: деформация работает в
 * плоскости карты (0…10000 по обеим осям); участок не переносится через шов
 * замыкания контура (0-я вершина остаётся началом списка).
 */

import { smoothPolyline } from './sector-bounds.ts';
import { parseBounds } from './sector-bounds.ts';
import type { BoundsPrimitive, Point, SectorBounds } from './sector-bounds.ts';

/* ------------------------------------------------------------------ типы */

/** Выбранный участок: какой контур, какой клик и какие вершины он накрыл. */
export interface EdgeSelection {
  readonly contourId: string;
  readonly contourIndex: number;
  /** Индекс сегмента, по которому пришёлся клик (`edgeIndex … edgeIndex + 1`). */
  readonly edgeIndex: number;
  /** Параметр клика на этом сегменте (0…1) — для подсветки и подписи. */
  readonly t: number;
  /** Первая структурная вершина участка. */
  readonly spanStart: number;
  /** Последняя структурная вершина участка. */
  readonly spanEnd: number;
  /** Видимая кривая участка (базовая, до деформации). */
  readonly curve: readonly Point[];
}

/** Активная правка участка: ядро, якоря, окно влияния и предпросмотр. */
export interface BoundsEditActive {
  readonly contourId: string;
  readonly contourIndex: number;
  readonly spanStart: number;
  readonly spanEnd: number;
  /** Ядро — отдельная перетаскиваемая точка (мировые координаты). */
  readonly core: Point;
  /** Проекция ядра на кривую, зажатая внутрь окна: позиция пика деформации. */
  readonly coreFraction: number;
  /** Проекция ядра на кривую без зажима — нужна подписи и тестам. */
  readonly coreRawFraction: number;
  /** 5 якорей на видимой кривой — не двигаются при движении ядра. */
  readonly anchors: readonly Point[];
  /** Доли длины дуги, на которых стоят якоря (0,1…0,9). */
  readonly anchorFractions: readonly number[];
  /** Окно влияния в долях длины дуги: вне него смещение строго ноль. */
  readonly window: readonly [number, number];
  /** Видимая кривая участка до деформации. */
  readonly base: readonly Point[];
  /** Предпросмотр: деформированная видимая кривая участка. */
  readonly curve: readonly Point[];
}

/** Снимок контура: точки и пометки «мягких» вершин (вставленных правками). */
export interface ContourSnapshot {
  readonly points: readonly Point[];
  readonly soft: readonly number[];
}

/** Запись журнала одного коммита: что было до и после. */
export interface BoundsEditEntry {
  readonly sequence: number;
  readonly contourId: string;
  readonly contourIndex: number;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly before: ContourSnapshot;
  readonly after: ContourSnapshot;
}

/** Сессия правки: документ, пометки мягких вершин, журнал, активная правка. */
export interface BoundsEditSession {
  readonly doc: SectorBounds;
  readonly soft: Readonly<Record<string, readonly number[]>>;
  readonly past: readonly BoundsEditEntry[];
  readonly future: readonly BoundsEditEntry[];
  readonly active: BoundsEditActive | null;
  readonly selection: EdgeSelection | null;
  readonly sequence: number;
}

/** Равномерно пересэмплированная кривая: точки и накопленные длины. */
export interface SampledCurve {
  readonly points: readonly Point[];
  /** Доля длины дуги для каждой точки (0…1, монотонно). */
  readonly fractions: readonly number[];
  /** Длина дуги от начала до точки `i` (монотонно, `length` в конце). */
  readonly cumulative: readonly number[];
  readonly length: number;
}

/* --------------------------------------------------------------- константы */

/** Число опорных точек-якорей на участке. */
export const BOUNDS_EDIT_ANCHOR_COUNT = 5;

/** Доли длины дуги, на которых стоят якоря: 5 равноудалённых точек. */
export const BOUNDS_EDIT_ANCHOR_FRACTIONS: readonly number[] = Object.freeze([0.1, 0.3, 0.5, 0.7, 0.9]);

/** Шагов на один квадратичный кусок при построении плотной ломаной. */
export const BOUNDS_EDIT_ARC_STEPS = 24;

/** Допуск проверки равенства шагов якорей (доля шага). */
export const BOUNDS_EDIT_ARC_TOLERANCE = 0.005;

/** Желаемый шаг точек записи вдоль видимой кривой (единицы карты). */
export const BOUNDS_EDIT_SAMPLE_SPACING = 24;

/** Минимум точек предпросмотра/записи на участок. */
export const BOUNDS_EDIT_MIN_SAMPLES = 16;

/** Максимум точек предпросмотра/записи на участок (защита от роста файла). */
export const BOUNDS_EDIT_MAX_SAMPLES = 96;

/** Доля ширины окна, на которую пик отодвигается от его границ. */
export const BOUNDS_EDIT_SHAPE_MARGIN = 0.02;

/** Минимальная длина видимого участка (единицы карты) — короче не редактируем. */
export const BOUNDS_EDIT_MIN_SPAN_LENGTH = 4;

/**
 * Допуск воспроизведения предпросмотра при записи (единицы карты). Скругление
 * контура строится по серединам рёбер, поэтому цепочка точек, снятая с
 * нарисованной линии, после записи ложится на неё не точно: расхождение
 * остаётся у краёв участка. Замер на `data/sector-bounds.json` — до 6 единиц
 * при шаге выборки 24; больше — значит запись разъехалась (регрессия).
 */
export const BOUNDS_EDIT_COMMIT_TOLERANCE = 8;

/** Какая часть крайнего куска участка снимается у стыка (см. `denseSpan`). */
export const BOUNDS_EDIT_EDGE_CROP = 0.75;

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

function samePoint(a: Point, b: Point, epsilon = BOUNDS_EDIT_EPSILON): boolean {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Плавный шаг: 0 на концах, 1 в середине, C1-непрерывный. */
export function smoothstep(u: number): number {
  const t = clamp(u, 0, 1);
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
  t = clamp(t, 0, 1);
  const point = add(a, scale(ab, t));
  return { t, distance: lengthOf(subtract(p, point)), point };
}

/* -------------------------------------------------- видимая кривая участка */

/** Кусок видимой линии: отрезок (`control === null`) или квадратичная кривая. */
interface PathPiece {
  readonly from: Point;
  readonly control: Point | null;
  readonly to: Point;
}

/** Видимая линия контура: куски скругления, замыкание и число вершин. */
interface VisibleContour {
  readonly pieces: readonly PathPiece[];
  readonly closed: boolean;
  /** Число вершин без дубля замыкания. */
  readonly vertices: number;
}

/** Замкнутый ли контур: гало — единственная незамкнутая линия. */
function isClosedContour(contour: BoundsPrimitive): boolean {
  return contour.kind !== 'halo';
}

/**
 * Куски видимой линии контура — тем же скруглением, что рисует карта:
 * `smoothPolyline` с замыканием для сектора и туманности, без замыкания для
 * гало. Участок берётся именно отсюда, поэтому якоря, подсветка и предпросмотр
 * лежат на **нарисованной** линии, а не на её локальной перерисовке.
 *
 * Приближение (описано в документации): туманность на карте скругляется
 * `smoothBoundaryAtMapEdge`, где участки вдоль края поля остаются прямыми, а
 * граница края зависит от вида. Здесь берётся обычное скругление: расхождение
 * возможно только там, где контур туманности совпадает с краем поля.
 */
function visibleContour(contour: BoundsPrimitive): VisibleContour {
  const closed = isClosedContour(contour);
  const path = smoothPolyline(contour.points.map(([x, y]) => [x, y] as const), closed);
  const pieces: PathPiece[] = [];
  let from = path.start;
  for (const curve of path.curves) {
    pieces.push({ from, control: curve.control, to: curve.end });
    from = curve.end;
  }
  if (path.tail !== null) pieces.push({ from, control: null, to: path.tail });
  let vertices = contour.points.length;
  if (closed) {
    while (vertices > 1 && samePoint(contour.points[0]!, contour.points[vertices - 1]!)) vertices -= 1;
  }
  return { pieces, closed, vertices };
}

/**
 * Куски видимой линии, накрывающие вершины `spanStart…spanEnd`.
 *
 * У замкнутого контура кусок `j` идёт от стыка перед вершиной `j` до стыка
 * перед вершиной `j + 1`; участок, кончающийся у дубля замыкания, обходит шов и
 * заканчивается первым куском. У открытой линии вершина `0` — начало линии,
 * последняя вершина — конец (хвостовой отрезок).
 */
function spanPieces(contour: BoundsPrimitive, spanStart: number, spanEnd: number): PathPiece[] {
  const visible = visibleContour(contour);
  const pieces = visible.pieces;
  if (pieces.length === 0) return [];
  if (visible.closed) {
    const indexOf = (vertex: number): number => ((vertex % visible.vertices) + visible.vertices) % visible.vertices;
    const last = indexOf(spanEnd);
    let index = indexOf(spanStart);
    const ordered: PathPiece[] = [];
    for (let guard = 0; guard <= pieces.length; guard += 1) {
      ordered.push(pieces[index]!);
      if (index === last) return ordered;
      index = (index + 1) % pieces.length;
    }
    return ordered;
  }
  const from = Math.max(0, spanStart - 1);
  const to = Math.min(pieces.length - 1, spanEnd - 1);
  if (to < from) return [];
  return pieces.slice(from, to + 1);
}

/** Точка куска в параметре `u ∈ [0, 1]`. */
function piecePoint(piece: PathPiece, u: number): Point {
  if (piece.control === null) {
    return [piece.from[0] + (piece.to[0] - piece.from[0]) * u, piece.from[1] + (piece.to[1] - piece.from[1]) * u] as Point;
  }
  const [x0, y0] = piece.from;
  const [x1, y1] = piece.control;
  const [x2, y2] = piece.to;
  const v = 1 - u;
  return [
    v * v * x0 + 2 * v * u * x1 + u * u * x2,
    v * v * y0 + 2 * v * u * y1 + u * u * y2,
  ] as Point;
}

/**
 * Плотная ломаная по кускам: `BOUNDS_EDIT_ARC_STEPS` шагов на кусок, общие
 * концы кусков не дублируются. Крайние куски можно обрезать по параметру
 * `u ∈ [0, 1]` — так участок берётся без половин соседних кусков.
 */
function densePieces(pieces: readonly PathPiece[], firstU = 0, lastU = 1): Point[] {
  const dense: Point[] = [];
  for (let p = 0; p < pieces.length; p += 1) {
    const piece = pieces[p]!;
    const from = p === 0 ? firstU : 0;
    const to = p === pieces.length - 1 ? lastU : 1;
    const steps = Math.max(1, Math.round(BOUNDS_EDIT_ARC_STEPS * Math.max(0.05, to - from)));
    for (let i = p === 0 ? 0 : 1; i <= steps; i += 1) {
      dense.push(piecePoint(piece, from + (to - from) * (i / steps)));
    }
  }
  return dense;
}

/**
 * Плотная видимая кривая участка.
 *
 * Кусок скругления идёт от стыка перед своей вершиной до стыка перед следующей,
 * то есть **начинается позади** своей вершины. Если взять участок целиком, его
 * первые точки окажутся позади структурной вершины, а запись контура поставит
 * их после неё — скругление развернёт линию петлёй (видно на отрисовке).
 * Поэтому крайние куски берутся со своей середины: участок — это та часть
 * нарисованной линии, которую ведут вершины `spanStart…spanEnd`. У открытой
 * линии её собственные концы (`spanStart === 0`, `spanEnd === последняя
 * вершина`) остаются настоящими концами, обрезать их нечем.
 */
function denseSpan(contour: BoundsPrimitive, spanStart: number, spanEnd: number): Point[] {
  const pieces = spanPieces(contour, spanStart, spanEnd);
  if (pieces.length === 0) return [];
  const closed = isClosedContour(contour);
  const openStart = !closed && spanStart === 0;
  const openEnd = !closed && spanEnd === contour.points.length - 1;
  // 0,75 снимает половину соседнего куска у края, но оставляет участок
  // заметным: у двухвершинного участка это четверть каждого из двух кусков.
  // Чем ближе к стыку (0,5), тем больше расхождение с исходной линией на краю.
  const firstU = openStart ? 0 : BOUNDS_EDIT_EDGE_CROP;
  const lastU = openEnd ? 1 : 1 - BOUNDS_EDIT_EDGE_CROP;
  if (pieces.length === 1) {
    // Один кусок на весь участок: берём его часть без выхода за пределы.
    return densePieces(pieces, Math.min(firstU, 0.5), Math.max(lastU, 0.5));
  }
  return densePieces(pieces, firstU, lastU);
}

/** Накопленные длины дуги по ломаной. */
function cumulativeOf(points: readonly Point[]): number[] {
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1]! + lengthOf(subtract(points[i]!, points[i - 1]!)));
  }
  return cumulative;
}

/** Плотная видимая кривая участка как `SampledCurve`: доли — по длине дуги. */
export function denseCurve(contour: BoundsPrimitive, spanStart: number, spanEnd: number): SampledCurve {
  const dense = denseSpan(contour, spanStart, spanEnd);
  const cumulative = cumulativeOf(dense);
  const total = cumulative.at(-1) ?? 0;
  return {
    points: dense,
    fractions: cumulative.map((value) => (total > BOUNDS_EDIT_EPSILON ? value / total : 0)),
    cumulative,
    length: total,
  };
}

/** Точка на ломаной в доле длины дуги `f ∈ [0, 1]` с линейной интерполяцией. */
function pointAtFraction(points: readonly Point[], cumulative: readonly number[], f: number): Point {
  if (points.length === 0) return [0, 0];
  if (points.length === 1) return points[0]!;
  const total = cumulative[cumulative.length - 1]!;
  if (!(total > BOUNDS_EDIT_EPSILON)) return points[0]!;
  const target = clamp(f, 0, 1) * total;
  // Двоичный поиск: ломаная длинная, линейный проход на каждый сэмпл не нужен.
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid]! <= target) low = mid;
    else high = mid;
  }
  const segment = cumulative[high]! - cumulative[low]!;
  const u = segment > BOUNDS_EDIT_EPSILON ? (target - cumulative[low]!) / segment : 0;
  const a = points[low]!;
  const b = points[high]!;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u] as Point;
}

/**
 * Пересэмплирование ломаной равномерно по длине дуги. Нужно на записи: после
 * деформации шаг между точками предпросмотра неравномерен (у пика точки
 * сходятся), а почти совпавшие вершины дают в скруглении излом. Форма не
 * меняется — точки просто переезжают по той же линии.
 */
function resamplePolyline(points: readonly Point[], count: number): Point[] {
  if (points.length < 2 || count < 2) return [...points];
  const cumulative = cumulativeOf(points);
  if (!(cumulative[cumulative.length - 1]! > BOUNDS_EDIT_EPSILON)) return [...points];
  const out: Point[] = [];
  for (let i = 0; i < count; i += 1) out.push(pointAtFraction(points, cumulative, i / (count - 1)));
  return out;
}

/** Проекция точки на ломаную: доля длины дуги, расстояние и точка. */
function projectOnPolyline(
  points: readonly Point[],
  cumulative: readonly number[],
  target: Point,
): { fraction: number; distance: number; point: Point } {
  const total = cumulative[cumulative.length - 1] ?? 0;
  let best = { fraction: 0, distance: Number.POSITIVE_INFINITY, point: points[0] ?? ([0, 0] as Point) };
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const projected = projectOnSegment(target, a, b);
    if (projected.distance >= best.distance) continue;
    const segment = cumulative[i]! - cumulative[i - 1]!;
    const fraction = total > BOUNDS_EDIT_EPSILON
      ? (cumulative[i - 1]! + segment * projected.t) / total
      : 0;
    best = { fraction, distance: projected.distance, point: projected.point };
  }
  return best;
}

/**
 * Видимая кривая участка, пересэмплированная равномерно по длине дуги.
 * `count` — число точек (≥ 2). Точки равноудалены с точностью шага
 * `BOUNDS_EDIT_ARC_STEPS`, начало и конец совпадают со стыками участка.
 */
export function spanCurve(
  contour: BoundsPrimitive,
  spanStart: number,
  spanEnd: number,
  count: number,
  extraFractions: readonly number[] = [],
): SampledCurve {
  const dense = denseCurve(contour, spanStart, spanEnd);
  if (dense.points.length < 2 || count < 2) {
    return { points: dense.points.slice(0, 1), fractions: [0], cumulative: [0], length: 0 };
  }
  const total = dense.length;
  if (!(total > BOUNDS_EDIT_EPSILON)) {
    return {
      points: [dense.points[0]!, dense.points[dense.points.length - 1]!],
      fractions: [0, 1],
      cumulative: [0, 0],
      length: 0,
    };
  }
  // Опорные доли (якоря) входят в набор точек точно: тогда смещение в якоре
  // равно нулю не приближённо, а буквально, и запись ставит вершину в якорь.
  const fractions: number[] = [];
  for (let i = 0; i < count; i += 1) fractions.push(i / (count - 1));
  for (const fraction of extraFractions) fractions.push(clamp(fraction, 0, 1));
  fractions.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const fraction of fractions) {
    if (unique.length === 0 || fraction - unique[unique.length - 1]! > 1e-9) unique.push(fraction);
  }
  const sampled: Point[] = [];
  const cumulative: number[] = [];
  for (const fraction of unique) {
    sampled.push(pointAtFraction(dense.points, dense.cumulative, fraction));
    cumulative.push(fraction * total);
  }
  return { points: sampled, fractions: unique, cumulative, length: total };
}

/** Число точек записи/предпросмотра под длину видимой кривой участка. */
export function spanSampleCount(contour: BoundsPrimitive, spanStart: number, spanEnd: number): number {
  const total = denseCurve(contour, spanStart, spanEnd).length;
  const wanted = Math.round(total / BOUNDS_EDIT_SAMPLE_SPACING) + 1;
  return clamp(wanted, BOUNDS_EDIT_MIN_SAMPLES, BOUNDS_EDIT_MAX_SAMPLES);
}

/** Длина видимой кривой участка. */
export function spanLength(contour: BoundsPrimitive, spanStart: number, spanEnd: number): number {
  return denseCurve(contour, spanStart, spanEnd).length;
}

/** Точка на видимой кривой в доле длины дуги. */
export function pointOnSpan(curve: SampledCurve, fraction: number): Point {
  return pointAtFraction(curve.points, curve.cumulative, fraction);
}

/** 5 якорей на видимой кривой участка: точки в долях длины дуги 0,1…0,9. */
export function anchorsForSpan(contour: BoundsPrimitive, spanStart: number, spanEnd: number): Point[] {
  return anchorsOf(denseCurve(contour, spanStart, spanEnd));
}

/** Точки якорей, взятые из уже пересэмплированной кривой (доли входят в неё). */
export function anchorsOf(curve: SampledCurve): Point[] {
  return BOUNDS_EDIT_ANCHOR_FRACTIONS.map((fraction) => pointOnSpan(curve, fraction));
}

/**
 * Проверка равенства шагов якорей **по длине дуги**: максимальное относительное
 * отклонение шага от среднего (доля шага). Расстояние меряется вдоль видимой
 * кривой участка, а не по прямой между якорями: у изогнутого участка равные
 * дуги дают разные хорды, и хорда как метрика дала бы ложное расхождение.
 */
export function anchorSpacingDeviation(
  contour: BoundsPrimitive,
  spanStart: number,
  spanEnd: number,
  anchors?: readonly Point[],
): number {
  const dense = denseCurve(contour, spanStart, spanEnd);
  const list = anchors ?? anchorsOf(dense);
  if (list.length < 2) return 0;
  if (!(dense.length > BOUNDS_EDIT_EPSILON)) return 0;
  const positions = list.map((anchor) => projectOnPolyline(dense.points, dense.cumulative, anchor).fraction * dense.length);
  const steps: number[] = [];
  for (let i = 1; i < positions.length; i += 1) steps.push(positions[i]! - positions[i - 1]!);
  const mean = steps.reduce((sum, value) => sum + value, 0) / steps.length;
  if (!(mean > BOUNDS_EDIT_EPSILON)) return 0;
  return Math.max(...steps.map((step) => Math.abs(step - mean))) / mean;
}

/**
 * Окно влияния для доли длины дуги: интервал между двумя соседними якорями.
 * Если доля совпала с якорем (частый случай двойного клика в середину участка),
 * берётся интервал шире или, при равенстве, правый — важно, что окно **не
 * пустое**: прежняя реализация возвращала `null` и правка молча не работала.
 */
export function influenceWindowFor(fraction: number): [number, number] {
  const stops = [0, ...BOUNDS_EDIT_ANCHOR_FRACTIONS, 1];
  const f = clamp(fraction, 0, 1);
  let best: [number, number] = [0, 1];
  let bestWidth = -1;
  for (let i = 0; i + 1 < stops.length; i += 1) {
    const left = stops[i]!;
    const right = stops[i + 1]!;
    if (f < left - BOUNDS_EDIT_EPSILON || f > right + BOUNDS_EDIT_EPSILON) continue;
    const width = right - left;
    if (width > bestWidth) {
      best = [left, right];
      bestWidth = width;
    }
  }
  return best;
}

/**
 * Деформация видимой кривой участка: каждая точка смещается на
 * `(ядро − точка в пике) · shape(f)`, где `shape` — два smoothstep-нуля на
 * границах окна и единица в пике. Вне окна смещение строго ноль.
 */
export function deformSpan(
  base: SampledCurve,
  core: Point,
  window: readonly [number, number],
  peakFraction: number,
): Point[] {
  const [left, right] = window;
  const peak = clamp(peakFraction, left, right);
  const peakPoint = pointOnSpan(base, peak);
  const pull = subtract(core, peakPoint);
  const deformed: Point[] = [];
  for (let i = 0; i < base.points.length; i += 1) {
    const f = base.fractions[i] ?? 0;
    if (f <= left || f >= right) {
      deformed.push(base.points[i]!);
      continue;
    }
    const before = smoothstep((f - left) / Math.max(BOUNDS_EDIT_EPSILON, peak - left));
    const after = smoothstep((right - f) / Math.max(BOUNDS_EDIT_EPSILON, right - peak));
    const shape = before * after;
    const point = base.points[i]!;
    deformed.push([point[0] + pull[0] * shape, point[1] + pull[1] * shape] as Point);
  }
  return deformed;
}

/**
 * Позиция пика: проекция ядра, зажатая внутрь окна на
 * `BOUNDS_EDIT_SHAPE_MARGIN` его ширины. Гарантирует ненулевой `shape`.
 */
export function peakFractionIn(window: readonly [number, number], rawFraction: number): number {
  const [left, right] = window;
  const margin = (right - left) * BOUNDS_EDIT_SHAPE_MARGIN;
  return clamp(rawFraction, left + margin, right - margin);
}

/* --------------------------------------------------------- контуры и участки */

/** Контур по id; `null` — такого контура нет. */
export function contourOf(doc: SectorBounds, contourId: string): BoundsPrimitive | null {
  return doc.bounds.find((item) => item.id === contourId) ?? null;
}

/** Вершины сегмента по индексу начальной вершины; `null` — вне диапазона. */
export function edgePoints(contour: BoundsPrimitive, edgeIndex: number): [Point, Point] | null {
  if (edgeIndex < 0 || edgeIndex + 1 >= contour.points.length) return null;
  const a = contour.points[edgeIndex];
  const b = contour.points[edgeIndex + 1];
  if (a === undefined || b === undefined) return null;
  return [a, b];
}

/** Пометки «мягких» вершин контура из сессии (пустой список — все структурные). */
export function softIndicesOf(session: BoundsEditSession, contourId: string): readonly number[] {
  return session.soft[contourId] ?? [];
}

/** Вершина помечена как вставленная правкой. */
export function isSoftVertex(session: BoundsEditSession, contourId: string, index: number): boolean {
  return softIndicesOf(session, contourId).includes(index);
}

/**
 * Границы участка по клику: расширяемся влево и вправо сквозь «мягкие» вершины
 * до ближайших структурных. Участок не переносится через шов замыкания: границы
 * обрезаются первой и последней вершинами контура.
 */
export function resolveSpan(
  points: readonly Point[],
  soft: readonly number[],
  edgeIndex: number,
): { spanStart: number; spanEnd: number } | null {
  if (points.length < 2) return null;
  if (edgeIndex < 0 || edgeIndex + 1 >= points.length) return null;
  const softSet = new Set(soft);
  let start = edgeIndex;
  while (start > 0 && softSet.has(start)) start -= 1;
  let end = edgeIndex + 1;
  const last = points.length - 1;
  while (end < last && softSet.has(end)) end += 1;
  if (start === end) return null;
  return { spanStart: start, spanEnd: end };
}

/** Вершины участка (включая концы). */
export function spanPoints(contour: BoundsPrimitive, spanStart: number, spanEnd: number): Point[] {
  return contour.points.slice(spanStart, spanEnd + 1).map((point) => point);
}

/**
 * Выбор участка по клику: ближайшая **видимая** кривая всех контуров в пределах
 * `tolerance` (мировые единицы). Возвращает участок вместе с его видимой кривой,
 * чтобы интерфейс подсветил именно то, что видит пользователь.
 */
export function pickBoundsEdge(
  session: BoundsEditSession,
  x: number,
  y: number,
  tolerance: number,
): EdgeSelection | null {
  const click: Point = [x, y];
  let best: EdgeSelection | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [contourIndex, contour] of session.doc.bounds.entries()) {
    const soft = softIndicesOf(session, contour.id);
    for (let edgeIndex = 0; edgeIndex + 1 < contour.points.length; edgeIndex += 1) {
      const edge = edgePoints(contour, edgeIndex);
      if (edge === null) continue;
      const span = resolveSpan(contour.points, soft, edgeIndex);
      if (span === null) continue;
      const count = Math.min(spanSampleCount(contour, span.spanStart, span.spanEnd), 48);
      const curve = spanCurve(contour, span.spanStart, span.spanEnd, count);
      const projected = projectOnPolyline(curve.points, curve.cumulative, click);
      if (projected.distance > tolerance) continue;
      if (projected.distance >= bestDistance) continue;
      const onEdge = projectOnSegment(click, edge[0], edge[1]);
      best = {
        contourId: contour.id,
        contourIndex,
        edgeIndex,
        t: onEdge.t,
        spanStart: span.spanStart,
        spanEnd: span.spanEnd,
        curve: curve.points,
      };
      bestDistance = projected.distance;
    }
  }
  return best;
}

/* ---------------------------------------------------------------- сессия */

/** Новая пустая сессия правки. */
export function createBoundsEditSession(
  doc: SectorBounds,
  soft: Readonly<Record<string, readonly number[]>> = {},
): BoundsEditSession {
  return { doc, soft, past: [], future: [], active: null, selection: null, sequence: 0 };
}

/** Обрезка точки по границам поля (0…10000). */
export function clampToMap(point: Point): Point {
  return [clamp(point[0], 0, BOUNDS_EDIT_MAP_BOUND), clamp(point[1], 0, BOUNDS_EDIT_MAP_BOUND)] as Point;
}

/** Окно влияния и проекция ядра для активной правки. */
function activeFor(
  contour: BoundsPrimitive,
  contourIndex: number,
  spanStart: number,
  spanEnd: number,
  corePoint: Point,
  window?: readonly [number, number],
  snapCore = false,
): BoundsEditActive | null {
  if (spanEnd <= spanStart || spanEnd >= contour.points.length) return null;
  if (!(spanLength(contour, spanStart, spanEnd) >= BOUNDS_EDIT_MIN_SPAN_LENGTH)) return null;
  const count = spanSampleCount(contour, spanStart, spanEnd);
  const base = spanCurve(contour, spanStart, spanEnd, count, BOUNDS_EDIT_ANCHOR_FRACTIONS);
  const target = clampToMap(corePoint);
  const raw = projectOnPolyline(base.points, base.cumulative, target).fraction;
  const box: readonly [number, number] = window ?? influenceWindowFor(raw);
  const peak = peakFractionIn(box, raw);
  // Ядро при открытии садится **на линию** в позицию пика: появление правки не
  // деформирует контур, а неподвижный коммит остаётся пустым. Отклонение от
  // точки клика — доли шага якоря, за пределы толеранса выбора не выходит.
  const core = snapCore ? pointOnSpan(base, peak) : target;
  return {
    contourId: contour.id,
    contourIndex,
    spanStart,
    spanEnd,
    core,
    coreFraction: peak,
    coreRawFraction: raw,
    anchors: anchorsOf(base),
    anchorFractions: [...BOUNDS_EDIT_ANCHOR_FRACTIONS],
    window: box,
    base: base.points,
    curve: deformSpan(base, core, box, peak),
  };
}

/**
 * Открытие правки участка (двойной клик): ядро — в точке клика (обрезано по
 * полю), якоря — 5 равноудалённых точек видимой кривой, окно влияния — между
 * соседними якорями. Коммит ещё не сделан: предпросмотр живёт в `active`.
 * Повторный двойной клик заменяет правку (журнал не трогается).
 */
export function beginBoundsEdit(
  session: BoundsEditSession,
  contourId: string,
  edgeIndex: number,
  point: Point,
): BoundsEditSession {
  const base = session.active !== null ? cancelBoundsEdit(session) : session;
  const contour = contourOf(base.doc, contourId);
  if (contour === null) return base;
  const span = resolveSpan(contour.points, softIndicesOf(base, contourId), edgeIndex);
  if (span === null) return base;
  const contourIndex = base.doc.bounds.findIndex((item) => item.id === contourId);
  const active = activeFor(contour, contourIndex, span.spanStart, span.spanEnd, point, undefined, true);
  if (active === null) return { ...base, selection: null };
  const selection: EdgeSelection = {
    contourId,
    contourIndex,
    edgeIndex,
    t: projectOnSegment(clampToMap(point), contour.points[span.spanStart]!, contour.points[span.spanEnd]!).t,
    spanStart: span.spanStart,
    spanEnd: span.spanEnd,
    curve: active.base,
  };
  return { ...base, active, selection };
}

/**
 * Перетаскивание ядра: пересчитать проекцию, пик и предпросмотр. Окно влияния
 * и якоря остаются прежними — это устойчивые опоры, а не бегущие за курсором
 * точки. Ядро обрезается по полю, поэтому коммит всегда корректен.
 */
export function moveBoundsEditCore(session: BoundsEditSession, point: Point): BoundsEditSession {
  const active = session.active;
  if (active === null) return session;
  const contour = contourOf(session.doc, active.contourId);
  if (contour === null) return session;
  const next = activeFor(contour, active.contourIndex, active.spanStart, active.spanEnd, point, active.window);
  if (next === null) return session;
  if (samePoint(active.core, next.core) && active.curve === next.curve) return session;
  return { ...session, active: next };
}

/**
 * Коммит правки (на отпускании ядра): деформированные точки участка заменяют
 * внутренние вершины, вставленные вершины помечаются мягкими, запись идёт в
 * журнал. Если геометрия не изменилась (ядро вернули на линию или кликнули без
 * перемещения), коммит **не создаёт записи** и просто закрывает правку.
 */
export function commitBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const active = session.active;
  if (active === null) return session;
  const contour = contourOf(session.doc, active.contourId);
  if (contour === null) return session;
  const before = contour.points;
  const spanStart = active.spanStart;
  const spanEnd = active.spanEnd;
  if (spanEnd >= before.length) return session;
  if (active.curve.length < 3) return { ...session, active: null, selection: null };

  // «Изменений нет»: ни одна точка предпросмотра не сдвинулась относительно
  // базовой линии — записи не будет. Проверка идёт до выравнивания шага.
  const moved = active.curve.some((point, index) => {
    const reference = active.base[index];
    return reference !== undefined && !samePoint(point, reference);
  });
  if (!moved) return { ...session, active: null, selection: null };

  // Внутренние точки видимой кривой между концами участка: концы не двигаются.
  // Шаг выравнивается по длине дуги, иначе у пика деформации вершины сходятся
  // почти в одну точку и скругление рисует излом.
  const sampled = resamplePolyline(active.curve, active.curve.length);
  const inserted: Point[] = [];
  for (let i = 1; i < sampled.length - 1; i += 1) inserted.push(sampled[i]!);

  const nextPoints: Point[] = [
    ...before.slice(0, spanStart + 1),
    ...inserted,
    ...before.slice(spanEnd),
  ];

  if (inserted.length === 0) return { ...session, active: null, selection: null };

  const shift = inserted.length - (spanEnd - spanStart - 1);
  const contourSoft = softIndicesOf(session, active.contourId);
  const nextSoft: number[] = [];
  for (const index of contourSoft) {
    if (index <= spanStart) nextSoft.push(index);
    else if (index >= spanEnd) nextSoft.push(index + shift);
  }
  for (let i = 0; i < inserted.length; i += 1) nextSoft.push(spanStart + 1 + i);
  nextSoft.sort((a, b) => a - b);

  const entry: BoundsEditEntry = {
    sequence: session.sequence + 1,
    contourId: active.contourId,
    contourIndex: active.contourIndex,
    spanStart,
    spanEnd,
    before: { points: [...before], soft: [...contourSoft] },
    after: { points: nextPoints, soft: nextSoft },
  };
  const nextDoc: SectorBounds = {
    ...session.doc,
    bounds: session.doc.bounds.map((item) => (item.id === active.contourId ? { ...item, points: nextPoints } : item)),
  };
  return {
    doc: nextDoc,
    soft: { ...session.soft, [active.contourId]: nextSoft },
    past: [...session.past, entry],
    future: [],
    active: null,
    selection: null,
    sequence: entry.sequence,
  };
}

/** Отмена правки (Escape, правый клик): предпросмотр теряется, документ цел. */
export function cancelBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  if (session.active === null) return session;
  return { ...session, active: null, selection: null };
}

/** Выбор участка для подсветки (UI-состояние, в журнал не идёт). */
export function selectBoundsEdge(session: BoundsEditSession, selection: EdgeSelection | null): BoundsEditSession {
  if (selection === null && session.selection === null) return session;
  if (selection !== null && session.selection !== null
    && selection.contourId === session.selection.contourId
    && selection.edgeIndex === session.selection.edgeIndex
    && selection.spanStart === session.selection.spanStart
    && selection.spanEnd === session.selection.spanEnd) return session;
  return { ...session, selection };
}

/** Документ с восстановленным снимком контура. */
function withSnapshot(session: BoundsEditSession, contourId: string, snapshot: ContourSnapshot): BoundsEditSession {
  return {
    ...session,
    doc: {
      ...session.doc,
      bounds: session.doc.bounds.map((item) => (item.id === contourId ? { ...item, points: [...snapshot.points] } : item)),
    },
    soft: { ...session.soft, [contourId]: [...snapshot.soft] },
  };
}

/**
 * Отмена последнего коммита (Ctrl+Z): документ возвращается к `before`,
 * активная правка сбрасывается. Один вызов — один шаг.
 */
export function undoBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const entry = session.past.at(-1);
  if (entry === undefined) return session;
  if (contourOf(session.doc, entry.contourId) === null) return session;
  const restored = withSnapshot(session, entry.contourId, entry.before);
  return {
    ...restored,
    past: session.past.slice(0, -1),
    future: [...session.future, entry],
    active: null,
    selection: null,
    sequence: session.sequence,
  };
}

/** Повтор отменённого коммита (Ctrl+Shift+Z) — тоже один шаг. */
export function redoBoundsEdit(session: BoundsEditSession): BoundsEditSession {
  const entry = session.future.at(-1);
  if (entry === undefined) return session;
  if (contourOf(session.doc, entry.contourId) === null) return session;
  const restored = withSnapshot(session, entry.contourId, entry.after);
  return {
    ...restored,
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

/**
 * Загрузка документа в сессию после импорта: журнал очищается, пометки мягких
 * вершин и выбор сбрасываются — в файле их нет, а угадывать происхождение
 * вершин нельзя. `null` — импорт невозможен (нет контуров).
 */
export function importBoundsEdit(doc: SectorBounds): BoundsEditSession {
  return createBoundsEditSession(doc, {});
}
