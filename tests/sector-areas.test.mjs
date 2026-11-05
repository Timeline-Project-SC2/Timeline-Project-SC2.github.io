/* Ядро редактора границ: контракт, геометрия, LOD, цвет, градиент, каскад,
 * форс-закрашивание и журнал (шаг 1 §11 части 2 плана).
 *
 * Проверяется чистая модель без UI и рендера: разбор и валидация документа,
 * упрощение/сглаживание с сохранением параметра пути, расчёт LOD, стиль
 * состояния, градиент `auto/custom/hybrid`, наследование состояний, override
 * и журнал. Запуск: node --test tests/sector-areas.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createArea,
  emptySectorAreasDoc,
  findParentCycles,
  parseSectorAreas,
  validateSectorAreas,
} from '../src/atlas/sector-areas-contract.ts';
import {
  distanceToRing,
  parametrize,
  pointAt,
  pointInArea,
  pointInRing,
  ringArea,
  ringCentroid,
  ringContainsRing,
  ringLength,
  selfIntersections,
  simplify,
  smooth,
  totalVertices,
} from '../src/atlas/sector-areas-geometry.ts';
import {
  LOD_PRESETS,
  computeLod,
  createLodCache,
  effectiveLevel,
  lodEpsilon,
  lodForState,
  roundingIterations,
  viewportBucket,
} from '../src/atlas/sector-areas-lod.ts';
import {
  createFactionPalette,
  focusAppearance,
  parseFactionCsv,
  stateStyle,
  strokeSafeColor,
  taskStyle,
} from '../src/atlas/sector-areas-color.ts';
import { autoStops, paintRing, resolveGradient, sampleGradient } from '../src/atlas/sector-areas-gradient.ts';
import {
  buildAreaIndex,
  checkContainment,
  effectiveStates,
  hierarchyDepth,
  pickState,
  statesForLevel,
} from '../src/atlas/sector-areas-cascade.ts';
import {
  commitOverride,
  createOverrideStroke,
  overrideCovers,
  overridesFor,
  paintOrder,
  removeOverride,
  resolvePaint,
} from '../src/atlas/sector-areas-force.ts';
import { buildJournal, filterJournal, journalToJson } from '../src/atlas/sector-areas-journal.ts';

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const BIG = [[1000, 1000], [4000, 1000], [4000, 4000], [1000, 4000], [1000, 1000]];
const SMALL = [[1500, 1500], [2000, 1500], [2000, 2000], [1500, 2000], [1500, 1500]];

const factionsCsv = await readFile(new URL('../data/factions.csv', import.meta.url), 'utf8');
const palette = createFactionPalette(parseFactionCsv(factionsCsv));

function docWith(areas, extras = {}) {
  return parseSectorAreas({ ...emptySectorAreasDoc(), areas, ...extras });
}

/* --------------------------------------------------------------- контракт */

test('каркас data/sector-areas.json разбирается и проходит валидацию', async () => {
  const raw = await readFile(new URL('../data/sector-areas.json', import.meta.url), 'utf8');
  const doc = parseSectorAreas(raw);
  assert.equal(doc.version, 1);
  assert.equal(doc.mapSize, 10000);
  assert.deepEqual(doc.areas, []);
  assert.deepEqual(doc.modes, ['political', 'military', 'economy', 'tension']);
  assert.deepEqual(doc.experimentalModes, ['ecology', 'history']);
  const report = validateSectorAreas(doc);
  assert.deepEqual(report.errors, []);
  assert.equal(report.ok, true);
});

test('ошибки схемы и ссылок попадают в отчёт валидации', () => {
  const doc = docWith([
    createArea({ id: 'a-1', name: 'Первая', rings: [SQUARE], parentId: 'нет' }),
    createArea({ id: 'a-2', name: 'Вторая', rings: [SQUARE], parentId: 'a-3' }),
    createArea({ id: 'a-3', name: 'Третья', rings: [SQUARE], parentId: 'a-2' }),
  ], {
    overrides: [{ id: 'o-1', areaId: 'нет', mode: null, rings: [SQUARE], color: '#ffffff', alpha: 1 }],
  });
  const report = validateSectorAreas(doc);
  assert.ok(report.errors.some((message) => message.includes('родитель') && message.includes('a-1')));
  assert.ok(report.errors.some((message) => message.includes('Цикл')));
  assert.ok(report.errors.some((message) => message.includes('o-1')));
  assert.equal(report.ok, false);
  assert.equal(findParentCycles(doc).length, 1);
});

test('состояние проверяется по фракциям, глубине и градиенту', () => {
  const area = createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] });
  const broken = {
    ...area,
    states: [{
      id: 'st-1',
      mode: 'political',
      factionMode: 'pair',
      factionIds: ['Доминион Терран', 'Доминион Терран'],
      task: 'none',
      visibleFrom: 8,
      visibleTo: 2,
      z: 20,
      priority: 0,
      lodBias: 0,
      rounding: 1,
      gradient: { mode: 'custom', stops: [{ offset: 0, color: '#ff0000', alpha: 1 }] },
      override: false,
      label: null,
    }],
  };
  const report = validateSectorAreas(docWith([broken]), {
    factionNames: new Set(palette.names),
  });
  assert.ok(report.errors.some((message) => message.includes('должны различаться')));
  assert.ok(report.errors.some((message) => message.includes('начало глубины больше конца')));
  assert.ok(report.errors.some((message) => message.includes('минимум два стопа')));
});

test('неизвестная фракция и экспериментальный режим ловятся валидатором', () => {
  const area = createArea({ id: 'a-1', name: 'Область', rings: [SQUARE] });
  const withUnknown = {
    ...area,
    states: [{
      id: 'st-1',
      mode: 'political',
      factionMode: 'single',
      factionIds: ['Нет такой фракции'],
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
    }],
  };
  const report = validateSectorAreas(docWith([withUnknown]), { factionNames: new Set(palette.names) });
  assert.ok(report.errors.some((message) => message.includes('Нет такой фракции')));
  assert.throws(() => parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{ ...area, states: [{ id: 's', mode: 'ecology', factionIds: [] }] }],
  }), RangeError);
});

/* --------------------------------------------------------------- геометрия */

test('длина, площадь, центр и принадлежность точки считаются по кольцу', () => {
  assert.equal(ringLength(SQUARE), 40);
  assert.equal(ringArea(SQUARE), 100);
  assert.deepEqual(ringCentroid(SQUARE), [5, 5]);
  assert.equal(pointInRing(SQUARE, 5, 5), true);
  assert.equal(pointInRing(SQUARE, 15, 5), false);
  assert.equal(distanceToRing(SQUARE, 5, 5), 5);
});

test('дырка области исключается из принадлежности', () => {
  const area = createArea({ id: 'a-1', name: 'С дыркой', rings: [BIG, SMALL] });
  assert.equal(pointInArea(area, 1200, 1200), true);
  assert.equal(pointInArea(area, 1750, 1750), false);
  assert.equal(pointInArea(area, 900, 900), false);
  assert.equal(totalVertices(area), BIG.length + SMALL.length);
  assert.equal(ringContainsRing(BIG, SMALL), true);
  assert.equal(ringContainsRing(SMALL, BIG), false);
});

test('самопересечение считается предупреждением, а не исправляется само', () => {
  const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]];
  assert.equal(selfIntersections(bowtie), 1);
  assert.equal(selfIntersections(SQUARE), 0);
  // Геометрия не переписывается: упрощение возвращает новую ломаную.
  const source = parametrize(bowtie, true);
  assert.equal(source.points.length, 4);
});

test('упрощение RDP сохраняет концы и параметр исходного пути', () => {
  const ring = parametrize([[0, 0], [5, 0.4], [10, 0], [10, 10], [0, 10], [0, 0]], true);
  const reduced = simplify(ring, 1);
  assert.equal(reduced.points.length, 4);
  assert.deepEqual(reduced.points[0], [0, 0]);
  assert.equal(reduced.params[0], 0);
  assert.ok(Math.abs((reduced.params[1] ?? 0) - 0.2506) < 0.01);
  // Параметр последней вершины меньше единицы: замыкающий сегмент не потерян.
  assert.ok((reduced.params.at(-1) ?? 0) < 1);
  // Точка на пути по параметру попадает на ломаную.
  const point = pointAt(reduced, 0.5);
  assert.ok(distanceToRing(reduced.points.map((p) => p), point[0], point[1]) < 1e-6);
});

test('сглаживание Шайкина добавляет вершины и держит параметры в 0…1', () => {
  const ring = parametrize(SQUARE, true);
  const smoothed = smooth(ring, 2);
  assert.ok(smoothed.points.length > ring.points.length);
  for (const param of smoothed.params) {
    assert.ok(param >= 0 && param <= 1, `параметр вне диапазона: ${param}`);
  }
  assert.equal(smooth(ring, 0).points.length, ring.points.length);
});

/* -------------------------------------------------------------------- LOD */

test('эффективный уровень учитывает диапазон состояния и смещение', () => {
  const state = { visibleFrom: 2, visibleTo: 8, lodBias: 1, rounding: 1, mode: 'political' };
  assert.equal(effectiveLevel(4, state), 5);
  assert.equal(effectiveLevel(8, state), 8);
  assert.equal(effectiveLevel(0, state), 2);
  const wide = { visibleFrom: 0, visibleTo: 12, lodBias: -3, rounding: 1, mode: 'political' };
  assert.equal(effectiveLevel(1, wide), 0);
});

test('допуск упрощения падает с глубиной и со смещением детализации', () => {
  assert.equal(lodEpsilon(0, 0), 20);
  assert.ok(lodEpsilon(12, 0) < lodEpsilon(0, 0));
  assert.ok(lodEpsilon(0, 1) < lodEpsilon(0, 0));
  assert.ok(lodEpsilon(0, -1) > lodEpsilon(0, 0));
  assert.equal(roundingIterations(0), 0);
  assert.equal(roundingIterations(2), 2);
  assert.equal(LOD_PRESETS.length, 3);
  assert.equal(viewportBucket(10000) > viewportBucket(10), true);
});

test('кэш LOD детерминирован для одного ключа и различает уровень', () => {
  const cache = createLodCache();
  const area = createArea({ id: 'a-1', name: 'Область', rings: [BIG] });
  const first = computeLod(area, 4, 1, 0, cache, 1000);
  const second = computeLod(area, 4, 1, 0, cache, 1000);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(cache.size, 1);
  const deep = computeLod(area, 10, 1, 0, cache, 1000);
  assert.deepEqual(deep.rings, computeLod(area, 10, 1, 0, cache, 1000).rings);
  assert.ok(deep.rings[0].points.length >= first.rings[0].points.length);
});

test('состояние задаёт округлость, а пресет −1 L не сглаживает', () => {
  const area = createArea({ id: 'a-1', name: 'Область', rings: [BIG] });
  const raw = { visibleFrom: 0, visibleTo: 12, lodBias: -1, rounding: 0, mode: 'political' };
  const soft = { visibleFrom: 0, visibleTo: 12, lodBias: 0, rounding: 2, mode: 'political' };
  const rawGeometry = lodForState(area, raw, 4);
  const softGeometry = lodForState(area, soft, 4);
  assert.equal(rawGeometry.rounding, 0);
  assert.equal(softGeometry.rounding, 2);
  assert.ok(softGeometry.rings[0].points.length > rawGeometry.rings[0].points.length);
});

/* ------------------------------------------------------------------- цвет */

test('палитра берёт цвета из data/factions.csv, неизвестная фракция — нейтраль', () => {
  assert.deepEqual(palette.colorOf('Доминион Терран'), [254, 0, 0]);
  assert.equal(palette.has('Доминион Терран'), true);
  assert.equal(palette.has('Нет такой'), false);
  assert.deepEqual(palette.colorOf('Нет такой'), [223, 231, 242]);
});

test('режим добавляет акцент, задача — пунктир и толщину, фракция остаётся', () => {
  const base = {
    id: 'st',
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
  };
  const political = stateStyle(base, { palette });
  assert.deepEqual(political.stroke, [254, 0, 0]);
  assert.deepEqual(political.dash, []);

  const military = stateStyle({ ...base, mode: 'military' }, { palette });
  assert.ok(military.stroke[1] > political.stroke[1]);
  assert.equal(military.accent !== null, true);

  const blockade = stateStyle({ ...base, task: 'blockade' }, { palette });
  assert.deepEqual(blockade.dash, taskStyle('blockade').dash);
  assert.ok(blockade.width > political.width);
  assert.deepEqual(blockade.stroke, [254, 0, 0]);
});

test('stroke-safe ограничивает светлоту тёмной карты', () => {
  const light = [255, 255, 255];
  const safe = strokeSafeColor(light, 0.72);
  assert.notDeepEqual(safe, light);
  const hsl = safe[0] / 255;
  assert.ok(hsl <= 0.73);
  assert.deepEqual(strokeSafeColor([10, 20, 30], 0.72), [10, 20, 30]);
});

test('фокус-режим настраивается: приглушение по умолчанию, скрытие — опция', () => {
  const dimmed = focusAppearance('military', 'political');
  assert.equal(dimmed.visible, true);
  assert.ok(dimmed.alpha < 1);
  const hidden = focusAppearance('military', 'political', { behavior: 'hide', dimAlpha: 0.3 });
  assert.equal(hidden.visible, false);
  const active = focusAppearance('political', 'political');
  assert.equal(active.alpha, 1);
  const noFocus = focusAppearance('political', null);
  assert.equal(noFocus.visible, true);
});

/* --------------------------------------------------------------- градиент */

const state = (overrides = {}) => ({
  id: 'st',
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

test('автоматический градиент строится от фракции, пара даёт переход A→B', () => {
  const single = resolveGradient({ mode: 'auto' }, { palette, factionMode: 'single', factionIds: ['Доминион Терран'], mode: 'political' });
  assert.deepEqual(single.stops[0].rgb, [254, 0, 0]);
  assert.equal(single.splitAt, 0.5);

  const pair = resolveGradient({ mode: 'auto', splitAt: 0.4 }, {
    palette,
    factionMode: 'pair',
    factionIds: ['Доминион Терран', 'Умоджанский Протекторат'],
    mode: 'political',
  });
  assert.deepEqual(pair.stops[0].rgb, [254, 0, 0]);
  assert.deepEqual(pair.stops.at(-1).rgb, [60, 199, 230]);
  assert.equal(pair.splitAt, 0.4);
  assert.equal(autoStops({ palette, factionMode: 'neutral' }, 0.5).length, 3);
});

test('custom берёт явные стопы, hybrid правит базу и добавляет блик', () => {
  const custom = resolveGradient({
    mode: 'custom',
    stops: [
      { offset: 0, color: '#000000', alpha: 1 },
      { offset: 1, color: '#ffffff', alpha: 0.5 },
    ],
  });
  assert.deepEqual(sampleGradient(custom, 0).rgb, [0, 0, 0]);
  assert.deepEqual(sampleGradient(custom, 1).rgb, [255, 255, 255]);
  assert.ok(Math.abs(sampleGradient(custom, 1).alpha - 0.5) < 1e-9);

  const hybrid = resolveGradient({
    mode: 'hybrid',
    splitAt: 0.3,
    overrides: [{ index: 0, offset: null, color: '#123456', alpha: null, at: null, splitAt: null }],
  }, { palette, factionMode: 'single', factionIds: ['Доминион Терран'] });
  assert.deepEqual(hybrid.stops[0].rgb, [18, 52, 86]);
  assert.equal(hybrid.splitAt, 0.3);

  const withHighlight = resolveGradient({
    mode: 'hybrid',
    overrides: [{ index: null, offset: null, color: '#ffffff', alpha: 0.8, at: 0.75, splitAt: null }],
  }, { palette, factionMode: 'single', factionIds: ['Доминион Терран'] });
  assert.equal(withHighlight.stops.length, 4);
});

test('градиент не плывёт при LOD: параметры вершин — доли исходного пути', () => {
  const context = { palette, factionMode: 'single', factionIds: ['Доминион Терран'] };
  const resolved = resolveGradient({ mode: 'auto' }, context);
  const noisy = [
    [1000, 1000], [1500, 1010], [2000, 1000], [2500, 1005], [3000, 1000], [3500, 1000],
    [4000, 1000], [4000, 2000], [4000, 3000], [4000, 4000], [3000, 4000], [2000, 4000],
    [1000, 4000], [1000, 3000], [1000, 2000], [1000, 1000],
  ];
  const source = parametrize(noisy, true);
  const reduced = simplify(source, 60);

  // Упрощение выбрасывает вершины, но у выживших остаются исходные параметры.
  assert.ok(reduced.points.length < source.points.length);
  for (const param of reduced.params) {
    assert.ok(source.params.includes(param), `параметр ${param} не из исходного пути`);
  }

  const paints = paintRing(resolved, reduced);
  assert.equal(paints.length, reduced.points.length);
  for (const paint of paints) {
    assert.deepEqual(paint.rgb, sampleGradient(resolved, paint.param).rgb);
  }

  // Точка перехода — та же доля пути: стопы идут от параметра, а не от индекса.
  const atSplit = sampleGradient(resolved, resolved.splitAt);
  assert.deepEqual(sampleGradient(resolveGradient({ mode: 'auto', splitAt: 0.5 }, context), 0.5).rgb, atSplit.rgb);
  assert.notDeepEqual(sampleGradient(resolved, 0).rgb, sampleGradient(resolved, 0.5).rgb);
});

test('замкнутый контур без шва даёт циклические стопы, с швом — разрыв', () => {
  const resolved = resolveGradient({ mode: 'auto' }, { palette, factionMode: 'single', factionIds: ['Доминион Терран'], closed: true });
  assert.equal(resolved.cyclic, true);
  assert.deepEqual(sampleGradient(resolved, 0).rgb, sampleGradient(resolved, 1).rgb);
  const seamed = resolveGradient({ mode: 'auto', seamVertex: 0 }, { palette, closed: true });
  assert.equal(seamed.cyclic, false);
  assert.equal(seamed.seamVertex, 0);
});

/* ----------------------------------------------------------------- каскад */

function cascadeDoc() {
  return docWith([
    {
      ...createArea({ id: 'parent', name: 'Родитель', rings: [BIG], source: 'sector' }),
      states: [state({ id: 'st-parent', mode: 'political', z: 10 })],
    },
    {
      ...createArea({ id: 'child', name: 'Ребёнок', rings: [SMALL], parentId: 'parent' }),
      states: [],
    },
  ]);
}

test('индекс областей даёт детей, корни и глубину', () => {
  const index = buildAreaIndex(cascadeDoc());
  assert.deepEqual(index.roots.map((area) => area.id), ['parent']);
  assert.deepEqual((index.childrenOf.get('parent') ?? []).map((area) => area.id), ['child']);
  assert.equal(index.depthOf.get('child'), 1);
  assert.equal(hierarchyDepth(cascadeDoc()), 1);
});

test('состояние наследуется от родителя и не рисуется дважды', () => {
  const doc = cascadeDoc();
  const cascaded = effectiveStates(doc, 'child', 'political');
  assert.equal(cascaded.length, 1);
  assert.equal(cascaded[0].inherited, true);
  assert.equal(cascaded[0].areaId, 'parent');
  assert.equal(cascaded[0].distance, 1);
  assert.equal(pickState(doc, 'child', 'political').state.id, 'st-parent');
});

test('своё состояние перекрывает унаследованное, приоритет — внутри ступени', () => {
  const doc = cascadeDoc();
  const areas = doc.areas.map((area) => (area.id === 'child'
    ? {
      ...area,
      states: [
        state({ id: 'st-low', priority: 1 }),
        state({ id: 'st-high', priority: 5 }),
      ],
    }
    : area));
  const withChild = { ...doc, areas };
  const winner = pickState(withChild, 'child', 'political');
  assert.equal(winner.state.id, 'st-high');
  assert.equal(winner.inherited, false);
  assert.equal(effectiveStates(withChild, 'child', 'political').length, 3);
});

test('глубина отсекает состояния вне диапазона видимости', () => {
  const doc = cascadeDoc();
  const narrow = {
    ...doc,
    areas: doc.areas.map((area) => (area.id === 'parent'
      ? { ...area, states: [state({ id: 'st-parent', visibleFrom: 6, visibleTo: 9 })] }
      : area)),
  };
  assert.equal(statesForLevel(narrow, 'child', 7, 'political').length, 1);
  assert.equal(statesForLevel(narrow, 'child', 3, 'political').length, 0);
  assert.equal(pickState(narrow, 'child', 'political', 3), null);
});

test('вложенность проверяется по геометрии: расхождение видно предупреждением', () => {
  const doc = cascadeDoc();
  assert.deepEqual(checkContainment(doc), []);
  const broken = {
    ...doc,
    areas: doc.areas.map((area) => (area.id === 'child'
      ? { ...area, rings: [[[8000, 8000], [8500, 8000], [8500, 8500], [8000, 8500], [8000, 8000]]] }
      : area)),
  };
  const warnings = checkContainment(broken);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('не вложена'));
});

/* ----------------------------------------------------- форс-закрашивание */

test('мазок перебивает состояние, но не разрушает его', () => {
  const doc = cascadeDoc();
  const stroke = createOverrideStroke({
    id: 'force-1',
    rings: [SMALL],
    color: '#00ff00',
    areaId: 'child',
    mode: 'political',
    note: 'тест',
  });
  const committed = commitOverride(doc, stroke);
  assert.equal(committed.overrides.length, 1);
  assert.equal(committed.events.at(-1).kind, 'override');

  const paint = resolvePaint(committed, 'child', 'political');
  assert.equal(paint.isOverride, true);
  assert.deepEqual(paint.rgb, [0, 255, 0]);
  // Исходное состояние сохранилось и доступно для отката.
  assert.equal(paint.state.id, 'st-parent');

  const removed = removeOverride(committed, 'force-1');
  assert.equal(removed.overrides.length, 0);
  assert.equal(resolvePaint(removed, 'child', 'political').isOverride, false);
});

test('мазок без привязки к области действует на все, порядок — последним', () => {
  const doc = cascadeDoc();
  const globalStroke = createOverrideStroke({ id: 'force-all', rings: [BIG], color: '#0000ff' });
  const committed = commitOverride(doc, globalStroke);
  assert.equal(overridesFor(committed, 'child', 'political').length, 1);
  assert.equal(resolvePaint(committed, 'child', 'political').isOverride, true);
  assert.equal(overrideCovers(globalStroke, 1750, 1750), true);

  const order = paintOrder(
    [
      { id: 'a', z: 50, override: false },
      { id: 'b', z: 1, override: true },
      { id: 'c', z: 10, override: false },
    ],
    (entry) => entry.z,
    (entry) => entry.override,
  );
  assert.deepEqual(order.map((entry) => entry.id), ['c', 'a', 'b']);
});

/* ----------------------------------------------------------------- журнал */

test('журнал показывает свои и унаследованные состояния и считает вес', () => {
  const doc = cascadeDoc();
  const journal = buildJournal(doc);
  assert.equal(journal.entries.length, 2);
  const child = journal.entries.find((entry) => entry.areaId === 'child');
  assert.equal(child.depth, 1);
  assert.equal(child.ownStates.length, 0);
  assert.equal(child.effectiveByMode.political.inherited, true);
  assert.equal(child.effectiveByMode.political.fromAreaId, 'parent');
  assert.equal(child.effectiveByMode.military, null);
  assert.equal(journal.weight.areas, 2);
  assert.equal(journal.weight.inheritedStates, 1);
  assert.equal(journal.weight.maxDepth, 1);
  assert.ok(journal.weight.totalVertices > 0);
});

test('фильтры журнала работают по режиму, фракции и глубине', () => {
  const doc = cascadeDoc();
  const journal = buildJournal(doc);
  assert.equal(filterJournal(journal, { mode: 'military' }).entries.length, 0);
  assert.equal(filterJournal(journal, { mode: 'political' }).entries.length, 2);
  assert.equal(filterJournal(journal, { faction: 'Доминион Терран' }).entries.length, 2);
  assert.equal(filterJournal(journal, { faction: 'Дэлаамы' }).entries.length, 0);
  assert.equal(filterJournal(journal, { level: 11 }).entries.length, 2);
  assert.equal(filterJournal(journal, { onlyInherited: true }).entries.length, 1);
  assert.equal(filterJournal(journal, { source: 'sector' }).entries.length, 1);
});

test('выгрузка журнала — простой JSON, пригодный для экспорта', () => {
  const journal = buildJournal(cascadeDoc());
  const parsed = JSON.parse(journalToJson(journal));
  assert.equal(parsed.weight.areas, 2);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].areaId, 'parent');
  assert.equal(parsed.entries[1].effectiveByMode.political.inherited, true);
});
