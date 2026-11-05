/* Градиент границы: `auto` / `custom` / `hybrid` (§6 части 1 плана).
 *
 * Считается по **исходной** ломаной в мировых координатах: у каждой вершины
 * упрощённой геометрии сохраняется параметр исходного пути (`0…1`), поэтому
 * градиент не «плывёт» при панорамировании и смене LOD, а точка `splitAt`
 * остаётся на месте. Замкнутый контур без шва — циклические стопы; с швом —
 * разрыв в выбранной вершине (`seamVertex`).
 */

import { parseHexColor } from './config.ts';
import type { AreaState, FactionMode, GradientDirection, GradientMode, GradientSpec, TaskKind } from './sector-areas-contract.ts';
import { DEFAULT_GRADIENT } from './sector-areas-contract.ts';
import { clamp01, lighten, mixRgb, NEUTRAL_COLOR, stateStyle } from './sector-areas-color.ts';
import type { FactionPalette, Rgb } from './sector-areas-color.ts';
import type { ParametrizedRing } from './sector-areas-geometry.ts';

export interface ResolvedStop {
  readonly offset: number;
  readonly rgb: Rgb;
  readonly alpha: number;
}

export interface ResolvedGradient {
  readonly stops: readonly ResolvedStop[];
  readonly mode: GradientMode;
  /** Точка перехода A→B; `0,5` — середина. */
  readonly splitAt: number;
  readonly direction: GradientDirection;
  /** `true` — замкнутый контур без шва: стопы повторяются по кругу. */
  readonly cyclic: boolean;
  readonly seamVertex: number | null;
}

export interface GradientSample {
  readonly rgb: Rgb;
  readonly alpha: number;
}

export interface GradientContext {
  readonly palette?: FactionPalette;
  readonly factionMode?: FactionMode;
  readonly factionIds?: readonly string[];
  readonly mode?: GradientSpec['mode'];
  readonly task?: TaskKind;
  readonly closed?: boolean;
  /** Акцент режима (милитари — предупреждающий, тэншен — красный). */
  readonly accent?: Rgb | null;
}

function hexToRgb(color: string): Rgb {
  const rgb = parseHexColor(color);
  if (rgb === null) return [223, 231, 242];
  return [rgb[0], rgb[1], rgb[2]];
}

/** Базовые стопы автоматического градиента: фракция, задача и акцент режима. */
export function autoStops(context: GradientContext, splitAt: number): readonly ResolvedStop[] {
  const palette = context.palette;
  const ids = context.factionIds ?? [];
  const factionMode = context.factionMode ?? 'single';
  const task = context.task ?? 'none';
  const accent = context.accent ?? null;

  const neutral: Rgb = hexToRgb(NEUTRAL_COLOR);
  const first = factionMode === 'neutral' || palette === undefined ? neutral : palette.colorOf(ids[0] ?? null);
  const second = factionMode === 'pair' && palette !== undefined ? palette.colorOf(ids[1] ?? null) : null;

  const split = clamp01(splitAt);
  const middle = second === null ? lighten(first, 0.18) : mixRgb(first, second, 0.5);
  const mid = task === 'none' || accent === null ? middle : mixRgb(middle, accent, 0.35);

  if (second !== null) {
    return [
      { offset: 0, rgb: first, alpha: 1 },
      { offset: split, rgb: mid, alpha: 1 },
      { offset: 1, rgb: second, alpha: 1 },
    ];
  }
  return [
    { offset: 0, rgb: first, alpha: 1 },
    { offset: split, rgb: mid, alpha: 1 },
    { offset: 1, rgb: first, alpha: 0.85 },
  ];
}

function normalizeStops(stops: readonly ResolvedStop[]): readonly ResolvedStop[] {
  return [...stops]
    .map((stop) => ({ offset: clamp01(stop.offset), rgb: stop.rgb, alpha: clamp01(stop.alpha) }))
    .sort((a, b) => a.offset - b.offset);
}

function applyOverrides(
  base: readonly ResolvedStop[],
  spec: GradientSpec,
): readonly ResolvedStop[] {
  let stops = [...base];
  for (const entry of spec.overrides) {
    if (entry.index !== null) {
      const target = stops[entry.index];
      if (target === undefined) continue;
      stops[entry.index] = {
        offset: entry.offset ?? target.offset,
        rgb: entry.color === null ? target.rgb : hexToRgb(entry.color),
        alpha: entry.alpha ?? target.alpha,
      };
      continue;
    }
    const position = entry.at ?? entry.offset;
    if (position === null) continue;
    stops.push({
      offset: clamp01(position),
      rgb: entry.color === null ? mixRgb(stops[0]?.rgb ?? [223, 231, 242], stops[stops.length - 1]?.rgb ?? [223, 231, 242], 0.5) : hexToRgb(entry.color),
      alpha: entry.alpha ?? 1,
    });
  }
  stops = [...new Map(stops.map((stop) => [stop.offset.toFixed(6), stop])).values()];
  return normalizeStops(stops);
}

/** Разворачивает спецификацию в готовые стопы; `custom` берёт явные, `hybrid` — базу с правками. */
export function resolveGradient(spec: GradientSpec, context: GradientContext = {}): ResolvedGradient {
  const source = spec ?? DEFAULT_GRADIENT;
  const splitAt = clamp01(source.splitAt ?? 0.5);
  const closed = context.closed ?? false;
  const seam = source.seamVertex ?? null;

  let stops: readonly ResolvedStop[];
  if (source.mode === 'custom') {
    stops = normalizeStops(source.stops.map((stop) => ({
      offset: stop.offset,
      rgb: hexToRgb(stop.color),
      alpha: stop.alpha,
    })));
  } else {
    const base = autoStops(context, splitAt);
    stops = source.mode === 'hybrid' ? applyOverrides(base, source) : normalizeStops(base);
  }

  return {
    stops,
    mode: source.mode,
    splitAt,
    direction: source.direction,
    cyclic: closed && seam === null,
    seamVertex: seam,
  };
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function cyclicStops(stops: readonly ResolvedStop[]): readonly ResolvedStop[] {
  if (stops.length === 0) return stops;
  const last = stops[stops.length - 1]!;
  const first = stops[0]!;
  return [
    { offset: -1, rgb: last.rgb, alpha: last.alpha },
    ...stops,
    { offset: 2, rgb: first.rgb, alpha: first.alpha },
  ];
}

/** Выборка градиента в точке `t` (`0…1`) с учётом направления и смешивания. */
export function sampleGradient(resolved: ResolvedGradient, t: number, blend: GradientSpec['blend'] = 'linear'): GradientSample {
  const stops = resolved.stops;
  if (stops.length === 0) return { rgb: [223, 231, 242], alpha: 1 };
  const first = stops[0]!;
  if (stops.length === 1) return { rgb: first.rgb, alpha: first.alpha };

  let raw = Number.isFinite(t) ? t : 0;
  if (resolved.direction === 'reverse') raw = 1 - raw;
  if (resolved.direction === 'across') raw = Math.abs(raw * 2 - 1);
  let position = clamp01(raw);
  if (resolved.cyclic) position = ((raw % 1) + 1) % 1;

  const list = resolved.cyclic ? cyclicStops(stops) : stops;
  for (let i = 1; i < list.length; i += 1) {
    const previous = list[i - 1]!;
    const next = list[i]!;
    if (position <= next.offset || i === list.length - 1) {
      const span = next.offset - previous.offset;
      const local = span <= 0 ? 1 : clamp01((position - previous.offset) / span);
      const k = blend === 'smooth' ? smoothstep(local) : blend === 'step' ? 0 : local;
      return { rgb: mixRgb(previous.rgb, next.rgb, k), alpha: previous.alpha + (next.alpha - previous.alpha) * k };
    }
  }
  const last = list[list.length - 1]!;
  return { rgb: last.rgb, alpha: last.alpha };
}

/** Цвет в вершине упрощённой геометрии: параметр вершины — доля исходного пути. */
export function gradientAtVertex(resolved: ResolvedGradient, param: number, blend: GradientSpec['blend'] = 'linear'): GradientSample {
  return sampleGradient(resolved, param, blend);
}

export interface VertexPaint {
  readonly param: number;
  readonly rgb: Rgb;
  readonly alpha: number;
}

/** Раскраска вершин кольца: проекция исходных параметров на упрощённый путь. */
export function paintRing(
  resolved: ResolvedGradient,
  ring: ParametrizedRing,
  blend: GradientSpec['blend'] = 'linear',
): readonly VertexPaint[] {
  return ring.params.map((param) => ({ param, ...gradientAtVertex(resolved, param, blend) }));
}

/** Признак «шва»: замкнутый контур с заданной вершиной разрыва. */
export function hasSeam(resolved: ResolvedGradient): boolean {
  return resolved.seamVertex !== null;
}

/**
 * Акцент режима для автоматического градиента: совпадает с акцентом
 * `MODE_STYLES`, чтобы градиент и обводка не расходились по цвету.
 */
export function modeAccentRgb(state: AreaState): Rgb | null {
  return stateStyle(state).accent;
}
