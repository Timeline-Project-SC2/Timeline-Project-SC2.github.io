/* Контракт редактора границ: области (Area), состояния (State) и режимы (Mode).
 *
 * Проект решения — заметки `docs/stages/stage-09-12-sector/notes/brush-*.md`.
 * Модуль — «чистое ядро» (шаг 1 §11 части 2): только типы, разбор и валидация.
 * Ни геометрии, ни рендера, ни DOM здесь нет. Источник истины — JSON
 * (`data/sector-areas.json`), этот файл описывает его схему версии 1.
 *
 * Ключевое отличие от прежнего проекта: геометрия области живёт в мировых
 * координатах `0…10000` и не обязана совпадать с координатным сектором; адрес
 * `KP·…` — справочный, а каскад идёт по явному `parentId`.
 */

export const SECTOR_AREAS_SCHEMA_VERSION = 1;
export const SECTOR_AREAS_MAP_SIZE = 10000;

/** Глубина лестницы `L0…L12`; системные кадры `S0…S2` в редакторе не участвуют. */
export const MIN_LEVEL = 0;
export const MAX_LEVEL = 12;

/* ------------------------------------------------------------------- режимы */

export type Mode = 'political' | 'military' | 'economy' | 'tension';
export type ExperimentalMode = 'ecology' | 'history';
export type AnyMode = Mode | ExperimentalMode;

export const MODES: readonly Mode[] = Object.freeze(['political', 'military', 'economy', 'tension']);
export const EXPERIMENTAL_MODES: readonly ExperimentalMode[] = Object.freeze(['ecology', 'history']);
export const ALL_MODES: readonly AnyMode[] = Object.freeze([...MODES, ...EXPERIMENTAL_MODES]);

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

export function isExperimentalMode(value: unknown): value is ExperimentalMode {
  return typeof value === 'string' && (EXPERIMENTAL_MODES as readonly string[]).includes(value);
}

export function isAnyMode(value: unknown): value is AnyMode {
  return isMode(value) || isExperimentalMode(value);
}

/* --------------------------------------------------------------- перечисления */

/** Привязка состояния к фракции: одна, пара (граница A→B) или нейтраль. */
export type FactionMode = 'single' | 'pair' | 'neutral';
export const FACTION_MODES: readonly FactionMode[] = Object.freeze(['single', 'pair', 'neutral']);

/** Чем создана область: свободная кисть, секторный снап или импорт. */
export type AreaSource = 'brush' | 'sector' | 'import';
export const AREA_SOURCES: readonly AreaSource[] = Object.freeze(['brush', 'sector', 'import']);

/** Степень сглаживания: `0` — сырая ломаная, `1` — базовое, `2` — сильное. */
export type Rounding = 0 | 1 | 2;

export type GradientMode = 'auto' | 'custom' | 'hybrid';
export type GradientBlend = 'linear' | 'smooth' | 'step';
export type GradientDirection = 'along' | 'reverse' | 'across';

/** Вид задачи: меняет стиль (пунктир, толщина, прозрачность), но не фракцию. */
export type TaskKind = 'none' | 'patrol' | 'siege' | 'trade' | 'raid' | 'blockade';
export const TASK_KINDS: readonly TaskKind[] = Object.freeze(['none', 'patrol', 'siege', 'trade', 'raid', 'blockade']);

/** Классификация области относительно области действия (scope). */
export type AreaLocation = 'inside' | 'outside' | 'border' | 'core' | 'band' | 'unknown';
export const AREA_LOCATIONS: readonly AreaLocation[] = Object.freeze([
  'inside',
  'outside',
  'border',
  'core',
  'band',
  'unknown',
]);

/** Набор детализации по умолчанию; редактируется глобально (часть 3 §5). */
export const DEFAULT_DETAIL_IDS: readonly string[] = Object.freeze([
  'inside',
  'outside',
  'border',
  'core',
  'band',
  'unknown',
]);

/* ------------------------------------------------------------------ геометрия */

export type AreaPoint = readonly [number, number];
export type Ring = readonly AreaPoint[];

/* ------------------------------------------------------------------ градиент */

export interface GradientStop {
  /** Смещение вдоль границы: `0…1`. */
  readonly offset: number;
  readonly color: string;
  readonly alpha: number;
}

/** Точечная правка админа поверх автоматических стопов (режим `hybrid`). */
export interface GradientOverride {
  /** Индекс заменяемого стопа в базовом наборе. */
  readonly index: number | null;
  /** Позиция вставки: стоп добавляется, а не заменяет существующий. */
  readonly at: number | null;
  readonly offset: number | null;
  readonly color: string | null;
  readonly alpha: number | null;
  /** Сдвиг точки перехода A→B. */
  readonly splitAt: number | null;
}

export interface GradientSpec {
  readonly mode: GradientMode;
  readonly blend: GradientBlend;
  /** Явные стопы для `custom`; в `auto` пусто, в `hybrid` — переопределения базы. */
  readonly stops: readonly GradientStop[];
  readonly overrides: readonly GradientOverride[];
  /** Точка перехода A→B для пары фракций; `null` — середина. */
  readonly splitAt: number | null;
  readonly direction: GradientDirection;
  /** Вершина шва замкнутого контура; `null` — стопы циклические. */
  readonly seamVertex: number | null;
  readonly version: number;
}

export const DEFAULT_GRADIENT: GradientSpec = Object.freeze({
  mode: 'auto',
  blend: 'linear',
  stops: Object.freeze([]),
  overrides: Object.freeze([]),
  splitAt: null,
  direction: 'along',
  seamVertex: null,
  version: 1,
});

/* ------------------------------------------------------------------ состояние */

export interface AreaState {
  readonly id: string;
  readonly mode: Mode;
  readonly factionMode: FactionMode;
  readonly factionIds: readonly string[];
  readonly task: TaskKind;
  /** Диапазон глубин, где состояние показывается: `L0…L12`. */
  readonly visibleFrom: number;
  readonly visibleTo: number;
  readonly z: number;
  /** Приоритет среди нескольких состояний одной области в одном режиме. */
  readonly priority: number;
  readonly lodBias: number;
  readonly rounding: Rounding;
  readonly gradient: GradientSpec;
  /** Признак форс-закрашивания: перебивает цвета, но не разрушает состояния. */
  readonly override: boolean;
  readonly label: string | null;
}

export const DEFAULT_STATE_PRIORITY = 0;

/* --------------------------------------------------------------------- событие */

export interface AreaEvent {
  readonly id: string;
  /** Что произошло: `create`, `edit`, `state`, `override`, `remove`. */
  readonly kind: string;
  readonly areaId: string | null;
  readonly mode: AnyMode | null;
  readonly note: string | null;
}

/* ---------------------------------------------------------------------- область */

export interface Area {
  readonly id: string;
  readonly name: string;
  /** Родитель каскада; `null` — область верхнего уровня. */
  readonly parentId: string | null;
  /** Справочный адрес `KP·…`; для свободной кисти вычисляется, а не требуется. */
  readonly address: string | null;
  readonly source: AreaSource;
  /** `false` — открытая линия (граница без заливки). */
  readonly closed: boolean;
  /** Первое кольцо — внешнее, остальные — дырки. */
  readonly rings: readonly Ring[];
  readonly states: readonly AreaState[];
  readonly scopeId: string | null;
  readonly location: AreaLocation | null;
  /** Детализация из настраиваемого набора (часть 3 §5). */
  readonly detail: string | null;
  readonly distance: number | null;
  /** Полоса пограничного мира; связана с полосами `BorderWorld`. */
  readonly band: string | null;
  readonly events: readonly AreaEvent[];
}

/* ---------------------------------------------------------- форс-закрашивание */

export interface AreaOverride {
  readonly id: string;
  /** `null` — мазок перебивает все области под собой, не привязан к одной. */
  readonly areaId: string | null;
  readonly mode: Mode | null;
  readonly rings: readonly Ring[];
  readonly color: string;
  readonly alpha: number;
  readonly z: number;
  readonly note: string | null;
}

/** Приоритет мазка форс-закрашивания: рисуется последним, поверх всего. */
export const OVERRIDE_Z = 1000;

/* -------------------------------------------------------------------- документ */

export interface SectorAreasDoc {
  readonly version: typeof SECTOR_AREAS_SCHEMA_VERSION;
  readonly mapSize: typeof SECTOR_AREAS_MAP_SIZE;
  readonly modes: readonly Mode[];
  readonly experimentalModes: readonly ExperimentalMode[];
  readonly areas: readonly Area[];
  readonly overrides: readonly AreaOverride[];
  readonly events: readonly AreaEvent[];
}

export function emptySectorAreasDoc(): SectorAreasDoc {
  return {
    version: SECTOR_AREAS_SCHEMA_VERSION,
    mapSize: SECTOR_AREAS_MAP_SIZE,
    modes: MODES,
    experimentalModes: EXPERIMENTAL_MODES,
    areas: [],
    overrides: [],
    events: [],
  };
}

/* --------------------------------------------------------------------- разбор */

function invalid(message: string): never {
  throw new RangeError(`Некорректные области сектора: ${message}`);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(message);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(message);
  return value;
}

function requireNullableString(value: unknown, message: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, message);
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(message);
  return value;
}

function requireInteger(value: unknown, message: string): number {
  const number = requireNumber(value, message);
  if (!Number.isInteger(number)) return invalid(message);
  return number;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') return invalid(message);
  return value;
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) return invalid(message);
  return value as T;
}

function parseRounding(value: unknown, message: string): Rounding {
  if (value === undefined || value === null) return 1;
  const number = requireNumber(value, message);
  if (number === 0) return 0;
  if (number === 1) return 1;
  if (number === 2) return 2;
  return invalid(`${message} должна быть 0, 1 или 2`);
}

function parsePoint(value: unknown, message: string): AreaPoint {
  if (!Array.isArray(value) || value.length !== 2) return invalid(message);
  const x = requireNumber(value[0], message);
  const y = requireNumber(value[1], message);
  if (x < 0 || x > SECTOR_AREAS_MAP_SIZE || y < 0 || y > SECTOR_AREAS_MAP_SIZE) {
    return invalid(`${message} (координата вне диапазона 0…${SECTOR_AREAS_MAP_SIZE})`);
  }
  return [x, y];
}

function parseRings(value: unknown, message: string): readonly Ring[] {
  if (!Array.isArray(value) || value.length === 0) return invalid(message);
  return value.map((ring: unknown) => {
    if (!Array.isArray(ring) || ring.length < 2) return invalid(`${message}: кольцо должно иметь минимум 2 точки`);
    return ring.map((point: unknown) => parsePoint(point, `${message}: точка кольца`));
  });
}

function parseGradient(value: unknown, message: string): GradientSpec {
  if (value === null || value === undefined) return DEFAULT_GRADIENT;
  const raw = asRecord(value, `${message}: градиент должен быть объектом`);
  const stops = raw.stops === undefined || raw.stops === null
    ? []
    : (Array.isArray(raw.stops) ? raw.stops.map((stop: unknown) => {
      const item = asRecord(stop, `${message}: стоп градиента должен быть объектом`);
      return {
        offset: requireNumber(item.offset, `${message}: смещение стопа`),
        color: requireString(item.color, `${message}: цвет стопа`),
        alpha: requireNumber(item.alpha, `${message}: прозрачность стопа`),
      } satisfies GradientStop;
    }) : invalid(`${message}: стопы градиента должны быть массивом`));
  const overrides = raw.overrides === undefined || raw.overrides === null
    ? []
    : (Array.isArray(raw.overrides) ? raw.overrides.map((entry: unknown) => {
      const item = asRecord(entry, `${message}: переопределение градиента должно быть объектом`);
      return {
        index: item.index === undefined || item.index === null ? null : requireInteger(item.index, `${message}: индекс стопа`),
        at: item.at === undefined || item.at === null ? null : requireNumber(item.at, `${message}: позиция вставки`),
        offset: item.offset === undefined || item.offset === null ? null : requireNumber(item.offset, `${message}: смещение`),
        color: item.color === undefined || item.color === null ? null : requireString(item.color, `${message}: цвет`),
        alpha: item.alpha === undefined || item.alpha === null ? null : requireNumber(item.alpha, `${message}: прозрачность`),
        splitAt: item.splitAt === undefined || item.splitAt === null ? null : requireNumber(item.splitAt, `${message}: точка перехода`),
      } satisfies GradientOverride;
    }) : invalid(`${message}: переопределения градиента должны быть массивом`));

  return {
    mode: raw.mode === undefined ? DEFAULT_GRADIENT.mode : requireOneOf(raw.mode, ['auto', 'custom', 'hybrid'] as const, `${message}: режим градиента`),
    blend: raw.blend === undefined ? DEFAULT_GRADIENT.blend : requireOneOf(raw.blend, ['linear', 'smooth', 'step'] as const, `${message}: смешивание градиента`),
    stops,
    overrides,
    splitAt: raw.splitAt === undefined || raw.splitAt === null ? null : requireNumber(raw.splitAt, `${message}: точка перехода`),
    direction: raw.direction === undefined ? DEFAULT_GRADIENT.direction : requireOneOf(raw.direction, ['along', 'reverse', 'across'] as const, `${message}: направление градиента`),
    seamVertex: raw.seamVertex === undefined || raw.seamVertex === null ? null : requireInteger(raw.seamVertex, `${message}: вершина шва`),
    version: raw.version === undefined ? DEFAULT_GRADIENT.version : requireInteger(raw.version, `${message}: версия градиента`),
  };
}

function parseState(value: unknown, message: string): AreaState {
  const raw = asRecord(value, message);
  const factionIds = Array.isArray(raw.factionIds)
    ? raw.factionIds.map((entry: unknown) => requireString(entry, `${message}: идентификатор фракции`))
    : invalid(`${message}: список фракций должен быть массивом`);
  const visibleFrom = raw.visibleFrom === undefined ? MIN_LEVEL : requireInteger(raw.visibleFrom, `${message}: начало диапазона глубин`);
  const visibleTo = raw.visibleTo === undefined ? MAX_LEVEL : requireInteger(raw.visibleTo, `${message}: конец диапазона глубин`);

  return {
    id: requireString(raw.id, `${message}: идентификатор состояния`),
    mode: requireOneOf(raw.mode, MODES, `${message}: режим состояния`),
    factionMode: requireOneOf(raw.factionMode ?? 'single', FACTION_MODES, `${message}: привязка к фракции`),
    factionIds,
    task: requireOneOf(raw.task ?? 'none', TASK_KINDS, `${message}: вид задачи`),
    visibleFrom,
    visibleTo,
    z: raw.z === undefined ? 0 : requireNumber(raw.z, `${message}: порядок наложения`),
    priority: raw.priority === undefined ? DEFAULT_STATE_PRIORITY : requireNumber(raw.priority, `${message}: приоритет состояния`),
    lodBias: raw.lodBias === undefined ? 0 : requireNumber(raw.lodBias, `${message}: смещение детализации`),
    rounding: parseRounding(raw.rounding, `${message}: округлость`),
    gradient: parseGradient(raw.gradient, message),
    override: raw.override === undefined ? false : requireBoolean(raw.override, `${message}: признак переопределения`),
    label: requireNullableString(raw.label, `${message}: подпись состояния`),
  };
}

function parseEvent(value: unknown, message: string): AreaEvent {
  const raw = asRecord(value, message);
  const mode = requireNullableString(raw.mode, `${message}: режим события`);
  if (mode !== null && !isAnyMode(mode)) return invalid(`${message}: неизвестный режим`);
  return {
    id: requireString(raw.id, `${message}: идентификатор события`),
    kind: requireString(raw.kind, `${message}: вид события`),
    areaId: requireNullableString(raw.areaId, `${message}: область события`),
    mode: mode === null ? null : (mode as AnyMode),
    note: requireNullableString(raw.note, `${message}: примечание события`),
  };
}

function parseArea(value: unknown, message: string): Area {
  const raw = asRecord(value, message);
  const address = requireNullableString(raw.address, `${message}: адрес области`);
  const states = raw.states === undefined || raw.states === null
    ? []
    : (Array.isArray(raw.states) ? raw.states.map((entry: unknown) => parseState(entry, `${message}: состояние`)) : invalid(`${message}: состояния должны быть массивом`));
  const events = raw.events === undefined || raw.events === null
    ? []
    : (Array.isArray(raw.events) ? raw.events.map((entry: unknown) => parseEvent(entry, `${message}: событие`)) : invalid(`${message}: события должны быть массивом`));
  const location = requireNullableString(raw.location, `${message}: положение области`);

  return {
    id: requireString(raw.id, `${message}: идентификатор области`),
    name: requireString(raw.name, `${message}: имя области`),
    parentId: requireNullableString(raw.parentId, `${message}: родитель области`),
    address,
    source: requireOneOf(raw.source ?? 'brush', AREA_SOURCES, `${message}: источник области`),
    closed: raw.closed === undefined ? true : requireBoolean(raw.closed, `${message}: замкнутость области`),
    rings: parseRings(raw.rings, `${message}: геометрия области`),
    states,
    scopeId: requireNullableString(raw.scopeId, `${message}: область действия`),
    location: location === null ? null : (requireOneOf(location, AREA_LOCATIONS, `${message}: положение области`) as AreaLocation),
    detail: requireNullableString(raw.detail, `${message}: детализация области`),
    distance: raw.distance === undefined || raw.distance === null ? null : requireNumber(raw.distance, `${message}: расстояние области`),
    band: requireNullableString(raw.band, `${message}: полоса области`),
    events,
  };
}

function parseOverride(value: unknown, message: string): AreaOverride {
  const raw = asRecord(value, message);
  const mode = requireNullableString(raw.mode, `${message}: режим переопределения`);
  // Форс-закрашивание действует только в активных режимах v1.
  if (mode !== null && !isMode(mode)) return invalid(`${message}: режим переопределения не активен в v1`);
  return {
    id: requireString(raw.id, `${message}: идентификатор переопределения`),
    areaId: requireNullableString(raw.areaId, `${message}: область переопределения`),
    mode: mode === null ? null : mode,
    rings: parseRings(raw.rings, `${message}: геометрия переопределения`),
    color: requireString(raw.color, `${message}: цвет переопределения`),
    alpha: raw.alpha === undefined ? 1 : requireNumber(raw.alpha, `${message}: прозрачность переопределения`),
    z: raw.z === undefined ? OVERRIDE_Z : requireNumber(raw.z, `${message}: порядок переопределения`),
    note: requireNullableString(raw.note, `${message}: примечание переопределения`),
  };
}

/** Разбирает документ областей из JSON или объекта; ошибка схемы — `RangeError`. */
export function parseSectorAreas(json: unknown): SectorAreasDoc {
  let value: unknown = json;
  if (typeof json === 'string') {
    try {
      value = JSON.parse(json) as unknown;
    } catch {
      return invalid('ошибка JSON.');
    }
  }
  const root = asRecord(value, 'ожидался объект.');
  if (root.version !== SECTOR_AREAS_SCHEMA_VERSION) return invalid('неподдерживаемая версия схемы.');
  if (root.mapSize !== SECTOR_AREAS_MAP_SIZE) return invalid('неверный размер карты.');
  if (!Array.isArray(root.areas)) return invalid('список областей должен быть массивом.');
  if (!Array.isArray(root.overrides)) return invalid('список переопределений должен быть массивом.');
  if (!Array.isArray(root.events)) return invalid('журнал событий должен быть массивом.');

  const modes = root.modes === undefined
    ? MODES
    : (Array.isArray(root.modes) ? root.modes.map((entry: unknown) => requireOneOf(entry, MODES, 'неизвестный режим.')) : invalid('список режимов должен быть массивом.'));
  const experimentalModes = root.experimentalModes === undefined
    ? EXPERIMENTAL_MODES
    : (Array.isArray(root.experimentalModes)
      ? root.experimentalModes.map((entry: unknown) => requireOneOf(entry, EXPERIMENTAL_MODES, 'неизвестный экспериментальный режим.'))
      : invalid('список экспериментальных режимов должен быть массивом.'));

  return {
    version: SECTOR_AREAS_SCHEMA_VERSION,
    mapSize: SECTOR_AREAS_MAP_SIZE,
    modes,
    experimentalModes,
    areas: root.areas.map((entry: unknown) => parseArea(entry, 'область')),
    overrides: root.overrides.map((entry: unknown) => parseOverride(entry, 'переопределение')),
    events: root.events.map((entry: unknown) => parseEvent(entry, 'событие')),
  };
}

/* ------------------------------------------------------------------ валидация */

export interface ValidationContext {
  /** Имена фракций из `data/factions.csv` — для проверки ссылок состояния. */
  readonly factionNames?: ReadonlySet<string>;
  /** Идентификаторы областей действия (scope). */
  readonly scopeIds?: ReadonlySet<string>;
  /** Идентификаторы полос пограничного мира. */
  readonly bandIds?: ReadonlySet<string>;
  /** Допустимые значения детализации (глобальная настройка редактора). */
  readonly detailIds?: ReadonlySet<string>;
}

export interface ValidationReport {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

function isClosedRing(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined) return false;
  return first[0] === last[0] && first[1] === last[1];
}

/** Проверяет документ: ошибки схемы/ссылок и предупреждения о геометрии. */
export function validateSectorAreas(doc: SectorAreasDoc, context?: ValidationContext): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const areaIds = new Set<string>();
  for (const area of doc.areas) {
    if (areaIds.has(area.id)) errors.push(`Область ${area.id}: идентификатор повторяется.`);
    areaIds.add(area.id);
  }

  for (const area of doc.areas) {
    if (area.parentId !== null && !areaIds.has(area.parentId)) {
      errors.push(`Область ${area.id}: родитель ${area.parentId} не найден.`);
    }
    if (area.parentId === area.id) errors.push(`Область ${area.id}: ссылается сама на себя.`);

    if (area.rings.length === 0) errors.push(`Область ${area.id}: нет геометрии.`);
    area.rings.forEach((ring, index) => {
      const closedRing = isClosedRing(ring);
      if (area.closed && !closedRing) {
        errors.push(`Область ${area.id}: кольцо ${index} замкнутой области должно начинаться и заканчиваться одной точкой.`);
      }
      const minimum = area.closed ? 4 : 2;
      if (ring.length < minimum) {
        errors.push(`Область ${area.id}: кольцо ${index} должно иметь минимум ${minimum} точек.`);
      }
    });

    if (area.scopeId !== null && context?.scopeIds !== undefined && !context.scopeIds.has(area.scopeId)) {
      errors.push(`Область ${area.id}: область действия ${area.scopeId} не найдена.`);
    }
    if (area.detail !== null && context?.detailIds !== undefined && !context.detailIds.has(area.detail)) {
      errors.push(`Область ${area.id}: детализация «${area.detail}» не входит в набор.`);
    }
    if (area.band !== null && context?.bandIds !== undefined && !context.bandIds.has(area.band)) {
      errors.push(`Область ${area.id}: полоса «${area.band}» не найдена в пограничном мире.`);
    }
    if (area.distance !== null && (!Number.isFinite(area.distance) || area.distance < 0)) {
      errors.push(`Область ${area.id}: расстояние должно быть неотрицательным числом.`);
    }

    const stateIds = new Set<string>();
    const pairs = new Map<string, number>();
    for (const state of area.states) {
      if (stateIds.has(state.id)) errors.push(`Область ${area.id}: состояние ${state.id} повторяется.`);
      stateIds.add(state.id);

      if (!isMode(state.mode)) errors.push(`Область ${area.id}: режим ${state.mode} не активен в v1.`);
      if (state.visibleFrom > state.visibleTo) {
        errors.push(`Область ${area.id}: состояние ${state.id} — начало глубины больше конца.`);
      }
      if (state.visibleFrom < MIN_LEVEL || state.visibleTo > MAX_LEVEL) {
        errors.push(`Область ${area.id}: состояние ${state.id} — диапазон глубин вне ${MIN_LEVEL}…${MAX_LEVEL}.`);
      }

      if (state.factionMode === 'single' && state.factionIds.length !== 1) {
        errors.push(`Область ${area.id}: состояние ${state.id} — для одиночной фракции нужна ровно одна.`);
      }
      if (state.factionMode === 'pair' && state.factionIds.length !== 2) {
        errors.push(`Область ${area.id}: состояние ${state.id} — для пары нужны две фракции.`);
      }
      if (state.factionMode === 'pair' && state.factionIds.length === 2 && state.factionIds[0] === state.factionIds[1]) {
        errors.push(`Область ${area.id}: состояние ${state.id} — фракции пары должны различаться.`);
      }
      if (state.factionMode === 'neutral' && state.factionIds.length !== 0) {
        errors.push(`Область ${area.id}: состояние ${state.id} — нейтральное состояние не ссылается на фракции.`);
      }
      for (const faction of state.factionIds) {
        if (context?.factionNames !== undefined && !context.factionNames.has(faction)) {
          errors.push(`Область ${area.id}: состояние ${state.id} — фракция «${faction}» отсутствует в data/factions.csv.`);
        }
      }

      const key = `${state.mode}`;
      const seen = pairs.get(key) ?? 0;
      pairs.set(key, seen + 1);
      if (seen >= 1) {
        warnings.push(`Область ${area.id}: в режиме ${state.mode} несколько состояний — выбор идёт по приоритету.`);
      }

      validateGradient(area.id, state.id, state.gradient, errors);
    }
  }

  for (const cycle of findParentCycles(doc)) {
    errors.push(`Цикл в иерархии областей: ${cycle.join(' → ')}.`);
  }

  const overrideIds = new Set<string>();
  for (const override of doc.overrides) {
    if (overrideIds.has(override.id)) errors.push(`Переопределение ${override.id}: идентификатор повторяется.`);
    overrideIds.add(override.id);
    if (override.areaId !== null && !areaIds.has(override.areaId)) {
      errors.push(`Переопределение ${override.id}: область ${override.areaId} не найдена.`);
    }
    if (override.alpha < 0 || override.alpha > 1) {
      errors.push(`Переопределение ${override.id}: прозрачность должна быть в диапазоне 0…1.`);
    }
  }

  const eventIds = new Set<string>();
  for (const event of [...doc.events, ...doc.areas.flatMap((area) => [...area.events])]) {
    if (eventIds.has(event.id)) errors.push(`Событие ${event.id}: идентификатор повторяется.`);
    eventIds.add(event.id);
    if (event.areaId !== null && !areaIds.has(event.areaId)) {
      errors.push(`Событие ${event.id}: область ${event.areaId} не найдена.`);
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

function validateGradient(
  areaId: string,
  stateId: string,
  gradient: GradientSpec,
  errors: string[],
): void {
  const where = `Область ${areaId}: состояние ${stateId}`;
  if (gradient.mode === 'custom' && gradient.stops.length < 2) {
    errors.push(`${where}: для градиента «custom» нужно минимум два стопа.`);
  }
  let previous = -Infinity;
  gradient.stops.forEach((stop, index) => {
    if (stop.offset < 0 || stop.offset > 1) errors.push(`${where}: стоп ${index} — смещение вне диапазона 0…1.`);
    if (stop.offset < previous) errors.push(`${where}: стоп ${index} — смещения должны идти по возрастанию.`);
    previous = stop.offset;
    if (stop.alpha < 0 || stop.alpha > 1) errors.push(`${where}: стоп ${index} — прозрачность вне диапазона 0…1.`);
  });
  if (gradient.splitAt !== null && (gradient.splitAt < 0 || gradient.splitAt > 1)) {
    errors.push(`${where}: точка перехода градиента вне диапазона 0…1.`);
  }
  for (const entry of gradient.overrides) {
    if (entry.index !== null && (entry.index < 0 || entry.index >= gradient.stops.length)) {
      errors.push(`${where}: переопределение ссылается на несуществующий стоп ${entry.index}.`);
    }
  }
}

/** Возвращает пути циклов в иерархии `parentId`; пустой массив — циклов нет. */
export function findParentCycles(doc: SectorAreasDoc): readonly string[][] {
  const byId = new Map<string, Area>(doc.areas.map((area) => [area.id, area]));
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  for (const area of doc.areas) {
    if (state.get(area.id) === 'done') continue;
    const path: string[] = [];
    let current: Area | undefined = area;
    while (current !== undefined) {
      const mark = state.get(current.id);
      if (mark === 'done') break;
      if (mark === 'visiting') {
        cycles.push([...path.slice(path.indexOf(current.id)), current.id]);
        break;
      }
      state.set(current.id, 'visiting');
      path.push(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    for (const id of path) state.set(id, 'done');
  }

  return cycles;
}

/** Создаёт новую область свободной кистью: мировые координаты, адрес справочный. */
export function createArea(input: {
  readonly id: string;
  readonly name: string;
  readonly rings: readonly Ring[];
  readonly parentId?: string | null;
  readonly address?: string | null;
  readonly closed?: boolean;
  readonly source?: AreaSource;
}): Area {
  return {
    id: input.id,
    name: input.name,
    parentId: input.parentId ?? null,
    address: input.address ?? null,
    source: input.source ?? 'brush',
    closed: input.closed ?? true,
    rings: input.rings,
    states: [],
    scopeId: null,
    location: null,
    detail: null,
    distance: null,
    band: null,
    events: [],
  };
}
