import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const net = require('../src/atlas/faction-net.ts');
const ladder = require('../src/atlas/level-ladder.ts');
const scene = require('../src/atlas/sector-scene.ts');

const {
  BRIDGE_GAP_FACTOR,
  MAX_FLARES_PER_NET,
  MAX_FLARES_PER_RIVAL,
  NODE_RADIUS_BY_TYPE,
  SOLO_PETAL_RADIUS,
  NET_LAYER_LEVELS,
  bridgesBetween,
  bubbleFor,
  bubblePath,
  colorStops,
  flaresFor,
  isNetLayerLevel,
  netsAtLevel,
  parseNetworks,
  parseNetId,
  sampleGradient,
} = net;

const DESKTOP = { w: 1920, h: 1080 };
const PHONE = { w: 390, h: 844 };
const L2_WIDTH = ladder.visibleWidthForLevel(2);

/** Реальные координаты `data/systems.csv` — для отчёта о бабле на Корхале. */
const KORHAL = { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', type: 'capital' };
const MISTAFF = { id: '11', name: 'Мистафф', x: 5749, y: 6171, faction: 'Доминион Терран', type: 'standard' };
const TARSONIS = { id: '13', name: 'Тарсонис', x: 5749, y: 5984, faction: 'Доминион Терран', type: 'capital' };

function withNet(systems, netId) {
  return systems.map((system) => ({ ...system, net_id: netId }));
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

function readSystemsCsv() {
  const text = readFileSync(new URL('../data/systems.csv', import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = csvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = csvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
  return { headers, rows };
}

/** Табличные цвета фракций (`data/factions.csv`, Z-3.7): источник резолвера. */
const FACTION_COLORS = (() => {
  const text = readFileSync(new URL('../data/factions.csv', import.meta.url), 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const headers = csvLine(lines[0]);
  const colors = new Map();
  for (const line of lines.slice(1)) {
    const cells = csvLine(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    colors.set(row.faction, row.color);
  }
  return colors;
})();

/** Резолвер в духе загрузчика: неизвестное и пустое имя — цвет строки «—». */
function tableColor(faction) {
  return FACTION_COLORS.get(faction) ?? FACTION_COLORS.get('\u2014');
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Числа пути в порядке следования: пары «x y». */
function pathPoints(path) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g) ?? [];
  assert.equal(numbers.length % 2, 0, 'в пути непарное число координат');
  const points = [];
  for (let index = 0; index < numbers.length; index += 2) {
    points.push({ x: Number(numbers[index]), y: Number(numbers[index + 1]) });
  }
  return points;
}

function bboxOf(points) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function insideRing(ring, x, y) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index];
    const b = ring[previous];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ширина контура на вертикали `x`: длина пересечения с кольцами, единицы карты. */
function widthAtX(bubble, x) {
  const crossings = [];
  for (const ring of bubble.rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
      const a = ring[index];
      const b = ring[previous];
      if ((a.x > x) !== (b.x > x)) {
        crossings.push(a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y));
      }
    }
  }
  crossings.sort((first, second) => first - second);
  let widest = 0;
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    widest = Math.max(widest, crossings[index + 1] - crossings[index]);
  }
  return widest;
}

/* --------------------------------------------------------------- группировка */

test('группировка: три системы с net_id 7 — одна сеть из трёх', () => {
  const systems = [
    ...withNet([KORHAL], 7),
    ...withNet([MISTAFF], 7),
    ...withNet([TARSONIS], 7),
  ];
  const nets = parseNetworks(systems);
  assert.equal(nets.length, 1);
  assert.equal(nets[0].netId, 7);
  assert.equal(nets[0].members.length, 3);
  assert.deepEqual(nets[0].members.map((member) => member.id), ['1', '11', '13']);
  assert.deepEqual(nets[0].factions, ['Доминион Терран']);
  assert.equal(nets[0].centerX, (KORHAL.x + MISTAFF.x + TARSONIS.x) / 3);
  assert.equal(nets[0].centerY, (KORHAL.y + MISTAFF.y + TARSONIS.y) / 3);
});

test('net_id 0, пустая строка и отсутствие колонки не попадают ни в одну сеть', () => {
  const systems = [
    ...withNet([KORHAL], 7),
    ...withNet([MISTAFF], 0),
    ...withNet([TARSONIS], ''),
    { id: '5', name: 'Чар', x: 5086, y: 5896, faction: 'Рой зергов Загары', type: 'capital' },
    { id: '6', name: 'Слейн', x: 9233, y: 4539, faction: 'Тал-даримы', type: 'capital', net_id: '   ' },
    { id: '7', name: 'Шакурас', x: 8396, y: 3061, faction: 'Неразимы', type: 'capital', net_id: 'нет' },
  ];
  const nets = parseNetworks(systems);
  assert.equal(nets.length, 1, 'вне сети попали системы без net_id');
  assert.deepEqual(nets[0].members.map((member) => member.id), ['1']);
  assert.equal(parseNetId(0), null);
  assert.equal(parseNetId(''), null);
  assert.equal(parseNetId(undefined), null);
  assert.equal(parseNetId(-3), null);
  assert.equal(parseNetId(2.5), null);
  assert.equal(parseNetId('12'), 12);
});

test('правило 6: система с net_id = 0 физически не входит в бабл', () => {
  const stranger = { ...MISTAFF, net_id: 0 };
  const systems = [...withNet([KORHAL, TARSONIS], 7), stranger];
  const nets = parseNetworks(systems);
  const bubble = bubbleFor(nets[0].members, { netId: nets[0].netId });
  assert.deepEqual(bubble.petals.map((petal) => petal.systemId), ['1', '13']);
  assert.ok(!bubble.petals.some((petal) => petal.systemId === stranger.id));
});

test('сети независимы от порядка строк: вход переставляется, результат тот же', () => {
  const systems = withNet([KORHAL, MISTAFF, TARSONIS], 7);
  const forward = parseNetworks(systems)[0];
  const backward = parseNetworks(systems.slice().reverse())[0];
  assert.deepEqual(
    forward.members.map((member) => member.id),
    backward.members.map((member) => member.id),
  );
  assert.equal(
    bubblePath(bubbleFor(forward.members), { centerX: forward.centerX, centerY: forward.centerY, visibleWidth: L2_WIDTH }, DESKTOP),
    bubblePath(bubbleFor(backward.members), { centerX: backward.centerX, centerY: backward.centerY, visibleWidth: L2_WIDTH }, DESKTOP),
  );
});

/* --------------------------------------------------------------- уровни слоя */

test('правило 7: слой живёт только на L2…L6, как TERRITORY_LEVELS', () => {
  assert.deepEqual([...NET_LAYER_LEVELS], [...scene.TERRITORY_LEVELS]);
  for (const level of [0, 1, 7, 8, 9, 12]) {
    assert.equal(isNetLayerLevel(level), false, `L${level} не должен включать слой`);
  }
  for (const level of [2, 3, 4, 5, 6]) {
    assert.equal(isNetLayerLevel(level), true, `L${level} обязан включать слой`);
  }
  const nets = parseNetworks(withNet([KORHAL, TARSONIS], 7));
  assert.equal(netsAtLevel(nets, 1).length, 0);
  assert.equal(netsAtLevel(nets, 2).length, 1);
  assert.equal(netsAtLevel(nets, 7).length, 0);
});

/* ------------------------------------------------------------------ бабл */

test('bubbleFor детерминирован: два вызова дают идентичный путь побайтово', () => {
  const members = withNet([KORHAL, MISTAFF, TARSONIS], 7);
  const camera = { centerX: KORHAL.x, centerY: KORHAL.y, visibleWidth: L2_WIDTH };
  const first = bubbleFor(members, { netId: 7 });
  const second = bubbleFor(members, { netId: 7 });
  assert.deepEqual(first, second);

  const firstPath = bubblePath(first, camera, DESKTOP);
  const secondPath = bubblePath(second, camera, DESKTOP);
  assert.equal(firstPath, secondPath);
  assert.ok(firstPath.length > 0);
  assert.equal(firstPath, bubblePath(first, camera, DESKTOP), 'путь зависит от вызова, а не от данных');
});

test('бабл из трёх систем Корхала: лепестки, узлы и мягкое слияние', () => {
  const members = withNet([KORHAL, MISTAFF, TARSONIS], 7);
  const bubble = bubbleFor(members, { netId: 7 });

  assert.equal(bubble.petals.length, 3);
  assert.equal(bubble.nodes.length, 3);
  assert.ok(bubble.rings.length >= 1, 'у бабла нет замкнутого контура');

  // Каждая система лежит внутри контура: лепестки не оторвались от бабла.
  const biggest = bubble.rings[0];
  for (const petal of bubble.petals) {
    assert.ok(
      bubble.rings.some((ring) => insideRing(ring, petal.x, petal.y)),
      `система ${petal.systemId} осталась вне контура`,
    );
    assert.ok(petal.radius > 0);
  }

  // Контур заключён в «лепестковый» прямоугольник, а не в выпуклую оболочку.
  assert.ok(bubble.bounds.minX < Math.min(...bubble.petals.map((petal) => petal.x)));
  assert.ok(bubble.bounds.maxY > Math.max(...bubble.petals.map((petal) => petal.y)));
  assert.ok(biggest.length > 16, 'слишком грубый контур');

  // Столица крупнее обычной системы: узлы и лепестки.
  const capital = bubble.nodes.find((node) => node.systemId === '1');
  const standard = bubble.nodes.find((node) => node.systemId === '11');
  assert.ok(capital.radius > standard.radius, 'узел столицы не крупнее');
  assert.equal(NODE_RADIUS_BY_TYPE.capital > NODE_RADIUS_BY_TYPE.standard, true);
  for (const node of bubble.nodes) {
    const petal = bubble.petals.find((candidate) => candidate.systemId === node.systemId);
    assert.ok(Math.hypot(node.x - petal.x, node.y - petal.y) < 1e-9, 'узел смещён от системы');
    assert.ok(node.radius < petal.radius, 'узел не вписан в свой лепесток');
  }
});

test('бабл — мягкое слияние с перемычкой, а не выпуклая оболочка', () => {
  // Два лепестка на одной горизонтали: посередине контур обязан «сузиться».
  const pair = [
    { id: '1', name: 'A', x: 5000, y: 5000, faction: 'Доминион Терран', type: 'standard', net_id: 4 },
    { id: '2', name: 'B', x: 5300, y: 5000, faction: 'Кел-Морийский Синдикат', type: 'standard', net_id: 4 },
  ];
  const bubble = bubbleFor(pair);
  const waist = widthAtX(bubble, 5150);
  const atPetal = widthAtX(bubble, 5000);
  assert.ok(waist > 0, 'перемычка между лепестками отсутствует');
  assert.ok(
    waist < atPetal * 0.98,
    `контур не сужается в перемычке: ${waist.toFixed(1)} против ${atPetal.toFixed(1)}`,
  );
  // И перемычка действительно «мягкая»: стенки не сходятся в точку.
  assert.ok(waist > atPetal * 0.5, 'лепестки слиплись в точку вместо перемычки');

  // Одиночная система сети — ровный круг фиксированного радиуса.
  const solo = bubbleFor([{ id: '9', name: 'Один', x: 0, y: 0, type: 'standard', net_id: 4 }]);
  assert.ok(Math.abs(solo.petals[0].radius - SOLO_PETAL_RADIUS) < 1e-9);
  assert.ok(solo.rings.length >= 1);
});

test('далёкие системы одной сети не тянут оболочку через полкарты', () => {
  // Выпуклая оболочка нарисовала бы эллипс на весь сектор; мягкое слияние даёт
  // два отдельных кольца — по кольцу на лепесток.
  const spread = [
    { id: '1', name: 'A', x: 2000, y: 2000, faction: 'Доминион Терран', type: 'standard', net_id: 1 },
    { id: '2', name: 'B', x: 8000, y: 8000, faction: 'Рой зергов Загары', type: 'standard', net_id: 1 },
  ];
  const bubble = bubbleFor(spread);
  assert.equal(bubble.rings.length, 2, 'далёкие лепестки слиплись в одну оболочку');
  for (const ring of bubble.rings) {
    const center = ring.reduce(
      (acc, point) => ({ x: acc.x + point.x / ring.length, y: acc.y + point.y / ring.length }),
      { x: 0, y: 0 },
    );
    // Каждое кольцо остаётся у своей системы, а не растягивается на весь сектор.
    const near = Math.min(...spread.map((system) => Math.hypot(system.x - center.x, system.y - center.y)));
    assert.ok(near < 600, `кольцо ушло от своих систем на ${near.toFixed(0)} единиц`);
  }
  const path = bubblePath(bubble, { centerX: 5000, centerY: 5000, visibleWidth: 10000 }, { w: 1000, h: 1000 });
  assert.equal((path.match(/Z/g) ?? []).length, 2, 'в пути не два замкнутых контура');
});

/* ------------------------------------------------------------------- путь */

test('bubblePath: на L2 контур целиком внутри кадра', () => {
  const members = withNet([KORHAL, MISTAFF, TARSONIS], 7);
  const bubble = bubbleFor(members, { netId: 7 });
  const camera = { centerX: KORHAL.x, centerY: KORHAL.y, visibleWidth: L2_WIDTH };
  assert.equal(ladder.levelForWidth(camera.visibleWidth), 2, 'камера не на L2');

  const path = bubblePath(bubble, camera, DESKTOP);
  assert.ok(path.length > 0);
  assert.ok(!path.includes('e') && !path.includes('E'), 'в пути экспоненциальная запись');
  assert.ok(!/NaN|Infinity|undefined/.test(path), 'в пути нечисловые координаты');
  assert.match(path, /^M/, 'путь не начинается с MoveTo');
  assert.match(path, /Z/, 'контур не замкнут');

  const points = pathPoints(path);
  assert.ok(points.length >= 3);
  const box = bboxOf(points);
  assert.ok(box.minX >= 0 && box.maxX <= DESKTOP.w, `выход за кадр по X: ${box.minX}…${box.maxX}`);
  assert.ok(box.minY >= 0 && box.maxY <= DESKTOP.h, `выход за кадр по Y: ${box.minY}…${box.maxY}`);
  assert.ok(box.width > 20 && box.height > 20, 'бабл на L2 вырожден');
});

test('bubblePath на 390×844 не вырождается в точку', () => {
  const members = withNet([KORHAL, TARSONIS], 7);
  const bubble = bubbleFor(members, { netId: 7 });
  const camera = { centerX: (KORHAL.x + TARSONIS.x) / 2, centerY: (KORHAL.y + TARSONIS.y) / 2, visibleWidth: L2_WIDTH };
  const box = bboxOf(pathPoints(bubblePath(bubble, camera, PHONE)));
  assert.ok(box.width >= 10, `ширина бабла на телефоне ${box.width} px`);
  assert.ok(box.height >= 10, `высота бабла на телефоне ${box.height} px`);
  assert.ok(box.minX >= 0 && box.maxX <= PHONE.w);
  assert.ok(box.minY >= 0 && box.maxY <= PHONE.h);
});

/* ---------------------------------------------------------------- градиент */

function channelsBetween(stops, steps = 20) {
  const samples = [];
  for (let step = 0; step <= steps; step += 1) {
    samples.push(sampleGradient(stops, step / steps));
  }
  return samples;
}

function assertMonotone(samples, label) {
  for (let channel = 0; channel < 3; channel += 1) {
    const values = samples.map((sample) => sample[channel]);
    const ascending = values.every((value, index) => index === 0 || value >= values[index - 1]);
    const descending = values.every((value, index) => index === 0 || value <= values[index - 1]);
    assert.ok(ascending || descending, `${label}: канал ${channel} немонотонен (${values.join(',')})`);
  }
}

test('colorStops: у сети из двух фракций ровно 2 стопа на границах диапазонов', () => {
  const members = [
    { id: '2', name: 'Мория', x: 5568, y: 5994, faction: 'Кел-Морийский Синдикат', net_id: 9 },
    { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', net_id: 9 },
  ];
  const stops = colorStops(members, tableColor);
  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((stop) => stop.offset), [0, 1]);
  // Стоп 0 — участник пары с меньшим id (Корхал, 1), стоп 1 — Мория (2).
  assert.deepEqual(stops.map((stop) => stop.faction), ['Доминион Терран', 'Кел-Морийский Синдикат']);
  assert.deepEqual(stops.map((stop) => stop.systemId), ['1', '2']);
  // Цвета — табличные: Доминион `#fe0000`, Синдикат — его строка factions.csv.
  assert.deepEqual(stops[0].rgb, hexToRgb(FACTION_COLORS.get('Доминион Терран')));
  assert.deepEqual(stops[0].rgb, [254, 0, 0]);
  assert.deepEqual(stops[1].rgb, hexToRgb(FACTION_COLORS.get('Кел-Морийский Синдикат')));
  // Порядок строк во входе не меняет градиент.
  assert.deepEqual(colorStops(members.slice().reverse(), tableColor), stops);
  assert.notDeepEqual(stops[0].rgb, stops[1].rgb);
  assert.match(stops[0].color, /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/);

  const samples = channelsBetween(stops);
  assert.deepEqual(samples[0], stops[0].rgb, 'начало градиента не равно первому стопу');
  assert.deepEqual(samples[samples.length - 1], stops[1].rgb, 'конец градиента не равен второму стопу');
  assertMonotone(samples, 'две фракции');
});

test('colorStops: при 4 цветах стопов ровно 2 — только ближайшие системы', () => {
  // Ближайшая пара — «Альфа» (0,0) и «Бета» (100,0); остальные цвета далеко.
  const members = [
    { id: '1', name: 'Альфа', x: 5000, y: 5000, faction: 'Доминион Терран', net_id: 3 },
    { id: '2', name: 'Бета', x: 5100, y: 5000, faction: 'Рой зергов Загары', net_id: 3 },
    { id: '3', name: 'Гамма', x: 6000, y: 5000, faction: 'Дэлаамы', net_id: 3 },
    { id: '4', name: 'Дельта', x: 5000, y: 6000, faction: 'Тал-даримы', net_id: 3 },
  ];
  const stops = colorStops(members, tableColor);
  assert.equal(stops.length, 2, 'при 4 цветах стопов должно быть ровно 2');
  assert.deepEqual(stops.map((stop) => stop.faction), ['Доминион Терран', 'Рой зергов Загары']);
  assert.deepEqual(stops.map((stop) => stop.systemId), ['1', '2']);
  assert.deepEqual(stops.map((stop) => stop.offset), [0, 1]);
  assert.ok(
    !stops.some((stop) => stop.faction === 'Дэлаамы' || stop.faction === 'Тал-даримы'),
    'в градиент попали не ближайшие системы',
  );
  assertMonotone(channelsBetween(stops), 'четыре цвета');
});

test('colorStops: одна фракция даёт два стопа одного цвета', () => {
  const stops = colorStops(withNet([KORHAL, MISTAFF], 7), tableColor);
  assert.equal(stops.length, 2);
  assert.deepEqual(stops[0].rgb, stops[1].rgb);
});

test('бабл несёт градиент своих участников', () => {
  const members = [
    { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', net_id: 9 },
    { id: '2', name: 'Мория', x: 5568, y: 5994, faction: 'Кел-Морийский Синдикат', net_id: 9 },
  ];
  const bubble = bubbleFor(members, { netId: 9, factionColor: tableColor });
  assert.equal(bubble.stops.length, 2);
  assert.deepEqual(bubble.stops.map((stop) => stop.faction), ['Доминион Терран', 'Кел-Морийский Синдикат']);
});

/* ------------------------------------------------------------------ лента */

test('bridgesBetween: критерий соседства зафиксирован, дальние сети — null', () => {
  const makeNet = (netId, x, y) => parseNetworks([
    { id: String(netId), name: `Сеть ${netId}`, x, y, faction: 'Доминион Терран', net_id: netId },
  ])[0];

  // У одиночных сетей радиус лепестка SOLO_PETAL_RADIUS: порог соседства
  // BRIDGE_GAP_FACTOR · (rA + rB) = 1,6 · 300 = 480 единиц карты.
  const threshold = BRIDGE_GAP_FACTOR * SOLO_PETAL_RADIUS * 2;
  assert.equal(threshold, 480);

  const near = bridgesBetween(makeNet(1, 5000, 5000), makeNet(2, 5000 + threshold - 20, 5000), {
    factionColor: tableColor,
  });
  assert.ok(near !== null, 'соседние сети не соединились лентой');
  assert.equal(near.from.netId, 1);
  assert.equal(near.to.netId, 2);
  assert.ok(near.gap <= threshold);
  assert.ok(near.length > 0);
  assert.equal(near.quad.length, 4);
  assert.deepEqual(near.stops.map((stop) => stop.offset), [0, 1]);

  const far = bridgesBetween(makeNet(1, 5000, 5000), makeNet(2, 5000 + threshold + 40, 5000));
  assert.equal(far, null, 'лента протянулась к несоседней сети');

  // Порог проверяется именно по просвету между лепестками, а не по центрам.
  const wide = bridgesBetween(makeNet(1, 5000, 5000), makeNet(2, 5000 + threshold + 40, 5000), {
    soloPetalRadius: 200,
  });
  assert.ok(wide !== null, 'критерий не учитывает радиусы лепестков');

  // Сеть сама с собой лентой не соединяется.
  const solo = makeNet(3, 3000, 3000);
  assert.equal(bridgesBetween(solo, solo), null);
});

test('bridgesBetween: градиент ленты — цвет своей сети → цвет чужой', () => {
  const nets = parseNetworks([
    { id: '1', name: 'Корхал', x: 5720, y: 6257, faction: 'Доминион Терран', net_id: 7 },
    { id: '2', name: 'Мория', x: 5568, y: 5994, faction: 'Кел-Морийский Синдикат', net_id: 9 },
  ]);
  const bridge = bridgesBetween(nets[0], nets[1], { factionColor: tableColor });
  assert.ok(bridge !== null);
  assert.deepEqual(bridge.stops[0].rgb, hexToRgb(FACTION_COLORS.get('Доминион Терран')));
  assert.deepEqual(bridge.stops[1].rgb, hexToRgb(FACTION_COLORS.get('Кел-Морийский Синдикат')));

  // Лента соединяет именно ближайшие системы: концы лежат на их лепестках.
  const fromPetal = bubbleFor(nets[0].members).petals.find((petal) => petal.systemId === bridge.from.systemId);
  const toPetal = bubbleFor(nets[1].members).petals.find((petal) => petal.systemId === bridge.to.systemId);
  assert.ok(fromPetal !== undefined && toPetal !== undefined);
  const fromDistance = Math.hypot(bridge.from.x - fromPetal.x, bridge.from.y - fromPetal.y);
  const toDistance = Math.hypot(bridge.to.x - toPetal.x, bridge.to.y - toPetal.y);
  assert.ok(fromDistance <= fromPetal.radius + 1e-9);
  assert.ok(toDistance <= toPetal.radius + 1e-9);
  assert.ok(Math.abs(bridge.width - Math.max(0, bridge.width)) < 1e-9);
});

/* -------------------------------------------------------------- всполохи */

test('flaresFor: направления детерминированы и число ≤ лимита из констант', () => {
  const nets = parseNetworks([
    { id: '1', name: 'Ядро', x: 5000, y: 5000, faction: 'Доминион Терран', net_id: 1 },
    { id: '2', name: 'Сосед', x: 5380, y: 5000, faction: 'Рой зергов Загары', net_id: 2 },
    { id: '3', name: 'Дальний', x: 9000, y: 9000, faction: 'Дэлаамы', net_id: 3 },
  ]);
  const [core, neighbour, faraway] = nets;

  const flares = flaresFor(core, [neighbour, faraway]);
  assert.ok(flares.length > 0, 'всполохов нет у конфронтующей сети');
  assert.ok(flares.length <= MAX_FLARES_PER_NET, `всполохов ${flares.length} больше лимита`);
  assert.ok(
    flares.every((flare) => flare.targetNetId === 2),
    'всполох ушёл к сети вне критерия соседства',
  );
  assert.deepEqual(flaresFor(core, [neighbour, faraway]), flares);
  assert.deepEqual(flaresFor(core, [faraway, neighbour]), flares, 'порядок соперников влияет на результат');

  // Направление — в сторону конфронтующей сети, а не случайное.
  const towardRival = Math.atan2(neighbour.centerY - core.centerY, neighbour.centerX - core.centerX);
  for (const flare of flares) {
    const delta = Math.abs(Math.atan2(Math.sin(flare.angle - towardRival), Math.cos(flare.angle - towardRival)));
    assert.ok(delta <= 0.26 + 1e-9, `всполох отклонился на ${delta.toFixed(3)} рад`);
    assert.ok(flare.length > 0 && flare.intensity > 0 && flare.intensity <= 1);
  }
  assert.ok(flares.length <= MAX_FLARES_PER_RIVAL * 1, 'на одного соперника больше лимита');
  assert.equal(flaresFor(core, []).length, 0);
  assert.equal(flaresFor(core, [neighbour], { limit: 0 }).length, 0);
  assert.ok(flaresFor(core, [neighbour], { limit: 1 }).length <= 1);
  assert.throws(() => flaresFor(core, [neighbour], { limit: MAX_FLARES_PER_NET + 1 }), RangeError);
});

test('flaresFor не использует Math.random и Date.now', () => {
  const source = readFileSync(new URL('../src/atlas/faction-net.ts', import.meta.url), 'utf8');
  // Упоминание в комментарии — не вызов: проверяются именно обращения.
  assert.ok(!/Math\s*\.\s*random\s*\(/.test(source), 'в модуле есть вызов Math.random');
  assert.ok(!/Date\s*\.\s*now\s*\(/.test(source), 'в модуле есть вызов Date.now');
  assert.ok(!/new\s+Date\s*\(/.test(source), 'в модуле есть new Date');
});

/* ----------------------------------------------------------------- CSV */

test('systems.csv читается: колонки сетей на месте и не ломают существующие поля', () => {
  const { headers, rows } = readSystemsCsv();
  // `net_confront_id` (каналы, Z-3.8) стоит сразу после `net_id`; позицию в
  // таблице задаёт лист владельца, код читает колонки по заголовку.
  assert.ok(headers.includes('net_confront_id'), 'в systems.csv нет net_confront_id');
  assert.equal(
    headers.indexOf('net_confront_id'),
    headers.indexOf('net_id') + 1,
    'net_confront_id должна стоять сразу после net_id',
  );
  assert.equal(rows.length, 173, 'изменилось число систем');

  // Разметка владельца (25.10.2026): сети 1…4, 27 систем с сетью, 146 без.
  const filled = rows.filter((row) => parseNetId(row.net_id) !== null);
  assert.equal(filled.length, 27, 'изменилось число систем с сетью');
  assert.equal(rows.filter((row) => row.net_id === '').length, 146, 'изменилось число систем без сети');
  // Каналы размечены взаимно: Тарсонис `1-3` и Умоджа `3-1`, других нет.
  const channels = rows.filter((row) => row.net_confront_id !== '');
  assert.deepEqual(
    channels.map((row) => `${row.name}:${row.net_id}:${row.net_confront_id}`),
    ['Умоджа:3:3-1', 'Тарсонис:1:1-3'],
    'разметка каналов разошлась с таблицей владельца',
  );

  // Существующие поля на месте: имя, координаты и тип читаются как раньше.
  const korhal = rows.find((row) => row.name === 'Корхал');
  assert.ok(korhal !== undefined);
  assert.equal(Number(korhal.x), 5720);
  assert.equal(Number(korhal.y), 6257);
  assert.equal(korhal.type, 'capital');
  assert.equal(korhal.system_id, '1');
  assert.equal(korhal.net_id, '1');
  assert.equal(korhal.net_confront_id, '');

  // Сети по текущему снимку: четыре (1…4), разметка владельца, не выдумана.
  assert.deepEqual(
    parseNetworks(rows).map((net) => net.netId),
    [1, 2, 3, 4],
    'состав сетей разошёлся с таблицей владельца',
  );

  // Строки CSV со строковыми координатами и net_id тоже группируются:
  // разметку владелец добавит прямо в таблицу, без промежуточного JSON.
  const unassigned = rows.map((row) => ({ ...row, net_id: '' }));
  const labeled = unassigned.map((row) =>
    ['1', '11', '13'].includes(row.system_id) ? { ...row, net_id: '7' } : row,
  );
  const nets = parseNetworks(labeled);
  const seven = nets.find((net) => net.netId === 7);
  assert.ok(seven !== undefined, 'строковый net_id не сгруппировался в сеть');
  assert.deepEqual(seven.members.map((member) => member.id), ['1', '11', '13']);
  assert.deepEqual(seven.members.map((member) => member.name), ['Корхал', 'Мистафф', 'Тарсонис']);
  assert.deepEqual(seven.members.map((member) => member.systemType), ['capital', 'standard', 'capital']);
});

test('колонки сетей читаются загрузчиком data-loader.ts и не ломают его', async () => {
  const csv = readFileSync(new URL('../data/systems.csv', import.meta.url), 'utf8');
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
      text: async () => (String(url).includes('systems.csv') ? csv : ''),
      json: async () => [],
    });
    const loader = require('../src/atlas/data-loader.ts');
    const api = loader.createDataLoader({ state: {}, runtime: { travelCore: null } });
    const dataset = await api.loadDataset();

    assert.equal(dataset.systems.length, 173, 'загрузчик потерял системы на новой колонке');
    const korhal = dataset.systems.find((system) => system.name === 'Корхал');
    assert.ok(korhal !== undefined);
    assert.deepEqual(korhal.coord, [5720, 6257]);
    assert.equal(korhal.systemType, 'capital');
    assert.equal(korhal.primaryFaction, 'Доминион Терран');
    // Колонки слоя сетей загрузчик отдаёт в записи: `net_id` — числом,
    // `net_confront_id` — текстом ячейки, пустая ячейка — `null`.
    assert.equal(korhal.net_id, 1);
    assert.equal(korhal.net_confront_id, null);
    const umojan = dataset.systems.find((system) => system.name === 'Умоджа');
    assert.ok(umojan !== undefined);
    assert.equal(umojan.net_id, 3);
    assert.equal(umojan.net_confront_id, '3-1');
    // Систем без сети большинство: у них обе колонки `null`, а не '' и не 0.
    const outside = dataset.systems.filter((system) => system.net_id === null);
    assert.equal(outside.length, 173 - 27, 'загрузчик потерял пустые net_id');
    assert.ok(outside.every((system) => system.net_confront_id === null));
  } finally {
    globalThis.window = restore.window;
    globalThis.document = restore.document;
    globalThis.fetch = restore.fetch;
  }
});
