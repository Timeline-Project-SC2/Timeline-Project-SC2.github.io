import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_FIXTURE_PATH,
  GRID_FREQUENCIES,
  HISTORICAL_TARGET_MS,
  STAGE5_BASELINE_TOTAL_MS,
  SURFACE_FREQUENCIES,
  buildTimingReport,
  compareFixtures,
  computePlanetHashes,
  countFixtureChecks,
  formatTimingSummary,
  loadFixtureFile,
  verifyPlanetHashes,
} from '../tools/verify_planet_hashes.mjs';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_SCRIPT_PATH = resolve(ROOT_DIR, 'tools/verify_planet_hashes.mjs');

// Фактический состав на текущем main:
//   GeodesicGrid CRC32C: 5 (v = 16, 24, 32, 64, 128)
//   PlanetGeography SHA-256: 22 массива × 4 частоты (v = 16, 24, 32, 128) = 88
//   PlanetSurface SHA-256:   23 массива × 4 частоты (v = 16, 24, 32, 128) = 92
//   Итого: 5 + 88 + 92 = 185 проверок.
const EXPECTED_GRID_CHECKS = 5;
const EXPECTED_GEOGRAPHY_CHECKS = 88;
const EXPECTED_SURFACE_CHECKS = 92;
const EXPECTED_TOTAL_CHECKS = 185;

function flipLastHexChar(hex) {
  const last = hex.at(-1);
  const replacement = last === '0' ? '1' : '0';
  return `${hex.slice(0, -1)}${replacement}`;
}

let cachedFirstRun = null;
function getFirstRun() {
  if (!cachedFirstRun) {
    cachedFirstRun = verifyPlanetHashes({ fixturePath: DEFAULT_FIXTURE_PATH });
  }
  return cachedFirstRun;
}

test('FULL EQ: фикстура непустая, хранит метаданные версий/профиля и ровно 185 проверок (защита от обнуления)', () => {
  const fileStat = statSync(DEFAULT_FIXTURE_PATH);
  assert.ok(fileStat.size > 10_000, `размер фикстуры слишком мал: ${fileStat.size} Б`);

  const fixture = loadFixtureFile(DEFAULT_FIXTURE_PATH);
  const counts = countFixtureChecks(fixture);

  assert.equal(counts.validStructure, true, JSON.stringify(counts.invalidEntries));
  assert.ok(counts.total > 0, 'число проверок в фикстуре не должно обнуляться');
  assert.equal(counts.gridChecks, EXPECTED_GRID_CHECKS);
  assert.equal(counts.geographyChecks, EXPECTED_GEOGRAPHY_CHECKS);
  assert.equal(counts.surfaceChecks, EXPECTED_SURFACE_CHECKS);
  assert.equal(counts.total, EXPECTED_TOTAL_CHECKS);
  assert.equal(fixture.checkCount, EXPECTED_TOTAL_CHECKS);
  assert.equal(fixture.composition.totalChecks, EXPECTED_TOTAL_CHECKS);

  assert.deepEqual(fixture.versions, {
    grid: 'goldberg-gp-v1',
    noise: 'planet-noise-simplex3d-v1',
    geography: 'c100-soft-v3',
    surface: 'c100-soft-v2',
    hydrology: 'planet-hydrology-v1',
    biome: 'planet-biomes-v1',
    preset: 'planet-presets-v1',
    gridCacheFormat: 1,
  });
  assert.equal(fixture.masterSeed, '0123456789abcdef');
  assert.equal(fixture.generationKey, 'PG1-5NKT36OZBP4QPXE32CKQ5V3ANI');
  assert.equal(fixture.profile.presetId, 'earthlike_balanced');
  assert.equal(fixture.profile.surfaceClass, 'terrestrial');
  assert.equal(fixture.profile.radiusKm, 6371);
  assert.deepEqual(fixture.frequencies.grid, [...GRID_FREQUENCIES]);
  assert.deepEqual(fixture.frequencies.geography, [...SURFACE_FREQUENCIES]);
  assert.deepEqual(fixture.frequencies.surface, [...SURFACE_FREQUENCIES]);

  // Явная проверка защиты от обнуления и пустого файла фикстуры.
  assert.equal(countFixtureChecks({}).total, 0);
  assert.equal(
    countFixtureChecks({ checkCount: 0, grid: {}, geography: {}, surface: {} }).validStructure,
    false,
  );

  const tmpDir = mkdtempSync(join(tmpdir(), 'planet-eq-zero-'));
  try {
    const emptyPath = join(tmpDir, 'empty.json');
    writeFileSync(emptyPath, '', 'utf8');
    assert.throws(() => loadFixtureFile(emptyPath), /пуст \(0 байт\)/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FULL EQ: верификация проходит на текущем коде (185/185) и детерминирована между двумя прогонами подряд', () => {
  const first = getFirstRun();
  assert.equal(
    first.ok,
    true,
    `расхождения с tools/planet_hash_fixtures.json:\n${first.mismatches.map((m) => m.message).join('\n')}`,
  );
  assert.equal(first.checkedCount, EXPECTED_TOTAL_CHECKS);
  assert.equal(first.mismatches.length, 0);

  const second = computePlanetHashes();
  assert.deepEqual(second.fixture, first.actualFixture);
  assert.equal(
    JSON.stringify(second.fixture, null, 2),
    JSON.stringify(first.actualFixture, null, 2),
  );
});

test('FULL EQ: подмена хэша роняет верификатор (в памяти и через CLI exit 1) с указанием массива, v и обоих хэшей', () => {
  const { actualFixture } = getFirstRun();

  // 1. Подмена SHA-256 массива PlanetGeography
  const tamperedGeo = structuredClone(actualFixture);
  const realElevHash = actualFixture.geography['128'].elevation;
  const fakeElevHash = flipLastHexChar(realElevHash);
  tamperedGeo.geography['128'].elevation = fakeElevHash;
  const geoCheck = compareFixtures(tamperedGeo, actualFixture);
  assert.equal(geoCheck.ok, false);
  assert.equal(geoCheck.mismatches.length, 1);
  assert.deepEqual(geoCheck.mismatches[0], {
    array: 'PlanetGeography.elevation',
    v: 128,
    expected: fakeElevHash,
    actual: realElevHash,
    message: `массив=PlanetGeography.elevation v=128 ожидалось=${fakeElevHash} фактически=${realElevHash}`,
  });

  // 2. Подмена SHA-256 массива PlanetSurface
  const tamperedSurf = structuredClone(actualFixture);
  const realFlowHash = actualFixture.surface['24'].flowAccumulationKm2;
  const fakeFlowHash = flipLastHexChar(realFlowHash);
  tamperedSurf.surface['24'].flowAccumulationKm2 = fakeFlowHash;
  const surfCheck = compareFixtures(tamperedSurf, actualFixture);
  assert.equal(surfCheck.ok, false);
  assert.equal(surfCheck.mismatches.length, 1);
  assert.equal(surfCheck.mismatches[0].array, 'PlanetSurface.flowAccumulationKm2');
  assert.equal(surfCheck.mismatches[0].v, 24);

  // 3. Подмена CRC32C GeodesicGrid
  const tamperedGrid = structuredClone(actualFixture);
  const realCrc = actualFixture.grid['64'].crc32c;
  const fakeCrc = flipLastHexChar(realCrc);
  tamperedGrid.grid['64'].crc32c = fakeCrc;
  const gridCheck = compareFixtures(tamperedGrid, actualFixture);
  assert.equal(gridCheck.ok, false);
  assert.equal(gridCheck.mismatches.length, 1);
  assert.equal(gridCheck.mismatches[0].array, 'GeodesicGrid.serializeGridCache');
  assert.equal(gridCheck.mismatches[0].v, 64);

  // 4. Сквозной CLI-запуск с однобайтовой подменой в файле фикстуры -> exit 1
  const tmpDir = mkdtempSync(join(tmpdir(), 'planet-eq-tamper-'));
  try {
    const rawText = readFileSync(DEFAULT_FIXTURE_PATH, 'utf8');
    const mutatedText = rawText.replace(realElevHash, fakeElevHash);
    assert.notEqual(mutatedText, rawText);
    const mutatedPath = join(tmpDir, 'planet_hash_fixtures.mutated.json');
    writeFileSync(mutatedPath, mutatedText, 'utf8');

    const child = spawnSync(
      process.execPath,
      [CLI_SCRIPT_PATH, `--fixture=${mutatedPath}`],
      { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(child.status, 1, `ожидался exit code 1, получен ${child.status}`);
    assert.match(child.stderr, /FULL EQ FAIL/);
    assert.match(child.stderr, /массив=PlanetGeography\.elevation v=128/);
    assert.ok(child.stderr.includes(`ожидалось=${fakeElevHash}`));
    assert.ok(child.stderr.includes(`фактически=${realElevHash}`));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('FULL EQ: порог 855 мс не блокирующий — превышение печатается со знаком и процентом, но не роняет гейт', () => {
  const { actualFixture } = getFirstRun();
  const slowTiming = buildTimingReport({ meshV128Ms: 250, surfaceV128Ms: 1200 });
  assert.equal(slowTiming.historicalTargetMs, HISTORICAL_TARGET_MS);
  assert.equal(slowTiming.stage5BaselineTotalMs, STAGE5_BASELINE_TOTAL_MS);
  assert.equal(slowTiming.totalMs, 1450);
  assert.ok(slowTiming.deltaFromTargetMs > 0);
  assert.ok(slowTiming.deltaFromTargetPct > 0);

  const formatted = formatTimingSummary(slowTiming);
  assert.match(formatted, /\+595\.0 мс \(\+69\.6%\)/);
  assert.match(formatted, /-1114\.7 мс \(-43\.5%\)/);

  const verifiedWithSlowTiming = verifyPlanetHashes({
    fixturePath: DEFAULT_FIXTURE_PATH,
    precomputed: { fixture: actualFixture, timing: slowTiming },
  });
  assert.equal(verifiedWithSlowTiming.ok, true);
});
