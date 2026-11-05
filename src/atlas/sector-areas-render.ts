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
import type { Area, AreaPoint, AreaState, Mode, SectorAreasDoc } from './sector-areas-contract.ts';
import { focusAppearance, stateStyle, toCss } from './sector-areas-color.ts';
import type { FactionPalette, FocusSettings, Rgb } from './sector-areas-color.ts';
import { paintRing, resolveGradient } from './sector-areas-gradient.ts';
import { statesForLevel } from './sector-areas-cascade.ts';
import { computeLod, effectiveLevel } from './sector-areas-lod.ts';
import type { LodCache } from './sector-areas-lod.ts';
import { overridesFor } from './sector-areas-force.ts';
import { ringArea } from './sector-areas-geometry.ts';

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
  /** `true` — мазок форс-закрашивания: цвет перебит, состояния сохранены. */
  readonly override: boolean;
  readonly label: string | null;
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
      paints.push(overridePaint(area, override.color, override.alpha, override.z, level, options));
      continue;
    }

    for (const mode of MODES) {
      const resolved = statesForLevel(doc, area.id, level, mode)[0];
      if (resolved === undefined) continue;
      const appearance = focusAppearance(mode, focusMode, focus);
      if (!appearance.visible) continue;
      paints.push(statePaint(area, resolved.state, mode, level, appearance.alpha, options));
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

function overridePaint(
  area: Area,
  color: string,
  alpha: number,
  z: number,
  level: number,
  options: AreaPaintOptions,
): AreaPaint {
  const rgb = hexToRgb(color);
  return {
    areaId: area.id,
    stateId: null,
    mode: options.focusMode ?? (MODES[0] ?? 'political'),
    name: area.name,
    z,
    level,
    visible: true,
    fill: area.closed ? { rgb, alpha: alpha * 0.35 } : null,
    stroke: { rgb, alpha, width: options.strokeWidth ?? 2, dash: [] },
    rings: ringsFor(area, level, 0, 1, options),
    override: true,
    label: `${area.name} · override`,
  };
}

function statePaint(
  area: Area,
  state: AreaState,
  mode: Mode,
  level: number,
  focusAlpha: number,
  options: AreaPaintOptions,
): AreaPaint {
  const style = stateStyle(state, {
    ...(options.palette === undefined ? {} : { palette: options.palette }),
    ...(options.strokeSafe === undefined ? {} : { strokeSafe: options.strokeSafe }),
    ...(options.fillAlpha === undefined ? {} : { fillAlpha: options.fillAlpha }),
  });

  const gradient = resolveGradient(state.gradient, {
    ...(options.palette === undefined ? {} : { palette: options.palette }),
    factionMode: state.factionMode,
    factionIds: state.factionIds,
    task: state.task,
    closed: area.closed,
    accent: style.accent,
  });

  const rings = ringsFor(area, level, state.lodBias, state.rounding, options).map((ring) => {
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

  return {
    areaId: area.id,
    stateId: state.id,
    mode,
    name: area.name,
    z: state.z,
    level: effectiveLevel(level, state),
    visible: true,
    fill: area.closed ? { rgb: style.fill, alpha: style.fillAlpha * focusAlpha } : null,
    stroke: {
      rgb: style.stroke,
      alpha: style.alpha * focusAlpha,
      width: options.strokeWidth ?? Math.max(1, style.width),
      dash: style.dash,
    },
    rings,
    override: false,
    label: state.label ?? area.name,
  };
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

/** Площадь внешнего кольца — для журнала и отсечения мелких областей. */
export function areaSize(area: Area): number {
  const outer = area.rings[0];
  if (outer === undefined) return 0;
  return ringArea(outer, area.closed);
}
