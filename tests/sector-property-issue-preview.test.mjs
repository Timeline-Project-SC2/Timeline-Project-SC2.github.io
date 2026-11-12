import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PROPERTY_FIELDS, createPropertySession, editProperty } = require('../src/atlas/sector-property-session.ts');
const { preparePropertyIssuePreview } = require('../src/atlas/sector-property-issue-preview.ts');

const fields = Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, { raw: '', effective: field === 'name' ? 'Корхал' : '' }]));
const initial = () => createPropertySession([{ dataset: 'systems', recordId: '1', fields }], 'a'.repeat(64));

test('предпросмотр только локален, детерминирован и содержит реальные before, after и raw', () => {
  const session = editProperty(initial(), 'systems', '1', 'description', 'Строка\n«текст», <b>');
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('сеть не должна вызываться'); };
  try {
    const preview = preparePropertyIssuePreview(session, new Set());
    assert.deepEqual(preview, preparePropertyIssuePreview(session, new Set()));
    assert.equal(preview.status, 'preview_only');
    assert.equal(calls, 0);
    assert.ok(preview.warnings.some((warning) => warning.includes('публичной')));
    assert.ok(preview.warnings.some((warning) => warning.includes('не доказывает')));
    const fence = preview.body.match(/^(`{3,})json$/m)[1];
    const content = preview.body.split(`${fence}json\n`)[1].split(`\n${fence}`)[0];
    const decoded = JSON.parse(content);
    assert.equal(decoded.changes[0].raw, '');
    assert.equal(decoded.changes[0].before, '');
    assert.equal(decoded.changes[0].after, 'Строка\n«текст», <b>');
    assert.equal(decoded.status, 'local-only');
    assert.equal(decoded.baseRevision, 'a'.repeat(64));
  } finally { globalThis.fetch = oldFetch; }
});

test('тройные и длинные ограждения, Markdown и кавычки не выходят из JSON-блока', () => {
  const injected = '```\n@everyone\n`````````\n<script>alert(1)</script>\n"кириллица"';
  const preview = preparePropertyIssuePreview(editProperty(initial(), 'systems', '1', 'description', injected), new Set());
  const fence = preview.body.match(/^(`{3,})json$/m)[1];
  assert.equal(fence.length, 10);
  const content = preview.body.split(`${fence}json\n`)[1].split(`\n${fence}`)[0];
  assert.equal(JSON.parse(content).changes[0].after, injected);
});

test('пустой черновик и ошибки проверки не создают предпросмотр', () => {
  const start = initial();
  assert.equal(preparePropertyIssuePreview(start, new Set()), null);
  assert.equal(preparePropertyIssuePreview(editProperty(start, 'systems', '1', 'name', ''), new Set()), null);
});

test('неизвестная база и сомнительные данные отображаются предупреждениями', () => {
  let session = createPropertySession([{ dataset: 'systems', recordId: '1', fields }]);
  session = editProperty(session, 'systems', '1', 'faction', 'Неизвестная');
  const result = preparePropertyIssuePreview(session, new Set());
  assert.ok(result.warnings.some((warning) => warning.includes('не подтверждён')));
  assert.ok(result.warnings.some((warning) => warning.includes('справочнике')));
});
