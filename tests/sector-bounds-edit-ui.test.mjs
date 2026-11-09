/* Правка линий границ сектора: UI-модуль (карточка SEC-VISUAL-EDIT).
 *
 * Здесь проверяется то, что нельзя проверить в чистой модели:
 * - **видимость overlay**: правило `.admin-editor-line-preview` в боевом CSS
 *   (absolute + inset 0 + pointer-events: none + z-index выше карты) и сам
 *   канвас в стадии карты с этим классом;
 * - **взаимодействие**: выбор участка, двойной клик, перетаскивание ядра,
 *   коммит, отмена/повтор, Esc, правая кнопка, отказ при отсутствии перемещения;
 * - **состояния инструмента** и координация с редактором областей;
 * - **импорт** выгруженного JSON и защита горячих клавиш от полей ввода.
 *
 * DOM подменён минимальными заглушками (события, класс-лист, 2D-контекст с
 * записью вызовов). Это не браузер: настоящая раскладка и пиксели проверяются
 * отдельно, см. `docs/handlers`-отчёт карточки.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSectorBoundsEditUi, OVERLAY_CLASS } from '../src/atlas/sector-bounds-edit-ui.ts';
import { isTextEntryTarget } from '../src/atlas/pointer-rules.ts';
import { hotkeyOwnedByLineMode } from '../src/atlas/sector-areas-editor-ui.ts';
import { parseBounds } from '../src/atlas/sector-bounds.ts';

const realBounds = parseBounds(await readFile(new URL('../data/sector-bounds.json', import.meta.url), 'utf8'));

/** Маленький открытый контур с известными координатами: клики и перетаскивание. */
const lineDoc = {
  version: 1,
  mapSize: 10000,
  source: 'test',
  bounds: [{
    id: 'test.contour',
    kind: 'halo',
    label: 'тестовый контур',
    style: { strokeWidth: 2, dash: [], color: 'tactical' },
    points: [[100, 100], [300, 100], [500, 200], [700, 400], [900, 600]],
  }],
};
const css = await readFile(new URL('../site/sector/admin-edit/admin-edit.css', import.meta.url), 'utf8');

/* --------------------------------------------------------------- заглушки DOM */

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

/** Запись вызовов 2D-контекста: по ней видно, что и где нарисовано. */
function recordingContext() {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const context = {
    calls,
    canvas: null,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    lineJoin: 'miter',
    lineCap: 'butt',
    lineDashOffset: 0,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    rect: record('rect'),
    clip: record('clip'),
    clearRect: record('clearRect'),
    stroke: record('stroke'),
    fill: record('fill'),
    arc: record('arc'),
    setLineDash: record('setLineDash'),
    setTransform: record('setTransform'),
    quadraticCurveTo: record('quadraticCurveTo'),
  };
  return context;
}

class FakeNode {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList();
    this.style = {};
    this.attrs = {};
    this.listeners = new Map();
    this.isContentEditable = false;
    this.value = '';
    this.files = null;
    this.innerHTML = '';
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  /** Рассылка события по заглушке: то, что делает браузер. */
  dispatch(type, event) {
    const payload = event ?? {};
    if (payload.target === undefined) payload.target = this;
    if (payload.preventDefault === undefined) payload.preventDefault = () => { payload.defaultPrevented = true; };
    if (payload.stopPropagation === undefined) payload.stopPropagation = () => { payload.propagationStopped = true; };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
    return payload;
  }
  closest(selector) { return this.matches(selector) ? this : null; }
  matches(selector) {
    if (selector === '[data-action]') return this.getAttribute('data-action') !== null;
    const action = /^\[data-action="([^"]+)"\]$/.exec(selector);
    if (action !== null) return this.getAttribute('data-action') === action[1];
    if (selector === '[data-editor-block="lines"]') return this.getAttribute('data-editor-block') === 'lines';
    return false;
  }
  contains(node) {
    if (node === this) return true;
    let current = node?.parentNode ?? null;
    while (current !== null) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  querySelector(selector) {
    const stack = [...this.children];
    while (stack.length > 0) {
      const node = stack.shift();
      if (node.matches(selector)) return node;
      stack.push(...node.children);
    }
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth ?? 0, height: this.clientHeight ?? 0 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() { return this.context ?? null; }
}

// Модуль проверяет `target instanceof Element` и `event instanceof MouseEvent`.
globalThis.Element = FakeNode;
class FakeMouseEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
}
globalThis.MouseEvent = FakeMouseEvent;

/** Окно кадра: rAF-перерисовка и приём горячих клавиш (их слушает window). */
function makeWindow() {
  const handlers = new Map();
  let frame = 0;
  return {
    devicePixelRatio: 1,
    requestAnimationFrame() { frame += 1; return frame; },
    cancelAnimationFrame() {},
    addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    /** Нажатие клавиши: то, что делает браузер на всплытии до window. */
    dispatch(type, init) {
      const event = { type, ...init };
      if (event.preventDefault === undefined) event.preventDefault = () => { event.defaultPrevented = true; };
      if (event.stopPropagation === undefined) event.stopPropagation = () => { event.propagationStopped = true; };
      for (const handler of handlers.get(type) ?? []) handler(event);
      return event;
    },
    listenerCount(type) { return (handlers.get(type) ?? []).length; },
  };
}
globalThis.window = makeWindow();
const created = [];
globalThis.document = {
  createElement(tag) {
    const node = new FakeNode(tag);
    if (tag === 'canvas') {
      node.context = recordingContext();
      node.context.canvas = node;
      created.push(node);
    }
    return node;
  },
  body: new FakeNode('body'),
};

/** Стадия карты, канва, панель и ядро карты — как в бою, но без браузера. */
function harness(sectorBounds = realBounds) {
  created.length = 0;
  const stage = new FakeNode('main');
  stage.clientWidth = 800;
  stage.clientHeight = 600;
  const canvas = new FakeNode('canvas');
  const panel = new FakeNode('aside');
  const block = new FakeNode('div');
  block.setAttribute('data-editor-block', 'lines');
  panel.appendChild(block);
  // Кнопки панели: клик по ним приходит как событие с `target`.
  const buttons = new Map();
  for (const action of ['line-tool', 'line-export', 'line-undo', 'line-redo']) {
    const button = new FakeNode('button');
    button.setAttribute('data-action', action);
    panel.appendChild(button);
    buttons.set(action, button);
  }
  const state = {
    sectorBounds,
    view: { tx: 0, ty: 0, scale: 1 },
    viewport: { w: 800, h: 600 },
  };
  let renders = 0;
  const kernel = {
    state,
    renderer: {
      requestRender() { renders += 1; },
      toScreen(x, y) { return { x, y }; },
      toWorld(x, y) { return { x, y }; },
    },
  };
  const frame = globalThis.window;
  const counts = { activate: 0, deactivate: 0 };
  const ui = createSectorBoundsEditUi({
    kernel,
    panel,
    stage,
    canvas,
    onActivate() { counts.activate += 1; },
    onDeactivate() { counts.deactivate += 1; },
  });
  return {
    ui, kernel, stage, canvas, panel, block, buttons, counts, frame,
    renders: () => renders,
    /** Клик по кнопке панели. */
    click(action) {
      const button = buttons.get(action);
      assert.ok(button, `кнопка ${action}`);
      return panel.dispatch('click', { target: button });
    },
    /** Указатель на стадии карты: цель — канва карты, как в браузере. */
    pointer(type, x, y, extra = {}) {
      return stage.dispatch(type, {
        clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, target: canvas, ...extra,
      });
    },
    /** Двойной клик по карте. */
    dblclick(x, y, extra = {}) {
      return stage.dispatch('dblclick', new FakeMouseEvent('dblclick', {
        clientX: x, clientY: y, button: 0, target: canvas, ...extra,
      }));
    },
    /** Нажатие клавиши (window, фаза перехвата — как в модуле). */
    key(init) {
      return frame.dispatch('keydown', init);
    },
  };
}

/* ------------------------------------------------------- видимость overlay */

test('overlay: у класса есть правило absolute + inset + pointer-events: none', () => {
  const rule = new RegExp(`\\.${OVERLAY_CLASS}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  assert.ok(rule, `в admin-edit.css есть правило .${OVERLAY_CLASS}`);
  const body = rule[1];
  assert.match(body, /position:\s*absolute/u, 'overlay позиционирован');
  assert.match(body, /inset:\s*0/u, 'overlay накрывает стадию');
  assert.match(body, /pointer-events:\s*none/u, 'overlay не перехватывает мышь');
  const zIndex = /z-index:\s*(\d+)/u.exec(body);
  assert.ok(zIndex !== null, 'у overlay задан z-index');
  // Выше карты (0), виньетки (1) и тонировки редактора (2), ниже панелей (14+).
  assert.ok(Number(zIndex[1]) >= 3, `z-index ${zIndex[1]} выше слоя карты и тонировки`);
  const brush = /\.admin-editor-brush-preview\s*\{[^}]*z-index:\s*(\d+)/u.exec(css);
  assert.ok(brush !== null, 'правило предпросмотра кисти существует');
  assert.ok(Number(zIndex[1]) <= 13, 'overlay не перекрывает панели редактора');
});

test('overlay: канвас создаётся в стадии карты с классом и aria-hidden', () => {
  const env = harness();
  const before = created.length;
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  assert.ok(created.length > before, 'канвас overlay создан');
  const node = created.at(-1);
  assert.equal(node.className, OVERLAY_CLASS);
  assert.equal(node.getAttribute('aria-hidden'), 'true');
  assert.equal(node.parentNode, env.stage, 'overlay лежит в стадии карты');
  assert.ok(node.style.width.endsWith('px') && node.style.width === '800px', 'ширина по стадии');
  assert.ok(node.style.height === '600px', 'высота по стадии');
  env.ui.destroy();
});

test('overlay: по клику рисуются участок, затем якоря и ядро', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  const node = created.at(-1);
  assert.ok(node, 'overlay создан');
  const ctx = node.context;
  ctx.calls.length = 0;
  env.pointer('pointerdown', 400, 150);
  assert.equal(env.ui.session().selection.spanStart, 1, 'участок выбран по клику');
  assert.ok(ctx.calls.some((call) => call.name === 'stroke'), 'подсветка участка нарисована');
  // Активная правка: 5 якорей (fill ромбов) и ядро (arc радиусом 8).
  ctx.calls.length = 0;
  env.dblclick(400, 150);
  assert.ok(env.ui.session().active, 'правка открылась');
  const arcs = ctx.calls.filter((call) => call.name === 'arc');
  assert.ok(arcs.length >= 1, 'ядро нарисовано');
  assert.ok(arcs.some((call) => call.args[2] === 8), 'радиус ядра — 8 px');
  const core = env.ui.session().active.core;
  const coreArc = arcs.find((call) => call.args[2] === 8);
  assert.ok(coreArc, 'ядро нарисовано радиусом 8');
  assert.ok(Math.hypot(coreArc.args[0] - core[0], coreArc.args[1] - core[1]) < 0.5, 'ядро на своём месте');
  const fills = ctx.calls.filter((call) => call.name === 'fill');
  assert.ok(fills.length >= 6, 'пять якорей и ядро залиты');
  env.ui.destroy();
});

/* ----------------------------------------------------------- взаимодействие */

test('сценарий: выбор → двойной клик → перетаскивание → коммит → отмена → повтор', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  assert.equal(env.ui.session().selection.spanStart, 1, 'участок выбран кликом');

  env.dblclick(400, 150);
  const active = env.ui.session().active;
  assert.ok(active, 'ядро и якоря появились');
  assert.equal(active.anchors.length, 5, 'пять якорей');
  assert.equal(active.curve.length, active.base.length, 'предпросмотр той же плотности');

  // Перетаскивание: нажимаем на ядро, ведём, отпускаем.
  env.pointer('pointerdown', active.core[0], active.core[1]);
  env.pointer('pointermove', active.core[0] + 40, active.core[1] + 40);
  env.pointer('pointerup', active.core[0] + 40, active.core[1] + 40);
  assert.equal(env.ui.session().past.length, 1, 'коммит записан один раз');
  assert.equal(env.ui.session().active, null, 'правка закрыта');
  assert.equal(env.kernel.state.sectorBounds.bounds.length, lineDoc.bounds.length, 'документ отдан карте');
  assert.ok(env.renders() > 0, 'карта попросила перерисовку');
  const contour = env.ui.session().doc.bounds.find((item) => item.id === 'test.contour');
  assert.ok(contour.points.length > 5, 'точки участка записаны');

  // Ctrl+Z: ровно один шаг отмены.
  env.key({ code: 'KeyZ', key: 'z', ctrlKey: true, target: env.canvas });
  assert.equal(env.ui.session().past.length, 0, 'отмена не сработала дважды');
  assert.deepEqual(env.ui.session().doc, lineDoc, 'документ вернулся к исходному');

  // Ctrl+Shift+Z: ровно один шаг повтора.
  env.key({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true, target: env.canvas });
  assert.equal(env.ui.session().past.length, 1, 'повтор тоже один шаг');
  env.ui.destroy();
});

test('горячие клавиши в поле ввода не трогают журнал', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  env.dblclick(400, 150);
  const active = env.ui.session().active;
  env.pointer('pointerdown', active.core[0], active.core[1]);
  env.pointer('pointermove', active.core[0] + 30, active.core[1] + 30);
  env.pointer('pointerup', active.core[0] + 30, active.core[1] + 30);
  assert.equal(env.ui.session().past.length, 1);

  const input = new FakeNode('input');
  const editable = new FakeNode('div');
  editable.isContentEditable = true;
  env.key({ code: 'KeyZ', key: 'z', ctrlKey: true, target: input });
  env.key({ code: 'KeyZ', key: 'z', ctrlKey: true, target: editable });
  assert.equal(env.ui.session().past.length, 1, 'Ctrl+Z в поле не отменяет правку карты');

  const escape = env.key({ key: 'Escape', target: input });
  assert.ok(!escape.defaultPrevented, 'Esc в поле ввода не перехвачен');
  env.ui.destroy();
});

/* ------------------------------------------------------ состояния панели */

test('панель: раздел «Линии» с инструментом, историей, экспортом и импортом', () => {
  const env = harness();
  const html = env.block.innerHTML;
  assert.match(html, /data-action="line-tool"/u);
  assert.match(html, /data-action="line-undo"/u);
  assert.match(html, /data-action="line-redo"/u);
  assert.match(html, /data-action="line-export"/u);
  assert.match(html, /data-action="line-import"/u, 'поле импорта есть, а не мёртвая кнопка');
  assert.match(html, /type="file"/u);
  assert.match(html, /accept="application\/json,\.json"/u);
  assert.match(html, /role="status"/u, 'статус читается скринридером');
  assert.match(html, /aria-live="polite"/u);
  assert.match(html, /aria-pressed="false"/u);
  env.ui.destroy();
});

test('панель: активное состояние инструмента, счётчики и возврат к прежнему инструменту', () => {
  const env = harness(lineDoc);
  env.click('line-tool');
  assert.match(env.block.innerHTML, /aria-pressed="true"/u);
  assert.match(env.block.innerHTML, /is-current/u);
  assert.ok(env.canvas.classList.contains('editor-lines'), 'курсор инструмента на канве');
  assert.equal(env.counts.activate, 1, 'рисование выключено один раз');
  assert.equal(env.counts.deactivate, 0);

  // Повторный клик по инструменту: выключение, возврат состояния.
  env.pointer('pointerdown', 400, 150);
  env.click('line-tool');
  assert.equal(env.ui.enabled(), false);
  assert.equal(env.counts.deactivate, 1, 'прежнее состояние запрошено один раз');
  assert.equal(env.ui.session().selection, null, 'выбор снят при выключении');
  assert.match(env.block.innerHTML, /aria-pressed="false"/u);
  assert.equal(env.canvas.classList.contains('editor-lines'), false);
  // После выключения клики карте больше не мешают: обработчик не трогает события.
  const event = env.pointer('pointerdown', 400, 150);
  assert.ok(!event.defaultPrevented, 'жест не перехвачен');
  env.ui.destroy();
});

test('панель: отмена и повтор без журнала дают сообщение, а не запись', () => {
  const env = harness();
  env.click('line-undo');
  assert.match(env.block.innerHTML, /Нет записей для отмены/u);
  env.click('line-redo');
  assert.match(env.block.innerHTML, /Нет записей для повтора/u);
  assert.equal(env.ui.session().past.length, 0);
  env.ui.destroy();
});

/* ---------------------------------------------------- отмена и граничные случаи */

test('Esc отменяет правку, не создавая записи и не оставляя активной сессии', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.dblclick(400, 150);
  assert.ok(env.ui.session().active);
  const event = env.key({ key: 'Escape', target: env.canvas });
  assert.equal(event.defaultPrevented, true, 'Esc обработан инструментом');
  assert.equal(env.ui.session().active, null, 'активной сессии нет');
  assert.equal(env.ui.session().past.length, 0, 'записи нет');
  assert.deepEqual(env.ui.session().doc, lineDoc);
  // Esc при отсутствии правки ничего не перехватывает.
  const idle = env.key({ key: 'Escape', target: env.canvas });
  assert.ok(!idle.defaultPrevented, 'без активной правки Esc не перехвачен');
  env.ui.destroy();
});

test('правая кнопка отменяет правку без записи', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.dblclick(400, 150);
  const active = env.ui.session().active;
  assert.ok(active);
  const event = env.stage.dispatch('contextmenu', { clientX: active.core[0], clientY: active.core[1] });
  assert.equal(event.defaultPrevented, true, 'меню карты подавлено только при активной правке');
  assert.equal(env.ui.session().active, null);
  assert.equal(env.ui.session().past.length, 0);
  env.ui.destroy();
});

test('перетаскивание без реального перемещения: коммита нет', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.dblclick(400, 150);
  const active = env.ui.session().active;
  env.pointer('pointerdown', active.core[0], active.core[1]);
  env.pointer('pointerup', active.core[0], active.core[1]);
  assert.equal(env.ui.session().past.length, 0, 'записи нет');
  assert.equal(env.ui.session().active, null, 'сессия закрыта');
  assert.match(env.block.innerHTML, /не перемещено/u);
  env.ui.destroy();
});

/* --------------------------------------------------------------- импорт */

test('импорт: выгруженный JSON принимается, мусор — отклоняется', () => {
  const env = harness();
  const json = env.ui.exportJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.bounds.length, realBounds.bounds.length, 'экспорт в схеме data/sector-bounds.json');

  assert.equal(env.ui.importJson(json), true);
  assert.deepEqual(env.ui.session().doc, realBounds, 'документ восстановлен');
  assert.equal(env.ui.session().past.length, 0, 'импорт не пишет журнал');

  assert.equal(env.ui.importJson('{"version":2}'), false, 'некорректная версия отклонена');
  assert.match(env.block.innerHTML, /Импорт не выполнен/u);
  assert.deepEqual(env.ui.session().doc, realBounds, 'документ после ошибки не испорчен');
  env.ui.destroy();
});

test('импорт: кнопка файла связана с обработчиком change', () => {
  const env = harness();
  const input = new FakeNode('input');
  input.setAttribute('data-action', 'line-import');
  input.files = [{ text: async () => env.ui.exportJson() }];
  env.panel.dispatch('change', { target: input });
  assert.equal(input.value, '', 'значение сброшено: тот же файл можно выбрать снова');
  env.ui.destroy();
});

/* ------------------------------------------------- горячие клавиши и ввод */

test('горячие клавиши: поле ввода и contenteditable защищены', () => {
  const input = new FakeNode('input');
  assert.equal(isTextEntryTarget(input), true, 'input защищён');
  const editable = new FakeNode('div');
  editable.isContentEditable = true;
  assert.equal(isTextEntryTarget(editable), true, 'contenteditable защищён');
  const plain = new FakeNode('div');
  assert.equal(isTextEntryTarget(plain), false, 'обычный узел не защищён');
  assert.equal(isTextEntryTarget(null), false);
});

test('горячие клавиши: при активной правке линий обе клавиши уходят ей', () => {
  assert.equal(hotkeyOwnedByLineMode('undo', true), true);
  assert.equal(hotkeyOwnedByLineMode('redo', true), true, 'повтор тоже не обрабатывается дважды');
  assert.equal(hotkeyOwnedByLineMode('undo', false), false);
  assert.equal(hotkeyOwnedByLineMode('force', true), false);
  assert.equal(hotkeyOwnedByLineMode(null, true), false);
});

/* ----------------------------------------------------------- жизненный цикл */

test('сессия правки линий начинается из состояния карты', () => {
  const env = harness();
  assert.deepEqual(env.ui.session().doc, realBounds);
  assert.equal(env.ui.enabled(), false);
  env.ui.destroy();
});

test('пустые границы: сессия с пустым списком контуров и предупреждение', () => {
  const env = harness(null);
  assert.equal(env.ui.session().doc.bounds.length, 0);
  assert.match(env.block.innerHTML, /Границы сектора не загружены/u);
  env.ui.destroy();
});

test('destroy: обработчики сняты, overlay удалён', () => {
  const env = harness();
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  const node = created.at(-1);
  const listenersBefore = env.stage.listeners.get('pointerdown')?.length ?? 0;
  assert.ok(listenersBefore > 0);
  env.ui.destroy();
  assert.equal(env.stage.listeners.get('pointerdown')?.length ?? 0, 0, 'слушатели сняты');
  assert.equal(node.parentNode, null, 'overlay удалён из стадии');
  // Событие после уничтожения не падает.
  env.pointer('pointerdown', 400, 150);
});

/* ---------------------------------------- предел тяги и отказ записи */

test('предел тяги: упор в окно влияния виден в панели, запись всё равно проходит', () => {
  const env = harness(lineDoc);
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 400, 150);
  env.dblclick(400, 150);
  const active = env.ui.session().active;
  assert.ok(active);
  env.pointer('pointerdown', active.core[0], active.core[1]);
  env.pointer('pointermove', active.core[0] + 1000, active.core[1] + 1000);
  assert.equal(env.ui.session().active.limited, true, 'ядро упёрлось в предел');
  const hint = env.block.innerHTML;
  assert.match(hint, /Тяга ограничена/u, 'пользователь видит, что тяга ограничена');
  env.pointer('pointerup', active.core[0] + 1000, active.core[1] + 1000);
  assert.equal(env.ui.session().past.length, 1, 'ограниченная тяга всё равно пишется');
  assert.match(env.block.innerHTML, /ограниченной тягой/u, 'в сообщении о коммите сказано об ограничении');
  env.ui.destroy();
});

test('отказ записи у края поля: панель объясняет причину, журнал пуст', () => {
  // Квадрат у самого верха карты: тяга за край сложила бы линию петлёй.
  const edgeDoc = {
    version: 1,
    mapSize: 10000,
    source: 'test',
    bounds: [{
      id: 'test.contour',
      kind: 'nebula',
      label: 'у края',
      style: { strokeWidth: 2, dash: [], color: 'nebula' },
      points: [[0, 9900], [300, 9900], [300, 9970], [0, 9970], [0, 9900]],
    }],
  };
  const env = harness(edgeDoc);
  env.ui.setEnabled(true);
  env.pointer('pointerdown', 150, 9900);
  env.dblclick(150, 9900);
  const active = env.ui.session().active;
  assert.ok(active, 'правка у края открывается');
  env.pointer('pointerdown', active.core[0], active.core[1]);
  env.pointer('pointermove', 25000, 25000);
  env.pointer('pointerup', 25000, 25000);
  assert.equal(env.ui.session().past.length, 0, 'запись не сделана');
  assert.match(env.block.innerHTML, /Запись не выполнена/u, 'причина отказа видна');
  assert.match(env.block.innerHTML, /петл/u, 'сказано, что линия сложилась бы петлёй');
  env.ui.destroy();
});
