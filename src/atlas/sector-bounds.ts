export type Point = readonly [number, number];
export type Polyline = readonly Point[];
export interface BoundsStyle { readonly strokeWidth: number; readonly dash: readonly number[]; readonly color: 'nebula' | 'tactical'; }
export interface BoundsPrimitive { readonly id: string; readonly kind: 'sector' | 'halo' | 'nebula'; readonly style: BoundsStyle; readonly label: string; readonly points: Polyline; readonly cells?: readonly Point[]; }
export interface SectorBounds { readonly version: number; readonly mapSize: 10000; readonly source: string; readonly bounds: readonly BoundsPrimitive[]; }
export interface Camera { readonly x: number; readonly y: number; readonly scale: number; }
export interface Viewport { readonly width: number; readonly height: number; }

function invalid(message: string): never { throw new RangeError(`Некорректные границы сектора: ${message}`); }
export function parseBounds(json: unknown): SectorBounds {
  let value: unknown = json;
  if (typeof json === 'string') { try { value = JSON.parse(json) as unknown; } catch { return invalid('ошибка JSON.'); } }
  if (value === null || typeof value !== 'object') return invalid('ожидался объект.');
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || root.mapSize !== 10000 || typeof root.source !== 'string' || !Array.isArray(root.bounds)) return invalid('неверная версия, размер карты или список контуров.');
  const items: BoundsPrimitive[] = root.bounds.map((raw: unknown) => {
    if (raw === null || typeof raw !== 'object') return invalid('контур должен быть объектом.');
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !['sector', 'halo', 'nebula'].includes(String(item.kind)) || typeof item.label !== 'string' || !Array.isArray(item.points)) return invalid('неверные поля контура.');
    const kind = item.kind as BoundsPrimitive['kind'];
    const style = item.style as Record<string, unknown> | null;
    if (style === null || typeof style !== 'object' || typeof style.strokeWidth !== 'number' || !Array.isArray(style.dash) || !['nebula', 'tactical'].includes(String(style.color))) return invalid('неверный стиль контура.');
    const points: Point[] = item.points.map((p: unknown) => {
      if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || (p[0] as number) < 0 || (p[0] as number) > 10000 || (p[1] as number) < 0 || (p[1] as number) > 10000) return invalid('координата вне диапазона 0…10000 или NaN.');
      return [p[0] as number, p[1] as number];
    });
    if (kind !== 'halo' && (points.length < 4 || points[0]?.[0] !== points[points.length - 1]?.[0] || points[0]?.[1] !== points[points.length - 1]?.[1])) return invalid('замкнутый контур должен иметь минимум 3 вершины и совпадающие начало/конец.');
    if (kind === 'halo' && points.length < 2) return invalid('линия гало должна иметь минимум 2 точки.');
    return { id: item.id, kind, style: { strokeWidth: style.strokeWidth as number, dash: style.dash as number[], color: style.color as BoundsStyle['color'] }, label: item.label, points };
  });
  return { version: 1, mapSize: 10000, source: root.source, bounds: items };
}
export function polygonAt(bounds: SectorBounds, id: string): Polyline | null { return bounds.bounds.find((p) => p.id === id && p.kind !== 'halo')?.points ?? null; }
export function pointInPolygon(polygon: Polyline, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) { const a = polygon[i]; const b = polygon[j]; if (a !== undefined && b !== undefined && ((a[1] > y) !== (b[1] > y)) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside; }
  return inside;
}
export function distanceToRing(polygon: Polyline, x: number, y: number): number {
  let min = Infinity;
  for (let i = 1; i < polygon.length; i++) { const a = polygon[i - 1]; const b = polygon[i]; if (a === undefined || b === undefined) continue; const dx = b[0] - a[0]; const dy = b[1] - a[1]; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1))); min = Math.min(min, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)); }
  return min;
}
export function clipPolylineToViewport(line: Polyline, camera: Camera, viewport: Viewport): Point[] {
  return line.filter(([x, y]) => { const sx = (x - camera.x) * camera.scale; const sy = (y - camera.y) * camera.scale; return sx >= 0 && sx <= viewport.width && sy >= 0 && sy <= viewport.height; });
}
export function enumerate(bounds: SectorBounds): BoundsPrimitive[] { return [...bounds.bounds]; }
