/* GeodesicGrid — геодезическая сетка Голдберга GP(v,0) на единичной сфере.
   =========================================================================
   СПАЙК ЭТАПА 1. Модуль проверяет саму возможность собственной топологии:
   подразделение икосаэдра с произвольной частотой v, двойственные ячейки
   (12 пятиугольников, остальные — шестиугольники), соседи, площади и
   черновые стабильные адреса ячеек.

   ПОСТРОЕНИЕ
     1) 20 граней икосаэдра находятся по вершинам: тройки вершин на
        минимальном попарном расстоянии, ориентация — наружу.
     2) Каждая грань делится барицентрической решёткой на v² треугольников;
        вершины проецируются на единичную сферу и склеиваются по округлённой
        координате (соседние грани дают одни и те же точки с точностью до
        плавающей арифметики, шаг решётки на много порядков больше).
     3) Ячейка ячейки Голдберга — многоугольник вокруг вершины триангуляции:
        его углы — центроиды инцидентных треугольников, упорядоченные по
        полярному углу в касательной плоскости центра.
     4) Площадь ячейки — сумма сферических площадей веера из первого угла
        (формула через atan2 от скалярного тройного произведения).

   АДРЕС ЯЧЕЙКИ (черновик v0): goldberg-gp-v0/w<тело>/v<частота>/f<грань>/a<i>/b<j>,
   где w — резерв сегмента тела под будущий кластер (осколки планеты): пока
   всегда w0, одно тело, трёхуровневый сетап не учитывается (парковка в
   docs/stages/stage_patches.md). Грань и барицентрические координаты —
   первое появление вершины при обходе граней в фиксированном порядке. Порядок граней детерминирован
   построением (тройки в лексикографическом порядке индексов вершин), поэтому
   адрес воспроизводим между запусками одной версии. Финальную канонизацию
   рёберных вершин предстоит зафиксировать на Этапе 3.

   API
     var grid = GeodesicGrid.build(v);        // v >= 1, целое
       grid.cellCount                          // 10v²+2
       grid.triangleCount                      // 20v²
       grid.centers    Float32Array(3F)        // направления центров ячеек
       grid.corners    Float32Array(3T)        // углы ячеек (центроиды треугольников)
       grid.triangles  Uint32Array(3T)         // исходная триангуляция (индексы центров)
       grid.cellCornerStart Uint32Array(F+1)   // начало углов ячейки в cellCorners
       grid.cellCorners     Uint32Array        // индексы углов по ячейкам, по кругу
       grid.neighbors  Int32Array(6F)          // соседи, -1 — пусто (пятиугольники)
       grid.neighborCount Uint8Array(F)        // 5 или 6
       grid.areas      Float32Array(F)         // сферическая площадь, сумма = 4π
       grid.pentagons                          // всегда 12 при v >= 1
       grid.bodyIndex                          // резерв: номер тела в кластере, пока 0
     GeodesicGrid.addressOf(grid, cell)        // строка адреса
     GeodesicGrid.pick(grid, dir)              // ближайшая ячейка: полный перебор (спайк)
     GeodesicGrid.validate(grid)               // {ok, checks:{...}} для тестов

   В браузере модуль вешает window.GeodesicGrid, в Node — module.exports
   (tools/check_planet_spike.mjs гоняет ядро без DOM). */
(function (root) {
  'use strict';

  function normalize3(x, y, z, out) {
    var len = Math.sqrt(x * x + y * y + z * z) || 1;
    out[0] = x / len; out[1] = y / len; out[2] = z / len;
    return out;
  }

  function icosahedron() {
    var t = (1 + Math.sqrt(5)) / 2;
    var raw = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ];
    var verts = raw.map(function (p) { return normalize3(p[0], p[1], p[2], [0, 0, 0]); });
    // Минимальное попарное расстояние — длина ребра.
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
      // Ориентация наружу: нормаль (b-a)×(c-a) смотрит от центра.
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var outward = nx * (a[0] + b[0] + c[0]) + ny * (a[1] + b[1] + c[1]) + nz * (a[2] + b[2] + c[2]);
      faces.push(outward > 0 ? [i, j, k] : [i, k, j]);
    }
    return { verts: verts, faces: faces };
  }

  // Сферическая площадь треугольника по трём единичным векторам (со знаком).
  function sphericalTriangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
    var triple = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    var denom = 1 + (ax * bx + ay * by + az * bz) + (bx * cx + by * cy + bz * cz) + (cx * ax + cy * ay + cz * az);
    return 2 * Math.atan2(triple, denom);
  }

  function build(v) {
    if (!Number.isInteger(v) || v < 1) throw new Error('GeodesicGrid.build: v должно быть целым >= 1');
    var ico = icosahedron();
    var verts = [];               // плоский массив направлений вершин триангуляции
    var addrFace = [], addrI = [], addrJ = [];
    var byKey = new Map();
    var tmp = [0, 0, 0];

    function getVertex(x, y, z, face, i, j) {
      normalize3(x, y, z, tmp);
      var key = tmp[0].toFixed(9) + ',' + tmp[1].toFixed(9) + ',' + tmp[2].toFixed(9);
      var found = byKey.get(key);
      if (found !== undefined) return found;
      var id = verts.length / 3;
      verts.push(tmp[0], tmp[1], tmp[2]);
      addrFace.push(face); addrI.push(i); addrJ.push(j);
      byKey.set(key, id);
      return id;
    }

    var tris = [];
    ico.faces.forEach(function (faceIdx, faceNo) {
      var A = ico.verts[faceIdx[0]], B = ico.verts[faceIdx[1]], C = ico.verts[faceIdx[2]];
      var local = new Map();
      function P(i, j) {
        var key = i + ',' + j;
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
          tris.push(P(i, j), P(i + 1, j), P(i, j + 1));
          if (i + j < v - 1) tris.push(P(i + 1, j), P(i + 1, j + 1), P(i, j + 1));
        }
      }
    });

    var cellCount = verts.length / 3;
    var triangleCount = tris.length / 3;
    var centers = new Float32Array(verts);
    var triangles = new Uint32Array(tris);

    // Углы ячеек — центроиды треугольников, спроецированные на сферу.
    var corners = new Float32Array(triangleCount * 3);
    var incident = new Array(cellCount);
    var c;
    for (c = 0; c < cellCount; c++) incident[c] = [];
    for (var t = 0; t < triangleCount; t++) {
      var a = triangles[t * 3], b = triangles[t * 3 + 1], d = triangles[t * 3 + 2];
      normalize3(
        centers[a * 3] + centers[b * 3] + centers[d * 3],
        centers[a * 3 + 1] + centers[b * 3 + 1] + centers[d * 3 + 1],
        centers[a * 3 + 2] + centers[b * 3 + 2] + centers[d * 3 + 2],
        tmp
      );
      corners[t * 3] = tmp[0]; corners[t * 3 + 1] = tmp[1]; corners[t * 3 + 2] = tmp[2];
      incident[a].push(t); incident[b].push(t); incident[d].push(t);
    }

    // Соседи — по рёбрам триангуляции.
    var neighborSets = new Array(cellCount);
    for (c = 0; c < cellCount; c++) neighborSets[c] = new Set();
    for (t = 0; t < triangleCount; t++) {
      var x = triangles[t * 3], y = triangles[t * 3 + 1], z = triangles[t * 3 + 2];
      neighborSets[x].add(y); neighborSets[x].add(z);
      neighborSets[y].add(x); neighborSets[y].add(z);
      neighborSets[z].add(x); neighborSets[z].add(y);
    }

    var neighbors = new Int32Array(cellCount * 6).fill(-1);
    var neighborCount = new Uint8Array(cellCount);
    var pentagons = 0;
    for (c = 0; c < cellCount; c++) {
      var list = Array.from(neighborSets[c]).sort(function (p, q) { return p - q; });
      neighborCount[c] = list.length;
      if (list.length === 5) pentagons++;
      for (var n = 0; n < list.length; n++) neighbors[c * 6 + n] = list[n];
    }

    // Углы каждой ячейки по кругу + площадь.
    var cellCornerStart = new Uint32Array(cellCount + 1);
    var flatCorners = [];
    var areas = new Float32Array(cellCount);
    for (c = 0; c < cellCount; c++) {
      cellCornerStart[c] = flatCorners.length;
      var cx = centers[c * 3], cy = centers[c * 3 + 1], cz = centers[c * 3 + 2];
      // Касательный базис: t1 ⟂ центру, t2 = центр × t1.
      var ax = Math.abs(cx) < 0.9 ? 1 : 0, ay = Math.abs(cx) < 0.9 ? 0 : 1;
      var t1 = normalize3(cy * 0 - cz * ay, cz * ax - cx * 0, cx * ay - cy * ax, [0, 0, 0]);
      var t2 = [cy * t1[2] - cz * t1[1], cz * t1[0] - cx * t1[2], cx * t1[1] - cy * t1[0]];
      var ring = incident[c].slice().sort(function (p, q) {
        var ap = Math.atan2(
          corners[p * 3] * t2[0] + corners[p * 3 + 1] * t2[1] + corners[p * 3 + 2] * t2[2],
          corners[p * 3] * t1[0] + corners[p * 3 + 1] * t1[1] + corners[p * 3 + 2] * t1[2]);
        var aq = Math.atan2(
          corners[q * 3] * t2[0] + corners[q * 3 + 1] * t2[1] + corners[q * 3 + 2] * t2[2],
          corners[q * 3] * t1[0] + corners[q * 3 + 1] * t1[1] + corners[q * 3 + 2] * t1[2]);
        return ap - aq;
      });
      var area = 0;
      for (var k = 1; k + 1 < ring.length; k++) {
        var p0 = ring[0] * 3, p1 = ring[k] * 3, p2 = ring[k + 1] * 3;
        area += sphericalTriangleArea(
          corners[p0], corners[p0 + 1], corners[p0 + 2],
          corners[p1], corners[p1 + 1], corners[p1 + 2],
          corners[p2], corners[p2 + 1], corners[p2 + 2]);
      }
      if (area < 0) { ring.reverse(); area = -area; }
      areas[c] = area;
      for (k = 0; k < ring.length; k++) flatCorners.push(ring[k]);
    }
    cellCornerStart[cellCount] = flatCorners.length;

    return {
      v: v,
      bodyIndex: 0, // резерв сегмента тела w в адресе; кластеров пока нет
      cellCount: cellCount,
      triangleCount: triangleCount,
      centers: centers,
      corners: corners,
      triangles: triangles,
      cellCornerStart: cellCornerStart,
      cellCorners: new Uint32Array(flatCorners),
      neighbors: neighbors,
      neighborCount: neighborCount,
      areas: areas,
      pentagons: pentagons,
      addrFace: new Uint16Array(addrFace),
      addrI: new Uint16Array(addrI),
      addrJ: new Uint16Array(addrJ)
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function addressOf(grid, cell) {
    var w = typeof grid.bodyIndex === 'number' ? grid.bodyIndex : 0;
    return 'goldberg-gp-v0/w' + w + '/v' + grid.v + '/f' + pad2(grid.addrFace[cell]) +
      '/a' + grid.addrI[cell] + '/b' + grid.addrJ[cell];
  }

  // Спайковый поиск: полный перебор центров. Для v=64 это 40 962 скалярных
  // произведений — приемлемо для прототипа; ускорение по граням — Этап 3.
  function pick(grid, dir) {
    var centers = grid.centers;
    var best = -1, bestDot = -Infinity;
    for (var c = 0; c < grid.cellCount; c++) {
      var dot = centers[c * 3] * dir[0] + centers[c * 3 + 1] * dir[1] + centers[c * 3 + 2] * dir[2];
      if (dot > bestDot) { bestDot = dot; best = c; }
    }
    return best;
  }

  function validate(grid) {
    var v = grid.v;
    var checks = {};
    checks.cellCount = grid.cellCount === 10 * v * v + 2;
    checks.triangleCount = grid.triangleCount === 20 * v * v;
    checks.pentagons = grid.pentagons === 12;
    var areaSum = 0, bad = 0;
    for (var c = 0; c < grid.cellCount; c++) {
      areaSum += grid.areas[c];
      if (!(grid.areas[c] > 0) || !Number.isFinite(grid.centers[c * 3])) bad++;
      if (grid.neighborCount[c] !== 5 && grid.neighborCount[c] !== 6) bad++;
    }
    checks.areaSum = Math.abs(areaSum - 4 * Math.PI) < 1e-3;
    checks.finite = bad === 0;
    var symmetric = true;
    outer:
    for (c = 0; c < grid.cellCount; c++) {
      for (var n = 0; n < grid.neighborCount[c]; n++) {
        var nb = grid.neighbors[c * 6 + n];
        var back = false;
        for (var m = 0; m < grid.neighborCount[nb]; m++) {
          if (grid.neighbors[nb * 6 + m] === c) { back = true; break; }
        }
        if (!back) { symmetric = false; break outer; }
      }
    }
    checks.neighborsSymmetric = symmetric;
    var addr = new Set();
    for (c = 0; c < grid.cellCount; c++) addr.add(grid.addrFace[c] + ',' + grid.addrI[c] + ',' + grid.addrJ[c] + ',' +
      Math.round(grid.centers[c * 3] * 1e7) + ',' + Math.round(grid.centers[c * 3 + 1] * 1e7));
    checks.noDuplicateCenters = addr.size === grid.cellCount;
    var ok = Object.keys(checks).every(function (k) { return checks[k]; });
    return { ok: ok, checks: checks, areaSum: areaSum };
  }

  var api = { build: build, addressOf: addressOf, pick: pick, validate: validate };
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.GeodesicGrid = api;
})(typeof window !== 'undefined' ? window : globalThis);
