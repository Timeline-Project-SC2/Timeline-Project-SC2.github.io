import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.js');
const PlanetSurface = require('../site/shared/planet-surface.js');
const PlanetGlobe = require('../site/shared/planet-globe.js');

const V = 16;
const grid = GeodesicGrid.build(V);
const surface = PlanetSurface.generateSurface(grid, {
  masterSeedHex: '0123456789abcdef',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  geographyVersion: 'c100-soft-v2',
  // Нормы v=16 как доля канонической Земли v=128: тот же физический
  // масштаб, который worker строит для LOD-прокси.
  continentMeanCells: 7,
  oceanBasinMeanCells: 94,
  drainageMeanCells: 2,
  coastSoftWidthCells: 0.375,
  continentSoftWidthCells: 0.5,
  biomeSoftWidthCells: 0.25,
});

test('planet-globe-v1: геометрия ячеек индексированная, полная и без дырок по индексам', () => {
  const geometry = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'biome' });
  const expectedCells = 10 * V * V + 2;
  const expectedSides = grid.cellCorners.length;

  assert.equal(geometry.version, 'planet-globe-v1');
  assert.equal(geometry.cellCount, expectedCells);
  assert.equal(geometry.triangleCount, expectedSides);
  assert.equal(geometry.vertexCount, expectedCells + expectedSides);
  assert.equal(geometry.positions.length, geometry.vertexCount * 3);
  assert.equal(geometry.colors.length, geometry.vertexCount * 4);
  assert.equal(geometry.indices.length, expectedSides * 3);
  assert.equal(geometry.cellIndexStart.length, expectedCells + 1);
  assert.equal(geometry.cellIndexStart[expectedCells], geometry.indices.length);
  assert.equal(
    geometry.typedBytes,
    geometry.positions.byteLength + geometry.colors.byteLength + geometry.indices.byteLength,
  );

  for (let c = 0; c < expectedCells; c++) {
    const sides = grid.cellCornerStart[c + 1] - grid.cellCornerStart[c];
    assert.equal(geometry.cellIndexStart[c + 1] - geometry.cellIndexStart[c], sides * 3);
  }
  for (let i = 0; i < geometry.indices.length; i++) {
    assert.ok(geometry.indices[i] >= 0 && geometry.indices[i] < geometry.vertexCount);
  }
  for (let i = 0; i < geometry.positions.length; i++) assert.ok(Number.isFinite(geometry.positions[i]));

  // A-канал цвета кодирует край веера: центр 0, углы 255.
  assert.equal(geometry.colors[3], 0);
  assert.equal(geometry.colors[(geometry.cellCount + 1) * 4 + 3], 255);

  let rangeCells = 0;
  let rangeIndices = 0;
  for (const range of geometry.chunkRanges) {
    rangeCells += range.cellCount;
    rangeIndices += range.indexCount;
    assert.ok(range.indexStart >= 0);
    assert.ok(range.indexStart + range.indexCount <= geometry.indices.length);
    assert.ok(range.cosAngularRadius >= -1 && range.cosAngularRadius <= 1);
  }
  assert.equal(rangeCells, expectedCells);
  assert.equal(rangeIndices, geometry.indices.length);
});

test('planet-globe-v1: геометрия и цвета детерминированы для одинаковой поверхности', () => {
  const first = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'rivers' });
  const second = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'rivers' });
  assert.deepEqual(first.positions, second.positions);
  assert.deepEqual(first.colors, second.colors);
  assert.deepEqual(first.indices, second.indices);

  const transferables = PlanetGlobe.listGeometryTransferables(first, false);
  assert.equal(transferables.length, 3);
  assert.ok(!transferables.includes(first.vertexCellId.buffer));
});

test('planet-globe-v1: все цветовые слои конечны, а речной слой реально выделяет сток', () => {
  for (const mode of PlanetGlobe.COLOR_MODES.map((item) => item.key)) {
    const colors = PlanetGlobe.buildCellColors(surface, mode);
    assert.equal(colors.length, surface.cellCount * 3, mode);
    for (let i = 0; i < colors.length; i++) {
      assert.ok(Number.isFinite(colors[i]), `${mode}:${i}`);
      assert.ok(colors[i] >= -1e-6 && colors[i] <= 1 + 1e-6, `${mode}:${i}=${colors[i]}`);
    }
  }

  const biome = PlanetGlobe.buildCellColors(surface, 'biome');
  const rivers = PlanetGlobe.buildCellColors(surface, 'rivers');
  let streamCell = -1;
  let bestStream = 0;
  for (let c = 0; c < surface.cellCount; c++) {
    if (surface.streamWeight[c] > bestStream) {
      bestStream = surface.streamWeight[c];
      streamCell = c;
    }
  }
  assert.ok(streamCell >= 0 && bestStream > 0.2, 'в тестовой поверхности должен быть заметный сток');
  assert.ok(rivers[streamCell * 3 + 2] > biome[streamCell * 3 + 2] + 0.15);
});

test('planet-globe-v1: рельеф поднимает сушу и опускает глубокий океан без разрыва полигона pick', () => {
  const geometry = PlanetGlobe.buildGlobeGeometry(grid, surface, { colorMode: 'biome', reliefScale: 1 });
  const radiusOfCenter = (cell) => Math.hypot(
    geometry.positions[cell * 3],
    geometry.positions[cell * 3 + 1],
    geometry.positions[cell * 3 + 2],
  );
  let highLand = -1;
  let deepOcean = -1;
  for (let c = 0; c < surface.cellCount; c++) {
    if (highLand < 0 || surface.elevation[c] > surface.elevation[highLand]) highLand = c;
    if (deepOcean < 0 || surface.elevation[c] < surface.elevation[deepOcean]) deepOcean = c;
  }
  assert.ok(surface.elevation[highLand] > surface.seaLevel);
  assert.ok(surface.elevation[deepOcean] < surface.seaLevel);
  assert.ok(radiusOfCenter(highLand) > 1.005);
  assert.ok(radiusOfCenter(deepOcean) < 0.999);

  const polygon = PlanetGlobe.cellPolygon(grid, surface, highLand, { reliefScale: 1, inflate: 1.006 });
  const sides = grid.cellCornerStart[highLand + 1] - grid.cellCornerStart[highLand];
  assert.equal(polygon.corners.length, sides);
  assert.ok(Math.hypot(...polygon.center) > radiusOfCenter(highLand));
  for (const corner of polygon.corners) {
    for (const value of corner) assert.ok(Number.isFinite(value));
    assert.ok(Math.hypot(...corner) > 0.98 && Math.hypot(...corner) < 1.05);
  }
  assert.equal(PlanetGlobe.cellPolygon(grid, surface, -1), null);
});

test('planet-globe-v1: портретный FOV сохраняет горизонтальный угол и помещает планету по ширине', () => {
  const landscape = PlanetGlobe.fieldOfViewYForAspect(16 / 9);
  assert.ok(Math.abs(landscape - 42 * Math.PI / 180) < 1e-12);

  const portraitAspect = 9 / 19.5;
  const portrait = PlanetGlobe.fieldOfViewYForAspect(portraitAspect);
  const horizontalHalfTan = Math.tan(portrait / 2) * portraitAspect;
  assert.ok(Math.abs(horizontalHalfTan - Math.tan(landscape / 2)) < 1e-12);
  assert.ok(portrait > 1.25 && portrait < 1.45);

  // При стартовой дистанции 3.05 диск должен занимать меньше ширины,
  // а не ~170% кадра, как при фиксированном FOV 42° в портрете.
  const projectedRadiusNdc = 1 / (3.05 * horizontalHalfTan);
  assert.ok(projectedRadiusNdc > 0.8 && projectedRadiusNdc < 0.9);
});

test('planet-globe-v1: fallback-развёртка заполнена и сохраняет размер/альфу', () => {
  const preview = PlanetGlobe.buildEquirectPreview(grid, surface, 180, 90, 'biome');
  assert.equal(preview.width, 180);
  assert.equal(preview.height, 90);
  assert.equal(preview.data.length, 180 * 90 * 4);
  let nonBackground = 0;
  for (let i = 0; i < preview.data.length; i += 4) {
    assert.equal(preview.data[i + 3], 255);
    if (!(preview.data[i] === 3 && preview.data[i + 1] === 18 && preview.data[i + 2] === 48)) nonBackground++;
  }
  assert.ok(nonBackground > 180 * 90 * 0.75);
});
