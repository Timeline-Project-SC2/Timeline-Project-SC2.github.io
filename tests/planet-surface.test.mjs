import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');
const PlanetGeography = require('../site/shared/planet-geography.js');
const PlanetSurface = require('../site/shared/planet-surface.js');

const EARTH_SEED = '0123456789abcdef';
const SMALL_INPUT = {
  masterSeedHex: EARTH_SEED,
  radiusKm: 6371,
  continentMeanCells: 100,
  oceanBasinMeanCells: 500,
  drainageMeanCells: 18,
};

function surfaceSnapshot(surface) {
  const snapshot = {};
  for (const name of PlanetSurface.ARRAY_FIELDS) snapshot[name] = Array.from(surface[name]);
  return snapshot;
}

function hardLandCells(surface) {
  const cells = [];
  for (let c = 0; c < surface.cellCount; c++) {
    if (surface.catchmentId[c] >= 0) cells.push(c);
  }
  return cells;
}

function biomeFraction(surface, key) {
  return surface.stats.biomes.fractions.find((item) => item.key === key);
}

test('c100-soft-v2: профиль разделяет базу, гидрологию и биомы и не принимает v1 как синоним', () => {
  const profile = PlanetSurface.normalizeSurfaceProfile({
    master_seed_hex: 'ABCDEF0123456789',
    radius_km: '6371',
    geography_version: 'c100-soft-v2',
    drainage_mean_cells: '72',
    biome_soft_width_cells: '2',
  });
  assert.equal(profile.masterSeedHex, 'abcdef0123456789');
  assert.equal(profile.geographyVersion, 'c100-soft-v2');
  assert.equal(profile.baseGeographyVersion, 'c100-soft-v1');
  assert.equal(profile.hydrologyVersion, 'planet-hydrology-v1');
  assert.equal(profile.biomeVersion, 'planet-biomes-v1');
  assert.equal(profile.drainageMeanCells, 72);
  assert.equal(PlanetSurface.DEFAULT_PROFILE.geographyVersion, 'c100-soft-v2');

  assert.throws(
    () => PlanetSurface.normalizeSurfaceProfile({ geographyVersion: 'c100-soft-v1' }),
    /только поля\/C100 Этапа 4/,
  );
  assert.throws(
    () => PlanetSurface.normalizeSurfaceProfile({ geographyVersion: 'c100-soft-v99' }),
    /geographyVersion/,
  );
  assert.throws(
    () => PlanetSurface.normalizeSurfaceProfile({ hydrologyVersion: 'planet-hydrology-v99' }),
    /hydrologyVersion/,
  );
  assert.throws(
    () => PlanetSurface.normalizeSurfaceProfile({ biomeVersion: 'planet-biomes-v99' }),
    /biomeVersion/,
  );
});

test('planet-hydrology-v1: генерация детерминирована и не меняет поля Этапа 4', () => {
  const grid = GeodesicGrid.build(16);
  const first = PlanetSurface.generateSurface(grid, SMALL_INPUT);
  const second = PlanetSurface.generateSurface(grid, SMALL_INPUT);
  const validation = PlanetSurface.validateSurface(grid, first);

  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.deepEqual(surfaceSnapshot(first), surfaceSnapshot(second));
  assert.equal(first.geographyVersion, 'c100-soft-v2');
  assert.equal(first.baseGeography.geographyVersion, 'c100-soft-v1');

  const baseOnly = PlanetGeography.generateGeography(grid, SMALL_INPUT);
  assert.deepEqual(Array.from(first.elevation), Array.from(baseOnly.elevation));
  assert.deepEqual(Array.from(first.muLand), Array.from(baseOnly.muLand));
  assert.deepEqual(Array.from(first.continentTop1Id), Array.from(baseOnly.continentTop1Id));

  const augmented = PlanetSurface.augmentGeography(grid, baseOnly);
  assert.deepEqual(surfaceSnapshot(augmented), surfaceSnapshot(first));

  // Golden-фиксация v1: изменение этих значений требует новой версии
  // гидрологии или биомов, а не молчаливой правки замороженного рецепта.
  assert.equal(first.catchments.length, 648);
  assert.equal(first.drainageRegions.length, 52);
  assert.equal(first.lakes.length, 1);
  assert.equal(first.flowReceiver[1000], 1011);
  assert.equal(first.catchmentId[1000], 227);
  assert.equal(first.drainageRegionId[1000], 25);
  assert.equal(first.biomeTop1Id[1000], 11);
  assert.equal(first.biomeTop2Id[1000], 10);
  assert.ok(Math.abs(first.thresholds.streamFlowKm2 - 128553.484375) < 1e-6);
  assert.ok(Math.abs(first.biomeTop1Weight[1000] - 0.7311058044433594) < 1e-7);

  const otherSeed = PlanetSurface.generateSurface(grid, {
    ...SMALL_INPUT,
    masterSeedHex: 'deadbeefcafebabe',
  });
  assert.notDeepEqual(Array.from(first.flowReceiver), Array.from(otherSeed.flowReceiver));
});

test('planet-hydrology-v1: граф стока ацикличен, а вся суша имеет явный терминал', () => {
  const grid = GeodesicGrid.build(16);
  const surface = PlanetSurface.generateSurface(grid, SMALL_INPUT);
  const land = hardLandCells(surface);
  assert.ok(land.length > 0);
  assert.equal(surface.stats.hydrology.landCells, land.length);
  assert.equal(surface.stats.hydrology.routedLandFraction, 1);
  assert.equal(surface.stats.hydrology.cycleBreakCount, 0);
  assert.equal(surface.stats.hydrology.uphillFilledEdgeFraction, 0);
  assert.ok(surface.stats.hydrology.uphillRawEdgeFractionOutsideDepressions <= 0.001);
  assert.ok(surface.stats.hydrology.flow.majorRiverUphillRawOutsideDepressionsFraction <= 0.01);

  const fractions = surface.stats.hydrology.terminalLandAreaFractions;
  assert.ok(Math.abs(fractions.ocean + fractions.terminalLake + fractions.endorheic - 1) < 1e-9);

  for (const start of land) {
    assert.ok(surface.catchmentId[start] >= 0);
    assert.ok(surface.drainageRegionId[start] >= 0);
    assert.ok(surface.terminalType[start] >= PlanetSurface.TERMINAL_TYPES.OCEAN);
    assert.ok(surface.terminalType[start] <= PlanetSurface.TERMINAL_TYPES.ENDORHEIC);
    assert.ok(surface.filledElevation[start] + 1e-6 >= surface.elevation[start]);
    assert.ok(Math.abs(
      surface.depressionDepth[start] -
      Math.max(0, surface.filledElevation[start] - surface.elevation[start]),
    ) < 1e-5);

    let cell = start;
    for (let steps = 0; steps <= grid.cellCount; steps++) {
      const receiver = surface.flowReceiver[cell];
      if (receiver < 0) break;
      let isNeighbor = false;
      for (let j = 0; j < grid.neighborCount[cell]; j++) {
        if (grid.neighbors[cell * 6 + j] === receiver) isNeighbor = true;
      }
      assert.equal(isNeighbor, true, `receiver ${cell}->${receiver} должен быть соседом`);
      assert.ok(surface.filledElevation[receiver] <= surface.filledElevation[cell] + 1e-9);
      if (surface.catchmentId[receiver] >= 0) {
        assert.ok(surface.flowAccumulationKm2[receiver] + 1e-3 >= surface.flowAccumulationKm2[cell]);
        assert.ok(surface.flowAccumulationCells[receiver] + 1e-5 >= surface.flowAccumulationCells[cell]);
        cell = receiver;
      } else {
        assert.equal(surface.terminalType[start], PlanetSurface.TERMINAL_TYPES.OCEAN);
        break;
      }
      assert.ok(steps < grid.cellCount, 'путь стока не должен зацикливаться');
    }
  }

  const catchmentCells = surface.catchments.reduce((sum, record) => sum + record.cellCount, 0);
  const regionCells = surface.drainageRegions.reduce((sum, record) => sum + record.cellCount, 0);
  assert.equal(catchmentCells, land.length);
  assert.equal(regionCells, land.length);
  assert.ok(surface.catchments.every((record, id) => record.id === id && record.cellCount > 0));
  assert.ok(surface.drainageRegions.every((record, id) => record.id === id && record.cellCount > 0));
  assert.ok(surface.thresholds.majorRiverFlowKm2 > surface.thresholds.streamFlowKm2);
});

test('planet-hydrology-v1: озёра согласованы с ячейками, дельты остаются у берега и шельфа', () => {
  const grid = GeodesicGrid.build(32);
  const surface = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    radiusKm: 6371,
    continentMeanCells: 180,
    oceanBasinMeanCells: 1200,
    drainageMeanCells: 24,
  });
  assert.equal(PlanetSurface.validateSurface(grid, surface).ok, true);
  assert.ok(surface.lakes.length > 0);

  const lakeCells = new Array(surface.lakes.length).fill(0);
  for (let c = 0; c < grid.cellCount; c++) {
    if (surface.lakeId[c] >= 0) {
      lakeCells[surface.lakeId[c]]++;
      assert.ok(surface.lakeWeight[c] > 0);
    } else {
      assert.equal(surface.lakeWeight[c], 0);
    }
    if (surface.deltaWeight[c] >= 0.25) {
      assert.ok(surface.signedCoastDistanceCells[c] >= -3, `дельта в открытом океане: ${c}`);
      assert.ok(surface.signedCoastDistanceCells[c] <= 2, `дельта далеко от берега: ${c}`);
    }
  }
  for (const lake of surface.lakes) {
    assert.equal(lakeCells[lake.id], lake.cellCount);
    assert.equal(surface.catchmentId[lake.representativeCell], lake.catchmentId);
    assert.ok(lake.effectiveAreaKm2 > 0);
    assert.ok(Number.isFinite(lake.maxDepth));
  }
  assert.ok(surface.stats.hydrology.deltaCellsAtWeight025 > 0);
});

test('planet-biomes-v1: мягкие top-2 смеси, энтропия и цвета согласованы', () => {
  const grid = GeodesicGrid.build(16);
  const surface = PlanetSurface.generateSurface(grid, SMALL_INPUT);
  assert.equal(PlanetSurface.BIOME_COUNT, 16);
  assert.equal(new Set(PlanetSurface.BIOME_DEFINITIONS.map((item) => item.key)).size, 16);
  assert.equal(surface.biomeDefinitions.length, 16);

  let mixedCells = 0;
  for (let c = 0; c < grid.cellCount; c++) {
    assert.ok(Math.abs(surface.biomeTop1Weight[c] + surface.biomeTop2Weight[c] - 1) < 1e-4);
    assert.ok(surface.biomeTop1Weight[c] >= surface.biomeTop2Weight[c]);
    assert.notEqual(surface.biomeTop1Id[c], surface.biomeTop2Id[c]);
    assert.ok(surface.biomeEntropy[c] >= 0 && surface.biomeEntropy[c] <= 1);
    if (surface.biomeTop2Weight[c] > 0.1) mixedCells++;
  }
  assert.ok(mixedCells > grid.cellCount * 0.2, 'биом не должен быть одним жёстким ID');

  const globalSum = surface.stats.biomes.fractions.reduce(
    (sum, item) => sum + item.globalAreaFraction, 0,
  );
  const landSum = surface.stats.biomes.fractions.reduce(
    (sum, item) => sum + item.landAreaFraction, 0,
  );
  assert.ok(Math.abs(globalSum - 1) < 1e-6);
  assert.ok(Math.abs(landSum - 1) < 1e-6);
  assert.ok(biomeFraction(surface, 'deep_ocean').globalAreaFraction > 0.2);
  assert.ok(biomeFraction(surface, 'shelf').globalAreaFraction < 0.12);
  assert.ok(biomeFraction(surface, 'boreal_forest').landAreaFraction > 0.03);
  assert.ok(surface.stats.biomes.meanEntropy > 0.15);
});

test('c100-soft-v2: async совпадает с sync и сообщает прогресс базы и поверхности', async () => {
  const grid = GeodesicGrid.build(16);
  const sync = PlanetSurface.generateSurface(grid, SMALL_INPUT);
  const progress = [];
  let yields = 0;
  const asyncResult = await PlanetSurface.generateSurfaceAsync(grid, SMALL_INPUT, {
    chunkCells: 1024,
    onProgress(stage, fraction) {
      progress.push([stage, fraction]);
    },
    async yieldControl() {
      yields++;
    },
  });
  assert.deepEqual(surfaceSnapshot(asyncResult), surfaceSnapshot(sync));
  assert.ok(progress.some(([stage]) => stage === 'fields'));
  assert.ok(progress.some(([stage]) => stage === 'biomes'));
  assert.deepEqual(progress.at(-1), ['done', 1]);
  assert.ok(yields >= 2);
});

test('c100-soft-v2: полностью океаническая, сухая и бесплодная планеты не падают', () => {
  const grid = GeodesicGrid.build(8);
  const ocean = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 12,
    oceanPctl: 100,
    shelfBelowPctl: 100,
    shelfAbovePctl: 100,
  });
  assert.equal(PlanetSurface.validateSurface(grid, ocean).ok, true);
  assert.equal(ocean.stats.hydrology.landCells, 0);
  assert.deepEqual(ocean.catchments, []);
  assert.deepEqual(ocean.drainageRegions, []);
  assert.deepEqual(ocean.lakes, []);
  assert.ok(Array.from(ocean.biomeTop1Id).every((id) => id >= 0 && id <= 2));

  const dry = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 12,
    oceanPctl: 0,
    shelfBelowPctl: 0,
    shelfAbovePctl: 0,
  });
  assert.equal(PlanetSurface.validateSurface(grid, dry).ok, true);
  assert.equal(dry.stats.hydrology.landCells, grid.cellCount);
  const dryFractions = dry.stats.hydrology.terminalLandAreaFractions;
  assert.ok(Math.abs(dryFractions.ocean + dryFractions.terminalLake + dryFractions.endorheic - 1) < 1e-9);

  const barren = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    surfaceClass: 'barren',
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 12,
    oceanPctl: 0,
    shelfBelowPctl: 0,
    shelfAbovePctl: 0,
  });
  assert.equal(PlanetSurface.validateSurface(grid, barren).ok, true);
  assert.deepEqual(barren.lakes, []);
  assert.ok(biomeFraction(barren, 'barren').top1AreaFraction > 0.35);
  assert.ok(
    biomeFraction(barren, 'barren').top1AreaFraction >
    biomeFraction(barren, 'hot_desert').top1AreaFraction,
  );
});

test('c100-soft-v2: газовый гигант явно неприменим, transferable-контракт не дублирует буферы', () => {
  const grid = GeodesicGrid.build(4);
  const gasGiant = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    surfaceClass: 'gas_giant',
  });
  assert.equal(gasGiant.surfaceApplicable, false);
  assert.equal(PlanetSurface.validateSurface(grid, gasGiant).ok, true);
  assert.deepEqual(gasGiant.catchments, []);
  assert.deepEqual(gasGiant.lakes, []);
  assert.ok(Array.from(gasGiant.biomeTop1Id).every((id) => id === -1));

  const surfaceGrid = GeodesicGrid.build(8);
  const surface = PlanetSurface.generateSurface(surfaceGrid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 12,
  });
  const packed = PlanetSurface.packSurfaceForTransfer(surface);
  assert.equal(packed.message, surface);
  assert.ok(packed.transfer.length > 0);
  assert.ok(packed.transfer.every((buffer) => buffer instanceof ArrayBuffer && buffer.byteLength > 1024));
  assert.equal(new Set(packed.transfer).size, packed.transfer.length);
  assert.ok(PlanetSurface.typedBytesOf(surface) > 0);
});

test('c100-soft-v2: валидатор ловит цикл стока и порчу биомных весов', () => {
  const grid = GeodesicGrid.build(8);
  const surface = PlanetSurface.generateSurface(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 12,
  });
  const landCell = Array.from(surface.catchmentId).findIndex((id) => id >= 0);
  assert.ok(landCell >= 0);
  const originalReceiver = surface.flowReceiver[landCell];
  surface.flowReceiver[landCell] = landCell;
  let validation = PlanetSurface.validateSurface(grid, surface);
  assert.equal(validation.ok, false);
  assert.equal(validation.checks.flowAcyclic, false);
  surface.flowReceiver[landCell] = originalReceiver;

  const originalWeight = surface.biomeTop1Weight[landCell];
  surface.biomeTop1Weight[landCell] = 2;
  validation = PlanetSurface.validateSurface(grid, surface);
  assert.equal(validation.ok, false);
  assert.equal(validation.checks.biomeWeights, false);
  surface.biomeTop1Weight[landCell] = originalWeight;
  assert.equal(PlanetSurface.validateSurface(grid, surface).ok, true);
});
