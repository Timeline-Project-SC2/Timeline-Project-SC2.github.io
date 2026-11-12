import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assessPropertyConflicts } = createRequire(import.meta.url)('../src/issue-gateway/property-conflicts.ts');
const hash = 'a'.repeat(64);
const hash2 = 'b'.repeat(64);
const fields = () => Object.fromEntries(['name', 'type', 'faction', 'description', 'source_url'].map((key) => [key, { raw: key, effective: key }]));
const snapshot = () => ({ dataset: 'systems', recordId: 's1', fields: fields() });
const base = () => ({ contentRevision: hash, snapshots: [snapshot()] });
const current = () => ({ contentRevision: hash2, snapshots: [snapshot()] });
const draft = () => ({ type: 'sector-property-local-draft', version: 1, status: 'local-only', baseRevision: hash, changes: [{ dataset: 'systems', recordId: 's1', field: 'name', raw: 'name', before: 'name', after: 'Новое имя' }] });
const check = (d, b, c) => assessPropertyConflicts(d, b, c, new Set());

test('независимая правка другого поля не конфликтует', () => {
  const latest = current();
  latest.snapshots[0].fields.description.effective = 'другое';
  assert.deepEqual(check(draft(), base(), latest), { status: 'candidate_needs_validation' });
});

test('изменение текущего видимого значения или upstream конфликтует даже при совпадении с after', () => {
  for (const key of ['raw', 'effective']) {
    const latest = current();
    latest.snapshots[0].fields.name[key] = 'Новое имя';
    assert.deepEqual(check(draft(), base(), latest), { status: 'conflict' });
  }
});

test('несовпадение базы, raw, дубли и отсутствующие записи не разрешают обработку', () => {
  const missing = current(); missing.snapshots = [];
  const duplicate = current(); duplicate.snapshots.push(snapshot());
  const wrongBase = draft(); wrongBase.baseRevision = hash2;
  const forged = draft(); forged.changes[0].before = 'подмена';
  const duplicated = draft(); duplicated.changes.push({ ...duplicated.changes[0] });
  const noRevision = draft(); noRevision.baseRevision = null;
  for (const [d, b, c] of [[draft(), base(), missing], [draft(), base(), duplicate], [wrongBase, base(), current()], [forged, base(), current()], [duplicated, base(), current()], [noRevision, base(), current()]]) {
    assert.deepEqual(check(d, b, c), { status: 'indeterminate' });
  }
});

test('разные dataset не смешиваются; null и пустая строка различны', () => {
  const b = base(); b.snapshots[0].fields.name.raw = null;
  const d = draft(); d.changes[0].raw = null;
  const c = current(); c.snapshots[0].fields.name.raw = '';
  c.snapshots.push({ ...snapshot(), dataset: 'places' });
  assert.deepEqual(check(d, b, c), { status: 'conflict' });
  c.snapshots[0].fields.name.raw = null;
  assert.deepEqual(check(d, b, c), { status: 'candidate_needs_validation' });
});

test('ошибка любого поля блокирует черновик целиком', () => {
  const d = draft();
  d.changes.push({ ...d.changes[0], field: 'source_url', raw: 'source_url', before: 'source_url', after: 'javascript:alert(1)' });
  assert.deepEqual(check(d, base(), current()), { status: 'indeterminate' });
});
