import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('исторические колонки сетей из снимка загружаются без потери данных', async () => {
  const text = readFileSync(new URL('../data/systems.csv', import.meta.url), 'utf8');
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  try {
    globalThis.window = { __MAP_DATA__: null };
    globalThis.document = { currentScript: null };
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => String(url).includes('systems.csv') ? text : '',
      json: async () => [],
    });
    const { createDataLoader } = require('../src/atlas/data-loader.ts');
    const dataset = await createDataLoader({ state: {}, runtime: { travelCore: null } }).loadDataset();
    assert.equal(dataset.systems.length, 173);
    const byName = new Map(dataset.systems.map((system) => [system.name, system]));
    assert.deepEqual([byName.get('Корхал').net_id, byName.get('Корхал').net_confront_id], [1, null]);
    assert.deepEqual([byName.get('Умоджа').net_id, byName.get('Умоджа').net_confront_id], [3, '3-1']);
    assert.equal(byName.get('Корхал').primaryFaction, 'Доминион Терран');
    assert.deepEqual(byName.get('Корхал').coord, [5720, 6257]);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
  }
});
