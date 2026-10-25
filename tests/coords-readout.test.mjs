/* Readout координат: расстояние до границы кадра, ссылка `?at=`, админ-режим,
 * карточка точки (§7.7–§7.8 плана глубокого рендера).
 *
 * Тесты чистые: DOM не нужен, потому что проверяются вынесенные функции, а не
 * отрисовка. Живой браузерный прогон в песочнице невозможен (нет WebGL2).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readout = require('../src/atlas/coords-readout.ts');
const dossier = require('../src/atlas/dossier-card.ts');
const ladder = require('../src/atlas/level-ladder.ts');
const address = require('../src/atlas/sector-address.ts');
const units = require('../src/atlas/sector-units.ts');

const VIEWPORT = { w: 1920, h: 1080 };
const MAP_SIZE = 10000;
const FIT_INSET = 0.94;
const NBSP = units.NBSP;

const fit = ladder.fitScaleFor(VIEWPORT, MAP_SIZE, FIT_INSET);

test('readout: «1,00 св.г. до границы» на пределе приближения по требованию', () => {
  const maxScale = ladder.maxScaleForTargetEdge(VIEWPORT, MAP_SIZE, FIT_INSET);
  const text = readout.zoomReadoutText(VIEWPORT, maxScale, fit);
  assert.equal(text.edge, units.formatDistanceLy(ladder.TARGET_EDGE_LY, 'full') + ' до границы');
  assert.equal(text.edge, '1,00' + NBSP + 'св.г. до границы');
});

test('readout: процент зума на упоре = 532 % для 1920×1080 (§17.23)', () => {
  const maxScale = ladder.maxScaleForTargetEdge(VIEWPORT, MAP_SIZE, FIT_INSET);
  const text = readout.zoomReadoutText(VIEWPORT, maxScale, fit);
  assert.equal(text.percent, '532%');
  assert.ok(Math.abs(maxScale - 0.54) < 1e-9, `maxScale ${maxScale} ≠ 0.54`);
  assert.ok(Math.abs(fit - 0.10152) < 1e-9, `fitScale ${fit} ≠ 0.10152`);
});

test('readout: на «вся карта» процент 100 и расстояние считается по короткой оси', () => {
  const text = readout.zoomReadoutText(VIEWPORT, fit, fit);
  assert.equal(text.percent, '100%');
  // fitScale = short / mapSize * fitInset = 1080 / 10000 * 0.94 = 0.10152
  // edgeDistance = short / 2 / fitScale / 1000 = 1080 / 2 / 0.10152 / 1000 = 5.32 св.г.
  const expected = Math.min(VIEWPORT.w, VIEWPORT.h) / 2 / fit / 1000;
  assert.equal(text.edge, units.formatDistanceLy(expected, 'full') + ' до границы');
  // Формат: "5,32" + NBSP + "св.г." — проверяем, что начинается с "5,32" и есть NBSP перед "св.г."
  assert.ok(text.edge.startsWith('5,32' + NBSP + 'св.г.'), text.edge);
});

test('readout: расстояние до границы считается по короткой оси и не зависит от поворота экрана', () => {
  const tall = { w: 390, h: 844 };
  const wide = { w: 844, h: 390 };
  const fitTall = ladder.fitScaleFor(tall, MAP_SIZE, FIT_INSET);
  const fitWide = ladder.fitScaleFor(wide, MAP_SIZE, FIT_INSET);
  const a = readout.zoomReadoutText(tall, fitTall, fitTall);
  const b = readout.zoomReadoutText(wide, fitWide, fitWide);
  assert.equal(a.edge, b.edge);
  assert.notEqual(readout.visibleWidthOf(tall, fitTall), readout.visibleWidthOf(wide, fitWide));
});

test('readout: нулевой и отрицательный масштаб не дают строк', () => {
  assert.equal(readout.zoomReadoutText(VIEWPORT, 0, fit), null);
  assert.equal(readout.zoomReadoutText(VIEWPORT, -1, fit), null);
  assert.equal(readout.zoomReadoutText(VIEWPORT, fit, 0), null);
  assert.equal(readout.zoomReadoutText({ w: 0, h: 0 }, fit, fit), null);
});

test('ссылка ?at=: адрес возвращается в точку через sector-address', () => {
  const target = readout.parseMapLink('?at=KP·REQHC&lw=39');
  assert.ok(target);
  assert.equal(target.address, 'KP·REQHC');
  assert.equal(target.lw, 39);
  assert.equal(address.formatAddress(address.addressOf(target.x, target.y)), 'KP·REQHC');
});

test('ссылка ?at=: понимает расширенную запись и запись без сектора', () => {
  const compact = readout.parseMapLink('?at=KP%C2%B7REQHC');
  const expanded = readout.parseMapLink('?at=KP-R-E-Q-H-C');
  const bare = readout.parseMapLink('?at=reqhc');
  assert.ok(compact && expanded && bare);
  assert.equal(expanded.address, 'KP·REQHC');
  assert.equal(bare.address, 'KP·REQHC');
  assert.deepEqual({ x: bare.x, y: bare.y }, { x: compact.x, y: compact.y });
  assert.equal(bare.lw, null);
});

test('ссылка ?at=: мусор, пустое значение и адрес уровня ниже T5 отбрасываются', () => {
  assert.equal(readout.parseMapLink(''), null);
  assert.equal(readout.parseMapLink('?lw=39'), null);
  assert.equal(readout.parseMapLink('?at='), null);
  assert.equal(readout.parseMapLink('?at=KP·REQ'), null);
  assert.equal(readout.parseMapLink('?at=KP·ZZZZZ'), null);
});

test('ссылка ?at=: некорректная ширина кадра не превращается в NaN', () => {
  const broken = readout.parseMapLink('?at=REQHC&lw=abc');
  const negative = readout.parseMapLink('?at=REQHC&lw=-5');
  assert.equal(broken.lw, null);
  assert.equal(negative.lw, null);
  const decimal = readout.parseMapLink('?at=REQHC&lw=39,5');
  assert.equal(decimal.lw, 39.5);
});

test('ссылка ?at=: lw=39 на 1920×1080 — это ширина кадра 39, высота 21,94', () => {
  const target = readout.parseMapLink('?at=KP·REQHC&lw=39');
  const scale = readout.scaleForVisibleWidth(VIEWPORT, target.lw);
  assert.equal(scale, VIEWPORT.w / 39);
  assert.equal(scale, 1920 / 39);
  assert.ok(Math.abs(readout.visibleWidthOf(VIEWPORT, scale) - 39) < 1e-9);
  assert.ok(Math.abs(VIEWPORT.h / scale - 21.94) < 0.01, String(VIEWPORT.h / scale));
  assert.equal(readout.scaleForVisibleWidth(VIEWPORT, 0), null);
  assert.equal(readout.scaleForVisibleWidth(VIEWPORT, -1), null);
});

test('ссылка ?at=: на телефоне 390×844 lw=39 остаётся шириной 39', () => {
  const phone = { w: 390, h: 844 };
  const scale = readout.scaleForVisibleWidth(phone, 39);
  assert.equal(scale, 390 / 39);
  assert.ok(Math.abs(readout.visibleWidthOf(phone, scale) - 39) < 1e-9);
  assert.ok(Math.abs(phone.h / scale - 84.4) < 0.05, String(phone.h / scale));
});

test('ссылка ?at=: на упоре клампа ширина 3,56 св.г. (§17.23)', () => {
  const requested = readout.scaleForVisibleWidth(VIEWPORT, 3.56);
  const maxScale = ladder.maxScaleForTargetEdge(VIEWPORT, MAP_SIZE, FIT_INSET);
  const applied = Math.min(requested, maxScale);
  assert.equal(applied, 0.54);
  const width = readout.visibleWidthOf(VIEWPORT, applied);
  assert.ok(Math.abs(width / 1000 - 3.5555555) < 1e-6, String(width / 1000));
});

test('админ-режим ?coords=1 распознаётся только точным значением', () => {
  assert.equal(readout.isCoordinatesMode('?coords=1'), true);
  assert.equal(readout.isCoordinatesMode('?coords=1&at=REQHC'), true);
  assert.equal(readout.isCoordinatesMode('?coords=0'), false);
  assert.equal(readout.isCoordinatesMode('?coords=true'), false);
  assert.equal(readout.isCoordinatesMode(''), false);
});

test('карточка точки: координаты с одним знаком и пробелом-разделителем', () => {
  assert.equal(dossier.formatPointTenths(5720), '5' + '\u2009' + '720,0');
  assert.equal(dossier.formatPointTenths(6256.96), '6' + '\u2009' + '257,0');
  assert.equal(dossier.formatPointTenths(3.25), '3,3');
});

test('карточка точки: уровень и номинальная видимая ширина в св.г.', () => {
  assert.equal(dossier.levelCaption(78.125), 'L7 · ' + units.formatDistanceLy(ladder.visibleWidthLyForLevel(7), 'short'));
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(0)), 'L0 · ' + units.formatDistanceLy(ladder.visibleWidthLyForLevel(0), 'short'));
});

test('карточка точки: ближайшая система считается только по системам с координатами', () => {
  const systems = [
    { id: 'far', name: 'Далёкая', coordSource: 'map', coord: [100, 100] },
    { id: 'near', name: 'Мистафф', coordSource: 'map', coord: [5800, 6300] },
    { id: 'unknown', name: 'Без координат', coordSource: 'catalog', coord: [5720, 6257] },
    { id: 'broken', name: 'Битые', coordSource: 'map', coord: ['—', '—'] }
  ];
  const explicit = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const nearest = dossier.nearestSystemTo(systems, explicit, 5720, 6257);
  assert.equal(nearest.name, 'Мистафф');
  assert.ok(Math.abs(nearest.distance - Math.hypot(80, 43)) < 1e-9);
  assert.equal(dossier.nearestSystemTo([systems[2]], explicit, 5720, 6257), null);
});

test('карточка точки: расстояние до ядра сектора в св.г. (§3.3, §17.23)', () => {
  const distance = Math.hypot(5720 - 6014, 6257 - 5856);
  assert.equal(Math.round(distance), 497);
  const coreLy = units.unitsToLy(distance);
  // distance ≈ 497.23 ед → coreLy ≈ 0.49723 св.г.
  assert.ok(Math.abs(coreLy - 0.49723) < 1e-5, `ядро сектора ${coreLy} св.г.`);
});

test('кадр системы: frame понимает только S и O', () => {
  assert.equal(dossier.parseFrame('S'), 'S');
  assert.equal(dossier.parseFrame('o'), 'O');
  assert.equal(dossier.parseFrame(' O '), 'O');
  assert.equal(dossier.parseFrame('X'), null);
  assert.equal(dossier.parseFrame(''), null);
  assert.equal(dossier.parseFrame(null), null);
});
