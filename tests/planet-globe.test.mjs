import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const GlobeShared = require('../site/shared/planet-globe.ts');
const PlanetGlobe = GlobeShared.default;
const { buildGlobeGeometry } = require('../site/shared/planet-globe-pack.ts');
const LocalMapContract = require('../src/local-map/local-map-contract.ts');
const LocalMapHeightfield = require('../src/local-map/local-map-heightfield.ts');
const LocalMapWorker = require('../src/local-map/local-map-worker.ts');
const LocalCamera = require('../site/planet-globe/local-camera.ts');

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
  let rafSeq = 0;
  const queue = new Map();
  const downloads = [];
  const realPerformance = globalThis.performance;
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.performance = { now: () => clock };
  globalThis.requestAnimationFrame = (cb) => {
    rafSeq++;
    queue.set(rafSeq, cb);
    return rafSeq;
  };
  globalThis.cancelAnimationFrame = (id) => { queue.delete(id); };
  const harness = {
    gpuDone: false,
    now: () => clock,
    advance(ms) { clock += ms; },
    tick(ms) {
      clock += ms;
      const callbacks = [...queue.values()];
      queue.clear();
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
  assert.equal(manual.aborted, true, 'Стоп без t1 — aborted');
  assert.equal(manual.totalMs, null, 'totalMs без t1 — null');
  assert.equal(manual.gpuMs, null, 'gpuMs без фаз — null');
  assert.equal(manual.seed, 12345, 'seed берётся при старте');

  // Естественный финал на реальном переходе.
  const natural = runRealTransition(log, harness);
  assert.deepEqual(Object.keys(natural).sort(), Object.keys(manual).sort(),
    'оба пути пишут одну и ту же структуру записи');
  assert.equal(natural.aborted, false, 'переход был — aborted false');
  assert.equal(natural.totalMs, 152, 'totalMs = t8 − t1 (162 − 10)');
  assert.equal(natural.gpuMs, 32, 'gpuMs = t6 − t5 (82 − 50)');
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

test('A-16: t1 не перезаписывается (Dive-in после клика по гексу)', (t) => {
  const { log, harness } = createLogHarness();
  t.after(() => harness.restore());
  log.start(555);
  harness.advance(10);
  log.mark('t1', 10);      // клик по гексу — t1 = 10
  harness.advance(10);
  log.mark('t1', 20);      // Dive-in — игнорируется
  harness.advance(10);
  log.mark('t2');
  const rec = log.stop();
  assert.equal(rec.t1, 10, 't1 остаётся первой меткой');
  assert.equal(rec.cell, 10, 'ячейка первой t1');

  // На反过来м порядке: Dive-in first, потом клик — t1 = Dive-in.
  log.start(556);
  harness.advance(5);
  const diveAt = harness.now();
  log.mark('t1', 30);      // Dive-in
  harness.advance(5);
  log.mark('t1', 40);      // клик по гексу — игнорируется
  const rec2 = log.stop();
  assert.equal(rec2.t1, diveAt, 't1 = метка Dive-in');
  assert.equal(rec2.cell, 30, 'ячейка Dive-in');
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
  assert.match(name, /^tl-987654-42-\d{4}-\d{2}-\d{2}-\d{6}\.json$/,
    'имя: seed, ячейка, ISO-подобная дата-время (UTC) + .json');
  const parsed = JSON.parse(downloads[0].text);
  assert.ok(Array.isArray(parsed), 'файл — весь буфер (массив записей)');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].seed, 987654);
  assert.equal(parsed[0].cell, 42);

  // Ячейка неизвестна (стоп до клика) — null, не NaN.
  log.start(777);
  log.stop();
  assert.equal(downloads.length, 2);
  assert.match(downloads[1].filename, /^tl-777-null-\d{4}-\d{2}-\d{2}-\d{6}\.json$/,
    'ячейка неизвестна — null (браузер не заменяет на _)');
});

test('A-16: кнопка и обработчик живут только при ?debug=local', () => {
  const html = readFileSync(new URL('../site/planet-globe/index.html', import.meta.url), 'utf8');
  const inspectorAt = html.indexOf('id="patchInspector"');
  assert.ok(inspectorAt >= 0, 'панель #patchInspector есть');
  const inspectorBlock = html.slice(inspectorAt, html.indexOf('</section>', inspectorAt));
  assert.match(inspectorBlock, /localTransitionLogBtn/, 'кнопка внутри панели #patchInspector');
  assert.ok(
    inspectorBlock.indexOf('localTransitionLogBtn') < inspectorBlock.indexOf('diveLocalMapBtn'),
    'кнопка до Dive-in (лог-старт предшествует переходу)',
  );
  assert.match(
    html,
    /<button id="localTransitionLogBtn"[^>]*\shidden[^>]*>/,
    'кнопка скрыта по умолчанию (вне ?debug=local её нет)',
  );
  const diagAt = html.indexOf('id="localMapDiag"');
  assert.ok(diagAt >= 0, 'панель #localMapDiag есть');
  const diagBlock = html.slice(diagAt, html.indexOf('</div>', diagAt));
  assert.ok(!diagBlock.includes('localTransitionLogBtn'), 'кнопки нет в #localMapDiag');
  assert.match(html, /id="localMapDiag" hidden/, 'панель скрыта по умолчанию');

  const page = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  // Обработчик кнопки и создание модуля — только в debug-режиме.
  assert.match(page, /if \(LOCAL_DEBUG_QUERY\) \{\s*els\.localTransitionLogBtn\.hidden = false;\s*tl = tlCreate\(\{ gpuDone:/);
  assert.match(page, /els\.localTransitionLogBtn\.addEventListener\('click', tlClick\);/);
  // Кнопка показывается в debug-режиме; панель открывается окном замера
  // (startLocalCameraDiagWindow), wiring её не показывает.
  const tlCreateAt = page.indexOf('tl = tlCreate');
  const wiringAt = page.lastIndexOf('if (LOCAL_DEBUG_QUERY) {', tlCreateAt);
  const wiringBlock = page.slice(wiringAt, page.indexOf('\n  }', wiringAt));
  assert.match(wiringBlock, /els\.localTransitionLogBtn\.hidden = false;/, 'кнопка в debug-режиме видна');
  assert.ok(!wiringBlock.includes('localMapDiag.hidden'), 'wiring не меняет видимость панели');
  const diagWindowAt = page.indexOf('function startLocalCameraDiagWindow');
  const diagBody = page.slice(diagWindowAt, page.indexOf('\nfunction ', diagWindowAt + 10));
  assert.match(diagBody, /els\.localMapDiag\.hidden = false;/, 'панель открывается окном замера');
  // Фазовые метки ставит страница в потоке перехода: клик по гексу и Dive-in.
  assert.match(page, /tl\?\.mark\('t1', neighbor\.cell\)/);
  assert.match(page, /tl\?\.mark\('t1', centerCell\.cell\)/, 't1 на пути Dive-in');
  assert.match(page, /tl\?\.mark\('t2'\)/);
  assert.match(page, /tl\?\.mark\('t3'\)/);
  assert.match(page, /tl\?\.mark\('t4'\)/);
  assert.match(page, /tl\?\.mark\('t5'\)/);
  // debug=local из адреса нагрузки переносится в собираемый URL.
  assert.match(
    page,
    /if \(LOCAL_DEBUG_QUERY\) \{\s*params\.set\('debug', 'local'\);\s*\}/,
    'debug=local переводится в URL',
  );
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

/* ---------------------------------------------------------------
   W24: масштаб клетки и пропорция вертикали
   ------------------------------------------------------------
   Одна клетка на планетарном и стратегическом уровне и одна
   пропорция вертикали у обеих ветвей рельефа. Числа живут в
   общей таблице `GLOBE_CELL_SCALE` / `GLOBE_RELIEF` модуля
   `site/shared/planet-globe.ts`; здесь проверяется, что оба
   масштаба сходятся с реальной геометрией и друг с другом.
   ------------------------------------------------------------ */

/** Те же нормы v=16, что у `surface` выше: нужны генератору локальной карты. */
const LOCAL_MAP_PROFILE = {
  masterSeedHex: '0123456789abcdef',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
};

/** Сухая гексагональная клетка — центр участка для локальной карты. */
function pickDryHexCell() {
  for (let c = 0; c < grid.cellCount; c++) {
    if (grid.neighborCount[c] !== 6) continue;
    if (surface.elevation[c] < surface.seaLevel) continue;
    if (surface.streamWeight[c] > 0 || surface.lakeWeight[c] !== 0) continue;
    return c;
  }
  return -1;
}

test('W24: шаг центров соседних клеток на глобусе и в локальной карте совпадает в пределах 1 %', async () => {
  const table = GlobeShared.GLOBE_CELL_SCALE;

  // 1. Глобус: касательное расстояние между центрами соседних клеток v=128
  //    при R = 6 371 км, среднее по всем парам соседей.
  const earthGrid = GeodesicGrid.build(table.gridV);
  assert.equal(earthGrid.cellCount, table.cellCount, 'v=128 — каноническая сетка таблицы');
  const radiusM = table.planetRadiusKm * 1000;
  const centers = earthGrid.centers;
  const neighbors = earthGrid.neighbors;
  let spacingSum = 0;
  let pairCount = 0;
  let spacingMin = Infinity;
  let spacingMax = 0;
  for (let c = 0; c < earthGrid.cellCount; c++) {
    for (let k = 0; k < 6; k++) {
      const d = neighbors[c * 6 + k];
      if (d < 0 || d <= c) continue;
      const dot = (centers[c * 3] * centers[d * 3])
        + (centers[c * 3 + 1] * centers[d * 3 + 1])
        + (centers[c * 3 + 2] * centers[d * 3 + 2]);
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      const tangentM = angle * radiusM;
      spacingSum += tangentM;
      pairCount++;
      if (tangentM < spacingMin) spacingMin = tangentM;
      if (tangentM > spacingMax) spacingMax = tangentM;
    }
  }
  assert.ok(pairCount > 400000, `пар соседей достаточно для среднего (${pairCount})`);
  const globeSpacingM = spacingSum / pairCount;
  // Голдбергова сетка нерегулярна: у отдельной пары шаг гуляет в пределах
  // ±10 %, у среднего по сетке — нет. Именно среднее задаёт масштаб карты.
  assert.ok(
    Math.abs(globeSpacingM - table.cellCenterSpacingM) / table.cellCenterSpacingM < 0.01,
    `средний шаг глобуса ${globeSpacingM.toFixed(1)} м против табличных `
      + `${table.cellCenterSpacingM.toFixed(1)} м (допуск 1 %)`,
  );
  // Площадь клетки и апофема — те же числа, что зафиксированы решением.
  assert.ok(Math.abs(table.cellAreaKm2 - 3113) / 3113 < 0.001, `площадь клетки ${table.cellAreaKm2}`);
  assert.ok(Math.abs(table.cellApothemM - 30000) / 30000 < 0.01, `апофема ${table.cellApothemM}`);
  assert.ok(Math.abs(table.cellEdgeM - 34600) / 34600 < 0.01, `ребро ${table.cellEdgeM}`);
  assert.ok(spacingMin < globeSpacingM && spacingMax > globeSpacingM);

  // 2. Локальная карта: тот же физический участок, что и клетка планеты.
  const dryCell = pickDryHexCell();
  assert.ok(dryCell >= 0, 'нужна сухая клетка для центра участка');
  const patch = LocalMapContract.buildPatch7(grid, surface, dryCell);
  LocalMapWorker.clearLocalMapCache();
  const local = await LocalMapWorker.generateLocalMap({
    patch: patch,
    seed: 12345,
    placeId: Number(7),
    radiusM: table.strategicPatchRadiusM,
    profile: LOCAL_MAP_PROFILE,
    patchKey: 'w24-cell-scale',
  });
  assert.ok(Array.isArray(local.ringCells) && local.ringCells.length >= 6, 'кольца соседей посчитаны');
  const localSpacing = local.ringCells.slice(0, 6).map(
    (cell) => Math.hypot(cell.offsetM[0], cell.offsetM[1]),
  );
  for (const spacingM of localSpacing) {
    assert.ok(
      Math.abs(spacingM - globeSpacingM) / globeSpacingM < 0.01,
      `шаг локальной карты ${spacingM.toFixed(1)} м против глобуса `
        + `${globeSpacingM.toFixed(1)} м (допуск 1 %)`,
    );
  }
  // Контроль регрессии: до W24 радиус 2 500 м давал шаг 2 875 м — сжатие 21×.
  assert.ok(
    globeSpacingM / (LocalMapHeightfield.SKIRT_HEX_SPACING_RATIO * 2500) > 20,
    'прежняя пара 2 500 м / 2 875 м действительно была сжатием ~21×',
  );
  // Шаг центров и шаг камеры страницы — одно отношение.
  assert.equal(LocalMapHeightfield.SKIRT_HEX_SPACING_RATIO, table.strategicHexStepRatio);
  // Радиус участка — тот же, что у юбки горизонта для этой же планеты:
  // обе стороны берут шаг сетки из одной формулы, поэтому таблица не спорит
  // с `hexSpacingMeters` воркера.
  const workerSpacingM = LocalMapWorker.hexSpacingMeters(table.planetRadiusKm * 1000);
  assert.ok(
    Math.abs(workerSpacingM - table.cellCenterSpacingM) / table.cellCenterSpacingM < 0.01,
    `hexSpacingMeters воркера ${workerSpacingM.toFixed(1)} м против табличных `
      + `${table.cellCenterSpacingM.toFixed(1)} м`,
  );
  assert.ok(
    Math.abs(table.strategicPatchRadiusM - workerSpacingM / table.strategicHexStepRatio) < 1,
    'радиус участка = шаг сетки / отношение шага',
  );
});

test('W24: отношение вертикали океан/суша = 1,79 ± 0,05, коэффициенты — из общей таблицы', () => {
  const relief = GlobeShared.GLOBE_RELIEF;
  const drawnRatio = relief.oceanMax / relief.landMax;
  const trueRatio = relief.oceanReliefM / relief.landReliefM;
  // Обе ветви несут одно преувеличение: (коэффициент · R) / истинная амплитуда.
  const exaggerationLand = (relief.landMax * 6371000) / relief.landReliefM;
  const exaggerationOcean = (relief.oceanMax * 6371000) / relief.oceanReliefM;
  assert.ok(
    Math.abs(exaggerationLand - relief.verticalExaggeration) < 0.1,
    `преувеличение суши ${exaggerationLand.toFixed(2)} против табличных ${relief.verticalExaggeration}`,
  );
  assert.ok(
    Math.abs(exaggerationOcean - relief.verticalExaggeration) < 0.1,
    `преувеличение океана ${exaggerationOcean.toFixed(2)} против табличных ${relief.verticalExaggeration}`,
  );
  assert.ok(
    Math.abs(exaggerationLand - exaggerationOcean) < 0.1,
    `ветви преувеличены одинаково (${exaggerationLand.toFixed(2)} / ${exaggerationOcean.toFixed(2)})`,
  );
  assert.ok(
    Math.abs(drawnRatio - 1.79) <= 0.05,
    `нарисованное отношение ${drawnRatio.toFixed(3)} должно быть 1,79 ± 0,05`,
  );
  assert.ok(
    Math.abs(drawnRatio - trueRatio) <= 0.05,
    `отношение коэффициентов ${drawnRatio.toFixed(3)} против истинного `
      + `${trueRatio.toFixed(3)} (дно 10 995 м, суша 6 147 м)`,
  );
  // Прежняя пара давала 2,75 в пользу суши — именно её и убрали.
  assert.ok(Math.abs(0.022 / 0.008 - 2.75) < 1e-12);
  assert.ok(drawnRatio < 2.75);

  // Геометрия несёт ровно табличные коэффициенты: крайние клетки поля высот
  // получают полный размах своей ветви.
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
  const landDelta = radiusOfCenter(highLand) - 1;
  const oceanDelta = 1 - radiusOfCenter(deepOcean);
  assert.ok(Math.abs(landDelta - relief.landMax) < 2e-5, `суша +${landDelta} против табличных +${relief.landMax}`);
  assert.ok(Math.abs(oceanDelta - relief.oceanMax) < 2e-5, `океан −${oceanDelta} против табличных −${relief.oceanMax}`);
  const geometryRatio = oceanDelta / landDelta;
  assert.ok(
    Math.abs(geometryRatio - 1.79) <= 0.05,
    `отношение вертикали в геометрии ${geometryRatio.toFixed(3)} должно быть 1,79 ± 0,05`,
  );
  // reliefScale у обеих ветвей общий — «усиленный» рельеф сохраняет пропорцию.
  const scaled = buildGlobeGeometry(grid, surface, { colorMode: 'biome', reliefScale: 1.6 });
  const scaledLand = Math.hypot(
    scaled.positions[highLand * 3],
    scaled.positions[highLand * 3 + 1],
    scaled.positions[highLand * 3 + 2],
  ) - 1;
  assert.ok(Math.abs(scaledLand - relief.landMax * 1.6) < 3e-5, `усиленная суша ${scaledLand}`);
});

test('W24: упаковка геометрии (pack) и CPU-полигоны берут рельеф из одной таблицы', () => {
  const geometry = buildGlobeGeometry(grid, surface, { colorMode: 'biome', reliefScale: 1 });
  let maxDiff = 0;
  for (let c = 0; c < surface.cellCount; c++) {
    const polygon = PlanetGlobe.cellPolygon(grid, surface, c, { reliefScale: 1, inflate: 1 });
    const packedRadius = Math.hypot(
      geometry.positions[c * 3],
      geometry.positions[c * 3 + 1],
      geometry.positions[c * 3 + 2],
    );
    const polygonRadius = Math.hypot(polygon.center[0], polygon.center[1], polygon.center[2]);
    maxDiff = Math.max(maxDiff, Math.abs(packedRadius - polygonRadius));
  }
  // pack отдаёт f32, cellPolygon считает в f64 — допуск на квантование.
  assert.ok(maxDiff < 2e-5, `pack и cellPolygon расходятся на ${maxDiff}`);

  // В упаковке не осталось собственной копии коэффициентов.
  const packSrc = readFileSync(
    new URL('../site/shared/planet-globe-pack.ts', import.meta.url),
    'utf8',
  );
  assert.match(packSrc, /import PlanetGlobe, \{ reliefDelta \} from '\.\/planet-globe\.ts';/);
  assert.ok(!/function reliefDelta/.test(packSrc), 'reliefDelta в pack не дублируется');
  assert.ok(!/\* 0\.02/.test(packSrc), 'в pack нет литералов вертикали');

  // Страница берёт радиус участка из таблицы, а не из литерала.
  const pageSrc = readFileSync(
    new URL('../site/planet-globe/planet-globe.ts', import.meta.url),
    'utf8',
  );
  assert.match(pageSrc, /const LOCAL_PATCH_BASE_RADIUS_M = GLOBE_CELL_SCALE\.strategicPatchRadiusM;/);
  assert.ok(!/LOCAL_PATCH_BASE_RADIUS_M = 2500/.test(pageSrc), 'литерал 2 500 м убран');
  // UP-1 §3.3: шаг камеры больше не проверяется по тексту страницы — он живёт
  // в чистом модуле `local-camera.ts`, и там же проверяется числом: шаг
  // ре-бейзинга равен `стратегический шаг × радиус`, без литерала 1,15.
  assert.equal(
    LocalCamera.LOCAL_HEX_STEP_RATIO,
    GlobeShared.GLOBE_CELL_SCALE.strategicHexStepRatio,
    'шаг камеры берётся из общей таблицы масштабов',
  );
  assert.equal(LocalCamera.LOCAL_HEX_STEP_RATIO, 1.15, 'отношение шага — 1,15');
});

test('UP-1: чистая камера локальной карты — ре-бейзинг сохраняет ракурс и мировую точку', () => {
  const ratio = GlobeShared.GLOBE_CELL_SCALE.strategicHexStepRatio;
  const radiusM = GlobeShared.GLOBE_CELL_SCALE.strategicPatchRadiusM; // 52,1 км
  const stepM = ratio * radiusM;
  const start = { target: [10, 20, 100], yaw: -Math.PI / 2, pitch: 0.31, distance: 600 };

  for (const azimuth of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.4]) {
    const rebased = LocalCamera.rebaseLocalCameraState(start, azimuth, radiusM);
    // Ракурс пользователя переносится без изменений.
    assert.equal(rebased.yaw, start.yaw, 'yaw не меняется');
    assert.equal(rebased.pitch, start.pitch, 'pitch не меняется');
    assert.equal(rebased.distance, start.distance, 'дистанция не меняется');
    // Сдвиг — ровно шаг гекса против азимута перехода.
    const expected = [
      start.target[0] - Math.sin(azimuth) * stepM,
      start.target[1] - Math.cos(azimuth) * stepM,
      start.target[2],
    ];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(rebased.target[i] - expected[i]) < 1e-9,
        `ось ${i}: сдвиг ${rebased.target[i] - start.target[i]} против ${expected[i] - start.target[i]}`);
    }
    // Мировая точка взгляда сохраняется: глаз камеры сдвигается тем же вектором,
    // поэтому картинка не прыгает — камера просто переезжает в новое начало координат.
    const eyeBefore = LocalCamera.cameraEye(start);
    const eyeAfter = LocalCamera.cameraEye(rebased);
    for (let i = 0; i < 2; i++) {
      const shift = (i === 0 ? Math.sin(azimuth) : Math.cos(azimuth)) * stepM;
      assert.ok(Math.abs((eyeAfter[i] + shift) - eyeBefore[i]) < 1e-9, `глаз по оси ${i} сохраняет мир`);
    }
    assert.ok(Math.abs(eyeAfter[2] - eyeBefore[2]) < 1e-9, 'высота глаза не меняется');
    // Шаг совпадает с шагом решётки Patch7/юбки (`SKIRT_HEX_SPACING_RATIO`).
    const shiftM = Math.hypot(rebased.target[0] - start.target[0], rebased.target[1] - start.target[1]);
    assert.ok(Math.abs(shiftM - LocalMapWorker.SKIRT_HEX_SPACING_RATIO * radiusM) < 1e-6,
      `шаг ре-бейзинга ${shiftM} против общего ${LocalMapWorker.SKIRT_HEX_SPACING_RATIO * radiusM}`);

    // Два перехода в противоположные стороны возвращают точку прицела назад.
    const back = LocalCamera.rebaseLocalCameraState(rebased, azimuth + Math.PI, radiusM);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back.target[i] - start.target[i]) < 1e-9, `обратный переход по оси ${i}`);
    }
  }

  // Нулевой и отрицательный радиус не двигают точку прицела вовсе.
  for (const r of [0, -1]) {
    const still = LocalCamera.rebaseLocalCameraState(start, 1.2, r);
    assert.deepEqual(still.target, start.target, `радиус ${r} не сдвигает прицел`);
  }
  // Исходное состояние не мутируется: снимок камеры — копия массива.
  assert.deepEqual(start.target, [10, 20, 100], 'аргумент ре-бейзинга не изменён');
  const snapshot = LocalCamera.cloneLocalCameraState(start);
  snapshot.target[0] = 999;
  assert.deepEqual(start.target, [10, 20, 100], 'снимок камеры не разделяет массив с состоянием');
});

test('UP-1: чистая камера локальной карты — кривые перехода, остаток и кадр сцены', () => {
  // Кривые: края закреплены, направление монотонное, середина easeInOut — 0,5.
  assert.equal(LocalCamera.easeOutCubic(0), 0);
  assert.equal(LocalCamera.easeOutCubic(1), 1);
  assert.equal(LocalCamera.easeInOutCubic(0), 0);
  assert.equal(LocalCamera.easeInOutCubic(1), 1);
  assert.equal(LocalCamera.easeInOutCubic(0.5), 0.5);
  assert.equal(LocalCamera.lerpLocal(10, 20, 0.25), 12.5);
  let prev = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const e = LocalCamera.easeOutCubic(i / 20);
    assert.ok(e > prev, 'easeOutCubic монотонна');
    prev = e;
  }

  // Кадр анимации: края совпадают с ключевыми точками, середина — между ними,
  // завершение наступает ровно в `startAt + durationMs`.
  const anim = {
    startAt: 1000,
    durationMs: 800,
    fromYaw: -Math.PI / 2 - 0.24,
    toYaw: -Math.PI / 2,
    fromPitch: 1.32,
    toPitch: 0.31,
    fromDist: 3120,
    toDist: 600,
    fromTarget: [0, 0, 162.5],
    toTarget: [0, 350, 62.5],
    easeInOut: true,
  };
  const atStart = LocalCamera.cameraAnimFrame(anim, anim.startAt);
  assert.deepEqual(atStart.state.target, anim.fromTarget);
  assert.equal(atStart.state.distance, anim.fromDist);
  assert.equal(atStart.done, false);
  const mid = LocalCamera.cameraAnimFrame(anim, anim.startAt + anim.durationMs / 2);
  assert.ok(mid.state.distance < anim.fromDist && mid.state.distance > anim.toDist,
    'середина спуска между ключевыми дистанциями');
  assert.ok(mid.state.pitch < anim.fromPitch && mid.state.pitch > anim.toPitch, 'наклон выравнивается');
  assert.equal(mid.done, false);
  const atEnd = LocalCamera.cameraAnimFrame(anim, anim.startAt + anim.durationMs);
  assert.equal(atEnd.done, true, 'анимация завершается на последнем кадре');
  assert.ok(Math.abs(atEnd.state.distance - anim.toDist) < 1e-9);
  assert.ok(Math.abs(atEnd.state.yaw - anim.toYaw) < 1e-12);
  // Время за пределами окна зажимается: кадр не «уезжает» дальше ключевых точек.
  assert.equal(LocalCamera.cameraAnimFrame(anim, anim.startAt - 500).state.distance, anim.fromDist);
  assert.equal(LocalCamera.cameraAnimFrame(anim, anim.startAt + 5000).state.distance, anim.toDist);

  // Остаток после подмены патча и решение о сглаживании.
  const rebased = { target: [0, 0, 100], yaw: 0, pitch: 0.31, distance: 600 };
  assert.equal(LocalCamera.rebaseResidualM(rebased, 40, 55), 5);
  assert.equal(LocalCamera.needsRebaseSettle(rebased, LocalCamera.cloneLocalCameraState(rebased)), false,
    'точный ре-бейзинг не запускает сглаживание');
  const nudged = LocalCamera.cloneLocalCameraState(rebased);
  nudged.target[0] += 1;
  assert.equal(LocalCamera.needsRebaseSettle(rebased, nudged), true, 'остаток 1 м гасится');
  const tinyDist = LocalCamera.cloneLocalCameraState(rebased);
  tinyDist.distance += 1e-4;
  assert.equal(LocalCamera.needsRebaseSettle(rebased, tinyDist), false, 'дрожание дистанции ниже порога');
  const nudgedDist = LocalCamera.cloneLocalCameraState(rebased);
  nudgedDist.distance += 0.01;
  assert.equal(LocalCamera.needsRebaseSettle(rebased, nudgedDist), true, 'сдвиг дистанции выше порога');
});

test('UP-1: чистая камера локальной карты — шкала ширины, точка прицела и кадр канваса', () => {
  // Логарифмическая шкала по 11 ступеням 1,2 … 1250 км.
  assert.equal(LocalCamera.scaleStep01(1.2), 0);
  assert.equal(LocalCamera.scaleStep01(1250), 1);
  assert.equal(LocalCamera.scaleStep01(0.4), 0, 'ниже нижней ступени шкала зажата');
  assert.equal(LocalCamera.scaleStep01(99999), 1, 'выше верхней ступени шкала зажата');
  const midWidth = Math.sqrt(1.2 * 1250);
  assert.ok(Math.abs(LocalCamera.scaleStep01(midWidth) - 0.5) < 1e-12,
    `середина логарифмической шкалы при ${midWidth} км`);

  const context = { aspect: 16 / 9, radiusM: 2500, minCloseDistanceM: 2 };
  let prevDist = 0;
  let prevPitch = -Infinity;
  for (let step = 0; step < 11; step++) {
    const widthKm = 1.2 * Math.pow(1250 / 1.2, step / 10);
    const dist = LocalCamera.cameraDistanceForWidthKm(widthKm, context);
    assert.ok(dist > prevDist, `дистанция растёт на ступени ${step}: ${dist}`);
    prevDist = dist;
    const pitch = LocalCamera.cameraPitchForWidthKm(widthKm);
    assert.ok(pitch > prevPitch, `наклон растёт на ступени ${step}: ${pitch}`);
    prevPitch = pitch;
  }
  assert.ok(Math.abs(LocalCamera.cameraPitchForWidthKm(1.2) - LocalCamera.LOCAL_REST_PITCH) < 1e-12,
    'у долины наклон равен панорамному');
  assert.ok(Math.abs(LocalCamera.cameraPitchForWidthKm(1250) - 0.76) < 1e-12, 'на обзоре 0,76 рад');

  // Точка прицела: смещение вперёд по yaw и пол высоты над центром поля.
  const rest = LocalCamera.defaultLocalCameraTarget(LocalCamera.LOCAL_REST_YAW, 1.2, 2500, 10);
  assert.ok(Math.abs(rest[0]) < 1e-9, 'на азимуте покоя смещение вперёд идёт на север');
  assert.ok(rest[1] > 0, 'смещение вперёд положительно по северу');
  assert.ok(Math.abs(rest[2] - (10 + 62.5)) < 1e-9, 'высота прицела — центр поля плюс пол 2,5 % радиуса');
  // Нечисловой центр heightfield не ломает прицел.
  assert.equal(LocalCamera.defaultLocalCameraTarget(LocalCamera.LOCAL_REST_YAW, 1.2, 2500, NaN)[2], 62.5);
  // Нулевой радиус — смещения вперёд нет, остаётся пол 14 м.
  const zeroRadius = LocalCamera.defaultLocalCameraTarget(0, 1.2, 0, 0);
  assert.ok(Math.abs(zeroRadius[0]) < 1e-12 && Math.abs(zeroRadius[1]) < 1e-12, 'нулевой радиус — без сноса');
  assert.equal(zeroRadius[2], 14, 'нулевой радиус — только пол высоты прицела');

  // Кадр канваса: скрытый канвас (0 × 0) не даёт нулевого отношения сторон.
  assert.equal(LocalCamera.canvasAspectRatio(0, 0), 0.1);
  assert.equal(LocalCamera.canvasAspectRatio(1920, 1080), 1920 / 1080);
  assert.equal(LocalCamera.canvasAspectRatio(50, 1000), 0.1);
});
