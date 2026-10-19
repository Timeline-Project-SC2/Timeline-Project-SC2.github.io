// Модель «детализация vs оптимизация» для спайка Этапа 1:
// стоимость сетки Голдберга и полей на плотностях от текущей «Земли» (v=64)
// до ×8–9 (v=181/192), плюс аналитическая стоимость GPU-геометрии в трёх
// вариантах раскладки буферов. Запуск: node --expose-gc tools/bench_planet_density.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');
const PlanetNoise = require('../site/shared/planet-noise.js');

const EARTH_R = 6371;
const EARTH_AREA = 4 * Math.PI * EARTH_R * EARTH_R; // км²

function typedBytes(obj) {
  let sum = 0;
  for (const val of Object.values(obj)) {
    if (ArrayBuffer.isView(val)) sum += val.byteLength;
  }
  return sum;
}

function fmt(n) { return Math.round(n).toLocaleString('ru-RU'); }
function mb(bytes) { return (bytes / 1048576).toFixed(1); }

// Геометрия: F ячеек (12 пятиугольников), S = сумма сторон = 6F-12.
// A — текущий веер из центра: вершины F+S, 11 float (pos3+col3+centerW+center3+birth),
//     индексы 3S uint32, треугольников S.
// B — веер из угла без центральной вершины: вершины S, 10 float (без centerW),
//     треугольников 4F-12, индексы 3×(4F-12).
// C — B + упакованный цвет/birth в uint32: 28 байт/вершина.
// Атмосфера во всех вариантах: центры 3F float + индексы первичной триангуляции 60v² uint32.
function gpuModel(F, v) {
  const S = 6 * F - 12;
  const atmo = F * 3 * 4 + 60 * v * v * 4;
  const a = (F + S) * 44 + S * 3 * 4 + atmo;
  const b = S * 40 + (4 * F - 12) * 3 * 4 + atmo;
  const c = S * 28 + (4 * F - 12) * 3 * 4 + atmo;
  return { trisA: S, trisB: 4 * F - 12, vertsA: F + S, vertsB: S, a, b, c };
}

// Прогрев JIT на мелкой сетке.
GeodesicGrid.build(16);

console.log('v | ячеек | сетка мс | поля мс | pick мкс | сетка RAM МБ | ' +
  'ячейка Земли км² | ребро км | трис A/B | GPU МБ A/B/C');
for (const v of [64, 100, 128, 160, 181, 192]) {
  if (global.gc) global.gc();
  const t0 = Date.now();
  const grid = GeodesicGrid.build(v);
  const msBuild = Date.now() - t0;
  const val = GeodesicGrid.validate(grid);
  if (!val.ok) { console.log(`v=${v}: FAIL validate ${JSON.stringify(val.checks)}`); continue; }

  const sampler = PlanetNoise.createSampler(
    { seedText: 'korhal-iv', kind: 'simplex', freq: 2.2, octaves: 5, gain: 0.5, warp: 0.35 });
  const out = [0, 0, 0];
  let acc = 0;
  const t1 = Date.now();
  for (let c = 0; c < grid.cellCount; c++) {
    sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
    acc += out[0];
  }
  const msFields = Date.now() - t1;

  // pick: полный перебор по центрам, 200 направлений Фибоначчи.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const t2 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) {
    const y = 1 - (i / 199) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    acc += GeodesicGrid.pick(grid, [Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  const pickUs = Number(process.hrtime.bigint() - t2) / 1000 / 200;

  const F = grid.cellCount;
  const g = gpuModel(F, v);
  const cellKm2 = EARTH_AREA / F;
  const edgeKm = Math.sqrt(2 * cellKm2 / (3 * Math.sqrt(3)));
  console.log(
    `${v} | ${fmt(F)} | ${msBuild} | ${msFields} | ${pickUs.toFixed(0)} | ${mb(typedBytes(grid))} | ` +
    `${fmt(cellKm2)} | ${edgeKm.toFixed(1)} | ${fmt(g.trisA)}/${fmt(g.trisB)} | ` +
    `${mb(g.a)}/${mb(g.b)}/${mb(g.c)}   (acc=${acc.toFixed(1)})`);
}
console.log('\nA — текущий веер из центра; B — веер из угла (4 трис/ячейка); C — B + упакованный цвет.');
