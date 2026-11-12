/* Редактор границ: интерфейс в админской копии сектора (шаг 2 §11 части 2).
 *
 * Работает только в `site/sector/admin-edit/` — на публичном `/sector/` модуль
 * не инициализируется. Данные берутся из `kernel.state.sectorAreas`, то есть из
 * того же `data/sector-areas.json`, что читает публичная страница: своего
 * снимка у редактора нет.
 *
 * Модель поведения скопирована с классического «лассо» (Photoshop, GIMP,
 * Krita): нажатие левой кнопки начинает контур, движение тянет «резиновую
 * нить», отпускание замыкает контур, `Esc` и правая кнопка прерывают штрих,
 * щелчок без движения выделяет область под курсором. Правая кнопка и колесо
 * остаются карте, поэтому рисование не спорит с панорамой.
 */

import { DEFAULT_GRADIENT, MODES, emptySectorAreasDoc, parseSectorAreas } from './sector-areas-contract.ts';
import type { Area, AreaEvent, AreaPoint, AreaState, Mode, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
import {
  addAreaFromSectorCell,
  addForceFill,
  brushWidthInWorld,
  canFillArea,
  canRedo,
  canUndo,
  createEditorSession,
  createEmptyArea,
  exportDoc,
  fillShapeAsState,
  importDoc,
  redo,
  removeArea,
  renameArea,
  selectArea,
  setBrushWidth,
  setMode,
  setParent,
  setSnapMode,
  setState,
  snapAndRecordStroke,
  thickenStroke,
  undo,
} from './sector-areas-editor.ts';
import type { EditorSession, SnapMode } from './sector-areas-editor.ts';
import { displayedGridTierFor } from './sector-scene.ts';
import type { FrameViewport, SceneCamera } from './sector-scene.ts';
import { snapStrokeToDisplayedGrid } from './sector-areas-snap.ts';
import { areaSize } from './sector-areas-render.ts';
import { closedStrokeRing, pointHitsArea, strokeVertices, totalVertices } from './sector-areas-geometry.ts';
import { MODULE_HELP } from './sector-areas-module-help.ts';
import { helpTitle, markdownToHtml } from './sector-areas-help.ts';
import { createFactionPalette } from './sector-areas-color.ts';
import type { FactionPalette } from './sector-areas-color.ts';
import {
  TOOL_HINTS,
  TOOL_IDS,
  TOOL_LABELS,
  TOOL_TITLES,
  addVertex,
  beginDrag,
  cancelInput,
  createToolState,
  endDrag,
  finishVertices,
  isToolId,
  moveCursor,
  moveDrag,
  previewDraft,
  selectTool,
  toolInput,
  validateDraft,
} from './sector-areas-tools.ts';
import type { ShapeDraft } from './sector-areas-tools.ts';
import {
  DEFAULT_MODULE_ID,
  MODULE_RELATIONS,
  PLANE_QUESTIONS,
  PLANE_TITLES,
  RELATION_KIND_TITLES,
  SECTOR_MODULES,
  STATUS_TITLES,
  documentReport,
  isolatedModuleIds,
  modeLabel,
  moduleActions,
  moduleById,
  moduleRows,
  modulesByPlane,
  relationsForModule,
} from './sector-areas-registry.ts';
import type {
  ModuleRelation,
  ModuleRelationKind,
  RegistryContext,
  RegistrySystem,
  SectorModule,
} from './sector-areas-registry.ts';
import type { AtlasView, SystemRecord } from './config.ts';
import { NO_FACTION_KEY } from './config.ts';
import { PROPERTY_FIELDS, createPropertySession, editProperty, propertyChanges, redoProperty, undoProperty } from './sector-property-session.ts';
import type { PropertySession } from './sector-property-session.ts';
import { preparePropertyDraft, restorePropertyDraft } from './sector-property-draft.ts';
import { preparePropertyIssuePreview } from './sector-property-issue-preview.ts';
import type { PropertyIssuePreview } from './sector-property-issue-preview.ts';
import { newRequestId, preparePropertyPacket } from './sector-property-packet.ts';
import { SUBMIT_MESSAGES, readGatewayUrl, submitPropertyPacket } from './sector-property-submit.ts';
import type { SubmitOutcome } from './sector-property-submit.ts';
import type { PropertyField } from './sector-property-overlay.ts';
import { canContinueStroke, canStartStroke, isDrawButton as isDrawButtonRule, isTextEntryTarget } from './pointer-rules.ts';
import type { AtlasKernel } from './config.ts';

export const DRAFT_KEY = 'timeline.sector-areas.draft.v1';
export const PANEL_KEY = 'timeline.sector-areas.panel.v1';
/** Минимальный шаг между точками мазка в пикселях экрана. */
export const MIN_STEP_PX = 6;
/** Граница «щелчок или штрих»: меньше столько точек — это выбор, а не контур. */
export const CLICK_POINTS = 3;

export interface SectorAreasEditorUiOptions {
  readonly kernel: AtlasKernel;
  /** Панель `[data-admin-editor]`. */
  readonly panel: HTMLElement | null;
  /**
   * Родитель канвы — `.map-stage`. Перехватчик вешается именно на него в фазе
   * перехвата: так он срабатывает раньше обработчиков панорамы на канве.
   */
  readonly stage: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Текст справки в разметке Markdown; пусто — кнопка «?» показывает заглушку. */
  readonly helpText?: string;
  /** Хранилище черновика и состояния панели; `null` — отключены. */
  readonly storage?: Storage | null;
  /**
   * Линейная правка границ активна: Ctrl+Z/Ctrl+Shift+Z уступают модулю
   * правки линий, а рисование штрихов выключено. Заглушка `() => false`.
   */
  readonly isLineMode?: () => boolean;
  /**
   * Инструмент рисования включён или выключен — в том числе программно.
   * Правка линий по этому сигналу выключается: два обработчика указателя на
   * одной стадии карты одновременно работать не должны.
   */
  readonly onEnableChange?: (on: boolean) => void;
  /** Уведомление об изменении сессии (импорт, черновик, выбор, правки) для смежных панелей. */
  readonly onSessionChange?: () => void;
  /**
   * Итог `Ctrl+Z`/`Ctrl+Shift+Z` строкой для панели.
   *
   * История общая у редактора областей и иерархии, а показывать результат
   * некому: блок редактора виден только на экране журнала, тогда как правка
   * линии пары идёт из блока иерархии. Сообщение уходит туда.
   */
  readonly onHistory?: (kind: 'undo' | 'redo', message: string) => void;
}

export interface SectorAreasEditorDraft {
  save(): boolean;
  load(): boolean;
  clear(): void;
  info(): string | null;
}

export interface SectorAreasEditorUiApi {
  session(): EditorSession;
  /**
   * Подменяет сессию новой (из команд иерархии: якоря, группы, сочетания).
   * История и журнал общие: `applySession` просто кладёт сессию и применяет
   * её документ к состоянию карты.
   */
  applySession(next: EditorSession): void;
  doc(): SectorAreasDoc;
  screen(): EditorScreen;
  setScreen(screen: EditorScreen): void;
  refresh(): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** Свёрнута ли панель; `null` — панели нет. */
  collapsed(): boolean | null;
  setCollapsed(value: boolean): void;
  draft: SectorAreasEditorDraft;
  /** Документ в виде JSON для выгрузки. */
  exportJson(): string;
  /** Готовый материал для заявки в GitHub. */
  requestMaterial(): string;
  destroy(): void;
}

/* -------------------------------------------------------------- чистые утилиты */

/** Правая и средняя кнопки рисовать не должны: это панорама и контекст карты. */
export function isDrawButton(button: number): boolean {
  return isDrawButtonRule(button);
}

/**
 * Прореживает мазок: точки ближе `minDistance` не несут формы, но раздувают
 * документ. Первая и последняя сохраняются всегда — начало и конец штриха
 * важны для замыкания.
 */
export function strokePoints(points: readonly AreaPoint[], minDistance: number): AreaPoint[] {
  if (points.length === 0 || minDistance <= 0) return [...points];
  const kept: AreaPoint[] = [points[0]!];
  let last = points[0]!;
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const dx = point[0] - last[0];
    const dy = point[1] - last[1];
    if (Math.hypot(dx, dy) < minDistance) continue;
    kept.push(point);
    last = point;
  }
  const tail = points[points.length - 1]!;
  if (kept.length === 0 || kept[kept.length - 1] !== tail) kept.push(tail);
  return kept;
}

/** Команда редактора, которую несёт клавиша. */
export type EditorHotkey = 'undo' | 'redo' | 'force' | 'finish' | 'cancel' | null;

/**
 * Разбор клавиши редактора: чистая функция, обработчик только вызывает её.
 *
 * Клавиша берётся по `event.code` — физическому коду, а не по `event.key`.
 * На кириллической раскладке `Ctrl+Z` приходит как «я» и `F` — как «а»:
 * сравнение по `event.key` молча не срабатывало, и отмена казалась
 * неработающей. Физический код от раскладки не зависит.
 *
 * Сочетание с `Ctrl`/`Cmd`, отличное от `Z`, редактору не принадлежит:
 * `Ctrl+F` остаётся поиском браузера.
 */
export function editorHotkey(event: {
  readonly code?: string;
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}): EditorHotkey {
  const withModifier = event.ctrlKey === true || event.metaKey === true;
  if (withModifier) {
    // Повтор — `Ctrl+Shift+Z`: сочетание из руководства, а не выдуманное здесь.
    if (event.code === 'KeyZ') return event.shiftKey === true ? 'redo' : 'undo';
    return null;
  }
  if (event.code === 'KeyF') return 'force';
  if (event.key === 'Enter') return 'finish';
  if (event.key === 'Escape') return 'cancel';
  return null;
}

/**
 * Владелец `Ctrl+Z`/`Ctrl+Shift+Z` при включённой правке линий — модуль правки
 * линий. Обе клавиши уходят ему вместе: если отдавать только отмену, одно
 * нажатие обрабатывают два журнала, и шаг «съедается» дважды.
 */
export function hotkeyOwnedByLineMode(hotkey: EditorHotkey, lineMode: boolean): boolean {
  return lineMode && (hotkey === 'undo' || hotkey === 'redo');
}

/** Строка журнала: `override · a-1 · Форс-закрашивание force-3 цветом #00ff00`. */
export function eventLine(event: AreaEvent): string {
  const area = event.areaId === null ? '' : ' · ' + event.areaId;
  const note = event.note === null ? 'без комментария' : event.note;
  return `${event.kind}${area} · ${note}`;
}

/** Подпись последней записи журнала или `null`, если журнал пуст. */
export function lastEventNote(doc: { readonly events: readonly AreaEvent[] }): string | null {
  const last = doc.events.at(-1);
  if (last === undefined) return null;
  const note = last.note === null ? null : last.note.trim();
  return note === null || note.length === 0 ? null : note;
}

/**
 * Текст уведомления об отмене/повторе.
 *
 * Клавиша и результат меняют документ одинаково у всех правок — и контуров, и
 * линии раздела пары. Без подписи `Ctrl+Z` выглядел как «ничего не произошло»:
 * откат ручной линии возвращает автолинию, а она может проходить в считанных
 * пикселях от прежней, и отличить одно от другого на карте нечем.
 */
export function historyNotice(
  kind: 'undo' | 'redo',
  note: string | null,
  applied = true,
): string {
  if (!applied) {
    return kind === 'undo'
      ? 'Отменять нечего: история правок пуста.'
      : 'Повторять нечего: история повтора пуста.';
  }
  const combo = kind === 'undo' ? 'Ctrl+Z' : 'Ctrl+Shift+Z';
  const title = kind === 'undo' ? 'Отменено' : 'Повторено';
  return note === null ? `${title} (${combo}).` : `${title} (${combo}): ${note}.`;
}

/** Заголовок области в списке: имя, вершины и (при наличии) число штрихов. */
export function areaLabel(area: Area): string {
  const vertices = totalVertices(area) + strokeVertices(area);
  const strokes = area.strokes?.length ?? 0;
  return strokes > 0
    ? `${area.name} (${vertices} верш., штрихов: ${strokes})`
    : `${area.name} (${vertices} верш.)`;
}

/**
 * Состояние по умолчанию: цвет режима, полный диапазон глубин.
 *
 * Решение владельца: без выбранной фракции состояние **нейтральное**
 * (`factionMode: 'neutral'`, пустой список). Прежнее `single` с пустым
 * списком нарушало контракт: `validateSectorAreas` считал это ошибкой.
 */
export function createDefaultState(id: string, mode: Mode): AreaState {
  return {
    id,
    mode,
    factionMode: 'neutral',
    factionIds: [],
    task: 'none',
    visibleFrom: 0,
    visibleTo: 12,
    z: 10,
    priority: 0,
    lodBias: 0,
    rounding: 1,
    gradient: DEFAULT_GRADIENT,
    override: false,
    label: null,
  };
}

/**
 * Материал для заявки в GitHub: что изменилось, чем проверено и сам JSON
 * вложением. Заявку оформляет владелец, здесь только заготовка.
 */
export function requestMaterial(doc: SectorAreasDoc, options: { readonly title?: string } = {}): string {
  const title = options.title ?? 'Области сектора: изменения границ';
  const lines: string[] = [
    '# ' + title,
    '',
    '## Что изменилось',
    '',
  ];
  const events = doc.events.slice(-30);
  if (events.length === 0) {
    lines.push('— Журнал пуст: изменений не было.', '');
  } else {
    for (const event of events) lines.push('- ' + eventLine(event));
    lines.push('');
  }
  lines.push('## Состав документа', '');
  lines.push(`- Областей: ${doc.areas.length}`);
  lines.push(`- Штрихов в областях: ${doc.areas.reduce((sum, area) => sum + (area.strokes?.length ?? 0), 0)}`);
  lines.push(`- Состояний: ${doc.areas.reduce((sum, area) => sum + area.states.length, 0)}`);
  lines.push(`- Мазков форс-закрашивания: ${doc.overrides.length}`);
  lines.push(`- Событий в журнале: ${doc.events.length}`);
  lines.push('');
  lines.push('## Проверки', '');
  lines.push('Материал собран офлайн: перечисленные проверки **в браузере не запускались**, и редактор не выдаёт себя за CI. Их выполняет администратор перед заявкой.');
  lines.push('');
  lines.push('- [ ] `npm run build` — типы и сборка (не запускалось).');
  lines.push('- [ ] `npm test` — набор тестов репозитория (не запускалось).');
  lines.push('- [ ] `python3 -B tools/check_docs.py` — документация (не запускалось).');
  lines.push('- [ ] Страница `/sector/admin-edit/`: области на месте, журнал не пустой, лишних мазков закрашивания нет.');
  lines.push('');
  lines.push('Статус изменений: **демо, не отправлено**. Файл скачан, заявка не создана: её оформляет администратор, применяет владелец.');
  lines.push('');
  lines.push('## Файл данных', '');
  lines.push('Полный документ — вложением ниже, он же выгружается кнопкой «Скачать JSON».');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(doc, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Фильтр отображаемых рёбер графа по плоскости связи. */
export type RelationFilter = 'all' | ModuleRelationKind;

/** Активный рабочий экран правой панели: в каждый момент открыт ровно один. */
export type EditorScreen = 'module' | 'dependencies' | 'draw' | 'properties' | 'changes' | 'lines' | 'hierarchy' | 'point-properties';

export function isEditorScreen(value: string): value is EditorScreen {
  return value === 'module'
    || value === 'dependencies'
    || value === 'draw'
    || value === 'properties'
    || value === 'changes'
    || value === 'lines'
    || value === 'hierarchy'
    || value === 'point-properties';
}

interface GraphNodeBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly short: string;
}

const GRAPH_NODE_BOXES: Readonly<Record<string, GraphNodeBox>> = Object.freeze({
  'sector-areas-contract': { x: 40, y: 14, w: 44, h: 44, short: 'Документ' },
  'sector-bounds': { x: 232, y: 30, w: 44, h: 44, short: 'Границы' },
  'sector-areas-geometry': { x: 122, y: 88, w: 44, h: 44, short: 'Геометрия' },
  'sector-areas-snap': { x: 23, y: 144, w: 44, h: 44, short: 'Привязка' },
  'sector-areas-cascade': { x: 130, y: 186, w: 44, h: 44, short: 'Наследование' },
  'sector-areas-scope': { x: 240, y: 128, w: 44, h: 44, short: 'Принадлежность' },
  'sector-areas-gradient': { x: 30, y: 252, w: 44, h: 44, short: 'Переход цвета' },
  'sector-areas-color': { x: 14, y: 333, w: 44, h: 44, short: 'Палитра' },
  'sector-areas-lod': { x: 244, y: 236, w: 44, h: 44, short: 'Детализация' },
  'sector-areas-journal': { x: 235, y: 340, w: 44, h: 44, short: 'Журнал' },
  'sector-areas-force': { x: 120, y: 305, w: 44, h: 44, short: 'Закрашивание' },
  'sector-areas-editor': { x: 120, y: 403, w: 44, h: 44, short: 'Команды' },
  'sector-areas-render': { x: 28, y: 438, w: 44, h: 44, short: 'Отрисовка' },
  'nebula-model': { x: 245, y: 408, w: 44, h: 44, short: 'Туманности' },
  'sector-halo-clip': { x: 148, y: 486, w: 44, h: 44, short: 'Обрезка гало' },
  'sector-areas-border-world': { x: 138, y: 575, w: 44, h: 44, short: 'Пограничный мир' },
});

const RELATION_FILTER_LABELS: Readonly<Record<RelationFilter, string>> = Object.freeze({
  all: 'Все',
  data: 'Данные',
  spatial: 'Геометрия',
  order: 'Порядок',
});

export function isRelationFilter(value: string): value is RelationFilter {
  return value === 'all' || value === 'data' || value === 'spatial' || value === 'order';
}

/**
 * Чистая разметка графа модулей: рёбра строятся только по подтверждённым
 * `MODULE_RELATIONS`, а узлы без рёбер выводятся в отдельной зоне внизу.
 */
export function moduleGraphHtml(selectedId: string, filter: RelationFilter = 'all'): string {
  const isolated = new Set(isolatedModuleIds());
  const visibleRelations: readonly ModuleRelation[] = filter === 'all'
    ? MODULE_RELATIONS
    : MODULE_RELATIONS.filter((item) => item.kind === filter);

  const fallbackBoxes = new Map<string, GraphNodeBox>();
  let fallbackIndex = 0;
  for (const mod of SECTOR_MODULES) {
    if (GRAPH_NODE_BOXES[mod.id] === undefined) {
      fallbackBoxes.set(mod.id, {
        x: 12 + (fallbackIndex % 2) * 152,
        y: 640 + Math.floor(fallbackIndex / 2) * 54,
        w: 140,
        h: 44,
        short: mod.label.slice(0, 16),
      });
      fallbackIndex += 1;
    }
  }
  const boxOf = (id: string): GraphNodeBox | null => GRAPH_NODE_BOXES[id] ?? fallbackBoxes.get(id) ?? null;

  const neighborIds = new Set<string>();
  for (const rel of visibleRelations) {
    if (rel.from === selectedId) neighborIds.add(rel.to);
    if (rel.to === selectedId) neighborIds.add(rel.from);
  }

  const edgesSvg = visibleRelations.map((rel) => {
    const fromBox = boxOf(rel.from);
    const toBox = boxOf(rel.to);
    if (fromBox === null || toBox === null) return '';
    const fromX = fromBox.x + fromBox.w / 2;
    const fromY = fromBox.y + fromBox.h / 2;
    const toX = toBox.x + toBox.w / 2;
    const toY = toBox.y + toBox.h / 2;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const length = Math.max(1, Math.hypot(dx, dy));
    // Кривая выходит из узла и заканчивается перед его окружностью.
    const x1 = fromX + dx / length * 10;
    const y1 = fromY + dy / length * 10;
    const x2 = toX - dx / length * 13;
    const y2 = toY - dy / length * 13;
    const bend = rel.kind === 'spatial' ? -18 : 18;
    const controlX = (x1 + x2) / 2 - dy / length * bend;
    const controlY = (y1 + y2) / 2 + dx / length * bend;
    const active = rel.from === selectedId || rel.to === selectedId;
    return `<path class="admin-editor-graph-edge" data-kind="${rel.kind}" data-from="${escapeHtml(rel.from)}"`
      + ` data-to="${escapeHtml(rel.to)}" data-active="${active ? 'true' : 'false'}"`
      + ` marker-end="url(#adminGraphArrow-${rel.kind})"`
      + ` d="M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${controlX.toFixed(1)} ${controlY.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}">`
      + `<title>${escapeHtml(rel.from)} → ${escapeHtml(rel.to)} (${escapeHtml(RELATION_KIND_TITLES[rel.kind])}): ${escapeHtml(rel.note)}</title>`
      + '</path>';
  }).join('');

  const svgHeight = fallbackIndex > 0 ? 648 + Math.ceil(fallbackIndex / 2) * 54 : 632;
  const nodesSvg = SECTOR_MODULES.map((mod) => {
    const box = boxOf(mod.id);
    if (box === null) return '';
    const current = mod.id === selectedId;
    const linked = neighborIds.has(mod.id);
    const isIsolated = isolated.has(mod.id);
    const cx = (box.x + box.w / 2).toFixed(1);
    const cy = (box.y + box.h / 2).toFixed(1);
    const labelY = (box.y + box.h / 2 + 27).toFixed(1);
    return `<g class="admin-editor-graph-node${current ? ' is-current' : ''}${linked ? ' is-linked' : ''}"`
      + ` role="button" tabindex="0"`
      + ` aria-label="${escapeHtml(mod.label + ' — открыть модуль')}"`
      + ` data-action="module" data-module="${escapeHtml(mod.id)}" data-plane="${mod.plane}"`
      + ` data-status="${mod.status}" data-isolated="${isIsolated ? 'true' : 'false'}">`
      + `<title>${escapeHtml(mod.label)} · ${escapeHtml(PLANE_TITLES[mod.plane])} · ${escapeHtml(STATUS_TITLES[mod.status])}${isIsolated ? ' (самостоятельный узел без связей)' : ''}</title>`
      + `<circle class="admin-editor-graph-hit" cx="${cx}" cy="${cy}" r="22"></circle>`
      + `<circle class="admin-editor-graph-ring" cx="${cx}" cy="${cy}" r="12"></circle>`
      + `<circle class="admin-editor-graph-dot" cx="${cx}" cy="${cy}" r="6"></circle>`
      + `<text x="${cx}" y="${labelY}" text-anchor="middle">${escapeHtml(box.short)}</text>`
      + '</g>';
  }).join('');

  const filterButtons = (['all', 'data', 'spatial', 'order'] as const).map((plane) => {
    const current = plane === filter;
    return `<button type="button" class="admin-editor-graph-filter${current ? ' is-current' : ''}"`
      + ` data-action="relation-filter" data-plane="${plane}" aria-pressed="${current ? 'true' : 'false'}">`
      + `${escapeHtml(RELATION_FILTER_LABELS[plane])}</button>`;
  }).join('');

  return [
    '<div class="admin-editor-graph-pane" data-editor-graph>',
    '  <div class="admin-editor-graph-head">',
    '    <p class="admin-editor-meta">Что от чего зависит и на что влияет</p>',
    '    <div class="admin-editor-graph-filters" role="group" aria-label="Плоскость связей графа">' + filterButtons + '</div>',
    '  </div>',
    '  <p class="admin-editor-graph-legend">',
    '    <span data-kind="data">● связи данных</span>',
    '    <span data-kind="spatial">● пространственное влияние</span>',
    '    <span data-kind="order">● порядок отрисовки</span>',
    '  </p>',
    '  <p class="admin-editor-hint">Стрелка: источник → использующий его модуль. Клик по узлу — описание. Связи схемы не редактируются.</p>',
    `  <svg class="admin-editor-graph-svg" viewBox="0 0 320 ${svgHeight}" role="group" aria-label="Граф подтверждённых связей модулей">`,
    '    <defs>',
    '      <marker id="adminGraphArrow-data" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,1 L7,4 L0,7 z" fill="#a6d9d0"></path></marker>',
    '      <marker id="adminGraphArrow-spatial" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,1 L7,4 L0,7 z" fill="#8ad7c2"></path></marker>',
    '      <marker id="adminGraphArrow-order" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,1 L7,4 L0,7 z" fill="#9ec5ff"></path></marker>',
    '    </defs>',
    '    <g class="admin-editor-graph-edges">' + edgesSvg + '</g>',
    '    <line class="admin-editor-graph-divider" x1="12" y1="550" x2="308" y2="550"></line>',
    '    <text class="admin-editor-graph-caption" x="160" y="566" text-anchor="middle">Отдельно · без подтверждённых связей</text>',
    '    <g class="admin-editor-graph-nodes">' + nodesSvg + '</g>',
    '  </svg>',
    '</div>',
  ].join('');
}

function download(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Подписи режимов живут в чистом реестре: панель не держит второй словарь. */
export { modeLabel };

/* ------------------------------------------------------------------ редактор */

export function createSectorAreasEditorUi(options: SectorAreasEditorUiOptions): SectorAreasEditorUiApi {
  const { kernel, panel, stage, canvas } = options;
  const helpText = options.helpText ?? '';
  const storage = options.storage === undefined
    ? (typeof window === 'undefined' ? null : window.localStorage)
    : options.storage;

  let session: EditorSession = createEditorSession(kernel.state.sectorAreas ?? emptySectorAreasDoc());
  let on = false;
  let drawing = false;
  /**
   * Инструмент и его незавершённый ввод — состояние интерфейса, а не документа:
   * переключение не попадает ни в журнал, ни в историю отмен.
   */
  let toolState = createToolState('free-line');
  /**
   * Фракция новой области. `null` — нейтральная: по решению владельца новая
   * область начинает нейтральной, пока администратор не выберет фракцию.
   */
  let faction: string | null = null;
  let color = '#ffcc00';
  let notice: string | null = null;
  let capturedId: number | null = null;

  /* Выбранный в реестре модуль: панель показывает его свойства. */
  let moduleId = DEFAULT_MODULE_ID;
  /* Активный экран рабочей области: как в Obsidian, одновременно открыт один экран. */
  let activeScreen: EditorScreen = 'dependencies';
  let pointSession: PropertySession | null = null;
  let pointIndex = 0;
  let pointNotice: string | null = null;
  let pointReview: { preview: PropertyIssuePreview; acknowledged: boolean; confirmed: boolean } | null = null;
  /** Заявка, подготовленная к отправке: ID попытки фиксируется до запроса. */
  let pointSubmission: { requestId: string; title: string; body: string; snapshot: string; fromPreview: boolean } | null = null;
  let pointSubmitState: 'idle' | 'sending' = 'idle';
  let pointSubmitOutcome: SubmitOutcome | null = null;
  /* Фильтр отображаемых рёбер графа модулей: состояние интерфейса, не документа. */
  let relationFilter: RelationFilter = 'all';
  /* Предпросмотр «было → стало»: сравнение с документом на момент открытия. */
  let previewOn = false;
  /* Тир секторного снапа: 5, 6 или 7 букв адреса (глубже — мельче ячейка). */
  let snapLetters: 5 | 6 | 7 = 5;
  /* Документ «как было»: загруженный data/sector-areas.json. Не перезаписывается. */
  const baseline: SectorAreasDoc = session.doc;

  /* Окно справки создаётся лениво и живёт вне панели: у панели своя прокрутка,
   * а окно должно лежать поверх карты. */
  let help: HTMLElement | null = null;
  let helpReturn: HTMLElement | null = null;

  /* Предпросмотр штриха: отдельный канвас поверх карты. Области рисует общий
   * рендер сцены, а «резиновая нить» живёт только во время штриха. */
  let preview: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;
  let overlayW = 1;
  let overlayH = 1;

  /* Область, выбранная в панели: без неё клавиша `F` не знает, что закрашивать. */
  function selected(): Area | null {
    return session.doc.areas.find((area) => area.id === session.selection) ?? null;
  }

  /** Кладёт документ обратно в состояние карты — рендер читает его оттуда же. */
  function apply(): void {
    kernel.state.sectorAreas = session.doc;
    kernel.renderer.requestRender();
    refresh();
    options.onSessionChange?.();
  }

  function commit(next: EditorSession): void {
    session = next;
    apply();
  }

  /* ------------------------------------------------------- предпросмотр штриха */

  function previewCanvas(): CanvasRenderingContext2D | null {
    if (stage === null || typeof document === 'undefined') return null;
    if (preview === null) {
      const node = document.createElement('canvas');
      node.className = 'admin-editor-brush-preview';
      node.setAttribute('aria-hidden', 'true');
      stage.appendChild(node);
      preview = node;
      previewCtx = node.getContext('2d');
    }
    const w = Math.max(1, Math.round(stage.clientWidth));
    const h = Math.max(1, Math.round(stage.clientHeight));
    const dpr = Math.min(typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1), 2);
    if (preview.width !== w * dpr || preview.height !== h * dpr) {
      preview.width = w * dpr;
      preview.height = h * dpr;
    }
    preview.style.width = w + 'px';
    preview.style.height = h + 'px';
    overlayW = w;
    overlayH = h;
    if (previewCtx !== null) {
      previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      previewCtx.clearRect(0, 0, w, h);
    }
    return previewCtx;
  }

  function screenOf(point: AreaPoint): { x: number; y: number } | null {
    return kernel.renderer.toScreen(point[0], point[1]);
  }

  /** Контекст реестра: свойства модулей считаются по живым данным карты. */
  function registryContext(): RegistryContext {
    const state = kernel.state;
    const view: AtlasView | undefined = state.view;
    const systems: readonly SystemRecord[] = state.systems ?? [];
    // Координата системы — пара `[x, y]`, а не объект: приводим к виду реестра.
    const projected = systems
      .map((system) => {
        const coord = system.coord;
        return coord === null ? null : { name: system.name, x: coord[0], y: coord[1] };
      })
      .filter((item): item is RegistrySystem => item !== null);
    return {
      session,
      bounds: state.sectorBounds ?? null,
      systems: projected,
      scale: view !== undefined && Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1,
    };
  }

  /** Текущий кадр для выбора отображаемого яруса сетки: те же размеры, что у рендерера. */
  function currentViewport(): FrameViewport {
    const vp = kernel.state.viewport;
    const w = vp !== undefined && Number.isFinite(vp.w) && vp.w > 0
      ? vp.w
      : Math.max(1, stage?.clientWidth ?? canvas?.clientWidth ?? 1000);
    const h = vp !== undefined && Number.isFinite(vp.h) && vp.h > 0
      ? vp.h
      : Math.max(1, stage?.clientHeight ?? canvas?.clientHeight ?? 1000);
    return { w, h };
  }

  /** Камера сцены в мировых координатах — совпадает с `sceneCamera` в `canvas-renderer.ts`. */
  function currentCamera(): SceneCamera {
    const vp = currentViewport();
    const scale = registryContext().scale;
    const center = typeof kernel.renderer.toWorld === 'function'
      ? kernel.renderer.toWorld(vp.w / 2, vp.h / 2)
      : { x: 5000, y: 5000 };
    return {
      centerX: Number.isFinite(center.x) ? center.x : 5000,
      centerY: Number.isFinite(center.y) ? center.y : 5000,
      visibleWidth: vp.w / scale,
    };
  }

  /* ------------------------------------------------ сравнение контуров с моментом открытия */

  /** Подпись состояния кадра: по ней видно, что карту сдвинули или приблизили. */
  function viewKey(): string {
    const view: AtlasView | undefined = kernel.state.view;
    const scale = view === undefined ? 1 : view.scale;
    const tx = view === undefined ? 0 : view.tx;
    const ty = view === undefined ? 0 : view.ty;
    const width = stage === null ? 0 : stage.clientWidth;
    const height = stage === null ? 0 : stage.clientHeight;
    return `${scale}|${tx}|${ty}|${width}x${height}`;
  }

  function tracePolyline(
    ctx: CanvasRenderingContext2D,
    points: readonly AreaPoint[],
    color: string,
    dash: readonly number[],
  ): void {
    if (points.length < 2) return;
    let started = false;
    ctx.beginPath();
    ctx.setLineDash([...dash]);
    ctx.strokeStyle = color;
    for (const point of points) {
      const screen = screenOf(point);
      if (screen === null) continue;
      if (started) ctx.lineTo(screen.x, screen.y);
      else {
        ctx.moveTo(screen.x, screen.y);
        started = true;
      }
    }
    if (!started) return;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function traceRing(ctx: CanvasRenderingContext2D, area: Area, color: string, dash: readonly number[]): void {
    const ring = area.rings[0];
    if (ring !== undefined && ring.length >= 2) {
      tracePolyline(ctx, ring, color, dash);
    }
    for (const stroke of area.strokes ?? []) {
      const pts = stroke.closed && stroke.points.length > 1
        ? [...stroke.points, stroke.points[0]!]
        : stroke.points;
      tracePolyline(ctx, pts, color, dash);
    }
  }

  /**
   * «Было» — документ на момент открытия, «стало» — текущая сессия. Обе стороны
   * только читаются: предпросмотр ничего не перезаписывает ни в данных, ни в
   * состоянии карты.
   */
  function drawCompare(ctx: CanvasRenderingContext2D): void {
    const before = baseline.areas;
    const after = session.doc.areas;
    const afterIds = new Set(after.map((area) => area.id));
    const beforeIds = new Set(before.map((area) => area.id));
    for (const area of before) {
      const removed = !afterIds.has(area.id);
      traceRing(ctx, area, removed ? 'rgba(255, 122, 108, .95)' : 'rgba(255, 226, 200, .5)', removed ? [] : [6, 5]);
    }
    for (const area of after) {
      const added = !beforeIds.has(area.id);
      traceRing(ctx, area, added ? 'rgba(126, 232, 168, .95)' : 'rgba(198, 232, 255, .72)', []);
    }
  }

  /**
   * «Резиновая нить»: черновик текущего инструмента. Замкнутая фигура
   * показывается замкнутой, открытая линия — открытой: предпросмотр не должен
   * обещать замыкания, которого не будет. При привязке «к рёбрам сетки» поверх
   * пунктирной траектории курсора сразу рисуется живой контур по рёбрам сетки
   * (само состояние инструмента и документ до завершения ввода не меняются).
   */
  function drawStroke(ctx: CanvasRenderingContext2D): void {
    const draft = previewDraft(toolState);
    if (draft === null) return;
    const ring = draft.closed && draft.points.length > 1
      ? [...draft.points, draft.points[0]!]
      : draft.points;
    const points: { x: number; y: number }[] = [];
    for (const point of ring) {
      const screen = screenOf(point);
      if (screen !== null) points.push(screen);
    }
    if (points.length === 0) return;

    const gridSnapActive = session.snapMode === 'grid' && draft.points.length >= 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, session.brushWidthPx / 2);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = gridSnapActive ? 'rgba(255, 226, 231, .42)' : 'rgba(255, 226, 231, .92)';
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (gridSnapActive) {
      const snapped = snapStrokeToDisplayedGrid(draft.points, currentViewport(), currentCamera(), {
        closed: draft.closed,
      }).points;
      const snappedRing = draft.closed && snapped.length > 1
        ? [...snapped, snapped[0]!]
        : snapped;
      const snappedScreen: { x: number; y: number }[] = [];
      for (const point of snappedRing) {
        const screen = screenOf(point);
        if (screen !== null) snappedScreen.push(screen);
      }
      if (snappedScreen.length >= 2) {
        ctx.lineWidth = Math.max(1.8, session.brushWidthPx / 2 + 0.6);
        ctx.strokeStyle = 'rgba(138, 215, 194, .96)';
        ctx.beginPath();
        ctx.moveTo(snappedScreen[0]!.x, snappedScreen[0]!.y);
        for (let i = 1; i < snappedScreen.length; i += 1) ctx.lineTo(snappedScreen[i]!.x, snappedScreen[i]!.y);
        ctx.stroke();
      }
    }

    ctx.fillStyle = 'rgba(255, 226, 231, .95)';
    // У вершинных инструментов показываются сами вершины; штрих точек не копит.
    const markers = toolInput(toolState.tool) === 'vertices' ? points : points.slice(0, 1);
    for (const point of markers) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Один проход по оверлею: штрих во время рисования и сравнение по флажку. */
  function paintOverlay(): void {
    const ctx = previewCanvas();
    if (ctx === null) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, overlayW, overlayH);
    ctx.clip();
    if (previewOn) drawCompare(ctx);
    if (drawing) drawStroke(ctx);
    ctx.restore();
  }

  /* Карта двигается своими обработчиками, поэтому предпросмотр перерисовывается
   * по кадру — но только когда сменился вид камеры, а не каждый кадр подряд. */
  let overlayFrame = 0;
  let lastViewKey = '';

  function overlayStep(): void {
    overlayFrame = 0;
    if (!previewOn) return;
    const key = viewKey();
    if (key !== lastViewKey) {
      lastViewKey = key;
      paintOverlay();
    }
    overlayFrame = typeof window === 'undefined' ? 0 : window.requestAnimationFrame(overlayStep);
  }

  function startOverlayLoop(): void {
    if (typeof window === 'undefined' || overlayFrame !== 0) return;
    lastViewKey = '';
    overlayFrame = window.requestAnimationFrame(overlayStep);
  }

  function stopOverlayLoop(): void {
    if (overlayFrame !== 0 && typeof window !== 'undefined') window.cancelAnimationFrame(overlayFrame);
    overlayFrame = 0;
    lastViewKey = '';
    clearPreview();
  }

  function clearPreview(): void {
    const ctx = previewCtx;
    if (ctx === null || preview === null) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.restore();
  }

  /* ------------------------------------------------------------------- справка */

  function helpHtml(): string {
    if (helpText.trim().length === 0) {
      return '<p class="admin-editor-hint">Текст справки не передан: окно открывается, но файла руководства в сборке нет.</p>';
    }
    return markdownToHtml(helpText);
  }

  function ensureHelp(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    if (help !== null) return help;
    const node = document.createElement('div');
    node.className = 'admin-editor-help-backdrop';
    node.hidden = true;
    node.innerHTML = [
      '<div class="admin-editor-help-dialog" role="dialog" aria-modal="true" aria-labelledby="adminEditorHelpTitle">',
      '  <div class="admin-editor-help-head">',
      '    <h2 id="adminEditorHelpTitle" data-editor-help-title>Справка редактора</h2>',
      '    <button class="admin-editor-help-close icon-button" type="button" data-action="help-close" title="Закрыть справку" aria-label="Закрыть справку"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"></path></svg></button>',
      '  </div>',
      '  <div class="admin-editor-help-body" data-editor-help></div>',
      '</div>',
    ].join('');
    node.addEventListener('click', function (event): void {
      if (event.target === node) closeHelp();
    });
    document.body.appendChild(node);
    help = node;
    return node;
  }

  function openHelp(): void {
    const dialog = ensureHelp();
    if (dialog === null) return;
    helpReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const title = dialog.querySelector('[data-editor-help-title]');
    const body = dialog.querySelector('[data-editor-help]');
    if (title !== null) title.textContent = helpText.trim().length === 0 ? 'Справка редактора' : helpTitle(helpText);
    if (body !== null) body.innerHTML = helpHtml();
    dialog.hidden = false;
    const close = dialog.querySelector<HTMLElement>('[data-action="help-close"]');
    if (close !== null) close.focus();
  }

  function closeHelp(): void {
    if (help !== null) help.hidden = true;
    if (helpReturn !== null) {
      helpReturn.focus();
      helpReturn = null;
    }
  }

  function helpOpen(): boolean {
    return help !== null && !help.hidden;
  }

  /* ------------------------------------------------------------------- панель */

  function activeAreaBarHtml(): string {
    const active = selected();
    const label = active === null
      ? 'Активная область: <strong>нет</strong> (первый штрих создаст новую)'
      : 'Активная область: <strong>' + escapeHtml(active.name) + '</strong> · штрихов: '
        + String(active.strokes?.length ?? 0);
    return '<div class="admin-editor-active-bar">'
      + '<p class="admin-editor-meta">' + label + '</p>'
      + '<button type="button" class="admin-editor-create-area" data-action="create-area">+ Создать новую область</button>'
      + '</div>';
  }

  function systemsNavHtml(): string {
    const isolated = new Set(isolatedModuleIds());
    const navTabs: readonly { readonly id: EditorScreen; readonly label: string }[] = [
      { id: 'module', label: 'Модуль' },
      { id: 'hierarchy', label: 'Объекты и связи' },
      { id: 'draw', label: 'Рисование' },
      { id: 'lines', label: 'Линии' },
      { id: 'properties', label: 'Свойства области' },
      { id: 'point-properties', label: 'Свойства точек' },
      { id: 'changes', label: 'Журнал и выгрузка' },
      { id: 'dependencies', label: 'Граф модулей' },
    ];
    const categories = [
      { label: 'Карта и области', ids: ['draw', 'lines', 'properties', 'hierarchy', 'point-properties'] },
      { label: 'Сохранение', ids: ['changes'] },
      { label: 'Устройство редактора', ids: ['dependencies', 'module'] },
    ];
    const screenItems = categories.map((category) => '<details class="admin-editor-category"><summary>'
      + category.label + '</summary><ul class="admin-editor-nav-list">'
      + navTabs.filter(tab => category.ids.includes(tab.id)).map(tab => {
        const current = activeScreen === tab.id;
        return '<li><button type="button" class="admin-editor-nav-item' + (current ? ' is-current' : '')
          + '" data-action="screen" data-screen="' + tab.id + '"'
          + (current ? ' aria-current="page"' : '')
          + ' aria-pressed="' + (current ? 'true' : 'false') + '">' + escapeHtml(tab.label) + '</button></li>';
      }).join('') + '</ul></details>').join('');

    const planes = (['data', 'spatial', 'order'] as const).map((plane) => {
      const items = modulesByPlane(plane).map((mod) => {
        const current = activeScreen === 'module' && mod.id === moduleId;
        const isIsolated = isolated.has(mod.id);
        return '<li><button type="button" class="admin-editor-module' + (current ? ' is-current' : '') + '"'
          + ' data-action="module" data-module="' + escapeHtml(mod.id) + '"'
          + (isIsolated ? ' data-isolated="true"' : '')
          + (current ? ' aria-current="page"' : '')
          + ' aria-pressed="' + (current ? 'true' : 'false') + '"'
          + ' title="' + escapeHtml(mod.label + ' · ' + STATUS_TITLES[mod.status]) + '">'
          + '<span class="admin-editor-module-name">' + escapeHtml(mod.label)
          + (isIsolated ? ' <em class="admin-editor-isolated-tag">изолирован</em>' : '')
          + '</span>'
          + '<span class="admin-editor-status" data-status="' + mod.status + '">'
          + escapeHtml(STATUS_TITLES[mod.status]) + '</span></button></li>';
      }).join('');
      return '<details class="admin-editor-plane admin-editor-category"><summary>' + escapeHtml(PLANE_TITLES[plane]) + '</summary>'
        + '<h3 class="admin-editor-plane-title" title="' + escapeHtml(PLANE_QUESTIONS[plane]) + '">'
        + escapeHtml(PLANE_TITLES[plane]) + '</h3>'
        + '<ul class="admin-editor-modules">' + items + '</ul></details>';
    }).join('');

    return [
      '<nav class="admin-editor-nav" data-editor-nav aria-label="Системы и разделы редактора">',
      '  <button type="button" data-action="navigation-toggle" class="admin-editor-navigation-toggle" aria-expanded="true">Модули и разделы ↕</button>',
      '  <div class="admin-editor-toggles">',
      '    <label class="admin-editor-field admin-editor-field-inline admin-editor-mode-check" title="Включить рисование областей выбранным инструментом. Выключите, чтобы работать с картой без новых штрихов."><input type="checkbox" data-action="toggle-enable"' + (on ? ' checked' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1L20 7l-3-3L4 17z M14 7l3 3"/></svg><span>Рисование</span></label>',
      '    <label class="admin-editor-field admin-editor-field-inline admin-editor-mode-check" title="Сравнение с моментом открытия: пунктир — исходный контур, голубой — текущий, зелёный — новая область, красный — удалённая. Только просмотр контуров, без сохранения."><input type="checkbox" data-action="preview"' + (previewOn ? ' checked' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4v16h6" stroke-dasharray="3 2"/><path d="M14 4h6v16h-6M12 2v20"/></svg><span>Сравнить контуры</span></label>',
      '  </div>',
      '  <div class="admin-editor-nav-group">',
      '    <p class="admin-editor-nav-title">Контекст карты</p>',
      '    <div class="admin-editor-categories">' + screenItems + '</div>',
      '  </div>',
      '  <div class="admin-editor-nav-group">',
      '    <p class="admin-editor-nav-title">Системы</p>',
      '    <details class="admin-editor-category admin-editor-module-menu"><summary>Модули по категориям</summary><div class="admin-editor-planes">' + planes + '</div></details>',
      '  </div>',
      '</nav>',
    ].join('');
  }

  function drawScreenHtml(): string {
    const modeOptions = MODES.map((mode) => (
      `<option value="${mode}"${mode === session.mode ? ' selected' : ''}>${modeLabel(mode)}</option>`
    )).join('');
    return [
      '<div class="admin-editor-stage" data-editor-stage data-editor-screen="draw">',
      '  <p class="admin-editor-meta"><strong>Инструменты карты</strong> · контекст около полотна</p>',
      '  <div class="admin-editor-grid">',
      '    <label class="admin-editor-field">Режим <select data-action="mode">' + modeOptions + '</select></label>',
      '    <label class="admin-editor-field">Привязка <select data-action="snap">',
      '      <option value="free"' + (session.snapMode === 'free' ? ' selected' : '') + '>свободная</option>',
      '      <option value="grid"' + (session.snapMode === 'grid' ? ' selected' : '') + '>к рёбрам сетки</option>',
      '      <option value="sector"' + (session.snapMode === 'sector' ? ' selected' : '') + '>к ячейке адреса</option>',
      '    </select></label>',
      '    <label class="admin-editor-field">Кисть, px <input type="number" min="1" max="40" step="1" value="' + session.brushWidthPx + '" data-action="width"></label>',
      snapDetailsHtml(),
      '  </div>',
      activeAreaBarHtml(),
      '  <p class="admin-editor-hint">ЛКМ — штрих в активную область. ПКМ и колесо — карте. <kbd>F</kbd> — закрасить выбранную, <kbd>Enter</kbd> — завершить вершины, <kbd>Esc</kbd> — прервать или закрыть справку, <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить.</p>',
      previewOn
        ? '  <p class="admin-editor-hint">Сравнение с моментом открытия редактора: пунктир — исходный контур, голубой — текущий контур существующей области, зелёный — новая область, красный — удалённая. Цвета заливки и свойства отдельно не сравниваются; данные не меняются.</p>'
        : '',
      '</div>',
    ].join('');
  }

  function moduleScreenHtml(): string {
    const selectedModule: SectorModule | null = moduleById(moduleId);
    const body = selectedModule === null
      ? '<p class="admin-editor-hint">Модуль не выбран.</p>'
      : modulePropertiesHtml(selectedModule);
    return '<div class="admin-editor-stage admin-editor-node-card" data-editor-stage data-editor-screen="module" data-editor-node-card>'
      + '<button type="button" class="admin-editor-back" data-action="screen" data-screen="dependencies">← К графу модулей</button>'
      + body
      + '</div>';
  }

  function dependenciesScreenHtml(): string {
    return '<div class="admin-editor-stage" data-editor-stage data-editor-screen="dependencies">'
      + moduleGraphHtml(moduleId, relationFilter)
      + '<div class="admin-editor-row"><button type="button" data-action="screen" data-screen="hierarchy">Настроить объекты и пары</button></div>'
      + '<p class="admin-editor-hint">Менять можно связи объектов документа: родителя области в свойствах, состав групп и порядок наложения пар. Это не переподключение модулей графа.</p>'
      + '</div>';
  }

  const POINT_LABELS: Record<PropertyField, string> = { name: 'Название', type: 'Тип', faction: 'Фракция', description: 'Описание', source_url: 'Ссылка на источник' };
  function pointFactions(): Set<string> {
    const factions = typeof kernel.data?.factionsByName === 'function' ? kernel.data.factionsByName() : new Map();
    return new Set(factions.keys());
  }
  function pointDraft(current: PropertySession): ReturnType<typeof preparePropertyDraft> {
    return preparePropertyDraft(current, pointFactions());
  }
  function setPointSession(next: PropertySession): void {
    if (pointSession !== next) {
      pointReview = null;
      // Любая правка делает подготовленную заявку недействительной.
      if (pointSubmitState !== 'sending') {
        pointSubmission = null;
        pointSubmitOutcome = null;
      }
    }
    pointSession = next;
  }
  /**
   * Отправка заявки в шлюз. Заявка собирается заново из текущей сессии; если
   * содержимое отличается от подтверждённого предпросмотра, отправка
   * отменяется. ID попытки сохраняется до запроса, поэтому повтор после
   * неизвестного результата идёт с тем же ID и не создаёт дубль.
   */
  async function submitPointRequest(): Promise<void> {
    if (pointSession === null || pointSubmitState === 'sending') return;
    pointSubmitState = 'sending';
    pointSubmitOutcome = null;
    pointNotice = null;
    updatePointSummary();
    try {
      const requestId = pointSubmission?.requestId ?? newRequestId(Date.now(), (count = 32) => crypto.getRandomValues(new Uint8Array(count)));
      const review = await preparePropertyPacket(pointSession, pointFactions(), requestId);
      if (review === null || review.status !== 'ready') {
        pointNotice = review?.errors[0] ?? 'Заявка не готова: проверьте правки.';
        pointSubmission = null;
        return;
      }
      // Неизменность содержимого между подготовкой и отправкой: подпись та же.
      if (pointSubmission !== null && pointSubmission.snapshot !== review.draftSnapshot) {
        pointNotice = 'Содержимое изменилось во время подготовки: проверьте предпросмотр заново.';
        pointSubmission = null;
        return;
      }
      pointSubmission = { requestId, title: review.title, body: review.body, snapshot: review.draftSnapshot, fromPreview: true };
      const gatewayUrl = readGatewayUrl(document.querySelector('meta[name="issue-gateway"]'));
      const outcome = await submitPropertyPacket({ title: review.title, body: review.body, requestId }, {
        gatewayUrl,
        origin: location.origin,
      });
      pointSubmitOutcome = outcome;
      pointNotice = SUBMIT_MESSAGES[outcome.status];
      // Успех создания не применяет правку: сессия остаётся как есть. ID
      // сохраняется намеренно — повторный клик вернёт ту же Issue, а не создаст новую.
      void outcome;
    } catch {
      pointSubmitOutcome = { status: 'unavailable' };
      pointNotice = SUBMIT_MESSAGES.unavailable;
    } finally {
      pointSubmitState = 'idle';
      updatePointSummary();
    }
  }

  function pointReviewHtml(): string {
    if (pointReview === null) return '';
    const { preview, acknowledged, confirmed } = pointReview;
    return '<section aria-label="Предпросмотр будущей заявки"><h3>Предпросмотр — не отправлено</h3>'
      + '<p><strong>Заголовок:</strong> ' + escapeHtml(preview.title) + '</p>'
      + '<ul>' + preview.warnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join('') + '</ul>'
      + '<label class="admin-editor-property-field"><span>Содержимое</span><pre class="admin-editor-point-preview">' + escapeHtml(preview.body) + '</pre></label>'
      + '<label><input type="checkbox" data-action="point-review-ack"' + (acknowledged ? ' checked' : '') + '> Я проверил содержимое и понимаю, что будущая Issue будет публичной.</label>'
      + '<div><button type="button" data-action="point-review-confirm"' + (acknowledged ? '' : ' disabled') + '>Подтвердить просмотр</button></div>'
      + (confirmed ? '<p role="status">Просмотр подтверждён локально. Отправка — отдельное действие ниже.</p>' : '')
      + '<h3>Отправка</h3>'
      + '<p>Отправка создаёт публичную заявку в GitHub от вашего имени. Она <strong>не</strong> применяет правку и не обновляет сайт: это отдельные шаги, и их результат проверяется отдельно.</p>'
      + (pointSubmission === null
        ? ''
        : '<p>Идентификатор заявки: <code>' + escapeHtml(pointSubmission.requestId) + '</code> — повтор с ним же не создаёт вторую Issue; новая правка создаёт новый идентификатор.</p>')
      + '<div><button type="button" data-action="point-submit"'
      + (confirmed && pointSubmitState !== 'sending' ? '' : ' disabled') + '>'
      + (pointSubmitState === 'sending' ? 'Отправка…' : 'Отправить заявку в GitHub') + '</button></div>'
      + (pointSubmitOutcome === null ? '' : '<p role="status">' + escapeHtml(SUBMIT_MESSAGES[pointSubmitOutcome.status])
        + (pointSubmitOutcome.status === 'created' || pointSubmitOutcome.status === 'existing'
          ? ' <a href="' + escapeHtml(pointSubmitOutcome.url) + '" rel="noopener noreferrer" target="_blank">Issue #' + pointSubmitOutcome.number + '</a>'
          : '') + '</p>')
      + '</section>';
  }
  function pointChangeSummaryHtml(current: PropertySession): string {
    const changes = propertyChanges(current);
    const summary = changes.map((change) => '<li>' + escapeHtml(change.dataset + ' · ' + change.recordId + ' · ' + POINT_LABELS[change.field])
      + ': <del>' + escapeHtml(change.before || '∅') + '</del> → <ins>' + escapeHtml(change.after || '∅') + '</ins></li>').join('');
    const { problems } = pointDraft(current);
    const issues = problems.map((problem) => '<li>' + escapeHtml((problem.severity === 'error' ? 'Ошибка: ' : 'Внимание: ') + problem.change.dataset + ' · ' + problem.change.recordId + ' · ' + POINT_LABELS[problem.change.field] + ': ' + problem.message) + '</li>').join('');
    return '<p>Изменений: ' + changes.length + '</p>' + (summary ? '<ul>' + summary + '</ul>' : '')
      + (issues ? '<ul class="admin-editor-point-issues" role="status">' + issues + '</ul>' : '')
      + (pointNotice === null ? '' : '<p role="status">' + escapeHtml(pointNotice) + '</p>');
  }
  function updatePointSummary(): void {
    if (pointSession === null || panel === null) return;
    const summary = panel.querySelector('[data-point-summary]');
    if (summary !== null) summary.innerHTML = pointChangeSummaryHtml(pointSession);
    const undoButton = panel.querySelector<HTMLButtonElement>('[data-action="point-undo"]');
    const redoButton = panel.querySelector<HTMLButtonElement>('[data-action="point-redo"]');
    if (undoButton !== null) undoButton.disabled = pointSession.past.length === 0;
    if (redoButton !== null) redoButton.disabled = pointSession.future.length === 0;
    const exportButton = panel.querySelector<HTMLButtonElement>('[data-action="point-export"]');
    if (exportButton !== null) exportButton.disabled = pointDraft(pointSession).draft === null;
    const previewButton = panel.querySelector<HTMLButtonElement>('[data-action="point-preview"]');
    if (previewButton !== null) previewButton.disabled = pointDraft(pointSession).draft === null;
    const review = panel.querySelector('[data-point-review]');
    if (review !== null) review.innerHTML = pointReviewHtml();
    const submitButton = panel.querySelector<HTMLButtonElement>('[data-action="point-submit"]');
    if (submitButton !== null) {
      submitButton.disabled = pointReview === null || !pointReview.confirmed || pointSubmitState === 'sending';
      submitButton.textContent = pointSubmitState === 'sending' ? 'Отправка…' : 'Отправить заявку в GitHub';
    }
  }

  function pointPropertiesHtml(): string {
    if (pointSession === null) return '<div class="admin-editor-stage"><p>Снимок свойств недоступен.</p></div>';
    const current = pointSession.snapshots[pointIndex];
    const values = pointSession.present[pointIndex];
    const options = pointSession.snapshots.map((snapshot, index) =>
      '<option value="' + index + '"' + (index === pointIndex ? ' selected' : '') + '>'
      + escapeHtml((snapshot.dataset === 'systems' ? 'Система · ' : 'Место · ') + snapshot.fields.name.effective + ' · ID ' + snapshot.recordId) + '</option>').join('');
    const fields = current && values ? PROPERTY_FIELDS.map((field) => {
      const label = escapeHtml(POINT_LABELS[field]);
      const value = escapeHtml(values[field]);
      return '<label class="admin-editor-property-field"><span>' + label + '</span>'
        + (field === 'description'
          ? '<textarea data-action="point-field" data-point-field="' + field + '" rows="4">' + value + '</textarea>'
          : '<input data-action="point-field" data-point-field="' + field + '" value="' + value + '">') + '</label>';
    }).join('') : '<p>Нет однозначно сопоставленных объектов.</p>';
    return '<div class="admin-editor-stage admin-editor-point-properties" data-editor-screen="point-properties">'
      + '<p>Локальный черновик: правки не отправлены и не опубликованы; при перезагрузке они исчезнут.</p>'
      + '<label class="admin-editor-property-field"><span>Объект</span><select data-action="point-select">' + options + '</select></label>'
      + fields + '<div class="admin-editor-row"><button type="button" data-action="point-undo"' + (pointSession.past.length ? '' : ' disabled') + '>Отменить</button>'
      + '<button type="button" data-action="point-redo"' + (pointSession.future.length ? '' : ' disabled') + '>Повторить</button></div>'
      + '<div data-point-summary>' + pointChangeSummaryHtml(pointSession) + '</div>'
      + '<button type="button" data-action="point-preview"' + (pointDraft(pointSession).draft ? '' : ' disabled') + '>Посмотреть будущую заявку</button>'
      + '<div data-point-review>' + pointReviewHtml() + '</div>'
      + '<button type="button" data-action="point-export"' + (pointDraft(pointSession).draft ? '' : ' disabled') + '>Скачать локальный черновик</button>'
      + '<label class="admin-editor-property-field"><span>Загрузить локальный черновик</span><input type="file" accept="application/json,.json" data-action="point-import"></label>'
      + '<p>' + (pointSession.contentRevision === null ? 'Отпечаток входов не подтверждён.' : 'Отпечаток входов сверён; он не подтверждает публикацию или права.') + ' Отправка идёт через шлюз после проверки содержимого; создание Issue не применяет правку и не публикует её. Не включайте секреты или непубличные данные.</p></div>';
  }

  function modulesHtml(): string {
    const nav = systemsNavHtml() + '<div class="admin-editor-toolbox" aria-label="Toolbox">' + toolsHtml() + '</div>';
    if (activeScreen === 'properties' || activeScreen === 'changes' || activeScreen === 'lines' || activeScreen === 'hierarchy') {
      return '<div class="admin-editor-shell admin-editor-shell-nav-only">' + nav + '</div>';
    }
    const stageHtml = activeScreen === 'point-properties'
      ? pointPropertiesHtml()
      : activeScreen === 'draw'
      ? drawScreenHtml()
      : (activeScreen === 'dependencies' ? dependenciesScreenHtml() : moduleScreenHtml());
    return '<div class="admin-editor-shell">' + nav + stageHtml + '</div>';
  }

  /**
   * Инструменты рисования: пять базовых, как в Paint. Переключение — состояние
   * интерфейса: оно не коммитит документ и не оставляет записи в истории.
   */
  function toolsHtml(): string {
    const labels = ['Кисть', 'Линия', 'Прямоуг.', 'Эллипс', 'Полигон'];
    const paths = ['M4 20l4-1L20 7l-3-3L4 17z M14 7l3 3', 'M4 20L20 4 M4 17v3h3 M17 4h3v3', 'M4 5h16v14H4z', 'M20 12a8 6 0 1 1-16 0 8 6 0 1 1 16 0', 'M12 3l9 7-4 11H7L3 10z'];
    const buttons = TOOL_IDS.map((tool, index) => {
      const current = tool === toolState.tool;
      return '<button type="button" class="admin-editor-tool' + (current ? ' is-current' : '') + '"'
        + ' data-action="tool" data-tool="' + escapeHtml(tool) + '"'
        + ' aria-pressed="' + (current ? 'true' : 'false') + '"'
        + ' aria-label="' + escapeHtml(TOOL_TITLES[tool]) + '" title="' + escapeHtml(TOOL_TITLES[tool] + ': ' + TOOL_HINTS[tool]) + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + paths[index] + '"/></svg>'
        + '<span>' + escapeHtml(labels[index] ?? TOOL_LABELS[tool]) + '</span></button>';
    }).join('');
    return '<p class="admin-editor-meta"><strong>Инструмент</strong> · ' + escapeHtml(TOOL_TITLES[toolState.tool]) + '</p>'
      + '<div class="admin-editor-tools" role="group" aria-label="Инструменты рисования">' + buttons + '</div>'
      + '<p class="admin-editor-hint">' + escapeHtml(TOOL_HINTS[toolState.tool]) + '</p>';
  }

  /** Детали выбранного режима привязки: ярус сетки или глубина букв адреса. */
  function snapDetailsHtml(): string {
    if (session.snapMode === 'sector') {
      const options = [5, 6, 7].map((value) => (
        `<option value="${value}"${value === snapLetters ? ' selected' : ''}>${value} букв</option>`
      )).join('');
      return '<label class="admin-editor-field">Глубина адреса <select data-action="snap-letters">' + options + '</select></label>';
    }
    if (session.snapMode === 'grid') {
      const tier = displayedGridTierFor(currentViewport(), currentCamera());
      const text = tier === null
        ? 'нет видимого яруса'
        : `${tier.id} · ${String(tier.cellSize).replace('.', ',')} св. л.`;
      return '<div class="admin-editor-field"><span class="admin-editor-field-label">Ярус сетки</span>'
        + '<span class="admin-editor-tier-badge">' + escapeHtml(text) + '</span></div>';
    }
    return '';
  }

  function propertiesHtml(): string {
    return areaEditorHtml();
  }

  function relationItemHtml(relation: ModuleRelation, direction: 'in' | 'out'): string {
    const peerId = direction === 'in' ? relation.from : relation.to;
    const peer = moduleById(peerId);
    const peerTitle = peer?.label ?? peerId;
    const arrow = direction === 'in' ? '←' : '→';
    return '<li class="admin-editor-rel-item">'
      + '<div class="admin-editor-rel-head">'
      + '<button type="button" class="admin-editor-rel-target" data-action="module" data-module="' + escapeHtml(peerId) + '">'
      + arrow + ' ' + escapeHtml(peerTitle) + '</button>'
      + '<span class="admin-editor-rel-kind" data-kind="' + relation.kind + '">' + escapeHtml(RELATION_KIND_TITLES[relation.kind]) + '</span>'
      + '</div>'
      + '<p class="admin-editor-hint">' + escapeHtml(relation.note) + '</p>'
      + '</li>';
  }

  function moduleRelationsHtml(targetId: string): string {
    const { incoming, outgoing } = relationsForModule(targetId);
    const graphButton = '<div class="admin-editor-row">'
      + '<button type="button" data-action="screen" data-screen="dependencies">Открыть экран «Зависимости»</button>'
      + '</div>';
    if (incoming.length === 0 && outgoing.length === 0) {
      return '<div class="admin-editor-relations">'
        + '<p class="admin-editor-meta"><strong>Связи модуля</strong></p>'
        + '<p class="admin-editor-hint">Подтверждённых связей в коде нет: модуль отображается самостоятельным узлом.</p>'
        + graphButton
        + '</div>';
    }
    const inBlock = incoming.length === 0
      ? ''
      : '<p class="admin-editor-meta"><strong>Зависит от (' + incoming.length + ')</strong></p>'
        + '<ul class="admin-editor-rel-list">' + incoming.map((rel) => relationItemHtml(rel, 'in')).join('') + '</ul>';
    const outBlock = outgoing.length === 0
      ? ''
      : '<p class="admin-editor-meta"><strong>Влияет на (' + outgoing.length + ')</strong></p>'
        + '<ul class="admin-editor-rel-list">' + outgoing.map((rel) => relationItemHtml(rel, 'out')).join('') + '</ul>';
    return '<div class="admin-editor-relations">' + inBlock + outBlock + graphButton + '</div>';
  }

  /** Карточка выбранного узла: значения, подтверждённые связи и действия модуля. */
  function modulePropertiesHtml(module: SectorModule): string {
    const context = registryContext();
    const rows = moduleRows(module, context);
    const guide = MODULE_HELP[module.id];
    const guidance = guide === undefined ? '' : '<dl class="admin-editor-guide">'
      + [['Что это', guide.what], ['Где и на что влияет', guide.where], ['Как работать', guide.how], ['Что важно знать', guide.limits]].map(([title, text]) => '<div><dt>' + escapeHtml(title ?? '') + '</dt><dd>' + escapeHtml(text ?? '') + '</dd></div>').join('') + '</dl>'
      + (guide.screen === null ? '' : '<div class="admin-editor-row"><button type="button" data-action="screen" data-screen="' + guide.screen + '">Открыть настройки / действия</button></div>');
    return [
      '<p class="admin-editor-meta"><strong>' + escapeHtml(module.label) + '</strong><br>'
        + escapeHtml(PLANE_TITLES[module.plane]) + ' · <span class="admin-editor-status" data-status="'
        + module.status + '">' + escapeHtml(STATUS_TITLES[module.status]) + '</span></p>',
      guidance,
      '<details class="admin-editor-values"><summary>Текущие значения</summary>',
      '<table class="admin-editor-table"><tbody>' + rows.map((item) => (
        '<tr><th scope="row">' + escapeHtml(item.label) + '</th><td>' + escapeHtml(item.value) + '</td></tr>'
      )).join('') + '</tbody></table>',
      '</details>',
      moduleRelationsHtml(module.id),
      moduleActionsHtml(module, context),
      '<details><summary>Технические подробности</summary><p class="admin-editor-hint">' + escapeHtml(module.note) + '</p><p class="admin-editor-hint">Файл: <code>' + escapeHtml(module.source) + '</code></p></details>',
    ].join('');
  }

  function moduleActionsHtml(module: SectorModule, context: RegistryContext): string {
    const actions = moduleActions(module, context);
    if (actions.length === 0) return '<p class="admin-editor-hint">Действий в панели нет: модуль только показывает значения.</p>';
    return '<div class="admin-editor-row">' + actions.map((action) => (
      '<button type="button" data-action="module-run" data-run="' + escapeHtml(action.id) + '"'
        + (action.disabled === true ? ' disabled' : '') + '>' + escapeHtml(action.label) + '</button>'
    )).join('') + '</div>';
  }

  /**
   * Палитра фракций из существующего источника данных: имена и цвета приходят
   * из `data/factions.csv` через уже готовую функцию палитры. Панель не держит
   * своего списка фракций и не касается данных.
   */
  function factionPalette(): FactionPalette | null {
    const data = kernel.data;
    if (data === null || data === undefined || typeof data.factionsByName !== 'function') return null;
    const entries = [...data.factionsByName().entries()].map(([name, details]) => ({ name, color: details.color }));
    return createFactionPalette(entries);
  }

  /** Список фракций: служебная строка «—» означает «фракции нет» и не предлагается. */
  function factionNames(): readonly string[] {
    const palette = factionPalette();
    if (palette === null) return [];
    return palette.names.filter((name) => name.trim().length > 0 && name !== NO_FACTION_KEY);
  }

  /**
   * Выбор фракции для новой области. Первый вариант — нейтральная: по решению
   * владельца новая область начинает нейтральной, пока не выбрана фракция.
   */
  function factionHtml(): string {
    const names = factionNames();
    if (names.length === 0) {
      return '<p class="admin-editor-hint">Палитра фракций недоступна: новая область получит нейтральный цвет.</p>';
    }
    const palette = factionPalette();
    const swatch = faction === null ? '' : (palette?.cssOf(faction) ?? '');
    const options = ['<option value=""' + (faction === null ? ' selected' : '') + '>Без фракции (нейтральная)</option>']
      .concat(names.map((name) => (
        '<option value="' + escapeHtml(name) + '"' + (faction === name ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'
      )))
      .join('');
    return '<label class="admin-editor-field">Фракция новой области <select data-action="faction">' + options + '</select></label>'
      + (swatch === ''
        ? ''
        : '<p class="admin-editor-meta">Цвет фракции: <span class="admin-editor-swatch" style="background:' + escapeHtml(swatch) + '"></span> '
          + escapeHtml(swatch) + '</p>');
  }

  /** Непосредственная правка области: это часть модуля команд, а не реестра. */
  function validParent(areaId: string, parentId: string): boolean {
    const seen = new Set([areaId]);
    let current: string | null = parentId || null;
    while (current !== null) {
      if (seen.has(current)) return false;
      seen.add(current);
      const parent = session.doc.areas.find(item => item.id === current);
      if (parent === undefined) return false;
      current = parent.parentId;
    }
    return true;
  }

  function parentFieldHtml(area: Area): string {
    return '<label class="admin-editor-field">Родительская область <select data-action="parent"'
      + (session.selection === null ? ' disabled' : '') + '><option value="">Без родителя</option>'
      + session.doc.areas.filter(item => validParent(area.id, item.id)).map(item => '<option value="'
        + escapeHtml(item.id) + '"' + (item.id === area.parentId ? ' selected' : '') + '>' + escapeHtml(item.name) + '</option>').join('')
      + '</select></label><p class="admin-editor-hint">Если собственного состояния нет, область наследует его от родителя. Контур не перемещается. Связь можно отменить.</p>';
  }

  function areaEditorHtml(): string {
    const areas = session.doc.areas;
    if (areas.length === 0) {
      return '<div class="admin-editor-row"><button type="button" data-action="create-area">+ Создать новую область</button></div>'
        + '<p class="admin-editor-hint">Областей пока нет: нажмите «Создать новую область» или проведите первый штрих на карте.</p>';
    }
    const placeholder = session.selection === null
      ? '<option value="" disabled selected>Выберите активную область…</option>'
      : '';
    const options = placeholder + areas.map((area) => (
      `<option value="${escapeHtml(area.id)}"${area.id === session.selection ? ' selected' : ''}>${escapeHtml(areaLabel(area))}</option>`
    )).join('');
    const area = selected() ?? areas[0]!;
    const vertices = totalVertices(area) + strokeVertices(area);
    const strokesCount = area.strokes?.length ?? 0;
    return [
      '<p class="admin-editor-meta"><strong>Область</strong> · правка командой</p>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="create-area">+ Создать новую область</button>',
      '</div>',
      '<label class="admin-editor-field">Область <select data-action="select">' + options + '</select></label>',
      parentFieldHtml(area),
      '<label class="admin-editor-field">Название <input type="text" value="' + escapeHtml(area.name) + '" data-field="name"></label>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="rename">Переименовать</button>',
      '<button type="button" data-action="add-state">Состояние</button>',
      '<button type="button" data-action="remove">Удалить</button>',
      '</div>',
      '<label class="admin-editor-field admin-editor-field-inline">Цвет заливки <input type="color" value="' + color + '" data-field="color"></label>',
      // Два разных действия заливки: override поверх выбранной области и
      // заливка новой замкнутой фигуры как её состояние. Кнопки разные всегда,
      // второе недоступно на открытой линии — до её выбора, а не после отказа.
      '<div class="admin-editor-row">',
      '<button type="button" data-action="force">Закрасить (F)</button>',
      '<button type="button" data-action="fill-state"' + (canFillArea(area).ok ? '' : ' disabled')
        + ' title="' + escapeHtml(canFillArea(area).reason ?? 'Залить замкнутую фигуру как её состояние') + '">Залить фигуру</button>',
      '</div>',
      factionHtml(),
      '<p class="admin-editor-meta">',
      'Штрихов: ' + strokesCount + ' · вершин: ' + vertices + ' · площадь: ' + Math.round(areaSize(area)).toLocaleString('ru-RU'),
      ' · состояний: ' + area.states.length,
      (area.address ? ' · адрес: ' + escapeHtml(area.address) : ''),
      '</p>',
    ].join('');
  }

  /** Проверка документа: предупреждение, а не запрет — решение владельца. */
  function validationHtml(): string {
    const report = documentReport(session.doc, { bounds: registryContext().bounds });
    const issues = [...report.errors, ...report.warnings];
    if (issues.length === 0) {
      return '<p class="admin-editor-hint">Проверка документа: замечаний нет.</p>';
    }
    const severity = report.errors.length > 0 ? 'error' : 'warning';
    return '<div class="admin-editor-check" data-state="' + severity + '">'
      + '<p class="admin-editor-hint">Проверка документа: ошибок ' + report.errors.length
      + ', предупреждений ' + report.warnings.length
      + '. Это предупреждение: правку, черновик и выгрузку оно не блокирует, решение за администратором.</p>'
      + '<ul class="admin-editor-log">' + issues.slice(0, 6).map((item) => (
        '<li>' + escapeHtml(item) + '</li>'
      )).join('') + '</ul></div>';
  }

  function changesHtml(): string {
    const events = session.doc.events.slice(-12).reverse();
    const journal = events.length === 0
      ? '<p class="admin-editor-hint">Журнал пуст.</p>'
      : '<ol class="admin-editor-log">' + events.map((event) => (
        '<li>' + escapeHtml(eventLine(event)) + '</li>'
      )).join('') + '</ol>';
    return [
      '<p class="admin-editor-demo">Демо: правки лежат в этом браузере. На сайт ничего не отправлено.</p>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="undo"' + (canUndo(session) ? '' : ' disabled') + '>Отменить</button>',
      '<button type="button" data-action="redo"' + (canRedo(session) ? '' : ' disabled') + '>Повторить</button>',
      '</div>',
      journal,
      validationHtml(),
      '<div class="admin-editor-row">',
      '<button type="button" data-action="draft-save">Черновик: сохранить</button>',
      '<button type="button" data-action="draft-load">загрузить</button>',
      '<button type="button" data-action="draft-clear">очистить</button>',
      '</div>',
      '<p class="admin-editor-hint">' + escapeHtml(draft.info() ?? '') + '</p>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="download">Скачать JSON</button>',
      '<button type="button" data-action="copy">Скопировать</button>',
      '<button type="button" data-action="request">Материал заявки</button>',
      '</div>',
      '<label class="admin-editor-import" for="areasImportInput">',
      '<span>Загрузить выгруженный JSON областей</span>',
      '<input id="areasImportInput" type="file" accept="application/json,.json" data-action="areas-import"',
      ' aria-label="Загрузить выгруженный ранее JSON областей" />',
      '</label>',
      notice === null ? '' : '<p class="admin-editor-hint">' + escapeHtml(notice) + '</p>',
    ].join('');
  }

  function draftInfoText(): string | null {
    if (storage === null) return 'Черновик недоступен: нет локального хранилища.';
    const raw = storage.getItem(DRAFT_KEY);
    if (raw === null) return 'Черновик не сохранялся.';
    let when = 'время неизвестно';
    try {
      const parsed = JSON.parse(raw) as { savedAt?: string };
      if (typeof parsed.savedAt === 'string') when = new Date(parsed.savedAt).toLocaleString('ru-RU');
    } catch (err) {
      when = 'файл повреждён';
    }
    return 'Черновик сохранён: ' + when + '.';
  }

  /** Перерисовка блоков панели без потери недопечатанного названия области. */
  // Высота строки меняется при переносе категорий, масштабе и сворачивании.
  // Один измеренный отступ используется Toolbox, доком и карточкой системы.
  let navigationObserver: ResizeObserver | null = null;
  function syncNavigationHeight(): void {
    const nav = panel?.querySelector<HTMLElement>('.admin-editor-nav');
    if (!nav || typeof nav.getBoundingClientRect !== 'function') return;
    const height = Math.ceil(nav.getBoundingClientRect().height);
    if (height <= 0) return;
    panel?.style.setProperty('--shell-top', `${height + 8}px`);
    stage?.style.setProperty('--admin-content-top', `${height + 16}px`);
  }

  function refresh(): void {
    if (panel === null) return;
    if (typeof panel.setAttribute === 'function') {
      panel.setAttribute('data-active-screen', activeScreen);
    }
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const editing = typeof HTMLInputElement !== 'undefined'
      && active instanceof HTMLInputElement
      && active.getAttribute('data-field') === 'name'
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const pointEditing = ((typeof HTMLInputElement !== 'undefined' && active instanceof HTMLInputElement)
      || (typeof HTMLTextAreaElement !== 'undefined' && active instanceof HTMLTextAreaElement))
      && active.getAttribute('data-action') === 'point-field'
      ? { field: active.getAttribute('data-point-field'), value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const dockTitle = panel.querySelector('#adminEditorTitle');
    if (dockTitle !== null) {
      const titles: Record<EditorScreen, string> = { dependencies: 'Карта связей модулей', module: 'О модуле', draw: 'Рисование областей', properties: 'Свойства области', changes: 'Журнал и выгрузка', hierarchy: 'Объекты и связи', lines: 'Правка границ', 'point-properties': 'Свойства точек' };
      dockTitle.textContent = titles[activeScreen];
    }
    const railLabel = panel.querySelector('.admin-editor-rail-label');
    if (railLabel !== null) railLabel.textContent = 'Панель редактора';
    const summary = panel.querySelector('[data-editor-summary]');
    const modules = panel.querySelector('[data-editor-block="modules"]');
    const properties = panel.querySelector('[data-editor-block="properties"]');
    const changes = panel.querySelector('[data-editor-block="changes"]');
    if (summary !== null) summary.textContent = summaryText();
    if (modules !== null) modules.innerHTML = modulesHtml();
    const navigationToggle = panel.querySelector('[data-action="navigation-toggle"]');
    if (navigationToggle !== null) navigationToggle.setAttribute('aria-expanded', panel.classList.contains('is-navigation-collapsed') ? 'false' : 'true');
    if (properties !== null) properties.innerHTML = propertiesHtml();
    if (changes !== null) changes.innerHTML = changesHtml();
    if (editing !== null) {
      const input = panel.querySelector<HTMLInputElement>('[data-field="name"]');
      if (input !== null) {
        input.value = editing.value;
        if (editing.start !== null && editing.end !== null) input.setSelectionRange(editing.start, editing.end);
        input.focus();
      }
    }
    if (pointEditing !== null && pointEditing.field !== null && PROPERTY_FIELDS.includes(pointEditing.field as PropertyField)) {
      const input = panel.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-point-field="' + pointEditing.field + '"]');
      if (input !== null) {
        input.value = pointEditing.value;
        if (pointEditing.start !== null && pointEditing.end !== null) input.setSelectionRange(pointEditing.start, pointEditing.end);
        input.focus();
      }
    }
    syncNavigationHeight();
    if (typeof ResizeObserver !== 'undefined') {
      navigationObserver ??= new ResizeObserver(syncNavigationHeight);
      navigationObserver.disconnect();
      const nav = panel.querySelector('.admin-editor-nav');
      if (nav) navigationObserver.observe(nav);
    }
    if (previewOn) {
      lastViewKey = '';
      paintOverlay();
    }
  }

  /** Сводка в шапке: режим, кисть и привязка видны и при свёрнутых разделах. */
  function summaryText(): string {
    const state = on ? 'рисование включено' : 'рисование выключено';
    const gridTier = session.snapMode === 'grid' ? displayedGridTierFor(currentViewport(), currentCamera()) : null;
    const snap = session.snapMode === 'grid'
      ? (gridTier === null ? 'к рёбрам сетки' : `к рёбрам сетки (${gridTier.id})`)
      : (session.snapMode === 'sector' ? `к ячейке (${snapLetters} букв)` : 'свободная');
    const active = selected();
    const activePart = active === null ? '' : ` · область: ${active.name} (штрихов: ${active.strokes?.length ?? 0})`;
    const preview = previewOn ? ' · сравнение контуров с моментом открытия' : '';
    const pending = drawing ? ' · ввод не завершён' : '';
    return `${state} · инструмент: ${TOOL_TITLES[toolState.tool]} · режим: ${modeLabel(session.mode)}`
      + ` · кисть: ${session.brushWidthPx} px · привязка: ${snap}${activePart}${preview}${pending}`;
  }

  /* --------------------------------------------------------------- сворачивание */

  function setCollapsed(value: boolean): void {
    if (panel === null) return;
    panel.classList.toggle('is-collapsed', value);
    const rail = panel.querySelector<HTMLElement>('[data-action="expand"]');
    const collapse = panel.querySelector<HTMLElement>('[data-action="collapse"]');
    if (rail !== null) rail.setAttribute('aria-expanded', value ? 'false' : 'true');
    if (collapse !== null) collapse.setAttribute('aria-expanded', value ? 'false' : 'true');
    if (storage !== null) {
      try {
        storage.setItem(PANEL_KEY, value ? 'collapsed' : 'expanded');
      } catch (err) {
        /* хранилище недоступно — панель просто не запомнит состояние */
      }
    }
  }

  function collapsed(): boolean | null {
    if (panel === null) return null;
    return panel.classList.contains('is-collapsed');
  }

  function restoreCollapsed(): void {
    if (panel === null || storage === null) return;
    const saved = storage.getItem(PANEL_KEY);
    setCollapsed(saved === 'collapsed');
  }

  /* ------------------------------------------------------------------- команды */

  function closeStroke(): void {
    // Незавершённый ввод отбрасывается: документ и история при этом не меняются.
    toolState = cancelInput(toolState);
    drawing = false;
    clearPreview();
    if (canvas !== null) canvas.classList.remove('editor-drawing');
    if (stage !== null && capturedId !== null) {
      try {
        if (stage.hasPointerCapture(capturedId)) stage.releasePointerCapture(capturedId);
      } catch (err) {
        /* захват уже снят браузером — это не ошибка */
      }
      capturedId = null;
    }
  }

  /** Область под курсором: верхняя из подходящих (кольца и отдельные штрихи). */
  function areaAt(point: AreaPoint): Area | null {
    const areas = session.doc.areas;
    const hitTolerance = 8 / registryContext().scale;
    for (let i = areas.length - 1; i >= 0; i -= 1) {
      const area = areas[i]!;
      if (pointHitsArea(area, point[0], point[1], hitTolerance)) return area;
    }
    return null;
  }

  /**
   * Явное создание новой пустой области и переключение активного выбора на неё.
   * Отмена (`Ctrl+Z`) удаляет пустую область и возвращает прежний выбор.
   */
  function createNewArea(): void {
    const id = nextId();
    const name = 'Область ' + String(session.doc.areas.length + 1);
    try {
      const next = createEmptyArea(session, { id, name });
      notice = 'Создана пустая область «' + name + '». Новые штрихи записываются в неё.';
      commit(next);
    } catch (error) {
      notice = 'Область не создана: ' + (error instanceof Error ? error.message : 'неизвестная ошибка') + '.';
      refresh();
    }
  }

  /**
   * Область по ячейке адреса: площадь = прямоугольник тира `5…7` букв, адрес и
   * родитель считает сама команда `addAreaFromSectorCell`. Свободный контур при
   * этом не создаётся — иначе привязка была бы только меткой.
   */
  function createFromSectorCell(point: AreaPoint): void {
    const id = nextId();
    try {
      const next = addAreaFromSectorCell(session, {
        id,
        name: 'Ячейка ' + String(session.doc.areas.length + 1),
        x: point[0],
        y: point[1],
        letters: snapLetters,
        state: createDefaultState('state-' + id, session.mode),
      });
      const created = next.doc.areas.find((area) => area.id === id);
      notice = 'Область создана по ячейке адреса: ' + (created?.address ?? 'адрес не определён') + '.';
      commit(next);
    } catch (error) {
      notice = 'Секторный снап не сработал: ' + (error instanceof Error ? error.message : 'неизвестная ошибка') + '.';
      refresh();
    }
  }

  /**
   * Завершение ввода инструмента.
   *
   * Сначала привязка к ячейке адреса, затем выделение щелчком у свободной линии,
   * затем завершённый штрих: при активной области он дописывается в её список
   * `strokes`, иначе создаёт первую область и делает её активной. При режиме
   * привязки `grid` точки штриха притягиваются к отображаемым рёбрам сетки.
   */
  function completeInput(): void {
    const byVertices = toolInput(toolState.tool) === 'vertices';
    const start = byVertices ? (toolState.vertices[0] ?? null) : (toolState.path[0] ?? null);

    // Привязка «к ячейке адреса»: и щелчок, и штрих дают площадь ячейки.
    if (start !== null && session.snapMode === 'sector' && !byVertices) {
      closeStroke();
      const under = areaAt(start);
      if (under !== null) {
        notice = 'Выбрана область: ' + under.name + '.';
        commit(selectArea(session, under.id));
        return;
      }
      createFromSectorCell(start);
      return;
    }

    // Щелчок без движения у свободной линии — это выделение, а не точка.
    if (toolState.tool === 'free-line' && start !== null && toolState.path.length < CLICK_POINTS) {
      closeStroke();
      const area = areaAt(start);
      if (area !== null) {
        notice = 'Выбрана область: ' + area.name + '.';
        commit(selectArea(session, area.id));
        return;
      }
      notice = 'Короткий штрих: нужно не меньше трёх точек.';
      refresh();
      return;
    }

    const finished = byVertices ? finishVertices(toolState) : endDrag(toolState);
    toolState = finished.state;
    closeStroke();
    const check = validateDraft(finished.draft);
    if (!check.ok || finished.draft === null) {
      notice = check.reason ?? 'Фигура не создана.';
      refresh();
      return;
    }
    const draft: ShapeDraft = finished.draft;
    const active = selected();
    const areaId = nextId();
    const strokeId = 'stroke-' + String(session.sequence);
    const stateId = active === null ? ('state-' + areaId) : ('state-' + active.id + '-1');
    notice = null;
    try {
      // Пустая или новая область сразу получает состояние текущего режима,
      // чтобы завершённый штрих был виден на карте одной командой истории.
      commit(snapAndRecordStroke(
        session,
        {
          stroke: {
            id: strokeId,
            points: draft.points,
            closed: draft.closed,
          },
          areaIdIfNew: areaId,
          areaNameIfNew: TOOL_TITLES[draft.tool] + ' ' + String(session.doc.areas.length + 1),
          state: createDefaultState(stateId, session.mode),
        },
        currentViewport(),
        currentCamera(),
      ));
    } catch (error) {
      notice = 'Фигура не создана: ' + (error instanceof Error ? error.message : 'неизвестная ошибка') + '.';
      refresh();
    }
  }

  function nextId(): string {
    return 'area-' + String(session.sequence);
  }

  function forceFill(): void {
    const area = selected();
    if (area === null) {
      notice = 'Выберите область в разделе «Свойства».';
      refresh();
      return;
    }
    const fillCheck = canFillArea(area);
    if (!fillCheck.ok) {
      notice = fillCheck.reason ?? 'Закрасить область нельзя.';
      refresh();
      return;
    }
    const strokeRings = (area.strokes ?? [])
      .filter((stroke) => stroke.closed)
      .map((stroke) => closedStrokeRing(stroke));
    const rings: readonly Ring[] = [...(area.rings as readonly Ring[]), ...strokeRings];
    notice = null;
    commit(addForceFill(session, {
      id: 'force-' + String(session.sequence),
      rings,
      color,
      areaId: area.id,
    }));
  }

  /**
   * Заливка новой замкнутой фигуры как её состояния — второе действие заливки.
   *
   * Отличие от «закрасить» принципиальное, и его не прячут: состояние пишется
   * в саму область, а слой `overrides` не трогается вовсе. Открытая линия не
   * заливается — площади у неё нет; кнопка недоступна заранее, а команда и тут
   * откажет, если вызов всё же дошёл.
   */
  function fillState(): void {
    const area = selected();
    const check = canFillArea(area);
    if (!check.ok || area === null) {
      notice = check.reason ?? 'Залить фигуру нельзя.';
      refresh();
      return;
    }
    const palette = factionPalette();
    // Нейтральная по умолчанию: фракция не выбрана или её нет в палитре данных.
    const chosen = faction !== null && (palette?.has(faction) ?? false) ? faction : null;
    // Состояние того же режима заменяется, а не копится: иначе в одном режиме
    // оказалось бы несколько состояний и проверка документа это отмечала бы.
    const existing = area.states.find((item) => item.mode === session.mode);
    const id = existing?.id ?? ('state-' + area.id + '-' + String(area.states.length + 1));
    const base = createDefaultState(id, session.mode);
    const state: AreaState = chosen === null
      ? base
      : { ...base, factionMode: 'single', factionIds: [chosen] };
    notice = chosen === null
      ? 'Фигура залита нейтральным состоянием.'
      : 'Фигура залита фракцией «' + chosen + '».';
    commit(fillShapeAsState(session, { areaId: area.id, state }));
  }

  function rename(): void {
    const area = selected();
    const input = panel?.querySelector<HTMLInputElement>('[data-field="name"]');
    if (area === null || input === null || input === undefined) return;
    const name = input.value.trim();
    if (name.length === 0) return;
    commit(renameArea(session, area.id, name));
  }

  function addState(): void {
    const area = selected();
    if (area === null) return;
    const id = 'state-' + area.id + '-' + String(area.states.length + 1);
    commit(setState(session, area.id, createDefaultState(id, session.mode)));
  }

  /** Тир адреса: только 5, 6 или 7 букв — мельче снап не работает по контракту. */
  function clampLetters(value: number): 5 | 6 | 7 {
    if (value === 6) return 6;
    if (value === 7) return 7;
    return 5;
  }

  /** Действия, объявленные модулем: выполняются его же командами. */
  function runModuleAction(action: string): void {
    if (action === 'create-area') {
      createNewArea();
      return;
    }
    if (action === 'undo') {
      commit(canUndo(session) ? undo(session) : session);
      return;
    }
    if (action === 'redo') {
      commit(canRedo(session) ? redo(session) : session);
      return;
    }
    if (action === 'force') {
      forceFill();
    }
  }

  function setScreen(next: EditorScreen): void {
    if (next === 'point-properties' && pointSession === null) {
      const snapshots = typeof kernel.data?.propertySnapshots === 'function' ? kernel.data.propertySnapshots() : [];
      const revision = typeof kernel.data?.propertyContentRevision === 'function' ? kernel.data.propertyContentRevision() : null;
      pointSession = createPropertySession(snapshots, revision);
      const activeDataset = kernel.state.activePlanetId ? 'places' : 'systems';
      const activeId = kernel.state.activePlanetId ?? kernel.state.activeSystemId;
      const selectedIndex = snapshots.findIndex((item) => item.dataset === activeDataset && item.recordId === activeId);
      pointIndex = Math.max(0, selectedIndex);
    }
    activeScreen = next;
    setCollapsed(false);
    refresh();
  }

  function setEnabled(value: boolean): void {
    const changed = value !== on;
    on = value;
    if (!on) closeStroke();
    refresh();
    if (changed) options.onEnableChange?.(on);
  }

  /* ------------------------------------------------------------------- события */

  function applyValueAction(action: string, input: HTMLInputElement): void {
    switch (action) {
      case 'mode': commit(setMode(session, input.value as Mode)); break;
      case 'snap': commit(setSnapMode(session, input.value as SnapMode)); break;
      case 'width': {
        // Ручной ввод может дать ноль, минус или мусор: команда тогда бросает
        // RangeError. Панель не падает, а честно говорит, что осталось прежним.
        const value = Number(input.value);
        if (!Number.isFinite(value) || value <= 0) {
          notice = 'Ширина кисти должна быть положительным числом: оставлено ' + session.brushWidthPx + ' px.';
          refresh();
          break;
        }
        const clamped = Math.min(40, Math.max(1, Math.round(value)));
        notice = clamped === value ? null : 'Ширина кисти ограничена ' + clamped + ' px.';
        try {
          commit(setBrushWidth(session, clamped));
        } catch (error) {
          notice = 'Ширину кисти изменить не удалось: оставлено ' + session.brushWidthPx + ' px.';
          refresh();
        }
        break;
      }
      case 'snap-letters': snapLetters = clampLetters(Number(input.value)); refresh(); break;
      case 'faction': faction = input.value.trim().length === 0 ? null : input.value; refresh(); break;
      case 'parent': {
        const area = selected();
        if (area !== null && validParent(area.id, input.value)) commit(setParent(session, area.id, input.value || null));
        break;
      }
      case 'select': commit(selectArea(session, input.value === '' ? null : input.value)); break;
      default: break;
    }
  }

  function onPanelChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('[data-action]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action === null) return;
    if (action === 'point-import' && pointSession !== null) {
      const input = control as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      input.value = '';
      if (file.size > 2_000_000) { pointNotice = 'Черновик слишком велик (максимум 2 МБ).'; updatePointSummary(); return; }
      void file.text().then((text) => {
        try {
          if (pointSession === null) throw new Error('Сессия закрыта.');
          const restored = restorePropertyDraft(JSON.parse(text) as unknown, pointSession, pointFactions());
          setPointSession(restored.session);
          pointNotice = 'Локальный черновик загружен; он не отправлен и не опубликован.';
          refresh();
        } catch (error) {
          pointNotice = 'Загрузка не выполнена: ' + (error instanceof Error ? error.message : 'некорректный файл.');
          updatePointSummary();
        }
      }).catch(() => { pointNotice = 'Загрузка не выполнена: файл не прочитан.'; updatePointSummary(); });
      return;
    }
    if (action === 'point-review-ack' && pointReview !== null) {
      pointReview.acknowledged = (control as HTMLInputElement).checked;
      pointReview.confirmed = false;
      const confirm = panel?.querySelector<HTMLButtonElement>('[data-action="point-review-confirm"]');
      if (confirm) confirm.disabled = !pointReview.acknowledged;
      const review = panel?.querySelector('[data-point-review] [role="status"]');
      if (review) review.remove();
      return;
    }
    if (action === 'point-select' && pointSession !== null) {
      const index = Number((control as HTMLSelectElement).value);
      if (Number.isInteger(index) && index >= 0 && index < pointSession.snapshots.length) pointIndex = index;
      refresh();
      return;
    }
    if (action === 'point-field' && pointSession !== null) {
      const field = control.getAttribute('data-point-field') as PropertyField;
      const selected = pointSession.snapshots[pointIndex];
      if (selected && PROPERTY_FIELDS.includes(field)) setPointSession(editProperty(pointSession, selected.dataset, selected.recordId, field, (control as HTMLInputElement).value));
      pointNotice = null;
      updatePointSummary();
      return;
    }
    // Импорт выгруженного файла областей (дефект B6 ревью): полный цикл
    // «экспорт в файл → импорт через UI → правка» без записи в репозиторий.
    if (action === 'areas-import') {
      const input = control as HTMLInputElement;
      const files = input.files;
      const file = files === null || files === undefined ? null : files[0] ?? null;
      if (file === null) return;
      void file.text().then((text) => {
        let imported = false;
        try {
          session = importDoc(text);
          notice = `Области загружены: ${session.doc.areas.length} шт.; история очищена.`;
          imported = true;
        } catch (error) {
          notice = `Импорт не выполнен: ${error instanceof Error ? error.message : 'некорректные данные.'}`;
        }
        // Сброс значения: повторный выбор того же файла снова даёт change.
        input.value = '';
        if (imported) apply();
        else refresh();
      }).catch(() => {
        notice = 'Импорт не выполнен: файл не прочитан.';
        refresh();
      });
      return;
    }
    applyValueAction(action, control as HTMLInputElement);
  }

  /** Подсветка соседей без перерисовки DOM и без правки документа. */
  function onGraphHighlight(event: Event): void {
    if (panel === null || !(event.target instanceof Element)) return;
    const node = event.target.closest('.admin-editor-graph-node');
    if (node === null) return;
    const leaving = event.type === 'pointerout' || event.type === 'focusout';
    const id = leaving ? moduleId : (node.getAttribute('data-module') ?? moduleId);
    for (const edge of panel.querySelectorAll('[data-editor-graph] .admin-editor-graph-edge')) {
      edge.setAttribute('data-active', String(edge.getAttribute('data-from') === id || edge.getAttribute('data-to') === id));
    }
  }

  function onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Кнопка реестра и узел графа состоят из вложенных тегов: цель клика —
    // потомок, поэтому действие ищем по ближайшему предку с `[data-action]`.
    const control = target.closest('[data-action]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action === null) return;
    // В реальном браузере клик по `<select>` или числовому `<input>` открывает
    // список/фокус: перерисовка `innerHTML` на `click` закрыла бы список до
    // выбора пункта. Для них ждём `change` (`onPanelChange`), а в Node-заглушках
    // без DOM-классов оставляем прямое срабатывание по `click`.
    const isNativeSelectOrNumber = (typeof HTMLSelectElement !== 'undefined' && control instanceof HTMLSelectElement)
      || (typeof HTMLInputElement !== 'undefined' && control instanceof HTMLInputElement && control.type === 'number');
    if (isNativeSelectOrNumber) return;
    const input = control as HTMLInputElement;

    switch (action) {
      case 'navigation-toggle': {
        if (panel !== null) {
          const compact = panel.classList.toggle('is-navigation-collapsed');
          control.setAttribute('aria-expanded', compact ? 'false' : 'true');
          syncNavigationHeight();
        }
        break;
      }
      case 'help': openHelp(); break;
      case 'help-close': closeHelp(); break;
      case 'collapse': setCollapsed(true); break;
      case 'expand': setCollapsed(false); break;
      case 'toggle-enable': setEnabled(input.checked); break;
      case 'mode':
      case 'snap':
      case 'width':
      case 'snap-letters':
      case 'faction':
      case 'select':
      case 'parent':
        applyValueAction(action, input);
        break;
      // Инструмент, фильтр графа и выбор модуля — состояние интерфейса: `refresh`,
      // а не `commit`, поэтому в журнале и в истории отмен следов не оставляют.
      case 'tool': {
        const tool = control.getAttribute('data-tool') ?? '';
        if (!isToolId(tool)) break;
        toolState = selectTool(toolState, tool);
        notice = null;
        refresh();
        break;
      }
      case 'screen': {
        const next = control.getAttribute('data-screen') ?? '';
        if (!isEditorScreen(next)) break;
        setScreen(next);
        break;
      }
      case 'relation-filter': {
        const plane = control.getAttribute('data-plane') ?? '';
        if (!isRelationFilter(plane)) break;
        relationFilter = plane;
        refresh();
        break;
      }
      case 'module': {
        const nextModule = control.getAttribute('data-module') ?? '';
        if (nextModule.length > 0 && moduleById(nextModule) !== null) {
          moduleId = nextModule;
          activeScreen = 'module';
          setCollapsed(false);
        }
        refresh();
        break;
      }
      case 'module-run': runModuleAction(control.getAttribute('data-run') ?? ''); break;
      case 'point-submit': { void submitPointRequest(); break; }
      case 'point-preview': {
        if (pointSession !== null) {
          const preview = preparePropertyIssuePreview(pointSession, pointFactions());
          if (preview !== null) {
            pointReview = { preview, acknowledged: false, confirmed: false };
            pointSubmitOutcome = null;
            // Тот же ID сохраняется: повтор после неизвестного результата не создаст дубль.
            if (pointSubmission !== null && pointSubmission.snapshot !== preview.draftSnapshot) pointSubmission = null;
          }
          updatePointSummary();
        }
        break;
      }
      case 'point-review-confirm': {
        if (pointReview !== null && pointReview.acknowledged && pointSession !== null) {
          const current = preparePropertyIssuePreview(pointSession, pointFactions());
          if (current !== null && current.draftSnapshot === pointReview.preview.draftSnapshot) {
            pointReview.confirmed = true;
          } else {
            pointReview = null;
            pointNotice = 'Содержимое изменилось: проверьте предпросмотр заново.';
          }
          updatePointSummary();
        }
        break;
      }
      case 'point-export': {
        if (pointSession !== null) {
          const draft = pointDraft(pointSession).draft;
          if (draft !== null) download('sector-properties-local-draft.json', JSON.stringify(draft, null, 2) + '\n', 'application/json');
        }
        break;
      }
      case 'point-undo': if (pointSession !== null) { setPointSession(undoProperty(pointSession)); refresh(); } break;
      case 'point-redo': if (pointSession !== null) { setPointSession(redoProperty(pointSession)); refresh(); } break;
      case 'create-area': createNewArea(); break;
      case 'preview': {
        previewOn = input.checked;
        if (previewOn) {
          lastViewKey = '';
          paintOverlay();
          startOverlayLoop();
        } else {
          stopOverlayLoop();
        }
        refresh();
        break;
      }
      case 'rename': rename(); break;
      case 'add-state': addState(); break;
      case 'remove': {
        const area = selected();
        if (area !== null) commit(removeArea(session, area.id));
        break;
      }
      case 'force': forceFill(); break;
      case 'fill-state': fillState(); break;
      case 'undo': if (canUndo(session)) commit(undo(session)); break;
      case 'redo': if (canRedo(session)) commit(redo(session)); break;
      case 'draft-save': notice = draft.save() ? 'Черновик сохранён.' : 'Черновик не сохранился.'; refresh(); break;
      case 'draft-load': notice = draft.load() ? 'Черновик загружен.' : 'Черновик не найден.'; refresh(); break;
      case 'draft-clear': draft.clear(); notice = 'Черновик очищен.'; refresh(); break;
      case 'download': download('sector-areas.json', exportDoc(session), 'application/json'); break;
      case 'copy': void copyJson().then((ok) => { notice = ok ? 'JSON скопирован.' : 'Скопировать не удалось.'; refresh(); }); break;
      case 'request': download('sector-areas-request.md', requestMaterial(session.doc), 'text/markdown'); break;
      default: break;
    }
  }

  function onPanelKeyDown(event: KeyboardEvent): boolean {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    // Родные кнопки, ссылки и поля ввода обрабатывают Enter/Пробел сами.
    const tag = (target as { tagName?: string }).tagName?.toUpperCase() ?? '';
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') return false;
    if (typeof HTMLButtonElement !== 'undefined' && target instanceof HTMLButtonElement) return false;
    if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return false;
    if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return false;
    if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return false;
    const control = target.closest('[data-action]');
    if (control === null) return false;
    event.preventDefault();
    onPanelClick(event);
    return true;
  }

  function onColorInput(): void {
    const input = panel?.querySelector<HTMLInputElement>('[data-field="color"]');
    if (input !== null && input !== undefined) color = input.value;
  }

  function pointAt(event: PointerEvent): AreaPoint | null {
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const world = kernel.renderer.toWorld(event.clientX - rect.left, event.clientY - rect.top);
    if (world === null || !isFinite(world.x) || !isFinite(world.y)) return null;
    return [world.x, world.y];
  }

  /** Шаг прореживания в мировых единицах: порог задан в пикселях экрана. */
  function minStepWorld(): number {
    return MIN_STEP_PX / registryContext().scale;
  }

  function onPointerDown(event: PointerEvent): void {
    // Правило ввода: жест начинается только на канве карты, только основной
    // левой кнопкой и никогда — на органе интерфейса. Панели лежат внутри
    // `.map-stage`, поэтому без этой проверки перехватчик глушил бы их клики.
    if (!on || !canStartStroke(event, canvas)) return;
    const point = pointAt(event);
    if (point === null) return;
    // Перехват раньше обработчиков карты: панорама не должна мешать вводу.
    event.stopPropagation();
    const byVertices = toolInput(toolState.tool) === 'vertices';
    // Кликовым инструментам нужен `dblclick`: `preventDefault` на `pointerdown`
    // отменяет совместимые события мыши, и двойной клик дошёл бы мёртвым.
    if (!byVertices) event.preventDefault();
    toolState = byVertices ? addVertex(toolState, point) : beginDrag(toolState, point);
    drawing = true;
    // Захват указателя нужен только перетаскиванию: клики ставят вершины по
    // одному, и удерживать ввод на стадии было бы незачем.
    if (!byVertices && stage !== null) {
      try {
        stage.setPointerCapture(event.pointerId);
        capturedId = event.pointerId;
      } catch (err) {
        capturedId = null;
      }
    }
    if (canvas !== null) canvas.classList.add('editor-drawing');
    paintOverlay();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !drawing || !canContinueStroke(event)) return;
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    if (toolState.phase !== 'drag') {
      // Вершины уже поставлены: курсор тянет «резиновую нить» до следующей.
      toolState = moveCursor(toolState, point);
    } else if (toolState.tool === 'free-line') {
      // Штрих прореживается по шагу в мировых единицах: точки ближе порога
      // не несут формы, но раздувают документ.
      toolState = moveDrag(toolState, point, minStepWorld());
    } else {
      // Прямоугольнику и эллипсу нужны две опорные точки, а не весь путь.
      toolState = moveCursor(toolState, point);
    }
    paintOverlay();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drawing) return;
    // Отпускание любой другой кнопки ввод не завершает.
    if (event.button !== 0) return;
    // Кликовые инструменты завершаются `Enter` или двойным кликом: отпускание
    // здесь не трогаем вовсе, чтобы событие мыши дошло до браузера.
    if (toolInput(toolState.tool) === 'vertices') return;
    event.stopPropagation();
    event.preventDefault();
    completeInput();
  }

  /** Двойной клик завершает ввод по вершинам; масштаб карте при этом не меняем. */
  function onDoubleClick(event: Event): void {
    if (!on || !drawing || toolInput(toolState.tool) !== 'vertices') return;
    if (!canContinueStroke(event)) return;
    event.preventDefault();
    event.stopPropagation();
    completeInput();
  }

  /** Правая кнопка во время ввода — отмена, как в классическом лассо. */
  function onContextMenu(event: Event): void {
    if (!drawing) return;
    event.preventDefault();
    event.stopPropagation();
    notice = 'Ввод отменён.';
    closeStroke();
    refresh();
  }

  function onKeyDown(event: KeyboardEvent): void {
    // `Escape` приходит именно так: сравнение с 'escape' не срабатывало никогда.
    if (event.key === 'Escape' && helpOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeHelp();
      return;
    }
    // Окно справки и панель живут вне канвы, но клавиши карты слушают документ.
    // Обработчик стоит в фазе перехвата, поэтому его `stopPropagation` не даёт
    // вводу в админском интерфейсе сработать как клавише карты (ADM-UI §8 п.3).
    const target = event.target;
    if (insideHelp(target)) {
      event.stopPropagation();
      return;
    }
    if (insidePanel(target)) {
      // Capture на window срабатывает раньше bubble-обработчика панели. Сначала
      // даём SVG-органам панели их клавиатурную активацию, затем изолируем карту.
      const handled = onPanelKeyDown(event);
      event.stopPropagation();
      if (handled) return;
    }
    // Поля ввода и редактируемые узлы не отдаём редактору ни при каких условиях:
    // иначе `Ctrl+Z` ломает правку текста, а `F` не даёт написать слово с «ф».
    // `contenteditable` добавлен вместе с правкой линий (карточка SEC-VISUAL-EDIT).
    if (isTextEntryTarget(target)) return;
    // Разбор клавиши вынесен в чистую функцию: ею же проверяется раскладка.
    const hotkey = editorHotkey(event);
    if (activeScreen === 'point-properties' && pointSession !== null && (hotkey === 'undo' || hotkey === 'redo')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      setPointSession(hotkey === 'undo' ? undoProperty(pointSession) : redoProperty(pointSession));
      refresh();
      return;
    }
    //
    // `Ctrl+Z` и `Ctrl+Shift+Z` — журнал редактора. Пока редактор открыт, они
    // работают независимо от режима рисования: выключив «Рисовать границы»,
    // нужно иметь возможность отменить только что сделанное. Решение владельца
    // по карточке P2; раньше охранник ниже глушил отмену вместе с рисованием.
    // Линейная правка активна — уступаем обе клавиши (отмену и повтор) модулю
    // правки линий: иначе одно нажатие обрабатывают два журнала.
    const lineMode = options.isLineMode?.() ?? false;
    if (hotkeyOwnedByLineMode(hotkey, lineMode)) return;
    if (hotkey === 'undo') {
      event.preventDefault();
      // Что именно откатывается, берём из журнала до отката: после `undo`
      // последняя запись уже снята и назвать её нечем.
      const note = lastEventNote(session.doc);
      const applied = canUndo(session);
      commit(applied ? undo(session) : session);
      options.onHistory?.('undo', historyNotice('undo', note, applied));
      return;
    }
    if (hotkey === 'redo') {
      event.preventDefault();
      const note = session.future[0] === undefined ? null : lastEventNote(session.future[0]);
      const applied = canRedo(session);
      commit(applied ? redo(session) : session);
      options.onHistory?.('redo', historyNotice('redo', note, applied));
      return;
    }
    // Ниже — только режим рисования: `F` и команды ввода фигуры.
    if (!on) return;
    if (hotkey === 'force') {
      event.preventDefault();
      forceFill();
      return;
    }
    // `Enter` завершает ввод по вершинам — то же, что двойной клик.
    if (hotkey === 'finish' && drawing && toolInput(toolState.tool) === 'vertices') {
      event.preventDefault();
      completeInput();
      return;
    }
    if (hotkey === 'cancel' && drawing) {
      event.preventDefault();
      notice = 'Ввод отменён.';
      closeStroke();
      refresh();
    }
  }

  function insideHelp(target: EventTarget | null): boolean {
    return help !== null && typeof Node !== 'undefined' && target instanceof Node && help.contains(target);
  }

  function insidePanel(target: EventTarget | null): boolean {
    return panel !== null && typeof Element !== 'undefined' && target instanceof Element && panel.contains(target);
  }

  async function copyJson(): Promise<boolean> {
    const text = exportDoc(session);
    try {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      return false;
    }
    return false;
  }

  /* ------------------------------------------------------------------ черновик */

  const draft: SectorAreasEditorDraft = {
    save(): boolean {
      if (storage === null) return false;
      try {
        storage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: new Date().toISOString(), doc: session.doc }));
        return true;
      } catch (err) {
        return false;
      }
    },
    load(): boolean {
      if (storage === null) return false;
      const raw = storage.getItem(DRAFT_KEY);
      if (raw === null) return false;
      try {
        const parsed = JSON.parse(raw) as { doc?: unknown };
        if (parsed.doc === undefined) return false;
        const next = parseSectorAreas(parsed.doc);
        // Новая сессия считается по загруженному документу: иначе счётчик
        // начинался бы с единицы и новые области получали занятые id.
        const restored = createEditorSession(next);
        session = {
          ...restored,
          mode: session.mode,
          snapMode: session.snapMode,
          brushWidthPx: session.brushWidthPx,
          past: [...session.past, session.doc],
          pastSelections: [...(session.pastSelections ?? session.past.map(() => null)), session.selection],
          future: [],
          futureSelections: [],
        };
        apply();
        return true;
      } catch (err) {
        return false;
      }
    },
    clear(): void {
      if (storage === null) return;
      storage.removeItem(DRAFT_KEY);
    },
    info(): string | null {
      return draftInfoText();
    },
  };

  /* --------------------------------------------------------------------- wiring */

  type Handler = (event: Event) => void;
  const listeners: { target: EventTarget; type: string; handler: Handler; capture: boolean }[] = [];

  function bind(target: EventTarget | null, type: string, handler: Handler, capture = false): void {
    if (target === null) return;
    target.addEventListener(type, handler, capture);
    listeners.push({ target, type, handler, capture });
  }

  // Ввод слушается на стадии карты в фазе перехвата: канва — её потомок, и
  // обработчики панорамы на ней просто не получают событий рисования.
  const inputTarget: EventTarget | null = stage ?? canvas;
  bind(typeof window === 'undefined' ? null : window, 'resize', syncNavigationHeight);
  bind(panel, 'click', onPanelClick);
  for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) bind(panel, type, onGraphHighlight);
  bind(panel, 'change', onPanelChange);
  bind(panel, 'keydown', onPanelKeyDown as unknown as Handler);
  bind(panel, 'input', onColorInput);
  bind(inputTarget, 'pointerdown', onPointerDown as unknown as Handler, true);
  bind(inputTarget, 'pointermove', onPointerMove as unknown as Handler, true);
  bind(inputTarget, 'pointerup', onPointerUp as unknown as Handler, true);
  bind(inputTarget, 'pointercancel', onPointerUp as unknown as Handler, true);
  bind(inputTarget, 'contextmenu', onContextMenu, true);
  // Двойной клик завершает ввод по вершинам. Перехват на стадии: канва слушает
  // `dblclick` для масштаба, и её обработчик не должен получать этот жест.
  bind(inputTarget, 'dblclick', onDoubleClick, true);
  // Фаза перехвата на `window`: карта слушает `document` в фазе всплытия,
  // поэтому `Escape` и ввод в админском интерфейсе доходят сначала сюда.
  bind(typeof window === 'undefined' ? null : window, 'keydown', onKeyDown as unknown as Handler, true);

  restoreCollapsed();
  refresh();

  return {
    session(): EditorSession { return session; },
    applySession(next: EditorSession): void {
      session = next;
      apply();
    },
    doc(): SectorAreasDoc { return session.doc; },
    screen(): EditorScreen { return activeScreen; },
    setScreen,
    refresh,
    setEnabled,
    enabled(): boolean { return on; },
    collapsed,
    setCollapsed,
    draft,
    exportJson(): string { return exportDoc(session); },
    requestMaterial(): string { return requestMaterial(session.doc); },
    destroy(): void {
      navigationObserver?.disconnect();
      panel?.style?.removeProperty?.('--shell-top');
      stage?.style?.removeProperty?.('--admin-content-top');
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler, item.capture);
      listeners.length = 0;
      stopOverlayLoop();
      closeStroke();
      if (preview !== null) {
        preview.remove();
        preview = null;
        previewCtx = null;
      }
      if (help !== null) {
        help.remove();
        help = null;
        helpReturn = null;
      }
    },
  };
}

/* Толщина мазка: ширина в пикселях переводится в мировые единицы масштабом
 * кадра, иначе на разных масштабах кисть давала бы разную толщину. */
export function brushWidth(options: { readonly session: EditorSession; readonly scale: number }): number {
  return brushWidthInWorld(options.session, options.scale);
}

/** Контур по готовому штриху: для предпросмотра и для команды создания области. */
export function strokeRing(points: readonly AreaPoint[], width: number): Ring {
  return thickenStroke(points, width);
}

/** Разбор документа, выгруженного редактором: строго через валидатор. */
export function parseExported(json: string): SectorAreasDoc {
  return importDoc(json).doc;
}

export { parseSectorAreas };
