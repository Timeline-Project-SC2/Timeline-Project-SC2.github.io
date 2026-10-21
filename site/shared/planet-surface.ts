/* PlanetSurface — гидрология и биомы c100-soft-v2 поверх географии
   c100-soft-v1 для TIMELINE PROJECT. Строгий TS-порт planet-surface.js
   (CR-01 PR 4, И-5/И-6): горячие циклы (priority-flood, получатели стока,
   аккумуляция Кана, веса биомов и их SIMD-сглаживание) выполняет
   Wasm-ускоритель planet-core, повторяя JS-арифметику побитово —
   включая f32-округления аккумулятора стока на каждом шаге и порядок
   извлечения (key, cellIndex) по И-2. Подъём стока запрещён по
   filledElevation; raw-uphill допустим только внутри впадин/озёр
   priority-flood, как в эталоне Этапа 5. */

import PlanetGeography from './planet-geography.ts';
import type {
  DistributionStats, GeographyProfile, GeographyProfileInput,
  GeographyResult, GeographyStats, GeographyValidation,
} from './planet-geography.ts';
import { PlanetCore } from '../../src/planet/planet-core-host.ts';
import type { PlanetGrid } from './geodesic-grid.ts';

export interface SurfaceProfile extends GeographyProfile {
  baseGeographyVersion: string;
  hydrologyVersion: string;
  biomeVersion: string;
}

export interface SurfaceArrays {
  filledElevation: Float32Array;
  depressionDepth: Float32Array;
  slope: Float32Array;
  flowReceiver: Int32Array;
  flowAccumulationKm2: Float32Array;
  flowAccumulationCells: Float32Array;
  catchmentId: Int32Array;
  drainageRegionId: Int32Array;
  terminalType: Uint8Array;
  lakeId: Int32Array;
  lakeWeight: Float32Array;
  streamWeight: Float32Array;
  riverInfluence: Float32Array;
  deltaWeight: Float32Array;
  mountainWeight: Float32Array;
  mountainSeamWeight: Float32Array;
  mountainRangeId: Int32Array;
  biomeTop1Id: Int32Array;
  biomeTop1Weight: Float32Array;
  biomeTop2Id: Int32Array;
  biomeTop2Weight: Float32Array;
  biomeEntropy: Float32Array;
  biomeColor: Float32Array;
}

export interface BiomeDefinition {
  id: number;
  key: string;
  nameRu: string;
  color: number[];
}

export interface SurfaceThresholds {
  highlandLevel: number;
  mountainLevel: number;
  aridLevel: number;
  wetLevel: number;
  coldLevel: number;
  hotLevel: number;
  streamFlowKm2: number;
  majorRiverFlowKm2: number;
  slopeP55?: number;
  slopeP70?: number;
  slopeP95?: number;
}

export interface CatchmentRecord {
  id: number;
  rootCell: number;
  outletCell: number;
  downstreamCell: number;
  terminalType: string;
  terminalTypeCode: number;
  cellCount: number;
  areaKm2: number;
  effectiveLandAreaKm2: number;
  maxFlowKm2: number;
  maxFlowCells: number;
  lakeId: number;
}

export interface DrainageRegionRecord {
  id: number;
  outletCell: number;
  cellCount: number;
  areaKm2: number;
  effectiveLandAreaKm2: number;
  catchmentCount: number;
  catchmentIds: number[];
  terminalType: string;
  dominantCatchmentId: number;
  physicalLandmassId: number;
}

export interface LakeRecord {
  id: number;
  representativeCell: number;
  outletCell: number;
  downstreamCell: number;
  overflowing: boolean;
  cellCount: number;
  effectiveAreaKm2: number;
  maxDepth: number;
  spillElevation: number;
  catchmentId: number;
  depressionId: number;
}

export interface MountainRangeRecord {
  id: number;
  representativeCell: number;
  cellCount: number;
  areaKm2: number;
  maxElevation: number;
  plateIds: number[];
}

export interface BiomeFraction {
  id: number;
  key: string;
  globalAreaFraction: number;
  landAreaFraction: number;
  top1AreaFraction: number;
}

export interface BiomeStats {
  biomeCount: number;
  meanEntropy: number;
  fractions: BiomeFraction[];
}

export interface MountainStats {
  rangeCount: number;
  mountainAreaFraction: number;
  seamAreaFraction: number;
  distribution?: DistributionStats;
}

export interface HydrologyStats {
  landCells: number;
  routedLandFraction: number;
  cycleBreakCount: number;
  uphillFilledEdgeFraction: number;
  uphillRawEdgeFractionOutsideDepressions: number;
  terminalLandAreaFractions: { ocean: number; terminalLake: number; endorheic: number };
  depression: { componentCount: number; landAreaFraction: number; modes: Record<string, number> };
  lakes: { count: number; landAreaFraction: number };
  catchments: { distribution: DistributionStats; targetMeanCells: number };
  drainageRegions: { distribution: DistributionStats; targetMeanCells: number; meanRatio: number | null };
  flow: {
    streamThresholdKm2: number;
    majorRiverThresholdKm2: number;
    streamLandCellFraction: number;
    majorRiverLandCellFraction: number;
    majorRiverUphillRawOutsideDepressionsFraction: number;
    maxAccumulationKm2: number;
  };
  deltaCellsAtWeight025: number;
  totalAreaChecked: number;
}

export interface SurfaceStats extends GeographyStats {
  hydrology: HydrologyStats;
  biomes: BiomeStats;
  mountains: MountainStats;
}

export interface SurfaceResult extends GeographyResult, SurfaceArrays {
  baseGeography: GeographyResult;
  profile: SurfaceProfile;
  surfaceVersion: string;
  baseGeographyVersion: string;
  hydrologyVersion: string;
  biomeVersion: string;
  catchments: CatchmentRecord[];
  drainageRegions: DrainageRegionRecord[];
  lakes: LakeRecord[];
  mountainRanges: MountainRangeRecord[];
  biomeDefinitions: BiomeDefinition[];
  thresholds: SurfaceThresholds;
  stats: SurfaceStats;
}

export interface SurfaceOptions {
  onProgress?: (stage: string, fraction: number) => void;
  chunkCells?: number;
  yieldControl?: (info: { stage: string; start?: number; end?: number }) => unknown;
}

export interface SurfaceValidation {
  ok: boolean;
  checks: Record<string, boolean>;
  typedBytes?: number;
  baseValidation?: GeographyValidation;
}

const BASE_GEOGRAPHY_VERSION = PlanetGeography.GEOGRAPHY_VERSION;
const SURFACE_GEOGRAPHY_VERSION = 'c100-soft-v2';
const SURFACE_VERSION = SURFACE_GEOGRAPHY_VERSION;
const HYDROLOGY_VERSION = 'planet-hydrology-v1';
const BIOME_VERSION = 'planet-biomes-v1';

const TERMINAL_NONE = 0;
const TERMINAL_OCEAN = 1;
const TERMINAL_LAKE = 2;
const TERMINAL_ENDORHEIC = 3;
const TERMINAL_TYPE_NAMES = ['none', 'ocean', 'terminal_lake', 'endorheic'];

const BIOME_DEFINITIONS: BiomeDefinition[] = [
  { id: 0, key: 'deep_ocean', nameRu: 'Глубокий океан', color: [0.008, 0.050, 0.160] },
  { id: 1, key: 'shelf', nameRu: 'Шельф', color: [0.060, 0.420, 0.520] },
  { id: 2, key: 'sea_ice', nameRu: 'Морской лёд', color: [0.780, 0.880, 0.940] },
  { id: 3, key: 'lake', nameRu: 'Озеро', color: [0.080, 0.350, 0.550] },
  { id: 4, key: 'polar_ice', nameRu: 'Полярный лёд', color: [0.880, 0.930, 0.970] },
  { id: 5, key: 'tundra', nameRu: 'Тундра', color: [0.480, 0.560, 0.480] },
  { id: 6, key: 'boreal_forest', nameRu: 'Тайга', color: [0.120, 0.340, 0.220] },
  { id: 7, key: 'temperate_forest', nameRu: 'Умеренный лес', color: [0.160, 0.460, 0.200] },
  { id: 8, key: 'rainforest', nameRu: 'Дождевой лес', color: [0.030, 0.320, 0.120] },
  { id: 9, key: 'grassland', nameRu: 'Степь и равнины', color: [0.520, 0.580, 0.240] },
  { id: 10, key: 'shrubland', nameRu: 'Кустарники и саванна', color: [0.580, 0.480, 0.220] },
  { id: 11, key: 'hot_desert', nameRu: 'Жаркая пустыня', color: [0.780, 0.600, 0.280] },
  { id: 12, key: 'barren', nameRu: 'Пустошь', color: [0.450, 0.400, 0.340] },
  { id: 13, key: 'alpine', nameRu: 'Высокогорье', color: [0.480, 0.460, 0.440] },
  { id: 14, key: 'volcanic', nameRu: 'Вулканическая местность', color: [0.320, 0.130, 0.080] },
  { id: 15, key: 'wetland', nameRu: 'Водно-болотные угодья', color: [0.180, 0.420, 0.300] },
];
const BIOME_COUNT = BIOME_DEFINITIONS.length;
// Водные биомы для финальной маски сглаживания — 0, 1, 2 (живут в ядре smoothBiomeWeights).

const ARRAY_FIELDS = [
  'filledElevation', 'depressionDepth', 'slope',
  'flowReceiver', 'flowAccumulationKm2', 'flowAccumulationCells',
  'catchmentId', 'drainageRegionId', 'terminalType',
  'lakeId', 'lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
  'mountainWeight', 'mountainSeamWeight', 'mountainRangeId',
  'biomeTop1Id', 'biomeTop1Weight', 'biomeTop2Id', 'biomeTop2Weight',
  'biomeEntropy', 'biomeColor',
] as const;

let sharedCore: PlanetCore | null = null;

function getCore(): PlanetCore {
  if (!sharedCore) sharedCore = new PlanetCore();
  return sharedCore;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}
function clamp01(x: number): number {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function cloneBiomeDefinitions(): BiomeDefinition[] {
  return BIOME_DEFINITIONS.map(function (d) {
    return { id: d.id, key: d.key, nameRu: d.nameRu, color: d.color.slice() };
  });
}

function normalizeSurfaceProfile(input?: GeographyProfileInput | null): SurfaceProfile {
  const src: GeographyProfileInput = Object.assign({}, input || {});
  const requested = src.geographyVersion != null ? src.geographyVersion : src.geography_version;
  if (requested === BASE_GEOGRAPHY_VERSION) {
    throw new Error('PlanetSurface: geographyVersion ' + BASE_GEOGRAPHY_VERSION +
      ' описывает только поля/C100 Этапа 4; для полного рецепта нужна новая ревизия ' +
      SURFACE_GEOGRAPHY_VERSION);
  }
  if (requested != null && requested !== '' && requested !== SURFACE_GEOGRAPHY_VERSION) {
    throw new Error('PlanetSurface: неподдерживаемая geographyVersion ' + String(requested));
  }
  const requestedHydrology = src.hydrologyVersion != null ? src.hydrologyVersion : src.hydrology_version;
  if (requestedHydrology != null && requestedHydrology !== '' && requestedHydrology !== HYDROLOGY_VERSION) {
    throw new Error('PlanetSurface: неподдерживаемая hydrologyVersion ' + String(requestedHydrology));
  }
  const requestedBiomes = src.biomeVersion != null ? src.biomeVersion : src.biome_version;
  if (requestedBiomes != null && requestedBiomes !== '' && requestedBiomes !== BIOME_VERSION) {
    throw new Error('PlanetSurface: неподдерживаемая biomeVersion ' + String(requestedBiomes));
  }
  src.geographyVersion = BASE_GEOGRAPHY_VERSION;
  const base = PlanetGeography.normalizeProfile(src);
  const profile = Object.assign({}, base) as SurfaceProfile;
  profile.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
  profile.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
  profile.hydrologyVersion = HYDROLOGY_VERSION;
  profile.biomeVersion = BIOME_VERSION;
  return profile;
}

function surfaceProfileFromBase(baseProfile: GeographyProfile): SurfaceProfile {
  const profile = Object.assign({}, baseProfile || {}) as SurfaceProfile;
  profile.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
  profile.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
  profile.hydrologyVersion = HYDROLOGY_VERSION;
  profile.biomeVersion = BIOME_VERSION;
  return profile;
}

function baseProfileInput(input?: GeographyProfileInput | null): GeographyProfileInput {
  const surfaceProfile = normalizeSurfaceProfile(input);
  const base = Object.assign({}, surfaceProfile) as unknown as GeographyProfileInput;
  base.geographyVersion = BASE_GEOGRAPHY_VERSION;
  return base;
}

function isGeographyResult(value: unknown): value is GeographyResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as GeographyResult;
  return !!(candidate.elevation && candidate.muLand && candidate.continents &&
    candidate.profile && Number.isInteger(candidate.cellCount));
}

function allocateSurfaceArrays(cellCount: number): SurfaceArrays {
  return {
    filledElevation: new Float32Array(cellCount),
    depressionDepth: new Float32Array(cellCount),
    slope: new Float32Array(cellCount),
    flowReceiver: new Int32Array(cellCount).fill(-1),
    flowAccumulationKm2: new Float32Array(cellCount),
    flowAccumulationCells: new Float32Array(cellCount),
    catchmentId: new Int32Array(cellCount).fill(-1),
    drainageRegionId: new Int32Array(cellCount).fill(-1),
    terminalType: new Uint8Array(cellCount),
    lakeId: new Int32Array(cellCount).fill(-1),
    lakeWeight: new Float32Array(cellCount),
    streamWeight: new Float32Array(cellCount),
    riverInfluence: new Float32Array(cellCount),
    deltaWeight: new Float32Array(cellCount),
    mountainWeight: new Float32Array(cellCount),
    mountainSeamWeight: new Float32Array(cellCount),
    mountainRangeId: new Int32Array(cellCount).fill(-1),
    biomeTop1Id: new Int32Array(cellCount).fill(-1),
    biomeTop1Weight: new Float32Array(cellCount),
    biomeTop2Id: new Int32Array(cellCount).fill(-1),
    biomeTop2Weight: new Float32Array(cellCount),
    biomeEntropy: new Float32Array(cellCount),
    biomeColor: new Float32Array(cellCount * 3),
  };
}

function makeWeightedQuantiles(
  values: Float32Array | Float64Array, weights: Float64Array,
): (q: number) => number {
  const order: number[] = [];
  let i: number;
  for (i = 0; i < values.length; i++) {
    if ((weights[i] as number) > 0 && Number.isFinite(values[i] as number)) order.push(i);
  }
  order.sort(function (a, b) { return (values[a] as number) - (values[b] as number) || a - b; });
  const cumulative = new Float64Array(order.length);
  let total = 0;
  for (i = 0; i < order.length; i++) {
    total += weights[order[i] as number] as number;
    cumulative[i] = total;
  }
  return function quantile(q: number): number {
    if (!order.length || !(total > 0)) return 0;
    if (q <= 0) return values[order[0] as number] as number;
    if (q >= 1) return values[order[order.length - 1] as number] as number;
    const target = total * q;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) >= target) hi = mid;
      else lo = mid + 1;
    }
    return values[order[lo] as number] as number;
  };
}

function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

function distributionStats(values: number[]): DistributionStats {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i] as number;
  return {
    count: sorted.length,
    sum: sum,
    mean: sorted.length ? sum / sorted.length : 0,
    min: sorted.length ? (sorted[0] as number) : 0,
    p10: quantileSorted(sorted, 0.10),
    median: quantileSorted(sorted, 0.50),
    p90: quantileSorted(sorted, 0.90),
    p99: quantileSorted(sorted, 0.99),
    max: sorted.length ? (sorted[sorted.length - 1] as number) : 0,
  };
}

function assertInputs(grid: PlanetGrid, geography: GeographyResult): void {
  if (!grid || !grid.centers || !grid.areas || !grid.neighbors || !grid.neighborCount ||
      !Number.isInteger(grid.cellCount) || grid.cellCount <= 0) {
    throw new Error('PlanetSurface: нужна сетка GeodesicGrid с centers/areas/neighbors');
  }
  if (!isGeographyResult(geography)) {
    throw new Error('PlanetSurface: нужен результат PlanetGeography.generateGeography');
  }
  if (geography.cellCount !== grid.cellCount || geography.v !== grid.v) {
    throw new Error('PlanetSurface: сетка и география имеют разную форму');
  }
  if (geography.geographyVersion !== BASE_GEOGRAPHY_VERSION &&
      !(geography.baseGeography && geography.baseGeography.geographyVersion === BASE_GEOGRAPHY_VERSION)) {
    throw new Error('PlanetSurface: базовая география должна быть ' + BASE_GEOGRAPHY_VERSION);
  }
  const required = PlanetGeography.ARRAY_FIELDS;
  const source = geography as unknown as Record<string, { length: number } | undefined>;
  for (let i = 0; i < required.length; i++) {
    const name = required[i] as string;
    const value = source[name];
    if (!value || value.length !== grid.cellCount) {
      throw new Error('PlanetSurface: в географии нет массива ' + name);
    }
  }
}

function connectedComponents(grid: PlanetGrid, mask: Uint8Array): { ids: Int32Array; components: number[][] } {
  const ids = new Int32Array(grid.cellCount).fill(-1);
  const components: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < grid.cellCount; start++) {
    if (!mask[start] || (ids[start] as number) >= 0) continue;
    const id = components.length;
    const cells: number[] = [];
    stack.length = 0;
    stack.push(start);
    ids[start] = id;
    while (stack.length) {
      const cell = stack.pop() as number;
      cells.push(cell);
      for (let j = 0; j < (grid.neighborCount[cell] as number); j++) {
        const nb = grid.neighbors[cell * 6 + j] as number;
        if (mask[nb] && (ids[nb] as number) < 0) {
          ids[nb] = id;
          stack.push(nb);
        }
      }
    }
    components.push(cells);
  }
  return { ids, components };
}

function surfaceLiquidFactor(surfaceClass: string): number {
  if (surfaceClass === 'desert') return 0.55;
  if (surfaceClass === 'ice') return 0.70;
  if (surfaceClass === 'volcanic') return 0.80;
  if (surfaceClass === 'barren') return 0.10;
  return 1.0;
}

function lakeThresholds(surfaceClass: string): { lake: number; overflow: number } {
  if (surfaceClass === 'desert') return { lake: 0.54, overflow: 0.74 };
  if (surfaceClass === 'barren') return { lake: 0.70, overflow: 0.86 };
  if (surfaceClass === 'ice') return { lake: 0.40, overflow: 0.62 };
  if (surfaceClass === 'volcanic') return { lake: 0.44, overflow: 0.66 };
  return { lake: 0.34, overflow: 0.58 };
}

interface DepressionInfo {
  id: number;
  cells: number[];
  cellCount: number;
  areaKm2: number;
  maxDepth: number;
  volumeProxyKm2: number;
  localPrecipArea: number;
  localWeightedArea: number;
  outletCell: number;
  downstreamCell: number;
  spillElevation: number;
  sinkRoots: number[];
  inflowKm2: number;
  inflowCells: number;
  upstreamPrecip: number;
  wetness: number;
  mode: string;
}

function computeSurface(grid: PlanetGrid, geography: GeographyResult, options: SurfaceOptions): SurfaceResult {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  function progress(stage: string, fraction: number): void { if (onProgress) onProgress(stage, fraction); }

  const baseGeography = geography.baseGeography && geography.baseGeography.geographyVersion === BASE_GEOGRAPHY_VERSION
    ? geography.baseGeography : geography;
  assertInputs(grid, baseGeography);
  const profile = surfaceProfileFromBase(baseGeography.profile);
  const n = grid.cellCount;
  const arrays = allocateSurfaceArrays(n);
  const radiusKm = baseGeography.radiusKm || profile.radiusKm;
  const areaScale = radiusKm * radiusKm;

  const surface = Object.assign({}, baseGeography) as unknown as SurfaceResult;
  surface.baseGeography = baseGeography;
  surface.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
  surface.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
  surface.surfaceVersion = SURFACE_VERSION;
  surface.hydrologyVersion = HYDROLOGY_VERSION;
  surface.biomeVersion = BIOME_VERSION;
  surface.profile = profile;
  const surfaceWritable = surface as unknown as Record<string, unknown>;
  const arraysSource = arrays as unknown as Record<string, unknown>;
  for (const name of ARRAY_FIELDS) surfaceWritable[name] = arraysSource[name];
  surface.catchments = [];
  surface.drainageRegions = [];
  surface.lakes = [];
  surface.mountainRanges = [];
  surface.biomeDefinitions = cloneBiomeDefinitions();
  surface.thresholds = {} as SurfaceThresholds;
  surface.stats = Object.assign({}, baseGeography.stats || {}) as SurfaceStats;

  if (!baseGeography.surfaceApplicable) {
    surface.stats.hydrology = emptyHydrologyStats(profile);
    surface.stats.biomes = emptyBiomeStats();
    surface.stats.mountains = { rangeCount: 0, mountainAreaFraction: 0, seamAreaFraction: 0 };
    progress('done', 1);
    return surface;
  }

  const elevation = baseGeography.elevation;
  const seaLevel = baseGeography.seaLevel;
  const hardLand = new Uint8Array(n);
  const landCells: number[] = [];
  let c: number, j: number, nb: number;
  for (c = 0; c < n; c++) {
    if (profile.oceanPctl <= 0) hardLand[c] = 1;
    else if (profile.oceanPctl < 100) hardLand[c] = (elevation[c] as number) > seaLevel ? 1 : 0;
    if (hardLand[c]) landCells.push(c);
  }

  const landWeights = new Float64Array(n);
  let totalArea = 0;
  let hardLandArea = 0;
  for (c = 0; c < n; c++) {
    totalArea += grid.areas[c] as number;
    if (hardLand[c]) {
      landWeights[c] = grid.areas[c] as number;
      hardLandArea += grid.areas[c] as number;
    }
  }
  const qElevation = makeWeightedQuantiles(elevation, landWeights);
  const qMoisture = makeWeightedQuantiles(baseGeography.moisture, landWeights);
  const qTemperature = makeWeightedQuantiles(baseGeography.temperature, landWeights);
  const thresholds: SurfaceThresholds = {
    highlandLevel: qElevation(profile.highlandLandPctl / 100),
    mountainLevel: qElevation(profile.mountainLandPctl / 100),
    aridLevel: qMoisture(profile.aridLandPctl / 100),
    wetLevel: qMoisture(profile.wetLandPctl / 100),
    coldLevel: qTemperature(profile.coldPctl / 100),
    hotLevel: qTemperature(profile.hotPctl / 100),
    streamFlowKm2: 0,
    majorRiverFlowKm2: 0,
  };
  surface.thresholds = thresholds;

  const precip01 = new Float32Array(n);
  const localRunoffKm2 = new Float64Array(n);
  const localRunoffCells = new Float64Array(n);
  let liquidFactor = surfaceLiquidFactor(profile.surfaceClass);
  if (profile.surfaceClass === 'barren' && profile.oceanPctl <= 0) liquidFactor = 0.035;
  for (c = 0; c < n; c++) {
    precip01[c] = thresholds.wetLevel > thresholds.aridLevel
      ? smoothstep(thresholds.aridLevel, thresholds.wetLevel, baseGeography.moisture[c] as number)
      : clamp01(baseGeography.moisture[c] as number);
    const tempFactor = 0.45 + 0.55 * smoothstep(thresholds.coldLevel, thresholds.hotLevel, baseGeography.temperature[c] as number);
    const coeff = liquidFactor * tempFactor * (0.06 + 0.94 * (precip01[c] as number));
    localRunoffKm2[c] = hardLand[c] ? (grid.areas[c] as number) * areaScale * (baseGeography.muLand[c] as number) * coeff : 0;
    localRunoffCells[c] = hardLand[c] ? (baseGeography.muLand[c] as number) : 0;
  }

  progress('hydrology-priority-flood', 0.08);
  const flood = getCore().priorityFlood(grid.neighbors, grid.neighborCount, elevation, hardLand, n);
  for (c = 0; c < n; c++) {
    arrays.filledElevation[c] = flood.filled[c] as number;
    arrays.depressionDepth[c] = hardLand[c] ? Math.max(0, (flood.filled[c] as number) - (elevation[c] as number)) : 0;
  }

  progress('hydrology-flow', 0.18);
  const flow = getCore().flowReceivers(grid.neighbors, grid.neighborCount, grid.centers,
    elevation, flood.filled, flood.parent, hardLand, n);
  const rawReceiver = flow.rawReceiver;
  const filledReceiver = flow.filledReceiver;
  const rawSlope = flow.rawSlope;
  arrays.slope.set(flow.slope);
  const qSlope = makeWeightedQuantiles(rawSlope, landWeights);
  thresholds.slopeP55 = qSlope(0.55);
  thresholds.slopeP70 = qSlope(0.70);
  thresholds.slopeP95 = qSlope(0.95);

  const orderAsc = landCells.slice().sort(function (a, b) { return (elevation[a] as number) - (elevation[b] as number) || a - b; });
  const rawRoot = new Int32Array(n).fill(-1);
  for (c = 0; c < orderAsc.length; c++) {
    const cell = orderAsc[c] as number;
    const rr = rawReceiver[cell] as number;
    rawRoot[cell] = (rr < 0 || !hardLand[rr]) ? cell : (rawRoot[rr] as number);
  }
  const rawAccKm2 = new Float64Array(n);
  const rawAccCells = new Float64Array(n);
  for (c = 0; c < landCells.length; c++) {
    rawAccKm2[landCells[c] as number] = localRunoffKm2[landCells[c] as number] as number;
    rawAccCells[landCells[c] as number] = localRunoffCells[landCells[c] as number] as number;
  }
  for (c = orderAsc.length - 1; c >= 0; c--) {
    const cell = orderAsc[c] as number;
    const rr = rawReceiver[cell] as number;
    if (rr >= 0 && hardLand[rr]) {
      rawAccKm2[rr] = (rawAccKm2[rr] as number) + (rawAccKm2[cell] as number);
      rawAccCells[rr] = (rawAccCells[rr] as number) + (rawAccCells[cell] as number);
    }
  }
  interface RawCatchmentEntry { cellCount: number; areaKm2: number; precipArea: number; weightedArea: number }
  const rawCatchmentStats = new Map<number, RawCatchmentEntry>();
  for (c = 0; c < landCells.length; c++) {
    const cell = landCells[c] as number;
    const root = rawRoot[cell] as number;
    let entry = rawCatchmentStats.get(root);
    if (!entry) {
      entry = { cellCount: 0, areaKm2: 0, precipArea: 0, weightedArea: 0 };
      rawCatchmentStats.set(root, entry);
    }
    const physicalArea = (grid.areas[cell] as number) * areaScale;
    const weighted = physicalArea * Math.max(0.02, baseGeography.muLand[cell] as number);
    entry.cellCount++;
    entry.areaKm2 += physicalArea;
    entry.precipArea += (precip01[cell] as number) * weighted;
    entry.weightedArea += weighted;
  }

  const depressionMask = new Uint8Array(n);
  for (c = 0; c < n; c++) depressionMask[c] = hardLand[c] && (arrays.depressionDepth[c] as number) > 1e-9 ? 1 : 0;
  const depressionComponents = connectedComponents(grid, depressionMask);
  const sinkRootsByComponent: number[][] = depressionComponents.components.map(function () { return []; });
  rawCatchmentStats.forEach(function (_entry, rootCell) {
    if (rawReceiver[rootCell] === -1) {
      const componentId = depressionComponents.ids[rootCell] as number;
      if (componentId >= 0) (sinkRootsByComponent[componentId] as number[]).push(rootCell);
    }
  });
  const relief = Math.max(1e-9, baseGeography.elevationMax - seaLevel);
  const microDepth = Math.max(0.0015, relief * 0.004);
  const lakeCutoffs = lakeThresholds(profile.surfaceClass);
  const lakeDistance = new Int32Array(n).fill(-1);
  const depressionInfo: DepressionInfo[] = [];
  arrays.flowReceiver.set(filledReceiver);

  for (let compIndex = 0; compIndex < depressionComponents.components.length; compIndex++) {
    const cells = depressionComponents.components[compIndex] as number[];
    const info: DepressionInfo = {
      id: compIndex,
      cells: cells,
      cellCount: cells.length,
      areaKm2: 0,
      maxDepth: 0,
      volumeProxyKm2: 0,
      localPrecipArea: 0,
      localWeightedArea: 0,
      outletCell: -1,
      downstreamCell: -1,
      spillElevation: 0,
      sinkRoots: [],
      inflowKm2: 0,
      inflowCells: 0,
      upstreamPrecip: 0,
      wetness: 0,
      mode: 'filled',
    };
    let bestOutletScore = Infinity;
    for (c = 0; c < cells.length; c++) {
      const cell = cells[c] as number;
      const areaKm2 = (grid.areas[cell] as number) * areaScale;
      info.areaKm2 += areaKm2;
      info.maxDepth = Math.max(info.maxDepth, arrays.depressionDepth[cell] as number);
      info.volumeProxyKm2 += (arrays.depressionDepth[cell] as number) * areaKm2;
      const w = areaKm2 * Math.max(0.02, baseGeography.muLand[cell] as number);
      info.localPrecipArea += (precip01[cell] as number) * w;
      info.localWeightedArea += w;
      const fp = flood.parent[cell] as number;
      if (fp >= 0 && depressionComponents.ids[fp] !== compIndex) {
        const score = (flood.filled[cell] as number) * 1000 + (flood.filled[fp] as number);
        if (score < bestOutletScore) {
          bestOutletScore = score;
          info.outletCell = cell;
          info.downstreamCell = fp;
          info.spillElevation = flood.filled[cell] as number;
        }
      }
    }
    const componentSinkRoots = sinkRootsByComponent[compIndex] as number[];
    let upstreamWeightedArea = 0;
    for (c = 0; c < componentSinkRoots.length; c++) {
      const sinkRoot = componentSinkRoots[c] as number;
      const sinkEntry = rawCatchmentStats.get(sinkRoot);
      info.sinkRoots.push(sinkRoot);
      info.inflowKm2 += rawAccKm2[sinkRoot] as number;
      info.inflowCells += rawAccCells[sinkRoot] as number;
      if (sinkEntry) {
        info.upstreamPrecip += sinkEntry.precipArea;
        upstreamWeightedArea += sinkEntry.weightedArea;
      }
    }
    const localPrecip = info.localWeightedArea > 0 ? info.localPrecipArea / info.localWeightedArea : 0;
    const upstreamPrecip = upstreamWeightedArea > 0 ? info.upstreamPrecip / upstreamWeightedArea : localPrecip;
    info.wetness = clamp01(0.72 * upstreamPrecip + 0.28 * localPrecip);
    const significant = info.maxDepth > microDepth;
    if (!significant) info.mode = 'filled';
    else if (info.outletCell >= 0 && info.wetness >= lakeCutoffs.overflow) info.mode = 'overflow_lake';
    else if (info.wetness >= lakeCutoffs.lake) info.mode = 'terminal_lake';
    else info.mode = 'endorheic';
    if (profile.surfaceClass === 'barren' && profile.oceanPctl <= 0) {
      info.mode = significant ? 'endorheic' : 'filled';
    }
    depressionInfo.push(info);

    if (info.mode === 'endorheic' || info.mode === 'terminal_lake') {
      for (c = 0; c < cells.length; c++) arrays.flowReceiver[cells[c] as number] = rawReceiver[cells[c] as number] as number;
    } else if (info.mode === 'overflow_lake' && info.outletCell >= 0) {
      const queue = new Int32Array(cells.length);
      let qHead = 0, qTail = 0;
      lakeDistance[info.outletCell] = 0;
      arrays.flowReceiver[info.outletCell] = info.downstreamCell;
      queue[qTail++] = info.outletCell;
      while (qHead < qTail) {
        const cell = queue[qHead++] as number;
        for (j = 0; j < (grid.neighborCount[cell] as number); j++) {
          nb = grid.neighbors[cell * 6 + j] as number;
          if (depressionComponents.ids[nb] === compIndex && (lakeDistance[nb] as number) < 0) {
            lakeDistance[nb] = (lakeDistance[cell] as number) + 1;
            arrays.flowReceiver[nb] = cell;
            queue[qTail++] = nb;
          }
        }
      }
    }
  }

  const lakeRecords: LakeRecord[] = [];
  const lakeCandidateStamp = new Int32Array(n).fill(-1);
  const lakeSeenStamp = new Int32Array(n).fill(-1);
  for (let compIndex = 0; compIndex < depressionInfo.length; compIndex++) {
    const info = depressionInfo[compIndex] as DepressionInfo;
    if (info.mode !== 'overflow_lake' && info.mode !== 'terminal_lake') continue;
    const depthThreshold = info.mode === 'overflow_lake' ? 0 : info.maxDepth * 0.45;
    const lakeCandidates: number[] = [];
    for (c = 0; c < info.cells.length; c++) {
      const cell = info.cells[c] as number;
      if ((arrays.depressionDepth[cell] as number) >= depthThreshold) {
        lakeCandidateStamp[cell] = compIndex;
        lakeCandidates.push(cell);
      }
    }
    for (c = 0; c < info.sinkRoots.length; c++) {
      const cell = info.sinkRoots[c] as number;
      if (lakeCandidateStamp[cell] !== compIndex) {
        lakeCandidateStamp[cell] = compIndex;
        lakeCandidates.push(cell);
      }
    }
    const lakeParts: number[][] = [];
    for (c = 0; c < lakeCandidates.length; c++) {
      const cell = lakeCandidates[c] as number;
      if (lakeSeenStamp[cell] === compIndex) continue;
      const part: number[] = [];
      const stack: number[] = [cell];
      lakeSeenStamp[cell] = compIndex;
      while (stack.length) {
        const current = stack.pop() as number;
        part.push(current);
        for (j = 0; j < (grid.neighborCount[current] as number); j++) {
          nb = grid.neighbors[current * 6 + j] as number;
          if (lakeCandidateStamp[nb] === compIndex && lakeSeenStamp[nb] !== compIndex) {
            lakeSeenStamp[nb] = compIndex;
            stack.push(nb);
          }
        }
      }
      lakeParts.push(part);
    }
    for (let partIndex = 0; partIndex < lakeParts.length; partIndex++) {
      const lakeCells = lakeParts[partIndex] as number[];
      const lakeId = lakeRecords.length;
      let representative = lakeCells[0] as number;
      let effectiveArea = 0;
      for (c = 0; c < lakeCells.length; c++) {
        const cell = lakeCells[c] as number;
        if ((arrays.depressionDepth[cell] as number) > (arrays.depressionDepth[representative] as number)) representative = cell;
        let weight: number;
        if (info.mode === 'overflow_lake') {
          weight = 0.30 + 0.70 * Math.sqrt(clamp01((arrays.depressionDepth[cell] as number) / Math.max(1e-12, info.maxDepth)));
        } else {
          weight = 0.25 + 0.75 * smoothstep(depthThreshold, info.maxDepth, arrays.depressionDepth[cell] as number);
        }
        arrays.lakeId[cell] = lakeId;
        arrays.lakeWeight[cell] = clamp01(weight);
        effectiveArea += (grid.areas[cell] as number) * areaScale * (arrays.lakeWeight[cell] as number);
      }
      lakeRecords.push({
        id: lakeId,
        representativeCell: representative,
        outletCell: info.mode === 'overflow_lake' ? info.outletCell : representative,
        downstreamCell: info.mode === 'overflow_lake' ? info.downstreamCell : -1,
        overflowing: info.mode === 'overflow_lake',
        cellCount: lakeCells.length,
        effectiveAreaKm2: effectiveArea,
        maxDepth: info.maxDepth,
        spillElevation: info.spillElevation || (flood.filled[representative] as number),
        catchmentId: -1,
        depressionId: info.id,
      });
    }
  }
  surface.lakes = lakeRecords;

  progress('hydrology-accumulation', 0.34);
  const topo = accumulateFlow(grid, hardLand, Int32Array.from(landCells), arrays, localRunoffKm2, localRunoffCells, flood.filled);
  const flowOrder = topo.order;

  const rootCellOf = new Int32Array(n).fill(-1);
  for (c = flowOrder.length - 1; c >= 0; c--) {
    const cell = flowOrder[c] as number;
    const rr = arrays.flowReceiver[cell] as number;
    rootCellOf[cell] = (rr < 0 || !hardLand[rr]) ? cell : (rootCellOf[rr] as number);
  }
  const uniqueRoots: number[] = [];
  const rootSeen = new Uint8Array(n);
  for (c = 0; c < landCells.length; c++) {
    const r = rootCellOf[landCells[c] as number] as number;
    if (r >= 0 && !rootSeen[r]) { rootSeen[r] = 1; uniqueRoots.push(r); }
  }
  uniqueRoots.sort(function (a, b) { return a - b; });
  const rootToCatchment = new Int32Array(n).fill(-1);
  const catchmentRecords: CatchmentRecord[] = uniqueRoots.map(function (rootCell, id) {
    rootToCatchment[rootCell] = id;
    const receiver = arrays.flowReceiver[rootCell] as number;
    const type = receiver >= 0 && !hardLand[receiver] ? TERMINAL_OCEAN
      : ((arrays.lakeId[rootCell] as number) >= 0 ? TERMINAL_LAKE : TERMINAL_ENDORHEIC);
    return {
      id: id,
      rootCell: rootCell,
      outletCell: rootCell,
      downstreamCell: receiver,
      terminalType: TERMINAL_TYPE_NAMES[type] as string,
      terminalTypeCode: type,
      cellCount: 0,
      areaKm2: 0,
      effectiveLandAreaKm2: 0,
      maxFlowKm2: arrays.flowAccumulationKm2[rootCell] as number,
      maxFlowCells: arrays.flowAccumulationCells[rootCell] as number,
      lakeId: arrays.lakeId[rootCell] as number,
    };
  });
  for (c = 0; c < landCells.length; c++) {
    const cell = landCells[c] as number;
    const cid = rootToCatchment[rootCellOf[cell] as number] as number;
    arrays.catchmentId[cell] = cid;
    const record = catchmentRecords[cid] as CatchmentRecord;
    arrays.terminalType[cell] = record.terminalTypeCode;
    record.cellCount++;
    record.areaKm2 += (grid.areas[cell] as number) * areaScale;
    record.effectiveLandAreaKm2 += (grid.areas[cell] as number) * areaScale * (baseGeography.muLand[cell] as number);
  }
  surface.catchments = catchmentRecords;
  for (c = 0; c < surface.lakes.length; c++) {
    const lake = surface.lakes[c] as LakeRecord;
    lake.catchmentId = arrays.catchmentId[lake.representativeCell] as number;
  }

  const qFlow = makeWeightedQuantiles(arrays.flowAccumulationKm2, landWeights);
  thresholds.streamFlowKm2 = qFlow(profile.streamFlowPctl / 100);
  thresholds.majorRiverFlowKm2 = qFlow(profile.majorRiverFlowPctl / 100);
  if (!(thresholds.majorRiverFlowKm2 > thresholds.streamFlowKm2)) {
    thresholds.majorRiverFlowKm2 = Math.max(thresholds.streamFlowKm2 * 4, thresholds.streamFlowKm2 + 1e-9);
  }
  computeStreamAndDelta(grid, baseGeography, arrays, hardLand, thresholds, liquidFactor);

  progress('drainage-regions', 0.48);
  surface.drainageRegions = buildDrainageRegions(
    grid, baseGeography, arrays, hardLand, landCells, flowOrder, profile, areaScale,
  );

  progress('mountains', 0.60);
  const mountainStats = computeMountains(grid, baseGeography, arrays, hardLand, thresholds, areaScale);
  surface.mountainRanges = mountainStats.ranges;

  progress('biomes', 0.72);
  const biomeStats = computeBiomes(grid, baseGeography, arrays, hardLand, profile, thresholds);
  surface.stats.hydrology = computeHydrologyStats(
    grid, baseGeography, arrays, hardLand, landCells.length, hardLandArea, totalArea,
    catchmentRecords, surface.drainageRegions, depressionInfo, topo.cycleBreakCount, profile, thresholds,
  );
  surface.stats.biomes = biomeStats;
  surface.stats.mountains = mountainStats.stats;
  progress('done', 1);
  return surface;
}

function accumulateFlow(
  grid: PlanetGrid, hardLand: Uint8Array, landCells: Int32Array, arrays: SurfaceArrays,
  localRunoffKm2: Float64Array, localRunoffCells: Float64Array, filled: Float64Array,
): { order: Int32Array; cycleBreakCount: number } {
  const topo = getCore().accumulateFlow(hardLand, landCells, arrays.flowReceiver,
    localRunoffKm2, localRunoffCells, filled, grid.cellCount);
  arrays.flowAccumulationKm2.set(topo.accKm2);
  arrays.flowAccumulationCells.set(topo.accCells);
  arrays.flowReceiver.set(topo.flowReceiver);
  return { order: topo.order, cycleBreakCount: topo.cycleBreakCount };
}

function computeStreamAndDelta(
  grid: PlanetGrid, geography: GeographyResult, arrays: SurfaceArrays, hardLand: Uint8Array,
  thresholds: SurfaceThresholds, liquidFactor: number,
): void {
  const stream = Math.max(1e-12, thresholds.streamFlowKm2);
  const major = Math.max(stream * 1.000001, thresholds.majorRiverFlowKm2);
  const logStream = Math.log1p(stream);
  const logMajor = Math.log1p(major);
  const logLow = Math.log1p(stream * 0.35);
  let c: number, j: number, nb: number;
  for (c = 0; c < grid.cellCount; c++) {
    if (!hardLand[c]) continue;
    const logFlow = Math.log1p(Math.max(0, arrays.flowAccumulationKm2[c] as number));
    let weight: number;
    if (logFlow <= logLow) weight = 0;
    else if (logFlow < logStream) weight = 0.32 * smoothstep(logLow, logStream, logFlow);
    else weight = 0.32 + 0.68 * smoothstep(logStream, logMajor, logFlow);
    weight *= liquidFactor * (0.35 + 0.65 * (geography.muLand[c] as number));
    if ((arrays.lakeWeight[c] as number) > 0.65) weight *= 0.25;
    arrays.streamWeight[c] = clamp01(weight);
    arrays.riverInfluence[c] = arrays.streamWeight[c] as number;
  }

  // Дельты: только устья в океан и соседний шельф, никаких случайных
  // дельт в открытом океане.
  for (c = 0; c < grid.cellCount; c++) {
    if (!hardLand[c]) continue;
    const receiver = arrays.flowReceiver[c] as number;
    if (receiver < 0 || hardLand[receiver]) continue;
    const flowScore = smoothstep(logStream, Math.log1p(major * 1.5), Math.log1p(arrays.flowAccumulationKm2[c] as number));
    if (flowScore <= 0) continue;
    const slopeFactor = 1 - smoothstep(thresholds.slopeP70 as number, thresholds.slopeP95 as number, arrays.slope[c] as number);
    const base = clamp01(flowScore * (0.35 + 0.65 * slopeFactor) * liquidFactor);
    if (base <= 0.03) continue;
    arrays.deltaWeight[c] = Math.max(arrays.deltaWeight[c] as number, base);
    for (j = 0; j < (grid.neighborCount[c] as number); j++) {
      nb = grid.neighbors[c * 6 + j] as number;
      if (hardLand[nb]) {
        arrays.deltaWeight[nb] = Math.max(arrays.deltaWeight[nb] as number, base * 0.38);
      } else if ((geography.signedCoastDistanceCells[nb] as number) >= -3) {
        arrays.deltaWeight[nb] = Math.max(arrays.deltaWeight[nb] as number,
          base * 0.70 * (0.35 + 0.65 * (geography.muShelf[nb] as number)));
      }
    }
  }
  const first = new Float32Array(arrays.riverInfluence);
  for (c = 0; c < grid.cellCount; c++) {
    let best = first[c] as number;
    for (j = 0; j < (grid.neighborCount[c] as number); j++) {
      nb = grid.neighbors[c * 6 + j] as number;
      best = Math.max(best, (first[nb] as number) * 0.55);
    }
    arrays.riverInfluence[c] = best;
  }
  const second = new Float32Array(arrays.riverInfluence);
  for (c = 0; c < grid.cellCount; c++) {
    let best = second[c] as number;
    for (j = 0; j < (grid.neighborCount[c] as number); j++) {
      nb = grid.neighbors[c * 6 + j] as number;
      best = Math.max(best, (second[nb] as number) * 0.35);
    }
    arrays.riverInfluence[c] = clamp01(Math.max(best, (arrays.lakeWeight[c] as number) * 0.85, (arrays.deltaWeight[c] as number) * 0.80));
  }
}

interface DrainageSegment {
  id: number;
  alive: boolean;
  cells: number[];
  size: number;
  minCell: number;
  catchments: Set<number>;
  dominantLandmass: number;
  outletCell: number;
  neighbors: Set<number>;
}

function buildDrainageRegions(
  grid: PlanetGrid, geography: GeographyResult, arrays: SurfaceArrays, hardLand: Uint8Array,
  landCells: number[], flowOrder: Int32Array, profile: SurfaceProfile, areaScale: number,
): DrainageRegionRecord[] {
  const n = grid.cellCount;
  const target = Math.max(1, profile.drainageMeanCells || 1);
  const pending: (number[] | null)[] = new Array(n).fill(null);
  const initial: number[][] = [];
  let c: number, cell: number, receiver: number;
  function mergeLists(a: number[] | null, b: number[] | null): number[] | null {
    if (!a) return b;
    if (!b) return a;
    if (a.length < b.length) { const tmp = a; a = b; b = tmp; }
    for (let i = 0; i < b.length; i++) a.push(b[i] as number);
    return a;
  }
  for (c = 0; c < flowOrder.length; c++) {
    cell = flowOrder[c] as number;
    const list = pending[cell] || [];
    pending[cell] = null;
    list.push(cell);
    receiver = arrays.flowReceiver[cell] as number;
    if (receiver >= 0 && hardLand[receiver]) {
      if (list.length >= target) initial.push(list);
      else pending[receiver] = mergeLists(pending[receiver] as number[] | null, list);
    } else {
      initial.push(list);
    }
  }

  const segmentId = new Int32Array(n).fill(-1);
  const segments: DrainageSegment[] = initial.map(function (cells, id) {
    const catchmentSet = new Set<number>();
    const landmassCounts = new Map<number, number>();
    let minCell = Infinity;
    let outletCell = cells[0] as number;
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i] as number;
      segmentId[x] = id;
      minCell = Math.min(minCell, x);
      catchmentSet.add(arrays.catchmentId[x] as number);
      const lm = geography.physicalLandmassId[x] as number;
      if (lm >= 0) landmassCounts.set(lm, (landmassCounts.get(lm) || 0) + 1);
      if ((arrays.flowAccumulationCells[x] as number) > (arrays.flowAccumulationCells[outletCell] as number)) outletCell = x;
    }
    let dominantLandmass = -1, bestCount = -1;
    landmassCounts.forEach(function (count, lm) {
      if (count > bestCount) { bestCount = count; dominantLandmass = lm; }
    });
    return {
      id: id, alive: true, cells: cells, size: cells.length, minCell: minCell,
      catchments: catchmentSet, dominantLandmass: dominantLandmass,
      outletCell: outletCell, neighbors: new Set<number>(),
    };
  });
  for (c = 0; c < landCells.length; c++) {
    cell = landCells[c] as number;
    const sid = segmentId[cell] as number;
    for (let j = 0; j < (grid.neighborCount[cell] as number); j++) {
      const nb = grid.neighbors[cell * 6 + j] as number;
      if (!hardLand[nb]) continue;
      const other = segmentId[nb] as number;
      if (other >= 0 && other !== sid) {
        (segments[sid] as DrainageSegment).neighbors.add(other);
        (segments[other] as DrainageSegment).neighbors.add(sid);
      }
    }
  }

  function mergeSegments(survivor: DrainageSegment, removed: DrainageSegment): void {
    if (survivor === removed || !survivor.alive || !removed.alive) return;
    for (let i = 0; i < removed.cells.length; i++) {
      survivor.cells.push(removed.cells[i] as number);
      segmentId[removed.cells[i] as number] = survivor.id;
    }
    survivor.size = survivor.cells.length;
    survivor.minCell = Math.min(survivor.minCell, removed.minCell);
    removed.catchments.forEach(function (id) { survivor.catchments.add(id); });
    if ((arrays.flowAccumulationCells[removed.outletCell] as number) > (arrays.flowAccumulationCells[survivor.outletCell] as number)) {
      survivor.outletCell = removed.outletCell;
    }
    removed.neighbors.forEach(function (otherId) {
      const other = segments[otherId] as DrainageSegment | undefined;
      if (!other || !other.alive) return;
      other.neighbors.delete(removed.id);
      if (other.id !== survivor.id) {
        other.neighbors.add(survivor.id);
        survivor.neighbors.add(other.id);
      }
    });
    survivor.neighbors.delete(removed.id);
    survivor.neighbors.delete(survivor.id);
    removed.alive = false;
    removed.cells = [];
    removed.neighbors.clear();
  }

  const mergeThreshold = target * 0.85;
  for (let pass = 0; pass < 16; pass++) {
    const active = segments.filter(function (s) { return s.alive; })
      .sort(function (a, b) { return a.size - b.size || a.minCell - b.minCell; });
    let changed = false;
    for (c = 0; c < active.length; c++) {
      const seg = active[c] as DrainageSegment;
      if (!seg.alive || seg.size >= mergeThreshold) continue;
      let bestSeg: DrainageSegment | null = null;
      let bestScore = Infinity;
      seg.neighbors.forEach(function (otherId) {
        const other = segments[otherId] as DrainageSegment | undefined;
        if (!other || !other.alive || other === seg) return;
        if (seg.dominantLandmass >= 0 && other.dominantLandmass >= 0 &&
            seg.dominantLandmass !== other.dominantLandmass) return;
        let sharedCatchment = false;
        seg.catchments.forEach(function (id) { if (other.catchments.has(id)) sharedCatchment = true; });
        const score = seg.size + other.size - (sharedCatchment ? target * 0.75 : 0);
        if (score < bestScore) { bestScore = score; bestSeg = other; }
      });
      if (!bestSeg) continue;
      const best = bestSeg as DrainageSegment;
      if (seg.size + best.size > target * 2.25 && seg.size > target * 0.25) continue;
      const survivor = best.size >= seg.size ? best : seg;
      const removed = survivor === seg ? best : seg;
      mergeSegments(survivor, removed);
      changed = true;
    }
    if (!changed) break;
  }

  const finalSegments = segments.filter(function (s) { return s.alive; })
    .sort(function (a, b) { return a.minCell - b.minCell; });
  const records: DrainageRegionRecord[] = finalSegments.map(function (seg, id) {
    let areaKm2 = 0;
    let effectiveLandAreaKm2 = 0;
    for (let i = 0; i < seg.cells.length; i++) {
      const x = seg.cells[i] as number;
      arrays.drainageRegionId[x] = id;
      areaKm2 += (grid.areas[x] as number) * areaScale;
      effectiveLandAreaKm2 += (grid.areas[x] as number) * areaScale * (geography.muLand[x] as number);
    }
    const outletCatchment = arrays.catchmentId[seg.outletCell] as number;
    return {
      id: id,
      outletCell: seg.outletCell,
      cellCount: seg.cells.length,
      areaKm2: areaKm2,
      effectiveLandAreaKm2: effectiveLandAreaKm2,
      catchmentCount: seg.catchments.size,
      catchmentIds: Array.from(seg.catchments).sort(function (a, b) { return a - b; }),
      terminalType: TERMINAL_TYPE_NAMES[arrays.terminalType[seg.outletCell] as number] || 'none',
      dominantCatchmentId: outletCatchment,
      physicalLandmassId: seg.dominantLandmass,
    };
  });
  return records;
}

function computeMountains(
  grid: PlanetGrid, geography: GeographyResult, arrays: SurfaceArrays, hardLand: Uint8Array,
  thresholds: SurfaceThresholds, areaScale: number,
): { ranges: MountainRangeRecord[]; stats: MountainStats } {
  let c: number;
  let mountainArea = 0, seamArea = 0, landArea = 0;
  for (c = 0; c < grid.cellCount; c++) {
    if (!hardLand[c]) continue;
    landArea += grid.areas[c] as number;
    const heightScore = thresholds.mountainLevel > thresholds.highlandLevel
      ? smoothstep(thresholds.highlandLevel, thresholds.mountainLevel, geography.elevation[c] as number)
      : ((geography.elevation[c] as number) >= thresholds.mountainLevel ? 1 : 0);
    const slopeScore = smoothstep(thresholds.slopeP55 as number, thresholds.slopeP95 as number, arrays.slope[c] as number);
    const mountain = (geography.muLand[c] as number) * heightScore * (0.45 + 0.55 * slopeScore);
    const seamRelief = thresholds.mountainLevel > thresholds.highlandLevel
      ? smoothstep(
          thresholds.highlandLevel - (thresholds.mountainLevel - thresholds.highlandLevel) * 0.35,
          thresholds.mountainLevel, geography.elevation[c] as number)
      : heightScore;
    const seam = (geography.muLand[c] as number) * seamRelief *
      smoothstep(0.28, 0.88, geography.plateBoundary[c] as number) *
      (0.38 + 0.38 * slopeScore + 0.24 * (geography.volcanism[c] as number));
    arrays.mountainWeight[c] = clamp01(mountain);
    arrays.mountainSeamWeight[c] = clamp01(seam);
    mountainArea += (arrays.mountainWeight[c] as number) * (grid.areas[c] as number);
    seamArea += (arrays.mountainSeamWeight[c] as number) * (grid.areas[c] as number);
  }
  const mask = new Uint8Array(grid.cellCount);
  for (c = 0; c < grid.cellCount; c++) mask[c] = hardLand[c] && (arrays.mountainSeamWeight[c] as number) >= 0.42 ? 1 : 0;
  const comps = connectedComponents(grid, mask).components
    .filter(function (cells) { return cells.length >= 3; });
  const ranges: MountainRangeRecord[] = comps.map(function (cells, id) {
    let areaKm2 = 0;
    let maxElevation = -Infinity;
    let representative = cells[0] as number;
    const plateCounts = new Float64Array(PlanetGeography.PLATE_COUNT);
    for (let i = 0; i < cells.length; i++) {
      const x = cells[i] as number;
      arrays.mountainRangeId[x] = id;
      areaKm2 += (grid.areas[x] as number) * areaScale;
      if ((geography.elevation[x] as number) > maxElevation) {
        maxElevation = geography.elevation[x] as number;
        representative = x;
      }
      if ((geography.plateId[x] as number) >= 0) {
        plateCounts[geography.plateId[x] as number] = (plateCounts[geography.plateId[x] as number] as number) + 1;
      }
    }
    const plates = Array.from(plateCounts).map(function (count, plateId) {
      return { plateId: plateId, count: count };
    }).filter(function (x) { return x.count > 0; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 2).map(function (x) { return x.plateId; });
    return {
      id: id,
      representativeCell: representative,
      cellCount: cells.length,
      areaKm2: areaKm2,
      maxElevation: maxElevation,
      plateIds: plates,
    };
  });
  return {
    ranges: ranges,
    stats: {
      rangeCount: ranges.length,
      mountainAreaFraction: landArea ? mountainArea / landArea : 0,
      seamAreaFraction: landArea ? seamArea / landArea : 0,
      distribution: distributionStats(ranges.map(function (r) { return r.cellCount; })),
    },
  };
}

function computeBiomes(
  grid: PlanetGrid, geography: GeographyResult, arrays: SurfaceArrays, hardLand: Uint8Array,
  profile: SurfaceProfile, thresholds: SurfaceThresholds,
): BiomeStats {
  const n = grid.cellCount;
  const tempSpan = Math.max(0.05, thresholds.hotLevel - thresholds.coldLevel);
  const moistSpan = Math.max(0.05, thresholds.wetLevel - thresholds.aridLevel);
  const vegFactor = profile.surfaceClass === 'barren' ? 0.05
    : profile.surfaceClass === 'desert' ? 0.45
      : profile.surfaceClass === 'volcanic' ? 0.65 : 1.0;
  const iceAvailability = profile.surfaceClass === 'barren' && profile.oceanPctl <= 0 ? 0.25 : 1.0;
  const hotDesertFactor = profile.surfaceClass === 'barren' ? 0.15
    : profile.surfaceClass === 'desert' ? 1.45 : 1.0;
  let c: number, b: number;

  const coastExp = new Float64Array(n);
  const volcPow = new Float64Array(n);
  for (c = 0; c < n; c++) {
    coastExp[c] = Math.exp(-Math.max(0, geography.signedCoastDistanceCells[c] as number) / 4);
    volcPow[c] = Math.pow(geography.volcanism[c] as number, 1.5);
  }
  const params = new Float64Array([
    thresholds.coldLevel, thresholds.hotLevel, thresholds.aridLevel, thresholds.wetLevel,
    thresholds.slopeP55 as number, thresholds.slopeP95 as number,
    tempSpan, moistSpan, geography.seaLevel, geography.elevationMin, geography.elevationMax,
    geography.shelfBelowLevel, vegFactor, iceAvailability, hotDesertFactor,
    profile.surfaceClass === 'desert' ? 1 : 0,
    profile.surfaceClass === 'ice' ? 1 : 0,
    profile.surfaceClass === 'barren' ? 1 : 0,
    profile.surfaceClass === 'volcanic' ? 1.80 : 0.80,
  ]);
  let weights: Float32Array = getCore().biomeWeights({
    muOcean: geography.muOcean, muShelf: geography.muShelf, muLand: geography.muLand,
    temperature: geography.temperature, moisture: geography.moisture, elevation: geography.elevation,
    riverInfluence: arrays.riverInfluence, lakeWeight: arrays.lakeWeight, deltaWeight: arrays.deltaWeight,
    slope: arrays.slope, mountainWeight: arrays.mountainWeight, mountainSeamWeight: arrays.mountainSeamWeight,
    coastExp: coastExp, volcPow: volcPow,
  }, hardLand, params, n);

  const width = Math.max(0, Number(profile.biomeSoftWidthCells) || 0);
  if (width > 0) {
    const fullSteps = Math.floor(width);
    const fraction = width - fullSteps;
    const steps = Math.min(6, fullSteps + (fraction > 0 ? 1 : 0));
    const alphas = new Float64Array(steps);
    for (let step = 0; step < steps; step++) {
      alphas[step] = 0.42 * (step < fullSteps ? 1 : fraction);
    }
    weights = getCore().smoothBiomeWeights(weights, grid.neighbors, grid.neighborCount,
      geography.muOcean, geography.muShelf, geography.muLand,
      arrays.lakeWeight, hardLand, alphas, n);
  }

  const globalSums = new Float64Array(BIOME_COUNT);
  const landSums = new Float64Array(BIOME_COUNT);
  const top1Sums = new Float64Array(BIOME_COUNT);
  let totalArea = 0, landArea = 0, entropyWeighted = 0;
  for (c = 0; c < n; c++) {
    const base = c * BIOME_COUNT;
    let top1 = -1, top2 = -1, w1 = -1, w2 = -1;
    let r = 0, g = 0, bl = 0;
    for (b = 0; b < BIOME_COUNT; b++) {
      const w = weights[base + b] as number;
      globalSums[b] = (globalSums[b] as number) + w * (grid.areas[c] as number);
      if (hardLand[c]) landSums[b] = (landSums[b] as number) + w * (grid.areas[c] as number);
      const color = (BIOME_DEFINITIONS[b] as BiomeDefinition).color;
      r += (color[0] as number) * w; g += (color[1] as number) * w; bl += (color[2] as number) * w;
      if (w > w1) { top2 = top1; w2 = w1; top1 = b; w1 = w; }
      else if (w > w2) { top2 = b; w2 = w; }
    }
    totalArea += grid.areas[c] as number;
    if (hardLand[c]) landArea += grid.areas[c] as number;
    const topSum = w1 + Math.max(0, w2);
    const p1 = topSum > 0 ? w1 / topSum : 1;
    const p2 = topSum > 0 && top2 >= 0 ? Math.max(0, w2) / topSum : 0;
    arrays.biomeTop1Id[c] = top1;
    arrays.biomeTop1Weight[c] = p1;
    arrays.biomeTop2Id[c] = top2;
    arrays.biomeTop2Weight[c] = p2;
    let entropy = 0;
    if (p1 > 0) entropy -= p1 * Math.log(p1);
    if (p2 > 0) entropy -= p2 * Math.log(p2);
    arrays.biomeEntropy[c] = entropy / Math.LN2;
    entropyWeighted += (arrays.biomeEntropy[c] as number) * (grid.areas[c] as number);
    if (top1 >= 0) top1Sums[top1] = (top1Sums[top1] as number) + (grid.areas[c] as number);
    const shade = clamp(0.94 + (geography.detail[c] as number) * 0.08 + (arrays.mountainWeight[c] as number) * 0.05, 0.82, 1.12);
    arrays.biomeColor[c * 3] = clamp01(r * shade);
    arrays.biomeColor[c * 3 + 1] = clamp01(g * shade);
    arrays.biomeColor[c * 3 + 2] = clamp01(bl * shade);
  }
  const fractions: BiomeFraction[] = BIOME_DEFINITIONS.map(function (d, id) {
    return {
      id: id,
      key: d.key,
      globalAreaFraction: totalArea ? (globalSums[id] as number) / totalArea : 0,
      landAreaFraction: landArea ? (landSums[id] as number) / landArea : 0,
      top1AreaFraction: totalArea ? (top1Sums[id] as number) / totalArea : 0,
    };
  });
  return {
    biomeCount: BIOME_COUNT,
    meanEntropy: totalArea ? entropyWeighted / totalArea : 0,
    fractions: fractions,
  };
}

function computeHydrologyStats(
  grid: PlanetGrid, geography: GeographyResult, arrays: SurfaceArrays, hardLand: Uint8Array,
  landCellCount: number, hardLandArea: number, totalArea: number,
  catchments: CatchmentRecord[], drainageRegions: DrainageRegionRecord[],
  depressionInfo: DepressionInfo[], cycleBreakCount: number,
  profile: SurfaceProfile, thresholds: SurfaceThresholds,
): HydrologyStats {
  const terminalArea = [0, 0, 0, 0];
  let routed = 0;
  let lakeArea = 0;
  let depressionArea = 0;
  let streamCells = 0, majorCells = 0, deltaCells = 0;
  let uphillFilledEdges = 0, uphillRawOutsideDepressions = 0, checkedEdges = 0;
  let majorEdges = 0, majorUphillRawOutsideDepressions = 0;
  for (let c = 0; c < grid.cellCount; c++) {
    depressionArea += (arrays.depressionDepth[c] as number) > 1e-9 ? (grid.areas[c] as number) : 0;
    lakeArea += (arrays.lakeWeight[c] as number) * (grid.areas[c] as number);
    if ((arrays.deltaWeight[c] as number) >= 0.25) deltaCells++;
    if (!hardLand[c]) continue;
    terminalArea[arrays.terminalType[c] as number] = (terminalArea[arrays.terminalType[c] as number] as number) + (grid.areas[c] as number);
    if ((arrays.catchmentId[c] as number) >= 0) routed++;
    if ((arrays.flowAccumulationKm2[c] as number) >= thresholds.streamFlowKm2) streamCells++;
    if ((arrays.flowAccumulationKm2[c] as number) >= thresholds.majorRiverFlowKm2) majorCells++;
    const receiver = arrays.flowReceiver[c] as number;
    if (receiver >= 0) {
      checkedEdges++;
      if ((arrays.filledElevation[receiver] as number) > (arrays.filledElevation[c] as number) + 1e-9) uphillFilledEdges++;
      // Внутри priority-flood впадины маршрут идёт по уровню заполненной
      // поверхности/озера, поэтому сырой рельеф дна может локально расти.
      // Вне впадин и озёр подъём по сырой высоте — настоящая ошибка стока.
      const outsideDepression = (arrays.depressionDepth[c] as number) <= 1e-9 && (arrays.lakeWeight[c] as number) <= 0;
      const rawUphillOutside = outsideDepression &&
        (geography.elevation[receiver] as number) > (geography.elevation[c] as number) + 1e-9;
      if (rawUphillOutside) uphillRawOutsideDepressions++;
      if ((arrays.flowAccumulationKm2[c] as number) >= thresholds.majorRiverFlowKm2 && hardLand[receiver]) {
        majorEdges++;
        if (rawUphillOutside) majorUphillRawOutsideDepressions++;
      }
    }
  }
  const catchmentDist = distributionStats(catchments.map(function (r) { return r.cellCount; }));
  const drainageDist = distributionStats(drainageRegions.map(function (r) { return r.cellCount; }));
  return {
    landCells: landCellCount,
    routedLandFraction: landCellCount ? routed / landCellCount : 0,
    cycleBreakCount: cycleBreakCount,
    uphillFilledEdgeFraction: checkedEdges ? uphillFilledEdges / checkedEdges : 0,
    uphillRawEdgeFractionOutsideDepressions: checkedEdges ? uphillRawOutsideDepressions / checkedEdges : 0,
    terminalLandAreaFractions: {
      ocean: hardLandArea ? (terminalArea[TERMINAL_OCEAN] as number) / hardLandArea : 0,
      terminalLake: hardLandArea ? (terminalArea[TERMINAL_LAKE] as number) / hardLandArea : 0,
      endorheic: hardLandArea ? (terminalArea[TERMINAL_ENDORHEIC] as number) / hardLandArea : 0,
    },
    depression: {
      componentCount: depressionInfo.length,
      landAreaFraction: hardLandArea ? depressionArea / hardLandArea : 0,
      modes: depressionInfo.reduce(function (acc, info) {
        acc[info.mode] = (acc[info.mode] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    },
    lakes: {
      count: 0,
      landAreaFraction: hardLandArea ? lakeArea / hardLandArea : 0,
    },
    catchments: {
      distribution: catchmentDist,
      targetMeanCells: profile.drainageMeanCells,
    },
    drainageRegions: {
      distribution: drainageDist,
      targetMeanCells: profile.drainageMeanCells,
      meanRatio: profile.drainageMeanCells > 0 && drainageDist.count
        ? drainageDist.mean / profile.drainageMeanCells : null,
    },
    flow: {
      streamThresholdKm2: thresholds.streamFlowKm2,
      majorRiverThresholdKm2: thresholds.majorRiverFlowKm2,
      streamLandCellFraction: landCellCount ? streamCells / landCellCount : 0,
      majorRiverLandCellFraction: landCellCount ? majorCells / landCellCount : 0,
      majorRiverUphillRawOutsideDepressionsFraction: majorEdges
        ? majorUphillRawOutsideDepressions / majorEdges : 0,
      maxAccumulationKm2: catchments.reduce(function (m, r) { return Math.max(m, r.maxFlowKm2); }, 0),
    },
    deltaCellsAtWeight025: deltaCells,
    totalAreaChecked: totalArea,
  };
}

function emptyHydrologyStats(profile: SurfaceProfile): HydrologyStats {
  return {
    landCells: 0,
    routedLandFraction: 0,
    cycleBreakCount: 0,
    uphillFilledEdgeFraction: 0,
    uphillRawEdgeFractionOutsideDepressions: 0,
    terminalLandAreaFractions: { ocean: 0, terminalLake: 0, endorheic: 0 },
    depression: { componentCount: 0, landAreaFraction: 0, modes: {} },
    lakes: { count: 0, landAreaFraction: 0 },
    catchments: { distribution: distributionStats([]), targetMeanCells: profile.drainageMeanCells },
    drainageRegions: { distribution: distributionStats([]), targetMeanCells: profile.drainageMeanCells, meanRatio: null },
    flow: { streamThresholdKm2: 0, majorRiverThresholdKm2: 0, streamLandCellFraction: 0, majorRiverLandCellFraction: 0, majorRiverUphillRawOutsideDepressionsFraction: 0, maxAccumulationKm2: 0 },
    deltaCellsAtWeight025: 0,
    totalAreaChecked: 0,
  };
}

function emptyBiomeStats(): BiomeStats {
  return {
    biomeCount: BIOME_COUNT,
    meanEntropy: 0,
    fractions: BIOME_DEFINITIONS.map(function (d) {
      return { id: d.id, key: d.key, globalAreaFraction: 0, landAreaFraction: 0, top1AreaFraction: 0 };
    }),
  };
}

function augmentGeography(grid: PlanetGrid, geography: GeographyResult, options?: SurfaceOptions | null): SurfaceResult {
  const base = geography && geography.baseGeography ? geography.baseGeography : geography;
  const surface = computeSurface(grid, base, options || {});
  surface.stats.hydrology.lakes.count = surface.lakes.length;
  return surface;
}

function generateSurface(grid: PlanetGrid, input?: GeographyResult | GeographyProfileInput | null, options?: SurfaceOptions | null): SurfaceResult {
  const opts = options || {};
  if (isGeographyResult(input)) return augmentGeography(grid, input, opts);
  const userProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const geography = PlanetGeography.generateGeography(grid, baseProfileInput(input || {}), {
    onProgress: function (stage, fraction) {
      if (userProgress && stage !== 'done') userProgress(stage, fraction * 0.55);
    },
  });
  return augmentGeography(grid, geography, Object.assign({}, opts, {
    onProgress: function (stage: string, fraction: number) {
      if (userProgress) userProgress(stage, 0.55 + fraction * 0.45);
    },
  }));
}

function defaultYieldControl(): Promise<void> {
  return new Promise(function (resolve) {
    if (typeof setTimeout !== 'undefined') setTimeout(resolve, 0);
    else resolve();
  });
}

async function augmentGeographyAsync(grid: PlanetGrid, geography: GeographyResult, options?: SurfaceOptions | null): Promise<SurfaceResult> {
  const opts = options || {};
  const yieldControl = typeof opts.yieldControl === 'function' ? opts.yieldControl : defaultYieldControl;
  await yieldControl({ stage: 'surface-start' });
  return augmentGeography(grid, geography, opts);
}

async function generateSurfaceAsync(grid: PlanetGrid, input?: GeographyResult | GeographyProfileInput | null, options?: SurfaceOptions | null): Promise<SurfaceResult> {
  const opts = options || {};
  if (isGeographyResult(input)) return augmentGeographyAsync(grid, input, opts);
  const userProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const baseOptions = Object.assign({}, opts, {
    onProgress: function (stage: string, fraction: number) {
      if (userProgress && stage !== 'done') userProgress(stage, fraction * 0.55);
    },
  });
  const geography = await PlanetGeography.generateGeographyAsync(grid, baseProfileInput(input || {}),
    baseOptions as unknown as Parameters<typeof PlanetGeography.generateGeographyAsync>[2]);
  const surfaceOptions = Object.assign({}, opts, {
    onProgress: function (stage: string, fraction: number) {
      if (userProgress) userProgress(stage, 0.55 + fraction * 0.45);
    },
  });
  return augmentGeographyAsync(grid, geography, surfaceOptions);
}

function collectTypedBuffers(surface: SurfaceResult | null): ArrayBuffer[] {
  const seen = new Set<ArrayBufferLike>();
  const buffers: ArrayBuffer[] = [];
  function add(value: unknown): void {
    if (ArrayBuffer.isView(value) && value.buffer && !seen.has(value.buffer)) {
      seen.add(value.buffer);
      buffers.push(value.buffer as ArrayBuffer);
    }
  }
  if (!surface) return buffers;
  const view = surface as unknown as Record<string, unknown>;
  PlanetGeography.ARRAY_FIELDS.forEach(function (name) { add(view[name]); });
  ARRAY_FIELDS.forEach(function (name) { add(view[name]); });
  return buffers;
}

function typedBytesOf(surface: SurfaceResult | null): number {
  return collectTypedBuffers(surface).reduce(function (sum, buffer) { return sum + buffer.byteLength; }, 0);
}

function listTransferableBuffers(surface: SurfaceResult | null): ArrayBuffer[] {
  return collectTypedBuffers(surface).filter(function (buffer) { return buffer.byteLength > 1024; });
}

function packSurfaceForTransfer(surface: SurfaceResult | null): { message: SurfaceResult | null; transfer: ArrayBuffer[] } {
  return { message: surface, transfer: listTransferableBuffers(surface) };
}

function validateSurface(grid: PlanetGrid, surface: SurfaceResult | null): SurfaceValidation {
  const checks: Record<string, boolean> = {};
  if (!grid || !surface) return { ok: false, checks: { shape: false } };
  const base = surface.baseGeography || surface;
  const baseValidation = PlanetGeography.validateGeography(grid, base);
  checks.baseGeography = baseValidation.ok;
  checks.shape = surface.cellCount === grid.cellCount && surface.v === grid.v;
  checks.versions = surface.geographyVersion === SURFACE_GEOGRAPHY_VERSION &&
    surface.baseGeographyVersion === BASE_GEOGRAPHY_VERSION &&
    surface.hydrologyVersion === HYDROLOGY_VERSION &&
    surface.biomeVersion === BIOME_VERSION;
  let lengths = true;
  const surfaceView = surface as unknown as Record<string, { length: number } | undefined>;
  ARRAY_FIELDS.forEach(function (name) {
    const expected = name === 'biomeColor' ? grid.cellCount * 3 : grid.cellCount;
    const value = surfaceView[name];
    if (!value || value.length !== expected) lengths = false;
  });
  checks.arrayLengths = lengths;
  if (!lengths || !checks.shape) return { ok: false, checks: checks, baseValidation: baseValidation };

  let finite = true, ranges = true, ids = true, biomeWeightsOk = true, receivers = true;
  const floatFields: (keyof SurfaceArrays)[] = ['filledElevation', 'depressionDepth', 'slope', 'flowAccumulationKm2',
    'flowAccumulationCells', 'lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
    'mountainWeight', 'mountainSeamWeight', 'biomeTop1Weight', 'biomeTop2Weight', 'biomeEntropy'];
  const unitFields: (keyof SurfaceArrays)[] = ['lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
    'mountainWeight', 'mountainSeamWeight', 'biomeTop1Weight', 'biomeTop2Weight', 'biomeEntropy'];
  for (let c = 0; c < grid.cellCount; c++) {
    for (let i = 0; i < floatFields.length; i++) {
      if (!Number.isFinite(surface[floatFields[i] as keyof SurfaceArrays][c] as number)) finite = false;
    }
    for (let i = 0; i < unitFields.length; i++) {
      const v = surface[unitFields[i] as keyof SurfaceArrays][c] as number;
      if (v < -1e-6 || v > 1.000001) ranges = false;
    }
    if ((surface.depressionDepth[c] as number) < -1e-6 || (surface.slope[c] as number) < -1e-12 ||
        (surface.flowAccumulationKm2[c] as number) < -1e-6 || (surface.flowAccumulationCells[c] as number) < -1e-6) ranges = false;
    for (let i = 0; i < 3; i++) {
      const color = surface.biomeColor[c * 3 + i] as number;
      if (!Number.isFinite(color) || color < -1e-6 || color > 1.000001) ranges = false;
    }
    if (surface.surfaceApplicable) {
      if ((surface.catchmentId[c] as number) < -1 || (surface.catchmentId[c] as number) >= Math.max(1, surface.catchments.length) ||
          (surface.drainageRegionId[c] as number) < -1 || (surface.drainageRegionId[c] as number) >= Math.max(1, surface.drainageRegions.length) ||
          (surface.lakeId[c] as number) < -1 || (surface.lakeId[c] as number) >= Math.max(1, surface.lakes.length) ||
          (surface.mountainRangeId[c] as number) < -1 || (surface.mountainRangeId[c] as number) >= Math.max(1, surface.mountainRanges.length) ||
          (surface.terminalType[c] as number) > TERMINAL_ENDORHEIC) ids = false;
      const bw = (surface.biomeTop1Weight[c] as number) + (surface.biomeTop2Weight[c] as number);
      if ((surface.biomeTop1Id[c] as number) < 0 || (surface.biomeTop1Id[c] as number) >= BIOME_COUNT ||
          (surface.biomeTop2Id[c] as number) < -1 || (surface.biomeTop2Id[c] as number) >= BIOME_COUNT ||
          surface.biomeTop1Id[c] === surface.biomeTop2Id[c] || Math.abs(bw - 1) > 1e-4) biomeWeightsOk = false;
      const receiver = surface.flowReceiver[c] as number;
      if (receiver >= 0) {
        let isNeighbor = false;
        for (let i = 0; i < (grid.neighborCount[c] as number); i++) {
          if (grid.neighbors[c * 6 + i] === receiver) { isNeighbor = true; break; }
        }
        if (!isNeighbor) receivers = false;
      }
    }
  }
  checks.finite = finite;
  checks.ranges = ranges;
  checks.ids = surface.surfaceApplicable ? ids : true;
  checks.biomeWeights = surface.surfaceApplicable ? biomeWeightsOk : true;
  checks.flowReceivers = surface.surfaceApplicable ? receivers : true;
  checks.flowAcyclic = surface.surfaceApplicable ? validateFlowAcyclic(grid, surface) : true;
  checks.stats = !!(surface.stats && surface.stats.hydrology && surface.stats.biomes && surface.stats.mountains);
  const ok = Object.keys(checks).every(function (key) { return checks[key]; });
  return { ok: ok, checks: checks, typedBytes: typedBytesOf(surface), baseValidation: baseValidation };
}

function validateFlowAcyclic(grid: PlanetGrid, surface: SurfaceResult): boolean {
  const state = new Uint8Array(grid.cellCount);
  const stack: number[] = [];
  for (let start = 0; start < grid.cellCount; start++) {
    if (state[start] === 2 || (surface.flowReceiver[start] as number) < -1) continue;
    let cell = start;
    stack.length = 0;
    while (cell >= 0 && state[cell] === 0) {
      state[cell] = 1;
      stack.push(cell);
      cell = surface.flowReceiver[cell] as number;
      if (cell >= 0 && state[cell] === 1) return false;
    }
    for (let i = 0; i < stack.length; i++) state[stack[i] as number] = 2;
  }
  return true;
}

const PlanetSurface = {
  BASE_GEOGRAPHY_VERSION: BASE_GEOGRAPHY_VERSION,
  SURFACE_GEOGRAPHY_VERSION: SURFACE_GEOGRAPHY_VERSION,
  SURFACE_VERSION: SURFACE_VERSION,
  GEOGRAPHY_VERSION: SURFACE_GEOGRAPHY_VERSION,
  HYDROLOGY_VERSION: HYDROLOGY_VERSION,
  BIOME_VERSION: BIOME_VERSION,
  BIOME_DEFINITIONS: cloneBiomeDefinitions(),
  BIOME_COUNT: BIOME_COUNT,
  ARRAY_FIELDS: ARRAY_FIELDS.slice(),
  TERMINAL_TYPES: {
    NONE: TERMINAL_NONE,
    OCEAN: TERMINAL_OCEAN,
    TERMINAL_LAKE: TERMINAL_LAKE,
    ENDORHEIC: TERMINAL_ENDORHEIC,
  },
  TERMINAL_TYPE_NAMES: TERMINAL_TYPE_NAMES.slice(),
  normalizeSurfaceProfile: normalizeSurfaceProfile,
  generateSurface: generateSurface,
  generateSurfaceAsync: generateSurfaceAsync,
  augmentGeography: augmentGeography,
  augmentGeographyAsync: augmentGeographyAsync,
  validateSurface: validateSurface,
  typedBytesOf: typedBytesOf,
  listTransferableBuffers: listTransferableBuffers,
  packSurfaceForTransfer: packSurfaceForTransfer,
  DEFAULT_PROFILE: normalizeSurfaceProfile({}),
};

export default PlanetSurface;

declare global {
  interface Window {
    PlanetSurface: typeof PlanetSurface;
  }
}

(globalThis as unknown as { PlanetSurface: typeof PlanetSurface }).PlanetSurface = PlanetSurface;
