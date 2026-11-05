/* LOD и округлость областей редактора (§7 части 2 плана).
 *
 * `effectiveLevel = clamp(currentLevel + lodBias, visibleFrom..visibleTo, 0..12)`.
 * Допуск упрощения пропорционален видимой ширине уровня и ослабляется смещением:
 * `eps = EPS_RATIO · visibleWidth(level) / LEVEL_STEP^bias`.
 * Упрощение — RDP, сглаживание — Chaikin; результат кэшируется по
 * `(areaId, level, rounding, bucket)` и детерминирован для одного входа.
 */

import { LEVEL_STEP, visibleWidthForLevel } from './level-ladder.ts';
import { MAX_LEVEL, MIN_LEVEL } from './sector-areas-contract.ts';
import type { Area, AreaState, Rounding } from './sector-areas-contract.ts';
import { parametrize, simplify, smooth } from './sector-areas-geometry.ts';
import type { ParametrizedRing } from './sector-areas-geometry.ts';

/** Доля видимой ширины уровня, равная допуску упрощения. */
export const EPS_RATIO = 0.002;

export interface LodPreset {
  readonly id: string;
  readonly label: string;
  readonly lodBias: number;
  readonly rounding: Rounding;
}

/** Пресеты админ-панели: `−1 L`, `0`, `+1 L`; advanced — раздельные ползунки. */
export const LOD_PRESETS: readonly LodPreset[] = Object.freeze([
  Object.freeze({ id: 'lod-minus', label: '−1 L', lodBias: -1, rounding: 0 }),
  Object.freeze({ id: 'lod-base', label: '0', lodBias: 0, rounding: 1 }),
  Object.freeze({ id: 'lod-plus', label: '+1 L', lodBias: 1, rounding: 2 }),
]);

export function lodPreset(id: string): LodPreset | null {
  return LOD_PRESETS.find((preset) => preset.id === id) ?? null;
}

/** Число проходов Шайкина для степени округлости `0…2`. */
export function roundingIterations(rounding: Rounding): number {
  return Math.max(0, Math.min(2, Math.round(rounding)));
}

/** Глубина, на которой состояние показывается с учётом диапазона и смещения. */
export function effectiveLevel(currentLevel: number, state: AreaState): number {
  const from = Math.max(MIN_LEVEL, state.visibleFrom);
  const to = Math.min(MAX_LEVEL, state.visibleTo);
  if (!(to >= from)) return from;
  const raw = Number.isFinite(currentLevel) ? currentLevel + state.lodBias : from;
  return Math.max(from, Math.min(to, raw));
}

/** Допуск RDP в мировых единицах для уровня и смещения детализации. */
export function lodEpsilon(level: number, bias: number): number {
  const clamped = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level));
  const width = visibleWidthForLevel(clamped);
  const factor = LEVEL_STEP ** (Number.isFinite(bias) ? bias : 0);
  return (EPS_RATIO * width) / (factor === 0 ? 1 : factor);
}

export interface LodGeometry {
  readonly areaId: string;
  readonly level: number;
  readonly rounding: Rounding;
  readonly rings: readonly ParametrizedRing[];
  /** `true` — геометрия взята из кэша, а не пересчитана. */
  readonly cached: boolean;
}

export function lodKey(areaId: string, level: number, rounding: Rounding, viewportBucket = 0): string {
  return `${areaId}|${level.toFixed(4)}|${rounding}|${viewportBucket}`;
}

/** Групба ширины кадра: степень двойки, чтобы кэш не рос от каждого пикселя. */
export function viewportBucket(visibleWidth: number): number {
  if (!Number.isFinite(visibleWidth) || visibleWidth <= 0) return 0;
  return Math.round(Math.log2(visibleWidth) * 4);
}

export interface LodCache {
  get(key: string): LodGeometry | undefined;
  set(key: string, value: LodGeometry): void;
  clear(): void;
  readonly size: number;
}

export function createLodCache(): LodCache {
  const store = new Map<string, LodGeometry>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: LodGeometry) => {
      store.set(key, value);
    },
    clear: () => store.clear(),
    get size(): number {
      return store.size;
    },
  };
}

/**
 * Считает геометрию области: `level` — уровень кадра, `bias` — смещение
 * детализации. Допуск берётся от эффективного уровня `level + bias`, поэтому
 * `+1 L` даёт более мелкий допуск (больше деталей), а `−1 L` — более крупный.
 */
export function computeLod(
  area: Area,
  level: number,
  rounding: Rounding,
  bias = 0,
  cache?: LodCache,
  viewportWidth?: number,
): LodGeometry {
  const effective = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level + bias));
  const bucket = viewportWidth === undefined ? 0 : viewportBucket(viewportWidth);
  const key = lodKey(area.id, effective, rounding, bucket);
  if (cache !== undefined) {
    const hit = cache.get(key);
    if (hit !== undefined) return { ...hit, cached: true };
  }

  const eps = lodEpsilon(level, bias);
  const passes = roundingIterations(rounding);
  const rings = area.rings.map((ring) => {
    const base = parametrize(ring, area.closed);
    const reduced = simplify(base, eps);
    return passes > 0 ? smooth(reduced, passes) : reduced;
  });

  const geometry: LodGeometry = { areaId: area.id, level: effective, rounding, rings, cached: false };
  if (cache !== undefined) cache.set(key, geometry);
  return geometry;
}

/**
 * Геометрия состояния: эффективный уровень учитывает `lodBias` и диапазон
 * `visibleFrom…visibleTo`; округлость берётся из состояния.
 */
export function lodForState(
  area: Area,
  state: AreaState,
  currentLevel: number,
  cache?: LodCache,
  viewportWidth?: number,
): LodGeometry {
  const effective = effectiveLevel(currentLevel, state);
  return computeLod(area, currentLevel, state.rounding, effective - currentLevel, cache, viewportWidth);
}

/** Превью `L−1 / L / L+1` для админ-панели; вне лестницы — `S0…S2` не берутся. */
export function lodPreviewLevels(level: number): readonly number[] {
  const base = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));
  return [Math.max(MIN_LEVEL, base - 1), base, Math.min(MAX_LEVEL, base + 1)];
}
