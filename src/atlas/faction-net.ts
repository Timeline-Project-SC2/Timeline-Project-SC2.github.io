/* Atlas сектора — фракционные сети (`net_id`) и геометрия баблов (карточка Z-3.3).
 *
 * Слой заменяет фракционные границы (§17.22.2): сеть — это группа систем с
 * одинаковым `net_id > 0`, а не фракция. Модуль чистый: без DOM, canvas, таймеров,
 * `Math.random` и `Date.now`; один и тот же вход даёт один и тот же путь побайтово.
 *
 * Модель (по эскизу владельца, §17.22.2):
 *   1. `parseNetworks` группирует системы по `net_id`; `0`, пустая ячейка и
 *      отсутствие колонки — система вне сети (обратная совместимость).
 *   2. `bubbleFor` — мягкое объединение кругов вокруг систем сети: контур
 *      изолинии метаполя `Σ (r/d)^6 = 1`, то есть «лепестки с перемычкой»,
 *      а не выпуклая оболочка. Радиус лепестка — от ближайшего соседа внутри
 *      сети (сеть из одной системы — фиксированный радиус).
 *   3. `bubblePath` — перевод мирового контура в SVG/Canvas-путь кадра;
 *      на вход идут только числа, на выход — строка без `NaN`/`Infinity`.
 *   4. `colorStops` — ровно два стопа на границах диапазонов; при 3+ цветах
 *      берутся только ближайшие системы (правило владельца буквально).
 *   5. `bridgesBetween` — градиентная лента по кратчайшему расстоянию между
 *      баблами; `null`, если сети не соседние (критерий — `BRIDGE_GAP_FACTOR`).
 *   6. `flaresFor` — «всполохи» в сторону конфронтующей сети; число и
 *      направление детерминированы данными сети, без случайности.
 *   7. Слой живёт только на уровнях территорий `L2…L6` (`NET_LAYER_LEVELS`,
 *      тот же диапазон, что `TERRITORY_LEVELS` сцены, §8.1).
 *
 * Числа и их источник:
 *   — цвет фракции — та же устойчивая формула оттенка, что в `canvas-renderer.ts`
 *     (`§6.2 п. 4`): `hue = (hue * 31 + код символа) % 360`, поэтому бабл и
 *     территория одной фракции совпадают по цвету;
 *   — узел (белая окружность) — доля своего лепестка по типу системы:
 *     столица крупнее (`NODE_RADIUS_BY_TYPE`);
 *   — лента между сетями уже `BRIDGE_WIDTH_RATIO` от меньшего лепестка;
 *   — «всполохи» — не больше `MAX_FLARES_PER_NET` за кадр (защита бюджета).
 */

/* --------------------------------------------------------------- уровни слоя */

/**
 * Слой баблов активен только на уровнях территорий (`L2…L6`, §8.1) — тот же
 * диапазон, что `TERRITORY_LEVELS` в `sector-scene.ts`. Массив объявлен здесь
 * независимо (совпадение закреплено тестом `faction-net.test.mjs`): рантайм-импорт
 * сцены создал бы цикл, когда `Z-3.4` смонтирует слой сетей внутрь кадра.
 */
export const NET_LAYER_LEVELS: readonly number[] = Object.freeze([2, 3, 4, 5, 6]);

/** Живёт ли слой сетей на уровне лестницы (`L2…L6`). */
export function isNetLayerLevel(level: number): boolean {
  return NET_LAYER_LEVELS.includes(level);
}

/** Сети для кадра: на обзоре (`L0…L1`) и глубже `L6` слой не рисуется. */
export function netsAtLevel(
  nets: readonly FactionNet[],
  level: number,
): readonly FactionNet[] {
  return isNetLayerLevel(level) ? nets : [];
}

/* ------------------------------------------------------------------ константы */

/** Лепесток тянется к ближайшему соседу: `0,62 · d` даёт перемычку, а не точку. */
export const PETAL_FACTOR = 0.62;

/** Нижняя граница радиуса лепестка, единицы карты (≈ `0,09` св.г., §17.23). */
export const MIN_PETAL_RADIUS = 90;

/** Верхняя граница радиуса лепестка, единицы карты. */
export const MAX_PETAL_RADIUS = 420;

/** Радиус одиночной системы сети, единицы карты. */
export const SOLO_PETAL_RADIUS = 150;

/** Столица даёт чуть более крупный лепесток и заметно более крупный узел. */
export const CAPITAL_PETAL_SCALE = 1.18;

/** Изолиния метаполя: `Σ (r/d)^6 = 1` — мягкое слияние, без выпуклой оболочки. */
export const BUBBLE_FIELD_POWER = 6;

/** Разрешение сетки изолинии (ячеек на сторону квадратной области выборки). */
export const BUBBLE_GRID_CELLS = 64;

/**
 * Потолок разрешения: для сети, растянутой по сектору, сетка мельчает, чтобы
 * лепесток оставался круглым, но не больше 96 ячеек на сторону (бюджет кадра).
 */
export const MAX_GRID_CELLS = 96;

/** Целевая плотность: не меньше 8 ячеек на радиус самого крупного лепестка. */
export const GRID_CELLS_PER_RADIUS = 8;

/** Радиус белого узла — доля своего лепестка по типу системы. */
export const NODE_RADIUS_BY_TYPE: Readonly<Record<string, number>> = Object.freeze({
  capital: 0.34,
  standard: 0.24,
  unknown: 0.2,
});

/** Доля лепестка для типа, которого нет в таблице. */
export const NODE_RADIUS_DEFAULT = 0.24;

/**
 * Критерий соседства сетей для ленты: просвет между ближайшими кругами не
 * больше `1,6 · (rA + rB)`. Дальше ленты нет — сети не конфликтуют на карте.
 */
export const BRIDGE_GAP_FACTOR = 1.6;

/** Полуширина ленты как доля меньшего лепестка. */
export const BRIDGE_WIDTH_RATIO = 0.5;

/** Минимальная ширина ленты, единицы карты. */
export const BRIDGE_MIN_WIDTH = 24;

/** «Всполохов» от одной конфронтующей сети. */
export const MAX_FLARES_PER_RIVAL = 2;

/** Потолок «всполохов» на одну сеть за кадр. */
export const MAX_FLARES_PER_NET = 6;

/** Разброс направлений «всполохов» вокруг направления на конфронтующую сеть, рад. */
export const FLARE_SPREAD = 0.5;

/** Минимальная и максимальная длина «всполоха», единицы карты. */
export const MIN_FLARE_LENGTH = 24;
export const MAX_FLARE_LENGTH = 260;

/** Подпись фракции по умолчанию — та же, что в загрузчике данных. */
const NEUTRAL_FACTION = 'Фракции нет';

/* --------------------------------------------------------------- типы записей */

/** Строка данных о системе: принимает и `systems.csv`, и записи загрузчика. */
export interface NetSystemInput {
  readonly id?: string | number | null;
  /** Колонка `system_id` из `systems.csv`; `id` записи загрузчика важнее. */
  readonly system_id?: string | number | null;
  readonly name?: string | null;
  readonly x?: number | string | null;
  readonly y?: number | string | null;
  readonly faction?: string | null;
  readonly type?: string | null;
  readonly systemType?: string | null;
  readonly net_id?: number | string | null;
  readonly netId?: number | string | null;
}

/** Нормализованная система внутри сети. */
export interface NetSystem {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly faction: string | null;
  readonly systemType: string;
  readonly netId: number;
}

/** Сеть: системы с одинаковым `net_id > 0`. */
export interface FactionNet {
  readonly netId: number;
  readonly members: readonly NetSystem[];
  readonly factions: readonly string[];
  readonly centerX: number;
  readonly centerY: number;
}

/** Точка в координатах карты (`0…10 000`, §10.3). */
export interface NetPoint {
  readonly x: number;
  readonly y: number;
}

/** Лепесток бабла: круг вокруг системы сети (мировые единицы). */
export interface BubblePetal {
  readonly systemId: string;
  readonly name: string;
  readonly faction: string | null;
  readonly systemType: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Белый узел внутри бабла: радиус — доля лепестка по типу системы. */
export interface BubbleNode {
  readonly systemId: string;
  readonly systemType: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Прямоугольник бабла в мировых единицах. */
export interface BubbleBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Стоп градиента цвета фракции. */
export interface ColorStop {
  /** `0` или `1`: цвет фракции строго на границе своего диапазона. */
  readonly offset: number;
  readonly faction: string;
  readonly systemId: string;
  readonly rgb: readonly [number, number, number];
  /** Готовая строка для SVG/Canvas: `rgb(r, g, b)`. */
  readonly color: string;
}

/** Бабл сети: лепестки, узлы, контур и градиент. */
export interface Bubble {
  readonly netId: number;
  readonly petals: readonly BubblePetal[];
  readonly nodes: readonly BubbleNode[];
  readonly centerX: number;
  readonly centerY: number;
  /** Замкнутые контуры изолинии в мировых координатах (обычно один). */
  readonly rings: readonly (readonly NetPoint[])[];
  readonly bounds: BubbleBounds;
  readonly stops: readonly ColorStop[];
}

export interface BubbleOptions {
  readonly netId?: number;
  readonly petalFactor?: number;
  readonly minPetalRadius?: number;
  readonly maxPetalRadius?: number;
  readonly soloPetalRadius?: number;
  readonly capitalPetalScale?: number;
  readonly gridCells?: number;
  readonly fieldPower?: number;
  /** Сглаживание контура (по умолчанию включено). */
  readonly smooth?: boolean;
}

/** Камера сектора: структурно совпадает с `SceneCamera` из `sector-scene.ts`. */
export interface NetCamera {
  readonly centerX: number;
  readonly centerY: number;
  readonly visibleWidth: number;
}

/** Кадр: структурно совпадает с `FrameViewport` из `level-ladder.ts`. */
export interface NetViewport {
  readonly w: number;
  readonly h: number;
}

/** Конец ленты на границе лепестка. */
export interface BridgeAnchor {
  readonly netId: number;
  readonly systemId: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Лента между двумя соседними сетями: градиент цвета A → цвета B. */
export interface Bridge {
  readonly from: BridgeAnchor;
  readonly to: BridgeAnchor;
  /** Расстояние между центрами ближайших систем, мировые единицы. */
  readonly gap: number;
  /** Видимая длина ленты (`gap − rA − rB`, не меньше нуля). */
  readonly length: number;
  readonly width: number;
  /** Четыре угла ленты в мировых координатах: A+, B+, B−, A−. */
  readonly quad: readonly [NetPoint, NetPoint, NetPoint, NetPoint];
  readonly stops: readonly ColorStop[];
}

/** «Всполох» в сторону конфронтующей сети. */
export interface Flare {
  readonly netId: number;
  readonly targetNetId: number;
  readonly originX: number;
  readonly originY: number;
  /** Радианы, мировые координаты (`0` — вправо, ось `y` вниз, как на карте). */
  readonly angle: number;
  readonly length: number;
  readonly width: number;
  /** `0…1`: чем ближе конфронтация, тем ярче импульс. */
  readonly intensity: number;
}

export interface FlareOptions {
  readonly limit?: number;
}

/* ------------------------------------------------------------- малые утилиты */

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `net_id` → номер сети. Пусто, `0`, отрицательные, дробные и нечисловые
 * значения — система вне сети (правило «0 или пустота — отсутствие в сети»).
 */
export function parseNetId(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric === null) return null;
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizedSystemType(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === '' || text === 'none' || text === 'standard' || text === 'system') return 'standard';
  if (text === 'unknown' || text === 'unknow') return 'unknown';
  return text;
}

/** Идентификатор системы: `id` записи загрузчика, иначе колонка `system_id`. */
function idOf(raw: NetSystemInput): string {
  for (const candidate of [raw.id, raw.system_id]) {
    if (candidate === null || candidate === undefined) continue;
    const text = String(candidate).trim();
    if (text !== '') return text;
  }
  return '';
}

function factionNameOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? NEUTRAL_FACTION : text;
}

/** Идентификаторы сравниваются как числа, если оба числовые: `2` раньше `11`. */
function compareIds(a: string, b: string): number {
  const numericA = Number(a);
  const numericB = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(numericA) && Number.isFinite(numericB)) {
    if (numericA !== numericB) return numericA - numericB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function requirePositive(value: number | undefined, fallback: number, what: string): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result <= 0) {
    throw new RangeError(`${what} должен быть положительным числом: ${String(value)}`);
  }
  return result;
}

function requireInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  what: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum) {
    throw new RangeError(`${what} должен быть целым числом ≥ ${minimum}: ${String(value)}`);
  }
  return result;
}

/* -------------------------------------------------------------------- сети */

function toNetSystem(raw: NetSystemInput): NetSystem | null {
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const netId = parseNetId(raw.net_id) ?? parseNetId(raw.netId);
  const id = idOf(raw);
  if (x === null || y === null || netId === null || id === '') return null;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id;
  const faction = typeof raw.faction === 'string' && raw.faction.trim() !== '' ? raw.faction.trim() : null;
  const systemType = normalizedSystemType(raw.type ?? raw.systemType);
  return { id, name, x, y, faction, systemType, netId };
}

/**
 * Группировка систем по `net_id > 0`. Внутри сети порядок детерминирован
 * (идентификатор как число, затем как строка), сети — по возрастанию `net_id`.
 * Системы без координат, без идентификатора и с `net_id` `0`/пусто в сети не попадают.
 */
export function parseNetworks(systems: readonly NetSystemInput[]): readonly FactionNet[] {
  const groups = new Map<number, NetSystem[]>();
  for (const raw of systems ?? []) {
    const member = toNetSystem(raw);
    if (member === null) continue;
    const bucket = groups.get(member.netId);
    if (bucket === undefined) groups.set(member.netId, [member]);
    else bucket.push(member);
  }

  const nets: FactionNet[] = [];
  for (const [netId, bucket] of groups) {
    bucket.sort((a, b) => compareIds(a.id, b.id));
    const factions: string[] = [];
    for (const member of bucket) {
      if (member.faction !== null && !factions.includes(member.faction)) {
        factions.push(member.faction);
      }
    }
    nets.push({
      netId,
      members: bucket,
      factions,
      centerX: mean(bucket.map((member) => member.x)),
      centerY: mean(bucket.map((member) => member.y)),
    });
  }

  return nets.sort((a, b) => a.netId - b.netId);
}

/* ------------------------------------------------------------------- цвета */

/**
 * Устойчивый оттенок фракции: та же формула, что `factionHue` в
 * `canvas-renderer.ts` (`§6.2 п. 4`) — цвет не зависит от глубины и запуска.
 */
export function factionHue(faction: string): number {
  let hash = 0;
  for (let index = 0; index < faction.length; index += 1) {
    hash = (hash * 31 + faction.charCodeAt(index)) % 360;
  }
  return hash;
}

function channelToByte(value: number): number {
  return Math.round(clamp(value, 0, 1) * 255);
}

function hueToChannel(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

/** Цвет фракции в RGB: `hsl(hue, 68 %, 62 %)`, как заливка территории. */
export function factionRgb(faction: string): readonly [number, number, number] {
  const hue = ((factionHue(faction) % 360) + 360) % 360 / 360;
  const saturation = 0.68;
  const lightness = 0.62;
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  return [
    channelToByte(hueToChannel(p, q, hue + 1 / 3)),
    channelToByte(hueToChannel(p, q, hue)),
    channelToByte(hueToChannel(p, q, hue - 1 / 3)),
  ];
}

interface ColorPoint {
  readonly id: string;
  readonly faction: string;
  readonly x: number;
  readonly y: number;
}

function toColorPoints(members: readonly NetSystemInput[]): ColorPoint[] {
  const points: ColorPoint[] = [];
  let index = 0;
  for (const raw of members ?? []) {
    const x = finiteNumber(raw.x);
    const y = finiteNumber(raw.y);
    if (x === null || y === null) continue;
    const rawId = idOf(raw);
    const id = rawId === '' ? `#${index}` : rawId;
    points.push({ id, faction: factionNameOf(raw.faction), x, y });
    index += 1;
  }
  return points;
}

function colorStopAt(offset: number, point: ColorPoint): ColorStop {
  const rgb = factionRgb(point.faction);
  return {
    offset,
    faction: point.faction,
    systemId: point.id,
    rgb,
    color: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
  };
}

/**
 * Ближайшая пара систем с разными фракциями. Вход уже отсортирован по
 * идентификатору, поэтому при равных расстояниях побеждает первая найденная
 * пара — то есть меньший `id` и его ближайший сосед: результат не зависит
 * от порядка строк CSV.
 */
function nearestDistinctPair(points: readonly ColorPoint[]): readonly [ColorPoint, ColorPoint] {
  let bestA = points[0]!;
  let bestB = points[1] ?? points[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let first = 0; first < points.length; first += 1) {
    const a = points[first]!;
    for (let second = first + 1; second < points.length; second += 1) {
      const b = points[second]!;
      if (a.faction === b.faction) continue;
      const distance = Math.hypot(b.x - a.x, b.y - a.y);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        bestA = a;
        bestB = b;
      }
    }
  }
  return [bestA, bestB];
}

/**
 * Градиент сети: ровно два стопа на границах диапазонов (`0` и `1`).
 *
 * Правило одно для любого числа фракций: берётся ближайшая пара систем с
 * разными фракциями — при двух фракциях это и есть их цвета, при трёх и более
 * в градиент попадают только ближайшие системы (правило владельца:
 * «пересечение на большем кол-ве цветов — только с ближайшими системами»).
 * Одна фракция — оба стопа одного цвета.
 *
 * Стоп `0` — участник пары с меньшим `id`, поэтому градиент не зависит от
 * порядка строк CSV; направление вдоль бабла выбирает рендерер (`Z-3.4`).
 */
export function colorStops(members: readonly NetSystemInput[]): readonly ColorStop[] {
  const points = toColorPoints(members).sort((a, b) => compareIds(a.id, b.id));
  if (points.length === 0) return [];

  const factions: string[] = [];
  for (const point of points) {
    if (!factions.includes(point.faction)) factions.push(point.faction);
  }
  if (factions.length === 1) {
    const only = points[0]!;
    return [colorStopAt(0, only), colorStopAt(1, only)];
  }

  const [nearestA, nearestB] = nearestDistinctPair(points);
  const [first, second] = compareIds(nearestA.id, nearestB.id) <= 0
    ? [nearestA, nearestB]
    : [nearestB, nearestA];
  return [colorStopAt(0, first), colorStopAt(1, second)];
}

/** Линейная интерполяция между стопами: канал меняется монотонно. */
export function sampleGradient(
  stops: readonly ColorStop[],
  t: number,
): readonly [number, number, number] {
  if (stops.length === 0) return [0, 0, 0];
  const first = stops[0]!;
  if (stops.length === 1) return first.rgb;
  const clamped = Number.isFinite(t) ? clamp(t, 0, 1) : 0;

  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1]!;
    const next = stops[index]!;
    if (clamped <= next.offset) {
      const span = next.offset - previous.offset;
      const local = span <= 0 ? 1 : (clamped - previous.offset) / span;
      const mix = (a: number, b: number): number => Math.round(a + (b - a) * local);
      return [
        mix(previous.rgb[0], next.rgb[0]),
        mix(previous.rgb[1], next.rgb[1]),
        mix(previous.rgb[2], next.rgb[2]),
      ];
    }
  }

  return stops[stops.length - 1]!.rgb;
}

/* ---------------------------------------------------------------- геометрия */

interface BubblePoint {
  readonly id: string;
  readonly name: string;
  readonly faction: string | null;
  readonly systemType: string;
  readonly x: number;
  readonly y: number;
}

interface ResolvedBubbleOptions {
  readonly petalFactor: number;
  readonly minPetalRadius: number;
  readonly maxPetalRadius: number;
  readonly soloPetalRadius: number;
  readonly capitalPetalScale: number;
  readonly gridCells: number;
  readonly fieldPower: number;
  readonly smooth: boolean;
}

function resolveBubbleOptions(options: BubbleOptions = {}): ResolvedBubbleOptions {
  const minPetalRadius = requirePositive(options.minPetalRadius, MIN_PETAL_RADIUS, 'minPetalRadius');
  const maxPetalRadius = requirePositive(options.maxPetalRadius, MAX_PETAL_RADIUS, 'maxPetalRadius');
  if (maxPetalRadius < minPetalRadius) {
    throw new RangeError('maxPetalRadius не может быть меньше minPetalRadius');
  }
  return {
    petalFactor: requirePositive(options.petalFactor, PETAL_FACTOR, 'petalFactor'),
    minPetalRadius,
    maxPetalRadius,
    soloPetalRadius: requirePositive(options.soloPetalRadius, SOLO_PETAL_RADIUS, 'soloPetalRadius'),
    capitalPetalScale: requirePositive(options.capitalPetalScale, CAPITAL_PETAL_SCALE, 'capitalPetalScale'),
    gridCells: requireInteger(options.gridCells, BUBBLE_GRID_CELLS, 8, 'gridCells'),
    fieldPower: requirePositive(options.fieldPower, BUBBLE_FIELD_POWER, 'fieldPower'),
    smooth: options.smooth !== false,
  };
}

function petalRadii(points: readonly BubblePoint[], options: ResolvedBubbleOptions): number[] {
  const radii: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    let nearest = Number.POSITIVE_INFINITY;
    for (let other = 0; other < points.length; other += 1) {
      if (other === index) continue;
      const candidate = points[other]!;
      nearest = Math.min(nearest, Math.hypot(candidate.x - point.x, candidate.y - point.y));
    }
    const base = Number.isFinite(nearest)
      ? clamp(nearest * options.petalFactor, options.minPetalRadius, options.maxPetalRadius)
      : options.soloPetalRadius;
    const scale = point.systemType === 'capital' ? options.capitalPetalScale : 1;
    // Верхняя граница умножается на бонус столицы: «столица крупнее» держится
    // даже на крупнейшей сети.
    radii.push(Math.min(options.maxPetalRadius * options.capitalPetalScale, Math.max(options.minPetalRadius, base * scale)));
  }
  return radii;
}

/**
 * Поле метаполя: `Σ (r/d)^power`; изолиния `= 1` и есть контур бабла.
 * Для показателя `6` (значение по умолчанию) считается как `r⁶ / (d²)³`
 * без `Math.pow` — сетка поля проходит по тысячам точек на каждый бабл.
 */
function metaballField(
  x: number,
  y: number,
  points: readonly BubblePoint[],
  radii: readonly number[],
  power: number,
  sixthPowers: readonly number[] | null,
): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const dx = x - point.x;
    const dy = y - point.y;
    const distanceSquared = dx * dx + dy * dy;
    if (distanceSquared < 1e-9) return Number.MAX_VALUE;
    if (sixthPowers !== null) {
      total += sixthPowers[index]! / (distanceSquared * distanceSquared * distanceSquared);
    } else {
      const radius = radii[index]!;
      total += Math.pow((radius * radius) / distanceSquared, power / 2);
    }
    if (total > 1e12) return total;
  }
  return total;
}

interface BubbleSegment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

function pointKey(x: number, y: number): string {
  return `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
}

function interpolateEdge(
  x1: number,
  y1: number,
  v1: number,
  x2: number,
  y2: number,
  v2: number,
): NetPoint {
  const delta = v2 - v1;
  const raw = delta === 0 ? 0.5 : (1 - v1) / delta;
  const t = clamp(raw, 0, 1);
  return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t };
}

/** Склейка отрезков изолинии в замкнутые кольца; порядок детерминирован. */
function chainRings(segments: readonly BubbleSegment[]): NetPoint[][] {
  const adjacency = new Map<string, number[]>();
  const register = (key: string, index: number): void => {
    const list = adjacency.get(key);
    if (list === undefined) adjacency.set(key, [index]);
    else list.push(index);
  };
  segments.forEach((segment, index) => {
    register(pointKey(segment.ax, segment.ay), index);
    register(pointKey(segment.bx, segment.by), index);
  });

  const used = new Uint8Array(segments.length);
  const rings: Array<{ readonly points: NetPoint[]; readonly size: number }> = [];

  for (let start = 0; start < segments.length; start += 1) {
    if (used[start] === 1) continue;
    const first = segments[start]!;
    used[start] = 1;
    const points: NetPoint[] = [{ x: first.ax, y: first.ay }, { x: first.bx, y: first.by }];
    const startKey = pointKey(first.ax, first.ay);
    let currentKey = pointKey(first.bx, first.by);
    let closed = false;

    for (let guard = 0; guard <= segments.length; guard += 1) {
      if (currentKey === startKey) {
        closed = true;
        break;
      }
      const candidates = adjacency.get(currentKey) ?? [];
      let next = -1;
      for (const index of candidates) {
        if (used[index] === 0) {
          next = index;
          break;
        }
      }
      if (next === -1) break;
      used[next] = 1;
      const segment = segments[next]!;
      const forward = pointKey(segment.ax, segment.ay) === currentKey;
      const point: NetPoint = forward
        ? { x: segment.bx, y: segment.by }
        : { x: segment.ax, y: segment.ay };
      points.push(point);
      currentKey = pointKey(point.x, point.y);
    }

    if (closed && points.length >= 4) {
      const last = points[points.length - 1]!;
      if (pointKey(last.x, last.y) === startKey) points.pop();
      if (points.length >= 3) rings.push({ points, size: points.length });
    }
  }

  rings.sort((a, b) => b.size - a.size
    || a.points[0]!.x - b.points[0]!.x
    || a.points[0]!.y - b.points[0]!.y);
  return rings.map((ring) => ring.points);
}

/** Один проход Чайкина: угловатая ломаная сетки становится мягким контуром. */
function smoothRing(points: readonly NetPoint[]): NetPoint[] {
  if (points.length < 3) return points.slice();
  const result: NetPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    result.push({
      x: current.x * 0.75 + next.x * 0.25,
      y: current.y * 0.75 + next.y * 0.25,
    });
    result.push({
      x: current.x * 0.25 + next.x * 0.75,
      y: current.y * 0.25 + next.y * 0.75,
    });
  }
  return result;
}

function boundsOfPoints(points: readonly NetPoint[]): BubbleBounds | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Контур бабла: марширующие квадраты по изолинии метаполя. */
function buildRings(
  points: readonly BubblePoint[],
  radii: readonly number[],
  options: ResolvedBubbleOptions,
): NetPoint[][] {
  const maxRadius = Math.max(...radii);
  let pad = Math.max(maxRadius * 0.6, 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]!;
      const radius = radii[index]!;
      minX = Math.min(minX, point.x - radius);
      minY = Math.min(minY, point.y - radius);
      maxX = Math.max(maxX, point.x + radius);
      maxY = Math.max(maxY, point.y + radius);
    }
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;

    const side = Math.max(maxX - minX, maxY - minY, 1e-6);
    const originX = (minX + maxX) / 2 - side / 2;
    const originY = (minY + maxY) / 2 - side / 2;
    // Плотность сетки подстраивается под разброс сети: локальный кластер
    // считается базовым разрешением, растянутая сеть — мельче (до потолка),
    // иначе лепесток на карте превращается в многоугольник.
    const cells = clamp(
      Math.ceil(side / (maxRadius / GRID_CELLS_PER_RADIUS)),
      options.gridCells,
      MAX_GRID_CELLS,
    );
    const cellSize = side / cells;
    const stride = cells + 1;
    const values = new Float64Array(stride * stride);
    const sixthPowers = options.fieldPower === 6
      ? radii.map((radius) => radius ** 6)
      : null;
    for (let row = 0; row <= cells; row += 1) {
      const sampleY = originY + row * cellSize;
      for (let column = 0; column <= cells; column += 1) {
        values[row * stride + column] = metaballField(
          originX + column * cellSize,
          sampleY,
          points,
          radii,
          options.fieldPower,
          sixthPowers,
        );
      }
    }

    let borderInside = false;
    for (let index = 0; index < stride; index += 1) {
      if (
        values[index]! >= 1
        || values[cells * stride + index]! >= 1
        || values[index * stride]! >= 1
        || values[index * stride + cells]! >= 1
      ) {
        borderInside = true;
        break;
      }
    }
    if (borderInside) {
      pad *= 2;
      continue;
    }

    const segments: BubbleSegment[] = [];
    for (let row = 0; row < cells; row += 1) {
      for (let column = 0; column < cells; column += 1) {
        const va = values[row * stride + column]!;
        const vb = values[row * stride + column + 1]!;
        const vc = values[(row + 1) * stride + column + 1]!;
        const vd = values[(row + 1) * stride + column]!;
        const mask = (va >= 1 ? 1 : 0)
          | (vb >= 1 ? 2 : 0)
          | (vc >= 1 ? 4 : 0)
          | (vd >= 1 ? 8 : 0);
        if (mask === 0 || mask === 15) continue;

        const x0 = originX + column * cellSize;
        const x1 = x0 + cellSize;
        const y0 = originY + row * cellSize;
        const y1 = y0 + cellSize;
        const bottom = interpolateEdge(x0, y0, va, x1, y0, vb);
        const right = interpolateEdge(x1, y0, vb, x1, y1, vc);
        const top = interpolateEdge(x1, y1, vc, x0, y1, vd);
        const left = interpolateEdge(x0, y1, vd, x0, y0, va);

        const push = (a: NetPoint, b: NetPoint): void => {
          segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
        };

        switch (mask) {
          case 1:
          case 14:
            push(left, bottom);
            break;
          case 2:
          case 13:
            push(bottom, right);
            break;
          case 3:
          case 12:
            push(left, right);
            break;
          case 4:
          case 11:
            push(right, top);
            break;
          case 5:
          case 10: {
            const centerInside = metaballField(
              (x0 + x1) / 2,
              (y0 + y1) / 2,
              points,
              radii,
              options.fieldPower,
              sixthPowers,
            ) >= 1;
            if (mask === 5) {
              if (centerInside) {
                push(left, top);
                push(bottom, right);
              } else {
                push(left, bottom);
                push(right, top);
              }
            } else if (centerInside) {
              push(left, bottom);
              push(right, top);
            } else {
              push(left, top);
              push(bottom, right);
            }
            break;
          }
          case 6:
          case 9:
            push(bottom, top);
            break;
          case 7:
          case 8:
            push(left, top);
            break;
          case 15:
            break;
          default:
            break;
        }
      }
    }

    const rings = chainRings(segments);
    return options.smooth ? rings.map((ring) => smoothRing(ring)) : rings;
  }

  return [];
}

function toBubblePoint(raw: NetSystemInput, index: number): BubblePoint | null {
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  if (x === null || y === null) return null;
  const rawId = idOf(raw);
  const id = rawId === '' ? `#${index}` : rawId;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id;
  const faction = typeof raw.faction === 'string' && raw.faction.trim() !== '' ? raw.faction.trim() : null;
  return {
    id,
    name,
    faction,
    systemType: normalizedSystemType(raw.type ?? raw.systemType),
    x,
    y,
  };
}

function nodeRadiusFactor(systemType: string): number {
  return NODE_RADIUS_BY_TYPE[systemType] ?? NODE_RADIUS_DEFAULT;
}

/**
 * Бабл сети: мягкое объединение кругов вокруг систем одной сети.
 * Порядок участников сортируется по идентификатору, поэтому бабл не зависит
 * от порядка строк CSV — два вызова дают идентичный путь побайтово.
 */
export function bubbleFor(
  members: readonly NetSystemInput[],
  options: BubbleOptions = {},
): Bubble {
  const resolved = resolveBubbleOptions(options);
  const points: BubblePoint[] = [];
  for (const raw of members ?? []) {
    const point = toBubblePoint(raw, points.length);
    if (point !== null) points.push(point);
  }
  if (points.length === 0) {
    throw new RangeError('bubbleFor: у сети нет ни одной системы с координатами');
  }
  points.sort((a, b) => compareIds(a.id, b.id));

  let detectedNetId: number | null = null;
  for (const raw of members ?? []) {
    const candidate = parseNetId(raw.net_id) ?? parseNetId(raw.netId);
    if (candidate !== null) {
      detectedNetId = candidate;
      break;
    }
  }
  const netId = options.netId ?? detectedNetId ?? 0;

  const radii = petalRadii(points, resolved);
  const petals: BubblePetal[] = points.map((point, index) => ({
    systemId: point.id,
    name: point.name,
    faction: point.faction,
    systemType: point.systemType,
    x: point.x,
    y: point.y,
    radius: radii[index]!,
  }));
  const nodes: BubbleNode[] = points.map((point, index) => ({
    systemId: point.id,
    systemType: point.systemType,
    x: point.x,
    y: point.y,
    radius: radii[index]! * nodeRadiusFactor(point.systemType),
  }));

  const rings = buildRings(points, radii, resolved);
  const ringBounds = boundsOfPoints(rings.flat());
  const bounds = ringBounds ?? boundsOfPoints(petals.map((petal) => ({ x: petal.x, y: petal.y })))
    ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  return {
    netId,
    petals,
    nodes,
    centerX: mean(points.map((point) => point.x)),
    centerY: mean(points.map((point) => point.y)),
    rings,
    bounds,
    stops: colorStops(points),
  };
}

/* -------------------------------------------------------------------- путь */

function requireMeasure(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${what} должен быть положительным числом: ${String(value)}`);
  }
  return value;
}

function requireViewport(viewport: NetViewport): NetViewport {
  if (viewport === null || viewport === undefined) {
    throw new RangeError('Кадр должен быть объектом { w, h }');
  }
  return {
    w: requireMeasure(viewport.w, 'Ширина кадра (viewport.w)'),
    h: requireMeasure(viewport.h, 'Высота кадра (viewport.h)'),
  };
}

function requireCamera(camera: NetCamera): NetCamera {
  if (camera === null || camera === undefined) {
    throw new RangeError('Камера должна быть объектом { centerX, centerY, visibleWidth }');
  }
  if (!Number.isFinite(camera.centerX) || !Number.isFinite(camera.centerY)) {
    throw new RangeError('Центр камеры должен быть парой конечных чисел');
  }
  return {
    centerX: camera.centerX,
    centerY: camera.centerY,
    visibleWidth: requireMeasure(camera.visibleWidth, 'Видимая ширина (visibleWidth)'),
  };
}

/** Число пути: два знака, без хвостовых нулей, без `-0` и экспоненты. */
function pathNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Координата пути должна быть конечным числом: ${String(value)}`);
  }
  const rounded = Math.round(value * 100) / 100;
  const fixed = (rounded === 0 ? 0 : rounded).toFixed(2);
  if (fixed.endsWith('.00')) return fixed.slice(0, -3);
  if (fixed.endsWith('0')) return fixed.slice(0, -1);
  return fixed;
}

/**
 * SVG/Canvas-путь бабла в пикселях кадра. `camera` и `viewport` те же по смыслу,
 * что у сцены сектора (`SceneCamera` / `FrameViewport`), поэтому масштаб
 * совпадает с маркерами и территориями.
 */
export function bubblePath(
  bubble: Bubble,
  camera: NetCamera,
  viewport: NetViewport,
): string {
  const frame = requireViewport(viewport);
  const cam = requireCamera(camera);
  if (bubble === null || bubble === undefined || bubble.rings.length === 0) {
    return '';
  }
  const scale = Math.min(frame.w, frame.h) / cam.visibleWidth;
  const halfWidth = frame.w / 2;
  const halfHeight = frame.h / 2;

  const parts: string[] = [];
  for (const ring of bubble.rings) {
    if (ring.length < 3) continue;
    const commands: string[] = [];
    for (let index = 0; index < ring.length; index += 1) {
      const point = ring[index]!;
      const screenX = halfWidth + (point.x - cam.centerX) * scale;
      const screenY = halfHeight + (point.y - cam.centerY) * scale;
      commands.push(`${index === 0 ? 'M' : 'L'}${pathNumber(screenX)} ${pathNumber(screenY)}`);
    }
    parts.push(`${commands.join('')}Z`);
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------ лента */

interface NetGeometry {
  readonly points: readonly BubblePoint[];
  readonly radii: readonly number[];
}

function geometryOf(net: FactionNet, options: ResolvedBubbleOptions): NetGeometry {
  const points: BubblePoint[] = net.members.map((member) => ({
    id: member.id,
    name: member.name,
    faction: member.faction,
    systemType: member.systemType,
    x: member.x,
    y: member.y,
  }));
  return { points, radii: petalRadii(points, options) };
}

function primaryColorPoint(net: FactionNet): ColorPoint {
  for (const member of net.members) {
    if (member.faction !== null) {
      return { id: member.id, faction: member.faction, x: member.x, y: member.y };
    }
  }
  const first = net.members[0];
  return {
    id: first?.id ?? `net-${net.netId}`,
    faction: NEUTRAL_FACTION,
    x: first?.x ?? net.centerX,
    y: first?.y ?? net.centerY,
  };
}

/**
 * Лента между двумя сетями по кратчайшему расстоянию.
 *
 * Критерий соседства (зафиксирован здесь): сети соседние, если просвет между
 * ближайшими лепестками не больше `BRIDGE_GAP_FACTOR · (rA + rB)`. Дальше
 * `null`: лента не тянется через полсектора. Одна и та же сеть — тоже `null`.
 */
export function bridgesBetween(
  netA: FactionNet,
  netB: FactionNet,
  options: BubbleOptions = {},
): Bridge | null {
  if (!netA || !netB || netA.netId === netB.netId) return null;
  if (netA.members.length === 0 || netB.members.length === 0) return null;

  const resolved = resolveBubbleOptions(options);
  const geometryA = geometryOf(netA, resolved);
  const geometryB = geometryOf(netB, resolved);

  let bestA = -1;
  let bestB = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let indexA = 0; indexA < geometryA.points.length; indexA += 1) {
    const pointA = geometryA.points[indexA]!;
    for (let indexB = 0; indexB < geometryB.points.length; indexB += 1) {
      const pointB = geometryB.points[indexB]!;
      const distance = Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestA = indexA;
        bestB = indexB;
      }
    }
  }
  if (bestA < 0 || bestB < 0) return null;

  const pointA = geometryA.points[bestA]!;
  const pointB = geometryB.points[bestB]!;
  const radiusA = geometryA.radii[bestA]!;
  const radiusB = geometryB.radii[bestB]!;
  if (bestDistance > BRIDGE_GAP_FACTOR * (radiusA + radiusB)) return null;

  const distance = Math.max(bestDistance, 1e-9);
  const ux = (pointB.x - pointA.x) / distance;
  const uy = (pointB.y - pointA.y) / distance;
  // Перекрытие лепестков — вырожденная, но всё же лента: концы садятся в центры
  // ближайших систем, полотно уходит под заливку баблов, длина при этом ноль.
  const overlap = bestDistance <= radiusA + radiusB;
  const fromX = overlap ? pointA.x : pointA.x + ux * radiusA;
  const fromY = overlap ? pointA.y : pointA.y + uy * radiusA;
  const toX = overlap ? pointB.x : pointB.x - ux * radiusB;
  const toY = overlap ? pointB.y : pointB.y - uy * radiusB;
  const length = Math.max(0, bestDistance - radiusA - radiusB);

  const width = Math.max(BRIDGE_MIN_WIDTH, BRIDGE_WIDTH_RATIO * Math.min(radiusA, radiusB));
  const half = width / 2;
  const normalX = -uy;
  const normalY = ux;

  return {
    from: { netId: netA.netId, systemId: pointA.id, x: fromX, y: fromY, radius: radiusA },
    to: { netId: netB.netId, systemId: pointB.id, x: toX, y: toY, radius: radiusB },
    gap: bestDistance,
    length,
    width,
    quad: [
      { x: fromX + normalX * half, y: fromY + normalY * half },
      { x: toX + normalX * half, y: toY + normalY * half },
      { x: toX - normalX * half, y: toY - normalY * half },
      { x: fromX - normalX * half, y: fromY - normalY * half },
    ],
    stops: [colorStopAt(0, primaryColorPoint(netA)), colorStopAt(1, primaryColorPoint(netB))],
  };
}

/* --------------------------------------------------------------- всполохи */

/** FNV-1a по десятичным записям чисел: детерминированный «шум» без `Math.random`. */
function flareSeed(netId: number, rivalId: number, index: number): number {
  let hash = 2166136261;
  for (const value of [netId, rivalId, index]) {
    const text = String(Math.trunc(value));
    for (let position = 0; position < text.length; position += 1) {
      hash ^= text.charCodeAt(position);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return hash >>> 0;
}

function flareLimit(value: number | undefined): number {
  if (value === undefined) return MAX_FLARES_PER_NET;
  if (!Number.isInteger(value) || value < 0 || value > MAX_FLARES_PER_NET) {
    throw new RangeError(
      `limit «всполохов» должен быть целым в диапазоне 0…${MAX_FLARES_PER_NET}: ${String(value)}`,
    );
  }
  return value;
}

/**
 * «Всполохи» сети в сторону конфронтующих сетей.
 *
 * Конфронтация — соседство по критерию `bridgesBetween` (иначе сеть просто
 * не видна рядом). Число импульсов на соседа и разброс направления берутся из
 * детерминированного хеша `(net_id, rival_id, индекс)` — без `Math.random`
 * и без `Date.now`; суммарно не больше `MAX_FLARES_PER_NET`.
 */
export function flaresFor(
  net: FactionNet,
  rivals: readonly FactionNet[],
  options: FlareOptions = {},
): readonly Flare[] {
  const limit = flareLimit(options.limit);
  if (!net || limit === 0) return [];
  const ordered = (rivals ?? [])
    .filter((rival) => rival && rival.netId !== net.netId)
    .slice()
    .sort((a, b) => a.netId - b.netId);

  const flares: Flare[] = [];
  for (const rival of ordered) {
    if (flares.length >= limit) break;
    const bridge = bridgesBetween(net, rival);
    if (bridge === null) continue;

    const spanX = rival.centerX - net.centerX;
    const spanY = rival.centerY - net.centerY;
    const span = Math.hypot(spanX, spanY);
    const baseAngle = span > 1e-9
      ? Math.atan2(spanY, spanX)
      : Math.atan2(bridge.to.y - bridge.from.y, bridge.to.x - bridge.from.x);
    const count = 1 + (flareSeed(net.netId, rival.netId, 0) % MAX_FLARES_PER_RIVAL);
    const intensity = clamp(1 / (1 + bridge.gap / 400), 0, 1);
    const length = clamp(bridge.gap * 0.45, MIN_FLARE_LENGTH, MAX_FLARE_LENGTH);
    const width = Math.max(2, bridge.width * 0.3);

    for (let index = 0; index < count && flares.length < limit; index += 1) {
      const jitter = ((flareSeed(net.netId, rival.netId, index + 1) % 1001) / 1000 - 0.5);
      flares.push({
        netId: net.netId,
        targetNetId: rival.netId,
        originX: bridge.from.x,
        originY: bridge.from.y,
        angle: baseAngle + jitter * FLARE_SPREAD,
        length,
        width,
        intensity,
      });
    }
  }

  return flares.sort((a, b) => a.targetNetId - b.targetNetId || a.angle - b.angle);
}
