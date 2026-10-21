#!/usr/bin/env node
/* Bench и статистическая калибровка Этапа 4: поля + C100-soft.
 *
 * Гейт G2 по умолчанию (каноническая Земля, v=128, 5 seed):
 *   node tools/bench_planet_stage4.mjs
 *
 * Калибровочный ансамбль (минимум 30 seed на профиль):
 *   node tools/bench_planet_stage4.mjs --mode=ensemble --seeds=30 \
 *     --preset=earthlike_balanced --output=/tmp/stage4-earthlike.json
 *
 * Пресеты импортируются из TypeScript-модуля контракта, который читает тот же
 * канонический JSON, что Python-контракт и JS-генератор; Python-child_process
 * здесь больше нет. Отдельные поля можно переопределить для калибровки:
 *   --set=continent_variation=1.0 --set=continent_soft_width_cells=3
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { PRESETS as CONTRACT_PRESETS, getPresetGeographyValues } from '../site/shared/planet-generation-contract.ts';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');
const PlanetGeography = require('../site/shared/planet-geography.js');

const PREFERRED_SURFACE_CLASS = {
  earthlike_balanced: 'terrestrial',
  earthlike_archipelago: 'terrestrial',
  ocean_world: 'ocean',
  desert_dry: 'desert',
  ice_world: 'ice',
  volcanic_active: 'volcanic',
  barren_moon: 'barren',
  gas_giant_bands: 'gas_giant',
};

function parseArgs(argv) {
  const result = {
    mode: 'gate',
    v: 128,
    seeds: 5,
    seedStart: 0,
    preset: 'earthlike_balanced',
    radiusKm: 6371,
    surfaceClass: null,
    output: null,
    overrides: {},
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`Неизвестный аргумент: ${arg}`);
    const [, name, raw] = m;
    if (name === 'mode') result.mode = raw;
    else if (name === 'v') result.v = Number(raw);
    else if (name === 'seeds') result.seeds = Number(raw);
    else if (name === 'seed-start') result.seedStart = Number(raw);
    else if (name === 'preset') result.preset = raw;
    else if (name === 'radius-km') result.radiusKm = Number(raw);
    else if (name === 'surface-class') result.surfaceClass = raw;
    else if (name === 'output') result.output = raw;
    else if (name === 'set') {
      const eq = raw.indexOf('=');
      if (eq <= 0) throw new Error(`Ожидался --set=поле=значение, получено: ${arg}`);
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      result.overrides[key] = Number.isFinite(Number(value)) && value.trim() !== '' ? Number(value) : value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  if (!['gate', 'ensemble'].includes(result.mode)) throw new Error('--mode: gate|ensemble');
  if (!Number.isInteger(result.v) || result.v < 1) throw new Error('--v должно быть целым >= 1');
  if (!Number.isInteger(result.seeds) || result.seeds < 1 || result.seeds > 1000) throw new Error('--seeds: 1..1000');
  if (!Number.isInteger(result.seedStart) || result.seedStart < 0) throw new Error('--seed-start должно быть целым >= 0');
  if (!(result.radiusKm > 0)) throw new Error('--radius-km должно быть > 0');
  if (result.mode === 'ensemble' && result.seeds < 30) {
    throw new Error('Калибровочный ансамбль Этапа 4 требует минимум 30 seed');
  }
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

function seedFor(presetId, index) {
  return createHash('sha256')
    .update(`planet-stage4-calibration-v1|${presetId}|${index}`)
    .digest('hex')
    .slice(0, 16);
}

function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function distribution(values) {
  const sorted = sortedCopy(values);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sum: +sum.toFixed(3),
    mean: sorted.length ? +(sum / sorted.length).toFixed(3) : 0,
    min: sorted.length ? +sorted[0].toFixed(3) : 0,
    p10: +quantileSorted(sorted, 0.1).toFixed(3),
    median: +quantileSorted(sorted, 0.5).toFixed(3),
    p90: +quantileSorted(sorted, 0.9).toFixed(3),
    p99: +quantileSorted(sorted, 0.99).toFixed(3),
    max: sorted.length ? +sorted[sorted.length - 1].toFixed(3) : 0,
  };
}

function median(values) {
  return distribution(values).median;
}

function typedGridBytes(grid) {
  let total = 0;
  for (const value of Object.values(grid)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

function axisBandStd(grid, elevation) {
  const binCount = 32;
  const result = {};
  for (let axis = 0; axis < 3; axis++) {
    const weighted = new Float64Array(binCount);
    const weights = new Float64Array(binCount);
    for (let cell = 0; cell < grid.cellCount; cell++) {
      const coord = grid.centers[cell * 3 + axis];
      const bin = Math.min(binCount - 1, Math.max(0, Math.floor((coord + 1) * 0.5 * binCount)));
      weighted[bin] += elevation[cell] * grid.areas[cell];
      weights[bin] += grid.areas[cell];
    }
    let totalWeight = 0;
    let mean = 0;
    const means = [];
    for (let bin = 0; bin < binCount; bin++) {
      if (!weights[bin]) continue;
      const value = weighted[bin] / weights[bin];
      means.push([value, weights[bin]]);
      mean += value * weights[bin];
      totalWeight += weights[bin];
    }
    mean = totalWeight ? mean / totalWeight : 0;
    let variance = 0;
    for (const [value, weight] of means) variance += weight * (value - mean) ** 2;
    result[['x', 'y', 'z'][axis]] = +(totalWeight ? Math.sqrt(variance / totalWeight) : 0).toFixed(6);
  }
  const values = Object.values(result);
  result.maxMinRatio = +(Math.max(...values) / Math.max(1e-12, Math.min(...values))).toFixed(3);
  return result;
}

function summarizeSeed(seedHex, geography, meshMs, geographyMs, gridBytes) {
  const continents = geography.continents;
  const basins = geography.oceanBasins;
  return {
    seed: seedHex,
    meshMs: +meshMs.toFixed(1),
    geographyMs: +geographyMs.toFixed(1),
    totalMs: +(meshMs + geographyMs).toFixed(1),
    typedMemoryMiB: +((gridBytes + PlanetGeography.typedBytesOf(geography)) / 1048576).toFixed(2),
    processRssMiB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    seaLevel: +geography.seaLevel.toFixed(6),
    oceanFractionHard: +geography.stats.oceanFractionHard.toFixed(6),
    oceanAbsError: +Math.abs(
      geography.stats.oceanFractionHard - geography.stats.oceanFractionTarget,
    ).toFixed(6),
    softFractions: geography.stats.softFractions,
    continents: {
      ...geography.stats.continents,
      hardZeroCount: continents.filter((record) => record.hardCellCount === 0).length,
      effectiveUnderOneCount: continents.filter((record) => record.effectiveMassCells < 1).length,
    },
    oceanBasins: {
      ...geography.stats.oceanBasins,
      hardZeroCount: basins.filter((record) => record.hardCellCount === 0).length,
      effectiveUnderOneCount: basins.filter((record) => record.effectiveMassCells < 1).length,
    },
    plates: geography.stats.plates,
    landmasses: geography.stats.landmasses,
    climate: geography.stats.climate,
  };
}

const options = parseArgs(process.argv.slice(2));
const presets = loadPresets();
const preset = presets[options.preset];
if (!preset) throw new Error(`Неизвестный preset: ${options.preset}`);

const surfaceClass = options.surfaceClass || PREFERRED_SURFACE_CLASS[options.preset] || 'terrestrial';
const seedSummaries = [];
const pooledContinentMasses = [];
const pooledBasinMasses = [];
const pooledDesiredContinentMasses = [];
const pooledDesiredBasinMasses = [];
const axisBands = [];
let allValid = true;
let sharedGrid = null;
let sharedMeshMs = 0;
let sharedGridBytes = 0;

if (options.mode === 'ensemble') {
  const t = performance.now();
  sharedGrid = GeodesicGrid.build(options.v);
  sharedMeshMs = performance.now() - t;
  sharedGridBytes = typedGridBytes(sharedGrid);
}

for (let i = 0; i < options.seeds; i++) {
  const seedIndex = options.seedStart + i;
  const seedHex = seedFor(options.preset, seedIndex);
  let grid = sharedGrid;
  let meshMs = sharedMeshMs;
  let gridBytes = sharedGridBytes;
  if (!grid) {
    const t = performance.now();
    grid = GeodesicGrid.build(options.v);
    meshMs = performance.now() - t;
    gridBytes = typedGridBytes(grid);
  }

  const input = {
    ...preset.values,
    ...options.overrides,
    preset_id: options.preset,
    surface_class: surfaceClass,
    radius_km: options.radiusKm,
    master_seed_hex: seedHex,
    grid_version: grid.gridVersion,
    noise_version: PlanetGeography.NOISE_VERSION,
    geography_version: PlanetGeography.GEOGRAPHY_VERSION,
    preset_version: PlanetGeography.PRESET_VERSION,
  };

  const t = performance.now();
  const geography = PlanetGeography.generateGeography(grid, input);
  const geographyMs = performance.now() - t;
  const validation = PlanetGeography.validateGeography(grid, geography);
  if (!validation.ok) allValid = false;

  const summary = summarizeSeed(seedHex, geography, meshMs, geographyMs, gridBytes);
  summary.seedIndex = seedIndex;
  summary.validationOk = validation.ok;
  summary.validationChecks = validation.checks;
  summary.axisBandElevationStd = geography.surfaceApplicable
    ? axisBandStd(grid, geography.elevation)
    : null;
  seedSummaries.push(summary);
  if (summary.axisBandElevationStd) axisBands.push(summary.axisBandElevationStd);
  for (const record of geography.continents) {
    pooledContinentMasses.push(record.effectiveMassCells);
    pooledDesiredContinentMasses.push(record.desiredMassCells);
  }
  for (const record of geography.oceanBasins) {
    pooledBasinMasses.push(record.effectiveMassCells);
    pooledDesiredBasinMasses.push(record.desiredMassCells);
  }
}

const profile = PlanetGeography.normalizeProfile({
  ...preset.values,
  ...options.overrides,
  preset_id: options.preset,
  surface_class: surfaceClass,
  radius_km: options.radiusKm,
  master_seed_hex: seedFor(options.preset, options.seedStart),
});

const continentPooled = distribution(pooledContinentMasses);
const basinPooled = distribution(pooledBasinMasses);
const totalMedianMs = median(seedSummaries.map((entry) => entry.totalMs));
const geographyMedianMs = median(seedSummaries.map((entry) => entry.geographyMs));
const meshMedianMs = median(seedSummaries.map((entry) => entry.meshMs));
const typedMemoryMaxMiB = Math.max(...seedSummaries.map((entry) => entry.typedMemoryMiB));
const oceanMaxAbsError = Math.max(...seedSummaries.map((entry) => entry.oceanAbsError));
const continentMeanRatio = profile.continentMeanCells > 0 && continentPooled.count
  ? continentPooled.mean / profile.continentMeanCells
  : null;
const basinMeanRatio = profile.oceanBasinMeanCells > 0 && basinPooled.count
  ? basinPooled.mean / profile.oceanBasinMeanCells
  : null;
const continentHardZeroFraction = continentPooled.count
  ? seedSummaries.reduce((sum, entry) => sum + entry.continents.hardZeroCount, 0) / continentPooled.count
  : 0;
const basinHardZeroFraction = basinPooled.count
  ? seedSummaries.reduce((sum, entry) => sum + entry.oceanBasins.hardZeroCount, 0) / basinPooled.count
  : 0;
const climateMinCorrelation = seedSummaries.length
  ? Math.min(...seedSummaries.map((entry) => entry.climate.temperatureInsolationCorrelation))
  : 0;

const checks = {
  validation: allValid,
  medianTotalMsAtMost2000: totalMedianMs <= 2000,
  typedMemoryAtMost64MiB: typedMemoryMaxMiB <= 64,
  oceanAbsErrorAtMost0_01: oceanMaxAbsError <= 0.01,
  continentMeanWithin20Percent: continentMeanRatio === null || (continentMeanRatio >= 0.8 && continentMeanRatio <= 1.25),
  oceanBasinMeanWithin20Percent: basinMeanRatio === null || (basinMeanRatio >= 0.8 && basinMeanRatio <= 1.25),
  continentHardZeroFractionAtMost1Percent: continentHardZeroFraction <= 0.01,
  oceanBasinHardZeroFractionAtMost1Percent: basinHardZeroFraction <= 0.01,
  climateCorrelationAbove0_5: surfaceClass === 'gas_giant' || surfaceClass === 'no_surface' || climateMinCorrelation > 0.5,
};

function aggregatePerSeed(path) {
  const values = seedSummaries.map((entry) => path.split('.').reduce((value, key) => value?.[key], entry));
  return distribution(values.filter((value) => Number.isFinite(value)));
}

const result = {
  mode: options.mode,
  preset: options.preset,
  surfaceClass,
  v: options.v,
  cells: GeodesicGrid.cellCountForFrequency(options.v),
  radiusKm: options.radiusKm,
  expectedFrequency: PlanetGeography.expectedFrequency(options.radiusKm),
  seedCount: options.seeds,
  seedStart: options.seedStart,
  versions: {
    grid: GeodesicGrid.GRID_VERSION || 'goldberg-gp-v1',
    noise: PlanetGeography.NOISE_VERSION,
    geography: PlanetGeography.GEOGRAPHY_VERSION,
    presets: PlanetGeography.PRESET_VERSION,
  },
  profile,
  timingMs: {
    meshMedian: meshMedianMs,
    geographyMedian: geographyMedianMs,
    totalMedian: totalMedianMs,
    totalDistribution: distribution(seedSummaries.map((entry) => entry.totalMs)),
    meshBuildsSharedInEnsemble: options.mode === 'ensemble',
  },
  memory: {
    typedGridPlusGeographyMaxMiB: typedMemoryMaxMiB,
    processRssMaxMiB: Math.max(...seedSummaries.map((entry) => entry.processRssMiB)),
  },
  ocean: {
    targetFraction: profile.oceanPctl / 100,
    hardDistribution: aggregatePerSeed('oceanFractionHard'),
    maxAbsError: +oceanMaxAbsError.toFixed(6),
    softLandDistribution: aggregatePerSeed('softFractions.land'),
    softShelfDistribution: aggregatePerSeed('softFractions.shelf'),
    softOceanDistribution: aggregatePerSeed('softFractions.ocean'),
  },
  continents: {
    targetMeanCells: profile.continentMeanCells,
    pooledEffectiveMass: continentPooled,
    pooledDesiredMass: distribution(pooledDesiredContinentMasses),
    meanRatio: continentMeanRatio === null ? null : +continentMeanRatio.toFixed(4),
    hardZeroFraction: +continentHardZeroFraction.toFixed(5),
    perSeedMedianMass: aggregatePerSeed('continents.distribution.median'),
    perSeedP90Mass: aggregatePerSeed('continents.distribution.p90'),
    coreSupportFraction: aggregatePerSeed('continents.coreSupportFraction'),
    transitionSupportFraction: aggregatePerSeed('continents.transitionSupportFraction'),
    meanEntropy: aggregatePerSeed('continents.meanEntropy'),
  },
  oceanBasins: {
    targetMeanCells: profile.oceanBasinMeanCells,
    pooledEffectiveMass: basinPooled,
    pooledDesiredMass: distribution(pooledDesiredBasinMasses),
    meanRatio: basinMeanRatio === null ? null : +basinMeanRatio.toFixed(4),
    hardZeroFraction: +basinHardZeroFraction.toFixed(5),
    perSeedMedianMass: aggregatePerSeed('oceanBasins.distribution.median'),
    perSeedP90Mass: aggregatePerSeed('oceanBasins.distribution.p90'),
  },
  landmassesByThreshold: [0, 1, 2].map((index) => ({
    threshold: seedSummaries[0]?.landmasses[index]?.threshold ?? null,
    count: distribution(seedSummaries.map((entry) => entry.landmasses[index]?.count).filter(Number.isFinite)),
    medianCells: distribution(seedSummaries.map((entry) => entry.landmasses[index]?.medianCells).filter(Number.isFinite)),
    maxCells: distribution(seedSummaries.map((entry) => entry.landmasses[index]?.maxCells).filter(Number.isFinite)),
    largestShare: distribution(seedSummaries.map((entry) => entry.landmasses[index]?.largestShare).filter(Number.isFinite)),
    tinyIslandsUnder5: distribution(seedSummaries.map((entry) => entry.landmasses[index]?.tinyIslandsUnder5).filter(Number.isFinite)),
  })),
  climate: {
    equatorTemperature: aggregatePerSeed('climate.equatorTemperature'),
    polarTemperature: aggregatePerSeed('climate.polarTemperature'),
    temperatureInsolationCorrelation: aggregatePerSeed('climate.temperatureInsolationCorrelation'),
    minCorrelation: +climateMinCorrelation.toFixed(4),
  },
  axisBandElevationStd: {
    x: distribution(axisBands.map((entry) => entry.x)),
    y: distribution(axisBands.map((entry) => entry.y)),
    z: distribution(axisBands.map((entry) => entry.z)),
    maxMinRatio: distribution(axisBands.map((entry) => entry.maxMinRatio)),
  },
  checks,
  seeds: seedSummaries,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (options.output) writeFileSync(options.output, serialized, 'utf8');
process.stdout.write(serialized);

const hardChecks = options.mode === 'gate'
  ? Object.values(checks)
  : [checks.validation, checks.oceanAbsErrorAtMost0_01, checks.typedMemoryAtMost64MiB];
if (!hardChecks.every(Boolean)) process.exitCode = 1;
