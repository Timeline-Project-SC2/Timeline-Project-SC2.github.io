import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const units = require('../src/atlas/sector-units.ts');

const { NBSP } = units;

test('расстояния сохраняют единицу, русскую запись и заданную точность', () => {
  const outputs = [
    units.formatDistanceLy(8.4, 'short'),
    units.formatDistanceLy(88.4, 'short'),
    units.formatDistanceLy(90.79, 'full'),
    units.formatDistanceLy(108.07, 'full'),
    units.formatDistanceLy(1302.9, 'short'),
    units.formatDistanceLy(5776.3, 'short'),
  ];

  assert.deepEqual(outputs, [
    `8,4${NBSP}св.г.`,
    `88,4${NBSP}св.г.`,
    `90,79${NBSP}св.г.`,
    `108,07${NBSP}св.г.`,
    `1${NBSP}302,9${NBSP}св.г.`,
    `5${NBSP}776,3${NBSP}св.г.`,
  ]);
  assert.equal(units.formatDistanceLy(8.4), `8,4${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(8.4, 'full'), `8,40${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(10000, 'short'), `≥ 10${NBSP}000${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(15000, 'full'), `≥ 10${NBSP}000${NBSP}св.г.`);
  assert.throws(() => units.formatDistanceLy(-0.1), RangeError);
  assert.throws(() => units.formatDistanceLy(Number.NaN), RangeError);

  const allOutputs = [
    ...outputs,
    units.formatDistanceLy(10000),
    units.formatDistanceLy(15000),
  ].join(' ');
  assert.doesNotMatch(allOutputs, /ly|св\. лет|св\.год/);
  assert.doesNotMatch(allOutputs, /\d\.\d/);
  for (const output of outputs) {
    assert.ok(output.endsWith(`${NBSP}св.г.`));
  }
});

test('склонение лет учитывает исключения и дробные значения', () => {
  assert.equal(units.pluralYears(1), 'год');
  assert.equal(units.pluralYears(2), 'года');
  assert.equal(units.pluralYears(5), 'лет');
  assert.equal(units.pluralYears(21), 'год');
  assert.equal(units.pluralYears(90.8), 'лет');
  assert.equal(units.pluralYears(11), 'лет');
  assert.equal(units.pluralYears(22), 'года');
  assert.equal(units.pluralYears(25), 'лет');
});

test('углы нормализуются в интервал (-180°, 180°] с русским минусом', () => {
  assert.equal(units.formatAngleDeg(Math.PI), '180°');
  assert.equal(units.formatAngleDeg(-Math.PI), '180°');
  assert.equal(units.formatAngleDeg(3 * Math.PI), '180°');
  assert.equal(units.formatAngleDeg(-0), '0°');
  assert.equal(units.formatAngleDeg(0), '0°');
  assert.equal(units.formatAngleDeg(-Math.PI / 2), '−90°');
  assert.equal(units.formatAngleDeg(7 * Math.PI / 4), '−45°');
  assert.equal(units.formatAngleDeg(12.04 * Math.PI / 180), '12,0°');
  assert.equal(units.formatAngleDeg(136.4 * Math.PI / 180), '136,4°');
  assert.throws(() => units.formatAngleDeg(Number.NaN), RangeError);
});
