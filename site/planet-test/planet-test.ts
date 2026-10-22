/* Стенд /planet-test/ на общем боевом ядре (CR-01 PR 5/6.1, И-5.3/И-6).
   -------------------------------------------------------------------------
   Раньше здесь жил трёхтысячный монолит planet-test.js со своим воркером и
   своим GL. Теперь стенд — тонкая обёртка вокруг боевого ядра:
     - рендер и генерация: site/shared/planet-globe.ts + planet-globe-worker.ts
       (те же протокол, геометрия 24 байта/вершину и поля c100-soft-v2, что
       и на /planet-globe/);
     - уникальные экспериментальные режимы: src/planet/planet-globe-fx.ts
       (взрыв осколков Шакураса uSep и шейдерные диагностические палитры).
   Дублирующие planet-test.js и planet-worker.js удалены (И-5).
   PR 6.1: каскадная сборка uBuild, центробежное замещение, контролы осколков
   и 10-секундная телеметрия кадра. */

import PlanetGlobe from '../shared/planet-globe.ts';
import type { CellPolygon, GlobeGeometry, GlobeStats, PlanetGlobeHandle } from '../shared/planet-globe.ts';
import type { GeographyProfileInput } from '../shared/planet-geography.ts';
import type {
  GenerateMessage,
  GlobePickInfo,
  GlobeSummary,
  PickMessage,
  WorkerResponse,
} from '../planet-globe/planet-globe-worker.ts';
import {
  FX_PALETTES,
  FX_TEXTURE_MODES,
  animateShardSeparation,
  buildProceduralShardLayout,
  buildShardTextureData,
  createFxHooks,
  randomFxTheme,
  separationVisuals,
} from '../../src/planet/planet-globe-fx.ts';
import type { FxPaletteId, FxRuntimeState, FxTextureMode, SeparationAnimationHandle, ShardDist } from '../../src/planet/planet-globe-fx.ts';

function must<T extends HTMLElement>(id: string): T {
  if (typeof document === 'undefined') return {} as T;
  const node = document.getElementById(id);
  if (!node) throw new Error('Нет обязательного узла стенда: #' + id);
  return node as T;
}

const els = {
  canvas: must<HTMLCanvasElement>('globe'),
  status: must<HTMLElement>('statusLine'),
  stats: must<HTMLElement>('statsBox'),
  panel: must<HTMLElement>('panel'),
  panelToggle: must<HTMLButtonElement>('panelToggle'),
  panelBody: must<HTMLElement>('panelBody'),
  planet: must<HTMLSelectElement>('planetSel'),
  seed: must<HTMLInputElement>('seedText'),
  radius: must<HTMLInputElement>('radiusKm'),
  quality: must<HTMLSelectElement>('qualitySel'),
  generate: must<HTMLButtonElement>('generateBtn'),
  sepRange: must<HTMLInputElement>('sepRange'),
  sepOut: must<HTMLElement>('sepOut'),
  boomBtn: must<HTMLButtonElement>('boomBtn'),
  shardMode: must<HTMLInputElement>('shardModeChk'),
  shardCount: must<HTMLInputElement>('shardCountRange'),
  shardCountOut: must<HTMLElement>('shardCountOut'),
  shardDist: must<HTMLSelectElement>('shardDist'),
  shardThick: must<HTMLInputElement>('shardThick'),
  shardThickV: must<HTMLElement>('shardThickV'),
  shardJag: must<HTMLInputElement>('shardJag'),
  shardJagV: must<HTMLElement>('shardJagV'),
  shardLoss: must<HTMLInputElement>('shardLoss'),
  shardLossV: must<HTMLElement>('shardLossV'),
  coreScale: must<HTMLInputElement>('coreScale'),
  coreScaleV: must<HTMLElement>('coreScaleV'),
  buildSec: must<HTMLInputElement>('buildSec'),
  buildSecV: must<HTMLElement>('buildSecV'),
  buildProgress: must<HTMLInputElement>('buildProgress'),
  buildProgressV: must<HTMLElement>('buildProgressV'),
  buildBtn: must<HTMLButtonElement>('buildBtn'),
  buildAnimBtn: must<HTMLButtonElement>('buildAnimBtn'),
  spinBtn: must<HTMLButtonElement>('spinBtn'),
  bordersBtn: must<HTMLButtonElement>('bordersBtn'),
  palette: must<HTMLSelectElement>('paletteSel'),
  texMode: must<HTMLSelectElement>('texModeSel'),
  texAmount: must<HTMLInputElement>('texAmountRange'),
  texScale: must<HTMLInputElement>('texScaleRange'),
  hue: must<HTMLInputElement>('hueRange'),
  themeBtn: must<HTMLButtonElement>('themeBtn'),
  fps: must<HTMLElement>('fps'),
  frameP50: must<HTMLElement>('frameP50'),
  frameP95: must<HTMLElement>('frameP95'),
  frameP99: must<HTMLElement>('frameP99'),
  frameOver50: must<HTMLElement>('frameOver50'),
  frameOver100: must<HTMLElement>('frameOver100'),
  frameWorst: must<HTMLElement>('frameWorst'),
  cellInfo: must<HTMLElement>('cellInfo'),
};

const PLANET_PRESETS: {
  id: string; label: string; radiusKm: number; surfaceClass: string; seed: string;
}[] = [
    { id: 'shakuras', label: 'Шакурас · осколки', radiusKm: 5860, surfaceClass: 'temperate terrestrial', seed: 'shakuras' },
    { id: 'korhal-iv', label: 'Корхал-IV · пустыня', radiusKm: 6521, surfaceClass: 'arid terrestrial', seed: 'korhal-iv' },
    { id: 'aiur', label: 'Айур · джунгли', radiusKm: 7094, surfaceClass: 'living terrestrial', seed: 'aiur' },
  ];

type TestFxState = FxRuntimeState & {
  shardDist?: ShardDist;
  shardThick?: number;
  shardJag?: number;
  shardLoss?: number;
  coreScale?: number;
  grid?: unknown;
  geometry?: unknown;
};

/* Состояние FX-плагина: его читают шейдерные хуки в каждом кадре. */
const fxState: TestFxState = {
  separation: 0.3,
  shardMode: true,
  shardCount: 12,
  seedText: 'shakuras',
  theme: {
    palette: 0,
    textureMode: 1,
    textureAmount: 0.45,
    textureScale: 24,
    hueShiftDeg: 0,
  },
  reliefScale: 1,
  shardDist: 'power',
  shardThick: 0.14,
  shardJag: 0.5,
  shardLoss: 0,
  coreScale: 0.55,
};

let globe: PlanetGlobeHandle | null = null;
let worker: Worker | null = null;
let workerToken = '';
let workerSeq = 0;
let requestSeq = 0;
let activeRequestId = 0;
let latestPickRequest = 0;
let displayedSummary: GlobeSummary | null = null;
let boomAnimation: SeparationAnimationHandle | null = null;
let autoRotate = true;
let bordersEnabled = true;

function setStatus(text: string, kind: string): void {
  els.status.textContent = text || '';
  if (els.status.dataset) els.status.dataset.kind = kind || '';
}

function fmtMs(x: unknown): string {
  const n = Number(x) || 0;
  return n.toLocaleString('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 1 }) + ' мс';
}

function fmtFrameMs(v: number): string {
  return v ? v.toFixed(1) + 'ms' : '—';
}

function isCoarseOrSmallScreen(): boolean {
  return !!window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760);
}

function canonicalFrequency(radiusKm: number): number {
  const cells = 163842 * Math.pow(radiusKm / 6371, 2);
  return Math.max(8, Math.round(Math.sqrt(Math.max(0, cells - 2) / 10)));
}

function targetRenderV(radiusKm: number): number {
  const q = els.quality.value;
  let factor = 1;
  if (q === 'auto') factor = isCoarseOrSmallScreen() ? 0.5 : 1;
  else if (q === 'balanced') factor = 0.75;
  else if (q === 'performance') factor = 0.5;
  return Math.max(16, Math.min(128, Math.round(canonicalFrequency(radiusKm) * factor)));
}

function profileFromControls(): GeographyProfileInput {
  const radiusKm = Math.max(300, Number(els.radius.value) || 5860);
  const seedRaw = els.seed.value.trim() || 'shakuras';
  const profile: GeographyProfileInput = {
    planetId: 'stage1-' + els.planet.value,
    presetId: els.planet.value,
    surfaceClass: (PLANET_PRESETS.find((p) => p.id === els.planet.value) || PLANET_PRESETS[0] as { surfaceClass: string }).surfaceClass,
    radiusKm,
    geographyVersion: 'c100-soft-v2',
  };
  if (/^[0-9a-fA-F]{16}$/.test(seedRaw)) profile.masterSeedHex = seedRaw.toLowerCase();
  else profile.seedText = seedRaw;
  return profile;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  workerToken = 'stage1-' + (++workerSeq) + '-' + Date.now();
  worker = new Worker('../planet-globe/planet-globe-worker.js');
  worker.onmessage = onWorkerMessage;
  worker.onerror = function (event: ErrorEvent): void {
    setStatus('Ошибка воркера: ' + (event.message || 'неизвестная ошибка'), 'error');
  };
  return worker;
}

function onWorkerMessage(event: MessageEvent): void {
  const msg = (event.data || {}) as WorkerResponse;
  if (msg.token && msg.token !== workerToken) return;
  if (msg.type === 'progress') {
    if (msg.requestId !== activeRequestId) return;
    setStatus(msg.label || msg.stage || 'Генерация…', 'info');
    return;
  }
  if (msg.type === 'ready') {
    if (msg.requestId !== activeRequestId) return;
    displayedSummary = msg.summary;
    fxState.reliefScale = msg.geometry.reliefScale || 1;
    fxState.geometry = msg.geometry;
    if (globe) globe.setGeometry(msg.geometry as unknown as GlobeGeometry);
    renderSummary(msg.summary);
    els.cellInfo.textContent = 'ячейка не выбрана — кликните по глобусу';
    setStatus('Готово: ' + msg.summary.planetId + ', v=' + msg.summary.renderV + '. Управляйте разлётом и палитрами справа.', 'ok');
    return;
  }
  if (msg.type === 'pick-result') {
    if (msg.requestId !== latestPickRequest) return;
    renderPickedCell(msg.info);
    if (globe) {
      if (msg.info && msg.info.polygon) globe.setSelection(msg.info.polygon as CellPolygon);
      else globe.clearSelection();
    }
    return;
  }
  if (msg.type === 'error') {
    if (msg.requestId !== activeRequestId && msg.requestId !== latestPickRequest) return;
    if (msg.requestId === latestPickRequest) {
      els.cellInfo.textContent = 'ошибка pick: ' + (msg.message || 'не удалось выбрать ячейку');
      return;
    }
    setStatus('Ошибка: ' + (msg.message || msg.code || 'генерация не удалась'), 'error');
  }
}

function renderSummary(s: GlobeSummary): void {
  const lines = [
    s.planetId + ' · R=' + s.radiusKm + ' км · seed ' + s.masterSeedHex,
    'v=' + s.renderV + ' из канонических ' + s.canonicalV + ' · ячеек ' + s.cellCount + ' · треугольников ' + s.triangleCount,
    'время CPU: сетка ' + fmtMs(s.timingsMs.mesh) + ', поверхность ' + fmtMs(s.timingsMs.surface) + ', геометрия ' + fmtMs(s.timingsMs.geometry) + ', всего ' + fmtMs(s.timingsMs.total),
    'рельеф: reliefScale=' + fxState.reliefScale + ' (влияет на восстановление высоты в палитрах)',
    s.gridVersion + ' · ' + s.geographyVersion + ' · ' + s.surfaceVersion,
  ];
  els.stats.textContent = lines.join('\n');
}

function renderFrameHud(stats: GlobeStats): void {
  els.fps.textContent = stats.fps ? stats.fps.toFixed(0) : '—';
  els.frameP50.textContent = fmtFrameMs(stats.p50);
  els.frameP95.textContent = fmtFrameMs(stats.p95);
  els.frameP99.textContent = fmtFrameMs(stats.p99);
  els.frameOver50.textContent = String(stats.over50 || 0);
  els.frameOver100.textContent = String(stats.over100 || 0);
  const worst = stats.worst5 || [];
  els.frameWorst.textContent = worst.length
    ? worst.map(function (v) { return v.toFixed(1); }).join('/')
    : '—';
  if (displayedSummary) els.stats.dataset.fps = String(stats.fps);
}

function renderPickedCell(info: GlobePickInfo | null): void {
  if (!info) {
    els.cellInfo.textContent = 'мимо планеты';
    return;
  }
  const biome = info.biome && info.biome.top1Key ? info.biome.top1Key : '—';
  els.cellInfo.textContent =
    'ячейка #' + info.cell +
    ' · ' + info.address +
    ' · ' + info.latitudeDeg.toFixed(2) + '°, ' + info.longitudeDeg.toFixed(2) + '°' +
    ' · высота ' + info.elevation.toFixed(3) +
    ' · биом ' + biome;
}

function sendPick(direction: number[]): void {
  if (!worker || !workerToken || !displayedSummary) return;
  const id = ++requestSeq;
  latestPickRequest = id;
  const post: PickMessage = {
    type: 'pick',
    token: workerToken,
    requestId: id,
    purpose: 'select',
    direction: direction,
  };
  worker.postMessage(post);
}

function generate(): void {
  ensureWorker();
  const radiusKm = Math.max(300, Number(els.radius.value) || 5860);
  const id = ++requestSeq;
  activeRequestId = id;
  const post: GenerateMessage = {
    type: 'generate',
    token: workerToken,
    requestId: id,
    profile: profileFromControls(),
    renderV: targetRenderV(radiusKm),
    colorMode: 'biome',
    reliefScale: 1,
    fallbackPreview: false,
  };
  (worker as Worker).postMessage(post);
  setStatus('Генерация планеты на боевом ядре…', 'info');
}

function applySeparationVisuals(): void {
  const visuals = separationVisuals(fxState.separation, fxState.shardMode, 0);
  if (globe) globe.setAtmosphereEnabled(visuals.atmoFade > 0.2);
}

function setSeparation(value: number): void {
  fxState.separation = Math.max(0, Math.min(2.5, value));
  els.sepRange.value = String(fxState.separation);
  els.sepOut.textContent = fxState.separation.toFixed(2);
  applySeparationVisuals();
}

function stopBoomAnimation(): void {
  if (boomAnimation) {
    boomAnimation.cancel();
    boomAnimation = null;
  }
}

function toggleBoom(): void {
  stopBoomAnimation();
  // Взрыв/сброс двигает ТОЛЬКО uSep — геометрия не пересобирается (мини-спайк).
  const exploding = fxState.separation < 1.0;
  boomAnimation = animateShardSeparation({
    fromSep: fxState.separation,
    toSep: exploding ? 2.1 : 0.3,
    reset: !exploding,
    onFrame: (sep) => setSeparation(sep),
    onDone: () => { boomAnimation = null; },
  });
  els.boomBtn.textContent = exploding ? '↩ Собрать' : '💥 Взрыв';
  if (performance.mark) performance.mark('planet: explosion animation');
}

function applyTheme(): void {
  els.palette.value = String(fxState.theme.palette);
  els.texMode.value = String(fxState.theme.textureMode);
  els.texAmount.value = String(fxState.theme.textureAmount);
  els.texScale.value = String(fxState.theme.textureScale);
  els.hue.value = String(fxState.theme.hueShiftDeg);
}

function fillSelects(): void {
  for (const preset of PLANET_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    els.planet.appendChild(option);
  }
  for (const palette of FX_PALETTES) {
    const option = document.createElement('option');
    option.value = String(palette.id);
    option.textContent = palette.label;
    els.palette.appendChild(option);
  }
  for (const mode of FX_TEXTURE_MODES) {
    const option = document.createElement('option');
    option.value = String(mode.id);
    option.textContent = mode.label;
    els.texMode.appendChild(option);
  }
}

function setPanelCollapsed(collapsed: boolean, persist: boolean): void {
  els.panel.classList.toggle('collapsed', collapsed);
  els.panelToggle.setAttribute('aria-expanded', String(!collapsed));
  els.panelToggle.textContent = collapsed ? '+' : '−';
  const label = collapsed ? 'Развернуть панель параметров' : 'Свернуть панель параметров';
  els.panelToggle.title = label;
  els.panelToggle.setAttribute('aria-label', label);
  if (persist) {
    try { localStorage.setItem('planetTestPanelCollapsed', collapsed ? '1' : '0'); }
    catch (_) { /* хранение состояния необязательно */ }
  }
}

function toggleSpin(): void {
  autoRotate = !autoRotate;
  els.spinBtn.setAttribute('aria-pressed', String(autoRotate));
  if (globe) globe.setAutoRotate(autoRotate);
}

function syncShardOutputs(): void {
  els.shardThickV.textContent = Number(els.shardThick.value).toFixed(2);
  els.shardJagV.textContent = Number(els.shardJag.value).toFixed(2);
  els.shardLossV.textContent = Number(els.shardLoss.value).toFixed(2);
  els.coreScaleV.textContent = Number(els.coreScale.value).toFixed(2);
}

function applyShardLayoutPreview(): void {
  const dist = els.shardDist.value as ShardDist;
  fxState.shardDist = dist;
  fxState.shardThick = Number(els.shardThick.value) || 0.14;
  fxState.shardJag = Number(els.shardJag.value) || 0;
  fxState.shardLoss = Number(els.shardLoss.value) || 0;
  fxState.coreScale = Number(els.coreScale.value) || 0.55;
  const built = buildShardTextureData(buildProceduralShardLayout({
    count: fxState.shardCount, dist: dist, sep: 0,
    thick: fxState.shardThick, jag: fxState.shardJag, loss: fxState.shardLoss,
    seedText: fxState.seedText,
  }), 0);
  if (built.shardInfo) {
    els.shardCountOut.textContent = fxState.shardCount + ' (непустых ' + built.shardInfo.nonEmpty + ')';
  }
}

function playBuildAnimation(): void {
  const duration = Math.max(0.5, Number(els.buildSec.value) || 2.4);
  if (globe) globe.animateBuild(duration);
  els.buildProgress.value = '0';
  els.buildProgressV.textContent = '0.00';
}

function init(): void {
  fillSelects();
  applyTheme();
  setSeparation(fxState.separation);
  els.shardCountOut.textContent = String(fxState.shardCount);
  syncShardOutputs();
  els.buildSecV.textContent = Number(els.buildSec.value).toFixed(1) + ' с';
  els.buildProgressV.textContent = Number(els.buildProgress.value).toFixed(2);

  let savedPanelCollapsed = false;
  try { savedPanelCollapsed = localStorage.getItem('planetTestPanelCollapsed') === '1'; }
  catch (_) { /* приватный режим: панель останется открытой */ }
  setPanelCollapsed(savedPanelCollapsed, false);
  els.panelToggle.addEventListener('click', function () {
    setPanelCollapsed(!els.panel.classList.contains('collapsed'), true);
  });

  try {
    globe = PlanetGlobe.createPlanetGlobe(els.canvas, {
      autoRotate: true,
      borders: true,
      atmosphere: true,
      maxPixelRatio: isCoarseOrSmallScreen() ? 1.5 : 2,
      fx: createFxHooks(fxState),
      onStats: function (stats: GlobeStats): void {
        renderFrameHud(stats);
      },
      onPickDirection: function (direction: number[]): void {
        sendPick(direction);
      },
      onPickMiss: function (): void {
        els.cellInfo.textContent = 'мимо планеты';
        if (globe) globe.clearSelection();
      },
    });
  } catch (err) {
    console.error(err);
    globe = null;
  }
  if (!globe) {
    setStatus('WebGL2 недоступен: стенд FX-режимов требует WebGL2.', 'error');
    return;
  }

  els.generate.addEventListener('click', generate);
  els.planet.addEventListener('change', () => {
    const preset = PLANET_PRESETS.find((p) => p.id === els.planet.value);
    if (preset) {
      els.seed.value = preset.seed;
      els.radius.value = String(preset.radiusKm);
      fxState.seedText = preset.seed;
    }
  });
  els.seed.addEventListener('input', () => { fxState.seedText = els.seed.value.trim() || 'shakuras'; });

  // Взрыв осколков Шакураса (uSep).
  els.boomBtn.addEventListener('click', toggleBoom);
  els.sepRange.addEventListener('input', () => {
    // Ручной ползунок, как и в спайке, останавливает анимацию взрыва.
    stopBoomAnimation();
    els.boomBtn.textContent = '💥 Взрыв';
    setSeparation(Number(els.sepRange.value));
  });
  els.shardMode.addEventListener('change', () => {
    fxState.shardMode = els.shardMode.checked;
    applySeparationVisuals();
  });
  els.shardCount.addEventListener('input', () => {
    fxState.shardCount = Math.max(2, Math.min(32, Number(els.shardCount.value) || 12));
    els.shardCountOut.textContent = String(fxState.shardCount);
    applyShardLayoutPreview();
  });
  els.shardDist.addEventListener('change', applyShardLayoutPreview);
  els.shardThick.addEventListener('input', () => { syncShardOutputs(); applyShardLayoutPreview(); });
  els.shardJag.addEventListener('input', () => { syncShardOutputs(); applyShardLayoutPreview(); });
  els.shardLoss.addEventListener('input', () => { syncShardOutputs(); applyShardLayoutPreview(); });
  els.coreScale.addEventListener('input', () => {
    syncShardOutputs();
    fxState.coreScale = Number(els.coreScale.value) || 0.55;
  });

  // Каскадная сборка.
  els.buildSec.addEventListener('input', () => {
    els.buildSecV.textContent = Number(els.buildSec.value).toFixed(1) + ' с';
  });
  els.buildProgress.addEventListener('input', () => {
    const value = Math.max(0, Math.min(1, Number(els.buildProgress.value) || 0));
    els.buildProgressV.textContent = value.toFixed(2);
    if (globe) globe.setBuildProgress(value);
  });
  els.buildBtn.addEventListener('click', playBuildAnimation);
  els.buildAnimBtn.addEventListener('click', playBuildAnimation);

  // Вращение и границы ячеек.
  els.spinBtn.addEventListener('click', toggleSpin);
  els.bordersBtn.addEventListener('click', () => {
    bordersEnabled = !bordersEnabled;
    els.bordersBtn.setAttribute('aria-pressed', String(bordersEnabled));
    if (globe) globe.setBordersEnabled(bordersEnabled);
  });
  document.addEventListener('keydown', function (e: KeyboardEvent): void {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target as HTMLElement | null;
    const tag = t && t.tagName;
    const input = t as HTMLInputElement | null;
    const textInput = tag === 'INPUT' && /^(text|search|number|password|email|url|tel)$/.test((input && input.type) || 'text');
    if (textInput || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    e.preventDefault();
    toggleSpin();
  });

  // Диагностические палитры и фактуры.
  els.palette.addEventListener('change', () => {
    fxState.theme = { ...fxState.theme, palette: Number(els.palette.value) as FxPaletteId };
  });
  els.texMode.addEventListener('change', () => {
    fxState.theme = { ...fxState.theme, textureMode: Number(els.texMode.value) as FxTextureMode };
  });
  els.texAmount.addEventListener('input', () => {
    fxState.theme = { ...fxState.theme, textureAmount: Number(els.texAmount.value) };
  });
  els.texScale.addEventListener('input', () => {
    fxState.theme = { ...fxState.theme, textureScale: Number(els.texScale.value) };
  });
  els.hue.addEventListener('input', () => {
    fxState.theme = { ...fxState.theme, hueShiftDeg: Number(els.hue.value) };
  });
  els.themeBtn.addEventListener('click', () => {
    fxState.theme = randomFxTheme(els.seed.value.trim() || 'shakuras');
    applyTheme();
  });

  generate();
}

if (typeof document !== 'undefined') {
  init();
}
