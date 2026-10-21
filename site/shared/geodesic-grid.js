/* GeodesicGrid — боевое ядро геодезической сетки Голдберга GP(v,0).
   =========================================================================
   ЭТАП 3. Ядро выросло из спайка Этапа 1 и сохраняет его публичную форму
   (centers/corners/triangles/cellCorners/neighbors/areas), но фиксирует
   контракты, которых у спайка ещё не было:

   - grid/address/topology version: goldberg-gp-v1;
   - канонический адрес ячейки и обратный поиск по адресу;
   - ячейки переупорядочены по пространственным chunk-блокам внутри граней
     икосаэдра, диапазоны chunk непрерывны во всех SoA-массивах;
   - точный быстрый pick по chunk bounding spheres (не полный перебор);
   - версионированный little-endian бинарный кэш топологии с CRC32C;
   - формула канонической частоты по радиусу (Земля — v=128).

   ПОСТРОЕНИЕ
     1) 20 граней икосаэдра находятся по вершинам: тройки вершин на
        минимальном попарном расстоянии, ориентация — наружу. Порядок
        исходных 12 вершин и лексикографическое перечисление троек являются
        частью goldberg-gp-v1 и не меняются без новой версии.
     2) Каждая грань делится барицентрической решёткой на v² треугольников;
        вершины проецируются на единичную сферу и склеиваются по округлённой
        координате.
     3) Ячейка Голдберга — многоугольник вокруг вершины триангуляции: его углы —
        центроиды инцидентных треугольников, упорядоченные по полярному углу
        в касательной плоскости центра.
     4) Площадь ячейки — сумма сферических площадей веера из первого угла.
     5) Готовая топология переупорядочивается по chunk-ключам; числовой индекс
        остаётся быстрым runtime-индексом, но не вечным идентификатором.

   АДРЕС ЯЧЕЙКИ (v1):
     goldberg-gp-v1/w<тело>/v<частота>/f<грань>/a<i>/b<j>

   w — резерв сегмента тела, сейчас всегда 0; трёхуровневый сетап иной
   топологии не заложен. Владельцем вершины на общем ребре/углу считается
   лексикографически наименьшее представление (face, i, j) среди всех
   инцидентных граней в замороженной таблице граней v1. Третья барицентрическая
   координата равна v-i-j.

   CHUNKS
   Внутри грани-владельца решётка делится на блоки по 32 шага по осям i/j.
   Порядок ячеек: face, blockI, blockJ, i, j. Квадратные блоки на гипотенузе
   треугольной грани могут дать микро-остатки; блоки меньше 32 ячеек поэтому
   канонически сливаются с соседним блоком той же грани при потолке chunk
   1088 ячеек. Итоговый chunk — непрерывный диапазон
   [startCell, startCell+cellCount), принадлежащий одной грани и имеющий
   bounding sphere по центрам и углам своих ячеек.

   API (основное)
     GeodesicGrid.build(v)
     GeodesicGrid.addressOf(grid, cell)
     GeodesicGrid.parseAddress(address)
     GeodesicGrid.cellAtAddress(grid, addressOrParts)
     GeodesicGrid.pick(grid, dir)              // точный быстрый поиск
     GeodesicGrid.pickBruteForce(grid, dir)    // референс для тестов
     GeodesicGrid.getChunks(grid)
     GeodesicGrid.getChunkNeighbors(grid, chunkId)
     GeodesicGrid.validate(grid)
     GeodesicGrid.validateChunks(grid)
     GeodesicGrid.frequencyForRadius(radiusKm)
     GeodesicGrid.serializeGridCache(grid, meta?)
     GeodesicGrid.deserializeGridCache(bytes, expectedMeta)
     GeodesicGrid.loadGridWithCache({readCache, writeCache, rebuildGrid, expectedMeta})

   В браузере модуль вешает window.GeodesicGrid, в Node — module.exports. */
(function (root) {
  'use strict';

  var GRID_VERSION = 'goldberg-gp-v1';
  var ADDRESS_SCHEMA = GRID_VERSION;
  var TOPOLOGY_SCHEMA = 'goldberg-gp-v1-soa';
  var CHUNK_SCHEMA = 'face-barycentric-blocks-v1';
  var CHUNK_BLOCK_STEPS = 32;
  var CHUNK_MIN_CELLS = 32;
  var CHUNK_MAX_CELLS = 1088;
  var EARTH_RADIUS_KM = 6371;
  var EARTH_CANONICAL_V = 128;
  var CACHE_FORMAT_VERSION = 1;
  var CACHE_HEADER_LENGTH = 32;
  var CACHE_ENDIANNESS_MARKER = 0x01020304;

  function normalize3(x, y, z, out) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    out[0] = x / len; out[1] = y / len; out[2] = z / len;
    return out;
  }

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  function cellCountForFrequency(v) {
    if (!Number.isInteger(v) || v < 1) throw new Error('GeodesicGrid: v должно быть целым >= 1');
    return 10 * v * v + 2;
  }

  function triangleCountForFrequency(v) {
    if (!Number.isInteger(v) || v < 1) throw new Error('GeodesicGrid: v должно быть целым >= 1');
    return 20 * v * v;
  }

  function frequencyForRadius(radiusKm) {
    if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
      throw new Error('GeodesicGrid.frequencyForRadius: radiusKm должно быть конечным > 0');
    }
    var earthCells = cellCountForFrequency(EARTH_CANONICAL_V);
    var ratio = radiusKm / EARTH_RADIUS_KM;
    var targetCells = earthCells * ratio * ratio;
    return Math.max(1, Math.round(Math.sqrt(Math.max(0, targetCells - 2) / 10)));
  }

  function meanCellAreaKm2(radiusKm, v) {
    var freq = v == null ? frequencyForRadius(radiusKm) : v;
    return 4 * Math.PI * radiusKm * radiusKm / cellCountForFrequency(freq);
  }

  function meanCellEdgeKm(radiusKm, v) {
    // Оценка по равновеликому правильному шестиугольнику.
    return Math.sqrt(2 * meanCellAreaKm2(radiusKm, v) / (3 * Math.sqrt(3)));
  }

  function icosahedron() {
    var t = (1 + Math.sqrt(5)) / 2;
    // Порядок raw-вершин заморожен goldberg-gp-v1: от него зависят номера
    // граней и канонические адреса на общих рёбрах.
    var raw = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ];
    var verts = raw.map(function (p) { return normalize3(p[0], p[1], p[2], [0, 0, 0]); });
    var minD2 = Infinity;
    var i, j, k;
    for (i = 0; i < 12; i++) for (j = i + 1; j < 12; j++) {
      var dx = verts[i][0] - verts[j][0], dy = verts[i][1] - verts[j][1], dz = verts[i][2] - verts[j][2];
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < minD2) minD2 = d2;
    }
    function isEdge(a, b) {
      var ex = verts[a][0] - verts[b][0], ey = verts[a][1] - verts[b][1], ez = verts[a][2] - verts[b][2];
      return Math.abs(ex * ex + ey * ey + ez * ez - minD2) < 1e-9;
    }
    var faces = [];
    for (i = 0; i < 12; i++) for (j = i + 1; j < 12; j++) for (k = j + 1; k < 12; k++) {
      if (!isEdge(i, j) || !isEdge(j, k) || !isEdge(i, k)) continue;
      var a = verts[i], b = verts[j], c = verts[k];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var outward = nx * (a[0] + b[0] + c[0]) + ny * (a[1] + b[1] + c[1]) + nz * (a[2] + b[2] + c[2]);
      faces.push(outward > 0 ? [i, j, k] : [i, k, j]);
    }
    if (faces.length !== 20) throw new Error('GeodesicGrid: икосаэдр должен дать ровно 20 граней');
    return { verts: verts, faces: faces };
  }

  function sphericalTriangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
    var triple = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    var denom = 1 + (ax * bx + ay * by + az * bz) + (bx * cx + by * cy + bz * cz) + (cx * ax + cy * ay + cz * az);
    return 2 * Math.atan2(triple, denom);
  }

  function insertionSortSegment(values, start, end) {
    for (var i = start + 1; i < end; i++) {
      var value = values[i];
      var j = i - 1;
      while (j >= start && values[j] > value) {
        values[j + 1] = values[j];
        j--;
      }
      values[j + 1] = value;
    }
  }

  function candidateIsSmaller(face, i, j, oldFace, oldI, oldJ) {
    return face < oldFace ||
      (face === oldFace && (i < oldI || (i === oldI && j < oldJ)));
  }

  function chunkBlockIndex(coord) {
    return Math.floor(coord / CHUNK_BLOCK_STEPS);
  }

  function build(v) {
    if (!Number.isInteger(v) || v < 1 || v > 10000) {
      throw new Error('GeodesicGrid.build: v должно быть целым от 1 до 10000');
    }
    var ico = icosahedron();
    var expectedCells = cellCountForFrequency(v);
    var expectedTriangles = triangleCountForFrequency(v);

    var centersRaw = new Float32Array(expectedCells * 3);
    var addrFaceRaw = new Uint8Array(expectedCells);
    var addrIRaw = new Uint16Array(expectedCells);
    var addrJRaw = new Uint16Array(expectedCells);
    var vertexCount = 0;
    var byKey = new Map();
    var tmp = [0, 0, 0];

    function getVertex(x, y, z, face, i, j) {
      normalize3(x, y, z, tmp);
      var key = tmp[0].toFixed(9) + ',' + tmp[1].toFixed(9) + ',' + tmp[2].toFixed(9);
      var found = byKey.get(key);
      if (found !== undefined) {
        if (candidateIsSmaller(face, i, j, addrFaceRaw[found], addrIRaw[found], addrJRaw[found])) {
          addrFaceRaw[found] = face;
          addrIRaw[found] = i;
          addrJRaw[found] = j;
        }
        return found;
      }
      var id = vertexCount++;
      centersRaw[id * 3] = tmp[0];
      centersRaw[id * 3 + 1] = tmp[1];
      centersRaw[id * 3 + 2] = tmp[2];
      addrFaceRaw[id] = face;
      addrIRaw[id] = i;
      addrJRaw[id] = j;
      byKey.set(key, id);
      return id;
    }

    var trianglesRaw = new Uint32Array(expectedTriangles * 3);
    var triCursor = 0;
    ico.faces.forEach(function (faceIdx, faceNo) {
      var A = ico.verts[faceIdx[0]], B = ico.verts[faceIdx[1]], C = ico.verts[faceIdx[2]];
      var local = new Map();
      function P(i, j) {
        var key = i * (v + 1) + j;
        var id = local.get(key);
        if (id !== undefined) return id;
        var wa = (v - i - j) / v, wb = i / v, wc = j / v;
        id = getVertex(
          A[0] * wa + B[0] * wb + C[0] * wc,
          A[1] * wa + B[1] * wb + C[1] * wc,
          A[2] * wa + B[2] * wb + C[2] * wc,
          faceNo, i, j
        );
        local.set(key, id);
        return id;
      }
      for (var i = 0; i < v; i++) {
        for (var j = 0; j < v - i; j++) {
          trianglesRaw[triCursor++] = P(i, j);
          trianglesRaw[triCursor++] = P(i + 1, j);
          trianglesRaw[triCursor++] = P(i, j + 1);
          if (i + j < v - 1) {
            trianglesRaw[triCursor++] = P(i + 1, j);
            trianglesRaw[triCursor++] = P(i + 1, j + 1);
            trianglesRaw[triCursor++] = P(i, j + 1);
          }
        }
      }
    });
    if (vertexCount !== expectedCells || triCursor !== trianglesRaw.length) {
      throw new Error('GeodesicGrid.build: внутреннее несоответствие числа вершин/треугольников');
    }

    var cellCount = expectedCells;
    var triangleCount = expectedTriangles;
    var corners = new Float32Array(triangleCount * 3);
    var incidenceCount = new Uint8Array(cellCount);
    var t, a, b, d;
    for (t = 0; t < triangleCount; t++) {
      a = trianglesRaw[t * 3]; b = trianglesRaw[t * 3 + 1]; d = trianglesRaw[t * 3 + 2];
      normalize3(
        centersRaw[a * 3] + centersRaw[b * 3] + centersRaw[d * 3],
        centersRaw[a * 3 + 1] + centersRaw[b * 3 + 1] + centersRaw[d * 3 + 1],
        centersRaw[a * 3 + 2] + centersRaw[b * 3 + 2] + centersRaw[d * 3 + 2],
        tmp
      );
      corners[t * 3] = tmp[0]; corners[t * 3 + 1] = tmp[1]; corners[t * 3 + 2] = tmp[2];
      incidenceCount[a]++; incidenceCount[b]++; incidenceCount[d]++;
    }

    var cellCornerStartRaw = new Uint32Array(cellCount + 1);
    var offset = 0;
    var c;
    for (c = 0; c < cellCount; c++) {
      cellCornerStartRaw[c] = offset;
      offset += incidenceCount[c];
    }
    cellCornerStartRaw[cellCount] = offset;
    var cellCornersRaw = new Uint32Array(offset);
    var fillCursor = new Uint32Array(cellCornerStartRaw);
    for (t = 0; t < triangleCount; t++) {
      a = trianglesRaw[t * 3]; b = trianglesRaw[t * 3 + 1]; d = trianglesRaw[t * 3 + 2];
      cellCornersRaw[fillCursor[a]++] = t;
      cellCornersRaw[fillCursor[b]++] = t;
      cellCornersRaw[fillCursor[d]++] = t;
    }

    // Соседи фиксированной ширины 6: без Set на каждую ячейку. Дубли рёбер
    // от двух инцидентных треугольников отсекаются линейной проверкой до 6 слотов.
    var neighborsRaw = new Int32Array(cellCount * 6).fill(-1);
    var neighborCountRaw = new Uint8Array(cellCount);
    function addNeighbor(cell, nb) {
      var base = cell * 6;
      var count = neighborCountRaw[cell];
      for (var k = 0; k < count; k++) if (neighborsRaw[base + k] === nb) return;
      if (count >= 6) throw new Error('GeodesicGrid.build: у ячейки больше 6 соседей');
      neighborsRaw[base + count] = nb;
      neighborCountRaw[cell] = count + 1;
    }
    for (t = 0; t < triangleCount; t++) {
      a = trianglesRaw[t * 3]; b = trianglesRaw[t * 3 + 1]; d = trianglesRaw[t * 3 + 2];
      addNeighbor(a, b); addNeighbor(a, d);
      addNeighbor(b, a); addNeighbor(b, d);
      addNeighbor(d, a); addNeighbor(d, b);
    }
    var pentagons = 0;
    for (c = 0; c < cellCount; c++) {
      if (neighborCountRaw[c] === 5) pentagons++;
      insertionSortSegment(neighborsRaw, c * 6, c * 6 + neighborCountRaw[c]);
    }

    var areasRaw = new Float32Array(cellCount);
    var angles = new Float64Array(6);
    for (c = 0; c < cellCount; c++) {
      var start = cellCornerStartRaw[c];
      var end = cellCornerStartRaw[c + 1];
      var cx = centersRaw[c * 3], cy = centersRaw[c * 3 + 1], cz = centersRaw[c * 3 + 2];
      var ax = Math.abs(cx) < 0.9 ? 1 : 0, ay = Math.abs(cx) < 0.9 ? 0 : 1;
      var t1 = normalize3(cy * 0 - cz * ay, cz * ax - cx * 0, cx * ay - cy * ax, [0, 0, 0]);
      var t2 = [cy * t1[2] - cz * t1[1], cz * t1[0] - cx * t1[2], cx * t1[1] - cy * t1[0]];
      var k;
      for (k = start; k < end; k++) {
        var corner = cellCornersRaw[k] * 3;
        angles[k - start] = Math.atan2(
          corners[corner] * t2[0] + corners[corner + 1] * t2[1] + corners[corner + 2] * t2[2],
          corners[corner] * t1[0] + corners[corner + 1] * t1[1] + corners[corner + 2] * t1[2]
        );
      }
      // Insertion sort сегмента из 5/6 углов по заранее посчитанным углам.
      for (var ii = 1; ii < end - start; ii++) {
        var cornerValue = cellCornersRaw[start + ii];
        var angleValue = angles[ii];
        var jj = ii - 1;
        while (jj >= 0 && angles[jj] > angleValue) {
          cellCornersRaw[start + jj + 1] = cellCornersRaw[start + jj];
          angles[jj + 1] = angles[jj];
          jj--;
        }
        cellCornersRaw[start + jj + 1] = cornerValue;
        angles[jj + 1] = angleValue;
      }
      var area = 0;
      for (k = 1; k + 1 < end - start; k++) {
        var p0 = cellCornersRaw[start] * 3;
        var p1 = cellCornersRaw[start + k] * 3;
        var p2 = cellCornersRaw[start + k + 1] * 3;
        area += sphericalTriangleArea(
          corners[p0], corners[p0 + 1], corners[p0 + 2],
          corners[p1], corners[p1 + 1], corners[p1 + 2],
          corners[p2], corners[p2 + 1], corners[p2 + 2]
        );
      }
      if (area < 0) {
        var lo = start, hi = end - 1;
        while (lo < hi) {
          var swap = cellCornersRaw[lo];
          cellCornersRaw[lo] = cellCornersRaw[hi];
          cellCornersRaw[hi] = swap;
          lo++; hi--;
        }
        area = -area;
      }
      areasRaw[c] = area;
    }

    var grid = reorderCells({
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
      addrJ: addrJRaw
    });
    grid.gridVersion = GRID_VERSION;
    grid.addressSchema = ADDRESS_SCHEMA;
    grid.topologySchema = TOPOLOGY_SCHEMA;
    grid.chunkSchema = CHUNK_SCHEMA;
    grid.chunkBlockSteps = CHUNK_BLOCK_STEPS;
    grid.bodyIndex = 0;
    attachChunks(grid);
    return grid;
  }

  function reorderCells(raw) {
    var count = raw.cellCount;
    var maxBlock = Math.floor(raw.v / CHUNK_BLOCK_STEPS) + 1;
    var groupsByKey = new Map();
    var groups = [];
    var oldGroup = new Uint32Array(count);
    var c;
    for (c = 0; c < count; c++) {
      var face = raw.addrFace[c];
      var qa = chunkBlockIndex(raw.addrI[c]);
      var qb = chunkBlockIndex(raw.addrJ[c]);
      var key = (face * maxBlock + qa) * maxBlock + qb;
      var group = groupsByKey.get(key);
      if (!group) {
        group = { faceIndex: face, blockI: qa, blockJ: qb, tempIndex: groups.length, ordinal: groups.length };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      oldGroup[c] = group.tempIndex;
    }
    var groupList = groups.slice();
    groups.sort(function (p, q) {
      return p.faceIndex - q.faceIndex || p.blockI - q.blockI || p.blockJ - q.blockJ;
    });
    for (var gi = 0; gi < groups.length; gi++) groups[gi].ordinal = gi;
    var oldChunk = new Uint32Array(count);
    for (c = 0; c < count; c++) oldChunk[c] = groupList[oldGroup[c]].ordinal;

    var order = new Array(count);
    for (c = 0; c < count; c++) order[c] = c;
    order.sort(function (p, q) {
      return oldChunk[p] - oldChunk[q] ||
        raw.addrI[p] - raw.addrI[q] ||
        raw.addrJ[p] - raw.addrJ[q] ||
        p - q;
    });
    var newId = new Uint32Array(count);
    for (var pos = 0; pos < count; pos++) newId[order[pos]] = pos;

    var centers = new Float32Array(raw.centers.length);
    var areas = new Float32Array(raw.areas.length);
    var neighbors = new Int32Array(raw.neighbors.length).fill(-1);
    var neighborCount = new Uint8Array(raw.neighborCount.length);
    var addrFace = new Uint8Array(raw.addrFace.length);
    var addrI = new Uint16Array(raw.addrI.length);
    var addrJ = new Uint16Array(raw.addrJ.length);
    var cellChunk = new Uint32Array(count);
    var cellCornerStart = new Uint32Array(count + 1);
    var cellCorners = new Uint32Array(raw.cellCorners.length);

    var cornerOffset = 0;
    for (pos = 0; pos < count; pos++) {
      var old = order[pos];
      centers[pos * 3] = raw.centers[old * 3];
      centers[pos * 3 + 1] = raw.centers[old * 3 + 1];
      centers[pos * 3 + 2] = raw.centers[old * 3 + 2];
      areas[pos] = raw.areas[old];
      neighborCount[pos] = raw.neighborCount[old];
      addrFace[pos] = raw.addrFace[old];
      addrI[pos] = raw.addrI[old];
      addrJ[pos] = raw.addrJ[old];
      cellChunk[pos] = oldChunk[old];
      for (var n = 0; n < raw.neighborCount[old]; n++) {
        neighbors[pos * 6 + n] = newId[raw.neighbors[old * 6 + n]];
      }
      insertionSortSegment(neighbors, pos * 6, pos * 6 + neighborCount[pos]);
      cellCornerStart[pos] = cornerOffset;
      var rawStart = raw.cellCornerStart[old];
      var rawEnd = raw.cellCornerStart[old + 1];
      for (var k = rawStart; k < rawEnd; k++) cellCorners[cornerOffset++] = raw.cellCorners[k];
    }
    cellCornerStart[count] = cornerOffset;

    var triangles = new Uint32Array(raw.triangles.length);
    for (var ti = 0; ti < raw.triangles.length; ti++) triangles[ti] = newId[raw.triangles[ti]];

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
      cellChunk: cellChunk
    };
  }

  function attachChunks(grid) {
    if (!grid || !grid.addrFace || !grid.addrI || !grid.addrJ) {
      throw new Error('GeodesicGrid.attachChunks: нет адресных массивов');
    }
    var baseDescriptors = [];
    var byKey = new Map();
    var cellBase = new Uint32Array(grid.cellCount);
    var c;
    for (c = 0; c < grid.cellCount; c++) {
      var face = grid.addrFace[c];
      var qa = chunkBlockIndex(grid.addrI[c]);
      var qb = chunkBlockIndex(grid.addrJ[c]);
      var key = face + '/' + qa + '/' + qb;
      var desc = byKey.get(key);
      if (!desc) {
        desc = {
          tempId: baseDescriptors.length,
          faceIndex: face,
          blockI: qa,
          blockJ: qb,
          startCell: c,
          cellCount: 0
        };
        byKey.set(key, desc);
        baseDescriptors.push(desc);
      }
      if (desc.startCell + desc.cellCount !== c) {
        throw new Error('GeodesicGrid: ячейки chunk не образуют непрерывный диапазон');
      }
      desc.cellCount++;
      cellBase[c] = desc.tempId;
    }

    var baseByTemp = baseDescriptors.slice();
    baseDescriptors.sort(function (p, q) {
      return p.faceIndex - q.faceIndex || p.blockI - q.blockI || p.blockJ - q.blockJ;
    });
    var effectiveIdByTemp = new Uint32Array(baseDescriptors.length);
    var descriptors = [];
    baseDescriptors.forEach(function (base) {
      var prev = descriptors[descriptors.length - 1];
      var shouldMerge = !!prev && prev.faceIndex === base.faceIndex &&
        (base.cellCount < CHUNK_MIN_CELLS || prev.cellCount < CHUNK_MIN_CELLS) &&
        prev.cellCount + base.cellCount <= CHUNK_MAX_CELLS;
      if (shouldMerge) {
        effectiveIdByTemp[base.tempId] = prev.id;
        prev.cellCount += base.cellCount;
        prev.blockCount++;
        return;
      }
      var effective = {
        id: descriptors.length,
        faceIndex: base.faceIndex,
        blockI: base.blockI,
        blockJ: base.blockJ,
        blockCount: 1,
        startCell: base.startCell,
        cellCount: base.cellCount
      };
      effectiveIdByTemp[base.tempId] = effective.id;
      descriptors.push(effective);
    });
    var cellChunk = new Uint32Array(grid.cellCount);
    for (c = 0; c < grid.cellCount; c++) {
      cellChunk[c] = effectiveIdByTemp[baseByTemp[cellBase[c]].tempId];
    }

    var chunkCount = descriptors.length;
    var chunkCellStart = new Uint32Array(chunkCount + 1);
    var chunkFace = new Uint16Array(chunkCount);
    var chunkCenters = new Float32Array(chunkCount * 3);
    var chunkRadius = new Float32Array(chunkCount);
    var chunkCos = new Float32Array(chunkCount);
    var chunkSin = new Float32Array(chunkCount);
    var chunks = new Array(chunkCount);

    descriptors.forEach(function (desc) {
      chunkCellStart[desc.id] = desc.startCell;
      chunkFace[desc.id] = desc.faceIndex;
      var mx = 0, my = 0, mz = 0;
      for (c = desc.startCell; c < desc.startCell + desc.cellCount; c++) {
        mx += grid.centers[c * 3]; my += grid.centers[c * 3 + 1]; mz += grid.centers[c * 3 + 2];
      }
      var center = normalize3(mx, my, mz, [0, 0, 0]);
      var minDot = Infinity;
      function visit(px, py, pz) {
        var dot = px * center[0] + py * center[1] + pz * center[2];
        if (dot < minDot) minDot = dot;
      }
      for (c = desc.startCell; c < desc.startCell + desc.cellCount; c++) {
        visit(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2]);
        for (var k = grid.cellCornerStart[c]; k < grid.cellCornerStart[c + 1]; k++) {
          var corner = grid.cellCorners[k] * 3;
          visit(grid.corners[corner], grid.corners[corner + 1], grid.corners[corner + 2]);
        }
      }
      var cos = clamp(minDot, -1, 1);
      var angularRadius = Math.acos(cos);
      var radius = Math.sqrt(Math.max(0, 2 - 2 * cos));
      chunkCenters[desc.id * 3] = center[0];
      chunkCenters[desc.id * 3 + 1] = center[1];
      chunkCenters[desc.id * 3 + 2] = center[2];
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
          angularRadius: angularRadius
        }
      };
    });
    chunkCellStart[chunkCount] = grid.cellCount;

    var neighborSets = new Array(chunkCount);
    var ci;
    for (ci = 0; ci < chunkCount; ci++) neighborSets[ci] = new Set();
    for (c = 0; c < grid.cellCount; c++) {
      var own = cellChunk[c];
      for (var n = 0; n < grid.neighborCount[c]; n++) {
        var other = cellChunk[grid.neighbors[c * 6 + n]];
        if (other !== own) neighborSets[own].add(other);
      }
    }
    var chunkNeighborStart = new Uint32Array(chunkCount + 1);
    var totalNeighbors = 0;
    var sortedNeighbors = new Array(chunkCount);
    for (ci = 0; ci < chunkCount; ci++) {
      sortedNeighbors[ci] = Array.from(neighborSets[ci]).sort(function (p, q) { return p - q; });
      chunkNeighborStart[ci] = totalNeighbors;
      totalNeighbors += sortedNeighbors[ci].length;
    }
    chunkNeighborStart[chunkCount] = totalNeighbors;
    var chunkNeighbors = new Uint32Array(totalNeighbors);
    for (ci = 0; ci < chunkCount; ci++) {
      for (var ni = 0; ni < sortedNeighbors[ci].length; ni++) {
        chunkNeighbors[chunkNeighborStart[ci] + ni] = sortedNeighbors[ci][ni];
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

  function ensureChunks(grid) {
    if (!grid.chunks || !grid.cellChunk || !grid.chunkCenters) attachChunks(grid);
    return grid.chunks;
  }

  function getChunks(grid) {
    return ensureChunks(grid);
  }

  function getChunkNeighbors(grid, chunkId) {
    ensureChunks(grid);
    if (!Number.isInteger(chunkId) || chunkId < 0 || chunkId >= grid.chunkCount) return [];
    return Array.from(grid.chunkNeighbors.subarray(
      grid.chunkNeighborStart[chunkId], grid.chunkNeighborStart[chunkId + 1]
    ));
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function addressOf(grid, cell) {
    if (!Number.isInteger(cell) || cell < 0 || cell >= grid.cellCount) {
      throw new Error('GeodesicGrid.addressOf: ячейка вне диапазона');
    }
    var w = typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0;
    var schema = grid.addressSchema || GRID_VERSION;
    return schema + '/w' + w + '/v' + grid.v + '/f' + pad2(grid.addrFace[cell]) +
      '/a' + grid.addrI[cell] + '/b' + grid.addrJ[cell];
  }

  var ADDRESS_RE = /^goldberg-gp-v1\/w(\d+)\/v(\d+)\/f(\d{2})\/a(\d+)\/b(\d+)$/;

  function parseAddress(address) {
    if (typeof address !== 'string') return null;
    var m = ADDRESS_RE.exec(address);
    if (!m) return null;
    var parsed = {
      gridVersion: GRID_VERSION,
      addressSchema: ADDRESS_SCHEMA,
      bodyIndex: Number(m[1]),
      v: Number(m[2]),
      face: Number(m[3]),
      faceIndex: Number(m[3]),
      i: Number(m[4]),
      j: Number(m[5])
    };
    if (!Number.isSafeInteger(parsed.bodyIndex) || parsed.bodyIndex < 0 ||
        !Number.isInteger(parsed.v) || parsed.v < 1 || parsed.face < 0 || parsed.face > 19 ||
        parsed.i < 0 || parsed.j < 0 || parsed.i + parsed.j > parsed.v) {
      return null;
    }
    return parsed;
  }

  function addressOrderParts(grid, cell) {
    return [
      grid.addrFace[cell],
      chunkBlockIndex(grid.addrI[cell]),
      chunkBlockIndex(grid.addrJ[cell]),
      grid.addrI[cell],
      grid.addrJ[cell]
    ];
  }

  function compareParts(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  }

  function cellAtAddress(grid, address) {
    var parts = typeof address === 'string' ? parseAddress(address) : address;
    if (!parts || !grid || !grid.addrFace) return -1;
    var body = typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0;
    if (parts.bodyIndex !== body || parts.v !== grid.v) return -1;
    var face = parts.faceIndex != null ? parts.faceIndex : parts.face;
    if (!Number.isInteger(face) || face < 0 || face > 19 ||
        !Number.isInteger(parts.i) || !Number.isInteger(parts.j) ||
        parts.i < 0 || parts.j < 0 || parts.i + parts.j > grid.v) return -1;
    var target = [face, chunkBlockIndex(parts.i), chunkBlockIndex(parts.j), parts.i, parts.j];
    var lo = 0, hi = grid.cellCount - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var cmp = compareParts(addressOrderParts(grid, mid), target);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  function pickBruteForce(grid, dir) {
    var centers = grid.centers;
    var best = -1, bestDot = -Infinity;
    for (var c = 0; c < grid.cellCount; c++) {
      var dot = centers[c * 3] * dir[0] + centers[c * 3 + 1] * dir[1] + centers[c * 3 + 2] * dir[2];
      if (dot > bestDot) { bestDot = dot; best = c; }
    }
    return best;
  }

  function pick(grid, dir) {
    var len = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
    if (!Number.isFinite(len) || len === 0) return 0;
    var x = dir[0] / len, y = dir[1] / len, z = dir[2] / len;
    var chunks;
    try {
      chunks = ensureChunks(grid);
    } catch (_) {
      return pickBruteForce(grid, [x, y, z]);
    }
    if (!chunks.length || !grid.chunkCenters || !grid.chunkCosAngularRadius) {
      return pickBruteForce(grid, [x, y, z]);
    }
    var dots = new Float64Array(chunks.length);
    var nearestChunk = 0;
    var nearestDot = -Infinity;
    var ci;
    for (ci = 0; ci < chunks.length; ci++) {
      var dot = grid.chunkCenters[ci * 3] * x +
        grid.chunkCenters[ci * 3 + 1] * y +
        grid.chunkCenters[ci * 3 + 2] * z;
      dots[ci] = dot;
      if (dot > nearestDot) { nearestDot = dot; nearestChunk = ci; }
    }
    var best = -1;
    var bestDot = -Infinity;
    function scanChunk(chunkId) {
      var chunk = chunks[chunkId];
      var start = chunk.startCell;
      var end = start + chunk.cellCount;
      for (var c = start; c < end; c++) {
        var cellDot = grid.centers[c * 3] * x + grid.centers[c * 3 + 1] * y + grid.centers[c * 3 + 2] * z;
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
      var sinBest = Math.sqrt(Math.max(0, 1 - bestDot * bestDot));
      var minCenterDot = bestDot * grid.chunkCosAngularRadius[ci] -
        sinBest * grid.chunkSinAngularRadius[ci];
      if (dots[ci] >= minCenterDot - 1e-12) scanChunk(ci);
    }
    return best;
  }

  function validateChunks(grid) {
    var checks = {};
    var chunks;
    try {
      chunks = ensureChunks(grid);
      checks.present = true;
    } catch (err) {
      return { ok: false, checks: { present: false }, error: String((err && err.message) || err) };
    }
    var partition = chunks.length > 0 && chunks[0].startCell === 0;
    var faceOk = true;
    var boundsOk = true;
    var seen = new Uint8Array(grid.cellCount);
    var total = 0;
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      if (chunk.id !== ci || chunk.startCell !== total || chunk.cellCount <= 0) partition = false;
      total += chunk.cellCount;
      var center = chunk.boundingSphere.center;
      var cos = chunk.boundingSphere.cosAngularRadius;
      var centerLen = Math.sqrt(center[0] * center[0] + center[1] * center[1] + center[2] * center[2]);
      if (!Number.isFinite(centerLen) || Math.abs(centerLen - 1) > 1e-5 || !(cos >= -1 && cos <= 1)) boundsOk = false;
      for (var c = chunk.startCell; c < chunk.startCell + chunk.cellCount; c++) {
        if (seen[c] || grid.cellChunk[c] !== ci) partition = false;
        seen[c] = 1;
        if (grid.addrFace[c] !== chunk.faceIndex) faceOk = false;
        var dotCenter = grid.centers[c * 3] * center[0] + grid.centers[c * 3 + 1] * center[1] + grid.centers[c * 3 + 2] * center[2];
        if (dotCenter < cos - 1e-6) boundsOk = false;
        for (var k = grid.cellCornerStart[c]; k < grid.cellCornerStart[c + 1]; k++) {
          var corner = grid.cellCorners[k] * 3;
          var dotCorner = grid.corners[corner] * center[0] + grid.corners[corner + 1] * center[1] + grid.corners[corner + 2] * center[2];
          if (dotCorner < cos - 1e-6) boundsOk = false;
        }
      }
    }
    checks.partition = partition && total === grid.cellCount;
    checks.faceContained = faceOk;
    checks.boundingSpheres = boundsOk;

    var neighborOk = true;
    var neighborSets = chunks.map(function (_, id) { return new Set(getChunkNeighbors(grid, id)); });
    for (ci = 0; ci < chunks.length; ci++) {
      var list = getChunkNeighbors(grid, ci);
      if (list.length !== neighborSets[ci].size || list.indexOf(ci) >= 0) neighborOk = false;
      for (var ni = 0; ni < list.length; ni++) {
        if (!neighborSets[list[ni]] || !neighborSets[list[ni]].has(ci)) neighborOk = false;
      }
    }
    checks.neighborsSymmetric = neighborOk;
    var maxCells = 0;
    var maxAngular = 0;
    chunks.forEach(function (chunk) {
      maxCells = Math.max(maxCells, chunk.cellCount);
      maxAngular = Math.max(maxAngular, chunk.boundingSphere.angularRadius);
    });
    return {
      ok: Object.keys(checks).every(function (k) { return checks[k]; }),
      checks: checks,
      chunkCount: chunks.length,
      averageCells: chunks.length ? grid.cellCount / chunks.length : 0,
      maxCells: maxCells,
      maxAngularRadius: maxAngular
    };
  }

  function validate(grid) {
    var checks = {};
    if (!grid || !Number.isInteger(grid.v) || grid.v < 1) {
      return { ok: false, checks: { shape: false }, areaSum: 0 };
    }
    var v = grid.v;
    var expectedCells = cellCountForFrequency(v);
    var expectedTriangles = triangleCountForFrequency(v);
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

    var areaSum = 0;
    var finite = true;
    var indicesOk = true;
    var c, k;
    for (c = 0; c < grid.cellCount; c++) {
      areaSum += grid.areas[c];
      var nx = grid.centers[c * 3], ny = grid.centers[c * 3 + 1], nz = grid.centers[c * 3 + 2];
      var nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(grid.areas[c] > 0) || !Number.isFinite(grid.areas[c]) ||
          !Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(nz) ||
          Math.abs(nlen - 1) > 1e-4) finite = false;
      if (grid.neighborCount[c] !== 5 && grid.neighborCount[c] !== 6) finite = false;
      if (grid.cellCornerStart[c + 1] - grid.cellCornerStart[c] !== grid.neighborCount[c]) indicesOk = false;
      for (k = 0; k < grid.neighborCount[c]; k++) {
        var nb = grid.neighbors[c * 6 + k];
        if (nb < 0 || nb >= grid.cellCount || nb === c) indicesOk = false;
      }
      for (k = grid.cellCornerStart[c]; k < grid.cellCornerStart[c + 1]; k++) {
        if (grid.cellCorners[k] < 0 || grid.cellCorners[k] >= grid.triangleCount) indicesOk = false;
      }
    }
    for (var t = 0; t < grid.triangleCount; t++) {
      var a = grid.triangles[t * 3], b = grid.triangles[t * 3 + 1], d = grid.triangles[t * 3 + 2];
      if (a < 0 || b < 0 || d < 0 || a >= grid.cellCount || b >= grid.cellCount || d >= grid.cellCount ||
          a === b || b === d || a === d) indicesOk = false;
      var cx = grid.corners[t * 3], cy = grid.corners[t * 3 + 1], cz = grid.corners[t * 3 + 2];
      var clen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || Math.abs(clen - 1) > 1e-4) finite = false;
    }
    checks.areaSum = Math.abs(areaSum - 4 * Math.PI) < 1e-3;
    checks.finite = finite;
    checks.indices = indicesOk;

    var symmetric = true;
    outer:
    for (c = 0; c < grid.cellCount; c++) {
      for (var n = 0; n < grid.neighborCount[c]; n++) {
        var neighbor = grid.neighbors[c * 6 + n];
        var back = false;
        for (var m = 0; m < grid.neighborCount[neighbor]; m++) {
          if (grid.neighbors[neighbor * 6 + m] === c) { back = true; break; }
        }
        if (!back) { symmetric = false; break outer; }
      }
    }
    checks.neighborsSymmetric = symmetric;

    var addressSet = new Set();
    var centerSet = new Set();
    var addressesOk = true;
    var prevFace = -1, prevBlockI = -1, prevBlockJ = -1, prevI = -1, prevJ = -1;
    for (c = 0; c < grid.cellCount; c++) {
      var face = grid.addrFace[c];
      var ai = grid.addrI[c];
      var aj = grid.addrJ[c];
      var blockI = chunkBlockIndex(ai);
      var blockJ = chunkBlockIndex(aj);
      if (face > 19 || ai + aj > v) addressesOk = false;
      // Порядок ячеек должен быть строго лексикографическим по ключу,
      // который использует бинарный cellAtAddress. Вместе с уникальностью
      // tuple ниже это O(F)-доказательство обратного поиска без regex на
      // каждую ячейку; полный строковый round-trip покрыт юнит-тестами v4.
      if (c > 0) {
        var cmp = face - prevFace || blockI - prevBlockI || blockJ - prevBlockJ || ai - prevI || aj - prevJ;
        if (cmp <= 0) addressesOk = false;
      }
      prevFace = face; prevBlockI = blockI; prevBlockJ = blockJ; prevI = ai; prevJ = aj;
      addressSet.add(face + ',' + ai + ',' + aj);
      centerSet.add(Math.round(grid.centers[c * 3] * 1e7) + ',' +
        Math.round(grid.centers[c * 3 + 1] * 1e7) + ',' +
        Math.round(grid.centers[c * 3 + 2] * 1e7));
    }
    checks.addresses = addressesOk && addressSet.size === grid.cellCount;
    checks.noDuplicateCenters = centerSet.size === grid.cellCount;
    var chunkValidation = validateChunks(grid);
    checks.chunks = chunkValidation.ok;
    var ok = Object.keys(checks).every(function (key) { return checks[key]; });
    return { ok: ok, checks: checks, areaSum: areaSum, chunks: chunkValidation };
  }

  /* ---------------- binary cache v1 ---------------- */

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    var encoded = unescape(encodeURIComponent(text));
    var out = new Uint8Array(encoded.length);
    for (var i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
    return out;
  }

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Bytes(bytes) {
    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var bitLength = bytes.length * 8;
    var paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
    var padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    var w = new Int32Array(64);
    for (var block = 0; block < paddedLength; block += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = view.getInt32(block + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (hh + sum1 + ch + SHA256_K[i] + w[i]) | 0;
        var sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (sum0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = new Uint8Array(32);
    var outView = new DataView(out.buffer);
    for (var j = 0; j < 8; j++) outView.setUint32(j * 4, h[j] >>> 0, false);
    return out;
  }

  var crc32cTables = null;
  function crc32c(bytes) {
    if (!crc32cTables) {
      var base = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var crc = n;
        for (var k = 0; k < 8; k++) crc = (crc & 1) ? (0x82f63b78 ^ (crc >>> 1)) : (crc >>> 1);
        base[n] = crc >>> 0;
      }
      crc32cTables = [base];
      for (var tableIndex = 1; tableIndex < 4; tableIndex++) {
        var prev = crc32cTables[tableIndex - 1];
        var table = new Uint32Array(256);
        for (n = 0; n < 256; n++) table[n] = (prev[n] >>> 8) ^ base[prev[n] & 0xff];
        crc32cTables.push(table);
      }
    }
    var t0 = crc32cTables[0], t1 = crc32cTables[1], t2 = crc32cTables[2], t3 = crc32cTables[3];
    var result = 0xffffffff;
    var i = 0;
    var limit = bytes.length - 3;
    for (; i < limit; i += 4) {
      result = t3[(result ^ bytes[i]) & 0xff] ^
        t2[((result >>> 8) ^ bytes[i + 1]) & 0xff] ^
        t1[((result >>> 16) ^ bytes[i + 2]) & 0xff] ^
        t0[((result >>> 24) ^ bytes[i + 3]) & 0xff];
    }
    for (; i < bytes.length; i++) {
      result = t0[(result ^ bytes[i]) & 0xff] ^ (result >>> 8);
    }
    return (result ^ 0xffffffff) >>> 0;
  }

  function normalizeCacheMeta(meta) {
    if (typeof meta === 'number') meta = { v: meta };
    meta = meta || {};
    return {
      addressSchema: String(meta.addressSchema || ADDRESS_SCHEMA),
      gridVersion: String(meta.gridVersion || GRID_VERSION),
      topologySchema: String(meta.topologySchema || TOPOLOGY_SCHEMA),
      v: meta.v
    };
  }

  function gridCacheMeta(input) {
    if (typeof input === 'number') return normalizeCacheMeta({ v: input });
    if (input && input.centers && Number.isInteger(input.v)) {
      return normalizeCacheMeta({
        addressSchema: input.addressSchema || ADDRESS_SCHEMA,
        gridVersion: input.gridVersion || GRID_VERSION,
        topologySchema: input.topologySchema || TOPOLOGY_SCHEMA,
        v: input.v
      });
    }
    return normalizeCacheMeta(input || {});
  }

  function gridCacheParamsHash(meta) {
    var canonical = normalizeCacheMeta(meta);
    if (!Number.isInteger(canonical.v) || canonical.v < 1) {
      throw new Error('GeodesicGrid grid cache: meta.v должно быть целым >= 1');
    }
    var digest = sha256Bytes(utf8Bytes(JSON.stringify(canonical)));
    return (((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0);
  }

  function align4(n) {
    return (n + 3) & ~3;
  }

  function cacheSections(grid) {
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
      { name: 'addrJ', array: grid.addrJ, kind: 'u16' }
    ];
  }

  function sectionElementSize(kind) {
    if (kind === 'u8') return 1;
    if (kind === 'u16') return 2;
    return 4;
  }

  var HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  function sectionHasCanonicalType(arr, kind) {
    return (kind === 'f32' && arr instanceof Float32Array) ||
      (kind === 'u32' && arr instanceof Uint32Array) ||
      (kind === 'i32' && arr instanceof Int32Array) ||
      (kind === 'u16' && arr instanceof Uint16Array) ||
      (kind === 'u8' && arr instanceof Uint8Array);
  }

  function writeSection(view, bytes, offset, section) {
    var arr = section.array;
    var byteLength = arr.length * sectionElementSize(section.kind);
    if (HOST_LITTLE_ENDIAN && sectionHasCanonicalType(arr, section.kind) && arr.byteLength === byteLength) {
      bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), offset);
      return align4(byteLength);
    }
    for (var i = 0; i < arr.length; i++) {
      if (section.kind === 'f32') view.setFloat32(offset + i * 4, arr[i], true);
      else if (section.kind === 'u32') view.setUint32(offset + i * 4, arr[i], true);
      else if (section.kind === 'i32') view.setInt32(offset + i * 4, arr[i], true);
      else if (section.kind === 'u16') view.setUint16(offset + i * 2, arr[i], true);
      else view.setUint8(offset + i, arr[i]);
    }
    return align4(arr.length * sectionElementSize(section.kind));
  }

  function serializeGridCache(grid, meta) {
    if (!grid || !Number.isInteger(grid.v)) throw new Error('GeodesicGrid.serializeGridCache: нет сетки');
    ensureChunks(grid);
    var canonical = normalizeCacheMeta(meta || gridCacheMeta(grid));
    if (canonical.v !== grid.v) throw new Error('GeodesicGrid.serializeGridCache: meta.v не совпадает с grid.v');
    var validation = validate(grid);
    if (!validation.ok) throw new Error('GeodesicGrid.serializeGridCache: сетка не прошла validate()');
    var sections = cacheSections(grid);
    var payloadLength = 32;
    sections.forEach(function (section) {
      if (!section.array) throw new Error('GeodesicGrid.serializeGridCache: отсутствует массив ' + section.name);
      payloadLength += align4(section.array.length * sectionElementSize(section.kind));
    });
    var buffer = new ArrayBuffer(CACHE_HEADER_LENGTH + payloadLength);
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    bytes[0] = 0x47; bytes[1] = 0x45; bytes[2] = 0x4f; bytes[3] = 0x00; // GEO\0
    view.setUint16(4, CACHE_FORMAT_VERSION, true);
    view.setUint16(6, 0, true);
    view.setUint32(8, CACHE_ENDIANNESS_MARKER, true);
    view.setUint32(12, gridCacheParamsHash(canonical), true);
    view.setUint32(16, CACHE_HEADER_LENGTH, true);
    view.setUint32(20, payloadLength, true);
    view.setUint32(28, grid.v, true);

    var payload = CACHE_HEADER_LENGTH;
    view.setUint32(payload + 0, 1, true); // payload layout v1
    view.setUint32(payload + 4, grid.v, true);
    view.setUint32(payload + 8, grid.cellCount, true);
    view.setUint32(payload + 12, grid.triangleCount, true);
    view.setUint32(payload + 16, grid.cellCorners.length, true);
    view.setUint32(payload + 20, typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0, true);
    view.setUint32(payload + 24, grid.chunkBlockSteps || CHUNK_BLOCK_STEPS, true);
    view.setUint32(payload + 28, 0, true);
    var offset = payload + 32;
    sections.forEach(function (section) {
      offset += writeSection(view, bytes, offset, section);
    });
    view.setUint32(24, crc32c(bytes.subarray(CACHE_HEADER_LENGTH)), true);
    return buffer;
  }

  function toUint8Array(input) {
    if (!input) return null;
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  function allocateSection(length, kind) {
    if (kind === 'f32') return new Float32Array(length);
    if (kind === 'u32') return new Uint32Array(length);
    if (kind === 'i32') return new Int32Array(length);
    if (kind === 'u16') return new Uint16Array(length);
    return new Uint8Array(length);
  }

  function readSection(view, inputBytes, offset, length, kind, limit) {
    var size = sectionElementSize(kind);
    var byteLength = length * size;
    if (offset < 0 || offset + byteLength > limit) throw new Error('section-out-of-range');
    var out;
    var i;
    if (HOST_LITTLE_ENDIAN) {
      out = allocateSection(length, kind);
      new Uint8Array(out.buffer).set(inputBytes.subarray(offset, offset + byteLength));
      return { array: out, nextOffset: offset + align4(byteLength) };
    }
    if (kind === 'f32') {
      out = new Float32Array(length);
      for (i = 0; i < length; i++) out[i] = view.getFloat32(offset + i * 4, true);
    } else if (kind === 'u32') {
      out = new Uint32Array(length);
      for (i = 0; i < length; i++) out[i] = view.getUint32(offset + i * 4, true);
    } else if (kind === 'i32') {
      out = new Int32Array(length);
      for (i = 0; i < length; i++) out[i] = view.getInt32(offset + i * 4, true);
    } else if (kind === 'u16') {
      out = new Uint16Array(length);
      for (i = 0; i < length; i++) out[i] = view.getUint16(offset + i * 2, true);
    } else {
      out = new Uint8Array(length);
      for (i = 0; i < length; i++) out[i] = view.getUint8(offset + i);
    }
    return { array: out, nextOffset: offset + align4(byteLength) };
  }

  function deserializeGridCache(input, expectedMeta) {
    try {
      var bytes = toUint8Array(input);
      if (!bytes || bytes.length < CACHE_HEADER_LENGTH + 32) return { ok: false, reason: 'too-small' };
      var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes[0] !== 0x47 || bytes[1] !== 0x45 || bytes[2] !== 0x4f || bytes[3] !== 0x00) {
        return { ok: false, reason: 'bad-magic' };
      }
      if (view.getUint16(4, true) !== CACHE_FORMAT_VERSION) return { ok: false, reason: 'unsupported-version' };
      if (view.getUint16(6, true) !== 0) return { ok: false, reason: 'unsupported-flags' };
      if (view.getUint32(8, true) !== CACHE_ENDIANNESS_MARKER) return { ok: false, reason: 'bad-endianness-marker' };
      if (view.getUint32(16, true) !== CACHE_HEADER_LENGTH) return { ok: false, reason: 'bad-header-length' };
      var payloadLength = view.getUint32(20, true);
      if (payloadLength !== bytes.length - CACHE_HEADER_LENGTH) return { ok: false, reason: 'length-mismatch' };
      var expected = normalizeCacheMeta(expectedMeta || {});
      var headerV = view.getUint32(28, true);
      if (Number.isInteger(expected.v) && expected.v !== headerV) return { ok: false, reason: 'v-mismatch' };
      if (!Number.isInteger(expected.v)) expected.v = headerV;
      if (view.getUint32(12, true) !== gridCacheParamsHash(expected)) {
        return { ok: false, reason: 'params-hash-mismatch' };
      }
      var payloadBytes = bytes.subarray(CACHE_HEADER_LENGTH);
      if (view.getUint32(24, true) !== crc32c(payloadBytes)) return { ok: false, reason: 'crc-mismatch' };

      var payload = CACHE_HEADER_LENGTH;
      if (view.getUint32(payload + 0, true) !== 1) return { ok: false, reason: 'unsupported-payload-layout' };
      var v = view.getUint32(payload + 4, true);
      var cellCount = view.getUint32(payload + 8, true);
      var triangleCount = view.getUint32(payload + 12, true);
      var cellCornersLength = view.getUint32(payload + 16, true);
      var bodyIndex = view.getUint32(payload + 20, true);
      var blockSteps = view.getUint32(payload + 24, true);
      if (v !== headerV || cellCount !== cellCountForFrequency(v) ||
          triangleCount !== triangleCountForFrequency(v) ||
          cellCornersLength !== 60 * v * v || blockSteps !== CHUNK_BLOCK_STEPS) {
        return { ok: false, reason: 'invalid-payload-header' };
      }

      var offset = payload + 32;
      var limit = bytes.length;
      var specs = [
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
        ['addrJ', cellCount, 'u16']
      ];
      var grid = {
        v: v,
        gridVersion: expected.gridVersion,
        addressSchema: expected.addressSchema,
        topologySchema: expected.topologySchema,
        chunkSchema: CHUNK_SCHEMA,
        chunkBlockSteps: blockSteps,
        bodyIndex: bodyIndex,
        cellCount: cellCount,
        triangleCount: triangleCount,
        pentagons: 0
      };
      specs.forEach(function (spec) {
        var read = readSection(view, bytes, offset, spec[1], spec[2], limit);
        grid[spec[0]] = read.array;
        offset = read.nextOffset;
      });
      if (offset !== limit) return { ok: false, reason: 'payload-size-mismatch' };
      for (var c = 0; c < cellCount; c++) if (grid.neighborCount[c] === 5) grid.pentagons++;
      attachChunks(grid);
      var validation = validate(grid);
      if (!validation.ok) return { ok: false, reason: 'validation-failed', validation: validation };
      return { ok: true, grid: grid };
    } catch (err) {
      return { ok: false, reason: 'invalid-payload', error: String((err && err.message) || err) };
    }
  }

  function loadGridWithCache(options) {
    options = options || {};
    var expectedMeta = normalizeCacheMeta(options.expectedMeta || {});
    var reason = 'cache-miss';
    var readPromise;
    try {
      readPromise = Promise.resolve(options.readCache ? options.readCache() : null);
    } catch (err) {
      readPromise = Promise.reject(err);
    }
    return readPromise.catch(function (err) {
      reason = 'cache-read-error';
      return null;
    }).then(function (bytes) {
      if (bytes) {
        var parsed = deserializeGridCache(bytes, expectedMeta);
        if (parsed.ok) return { grid: parsed.grid, source: 'cache' };
        reason = parsed.reason || reason;
      }
      return Promise.resolve(options.rebuildGrid ? options.rebuildGrid() : build(expectedMeta.v))
        .then(function (grid) {
          var done = { grid: grid, source: 'rebuilt', reason: reason };
          if (!options.writeCache) return done;
          var serialized;
          try {
            serialized = serializeGridCache(grid, expectedMeta);
          } catch (_) {
            return done;
          }
          return Promise.resolve(options.writeCache(serialized, grid))
            .catch(function () { return null; })
            .then(function () { return done; });
        });
    });
  }

  var api = {
    build: build,
    addressOf: addressOf,
    parseAddress: parseAddress,
    cellAtAddress: cellAtAddress,
    pick: pick,
    pickBruteForce: pickBruteForce,
    getChunks: getChunks,
    getChunkNeighbors: getChunkNeighbors,
    validate: validate,
    validateChunks: validateChunks,
    attachChunks: attachChunks,
    cellCountForFrequency: cellCountForFrequency,
    triangleCountForFrequency: triangleCountForFrequency,
    frequencyForRadius: frequencyForRadius,
    meanCellAreaKm2: meanCellAreaKm2,
    meanCellEdgeKm: meanCellEdgeKm,
    gridCacheMeta: gridCacheMeta,
    gridCacheParamsHash: gridCacheParamsHash,
    serializeGridCache: serializeGridCache,
    deserializeGridCache: deserializeGridCache,
    loadGridWithCache: loadGridWithCache,
    crc32c: crc32c,
    GRID_VERSION: GRID_VERSION,
    ADDRESS_SCHEMA: ADDRESS_SCHEMA,
    TOPOLOGY_SCHEMA: TOPOLOGY_SCHEMA,
    CHUNK_SCHEMA: CHUNK_SCHEMA,
    CHUNK_BLOCK_STEPS: CHUNK_BLOCK_STEPS,
    CHUNK_MIN_CELLS: CHUNK_MIN_CELLS,
    CHUNK_MAX_CELLS: CHUNK_MAX_CELLS,
    EARTH_RADIUS_KM: EARTH_RADIUS_KM,
    EARTH_CANONICAL_V: EARTH_CANONICAL_V,
    CACHE_FORMAT_VERSION: CACHE_FORMAT_VERSION
  };
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GeodesicGrid = api;
})(typeof window !== 'undefined' ? window : globalThis);
