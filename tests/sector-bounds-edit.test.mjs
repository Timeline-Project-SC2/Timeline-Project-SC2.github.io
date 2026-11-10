/* Правка линий границ сектора: участок, ядро, 5 якорей, локальная деформация,
 * журнал и экспорт/импорт. Чистая модель без DOM.
 *
 * Тесты идут по трём наборам данных:
 * - реальный `data/sector-bounds.json` (4 контура: граница, гало, две туманности);
 * - синтетическая **сильно изогнутая** кривая (дуга окружности) — на ней видно,
 *   что якоря делят длину дуги, а не параметр прямой хорды;
 * - синтетические вырожденные участки (короткий, замкнутый, открытый).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BOUNDS_EDIT_ANCHOR_COUNT,
  BOUNDS_EDIT_ANCHOR_FRACTIONS,
  BOUNDS_EDIT_ARC_TOLERANCE,
  BOUNDS_EDIT_COMMIT_TOLERANCE,
  BOUNDS_EDIT_MAX_SAMPLES,
  BOUNDS_EDIT_MIN_PULL,
  BOUNDS_EDIT_MIN_SPAN_LENGTH,
  BOUNDS_EDIT_MIN_STEP,
  BOUNDS_EDIT_PULL_LIMIT,
  anchorsForSpan,
  anchorSpacingDeviation,
  beginBoundsEdit,
  cancelBoundsEdit,
  commitBoundsEdit,
  contourOf,
  createBoundsEditSession,
  deformSpan,
  edgePoints,
  importBoundsEdit,
  influenceWindowFor,
  moveBoundsEditCore,
  parseBoundsEdit,
  peakFractionIn,
  pickBoundsEdge,
  pointOnSpan,
  redoBoundsEdit,
  resolveSpan,
  selectBoundsEdge,
  serializeBoundsEdit,
  softIndicesOf,
  spanCurve,
  spanLength,
  spanSampleCount,
  undoBoundsEdit,
} from '../src/atlas/sector-bounds-edit.ts';
import { parseBounds, smoothPolyline } from '../src/atlas/sector-bounds.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

/** Точка посередине сегмента реального контура. */
function midpointOfEdge(contour, edgeIndex) {
  const edge = edgePoints(contour, edgeIndex);
  assert.ok(edge, `сегмент ${edgeIndex} существует`);
  return [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
}

/** Открыть правку на сегменте реального контура. */
function beginOn(session, contourId, edgeIndex) {
  const contour = contourOf(session.doc, contourId);
  assert.ok(contour, `контур ${contourId}`);
  const click = midpointOfEdge(contour, edgeIndex);
  return beginBoundsEdit(session, contourId, edgeIndex, click);
}

/**
 * Расстояние от точки до ломаной (по сегментам, не до ближайшей вершины).
 * «Лежит на кривой» проверяется именно так: плотная ломаная — приближение
 * гладкой кривой, между её вершинами расстояние до самой кривой мало.
 */
function distanceToPolyline(point, polyline) {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < polyline.length; i += 1) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 === 0 ? 0 : ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(point[0] - (a[0] + abx * t), point[1] - (a[1] + aby * t)));
  }
  return best;
}

/** Дуга окружности: 13 вершин, заметная кривизна на всём участке. */
function arcPoints(radius = 300, steps = 12) {
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = (Math.PI / 2) * (i / steps);
    points.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }
  return points;
}

/** Контур из списка точек (по умолчанию — открытая линия гало). */
function contourFrom(points, kind = 'halo') {
  return docWith(points, kind).bounds[0];
}

/**
 * Плотная ломаная **нарисованной** линии контура: то же скругление, что у карты
 * (`smoothPolyline`, с замыканием для замкнутых контуров).
 */
function renderedPolyline(contour, steps = 24) {
  const closed = contour.kind !== 'halo';
  const path = smoothPolyline(contour.points, closed);
  const points = [];
  let from = path.start;
  const push = (a, control, b) => {
    for (let i = points.length === 0 ? 0 : 1; i <= steps; i += 1) {
      const u = i / steps;
      if (control === null) points.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      else {
        const v = 1 - u;
        points.push([
          v * v * a[0] + 2 * v * u * control[0] + u * u * b[0],
          v * v * a[1] + 2 * v * u * control[1] + u * u * b[1],
        ]);
      }
    }
  };
  for (const curve of path.curves) {
    push(from, curve.control, curve.end);
    from = curve.end;
  }
  if (path.tail !== null) push(from, null, path.tail);
  return points;
}

/** Синтетический документ из одного контура. */
function docWith(points, kind = 'halo') {
  return {
    version: 1,
    mapSize: 10000,
    source: 'test',
    bounds: [{
      id: 'test.contour',
      kind,
      label: 'тестовый контур',
      style: { strokeWidth: 2, dash: [], color: 'tactical' },
      points,
    }],
  };
}

/* ------------------------------------------------------------------ якоря */

test('якоря: 5 точек в долях длины дуги 0,1…0,9 на прямом участке', () => {
  const line = contourFrom([[0, 0], [1000, 0]]);
  const anchors = anchorsForSpan(line, 0, 1);
  assert.equal(anchors.length, BOUNDS_EDIT_ANCHOR_COUNT);
  assert.equal(anchors.length, BOUNDS_EDIT_ANCHOR_FRACTIONS.length);
  for (let i = 0; i < anchors.length; i += 1) {
    assert.ok(Math.abs(anchors[i][0] - BOUNDS_EDIT_ANCHOR_FRACTIONS[i] * 1000) < 0.5, `якорь ${i} на своём месте`);
    assert.ok(Math.abs(anchors[i][1]) < 1e-9, 'якорь лежит на линии');
  }
  assert.ok(anchorSpacingDeviation(line, 0, 1, anchors) <= BOUNDS_EDIT_ARC_TOLERANCE, 'шаг якорей одинаков');
});

test('якоря: на изогнутой кривой равноудалены по длине дуги, а не по параметру хорды', () => {
  const points = arcPoints(300, 12);
  const arc = contourFrom(points);
  const anchors = anchorsForSpan(arc, 0, points.length - 1);
  assert.equal(anchors.length, 5);
  const deviation = anchorSpacingDeviation(arc, 0, points.length - 1, anchors);
  assert.ok(deviation <= BOUNDS_EDIT_ARC_TOLERANCE,
    `отклонение шага ${(deviation * 100).toFixed(3)} % ≤ ${BOUNDS_EDIT_ARC_TOLERANCE * 100} %`);

  // Якоря лежат на дуге окружности: радиус каждой точки — 300 ± 1 %.
  for (const [x, y] of anchors) {
    assert.ok(Math.abs(Math.hypot(x, y) - 300) / 300 < 0.01, 'якорь на видимой кривой');
  }

  // Контроль смысла: деление по параметру хорды дало бы другие точки.
  const chord = [points[0], points.at(-1)];
  const byChord = BOUNDS_EDIT_ANCHOR_FRACTIONS.map((f) => [
    chord[0][0] + (chord[1][0] - chord[0][0]) * f,
    chord[0][1] + (chord[1][1] - chord[0][1]) * f,
  ]);
  const chordDeviation = anchors.reduce((worst, anchor, index) => {
    const reference = byChord[index];
    return Math.max(worst, Math.hypot(anchor[0] - reference[0], anchor[1] - reference[1]));
  }, 0);
  assert.ok(chordDeviation > 10, 'якоря не совпадают с делением хорды (регрессия исправлена)');
});

test('якоря: расстояния между соседними якорями равны и на кривой с изломом', () => {
  const points = [[0, 0], [400, 40], [700, 300], [900, 900], [1200, 1400]];
  const bent = contourFrom(points);
  const anchors = anchorsForSpan(bent, 0, points.length - 1);
  assert.ok(anchorSpacingDeviation(bent, 0, points.length - 1, anchors) <= BOUNDS_EDIT_ARC_TOLERANCE);
  // Якоря лежат ровно на нарисованной линии контура, а не на её перерисовке.
  const rendered = renderedPolyline(bent);
  for (const anchor of anchors) {
    const distance = distanceToPolyline(anchor, rendered);
    assert.ok(distance < 0.5, `якорь на нарисованной линии (расстояние ${distance.toFixed(3)})`);
  }
});

/* ------------------------------------------------------- окно влияния */

test('окно влияния: непустое в любой точке участка, включая сами якоря', () => {
  for (const fraction of [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 0.95, 1]) {
    const [left, right] = influenceWindowFor(fraction);
    assert.ok(right > left, `окно не пустое при f=${fraction}`);
    assert.ok(fraction >= left - 1e-9 && fraction <= right + 1e-9, `f=${fraction} внутри окна`);
  }
  // Якорь — граница двух интервалов: берётся более широкий, пик зажимается внутрь.
  assert.deepEqual(influenceWindowFor(0.5), [0.3, 0.5]);
  assert.deepEqual(influenceWindowFor(0.0), [0, 0.1]);
  assert.deepEqual(influenceWindowFor(1.0), [0.9, 1]);
});

test('окно влияния: пик всегда строго внутри окна (деформация не схлопывается)', () => {
  const window = [0.3, 0.5];
  for (const raw of [0.3, 0.35, 0.4, 0.5, 0.9]) {
    const peak = peakFractionIn(window, raw);
    assert.ok(peak > window[0] && peak < window[1], `пик ${peak} внутри окна`);
  }
});

/* ----------------------------------------------------------- деформация */

test('деформация: кривая проходит через ядро, якоря и концы стоят на месте', () => {
  const line = contourFrom([[0, 0], [1000, 0]]);
  const count = spanSampleCount(line, 0, 1);
  const window = influenceWindowFor(0.4);
  const peak = peakFractionIn(window, 0.4);
  // Пик входит в набор точек явно: тогда «кривая проходит через ядро» — точное
  // утверждение о конкретной точке, а не о ближайшей соседней.
  const base = spanCurve(line, 0, 1, count, [...BOUNDS_EDIT_ANCHOR_FRACTIONS, peak]);
  const core = [pointOnSpan(base, peak)[0], 120];
  const curve = deformSpan(base, core, window, peak);
  /** Индекс точки с точно такой долей длины дуги. */
  const indexOf = (fraction) => base.fractions.findIndex((value) => Math.abs(value - fraction) < 1e-9);

  assert.ok(Math.abs(curve[indexOf(peak)][1] - 120) < 1.5, 'контур проходит через ядро');

  // Якоря: смещение строго ноль (они вне окна или на его границе).
  for (const fraction of BOUNDS_EDIT_ANCHOR_FRACTIONS) {
    assert.equal(curve[indexOf(fraction)][1], 0, `якорь f=${fraction} не смещён`);
  }
  // Вне окна влияния — исходная линия.
  for (let i = 0; i < base.points.length; i += 1) {
    const f = base.fractions[i];
    if (f <= window[0] || f >= window[1]) assert.equal(curve[i][1], 0, `вне окна f=${f} без смещения`);
  }
  // Концы участка совпадают с исходными.
  assert.deepEqual(curve[0], base.points[0]);
  assert.deepEqual(curve.at(-1), base.points.at(-1));
});

test('деформация: перетаскивание ядра в середине участка (f = 0,5) не даёт пустой правки', () => {
  // Регрессия: ядро, попавшее точно в якорь t = 0,5, раньше давало нулевую
  // деформацию — перетаскивание выглядело как «ничего не происходит».
  const line = contourFrom([[0, 0], [1000, 0]]);
  const count = spanSampleCount(line, 0, 1);
  const base = spanCurve(line, 0, 1, count);
  const window = influenceWindowFor(0.5);
  const peak = peakFractionIn(window, 0.5);
  const curve = deformSpan(base, [pointOnSpan(base, peak)[0], 80], window, peak);
  const moved = curve.some((point, index) => Math.abs(point[1] - base.points[index][1]) > 1);
  assert.ok(moved, 'середина участка деформируется, а не остаётся прямой');
  const maxLift = curve.reduce((worst, point) => Math.max(worst, Math.abs(point[1])), 0);
  assert.ok(maxLift > 60, `подъём заметный (${maxLift.toFixed(1)})`);
});

test('деформация: влияние локально, дальние точки участка и весь остальной контур целы', () => {
  let session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edgeIndex = 10;
  const click = midpointOfEdge(contour, edgeIndex);
  let edited = beginBoundsEdit(session, 'sector.outline', edgeIndex, click);
  assert.ok(edited.active);
  const active = edited.active;
  const window = active.window;
  // Ядро уводим далеко в сторону.
  const moved = moveBoundsEditCore(edited, [click[0] + 120, click[1] + 120]);
  assert.ok(moved.active);
  const count = moved.active.curve.length;
  for (let i = 0; i < count; i += 1) {
    const f = i / (count - 1);
    if (f <= window[0] || f >= window[1]) {
      assert.deepEqual(moved.active.curve[i], moved.active.base[i], `вне окна точка ${i} не смещена`);
    }
  }
  // Документ не изменился ни на вершину до коммита.
  assert.deepEqual(moved.doc, bounds);
  // После коммита все вершины вне участка на месте.
  const committed = commitBoundsEdit(moved);
  const next = contourOf(committed.doc, 'sector.outline');
  assert.ok(next);
  assert.deepEqual(next.points.slice(0, active.spanStart + 1), contour.points.slice(0, active.spanStart + 1));
  assert.deepEqual(next.points.slice(next.points.length - (contour.points.length - active.spanEnd)),
    contour.points.slice(active.spanEnd));
});

/* ------------------------------------------------------------- сессия */

test('beginBoundsEdit: активная правка, 5 якорей, документ не тронут', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  assert.deepEqual(edited.doc, bounds, 'документ не поменялся до коммита');
  assert.ok(edited.active);
  assert.equal(edited.active.anchors.length, 5);
  assert.equal(edited.active.anchorFractions.length, 5);
  assert.ok(edited.active.curve.length >= 2);
  assert.equal(edited.selection.contourId, 'sector.outline');
  assert.equal(edited.selection.edgeIndex, 10);
  assert.equal(edited.selection.spanStart, 10);
  assert.equal(edited.selection.spanEnd, 11);
  assert.equal(edited.sequence, 0, 'выбор не идёт в журнал');
  // Якоря активной правки — ровно точки видимой кривой участка.
  for (const anchor of edited.active.anchors) {
    assert.ok(distanceToPolyline(anchor, edited.active.base) < 0.5, 'якорь на видимой кривой');
  }
});

test('moveBoundsEditCore: якоря и окно влияния не смещаются, предпросмотр пересчитывается', () => {
  const edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  assert.ok(edited.active);
  const anchors = edited.active.anchors.map((point) => [...point]);
  const window = [...edited.active.window];
  const click = edited.active.core;
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  assert.deepEqual(moved.active.anchors, anchors.map((point) => point), 'якоря не смещаются');
  assert.deepEqual([...moved.active.window], window, 'окно влияния не перескакивает');
  assert.deepEqual(moved.active.core, [click[0] + 40, click[1] + 30]);
  assert.notDeepEqual(moved.active.curve, edited.active.curve, 'предпросмотр пересчитан');
});

test('moveBoundsEditCore: ядро не выходит за поле и не уходит дальше предела тяги', () => {
  const edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  assert.ok(edited.active);
  const moved = moveBoundsEditCore(edited, [20000, 5000]);
  assert.ok(moved.active);
  assert.ok(moved.active.core[0] <= 10000 && moved.active.core[1] <= 10000, 'ядро внутри поля');
  assert.equal(moved.active.limited, true, 'упор в край поля помечен');
  // Тяга ограничена длиной окна влияния: ядро ближе к линии, чем запрошено.
  const spanArc = spanLength(contourOf(bounds, 'sector.outline'), 10, 11);
  const peak = pointOnSpan(
    spanCurve(contourOf(bounds, 'sector.outline'), 10, 11, spanSampleCount(contourOf(bounds, 'sector.outline'), 10, 11)),
    moved.active.coreFraction,
  );
  const pull = Math.hypot(moved.active.core[0] - peak[0], moved.active.core[1] - peak[1]);
  assert.ok(pull <= Math.max(BOUNDS_EDIT_MIN_PULL, BOUNDS_EDIT_PULL_LIMIT * (moved.active.window[1] - moved.active.window[0]) * spanArc) + 1e-6,
    `тяга ${pull.toFixed(2)} в пределах ${BOUNDS_EDIT_PULL_LIMIT} окон`);

  const moved2 = moveBoundsEditCore(edited, [-500, 5000]);
  assert.ok(moved2.active);
  assert.equal(moved2.active.limited, true, 'упор в левый край поля помечен');
  assert.ok(moved2.active.core[0] >= 0 && moved2.active.core[0] <= 10000, 'ядро не вышло за поле');
});

test('moveBoundsEditCore: в пределах предела тяги ядро встаёт ровно туда, куда тянут', () => {
  const edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  assert.ok(edited.active);
  const core = edited.active.core;
  const dx = 3;
  const dy = 2;
  const moved = moveBoundsEditCore(edited, [core[0] + dx, core[1] + dy]);
  assert.ok(moved.active);
  assert.equal(moved.active.limited, false);
  assert.equal(moved.active.core[0], core[0] + dx);
  assert.equal(moved.active.core[1], core[1] + dy);
});

test('beginBoundsEdit: короткий участок не открывает правку', () => {
  // Дуга короче порога: вся видимая линия участка — доли единицы карты.
  const step = BOUNDS_EDIT_MIN_SPAN_LENGTH / 8;
  const short = [[10, 10], [10 + step, 10], [10 + step, 10 + step]];
  const doc = docWith(short);
  const session = createBoundsEditSession(doc);
  assert.ok(spanLength(doc.bounds[0], 0, 1) < BOUNDS_EDIT_MIN_SPAN_LENGTH,
    `видимая длина ${spanLength(doc.bounds[0], 0, 1).toFixed(3)} < ${BOUNDS_EDIT_MIN_SPAN_LENGTH}`);
  const edited = beginBoundsEdit(session, 'test.contour', 0, [10, 10]);
  assert.equal(edited.active, null, 'слишком короткий участок не редактируется');
});

test('beginBoundsEdit: неизвестный контур, сегмент и вырожденный участок — без изменений', () => {
  const session = createBoundsEditSession(bounds);
  assert.equal(beginBoundsEdit(session, 'no-such', 0, [0, 0]).active, null);
  assert.equal(beginBoundsEdit(session, 'sector.outline', 999, [0, 0]).active, null);
  const degenerate = docWith([[100, 100], [100, 100], [100, 100]]);
  assert.equal(beginBoundsEdit(createBoundsEditSession(degenerate), 'test.contour', 0, [100, 100]).active, null);
});

/* -------------------------------------------------------------- коммит */

test('commitBoundsEdit: участок заменяется точками кривой, соседи и замыкание целы', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  assert.ok(edited.active);
  const inserted = edited.active.curve.length - 2;
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  const committed = commitBoundsEdit(moved);
  assert.equal(committed.active, null, 'после коммита правка закрывается');
  const next = contourOf(committed.doc, 'sector.outline');
  assert.ok(next);
  assert.equal(next.points.length, contour.points.length + inserted, 'вставлены только точки участка');
  assert.deepEqual(next.points.slice(0, 11), contour.points.slice(0, 11), 'вершины до участка целы');
  assert.deepEqual(next.points.slice(next.points.length - 16), contour.points.slice(12), 'вершины после участка целы');
  assert.deepEqual(next.points[0], next.points.at(-1), 'замкнутость контура сохранена');
  for (const item of committed.doc.bounds) {
    if (item.id !== 'sector.outline') assert.deepEqual(item, bounds.bounds.find((entry) => entry.id === item.id));
  }
  assert.equal(committed.past.length, 1);
  assert.equal(committed.past[0].sequence, 1);
  // Вставленные вершины помечены мягкими: повторный выбор возьмёт весь участок.
  const soft = softIndicesOf(committed, 'sector.outline');
  assert.equal(soft.length, inserted, 'мягкие вершины учтены');
  assert.deepEqual(resolveSpan(next.points, soft, 10), { spanStart: 10, spanEnd: 11 + inserted });
});

test('commitBoundsEdit: открытый контур (гало) остаётся открытым', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'halo.dashed');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 5);
  const edited = beginBoundsEdit(session, 'halo.dashed', 5, click);
  const moved = moveBoundsEditCore(edited, [click[0] + 30, click[1] - 20]);
  const committed = commitBoundsEdit(moved);
  const next = contourOf(committed.doc, 'halo.dashed');
  assert.ok(next);
  assert.notDeepEqual(next.points[0], next.points.at(-1), 'гало остаётся открытым');
  assert.deepEqual(next.points.slice(0, 6), contour.points.slice(0, 6));
  assert.deepEqual(next.points.slice(next.points.length - 6), contour.points.slice(7));
});

test('commitBoundsEdit: ядро без движения — без записи в журнал', () => {
  // Ядро при открытии садится на линию, поэтому коммит без перетаскивания
  // ничего не меняет и записи не создаёт.
  const edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  assert.ok(edited.active);
  const closed = commitBoundsEdit(edited);
  assert.deepEqual(closed.doc, bounds, 'документ не поменялся');
  assert.equal(closed.past.length, 0, 'в журнале нет записи');
  assert.equal(closed.active, null, 'правка закрывается');
});

test('commitBoundsEdit: ядро вернули на линию — коммит не создаёт записи', () => {
  let edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  const original = edited.active.core; // ядро уже на линии
  edited = moveBoundsEditCore(edited, [original[0] + 200, original[1] + 200]);
  assert.ok(edited.active);
  // Возврат точно на исходную точку линии: смещения нет.
  const back = moveBoundsEditCore(edited, original);
  const committed = commitBoundsEdit(back);
  assert.equal(committed.past.length, 0, 'записи нет: форма не изменилась');
  assert.deepEqual(committed.doc, bounds);
});

test('повторная правка: тот же участок выбирается целиком и не раздувает файл', () => {
  let session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const counts = [];
  for (let step = 0; step < 3; step += 1) {
    const current = contourOf(session.doc, 'sector.outline');
    assert.ok(current);
    const click = midpointOfEdge(current, 10);
    const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
    assert.ok(edited.active, `шаг ${step}: правка открылась повторно`);
    assert.equal(edited.active.spanStart, 10, 'участок начинается там же');
    const sampleCount = edited.active.curve.length;
    counts.push(sampleCount);
    session = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 25, click[1] + 25]));
    assert.equal(session.past.length, step + 1, `шаг ${step}: одна запись журнала`);
  }
  // Число точек участка стабильно (± 2), а не растёт как 16^n.
  for (const count of counts) assert.ok(Math.abs(count - counts[0]) <= 2, `точек ${count} против ${counts[0]}`);
  const finalContour = contourOf(session.doc, 'sector.outline');
  assert.ok(finalContour);
  assert.ok(finalContour.points.length <= contour.points.length + 3 * BOUNDS_EDIT_MAX_SAMPLES, 'файл не раздут');
});

test('повторный двойной клик: правка на другом участке заменяет активную без записи', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  let edited = beginBoundsEdit(session, 'sector.outline', 10, midpointOfEdge(contour, 10));
  edited = beginBoundsEdit(edited, 'sector.outline', 14, midpointOfEdge(contour, 14));
  assert.ok(edited.active);
  assert.equal(edited.active.spanStart, 14, 'правка перешла на новый участок');
  assert.equal(edited.past.length, 0, 'замены не пишутся в журнал');
  assert.deepEqual(edited.doc, bounds);
});

test('концы контура: правка первого и последнего участка не ломает замыкание', () => {
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  for (const edgeIndex of [0, contour.points.length - 2]) {
    let session = createBoundsEditSession(bounds);
    const click = midpointOfEdge(contour, edgeIndex);
    const edited = beginBoundsEdit(session, 'sector.outline', edgeIndex, click);
    assert.ok(edited.active, `участок ${edgeIndex} открылся`);
    session = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 20, click[1] + 20]));
    const next = contourOf(session.doc, 'sector.outline');
    assert.ok(next);
    assert.deepEqual(next.points[0], next.points.at(-1), `замыкание сохранено (участок ${edgeIndex})`);
    assert.deepEqual(next.points[0], contour.points[0], 'первая вершина не сдвинулась');
  }
});

/* ----------------------------- отрисовка и запись: регрессии отрисовки */

test('якоря активной правки лежат на нарисованной линии контура (все контуры файла)', () => {
  for (const contour of bounds.bounds) {
    const edgeIndex = Math.min(3, contour.points.length - 3);
    const session = createBoundsEditSession(bounds);
    const click = midpointOfEdge(contour, edgeIndex);
    const edited = beginBoundsEdit(session, contour.id, edgeIndex, click);
    assert.ok(edited.active, `${contour.id}: правка открылась`);
    // «Нарисованная линия» — то же скругление, что у карты, по всему контуру.
    const rendered = renderedPolyline(contour);
    for (const anchor of edited.active.anchors) {
      const distance = distanceToPolyline(anchor, rendered);
      assert.ok(distance < 0.5, `${contour.id}: якорь на нарисованной линии (${distance.toFixed(3)})`);
    }
  }
});

test('запись воспроизводит предпросмотр в пределах допуска', () => {
  for (const contour of bounds.bounds) {
    const edgeIndex = Math.min(5, contour.points.length - 3);
    const session = createBoundsEditSession(bounds);
    const click = midpointOfEdge(contour, edgeIndex);
    const edited = beginBoundsEdit(session, contour.id, edgeIndex, click);
    assert.ok(edited.active, `${contour.id}: правка открылась`);
    const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
    const committed = commitBoundsEdit(moved);
    assert.equal(committed.past.length, 1, `${contour.id}: запись в журнал`);
    const next = contourOf(committed.doc, contour.id);
    assert.ok(next);
    const line = renderedPolyline(next);
    for (const point of moved.active.curve) {
      const distance = distanceToPolyline(point, line);
      assert.ok(distance <= BOUNDS_EDIT_COMMIT_TOLERANCE,
        `${contour.id}: предпросмотр и запись расходятся на ${distance.toFixed(2)} (допуск ${BOUNDS_EDIT_COMMIT_TOLERANCE})`);
    }
  }
});

test('запись: шаг вставленных вершин ровный, реверсов и слипшихся точек нет', () => {
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), 'sector.outline', 10, click);
  assert.ok(edited.active);
  const insertedCount = edited.active.curve.length - 2;
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]));
  const next = contourOf(committed.doc, 'sector.outline');
  assert.ok(next);
  const chain = next.points.slice(11, 11 + insertedCount);
  assert.equal(chain.length, insertedCount);
  const steps = [];
  for (let i = 1; i < chain.length; i += 1) {
    steps.push(Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]));
  }
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median > 5, `шаг различим (${median.toFixed(1)})`);
  for (const step of steps) {
    assert.ok(step > median / 3, `нет слипшихся вершин (шаг ${step.toFixed(1)} против медианы ${median.toFixed(1)})`);
    assert.ok(step < median * 3, `нет разрывов и реверсов (шаг ${step.toFixed(1)} против медианы ${median.toFixed(1)})`);
  }
});

test('правка не меняет нарисованную линию вне участка', () => {
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), 'sector.outline', 10, click);
  assert.ok(edited.active);
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 50, click[1] - 40]));
  const next = contourOf(committed.doc, 'sector.outline');
  assert.ok(next);
  // Куски вне участка зависят только от неизменённых вершин — сравниваем их точки.
  const before = renderedPolyline(contour);
  const after = renderedPolyline(next);
  const near = (point) => Math.hypot(point[0] - click[0], point[1] - click[1]) > 600;
  const outside = before.filter(near);
  assert.ok(outside.length > 40, 'вне участка есть что сравнивать');
  for (const point of outside) {
    assert.ok(distanceToPolyline(point, after) < 0.5, 'линия вне участка на месте');
  }
});

/* -------------------------------------------------------- undo / redo */

test('undo/redo: один шаг на вызов, мягкие вершины тоже откатываются', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]));
  assert.equal(committed.past.length, 1);

  const undone = undoBoundsEdit(committed);
  assert.deepEqual(contourOf(undone.doc, 'sector.outline').points, contour.points, 'undo возвращает исходный контур');
  assert.deepEqual(softIndicesOf(undone, 'sector.outline'), [], 'мягкие вершины сняты');
  assert.equal(undone.past.length, 0);
  assert.equal(undone.future.length, 1);
  // Повторный undo ничего не делает (нет двойного шага).
  assert.equal(undoBoundsEdit(undone).past.length, 0);
  assert.deepEqual(undoBoundsEdit(undone).doc, undone.doc);

  const redone = redoBoundsEdit(undone);
  assert.deepEqual(contourOf(redone.doc, 'sector.outline').points, contourOf(committed.doc, 'sector.outline').points);
  assert.deepEqual(softIndicesOf(redone, 'sector.outline'), softIndicesOf(committed, 'sector.outline'));
  assert.equal(redone.past.length, 1);
  assert.equal(redone.future.length, 0);
  // Один вызов redo — ровно один шаг.
  assert.equal(redoBoundsEdit(redone).past.length, 1);
});

test('undo/redo: несколько коммитов идут по одной истории', () => {
  let session = createBoundsEditSession(bounds);
  for (const step of [
    { contourId: 'sector.outline', edgeIndex: 10, dx: 40, dy: 30 },
    { contourId: 'halo.dashed', edgeIndex: 5, dx: 30, dy: -20 },
  ]) {
    const contour = contourOf(session.doc, step.contourId);
    assert.ok(contour);
    const click = midpointOfEdge(contour, step.edgeIndex);
    const edited = beginBoundsEdit(session, step.contourId, step.edgeIndex, click);
    session = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + step.dx, click[1] + step.dy]));
  }
  assert.equal(session.past.length, 2);
  session = undoBoundsEdit(session);
  assert.equal(session.past.length, 1);
  session = undoBoundsEdit(session);
  assert.equal(session.past.length, 0);
  assert.deepEqual(contourOf(session.doc, 'sector.outline').points, contourOf(bounds, 'sector.outline').points);
  assert.deepEqual(contourOf(session.doc, 'halo.dashed').points, contourOf(bounds, 'halo.dashed').points);
  session = redoBoundsEdit(redoBoundsEdit(session));
  assert.equal(session.past.length, 2, 'два redo — оба коммита на месте');
});

test('cancelBoundsEdit (Escape / правый клик): предпросмотр сброшен, документ цел', () => {
  const edited = beginOn(createBoundsEditSession(bounds), 'sector.outline', 10);
  const moved = moveBoundsEditCore(edited, [edited.active.core[0] + 40, edited.active.core[1] + 30]);
  const cancelled = cancelBoundsEdit(moved);
  assert.equal(cancelled.active, null);
  assert.equal(cancelled.selection, null);
  assert.deepEqual(cancelled.doc, bounds);
  assert.equal(cancelled.past.length, 0);
});

test('selectBoundsEdge: подсветка не идёт в журнал и не плодит сессии', () => {
  const session = createBoundsEditSession(bounds);
  const selection = { contourId: 'sector.outline', contourIndex: 0, edgeIndex: 3, t: 0.5, spanStart: 3, spanEnd: 4, curve: [] };
  const selected = selectBoundsEdge(session, selection);
  assert.deepEqual(selected.selection, selection);
  assert.deepEqual(selected.doc, bounds);
  assert.equal(selected.past.length, 0);
  assert.equal(selectBoundsEdge(selected, selection), selected, 'повторный выбор того же участка — та же сессия');
  assert.equal(selectBoundsEdge(selected, null).selection, null);
});

/* ------------------------------------------------------------- выбор */

test('pickBoundsEdge: клик по видимой линии находит участок, далёкий клик — null', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const picked = pickBoundsEdge(session, click[0], click[1], 25);
  assert.ok(picked);
  assert.equal(picked.contourId, 'sector.outline');
  assert.equal(picked.edgeIndex, 10);
  assert.equal(picked.spanStart, 10);
  assert.equal(picked.spanEnd, 11);
  assert.ok(picked.curve.length >= 2, 'видимая кривая участка приложена');
  assert.ok(pickBoundsEdge(session, click[0], click[1] + 10, 25));
  assert.equal(pickBoundsEdge(session, click[0], click[1] + 10000, 25), null);
});

test('pickBoundsEdge: внутри изменённого участка выбирается весь участок, а не подотрезок', () => {
  let session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  session = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]));
  const next = contourOf(session.doc, 'sector.outline');
  assert.ok(next);
  // Клик по точке внутри вставленной цепочки.
  const inside = next.points[13];
  const picked = pickBoundsEdge(session, inside[0], inside[1], 25);
  assert.ok(picked);
  assert.equal(picked.spanStart, 10, 'участок тот же — от структурной вершины');
  assert.ok(picked.spanEnd > 11, 'и тянется до следующей структурной вершины');
});

/* --------------------------------------------------------- экспорт/импорт */

test('serialize/parse: round-trip сохраняет документ границ', () => {
  const json = serializeBoundsEdit(bounds);
  assert.deepEqual(parseBoundsEdit(json), bounds);
  assert.deepEqual(parseBounds(json), bounds, 'схема совпадает с data/sector-bounds.json');
});

test('round-trip после правки: выгруженный JSON читается обратно без потерь', () => {
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const click = midpointOfEdge(contour, 10);
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), 'sector.outline', 10, click);
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]));
  const exported = serializeBoundsEdit(committed.doc);
  const reimported = parseBoundsEdit(exported);
  assert.deepEqual(reimported, committed.doc, 'после импорта документ тот же');
  // Импорт в новую сессию: журнал пуст, вершины считаются структурными.
  const session = importBoundsEdit(reimported);
  assert.equal(session.past.length, 0);
  assert.equal(session.future.length, 0);
  assert.deepEqual(session.doc, committed.doc);
  assert.deepEqual(softIndicesOf(session, 'sector.outline'), [], 'происхождение вершин не угадывается');
  // И документ остаётся редактируемым.
  const again = beginBoundsEdit(session, 'sector.outline', 12, [committed.doc.bounds[0].points[12][0], committed.doc.bounds[0].points[12][1]]);
  assert.ok(again.active, 'после импорта правка открывается');
});

/* ------------------------------------------------- B1: границы карты */

/** Все рёбра всех контуров документа: пары соседних вершин. */
function allEdges(doc) {
  const edges = [];
  for (const contour of doc.bounds) {
    for (let i = 0; i < contour.points.length - 1; i += 1) edges.push({ contour, index: i });
  }
  return edges;
}

/** Контур после правки остаётся тем же замкнутым/открытым, что и до неё. */
function assertContourShape(before, after, where) {
  if (before.kind === 'halo') {
    assert.ok(after.points.length >= 2, `${where}: у гало минимум две точки`);
    return;
  }
  const first = after.points[0];
  const last = after.points[after.points.length - 1];
  assert.ok(after.points.length >= 4, `${where}: у замкнутого контура минимум 4 точки`);
  assert.deepEqual(last, first, `${where}: начало и конец замкнутого контура совпадают`);
}

test('B1: выгрузка после правки у края поля проходит собственный разбор (оба направления)', () => {
  // Воспроизведение HOLD: fog-echos #19 уводил вершины за y > 10000,
  // lost-signals #16 — за x < 0. Теперь предпросмотр обрезается по полю.
  const cases = [
    { id: 'nebula.fog-echos', edge: 19, pull: [12000, 9000] },
    { id: 'nebula.lost-signals', edge: 16, pull: [-4000, 3000] },
  ];
  for (const item of cases) {
    const contour = contourOf(bounds, item.id);
    assert.ok(contour, item.id);
    const edited = beginBoundsEdit(createBoundsEditSession(bounds), item.id, item.edge, item.pull);
    assert.ok(edited.active, `${item.id} #${item.edge}: правка открылась`);
    const committed = commitBoundsEdit(moveBoundsEditCore(edited, item.pull));
    assert.equal(committed.rejected ?? null, null, `${item.id} #${item.edge}: отказ не нужен`);
    assert.equal(committed.past.length, 1, `${item.id} #${item.edge}: правка записана`);
    const next = contourOf(committed.doc, item.id);
    assert.ok(next);
    for (const [x, y] of next.points) {
      assert.ok(x >= 0 && x <= 10000 && y >= 0 && y <= 10000,
        `${item.id} #${item.edge}: вершина ${x.toFixed(2)},${y.toFixed(2)} внутри поля`);
    }
    assertContourShape(contour, next, `${item.id} #${item.edge}`);
    const reimported = parseBoundsEdit(serializeBoundsEdit(committed.doc));
    assert.deepEqual(reimported, committed.doc, `${item.id} #${item.edge}: выгрузка читается обратно`);
    assert.equal(reimported.bounds.length, 4, 'все четыре контура на месте');
  }

  // Тяга ровно за угол поля на участке, лежащем на краю: либо валидная
  // запись, либо отказ с причиной — но не выгрузка вне диапазона.
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), 'nebula.fog-echos', 19, [12000, 12000]);
  const corner = commitBoundsEdit(moveBoundsEditCore(edited, [12000, 12000]));
  if (corner.rejected !== null && corner.rejected !== undefined) {
    assert.match(corner.rejected, /петл/);
    assert.deepEqual(corner.doc, bounds, 'отказ не меняет документ');
  } else {
    const next = contourOf(corner.doc, 'nebula.fog-echos');
    for (const [x, y] of next.points) {
      assert.ok(x >= 0 && x <= 10000 && y >= 0 && y <= 10000, 'угол поля: вершины внутри');
    }
  }
});

test('B1: правка на всех 76 рёбрах с тягой за поле — запись всегда валидна', () => {
  const edges = allEdges(bounds);
  assert.equal(edges.length, 76, 'в документе 76 рёбер');
  let recorded = 0;
  let rejected = 0;
  for (const { contour, index } of edges) {
    const edge = edgePoints(contour, index);
    assert.ok(edge);
    const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
    const edited = beginBoundsEdit(createBoundsEditSession(bounds), contour.id, index, click);
    if (!edited.active) continue;
    for (const pull of [[20000, 20000], [-20000, 20000], [20000, -20000], [-20000, -20000]]) {
      const committed = commitBoundsEdit(moveBoundsEditCore(edited, pull));
      const next = contourOf(committed.doc, contour.id);
      assert.ok(next);
      for (const [x, y] of next.points) {
        assert.ok(x >= 0 && x <= 10000 && y >= 0 && y <= 10000,
          `${contour.id} #${index} (тяга ${pull}): вершина вне поля ${x},${y}`);
      }
      assertContourShape(contour, next, `${contour.id} #${index} (тяга ${pull})`);
      // Выгрузка должна читаться парсером — иначе `/sector/` молча потеряет контуры.
      const json = serializeBoundsEdit(committed.doc);
      const reimported = parseBoundsEdit(json);
      assert.equal(reimported.bounds.length, 4, `${contour.id} #${index}: контуров 4 после разбора`);
      if (committed.past.length > 0) recorded += 1;
      if (committed.rejected !== null && committed.rejected !== undefined) {
        rejected += 1;
        assert.deepEqual(committed.doc, bounds, `${contour.id} #${index}: отказ не меняет документ`);
      }
    }
  }
  assert.ok(recorded > 250, `правок записано ${recorded} из ${edges.length * 4}`);
  assert.ok(rejected < 40, `отказов ${rejected} — защита от петли не срабатывает на каждой тяге`);
});

test('B1: запись, которая сложила бы контур петлёй, отклоняется с причиной', () => {
  // Квадрат у верхнего края: тяга за край складывает обрезанную линию петлёй.
  const square = [[0, 9900], [300, 9900], [300, 9970], [0, 9970], [0, 9900]];
  const doc = docWith(square, 'nebula');
  const session = createBoundsEditSession(doc);
  const clicked = beginBoundsEdit(session, 'test.contour', 0, [150, 9900]);
  assert.ok(clicked.active);
  const committed = commitBoundsEdit(moveBoundsEditCore(clicked, [20000, 20000]));
  assert.equal(committed.past.length, 0, 'запись не сделана');
  assert.equal(typeof committed.rejected, 'string');
  assert.match(committed.rejected, /петл/);
  assert.deepEqual(committed.doc, doc, 'документ не тронут');
  // Тот же участок при умеренной тяге пишется нормально.
  const mild = commitBoundsEdit(moveBoundsEditCore(clicked, [150, 9950]));
  assert.ok(mild.past.length === 1 || mild.rejected !== null);
  if (mild.past.length === 1) {
    assert.equal(parseBoundsEdit(serializeBoundsEdit(mild.doc)).bounds.length, 1);
  }
});

test('B1: слайверы у края поля не пишутся, шаг вершин различим', () => {
  const contour = contourOf(bounds, 'nebula.fog-echos');
  assert.ok(contour);
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), contour.id, 19, [12000, 12000]);
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [12000, 9000]));
  assert.equal(committed.rejected ?? null, null, 'запись у края проходит');
  const next = contourOf(committed.doc, contour.id);
  assert.ok(next);
  for (let i = 1; i < next.points.length; i += 1) {
    const step = Math.hypot(next.points[i][0] - next.points[i - 1][0], next.points[i][1] - next.points[i - 1][1]);
    assert.ok(step === 0 || step >= BOUNDS_EDIT_MIN_STEP,
      `слипшихся вершин нет (шаг ${step.toFixed(3)} на ${i})`);
  }
});

test('B1: UI-цикл выгрузка → импорт → правка на граничном случае', () => {
  const contour = contourOf(bounds, 'nebula.fog-echos');
  const edited = beginBoundsEdit(createBoundsEditSession(bounds), contour.id, 19, [12000, 12000]);
  const committed = commitBoundsEdit(moveBoundsEditCore(edited, [12000, 9000]));
  assert.equal(committed.rejected ?? null, null, 'граничный случай записывается');
  const exported = serializeBoundsEdit(committed.doc);
  const imported = importBoundsEdit(parseBoundsEdit(exported));
  assert.deepEqual(imported.doc, committed.doc);
  assert.equal(imported.past.length, 0);
  const again = beginBoundsEdit(imported, contour.id, 5, [9000, 9500]);
  assert.ok(again.active, 'после импорта правка на другом участке открывается');
});

test('parseBoundsEdit: некорректные данные — RangeError на русском', () => {
  assert.throws(() => parseBoundsEdit('{"version":2}'),
    (error) => error instanceof RangeError && /Некорректные/.test(error.message));
  assert.throws(() => parseBoundsEdit('не json'), (error) => error instanceof RangeError);
});
