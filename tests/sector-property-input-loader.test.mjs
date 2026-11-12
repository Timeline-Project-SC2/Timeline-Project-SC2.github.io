import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectPropertyBuildInputs } = require('../tools/vite/sector-property-build-inputs.ts');
const { createDataLoader } = require('../src/atlas/data-loader.ts');

async function loadScenario({ mismatch = false, inline = false, optionalError = false, optionalHtml = false, requiredHtml = false } = {}) {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const root = mkdtempSync(join(tmpdir(), 'sector-input-loader-'));
  const files = {
    'systems.csv': 'system_id,name,type,x,y,faction,description,source_url\n1,Корхал,capital,1,2,,,\n',
    'places.csv': 'ID,name,type,system_id,x,y,faction,description,source_url\n1,Место,planet,1,,,,,\n',
    'sector-property-overlay.json': '{"version":1,"changes":[]}',
    'factions.csv': '',
    'meta.json': '{}',
  };
  try {
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), value);
    const manifest = collectPropertyBuildInputs(root);
    if (mismatch) files['systems.csv'] += '\n';
    globalThis.window = { __MAP_DATA__: inline ? { systems: [], sectorBounds: null, sectorAreas: null } : null };
    globalThis.document = { currentScript: null };
    globalThis.fetch = async (url) => {
      const name = String(url).split('?')[0].split('/').at(-1);
      if (name === 'sector-property-build-inputs.json') return new Response(JSON.stringify(manifest), { status: 200 });
      if (optionalError && name === 'system-overrides.json') return new Response('', { status: 500 });
      if (optionalHtml && name === 'system-overrides.json') return new Response('{"systems":{"1":{"name":"чужое"}}}', { status: 200, headers: { 'content-type': 'text/html' } });
      if (requiredHtml && name === 'systems.csv') return new Response('<html>Ошибка</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return Object.hasOwn(files, name) ? new Response(files[name], { status: 200 }) : new Response('', { status: 404 });
    };
    const api = createDataLoader({ state: {}, runtime: { travelCore: null } });
    const dataset = await api.loadDataset();
    return { revision: api.propertyContentRevision(), expected: manifest.contentRevision, overrides: dataset.overrides };
  } finally {
    Object.assign(globalThis, original);
    rmSync(root, { recursive: true, force: true });
  }
}

test('отпечаток присваивается только после сверки фактически прочитанных HTTP-ответов', async () => {
  const result = await loadScenario();
  assert.equal(result.revision, result.expected);
});

test('подмена входного CSV и ошибка необязательного JSON не дают подтверждённый отпечаток', async () => {
  assert.equal((await loadScenario({ mismatch: true })).revision, null);
  assert.equal((await loadScenario({ optionalError: true })).revision, null);
});

test('inline-данные не получают отпечаток файловой сборки', async () => {
  assert.equal((await loadScenario({ inline: true })).revision, null);
});


test('SPA fallback HTML не принимается за опциональный JSON или обязательный CSV', async () => {
  const fallback = await loadScenario({ optionalHtml: true });
  assert.equal(fallback.revision, fallback.expected);
  assert.deepEqual(fallback.overrides, { systems: {} });
  await assert.rejects(() => loadScenario({ requiredHtml: true }), /Не удалось загрузить исходный CSV/);
});
