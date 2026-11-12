import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createDataLoader } = require('../src/atlas/data-loader.ts');

const systemsCsv = 'system_id,name,type,x,y,faction,description,source_url\n1,Система,standard,100,200,Фракция,"Старая\nстрока",old\n';
const placesCsv = 'ID,name,type,system_id,x,y,faction,description,source_url\n1,Место,planet,1,,,Фракция,Старое,old\n2,POI,station,,300,400,,Исходное,old\n';
const changes = [
  { dataset: 'systems', recordId: '1', field: 'description', base: 'Старая\nстрока', value: '' },
  { dataset: 'systems', recordId: '1', field: 'name', base: 'Система', value: 'Новое имя' },
  { dataset: 'systems', recordId: '1', field: 'faction', base: 'Фракция', value: '' },
  { dataset: 'places', recordId: '1', field: 'description', base: 'Старое', value: 'Новая строка\n«текст» <b>' },
  { dataset: 'places', recordId: '1', field: 'type', base: 'planet', value: 'station' },
  { dataset: 'places', recordId: '2', field: 'source_url', base: 'old', value: 'https://example.org/' },
];

async function run(inline, overlay = { version: 1, changes }, missingCsv = false) {
  const original = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const state = { order: { systems: [], planets: [] }, planetsById: {}, labels: [] };
  try {
    globalThis.window = { __MAP_DATA__: inline ? {
      systems: [{ id: '1', name: 'JSON', note: 'JSON-текст', worlds: [], planetIds: [] }],
      planets: [{ id: '1', name: 'Место', note: 'JSON-текст', systemId: '1' }],
      overrides: { systems: { 1: { name: 'Старый override', description: 'Старый override', faction: 'Старая фракция' } } },
      sectorBounds: null, sectorAreas: null,
    } : null };
    globalThis.document = { currentScript: null };
    globalThis.fetch = async (url) => {
      const path = String(url).split('?')[0];
      return { ok: !(missingCsv && path.endsWith('/systems.csv')), status: missingCsv && path.endsWith('/systems.csv') ? 503 : 200,
        text: async () => path.endsWith('/systems.csv') ? systemsCsv : path.endsWith('/places.csv') ? placesCsv : '',
        json: async () => path.endsWith('/sector-property-overlay.json') ? overlay
          : path.endsWith('/system-overrides.json') ? { systems: { 1: { name: 'Старый override', description: 'Старый override', faction: 'Старая фракция' } } }
            : path.endsWith('/meta.json') ? {} : [],
      };
    };
    const api = createDataLoader({ state, runtime: { travelCore: null } });
    const dataset = await api.loadDataset();
    Object.assign(state, { meta: dataset.meta, systemsRaw: dataset.systems, planets: dataset.planets, overrides: dataset.overrides, labels: dataset.labels });
    api.buildModel();
    return { ...state, propertySnapshots: api.propertySnapshots() };
  } finally {
    Object.assign(globalThis, original);
  }
}

for (const inline of [false, true]) test(`поправки после legacy overrides и при повторной сессии: ${inline ? 'inline' : 'обычная загрузка'}`, async () => {
  for (let session = 0; session < 2; session++) {
    const state = await run(inline);
    const system = state.systemsById['1'];
    assert.equal(system.id, '1');
    assert.equal(system.name, 'Новое имя');
    assert.equal(system.note, '');
    assert.equal(system.primaryFaction, '');
    assert.deepEqual(system.factions, []);
    assert.equal(state.planetsById['1'].note, 'Новая строка\n«текст» <b>');
    assert.deepEqual(state.planetsById['1'].placeTypes, ['station']);
    assert.equal(system.worlds[0].note, 'Новая строка\n«текст» <b>');
    assert.equal(state.planetsById['2'].sourceUrl, 'https://example.org/');
  }
});

test('поправка не оживляет удалённую исходную запись из legacy JSON', async () => {
  const state = await run(true, { version: 1, changes: [{ dataset: 'systems', recordId: 'missing', field: 'description', base: '', value: 'Нет' }] });
  assert.equal(state.systemsById.missing, undefined);
});


test('некорректный слой не заменяется пустым и загрузка не показывает устаревшие значения', async () => {
  await assert.rejects(() => run(false, { version: 2, changes: [] }), /Слой свойств не загружен/);
});

test('текст сохраняет пробелы и буквальный none после нормализации модели', async () => {
  const state = await run(false, { version: 1, changes: [
    { dataset: 'places', recordId: '1', field: 'description', base: 'Старое', value: ' none \n' },
  ] });
  assert.equal(state.planetsById['1'].note, ' none \n');
});


test('ошибка загрузки CSV не маскируется под отсутствие записи', async () => {
  await assert.rejects(() => run(false, { version: 1, changes }, true), /Не удалось загрузить исходный CSV/);
});


test('снимок сессии разделяет сырой CSV и опубликованное значение', async () => {
  const state = await run(true);
  const system = state.propertySnapshots.find((item) => item.dataset === 'systems' && item.recordId === '1');
  const place = state.propertySnapshots.find((item) => item.dataset === 'places' && item.recordId === '1');
  assert.deepEqual(system.fields.description, { raw: 'Старая\nстрока', effective: '' });
  assert.deepEqual(system.fields.name, { raw: 'Система', effective: 'Новое имя' });
  assert.deepEqual(place.fields.description, { raw: 'Старое', effective: 'Новая строка\n«текст» <b>' });
});
