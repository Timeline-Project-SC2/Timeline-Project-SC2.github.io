#!/usr/bin/env node
/* Стенд измерительных метрик качества локальной карты (Stage-8.12d, шаг 1).
 * ---------------------------------------------------------------------------
 * Один инструмент вместо потока «снимок глазами → отдельная карточка дефекта».
 * Печатает таблицу метрик по 7 контрольным ячейкам канонической сетки
 * Земли v=128 и служит оракулом для распила (шаг 2): после починки стенд
 * должен перейти из красного в зелёный без ручной правки отчёта.
 *
 *   node tools/stand_local_map.mjs            печать таблицы, всегда exit 0
 *   node tools/stand_local_map.mjs --gate     exit 1, если хотя бы одна метрика красная
 *   node tools/stand_local_map.mjs --json     та же таблица в JSON
 *   node tools/stand_local_map.mjs --profile=a17   другой мир (профиль A-17)
 *   node tools/stand_local_map.mjs --radius-m=2500 радиус участка, м
 *
 * Гейт по умолчанию выключен: пороги красные намеренно (фиксируют текущие
 * дефекты), CI ломать нельзя. Включать гейт можно только после того, как
 * волна починки закроет красные метрики.
 *
 * ЧТО ИЗМЕРЯЕТСЯ (метрики и пороги заданы владельцем; определения 1, 3 и
 * порог 2 переопределены карточкой воркера 18b, метрика 7 добавлена ей же):
 *   1. ступень кромки русла      — поперечный профиль русла, max |Δh| между
 *                                   соседними вершинами heightfield, только
 *                                   по вершинам области вреза (carve > 0) ≤ 2 м
 *   2. глубина воды в центре русла — глубина воды на оси русла          3…12 м
 *   3. непрерывность русла через грань гекса — вода в пределах одного
 *                                   текселя по обе стороны грани в фактических
 *                                   створах Patch7 (входы + выход к воде)
 *                                   100 % створов
 *   4. фактура рельефа            — RMS высоты в трёх кольцах (патч,
 *                                   воротник, юбка); отношение любой пары
 *                                   в пределах                              0,7…1,3
 *   5. перепад между соседними вершинами на суше — max |Δh| на суше     ≤ 6 м
 *   6. перепад waterDepthM патч/юбка на одинаковой глубине               ≤ 0,5 м
 *   7. доля площади гекса под врезом — доля точек сетки 44×44 (±0,95·R),
 *                                   где riverCarveFactor > 0            ≤ 12 %
 *
 * Почему 1 и 3 переопределены (карточка 18b): прежняя 1 мерила профиль
 * шириной 391 м при долине ±150 м — кромку вместе с природным зерном суши,
 * где соседняя метрика 5 разрешает 6 м, и порог 2 м был недостижим by
 * design. Прежняя 3 требовала воду в 16 точках по периметру гекса, а у реки
 * один исток и один сток: честная реализация даёт 1…2 из 16, и порог 16/16
 * выполним только 16 лучами из центра («паутиной»). Метрика 7 ловит именно
 * паутину: река с долиной даёт единицы процентов, 16 лучей — 22,5 % при
 * halfWidth 0,03 и 32,4 % при 0,045 (проверено на ветке с паутиной).
 *
 * ЧТО ИСПОЛЬЗУЕТСЯ ИЗ ПРОДАКШН-КОДА:
 *   - src/local-map/local-map-contract.ts: buildPatch7 (канонический срез
 *     7 ячеек), isWaterCell, nearestPatchCell, localPointToDirection;
 *   - src/local-map/local-map-rivers.ts (если модуль уже выделен распилом):
 *     riverSegments и riverCarveFactor — теми же segments/halfWidth, что
 *     считает воркер, стенд строит поле вреза для метрик 1 и 7. Если файла
 *     ещё нет (база до распила), используются дословные копии приватных
 *     riverSegments/riverCarveFactor/cellTangentMeters из
 *     local-map-worker.ts — по той же причине и с той же поме́ткой, что и
 *     копии ниже; числа распила при этом побайтово те же;
 *   - src/local-map/local-map-worker.ts: generateLocalMap (heightfield,
 *     terraform_map), generateHorizonSkirt (юбка, маски воды/русла),
 *     clusterHexMetric, HEX_APOTHEM_RATIO, CENTER_HEX_RADIUS_RATIO,
 *     SKIRT_* (радиусы колец), HEIGHTFIELD_RES, RIVER_HALF_WIDTH_RATIO,
 *     METERS_PER_ELEVATION_UNIT;
 *   - site/shared/geodesic-grid.ts + site/shared/planet-surface.ts: каноническая
 *     сетка и поверхность c100-soft-v2.
 * Ничего в src/ этот инструмент не правит: стенд только меряет.
 *
 * ЧТО ПРИШЛОСЬ СКОПИРОВАТЬ (и почему):
 *   - билинейную выборку heightfield (bilinearHeight) и выборку высоты юбки
 *     вдоль луча (skirtHeightAt) — в продакшн-коде это приватные функции
 *     воркера (sampleInnerHeightfield и тело generateHorizonSkirt), а
 *     src/ править нельзя; копии взяты дословно из
 *     tests/local-map-stage8.test.mjs, чтобы числа совпадали с прошлыми
 *     отчётами A-17/A-29;
 *   - формулу оптической глубины waterDepthM (GLSL-шейдер
 *     local-map-shaders.ts, ветка openSea) — в шейдере нет CPU-эквивалента;
 *     используется та же CPU-реплика, что и в диагностике A-29
 *     (pelagicDepth = 7,25 м, surfShoal = 0,8).
 * Обе копии помечены в коде и повторяют эталонные измерения A-17/A-29.
 *
 * ФИКСТУРЫ (копии из tests/local-map-stage8.test.mjs, значения не переписаны):
 *   A17_PROFILE, A29_PROFILE, список контрольных ячеек, radiusM = 2500 м.
 *   По умолчанию стенд мерит мир A-29 (masterSeedHex a29a29a29a29a29a): это
 *   тот мир, на котором закрыт A-29, и числа метрики 6 совпадают с его
 *   диагностикой (0,067 / 0,091 / 0,070 / 0,074 м на четырёх ячейках).
 *   Мир A-17 (seedText korhal-iv) доступен через --profile=a17: в нём
 *   каноническая топология Patch7 содержит реку у шести из семи ячеек, поэтому
 *   метрики 1–3 там измеримы шире, — стенд нужен и как кросс-проверка.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const GeodesicGrid = require('../site/shared/geodesic-grid.ts').default;
const PlanetSurface = require('../site/shared/planet-surface.ts').default;
const Contract = require('../src/local-map/local-map-contract.ts');
const Worker = require('../src/local-map/local-map-worker.ts');

// Модуль русел после распила local-map-worker.ts (Stage-8.12d, шаг распила):
// если файл есть, поле вреза считается ПРОИЗВОДСТВЕННЫМИ riverSegments /
// riverCarveFactor — именно так стенд видит и 16 вспомогательных лучей
// «паутины», если воркер их добавил в свои сегменты. Если файла нет (база
// стенда старше распила), ниже работают дословные копии тех же приватных
// функций воркера. Молча подменять производственный модуль копиями при его
// наличии нельзя: при битом экспорте стенд падает, а не меряет копию.
const RIVERS_PATH = fileURLToPath(new URL('../src/local-map/local-map-rivers.ts', import.meta.url));
const Rivers = existsSync(RIVERS_PATH) ? require('../src/local-map/local-map-rivers.ts') : null;
if (Rivers && (typeof Rivers.riverSegments !== 'function' || typeof Rivers.riverCarveFactor !== 'function')) {
  throw new Error('stand_local_map: src/local-map/local-map-rivers.ts есть, но не экспортирует riverSegments/riverCarveFactor');
}

// ---------------------------------------------------------------------------
// Фикстуры — копии из tests/local-map-stage8.test.mjs (значения не менять).
// ---------------------------------------------------------------------------

const A17_PROFILE = {
  seedText: 'korhal-iv',
  radiusKm: 6371,
  surfaceClass: 'terrestrial',
  presetId: 'earthlike_balanced',
  geographyVersion: 'c100-soft-v2',
  continentMeanCells: 400,
  continentVariation: 0.8,
  oceanBasinMeanCells: 6000,
  drainageMeanCells: 72,
  oceanPctl: 70,
  shelfBelowPctl: 67,
  shelfAbovePctl: 73,
  highlandLandPctl: 75,
  mountainLandPctl: 92,
  aridLandPctl: 25,
  wetLandPctl: 75,
  coldPctl: 20,
  hotPctl: 80,
  streamFlowPctl: 90,
  majorRiverFlowPctl: 99,
  coastSoftWidthCells: 3,
  continentSoftWidthCells: 4,
  biomeSoftWidthCells: 2,
  transitionEntropyPctl: 90,
};

const A29_PROFILE = {
  ...A17_PROFILE,
  masterSeedHex: 'a29a29a29a29a29a',
  oceanPctl: 90,
  shelfBelowPctl: 87,
  shelfAbovePctl: 93,
};

/** Контрольные ячейки канонической сетки Земли v=128 (заданы владельцем). */
const CONTROL_CELLS = [37488, 37518, 37548, 37519, 137363, 137390, 137436];

/** Профи мира: профиль + seed сектора (те же значения, что в отчётах A-17/A-29). */
const WORLDS = {
  a17: { profile: A17_PROFILE, seed: 0x4f9f2cab, label: 'A-17 (korhal-iv)' },
  a29: { profile: A29_PROFILE, seed: 0xa29b2026, label: 'A-29 (a29a29a29a29a29a)' },
};

const PLACE_ID = 2;
const DEFAULT_RADIUS_M = 2500;
const CANONICAL_V = 128;
/** Азимутов профиля батиметрии A-29 (метрика 6; метрика 3 азимутами больше не мерит). */
const AZIMUTHS = 16;
/** Метрика 7: сетка точек поля вреза — 44×44 центра ячеек квадрата ±0,95·R. */
const CARVE_AREA_GRID = 44;
const CARVE_AREA_RADIUS_RATIO = 0.95;
/** Шаг профиля батиметрии A-29, м. */
const BATHY_STEP_M = 45;
/** Число шагов профиля батиметрии A-29 (точки границы + 6 пар через 45 м). */
const BATHY_STEPS = 6;

// ---------------------------------------------------------------------------
// Пороги метрик — заданы владельцем, менять нельзя.
// ---------------------------------------------------------------------------

const THRESHOLDS = {
  bankStepM: 2,
  // Метрика 2 — диапазон, а не только минимум (карточка 18b): без потолка
  // воркер вырыл 18,4 м, и именно из-за этой глубины кромка метрики 1 не
  // могла стать пологой. riverDepthM оставлен как имя минимума диапазона.
  riverDepthM: 3,
  riverDepthMaxM: 12,
  // Метрика 3: непрерывны должны быть все фактические створы (100 %).
  continuityFraction: 1,
  textureRatioMin: 0.7,
  textureRatioMax: 1.3,
  landStepM: 6,
  waterDepthDeltaM: 0.5,
  // Метрика 7: потолок доли площади под врезом, %.
  carveAreaMaxPct: 12,
};

/** CPU-реплика оптической глубины waterDepthM (ветка openSea шейдера, A-29). */
const PELAGIC_DEPTH_M = 7.25;
const SURF_SHOAL = 0.8;
/** Допуск «вода выше зеркала моря», м: поверхность моря в карте — это z = 0. */
const WATER_LEVEL_TOL_M = 0.1;

// ---------------------------------------------------------------------------
// Разбор аргументов
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { gate: false, json: false, world: 'a29', radiusM: DEFAULT_RADIUS_M, help: false };
  for (const arg of argv) {
    if (arg === '--gate') options.gate = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--profile=')) {
      const name = arg.slice('--profile='.length);
      if (!Object.prototype.hasOwnProperty.call(WORLDS, name)) {
        throw new Error(`Неизвестный профиль: ${name} (доступны: ${Object.keys(WORLDS).join(', ')})`);
      }
      options.world = name;
    } else if (arg.startsWith('--radius-m=')) {
      const value = Number(arg.slice('--radius-m='.length));
      if (!Number.isFinite(value) || value <= 0) throw new Error('--radius-m должно быть положительным числом');
      options.radiusM = value;
    } else {
      throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Использование: node tools/stand_local_map.mjs [--gate] [--json] [--profile=a17|a29] [--radius-m=2500]',
    '',
    '  (без флагов) печать таблицы метрик по 7 контрольным ячейкам, всегда exit 0',
    '  --gate        exit 1, если хотя бы одна метрика красная (гейт выключен по умолчанию)',
    '  --json        та же таблица в JSON',
    '  --profile     мир измерения: a29 (по умолчанию) или a17',
    '  --radius-m    радиус участка, м (по умолчанию 2500 — как в отчётах A-17/A-29)',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Вспомогательные выборки (копии из tests/local-map-stage8.test.mjs — см. шапку)
// ---------------------------------------------------------------------------

/** Реплика билинейной выборки sampleInnerHeightfield воркера (сетка res × res). */
function bilinearHeight(heightfield, res, radiusM, px, py) {
  const cellSize = (2 * radiusM) / res;
  const gx = Math.min(res - 1.0001, Math.max(0, px / cellSize + res / 2));
  const gy = Math.min(res - 1.0001, Math.max(0, py / cellSize + res / 2));
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const ax = gx - ix;
  const ay = gy - iy;
  const i00 = iy * res + ix;
  return (heightfield[i00] * (1 - ax) + heightfield[i00 + 1] * ax) * (1 - ay)
    + (heightfield[i00 + res] * (1 - ax) + heightfield[i00 + res + 1] * ax) * ay;
}

/** Высота юбки вдоль луча angularIndex на расстоянии radiusM (копия A-17). */
function skirtHeightAt(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let previousRadius = 0;
  let previousZ = 0;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const index = (j * angularCount + angularIndex) * 3;
    const radius = Math.hypot(skirt.positions[index], skirt.positions[index + 1]);
    const z = skirt.positions[index + 2];
    if (j > 0 && radius >= radiusM) {
      const t = (radiusM - previousRadius) / (radius - previousRadius);
      return previousZ + (z - previousZ) * t;
    }
    previousRadius = radius;
    previousZ = z;
  }
  return previousZ;
}

/** Индекс ближайшей вершины юбки к точке (angularIndex, radiusM). */
function skirtVertexNear(skirt, angularIndex, radiusM) {
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  let best = 0;
  let bestDistance = Infinity;
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    const p = (j * angularCount + angularIndex) * 3;
    const radius = Math.hypot(skirt.positions[p], skirt.positions[p + 1]);
    const distance = Math.abs(radius - radiusM);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best / 3;
}

/** Тексель terraform_map в точке касательной плоскости (копия A-17b). */
function terraformTexel(map, res, radiusM, x, y) {
  const cellSize = 2 * radiusM / res;
  const ix = Math.max(0, Math.min(res - 1, Math.floor(x / cellSize + res / 2)));
  const iy = Math.max(0, Math.min(res - 1, Math.floor(y / cellSize + res / 2)));
  return map[iy * res + ix];
}

/** RMS по выборке значений. */
function rms(values) {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum / values.length);
}

/** Медиана выборки (для уровня суши вокруг русла). */
function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] + sorted[mid]) / 2);
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Поле вреза русла: производственные riverSegments/riverCarveFactor
// (src/local-map/local-map-rivers.ts), а до распила — дословные копии
// приватных функций local-map-worker.ts (помечены fallback*).
// ---------------------------------------------------------------------------

/** КОПИЯ (fallback до распила): обратная exp-карта cellTangentMeters воркера. */
function fallbackCellTangentMeters(patch, cell) {
  const { origin, east, north, radiusM } = patch.frame;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cosTheta = Math.min(1, Math.max(-1, dot(cell.center, origin)));
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  const scale = sinTheta > 1e-9 ? (theta * radiusM) / sinTheta : radiusM;
  return { u: dot(cell.center, east) * scale, v: dot(cell.center, north) * scale };
}

/** КОПИЯ (fallback до распила): riverSegments воркера (И-3.3). */
function fallbackRiverSegments(patch, radiusM, halfWidthM) {
  const raw = [];
  if (patch.river.flowsThroughCenter || patch.river.inlets.length > 0) {
    for (const edge of patch.river.inlets) {
      const cell = patch.cells[edge.slot + 1];
      if (!cell) continue;
      const inlet = fallbackCellTangentMeters(patch, cell);
      raw.push({ u0: inlet.u, v0: inlet.v, u1: 0, v1: 0 });
    }
    if (patch.river.outlet) {
      const cell = patch.cells[patch.river.outlet.slot + 1];
      if (cell) {
        const outlet = fallbackCellTangentMeters(patch, cell);
        raw.push({ u0: 0, v0: 0, u1: outlet.u, v1: outlet.v });
      }
    }
    if (raw.length === 0 && patch.river.flowsThroughCenter) {
      raw.push({ u0: -2 * radiusM, v0: 0, u1: 2 * radiusM, v1: 0 });
    }
  }
  return raw.map((seg) => ({
    ...seg,
    minU: Math.min(seg.u0, seg.u1) - halfWidthM,
    minV: Math.min(seg.v0, seg.v1) - halfWidthM,
    maxU: Math.max(seg.u0, seg.u1) + halfWidthM,
    maxV: Math.max(seg.v0, seg.v1) + halfWidthM,
  }));
}

/** КОПИЯ (fallback до распила): distanceToSegment воркера. */
function fallbackDistanceToSegment(wx, wy, seg) {
  const dx = seg.u1 - seg.u0;
  const dy = seg.v1 - seg.v0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((wx - seg.u0) * dx + (wy - seg.v0) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.u0 + dx * t;
  const py = seg.v0 + dy * t;
  return Math.hypot(wx - px, wy - py);
}

/** КОПИЯ (fallback до распила): riverCarveFactor воркера. */
function fallbackRiverCarveFactor(wx, wy, segments, halfWidthM) {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  let best = Infinity;
  for (const seg of segments) {
    if (wx < seg.minU || wx > seg.maxU || wy < seg.minV || wy > seg.maxV) continue;
    const d = fallbackDistanceToSegment(wx, wy, seg);
    if (d < best) best = d;
  }
  if (best === Infinity) return 0;
  if (best >= halfWidthM) return 0;
  const t = 1 - best / halfWidthM;
  return t * t * (3 - 2 * t);
}

const riverSegmentsImpl = Rivers ? Rivers.riverSegments : fallbackRiverSegments;
const riverCarveFactorImpl = Rivers ? Rivers.riverCarveFactor : fallbackRiverCarveFactor;
/** Откуда взяты segments/carve: 'local-map-rivers.ts' или копия до распила. */
const RIVER_CARVE_SOURCE = Rivers ? 'local-map-rivers.ts' : 'копия приватных функций local-map-worker.ts (модуля rivers ещё нет)';

/**
 * Поле вреза патча теми же segments/halfWidth, что считает воркер при
 * генерации heightfield: halfWidthM = max(2·cellSize, radiusM ·
 * RIVER_HALF_WIDTH_RATIO) и segments = riverSegments(patch, radiusM,
 * halfWidthM). Экспортируемая константа полуширины берётся из модуля русел,
 * если он есть, иначе из воркера (значение одно и то же — 0,03).
 */
function buildRiverCarveField(patch, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const halfWidthRatio = (Rivers && Number.isFinite(Rivers.RIVER_HALF_WIDTH_RATIO))
    ? Rivers.RIVER_HALF_WIDTH_RATIO
    : Worker.RIVER_HALF_WIDTH_RATIO;
  const halfWidthM = Math.max(2 * cellSize, radiusM * halfWidthRatio);
  const segments = riverSegmentsImpl(patch, radiusM, halfWidthM);
  return {
    segments,
    halfWidthM,
    halfWidthRatio,
    cellSize,
    res,
    carveAt: (wx, wy) => riverCarveFactorImpl(wx, wy, segments, halfWidthM),
  };
}

/** Касательные координаты вершины heightfield по её индексу, м. */
function vertexCoordsM(index, res, cellSize) {
  return {
    x: ((index % res) - res / 2) * cellSize,
    y: (Math.floor(index / res) - res / 2) * cellSize,
  };
}

// ---------------------------------------------------------------------------
// Геометрия русла: каноническая топология Patch7 (inlets/outlet)
// ---------------------------------------------------------------------------

/**
 * Оси русла, заданные канонической топологией Patch7: для каждой грани, через
 * которую по И-3.3 входит или выходит сток, — азимут соседней ячейки в
 * касательном кадре. Азимут берётся только из экспортируемых данных патча
 * (frame.east/frame.north и PatchCell.center).
 */
function riverAxes(patch) {
  const { east, north } = patch.frame;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const edges = [
    ...patch.river.inlets.map((edge) => ({ slot: edge.slot, kind: 'вход', cell: edge.neighborCell })),
    ...(patch.river.outlet ? [{ slot: patch.river.outlet.slot, kind: 'выход', cell: patch.river.outlet.neighborCell }] : []),
  ];
  return edges.map((edge) => {
    const cell = patch.cells[edge.slot + 1];
    const azimuth = Math.atan2(dot(cell.center, north), dot(cell.center, east));
    return { ...edge, azimuth, neighborIsWater: Contract.isWaterCell(cell, patch.seaLevel) };
  });
}

/**
 * Фактические створы метрики 3 (карточка 18b): каждая грань входа русла
 * (patch.river.inlets) плюс грань выхода (patch.river.outlet) ТОЛЬКО если
 * сосед за ней — вода (isWaterCell): выход на сушу — это сток в следующий
 * гекс суши, а не устье, и створом не считается.
 */
function riverGateAxes(patch) {
  return riverAxes(patch).filter(
    (axis) => axis.kind === 'вход' || axis.neighborIsWater,
  );
}

/** Русское склонение слова «створ» для формата значения метрики 3. */
function gateWord(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'створ';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'створа';
  return 'створов';
}

/** Радиус контура центрального гекса по азимуту (продакшн-метрика кластера). */
function hexBoundaryRadiusM(radiusM, azimuth) {
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  return apothemM / Worker.clusterHexMetric(Math.cos(azimuth), Math.sin(azimuth));
}

/**
 * Поперечный профиль русла: строка/столбец сетки heightfield поперёк оси
 * русла, проходящий через середину оси внутри гекса. Ширина профиля — 2,5
 * полуширины русла (производственная константа RIVER_HALF_WIDTH_RATIO).
 */
function riverCrossSection(patch, radiusM, axis, halfWidthM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const boundaryM = hexBoundaryRadiusM(radiusM, axis.azimuth);
  const midRadiusM = boundaryM * 0.5;
  const midX = Math.cos(axis.azimuth) * midRadiusM;
  const midY = Math.sin(axis.azimuth) * midRadiusM;
  // Ось профиля перпендикулярна руслу: идём по той сетке, что ближе к ней.
  const perpX = -Math.sin(axis.azimuth);
  const perpY = Math.cos(axis.azimuth);
  const alongX = Math.abs(perpX) >= Math.abs(perpY);
  const steps = Math.max(1, Math.round((2.5 * halfWidthM) / cellSize));
  // primary — индекс вдоль профиля (x при alongX, иначе y), secondary —
  // фиксированный поперечный индекс. До карточки 18b пара была переставлена:
  // профиль проходил через отражённую точку (midY, midX), а не через
  // середину русла, поэтому поле вреза на нём было тождественно нулём даже
  // при существующих сегментах и метрика 1 мерила зерно суши в стороне от
  // реки. Профиль обязан проходить через (midX, midY) — как и сказано выше.
  const centerIndex = alongX
    ? Math.round(midX / cellSize + res / 2)
    : Math.round(midY / cellSize + res / 2);
  const centerIndexOther = alongX
    ? Math.round(midY / cellSize + res / 2)
    : Math.round(midX / cellSize + res / 2);
  const indices = [];
  for (let k = -steps; k <= steps; k++) {
    const primary = centerIndex + k;
    const secondary = centerIndexOther;
    if (primary < 0 || secondary < 0 || primary >= res || secondary >= res) continue;
    indices.push(alongX ? secondary * res + primary : primary * res + secondary);
  }
  return { indices, centerVertex: indices[Math.floor(indices.length / 2)], halfWidthM, boundaryM, midRadiusM };
}

// ---------------------------------------------------------------------------
// Метрики
// ---------------------------------------------------------------------------

/**
 * Метрика 1 — ступень кромки русла: максимальный |Δh| между соседними
 * вершинами heightfield поперёк оси русла (порог ≤ 2 м), только в области
 * вреза (карточка 18b). В максимум включаются только ступени, у которых
 * хотя бы одна из двух вершин лежит в области вреза (carve > 0): так сама
 * кромка — переход от carve = 0 к carve > 0 — измеряется, а природное зерно
 * суши вне области вреза (его меряет метрика 5 с порогом 6 м) — нет.
 * Если carve = 0 на всём профиле, метрика неприменима (value = null), а не 0:
 * нулевая ступень несуществующей кромки — ложный PASS.
 */
function measureBankStep(local, crossSection, carveField) {
  const heightfield = local.heightfield;
  const carve = crossSection.indices.map((index) => {
    const { x, y } = vertexCoordsM(index, carveField.res, carveField.cellSize);
    return carveField.carveAt(x, y);
  });
  const inAreaCount = carve.filter((value) => value > 0).length;
  if (inAreaCount === 0) {
    return {
      value: null,
      inAreaCount,
      profileCount: crossSection.indices.length,
      detail: 'carve = 0 на всём профиле — вершин в области вреза нет, кромку мерить негде',
    };
  }
  let maxStep = 0;
  let at = null;
  let considered = 0;
  for (let k = 1; k < crossSection.indices.length; k++) {
    if (carve[k - 1] <= 0 && carve[k] <= 0) continue;
    considered++;
    const a = crossSection.indices[k - 1];
    const b = crossSection.indices[k];
    const delta = Math.abs(heightfield[a] - heightfield[b]);
    if (delta > maxStep) {
      maxStep = delta;
      at = k;
    }
  }
  if (considered === 0) {
    return {
      value: null,
      inAreaCount,
      profileCount: crossSection.indices.length,
      detail: 'в области вреза нет соседних пар вершин профиля',
    };
  }
  return {
    value: maxStep,
    inAreaCount,
    profileCount: crossSection.indices.length,
    detail: `вершин в области вреза: ${inAreaCount} из ${crossSection.indices.length} профиля; `
      + (at === null ? 'все ступени в области вреза нулевые' : `максимум на шаге ${at} профиля`),
  };
}

/**
 * Метрика 2 — глубина воды в центре русла (порог 3…12 м). Дно — высота
 * heightfield на оси русла; уровень воды — зеркало моря (0) для морской
 * ячейки, уровень суши (берег) для врезанного русла. Если в центре русла воды
 * нет вовсе (русло не врезано — маркер суши), глубина равна нулю: это и есть
 * измеряемый дефект «река пропала».
 */
function measureRiverDepth(local, crossSection) {
  const heightfield = local.heightfield;
  const terraform = local.terraformMap;
  const bed = heightfield[crossSection.centerVertex];
  const marker = terraform[crossSection.centerVertex] ?? 0;
  if (marker >= 2) {
    return { value: 0, detail: `в центре русла суша (${round(bed, 1)} м) — воды нет` };
  }
  let surface;
  if (marker === 0) {
    surface = 0;   // зеркало моря
  } else {
    const land = [];
    for (const index of crossSection.indices) {
      if ((terraform[index] ?? 0) >= 2) land.push(heightfield[index]);
    }
    surface = land.length > 0 ? median(land) : heightfield[crossSection.centerVertex];
  }
  const depth = Math.max(0, surface - bed);
  return {
    value: depth,
    detail: `дно ${round(bed, 1)} м, уровень ${round(surface, 1)} м`,
  };
}

/**
 * Метрика 3 — непрерывность русла через грань гекса в ФАКТИЧЕСКИХ створах
 * (карточка 18b): вода должна быть в пределах одного текселя по обе стороны
 * грани именно там, где русло её пересекает по канонической топологии
 * Patch7, — на гранях входов (inlets) и на грани выхода к воде (outlet с
 * соседом-водой). Знаменатель — число таких створов, а не 16 азимутов по
 * периметру: у реки один исток и один сток, честная реализация даёт 1…2
 * створа. Порог — 100 % створов.
 *
 * Вода считается присутствующей, если СЕМАНТИКА (маркер terraform_map на
 * стороне патча, маска воды/русла на стороне юбки) говорит «вода» И геометрия
 * не противоречит: морская вода должна лежать ниже зеркала моря (z = 0),
 * русло — выше него (его поверхность лежит на уровне суши). Один только
 * маркер без воды — это как раз дефект «ложная вода на суше».
 *
 * Применимость: если створов по топологии нет — N/A. Особый случай — грань
 * единственного выхода к воде без притоков и без потока через центр:
 * flowReceiver есть у КАЖДОЙ ячейки суши (это направление стока, а не река),
 * поэтому створ образуется, только если воркер при этом реально врезает
 * русло (segments непусты). Если топология утверждает реку (есть входы или
 * поток через центр), створы считаются независимо от воркера — иначе
 * отсутствующую реку метрика прятала бы в N/A вместо FAIL.
 */
function measureFaceContinuity(local, skirt, patch, radiusM, carveField) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const gates = riverGateAxes(patch);
  const topologyAssertsRiver = patch.river.inlets.length > 0 || patch.river.flowsThroughCenter;
  const workerCarvesRiver = carveField.segments.length > 0;
  if (gates.length === 0) {
    const outlet = patch.river.outlet;
    return {
      value: null,
      total: 0,
      detail: outlet
        ? `створов нет: входов нет, выход (слот ${outlet.slot}) ведёт на сушу — устья к воде нет`
        : 'створов нет: в Patch7 нет ни входов русла, ни выхода к воде',
    };
  }
  if (!topologyAssertsRiver && !workerCarvesRiver) {
    return {
      value: null,
      total: gates.length,
      detail: `створов нет: есть только выход стока к воде (${gates.map((gate) => `слот ${gate.slot}`).join(', ')}) `
        + 'без притоков и без потока через центр, а сегментов вреза воркер не строит — русла нет',
    };
  }
  let continuous = 0;
  const perGate = [];
  for (const gate of gates) {
    const azimuth = gate.azimuth;
    const normalized = ((azimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const angularIndex = Math.round((normalized / (Math.PI * 2)) * Worker.SKIRT_ANGULAR_SEGMENTS)
      % Worker.SKIRT_ANGULAR_SEGMENTS;
    const boundaryM = hexBoundaryRadiusM(radiusM, azimuth);
    const innerRadiusM = boundaryM - cellSize;
    const innerX = Math.cos(azimuth) * innerRadiusM;
    const innerY = Math.sin(azimuth) * innerRadiusM;
    const innerZ = bilinearHeight(local.heightfield, res, radiusM, innerX, innerY);
    const innerMarker = terraformTexel(local.terraformMap, res, radiusM, innerX, innerY);
    const innerWater = innerMarker === 0 ? innerZ <= WATER_LEVEL_TOL_M : innerMarker === 1;
    const outerRadiusM = boundaryM + cellSize;
    const outerZ = skirtHeightAt(skirt, angularIndex, outerRadiusM);
    const vertex = skirtVertexNear(skirt, angularIndex, outerRadiusM);
    const outerRiver = skirt.riverMask[vertex] > 127;
    const outerWater = outerRiver
      ? true
      : skirt.waterMask[vertex] > 127 && outerZ <= WATER_LEVEL_TOL_M;
    if (innerWater && outerWater) continuous++;
    perGate.push(
      `${gate.kind} слот ${gate.slot}: внутри ${innerWater ? 'вода есть' : 'воды нет'}, снаружи ${outerWater ? 'вода есть' : 'воды нет'}`,
    );
  }
  return {
    value: continuous,
    total: gates.length,
    detail: perGate.join('; '),
  };
}

/**
 * Метрика 7 — доля площади гекса под врезом (карточка 18b, порог ≤ 12 %):
 * сетка 44×44 центров ячеек квадрата ±0,95·R (R = радиус участка), точка
 * засчитывается, если riverCarveFactor > 0 в ней при тех же
 * segments/halfWidth, что у воркера. Смысл — ловить «паутину»: честная река
 * с долиной занимает единицы процентов, а 16 лучей из центра дали 22,5 %
 * при halfWidth 0,03 и 32,4 % при 0,045. Метрика применима всегда: нет
 * сегментов — честные 0 %, а не N/A.
 */
function measureCarveArea(carveField, radiusM) {
  const grid = CARVE_AREA_GRID;
  const extentM = CARVE_AREA_RADIUS_RATIO * radiusM;
  const stepM = (2 * extentM) / grid;
  let hits = 0;
  for (let iy = 0; iy < grid; iy++) {
    const y = -extentM + (iy + 0.5) * stepM;
    for (let ix = 0; ix < grid; ix++) {
      const x = -extentM + (ix + 0.5) * stepM;
      if (carveField.carveAt(x, y) > 0) hits++;
    }
  }
  const total = grid * grid;
  return {
    value: (hits / total) * 100,
    hits,
    total,
    detail: `точек с carve > 0: ${hits} из ${total} (сетка ${grid}×${grid}, ±${CARVE_AREA_RADIUS_RATIO}·R); `
      + `сегментов русла: ${carveField.segments.length}, halfWidth = ${round(carveField.halfWidthM, 1)} м `
      + `(${carveField.halfWidthRatio}·R), поле вреза: ${RIVER_CARVE_SOURCE}`,
  };
}

/**
 * Метрика 4 — фактура рельефа: RMS высоты в трёх кольцах (патч — центральный
 * гекс heightfield, воротник — плотные кольца юбки, юбка — дальние кольца).
 * Порог: отношение любой пары в пределах 0,7…1,3.
 */
function measureTexture(local, skirt, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / res;
  const apothemM = Worker.CENTER_HEX_RADIUS_RATIO * Worker.HEX_APOTHEM_RATIO * radiusM;
  const innerRadiusM = Worker.SKIRT_INNER_RADIUS_RATIO * radiusM;
  const collarEndM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;
  const patchValues = [];
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const wx = (x - res / 2) * cellSize;
      const wy = (y - res / 2) * cellSize;
      if (Worker.clusterHexMetric(wx, wy) <= apothemM) patchValues.push(local.heightfield[y * res + x]);
    }
  }
  const angularCount = Worker.SKIRT_ANGULAR_SEGMENTS + 1;
  const collarValues = [];
  const skirtValues = [];
  for (let j = 0; j <= Worker.SKIRT_RADIAL_RINGS; j++) {
    for (let i = 0; i < angularCount; i++) {
      const v = (j * angularCount + i) * 3;
      const radius = Math.hypot(skirt.positions[v], skirt.positions[v + 1]);
      const z = skirt.positions[v + 2];
      if (radius >= innerRadiusM && radius <= collarEndM) collarValues.push(z);
      else if (radius > collarEndM) skirtValues.push(z);
    }
  }
  const rmsPatch = rms(patchValues);
  const rmsCollar = rms(collarValues);
  const rmsSkirt = rms(skirtValues);
  const pairs = [
    { name: 'патч/воротник', ratio: rmsCollar / rmsPatch },
    { name: 'патч/юбка', ratio: rmsSkirt / rmsPatch },
    { name: 'воротник/юбка', ratio: rmsSkirt / rmsCollar },
  ].map((pair) => ({
    ...pair,
    // Выход за коридор 0,7…1,3: 1 — ровно на границе коридора, > 1 — за ним.
    violation: Math.max(pair.ratio / THRESHOLDS.textureRatioMax, THRESHOLDS.textureRatioMin / pair.ratio),
  }));
  const worst = pairs.reduce((a, b) => (b.violation > a.violation ? b : a));
  return {
    value: worst.ratio,
    pairs,
    detail: `RMS патч ${round(rmsPatch, 1)} м, воротник ${round(rmsCollar, 1)} м, юбка ${round(rmsSkirt, 1)} м; `
      + pairs.map((pair) => `${pair.name} = ${pair.ratio.toFixed(2)}×`).join(', ')
      + `; худшая пара ${worst.name} = ${worst.ratio.toFixed(2)}×`,
  };
}

/**
 * Метрика 5 — перепад между соседними вершинами heightfield на суше
 * (порог ≤ 6 м). На воде перепад не измеряется — метрика неприменима.
 */
function measureLandStep(local) {
  const res = Worker.HEIGHTFIELD_RES;
  const heightfield = local.heightfield;
  const terraform = local.terraformMap;
  let maxStep = 0;
  let landTexels = 0;
  for (let i = 0; i < heightfield.length; i++) {
    if ((terraform[i] ?? 0) >= 2) landTexels++;
  }
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const i = y * res + x;
      if ((terraform[i] ?? 0) < 2) continue;
      if (x + 1 < res && (terraform[i + 1] ?? 0) >= 2) {
        const delta = Math.abs(heightfield[i] - heightfield[i + 1]);
        if (delta > maxStep) maxStep = delta;
      }
      if (y + 1 < res && (terraform[i + res] ?? 0) >= 2) {
        const delta = Math.abs(heightfield[i] - heightfield[i + res]);
        if (delta > maxStep) maxStep = delta;
      }
    }
  }
  return {
    value: maxStep,
    landTexels,
    detail: `текселей суши: ${landTexels}`,
  };
}

/**
 * Метрика 6 — перепад waterDepthM патч/юбка на одинаковой глубине
 * (порог ≤ 0,5 м). Профиль тот же, что в диагностике A-29: 16 азимутов ×
 * (точка границы + 6 пар через 45 м), глубина считается CPU-репликой формулы
 * шейдера (pelagicDepth = 7,25 м, surfShoal = 0,8).
 *
 * Сравниваются только пары, где вода есть С ОБЕИХ сторон (маркер воды на
 * стороне патча, маска воды на стороне юбки): шейдер считает waterDepthM только
 * там, где вода нарисована, поэтому пара «вода ↔ суша» не имеет глубины и
 * измеряется метрикой 3 (непрерывность через грань).
 */
function measureWaterDepthDelta(local, skirt, radiusM) {
  const res = Worker.HEIGHTFIELD_RES;
  const guardM = Worker.SKIRT_HEIGHTFIELD_GUARD_RATIO * radiusM;
  const boundaryM = Worker.SKIRT_COLLAR_END_RADIUS_RATIO * radiusM;
  let maxDelta = 0;
  let waterPairs = 0;
  let totalPairs = 0;
  let worst = null;
  for (let az = 0; az < AZIMUTHS; az++) {
    const azimuth = (az / AZIMUTHS) * Math.PI * 2;
    const angularIndex = (az * Worker.SKIRT_ANGULAR_SEGMENTS) / AZIMUTHS;
    for (let step = 0; step <= BATHY_STEPS; step++) {
      const distanceM = step * BATHY_STEP_M;
      const innerRadiusM = Math.max(0, boundaryM - distanceM);
      const innerX = Math.max(-guardM, Math.min(guardM, Math.cos(azimuth) * innerRadiusM));
      const innerY = Math.max(-guardM, Math.min(guardM, Math.sin(azimuth) * innerRadiusM));
      const innerHeightM = bilinearHeight(local.heightfield, res, radiusM, innerX, innerY);
      const outerHeightM = skirtHeightAt(skirt, angularIndex, boundaryM + distanceM);
      const innerMarker = terraformTexel(local.terraformMap, res, radiusM, innerX, innerY);
      const outerRadiusM = boundaryM + distanceM;
      const vertex = skirtVertexNear(skirt, angularIndex, outerRadiusM);
      const outerRiver = skirt.riverMask[vertex] > 127;
      const outerWater = outerRiver
        || (skirt.waterMask[vertex] > 127 && outerHeightM <= WATER_LEVEL_TOL_M);
      totalPairs++;
      if (!(innerMarker === 0 || innerMarker === 1) || !outerWater) continue;
      waterPairs++;
      const innerDepthM = Math.max(0, -innerHeightM);
      const outerDepthM = Math.max(0, -outerHeightM);
      const innerWaterDepthM = (innerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const outerWaterDepthM = (outerDepthM * 1.35 + PELAGIC_DEPTH_M) * SURF_SHOAL;
      const delta = Math.abs(innerWaterDepthM - outerWaterDepthM);
      if (delta > maxDelta) {
        maxDelta = delta;
        worst = { azimuthDeg: az * (360 / AZIMUTHS), distanceM, innerHeightM, outerHeightM };
      }
    }
  }
  return {
    value: maxDelta,
    waterPairs,
    totalPairs,
    detail: worst
      ? `пар с водой по обе стороны: ${waterPairs} из ${totalPairs}; худшая пара: азимут ${worst.azimuthDeg}°, ${worst.distanceM} м, высоты ${round(worst.innerHeightM, 2)} / ${round(worst.outerHeightM, 2)} м`
      : `пар с водой по обе стороны нет (${totalPairs} пар измерено)`,
    hasWater: waterPairs > 0,
  };
}

// ---------------------------------------------------------------------------
// Зона контрольной ячейки (тип местности по канонической Patch7)
// ---------------------------------------------------------------------------

function zoneOf(patch) {
  const center = patch.cells[0];
  if (center.lakeWeight > 0) return 'озеро';
  if (Contract.isWaterCell(center, patch.seaLevel)) return 'океан';
  if (patch.river.inlets.length > 0 || patch.river.outlet) return 'река';
  return 'суша';
}

// ---------------------------------------------------------------------------
// Сборка таблицы
// ---------------------------------------------------------------------------

const METRIC_TITLES = {
  bankStep: 'ступень кромки русла',
  riverDepth: 'глубина воды в центре русла',
  continuity: 'непрерывность русла через грань',
  texture: 'фактура рельефа (RMS колец)',
  landStep: 'перепад вершин на суше',
  waterDepth: 'перепад waterDepthM патч/юбка',
  carveArea: 'доля площади гекса под врезом',
};

function metricRow(cell, zone, metric, value, valueText, threshold, status, detail) {
  // Неприменимая метрика не имеет значения: null, а не 0 (чтобы «нет данных»
  // нельзя было спутать с «измерено ноль»).
  return {
    cell,
    zone,
    metric,
    value: status === 'N/A' ? null : value,
    valueText: status === 'N/A' ? '—' : valueText,
    threshold,
    status,
    detail,
  };
}

async function measureCell(grid, surface, world, cell, radiusM) {
  const patch = Contract.buildPatch7(grid, surface, cell);
  const request = {
    patch,
    seed: world.seed,
    placeId: PLACE_ID,
    radiusM,
    profile: world.profile,
    neighborRings: 0,
    patchKey: `stand-${world.label}-${cell}`,
  };
  Worker.clearLocalMapCache();
  const local = await Worker.generateLocalMap(request);
  const skirt = await Worker.generateHorizonSkirt(request, local.heightfield);
  const zone = zoneOf(patch);
  const rows = [];

  // --- Поле вреза воркера: общее для метрик 1, 2 (применимость), 3 и 7 ---
  const carveField = buildRiverCarveField(patch, radiusM);

  // --- Метрики 1–2: русло по канонической топологии Patch7 ---
  // Применимость определяет поле вреза: если carve = 0 на всех профилях,
  // врезанного русла нет и обе метрики — N/A (а не ступень 0 м / глубина 0 м:
  // несуществующую реку нельзя ни «пропустить», ни «завалить»).
  const axes = riverAxes(patch);
  if (axes.length === 0) {
    rows.push(metricRow(cell, zone, METRIC_TITLES.bankStep, null, '—', '≤ 2 м', 'N/A', 'в Patch7 нет русла'));
    rows.push(metricRow(cell, zone, METRIC_TITLES.riverDepth, null, '—', '3…12 м', 'N/A', 'в Patch7 нет русла'));
  } else {
    const measuredAxes = axes.map((axis) => {
      const crossSection = riverCrossSection(patch, radiusM, axis, carveField.halfWidthM);
      return {
        axis,
        crossSection,
        bank: measureBankStep(local, crossSection, carveField),
        depth: measureRiverDepth(local, crossSection),
      };
    });
    const carvedAxes = measuredAxes.filter((entry) => entry.bank.value !== null);
    if (carvedAxes.length === 0) {
      const profileCount = measuredAxes.reduce((sum, entry) => sum + entry.bank.profileCount, 0);
      const noCarveDetail = `carve = 0 на всём профиле: вершин в области вреза 0 из ${profileCount} `
        + `(сегментов русла: ${carveField.segments.length}) — врезанного русла нет`;
      rows.push(metricRow(cell, zone, METRIC_TITLES.bankStep, null, '—', '≤ 2 м', 'N/A', noCarveDetail));
      rows.push(metricRow(cell, zone, METRIC_TITLES.riverDepth, null, '—', '3…12 м', 'N/A', noCarveDetail));
    } else {
      let worst = carvedAxes[0];
      let shallowest = carvedAxes[0];
      for (const entry of carvedAxes) {
        if (entry.bank.value > worst.bank.value) worst = entry;
        if (entry.depth.value < shallowest.depth.value) shallowest = entry;
      }
      rows.push(metricRow(
        cell, zone, METRIC_TITLES.bankStep, round(worst.bank.value), `${round(worst.bank.value, 2)} м`, '≤ 2 м',
        worst.bank.value <= THRESHOLDS.bankStepM ? 'PASS' : 'FAIL',
        `худшая грань: ${worst.axis.kind} (слот ${worst.axis.slot}); ${worst.bank.detail}`,
      ));
      const depth = shallowest.depth.value;
      rows.push(metricRow(
        cell, zone, METRIC_TITLES.riverDepth, round(depth), `${round(depth, 2)} м`, '3…12 м',
        depth >= THRESHOLDS.riverDepthM && depth <= THRESHOLDS.riverDepthMaxM ? 'PASS' : 'FAIL',
        `${shallowest.axis.kind} (слот ${shallowest.axis.slot}), ${shallowest.depth.detail}`,
      ));
    }
  }

  // --- Метрика 3: непрерывность воды в фактических створах ---
  const continuity = measureFaceContinuity(local, skirt, patch, radiusM, carveField);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.continuity,
    continuity.value, continuity.value === null ? '—' : `${continuity.value}/${continuity.total} ${gateWord(continuity.total)}`,
    '100 % створов',
    continuity.value === null
      ? 'N/A'
      : (continuity.value / continuity.total >= THRESHOLDS.continuityFraction ? 'PASS' : 'FAIL'),
    continuity.detail,
  ));

  // --- Метрика 4: фактура рельефа ---
  const texture = measureTexture(local, skirt, radiusM);
  const textureOk = texture.pairs.every(
    (pair) => pair.ratio >= THRESHOLDS.textureRatioMin && pair.ratio <= THRESHOLDS.textureRatioMax,
  );
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.texture, round(texture.value, 3), `${texture.value.toFixed(2)}×`,
    '0,70…1,30×', textureOk ? 'PASS' : 'FAIL', texture.detail,
  ));

  // --- Метрика 5: перепад вершин на суше ---
  const land = measureLandStep(local);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.landStep, round(land.value), `${round(land.value, 2)} м`, '≤ 6 м',
    land.landTexels === 0 ? 'N/A' : (land.value <= THRESHOLDS.landStepM ? 'PASS' : 'FAIL'),
    land.landTexels === 0 ? 'на участке нет суши' : land.detail,
  ));

  // --- Метрика 6: перепад waterDepthM патч/юбка ---
  const waterDepth = measureWaterDepthDelta(local, skirt, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.waterDepth, round(waterDepth.value), `${round(waterDepth.value, 3)} м`,
    '≤ 0,5 м',
    !waterDepth.hasWater ? 'N/A' : (waterDepth.value <= THRESHOLDS.waterDepthDeltaM ? 'PASS' : 'FAIL'),
    waterDepth.hasWater ? waterDepth.detail : 'на стыке нет воды',
  ));

  // --- Метрика 7: доля площади гекса под врезом ---
  const carveArea = measureCarveArea(carveField, radiusM);
  rows.push(metricRow(
    cell, zone, METRIC_TITLES.carveArea, round(carveArea.value, 2), `${carveArea.value.toFixed(1)} %`,
    '≤ 12 %',
    carveArea.value <= THRESHOLDS.carveAreaMaxPct ? 'PASS' : 'FAIL',
    carveArea.detail,
  ));

  return rows;
}

// ---------------------------------------------------------------------------
// Печать
// ---------------------------------------------------------------------------

function formatTable(rows, summary) {
  const header = ['ячейка', 'зона', 'метрика', 'значение', 'порог', 'статус'];
  const table = [header, ...rows.map((row) => [
    String(row.cell),
    row.zone,
    row.metric,
    row.valueText,
    row.threshold,
    row.status,
  ])];
  table.push([
    'SUMMARY',
    '—',
    '—',
    '—',
    '—',
    `FAIL: ${summary.fail} (FAIL ${summary.fail} / PASS ${summary.pass} / N/A ${summary.na})`,
  ]);
  const widths = header.map((_, column) => Math.max(...table.map((line) => line[column].length)));
  const lines = table.map((line) => line
    .map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
    .join('  '));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Публичный API стенда (используется тестом tests/local-map-stand.test.mjs)
// ---------------------------------------------------------------------------

/** Сводка по таблице: сколько PASS / FAIL / N/A и какие метрики красные. */
export function summarizeRows(rows) {
  const summary = {
    total: rows.length,
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    na: rows.filter((row) => row.status === 'N/A').length,
  };
  summary.failedMetrics = [...new Set(rows.filter((row) => row.status === 'FAIL').map((row) => row.metric))];
  summary.failCount = summary.fail;
  return summary;
}

/** Код возврата гейта: 1 при красной метрике, 0 при полном PASS. */
export function gateExitCode(summary) {
  return summary.fail > 0 ? 1 : 0;
}

/**
 * Полный прогон стенда: таблица метрик по всем контрольным ячейкам.
 * Опции: { world: 'a29' | 'a17', radiusM: число }.
 */
export async function runStand(options = {}) {
  const worldName = options.world ?? 'a29';
  const world = WORLDS[worldName];
  if (!world) throw new Error(`Неизвестный профиль: ${worldName}`);
  const radiusM = options.radiusM ?? DEFAULT_RADIUS_M;
  const grid = GeodesicGrid.build(CANONICAL_V);
  const surface = PlanetSurface.generateSurface(grid, world.profile);
  const rows = [];
  for (const cell of CONTROL_CELLS) {
    rows.push(...await measureCell(grid, surface, world, cell, radiusM));
  }
  const summary = summarizeRows(rows);
  return {
    tool: 'stand_local_map',
    world: worldName,
    worldLabel: world.label,
    radiusM,
    canonicalV: CANONICAL_V,
    controlCells: [...CONTROL_CELLS],
    riverCarveSource: RIVER_CARVE_SOURCE,
    thresholds: { ...THRESHOLDS },
    rows,
    summary,
    gate: options.gate === true,
    gatePassed: gateExitCode(summary) === 0,
  };
}

export {
  CONTROL_CELLS,
  THRESHOLDS,
  WORLDS,
  METRIC_TITLES,
  DEFAULT_RADIUS_M,
  CANONICAL_V,
  CARVE_AREA_GRID,
  CARVE_AREA_RADIUS_RATIO,
  RIVER_CARVE_SOURCE,
  formatTable,
  parseArgs,
  usage,
};

// ---------------------------------------------------------------------------
// Главный сценарий (только при запуске как CLI)
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1]
  && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    process.exit(0);
  }
  const report = await runStand(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`STAND_LOCAL_MAP мир=${report.worldLabel} radiusM=${report.radiusM} v=${report.canonicalV}`);
    console.log(formatTable(report.rows, report.summary));
    if (report.summary.failedMetrics.length > 0) {
      console.log(`Красные метрики: ${report.summary.failedMetrics.join(', ')}`);
    }
  }
  process.exit(options.gate ? gateExitCode(report.summary) : 0);
}
