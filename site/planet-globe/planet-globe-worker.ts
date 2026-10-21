/* Worker боевого глобуса (Этап 6, CR-01 PR 4: строгий TS + И-1).
   -------------------------------------------------------------------------
   Считает вне UI-потока: сетку goldberg-gp-v1 (с общим IndexedDB-кэшем
   топологии), поверхность c100-soft-v2 и GPU-геометрию planet-globe-v1.
   Главному потоку отправляет только transferable-массивы геометрии и
   компактные сводки; полная поверхность остаётся здесь и отвечает на
   pick и смену цветового слоя без повторной генерации.

   И-1 (закрытие дыры мобильного LOD): каноническая география
   c100-soft-v1 и гидрология/биомы c100-soft-v2 ВСЕГДА считаются на
   canonicalV = expectedFrequency(radiusKm) с каноническим профилем,
   и на ПК, и на телефоне. Пониженный мобильный renderV больше НЕ
   перегенерирует планету: это только прокси-меш отрисовки, на который
   готовые канонические поля проецируются семплированием по центру
   render-ячейки (GeodesicGrid.pick по канонической сетке). Масштабных
   «ячеечных» норм render-профиля больше нет. Адреса
   goldberg-gp-v1/w0/v<canonicalV>/<cell> и идентичности
   continentTop1Id/drainageRegionId идентичны на телефоне и ПК на 100%,
   потому что pick всегда идёт по канонической сетке и поверхности.

   Протокол:
     generate { token, requestId, profile, renderV, colorMode, reliefScale,
                fallbackPreview }
       -> status/progress -> ready { geometry, summary, preview? }
     color-mode { token, requestId, mode }
       -> colors { colors:Uint8Array }
     pick { token, requestId, direction:[x,y,z], purpose:'select'|'hover' }
       -> pick-result { info }
     clear-grid-cache -> cache-cleared
*/

import GeodesicGrid from '../shared/geodesic-grid.ts';
import type { PlanetGrid } from '../shared/geodesic-grid.ts';
import { verifyGenerationKey } from '../shared/planet-generation-contract.ts';
import type { GenerationKeyVerification, PlanetGenerationProfileInput } from '../shared/planet-generation-contract.ts';
import PlanetGeography from '../shared/planet-geography.ts';
import type { GeographyProfileInput } from '../shared/planet-geography.ts';
import PlanetSurface from '../shared/planet-surface.ts';
import type { SurfaceProfile, SurfaceResult } from '../shared/planet-surface.ts';
import PlanetGlobe from '../shared/planet-globe.ts';
import type { GlobeGeometry } from '../shared/planet-globe.ts';

interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const workerScope = globalThis as unknown as WorkerScopeLike;
const idbFactory = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

interface GenerateMessage {
  type: 'generate';
  token?: string;
  requestId?: string | number;
  profile?: GeographyProfileInput;
  renderV?: number;
  colorMode?: string;
  reliefScale?: number;
  fallbackPreview?: boolean;
}

interface ColorModeMessage {
  type: 'color-mode';
  token?: string;
  requestId?: string | number;
  mode?: string;
}

interface PickMessage {
  type: 'pick';
  token?: string;
  requestId?: string | number;
  direction?: number[];
  purpose?: string;
}

interface ClearCacheMessage {
  type: 'clear-grid-cache';
  token?: string;
  requestId?: string | number;
}

type WorkerMessage = GenerateMessage | ColorModeMessage | PickMessage | ClearCacheMessage;

interface CodedError extends Error {
  code?: string;
  generationKeyVerification?: GenerationKeyVerification;
}

/* ---------------------------------------------------- IndexedDB топологии */
/* Тот же физический кэш, что у planet-test: сетка v=128 строится один раз
   на браузер, а не одна копия на каждую страницу. */
let idbPromise: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!idbPromise) {
    idbPromise = new Promise<IDBDatabase>(function (resolve, reject) {
      const req = idbFactory.open('planet-spike-cache', 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('mesh')) req.result.createObjectStore('mesh');
        if (!req.result.objectStoreNames.contains('grids')) req.result.createObjectStore('grids');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  return idbPromise;
}
function idbGet(key: string): Promise<Uint8Array | null> {
  return idb().then(function (db) {
    return new Promise<Uint8Array | null>(function (resolve, reject) {
      const req = db.transaction('grids', 'readonly').objectStore('grids').get(key);
      req.onsuccess = function () { resolve((req.result as Uint8Array | undefined) || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function idbPut(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
  return idb().then(function (db) {
    return new Promise<void>(function (resolve, reject) {
      const req = db.transaction('grids', 'readwrite').objectStore('grids').put(value, key);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function gridKey(v: number): string { return 'gp-v1-bin:' + v; }

/* --------------------------------------------------------------- состояние */

interface CurrentPlanet {
  token: string | undefined;
  grid: PlanetGrid;
  surface: SurfaceResult;
  renderSurface: SurfaceResult;
  vertexCellId: Uint32Array;
  cellCount: number;
  reliefScale: number;
  colorMode: string;
}

const memoryGrids = new Map<number, PlanetGrid>();
let current: CurrentPlanet | null = null;
let generationBusy = false;
let pendingGenerate: GenerateMessage | null = null;

function post(type: string, payload?: Record<string, unknown>, transfer?: Transferable[]): void {
  const message = payload || {};
  message.type = type;
  if (transfer && transfer.length) workerScope.postMessage(message, transfer);
  else workerScope.postMessage(message);
}
function progress(token: string | undefined, requestId: string | number | undefined, stage: string, fraction: number, label?: string): void {
  post('progress', {
    token: token, requestId: requestId, stage: stage,
    fraction: Math.max(0, Math.min(1, fraction)), label: label || '',
  });
}

function assertGenerationKey(inputProfile: GeographyProfileInput): GenerationKeyVerification {
  const verification = verifyGenerationKey((inputProfile || {}) as PlanetGenerationProfileInput);
  if (!verification.ok) {
    const err = new Error(
      'Проверка generation_key не пройдена: ' +
      (verification.reason || 'PG1 не совпал') +
      (verification.expectedKey ? '; ожидался ' + verification.expectedKey : ''),
    ) as CodedError;
    err.code = 'GENERATION_KEY_MISMATCH';
    err.generationKeyVerification = verification;
    throw err;
  }
  return verification;
}

interface CanonicalInfo {
  requestProfile: GeographyProfileInput;
  canonical: SurfaceProfile;
  generationKeyVerification: GenerationKeyVerification;
  canonicalV: number;
  renderV: number;
  ratio: number;
}

function canonicalProfileInfo(inputProfile: GeographyProfileInput, renderV: number): CanonicalInfo {
  // Frozen-ключ проверяется по исходному каноническому профилю. И-1:
  // дальше профиль НЕ масштабируется под renderV — генерация всегда
  // каноническая, renderV влияет только на прокси-меш.
  const generationKeyVerification = assertGenerationKey(inputProfile || {});
  const profile = PlanetSurface.normalizeSurfaceProfile(inputProfile || {});
  const canonicalV = PlanetGeography.expectedFrequency(profile.radiusKm);
  return {
    requestProfile: inputProfile || {},
    canonical: profile,
    generationKeyVerification: generationKeyVerification,
    canonicalV: canonicalV,
    renderV: renderV,
    ratio: renderV / canonicalV,
  };
}

function yieldLoop(): Promise<void> {
  return new Promise<void>(function (resolve) { setTimeout(resolve, 0); });
}

async function getGrid(
  v: number, token: string | undefined, requestId: string | number | undefined,
  progressFraction?: number,
): Promise<{ grid: PlanetGrid; source: string }> {
  const cached = memoryGrids.get(v);
  if (cached) return { grid: cached, source: 'memory' };
  const loaded = await GeodesicGrid.loadGridWithCache({
    expectedMeta: { v: v },
    readCache: function () { return idbGet(gridKey(v)); },
    writeCache: function (bytes) { return idbPut(gridKey(v), bytes); },
    rebuildGrid: function () { return GeodesicGrid.build(v); },
  });
  const validation = GeodesicGrid.validate(loaded.grid);
  if (!validation.ok) throw new Error('Сетка v=' + v + ' не прошла валидацию');
  memoryGrids.set(v, loaded.grid);
  while (memoryGrids.size > 3) {
    const oldest = memoryGrids.keys().next().value as number;
    if (oldest === v) break;
    memoryGrids.delete(oldest);
  }
  progress(token, requestId, 'mesh', progressFraction == null ? 0.10 : progressFraction,
    loaded.source === 'cache' ? 'Сетка загружена из кэша' : 'Сетка построена');
  return { grid: loaded.grid, source: loaded.source };
}

function round(x: number, digits?: number): number {
  const f = Math.pow(10, digits || 4);
  return Math.round((Number(x) || 0) * f) / f;
}

/* Проекция канонических полей на прокси-сетку renderV (И-1): каждая
   render-ячейка берёт поля канонической ячейки, содержащей её центр.
   Собирается только то подмножество полей, которое читают строители
   геометрии и цветов PlanetGlobe; авторитетная поверхность для pick
   и сводок остаётся канонической. */
function projectSurfaceToRender(canonicalGrid: PlanetGrid, surface: SurfaceResult, renderGrid: PlanetGrid): SurfaceResult {
  const n = renderGrid.cellCount;
  const mapping = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    mapping[i] = GeodesicGrid.pick(canonicalGrid, [
      renderGrid.centers[i * 3] as number,
      renderGrid.centers[i * 3 + 1] as number,
      renderGrid.centers[i * 3 + 2] as number,
    ]);
  }
  function gatherF32(source: Float32Array): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = source[mapping[i] as number] as number;
    return out;
  }
  function gatherI32(source: Int32Array): Int32Array {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = source[mapping[i] as number] as number;
    return out;
  }
  const biomeColor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const src = (mapping[i] as number) * 3;
    biomeColor[i * 3] = surface.biomeColor[src] as number;
    biomeColor[i * 3 + 1] = surface.biomeColor[src + 1] as number;
    biomeColor[i * 3 + 2] = surface.biomeColor[src + 2] as number;
  }
  const projected = {
    cellCount: n,
    seaLevel: surface.seaLevel,
    elevationMin: surface.elevationMin,
    elevationMax: surface.elevationMax,
    elevation: gatherF32(surface.elevation),
    moisture: gatherF32(surface.moisture),
    temperature: gatherF32(surface.temperature),
    volcanism: gatherF32(surface.volcanism),
    continentTop1Id: gatherI32(surface.continentTop1Id),
    continentTop1Weight: gatherF32(surface.continentTop1Weight),
    continentEntropy: gatherF32(surface.continentEntropy),
    oceanBasinId: gatherI32(surface.oceanBasinId),
    drainageRegionId: gatherI32(surface.drainageRegionId),
    streamWeight: gatherF32(surface.streamWeight),
    lakeWeight: gatherF32(surface.lakeWeight),
    deltaWeight: gatherF32(surface.deltaWeight),
    mountainWeight: gatherF32(surface.mountainWeight),
    mountainSeamWeight: gatherF32(surface.mountainSeamWeight),
    biomeColor: biomeColor,
  };
  return projected as unknown as SurfaceResult;
}

function surfaceSummary(info: CanonicalInfo, surface: SurfaceResult, geometry: GlobeGeometry, timings: Record<string, number>): Record<string, unknown> {
  const requestProfile = info.requestProfile as Record<string, unknown>;
  return {
    planetId: (requestProfile.planetId as string) || (requestProfile.planet_id as string) || '',
    presetId: surface.profile.presetId,
    surfaceClass: surface.profile.surfaceClass,
    masterSeedHex: surface.profile.masterSeedHex,
    generationKey: (requestProfile.generationKey as string) ||
      (requestProfile.generation_key as string) || null,
    generationKeyVerification: info.generationKeyVerification,
    radiusKm: surface.profile.radiusKm,
    canonicalV: info.canonicalV,
    renderV: info.renderV,
    renderRatio: round(info.ratio, 4),
    cellCount: surface.cellCount,
    renderCellCount: geometry.cellCount,
    triangleCount: geometry.triangleCount,
    vertexCount: geometry.vertexCount,
    geometryBytes: geometry.typedBytes,
    gridVersion: surface.gridVersion,
    noiseVersion: surface.noiseVersion,
    geographyVersion: surface.geographyVersion,
    surfaceVersion: surface.surfaceVersion,
    hydrologyVersion: surface.hydrologyVersion,
    biomeVersion: surface.biomeVersion,
    seaLevel: surface.seaLevel,
    thresholds: surface.thresholds,
    stats: surface.stats,
    biomeDefinitions: surface.biomeDefinitions,
    counts: {
      continents: surface.continents.length,
      oceanBasins: surface.oceanBasins.length,
      plates: surface.plates.length,
      catchments: surface.catchments.length,
      drainageRegions: surface.drainageRegions.length,
      lakes: surface.lakes.length,
      mountainRanges: surface.mountainRanges.length,
    },
    // И-1: нормы больше не масштабируются под renderV — это фактические
    // канонические нормы генерации на любом устройстве.
    renderProfileCells: {
      continentMeanCells: info.canonical.continentMeanCells,
      oceanBasinMeanCells: info.canonical.oceanBasinMeanCells,
      drainageMeanCells: info.canonical.drainageMeanCells,
    },
    timingsMs: timings,
  };
}

async function runGenerate(message: GenerateMessage): Promise<void> {
  const token = message.token;
  const requestId = message.requestId;
  const started = performance.now();
  const renderV = Math.max(4, Math.min(256, Math.round(Number(message.renderV) || 32)));
  const colorMode = message.colorMode || 'biome';
  const reliefScale = message.reliefScale == null ? 1 : Number(message.reliefScale);
  try {
    progress(token, requestId, 'profile', 0.02, 'Профиль планеты');
    const info = canonicalProfileInfo(message.profile || {}, renderV);
    progress(token, requestId, 'mesh', 0.05, 'Сетка v=' + info.canonicalV);
    const meshStarted = performance.now();
    const gridResult = await getGrid(info.canonicalV, token, requestId);
    const grid = gridResult.grid;
    const meshMs = performance.now() - meshStarted;

    progress(token, requestId, 'surface', 0.12, 'Поля, континенты, реки и биомы');
    const surfaceStarted = performance.now();
    const surface = await PlanetSurface.generateSurfaceAsync(grid, info.canonical as unknown as GeographyProfileInput, {
      chunkCells: 8192,
      onProgress: function (stage, fraction) {
        progress(token, requestId, stage, 0.12 + fraction * 0.68,
          stage === 'fields' ? 'Поля и плиты' :
          stage === 'geography' ? 'Море и континенты' :
          stage === 'hydrology' ? 'Сток, реки и озёра' :
          stage === 'biomes' ? 'Биомы' : 'Поверхность');
      },
      yieldControl: yieldLoop,
    });
    const surfaceMs = performance.now() - surfaceStarted;
    if (!surface.surfaceApplicable) {
      const err = new Error('У этого типа тела нет твёрдой поверхности: глобус Этапа 6 её не рисует.') as CodedError;
      err.code = 'NO_SURFACE';
      throw err;
    }
    const validation = PlanetSurface.validateSurface(grid, surface);
    if (!validation.ok) throw new Error('Поверхность не прошла валидацию: ' + JSON.stringify(validation.checks));

    progress(token, requestId, 'geometry', 0.84, 'GPU-геометрия ячеек');
    await yieldLoop();
    const geometryStarted = performance.now();
    let renderGrid = grid;
    let renderSurface = surface;
    if (renderV !== info.canonicalV) {
      // Мобильный прокси-меш (И-1): геометрия грубее, поля — канонические.
      const proxy = await getGrid(renderV, token, requestId, 0.845);
      renderGrid = proxy.grid;
      renderSurface = projectSurfaceToRender(grid, surface, renderGrid);
    }
    const geometry = PlanetGlobe.buildGlobeGeometry(renderGrid, renderSurface, {
      colorMode: colorMode,
      reliefScale: reliefScale,
    });
    const geometryMs = performance.now() - geometryStarted;

    let preview = null;
    if (message.fallbackPreview) {
      progress(token, requestId, 'preview', 0.94, '2D fallback-развёртка');
      await yieldLoop();
      preview = PlanetGlobe.buildEquirectPreview(renderGrid, renderSurface, 720, 360, colorMode);
    }

    current = {
      token: token,
      grid: grid,
      surface: surface,
      renderSurface: renderSurface,
      vertexCellId: geometry.vertexCellId,
      cellCount: geometry.cellCount,
      reliefScale: reliefScale,
      colorMode: colorMode,
    };

    const payloadGeometry = {
      version: geometry.version,
      v: geometry.v,
      cellCount: geometry.cellCount,
      vertexCount: geometry.vertexCount,
      triangleCount: geometry.triangleCount,
      indexCount: geometry.indexCount,
      positions: geometry.positions,
      normals: geometry.normals,
      colors: geometry.colors,
      indices: geometry.indices,
      chunkRanges: geometry.chunkRanges,
      reliefScale: geometry.reliefScale,
      typedBytes: geometry.typedBytes,
    };
    const transfer: Transferable[] =
      PlanetGlobe.listGeometryTransferables(payloadGeometry as unknown as GlobeGeometry, false) as Transferable[];
    if (preview && preview.data && preview.data.buffer) transfer.push(preview.data.buffer as ArrayBuffer);
    const summary = surfaceSummary(info, surface, geometry, {
      mesh: round(meshMs, 1),
      surface: round(surfaceMs, 1),
      geometry: round(geometryMs, 1),
      total: round(performance.now() - started, 1),
    });
    summary.gridSource = gridResult.source;
    // 100% страница покажет только после GPU-подмены; worker завершил CPU-часть.
    progress(token, requestId, 'ready', 0.84, 'CPU-часть готова');
    post('ready', {
      token: token, requestId: requestId,
      geometry: payloadGeometry,
      summary: summary,
      preview: preview,
      colorMode: colorMode,
    }, transfer);
  } catch (err) {
    const e = err as CodedError;
    post('error', {
      token: token, requestId: requestId,
      code: e && e.code ? e.code : 'GENERATE_FAILED',
      message: e && e.message ? e.message : String(err),
      stack: e && e.stack ? String(e.stack) : '',
    });
  }
}

function pickInfo(direction: number[]): Record<string, unknown> {
  if (!current) throw new Error('Планета ещё не сгенерирована');
  const grid = current.grid;
  const s = current.surface;
  const len = Math.hypot(direction[0] as number, direction[1] as number, direction[2] as number) || 1;
  const dir = [(direction[0] as number) / len, (direction[1] as number) / len, (direction[2] as number) / len];
  const started = performance.now();
  const cell = GeodesicGrid.pick(grid, dir);
  const pickMs = performance.now() - started;
  const center = [grid.centers[cell * 3] as number, grid.centers[cell * 3 + 1] as number, grid.centers[cell * 3 + 2] as number];
  const continentId = s.continentTop1Id[cell] as number;
  const continent2Id = s.continentTop2Id[cell] as number;
  const catchmentId = s.catchmentId[cell] as number;
  const drainageRegionId = s.drainageRegionId[cell] as number;
  const lakeId = s.lakeId[cell] as number;
  const rangeId = s.mountainRangeId[cell] as number;
  const biome1 = s.biomeTop1Id[cell] as number;
  const biome2 = s.biomeTop2Id[cell] as number;
  const polygon = PlanetGlobe.cellPolygon(grid, s, cell, {
    reliefScale: current.reliefScale,
    inflate: 1.006,
  });
  const hardClass = (s.elevation[cell] as number) > s.seaLevel ? 'land' :
    ((s.elevation[cell] as number) >= s.shelfBelowLevel ? 'shelf' : 'ocean');
  return {
    cell: cell,
    address: GeodesicGrid.addressOf(grid, cell),
    pickMs: round(pickMs, 3),
    latitudeDeg: round(Math.asin(Math.max(-1, Math.min(1, center[1] as number))) * 180 / Math.PI, 2),
    longitudeDeg: round(Math.atan2(center[2] as number, center[0] as number) * 180 / Math.PI, 2),
    areaKm2: round((grid.areas[cell] as number) * s.radiusKm * s.radiusKm, 1),
    centerDirection: center,
    polygon: polygon,
    hardClass: hardClass,
    elevation: s.elevation[cell],
    seaLevel: s.seaLevel,
    elevationRelative: round((s.elevation[cell] as number) - s.seaLevel, 5),
    filledElevation: s.filledElevation[cell],
    depressionDepth: s.depressionDepth[cell],
    slope: s.slope[cell],
    temperature: s.temperature[cell],
    moisture: s.moisture[cell],
    volcanism: s.volcanism[cell],
    mu: {
      land: s.muLand[cell],
      shelf: s.muShelf[cell],
      ocean: s.muOcean[cell],
    },
    coastDistanceCells: s.signedCoastDistanceCells[cell],
    plateId: s.plateId[cell],
    plateBoundary: s.plateBoundary[cell],
    continent: continentId >= 0 ? {
      top1Id: continentId,
      top1Weight: s.continentTop1Weight[cell],
      top2Id: continent2Id,
      top2Weight: s.continentTop2Weight[cell],
      entropy: s.continentEntropy[cell],
      effectiveAreaKm2: s.continents[continentId] ? (s.continents[continentId] as { effectiveAreaKm2: number }).effectiveAreaKm2 : 0,
    } : null,
    oceanBasinId: s.oceanBasinId[cell],
    oceanBasinWeight: s.oceanBasinWeight[cell],
    physicalLandmassId: s.physicalLandmassId[cell],
    flow: {
      receiver: s.flowReceiver[cell],
      accumulationKm2: s.flowAccumulationKm2[cell],
      streamWeight: s.streamWeight[cell],
      riverInfluence: s.riverInfluence[cell],
      deltaWeight: s.deltaWeight[cell],
      lakeWeight: s.lakeWeight[cell],
      terminalType: s.terminalType[cell],
    },
    catchment: catchmentId >= 0 && s.catchments[catchmentId] ? {
      id: catchmentId,
      terminalType: (s.catchments[catchmentId] as { terminalType: string }).terminalType,
      cellCount: (s.catchments[catchmentId] as { cellCount: number }).cellCount,
      areaKm2: (s.catchments[catchmentId] as { areaKm2: number }).areaKm2,
      maxFlowKm2: (s.catchments[catchmentId] as { maxFlowKm2: number }).maxFlowKm2,
    } : null,
    drainageRegion: drainageRegionId >= 0 && s.drainageRegions[drainageRegionId] ? {
      id: drainageRegionId,
      terminalType: (s.drainageRegions[drainageRegionId] as { terminalType: string }).terminalType,
      cellCount: (s.drainageRegions[drainageRegionId] as { cellCount: number }).cellCount,
      areaKm2: (s.drainageRegions[drainageRegionId] as { areaKm2: number }).areaKm2,
      catchmentCount: (s.drainageRegions[drainageRegionId] as { catchmentCount: number }).catchmentCount,
    } : null,
    // Латентный баг JS-воркера исправлен при порте: рекорды озёр несут
    // effectiveAreaKm2 и overflowing, а не areaKm2/terminal.
    lake: lakeId >= 0 && s.lakes[lakeId] ? {
      id: lakeId,
      cellCount: (s.lakes[lakeId] as { cellCount: number }).cellCount,
      areaKm2: (s.lakes[lakeId] as { effectiveAreaKm2: number }).effectiveAreaKm2,
      terminal: !(s.lakes[lakeId] as { overflowing: boolean }).overflowing,
    } : null,
    mountains: {
      weight: s.mountainWeight[cell],
      seamWeight: s.mountainSeamWeight[cell],
      rangeId: rangeId,
    },
    biome: {
      top1Id: biome1,
      top1Key: s.biomeDefinitions[biome1] ? (s.biomeDefinitions[biome1] as { key: string }).key : '',
      top1Weight: s.biomeTop1Weight[cell],
      top2Id: biome2,
      top2Key: biome2 >= 0 && s.biomeDefinitions[biome2] ? (s.biomeDefinitions[biome2] as { key: string }).key : '',
      top2Weight: s.biomeTop2Weight[cell],
      entropy: s.biomeEntropy[cell],
    },
  };
}

async function ensureGeneration(message: GenerateMessage): Promise<void> {
  if (generationBusy) {
    pendingGenerate = message;
    return;
  }
  generationBusy = true;
  try {
    await runGenerate(message);
  } finally {
    generationBusy = false;
    if (pendingGenerate) {
      const next = pendingGenerate;
      pendingGenerate = null;
      void ensureGeneration(next);
    }
  }
}

workerScope.onmessage = function (event: MessageEvent) {
  const message = (event.data || {}) as WorkerMessage;
  try {
    if (message.type === 'generate') {
      void ensureGeneration(message);
    } else if (message.type === 'color-mode') {
      if (!current) throw new Error('Планета ещё не сгенерирована');
      const mode = message.mode || 'biome';
      const colors = PlanetGlobe.buildVertexColors(current.renderSurface, current.vertexCellId, mode, current.cellCount);
      current.colorMode = mode;
      post('colors', {
        token: message.token, requestId: message.requestId, mode: mode, colors: colors,
      }, [colors.buffer as ArrayBuffer]);
    } else if (message.type === 'pick') {
      const info = pickInfo(message.direction || [0, 0, 1]);
      post('pick-result', {
        token: message.token, requestId: message.requestId,
        purpose: message.purpose || 'select', info: info,
      });
    } else if (message.type === 'clear-grid-cache') {
      idb().then(function (db) {
        return new Promise<void>(function (resolve, reject) {
          const req = db.transaction('grids', 'readwrite').objectStore('grids').clear();
          req.onsuccess = function () { resolve(); };
          req.onerror = function () { reject(req.error); };
        });
      }).then(function () {
        memoryGrids.clear();
        post('cache-cleared', { token: message.token, requestId: message.requestId });
      }).catch(function (err) {
        post('error', { token: message.token, requestId: message.requestId, code: 'CACHE_CLEAR_FAILED', message: String((err as Error) && (err as Error).message || err) });
      });
    }
  } catch (err) {
    const e = err as CodedError;
    post('error', {
      token: message.token, requestId: message.requestId,
      code: e && e.code ? e.code : 'WORKER_FAILED',
      message: e && e.message ? e.message : String(err),
      stack: e && e.stack ? String(e.stack) : '',
    });
  }
};

post('worker-ready', {
  globeVersion: PlanetGlobe.GLOBE_VERSION,
  gridVersion: GeodesicGrid.GRID_VERSION,
  surfaceVersion: PlanetSurface.SURFACE_VERSION,
});
