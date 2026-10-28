import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scene = require('../src/atlas/sector-scene.ts');
const ladder = require('../src/atlas/level-ladder.ts');
const address = require('../src/atlas/sector-address.ts');
const { parseBounds } = require('../src/atlas/sector-bounds.ts');

const {
  APERTURE_FIRST_LEVEL,
  GRID_FIRST_LEVEL,
  GRID_LAST_LEVEL,
  GRID_LINE_ALPHA_NESTED,
  GRID_LINE_ALPHA_PRIMARY,
  LABEL_PRIORITY,
  LOUPE_CHAR_PX,
  LOUPE_LABEL_PAD_PX,
  LOUPE_MIN_CELL_PX,
  MAX_GRID_LABELS,
  MAX_GRID_LINES,
  MAX_LOUPE_LABELS,
  MAX_LOUPE_LINES,
  MIN_DRAWABLE_PX,
  boundsFor,
  buildSectorScene,
  cameraEdgeDistance,
  cameraForLevel,
  clusterSystems,
  gridFor,
  gridTiersFor,
  hitRadiusFor,
  inspectOf,
  inspectOnPointer,
  inspectPointFor,
  labelTextFor,
  loupeCommandCount,
  loupeGridFor,
  loupeLabelFits,
  pixelsPerLightYear,
  screenToWorld,
  sceneLevel,
  worldToScreen,
} = scene;

const SECTOR_BOUNDS = parseBounds(
  readFileSync(fileURLToPath(new URL('../data/sector-bounds.json', import.meta.url)), 'utf8'),
);

const DESKTOP = { w: 1920, h: 1080 };
const PHONE = { w: 390, h: 844 };
const CAPITAL = { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', type: 'capital' };
const SYSTEMS = [
  CAPITAL,
  { id: '2', name: 'Мория', x: 5568, y: 5994, faction: 'Кел-Морийский Синдикат', type: 'capital' },
  { id: '3', name: 'Умоджа', x: 5683, y: 5855, faction: 'Умоджанский Протекторат', type: 'capital' },
  { id: '4', name: 'Форт', x: 5750, y: 6300, faction: 'Доминион Терран', type: 'system' },
  { id: '5', name: 'Без фракции', x: 5700, y: 6280, faction: null, type: 'unknown' },
];

/** План §6.2: диаметр маркера по уровням `L0…L12`. */
const PLAN_DIAMETERS = [2.5, 3.1, 4.0, 5.0, 6.3, 7.9, 10.0, 12.6, 15.9, 20.0, 25.2, 31.8, 40.0];

function sceneAt(level, options = {}) {
  const viewport = options.viewport ?? DESKTOP;
  const camera = cameraForLevel(level, 5720, 6257);
  return buildSectorScene({ systems: options.systems ?? SYSTEMS, viewport, camera, ...options.extra });
}

function markersOf(result) {
  return result.primitives.filter((primitive) => primitive.kind === 'marker');
}

test('уровень кадра берётся из лестницы, а не считается заново', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
      const camera = cameraForLevel(level, 5720, 6257);
      assert.equal(camera.visibleWidth, ladder.visibleWidthForLevel(level));
      assert.equal(sceneLevel(camera.visibleWidth), level, `L${level} не определился по ширине`);

      const result = buildSectorScene({ systems: SYSTEMS, viewport, camera });
      assert.equal(result.level, level);
      assert.equal(result.frame, 'S');
      assert.equal(result.budgetMs, ladder.levelSpec(level).frameBudgetMs);
      assert.equal(
        ladder.levelForWidth(camera.visibleWidth),
        result.level,
        'сцена считает уровень не функцией лестницы',
      );
    }
  }
});

test('размер маркера на L11 и L12 совпадает с планом §6.2, апертура — ровно на L12', () => {
  assert.equal(APERTURE_FIRST_LEVEL, 12);
  for (const [level, expected] of [ [11, 31.8], [12, 40.0] ]) {
    const result = sceneAt(level);
    const markers = markersOf(result);
    assert.ok(markers.length > 0, `L${level}: в кадре нет маркеров`);
    for (const marker of markers) {
      assert.ok(
        Math.abs(marker.diameter - expected) <= 0.06,
        `L${level}: диаметр ${marker.diameter} вместо ${expected}`,
      );
      assert.equal(marker.diameter, ladder.markerDiameter(result.visibleWidth));
    }
    const aperture = result.primitives.find((primitive) => primitive.kind === 'aperture');
    if (level === 12) {
      // Апертура активна ровно при level === 12, кольцо равно диаметру маркера.
      assert.ok(aperture !== undefined, 'L12: нет апертуры');
      assert.ok(Math.abs(aperture.ringDiameter - expected) <= 0.06);
      assert.match(aperture.hint, /войти/);
    } else {
      assert.equal(aperture, undefined, `L${level}: апертура должна включаться только на L12`);
      assert.equal(result.counts.apertures, 0);
    }
  }
});

test('маркер растёт с глубиной монотонно и совпадает с планом §6.2 на всех L0…L12', () => {
  let previousDiameter = 0;
  let previousFootprint = 0;

  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level);
    const markers = markersOf(result);
    assert.ok(markers.length > 0, `L${level}: нет маркеров`);
    const diameter = markers[0].diameter;

    // С глубиной маркер только растёт — ровно плановые числа §6.2.
    assert.ok(diameter >= previousDiameter, `L${level}: диаметр ${diameter} меньше предыдущего ${previousDiameter}`);
    assert.ok(Math.abs(diameter - PLAN_DIAMETERS[level]) <= 0.06, `L${level}: ${diameter} вместо ${PLAN_DIAMETERS[level]}`);
    previousDiameter = diameter;

    // Мировой след сокращается при приближении: показатель 0,3544 меньше 1.
    const footprint = diameter / pixelsPerLightYear(DESKTOP, cameraForLevel(level, 5720, 6257));
    if (level > 0) assert.ok(footprint < previousFootprint, `L${level}: мировой след ${footprint} не сокращается`);
    previousFootprint = footprint;
  }
});

test('ничего мельче 0.25 px сцена не выдаёт (И-9)', () => {
  assert.equal(MIN_DRAWABLE_PX, 0.25);
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level);
    for (const primitive of result.primitives) {
      if (primitive.kind === 'marker' || primitive.kind === 'aperture') {
        const size = primitive.kind === 'marker' ? primitive.diameter : primitive.ringDiameter;
        assert.ok(size >= MIN_DRAWABLE_PX, `${primitive.kind} на L${level} размером ${size} px`);
        assert.ok(size <= 40 + 1e-9, `${primitive.kind} на L${level} больше клампа 40 px`);
      }
      if (primitive.kind === 'label') {
        assert.ok(primitive.height >= MIN_DRAWABLE_PX);
        assert.ok(primitive.fontSize >= MIN_DRAWABLE_PX);
      }
    }
  }
});

test('сетка L0…L12: два тира по gridTiersFor, L0 больше не пуст (G7.13, F3-4)', () => {
  assert.equal(GRID_FIRST_LEVEL, 0);
  assert.equal(GRID_LAST_LEVEL, 12);
  // Пары тиров — следствие правила §17.3 п. 5 при 1920×1080, а не таблица уровней:
  // scale = 1920 / visibleWidth(L); старший — минимальный i ≥ 1 с ячейкой ≤ 450 px,
  // вложенный — i+1, пока его ячейка ≥ 16 px. Числа: L0 T1 384 px + T2 76,8;
  // L3 T3 108,6 + T4 21,7; L8 T5 113,2 + T6 22,6; L12 T6 307,2 + T7 61,4.
  const expectedPairs = {
    0: ['T1', 'T2'], 1: ['T2', 'T3'], 2: ['T2', 'T3'], 3: ['T3', 'T4'],
    4: ['T3', 'T4'], 5: ['T3', 'T4'], 6: ['T4', 'T5'], 7: ['T4', 'T5'],
    8: ['T5', 'T6'], 9: ['T5', 'T6'], 10: ['T5', 'T6'], 11: ['T6', 'T7'],
    12: ['T6', 'T7'],
  };
  const tierIndex = (id) => address.ADDRESS_TIERS.findIndex((tier) => tier.id === id);
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level);
    const lines = result.primitives.filter((primitive) => primitive.kind === 'grid.line');
    const labels = result.primitives.filter((primitive) => primitive.kind === 'grid.label');
    const pair = expectedPairs[level];

    assert.ok(lines.length > 0, `L${level}: сетка пуста`);
    const seen = [...new Set(lines.map((line) => line.tier))].sort();
    assert.deepEqual(seen, [...pair].sort(), `L${level}: тиры ${seen.join('/')} вместо ${pair.join('/')}`);
    for (const line of lines) {
      const expectedAlpha = line.tier === pair[0] ? GRID_LINE_ALPHA_PRIMARY : GRID_LINE_ALPHA_NESTED;
      assert.equal(line.alpha, expectedAlpha, `L${level}: ${line.tier} с alpha ${line.alpha}`);
      assert.equal(line.cellSize, address.ADDRESS_TIERS[tierIndex(line.tier)].cellSize);
      assert.ok(line.x1 >= -1e-9 && line.x1 <= DESKTOP.w + 1e-9);
      assert.ok(line.y1 >= -1e-9 && line.y1 <= DESKTOP.h + 1e-9);
    }

    assert.ok(labels.length > 0, `L${level}: подписи сетки не построены`);
    const letters = tierIndex(pair[0]);
    for (const label of labels) {
      assert.equal(label.tier, pair[0], `L${level}: подпись не на старшем тире`);
      assert.ok(label.text.startsWith('KP·'), `адресная метка «${label.text}» без префикса сектора`);
      assert.equal(label.text.length, 'KP·'.length + letters, `L${level}: метка «${label.text}» не той длины`);
      // Буквы — из алфавита кодека адреса, а не из сцены.
      for (const letter of label.text.slice('KP·'.length)) {
        assert.ok(address.ALPHABET.includes(letter), `метка «${label.text}» содержит не букву адреса`);
      }
    }
  }
});

test('G2: сетка и подписи не пусты на L0…L12 и держатся в предохранителях 512/64', () => {
  // Число линий — только из правила §17.3 (эталон 52…65, максимум 171 на L3);
  // точная сверка таблицы §17.3 — в tests/sector-grid.test.mjs. Здесь — границы.
  for (let level = 0; level <= GRID_LAST_LEVEL; level++) {
    const { lines, labels } = gridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level);
    assert.ok(lines.length > 0, `L${level}: нет линий сетки`);
    assert.ok(lines.length <= MAX_GRID_LINES, `L${level}: линий ${lines.length} больше ${MAX_GRID_LINES}`);
    assert.ok(labels.length > 0, `L${level}: нет подписей сетки`);
    assert.ok(labels.length <= MAX_GRID_LABELS, `L${level}: подписей ${labels.length} больше ${MAX_GRID_LABELS}`);
  }
  // За пределами L0…L12 сетки нет.
  for (const level of [-1, 13]) {
    const outside = gridFor(DESKTOP, cameraForLevel(0, 5000, 5000), level);
    assert.equal(outside.lines.length, 0, `L${level}: сетка вне диапазона`);
    assert.equal(outside.labels.length, 0);
  }
});

test('G3: предохранитель MAX_GRID_LINES не поднят: при превышении остаётся один тир', () => {
  // 12 000 × 8 000 на L5: T5 (100 px) даёт 202 линии, вложенный T6 (20 px) — ещё 1 002;
  // в сумме 1 204 > 512, поэтому по §17.3 п. 8 в кадре остаётся только старший тир.
  const big = { w: 12000, h: 8000 };
  const { lines } = gridFor(big, cameraForLevel(5, 5000, 5000), 5);
  const tiers = [...new Set(lines.map((line) => line.tier))];
  assert.deepEqual(tiers, ['T5'], `остались тиры ${tiers.join('/')} вместо одного старшего`);
  assert.ok(lines.length > 0 && lines.length <= MAX_GRID_LINES, `линий ${lines.length}`);
});

test('G4: лимиты обычной сетки не подняты: MAX_GRID_LINES = 512, MAX_GRID_LABELS = 64', () => {
  assert.equal(MAX_GRID_LINES, 512);
  assert.equal(MAX_GRID_LABELS, 64);
});

test('G5: лупа на L8 при 1920×1080: T6, ячейка 22,6 px, окно в кадре', () => {
  const camera = cameraForLevel(8, 5000, 5000);
  const loupe = loupeGridFor(DESKTOP, camera, 8, { x: 960, y: 540 });

  // База — gridTiersFor(35,369).primary = T5 (113,2 px); порог LOUPE_MIN_CELL_PX = 22 px
  // пропускает T6 (0,64 · 35,369 = 22,636 px) и отсекает T7 (4,527 px).
  assert.equal(loupe.tierIndex, 6);
  assert.equal(loupe.cellSize, 0.64);
  assert.ok(Math.abs(loupe.cellPx - 22.636284) <= 0.001, `cellPx ${loupe.cellPx}, ждали 22,636 ±0,001`);
  assert.ok(Math.abs(loupe.cellPx - (1920 / ladder.visibleWidthForLevel(8)) * 0.64) < 1e-9);
  assert.ok(loupe.labels.length <= 9, `подписей ${loupe.labels.length} больше 9`);
  assert.ok(loupe.bounds !== null);
  const { x0, y0, x1, y1 } = loupe.bounds;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= DESKTOP.w && y1 <= DESKTOP.h, 'окно лупы вышло за кадр');
  assert.ok(x1 > x0 && y1 > y0);
  // Шесть букв T6 (2 + 5,4 · 6 = 34,4 px) в ячейку 22,6 px не влезают: у центра
  // подпись сокращается до одной последней буквы, остальные пропускаются.
  for (const label of loupe.labels) {
    assert.ok(label.text.length <= 1, `подпись «${label.text}» не влезла бы в ячейку`);
    assert.ok(loupeLabelFits(label.text, loupe.cellPx));
  }
});

test('G6: окно у края карты (точка 10;10) не выходит за [0, MAP_SIZE]', () => {
  const camera = cameraForLevel(8, 10, 10);
  const point = worldToScreen(DESKTOP, camera, 10, 10);
  const loupe = loupeGridFor(DESKTOP, camera, 8, point);

  assert.ok(loupe.bounds !== null);
  const corner0 = screenToWorld(DESKTOP, camera, loupe.bounds.x0, loupe.bounds.y0);
  const corner1 = screenToWorld(DESKTOP, camera, loupe.bounds.x1, loupe.bounds.y1);
  const mapSize = address.MAP_SIZE;
  for (const value of [corner0.x, corner0.y, corner1.x, corner1.y]) {
    assert.ok(value >= -1e-6 && value <= mapSize + 1e-6, `угол окна ${value} вне [0, ${mapSize}]`);
  }
  assert.ok(loupe.lines.length > 0);
});

test('G7: при LOUPE_MIN_CELL_PX = 200 глубина падает до базового тира, кадр не пуст', () => {
  assert.equal(LOUPE_MIN_CELL_PX, 22);
  const camera = cameraForLevel(8, 5000, 5000);
  const point = { x: 960, y: 540 };
  const normal = loupeGridFor(DESKTOP, camera, 8, point);
  const strict = loupeGridFor(DESKTOP, camera, 8, point, { minCellPx: 200 });
  const base = gridTiersFor(1920 / ladder.visibleWidthForLevel(8)).primary;

  assert.equal(base, 5);
  assert.equal(normal.tierIndex, 6);
  // Ни T5 (113,2 px), ни более мелкие тиры не достигают 200 px — остаётся база T5.
  assert.equal(strict.tierIndex, base);
  assert.ok(strict.lines.length > 0, 'кадр пустой');
  assert.ok(strict.lines.length <= normal.lines.length, 'линий стало больше');
});

test('G8: точка осмотра — центр кадра для сенсора до тапа и позиция указателя для мыши', () => {
  const camera = cameraForLevel(8, 5000, 5000);
  const centre = { x: DESKTOP.w / 2, y: DESKTOP.h / 2 };

  // Сенсор: без тапа точка — центр кадра; перемещение пальцем её не меняет.
  const touch = { ...inspectOf({}), on: true };
  assert.deepEqual(inspectPointFor(DESKTOP, touch), centre);
  Object.assign(touch, inspectOnPointer(touch, { kind: 'move', x: 300, y: 200, coarse: true }));
  assert.deepEqual(inspectPointFor(DESKTOP, touch), centre);
  assert.deepEqual(
    loupeGridFor(DESKTOP, camera, 8, inspectPointFor(DESKTOP, touch)),
    loupeGridFor(DESKTOP, camera, 8, centre),
    'лупа сенсора должна вызываться с центром кадра',
  );
  // Тап переносит точку осмотра в точку тапа.
  Object.assign(touch, inspectOnPointer(touch, { kind: 'tap', x: 700, y: 400, coarse: true }));
  assert.deepEqual(inspectPointFor(DESKTOP, touch), { x: 700, y: 400 });

  // Мышь: точка — позиция указателя; тап мышью её не трогает.
  const mouse = { ...inspectOf({}), on: true };
  Object.assign(mouse, inspectOnPointer(mouse, { kind: 'move', x: 300, y: 200, coarse: false }));
  assert.deepEqual(inspectPointFor(DESKTOP, mouse), { x: 300, y: 200 });
  assert.deepEqual(
    loupeGridFor(DESKTOP, camera, 8, inspectPointFor(DESKTOP, mouse)),
    loupeGridFor(DESKTOP, camera, 8, { x: 300, y: 200 }),
  );
  Object.assign(mouse, inspectOnPointer(mouse, { kind: 'tap', x: 900, y: 900, coarse: false }));
  assert.deepEqual(inspectPointFor(DESKTOP, mouse), { x: 300, y: 200 });

  // Уход указателя: точка сохраняется, наведение снято (окно рисуется с alpha 0,85).
  Object.assign(mouse, inspectOnPointer(mouse, { kind: 'leave' }));
  assert.equal(mouse.hovering, false);
  assert.deepEqual(inspectPointFor(DESKTOP, mouse), { x: 300, y: 200 });
});

test('H1: на L10 при 1920×1080 тир T6, ячейка 83,4 px и подписи из 6 букв влезают', () => {
  const loupe = loupeGridFor(DESKTOP, cameraForLevel(10, 5000, 5000), 10, { x: 960, y: 540 });
  // База L10 — T5 (417,0 px); порог 22 px пропускает вложенный T6 (0,64 · 130,30 = 83,394 px)
  // и отсекает T7 (16,679 px). Подпись глубиной 6 букв: 2 + 5,4 · 6 = 34,4 ≤ 83,4.
  assert.equal(loupe.tierIndex, 6);
  assert.equal(loupe.cellSize, 0.64);
  assert.ok(Math.abs(loupe.cellPx - 83.394250) <= 0.001, `cellPx ${loupe.cellPx}`);
  assert.equal(loupe.labels.length, 9);
  for (const label of loupe.labels) {
    assert.equal(label.text.length, 6, `подпись «${label.text}» не из 6 букв`);
    assert.ok(2 + 5.4 * label.text.length <= loupe.cellPx, `подпись «${label.text}» не влезает в ячейку`);
    assert.ok(loupeLabelFits(label.text, loupe.cellPx));
  }
});

test('H2: подписи лупы не пересекаются ни на одном уровне, размере кадра и пороге (допуск 0)', () => {
  const viewports = [DESKTOP, PHONE, { w: 2560, h: 1440 }, { w: 1800, h: 1000 }];
  const thresholds = [undefined, { minCellPx: 200 }];
  for (const viewport of viewports) {
    for (let level = 1; level <= GRID_LAST_LEVEL; level++) {
      for (const options of thresholds) {
        const loupe = loupeGridFor(viewport, cameraForLevel(level, 5000, 5000), level, {
          x: viewport.w / 2,
          y: viewport.h / 2,
        }, options);
        const boxes = loupe.labels.map((label) => ({
          x0: label.x,
          y0: label.y,
          x1: label.x + LOUPE_CHAR_PX * label.text.length,
          y1: label.y + 9,
        }));
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
            assert.ok(!overlap, `L${level} ${viewport.w}×${viewport.h}: подписи ${i} и ${j} пересеклись`);
          }
        }
      }
    }
  }
});

test('H3: центральная ячейка всегда имеет ровно одну непустую подпись — и на базовом тире, и при нехватке места', () => {
  const centreLabel = (viewport, level, options) => {
    const camera = cameraForLevel(level, 5000, 5000);
    const point = { x: viewport.w / 2, y: viewport.h / 2 };
    const loupe = loupeGridFor(viewport, camera, level, point, options);
    const world = screenToWorld(viewport, camera, point.x, point.y);
    const cellSize = loupe.cellSize;
    const corner = worldToScreen(viewport, camera, Math.floor(world.x / cellSize) * cellSize, Math.floor(world.y / cellSize) * cellSize);
    const atCentre = loupe.labels.filter((label) => Math.abs(label.x - corner.x) < 1e-6 && Math.abs(label.y - corner.y) < 1e-6);
    return { loupe, atCentre };
  };

  // Порог 200 px на L8: глубже базы T5 (113,2 px) не идём — подпись центра одна и непустая.
  const strict = centreLabel(DESKTOP, 8, { minCellPx: 200 });
  assert.equal(strict.loupe.tierIndex, 5);
  assert.equal(strict.atCentre.length, 1);
  assert.ok(strict.atCentre[0].text.length > 0);

  // {1800×1000} на L8: база T5 (3,2 · 33,16 = 106,1 px), T6 = 21,2 px ниже порога 22 —
  // в ячейку влезают полные 5 букв.
  const narrow = centreLabel({ w: 1800, h: 1000 }, 8);
  assert.equal(narrow.loupe.tierIndex, 5);
  assert.equal(narrow.atCentre.length, 1, 'у центра нет подписи');
  assert.equal(narrow.atCentre[0].text.length, 5);
  // Соседи, которым полный текст не влез, пропущены: наложений нет.
  for (const label of narrow.loupe.labels) {
    if (label === narrow.atCentre[0]) continue;
    assert.ok(loupeLabelFits(label.text, narrow.loupe.cellPx));
  }

  // DESKTOP L8: лупа уходит на T6 (22,6 px); шесть букв (34,4 px) не влезают —
  // центральная подпись сокращается до одной последней буквы.
  const normal = centreLabel(DESKTOP, 8);
  assert.equal(normal.loupe.tierIndex, 6);
  assert.equal(normal.atCentre.length, 1);
  assert.equal(normal.atCentre[0].text.length, 1);
});

test('H4: тиры лупы по уровням при 1920×1080 — база gridTiersFor плюс до двух шагов, потолок T7', () => {
  // Вывод по уровням (1920×1080): база = gridTiersFor(scale).primary (L0 T1, L1–L2 T2,
  // L3–L5 T3, L6–L7 T4, L8–L10 T5, L11–L12 T6), глубина — самый мелкий тир ≤ base+2
  // с ячейкой ≥ 22 px, иначе база. T7 (0,128) при base T6 — единственный шаг, влезающий
  // в потолок min(base+2, 7) = 7. Старые null на L10…L12 удалены осознанно (F3-5):
  // в кодеке есть T6/T7, и база на этих уровнях существует.
  const expectedBase = { 0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 3, 6: 4, 7: 4, 8: 5, 9: 5, 10: 5, 11: 6, 12: 6 };
  const expected = { 0: 2, 1: 3, 2: 3, 3: 3, 4: 4, 5: 4, 6: 5, 7: 5, 8: 6, 9: 6, 10: 6, 11: 7, 12: 7 };
  for (const level of Object.keys(expected).map(Number)) {
    const loupe = loupeGridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level, { x: 960, y: 540 });
    const base = gridTiersFor(1920 / ladder.visibleWidthForLevel(level)).primary;
    assert.equal(base, expectedBase[level], `L${level}: база T${base} вместо T${expectedBase[level]}`);
    assert.ok(loupe.tierIndex >= base && loupe.tierIndex <= Math.min(base + 2, 7), `L${level}: вне коридора базы`);
    assert.equal(loupe.tierIndex, expected[level], `L${level}: тир ${loupe.tierIndex}, ждали ${expected[level]}`);
  }
});

test('H5: в подписях лупы нет префикса сектора «KP·» на всех уровнях и размерах кадра', () => {
  for (const viewport of [DESKTOP, PHONE, { w: 2560, h: 1440 }]) {
    for (let level = 1; level <= GRID_LAST_LEVEL; level++) {
      const loupe = loupeGridFor(viewport, cameraForLevel(level, 5000, 5000), level, {
        x: viewport.w / 2,
        y: viewport.h / 2,
      });
      for (const label of loupe.labels) {
        assert.ok(!label.text.includes('KP·'), `L${level}: подпись «${label.text}» содержит префикс сектора`);
      }
    }
  }
  assert.equal(LOUPE_LABEL_PAD_PX, 2);
  assert.equal(LOUPE_CHAR_PX, 5.4);
});

test('лупа: команд отрисовки не больше 26 + 9·3 на L8 при 1920×1080, 390×844 и 2560×1440', () => {
  for (const viewport of [DESKTOP, PHONE, { w: 2560, h: 1440 }]) {
    const loupe = loupeGridFor(viewport, cameraForLevel(8, 5000, 5000), 8, { x: viewport.w / 2, y: viewport.h / 2 });
    const commands = loupeCommandCount(loupe);
    assert.ok(commands <= MAX_LOUPE_LINES + MAX_LOUPE_LABELS * 3, `${viewport.w}×${viewport.h}: команд ${commands}`);
  }
});

test('лупа строится на всех L0…L12: null-тира больше нет, окно не пусто', () => {
  // Раньше лупа возвращала null на L0 и L10…L12: таблица «уровень → тир» обрывалась
  // на T3. После F3-5 база — gridTiersFor(scale).primary, поэтому тир есть всегда.
  for (let level = 0; level <= GRID_LAST_LEVEL; level++) {
    const loupe = loupeGridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level, { x: 960, y: 540 });
    assert.notEqual(loupe.tierIndex, null, `L${level}: лупа не построена`);
    assert.ok(loupe.cellSize > 0, `L${level}: размер ячейки лупы 0`);
    assert.ok(loupe.lines.length > 0, `L${level}: нет линий лупы`);
    assert.ok(loupe.bounds !== null, `L${level}: нет окна лупы`);
  }

  // 390×844 на L9: база T4 (220,6 px), T5 (44,1 px) — выше порога 22 px.
  const loupe9Phone = loupeGridFor(PHONE, cameraForLevel(9, 5000, 5000), 9, { x: 195, y: 422 });
  assert.equal(loupe9Phone.tierIndex, 5);
  assert.ok(loupe9Phone.lines.length > 0);

  // Порог 200 px на 1920×1080 L9 упирается в базу T5 (217,2 px).
  const loupe9Base = loupeGridFor(DESKTOP, cameraForLevel(9, 5000, 5000), 9, { x: 960, y: 540 }, { minCellPx: 200 });
  assert.equal(loupe9Base.tierIndex, 5);
  assert.ok(loupe9Base.lines.length > 0);
});

test('адресные метки сетки совпадают с кодеком адреса на той же точке', () => {
  const level = 3;
  const camera = cameraForLevel(level, 5720, 6257);
  const { labels } = gridFor(DESKTOP, camera, level);
  assert.ok(labels.length > 0);

  // Старший тир кадра — из gridTiersFor, а не из таблицы уровней: на L3 это T3 (80 св.г.),
  // значит и ячейка подписи 80, и букв в адресе три («KP·REQ»).
  const tiers = gridTiersFor(DESKTOP.w / ladder.visibleWidthForLevel(level));
  const cellSize = address.ADDRESS_TIERS[tiers.primary].cellSize;
  assert.equal(cellSize, 80);
  for (const label of labels) {
    // Угол ячейки → её центр в мире → адрес по кодеку.
    const corner = screenToWorld(DESKTOP, camera, label.x, label.y);
    const centerX = (Math.floor(corner.x / cellSize) + 0.5) * cellSize;
    const centerY = (Math.floor(corner.y / cellSize) + 0.5) * cellSize;
    const expected = address.formatAddress(address.prefixOf(centerX, centerY, tiers.primary));
    assert.equal(label.text, expected, 'метка сетки не совпала с кодеком адреса');
  }
});

test('на L0…L12 сцена не содержит ни одного примитива kind === \'territory\'', () => {
  assert.equal(scene.TERRITORY_LEVELS, undefined);
  assert.equal(scene.territoriesFor, undefined);
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level, { systems: SYSTEMS, extra: { sectorBounds: SECTOR_BOUNDS } });
    assert.equal(
      result.primitives.filter((primitive) => primitive.kind === 'territory').length,
      0,
      `L${level}: сцена содержит удалённый примитив territory`,
    );
    assert.equal('territories' in result.counts, false);
  }
});

test('B1–B4: контуры границ сектора и гало на L0…L12 (data/sector-bounds.json)', () => {
  // B1: на L0 и на L9 сцена содержит 4 примитива kind 'bounds' при переданных данных и 0 — без них.
  for (const level of [0, 12]) {
    const withBounds = sceneAt(level, { extra: { sectorBounds: SECTOR_BOUNDS } });
    const items = withBounds.primitives.filter((primitive) => primitive.kind === 'bounds');
    assert.equal(items.length, 4, `L${level}: ожидалось 4 примитива bounds`);
    assert.equal(withBounds.counts.bounds, 4);

    const omitted = sceneAt(level);
    assert.equal(omitted.primitives.filter((primitive) => primitive.kind === 'bounds').length, 0);
    assert.equal(omitted.counts.bounds, 0);

    const explicitNull = sceneAt(level, { extra: { sectorBounds: null } });
    assert.equal(explicitNull.primitives.filter((primitive) => primitive.kind === 'bounds').length, 0);
    assert.equal(boundsFor(null, DESKTOP, cameraForLevel(level)).length, 0);
  }

  // B2: сохраняем полный непрерывный контур; кадр обрезается только при рисовании.
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    for (const [cx, cy] of [[5000, 5000], [8024, 2788]]) {
      const built = buildSectorScene({
        systems: SYSTEMS,
        viewport: DESKTOP,
        camera: cameraForLevel(level, cx, cy),
        sectorBounds: SECTOR_BOUNDS,
      });
      const items = built.primitives.filter((primitive) => primitive.kind === 'bounds');
      assert.equal(items.length, SECTOR_BOUNDS.bounds.length);
      for (const item of items) {
        const source = SECTOR_BOUNDS.bounds.find((entry) => entry.id === item.id);
        assert.ok(source);
        assert.equal(item.points.length, source.points.length, `L${level} ${item.id}: вершины не должны теряться вне viewport`);
        assert.ok(item.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
        if (item.boundsKind !== 'halo') {
          assert.deepEqual(item.points[0], item.points.at(-1), `L${level} ${item.id}: замкнутый контур должен оставаться замкнутым`);
        }
      }
    }
  }
  const visibleArcL9 = boundsFor(SECTOR_BOUNDS, DESKTOP, cameraForLevel(12, 8024, 2788))
    .find((item) => item.id === 'sector.outline');
  assert.ok(visibleArcL9 !== undefined && visibleArcL9.points.length > 0, 'на L12 у вершины контура должна остаться видимая дуга');

  // B3: у гало dash = [12, 8], у контура сектора dash пуст.
  const l0Bounds = boundsFor(SECTOR_BOUNDS, DESKTOP, cameraForLevel(0, 5000, 5000));
  const halo = l0Bounds.find((item) => item.boundsKind === 'halo');
  const outline = l0Bounds.find((item) => item.boundsKind === 'sector');
  assert.ok(halo !== undefined && outline !== undefined);
  assert.deepEqual(halo.dash, [12, 8]);
  assert.deepEqual(outline.dash, []);

  // B4: порядок — все 'bounds' идут раньше любого 'marker' и сетки.
  for (const level of [0, 3, 12]) {
    const built = sceneAt(level, { extra: { sectorBounds: SECTOR_BOUNDS } });
    let lastBoundsIndex = -1;
    let firstOtherIndex = Infinity;
    built.primitives.forEach((primitive, idx) => {
      if (primitive.kind === 'bounds') {
        lastBoundsIndex = idx;
      } else if (primitive.kind === 'grid.line' || primitive.kind === 'grid.label' || primitive.kind === 'marker') {
        firstOtherIndex = Math.min(firstOtherIndex, idx);
      }
    });
    assert.ok(lastBoundsIndex >= 0);
    assert.ok(lastBoundsIndex < firstOtherIndex, `L${level}: bounds должны идти раньше сетки и маркеров`);
  }
});

test('кластеры: ближе 1.6 · d маркеры сливаются с числом, порядок входа не важен', () => {
  const near = [
    { id: 'a', name: 'Альфа', x: 5000, y: 5000, faction: null, type: 'system' },
    { id: 'b', name: 'Бета', x: 5010, y: 5000, faction: null, type: 'system' },
  ];
  const cameraL0 = cameraForLevel(0, 5000, 5000);

  const merged = clusterSystems(near, DESKTOP, cameraL0, ladder.markerDiameter(cameraL0.visibleWidth));
  assert.equal(merged.length, 1, 'системы ближе порога не слились');
  assert.equal(merged[0].clusterCount, 2);
  assert.equal(merged[0].name, 'Альфа');

  const reversed = clusterSystems(near.slice().reverse(), DESKTOP, cameraL0, ladder.markerDiameter(10000));
  assert.deepEqual(reversed, merged);

  // Порог слияния — в пикселях: при Z-4b мировой след маркера растёт с
  // глубиной (§1), поэтому та же пара в 10 ед. на L5 ещё слита (расстояние
  // в px меньше `1,6 · d`), а пара в 200 ед. там уже разъезжается.
  const cameraL5 = cameraForLevel(5, 5000, 5000);
  const stillMerged = clusterSystems(near, DESKTOP, cameraL5, ladder.markerDiameter(cameraL5.visibleWidth));
  assert.equal(stillMerged.length, 2, 'пара в 10 ед. на L5 не достигает порога слияния');
  const far = [
    near[0],
    { id: 'b', name: 'Бета', x: 5190, y: 5000, faction: null, type: 'system' }
  ];
  const apart = clusterSystems(far, DESKTOP, cameraL5, ladder.markerDiameter(cameraL5.visibleWidth));
  assert.equal(apart.length, 2);

  // Кластерная подпись показывает число присоединённых систем (на L2 — у кластера).
  assert.equal(labelTextFor(merged[0], 2), 'Альфа +1');
  assert.equal(labelTextFor(merged[0], 3), null, 'на L3 подписываются только столицы');
});

test('подписи: приоритет «столица → фракция → прочие» и текст по уровню', () => {
  assert.deepEqual(LABEL_PRIORITY, { capital: 100, faction: 50, system: 10 });

  const l3 = sceneAt(3);
  const markersL3 = markersOf(l3);
  const capitalLabel = l3.labels.placed.find((box) => box.id === '1');
  assert.ok(capitalLabel !== undefined, 'на L3 столица без подписи');
  assert.equal(capitalLabel.priority, LABEL_PRIORITY.capital);

  for (const marker of markersL3) {
    const text = labelTextFor(marker, 3);
    if (marker.labelPriority !== LABEL_PRIORITY.capital) {
      assert.equal(text, null, 'на L3 подписаны не только столицы');
    }
  }
  // На L0 и L1 подписей нет вовсе.
  assert.equal(sceneAt(0).counts.labels, 0);
  assert.equal(sceneAt(1).counts.labels, 0);
  // С L6 в подписи появляется тип системы.
  const l6 = sceneAt(6);
  assert.ok(l6.labels.placed.some((box) => box.text.includes('capital')));
});

test('подписи не пересекаются ни с маркерами, ни между собой на 390×844 и 1920×1080', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    for (const level of [3, 5, 8, 9]) {
      const result = sceneAt(level, {
        viewport,
        systems: [
          ...SYSTEMS,
          { id: '6', name: 'Тарсонис', x: 5712, y: 6290, faction: 'Доминион Терран', type: 'capital' },
          { id: '7', name: 'Чар', x: 5735, y: 6218, faction: 'Доминион Терран', type: 'capital' },
        ],
      });
      const labels = result.primitives.filter((primitive) => primitive.kind === 'label');
      const markers = markersOf(result);

      for (const [index, box] of labels.entries()) {
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.w && box.y + box.height <= viewport.h);
        for (const other of labels.slice(index + 1)) {
          const overlaps = box.x < other.x + other.width && other.x < box.x + box.width
            && box.y < other.y + other.height && other.y < box.y + box.height;
          assert.ok(!overlaps, `${viewport.w}×${viewport.h} L${level}: подписи ${box.id} и ${other.id} пересеклись`);
        }
        for (const marker of markers) {
          const overlay = box.x < marker.x + marker.diameter / 2 && marker.x - marker.diameter / 2 < box.x + box.width
            && box.y < marker.y + marker.diameter / 2 && marker.y - marker.diameter / 2 < box.y + box.height;
          assert.ok(!overlay, `подпись ${box.id} наехала на маркер ${marker.id}`);
        }
      }
    }
  }
});

test('пустой вход не падает: остаются только слои без данных', () => {
  for (const level of [0, 3, 12]) {
    for (const viewport of [DESKTOP, PHONE]) {
      const result = buildSectorScene({
        systems: [],
        viewport,
        camera: cameraForLevel(level, 5000, 5000),
      });
      assert.equal(result.counts.markers, 0);
      assert.equal(result.counts.bounds, 0);
      assert.equal(result.counts.apertures, 0);
      assert.equal(result.counts.labels, 0);
      assert.equal(result.counts.invalidSystems, 0);
      for (const primitive of result.primitives) {
        assert.ok(primitive.kind === 'grid.line' || primitive.kind === 'grid.label');
      }
      // L0 больше не пуст: сетка живёт с L0 (G7.13, F3-4), данных у неё нет — только линии.
      if (level === 0) assert.ok(result.counts.gridLines > 0, 'L0: сетка пуста');
    }
  }

  // Грязные записи отбрасываются со счётчиком, а не роняют кадр.
  const dirty = buildSectorScene({
    systems: [{ id: '', name: '', x: Number.NaN, y: 0 }, CAPITAL],
    viewport: DESKTOP,
    camera: cameraForLevel(8, 5720, 6257),
  });
  assert.equal(dirty.counts.invalidSystems, 1);
  assert.equal(dirty.counts.markers, 1);
});

test('проекция мира на кадр: центр в центре, обратное преобразование точное', () => {
  const camera = cameraForLevel(4, 5720, 6257);
  const scale = pixelsPerLightYear(DESKTOP, camera);
  // Масштаб — по полной ширине кадра (Z-4b §3): `viewport.w / visibleWidth`.
  assert.equal(scale, DESKTOP.w / camera.visibleWidth);

  const center = worldToScreen(DESKTOP, camera, 5720, 6257);
  assert.equal(center.x, DESKTOP.w / 2);
  assert.equal(center.y, DESKTOP.h / 2);

  const shifted = worldToScreen(DESKTOP, camera, 5820, 6257);
  assert.ok(Math.abs(shifted.x - (DESKTOP.w / 2 + 100 * scale)) <= 1e-9);

  const back = screenToWorld(DESKTOP, camera, shifted.x, shifted.y);
  assert.ok(Math.abs(back.x - 5820) <= 1e-9);
  assert.ok(Math.abs(back.y - 6257) <= 1e-9);

  // edgeDist сцены: масштаб из полной ширины, короткая ось — внутри
  // `edgeDistance`. Камера L4 задаёт видимую ширину 3593,81 ед.
  assert.ok(Math.abs(cameraEdgeDistance(DESKTOP, camera) - 207.21947508826554) <= 1e-9);
  assert.ok(Math.abs(cameraEdgeDistance(PHONE, camera) - 368.3901779346943) <= 1e-9);

  // На номинале L12 edgeDistance остаётся справочной метрикой по короткой оси.
  const deepest = cameraForLevel(12, 5720, 6257);
  assert.ok(Math.abs(cameraEdgeDistance(DESKTOP, deepest) - 1.1248811662712044) <= 1e-9);
  assert.ok(Math.abs(cameraEdgeDistance(PHONE, deepest) - 1.9997887400376964) <= 1e-9);
});

test('хит-зона: d + 6 px, на сенсоре не меньше 44 px', () => {
  assert.equal(hitRadiusFor(2.5), 8.5);
  assert.equal(hitRadiusFor(34.3), 40.3);
  assert.equal(hitRadiusFor(2.5, 'touch'), 44);
  assert.equal(hitRadiusFor(34.3, 'touch'), 44);
  assert.equal(hitRadiusFor(39.4, 'touch'), 45.4);

  const touch = buildSectorScene({
    systems: SYSTEMS,
    viewport: PHONE,
    camera: cameraForLevel(0, 5720, 6257),
    hitTarget: 'touch',
  });
  for (const marker of markersOf(touch)) {
    assert.ok(marker.hitRadius >= 44);
    assert.ok(marker.hitRadius >= marker.diameter + 6);
  }
});

test('маркеры отсечены по кадру и адрес берётся из кодека', () => {
  const far = { id: '9', name: 'Далёкая', x: 100, y: 100, faction: null, type: 'system' };
  const result = buildSectorScene({
    systems: [CAPITAL, far],
    viewport: DESKTOP,
    camera: cameraForLevel(12, 5720, 6257),
  });
  const markers = markersOf(result);
  assert.equal(markers.length, 1, 'далёкая система не отсечена');
  assert.equal(markers[0].address, address.formatAddress(address.addressOf(CAPITAL.x, CAPITAL.y)));
  assert.equal(markers[0].address, 'KP·REQHC');
  assert.equal(markers[0].worldX, CAPITAL.x);
  assert.equal(markers[0].worldY, CAPITAL.y);
});

test('сцена детерминирована и слои идут в порядке §8.1', () => {
  const first = sceneAt(5, { extra: { sectorBounds: SECTOR_BOUNDS } });
  const second = sceneAt(5, { extra: { sectorBounds: SECTOR_BOUNDS } });
  assert.deepEqual(second, first);

  const order = first.primitives.map((primitive) => primitive.kind);
  const rank = { bounds: 0, 'grid.line': 1, 'grid.label': 2, marker: 3, aperture: 4, label: 5 };
  for (let index = 1; index < order.length; index++) {
    assert.ok(rank[order[index]] >= rank[order[index - 1]], `слой ${order[index]} вышел раньше ${order[index - 1]}`);
  }
});

test('нечисловые входы сцены дают RangeError, а не тихую пустоту', () => {
  assert.throws(() => buildSectorScene({ systems: [], viewport: { w: 0, h: 100 }, camera: cameraForLevel(3) }), RangeError);
  assert.throws(() => buildSectorScene({ systems: [], viewport: null, camera: cameraForLevel(3) }), RangeError);
  assert.throws(
    () => buildSectorScene({ systems: [], viewport: DESKTOP, camera: { centerX: 0, centerY: 0, visibleWidth: 0 } }),
    RangeError,
  );
  assert.throws(
    () => buildSectorScene({ systems: [], viewport: DESKTOP, camera: { centerX: Number.NaN, centerY: 0, visibleWidth: 100 } }),
    RangeError,
  );
  assert.throws(() => worldToScreen(DESKTOP, { centerX: 0, centerY: 0, visibleWidth: -1 }, 0, 0), RangeError);
  assert.throws(() => hitRadiusFor(0), RangeError);
  assert.throws(() => sceneLevel(0), RangeError);
});

test('модуль без DOM: в исходниках нет canvas, document и случайности', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/atlas/sector-scene.ts', import.meta.url)), 'utf8');
  const layoutSource = readFileSync(fileURLToPath(new URL('../src/atlas/label-layout.ts', import.meta.url)), 'utf8');

  for (const banned of ['document.', 'window.', 'getContext', 'requestAnimationFrame', 'new Image', 'Math.random', 'Date.now', 'performance.now']) {
    assert.ok(!source.includes(banned), `в sector-scene.ts есть ${banned}`);
    assert.ok(!layoutSource.includes(banned), `в label-layout.ts есть ${banned}`);
  }
  // Никаких заглушек в рантайме.
  for (const placeholder of ['TODO', 'FIXME', 'XXX']) {
    assert.ok(!source.includes(placeholder), `в sector-scene.ts есть ${placeholder}`);
    assert.ok(!layoutSource.includes(placeholder), `в label-layout.ts есть ${placeholder}`);
  }
  // Пороги уровня не переписаны в сцене: импорт из лестницы обязателен.
  assert.ok(source.includes("from './level-ladder.ts'"));
  assert.ok(source.includes("from './label-layout.ts'"));
});
