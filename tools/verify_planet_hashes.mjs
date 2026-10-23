#!/usr/bin/env node
/* Исполняемый гейт побитовой эквивалентности планетарного ядра (FULL EQ, A-10).
 *
 * Режимы запуска:
 *   node tools/verify_planet_hashes.mjs           — сверка с tools/planet_hash_fixtures.json (exit 1 при расхождении)
 *   node tools/verify_planet_hashes.mjs --write   — запись эталонных фикстур из текущего кода
 *   --fixture=<путь>                              — переопределение пути к JSON-фикстуре
 *
 * Состав проверок определяется фактически по экспортируемым массивам и полям
 * GeodesicGrid / PlanetGeography / PlanetSurface без ручной подгонки:
 *   - CRC32C сериализованного бинарного кэша GeodesicGrid на v = 16, 24, 32, 64, 128;
 *   - SHA-256 сырых байтов всех TypedArray-полей PlanetGeography на v = 16, 24, 32, 128;
 *   - SHA-256 сырых байтов всех собственных TypedArray-полей PlanetSurface на v = 16, 24, 32, 128.
 *
 * Политика производительности (аудит §8.11):
 *   Порог 855 мс и сравнение с baseline печатаются справочно (абсолютное и
 *   относительное отклонение со знаком) и НЕ влияют на код возврата.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { computeGenerationKey } from '../site/shared/planet-generation-contract.ts';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetGeography = require('../site/shared/planet-geography.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FIXTURE_SCHEMA = 'planet-full-eq-fixtures/v1';
export const DEFAULT_FIXTURE_PATH = resolve(ROOT_DIR, 'tools/planet_hash_fixtures.json');
export const BASELINE_JSON_PATH = resolve(ROOT_DIR, 'baseline-2026-10-20.json');

export const GRID_FREQUENCIES = Object.freeze([16, 24, 32, 64, 128]);
export const SURFACE_FREQUENCIES = Object.freeze([16, 24, 32, 128]);

export const CANONICAL_MASTER_SEED = '0123456789abcdef';
export const CANONICAL_PROFILE_INPUT = Object.freeze({
  preset_id: 'earthlike_balanced',
  surface_class: 'terrestrial',
  radius_km: 6371,
  master_seed_hex: CANONICAL_MASTER_SEED,
});

export const HISTORICAL_TARGET_MS = 855.0;
export const STAGE5_BASELINE_TOTAL_MS = 2564.7;

const HEX_CRC32_RE = /^[0-9a-f]{8}$/;
const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function sha256TypedArray(view, label = 'TypedArray') {
  if (!ArrayBuffer.isView(view)) {
    throw new TypeError(`Ожидался TypedArray (${label}), получено: ${typeof view}`);
  }
  const rawBytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  return createHash('sha256').update(rawBytes).digest('hex');
}

export function crc32cHex(bytes) {
  return (GeodesicGrid.crc32c(bytes) >>> 0).toString(16).padStart(8, '0');
}

function discoverGeographyArrayFields(geography) {
  const ordered = [];
  const seen = new Set();
  for (const field of PlanetGeography.ARRAY_FIELDS) {
    if (ArrayBuffer.isView(geography[field])) {
      ordered.push(field);
      seen.add(field);
    } else {
      throw new Error(`PlanetGeography.${field} отсутствует или не является TypedArray`);
    }
  }
  for (const [key, value] of Object.entries(geography)) {
    if (ArrayBuffer.isView(value) && !seen.has(key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  return ordered;
}

function discoverSurfaceArrayFields(surface, geographyFieldSet) {
  const ordered = [];
  const seen = new Set();
  for (const field of PlanetSurface.ARRAY_FIELDS) {
    if (ArrayBuffer.isView(surface[field])) {
      ordered.push(field);
      seen.add(field);
    } else {
      throw new Error(`PlanetSurface.${field} отсутствует или не является TypedArray`);
    }
  }
  for (const [key, value] of Object.entries(surface)) {
    if (ArrayBuffer.isView(value) && !geographyFieldSet.has(key) && !seen.has(key)) {
      ordered.push(key);
      seen.add(key);
    }
  }
  return ordered;
}

function loadMeshBaselineV128Ms() {
  if (!existsSync(BASELINE_JSON_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_JSON_PATH, 'utf8'));
    const entry = Array.isArray(parsed?.results)
      ? parsed.results.find((item) => item?.v === 128)
      : null;
    const ms = entry?.cpu?.meshBuildMs;
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function signedFixed(value, digits = 1) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}`;
}

export function buildTimingReport({ meshV128Ms, surfaceV128Ms }) {
  const totalV128Ms = meshV128Ms + surfaceV128Ms;
  const deltaTargetMs = totalV128Ms - HISTORICAL_TARGET_MS;
  const deltaTargetPct = ((totalV128Ms / HISTORICAL_TARGET_MS) - 1) * 100;
  const deltaStage5BaselineMs = totalV128Ms - STAGE5_BASELINE_TOTAL_MS;
  const deltaStage5BaselinePct = ((totalV128Ms / STAGE5_BASELINE_TOTAL_MS) - 1) * 100;
  const meshBaselineMs = loadMeshBaselineV128Ms();
  const deltaMeshBaselineMs = meshBaselineMs !== null ? meshV128Ms - meshBaselineMs : null;
  const deltaMeshBaselinePct = meshBaselineMs !== null
    ? ((meshV128Ms / meshBaselineMs) - 1) * 100
    : null;

  return {
    v: 128,
    meshMs: +meshV128Ms.toFixed(2),
    surfaceMs: +surfaceV128Ms.toFixed(2),
    totalMs: +totalV128Ms.toFixed(2),
    historicalTargetMs: HISTORICAL_TARGET_MS,
    deltaFromTargetMs: +deltaTargetMs.toFixed(2),
    deltaFromTargetPct: +deltaTargetPct.toFixed(2),
    stage5BaselineTotalMs: STAGE5_BASELINE_TOTAL_MS,
    deltaFromStage5BaselineMs: +deltaStage5BaselineMs.toFixed(2),
    deltaFromStage5BaselinePct: +deltaStage5BaselinePct.toFixed(2),
    ciBaselineMeshV128Ms: meshBaselineMs !== null ? +meshBaselineMs.toFixed(2) : null,
    deltaFromCiBaselineMeshMs: deltaMeshBaselineMs !== null ? +deltaMeshBaselineMs.toFixed(2) : null,
    deltaFromCiBaselineMeshPct: deltaMeshBaselinePct !== null ? +deltaMeshBaselinePct.toFixed(2) : null,
  };
}

export function formatTimingSummary(timing) {
  const parts = [
    `[PERF info · non-blocking] v=128: mesh=${timing.meshMs.toFixed(1)} мс + surface=${timing.surfaceMs.toFixed(1)} мс = total=${timing.totalMs.toFixed(1)} мс`,
    `отклонение от цели ${timing.historicalTargetMs.toFixed(1)} мс: ${signedFixed(timing.deltaFromTargetMs)} мс (${signedFixed(timing.deltaFromTargetPct)}%)`,
    `отклонение от Stage-5 baseline ${timing.stage5BaselineTotalMs.toFixed(1)} мс: ${signedFixed(timing.deltaFromStage5BaselineMs)} мс (${signedFixed(timing.deltaFromStage5BaselinePct)}%)`,
  ];
  if (
    timing.ciBaselineMeshV128Ms !== null &&
    timing.deltaFromCiBaselineMeshMs !== null &&
    timing.deltaFromCiBaselineMeshPct !== null
  ) {
    parts.push(
      `mesh vs baseline-2026-10-20 (${timing.ciBaselineMeshV128Ms.toFixed(1)} мс): ${signedFixed(timing.deltaFromCiBaselineMeshMs)} мс (${signedFixed(timing.deltaFromCiBaselineMeshPct)}%)`,
    );
  }
  return parts.join(' | ');
}

export function computePlanetHashes() {
  if (!HOST_LITTLE_ENDIAN) {
    throw new Error('FULL EQ требует little-endian архитектуру для сырых TypedArray-буферов');
  }

  const normalizedSurfaceProfile = PlanetSurface.normalizeSurfaceProfile(CANONICAL_PROFILE_INPUT);
  const normalizedGeographyProfile = PlanetGeography.normalizeProfile(CANONICAL_PROFILE_INPUT);
  const generationKey = computeGenerationKey({
    place_id: '2',
    profile_status: 'draft',
    profile_revision: '1',
    preset_id: CANONICAL_PROFILE_INPUT.preset_id,
    surface_class: CANONICAL_PROFILE_INPUT.surface_class,
    radius_km: String(CANONICAL_PROFILE_INPUT.radius_km),
    master_seed_hex: CANONICAL_PROFILE_INPUT.master_seed_hex,
  });

  const builtGrids = new Map();
  const gridEntries = {};
  let meshV128Ms = 0;

  for (const v of GRID_FREQUENCIES) {
    const t0 = performance.now();
    const grid = GeodesicGrid.build(v);
    const buildElapsed = performance.now() - t0;
    if (v === 128) meshV128Ms = buildElapsed;

    const gridValidation = GeodesicGrid.validate(grid);
    if (!gridValidation.ok) {
      throw new Error(`GeodesicGrid.validate(${v}) не пройдена: ${JSON.stringify(gridValidation.checks)}`);
    }
    const cacheBuffer = GeodesicGrid.serializeGridCache(grid);
    const cacheBytes = new Uint8Array(cacheBuffer);

    builtGrids.set(v, grid);
    gridEntries[String(v)] = {
      v,
      cellCount: grid.cellCount,
      byteLength: cacheBytes.byteLength,
      crc32c: crc32cHex(cacheBytes),
    };
  }

  const geographyEntries = {};
  const surfaceEntries = {};
  let geographyFieldNames = null;
  let surfaceFieldNames = null;
  let surfaceV128Ms = 0;

  for (const v of SURFACE_FREQUENCIES) {
    const grid = builtGrids.get(v) ?? GeodesicGrid.build(v);

    const geography = PlanetGeography.generateGeography(grid, normalizedGeographyProfile);
    const geoValidation = PlanetGeography.validateGeography(grid, geography);
    if (!geoValidation.ok) {
      throw new Error(`PlanetGeography.validateGeography(${v}) не пройдена: ${JSON.stringify(geoValidation.checks)}`);
    }

    const discoveredGeoFields = discoverGeographyArrayFields(geography);
    if (geographyFieldNames === null) {
      geographyFieldNames = discoveredGeoFields;
    }
    const geoFieldSet = new Set(discoveredGeoFields);

    const geoHashes = {};
    for (const field of discoveredGeoFields) {
      geoHashes[field] = sha256TypedArray(geography[field], `PlanetGeography.${field}@v=${v}`);
    }
    geographyEntries[String(v)] = geoHashes;

    const tSurface = performance.now();
    const surface = PlanetSurface.generateSurface(grid, normalizedSurfaceProfile);
    const surfaceElapsed = performance.now() - tSurface;
    if (v === 128) surfaceV128Ms = surfaceElapsed;

    const surfaceValidation = PlanetSurface.validateSurface(grid, surface);
    if (!surfaceValidation.ok) {
      throw new Error(`PlanetSurface.validateSurface(${v}) не пройдена: ${JSON.stringify(surfaceValidation.checks)}`);
    }

    const discoveredSurfFields = discoverSurfaceArrayFields(surface, geoFieldSet);
    if (surfaceFieldNames === null) {
      surfaceFieldNames = discoveredSurfFields;
    }

    const surfHashes = {};
    for (const field of discoveredSurfFields) {
      surfHashes[field] = sha256TypedArray(surface[field], `PlanetSurface.${field}@v=${v}`);
    }
    surfaceEntries[String(v)] = surfHashes;
  }

  const gridChecks = Object.keys(gridEntries).length;
  const geographyChecks = Object.values(geographyEntries).reduce(
    (sum, item) => sum + Object.keys(item).length,
    0,
  );
  const surfaceChecks = Object.values(surfaceEntries).reduce(
    (sum, item) => sum + Object.keys(item).length,
    0,
  );
  const totalChecks = gridChecks + geographyChecks + surfaceChecks;

  const fixture = {
    schema: FIXTURE_SCHEMA,
    endianness: 'LE',
    versions: {
      grid: GeodesicGrid.GRID_VERSION,
      noise: PlanetGeography.NOISE_VERSION,
      geography: PlanetGeography.GEOGRAPHY_VERSION,
      surface: PlanetSurface.SURFACE_VERSION,
      hydrology: PlanetSurface.HYDROLOGY_VERSION,
      biome: PlanetSurface.BIOME_VERSION,
      preset: PlanetGeography.PRESET_VERSION,
      gridCacheFormat: GeodesicGrid.CACHE_FORMAT_VERSION,
    },
    masterSeed: normalizedSurfaceProfile.masterSeedHex,
    generationKey,
    profile: normalizedSurfaceProfile,
    frequencies: {
      grid: [...GRID_FREQUENCIES],
      geography: [...SURFACE_FREQUENCIES],
      surface: [...SURFACE_FREQUENCIES],
    },
    arrayFields: {
      geography: geographyFieldNames ?? [],
      surface: surfaceFieldNames ?? [],
    },
    composition: {
      gridChecks,
      geographyArraysPerV: (geographyFieldNames ?? []).length,
      geographyChecks,
      surfaceArraysPerV: (surfaceFieldNames ?? []).length,
      surfaceChecks,
      totalChecks,
    },
    checkCount: totalChecks,
    grid: gridEntries,
    geography: geographyEntries,
    surface: surfaceEntries,
  };

  const timing = buildTimingReport({ meshV128Ms, surfaceV128Ms });
  return { fixture, timing };
}

export function countFixtureChecks(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return {
      validStructure: false,
      gridChecks: 0,
      geographyChecks: 0,
      surfaceChecks: 0,
      total: 0,
      invalidEntries: ['root: не объект'],
    };
  }

  const invalidEntries = [];
  let gridChecks = 0;
  let geographyChecks = 0;
  let surfaceChecks = 0;

  if (!fixture.grid || typeof fixture.grid !== 'object' || Array.isArray(fixture.grid)) {
    invalidEntries.push('grid: отсутствует словарь частот');
  } else {
    for (const [vKey, entry] of Object.entries(fixture.grid)) {
      if (entry && typeof entry === 'object' && typeof entry.crc32c === 'string' && HEX_CRC32_RE.test(entry.crc32c)) {
        gridChecks++;
      } else {
        invalidEntries.push(`GeodesicGrid.serializeGridCache@v=${vKey}: некорректный CRC32C`);
      }
    }
  }

  if (!fixture.geography || typeof fixture.geography !== 'object' || Array.isArray(fixture.geography)) {
    invalidEntries.push('geography: отсутствует словарь частот');
  } else {
    for (const [vKey, fields] of Object.entries(fixture.geography)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        invalidEntries.push(`PlanetGeography@v=${vKey}: некорректный объект полей`);
        continue;
      }
      for (const [name, hash] of Object.entries(fields)) {
        if (typeof hash === 'string' && HEX_SHA256_RE.test(hash)) {
          geographyChecks++;
        } else {
          invalidEntries.push(`PlanetGeography.${name}@v=${vKey}: некорректный SHA-256`);
        }
      }
    }
  }

  if (!fixture.surface || typeof fixture.surface !== 'object' || Array.isArray(fixture.surface)) {
    invalidEntries.push('surface: отсутствует словарь частот');
  } else {
    for (const [vKey, fields] of Object.entries(fixture.surface)) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        invalidEntries.push(`PlanetSurface@v=${vKey}: некорректный объект полей`);
        continue;
      }
      for (const [name, hash] of Object.entries(fields)) {
        if (typeof hash === 'string' && HEX_SHA256_RE.test(hash)) {
          surfaceChecks++;
        } else {
          invalidEntries.push(`PlanetSurface.${name}@v=${vKey}: некорректный SHA-256`);
        }
      }
    }
  }

  const total = gridChecks + geographyChecks + surfaceChecks;
  return {
    validStructure: invalidEntries.length === 0 && total > 0,
    gridChecks,
    geographyChecks,
    surfaceChecks,
    total,
    invalidEntries,
  };
}

function stableScalarText(value) {
  return value === undefined ? '<отсутствует>' : JSON.stringify(value);
}

export function compareFixtures(expectedFixture, actualFixture) {
  const mismatches = [];
  const pushMismatch = (array, v, expected, actual) => {
    mismatches.push({
      array,
      v,
      expected: String(expected),
      actual: String(actual),
      message: `массив=${array} v=${v} ожидалось=${expected} фактически=${actual}`,
    });
  };

  if (!expectedFixture || typeof expectedFixture !== 'object' || Array.isArray(expectedFixture)) {
    pushMismatch('fixture.root', 'meta', '<корректный объект фикстуры>', stableScalarText(expectedFixture));
    return { ok: false, checkedCount: 0, mismatches };
  }

  const counted = countFixtureChecks(expectedFixture);
  if (counted.total === 0) {
    pushMismatch('fixture.checkCount', 'meta', actualFixture.checkCount, 0);
  }

  const topScalarKeys = ['schema', 'endianness', 'masterSeed', 'generationKey', 'checkCount'];
  for (const key of topScalarKeys) {
    if (expectedFixture[key] !== actualFixture[key]) {
      pushMismatch(`meta.${key}`, 'meta', expectedFixture[key], actualFixture[key]);
    }
  }

  const compareFlatRecord = (prefix, expectedObj, actualObj) => {
    const exp = expectedObj && typeof expectedObj === 'object' && !Array.isArray(expectedObj) ? expectedObj : {};
    const act = actualObj && typeof actualObj === 'object' && !Array.isArray(actualObj) ? actualObj : {};
    const allKeys = new Set([...Object.keys(exp), ...Object.keys(act)]);
    for (const key of allKeys) {
      const eVal = JSON.stringify(exp[key]);
      const aVal = JSON.stringify(act[key]);
      if (eVal !== aVal) {
        pushMismatch(`${prefix}.${key}`, 'meta', exp[key], act[key]);
      }
    }
  };

  compareFlatRecord('meta.versions', expectedFixture.versions, actualFixture.versions);
  compareFlatRecord('meta.profile', expectedFixture.profile, actualFixture.profile);
  compareFlatRecord('meta.frequencies', expectedFixture.frequencies, actualFixture.frequencies);
  compareFlatRecord('meta.arrayFields', expectedFixture.arrayFields, actualFixture.arrayFields);
  compareFlatRecord('meta.composition', expectedFixture.composition, actualFixture.composition);

  let checkedCount = 0;

  // 1. GeodesicGrid CRC32C на наборе частот сетки
  const expGrid = expectedFixture.grid && typeof expectedFixture.grid === 'object' ? expectedFixture.grid : {};
  const actGrid = actualFixture.grid;
  const gridVKeys = new Set([...Object.keys(expGrid), ...Object.keys(actGrid)]);
  for (const vKey of gridVKeys) {
    const vLabel = Number.isNaN(Number(vKey)) ? vKey : Number(vKey);
    const eEntry = expGrid[vKey];
    const aEntry = actGrid[vKey];
    if (!eEntry || !aEntry) {
      pushMismatch(
        'GeodesicGrid.serializeGridCache',
        vLabel,
        eEntry?.crc32c ?? '<отсутствует в фикстуре>',
        aEntry?.crc32c ?? '<не сгенерировано>',
      );
      continue;
    }
    checkedCount++;
    if (eEntry.crc32c !== aEntry.crc32c) {
      pushMismatch('GeodesicGrid.serializeGridCache', vLabel, eEntry.crc32c, aEntry.crc32c);
    }
    if (eEntry.cellCount !== aEntry.cellCount) {
      pushMismatch('GeodesicGrid.cellCount', vLabel, eEntry.cellCount, aEntry.cellCount);
    }
    if (eEntry.byteLength !== aEntry.byteLength) {
      pushMismatch('GeodesicGrid.byteLength', vLabel, eEntry.byteLength, aEntry.byteLength);
    }
  }

  // 2. PlanetGeography SHA-256 и 3. PlanetSurface SHA-256
  const compareHashGroup = (groupLabel, expGroupRaw, actGroup) => {
    const expGroup = expGroupRaw && typeof expGroupRaw === 'object' ? expGroupRaw : {};
    const vKeys = new Set([...Object.keys(expGroup), ...Object.keys(actGroup)]);
    for (const vKey of vKeys) {
      const vLabel = Number.isNaN(Number(vKey)) ? vKey : Number(vKey);
      const expFields = expGroup[vKey];
      const actFields = actGroup[vKey];
      if (!expFields || typeof expFields !== 'object' || !actFields || typeof actFields !== 'object') {
        pushMismatch(
          `${groupLabel}.*`,
          vLabel,
          expFields ? '<объект>' : '<отсутствует в фикстуре>',
          actFields ? '<объект>' : '<не сгенерировано>',
        );
        continue;
      }
      const fieldNames = new Set([...Object.keys(expFields), ...Object.keys(actFields)]);
      for (const field of fieldNames) {
        checkedCount++;
        const expHash = expFields[field];
        const actHash = actFields[field];
        if (expHash !== actHash) {
          pushMismatch(
            `${groupLabel}.${field}`,
            vLabel,
            expHash ?? '<отсутствует в фикстуре>',
            actHash ?? '<отсутствует в генерации>',
          );
        }
      }
    }
  };

  compareHashGroup('PlanetGeography', expectedFixture.geography, actualFixture.geography);
  compareHashGroup('PlanetSurface', expectedFixture.surface, actualFixture.surface);

  return {
    ok: mismatches.length === 0 && checkedCount > 0,
    checkedCount,
    mismatches,
  };
}

export function loadFixtureFile(fixturePath = DEFAULT_FIXTURE_PATH) {
  if (!existsSync(fixturePath)) {
    throw new Error(`Файл фикстуры FULL EQ не найден: ${fixturePath}`);
  }
  const size = statSync(fixturePath).size;
  if (size === 0) {
    throw new Error(`Файл фикстуры FULL EQ пуст (0 байт): ${fixturePath}`);
  }
  const raw = readFileSync(fixturePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Повреждён JSON фикстуры FULL EQ (${fixturePath}): ${message}`);
  }
}

export function writePlanetHashFixtures({ fixturePath = DEFAULT_FIXTURE_PATH } = {}) {
  const { fixture, timing } = computePlanetHashes();
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;
  writeFileSync(fixturePath, serialized, 'utf8');
  return {
    fixturePath,
    bytesWritten: Buffer.byteLength(serialized, 'utf8'),
    fixture,
    timing,
  };
}

export function verifyPlanetHashes({
  fixturePath = DEFAULT_FIXTURE_PATH,
  precomputed = null,
} = {}) {
  const expectedFixture = loadFixtureFile(fixturePath);
  const { fixture: actualFixture, timing } = precomputed ?? computePlanetHashes();
  const comparison = compareFixtures(expectedFixture, actualFixture);
  return {
    ...comparison,
    fixturePath,
    expectedFixture,
    actualFixture,
    timing,
  };
}

function parseCliArgs(argv) {
  let write = false;
  let fixturePath = DEFAULT_FIXTURE_PATH;
  for (const arg of argv) {
    if (arg === '--write') {
      write = true;
    } else if (arg.startsWith('--fixture=')) {
      const value = arg.slice('--fixture='.length).trim();
      if (!value) throw new Error('Пустой путь в аргументе --fixture=');
      fixturePath = resolve(process.cwd(), value);
    } else {
      throw new Error(`Неизвестный аргумент: ${arg} (допустимы: --write, --fixture=<путь>)`);
    }
  }
  return { write, fixturePath };
}

function runCli() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[FULL EQ ERROR] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (options.write) {
    const written = writePlanetHashFixtures({ fixturePath: options.fixturePath });
    const c = written.fixture.composition;
    console.log(
      `FULL EQ WRITE OK: записано ${c.totalChecks} проверок ` +
      `(GeodesicGrid CRC32C: ${c.gridChecks}, PlanetGeography SHA-256: ${c.geographyChecks}, PlanetSurface SHA-256: ${c.surfaceChecks}) -> ` +
      `${written.fixturePath} (${written.bytesWritten} Б)`,
    );
    console.log(formatTimingSummary(written.timing));
    return;
  }

  let result;
  try {
    result = verifyPlanetHashes({ fixturePath: options.fixturePath });
  } catch (err) {
    console.error(`FULL EQ FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(formatTimingSummary(result.timing));

  if (!result.ok) {
    console.error(
      `FULL EQ FAIL: обнаружено расхождений: ${result.mismatches.length} (проверено записей: ${result.checkedCount})`,
    );
    for (const item of result.mismatches) {
      console.error(`  - ${item.message}`);
    }
    process.exit(1);
  }

  const c = result.actualFixture.composition;
  console.log(
    `FULL EQ OK: ${result.checkedCount}/${c.totalChecks} проверок совпали побитово ` +
    `(GeodesicGrid CRC32C: ${c.gridChecks}, PlanetGeography SHA-256: ${c.geographyChecks}, PlanetSurface SHA-256: ${c.surfaceChecks})`,
  );
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  runCli();
}
