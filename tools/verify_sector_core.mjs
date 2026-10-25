#!/usr/bin/env node
/* Сквозная сверка ядра сектора (волна SW-1, гейт G7.4).
 *
 * Зачем отдельный гейт, если есть модульные тесты воркеров: в Stage-8.7
 * зеркальные константы двух модулей разъехались молча (`RING_HF_RES`:
 * 92 terrain-draw вместо 7), и оба воркера при этом сдали зелёные PR.
 * Здесь проверяется именно СТЫК модулей, а не каждый модуль по отдельности:
 *
 *   1. пороги лестницы — точная геометрия `10 000 / 10^(n/9)` (не округления);
 *   2. `addressLetters` монотонно не убывает и не превышает `5`;
 *   3. `markerDiameter(visibleWidthForLevel(n))` совпадает с `markerPx` таблицы;
 *   4. контрольные векторы `levelForWidth` и гистерезис: шаг ровно один уровень,
 *      без мигания на монотонном зуме в обе стороны;
 *   5. кодек адреса против НЕЗАВИСИМОГО эталона на всех записях `systems.csv`
 *      (второй реализации в Node, а не повторного вызова проверяемого модуля);
 *   6. round-trip `адрес → прямоугольник → центр` и согласованность префиксов
 *      уровней с адресом;
 *   7. форматтер расстояний — эталоны гайдлайнера §6.5.1 и запрещённые формы.
 *
 * Запуск: node tools/verify_sector_core.mjs (код 0 — успех, 1 — расхождение).
 * Флаги: --verbose печатает все проверки, а не только итог.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADDRESS_TIERS,
  MAP_SIZE,
  addressOf,
  centerOf,
  formatAddress,
  parseAddress,
  prefixOf,
  rectOf,
} from '../src/atlas/sector-address.ts';
import {
  HYSTERESIS,
  LEVELS,
  MAX_VISIBLE_WIDTH,
  MIN_VISIBLE_WIDTH,
  levelForWidth,
  levelSpec,
  markerDiameter,
  visibleWidthForLevel,
} from '../src/atlas/level-ladder.ts';
import { NBSP, formatAngleDeg, formatDistanceLy, pluralYears } from '../src/atlas/sector-units.ts';

const verbose = process.argv.includes('--verbose');
const fails = [];
const passed = [];

function check(condition, message) {
  if (condition) {
    passed.push(message);
    return;
  }
  fails.push(message);
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
// Адресные буквы секторных уровней: L0…L9 закреплены таблицей, глубже L9 — всегда 5.
const sectorLetterCounts = [0, 1, 2, 2, 3, 3, 4, 4, 5, 5];

// Лестница разбирается по кадрам, а не по «ровно 13 записей»: глубина может расти
// (SW-3 добавляет L10…L12 по требованию «1 св.г. от цели до границы», §17.15), и гейт
// не должен требовать правки при каждом новом уровне. Проверяются структура и числа ядра.
const sectorLevels = LEVELS.filter((spec) => spec.frame === 'S');
const systemLevels = LEVELS.filter((spec) => spec.frame === 'O');
const deepestSector = sectorLevels.length - 1;

// 1. Лестница: порядок, три системных уровня в конце, точная геометрия порогов.
check(
  sectorLevels.length >= 10,
  `секторных уровней ${sectorLevels.length}, ожидалось не меньше 10 (L0…L9)`,
);
check(
  sectorLevels.map((spec) => spec.id).join(',') === sectorLevels.map((_spec, index) => `L${index}`).join(','),
  `порядок секторных уровней нарушен: ${sectorLevels.map((spec) => spec.id).join(',')}`,
);
check(
  systemLevels.map((spec) => spec.id).join(',') === 'S0,S1,S2',
  `системные уровни: ${systemLevels.map((spec) => spec.id).join(',')} вместо S0,S1,S2`,
);
check(
  LEVELS.length === sectorLevels.length + 3 && LEVELS.slice(-3).every((spec) => spec.frame === 'O'),
  'системные уровни должны стоять в конце лестницы, ровно три записи',
);
for (let level = 0; level <= deepestSector; level += 1) {
  const spec = sectorLevels[level];
  if (spec === undefined) continue;
  check(
    near(spec.visibleWidth, MAX_VISIBLE_WIDTH / 10 ** (level / 9), 1e-9),
    `${spec.id}: порог ${spec.visibleWidth} не равен 10 000 / 10^(${level}/9)`,
  );
}

// 2. Адресные префиксы уровней: монотонность и предел 5.
for (let index = 0; index <= deepestSector; index += 1) {
  const spec = sectorLevels[index];
  if (spec === undefined) continue;
  const expected = sectorLetterCounts[index] ?? 5;
  check(
    spec.addressLetters === expected,
    `${spec.id}: addressLetters ${spec.addressLetters} вместо ${expected}`,
  );
}
for (let index = 1; index < LEVELS.length; index += 1) {
  const previous = LEVELS[index - 1];
  const current = LEVELS[index];
  if (previous === undefined || current === undefined) continue;
  check(current.addressLetters >= previous.addressLetters, `addressLetters убывает на ${current.id}`);
  check(current.addressLetters <= 5, `addressLetters > 5 на ${current.id}`);
}

// 3. Стык «таблица ↔ формула размера маркера» — то, что разъехалось в Stage-8.7.
let worstMarkerDelta = { delta: 0, id: '' };
for (let level = 0; level <= deepestSector; level += 1) {
  const spec = sectorLevels[level];
  if (spec === undefined) continue;
  const delta = Math.abs(markerDiameter(visibleWidthForLevel(level)) - spec.markerPx);
  if (delta > worstMarkerDelta.delta) worstMarkerDelta = { delta, id: spec.id };
  check(delta <= 0.06, `${spec.id}: markerPx ${spec.markerPx} против формулы ${markerDiameter(spec.visibleWidth).toFixed(3)}`);
}

// 4. Контрольные векторы и гистерезис.
check(levelForWidth(19.53125) === 9, `levelForWidth(19,53125) = ${levelForWidth(19.53125)} вместо 9`);
check(levelForWidth(19.53) === 9, `levelForWidth(19,53) = ${levelForWidth(19.53)} вместо 9`);
check(levelForWidth(100) === 9, `levelForWidth(100) = ${levelForWidth(100)} вместо 9`);
check(levelForWidth(10000) === 0, `levelForWidth(10 000) = ${levelForWidth(10000)} вместо 0`);
check(levelForWidth(20000) === 0, `levelForWidth(20 000) = ${levelForWidth(20000)} вместо 0`);
check(MIN_VISIBLE_WIDTH === 16000, `MIN_VISIBLE_WIDTH = ${MIN_VISIBLE_WIDTH} вместо 16 000`);
check(MAX_VISIBLE_WIDTH === 10000, `MAX_VISIBLE_WIDTH = ${MAX_VISIBLE_WIDTH} вместо 10 000`);
check(near(HYSTERESIS, 0.12, 1e-12), `гистерезис ${HYSTERESIS} вместо 0,12`);

// Вход в L9 асимметричен: полная ширина 1000 единиц, без гистерезиса.
const enterFloorWidth = visibleWidthForLevel(9);
check(
  near(enterFloorWidth, 1000, 1e-9),
  `порог достижимости L9 ${enterFloorWidth} вместо 1000`,
);
check(near(visibleWidthForLevel(8) * (1 - HYSTERESIS), 1136.5637052130978, 1e-9),
  'симметричный порог L8 должен быть 1136,563705…');
const deepestFloorWidth = visibleWidthForLevel(deepestSector);
let level = 0;
let switchesIn = 0;
for (let width = MAX_VISIBLE_WIDTH; width > deepestFloorWidth * 0.98; width *= 0.995) {
  const next = levelForWidth(width, level);
  check(Math.abs(next - level) <= 1, `перескок через уровень: ${level} → ${next} при ширине ${width.toFixed(2)}`);
  if (next !== level) {
    switchesIn += 1;
    level = next;
  }
}
check(level === deepestSector, `зум вглубь остановился на уровне ${level} вместо ${deepestSector}`);
check(switchesIn === deepestSector, `смен уровня при зуме вглубь ${switchesIn} вместо ${deepestSector}`);

let backLevel = deepestSector;
let switchesOut = 0;
for (let width = deepestFloorWidth; width < MAX_VISIBLE_WIDTH; width *= 1.005) {
  const next = levelForWidth(width, backLevel);
  check(Math.abs(next - backLevel) <= 1, `перескок при отъезде: ${backLevel} → ${next}`);
  if (next !== backLevel) {
    switchesOut += 1;
    backLevel = next;
  }
}
check(backLevel === 0, `отъезд остановился на уровне ${backLevel} вместо 0`);
check(switchesOut === deepestSector, `смен уровня при отъезде ${switchesOut} вместо ${deepestSector}`);

// 5. Тиры адреса.
check(ADDRESS_TIERS.length === 6, `тиров ${ADDRESS_TIERS.length} вместо 6`);
check(
  ADDRESS_TIERS.map((tier) => tier.cellSize).join(',') === '10000,2000,400,80,16,3.2',
  `размеры тиров: ${ADDRESS_TIERS.map((tier) => tier.cellSize).join(',')}`,
);
check(MAP_SIZE === 10000, `MAP_SIZE = ${MAP_SIZE} вместо 10 000`);

// 6. Кодек против независимой реализации на реальных данных.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function referenceAddress(x, y) {
  const sizes = [2000, 400, 80, 16, 3.2];
  let restX = x;
  let restY = y;
  let letters = '';
  for (const size of sizes) {
    const column = Math.floor(restX / size);
    const row = Math.floor(restY / size);
    letters += ALPHABET[row * 5 + column];
    restX -= column * size;
    restY -= row * size;
  }
  return `KP·${letters}`;
}

const systemsPath = fileURLToPath(new URL('../data/systems.csv', import.meta.url));
const lines = readFileSync(systemsPath, 'utf8').trim().split(/\r?\n/);
const header = (lines[0] ?? '').split(',');
const xIndex = header.indexOf('x');
const yIndex = header.indexOf('y');
check(xIndex >= 0 && yIndex >= 0, 'в systems.csv нет колонок x/y');
const systems = lines.slice(1)
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const fields = line.split(',');
    return { x: Number(fields[xIndex]), y: Number(fields[yIndex]) };
  });
check(systems.length === 173, `систем в снимке ${systems.length} вместо 173`);

let mismatches = 0;
let worstCenterOffset = 0;
const addresses = new Set();
for (const system of systems) {
  const address = addressOf(system.x, system.y);
  const formatted = formatAddress(address);
  if (formatted !== referenceAddress(system.x, system.y)) mismatches += 1;
  addresses.add(formatted);
  const center = centerOf(address);
  worstCenterOffset = Math.max(worstCenterOffset, Math.hypot(center.x - system.x, center.y - system.y));
  const rect = rectOf(address);
  check(
    center.x > rect.x && center.x < rect.x + rect.size && center.y > rect.y && center.y < rect.y + rect.size,
    `центр вне прямоугольника для ${formatted}`,
  );
  check(formatAddress(parseAddress(formatted)) === formatted, `round-trip строки адреса ${formatted}`);
}
check(mismatches === 0, `расхождений с независимым эталоном: ${mismatches}`);
check(addresses.size === 173, `уникальных адресов ${addresses.size} из 173`);
// Точка внутри узла T5 отстоит от его центра не более чем на полудиагональ 3,2·√2/2.
check(worstCenterOffset <= 3.2 * Math.SQRT2 / 2 + 1e-9, `отклонение центра ${worstCenterOffset.toFixed(4)} св.г.`);
check(worstCenterOffset <= 2.27, `адрес грубее допуска 2,27 св.г.: ${worstCenterOffset.toFixed(4)}`);

// Префиксы уровней лестницы обязаны быть началом полного адреса.
for (let level = 0; level < 10; level += 1) {
  const spec = levelSpec(level);
  if (spec === undefined) continue;
  const prefix = formatAddress(prefixOf(5720, 6257, spec.addressLetters));
  check('KP·REQHC'.startsWith(prefix), `${spec.id}: префикс ${prefix} не начало адреса Корхала KP·REQHC`);
}

// 7. Форматтер расстояний: эталоны §6.5.1 и запрещённые формы.
const distanceCases = [
  [8.4, 'short', `8,4${NBSP}св.г.`],
  [88.4, 'short', `88,4${NBSP}св.г.`],
  [90.79, 'full', `90,79${NBSP}св.г.`],
  [108.07, 'full', `108,07${NBSP}св.г.`],
  [1302.9, 'short', `1${NBSP}302,9${NBSP}св.г.`],
  [5776.3, 'short', `5${NBSP}776,3${NBSP}св.г.`],
  [10000, 'short', `≥ 10${NBSP}000${NBSP}св.г.`],
];
for (const [lightYears, mode, expected] of distanceCases) {
  const got = formatDistanceLy(lightYears, mode);
  check(got === expected, `formatDistanceLy(${lightYears}, ${mode}) = "${got}", ожидалось "${expected}"`);
  for (const banned of ['ly', 'св. лет', 'св.год']) {
    check(!got.includes(banned), `в "${got}" запрещённая форма "${banned}"`);
  }
  check(!/\d\.\d/.test(got), `в "${got}" точка как десятичный разделитель`);
}
for (const [count, expected] of [[1, 'год'], [2, 'года'], [5, 'лет'], [21, 'год'], [90.8, 'лет']]) {
  check(pluralYears(count) === expected, `pluralYears(${count}) = ${pluralYears(count)}, ожидалось ${expected}`);
}
check(formatAngleDeg(0) === '0°', `formatAngleDeg(0) = ${formatAngleDeg(0)}`);
check(formatAngleDeg(-0) === '0°', `formatAngleDeg(−0) = ${formatAngleDeg(-0)}`);
check(formatAngleDeg(Math.PI) === '180°', `formatAngleDeg(π) = ${formatAngleDeg(Math.PI)}`);
check(formatAngleDeg(-Math.PI) === '180°', `formatAngleDeg(−π) = ${formatAngleDeg(-Math.PI)}`);
check(!formatAngleDeg(-Math.PI / 3).includes('-'), 'отрицательный угол напечатан ASCII-минусом');
check(formatAngleDeg(-Math.PI / 3).startsWith('−'), `formatAngleDeg(−60°) = ${formatAngleDeg(-Math.PI / 3)}`);

if (verbose) {
  for (const message of passed) console.log(`ok   ${message}`);
}
console.log(
  fails.length === 0
    ? `Сверка ядра сектора пройдена: ${passed.length} проверок; `
      + `маркер ≤ ${worstMarkerDelta.delta.toFixed(4)} px (${worstMarkerDelta.id}); `
      + `адреса 173/173, отклонение центра ≤ ${worstCenterOffset.toFixed(3)} св.г.`
    : `Сверка ядра сектора провалена: ${fails.length} из ${passed.length + fails.length} проверок`,
);
for (const message of fails) console.error(`FAIL ${message}`);
process.exit(fails.length === 0 ? 0 : 1);
