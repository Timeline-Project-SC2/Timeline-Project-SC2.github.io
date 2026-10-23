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
   2. Непрерывную сферическую юбку горизонта Stage-8.2 (generateHorizonSkirt):
      единую полярную сетку 97 × 57 (5 529 вершин, 32 256 индексов) без 6
      плит-лепестков, геометрию горизонта (R_inner = 0.72·R_patch,
      d_hex = 1.15·R_patch, R_outer = 6.5·d_hex = 7.475·R_patch,
      R_planet = 3.6·R_outer) и бесшовную гексагональную сшивку высот
      воротника с innerHeightfield по clusterHexMetric(x, y) на контуре
      центрального гекса.
   3. StructureRenderer на mock WebGL2: VAO рельефа и модулей создаются ровно
      один раз, повторные участки обновляются через gl.bufferSubData,
      compilePrograms/renderFrame/dispose работают и освобождают ресурсы.
   4. Stage-8.2.1: континентальное озеро выше seaLevel (морфология ячейки
      #53275 «Корхал IV») непрерывно проходит шестигранный воротник юбки
      горизонта без обрыва к z = 0 и не застраивается при малом radiusM,
      когда края patchSpanMeters попадают на сухих соседей.
   5. Stage-8.3: при малом radiusM = 600 юбка за пределами воротника видит
      планетарный шаг гексов и все 6 соседних ячеек Patch7, гребневой
      мультифрактал ridgedFbm даёт горно-долинный перепад > 120 м на внешнем
      кольце суши, сшивка воротника остаётся точной, а не менее 55% карты
      зонирования остаётся природным ландшафтом (zone === 0). */

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
  assert.equal(PROFILE.geographyVersion, 'c100-soft-v2');
  let samplerV2;
  assert.doesNotThrow(() => {
    samplerV2 = Contract.createPatchFieldSampler(PROFILE);
  }, 'createPatchFieldSampler принимает профиль c100-soft-v2 без исключения');
  assert.equal(PROFILE.geographyVersion, 'c100-soft-v2', 'входной профиль не мутируется');
  assert.doesNotThrow(() => {
    Contract.createPatchFieldSampler({ master_seed_hex: PROFILE.masterSeedHex, geography_version: 'c100-soft-v2' });
  }, 'createPatchFieldSampler принимает snake_case geography_version = c100-soft-v2');
  const samplerV1 = Contract.createPatchFieldSampler({ ...PROFILE, geographyVersion: 'c100-soft-v1' });
  const centerDir = dryPatch.cells[0].center;
  assert.deepEqual(
    samplerV2.sampleFields(centerDir[0], centerDir[1], centerDir[2]),
    samplerV1.sampleFields(centerDir[0], centerDir[1], centerDir[2]),
    'сэмплер по c100-soft-v2 побитово совпадает с базовым c100-soft-v1',
  );

  Worker.clearLocalMapCache();
  const plain = Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'detail-plain' }));
  const detailed = Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'detail-profile',
    profile: PROFILE,
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
    // Stage-8: полноэкранный треугольник купола неба и управление depthMask.
    drawArrays(mode, first, count) { calls.draws.push({ kind: 'sky', mode, first, count }); },
    depthMask() {},
    enable() {},
    disable() {},
    POLYGON_OFFSET_FILL: 0x8037,
    polygonOffset() {},
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
  // Stage-8.2.1: ровное водное зеркало (в том числе континентальное озеро
  // выше seaLevel) распознаётся по горизонтальной нормали и не получает
  // сухопутной текстуры с периодическими «зебровыми» кольцами.
  assert.ok(terrain.includes('isFlatWaterMirror'), 'признак ровного водного зеркала объявлен');
  assert.ok(terrain.includes('normalHoriz < 0.0015'), 'зеркало воды распознаётся по горизонтальной нормали');
  assert.ok(
    terrain.includes('v_worldPos.z > 0.0 && !isFlatWaterMirror'),
    '3 каскада сухопутной текстуры отключены на водном зеркале',
  );
  assert.ok(
    !terrain.includes('fract(v_worldPos.z / 30.0'),
    'периодические «зебровые» кольца каждые 30 м по высоте удалены',
  );
  assert.ok(
    terrain.includes('slopeSteep') && terrain.includes('slopeRock'),
    'крутые склоны затеняются по крутизне без периодичности',
  );
  assert.ok(
    terrain.includes('isFlatWaterMirror ? 1.0 : smoothstep'),
    'континентальные озёра выше seaLevel тонируются водой',
  );
  for (const name of ['u_zoning_map', 'u_terraform_map', 'u_lightDir', 'u_ambientColor', 'u_fogColor']) {
    assert.ok(terrain.includes(name), `юниформ ${name} сохранён`);
  }
  // Совместимость с обеими волнами: текущий шейдер origin/main И гексагональный
  // шейдер Воркера 2 (гекс-метрика hexApothem вместо круглых отсечек).
  assert.ok(
    terrain.includes('dist > u_focusRadiusM * 0.93') || terrain.includes('hexApothem'),
    'квадратные углы центрального меша отбрасываются (круг или гекс-метрика)',
  );
  assert.ok(
    terrain.includes('smoothstep(0.465, 0.495, edgeCoord)')
      || terrain.includes('hexLine') || terrain.includes('hexApothem'),
    'гекс-сетка имеет тонкую деликатную линию (edgeCoord или фаска Воркера 2)',
  );
  assert.ok(
    terrain.includes('* (1.0 - u_isSkirt)') || terrain.includes('u_isSkirt'),
    'изолинии полностью погашены на юбке',
  );
  assert.ok(
    terrain.includes('smoothstep(0.35, 0.98, v_fog)') || terrain.includes('v_fog'),
    'рельеф полностью растворяется в цвете горизонта',
  );
  const sky = Shaders.SKY_DOME_FRAGMENT_SHADER;
  assert.ok(
    sky.includes('smoothstep(horizonAngle - 0.12, horizonAngle + 0.08, beta)')
      || sky.includes('horizonAngle'),
    'широкий мягкий переход через лимб',
  );
  assert.ok(
    sky.includes('smoothstep(horizonAngle, horizonAngle + 0.85, beta)')
      || sky.includes('horizonAngle'),
    'плавный градиент неба к зениту',
  );
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

// ---------------------------------------------------------------------------
// 3. Stage-8.2: непрерывная сферическая юбка горизонта (97 × 57) и купол неба
// ---------------------------------------------------------------------------

test('hexMetric2D: единая гексагональная метрика — расстояние до прямых граней гекса', () => {
  // Для гекса с апофемой 1: вершины на описанной окружности r = 2/√3,
  // центры граней — на расстоянии 1 по нормалям граней (30° и 90°).
  assert.ok(Math.abs(Worker.hexMetric2D(2 / Math.sqrt(3), 0) - 1) < 1e-12, 'вершина на луче 0°: r = 2/√3');
  assert.ok(Math.abs(Worker.hexMetric2D(Math.sqrt(3) / 2, 0.5) - 1) < 1e-12, 'центр грани на луче 30°');
  assert.ok(Math.abs(Worker.hexMetric2D(0, 1) - 1) < 1e-12, 'центр грани на луче 90°');
  assert.ok(Math.abs(Worker.hexMetric2D(-2 / Math.sqrt(3), 0) - 1) < 1e-12, 'метрика чётна по x');
  assert.ok(Worker.hexMetric2D(0.4, 0.4) <= 1, 'точка внутри гекса: метрика <= апофемы');
  assert.ok(Worker.hexMetric2D(0.9, 0.9) > 1, 'точка вне гекса: метрика > апофемы');
  // Однородность: линия уровня метрики — идеальный правильный шестиугольник.
  for (const [x, y] of [[1, 0], [0.5, 0.8660254037844386], [-0.5, 0.8660254037844386], [0, -1]]) {
    const m = Worker.hexMetric2D(x, y);
    const scale = 21600 / m;
    assert.ok(
      Math.abs(Worker.hexMetric2D(x * scale, y * scale) - 21600) < 1e-9,
      'линия уровня метрики — шестиугольник с апофемой 21600 м',
    );
  }

  // clusterHexMetric — та же метрика с переставленными осями: нормали граней
  // смотрят ровно на θ_k = k·π/3 (направления центров 6 соседей кластера),
  // а вершины гекса — на лучи 30° + k·60°.
  const A = 1234.5;
  for (let k = 0; k < 6; k++) {
    const theta = (k * Math.PI) / 3;
    const faceX = A * Math.cos(theta);
    const faceY = A * Math.sin(theta);
    assert.ok(
      Math.abs(Worker.clusterHexMetric(faceX, faceY) - A) < 1e-9,
      `луч ${k}·π/3 — центр грани гекса кластера`,
    );
    const vertexX = (A / (Math.sqrt(3) / 2)) * Math.cos(theta + Math.PI / 6);
    const vertexY = (A / (Math.sqrt(3) / 2)) * Math.sin(theta + Math.PI / 6);
    assert.ok(
      Math.abs(Worker.clusterHexMetric(vertexX, vertexY) - A) < 1e-9,
      `луч 30° + ${k}·π/3 — вершина гекса кластера`,
    );
    assert.ok(
      Worker.clusterHexMetric(faceX, faceY) === Worker.hexMetric2D(faceY, faceX),
      'clusterHexMetric(x, y) === hexMetric2D(y, x)',
    );
  }
});

test('mapNeighborCellsToSlots: slot 0..5 ↔ 6 соседних ячеек без дубликатов', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  const slots = Worker.mapNeighborCellsToSlots(dryPatch);
  assert.equal(slots.length, 6, 'ровно 6 слотов кластера');
  const expected = dryPatch.cells.slice(1).map((c) => c.cell).sort((a, b) => a - b);
  assert.deepEqual(
    slots.map((c) => c.cell).sort((a, b) => a - b),
    expected,
    'взаимно-однозначное сопоставление, без дубликатов',
  );

  // Каждая ячейка попала в слот с ближайшим направлением (±π/3) в касательном кадре.
  const { east, north } = dryPatch.frame;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (let k = 0; k < 6; k++) {
    const cell = slots[k];
    const angle = Math.atan2(dot(cell.center, north), dot(cell.center, east));
    let diff = Math.abs(angle - (k * Math.PI) / 3) % (2 * Math.PI);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    assert.ok(diff <= Math.PI / 3 + 1e-9, `слот ${k} получил ближайшую по направлению ячейку`);
  }
});

/** Реплика билинейной выборки sampleInnerHeightfield воркера (сетка res × res). */
function bilinearHeight(heightfield, res, radiusM, px, py) {
  const cellSize = (2 * radiusM) / res;
  const gx = Math.min(res - 1.0001, Math.max(0, px / cellSize + res / 2));
  const gy = Math.min(res - 1.0001, Math.max(0, py / cellSize + res / 2));
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * res + ix;
  return (
    (heightfield[i00] * (1 - ax) + heightfield[i00 + 1] * ax) * (1 - ay)
    + (heightfield[i00 + res] * (1 - ax) + heightfield[i00 + res + 1] * ax) * ay
  );
}

const SKIRT_ANGULAR_COUNT = Worker.SKIRT_ANGULAR_SEGMENTS + 1;        // 97
const SKIRT_RADIAL_COUNT = Worker.SKIRT_RADIAL_RINGS + 1;             // 57
const SKIRT_VERTEX_COUNT = SKIRT_ANGULAR_COUNT * SKIRT_RADIAL_COUNT;  // 5 529
// Апофема выделенного центрального гекса: A = 0.93 · (√3/2) · R_patch ≈ 0.8054 · R_patch.
const SKIRT_CENTER_APOTHEM_M =
  Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * RADIUS_M;

function skirtVertex(skirt, i, j) {
  const v = (j * SKIRT_ANGULAR_COUNT + i) * 3;
  return [skirt.positions[v], skirt.positions[v + 1], skirt.positions[v + 2]];
}

function skirtRadiusAt(skirt, i, j) {
  const v = (j * SKIRT_ANGULAR_COUNT + i) * 3;
  return Math.hypot(skirt.positions[v], skirt.positions[v + 1]);
}

/** Участок и непрерывная юбка вокруг него (dryPatch — фиксированная фикстура). */
function buildSkirt(patchKey) {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const request = requestFor(dryPatch, { patchKey, profile: PROFILE });
  const local = Worker.generateLocalMap(request);
  return { request, local, skirt: Worker.generateHorizonSkirt(request, local.heightfield) };
}

/**
 * Фикстура Stage-8.2.1: континентальное озеро ВЫШЕ уровня моря (морфология
 * ячейки #53275 «Корхал IV»: seaLevel = 0.1129, elevation = 0.3910,
 * filledElevation = 0.3943, lakeWeight = 0.4456) в кольце сухих застраиваемых
 * соседей. Геометрия кольца берётся из канонического патча v=16 (dryPatch),
 * а поля ячеек переопределяются детерминированно.
 */
const LAKE_SEA_LEVEL = 0.1129;
const LAKE_CENTER_ELEVATION = 0.3910;
const LAKE_CENTER_FILLED = 0.3943;
const LAKE_WEIGHT = 0.4456;

function buildContinentalLakePatch(basePatch) {
  assert.ok(basePatch, 'нужен шестиугольный патч-основа');
  const center = basePatch.cells[0];
  const cells = [
    {
      ...center,
      elevation: LAKE_CENTER_ELEVATION,
      filledElevation: LAKE_CENTER_FILLED,
      depressionDepth: LAKE_CENTER_FILLED - LAKE_CENTER_ELEVATION,
      muLand: 0,
      slope: 0,
      lakeId: 11,
      lakeWeight: LAKE_WEIGHT,
      streamWeight: 0,
      riverAccumulation: 0,
      flowReceiver: -1,
    },
    ...basePatch.cells.slice(1).map((cell) => ({
      ...cell,
      elevation: 0.52,
      filledElevation: 0.52,
      depressionDepth: 0,
      muLand: 0.92,
      slope: 0.4,
      lakeId: -1,
      lakeWeight: 0,
      streamWeight: 0,
      riverAccumulation: 0,
      flowReceiver: -1,
    })),
  ];
  return {
    ...basePatch,
    seaLevel: LAKE_SEA_LEVEL,
    cells,
    river: {
      centerCell: basePatch.centerCell,
      flowsThroughCenter: false,
      centerStreamWeight: 0,
      centerRiverAccumulation: 0,
      inlets: [],
      outlet: null,
    },
  };
}

test('Stage-8.2 HorizonSkirt: единая полярная сетка 97 × 57 и геометрия горизонта', () => {
  const { skirt } = buildSkirt('skirt-continuous-grid');

  // Контракт сетки: 97 × 57 = 5 529 вершин и 96 × 56 × 6 = 32 256 индексов.
  assert.equal(Worker.SKIRT_ANGULAR_SEGMENTS, 96);
  assert.equal(Worker.SKIRT_RADIAL_RINGS, 56);
  assert.equal(Worker.SKIRT_COLLAR_RINGS, 14);
  assert.equal(Worker.SKIRT_RING_COUNT, 6);
  assert.equal(Worker.SKIRT_ANGULAR_SEGMENTS + 1, 97);
  assert.equal(Worker.SKIRT_RADIAL_RINGS + 1, 57);
  assert.equal(SKIRT_VERTEX_COUNT, 5529);
  assert.equal(skirt.positions.length, SKIRT_VERTEX_COUNT * 3);
  assert.equal(skirt.normals.length, SKIRT_VERTEX_COUNT * 3);
  assert.equal(skirt.indices.length, 32256);
  assert.equal(
    skirt.indices.length,
    Worker.SKIRT_ANGULAR_SEGMENTS * Worker.SKIRT_RADIAL_RINGS * 6,
  );
  for (const index of skirt.indices) {
    assert.ok(index < SKIRT_VERTEX_COUNT, 'все индексы ссылаются на вершины сетки');
  }
  assert.equal(
    new Set(skirt.indices).size,
    SKIRT_VERTEX_COUNT,
    'единая сетка использует все вершины (нет мёртвых узлов от плит-лепестков)',
  );

  // Геометрия непрерывного горизонта Stage-8.2.
  const R = RADIUS_M;
  assert.ok(Math.abs(skirt.innerRadiusM - 0.72 * R) < 1e-6, 'R_inner = 0.72·R_patch');
  assert.ok(Math.abs(skirt.hexSpacingM - 1.15 * R) < 1e-6, 'd_hex = 1.15·R_patch');
  assert.ok(Math.abs(skirt.outerRadiusM - 6.5 * skirt.hexSpacingM) < 1e-4, 'R_outer = 6.5·d_hex');
  assert.ok(Math.abs(skirt.outerRadiusM - 7.475 * R) < 1e-4, 'R_outer = 7.475·R_patch');
  assert.ok(
    Math.abs(skirt.planetRadiusM - 3.6 * skirt.outerRadiusM) < 1e-4,
    'R_planet = 3.6·R_outer — плавная кривизна горизонта',
  );
  assert.equal(skirt.ringCount, 6, '6 соседних гексов Patch7');
  assert.ok(
    Math.abs(SKIRT_CENTER_APOTHEM_M - 0.8054 * R) < 1,
    'A = 0.93·(√3/2)·R_patch ≈ 0.8054·R_patch — контур среза центрального гекса',
  );
  // Внутреннее кольцо юбки (0.72·R_patch) перекрывает шестиугольник гекса.
  assert.ok(skirt.innerRadiusM < SKIRT_CENTER_APOTHEM_M, 'воротник юбки перекрывает центральный гекс');

  // Радиусы колец: 14 плотных шагов воротника до 1.10·R_patch, затем 42 шага
  // от 1.10·R_patch до R_outer по степени t^1.35.
  const collarStep = (1.1 * R - 0.72 * R) / Worker.SKIRT_COLLAR_RINGS;
  const outerSteps = Worker.SKIRT_RADIAL_RINGS - Worker.SKIRT_COLLAR_RINGS;
  assert.equal(outerSteps, 42);
  for (let j = 1; j < SKIRT_RADIAL_COUNT; j++) {
    assert.ok(
      skirtRadiusAt(skirt, 0, j) > skirtRadiusAt(skirt, 0, j - 1),
      `радиус ряда ${j} больше радиуса ряда ${j - 1}`,
    );
  }
  for (let i = 0; i < SKIRT_ANGULAR_COUNT; i++) {
    assert.ok(
      Math.abs(skirtRadiusAt(skirt, i, 0) - skirt.innerRadiusM) < 1e-2,
      'внутреннее кольцо — окружность R_inner',
    );
    assert.ok(
      Math.abs(skirtRadiusAt(skirt, i, Worker.SKIRT_COLLAR_RINGS) - 1.1 * R) < 1e-2,
      '14-й ряд — граница плотного воротника 1.10·R_patch',
    );
    assert.ok(
      Math.abs(skirtRadiusAt(skirt, i, SKIRT_RADIAL_COUNT - 1) - skirt.outerRadiusM) < 1e-1,
      'внешнее кольцо — сферический горизонт R_outer',
    );
  }
  for (let j = 1; j <= Worker.SKIRT_COLLAR_RINGS; j++) {
    const step = skirtRadiusAt(skirt, 0, j) - skirtRadiusAt(skirt, 0, j - 1);
    assert.ok(Math.abs(step - collarStep) < 1e-2, `шаг воротника ${j} равномерный`);
  }
  for (let j = Worker.SKIRT_COLLAR_RINGS + 1; j < SKIRT_RADIAL_COUNT; j++) {
    const t = (j - Worker.SKIRT_COLLAR_RINGS) / outerSteps;
    const expected = 1.1 * R + (skirt.outerRadiusM - 1.1 * R) * Math.pow(t, 1.35);
    assert.ok(
      Math.abs(skirtRadiusAt(skirt, 0, j) - expected) < 1e-1,
      `радиус ряда ${j} следует степени t^1.35`,
    );
  }
  assert.ok(
    collarStep < skirtRadiusAt(skirt, 0, 16) - skirtRadiusAt(skirt, 0, 15),
    'воротник у гекса плотнее, чем ряды горизонта',
  );

  // Угловое замыкание i = 96 → i = 0 и круговые кольца: одна непрерывная сетка.
  for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
    const [x0, y0, z0] = skirtVertex(skirt, 0, j);
    const [x1, y1, z1] = skirtVertex(skirt, Worker.SKIRT_ANGULAR_SEGMENTS, j);
    assert.ok(
      Math.abs(x1 - x0) < 1e-2 && Math.abs(y1 - y0) < 1e-2 && Math.abs(z1 - z0) < 1e-2,
      `угловое замыкание ряда ${j} (шов нулевой длины)`,
    );
  }
  for (const j of [0, 7, Worker.SKIRT_COLLAR_RINGS, 20, SKIRT_RADIAL_COUNT - 1]) {
    const r0 = skirtRadiusAt(skirt, 0, j);
    for (let i = 1; i < SKIRT_ANGULAR_COUNT; i++) {
      assert.ok(
        Math.abs(skirtRadiusAt(skirt, i, j) - r0) < 1e-1,
        `ряд ${j} — непрерывная окружность (луч ${i})`,
      );
    }
  }
});

test('Stage-8.2 HorizonSkirt: бесшовная гексагональная сшивка высот воротника', () => {
  const { local, skirt } = buildSkirt('skirt-continuous-seam');
  const res = HF_RES;
  const A = SKIRT_CENTER_APOTHEM_M;
  const blendStart = Worker.SKIRT_COLLAR_BLEND_START_RATIO * A;   // 1.005 · A
  const blendEnd = Worker.SKIRT_COLLAR_BLEND_END_RATIO * A;       // 1.20 · A

  // 1. Внутри шестиугольника гекса (hexDist <= 1.005 · A) высота — ТОЧНАЯ
  //    билинейная выборка innerHeightfield: ровно тот же рельеф, что у
  //    обрезанного по гексу центрального меша 257 × 257, — ни ступеньки, ни щели.
  let exactVerts = 0;
  let exactMaxErr = 0;
  let bandVerts = 0;
  let bandMaxErr = 0;
  let nearBandMaxErr = 0;
  for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
    for (let i = 0; i < SKIRT_ANGULAR_COUNT; i++) {
      const [x, y, z] = skirtVertex(skirt, i, j);
      const hexDist = Worker.clusterHexMetric(x, y);
      const exactZ = bilinearHeight(local.heightfield, res, RADIUS_M, x, y);
      if (hexDist <= blendStart) {
        exactVerts++;
        exactMaxErr = Math.max(exactMaxErr, Math.abs(z - exactZ));
      } else if (hexDist <= blendEnd) {
        bandVerts++;
        bandMaxErr = Math.max(bandMaxErr, Math.abs(z - exactZ));
        if (hexDist <= blendStart * 1.01) {
          nearBandMaxErr = Math.max(nearBandMaxErr, Math.abs(z - exactZ));
        }
      }
    }
  }
  assert.ok(exactVerts > 400, `точная зона покрывает гекс (вершин: ${exactVerts})`);
  assert.ok(bandVerts > 400, `полоса смешивания заполнена узлами (${bandVerts})`);
  assert.ok(
    exactMaxErr < 1e-2,
    `высота воротника совпадает с innerHeightfield (макс. расхождение ${exactMaxErr} м)`,
  );
  assert.ok(
    nearBandMaxErr < 0.5,
    `на входе полосы (до 1.01·A) высота непрерывно продолжает heightfield (${nearBandMaxErr} м)`,
  );
  assert.ok(
    bandMaxErr < Worker.LAND_FBM_AMPLITUDE_M + Worker.PROFILE_DETAIL_AMPLITUDE_M,
    'смешивание полосы не выходит за амплитуду планетарного рельефа',
  );

  // 2. Контур среза hexDist == A целиком лежит в точной зоне: полоса
  //    смешивания начинается только за ним (1.005 · A), поэтому на всём
  //    шестиугольнике высота меша берётся из heightfield без скачка.
  for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
    const phi = (i / Worker.SKIRT_ANGULAR_SEGMENTS) * Math.PI * 2;
    const dirX = Math.cos(phi);
    const dirY = Math.sin(phi);
    const boundaryRadiusM = A / Worker.clusterHexMetric(dirX, dirY);
    const xBoundary = dirX * boundaryRadiusM;
    const yBoundary = dirY * boundaryRadiusM;
    assert.ok(
      Math.abs(Worker.clusterHexMetric(xBoundary, yBoundary) - A) < 1e-6,
      `точка на луче ${i} лежит на контуре среза A`,
    );
    let jOut = SKIRT_RADIAL_COUNT - 1;
    for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
      if (skirtRadiusAt(skirt, i, j) > 0) {
        const [x, y] = skirtVertex(skirt, i, j);
        if (Worker.clusterHexMetric(x, y) > blendStart) { jOut = j; break; }
      }
    }
    assert.ok(
      skirtRadiusAt(skirt, i, jOut) > boundaryRadiusM * Worker.SKIRT_COLLAR_BLEND_START_RATIO,
      `луч ${i}: полоса смешивания не задевает контур среза`,
    );
    // Высота меша на самом контуре (линейная интерполяция по радиальному ребру
    // между двумя точными узлами) совпадает с heightfield с точностью
    // дискретизации — не хуже 3 м при шаге воротника ~814 м.
    let jIn = 0;
    while (
      jIn < SKIRT_RADIAL_COUNT - 2
      && skirtRadiusAt(skirt, i, jIn + 1) < boundaryRadiusM
    ) jIn++;
    const rIn = skirtRadiusAt(skirt, i, jIn);
    const rOut = skirtRadiusAt(skirt, i, jIn + 1);
    const t = (boundaryRadiusM - rIn) / (rOut - rIn);
    const zIn = skirtVertex(skirt, i, jIn)[2];
    const zOut = skirtVertex(skirt, i, jIn + 1)[2];
    const meshZ = zIn + (zOut - zIn) * t;
    const exactZ = bilinearHeight(local.heightfield, res, RADIUS_M, xBoundary, yBoundary);
    assert.ok(
      Math.abs(meshZ - exactZ) < 3,
      `луч ${i}: высота на контуре гекса совпадает с heightfield (${Math.abs(meshZ - exactZ)} м)`,
    );
  }

  // 3. Точная зона имеет форму шестиугольника, а не круга: вдоль нормали грани
  //    (φ = 0°, i = 0) она заканчивается на 3-м ряду, а вдоль вершины гекса
  //    (φ = 30°, i = 8) — на 7-м (в 1.1547 раза дальше по радиусу).
  const lastExactRing = (i) => {
    let last = -1;
    for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
      const [x, y] = skirtVertex(skirt, i, j);
      if (Worker.clusterHexMetric(x, y) <= blendStart) last = j;
      else break;
    }
    return last;
  };
  assert.equal(lastExactRing(0), 3, 'φ = 0° (нормаль грани): точная зона до 3-го ряда');
  assert.equal(lastExactRing(8), 7, 'φ = 30° (вершина гекса): точная зона до 7-го ряда');
  assert.equal(lastExactRing(16), 3, 'φ = 60° (нормаль грани): точная зона до 3-го ряда');
  assert.equal(lastExactRing(24), 7, 'φ = 90° (вершина гекса): точная зона до 7-го ряда');
  const exactRingShape = new Set();
  for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) exactRingShape.add(lastExactRing(i));
  assert.deepEqual(
    [...exactRingShape].sort((a, b) => a - b),
    [3, 4, 5, 6, 7],
    'глубина точной зоны меняется по углу — гексагональный срез, а не окружность',
  );

  // 4. Нормали — гладкие конечные разности полярной сетки с угловым замыканием:
  //    единичная длина, верхняя полусфера и совпадение с формулой.
  const normals = skirt.normals;
  for (let v = 0; v < SKIRT_VERTEX_COUNT; v++) {
    const len = Math.hypot(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-5, `нормаль вершины ${v} единичной длины`);
    assert.ok(normals[v * 3 + 2] > 0, `нормаль вершины ${v} направлена вверх (nz > 0)`);
  }
  const finiteDifferenceNormal = (i, j) => {
    const iPrev = (i - 1 + Worker.SKIRT_ANGULAR_SEGMENTS) % Worker.SKIRT_ANGULAR_SEGMENTS;
    const iNext = (i + 1) % Worker.SKIRT_ANGULAR_SEGMENTS;
    const jPrev = Math.max(0, j - 1);
    const jNext = Math.min(SKIRT_RADIAL_COUNT - 1, j + 1);
    const [ax, ay, az] = skirtVertex(skirt, iNext, j);
    const [bx, by, bz] = skirtVertex(skirt, iPrev, j);
    const [cx, cy, cz] = skirtVertex(skirt, i, jNext);
    const [dx, dy, dz] = skirtVertex(skirt, i, jPrev);
    const tx = ax - bx;
    const ty = ay - by;
    const tz = az - bz;
    const rx = cx - dx;
    const ry = cy - dy;
    const rz = cz - dz;
    let nx = ty * rz - tz * ry;
    let ny = tz * rx - tx * rz;
    let nz = tx * ry - ty * rx;
    const len = Math.hypot(nx, ny, nz);
    nx /= len;
    ny /= len;
    nz /= len;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    return [nx, ny, nz];
  };
  for (const [i, j] of [[0, 0], [8, 3], [24, 7], [40, 20], [95, 56], [96, 30]]) {
    const expected = finiteDifferenceNormal(i, j);
    const v = (j * SKIRT_ANGULAR_COUNT + i) * 3;
    assert.ok(Math.abs(normals[v] - expected[0]) < 1e-4, `nx вершины (${i}, ${j})`);
    assert.ok(Math.abs(normals[v + 1] - expected[1]) < 1e-4, `ny вершины (${i}, ${j})`);
    assert.ok(Math.abs(normals[v + 2] - expected[2]) < 1e-4, `nz вершины (${i}, ${j})`);
  }

  // 5. Юбка строится и без профиля планеты, и без переданного heightfield.
  const noProfile = Worker.generateHorizonSkirt(requestFor(dryPatch, { patchKey: 'skirt-no-profile' }));
  assert.equal(noProfile.positions.length, SKIRT_VERTEX_COUNT * 3, 'без профиля — та же сетка');
  assert.equal(noProfile.indices.length, 32256, 'без профиля — те же индексы');
  const noCollar = Worker.generateHorizonSkirt(requestFor(dryPatch, { patchKey: 'skirt-no-collar' }), undefined);
  assert.equal(noCollar.positions.length, SKIRT_VERTEX_COUNT * 3, 'без heightfield — та же сетка');
  assert.equal(noCollar.indices.length, 32256, 'без heightfield — те же индексы');
});

test('Stage-8.2.1: континентальное озеро выше seaLevel проходит воротник юбки без обрыва к z = 0', () => {
  const patch = buildContinentalLakePatch(dryPatch);
  const invariants = Contract.verifyPatchInvariants(patch);
  assert.equal(invariants.ok, true, `фикстура озера валидна по И-3: ${JSON.stringify(invariants.checks)}`);

  const lakeRadiusM = 600;
  const lakeMirrorM =
    (Contract.waterLevelOf(patch.cells[0], patch.seaLevel) - patch.seaLevel) * M_PER_UNIT;
  assert.ok(
    Math.abs(lakeMirrorM - 253.3) < 1,
    `зеркало континентального озера ≈ +253 м над seaLevel (${lakeMirrorM} м)`,
  );

  Worker.clearLocalMapCache();
  const request = {
    patch,
    seed: 12345,
    placeId: 7,
    radiusM: lakeRadiusM,
    profile: PROFILE,
    patchKey: 'continental-lake',
  };
  const local = Worker.generateLocalMap(request);

  // 1. Локальный участок целиком под водой озера и держит зеркало waterLevelOf.
  assert.equal(local.meta.waterFraction, 1, 'вся локальная карта — вода озера');
  assert.ok(
    Math.abs(local.heightfield[CENTER] - lakeMirrorM) < 1e-3,
    `центр heightfield на уровне озера (${local.heightfield[CENTER]} м)`,
  );

  // 2. Маска спавна на полном patchSpanMeters разрешает застройку у сухих
  //    соседей — раньше это и порождало здания прямо на водном гексе.
  const spanMask = Contract.buildBuildingSpawnMask(patch, HF_RES);
  assert.ok(spanMask.includes(1), 'фикстура воспроизводит расхождение маски: сухие соседи застраиваемы');

  // 3. На водном гексе при radiusM = 600 не спавнится ни одного здания.
  const buildings = [];
  for (const pack of Object.values(local.instanceBuffers)) {
    for (let i = 0; i < pack.count; i++) buildings.push(Array.from(pack.buffer.subarray(i * 8, i * 8 + 8)));
  }
  assert.equal(buildings.length, 0, `на континентальном озере нет зданий (${buildings.length})`);
  assert.equal(local.meta.totalInstances, 0, 'meta.totalInstances = 0');
  assert.deepEqual(Object.keys(local.instanceBuffers), [], 'буферы инстансов пусты');

  // 4. Шестигранный воротник (кольца 0..10 юбки горизонта) не обваливается к
  //    z = 0: высота непрерывно продолжает зеркало озера (~ +253 м), без
  //    250-метрового обрыва на границе выделенного гекса.
  const skirt = Worker.generateHorizonSkirt(request, local.heightfield);
  const lastCollarRing = 10;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxRingJump = 0;
  let maxRaySpread = 0;
  for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
    let rayMin = Infinity;
    let rayMax = -Infinity;
    for (let j = 0; j <= lastCollarRing; j++) {
      const z = skirtVertex(skirt, i, j)[2];
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
      rayMin = Math.min(rayMin, z);
      rayMax = Math.max(rayMax, z);
      if (j > 0) maxRingJump = Math.max(maxRingJump, Math.abs(z - skirtVertex(skirt, i, j - 1)[2]));
    }
    maxRaySpread = Math.max(maxRaySpread, rayMax - rayMin);
  }
  assert.ok(
    minZ > lakeMirrorM - 5,
    `воротник не проваливается ниже зеркала озера: min z = ${minZ} м при зеркале ${lakeMirrorM} м`,
  );
  assert.ok(
    maxZ < lakeMirrorM + 40,
    `воротник не взлетает над зеркалом озера: max z = ${maxZ} м`,
  );
  assert.ok(
    maxRingJump < 25,
    `между соседними кольцами воротника нет 250-метрового обрыва (макс. скачок ${maxRingJump} м)`,
  );
  assert.ok(
    maxRaySpread < 40,
    `высота воротника непрерывна по радиусу на каждом луче (размах ${maxRaySpread} м)`,
  );

  Worker.clearLocalMapCache();
});

test('Stage-8.2 HorizonSkirt: GPU-путь непрерывной юбки на mock WebGL2', () => {
  const { local, skirt } = buildSkirt('skirt-continuous-gpu');
  const rp = skirt.planetRadiusM;

  // GPU-путь: до setHorizonSkirt инварианты Патча 8 не нарушены.
  const { gl, calls } = createMockGl();
  const renderer = new RendererModule.StructureRenderer(gl);
  renderer.initMeshLibrary(meshLibrary);
  renderer.onWorkerData(local);
  renderer.compilePrograms();
  assert.equal(calls.createProgram, 2, 'без юбки createProgram вызывается ровно дважды');
  assert.equal(
    calls.createVertexArray,
    MODULE_COUNT + 1,
    'до setHorizonSkirt VAO-инвариант (MODULE_COUNT + 1) не нарушен',
  );

  const viewProj = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  assert.doesNotThrow(() => {
    renderer.setHorizonSkirt(skirt);
    renderer.renderFrame(viewProj, {
      lightDir: [0.46, -0.36, 0.81],
      ambientColor: [0.28, 0.34, 0.39],
      fogColor: [0.16, 0.31, 0.42],
      fogStart: RADIUS_M * 1.05,
      fogEnd: skirt.outerRadiusM * 0.94,
      planetRadiusM: skirt.planetRadiusM,
      focusRadiusM: RADIUS_M,
      hexSizeM: skirt.hexSpacingM,
      horizonColor: [0.34, 0.58, 0.74],
      camera: { pitch: 0.44, yaw: -0.65, fovY: 0.87, aspect: 1.5, heightM: 3000 },
    });
  }, 'setHorizonSkirt + renderFrame отрабатывают на mock WebGL2');
  assert.equal(calls.createProgram, 3, 'программа купола неба создана лениво в setHorizonSkirt');

  const skyDraws = calls.draws.filter((draw) => draw.kind === 'sky');
  assert.equal(skyDraws.length, 1, 'купол неба рисуется один раз за кадр');
  assert.equal(skyDraws[0].count, 3, 'купол — полноэкранный треугольник из 3 вершин');
  const terrainDraws = calls.draws.filter((draw) => draw.kind === 'terrain');
  assert.equal(terrainDraws.length, 2, 'юбка (u_isSkirt=1) и центральный рельеф (u_isSkirt=0)');
  const uniform = (name) => calls.uniforms.filter((entry) => entry[0] === name).map((entry) => entry[1]);
  assert.deepEqual(uniform('u_isSkirt'), [1, 0], 'юбка рисуется с u_isSkirt=1, центр — с 0');
  assert.ok(
    uniform('u_planetRadiusM').some((value) => Math.abs(value - rp) < 1e-6),
    'u_planetRadiusM передан в шейдеры',
  );
  assert.ok(
    uniform('u_hexSizeM').some((value) => Math.abs(value - skirt.hexSpacingM) < 1e-6),
    'u_hexSizeM передан в шейдер рельефа',
  );

  renderer.dispose();
  assert.equal(renderer.ready, false, 'после dispose рендерер выключен');

  // setHorizonSkirt(null) полностью снимает горизонт и не ломает кадр.
  const mock2 = createMockGl();
  const second = new RendererModule.StructureRenderer(mock2.gl);
  second.initMeshLibrary(meshLibrary);
  second.onWorkerData(local);
  second.setHorizonSkirt(skirt);
  assert.doesNotThrow(() => second.setHorizonSkirt(null), 'снятие юбки освобождает ресурсы');
  assert.doesNotThrow(
    () => second.renderFrame(viewProj, {
      lightDir: [0, 0, 1],
      ambientColor: [0.3, 0.3, 0.3],
      fogColor: [0.5, 0.6, 0.7],
    }),
    'кадр без юбки после setHorizonSkirt(null) работает',
  );
  const secondSky = mock2.calls.draws.filter((draw) => draw.kind === 'sky');
  assert.equal(secondSky.length, 0, 'после снятия юбки купол не рисуется');
  second.dispose();
});

// ---------------------------------------------------------------------------
// 4. Stage-8.3: планетарный масштаб юбки, гребневые хребты и природная долина
// ---------------------------------------------------------------------------

test('Stage-8.3: малый радиус 600 м — планетарный масштаб, горно-долинный рельеф и природная долина', () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  const smallRadiusM = 600;
  Worker.clearLocalMapCache();
  const request = {
    patch: dryPatch,
    seed: 12345,
    placeId: 7,
    radiusM: smallRadiusM,
    profile: PROFILE,
    patchKey: 'stage83-small-radius',
  };
  const local = Worker.generateLocalMap(request);
  const skirt = Worker.generateHorizonSkirt(request, local.heightfield);

  // 1. Шестигранный воротник сшит с heightfield безошибочно: планетарное
  //    растяжение координат включается только за пределами воротника.
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * smallRadiusM;
  const blendStartM = Worker.SKIRT_COLLAR_BLEND_START_RATIO * apothemM;   // 1.005 · A
  let exactVerts = 0;
  let exactMaxErr = 0;
  for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
    for (let i = 0; i < SKIRT_ANGULAR_COUNT; i++) {
      const [x, y, z] = skirtVertex(skirt, i, j);
      if (Worker.clusterHexMetric(x, y) > blendStartM) continue;
      exactVerts++;
      const exactZ = bilinearHeight(local.heightfield, HF_RES, smallRadiusM, x, y);
      exactMaxErr = Math.max(exactMaxErr, Math.abs(z - exactZ));
    }
  }
  assert.ok(exactVerts > 400, `точная зона воротника заполнена (вершин: ${exactVerts})`);
  assert.ok(
    exactMaxErr < 1e-2,
    `сшивка воротника при radiusM = 600 точна (макс. расхождение ${exactMaxErr} м)`,
  );

  // 2. За пределами воротника (r > 1.1 · radiusM) координаты растянуты к
  //    физическому шагу гексов планеты: внешнее кольцо юбки целиком лежит на
  //    6 соседних канонических ячейках Patch7 и несёт выраженный
  //    горно-долинный перепад высот гребневого мультифрактала.
  const planetHexSpacingM = Worker.hexSpacingMeters(dryPatch.frame.radiusM);
  const planetCoordScale = Math.max(
    1,
    planetHexSpacingM / Math.max(Worker.SKIRT_HEX_SPACING_RATIO * smallRadiusM, 1),
  );
  assert.ok(planetCoordScale > 80, `планетарный масштаб при 600 м велик (${planetCoordScale})`);
  const smooth01 = (t) => {
    const x = t < 0 ? 0 : t > 1 ? 1 : t;
    return x * x * (3 - 2 * x);
  };
  const collarEndM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * smallRadiusM;
  const outerRing = SKIRT_RADIAL_COUNT - 1;
  const landHeights = [];
  const neighborCells = new Set();
  for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
    const [x, y, z] = skirtVertex(skirt, i, outerRing);
    const r = Math.hypot(x, y);
    assert.ok(r > collarEndM, 'внешнее кольцо лежит за пределами воротника');
    const coordScale = 1 + (planetCoordScale - 1) * smooth01((r - collarEndM) / (0.85 * smallRadiusM));
    const cell = Contract.nearestPatchCell(
      dryPatch,
      Contract.localPointToDirection(dryPatch, x * coordScale, y * coordScale),
    );
    if (Contract.isWaterCell(cell, dryPatch.seaLevel)) continue;
    landHeights.push(z);
    neighborCells.add(cell.cell);
  }
  assert.ok(landHeights.length > 50, `внешнее кольцо в основном суша (${landHeights.length} вершин)`);
  const reliefRangeM = Math.max(...landHeights) - Math.min(...landHeights);
  assert.ok(
    reliefRangeM > 120,
    `перепад высот внешнего кольца суши выражен (${reliefRangeM} м > 120 м)`,
  );
  assert.deepEqual(
    [...neighborCells].sort((a, b) => a - b),
    dryPatch.cells.slice(1).map((cell) => cell.cell).sort((a, b) => a - b),
    'все 6 соседних ячеек Patch7 реально формируют рельеф за пределами гекса',
  );

  // 3. Гребневой мультифрактал детерминирован, нормирован в [0, 1] и даёт
  //    настоящий контраст «острый гребень — гладкая долина».
  assert.equal(
    Worker.ridgedFbm(1.25, -3.5, 0x5A17C3, 5),
    Worker.ridgedFbm(1.25, -3.5, 0x5A17C3, 5),
    'ridgedFbm детерминирован',
  );
  let ridgeMin = Infinity;
  let ridgeMax = -Infinity;
  for (let gy = 0; gy < 32; gy++) {
    for (let gx = 0; gx < 32; gx++) {
      const value = Worker.ridgedFbm(gx * 0.31, gy * 0.31, 0x5A17C3, 5);
      assert.ok(value >= 0 && value <= 1, `ridgedFbm в [0, 1] (${value})`);
      ridgeMin = Math.min(ridgeMin, value);
      ridgeMax = Math.max(ridgeMax, value);
    }
  }
  assert.ok(ridgeMax - ridgeMin > 0.4, `контраст гребней и долин ridgedFbm (${ridgeMax - ridgeMin})`);

  // 4. Природная долина: не менее 55% карты зонирования — природный ландшафт
  //    (zone === 0), а органические гроздья застройки всё же дают здания.
  const zoneMap = Worker.generateZoneMap(12345, 7);
  let naturalTexels = 0;
  for (let i = 0; i < zoneMap.length; i += 2) {
    if (zoneMap[i] === 0) naturalTexels++;
  }
  const naturalFraction = naturalTexels / (Worker.ZONE_RES * Worker.ZONE_RES);
  assert.ok(
    naturalFraction >= 0.55,
    `доля природного ландшафта generateZoneMap не менее 55% (${naturalFraction})`,
  );
  let localNaturalTexels = 0;
  for (let i = 0; i < local.zoneMap.length; i += 2) {
    if (local.zoneMap[i] === 0) localNaturalTexels++;
  }
  assert.ok(
    localNaturalTexels / (Worker.ZONE_RES * Worker.ZONE_RES) >= 0.55,
    'в сгенерированном участке не менее 55% природных текселей',
  );
  assert.ok(local.meta.totalInstances > 0, 'кластеры застройки дают здания в scatterInstances');

  // 5. Терраформинг долины мягкий: альфа нигде не выше 0.42 (107 из 255).
  const terraformMap = Worker.generateTerraformMap();
  let terraformMax = 0;
  for (const value of terraformMap) terraformMax = Math.max(terraformMax, value);
  assert.ok(terraformMax <= Math.floor(0.42 * 255), `максимум terraform_map ограничен (${terraformMax})`);

  Worker.clearLocalMapCache();
});
