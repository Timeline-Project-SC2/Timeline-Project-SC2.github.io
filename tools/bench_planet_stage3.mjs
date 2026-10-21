#!/usr/bin/env node
/* Bench/валидация боевого ядра Этапа 3.
 *
 * По умолчанию проверяет каноническую Землю v=128:
 *   node tools/bench_planet_stage3.mjs
 *
 * Опции: --v=128 --reps=3 --picks=1000
 * На stdout печатается один JSON-объект. Ненулевой exit code означает, что
 * топология, chunk-контракт, быстрый pick или бинарный round-trip не прошли.
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');

function parseArgs(argv) {
  const result = { v: 128, reps: 3, picks: 1000 };
  for (const arg of argv) {
    const m = /^--(v|reps|picks)=([0-9]+)$/.exec(arg);
    if (!m) throw new Error(`Неизвестный аргумент: ${arg}`);
    result[m[1]] = Number(m[2]);
  }
  if (!Number.isInteger(result.v) || result.v < 1) throw new Error('--v должно быть целым >= 1');
  if (!Number.isInteger(result.reps) || result.reps < 1 || result.reps > 20) throw new Error('--reps: 1..20');
  if (!Number.isInteger(result.picks) || result.picks < 1 || result.picks > 100000) throw new Error('--picks: 1..100000');
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function typedBytes(grid) {
  let total = 0;
  for (const value of Object.values(grid)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

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

const options = parseArgs(process.argv.slice(2));
const buildTimes = [];
let grid = null;
for (let rep = 0; rep < options.reps; rep++) {
  const t = performance.now();
  grid = GeodesicGrid.build(options.v);
  buildTimes.push(performance.now() - t);
}

const validation = GeodesicGrid.validate(grid);
const chunkValidation = validation.chunks;
const chunks = GeodesicGrid.getChunks(grid);
const angularRadiiDeg = chunks.map((chunk) => chunk.boundingSphere.angularRadius * 180 / Math.PI);
const chunkSizes = chunks.map((chunk) => chunk.cellCount);

const random = deterministicRandom(0x51a9e001 ^ options.v);
const directions = Array.from({ length: options.picks }, () => randomUnitVector(random));
const fastTimes = [];
const bruteTimes = [];
let pickMismatches = 0;
for (const dir of directions) {
  let t = performance.now();
  const fast = GeodesicGrid.pick(grid, dir);
  fastTimes.push(performance.now() - t);
  t = performance.now();
  const brute = GeodesicGrid.pickBruteForce(grid, dir);
  bruteTimes.push(performance.now() - t);
  if (fast !== brute) pickMismatches++;
}

const meta = GeodesicGrid.gridCacheMeta(grid);
const serializeTimes = [];
let cacheBytes = null;
for (let rep = 0; rep < options.reps; rep++) {
  const t = performance.now();
  cacheBytes = GeodesicGrid.serializeGridCache(grid, meta);
  serializeTimes.push(performance.now() - t);
}
const deserializeTimes = [];
let parsed = null;
for (let rep = 0; rep < options.reps; rep++) {
  const t = performance.now();
  parsed = GeodesicGrid.deserializeGridCache(cacheBytes, meta);
  deserializeTimes.push(performance.now() - t);
}

const result = {
  v: options.v,
  gridVersion: grid.gridVersion,
  topologySchema: grid.topologySchema,
  cells: grid.cellCount,
  triangles: grid.triangleCount,
  buildMs: {
    reps: buildTimes.map((x) => +x.toFixed(1)),
    median: +median(buildTimes).toFixed(1),
  },
  typedMemoryMiB: +(typedBytes(grid) / 1048576).toFixed(2),
  validation: {
    ok: validation.ok,
    checks: validation.checks,
    areaSumDelta: +(Math.abs(validation.areaSum - 4 * Math.PI)).toExponential(3),
  },
  chunks: {
    ok: chunkValidation.ok,
    count: chunks.length,
    averageCells: +(grid.cellCount / chunks.length).toFixed(1),
    minCells: Math.min(...chunkSizes),
    maxCells: Math.max(...chunkSizes),
    averageAngularRadiusDeg: +(angularRadiiDeg.reduce((a, b) => a + b, 0) / angularRadiiDeg.length).toFixed(2),
    maxAngularRadiusDeg: +Math.max(...angularRadiiDeg).toFixed(2),
  },
  pick: {
    samples: options.picks,
    mismatches: pickMismatches,
    fastMeanMs: +(fastTimes.reduce((a, b) => a + b, 0) / fastTimes.length).toFixed(4),
    fastP95Ms: +percentile(fastTimes, 0.95).toFixed(4),
    bruteMeanMs: +(bruteTimes.reduce((a, b) => a + b, 0) / bruteTimes.length).toFixed(4),
    bruteP95Ms: +percentile(bruteTimes, 0.95).toFixed(4),
  },
  binaryCache: {
    ok: !!parsed?.ok,
    bytes: cacheBytes.byteLength,
    serializeMedianMs: +median(serializeTimes).toFixed(1),
    deserializeMedianMs: +median(deserializeTimes).toFixed(1),
    reason: parsed?.ok ? null : (parsed?.reason || 'unknown'),
  },
  canonicalDensity: {
    earthRadiusKm: GeodesicGrid.EARTH_RADIUS_KM,
    earthCanonicalV: GeodesicGrid.EARTH_CANONICAL_V,
    frequencyForEarth: GeodesicGrid.frequencyForRadius(6371),
    meanEarthCellAreaKm2: +GeodesicGrid.meanCellAreaKm2(6371).toFixed(1),
    meanEarthCellEdgeKm: +GeodesicGrid.meanCellEdgeKm(6371).toFixed(1),
  },
};

console.log(JSON.stringify(result, null, 2));
if (!validation.ok || !chunkValidation.ok || pickMismatches !== 0 || !parsed?.ok || chunkValidation.maxCells > GeodesicGrid.CHUNK_MAX_CELLS) {
  process.exitCode = 1;
}
