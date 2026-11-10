/* Отрисовка областей: документ → краски → примитив сцены (шаг 2 §11 части 2).
 *
 * Проверяется чистый слой без канвы: каскад и глубина отсекают лишнее,
 * фокус-режим приглушает или скрывает, градиент даёт цвета по вершинам,
 * мазок форс-закрашивания перебивает всё и уходит последним, а проекция
 * `areasFor` переводит мировые координаты в экранные.
 * Запуск: node --test tests/sector-areas-render.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createArea, emptySectorAreasDoc, parseSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { createFactionPalette, parseFactionCsv } from '../src/atlas/sector-areas-color.ts';
import { buildAreaPaints, areaSize } from '../src/atlas/sector-areas-render.ts';
import { areasFor, buildSectorScene } from '../src/atlas/sector-scene.ts';
import { createLodCache } from '../src/atlas/sector-areas-lod.ts';
import { commitOverride, createOverrideStroke } from '../src/atlas/sector-areas-force.ts';

const factionsCsv = await readFile(new URL('../data/factions.csv', import.meta.url), 'utf8');
const palette = createFactionPalette(parseFactionCsv(factionsCsv));

const SQUARE = [[1000, 1000], [4000, 1000], [4000, 4000], [1000, 4000], [1000, 1000]];
const LINE = [[1000, 5000], [2000, 5000], [3000, 5000]];
const SECOND = [[5000, 5000], [6000, 5000], [6000, 6000], [5000, 6000], [5000, 5000]];

const state = (overrides = {}) => ({
  id: 'st-1',
  mode: 'political',
  factionMode: 'single',
  factionIds: ['Доминион Терран'],
  task: 'none',
  visibleFrom: 0,
  visibleTo: 12,
  z: 20,
  priority: 0,
  lodBias: 0,
  rounding: 1,
  gradient: { mode: 'auto' },
  override: false,
  label: null,
  ...overrides,
});

const docWith = (areas, extras = {}) => parseSectorAreas({ ...emptySectorAreasDoc(), areas, ...extras });

const base = (options = {}) => ({
  level: 4,
  visibleWidth: 1000,
  palette,
  ...options,
});

test('пустой документ и область без состояний не дают красок', () => {
  assert.deepEqual(buildAreaPaints(emptySectorAreasDoc(), base()), []);
  const bare = docWith([createArea({ id: 'a-1', name: 'Без состояния', rings: [SQUARE] })]);
  assert.deepEqual(buildAreaPaints(bare, base()), []);
});

test('состояние даёт заливку и обводку цветом фракции', () => {
  const doc = docWith([{ ...createArea({ id: 'a-1', name: 'Доминион', rings: [SQUARE] }), states: [state()] }]);
  const paints = buildAreaPaints(doc, base());
  assert.equal(paints.length, 1);
  const paint = paints[0];
  assert.equal(paint.areaId, 'a-1');
  assert.equal(paint.mode, 'political');
  assert.equal(paint.override, false);
  assert.equal(paint.visible, true);
  assert.notEqual(paint.fill, null);
  assert.deepEqual(paint.stroke.rgb, [254, 0, 0]);
  assert.equal(paint.rings.length, 1);
  assert.ok(paint.rings[0].points.length >= 4);
});

test('открытая линия рисуется без заливки', () => {
  const area = createArea({ id: 'a-1', name: 'Линия', rings: [LINE], closed: false });
  const doc = docWith([{ ...area, states: [state()] }]);
  const paints = buildAreaPaints(doc, base());
  assert.equal(paints.length, 1);
  assert.equal(paints[0].fill, null);
});

test('глубина отсекает состояния вне диапазона видимости', () => {
  const area = { ...createArea({ id: 'a-1', name: 'Глубокая', rings: [SQUARE] }), states: [state({ visibleFrom: 6, visibleTo: 10 })] };
  const doc = docWith([area]);
  assert.equal(buildAreaPaints(doc, base({ level: 3 })).length, 0);
  assert.equal(buildAreaPaints(doc, base({ level: 7 })).length, 1);
  assert.equal(buildAreaPaints(doc, base({ level: 11 })).length, 0);
});

test('эффективный уровень учитывает смещение детализации', () => {
  const area = { ...createArea({ id: 'a-1', name: 'Со смещением', rings: [SQUARE] }), states: [state({ lodBias: 1 })] };
  const paints = buildAreaPaints(docWith([area]), base({ level: 5 }));
  assert.equal(paints[0].level, 6);
});

test('фокус-режим: приглушение уменьшает альфу, скрытие убирает область', () => {
  const doc = docWith([{ ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }), states: [state()] }]);
  const full = buildAreaPaints(doc, base())[0];
  const dimmed = buildAreaPaints(doc, base({ focusMode: 'military' }))[0];
  assert.ok(dimmed.stroke.alpha < full.stroke.alpha);
  assert.equal(dimmed.visible, true);

  const hidden = buildAreaPaints(doc, base({
    focusMode: 'military',
    focus: { behavior: 'hide', dimAlpha: 0.3 },
  }));
  assert.deepEqual(hidden, []);
});

test('несколько режимов одной области рисуются поверх одной геометрии', () => {
  const area = {
    ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }),
    states: [state({ id: 'st-1', mode: 'political', z: 20 }), state({ id: 'st-2', mode: 'military', z: 10 })],
  };
  const paints = buildAreaPaints(docWith([area]), base());
  assert.equal(paints.length, 2);
  assert.equal(paints[0].mode, 'military');
  assert.equal(paints[1].mode, 'political');
  // Геометрия одна: число вершин совпадает при одинаковом LOD.
  assert.equal(paints[0].rings[0].points.length, paints[1].rings[0].points.length);
});

test('градиент даёт цвета по вершинам исходного пути', () => {
  const area = {
    ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }),
    states: [state()],
  };
  const paints = buildAreaPaints(docWith([area]), base());
  const ring = paints[0].rings[0];
  assert.equal(ring.colors.length, ring.points.length);
  assert.notDeepEqual(ring.colors[0], ring.colors[Math.floor(ring.colors.length / 2)]);
  // Параметры вершин — доли исходного пути: после сглаживания они сдвинуты,
  // но остаются в диапазоне `0…1` и не привязаны к индексу вершины.
  for (const param of ring.params) {
    assert.ok(param >= 0 && param <= 1, `параметр вне диапазона: ${param}`);
  }
  assert.ok(ring.params[0] < 0.25);
});

test('форс-закрашивание перебивает цвет и уходит последним', () => {
  const area = { ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }), states: [state()] };
  const doc = commitOverride(
    docWith([area]),
    createOverrideStroke({ id: 'force-1', rings: [SQUARE], color: '#00ff00', areaId: 'a-1' }),
  );
  const paints = buildAreaPaints(doc, base());
  assert.equal(paints.length, 1);
  assert.equal(paints[0].override, true);
  assert.deepEqual(paints[0].stroke.rgb, [0, 255, 0]);
  assert.ok(paints[0].z > 20);
  // Исходное состояние не разрушено: оно осталось в документе.
  assert.equal(doc.areas[0].states.length, 1);
});

test('порядок отрисовки: по z, затем по режиму, мазки — последними', () => {
  const first = { ...createArea({ id: 'a-1', name: 'Первая', rings: [SQUARE] }), states: [state({ z: 30 })] };
  const second = {
    ...createArea({ id: 'a-2', name: 'Вторая', rings: [SECOND] }),
    states: [state({ id: 'st-9', z: 5 })],
  };
  const doc = docWith([first, second]);
  const paints = buildAreaPaints(doc, base());
  assert.deepEqual(paints.map((paint) => paint.areaId), ['a-2', 'a-1']);

  const filled = commitOverride(doc, createOverrideStroke({ id: 'force-1', rings: [SQUARE], color: '#0000ff' }));
  const withOverride = buildAreaPaints(filled, base());
  assert.equal(withOverride.at(-1).override, true);
});

test('кэш LOD даёт тот же результат при повторном построении', () => {
  const area = { ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }), states: [state()] };
  const doc = docWith([area]);
  const cache = createLodCache();
  const first = buildAreaPaints(doc, base({ cache }));
  const second = buildAreaPaints(doc, base({ cache }));
  assert.deepEqual(second, first);
  assert.ok(cache.size > 0);
});

test('площадь области считается по внешнему кольцу', () => {
  const area = createArea({ id: 'a-1', name: 'Квадрат', rings: [SQUARE] });
  assert.equal(areaSize(area), 9000000);
  assert.equal(areaSize(createArea({ id: 'a-2', name: 'Пусто', rings: [] })), 0);
});

test('проекция areasFor переводит мировые координаты в экранные', () => {
  // Округлость 0: без сглаживания вершины остаются исходными точками кольца.
  const area = { ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }), states: [state({ rounding: 0 })] };
  const paints = buildAreaPaints(docWith([area]), base());
  const projected = areasFor(paints, { w: 1000, h: 800 }, { centerX: 5000, centerY: 5000, visibleWidth: 10000 });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].kind, 'brush');

  const world = paints[0].rings[0].points[0];
  const scale = 1000 / 10000;
  const expectedX = 1000 / 2 + (world[0] - 5000) * scale;
  const expectedY = 800 / 2 + (world[1] - 5000) * scale;
  const point = projected[0].rings[0].points[0];
  assert.ok(Math.abs(point.x - expectedX) < 1e-6, `${point.x} != ${expectedX}`);
  assert.ok(Math.abs(point.y - expectedY) < 1e-6, `${point.y} != ${expectedY}`);
  // Центр мира попадает ровно в центр кадра.
  assert.equal(1000 / 2 + (5000 - 5000) * scale, 500);
  // Цвета вершин доезжают до сцены строками CSS.
  assert.match(projected[0].rings[0].colors[0], /^rgba?\(/);
});

test('сцена учитывает области: примитив brush и счётчик counts.areas', () => {
  const area = { ...createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] }), states: [state()] };
  const paints = buildAreaPaints(docWith([area]), base());
  const scene = buildSectorScene({
    systems: [{ id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', type: 'capital' }],
    viewport: { w: 1000, h: 1000 },
    camera: { centerX: 5000, centerY: 5000, visibleWidth: 10000 },
    areas: paints,
    labels: false,
  });
  assert.equal(scene.counts.areas, 1);
  assert.equal(scene.primitives.filter((primitive) => primitive.kind === 'brush').length, 1);
  // Области идут до маркеров и подписей, но после сетки адресов.
  const kinds = scene.primitives.map((primitive) => primitive.kind);
  assert.ok(kinds.indexOf('marker') > -1, 'маркер системы должен быть в сцене');
  assert.ok(kinds.indexOf('brush') < kinds.indexOf('marker'));
});

test('отдельные штрихи области отрисовываются без смешивания с rings и сохраняют открытость и заливку', () => {
  const hole = [[1500, 1500], [2000, 1500], [2000, 2000], [1500, 2000], [1500, 1500]];
  const openStroke = { id: 's-open', points: [[5200, 5200], [6200, 5200]], closed: false };
  const closedStroke = {
    id: 's-closed',
    points: [[7000, 7000], [8000, 7000], [8000, 8000], [7000, 8000]],
    closed: true,
  };
  const area = {
    ...createArea({
      id: 'a-multi',
      name: 'Мультиштриховая',
      rings: [SQUARE, hole],
      strokes: [openStroke, closedStroke],
    }),
    states: [state()],
  };
  const doc = docWith([area]);
  const paints = buildAreaPaints(doc, base());

  // Три отдельных слоя для одной области: (1) rings + дырка, (2) замкнутый штрих с заливкой, (3) открытый штрих без заливки.
  assert.equal(paints.length, 3);
  const ringsPaint = paints.find((item) => item.strokeIds === undefined);
  const closedPaint = paints.find((item) => item.strokeIds?.[0] === 's-closed');
  const openPaint = paints.find((item) => item.strokeIds?.[0] === 's-open');

  assert.equal(ringsPaint.rings.length, 2, 'кольцо и отверстие остались парой');
  assert.notEqual(ringsPaint.fill, null);
  assert.notEqual(closedPaint.fill, null, 'замкнутый штрих получает заливку состояния');
  assert.equal(closedPaint.rings[0].closed, true);
  assert.equal(openPaint.fill, null, 'открытый штрих не заливается');
  assert.equal(openPaint.rings[0].closed, false);

  // Площадь учитывает внешнее кольцо и замкнутый штрих, но не открытый.
  assert.equal(areaSize(area), 9_000_000 + 1_000_000);

  // Проекция в экранную сцену сохраняет все три примитива brush.
  const projected = areasFor(paints, { w: 1000, h: 800 }, { centerX: 5000, centerY: 5000, visibleWidth: 10000 });
  assert.equal(projected.length, 3);
});

test('форс-закрашивание учитывает фокус, rounding/lodBias состояния, а split прикрепляется и к замкнутым штрихам', () => {
  const closedStroke = { id: 's-closed', points: [[7000, 7000], [8000, 7000], [8000, 8000], [7000, 8000]], closed: true };
  const area = {
    ...createArea({
      id: 'a-override',
      name: 'С мазком',
      rings: [SQUARE],
      strokes: [closedStroke],
    }),
    states: [state({ mode: 'political', rounding: 2, lodBias: 1 })],
  };
  const stroke = createOverrideStroke({
    id: 'ov-1',
    areaId: 'a-override',
    mode: 'political',
    rings: [LINE],
    color: '#ff0055',
    alpha: 0.8,
  });
  const doc = commitOverride(docWith([area]), stroke);
  const splitMask = { holes: [SECOND], line: [[5000, 5000], [6000, 6000]], transitionHalfWidth: 0 };

  const visibleFocus = buildAreaPaints(doc, {
    level: 5,
    palette,
    focusMode: 'military',
    focus: { behavior: 'dim', dimAlpha: 0.25 },
    splitForArea: () => [splitMask],
  });
  const overridePaint = visibleFocus.find((item) => item.override);
  const closedStrokePaint = visibleFocus.find((item) => item.strokeIds?.[0] === 's-closed');
  assert.ok(overridePaint !== undefined);
  assert.ok(overridePaint.stroke.alpha <= 0.8 * 0.25 + 1e-6, 'override приглушается в неактивном фокус-режиме');
  assert.equal(closedStrokePaint.splits.length, 1, 'split прикреплён к замкнутому штриху даже при непустых rings');

  const hiddenFocus = buildAreaPaints(doc, {
    level: 5,
    palette,
    focusMode: 'military',
    focus: { behavior: 'hide', dimAlpha: 0.25 },
  });
  assert.equal(hiddenFocus.some((item) => item.override), false, 'hide скрывает override чужого режима');
});
