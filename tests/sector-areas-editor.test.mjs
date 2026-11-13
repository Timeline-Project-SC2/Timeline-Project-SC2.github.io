/* Операции редактора границ (шаг 3 §11 части 2 плана): кисть, секторный снап,
 * вершины, состояния, история и экспорт.
 *
 * Слой без DOM: команды над документом. Проверяется, что свободная кисть даёт
 * мировой контур со справочным адресом, снап — ячейку канонического адреса с
 * родителем предыдущего тира, правки вершин не рвут замкнутое кольцо, история
 * ходит вперёд-назад, а состояния и override не разрушают друг друга.
 * Запуск: node --test tests/sector-areas-editor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addAreaFromSectorCell,
  addAreaFromStroke,
  addForceFill,
  addStrokeToArea,
  addressForRing,
  areaById,
  assignScope,
  brushWidthInWorld,
  canRedo,
  canUndo,
  canFillArea,
  createEditorSession,
  createEmptyArea,
  exportDoc,
  fillShapeAsState,
  importDoc,
  insertVertex,
  moveVertex,
  nextSequence,
  recordCompletedStroke,
  redo,
  removeArea,
  removeState,
  removeVertex,
  renameArea,
  selectArea,
  selectedArea,
  setBrushWidth,
  setDetail,
  setGradient,
  setLod,
  setMode,
  setParent,
  setSnapMode,
  setState,
  setVisibility,
  snapAndRecordStroke,
  thickenStroke,
  undo,
} from '../src/atlas/sector-areas-editor.ts';
import { createScope } from '../src/atlas/sector-areas-scope.ts';
import { ringArea } from '../src/atlas/sector-areas-geometry.ts';
import { DEFAULT_GRADIENT, validateSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { resolvePaint } from '../src/atlas/sector-areas-force.ts';

const state = (overrides = {}) => ({
  id: 'st-1',
  mode: 'political',
  factionMode: 'single',
  factionIds: ['Доминион Терран'],
  task: 'none',
  visibleFrom: 0,
  visibleTo: 12,
  z: 0,
  priority: 0,
  lodBias: 0,
  rounding: 1,
  gradient: { mode: 'auto' },
  override: false,
  label: null,
  ...overrides,
});

test('новая сессия: свободная кисть по умолчанию, документ пуст', () => {
  const session = createEditorSession();
  assert.equal(session.snapMode, 'free');
  assert.equal(session.mode, 'political');
  assert.deepEqual(session.doc.areas, []);
  assert.equal(canUndo(session), false);
  assert.equal(canRedo(session), false);
  assert.equal(setBrushWidth(session, 12).brushWidthPx, 12);
  assert.throws(() => setBrushWidth(session, 0), RangeError);
  assert.equal(setMode(session, 'military').mode, 'military');
  assert.equal(setSnapMode(session, 'sector').snapMode, 'sector');
});

test('ширина кисти переводится из пикселей в мировые единицы по масштабу', () => {
  const session = setBrushWidth(createEditorSession(), 8);
  assert.equal(brushWidthInWorld(session, 2), 4);
  assert.equal(brushWidthInWorld(session, 0.5), 16);
  assert.throws(() => brushWidthInWorld(session, 0), RangeError);
});

test('штрих раздувается в контур заданной ширины', () => {
  const ring = thickenStroke([[0, 0], [100, 0]], 10, true);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ringArea(ring), 1000);
  const thin = thickenStroke([[0, 0], [100, 0]], 0, true);
  assert.deepEqual(thin, [[0, 0], [100, 0], [0, 0]]);
});

test('свободная кисть создаёт область в мировых координатах со справочным адресом', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Штрих',
    points: [[1000, 1000], [2000, 1000], [2000, 2000]],
    width: 40,
  });
  const area = selectedArea(session);
  assert.equal(area.id, 'a-1');
  assert.equal(area.source, 'brush');
  assert.equal(area.closed, true);
  assert.match(area.address ?? '', /^KP·[A-Y]{5}$/);
  assert.equal(session.doc.events.at(-1).kind, 'create');
  assert.equal(validateSectorAreas(session.doc).ok, true);
  // Штрих короче трёх точек замкнуть нельзя.
  assert.throws(() => addAreaFromStroke(session, { id: 'bad', name: 'bad', points: [[0, 0], [1, 1]] }), RangeError);
});

test('секторный снап даёт ячейку канонического адреса и родителя предыдущего тира', () => {
  const parent = addAreaFromSectorCell(createEditorSession(), {
    id: 'region',
    name: 'Ячейка T5',
    x: 5720,
    y: 6257,
    letters: 5,
  });
  const regionArea = selectedArea(parent);
  assert.match(regionArea.address ?? '', /^KP·[A-Y]{5}$/);
  const parentRing = regionArea.rings[0];
  assert.equal(Number(Math.abs(parentRing[1][0] - parentRing[0][0]).toFixed(4)), 3.2);

  // Глубже на тир: родитель — существующая область ячейки предыдущего тира.
  const cell = addAreaFromSectorCell(parent, { id: 'cell', name: 'Ячейка T6', x: 5720, y: 6257, letters: 6 });
  const cellArea = selectedArea(cell);
  assert.match(cellArea.address ?? '', /^KP·[A-Y]{6}$/);
  assert.equal(cellArea.parentId, 'region');
  assert.equal(cellArea.source, 'sector');
  const ring = cellArea.rings[0];
  assert.equal(Number(Math.abs(ring[1][0] - ring[0][0]).toFixed(4)), 0.64);
  // Прямоугольник ячейки берётся только из полного адреса: T0…T4 не снапятся.
  assert.throws(() => addAreaFromSectorCell(parent, { id: 'bad', name: 'Мелко', x: 5720, y: 6257, letters: 3 }), RangeError);
});

test('правка вершин не рвёт замкнутое кольцо', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Квадрат',
    points: [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]],
  });
  const ring = selectedArea(session).rings[0];
  assert.equal(ring.length, 5);

  const moved = moveVertex(session, 'a-1', 0, 0, [900, 900]);
  const movedRing = selectedArea(moved).rings[0];
  assert.deepEqual(movedRing[0], [900, 900]);
  assert.deepEqual(movedRing[movedRing.length - 1], [900, 900]);

  const inserted = insertVertex(moved, 'a-1', 0, 0, [1500, 1100]);
  const insertedRing = selectedArea(inserted).rings[0];
  assert.deepEqual(insertedRing[1], [1500, 1100]);
  assert.equal(insertedRing.length, movedRing.length + 1);

  const removed = removeVertex(inserted, 'a-1', 0, 1);
  assert.deepEqual(selectedArea(removed).rings[0], movedRing);

  // Три уникальные вершины — минимум замкнутого кольца; дальше удалять нельзя.
  const minimal = removeVertex(removed, 'a-1', 0, 0);
  assert.equal(selectedArea(minimal).rings[0].length, 4);
  assert.throws(() => removeVertex(minimal, 'a-1', 0, 0), RangeError);
  assert.throws(() => insertVertex(minimal, 'a-1', 9, 0, [0, 0]), RangeError);
});

test('история: шаг назад, шаг вперёд и очистка будущего новой командой', () => {
  const first = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Первая',
    points: [[0, 0], [100, 0], [100, 100]],
  });
  const second = renameArea(first, 'a-1', 'Переименованная');
  assert.equal(canUndo(second), true);
  assert.equal(selectedArea(second).name, 'Переименованная');

  const back = undo(second);
  assert.equal(selectedArea(back).name, 'Первая');
  assert.equal(canRedo(back), true);
  assert.equal(selectedArea(redo(back)).name, 'Переименованная');

  // Новая команда после отмены обнуляет «перёд».
  const branch = renameArea(back, 'a-1', 'Другая');
  assert.equal(canRedo(branch), false);
  assert.equal(selectedArea(branch).name, 'Другая');
  assert.equal(undo(createEditorSession()).doc.areas.length, 0);
});

test('состояние добавляется и заменяется по идентификатору', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[0, 0], [100, 0], [100, 100]],
  });
  session = setState(session, 'a-1', state());
  assert.equal(areaById(session, 'a-1').states.length, 1);
  session = setState(session, 'a-1', state({ priority: 7 }));
  assert.equal(areaById(session, 'a-1').states.length, 1);
  assert.equal(areaById(session, 'a-1').states[0].priority, 7);
  // Второй режим — второе состояние той же области.
  session = setState(session, 'a-1', state({ id: 'st-2', mode: 'military' }));
  assert.equal(areaById(session, 'a-1').states.length, 2);
  session = removeState(session, 'a-1', 'st-2');
  assert.equal(areaById(session, 'a-1').states.length, 1);
});

test('градиент, детализация и диапазон глубин правятся точечно', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[0, 0], [100, 0], [100, 100]],
  });
  session = setState(session, 'a-1', state());
  session = setGradient(session, 'a-1', 'st-1', { mode: 'custom', stops: [{ offset: 0, color: '#000000', alpha: 1 }, { offset: 1, color: '#ffffff', alpha: 1 }] });
  assert.equal(areaById(session, 'a-1').states[0].gradient.mode, 'custom');

  session = setLod(session, 'a-1', 'st-1', { lodBias: -1, rounding: 0 });
  assert.equal(areaById(session, 'a-1').states[0].lodBias, -1);
  assert.equal(areaById(session, 'a-1').states[0].rounding, 0);

  session = setVisibility(session, 'a-1', 'st-1', { from: 3, to: 99 });
  const visible = areaById(session, 'a-1').states[0];
  assert.equal(visible.visibleFrom, 3);
  assert.equal(visible.visibleTo, 12);
});

test('scope и детализация считаются по геометрии области', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[400, 400], [600, 400], [600, 600]],
  });
  const scope = createScope({
    id: 'square',
    kind: 'custom',
    label: 'Квадрат',
    rings: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]],
  });
  const assigned = assignScope(session, 'a-1', scope);
  const area = areaById(assigned, 'a-1');
  assert.equal(area.scopeId, 'square');
  assert.equal(area.location, 'core');
  assert.equal(area.detail, 'core');
  assert.equal(setDetail(assigned, 'a-1', 'своё').doc.areas[0].detail, 'своё');
});

test('форс-закрашивание коммитится сразу и не разрушает состояния', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[0, 0], [100, 0], [100, 100]],
  });
  session = setState(session, 'a-1', state());
  const filled = addForceFill(session, { id: 'force-1', rings: [[[0, 0], [100, 0], [100, 100], [0, 0]]], color: '#00ff00' });
  assert.equal(filled.doc.overrides.length, 1);
  assert.equal(filled.doc.events.at(-1).kind, 'override');

  const paint = resolvePaint(filled.doc, 'a-1', 'political');
  assert.equal(paint.isOverride, true);
  assert.equal(paint.state.id, 'st-1');
  assert.deepEqual(paint.rgb, [0, 255, 0]);
});

test('удаление области снимает родителя у детей и убирает её override', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'parent',
    name: 'Родитель',
    points: [[0, 0], [1000, 0], [1000, 1000]],
  });
  session = addAreaFromStroke(session, { id: 'child', name: 'Ребёнок', points: [[100, 100], [200, 100], [200, 200]], parentId: 'parent' });
  session = addForceFill(session, { id: 'force-1', rings: [[[0, 0], [10, 0], [10, 10], [0, 0]]], color: '#ff0000', areaId: 'child' });
  session = removeArea(session, 'child');
  assert.equal(areaById(session, 'child'), null);
  assert.equal(session.doc.overrides.length, 0);
  assert.equal(areaById(session, 'parent').id, 'parent');
  assert.throws(() => removeArea(session, 'нет'), RangeError);
  assert.throws(() => setParent(session, 'parent', 'parent'), RangeError);
});

test('экспорт и импорт сохраняют документ, битый JSON отклоняется', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[0, 0], [100, 0], [100, 100]],
  });
  session = setState(session, 'a-1', state());
  const json = exportDoc(session);
  const restored = importDoc(json);
  assert.equal(restored.doc.areas.length, 1);
  assert.equal(restored.doc.areas[0].states.length, 1);
  assert.deepEqual(restored.doc.areas[0].rings, session.doc.areas[0].rings);
  assert.equal(validateSectorAreas(restored.doc).ok, true);
  assert.throws(() => importDoc('{"version": 9}'), RangeError);
  // Импорт начинает новую историю: отмена не затирает прошлый документ.
  assert.equal(canUndo(restored), false);
});

test('выделение области и адрес по центру кольца', () => {
  const session = selectArea(addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Область',
    points: [[1000, 1000], [2000, 1000], [2000, 2000]],
  }), 'a-1');
  assert.equal(selectedArea(session).id, 'a-1');
  assert.equal(selectedArea(selectArea(session, null)), null);
  assert.match(addressForRing([[5720, 6257], [5721, 6257], [5721, 6258], [5720, 6258]]), /^KP·[A-Y]{5}$/);
});

/* ---------------------------------------------- инструменты рисования (карточка P2) */

const OPEN_LINE = [[1000, 1000], [2000, 2000], [3000, 1500]];
const CLOSED_SQUARE = [[1000, 1000], [4000, 1000], [4000, 4000], [1000, 4000]];

/** Заливка состояния: градиент полный, иначе проверка документа упадёт на стопах. */
const fillState = (overrides = {}) => state({ id: 'st-fill', gradient: DEFAULT_GRADIENT, ...overrides });

test('открытая линия сохраняется незамкнутой и получает location = unknown', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Открытая линия',
    points: OPEN_LINE,
    closed: false,
    location: 'unknown',
  });
  const area = areaById(session, 'a-1');
  assert.equal(area.closed, false, 'линия не замыкается');
  assert.equal(area.location, 'unknown', 'площади нет — классифицировать нечего');
  const ring = area.rings[0];
  assert.notDeepEqual(ring[0], ring[ring.length - 1], 'замыкающей копии первой точки нет');
  assert.deepEqual([...ring], OPEN_LINE, 'точки линии сохранены как есть');
  // Площадь открытой линии документом не классифицируется: `location` — unknown,
  // а `ringArea` — примитив геометрии, который о намерении инструмента не знает.
  assert.deepEqual(validateSectorAreas(session.doc).errors, []);
});

test('замкнутая фигура остаётся замкнутой без навязанного положения', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Прямоугольник',
    points: CLOSED_SQUARE,
    closed: true,
  });
  const area = areaById(session, 'a-1');
  assert.equal(area.closed, true);
  assert.equal(area.location, null, 'положение считает scope, а не инструмент');
  const ring = area.rings[0];
  assert.deepEqual(ring[0], ring[ring.length - 1], 'кольцо замкнуто');
  assert.ok(ringArea(ring, true) > 0);
  assert.deepEqual(validateSectorAreas(session.doc).errors, []);
});

test('две заливки различны: override идёт в overrides, состояние — в саму область', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1',
    name: 'Фигура',
    points: CLOSED_SQUARE,
    closed: true,
  });
  const before = session.doc.events.length;

  // Первая заливка — существующий мазок форс-закрашивания поверх области.
  session = addForceFill(session, {
    id: 'force-1',
    rings: session.doc.areas[0].rings,
    color: '#ff0000',
    areaId: 'a-1',
  });
  assert.equal(session.doc.overrides.length, 1);
  assert.equal(session.doc.areas[0].states.length, 0, 'override состояний не пишет');
  assert.equal(session.doc.events.at(-1).kind, 'override');

  // Вторая заливка — состояние самой фигуры, и это другое действие.
  session = fillShapeAsState(session, { areaId: 'a-1', state: fillState() });
  assert.equal(session.doc.overrides.length, 1, 'заливка состоянием не трогает override');
  assert.equal(session.doc.areas[0].states.length, 1);
  assert.equal(session.doc.events.at(-1).kind, 'state');
  assert.equal(session.doc.areas[0].states[0].id, 'st-fill');

  // Каждая завершённая операция — ровно одна запись в журнале.
  assert.equal(session.doc.events.length, before + 2);
  assert.deepEqual(validateSectorAreas(session.doc).errors, []);
});

test('повторная заливка заменяет состояние того же режима, а не копит их', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1', name: 'Фигура', points: CLOSED_SQUARE, closed: true,
  });
  session = fillShapeAsState(session, { areaId: 'a-1', state: fillState({ factionIds: ['Доминион Терран'] }) });
  session = fillShapeAsState(session, { areaId: 'a-1', state: fillState({ factionIds: ['Умоджанский Протекторат'] }) });
  assert.equal(session.doc.areas[0].states.length, 1, 'в одном режиме — одно состояние');
  assert.deepEqual(session.doc.areas[0].states[0].factionIds, ['Умоджанский Протекторат']);
  // Иначе проверка документа честно предупреждала бы о нескольких состояниях.
  assert.deepEqual(validateSectorAreas(session.doc).warnings, []);
});

test('открытую линию заливать нечем: обе заливки отказывают понятно', () => {
  const session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1', name: 'Линия', points: OPEN_LINE, closed: false, location: 'unknown',
  });
  const area = areaById(session, 'a-1');
  const check = canFillArea(area);
  assert.equal(check.ok, false);
  assert.match(check.reason, /не заливается/);
  assert.equal(canFillArea(null).ok, false);
  assert.match(canFillArea(null).reason, /не выбрана/);

  assert.throws(
    () => fillShapeAsState(session, { areaId: 'a-1', state: fillState() }),
    /не заливается/,
  );
  // Документ не испорчен: ни состояния, ни мазка, ни лишнего события.
  assert.equal(session.doc.areas[0].states.length, 0);
  assert.equal(session.doc.overrides.length, 0);
  assert.equal(session.doc.events.length, 1, 'неудачная заливка не пишет в журнал');
});

test('инструмент, режим, ширина и привязка не попадают в историю документа', () => {
  const start = createEditorSession();
  const tweaked = selectArea(setBrushWidth(setSnapMode(setMode(start, 'military'), 'sector'), 12), null);
  assert.equal(tweaked.doc, start.doc, 'документ тот же объект: правки не было');
  assert.equal(tweaked.doc.events.length, 0);
  assert.equal(canUndo(tweaked), false);
  assert.equal(canRedo(tweaked), false);

  // Выделение области — тоже состояние интерфейса, а не правка документа.
  const withArea = addAreaFromStroke(tweaked, { id: 'a-1', name: 'Фигура', points: CLOSED_SQUARE });
  const created = withArea.doc.events.length;
  const selected = selectArea(withArea, 'a-1');
  assert.equal(selected.doc.events.length, created, 'выделение не пишет в журнал');
  assert.equal(canUndo(selected), canUndo(withArea), 'выделение не добавляет шаг отмены');
});

test('отмена и повтор после заливки, создания фигуры и загрузки документа', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'a-1', name: 'Фигура', points: CLOSED_SQUARE, closed: true,
  });
  session = fillShapeAsState(session, { areaId: 'a-1', state: fillState() });
  assert.equal(session.doc.areas[0].states.length, 1);

  // Отмена снимает ровно последнее завершённое изменение, а не всё сразу.
  const back = undo(session);
  assert.equal(back.doc.areas[0].states.length, 0, 'заливка отменена');
  assert.equal(back.doc.areas.length, 1, 'сама фигура осталась: отмена не прыгает через шаги');
  assert.equal(canRedo(back), true);

  // Повтор возвращает заливку: это и есть проверенная работа redo.
  const forward = redo(back);
  assert.equal(forward.doc.areas[0].states.length, 1);
  assert.equal(forward.doc.areas[0].states[0].id, 'st-fill');

  // Ещё один шаг назад — и фигуры нет: две операции отменяются по одной.
  assert.equal(undo(back).doc.areas.length, 0);

  // Загруженный документ начинает чистую историю: ни отмены, ни повтора.
  const loaded = importDoc(exportDoc(forward));
  assert.equal(canUndo(loaded), false);
  assert.equal(canRedo(loaded), false);
  assert.equal(loaded.doc.areas[0].states.length, 1, 'документ перенесён целиком');
  // Нумерация продолжается: новая область не получает занятый номер.
  const after = addAreaFromStroke(loaded, {
    id: 'a-' + loaded.sequence, name: 'Новая', points: CLOSED_SQUARE, closed: true,
  });
  const ids = after.doc.areas.map((area) => area.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы не повторяются');
  assert.deepEqual(validateSectorAreas(after.doc).errors, []);
});

test('несколько отдельных штрихов продолжают активную область, undo/redo снимает и возвращает их поштучно', () => {
  let session = createEditorSession();
  const s1 = { id: 'stroke-1', points: [[200, 200], [800, 200]], closed: false };
  const s2 = { id: 'stroke-2', points: [[1000, 1000], [1600, 1000], [1600, 1600], [1000, 1600]], closed: true };
  const s3 = { id: 'stroke-3', points: [[2000, 400], [2400, 800]], closed: false };

  // Первый штрих при отсутствии выбора создаёт активную область и делает её выбранной.
  session = recordCompletedStroke(session, {
    stroke: s1,
    areaIdIfNew: 'area-1',
    areaNameIfNew: 'Составная',
    state: state(),
  });
  assert.equal(session.selection, 'area-1');
  assert.equal(session.doc.areas.length, 1);
  assert.deepEqual(session.doc.areas[0].rings, [], 'rings не переиспользуется для штрихов');
  assert.equal(session.doc.areas[0].strokes.length, 1);

  // Второй и третий штрихи продолжают ту же активную область по одной команде истории.
  session = recordCompletedStroke(session, { stroke: s2, state: state() });
  session = recordCompletedStroke(session, { stroke: s3, state: state() });
  assert.equal(session.doc.areas.length, 1, 'штрихи идут в ту же активную область');
  assert.deepEqual(session.doc.areas[0].strokes.map((item) => item.id), ['stroke-1', 'stroke-2', 'stroke-3']);
  assert.equal(session.past.length, 3, 'каждый завершённый штрих — отдельная команда истории');

  // Замкнутый штрих внутри области делает заливку допустимой.
  assert.equal(canFillArea(selectedArea(session)).ok, true);

  // Поштучный откат завершённых штрихов.
  const back1 = undo(session);
  assert.deepEqual(back1.doc.areas[0].strokes.map((item) => item.id), ['stroke-1', 'stroke-2']);
  assert.equal(back1.selection, 'area-1');

  const back2 = undo(back1);
  assert.deepEqual(back2.doc.areas[0].strokes.map((item) => item.id), ['stroke-1']);
  assert.equal(canFillArea(selectedArea(back2)).ok, false, 'остался только открытый штрих');

  const back3 = undo(back2);
  assert.equal(back3.doc.areas.length, 0);
  assert.equal(back3.selection, null);

  // Поштучный повтор возвращает штрихи по одному.
  const fwd1 = redo(back3);
  assert.deepEqual(fwd1.doc.areas[0].strokes.map((item) => item.id), ['stroke-1']);
  assert.equal(fwd1.selection, 'area-1');
  const fwd2 = redo(fwd1);
  assert.deepEqual(fwd2.doc.areas[0].strokes.map((item) => item.id), ['stroke-1', 'stroke-2']);
  const fwd3 = redo(fwd2);
  assert.deepEqual(fwd3.doc.areas[0].strokes.map((item) => item.id), ['stroke-1', 'stroke-2', 'stroke-3']);

  // Выгрузка и повторный импорт сохраняют все штрихи и продолжают нумерацию.
  const reloaded = importDoc(exportDoc(fwd3));
  assert.deepEqual(reloaded.doc.areas[0].strokes, fwd3.doc.areas[0].strokes);
  assert.ok(nextSequence(reloaded.doc) > 3);
  assert.deepEqual(validateSectorAreas(reloaded.doc).errors, []);
});

test('штрихи добавляются к области с существующими rings и дыркой, не меняя их смысл', () => {
  const hole = [[1200, 1200], [1400, 1200], [1400, 1400], [1200, 1400], [1200, 1200]];
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'area-ring',
    name: 'С кольцом и дыркой',
    points: CLOSED_SQUARE,
    closed: true,
    state: fillState(),
  });
  // Добавим дырку во внешнее кольцо классическим полем rings[1].
  session = {
    ...session,
    doc: {
      ...session.doc,
      areas: session.doc.areas.map((area) => ({ ...area, rings: [area.rings[0], hole] })),
    },
  };
  const beforeRings = session.doc.areas[0].rings;

  session = addStrokeToArea(session, {
    areaId: 'area-ring',
    stroke: { id: 'stroke-extra', points: [[3000, 3000], [3500, 3000]], closed: false },
  });
  assert.deepEqual(session.doc.areas[0].rings, beforeRings, 'rings и дырка неизменны');
  assert.equal(session.doc.areas[0].strokes.length, 1);
  assert.deepEqual(validateSectorAreas(session.doc).errors, []);
});

test('команда «Создать новую область» создаёт пустую область, а undo удаляет её и возвращает прежний активный ID', () => {
  let session = addAreaFromStroke(createEditorSession(), {
    id: 'area-1',
    name: 'Первая',
    points: CLOSED_SQUARE,
    closed: true,
    state: state(),
  });
  assert.equal(session.selection, 'area-1');

  // Создаём новую пустую область при активной area-1.
  const withEmpty = createEmptyArea(session, { id: 'area-2', name: 'Вторая пустая', state: state({ id: 'st-2' }) });
  assert.equal(withEmpty.selection, 'area-2', 'активный выбор переключён на новую пустую область');
  assert.equal(withEmpty.doc.areas.length, 2);
  const emptyArea = areaById(withEmpty, 'area-2');
  assert.deepEqual(emptyArea.rings, []);
  assert.deepEqual(emptyArea.strokes, []);
  assert.equal(canFillArea(emptyArea).ok, false);

  // Отмена создания пустой области удаляет её и возвращает выбор на area-1!
  const undone = undo(withEmpty);
  assert.equal(undone.doc.areas.length, 1);
  assert.equal(areaById(undone, 'area-2'), null);
  assert.equal(undone.selection, 'area-1', 'восстановлен прежний активный ID');

  // Повтор снова создаёт пустую область и делает её активной.
  const redone = redo(undone);
  assert.equal(redone.doc.areas.length, 2);
  assert.equal(redone.selection, 'area-2');

  // Если до создания пустой области активного выбора не было (null), undo возвращает null.
  const fromNull = createEmptyArea(createEditorSession(), { id: 'area-empty' });
  assert.equal(fromNull.selection, 'area-empty');
  const undoneNull = undo(fromNull);
  assert.equal(undoneNull.doc.areas.length, 0);
  assert.equal(undoneNull.selection, null);
});

test('snapAndRecordStroke привязывает штрих к рёбрам отображаемой адресной сетки в режиме grid', () => {
  let session = setSnapMode(createEditorSession(), 'grid');
  session = snapAndRecordStroke(
    session,
    {
      stroke: { id: 'stroke-grid-1', points: [[40, 78], [220, 77]], closed: false },
      areaIdIfNew: 'area-grid',
      state: state(),
    },
    { w: 1000, h: 800 },
    { centerX: 500, centerY: 500, visibleWidth: 2000 },
  );
  // Ярус T3 (cellSize = 80): линия около y = 78 притягивается к горизонтальному ребру y = 80.
  assert.deepEqual(session.doc.areas[0].strokes[0].points, [[40, 80], [220, 80]]);
});

test('толщина кисти записывается вместе со штрихом и переживает привязку к сетке', () => {
  let session = setBrushWidth(createEditorSession(), 40);
  assert.equal(session.brushWidthPx, 40);

  // Свободный режим: толщина доходит до документа как есть.
  session = snapAndRecordStroke(
    session,
    {
      stroke: { id: 'stroke-w-free', points: [[100, 100], [300, 100], [300, 300]], closed: true, width: session.brushWidthPx },
      areaIdIfNew: 'area-w-free',
      state: state(),
    },
    { w: 1000, h: 800 },
    { centerX: 500, centerY: 500, visibleWidth: 2000 },
  );
  assert.equal(session.doc.areas[0].strokes[0].width, 40, 'ширина штриха сохранена');

  // Привязка к сетке меняет точки, но не теряет толщину.
  let snapped = setSnapMode(createEditorSession(), 'grid');
  snapped = snapAndRecordStroke(
    snapped,
    {
      stroke: { id: 'stroke-w-grid', points: [[40, 78], [220, 77]], closed: false, width: 24 },
      areaIdIfNew: 'area-w-grid',
      state: state(),
    },
    { w: 1000, h: 800 },
    { centerX: 500, centerY: 500, visibleWidth: 2000 },
  );
  const gridStroke = snapped.doc.areas[0].strokes[0];
  assert.deepEqual(gridStroke.points, [[40, 80], [220, 80]], 'точки привязаны к ребру');
  assert.equal(gridStroke.width, 24, 'привязка не обнуляет толщину');
});
