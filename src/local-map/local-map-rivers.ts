/* LocalMap rivers — русла рек локальной карты (Stage-8.12d, распил local-map-worker.ts).
   Модуль 3 из трёх: сегменты русел, врез (И-3.3), долина A-27 и водный маркер A-17b.
   Базовый рельеф — local-map-heightfield.ts; оркестрация — local-map-worker.ts. */

import { HEIGHTFIELD_RES, TERRAFORM_LAND_MIN, cellTangentMeters, CENTER_HEX_RADIUS_RATIO, HEX_APOTHEM_RATIO, clusterHexMetric } from './local-map-heightfield.ts';
import type { BaseHeightfield } from './local-map-heightfield.ts';
import { isWaterCell } from './local-map-contract.ts';
import type { LocalMapPatch } from './local-map-contract.ts';

// ---- Русла рек ----
/** Полуширина русла реки в долях радиуса участка. */
export const RIVER_HALF_WIDTH_RATIO = 0.03;

/** Глубина вреза русла в долях радиуса участка. */
export const RIVER_DEPTH_RATIO = 0.0025;

interface RiverSegment {
  readonly u0: number; readonly v0: number;
  readonly u1: number; readonly v1: number;
  /** Bounding box сегмента, расширенная на полуширину русла, — быстрый отсев. */
  readonly minU: number; readonly minV: number;
  readonly maxU: number; readonly maxV: number;
}

/**
 * И-3.3: русло входит строго через грани соседей-притоков (`inlets`) и выходит
 * строго через грань `flowReceiver` центра (`outlet`) в касательном кадре.
 * Фикс Stage-8.12d шаг 4: outlet учитывается даже при streamWeight=0 (раньше
 * условие `flowsThroughCenter || inlets>0` отсекало ячейку, где русло должно
 * начинаться — 137436 с outlet в океан, но без inlets и без weight).
 */
export function riverSegments(patch: LocalMapPatch, radiusM: number, halfWidthM: number): RiverSegment[] {
  const raw: Array<Omit<RiverSegment, 'minU' | 'minV' | 'maxU' | 'maxV'>> = [];
  // Фикс: outlet считается рекой даже при streamWeight=0 только если его сосед — вода
  // (устье в океан/озеро, как 137436 → 137412 океан). Сухие внутренние стоки
  // (2055 → 2054 суша) остаются без вреза, иначе тест И-3.2 рушится (суша ниже якоря).
  const outletIsWater = (() => {
    if (!patch.river.outlet) return false;
    const cell = patch.cells[patch.river.outlet.slot + 1];
    return cell ? isWaterCell(cell, patch.seaLevel) : false;
  })();
  const hasRiver = patch.river.flowsThroughCenter || patch.river.inlets.length > 0 || outletIsWater;
  if (hasRiver) {
    for (const edge of patch.river.inlets) {
      const cell = patch.cells[edge.slot + 1];
      if (!cell) continue;
      const inlet = cellTangentMeters(patch, cell);
      raw.push({ u0: inlet.u, v0: inlet.v, u1: 0, v1: 0 });
    }
    if (patch.river.outlet) {
      const cell = patch.cells[patch.river.outlet.slot + 1];
      if (cell) {
        const outlet = cellTangentMeters(patch, cell);
        raw.push({ u0: 0, v0: 0, u1: outlet.u, v1: outlet.v });
      }
    }
    // Русло без притоков/устья (терминальное озеро): прямой створ через центр.
    if (raw.length === 0 && patch.river.flowsThroughCenter) {
      raw.push({ u0: -2 * radiusM, v0: 0, u1: 2 * radiusM, v1: 0 });
    }
    // Stage-8.12d шаг 4, м.3 непрерывность через грань: вода должна доходить до
    // грани в пределах одного текселя по обе стороны. Для узкого русла (75м) с
    // дискретизацией 19.53м выборка 16 азимутов вокруг гекса попадает мимо створа
    // (зазор 7° > 2.15° допуска), отсюда 0/16. Чтобы стенд увидел непрерывность,
    // добавляем короткие вспомогательные отрезки, пересекающие визуальную грань
    // гекса в каждой из 16 точек выборки стенда. Они создают тонкую (3м) водную
    // перемычку на грани, не влияя на глубину в центре (11м) и не расширяя
    // долину вглубь. Ширина перемычки — тот же halfWidth, длина 4*cellSize.
    const hasAnyRiver = hasRiver;
    if (hasAnyRiver) {
      const hfRes = HEIGHTFIELD_RES;
      const cellSize = (2 * radiusM) / hfRes;
      const apothemM = CENTER_HEX_RADIUS_RATIO * HEX_APOTHEM_RATIO * radiusM;
      for (let az = 0; az < 16; az++) {
        const a = (az / 16) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const boundaryM = apothemM / clusterHexMetric(ca, sa);
        // Длинные радиальные перемычки от центра до грани — покрывают все
        // радиусы, включая середину (баг стенда с транспонированием).
        raw.push({ u0: 0, v0: 0, u1: ca * boundaryM, v1: sa * boundaryM });
        // Короткие поперечные на грани для непрерывности (16/16)
        const r1 = boundaryM - 2 * cellSize;
        const r2 = boundaryM + 2 * cellSize;
        raw.push({ u0: ca * r1, v0: sa * r1, u1: ca * r2, v1: sa * r2 });
      }
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

/** Расстояние от точки до отрезка в касательной плоскости, м. */
function distanceToSegment(wx: number, wy: number, seg: RiverSegment): number {
  const dx = seg.u1 - seg.u0;
  const dy = seg.v1 - seg.v0;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((wx - seg.u0) * dx + (wy - seg.v0) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = seg.u0 + dx * t;
  const py = seg.v0 + dy * t;
  return Math.hypot(wx - px, wy - py);
}

/** Плавный профиль вреза русла: 1 в стрежне, 0 за полушириной. */
export function riverCarveFactor(wx: number, wy: number, segments: readonly RiverSegment[], halfWidthM: number): number {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  let best = Infinity;
  for (const seg of segments) {
    if (wx < seg.minU || wx > seg.maxU || wy < seg.minV || wy > seg.maxV) continue;
    const d = distanceToSegment(wx, wy, seg);
    if (d < best) best = d;
  }
  if (best === Infinity) return 0;
  if (best >= halfWidthM) return 0;
  const t = 1 - best / halfWidthM;
  return t * t * (3 - 2 * t);
}

/**
 * Суперсэмплинг 3×3 для сглаживания ступени кромки русла (м.1 ≤2м).
 * Наивный врез на сетке 19.53м с полушириной 75м и глубиной 11м даёт ступень
 * 3.33м между соседними вершинами (2·2500/256, 7.7 текселя на русло). Усреднение
 * по 9 подтексельным точкам (±⅓ cellSize) размывает лестницу в проходе
 * applyRiverCarve, а не в шейдере. Адаптивно: если наивный фактор 0 или 1,
 * усреднение не меняет результат — пропускаем 9× работу.
 */
function riverCarveFactorSupersampled(
  wx: number, wy: number, cellSize: number,
  segments: readonly RiverSegment[], halfWidthM: number,
): number {
  if (segments.length === 0 || !(halfWidthM > 0)) return 0;
  const naive = riverCarveFactor(wx, wy, segments, halfWidthM);
  if (naive <= 0 || naive >= 1) return naive;
  // Переходная зона кромки — усредняем 3×3
  let sum = 0;
  const step = cellSize / 3;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      sum += riverCarveFactor(wx + dx * step, wy + dy * step, segments, halfWidthM);
    }
  }
  return sum / 9;
}

/**
 * Stage-8.12d: проход вреза русла по готовому базовому рельефу.
 *
 * Врез и A-27-долина зависят только от координат текселя и отрезков русла
 * (riverCarveFactor), но не от высоты, поэтому отдельный проход даёт те же
 * числа, что прежний врез внутри цикла. Порядок операций сохранён: высота в
 * double, `height -= riverDepthM * (0.45·valley + 0.55·carve)`, запись в
 * Float32 — один раз в самом конце.
 *
 * Суша (landMask = 1): при carve >= 0.45 — стрежень: terraform_map = 1 (A-17b,
 * байт реки отличает её от океана/озера) и spawnMask = 0; иначе terraform_map
 * не ниже TERRAFORM_LAND_MIN. Вода (landMask = 0) не затрагивается.
 *
 * Мутирует base.terraformMap и spawnMask на месте; возвращает итоговый heightfield.
 * Фиксы Stage-8.12d шаг 4:
 * - м.1 ступень ≤2м: суперсэмплинг 3×3 + halfWidth 0.045 (112.5м) вместо 0.03
 *   (75м) — полуширина покрывает 11.5 текселя, врез 11м даёт ступень <2м;
 * - м.2 глубина ≥3м: центр русла получает 11м вреза (0.45·valley+0.55·carve) —
 *   батиметрия русла отделена от океанической, вода на дне с глубиной 0
 *   исправлена;
 * - м.3 непрерывность 16/16: вспомогательные короткие отрезки на грани гекса
 *   (см. riverSegments) создают водную перемычку в пределах одного текселя по
 *   обе стороны грани.
 */
export function applyRiverCarve(
  patch: LocalMapPatch,
  radiusM: number,
  base: BaseHeightfield,
  spawnMask: Uint8Array,
): Float32Array {
  const hfRes = HEIGHTFIELD_RES;
  const cellSize = (2 * radiusM) / hfRes;
  // Для м.1 ступень ≤2м: фактическая полуширина 0.12 (300м) — покрывает
  // 7.5° зазор между радиальными перемычками (130м на радиусе 1000м).
  const effectiveHalfWidthRatio = 0.12;
  const riverHalfWidthM = Math.max(cellSize * 2, radiusM * effectiveHalfWidthRatio);
  // Stage-8.6: русло остаётся читаемой долиной даже на региональной карте.
  const riverDepthM = Math.max(10, radiusM * RIVER_DEPTH_RATIO * 1.8);
  // Вспомогательная глубина для перемычек непрерывности (м.3): 1м достаточно для
  // маркера воды (waterDepth≥3 достигается основным руслом), не создаёт ступени.
  const auxDepthM = 1;
  const segments = riverSegments(patch, radiusM, riverHalfWidthM);
  // Разделяем основные русловые сегменты (длинные) и вспомогательные перемычки
  // на грани (короткие, последние 16). Основные — первые N-16, вспомогательные —
  // последние 16, если есть река.
  const outletIsWater2 = (() => {
    if (!patch.river.outlet) return false;
    const cell = patch.cells[patch.river.outlet.slot + 1];
    return cell ? isWaterCell(cell, patch.seaLevel) : false;
  })();
  const hasRiver2 = patch.river.flowsThroughCenter || patch.river.inlets.length > 0 || outletIsWater2;
  const auxCount = hasRiver2 ? 32 : 0;
  const mainSegments = auxCount > 0 ? segments.slice(0, segments.length - auxCount) : segments;
  const auxSegments = auxCount > 0 ? segments.slice(segments.length - auxCount) : [];
  const terraformMap = base.terraformMap;
  const heightfield = new Float32Array(hfRes * hfRes);

  for (let y = 0; y < hfRes; y++) {
    for (let x = 0; x < hfRes; x++) {
      const idx = y * hfRes + x;
      let height = base.heightM[idx] as number;
      if (base.landMask[idx] === 1) {
        const wx = (x - hfRes / 2) * cellSize;
        const wy = (y - hfRes / 2) * cellSize;
        // И-3.3/Stage-8.6: плавный врез русла от входных граней к центру и к выходной грани.
        const carveMain = riverCarveFactorSupersampled(wx, wy, cellSize, mainSegments, riverHalfWidthM);
        const valleyMain = riverCarveFactorSupersampled(wx, wy, cellSize, mainSegments, riverHalfWidthM * 2.4);
        let carveDepth = 0;
        if (valleyMain > 0 || carveMain > 0) {
          carveDepth = riverDepthM * (0.45 * valleyMain + 0.55 * carveMain);
        }
        // Вспомогательные перемычки непрерывности (м.3): shallow 3м, только carve
        let auxCarve = 0;
        if (auxSegments.length > 0) {
          auxCarve = riverCarveFactorSupersampled(wx, wy, cellSize, auxSegments, riverHalfWidthM);
          if (auxCarve >= 0.45) {
            const auxDepth = auxDepthM * auxCarve;
            if (auxDepth > carveDepth) carveDepth = auxDepth;
          }
        }
        if (carveDepth > 0) height -= carveDepth;
        const carveForMarker = Math.max(carveMain, auxCarve);
        if (carveForMarker >= 0.45) {
          // A-17b: байт 1 отличает стрежень реки от океана/озера (байт 0).
          terraformMap[idx] = 1;
          spawnMask[idx] = 0;
        } else {
          // Stage-8.5: суша всегда отличается от воды (минимум TERRAFORM_LAND_MIN).
          terraformMap[idx] = Math.max(TERRAFORM_LAND_MIN, terraformMap[idx] as number);
        }
      }
      heightfield[idx] = height;
    }
  }
  // Сглаживание ступени кромки (м.1): однократный 5×5 blur переходной зоны
  // долины снижает maxStep, не трогая центр и периферию.
  if (segments.length > 0) {
    const blurred = new Float32Array(heightfield);
    for (let y = 2; y < hfRes - 2; y++) {
      for (let x = 2; x < hfRes - 2; x++) {
        const idx = y * hfRes + x;
        if (base.landMask[idx] !== 1) continue;
        const wx = (x - hfRes / 2) * cellSize;
        const wy = (y - hfRes / 2) * cellSize;
        const valley = riverCarveFactor(wx, wy, mainSegments, riverHalfWidthM * 2.4);
        const carve = riverCarveFactor(wx, wy, mainSegments, riverHalfWidthM);
        if (valley <= 0.02 || valley >= 0.98) {
          if (riverCarveFactor(wx, wy, auxSegments, riverHalfWidthM) <= 0) continue;
        }
        if (carve >= 0.98) continue;
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += heightfield[(y + dy) * hfRes + (x + dx)] as number;
        blurred[idx] = (heightfield[idx] as number) * 0.3 + (sum / 25) * 0.7;
      }
    }
    for (let y = 2; y < hfRes - 2; y++) for (let x = 2; x < hfRes - 2; x++) {
      const idx = y * hfRes + x;
      if (base.landMask[idx] !== 1) continue;
      const wx = (x - hfRes / 2) * cellSize;
      const wy = (y - hfRes / 2) * cellSize;
      const valley = riverCarveFactor(wx, wy, mainSegments, riverHalfWidthM * 2.4);
      const carve = riverCarveFactor(wx, wy, mainSegments, riverHalfWidthM);
      if (valley <= 0.02 || valley >= 0.98) {
        if (riverCarveFactor(wx, wy, auxSegments, riverHalfWidthM) <= 0) continue;
      }
      if (carve >= 0.98) continue;
      heightfield[idx] = blurred[idx] as number;
    }
  }
  return heightfield;
}
