/* Форс-закрашивание (§5 части 1 плана).
 *
 * Отдельный override-слой: мазок перебивает **все** цвета — фракционные и
 * кастомные, на любом уровне — но не разрушает исходные состояния. По решению
 * владельца мазок коммитится сразу: он попадает в `overrides` документа, в
 * журнал и в легенду с явной меткой «override». Удаление — отдельное действие,
 * после которого исходные состояния снова видны.
 *
 * Рисуется последним: производительность достигается порядком отрисовки,
 * кэшем и понижением разрешения в рендере, а не отказом от функции.
 */

import { parseHexColor } from './config.ts';
import { OVERRIDE_Z } from './sector-areas-contract.ts';
import type { AreaOverride, AreaState, Mode, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
import type { Rgb } from './sector-areas-color.ts';
import { pickState } from './sector-areas-cascade.ts';
import type { ResolvedState } from './sector-areas-cascade.ts';
import { pointInRing } from './sector-areas-geometry.ts';

export interface OverrideStrokeInput {
  readonly id: string;
  readonly rings: readonly Ring[];
  readonly color: string;
  readonly alpha?: number;
  /** `null` — мазок перебивает всё, что под ним, без привязки к области. */
  readonly areaId?: string | null;
  readonly mode?: Mode | null;
  readonly z?: number;
  readonly note?: string | null;
}

export function createOverrideStroke(input: OverrideStrokeInput): AreaOverride {
  return {
    id: input.id,
    areaId: input.areaId ?? null,
    mode: input.mode ?? null,
    rings: input.rings,
    color: input.color,
    alpha: input.alpha ?? 1,
    z: input.z ?? OVERRIDE_Z,
    note: input.note ?? null,
  };
}

/** Коммит мазка в документ: мазок и событие журнала, исходные состояния intact. */
export function commitOverride(doc: SectorAreasDoc, override: AreaOverride, note?: string): SectorAreasDoc {
  const eventId = `ev-override-${override.id}`;
  return {
    ...doc,
    overrides: [...doc.overrides, override],
    events: [
      ...doc.events,
      {
        id: eventId,
        kind: 'override',
        areaId: override.areaId,
        mode: override.mode,
        note: note ?? `Форс-закрашивание ${override.id} цветом ${override.color}`,
      },
    ],
  };
}

export function removeOverride(doc: SectorAreasDoc, id: string): SectorAreasDoc {
  return {
    ...doc,
    overrides: doc.overrides.filter((entry) => entry.id !== id),
    events: [
      ...doc.events,
      { id: `ev-override-remove-${id}`, kind: 'override-remove', areaId: null, mode: null, note: `Снято переопределение ${id}` },
    ],
  };
}

/** Мазки, действующие на область (привязанные к ней или ко всем). */
export function overridesFor(doc: SectorAreasDoc, areaId?: string, mode?: Mode): readonly AreaOverride[] {
  return doc.overrides
    .filter((entry) => (entry.areaId === null || entry.areaId === areaId || areaId === undefined)
      && (entry.mode === null || entry.mode === mode || mode === undefined))
    .slice()
    .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function overrideColor(override: AreaOverride): Rgb {
  const rgb = parseHexColor(override.color);
  return rgb === null ? [223, 231, 242] : [rgb[0], rgb[1], rgb[2]];
}

/** Попадает ли точка в мазок: первое кольцо — внешнее, остальные — дырки. */
export function overrideCovers(override: AreaOverride, x: number, y: number): boolean {
  const outer = override.rings[0];
  if (outer === undefined) return false;
  if (!pointInRing(outer, x, y)) return false;
  for (let i = 1; i < override.rings.length; i += 1) {
    const hole = override.rings[i];
    if (hole !== undefined && pointInRing(hole, x, y)) return false;
  }
  return true;
}

export interface ResolvedPaint {
  readonly state: AreaState | null;
  readonly resolved: ResolvedState | null;
  /** Мазок форс-закрашивания, перебивший состояние; `null` — состояние своё. */
  readonly override: AreaOverride | null;
  readonly rgb: Rgb | null;
  readonly alpha: number;
  readonly z: number;
  readonly isOverride: boolean;
}

const NEUTRAL: Rgb = [223, 231, 242];

/**
 * Что рисовать для области в режиме на глубине: побеждает мазок
 * форс-закрашивания, иначе — состояние по каскаду. Исходное состояние при
 * этом не меняется: `resolved` возвращается вместе с решением.
 */
export function resolvePaint(doc: SectorAreasDoc, areaId: string, mode: Mode, level?: number): ResolvedPaint {
  const resolved = pickState(doc, areaId, mode, level);
  const override = overridesFor(doc, areaId, mode).at(-1) ?? null;

  if (override !== null) {
    return {
      state: resolved?.state ?? null,
      resolved,
      override,
      rgb: overrideColor(override),
      alpha: override.alpha,
      z: override.z,
      isOverride: true,
    };
  }

  return {
    state: resolved?.state ?? null,
    resolved,
    override: null,
    rgb: resolved === null ? null : NEUTRAL,
    alpha: resolved === null ? 0 : 1,
    z: resolved?.state.z ?? 0,
    isOverride: false,
  };
}

/** Порядок отрисовки: обычные области по `z`, мазки форс-закрашивания — последними. */
export function paintOrder<T>(entries: readonly T[], zOf: (entry: T) => number, isOverride: (entry: T) => boolean): readonly T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const overrideDiff = Number(isOverride(a.entry)) - Number(isOverride(b.entry));
      if (overrideDiff !== 0) return overrideDiff;
      const zDiff = zOf(a.entry) - zOf(b.entry);
      if (zDiff !== 0) return zDiff;
      return a.index - b.index;
    })
    .map((item) => item.entry);
}
