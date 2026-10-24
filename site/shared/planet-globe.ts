/* PlanetGlobe — боевой WebGL2-глобус планеты (Этап 6, CR-01 PR 4).
   =========================================================================
   Строгий TS-порт planet-globe.js. Модуль не вычисляет географию: он
   принимает готовую сетку `goldberg-gp-v1` и поверхность `c100-soft-v2`
   и превращает их в индексированную геометрию гексагональных ячеек,
   chunk-диапазоны отсечения, цвета слоёв и WebGL2-рендер.

   Изменения PR 4 (раздел 6.1 плана): упаковку позиций и честных
   наклонных нормалей рельефа выполняет Wasm-ядро globePack. Вершина —
   24 байта: позиция f32×3 (12) + нормаль i16×4 normalized (8, атрибут
   aNormal, location=2) + цвет RGBA8 (4). Нормаль считается по
   смещённым высотам веера ячейки, поэтому склоны получают объёмную
   светотень без роста числа полигонов; плоский `normalize(aPos)`
   в шейдере убран. Расширение цветов по вершинам — ядро
   expandVertexColors, побитово повторяющее JS-округление.

   География и pick остаются авторитетно на CPU: рендер только
   сообщает направление луча, ячейку находит `GeodesicGrid.pick`.

   Stage-8.10a (A-12a): упаковка вершин и цветов перенесена в отдельный
   модуль вне главного потока; рендерер не импортирует Wasm-ядро и работает
   на данных, уже переданных воркером (см. «ГРАНИЦА МОДУЛЯ» ниже). */

import type { PlanetGrid } from './geodesic-grid.ts';
import type { SurfaceResult } from './planet-surface.ts';

export interface GlobeChunkRange {
  id: number;
  startCell: number;
  cellCount: number;
  indexStart: number;
  indexCount: number;
  center: number[];
  cosAngularRadius: number;
  sinAngularRadius: number;
}

export interface GlobeGeometry {
  version: string;
  v: number;
  cellCount: number;
  vertexCount: number;
  triangleCount: number;
  indexCount: number;
  positions: Float32Array;
  normals: Int16Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCellId: Uint32Array;
  cellIndexStart: Uint32Array;
  chunkRanges: GlobeChunkRange[];
  reliefScale: number;
  typedBytes: number;
}

export interface GlobeGeometryOptions {
  reliefScale?: number;
  colorMode?: string;
}

export interface CellPolygon {
  cell: number;
  center: number[];
  corners: number[][];
}

export interface EquirectPreview {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface GlobeStats {
  fps: number;
  p50: number;
  p95: number;
  p99: number;
  over50: number;
  over100: number;
  worst5: number[];
  renderScale: number;
  distance: number;
}

/** Кадровый контекст для хука onAfterSurfaceDraw (объём осколков / ядро). */
export interface FxFrameContext {
  mvp: Float32Array;
  model: Float32Array;
  normalMat: Float32Array;
  lightDir: Float32Array;
  eyePos: Float32Array;
  timeSec: number;
}

/** Опциональный FX-плагин рендера (CR-01 PR 5 / PR 6.1): экспериментальные
 *  режимы из planet-globe-fx (взрыв осколков Шакураса uSep, диагностические
 *  палитры, объём и ядро) подключаются только через это поле — без hooks
 *  глобус рисуется как раньше. */
export interface PlanetGlobeFxHooks {
  /** Декорирование исходников surface-шейдеров перед компиляцией. */
  decorateSurfaceShaders?: (src: { vs: string; fs: string }) => { vs: string; fs: string };
  /** После линковки surface-программы (найти uniform-локации плагина). */
  onSurfaceProgram?: (gl: WebGL2RenderingContext, program: WebGLProgram) => void;
  /** Перед отрисовкой поверхности каждого кадра (uniform-ы плагина). */
  onSurfaceDraw?: (gl: WebGL2RenderingContext, program: WebGLProgram) => void;
  /** После загрузки геометрии на GPU: клеточный индекс осколков / объём. */
  onGeometryReady?: (gl: WebGL2RenderingContext, grid: PlanetGrid, geometry: GlobeGeometry) => void;
  /** Сразу после поверхности, до атмосферы (объём осколков и ядро). */
  onAfterSurfaceDraw?: (gl: WebGL2RenderingContext, frame: FxFrameContext) => void;
  /** Освобождение GPU-ресурсов плагина. */
  onDispose?: (gl: WebGL2RenderingContext) => void;
}

export interface PlanetGlobeOptions {
  antialias?: boolean;
  autoRotate?: boolean;
  borders?: boolean;
  atmosphere?: boolean;
  maxPixelRatio?: number;
  fx?: PlanetGlobeFxHooks | null;
  onGeometryUploadProgress?: (info: { geometry: GlobeGeometry; fraction: number }) => void;
  onGeometryReady?: (geometry: GlobeGeometry) => void;
  onStats?: (stats: GlobeStats) => void;
  onHoverDirection?: (dir: number[]) => void;
  onPickDirection?: (dir: number[]) => void;
  onPickMiss?: () => void;
  onZoomChange?: (distance: number) => void;
  /** Stage-8.2: колесо мыши «вглубь» (deltaY < 0) при дистанции у нижней
   *  границы (targetDistance <= MIN_DISTANCE * 1.03) — сигнал «погрузиться»
   *  на локальный уровень выбранной ячейки. Не чаще одного раза в 500 мс. */
  onZoomDive?: () => void;
  /** Этап 7 (intent-based prefetch): debounced-уведомление (180 мс) об изменении
   *  ракурса/дистанции камеры (колесо, pinch, drag, flyToDirection). viewDirection —
   *  единичный вектор сферы в центре экрана, zoomRatio = 0 (далеко) … 1 (вплотную). */
  onCameraIntent?: (intent: {
    viewDirection: [number, number, number];
    distance: number;
    zoomRatio: number;
  }) => void;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/** Геометрия на входе transitionGeometry: полный GPU-бандл PlanetGlobe или
 *  wire-срез воркера (GlobeWireGeometry без vertexCellId/cellIndexStart). */
export type GlobeGeometryData =
  Omit<GlobeGeometry, 'vertexCellId' | 'cellIndexStart'> & {
    vertexCellId?: Uint32Array;
    cellIndexStart?: Uint32Array;
  };

/** Снимок ракурса камеры глобуса (Этап 7): углы и дистанция плюс единичный
 *  вектор сферы в центре экрана (направление от камеры к центру планеты). */
export interface GlobeCameraState {
  rotX: number;
  rotY: number;
  distance: number;
  viewDirection: [number, number, number];
}

export interface PlanetGlobeHandle {
  version: string;
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  setGeometry(nextGeometry: GlobeGeometry | null): void;
  setColors(colors: Uint8Array): void;
  setSelection(nextSelection: CellPolygon | null): void;
  clearSelection(): void;
  setBordersEnabled(enabled: boolean): void;
  setAutoRotate(enabled: boolean): void;
  setAtmosphereEnabled(enabled: boolean): void;
  setDistance(value: number): void;
  getDistance(): number;
  resetView(): void;
  pickDirection(clientX: number, clientY: number): number[] | null;
  setAdaptiveQualityHold(enabled: boolean): void;
  isGeometryUploading(): boolean;
  resetStats(): void;
  getStats(): GlobeStats;
  /** Каскадная сборка: uBuild в 0..1 (1 — планета полностью собрана). */
  setBuildProgress(value: number): void;
  /** Анимация uBuild от 0 до 1 за durationSec секунд. */
  animateBuild(durationSec: number): void;
  /** Двухслойное центробежное замещение: uCenterGrow 0..1, опционально uHide. */
  setCenterGrow(value: number, hideMask?: number): void;
  /** Этап 7: бесшовная подмена геометрии центробежной волной — уходящий слой
   *  сжимается (uHide = t), новый прорастает из центра взгляда (uCenterGrow = t)
   *  за durationSec секунд (по умолчанию 0.45, минимум 0.08) без перезапуска
   *  каскадной сборки с полюса и без «попа»; prev-слой освобождается сразу
   *  по завершении волны. */
  transitionGeometry(nextGeometry: GlobeGeometryData, durationSec?: number): void;
  /** Этап 7: плавный подлёт так, чтобы point сферы direction оказался ровно
   *  в центре экрана; опционально меняет дистанцию за durationMs (650 мс).
   *  Любой ручной жест (pointerdown / wheel) прерывает подлёт. */
  flyToDirection(direction: ArrayLike<number>, targetDistance?: number, durationMs?: number): void;
  /** Этап 7: текущий ракурс камеры (углы, дистанция и центр экрана на сфере). */
  getCameraState(): GlobeCameraState;
  dispose(): void;
}

const GLOBE_VERSION = 'planet-globe-v1';
const COLOR_MODES: { key: string; label: string }[] = [
  { key: 'biome', label: 'Биомы' },
  { key: 'rivers', label: 'Реки и озёра' },
  { key: 'elevation', label: 'Высота' },
  { key: 'moisture', label: 'Влажность' },
  { key: 'temperature', label: 'Температура' },
  { key: 'continents', label: 'Континенты' },
  { key: 'drainage', label: 'Дренажные регионы' },
  { key: 'mountains', label: 'Горы и швы' },
];

/* ------------------------------------------------------- ГРАНИЦА МОДУЛЯ
   Stage-8.10a (A-12a). В этом модуле остаётся только слой данных и рендера
   главного потока: buildCellColors, buildEquirectPreview, reliefDelta,
   cellPolygon, listGeometryTransferables, createPlanetGlobe. Всё считается
   по сетке и `SurfaceResult`, которые уже пришли из воркера; pick идёт через
   `GeodesicGrid.pick`. Упаковка позиций/нормалей/цветов вершин на полном
   Wasm-ядре вынесена из этого файла без реэкспорта. */

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : (x > hi ? hi : x); }
function clamp01(x: number): number { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function mix(a: number, b: number, t: number): number { return a + (b - a) * t; }
function mix3(out: Float32Array, offset: number, color: number[], t: number): void {
  out[offset] = mix(out[offset] as number, color[0] as number, t);
  out[offset + 1] = mix(out[offset + 1] as number, color[1] as number, t);
  out[offset + 2] = mix(out[offset + 2] as number, color[2] as number, t);
}
function ramp(stops: number[][], t: number, out: Float32Array, offset: number): Float32Array {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= ((stops[i] as number[])[0] as number) || i === stops.length - 1) {
      const a = stops[i - 1] as number[], b = stops[i] as number[];
      const f = (b[0] as number) > (a[0] as number) ? clamp01((t - (a[0] as number)) / ((b[0] as number) - (a[0] as number))) : 0;
      out[offset] = mix(a[1] as number, b[1] as number, f);
      out[offset + 1] = mix(a[2] as number, b[2] as number, f);
      out[offset + 2] = mix(a[3] as number, b[3] as number, f);
      return out;
    }
  }
  return out;
}
function hashInt(id: number, salt: number): number {
  let x = (Math.imul((id | 0) + 1, 0x9E3779B1) ^ Math.imul(salt | 0, 0x85EBCA6B)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7FEB352D);
  x ^= x >>> 15; x = Math.imul(x, 0x846CA68B);
  x ^= x >>> 16;
  return x >>> 0;
}
function hslToRgb(h: number, s: number, l: number, out: Float32Array, offset: number): void {
  h = ((h % 1) + 1) % 1;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 1 / 6) { r = c; g = x; }
  else if (h < 2 / 6) { r = x; g = c; }
  else if (h < 3 / 6) { g = c; b = x; }
  else if (h < 4 / 6) { g = x; b = c; }
  else if (h < 5 / 6) { r = x; b = c; }
  else { r = c; b = x; }
  out[offset] = r + m; out[offset + 1] = g + m; out[offset + 2] = b + m;
}
function hashColor(id: number, salt: number, out: Float32Array, offset: number, saturation: number, lightness: number): void {
  const h = hashInt(id, salt);
  hslToRgb((h % 360) / 360, saturation, lightness + ((h >>> 9) % 17 - 8) * 0.006, out, offset);
}

const ELEVATION_RAMP = [
  [0.00, 0.004, 0.035, 0.13], [0.38, 0.015, 0.16, 0.38],
  [0.49, 0.05, 0.48, 0.55], [0.505, 0.55, 0.68, 0.36],
  [0.62, 0.20, 0.52, 0.20], [0.78, 0.62, 0.50, 0.24],
  [0.92, 0.45, 0.38, 0.32], [1.00, 0.96, 0.97, 0.99],
];
const MOISTURE_RAMP = [
  [0.00, 0.48, 0.30, 0.12], [0.28, 0.78, 0.62, 0.25],
  [0.55, 0.42, 0.62, 0.24], [0.78, 0.08, 0.55, 0.34],
  [1.00, 0.04, 0.30, 0.72],
];
const TEMPERATURE_RAMP = [
  [0.00, 0.10, 0.20, 0.72], [0.25, 0.15, 0.65, 0.88],
  [0.48, 0.22, 0.72, 0.34], [0.68, 0.92, 0.82, 0.25],
  [0.86, 0.96, 0.42, 0.10], [1.00, 0.72, 0.08, 0.05],
];

/* ------------------------------------------------- ЕДИНАЯ ТАБЛИЦА МАСШТАБОВ
   W24. Клетка планетарного и стратегического уровня — одна клетка, и
   пропорция вертикали у обеих ветвей рельефа — из одного места. Таблицы ниже
   — единственный источник чисел: страница берёт из них радиус участка
   локальной карты, упаковщик GPU-геометрии (A-12a) импортирует `reliefDelta`
   отсюда и не держит своей копии коэффициентов, поэтому страница, CPU-полигоны
   и воркер читают одно и то же. Нормировка на размах поля
   (`(elevation − seaLevel) / span`) не меняется: множители задают только, во
   сколько раз размах ветви преувеличен относительно радиуса планеты.

   `GLOBE_CELL_SCALE` — каноническая клетка глобуса:
     planetRadiusKm          6 371 км, каноническая частота сетки v = 128;
     gridV / cellCount       v = 128, N = 10·v² + 2 = 163 842 клетки;
     cellAreaKm2             площадь равновеликой клетки, 3 113,1 км²;
     cellEdgeM               ребро равновеликого шестиугольника, 34,6 км;
     cellApothemM            апофема `a = √(A / 2√3)`, 30,0 км;
     cellCenterSpacingM      шаг центров соседних клеток `d = 2a`, 60,0 км;
     strategicHexStepRatio   `d_hex = 1,15 · R_patch` — то же отношение, что
                            `SKIRT_HEX_SPACING_RATIO` воркера и
                            `LOCAL_HEX_STEP_RATIO` страницы;
     strategicPatchRadiusM   радиус участка локальной карты `R = d / 1,15`
                            = 52,1 км. Прежние 2 500 м давали шаг 2 875 м —
                            сжатие 21× относительно глобуса.

   `GLOBE_RELIEF` — пропорция вертикали. Прежняя пара суша 0,022 / океан 0,008
   давала 2,75 в пользу суши, хотя дно глубже суши в 1,79 раза. Пара
   суша 0,012 / океан 0,0215 повторяет отношение истинных амплитуд поля высот
   (10 995 м против 6 147 м при K = 8 570 м/ед.) и даёт обеим ветвям одно и то
   же преувеличение 12,4×:
     0,012  · 6 371 000 / 6 147  = 12,44   (суша)
     0,0215 · 6 371 000 / 10 995 = 12,46   (океан)
   Окончательное число — за владельцем на визуальной приёмке, меняется здесь
   и только здесь. */
const CELL_PLANET_RADIUS_KM = 6371;
const CELL_GRID_V = 128;
const CELL_COUNT = 10 * CELL_GRID_V * CELL_GRID_V + 2;
const CELL_RADIUS_M = CELL_PLANET_RADIUS_KM * 1000;
const CELL_AREA_M2 = (4 * Math.PI * CELL_RADIUS_M * CELL_RADIUS_M) / CELL_COUNT;
const CELL_APOTHEM_M = Math.sqrt(CELL_AREA_M2 / (2 * Math.sqrt(3)));
const CELL_CENTER_SPACING_M = 2 * CELL_APOTHEM_M;
const STRATEGIC_HEX_STEP_RATIO = 1.15;

export const GLOBE_CELL_SCALE = {
  planetRadiusKm: CELL_PLANET_RADIUS_KM,
  gridV: CELL_GRID_V,
  cellCount: CELL_COUNT,
  cellAreaKm2: CELL_AREA_M2 / 1e6,
  cellEdgeM: Math.sqrt((2 * CELL_AREA_M2) / (3 * Math.sqrt(3))),
  cellApothemM: CELL_APOTHEM_M,
  cellCenterSpacingM: CELL_CENTER_SPACING_M,
  strategicHexStepRatio: STRATEGIC_HEX_STEP_RATIO,
  strategicPatchRadiusM: CELL_CENTER_SPACING_M / STRATEGIC_HEX_STEP_RATIO,
} as const;

export const GLOBE_RELIEF = {
  landMax: 0.012,
  oceanMax: 0.0215,
  landReliefM: 6147,
  oceanReliefM: 10995,
  verticalExaggeration: 12.4,
} as const;

/** Радиальное смещение клетки от единичного радиуса (обе ветви — из таблицы). */
export function reliefDelta(surface: SurfaceResult, elevation: number, reliefScale: number): number {
  const sea = surface.seaLevel || 0;
  if (elevation >= sea) {
    const span = Math.max(1e-9, (surface.elevationMax || sea) - sea);
    return clamp01((elevation - sea) / span) * GLOBE_RELIEF.landMax * reliefScale;
  }
  const depthSpan = Math.max(1e-9, sea - (surface.elevationMin || sea));
  return -clamp01((sea - elevation) / depthSpan) * GLOBE_RELIEF.oceanMax * reliefScale;
}

function buildCellColors(surface: SurfaceResult, mode?: string): Float32Array {
  mode = mode || 'biome';
  const n = surface.cellCount;
  const out = new Float32Array(n * 3);
  const sea = surface.seaLevel || 0;
  const minE = surface.elevationMin != null ? surface.elevationMin : -1;
  const maxE = surface.elevationMax != null ? surface.elevationMax : 1;
  for (let c = 0; c < n; c++) {
    const o = c * 3;
    if (mode === 'elevation') {
      const et = (surface.elevation[c] as number) >= sea
        ? 0.5 + 0.5 * clamp01(((surface.elevation[c] as number) - sea) / Math.max(1e-9, maxE - sea))
        : 0.5 - 0.5 * clamp01((sea - (surface.elevation[c] as number)) / Math.max(1e-9, sea - minE));
      ramp(ELEVATION_RAMP, et, out, o);
    } else if (mode === 'moisture') {
      if ((surface.elevation[c] as number) <= sea) { out[o] = 0.01; out[o + 1] = 0.10; out[o + 2] = 0.28; }
      else ramp(MOISTURE_RAMP, surface.moisture[c] as number, out, o);
    } else if (mode === 'temperature') {
      ramp(TEMPERATURE_RAMP, surface.temperature[c] as number, out, o);
      if ((surface.elevation[c] as number) <= sea) mix3(out, o, [0.01, 0.08, 0.24], 0.25);
    } else if (mode === 'continents') {
      const cid = surface.continentTop1Id ? (surface.continentTop1Id[c] as number) : -1;
      if (cid >= 0 && (surface.continentTop1Weight[c] as number) > 0.03) {
        hashColor(cid, 11, out, o, 0.48, 0.46);
        // Переходная зона C100 светлеет с ростом энтропии.
        mix3(out, o, [0.95, 0.98, 1.0], clamp01(surface.continentEntropy[c] as number) * 0.22);
      } else {
        const basin = surface.oceanBasinId ? (surface.oceanBasinId[c] as number) : -1;
        if (basin >= 0) hashColor(basin, 97, out, o, 0.42, 0.16);
        else { out[o] = 0.01; out[o + 1] = 0.07; out[o + 2] = 0.20; }
      }
    } else if (mode === 'drainage') {
      const region = surface.drainageRegionId ? (surface.drainageRegionId[c] as number) : -1;
      if (region >= 0) {
        hashColor(region, 41, out, o, 0.50, 0.44);
        if ((surface.streamWeight[c] as number) > 0.05) mix3(out, o, [0.02, 0.25, 0.92], (surface.streamWeight[c] as number) * 0.55);
      } else { out[o] = 0.008; out[o + 1] = 0.06; out[o + 2] = 0.20; }
    } else {
      // biome / rivers / mountains: стартуем с авторитетного CPU-цвета.
      out[o] = Math.pow(clamp01(surface.biomeColor[o] as number), 0.58);
      out[o + 1] = Math.pow(clamp01(surface.biomeColor[o + 1] as number), 0.58);
      out[o + 2] = Math.pow(clamp01(surface.biomeColor[o + 2] as number), 0.58);
      if (mode === 'rivers') {
        out[o] = (out[o] as number) * 0.58; out[o + 1] = (out[o + 1] as number) * 0.62; out[o + 2] = (out[o + 2] as number) * 0.66;
        if ((surface.streamWeight[c] as number) > 0) mix3(out, o, [0.02, 0.38, 1.0], clamp01((surface.streamWeight[c] as number) * 0.88));
        if ((surface.lakeWeight[c] as number) > 0) mix3(out, o, [0.05, 0.58, 0.98], clamp01((surface.lakeWeight[c] as number) * 0.75));
        if ((surface.deltaWeight[c] as number) > 0) mix3(out, o, [0.25, 0.95, 0.72], clamp01((surface.deltaWeight[c] as number) * 0.58));
      } else if (mode === 'mountains') {
        out[o] = (out[o] as number) * 0.68; out[o + 1] = (out[o + 1] as number) * 0.70; out[o + 2] = (out[o + 2] as number) * 0.74;
        if ((surface.mountainWeight[c] as number) > 0) mix3(out, o, [0.72, 0.70, 0.68], (surface.mountainWeight[c] as number) * 0.58);
        if ((surface.mountainSeamWeight[c] as number) > 0) mix3(out, o, [1.0, 0.28, 0.08], clamp01((surface.mountainSeamWeight[c] as number) * 0.82));
        if ((surface.volcanism[c] as number) > 0.55) mix3(out, o, [0.95, 0.42, 0.08], ((surface.volcanism[c] as number) - 0.55) * 0.35);
      } else {
        // Обычный биомный вид: реки и дельты видны, но не перекрывают биом.
        if ((surface.streamWeight[c] as number) > 0) mix3(out, o, [0.03, 0.34, 0.88], clamp01((surface.streamWeight[c] as number) * 0.42));
        if ((surface.deltaWeight[c] as number) > 0) mix3(out, o, [0.10, 0.62, 0.55], clamp01((surface.deltaWeight[c] as number) * 0.18));
        if ((surface.mountainSeamWeight[c] as number) > 0) mix3(out, o, [0.86, 0.84, 0.80], clamp01((surface.mountainSeamWeight[c] as number) * 0.16));
      }
    }
  }
  return out;
}

function assertGeometryInputs(grid: PlanetGrid, surface: SurfaceResult): void {
  if (!grid || !grid.centers || !grid.corners || !grid.cellCorners || !grid.cellCornerStart ||
      !Number.isInteger(grid.cellCount)) {
    throw new Error('PlanetGlobe: нужна сетка GeodesicGrid');
  }
  if (!surface || surface.cellCount !== grid.cellCount || !surface.elevation || !surface.biomeColor) {
    throw new Error('PlanetGlobe: нужна поверхность PlanetSurface той же формы, что сетка');
  }
}

function listGeometryTransferables(geometry: GlobeGeometry | null, includeVertexCellId?: boolean): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  function add(a: { buffer: ArrayBufferLike } | null | undefined): void {
    if (a && a.buffer && out.indexOf(a.buffer as ArrayBuffer) < 0) out.push(a.buffer as ArrayBuffer);
  }
  add(geometry && geometry.positions);
  add(geometry && geometry.normals);
  add(geometry && geometry.colors);
  add(geometry && geometry.indices);
  if (includeVertexCellId) add(geometry && geometry.vertexCellId);
  return out;
}

function cellPolygon(grid: PlanetGrid, surface: SurfaceResult, cell: number, options?: GlobeGeometryOptions & { inflate?: number } | null): CellPolygon | null {
  const opts = options || {};
  assertGeometryInputs(grid, surface);
  if (!Number.isInteger(cell) || cell < 0 || cell >= grid.cellCount) return null;
  const reliefScale = opts.reliefScale == null ? 1 : Number(opts.reliefScale);
  const inflate = opts.inflate == null ? 1.004 : Number(opts.inflate);
  const centerR = (1 + reliefDelta(surface, surface.elevation[cell] as number, reliefScale)) * inflate;
  const center = [
    (grid.centers[cell * 3] as number) * centerR,
    (grid.centers[cell * 3 + 1] as number) * centerR,
    (grid.centers[cell * 3 + 2] as number) * centerR,
  ];
  const corners: number[][] = [];
  const start = grid.cellCornerStart[cell] as number;
  const end = grid.cellCornerStart[cell + 1] as number;
  for (let k = start; k < end; k++) {
    const corner = grid.cellCorners[k] as number;
    let radius = 1;
    if (grid.triangles) {
      const a = grid.triangles[corner * 3] as number, b = grid.triangles[corner * 3 + 1] as number, d = grid.triangles[corner * 3 + 2] as number;
      radius = 1 + (reliefDelta(surface, surface.elevation[a] as number, reliefScale) +
        reliefDelta(surface, surface.elevation[b] as number, reliefScale) +
        reliefDelta(surface, surface.elevation[d] as number, reliefScale)) / 3;
    }
    radius *= inflate;
    corners.push([
      (grid.corners[corner * 3] as number) * radius,
      (grid.corners[corner * 3 + 1] as number) * radius,
      (grid.corners[corner * 3 + 2] as number) * radius,
    ]);
  }
  return { cell: cell, center: center, corners: corners };
}

function buildEquirectPreview(grid: PlanetGrid, surface: SurfaceResult, width: number, height: number, mode?: string): EquirectPreview {
  assertGeometryInputs(grid, surface);
  width = Math.max(32, width | 0);
  height = Math.max(16, height | 0);
  const data = new Uint8ClampedArray(width * height * 4);
  let i: number, x: number, y: number;
  for (i = 0; i < width * height; i++) {
    data[i * 4] = 3; data[i * 4 + 1] = 18; data[i * 4 + 2] = 48; data[i * 4 + 3] = 255;
  }
  const colors = buildCellColors(surface, mode || 'biome');
  function put(px: number, py: number, c: number): void {
    if (py < 0 || py >= height) return;
    px = ((px % width) + width) % width;
    const o = (py * width + px) * 4;
    data[o] = Math.round(clamp01(colors[c * 3] as number) * 255);
    data[o + 1] = Math.round(clamp01(colors[c * 3 + 1] as number) * 255);
    data[o + 2] = Math.round(clamp01(colors[c * 3 + 2] as number) * 255);
    data[o + 3] = 255;
  }
  for (let c = 0; c < grid.cellCount; c++) {
    const cx = grid.centers[c * 3] as number, cy = grid.centers[c * 3 + 1] as number, cz = grid.centers[c * 3 + 2] as number;
    const lon = Math.atan2(cz, cx);
    const lat = Math.asin(clamp(cy, -1, 1));
    const px0 = Math.round((lon + Math.PI) / (2 * Math.PI) * width);
    const py0 = Math.round((0.5 - lat / Math.PI) * height);
    const angular = Math.sqrt(Math.max(0, grid.areas[c] as number) / Math.PI);
    let rx = Math.max(1, Math.ceil(angular * width / (2 * Math.PI) / Math.max(0.28, Math.cos(lat))));
    const ry = Math.max(1, Math.ceil(angular * height / Math.PI));
    rx = Math.min(rx, Math.max(2, width >> 2));
    for (y = py0 - ry; y <= py0 + ry; y++) {
      for (x = px0 - rx; x <= px0 + rx; x++) put(x, y, c);
    }
  }
  return { width: width, height: height, data: data };
}

/* ---------------------------------------------------------- WebGL2 */

const BASE_FOVY = 42 * Math.PI / 180;
function fieldOfViewYForAspect(aspect: number): number {
  // В портрете фиксированный вертикальный FOV обрезал планету по бокам
  // и заставлял GPU растеризовать огромную внеэкранную часть диска.
  // Сохраняем горизонтальный угол ландшафтного вида, расширяя
  // вертикальный FOV ровно настолько, чтобы сфера помещалась по ширине.
  if (!Number.isFinite(aspect) || aspect >= 1) return BASE_FOVY;
  return 2 * Math.atan(Math.tan(BASE_FOVY / 2) / Math.max(0.35, aspect));
}
function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect; out[5] = f;
  out[10] = (far + near) / (near - far); out[11] = -1;
  out[14] = 2 * far * near / (near - far);
  return out;
}
function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
function mat4RotationYawPitch(yaw: number, pitch: number): Float32Array {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  // R = RotX(pitch) * RotY(yaw), column-major.
  return new Float32Array([
    cy, sp * sy, -cp * sy, 0,
    0, cp, sp, 0,
    sy, -sp * cy, cp * cy, 0,
    0, 0, 0, 1,
  ]);
}
function transformDirectionTranspose(m: Float32Array, p: number[]): number[] {
  // Для чистой вращательной матрицы обратная равна транспонированной.
  return [
    (m[0] as number) * (p[0] as number) + (m[1] as number) * (p[1] as number) + (m[2] as number) * (p[2] as number),
    (m[4] as number) * (p[0] as number) + (m[5] as number) * (p[1] as number) + (m[6] as number) * (p[2] as number),
    (m[8] as number) * (p[0] as number) + (m[9] as number) * (p[1] as number) + (m[10] as number) * (p[2] as number),
  ];
}
/** Этап 7: точка сферы в центре экрана для ракурса (rotX = pitch, rotY = yaw).
 *  Камера стоит в [0, 0, distance] и смотрит в центр, поэтому центр экрана —
 *  это модельная точка (0, 0, 1): (-cp·sy, sp, cp·cy) (см. mat4RotationYawPitch). */
function cameraDirectionFromAngles(rotX: number, rotY: number): [number, number, number] {
  const cp = Math.cos(rotX), sp = Math.sin(rotX);
  const cy = Math.cos(rotY), sy = Math.sin(rotY);
  const len = Math.hypot(cp * sy, sp, cp * cy) || 1;
  return [(-cp * sy) / len, sp / len, (cp * cy) / len];
}
/** Кратчайшая дуга угла в (-π, π] — для подлёта без лишних оборотов по yaw. */
function shortestArcDelta(delta: number): number {
  let d = delta % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
function normalize3(v: number[]): number[] {
  const l = Math.hypot(v[0] as number, v[1] as number, v[2] as number) || 1;
  return [(v[0] as number) / l, (v[1] as number) / l, (v[2] as number) / l];
}

const SURFACE_VS = [
  '#version 300 es',
  'layout(location=0) in vec3 aPos;',
  'layout(location=1) in vec4 aColor;',
  'layout(location=2) in vec4 aNormal;',
  'uniform mat4 uMvp;',
  'uniform mat4 uModel;',
  // Каскадная сборка (uBuild) и двухслойное центробежное замещение
  // (uHide / uCenterGrow). При uBuild=1, uHide=0, uCenterGrow=0 —
  // тождество, чтобы decorateSurfaceShaders мог подменить aPos на fxPos.
  'uniform float uBuild;',
  'uniform float uHide;',
  'uniform float uCenterGrow;',
  'uniform vec3 uViewDir;',
  'out vec3 vColor;',
  'out float vEdge;',
  'out vec3 vNormal;',
  'out vec3 vWorldPos;',
  'out float vBuildEdge;',
  'void main() {',
  '  vec4 wp = uModel * vec4(aPos, 1.0);',
  '  vWorldPos = wp.xyz;',
  '  vNormal = normalize(mat3(uModel) * aNormal.xyz);',
  '  vColor = aColor.rgb;',
  '  vEdge = aColor.a;',
  '  vBuildEdge = 0.0;',
  '  gl_Position = uMvp * vec4(aPos, 1.0);',
  '  float birthLat = 0.78 * (0.5 - 0.5 * clamp(normalize(aPos).y, -1.0, 1.0));',
  '  float tBuild = clamp((uBuild - birthLat) / 0.22, 0.0, 1.0);',
  '  float invB = 1.0 - tBuild;',
  '  float easeB = 1.0 - invB * invB * invB;',
  '  float cellScale = 1.0 - 2.0 * invB * invB * invB + invB * invB;',
  '  float lift = (1.0 - easeB) * 0.38;',
  '  vec3 nrm = normalize(aPos);',
  '  vec3 built = nrm * (1.0 + lift) + (aPos - nrm) * cellScale;',
  '  float facing = dot(nrm, normalize(uViewDir));',
  '  float limbBirth = 0.78 * clamp(1.0 - facing, 0.0, 1.0);',
  '  if (uCenterGrow > 0.001) {',
  '    float tGrow = clamp((uCenterGrow - limbBirth) / 0.22, 0.0, 1.0);',
  '    float easeG = 1.0 - pow(1.0 - tGrow, 3.0);',
  '    built = aPos * easeG;',
  '  }',
  '  if (uHide > 0.001) {',
  '    float tHide = clamp((uHide - limbBirth) / 0.22, 0.0, 1.0);',
  '    built = nrm + (built - nrm) * (1.0 - tHide * tHide);',
  '  }',
  '  vBuildEdge = (uBuild < 0.999) ? (1.0 - easeB) : 0.0;',
  '  if (uBuild < 0.999 || uHide > 0.001 || uCenterGrow > 0.001) {',
  '    vec4 wpB = uModel * vec4(built, 1.0);',
  '    vWorldPos = wpB.xyz;',
  '    gl_Position = uMvp * vec4(built, 1.0);',
  '  }',
  '}',
].join('\n');
const SURFACE_FS = [
  '#version 300 es',
  'precision highp float;',
  'in vec3 vColor;',
  'in float vEdge;',
  'in vec3 vNormal;',
  'in vec3 vWorldPos;',
  'in float vBuildEdge;',
  'uniform vec3 uSunDir;',
  'uniform vec3 uCamPos;',
  'uniform float uBorder;',
  'out vec4 fragColor;',
  'void main() {',
  '  vec3 n = normalize(vNormal);',
  '  float nd = dot(n, normalize(uSunDir));',
  '  float light = 0.20 + 0.80 * smoothstep(-0.18, 0.42, nd);',
  '  vec3 viewDir = normalize(uCamPos - vWorldPos);',
  '  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);',
  '  vec3 col = vColor * light;',
  '  float border = smoothstep(0.84, 0.995, vEdge) * uBorder;',
  '  col = mix(col, vec3(0.015, 0.10, 0.13), border * 0.46);',
  '  col += vec3(0.05, 0.55, 0.62) * border * 0.10;',
  '  col += vec3(0.05, 0.28, 0.38) * rim * 0.16;',
  '  col = mix(col, vec3(1.0, 0.82, 0.32), vBuildEdge * 0.55);',
  '  col += vec3(1.0, 0.72, 0.22) * vBuildEdge * 0.40;',
  '  fragColor = vec4(col, 1.0);',
  '}',
].join('\n');
const ATMO_VS = [
  '#version 300 es',
  'layout(location=0) in vec3 aPos;',
  'uniform mat4 uMvp;',
  'uniform mat4 uModel;',
  'uniform float uScale;',
  'out vec3 vNormal;',
  'out vec3 vWorldPos;',
  'void main() {',
  '  vec3 p = aPos * uScale;',
  '  vec4 wp = uModel * vec4(p, 1.0);',
  '  vWorldPos = wp.xyz;',
  '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
  '  gl_Position = uMvp * vec4(p, 1.0);',
  '}',
].join('\n');
const ATMO_FS = [
  '#version 300 es',
  'precision highp float;',
  'in vec3 vNormal;',
  'in vec3 vWorldPos;',
  'uniform vec3 uCamPos;',
  'uniform float uIntensity;',
  'uniform float uBuild;',
  'out vec4 fragColor;',
  'void main() {',
  '  vec3 viewDir = normalize(uCamPos - vWorldPos);',
  '  float f = pow(clamp(1.0 - abs(dot(normalize(vNormal), viewDir)), 0.0, 1.0), 3.2);',
  '  float on = smoothstep(0.7, 1.0, uBuild);',
  '  vec3 col = vec3(0.16, 0.62, 0.92) * f * uIntensity * on;',
  '  fragColor = vec4(col, f * 0.78 * uIntensity * on);',
  '}',
].join('\n');
const SIMPLE_VS = [
  '#version 300 es',
  'layout(location=0) in vec3 aPos;',
  'uniform mat4 uMvp;',
  'void main() { gl_Position = uMvp * vec4(aPos, 1.0); }',
].join('\n');
const SIMPLE_FS = [
  '#version 300 es',
  'precision highp float;',
  'uniform vec4 uColor;',
  'out vec4 fragColor;',
  'void main() { fragColor = uColor; }',
].join('\n');

function makeSphereGeometry(lonSegments: number, latSegments: number): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let iy = 0; iy <= latSegments; iy++) {
    const lat = Math.PI / 2 - iy / latSegments * Math.PI;
    for (let ix = 0; ix <= lonSegments; ix++) {
      const lon = ix / lonSegments * Math.PI * 2;
      positions.push(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
    }
  }
  const row = lonSegments + 1;
  for (let y = 0; y < latSegments; y++) {
    for (let x = 0; x < lonSegments; x++) {
      const a = y * row + x, b = a + 1, c = a + row, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

interface PendingUpload {
  geometry: GlobeGeometry;
  stage: number;
  offset: number;
  uploadedBytes: number;
  totalBytes: number;
  vao: WebGLVertexArrayObject | null;
  positionBuffer: WebGLBuffer | null;
  colorBuffer: WebGLBuffer | null;
  normalBuffer: WebGLBuffer | null;
  indexBuffer: WebGLBuffer | null;
}

/** Главный поток. Полного ядра не касается: геометрия, цвета и индексы уже
 *  посчитаны воркером, а pick/полигон ячейки строятся на CPU из сетки
 *  (`cellPolygon`), поэтому создание глобуса не поднимает Wasm-арену. */
function createPlanetGlobe(canvas: HTMLCanvasElement, options?: PlanetGlobeOptions | null): PlanetGlobeHandle | null {
  const opts = options || {};
  if (!canvas || !canvas.getContext) return null;
  const gl = canvas.getContext('webgl2', {
    antialias: opts.antialias !== false,
    alpha: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  const GL: WebGL2RenderingContext = gl;

  let surfaceProgram: WebGLProgram | null = null, atmoProgram: WebGLProgram | null = null, simpleProgram: WebGLProgram | null = null;
  let U: Record<string, WebGLUniformLocation | null> = {}, UA: Record<string, WebGLUniformLocation | null> = {}, US: Record<string, WebGLUniformLocation | null> = {};
  let geometry: GlobeGeometry | null = null;
  let vao: WebGLVertexArrayObject | null = null, positionBuffer: WebGLBuffer | null = null, colorBuffer: WebGLBuffer | null = null, normalBuffer: WebGLBuffer | null = null, indexBuffer: WebGLBuffer | null = null;
  let atmoVao: WebGLVertexArrayObject | null = null, atmoIndexCount = 0;
  let selection: CellPolygon | null = null, selectionVao: WebGLVertexArrayObject | null = null, selectionBuffer: WebGLBuffer | null = null, selectionIndexBuffer: WebGLBuffer | null = null, selectionIndexCount = 0, selectionCornerCount = 0;
  let pendingUpload: PendingUpload | null = null;
  let queuedColors: Uint8Array | null = null;
  // Этап 7: временный prev-слой двухслойного центробежного замещения.
  // prevBorderBuf/prevIdBuf зарезервированы под будущие буферы границ/ID —
  // в planet-globe-v1 границы и ID живут в цвете и CPU-массивах.
  let prevVao: WebGLVertexArrayObject | null = null;
  let prevPosBuf: WebGLBuffer | null = null;
  let prevNormBuf: WebGLBuffer | null = null;
  let prevColorBuf: WebGLBuffer | null = null;
  let prevBorderBuf: WebGLBuffer | null = null;
  let prevIdBuf: WebGLBuffer | null = null;
  let prevIdxBuf: WebGLBuffer | null = null;
  let prevIndexCount = 0;
  let prevGeometry: GlobeGeometry | null = null;
  let waveStartMs = 0;
  let waveDurationMs = 0;
  // Этап 7: авто-подлёт flyToDirection и debounced-интент камеры (180 мс).
  interface FlyAnimation {
    fromX: number;
    fromY: number;
    toX: number;
    deltaY: number;
    fromDist: number;
    toDist: number;
    startAt: number;
    durationMs: number;
  }
  let flyAnim: FlyAnimation | null = null;
  let intentTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let disposed = false;
  let raf = 0;
  let yaw = -0.65, pitch = 0.38;
  let yawVelocity = 0, pitchVelocity = 0;
  // Этап 7: пределы дистанции камеры и zoomRatio для onCameraIntent.
  // Stage-8.2: нижний предел 1.15 — камера подлетает заметно ближе к гексу
  // перед переходом на локальный уровень участка.
  const MIN_DISTANCE = 1.15, MAX_DISTANCE = 6.0;
  let distance = 3.05, targetDistance = 3.05;
  /** Stage-8.2: защита onZoomDive от повторного спама (не чаще 500 мс). */
  let lastZoomDiveAt = -Infinity;
  let autoRotate = opts.autoRotate !== false;
  let bordersEnabled = opts.borders !== false;
  let atmosphereEnabled = opts.atmosphere !== false;
  let buildValue = 1;
  let buildAnimStart = -1;
  let buildAnimDur = 0;
  let centerGrowValue = 0;
  let hideValue = 0;
  let interacting = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let lastPinchDistance = 0;
  let downInfo: { x: number; y: number; at: number; moved: number } | null = null;
  let hoverQueued = false;
  let renderScale = 1;
  const maxPixelRatio = Math.max(0.5, Math.min(2, Number(opts.maxPixelRatio) || 2));
  let adaptiveQualityHold = false;
  let lastStatsAt = 0;
  let frameTimes: { at: number; ms: number }[] = [];
  let lastFrameAt = performance.now();
  let adaptCooldownUntil = 0;
  const sunDir = normalize3([-0.55, 0.35, 0.76]);
  const lightDirF = new Float32Array(sunDir);
  const eyePosF = new Float32Array(3);
  const frameCtx: FxFrameContext = {
    mvp: new Float32Array(16),
    model: new Float32Array(16),
    normalMat: new Float32Array(16),
    lightDir: lightDirF,
    eyePos: eyePosF,
    timeSec: 0,
  };

  function currentBuildProgress(now: number): number {
    if (buildAnimStart < 0) return buildValue;
    const p = (now - buildAnimStart) / Math.max(1, buildAnimDur);
    if (p >= 1) {
      buildAnimStart = -1;
      buildValue = 1;
      return 1;
    }
    return p < 0 ? 0 : p;
  }

  function compile(type: number, source: string): WebGLShader {
    const shader = GL.createShader(type) as WebGLShader;
    GL.shaderSource(shader, source);
    GL.compileShader(shader);
    if (!GL.getShaderParameter(shader, GL.COMPILE_STATUS)) {
      throw new Error('PlanetGlobe shader: ' + GL.getShaderInfoLog(shader));
    }
    return shader;
  }
  function makeProgram(vs: string, fs: string): WebGLProgram {
    const program = GL.createProgram() as WebGLProgram;
    GL.attachShader(program, compile(GL.VERTEX_SHADER, vs));
    GL.attachShader(program, compile(GL.FRAGMENT_SHADER, fs));
    GL.linkProgram(program);
    if (!GL.getProgramParameter(program, GL.LINK_STATUS)) {
      throw new Error('PlanetGlobe program: ' + GL.getProgramInfoLog(program));
    }
    return program;
  }
  function locations(program: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
    const out: Record<string, WebGLUniformLocation | null> = {};
    names.forEach(function (name) { out[name] = GL.getUniformLocation(program, name); });
    return out;
  }
  function initPrograms(): void {
    const surfaceSrc = (opts.fx && opts.fx.decorateSurfaceShaders)
      ? opts.fx.decorateSurfaceShaders({ vs: SURFACE_VS, fs: SURFACE_FS })
      : { vs: SURFACE_VS, fs: SURFACE_FS };
    surfaceProgram = makeProgram(surfaceSrc.vs, surfaceSrc.fs);
    if (opts.fx && opts.fx.onSurfaceProgram && surfaceProgram) {
      opts.fx.onSurfaceProgram(GL, surfaceProgram);
    }
    atmoProgram = makeProgram(ATMO_VS, ATMO_FS);
    simpleProgram = makeProgram(SIMPLE_VS, SIMPLE_FS);
    U = locations(surfaceProgram, ['uMvp', 'uModel', 'uSunDir', 'uCamPos', 'uBorder', 'uBuild', 'uHide', 'uCenterGrow', 'uViewDir']);
    UA = locations(atmoProgram, ['uMvp', 'uModel', 'uScale', 'uCamPos', 'uIntensity', 'uBuild']);
    US = locations(simpleProgram, ['uMvp', 'uColor']);
    buildAtmosphere();
  }
  function buildAtmosphere(): void {
    const sphere = makeSphereGeometry(56, 36);
    atmoIndexCount = sphere.indices.length;
    atmoVao = GL.createVertexArray();
    GL.bindVertexArray(atmoVao);
    const pos = GL.createBuffer();
    GL.bindBuffer(GL.ARRAY_BUFFER, pos);
    GL.bufferData(GL.ARRAY_BUFFER, sphere.positions, GL.STATIC_DRAW);
    GL.enableVertexAttribArray(0);
    GL.vertexAttribPointer(0, 3, GL.FLOAT, false, 0, 0);
    const idx = GL.createBuffer();
    GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, idx);
    GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, sphere.indices, GL.STATIC_DRAW);
    GL.bindVertexArray(null);
  }
  function deleteSurfaceBuffers(): void {
    if (vao) GL.deleteVertexArray(vao);
    if (positionBuffer) GL.deleteBuffer(positionBuffer);
    if (colorBuffer) GL.deleteBuffer(colorBuffer);
    if (normalBuffer) GL.deleteBuffer(normalBuffer);
    if (indexBuffer) GL.deleteBuffer(indexBuffer);
    vao = positionBuffer = colorBuffer = normalBuffer = indexBuffer = null;
  }
  function deletePendingUpload(): void {
    if (!pendingUpload) return;
    if (pendingUpload.vao) GL.deleteVertexArray(pendingUpload.vao);
    if (pendingUpload.positionBuffer) GL.deleteBuffer(pendingUpload.positionBuffer);
    if (pendingUpload.colorBuffer) GL.deleteBuffer(pendingUpload.colorBuffer);
    if (pendingUpload.normalBuffer) GL.deleteBuffer(pendingUpload.normalBuffer);
    if (pendingUpload.indexBuffer) GL.deleteBuffer(pendingUpload.indexBuffer);
    pendingUpload = null;
  }
  function disposePrevGeometry(): void {
    // Немедленное освобождение GPU-памяти уходящего слоя: буферы предыдущего
    // шара не должны переживать волну центробежного замещения.
    if (prevVao) GL.deleteVertexArray(prevVao);
    if (prevPosBuf) GL.deleteBuffer(prevPosBuf);
    if (prevNormBuf) GL.deleteBuffer(prevNormBuf);
    if (prevColorBuf) GL.deleteBuffer(prevColorBuf);
    if (prevBorderBuf) GL.deleteBuffer(prevBorderBuf);
    if (prevIdBuf) GL.deleteBuffer(prevIdBuf);
    if (prevIdxBuf) GL.deleteBuffer(prevIdxBuf);
    prevVao = null;
    prevPosBuf = null;
    prevNormBuf = null;
    prevColorBuf = null;
    prevBorderBuf = null;
    prevIdBuf = null;
    prevIdxBuf = null;
    prevIndexCount = 0;
    prevGeometry = null;
  }
  function scheduleCameraIntent(): void {
    // Этап 7: debounced-интент камеры (180 мс) для intent-based prefetch
    // воркера — частые жесты не должны заспамить канал postMessage.
    if (typeof opts.onCameraIntent !== 'function') return;
    if (intentTimer) clearTimeout(intentTimer);
    intentTimer = setTimeout(function () {
      intentTimer = 0;
      if (disposed) return;
      try {
        opts.onCameraIntent?.({
          viewDirection: cameraDirectionFromAngles(pitch, yaw),
          distance: distance,
          zoomRatio: clamp((MAX_DISTANCE - distance) / (MAX_DISTANCE - MIN_DISTANCE), 0, 1),
        });
      } catch (_) { /* коллбэк страницы не ломает рендер */ }
    }, 180);
  }
  function startCentrifugalTransition(durationSec: number | undefined): void {
    buildAnimStart = -1;
    buildValue = 1;
    centerGrowValue = 0;
    hideValue = 0;
    waveStartMs = performance.now();
    waveDurationMs = Math.max(80, (Number(durationSec) == null ? 0.45 : Number(durationSec)) * 1000);
  }
  function uploadGeometry(nextGeometry: GlobeGeometry | null): void {
    // Порционная заливка: текущая планета продолжает рисоваться старым
    // VAO, пока новый бандл собирается по частям. На канонической Земле
    // это ~30 МиБ, и одна синхронная заливка способна дать тяжёлый кадр.
    deletePendingUpload();
    if (!nextGeometry) return;
    const pending: PendingUpload = {
      geometry: nextGeometry,
      stage: 0,
      offset: 0,
      uploadedBytes: 0,
      totalBytes: nextGeometry.positions.byteLength + nextGeometry.colors.byteLength +
        nextGeometry.normals.byteLength + nextGeometry.indices.byteLength,
      vao: GL.createVertexArray(),
      positionBuffer: GL.createBuffer(),
      colorBuffer: GL.createBuffer(),
      normalBuffer: GL.createBuffer(),
      indexBuffer: GL.createBuffer(),
    };
    pendingUpload = pending;
    GL.bindVertexArray(pending.vao);
    GL.bindBuffer(GL.ARRAY_BUFFER, pending.positionBuffer);
    GL.bufferData(GL.ARRAY_BUFFER, nextGeometry.positions.byteLength, GL.STATIC_DRAW);
    GL.enableVertexAttribArray(0);
    GL.vertexAttribPointer(0, 3, GL.FLOAT, false, 0, 0);
    GL.bindBuffer(GL.ARRAY_BUFFER, pending.colorBuffer);
    GL.bufferData(GL.ARRAY_BUFFER, nextGeometry.colors.byteLength, GL.DYNAMIC_DRAW);
    GL.enableVertexAttribArray(1);
    GL.vertexAttribPointer(1, 4, GL.UNSIGNED_BYTE, true, 0, 0);
    GL.bindBuffer(GL.ARRAY_BUFFER, pending.normalBuffer);
    GL.bufferData(GL.ARRAY_BUFFER, nextGeometry.normals.byteLength, GL.STATIC_DRAW);
    GL.enableVertexAttribArray(2);
    GL.vertexAttribPointer(2, 4, GL.SHORT, true, 0, 0);
    GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, pending.indexBuffer);
    GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, nextGeometry.indices.byteLength, GL.STATIC_DRAW);
    GL.bindVertexArray(null);
  }
  function finishPendingUpload(): void {
    const pending = pendingUpload;
    if (!pending) return;
    pendingUpload = null;
    deleteSurfaceBuffers();
    geometry = pending.geometry;
    vao = pending.vao;
    positionBuffer = pending.positionBuffer;
    colorBuffer = pending.colorBuffer;
    normalBuffer = pending.normalBuffer;
    indexBuffer = pending.indexBuffer;
    if (queuedColors) {
      const colors = queuedColors;
      queuedColors = null;
      geometry.colors = colors;
      GL.bindBuffer(GL.ARRAY_BUFFER, colorBuffer);
      GL.bufferData(GL.ARRAY_BUFFER, colors, GL.DYNAMIC_DRAW);
      GL.bindBuffer(GL.ARRAY_BUFFER, null);
    }
    if (typeof opts.onGeometryUploadProgress === 'function') {
      try { opts.onGeometryUploadProgress({ geometry: geometry, fraction: 1 }); } catch (_) { /* HUD не ломает рендер */ }
    }
    if (typeof opts.onGeometryReady === 'function') {
      try { opts.onGeometryReady(geometry); } catch (_) { /* вызывающий код не ломает рендер */ }
    }
    if (opts.fx && opts.fx.onGeometryReady) {
      // Сетка живёт в воркере (pick); плагин добирает её через своё состояние.
      const maybeGrid = (geometry as unknown as { grid?: PlanetGrid }).grid ?? (null as unknown as PlanetGrid);
      try { opts.fx.onGeometryReady(GL, maybeGrid, geometry); } catch (_) { /* плагин не ломает рендер */ }
    }
  }
  function processPendingUpload(): void {
    if (!pendingUpload) return;
    const pending = pendingUpload;
    const arrays: (Float32Array | Uint8Array | Int16Array | Uint32Array)[] =
      [pending.geometry.positions, pending.geometry.colors, pending.geometry.normals, pending.geometry.indices];
    const targets = [GL.ARRAY_BUFFER, GL.ARRAY_BUFFER, GL.ARRAY_BUFFER, GL.ELEMENT_ARRAY_BUFFER];
    const buffers = [pending.positionBuffer, pending.colorBuffer, pending.normalBuffer, pending.indexBuffer];
    // Телефонная приёмка показала, что 2,5 МиБ одним bufferSubData для
    // мобильного драйвера слишком грубо. 384 КиБ и бюджет 3 мс дают
    // больше кадров на заливку, но каждый кадр заметно легче.
    const deadline = performance.now() + 3;
    GL.bindVertexArray(pending.vao);
    while (pendingUpload === pending && pending.stage < arrays.length && performance.now() < deadline) {
      let array = arrays[pending.stage] as Float32Array | Uint8Array | Int16Array | Uint32Array;
      // Цвет мог смениться, пока позиции ещё заливались.
      if (pending.stage === 1) array = pending.geometry.colors;
      const maxElements = Math.max(4096, Math.floor(393216 / array.BYTES_PER_ELEMENT));
      const count = Math.min(array.length - pending.offset, maxElements);
      if (count <= 0) {
        pending.stage++;
        pending.offset = 0;
        continue;
      }
      GL.bindBuffer(targets[pending.stage] as number, buffers[pending.stage] as WebGLBuffer | null);
      GL.bufferSubData(
        targets[pending.stage] as number,
        pending.offset * array.BYTES_PER_ELEMENT,
        array.subarray(pending.offset, pending.offset + count) as BufferSource,
      );
      pending.offset += count;
      pending.uploadedBytes += count * array.BYTES_PER_ELEMENT;
      if (pending.offset >= array.length) {
        pending.stage++;
        pending.offset = 0;
      }
      if (typeof opts.onGeometryUploadProgress === 'function') {
        try {
          opts.onGeometryUploadProgress({
            geometry: pending.geometry,
            fraction: pending.totalBytes ? pending.uploadedBytes / pending.totalBytes : 1,
          });
        } catch (_) { /* HUD не ломает рендер */ }
      }
    }
    GL.bindVertexArray(null);
    if (pendingUpload === pending && pending.stage >= arrays.length) finishPendingUpload();
  }
  function uploadSelection(): void {
    if (selectionVao) GL.deleteVertexArray(selectionVao);
    if (selectionBuffer) GL.deleteBuffer(selectionBuffer);
    if (selectionIndexBuffer) GL.deleteBuffer(selectionIndexBuffer);
    selectionVao = selectionBuffer = selectionIndexBuffer = null;
    selectionIndexCount = 0;
    selectionCornerCount = 0;
    if (!selection || !selection.corners || selection.corners.length < 3) return;
    const vertices: number[] = [];
    vertices.push(selection.center[0] as number, selection.center[1] as number, selection.center[2] as number);
    selection.corners.forEach(function (p) { vertices.push(p[0] as number, p[1] as number, p[2] as number); });
    const indices: number[] = [];
    for (let i = 0; i < selection.corners.length; i++) {
      indices.push(0, 1 + i, 1 + ((i + 1) % selection.corners.length));
    }
    selectionVao = GL.createVertexArray();
    GL.bindVertexArray(selectionVao);
    selectionBuffer = GL.createBuffer();
    GL.bindBuffer(GL.ARRAY_BUFFER, selectionBuffer);
    GL.bufferData(GL.ARRAY_BUFFER, new Float32Array(vertices), GL.DYNAMIC_DRAW);
    GL.enableVertexAttribArray(0);
    GL.vertexAttribPointer(0, 3, GL.FLOAT, false, 0, 0);
    selectionIndexBuffer = GL.createBuffer();
    GL.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, selectionIndexBuffer);
    GL.bufferData(GL.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), GL.DYNAMIC_DRAW);
    selectionIndexCount = indices.length;
    selectionCornerCount = selection.corners.length;
    GL.bindVertexArray(null);
  }
  function resizeIfNeeded(): number {
    const dpr = Math.min(maxPixelRatio, (globalThis.devicePixelRatio || 1)) * renderScale;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    GL.viewport(0, 0, canvas.width, canvas.height);
    return canvas.width / canvas.height;
  }
  function visibleRanges(model: Float32Array, layerGeometry: GlobeGeometry): { indexStart: number; indexCount: number }[] {
    if (!layerGeometry || !layerGeometry.chunkRanges || !layerGeometry.chunkRanges.length) {
      return [{ indexStart: 0, indexCount: layerGeometry.indexCount }];
    }
    const ranges: { indexStart: number; indexCount: number }[] = [];
    const threshold = 0.92 / distance;
    let current: { indexStart: number; indexCount: number } | null = null;
    for (let i = 0; i < layerGeometry.chunkRanges.length; i++) {
      const range = layerGeometry.chunkRanges[i] as GlobeChunkRange;
      // Нужна только z-координата центра в мировом пространстве;
      // без временного массива на каждый chunk в каждом кадре.
      const czRaw = (model[2] as number) * (range.center[0] as number) + (model[6] as number) * (range.center[1] as number) + (model[10] as number) * (range.center[2] as number);
      const cz = clamp(czRaw, -1, 1);
      const maxZ = cz * range.cosAngularRadius + Math.sqrt(Math.max(0, 1 - cz * cz)) * Math.abs(range.sinAngularRadius || 0);
      if (maxZ < threshold) { current = null; continue; }
      if (current && current.indexStart + current.indexCount === range.indexStart) {
        current.indexCount += range.indexCount;
      } else {
        current = { indexStart: range.indexStart, indexCount: range.indexCount };
        ranges.push(current);
      }
    }
    return ranges;
  }
  function percentile(sorted: number[], q: number): number {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
  }
  function collectStats(now: number): GlobeStats {
    const recent = frameTimes.filter(function (x) { return now - x.at <= 10000; });
    frameTimes = recent;
    const values = recent.map(function (x) { return x.ms; }).sort(function (a, b) { return a - b; });
    const p95 = percentile(values, 0.95);
    return {
      fps: values.length ? 1000 / Math.max(0.01, values.reduce(function (a, b) { return a + b; }, 0) / values.length) : 0,
      p50: percentile(values, 0.50),
      p95: p95,
      p99: percentile(values, 0.99),
      over50: values.filter(function (x) { return x > 50; }).length,
      over100: values.filter(function (x) { return x > 100; }).length,
      worst5: values.slice(-5).reverse(),
      renderScale: renderScale,
      distance: distance,
    };
  }
  function resetStats(): void {
    const now = performance.now();
    frameTimes = [];
    lastFrameAt = now;
    lastStatsAt = 0;
    adaptCooldownUntil = now + 3000;
  }
  function adaptQuality(now: number): void {
    // Генерация в worker и GPU-заливка не должны навсегда уронить
    // масштаб рендера: это не steady-сценарий гейта.
    if (adaptiveQualityHold || pendingUpload) return;
    if (now < adaptCooldownUntil || frameTimes.length < 70) return;
    const stats = collectStats(now);
    if (stats.p95 > 21 && renderScale > 0.55) {
      renderScale = Math.max(0.55, renderScale * 0.85);
      adaptCooldownUntil = now + 2500;
    } else if (stats.p95 > 0 && stats.p95 < 12.5 && renderScale < 1) {
      renderScale = Math.min(1, renderScale * 1.10);
      adaptCooldownUntil = now + 4000;
    }
  }
  function draw(now: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(draw);
    const dtMs = now - lastFrameAt;
    lastFrameAt = now;
    if (dtMs > 0 && dtMs < 1000) frameTimes.push({ at: now, ms: dtMs });
    adaptQuality(now);
    processPendingUpload();
    const aspect = resizeIfNeeded();
    const dt = Math.min(0.05, Math.max(0.001, dtMs / 1000));
    if (flyAnim) {
      // Этап 7: авто-подлёт flyToDirection с easeOutCubic по углам и дистанции.
      const t = clamp01((now - flyAnim.startAt) / Math.max(1, flyAnim.durationMs));
      const e = 1 - Math.pow(1 - t, 3);
      pitch = flyAnim.fromX + (flyAnim.toX - flyAnim.fromX) * e;
      yaw = flyAnim.fromY + flyAnim.deltaY * e;
      distance = flyAnim.fromDist + (flyAnim.toDist - flyAnim.fromDist) * e;
      targetDistance = flyAnim.toDist;
      scheduleCameraIntent();
      if (t >= 1) flyAnim = null;
    } else {
      if (!interacting) {
        yaw += yawVelocity * dt;
        pitch = clamp(pitch + pitchVelocity * dt, -1.35, 1.35);
        yawVelocity *= Math.pow(0.12, dt);
        pitchVelocity *= Math.pow(0.12, dt);
        if (autoRotate) yaw += 0.045 * dt;
      }
      distance += (targetDistance - distance) * Math.min(1, dt * 9);
    }
    const model = mat4RotationYawPitch(yaw, pitch);
    const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -distance, 1]);
    const proj = mat4Perspective(fieldOfViewYForAspect(aspect), aspect, 0.05, 30);
    const mvp = mat4Multiply(proj, mat4Multiply(view, model));
    const camPos = [0, 0, distance];
    const buildP = currentBuildProgress(now);
    const viewDirObj = normalize3(transformDirectionTranspose(model, [0, 0, 1]));
    frameCtx.mvp = mvp;
    frameCtx.model = model;
    frameCtx.normalMat = model;
    eyePosF[0] = camPos[0] as number;
    eyePosF[1] = camPos[1] as number;
    eyePosF[2] = camPos[2] as number;
    frameCtx.timeSec = now * 0.001;

    GL.clearColor(0.006, 0.012, 0.030, 1);
    GL.clear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    GL.enable(GL.DEPTH_TEST);
    GL.depthMask(true);
    GL.disable(GL.BLEND);
    GL.enable(GL.CULL_FACE);
    GL.cullFace(GL.BACK);

    if (geometry && vao) {
      GL.useProgram(surfaceProgram);
      GL.uniformMatrix4fv(U.uMvp as WebGLUniformLocation | null, false, mvp);
      GL.uniformMatrix4fv(U.uModel as WebGLUniformLocation | null, false, model);
      GL.uniform3f(U.uSunDir as WebGLUniformLocation | null, sunDir[0] as number, sunDir[1] as number, sunDir[2] as number);
      GL.uniform3f(U.uCamPos as WebGLUniformLocation | null, camPos[0] as number, camPos[1] as number, camPos[2] as number);
      GL.uniform1f(U.uBorder as WebGLUniformLocation | null, bordersEnabled ? 1 : 0);
      GL.uniform3f(U.uViewDir as WebGLUniformLocation | null, viewDirObj[0] as number, viewDirObj[1] as number, viewDirObj[2] as number);
      if (opts.fx && opts.fx.onSurfaceDraw && surfaceProgram) {
        opts.fx.onSurfaceDraw(GL, surfaceProgram);
      }
      if (prevVao && prevIndexCount > 0 && prevGeometry) {
        // Этап 7: волна двухслойного центробежного замещения. Уходящий слой
        // схлопывается от центра взгляда к краю (uHide = t), новый прорастает
        // из центра (uCenterGrow = t). Оба рисуются собранными (uBuild = 1):
        // каскадная сборка с полюса не перезапускается.
        const t = clamp01((now - waveStartMs) / Math.max(1, waveDurationMs));
        GL.uniform1f(U.uBuild as WebGLUniformLocation | null, 1.0);
        GL.uniform1f(U.uHide as WebGLUniformLocation | null, t);
        GL.uniform1f(U.uCenterGrow as WebGLUniformLocation | null, 1.0);
        GL.bindVertexArray(prevVao);
        const prevRanges = visibleRanges(model, prevGeometry);
        for (let i = 0; i < prevRanges.length; i++) {
          GL.drawElements(GL.TRIANGLES, (prevRanges[i] as { indexCount: number }).indexCount, GL.UNSIGNED_INT, (prevRanges[i] as { indexStart: number }).indexStart * 4);
        }
        GL.uniform1f(U.uHide as WebGLUniformLocation | null, 0.0);
        GL.uniform1f(U.uCenterGrow as WebGLUniformLocation | null, t);
        GL.bindVertexArray(vao);
        const ranges = visibleRanges(model, geometry);
        for (let i = 0; i < ranges.length; i++) {
          GL.drawElements(GL.TRIANGLES, (ranges[i] as { indexCount: number }).indexCount, GL.UNSIGNED_INT, (ranges[i] as { indexStart: number }).indexStart * 4);
        }
        GL.bindVertexArray(null);
        if (t >= 1) disposePrevGeometry();
      } else {
        GL.uniform1f(U.uBuild as WebGLUniformLocation | null, buildP);
        GL.uniform1f(U.uHide as WebGLUniformLocation | null, hideValue);
        GL.uniform1f(U.uCenterGrow as WebGLUniformLocation | null, centerGrowValue);
        GL.bindVertexArray(vao);
        const ranges = visibleRanges(model, geometry);
        for (let i = 0; i < ranges.length; i++) {
          GL.drawElements(GL.TRIANGLES, (ranges[i] as { indexCount: number }).indexCount, GL.UNSIGNED_INT, (ranges[i] as { indexStart: number }).indexStart * 4);
        }
        GL.bindVertexArray(null);
      }

      if (opts.fx && opts.fx.onAfterSurfaceDraw) {
        try { opts.fx.onAfterSurfaceDraw(GL, frameCtx); } catch (_) { /* плагин не ломает рендер */ }
      }
    } else if (prevVao && prevIndexCount > 0 && prevGeometry) {
      // Пока новый VAO ещё заливается порциями в transitionGeometry,
      // удерживаем отрисовку предыдущего слоя без пустых кадров.
      GL.useProgram(surfaceProgram);
      GL.uniformMatrix4fv(U.uMvp as WebGLUniformLocation | null, false, mvp);
      GL.uniformMatrix4fv(U.uModel as WebGLUniformLocation | null, false, model);
      GL.uniform3f(U.uSunDir as WebGLUniformLocation | null, sunDir[0] as number, sunDir[1] as number, sunDir[2] as number);
      GL.uniform3f(U.uCamPos as WebGLUniformLocation | null, camPos[0] as number, camPos[1] as number, camPos[2] as number);
      GL.uniform1f(U.uBorder as WebGLUniformLocation | null, bordersEnabled ? 1 : 0);
      GL.uniform3f(U.uViewDir as WebGLUniformLocation | null, viewDirObj[0] as number, viewDirObj[1] as number, viewDirObj[2] as number);
      GL.uniform1f(U.uBuild as WebGLUniformLocation | null, 1.0);
      GL.uniform1f(U.uHide as WebGLUniformLocation | null, 0.0);
      GL.uniform1f(U.uCenterGrow as WebGLUniformLocation | null, 1.0);
      GL.bindVertexArray(prevVao);
      const prevRanges = visibleRanges(model, prevGeometry);
      for (let i = 0; i < prevRanges.length; i++) {
        GL.drawElements(GL.TRIANGLES, (prevRanges[i] as { indexCount: number }).indexCount, GL.UNSIGNED_INT, (prevRanges[i] as { indexStart: number }).indexStart * 4);
      }
      GL.bindVertexArray(null);
    }

    if (selectionVao && selectionIndexCount) {
      GL.enable(GL.BLEND);
      GL.blendFunc(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
      GL.depthMask(false);
      GL.disable(GL.CULL_FACE);
      GL.useProgram(simpleProgram);
      GL.uniformMatrix4fv(US.uMvp as WebGLUniformLocation | null, false, mvp);
      GL.uniform4f(US.uColor as WebGLUniformLocation | null, 0.25, 0.95, 1.0, 0.30);
      GL.bindVertexArray(selectionVao);
      GL.drawElements(GL.TRIANGLES, selectionIndexCount, GL.UNSIGNED_INT, 0);
      GL.uniform4f(US.uColor as WebGLUniformLocation | null, 0.45, 1.0, 0.98, 0.95);
      // Буфер: [центр, углы...]; контур рисуем только по углам.
      GL.drawArrays(GL.LINE_LOOP, 1, selectionCornerCount);
      GL.bindVertexArray(null);
      GL.depthMask(true);
      GL.disable(GL.BLEND);
    }

    if (atmosphereEnabled && atmoVao && geometry && vao) {
      GL.enable(GL.BLEND);
      GL.blendFunc(GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA);
      GL.depthMask(false);
      GL.useProgram(atmoProgram);
      GL.uniformMatrix4fv(UA.uMvp as WebGLUniformLocation | null, false, mvp);
      GL.uniformMatrix4fv(UA.uModel as WebGLUniformLocation | null, false, model);
      GL.uniform3f(UA.uCamPos as WebGLUniformLocation | null, camPos[0] as number, camPos[1] as number, camPos[2] as number);
      GL.uniform1f(UA.uBuild as WebGLUniformLocation | null, buildP);
      GL.bindVertexArray(atmoVao);
      GL.enable(GL.CULL_FACE);
      GL.cullFace(GL.FRONT);
      GL.uniform1f(UA.uScale as WebGLUniformLocation | null, 1.18);
      GL.uniform1f(UA.uIntensity as WebGLUniformLocation | null, 0.72);
      GL.drawElements(GL.TRIANGLES, atmoIndexCount, GL.UNSIGNED_INT, 0);
      GL.cullFace(GL.BACK);
      GL.uniform1f(UA.uScale as WebGLUniformLocation | null, 1.025);
      GL.uniform1f(UA.uIntensity as WebGLUniformLocation | null, 0.22);
      GL.drawElements(GL.TRIANGLES, atmoIndexCount, GL.UNSIGNED_INT, 0);
      GL.bindVertexArray(null);
      GL.depthMask(true);
      GL.disable(GL.BLEND);
    }

    if (typeof opts.onStats === 'function' && now - lastStatsAt > 500) {
      lastStatsAt = now;
      try { opts.onStats(collectStats(now)); } catch (_) { /* HUD не ломает рендер */ }
    }
  }

  function pickDirection(clientX: number, clientY: number): number[] | null {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
    const aspect = rect.width / rect.height;
    const tanHalf = Math.tan(fieldOfViewYForAspect(aspect) / 2);
    const ray = normalize3([ndcX * aspect * tanHalf, ndcY * tanHalf, -1]);
    const origin = [0, 0, distance];
    const b = (origin[0] as number) * (ray[0] as number) + (origin[1] as number) * (ray[1] as number) + (origin[2] as number) * (ray[2] as number);
    const c = (origin[0] as number) * (origin[0] as number) + (origin[1] as number) * (origin[1] as number) + (origin[2] as number) * (origin[2] as number) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = -b + Math.sqrt(disc);
    if (t < 0) return null;
    const hit = [(origin[0] as number) + (ray[0] as number) * t, (origin[1] as number) + (ray[1] as number) * t, (origin[2] as number) + (ray[2] as number) * t];
    const model = mat4RotationYawPitch(yaw, pitch);
    return normalize3(transformDirectionTranspose(model, hit));
  }

  function pointerDistance(): number {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return 0;
    return Math.hypot((pts[0] as { x: number }).x - (pts[1] as { x: number }).x, (pts[0] as { y: number }).y - (pts[1] as { y: number }).y);
  }
  function onPointerDown(e: PointerEvent): void {
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    interacting = true;
    flyAnim = null; // ручной жест прерывает авто-подлёт (Этап 7)
    yawVelocity = pitchVelocity = 0;
    downInfo = { x: e.clientX, y: e.clientY, at: performance.now(), moved: 0 };
    lastPinchDistance = pointerDistance();
  }
  function onPointerMove(e: PointerEvent): void {
    if (pointers.has(e.pointerId)) {
      const prev = pointers.get(e.pointerId) as { x: number; y: number };
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (downInfo) downInfo.moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 1) {
        const scale = 0.0052;
        yaw += dx * scale;
        pitch = clamp(pitch + dy * scale, -1.35, 1.35);
        yawVelocity = dx * scale * 60;
        pitchVelocity = dy * scale * 60;
        if (downInfo && downInfo.moved > 2) scheduleCameraIntent();
      } else if (pointers.size === 2) {
        const d = pointerDistance();
        if (lastPinchDistance > 0 && d > 0) {
          targetDistance = clamp(targetDistance * lastPinchDistance / d, MIN_DISTANCE, MAX_DISTANCE);
          scheduleCameraIntent();
        }
        lastPinchDistance = d;
      }
    } else if (typeof opts.onHoverDirection === 'function' && e.pointerType === 'mouse' && !hoverQueued) {
      hoverQueued = true;
      requestAnimationFrame(function () {
        hoverQueued = false;
        const dir = pickDirection(e.clientX, e.clientY);
        if (dir && opts.onHoverDirection) {
          try { opts.onHoverDirection(dir); } catch (_) { /* noop */ }
        }
      });
    }
  }
  function onPointerUp(e: PointerEvent): void {
    const wasClick = downInfo && downInfo.moved < 7 && performance.now() - downInfo.at < 600;
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      interacting = false;
      lastPinchDistance = 0;
      if (wasClick && typeof opts.onPickDirection === 'function') {
        const dir = pickDirection(e.clientX, e.clientY);
        if (dir) {
          try { opts.onPickDirection(dir); } catch (_) { /* noop */ }
        } else if (typeof opts.onPickMiss === 'function') {
          try { opts.onPickMiss(); } catch (_) { /* noop */ }
        }
      }
      downInfo = null;
    }
  }
  function onPointerCancel(e: PointerEvent): void {
    pointers.delete(e.pointerId);
    if (!pointers.size) { interacting = false; downInfo = null; lastPinchDistance = 0; }
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    flyAnim = null; // ручной жест прерывает авто-подлёт (Этап 7)
    const factor = Math.exp(clamp(e.deltaY, -240, 240) * 0.0016);
    targetDistance = clamp(targetDistance * factor, MIN_DISTANCE, MAX_DISTANCE);
    scheduleCameraIntent();
    // Stage-8.2: зум колёсиком вглубь на упоре дистанции — сигнал погружения
    // на локальный уровень выбранной ячейки (защита от спама 500 мс).
    if (e.deltaY < 0 && targetDistance <= MIN_DISTANCE * 1.03 && typeof opts.onZoomDive === 'function') {
      const now = performance.now();
      if (now - lastZoomDiveAt >= 500) {
        lastZoomDiveAt = now;
        try { opts.onZoomDive(); } catch (_) { /* noop */ }
      }
    }
    if (typeof opts.onZoomChange === 'function') {
      try { opts.onZoomChange(targetDistance); } catch (_) { /* noop */ }
    }
  }
  function onContextLost(e: Event): void {
    e.preventDefault();
    if (typeof opts.onContextLost === 'function') {
      try { opts.onContextLost(); } catch (_) { /* noop */ }
    }
  }
  function onContextRestored(): void {
    const restoreGeometry = pendingUpload ? pendingUpload.geometry : geometry;
    pendingUpload = null;
    disposePrevGeometry(); // prev-слой погиб вместе с контекстом
    vao = positionBuffer = colorBuffer = normalBuffer = indexBuffer = null;
    selectionVao = selectionBuffer = selectionIndexBuffer = null;
    initPrograms();
    uploadGeometry(restoreGeometry);
    uploadSelection();
    if (typeof opts.onContextRestored === 'function') {
      try { opts.onContextRestored(); } catch (_) { /* noop */ }
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  initPrograms();
  raf = requestAnimationFrame(draw);

  return {
    version: GLOBE_VERSION,
    canvas: canvas,
    gl: GL,
    setGeometry: function (nextGeometry) {
      uploadGeometry(nextGeometry);
    },
    setColors: function (colors) {
      if (pendingUpload) {
        pendingUpload.geometry.colors = colors;
        queuedColors = colors;
        return;
      }
      if (!geometry || !colorBuffer) return;
      geometry.colors = colors;
      GL.bindBuffer(GL.ARRAY_BUFFER, colorBuffer);
      GL.bufferData(GL.ARRAY_BUFFER, colors, GL.DYNAMIC_DRAW);
      GL.bindBuffer(GL.ARRAY_BUFFER, null);
    },
    setSelection: function (nextSelection) {
      selection = nextSelection;
      uploadSelection();
    },
    clearSelection: function () {
      selection = null;
      uploadSelection();
    },
    setBordersEnabled: function (enabled) { bordersEnabled = !!enabled; },
    setAutoRotate: function (enabled) { autoRotate = !!enabled; },
    setAtmosphereEnabled: function (enabled) { atmosphereEnabled = !!enabled; },
    setDistance: function (value) { targetDistance = clamp(Number(value) || targetDistance, MIN_DISTANCE, MAX_DISTANCE); },
    getDistance: function () { return targetDistance; },
    resetView: function () {
      yaw = -0.65; pitch = 0.38; yawVelocity = pitchVelocity = 0;
      targetDistance = 3.05;
    },
    pickDirection: pickDirection,
    setAdaptiveQualityHold: function (enabled) { adaptiveQualityHold = !!enabled; },
    isGeometryUploading: function () { return !!pendingUpload; },
    resetStats: resetStats,
    getStats: function () { return collectStats(performance.now()); },
    setBuildProgress: function (value) {
      buildAnimStart = -1;
      buildValue = clamp01(Number(value));
    },
    animateBuild: function (durationSec) {
      buildValue = 0;
      buildAnimStart = performance.now();
      buildAnimDur = Math.max(0.05, Number(durationSec) || 0) * 1000;
    },
    setCenterGrow: function (value, hideMask) {
      centerGrowValue = clamp01(Number(value));
      if (hideMask !== undefined) hideValue = clamp01(Number(hideMask));
    },
    transitionGeometry: function (nextGeometry, durationSec) {
      // Этап 7: двухслойное центробежное замещение. Текущий слой переносится
      // в prev-слот целиком (VAO + все буферы), затем новая геометрия грузится
      // в основной слот через setGeometry — ракурс и каскадная сборка (uBuild=1)
      // не сбрасываются, волна идёт от центра взгляда.
      if (!nextGeometry) {
        disposePrevGeometry();
        uploadGeometry(null);
        return;
      }
      if (vao && positionBuffer && normalBuffer && colorBuffer && indexBuffer && geometry) {
        disposePrevGeometry();
        prevVao = vao;
        prevPosBuf = positionBuffer;
        prevNormBuf = normalBuffer;
        prevColorBuf = colorBuffer;
        prevIdxBuf = indexBuffer;
        prevIndexCount = geometry.indexCount;
        prevGeometry = geometry;
        vao = null;
        positionBuffer = null;
        normalBuffer = null;
        colorBuffer = null;
        indexBuffer = null;
      }
      uploadGeometry(nextGeometry as GlobeGeometry);
      startCentrifugalTransition(durationSec);
    },
    flyToDirection: function (direction, targetDistanceValue, durationMs) {
      // Этап 7: подлёт так, чтобы point сферы direction встал ровно в центр
      // экрана: targetRotX = asin(dy), targetRotY = atan2(-dx, dz) — тогда
      // normalize(cameraPosition()) совпадает с direction (см.
      // cameraDirectionFromAngles и mat4RotationYawPitch).
      const dx = Number(direction && direction[0]) || 0;
      const dy = Number(direction && direction[1]) || 0;
      const dz = Number(direction && direction[2]) || 0;
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0) || !Number.isFinite(len)) return;
      const targetRotX = clamp(Math.asin(clamp(dy / len, -1, 1)), -1.48, 1.48);
      const targetRotY = Math.atan2(-dx / len, dz / len);
      const requested = Number(targetDistanceValue);
      flyAnim = {
        fromX: pitch,
        fromY: yaw,
        toX: targetRotX,
        deltaY: shortestArcDelta(targetRotY - yaw),
        fromDist: distance,
        toDist: Number.isFinite(requested) && requested > 0
          ? clamp(requested, MIN_DISTANCE, MAX_DISTANCE)
          : targetDistance,
        startAt: performance.now(),
        durationMs: Math.max(80, Number(durationMs) == null ? 650 : Number(durationMs)),
      };
      yawVelocity = pitchVelocity = 0;
      scheduleCameraIntent();
    },
    getCameraState: function () {
      return {
        rotX: pitch,
        rotY: yaw,
        distance: distance,
        viewDirection: cameraDirectionFromAngles(pitch, yaw),
      };
    },
    dispose: function () {
      disposed = true;
      if (opts.fx && opts.fx.onDispose) {
        try { opts.fx.onDispose(GL); } catch (_) { /* плагин не ломает dispose */ }
      }
      if (intentTimer) { clearTimeout(intentTimer); intentTimer = 0; }
      flyAnim = null;
      cancelAnimationFrame(raf);
      disposePrevGeometry();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      deletePendingUpload();
      deleteSurfaceBuffers();
      if (selectionVao) GL.deleteVertexArray(selectionVao);
      if (selectionBuffer) GL.deleteBuffer(selectionBuffer);
      if (selectionIndexBuffer) GL.deleteBuffer(selectionIndexBuffer);
    },
  };
}

const PlanetGlobe = {
  GLOBE_VERSION: GLOBE_VERSION,
  COLOR_MODES: COLOR_MODES.map(function (x) { return { key: x.key, label: x.label }; }),
  buildCellColors: buildCellColors,
  listGeometryTransferables: listGeometryTransferables,
  cellPolygon: cellPolygon,
  buildEquirectPreview: buildEquirectPreview,
  fieldOfViewYForAspect: fieldOfViewYForAspect,
  createPlanetGlobe: createPlanetGlobe,
};

export default PlanetGlobe;

declare global {
  interface Window {
    PlanetGlobe: typeof PlanetGlobe;
  }
}

(globalThis as unknown as { PlanetGlobe: typeof PlanetGlobe }).PlanetGlobe = PlanetGlobe;
