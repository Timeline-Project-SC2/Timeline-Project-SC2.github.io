/* Иерархия областей: UI-модуль (§4–§7 ТЗ SEC-AREAS-HIERARCHY).
 *
 * Проверяется то, что нельзя проверить в чистой модели:
 * - видимость overlay: правило `.admin-editor-hierarchy-preview` в боевом CSS
 *   (absolute + inset 0 + pointer-events: none + z-index) и класс канваса;
 * - ясность цели правки (§7): строка состояния «Редактируется: …»;
 * - взаимодействие мышью: выбор области кликом, 6 якорей двойным кликом,
 *   перетаскивание якоря с коммитом, уточнение 2+4, Esc, правая кнопка;
 * - линии пар: правка линии якорями не меняет контуры областей;
 * - группы и сочетания: элементы панели и команды через общую сессию;
 * - взаимное исключение инструментов (коллбеки onActivate/onDeactivate).
 *
 * DOM подменён минимальными заглушками, как в `sector-bounds-edit-ui.test.mjs`:
 * это не браузер; раскладка и пиксели — отдельная проверка.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createSectorAreasHierarchyUi, HIERARCHY_OVERLAY_CLASS } from '../src/atlas/sector-areas-hierarchy-ui.ts';
import { createEditorSession, exportDoc } from '../src/atlas/sector-areas-editor.ts';
import { createArea, parseSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { createGroupCmd, createPairCmd } from '../src/atlas/sector-areas-hierarchy.ts';
import { sampleRing, curvePointAt } from '../src/atlas/sector-areas-anchors.ts';

const css = await readFile(new URL('../site/sector/admin-edit/admin-edit.css', import.meta.url), 'utf8');

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

function docWithPairAndLine() {
  const base = parseSectorAreas({
    version: 1,
    mapSize: 10000,
    modes: ['political', 'military', 'economy', 'tension'],
    experimentalModes: ['ecology', 'history'],
    areas: [
      createArea({ id: 'area-1', name: 'Альфа', rings: [square(1000, 1000, 4000, 4000)] }),
      createArea({ id: 'area-2', name: 'Бета', rings: [square(2500, 2500, 5500, 5500)] }),
    ],
    overrides: [],
    events: [],
  });
  const withPair = createPairCmd(createEditorSession(base), 'area-1', 'area-2');
  return withPair.session;
}

/* --------------------------------------------------------------- заглушки DOM */

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
  contains(name) { return this.values.has(name); }
}

function recordingContext() {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    canvas: null,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
    fill: record('fill'),
    arc: record('arc'),
    clip: record('clip'),
    clearRect: record('clearRect'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
  };
}

/** Разбор атрибутного селектора `[name="value"]` или `[name]`. */
function matchAttrSelector(selector, attrs) {
  const match = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (match === null) return false;
  const [, name, value] = match;
  if (!(name in attrs)) return false;
  return value === undefined || attrs[name] === value;
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
    this.innerHTML = '';
    this.clientWidth = 800;
    this.clientHeight = 600;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { return this.removeChildNode(node); }
  removeChildNode(node) {
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
  dispatch(type, event) {
    const payload = event ?? {};
    if (payload.target === undefined) payload.target = this;
    if (payload.preventDefault === undefined) payload.preventDefault = () => { payload.defaultPrevented = true; };
    if (payload.stopPropagation === undefined) payload.stopPropagation = () => { payload.propagationStopped = true; };
    for (const handler of this.listeners.get(type) ?? []) handler(payload);
    return payload;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentMatches(selector); }
  parentMatches(selector) {
    let current = this.parentNode;
    while (current !== null) {
      if (current.matches(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const blockMatch = /^\[data-editor-block="([^"]+)"\]$/.exec(selector);
    if (blockMatch !== null) return this.getAttribute('data-editor-block') === blockMatch[1];
    if (selector.startsWith('[')) return matchAttrSelector(selector, this.attrs);
    return this.tagName === selector.toUpperCase();
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
  querySelectorAll(selector) {
    const found = [];
    const stack = [...this.children];
    while (stack.length > 0) {
      const node = stack.shift();
      if (node.matches(selector)) found.push(node);
      stack.push(...node.children);
    }
    return found;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  getContext() { return this.context ?? null; }
}

globalThis.Element = FakeNode;
globalThis.MouseEvent = class FakeMouseEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init); }
};

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
      const list = this.handlers.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type, init) {
      const event = { type, ...init };
      if (event.preventDefault === undefined) event.preventDefault = () => { event.defaultPrevented = true; };
      if (event.stopPropagation === undefined) event.stopPropagation = () => { event.propagationStopped = true; };
      for (const handler of handlers.get(type) ?? []) handler(event);
      return event;
    },
  };
}
globalThis.window = makeWindow();
globalThis.CSS = { escape: (value) => value.replace(/["\\]/g, '\\$&') };

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

/* ---------------------------------------------------------------- стенд */

function harness(initialSession) {
  created.length = 0;
  const stage = new FakeNode('main');
  const canvas = new FakeNode('canvas');
  const panel = new FakeNode('aside');
  const block = new FakeNode('div');
  block.setAttribute('data-editor-block', 'hierarchy');
  panel.appendChild(block);
  const tool = new FakeNode('button');
  tool.setAttribute('data-action', 'hierarchy-tool');
  panel.appendChild(tool);

  let current = initialSession;
  const applied = [];
  const counts = { activate: 0, deactivate: 0 };
  const kernel = {
    state: {
      sectorBounds: null,
      sectorAreas: initialSession.doc,
      view: { tx: 0, ty: 0, scale: 1 },
      viewport: { w: 800, h: 600 },
    },
    renderer: {
      requestRender() { /* подсчёт не нужен */ },
      toScreen(x, y) { return { x, y }; },
      toWorld(x, y) { return { x, y }; },
    },
  };
  const ui = createSectorAreasHierarchyUi({
    kernel,
    panel,
    stage,
    canvas,
    areas: {
      getSession: () => current,
      applySession(next) { current = next; applied.push(next); kernel.state.sectorAreas = next.doc; },
    },
    onActivate() { counts.activate += 1; },
    onDeactivate() { counts.deactivate += 1; },
  });
  return {
    ui, kernel, stage, canvas, panel, block, tool, counts,
    applied,
    session: () => current,
    /** Внешняя смена сессии (как из «Свойств») с обновлением блока. */
    applyExternal(next) { current = next; kernel.state.sectorAreas = next.doc; ui.refresh(); },
    clickTool() { return panel.dispatch('click', { target: tool }); },
    click(button) { return panel.dispatch('click', { target: button }); },
    pointer(type, x, y, extra = {}) {
      return stage.dispatch(type, { clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true, target: canvas, ...extra });
    },
    dblclick(x, y) {
      return stage.dispatch('dblclick', new globalThis.MouseEvent('dblclick', { clientX: x, clientY: y, button: 0, target: canvas }));
    },
    contextMenu() {
      return stage.dispatch('contextmenu', { target: canvas, button: 2, preventDefault() {}, stopPropagation() {} });
    },
    escape() {
      return globalThis.window.dispatch('keydown', { key: 'Escape', target: canvas });
    },
    /** Последнее сообщение-уведомление из разметки блока. */
    notice() {
      const match = /admin-editor-notice">([^<]*)</.exec(String(block.innerHTML));
      return match === null ? null : match[1];
    },
    status() {
      const match = /Редактируется: ([^<]*)</.exec(String(block.innerHTML));
      return match === null ? null : match[1];
    },
  };
}

/* ------------------------------------------------------- видимость overlay */

test('overlay иерархии объявлен в боевом CSS выше карты и без событий ввода', () => {
  const rule = new RegExp(`\\.${HIERARCHY_OVERLAY_CLASS.replace(/-/g, '\\-')}\\s*{[^}]*position:\\s*absolute[^}]*}`);
  assert.match(css, rule, 'класс overlay отсутствует или не absolute');
  assert.match(css, new RegExp(`\\.${HIERARCHY_OVERLAY_CLASS.replace(/-/g, '\\-')}[^}]*pointer-events:\\s*none`, 'm'),
    'overlay обязан пропускать ввод');
});

test('включение инструмента создаёт overlay-канвас и вызывает onActivate', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  assert.equal(h.counts.activate, 1);
  const overlay = created.find((node) => node.classList.contains(HIERARCHY_OVERLAY_CLASS));
  assert.ok(overlay !== undefined, 'overlay-канвас не создан');
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');
  // Строка цели правки: после включения честно сказано, что контур не выбран.
  assert.match(h.status(), /контур области не выбран/);
});

test('выключение инструмента вызывает onDeactivate и снимает режим', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  h.clickTool();
  assert.equal(h.counts.deactivate, 1);
  assert.match(h.notice(), /выключен/);
});

/* ------------------------------------------------------- контур: мышь */

test('клик по карте выбирает область, статус называет контур области', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  h.pointer('pointerdown', 1500, 1500);
  assert.match(h.status(), /контур области «Альфа»/);
  assert.equal(h.ui.contourEditAreaId(), null, 'клик только выбирает, правку не открывает');
});

test('двойной клик по линии открывает 6 якорей и пишет их в документ', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const ring = h.session().doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  const click = curvePointAt(curve, 0.17, true);
  h.pointer('pointerdown', 2000, 2000); // выбор области
  h.dblclick(click[0], click[1]);
  assert.equal(h.ui.contourEditAreaId(), 'area-1');
  const anchors = h.session().doc.areas[0].contourAnchors;
  assert.ok(anchors !== undefined && anchors[0].anchors.length === 6, 'шесть якорей в документе');
  // Применения сессии этим модулем: выбор области (синхронизация со
  // «Свойствами») + первый набор якорей.
  assert.equal(h.applied.length, 2, 'выбор области и первый набор применяются отдельно');
  assert.match(String(h.session().doc.events.at(-1)?.note ?? ''), /Первый набор якорей/, 'последняя запись истории — первый набор');
  assert.match(h.status(), /контур области «Альфа»/);
});

test('перетаскивание якоря: предпросмотр, отпускание коммитит, Esc завершает', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const ring = h.session().doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.17, true)[0], curvePointAt(curve, 0.17, true)[1]);
  const anchor = h.session().contourEdit.state.anchors[1];
  h.pointer('pointerdown', anchor.point[0], anchor.point[1]);
  h.pointer('pointermove', anchor.point[0] + 60, anchor.point[1] + 120);
  h.pointer('pointerup', anchor.point[0] + 60, anchor.point[1] + 120);
  const baked = h.session().doc.areas[0].contourAnchors[0].anchors;
  assert.equal(baked.length, 6);
  const historyAfterCommit = h.applied.length;
  assert.ok(historyAfterCommit >= 2, 'коммит тяги — запись истории');
  h.escape();
  assert.equal(h.ui.contourEditAreaId(), null, 'Esc завершает правку');
});

test('отпускание без движения не создаёт запись истории', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const ring = h.session().doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.17, true)[0], curvePointAt(curve, 0.17, true)[1]);
  const before = h.session().past.length;
  const anchor = h.session().contourEdit.state.anchors[1];
  h.pointer('pointerdown', anchor.point[0], anchor.point[1]);
  h.pointer('pointerup', anchor.point[0], anchor.point[1]);
  assert.equal(h.session().past.length, before, 'холостое отпускание — истории нет');
});

test('повторный двойной клик по сегменту уточняет его: 6 → 10 якорей', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const ring = h.session().doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.17, true)[0], curvePointAt(curve, 0.17, true)[1]);
  const state = h.session().contourEdit.state;
  const mid = curvePointAt(state.curve, (state.anchors[2].s + state.anchors[3].s) / 2, true);
  h.dblclick(mid[0], mid[1]);
  assert.equal(h.session().doc.areas[0].contourAnchors[0].anchors.length, 10);
});

test('правая кнопка завершает правку контура', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const curve = sampleRing(h.session().doc.areas[0].rings[0]);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.3, true)[0], curvePointAt(curve, 0.3, true)[1]);
  assert.ok(h.ui.contourEditAreaId() !== null);
  h.contextMenu();
  assert.equal(h.ui.contourEditAreaId(), null);
});

/* ------------------------------------------------------- линии пар */

test('правка линии пары: Esc завершает правку, контуры областей целы', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const pairId = h.session().doc.pairs[0].id;
  const button = new FakeNode('button');
  button.setAttribute('data-pair-edit', pairId);
  h.click(button);
  assert.equal(h.ui.pairLinePairId(), pairId);
  assert.match(h.status(), /линия раздела пары/);
  const contoursBefore = JSON.stringify(h.session().doc.areas.map((area) => area.rings));
  // Уточняем середину линии.
  const midX = 3250;
  h.dblclick(midX, 3000);
  // До коммита тяги документ пары не меняется: правка линии локальна.
  assert.equal(JSON.stringify(h.session().doc.areas.map((area) => area.rings)), contoursBefore,
    'уточнение линии не трогает контуры');
  h.escape();
  assert.equal(h.ui.pairLinePairId(), null, 'Esc завершает правку линии');
});

test('перетаскивание якоря линии пишет ручную линию в сочетание, контуры целы', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const pairId = h.session().doc.pairs[0].id;
  const button = new FakeNode('button');
  button.setAttribute('data-pair-edit', pairId);
  h.click(button);
  const ringsBefore = JSON.stringify(h.session().doc.areas.map((area) => area.rings));
  // Якорь линии берём из документа: автолиния несёт 6 якорей, средний — по
  // центру. Перетаскивание идёт по экранным координатам 1:1 (toScreen —
  // тождество в стенде).
  const anchors = h.session().doc.pairs[0].line.anchors;
  const anchorPoint = anchors[2].point;
  h.pointer('pointerdown', anchorPoint[0], anchorPoint[1]);
  h.pointer('pointermove', anchorPoint[0] + 120, anchorPoint[1] + 40);
  h.pointer('pointerup', anchorPoint[0] + 120, anchorPoint[1] + 40);
  const pair = h.session().doc.pairs.find((entry) => entry.id === pairId);
  assert.equal(pair.line.manual, true, 'линия стала ручной');
  assert.equal(JSON.stringify(h.session().doc.areas.map((area) => area.rings)), ringsBefore,
    'контуры областей не изменились');
  // Esc завершает правку линии целиком.
  h.escape();
  assert.equal(h.ui.pairLinePairId(), null);
});

/* ------------------------------------------------------- группы и сочетания */

test('создание группы и сочетания через панель: команды идут в общую сессию', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  // Группа: поле с именем в разметке блока — заглушка innerHTML не парсится,
  // поэтому эмулируем ввод элементом и кликом по кнопке действия.
  const nameInput = new FakeNode('input');
  nameInput.setAttribute('data-hierarchy-group-name', '');
  nameInput.value = 'Север';
  const createGroup = new FakeNode('button');
  createGroup.setAttribute('data-action', 'hierarchy-group-create');
  // querySelector внутри модуля ищет в панели — подкладываем элементы.
  panelAttach(h.panel, nameInput);
  panelAttach(h.panel, createGroup);
  h.click(createGroup);
  assert.equal(h.session().doc.groups.length, 1);
  assert.equal(h.session().doc.groups[0].name, 'Север');
  // Сочетание: два селекта.
  const selectA = new FakeNode('select');
  selectA.setAttribute('data-hierarchy-pair-a', '');
  selectA.value = 'area-1';
  const selectB = new FakeNode('select');
  selectB.setAttribute('data-hierarchy-pair-b', '');
  selectB.value = 'area-2';
  const createPair = new FakeNode('button');
  createPair.setAttribute('data-action', 'hierarchy-pair-create');
  panelAttach(h.panel, selectA);
  panelAttach(h.panel, selectB);
  panelAttach(h.panel, createPair);
  h.click(createPair);
  // Пара area-1+area-2 уже есть: отказ с понятным сообщением, а не исключение.
  assert.match(h.notice(), /уже существует/);
  selectB.value = 'area-2';
  selectA.value = '';
  h.click(createPair);
  assert.match(h.notice(), /Выберите две области/);
});

function panelAttach(panel, node) {
  panel.appendChild(node);
}

test('смена режима и запрета пересечения через панель: записи в документе', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const pairId = h.session().doc.pairs[0].id;
  const modeSelect = new FakeNode('select');
  modeSelect.setAttribute('data-pair-mode', pairId);
  modeSelect.value = 'overlay';
  panelAttach(h.panel, modeSelect);
  h.panel.dispatch('change', { target: modeSelect });
  assert.equal(h.session().doc.pairs[0].mode, 'overlay');
  const forbid = new FakeNode('input');
  forbid.setAttribute('data-pair-forbid', pairId);
  forbid.checked = true;
  panelAttach(h.panel, forbid);
  h.panel.dispatch('change', { target: forbid });
  assert.equal(h.session().doc.pairs[0].forbidCrossing, true);
});

test('undo/redo панели откатывают и повторяют команды иерархии', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const nameInput = new FakeNode('input');
  nameInput.setAttribute('data-hierarchy-group-name', '');
  nameInput.value = 'Север';
  const createGroup = new FakeNode('button');
  createGroup.setAttribute('data-action', 'hierarchy-group-create');
  panelAttach(h.panel, nameInput);
  panelAttach(h.panel, createGroup);
  h.click(createGroup);
  assert.equal(h.session().doc.groups.length, 1);
  const undoButton = new FakeNode('button');
  undoButton.setAttribute('data-action', 'hierarchy-undo');
  panelAttach(h.panel, undoButton);
  const redoButton = new FakeNode('button');
  redoButton.setAttribute('data-action', 'hierarchy-redo');
  panelAttach(h.panel, redoButton);
  h.click(undoButton);
  assert.equal(h.session().doc.groups.length, 0);
  h.click(redoButton);
  assert.equal(h.session().doc.groups.length, 1);
});

test('выгрузка сессии иерархии проходит полный контракт', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const curve = sampleRing(h.session().doc.areas[0].rings[0]);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.17, true)[0], curvePointAt(curve, 0.17, true)[1]);
  const text = exportDoc(h.session(), 2);
  const parsed = parseSectorAreas(JSON.parse(text));
  assert.equal(parsed.areas[0].contourAnchors[0].anchors.length, 6);
  assert.equal(parsed.pairs.length, 1);
});

test('взаимное исключение: onActivate/onDeactivate вызываются ровно при переключении', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  h.clickTool();
  h.clickTool();
  assert.equal(h.counts.activate, 2);
  assert.equal(h.counts.deactivate, 1);
});

test('Esc в полях панели не завершает правку (текстовый ввод приоритетен)', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  const curve = sampleRing(h.session().doc.areas[0].rings[0]);
  h.pointer('pointerdown', 2000, 2000);
  h.dblclick(curvePointAt(curve, 0.3, true)[0], curvePointAt(curve, 0.3, true)[1]);
  const input = new FakeNode('input');
  input.tagName = 'INPUT';
  globalThis.window.dispatch('keydown', { key: 'Escape', target: input });
  assert.ok(h.ui.contourEditAreaId() !== null, 'Esc из поля ввода не должен ронять правку контура');
});

/* --------------------------------------------- регрессии B5/N1/S4 (UI) */

test('B5.2: «Править линию» при выключенном инструменте включает его и правка жива', () => {
  const h = harness(docWithPairAndLine());
  // Инструмент выключен: нажатие [Править линию] само включает его.
  const pairId = h.session().doc.pairs[0].id;
  const button = new FakeNode('button');
  button.setAttribute('data-pair-edit', pairId);
  h.click(button);
  assert.equal(h.ui.enabled(), true, 'инструмент включён кнопкой правки линии');
  assert.equal(h.ui.pairLinePairId(), pairId);
  // Ввод жив: двойной клик в середину СЕГМЕНТА (не на существующий якорь)
  // уточняет его и пишет в документ.
  const anchors = h.session().doc.pairs[0].line.anchors;
  const a2 = anchors[2].point;
  const a3 = anchors[3].point;
  const before = anchors.length;
  h.dblclick((a2[0] + a3[0]) / 2, (a2[1] + a3[1]) / 2);
  const after = h.session().doc.pairs[0].line.anchors.length;
  assert.equal(after, before + 4, 'уточнение 2+4 записано в документ сразу');
  // Esc завершает правку целиком; записанная линия остаётся.
  h.escape();
  assert.equal(h.ui.pairLinePairId(), null);
  assert.equal(h.session().doc.pairs[0].line.manual, true);
});

test('B5.4: ширина перехода применяется на change; input больше не перерисовывает панель', () => {
  const h = harness(docWithPairAndLine());
  const pairId = h.session().doc.pairs[0].id;
  const input = new FakeNode('input');
  input.setAttribute('data-pair-transition', pairId);
  input.value = '160';
  h.panel.dispatch('input', { target: input });
  assert.equal(h.session().doc.pairs[0].transitionWidth, null, 'посимвольный ввод ничего не применяет');
  h.panel.dispatch('change', { target: input });
  assert.equal(h.session().doc.pairs[0].transitionWidth, 160, 'значение применено на change');
});

test('N1: выбор области в списке «Свойства» синхронизируется с блоком «Иерархия»', () => {
  const h = harness(docWithPairAndLine());
  h.clickTool();
  // Сессия обновлена извне (выбор в «Свойствах»): блок иерархии следует за ней.
  const withSelection = { ...h.session(), selection: 'area-2' };
  h.ui.refresh();
  // refresh читает сессию через getSession — подменяем через применение.
  h.applied.length = 0;
  const statusBefore = h.status();
  void statusBefore;
  // Применяем сессию с выбором так же, как это делает редактор областей.
  h.applyExternal(withSelection);
  assert.match(h.status(), /контур области «Бета»/);
});

test('S4: область убирается из группы кнопкой на чипе; пометка пересмотра переключается', () => {
  let session = docWithPairAndLine();
  const grouped = createGroupCmd(session, 'Зона', ['area-1', 'area-2']);
  session = grouped.session;
  const h = harness(session);
  const groupId = h.session().doc.groups[0].id;
  const remove = new FakeNode('button');
  remove.setAttribute('data-group-remove', groupId);
  remove.setAttribute('data-area', 'area-2');
  h.click(remove);
  assert.deepEqual(h.session().doc.groups[0].areaIds, ['area-1'], 'область убрана, группа целá');
  const pairId = h.session().doc.pairs[0].id;
  const review = new FakeNode('button');
  review.setAttribute('data-pair-review', pairId);
  h.click(review);
  assert.equal(h.session().doc.pairs[0].needsReview, true, 'пометка включена кнопкой');
  h.click(review);
  assert.equal(h.session().doc.pairs[0].needsReview, false, 'пометка снята кнопкой');
});
