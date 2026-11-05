/* Правила ввода карты (шаг 2, приёмка).
 *
 * Панели лежат внутри `.map-stage`, поэтому перехватчик на стадии видит их
 * события первым. Правила должны пропускать органы интерфейса и чужие кнопки,
 * иначе клики по панели перестают работать (справка открывалась только с
 * шифтом — ровно этот случай).
 * Запуск: node --test tests/pointer-rules.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  INTERACTIVE_SELECTOR,
  canContinueStroke,
  canStartStroke,
  isDrawButton,
  isInside,
  isInteractiveTarget,
} from '../src/atlas/pointer-rules.ts';

/** Узел-заглушка: ровно те поля, которыми пользуются правила. */
function node(options = {}) {
  return {
    parent: options.parent ?? null,
    closestResult: options.closest ?? null,
    get parentElement() { return this.parent; },
    closest(selector) { return this.closestResult === null ? null : { selector, found: this.closestResult }; },
  };
}

const canvas = node();
const panel = node({ parent: null });
const button = node({ parent: panel });
const helpButton = node({ parent: panel, closest: 'button' });

test('вложенность считается вверх по parentElement, без DOM-классов', () => {
  assert.equal(isInside(button, panel), true);
  assert.equal(isInside(panel, panel), true);
  assert.equal(isInside(panel, canvas), false);
  assert.equal(isInside(null, canvas), false);
  assert.equal(isInside(button, null), false);
});

test('глубокая и кольцевая структура не роняет проверку', () => {
  const deep = node();
  let current = deep;
  for (let i = 0; i < 200; i += 1) {
    const parent = node();
    current.parent = parent;
    current = parent;
  }
  assert.equal(isInside(deep, current), false, 'глубже 64 шагов — считаем, что не внутри');

  const a = node();
  const b = node({ parent: a });
  a.parent = b; // кольцо
  assert.equal(isInside(b, node()), false);
});

test('орган интерфейса вычисляется по closest, а не по тегу', () => {
  assert.equal(isInteractiveTarget(helpButton), true);
  assert.equal(isInteractiveTarget(button), false);
  assert.equal(isInteractiveTarget(null), false);
  assert.equal(isInteractiveTarget({}), false, 'без closest — не орган');
  assert.match(INTERACTIVE_SELECTOR, /button/);
  assert.match(INTERACTIVE_SELECTOR, /input/);
});

test('рисовать разрешено только основной левой кнопке', () => {
  assert.equal(isDrawButton(0), true);
  assert.equal(isDrawButton(1), false);
  assert.equal(isDrawButton(2), false);
});

test('жест начинается на канве и не начинается на панели', () => {
  assert.equal(canStartStroke({ button: 0, isPrimary: true, target: canvas }, canvas), true);
  assert.equal(canStartStroke({ button: 0, isPrimary: true, target: button }, canvas), false,
    'клик по кнопке панели не должен начинать штрих');
  assert.equal(canStartStroke({ button: 0, isPrimary: true, target: helpButton }, canvas), false,
    'кнопка «?» — орган интерфейса, она обязана получить свой клик');
  assert.equal(canStartStroke({ button: 0, isPrimary: true, target: canvas }, null), false);
});

test('жест не начинается правой, средней и неосновной кнопкой', () => {
  assert.equal(canStartStroke({ button: 2, isPrimary: true, target: canvas }, canvas), false);
  assert.equal(canStartStroke({ button: 1, isPrimary: true, target: canvas }, canvas), false);
  assert.equal(canStartStroke({ button: 0, isPrimary: false, target: canvas }, canvas), false);
});

test('продолжение штриха не мешает органам интерфейса', () => {
  assert.equal(canContinueStroke({ target: canvas }), true);
  assert.equal(canContinueStroke({ target: helpButton }), false);
  assert.equal(canContinueStroke({}), true);
});

test('правила применены во вводе редактора', () => {
  const source = readFileSync(new URL('../src/atlas/sector-areas-editor-ui.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ canContinueStroke, canStartStroke/);
  assert.match(source, /if \(!on \|\| !canStartStroke\(event, canvas\)\) return;/);
  assert.match(source, /if \(!on \|\| !drawing \|\| !canContinueStroke\(event\)\) return;/);
  // Перехват остаётся на стадии: она родитель канвы и срабатывает раньше
  // обработчиков панорамы, но теперь — только для событий самой канвы.
  assert.match(source, /const inputTarget: EventTarget \| null = stage \?\? canvas;/);
});
