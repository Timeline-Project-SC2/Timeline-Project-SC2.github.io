#!/usr/bin/env node
/* W28a — воспроизводимые измерения морской стороны c100-soft-v2.
 *
 * Запуск: node tools/analysis/ocean_side.mjs
 * Все TypeScript-модули загружаются через createRequire и абсолютные пути.
 * Скрипт ничего не меняет в продукте: генерирует v=128 и v=64, измеряет
 * батиметрию и 40 детерминированно выбранных локальных пятен 5 × 5 км.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const loadTs = (relativePath) => require(resolve(ROOT, relativePath));

const GeodesicGrid = loadTs('site/shared/geodesic-grid.ts').default;
const PlanetGeography = loadTs('site/shared/planet-geography.ts').default;
const PlanetSurface = loadTs('site/shared/planet-surface.ts').default;
const Contract = loadTs('src/local-map/local-map-contract.ts');
const Heightfield = loadTs('src/local-map/local-map-heightfield.ts');

const PROFILE = Object.freeze({
  masterSeedHex: 'a29a29a29a29a29a',
  oceanPctl: 90,
  shelfBelowPctl: 87,
  shelfAbovePctl: 93,
});
const FREQUENCIES = [128, 64];
const K = 8570;
const EARTH_MEAN_OCEAN_DEPTH_M = 3700;
const EARTH_MAX_OCEAN_DEPTH_M = 10994;
const CLAMP_DEPTH_UNITS = 0.035;
const EXPANDED_OCEAN_MIN_ELEVATION = -1;
const PATCH_WIDTH_M = 5000;
const PATCH_RADIUS_M = PATCH_WIDTH_M / 2;
const LOCAL_SAMPLE_COUNT = 40;
const LOCAL_STEPS = 64;
const LOCAL_NODES = LOCAL_STEPS + 1;
const OCEAN_RELIEF_GATE_PCT = 1;

function fixed(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const safe = Object.is(value, -0) ? 0 : value;
  return safe.toFixed(digits);
}

function sumBy(rows, key) {
  let sum = 0;
  for (const row of rows) sum += row[key];
  return sum;
}

function weightedQuantile(rows, q) {
  if (!rows.length) return NaN;
  const sorted = [...rows].sort((a, b) => a.depth - b.depth || a.cell - b.cell);
  if (q <= 0) return sorted[0].depth;
  const totalWeight = sumBy(sorted, 'area');
  const target = q * totalWeight;
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.area;
    if (cumulative >= target) return row.depth;
  }
  return sorted[sorted.length - 1].depth;
}

function distribution(rows) {
  if (!rows.length) throw new Error('Океанская выборка пуста');
  const area = sumBy(rows, 'area');
  let weightedDepth = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    weightedDepth += row.depth * row.area;
    min = Math.min(min, row.depth);
    max = Math.max(max, row.depth);
  }
  return {
    cells: rows.length,
    areaFraction: null,
    meanUnits: weightedDepth / area,
    p1Units: weightedQuantile(rows, 0.01),
    p10Units: weightedQuantile(rows, 0.10),
    p50Units: weightedQuantile(rows, 0.50),
    p90Units: weightedQuantile(rows, 0.90),
    p99Units: weightedQuantile(rows, 0.99),
    minUnits: min,
    maxUnits: max,
    area,
  };
}

function makeOceanRows(grid, surface) {
  const rows = [];
  let totalArea = 0;
  let totalCells = 0;
  for (let cell = 0; cell < grid.cellCount; cell++) {
    const area = grid.areas[cell];
    totalArea += area;
    totalCells++;
    // Как и PlanetSurface: суша — строго elev > seaLevel; ячейка на уровне
    // моря относится к hard-ocean-части поверхности (d = 0).
    if (surface.elevation[cell] <= surface.seaLevel) {
      rows.push({
        cell,
        depth: surface.seaLevel - surface.elevation[cell],
        area,
      });
    }
  }
  const stats = distribution(rows);
  stats.areaFraction = sumBy(rows, 'area') / totalArea;
  stats.cellFraction = rows.length / totalCells;
  return { rows, stats, totalArea, totalCells };
}

function openOceanRows(grid, surface) {
  const rows = [];
  for (let cell = 0; cell < grid.cellCount; cell++) {
    // Согласовано с локальной картой: открытое море — elev < seaLevel,
    // без зеркал континентальных озёр.
    if (surface.elevation[cell] >= surface.seaLevel || surface.lakeWeight[cell] > 0) continue;
    rows.push({
      cell,
      depth: surface.seaLevel - surface.elevation[cell],
      area: grid.areas[cell],
    });
  }
  return rows;
}

function globalMetrics(grid, surface) {
  const ocean = makeOceanRows(grid, surface);
  const open = openOceanRows(grid, surface);
  const openArea = sumBy(open, 'area');
  let clampCells = 0;
  let clampArea = 0;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let clampMinDepth = Infinity;
  for (const row of open) {
    minDepth = Math.min(minDepth, row.depth);
    maxDepth = Math.max(maxDepth, row.depth);
    const clampedDepth = Math.max(row.depth, CLAMP_DEPTH_UNITS);
    clampMinDepth = Math.min(clampMinDepth, clampedDepth);
    if (row.depth < CLAMP_DEPTH_UNITS) {
      clampCells++;
      clampArea += row.area;
    }
  }
  const rawRangeUnits = maxDepth - minDepth;
  const clampedRangeUnits = maxDepth - clampMinDepth;
  const d = ocean.stats;
  const meanTargetK = EARTH_MEAN_OCEAN_DEPTH_M / d.meanUnits;
  const maxTargetK = EARTH_MAX_OCEAN_DEPTH_M / d.maxUnits;
  const predictedMeanM = d.meanUnits * K;
  const predictedMaxM = d.maxUnits * K;
  const targetDepthAtMinusOneUnits = surface.seaLevel - EXPANDED_OCEAN_MIN_ELEVATION;
  const observedOpenOceanMaxUnits = maxDepth;
  const expandedFactor = targetDepthAtMinusOneUnits / observedOpenOceanMaxUnits;
  let expandedClampedWeightedDepth = 0;
  for (const row of ocean.rows) {
    const expandedDepth = Math.min(
      targetDepthAtMinusOneUnits,
      Math.max(row.depth * expandedFactor, CLAMP_DEPTH_UNITS),
    );
    expandedClampedWeightedDepth += expandedDepth * row.area;
  }
  const expandedClampedMeanUnits = expandedClampedWeightedDepth / sumBy(ocean.rows, 'area');

  return {
    frequency: grid.v,
    cells: grid.cellCount,
    seaLevel: fixed(surface.seaLevel),
    ocean: {
      cells: d.cells,
      areaFraction: fixed(d.areaFraction),
      cellFraction: fixed(d.cellFraction),
      meanUnits: fixed(d.meanUnits),
      p1Units: fixed(d.p1Units),
      p10Units: fixed(d.p10Units),
      p50Units: fixed(d.p50Units),
      p90Units: fixed(d.p90Units),
      p99Units: fixed(d.p99Units),
      minUnits: fixed(d.minUnits),
      maxUnits: fixed(d.maxUnits),
      meanMetersAtK: fixed(d.meanUnits * K, 2),
      p10MetersAtK: fixed(d.p10Units * K, 2),
      p50MetersAtK: fixed(d.p50Units * K, 2),
      p90MetersAtK: fixed(d.p90Units * K, 2),
      p99MetersAtK: fixed(d.p99Units * K, 2),
      minMetersAtK: fixed(d.minUnits * K, 2),
      maxMetersAtK: fixed(d.maxUnits * K, 2),
      earthMeanMeters: fixed(EARTH_MEAN_OCEAN_DEPTH_M, 2),
      earthMaxMeters: fixed(EARTH_MAX_OCEAN_DEPTH_M, 2),
    },
    KFit: {
      meanTargetMeters: fixed(EARTH_MEAN_OCEAN_DEPTH_M, 2),
      KForMean: fixed(meanTargetK, 2),
      meanAtChosenK: fixed(predictedMeanM, 2),
      meanErrorPctAtChosenK: fixed((predictedMeanM / EARTH_MEAN_OCEAN_DEPTH_M - 1) * 100, 4),
      maxTargetMeters: fixed(EARTH_MAX_OCEAN_DEPTH_M, 2),
      KForMax: fixed(maxTargetK, 2),
      maxAtChosenK: fixed(predictedMaxM, 2),
      maxErrorPctAtChosenK: fixed((predictedMaxM / EARTH_MAX_OCEAN_DEPTH_M - 1) * 100, 4),
      KMaxVsKMeanPct: fixed((maxTargetK / meanTargetK - 1) * 100, 4),
    },
    clamp: {
      openOceanCells: open.length,
      thresholdUnits: fixed(CLAMP_DEPTH_UNITS),
      thresholdMetersAtK: fixed(CLAMP_DEPTH_UNITS * K, 2),
      affectedCells: clampCells,
      affectedCellFraction: fixed(clampCells / open.length),
      affectedAreaFractionOfOpenOcean: fixed(clampArea / openArea),
      rawMinDepthUnits: fixed(minDepth),
      rawMaxDepthUnits: fixed(maxDepth),
      rawBottomRangeUnits: fixed(rawRangeUnits),
      rawBottomRangeMetersAtK: fixed(rawRangeUnits * K, 2),
      clampedMinDepthUnits: fixed(clampMinDepth),
      clampedBottomRangeUnits: fixed(clampedRangeUnits),
      clampedBottomRangeMetersAtK: fixed(clampedRangeUnits * K, 2),
      rangeLossFromClampMetersAtK: fixed((rawRangeUnits - clampedRangeUnits) * K, 2),
    },
    oceanRangeToMinusOne: {
      targetMinimumElevation: fixed(EXPANDED_OCEAN_MIN_ELEVATION),
      targetMaxDepthUnits: fixed(targetDepthAtMinusOneUnits),
      targetMaxDepthMetersAtK: fixed(targetDepthAtMinusOneUnits * K, 2),
      observedOpenOceanMaxDepthUnits: fixed(observedOpenOceanMaxUnits),
      localDepthExpansionFactor: fixed(expandedFactor, 8),
      expandedMeanDepthWithoutFloorMetersAtK: fixed(d.meanUnits * expandedFactor * K, 2),
      expandedMeanWithoutFloorErrorPctAtK: fixed(((d.meanUnits * expandedFactor * K) / EARTH_MEAN_OCEAN_DEPTH_M - 1) * 100, 4),
      expandedMeanDepthWithFloorMetersAtK: fixed(expandedClampedMeanUnits * K, 2),
      expandedMeanWithFloorErrorPctAtK: fixed(((expandedClampedMeanUnits * K) / EARTH_MEAN_OCEAN_DEPTH_M - 1) * 100, 4),
      expandedMaxDepthMetersAtK: fixed(Math.min(targetDepthAtMinusOneUnits, d.maxUnits * expandedFactor) * K, 2),
      KForExpandedMeanWithFloor: fixed(EARTH_MEAN_OCEAN_DEPTH_M / expandedClampedMeanUnits, 2),
      KForExpandedMax: fixed(EARTH_MAX_OCEAN_DEPTH_M / Math.min(targetDepthAtMinusOneUnits, d.maxUnits * expandedFactor), 2),
    },
  };
}

function seededRng(tag) {
  const digest = createHash('sha256').update(tag).digest();
  let state = digest.readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function selectRandomUnique(items, count, tag) {
  if (items.length < count) throw new Error(`Недостаточно морских ячеек: ${items.length} < ${count}`);
  const rng = seededRng(tag);
  const pool = [...items];
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function range(values) {
  if (!values.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return max - min;
}

function sampleQuantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const next = sorted[lower + 1];
  return next === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (next - sorted[lower]);
}

function summarizeLocalScenario(samples, key) {
  const values = samples.map((sample) => Number(sample[key]));
  const passed = values.filter((value) => value >= OCEAN_RELIEF_GATE_PCT).length;
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    meanPct: fixed(sum / values.length, 6),
    p10Pct: fixed(sampleQuantile(values, 0.10), 6),
    p50Pct: fixed(sampleQuantile(values, 0.50), 6),
    p90Pct: fixed(sampleQuantile(values, 0.90), 6),
    minPct: fixed(Math.min(...values), 6),
    maxPct: fixed(Math.max(...values), 6),
    passedAtLeastOnePct: passed,
    sampleCount: values.length,
  };
}

function localPatchMetrics(grid, surface, sampler, expansionFactor) {
  const eligibleCells = [];
  for (let cell = 0; cell < grid.cellCount; cell++) {
    if (grid.neighborCount[cell] !== 6) continue;
    if (surface.elevation[cell] >= surface.seaLevel || surface.lakeWeight[cell] > 0) continue;
    eligibleCells.push(cell);
  }
  const selected = selectRandomUnique(
    eligibleCells,
    LOCAL_SAMPLE_COUNT,
    `W28a-ocean-side-v1|${PROFILE.masterSeedHex}|v=${grid.v}|${LOCAL_SAMPLE_COUNT}`,
  );
  const patches = [];
  for (let index = 0; index < selected.length; index++) {
    const centerCell = selected[index];
    const patch = Contract.buildPatch7(grid, surface, centerCell);
    const lattice = Heightfield.sampleDetailLattice(patch, sampler, PATCH_RADIUS_M);
    const fieldElevations = [];
    const noFloorDepths = [];
    const currentClampedDepths = [];
    const expandedClampedDepths = [];

    for (let y = 0; y < LOCAL_NODES; y++) {
      const v = ((y / LOCAL_STEPS) - 0.5) * PATCH_WIDTH_M;
      for (let x = 0; x < LOCAL_NODES; x++) {
        const u = ((x / LOCAL_STEPS) - 0.5) * PATCH_WIDTH_M;
        const direction = Contract.localPointToDirection(patch, u, v);
        const nearestCell = Contract.nearestPatchCell(patch, direction);
        if (nearestCell.elevation >= surface.seaLevel || nearestCell.lakeWeight > 0) continue;

        const rawElevation = lattice.elevation[y * LOCAL_NODES + x];
        fieldElevations.push(rawElevation);
        const depthWithoutFloor = Math.max(0, surface.seaLevel - rawElevation);
        noFloorDepths.push(depthWithoutFloor);
        currentClampedDepths.push(Math.max(depthWithoutFloor, CLAMP_DEPTH_UNITS));
        expandedClampedDepths.push(Math.min(
          surface.seaLevel - EXPANDED_OCEAN_MIN_ELEVATION,
          Math.max(depthWithoutFloor * expansionFactor, CLAMP_DEPTH_UNITS),
        ));
      }
    }
    if (fieldElevations.length === 0) {
      throw new Error(`Пятно ${centerCell} не содержит открытой морской выборки`);
    }

    const rawElevationRangeUnits = range(fieldElevations);
    const noFloorRangeUnits = range(noFloorDepths);
    const currentClampedRangeUnits = range(currentClampedDepths);
    const expandedClampedRangeUnits = range(expandedClampedDepths);
    const pct = (rangeUnits) => rangeUnits * K / PATCH_WIDTH_M * 100;
    const centerDepthUnits = surface.seaLevel - surface.elevation[centerCell];
    patches.push({
      sample: index + 1,
      centerCell,
      centerDepthUnits: fixed(centerDepthUnits),
      centerDepthMetersAtK: fixed(centerDepthUnits * K, 2),
      oceanNodes: fieldElevations.length,
      rawElevationMin: fixed(Math.min(...fieldElevations)),
      rawElevationMax: fixed(Math.max(...fieldElevations)),
      rawElevationRangeUnits: fixed(rawElevationRangeUnits),
      rawElevationRangeMetersAtK: fixed(rawElevationRangeUnits * K, 2),
      rawElevationM9Pct: fixed(pct(rawElevationRangeUnits), 6),
      noFloorM9Pct: fixed(pct(noFloorRangeUnits), 6),
      currentClampM9Pct: fixed(pct(currentClampedRangeUnits), 6),
      expandedToMinusOneM9Pct: fixed(pct(expandedClampedRangeUnits), 6),
      passesCurrentClampGate: pct(currentClampedRangeUnits) >= OCEAN_RELIEF_GATE_PCT,
      passesExpandedGate: pct(expandedClampedRangeUnits) >= OCEAN_RELIEF_GATE_PCT,
    });
  }
  return {
    v: grid.v,
    randomSeedTag: `W28a-ocean-side-v1|${PROFILE.masterSeedHex}|v=${grid.v}|${LOCAL_SAMPLE_COUNT}`,
    eligibleHexOceanCells: eligibleCells.length,
    sampleCount: patches.length,
    patchWidthM: fixed(PATCH_WIDTH_M, 2),
    radiusM: fixed(PATCH_RADIUS_M, 2),
    nodesPerSide: LOCAL_NODES,
    intervalsPerSide: LOCAL_STEPS,
    nodeSpacingM: fixed(PATCH_WIDTH_M / LOCAL_STEPS, 6),
    gateM9Pct: fixed(OCEAN_RELIEF_GATE_PCT, 2),
    expansionFactorToMinusOne: fixed(expansionFactor, 8),
    scenarios: {
      rawElevation: summarizeLocalScenario(patches, 'rawElevationM9Pct'),
      noMinimumDepthClamp: summarizeLocalScenario(patches, 'noFloorM9Pct'),
      currentSeaMinus0035Clamp: summarizeLocalScenario(patches, 'currentClampM9Pct'),
      linearOceanStretchToMinusOne: summarizeLocalScenario(patches, 'expandedToMinusOneM9Pct'),
    },
    patches,
  };
}

function negativeControl(seaLevel, expansionFactor) {
  const flat = new Float32Array(LOCAL_NODES * LOCAL_NODES);
  flat.fill(seaLevel);
  const current = Array.from(flat, (elevation) => Math.min(elevation, seaLevel - CLAMP_DEPTH_UNITS));
  const noFloor = Array.from(flat, (elevation) => Math.max(0, seaLevel - elevation));
  const expanded = Array.from(flat, (elevation) => Math.min(
    seaLevel - EXPANDED_OCEAN_MIN_ELEVATION,
    Math.max(Math.max(0, seaLevel - elevation) * expansionFactor, CLAMP_DEPTH_UNITS),
  ));
  const ranges = {
    rawElevationUnits: range(flat),
    noMinimumDepthClampUnits: range(noFloor),
    currentClampUnits: range(current),
    expandedToMinusOneUnits: range(expanded),
  };
  const passed = Object.values(ranges).every((value) => value === 0);
  if (!passed) throw new Error(`Негативный контроль не пройден: ${JSON.stringify(ranges)}`);
  return {
    status: 'PASS',
    field: `все ${flat.length} высот равны seaLevel=${fixed(seaLevel)}`,
    rangesUnits: Object.fromEntries(Object.entries(ranges).map(([key, value]) => [key, fixed(value)])),
  };
}

function generateAtFrequency(v) {
  const grid = GeodesicGrid.build(v);
  const surface = PlanetSurface.generateSurface(grid, { ...PROFILE });
  if (surface.cellCount !== grid.cellCount) {
    throw new Error(`v=${v}: cellCount поверхности не совпал с сеткой`);
  }
  const metrics = globalMetrics(grid, surface);
  if (Math.abs(surface.stats.oceanFractionHard - Number(metrics.ocean.areaFraction)) > 1e-6) {
    throw new Error(`v=${v}: измеренная доля океана расходится с PlanetGeography`);
  }
  return { grid, surface, metrics };
}

async function main() {
  const generated = new Map();
  for (const v of FREQUENCIES) generated.set(v, generateAtFrequency(v));

  const canonical = generated.get(128);
  // Повторяем адаптацию LocalMapContract.createPatchFieldSampler:
  // профиль поверхности c100-soft-v2 сэмплируется базовой географией c100-soft-v1.
  const samplerProfile = { ...canonical.surface.profile };
  if (samplerProfile.geographyVersion === 'c100-soft-v2') {
    samplerProfile.geographyVersion = PlanetGeography.GEOGRAPHY_VERSION;
  }
  const sampler = PlanetGeography.createFieldSampler(samplerProfile);
  const local = localPatchMetrics(
    canonical.grid,
    canonical.surface,
    sampler,
    Number(canonical.metrics.oceanRangeToMinusOne.localDepthExpansionFactor),
  );
  const control = negativeControl(
    canonical.surface.seaLevel,
    Number(canonical.metrics.oceanRangeToMinusOne.localDepthExpansionFactor),
  );

  const report = {
    schema: 'W28a-ocean-side-report/v1',
    profile: PROFILE,
    constants: {
      K: fixed(K, 2),
      earthMeanOceanDepthM: fixed(EARTH_MEAN_OCEAN_DEPTH_M, 2),
      earthMaximumOceanDepthM: fixed(EARTH_MAX_OCEAN_DEPTH_M, 2),
      clampDepthUnits: fixed(CLAMP_DEPTH_UNITS),
      clampDepthMetersAtK: fixed(CLAMP_DEPTH_UNITS * K, 2),
      expandedOceanMinimumElevation: fixed(EXPANDED_OCEAN_MIN_ELEVATION),
      targetDepthFromSeaToMinusOneAtK: fixed((canonical.surface.seaLevel + 1) * K, 2),
      oceanReliefGatePct: fixed(OCEAN_RELIEF_GATE_PCT, 2),
    },
    global: FREQUENCIES.map((v) => generated.get(v).metrics),
    localCanonicalV128: local,
    negativeControl: control,
  };

  console.log('Негативный контроль: PASS — константное поле даёт нулевой размах во всех сценариях.');
  console.log(JSON.stringify(report, null, 2));
}

await main();
