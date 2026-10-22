/* PlanetGlobeFx — опциональные экспериментальные режимы боевого глобуса
   (CR-01 PR 5, И-5.3/И-6): уникальные режимы стенда /planet-test/ перенесены
   типизированными модулями в единый рендерер planet-globe, дублирующий
   монолит planet-test.js удалён.
   --------------------------------------------------------------------------
   Два режима (mini-spike-22, «эффекты Шакураса»):

   1. Взрыв осколков Шакураса (uSep): GPU-трансформ осколков по строкам
      текстуры uShardTex (pivot / ось / дрейф / (spin, a, b)); фактический
      разлёт sepEff = uSep*a + b, «потерянные» осколки несут a=1.35, b=0.75.
      Анимация взрыва/сброса двигает ТОЛЬКО юниформ uSep — геометрия не
      пересобирается (animateShardSeparation). Взрыв/сброс: easeOutCubic
      2400 мс / easeInOutQuad 1500 мс, целевые jag/thick выставляются один
      раз до анимации (BOOM_TARGET / BOOM_DEFAULTS).

   2. Шейдерные диагностические палитры (uPalette 0…6) + декоративные
      фактуры поверхности (uTexMode 1…5, uTexAmount/uTexScale/uTexSeed) и
      hue-поворот. Палитры и фактуры — рендер-кастомизация: они не являются
      источником географии (берег, биом и адрес ячейки задают CPU-поля
      c100-soft-v2; на вершинном формате planet-globe-v1 влага/температура
      для палитр аппроксимируются декоративным шумом направления).

   Модуль опционален: createFxHooks() отдаёт PlanetGlobeFxHooks для
   необязательного поля `fx` в PlanetGlobeOptions. Без hooks глобус
   рисуется ровно как раньше (побочных эффектов нет).

   Канонический CPU-путь осколков (computeShardLayout + buildShardTextureData)
   перенесён сюда из легаси-модуля site/shared/planet-geometry.js (И-5) и
   работает одинаково для стенда /planet-test/ и объёма разломов.

   Индекс осколка на вершинном формате planet-globe-v1 (Волна PR 6.1):
   вершина не несёт `aShard`, поэтому принадлежность ячейки осколку
   разворачивается на вершины через `geometry.vertexCellId` и уходит в
   целочисленную текстуру `uShardIdTex`, которую вершинный шейдер читает по
   `gl_VertexID`. Все вершины одной ячейки получают ОДИН индекс, и веер
   ячейки не растягивается через всю планету (старый `fxShardIndex(aPos)`
   квантовал направление каждой вершины отдельно). Резерв без grid/geometry —
   квантование направления нормали ячейки (uShardIdReady = 0). */

import PlanetNoise from '../../site/shared/planet-noise.ts';
import type { PlanetGrid } from '../../site/shared/geodesic-grid.ts';
import type { GlobeGeometry, PlanetGlobeFxHooks } from '../../site/shared/planet-globe.ts';

export const PLANET_GLOBE_FX_VERSION = 'planet-globe-fx-v1';

/** Максимум осколков в uShardTex (столбцы RGBA32F, 4 строки на осколок). */
export const MAX_SHARDS = 64;

// ===========================================================================
// 1. Шейдерные чанки (канонический GLSL спайка)
// ===========================================================================

/** Трансформ осколка: строки текстуры — pivot / ось / дрейф / (spin, a, b). */
export const SHARD_TRANSFORM_GLSL = `
uniform sampler2D uShardTex;
uniform float uSep;
uniform float uShardMode;
// Трансформ осколка на GPU: строки текстуры — pivot / ось / дрейф /
// (spin, a, b), где фактический разлёт осколка sepEff = uSep*a + b
// (потерянные: a=1.35, b=0.75). Разлёт — юниформ: анимация без пересборки.
vec3 shardTransform(vec3 p, float sf) {
  int si = int(sf + 0.5);
  vec3 pivot = texelFetch(uShardTex, ivec2(si, 0), 0).xyz;
  vec3 axis = texelFetch(uShardTex, ivec2(si, 1), 0).xyz;
  vec3 drift = texelFetch(uShardTex, ivec2(si, 2), 0).xyz;
  vec3 par = texelFetch(uShardTex, ivec2(si, 3), 0).xyz;
  float sepEff = uSep * par.y + par.z;
  float ang = min(sepEff, 1.2) * par.x;
  float ca = cos(ang);
  float sa = sin(ang);
  vec3 v = p - pivot;
  vec3 r = v * ca + cross(axis, v) * sa + axis * dot(axis, v) * (1.0 - ca);
  return pivot + r + drift * sepEff;
}
`;

/** Клеточный индекс осколка: целочисленная текстура по gl_VertexID.
 *  Все вершины одной ячейки читают один и тот же texel (vertexCellId →
 *  layout.shardOf), поэтому веер ячейки не расходится между осколками. */
export const SHARD_CELL_INDEX_GLSL = `
uniform float uShardCount;
uniform float uShardIdReady;
uniform highp usampler2D uShardIdTex;
uniform int uShardIdW;
// Канонический путь: индекс осколка ячейки из текстуры (КЛЕТОЧНЫЙ индекс,
// одинаковый для центра веера и всех его углов).
float fxShardIndexCell() {
  int w = max(uShardIdW, 1);
  int vid = gl_VertexID;
  return float(texelFetch(uShardIdTex, ivec2(vid % w, vid / w), 0).r);
}
// Резерв без сетки/геометрии: квантование направления нормали ячейки.
float fxShardIndexFallback(vec3 cellNormal) {
  vec3 q = floor(normalize(cellNormal) * max(uShardCount, 1.0) * 0.5) + 0.5;
  return floor(fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * uShardCount);
}
vec3 fxShardPosition(vec3 p, vec3 cellNormal) {
  if (uShardMode < 0.5) return p;
  float si = uShardIdReady > 0.5 ? fxShardIndexCell() : fxShardIndexFallback(cellNormal);
  return shardTransform(p, si);
}
`;

/** Диагностические палитры 0…6 + hue-поворот (поле f: relief/moist/temp/hash). */
export const PALETTE_GLSL = `
uniform float uPalette;
uniform float uHueShift;
vec3 hueRotate(vec3 c, float a) {
  if (abs(a) < 0.001) return c;
  vec3 k = vec3(0.577350269);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec3 paletteColor(vec3 base, vec4 f) {
  if (uPalette < 0.5) return base;
  float relief = f.x * 2.0 - 1.0;
  float depth = clamp(-relief, 0.0, 1.0);
  float landH = clamp(relief, 0.0, 1.0);
  float moist = f.y;
  float temp = f.z;
  bool ocean = relief < 0.0;
  if (uPalette < 1.5) {
    vec3 oc = mix(vec3(0.05, 0.30, 0.33), vec3(0.01, 0.07, 0.16), smoothstep(0.04, 0.82, depth));
    vec3 land = mix(vec3(0.80, 0.62, 0.31), vec3(0.56, 0.34, 0.19), smoothstep(0.22, 0.88, landH));
    land = mix(land, vec3(0.40, 0.48, 0.21), smoothstep(0.62, 0.92, moist) * 0.55);
    land = mix(land, vec3(0.90, 0.84, 0.69), smoothstep(0.86, 1.0, landH));
    land = mix(land, vec3(0.93, 0.91, 0.83), (1.0 - smoothstep(0.05, 0.18, temp)) * 0.65);
    return ocean ? oc : land;
  }
  if (uPalette < 2.5) {
    vec3 oc = mix(vec3(0.10, 0.55, 0.72), vec3(0.01, 0.10, 0.28), smoothstep(0.03, 0.80, depth));
    oc = mix(oc, vec3(0.88, 0.95, 1.0), (1.0 - smoothstep(0.06, 0.20, temp)) * 0.82);
    vec3 land = mix(vec3(0.68, 0.82, 0.92), vec3(0.96, 0.99, 1.0), smoothstep(0.15, 0.95, landH));
    land = mix(land, vec3(0.36, 0.55, 0.62), smoothstep(0.55, 0.95, moist) * 0.35);
    land = mix(land, vec3(1.0), (1.0 - smoothstep(0.10, 0.30, temp)) * 0.55);
    return ocean ? oc : land;
  }
  if (uPalette < 3.5) {
    vec3 oc = mix(vec3(0.10, 0.05, 0.06), vec3(0.015, 0.012, 0.025), smoothstep(0.03, 0.82, depth));
    vec3 land = mix(vec3(0.16, 0.10, 0.09), vec3(0.48, 0.18, 0.09), smoothstep(0.18, 0.92, landH));
    land = mix(land, vec3(0.85, 0.32, 0.07), smoothstep(0.55, 0.92, temp) * 0.55);
    land = mix(land, vec3(0.40, 0.37, 0.34), smoothstep(0.78, 1.0, landH) * 0.55);
    return ocean ? oc : land;
  }
  if (uPalette < 4.5) {
    vec3 oc = mix(vec3(0.05, 0.65, 0.72), vec3(0.005, 0.16, 0.48), smoothstep(0.03, 0.80, depth));
    vec3 land = mix(vec3(0.76, 0.68, 0.38), vec3(0.08, 0.52, 0.25), smoothstep(0.34, 0.78, moist));
    land = mix(land, vec3(0.45, 0.43, 0.39), smoothstep(0.70, 0.95, landH) * 0.80);
    land = mix(land, vec3(0.94, 0.97, 1.0), smoothstep(0.90, 1.0, landH));
    return ocean ? oc : land;
  }
  if (uPalette < 5.5) {
    vec3 oc = mix(vec3(0.35, 0.10, 0.65), vec3(0.03, 0.02, 0.22), smoothstep(0.03, 0.82, depth));
    vec3 land = mix(vec3(0.10, 0.75, 0.65), vec3(0.85, 0.25, 0.90), smoothstep(0.20, 0.85, moist));
    land = mix(land, vec3(0.95, 0.55, 0.20), smoothstep(0.62, 0.95, temp) * 0.45);
    land = mix(land, vec3(0.90, 0.90, 1.0), smoothstep(0.82, 1.0, landH) * 0.70);
    return ocean ? oc : land;
  }
  float lum = ocean ? (0.10 + 0.20 * (1.0 - depth)) : (0.24 + 0.58 * landH);
  vec3 holo = mix(vec3(0.01, 0.10, 0.16), vec3(0.10, 0.95, 0.78), lum);
  holo = mix(holo, vec3(0.75, 1.0, 0.98), (1.0 - smoothstep(0.05, 0.20, temp)) * 0.45);
  return holo;
}
`;

/** Декоративные фактуры поверхности (не источник географии: рендер-кастомизация). */
export const FX_TEXTURE_GLSL = `
uniform float uTexMode;
uniform float uTexAmount;
uniform float uTexScale;
uniform vec3 uTexSeed;
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  return vnoise(p) * 0.55 + vnoise(p * 2.13) * 0.30 + vnoise(p * 4.41) * 0.15;
}
vec3 fxTexture(vec3 albedo, vec3 dir, vec4 f, float landMask, float oceanMask) {
  float amount = clamp(uTexAmount, 0.0, 1.0);
  if (amount <= 0.001 || uTexMode < 0.5) return albedo;
  vec3 p = dir * max(uTexScale, 0.1) + uTexSeed;
  float n1 = fbm3(p);
  float n2 = vnoise(p * 3.7 + uTexSeed * 1.31 + vec3(17.7, 9.2, 4.3));
  float cellTone = 0.96 + 0.08 * f.w;
  if (uTexMode < 1.5) {
    float grain = mix(0.80, 1.20, n1) * mix(0.92, 1.08, n2) * cellTone;
    albedo *= mix(1.0, grain, amount * (0.35 + 0.65 * landMask));
    albedo = mix(albedo, albedo * vec3(1.05, 0.99, 0.90), amount * smoothstep(0.68, 0.96, n2) * landMask * 0.35);
  } else if (uTexMode < 2.5) {
    float bands = 0.5 + 0.5 * sin((dir.x * 1.7 - dir.y * 2.3 + dir.z * 1.1) * uTexScale * 2.2 + n1 * 9.0);
    float dry = landMask * (1.0 - smoothstep(0.34, 0.74, f.y));
    float duneMask = max(dry, oceanMask * 0.32);
    albedo *= mix(1.0, mix(0.86, 1.16, bands), amount * duneMask);
    albedo = mix(albedo, albedo * vec3(1.09, 1.02, 0.84), amount * dry * smoothstep(0.72, 0.98, bands) * 0.45);
  } else if (uTexMode < 3.5) {
    float ridge = 1.0 - abs(n1 * 2.0 - 1.0);
    float line = smoothstep(0.86, 0.995, ridge) * (0.55 + 0.45 * n2);
    float hot = smoothstep(0.54, 0.86, f.z);
    float cold = 1.0 - smoothstep(0.16, 0.38, f.z);
    vec3 crackCol = mix(vec3(0.045, 0.032, 0.026), vec3(1.0, 0.36, 0.05), hot);
    crackCol = mix(crackCol, vec3(0.72, 0.90, 1.0), cold * 0.82);
    float crackMask = max(landMask, cold * oceanMask * 0.85);
    albedo = mix(albedo, crackCol, clamp(amount * line * crackMask, 0.0, 0.92));
    albedo += vec3(1.0, 0.34, 0.04) * line * amount * hot * landMask * 0.90;
  }
  return albedo;
}
`;

// ===========================================================================
// 2. Осколки Шакураса: layout → текстура uShardTex (канонический CPU-путь)
// ===========================================================================

export type ShardDist = 'equal' | 'power' | 'lognormal';

export interface ShardParams {
  /** Число осколков 2…MAX_SHARDS. */
  count: number;
  dist: ShardDist;
  /** Текущий разлёт (юниформ uSep). */
  sep: number;
  /** Толщина стен разлома (плотность осколков). */
  thick: number;
  /** Рваность границ осколков. */
  jag: number;
  /** Доля «потерянных» осколков (a=1.35, b=0.75). */
  loss: number;
  seedText: string;
}

export interface ShardLayout {
  /** Принадлежность ячеек осколкам (канонический путь с aShard). */
  shardOf: Uint16Array;
  counts: Uint32Array;
  pivots: Float32Array;
  axes: Float32Array;
  driftVec: Float32Array;
  spin: Float32Array;
  count: number;
  nonEmpty: number;
}

export interface ShardTextureInfo {
  count: number;
  nonEmpty: number;
  counts: Uint32Array;
  lost: number;
}

export interface ShardTextureResult {
  /** 64×4×4 Float32Array для gl.RGBA32F: строки pivot/axis/drift/(spin,a,b). */
  data: Float32Array | null;
  shardInfo: ShardTextureInfo | null;
  /** Максимум b (терминальный разлёт «потерянных»). */
  shardMaxB: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildShardTextureData(
  layout: ShardLayout | null,
  loss: number,
): ShardTextureResult {
  if (!layout) return { data: null, shardInfo: null, shardMaxB: 0 };
  const shardInfo: ShardTextureInfo = {
    count: layout.count,
    nonEmpty: layout.nonEmpty,
    counts: layout.counts.slice(),
    lost: 0,
  };
  const lost = new Uint8Array(layout.count);
  if (loss > 0) {
    const order: number[] = [];
    for (let oi = 0; oi < layout.count; oi++) {
      if ((layout.counts[oi] as number) > 0) order.push(oi);
    }
    order.sort((a, b) => (layout.counts[a] as number) - (layout.counts[b] as number));
    const lostCount = Math.min(Math.max(0, order.length - 1),
      Math.round(order.length * loss * 0.35));
    for (let li = 0; li < lostCount; li++) lost[order[li] as number] = 1;
    shardInfo.lost = lostCount;
  }

  const texData = new Float32Array(MAX_SHARDS * 4 * 4);
  let shardMaxB = 0;
  for (let si = 0; si < layout.count; si++) {
    let pa = 1, pb = 0;
    if (lost[si]) { pa = 1.35; pb = 0.75; }
    else if ((layout.counts[si] as number) > 0 && (layout.counts[si] as number) < 12) pa = 1 + loss * 0.8;
    if (pb > shardMaxB) shardMaxB = pb;
    texData.set([layout.pivots[si * 3] as number, layout.pivots[si * 3 + 1] as number, layout.pivots[si * 3 + 2] as number, 0], si * 4);
    texData.set([layout.axes[si * 3] as number, layout.axes[si * 3 + 1] as number, layout.axes[si * 3 + 2] as number, 0], (MAX_SHARDS + si) * 4);
    texData.set([layout.driftVec[si * 3] as number, layout.driftVec[si * 3 + 1] as number, layout.driftVec[si * 3 + 2] as number, 0], (MAX_SHARDS * 2 + si) * 4);
    texData.set([layout.spin[si] as number, pa, pb, 0], (MAX_SHARDS * 3 + si) * 4);
  }
  return { data: texData, shardInfo, shardMaxB };
}

interface ShardSeeds {
  centers: Float32Array;
  sizes: Float32Array;
  rnd: () => number;
}

function makeShardSeeds(count: number, dist: ShardDist, seedText: string): ShardSeeds {
  const K = count;
  const rnd = mulberry32(PlanetNoise.stringSeed(seedText + ':shards'));
  const centers = new Float32Array(K * 3);
  const sizes = new Float32Array(K);
  if (dist === 'equal') {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < K; i++) {
      const y = K === 1 ? 0 : 1 - (i / (K - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const th = golden * i;
      centers[i * 3] = Math.cos(th) * r;
      centers[i * 3 + 1] = y;
      centers[i * 3 + 2] = Math.sin(th) * r;
      sizes[i] = 1;
    }
  } else {
    for (let i = 0; i < K; i++) {
      const z = rnd() * 2 - 1;
      const ph = rnd() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      centers[i * 3] = Math.cos(ph) * rr;
      centers[i * 3 + 1] = z;
      centers[i * 3 + 2] = Math.sin(ph) * rr;
      if (dist === 'power') {
        // Парето, α=1.3: пара крупных осколков и много мелочи — как при дроблении.
        sizes[i] = Math.pow(1 - rnd() * 0.999, -1 / 1.3);
      } else {
        // Логнормальная, σ=0.8: плавный разброс без тяжёлого хвоста.
        const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(rnd() * Math.PI * 2);
        sizes[i] = Math.exp(0.8 * g);
      }
    }
  }
  return { centers, sizes, rnd };
}

/** Радиусы осколков (сфера Фурье-раздела) → плотность назначения ячеек. */
function shardDensities(sizes: Float32Array): Float32Array {
  const K = sizes.length;
  let sum = 0;
  for (let i = 0; i < K; i++) sum += sizes[i] as number;
  const rho2 = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const frac = Math.min(0.9, (sizes[i] as number) / sum);
    const rho = Math.acos(1 - 2 * frac);
    rho2[i] = Math.max(1e-8, rho * rho);
  }
  return rho2;
}

function assignCellsToShards(
  grid: PlanetGrid,
  centers: Float32Array,
  rho2: Float32Array,
): { shardOf: Uint16Array; counts: Uint32Array; cent: Float64Array } {
  const K = rho2.length;
  const F = grid.cellCount;
  const shardOf = new Uint16Array(F);
  const counts = new Uint32Array(K);
  const cent = new Float64Array(K * 3);
  for (let c = 0; c < F; c++) {
    const cx = grid.centers[c * 3] as number;
    const cy = grid.centers[c * 3 + 1] as number;
    const cz = grid.centers[c * 3 + 2] as number;
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < K; i++) {
      const dot = cx * (centers[i * 3] as number) + cy * (centers[i * 3 + 1] as number) + cz * (centers[i * 3 + 2] as number);
      const score = (1 - dot) / (rho2[i] as number);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    shardOf[c] = best;
    counts[best] = (counts[best] as number) + 1;
    cent[best * 3] = (cent[best * 3] as number) + cx;
    cent[best * 3 + 1] = (cent[best * 3 + 1] as number) + cy;
    cent[best * 3 + 2] = (cent[best * 3 + 2] as number) + cz;
  }
  return { shardOf, counts, cent };
}

function fillShardRows(
  seeds: ShardSeeds,
  counts: Uint32Array,
  cent: Float64Array,
  cellCount: number,
): { pivots: Float32Array; axes: Float32Array; driftVec: Float32Array; spin: Float32Array; nonEmpty: number } {
  const K = counts.length;
  const { centers, rnd } = seeds;
  const pivots = new Float32Array(K * 3);
  const axes = new Float32Array(K * 3);
  const driftVec = new Float32Array(K * 3);
  const spin = new Float32Array(K);
  let nonEmpty = 0;
  for (let i = 0; i < K; i++) {
    spin[i] = (rnd() * 2 - 1) * 0.7;
    const px = cent[i * 3] as number, py = cent[i * 3 + 1] as number, pz = cent[i * 3 + 2] as number;
    const pl = Math.sqrt(px * px + py * py + pz * pz);
    if ((counts[i] as number) > 0 && pl > 1e-9) {
      nonEmpty++;
      pivots[i * 3] = px / pl; pivots[i * 3 + 1] = py / pl; pivots[i * 3 + 2] = pz / pl;
    } else {
      pivots[i * 3] = centers[i * 3] as number;
      pivots[i * 3 + 1] = centers[i * 3 + 1] as number;
      pivots[i * 3 + 2] = centers[i * 3 + 2] as number;
    }
    const ax = rnd() * 2 - 1, ay = rnd() * 2 - 1, az = rnd() * 2 - 1;
    const gx = (pivots[i * 3 + 1] as number) * az - (pivots[i * 3 + 2] as number) * ay;
    const gy = (pivots[i * 3 + 2] as number) * ax - (pivots[i * 3] as number) * az;
    const gz = (pivots[i * 3] as number) * ay - (pivots[i * 3 + 1] as number) * ax;
    let gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
    let ux = gx, uy = gy, uz = gz;
    if (gl < 1e-6) { ux = 1; uy = 0; uz = 0; gl = 1; }
    axes[i * 3] = ux / gl; axes[i * 3 + 1] = uy / gl; axes[i * 3 + 2] = uz / gl;
    const actualFrac = (counts[i] as number) / Math.max(1, cellCount);
    const sizeFactor = actualFrac > 0
      ? Math.min(1.9, Math.max(0.7, Math.pow((1 / K) / actualFrac, 0.18))) : 1.5;
    const radial = (0.5 + rnd() * 0.9) * sizeFactor;
    let tx = rnd() * 2 - 1, ty = rnd() * 2 - 1, tz = rnd() * 2 - 1;
    const tdot = tx * (pivots[i * 3] as number) + ty * (pivots[i * 3 + 1] as number) + tz * (pivots[i * 3 + 2] as number);
    tx -= tdot * (pivots[i * 3] as number); ty -= tdot * (pivots[i * 3 + 1] as number); tz -= tdot * (pivots[i * 3 + 2] as number);
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    const tang = 0.35 * rnd() * sizeFactor;
    driftVec[i * 3] = (pivots[i * 3] as number) * radial + (tx / tl) * tang;
    driftVec[i * 3 + 1] = (pivots[i * 3 + 1] as number) * radial + (ty / tl) * tang;
    driftVec[i * 3 + 2] = (pivots[i * 3 + 2] as number) * radial + (tz / tl) * tang;
  }
  return { pivots, axes, driftVec, spin, nonEmpty };
}

function makeLayout(
  seeds: ShardSeeds,
  shardOf: Uint16Array,
  counts: Uint32Array,
  cent: Float64Array,
  cellCount: number,
): ShardLayout {
  const rows = fillShardRows(seeds, counts, cent, cellCount);
  return {
    shardOf,
    counts,
    pivots: rows.pivots,
    axes: rows.axes,
    driftVec: rows.driftVec,
    spin: rows.spin,
    count: counts.length,
    nonEmpty: rows.nonEmpty,
  };
}

const shardLayoutCache = new Map<string, ShardLayout>();

/** Канонический путь с aShard: разбиение сетки на осколки (Этапы 8/9). */
export function computeShardLayout(grid: PlanetGrid, sp: ShardParams): ShardLayout | null {
  if (!(sp.count > 1)) return null;
  const key = grid.v + '|' + sp.count + '|' + sp.dist + '|' + sp.seedText;
  const cached = shardLayoutCache.get(key);
  if (cached) {
    shardLayoutCache.delete(key);
    shardLayoutCache.set(key, cached);
    return cached;
  }
  const seeds = makeShardSeeds(sp.count, sp.dist, sp.seedText);
  const rho2 = shardDensities(seeds.sizes);
  const { shardOf, counts, cent } = assignCellsToShards(grid, seeds.centers, rho2);
  const layout = makeLayout(seeds, shardOf, counts, cent, grid.cellCount);
  shardLayoutCache.set(key, layout);
  while (shardLayoutCache.size > 4) {
    const oldest = shardLayoutCache.keys().next();
    if (oldest.done) break;
    shardLayoutCache.delete(oldest.value);
  }
  return layout;
}

/** Процедурный путь для planet-globe-v1 (без aShard): строки трансформов
 *  осколков без разбиения сетки — индекс осколка квантует GLSL. */
export function buildProceduralShardLayout(sp: ShardParams): ShardLayout | null {
  if (!(sp.count > 1)) return null;
  const K = sp.count;
  const seeds = makeShardSeeds(K, sp.dist, sp.seedText);
  const shardOf = new Uint16Array(0);
  const counts = new Uint32Array(K).fill(1);
  const cent = new Float64Array(K * 3);
  for (let i = 0; i < K; i++) {
    cent[i * 3] = seeds.centers[i * 3] as number;
    cent[i * 3 + 1] = seeds.centers[i * 3 + 1] as number;
    cent[i * 3 + 2] = seeds.centers[i * 3 + 2] as number;
  }
  return makeLayout(seeds, shardOf, counts, cent, K);
}

// ===========================================================================
// 2.1 Перенос site/shared/planet-geometry.js в строгий TS (Инвариант И-5)
// ===========================================================================
//
// Модуль не знает про DOM и WebGL: он превращает сетку Голдберга, поля
// планеты и параметры осколков в типизированные массивы поверхности и
// объёма. Численные выражения перенесены из легаси-файла дословно, поэтому
// канонические адреса ячеек и форма разломов не меняются. Легаси-файл
// site/shared/planet-geometry.js удалён: единственный владелец логики —
// этот модуль.

/** Поля ячейки, из которых строятся цвета и квантованные атрибуты. */
export interface PlanetFields {
  elev: Float32Array;
  moist: Float32Array;
  temp: Float32Array;
  sea: number;
  minE: number;
  maxE: number;
  masterSeed: number;
}

/** Результат buildCellData: цвета ячеек, упакованные поля и seed фактур. */
export interface CellData {
  colors: Float32Array;
  fieldCells: Uint8Array;
  texSeed: number[];
}

/** Массивы поверхности спайка (вершины ячеек + углы, индексы-веера). */
export interface SurfaceArrays {
  positions: Float32Array;
  colors: Float32Array;
  centerW: Float32Array;
  centers: Float32Array;
  birth: Float32Array;
  shard: Float32Array;
  field: Uint8Array;
  indices: Uint32Array;
  cellIndexStart: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/** Массивы объёма осколков: нижняя оболочка + боковые стенки разломов. */
export interface VolumeArrays {
  positions: Float32Array;
  colors: Float32Array;
  emissive: Float32Array;
  centers: Float32Array;
  birth: Float32Array;
  shard: Float32Array;
  /** 0 — стенка разлома, 1 — нижняя оболочка осколка. */
  kind: Float32Array;
  indices: Uint32Array;
  indexCount: number;
}

export interface SpikeGeometry {
  cellData: CellData;
  surface: SurfaceArrays;
  volume: VolumeArrays | null;
  layout: ShardLayout | null;
  shardTexData: Float32Array | null;
  shardInfo: ShardTextureInfo | null;
  shardMaxB: number;
  shardMode: number;
}

export interface SpikeGeometryOptions {
  /** Строить массивы объёма (нижняя оболочка + стенки разломов). */
  includeVolume?: boolean;
  /** Готовая палитра ячеек (иначе считается из полей). */
  cellData?: CellData;
  /** Отчёт о фазах сборки (cells → surface → volume). */
  onPhase?: (phase: string) => void;
}

type NoiseApi = typeof PlanetNoise;

const BIOME_COLORS = {
  deepOcean: [0.008, 0.05, 0.16],
  shelf: [0.06, 0.42, 0.52],
  coast: [0.12, 0.58, 0.62],
  ice: [0.84, 0.91, 0.96],
  tundra: [0.52, 0.58, 0.52],
  desert: [0.74, 0.59, 0.30],
  plains: [0.44, 0.56, 0.24],
  forest: [0.10, 0.42, 0.20],
  rock: [0.43, 0.41, 0.39],
  snow: [0.95, 0.97, 1.0],
};

function mix3(a: readonly number[], b: readonly number[], t: number, out: number[]): number[] {
  out[0] = (a[0] as number) + ((b[0] as number) - (a[0] as number)) * t;
  out[1] = (a[1] as number) + ((b[1] as number) - (a[1] as number)) * t;
  out[2] = (a[2] as number) + ((b[2] as number) - (a[2] as number)) * t;
  return out;
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

function smooth01(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function biomeColor(e: number, sea: number, minE: number, maxE: number,
  moist: number, temp: number, out: number[]): number[] {
  if (e <= sea) {
    const depth = clamp01((sea - e) / Math.max(1e-6, sea - minE));
    mix3(BIOME_COLORS.coast, BIOME_COLORS.shelf, smooth01(0, 0.15, depth), out);
    mix3(out, BIOME_COLORS.deepOcean, smooth01(0.12, 0.75, depth), out);
    if (temp < 0.14) mix3(out, BIOME_COLORS.ice, (0.14 - temp) / 0.14 * 0.85, out);
    return out;
  }
  const landH = clamp01((e - sea) / Math.max(1e-6, maxE - sea));
  // База: пустыня → равнина → лес по влажности.
  mix3(BIOME_COLORS.desert, BIOME_COLORS.plains, smooth01(0.28, 0.48, moist), out);
  mix3(out, BIOME_COLORS.forest, smooth01(0.55, 0.78, moist), out);
  // Холод: тундра и лёд.
  mix3(out, BIOME_COLORS.tundra, smooth01(0.38, 0.22, temp), out);
  mix3(out, BIOME_COLORS.ice, smooth01(0.20, 0.08, temp), out);
  // Высота: скалы и снег.
  mix3(out, BIOME_COLORS.rock, smooth01(0.68, 0.9, landH) * 0.85, out);
  mix3(out, BIOME_COLORS.snow, smooth01(0.9, 1.0, landH), out);
  return out;
}

/** Цвета ячеек, упакованные поля (relief/moist/temp/hash) и seed фактур. */
export function buildCellData(fields: PlanetFields, noise: NoiseApi = PlanetNoise): CellData {
  const F = fields.elev.length;
  const colors = new Float32Array(F * 3);
  const rgb = [0, 0, 0];
  for (let c = 0; c < F; c++) {
    biomeColor(fields.elev[c] as number, fields.sea, fields.minE, fields.maxE,
      fields.moist[c] as number, fields.temp[c] as number, rgb);
    colors[c * 3] = rgb[0] as number;
    colors[c * 3 + 1] = rgb[1] as number;
    colors[c * 3 + 2] = rgb[2] as number;
  }

  const fieldCells = new Uint8Array(F * 4);
  for (let c = 0; c < F; c++) {
    let relief: number;
    const elev = fields.elev[c] as number;
    if (elev <= fields.sea) {
      relief = -clamp01((fields.sea - elev) / Math.max(1e-6, fields.sea - fields.minE));
    } else {
      relief = clamp01((elev - fields.sea) / Math.max(1e-6, fields.maxE - fields.sea));
    }
    fieldCells[c * 4] = Math.round((relief * 0.5 + 0.5) * 255);
    fieldCells[c * 4 + 1] = Math.round(clamp01(fields.moist[c] as number) * 255);
    fieldCells[c * 4 + 2] = Math.round(clamp01(fields.temp[c] as number) * 255);
    fieldCells[c * 4 + 3] =
      noise.hash32(((fields.masterSeed >>> 0) ^ Math.imul(c + 1, 0x9E3779B1)) >>> 0) >>> 24;
  }

  return {
    colors,
    fieldCells,
    texSeed: [
      noise.hash32(((fields.masterSeed >>> 0) ^ 0xA53A9DBD) >>> 0) / 4294967296 * 64,
      noise.hash32(((fields.masterSeed >>> 0) ^ 0x5F356495) >>> 0) / 4294967296 * 64,
      noise.hash32(((fields.masterSeed >>> 0) ^ 0x1B873593) >>> 0) / 4294967296 * 64,
    ],
  };
}

function cellBirth(centerY: number, cellIndex: number): number {
  const lat01 = (1 - centerY) / 2;
  const h = Math.sin(cellIndex * 127.1) * 43758.5453;
  const jitter = (h - Math.floor(h) - 0.5) * 0.07;
  const b = lat01 * 0.74 + jitter;
  return b < 0 ? 0 : b > 0.78 ? 0.78 : b;
}

/** Соседняя через ребро (t1,t2) ячейка, отличная от c (или -1). */
function sideNeighbor(grid: PlanetGrid, c: number, t1: number, t2: number): number {
  let other = -1;
  for (let i = 0; i < 3; i++) {
    const a = grid.triangles[t1 * 3 + i] as number;
    for (let j = 0; j < 3; j++) {
      if (a === (grid.triangles[t2 * 3 + j] as number) && a !== c) other = a;
    }
  }
  return other;
}

/** Массивы поверхности: центр ячейки + её углы (веера, индексы по ячейкам). */
export function buildSurfaceArrays(grid: PlanetGrid, cellData: CellData,
  layout: ShardLayout | null): SurfaceArrays {
  const F = grid.cellCount;
  const totalSides = grid.cellCorners.length;
  const vertexCount = F + totalSides;
  const colors = cellData.colors;
  const fieldCells = cellData.fieldCells;
  const positions = new Float32Array(vertexCount * 3);
  const colorArr = new Float32Array(vertexCount * 3);
  const centerW = new Float32Array(vertexCount);
  const centersAttr = new Float32Array(vertexCount * 3);
  const birthArr = new Float32Array(vertexCount);
  const shardAttr = new Float32Array(vertexCount);
  const fieldVert = new Uint8Array(vertexCount * 4);
  if (fieldCells && fieldCells.length === F * 4) fieldVert.set(fieldCells, 0);
  colorArr.set(colors, 0);

  for (let c = 0; c < F; c++) {
    centerW[c] = 1;
    birthArr[c] = cellBirth(grid.centers[c * 3 + 1] as number, c);
    positions[c * 3] = grid.centers[c * 3] as number;
    positions[c * 3 + 1] = grid.centers[c * 3 + 1] as number;
    positions[c * 3 + 2] = grid.centers[c * 3 + 2] as number;
    shardAttr[c] = layout ? (layout.shardOf[c] as number) : 0;
    centersAttr[c * 3] = positions[c * 3] as number;
    centersAttr[c * 3 + 1] = positions[c * 3 + 1] as number;
    centersAttr[c * 3 + 2] = positions[c * 3 + 2] as number;
  }
  let slot = F;
  for (let c = 0; c < F; c++) {
    const start = grid.cellCornerStart[c] as number;
    const count = (grid.cellCornerStart[c + 1] as number) - start;
    for (let k = 0; k < count; k++) {
      const corner = grid.cellCorners[start + k] as number;
      positions[slot * 3] = grid.corners[corner * 3] as number;
      positions[slot * 3 + 1] = grid.corners[corner * 3 + 1] as number;
      positions[slot * 3 + 2] = grid.corners[corner * 3 + 2] as number;
      shardAttr[slot] = layout ? (layout.shardOf[c] as number) : 0;
      colorArr[slot * 3] = colors[c * 3] as number;
      colorArr[slot * 3 + 1] = colors[c * 3 + 1] as number;
      colorArr[slot * 3 + 2] = colors[c * 3 + 2] as number;
      centersAttr[slot * 3] = positions[c * 3] as number;
      centersAttr[slot * 3 + 1] = positions[c * 3 + 1] as number;
      centersAttr[slot * 3 + 2] = positions[c * 3 + 2] as number;
      birthArr[slot] = birthArr[c] as number;
      if (fieldCells && fieldCells.length === F * 4) {
        fieldVert[slot * 4] = fieldCells[c * 4] as number;
        fieldVert[slot * 4 + 1] = fieldCells[c * 4 + 1] as number;
        fieldVert[slot * 4 + 2] = fieldCells[c * 4 + 2] as number;
        fieldVert[slot * 4 + 3] = fieldCells[c * 4 + 3] as number;
      }
      slot++;
    }
  }

  const indices = new Uint32Array(totalSides * 3);
  const cellIndexStart = new Uint32Array(F + 1);
  let w = 0;
  slot = F;
  for (let c = 0; c < F; c++) {
    cellIndexStart[c] = w;
    const sides = (grid.cellCornerStart[c + 1] as number) - (grid.cellCornerStart[c] as number);
    for (let k = 0; k < sides; k++) {
      indices[w++] = c;
      indices[w++] = slot + k;
      indices[w++] = slot + ((k + 1) % sides);
    }
    slot += sides;
  }
  cellIndexStart[F] = w;

  return {
    positions,
    colors: colorArr,
    centerW,
    centers: centersAttr,
    birth: birthArr,
    shard: shardAttr,
    field: fieldVert,
    indices,
    cellIndexStart,
    vertexCount,
    indexCount: indices.length,
  };
}

/**
 * Массивы объёма: закрытая нижняя оболочка осколка (1 − thick) и боковые
 * стенки разломов между ячейками разных осколков.
 *
 * Кромка стенки берётся из `surfPos` (позиции вершин поверхности): стенка
 * садится ровно на свою ячейку даже с рельефом. Низ считается от единичной
 * сферы по направлению — как в легаси-спайке, поэтому у соседних ячеек
 * одного осколка общая нижняя кромка не расходится.
 */
export function buildVolumeArrays(grid: PlanetGrid, layout: ShardLayout,
  sp: ShardParams, surfPos: Float32Array, birthArr: Float32Array,
  noise: NoiseApi = PlanetNoise): VolumeArrays | null {
  const F = grid.cellCount;
  const thickEff = sp.thick * (1 - 0.45 * sp.loss);
  const fracNoise = noise.makeNoise('simplex',
    noise.hash32(noise.stringSeed(sp.seedText + ':fracture')));
  const pos: number[] = [];
  const col: number[] = [];
  const emi: number[] = [];
  const cen: number[] = [];
  const bir: number[] = [];
  const shr: number[] = [];
  const kind: number[] = [];
  const idx: number[] = [];

  const isBoundary = new Uint8Array(F);
  for (let c = 0; c < F; c++) {
    for (let n = 0; n < (grid.neighborCount[c] as number); n++) {
      if ((layout.shardOf[grid.neighbors[c * 6 + n] as number] as number) !== (layout.shardOf[c] as number)) {
        isBoundary[c] = 1;
        break;
      }
    }
  }

  const shadeAt = (x: number, y: number, z: number): number =>
    0.85 + 0.3 * (0.5 + 0.5 * fracNoise(x * 21 - 3.7, y * 21 + 8.9, z * 21 + 1.3));

  // Единая глубина нижней поверхности для стены, центров и углов: одинаковая
  // функция исходного направления не даёт щелей между кусками оболочки.
  let bottomNoise01 = 0.5;
  const bottomRadius = (x: number, y: number, z: number): number => {
    bottomNoise01 = 0.5 + 0.5 * fracNoise(x * 9 + 1.9, y * 9 + 5.5, z * 9 - 6.2);
    return 1 - thickEff * (0.65 + 0.55 * bottomNoise01);
  };

  const pushVert = (ox: number, oy: number, oz: number, s: number, cell: number,
    r: number, g: number, b: number, e: number, kindFlag: number): number => {
    const o = pos.length;
    pos.push(ox, oy, oz);
    col.push(r, g, b);
    emi.push(e);
    shr.push(s);
    kind.push(kindFlag || 0);
    cen.push(surfPos[cell * 3] as number, surfPos[cell * 3 + 1] as number, surfPos[cell * 3 + 2] as number);
    bir.push(birthArr[cell] as number);
    return o / 3;
  };

  const pushBottomVert = (x: number, y: number, z: number, s: number, cell: number,
    knownRadius?: number): number => {
    const rr = knownRadius === undefined ? bottomRadius(x, y, z) : knownRadius;
    const shade = 0.80 + 0.38 * bottomNoise01;
    // Низ — преимущественно тёмная порода с горячими пятнами, а не сплошная
    // лавовая плёнка: иначе эмиссия забивает гранёную геометрию. Глубже
    // участок оболочки — в среднем горячее.
    const heat = 0.08 + 0.30 * bottomNoise01 * bottomNoise01;
    return pushVert(x * rr, y * rr, z * rr, s, cell,
      0.105 * shade, 0.064 * shade, 0.048 * shade, heat, 1);
  };

  const bottomCenterIndex = new Int32Array(F).fill(-1);
  const bottomCenterOf = (cell: number): number => {
    const cached = bottomCenterIndex[cell] as number;
    if (cached >= 0) return cached;
    const vi = pushBottomVert(
      grid.centers[cell * 3] as number, grid.centers[cell * 3 + 1] as number,
      grid.centers[cell * 3 + 2] as number,
      layout.shardOf[cell] as number, cell);
    bottomCenterIndex[cell] = vi;
    return vi;
  };

  const bottomCornerOf = (t: number, s: number, anchorCell: number): number =>
    pushBottomVert(
      grid.corners[t * 3] as number, grid.corners[t * 3 + 1] as number,
      grid.corners[t * 3 + 2] as number, s, anchorCell);

  // Внутренняя часть низа: один треугольник центров на первичную ячейку
  // триангуляции. В смешанном треугольнике пара ячеек одного шарда
  // доводится до общего угла; оставшуюся приграничную часть закроют веера
  // граничных сторон ниже. Ориентация обратная верхней поверхности.
  for (let t = 0; t < grid.triangleCount; t++) {
    const ta = grid.triangles[t * 3] as number;
    const tb = grid.triangles[t * 3 + 1] as number;
    const tc = grid.triangles[t * 3 + 2] as number;
    const sa = layout.shardOf[ta] as number;
    const sb = layout.shardOf[tb] as number;
    const sc = layout.shardOf[tc] as number;
    if (sa === sb && sb === sc) {
      idx.push(bottomCenterOf(ta), bottomCenterOf(tc), bottomCenterOf(tb));
    } else {
      if (sa === sb) idx.push(bottomCenterOf(ta), bottomCornerOf(t, sa, ta), bottomCenterOf(tb));
      if (sb === sc) idx.push(bottomCenterOf(tb), bottomCornerOf(t, sb, tb), bottomCenterOf(tc));
      if (sc === sa) idx.push(bottomCenterOf(tc), bottomCornerOf(t, sc, tc), bottomCenterOf(ta));
    }
  }

  const SEG = 3;
  for (let c = 0; c < F; c++) {
    if (!isBoundary[c]) continue;
    const s = layout.shardOf[c] as number;
    const start = grid.cellCornerStart[c] as number;
    const sides = (grid.cellCornerStart[c + 1] as number) - start;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      const t1 = grid.cellCorners[start + k] as number;
      const t2 = grid.cellCorners[start + k2] as number;
      const nb = sideNeighbor(grid, c, t1, t2);
      if (nb < 0 || (layout.shardOf[nb] as number) === s) continue;
      const ax = grid.corners[t1 * 3] as number;
      const ay = grid.corners[t1 * 3 + 1] as number;
      const az = grid.corners[t1 * 3 + 2] as number;
      const bx = grid.corners[t2 * 3] as number;
      const by = grid.corners[t2 * 3 + 1] as number;
      const bz = grid.corners[t2 * 3 + 2] as number;
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const edgeLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
      // Радиус кромки — ровно из вершин поверхности этой ячейки (с рельефом).
      const ra = Math.hypot(surfPos[(F + start + k) * 3] as number,
        surfPos[(F + start + k) * 3 + 1] as number, surfPos[(F + start + k) * 3 + 2] as number);
      const rb = Math.hypot(surfPos[(F + start + k2) * 3] as number,
        surfPos[(F + start + k2) * 3 + 1] as number, surfPos[(F + start + k2) * 3 + 2] as number);
      let prevTop = -1;
      let prevBot = -1;
      const sideBottom: number[] = [];
      for (let j = 0; j <= SEG; j++) {
        const tt = j / SEG;
        let px = ax + ex * tt, py = ay + ey * tt, pz = az + ez * tt;
        let pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
        px /= pl; py /= pl; pz /= pl;
        if (j > 0 && j < SEG && sp.jag > 0) {
          const tx = py * ez - pz * ey, ty = pz * ex - px * ez, tz = px * ey - py * ex;
          const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
          const off = fracNoise(px * 13 + 7.3, py * 13 - 2.1, pz * 13 + 4.7) *
            sp.jag * Math.sin(Math.PI * tt) * edgeLen * 0.45;
          px += (tx / tl) * off; py += (ty / tl) * off; pz += (tz / tl) * off;
          pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
          px /= pl; py /= pl; pz /= pl;
        }
        const shade = shadeAt(px, py, pz);
        // Верх стенки — на радиусе поверхности ячейки (иначе шов с рельефом).
        const rTop = ra + (rb - ra) * tt;
        const topIdx = pushVert(px * rTop, py * rTop, pz * rTop, s, c,
          0.23 * shade, 0.145 * shade, 0.09 * shade, 0.03, 0);
        const rr2 = bottomRadius(px, py, pz);
        const botIdx = pushVert(px * rr2, py * rr2, pz * rr2, s, c,
          0.075 * shade, 0.05 * shade, 0.045 * shade, 0.85, 0);
        sideBottom.push(pushBottomVert(px, py, pz, s, c, rr2));
        if (prevTop >= 0) {
          idx.push(prevTop, topIdx, botIdx, prevTop, botIdx, prevBot);
        }
        prevTop = topIdx;
        prevBot = botIdx;
      }
      // Локальное закрытие именно этой стороны: короткий веер в пределах
      // одной ячейки, без лучей через весь осколок.
      const bottomCenter = bottomCenterOf(c);
      for (let j = 0; j < SEG; j++) {
        idx.push(bottomCenter, sideBottom[j + 1] as number, sideBottom[j] as number);
      }
    }
  }
  if (!idx.length) return null;
  return {
    positions: new Float32Array(pos),
    colors: new Float32Array(col),
    emissive: new Float32Array(emi),
    centers: new Float32Array(cen),
    birth: new Float32Array(bir),
    shard: new Float32Array(shr),
    kind: new Float32Array(kind),
    indices: new Uint32Array(idx),
    indexCount: idx.length,
  };
}

/** Полная сборка геометрии спайка: ячейки → поверхность → объём. */
export function buildGeometry(grid: PlanetGrid, fields: PlanetFields, sp: ShardParams,
  noise: NoiseApi = PlanetNoise, opts: SpikeGeometryOptions = {}): SpikeGeometry {
  const phase = opts.onPhase || ((): void => {});
  phase('cells');
  const cellData = opts.cellData || buildCellData(fields, noise);
  phase('surface');
  const layout = computeShardLayout(grid, sp);
  const built = buildShardTextureData(layout, sp.loss);
  const surface = buildSurfaceArrays(grid, cellData, layout);
  let volume: VolumeArrays | null = null;
  if (opts.includeVolume && layout) {
    phase('volume');
    volume = buildVolumeArrays(grid, layout, sp, surface.positions, surface.birth, noise);
  }
  return {
    cellData,
    surface,
    volume,
    layout,
    shardTexData: built.data,
    shardInfo: built.shardInfo,
    shardMaxB: built.shardMaxB,
    shardMode: layout ? 1 : 0,
  };
}

/**
 * Разворачивает принадлежность ячеек осколкам (`layout.shardOf`) на вершины
 * геометрии глобуса через `geometry.vertexCellId`.
 *
 * Именно этот массив уходит в текстуру индекса осколка: все вершины одной
 * ячейки (центр веера и её углы) обязаны получить ОДИН индекс, иначе
 * треугольники ячейки растягиваются через всю планету.
 */
export function expandVertexShardIndices(layout: ShardLayout | null,
  vertexCellId: Uint32Array): Uint32Array {
  const out = new Uint32Array(vertexCellId.length);
  if (!layout) return out;
  const cellCount = layout.shardOf.length;
  for (let i = 0; i < vertexCellId.length; i++) {
    const cell = vertexCellId[i] as number;
    out[i] = cell < cellCount ? (layout.shardOf[cell] as number) : 0;
  }
  return out;
}

/** Параметры осколков из состояния FX (дефолты — как в спайке). */
export function shardParamsFromState(state: FxRuntimeState): ShardParams {
  return {
    count: Math.max(2, Math.min(MAX_SHARDS, Math.round(state.shardCount))),
    dist: state.shardDist ?? 'power',
    sep: state.separation,
    thick: state.shardThick ?? 0.14,
    jag: state.shardJag ?? 0.5,
    loss: state.shardLoss ?? 0,
    seedText: state.seedText,
  };
}

// ===========================================================================
// 3. Разлёт осколков (uSep): визуал и анимация без пересборки геометрии
// ===========================================================================

export const BOOM_DEFAULTS = { sep: 0.3, jag: 0.5, thick: 0.14 };
export const BOOM_TARGET = { sep: 2.1, jag: 0.95, thick: 0.05 };

export interface SeparationVisuals {
  /** Затухание атмосферы при разлёте. */
  atmoFade: number;
  /** Видимость раскалённого ядра (режим Шакураса). */
  coreVisible: boolean;
}

export function separationVisuals(sep: number, shardMode: boolean, shardMaxB: number): SeparationVisuals {
  return {
    atmoFade: shardMode ? Math.max(0, 1 - sep * 2.2) : 1,
    coreVisible: shardMode && (sep > 0.01 || shardMaxB > 0.01),
  };
}

/** Взрыв: easeOutCubic (резкий выброс, затухание); сброс: easeInOutQuad. */
export function boomEase(reset: boolean, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  if (reset) return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  return 1 - Math.pow(1 - x, 3);
}

export interface SeparationAnimationOptions {
  fromSep: number;
  toSep: number;
  /** true — сброс к стандартам (easeInOutQuad 1500 мс), false — взрыв (2400 мс). */
  reset: boolean;
  durationMs?: number;
  onFrame: (sep: number) => void;
  onDone?: () => void;
  requestFrame?: (callback: (timeMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface SeparationAnimationHandle {
  cancel(): void;
  readonly running: boolean;
}

export function animateShardSeparation(options: SeparationAnimationOptions): SeparationAnimationHandle {
  const requestFrame = options.requestFrame
    || ((cb: (t: number) => void) => (globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame
    || ((h: number) => (globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame(h));
  const duration = options.durationMs != null ? options.durationMs : (options.reset ? 1500 : 2400);
  let handle = 0;
  let cancelled = false;
  const t0 = (globalThis as unknown as { performance: Performance }).performance.now();
  const step = (ts: number): void => {
    if (cancelled) return;
    const t = duration > 0 ? Math.min(1, (ts - t0) / duration) : 1;
    const e = boomEase(options.reset, t);
    options.onFrame(options.fromSep + (options.toSep - options.fromSep) * e);
    if (t < 1) {
      handle = requestFrame(step);
    } else {
      handle = 0;
      if (options.onDone) options.onDone();
    }
  };
  handle = requestFrame(step);
  return {
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (handle) cancelFrame(handle);
      handle = 0;
    },
    get running(): boolean {
      return !cancelled && handle !== 0;
    },
  };
}

// ===========================================================================
// 4. Диагностические палитры и фактуры (рендер-кастомизация)
// ===========================================================================

export type FxPaletteId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type FxTextureMode = 1 | 2 | 3 | 4 | 5;

export interface FxTheme {
  palette: FxPaletteId;
  textureMode: FxTextureMode;
  textureAmount: number;
  textureScale: number;
  /** Поворот hue в градусах (−35…35). */
  hueShiftDeg: number;
}

export const FX_PALETTES: readonly { id: FxPaletteId; label: string }[] = [
  { id: 0, label: 'боевые биомы c100' },
  { id: 1, label: 'атласная (песчано-зелёная)' },
  { id: 2, label: 'ледяная' },
  { id: 3, label: 'вулканическая' },
  { id: 4, label: 'тропическая' },
  { id: 5, label: 'неоновая' },
  { id: 6, label: 'голо-диагностика' },
];

export const FX_TEXTURE_MODES: readonly { id: FxTextureMode; label: string }[] = [
  { id: 1, label: 'зерно' },
  { id: 2, label: 'дюны' },
  { id: 3, label: 'трещины' },
  { id: 4, label: 'облака' },
  { id: 5, label: 'скалы' },
];

/** Детерминированная «случайная тема» из master-seed (как themeSeed спайка). */
export function randomFxTheme(masterSeedHex: string): FxTheme {
  const base = PlanetNoise.stringSeed(masterSeedHex || 'planet') >>> 0;
  const rnd = (n: number): number =>
    PlanetNoise.hash32((base ^ Math.imul(n + 1, 0x85EBCA6B)) >>> 0) / 4294967296;
  return {
    palette: (1 + Math.floor(rnd(1) * 6)) as FxPaletteId,
    textureMode: (1 + Math.floor(rnd(2) * 5)) as FxTextureMode,
    textureAmount: Number((0.30 + rnd(3) * 0.45).toFixed(2)),
    textureScale: 12 + Math.floor(rnd(4) * 37),
    hueShiftDeg: Math.round((rnd(5) - 0.5) * 70),
  };
}


// ===========================================================================
// 4.1 Объём осколков (VS_VOLUME/FS_VOLUME) и раскалённое ядро (VS_CORE/FS_CORE)
// ===========================================================================
//
// Восстановлено из 3728d4e:site/planet-test/planet-test.js: закрытая нижняя
// оболочка осколка (1 − thick) и боковые стенки разломов между ячейками
// разных осколков с затенением по глубине трещины, плюс процедурное
// раскалённое ядро Шакураса между осколками. Каскад сборки (uBuild/uHide/
// uCenterGrow) — зона поверхности, здесь его нет: объём виден только тогда,
// когда осколки уже разошлись.

/** Глубина трещины: 0 на кромке поверхности, 1 у дна (низ — всегда дно). */
const VOLUME_DEPTH_GLSL = SHARD_TRANSFORM_GLSL + `
uniform float uThick;
float fxCrackDepth(vec3 p, float kind) {
  if (kind > 0.5) return 1.0;
  return clamp((1.0 - length(p)) / max(uThick, 0.001), 0.0, 1.0);
}
`;

export const VS_VOLUME = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
layout(location=2) in float aEmissive;
layout(location=5) in float aShard;
layout(location=6) in float aKind; // 0 — стенка разлома, 1 — нижняя оболочка
uniform mat4 uMvp;
uniform mat4 uModel;
uniform float uScale;
${VOLUME_DEPTH_GLSL}
out vec3 vColor;
out float vEmissive;
out float vCrack;
out vec3 vWorldPos;
out float vKind;
void main() {
  // Тот же трансформ осколка, что у поверхности: стенка не отрывается от своей ячейки.
  vec3 bp = uShardMode > 0.5 ? shardTransform(aPos, aShard) : aPos;
  vec3 p = bp * uScale;
  vColor = aColor;
  vEmissive = aEmissive;
  vCrack = fxCrackDepth(aPos, aKind);
  vKind = aKind;
  vWorldPos = (uModel * vec4(p, 1.0)).xyz;
  gl_Position = uMvp * vec4(p, 1.0);
}
`;

export const FS_VOLUME = `#version 300 es
precision highp float;
in vec3 vColor;
in float vEmissive;
in float vCrack;
in vec3 vWorldPos;
in float vKind;
uniform vec3 uSunDir;
out vec4 fragColor;
void main() {
  // Плоская нормаль из производных мировой позиции — гранёная порода без
  // атрибутов нормалей (как в спайке).
  vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
  if (!gl_FrontFacing) n = -n;
  float diff = 0.32 + 0.68 * max(dot(n, normalize(uSunDir)), 0.0);
  // Стенка темнеет к дну трещины, но разлом светится именно оттуда.
  float depthShade = mix(1.0, 0.55, vCrack);
  vec3 lava = mix(vec3(0.55, 0.08, 0.01), vec3(1.0, 0.55, 0.12), clamp(vEmissive, 0.0, 1.0));
  lava += vec3(0.35, 0.30, 0.10) * max(vEmissive - 1.0, 0.0);
  float glow = vKind > 0.5 ? (0.55 + 0.45 * vCrack) : vCrack;
  vec3 col = vColor * diff * depthShade + lava * (vEmissive + glow * 0.35);
  fragColor = vec4(col, 1.0);
}
`;

export const VS_CORE = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uMvp;
uniform mat4 uModel;
uniform float uScale;
out vec3 vNormal;
out vec3 vObj;
void main() {
  vObj = aPos;
  vNormal = normalize(mat3(uModel) * normalize(aPos));
  gl_Position = uMvp * vec4(aPos * uScale, 1.0);
}
`;

export const FS_CORE = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vObj;
uniform vec3 uSunDir;
out vec4 fragColor;
// Декоративный GPU-шум только для вида лавовых трещин ядра (не авторитетный).
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
void main() {
  vec3 dir = normalize(vObj);
  float n = vnoise(dir * 7.0) * 0.65 + vnoise(dir * 15.0) * 0.35;
  float crack = 1.0 - smoothstep(0.0, 0.16, abs(n - 0.5));
  float diff = 0.35 + 0.65 * max(dot(normalize(vNormal), normalize(uSunDir)), 0.0);
  vec3 rock = vec3(0.10, 0.06, 0.05) * diff;
  vec3 lava = mix(vec3(0.85, 0.25, 0.03), vec3(1.0, 0.72, 0.25), crack);
  fragColor = vec4(rock + lava * crack * 1.6, 1.0);
}
`;

/** Радиус раскалённого ядра по умолчанию (coreScale). */
export const DEFAULT_CORE_SCALE = 0.55;

/** UV-сфера для ядра, когда сетки планеты ещё нет. */
function makeUvSphere(lonSegments: number, latSegments: number): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let lat = 0; lat <= latSegments; lat++) {
    const v = lat / latSegments;
    const phi = v * Math.PI;
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    for (let lon = 0; lon <= lonSegments; lon++) {
      const u = lon / lonSegments;
      const th = u * Math.PI * 2;
      positions.push(Math.cos(th) * sp, cp, Math.sin(th) * sp);
    }
  }
  const stride = lonSegments + 1;
  for (let lat = 0; lat < latSegments; lat++) {
    for (let lon = 0; lon < lonSegments; lon++) {
      const a = lat * stride + lon;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

// ===========================================================================
// 5. Адаптер к боевому глобусу: PlanetGlobeFxHooks для PlanetGlobeOptions.fx
// ===========================================================================

export interface FxRuntimeState {
  /** Текущий разлёт (uSep). */
  separation: number;
  /** Режим осколков Шакураса включён (uShardMode). */
  shardMode: boolean;
  /** Число осколков для процедурного квантования (planet-globe-v1). */
  shardCount: number;
  /** seed процедурного layout осколков. */
  seedText: string;
  theme: FxTheme;
  /** reliefScale активной геометрии — из неё в шейдере восстанавливается высота. */
  reliefScale: number;
  /* ---- Опциональные поля волны PR 6.1 (Интерфейс-контракт FxRuntimeState) ---- */
  /** Режим раскладки осколков (по умолчанию 'power'). */
  shardDist?: ShardDist;
  /** Толщина стен разлома (по умолчанию 0.14). */
  shardThick?: number;
  /** Рваность границ осколков (по умолчанию 0.5). */
  shardJag?: number;
  /** Доля «потерянных» осколков (по умолчанию 0). */
  shardLoss?: number;
  /** Радиус раскалённого ядра Шакураса (по умолчанию 0.55). */
  coreScale?: number;
  /** Сетка планеты: включает канонический клеточный путь осколков. */
  grid?: PlanetGrid | null;
  /** Готовая геометрия глобуса: источник vertexCellId для индекса осколка. */
  geometry?: GlobeGeometry | null;
}

/** Контекст кадра, который боевой глобус отдаёт плагину FX. */
export interface FxFrameContext {
  mvp: Float32Array;
  model: Float32Array;
  normalMat: Float32Array;
  lightDir: Float32Array;
  eyePos: Float32Array;
  timeSec: number;
}

/** Расширенный интерфейс контроллера FX: базовые хуки + объём и ядро. */
export interface PlanetGlobeFxController extends PlanetGlobeFxHooks {
  /** Геометрия и сетка готовы: строим объём осколков и ядро. */
  onGeometryReady?: (gl: WebGL2RenderingContext, grid: PlanetGrid, geometry: GlobeGeometry) => void;
  /** После отрисовки поверхности: объём осколков и раскалённое ядро. */
  onAfterSurfaceDraw?: (gl: WebGL2RenderingContext, frame: FxFrameContext) => void;
  /** Освобождение GPU-ресурсов плагина. */
  onDispose?: (gl: WebGL2RenderingContext) => void;
}

function replaceOnce(source: string, needle: string, replacement: string, label: string): string {
  const index = source.indexOf(needle);
  if (index < 0) {
    throw new Error('PlanetGlobeFx: не найден маркер шейдера ' + label);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

/** Компиляция и линковка программы объёма/ядра (WebGL2, один раз на контекст). */
function compileProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || '';
      gl.deleteShader(shader);
      throw new Error('шейдер не собрался: ' + log);
    }
    return shader;
  };
  const program = gl.createProgram() as WebGLProgram;
  const vs = compile(gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl.FRAGMENT_SHADER, fsSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || '';
    gl.deleteProgram(program);
    throw new Error('программа не слинковалась: ' + log);
  }
  return program;
}

interface VolumeUniforms {
  mvp: WebGLUniformLocation | null;
  model: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  thick: WebGLUniformLocation | null;
  shardMode: WebGLUniformLocation | null;
  sep: WebGLUniformLocation | null;
  shardTex: WebGLUniformLocation | null;
  sun: WebGLUniformLocation | null;
}

interface CoreUniforms {
  mvp: WebGLUniformLocation | null;
  model: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  sun: WebGLUniformLocation | null;
}

interface FxUniforms {
  sep: WebGLUniformLocation | null;
  shardMode: WebGLUniformLocation | null;
  shardCount: WebGLUniformLocation | null;
  shardTex: WebGLUniformLocation | null;
  shardIdTex: WebGLUniformLocation | null;
  shardIdW: WebGLUniformLocation | null;
  shardIdReady: WebGLUniformLocation | null;
  palette: WebGLUniformLocation | null;
  hueShift: WebGLUniformLocation | null;
  texMode: WebGLUniformLocation | null;
  texAmount: WebGLUniformLocation | null;
  texScale: WebGLUniformLocation | null;
  texSeed: WebGLUniformLocation | null;
  reliefScale: WebGLUniformLocation | null;
}

/** Ширина целочисленной текстуры индексов осколков (ровно десятки строк). */
const SHARD_ID_TEX_WIDTH = 1024;

/** Трансформ поверхности по клеточному индексу осколка. */
function surfaceShardTransformGLSL(): string {
  return SHARD_TRANSFORM_GLSL + '\n' + SHARD_CELL_INDEX_GLSL + '\n';
}

/** Хуки плагина: декорируют surface-шейдеры глобуса и гоняют uniform-ы FX. */
export function createFxHooks(state: FxRuntimeState): PlanetGlobeFxController {
  let uniforms: FxUniforms | null = null;
  let shardTexture: WebGLTexture | null = null;
  let shardTextureKey = '';
  let shardIdTexture: WebGLTexture | null = null;
  let shardIdTextureKey = '';
  let shardIdTexWidth = SHARD_ID_TEX_WIDTH;
  let shardIdAvailable = false;
  let layout: ShardLayout | null = null;
  let layoutKey = '';
  let shardTexData: Float32Array | null = null;
  let shardMaxB = 0;
  let readyGrid: PlanetGrid | null = null;
  let readyGeometry: GlobeGeometry | null = null;
  let lastGridRef: PlanetGrid | null = null;
  let lastGeometryRef: GlobeGeometry | null = null;

  const currentGrid = (): PlanetGrid | null => readyGrid ?? state.grid ?? null;
  const currentGeometry = (): GlobeGeometry | null => readyGeometry ?? state.geometry ?? null;

  /** Канонический layout осколков: клеточный при наличии сетки, иначе процедурный. */
  const ensureShardLayout = (): ShardLayout | null => {
    const sp = shardParamsFromState(state);
    const grid = currentGrid();
    if (grid !== lastGridRef) {
      // Новая сетка — прошлый layout и текстуры недействительны.
      lastGridRef = grid;
      layout = null;
      layoutKey = '';
      shardTextureKey = '';
      shardIdTextureKey = '';
      shardIdAvailable = false;
    }
    const key = (grid ? 'grid' + grid.v + ':' + grid.cellCount : 'proc') +
      '|' + sp.count + '|' + sp.dist + '|' + sp.seedText;
    if (layout && layoutKey === key) return layout;
    layout = grid ? computeShardLayout(grid, sp) : buildProceduralShardLayout(sp);
    layoutKey = key;
    const built = buildShardTextureData(layout, sp.loss);
    shardTexData = built.data;
    shardMaxB = built.shardMaxB;
    return layout;
  };

  const ensureShardTexture = (gl: WebGL2RenderingContext): void => {
    ensureShardLayout();
    if (!shardTexData) return;
    const key = layoutKey + '|loss' + (state.shardLoss ?? 0);
    if (shardTexture && shardTextureKey === key) return;
    if (!shardTexture) shardTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shardTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_SHARDS, 4, 0, gl.RGBA, gl.FLOAT, shardTexData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    shardTextureKey = key;
  };

  /**
   * Текстура клеточного индекса осколка по вершинам (R32UI).
   *
   * Данные — expandVertexShardIndices(layout, geometry.vertexCellId): вершины
   * одной ячейки получают одинаковый индекс, поэтому треугольники веера
   * ячейки двигаются одним осколком. Возвращает false, если сетки/геометрии
   * ещё нет или размер не влезает в лимиты контекста (тогда шейдер уходит на
   * резервное квантование нормали).
   */
  const ensureShardIdTexture = (gl: WebGL2RenderingContext): boolean => {
    const geometryNow = currentGeometry();
    const layoutNow = ensureShardLayout();
    if (!layoutNow || !geometryNow || !geometryNow.vertexCellId || !geometryNow.vertexCellId.length) {
      shardIdAvailable = false;
      return false;
    }
    if (geometryNow !== lastGeometryRef) {
      lastGeometryRef = geometryNow;
      shardIdTextureKey = '';
      shardIdAvailable = false;
    }
    const key = layoutKey + '|v' + geometryNow.v + '|n' + geometryNow.vertexCellId.length;
    if (shardIdTexture && shardIdTextureKey === key) return shardIdAvailable;
    const perVertex = expandVertexShardIndices(layoutNow, geometryNow.vertexCellId);
    const width = SHARD_ID_TEX_WIDTH;
    const height = Math.max(1, Math.ceil(perVertex.length / width));
    const maxSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (!(width <= maxSize) || !(height <= maxSize)) {
      shardIdAvailable = false;
      shardIdTextureKey = key;
      return false;
    }
    // Хвост последней строки добивается нулями: texImage2D требует полный
    // прямоугольник width×height.
    const padded = new Uint32Array(width * height);
    padded.set(perVertex, 0);
    if (!shardIdTexture) shardIdTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shardIdTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, width, height, 0,
      gl.RED_INTEGER, gl.UNSIGNED_INT, padded);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    shardIdTexWidth = width;
    shardIdTextureKey = key;
    shardIdAvailable = true;
    return true;
  };

  // ---- GPU-ресурсы объёма разломов и раскалённого ядра (Шаг 2) ----
  let volProgram: WebGLProgram | null = null;
  let volUniforms: VolumeUniforms | null = null;
  let volVao: WebGLVertexArrayObject | null = null;
  let volBuffers: WebGLBuffer[] = [];
  let volIndexCount = 0;
  let volKey = '';
  let coreProgram: WebGLProgram | null = null;
  let coreUniforms: CoreUniforms | null = null;
  let coreVao: WebGLVertexArrayObject | null = null;
  let coreBuffers: WebGLBuffer[] = [];
  let coreIndexCount = 0;
  let effectsFailed = false;

  /** Плагин не должен ломать рендер: ошибка шейдера отключает эффекты, а не глобус. */
  const failEffects = (err: unknown): void => {
    if (effectsFailed) return;
    effectsFailed = true;
    console.error('PlanetGlobeFx: объём осколков и ядро отключены —', err);
  };

  const uploadFloatAttribute = (gl: WebGL2RenderingContext, buffer: WebGLBuffer,
    location: number, size: number, data: Float32Array): void => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };

  const clearVolume = (gl: WebGL2RenderingContext): void => {
    for (const b of volBuffers) gl.deleteBuffer(b);
    volBuffers = [];
    if (volVao) gl.deleteVertexArray(volVao);
    volVao = null;
    volIndexCount = 0;
    volKey = '';
  };

  const clearCore = (gl: WebGL2RenderingContext): void => {
    for (const b of coreBuffers) gl.deleteBuffer(b);
    coreBuffers = [];
    if (coreVao) gl.deleteVertexArray(coreVao);
    coreVao = null;
    coreIndexCount = 0;
  };

  /**
   * Объём осколков: закрытая нижняя оболочка (1 − thick) + стенки разломов.
   * Пересобирается только при смене раскладки/толщины/рваности/потерь —
   * разлёт (uSep) остаётся юниформом и анимация геометрию не пересобирает.
   */
  const ensureVolume = (gl: WebGL2RenderingContext): void => {
    const grid = currentGrid();
    const geometry = currentGeometry();
    const layoutNow = ensureShardLayout();
    if (!grid || !geometry || !layoutNow) return;
    const sp = shardParamsFromState(state);
    const key = layoutKey + '|t' + sp.thick + '|j' + sp.jag + '|l' + sp.loss;
    if (volVao && volKey === key) return;
    // birth объёма нужен только каскаду сборки поверхности, которого здесь нет.
    const birth = new Float32Array(grid.cellCount);
    const volume = buildVolumeArrays(grid, layoutNow, sp, geometry.positions, birth);
    clearVolume(gl);
    if (!volume || !volume.indexCount) return;
    if (!volProgram) {
      volProgram = compileProgram(gl, VS_VOLUME, FS_VOLUME);
      volUniforms = {
        mvp: gl.getUniformLocation(volProgram, 'uMvp'),
        model: gl.getUniformLocation(volProgram, 'uModel'),
        scale: gl.getUniformLocation(volProgram, 'uScale'),
        thick: gl.getUniformLocation(volProgram, 'uThick'),
        shardMode: gl.getUniformLocation(volProgram, 'uShardMode'),
        sep: gl.getUniformLocation(volProgram, 'uSep'),
        shardTex: gl.getUniformLocation(volProgram, 'uShardTex'),
        sun: gl.getUniformLocation(volProgram, 'uSunDir'),
      };
    }
    volVao = gl.createVertexArray();
    gl.bindVertexArray(volVao);
    const newBuffer = (): WebGLBuffer => {
      const buffer = gl.createBuffer() as WebGLBuffer;
      volBuffers.push(buffer);
      return buffer;
    };
    uploadFloatAttribute(gl, newBuffer(), 0, 3, volume.positions);
    uploadFloatAttribute(gl, newBuffer(), 1, 3, volume.colors);
    uploadFloatAttribute(gl, newBuffer(), 2, 1, volume.emissive);
    uploadFloatAttribute(gl, newBuffer(), 5, 1, volume.shard);
    uploadFloatAttribute(gl, newBuffer(), 6, 1, volume.kind);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, newBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, volume.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    volIndexCount = volume.indexCount;
    volKey = key;
  };

  /** Ядро: первичная триангуляция сетки (как в спайке) или UV-сфера без сетки. */
  const ensureCore = (gl: WebGL2RenderingContext): void => {
    if (coreVao) return;
    const grid = currentGrid();
    const sphere = grid && grid.triangles ? null : makeUvSphere(32, 16);
    const positions = grid && grid.triangles ? grid.centers : (sphere as { positions: Float32Array }).positions;
    const indices = grid && grid.triangles ? grid.triangles : (sphere as { indices: Uint32Array }).indices;
    if (!positions.length || !indices.length) return;
    if (!coreProgram) {
      coreProgram = compileProgram(gl, VS_CORE, FS_CORE);
      coreUniforms = {
        mvp: gl.getUniformLocation(coreProgram, 'uMvp'),
        model: gl.getUniformLocation(coreProgram, 'uModel'),
        scale: gl.getUniformLocation(coreProgram, 'uScale'),
        sun: gl.getUniformLocation(coreProgram, 'uSunDir'),
      };
    }
    coreVao = gl.createVertexArray();
    gl.bindVertexArray(coreVao);
    const newBuffer = (): WebGLBuffer => {
      const buffer = gl.createBuffer() as WebGLBuffer;
      coreBuffers.push(buffer);
      return buffer;
    };
    uploadFloatAttribute(gl, newBuffer(), 0, 3, positions);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, newBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    coreIndexCount = indices.length;
  };

  return {
    decorateSurfaceShaders(src: { vs: string; fs: string }): { vs: string; fs: string } {
      // Vertex: трансформ осколков Шакураса поверх позиций planet-globe-v1.
      let vs = src.vs;
      vs = replaceOnce(vs, 'void main() {',
        surfaceShardTransformGLSL() +
        'out vec3 vObjDir;\n' +
        'out float vRadius;\n' +
        'void main() {\n' +
        '  // Клеточный индекс: все вершины веера ячейки — один осколок.\n' +
        '  vec3 fxPos = fxShardPosition(aPos, aNormal.xyz);',
        'surface.vs main');
      vs = replaceOnce(vs, 'vec4 wp = uModel * vec4(aPos, 1.0);',
        'vec4 wp = uModel * vec4(fxPos, 1.0);', 'surface.vs worldPos');
      vs = replaceOnce(vs, 'gl_Position = uMvp * vec4(aPos, 1.0);',
        'gl_Position = uMvp * vec4(fxPos, 1.0);\n  vObjDir = normalize(aPos);\n  vRadius = length(aPos);',
        'surface.vs gl_Position');

      // Fragment: диагностические палитры + декоративные фактуры + hue.
      let fs = src.fs;
      fs = replaceOnce(fs, 'void main() {',
        PALETTE_GLSL + '\n' + FX_TEXTURE_GLSL + '\n' +
        'uniform float uReliefScale;\n' +
        'in vec3 vObjDir;\n' +
        'in float vRadius;\n' +
        'void main() {\n' +
        '// Высота восстанавливается из радиуса вершины (reliefDelta planet-globe-v1:\n' +
        '// суша +0.022*k, океан −0.008*k). Влага/температура — декоративный шум.\n' +
        '  float fxR = vRadius - 1.0;\n' +
        '  float fxLandH = fxR >= 0.0 ? clamp(fxR / (0.022 * max(uReliefScale, 0.001)), 0.0, 1.0) : 0.0;\n' +
        '  float fxDepth = fxR < 0.0 ? clamp(-fxR / (0.008 * max(uReliefScale, 0.001)), 0.0, 1.0) : 0.0;\n' +
        '  float fxRelief = fxR >= 0.0 ? fxLandH : -fxDepth;\n' +
        '  vec4 fField = vec4(0.5 + 0.5 * fxRelief,\n' +
        '    fbm3(vObjDir * 2.7 + vec3(11.3, 5.1, 7.7)),\n' +
        '    fbm3(vObjDir * 1.9 + vec3(3.1, 17.9, 9.2)),\n' +
        '    fract(sin(dot(floor(vObjDir * 8.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453));',
        'surface.fs main');
      fs = replaceOnce(fs, 'vec3 col = vColor * light;',
        '  float fxLandMask = smoothstep(-0.015, 0.015, fxRelief);\n' +
        '  vec3 albedo = hueRotate(paletteColor(vColor, fField), uHueShift);\n' +
        '  albedo = fxTexture(albedo, vObjDir, fField, fxLandMask, 1.0 - fxLandMask);\n' +
        '  vec3 col = albedo * light;',
        'surface.fs albedo');

      return { vs, fs };
    },

    onSurfaceProgram(gl: WebGL2RenderingContext, program: WebGLProgram): void {
      uniforms = {
        sep: gl.getUniformLocation(program, 'uSep'),
        shardMode: gl.getUniformLocation(program, 'uShardMode'),
        shardCount: gl.getUniformLocation(program, 'uShardCount'),
        shardTex: gl.getUniformLocation(program, 'uShardTex'),
        shardIdTex: gl.getUniformLocation(program, 'uShardIdTex'),
        shardIdW: gl.getUniformLocation(program, 'uShardIdW'),
        shardIdReady: gl.getUniformLocation(program, 'uShardIdReady'),
        palette: gl.getUniformLocation(program, 'uPalette'),
        hueShift: gl.getUniformLocation(program, 'uHueShift'),
        texMode: gl.getUniformLocation(program, 'uTexMode'),
        texAmount: gl.getUniformLocation(program, 'uTexAmount'),
        texScale: gl.getUniformLocation(program, 'uTexScale'),
        texSeed: gl.getUniformLocation(program, 'uTexSeed'),
        reliefScale: gl.getUniformLocation(program, 'uReliefScale'),
      };
    },

    /** Геометрия готова: дальше индекс осколка берётся из vertexCellId. */
    onGeometryReady(_gl: WebGL2RenderingContext, grid: PlanetGrid, geometry: GlobeGeometry): void {
      readyGrid = grid;
      readyGeometry = geometry;
      // Новая сетка/геометрия — layout и текстуры индексов пересоберутся
      // лениво, в ближайшем onSurfaceDraw (см. ensureShardLayout).
    },

    onSurfaceDraw(gl: WebGL2RenderingContext, program: WebGLProgram): void {
      if (!uniforms) return;
      gl.useProgram(program);
      ensureShardTexture(gl);
      const cellIndexReady = state.shardMode ? ensureShardIdTexture(gl) : false;
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, shardTexture);
      if (uniforms.shardTex) gl.uniform1i(uniforms.shardTex, 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, shardIdTexture);
      if (uniforms.shardIdTex) gl.uniform1i(uniforms.shardIdTex, 3);
      if (uniforms.shardIdW) gl.uniform1i(uniforms.shardIdW, shardIdTexWidth);
      if (uniforms.shardIdReady) gl.uniform1f(uniforms.shardIdReady, cellIndexReady ? 1 : 0);
      if (uniforms.sep) gl.uniform1f(uniforms.sep, state.separation);
      if (uniforms.shardMode) gl.uniform1f(uniforms.shardMode, state.shardMode ? 1 : 0);
      if (uniforms.shardCount) gl.uniform1f(uniforms.shardCount, Math.max(2, Math.min(MAX_SHARDS, state.shardCount)));
      if (uniforms.palette) gl.uniform1f(uniforms.palette, state.theme.palette);
      if (uniforms.hueShift) gl.uniform1f(uniforms.hueShift, state.theme.hueShiftDeg * Math.PI / 180);
      if (uniforms.texMode) gl.uniform1f(uniforms.texMode, state.theme.textureMode);
      if (uniforms.texAmount) gl.uniform1f(uniforms.texAmount, state.theme.textureAmount);
      if (uniforms.texScale) gl.uniform1f(uniforms.texScale, state.theme.textureScale);
      if (uniforms.texSeed) {
        const s = PlanetNoise.stringSeed(state.seedText + ':fx-texture');
        gl.uniform3f(uniforms.texSeed,
          ((s & 255) / 255) * 8, (((s >>> 8) & 255) / 255) * 8, (((s >>> 16) & 255) / 255) * 8);
      }
      if (uniforms.reliefScale) gl.uniform1f(uniforms.reliefScale, Math.max(0.001, state.reliefScale));
      gl.activeTexture(gl.TEXTURE0);
    },

    /**
     * После отрисовки поверхности: объём разломов и раскалённое ядро.
     * Фоновый глобус к этому моменту уже залил depth, поэтому объём и ядро
     * просто дорисовываются с обычным тестом глубины (без блендинга), а
     * состояние GL восстанавливается до вызова — дальше глобус рисует
     * выделение ячейки и атмосферу.
     */
    onAfterSurfaceDraw(gl: WebGL2RenderingContext, frame: FxFrameContext): void {
      if (effectsFailed || !state.shardMode) return;
      if (!frame || !frame.mvp || !frame.model) return;
      if (!ensureShardLayout()) return;
      const visuals = separationVisuals(state.separation, state.shardMode, shardMaxB);
      const volumeVisible = state.separation > 0.0001 || shardMaxB > 0.0001;
      if (!volumeVisible && !visuals.coreVisible) return;

      const prevCull = gl.isEnabled(gl.CULL_FACE);
      const prevBlend = gl.isEnabled(gl.BLEND);
      const prevDepthMask = Boolean(gl.getParameter(gl.DEPTH_WRITEMASK));
      const light = frame && frame.lightDir && frame.lightDir.length >= 3
        ? frame.lightDir : new Float32Array([0.55, -0.35, 0.75]);
      const lx = light[0] as number;
      const ly = light[1] as number;
      const lz = light[2] as number;

      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(null);

      try {
        if (volumeVisible) {
          ensureVolume(gl);
          if (volProgram && volUniforms && volVao && volIndexCount > 0) {
            ensureShardTexture(gl);
            gl.useProgram(volProgram);
            gl.uniformMatrix4fv(volUniforms.mvp, false, frame.mvp);
            gl.uniformMatrix4fv(volUniforms.model, false, frame.model);
            gl.uniform1f(volUniforms.scale, 1);
            gl.uniform1f(volUniforms.thick, Math.max(0.001, state.shardThick ?? 0.14));
            gl.uniform1f(volUniforms.shardMode, 1);
            gl.uniform1f(volUniforms.sep, state.separation);
            gl.uniform3f(volUniforms.sun, lx, ly, lz);
            // Трансформы осколков — та же текстура, что у поверхности.
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, shardTexture);
            gl.uniform1i(volUniforms.shardTex, 0);
            gl.bindVertexArray(volVao);
            gl.drawElements(gl.TRIANGLES, volIndexCount, gl.UNSIGNED_INT, 0);
          }
        }
        if (visuals.coreVisible) {
          ensureCore(gl);
          if (coreProgram && coreUniforms && coreVao && coreIndexCount > 0) {
            gl.useProgram(coreProgram);
            gl.uniformMatrix4fv(coreUniforms.mvp, false, frame.mvp);
            gl.uniformMatrix4fv(coreUniforms.model, false, frame.model);
            gl.uniform1f(coreUniforms.scale, Math.max(0.05, state.coreScale ?? DEFAULT_CORE_SCALE));
            gl.uniform3f(coreUniforms.sun, lx, ly, lz);
            gl.bindVertexArray(coreVao);
            gl.drawElements(gl.TRIANGLES, coreIndexCount, gl.UNSIGNED_INT, 0);
          }
        }
      } catch (err) {
        failEffects(err);
      }

      gl.bindVertexArray(null);
      gl.useProgram(null);
      gl.activeTexture(gl.TEXTURE0);
      if (prevCull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      if (prevBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
      gl.depthMask(prevDepthMask);
    },

    /** Освобождение всех GPU-ресурсов плагина. */
    onDispose(gl: WebGL2RenderingContext): void {
      clearVolume(gl);
      clearCore(gl);
      if (volProgram) gl.deleteProgram(volProgram);
      if (coreProgram) gl.deleteProgram(coreProgram);
      volProgram = null;
      volUniforms = null;
      coreProgram = null;
      coreUniforms = null;
      if (shardTexture) gl.deleteTexture(shardTexture);
      if (shardIdTexture) gl.deleteTexture(shardIdTexture);
      shardTexture = null;
      shardTextureKey = '';
      shardIdTexture = null;
      shardIdTextureKey = '';
      shardIdAvailable = false;
      uniforms = null;
      volKey = '';
      effectsFailed = false;
    },
  };
}
