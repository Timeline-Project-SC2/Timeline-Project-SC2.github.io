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
      единую полярную сетку 145 × 85 (12 325 вершин, 32 256 индексов) без 6
      плит-лепестков, геометрию горизонта (R_inner = 0.72·R_patch,
      d_hex = 1.15·R_patch, R_outer = 10.0·d_hex = 11.5·R_patch,
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
      зонирования остаётся природным ландшафтом (zone === 0).
   6. Stage-8.5: `terraform_map` несёт явный водный маркер — `0` на воде,
      озере #53275 и континентальном зеркале, `>= 2` на любой суше во всех
      масштабах участка (10 км … 1250 км), значение `1` зарезервировано, а
      минимальная подложка суши не влияет на heightfield (нулевая альфа).
      Базовая высота суши интерполируется по Patch7 гладко (без прямых рёбер
      Вороного), поэтому перепад между соседними узлами сетки на масштабах
      156…1250 км не превышает 30 м при жёстком поле И-3.2.
   7. Stage-8.5: юбка горизонта без искусственного кругового вала — вокруг
      равнинного гекса простирается равнина (размах внешнего кольца меньше
      амплитуды fBm), на реально поднятых направлениях гребни вырастают, их
      амплитуда зависит от перепада высот Patch7, а не от radiusPatchM, и на
      кольцах юбки остаются широкие непрерывные равнинные сектора. Кривизна
      горизонта `planetRadiusM = max(frame.radiusM, 3.6·R_outer)` — от
      настоящего радиуса планеты, поэтому на малых масштабах проседание
      горизонта плавное (Δz < 1 км на 10 км).
   8. Stage-8.5.1: на прибрежном морском патче воротник центрального океана
      остаётся ровным на seaLevel, сухопутные соседи поднимаются грядами, а
      океанские направления держат отрицательную батиметрию без круглого вала.
   9. Stage-8.6: соседние суша ↔ океан синхронно продолжаются за воротником,
      а стрежень речного русла получает явный водный маркер terraform_map = 0
      и запрещает спавн даже выше seaLevel.
   10. Stage-8.7: кольца соседних областей вокруг активного гекса (ringCells,
      neighborRings 1..5): состав 6/12/18/24/30, ring-1 точны по 6 соседям Patch7,
      детерминированность, бюджет ringGenMs <= 20 мс и ring-буферы <= 512 КБ,
      waterMask по seaLevel, И-3.3 (neighborRings=0 — основной ответ побайтово
      совпадает), кэш с fingerprint(neighborRings) и глубокое клонирование. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Geometry = require('../src/local-map/local-map-geometry.ts');
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

test('И-3.2: высоты суши привязаны к filledElevation/seaLevel канонических ячеек', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'anchors' }));

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

test('И-3.2: океаническая/озёрная вода держит зеркало waterLevelOf и запрещает спавн', async () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  const res = await Worker.generateLocalMap(requestFor(waterPatch, { patchKey: 'water' }));

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

test('И-3.3: речное русло врезается от входных граней через центр к выходной', async () => {
  assert.ok(riverPatch, 'нужен речной центр с притоком и выходом');
  assert.ok(riverPatch.river.outlet, 'у речного центра есть выходная грань');
  assert.ok(riverPatch.river.inlets.length > 0, 'у речного центра есть входные грани');

  Worker.clearLocalMapCache();
  const strict = { spawnRule: STRICT_RULE };
  const withRiver = await Worker.generateLocalMap(requestFor(riverPatch, { ...strict, patchKey: 'river' }));
  // Двойник без русла: строгое правило спавна гасит терраформинг целиком,
  // поэтому карты отличаются ТОЛЬКО врезом русла.
  const twin = await Worker.generateLocalMap(requestFor(stripRiver(riverPatch), { ...strict, patchKey: 'river-twin' }));

  assert.equal(withRiver.meta.buildableFraction, 0, 'строгое правило запрещает спавн всюду');
  assert.equal(twin.meta.buildableFraction, 0, 'двойник тоже без спавна');

  const depth = Math.max(10, RADIUS_M * Worker.RIVER_DEPTH_RATIO * 1.8);
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

test('И-3.1: при переданном profile рельеф учитывает канал detail единого 3D-сэмплера', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  assert.equal(PROFILE.geographyVersion, 'c100-soft-v2');
  // Stage-8.10b (A-12b): createPatchFieldSampler ассинхронный (ленивый
  // динамический импорт ядра). «Без исключения» проверяется через await:
  // отклонение промиса проваливает тест.
  const samplerV2 = await Contract.createPatchFieldSampler(PROFILE);
  assert.equal(PROFILE.geographyVersion, 'c100-soft-v2', 'входной профиль не мутируется');
  await Contract.createPatchFieldSampler({ master_seed_hex: PROFILE.masterSeedHex, geography_version: 'c100-soft-v2' });
  const samplerV1 = await Contract.createPatchFieldSampler({ ...PROFILE, geographyVersion: 'c100-soft-v1' });
  const centerDir = dryPatch.cells[0].center;
  assert.deepEqual(
    samplerV2.sampleFields(centerDir[0], centerDir[1], centerDir[2]),
    samplerV1.sampleFields(centerDir[0], centerDir[1], centerDir[2]),
    'сэмплер по c100-soft-v2 побитово совпадает с базовым c100-soft-v1',
  );

  Worker.clearLocalMapCache();
  const plain = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'detail-plain' }));
  const detailed = await Worker.generateLocalMap(requestFor(dryPatch, {
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

test('И-3.4: инстансы стоят только в точках buildingSpawnMask === 1 и на рельефе', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'spawn' }));
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

test('meta Этапа 8: диагностика генерации заполнена, гейт G4 (genMs <= 150 мс) пройден', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const res = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'meta' }));
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

test('LRU-кэш участков: 8 записей, клонирование буферов, getCachedLocalMap/clearLocalMapCache', async () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  assert.equal(Worker.localMapCacheSize(), 0, 'кэш пуст после очистки');

  const first = await Worker.generateLocalMap(requestFor(waterPatch, { placeId: 0, patchKey: 'lru-0' }));
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
    await Worker.generateLocalMap(requestFor(waterPatch, { placeId: i, patchKey: `lru-${i}` }));
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

test('StructureRenderer: VAO рельефа и модулей создаются ровно один раз (Патч 8)', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-a' }));
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
    renderer.onWorkerData(await Worker.generateLocalMap(requestFor(dryPatch, {
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

test('StructureRenderer: порционная догрузка по бюджету и прогресс 0..1', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-b' }));
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

test('StructureRenderer: compilePrograms, renderFrame и dispose работают на mock WebGL2', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const payload = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'gpu-c' }));
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

test('шейдеры Этапа 8: тонирование водных низин, строгое начало #version 300 es и точность usampler2D', async () => {
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

test('localMapTransferables: все буферы ответа передаются zero-copy', async () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  Worker.clearLocalMapCache();
  const res = await Worker.generateLocalMap(requestFor(waterPatch, { patchKey: 'transfer' }));
  const transferables = Worker.localMapTransferables(res);
  assert.equal(transferables.length, 3, 'heightfield, zoneMap, terraformMap');
  assert.ok(transferables.includes(res.heightfield.buffer));
  assert.ok(transferables.includes(res.zoneMap.buffer));
  assert.ok(transferables.includes(res.terraformMap.buffer));
});

// ---------------------------------------------------------------------------
// 3. Stage-8.2: непрерывная сферическая юбка горизонта (145 × 85) и купол неба
// ---------------------------------------------------------------------------

test('hexMetric2D: единая гексагональная метрика — расстояние до прямых граней гекса', async () => {
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

test('mapNeighborCellsToSlots: slot 0..5 ↔ 6 соседних ячеек без дубликатов', async () => {
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

const SKIRT_ANGULAR_COUNT = Worker.SKIRT_ANGULAR_SEGMENTS + 1;        // 145
const SKIRT_RADIAL_COUNT = Worker.SKIRT_RADIAL_RINGS + 1;             // 85
const SKIRT_VERTEX_COUNT = SKIRT_ANGULAR_COUNT * SKIRT_RADIAL_COUNT;  // 12 325
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
async function buildSkirt(patchKey) {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const request = requestFor(dryPatch, { patchKey, profile: PROFILE });
  const local = await Worker.generateLocalMap(request);
  return { request, local, skirt: await Worker.generateHorizonSkirt(request, local.heightfield) };
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

test('Stage-8.2 HorizonSkirt: единая полярная сетка 145 × 85 и геометрия горизонта', async () => {
  const { skirt } = await buildSkirt('skirt-continuous-grid');

  // Контракт сетки: 145 × 85 = 12 325 вершин и 96 × 56 × 6 = 32 256 индексов.
  assert.equal(Worker.SKIRT_ANGULAR_SEGMENTS, 144);
  assert.equal(Worker.SKIRT_RADIAL_RINGS, 84);
  assert.equal(Worker.SKIRT_COLLAR_RINGS, 36);
  assert.equal(Worker.SKIRT_RING_COUNT, 6);
  assert.equal(Worker.SKIRT_ANGULAR_SEGMENTS + 1, 145);
  assert.equal(Worker.SKIRT_RADIAL_RINGS + 1, 85);
  assert.equal(SKIRT_VERTEX_COUNT, 12325);
  assert.equal(skirt.positions.length, SKIRT_VERTEX_COUNT * 3);
  assert.equal(skirt.normals.length, SKIRT_VERTEX_COUNT * 3);
  assert.equal(skirt.indices.length, 72576);
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
  assert.ok(Math.abs(skirt.outerRadiusM - 10.0 * skirt.hexSpacingM) < 1e-4, 'R_outer = 10.0·d_hex');
  assert.ok(Math.abs(skirt.outerRadiusM - 11.5 * R) < 1e-4, 'R_outer = 11.5·R_patch');
  assert.ok(
    Math.abs(
      skirt.planetRadiusM
      - Math.max(dryPatch.frame.radiusM || 0, 3.6 * skirt.outerRadiusM),
    ) < 1e-4,
    'R_planet = max(frame.radiusM, 3.6·R_outer) — кривизна от настоящего радиуса планеты',
  );
  assert.equal(skirt.ringCount, 6, '6 соседних гексов Patch7');
  assert.ok(
    Math.abs(SKIRT_CENTER_APOTHEM_M - 0.8054 * R) < 1,
    'A = 0.93·(√3/2)·R_patch ≈ 0.8054·R_patch — контур среза центрального гекса',
  );
  // Внутреннее кольцо юбки (0.72·R_patch) перекрывает шестиугольник гекса.
  assert.ok(skirt.innerRadiusM < SKIRT_CENTER_APOTHEM_M, 'воротник юбки перекрывает центральный гекс');

  // Радиусы колец: 36 плотных шагов воротника до 1.15·R_patch, затем 48 шагов
  // от 1.15·R_patch до R_outer по степени t^1.35.
  const collarStep = (1.15 * R - 0.72 * R) / Worker.SKIRT_COLLAR_RINGS;
  const outerSteps = Worker.SKIRT_RADIAL_RINGS - Worker.SKIRT_COLLAR_RINGS;
  assert.equal(outerSteps, 48);
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
      Math.abs(skirtRadiusAt(skirt, i, Worker.SKIRT_COLLAR_RINGS) - 1.15 * R) < 1e-2,
      '24-й ряд — граница плотного воротника 1.15·R_patch',
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
    const expected = 1.15 * R + (skirt.outerRadiusM - 1.15 * R) * Math.pow(t, 1.35);
    assert.ok(
      Math.abs(skirtRadiusAt(skirt, 0, j) - expected) < 1e-1,
      `радиус ряда ${j} следует степени t^1.35`,
    );
  }
  assert.ok(
    collarStep < skirtRadiusAt(skirt, 0, Worker.SKIRT_COLLAR_RINGS + 1) - skirtRadiusAt(skirt, 0, Worker.SKIRT_COLLAR_RINGS),
    'воротник у гекса плотнее, чем ряды горизонта',
  );

  // Угловое замыкание i = 144 → i = 0 и круговые кольца: одна непрерывная сетка.
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

test('Stage-8.2 HorizonSkirt: бесшовная гексагональная сшивка высот воротника', async () => {
  const { local, skirt } = await buildSkirt('skirt-continuous-seam');
  const res = HF_RES;
  const A = SKIRT_CENTER_APOTHEM_M;
  const blendStart = Worker.SKIRT_COLLAR_BLEND_START_RATIO * A;   // 1.005 · A
  const blendEnd = Worker.SKIRT_COLLAR_BLEND_END_RATIO * A;       // 1.35 · A

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
    bandMaxErr < Worker.METERS_PER_ELEVATION_UNIT,
    `полоса остаётся непрерывным планетарным склоном (${bandMaxErr} м)`,
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
  //    (φ = 0°) она короче, чем вдоль вершины гекса (φ = 30°).
  const lastExactRing = (i) => {
    let last = -1;
    for (let j = 0; j < SKIRT_RADIAL_COUNT; j++) {
      const [x, y] = skirtVertex(skirt, i, j);
      if (Worker.clusterHexMetric(x, y) <= blendStart) last = j;
      else break;
    }
    return last;
  };
  const sectorSteps = Worker.SKIRT_ANGULAR_SEGMENTS / 6;
  assert.ok(lastExactRing(sectorSteps / 2) > lastExactRing(0), 'точная зона глубже вдоль вершины');
  assert.equal(lastExactRing(sectorSteps), lastExactRing(0), 'секторная симметрия');
  const exactRingShape = new Set();
  for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) exactRingShape.add(lastExactRing(i));
  assert.ok(exactRingShape.size >= 4, 'точная зона имеет гексагональный, а не круглый срез');

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
  const noProfile = await Worker.generateHorizonSkirt(requestFor(dryPatch, { patchKey: 'skirt-no-profile' }));
  assert.equal(noProfile.positions.length, SKIRT_VERTEX_COUNT * 3, 'без профиля — та же сетка');
  assert.equal(noProfile.indices.length, 72576, 'без профиля — те же индексы');
  const noCollar = await Worker.generateHorizonSkirt(requestFor(dryPatch, { patchKey: 'skirt-no-collar' }), undefined);
  assert.equal(noCollar.positions.length, SKIRT_VERTEX_COUNT * 3, 'без heightfield — та же сетка');
  assert.equal(noCollar.indices.length, 72576, 'без heightfield — те же индексы');
});

test('Stage-8.2.1: континентальное озеро выше seaLevel проходит воротник юбки без обрыва к z = 0', async () => {
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
  const local = await Worker.generateLocalMap(request);

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
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
  const lastCollarRing = Worker.SKIRT_COLLAR_RINGS;
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

test('Stage-8.2 HorizonSkirt: GPU-путь непрерывной юбки на mock WebGL2', async () => {
  const { local, skirt } = await buildSkirt('skirt-continuous-gpu');
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
  // Stage-8.7: к каждому кольцу добавляется собственная LOD-область, поэтому
  // базовые два terrain-draw (юбка и центр) дополняются числом ringCells.
  const ringCells = local.ringCells ?? [];
  // Stage-8.7: в пределах одного кольца все 6·level ячеек смежны и лежат в
  // общем буфере, поэтому на кольцо приходится ровно один batch-draw.
  const ringBatches = new Set(ringCells.map((cell) => cell.ring)).size;
  assert.equal(
    terrainDraws.length,
    2 + ringBatches,
    'юбка, центральный рельеф и по одному batch-draw на каждое кольцо',
  );
  const uniform = (name) => calls.uniforms.filter((entry) => entry[0] === name).map((entry) => entry[1]);
  const isSkirtValues = uniform('u_isSkirt');
  // Stage-8.7: униформа ставится при смене программы, поэтому число её записей
  // не равно числу draw-вызовов. Проверяем состав, а не количество:
  // ровно один terrain-draw помечен как юбка (u_isSkirt=1).
  assert.equal(
    isSkirtValues.filter((value) => value === 1).length,
    1,
    'ровно один terrain-draw помечен как юбка',
  );
  assert.ok(isSkirtValues.includes(0), 'центральный рельеф и кольца рисуются с u_isSkirt=0');
  if (ringBatches > 0) {
    assert.deepEqual(
      uniform('u_ringLevel').filter((value) => value > 0),
      [5, 4, 3, 2, 1],
      'кольца рисуются от дальнего к ближнему: 5 → 4 → 3 → 2 → 1',
    );
  }
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

test('Stage-8.3: малый радиус 600 м — планетарный масштаб, горно-долинный рельеф и природная долина', async () => {
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
  const local = await Worker.generateLocalMap(request);
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);

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
    const coordScale = 1 + (planetCoordScale - 1) * smooth01((r - collarEndM) / (3.2 * smallRadiusM));
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


test('Stage-8.4: первые четыре кольца без радиальных и угловых ступенек Patch7', async () => {
  // Контрастные соседи выявляют скачок nearestPatchCell даже без макро-решётки.
  const patch = structuredClone(dryPatch);
  patch.cells.forEach((cell, i) => {
    cell.elevation = patch.seaLevel + 0.15 + (i % 2) * 0.25;
    cell.filledElevation = cell.elevation;
    cell.lakeWeight = 0;
  });
  const radiusM = 600;
  const skirt = await Worker.generateHorizonSkirt({
    patch, radiusM, seed: 12345, placeId: 7, patchKey: 'stage84-contrast',
  });
  const uniformPatch = structuredClone(patch);
  uniformPatch.cells.forEach((cell) => {
    cell.elevation = uniformPatch.seaLevel + 0.15;
    cell.filledElevation = cell.elevation;
  });
  const uniform = await Worker.generateHorizonSkirt({
    patch: uniformPatch, radiusM, seed: 12345, placeId: 7, patchKey: 'stage84-uniform',
  });
  // Вычитаем одинаковые fBm и горные гребни: проверяем именно якорь Patch7,
  // не запрещая естественные склоны детального рельефа.
  const anchorAt = (i, j) => skirtVertex(skirt, i, j)[2] - skirtVertex(uniform, i, j)[2];
  let maxRadialJump = 0;
  let maxAngularJump = 0;
  let checkedRings = 0;
  for (let j = 1; j < SKIRT_RADIAL_COUNT; j++) {
    const r = skirtRadiusAt(skirt, 0, j);
    if (r < 0.8 * radiusM || r > 4.5 * radiusM) continue;
    checkedRings++;
    for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
      const z = anchorAt(i, j);
      maxRadialJump = Math.max(maxRadialJump, Math.abs(z - anchorAt(i, j - 1)));
      maxAngularJump = Math.max(maxAngularJump, Math.abs(z - anchorAt(i + 1, j)));
    }
  }
  assert.ok(checkedRings >= 40, 'проверены воротник и переход до 4.5 R');
  assert.ok(maxRadialJump < 60, `нет радиальных ступенек: ${maxRadialJump} м`);
  assert.ok(maxAngularJump < 60, `нет угловых ступенек: ${maxAngularJump} м`);
});

// ---------------------------------------------------------------------------
// 6. Stage-8.5: явный водный маркер terraform_map — ложная вода исключена
// ---------------------------------------------------------------------------

test('Stage-8.5: terraform_map кодирует воду нулём, а сушу байтом >= 2 (нет ложной воды)', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  assert.ok(waterPatch, 'нужен полностью водный патч');
  assert.equal(Worker.TERRAFORM_LAND_MIN, 2, 'минимальная подложка суши — 2');
  assert.equal(Worker.TERRAFORM_ALPHA_SPAN, 253, 'знаменатель альфы терраформинга — 255 − 2');

  // 1. Базовый гауссов профиль: минимум 2 (нуль и единица зарезервированы под
  //    воду), максимум по-прежнему ограничен альфой 0.42 (Stage-8.3).
  const base = Worker.generateTerraformMap();
  let baseMin = Infinity;
  let baseMax = -Infinity;
  for (const value of base) {
    baseMin = Math.min(baseMin, value);
    baseMax = Math.max(baseMax, value);
  }
  assert.ok(baseMin >= Worker.TERRAFORM_LAND_MIN, `подложка суши generateTerraformMap >= 2 (${baseMin})`);
  assert.ok(baseMax <= Math.floor(0.42 * 255), `максимум terraform_map ограничен (${baseMax})`);

  // 2. Сухой патч: во всех масштабах участка (10 км … 1250 км) каждый тексель
  //    строго >= 2 — пологая суша больше не «тонет» в ложной воде.
  for (const scaleKm of [10, 60, 600, 1250]) {
    const radiusM = Math.max(600, (scaleKm * 1000) / 2);
    Worker.clearLocalMapCache();
    const dry = await Worker.generateLocalMap(
      requestFor(dryPatch, { radiusM, patchKey: `stage85-dry-${scaleKm}` }),
    );
    assert.equal(dry.terraformMap.length, Worker.TERRAFORM_RES * Worker.TERRAFORM_RES);
    let dryMin = Infinity;
    let reserved = 0;
    for (let i = 0; i < dry.terraformMap.length; i++) {
      const value = dry.terraformMap[i];
      dryMin = Math.min(dryMin, value);
      if (value === 1) reserved++;
    }
    assert.ok(
      dryMin >= Worker.TERRAFORM_LAND_MIN,
      `сухой патч ${scaleKm} км: нет нулей воды (min = ${dryMin})`,
    );
    assert.equal(reserved, 0, `сухой патч ${scaleKm} км: значение 1 зарезервировано и не встречается`);
    assert.equal(dry.meta.waterFraction, 0, `сухой патч ${scaleKm} км: вода не найдена`);
  }

  // 3. Полностью водный патч: каждый тексель — явный маркер воды 0.
  Worker.clearLocalMapCache();
  const water = await Worker.generateLocalMap(requestFor(waterPatch, { patchKey: 'stage85-water' }));
  assert.equal(water.meta.waterFraction, 1, 'водный патч целиком под водой');
  for (let i = 0; i < water.terraformMap.length; i++) {
    assert.equal(water.terraformMap[i], 0, `водный тексель ${i} terraform_map равен 0`);
  }

  // 4. Континентальное озеро выше seaLevel (морфология ячейки #53275
  //    «Корхал IV»): водное зеркало несёт маркер 0, а не «нулевую альфу суши».
  const lakePatch = buildContinentalLakePatch(dryPatch);
  Worker.clearLocalMapCache();
  const lake = await Worker.generateLocalMap({
    patch: lakePatch,
    seed: 12345,
    placeId: 7,
    radiusM: 600,
    profile: PROFILE,
    patchKey: 'stage85-lake-53275',
  });
  assert.equal(lake.meta.waterFraction, 1, 'локальный участок #53275 целиком под озером');
  for (let i = 0; i < lake.terraformMap.length; i++) {
    assert.equal(lake.terraformMap[i], 0, `тексель озера #53275 — маркер воды 0 (${lake.terraformMap[i]})`);
  }

  // 5. Смешанный участок того же озера на региональном масштабе: вода — 0,
  //    суша сухих соседей — >= 2, промежуточных значений нет.
  Worker.clearLocalMapCache();
  const lakeWideRadiusM = 625000;
  const lakeWide = await Worker.generateLocalMap({
    patch: lakePatch,
    seed: 12345,
    placeId: 7,
    radiusM: lakeWideRadiusM,
    patchKey: 'stage85-lake-wide',
  });
  const cellSize = (2 * lakeWideRadiusM) / HF_RES;
  let wetTexels = 0;
  let dryTexels = 0;
  let reservedWide = 0;
  for (let y = 0; y < HF_RES; y++) {
    for (let x = 0; x < HF_RES; x++) {
      const idx = y * HF_RES + x;
      const value = lakeWide.terraformMap[idx];
      if (value === 1) reservedWide++;
      const cell = Contract.nearestPatchCell(
        lakePatch,
        Contract.localPointToDirection(
          lakePatch,
          (x - HF_RES / 2) * cellSize,
          (y - HF_RES / 2) * cellSize,
        ),
      );
      if (Contract.isWaterCell(cell, lakePatch.seaLevel)) {
        wetTexels++;
        assert.equal(value, 0, `водный тексель озера #53275 равен 0 (${value})`);
      } else {
        dryTexels++;
        assert.ok(value >= Worker.TERRAFORM_LAND_MIN, `сухой тексель соседа >= 2 (${value})`);
      }
    }
  }
  assert.equal(reservedWide, 0, 'значение 1 не встречается и на смешанном участке');
  assert.ok(wetTexels > 0 && dryTexels > 0, `смешанный участок: вода ${wetTexels} / суша ${dryTexels}`);
  assert.ok(
    Math.abs(lakeWide.meta.waterFraction - wetTexels / (HF_RES * HF_RES)) < 1e-9,
    'meta.waterFraction совпадает с долей водных маркеров terraform_map',
  );

  // 6. Подложка 2 не влияет на рельеф: альфа терраформинга считается от
  //    TERRAFORM_LAND_MIN, поэтому в точках без терраформинга heightfield
  //    совпадает с природным даже при полностью разрешающей маске спавна.
  Worker.clearLocalMapCache();
  const strict = await Worker.generateLocalMap(
    requestFor(dryPatch, { spawnRule: STRICT_RULE, patchKey: 'stage85-alpha-strict' }),
  );
  Worker.clearLocalMapCache();
  const mixed = await Worker.generateLocalMap(requestFor(dryPatch, { patchKey: 'stage85-alpha-mixed' }));
  const cornerIdx = 3 * HF_RES + 3;   // гауссов профиль здесь уже на подложке 2
  assert.equal(mixed.terraformMap[cornerIdx], Worker.TERRAFORM_LAND_MIN, 'угловой тексель — подложка 2');
  assert.ok(
    Math.abs(strict.heightfield[cornerIdx] - mixed.heightfield[cornerIdx]) < 1e-9,
    'подложка 2 даёт нулевую альфу: рельеф без терраформинга не меняется',
  );
  const tfIdx = Math.floor(HF_RES / 2) * HF_RES + Math.floor(HF_RES / 2);
  assert.ok(
    mixed.terraformMap[tfIdx] > Worker.TERRAFORM_LAND_MIN,
    'в центре долины альфа терраформинга ненулевая',
  );
  assert.ok(
    Math.abs(strict.heightfield[tfIdx] - mixed.heightfield[tfIdx]) > 1e-6,
    'площадка терраформинга по-прежнему сглаживает рельеф в центре',
  );

  Worker.clearLocalMapCache();
});

test('Stage-8.5: юбка без кругового вала — гребни только на реально поднятых азимутах', async () => {
  // Фикстуры: геометрия канонического патча v=16 (dryPatch) сохраняется, а
  // высоты ячеек задаются детерминированно; русло снято, чтобы инварианты И-3
  // держались и рельеф юбки определялся только географией ячеек.
  const variantPatch = (levels) => {
    const patch = structuredClone(dryPatch);
    patch.cells.forEach((cell, index) => {
      cell.elevation = patch.seaLevel + levels[index % levels.length];
      cell.filledElevation = cell.elevation;
      cell.lakeWeight = 0;
      cell.streamWeight = 0;
      cell.depressionDepth = 0;
      cell.flowReceiver = -1;
    });
    patch.river = {
      centerCell: patch.river.centerCell,
      flowsThroughCenter: false,
      centerStreamWeight: 0,
      centerRiverAccumulation: 0,
      inlets: [],
      outlet: null,
    };
    return patch;
  };

  const outerRing = SKIRT_RADIAL_COUNT - 1;
  const ringOf = async (label, patch, radiusM, profile, ring) => {
    Worker.clearLocalMapCache();
    const request = {
      patch, radiusM, seed: 12345, placeId: 7, patchKey: label,
      ...(profile ? { profile } : {}),
    };
    const local = await Worker.generateLocalMap(request);
    const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
    const heights = [];
    for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) heights.push(skirtVertex(skirt, i, ring)[2]);
    return { skirt, heights, radiusM };
  };
  const rangeOf = (heights) => Math.max(...heights) - Math.min(...heights);
  /** Наибольший непрерывный сектор «равнины» (нижняя четверть размаха), градусы. */
  const plainSectorDeg = (heights) => {
    const min = Math.min(...heights);
    const range = rangeOf(heights);
    const total = heights.length;
    let run = 0;
    let best = 0;
    for (let i = 0; i < total + 40; i++) {
      if (heights[i % total] < min + 0.25 * range) {
        run++;
        best = Math.max(best, run);
      } else run = 0;
    }
    return (best * 360) / Worker.SKIRT_ANGULAR_SEGMENTS;
  };

  // 1. Вокруг равнинного низкого гекса — равнина: размах внешнего кольца юбки
  //    не превышает амплитуду fBm, значит замкнутого горного вала на 360° нет.
  const plainPatch = variantPatch([0.02]);
  assert.equal(
    Contract.verifyPatchInvariants(plainPatch).ok,
    true,
    `фикстура равнины валидна по И-3: ${JSON.stringify(Contract.verifyPatchInvariants(plainPatch).checks)}`,
  );
  const plainRange = rangeOf((await ringOf('stage85-skirt-plain', plainPatch, 600, null, outerRing)).heights);
  assert.ok(
    plainRange < Worker.LAND_FBM_AMPLITUDE_M,
    `вокруг равнинного гекса нет кругового вала: размах ${plainRange.toFixed(0)} м < ${Worker.LAND_FBM_AMPLITUDE_M} м (один fBm)`,
  );

  // 2. Та же геометрия, но реально поднятая и контрастная: гребни вырастают
  //    там, где возвышенность направления настоящая, а не «вокруг гекса».
  const upliftPatch = variantPatch([0.40, 0.55]);
  assert.equal(Contract.verifyPatchInvariants(upliftPatch).ok, true, 'фикстура поднятого рельефа валидна');
  const upliftRange = rangeOf((await ringOf('stage85-skirt-uplift', upliftPatch, 600, null, outerRing)).heights);
  assert.ok(
    upliftRange > plainRange + 80,
    `на поднятом направлении гребни растут: ${upliftRange.toFixed(0)} м против ${plainRange.toFixed(0)} м у равнины`,
  );

  // 3. peakAmpM больше не масштабируется визуальным radiusPatchM: одно и то же
  //    кольцо юбки одного патча даёт сопоставимый размах и на 600 м, и на 30 км.
  const smallRing = await ringOf('stage85-skirt-small', dryPatch, 600, PROFILE, outerRing);
  const bigRing = await ringOf('stage85-skirt-big', dryPatch, 30000, PROFILE, outerRing);
  const smallRange = rangeOf(smallRing.heights);
  const bigRange = rangeOf(bigRing.heights);
  assert.ok(
    Math.abs(smallRange - bigRange) < 0.25 * Math.max(smallRange, bigRange),
    `амплитуда гребней от реального перепада высот, а не от radiusPatchM: ${smallRange.toFixed(0)} м (600 м) против ${bigRange.toFixed(0)} м (30 км)`,
  );

  // 4. Направленный рельеф: на внешнем и среднем кольцах юбки есть широкие
  //    непрерывные равнинные сектора — гребни не замкнуты в кольцо на 360°.
  const smallPlainDeg = plainSectorDeg(smallRing.heights);
  assert.ok(
    smallPlainDeg >= 30,
    `на внешнем кольце есть открытый равнинный сектор ${smallPlainDeg.toFixed(0)}° >= 30°`,
  );
  const midRingIndex = 50;
  const midRing = await ringOf('stage85-skirt-mid', dryPatch, 600, PROFILE, midRingIndex);
  const midRadiusM = skirtRadiusAt(midRing.skirt, 0, midRingIndex);
  assert.ok(
    midRadiusM > 3 * 600 && midRadiusM < 4.5 * 600,
    `среднее кольцо юбки лежит в 3…4.5 R_patch (${midRadiusM.toFixed(0)} м)`,
  );
  const midPlainDeg = plainSectorDeg(midRing.heights);
  assert.ok(
    midPlainDeg >= 30,
    `на среднем кольце сохраняется широкий равнинный сектор: ${midPlainDeg.toFixed(0)}° >= 30°`,
  );

  // 5. Кривизна горизонта — от настоящего радиуса планеты: на малых и средних
  //    масштабах побеждает `patch.frame.radiusM`, на крупнейших остаётся
  //    нижняя граница 3.6·R_outer (иначе R_outer > R_planet и сферическое
  //    проседание в касательной плоскости вырождается).
  const skirtAt = async (label, radiusM) => {
    Worker.clearLocalMapCache();
    const request = requestFor(dryPatch, { radiusM, patchKey: label });
    const local = await Worker.generateLocalMap(request);
    return await Worker.generateHorizonSkirt(request, local.heightfield);
  };
  const microSkirt = await skirtAt('stage85-radius-micro', 5000);
  assert.ok(
    Math.abs(microSkirt.planetRadiusM - dryPatch.frame.radiusM) < 1e-6,
    `на масштабе 10 км R_planet = frame.radiusM (${microSkirt.planetRadiusM} м)`,
  );
  const microDropM = Worker.planetCurvatureDropM(microSkirt.planetRadiusM, microSkirt.outerRadiusM);
  assert.ok(
    microDropM < 1000,
    `кривизна настоящей планеты плавная: Δz на масштабе 10 км = ${(microDropM / 1000).toFixed(2)} км < 1 км`,
  );
  const wideSkirt = await skirtAt('stage85-radius-wide', 625000);
  assert.ok(
    Math.abs(wideSkirt.planetRadiusM - 3.6 * wideSkirt.outerRadiusM) < 1e-3,
    `на масштабе 1250 км действует нижняя граница 3.6·R_outer (${wideSkirt.planetRadiusM} м)`,
  );

  Worker.clearLocalMapCache();
});

test('Stage-8.5: базовая высота суши интерполируется по Patch7 гладко, без рёбер Вороного', async () => {
  const maxGridStep = (heightfield) => {
    let maxStep = 0;
    for (let y = 0; y < HF_RES; y++) {
      for (let x = 0; x < HF_RES - 1; x++) {
        maxStep = Math.max(maxStep, Math.abs(heightfield[y * HF_RES + x + 1] - heightfield[y * HF_RES + x]));
      }
    }
    for (let y = 0; y < HF_RES - 1; y++) {
      for (let x = 0; x < HF_RES; x++) {
        maxStep = Math.max(maxStep, Math.abs(heightfield[(y + 1) * HF_RES + x] - heightfield[y * HF_RES + x]));
      }
    }
    return maxStep;
  };

  // Масштабы приложения, на которых ступенчатый `nearestPatchCell` рисовал
  // прямые диагональные рёбра Вороного: 156 км (границы ячеек у края кадра),
  // 313 км и 625 км (до 6 соседей в кадре). 30 км — контроль: там участок
  // целиком внутри одной ячейки, рельеф обязан остаться прежним.
  for (const radiusM of [30000, 156000, 312500, 625000]) {
    for (const withProfile of [false, true]) {
      Worker.clearLocalMapCache();
      const local = await Worker.generateLocalMap(requestFor(dryPatch, {
        radiusM,
        patchKey: `stage85-smooth-${radiusM}-${withProfile ? 'p' : 'n'}`,
        ...(withProfile ? { profile: PROFILE } : {}),
      }));
      const maxStep = maxGridStep(local.heightfield);
      assert.ok(
        maxStep < 30,
        `radiusM=${radiusM} профиль=${withProfile ? 'да' : 'нет'}: нет ребра Вороного — максимальный перепад соседних узлов ${maxStep.toFixed(1)} м < 30 м`,
      );
      assert.ok(
        Number.isFinite(local.meta.genMs) && local.meta.genMs <= 150,
        `radiusM=${radiusM}: гейт G4 genMs=${local.meta.genMs.toFixed(1)} мс <= 150 мс`,
      );
    }
  }

  // Гладкость не куплена уплощением: на крупном масштабе реальный перепад
  // высот между ячейками Patch7 обязан оставаться в heightfield.
  Worker.clearLocalMapCache();
  const wide = await Worker.generateLocalMap(requestFor(dryPatch, {
    radiusM: 625000, patchKey: 'stage85-smooth-wide',
  }));
  const reliefM = wide.meta.maxHeightM - wide.meta.minHeightM;
  assert.ok(
    reliefM > 100,
    `на 1250 км перепад высот ячеек Patch7 сохранён: ${reliefM.toFixed(0)} м > 100 м`,
  );

  Worker.clearLocalMapCache();
});

// ---------------------------------------------------------------------------
// 8. Stage-8.5.1: живой прибрежный рельеф юбки над морским Patch7
// ---------------------------------------------------------------------------

/**
 * Прибрежная морская фикстура: центр и три соседа — океан с отрицательным
 * дном; остальные три соседа — суша +0.14…+0.28. Геометрия остаётся от
 * канонического Patch7, поэтому тестирует именно переход в юбке, а не
 * искусственную полярную сетку.
 */
function buildCoastalSeaPatch(basePatch) {
  assert.ok(basePatch, 'нужен морской Patch7-основание');
  const sea = basePatch.seaLevel;
  const landHeights = [0.14, 0.21, 0.28];
  const cells = basePatch.cells.map((cell, index) => {
    const isLand = index >= 4;
    const elevation = isLand
      ? sea + landHeights[index - 4]
      : sea - (0.18 + index * 0.025);
    return {
      ...cell,
      elevation,
      filledElevation: elevation,
      depressionDepth: 0,
      muLand: isLand ? 0.92 : 0,
      slope: isLand ? 0.18 : 0,
      lakeId: -1,
      lakeWeight: 0,
      streamWeight: 0,
      riverAccumulation: 0,
      flowReceiver: -1,
    };
  });
  return {
    ...basePatch,
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

/** Сухой центр с одним океанским соседом для обратной проверки шва. */
function buildCoastalLandPatch(basePatch) {
  assert.ok(basePatch, 'нужен Patch7-основание');
  const sea = basePatch.seaLevel;
  const cells = basePatch.cells.map((cell, index) => {
    const isOcean = index === 1;
    const elevation = isOcean ? sea - 0.23 : sea + 0.22 + (index % 3) * 0.03;
    return {
      ...cell,
      elevation,
      filledElevation: elevation,
      depressionDepth: 0,
      muLand: isOcean ? 0 : 0.92,
      slope: isOcean ? 0 : 0.18,
      lakeId: -1,
      lakeWeight: 0,
      streamWeight: 0,
      riverAccumulation: 0,
      flowReceiver: -1,
    };
  });
  return {
    ...basePatch,
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

/** Луч на центр заданного слота и соседние вершины юбки. */
function slotRayIndices(slot) {
  const center = slot * (Worker.SKIRT_ANGULAR_SEGMENTS / Worker.SKIRT_RING_COUNT);
  return [-3, -2, -1, 0, 1, 2, 3].map((offset) =>
    (center + offset + Worker.SKIRT_ANGULAR_SEGMENTS) % Worker.SKIRT_ANGULAR_SEGMENTS,
  );
}

test('Stage-8.5.1: морской патч — рельеф прибрежной суши юбки и ровное зеркало воротника', async () => {
  assert.ok(waterPatch, 'нужен полностью водный патч');
  const coastalSeaPatch = buildCoastalSeaPatch(waterPatch);
  assert.equal(Contract.verifyPatchInvariants(coastalSeaPatch).ok, true, 'прибрежная фикстура валидна по И-3');
  const radiusM = 600;
  Worker.clearLocalMapCache();
  const request = requestFor(coastalSeaPatch, { radiusM, patchKey: 'stage851-coastal-sea', profile: PROFILE });
  const local = await Worker.generateLocalMap(request);
  assert.equal(local.meta.waterFraction, 1, 'в малом активном гексе центр — океан');
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);

  // 1. Воротник центрального океана точно продолжает seaLevel независимо от
  // того, какой сосед начинает вступать в силу сразу за ним.
  let collarVertices = 0;
  for (let j = 0; j <= Worker.SKIRT_COLLAR_RINGS; j++) {
    for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
      const z = skirtVertex(skirt, i, j)[2];
      assert.ok(Math.abs(z) < 1e-6, `воротник (${i}, ${j}) держит z = 0, получено ${z}`);
      collarVertices++;
    }
  }
  assert.ok(collarVertices > 3000, `воротник проверен по всей окружности (${collarVertices})`);

  // 2. В сухих полусекторах — настоящая суша с грядами; подсчёт ведётся по
  // всей юбке, потому что три соседних гекса занимают примерно половину круга.
  let landVertices = 0;
  let maxLandZ = -Infinity;
  for (let j = Worker.SKIRT_COLLAR_RINGS + 1; j < SKIRT_RADIAL_COUNT; j++) {
    for (let i = 0; i < Worker.SKIRT_ANGULAR_SEGMENTS; i++) {
      const z = skirtVertex(skirt, i, j)[2];
      if (z > 1) landVertices++;
      maxLandZ = Math.max(maxLandZ, z);
    }
  }
  assert.ok(landVertices > 200, `сухие соседи дали более 200 вершин суши (${landVertices})`);
  assert.ok(maxLandZ > 100, `сухие соседи поднялись с грядами выше 100 м (${maxLandZ.toFixed(1)} м)`);

  // 3. Океанские полусектора не получают ложный положительный fBm-вал: на
  // лучах в центры океанских соседей дно всё время ниже seaLevel, с заметной
  // батиметрией уже в следующих кольцах.
  const slots = Worker.mapNeighborCellsToSlots(coastalSeaPatch);
  const oceanSlots = slots
    .map((cell, slot) => ({ cell, slot }))
    .filter(({ cell }) => cell.elevation < coastalSeaPatch.seaLevel && cell.lakeWeight === 0);
  const landSlots = slots
    .map((cell, slot) => ({ cell, slot }))
    .filter(({ cell }) => cell.elevation > coastalSeaPatch.seaLevel);
  assert.equal(oceanSlots.length, 3, 'три океанских соседа');
  assert.equal(landSlots.length, 3, 'три сухопутных соседа');
  let minOceanZ = Infinity;
  for (const { slot } of oceanSlots) {
    const i = slotRayIndices(slot)[3];
    for (let j = Worker.SKIRT_COLLAR_RINGS + 1; j < SKIRT_RADIAL_COUNT; j++) {
      const z = skirtVertex(skirt, i, j)[2];
      assert.ok(z <= 1e-4, `океанский слот ${slot}, кольцо ${j}: z <= 0 (${z.toFixed(2)})`);
      minOceanZ = Math.min(minOceanZ, z);
    }
  }
  assert.ok(minOceanZ < -5, `в океанских направлениях видна батиметрия (${minOceanZ.toFixed(1)} м)`);

  Worker.clearLocalMapCache();
});

// ---------------------------------------------------------------------------
// 9. Stage-8.6: синхронизация соседних ячеек и водный маркер русла
// ---------------------------------------------------------------------------

test('Stage-8.6: синхронизация соседних ячеек (суша ↔ океан) и водный маркер речного русла', async () => {
  assert.ok(waterPatch, 'нужен Patch7 для прибрежной пары');
  assert.ok(riverPatch, 'нужен Patch7 с руслом');
  const radiusM = 600;
  const coastalSeaPatch = buildCoastalSeaPatch(waterPatch);
  const coastalLandPatch = buildCoastalLandPatch(waterPatch);

  const build = async (patch, patchKey) => {
    Worker.clearLocalMapCache();
    const request = requestFor(patch, { radiusM, patchKey });
    const local = await Worker.generateLocalMap(request);
    return await Worker.generateHorizonSkirt(request, local.heightfield);
  };

  // С океанской ячейки луч в сторону сухого соседа поднимается настоящей
  // сушей, а с сухой ячейки луч к океану опускается ниже seaLevel.
  const seaSkirt = await build(coastalSeaPatch, 'stage86-ocean-to-land');
  const seaLandSlot = Worker.mapNeighborCellsToSlots(coastalSeaPatch)
    .findIndex((cell) => cell.elevation > coastalSeaPatch.seaLevel);
  assert.ok(seaLandSlot >= 0, 'у океанского центра есть сухопутный сосед');
  const seaToLandZ = skirtVertex(
    seaSkirt,
    slotRayIndices(seaLandSlot)[3],
    SKIRT_RADIAL_COUNT - 1,
  )[2];
  assert.ok(seaToLandZ > 15, `океан → суша поднимается выше 15 м (${seaToLandZ.toFixed(1)} м)`);

  const landSkirt = await build(coastalLandPatch, 'stage86-land-to-ocean');
  const landOceanSlot = Worker.mapNeighborCellsToSlots(coastalLandPatch)
    .findIndex((cell) => cell.elevation < coastalLandPatch.seaLevel && cell.lakeWeight === 0);
  assert.ok(landOceanSlot >= 0, 'у сухопутного центра есть океанский сосед');
  const landToSeaZ = skirtVertex(
    landSkirt,
    slotRayIndices(landOceanSlot)[3],
    SKIRT_RADIAL_COUNT - 1,
  )[2];
  assert.ok(landToSeaZ < -1, `суша → океан уходит под seaLevel (${landToSeaZ.toFixed(1)} м)`);

  // Водное стрежневое русло кодируется отдельным terraformMap == 1 (океан == 0),
  // а не только уменьшенной высотой. Реальный spawnMask потребляет этот же
  // запрет: ни один инстанс не может попасть в тексель стрежня.
  Worker.clearLocalMapCache();
  const river = await Worker.generateLocalMap(requestFor(riverPatch, { patchKey: 'stage86-river-marker' }));
  const waterCore = [];
  let raisedWaterCore = 0;
  for (let idx = 0; idx < river.terraformMap.length; idx++) {
    if (river.terraformMap[idx] !== 1) continue;
    waterCore.push(idx);
    if (river.heightfield[idx] > 0) raisedWaterCore++;
  }
  assert.ok(waterCore.length > 0, `русло содержит явные водные тексели (${waterCore.length})`);
  assert.ok(raisedWaterCore > 0, `река остаётся водой над z = 0 (${raisedWaterCore} текселей)`);
  const instances = [];
  for (const pack of Object.values(river.instanceBuffers)) {
    for (let i = 0; i < pack.count; i++) instances.push({ data: pack.buffer.subarray(i * 8, i * 8 + 8) });
  }
  for (const instance of instances) {
    const { index } = heightfieldIndexFor(instance, radiusM);
    assert.notEqual(river.terraformMap[index], 1, 'buildingSpawnMask запрещает инстанс в русле');
  }

  Worker.clearLocalMapCache();
});

// ---------------------------------------------------------------------------
// Stage-8.7: кольца соседних областей вокруг активного гекса (worker 1 из 5)
// ---------------------------------------------------------------------------

test('Stage-8.7: contract ringCells — состав, нет дубликатов, hfRes монотонно убывает', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  assert.equal(Worker.RING_LEVELS, 5);
  assert.equal(Worker.MAX_RING_CELLS, 91);
  // RING_HF_RES: [центр, 1..5], строго убывающее
  const res = Worker.RING_HF_RES;
  assert.equal(res.length, 6);
  for (let i = 1; i < res.length; i++) {
    assert.ok(res[i] < res[i - 1], `RING_HF_RES[${i}] < RING_HF_RES[${i - 1}]`);
  }
  Worker.clearLocalMapCache();
  const response = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-contract', profile: PROFILE, neighborRings: 5,
  }));
  assert.ok(response.ringCells, 'ringCells при neighborRings=5');
  assert.equal(response.ringCells.length, 90);
  assert.equal(response.meta.ringCellCount, 90);
  assert.ok(response.meta.ringGenMs >= 0 && response.meta.ringGenMs <= 20,
    `гейт ringGenMs: ${response.meta.ringGenMs.toFixed(2)} мс <= 20 мс`);
  // состав по кольцам: 6/12/18/24/30
  const counts = {};
  for (const cell of response.ringCells) counts[cell.ring] = (counts[cell.ring] || 0) + 1;
  assert.deepEqual(counts, { 1: 6, 2: 12, 3: 18, 4: 24, 5: 30 });
  // нет дубликатов cell, кольца в порядке возрастания, инварианты ячейки
  const seen = new Set();
  let lastRing = 0;
  for (const cell of response.ringCells) {
    assert.ok(!seen.has(cell.cell), `дубликат cell ${cell.cell}`);
    seen.add(cell.cell);
    assert.ok(cell.ring >= lastRing, 'кольца в порядке возрастания');
    lastRing = cell.ring;
    assert.ok(cell.ring >= 1 && cell.ring <= 5, `ring ${cell.ring} в [1, 5]`);
    assert.equal(cell.hfRes, res[cell.ring], `hfRes ring ${cell.ring}`);
    assert.equal(cell.heightfield.length, cell.hfRes * cell.hfRes);
    assert.equal(cell.waterMask.length, cell.hfRes * cell.hfRes);
    assert.ok(cell.minHeightM <= cell.maxHeightM, `границы высот ring ${cell.ring}`);
    const len = Math.hypot(cell.center[0], cell.center[1], cell.center[2]);
    assert.ok(Math.abs(len - 1) < 1e-6, `center единичная: ${len}`);
    assert.ok(Number.isFinite(cell.offsetM[0]) && Number.isFinite(cell.offsetM[1]), 'offsetM фините');
  }
  assert.equal(seen.size, 90);
});

test('Stage-8.7: ring-1 точность — центры и смещения совпадают с 6 соседями Patch7', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const response = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-ring1', profile: PROFILE, neighborRings: 1,
  }));
  assert.equal(response.ringCells.length, 6);
  for (const cell of response.ringCells) {
    // center совпадает с одним из patch.cells.slice(1).center
    let matched = false;
    for (let k = 1; k <= 6; k++) {
      const p = dryPatch.cells[k];
      const dot = cell.center[0] * p.center[0] + cell.center[1] * p.center[1] + cell.center[2] * p.center[2];
      if (dot > 1 - 1e-9) { matched = true; break; }
    }
    assert.ok(matched, 'ring-1 center совпадает с соседом Patch7');
    // A-17: канонический center остаётся физическим направлением семплирования,
    // а offsetM сжат к тому же видимому шагу, что использует юбка горизонта.
    const visibleSpacingM = Worker.SKIRT_HEX_SPACING_RATIO * RADIUS_M;
    const visibleOffsetM = Math.hypot(cell.offsetM[0], cell.offsetM[1]);
    assert.ok(
      Math.abs(visibleOffsetM - visibleSpacingM) < 1e-3,
      `видимый offsetM ${visibleOffsetM} совпадает с шагом юбки ${visibleSpacingM}`,
    );
  }
});

test('Stage-8.7: детерминированность — два вызова дают побайтово одинаковые ringCells', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const a = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-det-a', profile: PROFILE, neighborRings: 5,
  }));
  Worker.clearLocalMapCache();
  const b = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-det-b', profile: PROFILE, neighborRings: 5,
  }));
  assert.equal(a.ringCells.length, b.ringCells.length);
  for (let i = 0; i < a.ringCells.length; i++) {
    const ca = a.ringCells[i];
    const cb = b.ringCells[i];
    assert.equal(ca.cell, cb.cell);
    assert.equal(ca.ring, cb.ring);
    assert.equal(ca.hfRes, cb.hfRes);
    for (let j = 0; j < ca.heightfield.length; j++) assert.equal(ca.heightfield[j], cb.heightfield[j]);
    for (let j = 0; j < ca.waterMask.length; j++) assert.equal(ca.waterMask[j], cb.waterMask[j]);
  }
});

test('Stage-8.7: бюджет — ringGenMs <= 20 мс, ring-буферы <= 512 КБ', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const response = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-budget', profile: PROFILE, neighborRings: 5,
  }));
  assert.ok(response.meta.ringGenMs >= 0 && response.meta.ringGenMs <= 20,
    `гейт ringGenMs: ${response.meta.ringGenMs.toFixed(2)} мс <= 20 мс`);
  let bytes = 0;
  for (const cell of response.ringCells) {
    bytes += cell.heightfield.byteLength + cell.waterMask.byteLength;
  }
  assert.ok(bytes <= 512 * 1024, `ring-буферы: ${(bytes / 1024).toFixed(1)} КБ <= 512 КБ`);
});

test('Stage-8.7: waterMask — 1 там, где heightfield ниже seaLevel', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const response = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-water', profile: PROFILE, neighborRings: 5,
  }));
  for (const cell of response.ringCells) {
    for (let i = 0; i < cell.heightfield.length; i++) {
      const expected = cell.heightfield[i] < 0 ? 1 : 0;
      assert.equal(cell.waterMask[i], expected, `waterMask[${i}] ring ${cell.ring}`);
    }
  }
});

test('Stage-8.7: neighborRings=0 — основной ответ побайтово совпадает с ringCells=5 (И-3.3)', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const a = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-eq-a', profile: PROFILE, neighborRings: 0,
  }));
  Worker.clearLocalMapCache();
  const b = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-eq-b', profile: PROFILE, neighborRings: 5,
  }));
  assert.equal(a.ringCells, undefined, 'rings=0 не имеет ringCells');
  assert.equal(a.meta.ringCellCount, undefined);
  assert.equal(a.meta.ringGenMs, undefined);
  assert.equal(b.ringCells.length, 90);
  // основные буферы побайтово одинаковы
  for (let i = 0; i < a.heightfield.length; i++) assert.equal(a.heightfield[i], b.heightfield[i]);
  for (let i = 0; i < a.zoneMap.length; i++) assert.equal(a.zoneMap[i], b.zoneMap[i]);
  for (let i = 0; i < a.terraformMap.length; i++) assert.equal(a.terraformMap[i], b.terraformMap[i]);
  const aPacks = Object.values(a.instanceBuffers);
  const bPacks = Object.values(b.instanceBuffers);
  assert.equal(aPacks.length, bPacks.length);
  for (let p = 0; p < aPacks.length; p++) {
    assert.equal(aPacks[p].count, bPacks[p].count);
    for (let i = 0; i < aPacks[p].buffer.length; i++) assert.equal(aPacks[p].buffer[i], bPacks[p].buffer[i]);
  }
});

test('Stage-8.7: кэш и clone — fingerprint включает neighborRings, ringCells клонируются', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  // fingerprint включает neighborRings: rings=5 и rings=0 с тем же patchKey
  // не должны делить записи кэша.
  Worker.clearLocalMapCache();
  const withRings = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-cache', profile: PROFILE, neighborRings: 5,
  }));
  assert.ok(withRings.ringCells, 'rings=5 имеет ringCells');
  const withoutRings = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-cache', profile: PROFILE, neighborRings: 0,
  }));
  assert.equal(withoutRings.ringCells, undefined, 'rings=0 не читает ringCells из кэша rings=5');
  // cloneLocalMapResponse глубоко клонирует ringCells
  const clone = Worker.cloneLocalMapResponse(withRings);
  assert.equal(clone.ringCells.length, withRings.ringCells.length);
  const orig = withRings.ringCells[0];
  const cl = clone.ringCells[0];
  assert.notEqual(orig.heightfield.buffer, cl.heightfield.buffer, 'clone не делит буфер heightfield');
  orig.heightfield[0] = -9999;
  assert.notEqual(cl.heightfield[0], -9999, 'clone не зависит от оригинала');
  orig.waterMask[0] = 5;
  assert.notEqual(cl.waterMask[0], 5, 'clone waterMask не зависит от оригинала');
  // transferables содержат ring-буферы
  const transferables = Worker.localMapTransferables(withRings);
  const baseCount = 3 + Object.values(withRings.instanceBuffers).filter(Boolean).length;
  assert.equal(transferables.length, baseCount + 2 * withRings.ringCells.length,
    'transferables включают 2 буфера на каждую ячейку кольца');
});

test('Stage-8.7: без профиля ringCells отсутствуют (нет 3D-сэмпера)', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const response = await Worker.generateLocalMap(requestFor(dryPatch, {
    patchKey: 'stage87-noprofile', neighborRings: 5,
  }));
  assert.equal(response.ringCells, undefined);
  assert.equal(response.meta.ringCellCount, undefined);
  assert.equal(response.meta.ringGenMs, undefined);
});

/* ---------------------------------------------------------------
   Stage-8.10b (A-12b): разрыв цепочки локальной карты
   -------------------------------------------------------------
   Ядро (planet-core / planet-geography) больше не статически
   импортируется главным потоком страницы: генерация грузится
   ленивым чанком через динамический import(). Побайтовая
   эквивалентность generateLocalMap / generateHorizonSkirt — через
   golden-хэш фиксированного профиля и ячейки (проверено против
   сборки до правки A-12b, machine-noise исключена: genMs/ringGenMs).
   --------------------------------------------------------------- */

/** Детерминированный SHA-256 по всем буферам ответа и юбке (без timing). */
function goldenDigestOf(local, skirt) {
  const hash = createHash('sha256');
  const writeBytes = (label, view) => {
    hash.update(label);
    hash.update(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
  };
  const writeJson = (label, value) => {
    hash.update(label);
    hash.update(JSON.stringify(value));
  };
  writeBytes('heightfield', local.heightfield);
  writeBytes('zoneMap', local.zoneMap);
  writeBytes('terraformMap', local.terraformMap);
  for (const key of Object.keys(local.instanceBuffers).sort()) {
    const pack = local.instanceBuffers[key];
    if (!pack) continue;
    writeBytes('instance:' + key, pack.buffer);
    writeJson('instance-count:' + key, pack.count);
  }
  if (local.ringCells) {
    for (const cell of local.ringCells) {
      writeJson('ring-meta', [cell.cell, cell.ring, cell.center, cell.offsetM, cell.hfRes, cell.minHeightM, cell.maxHeightM]);
      writeBytes('ring-hf:' + cell.cell, cell.heightfield);
      writeBytes('ring-water:' + cell.cell, cell.waterMask);
    }
  }
  const meta = { ...local.meta };
  delete meta.genMs;
  delete meta.ringGenMs;
  writeJson('meta', meta);
  writeBytes('skirt-positions', skirt.positions);
  writeBytes('skirt-normals', skirt.normals);
  writeBytes('skirt-water', skirt.waterMask);
  writeBytes('skirt-river', skirt.riverMask);
  writeBytes('skirt-indices', skirt.indices);
  writeJson('skirt-scalars', [
    skirt.innerRadiusM, skirt.outerRadiusM, skirt.planetRadiusM, skirt.hexSpacingM, skirt.ringCount,
  ]);
  return hash.digest('hex');
}

test('Stage-8.10b: generateLocalMap + generateHorizonSkirt побайтово совпадают с golden-хэшем (фиксированный профиль и ячейка)', async () => {
  assert.ok(dryPatch, 'нужен сухой пологий центр');
  Worker.clearLocalMapCache();
  const request = requestFor(dryPatch, {
    patchKey: 'golden-eq',
    profile: PROFILE,
    neighborRings: 2,
  });
  const local = await Worker.generateLocalMap(request);
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
  assert.equal(
    goldenDigestOf(local, skirt),
    '36f8a81d5e3c11356d281a874e6684e18f91e619dabad6989bcb9b91f836cbe1',
    'генерация локальной карты побайтово фиксирует согласованный стык A-17',
  );
});

test('Stage-8.10b: ленивый чанк выставляет API глобуса и генерирует golden-ответ', async () => {
  await import('../site/planet-globe/local-map-worker-lazy.ts');
  const loaded = globalThis.LocalMapWorkerLazyModule;
  assert.ok(loaded, 'чанк обязан выставить globalThis.LocalMapWorkerLazyModule');
  assert.equal(typeof loaded?.generateLocalMap, 'function');
  assert.equal(typeof loaded?.generateHorizonSkirt, 'function');
  Worker.clearLocalMapCache();
  const request = requestFor(dryPatch, {
    patchKey: 'golden-eq',
    profile: PROFILE,
    neighborRings: 2,
  });
  const local = await loaded.generateLocalMap(request);
  const skirt = await loaded.generateHorizonSkirt(request, local.heightfield);
  assert.equal(
    goldenDigestOf(local, skirt),
    '36f8a81d5e3c11356d281a874e6684e18f91e619dabad6989bcb9b91f836cbe1',
    'генерация через ленивый чанк побайтово совпадает с golden-хэшем A-17',
  );
});

test('Stage-8.10b: загрузчик страницы кэширует промис модуля — динамический import() ровно один', () => {
  const page = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  // Кэш-переменная модуля: повторный Dive-in не вызывает новый import().
  assert.match(
    page,
    /let localMapWorkerModulePromise: Promise<LocalMapWorkerLazyModule> \| null = null;/,
    'загрузчик хранит промис модуля в переменной модуля',
  );
  assert.match(
    page,
    /localMapWorkerModulePromise \?\?= import\('\.\/local-map-worker-lazy\.js'\)/,
    'промис кэшируется через ??= — импорт выполняется ровно один раз',
  );
  // Счётчик вызовов динамического import: ровно одна статическая запись.
  const dynamicImports = page.match(/import\('\.\/local-map-worker-lazy\.js'\)/g) ?? [];
  assert.equal(dynamicImports.length, 1, 'динамический import() чанка встречается ровно один раз');
  // Точка :1917 стала асинхронной и ждёт загрузчик; guard после каждого await.
  assert.match(page, /async function renderLocalMapFromPatch/);
  assert.match(page, /localMapWorker = await loadLocalMapWorkerModule\(\)/);
  const guardsAfterAwait = page.match(/if \(requestId !== localMapEntrySeq\) return;/g) ?? [];
  assert.ok(guardsAfterAwait.length >= 3, 'guard по localMapEntrySeq стоит после каждого await');
  // Ошибка загрузки чанка сообщается через setLocalMapStatus.
  assert.match(page, /setLocalMapStatus\(\s*'Не удалось загрузить модуль локальной карты: '/);
  // Чистые хелперы — из local-map-geometry.ts, а не через модуль генерации.
  assert.match(
    page,
    /import \{[\s\S]*mapNeighborCellsToSlots,[\s\S]*neighborTerrainKind,[\s\S]*planetCurvatureDropM,[\s\S]*\} from '\.\.\/\.\.\/src\/local-map\/local-map-geometry\.ts';/,
  );
  // В странице не осталось value-import из local-map-worker.ts (только типы).
  const workerImportBlocks = page.match(/import [^;]*from '[^']*local-map-worker\.ts';/g) ?? [];
  assert.ok(workerImportBlocks.length > 0, 'страница импортирует типы wire-протокола из local-map-worker.ts');
  for (const block of workerImportBlocks) {
    assert.ok(
      /^import type /.test(block.trim()),
      `страница не должна value-импортировать local-map-worker.ts: ${block.trim()}`,
    );
  }
});

// ---------------------------------------------------------------------------
// A-17 / Stage-8.12: повторяемая диагностика пяти переходов владельца.
// Это намеренно числовой тест, а не снимок лога: при каждом запуске он заново
// строит каноническую v=128 поверхность seed=korhal-iv и печатает измерения.
// ---------------------------------------------------------------------------

const A17_CELLS = [43533, 43534, 43535, 43536, 43537];
const A17_RADIUS_M = 2500;
const A17_PROFILE = {
  seedText: 'korhal-iv',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  presetId: 'earthlike_balanced',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 400,
  continentVariation: 0.8,
  oceanBasinMeanCells: 6000,
  drainageMeanCells: 72,
  oceanPctl: 70,
  shelfBelowPctl: 67,
  shelfAbovePctl: 73,
  highlandLandPctl: 75,
  mountainLandPctl: 92,
  aridLandPctl: 25,
  wetLandPctl: 75,
  coldPctl: 20,
  hotPctl: 80,
  streamFlowPctl: 90,
  majorRiverFlowPctl: 99,
  coastSoftWidthCells: 3,
  continentSoftWidthCells: 4,
  biomeSoftWidthCells: 2,
  transitionEntropyPctl: 90,
};

function a17SkirtHeightAt(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let previousRadius = 0;
  let previousZ = 0;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const index = (j * angularCount + angularIndex) * 3;
    const radius = Math.hypot(skirt.positions[index], skirt.positions[index + 1]);
    const z = skirt.positions[index + 2];
    if (j > 0 && radius >= radiusM) {
      const t = (radiusM - previousRadius) / (radius - previousRadius);
      return previousZ + (z - previousZ) * t;
    }
    previousRadius = radius;
    previousZ = z;
  }
  return previousZ;
}

function a17BoundaryDiagnostics(local, skirt) {
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * A17_RADIUS_M;
  const azimuths = [];
  let waterSideMismatches = 0;
  let maximum = { azimuthDeg: 0, stepM: 0 };
  for (let angularIndex = 0; angularIndex < Worker.SKIRT_ANGULAR_SEGMENTS; angularIndex += 18) {
    const phi = angularIndex / Worker.SKIRT_ANGULAR_SEGMENTS * Math.PI * 2;
    const boundaryRadiusM = apothemM
      / Worker.clusterHexMetric(Math.cos(phi), Math.sin(phi));
    const x = Math.cos(phi) * boundaryRadiusM;
    const y = Math.sin(phi) * boundaryRadiusM;
    const patchZ = bilinearHeight(local.heightfield, HF_RES, A17_RADIUS_M, x, y);
    const skirtZ = a17SkirtHeightAt(skirt, angularIndex, boundaryRadiusM);
    if ((patchZ <= 0) !== (skirtZ <= 0)) waterSideMismatches++;
    const stepM = Math.abs(skirtZ - patchZ);
    const row = { azimuthDeg: angularIndex * 2.5, stepM: Number(stepM.toFixed(3)) };
    azimuths.push(row);
    if (stepM > maximum.stepM) maximum = row;
  }
  return {
    azimuths,
    maximum,
    // Измерительный шаг поиска берега — 25 м; при совпадении стороны воды на
    // всех восьми створах фактический разрыв на самом стыке равен нулю.
    shoreBreakM: waterSideMismatches === 0 ? 0 : 25,
  };
}

function a17NearestShore(skirt) {
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * A17_RADIUS_M;
  let nearest = null;
  for (let angularIndex = 0; angularIndex < Worker.SKIRT_ANGULAR_SEGMENTS; angularIndex++) {
    const phi = angularIndex / Worker.SKIRT_ANGULAR_SEGMENTS * Math.PI * 2;
    const boundaryRadiusM = apothemM
      / Worker.clusterHexMetric(Math.cos(phi), Math.sin(phi));
    let previousRadius = boundaryRadiusM;
    let previousZ = a17SkirtHeightAt(skirt, angularIndex, previousRadius);
    for (let radiusM = boundaryRadiusM + 25; radiusM <= skirt.outerRadiusM; radiusM += 25) {
      const z = a17SkirtHeightAt(skirt, angularIndex, radiusM);
      if ((previousZ > 0) !== (z > 0)) {
        const denominator = Math.abs(previousZ) + Math.abs(z);
        const crossingM = denominator > 0
          ? previousRadius + (radiusM - previousRadius) * Math.abs(previousZ) / denominator
          : radiusM;
        const gapM = crossingM - boundaryRadiusM;
        if (!nearest || gapM < nearest.gapM) {
          nearest = {
            azimuthDeg: Number((angularIndex * 2.5).toFixed(1)),
            gapM: Number(gapM.toFixed(1)),
            direction: z <= 0 ? 'к воде' : 'к суше',
          };
        }
        break;
      }
      previousRadius = radiusM;
      previousZ = z;
    }
  }
  return nearest ?? { azimuthDeg: null, gapM: null, direction: 'берег не найден' };
}

test('A-17 diagnostic: числа стыка и берега для #43533…#43537', async () => {
  const canonicalGrid = GeodesicGrid.build(128);
  const canonicalSurface = PlanetSurface.generateSurface(canonicalGrid, A17_PROFILE);
  const planetSpacingM = Worker.hexSpacingMeters(A17_PROFILE.radiusKm * 1000);
  const visualSpacingM = Worker.SKIRT_HEX_SPACING_RATIO * A17_RADIUS_M;
  const coordinateScale = planetSpacingM / visualSpacingM;
  const rows = [];

  for (const cellIndex of A17_CELLS) {
    const patch = Contract.buildPatch7(canonicalGrid, canonicalSurface, cellIndex);
    const request = {
      patch,
      seed: 0x4f9f2cab,
      placeId: 2,
      radiusM: A17_RADIUS_M,
      profile: A17_PROFILE,
      patchKey: `a17-diagnostic-${cellIndex}`,
    };
    Worker.clearLocalMapCache();
    const local = await Worker.generateLocalMap(request);
    const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
    const center = patch.cells[0];
    const boundary = a17BoundaryDiagnostics(local, skirt);
    const shore = a17NearestShore(skirt);
    rows.push({
      cell: cellIndex,
      elevation: Number(center.elevation.toFixed(6)),
      muLand: Number(center.muLand.toFixed(6)),
      streamWeight: Number(center.streamWeight.toFixed(6)),
      lakeWeight: Number(center.lakeWeight.toFixed(6)),
      seaLevel: Number(patch.seaLevel.toFixed(6)),
      waterFraction: Number(local.meta.waterFraction.toFixed(6)),
      boundaryAzimuthsM: boundary.azimuths.map((item) => item.stepM).join('/'),
      maxBoundaryStepM: boundary.maximum.stepM,
      maxAtDeg: boundary.maximum.azimuthDeg,
      shoreBreakM: boundary.shoreBreakM,
      shoreGapM: shore.gapM,
      shoreAtDeg: shore.azimuthDeg,
      shoreDirection: shore.direction,
      neighborLabels: patch.cells.slice(1)
        .map((cell) => Geometry.neighborTerrainKind(cell, patch.seaLevel)).join('/'),
    });
  }

  console.log(`A17_DIAG seed=${canonicalSurface.profile.masterSeedHex}`);
  console.table(rows);
  console.log('A17_HYPOTHESES', {
    a: `CONFIRMED coordinateScale=${coordinateScale.toFixed(3)}x (planet=${planetSpacingM.toFixed(1)}m, visual=${visualSpacingM.toFixed(1)}m)`,
    b: `REJECTED wholeWaterCells=${rows.filter((row) => row.waterFraction === 1).length}/5`,
    c: `REJECTED waterPlanes=0, fragmentAlpha=${Shaders.TERRAIN_FRAGMENT_SHADER.includes('fragColor = vec4(finalColor, 1.0)') ? '1.0' : 'not-opaque'}`,
  });

  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.boundaryAzimuthsM.split('/').length === 8));
  assert.ok(coordinateScale > 20, `растяжение координат измерено (${coordinateScale})`);
  assert.equal(rows.filter((row) => row.waterFraction === 1).length, 0);
  assert.ok(rows.every((row) => row.maxBoundaryStepM <= 1), 'после починки уступ не больше 1 м');
  assert.ok(rows.every((row) => row.shoreBreakM === 0), 'разрыв вода/суша на стыке равен 0 м');
  assert.ok(rows.every((row) => row.shoreGapM !== null), 'для каждой ячейки найден макро-берег');
  assert.ok(
    rows.some((row) => new Set(row.neighborLabels.split('/')).size > 1),
    'подписи соседей различают значимую реку и основной ландшафт',
  );
  assert.match(Shaders.TERRAIN_FRAGMENT_SHADER, /fragColor = vec4\(finalColor, 1\.0\)/);
});

// ---------------------------------------------------------------------------
// A-17b / Stage-8.12b: числовая диагностика ОБЛИКА стыка. Фикстуры не
// привязаны к seed/миру: океан, берег, суша и река строятся из валидного
// Patch7 и измеряются на 16 створах, на двух шагах внутрь/наружу.
// ---------------------------------------------------------------------------

const A17B_AZIMUTHS = 16;

function a17bPatch(basePatch, kind) {
  const seaLevel = 0.1;
  const dry = (cell) => ({
    ...cell, elevation: 0.28, filledElevation: 0.28, depressionDepth: 0,
    muLand: 1, lakeId: -1, lakeWeight: 0, streamWeight: 0,
    riverAccumulation: 0, flowReceiver: -1,
  });
  const wet = (cell) => ({
    ...cell, elevation: -0.18, filledElevation: -0.18, depressionDepth: 0,
    muLand: 0, lakeId: -1, lakeWeight: 0, streamWeight: 0,
    riverAccumulation: 0, flowReceiver: -1,
  });
  if (kind === 'river') return basePatch;
  const cells = basePatch.cells.map((cell, index) => {
    if (kind === 'ocean') return wet(cell);
    if (kind === 'coast') return index === 0 || index > 3 ? wet(cell) : dry(cell);
    return dry(cell);
  });
  return {
    ...basePatch,
    seaLevel,
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

function a17bTexel(map, res, radiusM, x, y) {
  const cellSize = 2 * radiusM / res;
  const ix = Math.max(0, Math.min(res - 1, Math.floor(x / cellSize + res / 2)));
  const iy = Math.max(0, Math.min(res - 1, Math.floor(y / cellSize + res / 2)));
  return map[iy * res + ix];
}

function a17bSkirtSample(skirt, angularIndex, radiusM) {
  const z = a17SkirtHeightAt(skirt, angularIndex, radiusM);
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let nearest = 0;
  let best = Infinity;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const p = (j * angularCount + angularIndex) * 3;
    const r = Math.hypot(skirt.positions[p], skirt.positions[p + 1]);
    const d = Math.abs(r - radiusM);
    if (d < best) { best = d; nearest = p; }
  }
  const vertex = nearest / 3;
  return {
    z,
    normalDetail: Math.hypot(skirt.normals[nearest], skirt.normals[nearest + 1]),
    water: (skirt.waterMask?.[vertex] ?? 0) > 127,
    river: (skirt.riverMask?.[vertex] ?? 0) > 127,
  };
}

test('A-17b diagnostic: облик стыка на океане, берегу, суше и реке', async () => {
  assert.ok(dryPatch && riverPatch, 'нужны сухая и речная основы Patch7');
  const fixtures = [
    ['океан', a17bPatch(dryPatch, 'ocean')],
    ['берег', a17bPatch(dryPatch, 'coast')],
    ['суша', a17bPatch(dryPatch, 'land')],
    ['река', a17bPatch(riverPatch, 'river')],
  ];
  const rows = [];
  const radiusM = 2500;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const sampleStepM = (Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM
    - Worker.SKIRT_INNER_RADIUS_RATIO * radiusM) / Worker.SKIRT_COLLAR_RINGS;

  for (const [fixture, patch] of fixtures) {
    const request = {
      patch, seed: 0xA17B2026, placeId: 2, radiusM,
      profile: PROFILE, neighborRings: 0, patchKey: `a17b-${fixture}`,
    };
    Worker.clearLocalMapCache();
    const local = await Worker.generateLocalMap(request);
    const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
    for (let az = 0; az < A17B_AZIMUTHS; az++) {
      const phi = az / A17B_AZIMUTHS * Math.PI * 2;
      const angularIndex = az * Worker.SKIRT_ANGULAR_SEGMENTS / A17B_AZIMUTHS;
      const boundaryRadiusM = apothemM / Worker.clusterHexMetric(Math.cos(phi), Math.sin(phi));
      const radii = [
        boundaryRadiusM - 2 * sampleStepM,
        boundaryRadiusM - sampleStepM,
        boundaryRadiusM + sampleStepM,
        boundaryRadiusM + 2 * sampleStepM,
      ];
      const point = (r) => [Math.cos(phi) * r, Math.sin(phi) * r];
      const [innerX, innerY] = point(radii[1]);
      const innerZ = bilinearHeight(local.heightfield, HF_RES, radiusM, innerX, innerY);
      const innerTf = a17bTexel(local.terraformMap, Worker.TERRAFORM_RES, radiusM, innerX, innerY);
      const outer = a17bSkirtSample(skirt, angularIndex, radii[2]);
      const outer2 = a17bSkirtSample(skirt, angularIndex, radii[3]);
      const innerWater = innerTf === 0;
      const innerRiver = innerTf === 1;
      const outerWater = outer.water;
      const outerRiver = outer.river;
      rows.push({
        fixture,
        azimuthDeg: az * 22.5,
        waterMismatch: Number(innerWater !== outerWater),
        innerHeightM: Number(innerZ.toFixed(3)),
        outerHeightM: Number(outer.z.toFixed(3)),
        heightDeltaM: Number(Math.abs(innerZ - outer.z).toFixed(3)),
        innerDepthM: Number(Math.max(0, -innerZ).toFixed(3)),
        outerDepthM: Number(Math.max(0, -outer.z).toFixed(3)),
        depthDeltaM: Number(Math.abs(Math.max(0, -innerZ) - Math.max(0, -outer.z)).toFixed(3)),
        riverMismatch: Number(innerRiver !== outerRiver),
        innerWaterInput: innerTf <= 1 ? 1 : 0,
        outerWaterInput: outer.water || outer.river ? 1 : 0,
        innerDetailM: Number(Math.abs(
          bilinearHeight(local.heightfield, HF_RES, radiusM, ...point(radii[0])) - innerZ,
        ).toFixed(3)),
        outerDetailM: Number(Math.abs(outer2.z - outer.z).toFixed(3)),
      });
    }
  }

  console.log(`A17B_DIAG latticeNodeM=${(2 * 11.5 * radiusM / 32).toFixed(1)} visibleWidthM=1200`);
  console.table(rows);
  const summary = fixtures.map(([fixture]) => {
    const group = rows.filter((row) => row.fixture === fixture);
    return {
      fixture,
      waterMismatches: group.reduce((sum, row) => sum + row.waterMismatch, 0),
      riverMismatches: group.reduce((sum, row) => sum + row.riverMismatch, 0),
      maxHeightDeltaM: Math.max(...group.map((row) => row.heightDeltaM)),
      maxDepthDeltaM: Math.max(...group.map((row) => row.depthDeltaM)),
      maxDetailDeltaM: Math.max(...group.map((row) => Math.abs(row.innerDetailM - row.outerDetailM))),
    };
  });
  console.table(summary);
  assert.equal(rows.length, 4 * A17B_AZIMUTHS);
  assert.equal(2 * 11.5 * radiusM / 32 > 1200, true, 'узел 33×33 крупнее видимой ширины 1.2 км');
  assert.ok(summary.every((row) => row.waterMismatches === 0), 'вода/суша совпадают на всех 16 створах');
  assert.ok(summary.every((row) => row.maxDepthDeltaM <= 0.5), 'перепад глубины на стыке не больше 0.5 м');
  assert.equal(summary.find((row) => row.fixture === 'река').riverMismatches, 0, 'русло продолжается в юбку');
  assert.ok(rows.every((row) => row.innerWaterInput === row.outerWaterInput), 'водный вход шейдера един по обе стороны');
});

test('A-17b property: 40 канонических ячеек двух профилей без расхождений на стыке', async () => {
  const profiles = [
    PROFILE,
    {
      ...PROFILE,
      masterSeedHex: 'deadbeefcafebabe',
      oceanPctl: 55,
      shelfBelowPctl: 52,
      shelfAbovePctl: 58,
      streamFlowPctl: 86,
    },
  ];
  const radiusM = 2500;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const sampleStepM = (Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM
    - Worker.SKIRT_INNER_RADIUS_RATIO * radiusM) / Worker.SKIRT_COLLAR_RINGS;
  const summaries = [];
  let checkedCells = 0;

  for (const profile of profiles) {
    const sampleGrid = GeodesicGrid.build(16);
    const sampleSurface = PlanetSurface.generateSurface(sampleGrid, profile);
    const buckets = { океан: [], берег: [], суша: [], река: [] };
    for (let cell = 0; cell < sampleGrid.cellCount; cell++) {
      if (sampleGrid.neighborCount[cell] !== 6) continue;
      const elevation = sampleSurface.elevation[cell];
      const muLand = sampleSurface.muLand[cell];
      const stream = sampleSurface.streamWeight[cell];
      if (elevation < sampleSurface.seaLevel) buckets.океан.push(cell);
      else if (stream > 0) buckets.река.push(cell);
      else if (muLand < 0.9) buckets.берег.push(cell);
      else buckets.суша.push(cell);
    }
    const selected = [];
    for (const cells of Object.values(buckets)) selected.push(...cells.slice(0, 5));
    // Редкая морфология не должна уменьшать общий размер выборки.
    for (let cell = 0; selected.length < 20 && cell < sampleGrid.cellCount; cell++) {
      if (sampleGrid.neighborCount[cell] === 6 && !selected.includes(cell)) selected.push(cell);
    }

    let waterMismatches = 0;
    let riverMismatches = 0;
    let maxDepthDeltaM = 0;
    for (const cell of selected) {
      const patch = Contract.buildPatch7(sampleGrid, sampleSurface, cell);
      const request = {
        patch, seed: 0xA17B2026, placeId: 2, radiusM, profile,
        neighborRings: 0, patchKey: `a17b-sample-${profile.masterSeedHex}-${cell}`,
      };
      Worker.clearLocalMapCache();
      const local = await Worker.generateLocalMap(request);
      const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
      for (let az = 0; az < A17B_AZIMUTHS; az++) {
        const phi = az / A17B_AZIMUTHS * Math.PI * 2;
        const angularIndex = az * Worker.SKIRT_ANGULAR_SEGMENTS / A17B_AZIMUTHS;
        const boundaryRadiusM = apothemM / Worker.clusterHexMetric(Math.cos(phi), Math.sin(phi));
        // На большой выборке проверяем именно общий шов; две пары колец
        // внутрь/наружу отдельно покрыты синтетической диагностикой выше.
        const innerRadiusM = boundaryRadiusM;
        const outerRadiusM = boundaryRadiusM;
        const x = Math.cos(phi) * innerRadiusM;
        const y = Math.sin(phi) * innerRadiusM;
        const innerZ = bilinearHeight(local.heightfield, HF_RES, radiusM, x, y);
        const innerTf = a17bTexel(local.terraformMap, Worker.TERRAFORM_RES, radiusM, x, y);
        const innerWater = innerTf === 0;
        const innerRiver = innerTf === 1;
        const outer = a17bSkirtSample(skirt, angularIndex, outerRadiusM);
        waterMismatches += Number(innerWater !== outer.water);
        riverMismatches += Number(innerRiver !== outer.river);
        maxDepthDeltaM = Math.max(maxDepthDeltaM,
          Math.abs(Math.max(0, -innerZ) - Math.max(0, -outer.z)));
      }
      checkedCells++;
    }
    summaries.push({
      profile: profile.masterSeedHex,
      cells: selected.length,
      waterMismatches,
      riverMismatches,
      maxDepthDeltaM: Number(maxDepthDeltaM.toFixed(3)),
      exceptions: waterMismatches + riverMismatches === 0 && maxDepthDeltaM <= 0.5 ? 'нет' : 'см. строки',
    });
  }

  console.table(summaries);
  assert.equal(checkedCells, 40);
  assert.ok(summaries.every((row) => row.waterMismatches === 0), '0 расхождений вода/суша');
  assert.ok(summaries.every((row) => row.riverMismatches === 0), '0 обрывов русла');
  assert.ok(summaries.every((row) => row.maxDepthDeltaM <= 0.5), 'глубина непрерывна с допуском 0.5 м');
});
