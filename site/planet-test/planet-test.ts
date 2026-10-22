/* Стенд /planet-test/ на общем боевом ядре (CR-01 PR 5, И-5.3/И-6).
   -------------------------------------------------------------------------
   Раньше здесь жил трёхтысячный монолит planet-test.js со своим воркером и
   своим GL. Теперь стенд — тонкая обёртка вокруг боевого ядра:
     - рендер и генерация: site/shared/planet-globe.ts + planet-globe-worker.ts
       (те же протокол, геометрия 24 байта/вершину и поля c100-soft-v2, что
       и на /planet-globe/);
     - уникальные экспериментальные режимы: src/planet/planet-globe-fx.ts
       (взрыв осколков Шакураса uSep и шейдерные диагностические палитры).
   Дублирующие planet-test.js и planet-worker.js удалены (И-5). */

import PlanetGlobe from '../shared/planet-globe.ts';
import type { GlobeGeometry, GlobeStats, PlanetGlobeHandle } from '../shared/planet-globe.ts';
import type { GeographyProfileInput } from '../shared/planet-geography.ts';
import type {
  GenerateMessage,
  GlobeSummary,
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
import type { FxPaletteId, FxRuntimeState, FxTextureMode, SeparationAnimationHandle } from '../../src/planet/planet-globe-fx.ts';

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
  palette: must<HTMLSelectElement>('paletteSel'),
  texMode: must<HTMLSelectElement>('texModeSel'),
  texAmount: must<HTMLInputElement>('texAmountRange'),
  texScale: must<HTMLInputElement>('texScaleRange'),
  hue: must<HTMLInputElement>('hueRange'),
  themeBtn: must<HTMLButtonElement>('themeBtn'),
};

const PLANET_PRESETS: {
  id: string; label: string; radiusKm: number; surfaceClass: string; seed: string;
}[] = [
    { id: 'shakuras', label: 'Шакурас · осколки', radiusKm: 5860, surfaceClass: 'temperate terrestrial', seed: 'shakuras' },
    { id: 'korhal-iv', label: 'Корхал-IV · пустыня', radiusKm: 6521, surfaceClass: 'arid terrestrial', seed: 'korhal-iv' },
    { id: 'aiur', label: 'Айур · джунгли', radiusKm: 7094, surfaceClass: 'living terrestrial', seed: 'aiur' },
  ];

/* Состояние FX-плагина: его читают шейдерные хуки в каждом кадре. */
const fxState: FxRuntimeState = {
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
};

let globe: PlanetGlobeHandle | null = null;
let worker: Worker | null = null;
let workerToken = '';
let workerSeq = 0;
let requestSeq = 0;
let activeRequestId = 0;
let displayedSummary: GlobeSummary | null = null;
let boomAnimation: SeparationAnimationHandle | null = null;

function setStatus(text: string, kind: string): void {
  els.status.textContent = text || '';
  if (els.status.dataset) els.status.dataset.kind = kind || '';
}

function fmtMs(x: unknown): string {
  const n = Number(x) || 0;
  return n.toLocaleString('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 1 }) + ' мс';
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
    if (globe) globe.setGeometry(msg.geometry as unknown as GlobeGeometry);
    renderSummary(msg.summary);
    setStatus('Готово: ' + msg.summary.planetId + ', v=' + msg.summary.renderV + '. Управляйте разлётом и палитрами справа.', 'ok');
    return;
  }
  if (msg.type === 'error') {
    if (msg.requestId !== activeRequestId) return;
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

function init(): void {
  fillSelects();
  applyTheme();
  setSeparation(fxState.separation);
  els.shardCountOut.textContent = String(fxState.shardCount);

  try {
    globe = PlanetGlobe.createPlanetGlobe(els.canvas, {
      autoRotate: true,
      borders: true,
      atmosphere: true,
      maxPixelRatio: isCoarseOrSmallScreen() ? 1.5 : 2,
      fx: createFxHooks(fxState),
      onStats: function (stats: GlobeStats): void {
        if (displayedSummary) {
          els.stats.dataset.fps = String(stats.fps);
        }
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
    // Демонстрация канонического CPU-пути осколков (64×4 RGBA32F-строки).
    const built = buildShardTextureData(buildProceduralShardLayout({
      count: fxState.shardCount, dist: 'power', sep: 0, thick: 0.14, jag: 0.5, loss: 0,
      seedText: fxState.seedText,
    }), 0);
    if (built.shardInfo) {
      els.shardCountOut.textContent = fxState.shardCount + ' (непустых ' + built.shardInfo.nonEmpty + ')';
    }
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
