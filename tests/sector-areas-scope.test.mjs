/* Области действия кисти (часть 3 плана §2–§5): адаптеры существующих границ,
 * принадлежность, детализация и правила пересечения scope.
 *
 * Scope — маска и референс, а не разбиение данных: геометрия области остаётся
 * в мировых координатах. Проверяется, что адаптер не изобретает геометрию,
 * линия гало даёт `unknown`, дополнение «вне сектора» инвертирует принадлежность,
 * а конфликт двух scope без правила остаётся неразрешённым (предупреждение).
 * Запуск: node --test tests/sector-areas-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseBounds } from '../src/atlas/sector-bounds.ts';
import { createArea } from '../src/atlas/sector-areas-contract.ts';
import {
  DEFAULT_BORDER_DISTANCE,
  DEFAULT_CORE_DISTANCE,
  addDetail,
  classifyArea,
  classifyLocation,
  createDetailSet,
  createScope,
  distanceToScope,
  dominanceFor,
  isInside,
  outsideScopeOf,
  removeDetail,
  renameDetail,
  resolveDominance,
  scopeConflicts,
  scopeCrossings,
  scopesFromBounds,
} from '../src/atlas/sector-areas-scope.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));
const scopes = scopesFromBounds(bounds);
const sectorScope = scopes.find((scope) => scope.id === 'sector.outline');
const haloScope = scopes.find((scope) => scope.id === 'halo.dashed');

const SQUARE = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
const areaAt = (id, x0, y0, size) => createArea({
  id,
  name: id,
  rings: [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]],
});

test('адаптер превращает границы сектора в scope, не меняя исходники', () => {
  assert.equal(scopes.length, bounds.bounds.length);
  assert.equal(sectorScope.kind, 'sector');
  assert.equal(sectorScope.rings.length, 1);
  assert.equal(scopes.filter((scope) => scope.kind === 'nebula').length, 2);
  assert.equal(sectorScope.source, 'data/sector-bounds.json');
  // Исходная геометрия не копируется в scope как новый владелец.
  assert.deepEqual(sectorScope.rings[0], bounds.bounds.find((item) => item.id === 'sector.outline').points);
});

test('линия гало площади не имеет: принадлежность не вычисляется', () => {
  assert.equal(haloScope.kind, 'custom');
  assert.deepEqual(haloScope.rings, []);
  assert.equal(isInside(haloScope, 5720, 6257), null);
  assert.equal(distanceToScope(haloScope, 5720, 6257), Infinity);
  assert.equal(classifyArea(haloScope, areaAt('a', 100, 100, 50)), 'unknown');
});

test('принадлежность scope считается по кольцу с дырками', () => {
  assert.equal(isInside(sectorScope, 5720, 6257), true);
  assert.equal(isInside(sectorScope, 100, 100), false);
  const withHole = createScope({
    id: 'donut',
    kind: 'custom',
    label: 'Кольцо',
    rings: [SQUARE, [[400, 400], [600, 400], [600, 600], [400, 600], [400, 400]]],
  });
  assert.equal(isInside(withHole, 100, 100), true);
  assert.equal(isInside(withHole, 500, 500), false);
});

test('scope-дополнение «вне сектора» инвертирует принадлежность', () => {
  const outside = outsideScopeOf(sectorScope);
  assert.equal(outside.kind, 'outside');
  assert.equal(outside.complement, true);
  assert.equal(isInside(outside, 100, 100), true);
  assert.equal(isInside(outside, 5720, 6257), false);
});

test('расстояние до границы scope: ноль на контуре и рост от него', () => {
  const point = sectorScope.rings[0][0];
  assert.equal(distanceToScope(sectorScope, point[0], point[1]), 0);
  const near = distanceToScope(sectorScope, point[0] + 10, point[1] + 10);
  const far = distanceToScope(sectorScope, point[0] + 40, point[1] + 40);
  assert.ok(near > 0 && far > near);
});

test('детализация: core, inside, border и outside по расстоянию до границы', () => {
  const scope = createScope({ id: 'square', kind: 'custom', label: 'Квадрат', rings: [SQUARE] });
  assert.equal(classifyArea(scope, areaAt('центр', 400, 400, 200)), 'core');
  assert.equal(classifyArea(scope, areaAt('внутри', 50, 50, 100)), 'inside');
  assert.equal(classifyArea(scope, areaAt('у границы', 10, 10, 30)), 'border');
  assert.equal(classifyArea(scope, areaAt('снаружи', 1100, 1100, 100)), 'outside');
  assert.equal(classifyArea(scope, areaAt('снаружи рядом', 1010, 1010, 30)), 'border');
  // Пороги — настройка, а не константа модуля.
  assert.equal(classifyLocation(scope, [[400, 400], [600, 400], [600, 600], [400, 600]], true, { coreDistance: 1000 }), 'inside');
  assert.equal(DEFAULT_BORDER_DISTANCE, 50);
  assert.equal(DEFAULT_CORE_DISTANCE, 200);
});

test('полоса пограничного мира вытесняет обычную детализацию', () => {
  const scope = createScope({ id: 'square', kind: 'custom', label: 'Квадрат', rings: [SQUARE] });
  const banded = classifyArea(scope, areaAt('полоса', 400, 400, 200), {
    bandOf: (x, y) => (x > 0 ? 'b1' : null),
  });
  assert.equal(banded, 'band');
  const plain = classifyArea(scope, areaAt('без полосы', 400, 400, 200), {
    bandOf: () => null,
  });
  assert.equal(plain, 'core');
});

test('пересечение scope — предупреждение, а не запрет', () => {
  const scope = createScope({ id: 'square', kind: 'custom', label: 'Квадрат', rings: [SQUARE] });
  const crossing = areaAt('через границу', 900, 900, 200);
  const crossings = scopeCrossings(crossing, [scope]);
  assert.equal(crossings.length, 1);
  assert.ok(crossings[0].share > 0 && crossings[0].share < 1);
  assert.equal(crossings[0].crossing, true);
  assert.equal(scopeCrossings(areaAt('внутри', 100, 100, 100), [scope])[0].crossing, false);
  assert.deepEqual(scopeCrossings(createArea({ id: 'пусто', name: 'пусто', rings: [] }), [scope]), []);
});

test('правила пар: явное главенство, порядок списка и «на равных»', () => {
  const rules = [
    { a: 'sector.outline', b: 'nebula.lost-signals', dominance: 'a' },
    { a: 'nebula.fog-echos', b: 'nebula.lost-signals', dominance: 'equal' },
  ];
  assert.equal(dominanceFor(rules, 'sector.outline', 'nebula.lost-signals'), 'a');
  // Правило симметрично: обратный порядок сторон разворачивает ответ.
  assert.equal(dominanceFor(rules, 'nebula.lost-signals', 'sector.outline'), 'b');
  assert.equal(dominanceFor(rules, 'nebula.lost-signals', 'nebula.fog-echos'), 'equal');
  assert.equal(dominanceFor(rules, 'sector.outline', 'нет'), null);

  const order = ['nebula.lost-signals', 'sector.outline'];
  assert.equal(resolveDominance(rules, order, 'sector.outline', 'nebula.lost-signals'), 'a');
  // Без правила работает порядок списка (drag-and-drop): выше — главнее.
  assert.equal(resolveDominance([], order, 'nebula.lost-signals', 'sector.outline'), 'a');
  assert.equal(resolveDominance([], order, 'sector.outline', 'nebula.lost-signals'), 'b');
  // Нет ни правила, ни порядка — безопасный режим «оба сохраняются».
  assert.equal(resolveDominance([], [], 'sector.outline', 'nebula.lost-signals'), null);
});

test('конфликты областей собираются парами с решением', () => {
  const first = createScope({ id: 's1', kind: 'custom', label: 'Первый', rings: [SQUARE] });
  const second = createScope({ id: 's2', kind: 'custom', label: 'Второй', rings: [[[500, 500], [1500, 500], [1500, 1500], [500, 1500], [500, 500]]] });
  const area = areaAt('пересечение', 400, 400, 400);
  const conflicts = scopeConflicts([area], [first, second]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual([conflicts[0].a, conflicts[0].b], ['s1', 's2']);
  assert.equal(conflicts[0].dominance, 'a');
  assert.equal(scopeConflicts([area], [first, second], [{ a: 's2', b: 's1', dominance: 'b' }])[0].dominance, 'a');
  assert.equal(scopeConflicts([areaAt('далеко', 4000, 4000, 100)], [first, second]).length, 0);
});

test('набор детализации редактируется глобально, band удаляется с пометкой', () => {
  const base = createDetailSet(['inside', 'outside', 'border', 'core', 'band', 'unknown']);
  assert.equal(base.has('band'), true);
  const extended = addDetail(base, 'rim');
  assert.equal(extended.has('rim'), true);
  assert.equal(base.has('rim'), false);
  const renamed = renameDetail(extended, 'rim', 'кромка');
  assert.equal(renamed.has('кромка'), true);
  assert.equal(renamed.has('rim'), false);

  const withoutBand = removeDetail(renamed, 'band');
  assert.equal(withoutBand.removedBand, true);
  assert.equal(withoutBand.set.has('band'), false);
  const withoutRim = removeDetail(renamed, 'rim');
  assert.equal(withoutRim.removedBand, false);
});
