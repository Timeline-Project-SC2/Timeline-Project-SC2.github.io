/* UI правки линий границ сектора: панель, overlay, ввод, экспорт и импорт.
 *
 * Слой с DOM: рендерит раздел «Линии» в панели редактора, слушает стадию карты
 * и рисует предпросмотр на **отдельном overlay-канвасе** поверх карты. Модель
 * без DOM живёт в `sector-bounds-edit.ts` — здесь только вызов её команд и
 * отрисовка.
 *
 * Почему overlay не был виден (исправлено): канвас создавался без класса стилей,
 * то есть попадал в обычный поток `.map-stage`. Соседний `#mapCanvas` —
 * `position: absolute`, а позиционированные элементы рисуются выше элементов
 * потока, поэтому overlay оказывался **под картой**. Теперь у класса
 * `.admin-editor-line-preview` есть правило в `site/sector/admin-edit/admin-edit.css`
 * (absolute, inset 0, `pointer-events: none`, z-index выше карты и ниже панелей).
 * Правило закреплено тестом `sector-bounds-edit-ui.test.mjs`.
 *
 * Координация с редактором областей: при включении «Правки линий» рисование
 * штрихов выключается (callback `onActivate`), при выключении возвращается
 * **прежнее** состояние инструмента (callback `onDeactivate`), а не безусловное
 * «включено». Ctrl+Z/Ctrl+Shift+Z при активной линейной правке уступает этому
 * модулю: hook `isLineMode` в редакторе областей пропускает обе клавиши.
 */

import { escapeHtml } from './config.ts';
import type { AtlasKernel, MapPoint } from './config.ts';
import { canStartStroke, canContinueStroke, isTextEntryTarget } from './pointer-rules.ts';
import {
  beginBoundsEdit,
  cancelBoundsEdit,
  commitBoundsEdit,
  createBoundsEditSession,
  importBoundsEdit,
  moveBoundsEditCore,
  parseBoundsEdit,
  pickBoundsEdge,
  redoBoundsEdit,
  selectBoundsEdge,
  serializeBoundsEdit,
  undoBoundsEdit,
} from './sector-bounds-edit.ts';
import type { BoundsEditSession } from './sector-bounds-edit.ts';
import type { Point, SectorBounds } from './sector-bounds.ts';

/* ------------------------------------------------------------------ типы */

export interface SectorBoundsEditUiOptions {
  readonly kernel: AtlasKernel;
  readonly panel: HTMLElement | null;
  readonly stage: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Линейная правка включена — вызывается при включении. */
  readonly onActivate?: () => void;
  /** Линейная правка выключена — вызывается при выключении. */
  readonly onDeactivate?: () => void;
}

export interface SectorBoundsEditUiApi {
  session(): BoundsEditSession;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  refresh(): void;
  exportJson(): string;
  /** Импорт документа из JSON-текста; `false` — данные не прошли контракт. */
  importJson(text: string): boolean;
  destroy(): void;
}

/* --------------------------------------------------------------- константы */

/** Радиус выбора участка в экранных пикселях. */
const PICK_PX = 25;
/** Радиус «попа» по ядру в экранных пикселях. */
const CORE_HIT_PX = 22;
/** Минимальное перемещение указателя для коммита (экранные пиксели). */
const DRAG_COMMIT_PX = 2;
/** Класс overlay-канваса: правило живёт в `admin-edit.css`. */
export const OVERLAY_CLASS = 'admin-editor-line-preview';
/** Класс курсора инструмента на канве карты. */
const TOOL_CURSOR_CLASS = 'editor-lines';

/** Пустой документ границ: парсер контракта читает пустой список контуров. */
function emptyBounds(): SectorBounds {
  return { version: 1, mapSize: 10000, source: 'editor', bounds: [] };
}

/* ---------------------------------------------------------------- модуль */

export function createSectorBoundsEditUi(options: SectorBoundsEditUiOptions): SectorBoundsEditUiApi {
  const { kernel, panel, stage, canvas } = options;
  let session: BoundsEditSession = createBoundsEditSession(kernel.state.sectorBounds ?? emptyBounds());
  let on = false;
  let dragging = false;
  let dragStartPoint: MapPoint | null = null;
  let dragMoved = false;
  let capturedId: number | null = null;
  let notice: string | null = null;

  /* overlay-канвас: предпросмотр участка, якорей и ядра. */
  let preview: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;
  let overlayW = 1;
  let overlayH = 1;
  let overlayFrame = 0;
  let lastViewKey = '';

  const listeners: { target: EventTarget; type: string; handler: (event: Event) => void; capture: boolean }[] = [];

  /* ------------------------------------------------------------- координаты */

  function pointAt(event: { clientX: number; clientY: number }): MapPoint | null {
    if (stage === null) return null;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function screenOf(world: readonly [number, number]): MapPoint | null {
    return kernel.renderer.toScreen(world[0], world[1]);
  }

  /** Толеранс выбора участка в мировых единицах: 25 пикселей по масштабу. */
  function pickTolerance(): number {
    const scale = kernel.state.view?.scale ?? 1;
    return PICK_PX / Math.max(0.0001, scale);
  }

  function viewKey(): string {
    const view = kernel.state.view;
    const viewport = kernel.state.viewport;
    return `${view?.tx ?? 0}:${view?.ty ?? 0}:${view?.scale ?? 1}:${viewport?.w ?? 0}:${viewport?.h ?? 0}:${stage?.clientWidth ?? 0}:${stage?.clientHeight ?? 0}`;
  }

  /* ------------------------------------------------------- документ в ядро */

  function apply(): void {
    kernel.state.sectorBounds = session.doc;
    kernel.renderer.requestRender();
    refresh();
  }

  function commit(next: BoundsEditSession): void {
    session = next;
    apply();
  }

  /* ----------------------------------------------------------- overlay-канвас */

  function previewCanvas(): CanvasRenderingContext2D | null {
    if (stage === null || typeof document === 'undefined') return null;
    if (preview === null) {
      const node = document.createElement('canvas');
      node.className = OVERLAY_CLASS;
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

  function clearPreview(): void {
    const ctx = previewCtx;
    if (ctx === null || preview === null) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.restore();
  }

  /* ------------------------------------------------------------- отрисовка */

  function paintOverlay(): void {
    const ctx = previewCanvas();
    if (ctx === null) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, overlayW, overlayH);
    ctx.clip();
    if (session.active !== null) drawActive(ctx);
    else if (session.selection !== null) drawSelection(ctx);
    ctx.restore();
  }

  /** Ломаная по мировым точкам в экранных координатах. */
  function tracePolyline(ctx: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]): boolean {
    let started = false;
    for (const point of points) {
      const screen = screenOf(point);
      if (screen === null) continue;
      if (!started) {
        ctx.moveTo(screen.x, screen.y);
        started = true;
      } else {
        ctx.lineTo(screen.x, screen.y);
      }
    }
    return started;
  }

  /** Выбранный участок: толстая полупрозрачная подсветка вдоль видимой кривой. */
  function drawSelection(ctx: CanvasRenderingContext2D): void {
    const selection = session.selection;
    if (selection === null) return;
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255, 204, 0, .45)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (!tracePolyline(ctx, selection.curve)) {
      ctx.restore();
      return;
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Вектор якоря: короткая стрелка от опоры к ядру — видно, куда тянет каждая
   * опора. Если ядро стоит на самой опоре, рисуется нормаль к линии.
   */
  function anchorVector(ctx: CanvasRenderingContext2D, point: readonly [number, number], core: Point): void {
    const screen = screenOf(point);
    if (screen === null) return;
    const coreScreen = screenOf(core);
    let dx = coreScreen === null ? 0 : coreScreen.x - screen.x;
    let dy = coreScreen === null ? 0 : coreScreen.y - screen.y;
    let length = Math.hypot(dx, dy);
    if (length < 1) {
      // Ядро на опоре: показываем нормаль (направление тяги по умолчанию).
      dx = 0;
      dy = -1;
      length = 1;
    }
    const ux = dx / length;
    const uy = dy / length;
    const tail = 14;
    ctx.beginPath();
    ctx.moveTo(screen.x + ux * 7, screen.y + uy * 7);
    ctx.lineTo(screen.x + ux * (7 + tail), screen.y + uy * (7 + tail));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(screen.x + ux * (8 + tail), screen.y + uy * (8 + tail), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Активная правка: видимая кривая, предпросмотр, 5 якорей-векторов и ядро. */
  function drawActive(ctx: CanvasRenderingContext2D): void {
    const active = session.active;
    if (active === null) return;

    // Подсветка участка остаётся видимой и во время правки.
    ctx.save();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255, 204, 0, .28)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (tracePolyline(ctx, active.base)) ctx.stroke();
    ctx.restore();

    // Исходная видимая кривая участка — серая пунктирная.
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(190, 198, 210, .65)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    if (tracePolyline(ctx, active.base)) ctx.stroke();
    ctx.setLineDash([]);

    // Предпросмотр деформированной кривой.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 120, 120, .95)';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (tracePolyline(ctx, active.curve)) ctx.stroke();

    // 5 якорей-векторов: ромб + короткий вектор «тяги».
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(127, 212, 255, .85)';
    ctx.fillStyle = 'rgba(127, 212, 255, .85)';
    for (const anchor of active.anchors) anchorVector(ctx, anchor, active.core);
    for (const anchor of active.anchors) {
      const screen = screenOf(anchor);
      if (screen === null) continue;
      ctx.beginPath();
      const r = 5;
      ctx.moveTo(screen.x, screen.y - r);
      ctx.lineTo(screen.x + r, screen.y);
      ctx.lineTo(screen.x, screen.y + r);
      ctx.lineTo(screen.x - r, screen.y);
      ctx.closePath();
      ctx.fillStyle = '#7fd4ff';
      ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }

    // Ядро: круг, во время перетаскивания — красный.
    const core = screenOf(active.core);
    if (core !== null) {
      ctx.beginPath();
      ctx.arc(core.x, core.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = dragging ? '#ff6060' : '#ffcc00';
      ctx.strokeStyle = 'rgba(255, 255, 255, .95)';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(core.x, core.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(10, 14, 20, .85)';
      ctx.fill();
    }
    ctx.restore();
  }

  /* overlay-loop: перерисовка при смене кадра (панорама/зум/размер). */
  function overlayStep(): void {
    overlayFrame = 0;
    if (session.selection === null && session.active === null) return;
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

  /* ----------------------------------------------------------- панель */

  function linesBlockHtml(): string {
    if (panel === null) return '';
    const hasBounds = kernel.state.sectorBounds !== null && kernel.state.sectorBounds !== undefined;
    const selection = session.selection;
    const active = session.active;
    const status = [
      `Контуров: ${session.doc.bounds.length}`,
      selection !== null ? `участок ${selection.contourId} #${selection.spanStart}…${selection.spanEnd}` : 'участок не выбран',
      active !== null ? 'правка активна' : '',
      `журнал: ${session.past.length}`,
    ].filter((part) => part.length > 0).join(' · ');
    const undoDisabled = session.past.length === 0 ? ' disabled' : '';
    const redoDisabled = session.future.length === 0 ? ' disabled' : '';
    return [
      '<p class="admin-editor-meta"><strong>Линии</strong> · правка контуров границ</p>',
      '<div class="admin-editor-tools" role="group" aria-label="Инструмент правки линий">',
      '  <button type="button" class="admin-editor-tool' + (on ? ' is-current' : '') + '"'
        + ' data-action="line-tool"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
        + ' title="Правка линий границ сектора: включить или выключить инструмент">Правка линий</button>',
      '</div>',
      '<div class="admin-editor-tools" role="group" aria-label="История правки линий">',
      '  <button type="button" class="admin-editor-tool" data-action="line-undo"' + undoDisabled
        + ' title="Отменить правку (Ctrl+Z)">Отменить</button>',
      '  <button type="button" class="admin-editor-tool" data-action="line-redo"' + redoDisabled
        + ' title="Повторить правку (Ctrl+Shift+Z)">Повторить</button>',
      '  <button type="button" class="admin-editor-tool" data-action="line-export" title="Выгрузить границы как JSON">Выгрузить JSON</button>',
      '</div>',
      '<label class="admin-editor-import" for="lineImportInput">'
        + '<span>Загрузить выгруженный JSON</span>'
        + '<input id="lineImportInput" type="file" accept="application/json,.json" data-action="line-import"'
        + (hasBounds ? '' : ' disabled')
        + ' aria-label="Загрузить выгруженный ранее JSON границ" />'
        + '</label>',
      '<p class="admin-editor-hint">'
        + 'ЛКМ — выбрать участок линии. Двойной клик — открыть правку (ядро + 5 якорей).'
        + ' Перетаскивание ядра деформирует участок; отпускание — применить.'
        + ' <kbd>Esc</kbd> — отменить правку, <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить коммит,'
        + ' <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> — повторить.'
        + '</p>',
      notice !== null ? `<p class="admin-editor-notice">${escapeHtml(notice)}</p>` : '',
      `<p class="admin-editor-status-text" role="status" aria-live="polite">${escapeHtml(status)}</p>`,
      hasBounds ? '' : '<p class="admin-editor-notice">Границы сектора не загружены: правка линий недоступна.</p>',
      '</div>',
    ].join('');
  }

  function refresh(): void {
    if (panel !== null) {
      const block = panel.querySelector('[data-editor-block="lines"]');
      if (block !== null) block.innerHTML = linesBlockHtml();
    }
    if (session.selection !== null || session.active !== null) {
      lastViewKey = '';
      paintOverlay();
      startOverlayLoop();
    } else {
      stopOverlayLoop();
    }
  }

  function setEnabled(value: boolean): void {
    if (value === on) {
      refresh();
      return;
    }
    on = value;
    if (!on) {
      if (dragging) {
        dragging = false;
        capturedId = null;
        session = cancelBoundsEdit(session);
      }
      session = selectBoundsEdge(session, null);
      if (canvas !== null) canvas.classList.remove(TOOL_CURSOR_CLASS);
      stopOverlayLoop();
      options.onDeactivate?.();
      notice = 'Правка линий выключена.';
    } else {
      if (canvas !== null) canvas.classList.add(TOOL_CURSOR_CLASS);
      options.onActivate?.();
      notice = 'Правка линий включена: выберите участок на карте.';
    }
    refresh();
    if (on && session.selection !== null) {
      lastViewKey = '';
      paintOverlay();
      startOverlayLoop();
    }
  }

  /* -------------------------------------------------------------- события */

  function onPanelClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('[data-action]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action === null) return;
    switch (action) {
      case 'line-tool':
        setEnabled(!on);
        break;
      case 'line-export': {
        const json = serializeBoundsEdit(session.doc);
        download('sector-bounds-edit.json', json, 'application/json');
        notice = 'Границы выгружены: sector-bounds-edit.json';
        refresh();
        break;
      }
      case 'line-undo':
        if (session.past.length > 0) {
          commit(undoBoundsEdit(session));
          notice = 'Правка отменена.';
        } else {
          notice = 'Нет записей для отмены.';
        }
        refresh();
        break;
      case 'line-redo':
        if (session.future.length > 0) {
          commit(redoBoundsEdit(session));
          notice = 'Правка повторена.';
        } else {
          notice = 'Нет записей для повтора.';
        }
        refresh();
        break;
      default:
        break;
    }
  }

  /** Импорт выгруженного JSON: контракт проверяется парсером документа. */
  function importJson(text: string): boolean {
    // Импорт работает и при выключенном инструменте: это данные, а не жест карты.
    let doc: SectorBounds;
    try {
      doc = parseBoundsEdit(text);
    } catch (error) {
      notice = `Импорт не выполнен: ${error instanceof Error ? error.message : 'некорректные данные.'}`;
      refresh();
      return false;
    }
    session = importBoundsEdit(doc);
    notice = `Границы загружены: контуров ${session.doc.bounds.length}.`;
    apply();
    return true;
  }

  function onPanelChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const input = target.closest('[data-action="line-import"]');
    if (input === null) return;
    const files = (input as HTMLInputElement).files;
    const file = files === null || files === undefined ? null : files[0] ?? null;
    if (file === null) return;
    void file.text().then((text) => {
      importJson(text);
      // Сброс значения: повторный выбор того же файла снова даёт событие change.
      (input as HTMLInputElement).value = '';
    }).catch(() => {
      notice = 'Импорт не выполнен: файл не прочитан.';
      refresh();
    });
  }

  function onPointerDown(event: PointerEvent): void {
    if (!on) return;
    if (!canStartStroke(event, canvas)) return;
    const point = pointAt(event);
    if (point === null) return;
    event.stopPropagation();
    // Клик рядом с ядром — начало перетаскивания.
    if (session.active !== null) {
      const coreScreen = screenOf(session.active.core);
      if (coreScreen !== null) {
        const hit = Math.hypot(point.x - coreScreen.x, point.y - coreScreen.y) <= CORE_HIT_PX;
        if (hit) {
          event.preventDefault();
          dragging = true;
          dragMoved = false;
          dragStartPoint = point;
          if (stage !== null) {
            try {
              stage.setPointerCapture(event.pointerId);
              capturedId = event.pointerId;
            } catch (err) {
              capturedId = null;
            }
          }
          paintOverlay();
          return;
        }
      }
    }
    event.preventDefault();
    // Иначе — выбор участка по клику.
    const world = kernel.renderer.toWorld(point.x, point.y);
    const picked = pickBoundsEdge(session, world.x, world.y, pickTolerance());
    session = selectBoundsEdge(session, picked);
    if (picked === null) notice = 'Кликнул вне линии: участок не выбран.';
    else notice = null;
    paintOverlay();
    refresh();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !dragging) return;
    if (!canContinueStroke(event)) return;
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    if (dragStartPoint !== null
      && Math.hypot(point.x - dragStartPoint.x, point.y - dragStartPoint.y) >= DRAG_COMMIT_PX) {
      dragMoved = true;
    }
    const world = kernel.renderer.toWorld(point.x, point.y);
    session = moveBoundsEditCore(session, [world.x, world.y]);
    paintOverlay();
  }

  function endDrag(commitIt: boolean): void {
    if (!dragging) return;
    dragging = false;
    if (capturedId !== null && stage !== null) {
      try { stage.releasePointerCapture(capturedId); } catch (err) { /* уже отпущено */ }
    }
    capturedId = null;
    const moved = dragMoved;
    dragMoved = false;
    dragStartPoint = null;
    if (!commitIt || !moved) {
      session = cancelBoundsEdit(session);
      notice = commitIt ? 'Ядро не перемещено: изменений нет.' : 'Правка отменена.';
      paintOverlay();
      refresh();
      return;
    }
    const next = commitBoundsEdit(session);
    const recorded = next.past.length > session.past.length;
    session = next;
    notice = recorded
      ? 'Участок деформирован и применён (Ctrl+Z отменяет).'
      : 'Форма не изменилась: коммит не создан.';
    apply();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!on || !dragging) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    endDrag(true);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (!on || !dragging) return;
    event.stopPropagation();
    endDrag(false);
  }

  function onDoubleClick(event: Event): void {
    if (!on) return;
    if (!(event instanceof MouseEvent)) return;
    if (event.button !== 0) return;
    if (!canContinueStroke(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    const world = kernel.renderer.toWorld(point.x, point.y);
    const picked = pickBoundsEdge(session, world.x, world.y, pickTolerance());
    if (picked === null) {
      notice = 'Двойной клик вне линии: правка не открыта.';
      refresh();
      return;
    }
    const next = beginBoundsEdit(session, picked.contourId, picked.edgeIndex, [world.x, world.y]);
    if (next.active === null) {
      session = next;
      notice = 'Участок слишком короткий: правка не открыта.';
    } else {
      session = next;
      notice = 'Правка открыта: тяните ядро, Esc — отмена.';
    }
    paintOverlay();
    refresh();
  }

  function onContextMenu(event: Event): void {
    if (!on) return;
    if (session.active === null) return;
    event.preventDefault();
    event.stopPropagation();
    session = cancelBoundsEdit(session);
    notice = 'Правка отменена (правая кнопка).';
    paintOverlay();
    refresh();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!on) return;
    if (isTextEntryTarget(event.target)) return;
    if (event.key === 'Escape') {
      if (session.active === null) return;
      event.preventDefault();
      event.stopPropagation();
      session = cancelBoundsEdit(session);
      notice = 'Правка отменена (Esc).';
      paintOverlay();
      refresh();
      return;
    }
    const withModifier = event.ctrlKey === true || event.metaKey === true;
    if (!withModifier) return;
    if (event.code !== 'KeyZ') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      if (session.future.length > 0) {
        commit(redoBoundsEdit(session));
        notice = 'Правка повторена.';
      } else {
        notice = 'Нет записей для повтора.';
      }
    } else if (session.past.length > 0) {
      commit(undoBoundsEdit(session));
      notice = 'Правка отменена.';
    } else {
      notice = 'Нет записей для отмены.';
    }
    refresh();
  }

  /* ------------------------------------------------------------------ wiring */

  function bind(target: EventTarget | null, type: string, handler: (event: Event) => void, capture = false): void {
    if (target === null) return;
    target.addEventListener(type, handler, capture);
    listeners.push({ target, type, handler, capture });
  }

  const inputTarget: EventTarget | null = stage ?? canvas;
  bind(panel, 'click', onPanelClick);
  bind(panel, 'change', onPanelChange);
  bind(inputTarget, 'pointerdown', onPointerDown as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointermove', onPointerMove as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointerup', onPointerUp as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointercancel', onPointerCancel as unknown as (event: Event) => void, true);
  bind(inputTarget, 'contextmenu', onContextMenu, true);
  bind(inputTarget, 'dblclick', onDoubleClick as unknown as (event: Event) => void, true);
  bind(typeof window === 'undefined' ? null : window, 'keydown', onKeyDown as unknown as (event: Event) => void, true);

  refresh();

  return {
    session(): BoundsEditSession { return session; },
    setEnabled,
    enabled(): boolean { return on; },
    refresh,
    exportJson(): string { return serializeBoundsEdit(session.doc); },
    importJson,
    destroy(): void {
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler, item.capture);
      listeners.length = 0;
      stopOverlayLoop();
      dragging = false;
      capturedId = null;
      dragStartPoint = null;
      if (canvas !== null) canvas.classList.remove(TOOL_CURSOR_CLASS);
      if (preview !== null && preview.parentNode !== null) preview.parentNode.removeChild(preview);
      preview = null;
      previewCtx = null;
      if (stage !== null) stage.classList.remove(TOOL_CURSOR_CLASS);
    },
  };
}

/* ------------------------------------------------------------------ вспомогательное */

/** Скачивание файла через `<a download>`: тот же механизм, что в редакторе областей. */
function download(name: string, text: string, type: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
