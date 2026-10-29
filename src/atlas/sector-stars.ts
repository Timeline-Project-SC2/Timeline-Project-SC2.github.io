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
