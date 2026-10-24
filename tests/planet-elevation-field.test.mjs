import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PlanetGeography = require('../site/shared/planet-geography.ts').default;
const PlanetNoise = require('../site/shared/planet-noise.ts').default;
const { sampleElevation, sampleElevationBoth, ELEVATION_SCALE_M } =
  require('../site/shared/planet-elevation-field.ts');

const SEED = '0123456789abcdef';
// Unit directions; sampleElevation normalizes внутри себя.
const DIRS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1].map((v) => v / Math.sqrt(3))];
const EARTH_RADIUS_M = PlanetGeography.EARTH_RADIUS_KM * 1000;

function sampleFieldsElevation(sampler, dx, dy, dz) {
  const out = new Float32Array(6);
  sampler.sampleFields(dx, dy, dz, out);
  return out[0];
}

// Точная копия логики planet-elevation-field.ts для независимой проверки
// обрезки октав по Найквисту (без использования проверяемого модуля).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offsetVector(seed) {
  const rand = mulberry32(seed);
  return [(rand() * 2 - 1) * 256, (rand() * 2 - 1) * 256, (rand() * 2 - 1) * 256];
}

function expectedElevationM(dx, dy, dz, baseOctaves) {
  const ratio = 1;
  const noiseE = PlanetNoise.makeNoise('simplex', PlanetGeography.domainSeed(SEED, 'elevation'));
  const noiseP = PlanetNoise.makeNoise('simplex', PlanetGeography.domainSeed(SEED, 'plates'));
  const noiseD = PlanetNoise.makeNoise('simplex', PlanetGeography.domainSeed(SEED, 'detail'));
  const noiseW = PlanetNoise.makeNoise('simplex', PlanetGeography.domainSeed(SEED, 'warp'));
  const offE = offsetVector(PlanetGeography.domainSeed(SEED, 'offset:elevation'));
  const offP = offsetVector(PlanetGeography.domainSeed(SEED, 'offset:plates'));
  const offD = offsetVector(PlanetGeography.domainSeed(SEED, 'offset:detail'));
  const offW = offsetVector(PlanetGeography.domainSeed(SEED, 'offset:warp'));

  const [nx, ny, nz] = [dx, dy, dz];
  const warpFreq = 0.85 * ratio;
  const wx = noiseW(nx * warpFreq + offW[0], ny * warpFreq + offW[1], nz * warpFreq + offW[2]);
  const wy = noiseW(nx * warpFreq + offW[1], ny * warpFreq + offW[2], nz * warpFreq + offW[0]);
  const wz = noiseW(nx * warpFreq + offW[2], ny * warpFreq + offW[0], nz * warpFreq + offW[1]);
  const along = wx * nx + wy * ny + wz * nz;
  const warpAmp = 0.14 / Math.max(0.25, ratio);
  let vx = nx + (wx - along * nx) * warpAmp;
  let vy = ny + (wy - along * ny) * warpAmp;
  let vz = nz + (wz - along * nz) * warpAmp;
  const vlen = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= vlen;
  vy /= vlen;
  vz /= vlen;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const fbm = (noise, x, y, z, octaves, gain) => {
    if (octaves <= 0) return 0;
    return PlanetNoise.fbm(noise, x, y, z, octaves, 2.0, gain);
  };
  const base = fbm(
    noiseE, vx * 2.15 * ratio + offE[0], vy * 2.15 * ratio + offE[1], vz * 2.15 * ratio + offE[2],
    baseOctaves, 0.5,
  );
  const plate = fbm(noiseP, nx * 1.12 * ratio + offP[0], ny * 1.12 * ratio + offP[1], nz * 1.12 * ratio + offP[2], 3, 0.52);
  const detail = fbm(noiseD, vx * 9.0 * ratio + offD[0], vy * 9.0 * ratio + offD[1], vz * 9.0 * ratio + offD[2], 2, 0.55);
  const elev = clamp(0.74 * base + 0.30 * plate + 0.10 * detail, -1, 1);
  return elev * ELEVATION_SCALE_M;
}

test('sampleElevation детерминирован, конечен и в диапазоне поля ±ELEVATION_SCALE_M', () => {
  const values = [];
  for (const d of DIRS) {
    const a = sampleElevation(d, 1);
    const b = sampleElevation(d, 1);
    assert.equal(a, b, 'детерминизм');
    assert.ok(Number.isFinite(a));
    assert.ok(a >= -ELEVATION_SCALE_M && a <= ELEVATION_SCALE_M, 'диапазон поля');
    values.push(a);
  }
  assert.ok(new Set(values).size > 1, 'разные направления дают разную высоту');
});

test('sampleElevation совпадает с PlanetGeography.sampleFields при extraOctaves = 0 (тонкий шаг)', () => {
  const sampler = PlanetGeography.createFieldSampler({ masterSeedHex: SEED });
  for (const d of DIRS) {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    const expected = sampleFieldsElevation(sampler, d[0] / len, d[1] / len, d[2] / len) * ELEVATION_SCALE_M;
    const actual = sampleElevation(d, 1);
    assert.ok(Math.abs(actual - expected) < 0.01, `разница при направлении ${d}: ${actual} vs ${expected}`);
  }
});

test('шаг за пределы Найквиста обрезает все октавы — плоскость в ноль', () => {
  assert.equal(sampleElevation([1, 0, 0], 1e12), 0);
  assert.equal(sampleElevation([0, 0, 1], 1e10), 0);
});

test('обрезка по Найквисту: stepM = 600 км оставляет 4 базовые октавы (пластины 3, деталь 2)', () => {
  const expected = expectedElevationM(1, 0, 0, 4);
  const actual = sampleElevation([1, 0, 0], 600_000);
  assert.ok(Math.abs(actual - expected) < 0.01, `разница: ${actual} vs ${expected}`);
  // Более грубый шаг не даёт большей детализации: при 700 км те же 4 октавы базы.
  assert.equal(sampleElevation([1, 0, 0], 700_000), sampleElevation([1, 0, 0], 600_000));
});

test('непрерывность поля: соседние точки на 1 м отличаются <= 1 м', () => {
  const R = EARTH_RADIUS_M;
  const pairs = [];
  // экватор, меридиан 0 и +1 м
  pairs.push([[1, 0, 0], [Math.cos(1 / R), Math.sin(1 / R), 0]]);
  // широта 45 deg, точка и та же точка со сдвигом по долготе +0.5 м
  const lat = Math.PI / 4;
  const dl = 0.5 / R;
  pairs.push([[Math.cos(lat), 0, Math.sin(lat)], [Math.cos(lat) * Math.cos(dl), Math.cos(lat) * Math.sin(dl), Math.sin(lat)]]);
  for (const [p, q] of pairs) {
    const diff = Math.abs(sampleElevation(q, 1) - sampleElevation(p, 1));
    assert.ok(diff <= 1, `разница на 1 м = ${diff} м`);
  }
});

test('sampleElevationBoth разделяет сушу и океан по нулевому уровню', () => {
  for (const d of DIRS) {
    const both = sampleElevationBoth(d, 1);
    const direct = sampleElevation(d, 1);
    assert.ok(both.landM >= 0, 'landM >= 0');
    assert.ok(both.oceanM <= 0, 'oceanM <= 0');
    assert.ok(both.landM === 0 || both.oceanM === 0, 'ровно одна сторона ненулевая');
    assert.equal(both.landM + both.oceanM, direct, 'сумма равна полной высоте');
  }
});

test('профиль: extraOctaves по умолчанию 0, валидация входных значений', () => {
  assert.equal(PlanetGeography.normalizeProfile({ masterSeedHex: SEED }).extraOctaves ?? 0, 0);
  assert.equal(PlanetGeography.normalizeProfile({ extraOctaves: 24 }).extraOctaves, 24);
  assert.equal(PlanetGeography.normalizeProfile({ extra_octaves: '8' }).extraOctaves, 8);
  assert.throws(() => PlanetGeography.normalizeProfile({ extraOctaves: -1 }), /extraOctaves/);
  assert.throws(() => PlanetGeography.normalizeProfile({ extraOctaves: 1.5 }), /extraOctaves/);
  assert.throws(() => PlanetGeography.normalizeProfile({ extraOctaves: 1e100 }), /extraOctaves/);
});

test('createFieldSampler: extraOctaves = 0 побитово как без параметра', () => {
  const a = PlanetGeography.createFieldSampler({ masterSeedHex: SEED });
  const b = PlanetGeography.createFieldSampler({ masterSeedHex: SEED, extraOctaves: 0 });
  const outA = new Float32Array(6);
  const outB = new Float32Array(6);
  for (const d of DIRS) {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    a.sampleFields(d[0] / len, d[1] / len, d[2] / len, outA);
    b.sampleFields(d[0] / len, d[1] / len, d[2] / len, outB);
    assert.deepEqual(Array.from(outA), Array.from(outB));
  }
});

test('extraOctaves = 24 меняет поле по сравнению с 0 и с 8', () => {
  const s0 = PlanetGeography.createFieldSampler({ masterSeedHex: SEED, extraOctaves: 0 });
  const s8 = PlanetGeography.createFieldSampler({ masterSeedHex: SEED, extraOctaves: 8 });
  const s24 = PlanetGeography.createFieldSampler({ masterSeedHex: SEED, extraOctaves: 24 });
  const out0 = new Float32Array(6);
  const out8 = new Float32Array(6);
  const out24 = new Float32Array(6);
  let changed0to24 = 0;
  let changed8to24 = 0;
  for (const d of DIRS) {
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    s0.sampleFields(d[0] / len, d[1] / len, d[2] / len, out0);
    s8.sampleFields(d[0] / len, d[1] / len, d[2] / len, out8);
    s24.sampleFields(d[0] / len, d[1] / len, d[2] / len, out24);
    if (out0[0] !== out24[0]) changed0to24++;
    if (out8[0] !== out24[0]) changed8to24++;
  }
  assert.ok(changed0to24 > 0, 'extraOctaves = 24 виден на сэмплировании');
  assert.ok(changed8to24 > 0, 'от 8 до 24 октав тоже виден');
});

test('generateGeography с extraOctaves: 24 валиден (сетка не ломается)', () => {
  const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
  const grid = GeodesicGrid.build(16);
  const geography = PlanetGeography.generateGeography(grid, {
    masterSeedHex: SEED,
    continentMeanCells: 200,
    oceanBasinMeanCells: 800,
    drainageMeanCells: 24,
    extraOctaves: 24,
  });
  const validation = PlanetGeography.validateGeography(grid, geography);
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
});
