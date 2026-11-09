/* UI правки линий границ сектора: панель, overlay, ввод, экспорт (этап 3 §11).
 *
 * Слой с DOM: рендерит раздел «Линии» в панели редактора, слушает стадию карты
 * и рисует предпросмотр деформации на отдельном overlay-канвасе. Модель без
 * DOM lives в `sector-bounds-edit.ts` — здесь только вызов её команд и отрисовка.
 *
 * Координация с редактором областей: при включении «Правки линий» рисование
 * штрихов выключается (callback `onActivate`), при выключении — включается
 * обратно (`onDeactivate`). Ctrl+Z при активной линейной правке уступает этому
 * модулю: hook `isLineMode` в редакторе областей пропускает отмену.
 */

import { escapeHtml } from './config.ts';
import type { AtlasKernel, MapPoint } from './config.ts';
import { canStartStroke, canContinueStroke } from './pointer-rules.ts';
import {
  beginBoundsEdit,
  cancelBoundsEdit,
  commitBoundsEdit,
  createBoundsEditSession,
  moveBoundsEditCore,
  pickBoundsEdge,
  redoBoundsEdit,
  selectBoundsEdge,
  serializeBoundsEdit,
  undoBoundsEdit,
} from './sector-bounds-edit.ts';
import type { BoundsEditSession } from './sector-bounds-edit.ts';
import type { SectorBounds } from './sector-bounds.ts';

/* ------------------------------------------------------------------ типы */

export interface SectorBoundsEditUiOptions {
  readonly kernel: AtlasKernel;
  readonly panel: HTMLElement | null;
  readonly stage: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Линейная правка активна — вызывается при включении. */
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
  destroy(): void;
}

/* --------------------------------------------------------------- константы */

/** Радиус выбора сегмента в экранных пикселях. */
const PICK_PX = 25;
/** Радиус «попа» по ядру в экранных пикселях. */
const CORE_HIT_PX = 22;
/** Минимальное перемещение ядра для коммита (мировые единицы). */
const COMMIT_EPSILON = 0.5;

/** Пустой документ границ: парсер контракта читает пустой список контуров. */
function emptyBounds(): SectorBounds {
  return { version: 1, mapSize: 10000, source: 'editor', bounds: [] };
}

/* ---------------------------------------------------------------- модуль */

export function createSectorBoundsEditUi(options: SectorBoundsEditUiOptions): SectorBoundsEditUiApi {
  const { kernel, panel, stage, canvas } = options;
  const initial = kernel.state.sectorBounds;
  let session: BoundsEditSession = createBoundsEditSession(initial ?? emptyBounds());
  let on = false;
  /** Перетаскивание ядра: вектор в мировых единицах. */
  let dragging = false;
  let capturedId: number | null = null;
  let notice: string | null = null;

  /* overlay-канвас: предпросмотр выбранного сегмента, якорей и ядра. */
  let preview: HTMLCanvasElement | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;
  let overlayW = 1;
  let overlayH = 1;
  let overlayFrame = 0;
  let lastViewKey = '';

  const listeners: { target: EventTarget; type: string; handler: (event: Event) => void; capture: boolean }[] = [];

  /* ------------------------------------------------------------- координаты */

  function pointAt(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (stage === null) return null;
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function screenOf(world: readonly [number, number]): MapPoint | null {
    return kernel.renderer.toScreen(world[0], world[1]);
  }

  /** Толеранс выбора сегмента в мировых единицах: 25 пикселей по масштабу. */
  function pickTolerance(): number {
    const scale = kernel.state.view?.scale ?? 1;
    return PICK_PX / Math.max(0.0001, scale);
  }

  function viewKey(): string {
    const v = kernel.state.view;
    const vp = kernel.state.viewport;
    return `${v?.tx ?? 0}:${v?.ty ?? 0}:${v?.scale ?? 1}:${vp?.w ?? 0}:${vp?.h ?? 0}`;
  }

  /* ------------------------------------------------------- применение документа */

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
      node.className = 'admin-editor-line-preview';
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
    if (session.selection !== null) drawSelection(ctx);
    if (session.active !== null) drawActive(ctx);
    ctx.restore();
  }

  /** Выбранный сегмент: толстая полупрозрачная линия. */
  function drawSelection(ctx: CanvasRenderingContext2D): void {
    const selection = session.selection;
    if (selection === null) return;
    const contour = session.doc.bounds.find((item) => item.id === selection.contourId);
    if (contour === undefined) return;
    const a = contour.points[selection.edgeIndex];
    const b = contour.points[selection.edgeIndex + 1];
    if (a === undefined || b === undefined) return;
    const sa = screenOf(a);
    const sb = screenOf(b);
    if (sa === null || sb === null) return;
    ctx.save();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255, 204, 0, .55)';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.restore();
  }

  /** Активная правка: 5 якорей, ядро, предпросмотр кривой. */
  function drawActive(ctx: CanvasRenderingContext2D): void {
    const active = session.active;
    if (active === null) return;
    const contour = session.doc.bounds.find((item) => item.id === active.contourId);
    if (contour === undefined) return;
    const a = contour.points[active.edgeIndex];
    const b = contour.points[active.edgeIndex + 1];
    if (a === undefined || b === undefined) return;
    const sa = screenOf(a);
    const sb = screenOf(b);
    if (sa === null || sb === null) return;

    ctx.save();
    // Предпросмотр кривой: деформированный сегмент.
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 120, 120, .9)';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < active.curve.length; i += 1) {
      const sp = screenOf(active.curve[i]!);
      if (sp === null) continue;
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();

    // Исходный сегмент — серая линия для контраста.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(180, 180, 180, .5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // 5 якорей: ромбы.
    for (const anchor of active.anchors) {
      const sp = screenOf(anchor);
      if (sp === null) continue;
      ctx.fillStyle = '#7fd4ff';
      ctx.strokeStyle = 'rgba(255, 255, 255, .8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const r = 5;
      ctx.moveTo(sp.x, sp.y - r);
      ctx.lineTo(sp.x + r, sp.y);
      ctx.lineTo(sp.x, sp.y + r);
      ctx.lineTo(sp.x - r, sp.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Ядро: круг,Dragable.
    const core = screenOf(active.core);
    if (core !== null) {
      ctx.fillStyle = dragging ? '#ff6060' : '#ffcc00';
      ctx.strokeStyle = 'rgba(255, 255, 255, .9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(core.x, core.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* overlay-loop: перерисовка при смене кадра (панорама/зум). */
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
    const bounds = session.doc;
    const hasBounds = kernel.state.sectorBounds !== null && kernel.state.sectorBounds !== undefined;
    const selection = session.selection;
    const active = session.active;
    const status = [
      `Контуров: ${bounds.bounds.length}`,
      selection !== null ? `сегмент ${selection.contourId} #${selection.edgeIndex}` : 'сегмент не выбран',
      active !== null ? 'правка активна' : '',
      `журнал: ${session.past.length}`,
    ].filter((part) => part.length > 0).join(' · ');
    return [
      '<p class="admin-editor-meta"><strong>Линии</strong> · правка контуров границ',
      '<div class="admin-editor-grid">',
      '  <button type="button" class="admin-editor-tool' + (on ? ' is-current' : '') + '"'
        + ' data-action="line-tool"'
        + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
        + ' title="Правка линий границ сектора">Правка линий</button>',
      '  <button type="button" data-action="line-export" title="Выгрузить границы как JSON">Выгрузить JSON</button>',
      '  <button type="button" data-action="line-undo" title="Отменить правку (Ctrl+Z)">Отменить</button>',
      '  <button type="button" data-action="line-redo" title="Повтор (Ctrl+Shift+Z)">Повторить</button>',
      '</div>',
      '<p class="admin-editor-hint">'
        + 'ЛКМ — выбрать участок линии. Двойной клик — открыть правку (ядро + 5 якорей).'
        + ' Перетаскивание ядра деформирует границу; отпускание — применить.'
        + ' <kbd>Esc</kbd> — отменить правку, <kbd>Ctrl</kbd>+<kbd>Z</kbd> — отменить коммит.'
        + '</p>',
      notice !== null ? `<p class="admin-editor-notice">${escapeHtml(notice)}</p>` : '',
      `<p class="admin-editor-status-text">${escapeHtml(status)}</p>`,
      hasBounds ? '' : '<p class="admin-editor-notice">Границы сектора не загружены: правка линий недоступна.</p>',
      '</div>',
    ].join('');
  }

  function refresh(): void {
    if (panel === null) return;
    const block = panel.querySelector('[data-editor-block="lines"]');
    if (block !== null) block.innerHTML = linesBlockHtml();
    if (session.selection !== null || session.active !== null) {
      lastViewKey = '';
      paintOverlay();
      startOverlayLoop();
    } else {
      stopOverlayLoop();
    }
  }

  function setEnabled(value: boolean): void {
    const wasOn = on;
    on = value;
    if (!on && dragging) {
      dragging = false;
      capturedId = null;
      cancelBoundsEdit(session);
    }
    if (on && !wasOn) {
      options.onActivate?.();
      if (session.selection === null && session.active === null) {
        lastViewKey = '';
        paintOverlay();
        startOverlayLoop();
      }
    } else if (!on && wasOn) {
      options.onDeactivate?.();
      stopOverlayLoop();
    }
    refresh();
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

  function onPointerDown(event: PointerEvent): void {
    if (!on) return;
    if (!canStartStroke(event, canvas)) return;
    const point = pointAt(event);
    if (point === null) return;
    event.stopPropagation();
    // Если правка активна и клик близок к ядру — перетаскивание.
    if (session.active !== null) {
      const coreScreen = screenOf(session.active.core);
      if (coreScreen !== null) {
        const dx = point.x - coreScreen.x;
        const dy = point.y - coreScreen.y;
        if (Math.hypot(dx, dy) <= CORE_HIT_PX) {
          event.preventDefault();
          dragging = true;
          if (stage !== null) {
            try {
              stage.setPointerCapture(event.pointerId);
              capturedId = event.pointerId;
            } catch (err) {
              capturedId = null;
            }
          }
          if (canvas !== null) canvas.classList.add('editor-drawing');
          paintOverlay();
          return;
        }
      }
    }
    event.preventDefault();
    // Выбор сегмента по клику.
    const world = kernel.renderer.toWorld(point.x, point.y);
    const picked = pickBoundsEdge(session.doc, world.x, world.y, pickTolerance());
    session = selectBoundsEdge(session, picked);
    paintOverlay();
    refresh();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !dragging) return;
    if (!canContinueStroke(event)) return;
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    const world = kernel.renderer.toWorld(point.x, point.y);
    session = moveBoundsEditCore(session, [world.x, world.y]);
    paintOverlay();
  }

  function onPointerUp(event: PointerEvent): void {
    if (!on || !dragging) return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    dragging = false;
    if (capturedId !== null && stage !== null) {
      try { stage.releasePointerCapture(capturedId); } catch (err) { /* уже отпущено */ }
    }
    capturedId = null;
    if (canvas !== null) canvas.classList.remove('editor-drawing');
    const moved = session.active !== null
      && Math.hypot(
        session.active.core[0] - session.active.anchors[2]![0],
        session.active.core[1] - session.active.anchors[2]![1],
      ) > COMMIT_EPSILON;
    if (moved) {
      commit(commitBoundsEdit(session));
      notice = 'Сегмент деформирован и применён.';
    } else {
      cancelBoundsEdit(session);
    }
    refresh();
  }

  function onDoubleClick(event: Event): void {
    if (!on) return;
    if (!(event instanceof PointerEvent) && !(event instanceof MouseEvent)) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (!canContinueStroke(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointAt(event);
    if (point === null) return;
    const world = kernel.renderer.toWorld(point.x, point.y);
    const picked = pickBoundsEdge(session.doc, world.x, world.y, pickTolerance());
    if (picked === null) {
      notice = 'Кликнул вне линии: правка не открыта.';
      refresh();
      return;
    }
    session = beginBoundsEdit(session, picked.contourId, picked.edgeIndex, [world.x, world.y]);
    notice = 'Правка открыта: перетаскивайте ядро.';
    paintOverlay();
    refresh();
  }

  function onContextMenu(event: Event): void {
    if (!on) return;
    if (session.active === null) return;
    event.preventDefault();
    event.stopPropagation();
    cancelBoundsEdit(session);
    notice = 'Правка отменена.';
    refresh();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!on) return;
    const target = event.target;
    if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return;
    if (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement) return;
    if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return;
    // Escape завершает правку.
    if (event.key === 'Escape' && session.active !== null) {
      event.preventDefault();
      event.stopPropagation();
      cancelBoundsEdit(session);
      notice = 'Правка отменена (Esc).';
      refresh();
      return;
    }
    // Ctrl+Z / Ctrl+Shift+Z — журнал линейной правки.
    const withModifier = event.ctrlKey === true || event.metaKey === true;
    if (!withModifier) return;
    const code = event.code;
    if (code === 'KeyZ') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        if (session.future.length > 0) {
          commit(redoBoundsEdit(session));
          notice = 'Правка повторена.';
        }
      } else if (session.past.length > 0) {
        commit(undoBoundsEdit(session));
        notice = 'Правка отменена.';
      }
      refresh();
    }
  }

  /* ------------------------------------------------------------------ wiring */

  function bind(target: EventTarget | null, type: string, handler: (event: Event) => void, capture = false): void {
    if (target === null) return;
    target.addEventListener(type, handler, capture);
    listeners.push({ target, type, handler, capture });
  }

  const inputTarget: EventTarget | null = stage ?? canvas;
  bind(panel, 'click', onPanelClick);
  bind(inputTarget, 'pointerdown', onPointerDown as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointermove', onPointerMove as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointerup', onPointerUp as unknown as (event: Event) => void, true);
  bind(inputTarget, 'pointercancel', onPointerUp as unknown as (event: Event) => void, true);
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
    destroy(): void {
      for (const item of listeners) item.target.removeEventListener(item.type, item.handler, item.capture);
      listeners.length = 0;
      stopOverlayLoop();
      if (dragging) {
        dragging = false;
        capturedId = null;
      }
      if (preview !== null && preview.parentNode !== null) preview.parentNode.removeChild(preview);
      preview = null;
      previewCtx = null;
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
