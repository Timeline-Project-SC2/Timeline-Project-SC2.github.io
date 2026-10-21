import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetGeography = require('../site/shared/planet-geography.ts').default;

const EARTH_SEED = '0123456789abcdef';

function typedArraySnapshot(geography) {
  const snapshot = {};
  for (const name of PlanetGeography.ARRAY_FIELDS) {
    snapshot[name] = Array.from(geography[name]);
  }
  return snapshot;
}

test('planet-noise-simplex3d-v1: xxHash32 и разделение seed по доменам', () => {
  assert.equal(PlanetGeography.xxHash32(''), 0x02cc5d05);
  assert.equal(PlanetGeography.xxHash32('a'), 0x550d7456);
  assert.equal(PlanetGeography.xxHash32('abc'), 0x32d153ff);
  assert.equal(PlanetGeography.xxHash32('123456789'), 0x937bad67);

  const goldenDomainSeeds = {
    elevation: 0x4b82f834,
    moisture: 0x76dfc1f2,
    temperature: 0x7736a794,
    plates: 0xc9a1507e,
    volcanism: 0x6ad7c5ba,
    detail: 0x8c4b9da6,
    warp: 0x362c7730,
    'offset:elevation': 0x306c8d0b,
    'offset:moisture': 0x7b6e2ec0,
    'offset:temperature': 0xced9c7ca,
    'offset:plates': 0xb8526bf4,
    'offset:volcanism': 0x2c20b140,
    'offset:detail': 0xa47d3d73,
    'offset:warp': 0xbb38833e,
    'plate-seeds': 0xf19b8527,
    'continent-masses': 0x387b9a60,
    'ocean-basin-masses': 0xa46910ef,
  };
  for (const [domain, expected] of Object.entries(goldenDomainSeeds)) {
    assert.equal(PlanetGeography.domainSeed(EARTH_SEED, domain), expected, domain);
  }

  const elevation = PlanetGeography.domainSeed(EARTH_SEED, 'elevation');
  const moisture = PlanetGeography.domainSeed(EARTH_SEED, 'moisture');
  assert.equal(elevation, PlanetGeography.domainSeed(EARTH_SEED.toUpperCase(), 'elevation'));
  assert.notEqual(elevation, moisture);
  assert.notEqual(
    PlanetGeography.domainSeed('0000000000000001', 'elevation'),
    PlanetGeography.domainSeed('0000000100000000', 'elevation'),
  );
  assert.deepEqual(PlanetGeography.parseMasterSeedHex(EARTH_SEED), {
    hex: EARTH_SEED,
    hi: 0x01234567,
    lo: 0x89abcdef,
  });
  assert.throws(() => PlanetGeography.parseMasterSeedHex('1234'), /16 hex/);
  assert.throws(() => PlanetGeography.parseMasterSeedHex('0123456789abcdeg'), /16 hex/);
});

test('c100-soft-v1: профиль принимает snake_case колонки и отвергает чужие версии', () => {
  const profile = PlanetGeography.normalizeProfile({
    master_seed_hex: 'ABCDEF0123456789',
    radius_km: '3390',
    surface_class: 'terrestrial',
    preset_id: 'marslike_dry',
    continent_mean_cells: '400',
    ocean_basin_mean_cells: '6000',
    drainage_mean_cells: '72',
    ocean_pctl: '35',
    shelf_below_pctl: '32',
    shelf_above_pctl: '38',
  });
  assert.equal(profile.masterSeedHex, 'abcdef0123456789');
  assert.equal(profile.radiusKm, 3390);
  assert.equal(profile.presetId, 'marslike_dry');
  assert.equal(profile.noiseVersion, 'planet-noise-simplex3d-v1');
  assert.equal(profile.geographyVersion, 'c100-soft-v1');
  assert.equal(profile.presetVersion, 'planet-presets-v1');

  assert.equal(PlanetGeography.DEFAULT_PROFILE.continentMeanCells, 400);
  assert.equal(PlanetGeography.DEFAULT_PROFILE.oceanBasinMeanCells, 6000);
  assert.equal(PlanetGeography.DEFAULT_PROFILE.drainageMeanCells, 72);
  assert.equal(PlanetGeography.expectedFrequency(6371), 128);
  assert.equal(PlanetGeography.expectedFrequency(3390), 68);
  assert.equal(PlanetGeography.expectedFrequency(1737.4), 35);

  assert.throws(
    () => PlanetGeography.normalizeProfile({ noiseVersion: 'planet-noise-v0' }),
    /noiseVersion/,
  );
  assert.throws(
    () => PlanetGeography.normalizeProfile({ geographyVersion: 'c100-soft-v0' }),
    /geographyVersion/,
  );
  assert.throws(
    () => PlanetGeography.normalizeProfile({ gridVersion: 'goldberg-gp-v0' }),
    /gridVersion/,
  );
  assert.throws(
    () => PlanetGeography.normalizeProfile({ surfaceClass: 'lava' }),
    /surfaceClass/,
  );
  assert.throws(
    () => PlanetGeography.normalizeProfile({ oceanPctl: 50, shelfBelowPctl: 60, shelfAbovePctl: 70 }),
    /shelfBelowPctl/,
  );
  assert.throws(() => PlanetGeography.normalizeProfile({ radiusKm: 0 }), /radiusKm/);
});

test('c100-soft-v1: единый sampler детерминирован и зависит от master seed', () => {
  const samplerA = PlanetGeography.createFieldSampler({ masterSeedHex: EARTH_SEED });
  const samplerB = PlanetGeography.createFieldSampler({ masterSeedHex: EARTH_SEED });
  const samplerOther = PlanetGeography.createFieldSampler({ masterSeedHex: '0000000000000001' });
  const a = samplerA.sampleFields(1, 2, 3, new Float32Array(6));
  const b = samplerB.sampleFields(2, 4, 6, new Float32Array(6));
  const other = samplerOther.sampleFields(1, 2, 3, new Float32Array(6));
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(other));
  const golden = [
    0.21845965087413788,
    0.3378230631351471,
    0.7717837691307068,
    0.67474365234375,
    0.25667667388916016,
    0.2451280802488327,
  ];
  for (let i = 0; i < golden.length; i++) {
    assert.ok(Math.abs(a[i] - golden[i]) < 1e-7, `golden sample[${i}]`);
  }
  assert.ok(a[PlanetGeography.FIELD_INDEX.elevation] >= -1);
  assert.ok(a[PlanetGeography.FIELD_INDEX.elevation] <= 1);
  for (const field of ['moisture', 'temperatureBase', 'plateAffinity', 'volcanism']) {
    const value = a[PlanetGeography.FIELD_INDEX[field]];
    assert.ok(value >= 0 && value <= 1, field);
  }
  assert.throws(() => samplerA.sampleFields(0, 0, 0), /ненулевым/);
});

test('c100-soft-v1: генерация валидна, повторяема и держит долю океана', () => {
  const grid = GeodesicGrid.build(16);
  const input = {
    masterSeedHex: EARTH_SEED,
    radiusKm: 6371,
    continentMeanCells: 100,
    oceanBasinMeanCells: 500,
    drainageMeanCells: 18,
  };
  const first = PlanetGeography.generateGeography(grid, input);
  const second = PlanetGeography.generateGeography(grid, input);
  const validation = PlanetGeography.validateGeography(grid, first);
  assert.equal(validation.ok, true, JSON.stringify(validation.checks));
  assert.deepEqual(typedArraySnapshot(first), typedArraySnapshot(second));
  assert.equal(first.surfaceApplicable, true);
  assert.equal(first.expectedFrequency, 128);
  assert.equal(first.frequencyMatchesProfile, false);
  assert.ok(Math.abs(first.stats.oceanFractionHard - 0.7) < 0.03);
  assert.ok(first.continents.length > 0);
  assert.ok(first.oceanBasins.length > 0);
  assert.equal(first.plates.length, PlanetGeography.PLATE_COUNT);
  assert.ok(first.plates.every((plate) => plate.cellCount > 0));
  assert.ok(first.plates.every((plate) => Number.isFinite(plate.supportAreaKm2) && plate.supportAreaKm2 > 0));
  const plateAreaKm2 = first.plates.reduce((sum, plate) => sum + plate.supportAreaKm2, 0);
  assert.ok(Math.abs(plateAreaKm2 - 4 * Math.PI * 6371 * 6371) / (4 * Math.PI * 6371 * 6371) < 1e-8);
  assert.ok(first.continents.every((record) => record.effectiveMassCells > 0));
  assert.ok(first.oceanBasins.every((record) => record.effectiveMassCells > 0));
  assert.ok(first.continents.every((record) => record.hardCellCount > 0));
  assert.ok(first.oceanBasins.every((record) => record.hardCellCount > 0));
  assert.ok(first.stats.climate.temperatureInsolationCorrelation > 0.5);
  assert.ok(first.stats.climate.equatorTemperature > first.stats.climate.polarTemperature);

  const otherSeed = PlanetGeography.generateGeography(grid, {
    ...input,
    masterSeedHex: 'deadbeefcafebabe',
  });
  assert.notDeepEqual(Array.from(first.elevation), Array.from(otherSeed.elevation));
});

test('c100-soft-v1: async-генерация совпадает с sync и уступает управление по чанкам', async () => {
  const grid = GeodesicGrid.build(16);
  const input = {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    drainageMeanCells: 10,
  };
  const sync = PlanetGeography.generateGeography(grid, input);
  const progress = [];
  let yields = 0;
  const asyncResult = await PlanetGeography.generateGeographyAsync(grid, input, {
    chunkCells: 1024,
    onProgress(stage, fraction) {
      progress.push([stage, fraction]);
    },
    async yieldControl() {
      yields++;
    },
  });
  assert.deepEqual(typedArraySnapshot(asyncResult), typedArraySnapshot(sync));
  assert.ok(progress.some(([stage]) => stage === 'fields'));
  assert.deepEqual(progress.at(-1), ['done', 1]);
  assert.ok(yields >= 2);
});

test('c100-soft-v1: полностью сухая и полностью океаническая планеты не падают', () => {
  const grid = GeodesicGrid.build(8);
  const dry = PlanetGeography.generateGeography(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    oceanPctl: 0,
    shelfBelowPctl: 0,
    shelfAbovePctl: 0,
  });
  assert.equal(PlanetGeography.validateGeography(grid, dry).ok, true);
  assert.equal(dry.stats.oceanFractionHard, 0);
  assert.ok(dry.stats.softFractions.land > 0.99);
  assert.equal(dry.oceanBasins.length, 0);

  const ocean = PlanetGeography.generateGeography(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
    oceanPctl: 100,
    shelfBelowPctl: 100,
    shelfAbovePctl: 100,
  });
  assert.equal(PlanetGeography.validateGeography(grid, ocean).ok, true);
  assert.equal(ocean.stats.oceanFractionHard, 1);
  assert.ok(ocean.stats.softFractions.ocean > 0.99);
  assert.equal(ocean.continents.length, 0);
});

test('c100-soft-v1: планеты без поверхности явно помечены как неприменимые', () => {
  const grid = GeodesicGrid.build(4);
  for (const surfaceClass of ['gas_giant', 'no_surface']) {
    const geography = PlanetGeography.generateGeography(grid, {
      masterSeedHex: EARTH_SEED,
      surfaceClass,
    });
    assert.equal(geography.surfaceApplicable, false);
    assert.deepEqual(geography.continents, []);
    assert.deepEqual(geography.oceanBasins, []);
    assert.equal(PlanetGeography.validateGeography(grid, geography).ok, true);
  }
});

test('c100-soft-v1: transferable-контракт и валидатор ловят порчу мягких весов', () => {
  const grid = GeodesicGrid.build(8);
  const geography = PlanetGeography.generateGeography(grid, {
    masterSeedHex: EARTH_SEED,
    continentMeanCells: 40,
    oceanBasinMeanCells: 100,
  });
  const packed = PlanetGeography.packGeographyForTransfer(geography);
  assert.equal(packed.message, geography);
  assert.ok(packed.transfer.length > 0);
  assert.ok(packed.transfer.every((buffer) => buffer instanceof ArrayBuffer));
  assert.equal(new Set(packed.transfer).size, packed.transfer.length);
  assert.equal(PlanetGeography.typedBytesOf(geography) > 0, true);

  geography.muLand[0] = 0.25;
  const validation = PlanetGeography.validateGeography(grid, geography);
  assert.equal(validation.ok, false);
  assert.equal(validation.checks.softMembershipSum, false);
});
