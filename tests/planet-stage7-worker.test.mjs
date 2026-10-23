/* Тесты Этапа 7 (волна Stage-7, Воркер 1): бесшовный зум Голдберга.
   -------------------------------------------------------------------------
   1. Воркер `PlanetGlobeWorker.createWorkerHandler`: цепочка generate ->
      prefetch (prefetch-ready с neighborChunks/hexCenterCell/patchReady) ->
      extract-patch для обычной шестиугольной ячейки и для пятиугольной
      ячейки полюса (авто-привязка к соседу, инварианты И-3, ключи §8.8).
   2. PlanetGlobe на mock WebGL2: transitionGeometry (двухслойное
      центробежное замещение uHide/uCenterGrow с освобождением prev-слоя),
      flyToDirection (easeOutCubic, прерывание жестом), getCameraState
      и debounced onCameraIntent (180 мс). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// RAF-заглушки ставятся ДО первого require planet-globe.ts: рендер-цикл
// гоняется вручную через pump(now) с синтетическим временем кадра.
const rafQueue = [];
globalThis.requestAnimationFrame = function (cb) { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = function () { rafQueue.length = 0; };

const PlanetGlobe = require('../site/shared/planet-globe.ts').default;
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const { PlanetGlobeWorker } = require('../site/planet-globe/planet-globe-worker.ts');

const V = 16;
const grid = GeodesicGrid.build(V);
const surface = PlanetSurface.generateSurface(grid, {
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
});

/* ------------------------------------------------------------------ воркер */

const WORKER_PROFILE = {
  place_id: '2',
  profile_status: 'draft',
  profile_revision: '1',
  preset_id: 'earthlike_balanced',
  surfaceClass: 'terrestrial',
  radiusKm: 797,
  masterSeedHex: '0123456789abcdef',
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
};

function firstOfType(messages, type) {
  return messages.find((m) => m.type === type) || null;
}

test('stage7-worker: prefetch без сгенерированной планеты возвращает безопасный ответ', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  const out = await handler.handle({ type: 'prefetch', token: 't0', requestId: 'r0', targetV: 16 });
  const pref = firstOfType(out, 'prefetch-ready');
  assert.ok(pref, 'должен прийти prefetch-ready');
  assert.equal(pref.patchReady, false);
  assert.equal(pref.focusCell, -1);
  assert.equal(pref.hexCenterCell, -1);
  assert.deepEqual(pref.neighborChunks, []);
  assert.equal(typeof pref.timingsMs.totalMs, 'number');
});

test('stage7-worker: generate -> prefetch прогревает сетку и собирает Patch7 заранее', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  const gen = await handler.handle({
    type: 'generate', token: 't1', requestId: 'r1',
    profile: WORKER_PROFILE, renderV: 8, colorMode: 'biome',
  });
  const ready = firstOfType(gen, 'ready');
  assert.ok(ready, 'generate должен завершиться ready');
  assert.equal(ready.summary.canonicalV, 16);

  const pref = await handler.handle({
    type: 'prefetch', token: 't1', requestId: 'r2',
    targetV: 16, focusDirection: [0.3, 0.5, 0.81],
  });
  const p = firstOfType(pref, 'prefetch-ready');
  assert.ok(p, 'должен прийти prefetch-ready');
  assert.equal(p.type, 'prefetch-ready');
  assert.equal(p.targetV, 16, 'targetV зажат каноном И-1');
  assert.ok(Number.isInteger(p.focusCell) && p.focusCell >= 0);
  assert.equal(p.patchReady, true);
  assert.ok(Number.isInteger(p.hexCenterCell) && p.hexCenterCell >= 0);
  const workerGrid = GeodesicGrid.build(16);
  assert.equal(workerGrid.neighborCount[p.hexCenterCell], 6, 'hexCenterCell — шестиугольник');
  assert.ok(Number.isInteger(p.chunkId) && p.chunkId >= 0);
  assert.ok(Array.isArray(p.neighborChunks) && p.neighborChunks.every((c) => Number.isInteger(c)));
  assert.ok(p.neighborChunks.length > 0, 'у чанка есть соседи');
  assert.equal(typeof p.timingsMs.gridMs, 'number');
  assert.equal(typeof p.timingsMs.patchMs, 'number');
  assert.equal(typeof p.timingsMs.totalMs, 'number');
  assert.ok(p.timingsMs.totalMs >= p.timingsMs.gridMs * 0 && p.timingsMs.totalMs >= 0);
});

test('stage7-worker: extract-patch шестиугольной ячейки — Patch7, инварианты И-3 и ключи §8.8', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  await handler.handle({
    type: 'generate', token: 't1', requestId: 'r1',
    profile: WORKER_PROFILE, renderV: 16, colorMode: 'biome',
  });
  const workerGrid = GeodesicGrid.build(16);
  let hexCell = -1;
  for (let c = 0; c < workerGrid.cellCount; c++) {
    if (workerGrid.neighborCount[c] === 6) { hexCell = c; break; }
  }
  assert.ok(hexCell >= 0);

  const first = await handler.handle({ type: 'extract-patch', token: 't1', requestId: 'r3', cell: hexCell });
  const patch = firstOfType(first, 'patch-ready');
  assert.ok(patch, 'должен прийти patch-ready');
  assert.equal(patch.requestedCell, hexCell);
  assert.equal(patch.hexCenterCell, hexCell, 'шестиугольник остаётся центром');

  // Инварианты И-3: все 5 проверок локального контракта green.
  assert.equal(patch.invariants.ok, true, JSON.stringify(patch.invariants.checks));
  for (const check of ['patch7-shape', 'tangent-identity', 'flood-hold', 'river-topology', 'spawn-ban']) {
    assert.equal(patch.invariants.checks[check], true, check);
  }

  // Форма Patch7: 7 канонических ячеек local-map-patch-v1 на canonicalV.
  assert.equal(patch.patch.version, 'local-map-patch-v1');
  assert.equal(patch.patch.v, 16);
  assert.equal(patch.patch.cells.length, 7);
  assert.equal(patch.patch.centerCell, hexCell);
  assert.ok(patch.spanMeters > 0);
  assert.ok(patch.buildableFraction >= 0 && patch.buildableFraction <= 1);

  // Ключи §8.8: формат и детерминизм (повторный вызов даёт те же ключи).
  assert.ok(patch.keys.planetKey.startsWith('PG1-'), 'planetKey = generation_key (PG1)');
  assert.match(patch.keys.cellKey, /^CK1-[0-9a-f]{16}$/);
  assert.match(patch.keys.regionKey, /^RK1-[0-9a-f]{16}$/);
  assert.match(patch.keys.patchKey, /^PK1-[0-9a-f]{16}$/);
  assert.match(patch.canonicalAddress, /^goldberg-gp-v1\/w0\/v16\//, 'адрес строго на canonicalV (И-1)');

  const second = await handler.handle({ type: 'extract-patch', token: 't1', requestId: 'r4', cell: hexCell });
  const patch2 = firstOfType(second, 'patch-ready');
  assert.deepEqual(patch2.keys, patch.keys, 'ключи §8.8 детерминированы');
  assert.equal(patch2.canonicalAddress, patch.canonicalAddress);
  assert.deepEqual(patch2.patch.frame, patch.patch.frame, 'касательный кадр детерминирован');

  // Ошибка: ячейка вне канонической сетки.
  const bad = await handler.handle({ type: 'extract-patch', token: 't1', requestId: 'r5', cell: 999999 });
  const err = firstOfType(bad, 'error');
  assert.ok(err, 'вне диапазона должен прийти error');
});

test('stage7-worker: пятиугольная ячейка полюса резолвится в шестиугольного соседа', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  await handler.handle({
    type: 'generate', token: 't1', requestId: 'r1',
    profile: WORKER_PROFILE, renderV: 16, colorMode: 'biome',
  });
  const workerGrid = GeodesicGrid.build(16);
  let pentagon = -1;
  let pentagonCount = 0;
  for (let c = 0; c < workerGrid.cellCount; c++) {
    if (workerGrid.neighborCount[c] === 5) {
      pentagonCount++;
      if (pentagon < 0) pentagon = c;
    }
  }
  assert.equal(pentagonCount, 12, 'у Голдберга ровно 12 пятиугольных вершин икосаэдра');

  const out = await handler.handle({ type: 'extract-patch', token: 't1', requestId: 'r6', cell: pentagon });
  const patch = firstOfType(out, 'patch-ready');
  assert.ok(patch, 'должен прийти patch-ready');
  assert.equal(patch.requestedCell, pentagon);
  assert.notEqual(patch.hexCenterCell, pentagon, 'центр сместился с пятиугольника');
  assert.equal(workerGrid.neighborCount[patch.hexCenterCell], 6, 'новый центр — шестиугольник');
  assert.ok(
    Array.from({ length: 6 }, (_, slot) => workerGrid.neighbors[pentagon * 6 + slot]).includes(patch.hexCenterCell),
    'резолв идёт в соседа пятиугольника',
  );
  assert.equal(patch.invariants.ok, true, JSON.stringify(patch.invariants.checks));
  for (const check of ['patch7-shape', 'tangent-identity', 'flood-hold', 'river-topology', 'spawn-ban']) {
    assert.equal(patch.invariants.checks[check], true, check);
  }
  assert.match(patch.canonicalAddress, /^goldberg-gp-v1\/w0\/v16\//);

  // prefetch по пятиугольнику тоже резолвится в шестиугольный центр.
  const pref = await handler.handle({ type: 'prefetch', token: 't1', requestId: 'r7', focusCell: pentagon });
  const p = firstOfType(pref, 'prefetch-ready');
  assert.ok(p && p.patchReady === true);
  assert.equal(p.hexCenterCell, patch.hexCenterCell, 'prefetch и extract-patch согласованы');
});

/* ------------------------------------------------- глобус на mock WebGL2 */

function makeMockGL() {
  const state = {
    uniform1fCalls: [],
    boundVaos: [],
    createdVaos: [],
    deletedVaos: [],
    createdBuffers: [],
    deletedBuffers: [],
    drawElements: [],
    drawArrays: [],
  };
  const locationCache = new Map();
  const gl = {
    COMPILE_STATUS: 'COMPILE_STATUS',
    LINK_STATUS: 'LINK_STATUS',
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    ARRAY_BUFFER: 34962,
    ELEMENT_ARRAY_BUFFER: 34963,
    STATIC_DRAW: 35044,
    DYNAMIC_DRAW: 35048,
    FLOAT: 5126,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_INT: 5125,
    TRIANGLES: 4,
    LINE_LOOP: 2,
    COLOR_BUFFER_BIT: 16384,
    DEPTH_BUFFER_BIT: 256,
    DEPTH_TEST: 2929,
    BLEND: 3042,
    CULL_FACE: 2884,
    BACK: 1029,
    FRONT: 1028,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    createShader() { return { kind: 'shader' }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ''; },
    createProgram() { return { kind: 'program' }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    getUniformLocation(program, name) {
      const key = String(name);
      if (!locationCache.has(key)) locationCache.set(key, { name: key });
      return locationCache.get(key);
    },
    createVertexArray() { const vao = { kind: 'vao' }; state.createdVaos.push(vao); return vao; },
    bindVertexArray(vao) { state.boundVaos.push(vao); },
    deleteVertexArray(vao) { state.deletedVaos.push(vao); },
    createBuffer() { const buf = { kind: 'buffer' }; state.createdBuffers.push(buf); return buf; },
    bindBuffer() {},
    bufferData() {},
    bufferSubData() {},
    deleteBuffer(buf) { state.deletedBuffers.push(buf); },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    viewport() {},
    clearColor() {},
    clear() {},
    enable() {},
    disable() {},
    depthMask() {},
    cullFace() {},
    blendFunc() {},
    useProgram() {},
    uniformMatrix4fv() {},
    uniform3f() {},
    uniform4f() {},
    uniform1f(loc, value) { state.uniform1fCalls.push({ name: loc.name, value }); },
    drawElements(target, count, type, offset) { state.drawElements.push({ count, offset }); },
    drawArrays(mode, first, count) { state.drawArrays.push({ mode, first, count }); },
  };
  return { gl, state };
}

function makeMockCanvas(mockGL) {
  const listeners = new Map();
  return {
    clientWidth: 800,
    clientHeight: 600,
    width: 0,
    height: 0,
    listeners,
    getContext(type) { return type === 'webgl2' ? mockGL : null; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
  };
}

function pump(now) {
  const batch = rafQueue.splice(0);
  for (const cb of batch) cb(now);
}

function uniformValues(state, name) {
  return state.uniform1fCalls.filter((call) => call.name === name).map((call) => call.value);
}

function makeGlobe() {
  const { gl, state } = makeMockGL();
  const canvas = makeMockCanvas(gl);
  const intents = [];
  const handle = PlanetGlobe.createPlanetGlobe(canvas, {
    autoRotate: false,
    borders: false,
    atmosphere: false,
    onCameraIntent: (intent) => intents.push(intent),
  });
  assert.ok(handle, 'глобус создан на mock WebGL2');
  const geometryA = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'biome' });
  const geometryB = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'rivers' });
  return { gl, state, canvas, intents, handle, geometryA, geometryB };
}

test('stage7-globe: transitionGeometry рисует два слоя (uHide/uCenterGrow) и освобождает prev-слой', () => {
  const { state, handle, geometryA, geometryB } = makeGlobe();

  handle.setGeometry(geometryA);
  pump(performance.now());
  assert.ok(state.drawElements.length > 0, 'первый слой рисуется');

  // Волна центробежного замещения: prev = biome, новый = rivers.
  const startMs = performance.now();
  handle.transitionGeometry(geometryB, 0.45);
  assert.equal(handle.isGeometryUploading(), true, 'новая геометрия заливается порциями');

  // Середина волны (t ~= 0.5): уходящий слой с uHide = t, новый с uCenterGrow = t.
  state.uniform1fCalls.length = 0;
  const midBound = state.boundVaos.length;
  pump(startMs + 225);
  const hide = uniformValues(state, 'uHide');
  const grow = uniformValues(state, 'uCenterGrow');
  const build = uniformValues(state, 'uBuild');
  assert.ok(hide.length >= 2, 'в кадре волны рисуются оба слоя');
  assert.ok(Math.abs(hide[0] - 0.5) < 0.06, 'уходящий слой: uHide = t (t ~= 0.5)');
  assert.equal(hide[hide.length - 1], 0, 'новый слой: uHide = 0');
  assert.ok(Math.abs(grow[grow.length - 1] - 0.5) < 0.06, 'новый слой: uCenterGrow = t');
  assert.ok(build.every((v) => v === 1.0), 'в волне каскадная сборка не перезапускается (uBuild = 1)');
  assert.equal(state.boundVaos.length - midBound >= 2, true, 'оба VAO биндятся в кадре волны');

  // Конец волны (t >= 1): prev-слой немедленно освобождается.
  const deletedBefore = state.deletedVaos.length;
  pump(startMs + 470);
  pump(startMs + 520);
  assert.ok(state.deletedVaos.length > deletedBefore, 'prevVao удалён по завершении волны');
  const tail = state.uniform1fCalls.slice(-3).map((call) => call.name);
  assert.ok(tail.includes('uBuild'), 'после волны обычный проход с uBuild');
  handle.dispose();
});

test('stage7-globe: getCameraState согласован с model-матрицей (viewDirection = центр экрана)', () => {
  const { handle } = makeGlobe();
  const cam = handle.getCameraState();
  assert.ok(Math.abs(cam.rotY - (-0.65)) < 1e-9, 'стартовый yaw');
  assert.ok(Math.abs(cam.rotX - 0.38) < 1e-9, 'стартовый pitch');
  assert.ok(Math.abs(cam.distance - 3.05) < 0.1);
  const len = Math.hypot(cam.viewDirection[0], cam.viewDirection[1], cam.viewDirection[2]);
  assert.ok(Math.abs(len - 1) < 1e-9, 'viewDirection единичный');
  const cp = Math.cos(cam.rotX), sp = Math.sin(cam.rotX);
  const cy = Math.cos(cam.rotY), sy = Math.sin(cam.rotY);
  assert.ok(Math.abs(cam.viewDirection[0] - (-cp * sy)) < 1e-9);
  assert.ok(Math.abs(cam.viewDirection[1] - sp) < 1e-9);
  assert.ok(Math.abs(cam.viewDirection[2] - cp * cy) < 1e-9);
  handle.dispose();
});

test('stage7-globe: flyToDirection доводит point сферы до центра экрана с easeOutCubic', () => {
  const { handle } = makeGlobe();
  const target = [0, 0, 1];
  const startMs = performance.now();
  handle.flyToDirection(target, 2.0, 650);
  const samples = [];
  for (let step = 0; step <= 12; step++) {
    pump(startMs + (step * 650) / 12);
    const cam = handle.getCameraState();
    samples.push({ t: step / 12, yaw: cam.rotY, pitch: cam.rotX, dist: cam.distance });
  }
  const final = handle.getCameraState();
  assert.ok(Math.abs(final.viewDirection[0] - 0) < 1e-6, 'dx в центре');
  assert.ok(Math.abs(final.viewDirection[1] - 0) < 1e-6, 'dy в центре');
  assert.ok(Math.abs(final.viewDirection[2] - 1) < 1e-6, 'dz в центре');
  assert.ok(Math.abs(final.rotX - 0) < 1e-6, 'targetRotX = asin(dy)');
  assert.ok(Math.abs(final.rotY - 0) < 1e-6, 'targetRotY = atan2(-dx, dz)');
  assert.ok(Math.abs(final.distance - 2.0) < 0.02, 'дистанция подлёта');

  // easeOutCubic: первая треть покрывает больше половины пути по yaw.
  const total = Math.abs(samples[0].yaw - samples[samples.length - 1].yaw);
  const firstThird = Math.abs(samples[0].yaw - samples[4].yaw);
  assert.ok(firstThird > total * 0.5, `замедление к концу (первая треть ${firstThird.toFixed(3)} из ${total.toFixed(3)})`);
  handle.dispose();
});

test('stage7-globe: pointerdown и wheel прерывают авто-подлёт', () => {
  const { canvas, handle } = makeGlobe();
  const startMs = performance.now();
  handle.flyToDirection([0, 0, 1], 2.0, 650);
  pump(startMs + 100);
  canvas.listeners.get('pointerdown')({ pointerId: 7, clientX: 12, clientY: 12, button: 0 });
  const frozen = handle.getCameraState();
  pump(startMs + 400);
  pump(startMs + 800);
  const after = handle.getCameraState();
  assert.equal(after.rotY, frozen.rotY, 'yaw замер после жеста');
  assert.equal(after.rotX, frozen.rotX, 'pitch замер после жеста');
  assert.ok(Math.abs(after.viewDirection[0] - frozen.viewDirection[0]) < 1e-9, 'точка взгляда замерла');
  handle.dispose();

  // Колесо тоже прерывает подлёт (ручной жест).
  const wheelCase = makeGlobe();
  wheelCase.handle.flyToDirection([0, 0, 1], 2.0, 650);
  pump(startMs + 150);
  wheelCase.canvas.listeners.get('wheel')({ deltaY: 40, preventDefault() {} });
  const frozenWheel = wheelCase.handle.getCameraState();
  pump(startMs + 500);
  pump(startMs + 900);
  const afterWheel = wheelCase.handle.getCameraState();
  assert.equal(afterWheel.rotY, frozenWheel.rotY, 'yaw замер после колеса');
  assert.equal(afterWheel.rotX, frozenWheel.rotX, 'pitch замер после колеса');
  wheelCase.handle.dispose();
});

test('stage7-globe: onCameraIntent приходит с debounce 180 мс и валидным zoomRatio', async () => {
  const { canvas, intents, handle } = makeGlobe();
  canvas.listeners.get('wheel')({ deltaY: -120, preventDefault() {} });
  canvas.listeners.get('wheel')({ deltaY: -60, preventDefault() {} });
  canvas.listeners.get('wheel')({ deltaY: -30, preventDefault() {} });
  assert.equal(intents.length, 0, 'до debounced-окна вызовов нет');
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(intents.length, 1, 'три жеста в окне схлопываются в один интент');
  const intent = intents[0];
  const cam = handle.getCameraState();
  assert.ok(Math.abs(intent.distance - cam.distance) < 1e-9);
  const len = Math.hypot(intent.viewDirection[0], intent.viewDirection[1], intent.viewDirection[2]);
  assert.ok(Math.abs(len - 1) < 1e-9, 'viewDirection единичный');
  assert.ok(intent.zoomRatio > 0.5 && intent.zoomRatio < 1, `zoomRatio в (0.5, 1) после зума: ${intent.zoomRatio}`);
  handle.dispose();
});

/* ------------- Stage-8.8.2 (A-1): прокси и финал одной генерации -------------
   Один запрос с необязательным proxyV приносит обе геометрии того же
   канонического расчёта. Проверяем эквивалентность отдельным запросам,
   счётчик генерации поверхности, transfer-контракт и цвета по renderV. */

function generateReady(handler, message) {
  return handler.handle(Object.assign({ type: 'generate', token: 'a1', colorMode: 'biome' }, message))
    .then((out) => out.find((m) => m.type === 'ready') || null);
}

function bytesOf(array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

function assertSameBytes(actual, expected, label) {
  assert.equal(actual.byteLength, expected.byteLength, label + ': длина массива');
  assert.ok(bytesOf(actual).equals(bytesOf(expected)), label + ': байты совпадают');
}

function assertSameGeometry(actual, expected, label) {
  assertSameBytes(actual.positions, expected.positions, label + ' positions');
  assertSameBytes(actual.normals, expected.normals, label + ' normals');
  assertSameBytes(actual.colors, expected.colors, label + ' colors');
  assertSameBytes(actual.indices, expected.indices, label + ' indices');
  assert.equal(actual.vertexCount, expected.vertexCount, label + ': vertexCount');
  assert.equal(actual.triangleCount, expected.triangleCount, label + ': triangleCount');
  assert.equal(actual.cellCount, expected.cellCount, label + ': cellCount');
  assert.equal(actual.v, expected.v, label + ': v');
}

test('stage8.8.2-a1: совмещённый ответ побайтово равен двум отдельным запросам', async () => {
  // Канон v=16 (radius 797): финал тоже проекция, прокси — вдвое грубее.
  const merged = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'm1', profile: WORKER_PROFILE, renderV: 16, proxyV: 8 });
  assert.ok(merged, 'совмещённый запрос завершается ready');
  assert.ok(merged.proxy, 'в ответе есть прокси-слой');
  assert.equal(merged.proxy.renderV, 8);
  assert.equal(merged.proxy.cellCount, merged.proxy.geometry.cellCount);

  const soloProxy = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'p1', profile: WORKER_PROFILE, renderV: 8 });
  assert.ok(!('proxy' in soloProxy), 'отдельный запрос без proxyV поля proxy не содержит');
  assertSameGeometry(merged.proxy.geometry, soloProxy.geometry, 'прокси ≠ отдельный запрос v=8');

  const soloFinal = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'f1', profile: WORKER_PROFILE, renderV: 16 });
  assertSameGeometry(merged.geometry, soloFinal.geometry, 'финал ≠ отдельный запрос v=16');

  // Тот же контракт, когда финал тоже грубее канона.
  const mergedSmall = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'm2', profile: WORKER_PROFILE, renderV: 8, proxyV: 4 });
  assert.ok(mergedSmall.proxy && mergedSmall.proxy.renderV === 4);
  const soloProxy4 = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'p2', profile: WORKER_PROFILE, renderV: 4 });
  const soloFinal8 = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'f2', profile: WORKER_PROFILE, renderV: 8 });
  assertSameGeometry(mergedSmall.proxy.geometry, soloProxy4.geometry, 'прокси v=4');
  assertSameGeometry(mergedSmall.geometry, soloFinal8.geometry, 'финал v=8');
});

test('stage8.8.2-a1: одна генерация поверхности на запрос (было две)', async () => {
  const original = PlanetSurface.generateSurfaceAsync;
  let calls = 0;
  PlanetSurface.generateSurfaceAsync = function (...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    // Прежний сценарий страницы: прокси-запрос, затем отдельный финальный.
    calls = 0;
    const legacy = PlanetGlobeWorker.createWorkerHandler();
    await generateReady(legacy, { requestId: 'l1', profile: WORKER_PROFILE, renderV: 8 });
    await generateReady(legacy, { requestId: 'l2', profile: WORKER_PROFILE, renderV: 16 });
    assert.equal(calls, 2, 'два запроса считают каноническую поверхность дважды (прежний код)');

    // Совмещённый запрос: одна каноническая генерация, две геометрии.
    calls = 0;
    const merged = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
      { requestId: 'c1', profile: WORKER_PROFILE, renderV: 16, proxyV: 8 });
    assert.equal(calls, 1, 'совмещённый запрос считает поверхность ровно один раз');
    assert.ok(merged.proxy, 'обе геометрии на месте при одной генерации');
  } finally {
    PlanetSurface.generateSurfaceAsync = original;
  }
});

test('stage8.8.2-a1: transfer list без дублей, прокси-буферы переносятся и отсоединяются', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  const out = await handler.handle({
    type: 'generate', token: 'a1', requestId: 'c2',
    profile: WORKER_PROFILE, renderV: 16, proxyV: 8, colorMode: 'biome',
  });
  const readyIndex = out.findIndex((m) => m.type === 'ready');
  assert.ok(readyIndex >= 0);
  const ready = out[readyIndex];
  const transfer = handler.lastTransfers()[readyIndex];
  assert.ok(Array.isArray(transfer) && transfer.length >= 8, 'в transfer list оба слоя');

  const unique = new Set(transfer);
  assert.equal(unique.size, transfer.length, 'ни один ArrayBuffer не встречается дважды');

  const finalBuffers = [ready.geometry.positions, ready.geometry.normals, ready.geometry.colors, ready.geometry.indices]
    .map((array) => array.buffer);
  const proxyBuffers = [ready.proxy.geometry.positions, ready.proxy.geometry.normals,
    ready.proxy.geometry.colors, ready.proxy.geometry.indices].map((array) => array.buffer);
  for (const buffer of finalBuffers.concat(proxyBuffers)) {
    assert.ok(transfer.includes(buffer), 'буфер в transfer list');
  }

  // Фактический перенос в main thread: после него прокси-буферы отсоединены.
  structuredClone({ geometry: ready.geometry, proxy: ready.proxy }, { transfer });
  for (const buffer of proxyBuffers) assert.equal(buffer.byteLength, 0, 'прокси-буфер отсоединён переносом');
  for (const buffer of finalBuffers) assert.equal(buffer.byteLength, 0, 'финальный буфер отсоединён переносом');

  // Страница освобождает CPU-буферы прокси сразу после подмены VAO.
  const page = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  assert.ok(/releaseProxyGeometryBuffers\(proxyGeometry\)/.test(page),
    'страница освобождает прокси-буферы после подмены VAO');
});

test('stage8.8.2-a1: color-mode с renderV отвечает цветами того слоя, что на экране', async () => {
  const handler = PlanetGlobeWorker.createWorkerHandler();
  const ready = await generateReady(handler, { requestId: 'c3', profile: WORKER_PROFILE, renderV: 16, proxyV: 8 });
  const proxyColors = (await handler.handle({
    type: 'color-mode', token: 'a1', requestId: 'k1', mode: 'rivers', renderV: 8,
  })).find((m) => m.type === 'colors');
  const finalColors = (await handler.handle({
    type: 'color-mode', token: 'a1', requestId: 'k2', mode: 'rivers',
  })).find((m) => m.type === 'colors');
  const otherV = (await handler.handle({
    type: 'color-mode', token: 'a1', requestId: 'k3', mode: 'rivers', renderV: 99,
  })).find((m) => m.type === 'colors');

  assert.equal(proxyColors.colors.length, ready.proxy.geometry.colors.length, 'цвета прокси по числу вершин прокси');
  assert.equal(proxyColors.colors.length, ready.proxy.geometry.vertexCount * 4);
  assert.equal(finalColors.colors.length, ready.geometry.colors.length, 'цвета финала по числу вершин финала');
  assert.equal(finalColors.colors.length, ready.geometry.vertexCount * 4);
  assert.notEqual(proxyColors.colors.length, finalColors.colors.length, 'слои разной частоты');
  assert.equal(otherV.colors.length, finalColors.colors.length, 'renderV вне слоёв — цвета по current (финал)');
  assert.ok(bytesOf(proxyColors.colors).length > 0 && bytesOf(otherV.colors).length > 0);
});

test('stage8.8.2-a1: запрос без proxyV даёт побайтово прежний ответ и без поля proxy', async () => {
  const plain = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'b1', profile: WORKER_PROFILE, renderV: 16 });
  const sameV = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'b2', profile: WORKER_PROFILE, renderV: 16, proxyV: 16 });
  const biggerV = await generateReady(PlanetGlobeWorker.createWorkerHandler(),
    { requestId: 'b3', profile: WORKER_PROFILE, renderV: 16, proxyV: 32 });

  for (const [label, msg] of [['proxyV = renderV', sameV], ['proxyV > renderV', biggerV]]) {
    assert.ok(!('proxy' in plain), 'без proxyV поля proxy нет');
    assert.ok(!('proxy' in msg), label + ': поля proxy нет');
    assertSameGeometry(msg.geometry, plain.geometry, label);
    for (const field of ['canonicalV', 'renderV', 'cellCount', 'renderCellCount', 'vertexCount',
      'triangleCount', 'geometryBytes', 'generationKey', 'seaLevel']) {
      assert.deepEqual(msg.summary[field], plain.summary[field], label + ': ' + field);
    }
  }

  // pick и extract-patch после совмещённой генерации — по канонической сетке.
  const handler = PlanetGlobeWorker.createWorkerHandler();
  const merged = await generateReady(handler, { requestId: 'b4', profile: WORKER_PROFILE, renderV: 8, proxyV: 4 });
  assert.equal(merged.summary.canonicalV, 16);
  const grid = GeodesicGrid.build(16);
  let hexCell = -1;
  for (let c = 0; c < grid.cellCount; c++) {
    if (grid.neighborCount[c] === 6) { hexCell = c; break; }
  }
  const pick = (await handler.handle({
    type: 'pick', token: 'a1', requestId: 'b5', cell: hexCell, purpose: 'select',
  })).find((m) => m.type === 'pick-result');
  assert.ok(pick && pick.info, 'pick отвечает после совмещённой генерации');
  assert.equal(pick.info.cell, hexCell, 'pick по-прежнему канонический (И-1)');
  assert.match(pick.info.address, /^goldberg-gp-v1\/w0\/v16\//);
  const patch = (await handler.handle({
    type: 'extract-patch', token: 'a1', requestId: 'b6', cell: hexCell,
  })).find((m) => m.type === 'patch-ready');
  assert.ok(patch, 'extract-patch отвечает после совмещённой генерации');
  assert.equal(patch.patch.v, 16, 'Patch7 канонический, не прокси-сетка');
  assert.equal(patch.invariants.ok, true, JSON.stringify(patch.invariants.checks));
});

test('stage8.8.2-a1: страница отправляет прокси-частоту первым же запросом и не шлёт второй generate', () => {
  const page = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  // 1. Первый запрос — сразу финальная renderV с прокси-частотой в том же сообщении.
  assert.match(page, /requestRender\(profile, key, estimates\.target, estimates\.target,[\s\S]{0,80}firstV\)/,
    'startGeneration отправляет один совмещённый запрос');
  assert.ok(/const proxyV = proxyRequestV != null && proxyRequestV < renderV/.test(page),
    'прокси-частота попадает в generate как proxyV');
  assert.ok(/if \(proxyV > 0\) post\.proxyV = proxyV;/.test(page), 'поле proxyV заполняется в GenerateMessage');
  // 2. Резервный scheduleUpgrade не отправляет второй generate для совмещённого ответа.
  assert.match(page, /if \(request\.proxyV > 0 && request\.proxyV < request\.renderV\) return;/,
    'scheduleUpgrade молчит, когда прокси пришёл в том же ответе');
  // 3. Финал приходит волной transitionGeometry(..., 0.45) после кадра с прокси.
  assert.match(page, /globe\.transitionGeometry\(target, 0\.45\)/, 'финал подменяется волной 0.45');
  // 4. Слой во время показа прокси запрашивается с renderV показанной геометрии.
  assert.match(page, /if \(proxyShown\) post\.renderV = displayedLayerV as number;/,
    'color-mode в окне прокси несёт renderV прокси-слоя');
});
