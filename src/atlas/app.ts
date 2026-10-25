/*!
 * Map Atlas — точка входа интерфейса атласа.
 * Статика без зависимостей: процедурное поле сектора (WebGL2 + CPU-фолбэк),
 * маркеры систем, поиск, каталог, досье и слой подписей карты.
 *
 * Данные: /data/meta.json, /data/systems.json, /data/planets.json,
 *         /data/system-overrides.json, /data/map-labels.json.
 * Пути от корня сайта: страницы лежат в site/<страница>/, общий код — в
 * site/shared/. До загрузки данных и при недоступности поля рисуется схема.
 */

import {
  CONFIG,
  cssVar,
  escapeHtml,
  qs,
  readJSON,
  resolveFieldStyle,
  writeJSON,
} from './config.ts';
import type {
  AtlasElements,
  AtlasKernel,
  AtlasRuntime,
  AtlasSkin,
  AtlasState,
  AtlasTheme,
} from './config.ts';
import { createCanvasRenderer } from './canvas-renderer.ts';
import { createCatalogPanel } from './catalog-panel.ts';
import { createCoordsReadout } from './coords-readout.ts';
import { createDataLoader } from './data-loader.ts';
import { createDossierCard } from './dossier-card.ts';
import { createSectorField } from './sector-field.ts';

const doc = document;

const state: AtlasState = {
  meta: null,
  systemsRaw: [], // базовый каталог систем
  systems: [], // разрешённые системы (база + оверрайды из data/system-overrides.json)
  planets: [],
  labels: [],
  overrides: null,
  systemsById: {},
  planetsById: {},
  planetByName: {},
  factionsByPlanet: {},
  order: { systems: [], planets: [] },
  tab: 'systems',
  catalogView: 'systems',
  query: '',
  listFactions: [],
  activeFactions: [],
  activeTypes: [],
  mapFaction: 'all',
  sortByCount: false,
  labelsOn: readJSON<boolean>(CONFIG.storage.labels, false) === true,
  hoverId: null,
  hoverPoiId: null,
  activeSystemId: null,
  activePlanetId: null,
  pinned: false,
  view: { scale: 1, tx: 0, ty: 0 },
  viewport: { w: 1, h: 1 },
  dpr: 1,
  travel: {
    enabled: false,
    freePointMode: false,
    ids: [],
    customPoints: {},
    nextFreePointId: 1,
    speedText: '100',
    returnEnabled: false,
    departureLocal: '',
    animationPreference: null,
    calculation: null,
    infoId: null,
    catalogWasOpen: false,
  },
};

const theme: AtlasTheme = {
  bg: cssVar('--bg', '#05080e'),
  accent: cssVar('--accent', '#b5d3fa'),
  accent2: cssVar('--accent-2', '#80a9da'),
  text: cssVar('--white', '#f5f8fc'),
  muted: cssVar('--muted', '#8996a8'),
  line: cssVar('--line-strong', 'rgba(172,194,221,.28)'),
  mono: cssVar('--mono', 'Consolas, monospace'),
};

const el = {} as AtlasElements;
const skin: AtlasSkin = {
  panelOffCanvas: false,
  panelBottomSheet: false,
  panelSidebar: false,
  panelOpen: false,
};
const runtime: AtlasRuntime = {
  renderQueued: false,
  toastTimer: null,
  loaderDismissed: false,
  fieldContextLost: false,
  coordinateReadoutEnabled: false,
  coordinatePointer: null,
  travelCore: window.TravelPlanner || null,
};

// Фабрики только определяют функции на общем kernel-объекте и ничего не
// вызывают при создании, поэтому сервисы можно безопасно собрать по очереди.
const kernel = {
  doc,
  state,
  theme,
  el,
  skin,
  runtime,
  canvas: null,
  ctx: null,
  fieldCanvas: null,
  field: null,
} as unknown as AtlasKernel;

kernel.data = createDataLoader(kernel);
kernel.renderer = createCanvasRenderer(kernel);
kernel.catalog = createCatalogPanel(kernel);
kernel.dossier = createDossierCard(kernel);
kernel.coords = createCoordsReadout(kernel);
kernel.app = { toast, layoutMapControls, resize, dismissTimelineLoader };

/* ------------------------------------------------------------------ загрузочный экран */

// Экран загрузки уходит сразу, как страница готова: искусственной паузы нет.
// Вызывается после первой отрисовки canvas (см. boot) и по таймауту-страховке.
function dismissTimelineLoader(): void {
  if (runtime.loaderDismissed) return;
  const loader = doc.getElementById('timelineLoader');
  if (!loader) {
    runtime.loaderDismissed = true;
    return;
  }
  runtime.loaderDismissed = true;
  loader.classList.add('is-leaving');
  window.setTimeout(function (): void {
    loader.classList.add('is-hidden');
    loader.setAttribute('aria-hidden', 'true');
  }, 480);
}

/* ------------------------------------------------------------------ модальные окна */

function openModal(node: HTMLElement): void { node.hidden = false; }
function closeModal(node: HTMLElement): void { node.hidden = true; }

// Старые демонстрационные Wiki-модали удалены вместе с их навигацией.

/* ------------------------------------------------------------------ уведомления и мелочи */

function toast(message: string): void {
  el.toast.textContent = message;
  el.toast.classList.add('visible');
  if (runtime.toastTimer !== null) window.clearTimeout(runtime.toastTimer);
  runtime.toastTimer = window.setTimeout(function (): void {
    el.toast.classList.remove('visible');
  }, 2600);
}

function applyLabelsToggle(): void {
  const label = state.labelsOn ? 'Скрыть подписи карты' : 'Показать подписи карты';
  el.labelsToggle.setAttribute('aria-pressed', String(state.labelsOn));
  el.labelsToggle.setAttribute('title', label);
  el.labelsToggle.setAttribute('aria-label', label);
  writeJSON(CONFIG.storage.labels, state.labelsOn);
  kernel.renderer.requestRender();
}

function layoutMapControls(): void {
  // досье шире, чем остальные элементы: сдвигаем кнопки масштаба влево,
  // иначе панель их перекрывает (так задумано в CSS обеих тем)
  const node = qs('.map-controls');
  if (!node) return;
  let offset = 0;
  const narrowTravelLayout = window.matchMedia && window.matchMedia('(max-width: 599px)').matches;
  if (state.travel.enabled && !narrowTravelLayout) offset = 382;
  if (!state.travel.enabled && !el.detailPanel.hidden) {
    const stage = el.mapStage.getBoundingClientRect();
    const panel = el.detailPanel.getBoundingClientRect();
    if (stage.right - panel.left < stage.width * 0.9) {
      offset = Math.max(0, Math.round(stage.right - panel.left) + 6);
    }
  }
  node.style.right = (14 + offset) + 'px';
}

function resize(): void {
  kernel.catalog.updateSearchHintDistance();
  const rect = el.mapStage.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  layoutMapControls();
  if (w === state.viewport.w && h === state.viewport.h && dpr === state.dpr) return;

  // Точка мира, которая была в центре экрана, остаётся в центре: при любом
  // изменении размера (окно, панель, клавиатура телефона) карта не «уезжает».
  let keep = null;
  if (state.viewport.w > 1 && state.viewport.h > 1 && state.view.scale > 0) {
    keep = kernel.renderer.toWorld(state.viewport.w / 2, state.viewport.h / 2);
  }

  state.viewport.w = w;
  state.viewport.h = h;
  state.dpr = dpr;
  const canvas = kernel.canvas!;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  if (keep) {
    state.view.tx = w / 2 - keep.x * state.view.scale;
    state.view.ty = h / 2 - keep.y * state.view.scale;
  }
  kernel.renderer.clampView();
  kernel.renderer.requestRender();
}

/* ------------------------------------------------------------------ привязка интерфейса */

function cacheElements(): void {
  const ids = [
    'searchInput', 'clearSearch', 'suggestions', 'searchWrap', 'searchHintViewport', 'searchHintTrack', 'mapFactionFilter', 'mapStage', 'mapCanvas',
    'leftPanel', 'closePanel', 'toggleSidePanel', 'filters', 'filterResultCount', 'filterIndicator',
    'catalogSectionDropdown', 'catalogSectionSummary', 'catalogSectionSummaryCount',
    'catalogListDropdown', 'listCaption', 'sortButton', 'catalogList', 'detailPanel',
    'detailType', 'detailContent', 'detailFooter', 'pinButton', 'closeDetail',
    'helpButton', 'closeHelp', 'helpModal', 'zoomIn', 'zoomOut', 'resetMap', 'zoomPercent', 'labelsToggle',
    'coordinateToggle', 'mapCoordinateReadout', 'toast', 'travelPanel', 'travelModeToggle', 'travelFreePointToggle',
    'travelTapeTop', 'travelTapeBottom', 'travelClose', 'travelCount', 'travelSpeed',
    'travelSpeedError', 'travelDeparture', 'travelReturn', 'travelAnimate', 'travelMotionNote',
    'travelStops', 'travelRouteHint', 'travelEmpty', 'travelSummary', 'travelLogPreview',
    'travelCopy', 'travelClear',
  ] as const;
  const byId = el as unknown as Record<string, HTMLElement | null>;
  ids.forEach(function (id): void {
    byId[id] = doc.getElementById(id);
  });
  el.legacyControls = qs('.legacy-controls');
  kernel.canvas = el.mapCanvas;
  kernel.ctx = kernel.canvas.getContext('2d');
}

function bindEvents(): void {
  // карта
  kernel.renderer.bindMapEvents();

  // управление
  el.zoomIn.addEventListener('click', function (): void {
    kernel.renderer.zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1.45);
  });
  el.zoomOut.addEventListener('click', function (): void {
    kernel.renderer.zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1 / 1.45);
  });
  el.resetMap.addEventListener('click', function (): void {
    kernel.coords.cancelPendingTravelTap();
    kernel.renderer.cancelAnimation();
    kernel.renderer.fitView();
    kernel.renderer.requestRender();
  });
  el.labelsToggle.addEventListener('click', function (): void {
    state.labelsOn = !state.labelsOn;
    applyLabelsToggle();
    toast(state.labelsOn ? 'Подписи карты включены' : 'Подписи карты скрыты');
  });

  kernel.coords.bind();
  kernel.catalog.bind();
  kernel.dossier.bind();

  // шапка и модальные окна
  el.helpButton.addEventListener('click', function (): void { openModal(el.helpModal); });
  el.closeHelp.addEventListener('click', function (): void { closeModal(el.helpModal); });
  el.helpModal.addEventListener('click', function (event): void {
    if (event.target === el.helpModal) closeModal(el.helpModal);
  });
  doc.querySelectorAll<HTMLElement>('.modal-backdrop').forEach(function (backdrop): void {
    backdrop.addEventListener('click', function (event): void {
      if (event.target === backdrop) closeModal(backdrop);
    });
  });

  // карта: фильтр по фракции
  el.mapFactionFilter.addEventListener('change', function (): void {
    state.mapFaction = el.mapFactionFilter.value;
    kernel.renderer.requestRender();
    const shownSystems = kernel.renderer.visibleSystems().length;
    const shownPois = kernel.renderer.visiblePointsOfInterest().length;
    toast('На карте: ' + shownSystems + ' систем · ' + shownPois + ' точек интереса');
  });

  // Старые демонстрационные разделы Wiki удалены: каталог теперь сам является навигацией.

  // клавиатура
  doc.addEventListener('keydown', function (event): void {
    const tag = ((event.target as Element | null)?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (event.key === 'Escape') {
      if (!el.helpModal.hidden) { closeModal(el.helpModal); return; }
      kernel.dossier.clearDetail();
      return;
    }
    if (event.key === '/' || event.key === '?') { event.preventDefault(); el.searchInput.focus(); return; }
    if (event.key === '+' || event.key === '=') {
      kernel.renderer.zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1.35);
      return;
    }
    if (event.key === '-' || event.key === '_') {
      kernel.renderer.zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1 / 1.35);
      return;
    }
    if (event.key === '0') {
      kernel.coords.cancelPendingTravelTap();
      kernel.renderer.fitView();
      kernel.renderer.requestRender();
      return;
    }
    if (event.key === 'l' || event.key === 'д') {
      state.labelsOn = !state.labelsOn;
      applyLabelsToggle();
      return;
    }
    const pan = 60;
    if (event.key === 'ArrowLeft') { state.view.tx += pan; kernel.renderer.clampView(); kernel.renderer.requestRender(); }
    if (event.key === 'ArrowRight') { state.view.tx -= pan; kernel.renderer.clampView(); kernel.renderer.requestRender(); }
    if (event.key === 'ArrowUp') { state.view.ty += pan; kernel.renderer.clampView(); kernel.renderer.requestRender(); }
    if (event.key === 'ArrowDown') { state.view.ty -= pan; kernel.renderer.clampView(); kernel.renderer.requestRender(); }
  });

  window.addEventListener('hashchange', kernel.dossier.applyHash);
  window.addEventListener('resize', resize);

  if (window.ResizeObserver) {
    const layoutObserver = new ResizeObserver(resize);
    layoutObserver.observe(el.mapStage);
    if (el.searchHintViewport) layoutObserver.observe(el.searchHintViewport);
  }
}

/* ------------------------------------------------------------------ запуск */

function initUI(): void {
  // в базовом и вики-скине управление подсказками и панелью лежит в скрытом блоке: показываем его
  if (el.legacyControls && window.innerWidth >= 700) el.legacyControls.hidden = false;
  applyLabelsToggle();

  const factions: Record<string, number> = {};
  state.systems.forEach(function (system): void {
    kernel.data.systemFactions(system).forEach(function (faction): void {
      factions[faction] = (factions[faction] || 0) + 1;
    });
  });
  let poiCount = 0;
  kernel.renderer.visiblePointsOfInterest().forEach(function (place): void {
    poiCount++;
    kernel.data.factionsOf(place).forEach(function (faction): void {
      factions[faction] = (factions[faction] || 0) + 1;
    });
  });
  const options = Object.keys(factions).sort(function (a, b): number {
    if (factions[b]! !== factions[a]!) return factions[b]! - factions[a]!;
    return a.localeCompare(b, 'ru');
  }).map(function (faction): string {
    return '<option value="' + escapeHtml(faction) + '">' + escapeHtml(faction) + ' · ' + factions[faction] + '</option>';
  }).join('');
  el.mapFactionFilter.innerHTML = '<option value="all">Все фракции · ' + (state.systems.length + poiCount) + '</option>' + options;
}

function boot(): void {
  cacheElements();
  kernel.catalog.updateSearchHintDistance();
  // Страховка: экран аутентификации не должен зависнуть даже при сетевой ошибке.
  window.setTimeout(dismissTimelineLoader, 8000);

  if (!kernel.ctx) {
    doc.body.insertAdjacentHTML('beforeend', '<div class="data-error">Браузер не поддерживает canvas — карта недоступна.</div>');
    dismissTimelineLoader();
    return;
  }

  // Поле живёт на собственном offscreen-канвасе: потеря WebGL-контекста на нём
  // не повреждает 2D-контекст основного #mapCanvas.
  const fieldCanvas = doc.createElement('canvas');
  const field = createSectorField(fieldCanvas, { style: resolveFieldStyle() });
  const onFieldContextLost = function (): void {
    runtime.fieldContextLost = true;
    kernel.renderer.requestRender();
  };
  const onFieldContextRestored = function (): void {
    runtime.fieldContextLost = false;
    kernel.renderer.requestRender();
  };
  fieldCanvas.addEventListener('webglcontextlost', onFieldContextLost);
  fieldCanvas.addEventListener('webglcontextrestored', onFieldContextRestored);
  kernel.fieldCanvas = fieldCanvas;
  kernel.field = field;

  const disposeField = function (): void {
    fieldCanvas.removeEventListener('webglcontextlost', onFieldContextLost);
    fieldCanvas.removeEventListener('webglcontextrestored', onFieldContextRestored);
    if (!kernel.field) return;
    kernel.field.dispose();
    kernel.field = null;
    kernel.fieldCanvas = null;
  };
  window.addEventListener('pagehide', disposeField);
  window.addEventListener('beforeunload', disposeField);

  kernel.catalog.detectSkin();
  bindEvents();

  kernel.data.loadDataset().then(function (data): void {
    state.meta = data.meta || {};
    state.systemsRaw = data.systems || [];
    state.planets = data.planets || [];
    state.overrides = data.overrides || { systems: {} };
    state.labels = data.labels || [];

    kernel.data.buildModel();
    kernel.coords.initializeTravelPlanner();
    resize();
    kernel.renderer.fitView();
    initUI();
    kernel.catalog.renderFilters();
    kernel.catalog.renderCatalog();

    kernel.dossier.applyHash();
    kernel.coords.updateZoomReadout();
    kernel.renderer.requestRender();
    // Два кадра дают canvas отрисоваться под лоад-скрином без белого всплеска.
    window.requestAnimationFrame(function (): void {
      window.requestAnimationFrame(dismissTimelineLoader);
    });

    if (!state.systems.length) {
      doc.body.insertAdjacentHTML('beforeend',
        '<div class="data-error">Не удалось прочитать <code>/data/systems.json</code>. ' +
        'Откройте сайт через HTTP-сервер (не <code>file://</code>): например <code>python3 -m http.server 8080</code>.</div>');
    }
  });
}

if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
else boot();
