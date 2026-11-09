/* Правка линий границ сектора: ядро, 5 якорей, локальная деформация и журнал.
 * Чистая модель без DOM: тесты проводят по session-командам на реальном
 * `data/sector-bounds.json` и на синтетических сегментах для точности
 * математики (этап 3, карточка SEC-VISUAL-EDIT).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BOUNDS_EDIT_ANCHOR_COUNT,
  BOUNDS_EDIT_ANCHOR_POSITIONS,
  BOUNDS_EDIT_EDGE_SAMPLES,
  beginBoundsEdit,
  cancelBoundsEdit,
  commitBoundsEdit,
  contourOf,
  createBoundsEditSession,
  deformEdge,
  deformEdgeAt,
  edgePoints,
  influenceIntervalFor,
  anchorsForEdge,
  moveBoundsEditCore,
  parseBoundsEdit,
  pickBoundsEdge,
  redoBoundsEdit,
  selectBoundsEdge,
  serializeBoundsEdit,
  undoBoundsEdit,
} from '../src/atlas/sector-bounds-edit.ts';
import { parseBounds } from '../src/atlas/sector-bounds.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

/* ------------------------------------------------------------------ якоря */

test('якоря: 5 опорных точек равномерно по сегменту (t = 0,1; 0,3; 0,5; 0,7; 0,9)', () => {
  const anchors = anchorsForEdge([0, 0], [100, 0]);
  assert.equal(anchors.length, BOUNDS_EDIT_ANCHOR_COUNT);
  assert.equal(anchors.length, BOUNDS_EDIT_ANCHOR_POSITIONS.length);
  for (let i = 0; i < 5; i += 1) {
    const [x, y] = anchors[i];
    assert.equal(y, 0, 'якорь лежит на сегменте');
    assert.equal(x, BOUNDS_EDIT_ANCHOR_POSITIONS[i] * 100, 'якорь на заданном параметре');
  }
  // Равномерность: шаг между соседними якорями постоянный.
  for (let i = 1; i < anchors.length; i += 1) {
    const step = Math.abs(anchors[i][0] - anchors[i - 1][0]);
    assert.equal(step, 20, 'шаг якорей одинаков');
  }
});

test('интервал влияния: ядро между якорями — интервал якорей; на якоре/конце — null', () => {
  assert.deepEqual(influenceIntervalFor(0.4), [0.3, 0.5]);
  assert.deepEqual(influenceIntervalFor(0.05), [0, 0.1]);
  assert.deepEqual(influenceIntervalFor(0.95), [0.9, 1]);
  assert.equal(influenceIntervalFor(0.3), null, 'ядро на якоре — деформации нет');
  assert.equal(influenceIntervalFor(0.5), null);
  assert.equal(influenceIntervalFor(0.9), null);
  assert.equal(influenceIntervalFor(0), null, 'ядро на конце сегмента — деформации нет');
  assert.equal(influenceIntervalFor(1), null);
});

/* ----------------------------------------------------------- математика */

test('деформация: ядро тянет контур, якоря и концы сегмента не двигаются', () => {
  const a = [0, 0];
  const b = [100, 0];
  const core = [40, 20]; // t = 0,4 — между якорями 0,3 и 0,5
  // Ядро: контур проходит через ядро точно.
  assert.deepEqual(deformEdgeAt(a, b, core, 0.4), [40, 20]);
  // Якоря: смещение строго ноль.
  for (const t of BOUNDS_EDIT_ANCHOR_POSITIONS) {
    assert.deepEqual(deformEdgeAt(a, b, core, t), [t * 100, 0], `якорь t=${t} не смещён`);
  }
  // Концы сегмента: тоже без смещения.
  assert.deepEqual(deformEdgeAt(a, b, core, 0), [0, 0]);
  assert.deepEqual(deformEdgeAt(a, b, core, 1), [100, 0]);
  // Вне интервала влияния (0,3…0,5): прямая как была.
  assert.deepEqual(deformEdgeAt(a, b, core, 0.05), [5, 0]);
  assert.deepEqual(deformEdgeAt(a, b, core, 0.95), [95, 0]);
  // Форма булмпа: максимум в ядре, симметрия по сторонам.
  const [x35, y35] = deformEdgeAt(a, b, core, 0.35);
  assert.equal(x35, 35);
  assert.ok(Math.abs(y35 - 10) < 1e-9, 'на полпути к якорю — половина толчка');
  const [x45, y45] = deformEdgeAt(a, b, core, 0.45);
  assert.equal(x45, 45);
  assert.ok(Math.abs(y45 - 10) < 1e-9);
});

test('деформация: кривая непрерывна и укладывается в 16 точек', () => {
  const curve = deformEdge([0, 0], [100, 0], [40, 20]);
  assert.equal(curve.length, BOUNDS_EDIT_EDGE_SAMPLES);
  assert.deepEqual(curve[0], [0, 0], 'начало сегмента на месте');
  assert.deepEqual(curve.at(-1), [100, 0], 'конец сегмента на месте');
  // Непрерывность: смещение не прыгает (максимальный шаг по y уложен в толчок).
  let maxStep = 0;
  for (let i = 1; i < curve.length; i += 1) {
    maxStep = Math.max(maxStep, Math.abs(curve[i][1] - curve[i - 1][1]));
  }
  assert.ok(maxStep <= 20, 'шаг смещения не превышает толчок ядра');
});

test('деформация: ядро вне сегмента — без смещения (параметър обрезан)', () => {
  const curve = deformEdge([0, 0], [100, 0], [500, 500]);
  assert.deepEqual(curve[0], [0, 0]);
  assert.deepEqual(curve.at(-1), [100, 0]);
  for (const point of curve) assert.equal(point[1], 0, 'контур остался на прямой');
});

/* -------------------------------------------------------------- сессия */

test('beginBoundsEdit: активная правка, якоря по определению, документ не тронут', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  assert.deepEqual(edited.doc, bounds, 'документ не поменялся до коммита');
  assert.ok(edited.active);
  assert.equal(edited.active.anchors.length, 5);
  assert.deepEqual(edited.active.anchors, anchorsForEdge(edge[0], edge[1]));
  assert.equal(edited.active.curve.length, BOUNDS_EDIT_EDGE_SAMPLES);
  assert.equal(edited.selection.contourId, 'sector.outline');
  assert.equal(edited.selection.edgeIndex, 10);
  assert.equal(edited.sequence, 0, 'выбор не идёт в журнал');
});

test('moveBoundsEditCore: якоря не смещаются, предпросмотр пересчитывается', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  assert.ok(edited.active);
  const anchors = [...edited.active.anchors];
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  assert.deepEqual(moved.active.anchors, anchors, 'якоря не смещаются при движении ядра');
  assert.deepEqual(moved.active.core, [click[0] + 40, click[1] + 30]);
  assert.notDeepEqual(moved.active.curve, edited.active.curve, 'предпросмотр пересчитан');
});

test('moveBoundsEditCore: ядро обрезается по границам поля', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const moved = moveBoundsEditCore(edited, [20000, 5000]);
  assert.deepEqual(moved.active.core, [10000, 5000], 'ядро в пределах поля');
  const moved2 = moveBoundsEditCore(moved, [-500, 5000]);
  assert.deepEqual(moved2.active.core, [0, 5000]);
});

/* -------------------------------------------------------------- коммит */

test('commitBoundsEdit: сегмент заменяется на 16 точек, соседние участки не тронуты', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  const committed = commitBoundsEdit(moved);
  assert.equal(committed.active, null, 'после коммита правка закрывается');
  const next = contourOf(committed.doc, 'sector.outline');
  assert.ok(next);
  // 28 − 2 + 16 точек: сегмент разбит на кривую.
  assert.equal(next.points.length, contour.points.length - 2 + BOUNDS_EDIT_EDGE_SAMPLES);
  // Начало и конец контура (соседи сегмента) на месте.
  assert.deepEqual(next.points.slice(0, 11), contour.points.slice(0, 11));
  assert.deepEqual(next.points.slice(next.points.length - 16), contour.points.slice(12));
  // Замкнутость контура сохранена.
  assert.deepEqual(next.points[0], next.points.at(-1));
  // Остальные контуры без изменений.
  for (const item of committed.doc.bounds) {
    if (item.id !== 'sector.outline') assert.deepEqual(item, bounds.bounds.find((entry) => entry.id === item.id));
  }
  // Журнал: одна запись.
  assert.equal(committed.past.length, 1);
  assert.equal(committed.past[0].sequence, 1);
});

test('commitBoundsEdit: открытый контур (гало) остаётся открытым', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'halo.dashed');
  assert.ok(contour);
  const edge = edgePoints(contour, 5);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'halo.dashed', 5, click);
  const moved = moveBoundsEditCore(edited, [click[0] + 30, click[1] - 20]);
  const committed = commitBoundsEdit(moved);
  const next = contourOf(committed.doc, 'halo.dashed');
  assert.ok(next);
  assert.equal(next.points.length, contour.points.length - 2 + BOUNDS_EDIT_EDGE_SAMPLES);
  assert.notDeepEqual(next.points[0], next.points.at(-1), 'гало остаётся открытым');
  assert.deepEqual(next.points.slice(0, 6), contour.points.slice(0, 6));
  assert.deepEqual(next.points.slice(next.points.length - 6), contour.points.slice(7));
});

test('commitBoundsEdit: ядро без движения — без записи в журнал', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const closed = commitBoundsEdit(edited);
  assert.deepEqual(closed.doc, bounds, 'документ не поменялся');
  assert.equal(closed.past.length, 0, 'в журнале нет записи');
  assert.equal(closed.active, null, 'правка закрывается');
});

test('undo/redo: возврат к before и повтор after', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  const committed = commitBoundsEdit(moved);
  const undone = undoBoundsEdit(committed);
  assert.deepEqual(contourOf(undone.doc, 'sector.outline').points, contour.points, 'undo возвращает исходный контур');
  assert.equal(undone.past.length, 0);
  assert.equal(undone.future.length, 1);
  const redone = redoBoundsEdit(undone);
  assert.deepEqual(contourOf(redone.doc, 'sector.outline').points, contourOf(committed.doc, 'sector.outline').points, 'redo повторяет коммит');
  assert.equal(redone.past.length, 1);
  assert.equal(redone.future.length, 0);
});

test('undo/redo: несколько коммитов идут по одной истории', () => {
  let session = createBoundsEditSession(bounds);
  // Два коммита на разных контурах: сектор и гало.
  const plan = [
    { contourId: 'sector.outline', edgeIndex: 10, dx: 40, dy: 30 },
    { contourId: 'halo.dashed', edgeIndex: 5, dx: 30, dy: -20 },
  ];
  for (const step of plan) {
    const contour = contourOf(session.doc, step.contourId);
    assert.ok(contour);
    const edge = edgePoints(contour, step.edgeIndex);
    assert.ok(edge);
    const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
    const edited = beginBoundsEdit(session, step.contourId, step.edgeIndex, click);
    const moved = moveBoundsEditCore(edited, [click[0] + step.dx, click[1] + step.dy]);
    session = commitBoundsEdit(moved);
  }
  assert.equal(session.past.length, 2);
  session = undoBoundsEdit(session);
  assert.equal(session.past.length, 1);
  session = undoBoundsEdit(session);
  assert.equal(session.past.length, 0);
  assert.deepEqual(contourOf(session.doc, 'sector.outline').points, contourOf(bounds, 'sector.outline').points, 'два undo — сектор обратно к исходнику');
  assert.deepEqual(contourOf(session.doc, 'halo.dashed').points, contourOf(bounds, 'halo.dashed').points, 'два undo — гало обратно к исходнику');
  session = redoBoundsEdit(session);
  session = redoBoundsEdit(session);
  assert.equal(session.past.length, 2, 'два redo — оба коммиты на месте');
});

test('cancelBoundsEdit (Escape): предпросмотр сброшен, документ без изменений', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const edited = beginBoundsEdit(session, 'sector.outline', 10, click);
  const moved = moveBoundsEditCore(edited, [click[0] + 40, click[1] + 30]);
  const cancelled = cancelBoundsEdit(moved);
  assert.equal(cancelled.active, null);
  assert.deepEqual(cancelled.doc, bounds);
  assert.equal(cancelled.past.length, 0);
});

test('повторный двойной клик: правка на другом сегменте заменяет активную', () => {
  const session = createBoundsEditSession(bounds);
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edgeA = edgePoints(contour, 10);
  const edgeB = edgePoints(contour, 14);
  assert.ok(edgeA && edgeB);
  const clickA= [(edgeA[0][0] + edgeA[1][0]) / 2, (edgeA[0][1] + edgeA[1][1]) / 2];
  const clickB= [(edgeB[0][0] + edgeB[1][0]) / 2, (edgeB[0][1] + edgeB[1][1]) / 2];
  let edited = beginBoundsEdit(session, 'sector.outline', 10, clickA);
  assert.ok(edited.active);
  edited = beginBoundsEdit(edited, 'sector.outline', 14, clickB);
  assert.ok(edited.active);
  assert.equal(edited.active.edgeIndex, 14, 'правка перешла на новый сегмент');
  assert.deepEqual(edited.doc, bounds, 'документ не тронут');
});

test('невалидные входы: вырожденный сегмент и неизвестный контур — без изменений', () => {
  const session = createBoundsEditSession(bounds);
  const same = beginBoundsEdit(session, 'sector.outline', 0, [0, 0]);
  // Первый сегмент реального контура не вырожденный — проверим по синтетике.
  const flat = { ...bounds, bounds: [{ id: 'x', kind: 'halo', label: 'x', style: { strokeWidth: 1, dash: [], color: 'nebula' }, points: [[10, 10], [10, 10], [20, 20]] }] };
  const session2 = createBoundsEditSession(flat);
  const noop = beginBoundsEdit(session2, 'x', 0, [10, 10]);
  assert.equal(noop.active, null, 'вырожденный сегмент не открывает правку');
  const missing = beginBoundsEdit(session, 'no-such', 0, [0, 0]);
  assert.equal(missing.active, null, 'несуществующий контур не открывает правку');
  const outOfRange = beginBoundsEdit(session, 'sector.outline', 999, [0, 0]);
  assert.equal(outOfRange.active, null, 'несуществующий сегмент не открывает правку');
  assert.deepEqual(same.doc, bounds);
});

test('selectBoundsEdge: выбор сегмента для подсветки не идёт в журнал', () => {
  const session = createBoundsEditSession(bounds);
  const selection = { contourId: 'sector.outline', contourIndex: 0, edgeIndex: 3, t: 0.5 };
  const selected = selectBoundsEdge(session, selection);
  assert.deepEqual(selected.selection, selection);
  assert.deepEqual(selected.doc, bounds);
  assert.equal(selected.past.length, 0);
  const cleared = selectBoundsEdge(selected, null);
  assert.equal(cleared.selection, null);
});

/* ------------------------------------------------------------- выбор */

test('pickBoundsEdge: клик на сегмент реального контура', () => {
  const contour = contourOf(bounds, 'sector.outline');
  assert.ok(contour);
  const edge = edgePoints(contour, 10);
  assert.ok(edge);
  const click = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
  const picked = pickBoundsEdge(bounds, click[0], click[1], 25);
  assert.ok(picked);
  assert.equal(picked.contourId, 'sector.outline');
  assert.equal(picked.edgeIndex, 10);
  assert.ok(Math.abs(picked.t - 0.5) < 1e-9);
  // Толеранс: клик в 10 единицах от сегмента найден, в 10 000 — нет.
  assert.ok(pickBoundsEdge(bounds, click[0], click[1] + 10, 25));
  assert.equal(pickBoundsEdge(bounds, click[0], click[1] + 10000, 25), null);
});

test('pickBoundsEdge: клик далеко от всех контуров — null', () => {
  // Браузер-поиск самого удалённого места поля: грубая сетка, максимум
  // минимального расстояния до всех сегментов.
  let best = null;
  for (let x = 0; x <= 10000; x += 200) {
    for (let y = 0; y <= 10000; y += 200) {
      let minDistance = Number.POSITIVE_INFINITY;
      for (const contour of bounds.bounds) {
        for (let i = 0; i + 1 < contour.points.length; i += 1) {
          const a = contour.points[i];
          const b = contour.points[i + 1];
          const abx = b[0] - a[0];
          const aby = b[1] - a[1];
          const len2 = abx * abx + aby * aby;
          let t = len2 === 0 ? 0 : ((x - a[0]) * abx + (y - a[1]) * aby) / len2;
          t = Math.max(0, Math.min(1, t));
          const dx = x - (a[0] + abx * t);
          const dy = y - (a[1] + aby * t);
          minDistance = Math.min(minDistance, Math.hypot(dx, dy));
        }
      }
      if (best === null || minDistance > best.distance) best = { x, y, distance: minDistance };
    }
  }
  assert.ok(best);
  assert.ok(best.distance > 25, 'найдено место дальше чем толеранс');
  assert.equal(pickBoundsEdge(bounds, best.x, best.y, 25), null);
});

/* --------------------------------------------------------- экспорт/импорт */

test('serialize/parse:round-trip сохраняет документ границ', () => {
  const json = serializeBoundsEdit(bounds);
  const parsed = parseBoundsEdit(json);
  assert.deepEqual(parsed, bounds);
  // Та же схема, что data/sector-bounds.json: парсер контракта читает экспорт.
  const viaContract = parseBounds(json);
  assert.deepEqual(viaContract, bounds);
});

test('parseBoundsEdit: некорректные данные — RangeError на русском', () => {
  assert.throws(() => parseBoundsEdit('{"version":2}'), (error) => error instanceof RangeError && /Некорректные/.test(error.message));
  assert.throws(() => parseBoundsEdit('не json'), (error) => error instanceof RangeError);
});
