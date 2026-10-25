/* Блоки-плейсхолдеры сектора (Z-3.2, §17.22.1): модель без DOM.
 *
 * Тесты чистые: проверяются разбор JSON, видимость в кадре, раскладка угловых
 * блоков, чистота `setState` и описания для скринридера. Живой браузерный прогон
 * в песочнице невозможен (нет WebGL2), поэтому отрисовка здесь не проверяется.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const overlays = require('../src/atlas/sector-overlays.ts');

const source = readFileSync(new URL('../src/atlas/sector-overlays.ts', import.meta.url), 'utf8');
const json = readFileSync(new URL('../data/sector-overlays.json', import.meta.url), 'utf8');
const blocks = overlays.parseOverlays(json);
const byId = new Map(blocks.map((block) => [block.id, block]));

const MAP_SIZE = 10000;
const FIT_INSET = 0.94;

/** Кадр с камерой «вся карта»: тот же расчёт, что `fitScaleFor` в атласе. */
function fitted(w, h) {
  return { w, h, scale: Math.min(w, h) / MAP_SIZE * FIT_INSET, centerX: MAP_SIZE / 2, centerY: MAP_SIZE / 2 };
}

const DESKTOP = fitted(1920, 1080);
const PHONE = fitted(390, 844);

function cornerPlacements(viewport) {
  return overlays.layoutOverlays(blocks, viewport).filter((placement) => placement.block.anchor.kind === 'corner');
}

function slotOf(id, slotId) {
  const block = byId.get(id);
  assert.ok(block, `нет блока ${id}`);
  const slot = block.slots.find((item) => item.id === slotId);
  assert.ok(slot, `нет слота ${slotId} у блока ${id}`);
  return slot;
}

/** Минимальный блок для синтетических сценариев. */
function blockSource(overrides) {
  return JSON.stringify({
    blocks: [{
      id: 'zone.9',
      title: 'HIGH DANGER ZONE',
      anchor: { kind: 'world', x: MAP_SIZE / 2, y: MAP_SIZE / 2 },
      size: { w: 100, h: 40, unit: 'px' },
      state: 'expanded',
      interactive: true,
      slots: [],
      ...overrides,
    }],
  });
}

test('JSON эталона: восемь блоков, уникальные id, все — заготовки', () => {
  assert.equal(blocks.length, 8);
  assert.equal(new Set(blocks.map((block) => block.id)).size, 8);
  assert.deepEqual(blocks.map((block) => block.id), [
    'legend', 'statistics', 'inset', 'watermark', 'zone.1', 'zone.2', 'callout.1', 'callout.2',
  ]);
  for (const block of blocks) {
    assert.ok(overlays.OVERLAY_ID_PATTERN.test(block.id), block.id);
    assert.equal(block.placeholder, true, block.id);
    assert.ok(block.title.length > 0, block.id);
    assert.equal(Object.isFrozen(block), true, block.id);
    assert.equal(Object.isFrozen(block.slots), true, block.id);
    for (const slot of block.slots) {
      assert.ok(slot.placeholder.length > 0, `${block.id}/${slot.id}`);
      assert.ok(overlays.OVERLAY_SLOT_KINDS.includes(slot.kind), `${block.id}/${slot.id}: ${slot.kind}`);
    }
  }
  // Уже разобранный объект даёт ту же модель, что и строка JSON.
  assert.deepEqual(overlays.parseOverlays(JSON.parse(json)), blocks);
});

test('состав по эталону: панели, метки зон, выноски и все шесть видов слотов', () => {
  assert.equal(byId.get('legend').anchor.corner, 'top-left');
  assert.equal(byId.get('statistics').anchor.corner, 'bottom-left');
  assert.equal(byId.get('inset').anchor.corner, 'top-right');
  assert.equal(byId.get('watermark').anchor.kind, 'world');
  for (const block of blocks) {
    if (block.id.startsWith('zone.') || block.id.startsWith('callout.')) {
      assert.equal(block.anchor.kind, 'world', block.id);
    }
  }
  const kinds = new Set(blocks.flatMap((block) => block.slots.map((slot) => slot.kind)));
  assert.deepEqual([...kinds].sort(), ['counter', 'link', 'list', 'media', 'number', 'text']);
});

test('тексты взяты с эталона и остаются плейсхолдерами, а не выдуманным лором', () => {
  assert.equal(slotOf('legend', 'scale').value, '1 Квадрат = 150 св.г.');
  assert.deepEqual(byId.get('watermark').slots.map((slot) => slot.value), ['Galactic Gala', 'PROTOSS SECTOR']);
  assert.equal(slotOf('zone.1', 'label').value, '/// HIGH DANGER ZONE ///');
  assert.equal(slotOf('zone.1', 'note').value, 'Zerg swarm fleet detected');
  assert.equal(slotOf('zone.2', 'note').value, 'Zerg swarm fleet detected');
  assert.equal(slotOf('callout.1', 'title').value, 'Zone of Lost Signals');
  assert.equal(slotOf('callout.1', 'class').value, 'Nebula class B');
  assert.equal(slotOf('callout.2', 'title').value, 'Fog of Echos');
  assert.equal(slotOf('callout.2', 'class').value, 'Nebula class A');
  // Пустые слоты — именно заготовки под будущие вложения.
  const empty = blocks.flatMap((block) => block.slots.filter((slot) => slot.value === null));
  assert.ok(empty.length >= 8, `пустых слотов: ${empty.length}`);
  for (const slot of empty) assert.ok(slot.placeholder.length > 0, slot.id);
});

test('битый JSON, чужой id, дубль id и неизвестный kind слота — RangeError по-русски', () => {
  assert.throws(
    () => overlays.parseOverlays('{"blocks": ['),
    (error) => error instanceof RangeError && /Битый JSON/.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays('{"blocks": "нет"}'),
    (error) => error instanceof RangeError && /массив blocks/.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays(blockSource({ id: 'toolbar' })),
    (error) => error instanceof RangeError && /Неизвестный id блока/.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays(JSON.stringify({
      blocks: [
        JSON.parse(blockSource()).blocks[0],
        JSON.parse(blockSource()).blocks[0],
      ],
    })),
    (error) => error instanceof RangeError && /Повторяющийся id/.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays(JSON.stringify({
      blocks: [{
        ...JSON.parse(blockSource()).blocks[0],
        slots: [{ id: 'video', kind: 'video', value: null, placeholder: 'видео' }],
      }],
    })),
    (error) => error instanceof RangeError && /Неизвестный kind слота/.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays(blockSource({ anchor: { kind: 'corner', corner: 'center' } })),
    (error) => error instanceof RangeError && /неизвестный угол/i.test(error.message),
  );
  assert.throws(
    () => overlays.parseOverlays(blockSource({ state: 'hidden' })),
    (error) => error instanceof RangeError && /Неизвестное состояние/.test(error.message),
  );
});

test('неинтерактивный блок не отдаёт action, даже если действие пришло в данных', () => {
  const withAction = {
    action: { kind: 'toggle', target: 'watermark.notes' },
    state: 'expanded',
  };
  const [passive] = overlays.parseOverlays(blockSource({ id: 'watermark', interactive: false, ...withAction }));
  assert.equal(passive.interactive, false);
  assert.equal(passive.action, undefined);
  assert.equal('action' in passive, false);

  const [active] = overlays.parseOverlays(blockSource({ id: 'legend', interactive: true, ...withAction }));
  assert.equal(active.action.kind, 'toggle');
  assert.equal(active.action.target, 'watermark.notes');
  // Блок без интерактивности в самом JSON эталона тоже без действия.
  assert.equal(byId.get('watermark').interactive, false);
  assert.equal(byId.get('watermark').action, undefined);
});

test('blocksAt на 1920×1080: все восемь блоков в кадре, состояния из данных', () => {
  const visible = overlays.blocksAt(blocks, DESKTOP);
  assert.deepEqual(visible.map((block) => block.id), blocks.map((block) => block.id));
  for (const block of visible) assert.equal(block.state, byId.get(block.id).state);
  assert.equal(byId.get('legend').state, 'expanded');
  assert.equal(byId.get('statistics').state, 'expanded');
});

test('правило телефона: при ширине ≤ 599 px legend и statistics сворачиваются', () => {
  assert.equal(overlays.OVERLAY_PHONE_MAX_WIDTH, 599);
  assert.equal(overlays.collapsesOnPhone('legend'), true);
  assert.equal(overlays.collapsesOnPhone('statistics'), true);
  assert.equal(overlays.collapsesOnPhone('inset'), false);

  const visible = overlays.blocksAt(blocks, PHONE);
  const states = new Map(visible.map((block) => [block.id, block.state]));
  assert.equal(states.get('legend'), 'collapsed');
  assert.equal(states.get('statistics'), 'collapsed');
  assert.equal(states.get('inset'), 'expanded');
  assert.equal(states.get('zone.1'), 'expanded');
  assert.equal(visible.length, 8);

  // Исходная модель не мутирована: правило применяется к копиям.
  for (const block of blocks) assert.notEqual(block.state, undefined);
  assert.equal(byId.get('legend').state, 'expanded');
  assert.equal(byId.get('statistics').state, 'expanded');
  assert.notEqual(visible[0], blocks[0]);

  // Ровно на границе брейкпоинта блоки ещё разворачиваются.
  const wide = overlays.blocksAt(blocks, fitted(600, 900));
  assert.equal(wide.find((block) => block.id === 'legend').state, 'expanded');
  const narrow = overlays.blocksAt(blocks, fitted(599, 900));
  assert.equal(narrow.find((block) => block.id === 'legend').state, 'collapsed');

  // Свёрнутая шапка ниже развёрнутой панели: высота берётся из константы.
  const collapsedRect = overlays.layoutOverlays(blocks, PHONE)
    .find((placement) => placement.block.id === 'legend').rect;
  assert.equal(collapsedRect.height, overlays.OVERLAY_COLLAPSED_HEIGHT_PX);
});

test('угловые блоки не наезжают друг на друга и не выходят за кадр (1920×1080 и 390×844)', () => {
  for (const viewport of [DESKTOP, PHONE]) {
    const corners = cornerPlacements(viewport);
    assert.equal(corners.length, 3, `${viewport.w}×${viewport.h}`);
    for (let first = 0; first < corners.length; first += 1) {
      const a = corners[first].rect;
      assert.ok(a.x >= 0 && a.y >= 0, `${corners[first].block.id} за левым/верхним краем`);
      assert.ok(a.x + a.width <= viewport.w, `${corners[first].block.id} за правым краем`);
      assert.ok(a.y + a.height <= viewport.h, `${corners[first].block.id} за нижним краем`);
      assert.ok(a.width > 0 && a.height > 0, `${corners[first].block.id} пустой прямоугольник`);
      for (let second = first + 1; second < corners.length; second += 1) {
        assert.equal(
          overlays.overlayRectsOverlap(a, corners[second].rect),
          false,
          `${corners[first].block.id} наехал на ${corners[second].block.id} при ${viewport.w}×${viewport.h}`,
        );
      }
    }
  }
});

test('два блока в одном углу встают в стопку с зазором, а не друг на друга', () => {
  const stacked = overlays.parseOverlays(JSON.stringify({
    blocks: ['legend', 'statistics'].map((id) => ({
      id,
      title: id === 'legend' ? 'MAP LEGEND' : 'STATISTICS',
      anchor: { kind: 'corner', corner: 'top-left' },
      size: { w: 0.2, h: 0.1, unit: 'frame' },
      state: 'expanded',
      interactive: true,
      slots: [],
    })),
  }));
  const placements = overlays.layoutOverlays(stacked, DESKTOP);
  assert.equal(placements.length, 2);
  const [first, second] = placements;
  assert.equal(overlays.overlayRectsOverlap(first.rect, second.rect), false);
  assert.equal(second.rect.y, first.rect.y + first.rect.height + overlays.OVERLAY_STACK_GAP_PX);
  assert.equal(second.rect.x, overlays.OVERLAY_EDGE_INSET_PX);
  assert.equal(first.rect.y, overlays.OVERLAY_EDGE_INSET_PX);
});

test('мировые якоря: проекция без переворота Y, без камеры блок не виден', () => {
  const centred = overlays.parseOverlays(blockSource({}));
  const [placement] = overlays.layoutOverlays(centred, DESKTOP);
  assert.equal(placement.rect.x, DESKTOP.w / 2 - 50);
  assert.equal(placement.rect.y, DESKTOP.h / 2 - 20);
  assert.equal(placement.rect.width, 100);

  // Без масштаба и центра камеры мировой якорь некуда проецировать.
  assert.deepEqual(overlays.layoutOverlays(centred, { w: 1920, h: 1080 }), []);

  // Якорь далеко за кадром отбрасывается, а не рисуется за краем.
  const far = overlays.parseOverlays(blockSource({ anchor: { kind: 'world', x: 20000, y: 5000 } }));
  assert.deepEqual(overlays.layoutOverlays(far, DESKTOP), []);

  // Экранный якорь задан в px кадра и не зависит от камеры.
  const screen = overlays.parseOverlays(blockSource({ anchor: { kind: 'screen', x: 100, y: 80 } }));
  const [screenPlacement] = overlays.layoutOverlays(screen, PHONE);
  assert.equal(screenPlacement.rect.x, 50);
  assert.equal(screenPlacement.rect.y, 60);

  // Битый кадр — RangeError, а не тихая пустая раскладка.
  assert.throws(() => overlays.layoutOverlays(blocks, { w: 0, h: 1080 }), RangeError);
  assert.throws(() => overlays.layoutOverlays(blocks, { ...DESKTOP, scale: -1 }), RangeError);
});

test('setState идемпотентен и не мутирует вход', () => {
  const snapshot = JSON.stringify(blocks);
  const once = overlays.setState(blocks, 'legend', 'collapsed');
  const twice = overlays.setState(once, 'legend', 'collapsed');

  assert.deepEqual(twice, once);
  assert.equal(JSON.stringify(blocks), snapshot, 'вход изменён');
  assert.notEqual(once, blocks);
  assert.equal(once[0].state, 'collapsed');
  assert.equal(blocks[0].state, 'expanded');
  // Нетронутые блоки переходят по ссылке: копируется только целевой.
  assert.equal(once[1], blocks[1]);
  assert.notEqual(once[0], blocks[0]);

  // Смена на то же состояние ничего не ломает и возвращает новый массив.
  const same = overlays.setState(blocks, 'legend', 'expanded');
  assert.deepEqual(same, blocks);
  assert.notEqual(same, blocks);

  // Неизвестный id не бросает исключение: модель остаётся прежней.
  assert.deepEqual(overlays.setState(blocks, 'toolbar', 'collapsed'), blocks);

  assert.throws(
    () => overlays.setState(blocks, 'legend', 'hidden'),
    (error) => error instanceof RangeError && /Неизвестное состояние/.test(error.message),
  );
});

test('describeForA11y: у каждого блока непустые role, label и подсказка', () => {
  const roles = {
    legend: 'region',
    statistics: 'status',
    inset: 'figure',
    watermark: 'img',
    'zone.1': 'alert',
    'zone.2': 'alert',
    'callout.1': 'note',
    'callout.2': 'note',
  };
  for (const block of blocks) {
    const a11y = overlays.describeForA11y(block);
    assert.ok(a11y.role.length > 0, `${block.id}: role`);
    assert.ok(a11y.label.length > 0, `${block.id}: label`);
    assert.ok(a11y.hint.length > 0, `${block.id}: hint`);
    assert.ok(a11y.label.startsWith(block.title), `${block.id}: label без заголовка`);
    assert.ok(/[А-Яа-яЁё]/.test(a11y.hint), `${block.id}: подсказка не по-русски`);
    assert.equal(a11y.role, roles[block.id], block.id);
  }
  assert.ok(overlays.describeForA11y(byId.get('legend')).label.includes('1 Квадрат = 150 св.г.'));
  assert.ok(overlays.describeForA11y(byId.get('zone.1')).label.includes('Zerg swarm fleet detected'));
});

test('подсказка describeForA11y следует состоянию и действию блока', () => {
  const expanded = overlays.describeForA11y(byId.get('legend'));
  assert.equal(expanded.hint, 'Свернуть блок');
  const collapsed = overlays.describeForA11y(overlays.setState(blocks, 'legend', 'collapsed')[0]);
  assert.equal(collapsed.hint, 'Развернуть блок');
  assert.equal(collapsed.role, 'region');
  assert.equal(overlays.describeForA11y(byId.get('inset')).hint, 'Открыть ссылку «#sector-inset-fullscreen»');
  assert.equal(overlays.describeForA11y(byId.get('zone.1')).hint, 'Перевести кадр на объект «zone.1»');
  assert.equal(overlays.describeForA11y(byId.get('watermark')).hint, 'Статический блок: только чтение.');
});

test('модель без DOM и без случайностей: запрещённых источников в модуле нет', () => {
  // Комментарии шапки перечисляют запреты словами — проверяется только код.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /Math\.random|Date\.now|performance\.now/);
  assert.doesNotMatch(code, /\b(?:document|window|navigator|localStorage)\b/);
  assert.doesNotMatch(json, /https?:\/\//);
});
