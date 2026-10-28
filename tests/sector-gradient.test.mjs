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
