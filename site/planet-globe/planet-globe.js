/* Страница боевого глобуса Этапа 6.
   -------------------------------------------------------------------------
   Это первая страница, где настоящая поверхность c100-soft-v2 видна
   целиком: биомы, реки, озёра, континенты и дренажные регионы считаются
   в worker, а WebGL2-глобус только рисует готовую геометрию ячеек.

   Поток загрузки повторяет принятую в спайке идею: сначала быстрый
   прокси той же планеты на меньшей частоте, затем бесшовная замена
   финальной частотой. Нормы «в ячейках» worker масштабирует к render-v,
   поэтому прокси сохраняет физический масштаб континентов и рек.
*/
(function () {
  'use strict';

  var VERSION = 'planet-stage-6-2';
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    canvas: $('globe'),
    fallback: $('fallbackCanvas'),
    fallbackWrap: $('fallbackWrap'),
    preset: $('presetSel'),
    presetInfo: $('presetInfo'),
    surfaceClass: $('surfaceClassSel'),
    planetId: $('planetId'),
    seed: $('seedText'),
    randomSeed: $('randomSeedBtn'),
    radius: $('radiusKm'),
    radiusOut: $('radiusOut'),
    quality: $('qualitySel'),
    qualityOut: $('qualityOut'),
    autoProxy: $('autoProxy'),
    colorMode: $('colorModeSel'),
    relief: $('reliefSel'),
    generate: $('generateBtn'),
    nextPlanet: $('nextPlanetBtn'),
    cycle: $('cycleBtn'),
    borders: $('bordersBtn'),
    spin: $('spinBtn'),
    atmosphere: $('atmosphereBtn'),
    resetView: $('resetViewBtn'),
    clearCache: $('clearCacheBtn'),
    panelToggle: $('panelToggle'),
    panelBody: $('panelBody'),
    status: $('statusLine'),
    loading: $('loading'),
    loadingTitle: $('loadingTitle'),
    loadingLabel: $('loadingLabel'),
    loadingBar: $('loadingBar'),
    loadingPct: $('loadingPct'),
    stats: $('statsBox'),
    selection: $('selectionBox'),
    hover: $('hoverLine'),
    fps: $('fps'),
    cells: $('cells'),
    tris: $('tris'),
    lod: $('lodHud'),
    renderScale: $('renderScale'),
    frameP50: $('frameP50'),
    frameP95: $('frameP95'),
    frameP99: $('frameP99'),
    frameOver50: $('frameOver50'),
    frameOver100: $('frameOver100'),
    heap: $('heap'),
    switchHistory: $('switchHistory')
  };

  var PREFERRED_SURFACE_CLASS = {
    earthlike_balanced: 'terrestrial',
    earthlike_archipelago: 'terrestrial',
    ocean_world: 'ocean',
    desert_dry: 'desert',
    ice_world: 'ice',
    volcanic_active: 'volcanic',
    barren_moon: 'barren'
  };
  var HARD_CLASS_RU = { land: 'суша', shelf: 'шельф', ocean: 'океан' };
  var TERMINAL_RU = { ocean: 'океан', terminal_lake: 'конечное озеро', endorheic: 'бессточная область' };

  var presets = [];
  var presetsById = new Map();
  var worker = null;
  var workerSeq = 0;
  var workerToken = '';
  var displayedToken = '';
  var requestSeq = 0;
  var activeRequest = null;
  var pendingGpuReady = null;
  var displayedSummary = null;
  var displayedProfileKey = '';
  var currentSelection = null;
  var latestPickRequest = 0;
  var latestHoverRequest = 0;
  var lastHoverSentAt = 0;
  var upgradeTimer = 0;
  var cycleTimer = 0;
  var cycleActive = false;
  var completedPlanets = 0;
  var generationHistory = [];
  var globe = null;
  var webglAvailable = true;

  try {
    var coarseScreen = isCoarseOrSmallScreen();
    globe = window.PlanetGlobe.createPlanetGlobe(els.canvas, {
      autoRotate: true,
      borders: true,
      atmosphere: true,
      maxPixelRatio: coarseScreen ? 1.5 : 2,
      onGeometryUploadProgress: function (info) {
        if (!pendingGpuReady || info.geometry !== pendingGpuReady.msg.geometry) return;
        var labelPhase = pendingGpuReady.msg.summary.renderV >= pendingGpuReady.request.targetV ? 'Финал' : 'Прокси';
        setProgress(0.84 + 0.16 * Math.max(0, Math.min(1, info.fraction || 0)),
          labelPhase + ' v=' + pendingGpuReady.msg.summary.renderV + ': GPU-заливка геометрии');
      },
      onGeometryReady: function (geometry) {
        if (!pendingGpuReady || geometry !== pendingGpuReady.msg.geometry) return;
        var pending = pendingGpuReady;
        pendingGpuReady = null;
        finalizeReady(pending.msg, pending.request);
      },
      onPickDirection: function (direction) { sendPick(direction, 'select'); },
      onHoverDirection: function (direction) {
        var now = performance.now();
        if (now - lastHoverSentAt < 90) return;
        lastHoverSentAt = now;
        sendPick(direction, 'hover');
      },
      onPickMiss: function () {
        currentSelection = null;
        if (globe) globe.clearSelection();
        renderSelection(null);
      },
      onStats: renderFrameStats,
      onContextLost: function () { setStatus('WebGL-контекст потерян; ждём восстановления…', 'warn'); },
      onContextRestored: function () { setStatus('WebGL-контекст восстановлен.', 'ok'); }
    });
  } catch (err) {
    console.error(err);
    globe = null;
  }
  if (!globe) {
    webglAvailable = false;
    els.canvas.hidden = true;
    els.fallbackWrap.hidden = false;
    setStatus('WebGL2 недоступен: включился 2D fallback с развёрткой планеты.', 'warn');
  }

  function setStatus(text, kind) {
    els.status.textContent = text || '';
    els.status.dataset.kind = kind || '';
  }
  function fmtInt(x) {
    return Math.round(Number(x) || 0).toLocaleString('ru-RU');
  }
  function fmtNum(x, digits) {
    return (Number(x) || 0).toLocaleString('ru-RU', {
      minimumFractionDigits: digits == null ? 2 : digits,
      maximumFractionDigits: digits == null ? 2 : digits
    });
  }
  function fmtPct(x, digits) { return fmtNum((Number(x) || 0) * 100, digits == null ? 1 : digits) + '%'; }
  function fmtMs(x) { return fmtNum(x, x >= 100 ? 0 : 1) + ' мс'; }
  function fmtBytes(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes >= 1048576) return fmtNum(bytes / 1048576, 1) + ' МиБ';
    if (bytes >= 1024) return fmtNum(bytes / 1024, 0) + ' КиБ';
    return fmtInt(bytes) + ' Б';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ------------------------------------------------------------- CSV */
  function parseCsv(text) {
    var rows = [];
    var row = [], field = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch !== '\r') field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    var header = rows.shift() || [];
    return rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
      .map(function (r) {
        var out = {};
        header.forEach(function (h, idx) { out[h] = r[idx] == null ? '' : r[idx]; });
        return out;
      });
  }
  function fetchFirst(urls) {
    var chain = Promise.reject(new Error('нет URL'));
    urls.forEach(function (url) {
      chain = chain.catch(function () {
        return fetch(url).then(function (res) {
          if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
          return res.text();
        });
      });
    });
    return chain;
  }
  function numberFrom(row, key, fallback) {
    var n = Number(row && row[key]);
    return Number.isFinite(n) ? n : fallback;
  }

  function installPresets(rows) {
    presets = rows.filter(function (r) {
      return r.archetype_id && r.archetype_id !== 'gas_giant_bands';
    });
    presetsById = new Map(presets.map(function (r) { return [r.archetype_id, r]; }));
    els.preset.innerHTML = presets.map(function (r) {
      return '<option value="' + escapeHtml(r.archetype_id) + '">' +
        escapeHtml(r.display_name_ru || r.archetype_id) + '</option>';
    }).join('');
    var params = new URLSearchParams(window.location.search);
    if (params.get('preset') && presetsById.has(params.get('preset'))) els.preset.value = params.get('preset');
    if (params.get('seed')) els.seed.value = params.get('seed');
    if (params.get('planet')) els.planetId.value = params.get('planet');
    if (params.get('radius')) els.radius.value = params.get('radius');
    if (params.get('quality')) els.quality.value = params.get('quality');
    if (params.get('mode')) els.colorMode.value = params.get('mode');
    if (params.get('relief')) els.relief.value = params.get('relief');
    syncSurfaceClassWithPreset();
    if (params.get('surface')) els.surfaceClass.value = params.get('surface');
    updateEstimates();
  }

  function syncSurfaceClassWithPreset() {
    var preset = presetsById.get(els.preset.value);
    if (!preset) return;
    var preferred = PREFERRED_SURFACE_CLASS[preset.archetype_id] || 'terrestrial';
    els.surfaceClass.value = preferred;
    els.presetInfo.textContent = preset.description_ru || '';
  }

  function canonicalFrequency(radiusKm) {
    var cells = 163842 * Math.pow(radiusKm / 6371, 2);
    return Math.max(8, Math.round(Math.sqrt(Math.max(0, cells - 2) / 10)));
  }
  function cellCountFor(v) { return 10 * v * v + 2; }
  function isCoarseOrSmallScreen() {
    return window.matchMedia && (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760);
  }
  function targetRenderV(canonicalV) {
    var q = els.quality.value;
    var factor = 1;
    // Телефонная приёмка Redmi: v=80 на Земле давал лишнюю плотность,
    // которую экран телефона всё равно не различает после fit по ширине.
    if (q === 'auto') factor = isCoarseOrSmallScreen() ? 0.5 : 1;
    else if (q === 'balanced') factor = 0.75;
    else if (q === 'performance') factor = 0.5;
    else if (q === 'proxy') factor = 0.375;
    return Math.max(16, Math.min(256, Math.round(canonicalV * factor)));
  }
  function proxyRenderV(targetV) {
    if (!els.autoProxy.checked || targetV <= 40) return targetV;
    return Math.max(16, Math.min(48, Math.round(targetV * 0.375)));
  }
  function updateEstimates() {
    var radius = Math.max(300, Number(els.radius.value) || 6371);
    var canonical = canonicalFrequency(radius);
    var target = targetRenderV(canonical);
    var proxy = proxyRenderV(target);
    els.radiusOut.textContent = 'канон v=' + canonical + ' · ' + fmtInt(cellCountFor(canonical)) + ' яч.';
    els.qualityOut.textContent = proxy === target
      ? 'v=' + target + ' · ' + fmtInt(cellCountFor(target)) + ' яч.'
      : 'прокси v=' + proxy + ' → финал v=' + target + ' · ' + fmtInt(cellCountFor(target)) + ' яч.';
    return { radius: radius, canonical: canonical, target: target, proxy: proxy };
  }

  function profileFromControls() {
    var preset = presetsById.get(els.preset.value);
    if (!preset) throw new Error('Пресет ещё не загружен');
    var seedRaw = els.seed.value.trim() || 'korhal-iv';
    var planetId = els.planetId.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'stage6-planet';
    els.planetId.value = planetId;
    var profile = {
      planetId: planetId,
      presetId: preset.archetype_id,
      surfaceClass: els.surfaceClass.value,
      radiusKm: Math.max(300, Number(els.radius.value) || 6371),
      geographyVersion: 'c100-soft-v2',
      continentMeanCells: numberFrom(preset, 'continent_mean_cells', 400),
      continentVariation: numberFrom(preset, 'continent_variation', 0.8),
      oceanBasinMeanCells: numberFrom(preset, 'ocean_basin_mean_cells', 6000),
      drainageMeanCells: numberFrom(preset, 'drainage_mean_cells', 72),
      oceanPctl: numberFrom(preset, 'ocean_pctl', 70),
      shelfBelowPctl: numberFrom(preset, 'shelf_below_pctl', 67),
      shelfAbovePctl: numberFrom(preset, 'shelf_above_pctl', 73),
      highlandLandPctl: numberFrom(preset, 'highland_land_pctl', 75),
      mountainLandPctl: numberFrom(preset, 'mountain_land_pctl', 92),
      aridLandPctl: numberFrom(preset, 'arid_land_pctl', 25),
      wetLandPctl: numberFrom(preset, 'wet_land_pctl', 75),
      coldPctl: numberFrom(preset, 'cold_pctl', 20),
      hotPctl: numberFrom(preset, 'hot_pctl', 80),
      streamFlowPctl: numberFrom(preset, 'stream_flow_pctl', 90),
      majorRiverFlowPctl: numberFrom(preset, 'major_river_flow_pctl', 99),
      coastSoftWidthCells: numberFrom(preset, 'coast_soft_width_cells', 3),
      continentSoftWidthCells: numberFrom(preset, 'continent_soft_width_cells', 4),
      biomeSoftWidthCells: numberFrom(preset, 'biome_soft_width_cells', 2),
      transitionEntropyPctl: numberFrom(preset, 'transition_entropy_pctl', 90)
    };
    if (/^[0-9a-fA-F]{16}$/.test(seedRaw)) profile.masterSeedHex = seedRaw.toLowerCase();
    else profile.seedText = seedRaw;
    return profile;
  }
  function profileKey(profile) {
    return JSON.stringify(profile) + '|relief=' + els.relief.value + '|quality=' + els.quality.value;
  }
  function updateUrl(profile) {
    var params = new URLSearchParams();
    params.set('preset', els.preset.value);
    params.set('planet', profile.planetId);
    params.set('seed', els.seed.value.trim());
    params.set('radius', String(profile.radiusKm));
    params.set('surface', els.surfaceClass.value);
    params.set('quality', els.quality.value);
    params.set('mode', els.colorMode.value);
    params.set('relief', els.relief.value);
    window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
  }

  /* --------------------------------------------------------------- worker */
  function ensureWorker() {
    if (worker) return worker;
    workerToken = 'stage6-' + (++workerSeq) + '-' + Date.now();
    worker = new Worker('planet-globe-worker.js?v=' + VERSION);
    worker.onmessage = onWorkerMessage;
    worker.onerror = function (event) {
      activeRequest = null;
      pendingGpuReady = null;
      if (globe) globe.setAdaptiveQualityHold(false);
      showLoading(false);
      setStatus('Ошибка worker: ' + (event.message || 'неизвестная ошибка'), 'error');
    };
    return worker;
  }
  function restartWorker() {
    if (worker) worker.terminate();
    worker = null;
    return ensureWorker();
  }
  function showLoading(show, compact, title) {
    els.loading.hidden = !show;
    els.loading.classList.toggle('compact', !!compact);
    if (title) els.loadingTitle.textContent = title;
    if (show) setProgress(0, 'Подготовка…');
  }
  function setProgress(fraction, label) {
    var pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    els.loadingBar.style.width = pct + '%';
    els.loadingPct.textContent = pct + '%';
    if (label) els.loadingLabel.textContent = label;
  }

  function requestRender(profile, key, renderV, targetV, phase) {
    ensureWorker();
    pendingGpuReady = null;
    if (globe) globe.setAdaptiveQualityHold(true);
    var id = ++requestSeq;
    activeRequest = {
      id: id,
      profile: profile,
      profileKey: key,
      renderV: renderV,
      targetV: targetV,
      phase: phase,
      startedAt: performance.now()
    };
    worker.postMessage({
      type: 'generate',
      token: workerToken,
      requestId: id,
      profile: profile,
      renderV: renderV,
      colorMode: els.colorMode.value,
      reliefScale: Number(els.relief.value),
      fallbackPreview: !webglAvailable
    });
    var phaseName = renderV === targetV ? 'Финал' : 'Прокси';
    showLoading(true, phase === 'upgrade', phaseName + ' v=' + renderV + (renderV === targetV ? '' : ' → финал v=' + targetV));
    setStatus('Генерация: ' + profile.planetId + ', ' + phaseName.toLowerCase() + ' v=' + renderV + '…');
  }

  function startGeneration(restart, reason) {
    window.clearTimeout(upgradeTimer);
    window.clearTimeout(cycleTimer);
    var profile, key;
    try {
      profile = profileFromControls();
      key = profileKey(profile);
    } catch (err) {
      setStatus(err.message || String(err), 'error');
      return;
    }
    updateUrl(profile);
    var estimates = updateEstimates();
    if (restart) restartWorker(); else ensureWorker();
    currentSelection = null;
    if (globe) globe.clearSelection();
    renderSelection(null);
    var firstV = proxyRenderV(estimates.target);
    requestRender(profile, key, firstV, estimates.target, reason || (firstV === estimates.target ? 'final' : 'proxy'));
  }

  function scheduleUpgrade(request) {
    window.clearTimeout(upgradeTimer);
    upgradeTimer = window.setTimeout(function () {
      // Тот же worker сохраняет proxy-поверхность для pick, пока финал
      // считается в фоне. Пользователь уже видит и крутит планету.
      requestRender(request.profile, request.profileKey, request.targetV, request.targetV, 'upgrade');
    }, 250);
  }

  function onWorkerMessage(event) {
    var msg = event.data || {};
    if (msg.token && msg.token !== workerToken && msg.token !== displayedToken) return;
    if (msg.type === 'worker-ready') return;
    if (msg.type === 'progress') {
      if (!activeRequest || msg.requestId !== activeRequest.id || msg.token !== workerToken) return;
      var phase = activeRequest.renderV === activeRequest.targetV ? 'Финал' : 'Прокси';
      setProgress(msg.fraction, phase + ' v=' + activeRequest.renderV + ': ' + (msg.label || msg.stage));
      return;
    }
    if (msg.type === 'ready') {
      if (!activeRequest || msg.requestId !== activeRequest.id || msg.token !== workerToken) return;
      handleReady(msg);
      return;
    }
    if (msg.type === 'colors') {
      if (msg.token !== displayedToken) return;
      if (globe) globe.setColors(msg.colors);
      setStatus('Слой: ' + selectedColorLabel() + '.', 'ok');
      return;
    }
    if (msg.type === 'pick-result') {
      if (msg.token !== displayedToken) return;
      if (msg.purpose === 'hover') {
        if (msg.requestId !== latestHoverRequest) return;
        renderHover(msg.info);
      } else {
        if (msg.requestId !== latestPickRequest) return;
        currentSelection = msg.info;
        if (globe && msg.info && msg.info.polygon) globe.setSelection(msg.info.polygon);
        renderSelection(msg.info);
      }
      return;
    }
    if (msg.type === 'cache-cleared') {
      setStatus('Кэш сеток очищен. Следующая генерация построит топологию заново.', 'ok');
      return;
    }
    if (msg.type === 'error') {
      if (activeRequest && msg.requestId && msg.requestId !== activeRequest.id) return;
      if (msg.requestId === latestPickRequest || msg.requestId === latestHoverRequest) return;
      activeRequest = null;
      pendingGpuReady = null;
      if (globe) globe.setAdaptiveQualityHold(false);
      showLoading(false);
      setStatus('Ошибка: ' + (msg.message || msg.code || 'генерация не удалась'), 'error');
      els.stats.textContent = 'Генерация не удалась.\n' + (msg.message || '') + (msg.stack ? '\n\n' + msg.stack : '');
    }
  }

  function handleReady(msg) {
    var request = activeRequest;
    if (globe) {
      // Worker закончил CPU-часть, но видимым глобус станет только после
      // порционной GPU-заливки и атомарной подмены VAO. До этого момента
      // не объявляем планету готовой и не сбрасываем steady-статистику.
      pendingGpuReady = { msg: msg, request: request };
      currentSelection = null;
      globe.clearSelection();
      renderSelection(null);
      setProgress(0.84, (msg.summary.renderV >= request.targetV ? 'Финал' : 'Прокси') +
        ' v=' + msg.summary.renderV + ': GPU-заливка геометрии');
      setStatus('CPU-часть готова: заливаю геометрию на GPU…');
      globe.setGeometry(msg.geometry);
      return;
    }
    finalizeReady(msg, request);
  }

  function finalizeReady(msg, request) {
    displayedToken = msg.token;
    displayedSummary = msg.summary;
    displayedProfileKey = request.profileKey;
    setProgress(1, 'Готово');
    if (!globe && msg.preview) drawFallback(msg.preview);
    currentSelection = null;
    renderSelection(null);
    renderSummary(msg.summary);
    els.cells.textContent = fmtInt(msg.summary.cellCount);
    els.tris.textContent = fmtInt(msg.summary.triangleCount);
    els.lod.textContent = 'v=' + msg.summary.renderV + ' / канон ' + msg.summary.canonicalV;

    var isFinal = msg.summary.renderV >= request.targetV;
    if (isFinal) {
      completedPlanets++;
      generationHistory.unshift({
        planet: msg.summary.planetId,
        preset: msg.summary.presetId,
        v: msg.summary.renderV,
        total: msg.summary.timingsMs.total,
        at: new Date()
      });
      generationHistory = generationHistory.slice(0, 8);
      renderHistory();
      activeRequest = null;
      if (globe) {
        globe.setAdaptiveQualityHold(false);
        globe.resetStats();
      }
      showLoading(false);
      setStatus('Готово: ' + msg.summary.planetId + ', финал v=' + msg.summary.renderV + ', CPU за ' + fmtMs(msg.summary.timingsMs.total) + ', GPU-бандл подменён. Статистика кадров сброшена — для steady-замера покрутите глобус 10 секунд.', 'ok');
      if (els.colorMode.value !== msg.colorMode) sendColorMode();
      if (cycleActive) scheduleNextCycle();
    } else {
      setStatus('Прокси v=' + msg.summary.renderV + ' уже можно крутить. Финал v=' + request.targetV + ' считается следом…', 'ok');
      scheduleUpgrade(request);
    }
  }

  function drawFallback(preview) {
    els.fallback.width = preview.width;
    els.fallback.height = preview.height;
    var ctx = els.fallback.getContext('2d');
    var image = new ImageData(preview.data, preview.width, preview.height);
    ctx.putImageData(image, 0, 0);
    els.fallbackWrap.hidden = false;
  }

  function selectedColorLabel() {
    var opt = els.colorMode.options[els.colorMode.selectedIndex];
    return opt ? opt.textContent : els.colorMode.value;
  }
  function sendColorMode() {
    if (!worker || !displayedToken || activeRequest || pendingGpuReady) return;
    var id = ++requestSeq;
    worker.postMessage({
      type: 'color-mode',
      token: displayedToken,
      requestId: id,
      mode: els.colorMode.value
    });
  }
  function sendPick(direction, purpose) {
    if (!worker || !displayedToken || !displayedSummary || pendingGpuReady) return;
    var id = ++requestSeq;
    if (purpose === 'hover') latestHoverRequest = id; else latestPickRequest = id;
    worker.postMessage({
      type: 'pick',
      token: displayedToken,
      requestId: id,
      purpose: purpose,
      direction: direction
    });
  }

  /* --------------------------------------------------------------- вывод */
  function renderFrameStats(stats) {
    els.fps.textContent = stats.fps ? fmtNum(stats.fps, 0) : '—';
    els.frameP50.textContent = stats.p50 ? fmtNum(stats.p50, 1) : '—';
    els.frameP95.textContent = stats.p95 ? fmtNum(stats.p95, 1) : '—';
    els.frameP99.textContent = stats.p99 ? fmtNum(stats.p99, 1) : '—';
    els.frameOver50.textContent = String(stats.over50 || 0);
    els.frameOver100.textContent = String(stats.over100 || 0);
    els.renderScale.textContent = fmtNum(stats.renderScale || 1, 2) + '×';
    if (performance.memory && performance.memory.usedJSHeapSize) {
      els.heap.textContent = fmtBytes(performance.memory.usedJSHeapSize);
    } else els.heap.textContent = 'n/a';
  }
  function renderHistory() {
    if (!generationHistory.length) {
      els.switchHistory.textContent = 'Смен планет в этой сессии пока не было.';
      return;
    }
    els.switchHistory.textContent = 'Завершено планет: ' + completedPlanets + '\n' + generationHistory.map(function (h) {
      return '· ' + h.planet + ' / ' + h.preset + ' / v=' + h.v + ' — ' + fmtMs(h.total);
    }).join('\n');
  }
  function biomeName(id) {
    if (!displayedSummary || !displayedSummary.biomeDefinitions || !displayedSummary.biomeDefinitions[id]) return '—';
    return displayedSummary.biomeDefinitions[id].nameRu || displayedSummary.biomeDefinitions[id].key;
  }
  function renderSummary(s) {
    var st = s.stats || {};
    var hydro = st.hydrology || {};
    var flow = hydro.flow || {};
    var term = hydro.terminalLandAreaFractions || {};
    var continents = st.continents || {};
    var basins = st.oceanBasins || {};
    var drainage = hydro.drainageRegions || {};
    var mnt = st.mountains || {};
    var topBiomes = ((st.biomes && st.biomes.fractions) || []).slice()
      .sort(function (a, b) { return b.landAreaFraction - a.landAreaFraction; })
      .slice(0, 5)
      .map(function (b) { return biomeName(b.id) + ' ' + fmtPct(b.landAreaFraction); })
      .join(', ');
    var lines = [
      s.planetId + ' · ' + s.presetId + ' · R=' + fmtInt(s.radiusKm) + ' км',
      'seed: ' + s.masterSeedHex,
      'рендер v=' + s.renderV + ' из канонических ' + s.canonicalV + ' · ячеек ' + fmtInt(s.cellCount) + ' · треугольников ' + fmtInt(s.triangleCount),
      'геометрия GPU: ' + fmtBytes(s.geometryBytes) + ' · сетка: ' + s.gridSource,
      'время: сетка ' + fmtMs(s.timingsMs.mesh) + ', поверхность ' + fmtMs(s.timingsMs.surface) + ', геометрия ' + fmtMs(s.timingsMs.geometry),
      '',
      'океан (hard): ' + fmtPct(st.oceanFractionHard) + ' при цели ' + fmtPct(st.oceanFractionTarget),
      'мягкие доли: суша ' + fmtPct(st.softFractions && st.softFractions.land) + ', шельф ' + fmtPct(st.softFractions && st.softFractions.shelf) + ', океан ' + fmtPct(st.softFractions && st.softFractions.ocean),
      'континенты C100: ' + s.counts.continents + ', средняя эфф. масса ' + fmtNum(continents.distribution && continents.distribution.mean, 1) + ' яч. (цель рендера ' + fmtInt(s.renderProfileCells.continentMeanCells) + ')',
      'бассейны океана: ' + s.counts.oceanBasins + ', плит: ' + s.counts.plates,
      '',
      'суши маршрутизировано: ' + fmtPct(hydro.routedLandFraction) + '; терминалы: океан ' + fmtPct(term.ocean) + ', конечные озёра ' + fmtPct(term.terminalLake) + ', бессточные ' + fmtPct(term.endorheic),
      'озёр: ' + s.counts.lakes + '; strict catchments: ' + s.counts.catchments + '; дренажных регионов: ' + s.counts.drainageRegions + ' (средняя ' + fmtNum(drainage.distribution && drainage.distribution.mean, 1) + ' яч., цель ' + fmtInt(s.renderProfileCells.drainageMeanCells) + ')',
      'реки: stream ' + fmtPct(flow.streamLandCellFraction) + ', major ' + fmtPct(flow.majorRiverLandCellFraction) + ' суши',
      'горные хребты: ' + s.counts.mountainRanges + ', площадь гор ' + fmtPct(mnt.mountainAreaFraction) + ', швов ' + fmtPct(mnt.seamAreaFraction),
      '',
      'биомы: средняя энтропия ' + fmtNum(st.biomes && st.biomes.meanEntropy, 3),
      'топ по суше: ' + topBiomes,
      '',
      s.gridVersion + ' · ' + s.noiseVersion + ' · ' + s.surfaceVersion + ' (' + s.hydrologyVersion + ' + ' + s.biomeVersion + ')'
    ];
    els.stats.textContent = lines.join('\n');
  }
  function renderHover(info) {
    if (!info) { els.hover.textContent = ''; return; }
    els.hover.textContent = 'под курсором: ячейка #' + info.cell + ' · ' + biomeName(info.biome.top1Id) + ' · ' + HARD_CLASS_RU[info.hardClass] + ' · pick ' + fmtNum(info.pickMs, 2) + ' мс';
  }
  function renderSelection(info) {
    if (!info) {
      els.selection.innerHTML = '<b>Ячейка не выбрана.</b><br>Кликните или коснитесь глобуса: здесь появятся биом, континент, река и канонический адрес.';
      return;
    }
    var rows = [];
    function row(label, value) { rows.push('<div class="sel-row"><span>' + escapeHtml(label) + '</span><b>' + value + '</b></div>'); }
    row('Ячейка', '#' + info.cell + ' · ' + fmtInt(info.areaKm2) + ' км²');
    row('Адрес', '<code>' + escapeHtml(info.address) + '</code>');
    row('Координаты', fmtNum(info.latitudeDeg, 2) + '°, ' + fmtNum(info.longitudeDeg, 2) + '°');
    row('Класс', HARD_CLASS_RU[info.hardClass] + ' · высота−море ' + fmtNum(info.elevationRelative, 4));
    row('Биом', escapeHtml(biomeName(info.biome.top1Id)) + ' ' + fmtPct(info.biome.top1Weight) +
      (info.biome.top2Id >= 0 ? ' + ' + escapeHtml(biomeName(info.biome.top2Id)) + ' ' + fmtPct(info.biome.top2Weight) : ''));
    row('Климат', 'температура ' + fmtPct(info.temperature, 0) + ', влажность ' + fmtPct(info.moisture, 0) + ', вулканизм ' + fmtPct(info.volcanism, 0));
    row('Мягкий берег', 'суша ' + fmtPct(info.mu.land) + ', шельф ' + fmtPct(info.mu.shelf) + ', океан ' + fmtPct(info.mu.ocean) + '; до берега ' + fmtNum(info.coastDistanceCells, 2) + ' яч.');
    if (info.continent) {
      row('Континент C100', '#' + info.continent.top1Id + ' · ' + fmtPct(info.continent.top1Weight) + ' · эфф. площадь ' + fmtInt(info.continent.effectiveAreaKm2) + ' км²');
    } else if (info.oceanBasinId >= 0) {
      row('Бассейн океана', '#' + info.oceanBasinId + ' · вес ' + fmtPct(info.oceanBasinWeight));
    }
    if (info.flow.accumulationKm2 > 0 || info.catchment) {
      row('Сток', fmtInt(info.flow.accumulationKm2) + ' км² · stream ' + fmtPct(info.flow.streamWeight) + ' · влияние реки ' + fmtPct(info.flow.riverInfluence));
    }
    if (info.drainageRegion) {
      row('Дренажный регион', '#' + info.drainageRegion.id + ' · ' + fmtInt(info.drainageRegion.cellCount) + ' яч. · → ' + (TERMINAL_RU[info.drainageRegion.terminalType] || info.drainageRegion.terminalType));
    }
    if (info.lake) row('Озеро', '#' + info.lake.id + ' · ' + fmtInt(info.lake.areaKm2) + ' км²');
    if (info.mountains.weight > 0.01 || info.mountains.rangeId >= 0) {
      row('Горы', 'вес ' + fmtPct(info.mountains.weight) + ', шов ' + fmtPct(info.mountains.seamWeight) + (info.mountains.rangeId >= 0 ? ', хребет #' + info.mountains.rangeId : ''));
    }
    row('Pick', fmtNum(info.pickMs, 2) + ' мс');
    els.selection.innerHTML = rows.join('');
  }

  /* --------------------------------------------------------------- цикл */
  function randomSeedHex() {
    var bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  function nextPlanet() {
    if (!presets.length) return;
    var idx = presets.findIndex(function (p) { return p.archetype_id === els.preset.value; });
    var next = presets[(idx + 1) % presets.length];
    els.preset.value = next.archetype_id;
    syncSurfaceClassWithPreset();
    els.seed.value = randomSeedHex();
    els.planetId.value = 'stage6-' + next.archetype_id.replace(/_/g, '-');
    updateEstimates();
    startGeneration(true, 'manual');
  }
  function scheduleNextCycle() {
    window.clearTimeout(cycleTimer);
    cycleTimer = window.setTimeout(function () {
      if (cycleActive) nextPlanet();
    }, 5000);
  }
  function setCycle(active) {
    cycleActive = !!active;
    els.cycle.setAttribute('aria-pressed', cycleActive ? 'true' : 'false');
    els.cycle.textContent = cycleActive ? 'стоп: автосмена планет' : 'автосмена планет (стресс)';
    window.clearTimeout(cycleTimer);
    if (cycleActive && !activeRequest) scheduleNextCycle();
    if (cycleActive) setStatus('Автосмена включена: новая планета каждые ~5 секунд после готовности финала.', 'ok');
  }

  /* --------------------------------------------------------------- события */
  els.preset.addEventListener('change', function () { syncSurfaceClassWithPreset(); updateEstimates(); });
  els.radius.addEventListener('input', updateEstimates);
  els.quality.addEventListener('change', function () {
    updateEstimates();
    if (!activeRequest && displayedSummary) {
      // Качество — тот же профиль на другой render-v: worker не убиваем,
      // текущая планета остаётся доступна для pick до замены.
      var profile = profileFromControls();
      var key = profileKey(profile);
      var est = updateEstimates();
      if (displayedSummary.renderV !== est.target) requestRender(profile, key, proxyRenderV(est.target), est.target, 'quality');
    }
  });
  els.autoProxy.addEventListener('change', updateEstimates);
  els.colorMode.addEventListener('change', function () {
    if (displayedSummary) updateUrl(profileFromControls());
    if (activeRequest) setStatus('Слой применится после готовности текущей генерации.');
    else sendColorMode();
  });
  els.relief.addEventListener('change', function () {
    setStatus('Высота рельефа применится при следующей перегенерации геометрии.');
  });
  els.randomSeed.addEventListener('click', function () { els.seed.value = randomSeedHex(); });
  els.generate.addEventListener('click', function () { startGeneration(true, 'manual'); });
  els.nextPlanet.addEventListener('click', nextPlanet);
  els.cycle.addEventListener('click', function () { setCycle(!cycleActive); });
  els.clearCache.addEventListener('click', function () {
    ensureWorker();
    worker.postMessage({ type: 'clear-grid-cache', token: workerToken, requestId: ++requestSeq });
  });
  function toggleButton(button, initial, apply) {
    var state = initial;
    button.setAttribute('aria-pressed', state ? 'true' : 'false');
    button.addEventListener('click', function () {
      state = !state;
      button.setAttribute('aria-pressed', state ? 'true' : 'false');
      apply(state);
    });
    return function () { return state; };
  }
  var spinState = toggleButton(els.spin, true, function (on) { if (globe) globe.setAutoRotate(on); });
  toggleButton(els.borders, true, function (on) { if (globe) globe.setBordersEnabled(on); });
  toggleButton(els.atmosphere, true, function (on) { if (globe) globe.setAtmosphereEnabled(on); });
  els.resetView.addEventListener('click', function () { if (globe) globe.resetView(); });
  els.panelToggle.addEventListener('click', function () {
    var expanded = els.panelToggle.getAttribute('aria-expanded') !== 'false';
    els.panelToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    els.panelToggle.textContent = expanded ? '+' : '−';
    els.panelBody.hidden = expanded;
  });
  window.addEventListener('keydown', function (event) {
    if (event.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement && document.activeElement.tagName || '')) {
      event.preventDefault();
      els.spin.click();
    }
  });

  renderHistory();
  renderSelection(null);
  fetchFirst([
    '../data/planet-archetypes-template.csv?v=' + VERSION,
    '../../data/planet-archetypes-template.csv?v=' + VERSION,
    '/data/planet-archetypes-template.csv?v=' + VERSION
  ]).then(function (text) {
    installPresets(parseCsv(text));
    ensureWorker();
    startGeneration(false, 'initial');
    void spinState;
  }).catch(function (err) {
    setStatus('Не удалось загрузить пресеты планет: ' + err.message, 'error');
    els.stats.textContent = 'Пресеты не загрузились. Проверьте, что страница открыта с опубликованного сайта TIMELINE PROJECT, а не как локальный файл.';
  });
})();
