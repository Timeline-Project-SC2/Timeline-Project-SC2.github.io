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
  areaFillBBox,
  distanceToAreaFillBoundary,
  distanceToRing,
  distanceToStroke,
  parametrize,
  pointAt,
  pointHitsArea,
  pointInArea,
  pointInAreaFill,
  pointInRing,
  pointInStroke,
  positiveContourRingsOf,
  ringArea,
  ringCentroid,
  ringContainsRing,
  ringLength,
  selfIntersections,
  simplify,
  simplifyStroke,
  smooth,
  strokeArea,
  strokeCentroid,
  strokeLength,
  strokesArea,
  strokeVertices,
  totalVertices,
} from '../src/atlas/sector-areas-geometry.ts';
import {
  displayedGridEdgesFor,
  displayedGridTierFor,
  gridEdgesForTierInBounds,
} from '../src/atlas/sector-scene.ts';
import {
  SNAP_COST_REL_TOLERANCE,
  SNAP_DIRECTION_HALF_WINDOW_CELLS,
  SNAP_DIRECTION_WEIGHT,
  compareGridEdgeKey,
  evaluateGridEdgeCost,
  pickBestGridEdge,
  snapPointToTierGrid,
  snapStrokeToDisplayedGrid,
  snapStrokeToEdges,
  snapStrokeToTierGrid,
} from '../src/atlas/sector-areas-snap.ts';
import {
  MODULE_RELATIONS,
  RELATION_KIND_TITLES,
  SECTOR_MODULES,
  isolatedModuleIds,
  relationsForModule,
} from '../src/atlas/sector-areas-registry.ts';
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
  assert.equal(doc.version, 2);
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

/* ------------------------------------------- привязка к рёбрам адресной сетки */

test('отображаемый ярус сетки: nested при видимости, иначе primary', () => {
  // Кадр 1000×800, видимая ширина 2000 → scale = 0,5 px/ед.:
  // T2 (400 * 0,5 = 200 px ≤ 450 px) — primary, T3 (80 * 0,5 = 40 px ≥ 16 px) — nested.
  const withNested = displayedGridTierFor(
    { w: 1000, h: 800 },
    { centerX: 5000, centerY: 5000, visibleWidth: 2000 },
  );
  assert.deepEqual(withNested, { role: 'nested', tier: 3, id: 'T3', cellSize: 80 });

  // Кадр 220×220, видимая ширина 10000 → scale = 0,022 px/ед.:
  // T1 (2000 * 0,022 = 44 px ≤ 450 px) — primary, а T2 (400 * 0,022 = 8,8 px < 16 px) скрыт!
  const onlyPrimary = displayedGridTierFor(
    { w: 220, h: 220 },
    { centerX: 5000, centerY: 5000, visibleWidth: 10000 },
  );
  assert.deepEqual(onlyPrimary, { role: 'primary', tier: 1, id: 'T1', cellSize: 2000 });

  const world = displayedGridEdgesFor(
    { w: 220, h: 220 },
    { centerX: 5000, centerY: 5000, visibleWidth: 10000 },
    { x0: 0, y0: 0, x1: 2000, y1: 2000 },
  );
  assert.equal(world.tier?.id, 'T1');
  assert.ok(world.edges.length >= 4);
});

test('снап: прямое ребро и переход на соседние рёбра без запирания в одной ячейке', () => {
  assert.equal(SNAP_DIRECTION_WEIGHT, 0.25);
  assert.equal(SNAP_COST_REL_TOLERANCE, 1e-9);
  assert.equal(SNAP_DIRECTION_HALF_WINDOW_CELLS, 0.125);

  const tier = { role: 'primary', tier: 2, id: 'T2', cellSize: 400 };

  // Прямое горизонтальное ребро внутри одной ячейки.
  const singleEdge = snapStrokeToTierGrid([[60, 392], [340, 395]], tier, { closed: false });
  assert.deepEqual(singleEdge.points, [[60, 400], [340, 400]]);
  assert.equal(singleEdge.runs.length, 1);
  assert.equal(singleEdge.runs[0].edge.orientation, 'horizontal');
  assert.equal(singleEdge.runs[0].edge.row, 1);
  assert.equal(singleEdge.runs[0].edge.col, 0);

  // Продолжение вдоль прямой через три соседние ячейки (col = 0 → 1 → 2).
  const acrossCells = snapStrokeToTierGrid([[60, 392], [920, 396]], tier, { closed: false });
  assert.deepEqual(acrossCells.points, [[60, 400], [920, 400]]);
  assert.deepEqual(
    acrossCells.runs.map((run) => [run.edge.row, run.edge.col, run.edge.orientation]),
    [
      [1, 0, 'horizontal'],
      [1, 1, 'horizontal'],
      [1, 2, 'horizontal'],
    ],
  );
});

test('снап: поворот около 90° начинает новый локальный сегмент через узел сетки', () => {
  const tier = { role: 'primary', tier: 2, id: 'T2', cellSize: 400 };
  // Эскиз слегка перелетает угол (400, 400) до x = 412 и поворачивает вниз к (412, 740).
  const turned = snapStrokeToTierGrid(
    [[60, 390], [412, 390], [412, 740]],
    tier,
    { closed: false },
  );
  assert.deepEqual(turned.points, [[60, 400], [400, 400], [400, 740]]);
  // Контур не выпрямлен в одну длинную сторону и не дотянут до 800.
  assert.equal(turned.points.at(-1)[1], 740);
});

test('снап: контур с несколькими поворотами и непрямоугольный замкнутый контур', () => {
  const tier = { role: 'primary', tier: 2, id: 'T2', cellSize: 400 };

  // Ступенчатая открытая ломаная с тремя поворотами по разным ячейкам.
  const stairs = snapStrokeToTierGrid(
    [
      [50, 392],
      [408, 392],
      [408, 792],
      [808, 792],
      [808, 1140],
    ],
    tier,
    { closed: false },
  );
  assert.deepEqual(stairs.points, [
    [50, 400],
    [400, 400],
    [400, 800],
    [800, 800],
    [800, 1140],
  ]);

  // Замкнутая Г-образная фигура на нескольких ячейках не превращается в один прямоугольник.
  const lShape = snapStrokeToTierGrid(
    [
      [15, 12],
      [788, 14],
      [790, 392],
      [392, 392],
      [392, 788],
      [14, 790],
    ],
    tier,
    { closed: true },
  );
  assert.deepEqual(lShape.points, [
    [0, 0],
    [800, 0],
    [800, 400],
    [400, 400],
    [400, 800],
    [0, 800],
  ]);
});

test('снап: дальнее ребро выигрывает строго тогда, когда это даёт формула цены', () => {
  const s = 100;
  // Ближнее ребро перпендикулярно движению (вертикальное x = 10, d₁ = 10, |u·t| = 0):
  // C_near = 10² + 0,25 · 100² · (1 − 0)² = 100 + 2500 = 2600.
  const nearPerpendicular = {
    tier: 3,
    row: 0,
    col: 0,
    orientation: 'vertical',
    cellSize: s,
    x1: 10,
    y1: 0,
    x2: 10,
    y2: 100,
  };

  // Дальнее сонаправленное ребро на d₂ = 45 (|u·t| = 1): C_far = 45² + 0 = 2025 < 2600 → выигрывает!
  const farWinning = {
    tier: 3,
    row: 1,
    col: 0,
    orientation: 'horizontal',
    cellSize: s,
    x1: 0,
    y1: 45,
    x2: 100,
    y2: 45,
  };
  const winEval = pickBestGridEdge([20, 0], [1, 0], [nearPerpendicular, farWinning]);
  assert.equal(winEval.edge, farWinning);
  assert.equal(evaluateGridEdgeCost([20, 0], [1, 0], nearPerpendicular).cost, 2600);
  assert.equal(evaluateGridEdgeCost([20, 0], [1, 0], farWinning).cost, 2025);

  // То же сонаправленное ребро на d₂ = 55: C_far = 55² = 3025 > 2600 → выигрывает ближнее!
  const farLosing = {
    ...farWinning,
    y1: 55,
    y2: 55,
  };
  const loseEval = pickBestGridEdge([20, 0], [1, 0], [nearPerpendicular, farLosing]);
  assert.equal(loseEval.edge, nearPerpendicular);

  // Порога максимальной дальности нет: единственный кандидат в 3000 единицах всё равно выбирается.
  const veryFar = {
    tier: 3,
    row: 30,
    col: 30,
    orientation: 'horizontal',
    cellSize: 80,
    x1: 2400,
    y1: 2400,
    x2: 2480,
    y2: 2400,
  };
  const unrestricted = pickBestGridEdge([100, 100], [1, 0], [veryFar]);
  assert.equal(unrestricted.edge, veryFar);
  assert.deepEqual(unrestricted.snappedPoint, [2400, 2400]);
});

test('снап: при равной цене кандидат выбирается детерминированно по (tier, row, col, orientation)', () => {
  // Точка (200, 200) в центре ячейки 400×400 при диагональном направлении (1, 1)/√2:
  // все четыре стороны ячейки (row=0 horiz, row=1 horiz, col=0 vert, col=1 vert) имеют абсолютно равную цену!
  const edges = gridEdgesForTierInBounds(2, { x0: 0, y0: 0, x1: 400, y1: 400 });
  const cellEdges = edges.filter((edge) => (
    (edge.orientation === 'horizontal' && edge.col === 0 && (edge.row === 0 || edge.row === 1))
    || (edge.orientation === 'vertical' && edge.row === 0 && (edge.col === 0 || edge.col === 1))
  ));
  assert.equal(cellEdges.length, 4);

  const forward = pickBestGridEdge([200, 200], [1, 1], cellEdges);
  const reversed = pickBestGridEdge([200, 200], [1, 1], [...cellEdges].reverse());
  assert.deepEqual(
    [forward.edge.tier, forward.edge.row, forward.edge.col, forward.edge.orientation],
    [2, 0, 0, 'horizontal'],
  );
  assert.deepEqual(reversed.edge, forward.edge, 'порядок входного массива не меняет победителя');

  // При совпадении (tier, row, col) horizontal строго раньше vertical.
  const hEdge = cellEdges.find((e) => e.row === 0 && e.col === 0 && e.orientation === 'horizontal');
  const vEdge = cellEdges.find((e) => e.row === 0 && e.col === 0 && e.orientation === 'vertical');
  assert.ok(compareGridEdgeKey(hEdge, vEdge) < 0);
  const cornerTie = pickBestGridEdge([0, 0], [1, 1], [vEdge, hEdge]);
  assert.equal(cornerTie.edge.orientation, 'horizontal');
});

test('снап: границы карты 0 и 10000 обрабатываются точно на любом ярусе вплоть до T7', () => {
  // Левый верхний край карты (0, 0) и правый нижний край (10000, 10000) на мельчайшем ярусе T7 (s = 0,128).
  const topBorder = snapPointToTierGrid([-5, 0.01], [1, 0], 7, 0.128);
  assert.deepEqual(topBorder.snappedPoint, [0, 0]);
  assert.equal(topBorder.edge.row, 0);
  assert.equal(topBorder.edge.col, 0);
  assert.equal(topBorder.edge.orientation, 'horizontal');

  const rightBorder = snapPointToTierGrid([10005, 9999.95], [0, 1], 7, 0.128);
  assert.equal(rightBorder.snappedPoint[0], 10000);
  assert.ok(Math.abs(rightBorder.snappedPoint[1] - 9999.95) < 1e-6);
  assert.equal(rightBorder.edge.orientation, 'vertical');
  assert.equal(rightBorder.edge.x1, 10000);

  // Отображаемая сетка в кадре привязывает штрих вдоль верхней границы карты y = 0.
  const borderStroke = snapStrokeToDisplayedGrid(
    [[20, 3], [350, 2]],
    { w: 1000, h: 800 },
    { centerX: 500, centerY: 500, visibleWidth: 2000 },
    { closed: false },
  );
  assert.equal(borderStroke.tier?.id, 'T3');
  assert.deepEqual(borderStroke.points, [[20, 0], [350, 0]]);

  // Для пустого списка кандидатов исходный штрих остаётся целым.
  assert.deepEqual(snapStrokeToEdges([[10, 20], [30, 40]], []).points, [[10, 20], [30, 40]]);
});

/* ------------------------------------------- отдельные штрихи и граф реестра */

test('старый документ без strokes читается с пустым списком, новые штрихи не смешиваются с rings и дырками', () => {
  // Старый JSON без поля strokes: версия схемы остаётся 1, strokes === [].
  const legacyRaw = JSON.stringify({
    version: 1,
    mapSize: 10000,
    modes: ['political', 'military', 'economy', 'tension'],
    experimentalModes: ['ecology', 'history'],
    areas: [{
      id: 'legacy-1',
      name: 'Старая с дыркой',
      parentId: null,
      address: null,
      source: 'brush',
      closed: true,
      rings: [BIG, SMALL],
      states: [],
      scopeId: null,
      location: null,
      detail: null,
      distance: null,
      band: null,
      events: [],
    }],
    overrides: [],
    events: [],
  });
  const parsedLegacy = parseSectorAreas(legacyRaw);
  assert.equal(parsedLegacy.version, 2, 'документ v1 автоматически мигрирует в актуальную схему v2');
  assert.deepEqual(parsedLegacy.areas[0].strokes, []);
  // Смысл rings и отверстий сохранён: внутри дырки SMALL точка не принадлежит кольцам.
  assert.equal(pointInArea(parsedLegacy.areas[0], 1750, 1750), false);
  assert.equal(pointInArea(parsedLegacy.areas[0], 1200, 1200), true);

  // Добавляем отдельные штрихи в ту же область: rings и дырка остаются нетронутыми.
  const openStroke = { id: 's-open', points: [[5000, 5000], [5600, 5000]], closed: false };
  const closedStroke = { id: 's-closed', points: [[6000, 6000], [6400, 6000], [6400, 6400], [6000, 6400]], closed: true };
  const withStrokes = parseSectorAreas(JSON.stringify({
    ...parsedLegacy,
    areas: [{ ...parsedLegacy.areas[0], strokes: [openStroke, closedStroke] }],
  }));
  const area = withStrokes.areas[0];
  assert.equal(area.rings.length, 2, 'кольцо и дырка не изменились');
  assert.equal(area.strokes.length, 2);
  assert.equal(pointInArea(area, 1750, 1750), false, 'дырка по-прежнему исключена');
  assert.equal(pointInStroke(closedStroke, 6200, 6200), true);
  assert.equal(pointInStroke(openStroke, 5300, 5005, 10), true);
  assert.equal(pointHitsArea(area, 6200, 6200, 10), true);
  assert.equal(strokeLength(openStroke), 600);
  assert.equal(strokeArea(openStroke), 0);
  assert.equal(strokeArea(closedStroke), 160000);
  assert.equal(strokesArea(area.strokes), 160000);
  assert.deepEqual(strokeCentroid(closedStroke), [6200, 6200]);
  assert.equal(distanceToStroke(openStroke, 5300, 5015), 15);
  assert.equal(strokeVertices(area), 6);
  assert.equal(totalVertices(area), BIG.length + SMALL.length, 'totalVertices считает только rings');
  assert.ok(simplifyStroke(closedStroke, 1, 1).points.length >= 4);
  assert.deepEqual(validateSectorAreas(withStrokes).errors, []);
});

test('валидатор ловит повторяющиеся ID и вырожденные замкнутые штрихи', () => {
  const badArea = createArea({
    id: 'a-bad',
    name: 'Проблемная',
    rings: [],
    strokes: [
      { id: 'dup', points: [[100, 100], [200, 100]], closed: true },
      { id: 'dup', points: [[300, 300], [400, 300]], closed: false },
    ],
  });
  const report = validateSectorAreas(docWith([badArea]));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((msg) => msg.includes('повторяется')));
  assert.ok(report.errors.some((msg) => msg.includes('минимум 3 вершин')));
});

test('граф модулей содержит только подтверждённые импортами связи и допускает изолированный узел', async () => {
  const ids = new Set(SECTOR_MODULES.map((m) => m.id));
  const sourceById = new Map(SECTOR_MODULES.map((m) => [m.id, m.source]));
  const kinds = new Set(MODULE_RELATIONS.map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ['data', 'order', 'spatial']);

  for (const relation of MODULE_RELATIONS) {
    assert.ok(ids.has(relation.from), `неизвестный источник связи: ${relation.from}`);
    assert.ok(ids.has(relation.to), `неизвестный приёмник связи: ${relation.to}`);
    assert.notEqual(relation.from, relation.to, 'модуль не должен ссылаться сам на себя');
    assert.ok(RELATION_KIND_TITLES[relation.kind]);
    assert.ok(relation.note.length > 15);

    // Каждая связь обязана подтверждаться реальным импортом в исходном коде приёмника.
    const toSource = await readFile(new URL(`../${sourceById.get(relation.to)}`, import.meta.url), 'utf8');
    const fromFile = sourceById.get(relation.from).split('/').pop();
    assert.ok(
      toSource.includes(`./${fromFile}`),
      `связь ${relation.from} -> ${relation.to} не подтверждена импортом ./${fromFile}`,
    );
  }

  // Пограничный мир не импортируется другими модулями реестра и сам их не импортирует — остаётся отдельным узлом.
  assert.ok(isolatedModuleIds().includes('sector-areas-border-world'));
  const borderRel = relationsForModule('sector-areas-border-world');
  assert.equal(borderRel.incoming.length, 0);
  assert.equal(borderRel.outgoing.length, 0);
});

test('схема v2 и геометрия заливки: миграция v1 -> v2, дырки, замкнутые и открытые штрихи', () => {
  const migrated = parseSectorAreas({
    version: 1,
    mapSize: 10000,
    modes: ['political', 'military', 'economy', 'tension'],
    experimentalModes: ['ecology', 'history'],
    areas: [
      createArea({
        id: 'a-v1',
        name: 'Смешанная',
        rings: [BIG, [[1800, 1800], [2400, 1800], [2400, 2400], [1800, 2400], [1800, 1800]]],
        strokes: [
          { id: 'st-closed', points: [[5000, 1000], [6000, 1000], [6000, 2000], [5000, 2000]], closed: true },
          { id: 'st-open', points: [[7000, 7000], [8000, 7000]], closed: false },
        ],
      }),
    ],
    overrides: [],
    events: [],
    pairs: [{
      id: 'p-1',
      areaA: 'a-v1',
      areaB: 'a-v1',
      mode: 'split',
      order: 'a-over-b',
      forbidCrossing: false,
      transitionWidth: null,
      line: null,
      extraLines: [{
        manual: true,
        points: [[5100, 1100], [5900, 1900]],
        anchors: [{ s: 0, point: [5100, 1100] }, { s: 1, point: [5900, 1900] }],
      }],
      needsReview: false,
      note: null,
    }],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.pairs[0].extraLines.length, 1);
  const roundTrip = parseSectorAreas(JSON.stringify(migrated));
  assert.equal(roundTrip.version, 2);
  assert.equal(roundTrip.pairs[0].extraLines[0].points.length, 2);

  const area = migrated.areas[0];
  assert.equal(positiveContourRingsOf(area).length, 2, 'учитываются внешнее кольцо и замкнутый штрих');
  assert.equal(pointInAreaFill(area, 1300, 1300), true);
  assert.equal(pointInAreaFill(area, 2000, 2000), false, 'дырка исключена из заливки');
  assert.equal(pointInAreaFill(area, 5500, 1500), true, 'замкнутый штрих входит в заливку');
  assert.equal(pointInAreaFill(area, 7500, 7000), false, 'открытый штрих не входит в заливку');
  const fillBox = areaFillBBox(area);
  assert.deepEqual(fillBox, { minX: 1000, minY: 1000, maxX: 6000, maxY: 4000 });
  assert.equal(distanceToAreaFillBoundary(area, 5500, 1500), 500);
});
