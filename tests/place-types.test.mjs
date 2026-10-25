/* Карточка C: места без типа (`none` / пустая ячейка) — не планеты.
 *
 * Проверяем ровно контракт нормализации типа места и меток/глифов каталога.
 * Источник данных — `data/places.csv` (читается с диска, без хардкода имён).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { normalizedPlaceType, createDataLoader } = require('../src/atlas/data-loader.ts');
const { PLACE_TYPES } = require('../src/atlas/config.ts');

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
