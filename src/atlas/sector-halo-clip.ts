import type { Point, SmoothedPolyline } from './sector-bounds.ts';

interface Curve { readonly start: Point; readonly control: Point; readonly end: Point; }
export interface HaloRun { readonly start: Point; readonly offset: number; readonly curves: Curve[]; }

const NODES = [0.0950125098376374, 0.281603550779259, 0.4580167776572274, 0.6178762444026438, 0.755404408355003, 0.8656312023878318, 0.9445750230732326, 0.9894009349916499];
const WEIGHTS = [0.1894506104550685, 0.1826034150449236, 0.1691565193950025, 0.1495959888165767, 0.1246289712555339, 0.0951585116824928, 0.0622535239386479, 0.0271524594117541];

function midpoint(a: Point, b: Point): Point { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

/** Длина квадратичной кривой: 16-точечная квадратура, без зависимости от положения камеры. */
function length(curve: Curve): number {
  const ax = curve.control[0] - curve.start[0];
  const ay = curve.control[1] - curve.start[1];
  const bx = curve.end[0] - 2 * curve.control[0] + curve.start[0];
  const by = curve.end[1] - 2 * curve.control[1] + curve.start[1];
  let sum = 0;
  for (let i = 0; i < NODES.length; i++) {
    const t1 = (1 - NODES[i]!) / 2;
    const t2 = (1 + NODES[i]!) / 2;
    sum += WEIGHTS[i]! * (Math.hypot(ax + bx * t1, ay + by * t1) + Math.hypot(ax + bx * t2, ay + by * t2));
  }
  return sum;
}

/**
 * Разбиваем только вдали от экрана. Пропущенная длина задаёт фазу пунктира;
 * соседние видимые части объединяем, чтобы не создавать швов внутри кадра.
 */
export function clipHalo(path: SmoothedPolyline, width: number, height: number): HaloRun[] {
  const margin = 128;
  const limit = Math.max(width, height, 1) * 2 + margin * 2;
  const runs: HaloRun[] = [];
  let active: HaloRun | null = null;
  let distance = 0;
  function visit(curve: Curve, depth: number): void {
    const xs = [curve.start[0], curve.control[0], curve.end[0]];
    const ys = [curve.start[1], curve.control[1], curve.end[1]];
    const minX = Math.min(...xs); const maxX = Math.max(...xs);
    const minY = Math.min(...ys); const maxY = Math.max(...ys);
    if (maxX < -margin || minX > width + margin || maxY < -margin || minY > height + margin) {
      active = null;
      distance += length(curve);
      return;
    }
    if (depth < 32 && (maxX - minX > limit || maxY - minY > limit)) {
      const a = midpoint(curve.start, curve.control);
      const b = midpoint(curve.control, curve.end);
      const m = midpoint(a, b);
      visit({ start: curve.start, control: a, end: m }, depth + 1);
      visit({ start: m, control: b, end: curve.end }, depth + 1);
      return;
    }
    if (active === null) {
      active = { start: curve.start, offset: distance, curves: [] };
      runs.push(active);
    }
    active.curves.push(curve);
    distance += length(curve);
  }
  let start = path.start;
  for (const segment of path.curves) {
    visit({ start, control: segment.control, end: segment.end }, 0);
    start = segment.end;
  }
  if (path.tail !== null) visit({ start, control: midpoint(start, path.tail), end: path.tail }, 0);
  return runs;
}
