/* GeodesicGrid — сетка Голдберга goldberg-gp-v1 для TIMELINE PROJECT.
   Строгий TS-порт geodesic-grid.js (CR-01 PR 4, И-5): алгоритм, порядок
   вершин/граней, строковые ключи toFixed(9), сортировки и все численные
   выражения повторены дословно — от них зависят канонические адреса
   ячеек goldberg-gp-v1/w0/v<freq>/<cell>. Публичный API сохранён. */

export interface GridChunk {
  id: number;
  faceIndex: number;
  blockI: number;
  blockJ: number;
  blockCount: number;
  startCell: number;
  cellCount: number;
  boundingSphere: {
    center: number[];
    radius: number;
    cosAngularRadius: number;
    angularRadius: number;
  };
}

export interface PlanetGrid {
  v: number;
  bodyIndex: number;
  cellCount: number;
  triangleCount: number;
  centers: Float32Array;
  corners: Float32Array;
  triangles: Uint32Array;
  cellCornerStart: Uint32Array;
  cellCorners: Uint32Array;
  neighbors: Int32Array;
  neighborCount: Uint8Array;
  areas: Float32Array;
  pentagons: number;
  addrFace: Uint8Array;
  addrI: Uint16Array;
  addrJ: Uint16Array;
  cellChunk: Uint32Array;
  gridVersion?: string;
  addressSchema?: string;
  topologySchema?: string;
  chunkSchema?: string;
  chunkBlockSteps?: number;
  chunkCount?: number;
  chunkCellStart?: Uint32Array;
  chunkFace?: Uint16Array;
  chunkCenters?: Float32Array;
  chunkRadius?: Float32Array;
  chunkCosAngularRadius?: Float32Array;
  chunkSinAngularRadius?: Float32Array;
  chunkNeighborStart?: Uint32Array;
  chunkNeighbors?: Uint32Array;
  chunks?: GridChunk[];
}

export interface ParsedAddress {
  gridVersion: string;
  addressSchema: string;
  bodyIndex: number;
  v: number;
  face: number;
  faceIndex: number;
  i: number;
  j: number;
}

export interface GridValidation {
  ok: boolean;
  checks: Record<string, boolean>;
  areaSum: number;
  chunks?: ChunkValidation;
}

export interface ChunkValidation {
  ok: boolean;
  checks: Record<string, boolean>;
  error?: string;
  chunkCount?: number;
  averageCells?: number;
  maxCells?: number;
  maxAngularRadius?: number;
}

export interface GridCacheMeta {
  addressSchema: string;
  gridVersion: string;
  topologySchema: string;
  v?: number;
}

export interface DeserializeResult {
  ok: boolean;
  reason?: string;
  grid?: PlanetGrid;
  validation?: GridValidation;
  error?: string;
}

const GRID_VERSION = 'goldberg-gp-v1';
const ADDRESS_SCHEMA = GRID_VERSION;
const TOPOLOGY_SCHEMA = 'goldberg-gp-v1-soa';
const CHUNK_SCHEMA = 'face-barycentric-blocks-v1';
const CHUNK_BLOCK_STEPS = 32;
const CHUNK_MIN_CELLS = 32;
const CHUNK_MAX_CELLS = 1088;
const EARTH_RADIUS_KM = 6371;
const EARTH_CANONICAL_V = 128;
const CACHE_FORMAT_VERSION = 1;
const CACHE_HEADER_LENGTH = 32;
const CACHE_ENDIANNESS_MARKER = 0x01020304;

function normalize3(x: number, y: number, z: number, out: number[]): number[] {
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  return out;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : (x > hi ? hi : x);
}

function cellCountForFrequency(v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new Error('GeodesicGrid: v должно быть целым >= 1');
  return 10 * v * v + 2;
}

function triangleCountForFrequency(v: number): number {
  if (!Number.isInteger(v) || v < 1) throw new Error('GeodesicGrid: v должно быть целым >= 1');
  return 20 * v * v;
}

function frequencyForRadius(radiusKm: number): number {
  if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
    throw new Error('GeodesicGrid.frequencyForRadius: radiusKm должно быть конечным > 0');
  }
  const earthCells = cellCountForFrequency(EARTH_CANONICAL_V);
  const ratio = radiusKm / EARTH_RADIUS_KM;
  const targetCells = earthCells * ratio * ratio;
  return Math.max(1, Math.round(Math.sqrt(Math.max(0, targetCells - 2) / 10)));
}

function meanCellAreaKm2(radiusKm: number, v?: number | null): number {
  const freq = v == null ? frequencyForRadius(radiusKm) : v;
  return 4 * Math.PI * radiusKm * radiusKm / cellCountForFrequency(freq);
}

function meanCellEdgeKm(radiusKm: number, v?: number | null): number {
  // Оценка по равновеликому правильному шестиугольнику.
  return Math.sqrt(2 * meanCellAreaKm2(radiusKm, v) / (3 * Math.sqrt(3)));
}

function icosahedron(): { verts: number[][]; faces: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  // Порядок raw-вершин заморожен goldberg-gp-v1: от него зависят номера
  // граней и канонические адреса на общих рёбрах.
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const verts = raw.map(function (p) { return normalize3(p[0] as number, p[1] as number, p[2] as number, [0, 0, 0]); });
  let minD2 = Infinity;
  let i: number, j: number, k: number;
  const vertAt = function (idx: number): number[] { return verts[idx] as number[]; };
  for (i = 0; i < 12; i++) for (j = i + 1; j < 12; j++) {
    const vi = vertAt(i), vj = vertAt(j);
    const dx = (vi[0] as number) - (vj[0] as number);
    const dy = (vi[1] as number) - (vj[1] as number);
    const dz = (vi[2] as number) - (vj[2] as number);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < minD2) minD2 = d2;
  }
  function isEdge(a: number, b: number): boolean {
    const va = vertAt(a), vb = vertAt(b);
    const ex = (va[0] as number) - (vb[0] as number);
    const ey = (va[1] as number) - (vb[1] as number);
    const ez = (va[2] as number) - (vb[2] as number);
    return Math.abs(ex * ex + ey * ey + ez * ez - minD2) < 1e-9;
  }
  const faces: number[][] = [];
  for (i = 0; i < 12; i++) for (j = i + 1; j < 12; j++) for (k = j + 1; k < 12; k++) {
    if (!isEdge(i, j) || !isEdge(j, k) || !isEdge(i, k)) continue;
    const a = verts[i] as number[], b = verts[j] as number[], c = verts[k] as number[];
    const ux = (b[0] as number) - (a[0] as number), uy = (b[1] as number) - (a[1] as number), uz = (b[2] as number) - (a[2] as number);
    const vx = (c[0] as number) - (a[0] as number), vy = (c[1] as number) - (a[1] as number), vz = (c[2] as number) - (a[2] as number);
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const outward = nx * ((a[0] as number) + (b[0] as number) + (c[0] as number)) +
      ny * ((a[1] as number) + (b[1] as number) + (c[1] as number)) +
      nz * ((a[2] as number) + (b[2] as number) + (c[2] as number));
    faces.push(outward > 0 ? [i, j, k] : [i, k, j]);
  }
  if (faces.length !== 20) throw new Error('GeodesicGrid: икосаэдр должен дать ровно 20 граней');
  return { verts, faces };
}

function sphericalTriangleArea(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const triple = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const denom = 1 + (ax * bx + ay * by + az * bz) + (bx * cx + by * cy + bz * cz) + (cx * ax + cy * ay + cz * az);
  return 2 * Math.atan2(triple, denom);
}

function insertionSortSegment(values: Int32Array, start: number, end: number): void {
  for (let i = start + 1; i < end; i++) {
    const value = values[i] as number;
    let j = i - 1;
    while (j >= start && (values[j] as number) > value) {
      values[j + 1] = values[j] as number;
      j--;
    }
    values[j + 1] = value;
  }
}

function candidateIsSmaller(face: number, i: number, j: number, oldFace: number, oldI: number, oldJ: number): boolean {
  return face < oldFace ||
    (face === oldFace && (i < oldI || (i === oldI && j < oldJ)));
}

function chunkBlockIndex(coord: number): number {
  return Math.floor(coord / CHUNK_BLOCK_STEPS);
}

interface RawGrid {
  v: number;
  cellCount: number;
  triangleCount: number;
  centers: Float32Array;
  corners: Float32Array;
  triangles: Uint32Array;
  cellCornerStart: Uint32Array;
  cellCorners: Uint32Array;
  neighbors: Int32Array;
  neighborCount: Uint8Array;
  areas: Float32Array;
  pentagons: number;
  addrFace: Uint8Array;
  addrI: Uint16Array;
  addrJ: Uint16Array;
}

let rawScratchCap = 0;
let centersRawBuf = new Float32Array(0);
let trianglesRawBuf = new Uint32Array(0);
let addrFaceRawBuf = new Uint8Array(0);
let addrIRawBuf = new Uint16Array(0);
let addrJRawBuf = new Uint16Array(0);
let incidenceCountBuf = new Uint8Array(0);
let cellCornerStartRawBuf = new Uint32Array(0);
let cellCornersRawBuf = new Uint32Array(0);
let fillCursorBuf = new Uint32Array(0);
let neighborsRawBuf = new Int32Array(0);
let neighborCountRawBuf = new Uint8Array(0);
let areasRawBuf = new Float32Array(0);
let oldKeyBuf = new Uint32Array(0);
let orderBuf = new Uint32Array(0);
let sortKeyBuf = new Uint32Array(0);
let newIdBuf = new Uint32Array(0);
let localRawBuf = new Int32Array(129 * 129);

function ensureRawScratch(expectedCells: number, expectedTriangles: number): void {
  const capCells = expectedCells < 163842 ? 163842 : expectedCells;
  if (rawScratchCap >= capCells) return;
  const capTris = expectedTriangles < 327680 ? 327680 : expectedTriangles;
  rawScratchCap = capCells;
  centersRawBuf = new Float32Array(capCells * 3);
  trianglesRawBuf = new Uint32Array(capTris * 3);
  addrFaceRawBuf = new Uint8Array(capCells);
  addrIRawBuf = new Uint16Array(capCells);
  addrJRawBuf = new Uint16Array(capCells);
  incidenceCountBuf = new Uint8Array(capCells);
  cellCornerStartRawBuf = new Uint32Array(capCells + 1);
  cellCornersRawBuf = new Uint32Array(capTris * 3);
  fillCursorBuf = new Uint32Array(capCells + 1);
  neighborsRawBuf = new Int32Array(capCells * 6);
  neighborCountRawBuf = new Uint8Array(capCells);
  areasRawBuf = new Float32Array(capCells);
  oldKeyBuf = new Uint32Array(capCells);
  orderBuf = new Uint32Array(capCells);
  sortKeyBuf = new Uint32Array(capCells);
  newIdBuf = new Uint32Array(capCells);
}

function addNeighborRaw(cell: number, nb: number): void {
  const base = cell * 6;
  const count = neighborCountRawBuf[cell] as number;
  for (let k = 0; k < count; k++) if (neighborsRawBuf[base + k] === nb) return;
  if (count >= 6) throw new Error('GeodesicGrid.build: у ячейки больше 6 соседей');
  neighborsRawBuf[base + count] = nb;
  neighborCountRawBuf[cell] = count + 1;
}

function build(v: number): PlanetGrid {
  if (!Number.isInteger(v) || v < 1 || v > 10000) {
    throw new Error('GeodesicGrid.build: v должно быть целым от 1 до 10000');
  }
  const ico = icosahedron();
  const expectedCells = cellCountForFrequency(v);
  const expectedTriangles = triangleCountForFrequency(v);
  ensureRawScratch(expectedCells, expectedTriangles);

  const centersRaw = centersRawBuf.subarray(0, expectedCells * 3);
  const addrFaceRaw = addrFaceRawBuf.subarray(0, expectedCells);
  const addrIRaw = addrIRawBuf.subarray(0, expectedCells);
  const addrJRaw = addrJRawBuf.subarray(0, expectedCells);
  let vertexCount = 0;
  const byKey = new Map<string, number>();

  function getVertex(x: number, y: number, z: number, face: number, i: number, j: number): number {
    const len = Math.sqrt(x * x + y * y + z * z);
    const nx = x / len, ny = y / len, nz = z / len;
    // Внутренние вершины грани (i > 0 && j > 0 && i + j < v) топологически не могут
    // совпадать с вершинами других граней икосаэдра — строковый ключ нужен только на границе.
    if (i === 0 || j === 0 || i + j === v) {
      const key = nx.toFixed(9) + ',' + ny.toFixed(9) + ',' + nz.toFixed(9);
      const found = byKey.get(key);
      if (found !== undefined) {
        if (candidateIsSmaller(face, i, j, addrFaceRaw[found] as number, addrIRaw[found] as number, addrJRaw[found] as number)) {
          addrFaceRaw[found] = face;
          addrIRaw[found] = i;
          addrJRaw[found] = j;
        }
        return found;
      }
      const id = vertexCount++;
      const id3 = id * 3;
      centersRaw[id3] = nx;
      centersRaw[id3 + 1] = ny;
      centersRaw[id3 + 2] = nz;
      addrFaceRaw[id] = face;
      addrIRaw[id] = i;
      addrJRaw[id] = j;
      byKey.set(key, id);
      return id;
    }
    const id = vertexCount++;
    const id3 = id * 3;
    centersRaw[id3] = nx;
    centersRaw[id3 + 1] = ny;
    centersRaw[id3 + 2] = nz;
    addrFaceRaw[id] = face;
    addrIRaw[id] = i;
    addrJRaw[id] = j;
    return id;
  }

  const trianglesRaw = trianglesRawBuf.subarray(0, expectedTriangles * 3);
  let triCursor = 0;
  const stride = v + 1;
  const strideSq = stride * stride;
  if (localRawBuf.length < strideSq) localRawBuf = new Int32Array(strideSq);
  const local = localRawBuf.subarray(0, strideSq);
  ico.faces.forEach(function (faceIdx, faceNo) {
    const A = ico.verts[faceIdx[0] as number] as number[];
    const B = ico.verts[faceIdx[1] as number] as number[];
    const C = ico.verts[faceIdx[2] as number] as number[];
    local.fill(-1);
    function P(i: number, j: number): number {
      const key = i * stride + j;
      const cached = local[key] as number;
      if (cached >= 0) return cached;
      const wa = (v - i - j) / v, wb = i / v, wc = j / v;
      const id = getVertex(
        (A[0] as number) * wa + (B[0] as number) * wb + (C[0] as number) * wc,
        (A[1] as number) * wa + (B[1] as number) * wb + (C[1] as number) * wc,
        (A[2] as number) * wa + (B[2] as number) * wb + (C[2] as number) * wc,
        faceNo, i, j,
      );
      local[key] = id;
      return id;
    }
    for (let i = 0; i < v; i++) {
      for (let j = 0; j < v - i; j++) {
        const p00 = P(i, j);
        const p10 = P(i + 1, j);
        const p01 = P(i, j + 1);
        trianglesRaw[triCursor++] = p00;
        trianglesRaw[triCursor++] = p10;
        trianglesRaw[triCursor++] = p01;
        if (i + j < v - 1) {
          trianglesRaw[triCursor++] = p10;
          trianglesRaw[triCursor++] = P(i + 1, j + 1);
          trianglesRaw[triCursor++] = p01;
        }
      }
    }
  });
  if (vertexCount !== expectedCells || triCursor !== trianglesRaw.length) {
    throw new Error('GeodesicGrid.build: внутреннее несоответствие числа вершин/треугольников');
  }

  const cellCount = expectedCells;
  const triangleCount = expectedTriangles;
  const corners = new Float32Array(triangleCount * 3);
  const incidenceCount = incidenceCountBuf.subarray(0, cellCount);
  incidenceCount.fill(0);
  let t: number, a: number, b: number, d: number;
  for (t = 0; t < triangleCount; t++) {
    const t3 = t * 3;
    a = trianglesRaw[t3] as number; b = trianglesRaw[t3 + 1] as number; d = trianglesRaw[t3 + 2] as number;
    const a3 = a * 3, b3 = b * 3, d3 = d * 3;
    const sx = (centersRaw[a3] as number) + (centersRaw[b3] as number) + (centersRaw[d3] as number);
    const sy = (centersRaw[a3 + 1] as number) + (centersRaw[b3 + 1] as number) + (centersRaw[d3 + 1] as number);
    const sz = (centersRaw[a3 + 2] as number) + (centersRaw[b3 + 2] as number) + (centersRaw[d3 + 2] as number);
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    corners[t3] = sx / len; corners[t3 + 1] = sy / len; corners[t3 + 2] = sz / len;
    incidenceCount[a] = (incidenceCount[a] as number) + 1;
    incidenceCount[b] = (incidenceCount[b] as number) + 1;
    incidenceCount[d] = (incidenceCount[d] as number) + 1;
  }

  const cellCornerStartRaw = cellCornerStartRawBuf.subarray(0, cellCount + 1);
  let offset = 0;
  let c: number;
  for (c = 0; c < cellCount; c++) {
    cellCornerStartRaw[c] = offset;
    offset += incidenceCount[c] as number;
  }
  cellCornerStartRaw[cellCount] = offset;
  const cellCornersRaw = cellCornersRawBuf.subarray(0, offset);
  const fillCursor = fillCursorBuf.subarray(0, cellCount + 1);
  fillCursor.set(cellCornerStartRaw);
  for (t = 0; t < triangleCount; t++) {
    a = trianglesRaw[t * 3] as number; b = trianglesRaw[t * 3 + 1] as number; d = trianglesRaw[t * 3 + 2] as number;
    cellCornersRaw[fillCursor[a] as number] = t;
    fillCursor[a] = (fillCursor[a] as number) + 1;
    cellCornersRaw[fillCursor[b] as number] = t;
    fillCursor[b] = (fillCursor[b] as number) + 1;
    cellCornersRaw[fillCursor[d] as number] = t;
    fillCursor[d] = (fillCursor[d] as number) + 1;
  }

  // Соседи фиксированной ширины 6: без Set на каждую ячейку. Дубли рёбер
  // от двух инцидентных треугольников отсекаются линейной проверкой до 6 слотов.
  const neighborsRaw = neighborsRawBuf.subarray(0, cellCount * 6);
  const neighborCountRaw = neighborCountRawBuf.subarray(0, cellCount);
  neighborCountRaw.fill(0);
  for (t = 0; t < triangleCount; t++) {
    a = trianglesRaw[t * 3] as number; b = trianglesRaw[t * 3 + 1] as number; d = trianglesRaw[t * 3 + 2] as number;
    addNeighborRaw(a, b); addNeighborRaw(a, d);
    addNeighborRaw(b, a); addNeighborRaw(b, d);
    addNeighborRaw(d, a); addNeighborRaw(d, b);
  }
  let pentagons = 0;
  for (c = 0; c < cellCount; c++) {
    if (neighborCountRaw[c] === 5) pentagons++;
  }

  const areasRaw = areasRawBuf.subarray(0, cellCount);
  const angles = new Float64Array(6);
  for (c = 0; c < cellCount; c++) {
    const start = cellCornerStartRaw[c] as number;
    const end = cellCornerStartRaw[c + 1] as number;
    const cx = centersRaw[c * 3] as number, cy = centersRaw[c * 3 + 1] as number, cz = centersRaw[c * 3 + 2] as number;
    const ax = Math.abs(cx) < 0.9 ? 1 : 0, ay = Math.abs(cx) < 0.9 ? 0 : 1;
    const ux = -cz * ay, uy = cz * ax, uz = cx * ay - cy * ax;
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const t1x = ux / ulen, t1y = uy / ulen, t1z = uz / ulen;
    const t2x = cy * t1z - cz * t1y;
    const t2y = cz * t1x - cx * t1z;
    const t2z = cx * t1y - cy * t1x;
    let k: number;
    for (k = start; k < end; k++) {
      const corner = (cellCornersRaw[k] as number) * 3;
      const crx = corners[corner] as number, cry = corners[corner + 1] as number, crz = corners[corner + 2] as number;
      const py = crx * t2x + cry * t2y + crz * t2z;
      const px = crx * t1x + cry * t1y + crz * t1z;
      const axp = px < 0 ? -px : px;
      const ayp = py < 0 ? -py : py;
      const r = px / (axp + ayp);
      angles[k - start] = py < 0 ? r - 1 : (py === 0 && px < 0 ? 2 : 1 - r);
    }
    // Insertion sort сегмента из 5/6 углов по заранее посчитанным углам.
    for (let ii = 1; ii < end - start; ii++) {
      const cornerValue = cellCornersRaw[start + ii] as number;
      const angleValue = angles[ii] as number;
      let jj = ii - 1;
      while (jj >= 0 && (angles[jj] as number) > angleValue) {
        cellCornersRaw[start + jj + 1] = cellCornersRaw[start + jj] as number;
        angles[jj + 1] = angles[jj] as number;
        jj--;
      }
      cellCornersRaw[start + jj + 1] = cornerValue;
      angles[jj + 1] = angleValue;
    }
    let area = 0;
    for (k = 1; k + 1 < end - start; k++) {
      const p0 = (cellCornersRaw[start] as number) * 3;
      const p1 = (cellCornersRaw[start + k] as number) * 3;
      const p2 = (cellCornersRaw[start + k + 1] as number) * 3;
      area += sphericalTriangleArea(
        corners[p0] as number, corners[p0 + 1] as number, corners[p0 + 2] as number,
        corners[p1] as number, corners[p1 + 1] as number, corners[p1 + 2] as number,
        corners[p2] as number, corners[p2 + 1] as number, corners[p2 + 2] as number,
      );
    }
    if (area < 0) {
      let lo = start, hi = end - 1;
      while (lo < hi) {
        const swap = cellCornersRaw[lo] as number;
        cellCornersRaw[lo] = cellCornersRaw[hi] as number;
        cellCornersRaw[hi] = swap;
        lo++; hi--;
      }
      area = -area;
    }
    areasRaw[c] = area;
  }

  const grid = reorderCells({
    v: v,
    cellCount: cellCount,
    triangleCount: triangleCount,
    centers: centersRaw,
    corners: corners,
    triangles: trianglesRaw,
    cellCornerStart: cellCornerStartRaw,
    cellCorners: cellCornersRaw,
    neighbors: neighborsRaw,
    neighborCount: neighborCountRaw,
    areas: areasRaw,
    pentagons: pentagons,
    addrFace: addrFaceRaw,
    addrI: addrIRaw,
    addrJ: addrJRaw,
  });
  grid.gridVersion = GRID_VERSION;
  grid.addressSchema = ADDRESS_SCHEMA;
  grid.topologySchema = TOPOLOGY_SCHEMA;
  grid.chunkSchema = CHUNK_SCHEMA;
  grid.chunkBlockSteps = CHUNK_BLOCK_STEPS;
  grid.bodyIndex = 0;
  attachChunks(grid, lastReorderedBaseDescs);
  lastReorderedBaseDescs = null;
  return grid;
}

interface BaseChunkDesc {
  tempId: number;
  faceIndex: number;
  blockI: number;
  blockJ: number;
  startCell: number;
  cellCount: number;
}

let lastReorderedBaseDescs: BaseChunkDesc[] | null = null;

function reorderCells(raw: RawGrid): PlanetGrid {
  const count = raw.cellCount;
  const maxBlock = Math.floor(raw.v / CHUNK_BLOCK_STEPS) + 1;
  const keySpace = 20 * maxBlock * maxBlock;
  const keyCounts = new Uint32Array(keySpace);
  const oldKey = oldKeyBuf.length >= count ? oldKeyBuf.subarray(0, count) : new Uint32Array(count);
  const rawAddrFace = raw.addrFace;
  const addrIRaw = raw.addrI;
  const addrJRaw = raw.addrJ;
  let c: number;
  for (c = 0; c < count; c++) {
    const face = rawAddrFace[c] as number;
    const qa = (addrIRaw[c] as number) >> 5;
    const qb = (addrJRaw[c] as number) >> 5;
    const key = (face * maxBlock + qa) * maxBlock + qb;
    oldKey[c] = key;
    keyCounts[key] = (keyCounts[key] as number) + 1;
  }

  // Ключ (face * maxBlock + qa) * maxBlock + qb уже монотонен по (faceIndex, blockI, blockJ).
  const keyWrite = new Uint32Array(keySpace);
  const baseDescs: BaseChunkDesc[] = [];
  let runningOffset = 0;
  const maxBlockSq = maxBlock * maxBlock;
  for (let key = 0; key < keySpace; key++) {
    const cnt = keyCounts[key] as number;
    if (cnt === 0) continue;
    keyWrite[key] = runningOffset;
    const face = Math.floor(key / maxBlockSq);
    const rem = key - face * maxBlockSq;
    const qa = Math.floor(rem / maxBlock);
    const qb = rem - qa * maxBlock;
    baseDescs.push({
      tempId: baseDescs.length,
      faceIndex: face,
      blockI: qa,
      blockJ: qb,
      startCell: runningOffset,
      cellCount: cnt,
    });
    runningOffset += cnt;
  }
  lastReorderedBaseDescs = baseDescs;

  const order = orderBuf.length >= count ? orderBuf.subarray(0, count) : new Uint32Array(count);
  const sortKeys = sortKeyBuf.length >= count ? sortKeyBuf.subarray(0, count) : new Uint32Array(count);
  for (c = 0; c < count; c++) {
    const key = oldKey[c] as number;
    const pos = keyWrite[key] as number;
    keyWrite[key] = pos + 1;
    order[pos] = c;
    sortKeys[pos] = (((addrIRaw[c] as number) << 16) | (addrJRaw[c] as number)) >>> 0;
  }
  const groupCount = baseDescs.length;
  for (let gi = 0; gi < groupCount; gi++) {
    const desc = baseDescs[gi] as BaseChunkDesc;
    const start = desc.startCell;
    const end = start + desc.cellCount;
    for (let i = start + 1; i < end; i++) {
      const curr = order[i] as number;
      const currKey = sortKeys[i] as number;
      let j = i - 1;
      while (j >= start && (sortKeys[j] as number) > currKey) {
        order[j + 1] = order[j] as number;
        sortKeys[j + 1] = sortKeys[j] as number;
        j--;
      }
      order[j + 1] = curr;
      sortKeys[j + 1] = currKey;
    }
  }
  const newId = newIdBuf.length >= count ? newIdBuf.subarray(0, count) : new Uint32Array(count);
  for (let pos = 0; pos < count; pos++) newId[order[pos] as number] = pos;

  const rawCenters = raw.centers;
  const rawAreas = raw.areas;
  const rawNeighbors = raw.neighbors;
  const rawNeighborCount = raw.neighborCount;
  const rawCellCornerStart = raw.cellCornerStart;
  const rawCellCorners = raw.cellCorners;
  const rawTriangles = raw.triangles;

  const centers = new Float32Array(rawCenters.length);
  const areas = new Float32Array(rawAreas.length);
  const neighbors = new Int32Array(rawNeighbors.length);
  const neighborCount = new Uint8Array(rawNeighborCount.length);
  const addrFace = new Uint8Array(rawAddrFace.length);
  const addrI = new Uint16Array(addrIRaw.length);
  const addrJ = new Uint16Array(addrJRaw.length);
  const cellChunk = new Uint32Array(count);
  const cellCornerStart = new Uint32Array(count + 1);
  const cellCorners = new Uint32Array(rawCellCorners.length);

  let cornerOffset = 0;
  for (let pos = 0; pos < count; pos++) {
    const old = order[pos] as number;
    const pos3 = pos * 3;
    const old3 = old * 3;
    centers[pos3] = rawCenters[old3] as number;
    centers[pos3 + 1] = rawCenters[old3 + 1] as number;
    centers[pos3 + 2] = rawCenters[old3 + 2] as number;
    areas[pos] = rawAreas[old] as number;
    const nc = rawNeighborCount[old] as number;
    neighborCount[pos] = nc;
    addrFace[pos] = rawAddrFace[old] as number;
    addrI[pos] = addrIRaw[old] as number;
    addrJ[pos] = addrJRaw[old] as number;
    const basePos = pos * 6;
    const baseOld = old * 6;
    for (let n = 0; n < nc; n++) {
      neighbors[basePos + n] = newId[rawNeighbors[baseOld + n] as number] as number;
    }
    if (nc < 6) neighbors[basePos + 5] = -1;
    insertionSortSegment(neighbors, basePos, basePos + nc);
    cellCornerStart[pos] = cornerOffset;
    const rawStart = rawCellCornerStart[old] as number;
    const rawEnd = rawCellCornerStart[old + 1] as number;
    for (let k = rawStart; k < rawEnd; k++) cellCorners[cornerOffset++] = rawCellCorners[k] as number;
  }
  cellCornerStart[count] = cornerOffset;

  const triLen = rawTriangles.length;
  const triangles = new Uint32Array(triLen);
  for (let ti = 0; ti < triLen; ti++) triangles[ti] = newId[rawTriangles[ti] as number] as number;

  return {
    v: raw.v,
    bodyIndex: 0,
    cellCount: count,
    triangleCount: raw.triangleCount,
    centers: centers,
    corners: raw.corners,
    triangles: triangles,
    cellCornerStart: cellCornerStart,
    cellCorners: cellCorners,
    neighbors: neighbors,
    neighborCount: neighborCount,
    areas: areas,
    pentagons: raw.pentagons,
    addrFace: addrFace,
    addrI: addrI,
    addrJ: addrJ,
    cellChunk: cellChunk,
  };
}

function attachChunks(grid: PlanetGrid, precomputedBase?: BaseChunkDesc[] | null): PlanetGrid {
  if (!grid || !grid.addrFace || !grid.addrI || !grid.addrJ) {
    throw new Error('GeodesicGrid.attachChunks: нет адресных массивов');
  }
  interface EffDesc {
    id: number; faceIndex: number; blockI: number; blockJ: number;
    blockCount: number; startCell: number; cellCount: number;
  }
  let baseDescriptors: BaseChunkDesc[];
  let c: number;
  if (precomputedBase) {
    baseDescriptors = precomputedBase;
  } else {
    const maxBlock = Math.floor(grid.v / CHUNK_BLOCK_STEPS) + 1;
    baseDescriptors = [];
    const keyToDescIdx = new Int32Array(20 * maxBlock * maxBlock).fill(-1);
    let lastKey = -1;
    let currentDesc: BaseChunkDesc | null = null;
    for (c = 0; c < grid.cellCount; c++) {
      const face = grid.addrFace[c] as number;
      const qa = chunkBlockIndex(grid.addrI[c] as number);
      const qb = chunkBlockIndex(grid.addrJ[c] as number);
      const key = (face * maxBlock + qa) * maxBlock + qb;
      if (key !== lastKey || !currentDesc) {
        let idx = keyToDescIdx[key] as number;
        if (idx < 0) {
          idx = baseDescriptors.length;
          keyToDescIdx[key] = idx;
          currentDesc = {
            tempId: idx,
            faceIndex: face,
            blockI: qa,
            blockJ: qb,
            startCell: c,
            cellCount: 0,
          };
          baseDescriptors.push(currentDesc);
        } else {
          currentDesc = baseDescriptors[idx] as BaseChunkDesc;
        }
        lastKey = key;
      }
      if (currentDesc.startCell + currentDesc.cellCount !== c) {
        throw new Error('GeodesicGrid: ячейки chunk не образуют непрерывный диапазон');
      }
      currentDesc.cellCount++;
    }
    baseDescriptors.sort(function (p, q) {
      return p.faceIndex - q.faceIndex || p.blockI - q.blockI || p.blockJ - q.blockJ;
    });
  }

  const descriptors: EffDesc[] = [];
  for (let bi = 0; bi < baseDescriptors.length; bi++) {
    const base = baseDescriptors[bi] as BaseChunkDesc;
    const prev = descriptors[descriptors.length - 1];
    const shouldMerge = !!prev && prev.faceIndex === base.faceIndex &&
      (base.cellCount < CHUNK_MIN_CELLS || prev.cellCount < CHUNK_MIN_CELLS) &&
      prev.cellCount + base.cellCount <= CHUNK_MAX_CELLS;
    if (shouldMerge && prev) {
      prev.cellCount += base.cellCount;
      prev.blockCount++;
      continue;
    }
    descriptors.push({
      id: descriptors.length,
      faceIndex: base.faceIndex,
      blockI: base.blockI,
      blockJ: base.blockJ,
      blockCount: 1,
      startCell: base.startCell,
      cellCount: base.cellCount,
    });
  }
  const cellChunk = grid.cellChunk && grid.cellChunk.length === grid.cellCount
    ? grid.cellChunk
    : new Uint32Array(grid.cellCount);
  for (let di = 0; di < descriptors.length; di++) {
    const desc = descriptors[di] as EffDesc;
    cellChunk.fill(desc.id, desc.startCell, desc.startCell + desc.cellCount);
  }

  const chunkCount = descriptors.length;
  const chunkCellStart = new Uint32Array(chunkCount + 1);
  const chunkFace = new Uint16Array(chunkCount);
  const chunkCenters = new Float32Array(chunkCount * 3);
  const chunkRadius = new Float32Array(chunkCount);
  const chunkCos = new Float32Array(chunkCount);
  const chunkSin = new Float32Array(chunkCount);
  const chunks = new Array<GridChunk>(chunkCount);
  const centers = grid.centers;
  const cellCornerStart = grid.cellCornerStart;
  const cellCorners = grid.cellCorners;
  const corners = grid.corners;

  for (let di = 0; di < chunkCount; di++) {
    const desc = descriptors[di] as EffDesc;
    chunkCellStart[desc.id] = desc.startCell;
    chunkFace[desc.id] = desc.faceIndex;
    let mx = 0, my = 0, mz = 0;
    const endCell = desc.startCell + desc.cellCount;
    for (c = desc.startCell; c < endCell; c++) {
      const c3 = c * 3;
      mx += centers[c3] as number;
      my += centers[c3 + 1] as number;
      mz += centers[c3 + 2] as number;
    }
    const center = normalize3(mx, my, mz, [0, 0, 0]);
    const cx0 = center[0] as number, cy0 = center[1] as number, cz0 = center[2] as number;
    let minDot = Infinity;
    for (c = desc.startCell; c < endCell; c++) {
      const c3 = c * 3;
      const d0 = (centers[c3] as number) * cx0 + (centers[c3 + 1] as number) * cy0 + (centers[c3 + 2] as number) * cz0;
      if (d0 < minDot) minDot = d0;
      const kEnd = cellCornerStart[c + 1] as number;
      for (let k = cellCornerStart[c] as number; k < kEnd; k++) {
        const corner = (cellCorners[k] as number) * 3;
        const dk = (corners[corner] as number) * cx0 + (corners[corner + 1] as number) * cy0 + (corners[corner + 2] as number) * cz0;
        if (dk < minDot) minDot = dk;
      }
    }
    const cos = clamp(minDot, -1, 1);
    const angularRadius = Math.acos(cos);
    const radius = Math.sqrt(Math.max(0, 2 - 2 * cos));
    chunkCenters[desc.id * 3] = cx0;
    chunkCenters[desc.id * 3 + 1] = cy0;
    chunkCenters[desc.id * 3 + 2] = cz0;
    chunkRadius[desc.id] = radius;
    chunkCos[desc.id] = cos;
    chunkSin[desc.id] = Math.sin(angularRadius);
    chunks[desc.id] = {
      id: desc.id,
      faceIndex: desc.faceIndex,
      blockI: desc.blockI,
      blockJ: desc.blockJ,
      blockCount: desc.blockCount,
      startCell: desc.startCell,
      cellCount: desc.cellCount,
      boundingSphere: {
        center: center,
        radius: radius,
        cosAngularRadius: cos,
        angularRadius: angularRadius,
      },
    };
  }
  chunkCellStart[chunkCount] = grid.cellCount;

  const sortedNeighbors = new Array<number[]>(chunkCount);
  const seenChunk = new Int32Array(chunkCount).fill(-1);
  const neighbors = grid.neighbors;
  const neighborCount = grid.neighborCount;
  let ci: number;
  let totalNeighbors = 0;
  const chunkNeighborStart = new Uint32Array(chunkCount + 1);
  for (ci = 0; ci < chunkCount; ci++) {
    const desc = descriptors[ci] as EffDesc;
    const ownList: number[] = [];
    seenChunk[ci] = ci;
    const endCell = desc.startCell + desc.cellCount;
    for (c = desc.startCell; c < endCell; c++) {
      const nc = neighborCount[c] as number;
      const base = c * 6;
      for (let n = 0; n < nc; n++) {
        const other = cellChunk[neighbors[base + n] as number] as number;
        if (seenChunk[other] !== ci) {
          seenChunk[other] = ci;
          ownList.push(other);
        }
      }
    }
    ownList.sort(function (p, q) { return p - q; });
    sortedNeighbors[ci] = ownList;
    chunkNeighborStart[ci] = totalNeighbors;
    totalNeighbors += ownList.length;
  }
  chunkNeighborStart[chunkCount] = totalNeighbors;
  const chunkNeighbors = new Uint32Array(totalNeighbors);
  for (ci = 0; ci < chunkCount; ci++) {
    for (let ni = 0; ni < (sortedNeighbors[ci] as number[]).length; ni++) {
      chunkNeighbors[(chunkNeighborStart[ci] as number) + ni] = (sortedNeighbors[ci] as number[])[ni] as number;
    }
  }

  grid.cellChunk = cellChunk;
  grid.chunkCount = chunkCount;
  grid.chunkCellStart = chunkCellStart;
  grid.chunkFace = chunkFace;
  grid.chunkCenters = chunkCenters;
  grid.chunkRadius = chunkRadius;
  grid.chunkCosAngularRadius = chunkCos;
  grid.chunkSinAngularRadius = chunkSin;
  grid.chunkNeighborStart = chunkNeighborStart;
  grid.chunkNeighbors = chunkNeighbors;
  grid.chunks = chunks;
  return grid;
}

function ensureChunks(grid: PlanetGrid): GridChunk[] {
  if (!grid.chunks || !grid.cellChunk || !grid.chunkCenters) attachChunks(grid);
  return grid.chunks as GridChunk[];
}

function getChunks(grid: PlanetGrid): GridChunk[] {
  return ensureChunks(grid);
}

function getChunkNeighbors(grid: PlanetGrid, chunkId: number): number[] {
  ensureChunks(grid);
  if (!Number.isInteger(chunkId) || chunkId < 0 || chunkId >= (grid.chunkCount as number)) return [];
  return Array.from((grid.chunkNeighbors as Uint32Array).subarray(
    (grid.chunkNeighborStart as Uint32Array)[chunkId] as number,
    (grid.chunkNeighborStart as Uint32Array)[chunkId + 1] as number,
  ));
}

function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }

function addressOf(grid: PlanetGrid, cell: number): string {
  if (!Number.isInteger(cell) || cell < 0 || cell >= grid.cellCount) {
    throw new Error('GeodesicGrid.addressOf: ячейка вне диапазона');
  }
  const w = typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0;
  const schema = grid.addressSchema || GRID_VERSION;
  return schema + '/w' + w + '/v' + grid.v + '/f' + pad2(grid.addrFace[cell] as number) +
    '/a' + (grid.addrI[cell] as number) + '/b' + (grid.addrJ[cell] as number);
}

const ADDRESS_RE = /^goldberg-gp-v1\/w(\d+)\/v(\d+)\/f(\d{2})\/a(\d+)\/b(\d+)$/;

function parseAddress(address: string): ParsedAddress | null {
  if (typeof address !== 'string') return null;
  const m = ADDRESS_RE.exec(address);
  if (!m) return null;
  const parsed: ParsedAddress = {
    gridVersion: GRID_VERSION,
    addressSchema: ADDRESS_SCHEMA,
    bodyIndex: Number(m[1]),
    v: Number(m[2]),
    face: Number(m[3]),
    faceIndex: Number(m[3]),
    i: Number(m[4]),
    j: Number(m[5]),
  };
  if (!Number.isSafeInteger(parsed.bodyIndex) || parsed.bodyIndex < 0 ||
      !Number.isInteger(parsed.v) || parsed.v < 1 || parsed.face < 0 || parsed.face > 19 ||
      parsed.i < 0 || parsed.j < 0 || parsed.i + parsed.j > parsed.v) {
    return null;
  }
  return parsed;
}

function addressOrderParts(grid: PlanetGrid, cell: number): number[] {
  return [
    grid.addrFace[cell] as number,
    chunkBlockIndex(grid.addrI[cell] as number),
    chunkBlockIndex(grid.addrJ[cell] as number),
    grid.addrI[cell] as number,
    grid.addrJ[cell] as number,
  ];
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
}

function cellAtAddress(grid: PlanetGrid, address: string | ParsedAddress): number {
  const parts = typeof address === 'string' ? parseAddress(address) : address;
  if (!parts || !grid || !grid.addrFace) return -1;
  const body = typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0;
  if (parts.bodyIndex !== body || parts.v !== grid.v) return -1;
  const face = parts.faceIndex != null ? parts.faceIndex : parts.face;
  if (!Number.isInteger(face) || face < 0 || face > 19 ||
      !Number.isInteger(parts.i) || !Number.isInteger(parts.j) ||
      parts.i < 0 || parts.j < 0 || parts.i + parts.j > grid.v) return -1;
  const target = [face, chunkBlockIndex(parts.i), chunkBlockIndex(parts.j), parts.i, parts.j];
  let lo = 0, hi = grid.cellCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareParts(addressOrderParts(grid, mid), target);
    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function pickBruteForce(grid: PlanetGrid, dir: readonly number[]): number {
  const centers = grid.centers;
  let best = -1, bestDot = -Infinity;
  for (let c = 0; c < grid.cellCount; c++) {
    const dot = (centers[c * 3] as number) * (dir[0] as number) +
      (centers[c * 3 + 1] as number) * (dir[1] as number) +
      (centers[c * 3 + 2] as number) * (dir[2] as number);
    if (dot > bestDot) { bestDot = dot; best = c; }
  }
  return best;
}

function pick(grid: PlanetGrid, dir: readonly number[]): number {
  const len = Math.sqrt((dir[0] as number) * (dir[0] as number) + (dir[1] as number) * (dir[1] as number) + (dir[2] as number) * (dir[2] as number));
  if (!Number.isFinite(len) || len === 0) return 0;
  const x = (dir[0] as number) / len, y = (dir[1] as number) / len, z = (dir[2] as number) / len;
  let chunks: GridChunk[];
  try {
    chunks = ensureChunks(grid);
  } catch {
    return pickBruteForce(grid, [x, y, z]);
  }
  if (!chunks.length || !grid.chunkCenters || !grid.chunkCosAngularRadius) {
    return pickBruteForce(grid, [x, y, z]);
  }
  const chunkCenters = grid.chunkCenters;
  const chunkCos = grid.chunkCosAngularRadius;
  const chunkSin = grid.chunkSinAngularRadius as Float32Array;
  const dots = new Float64Array(chunks.length);
  let nearestChunk = 0;
  let nearestDot = -Infinity;
  let ci: number;
  for (ci = 0; ci < chunks.length; ci++) {
    const dot = (chunkCenters[ci * 3] as number) * x +
      (chunkCenters[ci * 3 + 1] as number) * y +
      (chunkCenters[ci * 3 + 2] as number) * z;
    dots[ci] = dot;
    if (dot > nearestDot) { nearestDot = dot; nearestChunk = ci; }
  }
  let best = -1;
  let bestDot = -Infinity;
  function scanChunk(chunkId: number): void {
    const chunk = chunks[chunkId] as GridChunk;
    const start = chunk.startCell;
    const end = start + chunk.cellCount;
    for (let c = start; c < end; c++) {
      const cellDot = (grid.centers[c * 3] as number) * x +
        (grid.centers[c * 3 + 1] as number) * y +
        (grid.centers[c * 3 + 2] as number) * z;
      if (cellDot > bestDot || (cellDot === bestDot && (best < 0 || c < best))) {
        bestDot = cellDot;
        best = c;
      }
    }
  }
  scanChunk(nearestChunk);
  // Точный отсев по сферическому неравенству треугольника: chunk может
  // побить текущий best только если угловое расстояние до его центра не
  // больше суммы радиуса chunk и углового расстояния до лучшей ячейки.
  for (ci = 0; ci < chunks.length; ci++) {
    if (ci === nearestChunk) continue;
    const sinBest = Math.sqrt(Math.max(0, 1 - bestDot * bestDot));
    const minCenterDot = bestDot * (chunkCos[ci] as number) - sinBest * (chunkSin[ci] as number);
    if ((dots[ci] as number) >= minCenterDot - 1e-12) scanChunk(ci);
  }
  return best;
}

function validateChunks(grid: PlanetGrid): ChunkValidation {
  const checks: Record<string, boolean> = {};
  let chunks: GridChunk[];
  try {
    chunks = ensureChunks(grid);
    checks.present = true;
  } catch (err) {
    return { ok: false, checks: { present: false }, error: String((err as { message?: string })?.message || err) };
  }
  let partition = chunks.length > 0 && (chunks[0] as GridChunk).startCell === 0;
  let faceOk = true;
  let boundsOk = true;
  const seen = new Uint8Array(grid.cellCount);
  let total = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci] as GridChunk;
    if (chunk.id !== ci || chunk.startCell !== total || chunk.cellCount <= 0) partition = false;
    total += chunk.cellCount;
    const center = chunk.boundingSphere.center;
    const cos = chunk.boundingSphere.cosAngularRadius;
    const centerLen = Math.sqrt((center[0] as number) * (center[0] as number) + (center[1] as number) * (center[1] as number) + (center[2] as number) * (center[2] as number));
    if (!Number.isFinite(centerLen) || Math.abs(centerLen - 1) > 1e-5 || !(cos >= -1 && cos <= 1)) boundsOk = false;
    for (let c = chunk.startCell; c < chunk.startCell + chunk.cellCount; c++) {
      if (seen[c] || (grid.cellChunk[c] as number) !== ci) partition = false;
      seen[c] = 1;
      if ((grid.addrFace[c] as number) !== chunk.faceIndex) faceOk = false;
      const dotCenter = (grid.centers[c * 3] as number) * (center[0] as number) +
        (grid.centers[c * 3 + 1] as number) * (center[1] as number) +
        (grid.centers[c * 3 + 2] as number) * (center[2] as number);
      if (dotCenter < cos - 1e-6) boundsOk = false;
      for (let k = grid.cellCornerStart[c] as number; k < (grid.cellCornerStart[c + 1] as number); k++) {
        const corner = (grid.cellCorners[k] as number) * 3;
        const dotCorner = (grid.corners[corner] as number) * (center[0] as number) +
          (grid.corners[corner + 1] as number) * (center[1] as number) +
          (grid.corners[corner + 2] as number) * (center[2] as number);
        if (dotCorner < cos - 1e-6) boundsOk = false;
      }
    }
  }
  checks.partition = partition && total === grid.cellCount;
  checks.faceContained = faceOk;
  checks.boundingSpheres = boundsOk;

  let neighborOk = true;
  const neighborSets = chunks.map(function (_, id) { return new Set(getChunkNeighbors(grid, id)); });
  for (let ci = 0; ci < chunks.length; ci++) {
    const list = getChunkNeighbors(grid, ci);
    if (list.length !== (neighborSets[ci] as Set<number>).size || list.indexOf(ci) >= 0) neighborOk = false;
    for (let ni = 0; ni < list.length; ni++) {
      if (!neighborSets[list[ni] as number] || !(neighborSets[list[ni] as number] as Set<number>).has(ci)) neighborOk = false;
    }
  }
  checks.neighborsSymmetric = neighborOk;
  let maxCells = 0;
  let maxAngular = 0;
  chunks.forEach(function (chunk) {
    maxCells = Math.max(maxCells, chunk.cellCount);
    maxAngular = Math.max(maxAngular, chunk.boundingSphere.angularRadius);
  });
  return {
    ok: Object.keys(checks).every(function (k) { return checks[k] as boolean; }),
    checks: checks,
    chunkCount: chunks.length,
    averageCells: chunks.length ? grid.cellCount / chunks.length : 0,
    maxCells: maxCells,
    maxAngularRadius: maxAngular,
  };
}

function validate(grid: PlanetGrid): GridValidation {
  const checks: Record<string, boolean> = {};
  if (!grid || !Number.isInteger(grid.v) || grid.v < 1) {
    return { ok: false, checks: { shape: false }, areaSum: 0 };
  }
  const v = grid.v;
  const expectedCells = cellCountForFrequency(v);
  const expectedTriangles = triangleCountForFrequency(v);
  checks.cellCount = grid.cellCount === expectedCells;
  checks.triangleCount = grid.triangleCount === expectedTriangles;
  checks.pentagons = grid.pentagons === 12;
  checks.arrayLengths = !!(
    grid.centers && grid.centers.length === expectedCells * 3 &&
    grid.corners && grid.corners.length === expectedTriangles * 3 &&
    grid.triangles && grid.triangles.length === expectedTriangles * 3 &&
    grid.cellCornerStart && grid.cellCornerStart.length === expectedCells + 1 &&
    grid.cellCorners && grid.cellCorners.length === 60 * v * v &&
    grid.neighbors && grid.neighbors.length === expectedCells * 6 &&
    grid.neighborCount && grid.neighborCount.length === expectedCells &&
    grid.areas && grid.areas.length === expectedCells &&
    grid.addrFace && grid.addrFace.length === expectedCells &&
    grid.addrI && grid.addrI.length === expectedCells &&
    grid.addrJ && grid.addrJ.length === expectedCells
  );
  if (!checks.arrayLengths || !checks.cellCount || !checks.triangleCount) {
    checks.finite = false;
    checks.areaSum = false;
    checks.neighborsSymmetric = false;
    checks.noDuplicateCenters = false;
    checks.addresses = false;
    checks.chunks = false;
    return { ok: false, checks: checks, areaSum: 0 };
  }

  let areaSum = 0;
  let finite = true;
  let indicesOk = true;
  let c: number, k: number;
  for (c = 0; c < grid.cellCount; c++) {
    areaSum += grid.areas[c] as number;
    const nx = grid.centers[c * 3] as number, ny = grid.centers[c * 3 + 1] as number, nz = grid.centers[c * 3 + 2] as number;
    const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!((grid.areas[c] as number) > 0) || !Number.isFinite(grid.areas[c] as number) ||
        !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz) ||
        Math.abs(nlen - 1) > 1e-4) finite = false;
    if (grid.neighborCount[c] !== 5 && grid.neighborCount[c] !== 6) finite = false;
    if ((grid.cellCornerStart[c + 1] as number) - (grid.cellCornerStart[c] as number) !== grid.neighborCount[c]) indicesOk = false;
    for (k = 0; k < (grid.neighborCount[c] as number); k++) {
      const nb = grid.neighbors[c * 6 + k] as number;
      if (nb < 0 || nb >= grid.cellCount || nb === c) indicesOk = false;
    }
    for (k = grid.cellCornerStart[c] as number; k < (grid.cellCornerStart[c + 1] as number); k++) {
      if ((grid.cellCorners[k] as number) < 0 || (grid.cellCorners[k] as number) >= grid.triangleCount) indicesOk = false;
    }
  }
  for (let t = 0; t < grid.triangleCount; t++) {
    const a = grid.triangles[t * 3] as number, b = grid.triangles[t * 3 + 1] as number, d = grid.triangles[t * 3 + 2] as number;
    if (a < 0 || b < 0 || d < 0 || a >= grid.cellCount || b >= grid.cellCount || d >= grid.cellCount ||
        a === b || b === d || a === d) indicesOk = false;
    const cx = grid.corners[t * 3] as number, cy = grid.corners[t * 3 + 1] as number, cz = grid.corners[t * 3 + 2] as number;
    const clen = Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || Math.abs(clen - 1) > 1e-4) finite = false;
  }
  checks.areaSum = Math.abs(areaSum - 4 * Math.PI) < 1e-3;
  checks.finite = finite;
  checks.indices = indicesOk;

  let symmetric = true;
  outer:
  for (c = 0; c < grid.cellCount; c++) {
    for (let n = 0; n < (grid.neighborCount[c] as number); n++) {
      const neighbor = grid.neighbors[c * 6 + n] as number;
      let back = false;
      for (let m = 0; m < (grid.neighborCount[neighbor] as number); m++) {
        if (grid.neighbors[neighbor * 6 + m] === c) { back = true; break; }
      }
      if (!back) { symmetric = false; break outer; }
    }
  }
  checks.neighborsSymmetric = symmetric;

  const addressSet = new Set<string>();
  const centerSet = new Set<string>();
  let addressesOk = true;
  let prevFace = -1, prevBlockI = -1, prevBlockJ = -1, prevI = -1, prevJ = -1;
  for (c = 0; c < grid.cellCount; c++) {
    const face = grid.addrFace[c] as number;
    const ai = grid.addrI[c] as number;
    const aj = grid.addrJ[c] as number;
    const blockI = chunkBlockIndex(ai);
    const blockJ = chunkBlockIndex(aj);
    if (face > 19 || ai + aj > v) addressesOk = false;
    if (c > 0) {
      const cmp = face - prevFace || blockI - prevBlockI || blockJ - prevBlockJ || ai - prevI || aj - prevJ;
      if (cmp <= 0) addressesOk = false;
    }
    prevFace = face; prevBlockI = blockI; prevBlockJ = blockJ; prevI = ai; prevJ = aj;
    addressSet.add(face + ',' + ai + ',' + aj);
    centerSet.add(Math.round((grid.centers[c * 3] as number) * 1e7) + ',' +
      Math.round((grid.centers[c * 3 + 1] as number) * 1e7) + ',' +
      Math.round((grid.centers[c * 3 + 2] as number) * 1e7));
  }
  checks.addresses = addressesOk && addressSet.size === grid.cellCount;
  checks.noDuplicateCenters = centerSet.size === grid.cellCount;
  const chunkValidation = validateChunks(grid);
  checks.chunks = chunkValidation.ok;
  const ok = Object.keys(checks).every(function (key) { return checks[key] as boolean; });
  return { ok: ok, checks: checks, areaSum: areaSum, chunks: chunkValidation };
}

/* ---------------- binary cache v1 ---------------- */

function utf8Bytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  const encoded = unescape(encodeURIComponent(text));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
  return out;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  const w = new Int32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    let i: number;
    for (i = 0; i < 16; i++) w[i] = view.getInt32(block + i * 4, false);
    for (i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3);
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ ((w[i - 2] as number) >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number, b = h[1] as number, c = h[2] as number, d = h[3] as number;
    let e = h[4] as number, f = h[5] as number, g = h[6] as number, hh = h[7] as number;
    for (i = 0; i < 64; i++) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + sum1 + ch + (SHA256_K[i] as number) + (w[i] as number)) | 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0; h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0; h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0; h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0; h[7] = ((h[7] as number) + hh) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let j = 0; j < 8; j++) outView.setUint32(j * 4, (h[j] as number) >>> 0, false);
  return out;
}

let crc32cTables: Uint32Array[] | null = null;

function crc32c(bytes: Uint8Array): number {
  if (!crc32cTables) {
    const base = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let crc = n;
      for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0x82f63b78 ^ (crc >>> 1)) : (crc >>> 1);
      base[n] = crc >>> 0;
    }
    crc32cTables = [base];
    for (let tableIndex = 1; tableIndex < 4; tableIndex++) {
      const prev = crc32cTables[tableIndex - 1] as Uint32Array;
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) table[n] = ((prev[n] as number) >>> 8) ^ (base[(prev[n] as number) & 0xff] as number);
      crc32cTables.push(table);
    }
  }
  const t0 = crc32cTables[0] as Uint32Array, t1 = crc32cTables[1] as Uint32Array;
  const t2 = crc32cTables[2] as Uint32Array, t3 = crc32cTables[3] as Uint32Array;
  let result = 0xffffffff;
  let i = 0;
  const limit = bytes.length - 3;
  for (; i < limit; i += 4) {
    result = (t3[(result ^ (bytes[i] as number)) & 0xff] as number) ^
      (t2[((result >>> 8) ^ (bytes[i + 1] as number)) & 0xff] as number) ^
      (t1[((result >>> 16) ^ (bytes[i + 2] as number)) & 0xff] as number) ^
      (t0[((result >>> 24) ^ (bytes[i + 3] as number)) & 0xff] as number);
  }
  for (; i < bytes.length; i++) {
    result = (t0[(result ^ (bytes[i] as number)) & 0xff] as number) ^ (result >>> 8);
  }
  return (result ^ 0xffffffff) >>> 0;
}

type CacheMetaInput = number | Partial<GridCacheMeta> | PlanetGrid | null | undefined;

function normalizeCacheMeta(meta: CacheMetaInput): GridCacheMeta {
  let source: Partial<GridCacheMeta> = {};
  if (typeof meta === 'number') source = { v: meta };
  else if (meta) source = meta as Partial<GridCacheMeta>;
  const out: GridCacheMeta = {
    addressSchema: String(source.addressSchema || ADDRESS_SCHEMA),
    gridVersion: String(source.gridVersion || GRID_VERSION),
    topologySchema: String(source.topologySchema || TOPOLOGY_SCHEMA),
  };
  if (source.v !== undefined) out.v = source.v;
  return out;
}

function gridCacheMeta(input: CacheMetaInput): GridCacheMeta {
  if (typeof input === 'number') return normalizeCacheMeta({ v: input });
  if (input && (input as PlanetGrid).centers && Number.isInteger((input as PlanetGrid).v)) {
    const grid = input as PlanetGrid;
    return normalizeCacheMeta({
      addressSchema: grid.addressSchema || ADDRESS_SCHEMA,
      gridVersion: grid.gridVersion || GRID_VERSION,
      topologySchema: grid.topologySchema || TOPOLOGY_SCHEMA,
      v: grid.v,
    });
  }
  return normalizeCacheMeta(input || {});
}

function gridCacheParamsHash(meta: CacheMetaInput): number {
  const canonical = normalizeCacheMeta(meta);
  if (!Number.isInteger(canonical.v) || (canonical.v as number) < 1) {
    throw new Error('GeodesicGrid grid cache: meta.v должно быть целым >= 1');
  }
  const digest = sha256Bytes(utf8Bytes(JSON.stringify(canonical)));
  return ((((digest[0] as number) << 24) | ((digest[1] as number) << 16) | ((digest[2] as number) << 8) | (digest[3] as number)) >>> 0);
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

type SectionKind = 'f32' | 'u32' | 'i32' | 'u16' | 'u8';
type SectionArray = Float32Array | Uint32Array | Int32Array | Uint16Array | Uint8Array;

interface CacheSection {
  name: string;
  array: SectionArray;
  kind: SectionKind;
}

function cacheSections(grid: PlanetGrid): CacheSection[] {
  return [
    { name: 'centers', array: grid.centers, kind: 'f32' },
    { name: 'corners', array: grid.corners, kind: 'f32' },
    { name: 'triangles', array: grid.triangles, kind: 'u32' },
    { name: 'cellCornerStart', array: grid.cellCornerStart, kind: 'u32' },
    { name: 'cellCorners', array: grid.cellCorners, kind: 'u32' },
    { name: 'neighbors', array: grid.neighbors, kind: 'i32' },
    { name: 'neighborCount', array: grid.neighborCount, kind: 'u8' },
    { name: 'areas', array: grid.areas, kind: 'f32' },
    { name: 'addrFace', array: grid.addrFace, kind: 'u8' },
    { name: 'addrI', array: grid.addrI, kind: 'u16' },
    { name: 'addrJ', array: grid.addrJ, kind: 'u16' },
  ];
}

function sectionElementSize(kind: SectionKind): number {
  if (kind === 'u8') return 1;
  if (kind === 'u16') return 2;
  return 4;
}

const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function sectionHasCanonicalType(arr: SectionArray, kind: SectionKind): boolean {
  return (kind === 'f32' && arr instanceof Float32Array) ||
    (kind === 'u32' && arr instanceof Uint32Array) ||
    (kind === 'i32' && arr instanceof Int32Array) ||
    (kind === 'u16' && arr instanceof Uint16Array) ||
    (kind === 'u8' && arr instanceof Uint8Array);
}

function writeSection(view: DataView, bytes: Uint8Array, offset: number, section: CacheSection): number {
  const arr = section.array;
  const byteLength = arr.length * sectionElementSize(section.kind);
  if (HOST_LITTLE_ENDIAN && sectionHasCanonicalType(arr, section.kind) && arr.byteLength === byteLength) {
    bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), offset);
    return align4(byteLength);
  }
  for (let i = 0; i < arr.length; i++) {
    if (section.kind === 'f32') view.setFloat32(offset + i * 4, arr[i] as number, true);
    else if (section.kind === 'u32') view.setUint32(offset + i * 4, arr[i] as number, true);
    else if (section.kind === 'i32') view.setInt32(offset + i * 4, arr[i] as number, true);
    else if (section.kind === 'u16') view.setUint16(offset + i * 2, arr[i] as number, true);
    else view.setUint8(offset + i, arr[i] as number);
  }
  return align4(arr.length * sectionElementSize(section.kind));
}

function serializeGridCache(grid: PlanetGrid, meta?: CacheMetaInput): ArrayBuffer {
  if (!grid || !Number.isInteger(grid.v)) throw new Error('GeodesicGrid.serializeGridCache: нет сетки');
  ensureChunks(grid);
  const canonical = normalizeCacheMeta(meta === undefined ? gridCacheMeta(grid) : meta);
  if (canonical.v !== grid.v) throw new Error('GeodesicGrid.serializeGridCache: meta.v не совпадает с grid.v');
  const validation = validate(grid);
  if (!validation.ok) throw new Error('GeodesicGrid.serializeGridCache: сетка не прошла validate()');
  const sections = cacheSections(grid);
  let payloadLength = 32;
  sections.forEach(function (section) {
    if (!section.array) throw new Error('GeodesicGrid.serializeGridCache: отсутствует массив ' + section.name);
    payloadLength += align4(section.array.length * sectionElementSize(section.kind));
  });
  const buffer = new ArrayBuffer(CACHE_HEADER_LENGTH + payloadLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes[0] = 0x47; bytes[1] = 0x45; bytes[2] = 0x4f; bytes[3] = 0x00; // GEO\0
  view.setUint16(4, CACHE_FORMAT_VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, CACHE_ENDIANNESS_MARKER, true);
  view.setUint32(12, gridCacheParamsHash(canonical), true);
  view.setUint32(16, CACHE_HEADER_LENGTH, true);
  view.setUint32(20, payloadLength, true);
  view.setUint32(28, grid.v, true);

  const payload = CACHE_HEADER_LENGTH;
  view.setUint32(payload + 0, 1, true); // payload layout v1
  view.setUint32(payload + 4, grid.v, true);
  view.setUint32(payload + 8, grid.cellCount, true);
  view.setUint32(payload + 12, grid.triangleCount, true);
  view.setUint32(payload + 16, grid.cellCorners.length, true);
  view.setUint32(payload + 20, typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0, true);
  view.setUint32(payload + 24, grid.chunkBlockSteps || CHUNK_BLOCK_STEPS, true);
  view.setUint32(payload + 28, 0, true);
  let offset = payload + 32;
  sections.forEach(function (section) {
    offset += writeSection(view, bytes, offset, section);
  });
  view.setUint32(24, crc32c(bytes.subarray(CACHE_HEADER_LENGTH)), true);
  return buffer;
}

function toUint8Array(input: unknown): Uint8Array | null {
  if (!input) return null;
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

function allocateSection(length: number, kind: SectionKind): SectionArray {
  if (kind === 'f32') return new Float32Array(length);
  if (kind === 'u32') return new Uint32Array(length);
  if (kind === 'i32') return new Int32Array(length);
  if (kind === 'u16') return new Uint16Array(length);
  return new Uint8Array(length);
}

function readSection(
  view: DataView, inputBytes: Uint8Array, offset: number, length: number, kind: SectionKind, limit: number,
): { array: SectionArray; nextOffset: number } {
  const size = sectionElementSize(kind);
  const byteLength = length * size;
  if (offset < 0 || offset + byteLength > limit) throw new Error('section-out-of-range');
  let out: SectionArray;
  let i: number;
  if (HOST_LITTLE_ENDIAN) {
    out = allocateSection(length, kind);
    new Uint8Array(out.buffer).set(inputBytes.subarray(offset, offset + byteLength));
    return { array: out, nextOffset: offset + align4(byteLength) };
  }
  if (kind === 'f32') {
    const arr = new Float32Array(length);
    for (i = 0; i < length; i++) arr[i] = view.getFloat32(offset + i * 4, true);
    out = arr;
  } else if (kind === 'u32') {
    const arr = new Uint32Array(length);
    for (i = 0; i < length; i++) arr[i] = view.getUint32(offset + i * 4, true);
    out = arr;
  } else if (kind === 'i32') {
    const arr = new Int32Array(length);
    for (i = 0; i < length; i++) arr[i] = view.getInt32(offset + i * 4, true);
    out = arr;
  } else if (kind === 'u16') {
    const arr = new Uint16Array(length);
    for (i = 0; i < length; i++) arr[i] = view.getUint16(offset + i * 2, true);
    out = arr;
  } else {
    const arr = new Uint8Array(length);
    for (i = 0; i < length; i++) arr[i] = view.getUint8(offset + i);
    out = arr;
  }
  return { array: out, nextOffset: offset + align4(byteLength) };
}

function deserializeGridCache(input: unknown, expectedMeta?: CacheMetaInput): DeserializeResult {
  try {
    const bytes = toUint8Array(input);
    if (!bytes || bytes.length < CACHE_HEADER_LENGTH + 32) return { ok: false, reason: 'too-small' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[0] !== 0x47 || bytes[1] !== 0x45 || bytes[2] !== 0x4f || bytes[3] !== 0x00) {
      return { ok: false, reason: 'bad-magic' };
    }
    if (view.getUint16(4, true) !== CACHE_FORMAT_VERSION) return { ok: false, reason: 'unsupported-version' };
    if (view.getUint16(6, true) !== 0) return { ok: false, reason: 'unsupported-flags' };
    if (view.getUint32(8, true) !== CACHE_ENDIANNESS_MARKER) return { ok: false, reason: 'bad-endianness-marker' };
    if (view.getUint32(16, true) !== CACHE_HEADER_LENGTH) return { ok: false, reason: 'bad-header-length' };
    const payloadLength = view.getUint32(20, true);
    if (payloadLength !== bytes.length - CACHE_HEADER_LENGTH) return { ok: false, reason: 'length-mismatch' };
    const expected = normalizeCacheMeta(expectedMeta || {});
    const headerV = view.getUint32(28, true);
    if (Number.isInteger(expected.v) && expected.v !== headerV) return { ok: false, reason: 'v-mismatch' };
    if (!Number.isInteger(expected.v)) expected.v = headerV;
    if (view.getUint32(12, true) !== gridCacheParamsHash(expected)) {
      return { ok: false, reason: 'params-hash-mismatch' };
    }
    const payloadBytes = bytes.subarray(CACHE_HEADER_LENGTH);
    if (view.getUint32(24, true) !== crc32c(payloadBytes)) return { ok: false, reason: 'crc-mismatch' };

    const payload = CACHE_HEADER_LENGTH;
    if (view.getUint32(payload + 0, true) !== 1) return { ok: false, reason: 'unsupported-payload-layout' };
    const v = view.getUint32(payload + 4, true);
    const cellCount = view.getUint32(payload + 8, true);
    const triangleCount = view.getUint32(payload + 12, true);
    const cellCornersLength = view.getUint32(payload + 16, true);
    const bodyIndex = view.getUint32(payload + 20, true);
    const blockSteps = view.getUint32(payload + 24, true);
    if (v !== headerV || cellCount !== cellCountForFrequency(v) ||
        triangleCount !== triangleCountForFrequency(v) ||
        cellCornersLength !== 60 * v * v || blockSteps !== CHUNK_BLOCK_STEPS) {
      return { ok: false, reason: 'invalid-payload-header' };
    }

    let offset = payload + 32;
    const limit = bytes.length;
    const specs: Array<[string, number, SectionKind]> = [
      ['centers', cellCount * 3, 'f32'],
      ['corners', triangleCount * 3, 'f32'],
      ['triangles', triangleCount * 3, 'u32'],
      ['cellCornerStart', cellCount + 1, 'u32'],
      ['cellCorners', cellCornersLength, 'u32'],
      ['neighbors', cellCount * 6, 'i32'],
      ['neighborCount', cellCount, 'u8'],
      ['areas', cellCount, 'f32'],
      ['addrFace', cellCount, 'u8'],
      ['addrI', cellCount, 'u16'],
      ['addrJ', cellCount, 'u16'],
    ];
    const grid = {
      v: v,
      gridVersion: expected.gridVersion,
      addressSchema: expected.addressSchema,
      topologySchema: expected.topologySchema,
      chunkSchema: CHUNK_SCHEMA,
      chunkBlockSteps: blockSteps,
      bodyIndex: bodyIndex,
      cellCount: cellCount,
      triangleCount: triangleCount,
      pentagons: 0,
    } as PlanetGrid;
    const writable = grid as unknown as Record<string, unknown>;
    specs.forEach(function (spec) {
      const read = readSection(view, bytes, offset, spec[1], spec[2], limit);
      writable[spec[0]] = read.array;
      offset = read.nextOffset;
    });
    if (offset !== limit) return { ok: false, reason: 'payload-size-mismatch' };
    for (let c = 0; c < cellCount; c++) if (grid.neighborCount[c] === 5) grid.pentagons++;
    attachChunks(grid);
    const validation = validate(grid);
    if (!validation.ok) return { ok: false, reason: 'validation-failed', validation: validation };
    return { ok: true, grid: grid };
  } catch (err) {
    return { ok: false, reason: 'invalid-payload', error: String((err as { message?: string })?.message || err) };
  }
}

export interface LoadGridWithCacheOptions {
  expectedMeta?: CacheMetaInput;
  readCache?: () => unknown;
  rebuildGrid?: () => PlanetGrid | Promise<PlanetGrid>;
  writeCache?: (serialized: ArrayBuffer, grid: PlanetGrid) => unknown;
}

export interface LoadGridWithCacheResult {
  grid: PlanetGrid;
  source: 'cache' | 'rebuilt';
  reason?: string;
}

function loadGridWithCache(options: LoadGridWithCacheOptions = {}): Promise<LoadGridWithCacheResult> {
  const expectedMeta = normalizeCacheMeta(options.expectedMeta || {});
  let reason = 'cache-miss';
  let readPromise: Promise<unknown>;
  try {
    readPromise = Promise.resolve(options.readCache ? options.readCache() : null);
  } catch (err) {
    readPromise = Promise.reject(err);
  }
  return readPromise.catch(function () {
    reason = 'cache-read-error';
    return null;
  }).then(function (bytes): Promise<LoadGridWithCacheResult> | LoadGridWithCacheResult {
    if (bytes) {
      const parsed = deserializeGridCache(bytes, expectedMeta);
      if (parsed.ok && parsed.grid) return { grid: parsed.grid, source: 'cache' };
      reason = parsed.reason || reason;
    }
    return Promise.resolve(options.rebuildGrid ? options.rebuildGrid() : build(expectedMeta.v as number))
      .then(function (grid): LoadGridWithCacheResult | Promise<LoadGridWithCacheResult> {
        const done: LoadGridWithCacheResult = { grid: grid, source: 'rebuilt', reason: reason };
        if (!options.writeCache) return done;
        let serialized: ArrayBuffer;
        try {
          serialized = serializeGridCache(grid, expectedMeta);
        } catch {
          return done;
        }
        return Promise.resolve(options.writeCache(serialized, grid))
          .catch(function () { return null; })
          .then(function () { return done; });
      });
  });
}

const GeodesicGrid = {
  build,
  addressOf,
  parseAddress,
  cellAtAddress,
  pick,
  pickBruteForce,
  getChunks,
  getChunkNeighbors,
  validate,
  validateChunks,
  attachChunks,
  cellCountForFrequency,
  triangleCountForFrequency,
  frequencyForRadius,
  meanCellAreaKm2,
  meanCellEdgeKm,
  gridCacheMeta,
  gridCacheParamsHash,
  serializeGridCache,
  deserializeGridCache,
  loadGridWithCache,
  crc32c,
  GRID_VERSION,
  ADDRESS_SCHEMA,
  TOPOLOGY_SCHEMA,
  CHUNK_SCHEMA,
  CHUNK_BLOCK_STEPS,
  CHUNK_MIN_CELLS,
  CHUNK_MAX_CELLS,
  EARTH_RADIUS_KM,
  EARTH_CANONICAL_V,
  CACHE_FORMAT_VERSION,
};

export type GeodesicGridApi = typeof GeodesicGrid;

declare global {
  interface Window {
    GeodesicGrid: GeodesicGridApi;
  }
}

(globalThis as typeof globalThis & { GeodesicGrid: GeodesicGridApi }).GeodesicGrid = GeodesicGrid;

export default GeodesicGrid;
