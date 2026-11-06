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
  addAreaFromStroke,
  addForceFill,
  canFillArea,
  canRedo,
  canUndo,
  createEditorSession,
  exportDoc,
  fillShapeAsState,
  importDoc,
  redo,
  removeArea,
  renameArea,
  selectArea,
  setBrushWidth,
  setMode,
  setSnapMode,
  setState,
  undo,
} from './sector-areas-editor.ts';
import type { EditorSession, SnapMode } from './sector-areas-editor.ts';
import { areaSize } from './sector-areas-render.ts';
import { pointInArea, totalVertices } from './sector-areas-geometry.ts';
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
  PLANE_QUESTIONS,
  PLANE_TITLES,
  STATUS_TITLES,
  documentReport,
  modeLabel,
  moduleById,
  moduleRows,
  modulesByPlane,
} from './sector-areas-registry.ts';
import type { RegistryContext, RegistrySystem, SectorModule } from './sector-areas-registry.ts';
import type { AtlasView, SystemRecord } from './config.ts';
import { NO_FACTION_KEY } from './config.ts';
import { canContinueStroke, canStartStroke, isDrawButton as isDrawButtonRule } from './pointer-rules.ts';
import { brushWidthInWorld, thickenStroke } from './sector-areas-editor.ts';
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
}

export interface SectorAreasEditorDraft {
  save(): boolean;
  load(): boolean;
  clear(): void;
  info(): string | null;
}

export interface SectorAreasEditorUiApi {
  session(): EditorSession;
  doc(): SectorAreasDoc;
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

/** Строка журнала: `override · a-1 · Форс-закрашивание force-3 цветом #00ff00`. */
export function eventLine(event: AreaEvent): string {
  const area = event.areaId === null ? '' : ' · ' + event.areaId;
  const note = event.note === null ? 'без комментария' : event.note;
  return `${event.kind}${area} · ${note}`;
}

/** Заголовок области в списке: имя плюс число вершин. */
export function areaLabel(area: Area): string {
  return `${area.name} (${totalVertices(area)} верш.)`;
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
  }

  function commit(next: EditorSession): void {
    session = next;
    apply();
  }

  /* ------------------------------------------------------- предпросмотр штриха */

  function previewCanvas(): CanvasRenderingContext2D | null {
    if (stage === null) return null;
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

  /* ------------------------------------------------ предпросмотр «было → стало» */

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

  function traceRing(ctx: CanvasRenderingContext2D, area: Area, color: string, dash: readonly number[]): void {
    const ring = area.rings[0];
    if (ring === undefined || ring.length < 2) return;
    let started = false;
    ctx.beginPath();
    ctx.setLineDash([...dash]);
    ctx.strokeStyle = color;
    for (const point of ring) {
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
   * обещать замыкания, которого не будет.
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

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, session.brushWidthPx / 2);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = 'rgba(255, 226, 231, .92)';
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i]!.x, points[i]!.y);
    ctx.stroke();
    ctx.setLineDash([]);
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

  function modulesHtml(): string {
    const modeOptions = MODES.map((mode) => (
      `<option value="${mode}"${mode === session.mode ? ' selected' : ''}>${modeLabel(mode)}</option>`
    )).join('');
    const planes = (['data', 'spatial', 'order'] as const).map((plane) => {
      const items = modulesByPlane(plane).map((module) => {
        const current = module.id === moduleId;
        return '<li><button type="button" class="admin-editor-module' + (current ? ' is-current' : '') + '"'
          + ' data-action="module" data-module="' + escapeHtml(module.id) + '"'
          + ' aria-pressed="' + (current ? 'true' : 'false') + '">'
          + '<span class="admin-editor-module-name">' + escapeHtml(module.label) + '</span>'
          + '<span class="admin-editor-status" data-status="' + module.status + '">'
          + escapeHtml(STATUS_TITLES[module.status]) + '</span></button></li>';
      }).join('');
      return '<div class="admin-editor-plane">'
        + '<h3 class="admin-editor-plane-title">' + escapeHtml(PLANE_TITLES[plane]) + '</h3>'
        + '<p class="admin-editor-hint">' + escapeHtml(PLANE_QUESTIONS[plane]) + '</p>'
        + '<ul class="admin-editor-modules">' + items + '</ul></div>';
    }).join('');
    return [
      '<label class="admin-editor-field admin-editor-field-inline"><input type="checkbox" data-action="toggle-enable"' + (on ? ' checked' : '') + '> Рисовать границы</label>',
      '<div class="admin-editor-grid">',
      '<label class="admin-editor-field">Режим <select data-action="mode">' + modeOptions + '</select></label>',
      '<label class="admin-editor-field">Привязка <select data-action="snap">',
      '<option value="free"' + (session.snapMode === 'free' ? ' selected' : '') + '>свободная</option>',
      '<option value="sector"' + (session.snapMode === 'sector' ? ' selected' : '') + '>к ячейке адреса</option>',
      '</select></label>',
      '<label class="admin-editor-field">Кисть, px <input type="number" min="1" max="40" step="1" value="' + session.brushWidthPx + '" data-action="width"></label>',
      snapLettersHtml(),
      '</div>',
      toolsHtml(),
      '<p class="admin-editor-hint">ЛКМ — контур. ПКМ и колесо — карте. <kbd>F</kbd> — закрасить выбранную, <kbd>Enter</kbd> — завершить вершины, <kbd>Esc</kbd> — прервать или закрыть справку, <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить.</p>',
      '<label class="admin-editor-field admin-editor-field-inline"><input type="checkbox" data-action="preview"' + (previewOn ? ' checked' : '') + '> Предпросмотр «было → стало»</label>',
      previewOn
        ? '<p class="admin-editor-hint">Красная линия — область, которой в загруженном документе не станет; зелёная — новая; голубая — без изменений. Данные при предпросмотре не меняются.</p>'
        : '',
      '<div class="admin-editor-planes">' + planes + '</div>',
    ].join('');
  }

  /**
   * Инструменты рисования: пять базовых, как в Paint. Переключение — состояние
   * интерфейса: оно не коммитит документ и не оставляет записи в истории.
   */
  function toolsHtml(): string {
    const buttons = TOOL_IDS.map((tool) => {
      const current = tool === toolState.tool;
      return '<button type="button" class="admin-editor-tool' + (current ? ' is-current' : '') + '"'
        + ' data-action="tool" data-tool="' + escapeHtml(tool) + '"'
        + ' aria-pressed="' + (current ? 'true' : 'false') + '"'
        + ' title="' + escapeHtml(TOOL_TITLES[tool]) + '">' + escapeHtml(TOOL_LABELS[tool]) + '</button>';
    }).join('');
    return '<p class="admin-editor-meta"><strong>Инструмент</strong> · ' + escapeHtml(TOOL_TITLES[toolState.tool]) + '</p>'
      + '<div class="admin-editor-tools" role="group" aria-label="Инструменты рисования">' + buttons + '</div>'
      + '<p class="admin-editor-hint">' + escapeHtml(TOOL_HINTS[toolState.tool]) + '</p>';
  }

  /** Тир секторного снапа выбирается явно: 5, 6 или 7 букв адреса. */
  function snapLettersHtml(): string {
    if (session.snapMode !== 'sector') return '';
    const options = [5, 6, 7].map((value) => (
      `<option value="${value}"${value === snapLetters ? ' selected' : ''}>${value} букв</option>`
    )).join('');
    return '<label class="admin-editor-field">Глубина адреса <select data-action="snap-letters">' + options + '</select></label>';
  }

  function propertiesHtml(): string {
    const module: SectorModule | null = moduleById(moduleId);
    const head = module === null
      ? '<p class="admin-editor-hint">Модуль не выбран.</p>'
      : modulePropertiesHtml(module);
    return head + areaEditorHtml();
  }

  /** Свойства выбранного модуля: значения приходят из его собственных функций. */
  function modulePropertiesHtml(module: SectorModule): string {
    const rows = moduleRows(module, registryContext());
    return [
      '<p class="admin-editor-meta"><strong>' + escapeHtml(module.label) + '</strong><br>'
        + escapeHtml(PLANE_TITLES[module.plane]) + ' · <span class="admin-editor-status" data-status="'
        + module.status + '">' + escapeHtml(STATUS_TITLES[module.status]) + '</span></p>',
      '<p class="admin-editor-hint">' + escapeHtml(module.note) + '</p>',
      '<table class="admin-editor-table"><tbody>' + rows.map((item) => (
        '<tr><th scope="row">' + escapeHtml(item.label) + '</th><td>' + escapeHtml(item.value) + '</td></tr>'
      )).join('') + '</tbody></table>',
      moduleActionsHtml(module),
      '<p class="admin-editor-hint">Файл: <code>' + escapeHtml(module.source) + '</code></p>',
    ].join('');
  }

  function moduleActionsHtml(module: SectorModule): string {
    const actions = module.actions ?? [];
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
  function areaEditorHtml(): string {
    const areas = session.doc.areas;
    if (areas.length === 0) {
      return '<p class="admin-editor-hint">Областей пока нет: проведите контур на карте.</p>';
    }
    const options = areas.map((area) => (
      `<option value="${escapeHtml(area.id)}"${area.id === session.selection ? ' selected' : ''}>${escapeHtml(areaLabel(area))}</option>`
    )).join('');
    const area = selected() ?? areas[0]!;
    return [
      '<p class="admin-editor-meta"><strong>Область</strong> · правка командой</p>',
      '<label class="admin-editor-field">Область <select data-action="select">' + options + '</select></label>',
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
      'Вершин: ' + totalVertices(area) + ' · площадь: ' + Math.round(areaSize(area)).toLocaleString('ru-RU'),
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
  function refresh(): void {
    if (panel === null) return;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    const editing = typeof HTMLInputElement !== 'undefined'
      && active instanceof HTMLInputElement
      && active.getAttribute('data-field') === 'name'
      ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    const summary = panel.querySelector('[data-editor-summary]');
    const modules = panel.querySelector('[data-editor-block="modules"]');
    const properties = panel.querySelector('[data-editor-block="properties"]');
    const changes = panel.querySelector('[data-editor-block="changes"]');
    if (summary !== null) summary.textContent = summaryText();
    if (modules !== null) modules.innerHTML = modulesHtml();
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
    if (previewOn) {
      lastViewKey = '';
      paintOverlay();
    }
  }

  /** Сводка в шапке: режим, кисть и привязка видны и при свёрнутых разделах. */
  function summaryText(): string {
    const state = on ? 'рисование включено' : 'рисование выключено';
    const snap = session.snapMode === 'sector' ? `к ячейке (${snapLetters} букв)` : 'свободная';
    const preview = previewOn ? ' · предпросмотр «было → стало»' : '';
    const pending = drawing ? ' · ввод не завершён' : '';
    return `${state} · инструмент: ${TOOL_TITLES[toolState.tool]} · режим: ${modeLabel(session.mode)}`
      + ` · кисть: ${session.brushWidthPx} px · привязка: ${snap}${preview}${pending}`;
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

  /** Область под курсором: верхняя из подходящих (последняя нарисованная). */
  function areaAt(point: AreaPoint): Area | null {
    const areas = session.doc.areas;
    for (let i = areas.length - 1; i >= 0; i -= 1) {
      const area = areas[i]!;
      if (pointInArea(area, point[0], point[1])) return area;
    }
    return null;
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
   * Порядок прежний: сначала привязка к ячейке адреса, затем выделение щелчком
   * у свободной линии, затем фигура. Фигура проверяется существующими правилами,
   * и только годная уходит в документ одной командой — значит, и одной записью
   * в историю. Недопустимая фигуру не создаёт, а говорит, что не так.
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
        session = selectArea(session, under.id);
        refresh();
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
        session = selectArea(session, area.id);
        refresh();
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
    const id = nextId();
    notice = null;
    try {
      // Область сразу получает состояние текущего режима: иначе она создаётся,
      // но остаётся невидимой — рендер показывает только области с состояниями.
      commit(addAreaFromStroke(session, {
        id,
        name: TOOL_TITLES[draft.tool] + ' ' + (session.doc.areas.length + 1),
        points: draft.points,
        closed: draft.closed,
        source: 'brush',
        state: createDefaultState('state-' + id, session.mode),
        // Открытой линии площади нет: её положение `unknown`, а не догадка.
        location: draft.closed ? null : 'unknown',
      }));
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
    notice = null;
    commit(addForceFill(session, {
      id: 'force-' + String(session.sequence),
      rings: area.rings as readonly Ring[],
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

  function setEnabled(value: boolean): void {
    on = value;
    if (!on) closeStroke();
    refresh();
  }

  /* ------------------------------------------------------------------- события */

  function onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // Кнопка реестра состоит из подписей внутри: цель клика — вложенный узел,
    // поэтому действие ищем по ближайшему предку, а не по самой цели.
    const control = target.closest('[data-action]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action === null) return;
    const input = control as HTMLInputElement;

    switch (action) {
      case 'help': openHelp(); break;
      case 'help-close': closeHelp(); break;
      case 'collapse': setCollapsed(true); break;
      case 'expand': setCollapsed(false); break;
      case 'toggle-enable': setEnabled(input.checked); break;
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
      // Инструмент и фракция — состояние интерфейса: `refresh`, а не `commit`,
      // поэтому в журнале и в истории отмен они не оставляют следов.
      case 'tool': {
        const tool = control.getAttribute('data-tool') ?? '';
        if (!isToolId(tool)) break;
        toolState = selectTool(toolState, tool);
        notice = null;
        refresh();
        break;
      }
      case 'faction': faction = input.value.trim().length === 0 ? null : input.value; refresh(); break;
      case 'module': moduleId = control.getAttribute('data-module') ?? moduleId; refresh(); break;
      case 'module-run': runModuleAction(control.getAttribute('data-run') ?? ''); break;
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
      case 'select': commit(selectArea(session, input.value)); break;
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
    if (insidePanel(target)) event.stopPropagation();
    if (!on) return;
    if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return;
    if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return;
    if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return;
    // Разбор клавиши вынесен в чистую функцию: ею же проверяется раскладка.
    const hotkey = editorHotkey(event);
    if (hotkey === 'undo') {
      event.preventDefault();
      commit(canUndo(session) ? undo(session) : session);
      return;
    }
    if (hotkey === 'redo') {
      event.preventDefault();
      commit(canRedo(session) ? redo(session) : session);
      return;
    }
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
  bind(panel, 'click', onPanelClick);
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
    doc(): SectorAreasDoc { return session.doc; },
    refresh,
    setEnabled,
    enabled(): boolean { return on; },
    collapsed,
    setCollapsed,
    draft,
    exportJson(): string { return exportDoc(session); },
    requestMaterial(): string { return requestMaterial(session.doc); },
    destroy(): void {
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
