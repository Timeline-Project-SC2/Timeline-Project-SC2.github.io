/* Map Atlas — readout координат X/Y, Shift+Click и маршрутный readout.
 *
 * Маршрутный планировщик находится здесь, потому что его панель — тот же
 * координатный readout: остановки, расстояния, время и текстовый лог целиком
 * выводятся из координат карты, а чистая математика остаётся в TravelPlanner.
 */

import {
  CONFIG,
  clamp,
  escapeHtml,
  formatNumber,
  normalize,
  readJSON,
} from './config.ts';
import type {
  AtlasKernel,
  AtlasTravelStop,
  CoordsReadoutApi,
  MapCoord,
  MapPoint,
  SystemRecord,
  TravelPointRecord,
} from './config.ts';
import { edgeDistance } from './level-ladder.ts';
import { centerOf, formatAddress, parseAddress } from './sector-address.ts';
import { formatDistanceLy } from './sector-units.ts';
import { openPointCard } from './dossier-card.ts';

/** Кадр, восстановленный из ссылки `?at=<адрес>&lw=<видимая ширина>`. */
export interface MapLinkTarget {
  readonly address: string;
  readonly x: number;
  readonly y: number;
  readonly lw: number | null;
}

/** Разбирает `?at=<адрес>&lw=<ширина>` (§7.7). Обратный адрес — только через `sector-address.ts`. */
export function parseMapLink(search?: string): MapLinkTarget | null {
  var raw: string;
  try {
    raw = search === undefined ? window.location.search : search;
  } catch (err) {
    return null;
  }
  var params: URLSearchParams;
  try {
    params = new URLSearchParams(raw || '');
  } catch (err) {
    return null;
  }
  var at = params.get('at');
  if (!at) return null;
  var parsed = parseAddress(at);
  if (!parsed) return null;
  var center = centerOf(parsed);
  var lwRaw = params.get('lw');
  var lw = lwRaw === null ? null : Number(lwRaw.replace(',', '.'));
  if (lw !== null && !(Number.isFinite(lw) && lw > 0)) lw = null;
  return { address: formatAddress(parsed), x: center.x, y: center.y, lw: lw };
}

/** Админ-режим `?coords=1`: readout X/Y включён, `Shift+клик` копирует `x⇥y` без карточки (§7.8). */
export function isCoordinatesMode(search?: string): boolean {
  var raw: string;
  try {
    raw = search === undefined ? window.location.search : search;
  } catch (err) {
    return false;
  }
  try {
    return new URLSearchParams(raw || '').get('coords') === '1';
  } catch (err) {
    return false;
  }
}

/**
 * Видимая ширина кадра по горизонтали, св.г. — ровно `lw` из `?at=…&lw=`.
 *
 * Величина ширины кадра, а не короткая ось: при `lw = 39` кадр 1920×1080 обязан
 * быть 39 св.г. по ширине (высота при этом 21,94 св.г., потому что она в 1,78 раза
 * короче). Метрика глубины «до границы» считается отдельно — `edgeDistance`.
 */
export function visibleWidthOf(viewport: { readonly w: number; readonly h: number }, scale: number): number {
  if (!(scale > 0) || !(viewport.w > 0)) return 0;
  return viewport.w / scale;
}

/**
 * Масштаб, при котором ширина кадра равна `lw` св.г.
 *
 * Сверху масштаб клампит `centerOn()` рендерера (`[minScale, maxScale]`), поэтому
 * на `lw` меньше `2·w/min(w,h)` кадр упирается в предел и ширина выходит больше
 * заказанной. Ограничения здесь нет намеренно: одна граница — у рендерера.
 */
export function scaleForVisibleWidth(viewport: { readonly w: number; readonly h: number }, lw: number): number | null {
  if (!(lw > 0) || !(viewport.w > 0)) return null;
  return viewport.w / lw;
}

export interface ZoomReadoutText {
  readonly percent: string;
  readonly edge: string;
}

/**
 * Строки индикатора глубины: процент приближения и расстояние от цели в центре
 * кадра до ближайшей границы. Вторая строка намеренно не «ширина кадра»:
 * требование владельца (§17.15.1) задано метрикой `edgeDistance`.
 */
export function zoomReadoutText(
  viewport: { readonly w: number; readonly h: number },
  scale: number,
  fit: number,
): ZoomReadoutText | null {
  if (!(scale > 0) || !(fit > 0) || !(viewport.w > 0) || !(viewport.h > 0)) return null;
  return {
    percent: Math.round(scale / fit * 100) + '%',
    // Два знака: на пределе приближения строка обязана читаться как «1,00 св.г.».
    edge: formatDistanceLy(edgeDistance({ w: viewport.w, h: viewport.h }, scale), 'full') + ' до границы',
  };
}

interface StoredTravelState {
  version?: unknown;
  ids?: unknown;
  customPoints?: unknown;
  nextFreePointId?: unknown;
  enabled?: unknown;
  speed?: unknown;
  returnEnabled?: unknown;
  departureLocal?: unknown;
  animationPreference?: unknown;
}

interface PendingTravelTap {
  action: () => void;
  timer: number | null;
}

export function createCoordsReadout(kernel: AtlasKernel): CoordsReadoutApi {
  const doc = kernel.doc;
  const state = kernel.state;
  const el = kernel.el;
  const skin = kernel.skin;
  const runtime = kernel.runtime;
  const travelCore = kernel.runtime.travelCore;
  let travelSpeedTimer: number | null = null;
  let pendingTravelTapTimers: PendingTravelTap[] = [];
  let travelMotionQuery: MediaQueryList | null = null;
  let travelSmallQuery: MediaQueryList | null = null;
  let travelReducedMotion = false;
  let travelSmallScreen = false;

  function updateZoomReadout(): void {
    var text = zoomReadoutText(state.viewport, state.view.scale, kernel.renderer.fitScale());
    if (!text) return;
    el.zoomPercent.textContent = text.percent;
    var edgeNode = edgeDistanceNode();
    if (edgeNode) edgeNode.textContent = text.edge;
  }

  /**
   * Строка «1,00 св.г. до границы» под процентом зума.
   *
   * Узел создаётся здесь, а не в шаблоне: разметка `.zoom-readout` общая для всех
   * вариантов атласа, и правка шаблона задела бы чужие экраны. Вставка аддитивная
   * и повторяется ровно один раз.
   */
  function edgeDistanceNode(): HTMLElement | null {
    var percent = el.zoomPercent;
    if (!percent) return null;
    var existing = doc.getElementById('zoomEdgeDistance');
    if (existing) return existing;
    var container = percent.parentElement;
    if (!container) return null;
    var node = doc.createElement('span');
    node.id = 'zoomEdgeDistance';
    node.className = 'zoom-edge-distance';
    node.title = 'Расстояние от цели в центре кадра до ближайшей границы кадра';
    node.style.fontSize = '8px';
    node.style.lineHeight = '1.25';
    node.style.textAlign = 'center';
    node.style.opacity = '.72';
    container.appendChild(node);
    return node;
  }

  function updateCoordinateReadout(): void {
    if (!el.mapCoordinateReadout) return;
    var readout = el.mapCoordinateReadout;
    var point = runtime.coordinatePointer;
    if (!runtime.coordinateReadoutEnabled || !point || point.x < 0 || point.y < 0 ||
        point.x > state.viewport.w || point.y > state.viewport.h) {
      readout.hidden = true;
      readout.setAttribute('aria-hidden', 'true');
      return;
    }
    var world = kernel.renderer.toWorld(point.x, point.y);
    var size = kernel.data.mapSize();
    if (world.x < 0 || world.y < 0 || world.x > size || world.y > size) {
      readout.hidden = true;
      readout.setAttribute('aria-hidden', 'true');
      return;
    }
    readout.textContent = 'X ' + formatNumber(Math.round(world.x)) + ' · Y ' + formatNumber(Math.round(world.y));
    readout.hidden = false;
    readout.setAttribute('aria-hidden', 'false');
    // Справа от курсора: картинка курсора сайта (shared/cursor-fx.js) занимает до 32 px
    // вправо-вниз от острия, подсказка в точке +14/+14 оказалась бы под стрелкой.
    var left = point.x + 34;
    var top = point.y + 8;
    var width = readout.offsetWidth;
    var height = readout.offsetHeight;
    if (left + width > state.viewport.w - 6) left = point.x - width - 10;
    if (top + height > state.viewport.h - 6) top = point.y - height - 10;
    readout.style.left = clamp(left, 6, Math.max(6, state.viewport.w - width - 6)) + 'px';
    readout.style.top = clamp(top, 6, Math.max(6, state.viewport.h - height - 6)) + 'px';
  }

  function copyTextToClipboard(value: string, successMessage: string, failureMessage: string): void {
    function showCopied(): void { kernel.app.toast(successMessage); }

    function fallbackCopy(): void {
      var field = doc.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      field.style.pointerEvents = 'none';
      doc.body.appendChild(field);
      field.select();
      var copied = false;
      try { copied = doc.execCommand('copy'); } catch (err) { copied = false; }
      field.remove();
      if (copied) showCopied();
      else kernel.app.toast(failureMessage);
    }

    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(value).then(showCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function copyCoordinatesToClipboard(value: string, displayValue: string): void {
    copyTextToClipboard(value, 'Координаты скопированы: ' + displayValue,
      'Не удалось скопировать координаты');
  }

  function copyMapCoordinates(point: MapPoint): void {
    var world = kernel.renderer.toWorld(point.x, point.y);
    var size = kernel.data.mapSize();
    if (world.x < 0 || world.y < 0 || world.x > size || world.y > size) {
      kernel.app.toast('Shift+клик по самой карте');
      return;
    }
    if (isCoordinatesMode()) {
      var x = Math.round(world.x);
      var y = Math.round(world.y);
      // Табуляция разделяет значения на две соседние ячейки при вставке в таблицу.
      copyCoordinatesToClipboard(x + '\t' + y, x + ', ' + y);
      return;
    }
    // Обычный режим: Shift+клик открывает карточку точки (§7.8), а не молча копирует.
    // `point` — координаты внутри холста; карточка позиционируется как `fixed`,
    // поэтому ей нужны координаты окна, а не холста.
    var rect = el.mapCanvas ? el.mapCanvas.getBoundingClientRect() : { left: 0, top: 0 };
    openPointCard(kernel, {
      world: world,
      screen: { x: rect.left + point.x, y: rect.top + point.y }
    });
  }

  function travelSystemKey(system: SystemRecord | TravelPointRecord | null | undefined): string {
    if (!system) return '';
    if (system.isFreePoint) return 'free:' + String(system.id);
    if (system.id != null && String(system.id).trim()) return 'id:' + String(system.id);
    return 'name:' + normalize(system.name || '');
  }

  function travelEntityForId(id: string): SystemRecord | TravelPointRecord | null {
    return state.travel.customPoints[id] || state.systemsById[id] || null;
  }

  function pruneTravelCustomPoints(): void {
    Object.keys(state.travel.customPoints).forEach(function (id) {
      if (state.travel.ids.indexOf(id) === -1) delete state.travel.customPoints[id];
    });
  }

  function travelCoordinates(system: SystemRecord | TravelPointRecord | null | undefined): MapCoord | null {
    if (!system || system.coordSource !== 'map' || !Array.isArray(system.coord) || system.coord.length < 2) return null;
    var x = kernel.data.explicitMapNumber(system.coord[0]);
    var y = kernel.data.explicitMapNumber(system.coord[1]);
    var point = x !== null && y !== null ? { x: x, y: y } : null;
    return kernel.data.coordinateOnMap(point) ? [x!, y!] : null;
  }

  function travelStopForSystem(system: SystemRecord | TravelPointRecord | null | undefined): AtlasTravelStop | null {
    var coord = travelCoordinates(system);
    if (!system || !coord) return null;
    return { id: String(system.id), name: system.name, coord: coord, system: system };
  }

  function travelStops(): AtlasTravelStop[] {
    return state.travel.ids.map(function (id) {
      return travelStopForSystem(travelEntityForId(id));
    }).filter(function (stop): stop is AtlasTravelStop { return !!stop; });
  }

  function isValidTravelSequence(ids: string[]): boolean {
    if (ids.length > 50) return false;
    for (var i = 1; i < ids.length; i++) {
      var previous = travelEntityForId(ids[i - 1]!);
      var current = travelEntityForId(ids[i]!);
      if (previous && current && travelSystemKey(previous) === travelSystemKey(current)) return false;
    }
    return true;
  }

  function travelAnimationRequested(): boolean {
    if (state.travel.animationPreference !== null) return state.travel.animationPreference;
    return false;
  }

  function isTravelAnimationActive(): boolean {
    return !!(state.travel && state.travel.enabled && travelCore && !travelReducedMotion &&
      travelAnimationRequested() && state.travel.calculation && state.travel.calculation.legs.length);
  }

  function persistTravelState(): void {
    var stored = {
      version: 1,
      enabled: state.travel.enabled,
      ids: state.travel.ids.slice(0, 50),
      customPoints: state.travel.customPoints,
      nextFreePointId: state.travel.nextFreePointId,
      speed: state.travel.speedText,
      returnEnabled: state.travel.returnEnabled,
      departureLocal: state.travel.departureLocal,
      animationPreference: state.travel.animationPreference
    };
    try { window.localStorage.setItem(CONFIG.storage.travel, JSON.stringify(stored)); } catch (err) { /* private browsing / quota */ }
  }

  function restoreTravelState(): void {
    var stored = readJSON<StoredTravelState | null>(CONFIG.storage.travel, null);
    if (!stored || stored.version !== 1 || !Array.isArray(stored.ids)) return;
    var ids: string[] = [];
    var storedPoints = stored.customPoints && typeof stored.customPoints === 'object' ? stored.customPoints as Record<string, TravelPointRecord> : {};
    state.travel.customPoints = {};
    stored.ids.forEach(function (id) {
      var key = String(id);
      var entity: SystemRecord | TravelPointRecord | null | undefined = null;
      if (key.indexOf('__travel_free_point__:') === 0) {
        var savedPoint = storedPoints[key];
        var savedCoordinates = savedPoint && travelCoordinates({
          id: key, name: 'Произвольная точка', coord: savedPoint.coord, coordSource: 'map'
        });
        if (savedCoordinates) {
          entity = {
            id: key, name: 'Произвольная точка',
            coord: travelCore!.roundMapCoordinates(savedCoordinates),
            coordSource: 'map', isFreePoint: true
          };
          state.travel.customPoints[key] = entity;
        }
      } else {
        entity = state.systemsById[key];
      }
      if (!entity || !travelCoordinates(entity) || ids.length >= 50) return;
      var previous = ids.length ? travelEntityForId(ids[ids.length - 1]!) : null;
      if (previous && travelSystemKey(previous) === travelSystemKey(entity)) return;
      ids.push(key);
    });
    state.travel.ids = ids;
    pruneTravelCustomPoints();
    var storedNextId = Number(stored.nextFreePointId);
    state.travel.nextFreePointId = isFinite(storedNextId) && storedNextId > 0 ? Math.floor(storedNextId) : 1;
    state.travel.enabled = stored.enabled === true;
    state.travel.speedText = stored.speed == null ? '100' : String(stored.speed);
    state.travel.returnEnabled = stored.returnEnabled === true;
    state.travel.departureLocal = typeof stored.departureLocal === 'string' ? stored.departureLocal : '';
    state.travel.animationPreference = typeof stored.animationPreference === 'boolean'
      ? stored.animationPreference : null;
  }

  function loadTravelPreferences(): void {
    travelMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    travelSmallQuery = window.matchMedia ? window.matchMedia('(max-width: 599px), (pointer: coarse)') : null;
    travelReducedMotion = !!(travelMotionQuery && travelMotionQuery.matches);
    travelSmallScreen = !!(travelSmallQuery && travelSmallQuery.matches);
  }

  function syncTravelModeUi(): void {
    if (!el.travelPanel) return;
    el.travelPanel.hidden = !state.travel.enabled;
    el.travelTapeTop.hidden = !state.travel.enabled;
    el.travelTapeBottom.hidden = !state.travel.enabled || window.matchMedia('(max-width: 599px)').matches;
    el.travelModeToggle.setAttribute('aria-pressed', String(state.travel.enabled));
    el.travelModeToggle.setAttribute('aria-label', state.travel.enabled
      ? 'Выйти из режима расчётов' : 'Включить режим расчётов');
    el.travelModeToggle.title = state.travel.enabled ? 'Выйти из режима расчётов' : 'Режим расчётов путешествия';
    el.travelFreePointToggle.setAttribute('aria-pressed', String(state.travel.freePointMode));
    el.travelFreePointToggle.setAttribute('aria-label', state.travel.freePointMode
      ? 'Выйти из режима произвольных точек' : 'Включить постановку произвольных точек');
    el.travelFreePointToggle.title = state.travel.freePointMode
      ? 'Выйти из режима произвольных точек' : 'Произвольная точка: Shift+ЛКМ по пустому месту';
    el.mapStage.classList.toggle('travel-mode', state.travel.enabled);
    el.mapStage.classList.toggle('free-point-mode', state.travel.freePointMode);
    updateTravelCounter();
    syncTravelAnimationUi();
  }

  function syncTravelAnimationUi(): void {
    if (!el.travelAnimate) return;
    el.travelAnimate.checked = travelAnimationRequested() && !travelReducedMotion;
    el.travelAnimate.disabled = travelReducedMotion;
    el.mapStage.classList.toggle('travel-animated', travelAnimationRequested() && !travelReducedMotion);
    el.travelAnimate.setAttribute('aria-describedby', 'travelMotionNote');
    var note = el.travelMotionNote;
    if (note) {
      note.hidden = !travelReducedMotion;
      note.textContent = travelReducedMotion
        ? 'Отключена настройкой уменьшения движения в системе.'
        : 'Анимация включается вручную.';
    }
  }

  function updateTravelCounter(): void {
    if (el.travelCount) el.travelCount.textContent = state.travel.ids.length + ' / 50';
    if (el.travelStops) el.travelStops.setAttribute('aria-label', 'Точки маршрута: ' + state.travel.ids.length + ' из 50');
    if (el.travelRouteHint) el.travelRouteHint.textContent = state.travel.ids.length >= 50
      ? 'Достигнут лимит'
      : (state.travel.freePointMode ? 'Shift+ЛКМ — точка · ЛКМ — выход' : 'Кликните систему на карте');
  }

  function renderTravelStops(): void {
    if (!el.travelStops) return;
    var touchLayout = travelSmallScreen;
    var html = '';
    state.travel.ids.forEach(function (id, index) {
      var system = travelEntityForId(id);
      var stop = travelStopForSystem(system);
      if (!system || !stop) return;
      var isInfoOpen = state.travel.infoId === id;
      var infoSubject = system.isFreePoint ? 'произвольной точке' : 'системе ' + stop.name;
      var coordText = 'X ' + travelCore!.formatExactNumber(stop.coord[0]) + ' · Y ' + travelCore!.formatExactNumber(stop.coord[1]);
      html += '<li class="travel-stop' + (system.isFreePoint ? ' travel-stop-free' : '') + '" data-index="' + index + '" draggable="' + String(!touchLayout) + '">' +
        '<div class="travel-stop-main"><span class="travel-stop-order">' + (index + 1) + '</span>' +
        '<span class="travel-stop-copy"><strong>' + escapeHtml(stop.name) + '</strong><small>' + escapeHtml(coordText) + '</small></span>' +
        '<div class="travel-stop-actions">' +
          '<button type="button" data-travel-action="info" data-index="' + index + '" aria-expanded="' + String(isInfoOpen) + '" aria-label="Информация о ' + escapeHtml(infoSubject) + '" title="Название и координаты">i</button>' +
          '<button class="travel-touch-order" type="button" data-travel-action="up" data-index="' + index + '" aria-label="Переместить ' + escapeHtml(stop.name) + ' выше"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
          '<button class="travel-touch-order" type="button" data-travel-action="down" data-index="' + index + '" aria-label="Переместить ' + escapeHtml(stop.name) + ' ниже"' + (index === state.travel.ids.length - 1 ? ' disabled' : '') + '>↓</button>' +
          '<button type="button" data-travel-action="remove" data-index="' + index + '" aria-label="Убрать ' + escapeHtml(stop.name) + ' из маршрута" title="Убрать">×</button>' +
        '</div></div>' +
        (isInfoOpen ? '<div class="travel-stop-info"><strong>' + escapeHtml(stop.name) + '</strong><span>Координаты карты: (' + escapeHtml(travelCore!.formatExactNumber(stop.coord[0])) + ', ' + escapeHtml(travelCore!.formatExactNumber(stop.coord[1])) + ')</span></div>' : '') +
        '</li>';
    });
    el.travelStops.innerHTML = html;
    el.travelEmpty.hidden = state.travel.ids.length > 0;
    updateTravelCounter();
  }

  function refreshTravelCalculation(): void {
    var speed = travelCore ? travelCore!.parseSpeed(state.travel.speedText) : null;
    if (!speed) {
      state.travel.calculation = null;
      if (el.travelSpeed) el.travelSpeed.setAttribute('aria-invalid', 'true');
      if (el.travelSpeedError) el.travelSpeedError.hidden = false;
      updateTravelResults();
      return;
    }
    if (el.travelSpeed) el.travelSpeed.setAttribute('aria-invalid', 'false');
    if (el.travelSpeedError) el.travelSpeedError.hidden = true;
    state.travel.calculation = travelCore!.calculate(travelStops(), speed, state.travel.returnEnabled);
    updateTravelResults();
    kernel.renderer.requestRender();
  }

  function updateTravelResults(): void {
    if (!el.travelSummary) return;
    var stops = travelStops();
    var speed = travelCore ? travelCore!.parseSpeed(state.travel.speedText) : null;
    var canCopy = stops.length >= 2 && !!speed && !!state.travel.calculation;
    el.travelCopy.disabled = !canCopy;
    el.travelCount.textContent = state.travel.ids.length + ' / 50';
    if (!speed) {
      el.travelSummary.textContent = 'Укажите скорость больше нуля.';
      el.travelLogPreview.hidden = true;
      return;
    }
    if (stops.length < 2) {
      el.travelSummary.textContent = 'Добавьте минимум две точки, чтобы рассчитать перелёт.';
      el.travelLogPreview.hidden = true;
      return;
    }
    if (!state.travel.calculation) {
      el.travelSummary.textContent = 'Пересчёт маршрута…';
      el.travelLogPreview.hidden = true;
      return;
    }
    var calculation = state.travel.calculation;
    var lines = [
      'Маршрут: ' + travelCore!.formatNumber(calculation.outboundDistance) + ' св.л. · ' +
        travelCore!.formatNumber(calculation.outboundHours) + ' ч',
      'С возвратом: ' + travelCore!.formatNumber(calculation.roundTripDistance) + ' св.л. · ' +
        travelCore!.formatNumber(calculation.roundTripHours) + ' ч'
    ];
    if (state.travel.departureLocal) {
      var start = new Date(state.travel.departureLocal);
      if (isFinite(start.getTime())) {
        var arrival = new Date(start.getTime() + calculation.totalHours * 3600000);
        lines.push('Прибытие: ' + travelCore!.formatTimestamp(arrival));
      }
    }
    el.travelSummary.textContent = lines.join('\n');
    el.travelLogPreview.textContent = travelCore!.buildLog(
      stops, calculation, speed, state.travel.returnEnabled, state.travel.departureLocal
    );
    el.travelLogPreview.hidden = false;
  }

  function initializeTravelPlanner(): void {
    loadTravelPreferences();
    restoreTravelState();
    el.travelSpeed.value = state.travel.speedText;
    el.travelDeparture.value = state.travel.departureLocal;
    el.travelReturn.checked = state.travel.returnEnabled;
    renderTravelStops();
    refreshTravelCalculation();
    syncTravelModeUi();
  }

  function addTravelSystem(system: SystemRecord): boolean {
    var stop = travelStopForSystem(system);
    if (!stop) {
      kernel.app.toast('У системы нет подтверждённой пары координат X/Y');
      return false;
    }
    if (state.travel.ids.length >= 50) {
      kernel.app.toast('Лимит маршрута — 50 точек');
      return false;
    }
    var previous = state.travel.ids.length
      ? travelEntityForId(state.travel.ids[state.travel.ids.length - 1]!) : null;
    if (previous && travelSystemKey(previous) === travelSystemKey(system)) {
      kernel.app.toast('Нельзя добавить ту же систему подряд');
      return false;
    }
    state.travel.ids.push(String(system.id));
    state.travel.infoId = null;
    state.activeSystemId = system.id;
    persistTravelState();
    renderTravelStops();
    refreshTravelCalculation();
    kernel.app.toast('Добавлена система: ' + system.name);
    return true;
  }

  function addFreeTravelPoint(point: MapPoint): boolean {
    if (!kernel.data.coordinateOnMap(point)) {
      kernel.app.toast('Точка должна находиться в границах карты');
      return false;
    }
    if (state.travel.ids.length >= 50) {
      kernel.app.toast('Лимит маршрута — 50 точек');
      return false;
    }
    var id;
    do {
      id = '__travel_free_point__:' + state.travel.nextFreePointId++;
    } while (state.travel.customPoints[id] || state.systemsById[id]);
    var roundedCoordinates = travelCore!.roundMapCoordinates([point.x, point.y]);
    state.travel.customPoints[id] = {
      id: id,
      name: 'Произвольная точка',
      coord: roundedCoordinates,
      coordSource: 'map',
      isFreePoint: true
    };
    state.travel.ids.push(id);
    state.travel.infoId = null;
    persistTravelState();
    renderTravelStops();
    refreshTravelCalculation();
    kernel.app.toast('Добавлена произвольная точка');
    return true;
  }

  function reorderTravelStop(fromIndex: number, toIndex: number): void {
    var ids = state.travel.ids.slice();
    if (fromIndex < 0 || fromIndex >= ids.length || toIndex < 0 || toIndex >= ids.length || fromIndex === toIndex) return;
    var moved = ids.splice(fromIndex, 1)[0]!;
    ids.splice(toIndex, 0, moved);
    if (!isValidTravelSequence(ids)) {
      kernel.app.toast('Перестановка создала бы одинаковые соседние системы');
      return;
    }
    state.travel.ids = ids;
    persistTravelState();
    renderTravelStops();
    refreshTravelCalculation();
  }

  function removeTravelStop(index: number): void {
    var ids = state.travel.ids.slice();
    if (index < 0 || index >= ids.length) return;
    ids.splice(index, 1);
    if (!isValidTravelSequence(ids)) {
      kernel.app.toast('Нельзя оставить одинаковые соседние системы');
      return;
    }
    state.travel.ids = ids;
    state.travel.infoId = null;
    pruneTravelCustomPoints();
    persistTravelState();
    renderTravelStops();
    refreshTravelCalculation();
  }

  function clearTravelRoute(): void {
    cancelPendingTravelTap();
    state.travel.ids = [];
    state.travel.customPoints = {};
    state.travel.nextFreePointId = 1;
    state.travel.speedText = '100';
    state.travel.returnEnabled = false;
    state.travel.departureLocal = '';
    state.travel.animationPreference = null;
    state.travel.infoId = null;
    if (travelSpeedTimer) window.clearTimeout(travelSpeedTimer);
    try { window.localStorage.removeItem(CONFIG.storage.travel); } catch (err) { /* private browsing */ }
    el.travelSpeed.value = '100';
    el.travelDeparture.value = '';
    el.travelReturn.checked = false;
    renderTravelStops();
    refreshTravelCalculation();
    syncTravelAnimationUi();
    kernel.app.toast('Маршрут очищен');
  }

  function setTravelMode(enabled: boolean): void {
    enabled = !!enabled;
    if (state.travel.enabled === enabled) return;
    cancelPendingTravelTap();
    if (enabled) {
      state.travel.catalogWasOpen = travelSmallScreen && skin.panelOpen;
      if (state.travel.catalogWasOpen) kernel.catalog.setPanelOpen(false);
      state.pinned = false;
      state.activeSystemId = null;
      state.activePlanetId = null;
      state.hoverId = null;
      kernel.dossier.renderDetail();
    }
    state.travel.enabled = enabled;
    if (!enabled) state.travel.freePointMode = false;
    persistTravelState();
    syncTravelModeUi();
    kernel.app.layoutMapControls();
    if (!enabled && state.travel.catalogWasOpen) {
      state.travel.catalogWasOpen = false;
      kernel.catalog.setPanelOpen(true);
    }
    kernel.renderer.requestRender();
  }

  function setFreePointMode(enabled: boolean): void {
    enabled = !!enabled;
    if (enabled && !state.travel.enabled) setTravelMode(true);
    if (state.travel.freePointMode === enabled) return;
    state.travel.freePointMode = enabled;
    syncTravelModeUi();
    persistTravelState();
    kernel.app.toast(enabled
      ? 'Shift+ЛКМ по пустому месту — добавить произвольную точку; ЛКМ — выйти из режима'
      : 'Режим произвольных точек выключен');
  }

  function scheduleTravelSystemAdd(system: SystemRecord, pointerType?: string): void {
    scheduleTravelTap(function () { addTravelSystem(system); }, pointerType);
  }

  function scheduleFreeTravelPoint(point: MapPoint, pointerType?: string): void {
    scheduleTravelTap(function () { addFreeTravelPoint(point); }, pointerType);
  }

  function scheduleTravelTap(action: () => void, pointerType?: string): void {
    // Touch tap ждёт 180 мс; мышиный клик — 250 мс, чтобы dblclick-zoom успел отменить выбор.
    var pending: PendingTravelTap = { action: action, timer: null };
    var delay = pointerType === 'mouse' ? 250 : 180;
    pendingTravelTapTimers.push(pending);
    function commitTap(): void {
      if (!state.travel.enabled) {
        removePendingTravelTap(pending);
        return;
      }
      if (kernel.renderer.hasActivePointers()) {
        pending.timer = window.setTimeout(commitTap, 40);
        return;
      }
      removePendingTravelTap(pending);
      pending.action();
    }
    pending.timer = window.setTimeout(commitTap, delay);
  }

  function removePendingTravelTap(pending: PendingTravelTap): void {
    var index = pendingTravelTapTimers.indexOf(pending);
    if (index > -1) pendingTravelTapTimers.splice(index, 1);
  }

  function cancelPendingTravelTap(): void {
    pendingTravelTapTimers.forEach(function (pending) { if (pending.timer !== null) window.clearTimeout(pending.timer); });
    pendingTravelTapTimers = [];
  }

  function copyTravelLog(): void {
    var stops = travelStops();
    var speed = travelCore ? travelCore!.parseSpeed(state.travel.speedText) : null;
    if (stops.length < 2 || !speed || !state.travel.calculation) return;
    var log = travelCore!.buildLog(stops, state.travel.calculation, speed,
      state.travel.returnEnabled, state.travel.departureLocal);
    copyTextToClipboard(log, 'Лог маршрута скопирован', 'Не удалось скопировать лог маршрута');
  }

  function syncCoordinateToggle(): void {
    if (!el.coordinateToggle) return;
    el.coordinateToggle.setAttribute('aria-pressed', String(runtime.coordinateReadoutEnabled));
    var label = runtime.coordinateReadoutEnabled ? 'Отключить координаты наведения' : 'Включить координаты наведения';
    el.coordinateToggle.setAttribute('aria-label', label);
    el.coordinateToggle.title = label;
  }

  function bind(): void {
    // `?coords=1` — админ-режим (§7.8): readout X/Y включён с самого начала,
    // потому что админ пришёл за числами, а не за буквами.
    if (isCoordinatesMode()) runtime.coordinateReadoutEnabled = true;
    syncCoordinateToggle();
    if (el.coordinateToggle) el.coordinateToggle.addEventListener('click', function () {
      runtime.coordinateReadoutEnabled = !runtime.coordinateReadoutEnabled;
      syncCoordinateToggle();
      updateCoordinateReadout();
    });

    el.travelModeToggle.addEventListener('click', function () { setTravelMode(!state.travel.enabled); });
    el.travelFreePointToggle.addEventListener('click', function () {
      setFreePointMode(!state.travel.freePointMode);
    });
    el.travelClose.addEventListener('click', function () { setTravelMode(false); });
    el.travelClear.addEventListener('click', clearTravelRoute);
    el.travelCopy.addEventListener('click', copyTravelLog);
    el.travelSpeed.addEventListener('input', function () {
      state.travel.speedText = el.travelSpeed.value;
      state.travel.calculation = null;
      var valid = !!travelCore!.parseSpeed(state.travel.speedText);
      el.travelSpeed.setAttribute('aria-invalid', String(!valid));
      el.travelSpeedError.hidden = valid;
      updateTravelResults();
      if (travelSpeedTimer) window.clearTimeout(travelSpeedTimer);
      travelSpeedTimer = window.setTimeout(function () {
        travelSpeedTimer = null;
        refreshTravelCalculation();
        persistTravelState();
      }, 350);
    });
    el.travelReturn.addEventListener('change', function () {
      state.travel.returnEnabled = el.travelReturn.checked;
      persistTravelState();
      refreshTravelCalculation();
    });
    el.travelDeparture.addEventListener('change', function () {
      state.travel.departureLocal = el.travelDeparture.value;
      persistTravelState();
      refreshTravelCalculation();
    });
    el.travelAnimate.addEventListener('change', function () {
      if (travelReducedMotion) return;
      state.travel.animationPreference = el.travelAnimate.checked;
      persistTravelState();
      syncTravelAnimationUi();
      kernel.renderer.requestRender();
    });
    el.travelStops.addEventListener('click', function (event: Event) {
      var button = (event.target as Element).closest<HTMLElement>('[data-travel-action]');
      if (!button) return;
      var index = Number(button.getAttribute('data-index'));
      var action = button.getAttribute('data-travel-action');
      if (action === 'remove') removeTravelStop(index);
      else if (action === 'up') reorderTravelStop(index, index - 1);
      else if (action === 'down') reorderTravelStop(index, index + 1);
      else if (action === 'info') {
        var id = state.travel.ids[index]!;
        state.travel.infoId = state.travel.infoId === id ? null : id;
        if (state.travel.infoId) state.activeSystemId = id;
        renderTravelStops();
        kernel.renderer.requestRender();
      }
    });
    el.travelStops.addEventListener('dragstart', function (event) {
      if (travelSmallScreen) { event.preventDefault(); return; }
      var row = (event.target as Element).closest<HTMLElement>('.travel-stop');
      if (!row) return;
      row.classList.add('is-dragging');
      event.dataTransfer!.effectAllowed = 'move';
      event.dataTransfer!.setData('text/plain', row.getAttribute('data-index') || '');
    });
    el.travelStops.addEventListener('dragend', function (event) {
      var row = (event.target as Element).closest<HTMLElement>('.travel-stop');
      if (row) row.classList.remove('is-dragging');
    });
    el.travelStops.addEventListener('dragover', function (event) {
      if (travelSmallScreen) return;
      var row = (event.target as Element).closest<HTMLElement>('.travel-stop');
      if (row) event.preventDefault();
    });
    el.travelStops.addEventListener('drop', function (event) {
      if (travelSmallScreen) return;
      var row = (event.target as Element).closest<HTMLElement>('.travel-stop');
      if (!row) return;
      event.preventDefault();
      reorderTravelStop(Number(event.dataTransfer!.getData('text/plain')), Number(row.getAttribute('data-index')));
    });

    function updateTravelMotionPreference(event: MediaQueryListEvent): void {
      travelReducedMotion = !!event.matches;
      syncTravelAnimationUi();
      kernel.renderer.requestRender();
    }
    if (travelMotionQuery) {
      if (travelMotionQuery.addEventListener) travelMotionQuery.addEventListener('change', updateTravelMotionPreference);
      else if (travelMotionQuery.addListener) travelMotionQuery.addListener(updateTravelMotionPreference);
    }
    if (travelSmallQuery) {
      var updateTravelSmallScreen = function (event: MediaQueryListEvent): void {
        travelSmallScreen = !!event.matches;
        renderTravelStops();
        syncTravelModeUi();
        kernel.app.layoutMapControls();
        kernel.renderer.requestRender();
      };
      if (travelSmallQuery.addEventListener) travelSmallQuery.addEventListener('change', updateTravelSmallScreen);
      else if (travelSmallQuery.addListener) travelSmallQuery.addListener(updateTravelSmallScreen);
    }
  }
  return {
    bind,
    initializeTravelPlanner,
    updateZoomReadout,
    updateCoordinateReadout,
    copyTextToClipboard,
    copyMapCoordinates,
    travelStops,
    travelEntityForId,
    travelCoordinates,
    isTravelAnimationActive,
    cancelPendingTravelTap,
    scheduleTravelSystemAdd,
    scheduleFreeTravelPoint,
    addTravelSystem,
    setFreePointMode,
  };
}
