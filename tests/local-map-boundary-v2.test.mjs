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

test('m.14: 20 наземных центров × 6 граней × ≥ 20 общих узлов, max ≤ 2 м', async () => {
  const sample = await Stand.measureLandSample(grid, surface, world, 20, radiusM);
  assert.equal(sample.selected, 20);
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
