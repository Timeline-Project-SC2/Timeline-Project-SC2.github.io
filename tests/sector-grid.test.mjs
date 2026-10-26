import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const scene = require('../src/atlas/sector-scene.ts');
const ladder = require('../src/atlas/level-ladder.ts');
const address = require('../src/atlas/sector-address.ts');

const {
  GRID_CELL_MAX_PX,
  GRID_CELL_MIN_PX,
  GRID_FIRST_LEVEL,
  GRID_LAST_LEVEL,
  GRID_LINE_ALPHA_NESTED,
  GRID_LINE_ALPHA_PRIMARY,
  MAX_GRID_LABELS,
  MAX_GRID_LINES,
  cameraForLevel,
  gridFor,
  gridTiersFor,
  loupeLabelFits,
  screenToWorld,
} = scene;

const DESKTOP = { w: 1920, h: 1080 };
const PHONE = { w: 390, h: 844 };

/**
 * Эталон числа линий — таблица §17.3 (`v4-edits.md`), строки `L0…L12`:
 * 52, 129, 69, 171, 93, 50, 124, 67, 164, 88, 49, 117, 65 (максимум 171 на L3).
 */
const LINE_TABLE_17_3 = [52, 129, 69, 171, 93, 50, 124, 67, 164, 88, 49, 117, 65];

/**
 * Вывод таблицы §17.3 из правила п. 5: для каждого тира кадра число линий на
 * кадре `w × h` не больше `⌈w / cellPx⌉ + 1` вертикальных плюс `⌈h / cellPx⌉ + 1`
 * горизонтальных (`cellPx = cellSize · scale`), по старшему и вложенному тирам.
 * Оценка не зависит от положения камеры — это верхняя граница кадра 1920×1080;
 * фактический счёт с обрезкой по кадру и границам карты всегда не больше неё.
 */
function lineBudget(level, viewport = DESKTOP) {
  const scale = viewport.w / ladder.visibleWidthForLevel(level);
  const tiers = gridTiersFor(scale);
  const indexes = tiers.primary === tiers.nested ? [tiers.primary] : [tiers.primary, tiers.nested];
  let total = 0;
  for (const index of indexes) {
    const cellPx = address.ADDRESS_TIERS[index].cellSize * scale;
    total += Math.ceil(viewport.w / cellPx) + 1 + Math.ceil(viewport.h / cellPx) + 1;
  }

  return total;
}

function tiersOfLevel(level, viewport = DESKTOP) {
  return gridTiersFor(viewport.w / ladder.visibleWidthForLevel(level));
}

test('gridTiersFor: границы правила 450/16 и деривация тиров по масштабу (§17.3 п. 5)', () => {
  assert.equal(GRID_CELL_MAX_PX, 450);
  assert.equal(GRID_CELL_MIN_PX, 16);
  assert.equal(GRID_FIRST_LEVEL, 0);
  assert.equal(GRID_LAST_LEVEL, 12);

  // Ячейка старшего тира ровно 450 px — это ещё старший тир (T3 · 5,625 = 450).
  assert.deepEqual(gridTiersFor(450 / 80), { primary: 3, nested: 4 });
  // Чуть мельче — T3 уже шире 450 px, старшим становится T4 (90 px), вложенным T5 (18 px).
  assert.deepEqual(gridTiersFor(450 / 80 + 1e-6), { primary: 4, nested: 5 });
  // Вложенная ячейка ровно 16 px — вложенный тир ещё жив (T3 · 0,2 = 16).
  assert.deepEqual(gridTiersFor(16 / 80), { primary: 1, nested: 2 });
  // Мельче 16 px у следующего тира — сетка из одного старшего тира (T1 60 px, T2 12 px).
  assert.deepEqual(gridTiersFor(0.03), { primary: 1, nested: 1 });
  // Масштаб за пределом лестницы (`MAX_SCALE = 500`): 0,64 · 1 000 = 640 px > 450 —
  // деградация до одного самого мелкого тира T7 (128 px), второго тира нет.
  assert.deepEqual(gridTiersFor(1000), { primary: 7, nested: 7 });
  // Некорректный масштаб — RangeError, а не молчаливая пустая сетка.
  for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => gridTiersFor(scale), RangeError);
  }

  // Тиры на лестнице 1920×1080: T5 на L8 равен 3,2 · 35,369 = 113,18 px.
  const scale8 = DESKTOP.w / ladder.visibleWidthForLevel(8);
  const tiers8 = gridTiersFor(scale8);
  assert.equal(tiers8.primary, 5);
  assert.equal(tiers8.nested, 6);
  assert.ok(Math.abs(address.ADDRESS_TIERS[tiers8.primary].cellSize * scale8 - 113.181418) <= 0.001);
  assert.ok(Math.abs(address.ADDRESS_TIERS[tiers8.nested].cellSize * scale8 - 22.636284) <= 0.001);
});

test('таблица §17.3 воспроизводится правилом: 52…65 линий, максимум 171 на L3', () => {
  const actual = [];
  for (let level = 0; level <= 12; level += 1) actual.push(lineBudget(level));
  assert.deepEqual(actual, LINE_TABLE_17_3, `эталон §17.3: ${LINE_TABLE_17_3.join(', ')}`);

  assert.equal(Math.max(...actual), 171, 'максимум линий должен быть на L3');
  assert.equal(actual.indexOf(171), 3, 'максимум 171 — именно на L3');
  // Предохранитель не трогаем: 171 против 512 — запас почти 3×.
  assert.equal(MAX_GRID_LINES, 512);
  assert.equal(MAX_GRID_LABELS, 64);
  assert.ok(Math.max(...actual) < MAX_GRID_LINES);
});

test('L0…L12 на 1920×1080: непустая сетка, ровно два тира, α 0,16 и 0,07, не выше эталона', () => {
  for (let level = 0; level <= GRID_LAST_LEVEL; level += 1) {
    const { lines } = gridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level);
    const tiers = tiersOfLevel(level);
    const ids = [...new Set(lines.map((line) => line.tier))];

    assert.ok(lines.length > 0, `L${level}: сетка пуста`);
    assert.equal(ids.length, 2, `L${level}: в кадре ${ids.length} тира вместо двух`);
    assert.ok(ids.includes(address.ADDRESS_TIERS[tiers.primary].id), `L${level}: нет старшего тира`);
    assert.ok(ids.includes(address.ADDRESS_TIERS[tiers.nested].id), `L${level}: нет вложенного тира`);
    assert.ok(lines.length <= lineBudget(level), `L${level}: линий ${lines.length} больше эталона §17.3`);
    // L0 — по решению F3-4 сетка живёт и на нулевом уровне (эталон §17.3 — 52 линии).
    if (level === 0) {
      assert.equal(lineBudget(0), 52);
      assert.ok(lines.length > 20, `L0: линий ${lines.length}, ждали плотную сетку`);
    }
  }
});

test('альфа: 0,16 у старшего тира и 0,07 у вложенного, других значений нет', () => {
  assert.equal(GRID_LINE_ALPHA_PRIMARY, 0.16);
  assert.equal(GRID_LINE_ALPHA_NESTED, 0.07);
  for (const viewport of [DESKTOP, PHONE, { w: 2560, h: 1440 }]) {
    for (let level = 0; level <= GRID_LAST_LEVEL; level += 1) {
      const { lines } = gridFor(viewport, cameraForLevel(level, 5000, 5000), level);
      const tiers = gridTiersFor(viewport.w / ladder.visibleWidthForLevel(level));
      const primaryId = address.ADDRESS_TIERS[tiers.primary].id;
      const nestedId = address.ADDRESS_TIERS[tiers.nested].id;
      for (const line of lines) {
        const expected = line.tier === primaryId ? 0.16 : 0.07;
        assert.equal(line.alpha, expected, `${viewport.w}×${viewport.h} L${level}: α ${line.alpha} у ${line.tier}`);
        assert.ok(line.alpha <= GRID_LINE_ALPHA_PRIMARY, 'глубже старшего ярче — нельзя');
        // Толщина одна: примитив не несёт толщины, иерархии по ней нет.
        assert.equal(line.strokeWidth, undefined);
        assert.ok(line.tier === primaryId || line.tier === nestedId);
      }
    }
  }
});

test('толщина линии 1 px и прозрачность из примитива — в рендерере нет своих чисел сетки', () => {
  const source = readFileSync(new URL('../src/atlas/canvas-renderer.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function drawGridLine(');
  const end = source.indexOf('function drawGridLabel(', start);
  assert.ok(start > 0 && end > start, 'в рендерере нет drawGridLine');
  const pass = source.slice(start, end);
  assert.ok(/lineWidth\s*=\s*1\b/.test(pass), 'толщина линии сетки не 1 px');
  assert.ok(/line\.alpha/.test(pass), 'рендерер не читает line.alpha');
  assert.ok(!/rgba\([^)]*\.07|rgba\([^)]*\.16/.test(pass), 'в рендерере хардкод альфы тиров');

  const labelStart = source.indexOf('function drawGridLabel(');
  const labelEnd = source.indexOf('function drawLoupeLabel(', labelStart);
  const labelPass = source.slice(labelStart, labelEnd);
  assert.ok(/strokeText\(/.test(labelPass), 'у подписи сетки нет контура');
  assert.ok(labelPass.indexOf('strokeText(') < labelPass.indexOf('fillText('), 'контур рисуется после заливки');
});

test('деградация до одного тира: превышение MAX_GRID_LINES = 512 не поднимает лимит', () => {
  // 12 000 × 8 000 на L5: T5 (100 px) даёт 202 линии, вложенный T6 (20 px) — 1 002,
  // итого 1 204 > 512 — по §17.3 п. 8 остаётся только старший тир.
  const big = { w: 12000, h: 8000 };
  const scale = big.w / ladder.visibleWidthForLevel(5);
  const tiers = gridTiersFor(scale);
  assert.deepEqual(tiers, { primary: 5, nested: 6 });
  const { lines } = gridFor(big, cameraForLevel(5, 5000, 5000), 5);
  const ids = [...new Set(lines.map((line) => line.tier))];
  assert.deepEqual(ids, [address.ADDRESS_TIERS[tiers.primary].id], 'остался не один тир');
  assert.ok(lines.length > 0 && lines.length <= MAX_GRID_LINES, `линий ${lines.length}`);
  for (const line of lines) assert.equal(line.alpha, GRID_LINE_ALPHA_PRIMARY);
});

test('порог подписи не ослаблен: 2 + 5,4 · длина ≤ cellPx (loupeLabelFits)', () => {
  // Порог из §17.3 п. 6: `2 + 5,4 · длина ≤ cellPx`, без послаблений.
  for (const text of ['X', 'REQHC', 'REQHCM', 'REQHCMX']) {
    const threshold = 2 + 5.4 * text.length;
    assert.equal(loupeLabelFits(text, threshold + 1e-9), true, `${text}: не влезла вплотную`);
    assert.equal(loupeLabelFits(text, threshold - 1e-9), false, `${text}: ослабленный порог`);
    assert.equal(loupeLabelFits(text, threshold * 2), true);
  }
});

test('подписи сетки не накладываются друг на друга и влезают в ячейку старшего тира', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    for (let level = 0; level <= GRID_LAST_LEVEL; level += 1) {
      const { lines, labels } = gridFor(viewport, cameraForLevel(level, 5000, 5000), level);
      const tiers = gridTiersFor(viewport.w / ladder.visibleWidthForLevel(level));
      const cellPx = address.ADDRESS_TIERS[tiers.primary].cellSize * (viewport.w / ladder.visibleWidthForLevel(level));
      const boxes = labels.map((label) => ({
        x0: label.x + 3,
        y0: label.y + 3,
        x1: label.x + 3 + 5.4 * label.text.length,
        y1: label.y + 3 + 9,
      }));
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i];
          const b = boxes[j];
          const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
          assert.ok(!overlap, `${viewport.w}×${viewport.h} L${level}: подписи ${i} и ${j} пересеклись`);
        }
      }
      // Подпись не шире своей ячейки — иначе это была бы плашка поверх соседей.
      for (const label of labels) {
        assert.ok(5.4 * label.text.length <= cellPx, `${label.text} шире ячейки ${cellPx}`);
      }
      assert.ok(lines.length > 0);
    }
  }
});

test('геометрия: линии стоят на границах ячеек ADDRESS_TIERS в мировых координатах', () => {
  for (const level of [0, 3, 8, 12]) {
    const camera = cameraForLevel(level, 5720, 6257);
    const { lines } = gridFor(DESKTOP, camera, level);
    const tiers = gridTiersFor(DESKTOP.w / ladder.visibleWidthForLevel(level));
    for (const line of lines) {
      const vertical = Math.abs(line.x1 - line.x2) < 1e-9;
      const world = vertical
        ? screenToWorld(DESKTOP, camera, line.x1, line.y1).x
        : screenToWorld(DESKTOP, camera, line.x1, line.y1).y;
      const remainder = Math.abs(world / line.cellSize - Math.round(world / line.cellSize));
      assert.ok(remainder < 1e-6, `L${level}: линия ${line.tier} не на границе ячейки (${world})`);
      assert.ok(line.cellSize === address.ADDRESS_TIERS[tiers.primary].cellSize
        || line.cellSize === address.ADDRESS_TIERS[tiers.nested].cellSize);
    }
  }
});
