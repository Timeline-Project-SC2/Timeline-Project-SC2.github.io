import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const addressCodec = require('../src/atlas/sector-address.ts');
const { ADDRESS_TIERS, addressOf, centerOf, formatAddress, parseAddress, prefixOf, rectOf } = addressCodec;

const goldenVectors = [
  [5720, 6257, 'KP·REQHC'],
  [5749, 5984, 'KP·MYVYB'],
  [5568, 5994, 'KP·MXYXP'],
  [5683, 5855, 'KP·MYQAU'],
  [5086, 5896, 'KP·MWSRO'],
  [6683, 5076, 'KP·NLSMI'],
  [9233, 4539, 'KP·OIFRP'],
  [8396, 3061, 'KP·JKTJI'],
  [0, 0, 'KP·AAAAA'],
  [9999, 9999, 'KP·YYYYY'],
  [2500, 2500, 'KP·GGGGG'],
];

test('кодек адреса: тиры и 11 golden vectors', () => {
  assert.deepEqual(ADDRESS_TIERS.map(({ id, name, cellSize }) => [id, name, cellSize]), [
    ['T0', 'Сектор', 10000],
    ['T1', 'Квадрант', 2000],
    ['T2', 'Регион', 400],
    ['T3', 'Субсектор', 80],
    ['T4', 'Ячейка', 16],
    ['T5', 'Узел', 3.2],
  ]);
  for (const [x, y, expected] of goldenVectors) {
    assert.equal(formatAddress(addressOf(x, y)), expected, `${x},${y}`);
  }
});

test('кодек адреса: 173 системы имеют уникальные адреса и точный центр ячейки', () => {
  const csv = readFileSync(new URL('../data/systems.csv', import.meta.url), 'utf8').trimEnd();
  const rows = csv.split(/\r?\n/);
  const columns = rows[0]?.split(',') ?? [];
  const xColumn = columns.indexOf('x');
  const yColumn = columns.indexOf('y');
  assert.notEqual(xColumn, -1);
  assert.notEqual(yColumn, -1);

  const addresses = new Set();
  let systemCount = 0;
  for (const line of rows.slice(1)) {
    const fields = line.split(',');
    const x = Number(fields[xColumn]);
    const y = Number(fields[yColumn]);
    const address = addressOf(x, y);
    const compact = formatAddress(address);
    addresses.add(compact);
    const rect = rectOf(address);
    const center = centerOf(address);
    const error = Math.max(
      Math.abs(center.x - (rect.x + rect.size / 2)),
      Math.abs(center.y - (rect.y + rect.size / 2)),
    );
    assert.ok(error <= 1e-9, `${compact}: ошибка центра ${error}`);
    assert.equal(formatAddress(addressOf(center.x, center.y)), compact);
    systemCount += 1;
  }
  assert.equal(systemCount, 173);
  assert.equal(addresses.size, 173);
});

test('кодек адреса: прямоугольники крайних и граничных ячеек', () => {
  const samples = [
    [0, 0, 'KP·AAAAA', 0, 0],
    [9999, 9999, 'KP·YYYYY', 9996.8, 9996.8],
    [2500, 2500, 'KP·GGGGG', 2499.2, 2499.2],
  ];
  for (const [x, y, expected, expectedRectX, expectedRectY] of samples) {
    const address = addressOf(x, y);
    const rect = rectOf(address);
    const center = centerOf(address);
    assert.equal(formatAddress(address), expected);
    assert.equal(rect.x, expectedRectX);
    assert.equal(rect.y, expectedRectY);
    assert.equal(rect.size, 3.2);
    assert.equal(center.x, rect.x + 1.6);
    assert.equal(center.y, rect.y + 1.6);
    assert.ok(x >= rect.x && x < rect.x + rect.size);
    assert.ok(y >= rect.y && y < rect.y + rect.size);
  }
});

test('кодек адреса: уровневые префиксы и формы форматирования', () => {
  assert.equal(formatAddress(prefixOf(5720, 6257, 0)), 'KP');
  assert.equal(formatAddress(prefixOf(5720, 6257, 2)), 'KP·RE');
  assert.equal(formatAddress({ sector: 'KP', letters: 'REQHC' }, 'expanded'), 'KP-R-E-Q-H-C');
  assert.equal(formatAddress({ sector: 'KP', letters: 'RE' }, 'expanded'), 'KP-R-E');
});

test('кодек адреса: парсер принимает варианты записи и зарезервированные сектора', () => {
  for (const input of ['KP·REQHC', 'kp-reqhc', 'REQHC', 'KP-R-E-Q-H-C', 'KP REQHC']) {
    assert.deepEqual(parseAddress(input), { sector: 'KP', letters: 'REQHC' }, input);
  }
  for (const sector of ['TS', 'UJ', 'CH', 'AY', 'SL', 'SH']) {
    assert.deepEqual(parseAddress(`${sector}·ABCDE`), { sector, letters: 'ABCDE' });
  }
});

test('кодек адреса: парсер отвергает пустой ввод, мусор, чужие сектора и неверную длину', () => {
  for (const input of ['', '   ', 'не адрес', 'KP·', 'KP·ABCD', 'KP·ABCDEF', 'KP·AZAAA', 'XX·ABCDE', 'ABCDE!']) {
    assert.equal(parseAddress(input), null, JSON.stringify(input));
  }
});

test('кодек адреса: координаты за пределами поля отклоняются', () => {
  for (const [x, y] of [
    [-0.01, 0],
    [0, -0.01],
    [10000, 0],
    [0, 10000],
    [Number.NaN, 0],
    [0, Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(() => addressOf(x, y), TypeError);
  }
});
