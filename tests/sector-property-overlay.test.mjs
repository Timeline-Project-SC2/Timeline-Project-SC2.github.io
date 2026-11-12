import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parsePropertyOverlay, applyPropertyOverlay } = require('../src/atlas/sector-property-overlay.ts');

const entry = (dataset, recordId, field, base, value) => ({ dataset, recordId, field, base, value });
const document = (...changes) => ({ version: 1, changes });

test('слой различает datasets, очищает поле и не меняет исходные строки', () => {
  const input = { systems: [{ system_id: '1', description: 'старое', name: 'А' }], places: [{ ID: '1', description: 'место' }] };
  const before = structuredClone(input);
  const overlay = document(entry('systems', '1', 'description', 'старое', ''), entry('places', '1', 'description', 'место', 'текст\n«мир» <b>'));
  const result = applyPropertyOverlay(overlay, input);
  assert.equal(result.systems[0].description, '');
  assert.equal(result.places[0].description, 'текст\n«мир» <b>');
  assert.deepEqual(result.problems, []);
  assert.deepEqual(input, before);
});

test('изменение upstream не стирает утверждённую поправку и требует внимания', () => {
  const result = applyPropertyOverlay(document(entry('systems', '1', 'name', 'было', 'принято')), { systems: [{ system_id: '1', name: 'новое upstream' }], places: [] });
  assert.equal(result.systems[0].name, 'принято');
  assert.equal(result.problems[0].reason, 'upstream_changed');
});

test('удалённая и неоднозначная запись не создаётся и не меняется', () => {
  const input = { systems: [{ system_id: '1', name: 'А' }, { system_id: '1', name: 'Б' }], places: [] };
  const result = applyPropertyOverlay(document(entry('systems', '1', 'name', 'А', 'В'), entry('places', '1', 'name', null, 'Г')), input);
  assert.deepEqual(result.systems, input.systems);
  assert.deepEqual(result.places, []);
  assert.deepEqual(result.problems.map((p) => p.reason), ['duplicate_record', 'missing_record']);
});

test('отсутствующая колонка отлична от пустой', () => {
  const result = applyPropertyOverlay(document(entry('systems', '1', 'description', null, 'новое')), { systems: [{ system_id: '1', description: '' }], places: [] });
  assert.equal(result.problems[0].reason, 'upstream_changed');
});

test('схема отклоняет неизвестные поля, null вместо значения и повтор поля', () => {
  for (const value of [
    { version: 2, changes: [] },
    document(entry('systems', '1', 'system_id', '1', '2')),
    document(entry('systems', '1', 'name', '', null)),
    document(entry('systems', '1', 'name', '', 'А'), entry('systems', '1', 'name', '', 'Б')),
    { version: 1, changes: [], extra: true },
  ]) assert.throws(() => parsePropertyOverlay(value), TypeError);
});
