// CPU-only regression bench for CI.
//
// Compares mesh build time and deterministic typed-array memory for
// v=64/128/192 against baseline-2026-10-20.json. It intentionally does not
// measure frame time: GitHub-hosted runners have no representative GPU,
// and SwiftShader frame pacing would be a false signal.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function typedBytes(obj) {
  let sum = 0;
  for (const val of Object.values(obj || {})) if (ArrayBuffer.isView(val)) sum += val.byteLength;
  return sum;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (process.argv.includes('--child')) {
  const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
  const v = Number(argValue('v', '64'));
  const reps = Number(argValue('reps', '5'));
  GeodesicGrid.build(16);
  if (global.gc) global.gc();
  const samples = [];
  let grid = null;
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    grid = GeodesicGrid.build(v);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const rng = mulberry32(0xC0FFEE + v);
  const picks = [];
  let checksum = 0;
  for (let i = 0; i < 100; i++) {
    let x = rng() * 2 - 1;
    let y = rng() * 2 - 1;
    let z = rng() * 2 - 1;
    const len = Math.hypot(x, y, z) || 1;
    x /= len; y /= len; z /= len;
    const t0 = process.hrtime.bigint();
    checksum += GeodesicGrid.pick(grid, [x, y, z]);
    picks.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const sortedBuild = [...samples].sort((a, b) => a - b);
  const sortedPick = [...picks].sort((a, b) => a - b);
  const ru = process.resourceUsage();
  const maxRssBytes = process.platform === 'darwin' ? ru.maxrss : ru.maxrss * 1024;
  process.stdout.write(`${JSON.stringify({
    v,
    meshBuildMs: percentile(sortedBuild, 0.5),
    meshBuildSamplesMs: samples,
    gridTypedArrayBytes: typedBytes(grid),
    maxRssBytes,
    processMemory: process.memoryUsage(),
    pickMeanMs: picks.reduce((a, b) => a + b, 0) / picks.length,
    pickP95Ms: percentile(sortedPick, 0.95),
    checksum,
  })}\n`);
  process.exit(0);
}

const baselinePath = path.resolve(rootDir, argValue('baseline', 'baseline-2026-10-20.json'));
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const baselineByV = new Map(baseline.results.map((r) => [r.v, r.cpu]));
const failures = [];

for (const v of [64, 128, 192]) {
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', selfPath, '--child', `--v=${v}`, '--reps=5'],
    { cwd: rootDir, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );
  if (child.status !== 0) {
    failures.push(`v=${v}: bench child failed\n${child.stdout || ''}${child.stderr || ''}`);
    continue;
  }
  const lines = child.stdout.trim().split('\n');
  const current = JSON.parse(lines[lines.length - 1]);
  const base = baselineByV.get(v);
  if (!base) {
    failures.push(`v=${v}: baseline entry missing in ${path.relative(rootDir, baselinePath)}`);
    continue;
  }

  const buildDelta = (current.meshBuildMs / base.meshBuildMs - 1) * 100;
  const memDelta = (current.gridTypedArrayBytes / base.gridTypedArrayBytes - 1) * 100;
  console.log(
    `v=${v}: build ${base.meshBuildMs.toFixed(1)}ms -> ${current.meshBuildMs.toFixed(1)}ms (${buildDelta >= 0 ? '+' : ''}${buildDelta.toFixed(1)}%), ` +
    `typed memory ${(base.gridTypedArrayBytes / 1048576).toFixed(2)}MiB -> ${(current.gridTypedArrayBytes / 1048576).toFixed(2)}MiB (${memDelta >= 0 ? '+' : ''}${memDelta.toFixed(1)}%), ` +
    `pick mean ${current.pickMeanMs.toFixed(3)}ms p95 ${current.pickP95Ms.toFixed(3)}ms, maxRSS ${(current.maxRssBytes / 1048576).toFixed(1)}MiB (info)`,
  );

  if (current.meshBuildMs > base.meshBuildMs * 1.20) {
    failures.push(
      `build time for v=${v}: ${base.meshBuildMs.toFixed(1)}ms -> ${current.meshBuildMs.toFixed(1)}ms (+${buildDelta.toFixed(1)}%), threshold 20%`,
    );
  }
  if (current.gridTypedArrayBytes > base.gridTypedArrayBytes * 1.30) {
    failures.push(
      `memory for v=${v}: ${(base.gridTypedArrayBytes / 1048576).toFixed(2)}MiB -> ${(current.gridTypedArrayBytes / 1048576).toFixed(2)}MiB (+${memDelta.toFixed(1)}%), threshold 30%`,
    );
  }
}

if (failures.length) {
  console.error('\nPlanet CPU performance regression:');
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log('Planet CPU performance bench: OK');
