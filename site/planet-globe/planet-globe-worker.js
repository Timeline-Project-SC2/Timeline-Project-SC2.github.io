/* Worker боевого глобуса (Этап 6).
   -------------------------------------------------------------------------
   Считает вне UI-потока: сетку goldberg-gp-v1 (с общим IndexedDB-кэшем
   топологии спайка), поверхность c100-soft-v2 и GPU-геометрию
   planet-globe-v1. Главному потоку отправляет только transferable-массивы
   геометрии и компактные сводки; полная поверхность остаётся здесь и
   отвечает на pick и смену цветового слоя без повторной генерации.

   Протокол:
     generate { token, requestId, profile, renderV, colorMode, reliefScale,
                fallbackPreview }
       -> status/progress -> ready { geometry, summary, preview? }
     color-mode { token, requestId, mode }
       -> colors { colors:Uint8Array }
     pick { token, requestId, direction:[x,y,z], purpose:'select'|'hover' }
       -> pick-result { info }
     clear-grid-cache -> cache-cleared
*/
/* global importScripts */
'use strict';
importScripts(
  '../shared/geodesic-grid.js?v=planet-stage-6-2',
  '../shared/planet-noise.js?v=planet-stage-6-2',
  '../shared/planet-geography.js?v=planet-stage-6-2',
  '../shared/planet-surface.js?v=planet-stage-6-2',
  '../shared/planet-globe.js?v=planet-stage-6-2'
);

var GeodesicGrid = self.GeodesicGrid;
var PlanetGeography = self.PlanetGeography;
var PlanetSurface = self.PlanetSurface;
var PlanetGlobe = self.PlanetGlobe;

/* ---------------------------------------------------- IndexedDB топологии */
/* Тот же физический кэш, что у planet-test: сетка v=128 строится один раз
   на браузер, а не одна копия на каждую страницу. */
var idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('planet-spike-cache', 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains('mesh')) req.result.createObjectStore('mesh');
        if (!req.result.objectStoreNames.contains('grids')) req.result.createObjectStore('grids');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  return idbPromise;
}
function idbGet(key) {
  return idb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction('grids', 'readonly').objectStore('grids').get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function idbPut(key, value) {
  return idb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction('grids', 'readwrite').objectStore('grids').put(value, key);
      req.onsuccess = function () { resolve(); };
      req.onerror = function () { reject(req.error); };
    });
  });
}
function gridKey(v) { return 'gp-v1-bin:' + v; }

/* --------------------------------------------------------------- состояние */

var memoryGrids = new Map();
var current = null;
var generationBusy = false;
var pendingGenerate = null;

function post(type, payload, transfer) {
  payload = payload || {};
  payload.type = type;
  if (transfer && transfer.length) self.postMessage(payload, transfer);
  else self.postMessage(payload);
}
function progress(token, requestId, stage, fraction, label) {
  post('progress', {
    token: token, requestId: requestId, stage: stage,
    fraction: Math.max(0, Math.min(1, fraction)), label: label || ''
  });
}

function scaledRenderProfile(inputProfile, renderV) {
  var profile = PlanetSurface.normalizeSurfaceProfile(inputProfile || {});
  var canonicalV = PlanetGeography.expectedFrequency(profile.radiusKm);
  var ratio = renderV / canonicalV;
  var areaRatio = ratio * ratio;
  var scaled = Object.assign({}, profile);
  // Нормы «в ячейках» определены для канонической частоты. На LOD-прокси
  // тот же физический масштаб достигается пропорционально меньшей нормой.
  scaled.continentMeanCells = Math.max(1, Math.round(profile.continentMeanCells * areaRatio));
  scaled.oceanBasinMeanCells = Math.max(1, Math.round(profile.oceanBasinMeanCells * areaRatio));
  scaled.drainageMeanCells = Math.max(1, Math.round(profile.drainageMeanCells * areaRatio));
  scaled.coastSoftWidthCells = Math.max(0, profile.coastSoftWidthCells * ratio);
  scaled.continentSoftWidthCells = Math.max(0, profile.continentSoftWidthCells * ratio);
  scaled.biomeSoftWidthCells = Math.max(0, profile.biomeSoftWidthCells * ratio);
  return {
    requestProfile: inputProfile || {},
    canonical: profile,
    render: scaled,
    canonicalV: canonicalV,
    renderV: renderV,
    ratio: ratio,
    areaRatio: areaRatio
  };
}

function yieldLoop() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

async function getGrid(v, token, requestId) {
  if (memoryGrids.has(v)) return { grid: memoryGrids.get(v), source: 'memory' };
  var loaded = await GeodesicGrid.loadGridWithCache({
    expectedMeta: { v: v, blockSteps: GeodesicGrid.CHUNK_BLOCK_STEPS },
    readCache: function () { return idbGet(gridKey(v)); },
    writeCache: function (bytes) { return idbPut(gridKey(v), bytes); },
    rebuildGrid: function () { return GeodesicGrid.build(v); }
  });
  var validation = GeodesicGrid.validate(loaded.grid);
  if (!validation.ok) throw new Error('Сетка v=' + v + ' не прошла валидацию');
  memoryGrids.set(v, loaded.grid);
  while (memoryGrids.size > 3) {
    var oldest = memoryGrids.keys().next().value;
    if (oldest === v) break;
    memoryGrids.delete(oldest);
  }
  progress(token, requestId, 'mesh', 0.10,
    loaded.source === 'cache' ? 'Сетка загружена из кэша' : 'Сетка построена');
  return { grid: loaded.grid, source: loaded.source };
}

function round(x, digits) {
  var f = Math.pow(10, digits || 4);
  return Math.round((Number(x) || 0) * f) / f;
}

function surfaceSummary(scaledInfo, surface, geometry, timings) {
  return {
    planetId: scaledInfo.requestProfile.planetId || scaledInfo.requestProfile.planet_id || '',
    presetId: surface.profile.presetId,
    surfaceClass: surface.profile.surfaceClass,
    masterSeedHex: surface.profile.masterSeedHex,
    radiusKm: surface.profile.radiusKm,
    canonicalV: scaledInfo.canonicalV,
    renderV: scaledInfo.renderV,
    renderRatio: round(scaledInfo.ratio, 4),
    cellCount: surface.cellCount,
    triangleCount: geometry.triangleCount,
    vertexCount: geometry.vertexCount,
    geometryBytes: geometry.typedBytes,
    gridVersion: surface.gridVersion,
    noiseVersion: surface.noiseVersion,
    geographyVersion: surface.geographyVersion,
    surfaceVersion: surface.surfaceVersion,
    hydrologyVersion: surface.hydrologyVersion,
    biomeVersion: surface.biomeVersion,
    seaLevel: surface.seaLevel,
    thresholds: surface.thresholds,
    stats: surface.stats,
    biomeDefinitions: surface.biomeDefinitions,
    counts: {
      continents: surface.continents.length,
      oceanBasins: surface.oceanBasins.length,
      plates: surface.plates.length,
      catchments: surface.catchments.length,
      drainageRegions: surface.drainageRegions.length,
      lakes: surface.lakes.length,
      mountainRanges: surface.mountainRanges.length
    },
    renderProfileCells: {
      continentMeanCells: scaledInfo.render.continentMeanCells,
      oceanBasinMeanCells: scaledInfo.render.oceanBasinMeanCells,
      drainageMeanCells: scaledInfo.render.drainageMeanCells
    },
    timingsMs: timings
  };
}

async function runGenerate(message) {
  var token = message.token;
  var requestId = message.requestId;
  var started = performance.now();
  var renderV = Math.max(4, Math.min(256, Math.round(Number(message.renderV) || 32)));
  var colorMode = message.colorMode || 'biome';
  var reliefScale = message.reliefScale == null ? 1 : Number(message.reliefScale);
  try {
    progress(token, requestId, 'profile', 0.02, 'Профиль планеты');
    var scaledInfo = scaledRenderProfile(message.profile, renderV);
    progress(token, requestId, 'mesh', 0.05, 'Сетка v=' + renderV);
    var meshStarted = performance.now();
    var gridResult = await getGrid(renderV, token, requestId);
    var grid = gridResult.grid;
    var meshMs = performance.now() - meshStarted;

    progress(token, requestId, 'surface', 0.12, 'Поля, континенты, реки и биомы');
    var surfaceStarted = performance.now();
    var surface = await PlanetSurface.generateSurfaceAsync(grid, scaledInfo.render, {
      chunkCells: 8192,
      onProgress: function (stage, fraction) {
        progress(token, requestId, stage, 0.12 + fraction * 0.68,
          stage === 'fields' ? 'Поля и плиты' :
          stage === 'geography' ? 'Море и континенты' :
          stage === 'hydrology' ? 'Сток, реки и озёра' :
          stage === 'biomes' ? 'Биомы' : 'Поверхность');
      },
      yieldControl: yieldLoop
    });
    var surfaceMs = performance.now() - surfaceStarted;
    if (!surface.surfaceApplicable) {
      var err = new Error('У этого типа тела нет твёрдой поверхности: глобус Этапа 6 её не рисует.');
      err.code = 'NO_SURFACE';
      throw err;
    }
    var validation = PlanetSurface.validateSurface(grid, surface);
    if (!validation.ok) throw new Error('Поверхность не прошла валидацию: ' + JSON.stringify(validation.checks));

    progress(token, requestId, 'geometry', 0.84, 'GPU-геометрия ячеек');
    await yieldLoop();
    var geometryStarted = performance.now();
    var geometry = PlanetGlobe.buildGlobeGeometry(grid, surface, {
      colorMode: colorMode,
      reliefScale: reliefScale
    });
    var geometryMs = performance.now() - geometryStarted;

    var preview = null;
    if (message.fallbackPreview) {
      progress(token, requestId, 'preview', 0.94, '2D fallback-развёртка');
      await yieldLoop();
      preview = PlanetGlobe.buildEquirectPreview(grid, surface, 720, 360, colorMode);
    }

    current = {
      token: token,
      grid: grid,
      surface: surface,
      vertexCellId: geometry.vertexCellId,
      cellCount: geometry.cellCount,
      reliefScale: reliefScale,
      colorMode: colorMode
    };

    var payloadGeometry = {
      version: geometry.version,
      v: geometry.v,
      cellCount: geometry.cellCount,
      vertexCount: geometry.vertexCount,
      triangleCount: geometry.triangleCount,
      indexCount: geometry.indexCount,
      positions: geometry.positions,
      colors: geometry.colors,
      indices: geometry.indices,
      chunkRanges: geometry.chunkRanges,
      reliefScale: geometry.reliefScale,
      typedBytes: geometry.typedBytes
    };
    var transfer = PlanetGlobe.listGeometryTransferables(payloadGeometry, false);
    if (preview && preview.data && preview.data.buffer) transfer.push(preview.data.buffer);
    var summary = surfaceSummary(scaledInfo, surface, geometry, {
      mesh: round(meshMs, 1),
      surface: round(surfaceMs, 1),
      geometry: round(geometryMs, 1),
      total: round(performance.now() - started, 1)
    });
    summary.gridSource = gridResult.source;
    // 100% страница покажет только после GPU-подмены; worker завершил CPU-часть.
    progress(token, requestId, 'ready', 0.84, 'CPU-часть готова');
    post('ready', {
      token: token, requestId: requestId,
      geometry: payloadGeometry,
      summary: summary,
      preview: preview,
      colorMode: colorMode
    }, transfer);
  } catch (err) {
    post('error', {
      token: token, requestId: requestId,
      code: err && err.code ? err.code : 'GENERATE_FAILED',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : ''
    });
  }
}

function pickInfo(direction) {
  if (!current) throw new Error('Планета ещё не сгенерирована');
  var grid = current.grid;
  var s = current.surface;
  var len = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  var dir = [direction[0] / len, direction[1] / len, direction[2] / len];
  var started = performance.now();
  var cell = GeodesicGrid.pick(grid, dir);
  var pickMs = performance.now() - started;
  var center = [grid.centers[cell * 3], grid.centers[cell * 3 + 1], grid.centers[cell * 3 + 2]];
  var continentId = s.continentTop1Id[cell];
  var continent2Id = s.continentTop2Id[cell];
  var catchmentId = s.catchmentId[cell];
  var drainageRegionId = s.drainageRegionId[cell];
  var lakeId = s.lakeId[cell];
  var rangeId = s.mountainRangeId[cell];
  var biome1 = s.biomeTop1Id[cell];
  var biome2 = s.biomeTop2Id[cell];
  var polygon = PlanetGlobe.cellPolygon(grid, s, cell, {
    reliefScale: current.reliefScale,
    inflate: 1.006
  });
  var hardClass = s.elevation[cell] > s.seaLevel ? 'land' :
    (s.elevation[cell] >= s.shelfBelowLevel ? 'shelf' : 'ocean');
  return {
    cell: cell,
    address: GeodesicGrid.addressOf(grid, cell),
    pickMs: round(pickMs, 3),
    latitudeDeg: round(Math.asin(Math.max(-1, Math.min(1, center[1]))) * 180 / Math.PI, 2),
    longitudeDeg: round(Math.atan2(center[2], center[0]) * 180 / Math.PI, 2),
    areaKm2: round(grid.areas[cell] * s.radiusKm * s.radiusKm, 1),
    centerDirection: center,
    polygon: polygon,
    hardClass: hardClass,
    elevation: s.elevation[cell],
    seaLevel: s.seaLevel,
    elevationRelative: round(s.elevation[cell] - s.seaLevel, 5),
    filledElevation: s.filledElevation[cell],
    depressionDepth: s.depressionDepth[cell],
    slope: s.slope[cell],
    temperature: s.temperature[cell],
    moisture: s.moisture[cell],
    volcanism: s.volcanism[cell],
    mu: {
      land: s.muLand[cell],
      shelf: s.muShelf[cell],
      ocean: s.muOcean[cell]
    },
    coastDistanceCells: s.signedCoastDistanceCells[cell],
    plateId: s.plateId[cell],
    plateBoundary: s.plateBoundary[cell],
    continent: continentId >= 0 ? {
      top1Id: continentId,
      top1Weight: s.continentTop1Weight[cell],
      top2Id: continent2Id,
      top2Weight: s.continentTop2Weight[cell],
      entropy: s.continentEntropy[cell],
      effectiveAreaKm2: s.continents[continentId] ? s.continents[continentId].effectiveAreaKm2 : 0
    } : null,
    oceanBasinId: s.oceanBasinId[cell],
    oceanBasinWeight: s.oceanBasinWeight[cell],
    physicalLandmassId: s.physicalLandmassId[cell],
    flow: {
      receiver: s.flowReceiver[cell],
      accumulationKm2: s.flowAccumulationKm2[cell],
      streamWeight: s.streamWeight[cell],
      riverInfluence: s.riverInfluence[cell],
      deltaWeight: s.deltaWeight[cell],
      lakeWeight: s.lakeWeight[cell],
      terminalType: s.terminalType[cell]
    },
    catchment: catchmentId >= 0 && s.catchments[catchmentId] ? {
      id: catchmentId,
      terminalType: s.catchments[catchmentId].terminalType,
      cellCount: s.catchments[catchmentId].cellCount,
      areaKm2: s.catchments[catchmentId].areaKm2,
      maxFlowKm2: s.catchments[catchmentId].maxFlowKm2
    } : null,
    drainageRegion: drainageRegionId >= 0 && s.drainageRegions[drainageRegionId] ? {
      id: drainageRegionId,
      terminalType: s.drainageRegions[drainageRegionId].terminalType,
      cellCount: s.drainageRegions[drainageRegionId].cellCount,
      areaKm2: s.drainageRegions[drainageRegionId].areaKm2,
      catchmentCount: s.drainageRegions[drainageRegionId].catchmentCount
    } : null,
    lake: lakeId >= 0 && s.lakes[lakeId] ? {
      id: lakeId,
      cellCount: s.lakes[lakeId].cellCount,
      areaKm2: s.lakes[lakeId].areaKm2,
      terminal: !!s.lakes[lakeId].terminal
    } : null,
    mountains: {
      weight: s.mountainWeight[cell],
      seamWeight: s.mountainSeamWeight[cell],
      rangeId: rangeId
    },
    biome: {
      top1Id: biome1,
      top1Key: s.biomeDefinitions[biome1] ? s.biomeDefinitions[biome1].key : '',
      top1Weight: s.biomeTop1Weight[cell],
      top2Id: biome2,
      top2Key: biome2 >= 0 && s.biomeDefinitions[biome2] ? s.biomeDefinitions[biome2].key : '',
      top2Weight: s.biomeTop2Weight[cell],
      entropy: s.biomeEntropy[cell]
    }
  };
}

async function ensureGeneration(message) {
  if (generationBusy) {
    pendingGenerate = message;
    return;
  }
  generationBusy = true;
  try {
    await runGenerate(message);
  } finally {
    generationBusy = false;
    if (pendingGenerate) {
      var next = pendingGenerate;
      pendingGenerate = null;
      ensureGeneration(next);
    }
  }
}

self.onmessage = function (event) {
  var message = event.data || {};
  try {
    if (message.type === 'generate') {
      ensureGeneration(message);
    } else if (message.type === 'color-mode') {
      if (!current) throw new Error('Планета ещё не сгенерирована');
      var mode = message.mode || 'biome';
      var colors = PlanetGlobe.buildVertexColors(current.surface, current.vertexCellId, mode, current.cellCount);
      current.colorMode = mode;
      post('colors', {
        token: message.token, requestId: message.requestId, mode: mode, colors: colors
      }, [colors.buffer]);
    } else if (message.type === 'pick') {
      var info = pickInfo(message.direction || [0, 0, 1]);
      post('pick-result', {
        token: message.token, requestId: message.requestId,
        purpose: message.purpose || 'select', info: info
      });
    } else if (message.type === 'clear-grid-cache') {
      idb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = db.transaction('grids', 'readwrite').objectStore('grids').clear();
          req.onsuccess = resolve;
          req.onerror = function () { reject(req.error); };
        });
      }).then(function () {
        memoryGrids.clear();
        post('cache-cleared', { token: message.token, requestId: message.requestId });
      }).catch(function (err) {
        post('error', { token: message.token, requestId: message.requestId, code: 'CACHE_CLEAR_FAILED', message: String(err && err.message || err) });
      });
    }
  } catch (err) {
    post('error', {
      token: message.token, requestId: message.requestId,
      code: err && err.code ? err.code : 'WORKER_FAILED',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack) : ''
    });
  }
};

post('worker-ready', {
  globeVersion: PlanetGlobe.GLOBE_VERSION,
  gridVersion: GeodesicGrid.GRID_VERSION,
  surfaceVersion: PlanetSurface.SURFACE_VERSION
});
