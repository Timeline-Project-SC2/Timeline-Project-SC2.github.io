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

@inline function simplex3(table: usize, xin: f64, yin: f64, zin: f64): f64 {
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

@inline function simplexFbm(table: usize, x: f64, y: f64, z: f64, octaves: i32, lacunarity: f64, gain: f64): f64 {
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
  const grad = GRAD;
  const zero = f64x2.splat(0.0);
  const c06 = f64x2.splat(0.6);

  const gi0A = usize(load<u8>(pm + usize(iiA + i32(load<u8>(table + usize(jjA + i32(load<u8>(table + usize(kkA))))))))) * 24;
  const gi0B = usize(load<u8>(pm + usize(iiB + i32(load<u8>(table + usize(jjB + i32(load<u8>(table + usize(kkB))))))))) * 24;
  let t0v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x0v, x0v)), f64x2.mul(y0v, y0v)), f64x2.mul(z0v, z0v));
  const t0raw = t0v;
  t0v = f64x2.mul(t0v, t0v);
  let n0v = f64x2.mul(f64x2.mul(t0v, t0v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(grad + gi0A), load<f64>(grad + gi0B)), x0v),
    f64x2.mul(pack2(load<f64>(grad + gi0A + 8), load<f64>(grad + gi0B + 8)), y0v)),
    f64x2.mul(pack2(load<f64>(grad + gi0A + 16), load<f64>(grad + gi0B + 16)), z0v)));
  n0v = v128.bitselect(zero, n0v, f64x2.lt(t0raw, zero));

  const gi1A = usize(load<u8>(pm + usize(iiA + i1A + i32(load<u8>(table + usize(jjA + j1A + i32(load<u8>(table + usize(kkA + k1A))))))))) * 24;
  const gi1B = usize(load<u8>(pm + usize(iiB + i1B + i32(load<u8>(table + usize(jjB + j1B + i32(load<u8>(table + usize(kkB + k1B))))))))) * 24;
  let t1v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x1v, x1v)), f64x2.mul(y1v, y1v)), f64x2.mul(z1v, z1v));
  const t1raw = t1v;
  t1v = f64x2.mul(t1v, t1v);
  let n1v = f64x2.mul(f64x2.mul(t1v, t1v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(grad + gi1A), load<f64>(grad + gi1B)), x1v),
    f64x2.mul(pack2(load<f64>(grad + gi1A + 8), load<f64>(grad + gi1B + 8)), y1v)),
    f64x2.mul(pack2(load<f64>(grad + gi1A + 16), load<f64>(grad + gi1B + 16)), z1v)));
  n1v = v128.bitselect(zero, n1v, f64x2.lt(t1raw, zero));

  const gi2A = usize(load<u8>(pm + usize(iiA + i2A + i32(load<u8>(table + usize(jjA + j2A + i32(load<u8>(table + usize(kkA + k2A))))))))) * 24;
  const gi2B = usize(load<u8>(pm + usize(iiB + i2B + i32(load<u8>(table + usize(jjB + j2B + i32(load<u8>(table + usize(kkB + k2B))))))))) * 24;
  let t2v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x2v, x2v)), f64x2.mul(y2v, y2v)), f64x2.mul(z2v, z2v));
  const t2raw = t2v;
  t2v = f64x2.mul(t2v, t2v);
  let n2v = f64x2.mul(f64x2.mul(t2v, t2v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(grad + gi2A), load<f64>(grad + gi2B)), x2v),
    f64x2.mul(pack2(load<f64>(grad + gi2A + 8), load<f64>(grad + gi2B + 8)), y2v)),
    f64x2.mul(pack2(load<f64>(grad + gi2A + 16), load<f64>(grad + gi2B + 16)), z2v)));
  n2v = v128.bitselect(zero, n2v, f64x2.lt(t2raw, zero));

  const gi3A = usize(load<u8>(pm + usize(iiA + 1 + i32(load<u8>(table + usize(jjA + 1 + i32(load<u8>(table + usize(kkA + 1))))))))) * 24;
  const gi3B = usize(load<u8>(pm + usize(iiB + 1 + i32(load<u8>(table + usize(jjB + 1 + i32(load<u8>(table + usize(kkB + 1))))))))) * 24;
  let t3v = f64x2.sub(f64x2.sub(f64x2.sub(c06, f64x2.mul(x3v, x3v)), f64x2.mul(y3v, y3v)), f64x2.mul(z3v, z3v));
  const t3raw = t3v;
  t3v = f64x2.mul(t3v, t3v);
  let n3v = f64x2.mul(f64x2.mul(t3v, t3v), f64x2.add(f64x2.add(
    f64x2.mul(pack2(load<f64>(grad + gi3A), load<f64>(grad + gi3B)), x3v),
    f64x2.mul(pack2(load<f64>(grad + gi3A + 8), load<f64>(grad + gi3B + 8)), y3v)),
    f64x2.mul(pack2(load<f64>(grad + gi3A + 16), load<f64>(grad + gi3B + 16)), z3v)));
  n3v = v128.bitselect(zero, n3v, f64x2.lt(t3raw, zero));

  return f64x2.mul(f64x2.splat(32.0), f64x2.add(f64x2.add(f64x2.add(n0v, n1v), n2v), n3v));
}

@inline function simplexFbmX2(table: usize, xv: v128, yv: v128, zv: v128, octaves: i32, lacunarity: f64, gain: f64): v128 {
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
let sfCenters: usize = 0, sfOut: usize = 0, sfVolcPreOut: usize = 0, sfIsF32: bool = false;

@inline function sampleStoreCell(c: i32, plate: f64, base: f64, detail: f64,
  moistureRaw: f64, tempAnomaly: f64, ny: f64, volcRaw: f64): void {
  // W28: идентично site/shared/planet-geography.ts — контраст поля.
  const rawElev = 0.74 * base + 0.30 * plate + 0.10 * detail;
  let elevation = rawElev;
  if (rawElev > 0.40) {
    const d = rawElev - 0.40;
    elevation = rawElev + 5.0 * d * d;
  } else if (rawElev < 0.12) {
    const d = 0.12 - rawElev;
    elevation = rawElev - 0.65 * d;
  }
  elevation = clampd(elevation, -1.0, 1.0);
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

@inline function sampleCellScalar(c: i32): void {
  let x: f64, y: f64, z: f64;
  if (sfIsF32) {
    const ci = sfCenters + usize(c * 12);
    x = f64(load<f32>(ci)); y = f64(load<f32>(ci + 4)); z = f64(load<f32>(ci + 8));
  } else {
    const ci = sfCenters + usize(c * 24);
    x = load<f64>(ci); y = load<f64>(ci + 8); z = load<f64>(ci + 16);
  }
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

@inline function sampleCellPair(c: i32): void {
  let xA: f64, yA: f64, zA: f64, xB: f64, yB: f64, zB: f64;
  if (sfIsF32) {
    const ciA = sfCenters + usize(c * 12);
    xA = f64(load<f32>(ciA)); yA = f64(load<f32>(ciA + 4)); zA = f64(load<f32>(ciA + 8));
    xB = f64(load<f32>(ciA + 12)); yB = f64(load<f32>(ciA + 16)); zB = f64(load<f32>(ciA + 20));
  } else {
    const ciA = sfCenters + usize(c * 24);
    xA = load<f64>(ciA); yA = load<f64>(ciA + 8); zA = load<f64>(ciA + 16);
    xB = load<f64>(ciA + 24); yB = load<f64>(ciA + 32); zB = load<f64>(ciA + 40);
  }
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
  sfIsF32 = count < 0;
  if (sfIsF32) count = -count;
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
  const pairEnd = count & ~1;
  while (c < pairEnd) { sampleCellPair(c); c += 2; }
  if (c < count) sampleCellScalar(c);
}

// ------------------------------------------------------------- radix order
// Стабильная сортировка массива индексов order[] по значениям
// values[order[i]]. Host заполняет order начальным порядком (обычно
// возрастающие индексы или отфильтрованный список); стабильность даёт
// tie-break по исходной позиции — эквивалентно JS Array.sort со
// сравнением (values[a]-values[b] || a-b) на возрастающем списке.

@inline function keyF32(v: f32, descending: i32): u32 {
  let bits = reinterpret<u32>(v);
  if (bits == 0x80000000) bits = 0; // -0 равен +0 в JS-сравнении разностью
  let k = bits ^ ((bits & 0x80000000) != 0 ? 0xffffffff : 0x80000000);
  if (descending) k = ~k;
  return k;
}

export function radixOrderF32(values: usize, order: usize, tmp: usize, counts: usize, count: i32, descending: i32): void {
  let src = order, dst = tmp;
  for (let pass = 0; pass < 4; pass++) {
    memory.fill(counts, 0, 1024);
    const shift = pass * 8;
    for (let i = 0; i < count; i++) {
      const idx = load<u32>(src + usize(i * 4));
      const digit = (keyF32(load<f32>(values + usize(idx * 4)), descending) >> shift) & 255;
      const cp = counts + usize(digit * 4);
      store<u32>(cp, load<u32>(cp) + 1);
    }
    let running: u32 = 0;
    for (let d = 0; d < 256; d++) {
      const cp = counts + usize(d * 4);
      const n = load<u32>(cp);
      store<u32>(cp, running);
      running += n;
    }
    for (let i = 0; i < count; i++) {
      const idx = load<u32>(src + usize(i * 4));
      const digit = (keyF32(load<f32>(values + usize(idx * 4)), descending) >> shift) & 255;
      const cp = counts + usize(digit * 4);
      const pos = load<u32>(cp);
      store<u32>(cp, pos + 1);
      store<u32>(dst + usize(pos * 4), idx);
    }
    const swap = src; src = dst; dst = swap;
  }
}

@inline function keyF64(v: f64, descending: i32): u64 {
  let bits = reinterpret<u64>(v);
  if (bits == 0x8000000000000000) bits = 0;
  let k = bits ^ ((bits & 0x8000000000000000) != 0 ? 0xffffffffffffffff : 0x8000000000000000);
  if (descending) k = ~k;
  return k;
}

export function radixOrderF64(values: usize, order: usize, tmp: usize, counts: usize, count: i32, descending: i32): void {
  let src = order, dst = tmp;
  for (let pass = 0; pass < 8; pass++) {
    memory.fill(counts, 0, 1024);
    const shift = u64(pass * 8);
    for (let i = 0; i < count; i++) {
      const idx = load<u32>(src + usize(i * 4));
      const digit = u32((keyF64(load<f64>(values + usize(idx * 8)), descending) >> shift) & 255);
      const cp = counts + usize(digit * 4);
      store<u32>(cp, load<u32>(cp) + 1);
    }
    let running: u32 = 0;
    for (let d = 0; d < 256; d++) {
      const cp = counts + usize(d * 4);
      const n = load<u32>(cp);
      store<u32>(cp, running);
      running += n;
    }
    for (let i = 0; i < count; i++) {
      const idx = load<u32>(src + usize(i * 4));
      const digit = u32((keyF64(load<f64>(values + usize(idx * 8)), descending) >> shift) & 255);
      const cp = counts + usize(digit * 4);
      const pos = load<u32>(cp);
      store<u32>(cp, pos + 1);
      store<u32>(dst + usize(pos * 4), idx);
    }
    const swap = src; src = dst; dst = swap;
  }
}

// ------------------------------------------------------------------ heap
// 4-арная min-куча с перемежающимися записями по 16 Б (dist f64, cell i32,
// label i32): четверо детей узла лежат в одной кэш-линии, глубина вдвое
// меньше бинарной. Порядок извлечения — текущий минимум по (key, cell),
// как у бинарной кучи со строгим tie-break И-2: пары (key, cell) у всех
// потребителей уникальны (Дейкстра пушит только при строгом улучшении,
// priority-flood — каждую ячейку один раз), поэтому последовательность
// pop'ов не зависит от формы кучи. heapLabelPtr == 0 — вариант без меток
// (priority-flood/coast): label не пишется и не читается.
// Radix-куча на связных списках здесь проиграла бинарной: при плотных
// f64-ключах перераспределение бакетов превращается в pointer-chasing
// (проверено микробенчем и CPU-профилем).

let heapRecPtr: usize = 0;
let heapLabelPtr: usize = 0;
let heapSize: i32 = 0;
let heapCap: i32 = 0;
let heapOverflow: bool = false;
let heapOutDist: f64 = 0;
let heapOutCell: i32 = -1;
let heapOutLabel: i32 = -1;

// Диспетчер приоритетной очереди для Дейкстр: куча (pqDial=false) или
// Dial-бакеты (pqDial=true). pqFail: 0 — ok, 1 — переполнение (host
// повторяет с большей ёмкостью), 2 — нарушено предусловие Dial
// (host навсегда откатывается на кучу для этого ядра).
let pqDial: bool = false;
let pqFail: i32 = 0;

// Совместимый интерфейс с ядрами: используется только recPtr (16 Б/запись)
// и флаг labelPtr != 0; остальные буферы больше не нужны.
function heapInit(
  recPtr: usize, cellPtr: usize, labelPtr: usize, nextPtr: usize,
  bucketPtr: usize, b0CellPtr: usize, b0LabelPtr: usize, cap: i32,
): void {
  heapRecPtr = recPtr;
  heapLabelPtr = labelPtr;
  heapSize = 0;
  heapCap = cap;
  heapOverflow = false;
  pqDial = false;
  pqFail = 0;
}

@inline function heapRec(i: i32): usize { return heapRecPtr + usize(i * 16); }

@inline function heapPush(dist: f64, cell: i32, label: i32): void {
  if (heapSize >= heapCap) { heapOverflow = true; return; }
  let i = heapSize++;
  while (i > 0) {
    const parent = (i - 1) >> 2;
    const pP = heapRec(parent);
    const dp = load<f64>(pP);
    const cp = load<i32>(pP + 8);
    if (dp < dist || (dp == dist && cp <= cell)) break;
    const pI = heapRec(i);
    store<f64>(pI, dp);
    store<u64>(pI + 8, load<u64>(pP + 8));
    i = parent;
  }
  const pI = heapRec(i);
  store<f64>(pI, dist);
  store<i32>(pI + 8, cell);
  store<i32>(pI + 12, label);
}

@inline function heapPop(): bool {
  if (heapSize == 0) return false;
  heapOutDist = load<f64>(heapRecPtr);
  heapOutCell = load<i32>(heapRecPtr + 8);
  heapOutLabel = heapLabelPtr ? load<i32>(heapRecPtr + 12) : -1;
  heapSize--;
  if (heapSize == 0) return true;
  const pLast = heapRec(heapSize);
  const dLast = load<f64>(pLast);
  const cLast = load<i32>(pLast + 8);
  const clLast = load<u64>(pLast + 8);
  let i = 0;
  for (;;) {
    const first = (i << 2) + 1;
    if (first >= heapSize) break;
    let smallest = first;
    let pS = heapRec(first);
    let dS = load<f64>(pS);
    let cS = load<i32>(pS + 8);
    const lastChild = first + 3 < heapSize ? first + 3 : heapSize - 1;
    for (let ch = first + 1; ch <= lastChild; ch++) {
      const pCh = heapRec(ch);
      const dCh = load<f64>(pCh);
      const cCh = load<i32>(pCh + 8);
      if (dCh < dS || (dCh == dS && cCh < cS)) {
        smallest = ch;
        pS = pCh;
        dS = dCh;
        cS = cCh;
      }
    }
    if (dLast < dS || (dLast == dS && cLast <= cS)) break;
    const pI = heapRec(i);
    store<f64>(pI, dS);
    store<u64>(pI + 8, load<u64>(pS + 8));
    i = smallest;
  }
  const pI = heapRec(i);
  store<f64>(pI, dLast);
  store<u64>(pI + 8, clLast);
  return true;
}

// ------------------------------------------------------------- Dial PQ
// Dial-бакеты шириной 1.0 для Дейкстр: стоимости рёбер edgeCosts >= 1.0
// по построению (база 1.0 + неотрицательные слагаемые; plateBoundary —
// clamp01), поэтому push всегда попадает в бакет строго позже текущего
// обслуживаемого, а внутри бакета порядок (key, cell) восстанавливается
// сортировкой при активации. Последовательность pop'ов совпадает с
// кучей (key, cell) при уникальных парах. Нарушение предусловия
// (бакет <= обслуживаемого, выход за диапазон) — pqFail=2, host
// повторяет запуск кучей с полной переинициализацией выходов.
// Хранение: пул блоков по DIAL_BS записей, списки блоков на бакет;
// активация собирает бакет в sort-массивы и сортирует индексную
// перестановку LSD-radix'ом (cell, затем монотонный ключ f64).

const DIAL_BS: i32 = 32;

export function dialBlockSize(): i32 { return DIAL_BS; }

let dMeta: usize = 0;
let dBuckets: i32 = 0;
let dPoolK: usize = 0, dPoolC: usize = 0, dPoolL: usize = 0;
let dBlockNext: usize = 0;
let dBlocksCap: i32 = 0;
let dSortK: usize = 0, dSortC: usize = 0, dSortL: usize = 0;
let dSortIdx: usize = 0, dSortAux: usize = 0, dCnt: usize = 0;
let dSortCap: i32 = 0;
let dOrigin: f64 = 0;
let dSize: i32 = 0;
let dFreeBlock: i32 = -1;
let dNextBlock: i32 = 0;
let dServed: i32 = -1;
let dMaxBucket: i32 = -1;
let dActiveCount: i32 = 0;
let dActivePos: i32 = 0;

function dialInit(
  meta: usize, nBuckets: i32, poolK: usize, poolC: usize, poolL: usize,
  blockNext: usize, nBlocks: i32,
  sortK: usize, sortC: usize, sortL: usize,
  sortIdx: usize, sortAux: usize, cnt: usize, sortCap: i32, origin: f64,
): void {
  dMeta = meta; dBuckets = nBuckets;
  dPoolK = poolK; dPoolC = poolC; dPoolL = poolL;
  dBlockNext = blockNext; dBlocksCap = nBlocks;
  dSortK = sortK; dSortC = sortC; dSortL = sortL;
  dSortIdx = sortIdx; dSortAux = sortAux; dCnt = cnt; dSortCap = sortCap;
  dOrigin = origin;
  dSize = 0;
  dFreeBlock = -1;
  dNextBlock = 0;
  dServed = -1;
  dMaxBucket = -1;
  dActiveCount = 0;
  dActivePos = 0;
  pqDial = true;
  pqFail = 0;
  memory.fill(meta, 0xff, usize(nBuckets * 8));
  memory.fill(meta + usize(nBuckets * 8), 0, usize(nBuckets * 4));
}

@inline function dialHead(b: i32): i32 { return load<i32>(dMeta + usize(b * 4)); }
@inline function dialTail(b: i32): i32 { return load<i32>(dMeta + usize((dBuckets + b) * 4)); }
@inline function dialFill(b: i32): i32 { return load<i32>(dMeta + usize((2 * dBuckets + b) * 4)); }
@inline function dialSetHead(b: i32, v: i32): void { store<i32>(dMeta + usize(b * 4), v); }
@inline function dialSetTail(b: i32, v: i32): void { store<i32>(dMeta + usize((dBuckets + b) * 4), v); }
@inline function dialSetFill(b: i32, v: i32): void { store<i32>(dMeta + usize((2 * dBuckets + b) * 4), v); }

@inline function dialPush(dist: f64, cell: i32, label: i32): void {
  const rel = (dist - dOrigin) * 8.0;
  const b = i32(rel);
  if (!(rel >= 0) || b <= dServed || b >= dBuckets) { pqFail = 2; return; }
  if (b > dMaxBucket) dMaxBucket = b;
  let tail = dialTail(b);
  let fill = dialFill(b);
  if (tail < 0 || fill == DIAL_BS) {
    let nb: i32;
    if (dFreeBlock >= 0) {
      nb = dFreeBlock;
      dFreeBlock = load<i32>(dBlockNext + usize(nb * 4));
    } else if (dNextBlock < dBlocksCap) {
      nb = dNextBlock++;
    } else {
      pqFail = 1;
      return;
    }
    store<i32>(dBlockNext + usize(nb * 4), -1);
    if (tail < 0) dialSetHead(b, nb);
    else store<i32>(dBlockNext + usize(tail * 4), nb);
    tail = nb;
    fill = 0;
    dialSetTail(b, tail);
  }
  const idx = tail * DIAL_BS + fill;
  store<f64>(dPoolK + usize(idx * 8), dist);
  store<u64>(dPoolC + usize(idx * 8), (u64(u32(cell)) << 32) | u64(u32(label)));
  dialSetFill(b, fill + 1);
  dSize++;
}

@inline function dialMonoKey(d: f64): u64 {
  let bits = reinterpret<u64>(d);
  if (bits == 0x8000000000000000) bits = 0; // -0 == +0
  return (bits & 0x8000000000000000) != 0 ? ~bits : (bits | 0x8000000000000000);
}

function dialGatherSort(b: i32): void {
  let blk = dialHead(b);
  const tailB = dialTail(b);
  const tailFill = dialFill(b);
  dialSetHead(b, -1);
  dialSetTail(b, -1);
  dialSetFill(b, 0);
  let m = 0;
  while (blk >= 0) {
    const next = load<i32>(dBlockNext + usize(blk * 4));
    const lim = blk == tailB ? tailFill : DIAL_BS;
    if (m + lim > dSortCap) { pqFail = 1; dActiveCount = 0; dActivePos = 0; return; }
    const start = blk * DIAL_BS;
    memory.copy(dSortK + usize(m * 8), dPoolK + usize(start * 8), usize(lim * 8));
    memory.copy(dSortC + usize(m * 8), dPoolC + usize(start * 8), usize(lim * 8));
    m += lim;
    store<i32>(dBlockNext + usize(blk * 4), dFreeBlock);
    dFreeBlock = blk;
    blk = next;
  }
  if (m <= 1) {
    dActiveCount = m;
    dActivePos = 0;
    return;
  }
  const RUN: i32 = 32;
  for (let start = 0; start < m; start += RUN) {
    let end = start + RUN;
    if (end > m) end = m;
    for (let i = start + 1; i < end; i++) {
      const kv = load<f64>(dSortK + usize(i * 8));
      const clv = load<u64>(dSortC + usize(i * 8));
      const cv = i32(clv >> 32);
      let j = i - 1;
      while (j >= start) {
        const ku = load<f64>(dSortK + usize(j * 8));
        const clu = load<u64>(dSortC + usize(j * 8));
        if (ku < kv || (ku == kv && i32(clu >> 32) <= cv)) break;
        store<f64>(dSortK + usize((j + 1) * 8), ku);
        store<u64>(dSortC + usize((j + 1) * 8), clu);
        j--;
      }
      store<f64>(dSortK + usize((j + 1) * 8), kv);
      store<u64>(dSortC + usize((j + 1) * 8), clv);
    }
  }
  if (m > RUN) {
    let srcK = dSortK, dstK = dSortL;
    let srcCL = dSortC, dstCL = dSortAux;
    for (let width: i32 = RUN; width < m; width <<= 1) {
      for (let lo: i32 = 0; lo < m; lo += width << 1) {
        let mid = lo + width;
        if (mid > m) mid = m;
        let hi = lo + (width << 1);
        if (hi > m) hi = m;
        let p = lo, q = mid, k = lo;
        while (p < mid && q < hi) {
          const ku = load<f64>(srcK + usize(p * 8));
          const kv = load<f64>(srcK + usize(q * 8));
          const clu = load<u64>(srcCL + usize(p * 8));
          const clv = load<u64>(srcCL + usize(q * 8));
          if (ku < kv || (ku == kv && i32(clu >> 32) <= i32(clv >> 32))) {
            store<f64>(dstK + usize(k * 8), ku);
            store<u64>(dstCL + usize(k * 8), clu);
            p++;
          } else {
            store<f64>(dstK + usize(k * 8), kv);
            store<u64>(dstCL + usize(k * 8), clv);
            q++;
          }
          k++;
        }
        while (p < mid) {
          store<f64>(dstK + usize(k * 8), load<f64>(srcK + usize(p * 8)));
          store<u64>(dstCL + usize(k * 8), load<u64>(srcCL + usize(p * 8)));
          p++; k++;
        }
        while (q < hi) {
          store<f64>(dstK + usize(k * 8), load<f64>(srcK + usize(q * 8)));
          store<u64>(dstCL + usize(k * 8), load<u64>(srcCL + usize(q * 8)));
          q++; k++;
        }
      }
      const swapK = srcK; srcK = dstK; dstK = swapK;
      const swapCL = srcCL; srcCL = dstCL; dstCL = swapCL;
    }
    if (srcK != dSortK) {
      memory.copy(dSortK, srcK, usize(m * 8));
      memory.copy(dSortC, srcCL, usize(m * 8));
    }
  }
  dActiveCount = m;
  dActivePos = 0;
}

@inline function dialPop(): bool {
  while (dActivePos >= dActiveCount) {
    if (dSize == 0) return false;
    let b = dServed + 1;
    while (b <= dMaxBucket && dialHead(b) < 0) b++;
    if (b > dMaxBucket) { pqFail = 2; return false; }
    dServed = b;
    dialGatherSort(b);
    if (pqFail) return false;
  }
  const idx = dActivePos++;
  heapOutDist = load<f64>(dSortK + usize(idx * 8));
  const cl = load<u64>(dSortC + usize(idx * 8));
  heapOutCell = i32(cl >> 32);
  heapOutLabel = i32(cl);
  dSize--;
  return true;
}

@inline function pqPush(dist: f64, cell: i32, label: i32): void {
  if (pqDial) dialPush(dist, cell, label);
  else {
    heapPush(dist, cell, label);
    if (heapOverflow) pqFail = 1;
  }
}

@inline function pqPop(): bool {
  return pqDial ? dialPop() : heapPop();
}

// ------------------------------------------------------------- edge costs
// Точная копия buildEdgeCosts/computeEdgeCost из planet-geography.
// Результат пишется в f32 — округление как у JS Float32Array.

export function edgeCosts(
  neighbors: usize, neighborCount: usize,
  elevation: usize, temperature: usize, moisture: usize,
  plateId: usize, plateBoundary: usize, support: usize,
  plateCross: f64, out: usize, count: i32
): void {
  for (let c = 0; c < count; c++) {
    const base = c * 6;
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const eA = f64(load<f32>(elevation + usize(c * 4)));
    const tA = f64(load<f32>(temperature + usize(c * 4)));
    const mA = f64(load<f32>(moisture + usize(c * 4)));
    const pA = load<i32>(plateId + usize(c * 4));
    const pbA = f64(load<f32>(plateBoundary + usize(c * 4)));
    const sA = f64(load<f32>(support + usize(c * 4)));
    for (let n = 0; n < nc; n++) {
      const nb = load<i32>(neighbors + usize((base + n) * 4));
      const eB = f64(load<f32>(elevation + usize(nb * 4)));
      const elevCost = Math.min(1.0, Math.abs(eA - eB) * 8.0);
      const climateCost = 0.35 * Math.abs(tA - f64(load<f32>(temperature + usize(nb * 4)))) +
        0.25 * Math.abs(mA - f64(load<f32>(moisture + usize(nb * 4))));
      const pbB = f64(load<f32>(plateBoundary + usize(nb * 4)));
      const plateCost = pA != load<i32>(plateId + usize(nb * 4))
        ? plateCross + 0.35 * (pbA + pbB)
        : 0.08 * (pbA + pbB);
      const sMin = Math.min(sA, f64(load<f32>(support + usize(nb * 4))));
      const barrier = 3.2 * Math.max(0.0, 0.65 - sMin);
      store<f32>(out + usize((base + n) * 4), f32(1.0 + elevCost + climateCost + plateCost + barrier));
    }
  }
}

// ------------------------------------------------------------- dijkstra
// Тела runTopOne/runTopTwo из planet-geography на pq-диспетчере: куча и
// Dial дают одинаковую последовательность pop'ов (см. Dial PQ выше).

export function dijkstraTopOne(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  labelOut: usize, distScratch: usize,
  heapDist: usize, heapCell: usize, heapLabel: usize, heapNext: usize,
  heapBuckets: usize, heapB0Cell: usize, heapB0Label: usize, heapCapIn: i32
): i32 {
  heapInit(heapDist, heapCell, heapLabel, heapNext, heapBuckets, heapB0Cell, heapB0Label, heapCapIn);
  return topOneBody(neighbors, neighborCount, costs, seeds, biases, seedCount, count, labelOut, distScratch);
}

export function dialTopOne(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  labelOut: usize, distScratch: usize,
  dialMeta: usize, nBuckets: i32, poolK: usize, poolC: usize, poolL: usize,
  blockNext: usize, nBlocks: i32,
  sortK: usize, sortC: usize, sortL: usize,
  sortIdx: usize, sortAux: usize, cnt: usize, sortCap: i32
): i32 {
  let origin: f64 = 0;
  if (seedCount > 0) {
    let minD0: f64 = Infinity;
    for (let s2 = 0; s2 < seedCount; s2++) {
      const d0 = -load<f64>(biases + usize(s2 * 8));
      if (d0 < minD0) minD0 = d0;
    }
    origin = Math.floor(minD0);
  }
  dialInit(dialMeta, nBuckets, poolK, poolC, poolL, blockNext, nBlocks,
    sortK, sortC, sortL, sortIdx, sortAux, cnt, sortCap, origin);
  return topOneBody(neighbors, neighborCount, costs, seeds, biases, seedCount, count, labelOut, distScratch);
}

function topOneBody(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  labelOut: usize, distScratch: usize
): i32 {
  memory.fill(labelOut, 0xff, usize(count * 4));
  for (let c = 0; c < count; c++) {
    store<f64>(distScratch + usize(c * 8), Infinity);
  }
  for (let s = 0; s < seedCount; s++) {
    const seedCell = load<i32>(seeds + usize(s * 4));
    const d0 = -load<f64>(biases + usize(s * 8));
    store<i32>(labelOut + usize(seedCell * 4), s);
    store<f64>(distScratch + usize(seedCell * 8), d0);
    pqPush(d0, seedCell, s);
    if (pqFail) return pqFail;
  }
  while (pqPop()) {
    const cell = heapOutCell;
    const currentLabel = heapOutLabel;
    const currentDist = heapOutDist;
    if (load<i32>(labelOut + usize(cell * 4)) != currentLabel) continue;
    if (Math.abs(load<f64>(distScratch + usize(cell * 8)) - currentDist) > 1e-12) continue;
    const nc = i32(load<u8>(neighborCount + usize(cell)));
    const base = cell * 6;
    for (let n = 0; n < nc; n++) {
      const eOff = usize((base + n) * 4);
      const nb = load<i32>(neighbors + eOff);
      const candidate = currentDist + f64(load<f32>(costs + eOff));
      if (candidate < load<f64>(distScratch + usize(nb * 8)) - 1e-12) {
        store<f64>(distScratch + usize(nb * 8), candidate);
        store<i32>(labelOut + usize(nb * 4), currentLabel);
        pqPush(candidate, nb, currentLabel);
      }
    }
    if (pqFail) return pqFail;
  }
  if (pqFail) return pqFail;
  return 0;
}

// Состояние runTopTwo (offer — бывшее замыкание JS).
let ttLabel1: usize = 0, ttLabel2: usize = 0, ttDist1: usize = 0, ttDist2: usize = 0;

@inline function ttOffer(cell: i32, label: i32, candidate: f64): void {
  const c4 = usize(cell * 4);
  const c8 = usize(cell * 8);
  const l1 = load<i32>(ttLabel1 + c4);
  if (label == l1) {
    if (candidate < load<f64>(ttDist1 + c8) - 1e-12) {
      store<f64>(ttDist1 + c8, candidate);
      pqPush(candidate, cell, label);
    }
    return;
  }
  const l2 = load<i32>(ttLabel2 + c4);
  if (label == l2) {
    if (candidate < load<f64>(ttDist2 + c8) - 1e-12) {
      store<f64>(ttDist2 + c8, candidate);
      pqPush(candidate, cell, label);
    }
    return;
  }
  const d1 = load<f64>(ttDist1 + c8);
  const d2 = load<f64>(ttDist2 + c8);
  if (candidate < d1) {
    if (l1 >= 0 && d1 < d2) {
      store<i32>(ttLabel2 + c4, l1);
      store<f64>(ttDist2 + c8, d1);
    }
    store<i32>(ttLabel1 + c4, label);
    store<f64>(ttDist1 + c8, candidate);
    pqPush(candidate, cell, label);
  } else if (candidate < d2) {
    store<i32>(ttLabel2 + c4, label);
    store<f64>(ttDist2 + c8, candidate);
    pqPush(candidate, cell, label);
  }
}

export function dijkstraTopTwo(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  label1Out: usize, label2Out: usize, dist1Out: usize, dist2Out: usize,
  heapDist: usize, heapCell: usize, heapLabel: usize, heapNext: usize,
  heapBuckets: usize, heapB0Cell: usize, heapB0Label: usize, heapCapIn: i32
): i32 {
  heapInit(heapDist, heapCell, heapLabel, heapNext, heapBuckets, heapB0Cell, heapB0Label, heapCapIn);
  return topTwoBody(neighbors, neighborCount, costs, seeds, biases, seedCount, count,
    label1Out, label2Out, dist1Out, dist2Out);
}

export function dialTopTwo(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  label1Out: usize, label2Out: usize, dist1Out: usize, dist2Out: usize,
  dialMeta: usize, nBuckets: i32, poolK: usize, poolC: usize, poolL: usize,
  blockNext: usize, nBlocks: i32,
  sortK: usize, sortC: usize, sortL: usize,
  sortIdx: usize, sortAux: usize, cnt: usize, sortCap: i32
): i32 {
  let origin: f64 = 0;
  if (seedCount > 0) {
    let minD0: f64 = Infinity;
    for (let s2 = 0; s2 < seedCount; s2++) {
      const d0 = -load<f64>(biases + usize(s2 * 8));
      if (d0 < minD0) minD0 = d0;
    }
    origin = Math.floor(minD0);
  }
  dialInit(dialMeta, nBuckets, poolK, poolC, poolL, blockNext, nBlocks,
    sortK, sortC, sortL, sortIdx, sortAux, cnt, sortCap, origin);
  return topTwoBody(neighbors, neighborCount, costs, seeds, biases, seedCount, count,
    label1Out, label2Out, dist1Out, dist2Out);
}

function topTwoBody(
  neighbors: usize, neighborCount: usize, costs: usize,
  seeds: usize, biases: usize, seedCount: i32, count: i32,
  label1Out: usize, label2Out: usize, dist1Out: usize, dist2Out: usize
): i32 {
  ttLabel1 = label1Out; ttLabel2 = label2Out; ttDist1 = dist1Out; ttDist2 = dist2Out;
  memory.fill(label1Out, 0xff, usize(count * 4));
  memory.fill(label2Out, 0xff, usize(count * 4));
  for (let c = 0; c < count; c++) {
    store<f64>(dist1Out + usize(c * 8), Infinity);
    store<f64>(dist2Out + usize(c * 8), Infinity);
  }
  for (let s = 0; s < seedCount; s++) {
    const seedCell = load<i32>(seeds + usize(s * 4));
    const d0 = -load<f64>(biases + usize(s * 8));
    store<i32>(label1Out + usize(seedCell * 4), s);
    store<f64>(dist1Out + usize(seedCell * 8), d0);
    pqPush(d0, seedCell, s);
    if (pqFail) return pqFail;
  }
  while (pqPop()) {
    const cell = heapOutCell;
    const label = heapOutLabel;
    const dist = heapOutDist;
    let current: f64;
    if (label == load<i32>(label1Out + usize(cell * 4))) current = load<f64>(dist1Out + usize(cell * 8));
    else if (label == load<i32>(label2Out + usize(cell * 4))) current = load<f64>(dist2Out + usize(cell * 8));
    else continue;
    if (Math.abs(current - dist) > 1e-9) continue;
    const nc = i32(load<u8>(neighborCount + usize(cell)));
    const base = cell * 6;
    for (let n = 0; n < nc; n++) {
      const eOff = usize((base + n) * 4);
      const nb = load<i32>(neighbors + eOff);
      ttOffer(nb, label, dist + f64(load<f32>(costs + eOff)));
    }
    if (pqFail) return pqFail;
  }
  if (pqFail) return pqFail;
  return 0;
}

// --------------------------------------------------------- coast distance
// Точная копия Дейкстры-части computeCoastDistance из planet-geography
// (hardLand и signed собирает host). Возвращает число граничных ячеек
// или -1 при переполнении кучи.

export function coastDistance(
  neighbors: usize, neighborCount: usize, elevation: usize, hardLand: usize,
  seaLevel: f64, count: i32, distOut: usize,
  heapDist: usize, heapCell: usize, heapNext: usize,
  heapBuckets: usize, heapB0Cell: usize, heapCapIn: i32
): i32 {
  heapInit(heapDist, heapCell, 0, heapNext, heapBuckets, heapB0Cell, 0, heapCapIn);
  for (let c = 0; c < count; c++) store<f64>(distOut + usize(c * 8), Infinity);
  let boundaryCount = 0;
  for (let c = 0; c < count; c++) {
    let bestFraction: f64 = Infinity;
    const hc = load<u8>(hardLand + usize(c));
    const eC = f64(load<f32>(elevation + usize(c * 4)));
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const base = c * 6;
    for (let n = 0; n < nc; n++) {
      const nb = load<i32>(neighbors + usize((base + n) * 4));
      if (load<u8>(hardLand + usize(nb)) == hc) continue;
      const denom = Math.abs(eC - f64(load<f32>(elevation + usize(nb * 4))));
      const fraction = denom > 1e-12 ? Math.abs(eC - seaLevel) / denom : 0.5;
      if (fraction < bestFraction) bestFraction = fraction;
    }
    if (bestFraction < Infinity) {
      const d = clampd(bestFraction, 0.0, 1.0);
      store<f64>(distOut + usize(c * 8), d);
      heapPush(d, c, 0);
      if (heapOverflow) return -1;
      boundaryCount++;
    }
  }
  if (boundaryCount == 0) return 0;
  // Все начальные граничные ячейки имеют d в [0, 1], а все последующие шаги
  // прибавляют ровно +1.0. Поэтому куча нужна только для начальных граничных
  // ячеек, а все волны >= 1 идут в монотонную FIFO-очередь (в памяти после кучи).
  const qBase = heapDist + usize((boundaryCount + 2) * 16);
  let qHead: i32 = 0;
  let qTail: i32 = 0;
  while (heapSize > 0 || qHead < qTail) {
    let c: i32;
    let dc: f64;
    if (heapSize > 0) {
      const pTop = heapRec(0);
      const hDist = load<f64>(pTop);
      const hCell = load<i32>(pTop + 8);
      if (qHead < qTail) {
        const qc = load<i32>(qBase + usize(qHead * 4));
        const qd = load<f64>(distOut + usize(qc * 8));
        if (qd < hDist || (qd == hDist && qc < hCell)) {
          qHead++;
          c = qc;
          dc = qd;
        } else {
          heapPop();
          c = heapOutCell;
          dc = heapOutDist;
        }
      } else {
        heapPop();
        c = heapOutCell;
        dc = heapOutDist;
      }
    } else {
      c = load<i32>(qBase + usize(qHead * 4));
      qHead++;
      dc = load<f64>(distOut + usize(c * 8));
    }
    if (Math.abs(load<f64>(distOut + usize(c * 8)) - dc) > 1e-12) continue;
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const base = c * 6;
    const candidate = dc + 1.0;
    for (let n = 0; n < nc; n++) {
      const nb = load<i32>(neighbors + usize((base + n) * 4));
      if (candidate < load<f64>(distOut + usize(nb * 8))) {
        store<f64>(distOut + usize(nb * 8), candidate);
        store<i32>(qBase + usize(qTail * 4), nb);
        qTail++;
      }
    }
  }
  return boundaryCount;
}

// ------------------------------------------------------------ choose seeds
// Жадный farthest-point отбор из chooseSeeds (planet-geography): кандидаты
// уже отфильтрованы, отсортированы по score и урезаны host'ом. desired=0 —
// режим без желаемых масс (objective по хорде). Возвращает число выбранных.

export function chooseSeedsKernel(
  candidates: usize, candCount: i32, centers: usize, score: usize,
  desired: usize, desiredLen: i32, countWant: i32, meanSpacing: f64, maxScore: f64,
  selectedOut: usize, minChord2: usize, minResidual: usize
): i32 {
  const candX = minResidual + usize(candCount * 8);
  const candY = candX + usize(candCount * 8);
  const candZ = candY + usize(candCount * 8);
  const candScoreNorm = candZ + usize(candCount * 8);
  for (let j = 0; j < candCount; j++) {
    const j8 = usize(j * 8);
    store<f64>(minChord2 + j8, Infinity);
    store<f64>(minResidual + j8, Infinity);
    const other = load<i32>(candidates + usize(j * 4));
    const o3 = other * 3;
    store<f64>(candX + j8, f64(load<f32>(centers + usize(o3 * 4))));
    store<f64>(candY + j8, f64(load<f32>(centers + usize((o3 + 1) * 4))));
    store<f64>(candZ + j8, f64(load<f32>(centers + usize((o3 + 2) * 4))));
    store<f64>(candScoreNorm + j8, maxScore > 0.0 ? clamp01d(f64(load<f32>(score + usize(other * 4))) / maxScore) : 0.0);
  }
  let selectedCount = 0;
  const first = load<i32>(candidates);
  store<i32>(selectedOut, first);
  selectedCount = 1;
  updateWithSeeds(candCount, centers, desired, desiredLen, meanSpacing, first, 0, minChord2, minResidual, candX, candY, candZ);
  const limit = countWant < candCount ? countWant : candCount;
  while (selectedCount < limit) {
    let best = -1;
    let bestObjective: f64 = -Infinity;
    const nextRadius = desiredLen > 0 ? desiredRadiusOf(desired, desiredLen, meanSpacing, selectedCount) : 0.0;
    for (let i = 0; i < candCount; i++) {
      const i8 = usize(i * 8);
      if (load<f64>(minChord2 + i8) == 0.0) continue;
      const scoreNorm = load<f64>(candScoreNorm + i8);
      let objective: f64;
      if (desiredLen > 0) {
        const clearance = load<f64>(minResidual + i8) - nextRadius;
        objective = clearance + meanSpacing * 0.35 * scoreNorm;
      } else {
        objective = Math.sqrt(load<f64>(minChord2 + i8)) * (0.65 + 0.35 * scoreNorm);
      }
      if (objective > bestObjective) {
        bestObjective = objective;
        best = load<i32>(candidates + usize(i * 4));
      }
    }
    if (best < 0) break;
    store<i32>(selectedOut + usize(selectedCount * 4), best);
    selectedCount++;
    updateWithSeeds(candCount, centers, desired, desiredLen, meanSpacing, best, selectedCount - 1, minChord2, minResidual, candX, candY, candZ);
  }
  return selectedCount;
}

@inline function desiredRadiusOf(desired: usize, desiredLen: i32, meanSpacing: f64, selectedIndex: i32): f64 {
  const idx = selectedIndex < desiredLen ? selectedIndex : desiredLen - 1;
  const mass = load<f64>(desired + usize(idx * 8));
  return meanSpacing * Math.sqrt(Math.max(1.0, mass) / Math.PI);
}

function updateWithSeeds(
  candCount: i32, centers: usize,
  desired: usize, desiredLen: i32, meanSpacing: f64,
  cell: i32, selectedIndex: i32, minChord2: usize, minResidual: usize,
  candX: usize, candY: usize, candZ: usize
): void {
  const x = f64(load<f32>(centers + usize((cell * 3) * 4)));
  const y = f64(load<f32>(centers + usize((cell * 3 + 1) * 4)));
  const z = f64(load<f32>(centers + usize((cell * 3 + 2) * 4)));
  const selectedRadius = desiredLen > 0 ? desiredRadiusOf(desired, desiredLen, meanSpacing, selectedIndex) : 0.0;
  for (let j = 0; j < candCount; j++) {
    const j8 = usize(j * 8);
    const dx = x - load<f64>(candX + j8);
    const dy = y - load<f64>(candY + j8);
    const dz = z - load<f64>(candZ + j8);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < load<f64>(minChord2 + j8)) store<f64>(minChord2 + j8, d2);
    if (desiredLen > 0) {
      const curMinRes = load<f64>(minResidual + j8);
      const maxD = curMinRes + selectedRadius;
      if (maxD > 0.0 && (curMinRes == Infinity || d2 <= maxD * maxD * 1.0000000001)) {
        const residual = Math.sqrt(d2) - selectedRadius;
        if (residual < curMinRes) store<f64>(minResidual + j8, residual);
      }
    }
  }
}

// --------------------------------------------------------- priority flood
// Точная копия computePriorityFlood из planet-surface. filled — f64;
// parent инициализируется -1 по всем ячейкам. Возврат: 0 ok, 1 — куча.

export function priorityFlood(
  neighbors: usize, neighborCount: usize, elevation: usize, hardLand: usize, count: i32,
  filledOut: usize, parentOut: usize, seen: usize, heapDist: usize, heapCell: usize,
  heapNext: usize, heapBuckets: usize, heapB0Cell: usize, heapCapIn: i32
): i32 {
  heapInit(heapDist, heapCell, 0, heapNext, heapBuckets, heapB0Cell, 0, heapCapIn);
  memory.fill(seen, 0, usize(count));
  for (let c = 0; c < count; c++) {
    store<f64>(filledOut + usize(c * 8), f64(load<f32>(elevation + usize(c * 4))));
    store<i32>(parentOut + usize(c * 4), -1);
  }
  let hasOcean = false;
  for (let c = 0; c < count; c++) {
    if (load<u8>(hardLand + usize(c))) continue;
    hasOcean = true;
    let boundary = false;
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const base = c * 6;
    for (let j = 0; j < nc; j++) {
      if (load<u8>(hardLand + usize(load<i32>(neighbors + usize((base + j) * 4))))) { boundary = true; break; }
    }
    if (boundary) {
      store<u8>(seen + usize(c), 1);
      heapPush(load<f64>(filledOut + usize(c * 8)), c, 0);
      if (heapOverflow) return 1;
    }
  }
  if (!hasOcean) return 0;
  while (heapPop()) {
    const c = heapOutCell;
    const filledC = load<f64>(filledOut + usize(c * 8));
    if (Math.abs(filledC - heapOutDist) > 1e-12) continue;
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const base = c * 6;
    for (let j = 0; j < nc; j++) {
      const nb = load<i32>(neighbors + usize((base + j) * 4));
      if (load<u8>(seen + usize(nb)) || !load<u8>(hardLand + usize(nb))) continue;
      store<u8>(seen + usize(nb), 1);
      store<i32>(parentOut + usize(nb * 4), c);
      const filledNb = Math.max(f64(load<f32>(elevation + usize(nb * 4))), filledC);
      store<f64>(filledOut + usize(nb * 8), filledNb);
      heapPush(filledNb, nb, 0);
      if (heapOverflow) return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------- flow receivers
// Сырой уклон + steepest receivers по elevation и filled из computeSurface
// (planet-surface), включая fallback filledReceiver на flood.parent, затем
// на rawReceiver. edgeDistance — хорда по центрам (f32, как в сетке).

@inline function edgeDistanceKm(centers: usize, a: i32, b: i32): f64 {
  const dot = f64(load<f32>(centers + usize((a * 3) * 4))) * f64(load<f32>(centers + usize((b * 3) * 4))) +
    f64(load<f32>(centers + usize((a * 3 + 1) * 4))) * f64(load<f32>(centers + usize((b * 3 + 1) * 4))) +
    f64(load<f32>(centers + usize((a * 3 + 2) * 4))) * f64(load<f32>(centers + usize((b * 3 + 2) * 4)));
  return Math.sqrt(Math.max(1e-18, 2.0 - 2.0 * clampd(dot, -1.0, 1.0)));
}

@inline function steepestReceiverF32(
  neighbors: usize, neighborCount: usize, centers: usize, height: usize, cell: i32, hc: f64
): i32 {
  let best = -1;
  let bestSlope: f64 = 1e-12;
  const nc = i32(load<u8>(neighborCount + usize(cell)));
  const base = cell * 6;
  for (let j = 0; j < nc; j++) {
    const nb = load<i32>(neighbors + usize((base + j) * 4));
    const slope = (hc - f64(load<f32>(height + usize(nb * 4)))) / edgeDistanceKm(centers, cell, nb);
    if (slope > bestSlope) {
      bestSlope = slope;
      best = nb;
    }
  }
  return best;
}

@inline function steepestReceiverF64(
  neighbors: usize, neighborCount: usize, centers: usize, height: usize, cell: i32, hc: f64
): i32 {
  let best = -1;
  let bestSlope: f64 = 1e-12;
  const nc = i32(load<u8>(neighborCount + usize(cell)));
  const base = cell * 6;
  for (let j = 0; j < nc; j++) {
    const nb = load<i32>(neighbors + usize((base + j) * 4));
    const slope = (hc - load<f64>(height + usize(nb * 8))) / edgeDistanceKm(centers, cell, nb);
    if (slope > bestSlope) {
      bestSlope = slope;
      best = nb;
    }
  }
  return best;
}

export function flowReceivers(
  neighbors: usize, neighborCount: usize, centers: usize, elevation: usize, filled: usize,
  parent: usize, hardLand: usize, count: i32, rawSlopeOut: usize, slopeOut: usize,
  rawReceiverOut: usize, filledReceiverOut: usize
): void {
  for (let c = 0; c < count; c++) {
    store<i32>(rawReceiverOut + usize(c * 4), -1);
    store<i32>(filledReceiverOut + usize(c * 4), -1);
    const eC = f64(load<f32>(elevation + usize(c * 4)));
    let maxSlope: f64 = 0.0;
    const nc = i32(load<u8>(neighborCount + usize(c)));
    const base = c * 6;
    for (let j = 0; j < nc; j++) {
      const nb = load<i32>(neighbors + usize((base + j) * 4));
      const slope = (eC - f64(load<f32>(elevation + usize(nb * 4)))) / edgeDistanceKm(centers, c, nb);
      if (slope > maxSlope) maxSlope = slope;
    }
    store<f64>(rawSlopeOut + usize(c * 8), maxSlope);
    store<f32>(slopeOut + usize(c * 4), f32(maxSlope));
    if (!load<u8>(hardLand + usize(c))) continue;
    const raw = steepestReceiverF32(neighbors, neighborCount, centers, elevation, c, eC);
    let filledR = steepestReceiverF64(neighbors, neighborCount, centers, filled, c,
      load<f64>(filled + usize(c * 8)));
    if (filledR < 0) {
      const p = load<i32>(parent + usize(c * 4));
      if (p >= 0) filledR = p;
    }
    if (filledR < 0) filledR = raw;
    store<i32>(rawReceiverOut + usize(c * 4), raw);
    store<i32>(filledReceiverOut + usize(c * 4), filledR);
  }
}

// ---------------------------------------------------------- accumulate flow
// Топологическая аккумуляция Кана из accumulateFlow (planet-surface) с
// разрывом циклов по возрастанию filled. ВАЖНО: accKm2/accCells — f32:
// JS накапливает прямо в Float32Array, округляя на каждом шаге.
// flowReceiver мутируется на месте (разорванные рёбра -> -1), как в JS.
// Возвращает cycleBreakCount; длина порядка пишется в orderLenOut (i32).

export function accumulateFlow(
  hardLand: usize, landCells: usize, landCount: i32, flowReceiver: usize,
  localKm2: usize, localCells: usize, filled: usize, accKm2: usize, accCells: usize,
  orderOut: usize, orderLenOut: usize, upstream: usize, processed: usize, queue: usize,
  sortOrder: usize, sortTmp: usize, sortCounts: usize, count: i32
): i32 {
  memory.fill(upstream, 0, usize(count * 4));
  memory.fill(processed, 0, usize(count));
  memory.fill(accKm2, 0, usize(count * 4));
  memory.fill(accCells, 0, usize(count * 4));
  let qHead = 0, qTail = 0;
  let orderLen = 0;
  for (let i = 0; i < landCount; i++) {
    const cell = load<i32>(landCells + usize(i * 4));
    store<f32>(accKm2 + usize(cell * 4), f32(load<f64>(localKm2 + usize(cell * 8))));
    store<f32>(accCells + usize(cell * 4), f32(load<f64>(localCells + usize(cell * 8))));
    const receiver = load<i32>(flowReceiver + usize(cell * 4));
    if (receiver >= 0 && load<u8>(hardLand + usize(receiver))) {
      store<i32>(upstream + usize(receiver * 4), load<i32>(upstream + usize(receiver * 4)) + 1);
    }
  }
  for (let i = 0; i < landCount; i++) {
    const cell = load<i32>(landCells + usize(i * 4));
    if (load<i32>(upstream + usize(cell * 4)) == 0) {
      store<i32>(queue + usize(qTail * 4), cell);
      qTail++;
    }
  }
  // drainQueue вынесен инлайн-циклом через флаг повтора ниже.
  let cycleBreakCount = 0;
  let needDrain = true;
  let remIdx = 0;
  let remCount = 0;
  let breaking = false;
  for (;;) {
    if (needDrain) {
      needDrain = false;
      while (qHead < qTail) {
        const cell = load<i32>(queue + usize(qHead * 4));
        qHead++;
        if (load<u8>(processed + usize(cell))) continue;
        store<u8>(processed + usize(cell), 1);
        store<i32>(orderOut + usize(orderLen * 4), cell);
        orderLen++;
        const receiver = load<i32>(flowReceiver + usize(cell * 4));
        if (receiver >= 0 && load<u8>(hardLand + usize(receiver))) {
          store<f32>(accKm2 + usize(receiver * 4),
            f32(f64(load<f32>(accKm2 + usize(receiver * 4))) + f64(load<f32>(accKm2 + usize(cell * 4)))));
          store<f32>(accCells + usize(receiver * 4),
            f32(f64(load<f32>(accCells + usize(receiver * 4))) + f64(load<f32>(accCells + usize(cell * 4)))));
          const left = load<i32>(upstream + usize(receiver * 4)) - 1;
          store<i32>(upstream + usize(receiver * 4), left);
          if (left == 0) {
            store<i32>(queue + usize(qTail * 4), receiver);
            qTail++;
          }
        }
      }
    }
    if (orderLen >= landCount) break;
    if (!breaking) {
      breaking = true;
      remCount = 0;
      for (let i = 0; i < landCount; i++) {
        const cell = load<i32>(landCells + usize(i * 4));
        if (!load<u8>(processed + usize(cell))) {
          store<u32>(sortOrder + usize(remCount * 4), u32(cell));
          remCount++;
        }
      }
      radixOrderF64(filled, sortOrder, sortTmp, sortCounts, remCount, 0);
      remIdx = 0;
    }
    if (remIdx >= remCount) break;
    const cell = i32(load<u32>(sortOrder + usize(remIdx * 4)));
    remIdx++;
    if (load<u8>(processed + usize(cell))) continue;
    const receiver = load<i32>(flowReceiver + usize(cell * 4));
    if (receiver >= 0 && load<u8>(hardLand + usize(receiver))) {
      store<i32>(flowReceiver + usize(cell * 4), -1);
      const left = load<i32>(upstream + usize(receiver * 4)) - 1;
      store<i32>(upstream + usize(receiver * 4), left);
      cycleBreakCount++;
      if (left == 0) {
        store<i32>(queue + usize(qTail * 4), receiver);
        qTail++;
      }
    }
    if (load<i32>(upstream + usize(cell * 4)) == 0) {
      store<i32>(queue + usize(qTail * 4), cell);
      qTail++;
    }
    needDrain = true;
  }
  store<i32>(orderLenOut, orderLen);
  return cycleBreakCount;
}

// ------------------------------------------------------------ biome weights
// Скоринг computeBiomes из planet-surface (16 биомов), нормализация на
// месте. Все поля — f32, кроме coastExp и volcPow: host считает их в TS
// (Math.exp/Math.pow — платформенные) и передаёт как f64.
// params (f64): [0] coldLevel [1] hotLevel [2] aridLevel [3] wetLevel
// [4] slopeP55 [5] slopeP95 [6] tempSpan [7] moistSpan [8] seaLevel
// [9] elevationMin [10] elevationMax [11] shelfBelowLevel [12] vegFactor
// [13] iceAvailability [14] hotDesertFactor [15] desertFlag [16] iceFlag
// [17] barrenFlag [18] volcanicFactor

@inline function smoothstepK(e0: f64, e1: f64, x: f64): f64 {
  if (e0 == e1) return x >= e1 ? 1.0 : 0.0;
  const t = clamp01d((x - e0) / (e1 - e0));
  return t * t * (3.0 - 2.0 * t);
}

@inline function bandK(x: f64, lo: f64, peakLo: f64, peakHi: f64, hi: f64): f64 {
  return smoothstepK(lo, peakLo, x) * (1.0 - smoothstepK(peakHi, hi, x));
}

export function biomeWeights(
  muOcean: usize, muShelf: usize, muLand: usize, temperature: usize, moisture: usize,
  elevation: usize, riverInfluence: usize, lakeWeight: usize, deltaWeight: usize,
  slope: usize, mountainWeight: usize, mountainSeamWeight: usize,
  coastExp: usize, volcPow: usize, hardLand: usize, params: usize,
  weightsOut: usize, count: i32
): void {
  const coldLevel = load<f64>(params);
  const hotLevel = load<f64>(params + 8);
  const aridLevel = load<f64>(params + 16);
  const wetLevel = load<f64>(params + 24);
  const slopeP55 = load<f64>(params + 32);
  const slopeP95 = load<f64>(params + 40);
  const tempSpan = load<f64>(params + 48);
  const moistSpan = load<f64>(params + 56);
  const seaLevel = load<f64>(params + 64);
  const elevationMin = load<f64>(params + 72);
  const elevationMax = load<f64>(params + 80);
  const shelfBelowLevel = load<f64>(params + 88);
  const vegFactor = load<f64>(params + 96);
  const iceAvailability = load<f64>(params + 104);
  const hotDesertFactor = load<f64>(params + 112);
  const desertFlag = load<f64>(params + 120);
  const iceFlag = load<f64>(params + 128);
  const barrenFlag = load<f64>(params + 136);
  const volcanicFactor = load<f64>(params + 144);
  for (let c = 0; c < count; c++) {
    const co = usize(c * 4);
    const hl = load<u8>(hardLand + usize(c)) != 0;
    const waterMask = clamp01d(f64(load<f32>(muOcean + co)) + f64(load<f32>(muShelf + co)));
    const landMask = clamp01d(f64(load<f32>(muLand + co)) + (hl ? 0.12 : 0.0));
    const temp = f64(load<f32>(temperature + co));
    const river = f64(load<f32>(riverInfluence + co));
    const lake = f64(load<f32>(lakeWeight + co));
    const delta = f64(load<f32>(deltaWeight + co));
    let iceScore = 1.0 - smoothstepK(coldLevel - tempSpan * 0.35, coldLevel + tempSpan * 0.05, temp);
    if (iceFlag != 0.0) iceScore = clamp01d(iceScore * 1.15 + 0.10);
    iceScore *= iceAvailability;
    const elev = f64(load<f32>(elevation + co));
    const depthNorm = seaLevel > elevationMin
      ? clamp01d((seaLevel - elev) / (seaLevel - elevationMin)) : 0.0;
    const shelfBand = shelfBelowLevel < seaLevel ? smoothstepK(shelfBelowLevel, seaLevel, elev) : 0.0;

    let s0 = waterMask * (1.0 - shelfBand) * (0.35 + 0.65 * smoothstepK(0.02, 0.30, depthNorm));
    let s1 = waterMask * (f64(load<f32>(muShelf + co)) * 1.80 + shelfBand * 0.55 + delta * 0.35);
    let s2 = waterMask * iceScore * 1.25;
    let s3 = lake * 2.20;
    if (!(s0 > 0.0)) s0 = 0.0;
    if (!(s1 > 0.0)) s1 = 0.0;
    if (!(s2 > 0.0)) s2 = 0.0;
    if (!(s3 > 0.0)) s3 = 0.0;

    const base = weightsOut + usize(c * 64);
    if (landMask == 0.0) {
      let sum = s0 + s1 + s2 + s3;
      if (!(sum > 0.0)) {
        s0 = 1.0;
        sum = 1.0;
      }
      store<f32>(base, f32(s0 / sum));
      store<f32>(base + 4, f32(s1 / sum));
      store<f32>(base + 8, f32(s2 / sum));
      store<f32>(base + 12, f32(s3 / sum));
      store<u64>(base + 16, 0);
      store<u64>(base + 24, 0);
      store<u64>(base + 32, 0);
      store<u64>(base + 40, 0);
      store<u64>(base + 48, 0);
      store<u64>(base + 56, 0);
      continue;
    }

    const effMoisture = clamp01d(f64(load<f32>(moisture + co)) + river * 0.22 +
      lake * 0.25 + delta * 0.10 - (desertFlag != 0.0 ? 0.10 : 0.0));
    const coldScore = 1.0 - smoothstepK(coldLevel - tempSpan * 0.10, coldLevel + tempSpan * 0.35, temp);
    const coolScore = bandK(temp, coldLevel - tempSpan * 0.05, coldLevel + tempSpan * 0.22,
      coldLevel + tempSpan * 0.58, hotLevel - tempSpan * 0.05);
    const mildScore = bandK(temp, coldLevel + tempSpan * 0.15, coldLevel + tempSpan * 0.45,
      hotLevel - tempSpan * 0.05, hotLevel + tempSpan * 0.35);
    const hotScore = smoothstepK(hotLevel - tempSpan * 0.30, hotLevel + tempSpan * 0.12, temp);
    const dryScore = 1.0 - smoothstepK(aridLevel, wetLevel, effMoisture);
    const wetScore = smoothstepK(aridLevel, wetLevel, effMoisture);
    const veryWetScore = smoothstepK(wetLevel, wetLevel + moistSpan * 0.55, effMoisture);
    const midMoistScore = bandK(effMoisture, aridLevel - moistSpan * 0.25, aridLevel + moistSpan * 0.25,
      wetLevel - moistSpan * 0.05, wetLevel + moistSpan * 0.45);
    const landHeight = elevationMax > seaLevel
      ? clamp01d((elev - seaLevel) / (elevationMax - seaLevel)) : 0.0;
    const slopeScore = smoothstepK(slopeP55, slopeP95, f64(load<f32>(slope + co)));
    const mountain = f64(load<f32>(mountainWeight + co));
    const coastProximity = load<f64>(coastExp + usize(c * 8));

    let s4 = landMask * iceScore * (0.75 + 0.35 * mountain);
    let s5 = landMask * coldScore * (1.0 - iceScore * 0.75) * (1.0 - mountain * 0.45) * Math.max(vegFactor, 0.25);
    let s6 = landMask * coolScore * (0.35 + 0.65 * wetScore) * (1.0 - mountain * 0.65) * vegFactor;
    let s7 = landMask * mildScore * wetScore * (1.0 - hotScore * 0.45) * (1.0 - mountain * 0.60) * vegFactor;
    let s8 = landMask * hotScore * veryWetScore * (1.0 - mountain * 0.50) * vegFactor;
    let s9 = landMask * (mildScore * 0.70 + hotScore * 0.35) * midMoistScore *
      (1.0 - slopeScore * 0.35) * (1.0 - mountain * 0.55) * vegFactor;
    let s10 = landMask * (hotScore * 0.72 + mildScore * 0.28) *
      bandK(effMoisture, aridLevel - moistSpan * 0.45, aridLevel + moistSpan * 0.10,
        wetLevel - moistSpan * 0.25, wetLevel + moistSpan * 0.20) *
      (1.0 - mountain * 0.45) * Math.max(vegFactor, 0.20);
    let s11 = landMask * hotScore * dryScore * hotDesertFactor;
    const barren = barrenFlag != 0.0;
    let s12 = landMask * (dryScore * (0.22 + coldScore * 0.45) + (barren ? 0.90 : 0.0)) *
      (barren ? 0.65 + 0.35 * slopeScore : 0.45 + 0.55 * slopeScore);
    let s13 = landMask * mountain * 1.30;
    let s14 = landMask * load<f64>(volcPow + usize(c * 8)) *
      (0.22 + 0.78 * Math.max(mountain, f64(load<f32>(mountainSeamWeight + co)))) * volcanicFactor;
    const wetlandDriver = clamp01d(0.20 + river * 0.55 + lake * 0.45 + delta * 0.65 + coastProximity * 0.18);
    let s15 = landMask * wetScore * (1.0 - slopeScore) * (1.0 - landHeight * 0.75) * wetlandDriver * vegFactor;

    if (!(s4 > 0.0)) s4 = 0.0;
    if (!(s5 > 0.0)) s5 = 0.0;
    if (!(s6 > 0.0)) s6 = 0.0;
    if (!(s7 > 0.0)) s7 = 0.0;
    if (!(s8 > 0.0)) s8 = 0.0;
    if (!(s9 > 0.0)) s9 = 0.0;
    if (!(s10 > 0.0)) s10 = 0.0;
    if (!(s11 > 0.0)) s11 = 0.0;
    if (!(s12 > 0.0)) s12 = 0.0;
    if (!(s13 > 0.0)) s13 = 0.0;
    if (!(s14 > 0.0)) s14 = 0.0;
    if (!(s15 > 0.0)) s15 = 0.0;
    let sum = s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8 + s9 + s10 + s11 + s12 + s13 + s14 + s15;
    if (!(sum > 0.0)) {
      if (hl) s12 = 1.0; else s0 = 1.0;
      sum = 1.0;
    }
    store<f32>(base, f32(s0 / sum));
    store<f32>(base + 4, f32(s1 / sum));
    store<f32>(base + 8, f32(s2 / sum));
    store<f32>(base + 12, f32(s3 / sum));
    store<f32>(base + 16, f32(s4 / sum));
    store<f32>(base + 20, f32(s5 / sum));
    store<f32>(base + 24, f32(s6 / sum));
    store<f32>(base + 28, f32(s7 / sum));
    store<f32>(base + 32, f32(s8 / sum));
    store<f32>(base + 36, f32(s9 / sum));
    store<f32>(base + 40, f32(s10 / sum));
    store<f32>(base + 44, f32(s11 / sum));
    store<f32>(base + 48, f32(s12 / sum));
    store<f32>(base + 52, f32(s13 / sum));
    store<f32>(base + 56, f32(s14 / sum));
    store<f32>(base + 60, f32(s15 / sum));
  }
}

// ------------------------------------------------------ smooth biome weights
// Точная копия smoothBiomeWeights из planet-surface: steps шагов диффузии
// (ping-pong weights<->next, f32-округление на каждом шаге как у
// Float32Array), затем ОДИН проход масок по финальному буферу.
// Суммы по соседям — f64x2 по парам биомов (f32->f64 promote): порядок
// суммирования по соседям и ассоциативность combine сохранены.
// alphas — f64[steps] с готовыми 0.42*factor шага (считает host); шаг с
// !(alpha > 0) пропускается без обмена буферов, как в JS.
// Возврат: 0 — результат в weights, 1 — результат в next.

export function smoothBiomeWeights(
  weights: usize, next: usize, neighbors: usize, neighborCount: usize,
  muOcean: usize, muShelf: usize, muLand: usize, lakeWeight: usize, hardLand: usize,
  alphas: usize, steps: i32, count: i32
): i32 {
  let src = weights, dst = next;
  for (let step = 0; step < steps; step++) {
    const alpha = load<f64>(alphas + usize(step * 8));
    if (!(alpha > 0.0)) continue;
    const keep = 1.0 - alpha;
    const vKeep = f64x2.splat(keep);
    const vAlpha = f64x2.splat(alpha);
    for (let c = 0; c < count; c++) {
      const base = usize(c * 64);
      const sb = src + base;
      const nc = i32(load<u8>(neighborCount + usize(c)));
      const nbase = neighbors + usize(c * 24);
      const zero = f64x2.splat(0.0);
      let a0 = zero, a1 = zero, a2 = zero, a3 = zero;
      let a4 = zero, a5 = zero, a6 = zero, a7 = zero;
      let hasLand = (load<u64>(sb + 16) | load<u64>(sb + 24) | load<u64>(sb + 32) |
                     load<u64>(sb + 40) | load<u64>(sb + 48) | load<u64>(sb + 56)) != 0;
      for (let j = 0; j < nc; j++) {
        const nb = load<i32>(nbase + usize(j * 4));
        const wb = src + usize(nb * 64);
        const q0 = v128.load(wb);
        a0 = f64x2.add(a0, f64x2.promote_low_f32x4(q0));
        a1 = f64x2.add(a1, f64x2.promote_low_f32x4(v128.shuffle<f32>(q0, q0, 2, 3, 2, 3)));
        if ((load<u64>(wb + 16) | load<u64>(wb + 24) | load<u64>(wb + 32) |
             load<u64>(wb + 40) | load<u64>(wb + 48) | load<u64>(wb + 56)) != 0) {
          hasLand = true;
          const q1 = v128.load(wb + 16);
          a2 = f64x2.add(a2, f64x2.promote_low_f32x4(q1));
          a3 = f64x2.add(a3, f64x2.promote_low_f32x4(v128.shuffle<f32>(q1, q1, 2, 3, 2, 3)));
          const q2 = v128.load(wb + 32);
          a4 = f64x2.add(a4, f64x2.promote_low_f32x4(q2));
          a5 = f64x2.add(a5, f64x2.promote_low_f32x4(v128.shuffle<f32>(q2, q2, 2, 3, 2, 3)));
          const q3 = v128.load(wb + 48);
          a6 = f64x2.add(a6, f64x2.promote_low_f32x4(q3));
          a7 = f64x2.add(a7, f64x2.promote_low_f32x4(v128.shuffle<f32>(q3, q3, 2, 3, 2, 3)));
        }
      }
      const vCount = f64x2.splat(f64(nc));
      const w0 = v128.load(sb);
      const c0 = smoothCombine(f64x2.promote_low_f32x4(w0), a0, vCount, vKeep, vAlpha);
      const c1 = smoothCombine(f64x2.promote_low_f32x4(v128.shuffle<f32>(w0, w0, 2, 3, 2, 3)), a1, vCount, vKeep, vAlpha);
      const db = dst + base;
      v128.store(db, v128.shuffle<f32>(f32x4.demote_f64x2_zero(c0), f32x4.demote_f64x2_zero(c1), 0, 1, 4, 5));
      if (hasLand) {
        const w1 = v128.load(sb + 16), w2 = v128.load(sb + 32), w3 = v128.load(sb + 48);
        const c2 = smoothCombine(f64x2.promote_low_f32x4(w1), a2, vCount, vKeep, vAlpha);
        const c3 = smoothCombine(f64x2.promote_low_f32x4(v128.shuffle<f32>(w1, w1, 2, 3, 2, 3)), a3, vCount, vKeep, vAlpha);
        const c4 = smoothCombine(f64x2.promote_low_f32x4(w2), a4, vCount, vKeep, vAlpha);
        const c5 = smoothCombine(f64x2.promote_low_f32x4(v128.shuffle<f32>(w2, w2, 2, 3, 2, 3)), a5, vCount, vKeep, vAlpha);
        const c6 = smoothCombine(f64x2.promote_low_f32x4(w3), a6, vCount, vKeep, vAlpha);
        const c7 = smoothCombine(f64x2.promote_low_f32x4(v128.shuffle<f32>(w3, w3, 2, 3, 2, 3)), a7, vCount, vKeep, vAlpha);
        v128.store(db + 16, v128.shuffle<f32>(f32x4.demote_f64x2_zero(c2), f32x4.demote_f64x2_zero(c3), 0, 1, 4, 5));
        v128.store(db + 32, v128.shuffle<f32>(f32x4.demote_f64x2_zero(c4), f32x4.demote_f64x2_zero(c5), 0, 1, 4, 5));
        v128.store(db + 48, v128.shuffle<f32>(f32x4.demote_f64x2_zero(c6), f32x4.demote_f64x2_zero(c7), 0, 1, 4, 5));
      } else {
        store<u64>(db + 16, 0);
        store<u64>(db + 24, 0);
        store<u64>(db + 32, 0);
        store<u64>(db + 40, 0);
        store<u64>(db + 48, 0);
        store<u64>(db + 56, 0);
      }
    }
    const swap = src; src = dst; dst = swap;
  }
  // Маски: water 0..2, озеро 3, суша 4..15 — по финальному буферу (src).
  for (let c = 0; c < count; c++) {
    const base = src + usize(c * 64);
    const co = usize(c * 4);
    const waterMask = clamp01d(f64(load<f32>(muOcean + co)) + f64(load<f32>(muShelf + co)));
    const lakeGate = load<f32>(lakeWeight + co) > 0.0 ? 1.0 : 0.0;
    const hl = load<u8>(hardLand + usize(c)) != 0;
    const landMask = clamp01d(f64(load<f32>(muLand + co)) + (hl ? 0.12 : 0.0));
    if (landMask == 0.0 && lakeGate == 0.0) {
      let v0 = f32(f64(load<f32>(base)) * waterMask);
      if (!(v0 > 0.0)) v0 = 0.0;
      let v1 = f32(f64(load<f32>(base + 4)) * waterMask);
      if (!(v1 > 0.0)) v1 = 0.0;
      let v2 = f32(f64(load<f32>(base + 8)) * waterMask);
      if (!(v2 > 0.0)) v2 = 0.0;
      let sum = f64(v0) + f64(v1) + f64(v2);
      if (!(sum > 0.0)) {
        v0 = 1.0;
        sum = 1.0;
      }
      store<f32>(base, f32(f64(v0) / sum));
      store<f32>(base + 4, f32(f64(v1) / sum));
      store<f32>(base + 8, f32(f64(v2) / sum));
      store<f32>(base + 12, 0.0);
      store<u64>(base + 16, 0);
      store<u64>(base + 24, 0);
      store<u64>(base + 32, 0);
      store<u64>(base + 40, 0);
      store<u64>(base + 48, 0);
      store<u64>(base + 56, 0);
      continue;
    }
    let sum: f64 = 0.0;
    for (let b = 0; b < 16; b++) {
      const mask = b < 3 ? waterMask : (b == 3 ? lakeGate : landMask);
      const p = base + usize(b * 4);
      let v = f32(f64(load<f32>(p)) * mask);
      if (!(v > 0.0)) v = 0.0;
      store<f32>(p, v);
      sum += f64(v);
    }
    if (!(sum > 0.0)) {
      store<f32>(base + usize((hl ? 12 : 0) * 4), 1.0);
      sum = 1.0;
    }
    for (let b = 0; b < 16; b++) {
      const p = base + usize(b * 4);
      store<f32>(p, f32(f64(load<f32>(p)) / sum));
    }
  }
  return src == weights ? 0 : 1;
}

@inline function smoothCombine(w: v128, sum: v128, vCount: v128, vKeep: v128, vAlpha: v128): v128 {
  return f64x2.add(f64x2.mul(w, vKeep), f64x2.mul(f64x2.div(sum, vCount), vAlpha));
}

// ---------------------------------------------------------------- globe pack
// Позиции веера и честные нормали рельефа (6.1 GlobeVertex): центр ячейки
// + кольцо углов, смещённые радиусами cellRadius/cornerRadius (host
// считает их по reliefDelta). Нормали: центр — нормализованная сумма
// cross-произведений веерных треугольников (взвешены площадью), вершина
// кольца k — сумма cross соседних треугольников k-1 и k; квантование
// i16 normalized (4-й компонент 0). Возвращает общее число вершин.

@inline function quantNormal(v: f64): i32 {
  return i32(Math.floor(clampd(v, -1.0, 1.0) * 32767.0 + 0.5));
}

export function globePack(
  centers: usize, cornerCoords: usize, cellCorners: usize, cellCornerStart: usize,
  cellRadius: usize, cornerRadius: usize, positions: usize, normals: usize, count: i32
): i32 {
  // Центры — первые count вершин.
  for (let c = 0; c < count; c++) {
    const r = f64(load<f32>(cellRadius + usize(c * 4)));
    const ci = usize(c * 12);
    store<f32>(positions + ci, f32(f64(load<f32>(centers + ci)) * r));
    store<f32>(positions + ci + 4, f32(f64(load<f32>(centers + ci + 4)) * r));
    store<f32>(positions + ci + 8, f32(f64(load<f32>(centers + ci + 8)) * r));
  }
  let slot = count;
  for (let c = 0; c < count; c++) {
    const start = load<i32>(cellCornerStart + usize(c * 4));
    const sides = load<i32>(cellCornerStart + usize((c + 1) * 4)) - start;
    const firstSlot = slot;
    for (let k = 0; k < sides; k++) {
      const corner = load<i32>(cellCorners + usize((start + k) * 4));
      let cr = f64(load<f32>(cornerRadius + usize(corner * 4)));
      if (cr == 0.0) cr = 1.0;
      const vi = usize(corner * 12);
      const po = usize(slot * 12);
      store<f32>(positions + po, f32(f64(load<f32>(cornerCoords + vi)) * cr));
      store<f32>(positions + po + 4, f32(f64(load<f32>(cornerCoords + vi + 4)) * cr));
      store<f32>(positions + po + 8, f32(f64(load<f32>(cornerCoords + vi + 8)) * cr));
      slot++;
    }
    // Нормали веера по уже записанным f32-позициям.
    const co = usize(c * 12);
    const cx = f64(load<f32>(positions + co));
    const cy = f64(load<f32>(positions + co + 4));
    const cz = f64(load<f32>(positions + co + 8));
    let sumX: f64 = 0, sumY: f64 = 0, sumZ: f64 = 0;
    let prevX: f64 = 0, prevY: f64 = 0, prevZ: f64 = 0;
    let firstX: f64 = 0, firstY: f64 = 0, firstZ: f64 = 0;
    for (let k = 0; k < sides; k++) {
      const p1 = usize((firstSlot + k) * 12);
      const p2 = usize((firstSlot + (k + 1) % sides) * 12);
      const ax = f64(load<f32>(positions + p1)) - cx;
      const ay = f64(load<f32>(positions + p1 + 4)) - cy;
      const az = f64(load<f32>(positions + p1 + 8)) - cz;
      const bx = f64(load<f32>(positions + p2)) - cx;
      const by = f64(load<f32>(positions + p2 + 4)) - cy;
      const bz = f64(load<f32>(positions + p2 + 8)) - cz;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      sumX += nx; sumY += ny; sumZ += nz;
      if (k == 0) { firstX = nx; firstY = ny; firstZ = nz; }
      if (k > 0) {
        writeNormal(normals, positions, firstSlot + k, prevX + nx, prevY + ny, prevZ + nz);
      }
      prevX = nx; prevY = ny; prevZ = nz;
    }
    writeNormal(normals, positions, firstSlot, prevX + firstX, prevY + firstY, prevZ + firstZ);
    writeNormal(normals, positions, c, sumX, sumY, sumZ);
  }
  return slot;
}

function writeNormal(normals: usize, positions: usize, vertex: i32, x: f64, y: f64, z: f64): void {
  let len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0.0)) {
    const po = usize(vertex * 12);
    x = f64(load<f32>(positions + po));
    y = f64(load<f32>(positions + po + 4));
    z = f64(load<f32>(positions + po + 8));
    len = Math.sqrt(x * x + y * y + z * z);
    if (!(len > 0.0)) { x = 0.0; y = 1.0; z = 0.0; len = 1.0; }
  }
  const no = usize(vertex * 8);
  store<i16>(normals + no, i16(quantNormal(x / len)));
  store<i16>(normals + no + 2, i16(quantNormal(y / len)));
  store<i16>(normals + no + 4, i16(quantNormal(z / len)));
  store<i16>(normals + no + 6, 0);
}

// ------------------------------------------------------- expand vertex colors
// buildVertexColors из planet-globe: цвет ячейки -> RGBA8 по вершинам,
// A = edge factor веера (0 центр, 255 кольцо). Округление — JS Math.round
// (floor(v+0.5)); вход — f32-цвета buildCellColors.

export function expandVertexColors(
  vertexCellId: usize, cellColors: usize, out: usize, centerCount: i32, vertexCount: i32
): void {
  for (let v = 0; v < vertexCount; v++) {
    const cell = load<u32>(vertexCellId + usize(v * 4));
    const co = usize(cell * 12);
    const oo = usize(v * 4);
    store<u8>(out + oo, u8(i32(clamp01d(f64(load<f32>(cellColors + co))) * 255.0 + 0.5)));
    store<u8>(out + oo + 1, u8(i32(clamp01d(f64(load<f32>(cellColors + co + 4))) * 255.0 + 0.5)));
    store<u8>(out + oo + 2, u8(i32(clamp01d(f64(load<f32>(cellColors + co + 8))) * 255.0 + 0.5)));
    store<u8>(out + oo + 3, v < centerCount ? 0 : 255);
  }
}
