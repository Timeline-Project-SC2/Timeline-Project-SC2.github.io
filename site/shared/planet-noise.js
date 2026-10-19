/* PlanetNoise — детерминированные поля планеты для спайка Этапа 1.
   =========================================================================
   ЗАДАЧА МОДУЛЯ — сравнить два семейства 3D-шума на сфере и дать единый
   сэмплер полей (высота, влажность, температура) по направлению. Точный
   алгоритм будет заморожен позже (noise_version); здесь важно, что:
     - результат зависит только от seed и параметров (без Math.random);
     - оба кандидата гоняются одними и теми же fBm-настройками;
     - шум сэмплируется по 3D-направлению: нет шва по долготе и полюсов
       как особых точек.

   КАНДИДАТЫ
     'simplex' — градиентный симплекс-шум 3D (семейство, к которому относится
       и OpenSimplex; точный порт OpenSimplex2S — отдельное решение после
       выбора семейства на гейте G1).
     'value'   — собственный value noise: целочисленный хэш узлов решётки +
       трилинейная интерполяция со smootherstep.

   SEED: мастер-seed задаётся строкой; из неё хэшем xmur-подобной схемы
   получается uint32, подseed полей — финальным перемешиванием с доменными
   константами. Формат 64-битного seed из таблицы профилей сюда ляжет позже:
   для спайка достаточно воспроизводимости внутри контракта этой версии.

   API
     var sampler = PlanetNoise.createSampler({
       seedText: 'korhal-iv', kind: 'simplex' | 'value',
       freq: 2.2, octaves: 5, lacunarity: 2, gain: 0.5, warp: 0.35
     });
     sampler.sample(x, y, z, out);  // out[0]=высота [-1..1], out[1]=влажность [0..1], out[2]=температура [0..1]
     sampler.masterSeed             // uint32
     PlanetNoise.makeNoise(kind, seedUint32) -> fn(x,y,z) в [-1..1]
     PlanetNoise.fbm(noiseFn, x, y, z, octaves, lacunarity, gain)

   В браузере — window.PlanetNoise, в Node — module.exports. */
(function (root) {
  'use strict';

  function hash32(x) {
    x = x >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
    return (x ^ (x >>> 16)) >>> 0;
  }

  function stringSeed(text) {
    var h = 1779033703 ^ text.length;
    for (var i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return hash32(h >>> 0);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makePerm(seed) {
    var rand = mulberry32(seed);
    var p = new Uint8Array(256);
    var i;
    for (i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0;
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    var perm = new Uint8Array(512);
    var permMod12 = new Uint8Array(512);
    for (i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
      permMod12[i] = perm[i] % 12;
    }
    return { perm: perm, permMod12: permMod12 };
  }

  var GRAD3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
  ];
  var F3 = 1 / 3, G3 = 1 / 6;

  function makeSimplex(seed) {
    var tables = makePerm(seed);
    var perm = tables.perm, permMod12 = tables.permMod12;
    return function noise3(xin, yin, zin) {
      var n0, n1, n2, n3;
      var s = (xin + yin + zin) * F3;
      var i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
      var t = (i + j + k) * G3;
      var x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      var i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      var x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
      var x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
      var x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
      var ii = i & 255, jj = j & 255, kk = k & 255;
      var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (t0 < 0) n0 = 0; else {
        var g0 = GRAD3[permMod12[ii + perm[jj + perm[kk]]]];
        t0 *= t0; n0 = t0 * t0 * (g0[0] * x0 + g0[1] * y0 + g0[2] * z0);
      }
      var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (t1 < 0) n1 = 0; else {
        var g1 = GRAD3[permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]]];
        t1 *= t1; n1 = t1 * t1 * (g1[0] * x1 + g1[1] * y1 + g1[2] * z1);
      }
      var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (t2 < 0) n2 = 0; else {
        var g2 = GRAD3[permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]]];
        t2 *= t2; n2 = t2 * t2 * (g2[0] * x2 + g2[1] * y2 + g2[2] * z2);
      }
      var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (t3 < 0) n3 = 0; else {
        var g3 = GRAD3[permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]]];
        t3 *= t3; n3 = t3 * t3 * (g3[0] * x3 + g3[1] * y3 + g3[2] * z3);
      }
      return 32 * (n0 + n1 + n2 + n3);
    };
  }

  function makeValue(seed) {
    function lat(ix, iy, iz) {
      var h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1274126177) ^ (seed | 0);
      return (hash32(h >>> 0) / 4294967295) * 2 - 1;
    }
    function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    function lerp(a, b, t) { return a + (b - a) * t; }
    return function noise3(x, y, z) {
      var ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
      var fx = x - ix, fy = y - iy, fz = z - iz;
      var ux = fade(fx), uy = fade(fy), uz = fade(fz);
      var c000 = lat(ix, iy, iz), c100 = lat(ix + 1, iy, iz);
      var c010 = lat(ix, iy + 1, iz), c110 = lat(ix + 1, iy + 1, iz);
      var c001 = lat(ix, iy, iz + 1), c101 = lat(ix + 1, iy, iz + 1);
      var c011 = lat(ix, iy + 1, iz + 1), c111 = lat(ix + 1, iy + 1, iz + 1);
      return lerp(
        lerp(lerp(c000, c100, ux), lerp(c010, c110, ux), uy),
        lerp(lerp(c001, c101, ux), lerp(c011, c111, ux), uy),
        uz);
    };
  }

  function makeNoise(kind, seed) {
    if (kind === 'value') return makeValue(seed >>> 0);
    return makeSimplex(seed >>> 0);
  }

  function fbm(noise, x, y, z, octaves, lacunarity, gain) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var o = 0; o < octaves; o++) {
      sum += amp * noise(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  function offsetVector(seed) {
    var rand = mulberry32(seed);
    return [(rand() * 2 - 1) * 100, (rand() * 2 - 1) * 100, (rand() * 2 - 1) * 100];
  }

  var DOMAIN = {
    elevation: 0x1A2B3C4D,
    moisture: 0x2B3C4D5E,
    temperature: 0x3C4D5E6F,
    warp: 0x4D5E6F70
  };

  function createSampler(opts) {
    opts = opts || {};
    var kind = opts.kind === 'value' ? 'value' : 'simplex';
    var master = stringSeed(String(opts.seedText != null ? opts.seedText : 'planet'));
    var freq = opts.freq != null ? opts.freq : 2.2;
    var octaves = opts.octaves != null ? opts.octaves : 5;
    var lacunarity = opts.lacunarity != null ? opts.lacunarity : 2.0;
    var gain = opts.gain != null ? opts.gain : 0.5;
    var warp = opts.warp != null ? opts.warp : 0.35;

    var elevNoise = makeNoise(kind, hash32(master ^ DOMAIN.elevation));
    var moistNoise = makeNoise(kind, hash32(master ^ DOMAIN.moisture));
    var tempNoise = makeNoise(kind, hash32(master ^ DOMAIN.temperature));
    var warpNoise = makeNoise(kind, hash32(master ^ DOMAIN.warp));
    var offE = offsetVector(hash32(master ^ 0x51));
    var offM = offsetVector(hash32(master ^ 0x52));
    var offT = offsetVector(hash32(master ^ 0x53));
    var offW = offsetVector(hash32(master ^ 0x54));

    function sample(x, y, z, out) {
      var dx = x, dy = y, dz = z;
      if (warp > 0) {
        // Касательный варп: смещение по поверхности, затем нормализация.
        var wx = warpNoise(x * freq * 0.7 + offW[0], y * freq * 0.7 + offW[1], z * freq * 0.7 + offW[2]);
        var wy = warpNoise(x * freq * 0.7 + offW[1], y * freq * 0.7 + offW[2], z * freq * 0.7 + offW[0]);
        var wz = warpNoise(x * freq * 0.7 + offW[2], y * freq * 0.7 + offW[0], z * freq * 0.7 + offW[1]);
        var along = wx * x + wy * y + wz * z;
        var amp = warp * 0.35;
        dx = x + (wx - along * x) * amp;
        dy = y + (wy - along * y) * amp;
        dz = z + (wz - along * z) * amp;
        var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        dx /= len; dy /= len; dz /= len;
      }
      var elev = fbm(elevNoise, dx * freq + offE[0], dy * freq + offE[1], dz * freq + offE[2], octaves, lacunarity, gain);
      var moist = fbm(moistNoise, dx * freq * 1.35 + offM[0], dy * freq * 1.35 + offM[1], dz * freq * 1.35 + offM[2], Math.max(2, octaves - 1), lacunarity, gain);
      // Температура: ось Y — полярная. q = sqrt(1 - y²) — прокси инсоляции без тригонометрии.
      var q = Math.sqrt(Math.max(0, 1 - y * y));
      var tn = tempNoise(x * 1.6 + offT[0], y * 1.6 + offT[1], z * 1.6 + offT[2]);
      var temp = 0.72 * q + 0.28 * (tn * 0.5 + 0.5) - 0.22 * Math.max(0, elev);
      if (temp < 0) temp = 0; else if (temp > 1) temp = 1;
      out[0] = elev;
      out[1] = moist * 0.5 + 0.5;
      out[2] = temp;
      return out;
    }

    return { sample: sample, masterSeed: master, kind: kind };
  }

  var api = {
    makeNoise: makeNoise,
    fbm: fbm,
    createSampler: createSampler,
    stringSeed: stringSeed,
    hash32: hash32
  };
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanetNoise = api;
})(typeof window !== 'undefined' ? window : globalThis);
