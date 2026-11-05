/* Редактор границ: интерфейс в админской копии сектора (шаг 2 §11 части 2).
 *
 * Работает только в `site/sector/admin-edit/` — на публичном `/sector/` модуль
 * не инициализируется. Данные берутся из `kernel.state.sectorAreas`, то есть из
 * того же `data/sector-areas.json`, что читает публичная страница: своего
 * снимка у редактора нет.
 *
 * Ввод идёт на `#mapCanvas` в фазе перехвата: пока рисование включено, карта не
 * получает pointer-события и не уезжает под курсором. Все изменения идут через
 * команды слоя `sector-areas-editor.ts`, поэтому журнал и отмена работают так
 * же, как из кода.
 */

import { DEFAULT_GRADIENT, MODES, emptySectorAreasDoc, parseSectorAreas } from './sector-areas-contract.ts';
import type { Area, AreaEvent, AreaState, Mode, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
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
import { totalVertices } from './sector-areas-geometry.ts';
import { brushWidthInWorld, thickenStroke } from './sector-areas-editor.ts';
import type { AtlasKernel } from './config.ts';

export const DRAFT_KEY = 'timeline.sector-areas.draft.v1';
/** Минимальный шаг между точками мазка в пикселях экрана. */
export const MIN_STEP_PX = 6;

export interface SectorAreasEditorUiOptions {
  readonly kernel: AtlasKernel;
  /** Панель `[data-admin-editor]`. */
  readonly panel: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Хранилище черновика; `null` — черновик отключён (например, в тестах). */
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
  draft: SectorAreasEditorDraft;
  /** Документ в виде JSON для выгрузки. */
  exportJson(): string;
  /** Готовый материал для заявки в GitHub. */
  requestMaterial(): string;
  destroy(): void;
}

/* -------------------------------------------------------------- чистые утилиты */

/**
 * Прореживает мазок: точки ближе `minDistance` не несут формы, но раздувают
 * документ. Первая и последняя сохраняются всегда — начало и конец штриха
 * важны для замыкания.
 */
export function strokePoints(points: readonly [number, number][], minDistance: number): [number, number][] {
  if (points.length === 0 || minDistance <= 0) return [...points];
  const kept: [number, number][] = [points[0]!];
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

function defaultState(id: string, mode: Mode): AreaState {
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

/* ------------------------------------------------------------------ редактор */

export function createSectorAreasEditorUi(options: SectorAreasEditorUiOptions): SectorAreasEditorUiApi {
  const { kernel, panel, canvas } = options;
  const storage = options.storage === undefined
    ? (typeof window === 'undefined' ? null : window.localStorage)
    : options.storage;

  let session: EditorSession = createEditorSession(kernel.state.sectorAreas ?? emptySectorAreasDoc());
  let on = false;
  let drawing = false;
  let stroke: [number, number][] = [];
  let color = '#ffcc00';
  let notice: string | null = null;

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

  /* ------------------------------------------------------------------- панель */

  function modulesHtml(): string {
    const modeOptions = MODES.map((mode) => (
      `<option value="${mode}"${mode === session.mode ? ' selected' : ''}>${modeLabel(mode)}</option>`
    )).join('');
    return [
      '<label class="admin-editor-field"><input type="checkbox" data-action="toggle-enable"' + (on ? ' checked' : '') + '> Рисовать границы</label>',
      '<label class="admin-editor-field">Режим <select data-action="mode">' + modeOptions + '</select></label>',
      '<label class="admin-editor-field">Привязка <select data-action="snap">',
      '<option value="free"' + (session.snapMode === 'free' ? ' selected' : '') + '>свободная</option>',
      '<option value="sector"' + (session.snapMode === 'sector' ? ' selected' : '') + '>к сектору</option>',
      '</select></label>',
      '<label class="admin-editor-field">Кисть, px <input type="number" min="1" max="40" step="1" value="' + session.brushWidthPx + '" data-action="width"></label>',
      '<p class="admin-editor-hint">ЛКМ — провести границу. <kbd>F</kbd> — закрасить выбранную область. <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить.</p>',
    ].join('');
  }

  function modeLabel(mode: Mode): string {
    const labels: Record<Mode, string> = {
      political: 'политический',
      military: 'военный',
      economy: 'экономический',
      tension: 'напряжённость',
    };
    return labels[mode] ?? mode;
  }

  function propertiesHtml(): string {
    const areas = session.doc.areas;
    if (areas.length === 0) {
      return '<p class="admin-editor-hint">Областей пока нет: проведите границу на карте.</p>';
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
      '<label class="admin-editor-field">Цвет заливки <input type="color" value="' + color + '" data-field="color"></label>',
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
    const draftInfo = draftInfoText();
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
      '<p class="admin-editor-hint">' + escapeHtml(draftInfo) + '</p>',
      '<div class="admin-editor-row">',
      '<button type="button" data-action="download">Скачать JSON</button>',
      '<button type="button" data-action="copy">Скопировать</button>',
      '<button type="button" data-action="request">Материал заявки</button>',
      '</div>',
      notice === null ? '' : '<p class="admin-editor-hint">' + escapeHtml(notice) + '</p>',
    ].join('');
  }

  function draftInfoText(): string {
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
    const modules = panel.querySelector('[data-editor-block="modules"]');
    const properties = panel.querySelector('[data-editor-block="properties"]');
    const changes = panel.querySelector('[data-editor-block="changes"]');
    if (modules !== null) modules.innerHTML = modulesHtml();
    if (properties !== null) properties.innerHTML = propertiesHtml();
    if (changes !== null) changes.innerHTML = changesHtml();
  }

  /* --------------------------------------------------------------- дейстpanel */

  function closeStroke(): void {
    drawing = false;
    stroke = [];
    if (canvas !== null) canvas.classList.remove('editor-drawing');
  }

  function finishStroke(): void {
    const points = strokePoints(stroke, MIN_STEP_PX);
    closeStroke();
    if (points.length < 3) {
      notice = 'Короткий штрих: нужно не меньше трёх точек.';
      refresh();
      return;
    }
    notice = null;
    const name = 'Область ' + (session.doc.areas.length + 1);
    commit(addAreaFromStroke(session, {
      id: nextId(),
      name,
      points,
      closed: true,
      source: session.snapMode === 'sector' ? 'sector' : 'brush',
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
    commit(setState(session, area.id, defaultState(id, session.mode)));
  }

  /* ------------------------------------------------------------------- события */

  function setEnabled(value: boolean): void {
    on = value;
    if (!on) closeStroke();
    refresh();
  }

  function onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.getAttribute('data-action');
    if (action === null) return;
    const input = target as HTMLInputElement;

    switch (action) {
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

  function pointAt(event: PointerEvent): [number, number] | null {
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const world = kernel.renderer.toWorld(event.clientX - rect.left, event.clientY - rect.top);
    if (world === null || !isFinite(world.x) || !isFinite(world.y)) return null;
    return [world.x, world.y];
  }

  function onPointerDown(event: PointerEvent): void {
    if (!on || canvas === null) return;
    // Перехват до обработчиков карты: панорама не должна мешать штриху.
    event.stopImmediatePropagation();
    event.preventDefault();
    const point = pointAt(event);
    if (point === null) return;
    drawing = true;
    stroke = [point];
    canvas.classList.add('editor-drawing');
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !drawing || canvas === null) return;
    event.stopImmediatePropagation();
    const point = pointAt(event);
    if (point === null) return;
    stroke.push(point);
    kernel.renderer.requestRender();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!on || !drawing) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    finishStroke();
  }

  function onKeyDown(event: KeyboardEvent): void {
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
  const listeners: { target: EventTarget; type: string; handler: Handler }[] = [];

  function bind(target: EventTarget | null, type: string, handler: Handler, capture = false): void {
    if (target === null) return;
    if (capture) target.addEventListener(type, handler, true);
    else target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  bind(panel, 'click', onPanelClick);
  bind(panel, 'input', onColorInput);
  bind(canvas, 'pointerdown', onPointerDown as unknown as Handler, true);
  bind(canvas, 'pointermove', onPointerMove as unknown as Handler, true);
  bind(canvas, 'pointerup', onPointerUp as unknown as Handler, true);
  bind(canvas, 'pointercancel', onPointerUp as unknown as Handler, true);
  bind(typeof window === 'undefined' ? null : window, 'keydown', onKeyDown as unknown as Handler);

  return {
    session(): EditorSession { return session; },
    doc(): SectorAreasDoc { return session.doc; },
    refresh,
    setEnabled,
    enabled(): boolean { return on; },
    draft,
    exportJson(): string { return exportDoc(session); },
    requestMaterial(): string { return requestMaterial(session.doc); },
    destroy(): void {
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler, true);
      listeners.length = 0;
      closeStroke();
    },
  };
}

/* Толщина мазка: ширина в пикселях переводится в мировые единицы масштабом
 * кадра, иначе на разных масштабах кисть давала бы разную толщину. */
export function brushWidth(options: { readonly session: EditorSession; readonly scale: number }): number {
  return brushWidthInWorld(options.session, options.scale);
}

/** Контур по готовому штриху: для предпросмотра и для команды создания области. */
export function strokeRing(points: readonly [number, number][], width: number): Ring {
  return thickenStroke(points, width);
}

/** Разбор документа, выгруженного редактором: строго через валидатор. */
export function parseExported(json: string): SectorAreasDoc {
  return importDoc(json).doc;
}

export { parseSectorAreas };
