// A-31 / Stage-8.12d (шаг 5): фактура рельефа (RMS колец), перепад соседних
// вершин суши и батиметрия воротника прибрежного океана (ячейка #137390 и др.).
//
// Самодостаточный регрессионный тест воркера 19c без зависимости от tools/**.
// Запуск: node --test tests/local-map-texture-812d.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Heightfield = require('../src/local-map/local-map-heightfield.ts');
const Worker = require('../src/local-map/local-map-worker.ts');

const CANONICAL_V = 128;
const RADIUS_M = 2500;
const CONTROL_CELLS = Object.freeze([37488, 37518, 37548, 37519, 137363, 137390, 137436]);

const A29_SEED = 0xa29b2026;
const A29_PLACE_ID = 2;
const A29_PROFILE = Object.freeze({
  seedText: 'korhal-iv',
  masterSeedHex: 'a29a29a29a29a29a',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  presetId: 'earthlike_balanced',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 400,
  continentVariation: 0.8,
  oceanBasinMeanCells: 6000,
  drainageMeanCells: 72,
  oceanPctl: 90,
  shelfBelowPctl: 87,
  shelfAbovePctl: 93,
  highlandLandPctl: 75,
  mountainLandPctl: 92,
  aridLandPctl: 25,
  wetLandPctl: 75,
  coldPctl: 20,
  hotPctl: 80,
  streamFlowPctl: 90,
  majorRiverFlowPctl: 99,
  coastSoftWidthCells: 3,
  continentSoftWidthCells: 4,
  biomeSoftWidthCells: 2,
  transitionEntropyPctl: 90,
});

const RMS_RATIO_MIN = 0.70;
const RMS_RATIO_MAX = 1.30;
const LAND_VERTEX_STEP_MAX_M = 6;
const WATER_DEPTH_DELTA_MAX_M = 0.5;
const AZIMUTH_COUNT = 16;
const BATHY_STEPS = 6;
const BATHY_STEP_M = 45;
const PELAGIC_DEPTH_M = 7.25;
const SURF_SHOAL = 0.8;
const WATER_LEVEL_TOL_M = 0.1;

function rms(values) {
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) sumSq += values[i] * values[i];
  return Math.sqrt(sumSq / values.length);
}

function bilinearHeight(heightfield, res, radiusM, x, y) {
  const cellSize = (2 * radiusM) / res;
  const fx = Math.max(0, Math.min(res - 1, x / cellSize + res / 2));
  const fy = Math.max(0, Math.min(res - 1, y / cellSize + res / 2));
  const x0 = Math.min(res - 2, Math.floor(fx));
  const y0 = Math.min(res - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = heightfield[y0 * res + x0];
  const h10 = heightfield[y0 * res + (x0 + 1)];
  const h01 = heightfield[(y0 + 1) * res + x0];
  const h11 = heightfield[(y0 + 1) * res + (x0 + 1)];
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty)
    + (h01 * (1 - tx) + h11 * tx) * ty;
}

function texelAt(map, res, radiusM, x, y) {
  const cellSize = (2 * radiusM) / res;
  const ix = Math.max(0, Math.min(res - 1, Math.floor(x / cellSize + res / 2)));
  const iy = Math.max(0, Math.min(res - 1, Math.floor(y / cellSize + res / 2)));
  return map[iy * res + ix];
}

function sampleSkirtRay(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let prevRadius = 0;
  let prevZ = 0;
  let z = 0;
  let interpolated = false;
  let nearestVertex = 0;
  let bestDist = Infinity;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const vertex = j * angularCount + angularIndex;
    const p = vertex * 3;
    const r = Math.hypot(skirt.positions[p], skirt.positions[p + 1]);
    const currentZ = skirt.positions[p + 2];
    const dist = Math.abs(r - radiusM);
    if (dist < bestDist) {
      bestDist = dist;
      nearestVertex = vertex;
    }
    if (!interpolated && j > 0 && r >= radiusM) {
      const t = r > prevRadius ? (radiusM - prevRadius) / (r - prevRadius) : 0;
      z = prevZ + (currentZ - prevZ) * t;
      interpolated = true;
    }
    prevRadius = r;
    prevZ = currentZ;
  }
  if (!interpolated) z = prevZ;
  return {
    z,
    water: (skirt.waterMask?.[nearestVertex] ?? 0) > 127,
    river: (skirt.riverMask?.[nearestVertex] ?? 0) > 127,
  };
}

function measureRingRmsRatios(local, skirt, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const innerRadiusM = Worker.SKIRT_INNER_RADIUS_RATIO * radiusM;
  const collarEndM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;

  const patchHeights = [];
  for (let y = 0; y < res; y++) {
    const wy = (y - res / 2) * cellSize;
    for (let x = 0; x < res; x++) {
      const wx = (x - res / 2) * cellSize;
      if (Worker.clusterHexMetric(wx, wy) <= apothemM) {
        patchHeights.push(local.heightfield[y * res + x]);
      }
    }
  }

  const collarHeights = [];
  const skirtHeights = [];
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    for (let i = 0; i < angularCount; i++) {
      const p = (j * angularCount + i) * 3;
      const r = Math.hypot(skirt.positions[p], skirt.positions[p + 1]);
      const z = skirt.positions[p + 2];
      if (r >= innerRadiusM && r <= collarEndM) {
        collarHeights.push(z);
      } else if (r > collarEndM) {
        skirtHeights.push(z);
      }
    }
  }

  const rmsPatch = rms(patchHeights);
  const rmsCollar = rms(collarHeights);
  const rmsSkirt = rms(skirtHeights);
  return {
    rmsPatch,
    rmsCollar,
    rmsSkirt,
    ratios: [
      rmsCollar / rmsPatch,
      rmsSkirt / rmsPatch,
      rmsSkirt / rmsCollar,
    ],
  };
}

function measureLandMaxStep(local) {
  const res = Worker.HEIGHTFIELD_RES;
  const hf = local.heightfield;
  const tf = local.terraformMap;
  let landTexels = 0;
  let maxStepM = 0;
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if (tf[i] < 2) continue;
      landTexels++;
      if (x + 1 < res && tf[i + 1] >= 2) {
        const step = Math.abs(hf[i] - hf[i + 1]);
        if (step > maxStepM) maxStepM = step;
      }
      if (y + 1 < res && tf[i + res] >= 2) {
        const step = Math.abs(hf[i] - hf[i + res]);
        if (step > maxStepM) maxStepM = step;
      }
    }
  }
  return { landTexels, maxStepM };
}

function measureCollarWaterDepthDelta(local, skirt, radiusM) {
  const collarEndM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;
  const guardM = Worker.SKIRT_HEIGHTFIELD_GUARD_RATIO * radiusM;
  let waterPairs = 0;
  let maxDeltaM = 0;
  for (let az = 0; az < AZIMUTH_COUNT; az++) {
    const phi = (az / AZIMUTH_COUNT) * Math.PI * 2;
    const angularIndex = (az * Worker.SKIRT_ANGULAR_SEGMENTS) / AZIMUTH_COUNT;
    const cos = Math.cos(phi);
    const sin = Math.sin(phi);
    for (let s = 0; s <= BATHY_STEPS; s++) {
      const distanceM = s * BATHY_STEP_M;
      const innerR = Math.max(0, collarEndM - distanceM);
      const ix = Math.max(-guardM, Math.min(guardM, cos * innerR));
      const iy = Math.max(-guardM, Math.min(guardM, sin * innerR));
      const outerR = collarEndM + distanceM;
      const innerMarker = texelAt(local.terraformMap, Worker.HEIGHTFIELD_RES, radiusM, ix, iy);
      const outer = sampleSkirtRay(skirt, angularIndex, outerR);
      const outerHasWater = outer.river || (outer.water && outer.z <= WATER_LEVEL_TOL_M);
      if (!(innerMarker === 0 || innerMarker === 1) || !outerHasWater) continue;
      const innerH = bilinearHeight(local.heightfield, Worker.HEIGHTFIELD_RES, radiusM, ix, iy);
      const innerDepthM = Math.max(0, -innerH);
      const outerDepthM = Math.max(0, -outer.z);
      const innerWaterDepthM = (innerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const outerWaterDepthM = (outerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const deltaM = Math.abs(innerWaterDepthM - outerWaterDepthM);
      waterPairs++;
      if (deltaM > maxDeltaM) maxDeltaM = deltaM;
    }
  }
  return { waterPairs, maxDeltaM };
}

test('A-31 / Stage-8.12d: sampleLandGrainT ограничена по полосе и непрерывна в [0, 1]', () => {
  const seed = 0x29A29A29;
  const cellSize = (2 * RADIUS_M) / Worker.HEIGHTFIELD_RES;
  const noiseScale = (3.5 + Math.log2(RADIUS_M / 600) * 0.65) / RADIUS_M;
  const budgetM = Worker.LAND_FBM_AMPLITUDE_M + Worker.PROFILE_DETAIL_AMPLITUDE_M;

  let maxGrainStepM = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const ux = (x - 32) * cellSize * noiseScale;
      const uy = (y - 32) * cellSize * noiseScale;
      const g0 = Heightfield.sampleLandGrainT(ux, uy, seed, 0.25);
      const g1 = Heightfield.sampleLandGrainT(ux + cellSize * noiseScale, uy, seed, 0.25);
      const gPlain = Heightfield.sampleLandGrainT(ux, uy, seed, null);
      assert.ok(g0 >= 0 && g0 <= 1, `зерно с detail в [0, 1]: ${g0}`);
      assert.ok(gPlain >= 0 && gPlain <= 1, `зерно без detail в [0, 1]: ${gPlain}`);
      maxGrainStepM = Math.max(maxGrainStepM, Math.abs(g1 - g0) * budgetM);
    }
  }
  assert.ok(
    maxGrainStepM <= LAND_VERTEX_STEP_MAX_M,
    `шаг полосно-ограниченного зерна <= ${LAND_VERTEX_STEP_MAX_M} м (факт ${maxGrainStepM.toFixed(2)} м)`,
  );
});

test('A-31 / Stage-8.12d: все 7 контрольных ячеек A-29 держат фактуру RMS, перепад суши и waterDepthM воротника', async () => {
  const grid = GeodesicGrid.build(CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, A29_PROFILE);
  const totalSamples = AZIMUTH_COUNT * (BATHY_STEPS + 1);

  for (const cellId of CONTROL_CELLS) {
    const patch = Contract.buildPatch7(grid, surface, cellId);
    assert.equal(Contract.verifyPatchInvariants(patch).ok, true, `Patch7 #${cellId} валиден по И-3`);

    Worker.clearLocalMapCache();
    const request = {
      patch,
      seed: A29_SEED,
      placeId: A29_PLACE_ID,
      radiusM: RADIUS_M,
      profile: A29_PROFILE,
      patchKey: `a31-812d-${cellId}`,
    };
    const local = await Worker.generateLocalMap(request);
    const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);

    assert.ok(
      local.meta.genMs <= 150,
      `#${cellId}: время генерации в бюджете G4 (${local.meta.genMs.toFixed(1)} мс)`,
    );

    // Критерий A (м.4): все попарные отношения RMS в [0.70, 1.30]
    const texture = measureRingRmsRatios(local, skirt, RADIUS_M);
    for (const ratio of texture.ratios) {
      assert.ok(
        ratio >= RMS_RATIO_MIN && ratio <= RMS_RATIO_MAX,
        `#${cellId}: отношение RMS колец ${ratio.toFixed(2)}× вне [${RMS_RATIO_MIN}, ${RMS_RATIO_MAX}] `
          + `(патч=${texture.rmsPatch.toFixed(1)} м, воротник=${texture.rmsCollar.toFixed(1)} м, юбка=${texture.rmsSkirt.toFixed(1)} м)`,
      );
    }

    // Критерий B (м.5): перепад соседних вершин на суше <= 6 м
    const landStep = measureLandMaxStep(local);
    if (landStep.landTexels > 0) {
      assert.ok(
        landStep.maxStepM <= LAND_VERTEX_STEP_MAX_M,
        `#${cellId}: перепад соседних вершин суши ${landStep.maxStepM.toFixed(2)} м > ${LAND_VERTEX_STEP_MAX_M} м`,
      );
    }

    // Критерий C (м.6): перепад waterDepthM патч/юбка <= 0.5 м (включая прибрежную #137390)
    const center = patch.cells[0];
    const centerIsOcean = center.elevation < patch.seaLevel && center.lakeWeight === 0;
    const depthDelta = measureCollarWaterDepthDelta(local, skirt, RADIUS_M);
    if (centerIsOcean) {
      assert.equal(
        depthDelta.waterPairs,
        totalSamples,
        `#${cellId}: океанский воротник держит водную маску на всех ${totalSamples} точках профиля`,
      );
      assert.ok(
        depthDelta.maxDeltaM <= WATER_DEPTH_DELTA_MAX_M,
        `#${cellId}: перепад waterDepthM ${depthDelta.maxDeltaM.toFixed(3)} м > ${WATER_DEPTH_DELTA_MAX_M} м`,
      );
    }
  }

  Worker.clearLocalMapCache();
});
