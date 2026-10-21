/* PlanetSurface — гидрология, горные швы и биомы (Этап 5).
   =========================================================================
   Модуль является надстройкой над замороженным PlanetGeography
   (`c100-soft-v1`) и не меняет его поля, C100-идентичности или seed-контракт.
   Полный поверхностный рецепт Этапа 5 идентифицируется как
   `c100-soft-v2`: внутри него база по-прежнему `c100-soft-v1`, а
   гидрология и биомы имеют собственные версии алгоритмов.

   Что добавляет модуль:
     - priority-flood поверхность и глубину впадин;
     - направленный сток по наибольшему понижению, накопление потока;
     - строгие водосборы по терминальному устью/стоку и отдельно целевые
       drainage regions масштаба `drainage_mean_cells`;
     - переполняющиеся и терминальные озёра, бессточные впадины, дельты;
     - уклон, горный вес, тектонические горные швы и хребты;
     - мягкие top-2 биомы, энтропию перехода и CPU-смешанный цвет.

   Река здесь — подячеечный гидрологический граф и вес канала, а не
   территориальная замена ячейки. Конкретная линия русла внутри ячейки
   появится только на локальной карте Этапов 8+.

   API:
     PlanetSurface.generateSurface(grid, profile, options?)
     await PlanetSurface.generateSurfaceAsync(grid, profile, options?)
     PlanetSurface.augmentGeography(grid, geography, options?)
     PlanetSurface.validateSurface(grid, surface)
     PlanetSurface.listTransferableBuffers(surface)
     PlanetSurface.packSurfaceForTransfer(surface)

   `generateSurface` также принимает готовый результат PlanetGeography
   вместо профиля. В браузере перед модулем должны быть подключены
   PlanetNoise и PlanetGeography; в Node зависимости подтягиваются сами. */
(function (root) {
  'use strict';
  /* global module, require */

  var PlanetGeography = root.PlanetGeography ||
    (typeof module !== 'undefined' && module.exports ? require('./planet-geography.js') : null);
  if (!PlanetGeography) throw new Error('PlanetSurface: PlanetGeography должен быть подключён раньше');

  var BASE_GEOGRAPHY_VERSION = PlanetGeography.GEOGRAPHY_VERSION;
  var SURFACE_GEOGRAPHY_VERSION = 'c100-soft-v2';
  var SURFACE_VERSION = SURFACE_GEOGRAPHY_VERSION;
  var HYDROLOGY_VERSION = 'planet-hydrology-v1';
  var BIOME_VERSION = 'planet-biomes-v1';

  var TERMINAL_NONE = 0;
  var TERMINAL_OCEAN = 1;
  var TERMINAL_LAKE = 2;
  var TERMINAL_ENDORHEIC = 3;
  var TERMINAL_TYPE_NAMES = ['none', 'ocean', 'terminal_lake', 'endorheic'];

  var BIOME_DEFINITIONS = [
    { id: 0, key: 'deep_ocean', nameRu: 'Глубокий океан', color: [0.008, 0.050, 0.160] },
    { id: 1, key: 'shelf', nameRu: 'Шельф', color: [0.060, 0.420, 0.520] },
    { id: 2, key: 'sea_ice', nameRu: 'Морской лёд', color: [0.780, 0.880, 0.940] },
    { id: 3, key: 'lake', nameRu: 'Озеро', color: [0.080, 0.350, 0.550] },
    { id: 4, key: 'polar_ice', nameRu: 'Полярный лёд', color: [0.880, 0.930, 0.970] },
    { id: 5, key: 'tundra', nameRu: 'Тундра', color: [0.480, 0.560, 0.480] },
    { id: 6, key: 'boreal_forest', nameRu: 'Тайга', color: [0.120, 0.340, 0.220] },
    { id: 7, key: 'temperate_forest', nameRu: 'Умеренный лес', color: [0.160, 0.460, 0.200] },
    { id: 8, key: 'rainforest', nameRu: 'Дождевой лес', color: [0.030, 0.320, 0.120] },
    { id: 9, key: 'grassland', nameRu: 'Степь и равнины', color: [0.520, 0.580, 0.240] },
    { id: 10, key: 'shrubland', nameRu: 'Кустарники и саванна', color: [0.580, 0.480, 0.220] },
    { id: 11, key: 'hot_desert', nameRu: 'Жаркая пустыня', color: [0.780, 0.600, 0.280] },
    { id: 12, key: 'barren', nameRu: 'Пустошь', color: [0.450, 0.400, 0.340] },
    { id: 13, key: 'alpine', nameRu: 'Высокогорье', color: [0.480, 0.460, 0.440] },
    { id: 14, key: 'volcanic', nameRu: 'Вулканическая местность', color: [0.320, 0.130, 0.080] },
    { id: 15, key: 'wetland', nameRu: 'Водно-болотные угодья', color: [0.180, 0.420, 0.300] }
  ];
  var BIOME_COUNT = BIOME_DEFINITIONS.length;
  var WATER_BIOMES = [0, 1, 2];

  var ARRAY_FIELDS = [
    'filledElevation', 'depressionDepth', 'slope',
    'flowReceiver', 'flowAccumulationKm2', 'flowAccumulationCells',
    'catchmentId', 'drainageRegionId', 'terminalType',
    'lakeId', 'lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
    'mountainWeight', 'mountainSeamWeight', 'mountainRangeId',
    'biomeTop1Id', 'biomeTop1Weight', 'biomeTop2Id', 'biomeTop2Weight',
    'biomeEntropy', 'biomeColor'
  ];

  function clamp(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }
  function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
  }
  function smoothstep(edge0, edge1, x) {
    if (edge0 === edge1) return x >= edge1 ? 1 : 0;
    var t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }
  function band(x, lo, peakLo, peakHi, hi) {
    return smoothstep(lo, peakLo, x) * (1 - smoothstep(peakHi, hi, x));
  }
  function cloneBiomeDefinitions() {
    return BIOME_DEFINITIONS.map(function (d) {
      return { id: d.id, key: d.key, nameRu: d.nameRu, color: d.color.slice() };
    });
  }

  function MinHeap() {
    this.key = new Float64Array(1024);
    this.cell = new Int32Array(1024);
    this.size = 0;
    this.outKey = 0;
    this.outCell = -1;
  }
  MinHeap.prototype.ensure = function (capacity) {
    if (capacity <= this.key.length) return;
    var next = this.key.length;
    while (next < capacity) next *= 2;
    var key = new Float64Array(next);
    var cell = new Int32Array(next);
    key.set(this.key); cell.set(this.cell);
    this.key = key; this.cell = cell;
  };
  MinHeap.prototype.push = function (key, cell) {
    this.ensure(this.size + 1);
    var k = this.key, c = this.cell;
    var i = this.size++;
    k[i] = key; c[i] = cell;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (k[parent] <= k[i]) break;
      var tk = k[parent]; k[parent] = k[i]; k[i] = tk;
      var tc = c[parent]; c[parent] = c[i]; c[i] = tc;
      i = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    if (!this.size) return false;
    var k = this.key, c = this.cell;
    this.outKey = k[0];
    this.outCell = c[0];
    this.size--;
    if (this.size) {
      k[0] = k[this.size]; c[0] = c[this.size];
      var i = 0;
      for (;;) {
        var left = i * 2 + 1, right = left + 1, smallest = i;
        if (left < this.size && k[left] < k[smallest]) smallest = left;
        if (right < this.size && k[right] < k[smallest]) smallest = right;
        if (smallest === i) break;
        var tk = k[smallest]; k[smallest] = k[i]; k[i] = tk;
        var tc = c[smallest]; c[smallest] = c[i]; c[i] = tc;
        i = smallest;
      }
    }
    return true;
  };

  function normalizeSurfaceProfile(input) {
    var src = Object.assign({}, input || {});
    var requested = src.geographyVersion != null ? src.geographyVersion : src.geography_version;
    if (requested === BASE_GEOGRAPHY_VERSION) {
      throw new Error('PlanetSurface: geographyVersion ' + BASE_GEOGRAPHY_VERSION +
        ' описывает только поля/C100 Этапа 4; для полного рецепта нужна новая ревизия ' +
        SURFACE_GEOGRAPHY_VERSION);
    }
    if (requested != null && requested !== '' && requested !== SURFACE_GEOGRAPHY_VERSION) {
      throw new Error('PlanetSurface: неподдерживаемая geographyVersion ' + requested);
    }
    var requestedHydrology = src.hydrologyVersion != null ? src.hydrologyVersion : src.hydrology_version;
    if (requestedHydrology != null && requestedHydrology !== '' && requestedHydrology !== HYDROLOGY_VERSION) {
      throw new Error('PlanetSurface: неподдерживаемая hydrologyVersion ' + requestedHydrology);
    }
    var requestedBiomes = src.biomeVersion != null ? src.biomeVersion : src.biome_version;
    if (requestedBiomes != null && requestedBiomes !== '' && requestedBiomes !== BIOME_VERSION) {
      throw new Error('PlanetSurface: неподдерживаемая biomeVersion ' + requestedBiomes);
    }
    src.geographyVersion = BASE_GEOGRAPHY_VERSION;
    var base = PlanetGeography.normalizeProfile(src);
    var profile = Object.assign({}, base);
    profile.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
    profile.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
    profile.hydrologyVersion = HYDROLOGY_VERSION;
    profile.biomeVersion = BIOME_VERSION;
    return profile;
  }

  function surfaceProfileFromBase(baseProfile) {
    var profile = Object.assign({}, baseProfile || {});
    profile.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
    profile.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
    profile.hydrologyVersion = HYDROLOGY_VERSION;
    profile.biomeVersion = BIOME_VERSION;
    return profile;
  }

  function baseProfileInput(input) {
    var surfaceProfile = normalizeSurfaceProfile(input);
    var base = Object.assign({}, surfaceProfile);
    base.geographyVersion = BASE_GEOGRAPHY_VERSION;
    return base;
  }

  function isGeographyResult(value) {
    return !!(value && value.elevation && value.muLand && value.continents &&
      value.profile && Number.isInteger(value.cellCount));
  }

  function allocateSurfaceArrays(cellCount) {
    return {
      filledElevation: new Float32Array(cellCount),
      depressionDepth: new Float32Array(cellCount),
      slope: new Float32Array(cellCount),
      flowReceiver: new Int32Array(cellCount).fill(-1),
      flowAccumulationKm2: new Float32Array(cellCount),
      flowAccumulationCells: new Float32Array(cellCount),
      catchmentId: new Int32Array(cellCount).fill(-1),
      drainageRegionId: new Int32Array(cellCount).fill(-1),
      terminalType: new Uint8Array(cellCount),
      lakeId: new Int32Array(cellCount).fill(-1),
      lakeWeight: new Float32Array(cellCount),
      streamWeight: new Float32Array(cellCount),
      riverInfluence: new Float32Array(cellCount),
      deltaWeight: new Float32Array(cellCount),
      mountainWeight: new Float32Array(cellCount),
      mountainSeamWeight: new Float32Array(cellCount),
      mountainRangeId: new Int32Array(cellCount).fill(-1),
      biomeTop1Id: new Int32Array(cellCount).fill(-1),
      biomeTop1Weight: new Float32Array(cellCount),
      biomeTop2Id: new Int32Array(cellCount).fill(-1),
      biomeTop2Weight: new Float32Array(cellCount),
      biomeEntropy: new Float32Array(cellCount),
      biomeColor: new Float32Array(cellCount * 3)
    };
  }

  function makeWeightedQuantiles(values, weights) {
    var order = [];
    var i;
    for (i = 0; i < values.length; i++) if (weights[i] > 0 && Number.isFinite(values[i])) order.push(i);
    order.sort(function (a, b) { return values[a] - values[b] || a - b; });
    var cumulative = new Float64Array(order.length);
    var total = 0;
    for (i = 0; i < order.length; i++) {
      total += weights[order[i]];
      cumulative[i] = total;
    }
    return function quantile(q) {
      if (!order.length || !(total > 0)) return 0;
      if (q <= 0) return values[order[0]];
      if (q >= 1) return values[order[order.length - 1]];
      var target = total * q;
      var lo = 0, hi = cumulative.length - 1;
      while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (cumulative[mid] >= target) hi = mid;
        else lo = mid + 1;
      }
      return values[order[lo]];
    };
  }

  function quantileSorted(sorted, q) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  }

  function distributionStats(values) {
    var sorted = Array.from(values).sort(function (a, b) { return a - b; });
    var sum = 0;
    for (var i = 0; i < sorted.length; i++) sum += sorted[i];
    return {
      count: sorted.length,
      sum: sum,
      mean: sorted.length ? sum / sorted.length : 0,
      min: sorted.length ? sorted[0] : 0,
      p10: quantileSorted(sorted, 0.10),
      median: quantileSorted(sorted, 0.50),
      p90: quantileSorted(sorted, 0.90),
      p99: quantileSorted(sorted, 0.99),
      max: sorted.length ? sorted[sorted.length - 1] : 0
    };
  }

  function assertInputs(grid, geography) {
    if (!grid || !grid.centers || !grid.areas || !grid.neighbors || !grid.neighborCount ||
        !Number.isInteger(grid.cellCount) || grid.cellCount <= 0) {
      throw new Error('PlanetSurface: нужна сетка GeodesicGrid с centers/areas/neighbors');
    }
    if (!isGeographyResult(geography)) {
      throw new Error('PlanetSurface: нужен результат PlanetGeography.generateGeography');
    }
    if (geography.cellCount !== grid.cellCount || geography.v !== grid.v) {
      throw new Error('PlanetSurface: сетка и география имеют разную форму');
    }
    if (geography.geographyVersion !== BASE_GEOGRAPHY_VERSION &&
        !(geography.baseGeography && geography.baseGeography.geographyVersion === BASE_GEOGRAPHY_VERSION)) {
      throw new Error('PlanetSurface: базовая география должна быть ' + BASE_GEOGRAPHY_VERSION);
    }
    var required = PlanetGeography.ARRAY_FIELDS;
    for (var i = 0; i < required.length; i++) {
      if (!geography[required[i]] || geography[required[i]].length !== grid.cellCount) {
        throw new Error('PlanetSurface: в географии нет массива ' + required[i]);
      }
    }
  }

  function edgeDistance(grid, a, b) {
    var dot = grid.centers[a * 3] * grid.centers[b * 3] +
      grid.centers[a * 3 + 1] * grid.centers[b * 3 + 1] +
      grid.centers[a * 3 + 2] * grid.centers[b * 3 + 2];
    return Math.sqrt(Math.max(1e-18, 2 - 2 * clamp(dot, -1, 1)));
  }

  function computePriorityFlood(grid, elevation, hardLand) {
    var n = grid.cellCount;
    var filled = new Float64Array(n);
    var parent = new Int32Array(n).fill(-1);
    var seen = new Uint8Array(n);
    var c, j, nb;
    for (c = 0; c < n; c++) filled[c] = elevation[c];
    var heap = new MinHeap();
    var hasOcean = false;
    for (c = 0; c < n; c++) {
      if (hardLand[c]) continue;
      hasOcean = true;
      var boundary = false;
      for (j = 0; j < grid.neighborCount[c]; j++) {
        if (hardLand[grid.neighbors[c * 6 + j]]) { boundary = true; break; }
      }
      if (boundary) {
        seen[c] = 1;
        heap.push(filled[c], c);
      }
    }
    if (!hasOcean) return { filled: filled, parent: parent };
    while (heap.pop()) {
      c = heap.outCell;
      if (Math.abs(filled[c] - heap.outKey) > 1e-12) continue;
      for (j = 0; j < grid.neighborCount[c]; j++) {
        nb = grid.neighbors[c * 6 + j];
        if (seen[nb] || !hardLand[nb]) continue;
        seen[nb] = 1;
        parent[nb] = c;
        filled[nb] = Math.max(elevation[nb], filled[c]);
        heap.push(filled[nb], nb);
      }
    }
    return { filled: filled, parent: parent };
  }

  function steepestReceiver(grid, height, cell) {
    var best = -1;
    var bestSlope = 1e-12;
    for (var j = 0; j < grid.neighborCount[cell]; j++) {
      var nb = grid.neighbors[cell * 6 + j];
      var slope = (height[cell] - height[nb]) / edgeDistance(grid, cell, nb);
      if (slope > bestSlope) {
        bestSlope = slope;
        best = nb;
      }
    }
    return best;
  }

  function connectedComponents(grid, mask) {
    var ids = new Int32Array(grid.cellCount).fill(-1);
    var components = [];
    var stack = [];
    for (var start = 0; start < grid.cellCount; start++) {
      if (!mask[start] || ids[start] >= 0) continue;
      var id = components.length;
      var cells = [];
      stack.length = 0;
      stack.push(start);
      ids[start] = id;
      while (stack.length) {
        var cell = stack.pop();
        cells.push(cell);
        for (var j = 0; j < grid.neighborCount[cell]; j++) {
          var nb = grid.neighbors[cell * 6 + j];
          if (mask[nb] && ids[nb] < 0) {
            ids[nb] = id;
            stack.push(nb);
          }
        }
      }
      components.push(cells);
    }
    return { ids: ids, components: components };
  }

  function surfaceLiquidFactor(surfaceClass) {
    if (surfaceClass === 'desert') return 0.55;
    if (surfaceClass === 'ice') return 0.70;
    if (surfaceClass === 'volcanic') return 0.80;
    if (surfaceClass === 'barren') return 0.10;
    return 1.0;
  }

  function lakeThresholds(surfaceClass) {
    if (surfaceClass === 'desert') return { lake: 0.54, overflow: 0.74 };
    if (surfaceClass === 'barren') return { lake: 0.70, overflow: 0.86 };
    if (surfaceClass === 'ice') return { lake: 0.40, overflow: 0.62 };
    if (surfaceClass === 'volcanic') return { lake: 0.44, overflow: 0.66 };
    return { lake: 0.34, overflow: 0.58 };
  }

  function computeSurface(grid, geography, options) {
    options = options || {};
    var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    function progress(stage, fraction) { if (onProgress) onProgress(stage, fraction); }

    var baseGeography = geography.baseGeography && geography.baseGeography.geographyVersion === BASE_GEOGRAPHY_VERSION
      ? geography.baseGeography : geography;
    assertInputs(grid, baseGeography);
    var profile = surfaceProfileFromBase(baseGeography.profile);
    var n = grid.cellCount;
    var arrays = allocateSurfaceArrays(n);
    var radiusKm = baseGeography.radiusKm || profile.radiusKm;
    var areaScale = radiusKm * radiusKm;

    var surface = Object.assign({}, baseGeography);
    surface.baseGeography = baseGeography;
    surface.geographyVersion = SURFACE_GEOGRAPHY_VERSION;
    surface.baseGeographyVersion = BASE_GEOGRAPHY_VERSION;
    surface.surfaceVersion = SURFACE_VERSION;
    surface.hydrologyVersion = HYDROLOGY_VERSION;
    surface.biomeVersion = BIOME_VERSION;
    surface.profile = profile;
    ARRAY_FIELDS.forEach(function (name) { surface[name] = arrays[name]; });
    surface.catchments = [];
    surface.drainageRegions = [];
    surface.lakes = [];
    surface.mountainRanges = [];
    surface.biomeDefinitions = cloneBiomeDefinitions();
    surface.thresholds = {};
    surface.stats = Object.assign({}, baseGeography.stats || {});

    if (!baseGeography.surfaceApplicable) {
      surface.stats.hydrology = emptyHydrologyStats(profile);
      surface.stats.biomes = emptyBiomeStats();
      surface.stats.mountains = { rangeCount: 0, mountainAreaFraction: 0, seamAreaFraction: 0 };
      progress('done', 1);
      return surface;
    }

    var elevation = baseGeography.elevation;
    var seaLevel = baseGeography.seaLevel;
    var hardLand = new Uint8Array(n);
    var landCells = [];
    var c, j, nb;
    for (c = 0; c < n; c++) {
      if (profile.oceanPctl <= 0) hardLand[c] = 1;
      else if (profile.oceanPctl < 100) hardLand[c] = elevation[c] > seaLevel ? 1 : 0;
      if (hardLand[c]) landCells.push(c);
    }

    var landWeights = new Float64Array(n);
    var totalArea = 0;
    var hardLandArea = 0;
    for (c = 0; c < n; c++) {
      totalArea += grid.areas[c];
      if (hardLand[c]) {
        landWeights[c] = grid.areas[c];
        hardLandArea += grid.areas[c];
      }
    }
    var qElevation = makeWeightedQuantiles(elevation, landWeights);
    var qMoisture = makeWeightedQuantiles(baseGeography.moisture, landWeights);
    var qTemperature = makeWeightedQuantiles(baseGeography.temperature, landWeights);
    var thresholds = {
      highlandLevel: qElevation(profile.highlandLandPctl / 100),
      mountainLevel: qElevation(profile.mountainLandPctl / 100),
      aridLevel: qMoisture(profile.aridLandPctl / 100),
      wetLevel: qMoisture(profile.wetLandPctl / 100),
      coldLevel: qTemperature(profile.coldPctl / 100),
      hotLevel: qTemperature(profile.hotPctl / 100),
      streamFlowKm2: 0,
      majorRiverFlowKm2: 0
    };
    surface.thresholds = thresholds;

    var precip01 = new Float32Array(n);
    var localRunoffKm2 = new Float64Array(n);
    var localRunoffCells = new Float64Array(n);
    var liquidFactor = surfaceLiquidFactor(profile.surfaceClass);
    if (profile.surfaceClass === 'barren' && profile.oceanPctl <= 0) liquidFactor = 0.035;
    for (c = 0; c < n; c++) {
      precip01[c] = thresholds.wetLevel > thresholds.aridLevel
        ? smoothstep(thresholds.aridLevel, thresholds.wetLevel, baseGeography.moisture[c])
        : clamp01(baseGeography.moisture[c]);
      var tempFactor = 0.45 + 0.55 * smoothstep(thresholds.coldLevel, thresholds.hotLevel, baseGeography.temperature[c]);
      var coeff = liquidFactor * tempFactor * (0.06 + 0.94 * precip01[c]);
      localRunoffKm2[c] = hardLand[c] ? grid.areas[c] * areaScale * baseGeography.muLand[c] * coeff : 0;
      localRunoffCells[c] = hardLand[c] ? baseGeography.muLand[c] : 0;
    }

    progress('hydrology-priority-flood', 0.08);
    var flood = computePriorityFlood(grid, elevation, hardLand);
    for (c = 0; c < n; c++) {
      arrays.filledElevation[c] = flood.filled[c];
      arrays.depressionDepth[c] = hardLand[c] ? Math.max(0, flood.filled[c] - elevation[c]) : 0;
    }

    progress('hydrology-flow', 0.18);
    var rawReceiver = new Int32Array(n).fill(-1);
    var filledReceiver = new Int32Array(n).fill(-1);
    var rawSlope = new Float64Array(n);
    for (c = 0; c < n; c++) {
      var maxSlope = 0;
      for (j = 0; j < grid.neighborCount[c]; j++) {
        nb = grid.neighbors[c * 6 + j];
        var slope = (elevation[c] - elevation[nb]) / edgeDistance(grid, c, nb);
        if (slope > maxSlope) maxSlope = slope;
      }
      rawSlope[c] = maxSlope;
      arrays.slope[c] = maxSlope;
      if (!hardLand[c]) continue;
      rawReceiver[c] = steepestReceiver(grid, elevation, c);
      filledReceiver[c] = steepestReceiver(grid, flood.filled, c);
      if (filledReceiver[c] < 0 && flood.parent[c] >= 0) filledReceiver[c] = flood.parent[c];
      if (filledReceiver[c] < 0) filledReceiver[c] = rawReceiver[c];
    }
    var qSlope = makeWeightedQuantiles(rawSlope, landWeights);
    thresholds.slopeP55 = qSlope(0.55);
    thresholds.slopeP70 = qSlope(0.70);
    thresholds.slopeP95 = qSlope(0.95);

    // Предварительный сырой лес нужен, чтобы оценить приток во впадины до
    // решения, является ли каждая из них озером или бессточной областью.
    var orderAsc = landCells.slice().sort(function (a, b) { return elevation[a] - elevation[b] || a - b; });
    var rawRoot = new Int32Array(n).fill(-1);
    for (c = 0; c < orderAsc.length; c++) {
      var cell = orderAsc[c];
      var rr = rawReceiver[cell];
      rawRoot[cell] = (rr < 0 || !hardLand[rr]) ? cell : rawRoot[rr];
    }
    var rawAccKm2 = new Float64Array(n);
    var rawAccCells = new Float64Array(n);
    for (c = 0; c < landCells.length; c++) {
      rawAccKm2[landCells[c]] = localRunoffKm2[landCells[c]];
      rawAccCells[landCells[c]] = localRunoffCells[landCells[c]];
    }
    for (c = orderAsc.length - 1; c >= 0; c--) {
      cell = orderAsc[c];
      rr = rawReceiver[cell];
      if (rr >= 0 && hardLand[rr]) {
        rawAccKm2[rr] += rawAccKm2[cell];
        rawAccCells[rr] += rawAccCells[cell];
      }
    }
    var rawCatchmentStats = new Map();
    for (c = 0; c < landCells.length; c++) {
      cell = landCells[c];
      var root = rawRoot[cell];
      var entry = rawCatchmentStats.get(root);
      if (!entry) {
        entry = { cellCount: 0, areaKm2: 0, precipArea: 0, weightedArea: 0 };
        rawCatchmentStats.set(root, entry);
      }
      var physicalArea = grid.areas[cell] * areaScale;
      var weighted = physicalArea * Math.max(0.02, baseGeography.muLand[cell]);
      entry.cellCount++;
      entry.areaKm2 += physicalArea;
      entry.precipArea += precip01[cell] * weighted;
      entry.weightedArea += weighted;
    }

    var depressionMask = new Uint8Array(n);
    for (c = 0; c < n; c++) depressionMask[c] = hardLand[c] && arrays.depressionDepth[c] > 1e-9 ? 1 : 0;
    var depressionComponents = connectedComponents(grid, depressionMask);
    var sinkRootsByComponent = depressionComponents.components.map(function () { return []; });
    rawCatchmentStats.forEach(function (entry, rootCell) {
      if (rawReceiver[rootCell] === -1) {
        var componentId = depressionComponents.ids[rootCell];
        if (componentId >= 0) sinkRootsByComponent[componentId].push(rootCell);
      }
    });
    var relief = Math.max(1e-9, baseGeography.elevationMax - seaLevel);
    var microDepth = Math.max(0.0015, relief * 0.004);
    var lakeCutoffs = lakeThresholds(profile.surfaceClass);
    var lakeDistance = new Int32Array(n).fill(-1);
    var depressionInfo = [];
    arrays.flowReceiver.set(filledReceiver);

    for (var compIndex = 0; compIndex < depressionComponents.components.length; compIndex++) {
      var cells = depressionComponents.components[compIndex];
      var info = {
        id: compIndex,
        cells: cells,
        cellCount: cells.length,
        areaKm2: 0,
        maxDepth: 0,
        volumeProxyKm2: 0,
        localPrecipArea: 0,
        localWeightedArea: 0,
        outletCell: -1,
        downstreamCell: -1,
        spillElevation: 0,
        sinkRoots: [],
        inflowKm2: 0,
        inflowCells: 0,
        upstreamPrecip: 0,
        wetness: 0,
        mode: 'filled'
      };
      var bestOutletScore = Infinity;
      for (c = 0; c < cells.length; c++) {
        cell = cells[c];
        var areaKm2 = grid.areas[cell] * areaScale;
        info.areaKm2 += areaKm2;
        info.maxDepth = Math.max(info.maxDepth, arrays.depressionDepth[cell]);
        info.volumeProxyKm2 += arrays.depressionDepth[cell] * areaKm2;
        var w = areaKm2 * Math.max(0.02, baseGeography.muLand[cell]);
        info.localPrecipArea += precip01[cell] * w;
        info.localWeightedArea += w;
        var fp = flood.parent[cell];
        if (fp >= 0 && depressionComponents.ids[fp] !== compIndex) {
          var score = flood.filled[cell] * 1000 + flood.filled[fp];
          if (score < bestOutletScore) {
            bestOutletScore = score;
            info.outletCell = cell;
            info.downstreamCell = fp;
            info.spillElevation = flood.filled[cell];
          }
        }
      }
      var componentSinkRoots = sinkRootsByComponent[compIndex];
      for (c = 0; c < componentSinkRoots.length; c++) {
        var sinkRoot = componentSinkRoots[c];
        var sinkEntry = rawCatchmentStats.get(sinkRoot);
        info.sinkRoots.push(sinkRoot);
        info.inflowKm2 += rawAccKm2[sinkRoot];
        info.inflowCells += rawAccCells[sinkRoot];
        if (sinkEntry) {
          info.upstreamPrecip += sinkEntry.precipArea;
          info._upstreamWeightedArea = (info._upstreamWeightedArea || 0) + sinkEntry.weightedArea;
        }
      }
      var localPrecip = info.localWeightedArea > 0 ? info.localPrecipArea / info.localWeightedArea : 0;
      var upstreamPrecip = info._upstreamWeightedArea > 0 ? info.upstreamPrecip / info._upstreamWeightedArea : localPrecip;
      info.wetness = clamp01(0.72 * upstreamPrecip + 0.28 * localPrecip);
      delete info._upstreamWeightedArea;
      var significant = info.maxDepth > microDepth;
      if (!significant) info.mode = 'filled';
      else if (info.outletCell >= 0 && info.wetness >= lakeCutoffs.overflow) info.mode = 'overflow_lake';
      else if (info.wetness >= lakeCutoffs.lake) info.mode = 'terminal_lake';
      else info.mode = 'endorheic';
      if (profile.surfaceClass === 'barren' && profile.oceanPctl <= 0) {
        info.mode = significant ? 'endorheic' : 'filled';
      }
      depressionInfo.push(info);

      if (info.mode === 'endorheic' || info.mode === 'terminal_lake') {
        for (c = 0; c < cells.length; c++) arrays.flowReceiver[cells[c]] = rawReceiver[cells[c]];
      } else if (info.mode === 'overflow_lake' && info.outletCell >= 0) {
        var queue = new Int32Array(cells.length);
        var qHead = 0, qTail = 0;
        lakeDistance[info.outletCell] = 0;
        arrays.flowReceiver[info.outletCell] = info.downstreamCell;
        queue[qTail++] = info.outletCell;
        while (qHead < qTail) {
          cell = queue[qHead++];
          for (j = 0; j < grid.neighborCount[cell]; j++) {
            nb = grid.neighbors[cell * 6 + j];
            if (depressionComponents.ids[nb] === compIndex && lakeDistance[nb] < 0) {
              lakeDistance[nb] = lakeDistance[cell] + 1;
              arrays.flowReceiver[nb] = cell;
              queue[qTail++] = nb;
            }
          }
        }
      }
    }

    // Озёрные следы: переполняющееся озеро занимает всю заполненную впадину,
    // терминальное — только её глубокую часть и фактические стоки. Части
    // ищутся локально внутри впадины, без сканирования всей планеты на
    // каждую из сотен депрессий.
    var lakeRecords = [];
    var lakeCandidateStamp = new Int32Array(n).fill(-1);
    var lakeSeenStamp = new Int32Array(n).fill(-1);
    for (compIndex = 0; compIndex < depressionInfo.length; compIndex++) {
      info = depressionInfo[compIndex];
      if (info.mode !== 'overflow_lake' && info.mode !== 'terminal_lake') continue;
      var depthThreshold = info.mode === 'overflow_lake' ? 0 : info.maxDepth * 0.45;
      var lakeCandidates = [];
      for (c = 0; c < info.cells.length; c++) {
        cell = info.cells[c];
        if (arrays.depressionDepth[cell] >= depthThreshold) {
          lakeCandidateStamp[cell] = compIndex;
          lakeCandidates.push(cell);
        }
      }
      for (c = 0; c < info.sinkRoots.length; c++) {
        cell = info.sinkRoots[c];
        if (lakeCandidateStamp[cell] !== compIndex) {
          lakeCandidateStamp[cell] = compIndex;
          lakeCandidates.push(cell);
        }
      }
      var lakeParts = [];
      for (c = 0; c < lakeCandidates.length; c++) {
        cell = lakeCandidates[c];
        if (lakeSeenStamp[cell] === compIndex) continue;
        var part = [];
        var stack = [cell];
        lakeSeenStamp[cell] = compIndex;
        while (stack.length) {
          var current = stack.pop();
          part.push(current);
          for (j = 0; j < grid.neighborCount[current]; j++) {
            nb = grid.neighbors[current * 6 + j];
            if (lakeCandidateStamp[nb] === compIndex && lakeSeenStamp[nb] !== compIndex) {
              lakeSeenStamp[nb] = compIndex;
              stack.push(nb);
            }
          }
        }
        lakeParts.push(part);
      }
      for (var partIndex = 0; partIndex < lakeParts.length; partIndex++) {
        var lakeCells = lakeParts[partIndex];
        var lakeId = lakeRecords.length;
        var representative = lakeCells[0];
        var effectiveArea = 0;
        for (c = 0; c < lakeCells.length; c++) {
          cell = lakeCells[c];
          if (arrays.depressionDepth[cell] > arrays.depressionDepth[representative]) representative = cell;
          var weight;
          if (info.mode === 'overflow_lake') {
            weight = 0.30 + 0.70 * Math.sqrt(clamp01(arrays.depressionDepth[cell] / Math.max(1e-12, info.maxDepth)));
          } else {
            weight = 0.25 + 0.75 * smoothstep(depthThreshold, info.maxDepth, arrays.depressionDepth[cell]);
          }
          arrays.lakeId[cell] = lakeId;
          arrays.lakeWeight[cell] = clamp01(weight);
          effectiveArea += grid.areas[cell] * areaScale * arrays.lakeWeight[cell];
        }
        lakeRecords.push({
          id: lakeId,
          representativeCell: representative,
          outletCell: info.mode === 'overflow_lake' ? info.outletCell : representative,
          downstreamCell: info.mode === 'overflow_lake' ? info.downstreamCell : -1,
          overflowing: info.mode === 'overflow_lake',
          cellCount: lakeCells.length,
          effectiveAreaKm2: effectiveArea,
          maxDepth: info.maxDepth,
          spillElevation: info.spillElevation || flood.filled[representative],
          catchmentId: -1,
          depressionId: info.id
        });
      }
    }
    surface.lakes = lakeRecords;

    progress('hydrology-accumulation', 0.34);
    var topo = accumulateFlow(grid, hardLand, landCells, arrays, localRunoffKm2, localRunoffCells, flood.filled);
    var flowOrder = topo.order;

    var rootCellOf = new Int32Array(n).fill(-1);
    for (c = flowOrder.length - 1; c >= 0; c--) {
      cell = flowOrder[c];
      rr = arrays.flowReceiver[cell];
      rootCellOf[cell] = (rr < 0 || !hardLand[rr]) ? cell : rootCellOf[rr];
    }
    var uniqueRoots = [];
    var rootSeen = new Uint8Array(n);
    for (c = 0; c < landCells.length; c++) {
      var r = rootCellOf[landCells[c]];
      if (r >= 0 && !rootSeen[r]) { rootSeen[r] = 1; uniqueRoots.push(r); }
    }
    uniqueRoots.sort(function (a, b) { return a - b; });
    var rootToCatchment = new Int32Array(n).fill(-1);
    var catchmentRecords = uniqueRoots.map(function (rootCell, id) {
      rootToCatchment[rootCell] = id;
      var receiver = arrays.flowReceiver[rootCell];
      var type = receiver >= 0 && !hardLand[receiver] ? TERMINAL_OCEAN
        : (arrays.lakeId[rootCell] >= 0 ? TERMINAL_LAKE : TERMINAL_ENDORHEIC);
      return {
        id: id,
        rootCell: rootCell,
        outletCell: rootCell,
        downstreamCell: receiver,
        terminalType: TERMINAL_TYPE_NAMES[type],
        terminalTypeCode: type,
        cellCount: 0,
        areaKm2: 0,
        effectiveLandAreaKm2: 0,
        maxFlowKm2: arrays.flowAccumulationKm2[rootCell],
        maxFlowCells: arrays.flowAccumulationCells[rootCell],
        lakeId: arrays.lakeId[rootCell]
      };
    });
    for (c = 0; c < landCells.length; c++) {
      cell = landCells[c];
      var cid = rootToCatchment[rootCellOf[cell]];
      arrays.catchmentId[cell] = cid;
      var record = catchmentRecords[cid];
      arrays.terminalType[cell] = record.terminalTypeCode;
      record.cellCount++;
      record.areaKm2 += grid.areas[cell] * areaScale;
      record.effectiveLandAreaKm2 += grid.areas[cell] * areaScale * baseGeography.muLand[cell];
    }
    surface.catchments = catchmentRecords;
    for (c = 0; c < surface.lakes.length; c++) {
      var lake = surface.lakes[c];
      lake.catchmentId = arrays.catchmentId[lake.representativeCell];
    }

    var qFlow = makeWeightedQuantiles(arrays.flowAccumulationKm2, landWeights);
    thresholds.streamFlowKm2 = qFlow(profile.streamFlowPctl / 100);
    thresholds.majorRiverFlowKm2 = qFlow(profile.majorRiverFlowPctl / 100);
    if (!(thresholds.majorRiverFlowKm2 > thresholds.streamFlowKm2)) {
      thresholds.majorRiverFlowKm2 = Math.max(thresholds.streamFlowKm2 * 4, thresholds.streamFlowKm2 + 1e-9);
    }
    computeStreamAndDelta(grid, baseGeography, arrays, hardLand, thresholds, liquidFactor);

    progress('drainage-regions', 0.48);
    surface.drainageRegions = buildDrainageRegions(
      grid, baseGeography, arrays, hardLand, landCells, flowOrder, profile, areaScale
    );

    progress('mountains', 0.60);
    var mountainStats = computeMountains(grid, baseGeography, arrays, hardLand, thresholds, areaScale);
    surface.mountainRanges = mountainStats.ranges;

    progress('biomes', 0.72);
    var biomeStats = computeBiomes(grid, baseGeography, arrays, hardLand, profile, thresholds);
    surface.stats.hydrology = computeHydrologyStats(
      grid, baseGeography, arrays, hardLand, landCells.length, hardLandArea, totalArea,
      catchmentRecords, surface.drainageRegions, depressionInfo, topo.cycleBreakCount, profile, thresholds
    );
    surface.stats.biomes = biomeStats;
    surface.stats.mountains = mountainStats.stats;
    progress('done', 1);
    return surface;
  }

  function accumulateFlow(grid, hardLand, landCells, arrays, localRunoffKm2, localRunoffCells, filled) {
    var n = grid.cellCount;
    var upstreamRemaining = new Int32Array(n);
    var processed = new Uint8Array(n);
    var queue = new Int32Array(n);
    var qHead = 0, qTail = 0;
    var order = [];
    var c, cell, receiver;
    for (c = 0; c < landCells.length; c++) {
      cell = landCells[c];
      arrays.flowAccumulationKm2[cell] = localRunoffKm2[cell];
      arrays.flowAccumulationCells[cell] = localRunoffCells[cell];
      receiver = arrays.flowReceiver[cell];
      if (receiver >= 0 && hardLand[receiver]) upstreamRemaining[receiver]++;
    }
    for (c = 0; c < landCells.length; c++) {
      cell = landCells[c];
      if (upstreamRemaining[cell] === 0) queue[qTail++] = cell;
    }
    function drainQueue() {
      while (qHead < qTail) {
        cell = queue[qHead++];
        if (processed[cell]) continue;
        processed[cell] = 1;
        order.push(cell);
        receiver = arrays.flowReceiver[cell];
        if (receiver >= 0 && hardLand[receiver]) {
          arrays.flowAccumulationKm2[receiver] += arrays.flowAccumulationKm2[cell];
          arrays.flowAccumulationCells[receiver] += arrays.flowAccumulationCells[cell];
          upstreamRemaining[receiver]--;
          if (upstreamRemaining[receiver] === 0) queue[qTail++] = receiver;
        }
      }
    }
    drainQueue();
    var cycleBreakCount = 0;
    if (order.length < landCells.length) {
      var remaining = landCells.filter(function (x) { return !processed[x]; });
      remaining.sort(function (a, b) { return filled[a] - filled[b] || a - b; });
      for (c = 0; c < remaining.length && order.length < landCells.length; c++) {
        cell = remaining[c];
        if (processed[cell]) continue;
        receiver = arrays.flowReceiver[cell];
        if (receiver >= 0 && hardLand[receiver]) {
          arrays.flowReceiver[cell] = -1;
          upstreamRemaining[receiver]--;
          cycleBreakCount++;
          if (upstreamRemaining[receiver] === 0) queue[qTail++] = receiver;
        }
        if (upstreamRemaining[cell] === 0) queue[qTail++] = cell;
        drainQueue();
      }
    }
    return { order: order, cycleBreakCount: cycleBreakCount };
  }

  function computeStreamAndDelta(grid, geography, arrays, hardLand, thresholds, liquidFactor) {
    var stream = Math.max(1e-12, thresholds.streamFlowKm2);
    var major = Math.max(stream * 1.000001, thresholds.majorRiverFlowKm2);
    var logStream = Math.log1p(stream);
    var logMajor = Math.log1p(major);
    var logLow = Math.log1p(stream * 0.35);
    var c, j, nb;
    for (c = 0; c < grid.cellCount; c++) {
      if (!hardLand[c]) continue;
      var logFlow = Math.log1p(Math.max(0, arrays.flowAccumulationKm2[c]));
      var weight;
      if (logFlow <= logLow) weight = 0;
      else if (logFlow < logStream) weight = 0.32 * smoothstep(logLow, logStream, logFlow);
      else weight = 0.32 + 0.68 * smoothstep(logStream, logMajor, logFlow);
      weight *= liquidFactor * (0.35 + 0.65 * geography.muLand[c]);
      if (arrays.lakeWeight[c] > 0.65) weight *= 0.25;
      arrays.streamWeight[c] = clamp01(weight);
      arrays.riverInfluence[c] = arrays.streamWeight[c];
    }

    // Дельты: только устья в океан и соседний шельф, никаких случайных
    // дельт в открытом океане.
    for (c = 0; c < grid.cellCount; c++) {
      if (!hardLand[c]) continue;
      var receiver = arrays.flowReceiver[c];
      if (receiver < 0 || hardLand[receiver]) continue;
      var flowScore = smoothstep(logStream, Math.log1p(major * 1.5), Math.log1p(arrays.flowAccumulationKm2[c]));
      if (flowScore <= 0) continue;
      var slopeFactor = 1 - smoothstep(thresholds.slopeP70, thresholds.slopeP95, arrays.slope[c]);
      var base = clamp01(flowScore * (0.35 + 0.65 * slopeFactor) * liquidFactor);
      if (base <= 0.03) continue;
      arrays.deltaWeight[c] = Math.max(arrays.deltaWeight[c], base);
      for (j = 0; j < grid.neighborCount[c]; j++) {
        nb = grid.neighbors[c * 6 + j];
        if (hardLand[nb]) {
          arrays.deltaWeight[nb] = Math.max(arrays.deltaWeight[nb], base * 0.38);
        } else if (geography.signedCoastDistanceCells[nb] >= -3) {
          arrays.deltaWeight[nb] = Math.max(arrays.deltaWeight[nb],
            base * 0.70 * (0.35 + 0.65 * geography.muShelf[nb]));
        }
      }
    }
    var first = new Float32Array(arrays.riverInfluence);
    for (c = 0; c < grid.cellCount; c++) {
      var best = first[c];
      for (j = 0; j < grid.neighborCount[c]; j++) {
        nb = grid.neighbors[c * 6 + j];
        best = Math.max(best, first[nb] * 0.55);
      }
      arrays.riverInfluence[c] = best;
    }
    var second = new Float32Array(arrays.riverInfluence);
    for (c = 0; c < grid.cellCount; c++) {
      best = second[c];
      for (j = 0; j < grid.neighborCount[c]; j++) {
        nb = grid.neighbors[c * 6 + j];
        best = Math.max(best, second[nb] * 0.35);
      }
      arrays.riverInfluence[c] = clamp01(Math.max(best, arrays.lakeWeight[c] * 0.85, arrays.deltaWeight[c] * 0.80));
    }
  }

  function buildDrainageRegions(grid, geography, arrays, hardLand, landCells, flowOrder, profile, areaScale) {
    var n = grid.cellCount;
    var target = Math.max(1, profile.drainageMeanCells || 1);
    var pending = new Array(n).fill(null);
    var initial = [];
    var c, cell, receiver;
    function mergeLists(a, b) {
      if (!a) return b;
      if (!b) return a;
      if (a.length < b.length) { var tmp = a; a = b; b = tmp; }
      for (var i = 0; i < b.length; i++) a.push(b[i]);
      return a;
    }
    for (c = 0; c < flowOrder.length; c++) {
      cell = flowOrder[c];
      var list = pending[cell] || [];
      pending[cell] = null;
      list.push(cell);
      receiver = arrays.flowReceiver[cell];
      if (receiver >= 0 && hardLand[receiver]) {
        if (list.length >= target) initial.push(list);
        else pending[receiver] = mergeLists(pending[receiver], list);
      } else {
        initial.push(list);
      }
    }

    var segmentId = new Int32Array(n).fill(-1);
    var segments = initial.map(function (cells, id) {
      var catchmentSet = new Set();
      var landmassCounts = new Map();
      var minCell = Infinity;
      var outletCell = cells[0];
      for (var i = 0; i < cells.length; i++) {
        var x = cells[i];
        segmentId[x] = id;
        minCell = Math.min(minCell, x);
        catchmentSet.add(arrays.catchmentId[x]);
        var lm = geography.physicalLandmassId[x];
        if (lm >= 0) landmassCounts.set(lm, (landmassCounts.get(lm) || 0) + 1);
        if (arrays.flowAccumulationCells[x] > arrays.flowAccumulationCells[outletCell]) outletCell = x;
      }
      var dominantLandmass = -1, bestCount = -1;
      landmassCounts.forEach(function (count, lm) {
        if (count > bestCount) { bestCount = count; dominantLandmass = lm; }
      });
      return {
        id: id, alive: true, cells: cells, size: cells.length, minCell: minCell,
        catchments: catchmentSet, dominantLandmass: dominantLandmass,
        outletCell: outletCell, neighbors: new Set()
      };
    });
    for (c = 0; c < landCells.length; c++) {
      cell = landCells[c];
      var sid = segmentId[cell];
      for (var j = 0; j < grid.neighborCount[cell]; j++) {
        var nb = grid.neighbors[cell * 6 + j];
        if (!hardLand[nb]) continue;
        var other = segmentId[nb];
        if (other >= 0 && other !== sid) {
          segments[sid].neighbors.add(other);
          segments[other].neighbors.add(sid);
        }
      }
    }

    function mergeSegments(survivor, removed) {
      if (survivor === removed || !survivor.alive || !removed.alive) return;
      for (var i = 0; i < removed.cells.length; i++) {
        survivor.cells.push(removed.cells[i]);
        segmentId[removed.cells[i]] = survivor.id;
      }
      survivor.size = survivor.cells.length;
      survivor.minCell = Math.min(survivor.minCell, removed.minCell);
      removed.catchments.forEach(function (id) { survivor.catchments.add(id); });
      if (arrays.flowAccumulationCells[removed.outletCell] > arrays.flowAccumulationCells[survivor.outletCell]) {
        survivor.outletCell = removed.outletCell;
      }
      removed.neighbors.forEach(function (otherId) {
        var other = segments[otherId];
        if (!other || !other.alive) return;
        other.neighbors.delete(removed.id);
        if (other.id !== survivor.id) {
          other.neighbors.add(survivor.id);
          survivor.neighbors.add(other.id);
        }
      });
      survivor.neighbors.delete(removed.id);
      survivor.neighbors.delete(survivor.id);
      removed.alive = false;
      removed.cells = [];
      removed.neighbors.clear();
    }

    var mergeThreshold = target * 0.85;
    for (var pass = 0; pass < 16; pass++) {
      var active = segments.filter(function (s) { return s.alive; })
        .sort(function (a, b) { return a.size - b.size || a.minCell - b.minCell; });
      var changed = false;
      for (c = 0; c < active.length; c++) {
        var seg = active[c];
        if (!seg.alive || seg.size >= mergeThreshold) continue;
        var bestSeg = null;
        var bestScore = Infinity;
        seg.neighbors.forEach(function (otherId) {
          var other = segments[otherId];
          if (!other || !other.alive || other === seg) return;
          if (seg.dominantLandmass >= 0 && other.dominantLandmass >= 0 &&
              seg.dominantLandmass !== other.dominantLandmass) return;
          var sharedCatchment = false;
          seg.catchments.forEach(function (id) { if (other.catchments.has(id)) sharedCatchment = true; });
          var score = seg.size + other.size - (sharedCatchment ? target * 0.75 : 0);
          if (score < bestScore) { bestScore = score; bestSeg = other; }
        });
        if (!bestSeg) continue;
        if (seg.size + bestSeg.size > target * 2.25 && seg.size > target * 0.25) continue;
        var survivor = bestSeg.size >= seg.size ? bestSeg : seg;
        var removed = survivor === seg ? bestSeg : seg;
        mergeSegments(survivor, removed);
        changed = true;
      }
      if (!changed) break;
    }

    var finalSegments = segments.filter(function (s) { return s.alive; })
      .sort(function (a, b) { return a.minCell - b.minCell; });
    var records = finalSegments.map(function (seg, id) {
      var areaKm2 = 0;
      var effectiveLandAreaKm2 = 0;
      for (var i = 0; i < seg.cells.length; i++) {
        var x = seg.cells[i];
        arrays.drainageRegionId[x] = id;
        areaKm2 += grid.areas[x] * areaScale;
        effectiveLandAreaKm2 += grid.areas[x] * areaScale * geography.muLand[x];
      }
      var outletCatchment = arrays.catchmentId[seg.outletCell];
      return {
        id: id,
        outletCell: seg.outletCell,
        cellCount: seg.cells.length,
        areaKm2: areaKm2,
        effectiveLandAreaKm2: effectiveLandAreaKm2,
        catchmentCount: seg.catchments.size,
        catchmentIds: Array.from(seg.catchments).sort(function (a, b) { return a - b; }),
        terminalType: TERMINAL_TYPE_NAMES[arrays.terminalType[seg.outletCell]] || 'none',
        dominantCatchmentId: outletCatchment,
        physicalLandmassId: seg.dominantLandmass
      };
    });
    return records;
  }

  function computeMountains(grid, geography, arrays, hardLand, thresholds, areaScale) {
    var c;
    var mountainArea = 0, seamArea = 0, landArea = 0;
    for (c = 0; c < grid.cellCount; c++) {
      if (!hardLand[c]) continue;
      landArea += grid.areas[c];
      var heightScore = thresholds.mountainLevel > thresholds.highlandLevel
        ? smoothstep(thresholds.highlandLevel, thresholds.mountainLevel, geography.elevation[c])
        : (geography.elevation[c] >= thresholds.mountainLevel ? 1 : 0);
      var slopeScore = smoothstep(thresholds.slopeP55, thresholds.slopeP95, arrays.slope[c]);
      var mountain = geography.muLand[c] * heightScore * (0.45 + 0.55 * slopeScore);
      var seamRelief = thresholds.mountainLevel > thresholds.highlandLevel
        ? smoothstep(
            thresholds.highlandLevel - (thresholds.mountainLevel - thresholds.highlandLevel) * 0.35,
            thresholds.mountainLevel, geography.elevation[c])
        : heightScore;
      var seam = geography.muLand[c] * seamRelief *
        smoothstep(0.28, 0.88, geography.plateBoundary[c]) *
        (0.38 + 0.38 * slopeScore + 0.24 * geography.volcanism[c]);
      arrays.mountainWeight[c] = clamp01(mountain);
      arrays.mountainSeamWeight[c] = clamp01(seam);
      mountainArea += arrays.mountainWeight[c] * grid.areas[c];
      seamArea += arrays.mountainSeamWeight[c] * grid.areas[c];
    }
    var mask = new Uint8Array(grid.cellCount);
    for (c = 0; c < grid.cellCount; c++) mask[c] = hardLand[c] && arrays.mountainSeamWeight[c] >= 0.42 ? 1 : 0;
    var comps = connectedComponents(grid, mask).components
      .filter(function (cells) { return cells.length >= 3; });
    var ranges = comps.map(function (cells, id) {
      var areaKm2 = 0;
      var maxElevation = -Infinity;
      var representative = cells[0];
      var plateCounts = new Float64Array(PlanetGeography.PLATE_COUNT);
      for (var i = 0; i < cells.length; i++) {
        var x = cells[i];
        arrays.mountainRangeId[x] = id;
        areaKm2 += grid.areas[x] * areaScale;
        if (geography.elevation[x] > maxElevation) {
          maxElevation = geography.elevation[x];
          representative = x;
        }
        if (geography.plateId[x] >= 0) plateCounts[geography.plateId[x]]++;
      }
      var plates = Array.from(plateCounts).map(function (count, plateId) {
        return { plateId: plateId, count: count };
      }).filter(function (x) { return x.count > 0; })
        .sort(function (a, b) { return b.count - a.count; })
        .slice(0, 2).map(function (x) { return x.plateId; });
      return {
        id: id,
        representativeCell: representative,
        cellCount: cells.length,
        areaKm2: areaKm2,
        maxElevation: maxElevation,
        plateIds: plates
      };
    });
    return {
      ranges: ranges,
      stats: {
        rangeCount: ranges.length,
        mountainAreaFraction: landArea ? mountainArea / landArea : 0,
        seamAreaFraction: landArea ? seamArea / landArea : 0,
        distribution: distributionStats(ranges.map(function (r) { return r.cellCount; }))
      }
    };
  }

  function computeBiomes(grid, geography, arrays, hardLand, profile, thresholds) {
    var n = grid.cellCount;
    var weights = new Float32Array(n * BIOME_COUNT);
    var score = new Float64Array(BIOME_COUNT);
    var tempSpan = Math.max(0.05, thresholds.hotLevel - thresholds.coldLevel);
    var moistSpan = Math.max(0.05, thresholds.wetLevel - thresholds.aridLevel);
    var vegFactor = profile.surfaceClass === 'barren' ? 0.05
      : profile.surfaceClass === 'desert' ? 0.45
      : profile.surfaceClass === 'volcanic' ? 0.65 : 1.0;
    var iceAvailability = profile.surfaceClass === 'barren' && profile.oceanPctl <= 0 ? 0.25 : 1.0;
    var hotDesertFactor = profile.surfaceClass === 'barren' ? 0.15
      : profile.surfaceClass === 'desert' ? 1.45 : 1.0;
    var c, b;
    for (c = 0; c < n; c++) {
      score.fill(0);
      var waterMask = clamp01(geography.muOcean[c] + geography.muShelf[c]);
      var landMask = clamp01(geography.muLand[c] + (hardLand[c] ? 0.12 : 0));
      var temp = geography.temperature[c];
      var effMoisture = clamp01(geography.moisture[c] + arrays.riverInfluence[c] * 0.22 +
        arrays.lakeWeight[c] * 0.25 + arrays.deltaWeight[c] * 0.10 -
        (profile.surfaceClass === 'desert' ? 0.10 : 0));
      var coldScore = 1 - smoothstep(thresholds.coldLevel - tempSpan * 0.10,
        thresholds.coldLevel + tempSpan * 0.35, temp);
      var iceScore = 1 - smoothstep(thresholds.coldLevel - tempSpan * 0.35,
        thresholds.coldLevel + tempSpan * 0.05, temp);
      if (profile.surfaceClass === 'ice') iceScore = clamp01(iceScore * 1.15 + 0.10);
      iceScore *= iceAvailability;
      var coolScore = band(temp, thresholds.coldLevel - tempSpan * 0.05,
        thresholds.coldLevel + tempSpan * 0.22, thresholds.coldLevel + tempSpan * 0.58,
        thresholds.hotLevel - tempSpan * 0.05);
      var mildScore = band(temp, thresholds.coldLevel + tempSpan * 0.15,
        thresholds.coldLevel + tempSpan * 0.45, thresholds.hotLevel - tempSpan * 0.05,
        thresholds.hotLevel + tempSpan * 0.35);
      var hotScore = smoothstep(thresholds.hotLevel - tempSpan * 0.30,
        thresholds.hotLevel + tempSpan * 0.12, temp);
      var dryScore = 1 - smoothstep(thresholds.aridLevel, thresholds.wetLevel, effMoisture);
      var wetScore = smoothstep(thresholds.aridLevel, thresholds.wetLevel, effMoisture);
      var veryWetScore = smoothstep(thresholds.wetLevel, thresholds.wetLevel + moistSpan * 0.55, effMoisture);
      var midMoistScore = band(effMoisture, thresholds.aridLevel - moistSpan * 0.25,
        thresholds.aridLevel + moistSpan * 0.25, thresholds.wetLevel - moistSpan * 0.05,
        thresholds.wetLevel + moistSpan * 0.45);
      var depthNorm = geography.seaLevel > geography.elevationMin
        ? clamp01((geography.seaLevel - geography.elevation[c]) / (geography.seaLevel - geography.elevationMin)) : 0;
      var landHeight = geography.elevationMax > geography.seaLevel
        ? clamp01((geography.elevation[c] - geography.seaLevel) / (geography.elevationMax - geography.seaLevel)) : 0;
      var slopeScore = smoothstep(thresholds.slopeP55, thresholds.slopeP95, arrays.slope[c]);
      var mountain = arrays.mountainWeight[c];
      var coastProximity = Math.exp(-Math.max(0, geography.signedCoastDistanceCells[c]) / 4);

      var shelfBand = geography.shelfBelowLevel < geography.seaLevel
        ? smoothstep(geography.shelfBelowLevel, geography.seaLevel, geography.elevation[c]) : 0;
      score[0] = waterMask * (1 - shelfBand) * (0.35 + 0.65 * smoothstep(0.02, 0.30, depthNorm));
      score[1] = waterMask * (geography.muShelf[c] * 1.80 + shelfBand * 0.55 + arrays.deltaWeight[c] * 0.35);
      score[2] = waterMask * iceScore * 1.25;
      score[3] = arrays.lakeWeight[c] * 2.20;

      score[4] = landMask * iceScore * (0.75 + 0.35 * mountain);
      score[5] = landMask * coldScore * (1 - iceScore * 0.75) * (1 - mountain * 0.45) * Math.max(vegFactor, 0.25);
      score[6] = landMask * coolScore * (0.35 + 0.65 * wetScore) * (1 - mountain * 0.65) * vegFactor;
      score[7] = landMask * mildScore * wetScore * (1 - hotScore * 0.45) * (1 - mountain * 0.60) * vegFactor;
      score[8] = landMask * hotScore * veryWetScore * (1 - mountain * 0.50) * vegFactor;
      score[9] = landMask * (mildScore * 0.70 + hotScore * 0.35) * midMoistScore *
        (1 - slopeScore * 0.35) * (1 - mountain * 0.55) * vegFactor;
      score[10] = landMask * (hotScore * 0.72 + mildScore * 0.28) *
        band(effMoisture, thresholds.aridLevel - moistSpan * 0.45, thresholds.aridLevel + moistSpan * 0.10,
          thresholds.wetLevel - moistSpan * 0.25, thresholds.wetLevel + moistSpan * 0.20) *
        (1 - mountain * 0.45) * Math.max(vegFactor, 0.20);
      score[11] = landMask * hotScore * dryScore * hotDesertFactor;
      score[12] = landMask * (dryScore * (0.22 + coldScore * 0.45) +
        (profile.surfaceClass === 'barren' ? 0.90 : 0)) *
        (profile.surfaceClass === 'barren' ? 0.65 + 0.35 * slopeScore : 0.45 + 0.55 * slopeScore);
      score[13] = landMask * mountain * 1.30;
      score[14] = landMask * Math.pow(geography.volcanism[c], 1.5) *
        (0.22 + 0.78 * Math.max(mountain, arrays.mountainSeamWeight[c])) *
        (profile.surfaceClass === 'volcanic' ? 1.80 : 0.80);
      var wetlandDriver = clamp01(0.20 + arrays.riverInfluence[c] * 0.55 +
        arrays.lakeWeight[c] * 0.45 + arrays.deltaWeight[c] * 0.65 + coastProximity * 0.18);
      score[15] = landMask * wetScore * (1 - slopeScore) * (1 - landHeight * 0.75) *
        wetlandDriver * vegFactor;

      var sum = 0;
      for (b = 0; b < BIOME_COUNT; b++) {
        if (!(score[b] > 0)) score[b] = 0;
        sum += score[b];
      }
      if (!(sum > 0)) {
        score[hardLand[c] ? 12 : 0] = 1;
        sum = 1;
      }
      for (b = 0; b < BIOME_COUNT; b++) weights[c * BIOME_COUNT + b] = score[b] / sum;
    }

    smoothBiomeWeights(grid, geography, arrays, weights, hardLand, profile.biomeSoftWidthCells);

    var globalSums = new Float64Array(BIOME_COUNT);
    var landSums = new Float64Array(BIOME_COUNT);
    var top1Sums = new Float64Array(BIOME_COUNT);
    var totalArea = 0, landArea = 0, entropyWeighted = 0;
    for (c = 0; c < n; c++) {
      var base = c * BIOME_COUNT;
      var top1 = -1, top2 = -1, w1 = -1, w2 = -1;
      var r = 0, g = 0, bl = 0;
      for (b = 0; b < BIOME_COUNT; b++) {
        var w = weights[base + b];
        globalSums[b] += w * grid.areas[c];
        if (hardLand[c]) landSums[b] += w * grid.areas[c];
        var color = BIOME_DEFINITIONS[b].color;
        r += color[0] * w; g += color[1] * w; bl += color[2] * w;
        if (w > w1) { top2 = top1; w2 = w1; top1 = b; w1 = w; }
        else if (w > w2) { top2 = b; w2 = w; }
      }
      totalArea += grid.areas[c];
      if (hardLand[c]) landArea += grid.areas[c];
      var topSum = w1 + Math.max(0, w2);
      var p1 = topSum > 0 ? w1 / topSum : 1;
      var p2 = topSum > 0 && top2 >= 0 ? Math.max(0, w2) / topSum : 0;
      arrays.biomeTop1Id[c] = top1;
      arrays.biomeTop1Weight[c] = p1;
      arrays.biomeTop2Id[c] = top2;
      arrays.biomeTop2Weight[c] = p2;
      var entropy = 0;
      if (p1 > 0) entropy -= p1 * Math.log(p1);
      if (p2 > 0) entropy -= p2 * Math.log(p2);
      arrays.biomeEntropy[c] = entropy / Math.LN2;
      entropyWeighted += arrays.biomeEntropy[c] * grid.areas[c];
      if (top1 >= 0) top1Sums[top1] += grid.areas[c];
      var shade = clamp(0.94 + geography.detail[c] * 0.08 + arrays.mountainWeight[c] * 0.05, 0.82, 1.12);
      arrays.biomeColor[c * 3] = clamp01(r * shade);
      arrays.biomeColor[c * 3 + 1] = clamp01(g * shade);
      arrays.biomeColor[c * 3 + 2] = clamp01(bl * shade);
    }
    var fractions = BIOME_DEFINITIONS.map(function (d, id) {
      return {
        id: id,
        key: d.key,
        globalAreaFraction: totalArea ? globalSums[id] / totalArea : 0,
        landAreaFraction: landArea ? landSums[id] / landArea : 0,
        top1AreaFraction: totalArea ? top1Sums[id] / totalArea : 0
      };
    });
    return {
      biomeCount: BIOME_COUNT,
      meanEntropy: totalArea ? entropyWeighted / totalArea : 0,
      fractions: fractions
    };
  }

  function smoothBiomeWeights(grid, geography, arrays, weights, hardLand, widthCells) {
    var width = Math.max(0, Number(widthCells) || 0);
    if (!(width > 0)) return;
    var n = grid.cellCount;
    var next = new Float32Array(weights.length);
    var fullSteps = Math.floor(width);
    var fraction = width - fullSteps;
    var steps = fullSteps + (fraction > 0 ? 1 : 0);
    steps = Math.min(6, steps);
    for (var step = 0; step < steps; step++) {
      var alpha = 0.42 * (step < fullSteps ? 1 : fraction);
      if (!(alpha > 0)) continue;
      for (var c = 0; c < n; c++) {
        var base = c * BIOME_COUNT;
        var count = grid.neighborCount[c];
        for (var b = 0; b < BIOME_COUNT; b++) {
          var neighborSum = 0;
          for (var j = 0; j < count; j++) {
            neighborSum += weights[grid.neighbors[c * 6 + j] * BIOME_COUNT + b];
          }
          next[base + b] = weights[base + b] * (1 - alpha) + (neighborSum / count) * alpha;
        }
      }
      weights.set(next);
    }
    for (c = 0; c < n; c++) {
      base = c * BIOME_COUNT;
      var waterMask = clamp01(geography.muOcean[c] + geography.muShelf[c]);
      var landMask = clamp01(geography.muLand[c] + (hardLand[c] ? 0.12 : 0));
      var sum = 0;
      for (b = 0; b < BIOME_COUNT; b++) {
        if (WATER_BIOMES.indexOf(b) >= 0) weights[base + b] *= waterMask;
        else if (b === 3) weights[base + b] *= arrays.lakeWeight[c] > 0 ? 1 : 0;
        else weights[base + b] *= landMask;
        if (!(weights[base + b] > 0)) weights[base + b] = 0;
        sum += weights[base + b];
      }
      if (!(sum > 0)) {
        weights[base + (hardLand[c] ? 12 : 0)] = 1;
        sum = 1;
      }
      for (b = 0; b < BIOME_COUNT; b++) weights[base + b] /= sum;
    }
  }

  function computeHydrologyStats(grid, geography, arrays, hardLand, landCellCount, hardLandArea, totalArea,
      catchments, drainageRegions, depressionInfo, cycleBreakCount, profile, thresholds) {
    var terminalArea = [0, 0, 0, 0];
    var routed = 0;
    var lakeArea = 0;
    var depressionArea = 0;
    var streamCells = 0, majorCells = 0, deltaCells = 0;
    var uphillFilledEdges = 0, uphillRawOutsideDepressions = 0, checkedEdges = 0;
    var majorEdges = 0, majorUphillRawOutsideDepressions = 0;
    for (var c = 0; c < grid.cellCount; c++) {
      depressionArea += arrays.depressionDepth[c] > 1e-9 ? grid.areas[c] : 0;
      lakeArea += arrays.lakeWeight[c] * grid.areas[c];
      if (arrays.deltaWeight[c] >= 0.25) deltaCells++;
      if (!hardLand[c]) continue;
      terminalArea[arrays.terminalType[c]] += grid.areas[c];
      if (arrays.catchmentId[c] >= 0) routed++;
      if (arrays.flowAccumulationKm2[c] >= thresholds.streamFlowKm2) streamCells++;
      if (arrays.flowAccumulationKm2[c] >= thresholds.majorRiverFlowKm2) majorCells++;
      var receiver = arrays.flowReceiver[c];
      if (receiver >= 0) {
        checkedEdges++;
        if (arrays.filledElevation[receiver] > arrays.filledElevation[c] + 1e-9) uphillFilledEdges++;
        // Внутри priority-flood впадины маршрут идёт по уровню заполненной
        // поверхности/озера, поэтому сырой рельеф дна может локально расти.
        // Вне впадин и озёр подъём по сырой высоте — настоящая ошибка стока.
        var outsideDepression = arrays.depressionDepth[c] <= 1e-9 && arrays.lakeWeight[c] <= 0;
        var rawUphillOutside = outsideDepression &&
          geography.elevation[receiver] > geography.elevation[c] + 1e-9;
        if (rawUphillOutside) uphillRawOutsideDepressions++;
        if (arrays.flowAccumulationKm2[c] >= thresholds.majorRiverFlowKm2 && hardLand[receiver]) {
          majorEdges++;
          if (rawUphillOutside) majorUphillRawOutsideDepressions++;
        }
      }
    }
    var catchmentDist = distributionStats(catchments.map(function (r) { return r.cellCount; }));
    var drainageDist = distributionStats(drainageRegions.map(function (r) { return r.cellCount; }));
    return {
      landCells: landCellCount,
      routedLandFraction: landCellCount ? routed / landCellCount : 0,
      cycleBreakCount: cycleBreakCount,
      uphillFilledEdgeFraction: checkedEdges ? uphillFilledEdges / checkedEdges : 0,
      uphillRawEdgeFractionOutsideDepressions: checkedEdges ? uphillRawOutsideDepressions / checkedEdges : 0,
      terminalLandAreaFractions: {
        ocean: hardLandArea ? terminalArea[TERMINAL_OCEAN] / hardLandArea : 0,
        terminalLake: hardLandArea ? terminalArea[TERMINAL_LAKE] / hardLandArea : 0,
        endorheic: hardLandArea ? terminalArea[TERMINAL_ENDORHEIC] / hardLandArea : 0
      },
      depression: {
        componentCount: depressionInfo.length,
        landAreaFraction: hardLandArea ? depressionArea / hardLandArea : 0,
        modes: depressionInfo.reduce(function (acc, info) {
          acc[info.mode] = (acc[info.mode] || 0) + 1;
          return acc;
        }, {})
      },
      lakes: {
        count: 0,
        landAreaFraction: hardLandArea ? lakeArea / hardLandArea : 0
      },
      catchments: {
        distribution: catchmentDist,
        targetMeanCells: profile.drainageMeanCells
      },
      drainageRegions: {
        distribution: drainageDist,
        targetMeanCells: profile.drainageMeanCells,
        meanRatio: profile.drainageMeanCells > 0 && drainageDist.count
          ? drainageDist.mean / profile.drainageMeanCells : null
      },
      flow: {
        streamThresholdKm2: thresholds.streamFlowKm2,
        majorRiverThresholdKm2: thresholds.majorRiverFlowKm2,
        streamLandCellFraction: landCellCount ? streamCells / landCellCount : 0,
        majorRiverLandCellFraction: landCellCount ? majorCells / landCellCount : 0,
        majorRiverUphillRawOutsideDepressionsFraction: majorEdges
          ? majorUphillRawOutsideDepressions / majorEdges : 0,
        maxAccumulationKm2: catchments.reduce(function (m, r) { return Math.max(m, r.maxFlowKm2); }, 0)
      },
      deltaCellsAtWeight025: deltaCells,
      totalAreaChecked: totalArea
    };
  }

  function emptyHydrologyStats(profile) {
    return {
      landCells: 0,
      routedLandFraction: 0,
      cycleBreakCount: 0,
      uphillFilledEdgeFraction: 0,
      uphillRawEdgeFractionOutsideDepressions: 0,
      terminalLandAreaFractions: { ocean: 0, terminalLake: 0, endorheic: 0 },
      depression: { componentCount: 0, landAreaFraction: 0, modes: {} },
      lakes: { count: 0, landAreaFraction: 0 },
      catchments: { distribution: distributionStats([]), targetMeanCells: profile.drainageMeanCells },
      drainageRegions: { distribution: distributionStats([]), targetMeanCells: profile.drainageMeanCells, meanRatio: null },
      flow: { streamThresholdKm2: 0, majorRiverThresholdKm2: 0, streamLandCellFraction: 0, majorRiverLandCellFraction: 0, majorRiverUphillRawOutsideDepressionsFraction: 0, maxAccumulationKm2: 0 },
      deltaCellsAtWeight025: 0,
      totalAreaChecked: 0
    };
  }

  function emptyBiomeStats() {
    return {
      biomeCount: BIOME_COUNT,
      meanEntropy: 0,
      fractions: BIOME_DEFINITIONS.map(function (d) {
        return { id: d.id, key: d.key, globalAreaFraction: 0, landAreaFraction: 0, top1AreaFraction: 0 };
      })
    };
  }

  function augmentGeography(grid, geography, options) {
    var base = geography && geography.baseGeography ? geography.baseGeography : geography;
    var surface = computeSurface(grid, base, options || {});
    surface.stats.hydrology.lakes.count = surface.lakes.length;
    return surface;
  }

  function generateSurface(grid, input, options) {
    options = options || {};
    if (isGeographyResult(input)) return augmentGeography(grid, input, options);
    var userProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    var geography = PlanetGeography.generateGeography(grid, baseProfileInput(input), {
      onProgress: function (stage, fraction) {
        if (userProgress && stage !== 'done') userProgress(stage, fraction * 0.55);
      }
    });
    return augmentGeography(grid, geography, Object.assign({}, options, {
      onProgress: function (stage, fraction) {
        if (userProgress) userProgress(stage, 0.55 + fraction * 0.45);
      }
    }));
  }

  function defaultYieldControl() {
    return new Promise(function (resolve) {
      if (typeof setTimeout !== 'undefined') setTimeout(resolve, 0);
      else resolve();
    });
  }

  async function augmentGeographyAsync(grid, geography, options) {
    options = options || {};
    var yieldControl = typeof options.yieldControl === 'function' ? options.yieldControl : defaultYieldControl;
    await yieldControl({ stage: 'surface-start' });
    return augmentGeography(grid, geography, options);
  }

  async function generateSurfaceAsync(grid, input, options) {
    options = options || {};
    if (isGeographyResult(input)) return augmentGeographyAsync(grid, input, options);
    var userProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    var baseOptions = Object.assign({}, options, {
      onProgress: function (stage, fraction) {
        if (userProgress && stage !== 'done') userProgress(stage, fraction * 0.55);
      }
    });
    var geography = await PlanetGeography.generateGeographyAsync(grid, baseProfileInput(input), baseOptions);
    var surfaceOptions = Object.assign({}, options, {
      onProgress: function (stage, fraction) {
        if (userProgress) userProgress(stage, 0.55 + fraction * 0.45);
      }
    });
    return augmentGeographyAsync(grid, geography, surfaceOptions);
  }

  function collectTypedBuffers(surface) {
    var seen = new Set();
    var buffers = [];
    function add(value) {
      if (ArrayBuffer.isView(value) && value.buffer && !seen.has(value.buffer)) {
        seen.add(value.buffer);
        buffers.push(value.buffer);
      }
    }
    if (!surface) return buffers;
    PlanetGeography.ARRAY_FIELDS.forEach(function (name) { add(surface[name]); });
    ARRAY_FIELDS.forEach(function (name) { add(surface[name]); });
    return buffers;
  }

  function typedBytesOf(surface) {
    return collectTypedBuffers(surface).reduce(function (sum, buffer) { return sum + buffer.byteLength; }, 0);
  }

  function listTransferableBuffers(surface) {
    return collectTypedBuffers(surface).filter(function (buffer) { return buffer.byteLength > 1024; });
  }

  function packSurfaceForTransfer(surface) {
    return { message: surface, transfer: listTransferableBuffers(surface) };
  }

  function validateSurface(grid, surface) {
    var checks = {};
    if (!grid || !surface) return { ok: false, checks: { shape: false } };
    var base = surface.baseGeography || surface;
    var baseValidation = PlanetGeography.validateGeography(grid, base);
    checks.baseGeography = baseValidation.ok;
    checks.shape = surface.cellCount === grid.cellCount && surface.v === grid.v;
    checks.versions = surface.geographyVersion === SURFACE_GEOGRAPHY_VERSION &&
      surface.baseGeographyVersion === BASE_GEOGRAPHY_VERSION &&
      surface.hydrologyVersion === HYDROLOGY_VERSION &&
      surface.biomeVersion === BIOME_VERSION;
    var lengths = true;
    ARRAY_FIELDS.forEach(function (name) {
      var expected = name === 'biomeColor' ? grid.cellCount * 3 : grid.cellCount;
      if (!surface[name] || surface[name].length !== expected) lengths = false;
    });
    checks.arrayLengths = lengths;
    if (!lengths || !checks.shape) return { ok: false, checks: checks, baseValidation: baseValidation };

    var finite = true, ranges = true, ids = true, biomeWeights = true, receivers = true;
    var floatFields = ['filledElevation', 'depressionDepth', 'slope', 'flowAccumulationKm2',
      'flowAccumulationCells', 'lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
      'mountainWeight', 'mountainSeamWeight', 'biomeTop1Weight', 'biomeTop2Weight', 'biomeEntropy'];
    var unitFields = ['lakeWeight', 'streamWeight', 'riverInfluence', 'deltaWeight',
      'mountainWeight', 'mountainSeamWeight', 'biomeTop1Weight', 'biomeTop2Weight', 'biomeEntropy'];
    for (var c = 0; c < grid.cellCount; c++) {
      for (var i = 0; i < floatFields.length; i++) {
        if (!Number.isFinite(surface[floatFields[i]][c])) finite = false;
      }
      for (i = 0; i < unitFields.length; i++) {
        var v = surface[unitFields[i]][c];
        if (v < -1e-6 || v > 1.000001) ranges = false;
      }
      if (surface.depressionDepth[c] < -1e-6 || surface.slope[c] < -1e-12 ||
          surface.flowAccumulationKm2[c] < -1e-6 || surface.flowAccumulationCells[c] < -1e-6) ranges = false;
      for (i = 0; i < 3; i++) {
        var color = surface.biomeColor[c * 3 + i];
        if (!Number.isFinite(color) || color < -1e-6 || color > 1.000001) ranges = false;
      }
      if (surface.surfaceApplicable) {
        if (surface.catchmentId[c] < -1 || surface.catchmentId[c] >= Math.max(1, surface.catchments.length) ||
            surface.drainageRegionId[c] < -1 || surface.drainageRegionId[c] >= Math.max(1, surface.drainageRegions.length) ||
            surface.lakeId[c] < -1 || surface.lakeId[c] >= Math.max(1, surface.lakes.length) ||
            surface.mountainRangeId[c] < -1 || surface.mountainRangeId[c] >= Math.max(1, surface.mountainRanges.length) ||
            surface.terminalType[c] > TERMINAL_ENDORHEIC) ids = false;
        var bw = surface.biomeTop1Weight[c] + surface.biomeTop2Weight[c];
        if (surface.biomeTop1Id[c] < 0 || surface.biomeTop1Id[c] >= BIOME_COUNT ||
            surface.biomeTop2Id[c] < -1 || surface.biomeTop2Id[c] >= BIOME_COUNT ||
            surface.biomeTop1Id[c] === surface.biomeTop2Id[c] || Math.abs(bw - 1) > 1e-4) biomeWeights = false;
        var receiver = surface.flowReceiver[c];
        if (receiver >= 0) {
          var isNeighbor = false;
          for (i = 0; i < grid.neighborCount[c]; i++) {
            if (grid.neighbors[c * 6 + i] === receiver) { isNeighbor = true; break; }
          }
          if (!isNeighbor) receivers = false;
        }
      }
    }
    checks.finite = finite;
    checks.ranges = ranges;
    checks.ids = surface.surfaceApplicable ? ids : true;
    checks.biomeWeights = surface.surfaceApplicable ? biomeWeights : true;
    checks.flowReceivers = surface.surfaceApplicable ? receivers : true;
    checks.flowAcyclic = surface.surfaceApplicable ? validateFlowAcyclic(grid, surface) : true;
    checks.stats = !!(surface.stats && surface.stats.hydrology && surface.stats.biomes && surface.stats.mountains);
    var ok = Object.keys(checks).every(function (key) { return checks[key]; });
    return { ok: ok, checks: checks, typedBytes: typedBytesOf(surface), baseValidation: baseValidation };
  }

  function validateFlowAcyclic(grid, surface) {
    var state = new Uint8Array(grid.cellCount);
    var stack = [];
    for (var start = 0; start < grid.cellCount; start++) {
      if (state[start] === 2 || surface.flowReceiver[start] < -1) continue;
      var cell = start;
      stack.length = 0;
      while (cell >= 0 && state[cell] === 0) {
        state[cell] = 1;
        stack.push(cell);
        cell = surface.flowReceiver[cell];
        if (cell >= 0 && state[cell] === 1) return false;
      }
      for (var i = 0; i < stack.length; i++) state[stack[i]] = 2;
    }
    return true;
  }

  var api = {
    BASE_GEOGRAPHY_VERSION: BASE_GEOGRAPHY_VERSION,
    SURFACE_GEOGRAPHY_VERSION: SURFACE_GEOGRAPHY_VERSION,
    SURFACE_VERSION: SURFACE_VERSION,
    GEOGRAPHY_VERSION: SURFACE_GEOGRAPHY_VERSION,
    HYDROLOGY_VERSION: HYDROLOGY_VERSION,
    BIOME_VERSION: BIOME_VERSION,
    BIOME_DEFINITIONS: cloneBiomeDefinitions(),
    BIOME_COUNT: BIOME_COUNT,
    ARRAY_FIELDS: ARRAY_FIELDS.slice(),
    TERMINAL_TYPES: {
      NONE: TERMINAL_NONE,
      OCEAN: TERMINAL_OCEAN,
      TERMINAL_LAKE: TERMINAL_LAKE,
      ENDORHEIC: TERMINAL_ENDORHEIC
    },
    TERMINAL_TYPE_NAMES: TERMINAL_TYPE_NAMES.slice(),
    normalizeSurfaceProfile: normalizeSurfaceProfile,
    generateSurface: generateSurface,
    generateSurfaceAsync: generateSurfaceAsync,
    augmentGeography: augmentGeography,
    augmentGeographyAsync: augmentGeographyAsync,
    validateSurface: validateSurface,
    typedBytesOf: typedBytesOf,
    listTransferableBuffers: listTransferableBuffers,
    packSurfaceForTransfer: packSurfaceForTransfer
  };
  api.DEFAULT_PROFILE = normalizeSurfaceProfile({});
  /* global module */
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlanetSurface = api;
})(typeof window !== 'undefined' ? window : globalThis);
