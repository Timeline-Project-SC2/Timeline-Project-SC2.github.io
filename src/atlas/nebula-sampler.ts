/** Связь будущих настроек паттерна с существующим процедурным полем. */
import { hashSeed, sampleNebulaDensity } from './sector-field.ts';
import type { FieldStyle, SectorFieldState } from './sector-field.ts';
import { nebulaPatternPoint } from './nebula-model.ts';
import type { NebulaPattern } from './nebula-model.ts';
import type { Point } from './sector-bounds.ts';

/** Детерминированный образец облака; изменение seed сдвигает его в мировом поле. */
export function sampleNebulaPattern(pattern: NebulaPattern, state: SectorFieldState, world: Point, style: FieldStyle = 'nebula'): number {
  const [x, y] = nebulaPatternPoint(pattern, world);
  const shiftX = (hashSeed(pattern.seed + ':x') - hashSeed('KP:x')) / 0x100000000 * state.mapSize;
  const shiftY = (hashSeed(pattern.seed + ':y') - hashSeed('KP:y')) / 0x100000000 * state.mapSize;
  return sampleNebulaDensity(state, x + shiftX, y + shiftY, style);
}
