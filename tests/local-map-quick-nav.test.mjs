/* Node-тест чистой раскладки кнопок перехода Stage-8.7 (Воркер 4).
   Запуск: node --test tests/local-map-quick-nav.test.mjs.
   Проверяет фазу цикла и ступенчатую задержку слотов, границы opacity,
   порядок стрелок и поведение пустого/некорректного ввода. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QuickNav = require('../site/planet-globe/local-map-quick-nav.ts');
const { layoutQuickNavArrows, QUICK_NAV_CYCLE_MS } = QuickNav;

const HINTS = [
  { slot: 5, cell: 105, x: 15, y: 25, angleRad: 5 },
  { slot: 2, cell: 102, x: 12, y: 22, angleRad: 2 },
  { slot: 0, cell: 100, x: 10, y: 20, angleRad: 0 },
  { slot: 4, cell: 104, x: 14, y: 24, angleRad: 4 },
  { slot: 1, cell: 101, x: 11, y: 21, angleRad: 1 },
  { slot: 3, cell: 103, x: 13, y: 23, angleRad: 3 },
];

function opacityAt(slot, nowMs, cycleMs = QUICK_NAV_CYCLE_MS) {
  const hint = HINTS.find((candidate) => candidate.slot === slot);
  assert.ok(hint, `нет тестового hint для слота ${slot}`);
  const [arrow] = layoutQuickNavArrows([hint], cycleMs, nowMs);
  assert.ok(arrow, `нет раскладки для слота ${slot}`);
  return arrow.opacity;
}

function assertClose(actual, expected, message = '') {
  assert.ok(Math.abs(actual - expected) <= 1e-12, `${message}: ожидалось ${expected}, получено ${actual}`);
}

test('quick-nav: раскладка упорядочена по слотам и сохраняет координаты hints', () => {
  const arrows = layoutQuickNavArrows(HINTS, QUICK_NAV_CYCLE_MS, 1000);
  assert.deepEqual(arrows.map((arrow) => arrow.slot), [0, 1, 2, 3, 4, 5]);
  for (const arrow of arrows) {
    const hint = HINTS.find((candidate) => candidate.slot === arrow.slot);
    assert.ok(hint);
    assert.equal(arrow.cell, hint.cell);
    assert.equal(arrow.x, hint.x);
    assert.equal(arrow.y, hint.y);
    assert.equal(arrow.angleRad, hint.angleRad);
  }
  assert.equal(arrows.length, 6);
});

test('quick-nav: фаза повторяется по циклу и сдвигается на 90 мс по слоту', () => {
  for (let slot = 0; slot < 6; slot++) {
    const halfFadeInAt = 2 * QUICK_NAV_CYCLE_MS + slot * 90 + 90;
    assertClose(opacityAt(slot, halfFadeInAt), 0.5, `слот ${slot}`);
  }

  const atFirstCycle = layoutQuickNavArrows(HINTS, QUICK_NAV_CYCLE_MS, 1275);
  const atNextCycle = layoutQuickNavArrows(HINTS, QUICK_NAV_CYCLE_MS, 1275 + QUICK_NAV_CYCLE_MS);
  assert.deepEqual(atNextCycle, atFirstCycle);
});

test('quick-nav: fade-in и fade-out имеют заданные границы', () => {
  assert.equal(opacityAt(0, 0), 0);
  assertClose(opacityAt(0, 90), 0.5, 'середина fade-in');
  assertClose(opacityAt(0, 179), 179 / 180, 'последняя миллисекунда fade-in');
  assert.equal(opacityAt(0, 180), 1);
  assert.equal(opacityAt(0, 2339), 1);
  assert.equal(opacityAt(0, 2340), 1);
  assertClose(opacityAt(0, 2470), 0.5, 'середина fade-out');
  assertClose(opacityAt(0, 2599), 1 / 260, 'последняя миллисекунда окна');
  assert.equal(opacityAt(0, 2600), 0);
});

test('quick-nav: opacity всегда конечна и находится в диапазоне 0..1', () => {
  const sampleTimes = [-100000, -1, 0, 1, 90, 180, 2340, 2599, 2600, 7199, 7200, 1000000000];
  for (const nowMs of sampleTimes) {
    for (const arrow of layoutQuickNavArrows(HINTS, QUICK_NAV_CYCLE_MS, nowMs)) {
      assert.ok(Number.isFinite(arrow.opacity));
      assert.ok(arrow.opacity >= 0 && arrow.opacity <= 1, `opacity вне диапазона при nowMs=${nowMs}`);
    }
  }
  assert.ok(layoutQuickNavArrows(HINTS, 0, 90).every((arrow) => arrow.opacity === 0));
});

test('quick-nav: пустой массив и повторные вызовы не создают состояний', () => {
  assert.deepEqual(layoutQuickNavArrows([], QUICK_NAV_CYCLE_MS, 0), []);
  assert.deepEqual(layoutQuickNavArrows([], QUICK_NAV_CYCLE_MS, 8000), []);
  assert.deepEqual(layoutQuickNavArrows([], QUICK_NAV_CYCLE_MS, 0), []);
});

/* ---------------------------------------------------------------------------
   Stage-8.7.3: контракт DOM-гигиены оверлея.
   Регресс из #204: модуль вызывал host.replaceChildren(...) и стирал разметку
   хоста. На /planet-globe/ хостом была вся сцена #localMapStage, поэтому
   вместе с оверлеем исчезали канвас, шапка, кнопка «← На глобус планеты»,
   селектор ширины, «Соседи Patch7» и HUD — возврат на планетарный уровень
   становился невозможен. Тест поднимает минимальный fake DOM и проверяет,
   что чужие узлы хоста переживают создание и освобождение оверлея.
--------------------------------------------------------------------------- */

function createFakeDocument() {
  class FakeStyle {
    constructor() { this.props = new Map(); }
    setProperty(name, value, priority = '') { this.props.set(name, { value, priority }); }
    getPropertyValue(name) { return this.props.get(name)?.value ?? ''; }
    getPropertyPriority(name) { return this.props.get(name)?.priority ?? ''; }
    removeProperty(name) { this.props.delete(name); }
  }

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.ownerDocument = doc;
      this.children = [];
      this.parentElement = null;
      this.style = new FakeStyle();
      this.dataset = {};
      this.className = '';
      this.textContent = '';
      this.attributes = new Map();
      this.listeners = new Map();
      const self = this;
      this.classList = {
        add(name) { self.className = `${self.className} ${name}`.trim(); },
        remove(name) { self.className = self.className.split(/\s+/).filter((token) => token && token !== name).join(' '); },
        contains(name) { return self.className.split(/\s+/).includes(name); },
      };
    }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) {
      for (const node of nodes) {
        if (node.parentElement) node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    remove() {
      if (!this.parentElement) return;
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
      this.parentElement = null;
    }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type) { this.listeners.delete(type); }
    closest() { return null; }
  }

  class FakeButtonElement extends FakeElement {}

  const doc = {
    createElement(tag) { return tag.toLowerCase() === 'button' ? new FakeButtonElement(tag) : new FakeElement(tag); },
    createElementNS(_namespace, tag) { return new FakeElement(tag); },
  };
  doc.defaultView = {
    Element: FakeElement,
    HTMLButtonElement: FakeButtonElement,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance: { now: () => 1000 },
  };
  return doc;
}

test('quick-nav: оверлей не стирает содержимое хоста (регресс #204)', () => {
  const doc = createFakeDocument();
  const host = doc.createElement('div');
  const canvas = doc.createElement('canvas');
  const exitButton = doc.createElement('button');
  host.append(canvas, exitButton);

  const nav = QuickNav.createLocalMapQuickNav(host, () => {});
  assert.ok(host.children.includes(canvas), 'канвас локал-карты исчез при создании оверлея');
  assert.ok(host.children.includes(exitButton), 'кнопка «На глобус планеты» исчезла при создании оверлея');
  assert.ok(host.children.some((child) => child.classList.contains('lmqn-layer')), 'слой стрелок не добавлен');

  nav.update([{ slot: 0, cell: 100, x: 10, y: 20, angleRad: 0 }], true);
  assert.ok(host.children.includes(canvas), 'канвас исчез после первого update');
  assert.ok(host.children.includes(exitButton), 'кнопка выхода исчезла после первого update');

  nav.dispose();
  assert.deepEqual(host.children, [canvas, exitButton], 'после dispose в хосте остались лишние узлы или пропала разметка');
  assert.equal(host.style.getPropertyValue('position'), '', 'dispose не восстановил инлайновые стили хоста');
  assert.equal(host.getAttribute('data-local-map-quick-nav-host'), null);
});

test('quick-nav: модуль не заменяет содержимое хоста целиком', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../site/planet-globe/local-map-quick-nav.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('host.replaceChildren'), 'модуль снова стирает разметку хоста через host.replaceChildren');
});

test('quick-nav: страница передаёт модулю отдельный слой, а не сцену локал-карты', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../site/planet-globe/planet-globe.ts', import.meta.url), 'utf8');
  assert.ok(!source.includes('createLocalMapQuickNav(els.localMapStage'), 'хостом оверлея снова стала вся сцена #localMapStage');
  assert.match(source, /localMapQuickNavHost/, 'страница не хранит собственный слой оверлея');
});
