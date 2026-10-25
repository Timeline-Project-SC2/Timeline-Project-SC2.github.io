/* Карточка C: места без типа (`none` / пустая ячейка) — не планеты.
 *
 * Проверяем ровно контракт нормализации типа места, меток/глифов каталога и
 * видимости вида «Иное место» (`CATALOG_VIEW_TYPES` + реальный
 * `matchesCatalogView`): место из таблицы не должно пропадать из каталога.
 * Источник данных — `data/places.csv` (читается с диска, без хардкода имён).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { normalizedPlaceType, createDataLoader } = require('../src/atlas/data-loader.ts');
const { CATALOG_VIEW_TYPES, PLACE_TYPES } = require('../src/atlas/config.ts');
const { createCatalogPanel } = require('../src/atlas/catalog-panel.ts');

// Виды вкладки «Места» (вкладка «Системы» мест не фильтрует).
const CATALOG_VIEWS = ['planet', 'station', 'platform', 'other'];

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function readCsv(relativeUrl) {
  const lines = readFileSync(new URL(relativeUrl, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

const placesCsv = readCsv('../data/places.csv');

// Минимальное ядро: `createDataLoader` в момент создания читает только state/runtime.
function makeKernel() {
  return { state: {}, runtime: { travelCore: null } };
}

// Минимальное ядро каталога: при создании `createCatalogPanel` только сохраняет
// ссылки на doc/state/el/skin, а `matchesCatalogView` читает данные через лоадер.
function makeCatalog() {
  return createCatalogPanel({
    doc: null,
    state: {},
    el: {},
    skin: {},
    data: createDataLoader(makeKernel()),
  });
}

// Запись места ровно в том виде, в каком её отдаёт лоадер для строки places.csv
// (`mapPlaceRow`: `placeTypes: [normalizedPlaceType(row.type)]`).
function placeFromRow(row) {
  return { id: row.ID, name: row.name, placeTypes: [normalizedPlaceType(row.type)] };
}

test('C1: пустая ячейка и легаси `none` дают `unknown`, а не `planet`', function () {
  assert.equal(normalizedPlaceType('none'), 'unknown');
  assert.equal(normalizedPlaceType('None'), 'unknown');
  assert.equal(normalizedPlaceType('  none  '), 'unknown');
  assert.equal(normalizedPlaceType(''), 'unknown');
  assert.equal(normalizedPlaceType('   '), 'unknown');
  assert.equal(normalizedPlaceType('unknown'), 'unknown');
});

test('C2: легаси-поведение сохраняется только там, где типа нет вообще', function () {
  assert.equal(normalizedPlaceType(undefined), 'planet');
  assert.equal(normalizedPlaceType(null), 'planet');
});

test('C3: явный тип не подменяется', function () {
  assert.equal(normalizedPlaceType('planet'), 'planet');
  assert.equal(normalizedPlaceType('Planet'), 'planet');
  assert.equal(normalizedPlaceType('moon'), 'moon');
  assert.equal(normalizedPlaceType('station'), 'station');
  assert.equal(normalizedPlaceType('other'), 'other');
});

test('C4: PLACE_TYPES.unknown объявлен с label/plural/glyph', function () {
  assert.ok(Object.prototype.hasOwnProperty.call(PLACE_TYPES, 'unknown'));
  const unknown = PLACE_TYPES.unknown;
  assert.equal(unknown.label, 'Без типа');
  assert.equal(unknown.plural, 'места без типа');
  assert.equal(unknown.glyph, '?');
  for (const type of ['planet', 'moon', 'asteroid', 'station', 'platform', 'other']) {
    assert.ok(PLACE_TYPES[type], 'потерян тип ' + type);
  }
});

test('C5: в data/places.csv ровно две строки с типом none, и обе становятся `unknown`', function () {
  const withoutType = placesCsv.filter((row) => String(row.type || '').trim().toLowerCase() === 'none');
  assert.equal(withoutType.length, 2);
  withoutType.forEach((row) => {
    assert.equal(normalizedPlaceType(row.type), 'unknown', 'строка ' + row.ID);
  });
  // Ни одна другая строка снимка не должна прилипнуть к `unknown`.
  const unknownRows = placesCsv.filter((row) => normalizedPlaceType(row.type) === 'unknown');
  assert.equal(unknownRows.length, 2);
});

test('C6: регрессия — места с типом planet остаются планетами', function () {
  const planets = placesCsv.filter((row) => String(row.type || '').trim().toLowerCase() === 'planet');
  assert.ok(planets.length > 0);
  planets.forEach((row) => {
    assert.equal(normalizedPlaceType(row.type), 'planet', 'строка ' + row.ID);
  });
});

test('C7: placeTypeLabel/placeTypeGlyph не бросают на `unknown`', function () {
  const kernel = makeKernel();
  const data = createDataLoader(kernel);
  const place = { id: 'probe', name: 'Проба', placeTypes: ['unknown'] };
  assert.equal(data.primaryPlaceType(place), 'unknown');
  assert.equal(data.placeTypeLabel(place), 'Без типа');
  assert.equal(data.placeTypeLabel(place, true), 'Без типа');
  assert.equal(data.placeTypeGlyph(place), '?');
  // Фолбэк для незнакомого значения тоже не должен бросать.
  const custom = { id: 'custom', name: 'Кастом', placeTypes: ['artifact'] };
  assert.equal(data.placeTypeLabel(custom), 'artifact');
  assert.equal(data.placeTypeGlyph(custom), 'М');
});

test('C8: вид «Иное место» включает `unknown`', function () {
  assert.equal(CATALOG_VIEW_TYPES.other.includes('unknown'), true);
  ['moon', 'asteroid', 'other'].forEach(function (type) {
    assert.equal(CATALOG_VIEW_TYPES.other.includes(type), true, 'вид other потерял ' + type);
  });
});

test('C9: `planet` не попал в вид «Иное место»', function () {
  assert.equal(CATALOG_VIEW_TYPES.other.includes('planet'), false);
  // Ни один тип из PLACE_TYPES не должен выпасть из всех видов: иначе место
  // такого типа не видно ни в одной вкладке и не считается в счётчиках.
  const views = Object.keys(CATALOG_VIEW_TYPES);
  assert.deepEqual(views.slice().sort(), CATALOG_VIEWS.slice().sort());
  Object.keys(PLACE_TYPES).forEach(function (type) {
    const inViews = CATALOG_VIEWS.filter(function (view) {
      return CATALOG_VIEW_TYPES[view].includes(type);
    });
    assert.ok(inViews.length > 0, 'тип ' + type + ' не виден ни в одном виде');
  });
});

test('C10: каждая строка places.csv с типом none видна в «Ином месте» и считается в счётчике', function () {
  const catalog = makeCatalog();
  const places = placesCsv.map(placeFromRow);
  const withoutType = places.filter(function (place) { return place.placeTypes[0] === 'unknown'; });
  assert.equal(withoutType.length, 2);

  // Счётчик секции «Иные места» — тот же фильтр, что в renderSectionCounts.
  const otherCounted = places.filter(function (place) { return catalog.matchesCatalogView(place, 'other'); });
  // Пул чипов типа — как в currentTypePool для вкладки «Места».
  const pool = {};
  otherCounted.forEach(function (place) {
    place.placeTypes.forEach(function (type) { pool[type] = (pool[type] || 0) + 1; });
  });

  withoutType.forEach(function (place) {
    assert.equal(catalog.matchesCatalogView(place, 'other'), true, 'не видно в «Ином месте»: ' + place.name);
    assert.ok(otherCounted.indexOf(place) > -1, 'не посчитано в счётчике: ' + place.name);
    assert.equal(catalog.catalogViewForPlace(place), 'other', 'досье ведёт не в «Иное место»: ' + place.name);
    // Ровно один вид: иначе место задваивает счётчики вкладок.
    const views = CATALOG_VIEWS.filter(function (view) { return catalog.matchesCatalogView(place, view); });
    assert.deepEqual(views, ['other'], 'должно быть ровно в одном виде: ' + place.name);
  });
  // Без чипа `unknown` фильтр по таким местам не выбрать.
  assert.equal(pool.unknown, withoutType.length);
});

test('C11: каждая строка places.csv попадает ровно в один вид «Мест»', function () {
  const catalog = makeCatalog();
  placesCsv.map(placeFromRow).forEach(function (place) {
    const views = CATALOG_VIEWS.filter(function (view) { return catalog.matchesCatalogView(place, view); });
    assert.equal(views.length, 1, 'строка ' + place.id + ' (' + place.name + ') в видах: ' + JSON.stringify(views));
  });
});

test('C12: станция и платформа по-прежнему не пересекаются видами', function () {
  const catalog = makeCatalog();
  const station = { id: 'probe-station', name: 'Станция Проба', placeTypes: ['station'] };
  const platform = {
    id: 'probe-platform',
    name: 'Platform Probe',
    placeTypes: ['station'],
    wikiCategories: ['Space platforms'],
  };
  assert.deepEqual(
    CATALOG_VIEWS.filter(function (view) { return catalog.matchesCatalogView(station, view); }),
    ['station']
  );
  assert.deepEqual(
    CATALOG_VIEWS.filter(function (view) { return catalog.matchesCatalogView(platform, view); }),
    ['platform']
  );
  const explicit = { id: 'probe-explicit', name: 'Платформа Проба', placeTypes: ['platform'] };
  assert.deepEqual(
    CATALOG_VIEWS.filter(function (view) { return catalog.matchesCatalogView(explicit, view); }),
    ['platform']
  );
});
