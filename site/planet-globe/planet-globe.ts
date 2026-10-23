/* Страница боевого глобуса Этапа 6 (/planet-globe/).
   -------------------------------------------------------------------------
   Это первая страница, где настоящая поверхность c100-soft-v2 видна
   целиком: биомы, реки, озёра, континенты и дренажные регионы считаются
   в worker, а WebGL2-глобус только рисует готовую геометрию ячеек.

   Поток загрузки повторяет принятую в спайке идею: сначала быстрый
   прокси той же планеты на меньшей частоте, затем бесшовная замена
   финальной частотой. Нормы «в ячейках» worker масштабирует к render-v,
   поэтому прокси сохраняет физический масштаб континентов и рек.

   CR-01 PR 5 (И-5): строгий TypeScript-порт planet-globe.js
   (Strict ESM + TypeScript). Интерфейс и комментарии — по-русски. */

import PlanetGlobe from '../shared/planet-globe.ts';
import type { CellPolygon, GlobeGeometry, GlobeStats, PlanetGlobeHandle } from '../shared/planet-globe.ts';
import { verifyGenerationKey } from '../shared/planet-generation-contract.ts';
import type { PlanetGenerationProfileInput } from '../shared/planet-generation-contract.ts';
import type { GeographyProfileInput } from '../shared/planet-geography.ts';
import type {
  ColorModeMessage,
  ExtractPatchMessage,
  GenerateMessage,
  GlobePickInfo,
  GlobeSummary,
  PickMessage,
  PrefetchMessage,
  WorkerPatchReadyResponse,
  WorkerPrefetchReadyResponse,
  WorkerReadyResponse,
  WorkerResponse,
} from './planet-globe-worker.ts';
import { buildMeshLibrary } from '../../src/local-map/local-map-mesh.ts';
import {
  generateHorizonSkirt,
  generateLocalMap,
  planetCurvatureDropM,
} from '../../src/local-map/local-map-worker.ts';
import { StructureRenderer } from '../../src/local-map/local-map-renderer.ts';
import type {
  HorizonSkirtData,
  LocalMapWorkerResponse,
} from '../../src/local-map/local-map-worker.ts';
import {
  STRUCTURE_FRAGMENT_SHADER,
  STRUCTURE_VERTEX_SHADER,
  TERRAIN_FRAGMENT_SHADER,
  TERRAIN_VERTEX_SHADER,
} from '../../src/local-map/local-map-shaders.ts';

type Stage8StructureRenderer = StructureRenderer & {
  enqueueWorkerData?: (data: LocalMapWorkerResponse, budgetMs?: number) => void;
  processPendingUpload?: (budgetMs?: number) => boolean;
  isUploading?: () => boolean;
  getUploadProgress?: () => number;
  compilePrograms?: () => { terrainProgram: WebGLProgram; structureProgram: WebGLProgram };
  renderFrame?: (viewProj: Float32Array, opts?: Record<string, unknown>) => void;
  setHorizonSkirt?: (skirt: HorizonSkirtData | null) => void;
  dispose?: () => void;
};

/** Stage-8: состояние плавной анимации локальной камеры (Dive-in / перелёт к соседу). */
interface LocalCameraAnim {
  startAt: number;
  durationMs: number;
  fromYaw: number;
  toYaw: number;
  fromPitch: number;
  toPitch: number;
  fromDist: number;
  toDist: number;
  fromTarget: LocalVec3;
  toTarget: LocalVec3;
  /** Stage-8.2: плавная кривая easeInOutCubic для двухфазного спуска
   *  (по умолчанию — easeOutCubic для перелётов внутри локальной карты). */
  easeInOut?: boolean;
}

/** Палитра атмосферы планетарного горизонта (Stage-8.3): светлая дневная горная дымка. */
const LOCAL_HORIZON_COLOR: readonly [number, number, number] = [0.76, 0.82, 0.88];
const LOCAL_SKIRT_FOG_COLOR: readonly [number, number, number] = [0.66, 0.74, 0.82];
/** Рабочий панорамный наклон камеры локальной карты (Stage-8.3: ~17.8°). */
const LOCAL_REST_PITCH = 0.31;
/**
 * Stage-8.6: азимут покоя локальной камеры строго на настоящий Север (+Y).
 * Вектор взгляда камеры равен `(-cos(yaw), -sin(yaw))` в координатах
 * `(east, north) = (+X, +Y)`, поэтому при `yaw = -π/2` взгляд направлен в `(0, +1)`:
 * глаз стоит на Юге и смотрит на Север. Верх кадра = Север (`С`), право = Восток (`В`),
 * лево = Запад (`З`), низ = Юг (`Ю`) — экран 1-в-1 совпадает с подписями
 * `С / СВ / В / ЮВ / Ю / ЮЗ / З / СЗ` кнопок «СОСЕДИ PATCH7» и с ориентацией глобуса.
 */
const LOCAL_REST_YAW = -Math.PI / 2;
/** Stage-8.2: фаза 1 (подлёт глобуса к гексу) удерживается 320 мс, после чего
 *  сцена проявляется и камера начинает спуск до уровня участка. */
const LOCAL_DIVE_REVEAL_DELAY_MS = 320;
/** Stage-8.2: длительность фазы 2 — плавного спуска до уровня гекса. */
const LOCAL_DIVE_ANIM_MS = 1150;
/**
 * Stage-8.5: фиксированный физический радиус генерируемого центрального участка
 * (диаметр активного гекса ~4.5 км). 10 колец горизонта охватывают R_outer ≈ 28.75 км
 * вокруг центра с плотной сеткой и нормальным размером домиков. Селектор «Видимая
 * ширина» больше не растягивает меш, а управляет только дистанцией/наклоном камеры.
 */
const LOCAL_PATCH_BASE_RADIUS_M = 2500;
/**
 * Stage-8.7: шаг центров соседних гексов `d_hex = 1.15 · R_patch` — та же
 * величина, что у решётки Patch7/юбки. Переход между гексами переносит точку
 * прицела ровно на этот шаг, поэтому мировая точка взгляда не смещается.
 */
export const LOCAL_HEX_STEP_RATIO = 1.15;

interface LocalMapPrograms {
  terrainProgram: WebGLProgram;
  structureProgram: WebGLProgram;
}

function must<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error('Нет обязательного узла страницы: #' + id);
  return node as T;
}

const els = {
  canvas: must<HTMLCanvasElement>('globe'),
  fallback: must<HTMLCanvasElement>('fallbackCanvas'),
  fallbackWrap: must<HTMLElement>('fallbackWrap'),
  preset: must<HTMLSelectElement>('presetSel'),
  presetInfo: must<HTMLElement>('presetInfo'),
  surfaceClass: must<HTMLSelectElement>('surfaceClassSel'),
  planetId: must<HTMLInputElement>('planetId'),
  seed: must<HTMLInputElement>('seedText'),
  randomSeed: must<HTMLButtonElement>('randomSeedBtn'),
  radius: must<HTMLInputElement>('radiusKm'),
  radiusOut: must<HTMLElement>('radiusOut'),
  quality: must<HTMLSelectElement>('qualitySel'),
  qualityOut: must<HTMLElement>('qualityOut'),
  autoProxy: must<HTMLInputElement>('autoProxy'),
  colorMode: must<HTMLSelectElement>('colorModeSel'),
  relief: must<HTMLSelectElement>('reliefSel'),
  generate: must<HTMLButtonElement>('generateBtn'),
  nextPlanet: must<HTMLButtonElement>('nextPlanetBtn'),
  cycle: must<HTMLButtonElement>('cycleBtn'),
  borders: must<HTMLButtonElement>('bordersBtn'),
  spin: must<HTMLButtonElement>('spinBtn'),
  atmosphere: must<HTMLButtonElement>('atmosphereBtn'),
  resetView: must<HTMLButtonElement>('resetViewBtn'),
  clearCache: must<HTMLButtonElement>('clearCacheBtn'),
  panelToggle: must<HTMLButtonElement>('panelToggle'),
  panelBody: must<HTMLElement>('panelBody'),
  status: must<HTMLElement>('statusLine'),
  loading: must<HTMLElement>('loading'),
  loadingTitle: must<HTMLElement>('loadingTitle'),
  loadingLabel: must<HTMLElement>('loadingLabel'),
  loadingBar: must<HTMLElement>('loadingBar'),
  loadingPct: must<HTMLElement>('loadingPct'),
  stats: must<HTMLElement>('statsBox'),
  selection: must<HTMLElement>('pickOut'),
  hover: must<HTMLElement>('hoverLine'),
  fps: must<HTMLElement>('fps'),
  cells: must<HTMLElement>('cells'),
  tris: must<HTMLElement>('tris'),
  lod: must<HTMLElement>('lodHud'),
  renderScale: must<HTMLElement>('renderScale'),
  frameP50: must<HTMLElement>('frameP50'),
  frameP95: must<HTMLElement>('frameP95'),
  frameP99: must<HTMLElement>('frameP99'),
  frameOver50: must<HTMLElement>('frameOver50'),
  frameOver100: must<HTMLElement>('frameOver100'),
  heap: must<HTMLElement>('heap'),
  switchHistory: must<HTMLElement>('switchHistory'),
  diveLocalMap: must<HTMLButtonElement>('diveLocalMapBtn'),
  localMapStage: must<HTMLElement>('localMapStage'),
  localMapCanvas: must<HTMLCanvasElement>('localMapCanvas'),
  exitLocalMap: must<HTMLButtonElement>('exitLocalMapBtn'),
  localMapTitle: must<HTMLElement>('localMapTitle'),
  localScale: must<HTMLSelectElement>('localScaleSel'),
  resetLocalCam: must<HTMLButtonElement>('resetLocalCamBtn'),
  localNeighborNav: must<HTMLElement>('localNeighborNav'),
  placeSelect: must<HTMLSelectElement>('catalogPlaceSel'),
  breadcrumbSystem: must<HTMLAnchorElement>('breadcrumbSystem'),
  breadcrumbPlanet: must<HTMLElement>('breadcrumbPlanet'),
  breadcrumbPatchWrap: must<HTMLElement>('breadcrumbPatchWrap'),
  breadcrumbPatchSep: must<HTMLElement>('breadcrumbPatchSep'),
  breadcrumbPatch: must<HTMLElement>('breadcrumbPatch'),
  backToSector: must<HTMLAnchorElement>('backToSectorBtn'),
  localGenMs: must<HTMLElement>('localGenMs'),
  localUploadProgress: must<HTMLProgressElement>('localUploadProgress'),
  localUploadLabel: must<HTMLElement>('localUploadLabel'),
  localInstanceCount: must<HTMLElement>('localInstanceCount'),
  localBuildableFraction: must<HTMLElement>('localBuildableFraction'),
  localFogStatus: must<HTMLElement>('localFogStatus'),
  localInvariantStatus: must<HTMLElement>('localInvariantStatus'),
  localMapStatus: must<HTMLElement>('localMapStatus'),
};

const PREFERRED_SURFACE_CLASS: Record<string, string> = {
  earthlike_balanced: 'terrestrial',
  earthlike_archipelago: 'terrestrial',
  ocean_world: 'ocean',
  desert_dry: 'desert',
  ice_world: 'ice',
  volcanic_active: 'volcanic',
  barren_moon: 'barren',
};
const HARD_CLASS_RU: Record<string, string> = { land: 'суша', shelf: 'шельф', ocean: 'океан' };
const TERMINAL_RU: Record<string, string> = {
  ocean: 'океан', terminal_lake: 'конечное озеро', endorheic: 'бессточная область',
};

type CsvRow = Record<string, string>;

interface ActiveRequest {
  id: number;
  profile: GeographyProfileInput;
  profileKey: string;
  renderV: number;
  targetV: number;
  phase: string;
  startedAt: number;
}

interface HistoryEntry {
  planet: string;
  preset: string;
  v: number;
  total: number;
  at: Date;
}

let presets: CsvRow[] = [];
let presetsById = new Map<string, CsvRow>();
let worker: Worker | null = null;
let workerSeq = 0;
let workerToken = '';
let displayedToken = '';
let requestSeq = 0;
let activeRequest: ActiveRequest | null = null;
let pendingGpuReady: { msg: WorkerReadyResponse; request: ActiveRequest | null } | null = null;
let displayedSummary: GlobeSummary | null = null;
let latestPickRequest = 0;
let latestHoverRequest = 0;
let latestPrefetchRequest = 0;
let latestPatchRequest = 0;
let lastHoverSentAt = 0;
let upgradeTimer = 0;
let cycleTimer = 0;
let cycleActive = false;
let completedPlanets = 0;
let generationHistory: HistoryEntry[] = [];
const initialUrlParams = new URLSearchParams(window.location.search);
const initialCellRaw = (initialUrlParams.get('cell') || '').trim();
let placesCatalog: CsvRow[] = [];
let systemsCatalog: CsvRow[] = [];
let generationByPlaceId = new Map<string, CsvRow>();
let selectedPlace: CsvRow | null = null;
let pendingInitialCell: string | null = initialCellRaw || null;
let selectedCellAddress: string | null = pendingInitialCell;
let pendingInitialLocalView: boolean = Boolean(pendingInitialCell && initialUrlParams.get('view') === 'local');
let globe: PlanetGlobeHandle | null = null;
let webglAvailable = true;
let lastPatchReady: WorkerPatchReadyResponse | null = null;
let activePatchReady: WorkerPatchReadyResponse | null = null;
let localMapGl: WebGL2RenderingContext | null = null;
let localMapRenderer: Stage8StructureRenderer | null = null;
let localMapPrograms: LocalMapPrograms | null = null;
let localMapProgramsOwnedByRenderer = false;
let localMapActive = false;
let localMapFrameId = 0;
let localMapEntrySeq = 0;
let localMapHideTimer = 0;
/** Stage-8.2: таймер отложенного проявления сцены (фаза 2 двухфазного спуска). */
let localRevealTimer = 0;
let localMapData: LocalMapWorkerResponse | null = null;
let localMapGenerationMs = 0;
let localMapBuildableFraction = 0;
let localMapInstanceCount = 0;
let localMapWidthKm = 1.2;
/** Stage-8.5: физический радиус центрального участка — стабильный, не зависит от селектора «Видимая ширина». */
let localMapRadiusM = LOCAL_PATCH_BASE_RADIUS_M;
let localMapHudLastAt = 0;
let localMapCanvasEventsInstalled = false;
let localCameraYaw = LOCAL_REST_YAW;
let localCameraPitch = 0.82;
let localCameraDistance = 0;
let localCameraTarget: [number, number, number] = [0, 0, 20];
let localCameraAnim: LocalCameraAnim | null = null;
let localSkirtData: HorizonSkirtData | null = null;
/**
 * Ожидаемый перелёт к соседу: азимут действителен только для своей ячейки.
 * Stage-8.4: дополнительно сохраняет смещение точки прицела и состояние
 * камеры до перехода (prevTargetOffset / prevYaw / prevPitch / prevDist),
 * чтобы после смены патча перелёт стартовал без рывка и без принудительного
 * возврата взгляда к LOCAL_REST_YAW.
 */
let pendingNeighborFly: {
  cell: number;
  azimuth: number;
  prevTargetOffset?: [number, number, number];
  prevYaw?: number;
  prevPitch?: number;
  prevDist?: number;
} | null = null;
/** Пока запрошен новый Patch7, не запускаем второй переход по грани. */
let localPatchLoading = false;
let localClickCandidate: { pointerId: number; x: number; y: number } | null = null;
let localPointerMode: 'orbit' | 'pan' | null = null;
let localPointerId: number | null = null;
let localPointerLast = { x: 0, y: 0 };
let localPointers = new Map<number, { x: number; y: number }>();
let localPinchDistance = 0;

function setStatus(text: string, kind: string): void {
  els.status.textContent = text || '';
  if (els.status.dataset) els.status.dataset.kind = kind || '';
}

function fmtInt(x: unknown): string {
  return Math.round(Number(x) || 0).toLocaleString('ru-RU');
}

function fmtNum(x: unknown, digits?: number): string {
  return (Number(x) || 0).toLocaleString('ru-RU', {
    minimumFractionDigits: digits == null ? 2 : digits,
    maximumFractionDigits: digits == null ? 2 : digits,
  });
}

function fmtPct(x: unknown, digits?: number): string {
  return fmtNum((Number(x) || 0) * 100, digits == null ? 1 : digits) + '%';
}

function fmtMs(x: unknown): string {
  const n = Number(x) || 0;
  return fmtNum(n, n >= 100 ? 0 : 1) + ' мс';
}

function fmtBytes(bytes: unknown): string {
  const b = Number(bytes) || 0;
  if (b >= 1048576) return fmtNum(b / 1048576, 1) + ' МиБ';
  if (b >= 1024) return fmtNum(b / 1024, 0) + ' КиБ';
  return fmtInt(b) + ' Б';
}

function escapeHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c: string) => {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    };
    return map[c] as string;
  });
}

const LOCAL_MAP_SCALE_STEPS = [1.2, 2.5, 5, 10, 20, 39, 78, 156, 312, 625, 1250] as const;
const LOCAL_MAP_FOV = 50 * Math.PI / 180;
type LocalVec3 = [number, number, number];
type LocalPatchCell = WorkerPatchReadyResponse['patch']['cells'][number];

function parseSeedUint32(value: string): number {
  const seed = value.trim();
  if (/^[0-9a-fA-F]{16}$/.test(seed)) return Number.parseInt(seed.slice(-8), 16) >>> 0;
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(seed || 'timeline-project')) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function clampLocal(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLocalVec3(value: LocalVec3): LocalVec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 0) || !Number.isFinite(length)) return [0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length];
}

function crossLocalVec3(a: LocalVec3, b: LocalVec3): LocalVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dotLocalVec3(a: LocalVec3, b: LocalVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function perspectiveLocal(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function lookAtLocal(eye: LocalVec3, center: LocalVec3, up: LocalVec3): Float32Array {
  const zAxis = normalizeLocalVec3([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const xAxis = normalizeLocalVec3(crossLocalVec3(up, zAxis));
  const yAxis = crossLocalVec3(zAxis, xAxis);
  return new Float32Array([
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dotLocalVec3(xAxis, eye), -dotLocalVec3(yAxis, eye), -dotLocalVec3(zAxis, eye), 1,
  ]);
}

function multiplyLocalMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[column * 4 + k] as number);
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function createLocalShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL2 не создал шейдер локальной карты.');
  gl.shaderSource(shader, source.trimStart());
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'неизвестная ошибка компиляции';
    gl.deleteShader(shader);
    throw new Error('Ошибка шейдера локальной карты: ' + log);
  }
  return shader;
}

function createLocalProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = createLocalShader(gl, gl.VERTEX_SHADER, vertexSource);
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    fragment = createLocalShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new Error('WebGL2 не создал программу локальной карты.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error('Ошибка связывания программы локальной карты: ' + (gl.getProgramInfoLog(program) || 'неизвестная ошибка'));
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function compileLocalMapPrograms(gl: WebGL2RenderingContext): LocalMapPrograms {
  const terrainProgram = createLocalProgram(gl, TERRAIN_VERTEX_SHADER, TERRAIN_FRAGMENT_SHADER);
  try {
    return {
      terrainProgram,
      structureProgram: createLocalProgram(gl, STRUCTURE_VERTEX_SHADER, STRUCTURE_FRAGMENT_SHADER),
    };
  } catch (error) {
    gl.deleteProgram(terrainProgram);
    throw error;
  }
}

function setLocalMapStatus(text: string, kind: string): void {
  els.localMapStatus.textContent = text;
  els.localMapStatus.dataset.kind = kind;
  if (kind === 'error' || !localMapActive) {
    setStatus(text, kind);
  }
}

function initializeLocalMapRenderer(): boolean {
  let gl = localMapGl;
  if (!gl || gl.isContextLost()) {
    gl = els.localMapCanvas.getContext('webgl2', {
      // Stage-8.2: непрозрачный канвас — за горизонтом не просвечивает глобус.
      alpha: false,
      premultipliedAlpha: false,
      antialias: true,
      depth: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      setLocalMapStatus('WebGL2 недоступен: локальную 3D-карту открыть нельзя.', 'error');
      return false;
    }
    localMapGl = gl;
  }
  if (localMapRenderer && localMapPrograms && !gl.isContextLost()) return true;

  const renderer = new StructureRenderer(gl) as Stage8StructureRenderer;
  try {
    renderer.initMeshLibrary(buildMeshLibrary());
    if (typeof renderer.compilePrograms === 'function') {
      try {
        localMapPrograms = renderer.compilePrograms();
        localMapProgramsOwnedByRenderer = true;
      } catch (error) {
        console.warn('StructureRenderer.compilePrograms не сработал, использую совместимые шейдеры:', error);
        localMapPrograms = compileLocalMapPrograms(gl);
        localMapProgramsOwnedByRenderer = false;
      }
    } else {
      localMapPrograms = compileLocalMapPrograms(gl);
      localMapProgramsOwnedByRenderer = false;
    }
    localMapRenderer = renderer;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    installLocalMapCanvasEvents();
    return true;
  } catch (error) {
    renderer.dispose?.();
    localMapRenderer = null;
    localMapPrograms = null;
    localMapProgramsOwnedByRenderer = false;
    setLocalMapStatus((error as Error).message || 'Не удалось подготовить рендер локальной карты.', 'error');
    return false;
  }
}

function resizeLocalMapCanvas(): void {
  const gl = localMapGl;
  if (!gl) return;
  const rect = els.localMapCanvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.6);
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (els.localMapCanvas.width !== width || els.localMapCanvas.height !== height) {
    els.localMapCanvas.width = width;
    els.localMapCanvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

/**
 * Stage-8.5.2: равномерная логарифмическая шкала селектора «Видимая ширина»
 * по 11 ступеням (1.2 … 1250 км) — шаги 0.0 … 1.0 без мёртвых зон выше 70 км.
 */
function scaleStep01(widthKm: number): number {
  const safeKm = Math.max(1.2, Number(widthKm) || 1.2);
  return clampLocal(Math.log2(safeKm / 1.2) / Math.log2(1250 / 1.2), 0, 1);
}

/**
 * Stage-8.5.2: дистанция камеры по выбранной видимой ширине `widthKm` без
 * мёртвого потолка на 55 км — каждая из 11 ступеней селектора ощутимо
 * меняет высоту камеры (≈×1.47 за шаг), а максимальная дистанция остаётся
 * ниже localMaxCameraDistance().
 */
function cameraDistanceForWidthKm(widthKm: number): number {
  const rect = els.localMapCanvas.getBoundingClientRect();
  const aspect = rect.height > 0 ? rect.width / rect.height : 1;
  const fit = Math.max(0.45, Math.min(1, aspect || 1));
  const u = scaleStep01(widthKm);
  const baseUnit = (localMapRadiusM * 0.44) / (Math.tan(LOCAL_MAP_FOV / 2) * fit);
  const minCloseDist = Math.max(localMinCameraDistance(), baseUnit * 0.24); // ~566 м при 1,2 км (внутри долины у построек)
  const maxOverviewDist = baseUnit * 11.2; // ~26,4 км при 1250 км (весь 10-кольцевой диск в кадре, ниже localMaxCameraDistance = 35 км)
  return minCloseDist * Math.pow(maxOverviewDist / minCloseDist, u);
}

/**
 * Stage-8.5.2: целевой наклон камеры по видимой ширине без потолка на 39 км.
 * От LOCAL_REST_PITCH у долины (1.2 км) до 0.76 рада на обзоре 1250 км.
 */
function cameraPitchForWidthKm(widthKm: number): number {
  const u = scaleStep01(widthKm);
  return LOCAL_REST_PITCH + (0.76 - LOCAL_REST_PITCH) * Math.pow(u, 0.85);
}

/**
 * Stage-8.5.2: каноническая точка прицела локальной камеры — чуть впереди по
 * текущему yaw от центра heightfield и чуть выше уровня долины. Смещение
 * вперёд сужается с ростом ширины, чтобы при удалении камеры прицеливать
 * центр кадра в саму долину, а не за её край.
 */
function defaultLocalCameraTarget(yaw: number, widthKm = localMapWidthKm): LocalVec3 {
  const hf = localMapData?.heightfield;
  const res = Math.round(Math.sqrt(hf?.length || 0));
  const rawCenterZ = hf && res > 0 ? Number(hf[(res >> 1) * res + (res >> 1)] || 0) : 0;
  const centerZ = Number.isFinite(rawCenterZ) ? rawCenterZ : 0;
  const u = scaleStep01(widthKm);
  const forwardOffset = localMapRadiusM * 0.14 * (1 - 0.65 * u);
  return [
    -Math.cos(yaw) * forwardOffset,
    -Math.sin(yaw) * forwardOffset,
    centerZ + Math.max(14, localMapRadiusM * 0.025),
  ];
}

/**
 * Stage-8.7: ре-бейзинг камеры при подмене патча.
 *
 * Локальная система координат каждого участка привязана к центру своего гекса,
 * поэтому при переходе на соседа меняется начало координат: центр нового гекса
 * лежит в старой системе на расстоянии `d_hex = 1.15 · R_patch` вдоль азимута
 * перехода `azimuth = atan2(east, north)`. Функция переносит состояние камеры в
 * новую систему так, чтобы МИРОВАЯ точка прицела и ракурс остались неизменными:
 * к `target` прибавляется вектор `-d_hex · (sin azimuth, cos azimuth)` (старый
 * центр в координатах нового гекса), а `yaw`/`pitch`/`distance` не меняются —
 * пользовательский ракурс сохраняется непрерывно.
 *
 * Функция чистая (без обращения к состоянию модуля), чтобы её можно было
 * проверить тестом и переиспользовать в обе стороны перехода.
 */
export function rebaseLocalCameraState(
  prev: { target: LocalVec3; yaw: number; pitch: number; distance: number },
  azimuth: number,
  patchRadiusM: number,
): { target: LocalVec3; yaw: number; pitch: number; distance: number } {
  const stepM = LOCAL_HEX_STEP_RATIO * Math.max(0, patchRadiusM);
  return {
    target: [
      prev.target[0] - Math.sin(azimuth) * stepM,
      prev.target[1] - Math.cos(azimuth) * stepM,
      prev.target[2],
    ],
    yaw: prev.yaw,
    pitch: prev.pitch,
    distance: prev.distance,
  };
}

function resetLocalCamera(): void {
  localCameraYaw = LOCAL_REST_YAW;
  // Stage-8.5: наклон зависит от выбранной видимой ширины — плавно переходит
  // от панорамного вида вдоль долины к высотному тактическому обзору.
  localCameraPitch = cameraPitchForWidthKm(localMapWidthKm);
  // Точка прицела — каноническая точка долины; при уменьшении ширины камера
  // возвращается в неё точно, без остаточного смещения.
  localCameraTarget = defaultLocalCameraTarget(localCameraYaw, localMapWidthKm);
  // Stage-8.5: дистанция вычисляется через cameraDistanceForWidthKm() по
  // выбранной видимой ширине localMapWidthKm (физический R гекса фиксирован).
  localCameraDistance = cameraDistanceForWidthKm(localMapWidthKm);
}

function lerpLocal(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Stage-8.2: симметричная плавная кривая спуска (мягкий вход и выход). */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Прерывает плавную анимацию камеры (любое ручное действие пользователя). */
function cancelLocalCameraAnim(): void {
  localCameraAnim = null;
}

/**
 * Stage-8.3, фаза 2 двухфазного спуска: камера стартует с высокой орбитальной
 * точки (fromDist = 5.2x, крутой взгляд сверху вниз ~75°) и за 1150 мс по кривой
 * easeInOutCubic мягко опускается и выравнивается до панорамного уровня долины
 * (LOCAL_REST_PITCH ≈ 17.8°), оставляя в верхней трети кадра горы и облачный купол.
 */
function startLocalDiveInAnim(): void {
  const targetDist = localCameraDistance > 0 ? localCameraDistance : localMapRadiusM;
  const target: LocalVec3 = [
    localCameraTarget[0], localCameraTarget[1], localCameraTarget[2],
  ];
  localCameraAnim = {
    startAt: performance.now(),
    durationMs: LOCAL_DIVE_ANIM_MS,
    fromYaw: LOCAL_REST_YAW - 0.24,
    toYaw: LOCAL_REST_YAW,
    fromPitch: 1.32,
    toPitch: cameraPitchForWidthKm(localMapWidthKm),
    fromDist: targetDist * 5.2,
    toDist: targetDist,
    fromTarget: [0, 0, target[2] + localMapRadiusM * 0.25],
    toTarget: target,
    easeInOut: true,
  };
}

/**
 * Перелёт к соседнему гексу (Stage-8.4): 820 мс по плавной кривой
 * easeInOutCubic. Новая цель toTarget считается как в resetLocalCamera —
 * высота центра heightfield нового патча плюс сдвиг вперёд
 * `localMapRadiusM * 0.14` вдоль текущего localCameraYaw; fromTarget
 * стартует со стороны предыдущего гекса — Stage-8.6: ровно на шаг центров
 * соседних гексов `d_hex = 1.15 · R_patch` против азимута перехода, поэтому
 * камера въезжает в новый гекс тем же шагом, что и сетка Patch7.
 * Пользовательский yaw сохраняется (fromYaw = toYaw = localCameraYaw):
 * камера не принуждается крутиться обратно к LOCAL_REST_YAW.
 */
function startLocalNeighborFlyAnim(azimuth: number): void {
  const targetZ = localCameraTarget[2];
  // Целевая точка прицела — каноническая точка долины вдоль текущего yaw,
  // та же формула, что и в resetLocalCamera/defaultLocalCameraTarget.
  const toTarget = defaultLocalCameraTarget(localCameraYaw, localMapWidthKm);
  // Азимут перехода считаем как atan2(east, north); предыдущий гекс лежит
  // строго против направления перехода относительно нового центра.
  // Stage-8.6: смещение равно шагу центров соседних гексов d_hex = 1.15 · R_patch.
  const offset = localMapRadiusM * 1.15;
  const fromTarget: LocalVec3 = [
    -Math.sin(azimuth) * offset,
    -Math.cos(azimuth) * offset,
    targetZ,
  ];
  localCameraAnim = {
    startAt: performance.now(),
    durationMs: 820,
    fromYaw: localCameraYaw,
    toYaw: localCameraYaw,
    fromPitch: localCameraPitch,
    toPitch: cameraPitchForWidthKm(localMapWidthKm),
    fromDist: localCameraDistance,
    toDist: localCameraDistance,
    fromTarget,
    toTarget,
    easeInOut: true,
  };
}

/** Применяет очередной кадр анимации; по завершении снимает состояние. */
function applyLocalCameraAnim(now: number): void {
  const anim = localCameraAnim;
  if (!anim) return;
  const t = clampLocal((now - anim.startAt) / anim.durationMs, 0, 1);
  const e = anim.easeInOut ? easeInOutCubic(t) : easeOutCubic(t);
  localCameraYaw = lerpLocal(anim.fromYaw, anim.toYaw, e);
  localCameraPitch = lerpLocal(anim.fromPitch, anim.toPitch, e);
  localCameraDistance = lerpLocal(anim.fromDist, anim.toDist, e);
  localCameraTarget = [
    lerpLocal(anim.fromTarget[0], anim.toTarget[0], e),
    lerpLocal(anim.fromTarget[1], anim.toTarget[1], e),
    lerpLocal(anim.fromTarget[2], anim.toTarget[2], e),
  ];
  if (t >= 1) localCameraAnim = null;
}

function localCameraEye(): LocalVec3 {
  const cosPitch = Math.cos(localCameraPitch);
  const direction: LocalVec3 = [
    cosPitch * Math.cos(localCameraYaw),
    cosPitch * Math.sin(localCameraYaw),
    Math.sin(localCameraPitch),
  ];
  return [
    localCameraTarget[0] + direction[0] * localCameraDistance,
    localCameraTarget[1] + direction[1] * localCameraDistance,
    localCameraTarget[2] + direction[2] * localCameraDistance,
  ];
}

function localViewProjection(): Float32Array {
  if (!(localCameraDistance > 0)) resetLocalCamera();
  const aspect = Math.max(0.1, els.localMapCanvas.width / Math.max(1, els.localMapCanvas.height));
  const eye = localCameraEye();
  const view = lookAtLocal(eye, localCameraTarget, [0, 0, 1]);
  const near = Math.max(0.1, localMapRadiusM * 0.0001);
  // Stage-8: дальняя плоскость обязана вмещать все 6 колец до горизонта
  // (до 400+ км), иначе юбка отсекается far-плоскостью.
  const skirtOuter = localSkirtData ? localSkirtData.outerRadiusM : 0;
  const far = Math.max(
    100000,
    skirtOuter * 3.2 + localCameraDistance * 4,
    localCameraDistance * 6 + localMapRadiusM * 8,
  );
  return multiplyLocalMat4(perspectiveLocal(LOCAL_MAP_FOV, aspect, near, far), view);
}

/** Ближайший по азимуту сосед в касательном кадре активного Patch7. */
function nearestLocalNeighbor(azimuth: number): LocalPatchCell | null {
  const patch = activePatchReady?.patch;
  if (!patch) return null;
  const { east, north } = patch.frame;
  let nearest: LocalPatchCell | null = null;
  let nearestDelta = Infinity;
  for (const neighbor of patch.cells.slice(1)) {
    const dir = neighbor.center;
    const u = dir[0] * east[0] + dir[1] * east[1] + dir[2] * east[2];
    const v = dir[0] * north[0] + dir[1] * north[1] + dir[2] * north[2];
    const neighborAzimuth = Math.atan2(u, v);
    const delta = Math.abs(Math.atan2(
      Math.sin(azimuth - neighborAzimuth),
      Math.cos(azimuth - neighborAzimuth),
    ));
    if (delta < nearestDelta) {
      nearestDelta = delta;
      nearest = neighbor;
    }
  }
  return nearest;
}

/**
 * Запускает единый latest-wins переход на соседний канонический гекс.
 * Stage-8.5.1: блокировки `localPatchLoading` больше нет — повторный клик по
 * другой кнопке «СОСЕДИ PATCH7» или по другому гексу 3D-сцены не зависает:
 * каждый новый запрос увеличивает `latestPatchRequest`, ответы устаревших
 * переходов отбрасываются в обработчике (`msg.requestId !== latestPatchRequest`).
 */
function requestLocalNeighbor(neighbor: LocalPatchCell, azimuth: number): void {
  if (!localMapActive || !activePatchReady || !worker || !displayedToken) return;
  // Stage-8.4: точка прицела НЕ сбрасывается мгновенно — прежний обнуляющий
  // рывок localCameraTarget[0..1] ломал кадр ещё до прихода нового патча.
  // Текущее состояние камеры сохраняется в pendingNeighborFly и разыгрывается
  // плавным перелётом startLocalNeighborFlyAnim уже на новом патче.
  pendingNeighborFly = {
    cell: neighbor.cell,
    azimuth,
    prevTargetOffset: [localCameraTarget[0], localCameraTarget[1], localCameraTarget[2]],
    prevYaw: localCameraYaw,
    prevPitch: localCameraPitch,
    prevDist: localCameraDistance,
  };
  localPatchLoading = true;
  cancelLocalCameraAnim();
  setLocalMapStatus('Перехожу на соседний гекс #' + String(neighbor.cell) + '…', 'info');
  requestCellPick(neighbor.cell);
}

/** Строит луч через экранную точку и выбирает соседний гекс на плоскости участка. */
function pickLocalNeighborAt(clientX: number, clientY: number): void {
  if (!localMapActive || localPatchLoading || !activePatchReady || !(localCameraDistance > 0)) return;
  const rect = els.localMapCanvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  const aspect = rect.width / rect.height;
  const cosPitch = Math.cos(localCameraPitch);
  const viewDirection: LocalVec3 = [
    cosPitch * Math.cos(localCameraYaw),
    cosPitch * Math.sin(localCameraYaw),
    Math.sin(localCameraPitch),
  ];
  const right: LocalVec3 = [-Math.sin(localCameraYaw), Math.cos(localCameraYaw), 0];
  const screenUp: LocalVec3 = [
    -Math.sin(localCameraPitch) * Math.cos(localCameraYaw),
    -Math.sin(localCameraPitch) * Math.sin(localCameraYaw),
    Math.cos(localCameraPitch),
  ];
  const tanHalfFov = Math.tan(LOCAL_MAP_FOV / 2);
  const ray = normalizeLocalVec3([
    -viewDirection[0] + right[0] * ndcX * tanHalfFov * aspect + screenUp[0] * ndcY * tanHalfFov,
    -viewDirection[1] + right[1] * ndcX * tanHalfFov * aspect + screenUp[1] * ndcY * tanHalfFov,
    -viewDirection[2] + right[2] * ndcX * tanHalfFov * aspect + screenUp[2] * ndcY * tanHalfFov,
  ]);
  if (Math.abs(ray[2]) < 1e-8) return;
  const eye = localCameraEye();
  const rayDistance = (localCameraTarget[2] - eye[2]) / ray[2];
  if (!(rayDistance > 0) || !Number.isFinite(rayDistance)) return;
  const wx = eye[0] + ray[0] * rayDistance;
  const wy = eye[1] + ray[1] * rayDistance;
  const distance = Math.hypot(wx, wy);
  // Stage-8.4: внешний радиус клика расширен до 4.2·R — под 3–4 видимых
  // круга гексов вокруг активного при расширенной 10-кольцевой прогрузке.
  if (!(distance > localMapRadiusM * 0.84 && distance < localMapRadiusM * 4.2)) return;
  const azimuth = Math.atan2(wx, wy);
  const neighbor = nearestLocalNeighbor(azimuth);
  if (neighbor) requestLocalNeighbor(neighbor, azimuth);
}

function applyLocalPan(dx: number, dy: number): void {
  const rect = els.localMapCanvas.getBoundingClientRect();
  const worldPerPixel = (2 * localCameraDistance * Math.tan(LOCAL_MAP_FOV / 2)) / Math.max(1, rect.height);
  const right: LocalVec3 = [-Math.sin(localCameraYaw), Math.cos(localCameraYaw), 0];
  const screenUp: LocalVec3 = [
    -Math.sin(localCameraPitch) * Math.cos(localCameraYaw),
    -Math.sin(localCameraPitch) * Math.sin(localCameraYaw),
    Math.cos(localCameraPitch),
  ];
  localCameraTarget[0] += (-dx * right[0] + dy * screenUp[0]) * worldPerPixel;
  localCameraTarget[1] += (-dx * right[1] + dy * screenUp[1]) * worldPerPixel;
  localCameraTarget[2] += (-dx * right[2] + dy * screenUp[2]) * worldPerPixel;
  // Stage-8.4: свободное панорамирование расширено до 2.4·R без сброса,
  // а порог автоперехода на соседний гекс сдвинут к 1.15·R — пользователь
  // плавно движется по всей долине и за её кромку к следующим кругам гексов.
  const maxPan = localMapRadiusM * 2.4;
  const panLength = Math.hypot(localCameraTarget[0], localCameraTarget[1]);
  if (panLength > maxPan) {
    localCameraTarget[0] *= maxPan / panLength;
    localCameraTarget[1] *= maxPan / panLength;
  }
  localCameraTarget[2] = clampLocal(localCameraTarget[2], -localMapRadiusM * 0.25, localMapRadiusM * 0.5);
  if (panLength > localMapRadiusM * 1.15 && !localPatchLoading) {
    const azimuth = Math.atan2(localCameraTarget[0], localCameraTarget[1]);
    const neighbor = nearestLocalNeighbor(azimuth);
    if (neighbor) requestLocalNeighbor(neighbor, azimuth);
  }
}

/** Stage-8.2: нижний предел зума локальной камеры — до самого уровня земли и
 *  построек (0.045 * R_patch, но не ближе 2 м). */
function localMinCameraDistance(): number {
  return Math.max(2, localMapRadiusM * 0.045);
}

/** Stage-8.2: верхний предел зума — отдаление выше сферического горизонта.
 *  Stage-8.5: поднят до 14·R, чтобы вместить все ступени обзора 10 колец
 *  (максимальная дистанция cameraDistanceForWidthKm(1250 км) ≈ 13.75·R). */
function localMaxCameraDistance(): number {
  return localMapRadiusM * 14;
}

function currentLocalPinchDistance(): number {
  const points = [...localPointers.values()];
  if (points.length < 2) return 0;
  const a = points[0] as { x: number; y: number };
  const b = points[1] as { x: number; y: number };
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function installLocalMapCanvasEvents(): void {
  if (localMapCanvasEventsInstalled) return;
  localMapCanvasEventsInstalled = true;
  const canvas = els.localMapCanvas;
  canvas.addEventListener('contextmenu', (event: MouseEvent) => { event.preventDefault(); });
  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    event.preventDefault();
    localClickCandidate = null;
    cancelLocalCameraAnim();   // ручное управление прерывает перелёт камеры
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* захват может быть недоступен */ }
    localPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (localPointers.size >= 2) {
      localPointerId = null;
      localPointerMode = null;
      localPinchDistance = currentLocalPinchDistance();
      return;
    }
    localPointerId = event.pointerId;
    localPointerLast = { x: event.clientX, y: event.clientY };
    localPointerMode = event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
    if (event.button === 0 && !event.shiftKey) {
      localClickCandidate = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
  });
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    const previous = localPointers.get(event.pointerId);
    if (!previous) return;
    if (localClickCandidate?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - localClickCandidate.x, event.clientY - localClickCandidate.y) >= 6) {
      localClickCandidate = null;
    }
    localPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (localPointers.size >= 2) {
      const distance = currentLocalPinchDistance();
      if (localPinchDistance > 0 && distance > 0) {
        localCameraDistance = clampLocal(localCameraDistance * localPinchDistance / distance,
          localMinCameraDistance(), localMaxCameraDistance());
      }
      localPinchDistance = distance;
      return;
    }
    if (event.pointerId !== localPointerId || !localPointerMode) return;
    const dx = event.clientX - localPointerLast.x;
    const dy = event.clientY - localPointerLast.y;
    localPointerLast = { x: event.clientX, y: event.clientY };
    if (localPointerMode === 'orbit') {
      localCameraYaw -= dx * 0.006;
      // Stage-8.3: нижний предел наклона 0.06 рад (~3.4°) позволяет поднять взгляд
      // ещё выше — на горные пики и облака над долиной.
      localCameraPitch = clampLocal(localCameraPitch + dy * 0.005, 0.06, 1.48);
    } else {
      applyLocalPan(dx, dy);
    }
  });
  const endPointer = (event: PointerEvent): void => {
    const isShortLeftClick = event.type === 'pointerup' &&
      localClickCandidate?.pointerId === event.pointerId &&
      Math.hypot(event.clientX - localClickCandidate.x, event.clientY - localClickCandidate.y) < 6;
    localClickCandidate = null;
    localPointers.delete(event.pointerId);
    try { if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); } catch (_) { /* уже освобождён */ }
    if (localPointers.size < 2) localPinchDistance = 0;
    if (event.pointerId === localPointerId || localPointers.size === 1) {
      const remaining = localPointers.entries().next();
      if (!remaining.done) {
        const [id, point] = remaining.value;
        localPointerId = id;
        localPointerLast = { x: point.x, y: point.y };
        localPointerMode = 'orbit';
      } else {
        localPointerId = null;
        localPointerMode = null;
      }
    }
    if (isShortLeftClick) pickLocalNeighborAt(event.clientX, event.clientY);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (event: WheelEvent) => {
    event.preventDefault();
    const maxClusterDist = localMaxCameraDistance();
    // Дальнейшее отдаление колесом на верхнем пределе — возврат на глобус.
    if (event.deltaY > 0 && localCameraDistance >= maxClusterDist * 0.95) {
      exitLocalMap();
      return;
    }
    cancelLocalCameraAnim();   // зум колесом прерывает перелёт камеры
    localCameraDistance = clampLocal(localCameraDistance * Math.exp(event.deltaY * 0.001),
      localMinCameraDistance(), maxClusterDist);
  }, { passive: false });
  canvas.addEventListener('webglcontextlost', (event: Event) => {
    event.preventDefault();
    if (localMapFrameId) window.cancelAnimationFrame(localMapFrameId);
    localMapFrameId = 0;
    setLocalMapStatus('WebGL-контекст локальной карты потерян; ожидаю восстановления…', 'warn');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    localMapRenderer = null;
    localMapPrograms = null;
    localMapProgramsOwnedByRenderer = false;
    localMapGl = canvas.getContext('webgl2');
    if (localMapActive && lastPatchReady) enterLocalMap(lastPatchReady, localMapWidthKm);
  });
}

function setUniform3(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: LocalVec3): void {
  const location = gl.getUniformLocation(program, name);
  if (location !== null) gl.uniform3f(location, value[0], value[1], value[2]);
}

function setUniform1f(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, value: number): void {
  const location = gl.getUniformLocation(program, name);
  if (location !== null) gl.uniform1f(location, value);
}

function drawLocalMapFallback(viewProj: Float32Array): void {
  const gl = localMapGl;
  const renderer = localMapRenderer;
  const programs = localMapPrograms;
  if (!gl || !renderer || !programs || !renderer.ready) return;
  // Stage-8.3: дневная светотень гор и долины (тот же свет, что и в renderFrame).
  const light = normalizeLocalVec3([0.52, -0.38, 0.76]);
  const ambient: LocalVec3 = [0.42, 0.45, 0.48];
  const skirt = localSkirtData;
  const fog: LocalVec3 = [...LOCAL_SKIRT_FOG_COLOR];
  const horizon: LocalVec3 = [...LOCAL_HORIZON_COLOR];
  // Stage-8.4: старт тумана поднят до 0.64·R_outer — первые 3–4 круга гексов
  // вокруг активного при 10-кольцевой прогрузке остаются прозрачными и детальными.
  const fogStart = skirt ? skirt.outerRadiusM * 0.64 : localMapRadiusM * 0.85;
  const fogEnd = skirt ? skirt.outerRadiusM * 0.98 : localMapRadiusM;

  gl.useProgram(programs.terrainProgram);
  const terrainView = gl.getUniformLocation(programs.terrainProgram, 'u_viewProj');
  if (terrainView !== null) gl.uniformMatrix4fv(terrainView, false, viewProj);
  setUniform3(gl, programs.terrainProgram, 'u_lightDir', light);
  setUniform3(gl, programs.terrainProgram, 'u_ambientColor', ambient);
  setUniform3(gl, programs.terrainProgram, 'u_fogColor', fog);
  setUniform3(gl, programs.terrainProgram, 'u_horizonColor', horizon);
  setUniform1f(gl, programs.terrainProgram, 'u_fogStart', fogStart);
  setUniform1f(gl, programs.terrainProgram, 'u_fogEnd', fogEnd);
  setUniform1f(gl, programs.terrainProgram, 'u_terrainSize', localMapRadiusM * 2);
  const zoningUnit = gl.getUniformLocation(programs.terrainProgram, 'u_zoning_map');
  if (zoningUnit !== null) gl.uniform1i(zoningUnit, 0);
  const terraformUnit = gl.getUniformLocation(programs.terrainProgram, 'u_terraform_map');
  if (terraformUnit !== null) gl.uniform1i(terraformUnit, 1);
  renderer.drawTerrain(programs.terrainProgram);

  gl.useProgram(programs.structureProgram);
  const structureView = gl.getUniformLocation(programs.structureProgram, 'u_viewProj');
  if (structureView !== null) gl.uniformMatrix4fv(structureView, false, viewProj);
  setUniform3(gl, programs.structureProgram, 'u_lightDir', light);
  setUniform3(gl, programs.structureProgram, 'u_ambientColor', ambient);
  setUniform3(gl, programs.structureProgram, 'u_fogColor', fog);
  setUniform1f(gl, programs.structureProgram, 'u_fogStart', fogStart);
  setUniform1f(gl, programs.structureProgram, 'u_fogEnd', fogEnd);
  renderer.drawStructures(programs.structureProgram);
  gl.useProgram(null);
}

function localTotalInstances(data: LocalMapWorkerResponse): number {
  const meta = data.meta as LocalMapWorkerResponse['meta'] & { totalInstances?: number };
  if (Number.isFinite(meta.totalInstances)) return Math.max(0, Math.round(meta.totalInstances as number));
  return Object.values(data.instanceBuffers).reduce((sum, pack) => sum + (pack ? pack.count : 0), 0);
}

function updateLocalMapHud(): void {
  const renderer = localMapRenderer;
  const data = localMapData;
  const uploading = !!renderer && typeof renderer.isUploading === 'function' && renderer.isUploading();
  let progress = uploading ? 0 : 1;
  if (renderer && typeof renderer.getUploadProgress === 'function') {
    const reported = renderer.getUploadProgress();
    if (Number.isFinite(reported)) progress = clampLocal(reported, 0, 1);
  }
  els.localUploadProgress.value = progress;
  els.localUploadProgress.textContent = Math.round(progress * 100) + '%';
  els.localUploadLabel.textContent = uploading ? Math.round(progress * 100) + '% · загрузка' : 'Готово';
  els.localGenMs.textContent = fmtMs(localMapGenerationMs);
  els.localInstanceCount.textContent = fmtInt(data ? localTotalInstances(data) : localMapInstanceCount);
  els.localBuildableFraction.textContent = fmtPct(localMapBuildableFraction, 1);
  const skirt = localSkirtData;
  if (skirt) {
    const horizonDropM = planetCurvatureDropM(skirt.planetRadiusM, skirt.outerRadiusM);
    // Stage-8.4/8.5: число колец горизонта берётся из фактических данных юбки
    // (R_outer / d_hex), а не хардкодится — HUD честен и при 6, и при 10 кольцах.
    // Stage-8.5: в статусе также показана реальная видимая ширина камеры
    // (селектор «Видимая ширина») и Δz в метрах сферического проседания.
    const ringsLabel = Math.round(skirt.outerRadiusM / Math.max(1, skirt.hexSpacingM));
    els.localFogStatus.textContent =
      `${ringsLabel} колец · R ${fmtNum(skirt.outerRadiusM / 1000, 1)} км (обзор ${fmtNum(localMapWidthKm, 1)} км, Δz ${fmtNum(horizonDropM, 0)} м)`;
  } else {
    els.localFogStatus.textContent = 'активен · R ' + fmtInt(localMapRadiusM) + ' м';
  }
}

function renderLocalMapFrame(): void {
  localMapFrameId = 0;
  if (!localMapActive) return;
  localMapFrameId = window.requestAnimationFrame(renderLocalMapFrame);
  const gl = localMapGl;
  const renderer = localMapRenderer;
  if (!gl || !renderer || gl.isContextLost()) return;
  resizeLocalMapCanvas();
  if (typeof renderer.processPendingUpload === 'function') renderer.processPendingUpload(3.0);
  // Stage-8.3: светлый дневной сизый тон атмосферы вместо космической черноты —
  // за локальной сценой не должен просвечивать уменьшенный глобус.
  gl.clearColor(0.52, 0.62, 0.74, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  applyLocalCameraAnim(performance.now());
  const viewProj = localViewProjection();
  if (typeof renderer.renderFrame === 'function') {
    const skirt = localSkirtData;
    const aspect = Math.max(0.1, els.localMapCanvas.width / Math.max(1, els.localMapCanvas.height));
    const eye = localCameraEye();
    const renderOptions: Record<string, unknown> = {
      lightDir: new Float32Array([0.52, -0.38, 0.76]),
      ambientColor: new Float32Array([0.42, 0.45, 0.48]),
      fogColor: new Float32Array(LOCAL_SKIRT_FOG_COLOR),
      // Stage-8.3: туман отодвинут, чтобы горные хребты юбки читались объёмно
      // и растворялись только у самого дальнего края горизонта.
      // Stage-8.4: старт поднят до 0.64·R_outer под 10 колец прогрузки —
      // первые 3–4 круга гексов вокруг активного остаются без шва и размытия.
      fogStart: skirt ? skirt.outerRadiusM * 0.64 : localMapRadiusM * 0.85,
      fogEnd: skirt ? skirt.outerRadiusM * 0.98 : localMapRadiusM,
      radiusM: localMapRadiusM,
      // Stage-8.3: без объекта camera LocalMapRenderer.renderFrame не рисует
      // купол неба — облака и атмосферный лимб появляются только с ним.
      camera: {
        pitch: localCameraPitch,
        yaw: localCameraYaw,
        fovY: LOCAL_MAP_FOV,
        aspect,
        heightM: Math.max(2, eye[2] - localCameraTarget[2]),
      },
      skyAlpha: 1.0,
      opaqueSkyDome: true,
    };
    if (skirt) {
      renderOptions.planetRadiusM = skirt.planetRadiusM;
      renderOptions.focusRadiusM = localMapRadiusM;
      renderOptions.hexSizeM = skirt.hexSpacingM;
      renderOptions.horizonColor = new Float32Array(LOCAL_HORIZON_COLOR);
    }
    renderer.renderFrame(viewProj, renderOptions);
  } else {
    drawLocalMapFallback(viewProj);
  }
  if (performance.now() - localMapHudLastAt > 100) {
    localMapHudLastAt = performance.now();
    updateLocalMapHud();
  }
}

function selectedLocalScale(value: number): number {
  return LOCAL_MAP_SCALE_STEPS.find((step) => step === value) || 1.2;
}

function neighborCompassLabel(east: readonly number[], north: readonly number[], dir: readonly number[]): string {
  const u = (dir[0] || 0) * (east[0] || 0) + (dir[1] || 0) * (east[1] || 0) + (dir[2] || 0) * (east[2] || 0);
  const v = (dir[0] || 0) * (north[0] || 0) + (dir[1] || 0) * (north[1] || 0) + (dir[2] || 0) * (north[2] || 0);
  const deg = ((Math.atan2(u, v) * 180 / Math.PI) + 360) % 360;
  const dirs = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'] as const;
  return dirs[Math.round(deg / 45) % 8] as string;
}

function neighborTerrainKind(cell: WorkerPatchReadyResponse['patch']['cells'][number], seaLevel: number): string {
  if (cell.elevation < seaLevel) return 'океан';
  if (cell.lakeWeight > 0) return 'озеро';
  if (cell.streamWeight > 0) return 'река';
  if (cell.muLand < 0.5) return 'берег';
  return 'суша';
}

function updateLocalNeighborButtons(patchReady: WorkerPatchReadyResponse | null): void {
  const buttons = els.localNeighborNav.querySelectorAll<HTMLButtonElement>('button[data-slot]');
  const neighbors = patchReady ? patchReady.patch.cells.slice(1) : [];
  const frame = patchReady ? patchReady.patch.frame : null;
  const seaLevel = patchReady ? patchReady.patch.seaLevel : 0;
  buttons.forEach((button) => {
    const slot = Number(button.dataset.slot);
    const cell = neighbors[slot];
    if (!cell || !frame) {
      button.disabled = true;
      button.removeAttribute('data-cell');
      button.textContent = 'Слот ' + String(slot);
      button.setAttribute('aria-label', 'Соседняя ячейка, слот ' + String(slot));
      return;
    }
    const compass = neighborCompassLabel(frame.east, frame.north, cell.center);
    const kind = neighborTerrainKind(cell, seaLevel);
    button.disabled = false;
    button.dataset.cell = String(cell.cell);
    button.textContent = compass + ' · ' + kind + ' #' + String(cell.cell);
    button.title = 'Слот ' + String(slot) + ' (' + compass + ', ' + kind + '): переход на каноническую ячейку #' + String(cell.cell);
    button.setAttribute('aria-label', 'Перецентровка на соседнюю ячейку #' + String(cell.cell) + ' (' + compass + ', ' + kind + '), слот ' + String(slot));
  });
}

function updateLocalBreadcrumb(active: boolean): void {
  els.breadcrumbPatchWrap.hidden = !active;
  els.breadcrumbPatchSep.hidden = !active;
  els.breadcrumbPatch.hidden = !active;
  if (active) {
    els.breadcrumbPatch.textContent = activePatchReady
      ? 'Участок #' + String(activePatchReady.hexCenterCell)
      : 'Участок';
    els.breadcrumbPlanet.removeAttribute('aria-current');
    els.breadcrumbPlanet.setAttribute('role', 'button');
    els.breadcrumbPlanet.tabIndex = 0;
    els.breadcrumbPlanet.title = 'Вернуться на глобус планеты';
  } else {
    els.breadcrumbPatch.textContent = 'Участок';
    els.breadcrumbPlanet.setAttribute('aria-current', 'page');
    els.breadcrumbPlanet.removeAttribute('role');
    els.breadcrumbPlanet.tabIndex = -1;
    els.breadcrumbPlanet.removeAttribute('title');
  }
}

function updateLocalMapUrl(patchReady: WorkerPatchReadyResponse, widthKm: number): void {
  syncBrowserUrl({
    cell: patchReady.canonicalAddress,
    localView: true,
    scale: widthKm,
  });
}

function extractShortFaceCoord(canonicalAddress: string): string {
  const afterV = /\/v\d+\/(.+)$/.exec(canonicalAddress);
  if (afterV && afterV[1]) return afterV[1];
  const segments = canonicalAddress.split('/');
  return segments.length >= 3 ? segments.slice(-3).join('/') : canonicalAddress;
}

function renderLocalMapFromPatch(
  patchReady: WorkerPatchReadyResponse,
  scale: number,
  shouldFlyToPatch: boolean,
  requestId: number,
): void {
  const centerCell = patchReady.patch.cells[0];
  if (!centerCell || requestId !== localMapEntrySeq) return;
  // Stage-8.2, фаза 1: стремительное сближение поверхности планеты с выбранным
  // гексом за 420 мс (параллельно идёт CPU-генерация локального участка).
  if (shouldFlyToPatch && globe) globe.flyToDirection(centerCell.center, 1.16, 420);

  const startedAt = performance.now();
  let localData: LocalMapWorkerResponse;
  let currentProfile: GeographyProfileInput | undefined;
  try { currentProfile = profileFromControls(); } catch (_) { currentProfile = undefined; }
  // Stage-8.5: физический радиус центрального участка жёстко фиксирован
  // (LOCAL_PATCH_BASE_RADIUS_M = 2500 м) и больше не растягивается от селектора
  // «Видимая ширина» — домики и рельеф всегда нормального размера, а селектор
  // управляет только высотой/наклоном камеры.
  const mapRequest = {
    patch: patchReady.patch,
    seed: parseSeedUint32(els.seed.value),
    placeId: Number(selectedPlace?.ID || 2),
    radiusM: LOCAL_PATCH_BASE_RADIUS_M,
    patchKey: patchReady.keys.patchKey,
    ...(currentProfile ? { profile: currentProfile } : {}),
  };
  try {
    localData = generateLocalMap(mapRequest);
  } catch (error) {
    setLocalMapStatus('Ошибка генерации локальной карты: ' + ((error as Error).message || String(error)), 'error');
    return;
  }
  if (requestId !== localMapEntrySeq) return;

  // Stage-8: планетарная юбка 6 колец с бесшовным воротником по heightfield.
  let skirtData: HorizonSkirtData | null = null;
  try {
    skirtData = generateHorizonSkirt(mapRequest, localData.heightfield);
  } catch (error) {
    console.warn('generateHorizonSkirt не сработал, рисую плоскую карту:', error);
    skirtData = null;
  }
  localSkirtData = skirtData;
  if (requestId !== localMapEntrySeq) return;

  localMapData = localData;
  const meta = localData.meta as LocalMapWorkerResponse['meta'] & {
    genMs?: number;
    totalInstances?: number;
    buildableFraction?: number;
  };
  const measuredMs = performance.now() - startedAt;
  localMapGenerationMs = Number.isFinite(meta.genMs) ? Math.max(0, meta.genMs as number) : measuredMs;
  localMapInstanceCount = localTotalInstances(localData);
  localMapBuildableFraction = Number.isFinite(meta.buildableFraction)
    ? clampLocal(meta.buildableFraction as number, 0, 1)
    : clampLocal(patchReady.buildableFraction, 0, 1);
  if (!initializeLocalMapRenderer() || !localMapRenderer) return;

  const renderer = localMapRenderer;
  try {
    if (typeof renderer.enqueueWorkerData === 'function') {
      renderer.enqueueWorkerData(localData, 3.0);
      setLocalMapStatus('Данные готовы; выполняю порционную GPU-заливку без блокировки кадров.', 'info');
    } else {
      renderer.onWorkerData(localData);
      setLocalMapStatus('Локальная карта готова к управлению камерой.', 'ok');
    }
  } catch (error) {
    setLocalMapStatus('Ошибка передачи локальных данных в WebGL2: ' + ((error as Error).message || String(error)), 'error');
    return;
  }

  // Ленивая заливка VAO/буферов юбки и программы купола неба (null снимает
  // горизонт и корректно освобождает его GPU-ресурсы).
  if (typeof renderer.setHorizonSkirt === 'function') {
    try {
      renderer.setHorizonSkirt(localSkirtData);
    } catch (error) {
      console.warn('setHorizonSkirt не сработал, рисую плоскую карту:', error);
      localSkirtData = null;
    }
  }

  activePatchReady = patchReady;
  localPatchLoading = false;
  const shortFaceCoord = extractShortFaceCoord(patchReady.canonicalAddress);
  const planetName = selectedPlace?.name || 'Планета';
  els.localMapTitle.textContent =
    `${planetName} · ячейка #${patchReady.hexCenterCell} (${shortFaceCoord}) · ${patchReady.keys.patchKey}`;
  els.localMapTitle.title =
    `${patchReady.canonicalAddress} · patch_key ${patchReady.keys.patchKey}`;
  els.localInvariantStatus.textContent = (patchReady.invariants.ok ? 'OK' : 'ОШИБКА') + ' · ' +
    Object.values(patchReady.invariants.checks).filter(Boolean).length + '/' + Object.keys(patchReady.invariants.checks).length;
  els.localInvariantStatus.dataset.kind = patchReady.invariants.ok ? 'ok' : 'error';
  localMapActive = true;
  updateLocalNeighborButtons(patchReady);
  updateLocalBreadcrumb(true);
  updateLocalMapUrl(patchReady, scale);
  document.body.classList.add('local-map-active');
  els.localMapStage.hidden = false;
  resizeLocalMapCanvas();
  // Stage-8.6: при переходе к соседней ячейке ракурс предыдущего гекса
  // сохраняется уже на ПЕРВОМ кадре нового патча — сброс в покой выполняется
  // только при свежем Dive-in или при устаревшем/чужом ожидании перелёта.
  // Иначе пользователь видел лишний кадр скачка камеры до finishLocalMapEntry.
  const neighborArrival = pendingNeighborFly !== null &&
    pendingNeighborFly.cell === patchReady.hexCenterCell;
  if (!neighborArrival) resetLocalCamera();
  updateLocalMapHud();
  // Кадровый цикл стартует сразу: порционная GPU-заливка идёт уже во время
  // фазы 1, а сцена проявляется только к началу спуска камеры.
  if (!localMapFrameId) localMapFrameId = window.requestAnimationFrame(renderLocalMapFrame);
  window.clearTimeout(localRevealTimer);
  localRevealTimer = window.setTimeout(
    () => finishLocalMapEntry(requestId, shouldFlyToPatch),
    shouldFlyToPatch ? LOCAL_DIVE_REVEAL_DELAY_MS : 0,
  );
}

/**
 * Stage-8.2, фаза 2: проявляет `#localMapStage` и запускает плавный спуск
 * камеры до уровня выделенного гекса (или мгновенный перелёт к соседу внутри
 * уже открытой локальной карты — без задержки 320 мс).
 */
function finishLocalMapEntry(requestId: number, shouldFlyToPatch: boolean): void {
  localRevealTimer = 0;
  if (requestId !== localMapEntrySeq || !localMapActive || !activePatchReady) return;
  els.localMapStage.hidden = false;
  resizeLocalMapCanvas();
  // Stage-8.6: ожидание перелёта валидно только для прибывшей ячейки.
  const neighborFly = pendingNeighborFly && pendingNeighborFly.cell === activePatchReady.hexCenterCell
    ? pendingNeighborFly
    : null;
  // Сброс в покой нужен только там, где камера действительно стартует заново
  // (свежий Dive-in или устаревшее ожидание) — иначе переход к соседу
  // обходится без единого кадра скачка ракурса.
  if (shouldFlyToPatch) {
    resetLocalCamera();
    startLocalDiveInAnim();
  } else if (neighborFly) {
    // Перелёт к соседнему гексу: цель приезжает со стороны предыдущего гекса.
    // Stage-8.4/8.6: камера сохраняет состояние, записанное в requestLocalNeighbor
    // (или в обработчике «СОСЕДИ PATCH7») до перехода, — пользовательский
    // yaw/pitch/zoom не теряется, кадр не дёргается.
    const { azimuth, prevTargetOffset, prevYaw, prevPitch, prevDist } = neighborFly;
    if (prevTargetOffset) {
      localCameraTarget = [prevTargetOffset[0], prevTargetOffset[1], prevTargetOffset[2]];
    }
    if (prevYaw !== undefined) localCameraYaw = prevYaw;
    if (prevPitch !== undefined) localCameraPitch = prevPitch;
    if (prevDist !== undefined && prevDist > 0) localCameraDistance = prevDist;
    pendingNeighborFly = null;
    startLocalNeighborFlyAnim(azimuth);
  } else {
    resetLocalCamera();
  }
  els.localMapStage.classList.remove('is-active');
  void els.localMapStage.offsetWidth;
  els.localMapStage.classList.add('is-active');
  localMapHudLastAt = 0;
  updateLocalMapHud();
  els.localMapCanvas.focus({ preventScroll: true });
}

function enterLocalMap(patchReady: WorkerPatchReadyResponse, widthKm: number): void {
  if (!patchReady.invariants.ok) {
    setLocalMapStatus('Patch7 не прошёл проверки И-3; Dive-in заблокирован.', 'error');
    return;
  }
  const centerCell = patchReady.patch.cells[0];
  if (!centerCell) {
    setLocalMapStatus('Patch7 не содержит центральную ячейку.', 'error');
    return;
  }
  const scale = selectedLocalScale(Number(widthKm));
  // Stage-8.5: физический радиус центрального участка стабилен
  // (LOCAL_PATCH_BASE_RADIUS_M) и не зависит от селектора «Видимая ширина».
  localMapRadiusM = LOCAL_PATCH_BASE_RADIUS_M;
  els.localScale.value = String(scale);

  // Stage-8.5: если локальная карта уже открыта для ТОЙ ЖЕ ячейки,
  // не перегенерируем меш с гигантскими домами, а плавно переводим камеру
  // на новую дистанцию/наклон (550 мс easeInOutCubic), обновляя URL и HUD.
  //
  // Stage-8.5.1: плавный зум допустим ТОЛЬКО когда это действительно смена
  // масштаба на уже отрисованной ячейке. Пока идёт загрузка соседнего патча
  // (`localPatchLoading`) или запланирован перелёт (`pendingNeighborFly`),
  // `activePatchReady` ещё указывает на прежнюю ячейку — такой вызов обязан
  // идти полным путём `renderLocalMapFromPatch`, иначе переход по кнопкам
  // «СОСЕДИ PATCH7» и по клику на гексы 3D-сцены молча терялся.
  if (localMapActive && !localPatchLoading && !pendingNeighborFly && activePatchReady &&
      activePatchReady.hexCenterCell === patchReady.hexCenterCell) {
    localMapWidthKm = scale;
    const targetDistance = cameraDistanceForWidthKm(scale);
    const targetPitch = cameraPitchForWidthKm(scale);
    cancelLocalCameraAnim();
    localCameraAnim = {
      startAt: performance.now(),
      durationMs: 550,
      fromYaw: localCameraYaw,
      toYaw: localCameraYaw,
      fromPitch: localCameraPitch,
      toPitch: targetPitch,
      fromDist: localCameraDistance,
      toDist: targetDistance,
      fromTarget: [localCameraTarget[0], localCameraTarget[1], localCameraTarget[2]],
      toTarget: defaultLocalCameraTarget(localCameraYaw, scale),
      easeInOut: true,
    };
    updateLocalMapUrl(patchReady, scale);
    updateLocalMapHud();
    return;
  }

  const shouldFlyToPatch = !localMapActive;
  // Свежий Dive-in не должен подхватывать перелёт несостоявшегося соседнего запроса.
  if (shouldFlyToPatch) pendingNeighborFly = null;
  const requestId = ++localMapEntrySeq;
  window.clearTimeout(localMapHideTimer);
  localMapWidthKm = scale;
  setLocalMapStatus('Запускаю локальную генерацию и подлёт к центру Patch7…', 'info');

  // Подлёт и CPU-генерация стартуют на одном первом кадре Dive-in.
  window.requestAnimationFrame(() => {
    renderLocalMapFromPatch(patchReady, scale, shouldFlyToPatch, requestId);
  });
}

function exitLocalMap(): void {
  localMapEntrySeq++;
  localMapActive = false;
  pendingInitialLocalView = false;
  if (localMapFrameId) window.cancelAnimationFrame(localMapFrameId);
  localMapFrameId = 0;
  window.clearTimeout(localRevealTimer);
  localRevealTimer = 0;
  localSkirtData = null;
  localCameraAnim = null;
  pendingNeighborFly = null;
  localPatchLoading = false;
  localClickCandidate = null;
  localPointers.clear();
  localPointerId = null;
  localPointerMode = null;
  localPinchDistance = 0;
  els.localMapStage.classList.remove('is-active');
  document.body.classList.remove('local-map-active');
  updateLocalBreadcrumb(false);
  syncBrowserUrl({ localView: false });
  if (globe) {
    // Stage-8.2: глобус один раз доворачивается к центру активной ячейки и
    // плавно отводит камеру до орбитальной дистанции 2.85 под исчезающим
    // непрозрачным оверлеем (без ежекадровой синхронизации камер).
    const exitCell = activePatchReady ? activePatchReady.patch.cells[0] : null;
    const centerDir = exitCell ? exitCell.center : globe.getCameraState().viewDirection;
    globe.flyToDirection(centerDir, 2.85, 680);
  }

  if (localMapRenderer && typeof localMapRenderer.dispose === 'function') {
    localMapRenderer.dispose();
    localMapRenderer = null;
    if (!localMapProgramsOwnedByRenderer && localMapPrograms && localMapGl) {
      localMapGl.deleteProgram(localMapPrograms.terrainProgram);
      localMapGl.deleteProgram(localMapPrograms.structureProgram);
    }
    localMapPrograms = null;
    localMapProgramsOwnedByRenderer = false;
    localMapData = null;
  }
  window.clearTimeout(localMapHideTimer);
  localMapHideTimer = window.setTimeout(() => {
    if (!localMapActive) els.localMapStage.hidden = true;
  }, 460);
}

/* ------------------------------------------------------------- CSV */
function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const out: CsvRow = {};
      header.forEach((h, idx) => { out[h] = r[idx] == null ? '' : (r[idx] as string); });
      return out;
    });
}

function fetchFirst(urls: string[]): Promise<string> {
  let chain: Promise<string> = Promise.reject(new Error('нет URL'));
  urls.forEach((url) => {
    chain = chain.catch(() =>
      fetch(url).then((res) => {
        if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
        return res.text();
      }));
  });
  return chain;
}

function numberFrom(row: CsvRow | null, key: string, fallback: number): number {
  const n = Number(row && row[key]);
  return Number.isFinite(n) ? n : fallback;
}

interface PlaceLabDefaults {
  preset: string;
  planet: string;
  seed: string;
  radius: string;
  surface: string;
  quality: string;
  mode: string;
  relief: string;
}

interface SyncBrowserUrlOptions {
  profile?: GeographyProfileInput;
  cell?: string | null;
  localView?: boolean;
  scale?: number | string;
}

function normalizePlanetId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'stage6-planet';
}

function getPlaceLabDefaults(place: CsvRow): PlaceLabDefaults {
  const genRow = place.ID ? generationByPlaceId.get(place.ID) : undefined;
  const fallbackPreset = (presets[0] && presets[0].archetype_id) || 'earthlike_balanced';
  let preset = fallbackPreset;
  if (genRow && genRow.preset_id && presetsById.has(genRow.preset_id)) {
    preset = genRow.preset_id;
  } else if (place.type === 'moon' && presetsById.has('barren_moon')) {
    preset = 'barren_moon';
  }
  const preferredSurface = PREFERRED_SURFACE_CLASS[preset] || 'terrestrial';
  const surface = (genRow && genRow.surface_class && [...els.surfaceClass.options].some((o) => o.value === genRow.surface_class))
    ? genRow.surface_class
    : preferredSurface;
  const rawPlanet = place.ID || place.name || 'world';
  const seed = (genRow && genRow.master_seed_hex)
    ? genRow.master_seed_hex.trim()
    : ('place-' + (place.ID || '') + '-' + (place.name || 'world'));
  const rawRadius = (genRow && genRow.radius_km)
    ? genRow.radius_km
    : (place.type === 'moon' ? '1737' : '6371');
  const radius = String(Math.max(300, Number(rawRadius) || 6371));
  return {
    preset,
    planet: normalizePlanetId(rawPlanet),
    seed,
    radius,
    surface,
    quality: 'auto',
    mode: 'biome',
    relief: '1',
  };
}

function applyUrlLabOverrides(params: URLSearchParams, ignorePlanetParam: boolean): void {
  const presetParam = params.get('preset');
  if (presetParam && presetsById.has(presetParam)) {
    els.preset.value = presetParam;
    syncSurfaceClassWithPreset();
  }
  const surfaceParam = params.get('surface');
  if (surfaceParam && [...els.surfaceClass.options].some((o) => o.value === surfaceParam)) {
    els.surfaceClass.value = surfaceParam;
  }
  const seedParam = params.get('seed');
  if (seedParam) els.seed.value = seedParam;
  const planetParam = params.get('planet');
  if (planetParam && !ignorePlanetParam) els.planetId.value = planetParam;
  const radiusParam = params.get('radius');
  if (radiusParam) els.radius.value = radiusParam;
  const qualityParam = params.get('quality');
  if (qualityParam && [...els.quality.options].some((o) => o.value === qualityParam)) {
    els.quality.value = qualityParam;
  }
  const modeParam = params.get('mode');
  if (modeParam && [...els.colorMode.options].some((o) => o.value === modeParam)) {
    els.colorMode.value = modeParam;
  }
  const reliefParam = params.get('relief');
  if (reliefParam && [...els.relief.options].some((o) => o.value === reliefParam)) {
    els.relief.value = reliefParam;
  }
  const scaleParam = params.get('scale');
  if (scaleParam && LOCAL_MAP_SCALE_STEPS.some((step) => String(step) === scaleParam)) {
    els.localScale.value = scaleParam;
    localMapWidthKm = Number(scaleParam);
  }
  updateEstimates();
}

function installPresets(rows: CsvRow[]): void {
  presets = rows.filter((r) =>
    r.archetype_id && r.archetype_id !== 'gas_giant_bands');
  presetsById = new Map(presets.map((r) => [r.archetype_id as string, r]));
  els.preset.innerHTML = presets.map((r) =>
    '<option value="' + escapeHtml(r.archetype_id) + '">' +
    escapeHtml(r.display_name_ru || r.archetype_id) + '</option>').join('');
  syncSurfaceClassWithPreset();
  applyUrlLabOverrides(initialUrlParams, false);
}

function syncSurfaceClassWithPreset(): void {
  const preset = presetsById.get(els.preset.value);
  if (!preset) return;
  const preferred = PREFERRED_SURFACE_CLASS[preset.archetype_id as string] || 'terrestrial';
  els.surfaceClass.value = preferred;
  els.presetInfo.textContent = preset.description_ru || '';
}

function canonicalFrequency(radiusKm: number): number {
  const cells = 163842 * Math.pow(radiusKm / 6371, 2);
  return Math.max(8, Math.round(Math.sqrt(Math.max(0, cells - 2) / 10)));
}

function cellCountFor(v: number): number {
  return 10 * v * v + 2;
}

function isCoarseOrSmallScreen(): boolean {
  return !!window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760);
}

function targetRenderV(canonicalV: number): number {
  const q = els.quality.value;
  let factor = 1;
  // Телефонная приёмка Redmi: v=80 на Земле давал лишнюю плотность,
  // которую экран телефона всё равно не различает после fit по ширине.
  if (q === 'auto') factor = isCoarseOrSmallScreen() ? 0.5 : 1;
  else if (q === 'balanced') factor = 0.75;
  else if (q === 'performance') factor = 0.5;
  else if (q === 'proxy') factor = 0.375;
  return Math.max(16, Math.min(256, Math.round(canonicalV * factor)));
}

function proxyRenderV(targetV: number): number {
  if (!els.autoProxy.checked || targetV <= 40) return targetV;
  return Math.max(16, Math.min(48, Math.round(targetV * 0.375)));
}

function updateEstimates(): { radius: number; canonical: number; target: number; proxy: number } {
  const radius = Math.max(300, Number(els.radius.value) || 6371);
  const canonical = canonicalFrequency(radius);
  const target = targetRenderV(canonical);
  const proxy = proxyRenderV(target);
  els.radiusOut.textContent = 'канон v=' + canonical + ' · ' + fmtInt(cellCountFor(canonical)) + ' яч.';
  els.qualityOut.textContent = proxy === target
    ? 'v=' + target + ' · ' + fmtInt(cellCountFor(target)) + ' яч.'
    : 'прокси v=' + proxy + ' → финал v=' + target + ' · ' + fmtInt(cellCountFor(target)) + ' яч.';
  return { radius, canonical, target, proxy };
}

function profileFromControls(): GeographyProfileInput {
  const preset = presetsById.get(els.preset.value);
  if (!preset) throw new Error('Пресет ещё не загружен');
  const seedRaw = els.seed.value.trim() || 'korhal-iv';
  const planetId = normalizePlanetId(els.planetId.value);
  els.planetId.value = planetId;
  const profile: GeographyProfileInput = {
    planetId: planetId,
    presetId: preset.archetype_id,
    surfaceClass: els.surfaceClass.value,
    radiusKm: Math.max(300, Number(els.radius.value) || 6371),
    geographyVersion: 'c100-soft-v2',
    continentMeanCells: numberFrom(preset, 'continent_mean_cells', 400),
    continentVariation: numberFrom(preset, 'continent_variation', 0.8),
    oceanBasinMeanCells: numberFrom(preset, 'ocean_basin_mean_cells', 6000),
    drainageMeanCells: numberFrom(preset, 'drainage_mean_cells', 72),
    oceanPctl: numberFrom(preset, 'ocean_pctl', 70),
    shelfBelowPctl: numberFrom(preset, 'shelf_below_pctl', 67),
    shelfAbovePctl: numberFrom(preset, 'shelf_above_pctl', 73),
    highlandLandPctl: numberFrom(preset, 'highland_land_pctl', 75),
    mountainLandPctl: numberFrom(preset, 'mountain_land_pctl', 92),
    aridLandPctl: numberFrom(preset, 'arid_land_pctl', 25),
    wetLandPctl: numberFrom(preset, 'wet_land_pctl', 75),
    coldPctl: numberFrom(preset, 'cold_pctl', 20),
    hotPctl: numberFrom(preset, 'hot_pctl', 80),
    streamFlowPctl: numberFrom(preset, 'stream_flow_pctl', 90),
    majorRiverFlowPctl: numberFrom(preset, 'major_river_flow_pctl', 99),
    coastSoftWidthCells: numberFrom(preset, 'coast_soft_width_cells', 3),
    continentSoftWidthCells: numberFrom(preset, 'continent_soft_width_cells', 4),
    biomeSoftWidthCells: numberFrom(preset, 'biome_soft_width_cells', 2),
    transitionEntropyPctl: numberFrom(preset, 'transition_entropy_pctl', 90),
  };
  if (/^[0-9a-fA-F]{16}$/.test(seedRaw)) profile.masterSeedHex = seedRaw.toLowerCase();
  else profile.seedText = seedRaw;
  return profile;
}

function profileKey(profile: GeographyProfileInput): string {
  return JSON.stringify(profile) + '|relief=' + els.relief.value + '|quality=' + els.quality.value;
}

function syncBrowserUrl(options: SyncBrowserUrlOptions = {}): void {
  if (options.cell !== undefined) {
    selectedCellAddress = options.cell ? (options.cell.trim() || null) : null;
  }
  const currentPreset = options.profile?.presetId
    ? String(options.profile.presetId)
    : els.preset.value;
  const currentPlanet = options.profile
    ? String(options.profile.planetId)
    : normalizePlanetId(els.planetId.value);
  const currentSeed = els.seed.value.trim();
  const currentRadius = options.profile
    ? String(options.profile.radiusKm)
    : String(Math.max(300, Number(els.radius.value) || 6371));
  const currentSurface = options.profile?.surfaceClass
    ? String(options.profile.surfaceClass)
    : els.surfaceClass.value;
  const currentQuality = els.quality.value;
  const currentMode = els.colorMode.value;
  const currentRelief = els.relief.value;

  const params = new URLSearchParams();
  if (selectedPlace !== null) {
    const placeId = (selectedPlace.ID && selectedPlace.ID !== 'none') ? selectedPlace.ID.trim() : '';
    const systemId = (selectedPlace.system_id && selectedPlace.system_id !== 'none') ? selectedPlace.system_id.trim() : '';
    if (placeId) params.set('place', placeId);
    if (systemId) params.set('system', systemId);

    const defaults = getPlaceLabDefaults(selectedPlace);
    if (currentPreset && currentPreset !== defaults.preset) params.set('preset', currentPreset);
    if (currentPlanet && currentPlanet !== defaults.planet) params.set('planet', currentPlanet);
    if (currentSeed && currentSeed !== defaults.seed) params.set('seed', currentSeed);
    if (currentRadius && currentRadius !== defaults.radius) params.set('radius', currentRadius);
    if (currentSurface && currentSurface !== defaults.surface) params.set('surface', currentSurface);
    if (currentQuality && currentQuality !== defaults.quality) params.set('quality', currentQuality);
    if (currentMode && currentMode !== defaults.mode) params.set('mode', currentMode);
    if (currentRelief && currentRelief !== defaults.relief) params.set('relief', currentRelief);
  } else {
    if (currentPreset) params.set('preset', currentPreset);
    if (currentPlanet) params.set('planet', currentPlanet);
    if (currentSeed) params.set('seed', currentSeed);
    if (currentRadius) params.set('radius', currentRadius);
    if (currentSurface) params.set('surface', currentSurface);
    if (currentQuality) params.set('quality', currentQuality);
    if (currentMode) params.set('mode', currentMode);
    if (currentRelief) params.set('relief', currentRelief);
  }

  if (selectedCellAddress) {
    params.set('cell', selectedCellAddress);
    const isLocal = options.localView !== undefined
      ? options.localView
      : (localMapActive || pendingInitialLocalView);
    if (isLocal) {
      params.set('view', 'local');
      const scaleVal = options.scale !== undefined
        ? String(options.scale)
        : String(localMapWidthKm || els.localScale.value || '1.2');
      params.set('scale', scaleVal);
    }
  }

  const query = params.toString().replace(
    /(^|&)cell=([^&]*)/,
    (_match, prefix: string, val: string) => prefix + 'cell=' + val.replace(/%2F/gi, '/'),
  );
  const nextUrl = window.location.pathname + (query ? '?' + query : '') + window.location.hash;
  window.history.replaceState(null, '', nextUrl);
}

function updateUrl(profile: GeographyProfileInput): void {
  syncBrowserUrl({ profile });
}

/* --------------------------------------------------------------- worker */
function ensureWorker(): Worker {
  if (worker) return worker;
  workerToken = 'stage6-' + (++workerSeq) + '-' + Date.now();
  worker = new Worker('planet-globe-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = function (event: ErrorEvent): void {
    localPatchLoading = false;
    pendingNeighborFly = null;
    activeRequest = null;
    pendingGpuReady = null;
    if (globe) globe.setAdaptiveQualityHold(false);
    showLoading(false);
    setStatus('Ошибка worker: ' + (event.message || 'неизвестная ошибка'), 'error');
  };
  return worker;
}

function restartWorker(): Worker {
  if (worker) worker.terminate();
  worker = null;
  return ensureWorker();
}

function showLoading(show: boolean, compact?: boolean, title?: string): void {
  els.loading.hidden = !show;
  els.loading.classList.toggle('compact', !!compact);
  if (title) els.loadingTitle.textContent = title;
  if (show) setProgress(0, 'Подготовка…');
}

function setProgress(fraction: number, label?: string): void {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  els.loadingBar.style.width = pct + '%';
  els.loadingPct.textContent = pct + '%';
  if (label) els.loadingLabel.textContent = label;
}

function requestRender(
  profile: GeographyProfileInput,
  key: string,
  renderV: number,
  targetV: number,
  phase: string,
): void {
  ensureWorker();
  pendingGpuReady = null;
  if (globe) globe.setAdaptiveQualityHold(true);
  const id = ++requestSeq;
  activeRequest = {
    id, profile, profileKey: key, renderV, targetV, phase,
    startedAt: performance.now(),
  };
  const post: GenerateMessage = {
    type: 'generate',
    token: workerToken,
    requestId: id,
    profile: profile,
    renderV: renderV,
    colorMode: els.colorMode.value,
    reliefScale: Number(els.relief.value),
    fallbackPreview: !webglAvailable,
  };
  (worker as Worker).postMessage(post);
  const phaseName = renderV === targetV ? 'Финал' : 'Прокси';
  showLoading(true, phase === 'upgrade', phaseName + ' v=' + renderV + (renderV === targetV ? '' : ' → финал v=' + targetV));
  setStatus('Генерация: ' + String(profile.planetId) + ', ' + phaseName.toLowerCase() + ' v=' + renderV + '…', 'info');
}

function startGeneration(restart: boolean, reason: string): void {
  window.clearTimeout(upgradeTimer);
  window.clearTimeout(cycleTimer);
  let profile: GeographyProfileInput;
  let key: string;
  try {
    profile = profileFromControls();
    key = profileKey(profile);
  } catch (err) {
    setStatus((err as Error).message || String(err), 'error');
    return;
  }
  if (localMapActive) exitLocalMap();
  if (reason !== 'initial') {
    pendingInitialCell = null;
    selectedCellAddress = null;
    pendingInitialLocalView = false;
  }
  latestPatchRequest++;
  lastPatchReady = null;
  activePatchReady = null;
  localPatchLoading = false;
  pendingNeighborFly = null;
  els.diveLocalMap.disabled = true;
  updateLocalNeighborButtons(null);
  updateUrl(profile);
  const estimates = updateEstimates();
  if (restart) restartWorker(); else ensureWorker();
  if (globe) globe.clearSelection();
  renderSelection(null);
  const firstV = proxyRenderV(estimates.target);
  requestRender(profile, key, firstV, estimates.target, reason || (firstV === estimates.target ? 'final' : 'proxy'));
}

function scheduleUpgrade(request: ActiveRequest | null): void {
  window.clearTimeout(upgradeTimer);
  upgradeTimer = window.setTimeout(() => {
    // Тот же worker сохраняет proxy-поверхность для pick, пока финал
    // считается в фоне. Пользователь уже видит и крутит планету.
    if (!request) return;
    requestRender(request.profile, request.profileKey, request.targetV, request.targetV, 'upgrade');
  }, 250);
}

function onWorkerMessage(event: MessageEvent): void {
  const msg = (event.data || {}) as WorkerResponse & { token?: string };
  if (msg.token && msg.token !== workerToken && msg.token !== displayedToken) return;
  if (msg.type === 'worker-ready') return;
  if (msg.type === 'progress') {
    if (!activeRequest || msg.requestId !== activeRequest.id || msg.token !== workerToken) return;
    const phase = activeRequest.renderV === activeRequest.targetV ? 'Финал' : 'Прокси';
    setProgress(msg.fraction, phase + ' v=' + activeRequest.renderV + ': ' + (msg.label || msg.stage));
    return;
  }
  if (msg.type === 'ready') {
    if (!activeRequest || msg.requestId !== activeRequest.id || msg.token !== workerToken) return;
    handleReady(msg);
    return;
  }
  if (msg.type === 'colors') {
    if (msg.token !== displayedToken) return;
    if (globe) globe.setColors(msg.colors);
    setStatus('Слой: ' + selectedColorLabel() + '.', 'ok');
    return;
  }
  if (msg.type === 'pick-result') {
    if (msg.token !== displayedToken) return;
    if (msg.purpose === 'hover') {
      if (msg.requestId !== latestHoverRequest) return;
      renderHover(msg.info);
    } else {
      if (msg.requestId !== latestPickRequest) return;
      if (globe && msg.info && msg.info.polygon) globe.setSelection(msg.info.polygon as CellPolygon);
      renderSelection(msg.info);
      if (msg.info) {
        if (globe && Array.isArray(msg.info.centerDirection)) {
          globe.flyToDirection(msg.info.centerDirection, undefined, 650);
        }
        syncBrowserUrl({ cell: msg.info.address });
        const inspector = document.getElementById('patchInspector');
        if (inspector) inspector.dataset.cell = String(msg.info.cell);
        lastPatchReady = null;
        els.diveLocalMap.disabled = true;
        updateLocalNeighborButtons(null);
        const prefetch = document.getElementById('prefetchStatus');
        if (prefetch) prefetch.textContent = 'Каноническая ячейка ' + msg.info.address + ' выбрана; запрашиваю срез Patch7…';
        requestPatchExtract(msg.info.cell);
      } else {
        localPatchLoading = false;
        pendingNeighborFly = null;
        pendingInitialLocalView = false;
        syncBrowserUrl({ cell: null, localView: false });
      }
    }
    return;
  }
  if (msg.type === 'prefetch-ready') {
    if (msg.token !== displayedToken || msg.requestId !== latestPrefetchRequest) return;
    renderPrefetchReady(msg);
    return;
  }
  if (msg.type === 'patch-ready') {
    if (msg.token !== displayedToken || msg.requestId !== latestPatchRequest) return;
    renderPatchReady(msg);
    return;
  }
  if (msg.type === 'cache-cleared') {
    setStatus('Кэш сеток очищен. Следующая генерация построит топологию заново.', 'ok');
    return;
  }
  if (msg.type === 'error') {
    if (msg.requestId === latestPickRequest || msg.requestId === latestPatchRequest) {
      localPatchLoading = false;
      pendingNeighborFly = null;
    }
    if (activeRequest && msg.requestId && msg.requestId !== activeRequest.id) return;
    if (msg.requestId === latestPickRequest || msg.requestId === latestHoverRequest) return;
    activeRequest = null;
    pendingGpuReady = null;
    if (globe) globe.setAdaptiveQualityHold(false);
    showLoading(false);
    setStatus('Ошибка: ' + (msg.message || msg.code || 'генерация не удалась'), 'error');
    els.stats.textContent = 'Генерация не удалась.\n' + (msg.message || '') + (msg.stack ? '\n\n' + msg.stack : '');
  }
}

function handleReady(msg: WorkerReadyResponse): void {
  const request = activeRequest;
  if (request && request.phase === 'upgrade' && !pendingInitialCell) {
    pendingInitialCell = lastPatchReady?.canonicalAddress || activePatchReady?.canonicalAddress || selectedCellAddress;
  }
  lastPatchReady = null;
  els.diveLocalMap.disabled = true;
  updateLocalNeighborButtons(null);
  if (globe) {
    // Worker закончил CPU-часть, но видимым глобус станет только после
    // порционной GPU-заливки и атомарной подмены VAO. До этого момента
    // не объявляем планету готовой и не сбрасываем steady-статистику.
    pendingGpuReady = { msg: msg, request: request };
    globe.clearSelection();
    renderSelection(null);
    setProgress(0.84, (msg.summary.renderV >= (request ? request.targetV : 0) ? 'Финал' : 'Прокси') +
      ' v=' + msg.summary.renderV + ': GPU-заливка геометрии');
    setStatus('CPU-часть готова: заливаю геометрию на GPU…', 'info');
    // wire-геометрия без vertexCellId/cellIndexStart — pick живёт в воркере.
    if (request && request.phase === 'upgrade') {
      globe.transitionGeometry(msg.geometry as unknown as GlobeGeometry, 0.45);
    } else {
      globe.setGeometry(msg.geometry as unknown as GlobeGeometry);
      globe.animateBuild(1.1);
    }
    return;
  }
  finalizeReady(msg, request);
}

function finalizeReady(msg: WorkerReadyResponse, request: ActiveRequest | null): void {
  displayedToken = String(msg.token || '');
  displayedSummary = msg.summary;
  syncDossierSummary(msg.summary);
  setProgress(1, 'Готово');
  if (!globe && msg.preview) drawFallback(msg.preview);
  renderSelection(null);
  renderSummary(msg.summary);
  els.cells.textContent = fmtInt(msg.summary.cellCount);
  els.tris.textContent = fmtInt(msg.summary.triangleCount);
  els.lod.textContent = 'v=' + msg.summary.renderV + ' / канон ' + msg.summary.canonicalV;

  if (pendingInitialCell && worker && displayedToken) {
    const requestedCell = pendingInitialCell;
    pendingInitialCell = null;
    const id = ++latestPickRequest;
    const pickMsg: PickMessage = {
      type: 'pick',
      token: displayedToken,
      requestId: id,
      cell: requestedCell,
      purpose: 'select',
    };
    worker.postMessage(pickMsg);
  }

  const isFinal = request ? msg.summary.renderV >= request.targetV : true;
  if (isFinal) {
    completedPlanets++;
    generationHistory.unshift({
      planet: msg.summary.planetId,
      preset: msg.summary.presetId,
      v: msg.summary.renderV,
      total: msg.summary.timingsMs.total as number,
      at: new Date(),
    });
    generationHistory = generationHistory.slice(0, 8);
    renderHistory();
    activeRequest = null;
    if (globe) {
      globe.setAdaptiveQualityHold(false);
      globe.resetStats();
    }
    showLoading(false);
    setStatus('Готово: ' + msg.summary.planetId + ', финал v=' + msg.summary.renderV +
      ', CPU за ' + fmtMs(msg.summary.timingsMs.total) +
      ', GPU-бандл подменён. Статистика кадров сброшена — для steady-замера покрутите глобус 10 секунд.', 'ok');
    if (els.colorMode.value !== msg.colorMode) sendColorMode();
    if (cycleActive) scheduleNextCycle();
  } else {
    setStatus('Прокси v=' + msg.summary.renderV + ' уже можно крутить. Финал v=' +
      (request ? request.targetV : '?') + ' считается следом…', 'ok');
    scheduleUpgrade(request);
  }
}

function drawFallback(preview: { width: number; height: number; data: Uint8ClampedArray }): void {
  els.fallback.width = preview.width;
  els.fallback.height = preview.height;
  const ctx = els.fallback.getContext('2d');
  if (!ctx) return;
  const image = new ImageData(new Uint8ClampedArray(preview.data), preview.width, preview.height);
  ctx.putImageData(image, 0, 0);
  els.fallbackWrap.hidden = false;
}

function selectedColorLabel(): string {
  const opt = els.colorMode.options[els.colorMode.selectedIndex];
  return opt ? (opt.textContent || els.colorMode.value) : els.colorMode.value;
}

function sendColorMode(): void {
  if (!worker || !displayedToken || activeRequest || pendingGpuReady) return;
  const id = ++requestSeq;
  const post: ColorModeMessage = {
    type: 'color-mode',
    token: displayedToken,
    requestId: id,
    mode: els.colorMode.value,
  };
  worker.postMessage(post);
}

function sendPick(direction: number[], purpose: string): void {
  if (!worker || !displayedToken || !displayedSummary || pendingGpuReady) return;
  const id = ++requestSeq;
  if (purpose === 'hover') latestHoverRequest = id; else {
    latestPickRequest = id;
    latestPatchRequest++;
    lastPatchReady = null;
    els.diveLocalMap.disabled = true;
    updateLocalNeighborButtons(null);
  }
  const post: PickMessage = {
    type: 'pick',
    token: displayedToken,
    requestId: id,
    purpose: purpose,
    direction: direction,
  };
  worker.postMessage(post);
}

/* --------------------------------------------------------------- вывод */
function renderFrameStats(stats: GlobeStats): void {
  els.fps.textContent = stats.fps ? fmtNum(stats.fps, 0) : '—';
  els.frameP50.textContent = stats.p50 ? fmtNum(stats.p50, 1) : '—';
  els.frameP95.textContent = stats.p95 ? fmtNum(stats.p95, 1) : '—';
  els.frameP99.textContent = stats.p99 ? fmtNum(stats.p99, 1) : '—';
  els.frameOver50.textContent = String(stats.over50 || 0);
  els.frameOver100.textContent = String(stats.over100 || 0);
  els.renderScale.textContent = fmtNum(stats.renderScale || 1, 2) + '×';
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  if (memory && memory.usedJSHeapSize) {
    els.heap.textContent = fmtBytes(memory.usedJSHeapSize);
  } else els.heap.textContent = 'n/a';
}

function renderHistory(): void {
  if (!generationHistory.length) {
    els.switchHistory.textContent = 'Смен планет в этой сессии пока не было.';
    return;
  }
  els.switchHistory.textContent = 'Завершено планет: ' + completedPlanets + '\n' +
    generationHistory.map((h) =>
      '· ' + h.planet + ' / ' + h.preset + ' / v=' + h.v + ' — ' + fmtMs(h.total)).join('\n');
}

function biomeName(id: number): string {
  const defs = displayedSummary ? displayedSummary.biomeDefinitions : null;
  if (!defs || !defs[id]) return '—';
  const def = defs[id];
  return def.nameRu || def.key;
}

function renderSummary(s: GlobeSummary): void {
  const st = (s.stats || {}) as Record<string, unknown>;
  const hydro = (st.hydrology || {}) as Record<string, unknown>;
  const flow = (hydro.flow || {}) as Record<string, unknown>;
  const term = (hydro.terminalLandAreaFractions || {}) as Record<string, number>;
  const continents = (st.continents || {}) as Record<string, unknown>;
  const drainage = (hydro.drainageRegions || {}) as Record<string, unknown>;
  const mnt = (st.mountains || {}) as Record<string, number>;
  const biomes = (st.biomes || {}) as Record<string, unknown>;
  const softFractions = (st.softFractions || {}) as Record<string, number>;
  const continentDist = (continents.distribution || {}) as Record<string, number>;
  const drainageDist = (drainage.distribution || {}) as Record<string, number>;
  const biomeFractions = (Array.isArray(biomes.fractions) ? biomes.fractions : []) as { id: number; landAreaFraction: number }[];
  const topBiomes = biomeFractions.slice()
    .sort((a, b) => b.landAreaFraction - a.landAreaFraction)
    .slice(0, 5)
    .map((b) => biomeName(b.id) + ' ' + fmtPct(b.landAreaFraction))
    .join(', ');
  const lines = [
    s.planetId + ' · ' + s.presetId + ' · R=' + fmtInt(s.radiusKm) + ' км',
    'seed: ' + s.masterSeedHex,
    'рендер v=' + s.renderV + ' из канонических ' + s.canonicalV + ' · ячеек ' + fmtInt(s.cellCount) + ' · треугольников ' + fmtInt(s.triangleCount),
    'геометрия GPU: ' + fmtBytes(s.geometryBytes) + ' · сетка: ' + s.gridSource,
    'время: сетка ' + fmtMs(s.timingsMs.mesh) + ', поверхность ' + fmtMs(s.timingsMs.surface) + ', геометрия ' + fmtMs(s.timingsMs.geometry),
    '',
    'океан (hard): ' + fmtPct(st.oceanFractionHard) + ' при цели ' + fmtPct(st.oceanFractionTarget),
    'мягкие доли: суша ' + fmtPct(softFractions.land) + ', шельф ' + fmtPct(softFractions.shelf) + ', океан ' + fmtPct(softFractions.ocean),
    'континенты C100: ' + s.counts.continents + ', средняя эфф. масса ' + fmtNum(continentDist.mean, 1) + ' яч. (цель рендера ' + fmtInt(s.renderProfileCells.continentMeanCells) + ')',
    'бассейны океана: ' + s.counts.oceanBasins + ', плит: ' + s.counts.plates,
    '',
    'суши маршрутизировано: ' + fmtPct(flow.routedLandFraction) + '; терминалы: океан ' + fmtPct(term.ocean) + ', конечные озёра ' + fmtPct(term.terminalLake) + ', бессточные ' + fmtPct(term.endorheic),
    'озёр: ' + s.counts.lakes + '; strict catchments: ' + s.counts.catchments + '; дренажных регионов: ' + s.counts.drainageRegions + ' (средняя ' + fmtNum(drainageDist.mean, 1) + ' яч., цель ' + fmtInt(s.renderProfileCells.drainageMeanCells) + ')',
    'реки: stream ' + fmtPct(flow.streamLandCellFraction) + ', major ' + fmtPct(flow.majorRiverLandCellFraction) + ' суши',
    'горные хребты: ' + s.counts.mountainRanges + ', площадь гор ' + fmtPct(mnt.mountainAreaFraction) + ', швов ' + fmtPct(mnt.seamAreaFraction),
    '',
    'биомы: средняя энтропия ' + fmtNum(biomes.meanEntropy, 3),
    'топ по суше: ' + topBiomes,
    '',
    s.gridVersion + ' · ' + s.noiseVersion + ' · ' + s.surfaceVersion + ' (' + s.hydrologyVersion + ' + ' + s.biomeVersion + ')',
  ];
  els.stats.textContent = lines.join('\n');
}

function renderHover(info: GlobePickInfo | null): void {
  if (!info) { els.hover.textContent = ''; return; }
  els.hover.textContent = 'под курсором: ячейка #' + info.cell + ' · ' + biomeName(info.biome.top1Id) +
    ' · ' + HARD_CLASS_RU[info.hardClass] + ' · pick ' + fmtNum(info.pickMs, 2) + ' мс';
}

function renderSelection(info: GlobePickInfo | null): void {
  if (!info) {
    els.selection.innerHTML = '<b>Ячейка не выбрана.</b><br>Кликните или коснитесь глобуса: здесь появятся биом, континент, река и канонический адрес.';
    return;
  }
  const rows: string[] = [];
  function row(label: string, value: string): void {
    rows.push('<div class="sel-row"><span>' + escapeHtml(label) + '</span><b>' + value + '</b></div>');
  }
  row('Ячейка', '#' + info.cell + ' · ' + fmtInt(info.areaKm2) + ' км²');
  row('Адрес', '<code>' + escapeHtml(info.address) + '</code>');
  row('Координаты', fmtNum(info.latitudeDeg, 2) + '°, ' + fmtNum(info.longitudeDeg, 2) + '°');
  row('Класс', HARD_CLASS_RU[info.hardClass] + ' · высота−море ' + fmtNum(info.elevationRelative, 4));
  row('Биом', escapeHtml(biomeName(info.biome.top1Id)) + ' ' + fmtPct(info.biome.top1Weight) +
    (info.biome.top2Id >= 0 ? ' + ' + escapeHtml(biomeName(info.biome.top2Id)) + ' ' + fmtPct(info.biome.top2Weight) : ''));
  row('Климат', 'температура ' + fmtPct(info.temperature, 0) + ', влажность ' + fmtPct(info.moisture, 0) + ', вулканизм ' + fmtPct(info.volcanism, 0));
  row('Мягкий берег', 'суша ' + fmtPct(info.mu.land) + ', шельф ' + fmtPct(info.mu.shelf) + ', океан ' + fmtPct(info.mu.ocean) + '; до берега ' + fmtNum(info.coastDistanceCells, 2) + ' яч.');
  if (info.continent) {
    row('Континент C100', '#' + info.continent.top1Id + ' · ' + fmtPct(info.continent.top1Weight) + ' · эфф. площадь ' + fmtInt(info.continent.effectiveAreaKm2) + ' км²');
  } else if (info.oceanBasinId >= 0) {
    row('Бассейн океана', '#' + info.oceanBasinId + ' · вес ' + fmtPct(info.oceanBasinWeight));
  }
  if (info.flow.accumulationKm2 > 0 || info.catchment) {
    row('Сток', fmtInt(info.flow.accumulationKm2) + ' км² · stream ' + fmtPct(info.flow.streamWeight) + ' · влияние реки ' + fmtPct(info.flow.riverInfluence));
  }
  if (info.drainageRegion) {
    row('Дренажный регион', '#' + info.drainageRegion.id + ' · ' + fmtInt(info.drainageRegion.cellCount) + ' яч. · → ' + (TERMINAL_RU[info.drainageRegion.terminalType] || info.drainageRegion.terminalType));
  }
  if (info.lake) row('Озеро', '#' + info.lake.id + ' · ' + fmtInt(info.lake.areaKm2) + ' км²');
  if (info.mountains.weight > 0.01 || info.mountains.rangeId >= 0) {
    row('Горы', 'вес ' + fmtPct(info.mountains.weight) + ', шов ' + fmtPct(info.mountains.seamWeight) + (info.mountains.rangeId >= 0 ? ', хребет #' + info.mountains.rangeId : ''));
  }
  row('Pick', fmtNum(info.pickMs, 2) + ' мс');
  els.selection.innerHTML = rows.join('');
}

/* --------------------------------------------------------------- цикл */
function randomSeedHex(): string {
  const bytes = new Uint8Array(8);
  if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nextPlanet(): void {
  if (!presets.length) return;
  const idx = presets.findIndex((p) => p.archetype_id === els.preset.value);
  const next = presets[(idx + 1) % presets.length] as CsvRow;
  els.preset.value = next.archetype_id as string;
  syncSurfaceClassWithPreset();
  els.seed.value = randomSeedHex();
  els.planetId.value = 'stage6-' + (next.archetype_id || '').replace(/_/g, '-');
  updateEstimates();
  startGeneration(true, 'manual');
}

function scheduleNextCycle(): void {
  window.clearTimeout(cycleTimer);
  cycleTimer = window.setTimeout(() => {
    if (cycleActive) nextPlanet();
  }, 5000);
}

function setCycle(active: boolean): void {
  cycleActive = !!active;
  els.cycle.setAttribute('aria-pressed', cycleActive ? 'true' : 'false');
  els.cycle.textContent = cycleActive ? 'стоп: автосмена планет' : 'автосмена планет (стресс)';
  window.clearTimeout(cycleTimer);
  if (cycleActive && !activeRequest) scheduleNextCycle();
  if (cycleActive) setStatus('Автосмена включена: новая планета каждые ~5 секунд после готовности финала.', 'ok');
}

/* --------------------------------------------------------------- события */
function initEvents(): void {
  els.diveLocalMap.addEventListener('click', () => {
    if (lastPatchReady && !els.diveLocalMap.disabled) {
      enterLocalMap(lastPatchReady, Number(els.localScale.value));
    }
  });
  els.exitLocalMap.addEventListener('click', exitLocalMap);
  els.breadcrumbPlanet.addEventListener('click', () => {
    if (localMapActive) exitLocalMap();
  });
  els.breadcrumbPlanet.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!localMapActive) return;
    if (event.key === 'Enter' || event.key === ' ' || event.code === 'Space') {
      event.preventDefault();
      event.stopPropagation();
      exitLocalMap();
    }
  });
  els.localScale.addEventListener('change', () => {
    const scale = Number(els.localScale.value);
    // Stage-8.5: при изменении селектора «Видимая ширина» всегда запоминаем
    // новое значение, а если локальная карта открыта — плавно переводим камеру
    // (не перегенерируя меш, см. enterLocalMap с проверкой той же ячейки).
    localMapWidthKm = selectedLocalScale(scale);
    const patch = lastPatchReady || activePatchReady;
    if (patch && localMapActive) enterLocalMap(patch, scale);
  });
  els.resetLocalCam.addEventListener('click', resetLocalCamera);
  els.localNeighborNav.addEventListener('click', (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-cell]');
    const cell = Number(button && button.dataset.cell);
    if (!button || button.disabled || !Number.isInteger(cell) || cell < 0) return;
    // Азимут перехода в касательном кадре текущего патча (atan2(east, north)),
    // чтобы перелёт камеры стартовал со стороны предыдущего гекса.
    const slot = Number(button.dataset.slot);
    const patch = activePatchReady;
    const neighbor = patch && Number.isInteger(slot)
      ? patch.patch.cells[slot + 1]
      : undefined;
    if (patch && neighbor) {
      const { east, north } = patch.patch.frame;
      const dir = neighbor.center;
      const u = dir[0] * east[0] + dir[1] * east[1] + dir[2] * east[2];
      const v = dir[0] * north[0] + dir[1] * north[1] + dir[2] * north[2];
      // Stage-8.5.1: кнопка «СОСЕДИ PATCH7» и клик по гексу 3D-сцены идут
      // ОДНИМ путём — сохраняем полное состояние камеры (как в
      // requestLocalNeighbor), чтобы перелёт стартовал без рывка и не терял
      // пользовательский yaw/pitch/zoom.
      pendingNeighborFly = {
        cell,
        azimuth: Math.atan2(u, v),
        prevTargetOffset: [localCameraTarget[0], localCameraTarget[1], localCameraTarget[2]],
        prevYaw: localCameraYaw,
        prevPitch: localCameraPitch,
        prevDist: localCameraDistance,
      };
    }
    cancelLocalCameraAnim();
    // Stage-8.6: кнопка «СОСЕДИ PATCH7» идёт тем же путём, что и
    // requestLocalNeighbor, — флаг загрузки выставляется сразу перед запросом,
    // чтобы enterLocalMap не принял прибывший патч за смену масштаба.
    localPatchLoading = true;
    setLocalMapStatus('Запрашиваю соседнюю ячейку #' + cell + ' и новый Patch7…', 'info');
    requestCellPick(cell);
  });
  const copyLink = document.getElementById('copyCellLinkBtn');
  copyLink?.addEventListener('click', () => {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      const status = document.getElementById('prefetchStatus');
      if (status) status.textContent = 'Ссылка на ячейку скопирована.';
    }).catch(() => setStatus('Не удалось скопировать ссылку: проверьте разрешение браузера.', 'warn'));
  });
  els.preset.addEventListener('change', () => {
    syncSurfaceClassWithPreset();
    if (selectedPlace === null) {
      els.breadcrumbPlanet.textContent = els.preset.options[els.preset.selectedIndex]?.text || 'Демо-мир';
    }
    updateEstimates();
  });
  els.radius.addEventListener('input', () => { updateEstimates(); });
  els.quality.addEventListener('change', () => {
    updateEstimates();
    if (!activeRequest && displayedSummary) {
      // Качество — тот же профиль на другой render-v: worker не убиваем,
      // текущая планета остаётся доступна для pick до замены.
      const profile = profileFromControls();
      const key = profileKey(profile);
      const est = updateEstimates();
      updateUrl(profile);
      if (displayedSummary.renderV !== est.target) requestRender(profile, key, proxyRenderV(est.target), est.target, 'quality');
    }
  });
  els.autoProxy.addEventListener('change', () => { updateEstimates(); });
  els.colorMode.addEventListener('change', () => {
    if (displayedSummary) updateUrl(profileFromControls());
    if (activeRequest) setStatus('Слой применится после готовности текущей генерации.', 'info');
    else sendColorMode();
  });
  els.relief.addEventListener('change', () => {
    setStatus('Высота рельефа применится при следующей перегенерации геометрии.', 'info');
  });
  els.randomSeed.addEventListener('click', () => { els.seed.value = randomSeedHex(); });
  els.generate.addEventListener('click', () => { startGeneration(true, 'manual'); });
  els.nextPlanet.addEventListener('click', nextPlanet);
  els.cycle.addEventListener('click', () => { setCycle(!cycleActive); });
  els.clearCache.addEventListener('click', () => {
    ensureWorker();
    (worker as Worker).postMessage({ type: 'clear-grid-cache', token: workerToken, requestId: ++requestSeq });
  });

  function toggleButton(button: HTMLButtonElement, initial: boolean, apply: (on: boolean) => void): () => boolean {
    let state = initial;
    button.setAttribute('aria-pressed', state ? 'true' : 'false');
    button.addEventListener('click', () => {
      state = !state;
      button.setAttribute('aria-pressed', state ? 'true' : 'false');
      apply(state);
    });
    return () => state;
  }
  const spinState = toggleButton(els.spin, true, (on) => { if (globe) globe.setAutoRotate(on); });
  toggleButton(els.borders, true, (on) => { if (globe) globe.setBordersEnabled(on); });
  toggleButton(els.atmosphere, true, (on) => { if (globe) globe.setAtmosphereEnabled(on); });
  els.resetView.addEventListener('click', () => { if (globe) globe.resetView(); });
  els.panelToggle.addEventListener('click', () => {
    const expanded = els.panelToggle.getAttribute('aria-expanded') !== 'false';
    els.panelToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    els.panelToggle.textContent = expanded ? '+' : '−';
    els.panelBody.hidden = expanded;
  });
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (localMapActive) return;
    const activeEl = document.activeElement;
    const tag = activeEl ? activeEl.tagName : '';
    if (
      event.code === 'Space' &&
      !/INPUT|SELECT|TEXTAREA|BUTTON|A/.test(tag || '') &&
      activeEl?.getAttribute('role') !== 'button'
    ) {
      event.preventDefault();
      els.spin.click();
    }
  });
  void spinState;
}

function installPlaceCatalog(placesText: string, systemsText: string, generationText: string): void {
  placesCatalog = parseCsv(placesText).filter((row) => row.type === 'planet' || row.type === 'moon');
  systemsCatalog = parseCsv(systemsText);
  generationByPlaceId = new Map<string, CsvRow>();
  for (const row of parseCsv(generationText)) {
    if (row.place_id) generationByPlaceId.set(row.place_id, row);
  }
  const select = els.placeSelect;
  const placeOptions = placesCatalog.map((row) => '<option value="' + escapeHtml(row.ID) + '">' +
    escapeHtml(row.name + (row.type === 'moon' ? ' · луна' : '')) + '</option>').join('');
  const demo = ['korhal-iv|Корхал IV · эталон', 'char|Чар · эталон', 'shakuras|Шакурас · эталон'];
  select.innerHTML = '<optgroup label="Каталог сектора Копрулу (places.csv)">' + placeOptions +
    '</optgroup><optgroup label="Эталонные миры генератора (DEMO_PLANETS)">' + demo.map((v) => {
      const parts = v.split('|'); return '<option value="demo:' + escapeHtml(parts[0]) + '">' + escapeHtml(parts[1]) + '</option>';
    }).join('') + '</optgroup>';

  const hasPlaceParam = initialUrlParams.has('place');
  const hasPlanetParam = initialUrlParams.has('planet');
  const findPlace = (token: string): CsvRow | null => placesCatalog.find(
    (r) => r.ID === token || (r.name || '').toLocaleLowerCase('ru') === token.toLocaleLowerCase('ru'),
  ) || null;

  let requestedDemo = '';
  if (hasPlaceParam) {
    const placeReq = (initialUrlParams.get('place') || '').trim();
    selectedPlace = findPlace(placeReq) || placesCatalog.find((r) => r.ID === '2') || placesCatalog[0] || null;
  } else if (hasPlanetParam) {
    const planetReq = (initialUrlParams.get('planet') || '').trim();
    const matched = findPlace(planetReq);
    if (matched) {
      selectedPlace = matched;
    } else {
      selectedPlace = null;
      requestedDemo = planetReq;
    }
  } else {
    selectedPlace = placesCatalog.find((r) => r.ID === '2') || placesCatalog[0] || null;
  }

  if (selectedPlace) {
    select.value = selectedPlace.ID || '';
    applyPlace(selectedPlace);
    applyUrlLabOverrides(initialUrlParams, !hasPlaceParam);
  } else {
    if (requestedDemo) {
      const demoValue = 'demo:' + requestedDemo;
      if ([...select.options].some((o) => o.value === demoValue)) select.value = demoValue;
    }
    applyUrlLabOverrides(initialUrlParams, false);
    applyPlace(null);
  }

  select.addEventListener('change', () => {
    if (select.value.startsWith('demo:')) {
      selectedPlace = null;
      const demoSlug = select.value.slice(5);
      els.planetId.value = demoSlug;
      els.seed.value = demoSlug;
      applyPlace(null);
    } else {
      selectedPlace = placesCatalog.find((r) => r.ID === select.value) || null;
      applyPlace(selectedPlace);
    }
    startGeneration(true, 'catalog');
  });
}

function applyPlace(place: CsvRow | null): void {
  if (!place) {
    els.breadcrumbSystem.textContent = 'Система';
    els.breadcrumbSystem.href = '../sector/sector.html';
    els.breadcrumbPlanet.textContent = els.preset.options[els.preset.selectedIndex]?.text || 'Демо-мир';
    els.backToSector.href = '../sector/sector.html';
    return;
  }
  const genRow = place.ID ? generationByPlaceId.get(place.ID) : undefined;
  const defaults = getPlaceLabDefaults(place);
  els.planetId.value = place.ID || place.name || 'world';
  els.seed.value = defaults.seed;
  els.radius.value = defaults.radius;
  if (presetsById.has(defaults.preset)) {
    els.preset.value = defaults.preset;
    syncSurfaceClassWithPreset();
  }
  els.surfaceClass.value = defaults.surface;
  updateEstimates();
  const systemId = (place.system_id && place.system_id !== 'none') ? place.system_id.trim() : '';
  const placeId = (place.ID && place.ID !== 'none') ? place.ID.trim() : '';
  const system = systemId ? systemsCatalog.find((row) => row.system_id === systemId) : undefined;
  const name = document.getElementById('dossierName'); if (name) name.textContent = place.name || 'Мир';
  const meta = document.getElementById('dossierMeta'); if (meta) meta.textContent = (system ? system.name : 'Система не указана') + ' · ' + (place.faction || 'фракция неизвестна') + ' · ' + (place.type === 'moon' ? 'луна' : 'планета');
  const desc = document.getElementById('dossierDesc'); if (desc) desc.textContent = place.description && place.description !== 'none' ? place.description : 'Описание мира пока не внесено в каталог.';
  const badge = document.getElementById('dossierProfileBadge');
  const key = document.getElementById('dossierGenKey');
  if (genRow && genRow.profile_status === 'frozen') {
    const verification = verifyGenerationKey(genRow as unknown as PlanetGenerationProfileInput);
    if (badge) {
      badge.textContent = verification.ok ? 'L1 Frozen · ключ подтверждён' : 'L1 Frozen · расхождение ключа';
      badge.className = verification.ok ? 'profile-badge frozen' : 'profile-badge draft';
    }
    if (key) key.textContent = genRow.generation_key || verification.expectedKey || '—';
  } else {
    if (badge) { badge.textContent = 'L0 Draft · черновик'; badge.className = 'profile-badge draft'; }
    if (key) key.textContent = (genRow && genRow.generation_key) ? genRow.generation_key : 'Вычисляется по манифесту…';
  }
  els.breadcrumbPlanet.textContent = place.name || 'Планета';
  els.breadcrumbSystem.textContent = system ? (system.name || 'Система') : 'Система';
  els.breadcrumbSystem.href = systemId ? ('../sector/sector.html#/s/' + encodeURIComponent(systemId)) : '../sector/sector.html';
  els.backToSector.href = placeId ? ('../sector/sector.html#/p/' + encodeURIComponent(placeId)) : '../sector/sector.html';
}

function syncDossierSummary(summary: GlobeSummary): void {
  const keyEl = document.getElementById('dossierGenKey');
  if (keyEl && summary.generationKey) keyEl.textContent = summary.generationKey;
  const planetKeyOut = document.getElementById('planetKeyOut');
  if (planetKeyOut && summary.generationKey) planetKeyOut.textContent = summary.generationKey;
  const badge = document.getElementById('dossierProfileBadge');
  if (badge && summary.generationKeyVerification) {
    if (summary.generationKeyVerification.status === 'frozen' && summary.generationKeyVerification.ok) {
      badge.textContent = 'L1 Frozen · ключ подтверждён';
      badge.className = 'profile-badge frozen';
    }
  }
}

function requestPatchExtract(cell: number): void {
  if (!worker || !displayedToken || !Number.isInteger(cell) || cell < 0) return;
  const id = ++latestPatchRequest;
  const msg: ExtractPatchMessage = {
    type: 'extract-patch',
    token: displayedToken,
    requestId: id,
    cell: cell,
  };
  worker.postMessage(msg);
}

function requestCellPick(cell: number): void {
  if (!worker || !displayedToken || !Number.isInteger(cell) || cell < 0) return;
  if (localMapActive) localPatchLoading = true;
  latestPatchRequest++;
  lastPatchReady = null;
  els.diveLocalMap.disabled = true;
  updateLocalNeighborButtons(null);
  const msg: PickMessage = {
    type: 'pick',
    token: displayedToken,
    requestId: ++latestPickRequest,
    cell: cell,
    purpose: 'select',
  };
  worker.postMessage(msg);
}

function renderPrefetchReady(msg: WorkerPrefetchReadyResponse): void {
  const el = document.getElementById('prefetchStatus');
  if (!el) return;
  if (!msg.patchReady || msg.hexCenterCell < 0) {
    el.textContent = 'Предзагрузка v=' + msg.targetV + ': сетка прогрета (' + fmtNum(msg.timingsMs.totalMs, 1) + ' мс)';
    return;
  }
  el.textContent = 'Предзагрузка v=' + msg.targetV + ': чанк #' + msg.chunkId +
    ' (+' + msg.neighborChunks.length + ' соседей), срез Patch7 #' + msg.hexCenterCell +
    ' готов за ' + fmtNum(msg.timingsMs.totalMs, 1) + ' мс';
}

function renderPatchReady(msg: WorkerPatchReadyResponse): void {
  lastPatchReady = msg;
  // Stage-8.5.1: НЕ перезаписываем `activePatchReady` при открытой локальной
  // карте. Иначе `enterLocalMap(msg, scale)` ниже сравнивал только что
  // записанный `msg` сам с собой, принимал переход на соседнюю ячейку за смену
  // масштаба на той же ячейке и делал `return` без `renderLocalMapFromPatch`.
  // При открытой карте `activePatchReady = patchReady` обновляет сам
  // `renderLocalMapFromPatch` — уже после генерации нового меша.
  if (!localMapActive) activePatchReady = msg;
  els.diveLocalMap.disabled = !msg.invariants.ok;
  updateLocalNeighborButtons(msg);

  const planetKeyOut = document.getElementById('planetKeyOut');
  const regionKeyOut = document.getElementById('regionKeyOut');
  const cellKeyOut = document.getElementById('cellKeyOut');
  const patchKeyOut = document.getElementById('patchKeyOut');
  if (planetKeyOut) planetKeyOut.textContent = msg.keys.planetKey || '—';
  if (regionKeyOut) regionKeyOut.textContent = msg.keys.regionKey || '—';
  if (cellKeyOut) cellKeyOut.textContent = msg.keys.cellKey || '—';
  if (patchKeyOut) patchKeyOut.textContent = msg.keys.patchKey || '—';
  const prefetch = document.getElementById('prefetchStatus');
  if (prefetch) {
    prefetch.textContent = 'Срез Patch7 (' + msg.patch.version + ') для ' + msg.canonicalAddress + ' готов.';
  }
  const details = document.getElementById('patchDetails');
  if (details) {
    const riverInlets = msg.patch.river.inlets.length;
    const riverOutlet = msg.patch.river.outlet
      ? ('слот #' + msg.patch.river.outlet.slot + ' → ячейка ' + msg.patch.river.outlet.neighborCell)
      : 'терминал / нет стока';
    const checksCount = Object.values(msg.invariants.checks).filter(Boolean).length;
    const totalChecks = Object.keys(msg.invariants.checks).length;
    details.innerHTML =
      '<div class="kv">' +
        '<span>Центр Patch7 (v=' + escapeHtml(msg.patch.v) + ')</span><strong>#' + escapeHtml(msg.hexCenterCell) + ' (' + escapeHtml(msg.canonicalAddress) + ')</strong>' +
        '<span>Охват кольца (7 ячеек)</span><strong>' + fmtNum(msg.spanMeters / 1000, 2) + ' км (' + fmtInt(msg.spanMeters) + ' м)</strong>' +
        '<span>Площадка под базы (И-3.4)</span><strong>' + fmtPct(msg.buildableFraction, 1) + '</strong>' +
        '<span>Речной граф кольца (И-3.3)</span><strong>входов: ' + riverInlets + ' · выход: ' + escapeHtml(riverOutlet) + '</strong>' +
        '<span>Инварианты сшивки И-3</span><strong>' + (msg.invariants.ok ? 'OK' : 'ОШИБКА') + ' (' + checksCount + '/' + totalChecks + ')</strong>' +
      '</div>';
  }
  if (!msg.invariants.ok) {
    localPatchLoading = false;
    pendingNeighborFly = null;
    pendingInitialLocalView = false;
    if (localMapActive) exitLocalMap();
    else syncBrowserUrl({ localView: false });
    setLocalMapStatus('Patch7 не прошёл проверки И-3; Dive-in заблокирован.', 'error');
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (localMapActive || pendingInitialLocalView || params.get('view') === 'local') {
    pendingInitialLocalView = false;
    const scale = selectedLocalScale(Number(params.get('scale') || els.localScale.value));
    enterLocalMap(msg, scale);
  }
}

/* --------------------------------------------------------------- запуск */
function init(): void {
  try {
    const coarseScreen = isCoarseOrSmallScreen();
    globe = PlanetGlobe.createPlanetGlobe(els.canvas, {
      autoRotate: true,
      borders: true,
      atmosphere: true,
      maxPixelRatio: coarseScreen ? 1.5 : 2,
      onGeometryUploadProgress: function (info: { geometry: GlobeGeometry; fraction: number }): void {
        if (!pendingGpuReady || (info.geometry as unknown) !== (pendingGpuReady.msg.geometry as unknown)) return;
        const labelPhase = pendingGpuReady.msg.summary.renderV >= (pendingGpuReady.request ? pendingGpuReady.request.targetV : 0)
          ? 'Финал' : 'Прокси';
        setProgress(0.84 + 0.16 * Math.max(0, Math.min(1, info.fraction || 0)),
          labelPhase + ' v=' + pendingGpuReady.msg.summary.renderV + ': GPU-заливка геометрии');
      },
      onGeometryReady: function (geometry: GlobeGeometry): void {
        if (!pendingGpuReady || geometry !== (pendingGpuReady.msg.geometry as unknown as GlobeGeometry)) return;
        const pending = pendingGpuReady;
        pendingGpuReady = null;
        finalizeReady(pending.msg, pending.request);
      },
      onPickDirection: function (direction: number[]) { sendPick(direction, 'select'); },
      onZoomDive: function (): void {
        // Stage-8.2: колесо вглубь на упоре дистанции глобуса — двухфазный
        // спуск на локальный уровень уже выбранного и готового участка.
        if (localMapActive || els.diveLocalMap.disabled) return;
        if (!lastPatchReady || !lastPatchReady.invariants.ok) return;
        enterLocalMap(lastPatchReady, Number(els.localScale.value));
      },
      onHoverDirection: function (direction: number[]) {
        const now = performance.now();
        if (now - lastHoverSentAt < 90) return;
        lastHoverSentAt = now;
        sendPick(direction, 'hover');
      },
      onPickMiss: function () {
        latestPatchRequest++;
        lastPatchReady = null;
        activePatchReady = null;
        localPatchLoading = false;
        pendingNeighborFly = null;
        pendingInitialLocalView = false;
        els.diveLocalMap.disabled = true;
        updateLocalNeighborButtons(null);
        if (globe) globe.clearSelection();
        renderSelection(null);
        syncBrowserUrl({ cell: null, localView: false });
      },
      onCameraIntent: function (intent) {
        if (!worker || !displayedSummary || !displayedToken || intent.zoomRatio < 0.35) return;
        const id = ++latestPrefetchRequest;
        const msg: PrefetchMessage = {
          type: 'prefetch',
          token: displayedToken,
          requestId: id,
          targetV: displayedSummary.canonicalV,
          focusDirection: intent.viewDirection,
        };
        worker.postMessage(msg);
      },
      onStats: renderFrameStats,
      onContextLost: function () { setStatus('WebGL-контекст потерян; ждём восстановления…', 'warn'); },
      onContextRestored: function () { setStatus('WebGL-контекст восстановлен.', 'ok'); },
    });
  } catch (err) {
    console.error(err);
    globe = null;
  }
  if (!globe) {
    webglAvailable = false;
    els.canvas.hidden = true;
    els.fallbackWrap.hidden = false;
    setStatus('WebGL2 недоступен: включился 2D fallback с развёрткой планеты.', 'warn');
  }

  initEvents();
  renderHistory();
  renderSelection(null);
  Promise.all([
    fetchFirst(['../data/planet-archetypes-template.csv', '../../data/planet-archetypes-template.csv', '/data/planet-archetypes-template.csv']),
    fetchFirst(['/data/places.csv', '../data/places.csv']),
    fetchFirst(['/data/systems.csv', '../data/systems.csv']),
    fetchFirst(['/data/planet-generation.csv', '../data/planet-generation.csv']).catch(() => ''),
  ]).then(([presetText, placeText, systemText, generationText]) => {
    installPresets(parseCsv(presetText));
    installPlaceCatalog(placeText, systemText, generationText);
    ensureWorker();
    startGeneration(false, 'initial');
  }).catch((err: Error) => {
    setStatus('Не удалось загрузить пресеты планет: ' + err.message, 'error');
    els.stats.textContent = 'Пресеты не загрузились. Проверьте, что страница открыта с опубликованного сайта TIMELINE PROJECT, а не как локальный файл.';
  });
}

init();
