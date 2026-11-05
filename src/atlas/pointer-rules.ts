/* Правила ввода карты: что принадлежит карте, а что — интерфейсу поверх неё.
 *
 * Панели (каталог, карточка, редактор) лежат **внутри** `.map-stage`, поэтому
 * любой перехватчик на стадии видит их события первым. Если глушить всё
 * подряд, органы панели перестают нажиматься: `preventDefault()` на
 * `pointerdown` отменяет совместимые события мыши, в том числе `click`.
 * Отсюда правило, общее для всех жестов карты:
 *
 * 1. жест начинается только на канве карты;
 * 2. нажатие по органу интерфейса карте не принадлежит никогда;
 * 3. жест начинает только основная левая кнопка.
 *
 * Проверки написаны структурно (через `parentElement` и `closest`), а не через
 * `instanceof Node`: так их можно покрыть тестами без DOM.
 */

/** Органы интерфейса: их нажатие карте не принадлежит. */
export const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, label, summary, [role="button"], [contenteditable="true"], [data-editor-ui]';

interface EventLike {
  readonly target?: unknown;
}

interface ParentedNode {
  readonly parentElement?: unknown;
}

interface ClosableNode {
  closest?(selector: string): unknown;
}

function parentOf(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return null;
  const parent = (node as ParentedNode).parentElement;
  return parent === undefined ? null : parent;
}

/** Цель — сам элемент или его потомок. Обход идёт вверх по `parentElement`. */
export function isInside(target: unknown, root: unknown): boolean {
  if (root === null || root === undefined || target === null || target === undefined) return false;
  if (target === root) return true;
  let current = parentOf(target);
  let steps = 0;
  // Ограничение шагов: страховка от кольцевой или очень глубокой структуры.
  while (current !== null && current !== undefined && steps < 64) {
    if (current === root) return true;
    current = parentOf(current);
    steps += 1;
  }
  return false;
}

/** Цель — орган интерфейса (кнопка, поле, ссылка и тому подобное). */
export function isInteractiveTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const node = target as ClosableNode;
  if (typeof node.closest !== 'function') return false;
  return node.closest(INTERACTIVE_SELECTOR) !== null;
}

/** Основная левая кнопка: правая и средняя остаются карте. */
export function isDrawButton(button: number): boolean {
  return button === 0;
}

export interface StrokePointerEvent extends EventLike {
  readonly button: number;
  readonly isPrimary?: boolean;
}

/**
 * Можно ли начинать жест рисования по этому событию.
 * Рисование включено — но это ещё не поведение перехватывать интерфейс.
 */
export function canStartStroke(event: StrokePointerEvent, canvas: unknown): boolean {
  if (!isDrawButton(event.button)) return false;
  if (event.isPrimary === false) return false;
  if (!isInside(event.target, canvas)) return false;
  return !isInteractiveTarget(event.target);
}

/**
 * Можно ли продолжать жест: во время штриха `move`/`up` перехватываются даже
 * за пределами канвы (есть захват указателя), но не на органах интерфейса.
 */
export function canContinueStroke(event: EventLike): boolean {
  return !isInteractiveTarget(event.target);
}
