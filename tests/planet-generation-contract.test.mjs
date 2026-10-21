import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as PlanetGenerationContract from '../site/shared/planet-generation-contract.ts';
import contractJson from '../src/contracts/planet-generation-contract.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const PlanetGeography = require('../site/shared/planet-geography.ts').default;

const GOLDEN_KEY = 'PG1-5NKT36OZBP4QPXE32CKQ5V3ANI';
const RAW_EARTH = {
  place_id: '2',
  profile_status: 'draft',
  profile_revision: '1',
  preset_id: 'earthlike_balanced',
  surface_class: 'terrestrial',
  radius_km: '6371',
  master_seed_hex: '0123456789abcdef',
};

test('planet-generation-contract-v1: единый JSON содержит 37 колонок и 8 пресетов', () => {
  assert.deepEqual(PlanetGenerationContract.CONTRACT, contractJson);
  assert.equal(PlanetGenerationContract.FIELDS.length, 37);
  assert.equal(new Set(PlanetGenerationContract.FIELDS).size, 37);
  assert.equal(Object.keys(PlanetGenerationContract.PRESETS).length, 8);
  for (const [presetId, preset] of Object.entries(PlanetGenerationContract.PRESETS)) {
    assert.deepEqual(
      Object.keys(PlanetGenerationContract.getPresetGeographyValues(presetId)),
      [...PlanetGenerationContract.GEOGRAPHY_NUMBER_FIELDS],
      presetId,
    );
    assert.ok(preset.palette_id, presetId);
  }
});

test('PlanetGeography.DEFAULT_PROFILE раскрывается из контракта, а не из второй таблицы чисел', () => {
  const expected = PlanetGenerationContract.getPresetRuntimeValues('earthlike_balanced');
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(PlanetGeography.DEFAULT_PROFILE[field], value, field);
  }
  assert.equal(PlanetGeography.DEFAULT_PROFILE.continentMeanCells, 400);
  assert.equal(PlanetGeography.DEFAULT_PROFILE.oceanBasinMeanCells, 6000);
  assert.equal(PlanetGeography.DEFAULT_PROFILE.drainageMeanCells, 72);
});

test('PG1 TypeScript совпадает с golden Python для snake_case и camelCase профиля', () => {
  assert.equal(PlanetGenerationContract.computeGenerationKey(RAW_EARTH), GOLDEN_KEY);
  assert.equal(
    PlanetGenerationContract.computeGenerationKey({
      placeId: '2',
      profileStatus: 'frozen',
      profileRevision: 1,
      presetId: 'earthlike_balanced',
      surfaceClass: 'terrestrial',
      radiusKm: 6371,
      masterSeedHex: '0123456789ABCDEF',
      generationKey: GOLDEN_KEY,
    }),
    GOLDEN_KEY,
  );
  assert.match(
    PlanetGenerationContract.geographyManifestCanonicalText(RAW_EARTH),
    /"continent_mean_cells":400\.000/,
  );
});

test('quantizeDecimal повторяет Decimal ROUND_HALF_UP и каноническую точность', () => {
  assert.equal(String(PlanetGenerationContract.quantizeDecimal('radius_km', '6371.0005')), '6371.001');
  assert.equal(String(PlanetGenerationContract.quantizeDecimal('radius_km', '6371.0004')), '6371.000');
  assert.equal(String(PlanetGenerationContract.quantizeDecimal('continent_variation', '0.0000005')), '0.000001');
  assert.equal(String(PlanetGenerationContract.quantizeDecimal('axial_tilt_deg', '-1.2345675')), '-1.234568');
  assert.equal(String(PlanetGenerationContract.quantizeDecimal('ocean_pctl', '1e2')), '100.000');
});

test('verifyGenerationKey пропускает draft без ключа и строго проверяет frozen', () => {
  assert.deepEqual(PlanetGenerationContract.verifyGenerationKey(RAW_EARTH), {
    ok: true,
    applicable: false,
    status: 'draft',
    expectedKey: null,
    actualKey: null,
    reason: null,
  });

  const frozen = {
    ...RAW_EARTH,
    profile_status: 'frozen',
    generation_key: GOLDEN_KEY,
    palette_id: 'crimson',
    axial_tilt_deg: '45',
    notes_admin: 'редакционное поле на PG1 не влияет',
  };
  assert.equal(PlanetGenerationContract.verifyGenerationKey(frozen).ok, true);

  const stale = PlanetGenerationContract.verifyGenerationKey({
    ...frozen,
    ocean_pctl: '71',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.actualKey, GOLDEN_KEY);
  assert.notEqual(stale.expectedKey, GOLDEN_KEY);

  const missing = PlanetGenerationContract.verifyGenerationKey({
    ...RAW_EARTH,
    profile_status: 'frozen',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /отсутствует generation_key/);
});
