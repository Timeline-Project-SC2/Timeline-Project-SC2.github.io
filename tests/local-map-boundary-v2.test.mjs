/* W23d — отдельные регрессии расширенного Patch7, не меняют прочие тесты Stage-8. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Grid = require('../site/shared/geodesic-grid.ts').default;
const Surface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Worker = require('../src/local-map/local-map-worker.ts');
const Heightfield = require('../src/local-map/local-map-heightfield.ts');
const Geometry = require('../src/local-map/local-map-geometry.ts');
const Rivers = require('../src/local-map/local-map-rivers.ts');
const Stand = await import('../tools/stand_local_map.mjs');

const grid = Grid.build(128);
const world = Stand.WORLDS.a29;
const surface = Surface.generateSurface(grid, world.profile);
const radiusM = Stand.DEFAULT_RADIUS_M;
const patchFor = (cell) => Contract.withBoundaryInflows(
  grid, surface, Contract.buildPatch7(grid, surface, cell),
);
const requestFor = (patch, key, neighborRings) => ({
  patch, seed: world.seed, placeId: 2, radiusM, profile: world.profile,
  neighborRings, patchKey: `v2-${key}`,
});

test('Patch7 v2: граничные притоки из surface, проверка формы и JSON ≤ 4 КБ', () => {
  const sample = [
    ...Stand.selectLandCells(grid, surface, world.seed, 20),
    ...Stand.selectRiverCells(grid, surface, world.seed, 10),
    14074, 14075,
  ];
  let maxBytes = 0;
  for (const cell of sample) {
    const patch = patchFor(cell);
    assert.equal(patch.version, 'local-map-patch-v2');
    assert.deepEqual(Contract.verifyPatchInvariants(patch).ok, true, `инварианты #${cell}`);
    assert.deepEqual(patch.boundaryInflows, patchFor(cell).boundaryInflows, 'порядок независим от запроса');
    const inside = new Set(patch.cells.map((item) => item.cell));
    for (const inflow of patch.boundaryInflows) {
      assert.ok(!inside.has(inflow.fromCell) && inside.has(inflow.toCell));
      assert.equal(surface.flowReceiver[inflow.fromCell], inflow.toCell);
      assert.equal(surface.streamWeight[inflow.fromCell], inflow.streamWeight);
    }
    const extraBytes = JSON.stringify(patch).length
      - JSON.stringify({ ...patch, boundaryInflows: [] }).length;
    maxBytes = Math.max(maxBytes, extraBytes);
    assert.ok(extraBytes <= 4096, `#${cell}: +${extraBytes} Б ≤ 4096 Б`);
  }
  assert.ok(maxBytes > 0, 'выборка действительно включает граничные притоки');
  const valid = patchFor(14075);
  assert.equal(Contract.verifyPatchInvariants({ ...valid, version: 'local-map-patch-v1' }).checks['boundary-inflows-v2'], false,
    'отрицательный контроль: версия v1 не маскируется v2');
  assert.equal(Contract.verifyPatchInvariants({ ...valid, boundaryInflows: undefined }).checks['boundary-inflows-v2'], false,
    'отрицательный контроль: отсутствие поля не маскируется пустым массивом');
  assert.equal(Contract.verifyPatchInvariants({ ...valid, boundaryInflows: [
    { ...valid.boundaryInflows[0], fromCell: valid.centerCell },
  ] }).checks['boundary-inflows-v2'], false, 'отрицательный контроль: дуга изнутри патча отвергнута');
});

test('Patch7 v2: смена веса притока при том же ключе инвалидирует кэш поймы', async () => {
  const patch = patchFor(14075);
  const altered = { ...patch, boundaryInflows: patch.boundaryInflows.map((edge) =>
    edge.fromCell === 14104 ? { ...edge, streamWeight: 0 } : edge) };
  assert.ok(Contract.verifyPatchInvariants(altered).ok);
  Worker.clearLocalMapCache();
  const first = await Worker.generateLocalMap(requestFor(patch, 'stream-weight', 1));
  const second = await Worker.generateLocalMap(requestFor(altered, 'stream-weight', 1));
  const uncached = await Worker.generateLocalMap(requestFor(altered, 'fresh-stream-weight', 1));
  const maxDifference = (a, b) => {
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    return max;
  };
  assert.ok(maxDifference(first.heightfield, second.heightfield) >= 1,
    'порог streamWeight физически изменил долину, а кэш не замаскировал отличие');
  assert.equal(maxDifference(second.heightfield, uncached.heightfield), 0,
    'ответ с тем же patchKey, но новым весом, равен свежей генерации');
  assert.equal(maxDifference(second.ringCells[0].heightfield,
    uncached.ringCells[0].heightfield), 0, 'LOD-кольцо тоже не из старого кэша');
});

test('речные физические ширина/глубина не зависят от радиуса патча', async () => {
  const patch = patchFor(14074);
  const segments = await Worker.worldRiverSegmentsForPatch(patch, world.profile);
  const main = segments.find((seg) => seg.fromCell === patch.centerCell);
  assert.ok(main);
  const angle = 1100 / patch.frame.radiusM;
  const offsetDir = patch.frame.origin.map((value, i) =>
    Math.cos(angle) * value + Math.sin(angle) * main.normal[i]);
  for (const dir of [patch.frame.origin, offsetDir]) {
    const r1 = Worker.worldRiverDepthAt(dir, segments, radiusM, patch.frame.radiusM);
    const r2 = Worker.worldRiverDepthAt(dir, segments, 2 * radiusM, patch.frame.radiusM);
    assert.ok(r1 > 0.5, `створ в зоне вреза: ${r1} м`);
    assert.ok(Math.abs(r1 - r2) <= 0.1, `при 2× radiusPatchM Δглубины=${r1 - r2} м ≤ 0,1`);
  }
  // Маска русла использует ту же дистанцию, что и физический врез. Если
  // разделить вычисления, прежние пиксели terraform/spawn обязаны совпасть.
  for (const distanceM of [0, 100, 800, 1100, 1600, 2000, 5000]) {
    const angleM = distanceM / patch.frame.radiusM;
    const dir = patch.frame.origin.map((value, i) =>
      Math.cos(angleM) * value + Math.sin(angleM) * main.normal[i]);
    const info = { seaBlend: 0, channelFactor: 0 };
    Worker.worldRiverDepthAt(dir, segments, radiusM, patch.frame.radiusM, undefined, info);
    const originalMask = Geometry.worldRiverCarveFactor(
      dir, segments, patch.frame.radiusM, Rivers.RIVER_CHANNEL_HALF_WIDTH_M,
    );
    assert.ok(Math.abs(info.channelFactor - originalMask) <= 1e-12,
      `при ${distanceM} м маркер=стрежень: ${info.channelFactor} ≈ ${originalMask}`);
  }
  assert.ok(Worker.worldRiverDepthAt(patch.frame.origin, segments, radiusM, patch.frame.radiusM) >= 3);
  Worker.clearLocalMapCache();
  const baseRequest = requestFor(patch, 'radius-depth', 0);
  const first = await Worker.generateLocalMap(baseRequest);
  const doubled = await Worker.generateLocalMap({ ...baseRequest, radiusM: radiusM * 2 });
  const center = Math.floor(Worker.HEIGHTFIELD_RES / 2) * Worker.HEIGHTFIELD_RES
    + Math.floor(Worker.HEIGHTFIELD_RES / 2);
  assert.equal(first.terraformMap[center], 1, 'проверяется именно сухопутное русло');
  assert.equal(doubled.terraformMap[center], 1);
  assert.ok(Math.abs(first.heightfield[center] - doubled.heightfield[center]) <= 0.1,
    'с теми же мировыми дугами удвоение радиуса не углубляет и не поднимает речное дно');
  assert.ok(Rivers.RIVER_CHANNEL_HALF_WIDTH_M > 0);
  assert.equal(Rivers.RIVER_CHANNEL_DEPTH_M, 10);
});

test('m.2/m.3: десять речных створов держат глубину и непрерывность', async () => {
  const sample = await Stand.measureRiverSample(grid, surface, world, 10, radiusM);
  assert.equal(sample.selected, 10);
  assert.ok(sample.summary.m2.median >= 3 && sample.summary.m2.median <= 12,
    `m.2 медиана ${sample.summary.m2.median} м в 3…12 м`);
  assert.equal(sample.summary.m3.passed, 10, 'm.3 все 10 створов PASS');
});

test('m.14: 20 наземных центров × 6 граней × ≥ 20 общих узлов, max ≤ 2 м', async () => {
  const sample = await Stand.measureLandSample(grid, surface, world, 20, radiusM);
  assert.equal(sample.selected, 20);
  assert.ok(sample.m8.passed > 13, `m.8 доля ${sample.m8.passed}/20 выше 13/20`);
  assert.ok(sample.m10.passed > 10, `m.10 доля ${sample.m10.passed}/20 выше 10/20`);
  let faces = 0;
  for (const row of sample.rows) {
    assert.equal(row.m14Faces.length, 6, `центр #${row.cell}: ровно шесть граней`);
    for (const face of row.m14Faces) {
      faces++;
      assert.ok(face.points >= 20, `#${row.cell}→#${face.sourceCell}: ${face.points} узлов`);
      assert.ok(face.maxDeltaM <= 2, `#${row.cell}→#${face.sourceCell}: ${face.maxDeltaM} м`);
    }
  }
  assert.equal(faces, 120);

  // Если убрать локальную detail из общей формулы, тест обязан увидеть ≥1 м,
  // иначе m.14 мог бы ложно проходить на одном только базовом поле W28c.
  const stepM = 2 * radiusM / Worker.HEIGHTFIELD_RES;
  const seed = (world.seed ^ Math.imul(3, 0x85EBCA6B)) >>> 0;
  const detailOmittedM = Math.max(...sample.rows.map(({ cell }) => {
    const patch = patchFor(cell);
    return Math.abs(Heightfield.sampleLocalTerrainDetailM(
      patch.frame.origin, patch.frame.radiusM, seed, true, stepM,
    ));
  }));
  assert.ok(detailOmittedM >= 1, `отрицательный контроль без detail: Δ=${detailOmittedM} м ≥1 м`);
  // Не только аналитическая амплитуда: реальное кольцо продукта обязано
  // отличаться от результата «поле + врез», если удалить весь detail-канал.
  const patch = patchFor(sample.rows[0].cell);
  Worker.clearLocalMapCache();
  const local = await Worker.generateLocalMap(requestFor(patch, 'detail-negative', 1));
  const arcs = await Worker.worldRiverSegmentsForPatch(patch, world.profile);
  const omittedInProductM = Math.max(...local.ringCells.filter((cell) => cell.ring === 1).map((cell) => {
    const field = Heightfield.sampleElevationForSeed(cell.center, stepM,
      world.profile.masterSeedHex, patch.frame.radiusM / 1000, patch.seaLevel);
    const withoutDetail = field - Worker.worldRiverDepthAt(
      cell.center, arcs, radiusM, patch.frame.radiusM, field,
    );
    const center = Math.floor(cell.hfRes / 2) * cell.hfRes + Math.floor(cell.hfRes / 2);
    return Math.abs(cell.heightfield[center] - withoutDetail);
  }));
  assert.ok(omittedInProductM >= 1,
    `отрицательный контроль: product ring[1] без detail ошибся на ${omittedInProductM} м ≥1 м`);
});

test('m.14: без boundaryInflows повторяется ≥5 м и не выдаётся PASS', async () => {
  const target = patchFor(14074);
  const neighbor = patchFor(14075);
  assert.ok(neighbor.boundaryInflows.some((edge) => edge.toCell === 14074),
    'в патче соседа есть внешний приток к центру 14074');
  Worker.clearLocalMapCache();
  const fine = await Worker.generateLocalMap(requestFor(target, 'fine-14074', 0));
  const measure = async (patch, label) => {
    Worker.clearLocalMapCache();
    const local = await Worker.generateLocalMap(requestFor(patch, label, 1));
    const ring = local.ringCells.find((cell) => cell.ring === 1
      && cell.center.every((value, k) => Math.abs(value - target.frame.origin[k]) < 1e-7));
    assert.ok(ring, `кольцо содержит целевой гекс, ${label}`);
    const report = Stand.measureLodConsistency(fine, target, [{
      sourceLabel: String(patch.centerCell),
      frameEast: patch.frame.east, frameNorth: patch.frame.north,
      hfRes: ring.hfRes, spanM: ring.spanM, heightfield: ring.heightfield,
    }], radiusM);
    assert.ok(report.views[0].points >= 20);
    return report.value;
  };
  const full = await measure(neighbor, 'full-14075');
  const missing = await measure({ ...neighbor, boundaryInflows: [] }, 'empty-14075');
  assert.ok(full <= 2, `глобальные притоки: ${full} м ≤ 2 м`);
  assert.ok(missing >= 5, `отрицательный контроль boundaryInflows=[]: ${missing} м ≥ 5 м`);
});
