/* Иерархическая правка якорями (§4 и §7 ТЗ `SEC-AREAS-HIERARCHY`).
 *
 * Слой намеренно **без DOM и без рендера**: чистая геометрия над видимой
 * кривой. Интерфейс (`sector-areas-hierarchy-ui.ts`) вызывает команды и сам
 * рисует результат. Видимая кривая строится тем же правилом `smoothPolyline`
 * (квадратичные куски через середины соседних рёбер), которым контуры областей
 * и линии рисует карта, поэтому якоря стоят на реально отображаемой линии,
 * а не на невидимой хорде или исходных вершинах.
 *
 * ------------------------------------------------------------------ модель
 *
 * **Замкнутый контур, первое деление (§4.1).** Двойной клик по линии ставит
 * первый якорь в проецированную точку клика и ещё пять — ровно через `L/6`
 * длины дуги по всей видимой линии. Итого шесть якорей и шесть криволинейных
 * сегментов. Равенство шагов здесь точное: на замкнутой кривой достаточно
 * циклического сдвига. Допуск проверки — `ANCHOR_EQUAL_TOLERANCE` (доля шага).
 *
 * **Уточнение сегмента (§4.2).** Двойной клик внутри сегмента между двумя
 * соседними якорями: крайние якоря остаются на месте и не дублируются, внутри
 * сегмента появляются четыре якоря, один из которых — точно в точке клика.
 * Итого шесть якорей и пять кривых на этом участке; остальные сегменты и
 * якоря не меняются. Уточнение можно повторять на любом сегменте.
 *
 * Одновременно «якорь точно в клике» и «все пять частей строго равны» на
 * кривой достижимы не всегда. Решение исполнителя: точка клика не двигается,
 * а два «берега» сегмента делятся поровну каждый внутри себя. Более длинный
 * берег делится на три части (два внутренних якоря), короткий — на две
 * (один якорь); при равенстве берегов три части получает левый берег. Алгоритм
 * детерминирован и документирован; части внутри берега равны по длине дуги.
 *
 * **Слишком близкий клик.** Если точка клика ближе `ANCHOR_MIN_GAP` к
 * существующему якорю (или к концу открытой линии), деление отклоняется
 * с понятным сообщением: совпадающие якоря не создаются.
 *
 * **Открытая линия (§7).** Первое деление — адаптация того же правила:
 * концы линии становятся крайними якорями, клик даёт якорь в точке клика,
 * плюс три внутренних по тому же береговому правилу. Итого шесть якорей
 * и пять кривых. Концы линии перетаскиваются только внутри области
 * взаимодействия (`clampRegion`): выход стягивается к границе, а результат
 * помечается `limited` — интерфейс показывает уведомление. Для внутренних
 * якорей ограничение не действует.
 *
 * **Перетаскивание якоря (§4.3).** Смещение деформирует видимую кривую
 * локально: окно влияния — интервал между соседними якорями; внутри окно
 * сдвигается на `(цель − якорь) · w(f)` с гладким булмпом `w` (ноль на границах
 * окна, единица в якоре); за окном смещение строго ноль — остальные якоря и
 * вершины не двигаются. Якорь оказывается точно в целевой точке.
 *
 * Защита действия: если деформация выводит точки за поле карты, разворачивает
 * петлю (самопересечение кривой) или ставит якоря ближе `ANCHOR_MIN_GAP`,
 * смещение сжимается бинарным поиском; если и при `ANCHOR_MIN_Traction`
 * исходного сдвига действие недопустимо, оно отклоняется с сообщением —
 * данные не портятся молча.
 *
 * **Коммит.** Вершины кольца «едут» на деформированной кривой: каждая вершина
 * хранит свою долю длины дуги на базовой кривой и после правки берётся с той
 * же долей. Количество вершин и соответствие сохраняются, соседние участки
 * вне окна не меняются. После коммита кривая пересэмплируется из записанного
 * кольца; расхождение с предпросмотром не превышает «среза угла» шага
 * сэмплирования (замер — в тестах, `ANCHOR_COMMIT_TOLERANCE`).
 *
 * **Сохранение и загрузка.** Хранятся якоря (доля дуги + точная точка). При
 * повторном открытии якоря перепривязываются к кривой по ближайшей точке;
 * дрейф сверх `ANCHOR_RESNAP_TOLERANCE` возвращается вызывающему коду, чтобы
 * интерфейс мог сообщить о состоянии «требует пересмотра», не теряя данные.
 *
 * Ограничение: правка работает в плоскости карты `0…10000`; замкнутый контур
 * не переносится через шов начала списка вершин (якоря хранятся в долях дуги
 * и переживают циклический сдвиг начала).
 */

import type { AreaPoint, CurveAnchor, Ring } from './sector-areas-contract.ts';
/* --------------------------------------------------------------- константы */

/** Шагов на один квадратичный кусок при построении плотной видимой кривой. */
export const ANCHOR_ARC_STEPS = 24;

/** Сколько якорей создаётся при первом делении замкнутого контура (§4.1). */
export const ANCHOR_COUNT_CLOSED = 6;

/** Сколько якорей создаётся на открытой линии при первом делении (§7). */
export const ANCHOR_COUNT_OPEN = 6;

/** Допуск равенства шагов якорей первого деления (доля шага, тесты). */
export const ANCHOR_EQUAL_TOLERANCE = 0.005;

/** Допуск попадания клика на линию по умолчанию (единицы карты). */
export const ANCHOR_CLICK_TOLERANCE = 24;

/** Минимальное расстояние между якорями (единицы карты). */
export const ANCHOR_MIN_GAP = 12;

/** Минимальная длина кривой, которую берём в правку (единицы карты). */
export const ANCHOR_MIN_CURVE_LENGTH = 4;

/** Доля исходного сдвига, ниже которой тяга отклоняется целиком. */
export const ANCHOR_MIN_TRACTION = 0.02;

/** Граница поля карты: координаты точек кривой держатся внутри. */
export const ANCHOR_MAP_BOUND = 10000;

/** Допуск расхождения предпросмотра и записанной кривой (единицы карты). */
export const ANCHOR_COMMIT_TOLERANCE = 8;

/** Допуск перепривязки якоря к кривой при повторном открытии (единицы карты). */
export const ANCHOR_RESNAP_TOLERANCE = 12;

/** Желаемый шаг точек при записи линии сочетания (единицы карты). */
export const ANCHOR_LINE_SPACING = 24;

/** Границы числа точек записанной линии сочетания. */
export const ANCHOR_LINE_MIN_SAMPLES = 8;
export const ANCHOR_LINE_MAX_SAMPLES = 200;

/* ------------------------------------------------------------ видимая кривая */

/** Плотная ломаная видимой кривой с накопленными длинами дуги. */
export interface SampledCurve {
  readonly points: readonly AreaPoint[];
  /** Длина дуги от начала до каждой точки (монотонно). */
  readonly cumulative: readonly number[];
  readonly length: number;
}






function cumulativeOf(points: readonly AreaPoint[]): { cumulative: readonly number[]; length: number } {
  const cumulative: number[] = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    total += Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    cumulative.push(total);
  }
  return { cumulative, length: total };
}

/**
 * Видимая кривая замкнутого кольца: скругление тем же правилом, что в рендере,
 * с `ANCHOR_ARC_STEPS` шагами на кусок. Слишком короткое или вырожденное
 * кольцо в правку не берётся (`null`).
 */
export function sampleRing(ring: Ring): SampledCurve | null {
  return samplePolyline(ring, true);
}

/** Видимая кривая открытой линии; `null` — линию править нельзя. */
export function sampleLine(points: readonly AreaPoint[]): SampledCurve | null {
  return samplePolyline(points, false);
}

function samplePolyline(line: readonly AreaPoint[], closed: boolean): SampledCurve | null {
  const vertices = dedupClosingPoint(line, closed);
  const minimum = closed ? 3 : 2;
  if (vertices.length < minimum) return null;
  // Плотная выборка **прямыми** отрезками той же ломаной, которую рисует карта
  // (`traceRing` в `canvas-renderer` идёт lineTo по точкам LOD): якоря и
  // допуск клика совпадают с видимой линией, а не со сглаженной хордой.
  const dense: AreaPoint[] = [];
  const segments = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < segments; index += 1) {
    const from = vertices[index]!;
    const to = vertices[(index + 1) % vertices.length]!;
    for (let step = index === 0 ? 0 : 1; step <= ANCHOR_ARC_STEPS; step += 1) {
      const u = step / ANCHOR_ARC_STEPS;
      dense.push([from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u]);
    }
  }
  const { cumulative, length } = cumulativeOf(dense);
  if (!Number.isFinite(length) || length < ANCHOR_MIN_CURVE_LENGTH) return null;
  return { points: dense, cumulative, length };
}

/** Точка на кривой по доле длины дуги `s ∈ [0, 1]` (замкнутая — по модулю). */
export function curvePointAt(curve: SampledCurve, s: number, closed: boolean): AreaPoint {
  const total = curve.length;
  let target = ((s % 1) + 1) % 1;
  if (!closed) target = Math.min(1, Math.max(0, s)) * total;
  else target = target * total;
  // Бинарный поиск по накопленным длинам.
  let low = 0;
  let high = curve.cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    const value = curve.cumulative[mid] ?? 0;
    if (value < target) low = mid;
    else high = mid;
  }
  const from = curve.points[low] ?? [0, 0];
  const to = curve.points[high] ?? from;
  const span = (curve.cumulative[high] ?? 0) - (curve.cumulative[low] ?? 0);
  const t = span <= 1e-12 ? 0 : (target - (curve.cumulative[low] ?? 0)) / span;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

export interface CurveProjection {
  /** Доля длины дуги ближайшей точки. */
  readonly s: number;
  /** Расстояние от точки до кривой (единицы карты). */
  readonly distance: number;
  /** Ближайшая точка кривой. */
  readonly point: AreaPoint;
}

/** Ближайшая точка кривой к данной; перебор сегментов плотной ломаной. */
export function projectOnCurve(curve: SampledCurve, p: AreaPoint, closed: boolean): CurveProjection {
  const points = curve.points;
  const count = points.length;
  const segments = closed ? count : count - 1;
  let best: CurveProjection = { s: 0, distance: Infinity, point: points[0] ?? [0, 0] };
  for (let index = 0; index < segments; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % count]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 <= 1e-12 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    t = Math.min(1, Math.max(0, t));
    const x = a[0] + abx * t;
    const y = a[1] + aby * t;
    const distance = Math.hypot(p[0] - x, p[1] - y);
    if (distance < best.distance) {
      const arcStart = curve.cumulative[index] ?? 0;
      const arcEnd = curve.cumulative[(index + 1) % count] ?? curve.length;
      const s = arcEnd <= arcStart ? (curve.cumulative[index] ?? 0) / curve.length
        : (arcStart + (arcEnd - arcStart) * t) / curve.length;
      best = { s, distance, point: [x, y] };
    }
  }
  return best;
}

/* ----------------------------------------------------------------- утилиты */

function smoothstep(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
}

function sortedAnchors(anchors: readonly CurveAnchor[]): readonly CurveAnchor[] {
  return [...anchors].sort((a, b) => a.s - b.s);
}

/** Считает самопересечения ломаной (полные, кроме общих концов соседних). */
export function chainIntersections(points: readonly AreaPoint[], closed: boolean): number {
  const count = points.length;
  if (count < 3) return 0;
  const segments = closed ? count : count - 1;
  let found = 0;
  const intersects = (i1: number, i2: number): boolean => {
    const a0 = points[i1 % count]!;
    const a1 = points[(i1 + 1) % count]!;
    const b0 = points[i2 % count]!;
    const b1 = points[(i2 + 1) % count]!;
    const d1x = a1[0] - a0[0];
    const d1y = a1[1] - a0[1];
    const d2x = b1[0] - b0[0];
    const d2y = b1[1] - b0[1];
    const denominator = d1x * d2y - d1y * d2x;
    if (Math.abs(denominator) < 1e-12) return false;
    const t = ((b0[0] - a0[0]) * d2y - (b0[1] - a0[1]) * d2x) / denominator;
    const u = ((b0[0] - a0[0]) * d1y - (b0[1] - a0[1]) * d1x) / denominator;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
  };
  for (let i = 0; i < segments; i += 1) {
    for (let j = i + 2; j < segments; j += 1) {
      if (closed && i === 0 && j === segments - 1) continue;
      if (intersects(i, j)) found += 1;
    }
  }
  return found;
}

function bboxOf(points: readonly AreaPoint[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

function bboxOverlap(a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>, margin: number): boolean {
  return a.x0 - margin <= b.x1 && b.x0 - margin <= a.x1 && a.y0 - margin <= b.y1 && b.y0 - margin <= a.y1;
}

/**
 * Локальная проверка петли: деформация двигает только точки с весом > 0, поэтому
 * сравниваем пересечения **окна** (цепочка деформированных точек с запасом) —
 * внутри себя и с ближайшими неподвижными сегментами. Полный перебор кривой
 * на каждый шаг тяги не нужен: вне окна точки совпадают с базой.
 */
function localIntersectionIncrease(
  base: readonly AreaPoint[],
  next: readonly AreaPoint[],
  weights: Float64Array,
  closed: boolean,
): boolean {
  const count = next.length;
  let firstActive = -1;
  let lastActive = -1;
  for (let index = 0; index < count; index += 1) {
    if ((weights[index] ?? 0) > 0) {
      if (firstActive < 0) firstActive = index;
      lastActive = index;
    }
  }
  if (firstActive < 0) return false;
  const margin = 8;
  // Окно анализа: у замкнутой кривой — с циклическим запасом; у открытой —
  // зажато в диапазон точек (циклический перенос соединял начало и конец
  // линии в одну «цепочку» и давал ложные пересечения с фантомным
  // замыкающим сегментом).
  const i0 = closed ? ((firstActive - margin) % count + count) % count : Math.max(0, firstActive - margin);
  const i1 = closed ? (lastActive + margin) % count : Math.min(count - 1, lastActive + margin);
  const windowIndices: number[] = [];
  for (let step = i0; ; step = closed ? (step + 1) % count : step + 1) {
    windowIndices.push(step);
    if (step === i1) break;
  }
  const chain = windowIndices.map((pointIndex) => next[pointIndex]!);
  const chainBase = windowIndices.map((pointIndex) => base[pointIndex]!);
  const internalNext = chainIntersections(chain, false);
  const internalBase = chainIntersections(chainBase, false);
  if (internalNext > internalBase) return true;
  // Неподвижные сегменты рядом с окном: их концы не входят в цепочку окна.
  const chainBox = bboxOf(chain);
  const inWindow = new Set(windowIndices);
  const nearby: Array<readonly [AreaPoint, AreaPoint]> = [];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    if (inWindow.has(index) || inWindow.has((index + 1) % count)) continue;
    const a = base[index]!;
    const b = base[(index + 1) % count]!;
    if (bboxOverlap(chainBox, { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) }, 1)) {
      nearby.push([a, b]);
    }
  }
  if (nearby.length === 0) return false;
  const crossesChain = (chainPoints: readonly AreaPoint[]): number => {
    let found = 0;
    for (let i = 0; i + 1 < chainPoints.length; i += 1) {
      const a0 = chainPoints[i]!;
      const a1 = chainPoints[i + 1]!;
      for (const [b0, b1] of nearby) {
        const d1x = a1[0] - a0[0];
        const d1y = a1[1] - a0[1];
        const d2x = b1[0] - b0[0];
        const d2y = b1[1] - b0[1];
        const denominator = d1x * d2y - d1y * d2x;
        if (Math.abs(denominator) < 1e-12) continue;
        const t = ((b0[0] - a0[0]) * d2y - (b0[1] - a0[1]) * d2x) / denominator;
        const u = ((b0[0] - a0[0]) * d1y - (b0[1] - a0[1]) * d1x) / denominator;
        if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) found += 1;
      }
    }
    return found;
  };
  return crossesChain(chain) > crossesChain(chainBase);
}

/* --------------------------------------------------- состояние правки якорями */

/**
 * Состояние иерархической правки одной кривой: коммит-геометрия (`ring`),
 * её видимая кривая, якоря и — на время тяги — деформированный предпросмотр.
 * Для открытой линии сочетания `ring` хранит записанные точки линии.
 */
export interface ContourEditState {
  /**
   * Коммит-геометрия. У замкнутого кольца повторная конечная точка убрана:
   * слой записи (UI) возвращает её на место при сохранении области.
   */
  readonly ring: Ring;
  readonly closed: boolean;
  readonly curve: SampledCurve;
  /** Доля длины дуги каждой вершины `ring` на базовой кривой. */
  readonly vertexFractions: readonly number[];
  readonly anchors: readonly CurveAnchor[];
  /** Деформированный предпросмотр (та же длина массива, что у `curve.points`). */
  readonly preview: readonly AreaPoint[] | null;
  /** Кривая, на которой стоят якоря сейчас: предпросмотр или базовая. */
  readonly activeCurve: SampledCurve;
  /** Индекс перетаскиваемого якоря во время тяги; `null` — тяги нет. */
  readonly draggedIndex: number | null;
}

/**
 * Доли вершин кольца на кривой. Кривая — плотная выборка той же ломаной, поэтому
 * доля вершины — её накопленная длина, делённая на длину кривой (точно, без
 * проекций). Используется коммитом: вершины вне окна остаются на своих долях.
 */
function vertexFractionsOf(ring: Ring, closed: boolean, curve: SampledCurve): readonly number[] {
  const vertices = dedupClosingPoint(ring, closed);
  const minimum = closed ? 3 : 2;
  if (vertices.length < minimum) return ring.map((_, index) => (ring.length === 0 ? 0 : index / ring.length));
  const { cumulative, length } = cumulativeOf(vertices);
  if (length <= 0) return vertices.map((_, index) => (vertices.length === 0 ? 0 : index / vertices.length));
  const fractions = vertices.map((_, index) => (cumulative[index] ?? 0) / length);
  if (!closed) {
    // Концы открытой линии — ровно 0 и 1.
    fractions[0] = 0;
    fractions[fractions.length - 1] = 1;
  }
  void curve;
  return fractions;
}

function stateOf(ring: Ring, closed: boolean, anchors: readonly CurveAnchor[], preview: readonly AreaPoint[] | null): ContourEditState | null {
  const points = dedupClosingPoint(ring, closed);
  const curve = samplePolyline(points, closed);
  if (curve === null) return null;
  return {
    ring: points,
    closed,
    curve,
    vertexFractions: vertexFractionsOf(points, closed, curve),
    anchors: sortedAnchors(anchors),
    preview,
    activeCurve: curve,
    draggedIndex: null,
  };
}

/** У замкнутого кольца убирается повторная конечная точка (шов замыкания). */
function dedupClosingPoint(ring: Ring, closed: boolean): Ring {
  if (!closed || ring.length < 2) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined) return ring;
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return ring;
}

/**
 * Открывает правку замкнутого контура по клику: шесть якорей по §4.1.
 * Клик обязан попадать на видимую линию ближе `tolerance`, иначе — отказ
 * с понятной причиной.
 */
export function beginContourEdit(
  ring: Ring,
  click: AreaPoint,
  tolerance: number = ANCHOR_CLICK_TOLERANCE,
): { ok: true; state: ContourEditState } | { ok: false; reason: string } {
  const state = stateOf(ring, true, [], null);
  if (state === null) return { ok: false, reason: 'Контур слишком короткий или вырожденный для правки якорями.' };
  const hit = projectOnCurve(state.curve, click, true);
  if (hit.distance > tolerance) {
    return { ok: false, reason: `Клик в ${Math.round(hit.distance)} единицах от линии — якоря ставятся только на видимой линии.` };
  }
  const anchors: CurveAnchor[] = [];
  for (let index = 0; index < ANCHOR_COUNT_CLOSED; index += 1) {
    const s = (hit.s + index / ANCHOR_COUNT_CLOSED) % 1;
    anchors.push({ s, point: hit.point });
  }
  // Точка каждого якоря — точка кривой на его доле дуги: якоря на видимой линии.
  const placed = anchors.map((anchor, index) => ({ s: anchor.s, point: index === 0 ? hit.point : curvePointAt(state.curve, anchor.s, true) }));
  const next: ContourEditState = { ...state, anchors: sortedAnchors(placed) };
  return { ok: true, state: next };
}

/**
 * Открывает правку замкнутого контура по сохранённым якорям (после загрузки).
 * Якоря перепривязываются к текущей кривой по ближайшей точке; максимальный
 * дрейф возвращается рядом — вызывающий код решает, показывать ли
 * «требует пересмотра».
 */
export function reopenContourEdit(
  ring: Ring,
  saved: readonly CurveAnchor[],
): { ok: true; state: ContourEditState; maxDrift: number } | { ok: false; reason: string } {
  const state = stateOf(ring, true, [], null);
  if (state === null) return { ok: false, reason: 'Контур слишком короткий или вырожденный для правки якорями.' };
  const resnapped = resnapAnchors(state.curve, true, saved);
  return { ok: true, state: { ...state, anchors: resnapped.anchors }, maxDrift: resnapped.maxDrift };
}

/** Перепривязывает якоря к кривой по ближайшей точке; возвращает макс. дрейф. */
export function resnapAnchors(
  curve: SampledCurve,
  closed: boolean,
  anchors: readonly CurveAnchor[],
): { anchors: readonly CurveAnchor[]; maxDrift: number } {
  let maxDrift = 0;
  const next = anchors.map((anchor) => {
    const hit = projectOnCurve(curve, anchor.point, closed);
    maxDrift = Math.max(maxDrift, hit.distance);
    return { s: hit.s, point: hit.point };
  });
  return { anchors: sortedAnchors(next), maxDrift };
}

/**
 * Уточнение сегмента (§4.2): двойной клик внутри сегмента между соседними
 * якорями. Два крайних якоря остаются, внутри появляются четыре (один — точно
 * в клике); другие сегменты и якоря не меняются. Клик ближе `ANCHOR_MIN_GAP`
 * к существующему якорю отклоняется с сообщением.
 */
/** Дополнительные допуски геометрии (S2): масштаб задают в экранных пикселях. */
export interface AnchorToleranceOptions {
  /** Минимальное расстояние между якорями (единицы карты; по умолчанию константа). */
  readonly minGap?: number;
}

export function subdivideSegment(
  state: ContourEditState,
  click: AreaPoint,
  tolerance: number = ANCHOR_CLICK_TOLERANCE,
  options: AnchorToleranceOptions = {},
): { ok: true; state: ContourEditState } | { ok: false; reason: string } {
  const curve = state.activeCurve;
  const closed = state.closed;
  const hit = projectOnCurve(curve, click, closed);
  if (hit.distance > tolerance) {
    return { ok: false, reason: `Клик в ${Math.round(hit.distance)} от линии — уточнять можно только сегмент под курсором.` };
  }
  const anchors = state.anchors;
  if (anchors.length < 2) {
    return { ok: false, reason: 'Сначала поставьте первый набор якорей двойным кликом по линии.' };
  }
  const length = curve.length;
  // Сегмент: пара соседних якорей, накрывающая долю клика (на замкнутой — с циклом).
  let segmentIndex = -1;
  for (let index = 0; index < anchors.length; index += 1) {
    const current = anchors[index]!;
    const next = anchors[(index + 1) % anchors.length]!;
    if (!closed && index === anchors.length - 1) break;
    if (insideArc(current.s, next.s, hit.s, closed)) {
      segmentIndex = index;
      break;
    }
  }
  if (segmentIndex < 0) {
    return { ok: false, reason: 'Не удалось определить сегмент под кликом.' };
  }
  const first = anchors[segmentIndex]!;
  const second = anchors[(segmentIndex + 1) % anchors.length]!;
  const segLength = arcSpan(first.s, second.s, length, closed);
  const clickOffset = arcSpan(first.s, hit.s, length, closed);
  const minGap = options.minGap ?? ANCHOR_MIN_GAP;
  if (Math.min(clickOffset, segLength - clickOffset) < minGap) {
    return { ok: false, reason: 'Точка клика слишком близка к существующему якорю: совпадающие якоря не создаются.' };
  }
  // Береговое правило: длинный берег — 3 части, короткий — 2; равенство — левому 3.
  const leftLong = clickOffset >= segLength - clickOffset;
  const inserted: CurveAnchor[] = [];
  if (leftLong) {
    for (const share of [1 / 3, 2 / 3]) {
      inserted.push(anchorAt(state, first.s, clickOffset * share));
    }
    inserted.push(anchorAt(state, hit.s, (segLength - clickOffset) / 2));
  } else {
    inserted.push(anchorAt(state, first.s, clickOffset / 2));
    for (const share of [1 / 3, 2 / 3]) {
      inserted.push(anchorAt(state, hit.s, clickOffset + (segLength - clickOffset) * share));
    }
  }
  // Якорь в точке клика — точно в ближайшей точке кривой под курсором.
  inserted.push({ s: hit.s, point: hit.point });
  const merged = sortedAnchors([...anchors, ...inserted]);
  return { ok: true, state: { ...state, anchors: merged } };
}

/** Доля `s` лежит в дуге от `start` к `end` (в направлении роста длины). */
function insideArc(start: number, end: number, s: number, closed: boolean): boolean {
  if (!closed) return s >= start && s <= end;
  if (start <= end) return s >= start && s <= end;
  return s >= start || s <= end;
}

/** Длина дуги от `start` к `end` в направлении роста доли. */
function arcSpan(start: number, end: number, length: number, closed: boolean): number {
  const direct = (end - start) * length;
  if (direct > 1e-9) return direct;
  if (!closed) return Math.max(0, direct);
  return direct + length;
}

/** Якорь на расстоянии `offset` по дуге от `origin` (доли длины). */
function anchorAt(state: ContourEditState, origin: number, offset: number): CurveAnchor {
  const s = ((origin + offset / state.activeCurve.length) % 1 + 1) % 1;
  return { s, point: curvePointAt(state.activeCurve, s, state.closed) };
}

/**
 * Перетаскивание якоря (§4.3): локальная деформация видимой кривой.
 * Возвращает новое состояние с заполненным `preview`; коммит делает
 * `commitDrag`. Концы открытой линии удерживаются в `clampRegion`.
 */
export function dragAnchor(
  state: ContourEditState,
  index: number,
  target: AreaPoint,
  clampRegion?: Ring,
  options: AnchorToleranceOptions = {},
): { ok: true; state: ContourEditState; limited: boolean } | { ok: false; reason: string } {
  const anchor = state.anchors[index];
  if (anchor === undefined) return { ok: false, reason: 'Якорь не найден.' };
  const curve = state.activeCurve;
  const closed = state.closed;
  const length = curve.length;
  const anchors = state.anchors;
  const count = anchors.length;
  if (count < 2) return { ok: false, reason: 'Нет якорей для перетаскивания.' };

  // Окно влияния — интервал дуги между соседними якорями.
  const previousIndex = (index - 1 + count) % count;
  const nextIndex = (index + 1) % count;
  const isEnd = !closed && (index === 0 || index === count - 1);
  const windowStart = isEnd && index === 0 ? 0 : anchors[previousIndex]!.s;
  const windowEnd = isEnd && index === count - 1 ? 1 : anchors[nextIndex]!.s;
  const windowSpan = arcSpan(windowStart, windowEnd, length, closed);
  if (windowSpan <= 1e-9) return { ok: false, reason: 'Сегмент слишком короткий для перетаскивания.' };

  let goal: AreaPoint = [Math.min(ANCHOR_MAP_BOUND, Math.max(0, target[0])), Math.min(ANCHOR_MAP_BOUND, Math.max(0, target[1]))];
  let limited = goal[0] !== target[0] || goal[1] !== target[1];
  if (isEnd && clampRegion !== undefined && clampRegion.length >= 3) {
    const inside = pointInClampRegion(goal, clampRegion);
    if (!inside) {
      goal = projectIntoClampRegion(goal, clampRegion);
      limited = true;
    }
  }

  const displacement: [number, number] = [goal[0] - anchor.point[0], goal[1] - anchor.point[1]];
  if (Math.hypot(displacement[0], displacement[1]) < 1e-9) {
    return { ok: true, state: state, limited: false };
  }

  // Предрасчёт окна в долях дуги относительно якоря.
  const anchorArc = anchor.s * length;
  const startArc = windowStart * length;
  const weights = new Float64Array(curve.points.length);
  for (let pointIndex = 0; pointIndex < curve.points.length; pointIndex += 1) {
    let arc = curve.cumulative[pointIndex] ?? 0;
    // Нормализуем в окно: доля дуги от начала окна.
    let relative = arc - startArc;
    if (closed) {
      relative = ((relative % length) + length) % length;
      if (relative > windowSpan) {
        // Точка за окном — вес строго ноль (локальность).
        weights[pointIndex] = 0;
        continue;
      }
    } else if (relative < 0 || relative > windowSpan) {
      weights[pointIndex] = 0;
      continue;
    }
    const anchorRelative = ((anchorArc - startArc) % length + length) % length;
    let weight: number;
    if (relative <= anchorRelative) {
      weight = windowSpan > 0 && anchorRelative > 0 ? smoothstep(relative / anchorRelative) : 1;
    } else {
      const tail = windowSpan - anchorRelative;
      weight = tail > 0 ? 1 - smoothstep((relative - anchorRelative) / tail) : 1;
    }
    weights[pointIndex] = weight;
  }

  const basePoints = curve.points;
  const attempt = (factor: number): AreaPoint[] => basePoints.map((point, pointIndex) => {
    const weight = weights[pointIndex]!;
    return [
      point[0] + displacement[0] * weight * factor,
      point[1] + displacement[1] * weight * factor,
    ];
  });

  const valid = (points: readonly AreaPoint[]): boolean => {
    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      if (weights[pointIndex] === 0) continue;
      const [x, y] = points[pointIndex]!;
      if (x < 0 || x > ANCHOR_MAP_BOUND || y < 0 || y > ANCHOR_MAP_BOUND) return false;
    }
    if (localIntersectionIncrease(basePoints, points, weights, closed)) return false;
    // Порядок якорей: соседние должны остаться на расстоянии не меньше MIN_GAP.
    const projected = anchors.map((entry, entryIndex) => entryIndex === index
      ? { s: entry.s, point: goal as AreaPoint }
      : entry);
    const minGap = options.minGap ?? ANCHOR_MIN_GAP;
    for (let entryIndex = 0; entryIndex < projected.length; entryIndex += 1) {
      const a = projected[entryIndex]!;
      const b = projected[(entryIndex + 1) % projected.length]!;
      if (!closed && entryIndex === projected.length - 1) continue;
      if (Math.hypot(a.point[0] - b.point[0], a.point[1] - b.point[1]) < minGap) return false;
    }
    return true;
  };

  let factor = 1;
  if (!valid(attempt(1))) {
    // Бинарный поиск максимальной доли сдвига, при которой правка допустима:
    // валидный кандидат поднимает нижнюю границу, невалидный — опускает
    // верхнюю. Инверсия веток здесь давала всегда-нулевой фактор и отказ
    // вместо плавного зажима (дефект B3).
    let low = 0;
    let high = 1;
    for (let step = 0; step < 18; step += 1) {
      const mid = (low + high) / 2;
      if (valid(attempt(mid))) low = mid;
      else high = mid;
    }
    if (low < ANCHOR_MIN_TRACTION) {
      return { ok: false, reason: 'Действие отклонено: такая тяга ломает форму (петля, край карты или слипание якорей).' };
    }
    limited = true;
    factor = low;
  }
  const points = attempt(factor);
  // Якорь стоит там, куда фактически дотащила кривая (при ограниченной тяге —
  // не в цели): точка предпросмотра на дуге якоря.
  const draggedArc = anchor.s * length;
  const anchorPoint = pointAtIndex(points, draggedArc, curve.cumulative);
  return { ok: true, state: withPreview(state, points, index, anchorPoint), limited };
}

function withPreview(state: ContourEditState, points: readonly AreaPoint[], draggedIndex: number, anchorPoint: AreaPoint): ContourEditState {
  const anchors = state.anchors.map((anchor, index) => (index === draggedIndex ? { s: anchor.s, point: anchorPoint } : anchor));
  const cumulative = state.curve.cumulative;
  const length = state.curve.length;
  return {
    ...state,
    preview: points,
    anchors,
    activeCurve: { points, cumulative, length },
    draggedIndex,
  };
}

/** Отменяет тягу: предпросмотр сбрасывается к последнему закоммиченному. */
export function cancelDrag(state: ContourEditState): ContourEditState {
  if (state.preview === null) return state;
  const next = stateOf(state.ring, state.closed, state.anchors, null);
  return next === null ? state : next;
}

/**
 * Коммит перетаскивания: вершины кольца снимаются с деформированной кривой
 * по своим долям дуги, а **окно тяги дополнительно дочищается** — внутри окна
 * вставляются точки снятой кривой с шагом около `ANCHOR_LINE_SPACING`.
 * Без дочистки кольцо из немногих крупных вершин не воспроизводит
 * деформированную кривую (скругление срезало бы правку). Число вершин
 * растёт только внутри окна; соседние участки и якоря вне окна не меняются.
 * Кривая после записи пересэмплируется, якоря перепривязываются; расхождение
 * предпросмотра и записи — в пределах `ANCHOR_COMMIT_TOLERANCE`.
 */
export function commitDrag(state: ContourEditState): ContourEditState {
  if (state.preview === null || state.draggedIndex === null) return state;
  const base = state.curve;
  const length = base.length;
  const closed = state.closed;
  const anchors = state.anchors;
  const count = anchors.length;
  const index = state.draggedIndex;
  const isEnd = !closed && (index === 0 || index === count - 1);
  const windowStart = isEnd && index === 0 ? 0 : anchors[(index - 1 + count) % count]!.s;
  const windowEnd = isEnd && index === count - 1 ? 1 : anchors[(index + 1) % count]!.s;
  const span = arcSpan(windowStart, windowEnd, length, closed);

  // Окно в «развёрнутых» координатах дуги: рамка отсчёта вершин — абсолютная
  // (arcs растут монотонно от доли первой вершины, переход через шов замыкания
  // даёт значения больше длины), поэтому доля окна переводится в дугу как есть.
  const arcs = unrolledVertexArcs(state.vertexFractions, length, closed);
  const u0 = windowStart * length;
  const u1 = u0 + span;

  // Окно в развёрнутых координатах может переходить через шов замыкания
  // (u1 > length). Вершина с дугой arc < u0 тогда лежит в окне, если её дуга
  // плюс длина кривой попадает в [u0, u1]; без нормализации хвост окна не
  // находил своих вершин и контур «откатывался» при коммите (дефект B3).
  const windowArcOf = (arc: number): number | null => {
    if (arc > u0 && arc < u1) return arc;
    if (closed && arc + length > u0 && arc + length < u1) return arc + length;
    return null;
  };

  const samples = Math.min(96, Math.max(8, Math.round(span / ANCHOR_LINE_SPACING)));
  const ringPoints: AreaPoint[] = [];
  let inserted = false;
  for (let j = 0; j < arcs.length; j += 1) {
    const arc = windowArcOf(arcs[j]!);
    if (arc === null) {
      ringPoints.push(state.ring[j]!);
      continue;
    }
    if (!inserted) {
      inserted = true;
      for (let k = 0; k <= samples; k += 1) {
        const sampleArc = u0 + (span * k) / samples;
        const point = pointAtIndex(state.preview, ((sampleArc % length) + length) % length, base.cumulative);
        ringPoints.push([
          Math.min(ANCHOR_MAP_BOUND, Math.max(0, point[0])),
          Math.min(ANCHOR_MAP_BOUND, Math.max(0, point[1])),
        ]);
      }
    }
    // Вершины внутри окна заменяются точками снятой кривой.
  }
  if (!inserted) {
    // Окно между двумя соседними вершинами: вставляем точки, ничего не заменяя.
    for (let j = 0; j < arcs.length; j += 1) {
      ringPoints.push(state.ring[j]!);
      const arc = arcs[j]!;
      const next = arcs[j + 1];
      if (next !== undefined && arc < u0 && next > u1) {
        for (let k = 0; k <= samples; k += 1) {
          const a = u0 + (span * k) / samples;
          const point = pointAtIndex(state.preview, ((a % length) + length) % length, base.cumulative);
          ringPoints.push([
            Math.min(ANCHOR_MAP_BOUND, Math.max(0, point[0])),
            Math.min(ANCHOR_MAP_BOUND, Math.max(0, point[1])),
          ]);
        }
      }
    }
  }
  const cleaned = dropClosePoints(ringPoints);
  const next = stateOf(cleaned, closed, state.anchors, null);
  if (next === null) return state;
  const resnapped = resnapAnchors(next.curve, closed, state.anchors);
  return { ...next, anchors: resnapped.anchors };
}

/** Доли дуги вершин в монотонной «развёрнутой» системе (для замкнутых — без скачка). */
function unrolledVertexArcs(fractions: readonly number[], length: number, closed: boolean): readonly number[] {
  const arcs: number[] = [];
  let current = (fractions[0] ?? 0) * length;
  for (let j = 0; j < fractions.length; j += 1) {
    if (j > 0) {
      let delta = ((fractions[j] ?? 0) - (fractions[j - 1] ?? 0)) * length;
      if (closed && delta < 0) delta += length;
      if (delta < 0) delta = 0;
      current += delta;
    }
    arcs.push(current);
  }
  return arcs;
}

/** Убирает подряд идущие точки ближе 0,5 единицы (шов замыкания и стыки). */
function dropClosePoints(points: readonly AreaPoint[]): Ring {
  const result: AreaPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous !== undefined && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 0.5) continue;
    result.push(point);
  }
  if (result.length > 2) {
    const first = result[0]!;
    const last = result[result.length - 1]!;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.5) result.pop();
  }
  return result;
}

/** Точка на ломаной по абсолютной длине дуги. */
function pointAtIndex(points: readonly AreaPoint[], arc: number, cumulative: readonly number[]): AreaPoint {
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if ((cumulative[mid] ?? 0) < arc) low = mid;
    else high = mid;
  }
  const from = points[low] ?? [0, 0];
  const to = points[high] ?? from;
  const span = (cumulative[high] ?? 0) - (cumulative[low] ?? 0);
  const t = span <= 1e-12 ? 0 : (arc - (cumulative[low] ?? 0)) / span;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/* -------------------------------------------------------- открытая линия пары */

/**
 * Первое деление открытой линии (§7): концы становятся крайними якорями,
 * клик даёт якорь в точке клика, ещё три внутренних — береговым правилом
 * уточнения сегмента. Итого `ANCHOR_COUNT_OPEN` якорей и пять кривых.
 */
export function beginLineEdit(
  points: readonly AreaPoint[],
  click: AreaPoint,
  tolerance: number = ANCHOR_CLICK_TOLERANCE,
  options: AnchorToleranceOptions = {},
): { ok: true; state: ContourEditState } | { ok: false; reason: string } {
  const state = stateOf(points, false, [], null);
  if (state === null) return { ok: false, reason: 'Линия слишком короткая для правки якорями.' };
  const hit = projectOnCurve(state.curve, click, false);
  if (hit.distance > tolerance) {
    return { ok: false, reason: `Клик в ${Math.round(hit.distance)} от линии — якоря ставятся только на линии.` };
  }
  if (Math.min(hit.s, 1 - hit.s) * state.curve.length < (options.minGap ?? ANCHOR_MIN_GAP)) {
    return { ok: false, reason: 'Точка клика слишком близка к концу линии: совпадающие якоря не создаются.' };
  }
  const anchors: CurveAnchor[] = [
    { s: 0, point: state.curve.points[0] ?? hit.point },
    { s: 1, point: state.curve.points[state.curve.points.length - 1] ?? hit.point },
    { s: hit.s, point: hit.point },
  ];
  const partial: ContourEditState = { ...state, anchors: sortedAnchors(anchors) };
  // Три внутренних якоря береговым правилом по дуге [0, 1] вокруг клика.
  const length = state.curve.length;
  const clickOffset = hit.s * length;
  const leftLong = clickOffset >= length - clickOffset;
  const inserted: CurveAnchor[] = [];
  if (leftLong) {
    for (const share of [1 / 3, 2 / 3]) inserted.push(lineAnchor(state, clickOffset * share));
    inserted.push(lineAnchor(state, clickOffset + (length - clickOffset) / 2));
  } else {
    inserted.push(lineAnchor(state, clickOffset / 2));
    for (const share of [1 / 3, 2 / 3]) inserted.push(lineAnchor(state, clickOffset + (length - clickOffset) * share));
  }
  const merged = sortedAnchors([...partial.anchors, ...inserted]);
  return { ok: true, state: { ...partial, anchors: merged } };
}

function lineAnchor(state: ContourEditState, arc: number): CurveAnchor {
  const s = arc / state.curve.length;
  return { s, point: curvePointAt(state.curve, s, false) };
}

/**
 * Открывает правку открытой линии по сохранённым якорям (§7): между сессиями
 * и после загрузки. Якоря перепривязываются к текущей линии; число якорей
 * сохраняется — уточнения не теряются.
 */
export function reopenLineEdit(
  points: readonly AreaPoint[],
  saved: readonly CurveAnchor[],
): { ok: true; state: ContourEditState; maxDrift: number } | { ok: false; reason: string } {
  const state = stateOf(points, false, [], null);
  if (state === null) return { ok: false, reason: 'Линия слишком короткая для правки якорями.' };
  if (saved.length < 2) {
    return { ok: false, reason: 'У линии меньше двух якорей — поставьте их заново двойным кликом.' };
  }
  const resnapped = resnapAnchors(state.curve, false, saved);
  return { ok: true, state: { ...state, anchors: resnapped.anchors }, maxDrift: resnapped.maxDrift };
}

/**
 * Коммит линии сочетания: записанные точки — пересэмплированный предпросмотр
 * (шаг `ANCHOR_LINE_SPACING`, границы числа точек), якоря перепривязываются.
 */
export function commitLineDrag(state: ContourEditState): { points: readonly AreaPoint[]; anchors: readonly CurveAnchor[] } {
  if (state.preview === null) {
    return { points: state.ring, anchors: state.anchors };
  }
  const stored = resampleForStore(state.preview, ANCHOR_LINE_SPACING);
  const curve = samplePolyline(stored, false) ?? state.activeCurve;
  const resnapped = resnapAnchors(curve, false, state.anchors);
  return { points: stored, anchors: resnapped.anchors };
}

/** Пересэмплирует ломаную под шаг записи (границы числа точек соблюдаются). */
export function resampleForStore(points: readonly AreaPoint[], spacing: number): AreaPoint[] {
  const { cumulative, length } = cumulativeOf(points);
  if (length <= 0) return points.map(([x, y]): AreaPoint => [x, y]);
  let count = Math.round(length / spacing);
  count = Math.min(ANCHOR_LINE_MAX_SAMPLES, Math.max(ANCHOR_LINE_MIN_SAMPLES, count));
  const result: AreaPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const arc = (length * index) / (count - 1);
    result.push(pointAtIndex(points, arc, cumulative));
  }
  return result;
}

/* --------------------------------------------------- область-ограничитель концов */

function pointInClampRegion(p: AreaPoint, region: Ring): boolean {
  let inside = false;
  for (let index = 0, j = region.length - 1; index < region.length; j = index, index += 1) {
    const a = region[index]!;
    const b = region[j]!;
    if (((a[1] > p[1]) !== (b[1] > p[1]))
      && (p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1] + 1e-12) + a[0])) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ближайшая точка границы области: конец стягивается к границе, не теряясь. */
function projectIntoClampRegion(p: AreaPoint, region: Ring): AreaPoint {
  let best: AreaPoint = region[0] ?? [0, 0];
  let bestDistance = Infinity;
  for (let index = 0; index < region.length; index += 1) {
    const a = region[index]!;
    const b = region[(index + 1) % region.length]!;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 <= 1e-12 ? 0 : ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
    t = Math.min(1, Math.max(0, t));
    const x = a[0] + abx * t;
    const y = a[1] + aby * t;
    const distance = Math.hypot(p[0] - x, p[1] - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [x, y];
    }
  }
  return best;
}

/* ------------------------------------------------------------------ выбор */

/** Ближайший якорь к точке, не дальше `tolerance`; `null` — мимо. */
export function anchorAtPoint(
  state: ContourEditState,
  p: AreaPoint,
  tolerance: number,
): { index: number; distance: number } | null {
  let best: { index: number; distance: number } | null = null;
  state.anchors.forEach((anchor, index) => {
    const distance = Math.hypot(anchor.point[0] - p[0], anchor.point[1] - p[1]);
    if (distance <= tolerance && (best === null || distance < best.distance)) {
      best = { index, distance };
    }
  });
  return best;
}
