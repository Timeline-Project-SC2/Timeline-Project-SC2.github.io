/* Пограничный мир — уровень систем, а не область действия (часть 3 §6 плана).
 *
 * Проверяется первый тест владельца: центральная система — Корхал
 * (`system_id: 1`), пограничная — Коло (`system_id: 9`), расстояние между ними
 * `≈ 666,3` мировых единиц. Полосы `core 0…200`, `inner 200…450`,
 * `border 450…700`, `outside >700` задаются данными: число, пороги и названия
 * меняются без кода. Запуск: node --test tests/sector-areas-border-world.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  BORDER_SYSTEM_KOLO,
  CENTRAL_SYSTEM_KORHAL,
  DEFAULT_BANDS,
  bandAt,
  bandIdAt,
  bandIds,
  borderWorldFromSystems,
  createBorderWorld,
  distanceToCentral,
  parseSystemsCsv,
  setBands,
  validateBands,
} from '../src/atlas/sector-areas-border-world.ts';

const csv = await readFile(new URL('../data/systems.csv', import.meta.url), 'utf8');
const rows = parseSystemsCsv(csv);
const world = borderWorldFromSystems(rows, [1]);

test('системы читаются из снимка: Корхал и Коло на своих местах', () => {
  const korhal = rows.find((row) => row.systemId === 1);
  const kolo = rows.find((row) => row.systemId === 9);
  assert.equal(korhal.name, 'Корхал');
  assert.equal(kolo.name, 'Коло');
  assert.deepEqual([korhal.x, korhal.y], [CENTRAL_SYSTEM_KORHAL.x, CENTRAL_SYSTEM_KORHAL.y]);
  assert.deepEqual([kolo.x, kolo.y], [BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y]);
  assert.equal(world.centralSystems.length, 1);
  assert.equal(world.centralSystems[0].name, 'Корхал');
});

test('расстояние Корхал → Коло ≈ 666,3 мировых единиц', () => {
  const distance = distanceToCentral(world, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y);
  assert.ok(Math.abs(distance - 666.3) < 0.5, `расстояние ${distance}`);
  assert.equal(distanceToCentral(world, CENTRAL_SYSTEM_KORHAL.x, CENTRAL_SYSTEM_KORHAL.y), 0);
});

test('полосы первого теста: Корхал в ядре, Коло в пограничье', () => {
  assert.deepEqual(bandIds(world), ['core', 'inner', 'border', 'outside']);
  assert.equal(bandIdAt(world, CENTRAL_SYSTEM_KORHAL.x, CENTRAL_SYSTEM_KORHAL.y), 'core');
  assert.equal(bandIdAt(world, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y), 'border');
  assert.equal(bandAt(world, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y).label, 'Пограничье');
  // Точка в 250 единицах от Корхала — внутренний пояс.
  assert.equal(bandIdAt(world, CENTRAL_SYSTEM_KORHAL.x + 250, CENTRAL_SYSTEM_KORHAL.y), 'inner');
  assert.equal(bandIdAt(world, CENTRAL_SYSTEM_KORHAL.x + 900, CENTRAL_SYSTEM_KORHAL.y), 'outside');
});

test('несколько центральных систем: расстояние берётся по ближайшей', () => {
  const two = borderWorldFromSystems(rows, [1, 2]);
  assert.equal(two.centralSystems.length, 2);
  const onlyKorhal = distanceToCentral(world, 5720, 7000);
  const nearest = distanceToCentral(two, 5720, 7000);
  assert.ok(nearest <= onlyKorhal);
});

test('число полос, пороги и названия меняются без правки кода', () => {
  const custom = setBands(world, [
    { id: 'ядро', label: 'Ядро', from: 0, to: 300 },
    { id: 'даль', label: 'Даль', from: 300, to: 800 },
    { id: 'вне', label: 'Вне', from: 800, to: Infinity },
  ]);
  assert.deepEqual(bandIds(custom), ['ядро', 'даль', 'вне']);
  assert.equal(bandIdAt(custom, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y), 'даль');
  // Исходный мир не изменился: setBands возвращает новый объект.
  assert.deepEqual(bandIds(world), ['core', 'inner', 'border', 'outside']);
});

test('полосы проверяются: порядок, разрывы допустимы, пересечения — нет', () => {
  assert.deepEqual(validateBands(DEFAULT_BANDS), []);
  assert.deepEqual(validateBands([{ id: 'a', label: 'A', from: 0, to: 100 }, { id: 'b', label: 'B', from: 200, to: 300 }]), []);
  assert.ok(validateBands([{ id: 'a', label: 'A', from: 0, to: 200 }, { id: 'b', label: 'B', from: 100, to: 300 }]).length > 0);
  assert.ok(validateBands([{ id: 'a', label: 'A', from: 300, to: 100 }]).length > 0);
  assert.ok(validateBands([]).length > 0);
  assert.throws(() => setBands(world, [{ id: 'a', label: 'A', from: 0, to: 100 }, { id: 'b', label: 'B', from: 50, to: 200 }]), RangeError);
});

test('разрыв между полосами даёт null, а не ближайшую полосу', () => {
  const gaped = setBands(world, [
    { id: 'ближняя', label: 'Ближняя', from: 0, to: 100 },
    { id: 'дальняя', label: 'Дальняя', from: 600, to: Infinity },
  ]);
  assert.equal(bandAt(gaped, CENTRAL_SYSTEM_KORHAL.x + 300, CENTRAL_SYSTEM_KORHAL.y), null);
  assert.equal(bandIdAt(gaped, CENTRAL_SYSTEM_KORHAL.x + 50, CENTRAL_SYSTEM_KORHAL.y), 'ближняя');
});

test('пограничный мир требует центральную систему и не является scope', () => {
  assert.throws(() => createBorderWorld({ centralSystems: [] }), RangeError);
  // Полосы — интервалы расстояния, а не геометрия: область действия кисти
  // описывается отдельно (sector-areas-scope.ts).
  assert.equal(typeof world.bands[0].from, 'number');
  assert.equal(world.bands.at(-1).to, Infinity);
});
