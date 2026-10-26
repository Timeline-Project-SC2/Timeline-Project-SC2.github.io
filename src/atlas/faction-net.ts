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
 *   7. Слой живёт на уровнях территорий `L2…L12` (§8.1); диапазон задаёт
 *      `layerFillAlpha` / `layerLineAlpha` из `level-ladder.ts` (`Z-3.9`).
 *   8. `channelsFor` — каналы между сетями из колонки `net_confront_id`
 *      (карточка `Z-3.8`): узкая лента «свой-чужой» между двумя системами,
 *      идёт поверх баблов и сквозь них, в генерации баблов не участвует.
 *
 * Числа и их источник:
 *   — цвет фракции — данные таблицы `data/factions.csv` (карточка Z-3.7):
 *     модуль получает резолвер цвета снаружи (загрузчик данных) и сам оттенки
 *     из имени не вычисляет, поэтому бабл и территория одной фракции
 *     совпадают по табличному цвету;
 *   — узел (белая окружность) — доля своего лепестка по типу системы:
 *     столица крупнее (`NODE_RADIUS_BY_TYPE`);
 *   — лента между сетями уже `BRIDGE_WIDTH_RATIO` от меньшего лепестка;
 *   — канал между сетями (`Z-3.8`) вдвое уже ленты: `CHANNEL_WIDTH_RATIO =
 *     BRIDGE_WIDTH_RATIO · 0,5` от меньшего лепестка, яркость одна на все
 *     каналы (`CHANNEL_BRIGHTNESS`), а цвет — градиент табличных цветов фракций
 *     двух концов: номер канала на цвет не влияет;
 *   — «всполохи» — не больше `MAX_FLARES_PER_NET` за кадр (защита бюджета).
 */

import { NEUTRAL_FACTION_LABEL, parseHexColor } from './config.ts';
import { layerFillAlpha } from './level-ladder.ts';
import type { FactionColor } from './config.ts';

/* --------------------------------------------------------------- уровни слоя */

/** Диапазон слоя сетей (`L2…L12`, §8.1) выводится из лестницы `level-ladder.ts`. */
/** Живёт ли слой сетей на уровне лестницы (`L2…L12`). */
export function isNetLayerLevel(level: number): boolean {
  return layerFillAlpha(level) > 0;
}

/** Сети для кадра: на обзоре (`L0…L1`) и вне `L2…L12` слой не рисуется. */
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
 * Сторона «поля контроля» (осевой квадрат под узлом) как доля радиуса узла:
 * `2,7` — замер по эскизу владельца (111 px против 41,5 px узла). Квадрат
 * осевой: поворот на эскизе — след редактора, его не воспроизводим.
 */
export const CONTROL_FIELD_SIDE_RATIO = 2.7;

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

/**
 * Период ритма «всполоха» — плазменного сгустка, мс (дельта 5, П1.4).
 * Геометрия сгустка живёт в рендерере, а ритм — здесь: он считается из
 * детерминированного хеша пары `(netId, rivalId)` и чист от времени.
 */
export const FLARE_PULSE_MS = 1400;

/** Середина ритма: `0,775 ± 0,225` даёт диапазон `0,55…1`. */
export const FLARE_PULSE_MID = 0.775;

/** Амплитуда ритма — половина размаха `0,55…1`. */
export const FLARE_PULSE_AMPLITUDE = 0.225;

/**
 * Ритм «всполоха»: `0,775 + 0,225 · sin(2π · (nowMs / 1400 + seed))`, то есть
 * `0,55…1`. Время приходит аргументом — `Date.now` внутри нет, `Math.random`
 * тоже: один и тот же кадр всегда даёт одно и то же значение.
 */
export function flarePulse(nowMs: number, seed: number): number {
  const time = Number.isFinite(nowMs) ? nowMs : 0;
  const phase = Number.isFinite(seed) ? seed : 0;

  return FLARE_PULSE_MID
    + FLARE_PULSE_AMPLITUDE * Math.sin(2 * Math.PI * (time / FLARE_PULSE_MS + phase));
}

/**
 * Фаза ритма для всполоха: `seed = (хеш пары) % 1000 / 1000` — тот же хеш
 * `(net_id, rival_id, 0)`, по которому `flaresFor` решает, сколько импульсов
 * у пары. Рендерер берёт фазу отсюда, чтобы не знать про хеш.
 */
export function flarePulseSeed(netId: number, rivalId: number): number {
  return (flareSeed(netId, rivalId, 0) % 1000) / 1000;
}

/** Минимальная и максимальная длина «всполоха», единицы карты. */
export const MIN_FLARE_LENGTH = 24;
export const MAX_FLARE_LENGTH = 260;

/**
 * Резолвер табличного цвета фракции: имя → `#rrggbb` из `data/factions.csv`.
 * В рантайме это `factionColor` загрузчика данных; модуль сам цвет не вычисляет.
 */
export type FactionColorResolver = (faction: string) => FactionColor;

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
  /** Колонка `net_confront_id` из `systems.csv`: каналы «свой-чужой» (`Z-3.8`). */
  readonly net_confront_id?: number | string | null;
  readonly netConfrontId?: number | string | null;
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
  /**
   * Табличный цвет фракции. Без резолвера градиент не строится (`stops: []`):
   * цвет из имени фракции не вычисляется.
   */
  readonly factionColor?: FactionColorResolver;
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
  /**
   * Соперники берутся из данных (`Z-3.9`, дельта 4, В5): список `rivals` — это
   * уже объявленные в `net_confront_id` пары (`channelsFor`), поэтому критерий
   * геометрической близости `bridgesBetween` не применяется. Нет объявленных
   * пар — пустой список соперников и ноль всполохов.
   */
  readonly fromData?: boolean;
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
  return text === '' ? NEUTRAL_FACTION_LABEL : text;
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
 * Проверка резолвера цвета: без таблицы фракций градиент строить не из чего —
 * оттенок из имени не вычисляется, поэтому отсутствие резолвера — ошибка входа.
 */
function requireFactionColorResolver(
  resolveFactionColor: FactionColorResolver,
): FactionColorResolver {
  if (typeof resolveFactionColor !== 'function') {
    throw new RangeError('Нужен резолвер цвета фракции из таблицы factions.csv');
  }
  return resolveFactionColor;
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

function colorStopAt(
  offset: number,
  point: ColorPoint,
  resolveFactionColor: FactionColorResolver,
): ColorStop {
  const hex = resolveFactionColor(point.faction);
  const rgb = parseHexColor(hex);
  if (rgb === null) {
    throw new RangeError(
      `Цвет фракции «${point.faction}» не является #rrggbb: ${String(hex)}`,
    );
  }
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
 * Цвета стопов — табличные (`data/factions.csv`) и приходят через резолвер.
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
export function colorStops(
  members: readonly NetSystemInput[],
  resolveFactionColor: FactionColorResolver,
): readonly ColorStop[] {
  const resolve = requireFactionColorResolver(resolveFactionColor);
  const points = toColorPoints(members).sort((a, b) => compareIds(a.id, b.id));
  if (points.length === 0) return [];

  const factions: string[] = [];
  for (const point of points) {
    if (!factions.includes(point.faction)) factions.push(point.faction);
  }
  if (factions.length === 1) {
    const only = points[0]!;
    return [colorStopAt(0, only, resolve), colorStopAt(1, only, resolve)];
  }

  const [nearestA, nearestB] = nearestDistinctPair(points);
  const [first, second] = compareIds(nearestA.id, nearestB.id) <= 0
    ? [nearestA, nearestB]
    : [nearestB, nearestA];
  return [colorStopAt(0, first, resolve), colorStopAt(1, second, resolve)];
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

/** Нижний и верхний пределы радиуса узла на экране, px (Z-4d дельта 3). */
export const NODE_PX_MIN = 4;
export const NODE_PX_MAX = 9;

function nodeRadiusFactor(systemType: string): number {
  return NODE_RADIUS_BY_TYPE[systemType] ?? NODE_RADIUS_DEFAULT;
}

/** Экранный радиус узла по типу системы и экранному радиусу лепестка (`bubblePetalRadius × scale`). */
export function nodeRadiusPx(systemType: string, petalRadiusPx: number): number {
  const safePetal = Number.isFinite(petalRadiusPx) ? Math.max(0, petalRadiusPx) : 0;
  return clamp(
    safePetal * nodeRadiusFactor(normalizedSystemType(systemType)) * 0.35,
    NODE_PX_MIN,
    NODE_PX_MAX,
  );
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
    stops: options.factionColor ? colorStops(points, options.factionColor) : [],
  };
}

/* ------------------------------------------------- слияние полей сетей (Д-1) */

/** Часть общего поля, принадлежащая одной сети. */
export interface MergedField {
  readonly netId: number;
  /** Контуры своей части: замкнутые кольца в мировых координатах. */
  readonly rings: readonly (readonly NetPoint[])[];
}

/** Значение поля сети `k` в точке — та же формула, что у `bubbleFor`. */
function netFieldAt(
  point: NetPoint,
  geometry: NetGeometry,
  power: number,
  sixthPowers: readonly number[] | null,
): number {
  return metaballField(point.x, point.y, geometry.points, geometry.radii, power, sixthPowers);
}

function sixthPowersOf(radii: readonly number[], power: number): readonly number[] | null {
  return power === 6 ? radii.map((radius) => radius ** 6) : null;
}

/**
 * Слияние полей сетей (дельта 3, Д1 — главное).
 *
 * Одно общее метаполе вместо по-сетевых: `W(x, y) = Σ_k w_k(x, y)`, где
 * `w_k = Σ (r_i / d_i)^6` по системам сети `k` с теми же радиусами лепестков,
 * что у `bubbleFor`. Точка залита, если `W ≥ 1`; принадлежит сети `k`, если
 * она залита и `w_k` максимальна (равенство — меньший `netId`, ради
 * детерминизма). Новых порогов близости нет: близкие сети слипаются сами
 * (сумма пересекает единицу там, где каждая по отдельности ещё нет), далёкие
 * оставляют чёрный просвет.
 *
 * Контур каждой сети — изоляция её маски марчинг-скверсом по общей сетке:
 * на внешней границе интерполируется `W` по уровню `1`, на внутренней
 * (сеть против соседа) — разность `w_k − max_{j≠k} w_j` по уровню `0`,
 * поэтому кольца соседей смыкаются точно, без зазора и без наложения.
 *
 * Слияние — не конфронтация: каналы и всполохи из него не выводятся.
 */
export function mergedFields(
  nets: readonly FactionNet[],
  options: BubbleOptions = {},
): readonly MergedField[] {
  const resolved = resolveBubbleOptions(options);
  const list = (nets ?? [])
    .filter((net) => net && net.members.length > 0)
    .slice()
    .sort((a, b) => a.netId - b.netId);
  if (list.length === 0) return [];

  const geometries = list.map((net) => geometryOf(net, resolved));
  // Вырожденный случай Д1.4: одна сеть — ровно геометрия `bubbleFor`.
  if (list.length === 1) {
    return [{
      netId: list[0]!.netId,
      rings: buildRings(geometries[0]!.points, geometries[0]!.radii, resolved),
    }];
  }

  let maxRadius = 0;
  for (const geometry of geometries) {
    for (const radius of geometry.radii) maxRadius = Math.max(maxRadius, radius);
  }
  let pad = Math.max(maxRadius * 0.6, 1);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const geometry of geometries) {
      for (let index = 0; index < geometry.points.length; index += 1) {
        const point = geometry.points[index]!;
        const radius = geometry.radii[index]!;
        minX = Math.min(minX, point.x - radius);
        minY = Math.min(minY, point.y - radius);
        maxX = Math.max(maxX, point.x + radius);
        maxY = Math.max(maxY, point.y + radius);
      }
    }
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;

    // Сетка одна на все сети — над объединением габаритов (Д1.3).
    const side = Math.max(maxX - minX, maxY - minY, 1e-6);
    const originX = (minX + maxX) / 2 - side / 2;
    const originY = (minY + maxY) / 2 - side / 2;
    const cells = clamp(
      Math.ceil(side / (maxRadius / GRID_CELLS_PER_RADIUS)),
      resolved.gridCells,
      MAX_GRID_CELLS,
    );
    const cellSize = side / cells;
    const stride = cells + 1;
    const count = stride * stride;

    const powers = geometries.map((geometry) =>
      sixthPowersOf(geometry.radii, resolved.fieldPower));
    const fields: Float64Array[] = [];
    const total = new Float64Array(count);
    for (let netIndex = 0; netIndex < geometries.length; netIndex += 1) {
      const geometry = geometries[netIndex]!;
      const values = new Float64Array(count);
      for (let row = 0; row <= cells; row += 1) {
        const y = originY + row * cellSize;
        for (let column = 0; column <= cells; column += 1) {
          const index = row * stride + column;
          const value = netFieldAt({ x: originX + column * cellSize, y }, geometry, resolved.fieldPower, powers[netIndex]!);
          values[index] = value;
          total[index] = total[index]! + value;
        }
      }
      fields.push(values);
    }

    let borderInside = false;
    for (let index = 0; index < stride; index += 1) {
      if (
        total[index]! >= 1
        || total[cells * stride + index]! >= 1
        || total[index * stride]! >= 1
        || total[index * stride + cells]! >= 1
      ) {
        borderInside = true;
        break;
      }
    }
    if (borderInside) {
      pad *= 2;
      continue;
    }

    return list.map((net, netIndex) => ({
      netId: net.netId,
      rings: mergedRingsOf(
        netIndex,
        fields,
        total,
        cells,
        stride,
        cellSize,
        originX,
        originY,
        geometries,
        resolved,
      ),
    }));
  }

  return list.map((net) => ({ netId: net.netId, rings: [] as NetPoint[][] }));
}

/** Принадлежность угла сетке `netIndex`: залито (`W ≥ 1`) и поле максимально. */
function ownerAt(fields: readonly Float64Array[], total: number, index: number): number {
  if (total < 1) return -1;
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let netIndex = 0; netIndex < fields.length; netIndex += 1) {
    const value = fields[netIndex]![index]!;
    // Строго больше: при равенстве побеждает меньший `netId` (сети отсортированы).
    if (value > bestValue) {
      bestValue = value;
      best = netIndex;
    }
  }
  return best;
}

/**
 * Кольца одной сети: марчинг-скверс по её маске. `buildRings` здесь не годится —
 * там маска считается по полю одной сети, а тут она зависит от соседей.
 */
function mergedRingsOf(
  netIndex: number,
  fields: readonly Float64Array[],
  total: Float64Array,
  cells: number,
  stride: number,
  cellSize: number,
  originX: number,
  originY: number,
  geometries: readonly NetGeometry[],
  options: ResolvedBubbleOptions,
): NetPoint[][] {
  const own = fields[netIndex]!;
  const owners = new Int32Array(stride * stride);
  for (let index = 0; index < owners.length; index += 1) {
    owners[index] = ownerAt(fields, total[index]!, index);
  }

  /** Точка пересечения на ребре ячейки: внешняя граница — по `W`, внутренняя — по разности полей. */
  const crossing = (ax: number, ay: number, ia: number, bx: number, by: number, ib: number): NetPoint => {
    const insideA = owners[ia] === netIndex;
    const insideB = owners[ib] === netIndex;
    const bothFilled = total[ia]! >= 1 && total[ib]! >= 1;
    let t: number;
    if (insideA && insideB) {
      t = 0.5;
    } else if (bothFilled) {
      // Граница двух сетей: разность `w_own − w_other` переходит ноль ровно здесь.
      const otherA = maxOtherField(fields, netIndex, ia);
      const otherB = maxOtherField(fields, netIndex, ib);
      const ua = own[ia]! - otherA;
      const ub = own[ib]! - otherB;
      const delta = ub - ua;
      t = delta === 0 ? 0.5 : clamp(-ua / delta, 0, 1);
    } else {
      const va = total[ia]!;
      const vb = total[ib]!;
      const delta = vb - va;
      t = delta === 0 ? 0.5 : clamp((1 - va) / delta, 0, 1);
    }
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };

  const segments: BubbleSegment[] = [];
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      const ia = row * stride + column;
      const ib = ia + 1;
      const ic = ib + stride;
      const id = ia + stride;
      const mask = (owners[ia] === netIndex ? 1 : 0)
        | (owners[ib] === netIndex ? 2 : 0)
        | (owners[ic] === netIndex ? 4 : 0)
        | (owners[id] === netIndex ? 8 : 0);
      if (mask === 0 || mask === 15) continue;

      const x0 = originX + column * cellSize;
      const x1 = x0 + cellSize;
      const y0 = originY + row * cellSize;
      const y1 = y0 + cellSize;
      const bottom = crossing(x0, y0, ia, x1, y0, ib);
      const right = crossing(x1, y0, ib, x1, y1, ic);
      const top = crossing(x0, y1, id, x1, y1, ic);
      const left = crossing(x0, y0, ia, x0, y1, id);

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
          // Центр ячейки: принадлежность считается той же функцией, что у углов.
          const centre = {
            x: (x0 + x1) / 2,
            y: (y0 + y1) / 2,
          };
          let centreTotal = 0;
          let centreOwner = -1;
          let centreBest = Number.NEGATIVE_INFINITY;
          for (let other = 0; other < geometries.length; other += 1) {
            const value = netFieldAt(centre, geometries[other]!, options.fieldPower, null);
            centreTotal += value;
            if (value > centreBest) {
              centreBest = value;
              centreOwner = other;
            }
          }
          const centreInside = centreTotal >= 1 && centreOwner === netIndex;
          if (mask === 5) {
            if (centreInside) {
              push(left, top);
              push(bottom, right);
            } else {
              push(left, bottom);
              push(right, top);
            }
          } else if (centreInside) {
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
        default:
          break;
      }
    }
  }

  const rings = chainRings(segments);
  return options.smooth ? rings.map((ring) => smoothRing(ring)) : rings;
}

/** Максимальное поле среди соседних сетей в узле сетки. */
function maxOtherField(fields: readonly Float64Array[], netIndex: number, index: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (let other = 0; other < fields.length; other += 1) {
    if (other === netIndex) continue;
    const value = fields[other]![index]!;
    if (value > best) best = value;
  }
  return best === Number.NEGATIVE_INFINITY ? 0 : best;
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
 * совпадает с маркерами и территориями: масштаб по полной ширине кадра, как у
 * маркеров и территорий (`worldToScreen` сцены — тоже `frame.w / visibleWidth`).
 *
 * `Z-3.9` (дефект): раньше здесь стоял `Math.min(frame.w, frame.h)`, и на
 * `1366×768` бабл выходил в `768/1366 = 0,562` от нужного размера и съезжал к
 * центру кадра — расходился с маркерами и территориями того же кадра.
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
  const scale = frame.w / cam.visibleWidth;
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
    faction: NEUTRAL_FACTION_LABEL,
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
    stops: options.factionColor
      ? [
        colorStopAt(0, primaryColorPoint(netA), options.factionColor),
        colorStopAt(1, primaryColorPoint(netB), options.factionColor),
      ]
      : [],
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

/** Геометрия всполоха, когда ленты нет: направления и длины — от центров сетей. */
interface FlareGeometry {
  readonly gap: number;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
}

/**
 * Свой конец всполоха без ленты: ближайшая к сопернику система своей сети.
 * Она лежит внутри своего бабла, поэтому сгусток стартует на краю своего поля
 * контроля, а не в пустоте между сетями.
 */
function dataFlareGeometry(net: FactionNet, rival: FactionNet): FlareGeometry | null {
  if (net.members.length === 0 || rival.members.length === 0) return null;
  let own = net.members[0]!;
  let nearest = Number.POSITIVE_INFINITY;
  for (const member of net.members) {
    const distance = Math.hypot(rival.centerX - member.x, rival.centerY - member.y);
    if (distance < nearest) {
      nearest = distance;
      own = member;
    }
  }

  return {
    gap: Math.max(Math.hypot(rival.centerX - net.centerX, rival.centerY - net.centerY), 1e-9),
    originX: own.x,
    originY: own.y,
    // Тот же порядок, что у ленты: `0,3 · BRIDGE_MIN_WIDTH`, но не меньше 2.
    width: Math.max(2, BRIDGE_MIN_WIDTH * 0.3),
  };
}

/**
 * «Всполохи» сети в сторону конфронтующих сетей.
 *
 * Конфронтация — соседство по критерию `bridgesBetween` (иначе сеть просто
 * не видна рядом). Число импульсов на соседа и разброс направления берутся из
 * детерминированного хеша `(net_id, rival_id, индекс)` — без `Math.random`
 * и без `Date.now`; суммарно не больше `MAX_FLARES_PER_NET`.
 *
 * `fromData: true` (дельта 4, В5): соперники уже отобраны данными
 * (`net_confront_id` → `channelsFor`), поэтому далёкие сети без ленты всполох
 * всё равно получают — геометрия считается от центров и ближайших систем.
 * Без объявленных пар список соперников пуст и всполохов нет.
 */
export function flaresFor(
  net: FactionNet,
  rivals: readonly FactionNet[],
  options: FlareOptions = {},
): readonly Flare[] {
  const limit = flareLimit(options.limit);
  if (!net || limit === 0) return [];
  const fromData = options.fromData === true;
  const ordered = (rivals ?? [])
    .filter((rival) => rival && rival.netId !== net.netId)
    .slice()
    .sort((a, b) => a.netId - b.netId);

  const flares: Flare[] = [];
  for (const rival of ordered) {
    if (flares.length >= limit) break;
    const bridge = bridgesBetween(net, rival);
    const fallback = bridge === null && fromData ? dataFlareGeometry(net, rival) : null;
    if (bridge === null && fallback === null) continue;
    const gap = bridge === null ? fallback!.gap : bridge.gap;
    const originX = bridge === null ? fallback!.originX : bridge.from.x;
    const originY = bridge === null ? fallback!.originY : bridge.from.y;
    const width = bridge === null ? fallback!.width : Math.max(2, bridge.width * 0.3);

    const spanX = rival.centerX - net.centerX;
    const spanY = rival.centerY - net.centerY;
    const span = Math.hypot(spanX, spanY);
    const baseAngle = span > 1e-9
      ? Math.atan2(spanY, spanX)
      : Math.atan2(rival.centerY - net.centerY, rival.centerX - net.centerX);
    const count = 1 + (flareSeed(net.netId, rival.netId, 0) % MAX_FLARES_PER_RIVAL);
    const intensity = clamp(1 / (1 + gap / 400), 0, 1);
    const length = clamp(gap * 0.45, MIN_FLARE_LENGTH, MAX_FLARE_LENGTH);

    for (let index = 0; index < count && flares.length < limit; index += 1) {
      const jitter = ((flareSeed(net.netId, rival.netId, index + 1) % 1001) / 1000 - 0.5);
      flares.push({
        netId: net.netId,
        targetNetId: rival.netId,
        originX,
        originY,
        angle: baseAngle + jitter * FLARE_SPREAD,
        length,
        width,
        intensity,
      });
    }
  }

  return flares.sort((a, b) => a.targetNetId - b.targetNetId || a.angle - b.angle);
}

/* ------------------------------------------------ каналы между сетями (Z-3.8) */

/**
 * Канал — узкая лента между двумя системами разных сетей: пара «свой-чужой»
 * из колонки `net_confront_id` (`N-M` или `N-M-K`, где первое число ВСЕГДА
 * равно собственному `net_id` системы, а остальные — цели). Запись `«1-2-3»`
 * даёт ДВА канала, `1↔2` и `1↔3`, а не цепочку; цепочки (`1 → 2 → 3`)
 * возникают сами, когда система сети `2` объявит `«2-3»`.
 *
 * Правило партнёра (карточка `Z-3.8`) для системы `A` с `net_id = N` и целью `M`:
 *   1. если в сети `M` есть система `B`, объявившая ту же пару (`M-N` или
 *      `N-M`), связь ПРИНУДИТЕЛЬНАЯ именно с `B` — даже когда другая система
 *      сети `M` ближе; таких `B` несколько — берётся ближайшая из них;
 *   2. встречных объявлений нет — партнёр автоматический: ближайшая система
 *      сети `M`;
 *   3. одна пара систем — одна лента: `A-B` и `B-A` не дублируются;
 *   4. системы с одинаковым `net_id` не соединяются никогда (это же запрещает
 *      проверка ячейки: цель не может равняться своей сети).
 *
 * Каналы идут поверх баблов и сквозь них, но в генерацию баблов не входят:
 * `bubbleFor`, `parseNetworks` и геометрия лепестков колонку `net_confront_id`
 * не читают, поэтому JSON бабла с каналами и без них совпадает побайтово.
 *
 * Ошибки данных — `RangeError` с именем системы: ячейку заполняет владелец в
 * таблице, и молча пропущенный канал выглядел бы как «сети не конфликтуют».
 * Треугольник (`1-2`, `2-3`, `3-1`) разрешён: каналы строятся, а замкнутое
 * кольцо возвращается предупреждением (`warnings`), а не исключением, поэтому
 * сборка карты проходит и на кольце.
 */

/** Номер сети в `net_confront_id`: целое, начинается с `1` (карточка `Z-3.8`). */
export const NET_CONFRONT_MIN_ID = 1;

/**
 * Чисел в ячейке: минимум пара `N-M` — своя сеть и одна цель. Верхней границы
 * нет: сколько целей владелец впишет в ячейку, столько и проверяется, а
 * существует ли сеть с таким номером — решают данные, а не константа.
 */
export const NET_CONFRONT_MIN_PARTS = 2;

/**
 * Бюджет кадра: сколько лент каналов рисуется за один кадр. Канал — градиентный
 * проход поверх баблов, поэтому после разметки владельца лент может стать
 * больше, чем кадр готов нарисовать: сверх бюджета ленты не рисуются, а в
 * консоли один раз печатается предупреждение. На `channelsFor` бюджет не
 * влияет — геометрия считается целиком, режется только отрисовка.
 */
export const MAX_CHANNELS_PER_FRAME = 24;

/** Разделитель чисел в ячейке `net_confront_id`; пробелы по краям допускаются. */
export const NET_CONFRONT_SEPARATOR = '-';

/**
 * Ширина ленты канала: вдвое уже ленты между баблами — `BRIDGE_WIDTH_RATIO · 0,5`
 * от меньшего лепестка двух концов. База та же, что у `bridgesBetween`, поэтому
 * каналы масштабируются вместе с баблами и остаются «узкой лентой».
 */
export const CHANNEL_WIDTH_RATIO = BRIDGE_WIDTH_RATIO * 0.5;

/** Яркость канала: одна на все каналы, от номера канала и расстояния не зависит. */
export const CHANNEL_BRIGHTNESS = 1;

/**
 * Изгиб канала как доля хорды (дельта 3/редакция 2, С12): линия на эскизе
 * владельца изогнута, а не прямая. Знак берётся от порядка `systemId`.
 */
export const CHANNEL_BOW_RATIO = 0.08;

/** Толщина линии канала, экранные px: канал рисуется линией, а не лентой. */
export const CHANNEL_STROKE_PX = 2.5;

/** Конец канала: система сети в мировых координатах. */
export interface ChannelEnd {
  readonly netId: number;
  readonly systemId: string;
  readonly name: string;
  readonly faction: string | null;
  readonly systemType: string;
  readonly x: number;
  readonly y: number;
  /** Радиус лепестка этой системы в своём бабле: из него ширина ленты. */
  readonly radius: number;
}

/** Канал между двумя системами разных сетей. */
export interface NetChannel {
  /** Каноническая пара сетей: меньший номер первым, например `«1-2»`. */
  readonly pair: string;
  /** Конец с меньшим номером сети: порядок не зависит от порядка строк CSV. */
  readonly from: ChannelEnd;
  readonly to: ChannelEnd;
  /** Расстояние между системами, мировые единицы. */
  readonly gap: number;
  /** Длина ленты: канал идёт от системы до системы, без обрезки по баблам. */
  readonly length: number;
  readonly width: number;
  /**
   * Углы ленты: оставлены ради совместимости и старых тестов. Канал
   * рисуется линией `CHANNEL_STROKE_PX` по `curve`, а `width`/`quad` — нет.
   */
  readonly quad: readonly [NetPoint, NetPoint, NetPoint, NetPoint];
  /** Выход канала на границе своего бабла (или центр системы при перекрытии). */
  readonly edgeFrom: NetPoint;
  /** Вход канала на границе чужого бабла (или центр системы при перекрытии). */
  readonly edgeTo: NetPoint;
  /** Сдвиг контрольной точки квадратичной кривой, со знаком; при перекрытии `0`. */
  readonly bow: number;
  /** Квадратичная кривая канала: `[начало, контрольная точка, конец]`. */
  readonly curve: readonly [NetPoint, NetPoint, NetPoint];
  /** Градиент табличных цветов фракций двух концов (`data/factions.csv`). */
  readonly stops: readonly ColorStop[];
  /** `true` — партнёр объявил ту же пару встречно, связь принудительная. */
  readonly forced: boolean;
  /** Идентификаторы систем, объявивших эту пару сетей (отсортированы). */
  readonly declaredBy: readonly string[];
}

/** Предупреждение слоя каналов: сборка проходит, владелец видит причину. */
export interface NetChannelWarning {
  /** `'ring'` — замкнутое кольцо каналов (треугольник `1-2`, `2-3`, `3-1`). */
  readonly kind: 'ring';
  /** Сети кольца по порядку обхода, начиная с меньшего номера. */
  readonly netIds: readonly number[];
  readonly message: string;
}

/** Результат `channelsFor`: ленты и предупреждения, без исключений на кольцах. */
export interface NetChannelResult {
  readonly channels: readonly NetChannel[];
  readonly warnings: readonly NetChannelWarning[];
}

/**
 * Настройки каналов: те же ручки, что у баблов (геометрия лепестка нужна для
 * ширины ленты, `factionColor` — для градиента концов).
 */
export type ChannelOptions = BubbleOptions;

/** Текст ячейки `net_confront_id`: `null`/`undefined` и пустая строка — пусто. */
function confrontText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Значение колонки `net_confront_id`: имя из CSV важнее camelCase-записи. */
function confrontValueOf(raw: NetSystemInput): unknown {
  return raw.net_confront_id !== undefined && raw.net_confront_id !== null
    ? raw.net_confront_id
    : raw.netConfrontId;
}

/** Имя системы для текста ошибки: имя, иначе идентификатор, иначе номер строки. */
function systemLabelOf(raw: NetSystemInput, index: number): string {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name !== '') return name;
  const id = idOf(raw);
  return id !== '' ? id : `#${index + 1}`;
}

/**
 * Разбор ячейки `net_confront_id`: цели системы (без первого числа — оно равно
 * собственному `net_id`). Пустая ячейка или отсутствие колонки — `null`: система
 * каналов не объявляет. Любая ошибка — `RangeError` с именем системы.
 *
 * Проверки карточки `Z-3.8` (1, 2, 3, 5, 6): первое число равно своему `net_id`;
 * ни одна цель не равна первому числу; внутри ячейки нет повторов; `net_id` не
 * пуст и не `0`; числа целые и не меньше `1`, их минимум `2`. Верхней границы
 * номера нет: проверка 4 (сеть с таким номером существует в данных) — в
 * `channelsFor`, ей нужен весь набор систем, а не одна ячейка.
 */
export function netConfrontTargets(
  value: unknown,
  systemLabel: string,
  ownNetId: number | null,
): readonly number[] | null {
  const text = confrontText(value);
  if (text === '') return null;
  const where = `net_confront_id «${text}» системы «${systemLabel}»`;

  if (ownNetId === null) {
    throw new RangeError(
      `${where}: канал объявила система вне сети — net_id пуст или равен 0`,
    );
  }

  const parts = text.split(NET_CONFRONT_SEPARATOR);
  if (parts.length < NET_CONFRONT_MIN_PARTS) {
    throw new RangeError(
      `${where}: нужно не меньше ${NET_CONFRONT_MIN_PARTS} чисел `
      + `через «${NET_CONFRONT_SEPARATOR}», получено ${parts.length}`,
    );
  }

  const numbers: number[] = [];
  for (const part of parts) {
    const digits = part.trim();
    if (!/^\d+$/.test(digits)) {
      throw new RangeError(`${where}: «${part}» не является целым числом`);
    }
    const number = Number(digits);
    if (!Number.isInteger(number) || number < NET_CONFRONT_MIN_ID) {
      throw new RangeError(
        `${where}: номер сети ${digits} должен быть целым `
        + `и не меньше ${NET_CONFRONT_MIN_ID}`,
      );
    }
    numbers.push(number);
  }

  const own = numbers[0]!;
  if (own !== ownNetId) {
    throw new RangeError(
      `${where}: первое число должно быть равно собственному net_id системы (${ownNetId})`,
    );
  }

  const targets = numbers.slice(1);
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    if (target === own) {
      throw new RangeError(
        `${where}: цель ${target} равна собственной сети — система не соединяется сама с собой`,
      );
    }
    if (targets.indexOf(target) !== index) {
      throw new RangeError(`${where}: число ${target} повторяется внутри ячейки`);
    }
  }

  return targets;
}

/** Нормализованная строка данных для слоя каналов. */
interface ChannelEntry {
  readonly label: string;
  readonly netId: number | null;
  readonly targets: readonly number[];
  /** `null` — у строки нет координат или идентификатора: в геометрию не идёт. */
  readonly system: ChannelSystem | null;
}

/** Система канала: координаты и радиус лепестка известны. */
interface ChannelSystem {
  readonly id: string;
  readonly name: string;
  readonly faction: string | null;
  readonly systemType: string;
  readonly netId: number;
  readonly targets: readonly number[];
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Ключ пары сетей: меньший номер первым, чтобы `1-2` и `2-1` были одной парой. */
function netPairKey(netA: number, netB: number): string {
  return netA <= netB ? `${netA}|${netB}` : `${netB}|${netA}`;
}

/** Ключ пары систем: `A-B` и `B-A` — одна лента (правило 3). */
function systemPairKey(idA: string, idB: string): string {
  return compareIds(idA, idB) <= 0 ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/** Ближайшая система из пула: при равных расстояниях побеждает меньший `id`. */
function nearestOf(
  from: ChannelSystem,
  pool: readonly ChannelSystem[],
): ChannelSystem | null {
  let best: ChannelSystem | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of pool) {
    if (candidate.id === from.id) continue;
    const distance = Math.hypot(candidate.x - from.x, candidate.y - from.y);
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Кольцо в графе сетей: каноническая запись — от меньшего номера, в меньшую сторону. */
function canonicalRing(ring: readonly number[]): readonly number[] {
  if (ring.length === 0) return ring;
  let start = 0;
  for (let index = 1; index < ring.length; index += 1) {
    if (ring[index]! < ring[start]!) start = index;
  }
  const rotated: number[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    rotated.push(ring[(start + index) % ring.length]!);
  }
  const second = rotated[1]!;
  const last = rotated[rotated.length - 1]!;
  if (second <= last) return rotated;
  const reversed: number[] = [rotated[0]!];
  for (let index = rotated.length - 1; index >= 1; index -= 1) {
    reversed.push(rotated[index]!);
  }
  return reversed;
}

/**
 * Замкнутые кольца в графе сетей канала: обход в глубину по рёбрам пар сетей.
 * Рёбра между одной парой сетей считаются один раз, поэтому две ленты `1↔2`
 * (две системы сети `1` объявили одну цель) кольцом не признаются.
 */
function ringsOf(
  nodes: readonly number[],
  edges: ReadonlySet<string>,
): readonly (readonly number[])[] {
  const adjacency = new Map<number, number[]>();
  for (const node of nodes) adjacency.set(node, []);
  for (const edge of edges) {
    const [leftText, rightText] = edge.split('|');
    const left = Number(leftText);
    const right = Number(rightText);
    adjacency.get(left)?.push(right);
    adjacency.get(right)?.push(left);
  }
  for (const list of adjacency.values()) list.sort((a, b) => a - b);

  const rings: (readonly number[])[] = [];
  const seen = new Set<string>();
  const state = new Map<number, number>();
  const stack: number[] = [];

  const visit = (node: number): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const mark = state.get(next) ?? 0;
      if (mark === 1) {
        const ring = canonicalRing(stack.slice(stack.indexOf(next)));
        if (ring.length < 3) continue;
        const key = ring.join(NET_CONFRONT_SEPARATOR);
        if (seen.has(key)) continue;
        seen.add(key);
        rings.push(ring);
      } else if (mark === 0) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0) visit(node);
  }
  return rings;
}

/** Связь двух систем, найденная по правилу партнёра. */
interface ChannelLink {
  readonly own: ChannelSystem;
  readonly partner: ChannelSystem;
  readonly forced: boolean;
}

/**
 * Каналы между сетями по колонке `net_confront_id` (`Z-3.8`).
 *
 * Вход — те же строки, что у `parseNetworks` (сырой CSV или записи загрузчика).
 * Порядок каналов детерминирован: пары сетей по возрастанию, внутри пары —
 * идентификаторы систем, поэтому перестановка строк CSV результат не меняет.
 * Битая ячейка — `RangeError` с именем системы; замкнутое кольцо — не ошибка,
 * а предупреждение в `warnings`.
 */
export function channelsFor(
  systems: readonly NetSystemInput[],
  options: ChannelOptions = {},
): NetChannelResult {
  const resolved = resolveBubbleOptions(options);
  const list = systems ?? [];

  /* 1. Разбор и проверки ячеек: падаем с именем системы, а не молчим. */
  const entries: ChannelEntry[] = [];
  const knownNetIds = new Set<number>();
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index]!;
    const label = systemLabelOf(raw, index);
    const netId = parseNetId(raw.net_id) ?? parseNetId(raw.netId);
    if (netId !== null) knownNetIds.add(netId);
    const targets = netConfrontTargets(confrontValueOf(raw), label, netId) ?? [];

    const x = finiteNumber(raw.x);
    const y = finiteNumber(raw.y);
    const id = idOf(raw);
    const system: ChannelSystem | null = x === null || y === null || id === '' || netId === null
      ? null
      : {
        id,
        name: label,
        faction: typeof raw.faction === 'string' && raw.faction.trim() !== ''
          ? raw.faction.trim()
          : null,
        systemType: normalizedSystemType(raw.type ?? raw.systemType),
        netId,
        targets,
        x,
        y,
        radius: 0,
      };
    entries.push({ label, netId, targets, system });
  }

  /* 2. Проверка 4: каждое число-цель — сеть, которая реально есть в данных
   *    (`net_id` хотя бы одной системы). Допустимый диапазон номеров задаёт сам
   *    CSV, константами он не ограничен: сеть `7` законна, если она есть. */
  for (const entry of entries) {
    for (const target of entry.targets) {
      if (knownNetIds.has(target)) continue;
      throw new RangeError(
        `net_confront_id системы «${entry.label}»: сеть-цель ${target} не существует в данных`,
      );
    }
  }

  /* 3. Сети и радиусы лепестков: геометрия баблов используется как есть. */
  const nets = new Map<number, ChannelSystem[]>();
  for (const entry of entries) {
    const system = entry.system;
    if (system === null) continue;
    const bucket = nets.get(system.netId);
    if (bucket === undefined) nets.set(system.netId, [system]);
    else bucket.push(system);
  }
  const placed: ChannelSystem[] = [];
  for (const [netId, bucket] of nets) {
    bucket.sort((a, b) => compareIds(a.id, b.id));
    const points: BubblePoint[] = bucket.map((member) => ({
      id: member.id,
      name: member.name,
      faction: member.faction,
      systemType: member.systemType,
      x: member.x,
      y: member.y,
    }));
    const radii = petalRadii(points, resolved);
    for (let index = 0; index < bucket.length; index += 1) {
      const member = bucket[index]!;
      const withRadius: ChannelSystem = { ...member, radius: radii[index]! };
      bucket[index] = withRadius;
      placed.push(withRadius);
    }
    nets.set(netId, bucket);
  }

  /* 4. Кто объявил пару сетей: нужно для принудительной связи (правило 1). */
  const declaredPairs = new Map<string, string[]>();
  for (const system of placed) {
    for (const target of system.targets) {
      const key = netPairKey(system.netId, target);
      const declarers = declaredPairs.get(key);
      if (declarers === undefined) declaredPairs.set(key, [system.id]);
      else if (!declarers.includes(system.id)) declarers.push(system.id);
    }
  }

  /* 5. Правило партнёра и сборка лент: одна пара систем — одна лента. */
  const links = new Map<string, ChannelLink>();
  for (const system of placed) {
    for (const target of system.targets) {
      const bucket = nets.get(target);
      if (bucket === undefined || bucket.length === 0) {
        throw new RangeError(
          `net_confront_id системы «${system.name}»: у сети-цели ${target} `
          + 'нет ни одной системы с координатами',
        );
      }
      const mutual = bucket.filter((candidate) => candidate.targets.includes(system.netId));
      const partner = nearestOf(system, mutual.length > 0 ? mutual : bucket);
      if (partner === null) continue;
      const key = systemPairKey(system.id, partner.id);
      if (links.has(key)) continue;
      links.set(key, { own: system, partner, forced: mutual.length > 0 });
    }
  }

  const channels: NetChannel[] = [];
  for (const link of links.values()) {
    const ordered: readonly [ChannelSystem, ChannelSystem] = link.own.netId <= link.partner.netId
      ? [link.own, link.partner]
      : [link.partner, link.own];
    const first = ordered[0];
    const second = ordered[1];
    const gap = Math.hypot(second.x - first.x, second.y - first.y);
    // Лента идёт от системы до системы сквозь баблы: концы не обрезаются.
    const distance = Math.max(gap, 1e-9);
    const ux = (second.x - first.x) / distance;
    const uy = (second.y - first.y) / distance;
    const width = CHANNEL_WIDTH_RATIO * Math.min(first.radius, second.radius);
    const half = width / 2;
    const normalX = -uy;
    const normalY = ux;
    const pair = netPairKey(first.netId, second.netId);

    /* Изогнутая линия канала (С12, дельта 3): выход и вход — на границах баблов,
     * изгиб — доля хорды со знаком, чтобы у взаимной пары линии пересекались,
     * а два луча одной системы (`1-2-3`) шли в одну сторону. */
    const inside = gap <= first.radius + second.radius;
    const edgeFrom: NetPoint = inside
      ? { x: first.x, y: first.y }
      : { x: first.x + ux * first.radius, y: first.y + uy * first.radius };
    const edgeTo: NetPoint = inside
      ? { x: second.x, y: second.y }
      : { x: second.x - ux * second.radius, y: second.y - uy * second.radius };
    const chord = Math.hypot(edgeTo.x - edgeFrom.x, edgeTo.y - edgeFrom.y);
    const sign = compareIds(first.id, second.id) <= 0 ? 1 : -1;
    const bow = inside ? 0 : sign * CHANNEL_BOW_RATIO * chord;
    const control: NetPoint = {
      x: (edgeFrom.x + edgeTo.x) / 2 + -uy * bow,
      y: (edgeFrom.y + edgeTo.y) / 2 + ux * bow,
    };
    const declarers = (declaredPairs.get(pair) ?? []).slice().sort(compareIds);

    const endOf = (system: ChannelSystem): ChannelEnd => ({
      netId: system.netId,
      systemId: system.id,
      name: system.name,
      faction: system.faction,
      systemType: system.systemType,
      x: system.x,
      y: system.y,
      radius: system.radius,
    });
    const colorPointOf = (system: ChannelSystem): ColorPoint => ({
      id: system.id,
      faction: system.faction ?? NEUTRAL_FACTION_LABEL,
      x: system.x,
      y: system.y,
    });

    channels.push({
      pair: `${first.netId}${NET_CONFRONT_SEPARATOR}${second.netId}`,
      from: endOf(first),
      to: endOf(second),
      gap,
      length: gap,
      width,
      quad: [
        { x: first.x + normalX * half, y: first.y + normalY * half },
        { x: second.x + normalX * half, y: second.y + normalY * half },
        { x: second.x - normalX * half, y: second.y - normalY * half },
        { x: first.x - normalX * half, y: first.y - normalY * half },
      ],
      edgeFrom,
      edgeTo,
      bow,
      curve: [edgeFrom, control, edgeTo],
      stops: options.factionColor
        ? [
          colorStopAt(0, colorPointOf(first), options.factionColor),
          colorStopAt(1, colorPointOf(second), options.factionColor),
        ]
        : [],
      forced: link.forced,
      declaredBy: declarers,
    });
  }

  channels.sort((a, b) => a.from.netId - b.from.netId
    || a.to.netId - b.to.netId
    || compareIds(a.from.systemId, b.from.systemId)
    || compareIds(a.to.systemId, b.to.systemId));

  /* 6. Замкнутое кольцо — предупреждение, а не ошибка: сборка карты проходит. */
  const nodes: number[] = [];
  const edges = new Set<string>();
  for (const channel of channels) {
    for (const netId of [channel.from.netId, channel.to.netId]) {
      if (!nodes.includes(netId)) nodes.push(netId);
    }
    edges.add(netPairKey(channel.from.netId, channel.to.netId));
  }
  nodes.sort((a, b) => a - b);

  const warnings: NetChannelWarning[] = ringsOf(nodes, edges).map((ring) => ({
    kind: 'ring',
    netIds: ring,
    message: 'Замкнутое кольцо каналов: сети '
      + [...ring, ring[0]!].join(' → '),
  }));

  return { channels, warnings };
}
