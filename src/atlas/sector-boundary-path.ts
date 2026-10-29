import { smoothPolyline } from './sector-bounds.ts';
import type { Point, QuadraticSegment, SmoothedPolyline } from './sector-bounds.ts';

interface MapRect { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; }
function mid(a: Point, b: Point): Point { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

/** Скругляет контур, сохраняя участки, которые совпадают с краем карты. */
export function smoothBoundaryAtMapEdge(line: readonly Point[], rect: MapRect): SmoothedPolyline {
  const points = [...line];
  while (points.length > 1 && points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1]) points.pop();
  if (points.length < 3) return smoothPolyline(line, true);
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-5;
  const onSameEdge = (a: Point, b: Point): boolean =>
    (near(a[0], rect.left) && near(b[0], rect.left)) ||
    (near(a[0], rect.right) && near(b[0], rect.right)) ||
    (near(a[1], rect.top) && near(b[1], rect.top)) ||
    (near(a[1], rect.bottom) && near(b[1], rect.bottom));
  const edges = points.map((p, i) => onSameEdge(p, points[(i + 1) % points.length]!));
  if (!edges.some(Boolean)) return smoothPolyline(line, true);
  const start = edges.at(-1) ? points[0]! : mid(points.at(-1)!, points[0]!);
  const curves: QuadraticSegment[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const next = points[(i + 1) % points.length]!;
    curves.push({ control: p, end: edges[i] ? p : mid(p, next) });
    // Квадратичная кривая с контрольной точкой посередине — точная прямая.
    if (edges[i]) curves.push({ control: mid(p, next), end: next });
  }
  return { start, curves, tail: null, closed: true };
}
