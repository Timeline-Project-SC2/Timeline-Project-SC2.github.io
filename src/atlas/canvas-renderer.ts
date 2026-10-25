/* Map Atlas — камера, canvas-рендер карты и pointer-взаимодействие. */

import {
  CONFIG,
  clamp,
  easeOutCubic,
  normalize,
  rng,
} from './config.ts';
import type {
  AtlasKernel,
  AtlasView,
  CanvasRendererApi,
  MapLabel,
  MapPoint,
  PlaceRecord,
  SystemRecord,
} from './config.ts';
import { maxScaleForTargetEdge } from './level-ladder.ts';

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

interface LabelCandidate {
  label: MapLabel;
  point: MapPoint;
  rank: number;
  distance: number;
}

interface MarkerMetrics {
  radius: number;
  fontSize: number;
  stroke: number;
  dot: number;
  gap: number;
  crossGap: number;
  crossLength: number;
  reviewDot: number;
  hitRadius: number;
}

interface MarkerLabelCandidate {
  system: SystemRecord;
  point: MapPoint;
  radius: number;
  color: string;
  hover: boolean;
  active: boolean;
  verified: boolean;
  fromLabel: boolean;
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
    return maxScaleForTargetEdge(state.viewport, kernel.data.mapSize(), CONFIG.view.fitInset);
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

    var offset = toScreen(0, 0);
    var span = size * scale;

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

    // сетка навигации
    var step = 1000;
    if (scale * step < 46) step = 2000;
    if (scale * step < 46) step = 5000;
    ctx.strokeStyle = 'rgba(150,180,215,.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0; x <= size; x += step) {
      var sx = Math.round(offset.x + x * scale) + 0.5;
      ctx.moveTo(sx, offset.y);
      ctx.lineTo(sx, offset.y + span);
    }
    for (var y = 0; y <= size; y += step) {
      var sy = Math.round(offset.y + y * scale) + 0.5;
      ctx.moveTo(offset.x, sy);
      ctx.lineTo(offset.x + span, sy);
    }
    ctx.stroke();

    // координатные отметки
    ctx.fillStyle = 'rgba(190,212,240,.55)';
    ctx.font = '9px ' + theme.mono;
    if (scale > 0.09) {
      for (var gx = 0; gx <= size; gx += 2000) {
        var px = offset.x + gx * scale;
        ctx.fillText(String(gx), px + 3, offset.y + span - 4);
        ctx.fillText(String(gx), offset.x + 3, offset.y + gx * scale + 10);
      }
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------------ слой подписей карты */

  function drawMapLabels(): number | undefined {
    const ctx = kernel.ctx!;
    var labels = state.labels;
    if (!state.labelsOn || !labels || !labels.length) return;
    var scale = state.view.scale;
    if (scale < CONFIG.layers.labelScale) return;
    var fontSize = clamp(28 * scale, 8.5, 38);
    var glyph = clamp(11 * scale, 3, 13);
    var textGap = clamp(18 * scale, 6, 20);
    var collisionRadius = clamp(30 * scale, 9, 34);

    // Точки, где уже стоит маркер системы: он подписан своим именем, поэтому
    // одноимённая подпись из слоя карты была бы дублем.
    var markerPoints: Record<string, boolean> = {};
    visibleSystems().forEach(function (system) {
      markerPoints[Math.round(system.coord![0] / 8) + ':' + Math.round(system.coord![1] / 8)] = true;
    });
    visiblePointsOfInterest().forEach(function (place) {
      markerPoints[Math.round(place.mapCoord!.x / 8) + ':' + Math.round(place.mapCoord!.y / 8)] = true;
    });

    var budget = CONFIG.layers.labelBudget;
    var drawn = 0;
    var seen: Record<string, boolean> = {};
    var centerX = state.viewport.w / 2;
    var centerY = state.viewport.h / 2;
    var placed: MapPoint[] = [];

    // отбираем видимые подписи; приоритет — записи со связью в каталоге,
    // затем близость к центру экрана, чтобы бюджет доставался главному
    function labelRank(label: MapLabel): number {
      if (label.linkedSystemId) return 0;
      if (label.linkedPlanetId) return 1;
      if (label.kind === 'system') return 2;
      if (label.kind === 'planet') return 3;
      return 4;
    }

    var candidates: LabelCandidate[] = [];
    for (var c = 0; c < labels.length; c++) {
      var candidate = labels[c]!;
      if (candidate.noisy && scale < CONFIG.layers.noisyLabelScale) continue;
      var candidatePoint = toScreen(candidate.x, candidate.y);
      if (candidatePoint.x < -60 || candidatePoint.y < -20 ||
          candidatePoint.x > state.viewport.w + 60 || candidatePoint.y > state.viewport.h + 20) continue;
      if (candidate.kind !== 'object' &&
          markerPoints[Math.round(candidate.x / 8) + ':' + Math.round(candidate.y / 8)]) continue;
      candidates.push({
        label: candidate,
        point: candidatePoint,
        rank: labelRank(candidate),
        distance: Math.hypot(candidatePoint.x - centerX, candidatePoint.y - centerY)
      });
    }
    candidates.sort(function (a, b) {
      return a.rank - b.rank || a.distance - b.distance;
    });

    ctx.save();
    ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
    ctx.textBaseline = 'middle';

    for (var i = 0; i < candidates.length && drawn < budget; i++) {
      var label = candidates[i]!.label;
      var key = normalize(label.name);
      if (seen[key]) continue;
      var point = candidates[i]!.point;
      // система и её планета стоят в одной точке: вторую подпись не дублируем
      var tooClose = false;
      for (var p = 0; p < placed.length; p++) {
        if (Math.abs(placed[p]!.x - point.x) < collisionRadius && Math.abs(placed[p]!.y - point.y) < collisionRadius) { tooClose = true; break; }
      }
      if (tooClose) continue;
      placed.push(point);
      seen[key] = true;
      drawn++;

      var linked = label.linkedSystemId && state.systemsById[label.linkedSystemId];
      var isSystem = label.kind === 'system' && !linked;
      ctx.strokeStyle = label.kind === 'system'
        ? 'rgba(214,178,110,.5)'
        : (label.kind === 'planet' ? 'rgba(190,205,225,.34)' : 'rgba(150,170,195,.26)');
      ctx.beginPath();
      ctx.moveTo(point.x - glyph, point.y);
      ctx.lineTo(point.x + glyph, point.y);
      ctx.moveTo(point.x, point.y - glyph);
      ctx.lineTo(point.x, point.y + glyph);
      ctx.stroke();

      if (isSystem) {
        ctx.fillStyle = 'rgba(226,196,130,.72)';
      } else {
        ctx.fillStyle = 'rgba(200,214,232,.5)';
      }
      ctx.lineWidth = clamp(fontSize * 0.28, 2.5, 7);
      ctx.strokeStyle = 'rgba(2,5,10,.75)';
      ctx.strokeText(label.name, point.x + textGap, point.y - textGap);
      ctx.fillText(label.name, point.x + textGap, point.y - textGap);
    }
    ctx.restore();
    return drawn;
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

  function markerMetrics(scale: number): MarkerMetrics {
    var lod = CONFIG.markerLod;
    var radius = clamp(lod.worldRadius * scale, lod.minRadius, lod.maxRadius);
    var fontSize = clamp(lod.worldFont * scale, lod.minFont, lod.maxFont);
    return {
      radius: radius,
      fontSize: fontSize,
      stroke: clamp(4.8 * scale, 1.25, 4.5),
      dot: clamp(7 * scale, 2.2, 10),
      gap: clamp(16 * scale, 5, 18),
      crossGap: clamp(6 * scale, 2, 7),
      crossLength: clamp(12 * scale, 3, 14),
      reviewDot: clamp(8 * scale, 3, 9),
      hitRadius: Math.max(CONFIG.hitRadius, radius + clamp(12 * scale, 5, 14))
    };
  }

  function drawMarkers(): void {
    const ctx = kernel.ctx!;
    var scale = state.view.scale;
    var list = visibleSystems();
    var metrics = markerMetrics(scale);
    var labelCandidates: MarkerLabelCandidate[] = [];

    ctx.save();
    ctx.textBaseline = 'middle';

    // Сначала рисуются все круги. Размер в координатах мира умножается на
    // масштаб карты, а clamp удерживает маркеры читаемыми на обоих краях LOD.
    list.forEach(function (system) {
      var point = toScreen(system.coord![0], system.coord![1]);
      if (point.x < -80 || point.y < -80 || point.x > state.viewport.w + 80 || point.y > state.viewport.h + 80) return;

      var isHover = state.hoverId === system.id;
      var isActive = state.activeSystemId === system.id;
      var verified = system.coordSource === 'map';
      var fromLabel = verified && !system.fromSheet;
      var highlighted = isHover || isActive;
      var emphasis = (isHover ? clamp(5 * scale, 1.5, 4.5) : 0) +
        (isActive ? clamp(8 * scale, 1.6, 7) : 0);
      var radius = metrics.radius + emphasis;
      var color = highlighted ? theme.accent : 'rgba(36,234,219,.38)';
      var entry = {
        system: system, point: point, radius: radius, color: color,
        hover: isHover, active: isActive, verified: verified,
        fromLabel: fromLabel
      };
      ctx.save();
      if (highlighted) {
        ctx.shadowColor = theme.accent;
        ctx.shadowBlur = clamp(32 * scale, 12, 30);
      }
      ctx.globalAlpha = highlighted || verified ? 1 : 0.66;

      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.lineWidth = metrics.stroke * (highlighted ? 1.35 : 1);
      ctx.strokeStyle = color;
      if (!verified) {
        var dash = clamp(9 * scale, 3, 8);
        ctx.setLineDash([dash, dash]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (verified) {
        ctx.fillStyle = 'rgba(36,234,219,.08)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, metrics.dot, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // У систем с подписью на карте — масштабируемая крестовина точки.
      if (fromLabel) {
        var inner = radius + metrics.crossGap;
        var outer = inner + metrics.crossLength;
        ctx.beginPath();
        ctx.moveTo(point.x - outer, point.y); ctx.lineTo(point.x - inner, point.y);
        ctx.moveTo(point.x + inner, point.y); ctx.lineTo(point.x + outer, point.y);
        ctx.moveTo(point.x, point.y - outer); ctx.lineTo(point.x, point.y - inner);
        ctx.moveTo(point.x, point.y + inner); ctx.lineTo(point.x, point.y + outer);
        ctx.lineWidth = clamp(metrics.stroke * 0.72, 1, 3.2);
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.restore();

      if (system.needsReview) {
        ctx.beginPath();
        ctx.arc(point.x + radius * 0.72, point.y - radius * 0.72, metrics.reviewDot, 0, Math.PI * 2);
        ctx.fillStyle = '#e8a35c';
        ctx.fill();
      }

      if (state.labelsOn || highlighted) labelCandidates.push(entry);
    });

    // Включённый режим рисует каждое имя без лимита, LOD или устранения перекрытий.
    for (var i = 0; i < labelCandidates.length; i++) {
      var e = labelCandidates[i]!;
      var text = e.system.name.replace(/^Система\s+/, '');
      var fontSize = metrics.fontSize * (e.active || e.hover ? 1.08 : 1);
      var x = e.point.x + e.radius + metrics.gap;
      var y = e.point.y + e.radius * 0.56;
      ctx.save();
      ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
      ctx.textAlign = 'left';
      ctx.lineWidth = clamp(fontSize * 0.24, 2.6, 9);
      ctx.strokeStyle = 'rgba(2,5,10,.80)';
      ctx.fillStyle = e.hover || e.active ? theme.accent : 'rgba(36,234,219,.38)';
      if (e.hover || e.active) {
        ctx.shadowColor = theme.accent;
        ctx.shadowBlur = clamp(24 * scale, 8, 22);
      }
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    ctx.restore();
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
      var radius = clamp(9 * scale, 4, 9) + (hovered || active ? clamp(3 * scale, 1, 3) : 0);
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

      if (state.labelsOn) {
        var fontSize = clamp(25 * scale, 8, 18);
        ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
        ctx.textAlign = 'left';
        ctx.lineWidth = clamp(fontSize * 0.24, 2.5, 5);
        ctx.strokeStyle = 'rgba(2,5,10,.84)';
        ctx.fillStyle = color;
        ctx.strokeText(place.name, point.x + radius + 8, point.y - radius - 5);
        ctx.fillText(place.name, point.x + radius + 8, point.y - radius - 5);
      }
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
    var fontSize = clamp(36 * scale, 10, 54);
    var labelGap = clamp(18 * scale, 7, 22);
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
    if (state.labelsOn) {
      ctx.font = fontSize.toFixed(1) + 'px ' + theme.mono;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = theme.text;
      ctx.lineWidth = clamp(fontSize * 0.25, 3, 9);
      ctx.strokeStyle = 'rgba(2,5,10,.82)';
      ctx.strokeText(planet.name, point.x + radius + labelGap, point.y - radius - labelGap);
      ctx.fillText(planet.name, point.x + radius + labelGap, point.y - radius - labelGap);
    }
    ctx.restore();
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

    drawMapLabels();
    drawTravelRoute(frameTime);
    drawMarkers();
    drawPointsOfInterest();
    drawPlanetFocus();

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
    var radius = clamp(16 * state.view.scale, 10, 18);
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
    // метрики от масштаба, а не от системы: считаем один раз на вызов
    var metrics = markerMetrics(state.view.scale);
    var hoverBonus = clamp(5 * state.view.scale, 2, 7);
    for (var i = 0; i < list.length; i++) {
      var system = list[i]!;
      if (!system.coord) continue;
      var point = toScreen(system.coord![0], system.coord![1]);
      var dx = point.x - screenX;
      var dy = point.y - screenY;
      var distance = dx * dx + dy * dy; // сравниваем квадраты, корень — только для ответа
      var radius = metrics.hitRadius + (state.hoverId === system.id ? hoverBonus : 0);
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
  };
}
