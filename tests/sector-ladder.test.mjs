import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ladder = require('../src/atlas/level-ladder.ts');
const units = require('../src/atlas/sector-units.ts');

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
  [10, 'L10', 'S', 9.765625, 5, 40, 16],
  [11, 'L11', 'S', 4.8828125, 5, 40, 16],
  [12, 'L12', 'S', 2.44140625, 5, 40, 16],
  [13, 'S0', 'O', 100, 5, 0, 16],
  [14, 'S1', 'O', 16, 5, 0, 16],
  [15, 'S2', 'O', 2, 5, 0, 16],
];

const VIEWPORTS = [
  { w: 1920, h: 1080, expectedMaxScale: 0.54 },
  { w: 1366, h: 768, expectedMaxScale: 0.384 },
  { w: 2560, h: 1440, expectedMaxScale: 0.72 },
  { w: 390, h: 844, expectedMaxScale: 0.195 },
  { w: 844, h: 390, expectedMaxScale: 0.195 },
];

const MAP_SIZE = 10000;
const FIT_INSET = 0.94;
const EPS = 1e-9;

const near = (actual, expected, tolerance = EPS) => Math.abs(actual - expected) <= tolerance;

test('лестница содержит 16 последовательных уровней с согласованной таблицей', () => {
  assert.equal(ladder.LEVELS.length, 16);
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
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'S0', 'S1', 'S2'],
  );
  assert.deepEqual(
    ladder.LEVELS.map(({ level }) => level),
    Array.from({ length: 16 }, (_, index) => index),
  );

  for (const [index, spec] of ladder.LEVELS.entries()) {
    assert.equal(ladder.levelSpec(index), spec);
    assert.equal(ladder.frameOf(index), spec.frame);
    assert.equal(ladder.visibleWidthForLevel(index), spec.visibleWidth);
    assert.equal(ladder.visibleWidthLyForLevel(index), spec.visibleWidth / 1000);
  }
  assert.equal(ladder.visibleWidthLyForLevel(0), 10);
  assert.equal(ladder.visibleWidthLyForLevel(2), 2.5);
  assert.equal(ladder.visibleWidthLyForLevel(7), 0.078125);
  assert.throws(() => ladder.levelSpec(16), RangeError);
  assert.throws(() => ladder.levelSpec(1.5), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(16), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(1.5), RangeError);
});

test('SW-3: L10…L12 — та же геометрия 10 000 / 2^n, системный кадр сдвинут на 13…15', () => {
  assert.equal(ladder.DEEPEST_SECTOR_LEVEL, 12);
  for (const level of [10, 11, 12]) {
    const spec = ladder.levelSpec(level);
    assert.equal(spec.frame, 'S');
    assert.equal(spec.markerPx, 40);
    assert.equal(spec.addressLetters, 5);
    assert.equal(spec.frameBudgetMs, 16);
    assert.ok(near(spec.visibleWidth, 10000 / 2 ** level), `${spec.id}: порог не 10 000 / 2^${level}`);
  }
  assert.deepEqual(
    [10, 11, 12].map((level) => ladder.visibleWidthForLevel(level)),
    [9.765625, 4.8828125, 2.44140625],
  );
  // Системный кадр целиком сдвинулся на 13/14/15 и своей геометрии не менял.
  assert.deepEqual(
    [13, 14, 15].map((level) => ladder.levelSpec(level).id),
    ['S0', 'S1', 'S2'],
  );
  assert.deepEqual(
    [13, 14, 15].map((level) => ladder.frameOf(level)),
    ['O', 'O', 'O'],
  );
  assert.deepEqual(
    [13, 14, 15].map((level) => ladder.visibleWidthForLevel(level)),
    [100, 16, 2],
  );
});

test('секторный уровень определяется точной геометрией и меняется монотонно', () => {
  assert.equal(ladder.MAX_VISIBLE_WIDTH, 10000);
  assert.equal(ladder.MIN_VISIBLE_WIDTH, 16000);
  assert.equal(ladder.levelForWidth(10000), 0);
  assert.equal(ladder.levelForWidth(16000), 0);
  // Прежние контрольные числа §16.9 не сдвинулись.
  assert.equal(ladder.levelForWidth(19.53125), 9);
  assert.equal(ladder.levelForWidth(100), 6);
  // Расширение диапазона до 0…12: ниже L12 кламп не ставит «9».
  assert.equal(ladder.levelForWidth(0), 12);
  assert.equal(ladder.levelForWidth(2.44140625), 12);
  assert.throws(() => ladder.levelForWidth(Number.NaN), RangeError);

  for (let level = 0; level <= 12; level++) {
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
    assert.ok(currentLevel <= 12);
    previousLevel = currentLevel;
  }
  assert.equal(previousLevel, 12);
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
  assert.equal(ladder.levelForWidth(10000, 12), 11);
  // prev валидируется в 0…12 — расширение диапазона, а не снятие проверки.
  assert.throws(() => ladder.levelForWidth(10000, 13), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, -1), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, 1.5), RangeError);
});

test('вход в L12 по гистерезису: 2,148 — уже L12, 2,15 — ещё L11', () => {
  const enterWidth = ladder.visibleWidthForLevel(12) * (1 - ladder.HYSTERESIS);
  assert.ok(near(enterWidth, 2.1484375), `порог входа в L12 ${enterWidth} вместо 2,1484375`);

  assert.equal(ladder.levelForWidth(2.148), 12);
  assert.equal(ladder.levelForWidth(2.148, 11), 12);
  assert.equal(ladder.levelForWidth(enterWidth, 11), 12);
  assert.equal(ladder.levelForWidth(2.15, 11), 11);
  // Без prev «2,15» — сырой уровень 12; 11 получается именно гистерезисом.
  assert.equal(ladder.levelForWidth(2.15), 12);

  // Выход из L12 держится до W(12) · 1,12.
  const leaveWidth = ladder.visibleWidthForLevel(12) * (1 + ladder.HYSTERESIS);
  assert.equal(ladder.levelForWidth(leaveWidth - 0.000001, 12), 12);
  assert.equal(ladder.levelForWidth(leaveWidth, 12), 11);
});

test('тысяча монотонных шагов зума не вызывает мигания уровней', () => {
  const samples = 1000;
  const deepestWidth = ladder.visibleWidthForLevel(12) * (1 - ladder.HYSTERESIS);
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
  assert.equal(level, 12);
  assert.ok(changes <= 12, `при приближении произошло ${changes} смен уровней`);

  const zoomOutWidths = Array.from({ length: samples }, (_, index) => (
    deepestWidth
      * (ladder.MAX_VISIBLE_WIDTH / deepestWidth) ** (index / (samples - 1))
  ));
  level = 12;
  changes = 0;
  for (const width of zoomOutWidths) {
    const next = ladder.levelForWidth(width, level);
    assert.ok(next <= level, `уровень погрузился во время отдаления: ${level} → ${next}`);
    if (next !== level) changes++;
    level = next;
  }
  assert.equal(level, 0);
  assert.ok(changes <= 12, `при отдалении произошло ${changes} смен уровней`);
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

  // L10…L12: формула даёт 45,9 / 61,5 / 82,3 px — всё упирается в кламп 40 px.
  for (const level of [10, 11, 12]) {
    const spec = ladder.levelSpec(level);
    assert.equal(ladder.markerDiameter(spec.visibleWidth), 40);
    assert.equal(spec.markerPx, 40);
  }
  assert.equal(ladder.markerDiameter(2), 40);

  assert.equal(ladder.markerDiameter(10000), 2.5);
  assert.ok(ladder.markerDiameter(4999) > ladder.markerDiameter(5000));
  assert.ok(ladder.markerDiameter(5000) > ladder.markerDiameter(5001));
  assert.ok(ladder.markerDiameter(10000 / 512) > 34.24);
  assert.ok(ladder.markerDiameter(10000 / 512) < 34.36);
});

test('edgeDistance: масштаб для 1 св.г. даёт ровно 1,000 на всех пяти viewport (§17.23)', () => {
  assert.equal(ladder.TARGET_EDGE_LY, 1);
  assert.equal(ladder.MIN_CLAMP_EDGE_LY, 0.5);
  assert.equal(units.lyToUnits(ladder.TARGET_EDGE_LY), 1000);
  assert.equal(units.lyToUnits(ladder.MIN_CLAMP_EDGE_LY), 500);

  for (const viewport of VIEWPORTS) {
    const scale = ladder.scaleForEdgeDistance(viewport, 1);
    assert.ok(scale > 0, `масштаб не положителен для ${viewport.w}×${viewport.h}`);
    assert.equal(scale, viewport.expectedMaxScale);
    assert.equal(scale, Math.min(viewport.w, viewport.h) / 2000);

    const edgeDist = ladder.edgeDistance(viewport, scale);
    assert.ok(
      near(edgeDist, 1, EPS),
      `edgeDistance(${viewport.w}×${viewport.h}) = ${edgeDist}, ожидалось 1 ± 1e-9`,
    );

    // Видимая ширина по короткой оси на этом масштабе — 2 000 единиц (2,00 св.г.), уровень L2.
    const visibleWidthUnits = Math.min(viewport.w, viewport.h) / scale;
    assert.ok(near(visibleWidthUnits, 2000, EPS), `видимая ширина ${visibleWidthUnits} вместо 2000 ед`);
    assert.ok(near(units.unitsToLy(visibleWidthUnits), 2, EPS));
    assert.ok(near(2 * edgeDist, 2, EPS));
    assert.equal(ladder.levelForWidth(visibleWidthUnits), 2);
  }
});

test('регрессия «метрику не подменили»: пороги в единицах прежние, edgeDist в св.г. = visibleWidthLy / 2', () => {
  assert.equal(ladder.visibleWidthForLevel(8) / 2, 19.53125);
  assert.equal(ladder.visibleWidthForLevel(9) / 2, 9.765625);
  assert.equal(ladder.visibleWidthLyForLevel(8) / 2, 0.01953125);
  assert.equal(ladder.visibleWidthLyForLevel(9) / 2, 0.009765625);
  assert.equal(ladder.visibleWidthLyForLevel(2) / 2, 1.25);
  assert.equal(ladder.visibleWidthLyForLevel(3) / 2, 0.625);

  for (const viewport of VIEWPORTS) {
    const onL2 = ladder.edgeDistance(
      viewport,
      ladder.scaleForEdgeDistance(viewport, ladder.visibleWidthLyForLevel(2) / 2),
    );
    const onL3 = ladder.edgeDistance(
      viewport,
      ladder.scaleForEdgeDistance(viewport, ladder.visibleWidthLyForLevel(3) / 2),
    );
    const onL8 = ladder.edgeDistance(
      viewport,
      ladder.scaleForEdgeDistance(viewport, ladder.visibleWidthLyForLevel(8) / 2),
    );
    const onL9 = ladder.edgeDistance(
      viewport,
      ladder.scaleForEdgeDistance(viewport, ladder.visibleWidthLyForLevel(9) / 2),
    );
    assert.ok(near(onL2, 1.25, EPS), `L2: ${viewport.w}×${viewport.h} → ${onL2} вместо 1,25`);
    assert.ok(near(onL3, 0.625, EPS), `L3: ${viewport.w}×${viewport.h} → ${onL3} вместо 0,625`);
    assert.ok(near(onL8, 0.01953125, EPS), `L8: ${viewport.w}×${viewport.h} → ${onL8} вместо 0,01953125`);
    assert.ok(near(onL9, 0.009765625, EPS), `L9: ${viewport.w}×${viewport.h} → ${onL9} вместо 0,009765625`);
    assert.ok(onL2 > 1 && onL3 < 1);
  }
});

test('кламп зума — 0,54 / 0,384 / 0,72 / 0,195 и ровно 1,00 св.г. до границы (§17.23)', () => {
  assert.equal(ladder.TARGET_EDGE_LY, 1);
  assert.ok(near(ladder.fitScaleFor({ w: 1920, h: 1080 }, MAP_SIZE, FIT_INSET), 0.10152, EPS));

  for (const viewport of VIEWPORTS) {
    const minSide = Math.min(viewport.w, viewport.h);
    const fitScale = ladder.fitScaleFor(viewport, MAP_SIZE, FIT_INSET);
    assert.ok(
      near(fitScale, minSide / MAP_SIZE * FIT_INSET, EPS),
      `fitScaleFor(${viewport.w}×${viewport.h}) = ${fitScale} не по формуле рендерера`,
    );

    // §17.23: упор стоит ровно в точке требования — scale = min(w, h) / 2000.
    const maxScale = ladder.maxScaleForTargetEdge(viewport, MAP_SIZE, FIT_INSET);
    assert.equal(maxScale, viewport.expectedMaxScale);
    assert.equal(maxScale, minSide / 2000);
    const edgeAtMax = ladder.edgeDistance(viewport, maxScale);
    assert.ok(
      near(edgeAtMax, 1, EPS),
      `edgeDistance на клампе ${edgeAtMax} ≠ 1 при ${viewport.w}×${viewport.h}`,
    );

    // Множитель — тождество: mapSize / (2 · UNITS_PER_LY · fitInset) = 5,3191489… (532 %).
    const ratio = maxScale / fitScale;
    const identity = MAP_SIZE / (2 * units.UNITS_PER_LY * FIT_INSET);
    assert.ok(
      near(ratio, identity, EPS),
      `множитель ${ratio} ≠ ${identity} при ${viewport.w}×${viewport.h}`,
    );
    assert.equal(Math.round(ratio * 100), 532);

    // Предохранитель: кламп не глубже системного кадра 0,5 св.г. (500 единиц до края).
    assert.ok(
      maxScale <= ladder.scaleForEdgeDistance(viewport, ladder.MIN_CLAMP_EDGE_LY) + EPS,
      `кламп глубже системного кадра при ${viewport.w}×${viewport.h}`,
    );

    // На упоре 2 000 единиц по короткой оси с гистерезисом достигается L2 (порог входа 2 200 ед).
    assert.equal(ladder.levelForWidth(minSide / maxScale, 1), 2);
  }
});

test('метрика отклоняет нечисловые, нулевые и отрицательные входы', () => {
  const viewport = { w: 1920, h: 1080 };
  const badNumbers = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, -0.94];
  for (const value of badNumbers) {
    assert.throws(() => ladder.edgeDistance(viewport, value), RangeError, `scale ${value}`);
    assert.throws(() => ladder.scaleForEdgeDistance(viewport, value), RangeError, `edgeDist ${value}`);
    assert.throws(() => ladder.fitScaleFor(viewport, value, 0.94), RangeError, `mapSize ${value}`);
    assert.throws(() => ladder.fitScaleFor(viewport, 10000, value), RangeError, `fitInset ${value}`);
    assert.throws(() => ladder.maxScaleForTargetEdge(viewport, value, 0.94), RangeError, `mapSize ${value}`);
    assert.throws(() => ladder.maxScaleForTargetEdge(viewport, 10000, value), RangeError, `fitInset ${value}`);
  }

  for (const broken of [{ w: 0, h: 1080 }, { w: 1920, h: -1080 }, { w: Number.NaN, h: 1080 }, { w: 1920, h: 0 }]) {
    assert.throws(() => ladder.edgeDistance(broken, 1), RangeError, JSON.stringify(broken));
    assert.throws(() => ladder.scaleForEdgeDistance(broken, 1), RangeError, JSON.stringify(broken));
    assert.throws(() => ladder.fitScaleFor(broken, 10000, 0.94), RangeError, JSON.stringify(broken));
  }

  assert.throws(() => ladder.edgeDistance(null, 1), RangeError);
  assert.throws(() => ladder.edgeDistance(undefined, 1), RangeError);
});
