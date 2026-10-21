/* PlanetGlobe — боевой WebGL2-глобус планеты (Этап 6).
   =========================================================================
   Модуль не вычисляет географию. Он принимает готовую сетку
   `goldberg-gp-v1` и поверхность `c100-soft-v2` и превращает их в:

     - индексированную геометрию гексагональных ячеек одним GPU-бандлом;
     - chunk-диапазоны для отсечения обратной стороны планеты;
     - цвета биомов и диагностических слоёв (реки, высота, климат,
       континенты, дренажные регионы, горы);
     - WebGL2-рендер с границами ячеек, терминатором, low-poly атмосферой,
       вращением/зумом/pinch, адаптивным DPR и выделением ячейки;
     - статичный equirectangular preview для fallback без WebGL2.

   География и pick остаются авторитетно на CPU: рендер только сообщает
   направление луча в объектном пространстве, а вызывающий код/worker
   находит ячейку через `GeodesicGrid.pick`. GPU-шум здесь не используется
   и не может изменить берег, биом или адрес ячейки.

   Чистые строители геометрии работают и в Node, и в Web Worker:
     PlanetGlobe.buildGlobeGeometry(grid, surface, options?)
     PlanetGlobe.buildVertexColors(surface, vertexCellId, mode, cellCount?)
     PlanetGlobe.cellPolygon(grid, surface, cell, options?)
     PlanetGlobe.buildEquirectPreview(grid, surface, width, height, mode?)

   Браузерный рендер:
     var globe = PlanetGlobe.createPlanetGlobe(canvas, options?)
     globe.setGeometry(geometry)
     globe.setColors(uint8RgbaColors)
     globe.setSelection({ center, corners })
*/
(function (root) {
  'use strict';
  /* global module */

  var GLOBE_VERSION = 'planet-globe-v1';
  var COLOR_MODES = [
    { key: 'biome', label: 'Биомы' },
    { key: 'rivers', label: 'Реки и озёра' },
    { key: 'elevation', label: 'Высота' },
    { key: 'moisture', label: 'Влажность' },
    { key: 'temperature', label: 'Температура' },
    { key: 'continents', label: 'Континенты' },
    { key: 'drainage', label: 'Дренажные регионы' },
    { key: 'mountains', label: 'Горы и швы' }
  ];

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
  function smoothstep(a, b, x) {
    if (a === b) return x >= b ? 1 : 0;
    var t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  }
  function mix(a, b, t) { return a + (b - a) * t; }
  function mix3(out, offset, color, t) {
    out[offset] = mix(out[offset], color[0], t);
    out[offset + 1] = mix(out[offset + 1], color[1], t);
    out[offset + 2] = mix(out[offset + 2], color[2], t);
  }
  function ramp(stops, t, out, offset) {
    t = clamp01(t);
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i][0] || i === stops.length - 1) {
        var a = stops[i - 1], b = stops[i];
        var f = b[0] > a[0] ? clamp01((t - a[0]) / (b[0] - a[0])) : 0;
        out[offset] = mix(a[1], b[1], f);
        out[offset + 1] = mix(a[2], b[2], f);
        out[offset + 2] = mix(a[3], b[3], f);
        return out;
      }
    }
    return out;
  }
  function hashInt(id, salt) {
    var x = (Math.imul((id | 0) + 1, 0x9E3779B1) ^ Math.imul(salt | 0, 0x85EBCA6B)) >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7FEB352D);
    x ^= x >>> 15; x = Math.imul(x, 0x846CA68B);
    x ^= x >>> 16;
    return x >>> 0;
  }
  function hslToRgb(h, s, l, out, offset) {
    h = ((h % 1) + 1) % 1;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h * 6) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 1 / 6) { r = c; g = x; }
    else if (h < 2 / 6) { r = x; g = c; }
    else if (h < 3 / 6) { g = c; b = x; }
    else if (h < 4 / 6) { g = x; b = c; }
    else if (h < 5 / 6) { r = x; b = c; }
    else { r = c; b = x; }
    out[offset] = r + m; out[offset + 1] = g + m; out[offset + 2] = b + m;
  }
  function hashColor(id, salt, out, offset, saturation, lightness) {
    var h = hashInt(id, salt);
    hslToRgb((h % 360) / 360, saturation, lightness + ((h >>> 9) % 17 - 8) * 0.006, out, offset);
  }

  var ELEVATION_RAMP = [
    [0.00, 0.004, 0.035, 0.13], [0.38, 0.015, 0.16, 0.38],
    [0.49, 0.05, 0.48, 0.55], [0.505, 0.55, 0.68, 0.36],
    [0.62, 0.20, 0.52, 0.20], [0.78, 0.62, 0.50, 0.24],
    [0.92, 0.45, 0.38, 0.32], [1.00, 0.96, 0.97, 0.99]
  ];
  var MOISTURE_RAMP = [
    [0.00, 0.48, 0.30, 0.12], [0.28, 0.78, 0.62, 0.25],
    [0.55, 0.42, 0.62, 0.24], [0.78, 0.08, 0.55, 0.34],
    [1.00, 0.04, 0.30, 0.72]
  ];
  var TEMPERATURE_RAMP = [
    [0.00, 0.10, 0.20, 0.72], [0.25, 0.15, 0.65, 0.88],
    [0.48, 0.22, 0.72, 0.34], [0.68, 0.92, 0.82, 0.25],
    [0.86, 0.96, 0.42, 0.10], [1.00, 0.72, 0.08, 0.05]
  ];

  function reliefDelta(surface, elevation, reliefScale) {
    var sea = surface.seaLevel || 0;
    if (elevation >= sea) {
      var span = Math.max(1e-9, (surface.elevationMax || sea) - sea);
      return clamp01((elevation - sea) / span) * 0.022 * reliefScale;
    }
    var depthSpan = Math.max(1e-9, sea - (surface.elevationMin || sea));
    return -clamp01((sea - elevation) / depthSpan) * 0.008 * reliefScale;
  }

  function buildCellColors(surface, mode) {
    mode = mode || 'biome';
    var n = surface.cellCount;
    var out = new Float32Array(n * 3);
    var sea = surface.seaLevel || 0;
    var minE = surface.elevationMin != null ? surface.elevationMin : -1;
    var maxE = surface.elevationMax != null ? surface.elevationMax : 1;
    for (var c = 0; c < n; c++) {
      var o = c * 3;
      if (mode === 'elevation') {
        var et = surface.elevation[c] >= sea
          ? 0.5 + 0.5 * clamp01((surface.elevation[c] - sea) / Math.max(1e-9, maxE - sea))
          : 0.5 - 0.5 * clamp01((sea - surface.elevation[c]) / Math.max(1e-9, sea - minE));
        ramp(ELEVATION_RAMP, et, out, o);
      } else if (mode === 'moisture') {
        if (surface.elevation[c] <= sea) { out[o] = 0.01; out[o + 1] = 0.10; out[o + 2] = 0.28; }
        else ramp(MOISTURE_RAMP, surface.moisture[c], out, o);
      } else if (mode === 'temperature') {
        ramp(TEMPERATURE_RAMP, surface.temperature[c], out, o);
        if (surface.elevation[c] <= sea) mix3(out, o, [0.01, 0.08, 0.24], 0.25);
      } else if (mode === 'continents') {
        var cid = surface.continentTop1Id ? surface.continentTop1Id[c] : -1;
        if (cid >= 0 && surface.continentTop1Weight[c] > 0.03) {
          hashColor(cid, 11, out, o, 0.48, 0.46);
          // Переходная зона C100 светлеет с ростом энтропии.
          mix3(out, o, [0.95, 0.98, 1.0], clamp01(surface.continentEntropy[c]) * 0.22);
        } else {
          var basin = surface.oceanBasinId ? surface.oceanBasinId[c] : -1;
          if (basin >= 0) hashColor(basin, 97, out, o, 0.42, 0.16);
          else { out[o] = 0.01; out[o + 1] = 0.07; out[o + 2] = 0.20; }
        }
      } else if (mode === 'drainage') {
        var region = surface.drainageRegionId ? surface.drainageRegionId[c] : -1;
        if (region >= 0) {
          hashColor(region, 41, out, o, 0.50, 0.44);
          if (surface.streamWeight[c] > 0.05) mix3(out, o, [0.02, 0.25, 0.92], surface.streamWeight[c] * 0.55);
        } else { out[o] = 0.008; out[o + 1] = 0.06; out[o + 2] = 0.20; }
      } else {
        // biome / rivers / mountains: стартуем с авторитетного CPU-цвета.
        out[o] = Math.pow(clamp01(surface.biomeColor[o]), 0.58);
        out[o + 1] = Math.pow(clamp01(surface.biomeColor[o + 1]), 0.58);
        out[o + 2] = Math.pow(clamp01(surface.biomeColor[o + 2]), 0.58);
        if (mode === 'rivers') {
          out[o] *= 0.58; out[o + 1] *= 0.62; out[o + 2] *= 0.66;
          if (surface.streamWeight[c] > 0) mix3(out, o, [0.02, 0.38, 1.0], clamp01(surface.streamWeight[c] * 0.88));
          if (surface.lakeWeight[c] > 0) mix3(out, o, [0.05, 0.58, 0.98], clamp01(surface.lakeWeight[c] * 0.75));
          if (surface.deltaWeight[c] > 0) mix3(out, o, [0.25, 0.95, 0.72], clamp01(surface.deltaWeight[c] * 0.58));
        } else if (mode === 'mountains') {
          out[o] *= 0.68; out[o + 1] *= 0.70; out[o + 2] *= 0.74;
          if (surface.mountainWeight[c] > 0) mix3(out, o, [0.72, 0.70, 0.68], surface.mountainWeight[c] * 0.58);
          if (surface.mountainSeamWeight[c] > 0) mix3(out, o, [1.0, 0.28, 0.08], clamp01(surface.mountainSeamWeight[c] * 0.82));
          if (surface.volcanism[c] > 0.55) mix3(out, o, [0.95, 0.42, 0.08], (surface.volcanism[c] - 0.55) * 0.35);
        } else {
          // Обычный биомный вид: реки и дельты видны, но не перекрывают биом.
          if (surface.streamWeight[c] > 0) mix3(out, o, [0.03, 0.34, 0.88], clamp01(surface.streamWeight[c] * 0.42));
          if (surface.deltaWeight[c] > 0) mix3(out, o, [0.10, 0.62, 0.55], clamp01(surface.deltaWeight[c] * 0.18));
          if (surface.mountainSeamWeight[c] > 0) mix3(out, o, [0.86, 0.84, 0.80], clamp01(surface.mountainSeamWeight[c] * 0.16));
        }
      }
    }
    return out;
  }

  function buildVertexColors(surface, vertexCellId, mode, cellCount) {
    var cellColors = buildCellColors(surface, mode || 'biome');
    var vertices = vertexCellId.length;
    var centerCount = cellCount == null ? surface.cellCount : cellCount;
    var out = new Uint8Array(vertices * 4);
    for (var v = 0; v < vertices; v++) {
      var cell = vertexCellId[v];
      var co = cell * 3, o = v * 4;
      out[o] = Math.round(clamp01(cellColors[co]) * 255);
      out[o + 1] = Math.round(clamp01(cellColors[co + 1]) * 255);
      out[o + 2] = Math.round(clamp01(cellColors[co + 2]) * 255);
      out[o + 3] = v < centerCount ? 0 : 255; // A = edge factor веера
    }
    return out;
  }

  function assertGeometryInputs(grid, surface) {
    if (!grid || !grid.centers || !grid.corners || !grid.cellCorners || !grid.cellCornerStart ||
        !Number.isInteger(grid.cellCount)) {
      throw new Error('PlanetGlobe: нужна сетка GeodesicGrid');
    }
    if (!surface || surface.cellCount !== grid.cellCount || !surface.elevation || !surface.biomeColor) {
      throw new Error('PlanetGlobe: нужна поверхность PlanetSurface той же формы, что сетка');
    }
  }

  function buildGlobeGeometry(grid, surface, options) {
    options = options || {};
    assertGeometryInputs(grid, surface);
    var reliefScale = options.reliefScale == null ? 1 : Number(options.reliefScale);
    var F = grid.cellCount;
    var totalSides = grid.cellCorners.length;
    var vertexCount = F + totalSides;
    var positions = new Float32Array(vertexCount * 3);
    var vertexCellId = new Uint32Array(vertexCount);
    var indices = new Uint32Array(totalSides * 3);
    var cellIndexStart = new Uint32Array(F + 1);

    var cellRadius = new Float32Array(F);
    var c, k;
    for (c = 0; c < F; c++) cellRadius[c] = 1 + reliefDelta(surface, surface.elevation[c], reliefScale);
    var cornerRadius = new Float32Array(grid.triangleCount || (grid.corners.length / 3));
    for (var t = 0; t < cornerRadius.length; t++) {
      if (grid.triangles) {
        var a = grid.triangles[t * 3], b = grid.triangles[t * 3 + 1], d = grid.triangles[t * 3 + 2];
        cornerRadius[t] = (cellRadius[a] + cellRadius[b] + cellRadius[d]) / 3;
      } else cornerRadius[t] = 1;
    }

    for (c = 0; c < F; c++) {
      var r = cellRadius[c];
      positions[c * 3] = grid.centers[c * 3] * r;
      positions[c * 3 + 1] = grid.centers[c * 3 + 1] * r;
      positions[c * 3 + 2] = grid.centers[c * 3 + 2] * r;
      vertexCellId[c] = c;
    }
    var slot = F;
    var w = 0;
    for (c = 0; c < F; c++) {
      cellIndexStart[c] = w;
      var start = grid.cellCornerStart[c];
      var sides = grid.cellCornerStart[c + 1] - start;
      for (k = 0; k < sides; k++) {
        var corner = grid.cellCorners[start + k];
        var cr = cornerRadius[corner] || 1;
        positions[slot * 3] = grid.corners[corner * 3] * cr;
        positions[slot * 3 + 1] = grid.corners[corner * 3 + 1] * cr;
        positions[slot * 3 + 2] = grid.corners[corner * 3 + 2] * cr;
        vertexCellId[slot] = c;
        slot++;
      }
      var firstCornerSlot = slot - sides;
      for (k = 0; k < sides; k++) {
        indices[w++] = c;
        indices[w++] = firstCornerSlot + k;
        indices[w++] = firstCornerSlot + ((k + 1) % sides);
      }
    }
    cellIndexStart[F] = w;

    var chunkRanges = [];
    if (grid.chunkCellStart && grid.chunkCenters && grid.chunkCosAngularRadius) {
      for (var ci = 0; ci < grid.chunkCount; ci++) {
        var startCell = grid.chunkCellStart[ci];
        var endCell = grid.chunkCellStart[ci + 1];
        chunkRanges.push({
          id: ci,
          startCell: startCell,
          cellCount: endCell - startCell,
          indexStart: cellIndexStart[startCell],
          indexCount: cellIndexStart[endCell] - cellIndexStart[startCell],
          center: [grid.chunkCenters[ci * 3], grid.chunkCenters[ci * 3 + 1], grid.chunkCenters[ci * 3 + 2]],
          cosAngularRadius: grid.chunkCosAngularRadius[ci],
          sinAngularRadius: grid.chunkSinAngularRadius ? grid.chunkSinAngularRadius[ci] : 0
        });
      }
    }

    var colors = buildVertexColors(surface, vertexCellId, options.colorMode || 'biome', F);
    return {
      version: GLOBE_VERSION,
      v: grid.v,
      cellCount: F,
      vertexCount: vertexCount,
      triangleCount: totalSides,
      indexCount: indices.length,
      positions: positions,
      colors: colors,
      indices: indices,
      vertexCellId: vertexCellId,
      cellIndexStart: cellIndexStart,
      chunkRanges: chunkRanges,
      reliefScale: reliefScale,
      typedBytes: positions.byteLength + colors.byteLength + indices.byteLength
    };
  }

  function listGeometryTransferables(geometry, includeVertexCellId) {
    var out = [];
    function add(a) { if (a && a.buffer && out.indexOf(a.buffer) < 0) out.push(a.buffer); }
    add(geometry && geometry.positions);
    add(geometry && geometry.colors);
    add(geometry && geometry.indices);
    if (includeVertexCellId) add(geometry && geometry.vertexCellId);
    return out;
  }

  function cellPolygon(grid, surface, cell, options) {
    options = options || {};
    assertGeometryInputs(grid, surface);
    if (!Number.isInteger(cell) || cell < 0 || cell >= grid.cellCount) return null;
    var reliefScale = options.reliefScale == null ? 1 : Number(options.reliefScale);
    var inflate = options.inflate == null ? 1.004 : Number(options.inflate);
    var centerR = (1 + reliefDelta(surface, surface.elevation[cell], reliefScale)) * inflate;
    var center = [
      grid.centers[cell * 3] * centerR,
      grid.centers[cell * 3 + 1] * centerR,
      grid.centers[cell * 3 + 2] * centerR
    ];
    var corners = [];
    var start = grid.cellCornerStart[cell];
    var end = grid.cellCornerStart[cell + 1];
    for (var k = start; k < end; k++) {
      var corner = grid.cellCorners[k];
      var radius = 1;
      if (grid.triangles) {
        var a = grid.triangles[corner * 3], b = grid.triangles[corner * 3 + 1], d = grid.triangles[corner * 3 + 2];
        radius = 1 + (reliefDelta(surface, surface.elevation[a], reliefScale) +
          reliefDelta(surface, surface.elevation[b], reliefScale) +
          reliefDelta(surface, surface.elevation[d], reliefScale)) / 3;
      }
      radius *= inflate;
      corners.push([
        grid.corners[corner * 3] * radius,
        grid.corners[corner * 3 + 1] * radius,
        grid.corners[corner * 3 + 2] * radius
      ]);
    }
    return { cell: cell, center: center, corners: corners };
  }

  function buildEquirectPreview(grid, surface, width, height, mode) {
    assertGeometryInputs(grid, surface);
    width = Math.max(32, width | 0);
    height = Math.max(16, height | 0);
    var data = new Uint8ClampedArray(width * height * 4);
    var i, x, y;
    for (i = 0; i < width * height; i++) {
      data[i * 4] = 3; data[i * 4 + 1] = 18; data[i * 4 + 2] = 48; data[i * 4 + 3] = 255;
    }
    var colors = buildCellColors(surface, mode || 'biome');
    function put(px, py, c) {
      if (py < 0 || py >= height) return;
      px = ((px % width) + width) % width;
      var o = (py * width + px) * 4;
      data[o] = Math.round(clamp01(colors[c * 3]) * 255);
      data[o + 1] = Math.round(clamp01(colors[c * 3 + 1]) * 255);
      data[o + 2] = Math.round(clamp01(colors[c * 3 + 2]) * 255);
      data[o + 3] = 255;
    }
    for (var c = 0; c < grid.cellCount; c++) {
      var cx = grid.centers[c * 3], cy = grid.centers[c * 3 + 1], cz = grid.centers[c * 3 + 2];
      var lon = Math.atan2(cz, cx);
      var lat = Math.asin(clamp(cy, -1, 1));
      var px0 = Math.round((lon + Math.PI) / (2 * Math.PI) * width);
      var py0 = Math.round((0.5 - lat / Math.PI) * height);
      var angular = Math.sqrt(Math.max(0, grid.areas[c]) / Math.PI);
      var rx = Math.max(1, Math.ceil(angular * width / (2 * Math.PI) / Math.max(0.28, Math.cos(lat))));
      var ry = Math.max(1, Math.ceil(angular * height / Math.PI));
      rx = Math.min(rx, Math.max(2, width >> 2));
      for (y = py0 - ry; y <= py0 + ry; y++) {
        for (x = px0 - rx; x <= px0 + rx; x++) put(x, y, c);
      }
    }
    return { width: width, height: height, data: data };
  }

  /* ---------------------------------------------------------- WebGL2 */

  var BASE_FOVY = 42 * Math.PI / 180;
  function fieldOfViewYForAspect(aspect) {
    // В портрете фиксированный вертикальный FOV обрезал планету по бокам
    // и заставлял GPU растеризовать огромную внеэкранную часть диска.
    // Сохраняем горизонтальный угол ландшафтного вида, расширяя
    // вертикальный FOV ровно настолько, чтобы сфера помещалась по ширине.
    if (!Number.isFinite(aspect) || aspect >= 1) return BASE_FOVY;
    return 2 * Math.atan(Math.tan(BASE_FOVY / 2) / Math.max(0.35, aspect));
  }
  function mat4Perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    var out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) / (near - far); out[11] = -1;
    out[14] = 2 * far * near / (near - far);
    return out;
  }
  function mat4Multiply(a, b) {
    var out = new Float32Array(16);
    for (var col = 0; col < 4; col++) {
      for (var row = 0; row < 4; row++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }
  function mat4RotationYawPitch(yaw, pitch) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = RotX(pitch) * RotY(yaw), column-major.
    return new Float32Array([
      cy, sp * sy, -cp * sy, 0,
      0, cp, sp, 0,
      sy, -sp * cy, cp * cy, 0,
      0, 0, 0, 1
    ]);
  }
  function transformDirectionTranspose(m, p) {
    // Для чистой вращательной матрицы обратная равна транспонированной.
    return [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2]
    ];
  }
  function normalize3(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }

  var SURFACE_VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec4 aColor;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'out vec3 vColor;',
    'out float vEdge;',
    'out vec3 vNormal;',
    'out vec3 vWorldPos;',
    'void main() {',
    '  vec4 wp = uModel * vec4(aPos, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  vColor = aColor.rgb;',
    '  vEdge = aColor.a;',
    '  gl_Position = uMvp * vec4(aPos, 1.0);',
    '}'
  ].join('\n');
  var SURFACE_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vColor;',
    'in float vEdge;',
    'in vec3 vNormal;',
    'in vec3 vWorldPos;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uCamPos;',
    'uniform float uBorder;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec3 n = normalize(vNormal);',
    '  float nd = dot(n, normalize(uSunDir));',
    '  float light = 0.20 + 0.80 * smoothstep(-0.18, 0.42, nd);',
    '  vec3 viewDir = normalize(uCamPos - vWorldPos);',
    '  float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);',
    '  vec3 col = vColor * light;',
    '  float border = smoothstep(0.84, 0.995, vEdge) * uBorder;',
    '  col = mix(col, vec3(0.015, 0.10, 0.13), border * 0.46);',
    '  col += vec3(0.05, 0.55, 0.62) * border * 0.10;',
    '  col += vec3(0.05, 0.28, 0.38) * rim * 0.16;',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');
  var ATMO_VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'uniform mat4 uMvp;',
    'uniform mat4 uModel;',
    'uniform float uScale;',
    'out vec3 vNormal;',
    'out vec3 vWorldPos;',
    'void main() {',
    '  vec3 p = aPos * uScale;',
    '  vec4 wp = uModel * vec4(p, 1.0);',
    '  vWorldPos = wp.xyz;',
    '  vNormal = normalize(mat3(uModel) * normalize(aPos));',
    '  gl_Position = uMvp * vec4(p, 1.0);',
    '}'
  ].join('\n');
  var ATMO_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vNormal;',
    'in vec3 vWorldPos;',
    'uniform vec3 uCamPos;',
    'uniform float uIntensity;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec3 viewDir = normalize(uCamPos - vWorldPos);',
    '  float f = pow(clamp(1.0 - abs(dot(normalize(vNormal), viewDir)), 0.0, 1.0), 3.2);',
    '  vec3 col = vec3(0.16, 0.62, 0.92) * f * uIntensity;',
    '  fragColor = vec4(col, f * 0.78 * uIntensity);',
    '}'
  ].join('\n');
  var SIMPLE_VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'uniform mat4 uMvp;',
    'void main() { gl_Position = uMvp * vec4(aPos, 1.0); }'
  ].join('\n');
  var SIMPLE_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec4 uColor;',
    'out vec4 fragColor;',
    'void main() { fragColor = uColor; }'
  ].join('\n');

  function makeSphereGeometry(lonSegments, latSegments) {
    var positions = [];
    var indices = [];
    for (var iy = 0; iy <= latSegments; iy++) {
      var lat = Math.PI / 2 - iy / latSegments * Math.PI;
      for (var ix = 0; ix <= lonSegments; ix++) {
        var lon = ix / lonSegments * Math.PI * 2;
        positions.push(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      }
    }
    var row = lonSegments + 1;
    for (var y = 0; y < latSegments; y++) {
      for (var x = 0; x < lonSegments; x++) {
        var a = y * row + x, b = a + 1, c = a + row, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
  }

  function createPlanetGlobe(canvas, options) {
    options = options || {};
    if (!canvas || !canvas.getContext) return null;
    var gl = canvas.getContext('webgl2', {
      antialias: options.antialias !== false,
      alpha: false,
      powerPreference: 'high-performance'
    });
    if (!gl) return null;

    var surfaceProgram = null, atmoProgram = null, simpleProgram = null;
    var U = {}, UA = {}, US = {};
    var geometry = null;
    var vao = null, positionBuffer = null, colorBuffer = null, indexBuffer = null;
    var atmoVao = null, atmoIndexCount = 0;
    var selection = null, selectionVao = null, selectionBuffer = null, selectionIndexBuffer = null, selectionIndexCount = 0, selectionCornerCount = 0;
    var pendingUpload = null;
    var queuedColors = null;
    var disposed = false;
    var raf = 0;
    var yaw = -0.65, pitch = 0.38;
    var yawVelocity = 0, pitchVelocity = 0;
    var distance = 3.05, targetDistance = 3.05;
    var autoRotate = options.autoRotate !== false;
    var bordersEnabled = options.borders !== false;
    var atmosphereEnabled = options.atmosphere !== false;
    var interacting = false;
    var pointers = new Map();
    var lastPinchDistance = 0;
    var downInfo = null;
    var hoverQueued = false;
    var renderScale = 1;
    var maxPixelRatio = Math.max(0.5, Math.min(2, Number(options.maxPixelRatio) || 2));
    var adaptiveQualityHold = false;
    var lastStatsAt = 0;
    var frameTimes = [];
    var lastFrameAt = performance.now();
    var adaptCooldownUntil = 0;
    var sunDir = normalize3([-0.55, 0.35, 0.76]);

    function compile(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error('PlanetGlobe shader: ' + gl.getShaderInfoLog(shader));
      }
      return shader;
    }
    function makeProgram(vs, fs) {
      var program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('PlanetGlobe program: ' + gl.getProgramInfoLog(program));
      }
      return program;
    }
    function locations(program, names) {
      var out = {};
      names.forEach(function (name) { out[name] = gl.getUniformLocation(program, name); });
      return out;
    }
    function initPrograms() {
      surfaceProgram = makeProgram(SURFACE_VS, SURFACE_FS);
      atmoProgram = makeProgram(ATMO_VS, ATMO_FS);
      simpleProgram = makeProgram(SIMPLE_VS, SIMPLE_FS);
      U = locations(surfaceProgram, ['uMvp', 'uModel', 'uSunDir', 'uCamPos', 'uBorder']);
      UA = locations(atmoProgram, ['uMvp', 'uModel', 'uScale', 'uCamPos', 'uIntensity']);
      US = locations(simpleProgram, ['uMvp', 'uColor']);
      buildAtmosphere();
    }
    function buildAtmosphere() {
      var sphere = makeSphereGeometry(56, 36);
      atmoIndexCount = sphere.indices.length;
      atmoVao = gl.createVertexArray();
      gl.bindVertexArray(atmoVao);
      var pos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, pos);
      gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      var idx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }
    function deleteSurfaceBuffers() {
      if (vao) gl.deleteVertexArray(vao);
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (colorBuffer) gl.deleteBuffer(colorBuffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      vao = positionBuffer = colorBuffer = indexBuffer = null;
    }
    function deletePendingUpload() {
      if (!pendingUpload) return;
      if (pendingUpload.vao) gl.deleteVertexArray(pendingUpload.vao);
      if (pendingUpload.positionBuffer) gl.deleteBuffer(pendingUpload.positionBuffer);
      if (pendingUpload.colorBuffer) gl.deleteBuffer(pendingUpload.colorBuffer);
      if (pendingUpload.indexBuffer) gl.deleteBuffer(pendingUpload.indexBuffer);
      pendingUpload = null;
    }
    function uploadGeometry(nextGeometry) {
      // Порционная заливка: текущая планета продолжает рисоваться старым
      // VAO, пока новый бандл собирается по частям. На канонической Земле
      // это ~30 МиБ, и одна синхронная заливка способна дать тяжёлый кадр.
      deletePendingUpload();
      if (!nextGeometry) return;
      var pending = {
        geometry: nextGeometry,
        stage: 0,
        offset: 0,
        uploadedBytes: 0,
        totalBytes: nextGeometry.positions.byteLength + nextGeometry.colors.byteLength + nextGeometry.indices.byteLength,
        vao: gl.createVertexArray(),
        positionBuffer: gl.createBuffer(),
        colorBuffer: gl.createBuffer(),
        indexBuffer: gl.createBuffer()
      };
      pendingUpload = pending;
      gl.bindVertexArray(pending.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, pending.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, nextGeometry.positions.byteLength, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, pending.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, nextGeometry.colors.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pending.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, nextGeometry.indices.byteLength, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
    }
    function finishPendingUpload() {
      var pending = pendingUpload;
      if (!pending) return;
      pendingUpload = null;
      deleteSurfaceBuffers();
      geometry = pending.geometry;
      vao = pending.vao;
      positionBuffer = pending.positionBuffer;
      colorBuffer = pending.colorBuffer;
      indexBuffer = pending.indexBuffer;
      if (queuedColors) {
        var colors = queuedColors;
        queuedColors = null;
        geometry.colors = colors;
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
      if (typeof options.onGeometryUploadProgress === 'function') {
        try { options.onGeometryUploadProgress({ geometry: geometry, fraction: 1 }); } catch (_) { /* HUD не ломает рендер */ }
      }
      if (typeof options.onGeometryReady === 'function') {
        try { options.onGeometryReady(geometry); } catch (_) { /* вызывающий код не ломает рендер */ }
      }
    }
    function processPendingUpload() {
      if (!pendingUpload) return;
      var pending = pendingUpload;
      var arrays = [pending.geometry.positions, pending.geometry.colors, pending.geometry.indices];
      var targets = [gl.ARRAY_BUFFER, gl.ARRAY_BUFFER, gl.ELEMENT_ARRAY_BUFFER];
      var buffers = [pending.positionBuffer, pending.colorBuffer, pending.indexBuffer];
      // Телефонная приёмка показала, что 2,5 МиБ одним bufferSubData для
      // мобильного драйвера слишком грубо. 384 КиБ и бюджет 3 мс дают
      // больше кадров на заливку, но каждый кадр заметно легче.
      var deadline = performance.now() + 3;
      gl.bindVertexArray(pending.vao);
      while (pendingUpload === pending && pending.stage < arrays.length && performance.now() < deadline) {
        var array = arrays[pending.stage];
        // Цвет мог смениться, пока позиции ещё заливались.
        if (pending.stage === 1) array = pending.geometry.colors;
        var maxElements = Math.max(4096, Math.floor(393216 / array.BYTES_PER_ELEMENT));
        var count = Math.min(array.length - pending.offset, maxElements);
        if (count <= 0) {
          pending.stage++;
          pending.offset = 0;
          continue;
        }
        gl.bindBuffer(targets[pending.stage], buffers[pending.stage]);
        gl.bufferSubData(
          targets[pending.stage],
          pending.offset * array.BYTES_PER_ELEMENT,
          array.subarray(pending.offset, pending.offset + count)
        );
        pending.offset += count;
        pending.uploadedBytes += count * array.BYTES_PER_ELEMENT;
        if (pending.offset >= array.length) {
          pending.stage++;
          pending.offset = 0;
        }
        if (typeof options.onGeometryUploadProgress === 'function') {
          try {
            options.onGeometryUploadProgress({
              geometry: pending.geometry,
              fraction: pending.totalBytes ? pending.uploadedBytes / pending.totalBytes : 1
            });
          } catch (_) { /* HUD не ломает рендер */ }
        }
      }
      gl.bindVertexArray(null);
      if (pendingUpload === pending && pending.stage >= arrays.length) finishPendingUpload();
    }
    function uploadSelection() {
      if (selectionVao) gl.deleteVertexArray(selectionVao);
      if (selectionBuffer) gl.deleteBuffer(selectionBuffer);
      if (selectionIndexBuffer) gl.deleteBuffer(selectionIndexBuffer);
      selectionVao = selectionBuffer = selectionIndexBuffer = null;
      selectionIndexCount = 0;
      selectionCornerCount = 0;
      if (!selection || !selection.corners || selection.corners.length < 3) return;
      var vertices = [];
      vertices.push(selection.center[0], selection.center[1], selection.center[2]);
      selection.corners.forEach(function (p) { vertices.push(p[0], p[1], p[2]); });
      var indices = [];
      for (var i = 0; i < selection.corners.length; i++) {
        indices.push(0, 1 + i, 1 + ((i + 1) % selection.corners.length));
      }
      selectionVao = gl.createVertexArray();
      gl.bindVertexArray(selectionVao);
      selectionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, selectionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      selectionIndexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, selectionIndexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.DYNAMIC_DRAW);
      selectionIndexCount = indices.length;
      selectionCornerCount = selection.corners.length;
      gl.bindVertexArray(null);
    }
    function resizeIfNeeded() {
      var dpr = Math.min(maxPixelRatio, (root.devicePixelRatio || 1)) * renderScale;
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      return canvas.width / canvas.height;
    }
    function visibleRanges(model) {
      if (!geometry || !geometry.chunkRanges || !geometry.chunkRanges.length) {
        return geometry ? [{ indexStart: 0, indexCount: geometry.indexCount }] : [];
      }
      var ranges = [];
      var threshold = 0.92 / distance;
      var current = null;
      for (var i = 0; i < geometry.chunkRanges.length; i++) {
        var range = geometry.chunkRanges[i];
        // Нужна только z-координата центра в мировом пространстве;
        // без временного массива на каждый chunk в каждом кадре.
        var czRaw = model[2] * range.center[0] + model[6] * range.center[1] + model[10] * range.center[2];
        var cz = clamp(czRaw, -1, 1);
        var maxZ = cz * range.cosAngularRadius + Math.sqrt(Math.max(0, 1 - cz * cz)) * Math.abs(range.sinAngularRadius || 0);
        if (maxZ < threshold) { current = null; continue; }
        if (current && current.indexStart + current.indexCount === range.indexStart) {
          current.indexCount += range.indexCount;
        } else {
          current = { indexStart: range.indexStart, indexCount: range.indexCount };
          ranges.push(current);
        }
      }
      return ranges;
    }
    function percentile(sorted, q) {
      if (!sorted.length) return 0;
      return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
    }
    function collectStats(now) {
      var recent = frameTimes.filter(function (x) { return now - x.at <= 10000; });
      frameTimes = recent;
      var values = recent.map(function (x) { return x.ms; }).sort(function (a, b) { return a - b; });
      var p95 = percentile(values, 0.95);
      return {
        fps: values.length ? 1000 / Math.max(0.01, values.reduce(function (a, b) { return a + b; }, 0) / values.length) : 0,
        p50: percentile(values, 0.50),
        p95: p95,
        p99: percentile(values, 0.99),
        over50: values.filter(function (x) { return x > 50; }).length,
        over100: values.filter(function (x) { return x > 100; }).length,
        renderScale: renderScale,
        distance: distance
      };
    }
    function resetStats() {
      var now = performance.now();
      frameTimes = [];
      lastFrameAt = now;
      lastStatsAt = 0;
      adaptCooldownUntil = now + 3000;
    }
    function adaptQuality(now) {
      // Генерация в worker и GPU-заливка не должны навсегда уронить
      // масштаб рендера: это не steady-сценарий гейта.
      if (adaptiveQualityHold || pendingUpload) return;
      if (now < adaptCooldownUntil || frameTimes.length < 70) return;
      var stats = collectStats(now);
      if (stats.p95 > 21 && renderScale > 0.55) {
        renderScale = Math.max(0.55, renderScale * 0.85);
        adaptCooldownUntil = now + 2500;
      } else if (stats.p95 > 0 && stats.p95 < 12.5 && renderScale < 1) {
        renderScale = Math.min(1, renderScale * 1.10);
        adaptCooldownUntil = now + 4000;
      }
    }
    function draw(now) {
      if (disposed) return;
      raf = requestAnimationFrame(draw);
      var dtMs = now - lastFrameAt;
      lastFrameAt = now;
      if (dtMs > 0 && dtMs < 1000) frameTimes.push({ at: now, ms: dtMs });
      adaptQuality(now);
      processPendingUpload();
      var aspect = resizeIfNeeded();
      var dt = Math.min(0.05, Math.max(0.001, dtMs / 1000));
      if (!interacting) {
        yaw += yawVelocity * dt;
        pitch = clamp(pitch + pitchVelocity * dt, -1.35, 1.35);
        yawVelocity *= Math.pow(0.12, dt);
        pitchVelocity *= Math.pow(0.12, dt);
        if (autoRotate) yaw += 0.045 * dt;
      }
      distance += (targetDistance - distance) * Math.min(1, dt * 9);
      var model = mat4RotationYawPitch(yaw, pitch);
      var view = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-distance,1]);
      var proj = mat4Perspective(fieldOfViewYForAspect(aspect), aspect, 0.05, 30);
      var mvp = mat4Multiply(proj, mat4Multiply(view, model));
      var camPos = [0, 0, distance];

      gl.clearColor(0.006, 0.012, 0.030, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);

      if (geometry && vao) {
        gl.useProgram(surfaceProgram);
        gl.uniformMatrix4fv(U.uMvp, false, mvp);
        gl.uniformMatrix4fv(U.uModel, false, model);
        gl.uniform3f(U.uSunDir, sunDir[0], sunDir[1], sunDir[2]);
        gl.uniform3f(U.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.uniform1f(U.uBorder, bordersEnabled ? 1 : 0);
        gl.bindVertexArray(vao);
        var ranges = visibleRanges(model);
        for (var i = 0; i < ranges.length; i++) {
          gl.drawElements(gl.TRIANGLES, ranges[i].indexCount, gl.UNSIGNED_INT, ranges[i].indexStart * 4);
        }
        gl.bindVertexArray(null);
      }

      if (selectionVao && selectionIndexCount) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.useProgram(simpleProgram);
        gl.uniformMatrix4fv(US.uMvp, false, mvp);
        gl.uniform4f(US.uColor, 0.25, 0.95, 1.0, 0.30);
        gl.bindVertexArray(selectionVao);
        gl.drawElements(gl.TRIANGLES, selectionIndexCount, gl.UNSIGNED_INT, 0);
        gl.uniform4f(US.uColor, 0.45, 1.0, 0.98, 0.95);
        // Буфер: [центр, углы...]; контур рисуем только по углам.
        gl.drawArrays(gl.LINE_LOOP, 1, selectionCornerCount);
        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      if (atmosphereEnabled && atmoVao) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.useProgram(atmoProgram);
        gl.uniformMatrix4fv(UA.uMvp, false, mvp);
        gl.uniformMatrix4fv(UA.uModel, false, model);
        gl.uniform3f(UA.uCamPos, camPos[0], camPos[1], camPos[2]);
        gl.bindVertexArray(atmoVao);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT);
        gl.uniform1f(UA.uScale, 1.18);
        gl.uniform1f(UA.uIntensity, 0.72);
        gl.drawElements(gl.TRIANGLES, atmoIndexCount, gl.UNSIGNED_INT, 0);
        gl.cullFace(gl.BACK);
        gl.uniform1f(UA.uScale, 1.025);
        gl.uniform1f(UA.uIntensity, 0.22);
        gl.drawElements(gl.TRIANGLES, atmoIndexCount, gl.UNSIGNED_INT, 0);
        gl.bindVertexArray(null);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      if (typeof options.onStats === 'function' && now - lastStatsAt > 500) {
        lastStatsAt = now;
        try { options.onStats(collectStats(now)); } catch (_) { /* HUD не ломает рендер */ }
      }
    }

    function pickDirection(clientX, clientY) {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      var ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      var ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      var aspect = rect.width / rect.height;
      var tanHalf = Math.tan(fieldOfViewYForAspect(aspect) / 2);
      var ray = normalize3([ndcX * aspect * tanHalf, ndcY * tanHalf, -1]);
      var origin = [0, 0, distance];
      var b = origin[0] * ray[0] + origin[1] * ray[1] + origin[2] * ray[2];
      var c = origin[0] * origin[0] + origin[1] * origin[1] + origin[2] * origin[2] - 1;
      var disc = b * b - c;
      if (disc < 0) return null;
      var t = -b - Math.sqrt(disc);
      if (t < 0) t = -b + Math.sqrt(disc);
      if (t < 0) return null;
      var hit = [origin[0] + ray[0] * t, origin[1] + ray[1] * t, origin[2] + ray[2] * t];
      var model = mat4RotationYawPitch(yaw, pitch);
      return normalize3(transformDirectionTranspose(model, hit));
    }

    function pointerDistance() {
      var pts = Array.from(pointers.values());
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    function onPointerDown(e) {
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      interacting = true;
      yawVelocity = pitchVelocity = 0;
      downInfo = { x: e.clientX, y: e.clientY, at: performance.now(), moved: 0 };
      lastPinchDistance = pointerDistance();
    }
    function onPointerMove(e) {
      if (pointers.has(e.pointerId)) {
        var prev = pointers.get(e.pointerId);
        var dx = e.clientX - prev.x;
        var dy = e.clientY - prev.y;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (downInfo) downInfo.moved += Math.abs(dx) + Math.abs(dy);
        if (pointers.size === 1) {
          var scale = 0.0052;
          yaw += dx * scale;
          pitch = clamp(pitch + dy * scale, -1.35, 1.35);
          yawVelocity = dx * scale * 60;
          pitchVelocity = dy * scale * 60;
        } else if (pointers.size === 2) {
          var d = pointerDistance();
          if (lastPinchDistance > 0 && d > 0) {
            targetDistance = clamp(targetDistance * lastPinchDistance / d, 1.35, 6.0);
          }
          lastPinchDistance = d;
        }
      } else if (typeof options.onHoverDirection === 'function' && e.pointerType === 'mouse' && !hoverQueued) {
        hoverQueued = true;
        requestAnimationFrame(function () {
          hoverQueued = false;
          var dir = pickDirection(e.clientX, e.clientY);
          if (dir) {
            try { options.onHoverDirection(dir); } catch (_) { /* noop */ }
          }
        });
      }
    }
    function onPointerUp(e) {
      var wasClick = downInfo && downInfo.moved < 7 && performance.now() - downInfo.at < 600;
      pointers.delete(e.pointerId);
      if (!pointers.size) {
        interacting = false;
        lastPinchDistance = 0;
        if (wasClick && typeof options.onPickDirection === 'function') {
          var dir = pickDirection(e.clientX, e.clientY);
          if (dir) {
            try { options.onPickDirection(dir); } catch (_) { /* noop */ }
          } else if (typeof options.onPickMiss === 'function') {
            try { options.onPickMiss(); } catch (_) { /* noop */ }
          }
        }
        downInfo = null;
      }
    }
    function onPointerCancel(e) {
      pointers.delete(e.pointerId);
      if (!pointers.size) { interacting = false; downInfo = null; lastPinchDistance = 0; }
    }
    function onWheel(e) {
      e.preventDefault();
      var factor = Math.exp(clamp(e.deltaY, -240, 240) * 0.0016);
      targetDistance = clamp(targetDistance * factor, 1.35, 6.0);
      if (typeof options.onZoomChange === 'function') {
        try { options.onZoomChange(targetDistance); } catch (_) { /* noop */ }
      }
    }
    function onContextLost(e) {
      e.preventDefault();
      if (typeof options.onContextLost === 'function') {
        try { options.onContextLost(); } catch (_) { /* noop */ }
      }
    }
    function onContextRestored() {
      var restoreGeometry = pendingUpload ? pendingUpload.geometry : geometry;
      pendingUpload = null;
      vao = positionBuffer = colorBuffer = indexBuffer = null;
      selectionVao = selectionBuffer = selectionIndexBuffer = null;
      initPrograms();
      uploadGeometry(restoreGeometry);
      uploadSelection();
      if (typeof options.onContextRestored === 'function') {
        try { options.onContextRestored(); } catch (_) { /* noop */ }
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    initPrograms();
    raf = requestAnimationFrame(draw);

    return {
      version: GLOBE_VERSION,
      canvas: canvas,
      gl: gl,
      setGeometry: function (nextGeometry) {
        uploadGeometry(nextGeometry);
      },
      setColors: function (colors) {
        if (pendingUpload) {
          pendingUpload.geometry.colors = colors;
          queuedColors = colors;
          return;
        }
        if (!geometry || !colorBuffer) return;
        geometry.colors = colors;
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      },
      setSelection: function (nextSelection) {
        selection = nextSelection;
        uploadSelection();
      },
      clearSelection: function () {
        selection = null;
        uploadSelection();
      },
      setBordersEnabled: function (enabled) { bordersEnabled = !!enabled; },
      setAutoRotate: function (enabled) { autoRotate = !!enabled; },
      setAtmosphereEnabled: function (enabled) { atmosphereEnabled = !!enabled; },
      setDistance: function (value) { targetDistance = clamp(Number(value) || targetDistance, 1.35, 6.0); },
      getDistance: function () { return targetDistance; },
      resetView: function () {
        yaw = -0.65; pitch = 0.38; yawVelocity = pitchVelocity = 0;
        targetDistance = 3.05;
      },
      pickDirection: pickDirection,
      setAdaptiveQualityHold: function (enabled) { adaptiveQualityHold = !!enabled; },
      isGeometryUploading: function () { return !!pendingUpload; },
      resetStats: resetStats,
      getStats: function () { return collectStats(performance.now()); },
      dispose: function () {
        disposed = true;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        canvas.removeEventListener('webglcontextrestored', onContextRestored);
        deletePendingUpload();
        deleteSurfaceBuffers();
        if (selectionVao) gl.deleteVertexArray(selectionVao);
        if (selectionBuffer) gl.deleteBuffer(selectionBuffer);
        if (selectionIndexBuffer) gl.deleteBuffer(selectionIndexBuffer);
      }
    };
  }

  var api = {
    GLOBE_VERSION: GLOBE_VERSION,
    COLOR_MODES: COLOR_MODES.map(function (x) { return { key: x.key, label: x.label }; }),
    buildCellColors: buildCellColors,
    buildVertexColors: buildVertexColors,
    buildGlobeGeometry: buildGlobeGeometry,
    listGeometryTransferables: listGeometryTransferables,
    cellPolygon: cellPolygon,
    buildEquirectPreview: buildEquirectPreview,
    fieldOfViewYForAspect: fieldOfViewYForAspect,
    createPlanetGlobe: createPlanetGlobe
  };

  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanetGlobe = api;
})(typeof window !== 'undefined' ? window : globalThis);
