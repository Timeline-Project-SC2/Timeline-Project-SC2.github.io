/* Map Atlas — камера, canvas-рендер карты и pointer-взаимодействие. */

import {
  CONFIG,
  clamp,
  easeOutCubic,
  normalize,
  parseHexColor,
  rng,
} from './config.ts';
import type {
  AtlasKernel,
  AtlasView,
  CanvasRendererApi,
  MapPoint,
  PlaceRecord,
  SystemRecord,
} from './config.ts';
import { layerFillAlpha, layerLineAlpha, markerDiameter, maxScaleForTargetWidth } from './level-ladder.ts';
import type { LabelItem, LabelLayoutResult, LabelMetrics, LabelRect } from './label-layout.ts';
import { LABEL_BUDGET, layoutLabels } from './label-layout.ts';
import type {
  Bubble,
  BubbleNode,
  FactionNet,
  Flare,
  MergedField,
  NetChannel,
  NetPoint,
  NetSystemInput,
} from './faction-net.ts';
import {
  CHANNEL_BRIGHTNESS,
  CHANNEL_STROKE_PX,
  CONTROL_FIELD_SIDE_RATIO,
  MAX_CHANNELS_PER_FRAME,
  MAX_FLARES_PER_NET,
  bubbleFor,
  channelsFor,
  flarePulse,
  flarePulseSeed,
  flaresFor,
  isNetLayerLevel,
  mergedFields,
  parseNetworks,
  sampleGradient,
} from './faction-net.ts';
import type {
  SceneAperture,
  SceneCamera,
  SceneGridLabel,
  SceneGridLine,
  SceneMarker,
  SceneSystemInput,
  SceneTerritory,
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

/** Альфа заливки бабла на `L2`; глубже множится на `layerFillAlpha(level)` (С8). */
export const BUBBLE_FILL_ALPHA = 0.55;

/** Альфа «поля контроля» (квадрат под узлом); множится на `layerLineAlpha` (С11). */
export const CONTROL_FIELD_ALPHA = 0.22;

/** Ядро плазменного сгустка «всполоха», экранные px (дельта 5, П1.2). */
export const FLARE_CORE_PX = 2;

/** Гало сгустка: толщина линии-ореола, px. */
export const FLARE_HALO_PX = 5.5;

/** Альфа гало сгустка до умножения на `intensity` и ритм `flarePulse`. */
export const FLARE_HALO_ALPHA = 0.32;

/** Ветвей шлейфа у одного сгустка (по одной на каждую сторону). */
export const FLARE_BRANCHES = 2;

/** Полуугол ветви от древка, рад. */
export const FLARE_BRANCH_ANGLE = 0.35;

/** Доля длины древка, на которой ветвится шлейф. */
export const FLARE_BRANCH_AT = 0.55;

/** Длина ветви как доля длины древка. */
export const FLARE_BRANCH_LEN = 0.4;

/** Вспышка на конце сгустка, px: радиус `clamp(FLARE_HEAD_PX · scale, 1,5, 3)`. */
export const FLARE_HEAD_PX = 2.4;

interface ViewAnimation {
  from: AtlasView;
  to: AtlasView;
  start: number;
}

interface SchematicStar {
  x: number;
  y: number;
  r: number;
  a: number;
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

  let starCache: SchematicStar[] | null = null;

  function stars(): SchematicStar[] {
    if (starCache) return starCache;
    var random = rng(100000);
    var size = kernel.data.mapSize();
    starCache = [];
    for (var i = 0; i < 900; i++) {
      starCache.push({
        x: random() * size,
        y: random() * size,
        r: 0.4 + random() * 1.5,
        a: 0.12 + random() * 0.5
      });
    }
    return starCache;
  }

  function drawSchematic(): void {
    const ctx = kernel.ctx!;
    var size = kernel.data.mapSize();
    var view = state.view;
    var scale = view.scale;

    ctx.save();
    ctx.fillStyle = '#03060c';
    ctx.fillRect(0, 0, state.viewport.w, state.viewport.h);

    // мягкие «облака» сектора, чтобы схема не выглядела пустой
    var clouds = [
      { x: 0.36, y: 0.30, r: 0.26, color: 'rgba(80,120,190,.16)' },
      { x: 0.62, y: 0.58, r: 0.30, color: 'rgba(180,120,60,.12)' },
      { x: 0.78, y: 0.30, r: 0.22, color: 'rgba(120,90,200,.10)' }
    ];
    clouds.forEach(function (cloud) {
      var center = toScreen(cloud.x * size, cloud.y * size);
      var radius = cloud.r * size * scale;
      if (radius < 12) return;
      var gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      gradient.addColorStop(0, cloud.color);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(center.x - radius, center.y - radius, radius * 2, radius * 2);
    });

    // звёздное поле
    var list = stars();
    for (var i = 0; i < list.length; i++) {
      var star = list[i]!;
      var point = toScreen(star.x, star.y);
      if (point.x < -4 || point.y < -4 || point.x > state.viewport.w + 4 || point.y > state.viewport.h + 4) continue;
      ctx.globalAlpha = star.a;
      ctx.fillStyle = '#cfe0f5';
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(0.5, star.r), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

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

  function drawTerritory(territory: SceneTerritory): void {
    const ctx = kernel.ctx!;
    var radius = territory.screenRadius;
    if (!(radius > 2)) return;
    // Без таблицы цветов слой не рисуется — резолвер приходит из `data-loader`,
    // в стабах тестов его нет. У слоя сетей такой же гейт стоит в `drawNetLayer`.
    if (typeof kernel.data.factionColor !== 'function') return;
    // Цвет — данные таблицы фракций, а не оттенок от имени: на табличный цвет
    // накладывается только альфа радиального спада, сам цвет не изменяется.
    var rgb = parseHexColor(kernel.data.factionColor(territory.faction));
    if (!rgb) return;
    var channels = rgb[0] + ', ' + rgb[1] + ', ' + rgb[2];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    try {
      var gradient = ctx.createRadialGradient(
        territory.x, territory.y, Math.min(radius * 0.12, 18),
        territory.x, territory.y, radius,
      );
      gradient.addColorStop(0, 'rgba(' + channels + ', .16)');
      gradient.addColorStop(0.65, 'rgba(' + channels + ', .07)');
      gradient.addColorStop(1, 'rgba(' + channels + ', 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(territory.x, territory.y, radius, 0, Math.PI * 2);
      ctx.fill();
    } catch (err) {
      // Контекст-заглушка без градиентов: мягкое поле просто не рисуется.
    }
    ctx.restore();
  }

  function drawGridLine(line: SceneGridLine): void {
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.strokeStyle = 'rgba(150,180,215,.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(line.x1) + 0.5, Math.round(line.y1) + 0.5);
    ctx.lineTo(Math.round(line.x2) + 0.5, Math.round(line.y2) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function drawGridLabel(label: SceneGridLabel): void {
    const ctx = kernel.ctx!;
    ctx.save();
    ctx.font = '9px ' + theme.mono;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
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
    ctx.font = '10px ' + theme.mono;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(226,196,130,.75)';
    ctx.fillText(aperture.hint, aperture.x, Math.min(state.viewport.h - 16, aperture.y + radius + 6));
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

  /* --------------------------------------------- слой сетей: баблы (Z-3.9) */

  /*
   * Слой сетей в кадре (карточка `Z-3.9`, редакция 2 + дельта 3): геометрия
   * считается в `faction-net.ts` (`mergedFields`, `bubbleFor`, `channelsFor`,
   * `flaresFor`), рендерер её только рисует.
   *
   * Порядок сверху вниз по z закреплён карточкой (С6 + Д-1 + Д-3) — ровно так:
   *
   *   territory → заливка бабла → контур бабла → поле контроля (квадраты)
   *   → белые кольца узлов → всполохи → каналы → сетка → лупа → маркеры → подписи
   *
   * Ленты `bridgesBetween` не рисуются (С13): канал — тонкая изогнутая линия, а
   * `bridgesBetween` остаётся только поставщиком геометрии для `flaresFor`.
   * Владелец: каналы идут ПОВЕРХ баблов и стрелок.
   *
   * Данные — та же сборка, что у каналов (`netChannelInputs()`), второго способа
   * собирать системы нет: сети (`parseNetworks`), баблы (`bubbleFor`: стопы
   * градиента, узлы, лепестки) и слитые контуры (`mergedFields`) кэшируются по
   * ссылке `state.systems`, пересчёт — только при подмене набора данных.
   */
  let netLayerSource: SystemRecord[] | null = null;
  let netLayerNets: readonly FactionNet[] = [];
  let netLayerBubbles: readonly Bubble[] = [];
  let netLayerFields: readonly MergedField[] = [];

  /** Сети, баблы и слитые поля: `parseNetworks(netChannelInputs())`, кэш по `state.systems`. */
  function refreshNetLayer(): void {
    if (netLayerSource === state.systems) return;
    netLayerSource = state.systems;
    netLayerNets = [];
    netLayerBubbles = [];
    netLayerFields = [];
    try {
      var nets = parseNetworks(netChannelInputs());
      var bubbles: Bubble[] = [];
      for (var index = 0; index < nets.length; index += 1) {
        var net = nets[index]!;
        bubbles.push(bubbleFor(net.members, {
          netId: net.netId,
          // Цвет — таблица `data/factions.csv`: оттенок из имени не вычисляется.
          factionColor: function (faction) { return kernel.data.factionColor(faction); },
        }));
      }
      netLayerNets = nets;
      netLayerBubbles = bubbles;
      // Одно общее поле вместо по-сетевых: близкие сети слипаются, далёкие — нет.
      netLayerFields = mergedFields(nets);
    } catch (err) {
      // Битые данные сети: карта остаётся живой, но причина видна в консоли
      // вместе с именем системы из сообщения `RangeError`.
      console.error('Слой сетей: баблы не построены — '
        + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Табличный цвет фракции в синтаксис canvas (резолвер загрузчика). */
  function factionColorOf(faction: string | null): string {
    return kernel.data.factionColor(faction);
  }

  /** Число пути: два знака, без хвостовых нулей и без `-0`. */
  function coordText(value: number): string {
    var rounded = Math.round(value * 100) / 100;
    var fixed = (rounded === 0 ? 0 : rounded).toFixed(2);
    if (fixed.endsWith('.00')) return fixed.slice(0, -3);
    if (fixed.endsWith('0')) return fixed.slice(0, -1);
    return fixed;
  }

  /**
   * Контуры слитого поля в экранных координатах. Масштаб — полная ширина кадра
   * (`viewport.w / visibleWidth`), тот же, что у `worldToScreen` сцены, маркеров
   * и территорий: бабл не съезжает относительно систем своего кадра.
   */
  function mergedScreenPath(rings: readonly (readonly NetPoint[])[]): string {
    var cam = sceneCamera();
    var scale = state.viewport.w / cam.visibleWidth;
    var halfWidth = state.viewport.w / 2;
    var halfHeight = state.viewport.h / 2;
    var parts: string[] = [];
    for (var ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
      var ring = rings[ringIndex]!;
      if (ring.length < 3) continue;
      var commands: string[] = [];
      for (var index = 0; index < ring.length; index += 1) {
        var point = ring[index]!;
        var screenX = halfWidth + (point.x - cam.centerX) * scale;
        var screenY = halfHeight + (point.y - cam.centerY) * scale;
        commands.push((index === 0 ? 'M' : 'L') + coordText(screenX) + ' ' + coordText(screenY));
      }
      parts.push(commands.join('') + 'Z');
    }
    return parts.join(' ');
  }

  /** Дальняя точка габаритов бабла от центра сети: конец градиента заливки. */
  function gradientTipOf(bubble: Bubble): NetPoint {
    var bounds = bubble.bounds;
    var corners = [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ];
    var best = corners[0]!;
    var bestDistance = -1;
    for (var index = 0; index < corners.length; index += 1) {
      var corner = corners[index]!;
      var distance = Math.hypot(corner.x - bubble.centerX, corner.y - bubble.centerY);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = corner;
      }
    }
    return best;
  }

  /** Цвет из кортежа `sampleGradient` в синтаксис canvas. */
  function rgbText(rgb: readonly [number, number, number]): string {
    return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
  }

  /**
   * Заливка бабла (С8 + Д3.1): путь из `mergedFields`, цвет — стопы `colorStops`
   * через `sampleGradient` от центра сети (`t = 0`) к дальней точке габаритов
   * (`t = 1`), альфа `BUBBLE_FILL_ALPHA · layerFillAlpha(level)`.
   */
  function drawNetBubbleFill(field: MergedField, bubble: Bubble, net: FactionNet, level: number): void {
    const ctx = kernel.ctx!;
    var path = mergedScreenPath(field.rings);
    // Тестовый контекст-заглушка: в Node нет `Path2D` — бабл просто не рисуется.
    if (path.length === 0 || typeof Path2D === 'undefined') return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = BUBBLE_FILL_ALPHA * layerFillAlpha(level);
    try {
      var shape = new Path2D(path);
      var stops = bubble.stops;
      if (stops.length < 2) {
        // Меньше двух стопов — заливка одним цветом первой фракции сети.
        var faction = net.factions.length > 0 ? net.factions[0]! : null;
        ctx.fillStyle = stops.length > 0 ? stops[0]!.color : factionColorOf(faction);
      } else {
        var center = toScreen(bubble.centerX, bubble.centerY);
        var tip = gradientTipOf(bubble);
        var tipPoint = toScreen(tip.x, tip.y);
        var gradient = ctx.createLinearGradient(center.x, center.y, tipPoint.x, tipPoint.y);
        gradient.addColorStop(0, rgbText(sampleGradient(stops, 0)));
        gradient.addColorStop(1, rgbText(sampleGradient(stops, 1)));
        ctx.fillStyle = gradient;
      }
      ctx.fill(shape);
    } catch (err) {
      // Контекст-заглушка без `Path2D`/градиентов (тесты): заливка не рисуется.
    } finally {
      ctx.restore();
    }
  }

  /** Контур бабла (С7 + Д3.2): цвет фракции в полную силу, толщина в клампе `1…2`. */
  function drawNetBubbleOutline(field: MergedField, net: FactionNet, level: number): void {
    const ctx = kernel.ctx!;
    var path = mergedScreenPath(field.rings);
    if (path.length === 0 || typeof Path2D === 'undefined') return;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = layerLineAlpha(level);
    ctx.strokeStyle = factionColorOf(net.factions.length > 0 ? net.factions[0]! : null);
    ctx.lineWidth = clamp(1.6 * state.view.scale, 1, 2);
    try {
      ctx.stroke(new Path2D(path));
    } catch (err) {
      // Контекст-заглушка без `Path2D`: контур не рисуется.
    } finally {
      ctx.restore();
    }
  }

  /** Фракция системы внутри сети: лепесток бабла знает её, узел — нет. */
  function petalFactionOf(bubble: Bubble, systemId: string): string | null {
    for (var index = 0; index < bubble.petals.length; index += 1) {
      var petal = bubble.petals[index]!;
      if (petal.systemId === systemId) return petal.faction;
    }
    return null;
  }

  /**
   * Поле контроля (С11, Д3.4): осевой квадрат со стороной
   * `CONTROL_FIELD_SIDE_RATIO · r` цветом фракции, альфа
   * `CONTROL_FIELD_ALPHA · layerLineAlpha`, без обводки. Рисуется под узлами —
   * отдельным проходом, чтобы квадраты не перекрывали чужие узлы.
   */
  function drawNetControlField(node: BubbleNode, bubble: Bubble, level: number): void {
    const ctx = kernel.ctx!;
    var radius = node.radius * state.view.scale;
    if (!(radius >= 1.5)) return;
    var point = toScreen(node.x, node.y);
    var side = CONTROL_FIELD_SIDE_RATIO * radius;
    var half = side / 2;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = CONTROL_FIELD_ALPHA * layerLineAlpha(level);
    ctx.fillStyle = factionColorOf(petalFactionOf(bubble, node.systemId));
    ctx.fillRect(point.x - half, point.y - half, side, side);
    ctx.restore();
  }

  /**
   * Узел (С10, Д3.3): заливка табличным цветом фракции в полную силу (без
   * приглушения — тип системы виден по радиусу) и белое кольцо `0,95`.
   */
  function drawNetNode(node: BubbleNode, bubble: Bubble): void {
    const ctx = kernel.ctx!;
    var radius = node.radius * state.view.scale;
    if (!(radius >= 1.5)) return;
    var point = toScreen(node.x, node.y);

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = factionColorOf(petalFactionOf(bubble, node.systemId));
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = clamp(2.2 * state.view.scale, 1.4, 3);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Соперники сети — только из данных (С14, Д2.3): все `netId` из результата
   * `channelsFor`, кроме самой сети, по возрастанию. Нет пар в
   * `net_confront_id` — нет и стрелок.
   */
  function dataRivalsOf(net: FactionNet, channels: readonly NetChannel[]): FactionNet[] {
    var ids: number[] = [];
    for (var index = 0; index < channels.length; index += 1) {
      var channel = channels[index]!;
      var other: number | null = null;
      if (channel.from.netId === net.netId) other = channel.to.netId;
      else if (channel.to.netId === net.netId) other = channel.from.netId;
      if (other === null || other === net.netId) continue;
      if (ids.indexOf(other) < 0) ids.push(other);
    }
    ids.sort(function (a, b) { return a - b; });

    var rivals: FactionNet[] = [];
    for (var idIndex = 0; idIndex < ids.length; idIndex += 1) {
      for (var netIndex = 0; netIndex < netLayerNets.length; netIndex += 1) {
        if (netLayerNets[netIndex]!.netId === ids[idIndex]) rivals.push(netLayerNets[netIndex]!);
      }
    }
    return rivals;
  }

  /**
   * Начало стрелки: край поля контроля своей системы по направлению выстрела,
   * а если узел не найден — край контура своего бабла (`originX`, `originY`).
   */
  function flareStart(
    flare: Flare,
    bubble: Bubble,
    dirX: number,
    dirY: number,
  ): MapPoint {
    var best: BubbleNode | null = null;
    var bestDistance = Number.POSITIVE_INFINITY;
    for (var index = 0; index < bubble.nodes.length; index += 1) {
      var node = bubble.nodes[index]!;
      var distance = Math.hypot(node.x - flare.originX, node.y - flare.originY);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    if (best === null) return toScreen(flare.originX, flare.originY);

    var centre = toScreen(best.x, best.y);
    var half = CONTROL_FIELD_SIDE_RATIO * best.radius * state.view.scale / 2;
    // Точка на стороне осевого квадрата вдоль направления луча.
    var reach = Math.max(Math.abs(dirX), Math.abs(dirY));
    if (!(reach > 1e-6) || !(half > 0)) return centre;
    var step = half / reach;
    return { x: centre.x + dirX * step, y: centre.y + dirY * step };
  }

  /**
   * «Всполох» — плазменный сгусток (дельта 5, П1.3), а не стрелка: гало, две
   * ветви шлейфа, белое ядро и вспышка на конце. Никакого `Math.random`: ритм
   * берётся из `flarePulse(nowMs, seed)` — `nowMs` того же кадра, которым
   * рисуется сцена, `seed` — из детерминированного хеша пары сетей.
   *
   * Порядок внутри одного `save()/restore()`:
   *   a) гало (lighter) → b) ветви (source-over) → c) ядро (lighter) → d) вспышка (lighter).
   */
  function drawNetFlare(
    flare: Flare,
    net: FactionNet,
    bubble: Bubble | null,
    level: number,
    nowMs: number,
  ): void {
    const ctx = kernel.ctx!;
    var intensity = flare.intensity;
    if (!(intensity > 0)) return;
    var pulse = flarePulse(nowMs, flarePulseSeed(flare.netId, flare.targetNetId));
    var length = clamp(flare.length * state.view.scale, 20, 84);
    if (!(length > 0)) return;

    var dirX = Math.cos(flare.angle);
    var dirY = Math.sin(flare.angle);
    var start = bubble === null
      ? toScreen(flare.originX, flare.originY)
      : flareStart(flare, bubble, dirX, dirY);
    var tipX = start.x + dirX * length;
    var tipY = start.y + dirY * length;
    var color = factionColorOf(net.factions.length > 0 ? net.factions[0]! : null);
    // Множитель слоя на уровне — общий для всех четырёх частей сгустка.
    var layer = layerLineAlpha(level);

    ctx.save();
    ctx.lineCap = 'round';

    // a) гало: широкий мягкий ореол своего цвета фракции.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = FLARE_HALO_ALPHA * intensity * pulse * layer;
    ctx.strokeStyle = color;
    ctx.lineWidth = FLARE_HALO_PX;
    ctx.shadowBlur = 10;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // b) шлейф: две ветви от точки `FLARE_BRANCH_AT · L` под ±FLARE_BRANCH_ANGLE.
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.5 * intensity * pulse * layer;
    ctx.lineWidth = 1.2;
    ctx.shadowBlur = 0;
    var branchX = start.x + dirX * FLARE_BRANCH_AT * length;
    var branchY = start.y + dirY * FLARE_BRANCH_AT * length;
    var branch = FLARE_BRANCH_LEN * length;
    ctx.beginPath();
    for (var side = 0; side < FLARE_BRANCHES; side += 1) {
      var angle = flare.angle + (side === 0 ? -FLARE_BRANCH_ANGLE : FLARE_BRANCH_ANGLE);
      ctx.moveTo(branchX, branchY);
      ctx.lineTo(branchX + Math.cos(angle) * branch, branchY + Math.sin(angle) * branch);
    }
    ctx.stroke();

    // c) ядро: та же линия, но белая и тонкая.
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85 * intensity * pulse * layer;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = FLARE_CORE_PX;
    ctx.shadowBlur = 6;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // d) вспышка на конце сгустка.
    ctx.globalAlpha = 0.8 * pulse * layer;
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(tipX, tipY, clamp(FLARE_HEAD_PX * state.view.scale, 1.5, 3), 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * Сгустки всех сетей: соперники берутся из данных (`net_confront_id`), а не из
   * близости. Число сгустков — сколько вернул `flaresFor`: лимиты
   * `MAX_FLARES_PER_RIVAL` / `MAX_FLARES_PER_NET` не меняются.
   */
  function drawNetFlares(level: number, nowMs: number): void {
    if (!(layerLineAlpha(level) > 0)) return;
    var channels = netChannels();
    if (channels.length === 0) return;
    for (var index = 0; index < netLayerNets.length; index += 1) {
      var net = netLayerNets[index]!;
      var rivals = dataRivalsOf(net, channels);
      if (rivals.length === 0) continue;
      var flares = flaresFor(net, rivals, { limit: MAX_FLARES_PER_NET, fromData: true });
      var bubble = netLayerBubbles[index] ?? null;
      for (var flareIndex = 0; flareIndex < flares.length; flareIndex += 1) {
        drawNetFlare(flares[flareIndex]!, net, bubble, level, nowMs);
      }
    }
  }

  /**
   * Слой сетей в кадре. Два гейта на входе: уровень (`isNetLayerLevel`, общий с
   * каналами) и резолвер табличного цвета. Без таблицы `data/factions.csv` слой
   * не рисуется вовсе — резолвер приходит из `data-loader`, в стабах тестов его
   * нет, и проверка здесь одна на заливку, контур, узлы, поле и сгустки.
   * `nowMs` — время того же кадра, которым рисуется сцена (нужно ритму сгустков).
   */
  function drawNetLayer(level: number, nowMs: number): void {
    if (!isNetLayerLevel(level)) return;
    if (typeof kernel.data.factionColor !== 'function') return;
    refreshNetLayer();
    var drawn = Math.min(netLayerFields.length, netLayerBubbles.length);
    var index: number;
    for (index = 0; index < drawn; index += 1) {
      drawNetBubbleFill(netLayerFields[index]!, netLayerBubbles[index]!, netLayerNets[index]!, level);
    }
    for (index = 0; index < drawn; index += 1) {
      drawNetBubbleOutline(netLayerFields[index]!, netLayerNets[index]!, level);
    }
    // Поле контроля — отдельным проходом под всеми узлами (С6), затем узлы.
    var index2: number;
    for (index2 = 0; index2 < drawn; index2 += 1) {
      var fieldBubble = netLayerBubbles[index2]!;
      for (var squareIndex = 0; squareIndex < fieldBubble.nodes.length; squareIndex += 1) {
        drawNetControlField(fieldBubble.nodes[squareIndex]!, fieldBubble, level);
      }
    }
    for (index = 0; index < drawn; index += 1) {
      var bubble = netLayerBubbles[index]!;
      for (var nodeIndex = 0; nodeIndex < bubble.nodes.length; nodeIndex += 1) {
        drawNetNode(bubble.nodes[nodeIndex]!, bubble);
      }
    }
    drawNetFlares(level, nowMs);
  }

  /* ------------------------------------------------------------ каналы сетей (Z-3.8) */

  /*
   * Каналы между сетями (`net_confront_id`, карточка `Z-3.8`) — отдельный проход
   * ПОСЛЕ баблов, узлов и «всполохов»: линия идёт поверх заливки баблов и сквозь
   * них, поэтому проход не обрезается по контурам и рисуется `source-over`.
   * `Z-3.9` (С12, С13): канал — тонкая изогнутая линия `CHANNEL_STROKE_PX` по
   * `curve` из `channelsFor`, а не залитая лента; `width`/`quad` оставлены ради
   * совместимости и старых тестов. Мировая геометрия от камеры не зависит,
   * поэтому каналы считаются один раз на набор данных, а в кадре
   * пересчитываются только экранные точки.
   *
   * Колонки слоя сетей приходят из `data/systems.csv` через загрузчик: у каждой
   * записи есть `net_id` (`number | null`) и `net_confront_id` (`string | null`),
   * пустая ячейка — `null`.
   */
  let netChannelSource: SystemRecord[] | null = null;
  let netChannelList: readonly NetChannel[] = [];
  // Сколько лент было в последний раз, когда бюджет кадра не вместил их все:
  // предупреждение печатается один раз на количество, а не каждый кадр.
  let netChannelOverflow = 0;

  /** Колонка слоя сетей из записи: `unknown` загрузчика приводится к тексту. */
  function netColumn(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
  }

  function netChannelInputs(): NetSystemInput[] {
    var list = state.systems;
    var input: NetSystemInput[] = [];
    for (var index = 0; index < list.length; index += 1) {
      var system = list[index]!;
      var coord = system.coord;
      input.push({
        id: system.id,
        name: system.name,
        x: coord ? coord[0] : null,
        y: coord ? coord[1] : null,
        faction: system.primaryFaction ?? null,
        type: system.systemType ?? null,
        net_id: netColumn(system.net_id),
        net_confront_id: netColumn(system.net_confront_id),
      });
    }
    return input;
  }

  function netChannels(): readonly NetChannel[] {
    if (netChannelSource === state.systems) return netChannelList;
    netChannelSource = state.systems;
    try {
      var result = channelsFor(netChannelInputs(), {
        // Цвет — таблица `data/factions.csv`: оттенок из имени не вычисляется.
        factionColor: function (faction) { return kernel.data.factionColor(faction); },
      });
      netChannelList = result.channels;
      // Замкнутое кольцо каналов — не ошибка сборки: предупреждение видно в консоли.
      for (var index = 0; index < result.warnings.length; index += 1) {
        console.warn('Слой сетей: ' + result.warnings[index]!.message);
      }
    } catch (err) {
      // Битая ячейка `net_confront_id`: карта остаётся живой, но ошибка не
      // глотается — имя системы и причина печатаются из сообщения `RangeError`.
      netChannelList = [];
      console.error('Слой сетей: каналы не построены — '
        + (err instanceof Error ? err.message : String(err)));
    }
    return netChannelList;
  }

  /** Один канал: квадратичная кривая с градиентом табличных цветов двух концов. */
  function drawNetChannel(channel: NetChannel): void {
    const ctx = kernel.ctx!;
    var stops = channel.stops;
    // Без резолвера табличного цвета градиента нет: линия не рисуется вовсе.
    if (stops.length < 2) return;
    var start = toScreen(channel.curve[0].x, channel.curve[0].y);
    var control = toScreen(channel.curve[1].x, channel.curve[1].y);
    var finish = toScreen(channel.curve[2].x, channel.curve[2].y);
    if (!(Math.hypot(finish.x - start.x, finish.y - start.y) > 0.5)) return;

    ctx.save();
    // Проход поверх баблов: без обрезки по контурам и без сложения света.
    ctx.globalCompositeOperation = 'source-over';
    // Яркость одна на все каналы: ни номер канала, ни расстояние на неё не влияют.
    ctx.globalAlpha = CHANNEL_BRIGHTNESS;
    ctx.lineWidth = CHANNEL_STROKE_PX;
    ctx.lineCap = 'round';
    try {
      var gradient = ctx.createLinearGradient(start.x, start.y, finish.x, finish.y);
      gradient.addColorStop(0, stops[0]!.color);
      gradient.addColorStop(1, stops[stops.length - 1]!.color);
      ctx.strokeStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.quadraticCurveTo(control.x, control.y, finish.x, finish.y);
      ctx.stroke();
    } catch (err) {
      // Контекст-заглушка без градиентов (тесты): линия просто не рисуется.
    } finally {
      ctx.restore();
    }
  }

  /** Каналы живут на уровнях слоя сетей (`L2…L9`) — тот же диапазон, что баблы. */
  function drawNetChannels(level: number): void {
    if (!isNetLayerLevel(level)) return;
    var channels = netChannels();
    // Бюджет кадра: геометрия считается целиком, а рисуется не больше
    // `MAX_CHANNELS_PER_FRAME` каналов — кадр не должен стоить дороже разметки.
    var drawn = channels.length < MAX_CHANNELS_PER_FRAME ? channels.length : MAX_CHANNELS_PER_FRAME;
    if (channels.length > drawn && netChannelOverflow !== channels.length) {
      netChannelOverflow = channels.length;
      console.warn('Слой сетей: каналов ' + channels.length + ' — в кадр рисуется не больше '
        + MAX_CHANNELS_PER_FRAME + ', остальные ленты пропущены.');
    }
    for (var index = 0; index < drawn; index += 1) {
      drawNetChannel(channels[index]!);
    }
  }

  function renderScene(scene: SectorScene, nowMs: number): void {
    // Порядок отрисовки сверху вниз по z закреплён карточкой `Z-3.9` (С6) — ровно так:
    //   territory → заливка бабла → контур бабла → поле контроля (квадраты)
    //   → белые кольца узлов → всполохи → каналы → сетка → лупа → маркеры → подписи.
    for (var index = 0; index < scene.primitives.length; index += 1) {
      var primitive = scene.primitives[index]!;
      if (primitive.kind === 'territory') drawTerritory(primitive);
    }
    // Баблы: заливка → контур → квадраты и узлы → сгустки (порядок внутри `drawNetLayer`).
    drawNetLayer(scene.level, nowMs);
    // Отдельный проход каналов: ленты идут поверх заливки баблов, но под адресной
    // сеткой и маркерами, поэтому стоят между двумя проходами примитивов сцены.
    drawNetChannels(scene.level);
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
    if (running || kernel.coords.isTravelAnimationActive()) requestRender();

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.viewport.w, state.viewport.h);

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
      field.renderField({
        view: state.view,
        viewport: state.viewport,
        dpr: state.dpr,
        mapSize: kernel.data.mapSize(),
      });
      if (fieldCanvas.width > 0 && fieldCanvas.height > 0) {
        ctx.imageSmoothingEnabled = true;
        if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(fieldCanvas, 0, 0, state.viewport.w, state.viewport.h);
      } else {
        drawSchematic();
      }
    } else {
      drawSchematic();
    }

    // Порядок слоёв §8.1: поле → территории → сетка адресов → маркеры →
    // подписи → апертуры. Сцена пересобирается в каждом кадре, поэтому зум, пан,
    // ресайз и смена фильтра подхватываются через `requestRender()` без
    // отдельного кеша и без новых слушателей.
    const scene = buildScene();
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
