#!/usr/bin/env node
/* Bench Этапа 8 (Гейт G4): генерация локальной карты Patch7 и 3D-структур на CPU.
 *
 * Что измеряется без браузера:
 *   - построение геодезической сетки GP(v,0) и поверхности c100-soft-v2
 *     (по умолчанию v=64; опция --v=128 для полной канонической Земли);
 *   - отбор репрезентативного ансамбля канонических 6-угольных центров:
 *     сухая равнина (dry_plain), речной узел с притоками (river_junction),
 *     озёрная впадина (lake_basin) и морское побережье (coastline);
 *   - сборка среза 7 канонических ячеек buildPatch7 + verifyPatchInvariants (И-3);
 *   - сборка low-poly библиотеки 12 модулей buildMeshLibrary;
 *   - генерация локального участка generateLocalMap на ступенях видимой ширины
 *     1250 км, 78 км, 10 км и 1.2 км (median, p95, max в мс);
 *   - число 3D-инстансов и строгое соблюдение buildingSpawnMask (И-3.4):
 *     0 инстансов в ячейках растра, где spawnMask === 0.
 *
 * Кадровое время WebGL2 и порционная GPU-догрузка gl.bufferSubData здесь НЕ
 * гейтятся: честный FPS/p95 дают только реальный браузер и целевые устройства.
 *
 *   node tools/bench_local_map_stage8.mjs
 *   node tools/bench_local_map_stage8.mjs --v=128
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { PRESETS: CONTRACT_PRESETS, getPresetGeographyValues } = require('../site/shared/planet-generation-contract.ts');
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetGeography = require('../site/shared/planet-geography.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const LocalMapContract = require('../src/local-map/local-map-contract.ts');
const LocalMapMesh = require('../src/local-map/local-map-mesh.ts');
const LocalMapWorker = require('../src/local-map/local-map-worker.ts');

const PREFERRED_SURFACE_CLASS = {
  earthlike_balanced: 'terrestrial',
  earthlike_archipelago: 'terrestrial',
  ocean_world: 'ocean',
  desert_dry: 'desert',
  ice_world: 'ice',
  volcanic_active: 'volcanic',
  barren_moon: 'barren',
};

const SCALE_STEPS_KM = [1250, 78, 10, 1.2];

const CENTER_ARCHETYPES = [
  { key: 'dry_plain', label: 'сухая равнина' },
  { key: 'river_junction', label: 'речной узел с притоками' },
  { key: 'lake_basin', label: 'озёрная впадина' },
  { key: 'coastline', label: 'побережье' },
];

const EXPECTED_MESH_MODULES = [
  'hab_box',
  'container',
  'comm_mast',
  'factory',
  'silo_tank',
  'pipe_stack',
  'cargo_bay',
  'guard_tower',
  'barrier',
  'radar_dish',
  'hq_center',
  'dome_vault',
];

function parseArgs(argv) {
  const result = {
    v: 64,
    seeds: 3,
    seedStart: 0,
    runs: 3,
    meshRuns: 20,
    preset: 'earthlike_balanced',
    radiusKm: 6371,
    gateMs: 150,
    output: null,
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`Неизвестный аргумент: ${arg}`);
    const [, name, raw] = m;
    if (name === 'v') result.v = Number(raw);
    else if (name === 'seeds') result.seeds = Number(raw);
    else if (name === 'seed-start') result.seedStart = Number(raw);
    else if (name === 'runs') result.runs = Number(raw);
    else if (name === 'mesh-runs') result.meshRuns = Number(raw);
    else if (name === 'preset') result.preset = raw;
    else if (name === 'radius-km') result.radiusKm = Number(raw);
    else if (name === 'gate-ms') result.gateMs = Number(raw);
    else if (name === 'output') result.output = raw;
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  if (!Number.isInteger(result.v) || result.v < 16 || result.v > 256) {
    throw new Error('--v должно быть целым в диапазоне 16..256');
  }
  if (!Number.isInteger(result.seeds) || result.seeds < 1 || result.seeds > 30) {
    throw new Error('--seeds должно быть целым в диапазоне 1..30');
  }
  if (!Number.isInteger(result.runs) || result.runs < 1 || result.runs > 50) {
    throw new Error('--runs должно быть целым в диапазоне 1..50');
  }
  if (!Number.isInteger(result.meshRuns) || result.meshRuns < 1 || result.meshRuns > 200) {
    throw new Error('--mesh-runs должно быть целым в диапазоне 1..200');
  }
  if (!(result.radiusKm > 0)) {
    throw new Error('--radius-km должно быть > 0');
  }
  if (!(result.gateMs > 0)) {
    throw new Error('--gate-ms должно быть > 0');
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

function seedHexFor(tag, index) {
  return createHash('sha256')
    .update(`local-map-stage8-bench-v1|${tag}|${index}`)
    .digest('hex')
    .slice(0, 16);
}

function seedUint32For(seedHex, centerKey, scaleKm, runIndex) {
  const digest = createHash('sha256')
    .update(`local-map-run-v1|${seedHex}|${centerKey}|${scaleKm}|${runIndex}`)
    .digest();
  return digest.readUInt32LE(0);
}

function round(value, digits = 3) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function distribution(values, digits = 3) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? round(sum / sorted.length, digits) : 0,
    min: sorted.length ? round(sorted[0], digits) : 0,
    median: round(quantileSorted(sorted, 0.5), digits),
    p90: round(quantileSorted(sorted, 0.9), digits),
    p95: round(quantileSorted(sorted, 0.95), digits),
    p99: round(quantileSorted(sorted, 0.99), digits),
    max: sorted.length ? round(sorted[sorted.length - 1], digits) : 0,
  };
}

function rssMiB() {
  return round(process.memoryUsage().rss / 1048576, 1);
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

function isCellBuildableOnSurface(surface, cell, rule = LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE) {
  if (surface.elevation[cell] < surface.seaLevel) return false;
  if (surface.lakeWeight[cell] > 0) return false;
  if (surface.streamWeight[cell] > 0) return false;
  if (surface.slope[cell] >= rule.maxSlope) return false;
  if (surface.muLand[cell] < rule.minLand) return false;
  return true;
}

/** Выбор четырёх репрезентативных 6-угольных центров канонической сетки. */
function selectRepresentativeCenters(grid, surface) {
  const rule = LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE;
  let bestDry = -1;
  let bestDryScore = -Infinity;

  let bestRiver = -1;
  let bestRiverScore = -Infinity;

  let bestLake = -1;
  let bestLakeScore = -Infinity;

  let bestCoast = -1;
  let bestCoastScore = -Infinity;

  for (let c = 0; c < grid.cellCount; c++) {
    if (grid.neighborCount[c] !== 6) continue;

    let buildableNeighbors = 0;
    let oceanNeighbors = 0;
    let inletCount = 0;
    let streamInletCount = 0;
    for (let slot = 0; slot < 6; slot++) {
      const nb = grid.neighbors[c * 6 + slot];
      if (nb < 0) continue;
      if (isCellBuildableOnSurface(surface, nb, rule)) buildableNeighbors++;
      if (surface.elevation[nb] < surface.seaLevel) oceanNeighbors++;
      if (surface.flowReceiver[nb] === c) {
        inletCount++;
        if (surface.streamWeight[nb] > 0) streamInletCount++;
      }
    }

    const centerBuildable = isCellBuildableOnSurface(surface, c, rule);

    // 1. Сухая равнина: центр и максимум соседей пригодны к застройке, минимальный уклон.
    if (centerBuildable && oceanNeighbors === 0) {
      const score = buildableNeighbors * 10 + surface.muLand[c] - surface.slope[c] * 5;
      if (score > bestDryScore) {
        bestDryScore = score;
        bestDry = c;
      }
    }

    // 2. Речной узел с притоками: шестиугольник суши с руслом, слиянием речных притоков и выходом стока.
    if (
      surface.streamWeight[c] > 0 &&
      surface.elevation[c] >= surface.seaLevel &&
      surface.lakeWeight[c] <= 0 &&
      inletCount >= 1
    ) {
      const confluenceBonus = streamInletCount >= 2 ? 1e10 : streamInletCount >= 1 ? 1e9 : 0;
      const outletBonus = surface.flowReceiver[c] >= 0 ? 1e8 : 0;
      const bankBonus = buildableNeighbors > 0 ? 1e6 : 0;
      const score =
        confluenceBonus +
        outletBonus +
        bankBonus +
        streamInletCount * 1e5 +
        surface.flowAccumulationKm2[c];
      if (score > bestRiverScore) {
        bestRiverScore = score;
        bestRiver = c;
      }
    }

    // 3. Озёрная впадина: затопленная priority-flood впадина с озером (lakeWeight > 0).
    if (surface.lakeWeight[c] > 0) {
      const floodedBonus = surface.depressionDepth[c] > 1e-6 ? 1e6 : 0;
      const shoreBonus = buildableNeighbors > 0 ? 1e4 : 0;
      const score = floodedBonus + shoreBonus + surface.lakeWeight[c] * 100 + surface.depressionDepth[c] * 10;
      if (score > bestLakeScore) {
        bestLakeScore = score;
        bestLake = c;
      }
    }

    // 4. Побережье: граница суши и океана внутри кольца Patch7.
    if (
      surface.elevation[c] >= surface.seaLevel &&
      surface.lakeWeight[c] <= 0 &&
      oceanNeighbors >= 1 &&
      oceanNeighbors <= 4 &&
      (centerBuildable || buildableNeighbors >= 1)
    ) {
      const balance = 6 - Math.abs(oceanNeighbors - 3);
      const centerBonus = centerBuildable ? 100 : 0;
      const score = centerBonus + balance * 10 + buildableNeighbors;
      if (score > bestCoastScore) {
        bestCoastScore = score;
        bestCoast = c;
      }
    }
  }

  return {
    dry_plain: bestDry,
    river_junction: bestRiver,
    lake_basin: bestLake,
    coastline: bestCoast,
  };
}

/** Проверка библиотеки мешей 12 модулей и замер времени buildMeshLibrary(). */
function benchmarkMeshLibrary(meshRuns) {
  const timings = [];
  let library = null;
  for (let i = 0; i < meshRuns; i++) {
    const t0 = performance.now();
    library = LocalMapMesh.buildMeshLibrary();
    timings.push(performance.now() - t0);
  }

  const keys = Object.keys(library || {});
  let totalVertices = 0;
  let totalIndices = 0;
  let totalBytes = 0;
  let valid = keys.length === EXPECTED_MESH_MODULES.length;

  for (const id of EXPECTED_MESH_MODULES) {
    const mesh = library?.[id];
    if (!mesh) {
      valid = false;
      continue;
    }
    if (
      !(mesh.positions instanceof Float32Array) ||
      !(mesh.normals instanceof Float32Array) ||
      !(mesh.indices instanceof Uint16Array) ||
      mesh.vertexCount <= 0 ||
      mesh.vertexCount >= 65536 ||
      mesh.indexCount <= 0 ||
      mesh.positions.length !== mesh.vertexCount * 3 ||
      mesh.normals.length !== mesh.vertexCount * 3 ||
      mesh.indices.length !== mesh.indexCount
    ) {
      valid = false;
      continue;
    }
    for (let k = 0; k < mesh.indices.length; k++) {
      if (mesh.indices[k] >= mesh.vertexCount) {
        valid = false;
        break;
      }
    }
    totalVertices += mesh.vertexCount;
    totalIndices += mesh.indexCount;
    totalBytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
  }

  return {
    valid,
    moduleCount: keys.length,
    totalVertices,
    totalTriangles: totalIndices / 3,
    totalBytes,
    timingsMs: distribution(timings),
  };
}

/** Проверка инстансов на строгое соблюдение buildingSpawnMask (И-3.4). */
function inspectGeneratedMap(response, spawnMask) {
  const hfRes = response.meta.hfRes;
  const radiusM = response.meta.radiusM;
  const cellWorldSize = (2 * radiusM) / hfRes;
  const eps = 1e-4;

  let totalInstances = 0;
  let activeModules = 0;
  let spawnMaskViolations = 0;
  let layoutValid =
    response.heightfield instanceof Float32Array &&
    response.heightfield.length === hfRes * hfRes &&
    response.zoneMap instanceof Uint8Array &&
    response.zoneMap.length === response.meta.zoneRes * response.meta.zoneRes * 2 &&
    response.terraformMap instanceof Uint8Array &&
    response.terraformMap.length === response.meta.tfRes * response.meta.tfRes;

  let payloadBytes =
    response.heightfield.byteLength +
    response.zoneMap.byteLength +
    response.terraformMap.byteLength;

  for (const [moduleId, pack] of Object.entries(response.instanceBuffers)) {
    if (!pack) continue;
    if (!EXPECTED_MESH_MODULES.includes(moduleId)) layoutValid = false;
    if (!(pack.buffer instanceof Float32Array) || pack.buffer.length !== pack.count * 8) {
      layoutValid = false;
      continue;
    }
    if (pack.count > 0) activeModules++;
    totalInstances += pack.count;
    payloadBytes += pack.buffer.byteLength;

    for (let i = 0; i < pack.count; i++) {
      const worldX = pack.buffer[i * 8];
      const worldY = pack.buffer[i * 8 + 1];
      const worldZ = pack.buffer[i * 8 + 2];
      if (!Number.isFinite(worldX) || !Number.isFinite(worldY) || !Number.isFinite(worldZ)) {
        layoutValid = false;
        continue;
      }
      const px = worldX / cellWorldSize + hfRes / 2;
      const py = worldY / cellWorldSize + hfRes / 2;
      const pxi = Math.floor(px);
      const pyi = Math.floor(py);
      if (pxi < 0 || pxi >= hfRes || pyi < 0 || pyi >= hfRes) {
        spawnMaskViolations++;
        continue;
      }
      if (spawnMask[pyi * hfRes + pxi] === 1) continue;

      // Защита от ULP-округления Float32Array ровно на целочисленной границе ячейки
      const candidatesX = [pxi];
      const candidatesY = [pyi];
      if (Math.abs(px - Math.round(px)) < eps) {
        const altX = Math.floor(px + eps);
        const altX2 = Math.floor(px - eps);
        if (altX >= 0 && altX < hfRes) candidatesX.push(altX);
        if (altX2 >= 0 && altX2 < hfRes) candidatesX.push(altX2);
      }
      if (Math.abs(py - Math.round(py)) < eps) {
        const altY = Math.floor(py + eps);
        const altY2 = Math.floor(py - eps);
        if (altY >= 0 && altY < hfRes) candidatesY.push(altY);
        if (altY2 >= 0 && altY2 < hfRes) candidatesY.push(altY2);
      }
      let allowedAtBoundary = false;
      for (const cx of candidatesX) {
        for (const cy of candidatesY) {
          if (spawnMask[cy * hfRes + cx] === 1) allowedAtBoundary = true;
        }
      }
      if (!allowedAtBoundary) spawnMaskViolations++;
    }
  }

  if (totalInstances > LocalMapWorker.MAX_INSTANCES) layoutValid = false;

  const transferables = LocalMapWorker.localMapTransferables(response);
  if (!Array.isArray(transferables) || transferables.length !== 3 + Object.values(response.instanceBuffers).filter(Boolean).length) {
    layoutValid = false;
  }

  return {
    totalInstances,
    activeModules,
    spawnMaskViolations,
    layoutValid,
    payloadKiB: round(payloadBytes / 1024, 2),
  };
}

const options = parseArgs(process.argv.slice(2));
const presets = loadPresets();

// 1. Замер библиотеки 3D-мешей
const meshReport = benchmarkMeshLibrary(options.meshRuns);

// 2. Построение геодезической сетки GP(v,0)
const meshStart = performance.now();
const grid = GeodesicGrid.build(options.v);
const gridBuildMs = performance.now() - meshStart;

const seedReports = [];
const allPatchBuildMs = [];
const allPatchVerifyMs = [];
const allPatchTotalMs = [];
const allGenerateMs = [];

const byCenterTimings = Object.fromEntries(CENTER_ARCHETYPES.map((a) => [a.key, []]));
const byScaleTimings = Object.fromEntries(SCALE_STEPS_KM.map((s) => [String(s), []]));
const matrixSummary = {};
for (const arch of CENTER_ARCHETYPES) {
  for (const scaleKm of SCALE_STEPS_KM) {
    const key = `${arch.key}@${scaleKm}km`;
    matrixSummary[key] = {
      centerType: arch.key,
      centerLabel: arch.label,
      scaleKm,
      radiusM: (scaleKm * 1000) / 2,
      generateMs: [],
      instances: [],
      violations: 0,
    };
  }
}

let allSurfaceValid = true;
let allCentersFound = true;
let allPatchInvariantsOk = true;
let allLayoutsValid = true;
let totalSpawnMaskViolations = 0;
let totalGeneratedMaps = 0;

for (let s = 0; s < options.seeds; s++) {
  const seedHex = seedHexFor(options.preset, options.seedStart + s);
  const profile = scaledProfile(presets, options.preset, seedHex, options.radiusKm, options.v);

  const surfStart = performance.now();
  const surface = PlanetSurface.generateSurface(grid, profile);
  const surfaceMs = performance.now() - surfStart;

  const validation = PlanetSurface.validateSurface(grid, surface);
  if (!validation.ok) allSurfaceValid = false;

  const selected = selectRepresentativeCenters(grid, surface);
  const centerEntries = [];

  for (let cIdx = 0; cIdx < CENTER_ARCHETYPES.length; cIdx++) {
    const arch = CENTER_ARCHETYPES[cIdx];
    const cell = selected[arch.key];
    if (!(cell >= 0) || grid.neighborCount[cell] !== 6) {
      allCentersFound = false;
      centerEntries.push({
        centerType: arch.key,
        centerLabel: arch.label,
        cell,
        found: false,
      });
      continue;
    }

    const tPatch0 = performance.now();
    const patch = LocalMapContract.buildPatch7(grid, surface, cell);
    const buildPatchMs = performance.now() - tPatch0;

    const tVerify0 = performance.now();
    const invariantReport = LocalMapContract.verifyPatchInvariants(patch);
    const verifyInvariantsMs = performance.now() - tVerify0;
    const patchTotalMs = buildPatchMs + verifyInvariantsMs;

    allPatchBuildMs.push(buildPatchMs);
    allPatchVerifyMs.push(verifyInvariantsMs);
    allPatchTotalMs.push(patchTotalMs);

    if (!invariantReport.ok) allPatchInvariantsOk = false;

    const spawnMask = LocalMapContract.buildBuildingSpawnMask(
      patch,
      LocalMapWorker.HEIGHTFIELD_RES,
      LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE,
    );
    let buildableMaskCells = 0;
    for (let i = 0; i < spawnMask.length; i++) {
      if (spawnMask[i] === 1) buildableMaskCells++;
    }
    const buildableFraction = round(buildableMaskCells / spawnMask.length, 4);
    const patchSpanKm = round(LocalMapContract.patchSpanMeters(patch) / 1000, 2);

    const scaleResults = [];
    for (const scaleKm of SCALE_STEPS_KM) {
      const radiusM = (scaleKm * 1000) / 2;
      const runTimings = [];
      const runInstances = [];
      let scaleViolations = 0;
      let lastPayloadKiB = 0;
      let lastActiveModules = 0;

      for (let r = 0; r < options.runs; r++) {
        const seed32 = seedUint32For(seedHex, arch.key, scaleKm, r);
        const placeId = 1000 + s * 100 + cIdx * 10 + r;

        const tGen0 = performance.now();
        const response = LocalMapWorker.generateLocalMap({
          patch,
          seed: seed32,
          placeId,
          radiusM,
        });
        const genMs = performance.now() - tGen0;

        const inspected = inspectGeneratedMap(response, spawnMask);
        if (!inspected.layoutValid) allLayoutsValid = false;

        runTimings.push(genMs);
        allGenerateMs.push(genMs);
        byCenterTimings[arch.key].push(genMs);
        byScaleTimings[String(scaleKm)].push(genMs);

        runInstances.push(inspected.totalInstances);
        scaleViolations += inspected.spawnMaskViolations;
        totalSpawnMaskViolations += inspected.spawnMaskViolations;
        lastPayloadKiB = inspected.payloadKiB;
        lastActiveModules = inspected.activeModules;
        totalGeneratedMaps++;

        const mKey = `${arch.key}@${scaleKm}km`;
        matrixSummary[mKey].generateMs.push(genMs);
        matrixSummary[mKey].instances.push(inspected.totalInstances);
        matrixSummary[mKey].violations += inspected.spawnMaskViolations;
      }

      scaleResults.push({
        scaleKm,
        radiusM,
        generateMs: distribution(runTimings),
        instances: {
          mean: round(runInstances.reduce((a, b) => a + b, 0) / runInstances.length, 1),
          min: Math.min(...runInstances),
          max: Math.max(...runInstances),
          activeModules: lastActiveModules,
        },
        payloadKiB: lastPayloadKiB,
        spawnMaskViolations: scaleViolations,
      });
    }

    centerEntries.push({
      centerType: arch.key,
      centerLabel: arch.label,
      cell,
      address: GeodesicGrid.addressOf(grid, cell),
      patchSpanKm,
      riverInlets: patch.river.inlets.length,
      hasRiverOutlet: patch.river.outlet !== null,
      centerLakeWeight: round(patch.cells[0].lakeWeight, 4),
      centerStreamWeight: round(patch.cells[0].streamWeight, 4),
      centerMuLand: round(patch.cells[0].muLand, 4),
      buildPatchMs: round(buildPatchMs, 4),
      verifyInvariantsMs: round(verifyInvariantsMs, 4),
      patchTotalMs: round(patchTotalMs, 4),
      invariantsOk: invariantReport.ok,
      spawnMaskBuildableCells: buildableMaskCells,
      spawnMaskForbiddenCells: spawnMask.length - buildableMaskCells,
      spawnMaskBuildableFraction: buildableFraction,
      scales: scaleResults,
    });
  }

  seedReports.push({
    seed: seedHex,
    surfaceValidationOk: validation.ok,
    surfaceMs: round(surfaceMs, 1),
    centers: centerEntries,
  });
}

const overallGenerate = distribution(allGenerateMs);
const matrixTable = Object.values(matrixSummary).map((item) => ({
  centerType: item.centerType,
  centerLabel: item.centerLabel,
  scaleKm: item.scaleKm,
  radiusM: item.radiusM,
  generateMs: distribution(item.generateMs),
  instancesMean: round(item.instances.reduce((a, b) => a + b, 0) / Math.max(1, item.instances.length), 1),
  instancesMin: item.instances.length ? Math.min(...item.instances) : 0,
  instancesMax: item.instances.length ? Math.max(...item.instances) : 0,
  spawnMaskViolations: item.violations,
}));

const everyMatrixMedianWithinGate = matrixTable.every((row) => row.generateMs.median <= options.gateMs);
const everyMatrixP95WithinGate = matrixTable.every((row) => row.generateMs.p95 <= options.gateMs);

const checks = {
  surfaceValidation: allSurfaceValid,
  representativeHexCentersFound: allCentersFound,
  patchInvariantsAllOk: allPatchInvariantsOk,
  meshLibraryValid: meshReport.valid,
  workerBuffersLayoutValid: allLayoutsValid,
  spawnMaskZeroViolations: totalSpawnMaskViolations === 0,
  g4WorkerGenerateMedianAtMost150Ms: overallGenerate.median <= options.gateMs && everyMatrixMedianWithinGate,
  g4WorkerGenerateP95AtMost150Ms: overallGenerate.p95 <= options.gateMs && everyMatrixP95WithinGate,
};

const result = {
  stage: 'stage-8-local-map-g4',
  versions: {
    grid: GeodesicGrid.GRID_VERSION,
    geography: PlanetSurface.GEOGRAPHY_VERSION,
    patch: LocalMapContract.LOCAL_MAP_PATCH_VERSION,
  },
  config: {
    preset: options.preset,
    v: options.v,
    canonicalEarthV: LocalMapContract.EARTH_CANONICAL_V,
    cells: GeodesicGrid.cellCountForFrequency(options.v),
    radiusKm: options.radiusKm,
    seeds: options.seeds,
    runsPerScale: options.runs,
    scaleStepsKm: SCALE_STEPS_KM,
    heightfieldRes: LocalMapWorker.HEIGHTFIELD_RES,
    zoneRes: LocalMapWorker.ZONE_RES,
    terraformRes: LocalMapWorker.TERRAFORM_RES,
    maxInstances: LocalMapWorker.MAX_INSTANCES,
    gateWorkerMs: options.gateMs,
  },
  planetSetupMs: {
    gridBuildMs: round(gridBuildMs, 1),
    surfaceBuildMs: distribution(seedReports.map((r) => r.surfaceMs), 1),
  },
  meshLibrary: meshReport,
  patch7TimingsMs: {
    buildPatch7: distribution(allPatchBuildMs, 4),
    verifyPatchInvariants: distribution(allPatchVerifyMs, 4),
    total: distribution(allPatchTotalMs, 4),
  },
  generateLocalMapMs: {
    overall: overallGenerate,
    byCenter: Object.fromEntries(
      Object.entries(byCenterTimings).map(([k, vals]) => [k, distribution(vals)]),
    ),
    byScaleKm: Object.fromEntries(
      Object.entries(byScaleTimings).map(([k, vals]) => [k, distribution(vals)]),
    ),
  },
  spawnMaskAudit: {
    totalGeneratedMaps,
    totalSpawnMaskViolations,
  },
  matrix: matrixTable,
  memory: {
    processRssMiB: rssMiB(),
  },
  checks,
  seeds: seedReports,
};

const serialized = JSON.stringify(result, null, 2) + '\n';
if (options.output) writeFileSync(options.output, serialized);
process.stdout.write(serialized);
if (Object.values(result.checks).some((ok) => !ok)) process.exitCode = 1;
