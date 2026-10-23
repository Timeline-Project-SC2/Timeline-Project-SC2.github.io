#!/usr/bin/env node
/* Bench профилирования этапов генерации планеты (Stage-8.9.2 / A-13).
 *
 * Измеряет время каждого этапа через события onProgress для синхронного
 * generateSurface и асинхронного generateSurfaceAsync раздельно, выявляя
 * пробуксовку (bottlenecks) и накладные расходы yieldControl.
 *
 * Использование:
 *   node tools/bench_planet_stages.mjs
 *   node tools/bench_planet_stages.mjs --v=128 --seeds=5 --preset=earthlike_balanced
 *   node tools/bench_planet_stages.mjs --v=128 --seeds=5 --json=stages-run1.json
 *   node tools/bench_planet_stages.mjs --v=128 --seeds=5 --compare=stages-run1.json
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { PRESETS as CONTRACT_PRESETS, getPresetGeographyValues } from '../site/shared/planet-generation-contract.ts';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetGeography = require('../site/shared/planet-geography.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;

const PREFERRED_SURFACE_CLASS = {
  earthlike_balanced: 'terrestrial',
  earthlike_archipelago: 'terrestrial',
  ocean_world: 'ocean',
  desert_dry: 'desert',
  ice_world: 'ice',
  volcanic_active: 'volcanic',
  barren_moon: 'barren',
  gas_giant_bands: 'gas_giant',
};

function parseArgs(argv) {
  const result = {
    v: 128,
    seeds: 5,
    seedStart: 0,
    preset: 'earthlike_balanced',
    radiusKm: 6371,
    surfaceClass: null,
    json: null,
    compare: null,
    warmup: true,
    overrides: {},
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(`Использование: node tools/bench_planet_stages.mjs [опции]

Опции:
  --v=<число>          Частота разбиения геодезической сетки (по умолчанию: 128)
  --seeds=<число>      Количество сидов для медианы (по умолчанию: 5)
  --seed-start=<число> Начальный индекс сида (по умолчанию: 0)
  --preset=<имя>       Пресет планеты (по умолчанию: earthlike_balanced)
  --radius-km=<число>  Радиус планеты в км (по умолчанию: 6371)
  --surface-class=<кл> Класс поверхности (terrestrial, ocean, desert, ice, volcanic, barren, gas_giant)
  --json=<путь>        Сохранить результаты в формате JSON
  --compare=<путь>     Сравнить с предыдущим JSON-прогоном
  --no-warmup          Отключить прогрев JIT
  --set=ключ=значение  Переопределить параметр профиля
`);
      process.exit(0);
    }
    if (arg === '--no-warmup') {
      result.warmup = false;
      continue;
    }
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`Неизвестный аргумент: ${arg}`);
    const [, name, raw] = m;
    if (name === 'v') result.v = Number(raw);
    else if (name === 'seeds') result.seeds = Number(raw);
    else if (name === 'seed-start') result.seedStart = Number(raw);
    else if (name === 'preset') result.preset = raw;
    else if (name === 'radius-km') result.radiusKm = Number(raw);
    else if (name === 'surface-class') result.surfaceClass = raw;
    else if (name === 'json') result.json = raw;
    else if (name === 'compare') result.compare = raw;
    else if (name === 'set') {
      const eq = raw.indexOf('=');
      if (eq <= 0) throw new Error(`Ожидался --set=поле=значение, получено: ${arg}`);
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      result.overrides[key] = Number.isFinite(Number(value)) && value.trim() !== '' ? Number(value) : value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  if (!Number.isInteger(result.v) || result.v < 1) throw new Error('--v должно быть целым >= 1');
  if (!Number.isInteger(result.seeds) || result.seeds < 1 || result.seeds > 1000) throw new Error('--seeds: 1..1000');
  if (!Number.isInteger(result.seedStart) || result.seedStart < 0) throw new Error('--seed-start должно быть целым >= 0');
  if (!(result.radiusKm > 0)) throw new Error('--radius-km должно быть > 0');
  return result;
}

function loadPresets() {
  return Object.fromEntries(Object.entries(CONTRACT_PRESETS).map(([presetId, preset]) => [
    presetId,
    {
      description: preset.description,
      palette_id: preset.palette_id,
      expected_surface_classes: [...preset.expected_surface_classes],
      values: getPresetGeographyValues(presetId),
    },
  ]));
}

function seedFor(presetId, index) {
  return createHash('sha256')
    .update(`planet-stage5-calibration-v1|${presetId}|${index}`)
    .digest('hex')
    .slice(0, 16);
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function quantileSorted(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function distribution(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sum: round(sum, 2),
    mean: sorted.length ? round(sum / sorted.length, 2) : 0,
    min: sorted.length ? round(sorted[0], 2) : 0,
    p10: round(quantileSorted(sorted, 0.1), 2),
    median: round(quantileSorted(sorted, 0.5), 2),
    p90: round(quantileSorted(sorted, 0.9), 2),
    max: sorted.length ? round(sorted[sorted.length - 1], 2) : 0,
  };
}

/**
 * Замер времени этапов генерации через onProgress.
 *
 * Длительность этапа = время от его события (или старта) до события следующего этапа;
 * последний этап закрывается по возврату (resolve) из генерации.
 */
function measureGenerationStages(fn, grid, input) {
  const stageOrder = [];
  const stageDurations = new Map();
  let currentStage = 'fields';
  stageOrder.push('fields');

  const tStart = performance.now();
  let currentStageStart = tStart;

  const onProgress = (stage) => {
    if (stage === 'done') return;
    const now = performance.now();
    if (stage !== currentStage) {
      if (currentStage !== null) {
        const dur = now - currentStageStart;
        stageDurations.set(currentStage, (stageDurations.get(currentStage) || 0) + dur);
      }
      if (!stageOrder.includes(stage)) {
        stageOrder.push(stage);
      }
      currentStage = stage;
      currentStageStart = now;
    }
  };

  const res = fn(grid, input, { onProgress });
  if (res && typeof res.then === 'function') {
    return res.then((surface) => {
      const tEnd = performance.now();
      if (currentStage !== null) {
        const dur = tEnd - currentStageStart;
        stageDurations.set(currentStage, (stageDurations.get(currentStage) || 0) + dur);
      }
      const totalMs = tEnd - tStart;
      const stagesObj = {};
      for (const st of stageOrder) {
        stagesObj[st] = stageDurations.get(st) || 0;
      }
      return { totalMs, stages: stagesObj, stageOrder, surface };
    });
  } else {
    const tEnd = performance.now();
    if (currentStage !== null) {
      const dur = tEnd - currentStageStart;
      stageDurations.set(currentStage, (stageDurations.get(currentStage) || 0) + dur);
    }
    const totalMs = tEnd - tStart;
    const stagesObj = {};
    for (const st of stageOrder) {
      stagesObj[st] = stageDurations.get(st) || 0;
    }
    return Promise.resolve({ totalMs, stages: stagesObj, stageOrder, surface: res });
  }
}

async function runBenchmark() {
  const options = parseArgs(process.argv.slice(2));
  const presets = loadPresets();
  const preset = presets[options.preset];
  if (!preset) throw new Error(`Неизвестный preset: ${options.preset}`);

  const surfaceClass = options.surfaceClass || PREFERRED_SURFACE_CLASS[options.preset] || 'terrestrial';
  const cellCount = GeodesicGrid.cellCountForFrequency(options.v);

  let compareData = null;
  if (options.compare) {
    const comparePath = path.resolve(process.cwd(), options.compare);
    if (!fs.existsSync(comparePath)) {
      throw new Error(`Файл для сравнения не найден: ${comparePath}`);
    }
    compareData = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
  }

  // Прогрев JIT (warmup) для исключения эффекта компиляции первого сида
  if (options.warmup) {
    const warmupGrid = GeodesicGrid.build(16);
    const warmupInput = {
      ...preset.values,
      preset_id: options.preset,
      surface_class: surfaceClass,
      radius_km: 1000,
      master_seed_hex: seedFor(options.preset, 9999),
      grid_version: warmupGrid.gridVersion,
      noise_version: PlanetGeography.NOISE_VERSION,
      geography_version: PlanetSurface.GEOGRAPHY_VERSION,
      preset_version: PlanetGeography.PRESET_VERSION,
    };
    PlanetSurface.generateSurface(warmupGrid, warmupInput);
    await PlanetSurface.generateSurfaceAsync(warmupGrid, warmupInput);
  }

  // Сборка общей сетки для заданного v
  const grid = GeodesicGrid.build(options.v);

  const syncSeedResults = [];
  const asyncSeedResults = [];
  const allStagesSet = new Set();
  const orderedStages = [];

  for (let i = 0; i < options.seeds; i++) {
    const seedIndex = options.seedStart + i;
    const seedHex = seedFor(options.preset, seedIndex);

    const input = {
      ...preset.values,
      ...options.overrides,
      preset_id: options.preset,
      surface_class: surfaceClass,
      radius_km: options.radiusKm,
      master_seed_hex: seedHex,
      grid_version: grid.gridVersion,
      noise_version: PlanetGeography.NOISE_VERSION,
      geography_version: PlanetSurface.GEOGRAPHY_VERSION,
      preset_version: PlanetGeography.PRESET_VERSION,
    };

    // Синхронный замер
    const syncRes = await measureGenerationStages(PlanetSurface.generateSurface, grid, input);
    syncRes.seedIndex = seedIndex;
    syncRes.seedHex = seedHex;
    syncSeedResults.push(syncRes);
    for (const st of syncRes.stageOrder) {
      if (!allStagesSet.has(st)) {
        allStagesSet.add(st);
        orderedStages.push(st);
      }
    }

    // Асинхронный замер
    const asyncRes = await measureGenerationStages(PlanetSurface.generateSurfaceAsync, grid, input);
    asyncRes.seedIndex = seedIndex;
    asyncRes.seedHex = seedHex;
    asyncSeedResults.push(asyncRes);
    for (const st of asyncRes.stageOrder) {
      if (!allStagesSet.has(st)) {
        allStagesSet.add(st);
        orderedStages.push(st);
      }
    }
  }

  // Агрегация по этапам
  function aggregateStages(seedResults) {
    const stageStats = {};
    for (const stage of orderedStages) {
      const stageTimes = seedResults.map((r) => r.stages[stage] || 0);
      stageStats[stage] = distribution(stageTimes);
    }
    const totals = seedResults.map((r) => r.totalMs);
    const totalDist = distribution(totals);
    const sumOfMedians = round(orderedStages.reduce((acc, st) => acc + stageStats[st].median, 0), 2);
    const discrepancyMs = round(sumOfMedians - totalDist.median, 2);
    const discrepancyPercent = totalDist.median > 0
      ? round((Math.abs(sumOfMedians - totalDist.median) / totalDist.median) * 100, 3)
      : 0;

    // Доли от суммы медиан
    for (const stage of orderedStages) {
      const med = stageStats[stage].median;
      stageStats[stage].fractionOfSum = sumOfMedians > 0 ? round(med / sumOfMedians, 4) : 0;
      stageStats[stage].percentOfSum = sumOfMedians > 0 ? round((med / sumOfMedians) * 100, 2) : 0;
    }

    return {
      stages: stageStats,
      totalDistribution: totalDist,
      sumOfMedians,
      totalMedian: totalDist.median,
      discrepancyMs,
      discrepancyPercent,
      discrepancyOk: discrepancyPercent <= 2.0,
      seeds: seedResults.map((r) => ({
        seedIndex: r.seedIndex,
        seedHex: r.seedHex,
        totalMs: round(r.totalMs, 2),
        stages: Object.fromEntries(Object.entries(r.stages).map(([k, v]) => [k, round(v, 2)])),
      })),
    };
  }

  const syncAgg = aggregateStages(syncSeedResults);
  const asyncAgg = aggregateStages(asyncSeedResults);

  // Сравнение Sync vs Async по этапам
  const diffStages = {};
  for (const st of orderedStages) {
    const sMed = syncAgg.stages[st].median;
    const aMed = asyncAgg.stages[st].median;
    const deltaMs = round(aMed - sMed, 2);
    const deltaPercent = sMed > 0 ? round(((aMed - sMed) / sMed) * 100, 2) : 0;
    diffStages[st] = {
      syncMedianMs: sMed,
      asyncMedianMs: aMed,
      deltaMs,
      deltaPercent,
    };
  }
  const totalDeltaMs = round(asyncAgg.totalMedian - syncAgg.totalMedian, 2);
  const totalDeltaPercent = syncAgg.totalMedian > 0
    ? round(((asyncAgg.totalMedian - syncAgg.totalMedian) / syncAgg.totalMedian) * 100, 2)
    : 0;

  // Формирование JSON-результата
  const outputJson = {
    schema: 'planet-stages-bench/v1',
    generatedAt: new Date().toISOString(),
    v: options.v,
    cells: cellCount,
    preset: options.preset,
    surfaceClass,
    radiusKm: options.radiusKm,
    seedCount: options.seeds,
    seedStart: options.seedStart,
    stagesCount: orderedStages.length,
    orderedStages,
    sync: {
      stagesSumMedianMs: syncAgg.sumOfMedians,
      totalMedianMs: syncAgg.totalMedian,
      discrepancyMs: syncAgg.discrepancyMs,
      discrepancyPercent: syncAgg.discrepancyPercent,
      discrepancyOk: syncAgg.discrepancyOk,
      stages: Object.fromEntries(orderedStages.map((st) => [st, {
        medianMs: syncAgg.stages[st].median,
        meanMs: syncAgg.stages[st].mean,
        minMs: syncAgg.stages[st].min,
        maxMs: syncAgg.stages[st].max,
        percentOfSum: syncAgg.stages[st].percentOfSum,
        fractionOfSum: syncAgg.stages[st].fractionOfSum,
      }])),
      seeds: syncAgg.seeds,
    },
    async: {
      stagesSumMedianMs: asyncAgg.sumOfMedians,
      totalMedianMs: asyncAgg.totalMedian,
      discrepancyMs: asyncAgg.discrepancyMs,
      discrepancyPercent: asyncAgg.discrepancyPercent,
      discrepancyOk: asyncAgg.discrepancyOk,
      stages: Object.fromEntries(orderedStages.map((st) => [st, {
        medianMs: asyncAgg.stages[st].median,
        meanMs: asyncAgg.stages[st].mean,
        minMs: asyncAgg.stages[st].min,
        maxMs: asyncAgg.stages[st].max,
        percentOfSum: asyncAgg.stages[st].percentOfSum,
        fractionOfSum: asyncAgg.stages[st].fractionOfSum,
      }])),
      seeds: asyncAgg.seeds,
    },
    diffAsyncVsSync: {
      totalDeltaMs,
      totalDeltaPercent,
      stages: diffStages,
    },
  };

  if (options.json) {
    const jsonPath = path.resolve(process.cwd(), options.json);
    fs.writeFileSync(jsonPath, JSON.stringify(outputJson, null, 2), 'utf8');
  }

  // --- Печать отчёта в stdout ---
  const pad = (s, len, right = false) => {
    const str = String(s);
    return right ? str.padStart(len) : str.padEnd(len);
  };
  const fmtNum = (n, dec = 1) => (Number.isFinite(n) ? n.toFixed(dec) : '-');
  const fmtDelta = (ms, pct) => {
    if (!Number.isFinite(ms)) return '-';
    const sign = ms >= 0 ? '+' : '';
    return `${sign}${ms.toFixed(1)} ms (${sign}${pct.toFixed(1)}%)`;
  };

  console.log(`\n========================================================================================================`);
  console.log(`  ПРОФИЛИРОВАНИЕ ЭТАПОВ ГЕНЕРАЦИИ ПЛАНЕТЫ (Stage-8.9.2 / A-13)`);
  console.log(`  Пресет: ${options.preset} (${surfaceClass}) | v=${options.v} (${cellCount.toLocaleString('ru-RU')} ячеек) | Сидов: ${options.seeds}`);
  if (compareData) {
    console.log(`  Сравнение с: ${options.compare} (сгенерирован: ${compareData.generatedAt || 'н/д'})`);
  }
  console.log(`========================================================================================================\n`);

  const hasCompare = Boolean(compareData);
  const colW = {
    stage: 26,
    syncMs: 12,
    syncPct: 10,
    asyncMs: 12,
    asyncPct: 10,
    diff: 20,
    cmpSync: 22,
  };

  // 1. Таблица синхронной и асинхронной генерации
  console.log(`Таблица этапов (медианы по ${options.seeds} сидам):`);
  let header = `┌${'─'.repeat(colW.stage + 2)}┬${'─'.repeat(colW.syncMs + 2)}┬${'─'.repeat(colW.syncPct + 2)}┬${'─'.repeat(colW.asyncMs + 2)}┬${'─'.repeat(colW.asyncPct + 2)}┬${'─'.repeat(colW.diff + 2)}`;
  if (hasCompare) {
    header += `┬${'─'.repeat(colW.cmpSync + 2)}`;
  }
  header += '┐';
  console.log(header);

  let titleRow = `│ ${pad('Этап (Stage)', colW.stage)} │ ${pad('Sync (мс)', colW.syncMs, true)} │ ${pad('Доля %', colW.syncPct, true)} │ ${pad('Async (мс)', colW.asyncMs, true)} │ ${pad('Доля %', colW.asyncPct, true)} │ ${pad('Δ Async-Sync', colW.diff, true)} `;
  if (hasCompare) {
    titleRow += `│ ${pad('Δ vs Compare (Sync)', colW.cmpSync, true)} `;
  }
  titleRow += '│';
  console.log(titleRow);

  let midDivider = `├${'─'.repeat(colW.stage + 2)}┼${'─'.repeat(colW.syncMs + 2)}┼${'─'.repeat(colW.syncPct + 2)}┼${'─'.repeat(colW.asyncMs + 2)}┼${'─'.repeat(colW.asyncPct + 2)}┼${'─'.repeat(colW.diff + 2)}`;
  if (hasCompare) {
    midDivider += `┼${'─'.repeat(colW.cmpSync + 2)}`;
  }
  midDivider += '┤';
  console.log(midDivider);

  for (const st of orderedStages) {
    const sMed = syncAgg.stages[st].median;
    const sPct = syncAgg.stages[st].percentOfSum;
    const aMed = asyncAgg.stages[st].median;
    const aPct = asyncAgg.stages[st].percentOfSum;
    const diff = diffStages[st];
    const diffStr = fmtDelta(diff.deltaMs, diff.deltaPercent);

    let row = `│ ${pad(st, colW.stage)} │ ${pad(fmtNum(sMed), colW.syncMs, true)} │ ${pad(fmtNum(sPct) + '%', colW.syncPct, true)} │ ${pad(fmtNum(aMed), colW.asyncMs, true)} │ ${pad(fmtNum(aPct) + '%', colW.asyncPct, true)} │ ${pad(diffStr, colW.diff, true)} `;

    if (hasCompare) {
      const cmpSyncVal = compareData?.sync?.stages?.[st]?.medianMs ?? compareData?.sync?.stages?.[st]?.median ?? compareData?.sync?.stages?.[st];
      let cmpSyncStr = '-';
      if (Number.isFinite(cmpSyncVal)) {
        const dMs = sMed - cmpSyncVal;
        const dPct = cmpSyncVal > 0 ? (dMs / cmpSyncVal) * 100 : 0;
        cmpSyncStr = fmtDelta(dMs, dPct);
      }
      row += `│ ${pad(cmpSyncStr, colW.cmpSync, true)} `;
    }
    row += '│';
    console.log(row);
  }

  console.log(midDivider);

  // Итоговая строка: Сумма этапов
  const sumDiffStr = fmtDelta(totalDeltaMs, totalDeltaPercent);
  let sumRow = `│ ${pad('Сумма этапов (Sum)', colW.stage)} │ ${pad(fmtNum(syncAgg.sumOfMedians), colW.syncMs, true)} │ ${pad('100.0%', colW.syncPct, true)} │ ${pad(fmtNum(asyncAgg.sumOfMedians), colW.asyncMs, true)} │ ${pad('100.0%', colW.asyncPct, true)} │ ${pad(sumDiffStr, colW.diff, true)} `;
  if (hasCompare) {
    const cmpSum = compareData?.sync?.stagesSumMedianMs ?? compareData?.sync?.totalMedianMs;
    let cmpSumStr = '-';
    if (Number.isFinite(cmpSum)) {
      const dMs = syncAgg.sumOfMedians - cmpSum;
      const dPct = cmpSum > 0 ? (dMs / cmpSum) * 100 : 0;
      cmpSumStr = fmtDelta(dMs, dPct);
    }
    sumRow += `│ ${pad(cmpSumStr, colW.cmpSync, true)} `;
  }
  sumRow += '│';
  console.log(sumRow);

  // Общее время (Total elapsed)
  let totRow = `│ ${pad('Общее время (Total elapsed)', colW.stage)} │ ${pad(fmtNum(syncAgg.totalMedian), colW.syncMs, true)} │ ${pad('-', colW.syncPct, true)} │ ${pad(fmtNum(asyncAgg.totalMedian), colW.asyncMs, true)} │ ${pad('-', colW.asyncPct, true)} │ ${pad(sumDiffStr, colW.diff, true)} `;
  if (hasCompare) {
    const cmpTot = compareData?.sync?.totalMedianMs ?? compareData?.sync?.totalMedian;
    let cmpTotStr = '-';
    if (Number.isFinite(cmpTot)) {
      const dMs = syncAgg.totalMedian - cmpTot;
      const dPct = cmpTot > 0 ? (dMs / cmpTot) * 100 : 0;
      cmpTotStr = fmtDelta(dMs, dPct);
    }
    totRow += `│ ${pad(cmpTotStr, colW.cmpSync, true)} `;
  }
  totRow += '│';
  console.log(totRow);

  let bottomDivider = `└${'─'.repeat(colW.stage + 2)}┴${'─'.repeat(colW.syncMs + 2)}┴${'─'.repeat(colW.syncPct + 2)}┴${'─'.repeat(colW.asyncMs + 2)}┴${'─'.repeat(colW.asyncPct + 2)}┴${'─'.repeat(colW.diff + 2)}`;
  if (hasCompare) {
    bottomDivider += `┴${'─'.repeat(colW.cmpSync + 2)}`;
  }
  bottomDivider += '┘';
  console.log(bottomDivider);

  // 2. Контроль сходимости (расхождение суммы этапов и общего времени)
  console.log(`\nКонтроль сходимости (сумма этапов vs общее время):`);
  const syncStatus = syncAgg.discrepancyOk ? 'OK' : 'ПРЕДУПРЕЖДЕНИЕ (> 2%)';
  const asyncStatus = asyncAgg.discrepancyOk ? 'OK' : 'ПРЕДУПРЕЖДЕНИЕ (> 2%)';
  console.log(`  Sync:  сумма ${fmtNum(syncAgg.sumOfMedians)} мс vs total ${fmtNum(syncAgg.totalMedian)} мс | расхождение: ${syncAgg.discrepancyPercent.toFixed(3)}% [${syncStatus}]`);
  console.log(`  Async: сумма ${fmtNum(asyncAgg.sumOfMedians)} мс vs total ${fmtNum(asyncAgg.totalMedian)} мс | расхождение: ${asyncAgg.discrepancyPercent.toFixed(3)}% [${asyncStatus}]`);

  if (!syncAgg.discrepancyOk || !asyncAgg.discrepancyOk) {
    console.warn(`\nВНИМАНИЕ: Расхождение между суммой медиан этапов и медианой общего времени превышает 2%!`);
  }

  // 3. Анализ основных узких мест (пробуксовки)
  const sortedSyncStages = [...orderedStages].sort((a, b) => syncAgg.stages[b].median - syncAgg.stages[a].median);
  console.log(`\nОсновные узкие места (топ-4 по времени в синхронном режиме):`);
  for (let rank = 0; rank < Math.min(4, sortedSyncStages.length); rank++) {
    const st = sortedSyncStages[rank];
    const sMed = syncAgg.stages[st].median;
    const sPct = syncAgg.stages[st].percentOfSum;
    console.log(`  ${rank + 1}. ${pad(st, 24)}: ${fmtNum(sMed, 1)} мс (${fmtNum(sPct, 1)}% времени генерации)`);
  }

  console.log(`\nНакладные расходы асинхронного режима (yieldControl):`);
  const fieldsDiff = diffStages['fields'];
  if (fieldsDiff) {
    console.log(`  Этап fields (20 чанков × yieldControl): Sync ${fmtNum(fieldsDiff.syncMedianMs)} мс → Async ${fmtNum(fieldsDiff.asyncMedianMs)} мс (Δ ${fmtDelta(fieldsDiff.deltaMs, fieldsDiff.deltaPercent)})`);
  }
  console.log(`  Суммарная разница Async vs Sync: ${fmtDelta(totalDeltaMs, totalDeltaPercent)}`);
  console.log(`========================================================================================================\n`);

  if (options.json) {
    console.log(`JSON-отчёт сохранён в: ${options.json}`);
  }
}

runBenchmark().catch((err) => {
  console.error('Ошибка выполнения бенчмарка этапов:', err);
  process.exit(1);
});
