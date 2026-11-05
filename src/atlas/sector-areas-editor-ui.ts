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
  addAreaFromStroke,
  addForceFill,
  canRedo,
  canUndo,
  createEditorSession,
  exportDoc,
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
  return button === 0;
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

/** Состояние по умолчанию: цвет режима, полный диапазон глубин. */
export function createDefaultState(id: string, mode: Mode): AreaState {
  return {
    id,
    mode,
    factionMode: 'single',
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
  lines.push('- `npx tsc --noEmit` — типы без замечаний.');
  lines.push('- `npx eslint src tests` — без замечаний.');
  lines.push('- `npm run verify:docs` — документация актуальна.');
  lines.push('- `npm test` — страж реестра без новых падений.');
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

const MODE_LABELS: Record<Mode, string> = {
  political: 'политический',
  military: 'военный',
  economy: 'экономический',
  tension: 'напряжённость',
};

export function modeLabel(mode: Mode): string {
  return MODE_LABELS[mode] ?? mode;
}

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
  let stroke: AreaPoint[] = [];
  let color = '#ffcc00';
  let notice: string | null = null;
  let capturedId: number | null = null;

  /* Окно справки создаётся лениво и живёт вне панели: у панели своя прокрутка,
   * а окно должно лежать поверх карты. */
  let help: HTMLElement | null = null;
  let helpReturn: HTMLElement | null = null;

  /* Предпросмотр штриха: отдельный канвас поверх карты. Области рисует общий
   * рендер сцены, а «резиновая нить» живёт только во время штриха. */
  let preview: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;

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
    if (previewCtx !== null) {
      previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      previewCtx.clearRect(0, 0, w, h);
    }
    return previewCtx;
  }

  function screenOf(point: AreaPoint): { x: number; y: number } | null {
    return kernel.renderer.toScreen(point[0], point[1]);
  }

  /** «Резиновая нить»: сам штрих и линия от курсора к началу (замыкание). */
  function drawPreview(): void {
    const ctx = previewCanvas();
    if (ctx === null || preview === null) return;
    const points: { x: number; y: number }[] = [];
    for (const point of stroke) {
      const screen = screenOf(point);
      if (screen !== null) points.push(screen);
    }
    if (points.length === 0) return;

    const w = Number(preview.style.width.replace('px', '')) || preview.clientWidth;
    const h = Number(preview.style.height.replace('px', '')) || preview.clientHeight;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, session.brushWidthPx / 2);
    ctx.setLineDash([7, 5]);
    ctx.strokeStyle = 'rgba(255, 226, 231, .92)';
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i]!.x, points[i]!.y);
    if (points.length > 2) ctx.lineTo(points[0]!.x, points[0]!.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 226, 231, .95)';
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
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
    return [
      '<label class="admin-editor-field admin-editor-field-inline"><input type="checkbox" data-action="toggle-enable"' + (on ? ' checked' : '') + '> Рисовать границы</label>',
      '<div class="admin-editor-grid">',
      '<label class="admin-editor-field">Режим <select data-action="mode">' + modeOptions + '</select></label>',
      '<label class="admin-editor-field">Привязка <select data-action="snap">',
      '<option value="free"' + (session.snapMode === 'free' ? ' selected' : '') + '>свободная</option>',
      '<option value="sector"' + (session.snapMode === 'sector' ? ' selected' : '') + '>к сектору</option>',
      '</select></label>',
      '<label class="admin-editor-field">Кисть, px <input type="number" min="1" max="40" step="1" value="' + session.brushWidthPx + '" data-action="width"></label>',
      '</div>',
      '<p class="admin-editor-hint">ЛКМ — контур. ПКМ и колесо — карте. <kbd>F</kbd> — закрасить выбранную, <kbd>Esc</kbd> — прервать, <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить.</p>',
    ].join('');
  }

  function propertiesHtml(): string {
    const areas = session.doc.areas;
    if (areas.length === 0) {
      return '<p class="admin-editor-hint">Областей пока нет: проведите контур на карте.</p>';
    }
    const options = areas.map((area) => (
      `<option value="${escapeHtml(area.id)}"${area.id === session.selection ? ' selected' : ''}>${escapeHtml(areaLabel(area))}</option>`
    )).join('');
    const area = selected() ?? areas[0]!;
    return [
      '<label class="admin-editor-field">Область <select data-action="select">' + options + '</select></label>',
      '<label class="admin-editor-field">Название <input type="text" value="' + escapeHtml(area.name) + '" data-field="name"></label>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="rename">Переименовать</button>',
      '<button type="button" data-action="add-state">Состояние</button>',
      '<button type="button" data-action="remove">Удалить</button>',
      '</div>',
      '<label class="admin-editor-field admin-editor-field-inline">Цвет заливки <input type="color" value="' + color + '" data-field="color"></label>',
      '<div class="admin-editor-row"><button type="button" data-action="force">Закрасить (F)</button></div>',
      '<p class="admin-editor-meta">',
      'Вершин: ' + totalVertices(area) + ' · площадь: ' + Math.round(areaSize(area)).toLocaleString('ru-RU'),
      ' · состояний: ' + area.states.length,
      (area.address ? ' · адрес: ' + escapeHtml(area.address) : ''),
      '</p>',
    ].join('');
  }

  function changesHtml(): string {
    const events = session.doc.events.slice(-12).reverse();
    const journal = events.length === 0
      ? '<p class="admin-editor-hint">Журнал пуст.</p>'
      : '<ol class="admin-editor-log">' + events.map((event) => (
        '<li>' + escapeHtml(eventLine(event)) + '</li>'
      )).join('') + '</ol>';
    return [
      '<div class="admin-editor-row">',
      '<button type="button" data-action="undo"' + (canUndo(session) ? '' : ' disabled') + '>Отменить</button>',
      '<button type="button" data-action="redo"' + (canRedo(session) ? '' : ' disabled') + '>Повторить</button>',
      '</div>',
      journal,
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

  function refresh(): void {
    if (panel === null) return;
    const summary = panel.querySelector('[data-editor-summary]');
    const modules = panel.querySelector('[data-editor-block="modules"]');
    const properties = panel.querySelector('[data-editor-block="properties"]');
    const changes = panel.querySelector('[data-editor-block="changes"]');
    if (summary !== null) summary.textContent = summaryText();
    if (modules !== null) modules.innerHTML = modulesHtml();
    if (properties !== null) properties.innerHTML = propertiesHtml();
    if (changes !== null) changes.innerHTML = changesHtml();
  }

  /** Сводка в шапке: режим, кисть и привязка видны и при свёрнутых разделах. */
  function summaryText(): string {
    const state = on ? 'рисование включено' : 'рисование выключено';
    return `${state} · режим: ${modeLabel(session.mode)} · кисть: ${session.brushWidthPx} px · привязка: ${session.snapMode === 'sector' ? 'к сектору' : 'свободная'}`;
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
    drawing = false;
    stroke = [];
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

  function finishStroke(): void {
    const points = strokePoints(stroke, MIN_STEP_PX);
    const start = stroke[0] ?? null;
    closeStroke();
    // Щелчок без движения — это выделение, а не попытка нарисовать точку.
    if (points.length < CLICK_POINTS) {
      if (start !== null) {
        const area = areaAt(start);
        if (area !== null) {
          notice = 'Выбрана область: ' + area.name + '.';
          session = selectArea(session, area.id);
          refresh();
          return;
        }
      }
      notice = 'Короткий штрих: нужно не меньше трёх точек.';
      refresh();
      return;
    }
    notice = null;
    const id = nextId();
    // Область сразу получает состояние текущего режима: иначе она создаётся,
    // но остаётся невидимой — рендер показывает только области с состояниями.
    commit(addAreaFromStroke(session, {
      id,
      name: 'Область ' + (session.doc.areas.length + 1),
      points,
      closed: true,
      source: session.snapMode === 'sector' ? 'sector' : 'brush',
      state: createDefaultState('state-' + id, session.mode),
    }));
  }

  function nextId(): string {
    return 'area-' + String(session.sequence + 1);
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
      id: 'force-' + String(session.sequence + 1),
      rings: area.rings as readonly Ring[],
      color,
      areaId: area.id,
    }));
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

  function setEnabled(value: boolean): void {
    on = value;
    if (!on) closeStroke();
    refresh();
  }

  /* ------------------------------------------------------------------- события */

  function onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute('data-action');
    if (action === null) return;
    const input = target as HTMLInputElement;

    switch (action) {
      case 'help': openHelp(); break;
      case 'help-close': closeHelp(); break;
      case 'collapse': setCollapsed(true); break;
      case 'expand': setCollapsed(false); break;
      case 'toggle-enable': setEnabled(input.checked); break;
      case 'mode': commit(setMode(session, input.value as Mode)); break;
      case 'snap': commit(setSnapMode(session, input.value as SnapMode)); break;
      case 'width': commit(setBrushWidth(session, Number(input.value) || session.brushWidthPx)); break;
      case 'select': commit(selectArea(session, input.value)); break;
      case 'rename': rename(); break;
      case 'add-state': addState(); break;
      case 'remove': {
        const area = selected();
        if (area !== null) commit(removeArea(session, area.id));
        break;
      }
      case 'force': forceFill(); break;
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
    const scale = kernel.state.view.scale || 1;
    return MIN_STEP_PX / scale;
  }

  function onPointerDown(event: PointerEvent): void {
    // Правая и средняя кнопки — карте: панорама и контекстное меню.
    if (!on || !isDrawButton(event.button) || !event.isPrimary) return;
    // Перехват раньше обработчиков карты: панорама не должна мешать штриху.
    event.stopPropagation();
    event.preventDefault();
    const point = pointAt(event);
    if (point === null) return;
    drawing = true;
    stroke = [point];
    if (stage !== null) {
      try {
        stage.setPointerCapture(event.pointerId);
        capturedId = event.pointerId;
      } catch (err) {
        capturedId = null;
      }
    }
    if (canvas !== null) canvas.classList.add('editor-drawing');
    drawPreview();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !drawing) return;
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    const last = stroke[stroke.length - 1];
    if (last !== undefined) {
      const dx = point[0] - last[0];
      const dy = point[1] - last[1];
      if (Math.hypot(dx, dy) < minStepWorld()) return;
    }
    stroke.push(point);
    drawPreview();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drawing) return;
    // Отпускание любой другой кнопки штрих не завершает.
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    finishStroke();
  }

  /** Правая кнопка во время штриха — отмена, как в классическом лассо. */
  function onContextMenu(event: Event): void {
    if (!drawing) return;
    event.preventDefault();
    event.stopPropagation();
    notice = 'Штрих отменён.';
    closeStroke();
    refresh();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'escape' && helpOpen()) {
      event.preventDefault();
      closeHelp();
      return;
    }
    if (!on) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'z') {
      event.preventDefault();
      commit(event.shiftKey ? (canRedo(session) ? redo(session) : session) : (canUndo(session) ? undo(session) : session));
      return;
    }
    if (key === 'f') {
      event.preventDefault();
      forceFill();
      return;
    }
    if (key === 'escape' && drawing) closeStroke();
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
        session = { ...session, doc: next, past: [...session.past, session.doc], future: [] };
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
  bind(typeof window === 'undefined' ? null : window, 'keydown', onKeyDown as unknown as Handler);

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
