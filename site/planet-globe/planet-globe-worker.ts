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

   Stage-8.8.2 (A-1): прокси и финал приезжают в ОДНОМ ответе. Запрос с
   необязательным proxyV строит каноническую поверхность РОВНО ОДИН раз и
   возвращает в ready два слоя той же генерации: proxy (сетка proxyV) и
   geometry (сетка renderV). Без proxyV (или при proxyV >= renderV) ответ
   прежний: одна геометрия, поля proxy в сообщении нет. pick/prefetch/
   extract-patch по-прежнему считают по канонической сетке и поверхности.

   Протокол:
     generate { token, requestId, profile, renderV, colorMode, reliefScale,
                fallbackPreview, proxyV? }
       -> status/progress -> ready { geometry, summary, preview?, proxy? }
     color-mode { token, requestId, mode, renderV? }
       -> colors { colors:Uint8Array }
     pick { token, requestId, direction:[x,y,z], purpose:'select'|'hover' }
       -> pick-result { info }
     prefetch { token, requestId, targetV?, focusCell?|focusDirection? }
                (Этап 7: intent-based прогрев, latest-wins)
       -> prefetch-ready { targetV, focusCell, hexCenterCell, chunkId,
                           neighborChunks, patchReady, timingsMs }
     extract-patch { token, requestId, cell }
                (Этап 7: канонический срез Patch7 по И-1/И-3)
       -> patch-ready { requestedCell, hexCenterCell, canonicalAddress, patch,
                        invariants, spanMeters, buildableFraction, keys }
     clear-grid-cache -> cache-cleared
*/

import GeodesicGrid from '../shared/geodesic-grid.ts';
import type { PlanetGrid } from '../shared/geodesic-grid.ts';
import { verifyGenerationKey, computeGenerationKey } from '../shared/planet-generation-contract.ts';
import type { GenerationKeyVerification, PlanetGenerationProfileInput } from '../shared/planet-generation-contract.ts';
import PlanetGeography from '../shared/planet-geography.ts';
import type { GeographyProfileInput } from '../shared/planet-geography.ts';
import PlanetSurface from '../shared/planet-surface.ts';
import type { SurfaceProfile, SurfaceResult } from '../shared/planet-surface.ts';
import PlanetGlobe from '../shared/planet-globe.ts';
import type { GlobeGeometry } from '../shared/planet-globe.ts';
import { buildGlobeGeometry, buildVertexColors } from '../shared/planet-globe-pack.ts';
import { LOCAL_MAP_PATCH_VERSION, buildPatch7, withBoundaryInflows, verifyPatchInvariants, patchSpanMeters, buildBuildingSpawnMask } from '../../src/local-map/local-map-contract.ts';
import type { LocalMapPatch, PatchInvariantReport } from '../../src/local-map/local-map-contract.ts';

interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const workerScope = globalThis as unknown as WorkerScopeLike;
const idbFactory = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;

export interface GenerateMessage {
  type: 'generate';
  token?: string;
  requestId?: string | number;
  profile?: GeographyProfileInput;
  renderV?: number;
  /** Stage-8.8.2 (A-1): частота прокси-сетки для того же канонического
   *  расчёта. Необязательное поле: нет значения или proxyV >= renderV —
   *  прежний ответ с одной геометрией (обратная совместимость). */
  proxyV?: number;
  colorMode?: string;
  reliefScale?: number;
  fallbackPreview?: boolean;
}

export interface ColorModeMessage {
  type: 'color-mode';
  token?: string;
  requestId?: string | number;
  mode?: string;
  /** Stage-8.8.2 (A-1): слой цветов для указанной renderV (во время показа
   *  прокси). Нет поля — цвета по current (финальная геометрия), как раньше. */
  renderV?: number;
}

export interface PickMessage {
  type: 'pick';
  token?: string;
  requestId?: string | number;
  direction?: number[];
  /** Этап 7: выбор напрямую по каноническому индексу или адресу ячейки (?cell=). */
  cell?: number | string;
  purpose?: string;
}

export interface ClearCacheMessage {
  type: 'clear-grid-cache';
  token?: string;
  requestId?: string | number;
}

/** Этап 7: intent-based прогрев целевого уровня и соседних чанков.
 *  Отменяется по принципу latest-wins: новый prefetch инкрементирует
 *  seq, а завершение устаревшей задачи молча отбрасывается. */
export interface PrefetchMessage {
  type: 'prefetch';
  token?: string;
  requestId?: string | number;
  /** Целевая частота прокси-сетки для прогрева GridCache. */
  targetV?: number;
  /** Фокус камеры единичным вектором сферы (x, y, z). */
  focusDirection?: ArrayLike<number>;
  /** Или напрямую каноническая ячейка фокуса на canonicalV (И-1). */
  focusCell?: number;
}

/** Этап 7/W23d: экспорт канонического среза 7 ячеек Patch7 (local-map-patch-v2)
 *  вокруг hexCenterCell строго на canonicalV (И-1, Инвариант И-3). */
export interface ExtractPatchMessage {
  type: 'extract-patch';
  token?: string;
  requestId?: string | number;
  /** Каноническая ячейка (или пятиугольник, который резолвится в сосед). */
  cell: number;
}

export type WorkerMessage = GenerateMessage | ColorModeMessage | PickMessage | ClearCacheMessage
  | PrefetchMessage | ExtractPatchMessage;

/** Геометрия на проводе: без vertexCellId/cellIndexStart (pick живёт в воркере). */
export type GlobeWireGeometry = Omit<GlobeGeometry, 'vertexCellId' | 'cellIndexStart'>;

export interface GlobeBiomeDefinition {
  key: string;
  nameRu?: string;
  [field: string]: unknown;
}

export interface GlobeSummary {
  planetId: string;
  presetId: string;
  surfaceClass: string;
  masterSeedHex: string;
  generationKey: string;
  generationKeyVerification?: GenerationKeyVerification;
  radiusKm: number;
  canonicalV: number;
  renderV: number;
  renderRatio: number;
  cellCount: number;
  renderCellCount: number;
  triangleCount: number;
  vertexCount: number;
  geometryBytes: number;
  gridVersion: string;
  gridSource?: string;
  noiseVersion: string;
  geographyVersion: string;
  surfaceVersion: string;
  hydrologyVersion: string;
  biomeVersion: string;
  seaLevel: number;
  thresholds: Record<string, number>;
  stats: Record<string, unknown>;
  biomeDefinitions: GlobeBiomeDefinition[];
  counts: Record<string, number>;
  renderProfileCells: Record<string, number>;
  timingsMs: Record<string, number>;
}

export interface GlobePickContinent {
  top1Id: number;
  top1Weight: number;
  top2Id: number;
  top2Weight: number;
  entropy: number;
  effectiveAreaKm2: number;
}

export interface GlobePickInfo {
  cell: number;
  address: string;
  pickMs: number;
  latitudeDeg: number;
  longitudeDeg: number;
  areaKm2: number;
  centerDirection: number[];
  polygon: unknown;
  hardClass: string;
  elevation: number;
  seaLevel: number;
  elevationRelative: number;
  filledElevation: number;
  depressionDepth: number;
  slope: number;
  temperature: number;
  moisture: number;
  volcanism: number;
  mu: { land: number; shelf: number; ocean: number };
  coastDistanceCells: number;
  plateId: number;
  plateBoundary: number;
  continent: GlobePickContinent | null;
  oceanBasinId: number;
  oceanBasinWeight: number;
  physicalLandmassId: number;
  flow: {
    receiver: number;
    accumulationKm2: number;
    streamWeight: number;
    riverInfluence: number;
    deltaWeight: number;
    lakeWeight: number;
    terminalType: number;
  };
  catchment: {
    id: number;
    terminalType: string;
    cellCount: number;
    areaKm2: number;
    maxFlowKm2: number;
  } | null;
  drainageRegion: {
    id: number;
    terminalType: string;
    cellCount: number;
    areaKm2: number;
    catchmentCount: number;
  } | null;
  lake: {
    id: number;
    cellCount: number;
    areaKm2: number;
    terminal: boolean;
  } | null;
  mountains: {
    weight: number;
    seamWeight: number;
    rangeId: number;
  };
  biome: {
    top1Id: number;
    top1Key: string;
    top1Weight: number;
    top2Id: number;
    top2Key: string;
    top2Weight: number;
    entropy: number;
  };
}

export interface WorkerProgressResponse {
  type: 'progress';
  token?: string;
  requestId?: string | number;
  fraction: number;
  stage: string;
  label: string;
}

/** Stage-8.8.2 (A-1): прокси-слой совмещённого ответа — геометрия прокси-сетки
 *  (proxyV), построенная из той же канонической поверхности, что и финал. */
export interface GlobeProxyGeometry {
  renderV: number;
  geometry: GlobeWireGeometry;
  cellCount: number;
}

export interface WorkerReadyResponse {
  type: 'ready';
  token?: string;
  requestId?: string | number;
  geometry: GlobeWireGeometry;
  summary: GlobeSummary;
  colorMode?: string;
  preview?: { width: number; height: number; data: Uint8ClampedArray } | null;
  /** Stage-8.8.2 (A-1): есть только когда запрос пришёл с proxyV < renderV. */
  proxy?: GlobeProxyGeometry;
}

export interface WorkerColorsResponse {
  type: 'colors';
  token?: string;
  requestId?: string | number;
  mode?: string;
  colors: Uint8Array;
}

export interface WorkerPickResultResponse {
  type: 'pick-result';
  token?: string;
  requestId?: string | number;
  purpose?: string;
  info: GlobePickInfo | null;
}

export interface WorkerCacheClearedResponse {
  type: 'cache-cleared';
  token?: string;
  requestId?: string | number;
}

/** Замеры prefetch (Этап 7): прогрев сетки, сборка Patch7 и общее время. */
export interface PrefetchTimings {
  gridMs: number;
  patchMs: number;
  totalMs: number;
}

/** Этап 7: ответ на prefetch — целевой уровень прогрет, соседние чанки
 *  известны, срез Patch7 у центра взгляда собран заранее. */
export interface WorkerPrefetchReadyResponse {
  type: 'prefetch-ready';
  token?: string;
  requestId?: string | number;
  targetV: number;
  focusCell: number;
  hexCenterCell: number;
  chunkId: number;
  neighborChunks: number[];
  patchReady: boolean;
  timingsMs: PrefetchTimings;
}

/** Производные ключи ячейки/области/участка по §8.8 PREPARATION_PLAN. */
export interface PatchKeys {
  planetKey: string;
  cellKey: string;
  regionKey: string;
  patchKey: string;
}

/** Этап 7: канонический срез Patch7 с инвариантами И-3 и ключами §8.8. */
export interface WorkerPatchReadyResponse {
  type: 'patch-ready';
  token?: string;
  requestId?: string | number;
  requestedCell: number;
  hexCenterCell: number;
  canonicalAddress: string;
  patch: LocalMapPatch;
  invariants: PatchInvariantReport;
  spanMeters: number;
  buildableFraction: number;
  keys: PatchKeys;
}

export interface WorkerErrorResponse {
  type: 'error';
  token?: string;
  requestId?: string | number;
  message: string;
  code?: string;
  stack?: string;
  generationKeyVerification?: GenerationKeyVerification;
}

export type WorkerResponse = WorkerProgressResponse | WorkerReadyResponse | WorkerColorsResponse
  | WorkerPickResultResponse | WorkerCacheClearedResponse | WorkerPrefetchReadyResponse
  | WorkerPatchReadyResponse | WorkerErrorResponse
  | { type: 'worker-ready'; token?: string; requestId?: string | number };

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

/** Слой цветов: финальная renderSurface либо прокси-слой того же расчёта. */
interface ColorLayer {
  renderSurface: SurfaceResult;
  vertexCellId: Uint32Array;
  cellCount: number;
}

/** Stage-8.8.2 (A-1): прокси-слой совмещённой генерации. Живёт рядом с
 *  финалом, чтобы color-mode с renderV = proxyV отвечал цветами ровно того
 *  числа вершин, которое сейчас на экране. */
interface CurrentProxyLayer extends ColorLayer {
  renderV: number;
  renderGrid: PlanetGrid;
}

interface CurrentPlanet {
  token: string | undefined;
  /** Канонический профиль генерации (geographyVersion и нормы для И-1). */
  profile: SurfaceProfile;
  /** planetKey по §8.8: generation_key профиля или вычисленный PG1. */
  generationKey: string;
  canonicalV: number;
  renderV: number;
  /** Прокси-сетка отрисовки (совпадает с grid при renderV = canonicalV). */
  renderGrid: PlanetGrid;
  grid: PlanetGrid;
  surface: SurfaceResult;
  renderSurface: SurfaceResult;
  vertexCellId: Uint32Array;
  cellCount: number;
  /** Stage-8.8.2 (A-1): прокси-слой совмещённого ответа или null. */
  proxy: CurrentProxyLayer | null;
  reliefScale: number;
  colorMode: string;
  /** Кэш последнего среза Patch7 (упреждающая сборка prefetch). */
  lastPatchCache: { hexCenterCell: number; patch: LocalMapPatch } | null;
}

const memoryGrids = new Map<number, PlanetGrid>();
let current: CurrentPlanet | null = null;
let generationBusy = false;
let pendingGenerate: GenerateMessage | null = null;

/** Счётчик latest-wins для prefetch: новая задача отменяет старую. */
let latestPrefetchSeq = 0;

/* ------------------------------------------------------------- §8.8 ключи */

/** Детерминированный FNV-1a 64 (хэш-функция контракта §8.8): 16 hex-символов.
 *  64-битное состояние ведётся парой 32-битных половин, умножение на простую
 *  0x00000100000001B3 собирается из imul-частей без потери точности. */
function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hi = 0xcbf29ce4 >>> 0;
  let lo = 0x84222325 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ (bytes[i] as number)) >>> 0;
    const product = lo * 0x1b3; // < 2^41 — точно в float64
    const newLo = Math.imul(lo, 0x1b3) >>> 0;
    const carry = Math.floor(product / 0x100000000) >>> 0;
    hi = (Math.imul(hi, 0x1b3) + carry + Math.imul(lo, 0x100)) >>> 0;
    lo = newLo;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

/** renderV не бывает мельче 4 и детальнее канона (прокси — только грубее). */
function clampRenderV(requested: number, canonicalV: number): number {
  const v = Math.max(4, Math.min(256, Math.round(Number(requested) || canonicalV)));
  return Math.min(v, canonicalV);
}

/** Stage-8.8.2 (A-1): частота прокси-сетки из необязательного proxyV.
 *  Отсутствие поля или proxyV >= renderV означает «прокси не нужен»:
 *  вызывающий получает renderV и прежний ответ с одной геометрией. */
function normalizeProxyV(requested: number | undefined, renderV: number): number {
  if (requested == null) return renderV;
  const v = Math.round(Number(requested));
  if (!Number.isFinite(v)) return renderV;
  return Math.max(4, Math.min(256, v));
}

/** Ближайшая ячейка сетки к единичному направлению (обёртка GeodesicGrid.pick). */
function pickCell(grid: PlanetGrid, direction: ArrayLike<number>): number {
  return GeodesicGrid.pick(grid, [direction[0] as number, direction[1] as number, direction[2] as number]);
}

/** Этап 7: центральная ячейка среза Patch7 обязана быть шестиугольной.
 *  Пятиугольные вершины икосаэдра (neighborCount = 5) автоматически
 *  привязываются к первому шестиугольному соседу кольца. */
function resolveHexCenterCell(grid: PlanetGrid, cell: number): number {
  if (!Number.isInteger(cell) || cell < 0 || cell >= grid.cellCount) return -1;
  const neighborCount = grid.neighborCount[cell] as number;
  if (neighborCount === 6) return cell;
  if (neighborCount === 5) {
    for (let slot = 0; slot < 6; slot++) {
      const nb = grid.neighbors[cell * 6 + slot] as number;
      if (nb >= 0 && (grid.neighborCount[nb] as number) === 6) return nb;
    }
  }
  return -1;
}

/** Канонический адрес ячейки goldberg-gp-v1 на canonicalV (И-1). */
function canonicalCellAddress(grid: PlanetGrid, cell: number): string {
  return GeodesicGrid.addressOf(grid, cell);
}

/** Производные ключи ячейки, области и участка по §8.8 PREPARATION_PLAN:
 *    cell_key   = H(planet_key + '|' + canonical_address)
 *    region_key = H(planet_key + '|c100|' + top1ContinentId + '|' + geoVersion)
 *    patch_key  = H(planet_key + '|' + patch_version + '|' + hexCenterCell) */
function derivePatchKeys(planet: CurrentPlanet, hexCenterCell: number, canonicalAddress: string): PatchKeys {
  const planetKey = String(planet.generationKey || '');
  const geographyVersion = String(planet.profile.geographyVersion || '');
  const top1ContinentId = planet.surface.continentTop1Id[hexCenterCell] as number;
  return {
    planetKey: planetKey,
    cellKey: 'CK1-' + fnv1a64Hex(planetKey + '|' + canonicalAddress),
    regionKey: 'RK1-' + fnv1a64Hex(planetKey + '|c100|' + String(top1ContinentId) + '|' + geographyVersion),
    patchKey: 'PK1-' + fnv1a64Hex(planetKey + '|' + LOCAL_MAP_PATCH_VERSION + '|' + String(hexCenterCell)),
  };
}

/** Сборка Patch7 вокруг шестиугольной ячейки с кэшем prefetch (latest-wins). */
function buildPatchCached(planet: CurrentPlanet, hexCenterCell: number): LocalMapPatch {
  if (planet.lastPatchCache && planet.lastPatchCache.hexCenterCell === hexCenterCell) {
    return planet.lastPatchCache.patch;
  }
  // W23d: глобальная гидрология уже готова; добавляем только входящие дуги
  // второго кольца перед передачей Patch7 v2 в локальный worker.
  const patch = withBoundaryInflows(planet.grid, planet.surface,
    buildPatch7(planet.grid, planet.surface, hexCenterCell));
  planet.lastPatchCache = { hexCenterCell: hexCenterCell, patch: patch };
  return patch;
}

/** Подменяемый приёмник исходящих сообщений: null — обычный workerScope
 *  (браузерный worker), иначе обработчик createWorkerHandler копит ответы. */
type PostSink = (message: Record<string, unknown>, transfer?: Transferable[]) => void;
let postSink: PostSink | null = null;

function post(type: string, payload?: Record<string, unknown>, transfer?: Transferable[]): void {
  const message = payload || {};
  message.type = type;
  if (postSink) {
    postSink(message, transfer);
    return;
  }
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
  progressFraction?: number, emitProgress: boolean = true,
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
  // Прогрев prefetch (Этап 7) молчит: это фоновая задача, а не этап генерации.
  if (emitProgress) {
    progress(token, requestId, 'mesh', progressFraction == null ? 0.10 : progressFraction,
      loaded.source === 'cache' ? 'Сетка загружена из кэша' : 'Сетка построена');
  }
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

/** Геометрия на проводе: без vertexCellId/cellIndexStart (pick живёт в
 *  воркере). Один и тот же срез для финала и прокси-слоя. */
function wireGeometry(geometry: GlobeGeometry): GlobeWireGeometry {
  return {
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
    // Stage-8.8.2 (A-1): прокси-слой совмещённого ответа. Поверхность НЕ
    // пересчитывается — канонические поля проецируются на прокси-сетку теми
    // же вызовами, что и в прежней прокси-ветке.
    const proxyV = normalizeProxyV(message.proxyV, renderV);
    let proxyLayer: CurrentProxyLayer | null = null;
    let proxyGeometry: GlobeGeometry | null = null;
    if (proxyV < renderV) {
      const proxyGridResult = await getGrid(proxyV, token, requestId, 0.845);
      const proxyRenderGrid = proxyGridResult.grid;
      const proxyRenderSurface = projectSurfaceToRender(grid, surface, proxyRenderGrid);
      proxyGeometry = buildGlobeGeometry(proxyRenderGrid, proxyRenderSurface, {
        colorMode: colorMode,
        reliefScale: reliefScale,
      });
      proxyLayer = {
        renderV: proxyV,
        renderGrid: proxyRenderGrid,
        renderSurface: proxyRenderSurface,
        vertexCellId: proxyGeometry.vertexCellId,
        cellCount: proxyGeometry.cellCount,
      };
    }

    let renderGrid = grid;
    let renderSurface = surface;
    if (renderV !== info.canonicalV) {
      // Мобильный прокси-меш (И-1): геометрия грубее, поля — канонические.
      const render = await getGrid(renderV, token, requestId, 0.845);
      renderGrid = render.grid;
      renderSurface = projectSurfaceToRender(grid, surface, renderGrid);
    }
    const geometry = buildGlobeGeometry(renderGrid, renderSurface, {
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

    // planetKey по §8.8: generation_key профиля (frozen) или вычисленный PG1.
    const requestProfile = (message.profile || {}) as Record<string, unknown>;
    let generationKey = String(requestProfile.generationKey || requestProfile.generation_key || '');
    if (!generationKey) {
      try {
        generationKey = computeGenerationKey((message.profile || {}) as PlanetGenerationProfileInput);
      } catch (_) {
        generationKey = '';
      }
    }

    current = {
      token: token,
      profile: info.canonical,
      generationKey: generationKey,
      canonicalV: info.canonicalV,
      renderV: renderV,
      renderGrid: renderGrid,
      grid: grid,
      surface: surface,
      renderSurface: renderSurface,
      vertexCellId: geometry.vertexCellId,
      cellCount: geometry.cellCount,
      proxy: proxyLayer,
      reliefScale: reliefScale,
      colorMode: colorMode,
      lastPatchCache: null,
    };

    const payloadGeometry = wireGeometry(geometry);
    // Каждый ArrayBuffer попадает в transfer list ровно один раз: сначала
    // финал, затем прокси-слой той же генерации (Stage-8.8.2, A-1).
    const transfer: Transferable[] =
      PlanetGlobe.listGeometryTransferables(payloadGeometry as unknown as GlobeGeometry, false) as Transferable[];
    let payloadProxy: GlobeProxyGeometry | null = null;
    if (proxyLayer && proxyGeometry) {
      const wireProxy = wireGeometry(proxyGeometry);
      payloadProxy = {
        renderV: proxyLayer.renderV,
        geometry: wireProxy,
        cellCount: wireProxy.cellCount,
      };
      const proxyBuffers =
        PlanetGlobe.listGeometryTransferables(wireProxy as unknown as GlobeGeometry, false) as Transferable[];
      for (let i = 0; i < proxyBuffers.length; i++) {
        if (transfer.indexOf(proxyBuffers[i] as Transferable) < 0) transfer.push(proxyBuffers[i] as Transferable);
      }
    }
    if (preview && preview.data && preview.data.buffer) {
      const previewBuffer = preview.data.buffer as ArrayBuffer;
      if (transfer.indexOf(previewBuffer as Transferable) < 0) transfer.push(previewBuffer as Transferable);
    }
    const summary = surfaceSummary(info, surface, geometry, {
      mesh: round(meshMs, 1),
      surface: round(surfaceMs, 1),
      geometry: round(geometryMs, 1),
      total: round(performance.now() - started, 1),
    });
    summary.gridSource = gridResult.source;
    // 100% страница покажет только после GPU-подмены; worker завершил CPU-часть.
    progress(token, requestId, 'ready', 0.84, 'CPU-часть готова');
    const readyPayload: Record<string, unknown> = {
      token: token, requestId: requestId,
      geometry: payloadGeometry,
      summary: summary,
      preview: preview,
      colorMode: colorMode,
    };
    // Поле proxy появляется только в совмещённом ответе: без proxyV сообщение
    // побайтово прежнее (критерий E).
    if (payloadProxy) readyPayload.proxy = payloadProxy;
    post('ready', readyPayload, transfer);
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

function pickInfo(direction: number[], requestedCell?: number | string): Record<string, unknown> {
  if (!current) throw new Error('Планета ещё не сгенерирована');
  const grid = current.grid;
  const s = current.surface;
  const started = performance.now();
  let cell = -1;
  if (requestedCell !== undefined && requestedCell !== null && String(requestedCell).trim() !== '') {
    const raw = String(requestedCell).trim();
    if (/^\d+$/.test(raw)) {
      const idx = Number(raw);
      if (Number.isInteger(idx) && idx >= 0 && idx < grid.cellCount) cell = idx;
    } else {
      try {
        const byAddr = GeodesicGrid.cellAtAddress(grid, raw);
        if (Number.isInteger(byAddr) && byAddr >= 0 && byAddr < grid.cellCount) cell = byAddr;
      } catch (_) {
        cell = -1;
      }
    }
  }
  if (cell < 0) {
    const len = Math.hypot(direction[0] as number, direction[1] as number, direction[2] as number) || 1;
    const dir = [(direction[0] as number) / len, (direction[1] as number) / len, (direction[2] as number) / len];
    cell = GeodesicGrid.pick(grid, dir);
  }
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

/** Этап 7: intent-based prefetch — прогрев целевой сетки GridCache, канонической
 *  ячейки фокуса и упреждающая сборка Patch7. Latest-wins: пока задача ждёт
 *  сетку, новый prefetch инкрементирует seq, и результат старой отбрасывается. */
async function runPrefetch(message: PrefetchMessage): Promise<void> {
  const started = performance.now();
  const seq = ++latestPrefetchSeq;
  function safeResponse(targetV: number, focusCell: number, hexCenterCell: number, chunkId: number, patchReady: boolean): void {
    post('prefetch-ready', {
      token: message.token, requestId: message.requestId,
      targetV: targetV, focusCell: focusCell, hexCenterCell: hexCenterCell,
      chunkId: chunkId, neighborChunks: [], patchReady: patchReady,
      timingsMs: {
        gridMs: 0, patchMs: 0,
        totalMs: round(performance.now() - started, 3),
      },
    });
  }
  // Планета ещё не сгенерирована — безопасный ответ без прогрева (И-1).
  if (!current) {
    safeResponse(0, -1, -1, -1, false);
    return;
  }
  const planet = current;
  const targetV = clampRenderV(Number(message.targetV) || planet.renderV, planet.canonicalV);

  // 1. Прогрев целевой прокси-сетки в GridCache (молча, без progress-спама).
  const gridStarted = performance.now();
  try {
    await getGrid(targetV, message.token, message.requestId, undefined, false);
  } catch (_) {
    // Прогрев — упреждающая задача: ошибка сетки не ломает камеру.
  }
  const gridMs = performance.now() - gridStarted;
  if (seq !== latestPrefetchSeq) return; // устаревшая задача

  // 2. Каноническая ячейка фокуса: focusCell ИЛИ pickCell по focusDirection.
  let focusCell = -1;
  const requestedFocus = Number(message.focusCell);
  if (Number.isInteger(requestedFocus) && requestedFocus >= 0 && requestedFocus < planet.grid.cellCount) {
    focusCell = requestedFocus;
  } else if (message.focusDirection &&
    Number.isFinite(Number(message.focusDirection[0])) &&
    Number.isFinite(Number(message.focusDirection[1])) &&
    Number.isFinite(Number(message.focusDirection[2]))) {
    focusCell = pickCell(planet.grid, message.focusDirection);
  }
  const hexCenterCell = focusCell >= 0 ? resolveHexCenterCell(planet.grid, focusCell) : -1;
  if (focusCell < 0 || hexCenterCell < 0) {
    safeResponse(targetV, focusCell, hexCenterCell, -1, false);
    return;
  }

  // 3. Упреждающая сборка и кэширование среза Patch7 вокруг hexCenterCell.
  const patchStarted = performance.now();
  try {
    buildPatchCached(planet, hexCenterCell);
  } catch (_) {
    safeResponse(targetV, focusCell, hexCenterCell, -1, false);
    return;
  }
  const patchMs = performance.now() - patchStarted;
  if (seq !== latestPrefetchSeq) return; // устаревшая задача

  // 4. Чанк прокси-сетки под фокусом и его соседи (getChunkNeighbors).
  const renderGrid = planet.renderGrid;
  const renderCell = pickCell(renderGrid, planet.grid.centers.subarray(
    focusCell * 3, focusCell * 3 + 3,
  ));
  const chunkId = renderGrid.cellChunk ? renderGrid.cellChunk[renderCell] as number : 0;
  const neighborChunks = GeodesicGrid.getChunkNeighbors(renderGrid, chunkId);

  post('prefetch-ready', {
    token: message.token, requestId: message.requestId,
    targetV: targetV, focusCell: focusCell, hexCenterCell: hexCenterCell,
    chunkId: chunkId, neighborChunks: neighborChunks, patchReady: true,
    timingsMs: {
      gridMs: round(gridMs, 3),
      patchMs: round(patchMs, 3),
      totalMs: round(performance.now() - started, 3),
    },
  });
}

/** Этап 7/W23d: экспорт канонического Patch7 (local-map-patch-v2) по И-1/И-3:
 *  сетка и поверхность строго canonicalV, пятиугольник резолвится в соседа,
 *  инварианты проверяются на месте, ключи §8.8 считаются детерминированно. */
function runExtractPatch(message: ExtractPatchMessage): void {
  if (!current) throw new Error('Планета ещё не сгенерирована');
  const planet = current;
  const requestedCell = Number(message.cell);
  if (!Number.isInteger(requestedCell) || requestedCell < 0 || requestedCell >= planet.grid.cellCount) {
    throw new Error('extract-patch: ячейка ' + String(message.cell) + ' вне канонической сетки v=' + planet.canonicalV);
  }
  const hexCenterCell = resolveHexCenterCell(planet.grid, requestedCell);
  if (hexCenterCell < 0) {
    throw new Error('extract-patch: не найден шестиугольный центр для ячейки ' + requestedCell);
  }
  const patch = buildPatchCached(planet, hexCenterCell);
  const invariants = verifyPatchInvariants(patch);
  const spanMeters = patchSpanMeters(patch);
  const spawnMask = buildBuildingSpawnMask(patch, 32);
  let buildable = 0;
  for (let i = 0; i < spawnMask.length; i++) buildable += spawnMask[i] as number;
  const buildableFraction = spawnMask.length ? buildable / spawnMask.length : 0;
  const canonicalAddress = canonicalCellAddress(planet.grid, hexCenterCell);
  const keys = derivePatchKeys(planet, hexCenterCell, canonicalAddress);
  post('patch-ready', {
    token: message.token, requestId: message.requestId,
    requestedCell: requestedCell, hexCenterCell: hexCenterCell,
    canonicalAddress: canonicalAddress, patch: patch, invariants: invariants,
    spanMeters: round(spanMeters, 3),
    buildableFraction: round(buildableFraction, 6),
    keys: keys,
  });
}

/** Stage-8.8.2 (A-1): слой цветов для запрошенной renderV. Без поля — финал
 *  (как раньше). С renderV прокси-сетки — прокси-слой, чтобы число вершин
 *  совпадало с геометрией, которая сейчас на экране. */
function colorLayerFor(planet: CurrentPlanet, requestedV?: number): ColorLayer {
  if (requestedV == null) return planet;
  const v = Math.round(Number(requestedV));
  if (!Number.isFinite(v)) return planet;
  if (planet.proxy && v === planet.proxy.renderV) return planet.proxy;
  return planet;
}

/** Маршрутизация одного входного сообщения: общий контур для реального
 *  workerScope.onmessage и тестируемого PlanetGlobeWorker.createWorkerHandler. */
async function routeMessage(message: WorkerMessage): Promise<void> {
  try {
    if (message.type === 'generate') {
      await ensureGeneration(message);
    } else if (message.type === 'color-mode') {
      if (!current) throw new Error('Планета ещё не сгенерирована');
      const mode = message.mode || 'biome';
      const layer = colorLayerFor(current, message.renderV);
      const colors = buildVertexColors(layer.renderSurface, layer.vertexCellId, mode, layer.cellCount);
      current.colorMode = mode;
      post('colors', {
        token: message.token, requestId: message.requestId, mode: mode, colors: colors,
      }, [colors.buffer as ArrayBuffer]);
    } else if (message.type === 'pick') {
      const info = pickInfo(message.direction || [0, 0, 1], message.cell);
      post('pick-result', {
        token: message.token, requestId: message.requestId,
        purpose: message.purpose || 'select', info: info,
      });
    } else if (message.type === 'prefetch') {
      await runPrefetch(message);
    } else if (message.type === 'extract-patch') {
      runExtractPatch(message);
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
}

/** Тестируемый контур воркера (Этап 7): обрабатывает сообщения без реального
 *  Worker-скоупа и возвращает исходящие ответы каждого вызова по порядку. */
export interface WorkerTestHandler {
  handle(message: WorkerMessage): Promise<WorkerResponse[]>;
  /** Stage-8.8.2 (A-1), критерий C: transfer-списки последнего handle(),
   *  по одному на каждое исходящее сообщение в том же порядке. */
  lastTransfers(): Transferable[][];
}

export const PlanetGlobeWorker = {
  GLOBE_VERSION: PlanetGlobe.GLOBE_VERSION,
  GRID_VERSION: GeodesicGrid.GRID_VERSION,
  SURFACE_VERSION: PlanetSurface.SURFACE_VERSION,
  createWorkerHandler: function (): WorkerTestHandler {
    const outbox: WorkerResponse[] = [];
    let transfers: Transferable[][] = [];
    return {
      handle: async function (message: WorkerMessage): Promise<WorkerResponse[]> {
        outbox.length = 0;
        transfers = [];
        const previousSink = postSink;
        postSink = function (payload, transfer) {
          outbox.push(payload as WorkerResponse);
          transfers.push(transfer ? transfer.slice() : []);
        };
        try {
          await routeMessage(message);
        } finally {
          postSink = previousSink;
        }
        return outbox.slice();
      },
      lastTransfers: function (): Transferable[][] {
        return transfers.map(function (list) { return list.slice(); });
      },
    };
  },
};

// Реальный Worker-скоуп есть только в браузере: в Node-тестах модуль
// импортируется ради PlanetGlobeWorker.createWorkerHandler, и попытка
// подписаться/отправить в отсутствие postMessage не должна падать.
if (typeof workerScope.postMessage === 'function') {
  workerScope.onmessage = function (event: MessageEvent) {
    const message = (event.data || {}) as WorkerMessage;
    void routeMessage(message);
  };
  post('worker-ready', {
    globeVersion: PlanetGlobe.GLOBE_VERSION,
    gridVersion: GeodesicGrid.GRID_VERSION,
    surfaceVersion: PlanetSurface.SURFACE_VERSION,
  });
}
