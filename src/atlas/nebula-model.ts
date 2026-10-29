/** Данные и чистые операции будущего редактора. Мировые координаты, не пиксели экрана. */
import type { Point, SectorBounds } from './sector-bounds.ts';

export interface NebulaPattern {
  readonly seed: string;
  readonly scale: number;
  readonly rotation: number;
  readonly offset: Point;
}
export interface NebulaBlink {
  readonly enabled: boolean;
  /** Время полного цикла, мс. */
  readonly intervalMs: number;
  /** Множители плотности облака от 0 до 4; 1 — обычная яркость. */
  readonly min: number;
  readonly max: number;
  /** Начальная фаза в долях цикла. */
  readonly phase: number;
}
export interface NebulaBrushStroke {
  readonly points: readonly Point[];
  readonly radius: number;
  /** 0 — мягкий край, 1 — жёсткий. */
  readonly hardness: number;
  readonly opacity: number;
  readonly color: string;
}
export interface NebulaModel {
  readonly id: string;
  /** Замкнутое кольцо; промежуточные точки — управляющие вершины сглаженного контура. */
  readonly points: readonly Point[];
  readonly color: string;
  readonly pattern: NebulaPattern;
  readonly blink: NebulaBlink;
  readonly strokes: readonly NebulaBrushStroke[];
}

function point(p: Point): Point {
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new RangeError('Координаты должны быть конечными');
  return [p[0], p[1]];
}
function color(value: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new RangeError('Цвет должен быть в формате #rrggbb');
  return value.toLowerCase();
}
function inRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}
function ring(points: readonly Point[]): Point[] {
  const result = points.map(point);
  while (result.length > 1 && result[0]![0] === result.at(-1)![0] && result[0]![1] === result.at(-1)![1]) result.pop();
  if (result.length < 3 || new Set(result.map(([x, y]) => `${x},${y}`)).size < 3) throw new RangeError('Нужны как минимум три различные вершины');
  return [...result, point(result[0]!)];
}
function validPattern(pattern: NebulaPattern): NebulaPattern {
  if (!pattern.seed || !Number.isFinite(pattern.scale) || pattern.scale <= 0 || !Number.isFinite(pattern.rotation)) throw new RangeError('Некорректный паттерн');
  return { ...pattern, offset: point(pattern.offset) };
}
export function validBlink(blink: NebulaBlink): NebulaBlink {
  if (typeof blink.enabled !== 'boolean' || !Number.isFinite(blink.intervalMs) || blink.intervalMs <= 0 || !inRange(blink.min, 0, 4) || !inRange(blink.max, blink.min, 4) || !Number.isFinite(blink.phase)) throw new RangeError('Некорректные настройки мигания');
  return { ...blink };
}
function validStroke(stroke: NebulaBrushStroke): NebulaBrushStroke {
  if (stroke.points.length === 0 || !Number.isFinite(stroke.radius) || stroke.radius <= 0 || !inRange(stroke.hardness, 0, 1) || !inRange(stroke.opacity, 0, 1)) throw new RangeError('Некорректная кисть');
  return { ...stroke, color: color(stroke.color), points: stroke.points.map(point) };
}

/** По умолчанию берём геометрию сектора, но допускаем любую замкнутую область, в том числе вне сектора. */
export function createNebula(id: string, bounds: SectorBounds, points?: readonly Point[]): NebulaModel {
  if (!id.trim()) throw new RangeError('Требуется id туманности');
  const sector = bounds.bounds.find((item) => item.id === 'sector.outline' && item.kind === 'sector');
  const outline = points ?? sector?.points;
  if (!outline) throw new RangeError('Контур сектора отсутствует');
  return {
    id, points: ring(outline), color: '#5796a6',
    pattern: { seed: 'KP', scale: 1, rotation: 0, offset: [0, 0] },
    blink: { enabled: false, intervalMs: 3000, min: 0.5, max: 1, phase: 0 }, strokes: [],
  };
}
export function setNebulaOutline(model: NebulaModel, points: readonly Point[]): NebulaModel {
  return { ...model, points: ring(points) };
}
export function moveNebulaVertex(model: NebulaModel, index: number, position: Point): NebulaModel {
  const vertices = model.points.slice(0, -1).map(point);
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) throw new RangeError('Неизвестная вершина');
  vertices[index] = point(position);
  return setNebulaOutline(model, vertices);
}
export function insertNebulaVertex(model: NebulaModel, after: number, position: Point): NebulaModel {
  const vertices = model.points.slice(0, -1).map(point);
  if (!Number.isInteger(after) || after < 0 || after >= vertices.length) throw new RangeError('Неизвестное ребро');
  vertices.splice(after + 1, 0, point(position));
  return setNebulaOutline(model, vertices);
}
export function removeNebulaVertex(model: NebulaModel, index: number): NebulaModel {
  const vertices = model.points.slice(0, -1).map(point);
  if (!Number.isInteger(index) || index < 0 || index >= vertices.length) throw new RangeError('Неизвестная вершина');
  vertices.splice(index, 1);
  return setNebulaOutline(model, vertices);
}
/** Мягкий сдвиг вершин кистью; линия замкнута автоматически. */
export function deformNebula(model: NebulaModel, center: Point, radius: number, delta: Point): NebulaModel {
  const origin = point(center); const movement = point(delta);
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Радиус должен быть положительным');
  if (movement[0] === 0 && movement[1] === 0) return model;
  const vertices = model.points.slice(0, -1).map(point);
  // Если кисть касается длинного ребра вдали от его вершин, добавляем управляющую точку.
  let nearest = Infinity; let after = -1; let closest: Point = origin;
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i]!; const b = vertices[(i + 1) % vertices.length]!;
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((origin[0] - a[0]) * dx + (origin[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const p: Point = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - origin[0], p[1] - origin[1]);
    if (d < nearest) { nearest = d; after = i; closest = p; }
  }
  if (nearest < radius && vertices.every((p) => Math.hypot(p[0] - closest[0], p[1] - closest[1]) > radius * 0.1)) vertices.splice(after + 1, 0, closest);
  return setNebulaOutline(model, vertices.map((p): Point => {
    const t = Math.max(0, 1 - Math.hypot(p[0] - origin[0], p[1] - origin[1]) / radius);
    const weight = t * t * (3 - 2 * t);
    return [p[0] + movement[0] * weight, p[1] + movement[1] * weight];
  }));
}
export function setNebulaPattern(model: NebulaModel, pattern: NebulaPattern): NebulaModel {
  return { ...model, pattern: validPattern(pattern) };
}
export function setNebulaBlink(model: NebulaModel, blink: NebulaBlink): NebulaModel {
  return { ...model, blink: validBlink(blink) };
}
export function setNebulaColor(model: NebulaModel, value: string): NebulaModel {
  return { ...model, color: color(value) };
}
export function addNebulaStroke(model: NebulaModel, stroke: NebulaBrushStroke): NebulaModel {
  return { ...model, strokes: [...model.strokes, validStroke(stroke)] };
}

/** Непрерывная периодическая яркость без таймеров; вызывающий код подаёт время в мс. */
export function nebulaBlinkIntensity(blink: NebulaBlink, timeMs: number): number {
  validBlink(blink);
  if (!Number.isFinite(timeMs)) throw new RangeError('Время должно быть конечным');
  if (!blink.enabled) return 1;
  const phase = ((timeMs / blink.intervalMs + blink.phase) % 1 + 1) % 1;
  return blink.min + (blink.max - blink.min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
}
/** Преобразование мировых координат для детерминированного паттерна; seed хранится отдельно. */
export function nebulaPatternPoint(pattern: NebulaPattern, world: Point): Point {
  const p = validPattern(pattern);
  const [x, y] = point(world);
  const c = Math.cos(p.rotation); const s = Math.sin(p.rotation);
  const dx = x - p.offset[0]; const dy = y - p.offset[1];
  return [(c * dx + s * dy) / p.scale, (-s * dx + c * dy) / p.scale];
}
function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
/** Цвет кисти в точке: последовательные мазки смешиваются с базовым цветом. */
export function nebulaColorAt(model: NebulaModel, world: Point): readonly [number, number, number] {
  const p = point(world);
  const rgb = (value: string): number[] => [1, 3, 5].map((i) => parseInt(color(value).slice(i, i + 2), 16));
  let result = rgb(model.color);
  for (const raw of model.strokes) {
    const stroke = validStroke(raw);
    let distance = Math.hypot(p[0] - stroke.points[0]![0], p[1] - stroke.points[0]![1]);
    for (let i = 1; i < stroke.points.length; i++) distance = Math.min(distance, distanceToSegment(p, stroke.points[i - 1]!, stroke.points[i]!));
    const inner = stroke.radius * stroke.hardness;
    const t = distance <= inner ? 1 : Math.max(0, Math.min(1, (stroke.radius - distance) / (stroke.radius - inner || 1)));
    const alpha = stroke.opacity * t * t * (3 - 2 * t);
    const next = rgb(stroke.color);
    result = result.map((v, i) => v + (next[i]! - v) * alpha);
  }
  return [Math.round(result[0]!), Math.round(result[1]!), Math.round(result[2]!)];
}
