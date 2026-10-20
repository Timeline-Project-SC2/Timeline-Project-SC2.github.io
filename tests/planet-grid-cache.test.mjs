// Stage 3 TODO tests for the versioned binary topology cache.
//
// The cache implementation does not exist yet. These are intentionally
// registered as node:test TODOs with the exact future public signatures:
//
//   serializeGridCache(grid, meta) -> ArrayBuffer
//   deserializeGridCache(bytes, expectedMeta)
//     -> { ok: true, grid } | { ok: false, reason }
//   loadGridWithCache({ readCache, writeCache, rebuildGrid, expectedMeta })
//     -> Promise<{ grid, source: 'cache' | 'rebuilt', reason? }>
//
// Header v1 (see docs/PREPARATION_PLAN.md, Stage 3):
//   magic "GEO\0", uint16 version, uint32 0x01020304 endianness marker,
//   uint32 paramsHash, payload length and payload CRC32C.
//
// When Stage 3 lands, replace test.todo with test() and implement bodies
// equivalent to:
//
//   const bytes = new Uint8Array(serializeGridCache(grid, meta));
//   bytes[bytes.length - 1] ^= 0xff;
//   const out = await loadGridWithCache({
//     readCache: async () => bytes,
//     writeCache: async () => {},
//     rebuildGrid: async () => grid,
//     expectedMeta: meta,
//   });
//   assert.equal(out.source, 'rebuilt');
//
// and for the old version: set the uint16 at byte offset 4 to 0 and expect
// the same rebuilt result without an exception reaching the caller.

import test from 'node:test';

test.todo('planet grid cache: corrupt one byte -> rebuild mesh, do not throw');
test.todo('planet grid cache: old format version -> rebuild mesh, do not throw');
