import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { PROPERTY_FIELDS, createPropertySession, editProperty, undoProperty, redoProperty, propertyChanges } = createRequire(import.meta.url)('../src/atlas/sector-property-session.ts');
const snapshot = (dataset, recordId, raw = 'из Sheets', effective = 'с поправкой') => ({
  dataset, recordId,
  fields: Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, { raw, effective }])),
});

test('очистка сохраняет raw, опубликованное значение и пустой результат отдельно', () => {
  const initial = createPropertySession([snapshot('systems', '1')]);
  const edited = editProperty(initial, 'systems', '1', 'description', '');
  assert.deepEqual(propertyChanges(edited), [{ dataset: 'systems', recordId: '1', field: 'description', raw: 'из Sheets', before: 'с поправкой', after: '' }]);
  assert.deepEqual(propertyChanges(initial), []);
});

test('одинаковые ID разных datasets и разные поля независимы; undo/redo', () => {
  const initial = createPropertySession([snapshot('systems', '1'), snapshot('places', '1', null, '')]);
  const first = editProperty(initial, 'systems', '1', 'name', 'Имя');
  const second = editProperty(first, 'places', '1', 'description', '«А»\n<b>');
  assert.equal(propertyChanges(second).length, 2);
  assert.deepEqual(propertyChanges(undoProperty(second)), propertyChanges(first));
  assert.deepEqual(propertyChanges(redoProperty(undoProperty(second))), propertyChanges(second));
  const alternate = editProperty(undoProperty(second), 'places', '1', 'name', 'Б');
  assert.equal(redoProperty(alternate), alternate);
});

test('возврат к исходному видимому значению исключает изменение; одинаковое не пишет историю', () => {
  const session = createPropertySession([snapshot('systems', '1')]);
  assert.equal(editProperty(session, 'systems', '1', 'name', 'с поправкой'), session);
  const edited = editProperty(session, 'systems', '1', 'name', 'другое');
  assert.deepEqual(propertyChanges(editProperty(edited, 'systems', '1', 'name', 'с поправкой')), []);
});

test('повторы и отсутствующие объекты отклоняются, снимок копируется', () => {
  const input = snapshot('systems', '1');
  assert.throws(() => createPropertySession([input, input]), /Повтор/);
  const session = createPropertySession([input]);
  input.fields.name.effective = 'изменено снаружи';
  assert.equal(session.snapshots[0].fields.name.effective, 'с поправкой');
  assert.throws(() => editProperty(session, 'places', '1', 'name', 'А'), RangeError);
  assert.throws(() => editProperty(session, 'systems', '1', 'id', 'А'), TypeError);
});
