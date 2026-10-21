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

   Канонический CPU-путь осколков (computeShardLayout + buildShardTextureData
   из planet-geometry.js спайка) сохранён для геометрий с атрибутом aShard
   (Этапы 8/9); на вершинном формате planet-globe-v1 без aShard осколок
   назначается квантованием направления прямо в GLSL (fxShardIndex). */

import PlanetNoise from '../../site/shared/planet-noise.ts';
import type { PlanetGrid } from '../../site/shared/geodesic-grid.ts';
import type { PlanetGlobeFxHooks } from '../../site/shared/planet-globe.ts';

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
}

function replaceOnce(source: string, needle: string, replacement: string, label: string): string {
  const index = source.indexOf(needle);
  if (index < 0) {
    throw new Error('PlanetGlobeFx: не найден маркер шейдера ' + label);
  }
  return source.slice(0, index) + replacement + source.slice(index + needle.length);
}

interface FxUniforms {
  sep: WebGLUniformLocation | null;
  shardMode: WebGLUniformLocation | null;
  shardCount: WebGLUniformLocation | null;
  shardTex: WebGLUniformLocation | null;
  palette: WebGLUniformLocation | null;
  hueShift: WebGLUniformLocation | null;
  texMode: WebGLUniformLocation | null;
  texAmount: WebGLUniformLocation | null;
  texScale: WebGLUniformLocation | null;
  texSeed: WebGLUniformLocation | null;
  reliefScale: WebGLUniformLocation | null;
}

/** Хуки плагина: декорируют surface-шейдеры глобуса и гоняют uniform-ы FX. */
export function createFxHooks(state: FxRuntimeState): PlanetGlobeFxHooks {
  let uniforms: FxUniforms | null = null;
  let shardTexture: WebGLTexture | null = null;
  let shardTextureKey = '';

  const ensureShardTexture = (gl: WebGL2RenderingContext): void => {
    const key = state.shardCount + '|' + state.seedText + '|' + String(state.shardMode);
    if (shardTexture && shardTextureKey === key) return;
    const layout = buildProceduralShardLayout({
      count: Math.max(2, Math.min(MAX_SHARDS, Math.round(state.shardCount))),
      dist: 'power', sep: 0, thick: 0.14, jag: 0.5, loss: 0, seedText: state.seedText,
    });
    const built = buildShardTextureData(layout, 0);
    if (!shardTexture) shardTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shardTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_SHARDS, 4, 0, gl.RGBA, gl.FLOAT, built.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    shardTextureKey = key;
  };

  return {
    decorateSurfaceShaders(src: { vs: string; fs: string }): { vs: string; fs: string } {
      // Vertex: трансформ осколков Шакураса поверх позиций planet-globe-v1.
      let vs = src.vs;
      vs = replaceOnce(vs, 'void main() {',
        SHARD_TRANSFORM_GLSL + '\nuniform float uShardCount;\n' +
        '// planet-globe-v1 не несёт aShard: осколок квантуется по направлению.\n' +
        'float fxShardIndex(vec3 p) {\n' +
        '  vec3 q = floor(normalize(p) * max(uShardCount, 1.0) * 0.5) + 0.5;\n' +
        '  return floor(fract(sin(dot(q, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * uShardCount);\n' +
        '}\n' +
        'vec3 fxShardPosition(vec3 p) {\n' +
        '  if (uShardMode < 0.5) return p;\n' +
        '  return shardTransform(p, fxShardIndex(p));\n' +
        '}\n' +
        'out vec3 vObjDir;\n' +
        'out float vRadius;\n' +
        'void main() {\n' +
        '  vec3 fxPos = fxShardPosition(aPos);',
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
        palette: gl.getUniformLocation(program, 'uPalette'),
        hueShift: gl.getUniformLocation(program, 'uHueShift'),
        texMode: gl.getUniformLocation(program, 'uTexMode'),
        texAmount: gl.getUniformLocation(program, 'uTexAmount'),
        texScale: gl.getUniformLocation(program, 'uTexScale'),
        texSeed: gl.getUniformLocation(program, 'uTexSeed'),
        reliefScale: gl.getUniformLocation(program, 'uReliefScale'),
      };
    },

    onSurfaceDraw(gl: WebGL2RenderingContext, program: WebGLProgram): void {
      if (!uniforms) return;
      gl.useProgram(program);
      ensureShardTexture(gl);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, shardTexture);
      if (uniforms.shardTex) gl.uniform1i(uniforms.shardTex, 2);
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
    },
  };
}
