/* Отрисовка областей: из документа в списки обводок и заливок (шаг 2 §11).
 *
 * Чистый слой без DOM: на входе документ областей, уровень кадра и настройки
 * фокуса; на выходе — **мировые** координаты, параметры исходного пути и цвета
 * по вершинам. Проекцию в экран делает `sector-scene.ts` (`areasFor`), канву
 * рисует `canvas-renderer.ts`.
 *
 * Порядок такой: геометрия один раз, состояния — поверх неё (§2 части 1).
 * Форс-закрашивание перебивает все цвета и уходит в конец списка (§5).
 * Градиент считается по параметру исходного пути, поэтому не плывёт при LOD.
 */

import { MODES } from './sector-areas-contract.ts';
import type { Area, AreaPoint, AreaState, AreaStroke, Mode, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
import { focusAppearance, stateStyle, toCss } from './sector-areas-color.ts';
import type { FactionPalette, FocusSettings, Rgb } from './sector-areas-color.ts';
import { paintRing, resolveGradient } from './sector-areas-gradient.ts';
import { statesForLevel } from './sector-areas-cascade.ts';
import { computeLod, effectiveLevel, lodEpsilon, roundingIterations } from './sector-areas-lod.ts';
import type { LodCache } from './sector-areas-lod.ts';
import { overridesFor } from './sector-areas-force.ts';
import { ringArea, simplifyStroke, strokesArea } from './sector-areas-geometry.ts';

/**
 * Маска режима «разделение цветов» пары (§6 ТЗ `SEC-AREAS-HIERARCHY`):
 * заливка области не рисуется в полигонах `holes` (сторона другой области),
 * а при `transitionHalfWidth > 0` вдоль `line` рисуется полоса возврата
 * заливки — ступенчатый мягкий переход.
 */
export interface AreaSplitMask {
  readonly holes: readonly Ring[];
  /** Линия раздела пары: авто или ручная (мировые координаты). */
  readonly line: readonly AreaPoint[];
  /** Полуширина мягкого перехода в единицах карты; `0` — резкое разделение. */
  readonly transitionHalfWidth: number;
}

export interface AreaPaintOptions {
  /** Уровень кадра `L0…L12`: отсекает состояния вне диапазона и задаёт LOD. */
  readonly level: number;
  /** Видимая ширина кадра в мировых единицах — для бакета кэша LOD. */
  readonly visibleWidth?: number;
  readonly palette?: FactionPalette;
  /** Активный режим фокуса; `null` — показывать все режимы. */
  readonly focusMode?: Mode | null;
  readonly focus?: FocusSettings;
  readonly cache?: LodCache;
  /** Ограничить светлоту обводки для тёмной карты. */
  readonly strokeSafe?: boolean;
  /** Прозрачность заливки; `0` — только контур. */
  readonly fillAlpha?: number;
  /** Толщина обводки в пикселях. */
  readonly strokeWidth?: number;
  /**
   * Маски «разделения цветов» пар по ID области (§6): вырезы заливки и линии
   * раздела всех пар области. `undefined` — парный слой не используется.
   */
  readonly splitForArea?: (areaId: string) => readonly AreaSplitMask[];
}

export interface PaintedRing {
  /** Мировые координаты вершин после LOD. */
  readonly points: readonly AreaPoint[];
  /** Доля исходного пути в вершине: `0…1` — основа раскраски градиентом. */
  readonly params: readonly number[];
  /** Цвет вершины: обводка рисуется по сегментам. */
  readonly colors: readonly Rgb[];
  readonly alphas: readonly number[];
  readonly closed: boolean;
}

export interface AreaPaint {
  readonly areaId: string;
  readonly stateId: string | null;
  readonly mode: Mode;
  readonly name: string;
  readonly z: number;
  /** Эффективный уровень состояния после `lodBias` и диапазона глубин. */
  readonly level: number;
  /** `false` — фокус-режим скрыл состояние (`behavior: 'hide'`). */
  readonly visible: boolean;
  readonly fill: { readonly rgb: Rgb; readonly alpha: number } | null;
  readonly stroke: {
    readonly rgb: Rgb;
    readonly alpha: number;
    readonly width: number;
    readonly dash: readonly number[];
  };
  readonly rings: readonly PaintedRing[];
  /** Идентификаторы отдельных штрихов `Area.strokes`, вошедших в этот слой отрисовки. */
  readonly strokeIds?: readonly string[];
  /** `true` — мазок форс-закрашивания: цвет перебит, состояния сохранены. */
  readonly override: boolean;
  readonly label: string | null;
  /**
   * Маски разделения цветов всех пар с участием области (§6): массив, потому
   * что область может состоять в нескольких парах, и у каждой — своя линия
   * и своя полоса перехода. Пустой массив — обычная заливка без вырезов.
   */
  readonly splits?: readonly AreaSplitMask[];
}

/**
 * Строит список областей для кадра. Порядок готов для отрисовки: по `z`, затем
 * по режиму, затем по идентификатору; мазки форс-закрашивания — последними.
 */
export function buildAreaPaints(doc: SectorAreasDoc, options: AreaPaintOptions): readonly AreaPaint[] {
  const paints: AreaPaint[] = [];
  const level = options.level;
  const focus = options.focus;
  const focusMode = options.focusMode ?? null;

  for (const area of doc.areas) {
    const override = overridesFor(doc, area.id).at(-1) ?? null;
    if (override !== null) {
      paints.push(...overridePaints(area, override.color, override.alpha, override.z, level, options));
      continue;
    }

    for (const mode of MODES) {
      const resolved = statesForLevel(doc, area.id, level, mode)[0];
      if (resolved === undefined) continue;
      const appearance = focusAppearance(mode, focusMode, focus);
      if (!appearance.visible) continue;
      paints.push(...statePaints(area, resolved.state, mode, level, appearance.alpha, options));
    }
  }

  return paints.sort((a, b) => a.z - b.z
    || MODES.indexOf(a.mode) - MODES.indexOf(b.mode)
    || (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0));
}

/** Геометрия области на уровне: LOD и округлость из состояния. */
function ringsFor(
  area: Area,
  level: number,
  bias: number,
  rounding: 0 | 1 | 2,
  options: AreaPaintOptions,
): readonly PaintedRing[] {
  const geometry = computeLod(area, level, rounding, bias, options.cache, options.visibleWidth);
  return geometry.rings.map((ring) => ({
    points: ring.points,
    params: ring.params,
    colors: [],
    alphas: [],
    closed: ring.closed,
  }));
}

/** Геометрия отдельных штрихов `Area.strokes` без смешивания с `Area.rings`. */
function strokesFor(
  strokes: readonly AreaStroke[],
  level: number,
  bias: number,
  rounding: 0 | 1 | 2,
): readonly PaintedRing[] {
  const eps = lodEpsilon(level, bias);
  const passes = roundingIterations(rounding);
  return strokes.map((stroke) => {
    const reduced = simplifyStroke(stroke, eps, passes);
    return {
      points: reduced.points,
      params: reduced.params,
      colors: [],
      alphas: [],
      closed: stroke.closed,
    };
  });
}

function overridePaints(
  area: Area,
  color: string,
  alpha: number,
  z: number,
  level: number,
  options: AreaPaintOptions,
): readonly AreaPaint[] {
  const rgb = hexToRgb(color);
  const mode = options.focusMode ?? (MODES[0] ?? 'political');
  const strokeStyle = { rgb, alpha, width: options.strokeWidth ?? 2, dash: [] as const };
  const label = `${area.name} · override`;
  const result: AreaPaint[] = [];

  const strokes = area.strokes ?? [];
  const closedStrokes = strokes.filter((item) => item.closed);
  const openStrokes = strokes.filter((item) => !item.closed);
  const splitsOf = (): readonly AreaSplitMask[] => (options.splitForArea !== undefined && area.closed ? options.splitForArea(area.id) ?? [] : []);

  if (area.rings.length > 0) {
    result.push({
      areaId: area.id,
      stateId: null,
      mode,
      name: area.name,
      z,
      level,
      visible: true,
      fill: area.closed ? { rgb, alpha: alpha * 0.35 } : null,
      stroke: strokeStyle,
      rings: ringsFor(area, level, 0, 1, options),
      override: true,
      label,
      splits: splitsOf(),
    });
  }

  if (closedStrokes.length > 0) {
    result.push({
      areaId: area.id,
      stateId: null,
      mode,
      name: area.name,
      z,
      level,
      visible: true,
      fill: { rgb, alpha: alpha * 0.35 },
      stroke: strokeStyle,
      rings: strokesFor(closedStrokes, level, 0, 1),
      strokeIds: closedStrokes.map((item) => item.id),
      override: true,
      label,
      // Область с первичной геометрией-штрихом: маски вырезов вешаются на
      // штриховый слой (дефект B1 ревью — раньше split получали только кольца).
      splits: area.rings.length === 0 ? splitsOf() : [],
    });
  }
  if (openStrokes.length > 0) {
    result.push({
      areaId: area.id,
      stateId: null,
      mode,
      name: area.name,
      z,
      level,
      visible: true,
      fill: null,
      stroke: strokeStyle,
      rings: strokesFor(openStrokes, level, 0, 1),
      strokeIds: openStrokes.map((item) => item.id),
      override: true,
      label,
    });
  }

  return result;
}

function paintRingsWithGradient(
  rings: readonly PaintedRing[],
  state: AreaState,
  closed: boolean,
  accent: Rgb | null,
  options: AreaPaintOptions,
): readonly PaintedRing[] {
  const gradient = resolveGradient(state.gradient, {
    ...(options.palette === undefined ? {} : { palette: options.palette }),
    factionMode: state.factionMode,
    factionIds: state.factionIds,
    task: state.task,
    closed,
    accent,
  });

  return rings.map((ring) => {
    if (ring.points.length === 0) return ring;
    const painted = paintRing(gradient, {
      points: ring.points,
      params: ring.params,
      closed: ring.closed,
    });
    return {
      ...ring,
      colors: painted.map((entry) => entry.rgb),
      alphas: painted.map((entry) => entry.alpha),
    };
  });
}

function statePaints(
  area: Area,
  state: AreaState,
  mode: Mode,
  level: number,
  focusAlpha: number,
  options: AreaPaintOptions,
): readonly AreaPaint[] {
  const style = stateStyle(state, {
    ...(options.palette === undefined ? {} : { palette: options.palette }),
    ...(options.strokeSafe === undefined ? {} : { strokeSafe: options.strokeSafe }),
    ...(options.fillAlpha === undefined ? {} : { fillAlpha: options.fillAlpha }),
  });
  const resolvedLevel = effectiveLevel(level, state);
  const strokeStyle = {
    rgb: style.stroke,
    alpha: style.alpha * focusAlpha,
    width: options.strokeWidth ?? Math.max(1, style.width),
    dash: style.dash,
  };
  const label = state.label ?? area.name;
  const result: AreaPaint[] = [];
  const strokes = area.strokes ?? [];
  const closedStrokes = strokes.filter((item) => item.closed);
  const openStrokes = strokes.filter((item) => !item.closed);
  const splitsOf = (): readonly AreaSplitMask[] => (options.splitForArea !== undefined && area.closed ? options.splitForArea(area.id) ?? [] : []);

  if (area.rings.length > 0) {
    const rawRings = ringsFor(area, level, state.lodBias, state.rounding, options);
    result.push({
      areaId: area.id,
      stateId: state.id,
      mode,
      name: area.name,
      z: state.z,
      level: resolvedLevel,
      visible: true,
      fill: area.closed ? { rgb: style.fill, alpha: style.fillAlpha * focusAlpha } : null,
      stroke: strokeStyle,
      rings: paintRingsWithGradient(rawRings, state, area.closed, style.accent, options),
      override: false,
      label,
      splits: splitsOf(),
    });
  }

  if (closedStrokes.length > 0) {
    const rawClosed = strokesFor(closedStrokes, level, state.lodBias, state.rounding);
    result.push({
      areaId: area.id,
      stateId: state.id,
      mode,
      name: area.name,
      z: state.z,
      level: resolvedLevel,
      visible: true,
      fill: { rgb: style.fill, alpha: style.fillAlpha * focusAlpha },
      stroke: strokeStyle,
      rings: paintRingsWithGradient(rawClosed, state, true, style.accent, options),
      strokeIds: closedStrokes.map((item) => item.id),
      override: false,
      label,
      // См. overridePaints: split для областей, чья геометрия — штрих (B1).
      splits: area.rings.length === 0 ? splitsOf() : [],
    });
  }

  if (openStrokes.length > 0) {
    const rawOpen = strokesFor(openStrokes, level, state.lodBias, state.rounding);
    result.push({
      areaId: area.id,
      stateId: state.id,
      mode,
      name: area.name,
      z: state.z,
      level: resolvedLevel,
      visible: true,
      fill: null,
      stroke: strokeStyle,
      rings: paintRingsWithGradient(rawOpen, state, false, style.accent, options),
      strokeIds: openStrokes.map((item) => item.id),
      override: false,
      label,
    });
  }

  return result;
}

function hexToRgb(color: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) return [223, 231, 242];
  const hex = match[1]!;
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** ЦСС-цвет вершины: рендерер красит обводку по сегментам. */
export function vertexCss(rgb: Rgb, alpha: number): string {
  return toCss(rgb, alpha);
}

/** Площадь области по внешнему кольцу и замкнутым штрихам (без смешивания с дырками). */
export function areaSize(area: Area): number {
  const outer = area.rings[0];
  const ringsPart = outer === undefined ? 0 : ringArea(outer, area.closed);
  return ringsPart + strokesArea(area.strokes ?? []);
}
