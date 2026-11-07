/* Инструменты рисования областей: чистая машина состояний без DOM (P2).
 *
 * Проверяется то, что решает карточку: пять видов ввода, открытость линии,
 * замкнутость прямоугольника, эллипса и многоугольника, отмена незавершённого
 * ввода и понятный отказ для недопустимой фигуры. Минимумы точек не выдуманы —
 * они сверяются с существующим валидатором контракта `validateSectorAreas`.
 *
 * Запуск: node --test tests/sector-areas-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createArea, emptySectorAreasDoc, validateSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { ringArea } from '../src/atlas/sector-areas-geometry.ts';
import {
  CLOSED_MIN_VERTICES,
  ELLIPSE_SEGMENTS,
  OPEN_MIN_POINTS,
  TOOL_IDS,
  TOOL_INPUT,
  TOOL_LABELS,
  TOOL_TITLES,
  addVertex,
  beginDrag,
  cancelInput,
  clampPoint,
  createToolState,
  draftRing,
  endDrag,
  finishVertices,
  isToolId,
  isToolInputActive,
  moveCursor,
  moveDrag,
  previewDraft,
  selectTool,
  toolCloses,
  toolInput,
  undoVertex,
  validateDraft,
} from '../src/atlas/sector-areas-tools.ts';

/** Документ с одной областью из черновика: проверяется существующим валидатором. */
function docWithDraft(draft) {
  return {
    ...emptySectorAreasDoc(),
    areas: [
      {
        ...createArea({
          id: 'area-1',
          name: 'Фигура 1',
          rings: [draftRing(draft)],
          closed: draft.closed,
        }),
      },
    ],
  };
}

/** Перетаскивание от `from` к `to` указанным инструментом. */
function drag(tool, from, to) {
  let state = beginDrag(createToolState(tool), from);
  state = moveDrag(state, to);
  return endDrag(state);
}

/* ------------------------------------------------------------------- перечень */

test('набор инструментов — базовые пять, у каждого свой способ ввода', () => {
  assert.deepEqual([...TOOL_IDS], ['free-line', 'line', 'rectangle', 'ellipse', 'polygon']);
  // Перетаскивание: свободная линия, прямоугольник, эллипс.
  assert.equal(toolInput('free-line'), 'drag');
  assert.equal(toolInput('rectangle'), 'drag');
  assert.equal(toolInput('ellipse'), 'drag');
  // Клики по вершинам: линия и многоугольник.
  assert.equal(toolInput('line'), 'vertices');
  assert.equal(toolInput('polygon'), 'vertices');
  assert.deepEqual({ ...TOOL_INPUT }, {
    'free-line': 'drag', line: 'vertices', rectangle: 'drag', ellipse: 'drag', polygon: 'vertices',
  });

  assert.ok(isToolId('polygon'));
  assert.equal(isToolId('lasso'), false, 'лассо и прочие лишние инструменты не заявлены');
  // Подписи есть у каждого инструмента: кнопка не остаётся безымянной.
  for (const tool of TOOL_IDS) {
    assert.ok(TOOL_TITLES[tool].length > 0, `нет подписи у ${tool}`);
    assert.ok(TOOL_LABELS[tool].length > 0, `нет короткой подписи у ${tool}`);
  }
});

test('замыкаются только прямоугольник, эллипс и многоугольник', () => {
  assert.equal(toolCloses('free-line'), false);
  assert.equal(toolCloses('line'), false);
  assert.equal(toolCloses('rectangle'), true);
  assert.equal(toolCloses('ellipse'), true);
  assert.equal(toolCloses('polygon'), true);
});

/* --------------------------------------------------------------- перетаскивание */

test('свободная линия рисуется перетаскиванием и остаётся открытой', () => {
  let state = beginDrag(createToolState('free-line'), [1000, 1000]);
  state = moveDrag(state, [2000, 1200]);
  state = moveDrag(state, [3000, 1000]);
  assert.equal(isToolInputActive(state), true, 'пока ввод идёт, он незавершён');

  const result = endDrag(state);
  assert.equal(result.draft.closed, false, 'линия не замыкается при завершении');
  assert.equal(result.draft.points.length, 3);
  // Кольцо открытой области не должно получать замыкающую копию первой точки.
  const ring = draftRing(result.draft);
  assert.equal(ring.length, 3);
  assert.notDeepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(isToolInputActive(result.state), false, 'после завершения ввод очищен');
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('открытая линия из двух точек допустима: это минимум контракта', () => {
  const result = drag('free-line', [1000, 1000], [2000, 2000]);
  assert.equal(OPEN_MIN_POINTS, 2);
  assert.equal(validateDraft(result.draft).ok, true);
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('прямоугольник задаётся перетаскиванием и сохраняется замкнутым', () => {
  const result = drag('rectangle', [4000, 3000], [1000, 1000]);
  assert.equal(result.draft.closed, true);
  assert.equal(result.draft.points.length, 4, 'уникальных углов четыре');
  const ring = draftRing(result.draft);
  assert.equal(ring.length, 5, 'кольцо замкнуто повтором первой точки');
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ringArea(ring, true), 3000 * 2000);
  // Существующий валидатор принимает фигуру без замечаний.
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('эллипс задаётся перетаскиванием и сохраняется замкнутым', () => {
  const result = drag('ellipse', [1000, 1000], [5000, 3000]);
  assert.equal(result.draft.closed, true);
  assert.equal(result.draft.points.length, ELLIPSE_SEGMENTS);
  const ring = draftRing(result.draft);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // Площадь правильного многоугольника близка к площади эллипса π·rx·ry.
  const expected = Math.PI * 2000 * 1000;
  const actual = ringArea(ring, true);
  assert.ok(Math.abs(actual - expected) / expected < 0.01, `площадь ${actual} не близка к ${expected}`);
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('фигуры не выходят за карту: координаты приводятся к границам', () => {
  const result = drag('rectangle', [-500, -500], [20000, 20000]);
  for (const point of result.draft.points) {
    assert.ok(point[0] >= 0 && point[0] <= 10000, 'x вне карты');
    assert.ok(point[1] >= 0 && point[1] <= 10000, 'y вне карты');
  }
  const ellipse = drag('ellipse', [-900, 12000], [11000, -400]).draft;
  for (const point of ellipse.points) {
    assert.ok(point[0] >= 0 && point[0] <= 10000, 'x эллипса вне карты');
    assert.ok(point[1] >= 0 && point[1] <= 10000, 'y эллипса вне карты');
  }
  // И курсор за краем карты приводится, а не уходит в бесконечность.
  assert.deepEqual(clampPoint([-10, 20000]), [0, 10000]);
});

/* ------------------------------------------------------------------ по вершинам */

test('многоугольник ставится кликами и сохраняется замкнутым', () => {
  let state = createToolState('polygon');
  assert.equal(isToolInputActive(state), false);
  for (const point of [[1000, 1000], [4000, 1000], [4000, 4000]]) {
    state = addVertex(state, point);
  }
  assert.equal(isToolInputActive(state), true);

  // Enter или двойной клик завершают ввод.
  const result = finishVertices(state);
  assert.equal(result.draft.closed, true);
  const ring = draftRing(result.draft);
  assert.equal(ring.length, 4, 'три уникальные вершины и замыкающая копия');
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
  assert.equal(isToolInputActive(result.state), false, 'после завершения ввод очищен');
});

test('линия по точкам ставится кликами и остаётся открытой', () => {
  let state = createToolState('line');
  state = addVertex(state, [1000, 1000]);
  state = addVertex(state, [2000, 2500]);
  state = addVertex(state, [3000, 1000]);
  const result = finishVertices(state);
  assert.equal(result.draft.closed, false, 'линия не замыкается');
  assert.equal(draftRing(result.draft).length, 3, 'без замыкающей точки');
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('повторный клик в той же точке не удваивает вершину', () => {
  // Двойной клик приходит как два нажатия: второе не должно дать лишнюю вершину.
  let state = createToolState('polygon');
  for (const point of [[1000, 1000], [4000, 1000], [4000, 4000], [1000, 4000], [1000, 4000]]) {
    state = addVertex(state, point);
  }
  assert.equal(state.vertices.length, 4);
  const result = finishVertices(state);
  assert.equal(result.draft.points.length, 4);
  assert.equal(ringArea(draftRing(result.draft), true), 3000 * 3000);
  assert.deepEqual(validateSectorAreas(docWithDraft(result.draft)).errors, []);
});

test('курсор тянет «резиновую нить», но в фигуру не попадает до завершения', () => {
  let state = beginDrag(createToolState('rectangle'), [1000, 1000]);
  state = moveCursor(state, [3000, 2000]);
  const preview = previewDraft(state);
  assert.equal(preview.closed, true);
  assert.equal(preview.points.length, 4);
  // Пока тянем, черновик повторяет курсор; отпускание даёт ту же фигуру.
  const result = endDrag(state);
  assert.deepEqual(result.draft.points, preview.points);
});

test('шаг назад внутри ввода вершин снимает последнюю точку', () => {
  let state = createToolState('polygon');
  state = addVertex(state, [1000, 1000]);
  state = addVertex(state, [2000, 2000]);
  state = undoVertex(state);
  assert.equal(state.vertices.length, 1);
  state = undoVertex(state);
  assert.equal(state.vertices.length, 0);
  assert.equal(isToolInputActive(state), false, 'снята последняя вершина — ввод закончен');
});

/* ----------------------------------------------------------- отказ и отмена */

test('Escape отменяет незавершённый ввод, документ не получает фигуры', () => {
  let state = createToolState('polygon');
  state = addVertex(state, [1000, 1000]);
  state = addVertex(state, [2000, 2000]);
  const cancelled = cancelInput(state);
  assert.equal(isToolInputActive(cancelled), false);
  assert.equal(cancelled.vertices.length, 0);
  assert.equal(previewDraft(cancelled), null, 'предпросмотра после отмены нет');
  // Инструмент остаётся тем же: отмена ввода — не смена инструмента.
  assert.equal(cancelled.tool, 'polygon');
});

test('незавершённый ввод не создаёт фигуру', () => {
  assert.equal(endDrag(createToolState('free-line')).draft, null);
  assert.equal(finishVertices(createToolState('polygon')).draft, null);
  assert.match(validateDraft(null).reason, /Фигура не начата/);
});

test('недопустимая фигура даёт понятное сообщение и не портит документ', () => {
  // Двух вершин многоугольнику мало: минимум три уникальные.
  let two = createToolState('polygon');
  two = addVertex(two, [1000, 1000]);
  two = addVertex(two, [2000, 2000]);
  const short = finishVertices(two).draft;
  const shortCheck = validateDraft(short);
  assert.equal(shortCheck.ok, false);
  assert.match(shortCheck.reason, /минимум 3 вершины/);
  assert.equal(CLOSED_MIN_VERTICES, 3);

  // Одна точка — меньше минимума открытого кольца.
  const empty = validateDraft({ tool: 'free-line', closed: false, points: [[500, 500]] });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /минимум 2 точки/);

  // Две совпадающие точки минимум проходят, но длины у линии нет.
  const same = validateDraft(drag('free-line', [500, 500], [500, 500]).draft);
  assert.equal(same.ok, false);
  assert.match(same.reason, /без длины/);
});

test('вырожденные фигуры отклоняются: площади или длины нет', () => {
  // Перетаскивание без движения: прямоугольник схлопывается в точку.
  const flat = validateDraft(drag('rectangle', [2000, 2000], [2000, 2000]).draft);
  assert.equal(flat.ok, false);
  assert.match(flat.reason, /вырождена|без площади/);

  // Эллипс нулевой высоты: площади тоже нет.
  const line = validateDraft(drag('ellipse', [1000, 2000], [4000, 2000]).draft);
  assert.equal(line.ok, false);
  assert.match(line.reason, /вырождена|без площади/);

  // Три точки на одной прямой: вершины разные, а площадь нулевая. Такой случай
  // ловит существующая геометрия, а не перебор совпадающих координат.
  const collinear = { tool: 'polygon', closed: true, points: [[1000, 1000], [2000, 2000], [3000, 3000]] };
  const check = validateDraft(collinear);
  assert.equal(check.ok, false);
  assert.match(check.reason, /без площади/);

  // Открытая линия нулевой длины.
  const zero = validateDraft({ tool: 'free-line', closed: false, points: [[1000, 1000], [1000, 1000]] });
  assert.equal(zero.ok, false);
  assert.match(zero.reason, /без длины/);
});

/* --------------------------------------------------------------- состояние */

test('смена инструмента сбрасывает ввод, документ не трогается', () => {
  let state = createToolState('polygon');
  state = addVertex(state, [1000, 1000]);
  const switched = selectTool(state, 'ellipse');
  assert.equal(switched.tool, 'ellipse');
  assert.equal(isToolInputActive(switched), false);
  assert.equal(switched.vertices.length, 0);
  assert.equal(switched.path.length, 0);
  // Повторный выбор того же инструмента лишь отменяет ввод.
  const again = selectTool(addVertex(createToolState('polygon'), [500, 500]), 'polygon');
  assert.equal(again.tool, 'polygon');
  assert.equal(again.vertices.length, 0);
});

test('завершение ввода не бывает в покое: покой не отдаёт черновик', () => {
  const idle = createToolState('rectangle');
  assert.equal(previewDraft(idle), null);
  const result = endDrag(idle);
  assert.equal(result.draft, null);
  assert.equal(result.state, idle, 'состояние без ввода не подменяется новым объектом');
});
