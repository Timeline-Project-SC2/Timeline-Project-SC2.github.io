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
  mergedFields,
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

test('T4: слой живёт на L2…L9, как TERRITORY_LEVELS (с Z-4b глубина лестницы 9)', () => {
  // T4: список уровней слоя — ровно L2…L9, и он совпадает со списком территорий
  // (иначе на L6→L7 мягкое поле фракции исчезало бы скачком — шов, запрещённый
  // владельцем).
  assert.deepEqual([...NET_LAYER_LEVELS], [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...NET_LAYER_LEVELS], [...scene.TERRITORY_LEVELS]);
  for (const level of [0, 1, 10, 12]) {
    assert.equal(isNetLayerLevel(level), false, `L${level} не должен включать слой`);
  }
  for (const level of [2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(isNetLayerLevel(level), true, `L${level} обязан включать слой`);
  }
  const nets = parseNetworks(withNet([KORHAL, TARSONIS], 7));
  assert.equal(netsAtLevel(nets, 1).length, 0);
  assert.equal(netsAtLevel(nets, 2).length, 1);
  assert.equal(netsAtLevel(nets, 7).length, 1, 'на L7 слой больше не обрезается');
  assert.equal(netsAtLevel(nets, 9).length, 1, 'на L9 слой больше не обрезается');
});

/* --------------------------------------------------- затухание слоя (Z-3.9) */

/** Таблица заливки из карточки `Z-3.9` (С1): уровень → альфа. */
const FILL_ALPHA_BY_LEVEL = [
  [2, 1], [3, 0.75], [4, 0.5625], [5, 0.421875],
  [6, 0.31640625], [7, 0.25], [8, 0.25], [9, 0.25],
];

test('T1: layerFillAlpha — таблица L2…L9 и ноль вне диапазона', () => {
  assert.equal(ladder.LAYER_FADE_STEP, 0.75);
  assert.equal(ladder.LAYER_FILL_ALPHA_MIN, 0.25);
  assert.equal(ladder.LAYER_LINE_ALPHA_MIN, 0.45);
  assert.equal(ladder.DEEP_LAYER_FIRST_LEVEL, 2);

  for (const [level, expected] of FILL_ALPHA_BY_LEVEL) {
    assert.ok(
      Math.abs(ladder.layerFillAlpha(level) - expected) <= 1e-9,
      `L${level}: заливка ${ladder.layerFillAlpha(level)}, ожидалось ${expected}`,
    );
  }
  for (const level of [0, 1, 10, -1]) {
    assert.equal(ladder.layerFillAlpha(level), 0, `L${level}: заливки быть не должно`);
  }
});

test('T2: layerLineAlpha — пол заливки 0,45 и ноль вне диапазона', () => {
  // Формула С1 буквальна: `max(0,45; заливка)`. Поэтому линия совпадает с
  // заливкой, пока та ярче пола (L2…L4), а с L5 упирается в `0,45` — пол
  // `LAYER_LINE_ALPHA_MIN` держит контур на всей глубине до L9.
  for (const [level, expected] of FILL_ALPHA_BY_LEVEL) {
    const line = ladder.layerLineAlpha(level);
    const want = Math.max(0.45, expected);
    assert.ok(Math.abs(line - want) <= 1e-9, `L${level}: линия ${line}, ожидалось ${want}`);
    assert.ok(line >= 0.45, `L${level}: линия ниже пола`);
  }
  for (const [level, expected] of FILL_ALPHA_BY_LEVEL) {
    if (level <= 4) {
      assert.ok(
        Math.abs(ladder.layerLineAlpha(level) - expected) <= 1e-9,
        `L${level}: на ярких уровнях линия равна заливке`,
      );
    }
  }
  for (const level of [0, 1, 10, -1]) {
    assert.equal(ladder.layerLineAlpha(level), 0, `L${level}: линии быть не должно`);
  }
});

test('T3: заливка слоя не растёт с глубиной', () => {
  for (let level = 2; level < 9; level += 1) {
    assert.ok(
      ladder.layerFillAlpha(level + 1) <= ladder.layerFillAlpha(level),
      `L${level}→L${level + 1}: альфа заливки выросла`,
    );
    assert.ok(ladder.layerLineAlpha(level) > 0, `L${level}: линия погасла в ноль`);
  }
});

test('T5: bubblePath масштабирует по полной ширине кадра на 1920×1080 и 1366×768', () => {
  // Проекция проверяется на контуре из трёх точек: `bubblePath` читает только
  // `bubble.rings`, поэтому синтетический бабл честно проверяет именно масштаб.
  const visibleWidth = 1000;
  const camera = { centerX: 5000, centerY: 5000, visibleWidth };
  const bubble = {
    netId: 1,
    petals: [],
    nodes: [],
    centerX: camera.centerX,
    centerY: camera.centerY,
    rings: [[
      { x: camera.centerX + 100, y: camera.centerY },
      { x: camera.centerX + 100, y: camera.centerY + 100 },
      { x: camera.centerX, y: camera.centerY + 100 },
    ]],
    bounds: { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 },
    stops: [],
  };

  for (const viewport of [DESKTOP, { w: 1366, h: 768 }]) {
    const points = pathPoints(bubblePath(bubble, camera, viewport));
    const scaleX = (100 * viewport.w) / visibleWidth;
    assert.ok(
      Math.abs(points[0].x - (viewport.w / 2 + scaleX)) <= 1e-6,
      `${viewport.w}×${viewport.h}: x = ${points[0].x}, ожидалось ${viewport.w / 2 + scaleX}`,
    );
    // На неквадратном кадре масштаб короткой оси даёт другое число: проверяем,
    // что он больше не используется.
    const shortSideX = (100 * Math.min(viewport.w, viewport.h)) / visibleWidth;
    assert.ok(
      Math.abs(points[0].x - (viewport.w / 2 + shortSideX)) > 1e-6,
      'масштаб снова считается по короткой оси кадра',
    );
  }

  // 1366×768 отдельно: масштаб по высоте (768/1366 = 0,562) запрещён — это дефект S8.
  const phoneLaptop = { w: 1366, h: 768 };
  const projected = pathPoints(bubblePath(bubble, camera, phoneLaptop))[0].x;
  const byHeight = phoneLaptop.w / 2 + (100 * 768) / visibleWidth;
  assert.ok(
    Math.abs(projected - byHeight) > 1e-6,
    `бабл встал в масштаб короткой оси: ${projected} ≈ ${byHeight}`,
  );
});

test('T6: регресс на квадратном 1000×1000 — числа не изменились', () => {
  const visibleWidth = 1000;
  const camera = { centerX: 5000, centerY: 5000, visibleWidth };
  const bubble = {
    netId: 1,
    petals: [],
    nodes: [],
    centerX: camera.centerX,
    centerY: camera.centerY,
    rings: [[
      { x: camera.centerX + 100, y: camera.centerY },
      { x: camera.centerX + 100, y: camera.centerY + 100 },
      { x: camera.centerX, y: camera.centerY + 100 },
    ]],
    bounds: { minX: 5000, minY: 5000, maxX: 5100, maxY: 5100 },
    stops: [],
  };
  const square = { w: 1000, h: 1000 };
  const points = pathPoints(bubblePath(bubble, camera, square));

  // На квадратном кадре полная и короткая ось совпадают: старый и новый
  // масштаб дают одно и то же число, регресса нет.
  assert.ok(Math.abs(points[0].x - (1000 / 2 + 100)) <= 1e-6, `x = ${points[0].x}`);
  assert.ok(Math.abs(points[0].x - (500 + (100 * 1000) / visibleWidth)) <= 1e-6);
  assert.ok(Math.abs(points[0].x - (500 + (100 * Math.min(1000, 1000)) / visibleWidth)) <= 1e-6);
  assert.equal(points[1].y, 600);

  // Реальный бабл на квадратном кадре тоже считается по полной ширине.
  const real = bubbleFor(withNet([KORHAL, TARSONIS], 7), { netId: 7 });
  const realCamera = { centerX: KORHAL.x, centerY: KORHAL.y, visibleWidth: L2_WIDTH };
  const realPath = bubblePath(real, realCamera, square);
  assert.equal(realPath, bubblePath(real, realCamera, square), 'путь зависит от вызова');
  assert.ok(pathPoints(realPath).length >= 3);
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


/* ------------------------------------------------ слияние полей сетей (Д-1) */

/** Одна система сети: радиус лепестка — `SOLO_PETAL_RADIUS` (`150`). */
function soloNet(id, netId, x, y) {
  return { id, name: `Система ${id}`, x, y, faction: 'Доминион Терран', type: 'standard', net_id: netId };
}

function ringArea(ring) {
  let sum = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    sum += ring[previous].x * ring[index].y - ring[index].x * ring[previous].y;
  }
  return Math.abs(sum) / 2;
}

function ringsArea(rings) {
  return rings.reduce((total, ring) => total + ringArea(ring), 0);
}

function ringGap(ringsA, ringsB) {
  let best = Number.POSITIVE_INFINITY;
  for (const a of ringsA) {
    for (const b of ringsB) {
      for (const p of a) {
        for (const q of b) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      }
    }
  }
  return best;
}

function filled(nets, x, y) {
  let total = 0;
  for (const netItem of nets) {
    for (const member of netItem.members) {
      const distanceSquared = (x - member.x) ** 2 + (y - member.y) ** 2;
      if (distanceSquared < 1e-9) return true;
      total += (SOLO_PETAL_RADIUS * SOLO_PETAL_RADIUS / distanceSquared) ** 3;
    }
  }
  return total >= 1;
}

test('T7: поле контроля шире узла (CONTROL_FIELD_SIDE_RATIO > 2)', () => {
  assert.ok(net.CONTROL_FIELD_SIDE_RATIO > 2, 'квадрат поля контроля не шире узла');
  assert.equal(net.CONTROL_FIELD_SIDE_RATIO, 2.7, 'доля стороны разошлась с эскизом владельца');
});

test('M1: две близкие сети слипаются — середина залита, кольца смыкаются', () => {
  // Порог слияния для показателя 6: (2r/d)^6 · 2 ≥ 1 → d ≤ 2·2^(−1/6)·r ≈ 1,78r,
  // то есть расстояние между сетями из одной системы не больше ≈ 1,12·(r1 + r2).
  // Берём 1,1·(r1 + r2) = 2,2r: сумма полей на середине 1,13 > 1 — середина залита.
  const radius = SOLO_PETAL_RADIUS;
  const gap = 1.1 * (radius + radius);
  const nets = parseNetworks([soloNet('1', 1, 5000, 5000), soloNet('2', 2, 5000 + gap, 5000)]);
  const fields = mergedFields(nets);
  assert.deepEqual(fields.map((field) => field.netId), [1, 2]);
  for (const field of fields) assert.ok(field.rings.length >= 1, `сеть ${field.netId}: контура нет`);

  const middleX = 5000 + gap / 2;
  assert.ok(filled(nets, middleX, 5000), 'середина между сетями не залита при 1,1·(r1 + r2)');
  const owners = fields.filter((field) => field.rings.some((ring) => insideRing(ring, middleX, 5000)));
  assert.ok(owners.length >= 1, 'середина не принадлежит ни одной сети');

  assert.ok(ringGap(fields[0].rings, fields[1].rings) <= 1, 'кольца слипшихся сетей не сомкнулись');
});

test('M2: далёкие сети оставляют чёрный просвет (4 · (r1 + r2))', () => {
  const radius = SOLO_PETAL_RADIUS;
  const gap = 4 * (radius + radius);
  const nets = parseNetworks([soloNet('1', 1, 5000, 5000), soloNet('2', 2, 5000 + gap, 5000)]);
  const fields = mergedFields(nets);

  const middleX = 5000 + gap / 2;
  assert.equal(filled(nets, middleX, 5000), false, 'середина залита — сети не должны слипаться');
  const owners = fields.filter((field) => field.rings.some((ring) => insideRing(ring, middleX, 5000)));
  assert.equal(owners.length, 0, 'середина принадлежит сети при просвете');
  assert.ok(ringGap(fields[0].rings, fields[1].rings) > 100, 'сети далеко, а кольца рядом');
});

test('M3: одна сеть — кольца совпадают с bubbleFor побайтово', () => {
  const members = withNet([KORHAL, MISTAFF, TARSONIS], 7);
  const nets = parseNetworks(members);
  const merged = mergedFields(nets);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].netId, 7);
  assert.equal(
    JSON.stringify(merged[0].rings),
    JSON.stringify(bubbleFor(nets[0].members).rings),
    'вырожденный случай разошёлся с bubbleFor',
  );
});

test('M4: равенство полей — меньший netId, результат не зависит от порядка сетей', () => {
  const radius = SOLO_PETAL_RADIUS;
  const gap = 1.1 * (radius + radius);
  const input = [soloNet('1', 2, 5000 + gap, 5000), soloNet('2', 1, 5000, 5000)];
  const forward = mergedFields(parseNetworks(input));
  const backward = mergedFields(parseNetworks(input.slice().reverse()));
  assert.deepEqual(forward, backward, 'слияние зависит от порядка сетей');
  assert.deepEqual(forward.map((field) => field.netId), [1, 2]);

  // Серединный перпендикуляр равноудалён от сетей: по правилу равенства точки
  // на нём отдаются сети с меньшим `netId`. Сам перпендикуляр — шов масок, то
  // есть ровно граница обоих колец: проверяем, что шов лежит посередине
  // (кольца смыкаются именно там) и что по обе стороны от него маски не
  // накладываются и не оставляют дырки.
  const middle = { x: 5000 + gap / 2, y: 5000 };
  const small = forward.find((field) => field.netId === 1);
  const big = forward.find((field) => field.netId === 2);
  assert.ok(filled(parseNetworks(input), middle.x, middle.y), 'точка на перпендикуляре не залита');
  assert.ok(ringGap(small.rings, big.rings) <= 1, 'шов масок не посередине');

  const ownSide = (field, x) => field.rings.some((ring) => insideRing(ring, x, 5000));
  assert.ok(ownSide(small, middle.x - 30), 'своя сторона шва не у сети 1');
  assert.ok(!ownSide(big, middle.x - 30), 'маски сетей накладываются слева от шва');
  assert.ok(ownSide(big, middle.x + 30), 'своя сторона шва не у сети 2');
  assert.ok(!ownSide(small, middle.x + 30), 'маски сетей накладываются справа от шва');
});

test('M5: три сети — сумма площадей колец равна площади залитой маски, кольца не накладываются', () => {
  const nets = parseNetworks([
    soloNet('1', 1, 5000, 5000),
    soloNet('2', 2, 5300, 5000),
    soloNet('3', 3, 5150, 5290),
  ]);
  const fields = mergedFields(nets);
  assert.equal(fields.length, 3);
  for (const field of fields) assert.equal(field.rings.length, 1, `сеть ${field.netId}: колец не одно`);

  // Площадь маски — плотная выборка общего поля `W ≥ 1` по габаритам колец.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    for (const ring of field.rings) {
      for (const point of ring) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
  }
  const steps = 600;
  const dx = (maxX - minX) / steps;
  const dy = (maxY - minY) / steps;
  let hits = 0;
  for (let row = 0; row < steps; row += 1) {
    for (let column = 0; column < steps; column += 1) {
      if (filled(nets, minX + (column + 0.5) * dx, minY + (row + 0.5) * dy)) hits += 1;
    }
  }
  const maskArea = hits * dx * dy;
  const ringsTotal = fields.reduce((total, field) => total + ringsArea(field.rings), 0);
  const error = Math.abs(ringsTotal - maskArea) / maskArea;
  assert.ok(error <= 0.01, `площадь колец расходится с маской на ${(error * 100).toFixed(2)} %`);

  // Кольца не накладываются: центр одной сети не внутри чужого кольца.
  for (const owner of fields) {
    for (const other of fields) {
      if (owner.netId === other.netId) continue;
      const netItem = nets.find((candidate) => candidate.netId === other.netId);
      assert.ok(
        !owner.rings.some((ring) => insideRing(ring, netItem.centerX, netItem.centerY)),
        `кольцо сети ${owner.netId} накрыло центр сети ${other.netId}`,
      );
    }
  }
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


test('всполохи из данных: далёкая пара из net_confront_id даёт стрелку, без пары — пусто', () => {
  // Сети далеко друг от друга: `bridgesBetween` вернёт `null`, но пара объявлена
  // в данных, поэтому `fromData` стрелку всё равно строит (Z-3.9, С14/Д2.3).
  const nets = parseNetworks([
    { id: '1', name: 'Своя', x: 1000, y: 1000, faction: 'Доминион Терран', type: 'standard', net_id: 1, net_confront_id: '1-2' },
    { id: '2', name: 'Чужая', x: 9000, y: 9000, faction: 'Кел-Морийский Синдикат', type: 'standard', net_id: 2, net_confront_id: '2-1' },
    { id: '3', name: 'Одинокая', x: 5000, y: 2000, faction: 'Дэлаамы', type: 'standard', net_id: 3 },
  ]);
  const own = nets.find((item) => item.netId === 1);
  const rival = nets.find((item) => item.netId === 2);
  const lonely = nets.find((item) => item.netId === 3);

  assert.equal(bridgesBetween(own, rival), null, 'сети слишком далеко для ленты');
  assert.equal(flaresFor(own, [rival]).length, 0, 'без fromData близость обязательна');

  const arrows = flaresFor(own, [rival], { fromData: true });
  assert.ok(arrows.length > 0, 'пара из данных не дала стрелку');
  assert.ok(arrows.length <= MAX_FLARES_PER_NET);
  for (const flare of arrows) {
    assert.equal(flare.targetNetId, 2);
    assert.ok(flare.intensity > 0 && flare.intensity <= 1);
    assert.ok(flare.length > 0);
  }
  // Соперники без пары — стрелки не рисуются вовсе (Д2.3).
  assert.equal(flaresFor(own, [], { fromData: true }).length, 0);
  assert.equal(flaresFor(lonely, [], { fromData: true }).length, 0);
  // Детерминизм: два вызова подряд дают идентичный JSON.
  assert.equal(JSON.stringify(flaresFor(own, [rival], { fromData: true })), JSON.stringify(arrows));
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
