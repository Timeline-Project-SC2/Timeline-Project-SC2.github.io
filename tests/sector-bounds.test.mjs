import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseBounds, polygonAt, pointInPolygon, distanceToRing, smoothPolyline } from '../src/atlas/sector-bounds.ts';
import { clipHalo } from '../src/atlas/sector-halo-clip.ts';

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

test('реальное гало: гладкие касательные и открытые концы без замыкающего штриха', () => {
  const halo = bounds.bounds.find((item) => item.kind === 'halo');
  assert.ok(halo);
  assert.ok(halo.style.dash.length > 0);
  const path = smoothPolyline(halo.points, false);
  assert.equal(path.closed, false);
  assert.deepEqual(path.start, halo.points[0]);
  assert.deepEqual(path.tail, halo.points.at(-1));
  for (let i = 1; i < path.curves.length; i++) {
    const previous = path.curves[i - 1];
    const current = path.curves[i];
    const a = [previous.end[0] - previous.control[0], previous.end[1] - previous.control[1]];
    const b = [current.control[0] - previous.end[0], current.control[1] - previous.end[1]];
    assert.ok(Math.abs(a[0] * b[1] - a[1] * b[0]) < 1e-8, `стык ${i} имеет излом`);
    assert.ok(a[0] * b[0] + a[1] * b[1] > 0, `стык ${i} меняет направление`);
  }
});

test('обрезка длинного гало сохраняет фазу штрихов и ограничивает длину пути', () => {
  for (const pan of [-50, 0, 13, 100]) {
    const start = -1000000 + pan;
    const path = smoothPolyline([[start, 100], [1000000 + pan, 100]], false);
    const runs = clipHalo(path, 300, 200);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.ok(Math.abs(run.offset - (run.start[0] - start)) < 1e-7);
    assert.ok(run.curves.length < 10);
    assert.ok(run.curves.at(-1).end[0] - run.start[0] < 4000);
    // Один и тот же экранный x соответствует одной и той же позиции штриха.
    assert.ok(Math.abs((run.offset + 150 - run.start[0]) - (150 - start)) < 1e-7);
  }
});
