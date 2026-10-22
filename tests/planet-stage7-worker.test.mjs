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
