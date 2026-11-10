/* Группы областей и расширение контракта (§5 и §9 ТЗ SEC-AREAS-HIERARCHY):
 * схема v1 с необязательными `groups`/`pairs`/`contourAnchors`, валидация
 * ссылок, переименование без смены ID, удаление группы без потери областей
 * и сочетаний, обратная совместимость в обе стороны.
 *
 * Запуск: node --test tests/sector-areas-groups.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArea,
  emptySectorAreasDoc,
  parseSectorAreas,
  validateSectorAreas,
} from '../src/atlas/sector-areas-contract.ts';
import {
  addAreaToGroup,
  createGroup,
  deleteGroup,
  groupMembers,
  groupsContaining,
  nextGroupSequence,
  removeAreaFromGroup,
  renameGroup,
  setGroupAreas,
} from '../src/atlas/sector-areas-groups.ts';

const SQUARE_A = [[1000, 1000], [3000, 1000], [3000, 3000], [1000, 3000], [1000, 1000]];
const SQUARE_B = [[2000, 2000], [4000, 2000], [4000, 4000], [2000, 4000], [2000, 2000]];
const SQUARE_C = [[6000, 1000], [8000, 1000], [8000, 3000], [6000, 3000], [6000, 1000]];

function docWithAreas() {
  let doc = emptySectorAreasDoc();
  doc = { ...doc, areas: [
    createArea({ id: 'area-1', name: 'Альфа', rings: [SQUARE_A] }),
    createArea({ id: 'area-2', name: 'Бета', rings: [SQUARE_B] }),
    createArea({ id: 'area-3', name: 'Гамма', rings: [SQUARE_C] }),
  ] };
  return doc;
}

test('пустой документ содержит пустые группы и сочетания', () => {
  const doc = emptySectorAreasDoc();
  assert.deepEqual(doc.groups, []);
  assert.deepEqual(doc.pairs, []);
});

test('старый формат v1 без новых полей читается: группы и сочетания пусты', () => {
  const legacy = {
    version: 1,
    mapSize: 10000,
    modes: ['political', 'military', 'economy', 'tension'],
    experimentalModes: ['ecology', 'history'],
    areas: [{
      id: 'area-1',
      name: 'Альфа',
      parentId: null,
      address: null,
      source: 'brush',
      closed: true,
      rings: [SQUARE_A],
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
  };
  const doc = parseSectorAreas(JSON.parse(JSON.stringify(legacy)));
  assert.equal(doc.areas.length, 1);
  assert.deepEqual(doc.groups, []);
  assert.deepEqual(doc.pairs, []);
});

test('группы и сочетания проходят JSON round-trip без потерь', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { name: 'Север', areaIds: ['area-1', 'area-2'] });
  doc = {
    ...doc,
    pairs: [{
      id: 'pair-1',
      areaA: 'area-1',
      areaB: 'area-2',
      mode: 'split',
      order: 'a-over-b',
      forbidCrossing: true,
      transitionWidth: null,
      line: {
        manual: true,
        points: [[2000, 2000], [2500, 2500], [3000, 3000]],
        anchors: [
          { s: 0, point: [2000, 2000] },
          { s: 1, point: [3000, 3000] },
        ],
      },
      needsReview: false,
      note: null,
    }],
  };
  const text = JSON.stringify(doc, null, 2);
  const parsed = parseSectorAreas(text);
  assert.equal(parsed.groups?.length, 1);
  assert.equal(parsed.groups?.[0]?.name, 'Север');
  assert.equal(parsed.pairs?.length, 1);
  const pair = parsed.pairs?.[0];
  assert.equal(pair?.mode, 'split');
  assert.equal(pair?.forbidCrossing, true);
  assert.equal(pair?.line?.manual, true);
  assert.deepEqual(pair?.line?.points, [[2000, 2000], [2500, 2500], [3000, 3000]]);
  assert.deepEqual(pair?.line?.anchors, [
    { s: 0, point: [2000, 2000] },
    { s: 1, point: [3000, 3000] },
  ]);
  const again = parseSectorAreas(JSON.stringify(parsed));
  assert.deepEqual(again, parsed);
});

test('валидация: дубликат ID группы и ссылка на неизвестную область — ошибки', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { name: 'Север' });
  doc = { ...doc, groups: [
    { id: 'group-1', name: 'Север', areaIds: ['area-1'] },
    { id: 'group-1', name: 'Дубль', areaIds: ['area-404'] },
  ] };
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => message.includes('group-1') && message.includes('повторяется')));
  assert.ok(report.errors.some((message) => message.includes('area-404')));
});

test('валидация: сочетание само с собой и неизвестная область — ошибки', () => {
  let doc = docWithAreas();
  doc = {
    ...doc,
    pairs: [
      { id: 'pair-1', areaA: 'area-1', areaB: 'area-1', mode: 'split', order: 'a-over-b', forbidCrossing: false, transitionWidth: null, line: null, needsReview: false, note: null },
      { id: 'pair-2', areaA: 'area-1', areaB: 'area-404', mode: 'overlay', order: 'b-over-a', forbidCrossing: false, transitionWidth: null, line: null, needsReview: false, note: null },
    ],
  };
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => message.includes('pair-1') && message.includes('сама с собой')));
  assert.ok(report.errors.some((message) => message.includes('pair-2') && message.includes('area-404')));
});

test('валидация: пара А+Б и Б+А — предупреждение о дубликате unordered-пары', () => {
  let doc = docWithAreas();
  doc = {
    ...doc,
    pairs: [
      { id: 'pair-1', areaA: 'area-1', areaB: 'area-2', mode: 'split', order: 'a-over-b', forbidCrossing: false, transitionWidth: null, line: null, needsReview: false, note: null },
      { id: 'pair-2', areaA: 'area-2', areaB: 'area-1', mode: 'overlay', order: 'b-over-a', forbidCrossing: false, transitionWidth: null, line: null, needsReview: false, note: null },
    ],
  };
  const report = validateSectorAreas(doc);
  assert.ok(report.warnings.some((message) => message.includes('pair-1') && message.includes('pair-2')));
});

test('валидация: якоря контура вне диапазона и на несуществующем кольце — ошибки', () => {
  let doc = docWithAreas();
  doc = {
    ...doc,
    areas: doc.areas.map((area, index) => index === 0
      ? {
        ...area,
        contourAnchors: [
          { ringIndex: 0, anchors: [{ s: -0.2, point: [1000, 1000] }, { s: 0.5, point: [3000, 3000] }] },
          { ringIndex: 5, anchors: [{ s: 0.1, point: [1000, 1000] }, { s: 0.6, point: [3000, 3000] }] },
          { ringIndex: 0, anchors: [{ s: 0.7, point: [1000, 1000] }] },
        ],
      }
      : area),
  };
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => message.includes('вне 0…1')));
  assert.ok(report.errors.some((message) => message.includes('кольцо 5, которого нет')));
  assert.ok(report.errors.some((message) => message.includes('меньше двух якорей')));
});

test('создание группы: авт-ID продолжается, неизвестные области отбрасываются', () => {
  let doc = docWithAreas();
  assert.equal(nextGroupSequence(doc), 1);
  doc = createGroup(doc, { name: 'Север', areaIds: ['area-1', 'area-404', 'area-1'] });
  assert.deepEqual(doc.groups?.map((group) => group.id), ['group-1']);
  assert.deepEqual(groupMembers(doc, 'group-1'), ['area-1']);
  doc = createGroup(doc, { id: 'custom-9', name: 'Юг' });
  doc = createGroup(doc, { name: 'Запад' });
  // Номер продолжается по числовым хвостам всех ID (включая custom-9),
  // поэтому новая группа — group-10, а не group-2: повторов не возникает.
  assert.deepEqual(doc.groups?.map((group) => group.id), ['group-1', 'custom-9', 'group-10']);
  assert.equal(nextGroupSequence(doc), 11);
});

test('создание группы: дубликат ID и пустое имя отвергаются', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g', name: 'Север' });
  assert.throws(() => createGroup(doc, { id: 'g', name: 'Другая' }), RangeError);
  assert.throws(() => createGroup(doc, { name: '   ' }), RangeError);
});

test('переименование меняет имя и сохраняет ID и состав', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g-1', name: 'Старое', areaIds: ['area-2'] });
  doc = renameGroup(doc, 'g-1', 'Новое');
  assert.deepEqual(doc.groups, [{ id: 'g-1', name: 'Новое', areaIds: ['area-2'] }]);
  assert.throws(() => renameGroup(doc, 'g-404', 'Где-то'), RangeError);
  assert.throws(() => renameGroup(doc, 'g-1', ' '), RangeError);
});

test('удаление группы сохраняет области, контуры и сочетания и объясняет это', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g-1', name: 'Север', areaIds: ['area-1', 'area-2'] });
  doc = { ...doc, pairs: [
    { id: 'pair-1', areaA: 'area-1', areaB: 'area-2', mode: 'split', order: 'a-over-b', forbidCrossing: false, transitionWidth: null, line: null, needsReview: false, note: null },
  ] };
  const result = deleteGroup(doc, 'g-1');
  assert.deepEqual(result.doc.groups, []);
  assert.equal(result.doc.areas.length, 3);
  assert.equal(result.doc.pairs?.length, 1);
  assert.ok(result.notice.includes('сохранены'));
  assert.ok(result.notice.includes('pair') === false);
  assert.throws(() => deleteGroup(result.doc, 'g-1'), RangeError);
});

test('состав группы: добавить, убрать, заменить; дубликаты не копятся', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g-1', name: 'Север', areaIds: ['area-1'] });
  doc = addAreaToGroup(doc, 'g-1', 'area-2');
  doc = addAreaToGroup(doc, 'g-1', 'area-2');
  assert.deepEqual(groupMembers(doc, 'g-1'), ['area-1', 'area-2']);
  doc = removeAreaFromGroup(doc, 'g-1', 'area-1');
  assert.deepEqual(groupMembers(doc, 'g-1'), ['area-2']);
  doc = setGroupAreas(doc, 'g-1', ['area-3', 'area-404', 'area-3']);
  assert.deepEqual(groupMembers(doc, 'g-1'), ['area-3']);
  assert.throws(() => addAreaToGroup(doc, 'g-404', 'area-1'), RangeError);
});

test('группы по области: группа видна из области, несколько групп допускаются', () => {
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g-1', name: 'Север', areaIds: ['area-1'] });
  doc = createGroup(doc, { id: 'g-2', name: 'Фронт', areaIds: ['area-1', 'area-2'] });
  assert.deepEqual(groupsContaining(doc, 'area-1').map((group) => group.id), ['g-1', 'g-2']);
  assert.deepEqual(groupsContaining(doc, 'area-3').map((group) => group.id), []);
});

test('удаление области оставляет ссылку в группе видимой валидации как ошибку', () => {
  // Проверяем согласованность: состав чистится командами, но прямая правка
  // документа с «висячей» ссылкой ловится валидатором, а не теряется молча.
  let doc = docWithAreas();
  doc = createGroup(doc, { id: 'g-1', name: 'Север', areaIds: ['area-2'] });
  doc = { ...doc, areas: doc.areas.filter((area) => area.id !== 'area-2') };
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((message) => message.includes('g-1') && message.includes('area-2')));
});
