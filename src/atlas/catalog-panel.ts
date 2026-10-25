/* Map Atlas — поиск, фильтры, счётчики и левая панель каталога. */

import {
  CATALOG_VIEW_TYPES,
  PLACE_TYPES,
  escapeHtml,
  formatNumber,
  normalize,
  plural,
  qs,
  searchKey,
} from './config.ts';
import { centerOf, formatAddress, parseAddress } from './sector-address.ts';
import type {
  AtlasKernel,
  CatalogPanelApi,
  MapLabel,
  PlaceRecord,
  SearchEntry,
  SystemRecord,
} from './config.ts';

interface ListProjection {
  name: string;
  count: number;
}

export function createCatalogPanel(kernel: AtlasKernel): CatalogPanelApi {
  const doc = kernel.doc;
  const state = kernel.state;
  const el = kernel.el;
  const skin = kernel.skin;

  /* ------------------------------------------------------------------ поиск: подсказки */

  function updateSearchHintDistance(): void {
    if (!el.searchHintViewport || !el.searchHintTrack) return;
    var distance = Math.max(0, el.searchHintTrack.scrollWidth - el.searchHintViewport.clientWidth);
    el.searchHintTrack.style.setProperty('--search-hint-offset', '-' + distance + 'px');
  }

  function updateSuggestions(): void {
    var value = el.searchInput.value.trim();
    state.query = value;
    el.clearSearch.hidden = value.length === 0;

    if (!value) {
      el.suggestions.hidden = true;
      el.suggestions.innerHTML = '';
      renderCatalog();
      return;
    }

    var addressEntry = addressSuggestion(value);
    var results = kernel.data.search(value);
    if (addressEntry) {
      // Адрес идёт первым и заменяет «координаты» из числового разбора: буквенная
      // запись — это тоже переход к точке, дублировать его в списке незачем.
      results = [addressEntry].concat(results.filter(function (entry) { return entry.kind !== 'coordinate'; }));
    }
    if (!results.length) {
      el.suggestions.hidden = false;
      el.suggestions.innerHTML = '<div class="suggestions-empty">Ничего не найдено. Попробуйте часть названия места, системы или фракции.</div>';
      renderCatalog();
      return;
    }

    var html = '';
    var lastKind: string | null = null;
    results.forEach(function (entry, index) {
      if (entry.kind !== lastKind) {
        html += '<div class="suggestion-label">' + escapeHtml(entry.kindLabel) + '</div>';
        lastKind = entry.kind;
      }
      html += '<button class="suggestion" type="button" role="option" data-index="' + index + '">' +
        '<span class="suggestion-icon">' + escapeHtml(entry.glyph) + '</span>' +
        '<span class="suggestion-main">' +
        '<span class="suggestion-title">' + escapeHtml(entry.title) + '</span>' +
        '<span class="suggestion-sub">' + escapeHtml(entry.subtitle) + '</span>' +
        '</span>' +
        '<span class="suggestion-kind">' + escapeHtml(entry.kindLabel) + '</span>' +
        '</button>';
    });
    el.suggestions.innerHTML = html;
    el.suggestions.hidden = false;
    el.suggestions._results = results;
    renderCatalog();
  }

  /**
   * Адрес сектора (`KP·REQHC`, `REQHC`, `KP-R-E-Q-H-C`) как переход к точке.
   *
   * Разбор — только через `sector-address.ts`: второй парсер адресов запрещён,
   * иначе появится второй источник истины. Пять латинских букв `A…Y` могут
   * совпасть с именем, поэтому подсказка адреса идёт отдельной группой «Адрес»,
   * а совпадения по имени остаются в списке ниже.
   */
  function addressSuggestion(value: string): SearchEntry | null {
    var address = parseAddress(value);
    if (!address) return null;
    var center = centerOf(address);
    return {
      kind: 'coordinate',
      kindLabel: 'Адрес',
      glyph: '⌖',
      id: 'address:' + formatAddress(address),
      title: formatAddress(address),
      subtitle: 'Перейти к узлу · x ' + formatNumber(Math.round(center.x)) + ' · y ' + formatNumber(Math.round(center.y)),
      x: center.x,
      y: center.y
    };
  }

  function openSuggestion(entry: SearchEntry | undefined): void {
    if (!entry) return;
    if (entry.kind === 'coordinate') {
      kernel.dossier.clearDetail();
      // Адрес — это узел сетки: ведём к нему на предельное приближение, иначе
      // переход на «×2,6 от обзора» показывает точку, но не её адресный контекст.
      // Потолок берётся у рендерера (`maxScale()` — кламп «1 св.г. до границы»),
      // своих коэффициентов вместо него не вводим.
      var isAddress = entry.id.indexOf('address:') === 0;
      kernel.renderer.centerOn(entry.x, entry.y, isAddress
        ? kernel.renderer.maxScale()
        : Math.max(state.view.scale, kernel.renderer.fitScale() * 2.6));
    } else if (entry.kind === 'system') kernel.dossier.selectSystem(entry.id);
    else if (entry.kind === 'planet') kernel.dossier.selectPlanet(entry.id);
    else if (entry.kind === 'marker') {
      var label = findLabel(entry.id);
      if (label) {
        state.activeSystemId = label.linkedSystemId || null;
        state.activePlanetId = label.linkedPlanetId || null;
        state.pinned = true;
        kernel.renderer.centerOn(label.x, label.y, Math.max(state.view.scale, kernel.renderer.fitScale() * 3));
        kernel.dossier.renderDetail();
        kernel.dossier.updateHash();
      }
    }
    el.suggestions.hidden = true;
    el.searchInput.blur();
  }

  function findLabel(key: string): MapLabel | null {
    for (var i = 0; i < state.labels.length; i++) {
      var label = state.labels[i]!;
      if (label.name + '@' + label.x + ',' + label.y === key) return label;
    }
    return null;
  }

  // Виды вкладки «Места»: planet, station, platform, other. Каждый тип должен
  // попадать ровно в одну вкладку, иначе место есть в данных, но не видно ни в
  // одной. Набор типов вида берётся из CATALOG_VIEW_TYPES (config.ts): новый тип
  // попадает в каталог правкой одной таблицы.
  function matchesCatalogView(place: PlaceRecord, view?: string | null): boolean {
    var types = kernel.data.placeTypesOf(place);
    view = view || state.catalogView;
    if (!view || view === 'systems') return true;
    // Платформа и станция делят один тип `station`: платформа отличается признаком
    // isPlatformPlace. Пару разбираем до общей таблицы, иначе станция-платформа
    // попала бы сразу в две вкладки и задвоила счётчики.
    if (view === 'station') return types.indexOf('station') > -1 && !kernel.data.isPlatformPlace(place);
    if (view === 'platform') return types.indexOf('platform') > -1 || kernel.data.isPlatformPlace(place);
    var viewTypes = CATALOG_VIEW_TYPES[view];
    if (!viewTypes) return true;
    return viewTypes.some(function (type) { return types.indexOf(type) > -1; });
  }

  function catalogViewForPlace(place: PlaceRecord): string {
    var types = kernel.data.placeTypesOf(place);
    if (types.indexOf('platform') > -1) return 'platform';
    if (types.indexOf('station') > -1) return kernel.data.isPlatformPlace(place) ? 'platform' : 'station';
    if (types.indexOf('planet') > -1) return 'planet';
    return 'other';
  }

  function updateCatalogSectionState(): void {
    var active = state.catalogView || '';
    var selectedButton: Element | null = null;
    doc.querySelectorAll('[data-catalog-view]').forEach(function (button) {
      var selected = button.getAttribute('data-catalog-view') === active;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      if (selected) selectedButton = button;
    });
    if (el.catalogSectionSummary) {
      var label: HTMLElement | null = selectedButton ? qs('.catalog-section-copy strong', selectedButton) : null;
      el.catalogSectionSummary.textContent = label ? label.textContent : 'Места';
    }
    if (el.catalogSectionSummaryCount) {
      var count: HTMLElement | null = selectedButton ? qs('b', selectedButton) : null;
      el.catalogSectionSummaryCount.textContent = count ? count.textContent : '';
    }
  }

  function setCatalogView(view: string | null): void {
    state.catalogView = view;
    if (el.catalogSectionDropdown) el.catalogSectionDropdown.open = false;
    state.query = '';
    if (el.searchInput) el.searchInput.value = '';
    if (el.suggestions) el.suggestions.hidden = true;
    if (el.clearSearch) el.clearSearch.hidden = true;
    if (view === 'systems') {
      state.activeTypes = [];
      setTab('systems', { keepCatalogView: true });
    } else {
      // Стартовые фильтры вида — ровно его типы из общей таблицы, иначе фильтр
      // отсекал бы то, что вид показывает (так `unknown` терял «Иное место»).
      var viewTypes = view ? CATALOG_VIEW_TYPES[view] : null;
      state.activeTypes = viewTypes ? [...viewTypes] : [];
      setTab('planets', { keepCatalogView: true });
    }
    updateCatalogSectionState();
  }

  function setTab(tab: 'systems' | 'planets', options?: { keepCatalogView?: boolean }): void {
    options = options || {};
    state.tab = tab;
    if (!options.keepCatalogView) state.catalogView = tab === 'systems' ? 'systems' : null;
    updateCatalogSectionState();
    renderFilters();
    renderCatalog();
  }

  function renderSectionCounts(): void {
    var sectionCounts: Record<string, number> = {
      catalogCountSystems: state.systems.length,
      catalogCountPlanets: state.planets.filter(function (place) { return matchesCatalogView(place, 'planet'); }).length,
      catalogCountStations: state.planets.filter(function (place) { return matchesCatalogView(place, 'station'); }).length,
      catalogCountPlatforms: state.planets.filter(function (place) { return matchesCatalogView(place, 'platform'); }).length,
      catalogCountOther: state.planets.filter(function (place) { return matchesCatalogView(place, 'other'); }).length
    };
    Object.keys(sectionCounts).forEach(function (id) {
      var node = doc.getElementById(id);
      if (node) node.textContent = formatNumber(sectionCounts[id]!);
    });
    updateCatalogSectionState();
  }

  function currentFactionPool(): Record<string, number> {
    var counter: Record<string, number> = {};
    if (state.tab === 'systems') {
      state.systems.forEach(function (system) {
        (system.worlds.length ? kernel.data.systemFactions(system) : (system.factions || ['Фракции нет'])).forEach(function (faction) {
          counter[faction] = (counter[faction] || 0) + 1;
        });
      });
    } else {
      state.planets.filter(function (planet) { return matchesCatalogView(planet); }).forEach(function (planet) {
        kernel.data.factionsOf(planet).forEach(function (faction) {
          counter[faction] = (counter[faction] || 0) + 1;
        });
      });
    }
    return counter;
  }

  function currentTypePool(): Record<string, number> {
    var counter: Record<string, number> = {};
    if (state.tab === 'systems') {
      state.systems.forEach(function (system) {
        var seen: Record<string, boolean> = {};
        system.worlds.forEach(function (place) {
          kernel.data.placeTypesOf(place).forEach(function (type) { seen[type] = true; });
        });
        Object.keys(seen).forEach(function (type) { counter[type] = (counter[type] || 0) + 1; });
      });
    } else {
      state.planets.filter(function (place) { return matchesCatalogView(place); }).forEach(function (place) {
        kernel.data.placeTypesOf(place).forEach(function (type) { counter[type] = (counter[type] || 0) + 1; });
      });
    }
    return counter;
  }

  function renderFilters(): void {
    var counter = currentFactionPool();
    var typeCounter = currentTypePool();
    var factions = Object.keys(counter).sort(function (a, b) {
      if (counter[b]! !== counter[a]!) return counter[b]! - counter[a]!;
      return a.localeCompare(b, 'ru');
    });
    state.listFactions = factions;

    var typeMenu = qs<HTMLDetailsElement>('[data-filter-menu="type"]', el.filters);
    var factionMenu = qs<HTMLDetailsElement>('[data-filter-menu="faction"]', el.filters);
    var typeWasOpen = !!(typeMenu && typeMenu.open);
    var factionWasOpen = !!(factionMenu && factionMenu.open);
    state.activeFactions = state.activeFactions.filter(function (faction) { return counter[faction]; });
    state.activeTypes = state.activeTypes.filter(function (type) { return typeCounter[type]; });

    var typeNames = state.activeTypes.map(function (type) {
      return (PLACE_TYPES[type] || { plural: type }).plural;
    });
    var factionNames = state.activeFactions.slice();
    var typeSummary = typeNames.length ? typeNames.join(', ') : 'Все типы';
    var factionSummary = factionNames.length
      ? (factionNames.length < 3 ? factionNames.join(', ') : factionNames.length + ' выбрано')
      : 'Все фракции';
    var html = '<details class="filter-group" data-filter-menu="type"' + (typeWasOpen ? ' open' : '') + '>' +
      '<summary><span>ТИП</span><span class="filter-menu-current">' + escapeHtml(typeSummary) + '</span></summary>' +
      '<div class="filter-options">' +
      '<button class="filter-chip' + (!state.activeTypes.length ? ' active' : '') +
      '" type="button" data-type="">Все типы</button>';
    ['planet', 'moon', 'asteroid', 'station', 'platform', 'other', 'unknown'].forEach(function (type) {
      if (!typeCounter[type]) return;
      var active = state.activeTypes.indexOf(type) > -1;
      var config = PLACE_TYPES[type] || { plural: type };
      html += '<button class="filter-chip' + (active ? ' active' : '') + '" type="button" data-type="' + type + '">' +
        escapeHtml(config.plural) + ' <span>' + typeCounter[type] + '</span></button>';
    });
    html += '</div></details>' +
      '<details class="filter-group" data-filter-menu="faction"' + (factionWasOpen ? ' open' : '') + '>' +
      '<summary><span>ФРАКЦИЯ</span><span class="filter-menu-current">' + escapeHtml(factionSummary) + '</span></summary>' +
      '<div class="filter-options">' +
      '<button class="filter-chip' + (!state.activeFactions.length ? ' active' : '') +
      '" type="button" data-faction="">Все фракции</button>';
    factions.forEach(function (faction) {
      if (counter[faction]! < 1) return;
      var active = state.activeFactions.indexOf(faction) > -1;
      html += '<button class="filter-chip' + (active ? ' active' : '') + '" type="button" data-faction="' +
        escapeHtml(faction) + '">' + escapeHtml(faction) + ' <span>' + counter[faction] + '</span></button>';
    });
    html += '</div></details>';
    el.filters.innerHTML = html;

    if (el.filterIndicator) {
      var activeCount = state.activeTypes.length + state.activeFactions.length;
      el.filterIndicator.textContent = activeCount ? activeCount + ' выбрано' : 'Все';
    }
  }

  function matchesFaction(_list: unknown, factionsOfEntity: () => string[]): boolean {
    if (!state.activeFactions.length) return true;
    var factions = factionsOfEntity();
    return factions.some(function (faction) { return state.activeFactions.indexOf(faction) > -1; });
  }

  function matchesPlaceTypes(place: PlaceRecord): boolean {
    if (!state.activeTypes.length) return true;
    return kernel.data.placeTypesOf(place).some(function (type) { return state.activeTypes.indexOf(type) > -1; });
  }

  function visibleSystemsForList(): SystemRecord[] {
    var needle = normalize(state.query);
    var list = state.systems.filter(function (system) {
      if (!matchesFaction(system, function () { return kernel.data.systemFactions(system); })) return false;
      if (state.activeTypes.length && !system.worlds.some(matchesPlaceTypes)) return false;
      if (!needle) return true;
      return searchKey(system.name).indexOf(needle) > -1 || normalize(system.note || '').indexOf(needle) > -1;
    });
    list.sort(listComparator(function (system) { return { name: system.name, count: system.worlds.length }; }));
    return list;
  }

  function visiblePlanetsForList(): PlaceRecord[] {
    var needle = normalize(state.query);
    var list = state.planets.filter(function (planet) {
      if (!matchesCatalogView(planet)) return false;
      if (!matchesFaction(planet, function () { return kernel.data.factionsOf(planet); })) return false;
      if (!matchesPlaceTypes(planet)) return false;
      if (!needle) return true;
      return searchKey(planet.name).indexOf(needle) > -1 ||
        normalize((planet.terrain || []).join(' ')).indexOf(needle) > -1 ||
        normalize(planet.nameEn || '').indexOf(needle) > -1;
    });
    list.sort(listComparator(function (planet) { return { name: planet.name, count: planet.population ? 0 : 1 }; }));
    return list;
  }

  function listComparator<T>(project: (item: T) => ListProjection): (a: T, b: T) => number {
    return function (a: T, b: T): number {
      var pa = project(a);
      var pb = project(b);
      if (state.sortByCount && pb.count !== pa.count) return pb.count - pa.count;
      return pa.name.localeCompare(pb.name, 'ru');
    };
  }

  function catalogHidden(): boolean {
    return getComputedStyle(el.leftPanel).display === 'none';
  }

  function renderCatalog(): void {
    if (catalogHidden()) return;
    renderSectionCounts();
    var isSystems = state.tab === 'systems';
    var items = isSystems ? visibleSystemsForList() : visiblePlanetsForList();

    var sectionTitles: Record<string, string> = {
      planet: 'ПЛАНЕТЫ',
      station: 'СТАНЦИИ',
      platform: 'ПЛАТФОРМЫ',
      other: 'ИНЫЕ МЕСТА'
    };
    var sectionTitle = isSystems ? 'СИСТЕМЫ' : (sectionTitles[state.catalogView || ''] || 'МЕСТА');
    el.listCaption.textContent = state.query ? 'РЕЗУЛЬТАТЫ' : sectionTitle;
    el.filterResultCount.textContent = formatNumber(items.length) + ' ' + plural(items.length, ['запись', 'записи', 'записей']);
    el.sortButton.innerHTML = (state.sortByCount ? 'МЕСТА ↕' : 'А—Я <span>↕</span>');

    if (!items.length) {
      el.catalogList.innerHTML = '<div class="catalog-empty">Под фильтры ничего не попало. Сбросьте фракцию или строку поиска.</div>';
      return;
    }

    var activeSystem = state.activeSystemId;
    var activePlanet = state.activePlanetId;
    var html = '';

    items.slice(0, 600).forEach(function (item) {
      if (isSystems) {
        var systemItem = item as SystemRecord; var selected = systemItem.id === activeSystem && !activePlanet;
        var glyph = systemItem.name.replace(/^Система\s+/, '').slice(0, 2).toUpperCase();
        html += '<button class="catalog-row' + (selected ? ' selected' : '') + '" type="button" role="listitem" data-system="' + escapeHtml(systemItem.id) + '">' +
          '<span class="row-glyph">' + escapeHtml(glyph) + '</span>' +
          '<span class="row-copy">' +
          '<span class="row-title">' + escapeHtml(systemItem.name) + '</span>' +
          '<span class="row-meta"><span class="row-meta-text">' + escapeHtml(systemItem.primaryFaction || 'Фракции нет') + '</span></span>' +
          '</span>' +
          '<span class="row-count">' + systemItem.worlds.length + '</span>' +
          '</button>';
      } else {
        var placeItem = item as PlaceRecord; var system = placeItem.systemId ? state.systemsById[placeItem.systemId] : null;
        var selectedPlanetRow = placeItem.id === activePlanet;
        html += '<button class="catalog-row' + (selectedPlanetRow ? ' selected' : '') + '" type="button" role="listitem" data-planet="' + escapeHtml(placeItem.id) + '">' +
          '<span class="row-glyph">' + escapeHtml(kernel.data.placeTypeGlyph(placeItem)) + '</span>' +
          '<span class="row-copy">' +
          '<span class="row-title">' + escapeHtml(placeItem.name) + '</span>' +
          '<span class="row-meta">' +
          '<span class="row-status pdf-linked"></span>' +
          '<span class="row-meta-text">' + escapeHtml(kernel.data.placeTypeLabel(placeItem, true)) + ' · ' +
          escapeHtml(system ? system.name.replace(/^Система\s+/, '') : 'система не указана') + '</span>' +
          '</span>' +
          '</span>' +
          '<span class="row-count">' + escapeHtml(placeItem.onMap ? '⌖' : kernel.data.placeTypeGlyph(placeItem)) + '</span>' +
          '</button>';
      }
    });

    el.catalogList.innerHTML = html;
  }

  function detectSkin(): void {
    // В вики-скине панель стоит за левым краем (left: -300px), и открывать её
    // должен скрипт: в CSS остаётся только «закрытое» положение.
    skin.panelOffCanvas = parseFloat(getComputedStyle(el.leftPanel).left) < 0;
    // Панель, которая лежит поверх карты — десктопная колонка каталога во всю
    // высоту или нижняя шторка телефона — стартует свёрнутой: карта открывается
    // на весь экран. Так было и раньше, когда колонка стояла за левым краем.
    var panelRect = el.leftPanel.getBoundingClientRect();
    var stageRect = el.mapStage.getBoundingClientRect();
    skin.panelBottomSheet = stageRect.width > 0 && panelRect.width > stageRect.width * 0.8;
    skin.panelSidebar = stageRect.height > 0 && stageRect.width > 0 &&
      panelRect.left <= stageRect.left + 2 &&
      panelRect.height >= stageRect.height * 0.8 &&
      panelRect.width <= stageRect.width * 0.6;
    if (skin.panelOffCanvas || skin.panelBottomSheet || skin.panelSidebar) {
      el.leftPanel.classList.add('collapsed');
      el.mapStage.classList.add('wide');
      skin.panelOpen = false;
    } else {
      skin.panelOpen = !el.leftPanel.classList.contains('collapsed');
    }
  }

  function setPanelOpen(open: boolean): void {
    skin.panelOpen = open;
    el.leftPanel.classList.toggle('collapsed', !open);
    el.mapStage.classList.toggle('wide', !open);
    // Панель является дочерней для сдвинутой сцены: её штатный left:-300px
    // как раз ставит каталог у левого края окна. left:0 оставлял перед ним
    // пустую колонку шириной с сам каталог.
    if (skin.panelOffCanvas) el.leftPanel.style.left = '';
    kernel.renderer.requestRender();
  }

  function togglePanel(): void {
    setPanelOpen(!skin.panelOpen);
    var title = skin.panelOpen ? 'Скрыть каталог' : 'Показать каталог';
    [el.closePanel, el.toggleSidePanel].forEach(function (button) {
      if (button) button.setAttribute('title', title);
    });
  }

  function bind(): void {
    // панель каталога
    el.closePanel.addEventListener('click', togglePanel);
    if (el.toggleSidePanel) el.toggleSidePanel.addEventListener('click', togglePanel);
    var catalogSections = doc.getElementById('catalogSections');
    if (catalogSections) catalogSections.addEventListener('click', function (event) {
      var button = (event.target as Element).closest<HTMLElement>('[data-catalog-view]');
      if (!button) return;
      setCatalogView(button.getAttribute('data-catalog-view'));
    });

    el.sortButton.addEventListener('click', function () {
      state.sortByCount = !state.sortByCount;
      renderCatalog();
    });
    el.filters.addEventListener('click', function (event) {
      var chip = (event.target as Element).closest<HTMLElement>('.filter-chip');
      if (!chip) return;
      if (chip.hasAttribute('data-type')) {
        state.catalogView = state.tab === 'systems' ? 'systems' : null;
        updateCatalogSectionState();
        var type = chip.getAttribute('data-type');
        if (!type) {
          state.activeTypes = [];
        } else {
          var typeIndex = state.activeTypes.indexOf(type);
          if (typeIndex > -1) state.activeTypes.splice(typeIndex, 1);
          else state.activeTypes.push(type);
        }
      } else if (chip.hasAttribute('data-faction')) {
        var faction = chip.getAttribute('data-faction');
        if (!faction) {
          state.activeFactions = [];
        } else {
          var index = state.activeFactions.indexOf(faction);
          if (index > -1) state.activeFactions.splice(index, 1);
          else state.activeFactions.push(faction);
        }
      }
      renderFilters();
      renderCatalog();
    });
    el.catalogList.addEventListener('click', function (event) {
      var row = (event.target as Element).closest<HTMLElement>('[data-system],[data-planet]');
      if (!row) return;
      if (row.hasAttribute('data-system')) kernel.dossier.selectSystem(row.getAttribute('data-system'), { center: true });
      else kernel.dossier.selectPlanet(row.getAttribute('data-planet'), { center: true });
    });

    // поиск
    el.searchInput.addEventListener('input', updateSuggestions);
    el.searchInput.addEventListener('focus', function () { updateSuggestions(); });
    el.searchInput.addEventListener('keydown', function (event) {
      var results = el.suggestions._results || [];
      if (event.key === 'Escape') { el.searchInput.value = ''; updateSuggestions(); return; }
      if (event.key === 'Enter') {
        if (results.length) openSuggestion(results[0]);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!results.length) return;
        var buttons = Array.from(el.suggestions.querySelectorAll<HTMLElement>('.suggestion'));
        if (!buttons.length) return;
        var current = buttons.indexOf(el.suggestions.querySelector<HTMLElement>('.suggestion.active') as HTMLElement);
        var next = event.key === 'ArrowDown'
          ? (current + 1 + buttons.length) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
        buttons.forEach(function (button) { button.classList.remove('active'); });
        buttons[next]!.classList.add('active');
        buttons[next]!.scrollIntoView({ block: 'nearest' });
      }
    });
    el.clearSearch.addEventListener('click', function () {
      el.searchInput.value = '';
      updateSuggestions();
      el.searchInput.focus();
    });
    el.suggestions.addEventListener('click', function (event) {
      var button = (event.target as Element).closest<HTMLElement>('.suggestion');
      if (!button) return;
      var results = el.suggestions._results || [];
      openSuggestion(results[Number(button.getAttribute('data-index'))]);
    });
    doc.addEventListener('click', function (event) {
      if (!el.searchWrap.contains(event.target as Node)) el.suggestions.hidden = true;
    });
  }
  return {
    bind,
    detectSkin,
    setPanelOpen,
    updateSearchHintDistance,
    updateSuggestions,
    matchesCatalogView,
    catalogViewForPlace,
    updateCatalogSectionState,
    setCatalogView,
    renderFilters,
    renderCatalog,
  };
}
