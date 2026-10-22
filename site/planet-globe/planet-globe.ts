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
import { generateLocalMap } from '../../src/local-map/local-map-worker.ts';
import { StructureRenderer } from '../../src/local-map/local-map-renderer.ts';
import type { LocalMapWorkerResponse } from '../../src/local-map/local-map-worker.ts';
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
  dispose?: () => void;
};

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
  breadcrumbPatchWrap: must<HTMLElement>('breadcrumbPatchWrap'),
  breadcrumbPatchSep: must<HTMLElement>('breadcrumbPatchSep'),
  breadcrumbPatch: must<HTMLElement>('breadcrumbPatch'),
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
let placesCatalog: CsvRow[] = [];
let systemsCatalog: CsvRow[] = [];
let generationByPlaceId = new Map<string, CsvRow>();
let selectedPlace: CsvRow | null = null;
let pendingInitialCell: string | null = new URLSearchParams(window.location.search).get('cell');
let globe: PlanetGlobeHandle | null = null;
let webglAvailable = true;
let lastPatchReady: WorkerPatchReadyResponse | null = null;
let localMapGl: WebGL2RenderingContext | null = null;
let localMapRenderer: Stage8StructureRenderer | null = null;
let localMapPrograms: LocalMapPrograms | null = null;
let localMapProgramsOwnedByRenderer = false;
let localMapActive = false;
let localMapFrameId = 0;
let localMapEntrySeq = 0;
let localMapHideTimer = 0;
let localMapData: LocalMapWorkerResponse | null = null;
let localMapGenerationMs = 0;
let localMapBuildableFraction = 0;
let localMapInstanceCount = 0;
let localMapWidthKm = 1.2;
let localMapRadiusM = 600;
let localMapHudLastAt = 0;
let localMapCanvasEventsInstalled = false;
let localCameraYaw = -0.65;
let localCameraPitch = 0.82;
let localCameraDistance = 0;
let localCameraTarget: [number, number, number] = [0, 0, 20];
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
      alpha: false,
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

function resetLocalCamera(): void {
  localCameraYaw = -0.65;
  localCameraPitch = 0.82;
  const hf = localMapData?.heightfield;
  const res = Math.round(Math.sqrt(hf?.length || 0));
  const centerZ = hf && res > 0 ? Number(hf[(res >> 1) * res + (res >> 1)] || 0) : 0;
  localCameraTarget = [0, 0, Number.isFinite(centerZ) ? centerZ + 12 : 20];
  const rect = els.localMapCanvas.getBoundingClientRect();
  const aspect = rect.height > 0 ? rect.width / rect.height : 1;
  const fit = Math.max(0.45, Math.min(1, aspect || 1));
  localCameraDistance = Math.max(2, (localMapRadiusM * 1.18) / (Math.tan(LOCAL_MAP_FOV / 2) * fit));
}

function localViewProjection(): Float32Array {
  if (!(localCameraDistance > 0)) resetLocalCamera();
  const aspect = Math.max(0.1, els.localMapCanvas.width / Math.max(1, els.localMapCanvas.height));
  const cosPitch = Math.cos(localCameraPitch);
  const direction: LocalVec3 = [
    cosPitch * Math.cos(localCameraYaw),
    cosPitch * Math.sin(localCameraYaw),
    Math.sin(localCameraPitch),
  ];
  const eye: LocalVec3 = [
    localCameraTarget[0] + direction[0] * localCameraDistance,
    localCameraTarget[1] + direction[1] * localCameraDistance,
    localCameraTarget[2] + direction[2] * localCameraDistance,
  ];
  const view = lookAtLocal(eye, localCameraTarget, [0, 0, 1]);
  const near = Math.max(0.1, localMapRadiusM * 0.0001);
  const far = Math.max(10000, localCameraDistance * 6 + localMapRadiusM * 8);
  return multiplyLocalMat4(perspectiveLocal(LOCAL_MAP_FOV, aspect, near, far), view);
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
  const maxPan = localMapRadiusM * 0.75;
  const panLength = Math.hypot(localCameraTarget[0], localCameraTarget[1]);
  if (panLength > maxPan) {
    localCameraTarget[0] *= maxPan / panLength;
    localCameraTarget[1] *= maxPan / panLength;
  }
  localCameraTarget[2] = clampLocal(localCameraTarget[2], -localMapRadiusM * 0.25, localMapRadiusM * 0.5);
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
  });
  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    const previous = localPointers.get(event.pointerId);
    if (!previous) return;
    localPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (localPointers.size >= 2) {
      const distance = currentLocalPinchDistance();
      if (localPinchDistance > 0 && distance > 0) {
        localCameraDistance = clampLocal(localCameraDistance * localPinchDistance / distance,
          Math.max(2, localMapRadiusM * 0.08), localMapRadiusM * 60);
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
      localCameraPitch = clampLocal(localCameraPitch + dy * 0.005, 0.12, 1.48);
    } else {
      applyLocalPan(dx, dy);
    }
  });
  const endPointer = (event: PointerEvent): void => {
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
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('wheel', (event: WheelEvent) => {
    event.preventDefault();
    localCameraDistance = clampLocal(localCameraDistance * Math.exp(event.deltaY * 0.001),
      Math.max(2, localMapRadiusM * 0.08), localMapRadiusM * 60);
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
  const light = normalizeLocalVec3([0.46, -0.36, 0.81]);
  const ambient: LocalVec3 = [0.28, 0.34, 0.39];
  const fog: LocalVec3 = [0.025, 0.09, 0.13];
  const fogStart = localMapRadiusM * 0.72;
  const fogEnd = localMapRadiusM;

  gl.useProgram(programs.terrainProgram);
  const terrainView = gl.getUniformLocation(programs.terrainProgram, 'u_viewProj');
  if (terrainView !== null) gl.uniformMatrix4fv(terrainView, false, viewProj);
  setUniform3(gl, programs.terrainProgram, 'u_lightDir', light);
  setUniform3(gl, programs.terrainProgram, 'u_ambientColor', ambient);
  setUniform3(gl, programs.terrainProgram, 'u_fogColor', fog);
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
  els.localFogStatus.textContent = 'активен · R ' + fmtInt(localMapRadiusM) + ' м';
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
  gl.clearColor(0.004, 0.018, 0.034, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  const viewProj = localViewProjection();
  if (typeof renderer.renderFrame === 'function') {
    renderer.renderFrame(viewProj, {
      lightDir: new Float32Array([0.46, -0.36, 0.81]),
      ambientColor: new Float32Array([0.28, 0.34, 0.39]),
      fogColor: new Float32Array([0.025, 0.09, 0.13]),
      fogStart: localMapRadiusM * 0.72,
      fogEnd: localMapRadiusM,
      radiusM: localMapRadiusM,
    });
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

function updateLocalNeighborButtons(patchReady: WorkerPatchReadyResponse | null): void {
  const buttons = els.localNeighborNav.querySelectorAll<HTMLButtonElement>('button[data-slot]');
  const neighbors = patchReady ? patchReady.patch.cells.slice(1) : [];
  buttons.forEach((button) => {
    const slot = Number(button.dataset.slot);
    const cell = neighbors[slot];
    if (!cell) {
      button.disabled = true;
      button.removeAttribute('data-cell');
      button.textContent = 'Слот ' + String(slot);
      button.setAttribute('aria-label', 'Соседняя ячейка, слот ' + String(slot));
      return;
    }
    button.disabled = false;
    button.dataset.cell = String(cell.cell);
    button.textContent = 'Слот ' + String(slot) + ' · #' + String(cell.cell);
    button.title = 'Каноническая ячейка ' + String(cell.cell);
    button.setAttribute('aria-label', 'Перецентровка на соседнюю ячейку #' + String(cell.cell) + ', слот ' + String(slot));
  });
}

function updateLocalBreadcrumb(visible: boolean): void {
  els.breadcrumbPatchWrap.hidden = !visible;
  els.breadcrumbPatchSep.hidden = !visible;
  els.breadcrumbPatch.hidden = !visible;
  if (visible) els.breadcrumbPatch.textContent = 'Участок';
}

function updateLocalMapUrl(patchReady: WorkerPatchReadyResponse, widthKm: number): void {
  const params = new URLSearchParams(window.location.search);
  params.set('place', selectedPlace ? (selectedPlace.ID || '') : String(els.planetId.value || '2'));
  params.set('cell', patchReady.canonicalAddress);
  params.set('view', 'local');
  params.set('scale', String(widthKm));
  window.history.replaceState(null, '', window.location.pathname + '?' + params.toString() + window.location.hash);
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
  const shouldFlyToPatch = !localMapActive;
  const requestId = ++localMapEntrySeq;
  window.clearTimeout(localMapHideTimer);
  localMapWidthKm = scale;
  localMapRadiusM = Math.max(600, (scale * 1000) / 2);
  els.localScale.value = String(scale);
  setLocalMapStatus('Запускаю локальную генерацию и подлёт к центру Patch7…', 'info');

  // Подлёт и CPU-генерация стартуют на одном первом кадре Dive-in.
  window.requestAnimationFrame(() => {
    if (requestId !== localMapEntrySeq) return;
    if (shouldFlyToPatch && globe) globe.flyToDirection(centerCell.center, 1.45, 750);

    const startedAt = performance.now();
    let localData: LocalMapWorkerResponse;
    try {
      localData = generateLocalMap({
        patch: patchReady.patch,
        seed: parseSeedUint32(els.seed.value),
        placeId: Number(selectedPlace?.ID || 2),
        radiusM: Math.max(600, (scale * 1000) / 2),
      });
    } catch (error) {
      setLocalMapStatus('Ошибка генерации локальной карты: ' + ((error as Error).message || String(error)), 'error');
      return;
    }
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

    els.localMapTitle.textContent = patchReady.canonicalAddress + ' · patch_key ' + patchReady.keys.patchKey;
    els.localMapTitle.title = 'Ячейка ' + patchReady.canonicalAddress + ' · ключ участка ' + patchReady.keys.patchKey;
    els.localInvariantStatus.textContent = (patchReady.invariants.ok ? 'OK' : 'ОШИБКА') + ' · ' +
      Object.values(patchReady.invariants.checks).filter(Boolean).length + '/' + Object.keys(patchReady.invariants.checks).length;
    els.localInvariantStatus.dataset.kind = patchReady.invariants.ok ? 'ok' : 'error';
    updateLocalNeighborButtons(patchReady);
    updateLocalBreadcrumb(true);
    updateLocalMapUrl(patchReady, scale);
    document.body.classList.add('local-map-active');
    els.localMapStage.hidden = false;
    resizeLocalMapCanvas();
    resetLocalCamera();
    els.localMapStage.classList.remove('is-active');
    void els.localMapStage.offsetWidth;
    els.localMapStage.classList.add('is-active');
    localMapActive = true;
    localMapHudLastAt = 0;
    updateLocalMapHud();
    if (!localMapFrameId) localMapFrameId = window.requestAnimationFrame(renderLocalMapFrame);
    els.localMapCanvas.focus({ preventScroll: true });
  });
}

function exitLocalMap(): void {
  localMapEntrySeq++;
  localMapActive = false;
  if (localMapFrameId) window.cancelAnimationFrame(localMapFrameId);
  localMapFrameId = 0;
  localPointers.clear();
  localPointerId = null;
  localPointerMode = null;
  localPinchDistance = 0;
  els.localMapStage.classList.remove('is-active');
  document.body.classList.remove('local-map-active');
  updateLocalBreadcrumb(false);
  const params = new URLSearchParams(window.location.search);
  params.delete('view');
  params.delete('scale');
  const query = params.toString();
  window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
  if (globe) globe.setDistance(3.05);

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

function installPresets(rows: CsvRow[]): void {
  presets = rows.filter((r) =>
    r.archetype_id && r.archetype_id !== 'gas_giant_bands');
  presetsById = new Map(presets.map((r) => [r.archetype_id as string, r]));
  els.preset.innerHTML = presets.map((r) =>
    '<option value="' + escapeHtml(r.archetype_id) + '">' +
    escapeHtml(r.display_name_ru || r.archetype_id) + '</option>').join('');
  const params = new URLSearchParams(window.location.search);
  const presetParam = params.get('preset');
  if (presetParam && presetsById.has(presetParam)) els.preset.value = presetParam;
  const seedParam = params.get('seed');
  if (seedParam) els.seed.value = seedParam;
  const planetParam = params.get('planet');
  if (planetParam) els.planetId.value = planetParam;
  const radiusParam = params.get('radius');
  if (radiusParam) els.radius.value = radiusParam;
  const qualityParam = params.get('quality');
  if (qualityParam) els.quality.value = qualityParam;
  const modeParam = params.get('mode');
  if (modeParam) els.colorMode.value = modeParam;
  const reliefParam = params.get('relief');
  if (reliefParam) els.relief.value = reliefParam;
  const scaleParam = params.get('scale');
  if (scaleParam && LOCAL_MAP_SCALE_STEPS.some((step) => String(step) === scaleParam)) {
    els.localScale.value = scaleParam;
  }
  syncSurfaceClassWithPreset();
  const surfaceParam = params.get('surface');
  if (surfaceParam) els.surfaceClass.value = surfaceParam;
  updateEstimates();
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
  const planetId = els.planetId.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'stage6-planet';
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

function updateUrl(profile: GeographyProfileInput): void {
  const params = new URLSearchParams();
  const prior = new URLSearchParams(window.location.search);
  params.set('preset', els.preset.value);
  params.set('planet', String(profile.planetId));
  params.set('seed', els.seed.value.trim());
  params.set('radius', String(profile.radiusKm));
  params.set('surface', els.surfaceClass.value);
  params.set('quality', els.quality.value);
  params.set('mode', els.colorMode.value);
  params.set('relief', els.relief.value);
  if (selectedPlace) params.set('place', selectedPlace.ID || '');
  if (prior.has('cell')) params.set('cell', prior.get('cell') || '');
  if (prior.has('system')) params.set('system', prior.get('system') || '');
  if (prior.get('view') === 'local') {
    params.set('view', 'local');
    params.set('scale', prior.get('scale') || els.localScale.value || '1.2');
  }
  window.history.replaceState(null, '', window.location.pathname + '?' + params.toString() + window.location.hash);
}

/* --------------------------------------------------------------- worker */
function ensureWorker(): Worker {
  if (worker) return worker;
  workerToken = 'stage6-' + (++workerSeq) + '-' + Date.now();
  worker = new Worker('planet-globe-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = function (event: ErrorEvent): void {
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
  latestPatchRequest++;
  lastPatchReady = null;
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
        const params = new URLSearchParams(window.location.search);
        params.set('place', selectedPlace ? (selectedPlace.ID || '') : String(els.planetId.value));
        params.set('cell', msg.info.address);
        window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
        const inspector = document.getElementById('patchInspector');
        if (inspector) inspector.dataset.cell = String(msg.info.cell);
        lastPatchReady = null;
        els.diveLocalMap.disabled = true;
        updateLocalNeighborButtons(null);
        const prefetch = document.getElementById('prefetchStatus');
        if (prefetch) prefetch.textContent = 'Каноническая ячейка ' + msg.info.address + ' выбрана; запрашиваю срез Patch7…';
        requestPatchExtract(msg.info.cell);
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
    pendingInitialCell = lastPatchReady?.canonicalAddress || new URLSearchParams(window.location.search).get('cell');
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
  els.localScale.addEventListener('change', () => {
    if (lastPatchReady && localMapActive) enterLocalMap(lastPatchReady, Number(els.localScale.value));
  });
  els.resetLocalCam.addEventListener('click', resetLocalCamera);
  els.localNeighborNav.addEventListener('click', (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-cell]');
    const cell = Number(button && button.dataset.cell);
    if (!button || button.disabled || !Number.isInteger(cell) || cell < 0) return;
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
  els.preset.addEventListener('change', () => { syncSurfaceClassWithPreset(); updateEstimates(); });
  els.radius.addEventListener('input', () => { updateEstimates(); });
  els.quality.addEventListener('change', () => {
    updateEstimates();
    if (!activeRequest && displayedSummary) {
      // Качество — тот же профиль на другой render-v: worker не убиваем,
      // текущая планета остаётся доступна для pick до замены.
      const profile = profileFromControls();
      const key = profileKey(profile);
      const est = updateEstimates();
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
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (event.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(tag || '')) {
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
  const select = document.getElementById('catalogPlaceSel') as HTMLSelectElement | null;
  if (!select) return;
  const placeOptions = placesCatalog.map((row) => '<option value="' + escapeHtml(row.ID) + '">' +
    escapeHtml(row.name + (row.type === 'moon' ? ' · луна' : '')) + '</option>').join('');
  const demo = ['korhal-iv|Корхал IV · эталон', 'char|Чар · эталон', 'shakuras|Шакурас · эталон'];
  select.innerHTML = '<optgroup label="Каталог сектора Копрулу (places.csv)">' + placeOptions +
    '</optgroup><optgroup label="Эталонные миры генератора (DEMO_PLANETS)">' + demo.map((v) => {
      const parts = v.split('|'); return '<option value="demo:' + escapeHtml(parts[0]) + '">' + escapeHtml(parts[1]) + '</option>';
    }).join('') + '</optgroup>';
  const query = new URLSearchParams(location.search);
  const requested = query.get('place') || query.get('planet') || '2';
  const selected = placesCatalog.find((r) => r.ID === requested || (r.name || '').toLocaleLowerCase('ru') === requested.toLocaleLowerCase('ru'));
  selectedPlace = selected || placesCatalog.find((r) => r.ID === '2') || null;
  if (selectedPlace) { select.value = selectedPlace.ID || ''; applyPlace(selectedPlace); }
  else if (requested) { const demoValue = 'demo:' + requested; if ([...select.options].some((o) => o.value === demoValue)) select.value = demoValue; }
  select.addEventListener('change', () => {
    if (select.value.startsWith('demo:')) { selectedPlace = null; els.planetId.value = select.value.slice(5); els.seed.value = select.value.slice(5); }
    else { selectedPlace = placesCatalog.find((r) => r.ID === select.value) || null; if (selectedPlace) applyPlace(selectedPlace); }
    startGeneration(true, 'catalog');
  });
}

function applyPlace(place: CsvRow): void {
  const genRow = place.ID ? generationByPlaceId.get(place.ID) : undefined;
  els.planetId.value = place.ID || place.name || 'world';
  els.seed.value = (genRow && genRow.master_seed_hex) ? genRow.master_seed_hex : ('place-' + (place.ID || '') + '-' + (place.name || 'world'));
  els.radius.value = (genRow && genRow.radius_km) ? genRow.radius_km : (place.type === 'moon' ? '1737' : '6371');
  if (genRow && genRow.preset_id && presetsById.has(genRow.preset_id)) {
    els.preset.value = genRow.preset_id;
    syncSurfaceClassWithPreset();
  } else if (place.type === 'moon' && presetsById.has('barren_moon')) {
    els.preset.value = 'barren_moon';
    syncSurfaceClassWithPreset();
  }
  const system = systemsCatalog.find((row) => row.system_id === place.system_id);
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
  const crumb = document.getElementById('breadcrumbPlanet'); if (crumb) crumb.textContent = place.name || 'Планета';
  const sysCrumb = document.getElementById('breadcrumbSystem') as HTMLAnchorElement | null;
  if (sysCrumb) { sysCrumb.textContent = system ? (system.name || 'Система') : 'Система'; sysCrumb.href = '../sector/#system=' + encodeURIComponent(place.system_id || ''); }
  const back = document.getElementById('backToSectorBtn') as HTMLAnchorElement | null;
  if (back) back.href = '../sector/#planet=' + encodeURIComponent(place.ID || '');
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
    setLocalMapStatus('Patch7 не прошёл проверки И-3; Dive-in заблокирован.', 'error');
    return;
  }
  const params = new URLSearchParams(window.location.search);
  if (localMapActive || params.get('view') === 'local') {
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
      onHoverDirection: function (direction: number[]) {
        const now = performance.now();
        if (now - lastHoverSentAt < 90) return;
        lastHoverSentAt = now;
        sendPick(direction, 'hover');
      },
      onPickMiss: function () {
        if (globe) globe.clearSelection();
        renderSelection(null);
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
