export type LadderFrame = 'S' | 'O';

export interface LevelSpec {
  readonly level: number;
  readonly id: string;
  readonly frame: LadderFrame;
  readonly visibleWidth: number;
  readonly addressLetters: 0 | 1 | 2 | 3 | 4 | 5;
  readonly markerPx: number;
  readonly frameBudgetMs: number;
}

export const LEVELS: readonly LevelSpec[] = Object.freeze([
  Object.freeze({
    level: 0,
    id: 'L0',
    frame: 'S',
    visibleWidth: 10000,
    addressLetters: 0,
    markerPx: 2.5,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 1,
    id: 'L1',
    frame: 'S',
    visibleWidth: 5000,
    addressLetters: 1,
    markerPx: 3.3,
    frameBudgetMs: 8,
  }),
  Object.freeze({
    level: 2,
    id: 'L2',
    frame: 'S',
    visibleWidth: 2500,
    addressLetters: 2,
    markerPx: 4.5,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 3,
    id: 'L3',
    frame: 'S',
    visibleWidth: 1250,
    addressLetters: 2,
    markerPx: 6.0,
    frameBudgetMs: 10,
  }),
  Object.freeze({
    level: 4,
    id: 'L4',
    frame: 'S',
    visibleWidth: 625,
    addressLetters: 3,
    markerPx: 8.0,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 5,
    id: 'L5',
    frame: 'S',
    visibleWidth: 312.5,
    addressLetters: 3,
    markerPx: 10.7,
    frameBudgetMs: 12,
  }),
  Object.freeze({
    level: 6,
    id: 'L6',
    frame: 'S',
    visibleWidth: 156.25,
    addressLetters: 4,
    markerPx: 14.3,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 7,
    id: 'L7',
    frame: 'S',
    visibleWidth: 78.125,
    addressLetters: 4,
    markerPx: 19.2,
    frameBudgetMs: 14,
  }),
  Object.freeze({
    level: 8,
    id: 'L8',
    frame: 'S',
    visibleWidth: 39.0625,
    addressLetters: 5,
    markerPx: 25.7,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 9,
    id: 'L9',
    frame: 'S',
    visibleWidth: 19.53125,
    addressLetters: 5,
    markerPx: 34.3,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 10,
    id: 'S0',
    frame: 'O',
    visibleWidth: 100,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 11,
    id: 'S1',
    frame: 'O',
    visibleWidth: 16,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
  Object.freeze({
    level: 12,
    id: 'S2',
    frame: 'O',
    visibleWidth: 2,
    addressLetters: 5,
    // Системный кадр не использует секторный маркер.
    markerPx: 0,
    frameBudgetMs: 16,
  }),
]);

export const MAX_VISIBLE_WIDTH = 10000;
export const MIN_VISIBLE_WIDTH = 16000;
export const HYSTERESIS = 0.12;

export function levelSpec(level: number): LevelSpec {
  const spec = LEVELS[level];
  if (spec === undefined) {
    throw new RangeError(`Уровень вне лестницы глубины: ${level}`);
  }

  return spec;
}

export function frameOf(level: number): LadderFrame {
  return levelSpec(level).frame;
}

export function visibleWidthForLevel(level: number): number {
  return levelSpec(level).visibleWidth;
}

export function levelForWidth(visibleWidth: number, prev?: number): number {
  if (Number.isNaN(visibleWidth)) {
    throw new RangeError('Ширина кадра должна быть числом');
  }

  let rawLevel: number;
  if (visibleWidth >= MAX_VISIBLE_WIDTH) {
    rawLevel = 0;
  } else if (visibleWidth <= visibleWidthForLevel(9)) {
    rawLevel = 9;
  } else {
    rawLevel = Math.max(
      0,
      Math.min(
        9,
        Math.floor(Math.log2(MAX_VISIBLE_WIDTH / visibleWidth) + 1e-9),
      ),
    );
  }

  if (prev === undefined) {
    return rawLevel;
  }
  if (!Number.isInteger(prev) || prev < 0 || prev > 9) {
    throw new RangeError(`Секторный уровень вне диапазона 0…9: ${prev}`);
  }

  if (rawLevel > prev) {
    const nextLevel = prev + 1;
    const enterThreshold = visibleWidthForLevel(nextLevel) * (1 - HYSTERESIS);
    return visibleWidth <= enterThreshold ? nextLevel : prev;
  }

  if (rawLevel < prev) {
    const leaveThreshold = visibleWidthForLevel(prev) * (1 + HYSTERESIS);
    return visibleWidth >= leaveThreshold ? prev - 1 : prev;
  }

  return rawLevel;
}

export function markerDiameter(visibleWidth: number): number {
  if (Number.isNaN(visibleWidth) || visibleWidth < 0) {
    throw new RangeError('Ширина кадра для маркера не может быть отрицательной');
  }

  const diameter = 2.5 * (MAX_VISIBLE_WIDTH / visibleWidth) ** 0.42;
  return Math.max(2.5, Math.min(40, diameter));
}
