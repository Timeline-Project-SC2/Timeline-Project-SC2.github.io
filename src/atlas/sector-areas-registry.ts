/* Реестр модулей секторного редактора: один список вместо демонстрационной заглушки.
 *
 * Правила, по которым составлен реестр ([ED-2](../../docs/agents_task_orchestration/wave_cards/ADM-EDITOR-MODULES-WORKING-VIEW.md) §1 п.3,
 * [концепция модулей](../../docs/concepts/module-interaction-rules.md) §2):
 *
 * 1. Три плоскости не смешиваются: связи данных, пространственное влияние и
 *    порядок отрисовки. Четвёртый контур — доступ и черновик — плоскостью
 *    данных не является и здесь не описывается.
 * 2. Одна числовая шкала приоритетов не вводится: плоскость — имя, а не число.
 * 3. Редактор — управляющая поверхность. Он не владеет геометрией модулей и
 *    не переписывает их поведение: каждая строка свойств считается **функцией
 *    самого модуля** по текущим данным, а не берётся из литерала.
 * 4. Статус честный: `working` — модуль подключён и участвует в офлайн-работе,
 *    `view` — редактор только показывает его реальные значения, `offline` —
 *    модуль существует, но к панели не подключён, и это сказано прямо.
 *
 * Файл не держит состояния и не обращается к DOM: его можно проверить в node.
 */

import { MODES, SECTOR_AREAS_SCHEMA_VERSION, validateSectorAreas } from './sector-areas-contract.ts';
import type { Area, AreaState, Mode, SectorAreasDoc, ValidationReport } from './sector-areas-contract.ts';
import { ancestorsOf, checkContainment, hierarchyDepth, statesByMode } from './sector-areas-cascade.ts';
import { NEUTRAL_COLOR, TASK_STYLES, modeStyle, toCss } from './sector-areas-color.ts';
import { overridesFor, resolvePaint } from './sector-areas-force.ts';
import { bboxOf, ringArea, ringCentroid, selfIntersections, totalVertices } from './sector-areas-geometry.ts';
import { buildJournal } from './sector-areas-journal.ts';
import { LOD_PRESETS, effectiveLevel, lodEpsilon, roundingIterations } from './sector-areas-lod.ts';
import { buildAreaPaints, areaSize } from './sector-areas-render.ts';
import { classifyArea, scopeCrossings, scopesFromBounds } from './sector-areas-scope.ts';
import { DEFAULT_BANDS, bandAt, bandIds, createBorderWorld, distanceToCentral } from './sector-areas-border-world.ts';
import { CENTRAL_SYSTEM_KORHAL, BORDER_SYSTEM_KOLO } from './sector-areas-border-world.ts';
import { enumerate, polygonAt, smoothPolyline } from './sector-bounds.ts';
import type { SectorBounds } from './sector-bounds.ts';
import { clipHalo } from './sector-halo-clip.ts';
import { createNebula } from './nebula-model.ts';
import type { EditorSession } from './sector-areas-editor.ts';

/* ------------------------------------------------------------------ словари */

/** Плоскость связи: отвечает на свой вопрос и не заменяет остальные. */
export type ModulePlane = 'data' | 'spatial' | 'order';

export const PLANE_TITLES: Readonly<Record<ModulePlane, string>> = Object.freeze({
  data: 'Связи данных',
  spatial: 'Пространственное влияние',
  order: 'Порядок отрисовки',
});

export const PLANE_QUESTIONS: Readonly<Record<ModulePlane, string>> = Object.freeze({
  data: 'что является частью чего или на что ссылается',
  spatial: 'как один модуль меняет производное отображение другого',
  order: 'что визуально находится поверх чего',
});

/** Статус модуля в панели. `offline` показывается с причиной, а не молча. */
export type ModuleStatus = 'working' | 'view' | 'offline';

export const STATUS_TITLES: Readonly<Record<ModuleStatus, string>> = Object.freeze({
  working: 'рабочий',
  view: 'только просмотр',
  offline: 'не подключено',
});

export const MODE_TITLES: Readonly<Record<Mode, string>> = Object.freeze({
  political: 'политический',
  military: 'военный',
  economy: 'экономический',
  tension: 'напряжённость',
});

export function modeLabel(mode: Mode): string {
  return MODE_TITLES[mode] ?? mode;
}

/* -------------------------------------------------------------------- модель */

export interface ModuleRow {
  readonly label: string;
  readonly value: string;
}

export interface ModuleAction {
  readonly id: string;
  readonly label: string;
  /** `true` — действие недоступно сейчас; причина указана в подсказке модуля. */
  readonly disabled?: boolean;
}

/** Система в объёме, нужном пограничному миру: имя и мировые координаты. */
export interface RegistrySystem {
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface RegistryContext {
  readonly session: EditorSession;
  /** Границы сектора из `data/sector-bounds.json`; `null` — данные не загружены. */
  readonly bounds: SectorBounds | null;
  readonly systems: readonly RegistrySystem[];
  /** Масштаб кадра: переводит ширину кисти из пикселей в мировые единицы. */
  readonly scale: number;
}

export interface SectorModule {
  readonly id: string;
  readonly label: string;
  readonly plane: ModulePlane;
  readonly status: ModuleStatus;
  /** Файл модуля: реестр ссылается на существующий код, а не на описание. */
  readonly source: string;
  /** Честное пояснение: что модуль даёт редактору и чего он не делает. */
  readonly note: string;
  readonly rows: (context: RegistryContext) => readonly ModuleRow[];
  readonly actions?: readonly ModuleAction[];
}

/* ------------------------------------------------------------------ утилиты */

const EMPTY = '—';

function row(label: string, value: string): ModuleRow {
  return { label, value };
}

function num(value: number): string {
  if (!Number.isFinite(value)) return EMPTY;
  return Math.round(value).toLocaleString('ru-RU');
}

function fixed(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return EMPTY;
  return value.toFixed(digits).replace('.', ',');
}

/** Свойства считаются по реальным данным; исключение модуля — «нет данных». */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    return fallback;
  }
}

function selectedArea(context: RegistryContext): Area | null {
  const id = context.session.selection;
  if (id === null) return null;
  return context.session.doc.areas.find((area) => area.id === id) ?? null;
}

/** Состояние выбранной области: при нескольких — с наибольшим приоритетом. */
function selectedState(context: RegistryContext): AreaState | null {
  const area = selectedArea(context);
  if (area === null) return null;
  const sameMode = area.states.filter((state) => state.mode === context.session.mode);
  const ordered = [...sameMode].sort((left, right) => right.priority - left.priority);
  return ordered[0] ?? area.states[0] ?? null;
}

function areaTitle(context: RegistryContext): string {
  const area = selectedArea(context);
  if (area === null) return 'область не выбрана';
  return `${area.name} · ${area.id}`;
}

/* --------------------------------------------------------- проверка документа */

/**
 * Семантическая проверка текущего документа с реальным контекстом: области
 * действия берутся из границ сектора, полосы — из пограничного мира. Ошибки
 * и предупреждения **не блокируют** работу: редактор показывает их как
 * предупреждение (решение владельца), а решение принимает администратор.
 */
export function documentReport(doc: SectorAreasDoc, options: { readonly bounds?: SectorBounds | null } = {}): ValidationReport {
  const bounds = options.bounds ?? null;
  const scopes = bounds === null ? [] : safe(() => scopesFromBounds(bounds), []);
  const scopeIds = new Set(scopes.map((scope) => scope.id));
  const bandIdsValue = safe(() => {
    const world = createBorderWorld({ centralSystems: [CENTRAL_SYSTEM_KORHAL, BORDER_SYSTEM_KOLO] });
    return new Set(bandIds(world));
  }, new Set<string>());
  return safe(
    () => validateSectorAreas(doc, { scopeIds, bandIds: bandIdsValue }),
    { errors: ['Проверка документа недоступна: модуль контракта вернул ошибку.'], warnings: [], ok: false },
  );
}

/* -------------------------------------------------------------- список модулей */

export const SECTOR_MODULES: readonly SectorModule[] = Object.freeze([
  {
    id: 'sector-areas-contract',
    label: 'Документ областей, схема v1',
    plane: 'data',
    status: 'working',
    source: 'src/atlas/sector-areas-contract.ts',
    note: 'Разбор и сборка data/sector-areas.json плюс семантическая проверка. Схему редактор не меняет; ошибки показываются предупреждением и ничего не блокируют.',
    rows: (context) => {
      const doc = context.session.doc;
      const report = documentReport(doc, { bounds: context.bounds });
      const states = doc.areas.reduce((sum, area) => sum + area.states.length, 0);
      return [
        row('Версия схемы', String(SECTOR_AREAS_SCHEMA_VERSION)),
        row('Поле карты', `${num(doc.mapSize)} × ${num(doc.mapSize)}`),
        row('Режимы v1', MODES.map(modeLabel).join(', ')),
        row('Областей', num(doc.areas.length)),
        row('Состояний', num(states)),
        row('Мазков закрашивания', num(doc.overrides.length)),
        row('Событий журнала', num(doc.events.length)),
        row('Проверка: ошибки', num(report.errors.length)),
        row('Проверка: предупреждения', num(report.warnings.length)),
      ];
    },
  },
  {
    id: 'sector-areas-editor',
    label: 'Команды редактирования',
    plane: 'data',
    status: 'working',
    source: 'src/atlas/sector-areas-editor.ts',
    note: 'Кисть, секторный снап, вершины, состояния, история и выгрузка. Каждая команда возвращает новую сессию, поэтому отмена и повтор идут по одной истории.',
    rows: (context) => {
      const session = context.session;
      const world = safe(() => context.session.brushWidthPx / context.scale, Number.NaN);
      return [
        row('Режим новой области', modeLabel(session.mode)),
        row('Привязка', session.snapMode === 'sector' ? 'к ячейке адреса' : 'свободная'),
        row('Кисть', `${session.brushWidthPx} px · ${fixed(world)} мировых единиц`),
        row('Выбрано', areaTitle(context)),
        row('Шагов отмены', num(session.past.length)),
        row('Шагов повтора', num(session.future.length)),
        row('Следующий номер', num(session.sequence)),
      ];
    },
    actions: Object.freeze([
      Object.freeze({ id: 'undo', label: 'Отменить' }),
      Object.freeze({ id: 'redo', label: 'Повторить' }),
    ]),
  },
  {
    id: 'sector-areas-geometry',
    label: 'Геометрия и площади',
    plane: 'data',
    status: 'view',
    source: 'src/atlas/sector-areas-geometry.ts',
    note: 'Вершины, площади, центроид и самопересечения считаются по исходным контурам. Самопересечения показываются как предупреждение, а не исправляются молча.',
    rows: (context) => {
      const area = selectedArea(context);
      const vertices = context.session.doc.areas.reduce((sum, item) => sum + totalVertices(item), 0);
      if (area === null) {
        return [
          row('Вершин в документе', num(vertices)),
          row('Площадь', 'выберите область'),
        ];
      }
      const ring = area.rings[0] ?? [];
      const box = safe(() => bboxOf(ring), null);
      return [
        row('Вершин в документе', num(vertices)),
        row('Вершин у выбранной', num(totalVertices(area))),
        row('Площадь', num(ringArea(ring, area.closed))),
        row('Самопересечения', num(safe(() => selfIntersections(ring, area.closed), Number.NaN))),
        row('Габарит', box === null ? EMPTY : `${num(box.maxX - box.minX)} × ${num(box.maxY - box.minY)}`),
      ];
    },
  },
  {
    id: 'sector-areas-cascade',
    label: 'Каскад состояний',
    plane: 'data',
    status: 'view',
    source: 'src/atlas/sector-areas-cascade.ts',
    note: 'Наследование по явному parentId: своё состояние побеждает унаследованное. Нарушение вложенности считается предупреждением журнала, а не ошибкой документа.',
    rows: (context) => {
      const area = selectedArea(context);
      const doc = context.session.doc;
      const depth = safe(() => hierarchyDepth(doc), Number.NaN);
      const warnings = safe(() => checkContainment(doc).length, Number.NaN);
      if (area === null) {
        return [
          row('Глубина иерархии', num(depth)),
          row('Нарушений вложенности', num(warnings)),
          row('Предки', 'выберите область'),
        ];
      }
      return [
        row('Глубина иерархии', num(depth)),
        row('Нарушений вложенности', num(warnings)),
        row('Предков у выбранной', num(safe(() => ancestorsOf(doc, area.id).length, Number.NaN))),
        row('Режимов с состоянием', num(safe(() => statesByMode(doc, area.id).size, Number.NaN))),
      ];
    },
  },
  {
    id: 'sector-areas-lod',
    label: 'Детализация (LOD)',
    plane: 'order',
    status: 'view',
    source: 'src/atlas/sector-areas-lod.ts',
    note: 'Прореживание Рамера — Дугласа — Пейкера и сглаживание Шайкина. Пресеты меняют только показ: исходные контуры в документе не перезаписываются.',
    rows: (context) => {
      const state = selectedState(context);
      const level = safe(() => (state === null ? 0 : effectiveLevel(0, state)), 0);
      return [
        row('Пресеты панели', LOD_PRESETS.map((preset) => preset.label).join(' · ')),
        row('Уровень выбранной', String(level)),
        row('Порог прореживания', fixed(safe(() => lodEpsilon(level, state?.lodBias ?? 0), Number.NaN), 4)),
        row('Проходы сглаживания', num(safe(() => roundingIterations(state?.rounding ?? 1), Number.NaN))),
      ];
    },
  },
  {
    id: 'sector-areas-color',
    label: 'Палитра режимов',
    plane: 'order',
    status: 'view',
    source: 'src/atlas/sector-areas-color.ts',
    note: 'Цвет режима — акцент поверх нейтральной основы; задача меняет только рисунок линии. Палитра фракций берётся из данных, а не задаётся здесь.',
    rows: (context) => {
      const style = modeStyle(context.session.mode);
      const accent = style.accent === null ? 'нет, нейтральная основа' : toCss(style.accent);
      return [
        row('Режим', modeLabel(context.session.mode)),
        row('Акцент режима', accent),
        row('Нейтральный цвет', NEUTRAL_COLOR),
        row('Толщина линии', fixed(style.width, 2)),
        row('Прозрачность', fixed(style.alpha, 2)),
        row('Анимация', style.animation),
        row('Задачи в наборе', String(Object.keys(TASK_STYLES).length)),
      ];
    },
  },
  {
    id: 'sector-areas-gradient',
    label: 'Градиент состояния',
    plane: 'data',
    status: 'view',
    source: 'src/atlas/sector-areas-gradient.ts',
    note: 'Градиент считается по параметру исходного пути, поэтому не плывёт при смене детализации. Правка стопов в панель пока не выведена.',
    rows: (context) => {
      const state = selectedState(context);
      if (state === null) return [row('Градиент', 'выберите область')];
      const gradient = state.gradient;
      return [
        row('Режим', gradient.mode),
        row('Переход', gradient.blend),
        row('Направление', gradient.direction),
        row('Стопов', num(gradient.stops.length)),
        row('Переопределений', num(gradient.overrides.length)),
        row('Версия', String(gradient.version)),
      ];
    },
  },
  {
    id: 'sector-areas-force',
    label: 'Форс-закрашивание',
    plane: 'order',
    status: 'working',
    source: 'src/atlas/sector-areas-force.ts',
    note: 'Мазок по клавише F коммитится сразу и уходит поверх остальных. Состояния области при этом сохраняются: закраска не разрушает данные.',
    rows: (context) => {
      const doc = context.session.doc;
      const area = selectedArea(context);
      const own = area === null ? [] : overridesFor(doc, area.id);
      const resolved = area === null ? null : safe(() => resolvePaint(doc, area.id, context.session.mode), null);
      const color = resolved === null || resolved.rgb === null ? null : toCss(resolved.rgb);
      return [
        row('Мазков в документе', num(doc.overrides.length)),
        row('Мазков у выбранной', num(own.length)),
        row('Перебито закраской', resolved === null ? 'выберите область' : (resolved.isOverride ? 'да' : 'нет')),
        row('Итоговый цвет', color ?? (resolved === null ? 'выберите область' : 'нет состояния')),
        row('Слой z', resolved === null ? EMPTY : fixed(resolved.z, 1)),
      ];
    },
    actions: Object.freeze([
      Object.freeze({ id: 'force', label: 'Закрасить (F)' }),
    ]),
  },
  {
    id: 'sector-areas-scope',
    label: 'Области действия (Scope)',
    plane: 'spatial',
    status: 'view',
    source: 'src/atlas/sector-areas-scope.ts',
    note: 'Области действия строятся из границ сектора. Пересечения с областями видны, но правила разрешения конфликтов в панель не выведены: редактор ничего не решает молча.',
    rows: (context) => {
      if (context.bounds === null) return [row('Области действия', 'границы сектора не загружены')];
      const scopes = safe(() => scopesFromBounds(context.bounds), []);
      const area = selectedArea(context);
      const crossings = area === null ? null : safe(() => scopeCrossings(area, scopes).length, Number.NaN);
      const first = scopes[0];
      const location = area === null || first === undefined
        ? null
        : safe(() => classifyArea(first, area), null);
      return [
        row('Областей действия', num(scopes.length)),
        row('Идентификаторы', scopes.map((scope) => scope.id).join(', ') || EMPTY),
        row('Положение выбранной', location ?? 'выберите область'),
        row('Пересечений', crossings === null ? 'выберите область' : num(crossings)),
      ];
    },
  },
  {
    id: 'sector-areas-border-world',
    label: 'Пограничный мир',
    plane: 'spatial',
    status: 'view',
    source: 'src/atlas/sector-areas-border-world.ts',
    note: 'Полосы — уровень систем, а не область действия. Центр отсчёта — Корхал; Коло лежит в пограничье. Пороги и названия — глобальная настройка, из панели пока только читаются.',
    rows: (context) => {
      // Центр отсчёта — Корхал: тогда расстояние до Коло и его полоса совпадают
      // с первым тестом модели (`≈ 666,3` мировых единиц, полоса «Пограничье»).
      const world = safe(() => createBorderWorld({ centralSystems: [CENTRAL_SYSTEM_KORHAL] }), null);
      if (world === null) return [row('Пограничный мир', 'нет данных')];
      const toKolo = safe(() => distanceToCentral(world, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y), Number.NaN);
      const area = selectedArea(context);
      const band = area === null ? null : safe(() => bandAt(world, ...ringCentroid(area.rings[0] ?? [])), null);
      return [
        row('Полос', String(bandIds(world).length)),
        row('Полосы', DEFAULT_BANDS.map((item) => item.label).join(' · ')),
        row('Центров отсчёта', num(world.centralSystems.length) + ' (Корхал)'),
        row('Корхал → Коло', `${fixed(toKolo)} мировых единиц`),
        row('Полоса Коло', safe(() => bandAt(world, BORDER_SYSTEM_KOLO.x, BORDER_SYSTEM_KOLO.y)?.label ?? EMPTY, EMPTY)),
        row('Полоса выбранной', band === null ? 'выберите область' : band.label),
        row('Систем загружено', num(context.systems.length)),
      ];
    },
  },
  {
    id: 'sector-areas-journal',
    label: 'Журнал и вес набора',
    plane: 'order',
    status: 'working',
    source: 'src/atlas/sector-areas-journal.ts',
    note: 'Журнал — представление, а не второй источник истины: показывает эффективные состояния каскада и счётчики сложности. Выгружается вместе с материалом заявки.',
    rows: (context) => {
      const journal = safe(() => buildJournal(context.session.doc), null);
      if (journal === null) return [row('Журнал', 'нет данных')];
      const weight = journal.weight;
      return [
        row('Записей', num(journal.entries.length)),
        row('Состояний', num(weight.states)),
        row('Унаследованных', num(weight.inheritedStates)),
        row('Мазков', num(weight.overrides)),
        row('Событий', num(weight.events)),
        row('Глубина каскада', num(weight.maxDepth)),
        row('Вершин всего', num(weight.totalVertices)),
      ];
    },
  },
  {
    id: 'sector-areas-render',
    label: 'Отрисовка областей',
    plane: 'order',
    status: 'working',
    source: 'src/atlas/sector-areas-render.ts',
    note: 'Из документа получаются мировые контуры и цвета: порядок задаётся состоянием и закраской. Редактор этот список читает, а рисует общий рендерер карты.',
    rows: (context) => {
      const paints = safe(() => buildAreaPaints(context.session.doc, { level: 0 }), []);
      const area = selectedArea(context);
      return [
        row('Контуров на уровне L0', num(paints.length)),
        row('С закраской', num(paints.filter((paint) => paint.stateId === null).length)),
        row('Площадь выбранной', area === null ? 'выберите область' : num(areaSize(area))),
      ];
    },
  },
  {
    id: 'sector-bounds',
    label: 'Границы сектора и гало',
    plane: 'spatial',
    status: 'view',
    source: 'src/atlas/sector-bounds.ts',
    note: 'Исходные контуры из data/sector-bounds.json: сектор, гало, туманности. Редактор читает их и не перезаписывает: правка существующих границ не подключена.',
    rows: (context) => {
      const bounds = context.bounds;
      if (bounds === null) return [row('Границы', 'данные не загружены')];
      const primitives = safe(() => enumerate(bounds), []);
      const outline = safe(() => polygonAt(bounds, 'sector.outline') ?? [], []);
      const smoothed = safe(() => smoothPolyline(outline, true).curves.length, Number.NaN);
      return [
        row('Примитивов', num(primitives.length)),
        row('Состав', primitives.map((item) => `${item.id} (${item.label})`).join(', ') || EMPTY),
        row('Вершин контура сектора', num(outline.length)),
        row('Кривых после сглаживания', num(smoothed)),
      ];
    },
  },
  {
    id: 'nebula-model',
    label: 'Модель туманностей',
    plane: 'spatial',
    status: 'view',
    source: 'src/atlas/nebula-model.ts',
    note: 'Геометрия, паттерн и мигание туманности. Модель читается из границ сектора; кистей туманности в панели нет, поэтому правка не заявлена как доступная.',
    rows: (context) => {
      const bounds = context.bounds;
      if (bounds === null) return [row('Туманности', 'данные не загружены')];
      const nebulas = safe(() => enumerate(bounds).filter((item) => item.kind === 'nebula'), []);
      const first = nebulas[0];
      if (first === undefined) return [row('Туманности', 'в границах сектора нет')];
      const model = safe(() => createNebula(first.id, bounds, first.points), null);
      if (model === null) return [row('Туманности', num(nebulas.length)), row('Модель', 'не собирается из этих данных')];
      return [
        row('Туманностей', num(nebulas.length)),
        row('Вершин у первой', num(model.points.length)),
        row('Цвет', model.color),
        row('Паттерн', `${model.pattern.seed} · масштаб ${fixed(model.pattern.scale, 2)}`),
        row('Мигание', model.blink.enabled ? `включено, ${num(model.blink.intervalMs)} мс` : 'выключено'),
      ];
    },
  },
  {
    id: 'sector-halo-clip',
    label: 'Обрезка гало',
    plane: 'order',
    status: 'view',
    source: 'src/atlas/sector-halo-clip.ts',
    note: 'Производный показ: гало обрезается по кадру с сохранением фазы пунктира. Исходный контур остаётся целым — это и есть правило «обрезать только показ».',
    rows: (context) => {
      const bounds = context.bounds;
      if (bounds === null) return [row('Обрезка', 'данные не загружены')];
      const outline = safe(() => polygonAt(bounds, 'sector.outline') ?? [], []);
      // Кадр проверки равен полю карты: иначе весь контур лежит вне окна и
      // «видимых участков» было бы ноль при любых данных.
      const runs = safe(() => clipHalo(smoothPolyline(outline, true), 10000, 10000).length, Number.NaN);
      return [
        row('Кривых в контуре', num(safe(() => smoothPolyline(outline, true).curves.length, Number.NaN))),
        row('Видимых участков', Number.isFinite(runs) ? num(runs) : 'нет данных'),
        row('Кадр проверки', '10 000 × 10 000 мировых единиц'),
      ];
    },
  },
]);

export const DEFAULT_MODULE_ID = 'sector-areas-editor';

export function moduleById(id: string): SectorModule | null {
  return SECTOR_MODULES.find((module) => module.id === id) ?? null;
}

/** Порядок разделов панели: плоскость, затем порядок объявления. */
export function modulesByPlane(plane: ModulePlane): readonly SectorModule[] {
  return SECTOR_MODULES.filter((module) => module.plane === plane);
}

/** Строки свойств выбранного модуля: значения считает сам модуль. */
export function moduleRows(module: SectorModule, context: RegistryContext): readonly ModuleRow[] {
  return safe(() => module.rows(context), [row('Свойства', 'модуль не отдал значения')]);
}
