/* Node-тест Этапа 8 (волна Stage-8, Воркер 1): непрерывность локальной карты
   по Инварианту И-3 и порционная (staged) GPU-догрузка StructureRenderer по
   Патчу 8. Запуск: node --test tests/local-map-stage8.test.mjs (подключён в
   скрипт "test" package.json и в .github/workflows/check.yml).
   --------------------------------------------------------------------------
   Проверяет:
   1. generateLocalMap: привязку высот к каноническим filledElevation/seaLevel
      Patch7 (И-3.2), врез речного русла вдоль входа/выхода по общим граням
      (И-3.3), работу 3D-сэмплера при переданном profile (И-3.1), нулевой
      спавн структур в воде/озёрах/руслах (И-3.4), диагностику meta
      (totalInstances, buildableFraction, waterFraction, genMs <= 150) и
      LRU-кэш участков с клонированием буферов.
   2. StructureRenderer на mock WebGL2: VAO рельефа и модулей создаются ровно
      один раз, повторные участки обновляются через gl.bufferSubData,
      compilePrograms/renderFrame/dispose работают и освобождают ресурсы. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Worker = require('../src/local-map/local-map-worker.ts');
const RendererModule = require('../src/local-map/local-map-renderer.ts');
const Shaders = require('../src/local-map/local-map-shaders.ts');
const Mesh = require('../src/local-map/local-map-mesh.ts');

const HF_RES = Worker.HEIGHTFIELD_RES;
const CENTER = Math.floor(HF_RES / 2) * HF_RES + Math.floor(HF_RES / 2);
const RADIUS_M = 30000;

// Профиль повторяет tests/local-map.test.mjs: нормы v=16 как доля канонической
// Земли v=128 — тот же физический масштаб, что у LOD-прокси глобуса.
const PROFILE = {
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

const grid = GeodesicGrid.build(16);
const surface = PlanetSurface.generateSurface(grid, PROFILE);

const M_PER_UNIT = Worker.METERS_PER_ELEVATION_UNIT;
const STRICT_RULE = { minLand: 1, maxSlope: 0 };   // спавн запрещён всюду

function isHex(cell) {
  return grid.neighborCount[cell] === 6;
}

function cellIsLand(cell) {
  return surface.elevation[cell] >= surface.seaLevel && surface.lakeWeight[cell] === 0;
}

/** Речной центр: суша с руслом, притоком с суши и выходной гранью. */
function pickRiverCenter() {
  let best = -1;
  let bestAcc = -1;
  for (let c = 0; c < grid.cellCount; c++) {
    if (!isHex(c) || !cellIsLand(c) || surface.streamWeight[c] <= 0) continue;
    if (surface.flowReceiver[c] < 0) continue;
    const patch = Contract.buildPatch7(grid, surface, c);
    const inlandInlets = patch.river.inlets.filter((edge) => cellIsLand(edge.neighborCell)).length;
    if (inlandInlets === 0) continue;
    if (surface.flowAccumulationKm2[c] > bestAcc) {
      bestAcc = surface.flowAccumulationKm2[c];
      best = c;
    }
  }
  return best;
}

/** Сухой центр: суша, не озеро, не русло, пологий, достаточно суши. */
function pickDryCenter() {
  const rule = Contract.DEFAULT_BUILDING_SPAWN_RULE;
  for (let c = 0; c < grid.cellCount; c++) {
    if (!isHex(c) || !cellIsLand(c)) continue;
    if (surface.streamWeight[c] > 0 || surface.slope[c] >= rule.maxSlope) continue;
    if (surface.muLand[c] < rule.minLand) continue;
    return c;
  }
  return -1;
}

function pickWaterCenter() {
  for (let c = 0; c < grid.cellCount; c++) {
    if (!isHex(c)) continue;
    const patch = Contract.buildPatch7(grid, surface, c);
    if (patch.cells.every((cell) => Contract.isWaterCell(cell, patch.seaLevel))) return c;
  }
  return -1;
}

const riverCenter = pickRiverCenter();
const dryCenter = pickDryCenter();
const waterCenter = pickWaterCenter();

const riverPatch = riverCenter >= 0 ? Contract.buildPatch7(grid, surface, riverCenter) : null;
const dryPatch = dryCenter >= 0 ? Contract.buildPatch7(grid, surface, dryCenter) : null;
const waterPatch = waterCenter >= 0 ? Contract.buildPatch7(grid, surface, waterCenter) : null;

/** «Двойник» речного патча без русла: те же ячейки, но flowsThroughCenter = false. */
function stripRiver(patch) {
  const cells = patch.cells.map((cell, index) => (index === 0
    ? { ...cell, streamWeight: 0, flowReceiver: -1 }
    : cell));
  return {
    ...patch,
    cells,
    river: {
      centerCell: patch.river.centerCell,
      flowsThroughCenter: false,
      centerStreamWeight: 0,
      centerRiverAccumulation: 0,
      inlets: [],
      outlet: null,
    },
  };
}

function requestFor(patch, overrides = {}) {
  return { patch, seed: 12345, placeId: 7, radiusM: RADIUS_M, ...overrides };
}

/** Индекс ячейки heightfield по мировым координатам инстанса (x, y).
    scatterInstances кладёт инстанс в ячейку floor(px), floor(py), где
    (px, py) — дробные координаты jittered-сетки, поэтому восстанавливаем
    именно floor (с допуском на округление double). */
function heightfieldIndexFor(instance, radiusM) {
  const cellSize = (2 * radiusM) / HF_RES;
  const px = Math.floor(instance.data[0] / cellSize + HF_RES / 2 + 1e-6);
  const py = Math.floor(instance.data[1] / cellSize + HF_RES / 2 + 1e-6);
  return { index: py * HF_RES + px, px, py };
}

// ---------------------------------------------------------------------------
// 1. Непрерывность рельефа и рек по И-3
// ---------------------------------------------------------------------------

test('И-3.2: высоты суши привязаны к filledElevation/seaLevel канонических ячеек', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'anchors' }));

  const landMax = Worker.LAND_FBM_AMPLITUDE_M;
  let landChecked = 0;
  for (let y = 0; y < HF_RES; y += 16) {
    for (let x = 0; x < HF_RES; x += 16) {
      const cellSize = (2 * RADIUS_M) / HF_RES;
      const wx = (x - HF_RES / 2) * cellSize;
      const wy = (y - HF_RES / 2) * cellSize;
      const cell = Contract.nearestPatchCell(dryPatch, Contract.localPointToDirection(dryPatch, wx, wy));
      const height = res.heightfield[y * HF_RES + x];
      if (Contract.isWaterCell(cell, dryPatch.seaLevel)) {
        const mirror = (Contract.waterLevelOf(cell, dryPatch.seaLevel) - dryPatch.seaLevel) * M_PER_UNIT;
        assert.ok(Math.abs(height - mirror) < 1e-3, `зеркало воды ${mirror} != ${height}`);
      } else {
        const anchor = (Contract.baseElevationOf(cell) - dryPatch.seaLevel) * M_PER_UNIT;
        assert.ok(height >= anchor - 1e-3, `суша ниже канонической высоты: ${height} < ${anchor}`);
        assert.ok(height <= anchor + landMax + 1e-3, `суша выше якоря + fBm: ${height} > ${anchor + landMax}`);
        landChecked++;
      }
    }
  }
  assert.ok(landChecked > 0, 'в сухом патче есть проверенные точки суши');
});

test('И-3.2: океаническая/озёрная вода держит зеркало waterLevelOf и запрещает спавн', () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  const res = Worker.generateLocalMap(requestFor(waterPatch, { patchKey: 'water' }));

  const mirror = (Contract.waterLevelOf(waterPatch.cells[0], waterPatch.seaLevel) - waterPatch.seaLevel) * M_PER_UNIT;
  for (let i = 0; i < res.heightfield.length; i += 97) {
    assert.ok(Math.abs(res.heightfield[i] - mirror) < 1e-3, 'вода держит единый уровень зеркала');
  }
  assert.equal(res.meta.waterFraction, 1, 'вся карта — вода');
  assert.equal(res.meta.buildableFraction, 0, 'над водой спавн запрещён');
  assert.equal(res.meta.totalInstances, 0, 'в воде нет ни одного инстанса');
  assert.deepEqual(Object.keys(res.instanceBuffers), [], 'буферы инстансов пусты');

  // Вода не зонируется (applyWaterZoning): зона 0 и плотность 0 во всех текселях,
  // чтобы шейдер рельефа тонировал её как воду, а не как бетон ядра базы.
  assert.equal(res.zoneMap.length, Worker.ZONE_RES * Worker.ZONE_RES * 2);
  for (let i = 0; i < res.zoneMap.length; i++) {
    assert.equal(res.zoneMap[i], 0, 'водный тексель zone_map — зона 0 / плотность 0');
  }
});

test('И-3.3: речное русло врезается от входных граней через центр к выходной', () => {
  assert.ok(riverPatch, 'нужен речной центр с притоком и выходом');
  assert.ok(riverPatch.river.outlet, 'у речного центра есть выходная грань');
  assert.ok(riverPatch.river.inlets.length > 0, 'у речного центра есть входные грани');

  Worker.clearLocalMapCache();
  const strict = { spawnRule: STRICT_RULE };
  const withRiver = Worker.generateLocalMap(requestFor(riverPatch, { ...strict, patchKey: 'river' }));
  // Двойник без русла: строгое правило спавна гасит терраформинг целиком,
  // поэтому карты отличаются ТОЛЬКО врезом русла.
  const twin = Worker.generateLocalMap(requestFor(stripRiver(riverPatch), { ...strict, patchKey: 'river-twin' }));

  assert.equal(withRiver.meta.buildableFraction, 0, 'строгое правило запрещает спавн всюду');
  assert.equal(twin.meta.buildableFraction, 0, 'двойник тоже без спавна');

  const depth = Math.max(6, RADIUS_M * Worker.RIVER_DEPTH_RATIO);
  const centerDrop = twin.heightfield[CENTER] - withRiver.heightfield[CENTER];
  assert.ok(centerDrop > depth * 0.999, `в центре русло врезано на ${centerDrop} из ${depth}`);
  assert.ok(centerDrop <= depth + 1e-3, 'врез не превышает расчётную глубину');

  // Вдали от створа входа → центр → выход карты совпадают точно.
  const farIndex = 20 * HF_RES + 20;
  assert.ok(Math.abs(twin.heightfield[farIndex] - withRiver.heightfield[farIndex]) < 1e-6,
    'вне русла рельеф совпадает с двойником');

  // Врез плавный: берега русла — smoothstep от нуля до полной глубины,
  // поэтому рядом с центром есть точки с промежуточным врезом, а на
  // периферии карты врез отсутствует полностью.
  const mid = Math.floor(HF_RES / 2);
  let partial = 0;
  let outer = 0;
  for (let d = 1; d <= 8; d++) {
    for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      const drop = twin.heightfield[(mid + dy) * HF_RES + mid + dx] - withRiver.heightfield[(mid + dy) * HF_RES + mid + dx];
      assert.ok(drop >= -1e-6, 'врез только опускает рельеф');
      if (drop > 1e-3 && drop < depth - 1e-3) partial++;
    }
  }
  for (const [x, y] of [[10, 10], [HF_RES - 11, 10], [10, HF_RES - 11]]) {
    const drop = twin.heightfield[y * HF_RES + x] - withRiver.heightfield[y * HF_RES + x];
    if (Math.abs(drop) < 1e-6) outer++;
  }
  assert.ok(partial > 0, 'склон русла плавный (есть промежуточные значения вреза)');
  assert.ok(outer > 0, 'на периферии карты вреза нет');
});

test('И-3.1: при переданном profile рельеф учитывает канал detail единого 3D-сэмплера', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const plain = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'detail-plain' }));
  const detailed = Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'detail-profile',
    profile: { ...PROFILE, geographyVersion: 'c100-soft-v1' },
  }));

  let differing = 0;
  for (let i = 0; i < plain.heightfield.length; i += 61) {
    if (Math.abs(plain.heightfield[i] - detailed.heightfield[i]) > 1e-4) differing++;
  }
  assert.ok(differing > 0, 'канал detail меняет рельеф');
  assert.ok(detailed.meta.maxHeightM > plain.meta.maxHeightM, 'detail поднимает гребни суши');

  // Даже с profile суша не «ныряет» ниже канонической высоты своей ячейки.
  const cellSize = (2 * RADIUS_M) / HF_RES;
  for (let y = 0; y < HF_RES; y += 32) {
    for (let x = 0; x < HF_RES; x += 32) {
      const wx = (x - HF_RES / 2) * cellSize;
      const wy = (y - HF_RES / 2) * cellSize;
      const cell = Contract.nearestPatchCell(dryPatch, Contract.localPointToDirection(dryPatch, wx, wy));
      if (Contract.isWaterCell(cell, dryPatch.seaLevel)) continue;
      const anchor = (Contract.baseElevationOf(cell) - dryPatch.seaLevel) * M_PER_UNIT;
      assert.ok(detailed.heightfield[y * HF_RES + x] >= anchor - 1e-3, 'якорь высоты сохранён');
    }
  }
});

test('И-3.4: инстансы стоят только в точках buildingSpawnMask === 1 и на рельефе', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'spawn' }));
  const mask = Contract.buildBuildingSpawnMask(dryPatch, HF_RES);

  const instances = [];
  for (const pack of Object.values(res.instanceBuffers)) {
    for (let i = 0; i < pack.count; i++) {
      instances.push({ data: Array.from(pack.buffer.subarray(i * 8, i * 8 + 8)) });
    }
  }
  assert.equal(instances.length, res.meta.totalInstances, 'meta.totalInstances совпадает с буферами');
  assert.ok(instances.length > 0, 'в сухом патче есть застройка');

  for (const instance of instances) {
    const { index, px, py } = heightfieldIndexFor(instance, RADIUS_M);
    assert.ok(px >= 0 && px < HF_RES && py >= 0 && py < HF_RES, 'инстанс внутри сетки');
    assert.equal(mask[index], 1, 'инстанс не стоит в воде/озере/русле/на склоне');
    assert.ok(Math.abs(res.heightfield[index] - instance.data[2]) < 1e-3, 'инстанс стоит на рельефе');
  }
  // В воде и руслах застройки нет ни на одной точке маски.
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 1) continue;
    const { px, py } = { px: i % HF_RES, py: Math.floor(i / HF_RES) };
    for (const instance of instances) {
      const at = heightfieldIndexFor(instance, RADIUS_M);
      assert.ok(!(at.px === px && at.py === py), 'в запрещённой точке маски нет инстанса');
    }
  }
});

test('meta Этапа 8: диагностика генерации заполнена, гейт G4 (genMs <= 150 мс) пройден', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'meta' }));
  const meta = res.meta;

  assert.equal(meta.radiusM, RADIUS_M);
  assert.equal(meta.hfRes, HF_RES);
  assert.equal(meta.zoneRes, Worker.ZONE_RES);
  assert.equal(meta.tfRes, Worker.TERRAFORM_RES);
  assert.equal(meta.patchKey, 'meta');
  assert.equal(meta.totalInstances, res.meta.totalInstances);
  assert.ok(meta.buildableFraction > 0 && meta.buildableFraction <= 1, 'доля застраиваемых точек в (0, 1]');
  assert.ok(meta.waterFraction >= 0 && meta.waterFraction <= 1, 'доля воды в [0, 1]');
  assert.ok(meta.minHeightM <= meta.maxHeightM, 'границы высот корректны');
  assert.ok(meta.genMs >= 0 && meta.genMs <= 150, `гейт G4: genMs = ${meta.genMs} мс`);

  // На суше зонирование сохраняется (зоны 1…4 базы).
  let zoned = 0;
  for (let i = 0; i < res.zoneMap.length; i += 2) {
    if (res.zoneMap[i] > 0) zoned++;
  }
  assert.ok(zoned > 0, 'на суше есть зонированные тексели');

  let min = Infinity;
  let max = -Infinity;
  for (const h of res.heightfield) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  assert.ok(Math.abs(meta.minHeightM - min) < 1e-3, 'meta.minHeightM — реальный минимум рельефа');
  assert.ok(Math.abs(meta.maxHeightM - max) < 1e-3, 'meta.maxHeightM — реальный максимум рельефа');
});

test('LRU-кэш участков: 8 записей, клонирование буферов, getCachedLocalMap/clearLocalMapCache', () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  assert.equal(Worker.localMapCacheSize(), 0, 'кэш пуст после очистки');

  const first = Worker.generateLocalMap(requestFor(waterPatch, { placeId: 0, patchKey: 'lru-0' }));
  const key = Worker.localMapCacheKey(requestFor(waterPatch, { placeId: 0, patchKey: 'lru-0' }));
  assert.equal(key, `lru-0:${RADIUS_M}:12345:0`, 'ключ участка соответствует контракту');

  const hitA = Worker.getCachedLocalMap(key);
  const hitB = Worker.getCachedLocalMap(key);
  assert.ok(hitA && hitB, 'повторное обращение находит запись');
  assert.notEqual(hitA.heightfield, hitB.heightfield, 'буферы клонируются, а не отдаются по ссылке');
  assert.notEqual(hitA.heightfield, first.heightfield, 'кэш хранит собственную копию');
  assert.equal(hitA.heightfield[CENTER], hitB.heightfield[CENTER], 'значения высот совпадают');
  hitA.heightfield[CENTER] += 100;
  assert.notEqual(hitA.heightfield[CENTER], Worker.getCachedLocalMap(key).heightfield[CENTER],
    'мутация клона не портит кэш');
  assert.equal(Worker.getCachedLocalMap('нет-такого-ключа'), undefined, 'промах кэша — undefined');

  // Девятая запись вытесняет самую старую (LRU на 8 записей).
  for (let i = 1; i <= 8; i++) {
    Worker.generateLocalMap(requestFor(waterPatch, { placeId: i, patchKey: `lru-${i}` }));
  }
  assert.equal(Worker.localMapCacheSize(), Worker.LOCAL_MAP_CACHE_LIMIT, 'ёмкость кэша — 8 записей');
  assert.equal(Worker.getCachedLocalMap(key), undefined, 'самая старая запись вытеснена');
  assert.ok(Worker.getCachedLocalMap(`lru-8:${RADIUS_M}:12345:8`), 'свежая запись на месте');

  Worker.clearLocalMapCache();
  assert.equal(Worker.localMapCacheSize(), 0, 'кэш очищается полностью');
  assert.equal(Worker.getCachedLocalMap(`lru-8:${RADIUS_M}:12345:8`), undefined, 'после очистки записей нет');
});

// ---------------------------------------------------------------------------
// 2. Порционная (staged) GPU-догрузка StructureRenderer (Патч 8)
// ---------------------------------------------------------------------------

/** Минимальный mock WebGL2-контекста: считает создание/удаление ресурсов. */
function createMockGl() {
  const calls = {
    createVertexArray: 0,
    createBuffer: 0,
    createTexture: 0,
    createProgram: 0,
    deleteVertexArray: 0,
    deleteBuffer: 0,
    deleteTexture: 0,
    deleteProgram: 0,
    bufferData: [],
    bufferSubData: [],
    texImage2D: 0,
    uniforms: [],
    draws: [],
  };
  let nextId = 0;
  const gl = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88E4,
    DYNAMIC_DRAW: 0x88E8,
    FLOAT: 0x1406,
    TRIANGLES: 0x0004,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    TEXTURE_2D: 0x0DE1,
    RG8UI: 0x8237,
    R8: 0x8229,
    RG_INTEGER: 0x8D94,
    RED: 0x1903,
    UNSIGNED_BYTE: 0x1401,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    CLAMP_TO_EDGE: 0x812F,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE0: 0x84C0,
    TEXTURE1: 0x84C1,
    VERTEX_SHADER: 0x8B31,
    FRAGMENT_SHADER: 0x8B30,
    COMPILE_STATUS: 0x8B81,
    LINK_STATUS: 0x8B82,
    createVertexArray() { calls.createVertexArray++; return { kind: 'vao', id: ++nextId }; },
    bindVertexArray() {},
    deleteVertexArray() { calls.deleteVertexArray++; },
    createBuffer() { calls.createBuffer++; return { kind: 'buffer', id: ++nextId }; },
    bindBuffer() {},
    bufferData(target, dataOrSize, usage) {
      const size = typeof dataOrSize === 'number' ? dataOrSize : dataOrSize.byteLength;
      calls.bufferData.push({ target, size, usage });
    },
    bufferSubData(target, offset, data) {
      calls.bufferSubData.push({ target, offset, bytes: data.byteLength });
    },
    deleteBuffer() { calls.deleteBuffer++; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    vertexAttribDivisor() {},
    createTexture() { calls.createTexture++; return { kind: 'texture', id: ++nextId }; },
    bindTexture() {},
    texImage2D() { calls.texImage2D++; },
    texParameteri() {},
    activeTexture() {},
    deleteTexture() { calls.deleteTexture++; },
    createShader(type) { return { kind: 'shader', type, id: ++nextId, source: '', compiled: true, log: '' }; },
    shaderSource(shader, source) { shader.source = String(source); },
    compileShader(shader) {
      const src = shader.source;
      if (!src.startsWith('#version 300 es\n')) {
        shader.compiled = false;
        shader.log = 'WebGL2 §4.3: #version 300 es обязан быть в самом начале шейдера без ведущих пробелов/переводов строк';
        return;
      }
      if (/\busampler2D\b/.test(src) && !/precision\s+(highp|mediump|lowp)\s+usampler2D\s*;/.test(src) && !/uniform\s+(highp|mediump|lowp)\s+usampler2D\b/.test(src)) {
        shader.compiled = false;
        shader.log = "GLSL ES 3.00 §4.5.4: 'usampler2D' : No precision specified";
        return;
      }
      shader.compiled = true;
      shader.log = '';
    },
    getShaderParameter(shader, pname) {
      if (pname === 0x8B81) return Boolean(shader && shader.compiled);
      return true;
    },
    getShaderInfoLog(shader) { return shader && shader.log ? shader.log : ''; },
    deleteShader() {},
    createProgram() { calls.createProgram++; return { kind: 'program', id: ++nextId }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ''; },
    deleteProgram() { calls.deleteProgram++; },
    useProgram() {},
    getUniformLocation(_program, name) { return { kind: 'uniform', name }; },
    uniform1i(location, value) { calls.uniforms.push([location.name, value]); },
    uniform1f(location, value) { calls.uniforms.push([location.name, value]); },
    uniform3fv(location, value) { calls.uniforms.push([location.name, Array.from(value)]); },
    uniformMatrix4fv(location, transpose, value) { calls.uniforms.push([location.name, value.length]); },
    drawElements(mode, count) { calls.draws.push({ kind: 'terrain', count }); },
    drawElementsInstanced(mode, count, type, offset, instances) {
      calls.draws.push({ kind: 'instances', count, instances });
    },
  };
  return { gl, calls };
}

const meshLibrary = Mesh.buildMeshLibrary();
const MODULE_COUNT = Object.keys(meshLibrary).length;

test('StructureRenderer: VAO рельефа и модулей создаются ровно один раз (Патч 8)', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-a' }));
  const { gl, calls } = createMockGl();
  const renderer = new RendererModule.StructureRenderer(gl);

  renderer.initMeshLibrary(meshLibrary);
  assert.equal(calls.createVertexArray, MODULE_COUNT, 'по одному VAO на модуль построек');
  assert.equal(renderer.getVaoStats().moduleVaoCreates, MODULE_COUNT);

  renderer.onWorkerData(payload);
  const afterFirst = calls.createVertexArray;
  assert.equal(renderer.getVaoStats().terrainVaoCreates, 1, 'VAO рельефа создан ровно один раз');
  assert.equal(afterFirst, MODULE_COUNT + 1, 'новых VAO при первом участке не больше одного');
  assert.equal(renderer.ready, true, 'синхронный onWorkerData сразу готов к рендеру');
  assert.equal(renderer.isUploading(), false);

  // Предвыделенные буферы: индексы Uint32Array квардов и DYNAMIC_DRAW-вершины.
  const expectedIndices = (HF_RES - 1) * (HF_RES - 1) * 6 * 4;
  const indexUpload = calls.bufferData.find(
    (entry) => entry.target === gl.ELEMENT_ARRAY_BUFFER && entry.size === expectedIndices,
  );
  assert.ok(indexUpload, 'индексный буфер рельефа — Uint32Array на всю сетку');
  const vertexUploads = calls.bufferData.filter(
    (entry) => entry.target === gl.ARRAY_BUFFER && entry.size === HF_RES * HF_RES * 3 * 4,
  );
  assert.equal(vertexUploads.length, 2, 'позиции и нормали предвыделены на res² вершин');
  assert.ok(vertexUploads.every((entry) => entry.usage === gl.DYNAMIC_DRAW), 'вершины — DYNAMIC_DRAW');

  // Повторные участки не пересоздают VAO и идут через bufferSubData.
  const subDataBefore = calls.bufferSubData.length;
  for (let i = 0; i < 3; i++) {
    renderer.onWorkerData(Worker.generateLocalMap(requestFor(dryPatch, {
      patchKey: `gpu-a-${i}`, seed: 12345 + i,
    })));
  }
  assert.equal(calls.createVertexArray, afterFirst, 'VAO не пересоздаются при смене участка');
  assert.equal(renderer.getVaoStats().terrainVaoCreates, 1, 'terrainVaoCreates === 1');
  assert.ok(calls.bufferSubData.length > subDataBefore, 'данные идут через gl.bufferSubData');
  assert.equal(renderer.getVaoStats().stagedSubDataCalls, calls.bufferSubData.length,
    'статистика учитывает все порционные заливки');
  assert.ok(renderer.getVaoStats().stagedSubDataCalls > 0);

  renderer.dispose();
  assert.ok(calls.deleteVertexArray >= MODULE_COUNT + 1, 'VAO освобождены');
  assert.ok(calls.deleteBuffer >= MODULE_COUNT * 4 + 3, 'буферы освобождены');
  assert.ok(calls.deleteTexture >= 2, 'текстуры освобождены');
  assert.equal(renderer.ready, false, 'после dispose рендер выключен');
});

test('StructureRenderer: порционная догрузка по бюджету и прогресс 0..1', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-b' }));
  const { gl, calls } = createMockGl();
  const renderer = new RendererModule.StructureRenderer(gl);
  renderer.initMeshLibrary(meshLibrary);

  renderer.enqueueWorkerData(payload, 0);
  assert.equal(renderer.isUploading(), true, 'после постановки в очередь догрузка активна');
  assert.equal(renderer.ready, false, 'до конца догрузки кадр не готов');
  assert.ok(renderer.getUploadProgress() < 1, 'прогресс меньше 1');

  let steps = 0;
  let done = false;
  while (!done && steps < 1000) {
    done = renderer.processPendingUpload(0);
    steps++;
    const progress = renderer.getUploadProgress();
    assert.ok(progress >= 0 && progress <= 1, `прогресс в 0..1 (${progress})`);
  }
  assert.equal(done, true, 'догрузка завершилась');
  assert.ok(steps > 1, 'загрузка разбита на несколько порций');
  assert.equal(renderer.isUploading(), false);
  assert.equal(renderer.getUploadProgress(), 1, 'после завершения прогресс равен 1');
  assert.equal(renderer.ready, true);
  assert.equal(renderer.getVaoStats().terrainVaoCreates, 1, 'порции не пересоздают VAO');
  assert.ok(calls.bufferSubData.length > 1, 'порций bufferSubData больше одной');

  // Бюджет в мс: нулевой бюджет гарантированно прерывает загрузку после
  // первой порции, неограниченный — доводит её до конца (детерминированно
  // на mock-контексте, где время уходит только на CPU-расчёты).
  renderer.enqueueWorkerData(payload, 2.5);
  assert.equal(renderer.isUploading(), true, 'очередь снова активна');
  assert.equal(renderer.processPendingUpload(0), false, 'нулевой бюджет не завершает загрузку');
  assert.equal(renderer.isUploading(), true, 'загрузка продолжается после исчерпания бюджета');
  assert.equal(renderer.processPendingUpload(Infinity), true, 'неограниченный бюджет завершает загрузку');
});

test('StructureRenderer: compilePrograms, renderFrame и dispose работают на mock WebGL2', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-c' }));
  const { gl, calls } = createMockGl();
  const renderer = new RendererModule.StructureRenderer(gl);
  renderer.initMeshLibrary(meshLibrary);
  renderer.onWorkerData(payload);

  const programs = renderer.compilePrograms();
  assert.ok(programs.terrainProgram && programs.structureProgram, 'обе программы собраны');
  assert.notEqual(programs.terrainProgram, programs.structureProgram, 'программы различны');
  assert.equal(calls.createProgram, 2, 'две программы');
  assert.equal(renderer.compilePrograms().terrainProgram, programs.terrainProgram, 'программы кэшируются');

  const viewProj = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  renderer.renderFrame(viewProj, { lightDir: [0, 0, 1], ambientColor: [0.3, 0.3, 0.3], fogColor: [0.5, 0.6, 0.7] });

  const terrainDraws = calls.draws.filter((draw) => draw.kind === 'terrain');
  const instanceDraws = calls.draws.filter((draw) => draw.kind === 'instances');
  assert.equal(terrainDraws.length, 1, 'рельеф нарисован один раз');
  assert.equal(terrainDraws[0].count, (HF_RES - 1) * (HF_RES - 1) * 6, 'индексы рельефа — вся сетка');
  assert.ok(instanceDraws.length > 0, 'постройки нарисованы инстансингом');
  assert.ok(instanceDraws.every((draw) => draw.instances > 0), 'инстансов больше нуля');

  const uniform = (name) => calls.uniforms.filter((entry) => entry[0] === name).map((entry) => entry[1]);
  assert.ok(uniform('u_viewProj').length >= 2, 'u_viewProj выставлен для обеих программ');
  assert.deepEqual(uniform('u_zoning_map'), [0], 't_zoning — TEXTURE0');
  assert.deepEqual(uniform('u_terraform_map'), [1], 't_terraform — TEXTURE1');
  assert.deepEqual(uniform('u_terrainSize')[0], 2 * RADIUS_M, 'u_terrainSize = 2 * radiusM');
  assert.ok(Math.abs(uniform('u_fogStart')[0] - 0.72 * RADIUS_M) < 1e-3, 'u_fogStart = 0.72 * radiusM');
  assert.ok(Math.abs(uniform('u_fogEnd')[0] - 0.98 * RADIUS_M) < 1e-3, 'u_fogEnd = 0.98 * radiusM');
  assert.equal(calls.texImage2D, 2, 'две текстуры (t_zoning RG8UI и t_terraform R8)');

  renderer.dispose();
  assert.equal(calls.deleteProgram, 2, 'программы освобождены');
  const drawsBefore = calls.draws.length;
  renderer.drawTerrain(programs.terrainProgram);
  renderer.drawStructures(programs.structureProgram);
  renderer.renderFrame(viewProj);
  assert.equal(calls.draws.length, drawsBefore, 'после dispose ничего не рисуется');
});

test('шейдеры Этапа 8: тонирование водных низин, строгое начало #version 300 es и точность usampler2D', () => {
  const terrain = Shaders.TERRAIN_FRAGMENT_SHADER;
  for (const [label, shader] of [
    ['STRUCTURE_VERTEX_SHADER', Shaders.STRUCTURE_VERTEX_SHADER],
    ['STRUCTURE_FRAGMENT_SHADER', Shaders.STRUCTURE_FRAGMENT_SHADER],
    ['TERRAIN_VERTEX_SHADER', Shaders.TERRAIN_VERTEX_SHADER],
    ['TERRAIN_FRAGMENT_SHADER', Shaders.TERRAIN_FRAGMENT_SHADER],
  ]) {
    assert.ok(shader.startsWith('#version 300 es\n'), `${label}: #version 300 es обязан быть в первой строке без ведущих переводов строк (WebGL 2.0 §4.3)`);
    assert.ok(shader.includes('precision highp float;'), `${label}: precision highp float объявлена`);
    assert.ok(shader.includes('precision highp int;'), `${label}: precision highp int объявлена`);
  }
  assert.ok(/precision\s+highp\s+usampler2D\s*;/.test(terrain), 'TERRAIN_FRAGMENT_SHADER: явная точность precision highp usampler2D (GLSL ES 3.00 §4.5.4)');
  assert.ok(terrain.includes('SHALLOW_WATER_COLOR'), 'мелководный оттенок объявлен');
  assert.ok(terrain.includes('DEEP_WATER_COLOR'), 'глубоководный оттенок объявлен');
  assert.ok(terrain.includes('zone == 0u'), 'тонирование только вне зон застройки');
  assert.ok(terrain.includes('v_worldPos.z'), 'глубина считается по мировой высоте');
  assert.ok(terrain.includes('v_worldPos.z <= 0.0'), 'зеркало воды на z == 0 тоже тонируется');
  for (const name of ['u_zoning_map', 'u_terraform_map', 'u_lightDir', 'u_ambientColor', 'u_fogColor']) {
    assert.ok(terrain.includes(name), `юниформ ${name} сохранён`);
  }
  for (const shader of [Shaders.TERRAIN_VERTEX_SHADER, Shaders.STRUCTURE_VERTEX_SHADER]) {
    assert.ok(shader.includes('#version 300 es'), 'GLSL ES 3.00');
    assert.ok(shader.includes('u_fogStart') && shader.includes('u_fogEnd'), 'круговой туман сохранён');
  }
  assert.ok(Shaders.STRUCTURE_VERTEX_SHADER.includes('a_inst_pos_yaw'), 'per-instance атрибут location 2');
  assert.ok(Shaders.STRUCTURE_VERTEX_SHADER.includes('a_inst_scale_tint'), 'per-instance атрибут location 3');
});

test('localMapTransferables: все буферы ответа передаются zero-copy', () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  const res = Worker.generateLocalMap(requestFor(waterPatch, { patchKey: 'transfer' }));
  const transferables = Worker.localMapTransferables(res);
  assert.equal(transferables.length, 3, 'heightfield, zoneMap, terraformMap');
  assert.ok(transferables.includes(res.heightfield.buffer));
  assert.ok(transferables.includes(res.zoneMap.buffer));
  assert.ok(transferables.includes(res.terraformMap.buffer));
});
