import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const PlanetGlobe = require('../site/shared/planet-globe.ts').default;
const { buildGlobeGeometry } = require('../site/shared/planet-globe-pack.ts');

const V = 16;
const grid = GeodesicGrid.build(V);
const surface = PlanetSurface.generateSurface(grid, {
  masterSeedHex: '0123456789abcdef',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  geographyVersion: 'c100-soft-v2',
  // Нормы v=16 как доля канонической Земли v=128: тот же физический
  // масштаб, который worker строит для LOD-прокси.
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
});

test('planet-globe-v1: геометрия ячеек индексированная, полная и без дырок по индексам', () => {
  const geometry = buildGlobeGeometry(grid, surface, { colorMode: 'biome' });
  const expectedCells = 10 * V * V + 2;
  const expectedSides = grid.cellCorners.length;

  assert.equal(geometry.version, 'planet-globe-v1');
  assert.equal(geometry.cellCount, expectedCells);
  assert.equal(geometry.triangleCount, expectedSides);
  assert.equal(geometry.vertexCount, expectedCells + expectedSides);
  assert.equal(geometry.positions.length, geometry.vertexCount * 3);
  // CR-01 PR 4 (6.1): нормали рельефа i16x4 — вершина 24 Б (12+8+4).
  assert.equal(geometry.normals.length, geometry.vertexCount * 4);
  assert.equal(geometry.colors.length, geometry.vertexCount * 4);
  assert.equal(geometry.indices.length, expectedSides * 3);
  assert.equal(geometry.cellIndexStart.length, expectedCells + 1);
  assert.equal(geometry.cellIndexStart[expectedCells], geometry.indices.length);
  assert.equal(
    geometry.typedBytes,
    geometry.positions.byteLength + geometry.normals.byteLength +
      geometry.colors.byteLength + geometry.indices.byteLength,
  );
  // Нормали: 4-й компонент 0, вектор единичный в пределах квантования i16
  // и смотрит наружу (положительная проекция на радиус вершины).
  for (let i = 0; i < geometry.vertexCount; i++) {
    assert.equal(geometry.normals[i * 4 + 3], 0);
    const nx = geometry.normals[i * 4] / 32767;
    const ny = geometry.normals[i * 4 + 1] / 32767;
    const nz = geometry.normals[i * 4 + 2] / 32767;
    const len = Math.hypot(nx, ny, nz);
    assert.ok(len > 0.98 && len < 1.001, `normal length ${len} at ${i}`);
    const px = geometry.positions[i * 3];
    const py = geometry.positions[i * 3 + 1];
    const pz = geometry.positions[i * 3 + 2];
    const pLen = Math.hypot(px, py, pz) || 1;
    assert.ok((nx * px + ny * py + nz * pz) / pLen > 0.9, `normal outward at ${i}`);
  }

  for (let c = 0; c < expectedCells; c++) {
    const sides = grid.cellCornerStart[c + 1] - grid.cellCornerStart[c];
    assert.equal(geometry.cellIndexStart[c + 1] - geometry.cellIndexStart[c], sides * 3);
  }
  for (let i = 0; i < geometry.indices.length; i++) {
    assert.ok(geometry.indices[i] >= 0 && geometry.indices[i] < geometry.vertexCount);
  }
  for (let i = 0; i < geometry.positions.length; i++) assert.ok(Number.isFinite(geometry.positions[i]));

  // A-канал цвета кодирует край веера: центр 0, углы 255.
  assert.equal(geometry.colors[3], 0);
  assert.equal(geometry.colors[(geometry.cellCount + 1) * 4 + 3], 255);

  let rangeCells = 0;
  let rangeIndices = 0;
  for (const range of geometry.chunkRanges) {
    rangeCells += range.cellCount;
    rangeIndices += range.indexCount;
    assert.ok(range.indexStart >= 0);
    assert.ok(range.indexStart + range.indexCount <= geometry.indices.length);
    assert.ok(range.cosAngularRadius >= -1 && range.cosAngularRadius <= 1);
  }
  assert.equal(rangeCells, expectedCells);
  assert.equal(rangeIndices, geometry.indices.length);
});

test('planet-globe-v1: геометрия и цвета детерминированы для одинаковой поверхности', () => {
  const first = buildGlobeGeometry(grid, surface, { colorMode: 'rivers' });
  const second = buildGlobeGeometry(grid, surface, { colorMode: 'rivers' });
  assert.deepEqual(first.positions, second.positions);
  assert.deepEqual(first.colors, second.colors);
  assert.deepEqual(first.indices, second.indices);

  assert.deepEqual(first.normals, second.normals);

  const transferables = PlanetGlobe.listGeometryTransferables(first, false);
  assert.equal(transferables.length, 4);
  assert.ok(transferables.includes(first.normals.buffer));
  assert.ok(!transferables.includes(first.vertexCellId.buffer));
});

test('planet-globe-v1: все цветовые слои конечны, а речной слой реально выделяет сток', () => {
  for (const mode of PlanetGlobe.COLOR_MODES.map((item) => item.key)) {
    const colors = PlanetGlobe.buildCellColors(surface, mode);
    assert.equal(colors.length, surface.cellCount * 3, mode);
    for (let i = 0; i < colors.length; i++) {
      assert.ok(Number.isFinite(colors[i]), `${mode}:${i}`);
      assert.ok(colors[i] >= -1e-6 && colors[i] <= 1 + 1e-6, `${mode}:${i}=${colors[i]}`);
    }
  }

  const biome = PlanetGlobe.buildCellColors(surface, 'biome');
  const rivers = PlanetGlobe.buildCellColors(surface, 'rivers');
  let streamCell = -1;
  let bestStream = 0;
  for (let c = 0; c < surface.cellCount; c++) {
    if (surface.streamWeight[c] > bestStream) {
      bestStream = surface.streamWeight[c];
      streamCell = c;
    }
  }
  assert.ok(streamCell >= 0 && bestStream > 0.2, 'в тестовой поверхности должен быть заметный сток');
  assert.ok(rivers[streamCell * 3 + 2] > biome[streamCell * 3 + 2] + 0.15);
});

test('planet-globe-v1: рельеф поднимает сушу и опускает глубокий океан без разрыва полигона pick', () => {
  const geometry = buildGlobeGeometry(grid, surface, { colorMode: 'biome', reliefScale: 1 });
  const radiusOfCenter = (cell) => Math.hypot(
    geometry.positions[cell * 3],
    geometry.positions[cell * 3 + 1],
    geometry.positions[cell * 3 + 2],
  );
  let highLand = -1;
  let deepOcean = -1;
  for (let c = 0; c < surface.cellCount; c++) {
    if (highLand < 0 || surface.elevation[c] > surface.elevation[highLand]) highLand = c;
    if (deepOcean < 0 || surface.elevation[c] < surface.elevation[deepOcean]) deepOcean = c;
  }
  assert.ok(surface.elevation[highLand] > surface.seaLevel);
  assert.ok(surface.elevation[deepOcean] < surface.seaLevel);
  assert.ok(radiusOfCenter(highLand) > 1.005);
  assert.ok(radiusOfCenter(deepOcean) < 0.999);

  const polygon = PlanetGlobe.cellPolygon(grid, surface, highLand, { reliefScale: 1, inflate: 1.006 });
  const sides = grid.cellCornerStart[highLand + 1] - grid.cellCornerStart[highLand];
  assert.equal(polygon.corners.length, sides);
  assert.ok(Math.hypot(...polygon.center) > radiusOfCenter(highLand));
  for (const corner of polygon.corners) {
    for (const value of corner) assert.ok(Number.isFinite(value));
    assert.ok(Math.hypot(...corner) > 0.98 && Math.hypot(...corner) < 1.05);
  }
  assert.equal(PlanetGlobe.cellPolygon(grid, surface, -1), null);
});

test('planet-globe-v1: портретный FOV сохраняет горизонтальный угол и помещает планету по ширине', () => {
  const landscape = PlanetGlobe.fieldOfViewYForAspect(16 / 9);
  assert.ok(Math.abs(landscape - 42 * Math.PI / 180) < 1e-12);

  const portraitAspect = 9 / 19.5;
  const portrait = PlanetGlobe.fieldOfViewYForAspect(portraitAspect);
  const horizontalHalfTan = Math.tan(portrait / 2) * portraitAspect;
  assert.ok(Math.abs(horizontalHalfTan - Math.tan(landscape / 2)) < 1e-12);
  assert.ok(portrait > 1.25 && portrait < 1.45);

  // При стартовой дистанции 3.05 диск должен занимать меньше ширины,
  // а не ~170% кадра, как при фиксированном FOV 42° в портрете.
  const projectedRadiusNdc = 1 / (3.05 * horizontalHalfTan);
  assert.ok(projectedRadiusNdc > 0.8 && projectedRadiusNdc < 0.9);
});

test('planet-globe-v1: fallback-развёртка заполнена и сохраняет размер/альфу', () => {
  const preview = PlanetGlobe.buildEquirectPreview(grid, surface, 180, 90, 'biome');
  assert.equal(preview.width, 180);
  assert.equal(preview.height, 90);
  assert.equal(preview.data.length, 180 * 90 * 4);
  let nonBackground = 0;
  for (let i = 0; i < preview.data.length; i += 4) {
    assert.equal(preview.data[i + 3], 255);
    if (!(preview.data[i] === 3 && preview.data[i + 1] === 18 && preview.data[i + 2] === 48)) nonBackground++;
  }
  assert.ok(nonBackground > 180 * 90 * 0.75);
});

/* ---------------------------------------------------------------
   A-16 / Stage-8.10c: ручной лог-замер перехода между гексами
   ------------------------------------------------------------
   Инструмент живёт в site/planet-globe/local-transition-log.ts;
   страница подхватывает его только при ?debug=local. Ядро модуля
   берёт rAF/часы из глобуса и скачивание через options — так фазы
   t0..t8 и буфер проверяются в Node на синтетических кадрах.
   --------------------------------------------------------------- */

const { createTransitionLog } = require('../site/planet-globe/local-transition-log.ts');

/** Симуляция кадрового цикла: искусственные кадры, часы, скачивание. */
function createLogHarness() {
  let clock = 0;
  const queue = [];
  const downloads = [];
  const realPerformance = globalThis.performance;
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.performance = { now: () => clock };
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = () => {};
  const harness = {
    gpuDone: false,
    now: () => clock,
    advance(ms) { clock += ms; },
    tick(ms) {
      clock += ms;
      const callbacks = queue.splice(0, queue.length);
      for (const cb of callbacks) cb();
    },
    downloads,
    restore() {
      globalThis.performance = realPerformance;
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
  const log = createTransitionLog({
    gpuDone: () => harness.gpuDone,
    download: (filename, text) => { downloads.push({ filename, text }); },
  });
  return { log, harness, downloads };
}

/** Запускает «реальный» переход до естественного финала (t0..t8). */
function runRealTransition(log, harness) {
  log.start(12345);
  harness.advance(10);
  log.mark('t1', 7);
  harness.advance(10);
  log.mark('t2');
  harness.advance(10);
  log.mark('t3');
  harness.advance(10);
  log.mark('t4');
  harness.advance(10);
  log.mark('t5');
  harness.tick(16); // кадр 1: GPU-заливка ещё идёт — t6 не достигнут
  harness.gpuDone = true;
  harness.tick(16); // кадр 2: t6 — upload-условие выполнено
  harness.tick(16); // кадр 3: t7 — первый кадр после t6
  for (let i = 0; i < 5; i++) harness.tick(16); // 5 спокойных кадров → t8
  return lastRecord(harness.downloads);
}

/** Последняя запись из скачанного буфера (модуль скачивает весь буфер). */
function lastRecord(downloads) {
  const parsed = JSON.parse(downloads[downloads.length - 1].text);
  return parsed[parsed.length - 1];
}

test('A-16: ручной стоп и естественный финал дают одинаковую структуру записи', (t) => {
  const { log, harness } = createLogHarness();
  t.after(() => harness.restore());
  // Ручной стоп сразу после старта — переход не стартовал.
  log.start(12345);
  const manual = log.stop();
  assert.ok(manual, 'ручной стоп пишет запись');
  for (const key of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 'maxFrameGapMs']) {
    assert.equal(manual[key], null, `${key}: пустое поле — null, не undefined/NaN`);
    assert.notEqual(manual[key], undefined);
  }
  assert.equal(manual.cell, null, 'ячейка неизвестна — null');
  assert.equal(manual.alarming, false);
  assert.equal(manual.seed, 12345, 'seed берётся при старте');

  // Естественный финал на реальном переходе.
  const natural = runRealTransition(log, harness);
  assert.deepEqual(Object.keys(natural).sort(), Object.keys(manual).sort(),
    'оба пути пишут одну и ту же структуру записи');
  assert.equal(log.stop(), null, 'финал закрывает окно замера');
});

test('A-16: все фазы t0..t8 заполняются на реальном переходе', (t) => {
  const { log, harness } = createLogHarness();
  t.after(() => harness.restore());
  const rec = runRealTransition(log, harness);
  assert.equal(rec.seed, 12345);
  assert.equal(rec.cell, 7, 'cell — кликнутая ячейка (t1)');
  for (const key of ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) {
    assert.ok(typeof rec[key] === 'number' && Number.isFinite(rec[key]),
      `${key} заполнена числом (не null/NaN/undefined)`);
  }
  const phases = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
  for (let i = 1; i < phases.length; i++) {
    assert.ok(rec[phases[i]] >= rec[phases[i - 1]],
      `фазы монотонны: ${phases[i - 1]} <= ${phases[i]}`);
  }
  assert.ok(rec.t6 > rec.t5, 't6 (GPU) после t5 (skirt)');
  assert.ok(rec.t7 > rec.t6, 't7 (кадр) после t6 (GPU)');
});

test('A-16: max frame gap — отдельный пол, порог тревоги 100 мс', (t) => {
  const { log, harness } = createLogHarness();
  t.after(() => harness.restore());
  // Все разрывы маленькие — не тревожно.
  const calm = runRealTransition(log, harness);
  assert.equal(calm.maxFrameGapMs, 66, 'max frame gap — отдельный пол (счёт с t0)');
  assert.equal(calm.alarming, false);
  assert.notEqual(calm.maxFrameGapMs, calm.t8 - calm.t7,
    'maxFrameGapMs не смешивается с фазами');

  // Большой разрыв между кадрами — тревожный переход.
  const { log: log2, harness: h2 } = createLogHarness();
  t.after(() => h2.restore());
  log2.start(1);
  log2.mark('t1', 1);
  log2.mark('t2');
  log2.mark('t3');
  log2.mark('t4');
  log2.mark('t5');
  h2.tick(16);
  h2.gpuDone = true;
  h2.tick(16); // t6
  h2.tick(16); // t7
  h2.tick(150); // большой разрыв — выше порога
  h2.tick(16); // после скачка счётчик спокойных кадров заново
  h2.tick(16);
  h2.tick(16);
  h2.tick(16);
  h2.tick(16); // 5 спокойных кадров → t8 и финал
  const alarm = lastRecord(h2.downloads);
  assert.equal(alarm.maxFrameGapMs, 150);
  assert.equal(alarm.alarming, true, 'разрыв > 100 мс помечается как тревожный');
  assert.equal(typeof alarm.alarming, 'boolean', 'тревога — отдельный флаг');
});

test('A-16: буфер держит ровно последние 20 переходов', (t) => {
  const { log, harness, downloads } = createLogHarness();
  t.after(() => harness.restore());
  for (let i = 0; i < 25; i++) {
    log.start(i);
    log.mark('t1', i);
    log.stop();
  }
  const buffer = JSON.parse(downloads[downloads.length - 1].text);
  assert.equal(buffer.length, 20, 'буфер ровно на 20 переходов');
  assert.equal(buffer[0].seed, 5, 'старшие вытесняются');
  assert.equal(buffer[19].seed, 24, 'новее всех — последний');
});

test('A-16: файл скачивается, имя содержит seed, ячейку и дату-время', (t) => {
  const { log, harness, downloads } = createLogHarness();
  t.after(() => harness.restore());
  log.start(987654);
  log.mark('t1', 42);
  log.stop();
  assert.equal(downloads.length, 1, 'финал скачивает файл');
  const name = downloads[0].filename;
  assert.match(name, /^tl-987654-42-\d{13}$/,
    'имя: seed, ячейка, дата-время (Unix ms)');
  const parsed = JSON.parse(downloads[0].text);
  assert.ok(Array.isArray(parsed), 'файл — весь буфер (массив записей)');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].seed, 987654);
  assert.equal(parsed[0].cell, 42);

  // Ячейка неизвестна (стоп до клика) — null, не NaN.
  log.start(777);
  log.stop();
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].filename, /^tl-777-null-\d{13}$/);
});

test('A-16: кнопка и обработчик живут только при ?debug=local', () => {
  const html = readFileSync(new URL('../site/planet-globe/index.html', import.meta.url), 'utf8');
  const diagAt = html.indexOf('id="localMapDiag"');
  assert.ok(diagAt >= 0, 'панель #localMapDiag есть');
  const diagBlock = html.slice(diagAt, html.indexOf('</div>', diagAt));
  assert.match(diagBlock, /localTransitionLogBtn/, 'кнопка внутри панели #localMapDiag');
  assert.match(html, /id="localMapDiag" hidden/, 'панель скрыта по умолчанию');

  const page = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  // Обработчик кнопки и создание модуля — только в debug-режиме.
  assert.match(page, /if \(LOCAL_DEBUG_QUERY\) \{\s*tl = tlCreate\(\{ gpuDone:/);
  assert.match(page, /els\.localMapDiag\.lastElementChild\?\.addEventListener\('click', tlClick\);/);
  assert.match(page, /els\.localMapDiag\.hidden = false;/);
  // Фазовые метки ставит страница в потоке перехода.
  assert.match(page, /tl\?\.mark\('t1', neighbor\.cell\)/);
  assert.match(page, /tl\?\.mark\('t2'\)/);
  assert.match(page, /tl\?\.mark\('t3'\)/);
  assert.match(page, /tl\?\.mark\('t4'\)/);
  assert.match(page, /tl\?\.mark\('t5'\)/);
  // Горячий путь кадра не касается лог-замера (ни пробника, ни меток).
  const frameAt = page.indexOf('function renderLocalMapFrame');
  const frameEnd = page.indexOf('\nfunction ', frameAt + 10);
  const frameBody = page.slice(frameAt, frameEnd < 0 ? page.length : frameEnd);
  assert.ok(!frameBody.includes('tl'), 'renderLocalMapFrame не касается лог-замера');
  assert.ok(!frameBody.includes('tlMark'), 'горячий путь кадра чист');

  // Модуль ядра чист: без value-импортов (летит в главный чанк как есть).
  const moduleSrc = readFileSync(
    new URL('../site/planet-globe/local-transition-log.ts', import.meta.url),
    'utf8',
  );
  assert.ok(!/^import /m.test(moduleSrc), 'модуль не тащит зависимостей');
});
