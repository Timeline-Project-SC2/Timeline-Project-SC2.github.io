// Ядро применения заявки: решение «применить / конфликт / неопределённо».
// Ни сети, ни записи файлов: только чистая логика над переданными данными.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planPropertyApply, propertyIdempotencyKey, propertyKey,
  isAlreadyProcessed, recordProcessed,
} = require('../src/issue-gateway/property-apply.ts');
const { PROPERTY_FIELDS } = require('../src/atlas/sector-property-session.ts');
const { applyPropertyOverlay } = require('../src/atlas/sector-property-overlay.ts');

const BASE = 'b'.repeat(64);
const REQUEST_ID = 'pr-abc12345-00112233445566778899aabbccddeeff';
const REPOSITORY_ID = 1421259694;

function packet(changes, overrides = {}) {
  return {
    type: 'sector-property-request',
    version: 2,
    requestId: REQUEST_ID,
    threadId: REQUEST_ID,
    repositoryId: REPOSITORY_ID,
    author: { id: 42, login: 'author-a' },
    createdAt: '2026-11-13T10:00:00.000Z',
    baseRevision: BASE,
    changes,
    ...overrides,
  };
}
const change = (overrides = {}) => ({
  dataset: 'systems', recordId: '1', field: 'description', before: 'старое', after: 'новое', ...overrides,
});

/** Строки источников: те же имена колонок, что в CSV. */
const systems = (...rows) => rows.map((row) => ({ system_id: '1', name: 'Корхал', type: 'capital', x: '10', y: '20', faction: '', description: '', source_url: '', ...row }));
const places = (...rows) => rows.map((row) => ({ ID: '7', name: 'Точка', type: 'poi', system_id: '', x: '1', y: '2', faction: '', description: '', source_url: '', ...row }));

function baseOf(rows, dataset, recordId, revision = BASE) {
  const fields = new Map();
  for (const row of rows) {
    const id = dataset === 'systems' ? row.system_id : row.ID;
    const values = {};
    for (const field of PROPERTY_FIELDS) values[field] = Object.hasOwn(row, field) ? row[field] : '';
    fields.set(propertyKey(dataset, id), values);
  }
  void recordId;
  return { contentRevision: revision, fields };
}

const upstream = (systemsRows, placesRows = []) => ({ systems: systemsRows, places: placesRows });
const emptyOverlay = () => ({ version: 1, changes: [] });

test('применение: один слой с прежними поправками, стабильный порядок, ключ идемпотентности', () => {
  const rows = systems({ description: 'старое' });
  const existing = {
    version: 1,
    changes: [{ dataset: 'systems', recordId: '9', field: 'name', base: 'старое имя', value: 'новое имя' }],
  };
  const result = planPropertyApply(
    packet([change({ field: 'name', before: 'Корхал', after: 'Корхал II' }), change()]),
    baseOf(rows, 'systems', '1'),
    upstream(rows),
    existing,
    501,
  );
  assert.equal(result.status, 'apply');
  const { plan } = result;
  assert.equal(plan.idempotencyKey, `issue:1421259694:501:${REQUEST_ID}`);
  assert.deepEqual(plan.additions.map((item) => item.field), ['name', 'description'], 'порядок по схеме полей');
  assert.deepEqual(plan.overlay.changes.map((item) => [item.dataset, item.recordId, item.field]), [
    ['systems', '1', 'name'], ['systems', '1', 'description'], ['systems', '9', 'name'],
  ], 'сортировка по набору, ID и полю');
  assert.equal(plan.unchanged, 0);
  assert.ok(plan.warnings.some((warning) => warning.includes('публикац')));
  assert.ok(plan.warnings.some((warning) => warning.includes('Owner')));
  // Исходный слой не изменён.
  assert.equal(existing.changes.length, 1);
});

test('повтор той же заявки: уже применено, новых записей нет', () => {
  const rows = systems({ description: 'старое' });
  const applied = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1'), upstream(rows), emptyOverlay(), 501);
  assert.equal(applied.status, 'apply');
  const again = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1'), upstream(rows), applied.plan.overlay, 501);
  assert.deepEqual(again, { status: 'already_applied', idempotencyKey: `issue:1421259694:501:${REQUEST_ID}` });
});

test('база: другой отпечаток или подменённое «до» — отказ, а не перезапись', () => {
  const rows = systems({ description: 'старое' });
  const wrongRevision = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1', 'c'.repeat(64)), upstream(rows), emptyOverlay(), 501);
  assert.equal(wrongRevision.status, 'refused');
  assert.equal(wrongRevision.reason, 'base_mismatch');

  const wrongBefore = planPropertyApply(packet([change({ before: 'что-то другое' })]), baseOf(rows, 'systems', '1'), upstream(rows), emptyOverlay(), 501);
  assert.equal(wrongBefore.status, 'refused');
  assert.equal(wrongBefore.reason, 'base_mismatch');

  const noBase = { contentRevision: BASE, fields: new Map() };
  const missing = planPropertyApply(packet([change()]), noBase, upstream(rows), emptyOverlay(), 501);
  assert.equal(missing.reason, 'base_mismatch');

  const badBase = planPropertyApply(packet([change()]), { contentRevision: 'не-хэш', fields: new Map() }, upstream(rows), emptyOverlay(), 501);
  assert.equal(badBase.reason, 'indeterminate');
});

test('конфликт: значение в источнике изменилось после базы', () => {
  const base = systems({ description: 'старое' });
  const changed = systems({ description: 'кто-то поправил' });
  const result = planPropertyApply(packet([change()]), baseOf(base, 'systems', '1'), upstream(changed), emptyOverlay(), 501);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'conflict');
  assert.ok(result.details.some((detail) => detail.includes('изменилось в источнике')));
});

test('конфликт: в слое уже утверждено другое значение', () => {
  const rows = systems({ description: 'старое' });
  const overlay = { version: 1, changes: [{ dataset: 'systems', recordId: '1', field: 'description', base: 'старое', value: 'утверждено ранее' }] };
  const result = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1'), upstream(rows), overlay, 501);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'conflict');
  assert.ok(result.details.some((detail) => detail.includes('уже утверждено')));
});

test('независимые поля того же объекта применяются, если не конфликтуют', () => {
  const base = systems({ description: 'старое', faction: '' });
  const overlay = { version: 1, changes: [{ dataset: 'systems', recordId: '1', field: 'description', base: 'старое', value: 'новое' }] };
  const result = planPropertyApply(
    packet([change({ field: 'faction', before: '', after: 'Протосс' })]),
    baseOf(base, 'systems', '1'),
    upstream(base),
    overlay,
    501,
  );
  assert.equal(result.status, 'apply');
  assert.equal(result.plan.overlay.changes.length, 2);
  assert.equal(result.plan.additions.length, 1);
});

test('запись: пропала, дублируется или лежит в другом наборе данных', () => {
  const base = systems({ description: 'старое' });
  const gone = planPropertyApply(packet([change()]), baseOf(base, 'systems', '1'), upstream([]), emptyOverlay(), 501);
  assert.equal(gone.reason, 'record_missing');

  const duplicated = systems({ description: 'старое' }, { description: 'старое' });
  const ambiguous = planPropertyApply(packet([change()]), baseOf(base, 'systems', '1'), upstream(duplicated), emptyOverlay(), 501);
  assert.equal(ambiguous.reason, 'record_missing');
  assert.ok(ambiguous.details.some((detail) => detail.includes('неоднозначна')));

  // Тот же ID в places — это другая запись и другой набор данных.
  const otherDataset = planPropertyApply(
    packet([change({ dataset: 'places', recordId: '7' })]),
    baseOf(base, 'systems', '1'),
    upstream(base, places()),
    emptyOverlay(),
    501,
  );
  assert.equal(otherDataset.reason, 'base_mismatch');
});

test('места используют ID, а не system_id; пустые ID не индексируются', () => {
  const rows = places({ ID: '7', description: 'старое' });
  const base = baseOf(rows, 'places', '7');
  const result = planPropertyApply(
    packet([change({ dataset: 'places', recordId: '7' })]),
    base,
    upstream([], rows),
    emptyOverlay(),
    501,
  );
  assert.equal(result.status, 'apply');
  const withEmpty = places({ ID: '', description: 'старое' });
  const missing = planPropertyApply(packet([change({ dataset: 'places', recordId: '' })]), base, upstream([], withEmpty), emptyOverlay(), 501);
  assert.equal(missing.status, 'refused', 'пустой ID не должен находить запись');
});

test('отсутствие колонки и явная пустая строка различаются', () => {
  const row = systems({ description: 'старое' });
  delete row[0].description;
  const result = planPropertyApply(packet([change({ before: '', after: 'новое' })]), baseOf(row, 'systems', '1'), upstream(row), emptyOverlay(), 501);
  // Колонки нет: текущее значение null, «до» было пустой строкой → не перезаписываем молча.
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'conflict');
});

test('невалидная заявка, слой и номер Issue не приводят к применению', () => {
  const rows = systems({ description: 'старое' });
  const base = baseOf(rows, 'systems', '1');
  const cases = [
    [{ ...packet([change()]), extra: 1 }, emptyOverlay(), 501],
    [packet([change({ after: 'старое' })]), emptyOverlay(), 501],
    [packet([change()]), { version: 2, changes: [] }, 501],
    [packet([change()]), { version: 1, changes: [{ dataset: 'systems', recordId: '1', field: 'нет', base: null, value: 'x' }] }, 501],
    [packet([change()]), emptyOverlay(), 0],
    [packet([change()]), emptyOverlay(), -3],
    [packet([change()]), emptyOverlay(), 1.5],
    [packet([change({ dataset: 'planets' })]), emptyOverlay(), 501],
  ];
  for (const [request, overlay, number] of cases) {
    const result = planPropertyApply(request, base, upstream(rows), overlay, number);
    assert.equal(result.status, 'refused', JSON.stringify({ request, overlay, number }));
    assert.ok(['invalid_request', 'indeterminate'].includes(result.reason), result.reason);
  }
});

test('ключ идемпотентности: формат, отказ на некорректных данных, «правка текста = тот же ключ»', () => {
  assert.equal(propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID), `issue:1421259694:501:${REQUEST_ID}`);
  assert.equal(propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID), propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID));
  assert.throws(() => propertyIdempotencyKey(0, REQUEST_ID, REPOSITORY_ID), TypeError);
  assert.throws(() => propertyIdempotencyKey(501, 'short', REPOSITORY_ID), TypeError);
  // Разные Issue и разные заявки — разные ключи: второй автор не перезапишет первый.
  assert.notEqual(propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID), propertyIdempotencyKey(502, REQUEST_ID, REPOSITORY_ID));
  assert.notEqual(propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID), propertyIdempotencyKey(501, 'pr-abc12345-ffffffffffffffffffffffffffff', REPOSITORY_ID));
});

test('журнал обработанных заявок: без повторов, порядок сохраняется', () => {
  const key = propertyIdempotencyKey(501, REQUEST_ID, REPOSITORY_ID);
  assert.deepEqual(recordProcessed([], key), [key]);
  assert.deepEqual(recordProcessed([key], key), [key]);
  assert.deepEqual(recordProcessed([key], propertyIdempotencyKey(502, REQUEST_ID, REPOSITORY_ID)),
    [key, propertyIdempotencyKey(502, REQUEST_ID, REPOSITORY_ID)]);
  assert.equal(isAlreadyProcessed([key], key), true);
  assert.equal(isAlreadyProcessed([key], propertyIdempotencyKey(502, REQUEST_ID, REPOSITORY_ID)), false);
  assert.throws(() => recordProcessed([], ''), TypeError);
});

test('два автора на одном поле: первая применённая правка не перезаписывается второй', () => {
  const rows = systems({ description: 'старое' });
  const current = baseOf(rows, 'systems', '1');
  const authorA = packet([change({ after: 'вариант A' })], { requestId: 'pr-aaaa1111-00112233445566778899aabbccddeeff' });
  const first = planPropertyApply(authorA, current, upstream(rows), emptyOverlay(), 601);
  assert.equal(first.status, 'apply');

  // Автор B сделал правку на той же базе, но после применения A.
  const authorB = packet([change({ after: 'вариант B' })], { requestId: 'pr-bbbb2222-00112233445566778899aabbccddeeff' });
  const second = planPropertyApply(authorB, current, upstream(rows), first.plan.overlay, 602);
  assert.equal(second.status, 'refused');
  assert.equal(second.reason, 'conflict');
  assert.notEqual(first.plan.idempotencyKey, propertyIdempotencyKey(602, 'pr-bbbb2222-00112233445566778899aabbccddeeff', REPOSITORY_ID));
});

test('слой не мутирует входные данные и не зависит от порядка вызова', () => {
  const rows = systems({ description: 'старое' });
  const overlay = { version: 1, changes: [] };
  const snapshot = JSON.stringify(overlay);
  const first = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1'), upstream(rows), overlay, 501);
  assert.equal(JSON.stringify(overlay), snapshot);
  const second = planPropertyApply(packet([change()]), baseOf(rows, 'systems', '1'), upstream(rows), overlay, 501);
  assert.deepEqual(first, second);
  assert.notEqual(first.plan.overlay, second.plan.overlay, 'каждый вызов возвращает свой документ');
});

test('новый слой читается тем же загрузчиком карты: карточка видит новое значение, а не старое', () => {
  const rows = systems({ description: 'старое' });
  const overlay = { version: 1, changes: [] };
  const plan = planPropertyApply(packet([change({ after: 'Строка\nс «текстом» | и трубой' })]), baseOf(rows, 'systems', '1'), upstream(rows), overlay, 501);
  assert.equal(plan.status, 'apply');
  const applied = applyPropertyOverlay(plan.plan.overlay, { systems: rows, places: [] });
  assert.deepEqual(applied.problems, [], 'проблем сопоставления быть не должно');
  assert.equal(applied.systems[0].description, 'Строка\nс «текстом» | и трубой');
  assert.equal(rows[0].description, 'старое', 'входные строки не изменяются');
});

test('sync-триггер: устаревание базы видно как upstream_changed, а не молчаливая перезапись', () => {
  const baseRows = systems({ description: 'старое' });
  const plan = planPropertyApply(packet([change()]), baseOf(baseRows, 'systems', '1'), upstream(baseRows), emptyOverlay(), 501);
  assert.equal(plan.status, 'apply');
  const syncRows = systems({ description: 'обновлено из Sheets' });
  const applied = applyPropertyOverlay(plan.plan.overlay, { systems: syncRows, places: [] });
  assert.equal(applied.problems.length, 1);
  assert.equal(applied.problems[0].reason, 'upstream_changed');
  // Утверждённое значение сохраняется: слой — приоритетнее источника.
  assert.equal(applied.systems[0].description, 'новое');
});
