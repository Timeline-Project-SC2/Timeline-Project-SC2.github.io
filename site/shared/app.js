/*!
 * Map Atlas — интерфейс атласа.
 * Статика без зависимостей: canvas-рендер тайлов с LOD, маркеры систем,
 * поиск, каталог, досье и слой подписей карты.
 *
 * Данные: /data/meta.json, /data/systems.json, /data/planets.json,
 *         /data/system-overrides.json, /data/map-labels.json.
 * Растр:  /assets/tiles.json (+ /assets/tiles/<level>/<x>_<y>.webp) либо
 *         /assets/map-preview.webp.
 * Пути от корня сайта: страницы лежат в site/<страница>/, общий код — в site/shared/. Если растра нет — рисуется схема с сеткой,
 *         звёздным полем и слоем подписей, снятых с карты.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ конфигурация */

  var CONFIG = {
    storage: {
      labels: 'map.atlas.labels.v1'
    },
    data: {
      dir: '/data/',
      meta: 'meta.json',
      systems: 'systems.json',
      planets: 'planets.json',
      overrides: 'system-overrides.json',
      labels: 'map-labels.json'
    },
    tiles: {
      manifest: '/assets/tiles.json',
      dir: '/assets/tiles',
      cacheLimit: 260
    },
    view: {
      fitInset: 0.94,      // «вся карта» с небольшим запасом по краям
      minFactor: 0.62,     // насколько можно отъехать от режима «вся карта»
      maxFactor: 22,       // предел приближения относительно «вся карта»
      panMargin: 0.25,     // карта может уйти внутрь экрана на эту долю размера экрана (как на галактике)
      wheelStep: 0.0016,
      animate: 340
    },
    layers: {
      systemLabelScale: 0.055,  // подписи систем с подтверждённой координатой
      labelScale: 0.11,         // подписи объектов карты
      noisyLabelScale: 0.5,     // «шумные» подписи OCR — только крупно
      labelBudget: 120
    },
    markerLod: {
      // Базовые размеры заданы в координатах 10k-карты: при приближении они
      // растут вместе с растром. min/max оставляют обзор читаемым и безопасным.
      worldRadius: 30,
      minRadius: 7,
      maxRadius: 46,
      worldFont: 38,
      minFont: 9.5,
      maxFont: 56,
      labelBudgetMin: 16,
      labelBudgetMax: 54
    },
    hitRadius: 15,
    maxSuggestions: 22
  };

  /* ------------------------------------------------------------------ утилиты */

  var doc = document;
  var loaderDismissed = false;

  // Экран загрузки уходит сразу, как страница готова: искусственной паузы нет.
  // Вызывается после первой отрисовки canvas (см. boot) и по таймауту-страховке.
  function dismissTimelineLoader() {
    if (loaderDismissed) return;
    var loader = doc.getElementById('timelineLoader');
    if (!loader) { loaderDismissed = true; return; }
    loaderDismissed = true;
    loader.classList.add('is-leaving');
    window.setTimeout(function () {
      loader.classList.add('is-hidden');
      loader.setAttribute('aria-hidden', 'true');
    }, 480);
  }

  function qs(selector, root) { return (root || doc).querySelector(selector); }

  function clamp(value, min, max) { return value < min ? min : (value > max ? max : value); }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function normalize(value) {
    if (!value) return '';
    return String(value)
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[^\wа-я\s-]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function searchKey(value) {
    return normalize(value).replace(/^система\s+/, '');
  }

  function plural(count, forms) {
    var n = Math.abs(count) % 100;
    var n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  }

  function formatNumber(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
  }

  function cssVar(name, fallback) {
    var value = getComputedStyle(doc.documentElement).getPropertyValue(name);
    value = (value || '').trim();
    return value || fallback;
  }

  function hash(value) {
    var h = 2166136261;
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function rng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function readJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) { return fallback; }
  }

  function writeJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* приватный режим */ }
  }

  function assetVersion() {
    var script = doc.currentScript;
    if (!script || !script.src) return '';
    try { return new URL(script.src).searchParams.get('v') || ''; } catch (err) { return ''; }
  }

  /* ------------------------------------------------------------------ состояние */

  var state = {
    meta: null,
    systemsRaw: [],       // базовый каталог систем
    systems: [],          // разрешённые системы (база + оверрайды из data/system-overrides.json)
    planets: [],
    labels: [],
    overrides: null,
    tiles: null,
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
    labelsOn: readJSON(CONFIG.storage.labels, false) === true,
    hoverId: null,
    hoverPoiId: null,
    activeSystemId: null,
    activePlanetId: null,
    pinned: false,
    rasterMode: 'none',
    view: { scale: 1, tx: 0, ty: 0 },
    viewport: { w: 1, h: 1 },
    dpr: 1
  };

  var theme = {
    bg: cssVar('--bg', '#05080e'),
    accent: cssVar('--accent', '#b5d3fa'),
    accent2: cssVar('--accent-2', '#80a9da'),
    text: cssVar('--white', '#f5f8fc'),
    muted: cssVar('--muted', '#8996a8'),
    line: cssVar('--line-strong', 'rgba(172,194,221,.28)'),
    mono: cssVar('--mono', 'Consolas, monospace')
  };

  var el = {};
  var skin = { panelOffCanvas: false, panelBottomSheet: false, panelSidebar: false, panelOpen: false };
  var canvas = null;
  var ctx = null;
  var renderQueued = false;
  var toastsTimer = null;
  var coordinateReadoutEnabled = false;
  var coordinatePointer = null;

  /* ------------------------------------------------------------------ загрузка данных */

  function fetchJSON(url, fallback) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .catch(function () { return fallback; });
  }

  function splitCSVLine(line) {
    var result = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { cur += c; }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { result.push(cur); cur = ''; }
        else { cur += c; }
      }
    }
    result.push(cur);
    return result;
  }

  function parseCSV(text) {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    var headers = splitCSVLine(lines[0]).map(function (h) { return h.trim(); });
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = splitCSVLine(lines[i]);
      var obj = {};
      headers.forEach(function (h, idx) { obj[h] = (cols[idx] || '').trim(); });
      if (Object.keys(obj).every(function (k) { return obj[k] === ''; })) continue;
      rows.push(obj);
    }
    return rows;
  }

  function fetchCSV(url) {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(parseCSV)
      .catch(function () { return []; });
  }

  function mapSystemRow(row) {
    return {
      id: row.system_id || row.id || row.name,
      name: row.name || '',
      nameEn: row.name || '',
      // Systems use a dedicated classification tag; blank values mean no highlight.
      systemType: String(row.type || 'none').trim().toLowerCase(),
      // CSV estimates are not map positions. A marker needs an explicit map override.
      coord: null,
      coordSource: null,
      primaryFaction: row.faction || '',
      factions: row.faction ? [row.faction] : [],
      note: row.description || '',
      sourceUrl: row.source_url || '',
      worlds: [],
      planetIds: []
    };
  }

  function mergeSystemTypes(systems, rows) {
    if (!systems || !systems.length || !rows || !rows.length) return systems;
    var typesByKey = {};
    rows.forEach(function (row) {
      var type = String(row.type || 'none').trim().toLowerCase();
      [row.system_id || row.id, row.name].forEach(function (key) {
        var normalized = normalize(key);
        if (normalized) typesByKey[normalized] = type;
      });
    });
    return systems.map(function (system) {
      var keys = [system.id, system.system_id, system.name];
      for (var i = 0; i < keys.length; i++) {
        var normalized = normalize(keys[i]);
        if (normalized && Object.prototype.hasOwnProperty.call(typesByKey, normalized)) {
          return Object.assign({}, system, { systemType: typesByKey[normalized] });
        }
      }
      return system;
    });
  }

  function mapPlaceRow(row) {
    var xText = row.x == null ? '' : String(row.x).trim();
    var yText = row.y == null ? '' : String(row.y).trim();
    var x = xText ? Number(xText) : NaN;
    var y = yText ? Number(yText) : NaN;
    var coord = isFinite(x) && isFinite(y) ? [x, y] : null;
    var systemId = String(row.system_id || '').trim();
    var pointOfInterest = !systemId && !!coord;
    return {
      id: row.ID || row.id || row.name,
      name: row.name || '',
      nameEn: row.name || '',
      // если в таблице нет колонки type, место считается просто местом (placeTypesOf
      // подставит 'planet'); 'other' присваиваем только когда он указан явно
      placeTypes: row.type ? [row.type] : [],
      systemId: systemId || null,
      system: systemId || null,
      coord: coord,
      pointOfInterest: pointOfInterest,
      mapCoord: pointOfInterest ? { x: x, y: y } : null,
      primaryFaction: row.faction || '',
      factions: row.faction ? [row.faction] : [],
      note: row.description || '',
      sourceUrl: row.source_url || '',
      wikiCategories: []
    };
  }

  function mergeStandalonePoiRows(places, rows) {
    var result = places || [];
    var byId = Object.create(null);
    result.forEach(function (place) { byId[String(place.id)] = place; });

    (rows || []).map(mapPlaceRow).forEach(function (sheetPlace) {
      if (!sheetPlace.pointOfInterest) return;
      var existing = byId[String(sheetPlace.id)];
      if (!existing) {
        result.push(sheetPlace);
        byId[String(sheetPlace.id)] = sheetPlace;
        return;
      }
      // A populated system_id always wins: only genuinely standalone rows become POIs.
      if (existing.systemId) return;
      existing.pointOfInterest = true;
      existing.coord = sheetPlace.coord;
      existing.mapCoord = sheetPlace.mapCoord;
      if ((!existing.placeTypes || !existing.placeTypes.length) && sheetPlace.placeTypes.length) {
        existing.placeTypes = sheetPlace.placeTypes;
      }
    });
    return result;
  }

  function loadDataset() {
    var inline = window.__MAP_DATA__;
    if (inline && inline.systems) {
      return Promise.all([
        fetchCSV('/data/systems.csv'),
        fetchCSV('/data/places.csv')
      ]).then(function (rows) {
        var planets = inline.planets || [];
        planets = planets.length
          ? mergeStandalonePoiRows(planets, rows[1])
          : rows[1].map(mapPlaceRow);
        return {
          meta: inline.meta || {},
          systems: mergeSystemTypes(inline.systems || [], rows[0]),
          planets: planets,
          overrides: inline.overrides || { systems: {} },
          labels: inline.labels || [],
          tiles: null
        };
      });
    }

    var v = assetVersion();
    var suffix = v ? ('?v=' + encodeURIComponent(v)) : '';
    var dir = CONFIG.data.dir;

    // Сначала метаданные: в них флаг сборки растра, от которого зависит, нужно ли
    // вообще запрашивать assets/tiles.json (иначе на каждый заход будет 404).
    return fetchJSON(dir + CONFIG.data.meta + suffix, {}).then(function (meta) {
      if (meta && meta.generatedAt && !meta.generated) meta.generated = meta.generatedAt;
      var wantsRaster = !!(meta && meta.assets && meta.assets.hasRaster);
      return Promise.all([
        fetchJSON(dir + CONFIG.data.systems + suffix, []),
        fetchJSON(dir + CONFIG.data.planets + suffix, []),
        fetchJSON(dir + CONFIG.data.overrides + suffix, { systems: {} }),
        fetchJSON(dir + CONFIG.data.labels + suffix, []),
        wantsRaster ? fetchJSON(CONFIG.tiles.manifest + suffix, null) : Promise.resolve(null),
        fetchCSV('/data/systems.csv' + suffix),
        fetchCSV('/data/places.csv' + suffix)
      ]).then(function (parts) {
        var systems = parts[0];
        var planets = parts[1];
        if ((!systems || !systems.length) && parts[5] && parts[5].length) {
          systems = parts[5].map(mapSystemRow);
        }
        if ((!planets || !planets.length) && parts[6] && parts[6].length) {
          planets = parts[6].map(mapPlaceRow);
        } else {
          planets = mergeStandalonePoiRows(planets || [], parts[6]);
        }
        systems = mergeSystemTypes(systems, parts[5]);
        return {
          meta: meta, systems: systems, planets: planets,
          overrides: parts[2], labels: parts[3], tiles: parts[4]
        };
      });
    });
  }

  /* ------------------------------------------------------------------ модель */

  function applyOverrides(system) {
    var override = (state.overrides && state.overrides.systems && state.overrides.systems[system.id]) || null;

    var resolved = Object.assign({}, system);
    resolved.name = system.name;
    resolved.note = system.note;
    // Do not turn fallback/estimated coordinates into visible system markers.
    // Only explicit map overrides place a system on the map.
    resolved.coord = null;
    resolved.coordSource = null;
    resolved.override = override;

    if (override) {
      var point = null;
      var x = explicitMapNumber(override.x);
      var y = explicitMapNumber(override.y);
      if (x !== null && y !== null) {
        point = { x: x, y: y };
      } else {
        var xNorm = explicitMapNumber(override.x_norm);
        var yNorm = explicitMapNumber(override.y_norm);
        if (xNorm !== null && yNorm !== null) {
          point = {
            x: Math.round(xNorm * mapSize()),
            y: Math.round(yNorm * mapSize())
          };
        }
      }
      if (coordinateOnMap(point)) {
        resolved.coord = [point.x, point.y];
        resolved.coordSource = 'map';
      }
      if (override.name) resolved.name = override.name;
      if (override.description) resolved.note = override.description;
      if (override.faction) {
        resolved.primaryFaction = override.faction;
        resolved.factions = [override.faction].concat(system.factions || []);
      }
      resolved.mapLabel = override.label || null;
      resolved.mapConfidence = override.confidence || null;
      resolved.fromSheet = override.confidence === 'sheet' || override.source === 'google-sheets';
    }

    return resolved;
  }

  function mapSize() {
    return (state.meta && state.meta.mapSize) || 10000;
  }

  function explicitMapNumber(value) {
    if (value == null || (typeof value === 'string' && !value.trim())) return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function coordinateOnMap(point) {
    var size = mapSize();
    return !!point && isFinite(point.x) && isFinite(point.y) &&
      point.x >= 0 && point.y >= 0 && point.x <= size && point.y <= size;
  }

  // миры системы: сначала явные planetIds, затем планеты со ссылкой systemId
  function attachWorlds(system) {
    var list = [];
    (system.planetIds || []).forEach(function (id) {
      if (state.planetsById[id]) list.push(state.planetsById[id]);
    });
    state.planets.forEach(function (planet) {
      if (planet.systemId === system.id && list.indexOf(planet) === -1) list.push(planet);
    });
    system.worlds = list;
    return system;
  }

  function buildModel() {
    state.systems = (state.systemsRaw || []).map(function (system) {
      return attachWorlds(applyOverrides(system));
    });
    state.systemsById = {};
    state.planetsById = {};
    state.planetByName = {};

    state.systems.forEach(function (system) { state.systemsById[system.id] = system; });
    state.planets.forEach(function (planet) {
      state.planetsById[planet.id] = planet;
      state.planetByName[normalize(planet.name)] = planet;
    });

    state.order.systems = state.systems.map(function (system) { return system.id; });
    state.order.planets = state.planets.map(function (planet) { return planet.id; });

    buildSearchIndex();
    buildFacets();
  }

  // Перечень совпадает с docs/ADMIN_GUIDE.md; для каждого типа есть метка, чтобы
  // в каталоге не показывалось сырое значение из таблицы.
  var PLACE_TYPES = {
    planet: { label: 'Планета', plural: 'планеты', glyph: 'П' },
    moon: { label: 'Луна', plural: 'луны', glyph: 'Л' },
    asteroid: { label: 'Астероид', plural: 'астероиды', glyph: 'А' },
    station: { label: 'Станция', plural: 'станции', glyph: 'С' },
    platform: { label: 'Платформа', plural: 'платформы', glyph: 'Ф' },
    other: { label: 'Иное место', plural: 'иные места', glyph: 'И' }
  };

  function placeTypesOf(place) {
    return (place.placeTypes && place.placeTypes.length) ? place.placeTypes : ['planet'];
  }

  function primaryPlaceType(place) {
    return placeTypesOf(place)[0];
  }

  function placeTypeLabel(place, all) {
    var types = placeTypesOf(place);
    if (!all) types = types.slice(0, 1);
    return types.map(function (type) {
      if (type === 'station') return isPlatformPlace(place) ? 'Платформа' : 'Станция';
      return (PLACE_TYPES[type] || { label: type }).label;
    }).join(' · ');
  }

  function placeTypeGlyph(place) {
    var primary = primaryPlaceType(place);
    if (primary === 'station') return isPlatformPlace(place) ? 'ПТ' : 'СТ';
    var type = PLACE_TYPES[primary] || { glyph: 'М' };
    return type.glyph;
  }

  function factionsOf(planet) {
    return (planet.factions && planet.factions.length) ? planet.factions : ['Не указано'];
  }

  function buildFacets() {
    var counter = {};
    state.systems.forEach(function (system) {
      var list = system.worlds.length
        ? system.worlds.reduce(function (acc, planet) { return acc.concat(factionsOf(planet)); }, [])
        : (system.factions || []);
      (list.length ? list : ['Не указано']).forEach(function (faction) {
        counter[faction] = (counter[faction] || 0) + 1;
      });
    });
    state.factionsByPlanet = counter;
  }

  function systemFactions(system) {
    var set = [];
    system.worlds.forEach(function (planet) {
      factionsOf(planet).forEach(function (faction) {
        if (set.indexOf(faction) === -1) set.push(faction);
      });
    });
    if (!set.length) set = (system.factions || []).slice();
    if (system.primaryFaction && set.indexOf(system.primaryFaction) === -1) set.unshift(system.primaryFaction);
    return set;
  }

  /* ------------------------------------------------------------------ индекс поиска */

  var searchIndex = [];

  function buildSearchIndex() {
    searchIndex = [];

    state.systems.forEach(function (system) {
      searchIndex.push({
        kind: 'system',
        kindLabel: 'Система',
        glyph: 'S',
        id: system.id,
        title: system.name,
        subtitle: system.worlds.length + ' ' + plural(system.worlds.length, ['мир', 'мира', 'миров']),
        key: searchKey(system.name),
        extra: normalize((system.primaryFaction || '') + ' ' + (system.note || ''))
      });
    });

    state.planets.forEach(function (planet) {
      var system = planet.systemId ? state.systemsById[planet.systemId] : null;
      searchIndex.push({
        kind: 'planet',
        kindLabel: placeTypeLabel(planet, true),
        glyph: placeTypeGlyph(planet),
        id: planet.id,
        title: planet.name,
        subtitle: placeTypeLabel(planet, true) + ' · ' + (system ? system.name : 'система не указана'),
        key: searchKey(planet.name),
        extra: normalize(placeTypeLabel(planet, true) + ' ' + factionsOf(planet).join(' ') + ' ' + (planet.terrain || []).join(' ') + ' ' + (planet.nameEn || ''))
      });
    });

    (state.labels || []).forEach(function (label) {
      if (label.linkedSystemId || label.linkedPlanetId) {
        searchIndex.push({
          kind: 'marker',
          kindLabel: 'Подпись карты',
          glyph: '⌖',
          id: label.name + '@' + label.x + ',' + label.y,
          title: label.name + ' (подпись карты)',
          subtitle: 'x ' + label.x + ' · y ' + label.y + (label.conf ? ' · OCR ' + label.conf : ''),
          key: searchKey(label.name),
          extra: normalize(label.kind)
        });
      }
    });
  }

  function score(entry, needle) {
    var key = entry.key;
    if (!needle) return 0;
    if (key === needle) return 1200;
    if (key.indexOf(needle) === 0) return 900 - key.length;
    var word = key.split(/[\s-]+/);
    for (var i = 0; i < word.length; i++) {
      if (word[i].indexOf(needle) === 0) return 700 - key.length;
    }
    if (key.indexOf(needle) > -1) return 480 - key.length;
    if (entry.extra.indexOf(needle) > -1) return 260 - key.length;
    // разреженное совпадение: а-и-у-р
    var pos = 0, hits = 0;
    for (var c = 0; c < key.length && pos < needle.length; c++) {
      if (key[c] === needle[pos]) { pos++; hits++; }
    }
    if (pos === needle.length && needle.length >= 3) return 150 + hits - key.length;
    return 0;
  }

  function search(query) {
    var needle = normalize(query);
    if (needle.length < 1) return [];
    var results = [];
    for (var i = 0; i < searchIndex.length; i++) {
      var entry = searchIndex[i];
      var value = score(entry, needle);
      // подписи карты — вспомогательный слой: уступают системам и планетам каталога
      if (entry.kind === 'marker') value -= 140;
      if (value > 0) results.push({ entry: entry, value: value });
    }
    results.sort(function (a, b) {
      if (b.value !== a.value) return b.value - a.value;
      return a.entry.title.length - b.entry.title.length;
    });
    return results.slice(0, CONFIG.maxSuggestions).map(function (item) { return item.entry; });
  }

  /* ------------------------------------------------------------------ представление карты */

  function fitScale() {
    var size = mapSize();
    var pad = CONFIG.view.fitInset;
    return Math.min(state.viewport.w, state.viewport.h) / size * pad;
  }

  // Каталог лежит поверх карты и не меняет размер сцены. Ширина «занятой» полосы
  // берётся из CSS (--panel-inset): ею же пользуются чипы внизу и заголовок раздела,
  // поэтому вся обвеска двигается синхронно с панелью, а сама карта — ни на пиксель.
  function panelInset() {
    if (!el.mapStage) return 0;
    var raw = '';
    try { raw = getComputedStyle(el.mapStage).getPropertyValue('--panel-inset'); } catch (err) { raw = ''; }
    var value = parseFloat(raw);
    if (!isFinite(value) || value < 0) return 0;
    return Math.min(value, state.viewport.w * 0.5);
  }

  function minScale() { return fitScale() * CONFIG.view.minFactor; }
  function maxScale() { return fitScale() * CONFIG.view.maxFactor; }

  function fitView() {
    var size = mapSize();
    var scale = fitScale();
    state.view.scale = scale;
    var inset = panelInset();
    var span = size * scale;
    // центр «свободной» зоны справа от каталога: карта не уезжает под панель
    state.view.tx = inset + (state.viewport.w - inset - span) / 2;
    state.view.ty = (state.viewport.h - span) / 2;
    clampView();
  }

  // Запас CONFIG.view.panMargin от размера экрана: карту можно сдвинуть выше-ниже и левее-правее
  // дальше краёв, как на галактике. Когда карта меньше экрана, она свободно ходит внутри запаса.
  function clampAxis(value, span, viewport) {
    var m = viewport * CONFIG.view.panMargin;
    if (span <= viewport) {
      var c = (viewport - span) / 2;
      return clamp(value, c - m, c + m);
    }
    return clamp(value, viewport - span - m, m);
  }

  function clampView() {
    var size = mapSize();
    var scale = clamp(state.view.scale, minScale(), maxScale());
    state.view.scale = scale;
    var span = size * scale;
    state.view.tx = clampAxis(state.view.tx, span, state.viewport.w);
    state.view.ty = clampAxis(state.view.ty, span, state.viewport.h);
  }

  function toScreen(worldX, worldY) {
    return { x: state.view.tx + worldX * state.view.scale, y: state.view.ty + worldY * state.view.scale };
  }

  function toWorld(screenX, screenY) {
    return { x: (screenX - state.view.tx) / state.view.scale, y: (screenY - state.view.ty) / state.view.scale };
  }

  function zoomAt(screenX, screenY, factor) {
    var before = toWorld(screenX, screenY);
    var next = clamp(state.view.scale * factor, minScale(), maxScale());
    if (next === state.view.scale) return;
    state.view.scale = next;
    var after = toWorld(screenX, screenY);
    state.view.tx += (after.x - before.x) * next;
    state.view.ty += (after.y - before.y) * next;
    clampView();
    requestRender();
  }

  var animation = null;

  function animateTo(scale, tx, ty) {
    animation = {
      from: { scale: state.view.scale, tx: state.view.tx, ty: state.view.ty },
      to: { scale: clamp(scale, minScale(), maxScale()), tx: tx, ty: ty },
      start: performance.now()
    };
    requestRender();
  }

  function stepAnimation(now) {
    if (!animation) return false;
    var t = clamp((now - animation.start) / CONFIG.view.animate, 0, 1);
    var k = easeOutCubic(t);
    state.view.scale = animation.from.scale + (animation.to.scale - animation.from.scale) * k;
    state.view.tx = animation.from.tx + (animation.to.tx - animation.from.tx) * k;
    state.view.ty = animation.from.ty + (animation.to.ty - animation.from.ty) * k;
    if (t >= 1) animation = null;
    return true;
  }

  function centerOn(worldX, worldY, scale) {
    var target = scale || Math.max(state.view.scale, fitScale() * 2.6);
    var tx = state.viewport.w / 2 - worldX * target;
    var ty = state.viewport.h / 2 - worldY * target;
    var size = mapSize();
    tx = clampAxis(tx, size * target, state.viewport.w);
    ty = clampAxis(ty, size * target, state.viewport.h);
    animateTo(target, tx, ty);
  }

  /* ------------------------------------------------------------------ растр: тайлы и предпросмотр */

  var tiles = {
    levels: [],
    tileSize: 512,
    dir: CONFIG.tiles.dir,
    // ?v= от сборки: Pages держит файлы 10 минут, а после пересборки тайлов
    // их адреса не меняются. Версия из манифеста заставляет браузер взять свежие.
    version: '',
    preview: null,
    cache: {},
    loading: {},
    failed: {},
    previewState: 'idle',
    visible: {},
    counter: 0
  };

  function rasterExpected(meta) {
    // за флагом следит сборка тайлов; без него нет смысла ловить 404 на каждый запрос
    return !!(meta && meta.assets && meta.assets.hasRaster);
  }

  function configureTiles(manifest, meta) {
    tiles.levels = [];
    tiles.preview = null;
    tiles.version = (manifest && manifest.version) ? ('?v=' + encodeURIComponent(manifest.version)) : tiles.version;
    tiles.cache = {}; tiles.loading = {}; tiles.failed = {};

    if (manifest && manifest.levels && manifest.levels.length) {
      var size = manifest.mapSize || mapSize();
      tiles.tileSize = manifest.tileSize || 512;
      tiles.dir = (manifest.dir || CONFIG.tiles.dir).replace(/\/$/, '');
      tiles.preview = manifest.preview || null;
      tiles.version = manifest.version ? ('?v=' + encodeURIComponent(manifest.version)) : '';
      tiles.levels = manifest.levels.map(function (level, index) {
        var width = level.width || level.size || (meta.levels && meta.levels[index]) || size;
        return {
          index: level.index != null ? level.index : index,
          width: width,
          height: level.height || width,
          cols: level.cols || Math.ceil(width / tiles.tileSize),
          rows: level.rows || Math.ceil((level.height || width) / tiles.tileSize)
        };
      }).sort(function (a, b) { return a.width - b.width; });
      state.rasterMode = 'tiles';
    } else if ((window.SITE_LINKS && SITE_LINKS.sectorMapPreview) || rasterExpected(meta)) {
      // манифеста нет, но растр собран — пробуем один предпросмотр
      // (ссылка из links.js имеет приоритет над meta.json)
      var previewUrl = (window.SITE_LINKS && SITE_LINKS.sectorMapPreview) || (meta && meta.assets && meta.assets.preview) || '/assets/map-preview.webp';
      loadPreview(previewUrl + (manifest && manifest.version ? '?v=' + encodeURIComponent(manifest.version) : ''));
    }
  }

  function loadPreview(url) {
    var image = new Image();
    tiles.previewState = 'loading';
    image.onload = function () {
      tiles.previewImage = image;
      tiles.previewState = 'ready';
      state.rasterMode = 'preview';
      requestRender();
    };
    image.onerror = function () {
      tiles.previewState = 'missing';
      state.rasterMode = 'none';
      requestRender();
    };
    image.src = url;
  }

  function levelForScale(scale) {
    var size = mapSize();
    var need = size * scale;
    var chosen = tiles.levels[0];
    for (var i = 0; i < tiles.levels.length; i++) {
      chosen = tiles.levels[i];
      if (tiles.levels[i].width >= need) break;
    }
    return chosen;
  }

  function tileKey(level, col, row) { return level.index + '/' + col + '_' + row; }

  function ensureTile(level, col, row) {
    var key = tileKey(level, col, row);
    tiles.counter += 1;
    tiles.visible[key] = tiles.counter;
    if (tiles.cache[key] || tiles.loading[key] || tiles.failed[key]) return;
    tiles.loading[key] = true;
    var image = new Image();
    image.onload = function () {
      delete tiles.loading[key];
      tiles.cache[key] = image;
      requestRender();
      evictTiles();
    };
    image.onerror = function () {
      delete tiles.loading[key];
      tiles.failed[key] = true;
      tiles.failedCount = (tiles.failedCount || 0) + 1;
      // манифест есть, а файлов нет — показываем схему вместо пустого экрана
      if (tiles.failedCount >= 4 && !Object.keys(tiles.cache).length) {
        state.rasterMode = 'none';
        requestRender();
      }
    };
    image.src = tiles.dir + '/' + level.index + '/' + col + '_' + row + '.webp' + tiles.version;
  }

  function evictTiles() {
    var keys = Object.keys(tiles.cache);
    if (keys.length <= CONFIG.tiles.cacheLimit) return;
    keys.sort(function (a, b) { return (tiles.visible[a] || 0) - (tiles.visible[b] || 0); });
    var excess = keys.length - CONFIG.tiles.cacheLimit;
    for (var i = 0; i < excess; i++) delete tiles.cache[keys[i]];
  }

  function drawLevel(level) {
    // Один тайл — tiles.tileSize пикселей уровня, а не 1/cols карты.
    // Последняя колонка/строка неполная, поэтому size/cols сжимал растр:
    // для 1250 px и 3 колонок изображение кончалось на 84,7% мира, тогда как
    // маркеры продолжали рисоваться до 10000. Переводим каждый пиксель уровня
    // в мировые координаты напрямую — так растр и оверлеи совпадают пиксель-в-пиксель.
    var size = mapSize();
    var scale = state.view.scale;
    var worldPerPixelX = size / level.width;
    var worldPerPixelY = size / level.height;
    var tileWorldX = tiles.tileSize * worldPerPixelX;
    var tileWorldY = tiles.tileSize * worldPerPixelY;
    var view = state.view;

    var colFrom = Math.max(0, Math.floor((-view.tx) / (tileWorldX * scale)));
    var colTo = Math.min(level.cols - 1, Math.floor((state.viewport.w - view.tx) / (tileWorldX * scale)));
    var rowFrom = Math.max(0, Math.floor((-view.ty) / (tileWorldY * scale)));
    var rowTo = Math.min(level.rows - 1, Math.floor((state.viewport.h - view.ty) / (tileWorldY * scale)));

    var drawn = 0;
    for (var col = colFrom; col <= colTo; col++) {
      for (var row = rowFrom; row <= rowTo; row++) {
        ensureTile(level, col, row);
        var image = tiles.cache[tileKey(level, col, row)];
        if (!image) continue;
        var screen = toScreen(col * tileWorldX, row * tileWorldY);
        var width = image.naturalWidth * worldPerPixelX * scale;
        var height = image.naturalHeight * worldPerPixelY * scale;
        ctx.drawImage(image, screen.x, screen.y, width, height);
        drawn++;
      }
    }
    return drawn;
  }

  function drawRaster() {
    if (state.rasterMode === 'tiles') {
      var target = levelForScale(state.view.scale);
      var base = tiles.levels[0];
      if (base.index !== target.index) drawLevel(base);
      drawLevel(target);
      return;
    }
    if (state.rasterMode === 'preview' && tiles.previewImage) {
      var screen = toScreen(0, 0);
      var span = mapSize() * state.view.scale;
      ctx.drawImage(tiles.previewImage, screen.x, screen.y, span, span);
    }
  }

  /* ------------------------------------------------------------------ схематичная подложка */

  var starCache = null;

  function stars() {
    if (starCache) return starCache;
    var random = rng(100000);
    var size = mapSize();
    starCache = [];
    for (var i = 0; i < 900; i++) {
      starCache.push({
        x: random() * size,
        y: random() * size,
        r: 0.4 + random() * 1.5,
        a: 0.12 + random() * 0.5
      });
    }
    return starCache;
  }

  function drawSchematic() {
    var size = mapSize();
    var view = state.view;
    var scale = view.scale;

    ctx.save();
    ctx.fillStyle = '#03060c';
    ctx.fillRect(0, 0, state.viewport.w, state.viewport.h);

    // мягкие «облака» сектора, чтобы схема не выглядела пустой
    var clouds = [
      { x: 0.36, y: 0.30, r: 0.26, color: 'rgba(80,120,190,.16)' },
      { x: 0.62, y: 0.58, r: 0.30, color: 'rgba(180,120,60,.12)' },
      { x: 0.78, y: 0.30, r: 0.22, color: 'rgba(120,90,200,.10)' }
    ];
    clouds.forEach(function (cloud) {
      var center = toScreen(cloud.x * size, cloud.y * size);
      var radius = cloud.r * size * scale;
      if (radius < 12) return;
      var gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      gradient.addColorStop(0, cloud.color);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
    });

    var offset = toScreen(0, 0);
    var span = size * scale;

    // звёздное поле
    var list = stars();
    for (var i = 0; i < list.length; i++) {
      var star = list[i];
      var point = toScreen(star.x, star.y);
      if (point.x < -4 || point.y < -4 || point.x > state.viewport.w + 4 || point.y > state.viewport.h + 4) continue;
      ctx.globalAlpha = star.a;
      ctx.fillStyle = '#cfe0f5';
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(0.5, star.r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // сетка навигации
    var step = 1000;
    if (scale * step < 46) step = 2000;
    if (scale * step < 46) step = 5000;
    ctx.strokeStyle = 'rgba(150,180,215,.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= size; x += step) {
      var sx = Math.round(offset.x + x * scale) + 0.5;
      ctx.moveTo(sx, offset.y);
      ctx.lineTo(sx, offset.y + span);
    }
    for (var y = 0; y <= size; y += step) {
      var sy = Math.round(offset.y + y * scale) + 0.5;
      ctx.moveTo(offset.x, sy);
      ctx.lineTo(offset.x + span, sy);
    }
    ctx.stroke();

    // рамка сектора и угловые метки
    ctx.strokeStyle = 'rgba(190,212,240,.42)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offset.x + 0.5, offset.y + 0.5, span, span);
    ctx.fillStyle = 'rgba(190,212,240,.55)';
    ctx.font = '9px ' + theme.mono;
    if (scale > 0.09) {
      for (var gx = 0; gx <= size; gx += 2000) {
        var px = offset.x + gx * scale;
        ctx.fillText(String(gx), px + 3, offset.y + span - 4);
        ctx.fillText(String(gx), offset.x + 3, offset.y + gx * scale + 10);
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ слой подписей карты */

  function drawMapLabels() {
    var labels = state.labels;
    if (!labels || !labels.length) return;
    var scale = state.view.scale;
    if (scale < CONFIG.layers.labelScale) return;
    var fontSize = clamp(28 * scale, 8.5, 38);
    var glyph = clamp(11 * scale, 3, 13);
    var textGap = clamp(18 * scale, 6, 20);
    var collisionRadius = clamp(30 * scale, 9, 34);

    // Точки, где уже стоит маркер системы: он подписан своим именем, поэтому
    // одноимённая подпись из слоя карты была бы дублем.
    var markerPoints = {};
    visibleSystems().forEach(function (system) {
      markerPoints[Math.round(system.coord[0] / 8) + ':' + Math.round(system.coord[1] / 8)] = true;
    });
    visiblePointsOfInterest().forEach(function (place) {
      markerPoints[Math.round(place.mapCoord.x / 8) + ':' + Math.round(place.mapCoord.y / 8)] = true;
    });

    var budget = CONFIG.layers.labelBudget;
    var drawn = 0;
    var seen = {};
    var centerX = state.viewport.w / 2;
    var centerY = state.viewport.h / 2;
    var placed = [];

    // отбираем видимые подписи; приоритет — записи со связью в каталоге,
    // затем близость к центру экрана, чтобы бюджет доставался главному
    function labelRank(label) {
      if (label.linkedSystemId) return 0;
      if (label.linkedPlanetId) return 1;
      if (label.kind === 'system') return 2;
      if (label.kind === 'planet') return 3;
      return 4;
    }

    var candidates = [];
    for (var c = 0; c < labels.length; c++) {
      var candidate = labels[c];
      if (candidate.noisy && scale < CONFIG.layers.noisyLabelScale) continue;
      var candidatePoint = toScreen(candidate.x, candidate.y);
      if (candidatePoint.x < -60 || candidatePoint.y < -20 ||
          candidatePoint.x > state.viewport.w + 60 || candidatePoint.y > state.viewport.h + 20) continue;
      if (candidate.kind !== 'object' &&
          markerPoints[Math.round(candidate.x / 8) + ':' + Math.round(candidate.y / 8)]) continue;
      candidates.push({
        label: candidate,
        point: candidatePoint,
        rank: labelRank(candidate),
        distance: Math.hypot(candidatePoint.x - centerX, candidatePoint.y - centerY)
      });
    }
    candidates.sort(function (a, b) {
      return a.rank - b.rank || a.distance - b.distance;
    });

    ctx.save();
    ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
    ctx.textBaseline = 'middle';

    for (var i = 0; i < candidates.length && drawn < budget; i++) {
      var label = candidates[i].label;
      var key = normalize(label.name);
      if (seen[key]) continue;
      var point = candidates[i].point;
      // система и её планета стоят в одной точке: вторую подпись не дублируем
      var tooClose = false;
      for (var p = 0; p < placed.length; p++) {
        if (Math.abs(placed[p].x - point.x) < collisionRadius && Math.abs(placed[p].y - point.y) < collisionRadius) { tooClose = true; break; }
      }
      if (tooClose) continue;
      placed.push(point);
      seen[key] = true;
      drawn++;

      var linked = label.linkedSystemId && state.systemsById[label.linkedSystemId];
      var isSystem = label.kind === 'system' && !linked;
      ctx.strokeStyle = label.kind === 'system'
        ? 'rgba(214,178,110,.5)'
        : (label.kind === 'planet' ? 'rgba(190,205,225,.34)' : 'rgba(150,170,195,.26)');
      ctx.beginPath();
      ctx.moveTo(point.x - glyph, point.y);
      ctx.lineTo(point.x + glyph, point.y);
      ctx.moveTo(point.x, point.y - glyph);
      ctx.lineTo(point.x, point.y + glyph);
      ctx.stroke();

      if (isSystem) {
        ctx.fillStyle = 'rgba(226,196,130,.72)';
      } else {
        ctx.fillStyle = 'rgba(200,214,232,.5)';
      }
      ctx.lineWidth = clamp(fontSize * 0.28, 2.5, 7);
      ctx.strokeStyle = 'rgba(2,5,10,.75)';
      ctx.strokeText(label.name, point.x + textGap, point.y - textGap);
      ctx.fillText(label.name, point.x + textGap, point.y - textGap);
    }
    ctx.restore();
    return drawn;
  }

  /* ------------------------------------------------------------------ маркеры систем */

  function markerVisible(system) {
    if (state.mapFaction === 'all') return true;
    var factions = system.worlds.length ? systemFactions(system) : (system.factions || []);
    return factions.indexOf(state.mapFaction) > -1;
  }

  function visibleSystems() {
    var list = [];
    for (var i = 0; i < state.systems.length; i++) {
      if (state.systems[i].coord && markerVisible(state.systems[i])) list.push(state.systems[i]);
    }
    return list;
  }

  function visiblePointsOfInterest() {
    return state.planets.filter(function (place) {
      if (!place.pointOfInterest || place.systemId || !coordinateOnMap(place.mapCoord)) return false;
      return state.mapFaction === 'all' || factionsOf(place).indexOf(state.mapFaction) > -1;
    });
  }

  function markerMetrics(scale) {
    var lod = CONFIG.markerLod;
    var radius = clamp(lod.worldRadius * scale, lod.minRadius, lod.maxRadius);
    var fontSize = clamp(lod.worldFont * scale, lod.minFont, lod.maxFont);
    return {
      radius: radius,
      fontSize: fontSize,
      stroke: clamp(4.8 * scale, 1.25, 4.5),
      dot: clamp(7 * scale, 2.2, 10),
      gap: clamp(16 * scale, 5, 18),
      crossGap: clamp(6 * scale, 2, 7),
      crossLength: clamp(12 * scale, 3, 14),
      reviewDot: clamp(8 * scale, 3, 9),
      hitRadius: Math.max(CONFIG.hitRadius, radius + clamp(12 * scale, 5, 14))
    };
  }

  function boxesIntersect(a, b, padding) {
    padding = padding || 0;
    return !(a.right + padding <= b.left || a.left >= b.right + padding ||
      a.bottom + padding <= b.top || a.top >= b.bottom + padding);
  }

  function drawMarkers() {
    var scale = state.view.scale;
    var list = visibleSystems();
    var metrics = markerMetrics(scale);
    var showAllNames = state.labelsOn || scale >= 0.34;
    var entries = [];
    var labelCandidates = [];

    ctx.save();
    ctx.textBaseline = 'middle';

    // Сначала рисуются все круги. Размер в координатах мира умножается на
    // масштаб карты, а clamp удерживает маркеры читаемыми на обоих краях LOD.
    list.forEach(function (system) {
      var point = toScreen(system.coord[0], system.coord[1]);
      if (point.x < -80 || point.y < -80 || point.x > state.viewport.w + 80 || point.y > state.viewport.h + 80) return;

      var isHover = state.hoverId === system.id;
      var isActive = state.activeSystemId === system.id;
      var verified = system.coordSource === 'map';
      var fromLabel = verified && !system.fromSheet;
      var emphasis = (isHover ? clamp(5 * scale, 1.5, 4.5) : 0) +
        (isActive ? clamp(8 * scale, 1.6, 7) : 0);
      var radius = metrics.radius + emphasis;
      var color = verified ? theme.accent : theme.muted;
      var entry = {
        system: system, point: point, radius: radius, color: color,
        hover: isHover, active: isActive, verified: verified,
        fromLabel: fromLabel
      };
      entries.push(entry);

      ctx.save();
      if (isHover) {
        ctx.shadowColor = 'rgba(190,215,250,.55)';
        ctx.shadowBlur = clamp(32 * scale, 12, 30);
      }
      ctx.globalAlpha = verified ? 1 : (state.labelsOn ? 0.82 : 0.66);

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = metrics.stroke * (isHover ? 1.35 : 1);
      ctx.strokeStyle = color;
      if (!verified) {
        var dash = clamp(9 * scale, 3, 8);
        ctx.setLineDash([dash, dash]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (verified) {
        ctx.fillStyle = 'rgba(181,211,250,.16)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, metrics.dot, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // У систем с подписью на карте — масштабируемая крестовина точки.
      if (fromLabel) {
        var inner = radius + metrics.crossGap;
        var outer = inner + metrics.crossLength;
        ctx.beginPath();
        ctx.moveTo(point.x - outer, point.y); ctx.lineTo(point.x - inner, point.y);
        ctx.moveTo(point.x + inner, point.y); ctx.lineTo(point.x + outer, point.y);
        ctx.moveTo(point.x, point.y - outer); ctx.lineTo(point.x, point.y - inner);
        ctx.moveTo(point.x, point.y + inner); ctx.lineTo(point.x, point.y + outer);
        ctx.lineWidth = clamp(metrics.stroke * 0.72, 1, 3.2);
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.restore();

      if (system.needsReview) {
        ctx.beginPath();
        ctx.arc(point.x + radius * 0.72, point.y - radius * 0.72, metrics.reviewDot, 0, Math.PI * 2);
        ctx.fillStyle = '#e8a35c';
        ctx.fill();
      }

      var showName = showAllNames || isHover || isActive ||
        (fromLabel && scale >= CONFIG.layers.systemLabelScale);
      if (showName) {
        labelCandidates.push({
          entry: entry,
          priority: isActive ? 0 : (isHover ? 1 : (verified ? 2 : 3)),
          distance: Math.hypot(point.x - state.viewport.w / 2, point.y - state.viewport.h / 2)
        });
      }
    });

    // Подписи получают несколько позиций вокруг круга. На дальнем LOD бюджет
    // и проверка пересечений убирают кашу; active/hover остаются видимыми всегда.
    labelCandidates.sort(function (a, b) {
      return a.priority - b.priority || a.distance - b.distance;
    });
    var labelBudget = clamp(
      Math.round(CONFIG.markerLod.labelBudgetMin + scale * 48),
      CONFIG.markerLod.labelBudgetMin,
      CONFIG.markerLod.labelBudgetMax
    );
    if (scale >= 0.8) labelBudget = CONFIG.markerLod.labelBudgetMax;

    var markerBoxes = entries.map(function (entry) {
      return {
        id: entry.system.id,
        left: entry.point.x - entry.radius - metrics.crossLength,
        right: entry.point.x + entry.radius + metrics.crossLength,
        top: entry.point.y - entry.radius - metrics.crossLength,
        bottom: entry.point.y + entry.radius + metrics.crossLength
      };
    });
    var placed = [];
    var drawn = 0;

    for (var i = 0; i < labelCandidates.length && drawn < labelBudget; i++) {
      var candidate = labelCandidates[i];
      var e = candidate.entry;
      var text = e.system.name.replace(/^Система\s+/, '');
      var fontSize = metrics.fontSize * (e.active || e.hover ? 1.08 : 1);
      ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
      var width = ctx.measureText(text).width;
      var height = fontSize * 1.18;
      var gap = metrics.gap;
      var positions = [
        { x: e.point.x + e.radius + gap, y: e.point.y + e.radius * 0.56, align: 'left' },
        { x: e.point.x + e.radius + gap, y: e.point.y - e.radius * 0.56, align: 'left' },
        { x: e.point.x - e.radius - gap, y: e.point.y + e.radius * 0.56, align: 'right' },
        { x: e.point.x - e.radius - gap, y: e.point.y - e.radius * 0.56, align: 'right' }
      ];
      var chosen = null;

      for (var posIndex = 0; posIndex < positions.length; posIndex++) {
        var pos = positions[posIndex];
        var left = pos.align === 'left' ? pos.x : pos.x - width;
        var box = {
          left: left - 2, right: left + width + 2,
          top: pos.y - height / 2 - 2, bottom: pos.y + height / 2 + 2
        };
        var blocked = false;
        for (var m = 0; m < markerBoxes.length; m++) {
          if (markerBoxes[m].id !== e.system.id && boxesIntersect(box, markerBoxes[m], 2)) {
            blocked = true; break;
          }
        }
        if (!blocked) {
          for (var p = 0; p < placed.length; p++) {
            if (boxesIntersect(box, placed[p], 3)) { blocked = true; break; }
          }
        }
        if (!blocked) {
          chosen = { position: pos, box: box };
          break;
        }
      }

      // Фокус пользователя важнее автоматической раскладки.
      if (!chosen && candidate.priority <= 1) {
        var fallback = positions[0];
        chosen = {
          position: fallback,
          box: {
            left: fallback.x - 2, right: fallback.x + width + 2,
            top: fallback.y - height / 2 - 2, bottom: fallback.y + height / 2 + 2
          }
        };
      }
      if (!chosen) continue;

      placed.push(chosen.box);
      drawn++;
      ctx.textAlign = chosen.position.align;
      ctx.lineWidth = clamp(fontSize * 0.24, 2.6, 9);
      ctx.strokeStyle = 'rgba(2,5,10,.80)';
      ctx.fillStyle = e.hover || e.active
        ? theme.text
        : (e.verified ? 'rgba(230,240,252,.88)' : 'rgba(190,201,216,.74)');
      ctx.strokeText(text, chosen.position.x, chosen.position.y);
      ctx.fillText(text, chosen.position.x, chosen.position.y);
    }

    ctx.restore();
  }

  function drawPointsOfInterest() {
    var scale = state.view.scale;
    var list = visiblePointsOfInterest();
    ctx.save();
    ctx.textBaseline = 'middle';

    list.forEach(function (place) {
      var point = toScreen(place.mapCoord.x, place.mapCoord.y);
      if (point.x < -36 || point.y < -36 || point.x > state.viewport.w + 36 ||
          point.y > state.viewport.h + 36) return;

      var hovered = state.hoverPoiId === place.id;
      var active = state.activePlanetId === place.id;
      var radius = clamp(9 * scale, 4, 9) + (hovered || active ? clamp(3 * scale, 1, 3) : 0);
      var color = hovered || active ? theme.text : theme.accent2;

      ctx.save();
      if (hovered || active) {
        ctx.shadowColor = 'rgba(128,169,218,.72)';
        ctx.shadowBlur = clamp(24 * scale, 9, 26);
      }
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - radius);
      ctx.lineTo(point.x + radius, point.y);
      ctx.lineTo(point.x, point.y + radius);
      ctx.lineTo(point.x - radius, point.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(128,169,218,.24)';
      ctx.strokeStyle = color;
      ctx.lineWidth = clamp(2.4 * scale, 1.1, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      if (state.labelsOn || scale >= 0.34 || hovered || active) {
        var fontSize = clamp(25 * scale, 8, 18);
        ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
        ctx.textAlign = 'left';
        ctx.lineWidth = clamp(fontSize * 0.24, 2.5, 5);
        ctx.strokeStyle = 'rgba(2,5,10,.84)';
        ctx.fillStyle = color;
        ctx.strokeText(place.name, point.x + radius + 8, point.y - radius - 5);
        ctx.fillText(place.name, point.x + radius + 8, point.y - radius - 5);
      }
    });

    ctx.restore();
  }

  function drawPlanetFocus() {
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    if (!planet || !planet.mapCoord) return;
    var point = toScreen(planet.mapCoord.x, planet.mapCoord.y);
    var scale = state.view.scale;
    var color = theme.accent2;
    var radius = clamp(38 * scale, 11, 56);
    var armGap = clamp(12 * scale, 7, 18);
    var armLength = clamp(28 * scale, 12, 38);
    var fontSize = clamp(36 * scale, 10, 54);
    var labelGap = clamp(18 * scale, 7, 22);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = clamp(4.5 * scale, 1.2, 4.2);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(point.x - radius - armLength, point.y); ctx.lineTo(point.x - radius - armGap, point.y);
    ctx.moveTo(point.x + radius + armGap, point.y); ctx.lineTo(point.x + radius + armLength, point.y);
    ctx.moveTo(point.x, point.y - radius - armLength); ctx.lineTo(point.x, point.y - radius - armGap);
    ctx.moveTo(point.x, point.y + radius + armGap); ctx.lineTo(point.x, point.y + radius + armLength);
    ctx.stroke();
    ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = theme.text;
    ctx.lineWidth = clamp(fontSize * 0.25, 3, 9);
    ctx.strokeStyle = 'rgba(2,5,10,.82)';
    ctx.strokeText(planet.name, point.x + radius + labelGap, point.y - radius - labelGap);
    ctx.fillText(planet.name, point.x + radius + labelGap, point.y - radius - labelGap);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ цикл рендера */

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function render(now) {
    renderQueued = false;
    var running = stepAnimation(now || performance.now());
    if (running) requestRender();

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.viewport.w, state.viewport.h);

    if (state.rasterMode === 'tiles' || (state.rasterMode === 'preview' && tiles.previewImage)) {
      ctx.fillStyle = '#03060c';
      ctx.fillRect(0, 0, state.viewport.w, state.viewport.h);
      ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
      drawRaster();
    } else {
      drawSchematic();
    }

    drawMapLabels();
    drawMarkers();
    drawPointsOfInterest();
    drawPlanetFocus();

    updateZoomReadout();
    updateCoordinateReadout();
  }

  /* ------------------------------------------------------------------ события карты */

  var pointers = {};
  var pointerList = [];
  var drag = null;

  function localPoint(event) {
    var rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTestPointOfInterest(screenX, screenY) {
    var list = visiblePointsOfInterest();
    var best = null;
    var bestDistance = Infinity;
    var radius = clamp(16 * state.view.scale, 10, 18);
    for (var i = 0; i < list.length; i++) {
      var point = toScreen(list[i].mapCoord.x, list[i].mapCoord.y);
      var dx = point.x - screenX;
      var dy = point.y - screenY;
      var distance = dx * dx + dy * dy;
      if (distance <= radius * radius && distance < bestDistance) {
        best = list[i];
        bestDistance = distance;
      }
    }
    return best;
  }

  function hitTest(screenX, screenY) {
    var best = null;
    var bestDistance = Infinity;
    var list = state.systems;
    // метрики от масштаба, а не от системы: считаем один раз на вызов
    var metrics = markerMetrics(state.view.scale);
    var hoverBonus = clamp(5 * state.view.scale, 2, 7);
    for (var i = 0; i < list.length; i++) {
      var system = list[i];
      if (!system.coord) continue;
      var point = toScreen(system.coord[0], system.coord[1]);
      var dx = point.x - screenX;
      var dy = point.y - screenY;
      var distance = dx * dx + dy * dy; // сравниваем квадраты, корень — только для ответа
      var radius = metrics.hitRadius + (state.hoverId === system.id ? hoverBonus : 0);
      if (distance <= radius * radius && distance < bestDistance) {
        best = system;
        bestDistance = distance;
      }
    }
    return best;
  }

  function onPointerDown(event) {
    // Карту тащат левой кнопкой и колесом. Правая (контекстное меню на холсте отключено) и
    // боковые карту не двигают и систему не выбирают; курсор перетаскивания на них не включается.
    if (event.button > 1) return;
    canvas.setPointerCapture(event.pointerId);
    var point = localPoint(event);
    pointers[event.pointerId] = point;
    pointerList = Object.keys(pointers);

    if (pointerList.length === 1) {
      drag = {
        mode: 'pan',
        startX: point.x, startY: point.y,
        tx: state.view.tx, ty: state.view.ty, moved: false, shiftKey: event.shiftKey
      };
      canvas.classList.add('dragging');
    } else {
      drag = null;
      animation = null;
    }
  }

  function onPointerMove(event) {
    if (pointers[event.pointerId]) pointers[event.pointerId] = localPoint(event);
    var point = localPoint(event);
    coordinatePointer = coordinateReadoutEnabled && event.pointerType !== 'touch' ? point : null;
    updateCoordinateReadout();

    if (drag && drag.mode === 'pan' && pointerList.length === 1) {
      var dx = point.x - drag.startX;
      var dy = point.y - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      state.view.tx = drag.tx + dx;
      state.view.ty = drag.ty + dy;
      animation = null;
      clampView();
      requestRender();
      return;
    }

    if (pointerList.length === 2) {
      pinchUpdate();
      return;
    }

    // Наведение показывает карточку системы либо самостоятельной точки интереса.
    var hoveredPoi = hitTestPointOfInterest(point.x, point.y);
    var hovered = hoveredPoi ? null : hitTest(point.x, point.y);
    var poiId = hoveredPoi ? hoveredPoi.id : null;
    var hoverId = hovered ? hovered.id : null;
    var hoverChanged = poiId !== state.hoverPoiId || hoverId !== state.hoverId;
    if (hoverChanged) {
      state.hoverPoiId = poiId;
      state.hoverId = hoverId;
      canvas.classList.toggle('marker-hover', !!(poiId || hoverId));
      if (!state.pinned) {
        state.activeSystemId = hoverId;
        state.activePlanetId = poiId;
        renderDetail();
      }
      requestRender();
    }
  }

  var pinch = null;

  function pinchUpdate() {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return;
    var a = pointers[ids[0]];
    var b = pointers[ids[1]];
    var distance = Math.hypot(a.x - b.x, a.y - b.y);
    var center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!pinch) { pinch = { distance: distance, center: center }; return; }
    if (pinch.distance > 0) zoomAt(center.x, center.y, distance / pinch.distance);
    pinch.distance = distance;
    pinch.center = center;
  }

  function onPointerUp(event) {
    var point = pointers[event.pointerId] || localPoint(event);
    delete pointers[event.pointerId];
    pointerList = Object.keys(pointers);
    if (pointerList.length < 2) pinch = null;
    if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    canvas.classList.remove('dragging');

    var finished = drag;
    drag = null;
    if (!finished) return;

    if (finished.mode === 'pan' && !finished.moved) {
      if (event.shiftKey || finished.shiftKey) {
        event.preventDefault();
        copyMapCoordinates(point);
        return;
      }
      var placeHit = hitTestPointOfInterest(point.x, point.y);
      var hit = placeHit ? null : hitTest(point.x, point.y);
      if (placeHit) {
        selectPlanet(placeHit.id, { pin: true, center: false });
      } else if (hit) {
        selectSystem(hit.id, { pin: true, center: false });
      } else if (state.pinned) {
        clearDetail();
      }
    }
  }

  function onWheel(event) {
    event.preventDefault();
    animation = null;
    var point = localPoint(event);
    var factor = Math.exp(-event.deltaY * CONFIG.view.wheelStep);
    zoomAt(point.x, point.y, factor);
  }

  function onDoubleClick(event) {
    var point = localPoint(event);
    zoomAt(point.x, point.y, 1.8);
  }

  /* ------------------------------------------------------------------ доступ к записям */

  function selectSystem(id, options) {
    options = options || {};
    var system = state.systemsById[id];
    if (!system) return;
    if (state.tab !== 'systems' || state.catalogView !== 'systems') setCatalogView('systems');
    state.activeSystemId = id;
    state.activePlanetId = null;
    if (options.pin) state.pinned = true;
    if (options.center !== false && system.coord) centerOn(system.coord[0], system.coord[1]);
    renderDetail();
    renderCatalog();
    updateHash();
    requestRender();
  }

  function selectPlanet(id, options) {
    options = options || {};
    var planet = state.planetsById[id];
    if (!planet) return;
    var targetView = catalogViewForPlace(planet);
    if (state.tab !== 'planets' || state.catalogView !== targetView) setCatalogView(targetView);
    state.activePlanetId = id;
    state.pinned = true;
    state.activeSystemId = planet.systemId && state.systemsById[planet.systemId]
      ? planet.systemId : null;
    if (options.center !== false) {
      if (planet.pointOfInterest && coordinateOnMap(planet.mapCoord)) {
        centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, fitScale() * 3.4));
      } else if (!planet.pointOfInterest && planet.mapCoord) {
        centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, fitScale() * 3.4));
      } else if (planet.systemId) {
        var system = state.systemsById[planet.systemId];
        if (system && system.coord) centerOn(system.coord[0], system.coord[1], Math.max(state.view.scale, fitScale() * 2.6));
      }
    }
    renderDetail();
    renderCatalog();
    updateHash();
    requestRender();
  }

  function clearDetail() {
    state.pinned = false;
    state.activeSystemId = null;
    state.activePlanetId = null;
    state.hoverId = null;
    state.hoverPoiId = null;
    renderDetail();
    renderCatalog();
    updateHash();
    requestRender();
  }

  /* ------------------------------------------------------------------ поиск: подсказки */

  function updateSuggestions() {
    var value = el.searchInput.value.trim();
    state.query = value;
    el.clearSearch.hidden = value.length === 0;

    if (!value) {
      el.suggestions.hidden = true;
      el.suggestions.innerHTML = '';
      renderCatalog();
      return;
    }

    var results = search(value);
    if (!results.length) {
      el.suggestions.hidden = false;
      el.suggestions.innerHTML = '<div class="suggestions-empty">Ничего не найдено. Попробуйте часть названия места, системы или фракции.</div>';
      renderCatalog();
      return;
    }

    var html = '';
    var lastKind = null;
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

  function openSuggestion(entry) {
    if (!entry) return;
    if (entry.kind === 'system') selectSystem(entry.id);
    else if (entry.kind === 'planet') selectPlanet(entry.id);
    else if (entry.kind === 'marker') {
      var label = findLabel(entry.id);
      if (label) {
        state.activeSystemId = label.linkedSystemId || null;
        state.activePlanetId = label.linkedPlanetId || null;
        state.pinned = true;
        centerOn(label.x, label.y, Math.max(state.view.scale, fitScale() * 3));
        renderDetail();
        updateHash();
      }
    }
    el.suggestions.hidden = true;
    el.searchInput.blur();
  }

  function findLabel(key) {
    for (var i = 0; i < state.labels.length; i++) {
      var label = state.labels[i];
      if (label.name + '@' + label.x + ',' + label.y === key) return label;
    }
    return null;
  }

  /* ------------------------------------------------------------------ каталог слева */

  function isPlatformPlace(place) {
    if (placeTypesOf(place).indexOf('station') === -1) return false;
    var categories = (place.wikiCategories || []).join(' ').toLowerCase();
    var name = ((place.nameEn || '') + ' ' + (place.name || '')).toLowerCase();
    return categories.indexOf('space platforms') > -1 || name.indexOf('platform') > -1;
  }

  // Полный перечень типов из docs/ADMIN_GUIDE.md: planet, moon, asteroid, station,
  // platform, other. Каждый должен попадать ровно в одну вкладку, иначе место есть
  // в данных, но не видно ни в одной.
  function matchesCatalogView(place, view) {
    var types = placeTypesOf(place);
    view = view || state.catalogView;
    if (!view || view === 'systems') return true;
    if (view === 'planet') return types.indexOf('planet') > -1;
    if (view === 'platform') return types.indexOf('platform') > -1 || isPlatformPlace(place);
    if (view === 'station') return types.indexOf('station') > -1 && !isPlatformPlace(place);
    if (view === 'other') {
      return types.indexOf('moon') > -1 || types.indexOf('asteroid') > -1 || types.indexOf('other') > -1;
    }
    return true;
  }

  function catalogViewForPlace(place) {
    var types = placeTypesOf(place);
    if (types.indexOf('platform') > -1) return 'platform';
    if (types.indexOf('station') > -1) return isPlatformPlace(place) ? 'platform' : 'station';
    if (types.indexOf('planet') > -1) return 'planet';
    return 'other';
  }

  function updateCatalogSectionState() {
    var active = state.catalogView || '';
    doc.querySelectorAll('[data-catalog-view]').forEach(function (button) {
      var selected = button.getAttribute('data-catalog-view') === active;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  function setCatalogView(view) {
    state.catalogView = view;
    state.query = '';
    if (el.searchInput) el.searchInput.value = '';
    if (el.suggestions) el.suggestions.hidden = true;
    if (el.clearSearch) el.clearSearch.hidden = true;
    if (view === 'systems') {
      state.activeTypes = [];
      setTab('systems', { keepCatalogView: true });
    } else {
      if (view === 'planet') state.activeTypes = ['planet'];
      else if (view === 'station') state.activeTypes = ['station'];
      else if (view === 'platform') state.activeTypes = ['platform', 'station'];
      else if (view === 'other') state.activeTypes = ['moon', 'asteroid', 'other'];
      setTab('planets', { keepCatalogView: true });
    }
    updateCatalogSectionState();
  }

  function setTab(tab, options) {
    options = options || {};
    state.tab = tab;
    if (!options.keepCatalogView) state.catalogView = tab === 'systems' ? 'systems' : null;
    updateCatalogSectionState();
    renderFilters();
    renderCatalog();
  }

  function renderSectionCounts() {
    var sectionCounts = {
      catalogCountSystems: state.systems.length,
      catalogCountPlanets: state.planets.filter(function (place) { return matchesCatalogView(place, 'planet'); }).length,
      catalogCountStations: state.planets.filter(function (place) { return matchesCatalogView(place, 'station'); }).length,
      catalogCountPlatforms: state.planets.filter(function (place) { return matchesCatalogView(place, 'platform'); }).length,
      catalogCountOther: state.planets.filter(function (place) { return matchesCatalogView(place, 'other'); }).length
    };
    Object.keys(sectionCounts).forEach(function (id) {
      var node = doc.getElementById(id);
      if (node) node.textContent = formatNumber(sectionCounts[id]);
    });
  }

  function currentFactionPool() {
    var counter = {};
    if (state.tab === 'systems') {
      state.systems.forEach(function (system) {
        (system.worlds.length ? systemFactions(system) : (system.factions || ['Не указано'])).forEach(function (faction) {
          counter[faction] = (counter[faction] || 0) + 1;
        });
      });
    } else {
      state.planets.filter(function (planet) { return matchesCatalogView(planet); }).forEach(function (planet) {
        factionsOf(planet).forEach(function (faction) {
          counter[faction] = (counter[faction] || 0) + 1;
        });
      });
    }
    return counter;
  }

  function currentTypePool() {
    var counter = {};
    if (state.tab === 'systems') {
      state.systems.forEach(function (system) {
        var seen = {};
        system.worlds.forEach(function (place) {
          placeTypesOf(place).forEach(function (type) { seen[type] = true; });
        });
        Object.keys(seen).forEach(function (type) { counter[type] = (counter[type] || 0) + 1; });
      });
    } else {
      state.planets.filter(function (place) { return matchesCatalogView(place); }).forEach(function (place) {
        placeTypesOf(place).forEach(function (type) { counter[type] = (counter[type] || 0) + 1; });
      });
    }
    return counter;
  }

  function renderFilters() {
    var counter = currentFactionPool();
    var typeCounter = currentTypePool();
    var factions = Object.keys(counter).sort(function (a, b) {
      if (counter[b] !== counter[a]) return counter[b] - counter[a];
      return a.localeCompare(b, 'ru');
    });
    state.listFactions = factions;

    state.activeFactions = state.activeFactions.filter(function (faction) { return counter[faction]; });
    state.activeTypes = state.activeTypes.filter(function (type) { return typeCounter[type]; });
    var html = '<span class="filter-label">ТИП</span>' +
      '<button class="filter-chip' + (!state.activeTypes.length ? ' active' : '') +
      '" type="button" data-type="">Все типы</button>';
    ['planet', 'moon', 'asteroid', 'station', 'platform', 'other'].forEach(function (type) {
      if (!typeCounter[type]) return;
      var active = state.activeTypes.indexOf(type) > -1;
      var config = PLACE_TYPES[type] || { plural: type };
      html += '<button class="filter-chip' + (active ? ' active' : '') + '" type="button" data-type="' + type + '">' +
        escapeHtml(config.plural) + ' <span>' + typeCounter[type] + '</span></button>';
    });
    html += '<span class="filter-label">ФРАКЦИЯ</span>' +
      '<button class="filter-chip' + (!state.activeFactions.length ? ' active' : '') +
      '" type="button" data-faction="">Все фракции</button>';
    factions.forEach(function (faction) {
      if (counter[faction] < 1) return;
      var active = state.activeFactions.indexOf(faction) > -1;
      html += '<button class="filter-chip' + (active ? ' active' : '') + '" type="button" data-faction="' +
        escapeHtml(faction) + '">' + escapeHtml(faction) + ' <span>' + counter[faction] + '</span></button>';
    });
    el.filters.innerHTML = html;
  }

  function matchesFaction(list, factionsOfEntity) {
    if (!state.activeFactions.length) return true;
    var factions = factionsOfEntity();
    return factions.some(function (faction) { return state.activeFactions.indexOf(faction) > -1; });
  }

  function matchesPlaceTypes(place) {
    if (!state.activeTypes.length) return true;
    return placeTypesOf(place).some(function (type) { return state.activeTypes.indexOf(type) > -1; });
  }

  function visibleSystemsForList() {
    var needle = normalize(state.query);
    var list = state.systems.filter(function (system) {
      if (!matchesFaction(system, function () { return systemFactions(system); })) return false;
      if (state.activeTypes.length && !system.worlds.some(matchesPlaceTypes)) return false;
      if (!needle) return true;
      return searchKey(system.name).indexOf(needle) > -1 || normalize(system.note || '').indexOf(needle) > -1;
    });
    list.sort(listComparator(function (system) { return { name: system.name, count: system.worlds.length }; }));
    return list;
  }

  function visiblePlanetsForList() {
    var needle = normalize(state.query);
    var list = state.planets.filter(function (planet) {
      if (!matchesCatalogView(planet)) return false;
      if (!matchesFaction(planet, function () { return factionsOf(planet); })) return false;
      if (!matchesPlaceTypes(planet)) return false;
      if (!needle) return true;
      return searchKey(planet.name).indexOf(needle) > -1 ||
        normalize((planet.terrain || []).join(' ')).indexOf(needle) > -1 ||
        normalize(planet.nameEn || '').indexOf(needle) > -1;
    });
    list.sort(listComparator(function (planet) { return { name: planet.name, count: planet.population ? 0 : 1 }; }));
    return list;
  }

  function listComparator(project) {
    return function (a, b) {
      var pa = project(a);
      var pb = project(b);
      if (state.sortByCount && pb.count !== pa.count) return pb.count - pa.count;
      return pa.name.localeCompare(pb.name, 'ru');
    };
  }

  function catalogHidden() {
    return getComputedStyle(el.leftPanel).display === 'none';
  }

  function renderCatalog() {
    if (catalogHidden()) return;
    renderSectionCounts();
    var isSystems = state.tab === 'systems';
    var items = isSystems ? visibleSystemsForList() : visiblePlanetsForList();

    var sectionTitles = {
      planet: 'ПЛАНЕТЫ',
      station: 'СТАНЦИИ',
      platform: 'ПЛАТФОРМЫ',
      other: 'ИНЫЕ МЕСТА'
    };
    var sectionTitle = isSystems ? 'СИСТЕМЫ' : (sectionTitles[state.catalogView] || 'МЕСТА');
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
        var selected = item.id === activeSystem && !activePlanet;
        var glyph = item.name.replace(/^Система\s+/, '').slice(0, 2).toUpperCase();
        html += '<button class="catalog-row' + (selected ? ' selected' : '') + '" type="button" role="listitem" data-system="' + escapeHtml(item.id) + '">' +
          '<span class="row-glyph">' + escapeHtml(glyph) + '</span>' +
          '<span class="row-copy">' +
          '<span class="row-title">' + escapeHtml(item.name) + '</span>' +
          '<span class="row-meta"><span class="row-meta-text">' + escapeHtml(item.primaryFaction || 'фракция не указана') + '</span></span>' +
          '</span>' +
          '<span class="row-count">' + item.worlds.length + '</span>' +
          '</button>';
      } else {
        var system = item.systemId ? state.systemsById[item.systemId] : null;
        var selectedPlanetRow = item.id === activePlanet;
        html += '<button class="catalog-row' + (selectedPlanetRow ? ' selected' : '') + '" type="button" role="listitem" data-planet="' + escapeHtml(item.id) + '">' +
          '<span class="row-glyph">' + escapeHtml(placeTypeGlyph(item)) + '</span>' +
          '<span class="row-copy">' +
          '<span class="row-title">' + escapeHtml(item.name) + '</span>' +
          '<span class="row-meta">' +
          '<span class="row-status pdf-linked"></span>' +
          '<span class="row-meta-text">' + escapeHtml(placeTypeLabel(item, true)) + ' · ' +
          escapeHtml(system ? system.name.replace(/^Система\s+/, '') : 'система не указана') + '</span>' +
          '</span>' +
          '</span>' +
          '<span class="row-count">' + escapeHtml(item.onMap ? '⌖' : placeTypeGlyph(item)) + '</span>' +
          '</button>';
      }
    });

    el.catalogList.innerHTML = html;
  }

  /* ------------------------------------------------------------------ досье справа */

  function systemPositionLabel(system) {
    return system && system.coord && system.coordSource === 'map'
      ? 'Положение отмечено на схеме'
      : 'Положение на схеме не указано';
  }

  function badge(text, extraClass) {
    return '<span class="badge' + (extraClass ? ' ' + extraClass : '') + '">' + escapeHtml(text) + '</span>';
  }

  function renderDetail() {
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    var system = state.activeSystemId ? state.systemsById[state.activeSystemId] : null;

    if (!planet && !system) {
      el.detailPanel.hidden = true;
      el.detailContent.innerHTML = '';
      el.detailFooter.innerHTML = '';
      layoutMapControls();
      return;
    }

    if (planet) renderPlanetDetail(planet, system);
    else renderSystemDetail(system);

    el.detailPanel.hidden = false;
    el.pinButton.classList.toggle('active', state.pinned);
    layoutMapControls();
  }

  function renderSystemDetail(system) {
    el.detailType.textContent = 'СИСТЕМА';
    var worlds = system.worlds || [];

    var html = '';
    html += '<h3 class="detail-title">' + escapeHtml(system.name.replace(/^Система\s+/, '')) + '</h3>';
    html += '<p class="detail-subtitle">' + escapeHtml(
      (system.primaryFaction || 'фракция не указана') + ' · ' + worlds.length + ' ' + plural(worlds.length, ['мир', 'мира', 'миров'])
    ) + '</p>';

    html += '<div class="detail-badges">';
    html += badge(system.canonical ? 'каноническая система · WorldBox' :
      (system.confidence === 'pdf-linked' ? 'связь старого каталога' :
        (system.confidence === 'lore' ? 'по вики-лору' : 'система')),
      system.canonical ? 'pdf-linked' : '');
    var systemType = String(system.systemType || 'none').trim().toLowerCase();
    if (systemType !== 'none') {
      var systemTypeLabels = { capital: 'Столица', unknown: 'Неизвестный тип', unknow: 'Неизвестный тип' };
      html += badge(systemTypeLabels[systemType] || systemType, systemType === 'capital' ? 'custom' : '');
    }
    if (system.mapVerified) html += badge('сверено с картой');
    if (system.needsReview) html += badge('требует проверки · Кегар', 'custom');
    html += '</div>';

    html += '<div class="detail-section-title"><span>МЕСТА СИСТЕМЫ</span><span>' + worlds.length + '</span></div>';
    if (worlds.length) {
      html += '<div class="world-list">';
      worlds.forEach(function (world) {
        html += '<div class="world-card" data-planet="' + escapeHtml(world.id) + '">' +
          '<div class="world-card-top"><span class="world-name">' + escapeHtml(world.name) + '</span>' +
          '<span class="world-kind">' + escapeHtml(placeTypeLabel(world, true)) + '</span></div>' +
          '<div class="world-meta">' +
          factionsOf(world).slice(0, 2).map(function (faction) {
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
        '<div class="detail-note">Система отмечена на карте.' +
        (system.mapLabel ? ' Подпись: ' + escapeHtml(system.mapLabel) + '.' : '') + '</div>';
    }

    html += '<div class="detail-note"><strong>Внимание.</strong> ' + escapeHtml(system.note || 'Описание отсутствует.') + '</div>';
    if (system.mapNote) {
      html += '<div class="detail-note">' + escapeHtml(system.mapNote) + '</div>';
    }
    if (system.refs && system.refs.length) {
      html += '<div class="detail-section-title"><span>ИСТОЧНИКИ</span></div><div class="source-links">' +
        system.refs.map(function (ref) {
          return '<a href="' + escapeHtml(ref) + '" target="_blank" rel="noreferrer">' + escapeHtml(shortUrl(ref)) + ' ↗</a>';
        }).join('') + '</div>';
    }
    if (system.wiki) {
      html += '<div class="source-links"><a href="' + escapeHtml(system.wiki) + '" target="_blank" rel="noreferrer">StarCraft Wiki (EN) ↗</a></div>';
    }

    el.detailContent.innerHTML = html;

    el.detailFooter.innerHTML =
      '<span>' + escapeHtml(system.id) + '</span>' +
      '<button type="button" data-action="center">Центрировать</button>' +
      '<button type="button" data-action="link">Ссылка</button>';
  }

  function renderPlanetDetail(planet, system) {
    el.detailType.textContent = 'МЕСТО';
    var terrain = planet.terrain || [];
    var factions = factionsOf(planet);

    var html = '';
    html += '<div class="detail-kicker"><span class="confidence-dot pdf-linked"></span>' +
      escapeHtml('строгий канон · StarCraft Wiki') + '</div>';
    html += '<h3 class="detail-title">' + escapeHtml(planet.name) + '</h3>';
    html += '<p class="detail-subtitle">' + escapeHtml(placeTypeLabel(planet, true)) +
      (terrain.length ? ' · ' + escapeHtml(terrain.join(', ')) : '') + '</p>';

    html += '<div class="detail-badges">';
    placeTypesOf(planet).forEach(function (type) {
      html += badge((PLACE_TYPES[type] || { label: type }).label, 'pdf-linked');
    });
    if (planet.nameEn && planet.nameEn !== planet.name) html += badge(planet.nameEn);
    if (planet.status) html += badge(planet.status, 'custom');
    if (planet.onMap) html += badge('подпись на карте');
    if (planet.canonical) html += badge('строгий канон', 'pdf-linked');
    if (planet.canonicalSystem) html += badge('WorldBox.system', 'pdf-linked');
    if (planet.parent) html += badge('родитель: ' + planet.parent);
    html += '</div>';

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
    if (planet.pointOfInterest && planet.mapCoord) {
      html += '<div class="detail-note"><strong>Точка интереса.</strong> Координаты на карте: X ' +
        planet.mapCoord.x + ', Y ' + planet.mapCoord.y + '.</div>';
    } else if (planet.mapCoord) {
      html += '<div class="detail-note">На карте подпись «' + escapeHtml(planet.mapLabel || planet.name) + '» в точке ' +
        planet.mapCoord.x + ', ' + planet.mapCoord.y + '. Точка относится к подписи, а не к орбите.</div>';
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
      '<button type="button" data-action="center">Центрировать</button>';
  }

  function shortUrl(url) {
    try {
      var parsed = new URL(url);
      return parsed.host.replace('www.', '') + parsed.pathname.split('/').filter(Boolean).slice(-1)[0].replace(/_/g, ' ');
    } catch (err) { return url; }
  }

  /* ------------------------------------------------------------------ ссылки и хэш */

  function updateHash() {
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

  function applyHash() {
    var match = /^#\/([sp])\/(.+)$/.exec(window.location.hash || '');
    if (!match) return false;
    var id = decodeURIComponent(match[2]);
    if (match[1] === 's' && state.systemsById[id]) { selectSystem(id, { center: true }); return true; }
    if (match[1] === 'p' && state.planetsById[id]) { selectPlanet(id, { center: true }); return true; }
    return false;
  }

  function copyLink() {
    var url = window.location.href;
    var done = function () { toast('Ссылка скопирована'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { toast(url); });
    } else {
      toast(url);
    }
  }

  /* ------------------------------------------------------------------ модальные окна */

  function openModal(node) { node.hidden = false; }
  function closeModal(node) { node.hidden = true; }

  // Старые демонстрационные Wiki-модали удалены вместе с их навигацией.

  /* ------------------------------------------------------------------ уведомления и мелочи */

  function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('visible');
    window.clearTimeout(toastsTimer);
    toastsTimer = window.setTimeout(function () { el.toast.classList.remove('visible'); }, 2600);
  }

  function updateZoomReadout() {
    var fit = fitScale();
    var factor = fit > 0 ? state.view.scale / fit : 1;
    el.zoomPercent.textContent = Math.round(factor * 100) + '%';
  }

  function updateCoordinateReadout() {
    if (!el.mapCoordinateReadout) return;
    var readout = el.mapCoordinateReadout;
    var point = coordinatePointer;
    if (!coordinateReadoutEnabled || !point || point.x < 0 || point.y < 0 ||
        point.x > state.viewport.w || point.y > state.viewport.h) {
      readout.hidden = true;
      readout.setAttribute('aria-hidden', 'true');
      return;
    }
    var world = toWorld(point.x, point.y);
    var size = mapSize();
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

  function copyCoordinatesToClipboard(value, displayValue) {
    function showCopied() { toast('Скопировано в две ячейки: ' + displayValue); }

    function fallbackCopy() {
      var field = doc.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      doc.body.appendChild(field);
      field.select();
      var copied = false;
      try { copied = doc.execCommand('copy'); } catch (err) { copied = false; }
      field.remove();
      if (copied) showCopied();
      else toast('Не удалось скопировать координаты');
    }

    if (window.navigator.clipboard && window.navigator.clipboard.writeText) {
      window.navigator.clipboard.writeText(value).then(showCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function copyMapCoordinates(point) {
    var world = toWorld(point.x, point.y);
    var size = mapSize();
    if (world.x < 0 || world.y < 0 || world.x > size || world.y > size) {
      toast('Shift+клик по самой карте');
      return;
    }
    var x = Math.round(world.x);
    var y = Math.round(world.y);
    // Табуляция разделяет значения на две соседние ячейки при вставке в таблицу.
    copyCoordinatesToClipboard(x + '\t' + y, x + ', ' + y);
  }

  function applyLabelsToggle() {
    el.labelsToggle.setAttribute('aria-pressed', String(state.labelsOn));
    writeJSON(CONFIG.storage.labels, state.labelsOn);
    requestRender();
  }

  function detectSkin() {
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

  function setPanelOpen(open) {
    skin.panelOpen = open;
    el.leftPanel.classList.toggle('collapsed', !open);
    el.mapStage.classList.toggle('wide', !open);
    // Панель является дочерней для сдвинутой сцены: её штатный left:-300px
    // как раз ставит каталог у левого края окна. left:0 оставлял перед ним
    // пустую колонку шириной с сам каталог.
    if (skin.panelOffCanvas) el.leftPanel.style.left = '';
    requestRender();
  }

  function togglePanel() {
    setPanelOpen(!skin.panelOpen);
    var title = skin.panelOpen ? 'Скрыть каталог' : 'Показать каталог';
    [el.closePanel, el.toggleSidePanel].forEach(function (button) {
      if (button) button.setAttribute('title', title);
    });
  }

  function layoutMapControls() {
    // досье шире, чем остальные элементы: сдвигаем кнопки масштаба влево,
    // иначе панель их перекрывает (так задумано в CSS обеих тем)
    var node = qs('.map-controls');
    if (!node) return;
    var offset = 0;
    if (!el.detailPanel.hidden) {
      var stage = el.mapStage.getBoundingClientRect();
      var panel = el.detailPanel.getBoundingClientRect();
      if (stage.right - panel.left < stage.width * 0.9) {
        offset = Math.max(0, Math.round(stage.right - panel.left) + 6);
      }
    }
    node.style.right = (14 + offset) + 'px';
  }

  function resize() {
    var rect = el.mapStage.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = Math.max(1, Math.round(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    layoutMapControls();
    if (w === state.viewport.w && h === state.viewport.h && dpr === state.dpr) return;

    // Точка мира, которая была в центре экрана, остаётся в центре: при любом
    // изменении размера (окно, панель, клавиатура телефона) карта не «уезжает».
    var keep = null;
    if (state.viewport.w > 1 && state.viewport.h > 1 && state.view.scale > 0) {
      keep = toWorld(state.viewport.w / 2, state.viewport.h / 2);
    }

    state.viewport.w = w;
    state.viewport.h = h;
    state.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    if (keep) {
      state.view.tx = w / 2 - keep.x * state.view.scale;
      state.view.ty = h / 2 - keep.y * state.view.scale;
    }
    clampView();
    requestRender();
  }

  /* ------------------------------------------------------------------ привязка интерфейса */

  function cacheElements() {
    ['searchInput', 'clearSearch', 'suggestions', 'searchWrap', 'mapFactionFilter', 'mapStage', 'mapCanvas',
      'leftPanel', 'closePanel', 'toggleSidePanel', 'filters', 'filterResultCount',
      'listCaption', 'sortButton', 'catalogList', 'detailPanel',
      'detailType', 'detailContent', 'detailFooter', 'pinButton', 'closeDetail',
      'helpButton', 'closeHelp', 'helpModal', 'zoomIn', 'zoomOut', 'resetMap', 'zoomPercent', 'labelsToggle',
      'coordinateToggle', 'mapCoordinateReadout', 'toast'].forEach(function (id) {
        el[id] = doc.getElementById(id);
      });
    el.legacyControls = qs('.legacy-controls');
    canvas = el.mapCanvas;
    ctx = canvas.getContext('2d');
  }

  function bindEvents() {
    // карта
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', function () {
      coordinatePointer = null;
      updateCoordinateReadout();
      if (!drag && (state.hoverId || state.hoverPoiId)) {
        state.hoverId = null;
        state.hoverPoiId = null;
        canvas.classList.remove('marker-hover');
        if (!state.pinned) {
          state.activeSystemId = null;
          state.activePlanetId = null;
          renderDetail();
        }
        requestRender();
      }
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });

    // управление
    el.zoomIn.addEventListener('click', function () {
      zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1.45);
    });
    el.zoomOut.addEventListener('click', function () {
      zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1 / 1.45);
    });
    el.resetMap.addEventListener('click', function () {
      animation = null;
      fitView();
      requestRender();
    });
    el.labelsToggle.addEventListener('click', function () {
      state.labelsOn = !state.labelsOn;
      applyLabelsToggle();
      toast(state.labelsOn ? 'Подписи карты включены' : 'Подписи карты скрыты');
    });
    if (el.coordinateToggle) el.coordinateToggle.addEventListener('click', function () {
      coordinateReadoutEnabled = !coordinateReadoutEnabled;
      el.coordinateToggle.setAttribute('aria-pressed', String(coordinateReadoutEnabled));
      var label = coordinateReadoutEnabled ? 'Отключить координаты наведения' : 'Включить координаты наведения';
      el.coordinateToggle.setAttribute('aria-label', label);
      el.coordinateToggle.title = label;
      updateCoordinateReadout();
    });

    // панель каталога
    el.closePanel.addEventListener('click', togglePanel);
    if (el.toggleSidePanel) el.toggleSidePanel.addEventListener('click', togglePanel);
    var catalogSections = doc.getElementById('catalogSections');
    if (catalogSections) catalogSections.addEventListener('click', function (event) {
      var button = event.target.closest('[data-catalog-view]');
      if (!button) return;
      setCatalogView(button.getAttribute('data-catalog-view'));
    });

    el.sortButton.addEventListener('click', function () {
      state.sortByCount = !state.sortByCount;
      renderCatalog();
    });
    el.filters.addEventListener('click', function (event) {
      var chip = event.target.closest('.filter-chip');
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
      var row = event.target.closest('[data-system],[data-planet]');
      if (!row) return;
      if (row.hasAttribute('data-system')) selectSystem(row.getAttribute('data-system'), { center: true });
      else selectPlanet(row.getAttribute('data-planet'), { center: true });
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
        var buttons = Array.prototype.slice.call(el.suggestions.querySelectorAll('.suggestion'));
        if (!buttons.length) return;
        var current = buttons.indexOf(el.suggestions.querySelector('.suggestion.active'));
        var next = event.key === 'ArrowDown'
          ? (current + 1 + buttons.length) % buttons.length
          : (current - 1 + buttons.length) % buttons.length;
        buttons.forEach(function (button) { button.classList.remove('active'); });
        buttons[next].classList.add('active');
        buttons[next].scrollIntoView({ block: 'nearest' });
      }
    });
    el.clearSearch.addEventListener('click', function () {
      el.searchInput.value = '';
      updateSuggestions();
      el.searchInput.focus();
    });
    el.suggestions.addEventListener('click', function (event) {
      var button = event.target.closest('.suggestion');
      if (!button) return;
      var results = el.suggestions._results || [];
      openSuggestion(results[Number(button.getAttribute('data-index'))]);
    });
    doc.addEventListener('click', function (event) {
      if (!el.searchWrap.contains(event.target)) el.suggestions.hidden = true;
    });

    // досье
    el.closeDetail.addEventListener('click', clearDetail);
    el.pinButton.addEventListener('click', function () {
      state.pinned = !state.pinned;
      el.pinButton.classList.toggle('active', state.pinned);
      toast(state.pinned ? 'Карточка закреплена' : 'Карточка закрывается при уходе курсора');
      if (!state.pinned) clearDetail();
    });
    el.detailContent.addEventListener('click', function (event) {
      var card = event.target.closest('[data-planet],[data-system]');
      if (!card) return;
      if (card.hasAttribute('data-planet')) selectPlanet(card.getAttribute('data-planet'));
      else selectSystem(card.getAttribute('data-system'), { center: true });
    });
    el.detailFooter.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (!button) return;
      var action = button.getAttribute('data-action');
      if (action === 'center') {
        var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
        if (planet && planet.mapCoord) centerOn(planet.mapCoord.x, planet.mapCoord.y, Math.max(state.view.scale, fitScale() * 3.4));
        else if (state.activeSystemId) {
          var system = state.systemsById[state.activeSystemId];
          if (system && system.coord) centerOn(system.coord[0], system.coord[1], Math.max(state.view.scale, fitScale() * 2.6));
        }
      } else if (action === 'link') {
        copyLink();
      } else if (action === 'system') {
        state.activePlanetId = null;
        renderDetail();
        updateHash();
      }
    });

    // шапка и модальные окна
    el.helpButton.addEventListener('click', function () { openModal(el.helpModal); });
    el.closeHelp.addEventListener('click', function () { closeModal(el.helpModal); });
    el.helpModal.addEventListener('click', function (event) {
      if (event.target === el.helpModal) closeModal(el.helpModal);
    });
    doc.querySelectorAll('.modal-backdrop').forEach(function (backdrop) {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) closeModal(backdrop);
      });
    });

    // карта: фильтр по фракции
    el.mapFactionFilter.addEventListener('change', function () {
      state.mapFaction = el.mapFactionFilter.value;
      requestRender();
      var shownSystems = visibleSystems().length;
      var shownPois = visiblePointsOfInterest().length;
      toast('На карте: ' + shownSystems + ' систем · ' + shownPois + ' точек интереса');
    });

    // Старые демонстрационные разделы Wiki удалены: каталог теперь сам является навигацией.

    // клавиатура
    doc.addEventListener('keydown', function (event) {
      var tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (event.key === 'Escape') {
        if (!el.helpModal.hidden) { closeModal(el.helpModal); return; }
        clearDetail();
        return;
      }
      if (event.key === '/' || event.key === '?') { event.preventDefault(); el.searchInput.focus(); return; }
      if (event.key === '+' || event.key === '=') { zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1.35); return; }
      if (event.key === '-' || event.key === '_') { zoomAt(state.viewport.w / 2, state.viewport.h / 2, 1 / 1.35); return; }
      if (event.key === '0') { fitView(); requestRender(); return; }
      if (event.key === 'l' || event.key === 'д') {
        state.labelsOn = !state.labelsOn;
        applyLabelsToggle();
        return;
      }
      var pan = 60;
      if (event.key === 'ArrowLeft') { state.view.tx += pan; clampView(); requestRender(); }
      if (event.key === 'ArrowRight') { state.view.tx -= pan; clampView(); requestRender(); }
      if (event.key === 'ArrowUp') { state.view.ty += pan; clampView(); requestRender(); }
      if (event.key === 'ArrowDown') { state.view.ty -= pan; clampView(); requestRender(); }
    });

    window.addEventListener('hashchange', applyHash);
    window.addEventListener('resize', resize);

    if (window.ResizeObserver) {
      new ResizeObserver(resize).observe(el.mapStage);
    }
  }

  /* ------------------------------------------------------------------ запуск */

  function initUI() {
    // в базовом и вики-скине управление подсказками и панелью лежит в скрытом блоке: показываем его
    if (el.legacyControls && window.innerWidth >= 700) el.legacyControls.hidden = false;
    applyLabelsToggle();

    var factions = {};
    state.systems.forEach(function (system) {
      systemFactions(system).forEach(function (faction) { factions[faction] = (factions[faction] || 0) + 1; });
    });
    var poiCount = 0;
    visiblePointsOfInterest().forEach(function (place) {
      poiCount++;
      factionsOf(place).forEach(function (faction) { factions[faction] = (factions[faction] || 0) + 1; });
    });
    var options = Object.keys(factions).sort(function (a, b) {
      if (factions[b] !== factions[a]) return factions[b] - factions[a];
      return a.localeCompare(b, 'ru');
    }).map(function (faction) {
      return '<option value="' + escapeHtml(faction) + '">' + escapeHtml(faction) + ' · ' + factions[faction] + '</option>';
    }).join('');
    el.mapFactionFilter.innerHTML = '<option value="all">Все фракции · ' + (state.systems.length + poiCount) + '</option>' + options;

  }

  function boot() {
    cacheElements();
    // Страховка: экран аутентификации не должен зависнуть даже при сетевой ошибке.
    window.setTimeout(dismissTimelineLoader, 8000);

    if (!ctx) {
      doc.body.insertAdjacentHTML('beforeend', '<div class="data-error">Браузер не поддерживает canvas — карта недоступна.</div>');
      dismissTimelineLoader();
      return;
    }

    detectSkin();
    bindEvents();

  loadDataset().then(function (data) {
      state.meta = data.meta || {};
      state.systemsRaw = data.systems || [];
      state.planets = data.planets || [];
      state.overrides = data.overrides || { systems: {} };
      state.labels = data.labels || [];
      state.tiles = data.tiles || null;

      buildModel();
      configureTiles(data.tiles, state.meta);
      resize();
      fitView();
      initUI();
      renderFilters();
      renderCatalog();

      applyHash();
      updateZoomReadout();
      requestRender();
      // Два кадра дают canvas отрисоваться под лоад-скрином без белого всплеска.
      window.requestAnimationFrame(function () {
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
})();
