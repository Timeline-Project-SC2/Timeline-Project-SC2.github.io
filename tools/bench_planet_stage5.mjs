#!/usr/bin/env node
/* Bench и статистическая калибровка Этапа 5: гидрология + биомы.
 *
 * Гейт G3 по умолчанию (каноническая Земля, v=128, 5 seed):
 *   node tools/bench_planet_stage5.mjs
 *
 * Калибровочный ансамбль (минимум 30 seed на профиль):
 *   node tools/bench_planet_stage5.mjs --mode=ensemble --seeds=30 \
 *     --preset=earthlike_balanced --output=/tmp/stage5-earthlike.json
 *
 * Пресеты импортируются из TypeScript-модуля контракта — того же канонического
 * JSON, что читают Python-контракт и JS-генератор; Python-child_process здесь
 * больше нет. Отдельные поля можно переопределить для калибровки:
 *   --set=drainage_mean_cells=72 --set=biome_soft_width_cells=2
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
    throw new Error('Калибровочный ансамбль Этапа 5 требует минимум 30 seed');
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
    .update(`planet-stage5-calibration-v1|${presetId}|${index}`)
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

function round(value, digits = 4) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function distribution(values) {
  const sorted = sortedCopy(values.filter(Number.isFinite));
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sum: round(sum, 3),
    mean: sorted.length ? round(sum / sorted.length, 4) : 0,
    min: sorted.length ? round(sorted[0]) : 0,
    p10: round(quantileSorted(sorted, 0.1)),
    median: round(quantileSorted(sorted, 0.5)),
    p90: round(quantileSorted(sorted, 0.9)),
    p99: round(quantileSorted(sorted, 0.99)),
    max: sorted.length ? round(sorted[sorted.length - 1]) : 0,
  };
}

function median(values) {
  return distribution(values).median;
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

function derivedHydrologyMetrics(grid, surface) {
  let deltaMinCoastDistance = null;
  let deltaMaxCoastDistance = null;
  let majorEdges = 0;
  let majorUphillEdges = 0;
  let majorUphillOutsideDepressions = 0;
  let filledUphillEdges = 0;
  let landToLandEdges = 0;
  const majorThreshold = surface.thresholds.majorRiverFlowKm2 || 0;
  for (let c = 0; c < grid.cellCount; c++) {
    if (surface.deltaWeight[c] >= 0.25) {
      const distance = surface.signedCoastDistanceCells[c];
      deltaMinCoastDistance = deltaMinCoastDistance === null ? distance : Math.min(deltaMinCoastDistance, distance);
      deltaMaxCoastDistance = deltaMaxCoastDistance === null ? distance : Math.max(deltaMaxCoastDistance, distance);
    }
    if (surface.catchmentId[c] < 0) continue;
    const receiver = surface.flowReceiver[c];
    if (receiver < 0 || surface.catchmentId[receiver] < 0) continue;
    landToLandEdges++;
    if (surface.filledElevation[receiver] > surface.filledElevation[c] + 1e-9) filledUphillEdges++;
    if (surface.flowAccumulationKm2[c] >= majorThreshold) {
      majorEdges++;
      if (surface.elevation[receiver] > surface.elevation[c] + 1e-9) {
        majorUphillEdges++;
        if (surface.depressionDepth[c] <= 1e-9 && surface.lakeWeight[c] <= 0) {
          majorUphillOutsideDepressions++;
        }
      }
    }
  }
  return {
    deltaMinCoastDistanceCells: deltaMinCoastDistance,
    deltaMaxCoastDistanceCells: deltaMaxCoastDistance,
    majorRiverUphillRawEdgeFraction: majorEdges ? round(majorUphillEdges / majorEdges, 6) : 0,
    majorRiverUphillRawOutsideDepressionsFraction: majorEdges
      ? round(majorUphillOutsideDepressions / majorEdges, 6) : 0,
    filledUphillEdgeFraction: landToLandEdges ? round(filledUphillEdges / landToLandEdges, 6) : 0,
  };
}

function summarizeSeed(seedHex, grid, surface, meshMs, surfaceMs, gridBytes) {
  const hydrology = surface.stats.hydrology;
  const terminal = hydrology.terminalLandAreaFractions;
  const terminalSum = terminal.ocean + terminal.terminalLake + terminal.endorheic;
  return {
    seed: seedHex,
    meshMs: round(meshMs, 1),
    surfaceMs: round(surfaceMs, 1),
    totalMs: round(meshMs + surfaceMs, 1),
    typedMemoryMiB: round((gridBytes + PlanetSurface.typedBytesOf(surface)) / 1048576, 2),
    processRssMiB: round(process.memoryUsage().rss / 1048576, 1),
    thresholds: surface.thresholds,
    hydrology: {
      ...hydrology,
      terminalFractionSumError: round(Math.abs(terminalSum - (hydrology.landCells ? 1 : 0)), 8),
      derived: derivedHydrologyMetrics(grid, surface),
    },
    mountains: surface.stats.mountains,
    biomes: surface.stats.biomes,
  };
}

const options = parseArgs(process.argv.slice(2));
const presets = loadPresets();
const preset = presets[options.preset];
if (!preset) throw new Error(`Неизвестный preset: ${options.preset}`);

const surfaceClass = options.surfaceClass || PREFERRED_SURFACE_CLASS[options.preset] || 'terrestrial';
const seedSummaries = [];
const pooledCatchmentSizes = [];
const pooledDrainageRegionSizes = [];
const pooledLakeAreasKm2 = [];
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
    geography_version: PlanetSurface.GEOGRAPHY_VERSION,
    preset_version: PlanetGeography.PRESET_VERSION,
  };

  const t = performance.now();
  const surface = PlanetSurface.generateSurface(grid, input);
  const surfaceMs = performance.now() - t;
  const validation = PlanetSurface.validateSurface(grid, surface);
  if (!validation.ok) allValid = false;

  const summary = summarizeSeed(seedHex, grid, surface, meshMs, surfaceMs, gridBytes);
  summary.seedIndex = seedIndex;
  summary.validationOk = validation.ok;
  summary.validationChecks = validation.checks;
  seedSummaries.push(summary);
  for (const record of surface.catchments) pooledCatchmentSizes.push(record.cellCount);
  for (const record of surface.drainageRegions) pooledDrainageRegionSizes.push(record.cellCount);
  for (const record of surface.lakes) pooledLakeAreasKm2.push(record.effectiveAreaKm2);
}

const profile = PlanetSurface.normalizeSurfaceProfile({
  ...preset.values,
  ...options.overrides,
  preset_id: options.preset,
  surface_class: surfaceClass,
  radius_km: options.radiusKm,
  master_seed_hex: seedFor(options.preset, options.seedStart),
});

const catchmentPooled = distribution(pooledCatchmentSizes);
const drainagePooled = distribution(pooledDrainageRegionSizes);
const drainageMeanRatio = profile.drainageMeanCells > 0 && drainagePooled.count
  ? drainagePooled.mean / profile.drainageMeanCells
  : null;
const totalMedianMs = median(seedSummaries.map((entry) => entry.totalMs));
const surfaceMedianMs = median(seedSummaries.map((entry) => entry.surfaceMs));
const meshMedianMs = median(seedSummaries.map((entry) => entry.meshMs));
const typedMemoryMaxMiB = Math.max(...seedSummaries.map((entry) => entry.typedMemoryMiB));
const routedMin = Math.min(...seedSummaries.map((entry) => entry.hydrology.routedLandFraction));
const cycleBreakTotal = seedSummaries.reduce((sum, entry) => sum + entry.hydrology.cycleBreakCount, 0);
const terminalMaxSumError = Math.max(...seedSummaries.map((entry) => entry.hydrology.terminalFractionSumError));
const uphillFilledMax = Math.max(...seedSummaries.map((entry) => entry.hydrology.derived.filledUphillEdgeFraction));
const uphillMax = Math.max(...seedSummaries.map((entry) => entry.hydrology.uphillRawEdgeFractionOutsideDepressions));
const majorUphillMax = Math.max(...seedSummaries.map(
  (entry) => entry.hydrology.derived.majorRiverUphillRawOutsideDepressionsFraction));
const deltaDistancesValid = seedSummaries.every((entry) => {
  const derived = entry.hydrology.derived;
  return derived.deltaMinCoastDistanceCells === null ||
    (derived.deltaMinCoastDistanceCells >= -3 && derived.deltaMaxCoastDistanceCells <= 2);
});
const streamFractions = seedSummaries.map((entry) => entry.hydrology.flow.streamLandCellFraction);
const majorFractions = seedSummaries.map((entry) => entry.hydrology.flow.majorRiverLandCellFraction);
const expectedStreamFraction = Math.max(0, (100 - profile.streamFlowPctl) / 100);
const expectedMajorFraction = Math.max(0, (100 - profile.majorRiverFlowPctl) / 100);
const biomeGlobalSums = seedSummaries.map((entry) =>
  entry.biomes.fractions.reduce((sum, item) => sum + item.globalAreaFraction, 0));
const noSurface = surfaceClass === 'gas_giant' || surfaceClass === 'no_surface';

const checks = {
  validation: allValid,
  medianTotalMsAtMost4000: totalMedianMs <= 4000,
  typedMemoryAtMost64MiB: typedMemoryMaxMiB <= 64,
  routedLandFractionIsOne: noSurface || routedMin >= 0.999999,
  flowCycleBreaksZero: cycleBreakTotal === 0,
  terminalFractionsSumToOne: terminalMaxSumError <= 1e-6,
  drainageRegionMeanWithin25Percent: noSurface || drainageMeanRatio === null ||
    (drainageMeanRatio >= 0.75 && drainageMeanRatio <= 1.25),
  uphillFilledEdgesZero: uphillFilledMax === 0,
  uphillRawOutsideDepressionsAtMost0_1Percent: uphillMax <= 0.001,
  majorRiverUphillRawOutsideDepressionsAtMost1Percent: majorUphillMax <= 0.01,
  deltasOnlyNearCoast: deltaDistancesValid,
  streamFractionNearProfilePercentile: noSurface || streamFractions.every(
    (v) => Math.abs(v - expectedStreamFraction) <= 0.02),
  majorRiverFractionNearProfilePercentile: noSurface || majorFractions.every(
    (v) => Math.abs(v - expectedMajorFraction) <= 0.005),
  biomeFractionsSumToOne: noSurface || biomeGlobalSums.every((v) => Math.abs(v - 1) <= 1e-5),
  biomeEntropyMeanAtLeast0_15: noSurface || seedSummaries.every((entry) => entry.biomes.meanEntropy >= 0.15),
  mountainSeamsPresent: noSurface || seedSummaries.every((entry) => entry.mountains.seamAreaFraction > 0),
  mountainRangesPresent: noSurface || options.mode !== 'gate' ||
    seedSummaries.every((entry) => entry.mountains.rangeCount > 0),
};

function aggregatePerSeed(path) {
  const values = seedSummaries.map((entry) => path.split('.').reduce((value, key) => value?.[key], entry));
  return distribution(values.filter((value) => Number.isFinite(value)));
}

const biomeAggregate = PlanetSurface.BIOME_DEFINITIONS.map((definition, index) => ({
  id: definition.id,
  key: definition.key,
  globalAreaFraction: distribution(seedSummaries.map(
    (entry) => entry.biomes.fractions[index]?.globalAreaFraction)),
  landAreaFraction: distribution(seedSummaries.map(
    (entry) => entry.biomes.fractions[index]?.landAreaFraction)),
  top1AreaFraction: distribution(seedSummaries.map(
    (entry) => entry.biomes.fractions[index]?.top1AreaFraction)),
}));

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
    baseGeography: PlanetSurface.BASE_GEOGRAPHY_VERSION,
    geography: PlanetSurface.GEOGRAPHY_VERSION,
    hydrology: PlanetSurface.HYDROLOGY_VERSION,
    biomes: PlanetSurface.BIOME_VERSION,
    presets: PlanetGeography.PRESET_VERSION,
  },
  profile,
  timingMs: {
    meshMedian: meshMedianMs,
    surfaceMedian: surfaceMedianMs,
    totalMedian: totalMedianMs,
    surfaceDistribution: distribution(seedSummaries.map((entry) => entry.surfaceMs)),
    totalDistribution: distribution(seedSummaries.map((entry) => entry.totalMs)),
    meshBuildsSharedInEnsemble: options.mode === 'ensemble',
  },
  memory: {
    typedGridPlusSurfaceMaxMiB: typedMemoryMaxMiB,
    processRssMaxMiB: Math.max(...seedSummaries.map((entry) => entry.processRssMiB)),
  },
  hydrology: {
    landCells: aggregatePerSeed('hydrology.landCells'),
    routedLandFractionMin: routedMin,
    cycleBreakTotal,
    terminal: {
      ocean: aggregatePerSeed('hydrology.terminalLandAreaFractions.ocean'),
      terminalLake: aggregatePerSeed('hydrology.terminalLandAreaFractions.terminalLake'),
      endorheic: aggregatePerSeed('hydrology.terminalLandAreaFractions.endorheic'),
      maxSumError: terminalMaxSumError,
    },
    depression: {
      componentCount: aggregatePerSeed('hydrology.depression.componentCount'),
      landAreaFraction: aggregatePerSeed('hydrology.depression.landAreaFraction'),
    },
    lakes: {
      count: aggregatePerSeed('hydrology.lakes.count'),
      landAreaFraction: aggregatePerSeed('hydrology.lakes.landAreaFraction'),
      pooledEffectiveAreaKm2: distribution(pooledLakeAreasKm2),
    },
    strictCatchments: {
      note: 'Терминальные водосборы фактического дерева стока; drainage_mean_cells к ним не применяется.',
      pooledCellCount: catchmentPooled,
      perSeedCount: aggregatePerSeed('hydrology.catchments.distribution.count'),
    },
    drainageRegions: {
      note: 'Целевой масштаб drainage_mean_cells: сегментация дерева стока внутри физических массивов суши.',
      targetMeanCells: profile.drainageMeanCells,
      pooledCellCount: drainagePooled,
      meanRatio: drainageMeanRatio === null ? null : round(drainageMeanRatio),
      perSeedCount: aggregatePerSeed('hydrology.drainageRegions.distribution.count'),
    },
    flow: {
      streamThresholdKm2: aggregatePerSeed('hydrology.flow.streamThresholdKm2'),
      majorRiverThresholdKm2: aggregatePerSeed('hydrology.flow.majorRiverThresholdKm2'),
      streamLandCellFraction: distribution(streamFractions),
      expectedStreamLandFractionFromPercentile: expectedStreamFraction,
      majorRiverLandCellFraction: distribution(majorFractions),
      expectedMajorRiverLandFractionFromPercentile: expectedMajorFraction,
      maxAccumulationKm2: aggregatePerSeed('hydrology.flow.maxAccumulationKm2'),
      uphillFilledEdgeFraction: aggregatePerSeed('hydrology.derived.filledUphillEdgeFraction'),
      uphillRawEdgeFractionOutsideDepressions: aggregatePerSeed(
        'hydrology.uphillRawEdgeFractionOutsideDepressions'),
      majorRiverUphillRawEdgeFraction: aggregatePerSeed(
        'hydrology.derived.majorRiverUphillRawEdgeFraction'),
      majorRiverUphillRawOutsideDepressionsFraction: aggregatePerSeed(
        'hydrology.derived.majorRiverUphillRawOutsideDepressionsFraction'),
    },
    deltas: {
      cellsAtWeight025: aggregatePerSeed('hydrology.deltaCellsAtWeight025'),
      minCoastDistanceCells: aggregatePerSeed('hydrology.derived.deltaMinCoastDistanceCells'),
      maxCoastDistanceCells: aggregatePerSeed('hydrology.derived.deltaMaxCoastDistanceCells'),
    },
  },
  mountains: {
    rangeCount: aggregatePerSeed('mountains.rangeCount'),
    mountainAreaFraction: aggregatePerSeed('mountains.mountainAreaFraction'),
    seamAreaFraction: aggregatePerSeed('mountains.seamAreaFraction'),
  },
  biomes: {
    meanEntropy: aggregatePerSeed('biomes.meanEntropy'),
    fractions: biomeAggregate,
  },
  checks,
  seeds: seedSummaries,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (options.output) writeFileSync(options.output, serialized, 'utf8');
process.stdout.write(serialized);

const hardChecks = options.mode === 'gate'
  ? Object.values(checks)
  : [
      checks.validation,
      checks.typedMemoryAtMost64MiB,
      checks.routedLandFractionIsOne,
      checks.flowCycleBreaksZero,
      checks.uphillFilledEdgesZero,
      checks.terminalFractionsSumToOne,
    ];
if (!hardChecks.every(Boolean)) process.exitCode = 1;
