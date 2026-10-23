/* PlanetGlobePack — упаковка GPU-геометрии и цветов вершин глобуса
   (Stage-8.10a, A-12a).
   -------------------------------------------------------------------------
   Модуль выделен из `site/shared/planet-globe.ts`, чтобы рендерер главного
   потока не тянул за собой полное Wasm-ядро (`planet-core-host.ts`).

   Здесь живут ровно две функции, которым нужно полное ядро:
     - `buildVertexColors` (`expandVertexColors`: расширение клеточных цветов
       в RGBA8 по вершинам с альфой границы веера);
     - `buildGlobeGeometry` (`globePack`: позиции `f32×3` + честные наклонные
       нормали рельефа `i16×4 normalized`, вершина 24 байта).

   Допустимые потребители: `site/planet-globe/planet-globe-worker.ts`,
   Node-тесты (`tests/*`) и CPU-бенчмарк (`tools/bench_planet_stage6.mjs`).
   Ядро поднимается лениво при первом вызове функции, а не при импорте. */

import { getSharedPlanetCore, type PlanetCore } from '../../src/planet/planet-core-host.ts';
import type { PlanetGrid } from './geodesic-grid.ts';
import PlanetGlobe from './planet-globe.ts';
import type { GlobeChunkRange, GlobeGeometry, GlobeGeometryOptions } from './planet-globe.ts';
import type { SurfaceResult } from './planet-surface.ts';

function getCore(): PlanetCore {
  return getSharedPlanetCore();
}

function clamp01(x: number): number { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function reliefDelta(surface: SurfaceResult, elevation: number, reliefScale: number): number {
  const sea = surface.seaLevel || 0;
  if (elevation >= sea) {
    const span = Math.max(1e-9, (surface.elevationMax || sea) - sea);
    return clamp01((elevation - sea) / span) * 0.022 * reliefScale;
  }
  const depthSpan = Math.max(1e-9, sea - (surface.elevationMin || sea));
  return -clamp01((sea - elevation) / depthSpan) * 0.008 * reliefScale;
}

function assertGeometryInputs(grid: PlanetGrid, surface: SurfaceResult): void {
  if (!grid || !grid.centers || !grid.corners || !grid.cellCorners || !grid.cellCornerStart ||
      !Number.isInteger(grid.cellCount)) {
    throw new Error('PlanetGlobe: нужна сетка GeodesicGrid');
  }
  if (!surface || surface.cellCount !== grid.cellCount || !surface.elevation || !surface.biomeColor) {
    throw new Error('PlanetGlobe: нужна поверхность PlanetSurface той же формы, что сетка');
  }
}

/** @workerOnly Полное Wasm-ядро (expandVertexColors). На главный поток не
 *  вызывать: цвет вершины приезжает из воркера готовым в `geometry.colors`. */
export function buildVertexColors(
  surface: SurfaceResult,
  vertexCellId: Uint32Array,
  mode?: string,
  cellCount?: number,
): Uint8Array {
  const cellColors = PlanetGlobe.buildCellColors(surface, mode || 'biome');
  const centerCount = cellCount == null ? surface.cellCount : cellCount;
  return getCore().expandVertexColors(vertexCellId, cellColors, centerCount);
}

/** @workerOnly Полное Wasm-ядро (globePack: позиции f32×3 + наклонные
 *  нормали i16×4, вершина 24 Б). Вызывается из воркера, тестов и бенчмарка;
 *  рендерер получает результаты transferable-массивами через
 *  `setGeometry` / `transitionGeometry`. */
export function buildGlobeGeometry(
  grid: PlanetGrid,
  surface: SurfaceResult,
  options?: GlobeGeometryOptions | null,
): GlobeGeometry {
  const opts = options || {};
  assertGeometryInputs(grid, surface);
  const reliefScale = opts.reliefScale == null ? 1 : Number(opts.reliefScale);
  const F = grid.cellCount;
  const totalSides = grid.cellCorners.length;
  const vertexCount = F + totalSides;
  const vertexCellId = new Uint32Array(vertexCount);
  const indices = new Uint32Array(totalSides * 3);
  const cellIndexStart = new Uint32Array(F + 1);

  const cellRadius = new Float32Array(F);
  let c: number, k: number;
  for (c = 0; c < F; c++) cellRadius[c] = 1 + reliefDelta(surface, surface.elevation[c] as number, reliefScale);
  const cornerRadius = new Float32Array(grid.triangleCount || (grid.corners.length / 3));
  for (let t = 0; t < cornerRadius.length; t++) {
    if (grid.triangles) {
      const a = grid.triangles[t * 3] as number, b = grid.triangles[t * 3 + 1] as number, d = grid.triangles[t * 3 + 2] as number;
      cornerRadius[t] = ((cellRadius[a] as number) + (cellRadius[b] as number) + (cellRadius[d] as number)) / 3;
    } else cornerRadius[t] = 1;
  }

  // Позиции и нормали упаковывает Wasm-ядро globePack; сетка отдаёт
  // углы как Uint32Array — zero-copy Int32Array-вьюха на тот же буфер.
  const cellCornersI32 = new Int32Array(grid.cellCorners.buffer, grid.cellCorners.byteOffset, grid.cellCorners.length);
  const cellCornerStartI32 = new Int32Array(grid.cellCornerStart.buffer, grid.cellCornerStart.byteOffset, grid.cellCornerStart.length);
  const packed = getCore().globePack(grid.centers, grid.corners, cellCornersI32, cellCornerStartI32,
    cellRadius, cornerRadius, F);
  const positions = packed.positions;
  const normals = packed.normals;

  for (c = 0; c < F; c++) vertexCellId[c] = c;
  let slot = F;
  let w = 0;
  for (c = 0; c < F; c++) {
    cellIndexStart[c] = w;
    const start = grid.cellCornerStart[c] as number;
    const sides = (grid.cellCornerStart[c + 1] as number) - start;
    for (k = 0; k < sides; k++) {
      vertexCellId[slot] = c;
      slot++;
    }
    const firstCornerSlot = slot - sides;
    for (k = 0; k < sides; k++) {
      indices[w++] = c;
      indices[w++] = firstCornerSlot + k;
      indices[w++] = firstCornerSlot + ((k + 1) % sides);
    }
  }
  cellIndexStart[F] = w;

  const chunkRanges: GlobeChunkRange[] = [];
  if (grid.chunkCellStart && grid.chunkCenters && grid.chunkCosAngularRadius) {
    for (let ci = 0; ci < (grid.chunkCount as number); ci++) {
      const startCell = grid.chunkCellStart[ci] as number;
      const endCell = grid.chunkCellStart[ci + 1] as number;
      chunkRanges.push({
        id: ci,
        startCell: startCell,
        cellCount: endCell - startCell,
        indexStart: cellIndexStart[startCell] as number,
        indexCount: (cellIndexStart[endCell] as number) - (cellIndexStart[startCell] as number),
        center: [grid.chunkCenters[ci * 3] as number, grid.chunkCenters[ci * 3 + 1] as number, grid.chunkCenters[ci * 3 + 2] as number],
        cosAngularRadius: grid.chunkCosAngularRadius[ci] as number,
        sinAngularRadius: grid.chunkSinAngularRadius ? (grid.chunkSinAngularRadius[ci] as number) : 0,
      });
    }
  }

  const colors = buildVertexColors(surface, vertexCellId, opts.colorMode || 'biome', F);
  return {
    version: PlanetGlobe.GLOBE_VERSION,
    v: grid.v,
    cellCount: F,
    vertexCount: vertexCount,
    triangleCount: totalSides,
    indexCount: indices.length,
    positions: positions,
    normals: normals,
    colors: colors,
    indices: indices,
    vertexCellId: vertexCellId,
    cellIndexStart: cellIndexStart,
    chunkRanges: chunkRanges,
    reliefScale: reliefScale,
    typedBytes: positions.byteLength + normals.byteLength + colors.byteLength + indices.byteLength,
  };
}
