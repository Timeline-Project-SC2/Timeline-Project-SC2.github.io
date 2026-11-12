/* Map Atlas — загрузка CSV/JSON, нормализация записей, модель и индекс поиска. */

import {
  CONFIG,
  NEUTRAL_FACTION_LABEL,
  NO_FACTION_KEY,
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
  FactionColor,
  FactionDetails,
  MapCoord,
  MapLabel,
  MapPoint,
  PlaceRecord,
  PlanetProfileStatus,
  SearchEntry,
  SectorBounds,
  SystemRecord,
  UnknownRecord,
} from './config.ts';
import { parseBounds } from './sector-bounds.ts';
import { applyPropertyOverlay, parsePropertyOverlay } from './sector-property-overlay.ts';
import type { PropertyOverlay, PropertyOverride } from './sector-property-overlay.ts';
import type { PropertySnapshot, PropertySnapshotField } from './sector-property-session.ts';
import { PROPERTY_INPUT_FILES, verifyPropertyBuildInputs } from './sector-property-input-contract.ts';
import type { PropertyInputFile, PropertyInputBytes } from './sector-property-input-contract.ts';
import { parseSectorAreas } from './sector-areas-contract.ts';
import type { SectorAreasDoc } from './sector-areas-contract.ts';

type SheetRow = Record<string, string>;

interface SheetSystemData {
  systemType: string;
  coord: MapCoord | null;
  primaryFaction: string;
  note: string;
  sourceUrl: string;
  /** Историческая колонка `net_id`: текст ячейки, пустая ячейка — ''. */
  netId: string;
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
  net_id?: number | null;
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

  let propertyRevision: string | null = null;
  let propertyLoadEpoch = 0;
  let capturedInputs = new Map<PropertyInputFile, Promise<Uint8Array | null | undefined>>();

  // Сохраняются байты того же HTTP-ответа, который реально читает загрузчик.
  function capturePropertyInput(url: string, response: Response): void {
    const file = url.split('?')[0]?.replace(/^\/data\//, '') as PropertyInputFile | undefined;
    if (!file || !PROPERTY_INPUT_FILES.includes(file)) return;
    const html = response.headers?.get('content-type')?.toLowerCase().includes('text/html') ?? false;
    if (response.status === 404 || (response.ok && html && file.endsWith('.json') && file !== 'sector-property-overlay.json')) {
      capturedInputs.set(file, Promise.resolve(null)); return;
    }
    if (!response.ok || typeof response.clone !== 'function') { capturedInputs.set(file, Promise.resolve(undefined)); return; }
    capturedInputs.set(file, response.clone().arrayBuffer().then((value) => new Uint8Array(value)).catch(() => undefined));
  }

  async function checkPropertyInputs(suffix: string, epoch: number): Promise<void> {
    try {
      if (!globalThis.crypto?.subtle) return;
      const result = await fetch(CONFIG.data.dir + 'sector-property-build-inputs.json' + suffix, { credentials: 'same-origin' });
      if (!result.ok) return;
      const manifest = await result.json() as unknown;
      const pairs = await Promise.all(PROPERTY_INPUT_FILES.map(async (name) => [name, await capturedInputs.get(name)] as const));
      if (pairs.some(([, value]) => value === undefined)) return;
      const bytes = Object.fromEntries(pairs) as PropertyInputBytes;
      const verified = await verifyPropertyBuildInputs(manifest, bytes, globalThis.crypto.subtle);
      if (epoch === propertyLoadEpoch) propertyRevision = verified.contentRevision;
    } catch (error) {
      console.warn('Не удалось подтвердить отпечаток входов свойств:', error);
    }
  }

  function fetchJSON<T>(url: string, fallback: T): Promise<T> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        capturePropertyInput(url, response);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (response.headers?.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('Ожидался JSON, получен HTML');
        return response.json() as Promise<T>;
      })
      .catch(function () { return fallback; });
  }

  function fetchSectorBounds(url: string): Promise<SectorBounds | null> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json() as Promise<unknown>;
      })
      .then(function (raw) {
        return parseBounds(raw);
      })
      .catch(function (err) {
        console.error('Границы сектора: ' + (err instanceof Error ? err.message : String(err)));
        return null;
      });
  }

  /** Области редактора границ: тот же файл `data/sector-areas.json`, что и у `/sector/`. */
  function fetchSectorAreas(url: string): Promise<SectorAreasDoc | null> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json() as Promise<unknown>;
      })
      .then(function (raw) {
        return parseSectorAreas(raw);
      })
      .catch(function (err) {
        console.error('Области сектора: ' + (err instanceof Error ? err.message : String(err)));
        return null;
      });
  }

  // RFC-подобный разбор: переносы внутри кавычек принадлежат ячейке.
  // Значения остаются сырыми для сравнения базы поправок; нормализация — в sheetCell.
  function parseCSV(text: string): SheetRow[] {
    const records: string[][] = [];
    let record: string[] = [];
    let cell = '';
    let quoted = false;
    const source = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (quoted) {
        if (c === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell.length === 0) quoted = true;
      else if (c === ',') { record.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && source[i + 1] === '\n') i++;
        record.push(cell); records.push(record); record = []; cell = '';
      } else cell += c;
    }
    if (quoted) throw new Error('Незакрытая кавычка CSV');
    if (cell || record.length) { record.push(cell); records.push(record); }
    const headers = records.shift()?.map((header) => header.trim()) ?? [];
    return records.filter((values) => values.some((value) => value.trim() !== '')).map((values) => {
      const row: SheetRow = {};
      headers.forEach((header, index) => { row[header] = values[index] ?? ''; });
      return row;
    });
  }

  function fetchCSV(url: string, required = false): Promise<SheetRow[]> {
    return fetch(url, { credentials: 'same-origin' })
      .then(function (response) {
        capturePropertyInput(url, response);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        if (response.headers?.get('content-type')?.toLowerCase().includes('text/html')) throw new Error('Ожидался CSV, получен HTML');
        return response.text();
      })
      .then(parseCSV)
      .catch(function (error: unknown) {
        if (required) throw new Error('Не удалось загрузить исходный CSV: ' + url, { cause: error });
        return [];
      });
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

  /**
   * Историческая колонка `net_id`: целое число от 1, иначе `null`.
   * Данные сохранены для совместимости снимков; слой сетей больше не рисуется.
   */
  function netIdValue(value: unknown): number | null {
    var text = sheetValue(value);
    if (!text) return null;
    var parsed = Number(text);
    return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
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
      net_id: netIdValue(row.net_id),
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
        sourceUrl: sheetCell(row, 'source_url'),
        netId: sheetCell(row, 'net_id')
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
          // Пустой `net_id` в CSV не затирает сохранённое значение записи.
          if (sheetData.netId) update.net_id = netIdValue(sheetData.netId);
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

  /* Цвета фракций — снимок листа `faction_details` (`data/factions.csv`).
   * Строки читаются по заголовку, поэтому порядок колонок листа не важен.
   * Строка «—» — «фракции нет»: её цвет получают пустая и неизвестная фракции.
   * Неизвестное имя — это ошибка данных листа, а не рантайма: предупреждаем
   * один раз на имя и красим нейтральным цветом, но не падаем. */
  var factionDetailsByName = new Map<string, FactionDetails>();
  var warnedUnknownFactions = new Set<string>();

  function setFactionRows(rows: SheetRow[]): void {
    var byName = new Map<string, FactionDetails>();
    (rows || []).forEach(function (row) {
      var name = sheetCell(row, 'faction');
      if (!name) return;
      byName.set(name, {
        color: sheetCell(row, 'color').toLowerCase(),
        short: sheetCell(row, 'short'),
        order: explicitMapNumber(sheetCell(row, 'order'))
      });
    });
    factionDetailsByName = byName;
    warnedUnknownFactions = new Set<string>();
  }

  function neutralFactionColor(): FactionColor {
    var neutral = factionDetailsByName.get(NO_FACTION_KEY);
    return neutral ? neutral.color : '';
  }

  function factionColor(name: string | null | undefined): FactionColor {
    var key = sheetValue(name);
    if (!key || key === NO_FACTION_KEY || key === NEUTRAL_FACTION_LABEL) {
      return neutralFactionColor();
    }
    var details = factionDetailsByName.get(key);
    if (details) return details.color;
    if (!warnedUnknownFactions.has(key)) {
      warnedUnknownFactions.add(key);
      console.warn('Фракция «' + key + '» отсутствует в data/factions.csv: использован нейтральный цвет.');
    }
    return neutralFactionColor();
  }

  function factionsByName(): ReadonlyMap<string, FactionDetails> {
    return factionDetailsByName;
  }

  let activePropertyChanges: readonly PropertyOverride[] = [];
  let propertySources: { systems: SheetRow[]; places: SheetRow[] } = { systems: [], places: [] };

  function fetchPropertyOverlay(url: string): Promise<PropertyOverlay> {
    return fetch(url, { credentials: 'same-origin' }).then((response) => {
      capturePropertyInput(url, response);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json() as Promise<unknown>;
    }).then(parsePropertyOverlay).catch((error: unknown) => {
      throw new Error('Слой свойств не загружен: ' + (error instanceof Error ? error.message : String(error)));
    });
  }

  function preparePropertyChanges(overlay: PropertyOverlay, systems: SheetRow[], places: SheetRow[]): void {
    propertySources = { systems, places };
    const result = applyPropertyOverlay(overlay, { systems, places });
    const blocked = new Set(result.problems.filter((problem) => problem.reason !== 'upstream_changed').map((problem) => problem.change));
    // applyPropertyOverlay проверяет документ и создаёт копии записей; сопоставление по ключу.
    const blockedKeys = new Set([...blocked].map((change) => JSON.stringify([change.dataset, change.recordId, change.field])));
    activePropertyChanges = overlay.changes.filter((change) => !blockedKeys.has(JSON.stringify([change.dataset, change.recordId, change.field])));
    result.problems.forEach((problem) => console.warn('Слой свойств: ' + problem.reason + ' (' + problem.change.dataset + ', ' + problem.change.recordId + ', ' + problem.change.field + ')'));
  }

  function applyPropertyChanges(systems: SystemRecord[], places: PlaceRecord[]): void {
    const indices = {
      systems: new Map<string, SystemRecord[]>(),
      places: new Map<string, PlaceRecord[]>(),
    };
    systems.forEach((system) => indices.systems.set(String(system.id), [...(indices.systems.get(String(system.id)) ?? []), system]));
    places.forEach((place) => indices.places.set(String(place.id), [...(indices.places.get(String(place.id)) ?? []), place]));
    activePropertyChanges.forEach((change) => {
      const matches = indices[change.dataset].get(change.recordId);
      if (!matches || matches.length !== 1) {
        console.warn('Слой свойств: объект отсутствует или неоднозначен в модели (' + change.dataset + ', ' + change.recordId + ')');
        return;
      }
      const target = matches[0]!;
      const value = sheetValue(change.value);
      switch (change.field) {
        case 'name': target.name = change.value; break;
        case 'description': target.note = change.value; break;
        case 'source_url': target.sourceUrl = value; break;
        case 'faction': target.primaryFaction = value; target.factions = value ? [value] : []; break;
        case 'type':
          if (change.dataset === 'systems') (target as SystemRecord).systemType = normalizedSystemType(change.value);
          else (target as PlaceRecord).placeTypes = [normalizedPlaceType(change.value)];
          break;
      }
    });
  }

  /** Снимок доступен только для записей с однозначным ID в источнике и модели. */
  function propertySnapshots(): PropertySnapshot[] {
    const snapshots: PropertySnapshot[] = [];
    for (const dataset of ['systems', 'places'] as const) {
      const rows = propertySources[dataset];
      const idField = dataset === 'systems' ? 'system_id' : 'ID';
      const records = dataset === 'systems' ? state.systems : state.planets;
      const rawCounts = new Map<string, number>();
      const modelCounts = new Map<string, number>();
      rows.forEach((row) => { const id = row[idField]; if (id) rawCounts.set(id, (rawCounts.get(id) ?? 0) + 1); });
      records.forEach((record) => { const id = String(record.id); modelCounts.set(id, (modelCounts.get(id) ?? 0) + 1); });
      const byId = new Map(records.map((record) => [String(record.id), record]));
      for (const row of rows) {
        const id = row[idField];
        if (!id || rawCounts.get(id) !== 1 || modelCounts.get(id) !== 1) continue;
        const record = byId.get(id)!;
        const property = (field: string, effective: string | undefined): PropertySnapshotField => ({
          raw: Object.hasOwn(row, field) ? row[field]! : null,
          effective: effective ?? '',
        });
        const type = dataset === 'systems' ? (record as SystemRecord).systemType : (record as PlaceRecord).placeTypes?.[0];
        snapshots.push({ dataset, recordId: id, fields: {
          name: property('name', record.name),
          type: property('type', type),
          faction: property('faction', record.primaryFaction),
          description: property('description', record.note),
          source_url: property('source_url', record.sourceUrl),
        } });
      }
    }
    return snapshots;
  }

  function loadDataset(): Promise<AtlasDataset> {
    propertyRevision = null;
    const epoch = ++propertyLoadEpoch;
    capturedInputs = new Map();
    const inline = window.__MAP_DATA__;
    if (inline && inline.systems) {
      const inlineBoundsPromise: Promise<SectorBounds | null> = inline.sectorBounds !== undefined
        ? Promise.resolve(inline.sectorBounds)
        : fetchSectorBounds(CONFIG.data.dir + CONFIG.data.bounds);
      const inlineAreasPromise: Promise<SectorAreasDoc | null> = inline.sectorAreas !== undefined
        ? Promise.resolve(inline.sectorAreas)
        : fetchSectorAreas(CONFIG.data.dir + CONFIG.data.areas);
      return Promise.all([
        fetchCSV('/data/systems.csv', true),
        fetchCSV('/data/places.csv', true),
        fetchCSV(CONFIG.data.dir + CONFIG.data.generation),
        fetchCSV('/data/factions.csv'),
        inlineBoundsPromise,
        inlineAreasPromise,
        fetchPropertyOverlay(CONFIG.data.dir + CONFIG.data.propertyOverlay)
      ]).then(function ([systemRows, placeRows, generationRows, factionRows, sectorBounds, sectorAreas, propertyOverlay]) {
        preparePropertyChanges(propertyOverlay, systemRows, placeRows);
        setFactionRows(factionRows);
        state.sectorBounds = sectorBounds;
        state.sectorAreas = sectorAreas;
        var planets = inline.planets || [];
        planets = planets.length
          ? mergeStandalonePoiRows(planets, placeRows)
          : placeRows.map(mapPlaceRow);
        planets = mergePlanetGenerationRows(planets, generationRows);
        return {
          meta: inline.meta || {},
          systems: mergeSystemTypes(inline.systems || [], systemRows),
          planets: planets,
          overrides: inline.overrides || { systems: {} },
          labels: inline.labels || [],
          sectorBounds: sectorBounds,
          sectorAreas: sectorAreas,
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
        fetchSectorBounds(dir + CONFIG.data.bounds + suffix),
        fetchSectorAreas(dir + CONFIG.data.areas + suffix),
        fetchCSV('/data/systems.csv' + suffix, true),
        fetchCSV('/data/places.csv' + suffix, true),
        fetchCSV(CONFIG.data.dir + CONFIG.data.generation + suffix),
        fetchCSV('/data/factions.csv' + suffix),
        fetchPropertyOverlay(dir + CONFIG.data.propertyOverlay + suffix)
      ]).then(function ([systemsJson, planetsJson, overrides, labels, sectorBounds, sectorAreas, systemRows, placeRows, generationRows, factionRows, propertyOverlay]) {
        preparePropertyChanges(propertyOverlay, systemRows, placeRows);
        setFactionRows(factionRows);
        state.sectorBounds = sectorBounds;
        state.sectorAreas = sectorAreas;
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
        return checkPropertyInputs(suffix, epoch).then(() => ({
          meta: meta,
          systems: systems,
          planets: planets,
          overrides: overrides,
          labels: labels,
          sectorBounds: sectorBounds,
          sectorAreas: sectorAreas,
        }));
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
    // Исторический `net_id` сохраняется для совместимости, но слой сетей
    // больше не рисуется. Удалённое поле не должно протекать из старых JSON-снимков.
    delete normalized.net_confront_id;
    normalized.net_id = netIdValue(system.net_id);
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
    applyPropertyChanges(state.systems, state.planets);
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
    propertySnapshots,
    propertyContentRevision: () => propertyRevision,
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
    factionColor,
    factionsByName,
    search,
  };
}
