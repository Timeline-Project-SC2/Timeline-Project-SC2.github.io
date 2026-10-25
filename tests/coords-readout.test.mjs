/* Readout координат: расстояние до границы кадра, ссылка `?at=`, админ-режим,
 * карточка точки (§7.7–§7.8 плана глубокого рендера, §17.23).
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

test('C10: readout: «0,28 св.г. до границы» и процент 1891 % на пределе зума по полной ширине', () => {
  const maxScale = ladder.maxScaleForTargetWidth(VIEWPORT, MAP_SIZE, FIT_INSET);
  assert.equal(maxScale, 1.92);
  assert.ok(Math.abs(fit - 0.10152) < 1e-12);
  const text = readout.zoomReadoutText(VIEWPORT, maxScale, fit);
  assert.equal(text.percent, '1891%');
  assert.equal(text.edge, units.formatDistanceLy(ladder.edgeDistance(VIEWPORT, maxScale), 'full') + ' до границы');
  assert.equal(text.edge, '0,28' + NBSP + 'св.г. до границы');
});

test('readout: на «вся карта» процент 100 и расстояние считается по короткой оси в св.г.', () => {
  const text = readout.zoomReadoutText(VIEWPORT, fit, fit);
  assert.equal(text.percent, '100%');
  const expected = ladder.edgeDistance(VIEWPORT, fit);
  assert.equal(text.edge, units.formatDistanceLy(expected, 'full') + ' до границы');
  assert.equal(text.edge, '5,32' + NBSP + 'св.г. до границы');
});

test('readout: расстояние до границы считается по короткой оси и не зависит от поворота экрана', () => {
  const tall = { w: 390, h: 844 };
  const wide = { w: 844, h: 390 };
  const fitTall = ladder.fitScaleFor(tall, MAP_SIZE, FIT_INSET);
  const fitWide = ladder.fitScaleFor(wide, MAP_SIZE, FIT_INSET);
  const a = readout.zoomReadoutText(tall, fitTall, fitTall);
  const b = readout.zoomReadoutText(wide, fitWide, fitWide);
  assert.equal(a.edge, b.edge);
  // Ширина кадра при этом разная: она идёт по горизонтали, а не по короткой оси.
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
  // Обратный проход: точка кадра снова даёт тот же адрес — второй парсер не нужен.
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
  // Высота кадра при той же величине в 1,78 раза меньше ширины.
  assert.ok(Math.abs(VIEWPORT.h / scale - 21.94) < 0.01, String(VIEWPORT.h / scale));
  assert.equal(readout.scaleForVisibleWidth(VIEWPORT, 0), null);
  assert.equal(readout.scaleForVisibleWidth(VIEWPORT, -1), null);
});

test('ссылка ?at=: на телефоне 390×844 lw=39 остаётся шириной 39', () => {
  const phone = { w: 390, h: 844 };
  const scale = readout.scaleForVisibleWidth(phone, 39);
  assert.equal(scale, 390 / 39);
  assert.ok(Math.abs(readout.visibleWidthOf(phone, scale) - 39) < 1e-9);
  // Высота кадра тут уже почти в 2,2 раза больше ширины — и это не ошибка.
  assert.ok(Math.abs(phone.h / scale - 84.4) < 0.05, String(phone.h / scale));
});

test('ссылка ?at=: на упоре клампа кадр 1000 × 562,5 ед = 1,00 × 0,56 св.г. (полная ширина)', () => {
  // Кламп живёт в рендерере: `centerOn()` ограничивает масштаб до `maxScale()`,
  // равного `viewport.w / 1000` — на упоре полная ширина кадра ровно
  // `1` св.г. (`lyToUnits(1)` единиц), высота — из пропорций экрана.
  const requested = readout.scaleForVisibleWidth(VIEWPORT, 0.5);
  assert.equal(requested, 1920 / 0.5);
  const maxScale = ladder.maxScaleForTargetWidth(VIEWPORT, MAP_SIZE, FIT_INSET);
  const applied = Math.min(requested, maxScale);
  assert.equal(applied, 1.92);
  const widthUnits = readout.visibleWidthOf(VIEWPORT, applied);
  const heightUnits = VIEWPORT.h / applied;
  assert.equal(Math.round(widthUnits), 1000);
  assert.ok(Math.abs(heightUnits - 562.5) < 1e-9);
  assert.ok(Math.abs(units.unitsToLy(widthUnits) - 1) < 1e-12, String(units.unitsToLy(widthUnits)));
  assert.ok(Math.abs(units.unitsToLy(heightUnits) - 0.5625) < 1e-12);
  // Полная ширина на упоре — номинальная ширина L9.
  assert.equal(ladder.levelForWidth(widthUnits), 9);
  assert.ok(Math.abs(widthUnits - ladder.visibleWidthForLevel(9)) < 1e-9);
});

test('G9: полный адрес точки осмотра — formatAddress(addressOf(x, y)), строка «осмотр L8 · адрес · 16 ед»', () => {
  const x = 5720;
  const y = 6257;
  const full = address.formatAddress(address.addressOf(x, y));
  // Полный адрес: сектор и пять букв, а не префикс тира лупы.
  assert.equal(full.slice('KP·'.length).length, 5);

  const text = readout.inspectReadoutText(true, 8, { x, y }, 16);
  assert.equal(text, `осмотр L8 · ${full} · 16 ед`);
  assert.ok(text.includes(full));

  // Размер ячейки T5 — дробный, с запятой, как во всём интерфейсе.
  assert.equal(readout.inspectReadoutText(true, 8, { x, y }, 3.2), `осмотр L8 · ${full} · 3,2 ед`);
  // На уровне без базовой сетки размера нет, адрес остаётся.
  assert.equal(readout.inspectReadoutText(true, 9, { x, y }, null), `осмотр L9 · ${full}`);
  // Вне карты адреса нет, строка честно говорит об этом.
  assert.equal(readout.inspectReadoutText(true, 8, { x: -5, y: 10 }, 16), 'осмотр L8 · вне карты');
});

test('H6: полный адрес в панели координат — formatAddress(addressOf(x, y)) и содержит «KP·»', () => {
  const x = 5720;
  const y = 6257;
  const full = address.formatAddress(address.addressOf(x, y));
  assert.ok(full.startsWith('KP·'), `полный адрес «${full}» без префикса сектора`);

  const text = readout.inspectReadoutText(true, 8, { x, y }, 16);
  assert.ok(text.includes(full));
  assert.ok(text.includes('KP·'));
});

test('G10: при выключенном режиме строка осмотра отсутствует', () => {
  assert.equal(readout.inspectReadoutText(false, 8, { x: 5720, y: 6257 }, 16), null);
  assert.equal(readout.inspectReadoutText(false, 9, { x: 5720, y: 6257 }, null), null);
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
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(7)), 'L7 · ' + units.formatDistanceLy(ladder.visibleWidthLyForLevel(7), 'short'));
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(7)), 'L7 · 1,7' + NBSP + 'св.г.');
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(2)), 'L2 · 6,0' + NBSP + 'св.г.');
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(0)), 'L0 · ' + units.formatDistanceLy(10, 'short'));
  assert.equal(dossier.levelCaption(ladder.visibleWidthForLevel(0)), 'L0 · 10,0' + NBSP + 'св.г.');
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
  assert.equal(units.formatDistanceLy(units.unitsToLy(nearest.distance), 'full'), '0,09' + NBSP + 'св.г.');
  assert.equal(dossier.nearestSystemTo([systems[2]], explicit, 5720, 6257), null);
});

test('карточка точки: «от ядра сектора» переводится через unitsToLy и formatDistanceLy (3,67 св.г.)', () => {
  // Проверочный вектор §17.23: от (6014, 5856) до (8395.9, 3060.8) = 3672,41 ед -> «3,67 св.г.».
  assert.equal(Math.round(Math.hypot(8395.9 - 6014, 3060.8 - 5856)), 3672);
  assert.equal(dossier.sectorCoreDistanceText(8395.9, 3060.8), '3,67' + NBSP + 'св.г.');

  // Корхал `(5720; 6257)` — `497` ед = `0,50 св.г.` от центра ядра `(6014; 5856)`.
  assert.equal(Math.round(Math.hypot(5720 - 6014, 6257 - 5856)), 497);
  assert.equal(dossier.sectorCoreDistanceText(5720, 6257), '0,50' + NBSP + 'св.г.');

  // Проверка разметки самой карточки точки (`openPointCard`) без реального браузера.
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { innerWidth: 1920, innerHeight: 1080 };
  try {
    let createdRoot = null;
    const kernel = {
      doc: {
        createElement() {
          createdRoot = {
            className: '',
            innerHTML: '',
            offsetWidth: 250,
            offsetHeight: 120,
            style: { cssText: '', display: '', left: '', top: '' },
            setAttribute() {},
            addEventListener() {},
            focus() {},
          };
          return createdRoot;
        },
        body: { appendChild() {} },
        addEventListener() {},
      },
      el: { mapCanvas: null },
      coords: { copyTextToClipboard() {} },
      data: { explicitMapNumber: (value) => (Number.isFinite(Number(value)) ? Number(value) : null) },
      state: {
        systems: [{ id: 'near', name: 'Сосед', coordSource: 'map', coord: [8395.9 + 80, 3060.8 + 43] }],
        view: { scale: 0.54, tx: 0, ty: 0 },
        viewport: { w: 1920, h: 1080 },
      },
    };
    dossier.openPointCard(kernel, { world: { x: 8395.9, y: 3060.8 }, screen: { x: 200, y: 200 } });
    assert.ok(createdRoot.innerHTML.includes(`от ядра сектора: 3,67${NBSP}св.г.`), createdRoot.innerHTML);
    assert.ok(createdRoot.innerHTML.includes(`Сосед · 0,09${NBSP}св.г.`), createdRoot.innerHTML);
    // Полная ширина при масштабе фикстуры: 1920 / 0,54 = 3555,56 ед. — по
    // новой лестнице это L4 с номиналом 3,59 св.г. («3,6 св.г.»).
    assert.ok(createdRoot.innerHTML.includes(`L4 · 3,6${NBSP}св.г.`), createdRoot.innerHTML);
  } finally {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete globalThis.window;
  }
});

test('кадр системы: frame понимает только S и O', () => {
  assert.equal(dossier.parseFrame('S'), 'S');
  assert.equal(dossier.parseFrame('o'), 'O');
  assert.equal(dossier.parseFrame(' O '), 'O');
  assert.equal(dossier.parseFrame('X'), null);
  assert.equal(dossier.parseFrame(''), null);
  assert.equal(dossier.parseFrame(null), null);
});
