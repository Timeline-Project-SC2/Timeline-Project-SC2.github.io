/* Каскад состояний по иерархии областей (§2.1, §2.2 части 1 плана).
 *
 * Родитель задаётся **явно** (`parentId`) и дополнительно проверяется по
 * геометрии: расхождение видно как предупреждение, а не пропадает молча.
 * Наследование убирает «двойную прорисовку»: собственное состояние области
 * перекрывает унаследованное того же режима, а не рисуется поверх него.
 */

import type { Area, AreaState, Mode, SectorAreasDoc } from './sector-areas-contract.ts';
import { ringContainsRing } from './sector-areas-geometry.ts';

export interface AreaIndex {
  readonly byId: ReadonlyMap<string, Area>;
  readonly childrenOf: ReadonlyMap<string, readonly Area[]>;
  readonly roots: readonly Area[];
  readonly depthOf: ReadonlyMap<string, number>;
}

export function buildAreaIndex(doc: SectorAreasDoc): AreaIndex {
  const byId = new Map<string, Area>();
  for (const area of doc.areas) byId.set(area.id, area);

  const childrenOf = new Map<string, Area[]>();
  const roots: Area[] = [];
  for (const area of doc.areas) {
    if (area.parentId === null || !byId.has(area.parentId)) roots.push(area);
    else {
      const list = childrenOf.get(area.parentId);
      if (list === undefined) childrenOf.set(area.parentId, [area]);
      else list.push(area);
    }
  }

  const depthOf = new Map<string, number>();
  const walk = (area: Area, depth: number): void => {
    if (depthOf.has(area.id)) return;
    depthOf.set(area.id, depth);
    for (const child of childrenOf.get(area.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  return { byId, childrenOf, roots, depthOf };
}

/** Цепочка предков: от родителя к корню. Цикл не зацикливается. */
export function ancestorsOf(doc: SectorAreasDoc, areaId: string): readonly Area[] {
  const index = buildAreaIndex(doc);
  const chain: Area[] = [];
  const seen = new Set<string>([areaId]);
  let current = index.byId.get(areaId);
  while (current !== undefined && current.parentId !== null) {
    if (seen.has(current.parentId)) break;
    seen.add(current.parentId);
    const parent = index.byId.get(current.parentId);
    if (parent === undefined) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

export interface ResolvedState {
  readonly state: AreaState;
  /** Область, которой состояние принадлежит. */
  readonly areaId: string;
  /** `0` — собственное состояние; `1` — родителя; дальше по иерархии. */
  readonly distance: number;
  readonly inherited: boolean;
}

function compareStates(a: ResolvedState, b: ResolvedState): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (a.state.priority !== b.state.priority) return b.state.priority - a.state.priority;
  if (a.state.override !== b.state.override) return a.state.override ? -1 : 1;
  return a.state.id < b.state.id ? -1 : a.state.id > b.state.id ? 1 : 0;
}

/**
 * Все состояния, действующие на область: собственные плюс унаследованные.
 * Порядок: сначала свои, затем предки по возрастанию расстояния; внутри одной
 * ступени — по приоритету (убывание), затем по идентификатору.
 */
export function effectiveStates(doc: SectorAreasDoc, areaId: string, mode?: Mode): readonly ResolvedState[] {
  const index = buildAreaIndex(doc);
  const area = index.byId.get(areaId);
  if (area === undefined) return [];

  const result: ResolvedState[] = [];
  const collect = (target: Area, distance: number): void => {
    for (const state of target.states) {
      if (mode !== undefined && state.mode !== mode) continue;
      result.push({ state, areaId: target.id, distance, inherited: distance > 0 });
    }
  };

  collect(area, 0);
  ancestorsOf(doc, areaId).forEach((ancestor, position) => collect(ancestor, position + 1));
  return result.sort(compareStates);
}

/** Состояния, видимые на заданной глубине `L0…L12`. */
export function statesForLevel(
  doc: SectorAreasDoc,
  areaId: string,
  level: number,
  mode?: Mode,
): readonly ResolvedState[] {
  return effectiveStates(doc, areaId, mode).filter(
    (entry) => level >= entry.state.visibleFrom && level <= entry.state.visibleTo,
  );
}

/** Состояние, которое победит в отрисовке: первое по каскаду с учётом глубины. */
export function pickState(
  doc: SectorAreasDoc,
  areaId: string,
  mode: Mode,
  level?: number,
): ResolvedState | null {
  const candidates = level === undefined
    ? effectiveStates(doc, areaId, mode)
    : statesForLevel(doc, areaId, level, mode);
  return candidates[0] ?? null;
}

/** Состояния по режимам: что у области своё, а что унаследовано — для журнала. */
export function statesByMode(doc: SectorAreasDoc, areaId: string): ReadonlyMap<Mode, ResolvedState> {
  const result = new Map<Mode, ResolvedState>();
  for (const entry of effectiveStates(doc, areaId)) {
    if (!result.has(entry.state.mode)) result.set(entry.state.mode, entry);
  }
  return result;
}

/**
 * Проверка вложенности: вершины внешнего кольца ребёнка должны лежать внутри
 * внешнего кольца родителя. Возвращает понятные предупреждения, а не ошибки:
 * расхождение данных и геометрии — поведение для журнала, а не отказа.
 */
export function checkContainment(doc: SectorAreasDoc): readonly string[] {
  const index = buildAreaIndex(doc);
  const warnings: string[] = [];

  for (const area of doc.areas) {
    if (area.parentId === null) continue;
    const parent = index.byId.get(area.parentId);
    const childOuter = area.rings[0];
    const parentOuter = parent?.rings[0];
    if (parent === undefined || childOuter === undefined || parentOuter === undefined) continue;
    if (!area.closed || !parent.closed) continue;
    if (!ringContainsRing(parentOuter, childOuter)) {
      warnings.push(`Область ${area.id} «${area.name}» не вложена в родителя ${parent.id} «${parent.name}».`);
    }
  }

  return warnings;
}

/** Максимальная глубина иерархии: `0` — только корни. */
export function hierarchyDepth(doc: SectorAreasDoc): number {
  const index = buildAreaIndex(doc);
  let max = 0;
  for (const depth of index.depthOf.values()) max = Math.max(max, depth);
  return max;
}
