/* Map Atlas — досье системы/места, выбор записей и хэш-адреса. */

import { PLACE_TYPES, PLANET_GLOBE, escapeHtml, formatNumber, plural } from './config.ts';
import type {
  AtlasKernel,
  DossierCardApi,
  MapPoint,
  PlaceRecord,
  SelectionOptions,
  SystemRecord,
} from './config.ts';
import { levelForWidth, levelSpec, visibleWidthLyForLevel } from './level-ladder.ts';
import { addressOf, formatAddress } from './sector-address.ts';
import { formatDistanceLy, unitsToLy } from './sector-units.ts';

export function createDossierCard(kernel: AtlasKernel): DossierCardApi {
  const state = kernel.state;
  const el = kernel.el;

  /* ------------------------------------------------------------------ доступ к записям */

  function selectSystem(id: string | null | undefined, options?: SelectionOptions): void {
    options = options || {};
    var system = id ? state.systemsById[id] : null;
    if (!system) return;
    if (state.travel.enabled && !options.forceDetail) {
      kernel.coords.addTravelSystem(system);
      return;
    }
    if (state.tab !== 'systems' || state.catalogView !== 'systems') kernel.catalog.setCatalogView('systems');
    state.activeSystemId = id!;
    state.activePlanetId = null;
    if (options.pin) state.pinned = true;
    if (options.center !== false && system.coord) kernel.renderer.centerOn(system.coord[0], system.coord[1]);
    renderDetail();
    kernel.catalog.renderCatalog();
    updateHash();
    kernel.renderer.requestRender();
  }

  function selectPlanet(id: string | null | undefined, options?: SelectionOptions): void {
    options = options || {};
    var planet = id ? state.planetsById[id] : null;
    if (!planet) return;
    var targetView = kernel.catalog.catalogViewForPlace(planet);
    if (state.tab !== 'planets' || state.catalogView !== targetView) kernel.catalog.setCatalogView(targetView);
    state.activePlanetId = id!;
    state.pinned = true;
    state.activeSystemId = planet.systemId && state.systemsById[planet.systemId]
      ? planet.systemId! : null;
    if (options.center !== false) {
      if (planet.pointOfInterest && kernel.data.coordinateOnMap(planet.mapCoord)) {
        kernel.renderer.centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, kernel.renderer.fitScale() * 3.4));
      } else if (!planet.pointOfInterest && planet.mapCoord) {
        kernel.renderer.centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, kernel.renderer.fitScale() * 3.4));
      } else if (planet.systemId) {
        var system = state.systemsById[planet.systemId];
        if (system && system.coord) kernel.renderer.centerOn(system.coord[0], system.coord[1], Math.max(state.view.scale, kernel.renderer.fitScale() * 2.6));
      }
    }
    renderDetail();
    kernel.catalog.renderCatalog();
    updateHash();
    kernel.renderer.requestRender();
  }

  function clearDetail(): void {
    state.pinned = false;
    state.activeSystemId = null;
    state.activePlanetId = null;
    state.hoverId = null;
    state.hoverPoiId = null;
    renderDetail();
    kernel.catalog.renderCatalog();
    updateHash();
    kernel.renderer.requestRender();
  }

  /* ------------------------------------------------------------------ досье справа */

  function systemPositionLabel(system: SystemRecord | null | undefined): string {
    return system && system.coord && system.coordSource === 'map'
      ? 'Положение отмечено на схеме'
      : 'Положение на схеме не указано';
  }

  function badge(text: string, extraClass?: string): string {
    return '<span class="badge' + (extraClass ? ' ' + extraClass : '') + '">' + escapeHtml(text) + '</span>';
  }

  /* ------------------------------------------------------------------ 3D-глобус (Этап 7) */

  // На 3D-глобус ведём только те места, у которых есть процедурная поверхность:
  // планеты и луны каталога, а также любое место с профилем в planet-generation.csv.
  function isGlobeCapablePlace(place: PlaceRecord): boolean {
    if (place.planetProfileStatus) return true;
    var types = kernel.data.placeTypesOf(place);
    return types.indexOf('planet') !== -1 || types.indexOf('moon') !== -1;
  }

  // Единый формат перехода из Атласа сектора на страницу планеты:
  // /planet-globe/?place=<id>[&system=<systemId>].
  function planetGlobeUrl(place: PlaceRecord): string {
    var url = PLANET_GLOBE.route + '?place=' + encodeURIComponent(String(place.id));
    if (place.systemId) url += '&system=' + encodeURIComponent(String(place.systemId));
    return url;
  }

  function planetProfileStatusBadge(place: PlaceRecord): string {
    var status = place.planetProfileStatus;
    if (status === 'frozen') return badge('3D-профиль: L1 Frozen', 'globe-profile frozen');
    if (status === 'review') return badge('3D-профиль: на проверке', 'globe-profile review');
    if (status === 'draft') return badge('3D-профиль: черновик', 'globe-profile draft');
    return badge('3D-глобус Голдберга', 'globe-profile');
  }

  // Краткая подпись под кнопкой: пресет и радиус из planet-generation.csv, иначе
  // честное указание, что глобус соберётся процедурно из контракта c100-soft-v2.
  function planetGlobeCaption(place: PlaceRecord): string {
    var parts: string[] = [];
    if (place.planetPresetId) parts.push('пресет ' + place.planetPresetId);
    if (place.planetRadiusKm) parts.push('радиус ' + formatNumber(Math.round(place.planetRadiusKm)) + ' км');
    if (!parts.length) return PLANET_GLOBE.defaultPresetLabel;
    return parts.join(' · ');
  }

  function renderDetail(): void {
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    var system = state.activeSystemId ? state.systemsById[state.activeSystemId] : null;

    if (!planet && !system) {
      el.detailPanel.hidden = true;
      el.detailContent.innerHTML = '';
      el.detailFooter.innerHTML = '';
      kernel.app.layoutMapControls();
      return;
    }

    if (planet) renderPlanetDetail(planet, system);
    else renderSystemDetail(system!);

    el.detailPanel.hidden = false;
    el.pinButton.classList.toggle('active', state.pinned);
    syncDetailPreview();
    kernel.app.layoutMapControls();
  }

  // Карточка, которую показывает наведение (не закреплена и показывает систему или место под
  // мышью), — предпросмотр, и мышь она не ловит. Иначе система под панелью мигала бы: панель
  // появляется поверх системы, холст получает pointerleave, наведение снимается, панель
  // прячется — и так на каждом движении мыши, а щелчок по системе доставался бы панели.
  // Сквозь предпросмотр система остаётся под мышью, щелчок по ней закрепляет карточку.
  // Выбранное в каталоге, поиске или по адресу — не предпросмотр: с карточкой работают мышью.
  function syncDetailPreview(): void {
    var hovered = !!(state.hoverId || state.hoverPoiId);
    el.detailPanel.classList.toggle('is-preview', !state.pinned && hovered &&
      state.activeSystemId === state.hoverId && state.activePlanetId === state.hoverPoiId);
  }

  function renderSystemDetail(system: SystemRecord): void {
    el.detailType.textContent = 'СИСТЕМА';
    var worlds = system.worlds || [];

    var html = '';
    html += '<h3 class="detail-title">' + escapeHtml(system.name.replace(/^Система\s+/, '')) + '</h3>';
    html += '<p class="detail-subtitle">' + escapeHtml(
      (system.primaryFaction || 'Фракции нет') + ' · ' + worlds.length + ' ' + plural(worlds.length, ['мир', 'мира', 'миров'])
    ) + '</p>';

    html += '<div class="detail-badges">';
    var provenanceBadge = system.canonical ? 'каноническая система · WorldBox' :
      (system.confidence === 'pdf-linked' ? 'связь старого каталога' :
        (system.confidence === 'lore' ? 'по вики-лору' : 'система'));
    html += badge(provenanceBadge, system.canonical ? 'pdf-linked' : '');
    var systemType = kernel.data.normalizedSystemType(system.systemType);
    var systemTypeLabels: Record<string, string> = {
      standard: 'Система', capital: 'Столица', unknown: 'Неизвестный тип', unknow: 'Неизвестный тип'
    };
    // The normal provenance badge already says "система"; avoid repeating it.
    if (systemType !== 'standard' || provenanceBadge !== 'система') {
      html += badge(systemTypeLabels[systemType] || systemType, systemType === 'capital' ? 'custom' : '');
    }
    if (system.mapVerified) html += badge('сверено с картой');
    if (system.needsReview) html += badge('требует проверки · Кегар', 'custom');
    html += '</div>';

    html += '<div class="detail-note detail-description"><strong>Описание:</strong> ' +
      escapeHtml(system.note || 'отсутствует.') + '</div>';

    html += '<div class="detail-section-title"><span>МЕСТА СИСТЕМЫ</span><span>' + worlds.length + '</span></div>';
    if (worlds.length) {
      html += '<div class="world-list">';
      worlds.forEach(function (world) {
        html += '<div class="world-card" data-planet="' + escapeHtml(world.id) + '">' +
          '<div class="world-card-top"><span class="world-name">' + escapeHtml(world.name) + '</span>' +
          '<span class="world-kind">' + escapeHtml(kernel.data.placeTypeLabel(world, true)) + '</span>' +
          (isGlobeCapablePlace(world)
            ? '<a class="world-globe-link" href="' + escapeHtml(planetGlobeUrl(world)) +
              '" title="Открыть 3D-глобус планеты">🌐 Глобус →</a>' : '') +
          '</div>' +
          '<div class="world-meta">' +
          kernel.data.factionsOf(world).slice(0, 2).map(function (faction) {
            return '<span class="world-chip faction">' + escapeHtml(faction) + '</span>';
          }).join('') +
          (world.status ? '<span class="world-chip">' + escapeHtml(world.status) + '</span>' : '') +
          (world.custom ? '<span class="world-chip">кастом</span>' : '') +
          '</div>' +
          (world.population && world.population !== 'не указано'
            ? '<div class="world-pop">население: ' + escapeHtml(world.population) + '</div>' : '') +
          '</div>';
      });
      html += '</div>';
    } else {
      html += '<div class="detail-empty-worlds">Отдельные места в каталоге не перечислены: система известна только по названию.</div>';
    }

    if (system.coord && system.coordSource === 'map') {
      html += '<div class="detail-section-title"><span>ПОЛОЖЕНИЕ НА СХЕМЕ</span></div>' +
        '<div class="detail-position-row">' +
          '<div class="detail-coordinate-pair">' +
            '<div class="detail-coordinate"><strong>Координата X:</strong><span>' + escapeHtml(formatCoordinate(system.coord[0])) + '</span></div>' +
            '<div class="detail-coordinate"><strong>Координата Y:</strong><span>' + escapeHtml(formatCoordinate(system.coord[1])) + '</span></div>' +
          '</div>' +
          '<button class="detail-center-button" type="button" data-action="center">Центрировать</button>' +
        '</div>' +
        '<div class="detail-position-note">Система отмечена на карте.' +
          (system.mapLabel ? ' Подпись: ' + escapeHtml(system.mapLabel) + '.' : '') + '</div>';
    }

    if (system.mapNote) {
      html += '<div class="detail-note">' + escapeHtml(system.mapNote) + '</div>';
    }
    var systemSources = (system.refs || []).slice();
    var sheetSystemSource = safeSourceUrl(system.sourceUrl);
    if (sheetSystemSource && systemSources.indexOf(sheetSystemSource) === -1) systemSources.push(sheetSystemSource);
    if (systemSources.length) {
      html += '<div class="detail-section-title"><span>ИСТОЧНИКИ</span></div><div class="source-links">' +
        systemSources.map(function (ref) {
          return '<a href="' + escapeHtml(ref) + '" target="_blank" rel="noreferrer">' + escapeHtml(shortUrl(ref)) + ' ↗</a>';
        }).join('') + '</div>';
    }
    if (system.wiki) {
      html += '<div class="source-links"><a href="' + escapeHtml(system.wiki) + '" target="_blank" rel="noreferrer">StarCraft Wiki (EN) ↗</a></div>';
    }

    el.detailContent.innerHTML = html;

    el.detailFooter.innerHTML =
      '<span>' + escapeHtml(system.id) + '</span>' +
      '<button type="button" data-action="link">Ссылка</button>';
  }

  function renderPlanetDetail(planet: PlaceRecord, system: SystemRecord | null | undefined): void {
    el.detailType.textContent = 'МЕСТО';
    var terrain = planet.terrain || [];
    var factions = kernel.data.factionsOf(planet);

    var html = '';
    html += '<div class="detail-kicker"><span class="confidence-dot pdf-linked"></span>' +
      escapeHtml('строгий канон · StarCraft Wiki') + '</div>';
    html += '<h3 class="detail-title">' + escapeHtml(planet.name) + '</h3>';
    html += '<p class="detail-subtitle">' + escapeHtml(kernel.data.placeTypeLabel(planet, true)) +
      (terrain.length ? ' · ' + escapeHtml(terrain.join(', ')) : '') + '</p>';

    html += '<div class="detail-badges">';
    kernel.data.placeTypesOf(planet).forEach(function (type) {
      html += badge((PLACE_TYPES[type] || { label: type }).label, 'pdf-linked');
    });
    if (planet.nameEn && planet.nameEn !== planet.name) html += badge(planet.nameEn);
    if (planet.status) html += badge(planet.status, 'custom');
    if (planet.onMap) html += badge('подпись на карте');
    if (planet.canonical) html += badge('строгий канон', 'pdf-linked');
    if (planet.canonicalSystem) html += badge('WorldBox.system', 'pdf-linked');
    if (planet.parent) html += badge('родитель: ' + planet.parent);
    if (isGlobeCapablePlace(planet)) html += planetProfileStatusBadge(planet);
    html += '</div>';

    html += '<div class="detail-note detail-description"><strong>Описание:</strong> ' +
      escapeHtml(planet.note || 'отсутствует.') + '</div>';

    if (isGlobeCapablePlace(planet)) {
      html += '<div class="detail-globe-cta">' +
        '<a class="detail-globe-button" href="' + escapeHtml(planetGlobeUrl(planet)) + '">' +
          '<span class="detail-globe-icon">🌐</span> Открыть 3D-глобус планеты →</a>' +
        '<div class="detail-globe-caption">' + escapeHtml(planetGlobeCaption(planet)) + '</div>' +
        '</div>';
    }

    html += '<div class="detail-section-title"><span>СИСТЕМА</span></div>';
    html += '<div class="world-list">';
    if (system) {
      html += '<div class="world-card" data-system="' + escapeHtml(system.id) + '">' +
        '<div class="world-card-top"><span class="world-name">' + escapeHtml(system.name) + '</span>' +
        '<span class="world-kind">' + escapeHtml(systemPositionLabel(system)) + '</span></div></div>';
    } else {
      html += '<div class="detail-empty-worlds">Система в источниках не указана: место числится отдельно от ' + state.systems.length + ' систем каталога.</div>';
    }
    html += '</div>';

    html += '<div class="detail-section-title"><span>ДАННЫЕ МЕСТА</span></div>';
    html += '<div class="world-list"><div class="world-card">' +
      '<div class="world-meta">' +
      factions.map(function (faction) { return '<span class="world-chip faction">' + escapeHtml(faction) + '</span>'; }).join('') +
      terrain.map(function (kind) { return '<span class="world-chip">' + escapeHtml(kind) + '</span>'; }).join('') +
      '<span class="world-chip">население: ' + escapeHtml(planet.population || 'не указано') + '</span>' +
      '</div></div></div>';

    if (planet.sourceLine) {
      html += '<div class="detail-note"><strong>Источник.</strong> ' + escapeHtml(planet.sourceLine) + '</div>';
    }
    var placeSource = safeSourceUrl(planet.sourceUrl);
    if (placeSource) {
      html += '<div class="source-links"><a href="' + escapeHtml(placeSource) + '" target="_blank" rel="noreferrer">' +
        escapeHtml(shortUrl(placeSource)) + ' ↗</a></div>';
    }
    var placePosition = planet.mapCoord ||
      (system && system.coord && system.coordSource === 'map'
        ? { x: system.coord[0], y: system.coord[1] } : null);
    var placePositionTitle = planet.mapCoord ? 'ПОЛОЖЕНИЕ НА СХЕМЕ' : 'ПОЛОЖЕНИЕ СИСТЕМЫ';
    if (placePosition) {
      html += '<div class="detail-section-title"><span>' + placePositionTitle + '</span></div>' +
        '<div class="detail-position-row">' +
          '<div class="detail-coordinate-pair">' +
            '<div class="detail-coordinate"><strong>Координата X:</strong><span>' + escapeHtml(formatCoordinate(placePosition.x)) + '</span></div>' +
            '<div class="detail-coordinate"><strong>Координата Y:</strong><span>' + escapeHtml(formatCoordinate(placePosition.y)) + '</span></div>' +
          '</div>' +
          '<button class="detail-center-button" type="button" data-action="center">Центрировать</button>' +
        '</div>' +
        '<div class="detail-position-note">' +
          (planet.pointOfInterest
            ? 'Точка интереса отмечена на карте.'
            : (planet.mapCoord
              ? 'На карте отмечена подпись «' + escapeHtml(planet.mapLabel || planet.name) + '», а не орбита.'
              : 'Показано положение родительской системы.')) +
        '</div>';
    }
    if (planet.canonicalSystem) {
      html += '<div class="detail-note"><strong>Каноническая система.</strong> ' +
        escapeHtml(planet.canonicalSystem.name) + ' — явная ссылка <code>WorldBox.system</code>, а не вывод из имени мира.</div>';
    }

    if (planet.wiki) {
      html += '<div class="source-links"><a href="' + escapeHtml(planet.wiki) + '" target="_blank" rel="noreferrer">StarCraft Wiki (EN)' +
        (planet.wikiConfidence ? ' · ' + escapeHtml(planet.wikiConfidence) : '') + ' ↗</a></div>';
    }

    el.detailContent.innerHTML = html;
    el.detailFooter.innerHTML =
      '<span>' + escapeHtml(planet.id) + '</span>' +
      (system ? '<button type="button" data-action="system">← к системе</button>' : '') +
      (!placePosition ? '<button type="button" data-action="center">Центрировать</button>' : '');
  }

  function formatCoordinate(value: unknown): string {
    var number = Number(value);
    return isFinite(number) ? String(Math.round(number * 100) / 100) : '—';
  }

  function centerActiveDetail(): void {
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    if (planet && planet.mapCoord) {
      kernel.renderer.centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, kernel.renderer.fitScale() * 3.4));
      return;
    }
    var systemId = planet ? planet.systemId : state.activeSystemId;
    var system = systemId ? state.systemsById[systemId] : null;
    if (system && system.coord) {
      kernel.renderer.centerOn(system.coord[0], system.coord[1], Math.max(state.view.scale, kernel.renderer.fitScale() * 2.6));
    }
  }

  function safeSourceUrl(value: unknown): string {
    var text = kernel.data.sheetValue(value);
    if (!text) return '';
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = 'https://' + text;
    try {
      var parsed = new URL(text);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname
        ? parsed.href : '';
    } catch (err) { return ''; }
  }

  function shortUrl(url: string): string {
    try {
      var parsed = new URL(url);
      var tail = parsed.pathname.split('/').filter(Boolean).slice(-1)[0] || '';
      return parsed.host.replace(/^www\./i, '') + (tail ? '/' + tail.replace(/_/g, ' ') : '');
    } catch (err) { return url; }
  }

  /* ------------------------------------------------------------------ ссылки и хэш */

  function updateHash(): void {
    var hash = '';
    if (state.activePlanetId) hash = '#/p/' + encodeURIComponent(state.activePlanetId);
    else if (state.activeSystemId) hash = '#/s/' + encodeURIComponent(state.activeSystemId);
    try {
      // в песочнице предпросмотра и в iframe без своего origin history может быть запрещён
      if (hash) {
        if (window.location.hash !== hash) history.replaceState(null, '', hash);
      } else if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch (err) { /* адресная строка недоступна — молча продолжаем */ }
  }

  function applyHash(): boolean {
    var hash = window.location.hash || '';
    // `#system=<id>&frame=<S|O>` (§7.7): кадр только разбирается и запоминается.
    // Системный кадр рисует волна SW-5, поэтому здесь нет ни отрисовки, ни заглушек.
    var frameParam = /[?&]frame=([^&]*)/.exec(hash);
    var frame = parseFrame(frameParam ? frameParam[1] : null);
    hash = hash.replace(/[?&]frame=[^&]*/, '');
    var match = /^#\/([sp])\/(.+)$/.exec(hash);
    // Обратные ссылки со страницы планеты: /sector/#system=<id> и /sector/#planet=<id>.
    var named = /^#(system|planet)=(.+)$/.exec(hash);
    var kind = match ? match[1]! : (named ? named[1]! : '');
    var raw = match ? match[2]! : (named ? named[2]! : '');
    if (!kind) return false;
    var id = '';
    try { id = decodeURIComponent(raw); } catch (err) { return false; }
    if (!id) return false;
    if ((kind === 's' || kind === 'system') && state.systemsById[id]) {
      rememberSystemFrame(kernel, id, frame);
      selectSystem(id, { center: true });
      return true;
    }
    if ((kind === 'p' || kind === 'planet') && state.planetsById[id]) {
      selectPlanet(id, { center: true });
      return true;
    }
    return false;
  }

  function copyLink(): void {
    var url = window.location.href;
    var done = function (): void { kernel.app.toast('Ссылка скопирована'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { kernel.app.toast(url); });
    } else {
      kernel.app.toast(url);
    }
  }

  function bind(): void {
    // досье
    el.closeDetail.addEventListener('click', clearDetail);
    el.pinButton.addEventListener('click', function () {
      state.pinned = !state.pinned;
      el.pinButton.classList.toggle('active', state.pinned);
      syncDetailPreview();
      kernel.app.toast(state.pinned ? 'Карточка закреплена' : 'Карточка закрывается при уходе курсора');
      if (!state.pinned) clearDetail();
    });
    el.detailContent.addEventListener('click', function (event) {
      // Ссылка на 3D-глобус (и внешние источники) открывается обычным переходом:
      // карточку-предпросмотр мы намеренно не превращаем в перехватчик навигации.
      if ((event.target as Element).closest('a[href]')) return;
      var actionButton = (event.target as Element).closest<HTMLElement>('[data-action]');
      if (actionButton && actionButton.getAttribute('data-action') === 'center') {
        centerActiveDetail();
        return;
      }
      var card = (event.target as Element).closest<HTMLElement>('[data-planet],[data-system]');
      if (!card) return;
      if (card.hasAttribute('data-planet')) selectPlanet(card.getAttribute('data-planet'));
      else selectSystem(card.getAttribute('data-system'), { center: true });
    });
    el.detailFooter.addEventListener('click', function (event) {
      var button = (event.target as Element).closest<HTMLElement>('[data-action]');
      if (!button) return;
      var action = button.getAttribute('data-action');
      if (action === 'center') {
        centerActiveDetail();
      } else if (action === 'link') {
        copyLink();
      } else if (action === 'system') {
        state.activePlanetId = null;
        renderDetail();
        updateHash();
      }
    });
  }
  return {
    bind,
    selectSystem,
    selectPlanet,
    clearDetail,
    renderDetail,
    syncDetailPreview,
    centerActiveDetail,
    updateHash,
    applyHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Кадр системы из адресной строки (§7.7)                                      */
/* -------------------------------------------------------------------------- */

/** Кадр системы, разобранный из `#system=<id>&frame=<S|O>`; рисует его волна SW-5. */
export interface SystemFrameRequest {
  readonly systemId: string;
  readonly frame: 'S' | 'O';
}

const frameRequests = new WeakMap<AtlasKernel, SystemFrameRequest>();

/** Разбирает значение параметра `frame`: понимает только `S` и `O`, остальное — «нет кадра». */
export function parseFrame(value: string | null | undefined): 'S' | 'O' | null {
  var text = String(value == null ? '' : value).trim().toUpperCase();
  return text === 'S' || text === 'O' ? text : null;
}

function rememberSystemFrame(kernel: AtlasKernel, systemId: string, frame: 'S' | 'O' | null): void {
  if (frame) frameRequests.set(kernel, { systemId: systemId, frame: frame });
  else frameRequests.delete(kernel);
}

/**
 * Запрошенный системный кадр или `null`, если в адресе кадра не было.
 *
 * Пока это только разбор и хранение параметра: системного кадра в рендере ещё нет
 * (SW-5). Функция намеренно ничего не рисует — заглушек быть не должно.
 */
export function requestedSystemFrame(kernel: AtlasKernel): SystemFrameRequest | null {
  return frameRequests.get(kernel) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Карточка точки по Shift+клику (§7.8)                                       */
/* -------------------------------------------------------------------------- */

/** Центр ядра сектора Копрулу по данным (§3.3 плана глубокого рендера). */
const SECTOR_CORE = Object.freeze({ x: 6014, y: 5856 });

export interface PointCardTarget {
  /** Мировые координаты точки (единица карты равна одному световому году). */
  world: MapPoint;
  /** Координаты указателя внутри холста карты, px. */
  screen: MapPoint;
}

interface PointCardView {
  open(target: PointCardTarget): void;
  close(): void;
}

const pointCardViews = new WeakMap<AtlasKernel, PointCardView>();

/** Координата с одним знаком после запятой: `5 720,0`. */
export function formatPointTenths(value: number): string {
  var text = (Math.round(value * 10) / 10).toFixed(1);
  var parts = text.split('.');
  return formatNumber(parts[0] ?? '0') + ',' + (parts[1] ?? '0');
}

/**
 * Ближайшая к точке система (только системы с координатами на карте).
 * Возвращает `null`, если ни у одной системы координат нет.
 */
export function nearestSystemTo(
  systems: readonly SystemRecord[],
  explicitNumber: (value: unknown) => number | null,
  x: number,
  y: number,
): { name: string; distance: number } | null {
  var best: { name: string; distance: number } | null = null;
  systems.forEach(function (system) {
    if (system.coordSource !== 'map' || !Array.isArray(system.coord) || system.coord.length < 2) return;
    var px = explicitNumber(system.coord[0]);
    var py = explicitNumber(system.coord[1]);
    if (px === null || py === null) return;
    var distance = Math.hypot(px - x, py - y);
    if (best && distance >= best.distance) return;
    best = { name: system.name, distance: distance };
  });
  return best;
}

/** Уровень лестницы и его номинальная видимая ширина в св.г. (например, `L0 · 10,0 св.г.`). */
export function levelCaption(visibleWidth: number): string {
  var level = levelForWidth(visibleWidth);
  var spec = levelSpec(level);
  return spec.id + ' · ' + formatDistanceLy(visibleWidthLyForLevel(level), 'short');
}

/** Расстояние от точки `(x, y)` в единицах карты до ядра сектора, отформатированное в св.г. */
export function sectorCoreDistanceText(x: number, y: number): string {
  var core = Math.hypot(x - SECTOR_CORE.x, y - SECTOR_CORE.y);
  var coreLy = unitsToLy(core);
  return formatDistanceLy(coreLy, 'full');
}

function createPointCardView(kernel: AtlasKernel): PointCardView {
  var doc = kernel.doc;
  var root = doc.createElement('div');
  root.className = 'point-card';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-label', 'Карточка точки карты');
  root.setAttribute('tabindex', '-1');
  // `hidden` не годится: inline `display:flex` перебивает стиль браузера.
  root.style.cssText = [
    'position:fixed', 'z-index:45', 'min-width:236px', 'max-width:302px',
    'padding:10px 12px', 'display:flex', 'flex-direction:column', 'gap:6px',
    'background:rgba(5,10,17,.96)', 'border:1px solid rgba(172,194,221,.28)',
    'box-shadow:0 12px 30px rgba(0,0,0,.42)', 'backdrop-filter:blur(10px)',
    'color:#d8e4f4', 'font:10px/1.45 var(--mono,Consolas,monospace)',
    'letter-spacing:.01em', 'outline:none'
  ].join(';');
  root.style.display = 'none';
  doc.body.appendChild(root);

  function close(): void {
    if (root.style.display === 'none') return;
    root.style.display = 'none';
    var canvas = kernel.el.mapCanvas;
    if (!canvas) return;
    // Холст без tabindex не принимает фокус; `-1` делает это без нового таб-стопа.
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
    try { canvas.focus(); } catch (err) { /* фокус недоступен — молча продолжаем */ }
  }

  function copy(value: string, message: string): void {
    kernel.coords.copyTextToClipboard(value, message, 'Не удалось скопировать');
  }

  root.addEventListener('click', function (event: Event) {
    var button = (event.target as Element).closest<HTMLElement>('[data-point-action]');
    if (!button) return;
    var action = button.getAttribute('data-point-action');
    var address = button.getAttribute('data-point-address') || '';
    var row = button.getAttribute('data-point-row') || '';
    if (action === 'close') { close(); return; }
    if (action === 'address') copy(address, 'Адрес скопирован: ' + address);
    else if (action === 'xy') copy(button.getAttribute('data-point-xy') || '', 'Координаты скопированы');
    else if (action === 'row') copy(row, 'Строка скопирована');
  });

  doc.addEventListener('keydown', function (event: KeyboardEvent) {
    if (root.style.display === 'none') return;
    if (event.key === 'Escape') { close(); event.preventDefault(); }
  });

  doc.addEventListener('pointerdown', function (event: Event) {
    if (root.style.display === 'none') return;
    if (event.target instanceof Node && root.contains(event.target)) return;
    close();
  }, true);

  function open(target: PointCardTarget): void {
    var x = target.world.x;
    var y = target.world.y;
    var address = formatAddress(addressOf(
      Math.min(Math.max(x, 0), 9999),
      Math.min(Math.max(y, 0), 9999)
    ));
    var roundedX = Math.round(x);
    var roundedY = Math.round(y);
    var visibleWidth = stateWidth(kernel);
    var nearest = nearestSystemTo(kernel.state.systems, function (value) {
      return kernel.data.explicitMapNumber(value);
    }, x, y);

    root.innerHTML =
      '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">' +
      '<b style="font-size:12px;font-weight:600;color:#f5f8fc">' + escapeHtml(address) + '</b>' +
      '<span style="opacity:.72">' + escapeHtml(levelCaption(visibleWidth)) + '</span>' +
      '</div>' +
      '<div>x ' + escapeHtml(formatPointTenths(x)) + ' &nbsp; y ' + escapeHtml(formatPointTenths(y)) + '</div>' +
      '<div>ближайшая система: ' +
      (nearest
        ? escapeHtml(nearest.name) + ' · ' + formatDistanceLy(unitsToLy(nearest.distance), 'full')
        : 'координат нет') + '</div>' +
      '<div>от ядра сектора: ' + sectorCoreDistanceText(x, y) + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:2px">' +
      pointCardButton('address', 'Копировать адрес', address, roundedX + '\t' + roundedY, address + '\t' + roundedX + '\t' + roundedY) +
      pointCardButton('xy', 'Копировать x⇥y', address, roundedX + '\t' + roundedY, address + '\t' + roundedX + '\t' + roundedY) +
      pointCardButton('row', 'Копировать строку', address, roundedX + '\t' + roundedY, address + '\t' + roundedX + '\t' + roundedY) +
      '<button type="button" data-point-action="close" aria-label="Закрыть карточку точки" ' +
      'style="margin-left:auto;width:22px;height:22px;border:1px solid rgba(175,199,228,.22);' +
      'background:transparent;color:#b6c8de;font:11px/1 var(--mono,Consolas,monospace);cursor:pointer">×</button>' +
      '</div>';

    var margin = 14;
    var left = target.screen.x + margin;
    var top = target.screen.y + margin;
    root.style.display = 'flex';
    var width = root.offsetWidth;
    var height = root.offsetHeight;
    var maxWidth = window.innerWidth || kernel.state.viewport.w;
    var maxHeight = window.innerHeight || kernel.state.viewport.h;
    if (left + width > maxWidth - 8) left = target.screen.x - width - margin;
    if (top + height > maxHeight - 8) top = target.screen.y - height - margin;
    root.style.left = Math.max(8, Math.min(left, maxWidth - width - 8)) + 'px';
    root.style.top = Math.max(8, Math.min(top, maxHeight - height - 8)) + 'px';
    try { root.focus(); } catch (err) { /* фокус недоступен — молча продолжаем */ }
  }

  return { open, close };
}

function pointCardButton(action: string, label: string, address: string, xy: string, row: string): string {
  return '<button type="button" data-point-action="' + action + '"' +
    ' data-point-address="' + escapeHtml(address) + '"' +
    ' data-point-xy="' + escapeHtml(xy) + '"' +
    ' data-point-row="' + escapeHtml(row) + '"' +
    ' style="padding:3px 7px;border:1px solid rgba(175,199,228,.22);background:transparent;' +
    'color:#cfe0f4;font:9px/1.2 var(--mono,Consolas,monospace);cursor:pointer">' +
    escapeHtml(label) + '</button>';
}

function stateWidth(kernel: AtlasKernel): number {
  var scale = kernel.state.view.scale;
  if (!(scale > 0)) return 0;
  // Ширина кадра по горизонтали — та же величина, что и `lw` в ссылке (§7.7).
  return kernel.state.viewport.w / scale;
}

/**
 * Открывает карточку точки `Shift+кликом` (§7.8): адрес, координаты, ближайшая
 * система, расстояние до ядра сектора, уровень и видимая ширина кадра.
 *
 * Вызывается из `copyMapCoordinates`, чтобы не менять контракт `canvas-renderer.ts`:
 * рендерер по-прежнему сообщает только точку указателя.
 */
export function openPointCard(kernel: AtlasKernel, target: PointCardTarget): void {
  var view = pointCardViews.get(kernel);
  if (!view) {
    view = createPointCardView(kernel);
    pointCardViews.set(kernel, view);
  }
  view.open(target);
}
