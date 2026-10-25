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

test('режим label содержит три ступени точности (§17.23) и не меняет short/full', () => {
  // Ступень ly < 1 -> 3 знака.
  assert.equal(units.formatDistanceLy(0, 'label'), `0,000${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.0884, 'label'), `0,088${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.0908, 'label'), `0,091${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.10807, 'label'), `0,108${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.11632, 'label'), `0,116${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.11676, 'label'), `0,117${NBSP}св.г.`);

  // Ступень 1 <= ly < 100 -> 1 знак.
  assert.equal(units.formatDistanceLy(1, 'label'), `1,0${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(10, 'label'), `10,0${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(88.4, 'label'), `88,4${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(90.79, 'label'), `90,8${NBSP}св.г.`);

  // Ступень 100 <= ly < 10 000 -> целое с разрядным NBSP; >= 10 000 -> порог.
  assert.equal(units.formatDistanceLy(100, 'label'), `100${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(108.07, 'label'), `108${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(116.76, 'label'), `117${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(1302.6, 'label'), `1${NBSP}303${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(1303, 'label'), `1${NBSP}303${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(10000, 'label'), `≥ 10${NBSP}000${NBSP}св.г.`);

  // Режимы short и full не меняются.
  assert.equal(units.formatDistanceLy(0.0884, 'short'), `0,1${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.0884, 'full'), `0,09${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(1, 'full'), `1,00${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(108.07, 'short'), `108,1${NBSP}св.г.`);
  assert.throws(() => units.formatDistanceLy(88.4, 'unknown'), RangeError);
});

test('UNITS_PER_LY = 1000, unitsToLy и lyToUnits: перевод, round-trip и валидация', () => {
  assert.equal(units.UNITS_PER_LY, 1000);
  assert.equal(units.unitsToLy(1000), 1);
  assert.equal(units.unitsToLy(88.4), 0.0884);
  assert.equal(units.unitsToLy(0), 0);
  assert.equal(units.unitsToLy(10000), 10);

  assert.equal(units.lyToUnits(0), 0);
  assert.equal(units.lyToUnits(0.5), 500);
  assert.equal(units.lyToUnits(1), 1000);
  assert.equal(units.lyToUnits(10), 10000);

  for (const u of [0, 0.5, 88.4, 90.8, 108.07, 116.32, 116.76, 990.4, 1000, 3672.4, 10000]) {
    assert.ok(Math.abs(units.lyToUnits(units.unitsToLy(u)) - u) <= 1e-9, `round-trip ед→св.г.→ед для ${u}`);
  }
  for (const ly of [0, 0.0884, 0.101, 0.5, 0.99, 1, 3.6724, 10]) {
    assert.ok(Math.abs(units.unitsToLy(units.lyToUnits(ly)) - ly) <= 1e-12, `round-trip св.г.→ед→св.г. для ${ly}`);
  }

  for (const bad of [-0.1, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, undefined]) {
    assert.throws(() => units.unitsToLy(bad), RangeError, `unitsToLy(${String(bad)})`);
    assert.throws(() => units.lyToUnits(bad), RangeError, `lyToUnits(${String(bad)})`);
    assert.throws(() => units.formatDistanceLy(bad), RangeError, `formatDistanceLy(${String(bad)})`);
  }
});
