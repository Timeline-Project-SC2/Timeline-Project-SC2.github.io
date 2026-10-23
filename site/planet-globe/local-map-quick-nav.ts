export interface QuickNavHintInput {
  readonly slot: number;      // 0..5, совпадает с data-slot кнопок #localNeighborNav
  readonly cell: number;      // канонический индекс соседнего гекса
  readonly x: number;         // CSS px, середина грани на канвасе #localMapCanvas
  readonly y: number;
  readonly angleRad: number;  // экранный угол нормали грани «наружу», 0 = вправо (+X)
}

export interface LocalMapQuickNav {
  update(hints: readonly QuickNavHintInput[], visible: boolean): void;
  dispose(): void;
}

export const QUICK_NAV_CYCLE_MS = 7200;

const QUICK_NAV_VISIBLE_WINDOW_MS = 2600;
const QUICK_NAV_SLOT_DELAY_MS = 90;
const QUICK_NAV_FADE_IN_MS = 180;
const QUICK_NAV_FADE_OUT_MS = 260;
const QUICK_NAV_SLOT_COUNT = 6;
const QUICK_NAV_HOST_ATTRIBUTE = 'data-local-map-quick-nav-host';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const QUICK_NAV_STYLES = `
[${QUICK_NAV_HOST_ATTRIBUTE}] {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: visible;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] *,
[${QUICK_NAV_HOST_ATTRIBUTE}] {
  pointer-events: none;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-layer {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-button {
  position: absolute;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  width: 48px;
  height: 48px;
  min-width: 44px;
  min-height: 44px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: #00ff66;
  background: radial-gradient(circle, rgba(0, 20, 8, 0.34), rgba(0, 14, 6, 0.12) 28%, transparent 72%);
  opacity: 0;
  visibility: hidden;
  pointer-events: auto;
  touch-action: manipulation;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-button:disabled {
  cursor: default;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-button:focus-visible {
  outline: 1px solid rgba(132, 255, 178, 0.95);
  outline-offset: 1px;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-button::before {
  position: absolute;
  inset: 8px;
  border: 1px solid rgba(0, 255, 102, 0.38);
  border-radius: 50%;
  content: '';
  pointer-events: none;
  animation: lmqn-pulse 2.4s ease-in-out infinite;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-glyph {
  display: block;
  width: 30px;
  height: 32px;
  overflow: visible;
  shape-rendering: geometricPrecision;
  pointer-events: none;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-chevron-outline {
  fill: none;
  stroke: rgba(0, 23, 9, 0.96);
  stroke-width: 3.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-chevron {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  mix-blend-mode: screen;
  filter: drop-shadow(0 0 2px rgba(0, 255, 102, 0.95))
    drop-shadow(0 0 7px rgba(0, 255, 102, 0.62));
}
[${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-scanline {
  position: absolute;
  top: 10px;
  left: 50%;
  width: 1px;
  height: 28px;
  background: linear-gradient(180deg, transparent, rgba(183, 255, 211, 0.88), transparent);
  opacity: 0;
  pointer-events: none;
  animation: lmqn-scan 1.8s ease-in-out infinite;
}
@keyframes lmqn-pulse {
  0%, 100% { opacity: 0.04; transform: scale(0.84); }
  50% { opacity: 0.18; transform: scale(1.02); }
}
@keyframes lmqn-scan {
  0%, 100% { opacity: 0; transform: translate(-50%, -6px); }
  25%, 75% { opacity: 0.24; }
  50% { opacity: 0.48; transform: translate(-50%, 6px); }
}
@media (prefers-reduced-motion: reduce) {
  [${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-button::before {
    display: none !important;
    animation: none !important;
  }
  [${QUICK_NAV_HOST_ATTRIBUTE}] .lmqn-scanline {
    display: none !important;
    animation: none !important;
  }
}
`;

function collectValidHints(hints: readonly QuickNavHintInput[]): QuickNavHintInput[] {
  const hintsBySlot = new Map<number, QuickNavHintInput>();
  for (const hint of hints) {
    if (!Number.isInteger(hint.slot) || hint.slot < 0 || hint.slot >= QUICK_NAV_SLOT_COUNT) continue;
    if (!Number.isInteger(hint.cell) || hint.cell < 0) continue;
    if (!Number.isFinite(hint.x) || !Number.isFinite(hint.y) || !Number.isFinite(hint.angleRad)) continue;
    if (!hintsBySlot.has(hint.slot)) {
      hintsBySlot.set(hint.slot, {
        slot: hint.slot,
        cell: hint.cell,
        x: hint.x,
        y: hint.y,
        angleRad: hint.angleRad,
      });
    }
  }
  return [...hintsBySlot.values()].sort((left, right) => left.slot - right.slot);
}

function phaseInCycle(timeMs: number, cycleMs: number): number {
  return ((timeMs % cycleMs) + cycleMs) % cycleMs;
}

function opacityAt(slot: number, cycleMs: number, nowMs: number): number {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0 || !Number.isFinite(nowMs)) return 0;

  const windowMs = Math.min(QUICK_NAV_VISIBLE_WINDOW_MS, cycleMs);
  const fadeInMs = Math.min(QUICK_NAV_FADE_IN_MS, windowMs / 2);
  const fadeOutMs = Math.min(QUICK_NAV_FADE_OUT_MS, windowMs - fadeInMs);
  const phaseMs = phaseInCycle(nowMs - slot * QUICK_NAV_SLOT_DELAY_MS, cycleMs);
  if (phaseMs >= windowMs) return 0;
  if (phaseMs < fadeInMs) return phaseMs / fadeInMs;

  const fadeOutStartMs = windowMs - fadeOutMs;
  if (phaseMs >= fadeOutStartMs) return (windowMs - phaseMs) / fadeOutMs;
  return 1;
}

export function layoutQuickNavArrows(
  hints: readonly QuickNavHintInput[],
  cycleMs: number,
  nowMs: number,
): ReadonlyArray<{ slot: number; cell: number; x: number; y: number; angleRad: number; opacity: number }> {
  return collectValidHints(hints).map((hint) => ({
    slot: hint.slot,
    cell: hint.cell,
    x: hint.x,
    y: hint.y,
    angleRad: hint.angleRad,
    opacity: opacityAt(hint.slot, cycleMs, nowMs),
  }));
}

export function createLocalMapQuickNav(
  host: HTMLElement,
  onPick: (slot: number, cell: number) => void,
): LocalMapQuickNav {
  const document = host.ownerDocument;
  const documentView = document.defaultView;
  if (documentView === null) throw new Error('LocalMapQuickNav requires a browser document.');
  const view: NonNullable<typeof documentView> = documentView;

  const originalHostAttribute = host.getAttribute(QUICK_NAV_HOST_ATTRIBUTE);
  const hostStyleProperties = ['position', 'inset', 'z-index', 'overflow', 'pointer-events'] as const;
  const originalHostStyles = hostStyleProperties.map((name) => ({
    name,
    value: host.style.getPropertyValue(name),
    priority: host.style.getPropertyPriority(name),
  }));

  host.setAttribute(QUICK_NAV_HOST_ATTRIBUTE, '');
  host.style.setProperty('position', 'absolute');
  host.style.setProperty('inset', '0');
  host.style.setProperty('z-index', '2');
  host.style.setProperty('overflow', 'visible');
  host.style.setProperty('pointer-events', 'none');

  const styleElement = document.createElement('style');
  styleElement.textContent = QUICK_NAV_STYLES;
  const layer = document.createElement('div');
  layer.className = 'lmqn-layer';
  layer.setAttribute('aria-hidden', 'true');

  const buttons = new Map<number, HTMLButtonElement>();
  let currentHints: QuickNavHintInput[] = [];
  let isVisible = false;
  let disposed = false;
  let frameHandle: number | null = null;

  for (let slot = 0; slot < QUICK_NAV_SLOT_COUNT; slot++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lmqn-button';
    button.dataset.slot = String(slot);
    button.setAttribute('aria-label', `Перейти к соседнему гексу ${slot + 1}`);
    button.disabled = true;
    button.tabIndex = -1;
    button.style.visibility = 'hidden';
    button.style.opacity = '0';

    const glyph = document.createElementNS(SVG_NAMESPACE, 'svg');
    glyph.classList.add('lmqn-glyph');
    glyph.setAttribute('viewBox', '0 0 28 32');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.setAttribute('focusable', 'false');
    for (const pathData of ['M 4 5 L 14 16 L 4 27', 'M 11 5 L 21 16 L 11 27']) {
      const outline = document.createElementNS(SVG_NAMESPACE, 'path');
      outline.classList.add('lmqn-chevron-outline');
      outline.setAttribute('d', pathData);
      glyph.append(outline);

      const path = document.createElementNS(SVG_NAMESPACE, 'path');
      path.classList.add('lmqn-chevron');
      path.setAttribute('d', pathData);
      glyph.append(path);
    }

    const scanline = document.createElement('span');
    scanline.className = 'lmqn-scanline';
    scanline.setAttribute('aria-hidden', 'true');
    button.append(glyph, scanline);
    layer.append(button);
    buttons.set(slot, button);

  }

  const clickListener = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof view.Element)) return;
    const button = target.closest('button.lmqn-button');
    if (!(button instanceof view.HTMLButtonElement) || button.parentElement !== layer) return;

    const slot = Number(button.dataset.slot);
    if (!Number.isInteger(slot) || disposed || !isVisible || button.disabled) return;
    const hint = currentHints.find((candidate) => candidate.slot === slot);
    if (hint === undefined) return;

    event.preventDefault();
    event.stopPropagation();
    onPick(slot, hint.cell);
  };
  layer.addEventListener('click', clickListener);

  host.replaceChildren(styleElement, layer);

  function hideButtons(): void {
    layer.setAttribute('aria-hidden', 'true');
    for (const button of buttons.values()) {
      button.disabled = true;
      button.tabIndex = -1;
      button.style.opacity = '0';
      button.style.visibility = 'hidden';
    }
  }

  function cancelFrame(): void {
    if (frameHandle === null) return;
    view.cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }

  function render(nowMs: number): void {
    if (disposed || !isVisible || currentHints.length === 0) {
      hideButtons();
      return;
    }

    const arrows = layoutQuickNavArrows(currentHints, QUICK_NAV_CYCLE_MS, nowMs);
    const arrowsBySlot = new Map<number, (typeof arrows)[number]>();
    for (const arrow of arrows) arrowsBySlot.set(arrow.slot, arrow);
    layer.setAttribute('aria-hidden', 'false');

    for (const [slot, button] of buttons) {
      const arrow = arrowsBySlot.get(slot);
      if (arrow === undefined || arrow.opacity <= 0) {
        button.disabled = true;
        button.tabIndex = -1;
        button.style.opacity = '0';
        button.style.visibility = 'hidden';
        continue;
      }

      button.dataset.cell = String(arrow.cell);
      button.style.left = `${arrow.x}px`;
      button.style.top = `${arrow.y}px`;
      button.style.transform = `translate(-50%, -50%) rotate(${arrow.angleRad}rad)`;
      button.style.opacity = String(arrow.opacity);
      button.style.visibility = 'visible';
      button.disabled = false;
      button.tabIndex = 0;
    }
  }

  function scheduleFrame(): void {
    if (disposed || !isVisible || currentHints.length === 0 || frameHandle !== null) return;
    frameHandle = view.requestAnimationFrame((nowMs) => {
      frameHandle = null;
      render(nowMs);
      scheduleFrame();
    });
  }

  function update(hints: readonly QuickNavHintInput[], visible: boolean): void {
    if (disposed) return;
    currentHints = collectValidHints(hints);
    isVisible = visible && currentHints.length > 0;
    if (!isVisible) {
      cancelFrame();
      hideButtons();
      return;
    }

    render(view.performance.now());
    scheduleFrame();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    isVisible = false;
    currentHints = [];
    cancelFrame();
    hideButtons();
    layer.removeEventListener('click', clickListener);
    buttons.clear();
    host.replaceChildren();

    if (originalHostAttribute === null) host.removeAttribute(QUICK_NAV_HOST_ATTRIBUTE);
    else host.setAttribute(QUICK_NAV_HOST_ATTRIBUTE, originalHostAttribute);
    for (const { name, value, priority } of originalHostStyles) {
      if (value === '') host.style.removeProperty(name);
      else host.style.setProperty(name, value, priority);
    }
  }

  return { update, dispose };
}
