/* Planet spike — воркер генерации для /planet-test/ (Этап 1).
   Строит сетку и поля вне главного потока, чтобы каскадная анимация сборки
   могла идти во время фактической загрузки: страница показывает прокси
   низкого v и подменяет его результатом отсюда. weightedQuantile и
   landmassStats — копии одноимённых функций страницы (воркер не делит с ней
   код, кроме общих модулей).

   Сетки кэшируются в IndexedDB (та же база, что у страницы): сетка зависит
   только от v, поэтому повторные визиты не перестраивают её (при v=192 это
   минус ~2.2 с). Ключ с префиксом формата: при смене формата сетки префикс
   бампится и старый кэш игнорируется; дополнительно проверяется форма
   объекта (v, cellCount, centers). */
/* global importScripts */
'use strict';

importScripts('/shared/geodesic-grid.js?v=planet-spike-6', '/shared/planet-noise.js?v=planet-spike-1');

var GeodesicGrid = self.GeodesicGrid;
var PlanetNoise = self.PlanetNoise;
var gridCache = new Map();
var GRID_CACHE_PREFIX = 'gp-v0:';

function idbOpen(onOk) {
  try {
    var open = indexedDB.open('planet-spike-cache', 1);
    open.onupgradeneeded = function () { open.result.createObjectStore('grids'); };
    open.onsuccess = function () { onOk(open.result); };
    open.onerror = function () { onOk(null); };
  } catch (err) {
    onOk(null);
  }
}

function idbGetGrid(v, cb) {
  idbOpen(function (db) {
    if (!db) { cb(null); return; }
    try {
      var req = db.transaction('grids', 'readonly').objectStore('grids').get(GRID_CACHE_PREFIX + v);
      req.onsuccess = function () {
        var g = req.result;
        cb(g && g.v === v && g.cellCount === 10 * v * v + 2 && g.centers ? g : null);
      };
      req.onerror = function () { cb(null); };
    } catch (err) {
      cb(null);
    }
  });
}

function idbPutGrid(v, grid) {
  idbOpen(function (db) {
    if (!db) return;
    try {
      db.transaction('grids', 'readwrite').objectStore('grids').put(grid, GRID_CACHE_PREFIX + v);
    } catch (err) { /* квота/приватный режим — просто без кэша */ }
  });
}

function weightedQuantile(values, weights, q) {
  var idx = new Array(values.length);
  var i;
  for (i = 0; i < idx.length; i++) idx[i] = i;
  idx.sort(function (a, b) { return values[a] - values[b]; });
  var total = 0;
  for (i = 0; i < weights.length; i++) total += weights[i];
  var target = total * q;
  var acc = 0;
  for (i = 0; i < idx.length; i++) {
    acc += weights[idx[i]];
    if (acc >= target) return values[idx[i]];
  }
  return values[idx[idx.length - 1]];
}

function landmassStats(grid, elev, sea) {
  var F = grid.cellCount;
  var visited = new Uint8Array(F);
  var sizes = [];
  var landCells = 0;
  var stack = [];
  for (var c = 0; c < F; c++) {
    if (visited[c] || elev[c] <= sea) continue;
    var size = 0;
    stack.length = 0;
    stack.push(c);
    visited[c] = 1;
    while (stack.length) {
      var u = stack.pop();
      size++;
      landCells++;
      for (var n = 0; n < grid.neighborCount[u]; n++) {
        var v = grid.neighbors[u * 6 + n];
        if (!visited[v] && elev[v] > sea) { visited[v] = 1; stack.push(v); }
      }
    }
    sizes.push(size);
  }
  sizes.sort(function (a, b) { return a - b; });
  function pct(p) { return sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0; }
  return {
    count: sizes.length,
    landCells: landCells,
    median: pct(0.5),
    p90: pct(0.9),
    max: sizes.length ? sizes[sizes.length - 1] : 0
  };
}

function runFields(msg, params, grid, gridSource, msGrid) {
  var sampler = PlanetNoise.createSampler({
    seedText: params.seedText,
    kind: params.kind,
    freq: params.freq,
    octaves: params.octaves,
    gain: params.gain,
    warp: params.warp
  });
  var F = grid.cellCount;
  var elev = new Float32Array(F);
  var moist = new Float32Array(F);
  var temp = new Float32Array(F);
  var out = [0, 0, 0];
  var minE = Infinity, maxE = -Infinity;
  var step = Math.max(1, Math.floor(F / 20));
  var t = performance.now();
  for (var c = 0; c < F; c++) {
    sampler.sample(grid.centers[c * 3], grid.centers[c * 3 + 1], grid.centers[c * 3 + 2], out);
    elev[c] = out[0]; moist[c] = out[1]; temp[c] = out[2];
    if (out[0] < minE) minE = out[0];
    if (out[0] > maxE) maxE = out[0];
    if (c % step === 0) {
      self.postMessage({ type: 'progress', token: msg.token, v: params.v, stage: 'fields', pct: Math.floor(c / F * 100) });
    }
  }
  var sea = weightedQuantile(elev, grid.areas, params.ocean / 100);
  var msFields = performance.now() - t;

  t = performance.now();
  var stats = landmassStats(grid, elev, sea);
  var msStats = performance.now() - t;

  var reply = {
    type: 'done',
    token: msg.token,
    v: params.v,
    elev: elev, moist: moist, temp: temp,
    sea: sea, minE: minE, maxE: maxE,
    masterSeed: sampler.masterSeed,
    stats: stats,
    msGrid: msGrid, msFields: msFields, msStats: msStats,
    gridSource: gridSource
  };
  // Сетку главный поток кэширует у себя; шлём её только если там её ещё нет.
  if (!msg.haveGrid) reply.grid = grid;
  self.postMessage(reply, [elev.buffer, moist.buffer, temp.buffer]);
}

self.onmessage = function (e) {
  var msg = e.data;
  var params = msg.params;
  function fail(err) {
    self.postMessage({
      type: 'error',
      token: msg.token,
      message: String((err && err.message) || err)
    });
  }
  function proceed(grid, gridSource, msGrid) {
    try {
      runFields(msg, params, grid, gridSource, msGrid);
    } catch (err) {
      fail(err);
    }
  }
  self.postMessage({ type: 'progress', token: msg.token, v: params.v, stage: 'grid', pct: 0 });
  var mem = gridCache.get(params.v);
  if (mem) { proceed(mem, 'mem', 0); return; }
  idbGetGrid(params.v, function (cached) {
    if (cached) {
      gridCache.set(params.v, cached);
      proceed(cached, 'idb', 0);
      return;
    }
    var grid;
    var t = performance.now();
    try {
      grid = GeodesicGrid.build(params.v);
    } catch (err) {
      fail(err);
      return;
    }
    var msGrid = performance.now() - t;
    gridCache.set(params.v, grid);
    idbPutGrid(params.v, grid);
    proceed(grid, 'built', msGrid);
  });
};
