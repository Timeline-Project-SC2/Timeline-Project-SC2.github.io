/* Журнал областей и «вес» набора (§8 части 2 плана).
 *
 * Журнал — представление, а не второй источник истины: он показывает область,
 * её адрес, родителя, источник, собственные и **эффективные** (унаследованные)
 * состояния по режимам, метки форс-закрашивания и счётчики сложности. Цель —
 * видеть каскад и не терять, какая область какой режим наследует.
 */

import { MODES } from './sector-areas-contract.ts';
import type { Area, AreaSource, AreaState, Mode, SectorAreasDoc } from './sector-areas-contract.ts';
import { buildAreaIndex, effectiveStates } from './sector-areas-cascade.ts';
import { ringArea, totalVertices } from './sector-areas-geometry.ts';

export interface JournalStateInfo {
  readonly id: string;
  readonly mode: Mode;
  readonly factionMode: AreaState['factionMode'];
  readonly factionIds: readonly string[];
  readonly task: AreaState['task'];
  readonly priority: number;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly z: number;
  readonly override: boolean;
  /** `true` — состояние унаследовано от предка, а не задано области. */
  readonly inherited: boolean;
  /** Область-источник состояния при наследовании. */
  readonly fromAreaId: string;
  /** Ступень каскада: `0` — своё, `1` — родитель и так далее. */
  readonly distance: number;
}

export interface JournalEntry {
  readonly areaId: string;
  readonly name: string;
  readonly address: string | null;
  readonly parentId: string | null;
  readonly depth: number;
  readonly source: AreaSource;
  readonly closed: boolean;
  readonly vertexCount: number;
  readonly ringCount: number;
  readonly areaSize: number;
  readonly scopeId: string | null;
  readonly location: string | null;
  readonly detail: string | null;
  readonly distance: number | null;
  readonly band: string | null;
  readonly ownStates: readonly JournalStateInfo[];
  /** Победитель каскада по каждому активному режиму. */
  readonly effectiveByMode: Readonly<Record<Mode, JournalStateInfo | null>>;
  readonly overrideIds: readonly string[];
}

export interface JournalWeight {
  readonly areas: number;
  readonly states: number;
  readonly inheritedStates: number;
  readonly overrides: number;
  readonly events: number;
  readonly maxDepth: number;
  readonly totalVertices: number;
  readonly totalRings: number;
  readonly maxStatesPerArea: number;
}

export interface Journal {
  readonly entries: readonly JournalEntry[];
  readonly weight: JournalWeight;
  readonly generatedFrom: { readonly version: number; readonly mapSize: number };
}

export interface JournalOptions {
  /** Считать площадь и число вершин (по умолчанию — да). */
  readonly geometry?: boolean;
}

function toStateInfo(state: AreaState, inherited: boolean, fromAreaId: string, distance: number): JournalStateInfo {
  return {
    id: state.id,
    mode: state.mode,
    factionMode: state.factionMode,
    factionIds: state.factionIds,
    task: state.task,
    priority: state.priority,
    visibleFrom: state.visibleFrom,
    visibleTo: state.visibleTo,
    z: state.z,
    override: state.override,
    inherited,
    fromAreaId,
    distance,
  };
}

export function buildJournal(doc: SectorAreasDoc, options: JournalOptions = {}): Journal {
  const withGeometry = options.geometry !== false;
  const index = buildAreaIndex(doc);
  const entries: JournalEntry[] = [];

  for (const area of doc.areas) {
    const cascaded = effectiveStates(doc, area.id);
    const effectiveByMode = Object.fromEntries(
      MODES.map((mode) => [mode, cascaded.find((entry) => entry.state.mode === mode) ?? null]),
    ) as Record<Mode, ReturnType<typeof effectiveStates>[number] | null>;

    entries.push({
      areaId: area.id,
      name: area.name,
      address: area.address,
      parentId: area.parentId,
      depth: index.depthOf.get(area.id) ?? 0,
      source: area.source,
      closed: area.closed,
      vertexCount: withGeometry ? totalVertices(area) : 0,
      ringCount: area.rings.length,
      areaSize: withGeometry ? areaSizeOf(area) : 0,
      scopeId: area.scopeId,
      location: area.location,
      detail: area.detail,
      distance: area.distance,
      band: area.band,
      ownStates: area.states.map((state) => toStateInfo(state, false, area.id, 0)),
      effectiveByMode: Object.fromEntries(
        MODES.map((mode) => {
          const winner = effectiveByMode[mode] ?? null;
          return [mode, winner === null ? null : toStateInfo(winner.state, winner.inherited, winner.areaId, winner.distance)];
        }),
      ) as Record<Mode, JournalStateInfo | null>,
      overrideIds: doc.overrides
        .filter((override) => override.areaId === null || override.areaId === area.id)
        .map((override) => override.id),
    });
  }

  const weight = weighJournal(doc, entries);
  return { entries, weight, generatedFrom: { version: doc.version, mapSize: doc.mapSize } };
}

function areaSizeOf(area: Area): number {
  const outer = area.rings[0];
  if (outer === undefined) return 0;
  let size = ringArea(outer, area.closed);
  for (let i = 1; i < area.rings.length; i += 1) {
    const hole = area.rings[i];
    if (hole !== undefined) size -= ringArea(hole, true);
  }
  return Math.max(0, size);
}

function weighJournal(doc: SectorAreasDoc, entries: readonly JournalEntry[]): JournalWeight {
  let states = 0;
  let inheritedStates = 0;
  let maxStatesPerArea = 0;
  for (const entry of entries) {
    states += entry.ownStates.length;
    maxStatesPerArea = Math.max(maxStatesPerArea, entry.ownStates.length);
    for (const mode of MODES) {
      const winner = entry.effectiveByMode[mode];
      if (winner !== null && winner.inherited) inheritedStates += 1;
    }
  }
  let maxDepth = 0;
  for (const entry of entries) maxDepth = Math.max(maxDepth, entry.depth);

  return {
    areas: entries.length,
    states,
    inheritedStates,
    overrides: doc.overrides.length,
    events: doc.events.length + doc.areas.reduce((sum, area) => sum + area.events.length, 0),
    maxDepth,
    totalVertices: entries.reduce((sum, entry) => sum + entry.vertexCount, 0),
    totalRings: entries.reduce((sum, entry) => sum + entry.ringCount, 0),
    maxStatesPerArea,
  };
}

export interface JournalFilter {
  readonly mode?: Mode;
  readonly faction?: string;
  /** Глубина `L0…L12`: оставить области с состоянием, видимым на ней. */
  readonly level?: number;
  readonly source?: AreaSource;
  readonly scopeId?: string;
  readonly band?: string;
  readonly onlyInherited?: boolean;
  readonly onlyOverrides?: boolean;
}

export function filterJournal(journal: Journal, filter: JournalFilter): Journal {
  const entries = journal.entries.filter((entry) => {
    if (filter.source !== undefined && entry.source !== filter.source) return false;
    if (filter.scopeId !== undefined && entry.scopeId !== filter.scopeId) return false;
    if (filter.band !== undefined && entry.band !== filter.band) return false;
    if (filter.onlyOverrides === true && entry.overrideIds.length === 0) return false;

    if (filter.mode !== undefined) {
      const winner = entry.effectiveByMode[filter.mode];
      if (winner === null) return false;
      if (filter.faction !== undefined && !winner.factionIds.includes(filter.faction)) return false;
      if (filter.level !== undefined && (filter.level < winner.visibleFrom || filter.level > winner.visibleTo)) return false;
      if (filter.onlyInherited === true && !winner.inherited) return false;
      return true;
    }

    if (filter.faction !== undefined) {
      const hit = Object.values(entry.effectiveByMode).some(
        (winner) => winner !== null && winner.factionIds.includes(filter.faction as string),
      );
      if (!hit) return false;
    }
    if (filter.level !== undefined) {
      const hit = Object.values(entry.effectiveByMode).some(
        (winner) => winner !== null && filter.level !== undefined
          && filter.level >= winner.visibleFrom && filter.level <= winner.visibleTo,
      );
      if (!hit) return false;
    }
    if (filter.onlyInherited === true) {
      const hit = Object.values(entry.effectiveByMode).some((winner) => winner !== null && winner.inherited);
      if (!hit) return false;
    }
    return true;
  });

  const weight: JournalWeight = {
    ...journal.weight,
    areas: entries.length,
    states: entries.reduce((sum, entry) => sum + entry.ownStates.length, 0),
    totalVertices: entries.reduce((sum, entry) => sum + entry.vertexCount, 0),
    totalRings: entries.reduce((sum, entry) => sum + entry.ringCount, 0),
  };
  return { ...journal, entries, weight };
}

/** Выгрузка журнала: простой JSON без ссылок и вычисляемых полей. */
export function exportJournal(journal: Journal): Record<string, unknown> {
  return {
    version: journal.generatedFrom.version,
    mapSize: journal.generatedFrom.mapSize,
    weight: { ...journal.weight },
    entries: journal.entries.map((entry) => ({
      areaId: entry.areaId,
      name: entry.name,
      address: entry.address,
      parentId: entry.parentId,
      depth: entry.depth,
      source: entry.source,
      closed: entry.closed,
      vertexCount: entry.vertexCount,
      ringCount: entry.ringCount,
      areaSize: entry.areaSize,
      scopeId: entry.scopeId,
      location: entry.location,
      detail: entry.detail,
      distance: entry.distance,
      band: entry.band,
      ownStates: entry.ownStates.map((state) => ({ ...state, factionIds: [...state.factionIds] })),
      effectiveByMode: Object.fromEntries(
        MODES.map((mode) => {
          const winner = entry.effectiveByMode[mode];
          return [mode, winner === null ? null : { ...winner, factionIds: [...winner.factionIds] }];
        }),
      ),
      overrideIds: [...entry.overrideIds],
    })),
  };
}

export function journalToJson(journal: Journal, indent = 2): string {
  return JSON.stringify(exportJournal(journal), null, indent);
}
