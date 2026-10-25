import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scene = require('../src/atlas/sector-scene.ts');
const ladder = require('../src/atlas/level-ladder.ts');
const address = require('../src/atlas/sector-address.ts');

const {
  APERTURE_FIRST_LEVEL,
  GRID_LAST_LEVEL,
  GRID_TIER_BY_LEVEL,
  LABEL_PRIORITY,
  LOUPE_CHAR_PX,
  LOUPE_LABEL_PAD_PX,
  LOUPE_MIN_CELL_PX,
  MAX_GRID_LABELS,
  MAX_GRID_LINES,
  MAX_LOUPE_LABELS,
  MAX_LOUPE_LINES,
  MIN_DRAWABLE_PX,
  TERRITORY_LEVELS,
  buildSectorScene,
  cameraEdgeDistance,
  cameraForLevel,
  clusterSystems,
  gridFor,
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
  territoriesFor,
  worldToScreen,
} = scene;

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

/** План §6.2: диаметр маркера по уровням `L0…L9`. */
const PLAN_DIAMETERS = [2.5, 3.3, 4.5, 6.0, 8.0, 10.7, 14.3, 19.2, 25.6, 34.3];

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

test('размер маркера на L8 и L9 совпадает с планом §6.2, апертура — ровно на L9 (Z-4b §2)', () => {
  assert.equal(APERTURE_FIRST_LEVEL, 9);
  for (const [level, expected] of [ [8, 25.6], [9, 34.3] ]) {
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
    if (level === 9) {
      // Апертура активна ровно при level === 9, кольцо равно диаметру маркера.
      assert.ok(aperture !== undefined, 'L9: нет апертуры');
      assert.ok(Math.abs(aperture.ringDiameter - expected) <= 0.06);
      assert.match(aperture.hint, /войти/);
    } else {
      assert.equal(aperture, undefined, `L${level}: апертура должна включаться только на L9`);
      assert.equal(result.counts.apertures, 0);
    }
  }
});

test('маркер растёт с глубиной монотонно и совпадает с планом §6.2 на всех L0…L9', () => {
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

    // Мировой след маркера (сколько единиц карты занимает диск) при новой
    // лестнице растёт: диаметр растёт в 13,7 раза при размахе зума 10 раз
    // (`MARKER_EXPONENT = 1,1374` под шаг `10^(1/9)`, Z-4b §1).
    const footprint = diameter / pixelsPerLightYear(DESKTOP, cameraForLevel(level, 5720, 6257));
    assert.ok(footprint > previousFootprint, `L${level}: мировой след ${footprint} не растёт`);
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

test('сетка адресов живёт на L1…L8 по тирам Z-4c §1, берёт тир из кодека и не меняет тиры по уровням', () => {
  assert.equal(GRID_LAST_LEVEL, 8);

  const expectedTier = { 1: 'T1', 2: 'T1', 3: 'T2', 4: 'T2', 5: 'T2', 6: 'T2', 7: 'T2', 8: 'T2' };
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level);
    const lines = result.primitives.filter((primitive) => primitive.kind === 'grid.line');
    const labels = result.primitives.filter((primitive) => primitive.kind === 'grid.label');

    if (level === 0 || level > GRID_LAST_LEVEL) {
      assert.equal(lines.length, 0, `L${level}: сетка не должна рисоваться`);
      assert.equal(labels.length, 0);
      continue;
    }

    // Z-4c §1: на L8 сетка живёт (прежнее «на L8 пусто» было следствием старой таблицы).
    assert.ok(lines.length > 0, `L${level}: нет линий сетки`);
    const tierId = expectedTier[level];
    for (const line of lines) {
      assert.equal(line.tier, tierId, `L${level}: тир ${line.tier} вместо ${tierId}`);
      assert.ok(line.x1 >= -1e-9 && line.x1 <= DESKTOP.w + 1e-9);
      assert.ok(line.y1 >= -1e-9 && line.y1 <= DESKTOP.h + 1e-9);
    }
    for (const label of labels) {
      assert.equal(label.tier, tierId);
      assert.ok(label.text.startsWith('KP·'), `адресная метка «${label.text}» без префикса сектора`);
      const letters = ladder.levelSpec(level).addressLetters;
      assert.equal(label.text.length, 'KP·'.length + letters, `L${level}: метка «${label.text}» не той длины`);
      // Буквы — из алфавита кодека адреса, а не из сцены.
      for (const letter of label.text.slice('KP·'.length)) {
        assert.ok(address.ALPHABET.includes(letter), `метка «${label.text}» содержит не букву адреса`);
      }
    }
  }
});

test('G1: таблица обычной сетки — [null,1,1,2,2,2,2,2,2,null] (индекс = уровень L0…L9)', () => {
  assert.deepEqual([...GRID_TIER_BY_LEVEL], [null, 1, 1, 2, 2, 2, 2, 2, 2, null]);
  assert.equal(GRID_TIER_BY_LEVEL.length, ladder.DEEPEST_SECTOR_LEVEL + 1);
});

test('G2: число линий и подписей обычной сетки на 1920×1080 при центре кадра (допуск ±1)', () => {
  const expectedLines = { 1: 6, 2: 4, 3: 18, 4: 14, 5: 10, 6: 10, 7: 6, 8: 6 };
  const expectedLabels = { 1: 8, 2: 4, 3: 64, 4: 48, 5: 24, 6: 24, 7: 8, 8: 8 };
  for (const level of Object.keys(expectedLines).map(Number)) {
    const { lines, labels } = gridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level);
    assert.ok(
      Math.abs(lines.length - expectedLines[level]) <= 1,
      `L${level}: линий ${lines.length}, ждали ${expectedLines[level]} ±1`,
    );
    assert.ok(
      Math.abs(labels.length - expectedLabels[level]) <= 1,
      `L${level}: подписей ${labels.length}, ждали ${expectedLabels[level]} ±1`,
    );
  }
});

test('G3: на L8 сетка не пустая и линий меньше 12 — предохранитель MAX_GRID_LINES не срабатывает', () => {
  const { lines } = gridFor(DESKTOP, cameraForLevel(8, 5000, 5000), 8);
  assert.ok(lines.length > 0, 'L8: сетка пустая');
  assert.ok(lines.length < 12, `L8: линий ${lines.length}, ждали меньше 12`);
});

test('G4: лимиты обычной сетки не подняты: MAX_GRID_LINES = 512, MAX_GRID_LABELS = 64', () => {
  assert.equal(MAX_GRID_LINES, 512);
  assert.equal(MAX_GRID_LABELS, 64);
});

test('G5: лупа на L8 при 1920×1080: T4, ячейка 23,8 px, 26 линий, подписей не больше 9, окно в кадре', () => {
  const camera = cameraForLevel(8, 5000, 5000);
  const loupe = loupeGridFor(DESKTOP, camera, 8, { x: 960, y: 540 });

  assert.equal(loupe.tierIndex, 4);
  assert.equal(loupe.cellSize, 16);
  assert.ok(Math.abs(loupe.cellPx - 23.8) <= 0.1, `cellPx ${loupe.cellPx}, ждали 23,8 ±0,1`);
  assert.ok(Math.abs(loupe.cellPx - (1920 / ladder.visibleWidthForLevel(8)) * 16) < 1e-9);
  assert.equal(loupe.lines.length, 26);
  assert.ok(loupe.labels.length <= 9, `подписей ${loupe.labels.length} больше 9`);
  assert.ok(loupe.bounds !== null);
  const { x0, y0, x1, y1 } = loupe.bounds;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 <= DESKTOP.w && y1 <= DESKTOP.h, 'окно лупы вышло за кадр');
  assert.ok(x1 > x0 && y1 > y0);
  // Подпись лупы — только буквы до её тира (4 буквы, без «KP·»), не пятибуквенный адрес.
  for (const label of loupe.labels) assert.equal(label.text.length, 4);
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

test('G7: при LOUPE_MIN_CELL_PX = 200 глубина падает до базового тира, линий меньше, кадр не пуст', () => {
  assert.equal(LOUPE_MIN_CELL_PX, 22);
  const camera = cameraForLevel(8, 5000, 5000);
  const point = { x: 960, y: 540 };
  const normal = loupeGridFor(DESKTOP, camera, 8, point);
  const strict = loupeGridFor(DESKTOP, camera, 8, point, { minCellPx: 200 });

  assert.equal(normal.tierIndex, 4);
  // Ни один тир до базового (T2) не даёт 200 px, поэтому остаётся базовый тир.
  assert.equal(strict.tierIndex, 2);
  assert.ok(strict.tierIndex < normal.tierIndex);
  assert.ok(strict.lines.length > 0, 'кадр пустой');
  assert.ok(strict.lines.length < normal.lines.length, 'линий стало не меньше');
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

test('H1: на L8 при 1920×1080 тир T4, ячейка 23,8 px, подписи — 4 буквы и каждая влезает: 2 + 5,4·4 ≤ cellPx', () => {
  const loupe = loupeGridFor(DESKTOP, cameraForLevel(8, 5000, 5000), 8, { x: 960, y: 540 });
  assert.equal(loupe.tierIndex, 4);
  assert.ok(Math.abs(loupe.cellPx - 23.8) <= 0.1, `cellPx ${loupe.cellPx}`);
  assert.equal(loupe.labels.length, 9);
  for (const label of loupe.labels) {
    assert.equal(label.text.length, 4, `подпись «${label.text}» не из 4 букв`);
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

test('H3: центральная ячейка всегда имеет ровно одну непустую подпись — и при 200 px (базовый тир), и при нехватке места', () => {
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

  // Порог 200 px: тир упирается в базовый (T2), подпись центра одна и непустая.
  const strict = centreLabel(DESKTOP, 8, { minCellPx: 200 });
  assert.equal(strict.loupe.tierIndex, 2);
  assert.equal(strict.atCentre.length, 1);
  assert.ok(strict.atCentre[0].text.length > 0);

  // Ширина 1800 px: ячейка 23,8 → 22…23,6 px, полный текст не влезает — центр берёт одну букву.
  const narrow = centreLabel({ w: 1800, h: 1000 }, 8);
  assert.equal(narrow.loupe.tierIndex, 4);
  assert.equal(narrow.atCentre.length, 1, 'у центра нет подписи');
  assert.equal(narrow.atCentre[0].text.length, 1);
  // Соседи, которым полный текст не влез, пропущены: наложений нет.
  for (const label of narrow.loupe.labels) {
    if (label === narrow.atCentre[0]) continue;
    assert.ok(loupeLabelFits(label.text, narrow.loupe.cellPx));
  }

  // Обычный кадр: центр — полные 4 буквы.
  const normal = centreLabel(DESKTOP, 8);
  assert.equal(normal.atCentre.length, 1);
  assert.equal(normal.atCentre[0].text.length, 4);
});

test('H4: тиры лупы по уровням при 1920×1080 — L1 2, L3 3, L5 3, L7 3, L8 4 (L2, L4, L6 — 3)', () => {
  const expected = { 1: 2, 2: 3, 3: 3, 4: 3, 5: 3, 6: 3, 7: 3, 8: 4 };
  for (const level of Object.keys(expected).map(Number)) {
    const loupe = loupeGridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level, { x: 960, y: 540 });
    assert.equal(loupe.tierIndex, expected[level], `L${level}: тир T${loupe.tierIndex}, ждали T${expected[level]}`);
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

test('лупа на L0 и L9 не строится: базовой сетки на этих уровнях нет', () => {
  for (const level of [0, 9]) {
    const loupe = loupeGridFor(DESKTOP, cameraForLevel(level, 5000, 5000), level, { x: 960, y: 540 });
    assert.equal(loupe.tierIndex, null);
    assert.equal(loupe.lines.length, 0);
    assert.equal(loupe.bounds, null);
  }
});

test('адресные метки сетки совпадают с кодеком адреса на той же точке', () => {
  const level = 3;
  const camera = cameraForLevel(level, 5720, 6257);
  const { labels } = gridFor(DESKTOP, camera, level);
  assert.ok(labels.length > 0);

  for (const label of labels) {
    // Угол ячейки → её центр в мире → адрес по кодеку.
    const corner = screenToWorld(DESKTOP, camera, label.x, label.y);
    const cellSize = address.ADDRESS_TIERS[2].cellSize;
    const centerX = (Math.floor(corner.x / cellSize) + 0.5) * cellSize;
    const centerY = (Math.floor(corner.y / cellSize) + 0.5) * cellSize;
    const expected = address.formatAddress(address.prefixOf(centerX, centerY, ladder.levelSpec(level).addressLetters));
    assert.equal(label.text, expected, 'метка сетки не совпала с кодеком адреса');
  }
});

test('территории фракций считаются по системам и живут на L2…L9', () => {
  // С Z-4b глубина лестницы девять: поле фракции больше не обрезается на L6,
  // иначе на L6→L7 оно исчезало бы скачком (шов, запрещённый владельцем).
  assert.deepEqual([...TERRITORY_LEVELS], [2, 3, 4, 5, 6, 7, 8, 9]);

  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level, { systems: SYSTEMS });
    const territories = result.primitives.filter((primitive) => primitive.kind === 'territory');
    if (!TERRITORY_LEVELS.includes(level)) {
      assert.equal(territories.length, 0, `L${level}: территории не должны рисоваться`);
      continue;
    }
    assert.ok(territories.length > 0, `L${level}: территории пропали`);
    for (const territory of territories) {
      assert.ok(territory.systems >= 1);
      assert.ok(territory.radius >= 0);
      assert.ok(Number.isFinite(territory.x) && Number.isFinite(territory.y));
      assert.ok(territory.screenRadius >= 0);
      // Новый контракт Z-3.9: альфа слоя приходит из лестницы, а не из рендерера.
      assert.equal(
        territory.alpha,
        ladder.layerFillAlpha(level),
        `L${level}: альфа территории не из layerFillAlpha`,
      );
    }
  }

  const territories = territoriesFor(SYSTEMS, DESKTOP, cameraForLevel(3, 5720, 6257), 3);
  const dominion = territories.find((territory) => territory.faction === 'Доминион Терран');
  assert.ok(dominion !== undefined);
  assert.equal(dominion.systems, 2);
  assert.equal(dominion.centerX, (5720 + 5750) / 2);
  assert.equal(dominion.centerY, (6257 + 6300) / 2);
  assert.ok(Math.abs(dominion.radius - Math.hypot(15, 21.5)) <= 1e-9);
  assert.equal(dominion.alpha, ladder.layerFillAlpha(3), 'альфа территории на L3');
  // Система без фракции в территории не попадает.
  assert.ok(!territories.some((territory) => territory.faction === ''));
});

/* --------------------------------------- затухание территорий на глубине (Z-3.9) */

test('T7: территории на L7 и L9 не пуст, альфа = layerFillAlpha(level)', () => {
  for (const level of [7, 8, 9]) {
    const territories = territoriesFor(SYSTEMS, DESKTOP, cameraForLevel(level, 5720, 6257), level);
    assert.ok(territories.length > 0, `L${level}: поле фракции исчезло`);
    for (const territory of territories) {
      assert.equal(
        territory.alpha,
        ladder.layerFillAlpha(level),
        `L${level}: альфа ${territory.alpha} вместо ${ladder.layerFillAlpha(level)}`,
      );
      assert.ok(territory.alpha > 0, `L${level}: альфа слоя погасла в ноль`);
    }
    // Ниже L6 слой живёт, но слабеет: L7 и L9 стоят на нижней границе 0,25.
    assert.ok(Math.abs(ladder.layerFillAlpha(level) - ladder.LAYER_FILL_ALPHA_MIN) <= 1e-9);
  }

  // Появление на L7 — не скачок: L6 ярче L7, L7 не ноль.
  assert.ok(ladder.layerFillAlpha(6) > ladder.layerFillAlpha(7));
});

test('T8: на L1 и L0 территорий по-прежнему нет', () => {
  for (const level of [0, 1]) {
    assert.equal(TERRITORY_LEVELS.includes(level), false, `L${level} не должен давать территории`);
    const territories = territoriesFor(SYSTEMS, DESKTOP, cameraForLevel(level, 5720, 6257), level);
    assert.equal(territories.length, 0, `L${level}: территории не должны рисоваться`);

    const result = sceneAt(level, { systems: SYSTEMS });
    assert.equal(
      result.primitives.filter((primitive) => primitive.kind === 'territory').length,
      0,
      `L${level}: сцена вернула территории`,
    );
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
  assert.equal(stillMerged.length, 1, 'пара в 10 ед. на L5 должна оставаться кластером при новом следе маркера');
  const far = [
    near[0],
    { id: 'b', name: 'Бета', x: 5200, y: 5000, faction: null, type: 'system' },
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
  for (const level of [0, 3, 9]) {
    for (const viewport of [DESKTOP, PHONE]) {
      const result = buildSectorScene({
        systems: [],
        viewport,
        camera: cameraForLevel(level, 5000, 5000),
      });
      assert.equal(result.counts.markers, 0);
      assert.equal(result.counts.territories, 0);
      assert.equal(result.counts.apertures, 0);
      assert.equal(result.counts.labels, 0);
      assert.equal(result.counts.invalidSystems, 0);
      for (const primitive of result.primitives) {
        assert.ok(primitive.kind === 'grid.line' || primitive.kind === 'grid.label');
      }
      if (level === 0) assert.deepEqual(result.primitives, []);
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
  assert.ok(Math.abs(cameraEdgeDistance(DESKTOP, camera) - 1.0107600929450513) <= 1e-9);
  assert.ok(Math.abs(cameraEdgeDistance(PHONE, camera) - 1.7969068319023138) <= 1e-9);

  // На номинале L9 (полная ширина 1000 ед.): 1920×1080 → 0,28 св.г.
  // до ближайшей границы, 390×844 → 0,50 св.г. (Z-4b §3).
  const deepest = cameraForLevel(9, 5720, 6257);
  assert.ok(Math.abs(cameraEdgeDistance(DESKTOP, deepest) - 0.28125) <= 1e-9);
  assert.ok(Math.abs(cameraEdgeDistance(PHONE, deepest) - 0.5) <= 1e-9);
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
    camera: cameraForLevel(9, 5720, 6257),
  });
  const markers = markersOf(result);
  assert.equal(markers.length, 1, 'далёкая система не отсечена');
  assert.equal(markers[0].address, address.formatAddress(address.addressOf(CAPITAL.x, CAPITAL.y)));
  assert.equal(markers[0].address, 'KP·REQHC');
  assert.equal(markers[0].worldX, CAPITAL.x);
  assert.equal(markers[0].worldY, CAPITAL.y);
});

test('сцена детерминирована и слои идут в порядке §8.1', () => {
  const first = sceneAt(5);
  const second = sceneAt(5);
  assert.deepEqual(second, first);

  const order = first.primitives.map((primitive) => primitive.kind);
  const rank = { territory: 0, 'grid.line': 1, 'grid.label': 2, marker: 3, aperture: 4, label: 5 };
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
