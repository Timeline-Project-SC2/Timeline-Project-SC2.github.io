/* Map Atlas — камера, canvas-рендер карты и pointer-взаимодействие. */

import {
  CONFIG,
  clamp,
  easeOutCubic,
  normalize,
} from './config.ts';
import type {
  AtlasKernel,
  AtlasView,
  CanvasRendererApi,
  MapPoint,
  PlaceRecord,
  SystemRecord,
} from './config.ts';
import { markerDiameter, maxScaleForTargetWidth } from './level-ladder.ts';
import { smoothPolyline } from './sector-bounds.ts';
import { smoothBoundaryAtMapEdge } from './sector-boundary-path.ts';
import { clipHalo } from './sector-halo-clip.ts';
import { createStarGroups } from './sector-stars.ts';
import { nebulaBlinkIntensity } from './nebula-model.ts';
import type { LabelItem, LabelLayoutResult, LabelMetrics, LabelRect } from './label-layout.ts';
import { LABEL_BUDGET, layoutLabels } from './label-layout.ts';
import type {
  SceneAperture,
  SceneBounds,
  SceneCamera,
  SceneGridLabel,
  SceneGridLine,
  SceneMarker,
  SceneSystemInput,
  SectorScene,
} from './sector-scene.ts';
import {
  LOUPE_LABEL_PAD_PX,
  buildSectorScene,
  hitRadiusFor,
  inspectOf,
  inspectOnPointer,
  inspectPointFor,
  labelTextFor,
  loupeGridFor,
} from './sector-scene.ts';

interface ViewAnimation {
  from: AtlasView;
  to: AtlasView;
  start: number;
}

interface DragState {
  mode: 'pan';
  startX: number;
  startY: number;
  tx: number;
  ty: number;
  moved: boolean;
  shiftKey: boolean;
  button: number;
}

interface PinchState {
  distance: number;
  center: MapPoint;
}

export function createCanvasRenderer(kernel: AtlasKernel): CanvasRendererApi {
  const state = kernel.state;
  const theme = kernel.theme;
  const el = kernel.el;
  const runtime = kernel.runtime;

  function mapCanvas(): HTMLCanvasElement {
    return kernel.canvas!;
  }

  /* ------------------------------------------------------------------ представление карты */

  function fitScale(): number {
    var size = kernel.data.mapSize();
    var pad = CONFIG.view.fitInset;
    return Math.min(state.viewport.w, state.viewport.h) / size * pad;
  }

  // Каталог лежит поверх карты и не меняет размер сцены. Ширина «занятой» полосы
  // берётся из CSS (--panel-inset): ею же пользуются чипы внизу и заголовок раздела,
  // поэтому вся обвеска двигается синхронно с панелью, а сама карта — ни на пиксель.
  function panelInset(): number {
    if (!el.mapStage) return 0;
    var raw = '';
    try { raw = getComputedStyle(el.mapStage).getPropertyValue('--panel-inset'); } catch (err) { raw = ''; }
    var value = parseFloat(raw);
    if (!isFinite(value) || value < 0) return 0;
    return Math.min(value, state.viewport.w * 0.5);
  }

  function minScale(): number { return fitScale() * CONFIG.view.minFactor; }
  function maxScale(): number {
    return maxScaleForTargetWidth(state.viewport, kernel.data.mapSize(), CONFIG.view.fitInset);
  }

  function fitView(): void {
    var size = kernel.data.mapSize();
    var scale = fitScale();
    state.view.scale = scale;
    var inset = panelInset();
    var span = size * scale;
    // центр «свободной» зоны справа от каталога: карта не уезжает под панель
    state.view.tx = inset + (state.viewport.w - inset - span) / 2;
    state.view.ty = (state.viewport.h - span) / 2;
    clampView();
  }

  // Запас CONFIG.view.panMargin от размера экрана: карту можно сдвинуть выше-ниже и левее-правее
  // дальше краёв, как на галактике. Когда карта меньше экрана, она свободно ходит внутри запаса.
  function clampAxis(value: number, span: number, viewport: number): number {
    var m = viewport * CONFIG.view.panMargin;
    if (span <= viewport) {
      var c = (viewport - span) / 2;
      return clamp(value, c - m, c + m);
    }
    return clamp(value, viewport - span - m, m);
  }

  function clampView(): void {
    var size = kernel.data.mapSize();
    var scale = clamp(state.view.scale, minScale(), maxScale());
    state.view.scale = scale;
    var span = size * scale;
    state.view.tx = clampAxis(state.view.tx, span, state.viewport.w);
    state.view.ty = clampAxis(state.view.ty, span, state.viewport.h);
  }

  function toScreen(worldX: number, worldY: number): MapPoint {
    return { x: state.view.tx + worldX * state.view.scale, y: state.view.ty + worldY * state.view.scale };
  }

  function toWorld(screenX: number, screenY: number): MapPoint {
    return { x: (screenX - state.view.tx) / state.view.scale, y: (screenY - state.view.ty) / state.view.scale };
  }

  function zoomAt(screenX: number, screenY: number, factor: number): void {
    if (state.travel.enabled) kernel.coords.cancelPendingTravelTap();
    var before = toWorld(screenX, screenY);
    var next = clamp(state.view.scale * factor, minScale(), maxScale());
    if (next === state.view.scale) return;
    state.view.scale = next;
    var after = toWorld(screenX, screenY);
    state.view.tx += (after.x - before.x) * next;
    state.view.ty += (after.y - before.y) * next;
    clampView();
    requestRender();
  }

  let animation: ViewAnimation | null = null;

  function animateTo(scale: number, tx: number, ty: number): void {
    animation = {
      from: { scale: state.view.scale, tx: state.view.tx, ty: state.view.ty },
      to: { scale: clamp(scale, minScale(), maxScale()), tx: tx, ty: ty },
      start: performance.now()
    };
    requestRender();
  }

  function stepAnimation(now: number): boolean {
    if (!animation) return false;
    var t = clamp((now - animation.start) / CONFIG.view.animate, 0, 1);
    var k = easeOutCubic(t);
    state.view.scale = animation.from.scale + (animation.to.scale - animation.from.scale) * k;
    state.view.tx = animation.from.tx + (animation.to.tx - animation.from.tx) * k;
    state.view.ty = animation.from.ty + (animation.to.ty - animation.from.ty) * k;
    if (t >= 1) animation = null;
    return true;
  }

  function centerOn(worldX: number, worldY: number, scale?: number): void {
    var rawTarget = scale || Math.max(state.view.scale, fitScale() * 2.6);
    var target = clamp(rawTarget, minScale(), maxScale());
    var tx = state.viewport.w / 2 - worldX * target;
    var ty = state.viewport.h / 2 - worldY * target;
    var size = kernel.data.mapSize();
    tx = clampAxis(tx, size * target, state.viewport.w);
    ty = clampAxis(ty, size * target, state.viewport.h);
    animateTo(target, tx, ty);
  }

  /* ------------------------------------------------------------------ схематичная подложка */

  // Один и тот же каталог для обычного поля и схематического резерва.
  const starGroups = createStarGroups();
  function drawStars(): void {
    const ctx = kernel.ctx!;
    const size = kernel.data.mapSize();
    const scale = state.view.scale;
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(scale) || scale <= 0 ||
        !Number.isFinite(state.view.tx) || !Number.isFinite(state.view.ty) ||
        !Number.isFinite(state.viewport.w) || !Number.isFinite(state.viewport.h) ||
        state.viewport.w <= 0 || state.viewport.h <= 0) return;
    const margin = 2 / scale;
    const left = (-state.view.tx) / scale - margin;
    const right = (state.viewport.w - state.view.tx) / scale + margin;
    const top = (-state.view.ty) / scale - margin;
    const bottom = (state.viewport.h - state.view.ty) / scale + margin;
    ctx.save();
    ctx.fillStyle = '#cfe0f5';
    for (const group of starGroups) {
      ctx.globalAlpha = group.alpha;
      ctx.beginPath();
      for (let tileY = Math.floor(top / size); tileY <= Math.floor(bottom / size); tileY++) {
        for (let tileX = Math.floor(left / size); tileX <= Math.floor(right / size); tileX++) {
          for (const star of group.stars) {
            const x = state.view.tx + (star.x + tileX) * size * scale;
            const y = state.view.ty + (star.y + tileY) * size * scale;
            if (x < -2 || y < -2 || x > state.viewport.w + 2 || y > state.viewport.h + 2) continue;
            ctx.moveTo(x + group.radius, y);
            ctx.arc(x, y, group.radius, 0, Math.PI * 2);
          }
        }
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSchematic(scene: SectorScene | null): void {
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.fillStyle = '#03060c';
    ctx.fillRect(0, 0, state.viewport.w, state.viewport.h);

    // Резерв тоже использует контуры туманностей, а не несвязанные круги.
    if (scene) {
      ctx.fillStyle = 'rgba(80, 100, 180, .18)';
      for (const primitive of scene.primitives) {
        if (primitive.kind !== 'bounds' || primitive.boundsKind !== 'nebula') continue;
        ctx.beginPath();
        traceBounds(primitive);
        ctx.fill();
      }
    }

    // Сетку и координатные отметки рисует только слой сцены (`gridFor`):
    // собственных шагов сетки в рендерере нет.
    ctx.restore();
  }

  /* ------------------------------------------------------------------ маркеры систем */

  function markerVisible(system: SystemRecord): boolean {
    if (state.mapFaction === 'all') return true;
    var factions = system.worlds.length ? kernel.data.systemFactions(system) : (system.factions || []);
    return factions.indexOf(state.mapFaction) > -1;
  }

  function visibleSystems(): SystemRecord[] {
    var list: SystemRecord[] = [];
    for (var i = 0; i < state.systems.length; i++) {
      var system = state.systems[i]!; if (system.coord && markerVisible(system)) list.push(system);
    }
    return list;
  }

  function visiblePointsOfInterest(): PlaceRecord[] {
    return state.planets.filter(function (place) {
      if (!place.pointOfInterest || place.systemId || !kernel.data.coordinateOnMap(place.mapCoord)) return false;
      return state.mapFaction === 'all' || kernel.data.factionsOf(place).indexOf(state.mapFaction) > -1;
    });
  }

  function drawTravelRoute(now: number): void {
    const ctx = kernel.ctx!;
    if (!state.travel.enabled || !state.travel.calculation || !state.travel.calculation.legs.length) return;
    var calculation = state.travel.calculation;
    var legs = calculation.legs;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = 'rgba(46,245,230,.68)';
    ctx.shadowColor = 'rgba(46,245,230,.46)';
    ctx.shadowBlur = 9;

    legs.forEach(function (leg, index) {
      var from = toScreen(leg.from.coord[0]!, leg.from.coord[1]!);
      var to = toScreen(leg.to.coord[0]!, leg.to.coord[1]!);
      ctx.setLineDash(index >= calculation.forwardLegs.length ? [7, 6] : []);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);

      var angle = Math.atan2(to.y - from.y, to.x - from.x);
      var arrowX = from.x + (to.x - from.x) * 0.66;
      var arrowY = from.y + (to.y - from.y) * 0.66;
      var arrowSize = 7;
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - arrowSize * Math.cos(angle - Math.PI / 6), arrowY - arrowSize * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(arrowX - arrowSize * Math.cos(angle + Math.PI / 6), arrowY - arrowSize * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    });

    var stops = kernel.coords.travelStops();
    stops.forEach(function (stop, index) {
      var point = toScreen(stop.coord[0]!, stop.coord[1]!);
      ctx.setLineDash([]);
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(1,10,9,.94)';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = theme.accent;
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = theme.text;
      ctx.font = '10px ' + theme.mono;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), point.x, point.y);
    });

    if (kernel.coords.isTravelAnimationActive()) {
      var segment = Math.floor(now / 950) % legs.length;
      var progress = (now % 950) / 950;
      var current = legs[segment]!;
      var start = toScreen(current.from.coord[0]!, current.from.coord[1]!);
      var end = toScreen(current.to.coord[0]!, current.to.coord[1]!);
      var px = start.x + (end.x - start.x) * progress;
      var py = start.y + (end.y - start.y) * progress;
      ctx.shadowColor = theme.accent;
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#bafff9';
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Радиус ромба точки интереса: экранный, с клампом 4…9 px. */
  function poiRadius(): number {
    return clamp(9 * state.view.scale, 4, 9);
  }

  function drawPointsOfInterest(): void {
    const ctx = kernel.ctx!;
    var scale = state.view.scale;
    var list = visiblePointsOfInterest();
    ctx.save();
    ctx.textBaseline = 'middle';

    list.forEach(function (place) {
      var point = toScreen(place.mapCoord!.x, place.mapCoord!.y);
      if (point.x < -36 || point.y < -36 || point.x > state.viewport.w + 36 ||
          point.y > state.viewport.h + 36) return;

      var hovered = state.hoverPoiId === place.id;
      var active = state.activePlanetId === place.id;
      var radius = poiRadius() + (hovered || active ? clamp(3 * scale, 1, 3) : 0);
      var color = hovered || active ? theme.text : theme.accent2;

      ctx.save();
      if (hovered || active) {
        ctx.shadowColor = 'rgba(128,169,218,.72)';
        ctx.shadowBlur = clamp(24 * scale, 9, 26);
      }
      ctx.beginPath();
      ctx.moveTo(point.x, point.y - radius);
      ctx.lineTo(point.x + radius, point.y);
      ctx.lineTo(point.x, point.y + radius);
      ctx.lineTo(point.x - radius, point.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(128,169,218,.24)';
      ctx.strokeStyle = color;
      ctx.lineWidth = clamp(2.4 * scale, 1.1, 2.5);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      // Имя точки интереса рисует единый слой подписей (drawSceneLabels),
      // поэтому здесь остаётся только ромб-маркер без собственного текста.
    });

    ctx.restore();
  }

  function drawPlanetFocus(): void {
    const ctx = kernel.ctx!;
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    if (!planet || !planet.mapCoord) return;
    var point = toScreen(planet.mapCoord.x, planet.mapCoord.y);
    var scale = state.view.scale;
    var color = theme.accent2;
    var radius = clamp(38 * scale, 11, 56);
    var armGap = clamp(12 * scale, 7, 18);
    var armLength = clamp(28 * scale, 12, 38);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = clamp(4.5 * scale, 1.2, 4.2);
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(point.x - radius - armLength, point.y); ctx.lineTo(point.x - radius - armGap, point.y);
    ctx.moveTo(point.x + radius + armGap, point.y); ctx.lineTo(point.x + radius + armLength, point.y);
    ctx.moveTo(point.x, point.y - radius - armLength); ctx.lineTo(point.x, point.y - radius - armGap);
    ctx.moveTo(point.x, point.y + radius + armGap); ctx.lineTo(point.x, point.y + radius + armLength);
    ctx.stroke();
    // Имя выбранной планеты тоже идёт через единый слой подписей.
    ctx.restore();
  }

  /* --------------------------------------------------------------- сцена сектора (§8.1) */

  // Примитивы собирает `sector-scene.ts`: уровень по камере, территории фракций,
  // сетка адресов, маркеры по `markerDiameter` и апертура. Рендерер только рисует
  // готовое и раскладывает подписи по фактическим метрикам шрифта — собственных
  // размеров маркера и шагов сетки здесь нет (И-8).

  let coarsePointerQuery: MediaQueryList | null = null;
  var pulseQuery: MediaQueryList | null = null;

  /**
   * Грубый указатель (сенсор) расширяет хит-зону до 44 px (§6.2 п. 5).
   * `MediaQueryList` создаётся один раз и только читается: слушателей нет,
   * поэтому нечему протекать, а значение не устаревает при смене устройства ввода.
   */
  function coarsePointer(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    if (coarsePointerQuery === null) coarsePointerQuery = window.matchMedia('(pointer: coarse)');
    return coarsePointerQuery.matches;
  }

  function reducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    if (pulseQuery === null) pulseQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    return pulseQuery.matches;
  }

  /** Уровень выбирается по полной ширине (Z-4b); короткая ось — только для edgeDistance. */
  function visibleWidth(): number {
    var scale = state.view.scale;
    if (!(scale > 0)) return Number.POSITIVE_INFINITY;
    return state.viewport.w / scale;
  }

  function sceneCamera(): SceneCamera {
    var center = toWorld(state.viewport.w / 2, state.viewport.h / 2);
    return { centerX: center.x, centerY: center.y, visibleWidth: visibleWidth() };
  }

  /** Вход сцены: системы с координатами карты и тем же фильтром фракции, что и раньше. */
  function sceneSystems(): SceneSystemInput[] {
    var list = state.systems;
    var input: SceneSystemInput[] = [];
    for (var index = 0; index < list.length; index += 1) {
      var system = list[index]!;
      if (!system.coord || !markerVisible(system)) continue;
      var faction = system.primaryFaction ?? (system.factions && system.factions[0]) ?? null;
      input.push({
        id: system.id,
        name: system.name,
        x: system.coord[0],
        y: system.coord[1],
        faction: faction,
        type: system.systemType ?? null,
      });
    }
    return input;
  }

  function buildScene(): SectorScene | null {
    if (!(state.viewport.w > 0) || !(state.viewport.h > 0) || !(state.view.scale > 0)) return null;
    return buildSectorScene({
      systems: sceneSystems(),
      viewport: state.viewport,
      camera: sceneCamera(),
      sectorBounds: state.sectorBounds ?? null,
      hitTarget: coarsePointer() ? 'touch' : 'mouse',
      // Подписи раскладывает рендерер: только он знает фактические метрики шрифта.
      labels: false,
    });
  }

  /** Метрики подписи из фактического замера шрифта, а не из «средней ширины». */
  function labelMetrics(fontSize: number): LabelMetrics {
    var ctx = kernel.ctx;
    var fallback = fontSize * 0.6;
    var charWidth = fallback;
    var lineHeight = Math.round(fontSize * 1.25);
    if (ctx) {
      try {
        ctx.save();
        ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
        var sample = 'ЖЖЖЖЖЖЖЖЖЖ';
        var measured = ctx.measureText(sample);
        var width = measured && typeof measured.width === 'number' ? measured.width : 0;
        if (width > 0) charWidth = width / sample.length;
        ctx.restore();
      } catch (err) {
        // Контекст-заглушка без measureText (тесты): остаются метрики по умолчанию.
        charWidth = fallback;
      }
    }
    return {
      fontSize: fontSize,
      charWidth: charWidth,
      lineHeight: lineHeight,
      paddingX: CONFIG.scene.labelPaddingX,
      paddingY: CONFIG.scene.labelPaddingY,
    };
  }

  /** Одна геометрия для заливки туманности и её видимой границы. */
  function traceBounds(bounds: SceneBounds): void {
    const ctx = kernel.ctx!;
    const points = bounds.points.map(({ x, y }) => [x, y] as const);
    const corner = toScreen(0, 0);
    const farCorner = toScreen(kernel.data.mapSize(), kernel.data.mapSize());
    const path = bounds.boundsKind === 'nebula'
      ? smoothBoundaryAtMapEdge(points, { left: corner.x, right: farCorner.x, top: corner.y, bottom: farCorner.y })
      : smoothPolyline(points, bounds.boundsKind !== 'halo');
    ctx.moveTo(path.start[0], path.start[1]);
    for (const curve of path.curves) {
      ctx.quadraticCurveTo(curve.control[0], curve.control[1], curve.end[0], curve.end[1]);
    }
    if (path.tail !== null) ctx.lineTo(path.tail[0], path.tail[1]);
    if (path.closed) ctx.closePath();
  }

  /** Квадратичная кривая лежит внутри габарита своих исходных вершин. */
  function boundsIntersectViewport(bounds: SceneBounds): boolean {
    if (bounds.points.length < 2) return false;
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    for (const point of bounds.points) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    return maxX >= 0 && maxY >= 0 && minX <= state.viewport.w && minY <= state.viewport.h;
  }

  function drawBounds(bounds: SceneBounds): void {
    if (bounds.points.length < 2) return;
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = bounds.boundsKind === 'halo' ? 0.55 : 0.7;
    ctx.strokeStyle = bounds.color === 'tactical' ? theme.accent : theme.accent2;
    ctx.lineWidth = Math.max(1, bounds.strokeWidth);
    ctx.setLineDash([...bounds.dash]);

    // Ограничиваем обводку кадром. Для пунктира дополнительно исключаем
    // далёкие части кривой, сохраняя их длину в фазе штрихов.
    if (typeof ctx.rect === 'function' && typeof ctx.clip === 'function') {
      ctx.beginPath();
      ctx.rect(0, 0, state.viewport.w, state.viewport.h);
      ctx.clip();
    }

    if (bounds.boundsKind === 'halo' && bounds.dash.length > 0) {
      const path = smoothPolyline(bounds.points.map(({ x, y }) => [x, y] as const), false);
      const period = bounds.dash.reduce((sum, value) => sum + value, 0) * (bounds.dash.length % 2 ? 2 : 1);
      for (const run of clipHalo(path, state.viewport.w, state.viewport.h)) {
        ctx.lineDashOffset = period > 0 ? run.offset % period : 0;
        ctx.beginPath();
        ctx.moveTo(run.start[0], run.start[1]);
        for (const curve of run.curves) ctx.quadraticCurveTo(curve.control[0], curve.control[1], curve.end[0], curve.end[1]);
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      traceBounds(bounds);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /*
   * Фейд смены тира сетки (§17.3 п. 9): 160 мс. Состояние перехода живёт только
   * здесь — без новых слоёв, второго canvas и DOM-узлов (F3-7). Прозрачности
   * `0,16`/`0,07` приходят из сцены полем `line.alpha` (F3-9); рендерер хранит
   * лишь прогресс перехода к текущей цели, своих чисел прозрачности не вводит.
   *
   * Ключ — тир сетки. Тиры сменяются парами (например `T3/T4` → `T4/T5`): тир,
   * который был вложенным, становится старшим, и его цель меняется `0,07 → 0,16`.
   * Переход считается от текущего значения к новой цели, поэтому такая смена
   * тоже идёт 160 мс, без скачка. Исчезнувший тир сцена больше не содержит —
   * гасить нечего, его запись снимается без рисования.
   */
  const GRID_FADE_MS = 160;
  var gridFadeEntries = new Map<string, { from: number; to: number; start: number }>();
  var gridFadeFactors = new Map<string, number>();
  var gridFadePrimed = false;

  /** Значение перехода в момент `nowMs`: линейно от `from` к `to` за `GRID_FADE_MS`. */
  function gridFadeValue(entry: { readonly from: number; readonly to: number; readonly start: number }, nowMs: number): number {
    var progress = (nowMs - entry.start) / GRID_FADE_MS;
    var clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;

    return entry.from + (entry.to - entry.from) * clamped;
  }

  /** Множитель фейда тира `0…1`: `1` — штатная прозрачность `line.alpha`. */
  function gridFadeFactor(tier: string): number {
    return gridFadeFactors.get(tier) ?? 1;
  }

  /**
   * Шаг фейда за кадр: у каждого тира кадра своя цель — его `line.alpha` из сцены.
   * При `prefers-reduced-motion` переход не заводится вовсе (мгновенно). Пока
   * хотя бы один тир не дошёл до цели, рендерер просит следующий кадр.
   */
  function updateGridFade(scene: SectorScene, nowMs: number): void {
    var targets = new Map<string, number>();
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind === 'grid.line') targets.set(primitive.tier, primitive.alpha);
    }

    var reduced = reducedMotion();
    var animating = false;
    gridFadeFactors.clear();
    targets.forEach(function (target: number, tier: string): void {
      var previous = gridFadeEntries.get(tier);
      var from = !gridFadePrimed || reduced
        ? target
        : previous === undefined
          ? 0
          : gridFadeValue(previous, nowMs);
      var entry = previous !== undefined && previous.to === target && gridFadePrimed && !reduced
        ? previous
        : { from: from, to: target, start: nowMs };
      gridFadeEntries.set(tier, entry);

      var value = gridFadeValue(entry, nowMs);
      var factor = target > 0 ? Math.min(1, Math.max(0, value / target)) : 0;
      gridFadeFactors.set(tier, factor);
      if (factor < 1) animating = true;
    });
    gridFadeEntries.forEach(function (_entry, tier: string): void {
      if (!targets.has(tier)) gridFadeEntries.delete(tier);
    });
    gridFadePrimed = true;

    if (animating && !runtime.renderQueued) requestRender();
  }

  /** Линия сетки: всегда `1 px`, прозрачность — из примитива (`line.alpha`). */
  function drawGridLine(line: SceneGridLine): void {
    const ctx = kernel.ctx!;
    var alpha = line.alpha * gridFadeFactor(line.tier);
    if (!(alpha > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgb(150,180,215)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(line.x1) + 0.5, Math.round(line.y1) + 0.5);
    ctx.lineTo(Math.round(line.x2) + 0.5, Math.round(line.y2) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Подпись ячейки сетки: сперва тёмный контур `strokeText` `2 px`, затем заливка
   * `fillText` — вместо плашки (§17.3 п. 6). Позиция `+3/+3` прежняя.
   */
  function drawGridLabel(label: SceneGridLabel): void {
    const ctx = kernel.ctx!;
    var alpha = gridFadeFactor(label.tier);
    if (!(alpha > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '9px ' + theme.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(6,10,18,.85)';
    ctx.strokeText(label.text, label.x + 3, label.y + 3);
    ctx.fillStyle = 'rgba(160,186,216,.42)';
    ctx.fillText(label.text, label.x + 3, label.y + 3);
    ctx.restore();
  }

  /*
   * Приглушение маркеров в `anticipation` (`§6.4`): цель полёта остаётся яркой
   * (`1`), остальные гаснут до `dimAlpha` (`0,35`). Фазу знает только полёт
   * (`sector-flight.ts`), поэтому рендерер хранит лишь полученное состояние:
   * `setFlightDim(null, 1)` возвращает штатные `1` / `0,66`.
   */
  let flightDimTargetId: string | null = null;
  let flightDimAlpha = 1;

  function setFlightDim(targetId: string | null, alpha: number): void {
    var nextTarget = targetId || null;
    var nextAlpha = nextTarget === null
      ? 1
      : clamp(Number.isFinite(alpha) ? alpha : 1, 0, 1);
    if (nextTarget === flightDimTargetId && nextAlpha === flightDimAlpha) return;
    flightDimTargetId = nextTarget;
    flightDimAlpha = nextAlpha;
    requestRender();
  }

  /** `globalAlpha` маркера: приглушение полёта важнее подсветки и флага координат. */
  function markerAlpha(markerId: string, highlighted: boolean, verified: boolean): number {
    if (flightDimTargetId !== null) return markerId === flightDimTargetId ? 1 : flightDimAlpha;
    return highlighted || verified ? 1 : 0.66;
  }

  function drawMarker(marker: SceneMarker): void {
    const ctx = kernel.ctx!;
    var system = state.systemsById[marker.id];
    var isHover = state.hoverId === marker.id;
    var isActive = state.activeSystemId === marker.id;
    var highlighted = isHover || isActive;
    var verified = system ? system.coordSource === 'map' : true;
    var fromLabel = !!system && verified && !system.fromSheet;
    // Подсветка добавляет не больше 2 px и упирается в тот же кламп 40 px:
    // на глубоком зуме маркер не раздувается (§6.2 п. 2).
    var radius = Math.min(20, marker.diameter / 2 + (highlighted ? 2 : 0));
    var dot = Math.min(clamp(marker.diameter * 0.2, 1.1, 3.6), radius * 0.8);
    var stroke = clamp(marker.diameter * 0.12, 1, 2.4);
    var color = highlighted ? theme.accent : 'rgba(36,234,219,.38)';

    ctx.save();
    if (highlighted) {
      ctx.shadowColor = theme.accent;
      ctx.shadowBlur = 18;
    }
    ctx.globalAlpha = markerAlpha(marker.id, highlighted, verified);
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = stroke * (highlighted ? 1.35 : 1);
    ctx.strokeStyle = color;
    if (!verified) {
      var dash = clamp(marker.diameter * 0.35, 3, 8);
      ctx.setLineDash([dash, dash]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (verified) {
      ctx.fillStyle = 'rgba(36,234,219,.08)';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(marker.x, marker.y, dot, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // У систем с подписью на карте — крестовина точки, как было до сцены.
    if (fromLabel) {
      var inner = radius + clamp(marker.diameter * 0.25, 2, 7);
      var outer = inner + clamp(marker.diameter * 0.5, 3, 14);
      ctx.beginPath();
      ctx.moveTo(marker.x - outer, marker.y); ctx.lineTo(marker.x - inner, marker.y);
      ctx.moveTo(marker.x + inner, marker.y); ctx.lineTo(marker.x + outer, marker.y);
      ctx.moveTo(marker.x, marker.y - outer); ctx.lineTo(marker.x, marker.y - inner);
      ctx.moveTo(marker.x, marker.y + inner); ctx.lineTo(marker.x, marker.y + outer);
      ctx.lineWidth = clamp(stroke * 0.72, 1, 3.2);
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.restore();

    if (system && system.needsReview) {
      ctx.beginPath();
      ctx.arc(
        marker.x + radius * 0.72, marker.y - radius * 0.72,
        clamp(marker.diameter * 0.3, 3, 9), 0, Math.PI * 2,
      );
      ctx.fillStyle = '#e8a35c';
      ctx.fill();
    }
  }

  function drawAperture(aperture: SceneAperture): void {
    const ctx = kernel.ctx!;
    var radius = Math.min(20, aperture.ringDiameter / 2) + 6;
    ctx.save();
    ctx.strokeStyle = 'rgba(214,178,110,.55)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(aperture.x, aperture.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    var hoveredSystemId = state.hoverId
      ?? (state.hoverPoiId && !state.planetsById[state.hoverPoiId] ? state.hoverPoiId : null);
    var focusedSystemId = state.activeSystemId
      ?? (state.activePlanetId && !state.planetsById[state.activePlanetId] ? state.activePlanetId : null);
    if (aperture.systemId === hoveredSystemId || aperture.systemId === focusedSystemId) {
      ctx.font = '10px ' + theme.mono;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(226,196,130,.75)';
      ctx.fillText(aperture.hint, aperture.x, Math.min(state.viewport.h - 16, aperture.y + radius + 6));
    }
    ctx.restore();
  }

  /** Подписи систем: текст и приоритет берутся из сцены (§6.2, §8.1). */
  function collectSystemLabels(scene: SectorScene, items: LabelItem[]): void {
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind !== 'marker') continue;
      var text = labelTextFor(primitive, scene.level);
      if (text === null) continue;
      var highlighted = state.hoverId === primitive.id || state.activeSystemId === primitive.id;
      if (!state.labelsOn && !highlighted) continue;
      items.push({
        id: 'system:' + primitive.id,
        text: text,
        x: primitive.x,
        y: primitive.y,
        priority: primitive.labelPriority,
        radius: primitive.diameter / 2,
      });
    }
  }

  /** Картографические подписи из `map-labels.json` — тот же слой, приоритет ниже систем. */
  function collectMapLabels(items: LabelItem[]): void {
    if (!state.labelsOn) return;
    var labels = state.labels;
    if (!labels || !labels.length) return;
    var scale = state.view.scale;
    if (scale < CONFIG.layers.labelScale) return;

    // Точки, где уже стоит маркер, подписаны своим именем: дубль не нужен.
    var occupied: Record<string, boolean> = {};
    visibleSystems().forEach(function (system) {
      occupied[Math.round(system.coord![0] / 8) + ':' + Math.round(system.coord![1] / 8)] = true;
    });
    visiblePointsOfInterest().forEach(function (place) {
      occupied[Math.round(place.mapCoord!.x / 8) + ':' + Math.round(place.mapCoord!.y / 8)] = true;
    });

    var seen: Record<string, boolean> = {};
    for (var index = 0; index < labels.length; index += 1) {
      var label = labels[index]!;
      if (label.noisy && scale < CONFIG.layers.noisyLabelScale) continue;
      var key = normalize(label.name);
      if (seen[key]) continue;
      if (label.kind !== 'object' && occupied[Math.round(label.x / 8) + ':' + Math.round(label.y / 8)]) continue;
      var point = toScreen(label.x, label.y);
      if (point.x < -40 || point.y < -20 || point.x > state.viewport.w + 40 || point.y > state.viewport.h + 20) continue;
      seen[key] = true;
      items.push({
        id: 'map:' + index,
        text: label.name,
        x: point.x,
        y: point.y,
        priority: label.linkedSystemId ? 40 : (label.linkedPlanetId ? 35 : (label.kind === 'system' ? 30 : 20)),
      });
    }
  }

  function collectPoiLabels(items: LabelItem[]): void {
    if (!state.labelsOn) return;
    var list = visiblePointsOfInterest();
    var markerRadius = poiRadius();
    for (var index = 0; index < list.length; index += 1) {
      var place = list[index]!;
      var point = toScreen(place.mapCoord!.x, place.mapCoord!.y);
      if (point.x < -40 || point.y < -40 || point.x > state.viewport.w + 40 || point.y > state.viewport.h + 40) continue;
      items.push({
        id: 'poi:' + place.id,
        text: place.name,
        x: point.x,
        y: point.y,
        priority: 45,
        radius: markerRadius,
      });
    }
  }

  function collectFocusLabel(items: LabelItem[]): void {
    if (!state.labelsOn) return;
    var planet = state.activePlanetId ? state.planetsById[state.activePlanetId] : null;
    if (!planet || !planet.mapCoord) return;
    var point = toScreen(planet.mapCoord.x, planet.mapCoord.y);
    items.push({
      id: 'focus:' + planet.id,
      text: planet.name,
      x: point.x,
      y: point.y,
      priority: 120,
      radius: clamp(38 * state.view.scale, 11, 56),
    });
  }

  function drawLabels(layer: LabelLayoutResult, metrics: LabelMetrics): void {
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var index = 0; index < layer.placed.length; index += 1) {
      var box = layer.placed[index]!;
      // Подписи карты сохраняют свой якорь-крестик: без него мелкие объекты
      // «висят» в пустоте, а сетка адресов их не заменяет.
      if (box.id.indexOf('map:') === 0) {
        var source = state.labels[Number(box.id.slice(4))];
        if (source) {
          var anchor = toScreen(source.x, source.y);
          var glyph = clamp(box.fontSize * 0.5, 3, 6);
          ctx.save();
          ctx.strokeStyle = source.kind === 'system' ? 'rgba(214,178,110,.5)' : 'rgba(150,170,195,.28)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(anchor.x - glyph, anchor.y);
          ctx.lineTo(anchor.x + glyph, anchor.y);
          ctx.moveTo(anchor.x, anchor.y - glyph);
          ctx.lineTo(anchor.x, anchor.y + glyph);
          ctx.stroke();
          ctx.restore();
        }
      }
      var focused = box.priority >= 100;
      ctx.font = box.fontSize.toFixed(1) + 'px ' + theme.mono;
      ctx.lineWidth = clamp(box.fontSize * 0.24, 2.4, 6);
      ctx.strokeStyle = 'rgba(2,5,10,.82)';
      ctx.fillStyle = focused ? theme.accent : 'rgba(206,220,238,.76)';
      ctx.strokeText(box.text, box.x + metrics.paddingX, box.y + box.height / 2);
      ctx.fillText(box.text, box.x + metrics.paddingX, box.y + box.height / 2);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------- сборка слоёв сцены */

  function renderScene(scene: SectorScene, nowMs: number): void {
    // Гало сохранено в сцене и данных для редактора, но временно не рисуется.
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind === 'bounds' && primitive.boundsKind !== 'halo') drawBounds(primitive);
    }
    // Смена тира гасит/проявляет линии 160 мс (§17.3 п. 9); порядок проходов тот же.
    updateGridFade(scene, nowMs);
    for (index = 0; index < scene.primitives.length; index += 1) {
      primitive = scene.primitives[index]!;
      if (primitive.kind === 'grid.line') drawGridLine(primitive);
      else if (primitive.kind === 'grid.label') drawGridLabel(primitive);
    }
    // Лупа режима осмотра (Z-4c §2): после сетки адресов и до маркеров.
    drawLoupe(scene.level);
    for (index = 0; index < scene.primitives.length; index += 1) {
      primitive = scene.primitives[index]!;
      if (primitive.kind === 'marker') drawMarker(primitive);
    }
  }

  /**
   * Подпись лупы (A3): буквы адреса ячейки от левого верхнего угла с отступом
   * `LOUPE_LABEL_PAD_PX`, шрифт 9 px моно. Для обычной сетки — `drawGridLabel`, он не меняется.
   */
  function drawLoupeLabel(label: SceneGridLabel): void {
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.font = '9px ' + theme.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(160,186,216,.42)';
    ctx.fillText(label.text, label.x + LOUPE_LABEL_PAD_PX, label.y + LOUPE_LABEL_PAD_PX);
    ctx.restore();
  }

  /**
   * Лупа режима осмотра: линии окна — пунктиром 1 px тем же цветом, что сетка;
   * подписи — буквы адреса ячейки (см. `drawLoupeLabel`). Заливки нет. Вне наведения (`hovering: false`)
   * окно рисуется с alpha `0,85`, чтобы не мигало. Команд столько же, сколько
   * построено линий и подписей (`loupeCommandCount`), и это не зависит от площади кадра.
   */
  function drawLoupe(level: number): void {
    var inspect = inspectOf(state);
    if (!inspect.on) return;
    var loupe = loupeGridFor(state.viewport, sceneCamera(), level, inspectPointFor(state.viewport, inspect));
    if (loupe.tierIndex === null || loupe.bounds === null) return;
    var ctx = kernel.ctx!;
    ctx.save();
    ctx.globalAlpha = inspect.hovering ? 1 : 0.85;
    ctx.strokeStyle = 'rgba(150,180,215,.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (var index = 0; index < loupe.lines.length; index += 1) {
      var line = loupe.lines[index]!;
      ctx.moveTo(Math.round(line.x1) + 0.5, Math.round(line.y1) + 0.5);
      ctx.lineTo(Math.round(line.x2) + 0.5, Math.round(line.y2) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // Подписи — внутри того же save/restore: наследуют alpha окна (0,85 вне наведения).
    for (index = 0; index < loupe.labels.length; index += 1) {
      drawLoupeLabel(loupe.labels[index]!);
    }
    ctx.restore();
  }

  /** Апертуры — последним слоем кадра §8.1 (после подписей), с `L8`. */
  function drawApertures(scene: SectorScene): void {
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind === 'aperture') drawAperture(primitive);
    }
  }

  /**
   * Единый слой подписей: системы, карта, точки интереса и фокус — один бюджет
   * `LABEL_BUDGET` (120). Маркеры передаются препятствиями, поэтому подпись
   * не садится ни на свой, ни на чужой маркер.
   */
  function drawSceneLabels(scene: SectorScene): void {
    var items: LabelItem[] = [];
    var obstacles: LabelRect[] = [];
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind !== 'marker') continue;
      obstacles.push({
        x: primitive.x - primitive.diameter / 2,
        y: primitive.y - primitive.diameter / 2,
        width: primitive.diameter,
        height: primitive.diameter,
      });
    }
    collectSystemLabels(scene, items);
    collectMapLabels(items);
    collectPoiLabels(items);
    collectFocusLabel(items);
    if (!items.length) return;
    var metrics = labelMetrics(CONFIG.scene.labelFontPx);
    var layer = layoutLabels(items, state.viewport, {
      budget: LABEL_BUDGET,
      metrics: metrics,
      obstacles: obstacles,
    });
    drawLabels(layer, metrics);
  }

  /** Хит-зона маркера: `d + 6 px`, на грубом указателе не меньше 44 px (§6.2 п. 5). */
  function markerHitRadius(): number {
    return hitRadiusFor(markerDiameter(visibleWidth()), coarsePointer() ? 'touch' : 'mouse');
  }

  /* ------------------------------------------------------------------ цикл рендера */

  function requestRender(): void {
    if (runtime.renderQueued) return;
    runtime.renderQueued = true;
    requestAnimationFrame(render);
  }

  function render(now?: number): void {
    const ctx = kernel.ctx!;
    runtime.renderQueued = false;
    var frameTime = now || performance.now();
    var running = stepAnimation(frameTime);
    var travelActive = kernel.coords.isTravelAnimationActive();
    if (running || travelActive) {
      requestRender();
    }

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.viewport.w, state.viewport.h);

    // Сцена нужна до поля: её контуры являются маской облаков.
    const scene = buildScene();
    const field = kernel.field;
    const fieldCanvas = kernel.fieldCanvas;
    if (
      state.meta !== null &&
      field !== null &&
      fieldCanvas !== null &&
      !runtime.fieldContextLost &&
      state.viewport.w > 0 &&
      state.viewport.h > 0
    ) {
      const fieldState = {
        view: state.view,
        viewport: state.viewport,
        dpr: state.dpr,
        mapSize: kernel.data.mapSize(),
      };
      // Вне отмеченных туманностей — звёзды и спокойный фон без облачного шума.
      field.renderField({ ...fieldState, edgeDist: 1 });
      if (fieldCanvas.width > 0 && fieldCanvas.height > 0) {
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(fieldCanvas, 0, 0, state.viewport.w, state.viewport.h);
        const nebulae = scene?.primitives.filter((primitive): primitive is SceneBounds =>
          primitive.kind === 'bounds' && primitive.boundsKind === 'nebula' && boundsIntersectViewport(primitive),
        ) ?? [];
        const stationary = nebulae.filter((nebula) => !nebula.blink?.enabled);
        const blinking = nebulae.filter((nebula) => nebula.blink?.enabled);
        if (stationary.length > 0) {
          // Контур маски и обводка строятся одной и той же функцией.
          ctx.save();
          ctx.beginPath();
          for (const nebula of stationary) traceBounds(nebula);
          ctx.clip();
          field.renderField(fieldState);
          ctx.drawImage(fieldCanvas, 0, 0, state.viewport.w, state.viewport.h);
          ctx.restore();
        }
        for (const nebula of blinking) {
          const blink = nebula.blink!;
          ctx.save();
          ctx.beginPath();
          traceBounds(nebula);
          ctx.clip();
          field.renderField({ ...fieldState, cloudBrightness: nebulaBlinkIntensity(blink, frameTime) });
          ctx.drawImage(fieldCanvas, 0, 0, state.viewport.w, state.viewport.h);
          ctx.restore();
          if (blink.min !== blink.max) requestRender();
        }
      } else {
        drawSchematic(scene);
      }
    } else {
      drawSchematic(scene);
    }

    // Один звёздный слой поверх фона и облаков; размер точки не зависит от зума.
    drawStars();

    // Порядок слоёв: поле → звёзды → контуры сектора → сетка →
    // маркеры → подписи → апертуры.

    if (scene) renderScene(scene, frameTime);

    drawTravelRoute(frameTime);
    drawPointsOfInterest();
    drawPlanetFocus();
    if (scene) {
      drawSceneLabels(scene);
      drawApertures(scene);
    }

    kernel.coords.updateZoomReadout();
    kernel.coords.updateCoordinateReadout();
  }

  /* ------------------------------------------------------------------ события карты */

  const pointers: Record<string, MapPoint> = {};
  let pointerList: string[] = [];
  let drag: DragState | null = null;

  function localPoint(event: MouseEvent): MapPoint {
    var rect = mapCanvas().getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function hitTestPointOfInterest(screenX: number, screenY: number): PlaceRecord | null {
    var list = visiblePointsOfInterest();
    var best: PlaceRecord | null = null;
    var bestDistance = Infinity;
    // Хит-зона по тому же правилу, что у маркеров систем: `d + 6 px`,
    // на грубом указателе не меньше 44 px (§6.2 п. 5).
    var radius = hitRadiusFor(poiRadius() * 2, coarsePointer() ? 'touch' : 'mouse');
    for (var i = 0; i < list.length; i++) {
      var place = list[i]!; var point = toScreen(place.mapCoord!.x, place.mapCoord!.y);
      var dx = point.x - screenX;
      var dy = point.y - screenY;
      var distance = dx * dx + dy * dy;
      if (distance <= radius * radius && distance < bestDistance) {
        best = place;
        bestDistance = distance;
      }
    }
    return best;
  }

  function hitTest(screenX: number, screenY: number): SystemRecord | null {
    var best: SystemRecord | null = null;
    var bestDistance = Infinity;
    var list = state.systems;
    // Хит-зона считается от диаметра маркера на текущей глубине (d + 6 px,
    // на грубом указателе ≥ 44 px), а не от «мирового радиуса» (§6.2 п. 5).
    var baseRadius = markerHitRadius();
    var hoverBonus = 4;
    for (var i = 0; i < list.length; i++) {
      var system = list[i]!;
      if (!system.coord) continue;
      var point = toScreen(system.coord![0], system.coord![1]);
      var dx = point.x - screenX;
      var dy = point.y - screenY;
      var distance = dx * dx + dy * dy; // сравниваем квадраты, корень — только для ответа
      var radius = baseRadius + (state.hoverId === system.id ? hoverBonus : 0);
      if (distance <= radius * radius && distance < bestDistance) {
        best = system;
        bestDistance = distance;
      }
    }
    return best;
  }

  function onPointerDown(event: PointerEvent): void {
    // Карту тащат левой кнопкой и колесом. Правая (контекстное меню на холсте отключено) и
    // боковые карту не двигают и систему не выбирают; курсор перетаскивания на них не включается.
    if (event.button > 1) return;
    mapCanvas().setPointerCapture(event.pointerId);
    var point = localPoint(event);
    pointers[String(event.pointerId)] = point;
    pointerList = Object.keys(pointers);

    if (pointerList.length === 1) {
      drag = {
        mode: 'pan',
        startX: point.x, startY: point.y,
        tx: state.view.tx, ty: state.view.ty, moved: false, shiftKey: event.shiftKey,
        button: event.button
      };
      mapCanvas().classList.add('dragging');
    } else {
      kernel.coords.cancelPendingTravelTap();
      drag = null;
      animation = null;
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (pointers[String(event.pointerId)]) pointers[String(event.pointerId)] = localPoint(event);
    var point = localPoint(event);
    runtime.coordinatePointer = runtime.coordinateReadoutEnabled && event.pointerType !== 'touch' ? point : null;
    kernel.coords.updateCoordinateReadout();
    // Точка осмотра следует за мышью; сенсор её тапом (см. onPointerUp).
    if (event.pointerType !== 'touch') {
      var moved = inspectOf(state);
      Object.assign(moved, inspectOnPointer(moved, { kind: 'move', x: point.x, y: point.y, coarse: coarsePointer() }));
      if (moved.on) requestRender();
    }

    if (drag && drag.mode === 'pan' && pointerList.length === 1) {
      var dx = point.x - drag.startX;
      var dy = point.y - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      if (state.travel.enabled) {
        if (dx * dx + dy * dy <= 64) return;
        kernel.coords.cancelPendingTravelTap();
      }
      state.view.tx = drag.tx + dx;
      state.view.ty = drag.ty + dy;
      animation = null;
      clampView();
      requestRender();
      return;
    }

    if (pointerList.length === 2) {
      pinchUpdate();
      return;
    }

    // Наведение показывает карточку системы либо самостоятельной точки интереса.
    var hoveredPoi = hitTestPointOfInterest(point.x, point.y);
    var hovered = hoveredPoi ? null : hitTest(point.x, point.y);
    var poiId = hoveredPoi ? hoveredPoi.id : null;
    var hoverId = hovered ? hovered.id : null;
    var hoverChanged = poiId !== state.hoverPoiId || hoverId !== state.hoverId;
    if (hoverChanged) {
      state.hoverPoiId = poiId;
      state.hoverId = hoverId;
      mapCanvas().classList.toggle('marker-hover', !!(poiId || hoverId));
      if (!state.pinned) {
        state.activeSystemId = hoverId;
        state.activePlanetId = poiId;
        if (!state.travel.enabled) kernel.dossier.renderDetail();
      }
      requestRender();
    }
  }

  let pinch: PinchState | null = null;

  function pinchUpdate(): void {
    var ids = Object.keys(pointers);
    if (ids.length < 2) return;
    var a = pointers[ids[0]!]!;
    var b = pointers[ids[1]!]!;
    var distance = Math.hypot(a.x - b.x, a.y - b.y);
    var center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (!pinch) { pinch = { distance: distance, center: center }; return; }
    if (pinch.distance > 0) zoomAt(center.x, center.y, distance / pinch.distance);
    pinch.distance = distance;
    pinch.center = center;
  }

  function onPointerUp(event: PointerEvent): void {
    var point = pointers[String(event.pointerId)] || localPoint(event);
    delete pointers[String(event.pointerId)];
    pointerList = Object.keys(pointers);
    if (pointerList.length < 2) pinch = null;
    if (mapCanvas().hasPointerCapture && mapCanvas().hasPointerCapture(event.pointerId)) {
      mapCanvas().releasePointerCapture(event.pointerId);
    }
    mapCanvas().classList.remove('dragging');

    var finished = drag;
    drag = null;
    if (event.type === 'pointercancel') { kernel.coords.cancelPendingTravelTap(); return; }
    if (!finished) return;

    // Один поток pointer-событий обслуживает оба режима. Shift сохраняет копирование X/Y.
    if (finished.mode === 'pan' && finished.button === 0) {
      var tapDistance = Math.hypot(point.x - finished.startX, point.y - finished.startY);
      var shiftPressed = event.shiftKey || finished.shiftKey;
      if (tapDistance <= 8 && coarsePointer()) {
        // Тап на сенсоре переносит точку осмотра; остальная обработка тапа не меняется.
        var tapped = inspectOf(state);
        Object.assign(tapped, inspectOnPointer(tapped, { kind: 'tap', x: point.x, y: point.y, coarse: true }));
        if (tapped.on) requestRender();
      }
      if (state.travel.enabled && state.travel.freePointMode) {
        if (shiftPressed && tapDistance <= 3) {
          event.preventDefault();
          var occupiedBySystem = !!hitTest(point.x, point.y);
          var occupiedByPlace = !!hitTestPointOfInterest(point.x, point.y);
          if (occupiedBySystem || occupiedByPlace) {
            kernel.app.toast('Произвольную точку можно поставить только в пустом месте карты');
            return;
          }
          var freePointWorld = toWorld(point.x, point.y);
          if (!kernel.data.coordinateOnMap(freePointWorld)) {
            kernel.app.toast('Точка должна находиться в границах карты');
            return;
          }
          kernel.coords.scheduleFreeTravelPoint(freePointWorld, event.pointerType);
          return;
        }
        if (!shiftPressed && tapDistance <= 8) kernel.coords.setFreePointMode(false);
        return;
      }
      if (shiftPressed && tapDistance <= 3) {
        event.preventDefault();
        kernel.coords.copyMapCoordinates(point);
        return;
      }
      if (state.travel.enabled) {
        // Движение карты начинает работать немедленно; выбор отменяется при pan > 8 px.
        if (tapDistance <= 8 && !shiftPressed) {
          var routeSystem = hitTest(point.x, point.y);
          if (routeSystem) kernel.coords.scheduleTravelSystemAdd(routeSystem, event.pointerType);
        }
        return;
      }
      if (!finished.moved) {
        var placeHit = hitTestPointOfInterest(point.x, point.y);
        var hit = placeHit ? null : hitTest(point.x, point.y);
        if (placeHit) {
          kernel.dossier.selectPlanet(placeHit.id, { pin: true, center: false });
        } else if (hit) {
          kernel.dossier.selectSystem(hit.id, { pin: true, center: false });
        } else if (state.pinned) {
          kernel.dossier.clearDetail();
        }
      }
    }
  }

  function onWheel(event: WheelEvent): void {
    kernel.coords.cancelPendingTravelTap();
    event.preventDefault();
    animation = null;
    var point = localPoint(event);
    var factor = Math.exp(-event.deltaY * CONFIG.view.wheelStep);
    zoomAt(point.x, point.y, factor);
  }

  function onDoubleClick(event: MouseEvent): void {
    kernel.coords.cancelPendingTravelTap();
    var point = localPoint(event);
    zoomAt(point.x, point.y, 1.8);
  }

  function cancelAnimation(): void {
    animation = null;
  }

  function hasActivePointers(): boolean {
    return pointerList.length > 0;
  }

  function bindMapEvents(): void {
    const canvas = mapCanvas();
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('pointerleave', function () {
      runtime.coordinatePointer = null;
      kernel.coords.updateCoordinateReadout();
      var left = inspectOf(state);
      Object.assign(left, inspectOnPointer(left, { kind: 'leave' }));
      if (left.on) requestRender();
      if (!drag && (state.hoverId || state.hoverPoiId)) {
        state.hoverId = null;
        state.hoverPoiId = null;
        canvas.classList.remove('marker-hover');
        if (!state.pinned) {
          state.activeSystemId = null;
          state.activePlanetId = null;
          if (!state.travel.enabled) kernel.dossier.renderDetail();
        }
        requestRender();
      }
    });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  }
  return {
    fitScale,
    minScale,
    maxScale,
    fitView,
    clampView,
    toScreen,
    toWorld,
    zoomAt,
    centerOn,
    cancelAnimation,
    requestRender,
    visibleSystems,
    visiblePointsOfInterest,
    hasActivePointers,
    bindMapEvents,
    setFlightDim,
  };
}
