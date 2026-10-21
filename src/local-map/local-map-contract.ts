/* LocalMapContract — строгий контракт сшивки патча локальной карты с 7
   каноническими ячейками глобуса (Инвариант И-3, CR-01 PR 5).
   --------------------------------------------------------------------------
   Воркер локальной карты (Этап 8) принимает на вход канонический срез 7 ячеек
   глобуса v=128 (центральная ячейка + 6 её соседей из grid.neighbors) и
   соблюдает 4 правила сшивки:

   1. Координатное тождество: каждая точка (u, v) локальной карты через
      обратную касательную проекцию (exp-карта кадра origin/east/north)
      переводится в единичный 3D-вектор сферы d = (x, y, z) и опрашивает ТОТ ЖЕ
      сэмплер sampleFields(x, y, z), что и глобус: единый 3D-сэмплер базовых
      полей через planet-core / planet-geography (createPatchFieldSampler).
   2. Тождество берега и уровня воды: базовая высота привязана к
      filledElevation и seaLevel канонических ячеек c100-soft-v2; вес
      lakeWeight удерживает переполняющиеся и терминальные озёра водой, а не
      сухими впадинами (raw-uphill допустим только внутри впадин/озёр).
   3. Топологическое тождество рек: русло входит строго со стороны грани
      соседа-источника (flowReceiver[nb] == cell) и выходит строго через грань
      flowReceiver[cell]; веса рёбер — riverAccumulation (flowAccumulationKm2
      c100-soft-v2) и streamWeight.
   4. Тождество зонирования и терраформинга: buildingSpawnMask — жёсткая маска
      отбраковки спавна 3D-структур по воде, озёрам, руслам рек и крутым
      склонам (плюс muLand), чтобы базы/купола/башни не вырастали в воде.

   Контракт чистый (без побочных эффектов) и исполняется одинаково в
   воркере, в браузере и в Node-тесте tests/local-map.test.mjs. */

import PlanetGeography from '../../site/shared/planet-geography.ts';
import type { FieldSampler, GeographyProfileInput } from '../../site/shared/planet-geography.ts';
import type { PlanetGrid } from '../../site/shared/geodesic-grid.ts';
import type { SurfaceResult } from '../../site/shared/planet-surface.ts';

export const LOCAL_MAP_PATCH_VERSION = 'local-map-patch-v1';

/** Каноническая частота сетки Земли (И-1): адресация только на canonicalV. */
export const EARTH_CANONICAL_V = PlanetGeography.EARTH_CANONICAL_V;

/** Раскладка каналов sampleFields (совпадает с ядром sampleFieldsBatch). */
export const FIELD_CHANNELS = [
  'elevation', 'moisture', 'temperatureBase', 'plateAffinity', 'volcanism', 'detail',
] as const;

export type Vec3 = readonly [number, number, number];

export type PatchCellRole = 'center' | 'neighbor';

/** Канонический срез одной ячейки глобуса (все поля — c100-soft-v2). */
export interface PatchCell {
  readonly role: PatchCellRole;
  /** Слот в кольце grid.neighbors центральной ячейки: -1 у центра, 0…5 у соседей. */
  readonly slot: number;
  /** Канонический индекс ячейки на сетке v = canonicalV. */
  readonly cell: number;
  /** 3D-центр ячейки (единичная сфера). */
  readonly center: Vec3;
  /** Сырое дно (география c100-soft-v2). */
  readonly elevation: number;
  /** Уровень затопления озёр priority-flood (И-3.2): filled >= elevation. */
  readonly filledElevation: number;
  /** Глубина впадины: filledElevation - elevation. */
  readonly depressionDepth: number;
  /** Доля суши (И-3.4). */
  readonly muLand: number;
  /** Крутизна склона (И-3.4). */
  readonly slope: number;
  readonly lakeId: number;
  /** Вес озера: > 0 — озеро держит уровень воды (И-3.2). */
  readonly lakeWeight: number;
  /** Вес русла: > 0 — через ячейку проходит сток (И-3.3). */
  readonly streamWeight: number;
  /** Вес стока реки: flowAccumulationKm2 c100-soft-v2 (И-3.3). */
  readonly riverAccumulation: number;
  /** Получатель стока: канонический индекс соседа или -1 (терминал) (И-3.3). */
  readonly flowReceiver: number;
}

/** Грань речного стока на общем ребре кольца патча (И-3.3). */
export interface RiverEdge {
  /** Слот грани в кольце центральной ячейки (0…5). */
  readonly slot: number;
  /** Канонический индекс соседа за этой гранью. */
  readonly neighborCell: number;
  /** riverAccumulation соседа (flowAccumulationKm2). */
  readonly riverAccumulation: number;
  /** streamWeight соседа. */
  readonly streamWeight: number;
}

export interface PatchRiver {
  readonly centerCell: number;
  /** streamWeight центра > 0 — через патч проходит русло. */
  readonly flowsThroughCenter: boolean;
  readonly centerStreamWeight: number;
  readonly centerRiverAccumulation: number;
  /** Входы: соседи с flowReceiver[nb] == center — русло входит строго их гранями. */
  readonly inlets: readonly RiverEdge[];
  /** Выход: грань flowReceiver[center]; null — терминал (озеро/край стока). */
  readonly outlet: RiverEdge | null;
}

/** Касательный кадр центральной ячейки для (u, v) → 3D (И-3.1). */
export interface TangentFrame {
  readonly origin: Vec3;
  readonly east: Vec3;
  readonly north: Vec3;
  /** Радиус сферы в метрах — масштаб exp-карты. */
  readonly radiusM: number;
}

export interface LocalMapPatch {
  readonly version: typeof LOCAL_MAP_PATCH_VERSION;
  /** Частота канонической сетки (v=128 для Земли). */
  readonly v: number;
  readonly centerCell: number;
  /** Ровно 7 канонических ячеек: [центр, соседи 0…5]. */
  readonly cells: readonly PatchCell[];
  readonly seaLevel: number;
  readonly radiusKm: number;
  readonly river: PatchRiver;
  readonly frame: TangentFrame;
}

// ---------------------------------------------------------------------------
// Единый 3D-сэмплер базовых полей (И-3.1): через planet-core / planet-geography
// ---------------------------------------------------------------------------

/** Сэмплер базовых полей по 3D-вектору — тот же, что у глобуса. */
export interface FieldSampler3D {
  sampleFields(x: number, y: number, z: number, out?: Float32Array): Float32Array;
}

export function createPatchFieldSampler(input: GeographyProfileInput): FieldSampler {
  // PlanetGeography.createFieldSampler внутри использует Wasm-батч
  // planet-core (sampleFieldsBatch) — единый движок И-2/И-3.
  return PlanetGeography.createFieldSampler(input);
}

// ---------------------------------------------------------------------------
// Сборка патча из 7 канонических ячеек
// ---------------------------------------------------------------------------

function unitVector(x: number, y: number, z: number): Vec3 {
  const len = Math.sqrt(x * x + y * y + z * z);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new Error('LocalMapContract: нулевой вектор ячейки');
  }
  return [x / len, y / len, z / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function buildTangentFrame(origin: Vec3, radiusM: number): TangentFrame {
  // Стабильный мировой up: у полюсов ось Z вырождена — берём ось X.
  const ref: Vec3 = Math.abs(origin[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const east = unitVector(...cross(ref, origin));
  const north = unitVector(...cross(origin, east));
  return { origin, east, north, radiusM };
}

export function buildPatch7(grid: PlanetGrid, surface: SurfaceResult, centerCell: number): LocalMapPatch {
  if (!Number.isInteger(centerCell) || centerCell < 0 || centerCell >= grid.cellCount) {
    throw new Error('LocalMapContract.buildPatch7: ячейка вне диапазона');
  }
  const neighborCount = grid.neighborCount[centerCell] as number;
  if (neighborCount !== 6) {
    throw new Error(
      `LocalMapContract.buildPatch7: патч собирается вокруг шестиугольной ячейки (neighborCount = ${neighborCount})`,
    );
  }

  const seaLevel = surface.seaLevel;
  const radiusM = surface.radiusKm * 1000;

  const readCell = (role: PatchCellRole, slot: number, cell: number): PatchCell => {
    const center = unitVector(
      grid.centers[cell * 3] as number,
      grid.centers[cell * 3 + 1] as number,
      grid.centers[cell * 3 + 2] as number,
    );
    const elevation = surface.elevation[cell] as number;
    const filledElevation = surface.filledElevation[cell] as number;
    return {
      role,
      slot,
      cell,
      center,
      elevation,
      filledElevation,
      depressionDepth: surface.depressionDepth[cell] as number,
      muLand: surface.muLand[cell] as number,
      slope: surface.slope[cell] as number,
      lakeId: surface.lakeId[cell] as number,
      lakeWeight: surface.lakeWeight[cell] as number,
      streamWeight: surface.streamWeight[cell] as number,
      riverAccumulation: surface.flowAccumulationKm2[cell] as number,
      flowReceiver: surface.flowReceiver[cell] as number,
    };
  };

  const cells: PatchCell[] = [readCell('center', -1, centerCell)];
  for (let slot = 0; slot < 6; slot++) {
    const nb = grid.neighbors[centerCell * 6 + slot] as number;
    if (nb < 0) {
      throw new Error(`LocalMapContract.buildPatch7: пустой слот соседа ${slot} у ячейки ${centerCell}`);
    }
    cells.push(readCell('neighbor', slot, nb));
  }

  const center = cells[0] as PatchCell;

  // Сшивка рек (И-3.3): входы — грани соседей-источников, выход — грань получателя.
  const inlets: RiverEdge[] = [];
  for (const cell of cells) {
    if (cell.role !== 'neighbor') continue;
    if (cell.flowReceiver !== centerCell) continue;
    inlets.push({
      slot: cell.slot,
      neighborCell: cell.cell,
      riverAccumulation: cell.riverAccumulation,
      streamWeight: cell.streamWeight,
    });
  }

  let outlet: RiverEdge | null = null;
  if (center.flowReceiver >= 0) {
    const outCell = cells.find((cell) => cell.cell === center.flowReceiver);
    if (!outCell || outCell.role !== 'neighbor') {
      throw new Error(
        `LocalMapContract.buildPatch7: получатель стока ${center.flowReceiver} ячейки ${centerCell} не в кольце патча`,
      );
    }
    outlet = {
      slot: outCell.slot,
      neighborCell: outCell.cell,
      riverAccumulation: outCell.riverAccumulation,
      streamWeight: outCell.streamWeight,
    };
  }

  const river: PatchRiver = {
    centerCell,
    flowsThroughCenter: center.streamWeight > 0,
    centerStreamWeight: center.streamWeight,
    centerRiverAccumulation: center.riverAccumulation,
    inlets,
    outlet,
  };

  return {
    version: LOCAL_MAP_PATCH_VERSION,
    v: surface.v,
    centerCell,
    cells,
    seaLevel,
    radiusKm: surface.radiusKm,
    river,
    frame: buildTangentFrame(center.center, radiusM),
  };
}

// ---------------------------------------------------------------------------
// И-3.1: координатное тождество — (u, v) → 3D → тот же сэмплер
// ---------------------------------------------------------------------------

export function localPointToDirection(patch: LocalMapPatch, uMeters: number, vMeters: number): Vec3 {
  // Обратная касательная проекция: exp-карта кадра (origin, east, north).
  const { origin, east, north, radiusM } = patch.frame;
  const u = uMeters, v = vMeters;
  const chord = Math.sqrt(u * u + v * v);
  if (!(chord > 0)) return origin;
  const theta = chord / radiusM;
  const s = Math.sin(theta), c = Math.cos(theta);
  const dir = unitVector(
    origin[0] * c + (east[0] * u + north[0] * v) / chord * s,
    origin[1] * c + (east[1] * u + north[1] * v) / chord * s,
    origin[2] * c + (east[2] * u + north[2] * v) / chord * s,
  );
  return dir;
}

export function samplePatchFields(
  patch: LocalMapPatch,
  sampler: FieldSampler3D,
  uMeters: number,
  vMeters: number,
  out?: Float32Array,
): Float32Array {
  const d = localPointToDirection(patch, uMeters, vMeters);
  return sampler.sampleFields(d[0], d[1], d[2], out);
}

/** Ближайшая к направлению ячейка патча (маски/якоря высот). */
export function nearestPatchCell(patch: LocalMapPatch, direction: Vec3): PatchCell {
  let best = patch.cells[0] as PatchCell;
  let bestDot = -Infinity;
  for (const cell of patch.cells) {
    const dot = cell.center[0] * direction[0] + cell.center[1] * direction[1] + cell.center[2] * direction[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = cell;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// И-3.2: тождество берега и уровня воды (filledElevation / seaLevel / lakeWeight)
// ---------------------------------------------------------------------------

export function isWaterCell(cell: PatchCell, seaLevel: number): boolean {
  // Океан — ниже seaLevel; озёра (lakeWeight > 0) — вода всегда, включая
  // переполняющиеся и терминальные Этапа 5.
  return cell.elevation < seaLevel || cell.lakeWeight > 0;
}

export function waterLevelOf(cell: PatchCell, seaLevel: number): number {
  // Уровень воды: озёра держат затопление filledElevation c100-soft-v2,
  // океан — seaLevel.
  if (cell.lakeWeight > 0) return Math.max(seaLevel, cell.filledElevation);
  return seaLevel;
}

export function baseElevationOf(cell: PatchCell): number {
  // Базовая высота локальной карты привязана к filledElevation: впадина с
  // озером остаётся залитой, а не высыхает до сырого дна (И-3.2).
  return cell.filledElevation;
}

/** Базовая высота точки (u, v): filledElevation ближайшей канонической ячейки. */
export function patchBaseElevation(patch: LocalMapPatch, uMeters: number, vMeters: number): number {
  return baseElevationOf(nearestPatchCell(patch, localPointToDirection(patch, uMeters, vMeters)));
}

// ---------------------------------------------------------------------------
// И-3.4: buildingSpawnMask — маска запрета спавна 3D-зданий
// ---------------------------------------------------------------------------

export interface BuildingSpawnSample {
  readonly muLand: number;
  readonly lakeWeight: number;
  readonly streamWeight: number;
  readonly slope: number;
  readonly isWater: boolean;
}

export interface BuildingSpawnRule {
  /** Минимум muLand: вода/берег ниже порога — спавн запрещён. */
  readonly minLand: number;
  /** Предел крутизны: крутые склоны и горные швы — спавн запрещён. */
  readonly maxSlope: number;
}

export const DEFAULT_BUILDING_SPAWN_RULE: BuildingSpawnRule = {
  minLand: 0.5,
  maxSlope: 0.5,
};

export function spawnSampleOf(cell: PatchCell, seaLevel: number): BuildingSpawnSample {
  return {
    muLand: cell.muLand,
    lakeWeight: cell.lakeWeight,
    streamWeight: cell.streamWeight,
    slope: cell.slope,
    isWater: isWaterCell(cell, seaLevel),
  };
}

export function buildingSpawnAllowed(
  sample: BuildingSpawnSample,
  rule: BuildingSpawnRule = DEFAULT_BUILDING_SPAWN_RULE,
): boolean {
  // Жёсткая маска отбраковки (И-3.4): вода, озёра, русла рек, крутые склоны.
  if (sample.isWater) return false;                       // вода (океан/затопление)
  if (sample.lakeWeight > 0) return false;                // озёра
  if (sample.streamWeight > 0) return false;              // русла рек
  if (sample.slope >= rule.maxSlope) return false;        // крутые склоны
  if (sample.muLand < rule.minLand) return false;         // вода/берег по muLand
  return true;
}

/** Физический охват патча в метрах (диаметр кольца по касательной). */
export function patchSpanMeters(patch: LocalMapPatch): number {
  const { origin, radiusM } = patch.frame;
  let maxAngle = 0;
  for (const cell of patch.cells) {
    const dot = Math.min(1, Math.max(-1,
      cell.center[0] * origin[0] + cell.center[1] * origin[1] + cell.center[2] * origin[2]));
    maxAngle = Math.max(maxAngle, Math.acos(dot));
  }
  return 2 * maxAngle * radiusM;
}

export function buildBuildingSpawnMask(
  patch: LocalMapPatch,
  resolution: number,
  rule: BuildingSpawnRule = DEFAULT_BUILDING_SPAWN_RULE,
): Uint8Array {
  // Растр resolution×resolution по касательной плоскости патча: 1 — спавн
  // разрешён, 0 — запрещён. Поля точки — ближайшей канонической ячейки.
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw new Error('LocalMapContract.buildBuildingSpawnMask: resolution должно быть целым >= 1');
  }
  const mask = new Uint8Array(resolution * resolution);
  const span = patchSpanMeters(patch);
  for (let j = 0; j < resolution; j++) {
    const v = ((j + 0.5) / resolution - 0.5) * span;
    for (let i = 0; i < resolution; i++) {
      const u = ((i + 0.5) / resolution - 0.5) * span;
      const cell = nearestPatchCell(patch, localPointToDirection(patch, u, v));
      const allowed = buildingSpawnAllowed(spawnSampleOf(cell, patch.seaLevel), rule);
      mask[j * resolution + i] = allowed ? 1 : 0;
    }
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Верификация инвариантов И-3 (для теста и для самопроверки воркера)
// ---------------------------------------------------------------------------

export interface PatchInvariantReport {
  ok: boolean;
  checks: Record<string, boolean>;
}

export function verifyPatchInvariants(patch: LocalMapPatch): PatchInvariantReport {
  const checks: Record<string, boolean> = {};

  // Форма: ровно 7 канонических ячеек [центр, 6 соседей] без повторов.
  checks['patch7-shape'] =
    patch.cells.length === 7 &&
    (patch.cells[0] as PatchCell).role === 'center' &&
    (patch.cells[0] as PatchCell).cell === patch.centerCell &&
    patch.cells.slice(1).every((cell, slot) => cell.role === 'neighbor' && cell.slot === slot) &&
    new Set(patch.cells.map((cell) => cell.cell)).size === 7;

  // И-3.1: (0, 0) касательного кадра — ровно 3D-центр ячейки.
  const centerDir = localPointToDirection(patch, 0, 0);
  checks['tangent-identity'] =
    centerDir[0] === (patch.cells[0] as PatchCell).center[0] &&
    centerDir[1] === (patch.cells[0] as PatchCell).center[1] &&
    centerDir[2] === (patch.cells[0] as PatchCell).center[2];

  // И-3.2: озёра держат уровень затопления filledElevation и остаются водой.
  checks['flood-hold'] = patch.cells.every((cell) => {
    if (cell.lakeWeight > 0) {
      return isWaterCell(cell, patch.seaLevel) &&
        cell.filledElevation >= cell.elevation - 1e-6 &&
        waterLevelOf(cell, patch.seaLevel) >= cell.filledElevation - 1e-6;
    }
    return cell.filledElevation >= cell.elevation - 1e-6;
  });

  // И-3.3: реки только через общие рёбра кольца по flowReceiver.
  const ring = new Set(patch.cells.filter((cell) => cell.role === 'neighbor').map((cell) => cell.cell));
  const center = patch.cells[0] as PatchCell;
  const riverOk = patch.river.inlets.every((edge) =>
    ring.has(edge.neighborCell) &&
    edge.slot >= 0 && edge.slot <= 5 &&
    (patch.cells[edge.slot + 1] as PatchCell).cell === edge.neighborCell &&
    (patch.cells[edge.slot + 1] as PatchCell).flowReceiver === patch.centerCell,
  ) && (center.flowReceiver < 0
    ? patch.river.outlet === null
    : patch.river.outlet !== null &&
      ring.has(patch.river.outlet.neighborCell) &&
      patch.river.outlet.neighborCell === center.flowReceiver) &&
    patch.river.flowsThroughCenter === (center.streamWeight > 0);
  checks['river-topology'] = riverOk;

  // И-3.4: вода, озёра, русла и крутые склоны запрещают спавн 3D-зданий.
  checks['spawn-ban'] = patch.cells.every((cell) => {
    const sample = spawnSampleOf(cell, patch.seaLevel);
    const mustBan = sample.isWater || sample.lakeWeight > 0 ||
      sample.streamWeight > 0 ||
      sample.slope >= DEFAULT_BUILDING_SPAWN_RULE.maxSlope ||
      sample.muLand < DEFAULT_BUILDING_SPAWN_RULE.minLand;
    return !mustBan || !buildingSpawnAllowed(sample);
  });

  let ok = true;
  for (const value of Object.values(checks)) ok = ok && value;
  return { ok, checks };
}
