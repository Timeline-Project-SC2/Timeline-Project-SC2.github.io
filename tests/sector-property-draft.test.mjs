import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PROPERTY_FIELDS, createPropertySession, editProperty } = require('../src/atlas/sector-property-session.ts');
const { preparePropertyDraft, restorePropertyDraft, validatePropertyChanges } = require('../src/atlas/sector-property-draft.ts');

const snapshot = (dataset, id) => ({ dataset, recordId: id, fields: Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, { raw: field === 'name' ? 'raw' : null, effective: field === 'name' ? 'имя' : '' }])) });
const change = (field, after, dataset = 'systems') => ({ dataset, recordId: '1', field, raw: null, before: '', after });

test('пакет не выдаётся без изменений или при пустом имени', () => {
  const session = createPropertySession([snapshot('systems', '1')]);
  assert.equal(preparePropertyDraft(session, new Set()).draft, null);
  const edited = editProperty(session, 'systems', '1', 'name', '  ');
  const result = preparePropertyDraft(edited, new Set());
  assert.equal(result.draft, null);
  assert.equal(result.problems[0].severity, 'error');
});

test('ссылка должна быть полным http(s) адресом без учётных данных', () => {
  for (const url of ['example.org', 'javascript:alert(1)', 'file:///etc/file', 'https://user:password@example.org', ' https://example.org', 'https://example.org\n']) {
    assert.equal(validatePropertyChanges([change('source_url', url)], new Set())[0]?.severity, 'error', url);
  }
  for (const url of ['', 'https://example.org/path?q=тест', 'http://example.org']) {
    assert.deepEqual(validatePropertyChanges([change('source_url', url)], new Set()), []);
  }
});

test('неизвестные типы и фракции предупреждают, а не утверждают политику записи', () => {
  const problems = validatePropertyChanges([change('type', 'unknown-new'), change('faction', 'Другие'), change('type', 'station', 'places'), change('faction', 'Дэлаамы')], new Set(['Дэлаамы']));
  assert.deepEqual(problems.map((problem) => problem.severity), ['warning', 'warning']);
});

test('черновик хранит raw и исходное отображаемое значение, но не утверждает версию или права', () => {
  const initial = createPropertySession([snapshot('systems', '1'), snapshot('places', '1')]);
  const session = editProperty(editProperty(initial, 'systems', '1', 'name', 'Новая'), 'places', '1', 'description', 'текст\n«цитата»');
  const { draft, problems } = preparePropertyDraft(session, new Set());
  assert.deepEqual(problems, []);
  assert.equal(draft.type, 'sector-property-local-draft');
  assert.equal(draft.status, 'local-only');
  assert.equal(draft.baseRevision, null);
  assert.deepEqual(draft.changes[0], { dataset: 'systems', recordId: '1', field: 'name', raw: 'raw', before: 'имя', after: 'Новая' });
  assert.equal(draft.changes[1].after, 'текст\n«цитата»');
  assert.deepEqual(JSON.parse(JSON.stringify(draft)), draft);
});


test('локальный черновик восстанавливается в новой сессии только на совпадающей базе', () => {
  const base = createPropertySession([snapshot('systems', '1'), snapshot('places', '1')]);
  const changed = editProperty(editProperty(base, 'systems', '1', 'name', 'Новое имя'), 'places', '1', 'description', '');
  const actual = editProperty(changed, 'places', '1', 'description', 'описание');
  const { draft } = preparePropertyDraft(actual, new Set());
  const restored = restorePropertyDraft(JSON.parse(JSON.stringify(draft)), base, new Set());
  assert.deepEqual(preparePropertyDraft(restored.session, new Set()).draft, draft);
  assert.throws(() => restorePropertyDraft(draft, actual, new Set()), /отмените/);
  const moved = snapshot('systems', '1');
  moved.fields.name.raw = 'другая таблица';
  const stale = createPropertySession([moved, snapshot('places', '1')]);
  assert.throws(() => restorePropertyDraft(draft, stale, new Set()), /данные изменились/);
  assert.deepEqual(preparePropertyDraft(stale, new Set()).draft, null);
});

test('при импорте запрещены дубликаты, посторонние поля и недопустимые значения', () => {
  const base = createPropertySession([snapshot('systems', '1')]);
  const session = editProperty(base, 'systems', '1', 'name', 'Имя');
  const { draft } = preparePropertyDraft(session, new Set());
  assert.throws(() => restorePropertyDraft({ ...draft, changes: [...draft.changes, ...draft.changes] }, base, new Set()), /Повтор/);
  assert.throws(() => restorePropertyDraft({ ...draft, changes: [{ ...draft.changes[0], field: 'system_id' }] }, base, new Set()), /Некорректное/);
  assert.throws(() => restorePropertyDraft({ ...draft, changes: [{ ...draft.changes[0], after: '' }] }, base, new Set()), /недопустимые/);
  assert.throws(() => restorePropertyDraft({ ...draft, baseRevision: 'подделка' }, base, new Set()), /Некорректный/);
});


test('локальный черновик записывает отпечаток входов и не восстанавливается на другом', () => {
  const revision = 'a'.repeat(64);
  const base = createPropertySession([snapshot('systems', '1')], revision);
  const edited = editProperty(base, 'systems', '1', 'name', 'Новое имя');
  const { draft } = preparePropertyDraft(edited, new Set());
  assert.equal(draft.baseRevision, revision);
  assert.equal(restorePropertyDraft(draft, base, new Set()).session.present[0].name, 'Новое имя');
  const newer = createPropertySession([snapshot('systems', '1')], 'b'.repeat(64));
  assert.throws(() => restorePropertyDraft(draft, newer, new Set()), /Отпечаток входов отличается/);
  assert.throws(() => restorePropertyDraft(draft, createPropertySession([snapshot('systems', '1')]), new Set()), /Отпечаток входов отличается/);
  assert.throws(() => createPropertySession([], 'fake'), TypeError);
});
