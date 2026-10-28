import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nearestColorStops, sampleGradient } = require('../src/atlas/sector-gradient.ts');

const anchors = [
  { id: '2', x: 10, y: 0, color: '#00FF00' },
  { id: '1', x: 0, y: 0, color: '#ff0000' },
  { id: '3', x: 100, y: 0, color: '#0000ff' },
];

test('градиент использует ближайшую пару разных цветов и не зависит от порядка', () => {
  const stops = nearestColorStops(anchors);
  assert.deepEqual(stops, [{ offset: 0, rgb: [255, 0, 0] }, { offset: 1, rgb: [0, 255, 0] }]);
  assert.deepEqual(nearestColorStops([...anchors].reverse()), stops);
  assert.deepEqual(sampleGradient(stops, 0), [255, 0, 0]);
  assert.deepEqual(sampleGradient(stops, 0.5), [128, 128, 0]);
  assert.deepEqual(sampleGradient(stops, 1), [0, 255, 0]);
  assert.deepEqual(sampleGradient(stops, -1), [255, 0, 0]);
  assert.deepEqual(sampleGradient(stops, 2), [0, 255, 0]);
});

test('кастомный цвет, совпадающие цвета и равные расстояния', () => {
  const custom = { id: '10', x: 0, y: 1, color: '#123456' };
  const tied = [{ id: '2', x: 0, y: 0, color: '#abcdef' }, custom, { id: '11', x: 0, y: -1, color: '#fedcba' }];
  const result = nearestColorStops(tied);
  assert.deepEqual(result, [{ offset: 0, rgb: [171, 205, 239] }, { offset: 1, rgb: [18, 52, 86] }]);
  assert.deepEqual(nearestColorStops(tied.reverse()), result);
  assert.deepEqual(nearestColorStops([{ ...custom }, { ...custom, id: '4', color: '#123456' }]), [
    { offset: 0, rgb: [18, 52, 86] }, { offset: 1, rgb: [18, 52, 86] },
  ]);
  assert.deepEqual(nearestColorStops([]), []);
  assert.deepEqual(sampleGradient([], 0.5), [0, 0, 0]);
  assert.throws(() => nearestColorStops([{ ...custom, color: 'red' }]), RangeError);
  assert.throws(() => nearestColorStops([custom, custom]), RangeError);
});

test('удалённый слой сетей не подключён к рендереру', () => {
  const source = readFileSync(new URL('../src/atlas/canvas-renderer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /faction-net|drawNetLayer|drawNetChannels|netPulseActive/);
  assert.match(source, /drawMarker\(primitive\)/);
});

function permutations(items) {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest]));
}

test('смешанные числовые и текстовые ID дают одинаковый результат для всех перестановок', () => {
  // Все расстояния равны с точностью до допуска: выбор определяет порядок ID.
  const tied = [
    { id: '2', x: 0, y: 0, color: '#ff0000' },
    { id: '10', x: 1, y: 0, color: '#00ff00' },
    { id: '11x', x: 0.5, y: Math.sqrt(3) / 2, color: '#0000ff' },
  ];
  const expected = [{ offset: 0, rgb: [255, 0, 0] }, { offset: 1, rgb: [0, 255, 0] }];
  for (const ordering of permutations(tied)) {
    assert.deepEqual(nearestColorStops(ordering), expected, ordering.map((anchor) => anchor.id).join(','));
  }
});

test('повторяющийся ID отклоняется независимо от порядка, даже среди смешанных ID', () => {
  const anchorsWithDuplicate = [
    { id: '2', x: 0, y: 0, color: '#ff0000' },
    { id: '10', x: 1, y: 0, color: '#00ff00' },
    { id: '11x', x: 0, y: 1, color: '#0000ff' },
    { id: '2', x: 2, y: 2, color: '#ffffff' },
  ];
  for (const ordering of permutations(anchorsWithDuplicate)) {
    assert.throws(() => nearestColorStops(ordering), /id должен быть уникальным/, ordering.map((anchor) => anchor.id).join(','));
  }
});

test('числовые ID упорядочены по значению, а совпавшие значения и текстовые — по строке', () => {
  const tied = [
    { id: '02', x: 0, y: 0, color: '#ff0000' },
    { id: '2', x: 1, y: 0, color: '#00ff00' },
    { id: '10', x: 0.5, y: Math.sqrt(3) / 2, color: '#0000ff' },
    { id: '11x', x: 50, y: 50, color: '#ffffff' },
  ];
  const expected = [{ offset: 0, rgb: [255, 0, 0] }, { offset: 1, rgb: [0, 255, 0] }];
  for (const ordering of permutations(tied)) assert.deepEqual(nearestColorStops(ordering), expected);
});

test('порядок ID разрешает только равенство: ближайшая пара остаётся ближайшей', () => {
  const items = [
    { id: '2', x: 0, y: 0, color: '#ff0000' },
    { id: '10', x: 100, y: 0, color: '#00ff00' },
    { id: '11x', x: 101, y: 0, color: '#0000ff' },
  ];
  const expected = [{ offset: 0, rgb: [0, 255, 0] }, { offset: 1, rgb: [0, 0, 255] }];
  for (const ordering of permutations(items)) assert.deepEqual(nearestColorStops(ordering), expected);
});

test('текстовые ID упорядочены по строке при равных расстояниях', () => {
  const items = [
    { id: 'z', x: 0, y: 0, color: '#ff0000' },
    { id: 'a', x: 1, y: 0, color: '#00ff00' },
    { id: 'b', x: 0.5, y: Math.sqrt(3) / 2, color: '#0000ff' },
  ];
  const expected = [{ offset: 0, rgb: [0, 255, 0] }, { offset: 1, rgb: [0, 0, 255] }];
  for (const ordering of permutations(items)) assert.deepEqual(nearestColorStops(ordering), expected);
});
