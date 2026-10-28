import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseBounds, polygonAt, pointInPolygon, distanceToRing, smoothPolyline } from '../src/atlas/sector-bounds.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

test('bounds JSON is valid and closed where required', () => {
  assert.equal(bounds.bounds.length, 4);
  for (const item of bounds.bounds.filter((entry) => entry.kind !== 'halo')) {
    assert.deepEqual(item.points[0], item.points.at(-1));
  }
});

test('point inclusion for Korhal and outside point', () => {
  const polygon = polygonAt(bounds, 'sector.outline');
  assert.ok(polygon);
  assert.equal(pointInPolygon(polygon, 5720, 6257), true);
  assert.equal(pointInPolygon(polygon, 100, 100), false);
});

test('distance to ring is zero on boundary and grows away', () => {
  const polygon = polygonAt(bounds, 'sector.outline');
  assert.ok(polygon);
  const d0 = distanceToRing(polygon, polygon[0][0], polygon[0][1]);
  const d1 = distanceToRing(polygon, polygon[0][0] - 10, polygon[0][1] - 10);
  const d2 = distanceToRing(polygon, polygon[0][0] - 20, polygon[0][1] - 20);
  assert.equal(d0, 0);
  assert.ok(d1 > d0 && d2 > d1);
});

test('closed boundaries are smoothed into a continuous closed quadratic path', () => {
  const path = smoothPolyline([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], true);
  assert.deepEqual(path.start, [0, 5]);
  assert.equal(path.curves.length, 4);
  assert.deepEqual(path.curves[0], { control: [0, 0], end: [5, 0] });
  assert.deepEqual(path.curves.at(-1)?.end, path.start);
  assert.equal(path.tail, null);
  assert.equal(path.closed, true);
});

test('open boundaries keep their endpoints while smoothing intermediate corners', () => {
  const path = smoothPolyline([[0, 0], [10, 0], [10, 10]], false);
  assert.deepEqual(path.start, [0, 0]);
  assert.deepEqual(path.curves, [{ control: [10, 0], end: [10, 5] }]);
  assert.deepEqual(path.tail, [10, 10]);
  assert.equal(path.closed, false);
});

test('malformed geometry throws Russian RangeError', () => {
  assert.throws(() => parseBounds('{"version":1,"mapSize":10000,"source":"x","bounds":[{"id":"x","kind":"sector","style":{"strokeWidth":1,"dash":[],"color":"nebula"},"label":"x","points":[[1,1],[2,2],[1,1]]}]}'), (error) => error instanceof RangeError && /Некорректные/.test(error.message));
});
