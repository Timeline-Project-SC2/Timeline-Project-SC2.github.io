import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ladder = require('../src/atlas/level-ladder.ts');

const expectedRows = [
  [0, 'L0', 'S', 10000, 0, 2.5, 8],
  [1, 'L1', 'S', 5000, 1, 3.3, 8],
  [2, 'L2', 'S', 2500, 2, 4.5, 10],
  [3, 'L3', 'S', 1250, 2, 6.0, 10],
  [4, 'L4', 'S', 625, 3, 8.0, 12],
  [5, 'L5', 'S', 312.5, 3, 10.7, 12],
  [6, 'L6', 'S', 156.25, 4, 14.3, 14],
  [7, 'L7', 'S', 78.125, 4, 19.2, 14],
  [8, 'L8', 'S', 39.0625, 5, 25.7, 16],
  [9, 'L9', 'S', 19.53125, 5, 34.3, 16],
  [10, 'S0', 'O', 100, 5, 0, 16],
  [11, 'S1', 'O', 16, 5, 0, 16],
  [12, 'S2', 'O', 2, 5, 0, 16],
];

test('лестница содержит 13 последовательных уровней с согласованной таблицей', () => {
  assert.equal(ladder.LEVELS.length, 13);
  assert.deepEqual(
    ladder.LEVELS.map(({ level, id, frame, visibleWidth, addressLetters, markerPx, frameBudgetMs }) => [
      level,
      id,
      frame,
      visibleWidth,
      addressLetters,
      markerPx,
      frameBudgetMs,
    ]),
    expectedRows,
  );
  assert.deepEqual(
    ladder.LEVELS.map(({ id }) => id),
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'S0', 'S1', 'S2'],
  );
  assert.deepEqual(
    ladder.LEVELS.map(({ level }) => level),
    Array.from({ length: 13 }, (_, index) => index),
  );

  for (const [index, spec] of ladder.LEVELS.entries()) {
    assert.equal(ladder.levelSpec(index), spec);
    assert.equal(ladder.frameOf(index), spec.frame);
    assert.equal(ladder.visibleWidthForLevel(index), spec.visibleWidth);
  }
  assert.throws(() => ladder.levelSpec(13), RangeError);
  assert.throws(() => ladder.levelSpec(1.5), RangeError);
});

test('секторный уровень определяется точной геометрией и меняется монотонно', () => {
  assert.equal(ladder.MAX_VISIBLE_WIDTH, 10000);
  assert.equal(ladder.MIN_VISIBLE_WIDTH, 16000);
  assert.equal(ladder.levelForWidth(10000), 0);
  assert.equal(ladder.levelForWidth(16000), 0);
  assert.equal(ladder.levelForWidth(19.53125), 9);
  assert.equal(ladder.levelForWidth(100), 6);
  assert.equal(ladder.levelForWidth(0), 9);
  assert.throws(() => ladder.levelForWidth(Number.NaN), RangeError);

  for (let level = 0; level <= 9; level++) {
    const exactWidth = 10000 / 2 ** level;
    assert.equal(ladder.visibleWidthForLevel(level), exactWidth);
    assert.equal(ladder.levelForWidth(exactWidth), level);
  }

  let previousLevel = 0;
  for (let sample = 0; sample <= 2000; sample++) {
    const progress = sample / 2000;
    const width = 16000 * 0.0001 ** progress;
    const currentLevel = ladder.levelForWidth(width);
    assert.ok(currentLevel >= previousLevel, `уровень снизился при ширине ${width}`);
    assert.ok(currentLevel <= 9);
    previousLevel = currentLevel;
  }
  assert.equal(previousLevel, 9);
});

test('гистерезис ±12 % удерживает границу и ограничивает шаг одним уровнем', () => {
  assert.equal(ladder.HYSTERESIS, 0.12);

  const descendThreshold = ladder.visibleWidthForLevel(1) * (1 - ladder.HYSTERESIS);
  assert.equal(ladder.levelForWidth(descendThreshold, 0), 1);
  assert.equal(ladder.levelForWidth(descendThreshold + 0.000001, 0), 0);
  assert.equal(ladder.levelForWidth(4500), 1);
  assert.equal(ladder.levelForWidth(4500, 0), 0);

  const ascendThreshold = ladder.visibleWidthForLevel(1) * (1 + ladder.HYSTERESIS);
  assert.equal(ladder.levelForWidth(ascendThreshold, 1), 0);
  assert.equal(ladder.levelForWidth(ascendThreshold - 0.000001, 1), 1);

  assert.equal(ladder.levelForWidth(19.53125, 0), 1);
  assert.equal(ladder.levelForWidth(19.53125, 4), 5);
  assert.equal(ladder.levelForWidth(10000, 9), 8);
  assert.throws(() => ladder.levelForWidth(10000, 12), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, 10), RangeError);
});

test('тысяча монотонных шагов зума не вызывает мигания уровней', () => {
  const samples = 1000;
  const deepestWidth = ladder.visibleWidthForLevel(9) * (1 - ladder.HYSTERESIS);
  const zoomInWidths = Array.from({ length: samples }, (_, index) => (
    ladder.MAX_VISIBLE_WIDTH
      * (deepestWidth / ladder.MAX_VISIBLE_WIDTH) ** (index / (samples - 1))
  ));

  let level = 0;
  let changes = 0;
  for (const width of zoomInWidths) {
    const next = ladder.levelForWidth(width, level);
    assert.ok(next >= level, `уровень всплыл во время приближения: ${level} → ${next}`);
    if (next !== level) changes++;
    level = next;
  }
  assert.equal(level, 9);
  assert.ok(changes <= 9, `при приближении произошло ${changes} смен уровней`);

  const zoomOutWidths = Array.from({ length: samples }, (_, index) => (
    deepestWidth
      * (ladder.MAX_VISIBLE_WIDTH / deepestWidth) ** (index / (samples - 1))
  ));
  level = 9;
  changes = 0;
  for (const width of zoomOutWidths) {
    const next = ladder.levelForWidth(width, level);
    assert.ok(next <= level, `уровень погрузился во время отдаления: ${level} → ${next}`);
    if (next !== level) changes++;
    level = next;
  }
  assert.equal(level, 0);
  assert.ok(changes <= 9, `при отдалении произошло ${changes} смен уровней`);
});

test('диаметр маркера непрерывно зависит от ширины и совпадает с таблицей', () => {
  for (let level = 0; level <= 9; level++) {
    const spec = ladder.levelSpec(level);
    const diameter = ladder.markerDiameter(ladder.visibleWidthForLevel(level));
    assert.ok(
      Math.abs(diameter - spec.markerPx) <= 0.06,
      `${spec.id}: диаметр ${diameter} px не совпадает с ${spec.markerPx} px`,
    );
  }

  assert.equal(ladder.markerDiameter(10000), 2.5);
  assert.ok(ladder.markerDiameter(4999) > ladder.markerDiameter(5000));
  assert.ok(ladder.markerDiameter(5000) > ladder.markerDiameter(5001));
  assert.ok(ladder.markerDiameter(10000 / 512) > 34.24);
  assert.ok(ladder.markerDiameter(10000 / 512) < 34.36);
});
