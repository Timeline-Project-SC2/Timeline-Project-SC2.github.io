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
  MAX_GRID_LINES,
  MIN_DRAWABLE_PX,
  TERRITORY_LEVELS,
  buildSectorScene,
  cameraEdgeDistance,
  cameraForLevel,
  clusterSystems,
  gridFor,
  hitRadiusFor,
  labelTextFor,
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

test('сетка адресов живёт на L1…L8, берёт тир из кодека, а на L8 её гасит MAX_GRID_LINES', () => {
  assert.equal(GRID_TIER_BY_LEVEL.length, ladder.LEVELS.filter((spec) => spec.frame === 'S').length);
  assert.equal(GRID_LAST_LEVEL, 8);

  const expectedTier = { 1: 'T1', 2: 'T1', 3: 'T2', 4: 'T2', 5: 'T3', 6: 'T3', 7: 'T4', 8: 'T5' };
  for (let level = 0; level <= ladder.DEEPEST_SECTOR_LEVEL; level++) {
    const result = sceneAt(level);
    const lines = result.primitives.filter((primitive) => primitive.kind === 'grid.line');
    const labels = result.primitives.filter((primitive) => primitive.kind === 'grid.label');

    if (level === 0 || level > GRID_LAST_LEVEL) {
      assert.equal(lines.length, 0, `L${level}: сетка не должна рисоваться`);
      assert.equal(labels.length, 0);
      continue;
    }
    if (level === GRID_LAST_LEVEL) {
      // Z-4b: на L8 полная ширина 1291,55 ед. при ячейке T5 3,2 ед. — это
      // сотни линий, и предохранитель `MAX_GRID_LINES` честно гасит сетку
      // целиком, а не рисует часть кадра за бюджетом.
      assert.equal(lines.length, 0, 'L8: предохранитель MAX_GRID_LINES не сработал');
      assert.equal(labels.length, 0);
      continue;
    }

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

test('территории фракций считаются по системам и живут только на L2…L6', () => {
  assert.deepEqual([...TERRITORY_LEVELS], [2, 3, 4, 5, 6]);

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
    }
  }

  const territories = territoriesFor(SYSTEMS, DESKTOP, cameraForLevel(3, 5720, 6257), 3);
  const dominion = territories.find((territory) => territory.faction === 'Доминион Терран');
  assert.ok(dominion !== undefined);
  assert.equal(dominion.systems, 2);
  assert.equal(dominion.centerX, (5720 + 5750) / 2);
  assert.equal(dominion.centerY, (6257 + 6300) / 2);
  assert.ok(Math.abs(dominion.radius - Math.hypot(15, 21.5)) <= 1e-9);
  // Система без фракции в территории не попадает.
  assert.ok(!territories.some((territory) => territory.faction === ''));
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
