import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const flight = require('../src/atlas/sector-flight.ts');

test('длительность полёта следует матрице §6.4 с жёстким верхним пределом', () => {
  const expected = [760, 840, 920, 1000, 1080, 1160, 1240, 1320, 1400, 1480];
  for (let delta = 0; delta <= 9; delta++) assert.equal(flight.flightDuration(delta), expected[delta]);
  assert.equal(flight.flightDuration(10), 1500);
  assert.throws(() => flight.flightDuration(-1), RangeError);
});

test('планы клика и стрелки достигают L9 и используют абсолютную разницу уровней', () => {
  const start = { x: 500, y: 600, level: 4 };
  const target = { x: 700, y: 800, level: 9, id: 'goal' };
  const click = flight.planClickFlight(start, target);
  const arrow = flight.planArrowTrip({ x: 0, y: 0, level: 2 }, target);
  assert.deepEqual([click.delta, click.duration, click.targetScaleLevel], [5, 1160, 9]);
  assert.deepEqual([arrow.delta, arrow.duration], [7, 1320]);
  assert.equal(click.to.id, 'goal');
});

test('фазовые интервалы покрывают anticipation, рамку и settle без выхода за пределы', () => {
  assert.equal(flight.FLIGHT_TIMING.anticipation, 140);
  assert.equal(flight.FLIGHT_TIMING.frameEnd, 380);
  assert.equal(flight.FLIGHT_TIMING.settle, 120);
  assert.equal(flight.FLIGHT_TIMING.max, 1500);
});
