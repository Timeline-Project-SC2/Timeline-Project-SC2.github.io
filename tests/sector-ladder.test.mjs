import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ladder = require('../src/atlas/level-ladder.ts');
const units = require('../src/atlas/sector-units.ts');

/** Ширина уровня `n`: `10000 / 1,9194^n` св.г. */
const widthOf = (level) => 10000 / 1.9194 ** level;

const expectedRows = [
  [0, 'L0', 'S', widthOf(0), 0, 2.5, 8],
  [1, 'L1', 'S', widthOf(1), 1, 3.1, 8],
  [2, 'L2', 'S', widthOf(2), 2, 4.0, 10],
  [3, 'L3', 'S', widthOf(3), 2, 5.0, 10],
  [4, 'L4', 'S', widthOf(4), 3, 6.3, 12],
  [5, 'L5', 'S', widthOf(5), 3, 7.9, 12],
  [6, 'L6', 'S', widthOf(6), 4, 10.0, 14],
  [7, 'L7', 'S', widthOf(7), 4, 12.6, 14],
  [8, 'L8', 'S', widthOf(8), 5, 15.9, 16],
  [9, 'L9', 'S', widthOf(9), 5, 20.0, 16],
  [10, 'L10', 'S', widthOf(10), 5, 25.2, 16],
  [11, 'L11', 'S', widthOf(11), 5, 31.8, 16],
  [12, 'L12', 'S', widthOf(12), 5, 40.0, 16],
  [13, 'S0', 'O', 100, 5, 0, 16],
  [14, 'S1', 'O', 16, 5, 0, 16],
  [15, 'S2', 'O', 2, 5, 0, 16],
];

/** На каждом viewport предел масштаба равен 500 px/св.г.; edgeDistance остаётся геометрическим. */
const VIEWPORTS = [
  { w: 1920, h: 1080, expectedMaxScale: 500, expectedEdgeAtMax: 1.08 },
  { w: 1366, h: 768, expectedMaxScale: 500, expectedEdgeAtMax: 0.768 },
  { w: 2560, h: 1440, expectedMaxScale: 500, expectedEdgeAtMax: 1.44 },
  { w: 390, h: 844, expectedMaxScale: 500, expectedEdgeAtMax: 0.39 },
  { w: 844, h: 390, expectedMaxScale: 500, expectedEdgeAtMax: 0.39 },
];

const MAP_SIZE = 10000;
const FIT_INSET = 0.94;
const EPS = 1e-9;

const near = (actual, expected, tolerance = EPS) => Math.abs(actual - expected) <= tolerance;

test('лестница содержит L0…L12 и системный кадр с согласованной таблицей', () => {
  // 13 секторных записей L0…L12 + 3 системные S0…S2 (уровни 13…15).
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
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );

  for (const spec of ladder.LEVELS) {
    assert.equal(ladder.levelSpec(spec.level), spec);
    assert.equal(ladder.frameOf(spec.level), spec.frame);
    assert.equal(ladder.visibleWidthForLevel(spec.level), spec.visibleWidth);
    assert.equal(ladder.visibleWidthLyForLevel(spec.level), spec.visibleWidth / units.UNITS_PER_LY);
  }
  assert.equal(ladder.visibleWidthLyForLevel(0), 10000);
  assert.ok(near(ladder.visibleWidthLyForLevel(2), widthOf(2), 1e-12));
  assert.ok(near(ladder.visibleWidthLyForLevel(7), widthOf(7), 1e-12));
  assert.throws(() => ladder.levelSpec(16), RangeError);
  assert.throws(() => ladder.levelSpec(1.5), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(16), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(1.5), RangeError);
});

test('лестница содержит 13 секторных уровней, системные S0…S2 сохраняют номера и ширины', () => {
  assert.equal(ladder.DEEPEST_SECTOR_LEVEL, 12);
  assert.deepEqual(
    ladder.LEVELS.filter((spec) => spec.frame === 'S').map((spec) => spec.id),
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12'],
  );
  // Системный кадр сохранил номера 13/14/15 и свою геометрию целиком.
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

test('уровни после системного кадра вне лестницы', () => {
  for (const level of [16, 17]) {
    assert.throws(() => ladder.levelSpec(level), RangeError, `levelSpec(${level})`);
    assert.throws(() => ladder.visibleWidthForLevel(level), RangeError, `visibleWidthForLevel(${level})`);
  }
});

test('геометрия width(n) = 10000 / 1,9194^n, включая точную ширину L12', () => {
  for (let level = 0; level <= 12; level++) {
    assert.ok(
      near(ladder.visibleWidthForLevel(level), widthOf(level), 1e-6),
      `L${level}: ${ladder.visibleWidthForLevel(level)} вместо ${widthOf(level)}`,
    );
  }
  assert.ok(near(ladder.visibleWidthForLevel(12), 3.999577480075393, 1e-12));
  assert.equal(ladder.visibleWidthLyForLevel(12), ladder.visibleWidthForLevel(12));
  assert.equal(ladder.LEVEL_STEP, 1.9194);
});

test('C8/C9: frameBudgetMs и addressLetters по таблице Z-4b', () => {
  assert.deepEqual(
    Array.from({ length: 13 }, (_, level) => ladder.levelSpec(level).frameBudgetMs),
    [8, 8, 10, 10, 12, 12, 14, 14, 16, 16, 16, 16, 16],
  );
  assert.ok(ladder.LEVELS.every((spec) => spec.frameBudgetMs <= 16));
  assert.deepEqual(
    Array.from({ length: 13 }, (_, level) => ladder.levelSpec(level).addressLetters),
    [0, 1, 2, 2, 3, 3, 4, 4, 5, 5, 5, 5, 5],
  );
});

test('секторный уровень определяется точной геометрией и меняется монотонно', () => {
  assert.equal(ladder.MAX_VISIBLE_WIDTH, 10000);
  assert.equal(ladder.MIN_VISIBLE_WIDTH, 16000);
  assert.equal(ladder.levelForWidth(10000), 0);
  assert.equal(ladder.levelForWidth(16000), 0);
  // На и ниже L12 уровень не уходит: лестница кончается на 12.
  assert.equal(ladder.levelForWidth(1000), 3);
  assert.equal(ladder.levelForWidth(100), 7);
  assert.equal(ladder.levelForWidth(0), 12);
  assert.throws(() => ladder.levelForWidth(Number.NaN), RangeError);

  for (let level = 0; level <= 12; level++) {
    assert.ok(near(ladder.visibleWidthForLevel(level), widthOf(level), 1e-9));
    assert.equal(ladder.levelForWidth(widthOf(level)), level, `номинал L${level}`);
    // Край с допуском 1e-9: ширина чуть шире номинала L9 всё ещё L9.
    assert.equal(ladder.levelForWidth(widthOf(level) * (1 + 1e-12)), level, `допуск у L${level}`);
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
  assert.equal(ladder.levelForWidth(5000), 1);
  assert.equal(ladder.levelForWidth(5000, 0), 0);

  const ascendThreshold = ladder.visibleWidthForLevel(1) * (1 + ladder.HYSTERESIS);
  assert.equal(ladder.levelForWidth(ascendThreshold, 1), 0);
  assert.equal(ladder.levelForWidth(ascendThreshold - 0.000001, 1), 1);

  assert.equal(ladder.levelForWidth(19.53125, 0), 1);
  assert.equal(ladder.levelForWidth(19.53125, 4), 5);
  assert.equal(ladder.levelForWidth(10000, 12), 11);
  // prev валидируется в 0…12; системные S0…S2 не являются секторными уровнями.
  assert.throws(() => ladder.levelForWidth(10000, 13), RangeError);
  assert.throws(() => ladder.levelForWidth(10000, 16), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, -1), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, 1.5), RangeError);
});

test('асимметричный вход и выход на L12 удерживают номинальный предел', () => {
  const deepest = ladder.visibleWidthForLevel(12);
  assert.equal(ladder.levelForWidth(deepest, 11), 12);
  assert.equal(ladder.levelForWidth(deepest), 12);
  assert.ok(deepest * (1 - ladder.HYSTERESIS) < deepest);
  assert.equal(ladder.levelForWidth(deepest * (1 + 1e-12), 11), 12);
  assert.equal(ladder.levelForWidth(deepest * 1.01, 11), 11);
  assert.equal(ladder.levelForWidth(deepest * 1.11, 12), 12);
  assert.equal(ladder.levelForWidth(deepest * 1.12, 12), 11);
});

test('L12 включается и выключается ровно один раз при монотонном зуме', () => {
  let level = 11;
  let entries = 0;
  for (let width = 5; width >= 3.8; width -= 0.001) {
    const next = ladder.levelForWidth(width, level);
    if (level !== 12 && next === 12) entries++;
    assert.ok(next >= level, `приближение: уровень всплыл ${level} → ${next} на ${width}`);
    level = next;
  }
  assert.equal(level, 12);
  assert.equal(entries, 1);

  let exits = 0;
  for (let width = 3.8; width <= 5; width += 0.001) {
    const next = ladder.levelForWidth(width, level);
    if (level === 12 && next !== 12) exits++;
    assert.ok(next <= level, `отдаление: уровень погрузился ${level} → ${next} на ${width}`);
    level = next;
  }
  assert.equal(level, 11);
  assert.equal(exits, 1);
});

test('C4d: для n = 1…8 прежний гистерезис ±12 % не тронут', () => {
  for (let level = 1; level <= 11; level++) {
    const width = ladder.visibleWidthForLevel(level);
    assert.equal(ladder.levelForWidth(width * 0.89, level - 1), level - 1, `L${level}: 0,89 ещё снаружи`);
    assert.equal(ladder.levelForWidth(width * 0.88, level - 1), level, `L${level}: 0,88 — вход`);
    assert.equal(ladder.levelForWidth(width * 1.11, level), level, `L${level}: 1,11 ещё внутри`);
    assert.equal(ladder.levelForWidth(width * 1.12, level), level - 1, `L${level}: 1,12 — выход`);
  }
});

test('тысяча монотонных шагов зума не вызывает мигания уровней', () => {
  const samples = 1000;
  const deepestWidth = ladder.visibleWidthForLevel(12);
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
  assert.equal(changes, 12, `при приближении произошло ${changes} смен уровней`);

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
  assert.equal(changes, 12, `при отдалении произошло ${changes} смен уровней`);
});

test('C7: диаметр маркера непрерывно зависит от ширины и совпадает с таблицей', () => {
  assert.equal(ladder.MARKER_EXPONENT, 0.3544);
  for (let level = 0; level <= 12; level++) {
    const spec = ladder.levelSpec(level);
    const diameter = ladder.markerDiameter(ladder.visibleWidthForLevel(level));
    assert.ok(
      Math.abs(diameter - spec.markerPx) <= 0.05,
      `${spec.id}: диаметр ${diameter} px не совпадает с ${spec.markerPx} px`,
    );
  }

  // Концы ряда §6.2: 2,5 px на L0 и 40 px на L12; кламп сохраняется глубже.
  assert.equal(ladder.markerDiameter(10000), 2.5);
  assert.equal(ladder.markerDiameter(ladder.visibleWidthForLevel(12)), 40);
  assert.equal(ladder.markerDiameter(3.84), 40);
  assert.equal(ladder.markerDiameter(2), 40);
  assert.equal(ladder.markerDiameter(10000), 2.5);
  assert.ok(ladder.markerDiameter(4999) > ladder.markerDiameter(5000));
  assert.ok(ladder.markerDiameter(5000) > ladder.markerDiameter(5001));
});

test('edgeDistance остаётся справочной метрикой в св.г.', () => {

  for (const viewport of VIEWPORTS) {
    const scale = ladder.scaleForEdgeDistance(viewport, 1);
    assert.ok(scale > 0, `масштаб не положителен для ${viewport.w}×${viewport.h}`);
    assert.equal(scale, Math.min(viewport.w, viewport.h) / 2);

    const edgeDist = ladder.edgeDistance(viewport, scale);
    assert.ok(
      near(edgeDist, 1, EPS),
      `edgeDistance(${viewport.w}×${viewport.h}) = ${edgeDist}, ожидалось 1 ± 1e-9`,
    );
    // По короткой оси на этом масштабе — 2 000 единиц (2,00 св.г.).
    const shortWidthUnits = Math.min(viewport.w, viewport.h) / scale;
    assert.ok(near(shortWidthUnits, 2, EPS), `ширина ${shortWidthUnits} вместо 2 св.г.`);
    assert.ok(near(units.unitsToLy(shortWidthUnits), 2, EPS));
    assert.ok(near(2 * edgeDist, 2, EPS));
  }
});

test('регрессия «метрику не подменили»: edgeDistance считается по короткой оси в св.г.', () => {
  assert.ok(near(ladder.visibleWidthForLevel(8), widthOf(8), EPS));
  assert.equal(ladder.visibleWidthForLevel(12), widthOf(12));
  assert.equal(ladder.visibleWidthLyForLevel(12), widthOf(12));
  assert.ok(near(ladder.visibleWidthLyForLevel(8), widthOf(8), EPS));
  assert.ok(near(ladder.visibleWidthLyForLevel(2), widthOf(2), EPS));

  for (const viewport of VIEWPORTS) {
    for (const edgeLy of [0.25, 1, 2.5]) {
      const measured = ladder.edgeDistance(viewport, ladder.scaleForEdgeDistance(viewport, edgeLy));
      assert.ok(near(measured, edgeLy, EPS), `${viewport.w}×${viewport.h}: ${measured} вместо ${edgeLy} св.г.`);
    }
  }
});

test('C1: maxScale = 500 px/св.г. на пяти viewport и L12 удерживается на 3,84 св.г.', () => {
  for (const viewport of VIEWPORTS) {
    const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
    assert.ok(
      near(maxScale, 500, EPS),
      `${viewport.w}×${viewport.h}: maxScale ${maxScale} px/св.г., ожидалось 500`,
    );
    assert.ok(near(maxScale, 1 / units.TARGET_LY_PER_PX, EPS));
    // На упоре полная ширина кадра — ровно ширина L9 на любом экране.
    assert.ok(near(viewport.w / maxScale, viewport.w * units.TARGET_LY_PER_PX, EPS));
    // На 1920 px ширина 3,84 св.г. остаётся на L12; экраны шире могут срезать viewport за предел L12.
    if (viewport.w === 1920) assert.equal(ladder.levelForWidth(viewport.w / maxScale), 12);
    // Расстояние до границы на упоре — справочная величина по короткой оси.
    const edgeAtMax = ladder.edgeDistance(viewport, maxScale);
    assert.ok(
      near(edgeAtMax, viewport.expectedEdgeAtMax, EPS),
      `${viewport.w}×${viewport.h}: edgeDistance на упоре ${edgeAtMax} св.г. вместо ${viewport.expectedEdgeAtMax} св.г.`,
    );
  }
  assert.ok(near(ladder.fitScaleFor({ w: 1920, h: 1080 }, MAP_SIZE, FIT_INSET), 0.10152, EPS));
});

test('C2: оба направления viewport достигают предельного секторного уровня L12', () => {
  for (const viewport of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }]) {
    const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
    assert.ok(near(viewport.w / maxScale, viewport.w * 0.002, EPS));
    assert.equal(ladder.levelForWidth(viewport.w / maxScale), 12);
    assert.equal(ladder.levelForWidth(viewport.w / maxScale, 11), 12);
  }
});

test('C3: проход зумом от fitScale до maxScale проходит уровни подряд без пропусков', () => {
  const viewport = { w: 1920, h: 1080 };
  const fit = ladder.fitScaleFor(viewport, MAP_SIZE, FIT_INSET);
  const max = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
  const samples = 2000;

  let level = ladder.levelForWidth(viewport.w / fit);
  const visited = [level];
  for (let index = 1; index < samples; index++) {
    const scale = fit * (max / fit) ** (index / (samples - 1));
    const next = ladder.levelForWidth(viewport.w / scale, level);
    assert.ok(next >= level && next - level <= 1, `перескок уровня ${level} → ${next}`);
    if (next !== level) visited.push(next);
    level = next;
  }
  assert.equal(level, 12);
  // Все уровни L0…L12 достижимы обычным зумом.
  assert.deepEqual(visited, Array.from({ length: 13 }, (_, index) => index));
});

test('C10: readout на упоре 1920×1080 — 500 px/св.г. и edgeDistance 1,08 св.г. справочно', () => {
  const viewport = { w: 1920, h: 1080 };
  const fit = ladder.fitScaleFor(viewport, MAP_SIZE, FIT_INSET);
  const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
  assert.equal(maxScale, 500);
  assert.equal(units.formatDistanceLy(ladder.edgeDistance(viewport, maxScale), 'full'), '1,08' + units.NBSP + 'св.г.');
});

test('C11: grep-контроль — в лестнице нет старого предохранителя предела зума', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/atlas/level-ladder.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('MIN_CLAMP_EDGE_LY'), 'остался MIN_CLAMP_EDGE_LY');
  assert.ok(!source.includes('maxScaleForTargetEdge'), 'осталось старое имя maxScaleForTargetEdge');
  assert.ok(!source.includes('TARGET_EDGE_LY'), 'остался TARGET_EDGE_LY');
  assert.ok(!/0\.5/.test(source), 'в level-ladder.ts есть литерал 0.5');
});

test('метрика отклоняет нечисловые, нулевые и отрицательные входы', () => {
  const viewport = { w: 1920, h: 1080 };
  const badNumbers = [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, -0.94];
  for (const value of badNumbers) {
    assert.throws(() => ladder.edgeDistance(viewport, value), RangeError, `scale ${value}`);
    assert.throws(() => ladder.scaleForEdgeDistance(viewport, value), RangeError, `edgeDist ${value}`);
    assert.throws(() => ladder.fitScaleFor(viewport, value, 0.94), RangeError, `mapSize ${value}`);
    assert.throws(() => ladder.fitScaleFor(viewport, 10000, value), RangeError, `fitInset ${value}`);
    assert.throws(() => ladder.maxScaleForTargetWidth(viewport, value, 0.94), RangeError, `mapSize ${value}`);
    assert.throws(() => ladder.maxScaleForTargetWidth(viewport, 10000, value), RangeError, `fitInset ${value}`);
  }

  for (const broken of [{ w: 0, h: 1080 }, { w: 1920, h: -1080 }, { w: Number.NaN, h: 1080 }, { w: 1920, h: 0 }]) {
    assert.throws(() => ladder.edgeDistance(broken, 1), RangeError, JSON.stringify(broken));
    assert.throws(() => ladder.scaleForEdgeDistance(broken, 1), RangeError, JSON.stringify(broken));
    assert.throws(() => ladder.fitScaleFor(broken, 10000, 0.94), RangeError, JSON.stringify(broken));
    assert.throws(() => ladder.maxScaleForTargetWidth(broken, 10000, 0.94), RangeError, JSON.stringify(broken));
  }

  assert.throws(() => ladder.edgeDistance(null, 1), RangeError);
  assert.throws(() => ladder.edgeDistance(undefined, 1), RangeError);
});
