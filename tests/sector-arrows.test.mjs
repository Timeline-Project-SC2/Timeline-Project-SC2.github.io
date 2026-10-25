import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectSectorArrows } = require('../src/atlas/sector-arrows.ts');

function point(id, name, distance, deg) {
  const angle = deg * Math.PI / 180;
  return { id, name, x: distance * Math.cos(angle), y: distance * Math.sin(angle) };
}
function worldPoint(id, name, x, y) { return { id, name, x, y }; }

// Координаты data/systems.csv относительно Корхала (5720, 6257).
const golden = [
  worldPoint('raidin', 'Райдин', -64, 61),
  worldPoint('mistaff', 'Мистафф', 29, -86),
  worldPoint('jontur', 'Джонтур', -5, 108),
  worldPoint('norris', 'Норрис', 114, 23),
  worldPoint('dorian', 'Дориан', -102, -57),
];

test('golden для Корхала L4: пять систем ранжируются по расстоянию и углу', () => {
  const result = selectSectorArrows(golden, 0, 0);
  assert.deepEqual(result.arrows.map((item) => item.name), ['Райдин', 'Мистафф', 'Джонтур', 'Норрис', 'Дориан']);
  assert.deepEqual(result.arrows.map((item) => Math.round(item.distance * 10) / 10), [88.4, 90.8, 108.1, 116.3, 116.8]);
  const angles = result.arrows.map((item) => Math.round(item.angle * 1800 / Math.PI) / 10);
  assert.deepEqual(angles, [136.4, -71.4, 92.7, 11.4, -150.8]);
  assert.equal(result.omitted, 0);
});

test('расстояния до 0,5 px отсекаются; подавленные углы учитываются в счётчике', () => {
  const candidates = [
    { id: 'center', name: 'центр', x: 0.5, y: 0 },
    point('a', 'А', 1, 0), point('b', 'Б', 2, 10), point('c', 'В', 3, 40),
    point('d', 'Г', 4, 80), point('e', 'Д', 5, 120), point('f', 'Е', 6, 160),
    point('g', 'Ж', 7, -160), point('h', 'З', 8, -120), point('i', 'И', 9, -80), point('j', 'К', 10, -40),
  ];
  const result = selectSectorArrows(candidates, 0, 0);
  assert.equal(result.arrows.length, 5);
  assert.equal(result.omitted, 5);
  assert.equal(result.nextDistance, 10);
});

test('набор Слейна оставляет четыре направления и счётчик шести отсечённых', () => {
  const slane = [
    point('a', 'А', 88.4, 0), point('b', 'Б', 90.8, 5), point('c', 'В', 108, 90),
    point('d', 'Г', 116, 95), point('e', 'Д', 117, 180), point('f', 'Е', 130, 185),
    point('g', 'Ж', 150, 270), point('h', 'З', 160, 275), point('i', 'И', 2152, 10),
    point('j', 'К', 2152, -5),
  ];
  const result = selectSectorArrows(slane, 0, 0);
  assert.equal(result.arrows.length, 4);
  assert.equal(result.omitted, 6);
  assert.equal(result.nextDistance, 2152);
});

test('видимость сохраняется как состояние цели, но не меняет расстояние ранжирования', () => {
  const result = selectSectorArrows(golden, 0, 0, (system) => system.id === 'mistaff');
  assert.equal(result.arrows[1].visible, true);
  assert.equal(result.arrows[0].visible, false);
});
