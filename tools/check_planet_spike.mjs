// Проверка спайка Этапа 1 без браузера: топология сетки Голдберга,
// детерминированность шума и статистика полей на контрольных частотах.
// Запуск: node tools/check_planet_spike.mjs
// В CI не подключено — это инструмент спайка, а не боевой тест сайта.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetNoise = require('../site/shared/planet-noise.ts').default;
// И-5: логика спайка живёт в строгом TS-модуле плагина FX, легаси-JS удалён.
const PlanetGeometry = require('../src/planet/planet-globe-fx.ts');

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

console.log('== Топология ==');
for (const v of [1, 4, 16, 32, 64]) {
  const t = Date.now();
  const grid = GeodesicGrid.build(v);
  const ms = Date.now() - t;
  const val = GeodesicGrid.validate(grid);
  check(`v=${v}`, val.ok,
    `ячеек ${grid.cellCount}, треугольников ${grid.triangleCount}, пятиугольников ${grid.pentagons}, ` +
    `сумма площадей ${val.areaSum.toFixed(6)} (4π=${(4 * Math.PI).toFixed(6)}), построение ${ms} мс, ` +
    JSON.stringify(val.checks));
}

console.log('\n== Детерминированность шума ==');
for (const kind of ['simplex', 'value']) {
  const a = PlanetNoise.createSampler({ seedText: 'korhal-iv', kind });
  const b = PlanetNoise.createSampler({ seedText: 'korhal-iv', kind });
  const outA = [0, 0, 0];
  const outB = [0, 0, 0];
  let same = true;
  let inRange = true;
  // Точки — направления из детерминированной последовательности Фибоначчи на сфере.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < 2000; i++) {
    const y = 1 - (i / 1999) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    a.sample(x, y, z, outA);
    b.sample(x, y, z, outB);
    if (outA[0] !== outB[0] || outA[1] !== outB[1] || outA[2] !== outB[2]) same = false;
    if (!(outA[0] >= -1.000001 && outA[0] <= 1.000001 && outA[1] >= 0 && outA[1] <= 1 && outA[2] >= 0 && outA[2] <= 1)) inRange = false;
  }
  check(`${kind}: одинаковые результаты двух сэмплеров`, same);
  check(`${kind}: диапазоны полей`, inRange);
  // Golden value: фиксирует контракт этой версии шума. Меняется осознанно.
  a.sample(0.2672612419124244, 0.5345224838248488, 0.8017837257372732, outA);
  console.log(`     golden ${kind}: elev=${outA[0].toFixed(8)} moist=${outA[1].toFixed(8)} temp=${outA[2].toFixed(8)}`);
}

function landmassStats(grid, elev, sea) {
  const F = grid.cellCount;
  const visited = new Uint8Array(F);
  const sizes = [];
  let landCells = 0;
  const stack = [];
  for (let c = 0; c < F; c++) {
    if (visited[c] || elev[c] <= sea) continue;
    let size = 0;
    stack.length = 0;
    stack.push(c);
    visited[c] = 1;
    while (stack.length) {
      const u = stack.pop();
      size++;
      landCells++;
      for (let n = 0; n < grid.neighborCount[u]; n++) {
        const v = grid.neighbors[u * 6 + n];
        if (!visited[v] && elev[v] > sea) { visited[v] = 1; stack.push(v); }
      }
    }
    sizes.push(size);
  }
  sizes.sort((x, y) => x - y);
  const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0);
  return {
    count: sizes.length,
    landCells,
    median: pct(0.5),
    p90: pct(0.9),
    max: sizes.length ? sizes[sizes.length - 1] : 0,
  };
}

console.log('\n== Поля и массивы суши (процентиль океана 70%) ==');
for (const v of [34, 64, 100]) {
  const grid = GeodesicGrid.build(v);
  for (const kind of ['simplex', 'value']) {
    const sampler = PlanetNoise.createSampler({ seedText: 'korhal-iv', kind, freq: 2.2, octaves: 5, gain: 0.5, warp: 0.35 });
    const elev = new Float32Array(grid.cellCount);
    const out = [0, 0, 0];
    const t = Date.now();
    for (let c = 0; c < grid.cellCount; c++) {
      sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
      elev[c] = out[0];
    }
    const ms = Date.now() - t;
    const sorted = Array.from(elev).sort((x, y) => x - y);
    const sea = sorted[Math.floor(sorted.length * 0.7)];
    const st = landmassStats(grid, elev, sea);
    const landPct = (st.landCells / grid.cellCount * 100).toFixed(1);
    const maxShare = st.landCells ? (st.max / st.landCells * 100).toFixed(0) : '0';
    check(`v=${v} ${kind}: поля за ${ms} мс`, ms > 0,
      `суша ${landPct}%, массивов ${st.count}, медиана ${st.median}, P90 ${st.p90}, макс ${st.max} (${maxShare}% суши)`);
  }
}

console.log('\n== Геометрия поверхности и объёма осколков ==');
{
  const grid = GeodesicGrid.build(16);
  const sampler = PlanetNoise.createSampler({
    seedText: 'korhal-iv', kind: 'simplex', freq: 2.2, octaves: 5, gain: 0.5, warp: 0.35,
  });
  const elev = new Float32Array(grid.cellCount);
  const moist = new Float32Array(grid.cellCount);
  const temp = new Float32Array(grid.cellCount);
  const out = [0, 0, 0];
  let minE = Infinity;
  let maxE = -Infinity;
  for (let c = 0; c < grid.cellCount; c++) {
    sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
    elev[c] = out[0]; moist[c] = out[1]; temp[c] = out[2];
    minE = Math.min(minE, out[0]); maxE = Math.max(maxE, out[0]);
  }
  const t = Date.now();
  const geom = PlanetGeometry.buildGeometry(
    grid,
    { elev, moist, temp, sea: 0, minE, maxE, masterSeed: sampler.masterSeed },
    { count: 10, dist: 'power', sep: 0.3, thick: 0.14, jag: 0.5, loss: 0, seedText: 'korhal-iv' },
    PlanetNoise,
    { includeVolume: true },
  );
  const surface = geom.surface;
  const volume = geom.volume;
  let surfaceIndicesOk = surface.cellIndexStart[grid.cellCount] === surface.indexCount;
  for (let i = 0; i < surface.indices.length; i++) {
    if (surface.indices[i] >= surface.vertexCount) surfaceIndicesOk = false;
  }
  let volumeIndicesOk = !!volume && volume.indexCount % 3 === 0;
  const volumeVerts = volume ? volume.positions.length / 3 : 0;
  if (volume) {
    for (let i = 0; i < volume.indices.length; i++) {
      if (volume.indices[i] >= volumeVerts) volumeIndicesOk = false;
    }
  }
  check('v=16: поверхность', surface.vertexCount === grid.cellCount + grid.cellCorners.length &&
    surface.indexCount === grid.cellCorners.length * 3 && surfaceIndicesOk,
    `вершин ${surface.vertexCount}, индексов ${surface.indexCount}, построение ${Date.now() - t} мс`);
  check('v=16: объём осколков', volumeIndicesOk && volumeVerts > grid.cellCount,
    `вершин ${volumeVerts}, индексов ${volume ? volume.indexCount : 0}`);
}

console.log(failures ? `\nИТОГО: ${failures} провалов` : '\nИТОГО: все проверки пройдены');
process.exit(failures ? 1 : 0);
