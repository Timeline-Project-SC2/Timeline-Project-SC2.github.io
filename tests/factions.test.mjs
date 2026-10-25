import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);

const NO_FACTION_KEY = '\u2014';

function csvLine(line) {
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

function readCsv(relativePath) {
  const text = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = csvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = csvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { headers, rows, text };
}

/** Сырая фракция CSV: пустая ячейка и легаси `none` — «фракции нет». */
function cellFaction(row) {
  const text = String(row.faction ?? '').trim();
  return text.toLowerCase() === 'none' ? '' : text;
}

const factionsCsv = readCsv('../data/factions.csv');
const systemsCsv = readCsv('../data/systems.csv');
const placesCsv = readCsv('../data/places.csv');
const factionKeys = factionsCsv.rows.map((row) => row.faction);
const neutralRow = factionsCsv.rows.find((row) => row.faction === NO_FACTION_KEY);

/** Загрузчик данных на живых снимках CSV: fetch отдаёт файлы репозитория. */
async function loadDataLoader() {
  const restore = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  try {
    globalThis.window = { __MAP_DATA__: null };
    globalThis.document = { currentScript: null };
    globalThis.fetch = async (url) => {
      const target = String(url);
      const text = target.includes('factions.csv')
        ? factionsCsv.text
        : target.includes('systems.csv')
          ? systemsCsv.text
          : target.includes('places.csv')
            ? placesCsv.text
            : '';
      return {
        ok: true,
        status: 200,
        text: async () => text,
        json: async () => (target.includes('meta.json') ? {} : []),
      };
    };
    const loader = require('../src/atlas/data-loader.ts');
    const api = loader.createDataLoader({ state: {}, runtime: { travelCore: null } });
    await api.loadDataset();
    return api;
  } finally {
    globalThis.window = restore.window;
    globalThis.document = restore.document;
    globalThis.fetch = restore.fetch;
  }
}

test('C1: factions.csv — шапка и 8 строк: 7 фракций + «—»', () => {
  assert.deepEqual(factionsCsv.headers, ['faction', 'color', 'short', 'order', 'source_url']);
  assert.equal(factionsCsv.rows.length, 8);
  assert.equal(factionKeys.filter((key) => key !== NO_FACTION_KEY).length, 7);
});

test('C2: все цвета factions.csv совпадают с ^#[0-9a-f]{6}$', () => {
  for (const row of factionsCsv.rows) {
    assert.match(row.color, /^#[0-9a-f]{6}$/, `цвет «${row.faction}»: ${row.color}`);
  }
});

test('C3: строка «—» (U+2014) ровно одна', () => {
  const neutral = factionsCsv.rows.filter((row) => row.faction === NO_FACTION_KEY);
  assert.equal(neutral.length, 1);
  assert.equal(neutral[0].faction.charCodeAt(0), 0x2014);
  assert.match(neutral[0].color, /^#[0-9a-f]{6}$/, 'у строки «—» обязателен цвет');
});

test('C4: ключи factions.csv уникальны и непусты', () => {
  assert.ok(factionKeys.every((key) => key !== ''), 'есть строка без ключа faction');
  assert.equal(new Set(factionKeys).size, factionKeys.length);
});

test('C5: каждая фракция из systems.csv есть в таблице фракций', () => {
  const known = new Set(factionKeys);
  const used = [...new Set(systemsCsv.rows.map(cellFaction).filter(Boolean))];
  const unknown = used.filter((faction) => !known.has(faction));
  assert.deepEqual(unknown, [], `неизвестные фракции в systems.csv: ${unknown.join(', ')}`);
});

test('C6: каждая фракция из places.csv есть в таблице фракций', () => {
  const known = new Set(factionKeys);
  const used = [...new Set(placesCsv.rows.map(cellFaction).filter(Boolean))];
  const unknown = used.filter((faction) => !known.has(faction));
  assert.deepEqual(unknown, [], `неизвестные фракции в places.csv: ${unknown.join(', ')}`);
});

test('C7: пустое имя возвращает цвет «—», а не белый по умолчанию', async () => {
  const api = await loadDataLoader();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    // Пустое и отсутствующее имя — нейтральный табличный цвет без предупреждений.
    assert.equal(api.factionColor(''), neutralRow.color);
    assert.equal(api.factionColor(null), neutralRow.color);
    assert.equal(api.factionColor(undefined), neutralRow.color);
    assert.equal(api.factionColor(''), '#dfe7f2');
    assert.notEqual(api.factionColor(''), '#ffffff');
    // Известная фракция — её собственный цвет, отличимый от нейтрального.
    assert.equal(api.factionColor('Доминион Терран'), '#fe0000');
    assert.notEqual(api.factionColor('Доминион Терран'), api.factionColor(''));
    // Карта фракций несёт short/order из той же таблицы.
    const dominion = api.factionsByName().get('Доминион Терран');
    assert.deepEqual(dominion, { color: '#fe0000', short: 'Доминион', order: 1 });
    assert.deepEqual(warnings, []);
  } finally {
    console.warn = originalWarn;
  }
});

test('C8: неизвестное имя даёт цвет «—» и одно предупреждение на имя', async () => {
  const api = await loadDataLoader();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.equal(api.factionColor('Фракция Которой Нет'), neutralRow.color);
    assert.equal(api.factionColor('Фракция Которой Нет'), neutralRow.color);
    assert.equal(warnings.length, 1, 'повторное имя предупредило второй раз');
    assert.ok(warnings[0].includes('Фракция Которой Нет'));
    assert.equal(api.factionColor('Другая Неизвестная'), neutralRow.color);
    assert.equal(warnings.length, 2, 'новое неизвестное имя не предупредило');
  } finally {
    console.warn = originalWarn;
  }
});

test('C9: systems.csv — 173 строки, 57 без фракции', () => {
  assert.equal(systemsCsv.rows.length, 173);
  const without = systemsCsv.rows.filter((row) => cellFaction(row) === '');
  assert.equal(without.length, 57);
});

test('C10: в src/atlas не осталось factionHue', () => {
  const dir = new URL('../src/atlas/', import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => readFileSync(new URL(name, dir), 'utf8').includes('factionHue'));
  assert.deepEqual(offenders, [], `factionHue остался в: ${offenders.join(', ')}`);
});
