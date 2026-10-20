import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');

const grid = GeodesicGrid.build(8);
const meta = GeodesicGrid.gridCacheMeta(grid);
const validBytes = GeodesicGrid.serializeGridCache(grid, meta);

function assertSameTypedArray(actual, expected, label) {
  assert.equal(actual.constructor, expected.constructor, `${label}: тип массива`);
  assert.deepEqual(
    Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
    Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
    `${label}: байты массива`,
  );
}

test('binary cache v1: заголовок, SHA-256 paramsHash и round-trip топологии', () => {
  const bytes = new Uint8Array(validBytes);
  const view = new DataView(validBytes);
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x47, 0x45, 0x4f, 0x00]);
  assert.equal(view.getUint16(4, true), 1);
  assert.equal(view.getUint16(6, true), 0);
  assert.equal(view.getUint32(8, true), 0x01020304);
  assert.equal(view.getUint32(16, true), 32);
  assert.equal(view.getUint32(20, true), validBytes.byteLength - 32);
  assert.equal(view.getUint32(28, true), grid.v);
  assert.equal(view.getUint32(24, true), GeodesicGrid.crc32c(bytes.subarray(32)));
  assert.equal(GeodesicGrid.crc32c(new TextEncoder().encode('123456789')), 0xe3069283);

  const expectedHash = createHash('sha256').update(JSON.stringify(meta)).digest().readUInt32BE(0);
  assert.equal(view.getUint32(12, true), expectedHash);
  assert.equal(GeodesicGrid.gridCacheParamsHash(meta), expectedHash);

  const parsed = GeodesicGrid.deserializeGridCache(validBytes, meta);
  assert.equal(parsed.ok, true, parsed.reason);
  for (const name of [
    'centers', 'corners', 'triangles', 'cellCornerStart', 'cellCorners',
    'neighbors', 'neighborCount', 'areas', 'addrFace', 'addrI', 'addrJ', 'cellChunk',
  ]) {
    assertSameTypedArray(parsed.grid[name], grid[name], name);
  }
  assert.equal(parsed.grid.gridVersion, 'goldberg-gp-v1');
  assert.equal(parsed.grid.addressSchema, 'goldberg-gp-v1');
  assert.equal(parsed.grid.topologySchema, 'goldberg-gp-v1-soa');
  assert.equal(parsed.grid.chunkCount, grid.chunkCount);
  assert.equal(GeodesicGrid.validate(parsed.grid).ok, true);
});

test('binary cache v1: битый payload не бросает, loadGridWithCache перестраивает сетку', async () => {
  const corrupt = new Uint8Array(validBytes.slice(0));
  corrupt[corrupt.length - 1] ^= 0x01;

  const parsed = GeodesicGrid.deserializeGridCache(corrupt, meta);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'crc-mismatch');

  let written = null;
  const result = await GeodesicGrid.loadGridWithCache({
    expectedMeta: meta,
    readCache: async () => corrupt,
    writeCache: async (bytes) => { written = bytes; },
    rebuildGrid: async () => GeodesicGrid.build(meta.v),
  });
  assert.equal(result.source, 'rebuilt');
  assert.equal(result.reason, 'crc-mismatch');
  assert.equal(result.grid.v, meta.v);
  assert.ok(written instanceof ArrayBuffer);
  assert.equal(GeodesicGrid.deserializeGridCache(written, meta).ok, true);
});

test('binary cache v1: старая версия формата игнорируется и сетка перестраивается', async () => {
  const oldBytes = validBytes.slice(0);
  new DataView(oldBytes).setUint16(4, 0, true);

  const parsed = GeodesicGrid.deserializeGridCache(oldBytes, meta);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'unsupported-version');

  let writes = 0;
  const result = await GeodesicGrid.loadGridWithCache({
    expectedMeta: meta,
    readCache: async () => oldBytes,
    writeCache: async () => { writes++; },
    rebuildGrid: async () => GeodesicGrid.build(meta.v),
  });
  assert.equal(result.source, 'rebuilt');
  assert.equal(result.reason, 'unsupported-version');
  assert.equal(writes, 1);
});

test('binary cache v1: mismatch метаданных и ошибка чтения ведут к rebuild', async () => {
  const wrongMeta = GeodesicGrid.gridCacheMeta({ ...meta, v: 16 });
  const mismatch = GeodesicGrid.deserializeGridCache(validBytes, wrongMeta);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'v-mismatch');

  const result = await GeodesicGrid.loadGridWithCache({
    expectedMeta: meta,
    readCache: async () => { throw new Error('IDB unavailable'); },
    writeCache: async () => { throw new Error('quota'); },
    rebuildGrid: async () => GeodesicGrid.build(meta.v),
  });
  assert.equal(result.source, 'rebuilt');
  assert.equal(result.reason, 'cache-read-error');
  assert.equal(result.grid.cellCount, grid.cellCount);
});
