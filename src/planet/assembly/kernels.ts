// @ts-nocheck
// planet-core — Wasm-ускоритель горячих циклов планетной генерации (CR-01 PR 4).
// =============================================================================
// Этот файл — исходник AssemblyScript. Он НЕ входит в tsconfig проекта и
// компилируется отдельным скриптом tools/build_planet_core.mjs в .wasm,
// байты которого встраиваются в src/planet/planet-core-bytes.ts.
//
// КОНТРАКТ ДЕТЕРМИНИЗМА (И-2):
//   - Все ядра повторяют арифметику замороженных JS-рецептов Этапов 4–6
//     побитово: тот же порядок операций f64, те же округления при записи в
//     f32-массивы. Трансцендентные функции, чьё побитовое совпадение между
//     движками не гарантировано (pow, exp, log), в ядро не вносятся: host
//     считает их в TS и передаёт готовые массивы.
//   - Приоритетная очередь Дейкстр извлекает строго по (key, cellIndex):
//     Dial-бакеты шириной 1.0 (стоимости рёбер >= 1.0 по построению) с
//     сортировкой бакета при активации; при нарушении предусловия —
//     фолбэк на 4-арную кучу с тем же порядком извлечения. Пары
//     (key, cell) у потребителей уникальны, поэтому последовательность
//     pop'ов не зависит от структуры очереди.
//   - Сортировки — стабильный radix по монотонному ключу значения;
//     при равных значениях порядок индексов сохраняется (эквивалентно
//     стабильному Array.sort со сравнением-разностью и tie-break a-b).
//   - Память: никаких managed-объектов (runtime stub). Host-арена с
//     ARENA_BASE; таблица градиентов симплекса пишется host'ом по
//     указателю из setGradTable. Ядра инициализируют выходы по ВСЕМ
//     ячейкам: память арены переиспользуется между сессиями.

declare function abort(message: string | null, fileName: string | null, line: u32, column: u32): void;

const ARENA_BASE: usize = 1048576;

export function coreVersion(): i32 { return 1; }
export function arenaBase(): usize { return ARENA_BASE; }
export function heapBase(): usize { return __heap_base; }

let GRAD: usize = 0;
export function setGradTable(ptr: usize): void { GRAD = ptr; }

@inline function clampd(x: f64, lo: f64, hi: f64): f64 { return x < lo ? lo : (x > hi ? hi : x); }
@inline function clamp01d(x: f64): f64 { return x < 0.0 ? 0.0 : (x > 1.0 ? 1.0 : x); }

// --------------------------------------------------------------- xxHash32
// Точная копия xxHash32 из planet-geography (итерации на u32 с imul).

const XX_P1: u32 = 2654435761;
const XX_P2: u32 = 2246822519;
const XX_P3: u32 = 3266489917;
const XX_P4: u32 = 668265263;
const XX_P5: u32 = 374761393;

@inline function xxRound(acc: u32, input: u32): u32 {
  acc += input * XX_P2;
  acc = (acc << 13) | (acc >> 19);
  return acc * XX_P1;
}

export function xxhash32(bytes: usize, len: i32, seed: u32): u32 {
  let p: i32 = 0;
  let h: u32;
  if (len >= 16) {
    let v1: u32 = seed + XX_P1 + XX_P2;
    let v2: u32 = seed + XX_P2;
    let v3: u32 = seed;
    let v4: u32 = seed - XX_P1;
    const limit = len - 16;
    while (p <= limit) {
      v1 = xxRound(v1, load<u32>(bytes + usize(p))); p += 4;
      v2 = xxRound(v2, load<u32>(bytes + usize(p))); p += 4;
      v3 = xxRound(v3, load<u32>(bytes + usize(p))); p += 4;
      v4 = xxRound(v4, load<u32>(bytes + usize(p))); p += 4;
    }
    h = ((v1 << 1) | (v1 >> 31)) + ((v2 << 7) | (v2 >> 25)) +
        ((v3 << 12) | (v3 >> 20)) + ((v4 << 18) | (v4 >> 14));
  } else {
    h = seed + XX_P5;
  }
  h += u32(len);
  while (p <= len - 4) {
    h += load<u32>(bytes + usize(p)) * XX_P3;
    h = ((h << 17) | (h >> 15)) * XX_P4;
    p += 4;
  }
  while (p < len) {
    h += u32(load<u8>(bytes + usize(p))) * XX_P5;
    h = ((h << 11) | (h >> 21)) * XX_P1;
    p++;
  }
  h ^= h >> 15;
  h *= XX_P2;
  h ^= h >> 13;
  h *= XX_P3;
  h ^= h >> 16;
  return h;
}

// ------------------------------------------------------------ simplex 3D
// Точная копия makeSimplex из planet-noise (planet-noise-simplex3d-v1).
// Таблица: perm[512] по table, permMod12[512] по table+512; градиенты —
// f64-тройки по GRAD (host), индекс = permMod12[...] * 24 байта.

const F3: f64 = 1.0 / 3.0;
const G3: f64 = 1.0 / 6.0;

function simplex3(table: usize, xin: f64, yin: f64, zin: f64): f64 {
  let n0: f64, n1: f64, n2: f64, n3: f64;
  const s = (xin + yin + zin) * F3;
  const i = i32(Math.floor(xin + s)), j = i32(Math.floor(yin + s)), k = i32(Math.floor(zin + s));
  const t = f64(i + j + k) * G3;
  const x0 = xin - (f64(i) - t), y0 = yin - (f64(j) - t), z0 = zin - (f64(k) - t);
  let i1 = 0, j1 = 0, k1 = 0, i2 = 0, j2 = 0, k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  const x1 = x0 - f64(i1) + G3, y1 = y0 - f64(j1) + G3, z1 = z0 - f64(k1) + G3;
  const x2 = x0 - f64(i2) + 2.0 * G3, y2 = y0 - f64(j2) + 2.0 * G3, z2 = z0 - f64(k2) + 2.0 * G3;
  const x3 = x0 - 1.0 + 3.0 * G3, y3 = y0 - 1.0 + 3.0 * G3, z3 = z0 - 1.0 + 3.0 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  const pm = table + 512;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 < 0.0) n0 = 0.0; else {
    const gi = usize(load<u8>(pm + usize(ii + i32(load<u8>(table + usize(jj + i32(load<u8>(table + usize(kk))))))))) * 24;
    t0 *= t0;
    n0 = t0 * t0 * (load<f64>(GRAD + gi) * x0 + load<f64>(GRAD + gi + 8) * y0 + load<f64>(GRAD + gi + 16) * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 < 0.0) n1 = 0.0; else {
    const gi = usize(load<u8>(pm + usize(ii + i1 + i32(load<u8>(table + usize(jj + j1 + i32(load<u8>(table + usize(kk + k1))))))))) * 24;
    t1 *= t1;
    n1 = t1 * t1 * (load<f64>(GRAD + gi) * x1 + load<f64>(GRAD + gi + 8) * y1 + load<f64>(GRAD + gi + 16) * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 < 0.0) n2 = 0.0; else {
    const gi = usize(load<u8>(pm + usize(ii + i2 + i32(load<u8>(table + usize(jj + j2 + i32(load<u8>(table + usize(kk + k2))))))))) * 24;
    t2 *= t2;
    n2 = t2 * t2 * (load<f64>(GRAD + gi) * x2 + load<f64>(GRAD + gi + 8) * y2 + load<f64>(GRAD + gi + 16) * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 < 0.0) n3 = 0.0; else {
    const gi = usize(load<u8>(pm + usize(ii + 1 + i32(load<u8>(table + usize(jj + 1 + i32(load<u8>(table + usize(kk + 1))))))))) * 24;
    t3 *= t3;
    n3 = t3 * t3 * (load<f64>(GRAD + gi) * x3 + load<f64>(GRAD + gi + 8) * y3 + load<f64>(GRAD + gi + 16) * z3);
  }
  return 32.0 * (n0 + n1 + n2 + n3);
}

export function simplexOnce(table: usize, x: f64, y: f64, z: f64): f64 {
  return simplex3(table, x, y, z);
}

function simplexFbm(table: usize, x: f64, y: f64, z: f64, octaves: i32, lacunarity: f64, gain: f64): f64 {
  let amp: f64 = 1.0, freq: f64 = 1.0, sum: f64 = 0.0, norm: f64 = 0.0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * simplex3(table, x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbmOnce(table: usize, x: f64, y: f64, z: f64, octaves: i32, lacunarity: f64, gain: f64): f64 {
  return simplexFbm(table, x, y, z, octaves, lacunarity, gain);
}

// ------------------------------------------------------------- value noise
// Точная копия makeValue из planet-noise.

@inline function hash32u(x: u32): u32 {
  x = (x ^ (x >> 16)) * 0x45d9f3b;
  x = (x ^ (x >> 16)) * 0x45d9f3b;
  return (x ^ (x >> 16)) >>> 0;
}

@inline function latValue(seed: i32, ix: i32, iy: i32, iz: i32): f64 {
  const h = u32(ix * 374761393) ^ u32(iy * 668265263) ^ u32(iz * 1274126177) ^ u32(seed);
  return (f64(hash32u(h)) / 4294967295.0) * 2.0 - 1.0;
}

@inline function fade(t: f64): f64 { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
@inline function lerpd(a: f64, b: f64, t: f64): f64 { return a + (b - a) * t; }

export function valueOnce(seed: i32, x: f64, y: f64, z: f64): f64 {
  const ix = i32(Math.floor(x)), iy = i32(Math.floor(y)), iz = i32(Math.floor(z));
  const fx = x - f64(ix), fy = y - f64(iy), fz = z - f64(iz);
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);
  const c000 = latValue(seed, ix, iy, iz), c100 = latValue(seed, ix + 1, iy, iz);
  const c010 = latValue(seed, ix, iy + 1, iz), c110 = latValue(seed, ix + 1, iy + 1, iz);
  const c001 = latValue(seed, ix, iy, iz + 1), c101 = latValue(seed, ix + 1, iy, iz + 1);
  const c011 = latValue(seed, ix, iy + 1, iz + 1), c111 = latValue(seed, ix + 1, iy + 1, iz + 1);
  return lerpd(
    lerpd(lerpd(c000, c100, ux), lerpd(c010, c110, ux), uy),
    lerpd(lerpd(c001, c101, ux), lerpd(c011, c111, ux), uy),
    uz);
}

// ------------------------------------------------------------ simplex x2
// SIMD f64x2: две независимые точки в лейнах. Побитово тождественна
// скалярной simplex3 по каждому лейну: те же операции f64 в том же
// порядке (ассоциативность сохранена), ветвления углов и хэш градиентов —
// скалярно по лейнам, арифметика углов — векторно. Условие t<0 заменено
// bitselect'ом: dot вычисляется всегда (нагрузки градиентов безопасны,
// значения конечны), результат лейна при t<0 — ровно 0.0, как в скаляре.

@inline function pack2(a: f64, b: f64): v128 {
  return f64x2.replace_lane(f64x2.splat(a), 1, b);
}
@inline function lane0(v: v128): f64 { return f64x2.extract_lane(v, 0); }
@inline function lane1(v: v128): f64 { return f64x2.extract_lane(v, 1); }

function simplex3x2(table: usize, xv: v128, yv: v128, zv: v128): v128 {
  const F3v = f64x2.splat(F3);
  const G3v = f64x2.splat(G3);
  const sv = f64x2.mul(f64x2.add(f64x2.add(xv, yv), zv), F3v);
  const xA = lane0(xv), xB = lane1(xv);
  const yA = lane0(yv), yB = lane1(yv);
  const zA = lane0(zv), zB = lane1(zv);
  const sA = lane0(sv), sB = lane1(sv);
  const iA = i32(Math.floor(xA + sA)), iB = i32(Math.floor(xB + sB));
  const jA = i32(Math.floor(yA + sA)), jB = i32(Math.floor(yB + sB));
  const kA = i32(Math.floor(zA + sA)), kB = i32(Math.floor(zB + sB));
  const tA = f64(iA + jA + kA) * G3, tB = f64(iB + jB + kB) * G3;
  const x0A = xA - (f64(iA) - tA), x0B = xB - (f64(iB) - tB);
  const y0A = yA - (f64(jA) - tA), y0B = yB - (f64(jB) - tB);
  const z0A = zA - (f64(kA) - tA), z0B = zB - (f64(kB) - tB);
  let i1A = 0, j1A = 0, k1A = 0, i2A = 0, j2A = 0, k2A = 0;
  if (x0A >= y0A) {
    if (y0A >= z0A) { i1A = 1; j1A = 0; k1A = 0; i2A = 1; j2A = 1; k2A = 0; }
    else if (x0A >= z0A) { i1A = 1; j1A = 0; k1A = 0; i2A = 1; j2A = 0; k2A = 1; }
    else { i1A = 0; j1A = 0; k1A = 1; i2A = 1; j2A = 0; k2A = 1; }
  } else {
    if (y0A < z0A) { i1A = 0; j1A = 0; k1A = 1; i2A = 0; j2A = 1; k2A = 1; }
    else if (x0A < z0A) { i1A = 0; j1A = 1; k1A = 0; i2A = 0; j2A = 1; k2A = 1; }
    else { i1A = 0; j1A = 1; k1A = 0; i2A = 1; j2A = 1; k2A = 0; }
  }
  let i1B = 0, j1B = 0, k1B = 0, i2B = 0, j2B = 0, k2B = 0;
  if (x0B >= y0B) {
    if (y0B >= z0B) { i1B = 1; j1B = 0; k1B = 0; i2B = 1; j2B = 1; k2B = 0; }
    else if (x0B >= z0B) { i1B = 1; j1B = 0; k1B = 0; i2B = 1; j2B = 0; k2B = 1; }
    else { i1B = 0; j1B = 0; k1B = 1; i2B = 1; j2B = 0; k2B = 1; }
  } else {
    if (y0B < z0B) { i1B = 0; j1B = 0; k1B = 1; i2B = 0; j2B = 1; k2B = 1; }
    else if (x0B < z0B) { i1B = 0; j1B = 1; k1B = 0; i2B = 0; j2B = 1; k2B = 1; }
    else { i1B = 0; j1B = 1; k1B = 0; i2B = 1; j2B = 1; k2B = 0; }
  }
  const x0v = pack2(x0A, x0B), y0v = pack2(y0A, y0B), z0v = pack2(z0A, z0B);
  const x1v = f64x2.add(f64x2.sub(x0v, pack2(f64(i1A), f64(i1B))), G3v);
  const y1v = f64x2.add(f64x2.sub(y0v, pack2(f64(j1A), f64(j1B))), G3v);
  const z1v = f64x2.add(f64x2.sub(z0v, pack2(f64(k1A), f64(k1B))), G3v);
  const G3x2v = f64x2.splat(2.0 * G3);
  const x2v = f64x2.add(f64x2.sub(x0v, pack2(f64(i2A), f64(i2B))), G3x2v);
  const y2v = f64x2.add(f64x2.sub(y0v, pack2(f64(j2A), f64(j2B))), G3x2v);
  const z2v = f64x2.add(f64x2.sub(z0v, pack2(f64(k2A), f64(k2B))), G3x2v);
  const G3x3v = f64x2.splat(3.0 * G3);
  const onev = f64x2.splat(1.0);
  const x3v = f64x2.add(f64x2.sub(x0v, onev), G3x3v);
  const y3v = f64x2.add(f64x2.sub(y0v, onev), G3x3v);
  const z3v = f64x2.add(f64x2.sub(z0v, onev), G3x3v);
  const iiA = iA & 255, jjA = jA & 255, kkA = kA & 255;
  const iiB = iB & 255, jjB = jB & 255, kkB = kB & 255;
  const pm = table + 512;
  const zero = f64x2.splat(0.0);
  const c06 = f64x2.splat(0.6);

  const gi0A = usize(load<u8>(pm + usize(iiA + i32(load<u8>(table + usize(jjA + i32(load<u8>(table + usize(kkA))))))))) * 24;
  const gi0B = usize(load<u8>(pm + usize(iiB + i32(load<u8>(table + usize(jjB + i32(load<u8>(table + usize(kkB))))))))) * 24;
  let t0v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x0v, x0v)), f64x2.mul(y0v, y0v)), f64x2.mul(z0v, z0v));
  const t0raw = t0v;
  t0v = f64x2.mul(t0v, t0v);
  let n0v = f64x2.mul(f64x2.mul(t0v, t0v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(GRAD + gi0A), load<f64>(GRAD + gi0B)), x0v),
    f64x2.mul(pack2(load<f64>(GRAD + gi0A + 8), load<f64>(GRAD + gi0B + 8)), y0v)),
    f64x2.mul(pack2(load<f64>(GRAD + gi0A + 16), load<f64>(GRAD + gi0B + 16)), z0v)));
  n0v = v128.bitselect(zero, n0v, f64x2.lt(t0raw, zero));

  const gi1A = usize(load<u8>(pm + usize(iiA + i1A + i32(load<u8>(table + usize(jjA + j1A + i32(load<u8>(table + usize(kkA + k1A))))))))) * 24;
  const gi1B = usize(load<u8>(pm + usize(iiB + i1B + i32(load<u8>(table + usize(jjB + j1B + i32(load<u8>(table + usize(kkB + k1B))))))))) * 24;
  let t1v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x1v, x1v)), f64x2.mul(y1v, y1v)), f64x2.mul(z1v, z1v));
  const t1raw = t1v;
  t1v = f64x2.mul(t1v, t1v);
  let n1v = f64x2.mul(f64x2.mul(t1v, t1v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(GRAD + gi1A), load<f64>(GRAD + gi1B)), x1v),
    f64x2.mul(pack2(load<f64>(GRAD + gi1A + 8), load<f64>(GRAD + gi1B + 8)), y1v)),
    f64x2.mul(pack2(load<f64>(GRAD + gi1A + 16), load<f64>(GRAD + gi1B + 16)), z1v)));
  n1v = v128.bitselect(zero, n1v, f64x2.lt(t1raw, zero));

  const gi2A = usize(load<u8>(pm + usize(iiA + i2A + i32(load<u8>(table + usize(jjA + j2A + i32(load<u8>(table + usize(kkA + k2A))))))))) * 24;
  const gi2B = usize(load<u8>(pm + usize(iiB + i2B + i32(load<u8>(table + usize(jjB + j2B + i32(load<u8>(table + usize(kkB + k2B))))))))) * 24;
  let t2v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x2v, x2v)), f64x2.mul(y2v, y2v)), f64x2.mul(z2v, z2v));
  const t2raw = t2v;
  t2v = f64x2.mul(t2v, t2v);
  let n2v = f64x2.mul(f64x2.mul(t2v, t2v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(GRAD + gi2A), load<f64>(GRAD + gi2B)), x2v),
    f64x2.mul(pack2(load<f64>(GRAD + gi2A + 8), load<f64>(GRAD + gi2B + 8)), y2v)),
    f64x2.mul(pack2(load<f64>(GRAD + gi2A + 16), load<f64>(GRAD + gi2B + 16)), z2v)));
  n2v = v128.bitselect(zero, n2v, f64x2.lt(t2raw, zero));

  const gi3A = usize(load<u8>(pm + usize(iiA + 1 + i32(load<u8>(table + usize(jjA + 1 + i32(load<u8>(table + usize(kkA + 1))))))))) * 24;
  const gi3B = usize(load<u8>(pm + usize(iiB + 1 + i32(load<u8>(table + usize(jjB + 1 + i32(load<u8>(table + usize(kkB + 1))))))))) * 24;
  let t3v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x3v, x3v)), f64x2.mul(y3v, y3v)), f64x2.mul(z3v, z3v));
  const t3raw = t3v;
  t3v = f64x2.mul(t3v, t3v);
  let n3v = f64x2.mul(f64x2.mul(t3v, t3v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(GRAD + gi3A), load<f64>(GRAD + gi3B)), x3v),
    f64x2.mul(pack2(load<f64>(GRAD + gi3A + 8), load<f64>(GRAD + gi3B + 8)), y3v)),
    f64x2.mul(pack2(load<f64>(GRAD + gi3A + 16), load<f64>(GRAD + gi3B + 16)), z3v)));
  n3v = v128.bitselect(zero, n3v, f64x2.lt(t3raw, zero));

  return f64x2.mul(f64x2.splat(32.0), f64x2.add(f64x2.add(f64x2.add(n0v, n1v), n2v), n3v));
}

function simplexFbmX2(table: usize, xv: v128, yv: v128, zv: v128, octaves: i32, lacunarity: f64, gain: f64): v128 {
  let amp: f64 = 1.0, freq: f64 = 1.0, norm: f64 = 0.0;
  let sum = f64x2.splat(0.0);
  for (let o = 0; o < octaves; o++) {
    const fv = f64x2.splat(freq);
    sum = f64x2.add(sum, f64x2.mul(f64x2.splat(amp),
      simplex3x2(table, f64x2.mul(xv, fv), f64x2.mul(yv, fv), f64x2.mul(zv, fv))));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return f64x2.div(sum, f64x2.splat(norm));
}

// --------------------------------------------------------- sample fields
// Пакетный сэмплер полей географии (createFieldSampler.sampleFields из
// planet-geography): 7 доменов таблиц по 1024 байта, params — f64[23]:
// [0]=ratio, [1]=climateRatio, далее оффсеты E/M/T/P/V/D/W по 3.
// Выход out — f32[6*count] в порядке FIELD_INDEX; volcPreOut — f64[count]
// clamp01(volcRaw/2+0.5) ДО Math.pow(...,1.5): степень применяет host.

let sfPE: usize = 0, sfPM: usize = 0, sfPT: usize = 0, sfPP: usize = 0;
let sfPV: usize = 0, sfPD: usize = 0, sfPW: usize = 0;
let sfOE0: f64 = 0, sfOE1: f64 = 0, sfOE2: f64 = 0;
let sfOM0: f64 = 0, sfOM1: f64 = 0, sfOM2: f64 = 0;
let sfOT0: f64 = 0, sfOT1: f64 = 0, sfOT2: f64 = 0;
let sfOP0: f64 = 0, sfOP1: f64 = 0, sfOP2: f64 = 0;
let sfOV0: f64 = 0, sfOV1: f64 = 0, sfOV2: f64 = 0;
let sfOD0: f64 = 0, sfOD1: f64 = 0, sfOD2: f64 = 0;
let sfOW0: f64 = 0, sfOW1: f64 = 0, sfOW2: f64 = 0;
let sfWarpFreq: f64 = 0, sfWarpAmp: f64 = 0, sfElevationFreq: f64 = 0;
let sfDetailFreq: f64 = 0, sfMoistureFreq: f64 = 0, sfTempFreq: f64 = 0, sfVolcFreq: f64 = 0;
let sfCenters: usize = 0, sfOut: usize = 0, sfVolcPreOut: usize = 0;

function sampleStoreCell(c: i32, plate: f64, base: f64, detail: f64,
  moistureRaw: f64, tempAnomaly: f64, ny: f64, volcRaw: f64): void {
  const elevation = clampd(0.74 * base + 0.30 * plate + 0.10 * detail, -1.0, 1.0);
  const moisture = clamp01d(0.5 + 0.5 * moistureRaw + 0.04 * plate);
  const insolation = Math.sqrt(Math.max(0.0, 1.0 - ny * ny));
  const temperatureBase = clamp01d(0.72 * insolation + 0.28 * (tempAnomaly * 0.5 + 0.5));
  const oi = sfOut + usize(c * 24);
  store<f32>(oi, f32(elevation));
  store<f32>(oi + 4, f32(moisture));
  store<f32>(oi + 8, f32(temperatureBase));
  store<f32>(oi + 12, f32(clamp01d(plate * 0.5 + 0.5)));
  const volcPre = clamp01d(volcRaw * 0.5 + 0.5);
  store<f32>(oi + 16, f32(volcPre));
  store<f64>(sfVolcPreOut + usize(c * 8), volcPre);
  store<f32>(oi + 20, f32(clampd(detail, -1.0, 1.0)));
}

function sampleCellScalar(c: i32): void {
  const ci = sfCenters + usize(c * 24);
  const x = load<f64>(ci), y = load<f64>(ci + 8), z = load<f64>(ci + 16);
  const len = Math.sqrt(x * x + y * y + z * z);
  const nx = x / len, ny = y / len, nz = z / len;
  const wx = simplex3(sfPW, nx * sfWarpFreq + sfOW0, ny * sfWarpFreq + sfOW1, nz * sfWarpFreq + sfOW2);
  const wy = simplex3(sfPW, nx * sfWarpFreq + sfOW1, ny * sfWarpFreq + sfOW2, nz * sfWarpFreq + sfOW0);
  const wz = simplex3(sfPW, nx * sfWarpFreq + sfOW2, ny * sfWarpFreq + sfOW0, nz * sfWarpFreq + sfOW1);
  const along = wx * nx + wy * ny + wz * nz;
  let dx = nx + (wx - along * nx) * sfWarpAmp;
  let dy = ny + (wy - along * ny) * sfWarpAmp;
  let dz = nz + (wz - along * nz) * sfWarpAmp;
  let dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dlen == 0.0) dlen = 1.0;
  dx /= dlen; dy /= dlen; dz /= dlen;
  const plate = simplexFbm(sfPP, nx * 1.12 + sfOP0, ny * 1.12 + sfOP1, nz * 1.12 + sfOP2, 3, 2.0, 0.52);
  const base = simplexFbm(sfPE, dx * sfElevationFreq + sfOE0, dy * sfElevationFreq + sfOE1, dz * sfElevationFreq + sfOE2, 5, 2.0, 0.5);
  const detail = simplexFbm(sfPD, dx * sfDetailFreq + sfOD0, dy * sfDetailFreq + sfOD1, dz * sfDetailFreq + sfOD2, 3, 2.0, 0.55);
  const moistureRaw = simplexFbm(sfPM, dx * sfMoistureFreq + sfOM0, dy * sfMoistureFreq + sfOM1, dz * sfMoistureFreq + sfOM2, 4, 2.0, 0.5);
  const tempAnomaly = simplex3(sfPT, nx * sfTempFreq + sfOT0, ny * sfTempFreq + sfOT1, nz * sfTempFreq + sfOT2);
  const volcRaw = simplexFbm(sfPV, nx * sfVolcFreq + sfOV0, ny * sfVolcFreq + sfOV1, nz * sfVolcFreq + sfOV2, 3, 2.0, 0.55);
  sampleStoreCell(c, plate, base, detail, moistureRaw, tempAnomaly, ny, volcRaw);
}

function sampleCellPair(c: i32): void {
  const ciA = sfCenters + usize(c * 24);
  const ciB = ciA + 24;
  const xA = load<f64>(ciA), yA = load<f64>(ciA + 8), zA = load<f64>(ciA + 16);
  const xB = load<f64>(ciB), yB = load<f64>(ciB + 8), zB = load<f64>(ciB + 16);
  const lenA = Math.sqrt(xA * xA + yA * yA + zA * zA);
  const lenB = Math.sqrt(xB * xB + yB * yB + zB * zB);
  const nxA = xA / lenA, nyA = yA / lenA, nzA = zA / lenA;
  const nxB = xB / lenB, nyB = yB / lenB, nzB = zB / lenB;
  const nxv = pack2(nxA, nxB), nyv = pack2(nyA, nyB), nzv = pack2(nzA, nzB);
  const wfv = f64x2.splat(sfWarpFreq);
  const wxs = f64x2.mul(nxv, wfv), wys = f64x2.mul(nyv, wfv), wzs = f64x2.mul(nzv, wfv);
  const wxv = simplex3x2(sfPW,
    f64x2.add(wxs, f64x2.splat(sfOW0)), f64x2.add(wys, f64x2.splat(sfOW1)), f64x2.add(wzs, f64x2.splat(sfOW2)));
  const wyv = simplex3x2(sfPW,
    f64x2.add(wxs, f64x2.splat(sfOW1)), f64x2.add(wys, f64x2.splat(sfOW2)), f64x2.add(wzs, f64x2.splat(sfOW0)));
  const wzv = simplex3x2(sfPW,
    f64x2.add(wxs, f64x2.splat(sfOW2)), f64x2.add(wys, f64x2.splat(sfOW0)), f64x2.add(wzs, f64x2.splat(sfOW1)));
  const wxA = lane0(wxv), wyA = lane0(wyv), wzA = lane0(wzv);
  const wxB = lane1(wxv), wyB = lane1(wyv), wzB = lane1(wzv);
  const alongA = wxA * nxA + wyA * nyA + wzA * nzA;
  const alongB = wxB * nxB + wyB * nyB + wzB * nzB;
  let dxA = nxA + (wxA - alongA * nxA) * sfWarpAmp;
  let dyA = nyA + (wyA - alongA * nyA) * sfWarpAmp;
  let dzA = nzA + (wzA - alongA * nzA) * sfWarpAmp;
  let dxB = nxB + (wxB - alongB * nxB) * sfWarpAmp;
  let dyB = nyB + (wyB - alongB * nyB) * sfWarpAmp;
  let dzB = nzB + (wzB - alongB * nzB) * sfWarpAmp;
  let dlenA = Math.sqrt(dxA * dxA + dyA * dyA + dzA * dzA);
  if (dlenA == 0.0) dlenA = 1.0;
  let dlenB = Math.sqrt(dxB * dxB + dyB * dyB + dzB * dzB);
  if (dlenB == 0.0) dlenB = 1.0;
  dxA /= dlenA; dyA /= dlenA; dzA /= dlenA;
  dxB /= dlenB; dyB /= dlenB; dzB /= dlenB;
  const dxv = pack2(dxA, dxB), dyv = pack2(dyA, dyB), dzv = pack2(dzA, dzB);
  const plate = simplexFbmX2(sfPP,
    f64x2.add(f64x2.mul(nxv, f64x2.splat(1.12)), f64x2.splat(sfOP0)),
    f64x2.add(f64x2.mul(nyv, f64x2.splat(1.12)), f64x2.splat(sfOP1)),
    f64x2.add(f64x2.mul(nzv, f64x2.splat(1.12)), f64x2.splat(sfOP2)), 3, 2.0, 0.52);
  const base = simplexFbmX2(sfPE,
    f64x2.add(f64x2.mul(dxv, f64x2.splat(sfElevationFreq)), f64x2.splat(sfOE0)),
    f64x2.add(f64x2.mul(dyv, f64x2.splat(sfElevationFreq)), f64x2.splat(sfOE1)),
    f64x2.add(f64x2.mul(dzv, f64x2.splat(sfElevationFreq)), f64x2.splat(sfOE2)), 5, 2.0, 0.5);
  const detail = simplexFbmX2(sfPD,
    f64x2.add(f64x2.mul(dxv, f64x2.splat(sfDetailFreq)), f64x2.splat(sfOD0)),
    f64x2.add(f64x2.mul(dyv, f64x2.splat(sfDetailFreq)), f64x2.splat(sfOD1)),
    f64x2.add(f64x2.mul(dzv, f64x2.splat(sfDetailFreq)), f64x2.splat(sfOD2)), 3, 2.0, 0.55);
  const moistureRaw = simplexFbmX2(sfPM,
    f64x2.add(f64x2.mul(dxv, f64x2.splat(sfMoistureFreq)), f64x2.splat(sfOM0)),
    f64x2.add(f64x2.mul(dyv, f64x2.splat(sfMoistureFreq)), f64x2.splat(sfOM1)),
    f64x2.add(f64x2.mul(dzv, f64x2.splat(sfMoistureFreq)), f64x2.splat(sfOM2)), 4, 2.0, 0.5);
  const tempAnomaly = simplex3x2(sfPT,
    f64x2.add(f64x2.mul(nxv, f64x2.splat(sfTempFreq)), f64x2.splat(sfOT0)),
    f64x2.add(f64x2.mul(nyv, f64x2.splat(sfTempFreq)), f64x2.splat(sfOT1)),
    f64x2.add(f64x2.mul(nzv, f64x2.splat(sfTempFreq)), f64x2.splat(sfOT2)));
  const volcRaw = simplexFbmX2(sfPV,
    f64x2.add(f64x2.mul(nxv, f64x2.splat(sfVolcFreq)), f64x2.splat(sfOV0)),
    f64x2.add(f64x2.mul(nyv, f64x2.splat(sfVolcFreq)), f64x2.splat(sfOV1)),
    f64x2.add(f64x2.mul(nzv, f64x2.splat(sfVolcFreq)), f64x2.splat(sfOV2)), 3, 2.0, 0.55);
  sampleStoreCell(c, lane0(plate), lane0(base), lane0(detail), lane0(moistureRaw), lane0(tempAnomaly), nyA, lane0(volcRaw));
  sampleStoreCell(c + 1, lane1(plate), lane1(base), lane1(detail), lane1(moistureRaw), lane1(tempAnomaly), nyB, lane1(volcRaw));
}

export function sampleFieldsBatch(tables: usize, params: usize, centers: usize, out: usize, volcPreOut: usize, count: i32): void {
  const ratio = load<f64>(params);
  const climateRatio = load<f64>(params + 8);
  sfPE = tables; sfPM = tables + 1024; sfPT = tables + 2048; sfPP = tables + 3072;
  sfPV = tables + 4096; sfPD = tables + 5120; sfPW = tables + 6144;
  const oE = params + 16, oM = params + 40, oT = params + 64, oP = params + 88;
  const oV = params + 112, oD = params + 136, oW = params + 160;
  sfOE0 = load<f64>(oE); sfOE1 = load<f64>(oE + 8); sfOE2 = load<f64>(oE + 16);
  sfOM0 = load<f64>(oM); sfOM1 = load<f64>(oM + 8); sfOM2 = load<f64>(oM + 16);
  sfOT0 = load<f64>(oT); sfOT1 = load<f64>(oT + 8); sfOT2 = load<f64>(oT + 16);
  sfOP0 = load<f64>(oP); sfOP1 = load<f64>(oP + 8); sfOP2 = load<f64>(oP + 16);
  sfOV0 = load<f64>(oV); sfOV1 = load<f64>(oV + 8); sfOV2 = load<f64>(oV + 16);
  sfOD0 = load<f64>(oD); sfOD1 = load<f64>(oD + 8); sfOD2 = load<f64>(oD + 16);
  sfOW0 = load<f64>(oW); sfOW1 = load<f64>(oW + 8); sfOW2 = load<f64>(oW + 16);
  sfWarpFreq = 0.85 * ratio;
  sfWarpAmp = 0.14 / Math.max(0.25, ratio);
  sfElevationFreq = 2.15 * ratio;
  sfDetailFreq = 9.0 * ratio;
  sfMoistureFreq = 2.9 * climateRatio;
  sfTempFreq = 1.7 * climateRatio;
  sfVolcFreq = 3.6 * ratio;
  sfCenters = centers; sfOut = out; sfVolcPreOut = volcPreOut;
  let c = 0;
  for (; c + 1 < count; c += 2) sampleCellPair(c);
  if (c < count) sampleCellScalar(c);
}
