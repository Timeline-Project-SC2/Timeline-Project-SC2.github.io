/* Map Atlas — загрузка CSV/JSON, нормализация записей, модель и индекс поиска. */

import {
  CONFIG,
  PLACE_TYPES,
  assetVersion,
  normalize,
  plural,
  searchKey,
} from './config.ts';
import type {
  AtlasDataset,
  AtlasKernel,
  AtlasMeta,
  AtlasOverrides,
  CatalogSearchEntry,
  DataLoaderApi,
  MapCoord,
  MapLabel,
  MapPoint,
  PlaceRecord,
  PlanetProfileStatus,
  SearchEntry,
  SystemRecord,
  UnknownRecord,
} from './config.ts';

type SheetRow = Record<string, string>;

interface SheetSystemData {
  systemType: string;
  coord: MapCoord | null;
  primaryFaction: string;
  note: string;
  sourceUrl: string;
}

interface SheetSystemUpdate {
  systemType: string;
  coord?: MapCoord;
  coordSource?: string;
  fromSheet?: boolean;
  primaryFaction?: string;
  factions?: string[];
  note?: string;
  sourceUrl?: string;
}

interface SheetPlaceRecord extends PlaceRecord {
  placeTypes: string[];
  coord: MapCoord | null;
  systemId: string | null;
  system: string | null;
  pointOfInterest: boolean;
  mapCoord: MapPoint | null;
}

/* Тип места из таблицы. Пустая ячейка и легаси-токен `none` — это «место без
 * типа» (полка ожидания, §9.2 п.5), а не планета: иначе такое место попадает в
 * каталог планет и в системный кадр как тело. Легаси-фолбэк на `planet` остаётся
 * только там, где типа нет вообще (`undefined`/`null`: нет колонки в таблице или
 * у записи нет поля) — иначе поедет весь старый каталог. */
export function normalizedPlaceType(value: unknown): string {
  if (value == null) return 'planet';
  var text = String(value).trim().toLowerCase();
  if (!text || text === 'none') return 'unknown';
  return text;
}

export function createDataLoader(kernel: AtlasKernel): DataLoaderApi {
  const state = kernel.state;
  const travelCore = kernel.runtime.travelCore;

  /* ------------------------------------------------------------------ загрузка данных */

  function fetchJSON<T>(url: string, fallback: T): Promise<T> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json() as Promise<T>;
      })
      .catch(function () { return fallback; });
  }

  function splitCSVLine(line: string): string[] {
    var result: string[] = [];
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

  function parseCSV(text: string): SheetRow[] {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return [];
    var headers = splitCSVLine(lines[0]!).map(function (h) { return h.trim(); });
    var rows: SheetRow[] = [];
    for (var i = 1; i < lines.length; i++) {
      var cols = splitCSVLine(lines[i]!);
      var obj: SheetRow = {};
      headers.forEach(function (h, idx) { obj[h] = (cols[idx] || '').trim(); });
      if (Object.keys(obj).every(function (k) { return obj[k] === ''; })) continue;
      rows.push(obj);
    }
    return rows;
  }

  function fetchCSV(url: string): Promise<SheetRow[]> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(parseCSV)
      .catch(function () { return []; });
  }

  // Google Sheets uses blank cells for omitted values. Accept legacy "none" as blank,
  // but apply defaults according to each field instead of showing the token as data.
  function sheetValue(value: unknown): string {
    var text = value == null ? '' : String(value).trim();
    return text.toLowerCase() === 'none' ? '' : text;
  }

  function sheetCell(row: SheetRow | UnknownRecord | null | undefined, key: string): string {
    return sheetValue(row && row[key]);
  }

  function normalizedSystemType(value: unknown): string {
    var type = sheetValue(value).toLowerCase();
    if (!type || type === 'standard' || type === 'system') return 'standard';
    if (type === 'unknown' || type === 'unknow') return 'unknown';
    return type;
  }

  function mapSystemRow(row: SheetRow): SystemRecord {
    var x = explicitMapNumber(sheetCell(row, 'x'));
    var y = explicitMapNumber(sheetCell(row, 'y'));
    var coord: MapCoord | null = x !== null && y !== null ? [x, y] : null;
    var name = sheetCell(row, 'name');
    var faction = sheetCell(row, 'faction');
    return {
      id: sheetCell(row, 'system_id') || sheetCell(row, 'id') || name,
      name: name,
      nameEn: name,
      systemType: normalizedSystemType(row.type),
      coord: coord,
      coordSource: coord ? 'map' : null,
      fromSheet: !!coord,
      primaryFaction: faction,
      factions: faction ? [faction] : [],
      note: sheetCell(row, 'description'),
      sourceUrl: sheetCell(row, 'source_url'),
      worlds: [],
      planetIds: []
    };
  }

  function mergeSystemTypes(systems: UnknownRecord[], rows: SheetRow[]): UnknownRecord[] {
    if (!systems || !systems.length || !rows || !rows.length) return systems;
    var dataByKey: Record<string, SheetSystemData> = {};
    rows.forEach(function (row) {
      var x = explicitMapNumber(sheetCell(row, 'x'));
      var y = explicitMapNumber(sheetCell(row, 'y'));
      var faction = sheetCell(row, 'faction');
      var data: SheetSystemData = {
        systemType: normalizedSystemType(row.type),
        coord: x !== null && y !== null ? [x, y] as MapCoord : null,
        primaryFaction: faction,
        note: sheetCell(row, 'description'),
        sourceUrl: sheetCell(row, 'source_url')
      };
      [sheetCell(row, 'system_id') || sheetCell(row, 'id'), sheetCell(row, 'name')].forEach(function (key) {
        var normalized = normalize(key);
        if (normalized) dataByKey[normalized] = data;
      });
    });
    return systems.map(function (system) {
      var keys = [system.id, system.system_id, system.name];
      for (var i = 0; i < keys.length; i++) {
        var normalized = normalize(keys[i]);
        if (normalized && Object.prototype.hasOwnProperty.call(dataByKey, normalized)) {
          var sheetData = dataByKey[normalized]!;
          var update: SheetSystemUpdate = { systemType: sheetData.systemType };
          if (sheetData.coord) {
            update.coord = sheetData.coord;
            update.coordSource = 'map';
            update.fromSheet = true;
          }
          if (sheetData.primaryFaction) {
            update.primaryFaction = sheetData.primaryFaction;
            update.factions = [sheetData.primaryFaction];
          }
          if (sheetData.note) update.note = sheetData.note;
          if (sheetData.sourceUrl) update.sourceUrl = sheetData.sourceUrl;
          return Object.assign({}, system, update);
        }
      }
      return system;
    });
  }

  function mapPlaceRow(row: SheetRow): SheetPlaceRecord {
    var x = explicitMapNumber(sheetCell(row, 'x'));
    var y = explicitMapNumber(sheetCell(row, 'y'));
    var coord: MapCoord | null = x !== null && y !== null ? [x, y] : null;
    var systemId = sheetCell(row, 'system_id');
    var pointOfInterest = !systemId && !!coord;
    var name = sheetCell(row, 'name');
    var faction = sheetCell(row, 'faction');
    return {
      id: sheetCell(row, 'ID') || sheetCell(row, 'id') || name,
      name: name,
      nameEn: name,
      placeTypes: [normalizedPlaceType(row.type)],
      systemId: systemId || null,
      system: systemId || null,
      coord: coord,
      pointOfInterest: pointOfInterest,
      mapCoord: pointOfInterest ? { x: x!, y: y! } : null,
      primaryFaction: faction,
      factions: faction ? [faction] : [],
      note: sheetCell(row, 'description'),
      sourceUrl: sheetCell(row, 'source_url'),
      wikiCategories: []
    };
  }

  function mergeStandalonePoiRows(places: PlaceRecord[], rows: SheetRow[]): PlaceRecord[] {
    var result = places || [];
    var byId = Object.create(null) as Record<string, PlaceRecord>;
    result.forEach(function (place) { byId[String(place.id)] = place; });

    (rows || []).map(mapPlaceRow).forEach(function (sheetPlace) {
      var existing = byId[String(sheetPlace.id)];
      if (!existing) {
        if (sheetPlace.pointOfInterest) {
          result.push(sheetPlace);
          byId[String(sheetPlace.id)] = sheetPlace;
        }
        return;
      }
      // The sheet relationship is authoritative: a blank system_id is standalone,
      // and only a complete explicit coordinate pair turns it into a POI.
      existing.systemId = sheetPlace.systemId;
      existing.system = sheetPlace.systemId;
      existing.pointOfInterest = sheetPlace.pointOfInterest;
      if (sheetPlace.pointOfInterest) {
        existing.coord = sheetPlace.coord;
        existing.mapCoord = sheetPlace.mapCoord;
      } else if (!sheetPlace.systemId) {
        existing.mapCoord = null;
      }
      if ((!existing.placeTypes || !existing.placeTypes.length) && sheetPlace.placeTypes.length) {
        existing.placeTypes = sheetPlace.placeTypes;
      }
      if (sheetPlace.primaryFaction) {
        existing.primaryFaction = sheetPlace.primaryFaction;
        existing.factions = [sheetPlace.primaryFaction];
      }
      if (sheetPlace.note) existing.note = sheetPlace.note;
      if (sheetPlace.sourceUrl) existing.sourceUrl = sheetPlace.sourceUrl;
    });
    return result;
  }

  /* 3D-профиль планеты (Этап 7): строки `planet-generation.csv` сопоставляются
   * с записями сектора по `place_id === String(place.id)`. Снимок профилей —
   * источник истины только для четырёх полей 3D-профиля; отсутствие строки
   * оставляет планету «процедурной» без статуса и ключа. */
  function planetProfileStatusOf(value: unknown): PlanetProfileStatus | null {
    var text = sheetValue(value).toLowerCase();
    return text === 'draft' || text === 'review' || text === 'frozen' ? text : null;
  }

  function planetRadiusOf(value: unknown): number | null {
    var radius = explicitMapNumber(value);
    return radius !== null && radius > 0 ? radius : null;
  }

  function mergePlanetGenerationRows(places: PlaceRecord[], rows: SheetRow[]): PlaceRecord[] {
    if (!places || !places.length || !rows || !rows.length) return places;
    var byPlaceId: Record<string, SheetRow> = Object.create(null) as Record<string, SheetRow>;
    rows.forEach(function (row) {
      var placeId = sheetCell(row, 'place_id');
      // Дубли вкладки запрещены `tools/sync.py --strict`; если они всё же есть,
      // побеждает последняя строка — как и в порядке применения снимка.
      if (placeId) byPlaceId[placeId] = row;
    });
    return places.map(function (place) {
      var row = byPlaceId[String(place.id)];
      if (!row) return place;
      return Object.assign({}, place, {
        planetProfileStatus: planetProfileStatusOf(row.profile_status),
        planetPresetId: sheetCell(row, 'preset_id') || null,
        planetRadiusKm: planetRadiusOf(row.radius_km),
        planetGenerationKey: sheetCell(row, 'generation_key') || null
      });
    });
  }

  function loadDataset(): Promise<AtlasDataset> {
    const inline = window.__MAP_DATA__;
    if (inline && inline.systems) {
      return Promise.all([
        fetchCSV('/data/systems.csv'),
        fetchCSV('/data/places.csv'),
        fetchCSV(CONFIG.data.dir + CONFIG.data.generation)
      ]).then(function (rows) {
        var planets = inline.planets || [];
        planets = planets.length
          ? mergeStandalonePoiRows(planets, rows[1])
          : rows[1].map(mapPlaceRow);
        planets = mergePlanetGenerationRows(planets, rows[2]);
        return {
          meta: inline.meta || {},
          systems: mergeSystemTypes(inline.systems || [], rows[0]),
          planets: planets,
          overrides: inline.overrides || { systems: {} },
          labels: inline.labels || [],
        };
      });
    }

    var v = assetVersion();
    var suffix = v ? ('?v=' + encodeURIComponent(v)) : '';
    var dir = CONFIG.data.dir;

    // Сначала метаданные карты, затем каталог систем, мест и снимки таблиц.
    return fetchJSON<AtlasMeta>(dir + CONFIG.data.meta + suffix, {}).then(function (meta) {
      if (meta && meta.generatedAt && !meta.generated) meta.generated = meta.generatedAt;
      return Promise.all([
        fetchJSON<UnknownRecord[]>(dir + CONFIG.data.systems + suffix, []),
        fetchJSON<PlaceRecord[]>(dir + CONFIG.data.planets + suffix, []),
        fetchJSON<AtlasOverrides>(dir + CONFIG.data.overrides + suffix, { systems: {} }),
        fetchJSON<MapLabel[]>(dir + CONFIG.data.labels + suffix, []),
        fetchCSV('/data/systems.csv' + suffix),
        fetchCSV('/data/places.csv' + suffix),
        fetchCSV(CONFIG.data.dir + CONFIG.data.generation + suffix)
      ]).then(function ([systemsJson, planetsJson, overrides, labels, systemRows, placeRows, generationRows]) {
        var systems = systemsJson;
        var planets = planetsJson;
        if ((!systems || !systems.length) && systemRows && systemRows.length) {
          systems = systemRows.map(mapSystemRow);
        }
        if ((!planets || !planets.length) && placeRows && placeRows.length) {
          planets = placeRows.map(mapPlaceRow);
        } else {
          planets = mergeStandalonePoiRows(planets || [], placeRows);
        }
        systems = mergeSystemTypes(systems, systemRows);
        planets = mergePlanetGenerationRows(planets, generationRows);
        return {
          meta: meta,
          systems: systems,
          planets: planets,
          overrides: overrides,
          labels: labels,
        };
      });
    });
  }

  /* ------------------------------------------------------------------ модель */

  function stringList(value: unknown): string[] {
    var values: unknown[] = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    return values.map(sheetValue).filter(Boolean);
  }

  function normalizeSystemRecord(system: UnknownRecord): SystemRecord {
    var normalized = Object.assign({}, system) as SystemRecord;
    normalized.systemType = normalizedSystemType(system.systemType);
    normalized.primaryFaction = sheetValue(system.primaryFaction);
    normalized.factions = stringList(system.factions);
    normalized.note = sheetValue(system.note);
    normalized.sourceUrl = sheetValue(system.sourceUrl);
    return normalized;
  }

  function normalizePlaceRecord(place: PlaceRecord): PlaceRecord {
    var normalized = Object.assign({}, place);
    var placeTypes: unknown[] = Array.isArray(place.placeTypes) ? place.placeTypes :
      (place.placeTypes == null || place.placeTypes === '' ? [] : [place.placeTypes]);
    normalized.placeTypes = placeTypes.map(normalizedPlaceType);
    normalized.systemId = sheetValue(place.systemId) || null;
    normalized.primaryFaction = sheetValue(place.primaryFaction);
    normalized.factions = stringList(place.factions);
    normalized.note = sheetValue(place.note);
    normalized.sourceUrl = sheetValue(place.sourceUrl);
    return normalized;
  }

  function applyOverrides(input: UnknownRecord): SystemRecord {
    var system = normalizeSystemRecord(input);
    var override = (state.overrides && state.overrides.systems && state.overrides.systems[system.id]) || null;

    var resolved = Object.assign({}, system);
    resolved.name = system.name;
    resolved.note = system.note!;
    // Keep only a complete, in-bounds coordinate pair explicitly supplied by the map CSV.
    // Unmarked fallback coordinates from JSON are deliberately discarded.
    var sourceX = system.coordSource === 'map' && system.coord
      ? explicitMapNumber(system.coord[0]) : null;
    var sourceY = system.coordSource === 'map' && system.coord
      ? explicitMapNumber(system.coord[1]) : null;
    var sourcePoint = sourceX !== null && sourceY !== null ? { x: sourceX, y: sourceY } : null;
    resolved.coord = coordinateOnMap(sourcePoint) ? [sourceX!, sourceY!] : null;
    resolved.coordSource = resolved.coord ? 'map' : null;
    resolved.override = override;

    if (override) {
      var point: MapPoint | null = null;
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

  function mapSize(): number {
    return (state.meta && state.meta.mapSize) || 10000;
  }

  function explicitMapNumber(value: unknown): number | null {
    if (value == null || (typeof value === 'string' && !value.trim())) return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
  }

  function coordinateOnMap(point: MapPoint | null | undefined): point is MapPoint {
    var size = mapSize();
    return !!point && isFinite(point.x) && isFinite(point.y) &&
      point.x >= 0 && point.y >= 0 && point.x <= size && point.y <= size;
  }

  // миры системы: сначала явные planetIds, затем планеты со ссылкой systemId
  function attachWorlds(system: SystemRecord): SystemRecord {
    var list: PlaceRecord[] = [];
    (system.planetIds || []).forEach(function (id) {
      var byId = state.planetsById[String(id)]; if (byId) list.push(byId);
    });
    state.planets.forEach(function (planet) {
      if (planet.systemId === system.id && list.indexOf(planet) === -1) list.push(planet);
    });
    system.worlds = list;
    return system;
  }

  function buildModel(): void {
    state.planets = (state.planets || []).map(normalizePlaceRecord);
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

  function isPlatformPlace(place: PlaceRecord): boolean {
    if (placeTypesOf(place).indexOf('station') === -1) return false;
    var categories = (place.wikiCategories || []).join(' ').toLowerCase();
    var name = ((place.nameEn || '') + ' ' + (place.name || '')).toLowerCase();
    return categories.indexOf('space platforms') > -1 || name.indexOf('platform') > -1;
  }

  function placeTypesOf(place: PlaceRecord): string[] {
    return (place.placeTypes && place.placeTypes.length) ? place.placeTypes : ['planet'];
  }

  function primaryPlaceType(place: PlaceRecord): string {
    return placeTypesOf(place)[0]!;
  }

  function placeTypeLabel(place: PlaceRecord, all?: boolean): string {
    var types = placeTypesOf(place);
    if (!all) types = types.slice(0, 1);
    return types.map(function (type) {
      if (type === 'station') return isPlatformPlace(place) ? 'Платформа' : 'Станция';
      return (PLACE_TYPES[type] || { label: type }).label;
    }).join(' · ');
  }

  function placeTypeGlyph(place: PlaceRecord): string {
    var primary = primaryPlaceType(place);
    if (primary === 'station') return isPlatformPlace(place) ? 'ПТ' : 'СТ';
    var type = PLACE_TYPES[primary] || { glyph: 'М' };
    return type.glyph;
  }

  function factionsOf(planet: PlaceRecord): string[] {
    return (planet.factions && planet.factions.length) ? planet.factions : ['Фракции нет'];
  }

  function buildFacets(): void {
    var counter: Record<string, number> = {};
    state.systems.forEach(function (system) {
      var list = system.worlds.length
        ? system.worlds.reduce(function (acc: string[], planet: PlaceRecord) { return acc.concat(factionsOf(planet)); }, [] as string[])
        : (system.factions || []);
      (list.length ? list : ['Фракции нет']).forEach(function (faction) {
        counter[faction] = (counter[faction] || 0) + 1;
      });
    });
    state.factionsByPlanet = counter;
  }

  function systemFactions(system: SystemRecord): string[] {
    var set: string[] = [];
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

  var searchIndex: CatalogSearchEntry[] = [];

  function buildSearchIndex(): void {
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

  function score(entry: CatalogSearchEntry, needle: string): number {
    var key = entry.key;
    if (!needle) return 0;
    if (key === needle) return 1200;
    if (key.indexOf(needle) === 0) return 900 - key.length;
    var word = key.split(/[\s-]+/);
    for (var i = 0; i < word.length; i++) {
      if (word[i]!.indexOf(needle) === 0) return 700 - key.length;
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

  function search(query: string): SearchEntry[] {
    var rawQuery = String(query || '').trim();
    var coordinate = travelCore && travelCore.parseMapCoordinateQuery(rawQuery, mapSize());
    if (coordinate) {
      return [{
        kind: 'coordinate',
        kindLabel: 'Координаты',
        glyph: '⌖',
        id: 'coordinates:' + coordinate.x + ',' + coordinate.y,
        title: 'X ' + coordinate.xText + ' · Y ' + coordinate.yText,
        subtitle: 'Перейти к точке карты · можно вставить X и Y из таблицы через Tab',
        x: coordinate.x,
        y: coordinate.y
      }];
    }

    var needle = normalize(rawQuery);
    if (needle.length < 1) return [];
    var results: Array<{ entry: CatalogSearchEntry; value: number }> = [];
    for (var i = 0; i < searchIndex.length; i++) {
      var entry = searchIndex[i]!;
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
  return {
    loadDataset,
    buildModel,
    mapSize,
    explicitMapNumber,
    coordinateOnMap,
    normalizedSystemType,
    sheetValue,
    isPlatformPlace,
    placeTypesOf,
    primaryPlaceType,
    placeTypeLabel,
    placeTypeGlyph,
    factionsOf,
    systemFactions,
    search,
  };
}
