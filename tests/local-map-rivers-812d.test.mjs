/* Stage-8.12d, шаг 4: регресс устья при streamWeight=0 и защита от
   «паутины» вспомогательных лучей. Запуск отдельно от базовых 137 тестов:
   node --test tests/local-map-rivers-812d.test.mjs */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Rivers = require('../src/local-map/local-map-rivers.ts');
const Heightfield = require('../src/local-map/local-map-heightfield.ts');

const PLANET_RADIUS_M = 6_371_000;
const PATCH_RADIUS_M = 2_500;
const RES = Heightfield.HEIGHTFIELD_RES;

function directionAt(u, v) {
  const theta = Math.hypot(u, v) / PLANET_RADIUS_M;
  if (theta === 0) return [0, 0, 1];
  const scale = Math.sin(theta) / Math.hypot(u, v);
  return [u * scale, v * scale, Math.cos(theta)];
}

function patchCell(role, slot, cell, center, overrides = {}) {
  return {
    role,
    slot,
    cell,
    center,
    elevation: 1,
    filledElevation: 1,
    depressionDepth: 0,
    muLand: 1,
    slope: 0,
    lakeId: -1,
    lakeWeight: 0,
    streamWeight: 0,
    riverAccumulation: 0,
    flowReceiver: -1,
    ...overrides,
  };
}

function mouthPatch(outletElevation) {
  const cells = [
    patchCell('center', -1, 100, directionAt(0, 0), {
      riverAccumulation: 248,
      flowReceiver: 101,
    }),
    patchCell('neighbor', 0, 101, directionAt(2_100, 0), { elevation: outletElevation, filledElevation: outletElevation }),
    patchCell('neighbor', 1, 102, directionAt(1_050, 1_819)),
    patchCell('neighbor', 2, 103, directionAt(-1_050, 1_819)),
    patchCell('neighbor', 3, 104, directionAt(-2_100, 0)),
    patchCell('neighbor', 4, 105, directionAt(-1_050, -1_819)),
    patchCell('neighbor', 5, 106, directionAt(1_050, -1_819)),
  ];
  return {
    version: 'local-map-patch-v1',
    v: 128,
    centerCell: 100,
    cells,
    seaLevel: 0,
    radiusKm: 6_371,
    river: {
      centerCell: 100,
      flowsThroughCenter: false,
      centerStreamWeight: 0,
      centerRiverAccumulation: 248,
      inlets: [],
      outlet: { slot: 0, neighborCell: 101, riverAccumulation: 0, streamWeight: 0 },
    },
    frame: {
      origin: [0, 0, 1],
      east: [1, 0, 0],
      north: [0, 1, 0],
      radiusM: PLANET_RADIUS_M,
    },
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

test('Stage-8.12d: устье streamWeight=0 — один честный створ, пологий врез 3…12 м и площадь < 12 %', () => {
  const wetPatch = mouthPatch(-1);
  const cellSize = (2 * PATCH_RADIUS_M) / RES;
  const halfWidthM = Math.max(2 * cellSize, PATCH_RADIUS_M * Rivers.RIVER_HALF_WIDTH_RATIO);
  const segments = Rivers.riverSegments(wetPatch, PATCH_RADIUS_M, halfWidthM);

  assert.equal(segments.length, 1, 'устье строит только канонический outlet, без радиальных лучей');
  assert.equal(
    Rivers.riverSegments(mouthPatch(1), PATCH_RADIUS_M, halfWidthM).length,
    0,
    'обычный сухой flowReceiver при streamWeight=0 не превращается в реку',
  );

  let carveHits = 0;
  const areaGrid = 44;
  const extentM = PATCH_RADIUS_M * 0.95;
  for (let y = 0; y < areaGrid; y++) {
    const wy = -extentM + (y + 0.5) * (2 * extentM / areaGrid);
    for (let x = 0; x < areaGrid; x++) {
      const wx = -extentM + (x + 0.5) * (2 * extentM / areaGrid);
      if (Rivers.riverCarveFactor(wx, wy, segments, halfWidthM) > 0) carveHits++;
    }
  }
  assert.ok(carveHits / (areaGrid * areaGrid) < 0.12, 'один створ занимает меньше 12 % контрольной площади');

  const pointCount = RES * RES;
  const heightM = new Float64Array(pointCount);
  const landMask = new Uint8Array(pointCount);
  const terraformMap = new Uint8Array(pointCount);
  const spawnMask = new Uint8Array(pointCount);
  landMask.fill(1);
  terraformMap.fill(80);
  spawnMask.fill(1);
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      // Зерно намеренно даёт соседние перепады больше 2 м до прохода русла.
      heightM[y * RES + x] = 70 + 2.8 * Math.sin(x * 1.7) + 2.1 * Math.cos(y * 1.3);
    }
  }
  const base = { heightM, landMask, terraformMap, waterPoints: 0 };
  const carved = Rivers.applyRiverCarve(wetPatch, PATCH_RADIUS_M, base, spawnMask);

  let maxBankStepM = 0;
  let worstBankPair = '';
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const idx = y * RES + x;
      const wx = (x - RES / 2) * cellSize;
      const wy = (y - RES / 2) * cellSize;
      const carve = Rivers.riverCarveFactor(wx, wy, segments, halfWidthM);
      if (x + 1 < RES) {
        const nextCarve = Rivers.riverCarveFactor(wx + cellSize, wy, segments, halfWidthM);
        const step = Math.abs(carved[idx] - carved[idx + 1]);
        if ((carve > 0 || nextCarve > 0) && step > maxBankStepM) {
          maxBankStepM = step;
          worstBankPair = `x: (${x}, ${y}) → (${x + 1}, ${y}), carve ${carve.toFixed(3)}/${nextCarve.toFixed(3)}`;
        }
      }
      if (y + 1 < RES) {
        const nextCarve = Rivers.riverCarveFactor(wx, wy + cellSize, segments, halfWidthM);
        const step = Math.abs(carved[idx] - carved[idx + RES]);
        if ((carve > 0 || nextCarve > 0) && step > maxBankStepM) {
          maxBankStepM = step;
          worstBankPair = `y: (${x}, ${y}) → (${x}, ${y + 1}), carve ${carve.toFixed(3)}/${nextCarve.toFixed(3)}`;
        }
      }
    }
  }
  assert.ok(maxBankStepM <= 2, `ступень кромки ${maxBankStepM.toFixed(3)} м не выше 2 м; ${worstBankPair}`);

  const axisX = Math.round(1_000 / cellSize + RES / 2);
  const centerY = RES / 2;
  const bedIndex = centerY * RES + axisX;
  assert.equal(terraformMap[bedIndex], 1, 'стрежень помечен речной водой');
  const bankHeights = [];
  const profileRadius = Math.round(2.5 * halfWidthM / cellSize);
  for (let dy = -profileRadius; dy <= profileRadius; dy++) {
    const idx = (centerY + dy) * RES + axisX;
    if (terraformMap[idx] >= Heightfield.TERRAFORM_LAND_MIN) bankHeights.push(carved[idx]);
  }
  const depthM = median(bankHeights) - carved[bedIndex];
  assert.ok(depthM >= 3 && depthM <= 12, `глубина речной ветви ${depthM.toFixed(3)} м входит в 3…12 м`);
  assert.equal(spawnMask[bedIndex], 0, 'в русле запрещён спавн');
});
