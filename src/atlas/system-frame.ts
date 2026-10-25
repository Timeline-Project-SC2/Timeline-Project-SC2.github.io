/* Map Atlas — без-DOM-модель системного кадра S0…S2.
 *
 * Кадр является чистой структурой данных: звезда, заявленные места, орбиты,
 * пустые слоты и статусы. Геометрию рисует вызывающая сторона.
 */

import { PLANET_GLOBE } from './config.ts';
import type { AtlasKernel, PlaceRecord, SystemRecord } from './config.ts';
import { levelSpec } from './level-ladder.ts';

export type SystemFrameLevel = 13 | 14 | 15;
export type SystemFrameLevelId = 'S0' | 'S1' | 'S2';
export type SystemBodyKind = 'planet' | 'moon' | 'other' | 'unknown';
export type OrbitLayoutSource = 'declared-au' | 'uniform-log-slot';
export type OrbitScaleMode = 'no-orbits' | 'uniform-log-slots' | 'declared-au' | 'mixed';

export interface FramePoint {
  readonly x: number;
  readonly y: number;
}

export interface SystemFrameBody {
  readonly id: string;
  readonly placeId: string;
  readonly name: string;
  readonly kind: SystemBodyKind;
  readonly placeType: string | null;
  readonly typeStatus: 'declared' | 'unspecified';
  readonly status: 'declared';
  readonly slot: string;
  readonly sourceRowIndex: number;
  readonly orbitalIndex: number | null;
  readonly orbitAu: number | null;
  readonly orbitId: string;
  readonly position: FramePoint;
  readonly phaseRadians: number;
  readonly rawDiameterPx: number;
  readonly diameterPx: number;
  readonly clampMinPx: number;
  readonly clampMaxPx: number | null;
  readonly sizeStatus: 'visibility-clamped';
  readonly planetAction: {
    readonly label: 'К планете';
    readonly href: string;
    readonly target: '_self';
  } | null;
}

export interface SystemFrameOrbit {
  readonly id: string;
  readonly bodyId: string;
  /** Большая полуось из данных places, если она заявлена; иначе null. */
  readonly orbitAu: number | null;
  /** Радиус в координатах текущего системного кадра (а.е.). */
  readonly rScreenAu: number;
  /** Радиус от центра как доля ширины кадра. */
  readonly rScreenFraction: number;
  /** Натуральный логарифм для заявленной а.е.; null для условного слота. */
  readonly logRadius: number | null;
  /** Позиция в равномерно распределённом логарифмическом слоте, 0…1. */
  readonly normalizedLogSlot: number | null;
  readonly source: OrbitLayoutSource;
}

export interface SystemFrameStar {
  readonly id: string;
  readonly kind: 'star';
  readonly slot: 'S';
  readonly position: FramePoint;
  readonly spectralClass: null;
  readonly spectralClassLabel: 'класс не заявлен';
  readonly paletteFamily: 'G2V-подобная нейтральная';
  readonly palette: {
    readonly core: string;
    readonly disk: string;
    readonly edge: string;
    readonly rim: string;
    readonly corona: string;
  };
  readonly fractionalRim: {
    readonly coverageFraction: number;
    readonly thicknessFraction: number;
  };
  readonly diameterPx: number;
  readonly coronaLayers: readonly {
    readonly radiusFactor: number;
    readonly opacity: number;
  }[];
}

export interface SystemFrameWaitingSlot {
  readonly id: string;
  readonly slot: string;
  readonly status: 'empty';
  readonly placeId: null;
  readonly label: 'Пустой слот';
}

export interface SystemFrameEmptyState {
  readonly visible: true;
  readonly message: 'Тела не занесены. Данные добавляются в таблице places';
  readonly action: {
    readonly label: 'Открыть таблицу';
    readonly href: string;
    readonly target: '_blank';
    readonly rel: 'noreferrer';
  };
}

export interface SystemFrame {
  readonly systemId: string;
  readonly systemName: string;
  readonly level: SystemFrameLevel;
  readonly levelId: SystemFrameLevelId;
  readonly frame: {
    readonly kind: 'O';
    readonly widthAu: number;
    readonly outerOrbitFraction: 0.42;
  };
  readonly star: SystemFrameStar;
  readonly bodies: readonly SystemFrameBody[];
  readonly orbits: readonly SystemFrameOrbit[];
  readonly waitingShelf: {
    readonly label: 'Полка ожидания';
    readonly slots: readonly SystemFrameWaitingSlot[];
  };
  readonly orbitScale: {
    readonly r0Au: 0.4;
    readonly A: number | null;
    readonly outerDeclaredOrbitAu: number | null;
    readonly mode: OrbitScaleMode;
  };
  readonly isEmpty: boolean;
  readonly emptyState: SystemFrameEmptyState | null;
  readonly statuses: {
    readonly contents: 'empty' | 'declared';
    readonly orbitalData: 'absent' | 'partial' | 'declared';
    readonly diagram: 'conditional';
    readonly stellarClass: 'unclaimed';
  };
  readonly flags: {
    readonly isEmpty: boolean;
    readonly hasDeclaredBodies: boolean;
    readonly hasDeclaredOrbitData: boolean;
    readonly conditionalDiagram: true;
  };
  readonly notices: {
    readonly diagram: 'схема условна, порядок тел не зафиксирован';
    readonly stellarClass: 'класс не заявлен';
  };
}

export interface SystemFrameApi {
  openSystem(systemId: string, level: number): SystemFrame;
  close(): void;
}

export const ORBIT_REFERENCE_AU = 0.4;
export const OUTER_ORBIT_FRACTION = 0.42;
export const WAITING_SHELF_SLOT_COUNT = 3;

const BODY_SIZE_BY_LEVEL: Readonly<Record<SystemFrameLevelId, Readonly<Record<SystemBodyKind, number>>>> = {
  S0: { planet: 28, moon: 22, other: 20, unknown: 18 },
  S1: { planet: 112, moon: 88, other: 76, unknown: 64 },
  S2: { planet: 260, moon: 228, other: 212, unknown: 200 },
};

const BODY_SIZE_CLAMP_BY_LEVEL: Readonly<Record<SystemFrameLevelId, { min: number; max: number | null }>> = {
  S0: { min: 18, max: 28 },
  S1: { min: 48, max: 128 },
  S2: { min: 200, max: null },
};

const STAR_STYLE: Omit<SystemFrameStar, 'id' | 'diameterPx'> = {
  kind: 'star',
  slot: 'S',
  position: { x: 0.5, y: 0.5 },
  spectralClass: null,
  spectralClassLabel: 'класс не заявлен',
  paletteFamily: 'G2V-подобная нейтральная',
  palette: {
    core: '#fff4d8',
    disk: '#e7cf91',
    edge: '#a88c5e',
    rim: '#f5dfaa',
    corona: '#d5b577',
  },
  fractionalRim: {
    coverageFraction: 0.72,
    thicknessFraction: 0.075,
  },
  coronaLayers: [
    { radiusFactor: 1.18, opacity: 0.3 },
    { radiusFactor: 1.48, opacity: 0.16 },
    { radiusFactor: 1.88, opacity: 0.07 },
  ],
};

const EMPTY_STATE_MESSAGE = 'Тела не занесены. Данные добавляются в таблице places' as const;

function placesTableUrl(): string {
  // Публичная HTML-вкладка той же книги и gid, откуда tools/sync.py получает CSV.
  return 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrNzh4Te01vHYmnHxZQoNrTMmeeWjU2XbOGsTl9M6U8djTZ8evbNMmPTONwWZYbNeImHcqMpGiKKy7/pubhtml?gid=1415856610&single=true';
}

function validNumber(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstNumericField(record: PlaceRecord, fields: readonly string[]): number | null {
  for (const field of fields) {
    const value = validNumber(record[field]);
    if (value !== null) return value;
  }
  return null;
}

function orbitalIndexOf(place: PlaceRecord): number | null {
  const value = firstNumericField(place, ['orbital_index', 'orbitalIndex']);
  return value !== null && value >= 0 ? value : null;
}

function sourceRowIndexOf(place: PlaceRecord, arrayIndex: number): number {
  const rowIndex = firstNumericField(place, [
    'placesCsvRowIndex',
    'places_csv_row_index',
    'csvRowIndex',
    'csv_row_index',
  ]);
  return rowIndex !== null && rowIndex >= 0 ? rowIndex : arrayIndex;
}

function compareText(left: string, right: string): number {
  const a = left.toLowerCase().replace(/ё/g, 'е');
  const b = right.toLowerCase().replace(/ё/g, 'е');
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface OrderedPlace {
  readonly place: PlaceRecord;
  readonly arrayIndex: number;
  readonly rowIndex: number;
  readonly orbitalIndex: number | null;
}

function orderedPlaces(places: readonly PlaceRecord[]): OrderedPlace[] {
  const decorated = places.map(function (place, arrayIndex) {
    return {
      place: place,
      arrayIndex: arrayIndex,
      rowIndex: sourceRowIndexOf(place, arrayIndex),
      orbitalIndex: orbitalIndexOf(place),
    };
  });

  decorated.sort(function (left, right) {
    if (left.orbitalIndex !== null && right.orbitalIndex !== null && left.orbitalIndex !== right.orbitalIndex) {
      return left.orbitalIndex - right.orbitalIndex;
    }
    if (left.orbitalIndex !== null && right.orbitalIndex === null) return -1;
    if (left.orbitalIndex === null && right.orbitalIndex !== null) return 1;
    if (left.rowIndex !== right.rowIndex) return left.rowIndex - right.rowIndex;

    const nameOrder = compareText(String(left.place.name || ''), String(right.place.name || ''));
    if (nameOrder !== 0) return nameOrder;
    const idOrder = compareText(String(left.place.id || ''), String(right.place.id || ''));
    if (idOrder !== 0) return idOrder;
    return left.arrayIndex - right.arrayIndex;
  });

  return decorated;
}

function normalizedPlaceType(place: PlaceRecord): { kind: SystemBodyKind; placeType: string | null } {
  let source: unknown;
  let hasRawType = false;
  if (Object.hasOwn(place, 'type')) {
    source = place.type;
    hasRawType = true;
  } else if (Object.hasOwn(place, 'placeType')) {
    source = place.placeType;
    hasRawType = true;
  }

  let rawTypes: unknown[];
  if (hasRawType) {
    rawTypes = Array.isArray(source) ? source : [source];
  } else if (Array.isArray(place.placeTypes)) {
    rawTypes = place.placeTypes;
  } else if (place.placeTypes != null && place.placeTypes !== '') {
    rawTypes = [place.placeTypes];
  } else {
    rawTypes = [];
  }

  const firstType = rawTypes
    .map(function (value) { return value == null ? '' : String(value).trim().toLowerCase(); })
    .find(function (value) {
      return value !== '' && value !== 'none' && value !== 'unknown' && value !== 'null' && value !== '-';
    });

  if (!firstType) return { kind: 'unknown', placeType: null };
  if (firstType === 'planet') return { kind: 'planet', placeType: firstType };
  if (firstType === 'moon') return { kind: 'moon', placeType: firstType };
  return { kind: 'other', placeType: firstType };
}

function systemIdOf(place: PlaceRecord): string | null {
  const candidates: unknown[] = [place.systemId, place.system_id, place.system];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const id = String(candidate).trim();
    if (id && id.toLowerCase() !== 'none') return id;
  }
  return null;
}

function orbitAuOf(place: PlaceRecord): number | null {
  const value = firstNumericField(place, [
    'orbit_au',
    'orbitAu',
    'semi_major_axis_au',
    'semiMajorAxisAu',
    'orbital_radius_au',
    'orbitalRadiusAu',
  ]);
  return value !== null && value > 0 ? value : null;
}

/** A для r_screen = A · ln(1 + r_au / 0,4), чтобы внешний радиус был 0,42 ширины. */
export function calibrateOrbitScale(outerOrbitAu: number, frameWidthAu: number): number {
  if (!Number.isFinite(outerOrbitAu) || outerOrbitAu <= 0) {
    throw new RangeError(`Внешняя орбита должна быть положительным числом: ${String(outerOrbitAu)}`);
  }
  if (!Number.isFinite(frameWidthAu) || frameWidthAu <= 0) {
    throw new RangeError(`Ширина кадра должна быть положительным числом: ${String(frameWidthAu)}`);
  }
  return (OUTER_ORBIT_FRACTION * frameWidthAu) /
    Math.log1p(outerOrbitAu / ORBIT_REFERENCE_AU);
}

/** Лог-компрессия заявленной большой полуоси в координаты текущего кадра. */
export function orbitScreenRadius(orbitAu: number, scaleA: number): number {
  if (!Number.isFinite(orbitAu) || orbitAu < 0) {
    throw new RangeError(`Орбитальный радиус не может быть отрицательным: ${String(orbitAu)}`);
  }
  if (!Number.isFinite(scaleA) || scaleA <= 0) {
    throw new RangeError(`Масштаб орбит должен быть положительным числом: ${String(scaleA)}`);
  }
  return scaleA * Math.log1p(orbitAu / ORBIT_REFERENCE_AU);
}

function systemLevel(level: number): { level: SystemFrameLevel; levelId: SystemFrameLevelId; widthAu: number } {
  const spec = levelSpec(level);
  if (!spec || spec.frame !== 'O' || (spec.id !== 'S0' && spec.id !== 'S1' && spec.id !== 'S2')) {
    throw new RangeError(`Системный уровень должен быть S0…S2 (уровни 13…15): ${String(level)}`);
  }
  return {
    level: level as SystemFrameLevel,
    levelId: spec.id,
    widthAu: spec.visibleWidth,
  };
}

function findSystem(kernel: Pick<AtlasKernel, 'state'>, systemId: string): SystemRecord | null {
  const id = String(systemId);
  const byId = kernel.state.systemsById[id];
  if (byId) return byId;
  return kernel.state.systems.find(function (system) { return String(system.id) === id; }) || null;
}

function framePlaces(kernel: Pick<AtlasKernel, 'state'>, systemId: string): PlaceRecord[] {
  return kernel.state.planets.filter(function (place) {
    return systemIdOf(place) === systemId;
  });
}

function buildOrbits(
  systemId: string,
  ordered: readonly OrderedPlace[],
  frameWidthAu: number,
): { orbits: SystemFrameOrbit[]; A: number | null; outerAu: number | null; mode: OrbitScaleMode } {
  if (ordered.length === 0) return { orbits: [], A: null, outerAu: null, mode: 'no-orbits' };

  const orbitAuById = ordered.map(function (entry) { return orbitAuOf(entry.place); });
  const known = orbitAuById.filter(function (value): value is number { return value !== null; });
  const outerAu = known.length ? Math.max(...known) : null;
  const A = outerAu === null ? null : calibrateOrbitScale(outerAu, frameWidthAu);
  const mode: OrbitScaleMode = known.length === 0
    ? 'uniform-log-slots'
    : (known.length === ordered.length ? 'declared-au' : 'mixed');

  const orbits = ordered.map(function (entry, index) {
    const bodyId = String(entry.place.id || entry.place.name || `row-${entry.arrayIndex}`);
    const orbitId = `${systemId}:orbit:${bodyId}`;
    const orbitAu = orbitAuById[index] ?? null;
    if (orbitAu !== null && A !== null) {
      const logRadius = Math.log1p(orbitAu / ORBIT_REFERENCE_AU);
      const rScreenAu = orbitScreenRadius(orbitAu, A);
      return {
        id: orbitId,
        bodyId: bodyId,
        orbitAu: orbitAu,
        rScreenAu: rScreenAu,
        rScreenFraction: rScreenAu / frameWidthAu,
        logRadius: logRadius,
        normalizedLogSlot: null,
        source: 'declared-au' as const,
      };
    }

    const normalizedLogSlot = (index + 1) / ordered.length;
    const rScreenFraction = OUTER_ORBIT_FRACTION * normalizedLogSlot;
    return {
      id: orbitId,
      bodyId: bodyId,
      orbitAu: null,
      rScreenAu: frameWidthAu * rScreenFraction,
      rScreenFraction: rScreenFraction,
      logRadius: null,
      normalizedLogSlot: normalizedLogSlot,
      source: 'uniform-log-slot' as const,
    };
  });

  return { orbits: orbits, A: A, outerAu: outerAu, mode: mode };
}

function bodySize(kind: SystemBodyKind, levelId: SystemFrameLevelId, widthAu: number): {
  rawDiameterPx: number;
  diameterPx: number;
  clampMinPx: number;
  clampMaxPx: number | null;
} {
  const limits = BODY_SIZE_CLAMP_BY_LEVEL[levelId];
  const rawDiameterPx = 0.04 * (100 / widthAu);
  const requested = BODY_SIZE_BY_LEVEL[levelId][kind];
  const diameterPx = Math.max(limits.min, limits.max === null ? requested : Math.min(limits.max, requested));
  return {
    rawDiameterPx: rawDiameterPx,
    diameterPx: diameterPx,
    clampMinPx: limits.min,
    clampMaxPx: limits.max,
  };
}

function starForSystem(systemId: string, levelId: SystemFrameLevelId): SystemFrameStar {
  const diameterPxByLevel: Readonly<Record<SystemFrameLevelId, number>> = { S0: 36, S1: 120, S2: 320 };
  return {
    ...STAR_STYLE,
    id: `${systemId}:star`,
    diameterPx: diameterPxByLevel[levelId],
  };
}

function waitingShelf(): SystemFrame['waitingShelf'] {
  const slots: SystemFrameWaitingSlot[] = Array.from({ length: WAITING_SHELF_SLOT_COUNT }, function (_, index) {
    const ordinal = index + 1;
    return {
      id: `waiting-${ordinal}`,
      slot: `W${ordinal}`,
      status: 'empty',
      placeId: null,
      label: 'Пустой слот',
    };
  });
  return { label: 'Полка ожидания', slots: slots };
}

function globeActionForPlace(
  place: PlaceRecord,
  kind: SystemBodyKind,
  systemId: string,
  levelId: SystemFrameLevelId,
): SystemFrameBody['planetAction'] {
  if (levelId !== 'S2') return null;
  if (kind !== 'planet' && kind !== 'moon' && !place.planetProfileStatus) return null;
  const placeId = String(place.id);
  const href = PLANET_GLOBE.route + '?place=' + encodeURIComponent(placeId) +
    '&system=' + encodeURIComponent(systemId);
  return { label: 'К планете', href: href, target: '_self' };
}

function emptyStateFor(isEmpty: boolean): SystemFrameEmptyState | null {
  if (!isEmpty) return null;
  return {
    visible: true,
    message: EMPTY_STATE_MESSAGE,
    action: {
      label: 'Открыть таблицу',
      href: placesTableUrl(),
      target: '_blank',
      rel: 'noreferrer',
    },
  };
}

export function createSystemFrame(kernel: Pick<AtlasKernel, 'state'>): SystemFrameApi {
  function openSystem(systemId: string, level: number): SystemFrame {
    const requestedId = String(systemId);
    const system = findSystem(kernel, requestedId);
    if (!system) throw new RangeError(`Система не найдена: ${requestedId}`);

    const frameLevel = systemLevel(level);
    const entries = orderedPlaces(framePlaces(kernel, requestedId));
    const orbitData = buildOrbits(requestedId, entries, frameLevel.widthAu);
    const orbitsByBodyId = new Map<string, SystemFrameOrbit>();
    orbitData.orbits.forEach(function (orbit) { orbitsByBodyId.set(orbit.bodyId, orbit); });
    const bodyCount = entries.length;

    const bodies = entries.map(function (entry, index): SystemFrameBody {
      const place = entry.place;
      const id = String(place.id || place.name || `row-${entry.arrayIndex}`);
      const type = normalizedPlaceType(place);
      const size = bodySize(type.kind, frameLevel.levelId, frameLevel.widthAu);
      const phaseRadians = bodyCount === 0 ? 0 : (2 * Math.PI * index) / bodyCount;
      const orbit = orbitsByBodyId.get(id);
      const radiusFraction = orbit ? orbit.rScreenFraction : 0;
      return {
        id: id,
        placeId: id,
        name: String(place.name || id),
        kind: type.kind,
        placeType: type.placeType,
        typeStatus: type.placeType === null ? 'unspecified' : 'declared',
        status: 'declared',
        slot: `B${index + 1}`,
        sourceRowIndex: entry.rowIndex,
        orbitalIndex: entry.orbitalIndex,
        orbitAu: orbit ? orbit.orbitAu : null,
        orbitId: orbit ? orbit.id : `${requestedId}:orbit:${id}`,
        position: {
          x: 0.5 + radiusFraction * Math.cos(phaseRadians),
          y: 0.5 + radiusFraction * Math.sin(phaseRadians),
        },
        phaseRadians: phaseRadians,
        rawDiameterPx: size.rawDiameterPx,
        diameterPx: size.diameterPx,
        clampMinPx: size.clampMinPx,
        clampMaxPx: size.clampMaxPx,
        sizeStatus: 'visibility-clamped',
        planetAction: globeActionForPlace(place, type.kind, requestedId, frameLevel.levelId),
      };
    });

    const isEmpty = bodies.length === 0;
    const hasDeclaredOrbitData = orbitData.outerAu !== null;
    const hasUnknownOrbitData = orbitData.mode === 'mixed' || orbitData.mode === 'uniform-log-slots';
    const orbitalStatus = !hasDeclaredOrbitData
      ? 'absent'
      : (hasUnknownOrbitData ? 'partial' : 'declared');

    return {
      systemId: requestedId,
      systemName: String(system.name || requestedId),
      level: frameLevel.level,
      levelId: frameLevel.levelId,
      frame: {
        kind: 'O',
        widthAu: frameLevel.widthAu,
        outerOrbitFraction: OUTER_ORBIT_FRACTION,
      },
      star: starForSystem(requestedId, frameLevel.levelId),
      bodies: bodies,
      orbits: orbitData.orbits,
      waitingShelf: waitingShelf(),
      orbitScale: {
        r0Au: ORBIT_REFERENCE_AU,
        A: orbitData.A,
        outerDeclaredOrbitAu: orbitData.outerAu,
        mode: orbitData.mode,
      },
      isEmpty: isEmpty,
      emptyState: emptyStateFor(isEmpty),
      statuses: {
        contents: isEmpty ? 'empty' : 'declared',
        orbitalData: orbitalStatus,
        diagram: 'conditional',
        stellarClass: 'unclaimed',
      },
      flags: {
        isEmpty: isEmpty,
        hasDeclaredBodies: !isEmpty,
        hasDeclaredOrbitData: hasDeclaredOrbitData,
        conditionalDiagram: true,
      },
      notices: {
        diagram: 'схема условна, порядок тел не зафиксирован',
        stellarClass: 'класс не заявлен',
      },
    };
  }

  function close(): void {
    // Вызвавшая сторона владеет кадром и освобождает/отбрасывает его сама.
  }

  return { openSystem: openSystem, close: close };
}
