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
  const hintsBySlot = new Map<number, QuickNavHintInput>();
  for (const hint of hints) {
    if (!Number.isInteger(hint.slot) || hint.slot < 0 || hint.slot >= QUICK_NAV_SLOT_COUNT) continue;
    if (!Number.isInteger(hint.cell) || hint.cell < 0) continue;
    if (!Number.isFinite(hint.x) || !Number.isFinite(hint.y) || !Number.isFinite(hint.angleRad)) continue;
    if (!hintsBySlot.has(hint.slot)) hintsBySlot.set(hint.slot, hint);
  }

  return [...hintsBySlot.values()]
    .sort((left, right) => left.slot - right.slot)
    .map((hint) => ({
      slot: hint.slot,
      cell: hint.cell,
      x: hint.x,
      y: hint.y,
      angleRad: hint.angleRad,
      opacity: opacityAt(hint.slot, cycleMs, nowMs),
    }));
}
