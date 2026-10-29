import { rng } from './config.ts';

/** Звёзды живут в мировых координатах, а их радиусы — в CSS-пикселях. */
export interface BackgroundStar { readonly x: number; readonly y: number; }
export interface StarGroup { readonly radius: number; readonly alpha: number; readonly stars: readonly BackgroundStar[]; }

/** Координаты нормированы на сторону карты; каталог повторяется в соседних картах. */
export function createStarGroups(): readonly StarGroup[] {
  const random = rng(100000);
  const radii = [0.45, 0.65, 0.85, 1.05];
  const alphas = [0.16, 0.26, 0.42, 0.65];
  const groups = radii.flatMap((radius) => alphas.map((alpha) => ({ radius, alpha, stars: [] as BackgroundStar[] })));
  for (let i = 0; i < 6000; i++) {
    const x = random(); const y = random();
    // Большинство звёзд слабые и небольшие; редкие заметнее.
    const r = Math.min(3, Math.floor(random() ** 2 * 4));
    const a = Math.min(3, Math.floor(random() ** 2 * 4));
    groups[r * alphas.length + a]!.stars.push({ x, y });
  }
  return groups;
}

/** Дополнительные слои не хранят миллионы точек: звёзды вычисляются по ячейкам мира. */
export interface StarLayer {
  readonly cellsPerMap: number;
  /** Полная видимая ширина мира, на которой слой начинает проявляться. */
  readonly startWidth: number;
  /** Полная видимая ширина, на которой слой полностью проявился. */
  readonly fullWidth: number;
  readonly seed: number;
}
export interface StarWorldRect { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; }

export const DEPTH_STAR_LAYERS: readonly StarLayer[] = Object.freeze([
  Object.freeze({ cellsPerMap: 500, startWidth: 3200, fullWidth: 1600, seed: 0x1c936c35 }),
  Object.freeze({ cellsPerMap: 5000, startWidth: 320, fullWidth: 160, seed: 0x7261c452 }),
  Object.freeze({ cellsPerMap: 50000, startWidth: 32, fullWidth: 16, seed: 0x48a1fa2d }),
  Object.freeze({ cellsPerMap: 250000, startWidth: 6.4, fullWidth: 3.2, seed: 0xb39d2f81 }),
]);

/** Плавное проявление по логарифмическому масштабу; уже проявленный слой остаётся. */
export function depthStarOpacity(layer: StarLayer, visibleWidth: number): number {
  if (!Number.isFinite(visibleWidth) || visibleWidth <= 0) return 0;
  const progress = Math.max(0, Math.min(1, Math.log(layer.startWidth / visibleWidth) / Math.log(layer.startWidth / layer.fullWidth)));
  return progress * progress * (3 - 2 * progress);
}

function wrapCell(value: number, count: number): number { return ((value % count) + count) % count; }
function cellRandom(x: number, y: number, seed: number): number {
  let value = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca6b) ^ seed) >>> 0;
  value = Math.imul(value ^ (value >>> 15), 0x2c1b3c6d) >>> 0;
  value = Math.imul(value ^ (value >>> 12), 0x297a2d39) >>> 0;
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

/**
 * Выдаёт только звёзды видимой области: положение и стиль зависят от ячейки,
 * а не камеры. Решётка периодична по карте, как базовое поле.
 */
export function forEachDepthStar(
  layer: StarLayer, mapSize: number, rect: StarWorldRect,
  visit: (x: number, y: number, group: number) => void,
): void {
  if (!(Number.isFinite(mapSize) && mapSize > 0) ||
      ![rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) ||
      rect.left > rect.right || rect.top > rect.bottom) return;
  const count = layer.cellsPerMap;
  const cellSize = mapSize / count;
  for (let iy = Math.floor(rect.top / cellSize); iy <= Math.floor(rect.bottom / cellSize); iy++) {
    const cy = wrapCell(iy, count);
    for (let ix = Math.floor(rect.left / cellSize); ix <= Math.floor(rect.right / cellSize); ix++) {
      const cx = wrapCell(ix, count);
      if (cellRandom(cx, cy, layer.seed) >= 0.3) continue;
      const x = (ix + cellRandom(cx, cy, layer.seed ^ 0x19a7423d)) * cellSize;
      const y = (iy + cellRandom(cx, cy, layer.seed ^ 0x6fe3ab21)) * cellSize;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      const r = cellRandom(cx, cy, layer.seed ^ 0x4c28de51);
      const a = cellRandom(cx, cy, layer.seed ^ 0x5b481ed7);
      const group = Math.floor(r * r * 4) * 4 + Math.floor(a * a * 4);
      visit(x, y, group);
    }
  }
}
