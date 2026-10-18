'use strict';

var assert = require('node:assert/strict');
var planner = require('../site/shared/travel-planner.js');

assert.equal(planner.LIGHT_YEARS_PER_MAP_UNIT, 1);
assert.equal(planner.parseSpeed('100,5'), 100.5);
assert.equal(planner.parseSpeed('1 000'), 1000);
assert.equal(planner.parseSpeed('0.1'), 0.1);
assert.equal(planner.parseSpeed('+25'), 25);
assert.equal(planner.parseSpeed('0'), null);
assert.equal(planner.parseSpeed('-1'), null);
assert.equal(planner.parseSpeed('10abc'), null);
assert.equal(planner.parseSpeed('Infinity'), null);

var a = { id: 'a', name: 'A', coord: [0, 0, 999] };
var b = { id: 'b', name: 'B', coord: [3, 4, -999] };
var c = { id: 'c', name: 'C', coord: [3, 8] };
var route = planner.calculate([a, b, c], 100, true);
assert.equal(route.forwardLegs.length, 2);
assert.equal(route.returnLegs.length, 2);
assert.equal(route.forwardLegs[0].distanceLy, 5, 'Z must not affect 2D distance');
assert.equal(route.forwardLegs[0].hours, 1.2);
assert.equal(route.outboundDistance, 9);
assert.equal(route.roundTripDistance, 18);
assert.equal(route.roundTripHours, 4.32);
assert.deepEqual(route.legs.map(function (leg) { return leg.from.id + leg.to.id; }), ['ab', 'bc', 'cb', 'ba']);

var tiny = planner.calculate([
  { name: 'A', coord: [0, 0] },
  { name: 'B', coord: [0.01, 0] }
], 10000, false);
assert.equal(tiny.totalHours, 0.000024);
assert.equal(planner.formatNumber(tiny.totalHours), '0.000024');
assert.equal(planner.formatNumber(12345.67), '12300');
assert.equal(planner.formatExactNumber(1234.567), '1234.567');
assert.equal(planner.formatExactNumber(1234.5), '1234.5');

var log = planner.buildLog([a, b], planner.calculate([a, b], 100, false), 100, false, '');
assert.match(log, /^МАРШРУТ: A → B/m);
assert.match(log, /Координаты: \(0, 0\) → \(3, 4\)/);
assert.match(log, /Скорость: 100 св\.л\.\/сутки/);
assert.match(log, /С возвратом: 10 св\.л\. \| 2\.4 ч/);
assert.ok(!/\d,\d/.test(log), 'decimal values in the log must use dots');
assert.ok(log.includes('\n\n1. A → B'), 'separate log sections with an empty line');
var preciseStops = [
  { name: 'P', coord: [1.234567, 0] },
  { name: 'Произвольная точка', coord: [2.234567, 0] }
];
var preciseLog = planner.buildLog(preciseStops,
  planner.calculate(preciseStops, 12.3456, false), 12.3456, false, '');
assert.match(preciseLog, /Скорость: 12\.3456 св\.л\.\/сутки/);
assert.match(preciseLog, /\(1\.234567, 0\)/, 'coordinates must not be rounded');
assert.match(preciseLog, /Произвольная точка/);

console.log('travel-planner tests passed');
