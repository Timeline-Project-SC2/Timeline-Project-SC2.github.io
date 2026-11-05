/* Цвет и стиль состояния области: фракция → режим → задача (§2.2, §2.3, §3.1).
 *
 * Порядок наложения: базовый цвет фракции из `data/factions.csv` → преобразование
 * режима (акцент, свечение, пунктир) → задача (пунктир, толщина, прозрачность).
 * Задача меняет стиль, но **не отменяет** фракцию. Для тёмной карты есть
 * `stroke-safe` вариант с ограниченной светлотой.
 *
 * Ядро не читает файлы: палитру собирает вызывающий код (тест — из CSV,
 * страница — из уже загруженного снимка данных).
 */

import { parseHexColor } from './config.ts';
import type { Rgb } from './sector-gradient.ts';
import type { AreaState, Mode, TaskKind } from './sector-areas-contract.ts';

export type { Rgb };

/** Цвет строки «—» таблицы фракций: нейтральный серо-голубой. */
export const NEUTRAL_COLOR = '#dfe7f2';

const NEUTRAL_RGB: Rgb = [223, 231, 242];

export interface FactionEntry {
  readonly name: string;
  readonly color: string;
}

export interface FactionPalette {
  readonly names: readonly string[];
  readonly entries: readonly FactionEntry[];
  /** Цвет фракции; неизвестное имя даёт нейтральный цвет, а не ошибку. */
  readonly colorOf: (name: string | null | undefined) => Rgb;
  readonly cssOf: (name: string | null | undefined) => string;
  readonly has: (name: string | null | undefined) => boolean;
}

/** Собирает палитру из строк `data/factions.csv` (колонки `faction`,`color`). */
export function createFactionPalette(entries: readonly FactionEntry[]): FactionPalette {
  const byName = new Map<string, Rgb>();
  for (const entry of entries) {
    const rgb = parseHexColor(entry.color);
    if (rgb === null) continue;
    byName.set(entry.name, [rgb[0], rgb[1], rgb[2]]);
  }
  const colorOf = (name: string | null | undefined): Rgb => {
    if (name === null || name === undefined) return NEUTRAL_RGB;
    return byName.get(name) ?? NEUTRAL_RGB;
  };
  return {
    names: [...byName.keys()],
    entries,
    colorOf,
    cssOf: (name: string | null | undefined) => toCss(colorOf(name)),
    has: (name: string | null | undefined) => name !== null && name !== undefined && byName.has(name),
  };
}

/** Минимальный разбор CSV фракций: первая строка — заголовок. */
export function parseFactionCsv(csv: string): readonly FactionEntry[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];
  const header = lines[0]!.split(',').map((cell) => cell.trim());
  const nameIndex = header.indexOf('faction');
  const colorIndex = header.indexOf('color');
  if (nameIndex < 0 || colorIndex < 0) return [];

  const entries: FactionEntry[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const name = cells[nameIndex]?.trim() ?? '';
    const color = cells[colorIndex]?.trim() ?? '';
    if (name.length === 0 || !/^#[0-9a-f]{6}$/i.test(color)) continue;
    entries.push({ name, color: color.toLowerCase() });
  }
  return entries;
}

/* --------------------------------------------------------------- арифметика */

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

export function toCss(rgb: Rgb, alpha = 1): string {
  const a = clamp01(alpha);
  return a >= 1
    ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
    : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`;
}

export function rgbToHsl(rgb: Rgb): readonly [number, number, number] {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
  else if (max === g) hue = ((b - r) / delta + 2) / 6;
  else hue = ((r - g) / delta + 4) / 6;
  return [hue, saturation, lightness];
}

export function hslToRgb(hsl: readonly [number, number, number]): Rgb {
  const [h, s, l] = hsl;
  if (s === 0) {
    const value = Math.round(l * 255);
    return [value, value, value];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(channel(h + 1 / 3) * 255), Math.round(channel(h) * 255), Math.round(channel(h - 1 / 3) * 255)];
}

export function lighten(rgb: Rgb, amount: number): Rgb {
  const hsl = rgbToHsl(rgb);
  return hslToRgb([hsl[0], hsl[1], clamp01(hsl[2] + amount)]);
}

/**
 * `stroke-safe` вариант для тёмной карты: светлота ограничивается порогом,
 * тональность и насыщенность сохраняются.
 */
export function strokeSafeColor(rgb: Rgb, maxLightness = 0.72): Rgb {
  const hsl = rgbToHsl(rgb);
  const limit = clamp01(maxLightness);
  if (hsl[2] <= limit) return rgb;
  return hslToRgb([hsl[0], hsl[1], limit]);
}

/* ------------------------------------------------------------------- режимы */

export type StateAnimation = 'glow' | 'bursts' | 'pulses' | 'jitter';

export interface ModeStyle {
  /** Акцент режима; `null` — режим не подмешивает отдельный цвет. */
  readonly accent: Rgb | null;
  readonly accentWeight: number;
  readonly glow: number;
  readonly dash: readonly number[];
  readonly width: number;
  readonly alpha: number;
  readonly animation: StateAnimation;
}

/** Таблица режимов из §2.3 части 1. */
export const MODE_STYLES: Readonly<Record<Mode, ModeStyle>> = Object.freeze({
  political: Object.freeze({ accent: null, accentWeight: 0, glow: 0.35, dash: Object.freeze([]), width: 1, alpha: 1, animation: 'glow' }),
  military: Object.freeze({ accent: Object.freeze([255, 157, 46]) as Rgb, accentWeight: 0.45, glow: 0.5, dash: Object.freeze([]), width: 1.25, alpha: 1, animation: 'bursts' }),
  economy: Object.freeze({ accent: null, accentWeight: 0, glow: 0.15, dash: Object.freeze([10, 8]), width: 0.9, alpha: 0.9, animation: 'pulses' }),
  tension: Object.freeze({ accent: Object.freeze([255, 74, 58]) as Rgb, accentWeight: 0.5, glow: 0.6, dash: Object.freeze([4, 3, 10, 3]), width: 1.15, alpha: 1, animation: 'jitter' }),
});

export function modeStyle(mode: Mode): ModeStyle {
  return MODE_STYLES[mode] ?? MODE_STYLES.political;
}

/* -------------------------------------------------------------------- задачи */

export interface TaskStyle {
  readonly dash: readonly number[];
  readonly width: number;
  readonly alpha: number;
}

/** Задача меняет только стиль линии: пунктир, толщину и прозрачность. */
export const TASK_STYLES: Readonly<Record<TaskKind, TaskStyle>> = Object.freeze({
  none: Object.freeze({ dash: Object.freeze([]), width: 1, alpha: 1 }),
  patrol: Object.freeze({ dash: Object.freeze([12, 6]), width: 1, alpha: 0.95 }),
  siege: Object.freeze({ dash: Object.freeze([3, 4]), width: 1.4, alpha: 1 }),
  trade: Object.freeze({ dash: Object.freeze([16, 10]), width: 0.9, alpha: 0.85 }),
  raid: Object.freeze({ dash: Object.freeze([6, 3, 2, 3]), width: 1.1, alpha: 0.95 }),
  blockade: Object.freeze({ dash: Object.freeze([2, 6]), width: 1.6, alpha: 1 }),
});

export function taskStyle(task: TaskKind): TaskStyle {
  return TASK_STYLES[task] ?? TASK_STYLES.none;
}

/* --------------------------------------------------------------------- стиль */

export interface StateStyleOptions {
  readonly palette?: FactionPalette;
  /** Ограничить светлоту для тёмной карты. */
  readonly strokeSafe?: boolean;
  readonly maxLightness?: number;
  /** Доля заливки относительно цвета границы. */
  readonly fillAlpha?: number;
}

export interface StateStyle {
  readonly base: Rgb;
  readonly fill: Rgb;
  readonly stroke: Rgb;
  readonly accent: Rgb | null;
  readonly glow: number;
  readonly dash: readonly number[];
  readonly width: number;
  readonly alpha: number;
  readonly fillAlpha: number;
  readonly animation: StateAnimation;
  readonly mode: Mode;
}

/** Итоговый стиль состояния: фракция → режим → задача. */
export function stateStyle(state: AreaState, options: StateStyleOptions = {}): StateStyle {
  const palette = options.palette;
  const mode = modeStyle(state.mode);
  const task = taskStyle(state.task);

  const first = state.factionIds[0] ?? null;
  const second = state.factionIds[1] ?? null;
  const base = state.factionMode === 'neutral' || palette === undefined
    ? NEUTRAL_RGB
    : palette.colorOf(first);
  const partner = state.factionMode === 'pair' && palette !== undefined && second !== null
    ? palette.colorOf(second)
    : null;

  const withAccent = mode.accent === null
    ? base
    : mixRgb(base, mode.accent, mode.accentWeight);

  const safe = (rgb: Rgb): Rgb => (options.strokeSafe === true
    ? strokeSafeColor(rgb, options.maxLightness ?? 0.72)
    : rgb);

  const stroke = safe(withAccent);
  const fillAlpha = clamp01(options.fillAlpha ?? 1) * mode.alpha * task.alpha;

  return {
    base,
    fill: safe(mode.accent === null && state.mode === 'economy' ? lighten(base, 0.12) : mixRgb(withAccent, base, 0.35)),
    stroke,
    accent: mode.accent === null ? (partner === null ? null : safe(partner)) : safe(mode.accent),
    glow: mode.glow,
    dash: task.dash.length > 0 ? task.dash : mode.dash,
    width: mode.width * task.width,
    alpha: clamp01(mode.alpha * task.alpha),
    fillAlpha,
    animation: mode.animation,
    mode: state.mode,
  };
}

/* --------------------------------------------------------------- фокус-режим */

export type FocusBehavior = 'dim' | 'hide';

export interface FocusSettings {
  /** `dim` — приглушать остальные режимы; `hide` — скрывать. */
  readonly behavior: FocusBehavior;
  readonly dimAlpha: number;
}

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = Object.freeze({
  behavior: 'dim',
  dimAlpha: 0.28,
});

export interface FocusAppearance {
  readonly visible: boolean;
  readonly alpha: number;
  readonly emphasis: boolean;
}

/**
 * Как показывать состояние в фокус-режиме. Фокус-режим — линза, а не фильтр
 * данных: при `hide` состояние лишь не рисуется, но остаётся в JSON и журнале.
 */
export function focusAppearance(
  mode: Mode,
  activeMode: Mode | null,
  settings: FocusSettings = DEFAULT_FOCUS_SETTINGS,
): FocusAppearance {
  if (activeMode === null) return { visible: true, alpha: 1, emphasis: false };
  if (mode === activeMode) return { visible: true, alpha: 1, emphasis: true };
  return settings.behavior === 'hide'
    ? { visible: false, alpha: 0, emphasis: false }
    : { visible: true, alpha: clamp01(settings.dimAlpha), emphasis: false };
}
