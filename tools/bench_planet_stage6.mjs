#!/usr/bin/env node
/* Bench Этапа 6: GPU-геометрия глобуса без браузера.
 *
 * Что измеряется на CPU:
 *   - построение индексированной геометрии planet-globe-v1 поверх
 *     канонической Земли v=128 и поверхности c100-soft-v2;
 *   - перестройка всех восьми цветовых слоёв без новой географии;
 *   - точный pick по направлениям;
 *   - последовательные смены планет (поверхность + геометрия заново).
 *
 * Кадровое время здесь НЕ измеряется и не гейтится: честный FPS/p95
 * даёт только реальный браузер и реальное железо владельца.
 *
 *   node tools/bench_planet_stage6.mjs
 *   node tools/bench_planet_stage6.mjs --mode=switches --switches=14 --v=48
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { PRESETS as CONTRACT_PRESETS, getPresetGeographyValues } from '../site/shared/planet-generation-contract.ts';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetGeography = require('../site/shared/planet-geography.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const PlanetGlobe = require('../site/shared/planet-globe.ts').default;

const PREFERRED_SURFACE_CLASS = {
  earthlike_balanced: 'terrestrial',
  earthlike_archipelago: 'terrestrial',
  ocean_world: 'ocean',
  desert_dry: 'desert',
  ice_world: 'ice',
  volcanic_active: 'volcanic',
  barren_moon: 'barren',
};

function parseArgs(argv) {
  const result = {
    mode: 'gate',
    v: 128,
    seeds: 3,
    seedStart: 0,
    switches: 10,
    preset: 'earthlike_balanced',
    radiusKm: 6371,
    output: null,
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`Неизвестный аргумент: ${arg}`);
    const [, name, raw] = m;
    if (name === 'mode') result.mode = raw;
    else if (name === 'v') result.v = Number(raw);
    else if (name === 'seeds') result.seeds = Number(raw);
    else if (name === 'seed-start') result.seedStart = Number(raw);
    else if (name === 'switches') result.switches = Number(raw);
    else if (name === 'preset') result.preset = raw;
    else if (name === 'radius-km') result.radiusKm = Number(raw);
    else if (name === 'output') result.output = raw;
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  if (!['gate', 'switches'].includes(result.mode)) throw new Error('--mode: gate|switches');
  if (!Number.isInteger(result.v) || result.v < 4 || result.v > 256) throw new Error('--v: 4..256');
  if (!Number.isInteger(result.seeds) || result.seeds < 1 || result.seeds > 30) throw new Error('--seeds: 1..30');
  if (!Number.isInteger(result.switches) || result.switches < 1 || result.switches > 200) throw new Error('--switches: 1..200');
  if (!(result.radiusKm > 0)) throw new Error('--radius-km должно быть > 0');
  return result;
}

function loadPresets() {
  return Object.fromEntries(Object.entries(CONTRACT_PRESETS).map(([presetId, preset]) => [
    presetId,
    {
      description: preset.description,
      palette_id: preset.palette_id,
      expected_surface_classes: [...preset.expected_surface_classes],
      values: getPresetGeographyValues(presetId),
    },
  ]));
}

function seedFor(tag, index) {
  return createHash('sha256')
    .update(`planet-stage6-bench-v1|${tag}|${index}`)
    .digest('hex')
    .slice(0, 16);
}

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}
function quantileSorted(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
function distribution(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? round(sum / sorted.length) : 0,
    min: sorted.length ? round(sorted[0]) : 0,
    median: round(quantileSorted(sorted, 0.5)),
    p90: round(quantileSorted(sorted, 0.9)),
    p95: round(quantileSorted(sorted, 0.95)),
    p99: round(quantileSorted(sorted, 0.99)),
    max: sorted.length ? round(sorted[sorted.length - 1]) : 0,
  };
}
function typedGridBytes(grid) {
  const seen = new Set();
  let total = 0;
  for (const value of Object.values(grid)) {
    if (ArrayBuffer.isView(value) && !seen.has(value.buffer)) {
      seen.add(value.buffer);
      total += value.buffer.byteLength;
    }
  }
  return total;
}
function rssMiB() {
  return round(process.memoryUsage().rss / 1048576, 1);
}
function fibonacciDirections(count) {
  const dirs = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    dirs.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return dirs;
}
function scaledProfile(presets, presetId, seedHex, radiusKm, renderV) {
  const preset = presets[presetId];
  if (!preset) throw new Error(`Неизвестный preset: ${presetId}`);
  const canonical = PlanetSurface.normalizeSurfaceProfile({
    ...preset.values,
    preset_id: presetId,
    surface_class: PREFERRED_SURFACE_CLASS[presetId] || 'terrestrial',
    radius_km: radiusKm,
    master_seed_hex: seedHex,
    geography_version: PlanetSurface.GEOGRAPHY_VERSION,
  });
  const canonicalV = PlanetGeography.expectedFrequency(radiusKm);
  const ratio = renderV / canonicalV;
  const area = ratio * ratio;
  return {
    ...canonical,
    continentMeanCells: Math.max(1, Math.round(canonical.continentMeanCells * area)),
    oceanBasinMeanCells: Math.max(1, Math.round(canonical.oceanBasinMeanCells * area)),
    drainageMeanCells: Math.max(1, Math.round(canonical.drainageMeanCells * area)),
    coastSoftWidthCells: canonical.coastSoftWidthCells * ratio,
    continentSoftWidthCells: canonical.continentSoftWidthCells * ratio,
    biomeSoftWidthCells: canonical.biomeSoftWidthCells * ratio,
  };
}
function buildPlanet(grid, profile) {
  let started = performance.now();
  const surface = PlanetSurface.generateSurface(grid, profile);
  const surfaceMs = performance.now() - started;
  started = performance.now();
  const geometry = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'biome' });
  const geometryMs = performance.now() - started;
  return { surface, geometry, surfaceMs, geometryMs };
}

const options = parseArgs(process.argv.slice(2));
const presets = loadPresets();
let result;

if (options.mode === 'gate') {
  let started = performance.now();
  const grid = GeodesicGrid.build(options.v);
  const meshMs = performance.now() - started;
  const gridBytes = typedGridBytes(grid);
  const directions = fibonacciDirections(1000);
  const entries = [];
  const colorTimings = new Map(PlanetGlobe.COLOR_MODES.map((mode) => [mode.key, []]));
  let allValid = true;
  let allGeometryValid = true;

  for (let i = 0; i < options.seeds; i++) {
    const seedHex = seedFor(options.preset, options.seedStart + i);
    const profile = scaledProfile(presets, options.preset, seedHex, options.radiusKm, options.v);
    const built = buildPlanet(grid, profile);
    const validation = PlanetSurface.validateSurface(grid, built.surface);
    if (!validation.ok) allValid = false;

    const geometry = built.geometry;
    const expectedCells = GeodesicGrid.cellCountForFrequency(options.v);
    const expectedSides = grid.cellCorners.length;
    const geometryValid =
      geometry.cellCount === expectedCells &&
      geometry.vertexCount === expectedCells + expectedSides &&
      geometry.triangleCount === expectedSides &&
      geometry.indices.length === expectedSides * 3 &&
      geometry.cellIndexStart[expectedCells] === geometry.indices.length &&
      geometry.chunkRanges.reduce((sum, range) => sum + range.indexCount, 0) === geometry.indices.length;
    if (!geometryValid) allGeometryValid = false;

    for (const mode of PlanetGlobe.COLOR_MODES) {
      started = performance.now();
      const colors = PlanetGlobe.buildVertexColors(
        built.surface, geometry.vertexCellId, mode.key, geometry.cellCount);
      colorTimings.get(mode.key).push(performance.now() - started);
      if (colors.length !== geometry.vertexCount * 4) allGeometryValid = false;
    }

    const pickMs = [];
    let pickChecksum = 0;
    for (const direction of directions) {
      started = performance.now();
      pickChecksum = (pickChecksum + GeodesicGrid.pick(grid, direction)) >>> 0;
      pickMs.push(performance.now() - started);
    }

    entries.push({
      seed: seedHex,
      validationOk: validation.ok,
      geometryValid,
      surfaceMs: round(built.surfaceMs, 1),
      geometryMs: round(built.geometryMs, 1),
      totalMs: round(built.surfaceMs + built.geometryMs, 1),
      pick: distribution(pickMs),
      pickChecksum,
      geometryPayloadMiB: round(geometry.typedBytes / 1048576, 2),
      retainedWorkerGeometryMiB: round(
        (geometry.typedBytes + geometry.vertexCellId.byteLength + geometry.cellIndexStart.byteLength) / 1048576, 2),
      typedGridSurfaceGeometryMiB: round(
        (gridBytes + PlanetSurface.typedBytesOf(built.surface) + geometry.typedBytes) / 1048576, 2),
      processRssMiB: rssMiB(),
      chunks: geometry.chunkRanges.length,
    });
  }

  const geometryDistribution = distribution(entries.map((entry) => entry.geometryMs));
  const totalDistribution = distribution(entries.map((entry) => entry.totalMs));
  const colorDistributions = {};
  for (const [mode, values] of colorTimings) colorDistributions[mode] = distribution(values);
  const worstColorMedian = Math.max(...Object.values(colorDistributions).map((d) => d.median));
  const pickP95Max = Math.max(...entries.map((entry) => entry.pick.p95));
  const typedMax = Math.max(...entries.map((entry) => entry.typedGridSurfaceGeometryMiB));
  const checks = {
    validation: allValid,
    geometry: allGeometryValid,
    geometryMedianMsAtMost2500: geometryDistribution.median <= 2500,
    colorModeMedianMsAtMost1000: worstColorMedian <= 1000,
    pickP95MsAtMost2: pickP95Max <= 2,
    surfacePlusGeometryMedianMsAtMost6000: totalDistribution.median <= 6000,
    typedGridSurfaceGeometryAtMost96MiB: typedMax <= 96,
  };
  result = {
    mode: options.mode,
    versions: {
      grid: GeodesicGrid.GRID_VERSION,
      geography: PlanetSurface.GEOGRAPHY_VERSION,
      globe: PlanetGlobe.GLOBE_VERSION,
    },
    preset: options.preset,
    v: options.v,
    cells: GeodesicGrid.cellCountForFrequency(options.v),
    triangles: grid.cellCorners.length,
    radiusKm: options.radiusKm,
    meshMs: round(meshMs, 1),
    timingsMs: {
      geometry: geometryDistribution,
      surfacePlusGeometry: totalDistribution,
      colorModes: colorDistributions,
    },
    memory: { typedGridSurfaceGeometryMaxMiB: typedMax },
    checks,
    entries,
  };
} else {
  let started = performance.now();
  const grid = GeodesicGrid.build(options.v);
  const meshMs = performance.now() - started;
  const presetIds = Object.keys(PREFERRED_SURFACE_CLASS);
  const entries = [];
  let allValid = true;
  let peakRss = rssMiB();

  for (let i = 0; i < options.switches; i++) {
    const presetId = presetIds[i % presetIds.length];
    const seedHex = seedFor(`switch-${presetId}`, i);
    const profile = scaledProfile(presets, presetId, seedHex, options.radiusKm, options.v);
    let built = buildPlanet(grid, profile);
    const validation = PlanetSurface.validateSurface(grid, built.surface);
    if (!validation.ok || built.geometry.cellCount !== grid.cellCount) allValid = false;
    entries.push({
      index: i,
      preset: presetId,
      seed: seedHex,
      validationOk: validation.ok,
      surfaceMs: round(built.surfaceMs, 1),
      geometryMs: round(built.geometryMs, 1),
      totalMs: round(built.surfaceMs + built.geometryMs, 1),
      geometryPayloadMiB: round(built.geometry.typedBytes / 1048576, 2),
      processRssMiB: rssMiB(),
    });
    peakRss = Math.max(peakRss, entries[entries.length - 1].processRssMiB);
    built = null;
    if (typeof globalThis.gc === 'function') globalThis.gc();
  }

  const checks = {
    validation: allValid,
    allSwitchesCompleted: entries.length === options.switches,
    medianSwitchMsAtMost5000: distribution(entries.map((entry) => entry.totalMs)).median <= 5000,
  };
  result = {
    mode: options.mode,
    versions: {
      grid: GeodesicGrid.GRID_VERSION,
      geography: PlanetSurface.GEOGRAPHY_VERSION,
      globe: PlanetGlobe.GLOBE_VERSION,
    },
    v: options.v,
    cells: grid.cellCount,
    radiusKm: options.radiusKm,
    meshMs: round(meshMs, 1),
    switchCount: options.switches,
    timingsMs: {
      surface: distribution(entries.map((entry) => entry.surfaceMs)),
      geometry: distribution(entries.map((entry) => entry.geometryMs)),
      total: distribution(entries.map((entry) => entry.totalMs)),
    },
    memory: {
      firstProcessRssMiB: entries[0]?.processRssMiB ?? null,
      lastProcessRssMiB: entries[entries.length - 1]?.processRssMiB ?? null,
      peakProcessRssMiB: peakRss,
      note: 'RSS Node не является доказательством отсутствия утечек GPU в браузере; браузерный стресс делается автосменой на странице.',
    },
    checks,
    entries,
  };
}

const serialized = JSON.stringify(result, null, 2) + '\n';
if (options.output) writeFileSync(options.output, serialized);
process.stdout.write(serialized);
if (Object.values(result.checks).some((ok) => !ok)) process.exitCode = 1;
