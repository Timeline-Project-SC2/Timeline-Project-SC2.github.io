/* Каналы между сетями (`net_confront_id`, карточка Z-3.8).
 *
 * Проверки C1…C13 карточки — по одной на тест, плюс стыки, которые карточка
 * требует явно: ширина и яркость ленты, детерминизм порядка строк CSV,
 * отдельный проход отрисовки в `canvas-renderer.ts` и неизменность баблов.
 * Блок «D» — колонки сетей в загрузчике (`data-loader.ts` отдаёт `net_id` и
 * `net_confront_id`, пустая ячейка — `null`), блок «бюджет кадра» —
 * `MAX_CHANNELS_PER_FRAME` режет отрисовку, а не геометрию.
 *
 * Смысл данных: `net_id` — сеть системы, `net_confront_id` — пара «свой-чужой»,
 * где первое число ВСЕГДА равно собственному `net_id` системы, а остальные —
 * цели. Запись «1-2-3» даёт два канала (1↔2 и 1↔3), а не цепочку. Допустимые
 * номера целей задаёт фактический набор сетей в данных, а не константа.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const net = require('../src/atlas/faction-net.ts');

const {
  BRIDGE_WIDTH_RATIO,
  CHANNEL_BRIGHTNESS,
  CHANNEL_WIDTH_RATIO,
  MAX_CHANNELS_PER_FRAME,
  NET_CONFRONT_MIN_ID,
  NET_CONFRONT_MIN_PARTS,
  NET_LAYER_LEVELS,
  bubbleFor,
  bubblePath,
  channelsFor,
  netConfrontTargets,
  parseNetId,
  parseNetworks,
} = net;

const DOMINION = 'Доминион Терран';
const KMS = 'Кел-Морийский Синдикат';
const DAELAAM = 'Дэлаамы';

/** Строка данных в том виде, в каком её читает слой сетей (сырой CSV). */
function sys(id, name, x, y, faction, netId, confront) {
  const row = { id, name, x, y, faction, type: 'standard', net_id: netId };
  if (confront !== undefined) row.net_confront_id = confront;
  return row;
}

/** Ключ пары систем: `A-B` и `B-A` обязаны давать один ключ (правило 3). */
function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function channelKeys(channels) {
  return channels.map((channel) => pairKey(channel.from.systemId, channel.to.systemId));
}

function assertNoDuplicates(channels) {
  const keys = channelKeys(channels);
  assert.equal(new Set(keys).size, keys.length, `дубли лент: ${keys.join(', ')}`);
}

function throwsWithName(systems, name, what) {
  assert.throws(
    () => channelsFor(systems),
    (error) => {
      assert.ok(error instanceof RangeError, `${what}: ожидался RangeError, получен ${error}`);
      assert.ok(
        error.message.includes(name),
        `${what}: в сообщении нет имени системы «${name}»: ${error.message}`,
      );
      return true;
    },
    what,
  );
}

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

function readCsv(url) {
  const text = readFileSync(url, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = csvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = csvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { headers, rows };
}

const SYSTEMS_CSV = readCsv(new URL('../data/systems.csv', import.meta.url));

/** Табличные цвета фракций (`data/factions.csv`, Z-3.7) — источник резолвера. */
const FACTION_COLORS = (() => {
  const { headers, rows } = readCsv(new URL('../data/factions.csv', import.meta.url));
  assert.ok(headers.includes('color'), 'в factions.csv нет колонки color');
  const colors = new Map();
  for (const row of rows) colors.set(row.faction, row.color);
  return colors;
})();

/** Резолвер в духе загрузчика: неизвестное и пустое имя — цвет строки «—». */
function tableColor(faction) {
  return FACTION_COLORS.get(faction) ?? FACTION_COLORS.get('\u2014');
}

function tableRgb(faction) {
  const hex = tableColor(faction);
  return `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
}

/* --------------------------------------------------------------- C1…C13 */

test('C1 — «1-2», у сети 2 все пусты: канал к ближайшей системе сети 2', () => {
  const declarer = sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2');
  const near = sys('2', 'Бета', 5400, 5000, KMS, 2, '');
  const far = sys('3', 'Гамма', 6500, 5000, KMS, 2, '');

  const result = channelsFor([declarer, near, far], { factionColor: tableColor });
  assert.equal(result.channels.length, 1, 'каналов должно быть ровно один');
  assert.equal(result.warnings.length, 0);

  const channel = result.channels[0];
  assert.equal(channel.pair, '1-2');
  assert.equal(channel.from.systemId, '1', 'первый конец — система с меньшим номером сети');
  assert.equal(channel.to.systemId, '2', 'партнёр автоматический: ближайшая система сети 2');
  assert.equal(channel.forced, false, 'встречного объявления нет — связь не принудительная');
  assert.deepEqual(channel.declaredBy, ['1']);
  assert.equal(channel.gap, 400, 'длина — расстояние до ближайшей системы, а не до дальней');
  // Канал идёт от системы до системы сквозь баблы: концы не обрезаются лепестками.
  assert.equal(channel.length, channel.gap);
  assert.deepEqual(channel.stops.map((stop) => stop.faction), [DOMINION, KMS]);
});

test('C2 — «2-1» у системы сети 2: принудительная пара, даже если другая ближе', () => {
  const declarer = sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2');
  const closer = sys('3', 'Близкая', 5100, 5000, KMS, 2, '');
  const mutual = sys('2', 'Встречная', 6500, 5000, KMS, 2, '2-1');

  const result = channelsFor([declarer, closer, mutual], { factionColor: tableColor });
  assert.equal(result.channels.length, 1, 'пара A-B и B-A не должна дублироваться');

  const channel = result.channels[0];
  assert.equal(channel.to.systemId, '2', 'связь принудительная именно с объявившей системой');
  assert.notEqual(channel.to.systemId, '3', 'ближайшая система сети 2 не подменила партнёра');
  assert.equal(channel.forced, true);
  assert.equal(channel.gap, 1500, 'лента тянется к дальней, но встречной системе');
  assert.deepEqual(channel.declaredBy, ['1', '2'], 'пару объявили обе системы');
  assertNoDuplicates(result.channels);
});

test('C3 — «1-2» при отсутствии сети 2: RangeError с именем системы', () => {
  throwsWithName(
    [sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2')],
    'Альфа',
    'C3: сеть-цель не существует',
  );
  // Сеть есть в данных, но без координат: тоже ошибка, а не молчаливый пропуск.
  throwsWithName(
    [
      sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
      { id: '2', name: 'Без координат', faction: KMS, net_id: 2, net_confront_id: '' },
    ],
    'Альфа',
    'C3: у сети-цели нет координат',
  );
});

test('C4 — «2-2» и «2-2-3»: цель равна своей сети — RangeError', () => {
  const rival = sys('9', 'Сосед', 5400, 5000, DOMINION, 1, '');
  throwsWithName(
    [sys('1', 'Альфа', 5000, 5000, KMS, 2, '2-2'), rival],
    'Альфа',
    'C4: «2-2»',
  );
  throwsWithName(
    [sys('1', 'Альфа', 5000, 5000, KMS, 2, '2-2-3'), rival, sys('2', 'Третья', 5600, 5000, DAELAAM, 3, '')],
    'Альфа',
    'C4: «2-2-3»',
  );
});

test('C5 — «1-2» у системы сети 2: первое число не своё — RangeError', () => {
  throwsWithName(
    [
      sys('1', 'Чужая', 5000, 5000, KMS, 2, '1-2'),
      sys('2', 'Вторая', 5400, 5000, DOMINION, 1, ''),
    ],
    'Чужая',
    'C5: первое число не равно net_id',
  );
  assert.throws(
    () => netConfrontTargets('1-2', 'Чужая', 2),
    (error) => error instanceof RangeError && error.message.includes('Чужая')
      && error.message.includes('net_id'),
  );
});

test('C6 — «abc», «1», «1-», «1-4-5-6-7»: RangeError', () => {
  const rival = sys('2', 'Бета', 5400, 5000, KMS, 2, '');
  const third = sys('3', 'Гамма', 5600, 5000, DAELAAM, 3, '');
  // В этих данных есть сети 1…3: любое другое число — цель в несуществующую сеть.
  const cases = [
    ['abc', 'не число'],
    ['1', 'одно число'],
    ['1-', 'пустая цель'],
    ['1-2-', 'пустой хвост'],
    ['1-4', 'сети 4 в данных нет'],
    ['1-0', 'номер сети меньше 1'],
    ['1-2-3-4-5', 'пять чисел: сетей 4 и 5 в данных нет'],
    ['1-4-5-6-7', 'все цели вне фактического набора сетей'],
    ['1.5-2', 'дробное число'],
  ];
  for (const [cell, what] of cases) {
    throwsWithName(
      [sys('1', 'Альфа', 5000, 5000, DOMINION, 1, cell), rival, third],
      'Альфа',
      `C6: «${cell}» (${what})`,
    );
  }

  // Проверка 5: net_id пуст или 0 при непустой ячейке — тоже ошибка.
  for (const netId of [0, '', '   ', null]) {
    throwsWithName(
      [sys('1', 'Вне сети', 5000, 5000, DOMINION, netId, '1-2'), rival],
      'Вне сети',
      `C6: net_id = ${JSON.stringify(netId)} при непустом net_confront_id`,
    );
  }

  // Диапазон номеров задают данные, а не константа: сеть 4 законна, если она есть.
  const wide = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-4-7'),
    rival,
    third,
    sys('4', 'Дельта', 5800, 5000, KMS, 4, ''),
    sys('5', 'Эпсилон', 6000, 5000, DAELAAM, 7, ''),
  ], { factionColor: tableColor });
  assert.deepEqual(wide.channels.map((channel) => channel.pair), ['1-2', '1-4', '1-7']);
  // Много целей в одной ячейке — тоже не ошибка: границы числа частей нет.
  assert.equal(netConfrontTargets('1-2-3-4-5-6', 'Альфа', 1).length, 5);

  // Константы слоя: нижние границы и бюджет кадра. Верхних границ номеров нет.
  assert.equal(NET_CONFRONT_MIN_ID, 1);
  assert.equal(NET_CONFRONT_MIN_PARTS, 2);
  assert.equal(MAX_CHANNELS_PER_FRAME, 24);
  assert.ok(!('NET_CONFRONT_MAX_ID' in net), 'NET_CONFRONT_MAX_ID должна быть удалена');
  assert.ok(!('NET_CONFRONT_MAX_PARTS' in net), 'NET_CONFRONT_MAX_PARTS должна быть удалена');
});

test('C7 — «1-2-3»: ровно два канала, цели разные, дублей нет', () => {
  const declarer = sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-3');
  const second = sys('2', 'Бета', 5400, 5000, KMS, 2, '');
  const third = sys('3', 'Гамма', 5000, 5600, DAELAAM, 3, '');

  const result = channelsFor([declarer, second, third], { factionColor: tableColor });
  assert.equal(result.channels.length, 2, '«1-2-3» — два канала, а не цепочка');
  assert.deepEqual(result.channels.map((channel) => channel.pair), ['1-2', '1-3']);
  assert.deepEqual(
    result.channels.map((channel) => channel.to.systemId),
    ['2', '3'],
    'цели разные',
  );
  assert.deepEqual(result.channels.map((channel) => channel.from.systemId), ['1', '1']);
  assertNoDuplicates(result.channels);
  assert.equal(result.warnings.length, 0, 'две пары без кольца — предупреждений нет');
});

test('C8 — «1-2-2» и «1-2-1»: повтор внутри ячейки — RangeError', () => {
  const second = sys('2', 'Бета', 5400, 5000, KMS, 2, '');
  throwsWithName(
    [sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-2'), second],
    'Альфа',
    'C8: «1-2-2»',
  );
  throwsWithName(
    [sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-1'), second],
    'Альфа',
    'C8: «1-2-1»',
  );
  assert.throws(
    () => netConfrontTargets('1-2-2', 'Альфа', 1),
    (error) => error instanceof RangeError && error.message.includes('повторяется'),
  );
});

test('C9 — цепочка 1 → 2 → 3 через две системы: две пары, дублей нет', () => {
  const first = sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2');
  const middle = sys('2', 'Бета', 5400, 5000, KMS, 2, '2-3');
  const last = sys('3', 'Гамма', 5800, 5000, DAELAAM, 3, '');

  const result = channelsFor([first, middle, last], { factionColor: tableColor });
  assert.equal(result.channels.length, 2, 'цепочка — две ленты: 1↔2 и 2↔3');
  assert.deepEqual(result.channels.map((channel) => channel.pair), ['1-2', '2-3']);
  assert.deepEqual(
    result.channels.map((channel) => `${channel.from.systemId}-${channel.to.systemId}`),
    ['1-2', '2-3'],
    'какие системы соединились',
  );
  assertNoDuplicates(result.channels);
  assert.equal(result.warnings.length, 0, 'цепочка не замкнута — кольца нет');

  // Встречное объявление в середине цепочки не добавляет третью ленту.
  const mutual = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5400, 5000, KMS, 2, '2-1-3'),
    sys('3', 'Гамма', 5800, 5000, DAELAAM, 3, ''),
  ], { factionColor: tableColor });
  assert.equal(mutual.channels.length, 2);
  assert.deepEqual(mutual.channels.map((channel) => channel.forced), [true, false]);
  assert.equal(mutual.warnings.length, 0);
  assertNoDuplicates(mutual.channels);
});

test('C10 — треугольник 1-2, 2-3, 3-1: три канала и предупреждение о кольце', () => {
  const result = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5400, 5000, KMS, 2, '2-3'),
    sys('3', 'Гамма', 5200, 5400, DAELAAM, 3, '3-1'),
  ], { factionColor: tableColor });

  assert.equal(result.channels.length, 3, 'треугольник — три ленты');
  assert.deepEqual(result.channels.map((channel) => channel.pair), ['1-2', '1-3', '2-3']);
  assertNoDuplicates(result.channels);

  // Кольцо разрешено: не исключение, а предупреждение — сборка карты проходит.
  assert.equal(result.warnings.length, 1, 'одно предупреждение о замкнутом кольце');
  const warning = result.warnings[0];
  assert.equal(warning.kind, 'ring');
  assert.deepEqual(warning.netIds, [1, 2, 3]);
  assert.ok(warning.message.includes('1 → 2 → 3 → 1'), warning.message);

  // Две ленты между одной парой сетей кольцом не считаются.
  const parallel = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5400, 5000, KMS, 2, '2-1'),
    sys('3', 'Гамма', 5000, 5400, DOMINION, 1, '1-2'),
  ], { factionColor: tableColor });
  assert.equal(parallel.channels.length, 2, 'две системы сети 1 объявили одну цель');
  assert.equal(parallel.warnings.length, 0, 'параллельные ленты — не кольцо');
  assertNoDuplicates(parallel.channels);
});

test('C11 — bubbleFor с каналами и без: JSON идентичен', () => {
  // Реальные координаты `data/systems.csv`: Корхал и Мистафф — сеть 1, Мория — сеть 2.
  const plain = [
    { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: DOMINION, type: 'capital', net_id: 1 },
    { id: '11', name: 'Мистафф', x: 5749, y: 6171, faction: DOMINION, type: 'standard', net_id: 1 },
    { id: '2', name: 'Мория', x: 5568, y: 5994, faction: KMS, type: 'capital', net_id: 2 },
  ];
  const declared = [
    { ...plain[0], net_confront_id: '1-2' },
    { ...plain[1], net_confront_id: '1-2' },
    { ...plain[2], net_confront_id: '2-1' },
  ];

  const options = { factionColor: tableColor };
  const netOneOf = (rows) => rows.filter((row) => parseNetId(row.net_id) === 1);
  assert.equal(
    JSON.stringify(bubbleFor(netOneOf(declared), options)),
    JSON.stringify(bubbleFor(netOneOf(plain), options)),
    'JSON бабла с каналами и без обязан совпадать побайтово',
  );
  assert.equal(
    JSON.stringify(bubbleFor(declared, options)),
    JSON.stringify(bubbleFor(plain, options)),
    'колонка net_confront_id не влияет на бабл смешанного входа',
  );

  const camera = { centerX: 5700, centerY: 6100, visibleWidth: 2500 };
  const viewport = { w: 1920, h: 1080 };
  assert.equal(
    bubblePath(bubbleFor(netOneOf(declared), options), camera, viewport),
    bubblePath(bubbleFor(netOneOf(plain), options), camera, viewport),
    'путь бабла не меняется от каналов',
  );
  assert.equal(
    JSON.stringify(parseNetworks(declared)),
    JSON.stringify(parseNetworks(plain)),
    'parseNetworks не читает net_confront_id',
  );

  // И сами каналы на этих данных строятся: две декларации сети 1 — две ленты.
  const result = channelsFor(declared, options);
  assert.equal(result.channels.length, 2);
  assert.ok(result.channels.every((channel) => channel.forced));
  assertNoDuplicates(result.channels);
});

test('C12 — цвета концов из factions.csv, хеш имени не используется', () => {
  const declarer = sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-3');
  const second = sys('2', 'Бета', 5400, 5000, KMS, 2, '');
  const third = sys('3', 'Гамма', 5000, 5600, DAELAAM, 3, '');

  const result = channelsFor([declarer, second, third], { factionColor: tableColor });
  assert.equal(result.channels.length, 2);
  const [first, next] = result.channels;
  assert.deepEqual(
    first.stops.map((stop) => stop.color),
    [tableRgb(DOMINION), tableRgb(KMS)],
    'градиент — табличные цвета фракций концов',
  );
  assert.deepEqual(
    next.stops.map((stop) => stop.color),
    [tableRgb(DOMINION), tableRgb(DAELAAM)],
  );
  assert.deepEqual(first.stops.map((stop) => stop.offset), [0, 1]);
  assert.notDeepEqual(
    first.stops.map((stop) => stop.color),
    next.stops.map((stop) => stop.color),
    'цвет зависит от фракции конца, а не от номера канала',
  );

  // Одна и та же фракция на обоих концах — один цвет на оба стопа: номера
  // канала и расстояние на оттенок не влияют.
  const sameFaction = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5400, 5000, DOMINION, 2, ''),
  ], { factionColor: tableColor });
  assert.deepEqual(
    sameFaction.channels[0].stops.map((stop) => stop.color),
    [tableRgb(DOMINION), tableRgb(DOMINION)],
  );

  // Переименование систем не меняет цвет: оттенок из имени не вычисляется.
  const renamed = channelsFor([
    sys('1', 'Совершенно другое имя', 5000, 5000, DOMINION, 1, '1-2-3'),
    sys('2', 'И тут другое', 5400, 5000, KMS, 2, ''),
    sys('3', 'Третье имя', 5000, 5600, DAELAAM, 3, ''),
  ], { factionColor: tableColor });
  assert.equal(
    JSON.stringify(renamed.channels.map((channel) => channel.stops)),
    JSON.stringify(result.channels.map((channel) => channel.stops)),
    'стопы не зависят от имён систем',
  );

  // Без резолвера табличного цвета градиента нет: цвет из имени не выдумывается.
  assert.deepEqual(channelsFor([declarer, second, third]).channels[0].stops, []);

  // Статически: в слое каналов нет хеша (FNV-1a «всполохов» и подобного ему).
  const source = readFileSync(new URL('../src/atlas/faction-net.ts', import.meta.url), 'utf8');
  const marker = source.indexOf('каналы между сетями (Z-3.8)');
  assert.ok(marker > 0, 'в модуле нет слоя каналов');
  const channelSource = source.slice(marker);
  assert.ok(!/flareSeed/.test(channelSource), 'каналы используют хеш «всполохов»');
  assert.ok(!/Math\s*\.\s*imul/.test(channelSource), 'каналы считают хеш имени');
  assert.ok(!/Math\s*\.\s*random\s*\(/.test(channelSource), 'каналы используют случайность');
});

test('C13 — снимок data/systems.csv: разметка владельца даёт ровно один канал', () => {
  const { headers, rows } = SYSTEMS_CSV;
  // Позицию колонки задаёт лист владельца, код читает её по заголовку: важно,
  // что `net_confront_id` стоит сразу за `net_id`, а не «последней» вообще.
  assert.ok(headers.includes('net_confront_id'), 'в systems.csv нет колонки net_confront_id');
  assert.ok(
    headers.indexOf('net_confront_id') === headers.indexOf('net_id') + 1,
    'net_confront_id должна стоять сразу после net_id',
  );
  assert.equal(rows.length, 173, 'изменилось число систем');
  assert.equal(parseNetworks(rows).length, 4, 'на снимке четыре сети: 1, 2, 3, 4');

  const result = channelsFor(rows, { factionColor: tableColor });
  assert.deepEqual(result.warnings, [], 'на снимке нет замкнутых колец');
  assert.equal(result.channels.length, 1, 'две встречные ячейки дают одну ленту');

  const channel = result.channels[0];
  assert.equal(channel.pair, '1-3');
  assert.equal(channel.from.name, 'Тарсонис', 'первый конец — система сети с меньшим номером');
  assert.equal(channel.to.name, 'Умоджа');
  assert.equal(channel.forced, true, '«1-3» и «3-1» — взаимное объявление, пара принудительная');
  assert.deepEqual(channel.declaredBy, ['3', '13'], 'пару объявили Умоджа (id 3) и Тарсонис (id 13)');
  assert.deepEqual(
    channel.stops.map((stop) => stop.color),
    [tableRgb(DOMINION), tableRgb('Умоджанский Протекторат')],
  );
  assert.equal(channel.width, CHANNEL_WIDTH_RATIO * Math.min(channel.from.radius, channel.to.radius));

  // Пустая разметка — каналов ноль: так карта выглядит без ячеек владельца.
  const blank = rows.map((row) => ({ ...row, net_confront_id: '' }));
  const empty = channelsFor(blank, { factionColor: tableColor });
  assert.deepEqual(empty.channels, [], 'на пустой разметке каналов нет');
  assert.deepEqual(empty.warnings, [], 'предупреждений на пустой разметке нет');

  // Одна новая ячейка добавляет один канал без правки кода: сеть 2 (Мория) уже
  // размечена, достаточно объявить пару от имени системы сети 1.
  const labeled = rows.map((row) => (row.name === 'Корхал'
    ? { ...row, net_confront_id: '1-2' }
    : row));
  const filled = channelsFor(labeled, { factionColor: tableColor });
  assert.equal(filled.channels.length, 2, 'одна ячейка — один новый канал');
  const added = filled.channels.find((item) => item.pair === '1-2');
  assert.ok(added !== undefined, 'канал к сети 2 не построился');
  assert.equal(added.from.name, 'Корхал');
  assert.equal(added.to.name, 'Мория');
  assert.equal(added.forced, false, 'Мория встречного объявления не делала');
  assert.deepEqual(
    added.stops.map((stop) => stop.color),
    [tableRgb(DOMINION), tableRgb(KMS)],
  );
});

/* ------------------------------------------------------ вид и стыки слоя */

test('вид канала: ширина BRIDGE_WIDTH_RATIO · 0,5 и одна яркость на все каналы', () => {
  assert.equal(CHANNEL_WIDTH_RATIO, BRIDGE_WIDTH_RATIO * 0.5);
  assert.equal(CHANNEL_WIDTH_RATIO, 0.25);
  assert.equal(CHANNEL_BRIGHTNESS, 1);

  const result = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2-3'),
    sys('2', 'Бета', 5400, 5000, KMS, 2, ''),
    sys('3', 'Гамма', 5000, 5600, DAELAAM, 3, '3-1'),
    sys('4', 'Дельта', 5200, 5200, DOMINION, 3, ''),
  ], { factionColor: tableColor });
  assert.ok(result.channels.length >= 2);
  for (const channel of result.channels) {
    assert.equal(
      channel.width,
      CHANNEL_WIDTH_RATIO * Math.min(channel.from.radius, channel.to.radius),
      'ширина — доля меньшего лепестка, как у ленты между баблами',
    );
    assert.ok(channel.width > 0 && Number.isFinite(channel.width));
    assert.equal(channel.quad.length, 4, 'лента — четыре угла');
    for (const point of channel.quad) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'в углах нет NaN');
    }
    // Концы ленты — центры систем: канал идёт сквозь бабл, а не обрывается на нём.
    const middleA = {
      x: (channel.quad[0].x + channel.quad[3].x) / 2,
      y: (channel.quad[0].y + channel.quad[3].y) / 2,
    };
    const middleB = {
      x: (channel.quad[1].x + channel.quad[2].x) / 2,
      y: (channel.quad[1].y + channel.quad[2].y) / 2,
    };
    assert.ok(Math.abs(middleA.x - channel.from.x) < 1e-6, 'конец A уехал от системы');
    assert.ok(Math.abs(middleA.y - channel.from.y) < 1e-6, 'конец A уехал от системы');
    assert.ok(Math.abs(middleB.x - channel.to.x) < 1e-6, 'конец B уехал от системы');
    assert.ok(Math.abs(middleB.y - channel.to.y) < 1e-6, 'конец B уехал от системы');
  }
});

test('детерминизм: порядок строк CSV не меняет каналы', () => {
  const rows = [
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5400, 5000, KMS, 2, '2-3'),
    sys('3', 'Гамма', 5800, 5000, DAELAAM, 3, '3-1'),
    sys('4', 'Дельта', 5600, 5200, KMS, 2, ''),
  ];
  const direct = channelsFor(rows, { factionColor: tableColor });
  const reversed = channelsFor(rows.slice().reverse(), { factionColor: tableColor });
  assert.equal(
    JSON.stringify(direct),
    JSON.stringify(reversed),
    'перестановка строк меняет результат',
  );
  assert.equal(
    JSON.stringify(direct),
    JSON.stringify(channelsFor(rows, { factionColor: tableColor })),
    'два вызова на одном входе дают разные каналы',
  );
  assert.equal(direct.channels.length, 3, 'треугольник плюс четвёртая система сети 2');
  assert.equal(direct.warnings.length, 1);
});

test('ячейка net_confront_id: разбор, пробелы по краям и пустая колонка', () => {
  assert.deepEqual(netConfrontTargets('1-2', 'Альфа', 1), [2]);
  assert.deepEqual(netConfrontTargets('1-2-3', 'Альфа', 1), [2, 3]);
  assert.deepEqual(netConfrontTargets('1-3-2', 'Альфа', 1), [3, 2], 'порядок целей сохраняется');
  assert.deepEqual(netConfrontTargets('  1 - 2  ', 'Альфа', 1), [2], 'пробелы по краям допускаются');
  assert.deepEqual(netConfrontTargets('2-1', 'Бета', 2), [1]);

  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(netConfrontTargets(empty, 'Альфа', 1), null, `пусто: ${JSON.stringify(empty)}`);
  }
  // Отсутствие колонки — система вне слоя, как и пустая ячейка.
  assert.equal(channelsFor([sys('1', 'Альфа', 5000, 5000, DOMINION, 1)]).channels.length, 0);
  assert.equal(channelsFor([]).channels.length, 0);
  assert.deepEqual(channelsFor([]).warnings, []);
});

test('системы одной сети не соединяются, пары систем не дублируются', () => {
  const result = channelsFor([
    sys('1', 'Альфа', 5000, 5000, DOMINION, 1, '1-2'),
    sys('2', 'Бета', 5000, 5400, DOMINION, 1, '1-2'),
    sys('3', 'Гамма', 5400, 5000, KMS, 2, '2-1'),
    sys('4', 'Дельта', 5800, 5000, KMS, 2, ''),
  ], { factionColor: tableColor });

  for (const channel of result.channels) {
    assert.notEqual(channel.from.netId, channel.to.netId, 'канал внутри одной сети');
    assert.notEqual(channel.from.systemId, channel.to.systemId, 'канал в себя');
  }
  assertNoDuplicates(result.channels);
  // Обе системы сети 1 объявили цель, встречное объявление одно: ленты идут
  // к объявившей системе сети 2, а не к ближайшей «Дельте».
  assert.deepEqual(
    result.channels.map((channel) => `${channel.from.systemId}-${channel.to.systemId}`),
    ['1-3', '2-3'],
  );
  assert.ok(result.channels.every((channel) => channel.forced));
});

test('отрисовка: отдельный проход после баблов, source-over и без обрезки', () => {
  const source = readFileSync(new URL('../src/atlas/canvas-renderer.ts', import.meta.url), 'utf8');

  const start = source.indexOf('function drawNetChannel(');
  assert.ok(start > 0, 'в рендерере нет прохода каналов');
  const end = source.indexOf('function renderScene(', start);
  assert.ok(end > start, 'проход каналов не выделен в отдельную функцию');
  const pass = source.slice(start, end);

  assert.ok(
    /globalCompositeOperation\s*=\s*'source-over'/.test(pass),
    'каналы не рисуются source-over',
  );
  assert.ok(/globalAlpha\s*=\s*CHANNEL_BRIGHTNESS/.test(pass), 'яркость канала не из константы');
  assert.ok(!/\.clip\s*\(/.test(pass), 'канал обрезается по баблу — а должен идти поверх');
  assert.ok(!/bubbleFor|bubblePath|bridgesBetween/.test(pass), 'проход каналов трогает баблы');

  const scene = source.slice(source.indexOf('function renderScene('));
  const territoryAt = scene.indexOf("primitive.kind === 'territory'");
  const channelsAt = scene.indexOf('drawNetChannels(scene.level)');
  const markerAt = scene.indexOf("primitive.kind === 'marker'");
  assert.ok(territoryAt > 0 && channelsAt > territoryAt, 'каналы рисуются до заливки территорий');
  assert.ok(markerAt > channelsAt, 'каналы рисуются после маркеров');
  assert.ok(/isNetLayerLevel\(level\)/.test(source), 'каналы не ограничены уровнями слоя сетей');
  assert.ok(/channelsFor\(/.test(source), 'рендерер не использует channelsFor из faction-net.ts');
  assert.deepEqual([...NET_LAYER_LEVELS], [2, 3, 4, 5, 6]);
});

/* ------------------------------- колонки сетей в загрузчике (дельта Z-3.8) */

/** Штатная загрузка CSV загрузчиком: те же подмены, что в `tests/faction-net.test.mjs`. */
async function loadDataset(csvText) {
  const text = csvText ?? readFileSync(new URL('../data/systems.csv', import.meta.url), 'utf8');
  const restore = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
  };
  try {
    globalThis.window = { __MAP_DATA__: null };
    globalThis.document = { currentScript: null };
    globalThis.fetch = async (url) => ({
      ok: true,
      status: 200,
      text: async () => (String(url).includes('systems.csv') ? text : ''),
      json: async () => [],
    });
    const loader = require('../src/atlas/data-loader.ts');
    const api = loader.createDataLoader({ state: {}, runtime: { travelCore: null } });
    return await api.loadDataset();
  } finally {
    globalThis.window = restore.window;
    globalThis.document = restore.document;
    globalThis.fetch = restore.fetch;
  }
}

/** Запись загрузчика → вход слоя каналов: тот же путь, что в `canvas-renderer.ts`. */
function channelInputs(systems) {
  return systems.map((system) => ({
    id: system.id,
    name: system.name,
    x: system.coord ? system.coord[0] : null,
    y: system.coord ? system.coord[1] : null,
    faction: system.primaryFaction ?? null,
    type: system.systemType ?? null,
    net_id: system.net_id,
    net_confront_id: system.net_confront_id,
  }));
}

const SYSTEMS_HEADER = 'name,system_id,type,x,y,faction,net_id,net_confront_id,description,source_url';

test('D — загрузчик отдаёт net_id и net_confront_id, пустая ячейка даёт null', async () => {
  const dataset = await loadDataset();
  const { rows } = SYSTEMS_CSV;
  assert.equal(dataset.systems.length, 173, 'загрузчик потерял системы');

  // Колонки есть у каждой записи: `undefined` («нет колонки») больше не встречается,
  // поэтому слой каналов не различает «таблица без сетей» и «система вне сети».
  assert.ok(
    dataset.systems.every((system) => 'net_id' in system && 'net_confront_id' in system),
    'у части записей нет колонок слоя сетей',
  );
  assert.ok(
    dataset.systems.every((system) => system.net_id !== undefined
      && system.net_confront_id !== undefined),
    'колонка слоя сетей осталась undefined',
  );

  // Типы: `net_id` — целое число от 1 или null, `net_confront_id` — текст или null.
  for (const system of dataset.systems) {
    assert.ok(
      system.net_id === null || (Number.isInteger(system.net_id) && system.net_id >= 1),
      `net_id системы «${system.name}» = ${JSON.stringify(system.net_id)}`,
    );
    assert.ok(
      system.net_confront_id === null || typeof system.net_confront_id === 'string',
      `net_confront_id системы «${system.name}» = ${JSON.stringify(system.net_confront_id)}`,
    );
  }

  // Значения совпадают с CSV построчно: 146 систем вне сетей, 27 в сетях 1…4.
  const byId = new Map(dataset.systems.map((system) => [system.id, system]));
  for (const row of rows) {
    const system = byId.get(row.system_id);
    assert.ok(system !== undefined, `загрузчик потерял систему «${row.name}»`);
    assert.equal(
      system.net_id,
      row.net_id === '' ? null : Number(row.net_id),
      `net_id системы «${row.name}»`,
    );
    assert.equal(
      system.net_confront_id,
      row.net_confront_id === '' ? null : row.net_confront_id,
      `net_confront_id системы «${row.name}»`,
    );
  }
  assert.equal(dataset.systems.filter((system) => system.net_id === null).length, 146);

  // Точечно: размеченные и пустые ячейки.
  const korhal = dataset.systems.find((system) => system.name === 'Корхал');
  const umojan = dataset.systems.find((system) => system.name === 'Умоджа');
  const tarsonis = dataset.systems.find((system) => system.name === 'Тарсонис');
  assert.deepEqual([korhal.net_id, korhal.net_confront_id], [1, null]);
  assert.deepEqual([umojan.net_id, umojan.net_confront_id], [3, '3-1']);
  assert.deepEqual([tarsonis.net_id, tarsonis.net_confront_id], [1, '1-3']);

  // Остальные поля записи не изменились: колонки сетей ничего не затёрли.
  assert.deepEqual(korhal.coord, [5720, 6257]);
  assert.equal(korhal.systemType, 'capital');
  assert.equal(korhal.primaryFaction, DOMINION);

  // Записи загрузчика дают тот же канал, что и сырой CSV: слой не зависит от пути.
  const fromLoader = channelsFor(channelInputs(dataset.systems), { factionColor: tableColor });
  const fromCsv = channelsFor(rows, { factionColor: tableColor });
  assert.equal(fromLoader.channels.length, fromCsv.channels.length);
  assert.deepEqual(
    fromLoader.channels.map((channel) => [channel.pair, channel.from.name, channel.to.name, channel.forced]),
    fromCsv.channels.map((channel) => [channel.pair, channel.from.name, channel.to.name, channel.forced]),
  );
});

test('D — кривой net_id не роняет загрузку, а ячейка каналов сохраняется как есть', async () => {
  const csv = [
    SYSTEMS_HEADER,
    'Целая,1,standard,5000,5000,Доминион Терран,7,7-11,описание,http://example.test/1',
    'Пустая,2,standard,5100,5000,Кел-Морийский Синдикат,,,пусто,',
    'Пробелы,3,standard,5200,5000,Дэлаамы, 9 ,  9-7  ,пробелы по краям,',
    'Ноль,4,standard,5300,5000,Доминион Терран,0,,ноль — не сеть,',
    'Дробь,5,standard,5400,5000,Доминион Терран,2.5,,дробный номер не сеть,',
    'Текст,6,standard,5500,5000,Доминион Терран,abc,,нечисловой номер не сеть,',
  ].join('\n');
  const dataset = await loadDataset(csv);
  const byName = new Map(dataset.systems.map((system) => [system.name, system]));

  assert.equal(byName.get('Целая').net_id, 7, 'целый номер сети читается числом');
  assert.deepEqual(
    [byName.get('Пустая').net_id, byName.get('Пустая').net_confront_id],
    [null, null],
    'пустые ячейки — null',
  );
  assert.deepEqual(
    [byName.get('Пробелы').net_id, byName.get('Пробелы').net_confront_id],
    [9, '9-7'],
    'пробелы по краям ячеек обрезаются',
  );
  for (const name of ['Ноль', 'Дробь', 'Текст']) {
    assert.equal(byName.get(name).net_id, null, `${name}: некорректный net_id должен дать null`);
  }

  // Ячейка каналов не разбирается в загрузчике: текст доходит до слоя как есть,
  // и ошибку формата называет `channelsFor` — с именем системы.
  const declared = byName.get('Целая');
  assert.equal(declared.net_confront_id, '7-11');
  const inputs = channelInputs(dataset.systems);
  assert.throws(
    () => channelsFor(inputs, { factionColor: tableColor }),
    (error) => error instanceof RangeError
      && error.message.includes('Целая')
      && error.message.includes('сеть-цель 11 не существует в данных'),
    'битая цель должна назвать систему и причину',
  );
  // Та же ячейка с сетью 11 в данных — уже законный канал; рядом живёт пара 7↔9
  // из строки «Пробелы» (`9-7`), поэтому лент две.
  const withEleven = inputs.concat([
    { id: '11', name: 'Одиннадцатая', x: 5600, y: 5000, faction: KMS, type: 'standard', net_id: 11, net_confront_id: null },
  ]);
  const built = channelsFor(withEleven, { factionColor: tableColor });
  assert.deepEqual(
    [...built.channels.map((channel) => channel.pair)].sort(),
    ['7-11', '7-9'],
  );
});

/* ------------------------------------------------------- бюджет кадра */

test('бюджет кадра: MAX_CHANNELS_PER_FRAME = 24 режет отрисовку, а не геометрию', () => {
  assert.equal(MAX_CHANNELS_PER_FRAME, 24);

  // Тридцать сетей в цепочке с замыканием: геометрия считает все 30 лент.
  const systems = [];
  for (let netId = 1; netId <= 30; netId += 1) {
    const target = netId === 30 ? 1 : netId + 1;
    systems.push(sys(String(netId), `Сеть ${netId}`, 5000 + netId * 100, 5000, DOMINION, netId, `${netId}-${target}`));
  }
  const result = channelsFor(systems, { factionColor: tableColor });
  assert.equal(result.channels.length, 30, 'channelsFor обязан считать ленты сверх бюджета');
  assert.ok(result.channels.length > MAX_CHANNELS_PER_FRAME, 'бюджет не проверяется на малом наборе');

  // Рендерер рисует не больше бюджета и предупреждает один раз на количество.
  const source = readFileSync(new URL('../src/atlas/canvas-renderer.ts', import.meta.url), 'utf8');
  assert.ok(
    /import\s*\{[^}]*MAX_CHANNELS_PER_FRAME[^}]*\}\s*from\s*'\.\/faction-net\.ts'/.test(source),
    'бюджет кадра не импортирован из faction-net.ts',
  );
  const start = source.indexOf('function drawNetChannels(');
  assert.ok(start > 0, 'в рендерере нет прохода каналов');
  const pass = source.slice(start, source.indexOf('function renderScene(', start));
  assert.ok(/MAX_CHANNELS_PER_FRAME/.test(pass), 'проход каналов не учитывает бюджет кадра');
  assert.ok(/console\.warn/.test(pass), 'переполнение бюджета не видно в консоли');
  assert.ok(
    /netChannelOverflow !== channels\.length/.test(pass),
    'предупреждение о переполнении печатается каждый кадр',
  );
});
