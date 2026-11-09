/* Правка линий границ сектора: UI-модуль (этап 3 §11, карточка SEC-VISUAL-EDIT).
 *
 * Жизненный цикл на заглушках ядра и панели: сессия из состояния карты,
 * переключение инструмента, экспорт, кнопки отмены/повтора. Geometriю
 * модели (якоря, деформация, журнал) проверяет сектор sector-bounds-edit.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSectorBoundsEditUi } from '../src/atlas/sector-bounds-edit-ui.ts';
import { parseBounds } from '../src/atlas/sector-bounds.ts';

const bounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

class FakeElement {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.innerHTML = '';
    this.textContent = '';
    this.value = attrs.value ?? '';
    this.checked = false;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, value) { this.attrs[name] = value; }
  closest(selector) {
    return selector === '[data-action]' && Object.prototype.hasOwnProperty.call(this.attrs, 'data-action')
      ? this
      : null;
  }
  contains() { return false; }
  focus() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
}
// `onPanelClick` проверяет `target instanceof Element`: в Node такого глобала нет.
globalThis.Element = FakeElement;

function fakeKernel(sectorBounds) {
  const state = {
    sectorBounds,
    view: { tx: 0, ty: 0, scale: 1 },
    viewport: { w: 800, h: 600 },
  };
  let renders = 0;
  return {
    state,
    renderer: {
      requestRender() { renders += 1; },
      toScreen(x, y) { return { x, y }; },
      toWorld(x, y) { return { x, y }; },
    },
    renders() { return renders; },
  };
}

function fakePanel() {
  const blocks = new Map();
  const handlers = new Map();
  return {
    blocks,
    handlers,
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener() {},
    querySelector(selector) {
      if (!blocks.has(selector)) blocks.set(selector, { innerHTML: '' });
      return blocks.get(selector);
    },
    contains() { return false; },
    classList: { toggle() {}, contains() { return false; } },
  };
}

const blockHtml = (panel, name) => panel.blocks.get(`[data-editor-block="${name}"]`).innerHTML;

function clickPanel(panel, action, attrs = {}) {
  const handler = panel.handlers.get('click');
  handler({ target: new FakeElement({ 'data-action': action, ...attrs }) });
}

test('сессия правки линий начинается из состояния карты', () => {
  const kernel = fakeKernel(bounds);
  const api = createSectorBoundsEditUi({ kernel, panel: null, stage: null, canvas: null });
  assert.equal(api.session().doc.bounds.length, 4);
  assert.equal(api.enabled(), false);
  api.destroy();
});

test('пустые границы: сессия с пустым списком контуров', () => {
  const kernel = fakeKernel(null);
  const api = createSectorBoundsEditUi({ kernel, panel: null, stage: null, canvas: null });
  assert.equal(api.session().doc.bounds.length, 0);
  api.destroy();
});

test('включение/выключение инструмента: callbacks и состояние', () => {
  const kernel = fakeKernel(bounds);
  const activate = { count: 0 };
  const deactivate = { count: 0 };
  const api = createSectorBoundsEditUi({
    kernel, panel: null, stage: null, canvas: null,
    onActivate: () => { activate.count += 1; },
    onDeactivate: () => { deactivate.count += 1; },
  });
  api.setEnabled(true);
  assert.equal(api.enabled(), true);
  assert.equal(activate.count, 1, 'включение вызывает onActivate');
  api.setEnabled(false);
  assert.equal(api.enabled(), false);
  assert.equal(deactivate.count, 1, 'выключение вызывает onDeactivate');
  // Повторное выключение не вызывает callback снова.
  api.setEnabled(false);
  assert.equal(deactivate.count, 1);
  api.destroy();
});

test('панель: раздел «Линии» с кнопками инструмента, экспорта и отмены', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  const html = blockHtml(panel, 'lines');
  assert.match(html, /data-action="line-tool"/, 'кнопка инструмента');
  assert.match(html, /data-action="line-export"/, 'кнопка экспорта');
  assert.match(html, /data-action="line-undo"/, 'кнопка отмены');
  assert.match(html, /data-action="line-redo"/, 'кнопка повтора');
  assert.match(html, /Правка линий/);
  assert.match(html, /Контуров: 4/, 'счётчик контуров в статусе');
  api.destroy();
});

test('кнопка инструмента переключает состояние и перерисовывает панель', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  clickPanel(panel, 'line-tool');
  assert.equal(api.enabled(), true);
  assert.match(blockHtml(panel, 'lines'), /aria-pressed="true"/, 'инструмент активен');
  clickPanel(panel, 'line-tool');
  assert.equal(api.enabled(), false);
  assert.match(blockHtml(panel, 'lines'), /aria-pressed="false"/, 'инструмент выключен');
  api.destroy();
});

test('кнопка отмены без журнала — сообщение, без записи', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  clickPanel(panel, 'line-undo');
  assert.match(blockHtml(panel, 'lines'), /Нет записей для отмены/);
  assert.equal(api.session().past.length, 0);
  api.destroy();
});

test('кнопка экспорта: JSON в схеме data/sector-bounds.json', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  const json = api.exportJson();
  const parsed = parseBounds(json);
  assert.deepEqual(parsed, bounds);
  assert.match(json, /"version": 1/);
  assert.match(json, /"mapSize": 10000/);
  api.destroy();
});

test('выгрузка через кнопку панели: вызов download без DOM', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  // В Node-заглушке `download` молча пропускается: клика по кнопке не падает.
  clickPanel(panel, 'line-export');
  assert.match(blockHtml(panel, 'lines'), /Границы выгружены/);
  api.destroy();
});

test('destroy чистит обработчики: клика после уничтожения не падает', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(bounds), panel, stage: null, canvas: null });
  api.destroy();
  // После destroy панель не слушает события — клика нет, но и падения нет.
  clickPanel(panel, 'line-tool');
});

test('пустые границы: панель показывает уведомление о недоступности', () => {
  const panel = fakePanel();
  const api = createSectorBoundsEditUi({ kernel: fakeKernel(null), panel, stage: null, canvas: null });
  assert.match(blockHtml(panel, 'lines'), /Границы сектора не загружены/);
  api.destroy();
});
