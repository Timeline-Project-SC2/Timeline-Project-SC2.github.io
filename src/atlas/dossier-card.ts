/* Map Atlas — досье системы/места, выбор записей и хэш-адреса. */

import { PLACE_TYPES, escapeHtml, plural } from './config.ts';
import type {
  AtlasKernel,
  DossierCardApi,
  PlaceRecord,
  SelectionOptions,
  SystemRecord,
} from './config.ts';

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
          '<span class="world-kind">' + escapeHtml(kernel.data.placeTypeLabel(world, true)) + '</span></div>' +
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
    html += '</div>';

    html += '<div class="detail-note detail-description"><strong>Описание:</strong> ' +
      escapeHtml(planet.note || 'отсутствует.') + '</div>';

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
    var match = /^#\/([sp])\/(.+)$/.exec(window.location.hash || '');
    if (!match) return false;
    var id = decodeURIComponent(match[2]!);
    if (match[1] === 's' && state.systemsById[id]) { selectSystem(id, { center: true }); return true; }
    if (match[1] === 'p' && state.planetsById[id]) { selectPlanet(id, { center: true }); return true; }
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
