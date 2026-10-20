import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomUnitVector(random) {
  for (;;) {
    const x = random() * 2 - 1;
    const y = random() * 2 - 1;
    const z = random() * 2 - 1;
    const len2 = x * x + y * y + z * z;
    if (len2 > 0 && len2 <= 1) {
      const len = Math.sqrt(len2);
      return [x / len, y / len, z / len];
    }
  }
}

test('goldberg-gp-v1: топология, адреса и обратный поиск', () => {
  const grid = GeodesicGrid.build(4);
  const validation = GeodesicGrid.validate(grid);
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.equal(grid.gridVersion, 'goldberg-gp-v1');
  assert.equal(grid.addressSchema, 'goldberg-gp-v1');
  assert.equal(grid.topologySchema, 'goldberg-gp-v1-soa');

  const addresses = new Set();
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const address = GeodesicGrid.addressOf(grid, cell);
    addresses.add(address);
    const parsed = GeodesicGrid.parseAddress(address);
    assert.ok(parsed, address);
    assert.equal(parsed.bodyIndex, 0);
    assert.equal(parsed.v, 4);
    assert.equal(parsed.face, grid.addrFace[cell]);
    assert.equal(parsed.i, grid.addrI[cell]);
    assert.equal(parsed.j, grid.addrJ[cell]);
    assert.equal(GeodesicGrid.cellAtAddress(grid, address), cell);
    assert.equal(GeodesicGrid.cellAtAddress(grid, parsed), cell);
  }
  assert.equal(addresses.size, grid.cellCount);

  assert.equal(GeodesicGrid.parseAddress('goldberg-gp-v0/w0/v4/f00/a0/b0'), null);
  assert.equal(GeodesicGrid.parseAddress('goldberg-gp-v1/w0/v4/f20/a0/b0'), null);
  assert.equal(GeodesicGrid.parseAddress('goldberg-gp-v1/w0/v4/f00/a3/b2'), null);
  assert.equal(GeodesicGrid.cellAtAddress(grid, 'goldberg-gp-v1/w1/v4/f00/a0/b0'), -1);
});

test('goldberg-gp-v1: chunk-контракт непрерывен и соседи симметричны', () => {
  const grid = GeodesicGrid.build(64);
  const validation = GeodesicGrid.validateChunks(grid);
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.equal(validation.chunkCount, 60);
  assert.equal(validation.maxCells, 1024);
  assert.ok(Math.min(...GeodesicGrid.getChunks(grid).map((chunk) => chunk.cellCount)) >= 32);

  const chunks = GeodesicGrid.getChunks(grid);
  let nextStart = 0;
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.id, index);
    assert.equal(chunk.startCell, nextStart);
    nextStart += chunk.cellCount;
    assert.ok(Number.isFinite(chunk.boundingSphere.radius));
    assert.ok(chunk.boundingSphere.cosAngularRadius >= -1);
    assert.ok(chunk.boundingSphere.cosAngularRadius <= 1);
  }
  assert.equal(nextStart, grid.cellCount);
  assert.deepEqual(GeodesicGrid.getChunkNeighbors(grid, -1), []);
});

test('goldberg-gp-v1: быстрый pick точно совпадает с полным перебором', () => {
  const grid = GeodesicGrid.build(16);
  const random = deterministicRandom(0x5eed1234);
  const directions = [];
  for (let i = 0; i < 300; i++) directions.push(randomUnitVector(random));
  for (let cell = 0; cell < grid.cellCount; cell += 37) {
    directions.push([
      grid.centers[cell * 3],
      grid.centers[cell * 3 + 1],
      grid.centers[cell * 3 + 2],
    ]);
  }
  for (const dir of directions) {
    assert.equal(GeodesicGrid.pick(grid, dir), GeodesicGrid.pickBruteForce(grid, dir));
  }
});

test('goldberg-gp-v1: каноническая плотность Земли зафиксирована на v=128', () => {
  assert.equal(GeodesicGrid.EARTH_CANONICAL_V, 128);
  assert.equal(GeodesicGrid.frequencyForRadius(6371), 128);
  assert.equal(GeodesicGrid.frequencyForRadius(3390), 68);
  assert.equal(GeodesicGrid.frequencyForRadius(2000), 40);
  assert.equal(GeodesicGrid.cellCountForFrequency(128), 163842);
  assert.ok(Math.abs(GeodesicGrid.meanCellAreaKm2(6371) - 3113.15) < 0.1);
  assert.ok(Math.abs(GeodesicGrid.meanCellEdgeKm(6371) - 34.62) < 0.1);
  assert.throws(() => GeodesicGrid.frequencyForRadius(0), /radiusKm/);
});
