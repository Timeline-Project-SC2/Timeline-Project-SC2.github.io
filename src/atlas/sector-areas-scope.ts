/* Области действия кисти (scope) и детализация (часть 3 плана).
 *
 * Scope — маска и референс, а не разбиение данных: геометрия области остаётся
 * в мировых координатах `0…10000`. Кисть не импортирует поле и рендерер — она
 * потребляет интерфейс `Scope` (`isInside`, расстояние, классификация) и
 * возвращает `Area`/`State`. Адаптеры подключают существующие границы
 * (`data/sector-bounds.json`, `nebula-model.ts`) и не мутируют их.
 *
 * Пограничный мир — не scope, а отдельный уровень систем: см. `sector-areas-border-world.ts`.
 */

import { distanceToRing as boundsDistanceToRing, pointInPolygon } from './sector-bounds.ts';
import type { SectorBounds } from './sector-bounds.ts';
import type { Area, AreaLocation, Ring } from './sector-areas-contract.ts';
import { MAX_LEVEL, MIN_LEVEL } from './sector-areas-contract.ts';
import { ringCentroid } from './sector-areas-geometry.ts';

export type ScopeKind = 'free' | 'sector' | 'nebula' | 'outside' | 'custom';
export const SCOPE_KINDS: readonly ScopeKind[] = Object.freeze(['free', 'sector', 'nebula', 'outside', 'custom']);

export interface ScopeStyle {
  readonly fill: string;
  readonly stroke: string;
  readonly dash: readonly number[];
  readonly opacity: number;
}

export interface Scope {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly label: string;
  /** Пусто — scope без площади (линия гало): принадлежность не вычисляется. */
  readonly rings: readonly Ring[];
  /** Откуда пришла геометрия: файл или модуль. */
  readonly source: string;
  readonly visibleFrom: number;
  readonly visibleTo: number;
  /** `true` — scope-дополнение: «вне сектора». */
  readonly complement: boolean;
  readonly style: ScopeStyle;
}

export interface ScopeRule {
  readonly a: string;
  readonly b: string;
  readonly dominance: 'a' | 'b' | 'equal';
}

const DEFAULT_STYLE: ScopeStyle = Object.freeze({ fill: 'rgba(120,160,220,0.12)', stroke: 'rgba(160,200,255,0.65)', dash: Object.freeze([]), opacity: 0.6 });

export interface ScopeInput {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly label: string;
  readonly rings?: readonly Ring[];
  readonly source?: string;
  readonly visibleFrom?: number;
  readonly visibleTo?: number;
  readonly complement?: boolean;
  readonly style?: ScopeStyle;
}

export function createScope(input: ScopeInput): Scope {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    rings: input.rings ?? [],
    source: input.source ?? 'manual',
    visibleFrom: input.visibleFrom ?? MIN_LEVEL,
    visibleTo: input.visibleTo ?? MAX_LEVEL,
    complement: input.complement ?? false,
    style: input.style ?? DEFAULT_STYLE,
  };
}

/* -------------------------------------------------------------- адаптеры */

function kindOfPrimitive(kind: SectorBounds['bounds'][number]['kind']): ScopeKind {
  if (kind === 'sector') return 'sector';
  if (kind === 'nebula') return 'nebula';
  return 'custom';
}

/**
 * Адаптер существующих границ: сектор, туманности и линия гало.
 * Исходные контуры не копируются в scope как «владелец» — только как ссылка:
 * при редактировании исходник сохраняется с историей (source vs derived).
 */
export function scopesFromBounds(bounds: SectorBounds): readonly Scope[] {
  return bounds.bounds.map((primitive) => createScope({
    id: primitive.id,
    kind: kindOfPrimitive(primitive.kind),
    label: primitive.label,
    // Линия гало площади не имеет: rings пуст, принадлежность — `unknown`.
    rings: primitive.kind === 'halo' ? [] : [primitive.points],
    source: 'data/sector-bounds.json',
    style: {
      fill: primitive.kind === 'nebula' ? 'rgba(150,110,220,0.14)' : 'rgba(120,160,220,0.12)',
      stroke: primitive.style.color === 'nebula' ? 'rgba(190,150,255,0.7)' : 'rgba(160,200,255,0.65)',
      dash: primitive.style.dash,
      opacity: 0.6,
    },
  }));
}

/** Scope-дополнение: «вне сектора» — всё, что не попало в базовый контур. */
export function outsideScopeOf(base: Scope, id = `${base.id}:outside`): Scope {
  return createScope({
    id,
    kind: 'outside',
    label: `Вне: ${base.label}`,
    rings: base.rings,
    source: base.source,
    visibleFrom: base.visibleFrom,
    visibleTo: base.visibleTo,
    complement: true,
    style: base.style,
  });
}

/* ------------------------------------------------------------- геометрия */

/** Принадлежность точки scope: `null` — scope без площади (не вычисляется). */
export function isInside(scope: Scope, x: number, y: number): boolean | null {
  const outer = scope.rings[0];
  if (outer === undefined) return null;
  const inside = pointInPolygon(outer, x, y);
  if (!inside) return scope.complement ? true : false;
  for (let i = 1; i < scope.rings.length; i += 1) {
    const hole = scope.rings[i];
    if (hole !== undefined && pointInPolygon(hole, x, y)) return scope.complement ? true : false;
  }
  return scope.complement ? false : true;
}

/** Расстояние от точки до границы scope; `Infinity` — границы нет. */
export function distanceToScope(scope: Scope, x: number, y: number): number {
  if (scope.rings.length === 0) return Infinity;
  let min = Infinity;
  for (const ring of scope.rings) min = Math.min(min, boundsDistanceToRing(ring, x, y));
  return min;
}

export interface ClassifyOptions {
  /** Порог «у границы» в мировых единицах. */
  readonly borderDistance?: number;
  /** Порог «глубоко внутри» в мировых единицах. */
  readonly coreDistance?: number;
  /** Полоса пограничного мира: возвращает идентификатор полосы или `null`. */
  readonly bandOf?: (x: number, y: number) => string | null;
}

export const DEFAULT_BORDER_DISTANCE = 50;
export const DEFAULT_CORE_DISTANCE = 200;

/**
 * Классификация области относительно scope: `inside`, `outside`, `border`,
 * `core`, `band` (полоса пограничного мира) или `unknown`.
 * `inner`/`outer` не нужны: глубину уже задают `core`/`border`/`outside`.
 */
export function classifyLocation(
  scope: Scope,
  geometry: Ring,
  closed = true,
  options: ClassifyOptions = {},
): AreaLocation {
  const center = ringCentroid(geometry, closed);
  const [cx, cy] = center;
  const inside = isInside(scope, cx, cy);
  if (inside === null) return 'unknown';

  if (options.bandOf !== undefined) {
    const band = options.bandOf(cx, cy);
    if (band !== null) return 'band';
  }

  const distance = distanceToScope(scope, cx, cy);
  const border = options.borderDistance ?? DEFAULT_BORDER_DISTANCE;
  const core = options.coreDistance ?? DEFAULT_CORE_DISTANCE;

  if (!inside) return distance <= border ? 'border' : 'outside';
  if (distance >= core) return 'core';
  return distance <= border ? 'border' : 'inside';
}

export function classifyArea(scope: Scope, area: Area, options: ClassifyOptions = {}): AreaLocation {
  const outer = area.rings[0];
  if (outer === undefined) return 'unknown';
  return classifyLocation(scope, outer, area.closed, options);
}

export interface ScopeCrossing {
  readonly scopeId: string;
  /** Доля вершин области внутри scope: `0…1`. */
  readonly share: number;
  /** Область пересекает границу scope — предупреждение, а не запрет. */
  readonly crossing: boolean;
}

/** Как область ложится на scope: целиком внутри, целиком снаружи или crossing. */
export function scopeCrossings(area: Area, scopes: readonly Scope[]): readonly ScopeCrossing[] {
  const outer = area.rings[0];
  if (outer === undefined) return [];

  const result: ScopeCrossing[] = [];
  for (const scope of scopes) {
    let inside = 0;
    let known = 0;
    for (const point of outer) {
      const verdict = isInside(scope, point[0], point[1]);
      if (verdict === null) continue;
      known += 1;
      if (verdict) inside += 1;
    }
    if (known === 0) continue;
    const share = inside / known;
    result.push({ scopeId: scope.id, share, crossing: share > 0 && share < 1 });
  }
  return result;
}

/* ------------------------------------------------------------------ правила */

/** Явное правило пары: кто главенствует или «на равных»; `null` — правила нет. */
export function dominanceFor(rules: readonly ScopeRule[], a: string, b: string): 'a' | 'b' | 'equal' | null {
  for (const rule of rules) {
    if (rule.a === a && rule.b === b) return rule.dominance;
    if (rule.a === b && rule.b === a) {
      if (rule.dominance === 'equal') return 'equal';
      return rule.dominance === 'a' ? 'b' : 'a';
    }
  }
  return null;
}

/**
 * Разрешение конфликта двух scope: сначала явное правило, затем порядок списка
 * (drag-and-drop: выше — главнее). Без правила и без порядка — `null`, то есть
 * безопасный режим «оба сохраняются» с предупреждением.
 */
export function resolveDominance(
  rules: readonly ScopeRule[],
  order: readonly string[],
  a: string,
  b: string,
): 'a' | 'b' | 'equal' | null {
  const rule = dominanceFor(rules, a, b);
  if (rule !== null) return rule;
  const indexA = order.indexOf(a);
  const indexB = order.indexOf(b);
  if (indexA < 0 || indexB < 0) return null;
  if (indexA === indexB) return 'equal';
  return indexA < indexB ? 'a' : 'b';
}

export interface ScopeConflict {
  readonly a: string;
  readonly b: string;
  readonly dominance: 'a' | 'b' | 'equal' | null;
}

/** Все пары scope, чьи области пересекаются, с решением по правилам. */
export function scopeConflicts(
  areas: readonly Area[],
  scopes: readonly Scope[],
  rules: readonly ScopeRule[] = [],
  order?: readonly string[],
): readonly ScopeConflict[] {
  const list = order ?? scopes.map((scope) => scope.id);
  const pairs = new Map<string, ScopeConflict>();
  for (const area of areas) {
    const hits = scopeCrossings(area, scopes).filter((entry) => entry.share > 0).map((entry) => entry.scopeId);
    for (let i = 0; i < hits.length; i += 1) {
      for (let j = i + 1; j < hits.length; j += 1) {
        const a = hits[i]!;
        const b = hits[j]!;
        const key = [a, b].sort().join('|');
        if (pairs.has(key)) continue;
        pairs.set(key, { a, b, dominance: resolveDominance(rules, list, a, b) });
      }
    }
  }
  return [...pairs.values()];
}

/* ------------------------------------------------------------- детализация */

export interface DetailSet {
  readonly ids: readonly string[];
  readonly has: (id: string) => boolean;
}

/** Набор детализации — глобальная настройка редактора (часть 3 §5). */
export function createDetailSet(ids: readonly string[]): DetailSet {
  const set = new Set(ids);
  return { ids: [...set], has: (id: string) => set.has(id) };
}

export function addDetail(set: DetailSet, id: string): DetailSet {
  if (set.has(id)) return set;
  return createDetailSet([...set.ids, id]);
}

export function renameDetail(set: DetailSet, from: string, to: string): DetailSet {
  if (!set.has(from)) return set;
  return createDetailSet(set.ids.map((id) => (id === from ? to : id)));
}

/** `band` связан с полосами пограничного мира: удалить его можно, но не молча. */
export function removeDetail(set: DetailSet, id: string): { readonly set: DetailSet; readonly removedBand: boolean } {
  if (!set.has(id)) return { set, removedBand: false };
  return { set: createDetailSet(set.ids.filter((entry) => entry !== id)), removedBand: id === 'band' };
}
