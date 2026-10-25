import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const units = require('../src/atlas/sector-units.ts');

const { NBSP, UNITS_PER_LY, unitsToLy, lyToUnits, formatDistanceLy } = units;

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

test('режим label: три ступени точности по §17.23.3', () => {
  // < 1 св.г. → 3 знака
  assert.equal(units.formatDistanceLy(0.088, 'label'), `0,088${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.091, 'label'), `0,091${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(0.099, 'label'), `0,099${NBSP}св.г.`);

  // 1 … 99,9 св.г. → 1 знак
  assert.equal(units.formatDistanceLy(1.52, 'label'), `1,5${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(10.0, 'label'), `10,0${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(99.9, 'label'), `99,9${NBSP}св.г.`);

  // 100 … 9 999 св.г. → целое
  assert.equal(units.formatDistanceLy(108, 'label'), `108${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(1303, 'label'), `1${NBSP}303${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(9999, 'label'), `9${NBSP}999${NBSP}св.г.`);

  // >= 10 000 св.г.
  assert.equal(units.formatDistanceLy(10000, 'label'), `≥ 10${NBSP}000${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(15000, 'label'), `≥ 10${NBSP}000${NBSP}св.г.`);

  // Режим label не ломает существующие значения
  assert.equal(units.formatDistanceLy(8.4, 'label'), `8,4${NBSP}св.г.`);
  assert.equal(units.formatDistanceLy(88.4, 'label'), `88,4${NBSP}св.г.`);

  // Неизвестный режим
  assert.throws(() => units.formatDistanceLy(1, 'unknown'), RangeError);
});

test('контрольные точки форматирования label для карты (§17.23)', () => {
  // Значения в единицах карты переводятся в св.г. делением на 1000.
  // Все значения < 1 св.г. → 3 знака
  // 88,4 ед → 0,0884 св.г. → 0,088 св.г.
  assert.equal(units.formatDistanceLy(unitsToLy(88.4), 'label'), `0,088${NBSP}св.г.`);
  // 90,8 ед → 0,0908 св.г. → 0,091 св.г. (округление)
  assert.equal(units.formatDistanceLy(unitsToLy(90.8), 'label'), `0,091${NBSP}св.г.`);
  // 108,07 ед → 0,10807 св.г. → 0,108 св.г.
  assert.equal(units.formatDistanceLy(unitsToLy(108.07), 'label'), `0,108${NBSP}св.г.`);
  // 116,32 ед → 0,11632 св.г. → 0,116 св.г.
  assert.equal(units.formatDistanceLy(unitsToLy(116.32), 'label'), `0,116${NBSP}св.г.`);
  // 116,76 ед → 0,11676 св.г. → 0,117 св.г. (округление)
  assert.equal(units.formatDistanceLy(unitsToLy(116.76), 'label'), `0,117${NBSP}св.г.`);
});

<<<<<<< HEAD
test('UNITS_PER_LY = 1000 и функции конверсии единиц', () => {
=======
test(' UNITS_PER_LY = 1000 и функции конверсии единиц', () => {
>>>>>>> 20716f2 (wip(Z-4): единицы 1000 ед = 1 св.г.)
  assert.equal(UNITS_PER_LY, 1000);

  // unitsToLy
  assert.equal(unitsToLy(1000), 1);
  assert.equal(unitsToLy(88.4), 0.0884);
  assert.equal(unitsToLy(990.4), 0.9904);
  assert.equal(unitsToLy(0), 0);

  // lyToUnits
  assert.equal(lyToUnits(1), 1000);
  assert.equal(lyToUnits(0.0884), 88.4);
  assert.equal(lyToUnits(0.9904), 990.4);
  assert.equal(lyToUnits(0), 0);

  // RangeError на NaN и отрицательные
  assert.throws(() => unitsToLy(-1), RangeError);
  assert.throws(() => unitsToLy(Number.NaN), RangeError);
  assert.throws(() => lyToUnits(-0.1), RangeError);
  assert.throws(() => lyToUnits(Number.NaN), RangeError);
});

test('unit conversion round-trip', () => {
  const values = [0, 1, 88.4, 990.4, 1000, 5776.3, 10000, 15000];
  for (const v of values) {
    assert.equal(lyToUnits(unitsToLy(v)), v);
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
