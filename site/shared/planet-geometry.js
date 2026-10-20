/* PlanetGeometry — чистые массивы геометрии спайка /planet-test/.
   Модуль не знает про DOM и WebGL: он превращает сетку Голдберга, поля
   планеты и параметры осколков в типизированные массивы поверхности и
   объёма. Один и тот же код используют главный поток (fallback/прокси и
   пересборка по ползункам осколков) и Web Worker (фоновая подготовка
   LOD/новой планеты, пока текущий кадр или каскад загрузки остаётся на
   экране). Заливка этих массивов в GPU и кэш VAO остаются на странице. */
(function (root) {
  'use strict';

  function mix3(a, b, t, out) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function smooth(a, b, x) {
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }

  var COL = {
    deepOcean: [0.008, 0.05, 0.16],
    shelf: [0.06, 0.42, 0.52],
    coast: [0.12, 0.58, 0.62],
    ice: [0.84, 0.91, 0.96],
    tundra: [0.52, 0.58, 0.52],
    desert: [0.74, 0.59, 0.30],
    plains: [0.44, 0.56, 0.24],
    forest: [0.10, 0.42, 0.20],
    rock: [0.43, 0.41, 0.39],
    snow: [0.95, 0.97, 1.0]
  };

  function biomeColor(e, sea, minE, maxE, moist, temp, out) {
    if (e <= sea) {
      var depth = clamp01((sea - e) / Math.max(1e-6, sea - minE));
      mix3(COL.coast, COL.shelf, smooth(0, 0.15, depth), out);
      mix3(out, COL.deepOcean, smooth(0.12, 0.75, depth), out);
      if (temp < 0.14) mix3(out, COL.ice, (0.14 - temp) / 0.14 * 0.85, out);
      return out;
    }
    var landH = clamp01((e - sea) / Math.max(1e-6, maxE - sea));
    // База: пустыня → равнина → лес по влажности.
    mix3(COL.desert, COL.plains, smooth(0.28, 0.48, moist), out);
    mix3(out, COL.forest, smooth(0.55, 0.78, moist), out);
    // Холод: тундра и лёд.
    mix3(out, COL.tundra, smooth(0.38, 0.22, temp), out);
    mix3(out, COL.ice, smooth(0.20, 0.08, temp), out);
    // Высота: скалы и снег.
    mix3(out, COL.rock, smooth(0.68, 0.9, landH) * 0.85, out);
    mix3(out, COL.snow, smooth(0.9, 1.0, landH), out);
    return out;
  }

  function buildCellData(fields, PlanetNoise) {
    var F = fields.elev.length;
    var colors = new Float32Array(F * 3);
    var rgb = [0, 0, 0];
    var c;
    for (c = 0; c < F; c++) {
      biomeColor(fields.elev[c], fields.sea, fields.minE, fields.maxE,
        fields.moist[c], fields.temp[c], rgb);
      colors[c * 3] = rgb[0]; colors[c * 3 + 1] = rgb[1]; colors[c * 3 + 2] = rgb[2];
    }

    var fieldCells = new Uint8Array(F * 4);
    for (c = 0; c < F; c++) {
      var relief;
      if (fields.elev[c] <= fields.sea) {
        relief = -clamp01((fields.sea - fields.elev[c]) /
          Math.max(1e-6, fields.sea - fields.minE));
      } else {
        relief = clamp01((fields.elev[c] - fields.sea) /
          Math.max(1e-6, fields.maxE - fields.sea));
      }
      fieldCells[c * 4] = Math.round((relief * 0.5 + 0.5) * 255);
      fieldCells[c * 4 + 1] = Math.round(clamp01(fields.moist[c]) * 255);
      fieldCells[c * 4 + 2] = Math.round(clamp01(fields.temp[c]) * 255);
      fieldCells[c * 4 + 3] =
        PlanetNoise.hash32(((fields.masterSeed >>> 0) ^ Math.imul(c + 1, 0x9E3779B1)) >>> 0) >>> 24;
    }

    return {
      colors: colors,
      fieldCells: fieldCells,
      texSeed: [
        PlanetNoise.hash32(((fields.masterSeed >>> 0) ^ 0xA53A9DBD) >>> 0) / 4294967296 * 64,
        PlanetNoise.hash32(((fields.masterSeed >>> 0) ^ 0x5F356495) >>> 0) / 4294967296 * 64,
        PlanetNoise.hash32(((fields.masterSeed >>> 0) ^ 0x1B873593) >>> 0) / 4294967296 * 64
      ]
    };
  }

  function cellBirth(centerY, cellIndex) {
    var lat01 = (1 - centerY) / 2;
    var h = Math.sin(cellIndex * 127.1) * 43758.5453;
    var jitter = (h - Math.floor(h) - 0.5) * 0.07;
    var b = lat01 * 0.74 + jitter;
    return b < 0 ? 0 : b > 0.78 ? 0.78 : b;
  }
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var shardLayoutCache = new Map();

  function buildShardTexture(layout, sp) {
    if (!layout) return { data: null, shardInfo: null, shardMaxB: 0 };
    var shardInfo = {
      count: layout.count,
      nonEmpty: layout.nonEmpty,
      counts: layout.counts.slice(),
      lost: 0
    };
    var lost = new Uint8Array(layout.count);
    if (sp.loss > 0) {
      var order = [];
      for (var oi = 0; oi < layout.count; oi++) {
        if (layout.counts[oi] > 0) order.push(oi);
      }
      order.sort(function (a, b) { return layout.counts[a] - layout.counts[b]; });
      var lostCount = Math.min(Math.max(0, order.length - 1),
        Math.round(order.length * sp.loss * 0.35));
      for (var li = 0; li < lostCount; li++) lost[order[li]] = 1;
      shardInfo.lost = lostCount;
    }

    var texData = new Float32Array(64 * 4 * 4);
    var shardMaxB = 0;
    for (var si = 0; si < layout.count; si++) {
      var pa = 1, pb = 0;
      if (lost[si]) { pa = 1.35; pb = 0.75; }
      else if (layout.counts[si] > 0 && layout.counts[si] < 12) pa = 1 + sp.loss * 0.8;
      if (pb > shardMaxB) shardMaxB = pb;
      texData.set([layout.pivots[si * 3], layout.pivots[si * 3 + 1], layout.pivots[si * 3 + 2], 0], si * 4);
      texData.set([layout.axes[si * 3], layout.axes[si * 3 + 1], layout.axes[si * 3 + 2], 0], (64 + si) * 4);
      texData.set([layout.driftVec[si * 3], layout.driftVec[si * 3 + 1], layout.driftVec[si * 3 + 2], 0], (128 + si) * 4);
      texData.set([layout.spin[si], pa, pb, 0], (192 + si) * 4);
    }
    return { data: texData, shardInfo: shardInfo, shardMaxB: shardMaxB };
  }

  function computeShardLayout(grid, sp, PlanetNoise) {
    if (!(sp.count > 1)) return null;
    var key = grid.v + '|' + sp.count + '|' + sp.dist + '|' + sp.seedText;
    var cachedLayout = shardLayoutCache.get(key);
    if (cachedLayout) {
      shardLayoutCache.delete(key);
      shardLayoutCache.set(key, cachedLayout);
      return cachedLayout;
    }
    var K = sp.count;
    var rnd = mulberry32(PlanetNoise.stringSeed(sp.seedText + ':shards'));
    var centers = new Float32Array(K * 3);
    var sizes = new Float32Array(K);
    var i;
    if (sp.dist === 'equal') {
      var golden = Math.PI * (3 - Math.sqrt(5));
      for (i = 0; i < K; i++) {
        var y = K === 1 ? 0 : 1 - (i / (K - 1)) * 2;
        var r = Math.sqrt(Math.max(0, 1 - y * y));
        var th = golden * i;
        centers[i * 3] = Math.cos(th) * r;
        centers[i * 3 + 1] = y;
        centers[i * 3 + 2] = Math.sin(th) * r;
        sizes[i] = 1;
      }
    } else {
      for (i = 0; i < K; i++) {
        var z = rnd() * 2 - 1;
        var ph = rnd() * Math.PI * 2;
        var rr = Math.sqrt(Math.max(0, 1 - z * z));
        centers[i * 3] = Math.cos(ph) * rr;
        centers[i * 3 + 1] = z;
        centers[i * 3 + 2] = Math.sin(ph) * rr;
        if (sp.dist === 'power') {
          // Парето, α=1.3: пара крупных осколков и много мелочи — как при дроблении.
          sizes[i] = Math.pow(1 - rnd() * 0.999, -1 / 1.3);
        } else {
          // Логнормальная, σ=0.8: плавный разброс без тяжёлого хвоста.
          var g = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(rnd() * Math.PI * 2);
          sizes[i] = Math.exp(0.8 * g);
        }
      }
    }
    var sum = 0;
    for (i = 0; i < K; i++) sum += sizes[i];
    var rho2 = new Float32Array(K);
    for (i = 0; i < K; i++) {
      var frac = Math.min(0.9, sizes[i] / sum);
      var rho = Math.acos(1 - 2 * frac);
      rho2[i] = Math.max(1e-8, rho * rho);
    }
    var F = grid.cellCount;
    var shardOf = new Uint16Array(F);
    var counts = new Uint32Array(K);
    var cent = new Float64Array(K * 3);
    for (var c = 0; c < F; c++) {
      var cx = grid.centers[c * 3], cy = grid.centers[c * 3 + 1], cz = grid.centers[c * 3 + 2];
      var best = 0, bestScore = Infinity;
      for (i = 0; i < K; i++) {
        var dot = cx * centers[i * 3] + cy * centers[i * 3 + 1] + cz * centers[i * 3 + 2];
        var score = (1 - dot) / rho2[i];
        if (score < bestScore) { bestScore = score; best = i; }
      }
      shardOf[c] = best;
      counts[best]++;
      cent[best * 3] += cx; cent[best * 3 + 1] += cy; cent[best * 3 + 2] += cz;
    }
    var pivots = new Float32Array(K * 3);
    var axes = new Float32Array(K * 3);
    var driftVec = new Float32Array(K * 3);
    var spin = new Float32Array(K);
    var nonEmpty = 0;
    for (i = 0; i < K; i++) {
      spin[i] = (rnd() * 2 - 1) * 0.7;
      var px = cent[i * 3], py = cent[i * 3 + 1], pz = cent[i * 3 + 2];
      var pl = Math.sqrt(px * px + py * py + pz * pz);
      if (counts[i] > 0 && pl > 1e-9) {
        nonEmpty++;
        pivots[i * 3] = px / pl; pivots[i * 3 + 1] = py / pl; pivots[i * 3 + 2] = pz / pl;
      } else {
        pivots[i * 3] = centers[i * 3]; pivots[i * 3 + 1] = centers[i * 3 + 1]; pivots[i * 3 + 2] = centers[i * 3 + 2];
      }
      var ax = rnd() * 2 - 1, ay = rnd() * 2 - 1, az = rnd() * 2 - 1;
      var gx = pivots[i * 3 + 1] * az - pivots[i * 3 + 2] * ay;
      var gy = pivots[i * 3 + 2] * ax - pivots[i * 3] * az;
      var gz = pivots[i * 3] * ay - pivots[i * 3 + 1] * ax;
      var gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (gl < 1e-6) { gx = 1; gy = 0; gz = 0; gl = 1; }
      axes[i * 3] = gx / gl; axes[i * 3 + 1] = gy / gl; axes[i * 3 + 2] = gz / gl;
      var actualFrac = counts[i] / F;
      var sizeFactor = actualFrac > 0
        ? Math.min(1.9, Math.max(0.7, Math.pow((1 / K) / actualFrac, 0.18))) : 1.5;
      var radial = (0.5 + rnd() * 0.9) * sizeFactor;
      var tx = rnd() * 2 - 1, ty = rnd() * 2 - 1, tz = rnd() * 2 - 1;
      var tdot = tx * pivots[i * 3] + ty * pivots[i * 3 + 1] + tz * pivots[i * 3 + 2];
      tx -= tdot * pivots[i * 3]; ty -= tdot * pivots[i * 3 + 1]; tz -= tdot * pivots[i * 3 + 2];
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
      var tang = 0.35 * rnd() * sizeFactor;
      driftVec[i * 3] = pivots[i * 3] * radial + (tx / tl) * tang;
      driftVec[i * 3 + 1] = pivots[i * 3 + 1] * radial + (ty / tl) * tang;
      driftVec[i * 3 + 2] = pivots[i * 3 + 2] * radial + (tz / tl) * tang;
    }
    var layout = {
      shardOf: shardOf, counts: counts, pivots: pivots, axes: axes,
      driftVec: driftVec, spin: spin, count: K, nonEmpty: nonEmpty
    };
    shardLayoutCache.set(key, layout);
    while (shardLayoutCache.size > 4) {
      shardLayoutCache.delete(shardLayoutCache.keys().next().value);
    }
    return layout;
  }
  function sideNeighbor(grid, c, t1, t2) {
    var other = -1;
    for (var i = 0; i < 3; i++) {
      var a = grid.triangles[t1 * 3 + i];
      for (var j = 0; j < 3; j++) {
        if (a === grid.triangles[t2 * 3 + j] && a !== c) other = a;
      }
    }
    return other;
  }
  function buildVolumeArrays(grid, layout, sp, surfPos, birthArr, PlanetNoise) {
    if (!layout) return null;
    var F = grid.cellCount;
    var thickEff = sp.thick * (1 - 0.45 * sp.loss);
    var fracNoise = PlanetNoise.makeNoise('simplex',
      PlanetNoise.hash32(PlanetNoise.stringSeed(sp.seedText + ':fracture')));
    var pos = [], col = [], emi = [], cen = [], bir = [], shr = [], kind = [], idx = [];
    var c, n, k;

    var isBoundary = new Uint8Array(F);
    for (c = 0; c < F; c++) {
      for (n = 0; n < grid.neighborCount[c]; n++) {
        if (layout.shardOf[grid.neighbors[c * 6 + n]] !== layout.shardOf[c]) { isBoundary[c] = 1; break; }
      }
    }

    function shadeAt(x, y, z) {
      return 0.85 + 0.3 * (0.5 + 0.5 * fracNoise(x * 21 - 3.7, y * 21 + 8.9, z * 21 + 1.3));
    }

    // Единая глубина нижней поверхности для стены, центров и углов: одинаковая
    // функция исходного направления не даёт щелей между кусками оболочки.
    // bottomNoise01 переиспользуется для оттенка/нагрева низа, чтобы не
    // платить три вызова шума на каждую из десятков тысяч вершин оболочки.
    var bottomNoise01 = 0.5;
    function bottomRadius(x, y, z) {
      bottomNoise01 =
        0.5 + 0.5 * fracNoise(x * 9 + 1.9, y * 9 + 5.5, z * 9 - 6.2);
      return 1 - thickEff * (0.65 + 0.55 * bottomNoise01);
    }

    function pushVert(ox, oy, oz, s, cell, r, g, b, e, kindFlag) {
      var o = pos.length;
      pos.push(ox, oy, oz);
      col.push(r, g, b);
      emi.push(e);
      shr.push(s);
      kind.push(kindFlag || 0);
      cen.push(surfPos[cell * 3], surfPos[cell * 3 + 1], surfPos[cell * 3 + 2]);
      bir.push(birthArr[cell]);
      return o / 3;
    }

    function pushBottomVert(x, y, z, s, cell, knownRadius) {
      var rr = knownRadius === undefined ? bottomRadius(x, y, z) : knownRadius;
      var shade = 0.80 + 0.38 * bottomNoise01;
      // Низ — преимущественно тёмная порода с горячими пятнами, а не сплошная
      // лавовая плёнка: иначе эмиссия забивает гранёную геометрию. Глубже
      // участок оболочки — в среднем горячее.
      var heat = 0.08 + 0.30 * bottomNoise01 * bottomNoise01;
      return pushVert(x * rr, y * rr, z * rr, s, cell,
        0.105 * shade, 0.064 * shade, 0.048 * shade, heat, 1);
    }

    var bottomCenterIndex = new Int32Array(F).fill(-1);
    function bottomCenterOf(cell) {
      if (bottomCenterIndex[cell] >= 0) return bottomCenterIndex[cell];
      var vi = pushBottomVert(
        grid.centers[cell * 3], grid.centers[cell * 3 + 1], grid.centers[cell * 3 + 2],
        layout.shardOf[cell], cell);
      bottomCenterIndex[cell] = vi;
      return vi;
    }

    function bottomCornerOf(t, s, anchorCell) {
      return pushBottomVert(
        grid.corners[t * 3], grid.corners[t * 3 + 1], grid.corners[t * 3 + 2],
        s, anchorCell);
    }

    // Внутренняя часть низа: один треугольник центров на первичную ячейку
    // триангуляции. В смешанном треугольнике пара ячеек одного шарда
    // доводится до общего угла; оставшуюся приграничную часть закроют веера
    // граничных сторон ниже. Ориентация обратная верхней поверхности.
    for (var t = 0; t < grid.triangleCount; t++) {
      var ta = grid.triangles[t * 3];
      var tb = grid.triangles[t * 3 + 1];
      var tc = grid.triangles[t * 3 + 2];
      var sa = layout.shardOf[ta];
      var sb = layout.shardOf[tb];
      var sc = layout.shardOf[tc];
      if (sa === sb && sb === sc) {
        idx.push(bottomCenterOf(ta), bottomCenterOf(tc), bottomCenterOf(tb));
      } else {
        if (sa === sb) idx.push(bottomCenterOf(ta), bottomCornerOf(t, sa, ta), bottomCenterOf(tb));
        if (sb === sc) idx.push(bottomCenterOf(tb), bottomCornerOf(t, sb, tb), bottomCenterOf(tc));
        if (sc === sa) idx.push(bottomCenterOf(tc), bottomCornerOf(t, sc, tc), bottomCenterOf(ta));
      }
    }

    var SEG = 3;
    for (c = 0; c < F; c++) {
      if (!isBoundary[c]) continue;
      var s = layout.shardOf[c];
      var start = grid.cellCornerStart[c];
      var sides = grid.cellCornerStart[c + 1] - start;
      for (k = 0; k < sides; k++) {
        var t1 = grid.cellCorners[start + k];
        var t2 = grid.cellCorners[start + ((k + 1) % sides)];
        var nb = sideNeighbor(grid, c, t1, t2);
        if (nb < 0 || layout.shardOf[nb] === s) continue;
        var ax = grid.corners[t1 * 3], ay = grid.corners[t1 * 3 + 1], az = grid.corners[t1 * 3 + 2];
        var bx = grid.corners[t2 * 3], by = grid.corners[t2 * 3 + 1], bz = grid.corners[t2 * 3 + 2];
        var ex = bx - ax, ey = by - ay, ez = bz - az;
        var edgeLen = Math.sqrt(ex * ex + ey * ey + ez * ez);
        var prevTop = -1, prevBot = -1;
        var sideBottom = [];
        for (var j = 0; j <= SEG; j++) {
          var tt = j / SEG;
          var px = ax + ex * tt, py = ay + ey * tt, pz = az + ez * tt;
          var pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
          px /= pl; py /= pl; pz /= pl;
          if (j > 0 && j < SEG && sp.jag > 0) {
            var tx = py * ez - pz * ey, ty = pz * ex - px * ez, tz = px * ey - py * ex;
            var tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
            var off = fracNoise(px * 13 + 7.3, py * 13 - 2.1, pz * 13 + 4.7) *
              sp.jag * Math.sin(Math.PI * tt) * edgeLen * 0.45;
            px += (tx / tl) * off; py += (ty / tl) * off; pz += (tz / tl) * off;
            pl = Math.sqrt(px * px + py * py + pz * pz) || 1;
            px /= pl; py /= pl; pz /= pl;
          }
          var shade = shadeAt(px, py, pz);
          var rr2 = bottomRadius(px, py, pz);
          var topIdx = pushVert(px, py, pz, s, c, 0.23 * shade, 0.145 * shade, 0.09 * shade, 0.03);
          var botIdx = pushVert(px * rr2, py * rr2, pz * rr2, s, c,
            0.075 * shade, 0.05 * shade, 0.045 * shade, 0.85);
          sideBottom.push(pushBottomVert(px, py, pz, s, c, rr2));
          if (prevTop >= 0) {
            idx.push(prevTop, topIdx, botIdx, prevTop, botIdx, prevBot);
          }
          prevTop = topIdx; prevBot = botIdx;
        }
        // Локальное закрытие именно этой стороны: короткий веер в пределах
        // одной ячейки, без лучей через весь осколок.
        var bottomCenter = bottomCenterOf(c);
        for (j = 0; j < SEG; j++) {
          idx.push(bottomCenter, sideBottom[j + 1], sideBottom[j]);
        }
      }
    }
    if (!idx.length) return null;
    return {
      positions: new Float32Array(pos),
      colors: new Float32Array(col),
      emissive: new Float32Array(emi),
      centers: new Float32Array(cen),
      birth: new Float32Array(bir),
      shard: new Float32Array(shr),
      kind: new Float32Array(kind),
      indices: new Uint32Array(idx),
      indexCount: idx.length
    };
  }

  function buildSurfaceArrays(grid, cellData, layout) {
    var F = grid.cellCount;
    var totalSides = grid.cellCorners.length;
    var vertexCount = F + totalSides;
    var colors = cellData.colors;
    var fieldCells = cellData.fieldCells;
    var positions = new Float32Array(vertexCount * 3);
    var colorArr = new Float32Array(vertexCount * 3);
    var centerW = new Float32Array(vertexCount);
    var centersAttr = new Float32Array(vertexCount * 3);
    var birthArr = new Float32Array(vertexCount);
    var shardAttr = new Float32Array(vertexCount);
    var fieldVert = new Uint8Array(vertexCount * 4);
    if (fieldCells && fieldCells.length === F * 4) fieldVert.set(fieldCells, 0);
    colorArr.set(colors, 0);

    var c, k;
    for (c = 0; c < F; c++) {
      centerW[c] = 1;
      birthArr[c] = cellBirth(grid.centers[c * 3 + 1], c);
      positions[c * 3] = grid.centers[c * 3];
      positions[c * 3 + 1] = grid.centers[c * 3 + 1];
      positions[c * 3 + 2] = grid.centers[c * 3 + 2];
      shardAttr[c] = layout ? layout.shardOf[c] : 0;
      centersAttr[c * 3] = positions[c * 3];
      centersAttr[c * 3 + 1] = positions[c * 3 + 1];
      centersAttr[c * 3 + 2] = positions[c * 3 + 2];
    }
    var slot = F;
    for (c = 0; c < F; c++) {
      var start = grid.cellCornerStart[c];
      var count = grid.cellCornerStart[c + 1] - start;
      for (k = 0; k < count; k++) {
        var corner = grid.cellCorners[start + k];
        positions[slot * 3] = grid.corners[corner * 3];
        positions[slot * 3 + 1] = grid.corners[corner * 3 + 1];
        positions[slot * 3 + 2] = grid.corners[corner * 3 + 2];
        shardAttr[slot] = layout ? layout.shardOf[c] : 0;
        colorArr[slot * 3] = colors[c * 3];
        colorArr[slot * 3 + 1] = colors[c * 3 + 1];
        colorArr[slot * 3 + 2] = colors[c * 3 + 2];
        centersAttr[slot * 3] = positions[c * 3];
        centersAttr[slot * 3 + 1] = positions[c * 3 + 1];
        centersAttr[slot * 3 + 2] = positions[c * 3 + 2];
        birthArr[slot] = birthArr[c];
        if (fieldCells && fieldCells.length === F * 4) {
          fieldVert[slot * 4] = fieldCells[c * 4];
          fieldVert[slot * 4 + 1] = fieldCells[c * 4 + 1];
          fieldVert[slot * 4 + 2] = fieldCells[c * 4 + 2];
          fieldVert[slot * 4 + 3] = fieldCells[c * 4 + 3];
        }
        slot++;
      }
    }

    var indices = new Uint32Array(totalSides * 3);
    var cellIndexStart = new Uint32Array(F + 1);
    var w = 0;
    slot = F;
    for (c = 0; c < F; c++) {
      cellIndexStart[c] = w;
      var sides = grid.cellCornerStart[c + 1] - grid.cellCornerStart[c];
      for (k = 0; k < sides; k++) {
        indices[w++] = c;
        indices[w++] = slot + k;
        indices[w++] = slot + ((k + 1) % sides);
      }
      slot += sides;
    }
    cellIndexStart[F] = w;

    return {
      positions: positions,
      colors: colorArr,
      centerW: centerW,
      centers: centersAttr,
      birth: birthArr,
      shard: shardAttr,
      field: fieldVert,
      indices: indices,
      cellIndexStart: cellIndexStart,
      vertexCount: vertexCount,
      indexCount: indices.length
    };
  }

  function buildGeometry(grid, fields, sp, PlanetNoise, opts) {
    opts = opts || {};
    var phase = opts.onPhase || function () {};
    phase('cells');
    var cellData = opts.cellData || buildCellData(fields, PlanetNoise);
    phase('surface');
    var layout = computeShardLayout(grid, sp, PlanetNoise);
    var shardTex = buildShardTexture(layout, sp);
    var surface = buildSurfaceArrays(grid, cellData, layout);
    var volume = null;
    if (opts.includeVolume && layout) {
      phase('volume');
      volume = buildVolumeArrays(grid, layout, sp, surface.positions, surface.birth, PlanetNoise);
    }
    return {
      cellData: cellData,
      surface: surface,
      volume: volume,
      layout: layout,
      shardTexData: shardTex.data,
      shardInfo: shardTex.shardInfo,
      shardMaxB: shardTex.shardMaxB,
      shardMode: layout ? 1 : 0
    };
  }


  var api = {
    buildCellData: buildCellData,
    buildGeometry: buildGeometry,
    buildVolumeArrays: buildVolumeArrays,
    computeShardLayout: computeShardLayout
  };
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanetGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis);
