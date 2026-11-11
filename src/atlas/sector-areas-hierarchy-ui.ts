/* UI иерархии областей: якорная правка контуров (§4), группы (§5) и слои
 * сочетания пар (§6–§7) — панель, overlay и ввод.
 *
 * Слой с DOM по образцу `sector-bounds-edit-ui.ts`: раздел «Иерархия» в панели
 * редактора, отдельный overlay-канвас поверх карты (`pointer-events: none`),
 * слушатели на стадии карты. Модель без DOM — `sector-areas-hierarchy.ts`,
 * `sector-areas-anchors.ts`, `sector-areas-pairs.ts`; сессия областей —
 * в `sector-areas-editor-ui.ts` (через `getSession`/`applySession`), поэтому
 * история отмен и журнал у всех инструментов общие.
 *
 * Что сейчас редактируется (§7 ТЗ) — показано явно в строке состояния панели:
 * «контур области …» или «линия раздела пары …»; в нейтральном состоянии —
 * «ничего».
 *
 * Мышь (обе правки):
 *  - один клик — выбрать область (режим контура);
 *  - двойной клик по видимой линии — первый набор из шести якорей (§4.1) или
 *    уточнение сегмента 2+4 (§4.2); для линии пары — то же по открытой линии;
 *  - перетаскивание якоря — предпросмотр, отпускание — коммит (одна запись
 *    истории для контура; для линии пары — запись линии сочетания);
 *  - Esc или правая кнопка — завершить правку.
 *
 * Концы линии пары удерживаются в зоне взаимодействия: ограничитель — рамка
 * зоны пересечения колец (габариты зоны), попытка вывести конец за неё
 * стягивается к границе и помечается `limited` — интерфейс показывает
 * уведомление (§7 ТЗ). Правка линии пары не трогает контуры областей.
 */

import { escapeHtml } from './config.ts';
import type { AtlasKernel, MapPoint } from './config.ts';
import { levelForWidth } from './level-ladder.ts';
import { canContinueStroke, canStartStroke, isTextEntryTarget } from './pointer-rules.ts';
import {
  commitLineDrag,
  dragAnchor,
  projectOnCurve,
  reopenLineEdit,
  sampleRing,
  subdivideSegment,
} from './sector-areas-anchors.ts';
import type { ContourEditState } from './sector-areas-anchors.ts';
import {
  contourUnitsOf,
  pointHitsArea,
  primaryContourRing,
} from './sector-areas-geometry.ts';
import {
  computeAreaZoneGrid,
  pairLinesOf,
  zoneBoundaryPolygons,
} from './sector-areas-pairs.ts';
import {
  addAreaToGroupCmd,
  cancelContourDrag,
  closeContourEdit,
  commitContourDrag,
  createGroupCmd,
  createPairCmd,
  deleteGroupCmd,
  dragContourAnchor,
  markPairNeedsReviewCmd,
  openContourEdit,
  removeAreaFromGroupCmd,
  removePairCmd,
  renameGroupCmd,
  resetPairLineCmd,
  resolveVisibleContourClick,
  setPairForbidCrossingCmd,
  setPairLineCmd,
  setPairModeCmd,
  setPairOrderCmd,
  setPairTransitionCmd,
  subdivideContourSegment,
} from './sector-areas-hierarchy.ts';
import type { EditorSession } from './sector-areas-editor.ts';
import { redo, selectArea, undo } from './sector-areas-editor.ts';
import type { AreaPair, PairLine, Ring, SectorAreasDoc } from './sector-areas-contract.ts';

/* ------------------------------------------------------------------ типы */

export interface SectorAreasHierarchyUiOptions {
  readonly kernel: AtlasKernel;
  readonly panel: HTMLElement | null;
  readonly stage: HTMLElement | null;
  readonly canvas: HTMLCanvasElement | null;
  /** Доступ к общей сессии редактора областей (история и журнал общие). */
  readonly areas: {
    readonly getSession: () => EditorSession;
    readonly applySession: (session: EditorSession) => void;
  };
  /** Включение/выключение инструмента — для взаимного исключения инструментов. */
  readonly onActivate?: () => void;
  readonly onDeactivate?: () => void;
}

export interface SectorAreasHierarchyUiApi {
  setEnabled(on: boolean): void;
  enabled(): boolean;
  refresh(): void;
  /** Текущая правка контура: ID области или `null` (для тестов и статуса). */
  contourEditAreaId(): string | null;
  /** Правка линии пары: ID пары или `null` (для тестов и статуса). */
  pairLinePairId(): string | null;
  destroy(): void;
}

type EditMode = 'off' | 'contour' | 'pairline';

interface LineEditState {
  readonly pairId: string;
  readonly lineIndex: number;
  readonly sourceLine: PairLine;
  readonly state: ContourEditState;
  /** Индекс якоря под курсором во время тяги; `null` — тяги нет. */
  readonly dragging: number | null;
  readonly moved: boolean;
}

/* --------------------------------------------------------------- константы */

/** Класс overlay-канваса иерархии (правило — в admin-edit.css, закреплено тестом). */
export const HIERARCHY_OVERLAY_CLASS = 'admin-editor-hierarchy-preview';
const TOOL_CURSOR_CLASS = 'admin-tool-active';
const ANCHOR_HIT_PX = 14;
const DRAG_COMMIT_PX = 4;

const COLOR_ANCHOR = '#f5f7ff';
const COLOR_ANCHOR_ACTIVE = '#ff5a5a';
const COLOR_CONTOUR = '#f5f7ff';
const COLOR_PAIR_LINE = '#ffb454';
const COLOR_PREVIEW = '#ffd27a';

/* ---------------------------------------------------------------- модуль */

export function createSectorAreasHierarchyUi(options: SectorAreasHierarchyUiOptions): SectorAreasHierarchyUiApi {
  const { kernel, panel, stage, canvas } = options;

  /**
   * Допуски в мировых единицах считаются из экранных пикселей и масштаба кадра
   * (S2 ревью): на обзорном масштабе допуск клика не сжимается до пары
   * пикселей, на глубоком зуме минимальный зазор якорей не растёт в сотни px.
   */
  const CLICK_TOLERANCE_PX = 24;
  const MIN_GAP_PX = 6;
  const worldPerPx = (): number => {
    const view: { readonly scale?: number } | undefined = kernel.state.view;
    const scale = view === undefined ? undefined : view.scale;
    return scale !== undefined && Number.isFinite(scale) && scale > 0 ? 1 / scale : 1;
  };
  const currentLevel = (): number => {
    const vp = kernel.state.viewport as { readonly w?: number } | undefined;
    const w = vp?.w ?? 0;
    const perPx = worldPerPx();
    if (!Number.isFinite(w) || w <= 0) return 4;
    return levelForWidth(w * perPx);
  };
  const clickToleranceWorld = (): number => CLICK_TOLERANCE_PX * worldPerPx();
  const minGapWorld = (): number => Math.max(0.5, MIN_GAP_PX * worldPerPx());
  /** Отменяет отложенный выбор системы (карточка + автозум), если чтение доступно. */
  const cancelPendingTravelTap = (): void => {
    const coords = (kernel as { coords?: { cancelPendingTravelTap?: () => void } }).coords;
    if (coords !== undefined && typeof coords.cancelPendingTravelTap === 'function') {
      coords.cancelPendingTravelTap();
    }
  };

  let on = false;
  /** Что сейчас редактируется: контур области или линия сочетания пары (§7). */
  let mode: EditMode = 'off';
  /** Выбранная область в режиме контура. */
  let selectedAreaId: string | null = null;
  /** Индекс перетаскиваемого якоря контура; `null` — тяги нет. */
  let contourDragIndex: number | null = null;
  /** Правка линии пары: состояние и ID пары. */
  let lineEdit: LineEditState | null = null;
  let notice: string | null = null;
  let capturedId: number | null = null;
  let dragMoved = false;
  let dragStart: MapPoint | null = null;
  /** Выбор в общей сессии, который уже отражён в этом модуле (N1). */
  let lastSeenSelection: string | null | undefined = undefined;

  const listeners: Array<{ target: EventTarget | null; type: string; handler: (event: Event) => void; capture: boolean }> = [];
  let preview: HTMLCanvasElement | null = null;
  let overlayFrame = 0;
  let lastViewKey = '';

  function session(): EditorSession {
    return options.areas.getSession();
  }

  function apply(next: EditorSession): void {
    options.areas.applySession(next);
  }

  function setNotice(message: string | null): void {
    notice = message;
    refresh();
  }

  function doc(): SectorAreasDoc {
    return session().doc;
  }

  function areaById(areaId: string | null) {
    if (areaId === null) return null;
    return doc().areas.find((area) => area.id === areaId) ?? null;
  }

  function pairById(pairId: string | null): AreaPair | null {
    if (pairId === null) return null;
    return (doc().pairs ?? []).find((pair) => pair.id === pairId) ?? null;
  }

  /* --------------------------------------------------------- overlay-канвас */

  function previewCanvas(): CanvasRenderingContext2D | null {
    if (stage === null || typeof document === 'undefined') return null;
    if (preview === null) {
      const node = document.createElement('canvas');
      node.classList.add(HIERARCHY_OVERLAY_CLASS);
      node.setAttribute('aria-hidden', 'true');
      stage.appendChild(node);
      preview = node;
    }
    const ctx = preview.getContext('2d');
    const w = Math.max(1, Math.round(stage.clientWidth));
    const h = Math.max(1, Math.round(stage.clientHeight));
    const dpr = Math.min(typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1), 2);
    if (preview.width !== w * dpr || preview.height !== h * dpr) {
      preview.width = w * dpr;
      preview.height = h * dpr;
    }
    preview.style.width = w + 'px';
    preview.style.height = h + 'px';
    if (ctx !== null) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
    }
    return ctx;
  }

  function screenOf(world: readonly [number, number]): MapPoint | null {
    return kernel.renderer.toScreen(world[0], world[1]);
  }

  function worldAt(event: { clientX: number; clientY: number }): MapPoint | null {
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return kernel.renderer.toWorld(event.clientX - rect.left, event.clientY - rect.top);
  }

  function pointAt(event: { clientX: number; clientY: number }): MapPoint | null {
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function tracePolyline(ctx: CanvasRenderingContext2D, points: readonly { x: number; y: number }[]): boolean {
    if (points.length < 2) return false;
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, points[0]!.y);
    for (let index = 1; index < points.length; index += 1) ctx.lineTo(points[index]!.x, points[index]!.y);
    return true;
  }

  function drawAnchor(ctx: CanvasRenderingContext2D, screen: MapPoint, active: boolean, big: boolean): void {
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, big ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = active ? COLOR_ANCHOR_ACTIVE : 'rgba(6, 10, 18, .55)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = active ? '#ffffff' : COLOR_ANCHOR;
    ctx.stroke();
  }

  /** Полигоны всей зоны взаимодействия пары — ограничитель концов линии (§7). */
  function pairClampRegion(pair: AreaPair): readonly Ring[] | undefined {
    const areaA = areaById(pair.areaA);
    const areaB = areaById(pair.areaB);
    if (areaA === null || areaB === null) return undefined;
    const grid = computeAreaZoneGrid(areaA, areaB);
    if (grid === null) return undefined;
    const polygons = zoneBoundaryPolygons(grid);
    return polygons.length > 0 ? polygons : undefined;
  }

  function paintOverlay(): void {
    const ctx = previewCanvas();
    if (ctx === null) return;
    if (mode === 'contour') {
      const area = areaById(selectedAreaId);
      if (area === null) return;
      const ref = session().contourEdit ?? null;
      const unitRing = ref !== null && ref.areaId === area.id
        ? (contourUnitsOf(area)[ref.ringIndex]?.ring ?? primaryContourRing(area))
        : primaryContourRing(area);
      if (unitRing === null || unitRing.length < 3) return;
      const curve = sampleRing(unitRing);
      if (curve === null) return;
      const ringScreen = curve.points
        .map((point) => screenOf(point))
        .filter((point): point is MapPoint => point !== null);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = COLOR_CONTOUR;
      if (tracePolyline(ctx, ringScreen)) ctx.stroke();
      if (ref !== null && ref.areaId === area.id) {
        const state = ref.state;
        if (state.preview !== null) {
          const previewScreen = state.preview
            .map((point) => screenOf(point))
            .filter((point): point is MapPoint => point !== null);
          ctx.lineWidth = 2;
          ctx.strokeStyle = COLOR_PREVIEW;
          if (tracePolyline(ctx, previewScreen)) ctx.stroke();
        }
        state.anchors.forEach((anchor, index) => {
          const screen = screenOf(anchor.point);
          if (screen !== null) drawAnchor(ctx, screen, index === contourDragIndex, false);
        });
      }
      return;
    }
    if (mode === 'pairline' && lineEdit !== null) {
      const linePoints = lineEdit.state.preview ?? lineEdit.state.ring;
      const screen = linePoints
        .map((point) => screenOf(point))
        .filter((point): point is MapPoint => point !== null);
      ctx.lineWidth = 3;
      ctx.strokeStyle = COLOR_PAIR_LINE;
      if (tracePolyline(ctx, screen)) ctx.stroke();
      const anchors = lineEdit.state.anchors;
      const anchorCount = anchors.length;
      const draggingIndex = lineEdit.dragging;
      anchors.forEach((anchor, index) => {
        const point = screenOf(anchor.point);
        if (point === null) return;
        const isEnd = index === 0 || index === anchorCount - 1;
        drawAnchor(ctx, point, index === draggingIndex, isEnd);
        if (isEnd && index !== draggingIndex) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = COLOR_PAIR_LINE;
          ctx.fill();
        }
      });
    }
  }

  function clearPreview(): void {
    if (preview === null) return;
    const ctx = preview.getContext('2d');
    if (ctx === null) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.restore();
  }

  function overlayStep(): void {
    overlayFrame = 0;
    if (!on) return;
    const key = viewKey();
    if (key !== lastViewKey) {
      lastViewKey = key;
      paintOverlay();
    }
    if (typeof window !== 'undefined') overlayFrame = window.requestAnimationFrame(overlayStep);
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

  function viewKey(): string {
    const view: { scale?: number; tx?: number; ty?: number } | undefined = kernel.state.view;
    const scale = view === undefined ? 1 : view.scale;
    const tx = view === undefined ? 0 : view.tx;
    const ty = view === undefined ? 0 : view.ty;
    const width = stage === null ? 0 : stage.clientWidth;
    const height = stage === null ? 0 : stage.clientHeight;
    return `${scale}|${tx}|${ty}|${width}x${height}`;
  }

  /* ---------------------------------------------------------------- панель */

  function editTargetText(): string {
    if (mode === 'contour') {
      const area = areaById(selectedAreaId);
      return area === null ? 'контур области не выбран' : `контур области «${area.name}» (${area.id})`;
    }
    if (mode === 'pairline' && lineEdit !== null) {
      const pair = pairById(lineEdit.pairId);
      return pair === null ? 'линия раздела пары' : `линия раздела пары ${pairLabel(pair)}`;
    }
    return 'ничего';
  }

  function pairLabel(pair: AreaPair): string {
    const a = areaById(pair.areaA);
    const b = areaById(pair.areaB);
    return `${a?.name ?? pair.areaA} + ${b?.name ?? pair.areaB}`;
  }

  function groupRowHtml(group: { id: string; name: string; areaIds: readonly string[] }): string {
    const members = group.areaIds
      .map((areaId) => areaById(areaId))
      .filter((area): area is NonNullable<typeof area> => area !== null)
      .map((area) => `<span class="admin-chip">${escapeHtml(area.name)}`
        + `<button type="button" class="admin-chip-remove" data-group-remove="${escapeHtml(group.id)}"`
        + ` data-area="${escapeHtml(area.id)}" title="Убрать «${escapeHtml(area.name)}» из группы (область сохраняется)"`
        + ` aria-label="Убрать область «${escapeHtml(area.name)}» из группы «${escapeHtml(group.name)}»">×</button></span>`)
      .join(' ');
    const candidates = doc().areas
      .filter((area) => !group.areaIds.includes(area.id))
      .map((area) => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`)
      .join('');
    return [
      `<div class="admin-row" data-group="${escapeHtml(group.id)}">`,
      `<div class="admin-row-head"><strong>${escapeHtml(group.name)}</strong>`,
      `<span class="admin-meta-id">${escapeHtml(group.id)}</span></div>`,
      members.length > 0 ? `<div class="admin-chips">${members}</div>` : '<p class="admin-editor-meta">Пока без областей.</p>',
      '<div class="admin-editor-grid">',
      candidates.length > 0
        ? `<select data-group-add="${escapeHtml(group.id)}" aria-label="Добавить область в группу «${escapeHtml(group.name)}»"><option value="">Добавить область…</option>${candidates}</select>`
        : '',
      `<button type="button" class="admin-editor-tool" data-group-rename="${escapeHtml(group.id)}" title="Переименовать группу по полю ниже; ID сохранится">Переименовать</button>`,
      `<button type="button" class="admin-editor-tool" data-group-delete="${escapeHtml(group.id)}" title="Удалить группу; области и сочетания сохранятся">Удалить группу</button>`,
      `<input type="text" data-group-rename-input="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" aria-label="Новое имя группы «${escapeHtml(group.name)}»" />`,
      '</div>',
      '</div>',
    ].join('');
  }

  function pairRowHtml(pair: AreaPair): string {
    const review = pair.needsReview
      ? '<span class="admin-badge admin-badge-warn">требует пересмотра</span>'
      : '';
    const lineState = pair.line === null
      ? 'автолинии нет (области не пересекаются)'
      : pair.line.manual ? 'линия отредактирована вручную' : 'автолиния';
    const allLines = pairLinesOf(pair);
    const editButtons = allLines.length <= 1
      ? `<button type="button" class="admin-editor-tool" data-pair-edit="${escapeHtml(pair.id)}" data-line-index="0" title="Редактировать линию раздела якорями; контуры областей не меняются">Править линию</button>`
      : allLines.map((_, lineIdx) => (
        `<button type="button" class="admin-editor-tool" data-pair-edit="${escapeHtml(pair.id)}" data-line-index="${lineIdx}"`
        + ` title="Редактировать линию части ${lineIdx + 1} зоны взаимодействия">Править ч. ${lineIdx + 1}</button>`
      )).join('');
    return [
      `<div class="admin-row" data-pair="${escapeHtml(pair.id)}">`,
      `<div class="admin-row-head"><strong>${escapeHtml(pairLabel(pair))}</strong>`,
      `<span class="admin-meta-id">${escapeHtml(pair.id)}</span>${review}</div>`,
      `<p class="admin-editor-meta">${escapeHtml(lineState)}${pair.note !== null ? ` · ${escapeHtml(pair.note)}` : ''}</p>`,
      '<div class="admin-editor-grid">',
      `<label class="admin-editor-field">Режим<select data-pair-mode="${escapeHtml(pair.id)}" aria-label="Режим сочетания ${escapeHtml(pair.id)}">`
      + `<option value="split"${pair.mode === 'split' ? ' selected' : ''}>Разделение цветов</option>`
      + `<option value="overlay"${pair.mode === 'overlay' ? ' selected' : ''}>Наложение</option></select></label>`,
      `<label class="admin-editor-field">Поверх<select data-pair-order="${escapeHtml(pair.id)}" aria-label="Порядок наложения ${escapeHtml(pair.id)}">`
      + `<option value="a-over-b"${pair.order === 'a-over-b' ? ' selected' : ''}>Первая область</option>`
      + `<option value="b-over-a"${pair.order === 'b-over-a' ? ' selected' : ''}>Вторая область</option></select></label>`,
      `<label class="admin-editor-field">Переход (0 — резкий)<input type="number" min="0" step="20" value="${pair.transitionWidth === null ? 0 : Math.round(pair.transitionWidth)}" data-pair-transition="${escapeHtml(pair.id)}" aria-label="Ширина перехода ${escapeHtml(pair.id)}" /></label>`,
      '</div>',
      '<div class="admin-editor-field-inline">',
      `<input type="checkbox" data-pair-forbid="${escapeHtml(pair.id)}" id="forbid-${escapeHtml(pair.id)}"${pair.forbidCrossing ? ' checked' : ''} />`,
      `<label for="forbid-${escapeHtml(pair.id)}">Пересечение запрещено</label>`,
      '</div>',
      '<div class="admin-editor-grid">',
      editButtons,
      `<button type="button" class="admin-editor-tool" data-pair-review="${escapeHtml(pair.id)}" title="${pair.needsReview ? 'Снять пометку «требует пересмотра»' : 'Пометить «требует пересмотра» вручную'}">${pair.needsReview ? 'Снять пересмотр' : 'Пометить пересмотр'}</button>`,
      `<button type="button" class="admin-editor-tool" data-pair-reset="${escapeHtml(pair.id)}" title="Пересчитать линию автоматически; ручная правка будет заменена">Сбросить на авто</button>`,
      `<button type="button" class="admin-editor-tool" data-pair-delete="${escapeHtml(pair.id)}" title="Удалить сочетание; области и контуры сохранятся">Удалить</button>`,
      '</div>',
      '</div>',
    ].join('');
  }

  function blockHtml(): string {
    const groups = doc().groups ?? [];
    const pairs = doc().pairs ?? [];
    const areas = doc().areas;
    const pairOptions = (selected: string): string => areas
      .map((area) => `<option value="${escapeHtml(area.id)}"${area.id === selected ? ' selected' : ''}>${escapeHtml(area.name)}</option>`)
      .join('');
    const undoDisabled = session().past.length === 0 ? ' disabled' : '';
    const redoDisabled = session().future.length === 0 ? ' disabled' : '';
    const contourActive = mode === 'contour' && (session().contourEdit ?? null) !== null;
    return [
      '<p class="admin-editor-meta"><strong>Иерархия</strong> · якоря контуров, группы и сочетания пар</p>',
      '<div class="admin-editor-tools" role="group" aria-label="Инструмент иерархии областей">',
      '  <button type="button" class="admin-editor-tool' + (on ? ' is-current' : '') + '"'
        + ' data-action="hierarchy-tool" aria-pressed="' + (on ? 'true' : 'false') + '"'
        + ' title="Правка якорями, группы и сочетания: включить или выключить">Правка якорями</button>',
      '  <button type="button" class="admin-editor-tool" data-action="hierarchy-undo"' + undoDisabled + ' title="Отменить (Ctrl+Z)">Отменить</button>',
      '  <button type="button" class="admin-editor-tool" data-action="hierarchy-redo"' + redoDisabled + ' title="Повторить (Ctrl+Shift+Z)">Повторить</button>',
      '</div>',
      `<p class="admin-editor-status-text" role="status" aria-live="polite">Редактируется: ${escapeHtml(editTargetText())}</p>`,
      mode === 'contour'
        ? [
          '<p class="admin-editor-hint">Клик — выбрать область. Двойной клик по линии — 6 якорей; повторный по сегменту — уточнение 2+4.'
            + ' Тяните якорь; отпускание применяет. <kbd>Esc</kbd> — завершить.</p>',
          contourActive ? '<button type="button" class="admin-editor-tool" data-action="hierarchy-close-contour">Завершить правку контура</button>' : '',
        ].join('')
        : '',
      mode === 'pairline' && lineEdit !== null
        ? '<p class="admin-editor-hint">Двойной клик по линии — 6 якорей (концы удерживаются в зоне взаимодействия), повторный по сегменту — уточнение.'
          + ' Тяните якорь; отпускание применяет к линии раздела, контуры областей не меняются. <kbd>Esc</kbd> — завершить.</p>'
        : '',
      '<details open><summary>Группы (' + groups.length + ')</summary>',
      '<div class="admin-editor-field-inline">',
      '  <input type="text" data-hierarchy-group-name placeholder="Имя группы" aria-label="Имя новой группы" />',
      '  <button type="button" class="admin-editor-tool" data-action="hierarchy-group-create">Создать группу</button>',
      '</div>',
      groups.length > 0 ? groups.map(groupRowHtml).join('') : '<p class="admin-editor-meta">Групп пока нет.</p>',
      '</details>',
      '<details open><summary>Сочетания пар (' + pairs.length + ')</summary>',
      '<div class="admin-editor-grid">',
      `  <select data-hierarchy-pair-a aria-label="Первая область сочетания"><option value="">Область А…</option>${pairOptions('')}</select>`,
      `  <select data-hierarchy-pair-b aria-label="Вторая область сочетания"><option value="">Область Б…</option>${pairOptions('')}</select>`,
      '</div>',
      '<div class="admin-editor-field-inline">',
      '  <input type="checkbox" data-hierarchy-pair-forbid id="hierarchyPairForbid" />',
      '  <label for="hierarchyPairForbid">Сразу запретить пересечение</label>',
      '  <button type="button" class="admin-editor-tool" data-action="hierarchy-pair-create">Создать сочетание</button>',
      '</div>',
      pairs.length > 0 ? pairs.map(pairRowHtml).join('') : '<p class="admin-editor-meta">Сочетаний пока нет.</p>',
      '</details>',
      notice !== null ? `<p class="admin-editor-notice">${escapeHtml(notice)}</p>` : '',
    ].join('');
  }

  function lineOfPair(pair: AreaPair, lineIndex: number): PairLine | null {
    return lineIndex <= 0 ? pair.line : (pair.extraLines?.[lineIndex - 1] ?? null);
  }

  function refresh(): void {
    // Синхронизируем с общей сессией: очищаем устаревшие ссылки после импорта,
    // загрузки черновика, undo/redo или удаления области/пары.
    if (selectedAreaId !== null && areaById(selectedAreaId) === null) {
      selectedAreaId = null;
      contourDragIndex = null;
    }
    if (lineEdit !== null) {
      const pair = pairById(lineEdit.pairId);
      const targetLine = pair === null ? null : lineOfPair(pair, lineEdit.lineIndex);
      if (pair === null || pair.mode !== 'split' || targetLine === null || targetLine.points.length < 2) {
        lineEdit = null;
        if (mode === 'pairline') mode = on ? 'contour' : 'off';
      } else if (lineEdit.dragging === null && targetLine !== lineEdit.sourceLine) {
        const reopened = reopenLineEdit(targetLine.points, targetLine.anchors);
        if (reopened.ok) {
          lineEdit = {
            pairId: lineEdit.pairId,
            lineIndex: lineEdit.lineIndex,
            sourceLine: targetLine,
            state: reopened.state,
            dragging: null,
            moved: false,
          };
        } else {
          lineEdit = null;
          if (mode === 'pairline') mode = on ? 'contour' : 'off';
        }
      }
    }
    const selection = session().selection;
    if (selection !== lastSeenSelection) {
      lastSeenSelection = selection;
      if (mode === 'contour') selectedAreaId = selection;
    }
    if (panel !== null) {
      const block = panel.querySelector('[data-editor-block="hierarchy"]');
      if (block !== null) block.innerHTML = blockHtml();
    }
    if (on) paintOverlay();
  }

  /* ------------------------------------------------------------- действия */

  function setEnabled(value: boolean): void {
    if (value === on) {
      refresh();
      return;
    }
    on = value;
    if (!on) {
      stopOverlayLoop();
      endContour(false);
      lineEdit = null;
      mode = 'off';
      if (canvas !== null) canvas.classList.remove(TOOL_CURSOR_CLASS);
      options.onDeactivate?.();
      notice = 'Инструмент иерархии выключен.';
    } else {
      mode = 'contour';
      if (canvas !== null) canvas.classList.add(TOOL_CURSOR_CLASS);
      options.onActivate?.();
      notice = 'Правка якорями включена: клик по карте выбирает область.';
      lastViewKey = '';
      startOverlayLoop();
    }
    refresh();
  }

  function endContour(clearSelection: boolean): void {
    const current = session();
    if (current.contourEdit !== null && current.contourEdit !== undefined) {
      apply(closeContourEdit(current));
    }
    contourDragIndex = null;
    if (clearSelection) selectedAreaId = null;
  }

  function onGroupCreate(): void {
    if (panel === null) return;
    const input = panel.querySelector('[data-hierarchy-group-name]');
    const name = stringValue(input).trim();
    if (name.length === 0) {
      setNotice('Введите имя группы.');
      return;
    }
    try {
      const result = createGroupCmd(session(), name);
      if (input !== null) (input as unknown as { value: string }).value = '';
      apply(result.session);
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof RangeError ? error.message : 'Группу создать не удалось.');
    }
  }

  function onPairCreate(): void {
    if (panel === null) return;
    const selectA = panel.querySelector('[data-hierarchy-pair-a]');
    const selectB = panel.querySelector('[data-hierarchy-pair-b]');
    const forbid = panel.querySelector('[data-hierarchy-pair-forbid]');
    const areaA = stringValue(selectA);
    const areaB = stringValue(selectB);
    if (areaA.length === 0 || areaB.length === 0) {
      setNotice('Выберите две области для сочетания.');
      return;
    }
    try {
      const result = createPairCmd(session(), areaA, areaB, {
        forbidCrossing: forbid !== null && (forbid as { checked?: unknown }).checked === true,
      });
      apply(result.session);
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof RangeError ? error.message : 'Сочетание создать не удалось.');
    }
  }

  function onPanelClick(event: Event): void {
    // Панельные операции (группы, сочетания, история) доступны и при выключенном
    // инструменте: они не трогают ввод на карте.
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest('[data-action],[data-group-delete],[data-group-remove],[data-group-rename],[data-pair-delete],[data-pair-edit],[data-pair-reset],[data-pair-review]');
    if (control === null) return;
    const action = control.getAttribute('data-action');
    if (action === 'hierarchy-tool') {
      setEnabled(!on);
      return;
    }
    if (action === 'hierarchy-undo') {
      apply(undo(session()));
      setNotice('Отменено.');
      return;
    }
    if (action === 'hierarchy-redo') {
      apply(redo(session()));
      setNotice('Повторено.');
      return;
    }
    if (action === 'hierarchy-close-contour') {
      endContour(false);
      setNotice('Правка контура завершена.');
      return;
    }
    if (action === 'hierarchy-group-create') {
      onGroupCreate();
      return;
    }
    if (action === 'hierarchy-pair-create') {
      onPairCreate();
      return;
    }
    const removeGroup = control.getAttribute('data-group-remove');
    const removeAreaId = control.getAttribute('data-area');
    if (removeGroup !== null && removeAreaId !== null) {
      try {
        const result = removeAreaFromGroupCmd(session(), removeGroup, removeAreaId);
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Убрать из группы не удалось.');
      }
      return;
    }
    const reviewPairId = control.getAttribute('data-pair-review');
    if (reviewPairId !== null) {
      const pair = pairById(reviewPairId);
      if (pair === null) {
        setNotice('Сочетание не найдено.');
        return;
      }
      try {
        const result = markPairNeedsReviewCmd(session(), reviewPairId, !pair.needsReview);
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Пометку сохранить не удалось.');
      }
      return;
    }
    const groupId = control.getAttribute('data-group-delete');
    if (groupId !== null) {
      try {
        const result = deleteGroupCmd(session(), groupId);
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Группу удалить не удалось.');
      }
      return;
    }
    const renameId = control.getAttribute('data-group-rename');
    if (renameId !== null) {
      const row = control.closest('[data-group]');
      const input = row instanceof Element ? row.querySelector(`[data-group-rename-input="${cssEscape(renameId)}"]`) : null;
      const name = stringValue(input).trim();
      try {
        const result = renameGroupCmd(session(), renameId, name);
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Переименовать не удалось.');
      }
      return;
    }
    const pairId = control.getAttribute('data-pair-delete');
    if (pairId !== null) {
      try {
        const result = removePairCmd(session(), pairId);
        if (lineEdit?.pairId === pairId) lineEdit = null;
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Сочетание удалить не удалось.');
      }
      return;
    }
    const editPairId = control.getAttribute('data-pair-edit');
    if (editPairId !== null) {
      const lineIdxRaw = Number(control.getAttribute('data-line-index') ?? '0');
      const lineIdx = Number.isFinite(lineIdxRaw) && lineIdxRaw >= 0 ? Math.floor(lineIdxRaw) : 0;
      beginPairLineEditing(editPairId, lineIdx);
      return;
    }
    const resetPairId = control.getAttribute('data-pair-reset');
    if (resetPairId !== null) {
      try {
        const result = resetPairLineCmd(session(), resetPairId);
        if (lineEdit?.pairId === resetPairId) lineEdit = null;
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Сбросить линию не удалось.');
      }
    }
  }

  function cssEscape(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/["\\]/g, '\\$&');
  }

  /** Открывает правку линии пары по сохранённым якорям (число якорей цело). */
  function beginPairLineEditing(pairId: string, lineIndex = 0): void {
    // Правка линии доступна и при выключенном инструменте: кнопка панели сама
    // включает «Правку якорями» (иначе линия рисуется, но ввод мёртв — B5.2).
    if (!on) setEnabled(true);
    const pair = pairById(pairId);
    if (pair === null) {
      setNotice('Сочетание не найдено.');
      return;
    }
    const targetLine = lineOfPair(pair, lineIndex);
    if (targetLine === null || targetLine.points.length < 2) {
      setNotice('Автолинии нет: области не пересекаются, править нечего.');
      return;
    }
    const reopened = reopenLineEdit(targetLine.points, targetLine.anchors);
    if (!reopened.ok) {
      setNotice(reopened.reason);
      return;
    }
    mode = 'pairline';
    lineEdit = {
      pairId,
      lineIndex,
      sourceLine: targetLine,
      state: reopened.state,
      dragging: null,
      moved: false,
    };
    const partNote = pairLinesOf(pair).length > 1 ? ` (часть ${lineIndex + 1})` : '';
    setNotice(`Правка линии раздела пары ${pairLabel(pair)}${partNote}: двойной клик по сегменту уточняет его, тяните якоря.`);
    lastViewKey = '';
    refresh();
    paintOverlay();
  }

  function stringValue(target: unknown): string {
    if (target === null || typeof target !== 'object') return '';
    const value = (target as { value?: unknown }).value;
    return typeof value === 'string' ? value : '';
  }

  function onPanelChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const groupAdd = target.getAttribute('data-group-add');
    if (groupAdd !== null && stringValue(target).length > 0) {
      try {
        const result = addAreaToGroupCmd(session(), groupAdd, stringValue(target));
        apply(result.session);
        setNotice(result.message);
      } catch (error) {
        setNotice(error instanceof RangeError ? error.message : 'Добавить в группу не удалось.');
      }
      return;
    }
    const pairMode = target.getAttribute('data-pair-mode');
    if (pairMode !== null) {
      const result = setPairModeCmd(session(), pairMode, stringValue(target) === 'overlay' ? 'overlay' : 'split');
      // Режим «наложение» прячет линию раздела — открытая правка этой линии
      // закрывается, чтобы янтарный оверлей не висел поверх карты (N1 ревью).
      if (stringValue(target) === 'overlay' && lineEdit !== null && lineEdit.pairId === pairMode) {
        lineEdit = null;
        mode = 'contour';
      }
      apply(result.session);
      setNotice(result.message);
      return;
    }
    const pairOrder = target.getAttribute('data-pair-order');
    if (pairOrder !== null) {
      const result = setPairOrderCmd(session(), pairOrder, stringValue(target) === 'b-over-a' ? 'b-over-a' : 'a-over-b');
      apply(result.session);
      setNotice(result.message);
      return;
    }
    const pairForbid = target.getAttribute('data-pair-forbid');
    if (pairForbid !== null) {
      const checked = (target as { checked?: unknown }).checked === true;
      const result = setPairForbidCrossingCmd(session(), pairForbid, checked);
      apply(result.session);
      setNotice(result.message);
      return;
    }
    if (target.getAttribute('data-pair-transition') !== null) {
      onTransitionChange(target);
    }
  }

  /**
   * Ширина перехода применяется на `change` (уход из поля/Enter), а не на
   * каждый символ: посимвольная перерисовка панели уничтожала поле ввода
   * и сбрасывала фокус на BODY (дефект B5.4 ревью).
   */
  function onTransitionChange(target: Element): void {
    const transition = target.getAttribute('data-pair-transition');
    if (transition === null) return;
    const raw = stringValue(target).trim();
    if (raw.length === 0) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const width = value > 0 ? value : null;
    try {
      const result = setPairTransitionCmd(session(), transition, width);
      apply(result.session);
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof RangeError ? error.message : 'Ширину перехода сохранить не удалось.');
    }
  }

  /* ---------------------------------------------------------------- ввод */

  function nearestAnchorScreen(state: ContourEditState, point: MapPoint): { index: number; distance: number } | null {
    let best: { index: number; distance: number } | null = null;
    state.anchors.forEach((anchor, index) => {
      const screen = screenOf(anchor.point);
      if (screen === null) return;
      const distance = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (distance <= ANCHOR_HIT_PX && (best === null || distance < best.distance)) {
        best = { index, distance };
      }
    });
    return best;
  }

  function capturePointer(event: PointerEvent): void {
    if (stage !== null) {
      try {
        stage.setPointerCapture(event.pointerId);
        capturedId = event.pointerId;
      } catch {
        capturedId = null;
      }
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!on) return;
    if (!canStartStroke(event, canvas)) return;
    const point = pointAt(event);
    if (point === null) return;
    const world = worldAt(event);
    if (world === null) return;

    // Тяга якоря линии пары: состояние линии локально, запись — на отпускании.
    if (mode === 'pairline' && lineEdit !== null) {
      const hit = nearestAnchorScreen(lineEdit.state, point);
      if (hit !== null) {
        event.stopPropagation();
        event.preventDefault();
        // Отложенный выбор системы (карточка + автозум) под кликом отменяется:
        // тянем якорь, а не открываем систему (B5.3).
        cancelPendingTravelTap();
        lineEdit = { ...lineEdit, dragging: hit.index, moved: false };
        dragStart = point;
        dragMoved = false;
        capturePointer(event);
        paintOverlay();
      }
      return;
    }

    if (mode === 'contour') {
      cancelPendingTravelTap();
      const ref = session().contourEdit ?? null;
      if (ref !== null) {
        const hit = nearestAnchorScreen(ref.state, point);
        if (hit !== null) {
          event.stopPropagation();
          event.preventDefault();
          contourDragIndex = hit.index;
          dragStart = point;
          dragMoved = false;
          capturePointer(event);
          return;
        }
      }
      // Выбор области одним кликом (правая кнопка и текстовые поля отсечены).
      const hitArea = doc().areas.find((area) => pointHitsArea(area, world.x, world.y, clickToleranceWorld())) ?? null;
      selectedAreaId = hitArea === null ? null : hitArea.id;
      lastSeenSelection = hitArea?.id ?? null;
      // Выбор виден и в списке «Свойства»: сессия — общий источник истины.
      apply(selectArea(session(), selectedAreaId));
      notice = hitArea === null
        ? 'Клик мимо областей: контур не выбран.'
        : `Выбран контур области «${hitArea.name}»: двойной клик по линии ставит якоря.`;
      refresh();
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!on || !canContinueStroke(event)) return;
    if (capturedId === null && contourDragIndex === null
      && (mode !== 'pairline' || lineEdit === null || lineEdit.dragging === null)) return;
    const point = pointAt(event);
    if (point === null) return;
    if (dragStart !== null && Math.hypot(point.x - dragStart.x, point.y - dragStart.y) >= DRAG_COMMIT_PX) {
      dragMoved = true;
    }
    const world = worldAt(event);
    if (world === null) return;
    event.stopPropagation();

    if (mode === 'pairline' && lineEdit !== null && lineEdit.dragging !== null) {
      const pair = pairById(lineEdit.pairId);
      const clampRegion = pair === null ? undefined : pairClampRegion(pair);
      const dragged = dragAnchor(lineEdit.state, lineEdit.dragging, [world.x, world.y], clampRegion, {
        minGap: minGapWorld(),
      });
      if (!dragged.ok) {
        setNotice(dragged.reason);
        return;
      }
      lineEdit = { ...lineEdit, state: dragged.state, moved: true };
      if (dragged.limited) {
        if (notice !== 'Конец линии удержан в зоне взаимодействия.') {
          setNotice('Конец линии удержан в зоне взаимодействия.');
          return;
        }
      }
      paintOverlay();
      return;
    }

    if (mode === 'contour' && contourDragIndex !== null) {
      const result = dragContourAnchor(session(), contourDragIndex, [world.x, world.y], undefined, {
        minGap: minGapWorld(),
      });
      apply(result.session);
      if (result.message !== null && result.message !== notice) {
        notice = result.message;
        refresh();
        return;
      }
      paintOverlay();
    }
  }

  function releasePointer(): void {
    if (capturedId !== null && capturedId >= 0 && stage !== null) {
      try { stage.releasePointerCapture(capturedId); } catch { /* уже отпущено */ }
    }
    capturedId = null;
    dragStart = null;
  }

  function onPointerUp(event: PointerEvent): void {
    if (!on) return;
    if (event.button !== 0) return;
    const pairDragging = mode === 'pairline' && lineEdit !== null && lineEdit.dragging !== null;
    if (!pairDragging && capturedId === null && contourDragIndex === null) return;
    if (pairDragging || capturedId !== null) releasePointer();

    if (pairDragging && lineEdit !== null) {
      const moved = lineEdit.moved;
      lineEdit = { ...lineEdit, dragging: null };
      if (!moved) {
        paintOverlay();
        return;
      }
      const baked = commitLineDrag(lineEdit.state);
      const nextLine: PairLine = {
        manual: true,
        points: baked.points,
        anchors: baked.anchors,
      };
      const result = setPairLineCmd(session(), lineEdit.pairId, nextLine, lineEdit.lineIndex);
      apply(result.session);
      const pair = pairById(lineEdit.pairId);
      const savedLine = pair === null ? null : lineOfPair(pair, lineEdit.lineIndex);
      if (savedLine !== null) {
        const reopened = reopenLineEdit(savedLine.points, savedLine.anchors);
        if (reopened.ok) lineEdit = { ...lineEdit, sourceLine: savedLine, state: reopened.state };
      }
      setNotice(result.message);
      paintOverlay();
      return;
    }

    if (mode === 'contour' && contourDragIndex !== null) {
      contourDragIndex = null;
      if (!dragMoved) {
        apply(cancelContourDrag(session()));
        paintOverlay();
        return;
      }
      const result = commitContourDrag(session());
      apply(result.session);
      setNotice(result.message ?? 'Форма применена.');
      paintOverlay();
    }
  }

  function onPointerCancel(_event: PointerEvent): void {
    if (!on) return;
    if (lineEdit !== null && lineEdit.dragging !== null) {
      // Тяга отменяется: состояние линии восстанавливается из записанной линии.
      const pair = pairById(lineEdit.pairId);
      const targetLine = pair === null ? null : lineOfPair(pair, lineEdit.lineIndex);
      if (targetLine !== null) {
        const recorded = reopenLineEdit(targetLine.points, targetLine.anchors);
        lineEdit = {
          pairId: lineEdit.pairId,
          lineIndex: lineEdit.lineIndex,
          sourceLine: targetLine,
          state: recorded.ok ? recorded.state : lineEdit.state,
          dragging: null,
          moved: false,
        };
      } else {
        lineEdit = { ...lineEdit, dragging: null, moved: false };
      }
      paintOverlay();
    }
    if (contourDragIndex !== null) {
      // Откат предпросмотра контура: коммита не было, документ не менялся.
      contourDragIndex = null;
      apply(cancelContourDrag(session()));
    }
    releasePointer();
    paintOverlay();
  }

  function onDoubleClick(event: Event): void {
    if (!on) return;
    if (!(event instanceof MouseEvent)) return;
    if (event.button !== 0) return;
    if (!canContinueStroke(event)) return;
    const point = pointAt(event);
    const world = worldAt(event);
    if (point === null || world === null) return;

    // Событие гасится только когда двойной клик действительно открывает правку
    // или уточняет сегмент: иначе dblclick доходит до карты (в том числе
    // отменяет отложенный выбор системы) — «мимо» не должно ломать карту,
    // а действие рядом со звездой обязано отменить карточку и автозум (B5.3).
    const swallow = (): void => {
      event.preventDefault();
      event.stopPropagation();
      cancelPendingTravelTap();
    };

    if (mode === 'contour') {
      const tol = clickToleranceWorld();
      const level = currentLevel();
      const ref = session().contourEdit ?? null;

      // 1. Сначала проверяем активную единицу: уточнение существующей правки.
      if (ref !== null) {
        const refArea = areaById(ref.areaId);
        const refUnit = refArea === null ? undefined : contourUnitsOf(refArea)[ref.ringIndex];
        const nearRaw = projectOnCurve(ref.state.activeCurve, [world.x, world.y], ref.state.closed);
        const nearVisible = refArea !== null && refUnit !== undefined
          ? resolveVisibleContourClick(refArea, refUnit.ring, [world.x, world.y], tol, level)
          : null;
        if (nearRaw.distance <= tol || nearVisible !== null) {
          swallow();
          lastSeenSelection = ref.areaId;
          selectedAreaId = ref.areaId;
          const result = subdivideContourSegment(
            session(),
            [world.x, world.y],
            tol,
            { minGap: minGapWorld() },
            level,
          );
          if (result.session !== session()) apply(result.session);
          setNotice(result.message);
          paintOverlay();
          return;
        }
      }

      // 2. Поиск подходящего замкнутого контура (учитывает сглаживание и штрихи-острова).
      let hitTarget: { area: NonNullable<ReturnType<typeof areaById>>; ringIndex: number; click: readonly [number, number] } | null = null;
      for (const candidate of doc().areas) {
        const units = contourUnitsOf(candidate);
        for (const unit of units) {
          const mapped = resolveVisibleContourClick(candidate, unit.ring, [world.x, world.y], tol, level);
          if (mapped !== null) {
            hitTarget = { area: candidate, ringIndex: unit.ringIndex, click: mapped };
            break;
          }
        }
        if (hitTarget !== null) break;
      }
      if (hitTarget === null) {
        const fallbackArea = doc().areas.find((area) => pointHitsArea(area, world.x, world.y, tol))
          ?? (selectedAreaId !== null ? areaById(selectedAreaId) : null);
        if (fallbackArea === null) {
          setNotice('Двойной клик мимо областей: правка не открыта.');
          return;
        }
        swallow();
        lastSeenSelection = fallbackArea.id;
        selectedAreaId = fallbackArea.id;
        if (contourUnitsOf(fallbackArea).length === 0) {
          setNotice(fallbackArea.closed === false
            ? 'Это открытая линия (граница без заливки): якоря применимы к замкнутым областям.'
            : 'У области нет замкнутого контура: править нечего.');
          return;
        }
        const opened = openContourEdit(session(), fallbackArea.id, [world.x, world.y], 0, tol, level);
        if (opened.session !== session()) apply(opened.session);
        setNotice(opened.message);
        paintOverlay();
        return;
      }

      swallow();
      lastSeenSelection = hitTarget.area.id;
      selectedAreaId = hitTarget.area.id;
      if (ref !== null && ref.areaId === hitTarget.area.id && ref.ringIndex === hitTarget.ringIndex) {
        const result = subdivideContourSegment(
          session(),
          hitTarget.click,
          tol,
          { minGap: minGapWorld() },
          level,
        );
        if (result.session !== session()) apply(result.session);
        setNotice(result.message);
        paintOverlay();
        return;
      }
      const opened = openContourEdit(session(), hitTarget.area.id, hitTarget.click, hitTarget.ringIndex, tol, level);
      if (opened.session !== session()) apply(opened.session);
      setNotice(opened.message);
      paintOverlay();
      return;
    }

    if (mode === 'pairline' && lineEdit !== null) {
      const tol = clickToleranceWorld();
      const hit = projectOnCurve(lineEdit.state.activeCurve, [world.x, world.y], false);
      if (hit.distance > tol) {
        setNotice('Двойной клик мимо линии раздела.');
        return;
      }
      swallow();
      const refined = subdivideSegment(lineEdit.state, [hit.point[0], hit.point[1]], tol, { minGap: minGapWorld() });
      if (!refined.ok) {
        setNotice(refined.reason);
        return;
      }
      lineEdit = { ...lineEdit, state: refined.state };
      // Уточнение линии пишется в документ сразу (setPairLineCmd): иначе оно
      // жило только в состоянии и пропадало при Esc (дефект B5.2 ревью).
      const baked = commitLineDrag(lineEdit.state);
      const nextLine: PairLine = {
        manual: true,
        points: baked.points,
        anchors: baked.anchors,
      };
      const saved = setPairLineCmd(session(), lineEdit.pairId, nextLine, lineEdit.lineIndex);
      apply(saved.session);
      const pair = pairById(lineEdit.pairId);
      const savedLine = pair === null ? null : lineOfPair(pair, lineEdit.lineIndex);
      if (savedLine !== null) {
        const reopened = reopenLineEdit(savedLine.points, savedLine.anchors);
        if (reopened.ok) lineEdit = { ...lineEdit, sourceLine: savedLine, state: reopened.state };
      }
      setNotice('Сегмент линии уточнён: 2 крайних якоря сохранены, добавлены 4.');
      paintOverlay();
    }
  }

  function onCancelEdit(): void {
    if (mode === 'pairline') {
      // Правка линии пары завершается целиком: незакоммиченный предпросмотр
      // пропадает, записанная линия остаётся в документе как была.
      lineEdit = null;
      mode = 'contour';
      setNotice('Правка линии раздела завершена: записанная линия сохранена в документе.');
      paintOverlay();
      return;
    }
    endContour(false);
    setNotice('Правка контура завершена.');
    paintOverlay();
  }

  function onContextMenu(event: Event): void {
    if (!on) return;
    if (mode === 'contour' && (session().contourEdit ?? null) === null && lineEdit === null) return;
    event.preventDefault();
    event.stopPropagation();
    onCancelEdit();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!on) return;
    // Esc из текстовых полей панели не завершает правку: пользователь печатает.
    if (isTextEntryTarget(event.target)) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onCancelEdit();
  }

  /* ---------------------------------------------------------------- wiring */

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
    setEnabled,
    enabled(): boolean { return on; },
    refresh,
    contourEditAreaId(): string | null {
      const ref = session().contourEdit ?? null;
      return ref === null ? null : ref.areaId;
    },
    pairLinePairId(): string | null {
      return lineEdit === null ? null : lineEdit.pairId;
    },
    destroy(): void {
      stopOverlayLoop();
      for (const item of listeners) {
        if (item.target !== null) item.target.removeEventListener(item.type, item.handler, item.capture);
      }
      listeners.length = 0;
      if (preview !== null && preview.parentNode !== null) preview.parentNode.removeChild(preview);
      preview = null;
    },
  };
}
