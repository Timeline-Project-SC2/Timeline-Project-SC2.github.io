/* PlanetGeography — география планеты c100-soft-v1 для TIMELINE PROJECT.
   Строгий TS-порт planet-geography.js (CR-01 PR 4, И-5/И-6): горячие циклы
   (сэмплер полей, стоимости рёбер, Дейкстры top-1/top-2, береговая
   дистанция, жадный выбор семян) выполняет Wasm-ускоритель planet-core,
   повторяя JS-арифметику побитово (И-2: извлечение PQ строго по
   (key, cellIndex)). Публичный API и все формулы сохранены дословно. */

import { CONTRACT, getPresetRuntimeValues } from './planet-generation-contract.ts';
import PlanetNoise, { buildSimplexTable } from './planet-noise.ts';
import { getSharedPlanetCore, type PlanetCore } from '../../src/planet/planet-core-host.ts';
import type { PlanetGrid } from './geodesic-grid.ts';

export interface GeographyProfile {
  masterSeedHex: string;
  radiusKm: number;
  surfaceClass: string;
  presetId: string;
  gridVersion: string;
  noiseVersion: string;
  geographyVersion: string;
  presetVersion: string;
  continentMeanCells: number;
  continentVariation: number;
  oceanBasinMeanCells: number;
  drainageMeanCells: number;
  oceanPctl: number;
  shelfBelowPctl: number;
  shelfAbovePctl: number;
  highlandLandPctl: number;
  mountainLandPctl: number;
  aridLandPctl: number;
  wetLandPctl: number;
  coldPctl: number;
  hotPctl: number;
  streamFlowPctl: number;
  majorRiverFlowPctl: number;
  coastSoftWidthCells: number;
  continentSoftWidthCells: number;
  biomeSoftWidthCells: number;
  transitionEntropyPctl: number;
}

export type GeographyProfileInput = Record<string, unknown>;

export interface GeographyArrays {
  elevation: Float32Array;
  moisture: Float32Array;
  temperature: Float32Array;
  plateAffinity: Float32Array;
  volcanism: Float32Array;
  detail: Float32Array;
  muLand: Float32Array;
  muShelf: Float32Array;
  muOcean: Float32Array;
  signedCoastDistanceCells: Float32Array;
  plateId: Int32Array;
  plateBoundary: Float32Array;
  continentSupport: Float32Array;
  continentTop1Id: Int32Array;
  continentTop1Weight: Float32Array;
  continentTop2Id: Int32Array;
  continentTop2Weight: Float32Array;
  continentEntropy: Float32Array;
  oceanSupport: Float32Array;
  oceanBasinId: Int32Array;
  oceanBasinWeight: Float32Array;
  physicalLandmassId: Int32Array;
}

export interface DistributionStats {
  count: number;
  sum: number;
  mean: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
}

export interface RegionRecord {
  id: number;
  seedCell: number;
  desiredMassCells: number;
  effectiveMassCells: number;
  effectiveAreaKm2: number;
  hardCellCount: number;
}

export interface PlateRecord {
  id: number;
  seedDirection: number[];
  cellCount: number;
  supportAreaKm2: number;
}

export interface LandmassStatsEntry {
  threshold: number;
  landCells: number;
  count: number;
  medianCells: number;
  p90Cells: number;
  maxCells: number;
  largestShare: number;
  tinyIslandsUnder5: number;
  ids?: Int32Array;
}

export interface GeographyStats {
  oceanFractionHard: number;
  oceanFractionTarget: number;
  softFractions: { land: number; shelf: number; ocean: number };
  continents: {
    distribution: DistributionStats;
    targetMeanCells: number;
    coreSupportFraction?: number;
    transitionSupportFraction?: number;
    meanEntropy?: number;
  };
  oceanBasins: { distribution: DistributionStats; targetMeanCells: number };
  plates: { distribution: DistributionStats };
  landmasses: LandmassStatsEntry[];
  climate: {
    equatorTemperature: number;
    polarTemperature: number;
    temperatureInsolationCorrelation: number;
  };
}

export interface GeographyResult extends GeographyArrays {
  // Заполняется только PlanetSurface на augmented-результате; чистая
  // география поля не имеет (JS-эталон обращается к нему как к undefined).
  baseGeography?: GeographyResult;
  surfaceApplicable: boolean;
  gridVersion: string;
  noiseVersion: string;
  geographyVersion: string;
  presetVersion: string;
  profile: GeographyProfile;
  v: number;
  expectedFrequency: number;
  frequencyMatchesProfile: boolean;
  cellCount: number;
  radiusKm: number;
  seaLevel: number;
  shelfBelowLevel: number;
  shelfAboveLevel: number;
  elevationMin: number;
  elevationMax: number;
  continents: RegionRecord[];
  oceanBasins: RegionRecord[];
  plates: PlateRecord[];
  stats: GeographyStats | null;
}

export interface FieldSampler {
  sampleFields(x: number, y: number, z: number, out?: Float32Array): Float32Array;
  sampleDirection(direction: ArrayLike<number>, out?: Float32Array): Float32Array;
  profile: GeographyProfile;
  masterSeedHex: string;
  masterSeedHi: number;
  masterSeedLo: number;
  noiseVersion: string;
  geographyVersion: string;
}

interface FieldSamplerInternal extends FieldSampler {
  batchTables: Uint8Array;
  batchParams: Float64Array;
}

export interface GenerateGeographyOptions {
  onProgress?: (stage: string, fraction: number) => void;
  chunkCells?: number;
  yieldControl?: (info: { stage: string; start: number; end: number }) => unknown;
}

export interface GeographyValidation {
  ok: boolean;
  checks: Record<string, boolean>;
  typedBytes?: number;
}

const GENERATION_CONTRACT = CONTRACT;

function presetRuntimeValues(presetId: string): Record<string, number> {
  return getPresetRuntimeValues(presetId);
}

const GRID_VERSION = GENERATION_CONTRACT.default_versions.grid_version as string;
const NOISE_VERSION = GENERATION_CONTRACT.default_versions.noise_version as string;
// Этот модуль реализует именно legacy-поля/C100 v1; полный v2 собирается
// PlanetSurface поверх него. Версия обязана оставаться в supported_versions
// канонического контракта, а не молча становиться его дефолтной v2.
const GEOGRAPHY_VERSION = 'c100-soft-v1';
if ((GENERATION_CONTRACT.supported_versions.geography_version as readonly string[]).indexOf(GEOGRAPHY_VERSION) < 0) {
  throw new Error('PlanetGeography: контракт не поддерживает ' + GEOGRAPHY_VERSION);
}
const PRESET_VERSION = GENERATION_CONTRACT.default_versions.preset_version as string;
const SURFACE_CLASSES = GENERATION_CONTRACT.surface_classes.slice();
const EARTH_RADIUS_KM = 6371;
const EARTH_CANONICAL_V = 128;
const PLATE_COUNT = 7;
// Профильная continent_variation задаёт целевой разброс уже эффективных
// масс. Барьеры и bias-балансировка частично регрессируют распределение
// к среднему даже при desired-aware расстановке семян, поэтому внутренний
// набор желаемых масс строится шире. Коэффициент выбран по ансамблям
// v=128 так, чтобы earthlike_balanced при variation=0.8 давал фактическую
// sigma эффективных масс около 0.8 без заметной доли пустых идентичностей.
const CONTINENT_DESIRED_VARIATION_GAIN = 1.25;

const FIELD_INDEX = {
  elevation: 0,
  moisture: 1,
  temperatureBase: 2,
  plateAffinity: 3,
  volcanism: 4,
  detail: 5,
} as const;

const ARRAY_FIELDS = [
  'elevation', 'moisture', 'temperature', 'plateAffinity', 'volcanism', 'detail',
  'muLand', 'muShelf', 'muOcean', 'signedCoastDistanceCells',
  'plateId', 'plateBoundary',
  'continentSupport', 'continentTop1Id', 'continentTop1Weight',
  'continentTop2Id', 'continentTop2Weight', 'continentEntropy',
  'oceanSupport', 'oceanBasinId', 'oceanBasinWeight', 'physicalLandmassId',
] as const;

const DEFAULT_PROFILE = Object.assign({
  masterSeedHex: '0123456789abcdef',
  radiusKm: EARTH_RADIUS_KM,
  surfaceClass: 'terrestrial',
  presetId: 'earthlike_balanced',
  gridVersion: GRID_VERSION,
  noiseVersion: NOISE_VERSION,
  geographyVersion: GEOGRAPHY_VERSION,
  presetVersion: PRESET_VERSION,
}, presetRuntimeValues('earthlike_balanced')) as unknown as GeographyProfile;

const sharedCore = getSharedPlanetCore();
function getCore(): PlanetCore {
  return sharedCore;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}
function clamp01(x: number): number {
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}
function smoothstep01(x: number): number {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const encoded = unescape(encodeURIComponent(text));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
  return out;
}

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

const XX_P1 = 2654435761;
const XX_P2 = 2246822519;
const XX_P3 = 3266489917;
const XX_P4 = 668265263;
const XX_P5 = 374761393;

function xxHash32(input: string | Uint8Array, seed?: number): number {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  const seed32 = (seed || 0) >>> 0;
  const len = bytes.length;
  let p = 0;
  let h: number;
  function readU32(offset: number): number {
    return ((bytes[offset] as number) | ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) | ((bytes[offset + 3] as number) << 24)) >>> 0;
  }
  function round(acc: number, value: number): number {
    acc = (acc + Math.imul(value, XX_P2)) >>> 0;
    acc = rotl32(acc, 13);
    return Math.imul(acc, XX_P1) >>> 0;
  }
  if (len >= 16) {
    let v1 = (seed32 + XX_P1 + XX_P2) >>> 0;
    let v2 = (seed32 + XX_P2) >>> 0;
    let v3 = seed32 >>> 0;
    let v4 = (seed32 - XX_P1) >>> 0;
    const limit = len - 16;
    while (p <= limit) {
      v1 = round(v1, readU32(p)); p += 4;
      v2 = round(v2, readU32(p)); p += 4;
      v3 = round(v3, readU32(p)); p += 4;
      v4 = round(v4, readU32(p)); p += 4;
    }
    h = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    h = (seed32 + XX_P5) >>> 0;
  }
  h = (h + len) >>> 0;
  while (p <= len - 4) {
    h = (h + Math.imul(readU32(p), XX_P3)) >>> 0;
    h = Math.imul(rotl32(h, 17), XX_P4) >>> 0;
    p += 4;
  }
  while (p < len) {
    h = (h + Math.imul(bytes[p] as number, XX_P5)) >>> 0;
    h = Math.imul(rotl32(h, 11), XX_P1) >>> 0;
    p++;
  }
  h ^= h >>> 15;
  h = Math.imul(h, XX_P2) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, XX_P3) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function hex32(value: number): string {
  return ('00000000' + (value >>> 0).toString(16)).slice(-8);
}

function masterSeedHexFromText(text: unknown): string {
  const value = String(text == null ? 'planet' : text);
  const hi = PlanetNoise.stringSeed(value);
  const lo = PlanetNoise.stringSeed(value + '\u0000' + GEOGRAPHY_VERSION);
  return hex32(hi) + hex32(lo);
}

export interface MasterSeed {
  hex: string;
  hi: number;
  lo: number;
}

function parseMasterSeedHex(masterSeedHex: string): MasterSeed {
  if (typeof masterSeedHex !== 'string' || !/^[0-9a-fA-F]{16}$/.test(masterSeedHex)) {
    throw new Error('PlanetGeography: masterSeedHex должен содержать ровно 16 hex-цифр');
  }
  return {
    hex: masterSeedHex.toLowerCase(),
    hi: parseInt(masterSeedHex.slice(0, 8), 16) >>> 0,
    lo: parseInt(masterSeedHex.slice(8, 16), 16) >>> 0,
  };
}

function domainSeed(master: MasterSeed, domain: string): number {
  const prefix = utf8Bytes(NOISE_VERSION);
  const name = utf8Bytes(domain);
  const bytes = new Uint8Array(prefix.length + 1 + name.length + 1 + 8);
  bytes.set(prefix, 0);
  bytes[prefix.length] = 0;
  bytes.set(name, prefix.length + 1);
  const offset = prefix.length + 1 + name.length;
  bytes[offset] = 0;
  const view = new DataView(bytes.buffer);
  view.setUint32(offset + 1, master.hi, true);
  view.setUint32(offset + 5, master.lo, true);
  return xxHash32(bytes, 0);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function profileValue(src: GeographyProfileInput, camel: string, snake: string, fallback: unknown): unknown {
  if (src[camel] != null && src[camel] !== '') return src[camel];
  if (src[snake] != null && src[snake] !== '') return src[snake];
  return fallback;
}

function normalizeProfile(input?: GeographyProfileInput | null): GeographyProfile {
  const src: GeographyProfileInput = input || {};
  let masterSeedHex = profileValue(src, 'masterSeedHex', 'master_seed_hex', null);
  if (masterSeedHex == null) {
    masterSeedHex = src.seedText != null || src.seed_text != null
      ? masterSeedHexFromText(src.seedText != null ? src.seedText : src.seed_text)
      : DEFAULT_PROFILE.masterSeedHex;
  }
  const profile: GeographyProfile = {
    masterSeedHex: parseMasterSeedHex(String(masterSeedHex)).hex,
    radiusKm: finiteOr(profileValue(src, 'radiusKm', 'radius_km', DEFAULT_PROFILE.radiusKm), DEFAULT_PROFILE.radiusKm),
    surfaceClass: String(profileValue(src, 'surfaceClass', 'surface_class', DEFAULT_PROFILE.surfaceClass)),
    presetId: String(profileValue(src, 'presetId', 'preset_id', DEFAULT_PROFILE.presetId)),
    gridVersion: String(profileValue(src, 'gridVersion', 'grid_version', DEFAULT_PROFILE.gridVersion)),
    noiseVersion: String(profileValue(src, 'noiseVersion', 'noise_version', DEFAULT_PROFILE.noiseVersion)),
    geographyVersion: String(profileValue(src, 'geographyVersion', 'geography_version', DEFAULT_PROFILE.geographyVersion)),
    presetVersion: String(profileValue(src, 'presetVersion', 'preset_version', DEFAULT_PROFILE.presetVersion)),
    continentMeanCells: finiteOr(profileValue(src, 'continentMeanCells', 'continent_mean_cells', DEFAULT_PROFILE.continentMeanCells), DEFAULT_PROFILE.continentMeanCells),
    continentVariation: finiteOr(profileValue(src, 'continentVariation', 'continent_variation', DEFAULT_PROFILE.continentVariation), DEFAULT_PROFILE.continentVariation),
    oceanBasinMeanCells: finiteOr(profileValue(src, 'oceanBasinMeanCells', 'ocean_basin_mean_cells', DEFAULT_PROFILE.oceanBasinMeanCells), DEFAULT_PROFILE.oceanBasinMeanCells),
    drainageMeanCells: finiteOr(profileValue(src, 'drainageMeanCells', 'drainage_mean_cells', DEFAULT_PROFILE.drainageMeanCells), DEFAULT_PROFILE.drainageMeanCells),
    oceanPctl: finiteOr(profileValue(src, 'oceanPctl', 'ocean_pctl', DEFAULT_PROFILE.oceanPctl), DEFAULT_PROFILE.oceanPctl),
    shelfBelowPctl: finiteOr(profileValue(src, 'shelfBelowPctl', 'shelf_below_pctl', DEFAULT_PROFILE.shelfBelowPctl), DEFAULT_PROFILE.shelfBelowPctl),
    shelfAbovePctl: finiteOr(profileValue(src, 'shelfAbovePctl', 'shelf_above_pctl', DEFAULT_PROFILE.shelfAbovePctl), DEFAULT_PROFILE.shelfAbovePctl),
    highlandLandPctl: finiteOr(profileValue(src, 'highlandLandPctl', 'highland_land_pctl', DEFAULT_PROFILE.highlandLandPctl), DEFAULT_PROFILE.highlandLandPctl),
    mountainLandPctl: finiteOr(profileValue(src, 'mountainLandPctl', 'mountain_land_pctl', DEFAULT_PROFILE.mountainLandPctl), DEFAULT_PROFILE.mountainLandPctl),
    aridLandPctl: finiteOr(profileValue(src, 'aridLandPctl', 'arid_land_pctl', DEFAULT_PROFILE.aridLandPctl), DEFAULT_PROFILE.aridLandPctl),
    wetLandPctl: finiteOr(profileValue(src, 'wetLandPctl', 'wet_land_pctl', DEFAULT_PROFILE.wetLandPctl), DEFAULT_PROFILE.wetLandPctl),
    coldPctl: finiteOr(profileValue(src, 'coldPctl', 'cold_pctl', DEFAULT_PROFILE.coldPctl), DEFAULT_PROFILE.coldPctl),
    hotPctl: finiteOr(profileValue(src, 'hotPctl', 'hot_pctl', DEFAULT_PROFILE.hotPctl), DEFAULT_PROFILE.hotPctl),
    streamFlowPctl: finiteOr(profileValue(src, 'streamFlowPctl', 'stream_flow_pctl', DEFAULT_PROFILE.streamFlowPctl), DEFAULT_PROFILE.streamFlowPctl),
    majorRiverFlowPctl: finiteOr(profileValue(src, 'majorRiverFlowPctl', 'major_river_flow_pctl', DEFAULT_PROFILE.majorRiverFlowPctl), DEFAULT_PROFILE.majorRiverFlowPctl),
    coastSoftWidthCells: finiteOr(profileValue(src, 'coastSoftWidthCells', 'coast_soft_width_cells', DEFAULT_PROFILE.coastSoftWidthCells), DEFAULT_PROFILE.coastSoftWidthCells),
    continentSoftWidthCells: finiteOr(profileValue(src, 'continentSoftWidthCells', 'continent_soft_width_cells', DEFAULT_PROFILE.continentSoftWidthCells), DEFAULT_PROFILE.continentSoftWidthCells),
    biomeSoftWidthCells: finiteOr(profileValue(src, 'biomeSoftWidthCells', 'biome_soft_width_cells', DEFAULT_PROFILE.biomeSoftWidthCells), DEFAULT_PROFILE.biomeSoftWidthCells),
    transitionEntropyPctl: finiteOr(profileValue(src, 'transitionEntropyPctl', 'transition_entropy_pctl', DEFAULT_PROFILE.transitionEntropyPctl), DEFAULT_PROFILE.transitionEntropyPctl),
  };
  if (profile.noiseVersion !== NOISE_VERSION) {
    throw new Error('PlanetGeography: неподдерживаемая noiseVersion ' + profile.noiseVersion);
  }
  if (profile.geographyVersion !== GEOGRAPHY_VERSION) {
    throw new Error('PlanetGeography: неподдерживаемая geographyVersion ' + profile.geographyVersion);
  }
  if (profile.gridVersion !== GRID_VERSION) {
    throw new Error('PlanetGeography: неподдерживаемая gridVersion ' + profile.gridVersion);
  }
  if (SURFACE_CLASSES.indexOf(profile.surfaceClass) < 0) {
    throw new Error('PlanetGeography: неподдерживаемая surfaceClass ' + profile.surfaceClass);
  }
  if (!(profile.radiusKm > 0)) throw new Error('PlanetGeography: radiusKm должно быть > 0');
  if (!(profile.continentMeanCells > 0) || !(profile.oceanBasinMeanCells > 0) || !(profile.drainageMeanCells > 0)) {
    throw new Error('PlanetGeography: целевые размеры в ячейках должны быть > 0');
  }
  if (profile.continentVariation < 0) throw new Error('PlanetGeography: continentVariation не может быть отрицательной');
  const pctFields = ['oceanPctl', 'shelfBelowPctl', 'shelfAbovePctl', 'highlandLandPctl',
    'mountainLandPctl', 'aridLandPctl', 'wetLandPctl', 'coldPctl', 'hotPctl',
    'streamFlowPctl', 'majorRiverFlowPctl', 'transitionEntropyPctl'];
  const profileNumbers = profile as unknown as Record<string, number>;
  for (let i = 0; i < pctFields.length; i++) {
    const value = profileNumbers[pctFields[i] as string] as number;
    if (!(value >= 0 && value <= 100)) throw new Error('PlanetGeography: ' + pctFields[i] + ' вне диапазона 0..100');
  }
  if (!(profile.shelfBelowPctl <= profile.oceanPctl && profile.oceanPctl <= profile.shelfAbovePctl)) {
    throw new Error('PlanetGeography: требуется shelfBelowPctl <= oceanPctl <= shelfAbovePctl');
  }
  if (profile.coastSoftWidthCells < 0 || profile.continentSoftWidthCells < 0 || profile.biomeSoftWidthCells < 0) {
    throw new Error('PlanetGeography: ширины мягких переходов не могут быть отрицательными');
  }
  return profile;
}

function offsetVector(seed: number): [number, number, number] {
  const rng = mulberry32(seed);
  return [(rng() * 2 - 1) * 256, (rng() * 2 - 1) * 256, (rng() * 2 - 1) * 256];
}

function createFieldSampler(input?: GeographyProfileInput | null): FieldSamplerInternal {
  const profile = normalizeProfile(input);
  const master = parseMasterSeedHex(profile.masterSeedHex);
  const ratio = profile.radiusKm / EARTH_RADIUS_KM;
  const climateRatio = Math.sqrt(ratio);
  const seedE = domainSeed(master, 'elevation');
  const seedM = domainSeed(master, 'moisture');
  const seedT = domainSeed(master, 'temperature');
  const seedP = domainSeed(master, 'plates');
  const seedV = domainSeed(master, 'volcanism');
  const seedD = domainSeed(master, 'detail');
  const seedW = domainSeed(master, 'warp');
  let elevNoise: ((x: number, y: number, z: number) => number) | null = null;
  let moistNoise: ((x: number, y: number, z: number) => number) | null = null;
  let tempNoise: ((x: number, y: number, z: number) => number) | null = null;
  let plateNoise: ((x: number, y: number, z: number) => number) | null = null;
  let volcNoise: ((x: number, y: number, z: number) => number) | null = null;
  let detailNoise: ((x: number, y: number, z: number) => number) | null = null;
  let warpNoise: ((x: number, y: number, z: number) => number) | null = null;
  const offE = offsetVector(domainSeed(master, 'offset:elevation'));
  const offM = offsetVector(domainSeed(master, 'offset:moisture'));
  const offT = offsetVector(domainSeed(master, 'offset:temperature'));
  const offP = offsetVector(domainSeed(master, 'offset:plates'));
  const offV = offsetVector(domainSeed(master, 'offset:volcanism'));
  const offD = offsetVector(domainSeed(master, 'offset:detail'));
  const offW = offsetVector(domainSeed(master, 'offset:warp'));

  // Пакетные таблицы/параметры для Wasm-сэмплера полей: порядок доменов
  // E/M/T/P/V/D/W совпадает с раскладкой ядра sampleFieldsBatch.
  const batchTables = new Uint8Array(7 * 1024);
  batchTables.set(buildSimplexTable(seedE), 0);
  batchTables.set(buildSimplexTable(seedM), 1024);
  batchTables.set(buildSimplexTable(seedT), 2048);
  batchTables.set(buildSimplexTable(seedP), 3072);
  batchTables.set(buildSimplexTable(seedV), 4096);
  batchTables.set(buildSimplexTable(seedD), 5120);
  batchTables.set(buildSimplexTable(seedW), 6144);
  const batchParams = new Float64Array(23);
  batchParams[0] = ratio;
  batchParams[1] = climateRatio;
  batchParams.set(offE, 2);
  batchParams.set(offM, 5);
  batchParams.set(offT, 8);
  batchParams.set(offP, 11);
  batchParams.set(offV, 14);
  batchParams.set(offD, 17);
  batchParams.set(offW, 20);

  function sampleFields(x: number, y: number, z: number, out?: Float32Array): Float32Array {
    const len = Math.sqrt(x * x + y * y + z * z);
    if (!(len > 0) || !Number.isFinite(len)) throw new Error('PlanetGeography.sampleFields: направление должно быть ненулевым');
    if (!elevNoise) {
      elevNoise = PlanetNoise.makeNoise('simplex', seedE);
      moistNoise = PlanetNoise.makeNoise('simplex', seedM);
      tempNoise = PlanetNoise.makeNoise('simplex', seedT);
      plateNoise = PlanetNoise.makeNoise('simplex', seedP);
      volcNoise = PlanetNoise.makeNoise('simplex', seedV);
      detailNoise = PlanetNoise.makeNoise('simplex', seedD);
      warpNoise = PlanetNoise.makeNoise('simplex', seedW);
    }
    const nx = x / len, ny = y / len, nz = z / len;
    const target = out || new Float32Array(6);

    const warpFreq = 0.85 * ratio;
    const wx = (warpNoise as (x: number, y: number, z: number) => number)(nx * warpFreq + offW[0], ny * warpFreq + offW[1], nz * warpFreq + offW[2]);
    const wy = (warpNoise as (x: number, y: number, z: number) => number)(nx * warpFreq + offW[1], ny * warpFreq + offW[2], nz * warpFreq + offW[0]);
    const wz = (warpNoise as (x: number, y: number, z: number) => number)(nx * warpFreq + offW[2], ny * warpFreq + offW[0], nz * warpFreq + offW[1]);
    const along = wx * nx + wy * ny + wz * nz;
    const warpAmp = 0.14 / Math.max(0.25, ratio);
    let dx = nx + (wx - along * nx) * warpAmp;
    let dy = ny + (wy - along * ny) * warpAmp;
    let dz = nz + (wz - along * nz) * warpAmp;
    const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dlen; dy /= dlen; dz /= dlen;

    const plate = PlanetNoise.fbm(plateNoise as (x: number, y: number, z: number) => number,
      nx * 1.12 + offP[0], ny * 1.12 + offP[1], nz * 1.12 + offP[2], 3, 2.0, 0.52);
    const elevationFreq = 2.15 * ratio;
    const base = PlanetNoise.fbm(elevNoise,
      dx * elevationFreq + offE[0], dy * elevationFreq + offE[1], dz * elevationFreq + offE[2],
      5, 2.0, 0.5);
    const detailFreq = 9.0 * ratio;
    const detail = PlanetNoise.fbm(detailNoise as (x: number, y: number, z: number) => number,
      dx * detailFreq + offD[0], dy * detailFreq + offD[1], dz * detailFreq + offD[2],
      3, 2.0, 0.55);
    const elevation = clamp(0.74 * base + 0.30 * plate + 0.10 * detail, -1, 1);

    const moistureFreq = 2.9 * climateRatio;
    const moistureRaw = PlanetNoise.fbm(moistNoise as (x: number, y: number, z: number) => number,
      dx * moistureFreq + offM[0], dy * moistureFreq + offM[1], dz * moistureFreq + offM[2],
      4, 2.0, 0.5);
    const moisture = clamp01(0.5 + 0.5 * moistureRaw + 0.04 * plate);

    const tempFreq = 1.7 * climateRatio;
    const tempAnomaly = (tempNoise as (x: number, y: number, z: number) => number)(nx * tempFreq + offT[0], ny * tempFreq + offT[1], nz * tempFreq + offT[2]);
    const insolation = Math.sqrt(Math.max(0, 1 - ny * ny));
    const temperatureBase = clamp01(0.72 * insolation + 0.28 * (tempAnomaly * 0.5 + 0.5));

    const volcFreq = 3.6 * ratio;
    const volcRaw = PlanetNoise.fbm(volcNoise as (x: number, y: number, z: number) => number,
      nx * volcFreq + offV[0], ny * volcFreq + offV[1], nz * volcFreq + offV[2],
      3, 2.0, 0.55);
    const volcanism = Math.pow(clamp01(volcRaw * 0.5 + 0.5), 1.5);

    target[FIELD_INDEX.elevation] = elevation;
    target[FIELD_INDEX.moisture] = moisture;
    target[FIELD_INDEX.temperatureBase] = temperatureBase;
    target[FIELD_INDEX.plateAffinity] = clamp01(plate * 0.5 + 0.5);
    target[FIELD_INDEX.volcanism] = volcanism;
    target[FIELD_INDEX.detail] = clamp(detail, -1, 1);
    return target;
  }

  return {
    sampleFields,
    sampleDirection: function (direction: ArrayLike<number>, out?: Float32Array): Float32Array {
      return sampleFields(direction[0] as number, direction[1] as number, direction[2] as number, out);
    },
    profile,
    masterSeedHex: master.hex,
    masterSeedHi: master.hi,
    masterSeedLo: master.lo,
    noiseVersion: NOISE_VERSION,
    geographyVersion: GEOGRAPHY_VERSION,
    batchTables,
    batchParams,
  };
}

function allocateGeographyArrays(cellCount: number): GeographyArrays {
  return {
    elevation: new Float32Array(cellCount),
    moisture: new Float32Array(cellCount),
    temperature: new Float32Array(cellCount),
    plateAffinity: new Float32Array(cellCount),
    volcanism: new Float32Array(cellCount),
    detail: new Float32Array(cellCount),
    muLand: new Float32Array(cellCount),
    muShelf: new Float32Array(cellCount),
    muOcean: new Float32Array(cellCount),
    signedCoastDistanceCells: new Float32Array(cellCount),
    plateId: new Int32Array(cellCount).fill(-1),
    plateBoundary: new Float32Array(cellCount),
    continentSupport: new Float32Array(cellCount),
    continentTop1Id: new Int32Array(cellCount).fill(-1),
    continentTop1Weight: new Float32Array(cellCount),
    continentTop2Id: new Int32Array(cellCount).fill(-1),
    continentTop2Weight: new Float32Array(cellCount),
    continentEntropy: new Float32Array(cellCount),
    oceanSupport: new Float32Array(cellCount),
    oceanBasinId: new Int32Array(cellCount).fill(-1),
    oceanBasinWeight: new Float32Array(cellCount),
    physicalLandmassId: new Int32Array(cellCount).fill(-1),
  };
}

function sampleGridFields(
  grid: PlanetGrid, sampler: FieldSamplerInternal, arrays: GeographyArrays,
  start: number, end: number, temperatureBase: Float32Array,
): void {
  const count = end - start;
  if (count <= 0) return;
  const batch = getCore().sampleFields(sampler.batchTables, sampler.batchParams, grid.centers, start, count);
  const fields = batch.fields;
  const volcPre = batch.volcPre;
  const elevation = arrays.elevation;
  const moisture = arrays.moisture;
  const plateAffinity = arrays.plateAffinity;
  const volcanism = arrays.volcanism;
  const detail = arrays.detail;
  for (let c = start; c < end; c++) {
    const idx = c - start;
    const o = idx * 6;
    elevation[c] = fields[o] as number;
    moisture[c] = fields[o + 1] as number;
    temperatureBase[c] = fields[o + 2] as number;
    plateAffinity[c] = fields[o + 3] as number;
    // Math.pow остаётся host-сторонним (платформенная трансцендентная
    // функция): ядро отдаёт clamp01(volcRaw/2+0.5) в f64.
    const vp = volcPre[idx] as number;
    volcanism[c] = vp === 0 ? 0 : Math.pow(vp, 1.5);
    detail[c] = fields[o + 5] as number;
  }
}

let geoInitOrderBuf = new Uint32Array(163842);
for (let k = 0; k < 163842; k++) geoInitOrderBuf[k] = k;
let geoCumulativeBuf = new Float64Array(163842);

function makeWeightedQuantiles(values: Float32Array, weights: Float32Array): (q: number) => number {
  const n = values.length;
  if (geoInitOrderBuf.length < n) {
    geoInitOrderBuf = new Uint32Array(n);
    for (let k = 0; k < n; k++) geoInitOrderBuf[k] = k;
    geoCumulativeBuf = new Float64Array(n);
  }
  const initOrder = geoInitOrderBuf.subarray(0, n);
  let i: number;
  const order = n > 0
    ? getCore().radixOrderF32(values, initOrder, false, false)
    : initOrder;
  const cumulative = geoCumulativeBuf.subarray(0, order.length);
  let total = 0;
  for (i = 0; i < order.length; i++) {
    total += weights[order[i] as number] as number;
    cumulative[i] = total;
  }
  return function quantile(q: number): number {
    if (!order.length) return 0;
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

interface CoastResult {
  hardLand: Uint8Array;
  signedDistance: Float32Array;
}

function computeCoastDistance(
  grid: PlanetGrid, elevation: Float32Array, seaLevel: number, profile: GeographyProfile,
): CoastResult {
  const count = grid.cellCount;
  const hardLand = new Uint8Array(count);
  let c: number;
  if (profile.oceanPctl <= 0) hardLand.fill(1);
  else if (profile.oceanPctl < 100) {
    for (c = 0; c < count; c++) hardLand[c] = (elevation[c] as number) > seaLevel ? 1 : 0;
  }
  const result = getCore().coastDistance(
    grid.neighbors, grid.neighborCount, elevation, hardLand, seaLevel, count);
  const signed = new Float32Array(count);
  if (!result.boundaryCount) {
    signed.fill(hardLand[0] ? 30000 : -30000);
    return { hardLand, signedDistance: signed };
  }
  const distance = result.dist;
  for (c = 0; c < count; c++) signed[c] = hardLand[c] ? (distance[c] as number) : -(distance[c] as number);
  return { hardLand, signedDistance: signed };
}

function computeSoftMemberships(
  grid: PlanetGrid, arrays: GeographyArrays, profile: GeographyProfile,
  seaLevel: number, shelfBelowLevel: number, shelfAboveLevel: number, coast: CoastResult,
): void {
  const width = Math.max(0, profile.coastSoftWidthCells);
  const inv2Width = width > 0 ? 1 / (2 * width) : 0;
  const proxScale = Math.max(1, width * 2);
  const hasShelfBand = shelfAboveLevel > shelfBelowLevel;
  const depthSpan = Math.max(1e-12, seaLevel - shelfBelowLevel);
  const landSpan = Math.max(1e-12, shelfAboveLevel - seaLevel);
  const signedDistance = coast.signedDistance;
  const hardLand = coast.hardLand;
  const elevation = arrays.elevation;
  const outMuLand = arrays.muLand;
  const outMuShelf = arrays.muShelf;
  const outMuOcean = arrays.muOcean;
  const outSigned = arrays.signedCoastDistanceCells;
  const outContSupport = arrays.continentSupport;
  const outOceanSupport = arrays.oceanSupport;
  const n = grid.cellCount;
  for (let c = 0; c < n; c++) {
    const dist = signedDistance[c] as number;
    let muLand: number;
    if (width <= 0) muLand = hardLand[c] ? 1 : 0;
    else if (dist <= -width) muLand = 0;
    else if (dist >= width) muLand = 1;
    else muLand = smoothstep01(0.5 + dist * inv2Width);
    const elev = elevation[c] as number;
    let shelfPotential = 0;
    if (hasShelfBand && elev > shelfBelowLevel && elev < shelfAboveLevel) {
      if (elev <= seaLevel) {
        shelfPotential = clamp01(1 - (seaLevel - elev) / depthSpan);
      } else {
        shelfPotential = clamp01(1 - (elev - seaLevel) / landSpan);
      }
      const coastProximity = Math.exp(-Math.abs(dist) / proxScale);
      shelfPotential *= 0.35 + 0.65 * coastProximity;
    }
    let muShelf = (1 - muLand) * clamp01(shelfPotential);
    if (hardLand[c]) {
      // Низкая суша в переходной зоне может иметь shelf-остаток, но не за
      // счёт уже вычисленной доли суши сверх её дополнения до единицы.
      muShelf = Math.max(muShelf, (1 - muLand) * clamp01(shelfPotential) * 0.5);
    }
    let muOcean = clamp01(1 - muLand - muShelf);
    const sum = muLand + muShelf + muOcean;
    if (sum > 0) {
      muLand /= sum; muShelf /= sum; muOcean /= sum;
    } else {
      muOcean = 1;
    }
    outMuLand[c] = muLand;
    outMuShelf[c] = muShelf;
    outMuOcean[c] = muOcean;
    outSigned[c] = dist;
    outContSupport[c] = clamp01(muLand + 0.30 * muShelf);
    outOceanSupport[c] = clamp01(muOcean + 0.55 * muShelf);
  }
}

function randomUnitVector(rng: () => number): number[] {
  for (;;) {
    const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
    const len2 = x * x + y * y + z * z;
    if (len2 > 1e-12 && len2 <= 1) {
      const len = Math.sqrt(len2);
      return [x / len, y / len, z / len];
    }
  }
}

function computePlates(grid: PlanetGrid, arrays: GeographyArrays, master: MasterSeed): PlateRecord[] {
  const rng = mulberry32(domainSeed(master, 'plate-seeds'));
  const candidates: number[][] = [];
  let i: number, j: number;
  for (i = 0; i < 512; i++) candidates.push(randomUnitVector(rng));
  const seeds: number[][] = [candidates[0] as number[]];
  const selectedCandidate = new Uint8Array(candidates.length);
  selectedCandidate[0] = 1;
  const maxDot = new Float64Array(candidates.length).fill(-1);
  while (seeds.length < PLATE_COUNT) {
    const last = seeds[seeds.length - 1] as number[];
    let best = -1, bestScore = Infinity;
    for (i = 0; i < candidates.length; i++) {
      const cand = candidates[i] as number[];
      const dot = (cand[0] as number) * (last[0] as number) + (cand[1] as number) * (last[1] as number) + (cand[2] as number) * (last[2] as number);
      if (dot > (maxDot[i] as number)) maxDot[i] = dot;
      if (!selectedCandidate[i] && (maxDot[i] as number) < bestScore) {
        bestScore = maxDot[i] as number;
        best = i;
      }
    }
    selectedCandidate[best] = 1;
    seeds.push(candidates[best] as number[]);
  }
  const seedCount = seeds.length;
  const seedX = new Float64Array(seedCount);
  const seedY = new Float64Array(seedCount);
  const seedZ = new Float64Array(seedCount);
  const cellCounts = new Int32Array(seedCount);
  for (j = 0; j < seedCount; j++) {
    const s = seeds[j] as number[];
    seedX[j] = s[0] as number;
    seedY[j] = s[1] as number;
    seedZ[j] = s[2] as number;
  }
  const centers = grid.centers;
  const plateId = arrays.plateId;
  const plateBoundary = arrays.plateBoundary;
  const volcanism = arrays.volcanism;
  const n = grid.cellCount;
  for (let c = 0; c < n; c++) {
    const c3 = c * 3;
    const cx = centers[c3] as number;
    const cy = centers[c3 + 1] as number;
    const cz = centers[c3 + 2] as number;
    let bestId = 0, bestDot = -Infinity, secondDot = -Infinity;
    for (j = 0; j < seedCount; j++) {
      const d = cx * (seedX[j] as number) + cy * (seedY[j] as number) + cz * (seedZ[j] as number);
      if (d > bestDot) {
        secondDot = bestDot;
        bestDot = d;
        bestId = j;
      } else if (d > secondDot) {
        secondDot = d;
      }
    }
    plateId[c] = bestId;
    const boundary = clamp01(1 - Math.max(0, bestDot - secondDot) / 0.08);
    plateBoundary[c] = boundary;
    const volc = volcanism[c] as number;
    volcanism[c] = clamp01(volc * 0.72 + boundary * volc * 0.38 + boundary * 0.08);
    cellCounts[bestId] = (cellCounts[bestId] as number) + 1;
  }
  const records: PlateRecord[] = seeds.map(function (seed, id) {
    return { id: id, seedDirection: seed, cellCount: cellCounts[id] as number, supportAreaKm2: 0 };
  });
  return records;
}

type RegionMode = 'continent' | 'ocean';

function normal01(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function desiredMasses(
  count: number, totalSupport: number, targetMean: number, variation: number, rng: () => number,
): Float64Array {
  void targetMean;
  const masses = new Float64Array(count);
  if (!count) return masses;
  if (!(variation > 0)) {
    masses.fill(totalSupport / count);
    return masses;
  }
  let sum = 0;
  for (let i = 0; i < count; i++) {
    let weight = Math.exp(variation * normal01(rng) - 0.5 * variation * variation);
    weight = clamp(weight, 0.05, 8);
    masses[i] = weight;
    sum += weight;
  }
  const scale = totalSupport / Math.max(1e-12, sum);
  for (let i = 0; i < count; i++) masses[i] = (masses[i] as number) * scale;
  return masses;
}

function takeDesiredMasses(
  sortedDesc: number[] | Float64Array, count: number, totalSupport: number,
): Float64Array {
  const masses = new Float64Array(count);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    masses[i] = (sortedDesc[Math.min(i, sortedDesc.length - 1)] as number) || 0;
    sum += masses[i] as number;
  }
  if (count && sum > 0) {
    const scale = totalSupport / sum;
    for (let i = 0; i < count; i++) masses[i] = (masses[i] as number) * scale;
  }
  return masses;
}

function chooseSeeds(
  grid: PlanetGrid, support: Float32Array, score: Float32Array, countWant: number,
  componentIds: Int32Array | null, componentSizes: number[] | null,
  minComponentCells: number, desiredMassesSortedDesc: number[] | null,
): number[] {
  const rawCandidates = new Uint32Array(grid.cellCount);
  let candCount = 0;
  for (let c = 0; c < grid.cellCount; c++) {
    if ((support[c] as number) < 0.45) continue;
    if (componentIds && componentSizes) {
      const component = componentIds[c] as number;
      if (component < 0 || (componentSizes[component] as number) < minComponentCells) continue;
    }
    rawCandidates[candCount++] = c;
  }
  if (!candCount || countWant <= 0) return [];
  // LSD radix sort по f32-ключу стабилен: возрастающий порядок сырых кандидатов
  // сохраняет строгий tie-break (a - b) при равных score (Инвариант И-2).
  const sortedOrder = getCore().radixOrderF32(score, rawCandidates.subarray(0, candCount), true);
  const cap = Math.min(candCount, Math.max(10000, countWant * 120));
  const candidates = new Int32Array(sortedOrder.buffer, sortedOrder.byteOffset, cap);
  const maxScore = (score[candidates[0] as number] as number) || 1;
  const desiredSorted = desiredMassesSortedDesc && desiredMassesSortedDesc.length
    ? Float64Array.from(desiredMassesSortedDesc) : new Float64Array(0);
  const meanSpacing = Math.sqrt(4 * Math.PI / grid.cellCount);
  const selected = getCore().chooseSeeds(candidates, grid.centers, score,
    desiredSorted, countWant, meanSpacing, maxScore);
  return Array.from(selected);
}

interface AssignedRegions {
  top1Id: Int32Array;
  top1Weight: Float32Array;
  top2Id: Int32Array;
  top2Weight: Float32Array;
  entropy: Float32Array;
  desiredMass: Float64Array;
  effectiveMass: Float64Array;
  effectiveAreaKm2: Float64Array;
  hardCellCount: Uint32Array;
}

let compStackBuf = new Int32Array(163842);
let compMaskBuf = new Uint8Array(163842);
let compIdsBuf = new Int32Array(163842);
let scoreBuf = new Float32Array(163842);
let oceanTop2IdBuf = new Int32Array(163842);
let oceanTop2WeightBuf = new Float32Array(163842);
let oceanEntropyBuf = new Float32Array(0);

function assignRegions(
  grid: PlanetGrid, arrays: GeographyArrays, seeds: number[], desired: Float64Array,
  support: Float32Array, mode: RegionMode, softWidthCells: number, targetMean: number,
  outTop1Id: Int32Array, outTop1Weight: Float32Array,
  outTop2Id: Int32Array, outTop2Weight: Float32Array, outEntropy: Float32Array,
): AssignedRegions {
  const count = grid.cellCount;
  const result: AssignedRegions = {
    top1Id: outTop1Id,
    top1Weight: outTop1Weight,
    top2Id: outTop2Id,
    top2Weight: outTop2Weight,
    entropy: outEntropy,
    desiredMass: new Float64Array(seeds.length),
    effectiveMass: new Float64Array(seeds.length),
    effectiveAreaKm2: new Float64Array(seeds.length),
    hardCellCount: new Uint32Array(seeds.length),
  };
  if (!seeds.length) {
    outTop1Id.fill(-1);
    outTop1Weight.fill(0);
    outTop2Id.fill(-1);
    outTop2Weight.fill(0);
    if (mode === 'continent') outEntropy.fill(0);
    return result;
  }
  const radiusScale = Math.sqrt(Math.max(1, targetMean) / Math.PI);
  const biases = new Float64Array(seeds.length);
  let i: number, c: number;
  result.desiredMass.set(desired);
  for (i = 0; i < seeds.length; i++) {
    biases[i] = clamp(0.5 * radiusScale * Math.log(Math.max(1e-9, (result.desiredMass[i] as number) / Math.max(1, targetMean))),
      -1.5 * radiusScale, 1.5 * radiusScale);
  }
  const iterations = seeds.length > 1 ? 3 : 1;
  const plateCross = mode === 'continent' ? 0.75 : 0.25;
  const finalTop = getCore().balanceRegionsTopTwo(
    grid.neighbors, grid.neighborCount,
    arrays.elevation, arrays.temperature, arrays.moisture,
    arrays.plateId, arrays.plateBoundary, support,
    plateCross, Int32Array.from(seeds), biases,
    result.desiredMass, radiusScale, iterations, count,
  );
  const temperature = Math.max(0.35, softWidthCells || 0);
  const needEntropy = mode === 'continent';
  const label1 = finalTop.label1;
  const label2 = finalTop.label2;
  const dist1 = finalTop.dist1;
  const dist2 = finalTop.dist2;
  const areas = grid.areas;
  const hardCellCount = result.hardCellCount;
  const effectiveMass = result.effectiveMass;
  const effectiveAreaKm2 = result.effectiveAreaKm2;
  for (c = 0; c < count; c++) {
    const id1 = label1[c] as number;
    const id2 = label2[c] as number;
    outTop1Id[c] = id1;
    outTop2Id[c] = id2;
    if (id1 < 0) {
      outTop1Weight[c] = 0;
      outTop2Weight[c] = 0;
      if (needEntropy) outEntropy[c] = 0;
      continue;
    }
    hardCellCount[id1] = (hardCellCount[id1] as number) + 1;
    let w1 = 1;
    const d2 = dist2[c] as number;
    if (id2 >= 0 && Number.isFinite(d2)) {
      const delta = Math.max(0, d2 - (dist1[c] as number));
      const x = delta / temperature;
      if (x < 37) w1 = 1 / (1 + Math.exp(-x));
    }
    const w2 = id2 >= 0 ? 1 - w1 : 0;
    outTop1Weight[c] = w1;
    outTop2Weight[c] = w2;
    if (needEntropy) {
      if (w2 > 0) {
        let entropy = 0;
        if (w1 > 0 && w1 < 1) entropy -= w1 * Math.log(w1);
        entropy -= w2 * Math.log(w2);
        outEntropy[c] = entropy / Math.LN2;
      } else {
        outEntropy[c] = 0;
      }
    }
    const cellArea = areas[c] as number;
    const sup = support[c] as number;
    const sw1 = sup * w1;
    effectiveMass[id1] = (effectiveMass[id1] as number) + sw1;
    effectiveAreaKm2[id1] = (effectiveAreaKm2[id1] as number) + sw1 * cellArea;
    if (id2 >= 0) {
      const sw2 = sup * w2;
      effectiveMass[id2] = (effectiveMass[id2] as number) + sw2;
      effectiveAreaKm2[id2] = (effectiveAreaKm2[id2] as number) + sw2 * cellArea;
    }
  }
  return result;
}

function pruneEmptyRegions(
  grid: PlanetGrid, assigned: AssignedRegions, support: Float32Array,
): { assigned: AssignedRegions; keptOldIds: number[] } {
  const oldCount = assigned.hardCellCount.length;
  const remap = new Int32Array(oldCount).fill(-1);
  const keptOldIds: number[] = [];
  let i: number, c: number;
  for (i = 0; i < oldCount; i++) {
    if ((assigned.hardCellCount[i] as number) > 0) {
      remap[i] = keptOldIds.length;
      keptOldIds.push(i);
    }
  }
  if (keptOldIds.length === oldCount) {
    return { assigned, keptOldIds };
  }
  const pruned: AssignedRegions = {
    top1Id: assigned.top1Id,
    top1Weight: assigned.top1Weight,
    top2Id: assigned.top2Id,
    top2Weight: assigned.top2Weight,
    entropy: assigned.entropy,
    desiredMass: new Float64Array(keptOldIds.length),
    effectiveMass: new Float64Array(keptOldIds.length),
    effectiveAreaKm2: new Float64Array(keptOldIds.length),
    hardCellCount: new Uint32Array(keptOldIds.length),
  };
  for (i = 0; i < keptOldIds.length; i++) {
    pruned.desiredMass[i] = assigned.desiredMass[keptOldIds[i] as number] as number;
  }
  for (c = 0; c < grid.cellCount; c++) {
    const old1 = assigned.top1Id[c] as number;
    const old2 = assigned.top2Id[c] as number;
    if (old1 < 0) continue;
    const new1 = remap[old1] as number;
    const new2 = old2 >= 0 ? (remap[old2] as number) : -1;
    let w1 = assigned.top1Weight[c] as number;
    let w2 = assigned.top2Weight[c] as number;
    // Пустая идентичность не может быть top1 ни в одной ячейке по
    // построению фильтра. Если она была top2, её переходная масса
    // возвращается фактическому top1, а ячейка становится однозначной.
    if (old2 >= 0 && new2 < 0) {
      w1 = 1;
      w2 = 0;
      pruned.entropy[c] = 0;
    }
    pruned.top1Id[c] = new1;
    pruned.top2Id[c] = new2;
    pruned.top1Weight[c] = w1;
    pruned.top2Weight[c] = w2;
    if (new1 >= 0) {
      pruned.hardCellCount[new1] = (pruned.hardCellCount[new1] as number) + 1;
      pruned.effectiveMass[new1] = (pruned.effectiveMass[new1] as number) + (support[c] as number) * w1;
      pruned.effectiveAreaKm2[new1] = (pruned.effectiveAreaKm2[new1] as number) + (support[c] as number) * w1 * (grid.areas[c] as number);
    }
    if (new2 >= 0) {
      pruned.effectiveMass[new2] = (pruned.effectiveMass[new2] as number) + (support[c] as number) * w2;
      pruned.effectiveAreaKm2[new2] = (pruned.effectiveAreaKm2[new2] as number) + (support[c] as number) * w2 * (grid.areas[c] as number);
    }
  }
  return { assigned: pruned, keptOldIds };
}

interface RegionBuildResult {
  records: RegionRecord[];
  totalSupport: number;
  assigned: AssignedRegions;
}

function buildContinents(
  grid: PlanetGrid, arrays: GeographyArrays, profile: GeographyProfile,
  coast: CoastResult, radiusKm: number, rng: () => number,
): RegionBuildResult {
  const n = grid.cellCount;
  const support = arrays.continentSupport;
  const elevation = arrays.elevation;
  if (scoreBuf.length < n) scoreBuf = new Float32Array(n);
  if (compMaskBuf.length < n) compMaskBuf = new Uint8Array(n);
  if (compIdsBuf.length < n) compIdsBuf = new Int32Array(n);
  const score = scoreBuf.subarray(0, n);
  const supportMask = compMaskBuf.subarray(0, n);
  let totalSupport = 0;
  let maxElev = -Infinity, minElev = Infinity;
  let c: number;
  for (c = 0; c < n; c++) {
    const sup = support[c] as number;
    totalSupport += sup;
    supportMask[c] = sup >= 0.45 ? 1 : 0;
    const el = elevation[c] as number;
    if (el > maxElev) maxElev = el;
    if (el < minElev) minElev = el;
  }
  const countWant = Math.max(0, Math.round(totalSupport / profile.continentMeanCells));
  // Глубина берега и нормированная высота дают семенам внутренние,
  // а не береговые точки.
  const signedDistance = coast.signedDistance;
  const plateAffinity = arrays.plateAffinity;
  for (c = 0; c < n; c++) {
    const elevNorm = maxElev > minElev ? ((elevation[c] as number) - minElev) / (maxElev - minElev) : 0;
    score[c] = Math.min(25, Math.max(0, signedDistance[c] as number)) + elevNorm * 8 + (plateAffinity[c] as number) * 2;
  }
  const supportComponents = componentSizes(grid, supportMask, compIdsBuf.subarray(0, n));
  const desiredAll = desiredMasses(countWant, totalSupport, profile.continentMeanCells,
    profile.continentVariation * CONTINENT_DESIRED_VARIATION_GAIN, rng);
  const desiredSortedDesc = Array.from(desiredAll).sort(function (a, b) { return b - a; });
  let seeds = chooseSeeds(grid, support, score, countWant, supportComponents.ids,
    supportComponents.sizes, Math.max(5, Math.round(profile.continentMeanCells * 0.01)), desiredSortedDesc);
  const desired = takeDesiredMasses(desiredSortedDesc, seeds.length, totalSupport);
  let assigned = assignRegions(grid, arrays, seeds, desired, support, 'continent',
    profile.continentSoftWidthCells, profile.continentMeanCells,
    arrays.continentTop1Id, arrays.continentTop1Weight,
    arrays.continentTop2Id, arrays.continentTop2Weight, arrays.continentEntropy);
  const pruned = pruneEmptyRegions(grid, assigned, support);
  assigned = pruned.assigned;
  const keptSeeds = seeds;
  seeds = pruned.keptOldIds.map(function (oldId) { return keptSeeds[oldId] as number; });
  const areaScale = radiusKm * radiusKm;
  const finalAssigned = assigned;
  const records: RegionRecord[] = seeds.map(function (seedCell, id) {
    return {
      id: id,
      seedCell: seedCell,
      desiredMassCells: finalAssigned.desiredMass[id] as number,
      effectiveMassCells: finalAssigned.effectiveMass[id] as number,
      effectiveAreaKm2: (finalAssigned.effectiveAreaKm2[id] as number) * areaScale,
      hardCellCount: finalAssigned.hardCellCount[id] as number,
    };
  });
  return { records, totalSupport, assigned: finalAssigned };
}

function buildOceanBasins(
  grid: PlanetGrid, arrays: GeographyArrays, profile: GeographyProfile,
  coast: CoastResult, radiusKm: number, rng: () => number,
): RegionBuildResult {
  const n = grid.cellCount;
  const support = arrays.oceanSupport;
  const elevation = arrays.elevation;
  if (scoreBuf.length < n) scoreBuf = new Float32Array(n);
  if (compMaskBuf.length < n) compMaskBuf = new Uint8Array(n);
  if (compIdsBuf.length < n) compIdsBuf = new Int32Array(n);
  if (oceanTop2IdBuf.length < n) {
    oceanTop2IdBuf = new Int32Array(n);
    oceanTop2WeightBuf = new Float32Array(n);
  }
  const score = scoreBuf.subarray(0, n);
  const supportMask = compMaskBuf.subarray(0, n);
  let totalSupport = 0;
  let maxElev = -Infinity, minElev = Infinity;
  let c: number;
  for (c = 0; c < n; c++) {
    const sup = support[c] as number;
    totalSupport += sup;
    supportMask[c] = sup >= 0.45 ? 1 : 0;
    const el = elevation[c] as number;
    if (el > maxElev) maxElev = el;
    if (el < minElev) minElev = el;
  }
  const countWant = Math.max(0, Math.round(totalSupport / profile.oceanBasinMeanCells));
  const signedDistance = coast.signedDistance;
  for (c = 0; c < n; c++) {
    const depthNorm = maxElev > minElev ? 1 - ((elevation[c] as number) - minElev) / (maxElev - minElev) : 0;
    score[c] = Math.min(25, Math.max(0, -(signedDistance[c] as number))) + depthNorm * 8;
  }
  const supportComponents = componentSizes(grid, supportMask, compIdsBuf.subarray(0, n));
  const desiredAll = desiredMasses(countWant, totalSupport, profile.oceanBasinMeanCells, 0.45, rng);
  const desiredSortedDesc = Array.from(desiredAll).sort(function (a, b) { return b - a; });
  let seeds = chooseSeeds(grid, support, score, countWant, supportComponents.ids,
    supportComponents.sizes, Math.max(50, Math.round(profile.oceanBasinMeanCells * 0.03)), desiredSortedDesc);
  const desired = takeDesiredMasses(desiredSortedDesc, seeds.length, totalSupport);
  let assigned = assignRegions(grid, arrays, seeds, desired, support, 'ocean',
    Math.max(1, profile.continentSoftWidthCells), profile.oceanBasinMeanCells,
    arrays.oceanBasinId, arrays.oceanBasinWeight,
    oceanTop2IdBuf.subarray(0, n), oceanTop2WeightBuf.subarray(0, n), oceanEntropyBuf.subarray(0, n));
  const pruned = pruneEmptyRegions(grid, assigned, support);
  assigned = pruned.assigned;
  const keptSeeds = seeds;
  seeds = pruned.keptOldIds.map(function (oldId) { return keptSeeds[oldId] as number; });
  const areaScale = radiusKm * radiusKm;
  const finalAssigned = assigned;
  const records: RegionRecord[] = seeds.map(function (seedCell, id) {
    return {
      id: id,
      seedCell: seedCell,
      desiredMassCells: finalAssigned.desiredMass[id] as number,
      effectiveMassCells: finalAssigned.effectiveMass[id] as number,
      effectiveAreaKm2: (finalAssigned.effectiveAreaKm2[id] as number) * areaScale,
      hardCellCount: finalAssigned.hardCellCount[id] as number,
    };
  });
  return { records, totalSupport, assigned: finalAssigned };
}

function componentSizes(
  grid: PlanetGrid, mask: Uint8Array, idsOut?: Int32Array | null,
): { sizes: number[]; ids: Int32Array } {
  const n = grid.cellCount;
  if (compStackBuf.length < n) {
    compStackBuf = new Int32Array(n);
  }
  const stack = compStackBuf;
  const sizes: number[] = [];
  const ids = idsOut !== undefined
    ? (idsOut ? idsOut.fill(-1) : new Int32Array(0))
    : new Int32Array(n).fill(-1);
  const writeIds = ids.length > 0;
  for (let c = 0; c < n; c++) {
    if (!mask[c]) continue;
    const id = sizes.length;
    let size = 0;
    let sp = 0;
    stack[sp++] = c;
    mask[c] = 0;
    if (writeIds) ids[c] = id;
    while (sp > 0) {
      const cell = stack[--sp] as number;
      size++;
      const nc = grid.neighborCount[cell] as number;
      const base = cell * 6;
      for (let k = 0; k < nc; k++) {
        const nb = grid.neighbors[base + k] as number;
        if (mask[nb]) {
          mask[nb] = 0;
          if (writeIds) ids[nb] = id;
          stack[sp++] = nb;
        }
      }
    }
    sizes.push(size);
  }
  return { sizes, ids };
}

function quantileSorted(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

function distributionStats(values: ArrayLike<number>): DistributionStats {
  const sorted = Array.from(values).sort(function (a, b) { return a - b; });
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

function landmassStats(
  grid: PlanetGrid, arrays: GeographyArrays, threshold: number, idsOut?: Int32Array | null,
): LandmassStatsEntry {
  const n = grid.cellCount;
  if (compMaskBuf.length < n) compMaskBuf = new Uint8Array(n);
  const mask = compMaskBuf.subarray(0, n);
  let landCells = 0;
  for (let c = 0; c < n; c++) {
    const bit = (arrays.muLand[c] as number) >= threshold ? 1 : 0;
    mask[c] = bit;
    landCells += bit;
  }
  const components = componentSizes(grid, mask, idsOut);
  const stats = distributionStats(components.sizes);
  let tiny = 0;
  for (let i = 0; i < components.sizes.length; i++) if ((components.sizes[i] as number) < 5) tiny++;
  return {
    threshold: threshold,
    landCells: landCells,
    count: components.sizes.length,
    medianCells: stats.median,
    p90Cells: stats.p90,
    maxCells: stats.max,
    largestShare: landCells ? stats.max / landCells : 0,
    tinyIslandsUnder5: tiny,
  };
}

function computeStats(
  grid: PlanetGrid, arrays: GeographyArrays, profile: GeographyProfile,
  continents: RegionBuildResult, oceanBasins: RegionBuildResult,
  plates: PlateRecord[], coast: CoastResult,
): GeographyStats {
  let areaTotal = 0;
  let hardOceanArea = 0;
  let softLandArea = 0, softShelfArea = 0, softOceanArea = 0;
  let equatorTempSum = 0, equatorWeight = 0, polarTempSum = 0, polarWeight = 0;
  let tempSum = 0, qSum = 0, tempQSum = 0, temp2Sum = 0, q2Sum = 0;
  let coreSupport = 0, transitionSupport = 0, entropyWeighted = 0;
  const areas = grid.areas;
  const centers = grid.centers;
  const hardLand = coast.hardLand;
  const muLand = arrays.muLand;
  const muShelf = arrays.muShelf;
  const muOcean = arrays.muOcean;
  const temperature = arrays.temperature;
  const continentSupport = arrays.continentSupport;
  const continentTop1Weight = arrays.continentTop1Weight;
  const continentEntropy = arrays.continentEntropy;
  const n = grid.cellCount;
  let c: number;
  for (c = 0; c < n; c++) {
    const area = areas[c] as number;
    areaTotal += area;
    if (!hardLand[c]) hardOceanArea += area;
    softLandArea += (muLand[c] as number) * area;
    softShelfArea += (muShelf[c] as number) * area;
    softOceanArea += (muOcean[c] as number) * area;
    const y = centers[c * 3 + 1] as number;
    const q = Math.sqrt(Math.max(0, 1 - y * y));
    const temp = temperature[c] as number;
    tempSum += temp * area; qSum += q * area; tempQSum += temp * q * area;
    temp2Sum += temp * temp * area; q2Sum += q * q * area;
    const absY = y < 0 ? -y : y;
    if (absY <= 0.35) { equatorTempSum += temp * area; equatorWeight += area; }
    else if (absY >= 0.85) { polarTempSum += temp * area; polarWeight += area; }
    const support = continentSupport[c] as number;
    if ((continentTop1Weight[c] as number) >= 0.75) coreSupport += support;
    const ent = continentEntropy[c] as number;
    if (ent >= 0.5) transitionSupport += support;
    entropyWeighted += support * ent;
  }
  const covariance = tempQSum / areaTotal - (tempSum / areaTotal) * (qSum / areaTotal);
  const varTemp = Math.max(0, temp2Sum / areaTotal - Math.pow(tempSum / areaTotal, 2));
  const varQ = Math.max(0, q2Sum / areaTotal - Math.pow(qSum / areaTotal, 2));
  const correlation = varTemp > 0 && varQ > 0 ? covariance / Math.sqrt(varTemp * varQ) : 0;

  const continentMasses = continents.records.map(function (r) { return r.effectiveMassCells; });
  const continentDist = distributionStats(continentMasses);
  const basinMasses = oceanBasins.records.map(function (r) { return r.effectiveMassCells; });
  const basinDist = distributionStats(basinMasses);
  const thresholds = [0.35, 0.5, 0.65].map(function (threshold) {
    return landmassStats(grid, arrays, threshold, threshold === 0.5 ? arrays.physicalLandmassId : null);
  });
  const plateDist = distributionStats(plates.map(function (r) { return r.cellCount; }));
  return {
    oceanFractionHard: areaTotal ? hardOceanArea / areaTotal : 0,
    oceanFractionTarget: profile.oceanPctl / 100,
    softFractions: {
      land: areaTotal ? softLandArea / areaTotal : 0,
      shelf: areaTotal ? softShelfArea / areaTotal : 0,
      ocean: areaTotal ? softOceanArea / areaTotal : 0,
    },
    continents: {
      distribution: continentDist,
      targetMeanCells: profile.continentMeanCells,
      coreSupportFraction: continents.totalSupport ? coreSupport / continents.totalSupport : 0,
      transitionSupportFraction: continents.totalSupport ? transitionSupport / continents.totalSupport : 0,
      meanEntropy: continents.totalSupport ? entropyWeighted / continents.totalSupport : 0,
    },
    oceanBasins: {
      distribution: basinDist,
      targetMeanCells: profile.oceanBasinMeanCells,
    },
    plates: { distribution: plateDist },
    landmasses: thresholds,
    climate: {
      equatorTemperature: equatorWeight ? equatorTempSum / equatorWeight : 0,
      polarTemperature: polarWeight ? polarTempSum / polarWeight : 0,
      temperatureInsolationCorrelation: correlation,
    },
  };
}

function expectedFrequency(radiusKm: number): number {
  const earthCells = 10 * EARTH_CANONICAL_V * EARTH_CANONICAL_V + 2;
  const ratio = radiusKm / EARTH_RADIUS_KM;
  return Math.max(1, Math.round(Math.sqrt(Math.max(0, earthCells * ratio * ratio - 2) / 10)));
}

function finishGeography(
  grid: PlanetGrid, profile: GeographyProfile, sampler: FieldSamplerInternal,
  arrays: GeographyArrays, temperatureBase: Float32Array, options: GenerateGeographyOptions,
): GeographyResult {
  void sampler;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  function progress(stage: string, fraction: number): void {
    if (onProgress) onProgress(stage, fraction);
  }
  const expFreq = expectedFrequency(profile.radiusKm);
  const result: GeographyResult = {
    surfaceApplicable: true,
    gridVersion: grid.gridVersion || profile.gridVersion,
    noiseVersion: NOISE_VERSION,
    geographyVersion: GEOGRAPHY_VERSION,
    presetVersion: profile.presetVersion,
    profile: profile,
    v: grid.v,
    expectedFrequency: expFreq,
    frequencyMatchesProfile: grid.v === expFreq,
    cellCount: grid.cellCount,
    radiusKm: profile.radiusKm,
    seaLevel: 1e-300,
    shelfBelowLevel: 1e-300,
    shelfAboveLevel: 1e-300,
    elevationMin: 1e-300,
    elevationMax: 1e-300,
    continents: [] as RegionRecord[],
    oceanBasins: [] as RegionRecord[],
    plates: [] as PlateRecord[],
    stats: null as GeographyStats | null,
    elevation: arrays.elevation,
    moisture: arrays.moisture,
    temperature: arrays.temperature,
    plateAffinity: arrays.plateAffinity,
    volcanism: arrays.volcanism,
    detail: arrays.detail,
    muLand: arrays.muLand,
    muShelf: arrays.muShelf,
    muOcean: arrays.muOcean,
    signedCoastDistanceCells: arrays.signedCoastDistanceCells,
    plateId: arrays.plateId,
    plateBoundary: arrays.plateBoundary,
    continentSupport: arrays.continentSupport,
    continentTop1Id: arrays.continentTop1Id,
    continentTop1Weight: arrays.continentTop1Weight,
    continentTop2Id: arrays.continentTop2Id,
    continentTop2Weight: arrays.continentTop2Weight,
    continentEntropy: arrays.continentEntropy,
    oceanSupport: arrays.oceanSupport,
    oceanBasinId: arrays.oceanBasinId,
    oceanBasinWeight: arrays.oceanBasinWeight,
    physicalLandmassId: arrays.physicalLandmassId,
  };

  if (profile.surfaceClass === 'gas_giant' || profile.surfaceClass === 'no_surface') {
    result.surfaceApplicable = false;
    result.seaLevel = 0;
    result.shelfBelowLevel = 0;
    result.shelfAboveLevel = 0;
    result.elevationMin = 0;
    result.elevationMax = 0;
    result.stats = {
      oceanFractionHard: 0,
      oceanFractionTarget: profile.oceanPctl / 100,
      softFractions: { land: 0, shelf: 0, ocean: 0 },
      continents: { distribution: distributionStats([]), targetMeanCells: profile.continentMeanCells },
      oceanBasins: { distribution: distributionStats([]), targetMeanCells: profile.oceanBasinMeanCells },
      plates: { distribution: distributionStats([]) },
      landmasses: [],
      climate: { equatorTemperature: 0, polarTemperature: 0, temperatureInsolationCorrelation: 0 },
    };
    progress('done', 1);
    return result;
  }

  progress('sea-level', 0.35);
  const quantile = makeWeightedQuantiles(arrays.elevation, grid.areas);
  result.seaLevel = quantile(profile.oceanPctl / 100);
  result.shelfBelowLevel = quantile(profile.shelfBelowPctl / 100);
  result.shelfAboveLevel = quantile(profile.shelfAbovePctl / 100);
  const minE = grid.cellCount > 0 ? quantile(0) : Infinity;
  const maxE = grid.cellCount > 0 ? quantile(1) : -Infinity;
  result.elevationMin = minE;
  result.elevationMax = maxE;
  const elevation = arrays.elevation;
  const volcanism = arrays.volcanism;
  const temperature = arrays.temperature;
  const seaLevel = result.seaLevel;
  const elevSpan = maxE - seaLevel;
  let c: number;
  for (c = 0; c < grid.cellCount; c++) {
    const el = elevation[c] as number;
    const heightNorm = el > seaLevel && elevSpan > 0
      ? (el - seaLevel) / elevSpan
      : 0;
    temperature[c] = clamp01((temperatureBase[c] as number) - 0.22 * heightNorm + 0.03 * (volcanism[c] as number));
  }

  progress('coast', 0.45);
  const coast = computeCoastDistance(grid, arrays.elevation, result.seaLevel, profile);
  computeSoftMemberships(grid, arrays, profile, result.seaLevel,
    result.shelfBelowLevel, result.shelfAboveLevel, coast);

  progress('plates', 0.55);
  const master = parseMasterSeedHex(profile.masterSeedHex);
  result.plates = computePlates(grid, arrays, master);
  const plateAreaScale = profile.radiusKm * profile.radiusKm;
  for (c = 0; c < grid.cellCount; c++) {
    const plate = result.plates[arrays.plateId[c] as number] as PlateRecord;
    plate.supportAreaKm2 += (grid.areas[c] as number) * plateAreaScale;
  }

  progress('continents', 0.65);
  const continentRng = mulberry32(domainSeed(master, 'continent-masses'));
  const continents = buildContinents(grid, arrays, profile, coast, profile.radiusKm, continentRng);
  result.continents = continents.records;

  progress('ocean-basins', 0.85);
  const oceanRng = mulberry32(domainSeed(master, 'ocean-basin-masses'));
  const oceanBasins = buildOceanBasins(grid, arrays, profile, coast, profile.radiusKm, oceanRng);
  result.oceanBasins = oceanBasins.records;

  progress('stats', 0.95);
  result.stats = computeStats(grid, arrays, profile, continents, oceanBasins, result.plates, coast);
  progress('done', 1);
  return result;
}

function assertGrid(grid: PlanetGrid): void {
  if (!grid || !grid.centers || !grid.areas || !grid.neighbors || !grid.neighborCount ||
      !Number.isInteger(grid.cellCount) || grid.cellCount <= 0) {
    throw new Error('PlanetGeography: нужна сетка GeodesicGrid с centers/areas/neighbors');
  }
  if (grid.gridVersion && grid.gridVersion !== GRID_VERSION) {
    throw new Error('PlanetGeography: сетка должна быть ' + GRID_VERSION + ', получена ' + grid.gridVersion);
  }
}

function generateGeography(
  grid: PlanetGrid, input?: GeographyProfileInput | null, options?: GenerateGeographyOptions,
): GeographyResult {
  assertGrid(grid);
  const sampler = createFieldSampler(input);
  const profile = sampler.profile;
  const arrays = allocateGeographyArrays(grid.cellCount);
  const temperatureBase = arrays.temperature;
  if (profile.surfaceClass !== 'gas_giant' && profile.surfaceClass !== 'no_surface') {
    sampleGridFields(grid, sampler, arrays, 0, grid.cellCount, temperatureBase);
  }
  return finishGeography(grid, profile, sampler, arrays, temperatureBase, options || {});
}

function defaultYieldControl(): Promise<void> {
  return new Promise<void>(function (resolve) {
    if (typeof setTimeout !== 'undefined') setTimeout(resolve, 0);
    else resolve();
  });
}

async function generateGeographyAsync(
  grid: PlanetGrid, input?: GeographyProfileInput | null, options: GenerateGeographyOptions = {},
): Promise<GeographyResult> {
  assertGrid(grid);
  const sampler = createFieldSampler(input);
  const profile = sampler.profile;
  const arrays = allocateGeographyArrays(grid.cellCount);
  const temperatureBase = new Float32Array(grid.cellCount);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  if (profile.surfaceClass !== 'gas_giant' && profile.surfaceClass !== 'no_surface') {
    const chunkCells = Math.max(1024, Math.floor(options.chunkCells || 8192));
    const yieldControl = typeof options.yieldControl === 'function' ? options.yieldControl : defaultYieldControl;
    for (let start = 0; start < grid.cellCount; start += chunkCells) {
      const end = Math.min(grid.cellCount, start + chunkCells);
      sampleGridFields(grid, sampler, arrays, start, end, temperatureBase);
      if (onProgress) onProgress('fields', end / grid.cellCount);
      if (end < grid.cellCount) await yieldControl({ stage: 'fields', start: start, end: end });
    }
  }
  return finishGeography(grid, profile, sampler, arrays, temperatureBase, options);
}

function typedBytesOf(geography: GeographyResult): number {
  let total = 0;
  const source = geography as unknown as Record<string, unknown>;
  for (const name of ARRAY_FIELDS) {
    const value = source[name];
    if (geography && ArrayBuffer.isView(value)) total += value.byteLength;
  }
  return total;
}

function validateGeography(grid: PlanetGrid, geography: GeographyResult): GeographyValidation {
  const checks: Record<string, boolean> = {};
  if (!grid || !geography) return { ok: false, checks: { shape: false } };
  checks.shape = geography.cellCount === grid.cellCount && geography.v === grid.v;
  checks.versions = geography.noiseVersion === NOISE_VERSION && geography.geographyVersion === GEOGRAPHY_VERSION;
  let lengths = true;
  const source = geography as unknown as Record<string, { length: number } | undefined>;
  for (const name of ARRAY_FIELDS) {
    const value = source[name];
    if (!value || value.length !== grid.cellCount) lengths = false;
  }
  checks.arrayLengths = lengths;
  if (!lengths) return { ok: false, checks };
  let finite = true;
  let ranges = true;
  let softSum = true;
  let ids = true;
  let weights = true;
  const floatFields = ['elevation', 'moisture', 'temperature', 'plateAffinity', 'volcanism', 'detail',
    'muLand', 'muShelf', 'muOcean', 'plateBoundary', 'continentSupport',
    'continentTop1Weight', 'continentTop2Weight', 'continentEntropy', 'oceanSupport', 'oceanBasinWeight'];
  const unitFields = ['moisture', 'temperature', 'plateAffinity', 'volcanism', 'muLand', 'muShelf',
    'muOcean', 'plateBoundary', 'continentSupport', 'continentTop1Weight', 'continentTop2Weight',
    'continentEntropy', 'oceanSupport', 'oceanBasinWeight'];
  const numeric = geography as unknown as Record<string, Float32Array>;
  for (let c = 0; c < grid.cellCount; c++) {
    for (let i = 0; i < floatFields.length; i++) {
      if (!Number.isFinite((numeric[floatFields[i] as string] as Float32Array)[c] as number)) finite = false;
    }
    if ((geography.elevation[c] as number) < -1.00001 || (geography.elevation[c] as number) > 1.00001 ||
        (geography.detail[c] as number) < -1.00001 || (geography.detail[c] as number) > 1.00001) ranges = false;
    for (let i = 0; i < unitFields.length; i++) {
      const v = (numeric[unitFields[i] as string] as Float32Array)[c] as number;
      if (v < -1e-6 || v > 1.000001) ranges = false;
    }
    if (geography.surfaceApplicable) {
      const sum = (geography.muLand[c] as number) + (geography.muShelf[c] as number) + (geography.muOcean[c] as number);
      if (Math.abs(sum - 1) > 1e-4) softSum = false;
      const wSum = (geography.continentTop1Weight[c] as number) + (geography.continentTop2Weight[c] as number);
      if ((geography.continentTop1Id[c] as number) >= 0 && Math.abs(wSum - 1) > 1e-4) weights = false;
      if ((geography.continentTop1Id[c] as number) < -1 || (geography.continentTop1Id[c] as number) >= Math.max(1, geography.continents.length) ||
          (geography.continentTop2Id[c] as number) < -1 || (geography.continentTop2Id[c] as number) >= Math.max(1, geography.continents.length) ||
          (geography.oceanBasinId[c] as number) < -1 || (geography.oceanBasinId[c] as number) >= Math.max(1, geography.oceanBasins.length) ||
          (geography.plateId[c] as number) < 0 || (geography.plateId[c] as number) >= PLATE_COUNT) ids = false;
      if ((geography.continentTop1Id[c] as number) >= 0 && geography.continentTop1Id[c] === geography.continentTop2Id[c]) ids = false;
    }
  }
  checks.finite = finite;
  checks.ranges = ranges;
  checks.softMembershipSum = geography.surfaceApplicable ? softSum : true;
  checks.continentWeights = geography.surfaceApplicable ? weights : true;
  checks.ids = geography.surfaceApplicable ? ids : true;
  checks.stats = !!geography.stats;
  const ok = Object.keys(checks).every(function (key) { return checks[key] as boolean; });
  return { ok, checks, typedBytes: typedBytesOf(geography) };
}

function listTransferableBuffers(geography: GeographyResult): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const buffers: ArrayBuffer[] = [];
  const source = geography as unknown as Record<string, unknown>;
  for (const name of ARRAY_FIELDS) {
    const value = geography && source[name];
    if (ArrayBuffer.isView(value) && value.buffer && value.buffer.byteLength > 1024 && !seen.has(value.buffer as ArrayBuffer)) {
      seen.add(value.buffer as ArrayBuffer);
      buffers.push(value.buffer as ArrayBuffer);
    }
  }
  return buffers;
}

function packGeographyForTransfer(geography: GeographyResult): { message: GeographyResult; transfer: ArrayBuffer[] } {
  return { message: geography, transfer: listTransferableBuffers(geography) };
}

const PlanetGeography = {
  GRID_VERSION,
  NOISE_VERSION,
  GEOGRAPHY_VERSION,
  PRESET_VERSION,
  EARTH_RADIUS_KM,
  EARTH_CANONICAL_V,
  PLATE_COUNT,
  SURFACE_CLASSES: SURFACE_CLASSES.slice(),
  FIELD_INDEX,
  ARRAY_FIELDS: ARRAY_FIELDS.slice(),
  GENERATION_CONTRACT,
  getPresetRuntimeValues: presetRuntimeValues,
  DEFAULT_PROFILE: Object.assign({}, DEFAULT_PROFILE),
  xxHash32,
  parseMasterSeedHex,
  masterSeedHexFromText,
  domainSeed: function (masterSeedHex: string, domain: string): number {
    return domainSeed(parseMasterSeedHex(masterSeedHex), domain);
  },
  normalizeProfile,
  createFieldSampler,
  expectedFrequency,
  generateGeography,
  generateGeographyAsync,
  validateGeography,
  typedBytesOf,
  listTransferableBuffers,
  packGeographyForTransfer,
};

export type PlanetGeographyApi = typeof PlanetGeography;

declare global {
  interface Window {
    PlanetGeography: PlanetGeographyApi;
  }
}

(globalThis as typeof globalThis & { PlanetGeography: PlanetGeographyApi }).PlanetGeography = PlanetGeography;

export default PlanetGeography;
