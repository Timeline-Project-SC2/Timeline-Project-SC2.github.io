import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ladder = require('../src/atlas/level-ladder.ts');
const units = require('../src/atlas/sector-units.ts');

/** Ширина уровня `n` по формуле Z-4b: `10000 / 10^(n/9)` единиц карты. */
const widthOf = (level) => 10000 / 10 ** (level / 9);

const expectedRows = [
  [0, 'L0', 'S', widthOf(0), 0, 2.5, 8],
  [1, 'L1', 'S', widthOf(1), 1, 3.3, 8],
  [2, 'L2', 'S', widthOf(2), 2, 4.5, 10],
  [3, 'L3', 'S', widthOf(3), 2, 6.0, 10],
  [4, 'L4', 'S', widthOf(4), 3, 8.0, 12],
  [5, 'L5', 'S', widthOf(5), 3, 10.7, 12],
  [6, 'L6', 'S', widthOf(6), 4, 14.3, 14],
  [7, 'L7', 'S', widthOf(7), 4, 19.2, 14],
  [8, 'L8', 'S', widthOf(8), 5, 25.6, 16],
  // L9 — не литерал, а `lyToUnits(1)`; численно это та же тысяча.
  [9, 'L9', 'S', 1000, 5, 34.3, 16],
  [13, 'S0', 'O', 100, 5, 0, 16],
  [14, 'S1', 'O', 16, 5, 0, 16],
  [15, 'S2', 'O', 2, 5, 0, 16],
];

/** Пять viewport, сохранённых от прежних планов; maxScale теперь `viewport.w / 1000` px/ед. */
const VIEWPORTS = [
  { w: 1920, h: 1080, expectedMaxScale: 1.92, expectedEdgeAtMax: 0.28125 },
  { w: 1366, h: 768, expectedMaxScale: 1.366, expectedEdgeAtMax: 768 / (2 * 1.366 * 1000) },
  { w: 2560, h: 1440, expectedMaxScale: 2.56, expectedEdgeAtMax: 0.28125 },
  { w: 390, h: 844, expectedMaxScale: 0.39, expectedEdgeAtMax: 0.5 },
  { w: 844, h: 390, expectedMaxScale: 0.844, expectedEdgeAtMax: 390 / (2 * 0.844 * 1000) },
];

const MAP_SIZE = 10000;
const FIT_INSET = 0.94;
const EPS = 1e-9;

const near = (actual, expected, tolerance = EPS) => Math.abs(actual - expected) <= tolerance;

test('лестница содержит L0…L9 и нетронутый системный кадр с согласованной таблицей', () => {
  // 10 секторных записей L0…L9 + 3 системные S0…S2 (уровни 13…15).
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
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15],
  );

  for (const spec of ladder.LEVELS) {
    assert.equal(ladder.levelSpec(spec.level), spec);
    assert.equal(ladder.frameOf(spec.level), spec.frame);
    assert.equal(ladder.visibleWidthForLevel(spec.level), spec.visibleWidth);
    assert.equal(ladder.visibleWidthLyForLevel(spec.level), spec.visibleWidth / 1000);
  }
  assert.equal(ladder.visibleWidthLyForLevel(0), 10);
  assert.ok(near(ladder.visibleWidthLyForLevel(2), widthOf(2) / 1000, 1e-12));
  assert.ok(near(ladder.visibleWidthLyForLevel(7), widthOf(7) / 1000, 1e-12));
  assert.throws(() => ladder.levelSpec(16), RangeError);
  assert.throws(() => ladder.levelSpec(1.5), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(16), RangeError);
  assert.throws(() => ladder.visibleWidthLyForLevel(1.5), RangeError);
});

test('Z-4b: секторных уровней ровно 10, системный кадр не тронут (100 / 16 / 2)', () => {
  assert.equal(ladder.DEEPEST_SECTOR_LEVEL, 9);
  assert.deepEqual(
    ladder.LEVELS.filter((spec) => spec.frame === 'S').map((spec) => spec.id),
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'],
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

test('C12: levelSpec(10) бросает RangeError — лестница кончилась на L9', () => {
  for (const level of [10, 11, 12]) {
    assert.throws(() => ladder.levelSpec(level), RangeError, `levelSpec(${level})`);
    assert.throws(() => ladder.visibleWidthForLevel(level), RangeError, `visibleWidthForLevel(${level})`);
  }
});

test('C5/C6: width(n) = 10000 / 10^(n/9), а width(9) === lyToUnits(1) === 1000', () => {
  for (let level = 0; level <= 9; level++) {
    assert.ok(
      near(ladder.visibleWidthForLevel(level), widthOf(level), 1e-6),
      `L${level}: ${ladder.visibleWidthForLevel(level)} вместо ${widthOf(level)}`,
    );
  }
  assert.equal(ladder.visibleWidthForLevel(9), units.lyToUnits(1));
  assert.equal(units.lyToUnits(1), 1000);
  assert.equal(ladder.TARGET_WIDTH_LY, 1);
  assert.equal(ladder.visibleWidthForLevel(9), units.lyToUnits(ladder.TARGET_WIDTH_LY));
});

test('C8/C9: frameBudgetMs и addressLetters по таблице Z-4b', () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, level) => ladder.levelSpec(level).frameBudgetMs),
    [8, 8, 10, 10, 12, 12, 14, 14, 16, 16],
  );
  assert.ok(ladder.LEVELS.every((spec) => spec.frameBudgetMs <= 16));
  assert.deepEqual(
    Array.from({ length: 10 }, (_, level) => ladder.levelSpec(level).addressLetters),
    [0, 1, 2, 2, 3, 3, 4, 4, 5, 5],
  );
});

test('секторный уровень определяется точной геометрией и меняется монотонно', () => {
  assert.equal(ladder.MAX_VISIBLE_WIDTH, 10000);
  assert.equal(ladder.MIN_VISIBLE_WIDTH, 16000);
  assert.equal(ladder.levelForWidth(10000), 0);
  assert.equal(ladder.levelForWidth(16000), 0);
  // Ниже номинального L9 уровень не уходит: лестница кончается на 9.
  assert.equal(ladder.levelForWidth(1000), 9);
  assert.equal(ladder.levelForWidth(100), 9);
  assert.equal(ladder.levelForWidth(0), 9);
  assert.throws(() => ladder.levelForWidth(Number.NaN), RangeError);

  for (let level = 0; level <= 9; level++) {
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
  assert.equal(ladder.levelForWidth(7000), 1);
  assert.equal(ladder.levelForWidth(7000, 0), 0);

  const ascendThreshold = ladder.visibleWidthForLevel(1) * (1 + ladder.HYSTERESIS);
  assert.equal(ladder.levelForWidth(ascendThreshold, 1), 0);
  assert.equal(ladder.levelForWidth(ascendThreshold - 0.000001, 1), 1);

  assert.equal(ladder.levelForWidth(19.53125, 0), 1);
  assert.equal(ladder.levelForWidth(19.53125, 4), 5);
  assert.equal(ladder.levelForWidth(10000, 9), 8);
  // prev валидируется в 0…9 — диапазон новой лестницы, а не снятие проверки.
  assert.throws(() => ladder.levelForWidth(10000, 10), RangeError);
  assert.throws(() => ladder.levelForWidth(10000, 13), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, -1), RangeError);
  assert.throws(() => ladder.levelForWidth(1000, 1.5), RangeError);
});

test('C4/C4a/C4b: вход в L9 по точному порогу 1000, выход — по 1120 (асимметрия)', () => {
  // C4: точный порог, порог 0,88 к L9 не применяется.
  assert.equal(ladder.levelForWidth(1000, 8), 9);
  assert.equal(ladder.levelForWidth(1000), 9);
  assert.ok(ladder.visibleWidthForLevel(9) * (1 - ladder.HYSTERESIS) < 1000);
  // C4a: допуск округления полной ширины (например, `1920 / (1920 / 1000)`).
  assert.equal(ladder.levelForWidth(1000 * (1 + 1e-12), 8), 9);
  assert.equal(ladder.levelForWidth(1920 / (1920 / 1000), 8), 9);
  assert.equal(ladder.levelForWidth(1001, 8), 8);
  // C4b: полоса 1000…1120 однозначно L9 — выход L9 (1120) уже входа L8
  // (`width(8) * 0.88` = 1136,56), мёртвой зоны и мигания нет.
  assert.ok(near(ladder.visibleWidthForLevel(8) * (1 - ladder.HYSTERESIS), 1136.56, 0.01));
  assert.equal(ladder.levelForWidth(1119, 9), 9);
  assert.equal(ladder.levelForWidth(1120, 9), 8);
});

test('C4c: проход внутрь и обратно шагом 1 ед. — L9 включается и выключается по одному разу', () => {
  let level = 8;
  let entries = 0;
  for (let width = 1200; width >= 1000; width--) {
    const next = ladder.levelForWidth(width, level);
    if (level !== 9 && next === 9) entries++;
    assert.ok(next >= level, `приближение: уровень всплыл ${level} → ${next} на ${width}`);
    level = next;
  }
  assert.equal(level, 9);
  assert.equal(entries, 1);

  let exits = 0;
  for (let width = 1000; width <= 1200; width++) {
    const next = ladder.levelForWidth(width, level);
    if (level === 9 && next !== 9) exits++;
    assert.ok(next <= level, `отдаление: уровень погрузился ${level} → ${next} на ${width}`);
    level = next;
  }
  assert.equal(level, 8);
  assert.equal(exits, 1);
});

test('C4d: для n = 1…8 прежний гистерезис ±12 % не тронут', () => {
  for (let level = 1; level <= 8; level++) {
    const width = ladder.visibleWidthForLevel(level);
    assert.equal(ladder.levelForWidth(width * 0.89, level - 1), level - 1, `L${level}: 0,89 ещё снаружи`);
    assert.equal(ladder.levelForWidth(width * 0.88, level - 1), level, `L${level}: 0,88 — вход`);
    assert.equal(ladder.levelForWidth(width * 1.11, level), level, `L${level}: 1,11 ещё внутри`);
    assert.equal(ladder.levelForWidth(width * 1.12, level), level - 1, `L${level}: 1,12 — выход`);
  }
});

test('тысяча монотонных шагов зума не вызывает мигания уровней', () => {
  const samples = 1000;
  const deepestWidth = ladder.visibleWidthForLevel(9);
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
  assert.equal(changes, 9, `при приближении произошло ${changes} смен уровней`);

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
  assert.equal(changes, 9, `при отдалении произошло ${changes} смен уровней`);
});

test('C7: диаметр маркера непрерывно зависит от ширины и совпадает с таблицей', () => {
  assert.equal(ladder.MARKER_EXPONENT, 1.1374);
  for (let level = 0; level <= 9; level++) {
    const spec = ladder.levelSpec(level);
    const diameter = ladder.markerDiameter(ladder.visibleWidthForLevel(level));
    assert.ok(
      Math.abs(diameter - spec.markerPx) <= 0.05,
      `${spec.id}: диаметр ${diameter} px не совпадает с ${spec.markerPx} px`,
    );
  }

  // Концы ряда §6.2 и кламп: 34,3 px на L9 (допуск таблицы 0,05), 40 px глубже L9.
  assert.ok(Math.abs(ladder.markerDiameter(1000) - 34.3) <= 0.05);
  assert.equal(ladder.markerDiameter(1000).toFixed(1), '34.3');
  assert.equal(ladder.markerDiameter(500), 40);
  assert.equal(ladder.markerDiameter(2), 40);
  assert.equal(ladder.markerDiameter(10000), 2.5);
  assert.ok(ladder.markerDiameter(4999) > ladder.markerDiameter(5000));
  assert.ok(ladder.markerDiameter(5000) > ladder.markerDiameter(5001));
});

test('edgeDistance: масштаб для 1 св.г. до границы даёт ровно 1,000 на всех пяти viewport (§17.23)', () => {
  // Метрика «до границы» сохранена как есть: она больше не предел зума,
  // но `scaleForEdgeDistance` по-прежнему ей пользуются тесты и предохранители.
  assert.equal(ladder.TARGET_WIDTH_LY, 1);
  assert.equal(units.lyToUnits(ladder.TARGET_WIDTH_LY), 1000);

  for (const viewport of VIEWPORTS) {
    const scale = ladder.scaleForEdgeDistance(viewport, 1);
    assert.ok(scale > 0, `масштаб не положителен для ${viewport.w}×${viewport.h}`);
    assert.equal(scale, Math.min(viewport.w, viewport.h) / 2000);

    const edgeDist = ladder.edgeDistance(viewport, scale);
    assert.ok(
      near(edgeDist, 1, EPS),
      `edgeDistance(${viewport.w}×${viewport.h}) = ${edgeDist}, ожидалось 1 ± 1e-9`,
    );
    // По короткой оси на этом масштабе — 2 000 единиц (2,00 св.г.).
    const shortWidthUnits = Math.min(viewport.w, viewport.h) / scale;
    assert.ok(near(shortWidthUnits, 2000, EPS), `ширина ${shortWidthUnits} вместо 2000 ед`);
    assert.ok(near(units.unitsToLy(shortWidthUnits), 2, EPS));
    assert.ok(near(2 * edgeDist, 2, EPS));
  }
});

test('регрессия «метрику не подменили»: edgeDistance считается по короткой оси в св.г.', () => {
  assert.ok(near(ladder.visibleWidthForLevel(8), widthOf(8), EPS));
  assert.equal(ladder.visibleWidthForLevel(9), 1000);
  assert.ok(near(ladder.visibleWidthLyForLevel(8), widthOf(8) / 1000, EPS));
  assert.equal(ladder.visibleWidthLyForLevel(9), 1);
  assert.ok(near(ladder.visibleWidthLyForLevel(2), widthOf(2) / 1000, EPS));

  for (const viewport of VIEWPORTS) {
    for (const edgeLy of [0.25, 1, 2.5]) {
      const measured = ladder.edgeDistance(viewport, ladder.scaleForEdgeDistance(viewport, edgeLy));
      assert.ok(near(measured, edgeLy, EPS), `${viewport.w}×${viewport.h}: ${measured} вместо ${edgeLy} св.г.`);
    }
  }
});

test('C1: maxScale = viewport.w / 1000 на 1920 / 1366 / 2560 / 390 и полная ширина 1000 на упоре', () => {
  for (const viewport of VIEWPORTS) {
    const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
    assert.ok(
      near(maxScale, viewport.expectedMaxScale, EPS),
      `${viewport.w}×${viewport.h}: maxScale ${maxScale} px/ед вместо ${viewport.expectedMaxScale} px/ед`,
    );
    assert.ok(near(maxScale, viewport.w / units.lyToUnits(1), EPS));
    // На упоре полная ширина кадра — ровно ширина L9 на любом экране.
    assert.ok(near(viewport.w / maxScale, ladder.visibleWidthForLevel(9), EPS));
    assert.equal(ladder.levelForWidth(viewport.w / maxScale), 9);
    // Расстояние до границы на упоре — следствие пропорций, не предел:
    // 0,28 св.г. на широких экранах, 0,50 св.г. на портретном телефоне.
    const edgeAtMax = ladder.edgeDistance(viewport, maxScale);
    assert.ok(
      near(edgeAtMax, viewport.expectedEdgeAtMax, EPS),
      `${viewport.w}×${viewport.h}: edgeDistance на упоре ${edgeAtMax} св.г. вместо ${viewport.expectedEdgeAtMax} св.г.`,
    );
  }
  assert.ok(near(ladder.fitScaleFor({ w: 1920, h: 1080 }, MAP_SIZE, FIT_INSET), 0.10152, EPS));
});

test('C2: 1920×1080 и 1080×1920 дают на упоре один и тот же уровень L9', () => {
  for (const viewport of [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }]) {
    const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
    assert.ok(near(viewport.w / maxScale, 1000, EPS));
    assert.equal(ladder.levelForWidth(viewport.w / maxScale), 9);
    assert.equal(ladder.levelForWidth(viewport.w / maxScale, 8), 9);
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
  assert.equal(level, 9);
  // Все уровни достижимы обычным зумом, включая ранее недостижимые L3…L9.
  assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('C10: readout на упоре 1920×1080 — «1891%» и «0,28 св.г. до границы» (функции лестницы)', () => {
  const viewport = { w: 1920, h: 1080 };
  const fit = ladder.fitScaleFor(viewport, MAP_SIZE, FIT_INSET);
  const maxScale = ladder.maxScaleForTargetWidth(viewport, MAP_SIZE, FIT_INSET);
  assert.equal(Math.round(maxScale / fit * 100), 1891);
  assert.equal(units.formatDistanceLy(ladder.edgeDistance(viewport, maxScale), 'full'), '0,28' + units.NBSP + 'св.г.');
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
