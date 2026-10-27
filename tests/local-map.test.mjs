/* Node-тест контракта сшивки патча локальной карты с 7 каноническими ячейками
   глобуса (Инвариант И-3, CR-01 PR 5). Запуск: node --test tests/local-map.test.mjs
   (подключён в .github/workflows/check.yml).
   --------------------------------------------------------------------------
   Проверяет: сборку патча из 7 ячеек (центр + 6 соседей grid.neighbors),
   координатное тождество через единый 3D-сэмплер planet-core/planet-geography,
   удержание затопления озёр filledElevation (c100-soft-v2), топологию рек
   через общие рёбра (flowReceiver / riverAccumulation / streamWeight) и
   маску запрета спавна buildingSpawnMask (вода, озёра, русла, склоны). */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const LocalMapContract = require('../src/local-map/local-map-contract.ts');

const V = 16;
const EPS = 1e-6;

// Профиль повторяет tests/planet-globe.test.mjs: нормы v=16 как доля
// канонической Земли v=128 — тот же физический масштаб, что у LOD-прокси.
const INPUT = {
  masterSeedHex: '0123456789abcdef',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
};

const grid = GeodesicGrid.build(V);
const surface = PlanetSurface.generateSurface(grid, INPUT);
// Сэмплер опрашивает БАЗОВЫЕ поля c100-soft-v1 (E/M/T/P/V/D/W): поверхность
// c100-soft-v2 строится поверх них, и глобус использует тот же сэмплер.
// Stage-8.10b (A-12b): сэмплер поднимает полное ядро через ленивый
// динамический импорт — создание ассинхронно, await на верхнем уровне ESM.
const sampler = await LocalMapContract.createPatchFieldSampler({ ...INPUT, geographyVersion: 'c100-soft-v1' });

function isHex(cell) {
  return grid.neighborCount[cell] === 6;
}

/** Речной центр: шестиугольник с руслом и хотя бы одним входом-притоком. */
function pickRiverCenter() {
  let best = -1;
  let bestAcc = -1;
  for (let c = 0; c < grid.cellCount; c++) {
    if (!isHex(c) || surface.streamWeight[c] <= 0) continue;
    let inlets = 0;
    for (let k = 0; k < 6; k++) {
      const nb = grid.neighbors[c * 6 + k];
      if (surface.flowReceiver[nb] === c) inlets++;
    }
    if (inlets > 0 && surface.flowAccumulationKm2[c] > bestAcc) {
      bestAcc = surface.flowAccumulationKm2[c];
      best = c;
    }
  }
  return best;
}

/** Сухой центр: не вода, не озеро, не русло, пологий, достаточно суша. */
function pickDryCenter() {
  for (let c = 0; c < grid.cellCount; c++) {
    if (!isHex(c)) continue;
    if (surface.elevation[c] < surface.seaLevel) continue;
    if (surface.lakeWeight[c] > 0) continue;
    if (surface.streamWeight[c] > 0) continue;
    if (surface.slope[c] >= LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE.maxSlope) continue;
    if (surface.muLand[c] < LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE.minLand) continue;
    return c;
  }
  return -1;
}

const riverCenter = pickRiverCenter();
const dryCenter = pickDryCenter();
const lakeCells = [];
for (let c = 0; c < grid.cellCount; c++) {
  if (surface.lakeWeight[c] > 0 && isHex(c)) lakeCells.push(c);
}

const riverPatch = LocalMapContract.buildPatch7(grid, surface, riverCenter);

test('local-map-patch-v1: патч собирается из 7 канонических ячеек (центр + 6 соседей)', () => {
  assert.ok(riverCenter >= 0, 'нужен речной центр с притоками');
  assert.equal(riverPatch.version, 'local-map-patch-v1');
  assert.equal(riverPatch.v, V);
  assert.equal(riverPatch.centerCell, riverCenter);
  assert.equal(riverPatch.cells.length, 7);
  assert.equal(riverPatch.seaLevel, surface.seaLevel);
  assert.equal(riverPatch.radiusKm, surface.radiusKm);

  const [center, ...neighbors] = riverPatch.cells;
  assert.equal(center.role, 'center');
  assert.equal(center.slot, -1);
  assert.equal(center.cell, riverCenter);
  assert.equal(neighbors.length, 6);
  for (let slot = 0; slot < 6; slot++) {
    const cell = neighbors[slot];
    assert.equal(cell.role, 'neighbor');
    assert.equal(cell.slot, slot);
    assert.equal(cell.cell, grid.neighbors[riverCenter * 6 + slot]);
  }
  assert.equal(new Set(riverPatch.cells.map((cell) => cell.cell)).size, 7, 'ячейки патча уникальны');

  // Канонические поля c100-soft-v2 перенесены без потерь.
  for (const cell of riverPatch.cells) {
    assert.equal(cell.elevation, surface.elevation[cell.cell]);
    assert.equal(cell.filledElevation, surface.filledElevation[cell.cell]);
    assert.equal(cell.lakeWeight, surface.lakeWeight[cell.cell]);
    assert.equal(cell.streamWeight, surface.streamWeight[cell.cell]);
    assert.equal(cell.riverAccumulation, surface.flowAccumulationKm2[cell.cell]);
    assert.equal(cell.flowReceiver, surface.flowReceiver[cell.cell]);
    assert.ok(cell.filledElevation >= cell.elevation - EPS, 'filledElevation не ниже сырого дна');
  }

  // Пятиугольникам патч не собирается (кольцо из 6 граней).
  const pentagon = grid.pentagons > 0 ? grid.neighborCount.indexOf(5) : -1;
  if (pentagon >= 0) {
    assert.throws(() => LocalMapContract.buildPatch7(grid, surface, pentagon), /шестиугольной/);
  }
});

test('И-3.1: координатное тождество — (u, v) идёт через тот же 3D-сэмплер, что и глобус', () => {
  const center = riverPatch.cells[0];

  // Центр касательного кадра — ровно 3D-центр канонической ячейки.
  const origin = LocalMapContract.localPointToDirection(riverPatch, 0, 0);
  assert.deepEqual(Array.from(origin), Array.from(center.center));
  assert.ok(Math.abs(Math.hypot(...origin) - 1) < 1e-6, 'направление единичное');

  // (0, 0) через patch-сэмплер == прямой sampleFields центра ячейки.
  const direct = sampler.sampleFields(center.center[0], center.center[1], center.center[2]);
  const viaPatch = LocalMapContract.samplePatchFields(riverPatch, sampler, 0, 0);
  assert.deepEqual(Array.from(viaPatch), Array.from(direct));

  // Несколько точек (u, v): направление из обратной касательной проекции
  // опрашивается ТЕМ ЖЕ сэмплером (единая цепочка planet-core/planet-geography).
  assert.equal(direct.length, LocalMapContract.FIELD_CHANNELS.length);
  for (const [u, v] of [[500, 0], [0, 500], [-300, 250], [1200, -1200]]) {
    const dir = LocalMapContract.localPointToDirection(riverPatch, u, v);
    assert.ok(Math.abs(Math.hypot(...dir) - 1) < 1e-6, `единичный вектор (${u}, ${v})`);
    const expected = sampler.sampleFields(dir[0], dir[1], dir[2]);
    const actual = LocalMapContract.samplePatchFields(riverPatch, sampler, u, v);
    assert.deepEqual(Array.from(actual), Array.from(expected), `тот же сэмплер в (${u}, ${v})`);
  }
});

test('И-3.2: filledElevation держит затопление озёр c100-soft-v2, озёра остаются водой', () => {
  assert.ok(lakeCells.length > 0, 'в детерминированном мире v=16 есть хотя бы одно озеро');

  for (const lakeCell of lakeCells) {
    const patch = LocalMapContract.buildPatch7(grid, surface, lakeCell);
    for (const cell of patch.cells) {
      // Уровень затопления не ниже сырого дна: впадина остаётся залитой.
      assert.ok(cell.filledElevation >= cell.elevation - EPS, `filled >= elevation у ячейки ${cell.cell}`);
      assert.ok(cell.depressionDepth >= -EPS, 'depressionDepth не отрицателен');
      if (cell.lakeWeight > 0) {
        // Озеро (включая переполняющееся и терминальное) — всегда вода.
        assert.ok(LocalMapContract.isWaterCell(cell, patch.seaLevel), `озеро ${cell.cell} — вода`);
        const water = LocalMapContract.waterLevelOf(cell, patch.seaLevel);
        assert.ok(water >= cell.filledElevation - EPS, 'уровень воды держит filledElevation');
        assert.equal(LocalMapContract.baseElevationOf(cell), cell.filledElevation, 'базовая высота — filledElevation');
      }
      if (cell.depressionDepth > EPS) {
        // Залитая впадина: сухого дна ниже уровня нет.
        assert.ok(cell.filledElevation > cell.elevation, 'впадина залита, а не сухая');
      }
    }
    // Базовая высота точки (0, 0) — filledElevation центральной ячейки.
    assert.equal(
      LocalMapContract.patchBaseElevation(patch, 0, 0),
      patch.cells[0].filledElevation,
    );
  }
});

test('И-3.3: реки строго через общие рёбра — flowReceiver / riverAccumulation / streamWeight', () => {
  const { river } = riverPatch;
  const center = riverPatch.cells[0];

  assert.equal(river.centerCell, riverCenter);
  assert.equal(river.flowsThroughCenter, center.streamWeight > 0);
  assert.ok(river.flowsThroughCenter, 'центр выбран с руслом');
  assert.equal(river.centerStreamWeight, center.streamWeight);
  assert.equal(river.centerRiverAccumulation, center.riverAccumulation);

  // Входы строго со стороны граней соседей-источников: flowReceiver[nb] == cell.
  assert.ok(river.inlets.length > 0, 'у речного центра есть притоки');
  for (const edge of river.inlets) {
    const slotCell = riverPatch.cells[edge.slot + 1];
    assert.equal(slotCell.cell, edge.neighborCell, 'край входа — грань кольца патча');
    assert.equal(surface.flowReceiver[edge.neighborCell], riverCenter, 'источник указывает на центр');
    assert.equal(edge.streamWeight, surface.streamWeight[edge.neighborCell]);
    assert.equal(edge.riverAccumulation, surface.flowAccumulationKm2[edge.neighborCell]);
    assert.ok(edge.riverAccumulation > 0, 'вес притока положителен');
  }

  // Выход строго через грань получателя стока центра.
  const receiver = surface.flowReceiver[riverCenter];
  if (receiver >= 0) {
    assert.ok(river.outlet, 'у стока есть выход');
    assert.equal(river.outlet.neighborCell, receiver, 'выход — строго грань flowReceiver[center]');
    assert.equal(riverPatch.cells[river.outlet.slot + 1].cell, receiver);
    // Через выходную грань течёт вода: центр несёт положительный сток.
    assert.ok(center.riverAccumulation > 0 && center.streamWeight > 0, 'через русло течёт вода');
    // Веса выхода читаются из тех же канонических массивов c100-soft-v2.
    assert.equal(river.outlet.riverAccumulation, surface.flowAccumulationKm2[receiver]);
    assert.equal(river.outlet.streamWeight, surface.streamWeight[receiver]);
    // Устье в воде допустимо с нулевыми весами; на суше аккумуляция
    // монотонно растёт вниз по течению (вес riverAccumulation / streamWeight).
    const receiverIsWater = surface.elevation[receiver] < surface.seaLevel || surface.lakeWeight[receiver] > 0;
    if (!receiverIsWater) {
      assert.ok(river.outlet.streamWeight > 0, 'продолжение русла на суше несёт сток');
      assert.ok(river.outlet.riverAccumulation + EPS >= center.riverAccumulation,
        'аккумуляция стока не убывает вниз по течению');
    }
  } else {
    assert.equal(river.outlet, null, 'терминал не имеет выходной грани');
  }

  // Все входы и выход — только общие рёбра семёрки (никаких внешних ссылок).
  const ring = new Set(riverPatch.cells.slice(1).map((cell) => cell.cell));
  for (const edge of [...river.inlets, ...(river.outlet ? [river.outlet] : [])]) {
    assert.ok(ring.has(edge.neighborCell), 'грань ведёт к соседу из семёрки');
    assert.ok(edge.slot >= 0 && edge.slot <= 5);
  }
});

test('И-3.4: buildingSpawnMask запрещает воду, озёра, русла рек и крутые склоны', () => {
  const rule = LocalMapContract.DEFAULT_BUILDING_SPAWN_RULE;

  // Синтетические случаи маски отбраковки.
  const sample = (over) => ({
    muLand: 1, lakeWeight: 0, streamWeight: 0, slope: 0, isWater: false, ...over,
  });
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({})), true, 'сухая пологая — можно');
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({ isWater: true })), false, 'вода — нельзя');
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({ lakeWeight: 0.8 })), false, 'озеро — нельзя');
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({ streamWeight: 0.5 })), false, 'русло — нельзя');
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({ slope: rule.maxSlope + 0.1 })), false, 'склон — нельзя');
  assert.equal(LocalMapContract.buildingSpawnAllowed(sample({ muLand: rule.minLand - 0.1 })), false, 'берег/вода по muLand — нельзя');

  // Реальные ячейки патча: запрещённые категории не проходят маску.
  for (const cell of riverPatch.cells) {
    const s = LocalMapContract.spawnSampleOf(cell, riverPatch.seaLevel);
    const banned = s.isWater || s.lakeWeight > 0 || s.streamWeight > 0 ||
      s.slope >= rule.maxSlope || s.muLand < rule.minLand;
    assert.equal(
      LocalMapContract.buildingSpawnAllowed(s),
      !banned,
      `ячейка ${cell.cell}: ${banned ? 'запрещена' : 'разрешена'} согласно полям`,
    );
  }

  // Растр маски: центр речного патча (русло) запрещён.
  const riverMask = LocalMapContract.buildBuildingSpawnMask(riverPatch, 17);
  assert.equal(riverMask.length, 17 * 17);
  assert.equal(riverMask[8 * 17 + 8], 0, 'над руслом спавн запрещён');
  for (const value of riverMask) assert.ok(value === 0 || value === 1);

  // Сухой патч: хотя бы одна точка разрешена, центр — разрешён.
  assert.ok(dryCenter >= 0, 'нужен сухой пологий центр');
  const dryPatch = LocalMapContract.buildPatch7(grid, surface, dryCenter);
  const dryMask = LocalMapContract.buildBuildingSpawnMask(dryPatch, 17);
  assert.equal(dryMask[8 * 17 + 8], 1, 'над сухой пологой землёй спавн разрешён');
  assert.ok(dryMask.some((value) => value === 1), 'в сухом патче есть разрешённые точки');
});

test('verifyPatchInvariants: все проверки И-3 зелёные на речном и озёрном патчах', () => {
  const patches = [riverPatch];
  for (const lakeCell of lakeCells.slice(0, 1)) {
    patches.push(LocalMapContract.buildPatch7(grid, surface, lakeCell));
  }
  for (const patch of patches) {
    const report = LocalMapContract.verifyPatchInvariants(patch);
    assert.equal(report.ok, true, `И-3 отчёт: ${JSON.stringify(report.checks)}`);
    for (const key of ['patch7-shape', 'tangent-identity', 'flood-hold', 'river-topology', 'spawn-ban']) {
      assert.equal(report.checks[key], true, `проверка ${key}`);
    }
  }
});

/* ---------------------------------------------------------------
   Stage-8.10b (A-12b): разрыв цепочки ядра в контракте
   -------------------------------------------------------------
   Контракт больше не value-импортирует planet-geography на верхнем
   уровне: константы взяты из planet-geography-constants.ts (без ядра),
   а полное ядро поднимается лениво через динамический import() внутри
   createPatchFieldSampler. planet-geography по-прежнему отдаёт
   константы через объект — внешние импорты не ломаются.
   --------------------------------------------------------------- */

test('Stage-8.10b: контракт не тащит ядро на верхнем уровне, константы — из constants-модуля', async () => {
  const contract = readFileSync(
    new URL('../src/local-map/local-map-contract.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    !/^import PlanetGeography from '.*planet-geography\.ts';$/m.test(contract),
    'в контракте не должно быть value-импорта PlanetGeography на верхнем уровне',
  );
  assert.match(
    contract,
    /import \{ EARTH_CANONICAL_V, GEOGRAPHY_VERSION \} from '.*planet-geography-constants\.ts';/,
    'константы берутся из planet-geography-constants.ts',
  );
  assert.match(
    contract,
    /export async function createPatchFieldSampler/,
    'createPatchFieldSampler ассинхронный (ленивый динамический импорт ядра)',
  );
  assert.match(
    contract,
    /import\('\.\.\/\.\.\/site\/shared\/planet-geography\.ts'\)/,
    'ядро поднимается динамическим импортом внутри createPatchFieldSampler',
  );

  // Переснято под поле c100-soft-v3 (W28b, PR #235): версия географии поднята
  // `c100-soft-v1` → `c100-soft-v3` намеренно, контракт
  // `src/contracts/planet-generation-contract.json` принимает v1/v2/v3,
  // default остаётся `c100-soft-v2` (docs/stages/stage-08/notes/w28-field-results.md §7).
  // Смысл проверки не изменился: constants-модуль и объект PlanetGeography
  // отдают ОДНУ И ТУ ЖЕ действующую версию, а не историческую.
  const constants = require('../site/shared/planet-geography-constants.ts');
  assert.equal(constants.EARTH_CANONICAL_V, 128);
  assert.equal(constants.GEOGRAPHY_VERSION, 'c100-soft-v3');
  const contractJson = JSON.parse(readFileSync(
    new URL('../src/contracts/planet-generation-contract.json', import.meta.url),
    'utf8',
  ));
  assert.ok(
    contractJson.supported_versions.geography_version.includes(constants.GEOGRAPHY_VERSION),
    'действующая версия географии объявлена в контракте',
  );

  const PlanetGeography = require('../site/shared/planet-geography.ts').default;
  assert.equal(PlanetGeography.EARTH_CANONICAL_V, 128, 'объект по-прежнему отдаёт EARTH_CANONICAL_V');
  assert.equal(
    PlanetGeography.GEOGRAPHY_VERSION,
    constants.GEOGRAPHY_VERSION,
    'объект по-прежнему отдаёт действующую GEOGRAPHY_VERSION',
  );

  // Сэмплер через контракт даёт тот же результат (побитово — golden-тест в stage8).
  // Профиль запрашивает legacy v1: совместимость старых профилей обязана сохраняться.
  const sampler = await LocalMapContract.createPatchFieldSampler({ ...INPUT, geographyVersion: 'c100-soft-v1' });
  const probe = [0.31, -0.52, 0.79];
  const fields = sampler.sampleFields(probe[0], probe[1], probe[2]);
  assert.equal(fields.length, 6, 'сэмплер отдаёт 6 каналов');
  assert.ok(fields.every((value) => Number.isFinite(value)), 'сэмплер даёт конечные значения');
});
