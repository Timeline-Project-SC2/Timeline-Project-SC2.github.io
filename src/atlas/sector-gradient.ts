/* Общая цветовая арифметика для будущих окрашенных областей сектора.
 * Геометрия столкновения и редактор пока не определены: модуль ничего не рисует.
 */
import { parseHexColor } from './config.ts';

export type Rgb = readonly [number, number, number];
export interface GradientStop {
  readonly offset: number;
  readonly rgb: Rgb;
}

/** Источник цвета: фракционный или произвольный #rrggbb, уже выбранный вызывающим кодом. */
export interface ColorAnchor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly color: string;
}

/**
 * Детерминированная ближайшая пара разных цветов, как в прежнем слое сетей.
 * При одном цвете оба стопа одинаковы; отсутствие источников даёт пустой массив.
 * При равных расстояниях числовые ID идут первыми по числовому значению,
 * затем текстовые по строке; одинаковые числовые значения — также по строке.
 * Уникальность проверяется по точному значению строки ID.
 * Это только выбор цветов, а не определение геометрии столкновения областей.
 */
export function nearestColorStops(anchors: readonly ColorAnchor[]): readonly GradientStop[] {
  const ids = new Set<string>();
  const points = anchors.map((anchor) => {
    const rgb = parseHexColor(anchor.color);
    if (!anchor.id || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || rgb === null) {
      throw new RangeError('Цветовой якорь: нужны id, конечные координаты и цвет #rrggbb');
    }
    if (ids.has(anchor.id)) throw new RangeError('Цветовой якорь: id должен быть уникальным');
    ids.add(anchor.id);
    return { ...anchor, rgb, colorKey: anchor.color.trim().toLowerCase() };
  }).sort((a, b) => {
    const numberA = Number(a.id);
    const numberB = Number(b.id);
    const numericA = a.id.trim() !== '' && Number.isFinite(numberA);
    const numericB = b.id.trim() !== '' && Number.isFinite(numberB);
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (numericA && numericB && numberA !== numberB) return numberA < numberB ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (points.length === 0) return [];
  let first = points[0]!;
  let second = first;
  let distance = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i]!;
      const b = points[j]!;
      if (a.colorKey === b.colorKey) continue;
      const candidate = Math.hypot(a.x - b.x, a.y - b.y);
      if (candidate < distance - 1e-9) {
        distance = candidate;
        first = a;
        second = b;
      }
    }
  }
  return [{ offset: 0, rgb: first.rgb }, { offset: 1, rgb: second.rgb }];
}

/** Линейная интерполяция по упорядоченным стопам; крайние значения ограничены. */
export function sampleGradient(stops: readonly GradientStop[], t: number): Rgb {
  if (stops.length === 0) return [0, 0, 0];
  const first = stops[0]!;
  if (stops.length === 1) return first.rgb;
  const clamped = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]!;
    const next = stops[index]!;
    if (clamped <= next.offset) {
      const span = next.offset - previous.offset;
      const local = span <= 0 ? 1 : (clamped - previous.offset) / span;
      const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
      return [mix(previous.rgb[0], next.rgb[0]), mix(previous.rgb[1], next.rgb[1]), mix(previous.rgb[2], next.rgb[2])];
    }
  }
  return stops[stops.length - 1]!.rgb;
}
