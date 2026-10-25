import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CONFIG } = require('../src/atlas/config.ts');
const { createCanvasRenderer } = require('../src/atlas/canvas-renderer.ts');
const {
  TARGET_EDGE_LY,
  edgeDistance,
  fitScaleFor,
  maxScaleForTargetEdge,
} = require('../src/atlas/level-ladder.ts');
const { unitsToLy } = require('../src/atlas/sector-units.ts');

const MAP_SIZE = 10000;
const EPS = 1e-9;

/** Пять viewport из §17.23 с точными значениями maxScale = min(w, h) / 2000 (px/ед). */
const PLAN_VIEWPORTS = [
  { label: '1920×1080', w: 1920, h: 1080, expectedMaxScale: 0.54 },
  { label: '1366×768', w: 1366, h: 768, expectedMaxScale: 0.384 },
  { label: '2560×1440', w: 2560, h: 1440, expectedMaxScale: 0.72 },
  { label: '390×844', w: 390, h: 844, expectedMaxScale: 0.195 },
  { label: '844×390', w: 844, h: 390, expectedMaxScale: 0.195 },
];

/** Целевые точки внутри сектора: геометрический центр и реальная столица (Тарсонис). */
const SAMPLE_TARGETS = [
  { name: 'центр сектора', x: 5000, y: 5000 },
  { name: 'Тарсонис', x: 4902, y: 5404 },
];

function createStubCanvasContext() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
}

/**
 * Создаёт боевой экземпляр `createCanvasRenderer` с контролируемой очередью кадров
 * для проверки `maxScale`, `minScale`, `clampView`, `zoomAt` и `centerOn` в Node.
 */
function createRendererHarness(viewport, mapSize = MAP_SIZE) {
  let pendingFrame = null;
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    pendingFrame = callback;
    return 1;
  };

  const state = {
    meta: null,
    systems: [],
    systemsById: {},
    planets: [],
    planetsById: {},
    standalonePlaces: [],
    labels: [],
    searchIndex: [],
    catalogView: 'systems',
    faction: 'all',
    type: 'all',
    query: '',
    mapFaction: 'all',
    labelsOn: false,
    activeSystemId: null,
    activePlanetId: null,
    hoverId: null,
    hoverPoiId: null,
    pinned: false,
    suggestions: [],
    activeSuggestion: -1,
    viewport: { w: viewport.w, h: viewport.h },
    dpr: 1,
    view: { scale: 1, tx: 0, ty: 0 },
    travel: {
      enabled: false,
      freePointMode: false,
      stops: [],
      speedIndex: 0,
      roundTrip: false,
      activeStopIndex: -1,
      calculation: null,
    },
  };

  const runtime = {
    renderQueued: false,
    coordinateReadoutEnabled: false,
    coordinatePointer: null,
    travelCore: null,
    fieldContextLost: false,
  };

  const kernel = {
    doc: null,
    canvas: null,
    ctx: createStubCanvasContext(),
    fieldCanvas: null,
    field: null,
    state,
    theme: {
      bg: '#03060c',
      accent: '#24eadb',
      accent2: '#80a9da',
      text: '#e6f1ff',
      muted: '#8da2bd',
      warn: '#e8a35c',
      mono: 'monospace',
    },
    el: { mapStage: null },
    skin: null,
    links: null,
    runtime,
    data: {
      mapSize: () => mapSize,
      coordinateOnMap: (point) =>
        Boolean(point && point.x >= 0 && point.x <= mapSize && point.y >= 0 && point.y <= mapSize),
      factionsOf: () => [],
      systemFactions: () => [],
    },
    renderer: null,
    catalog: null,
    dossier: {
      renderDetail() {},
      selectPlanet() {},
      selectSystem() {},
      clearDetail() {},
    },
    coords: {
      cancelPendingTravelTap() {},
      updateZoomReadout() {},
      updateCoordinateReadout() {},
      isTravelAnimationActive: () => false,
      travelStops: () => [],
    },
    app: {
      toast() {},
    },
  };

  const renderer = createCanvasRenderer(kernel);
  kernel.renderer = renderer;
  renderer.fitView();

  function flushAnimationFrame(timestampMs) {
    const callback = pendingFrame;
    pendingFrame = null;
    if (callback) {
      callback(timestampMs);
    }
  }

  function restoreGlobals() {
    if (previousRaf === undefined) {
      delete globalThis.requestAnimationFrame;
    } else {
      globalThis.requestAnimationFrame = previousRaf;
    }
  }

  return { state, renderer, flushAnimationFrame, restoreGlobals };
}

/**
 * Геометрическое расстояние в св.г. от целевой точки `(targetX, targetY)` до каждой из
 * четырёх границ экрана и до ближайшей границы экрана — через `renderer.toWorld(...)` и `unitsToLy`.
 */
function targetToEdgeDistances(renderer, viewport, target) {
  const leftWorld = renderer.toWorld(0, viewport.h / 2);
  const rightWorld = renderer.toWorld(viewport.w, viewport.h / 2);
  const topWorld = renderer.toWorld(viewport.w / 2, 0);
  const bottomWorld = renderer.toWorld(viewport.w / 2, viewport.h);

  const left = unitsToLy(target.x - leftWorld.x);
  const right = unitsToLy(rightWorld.x - target.x);
  const top = unitsToLy(target.y - topWorld.y);
  const bottom = unitsToLy(bottomWorld.y - target.y);
  const nearest = Math.min(left, right, top, bottom);
  const farthest = Math.max(left, right, top, bottom);

  return { left, right, top, bottom, nearest, farthest };
}

test('CONFIG.view.maxFactor удалён из конфигурации и не используется в атласе', () => {
  assert.equal('maxFactor' in CONFIG.view, false);
  assert.equal(CONFIG.view.maxFactor, undefined);
  assert.equal(CONFIG.view.fitInset, 0.94);
  assert.equal(CONFIG.view.minFactor, 0.62);

  for (const relPath of ['../src/atlas/config.ts', '../src/atlas/canvas-renderer.ts']) {
    const source = readFileSync(new URL(relPath, import.meta.url), 'utf8');
    assert.equal(
      source.includes('maxFactor'),
      false,
      `${relPath} не должен содержать устаревший maxFactor`,
    );
  }
});

test('maxScale и minScale на пяти плановых viewport: 0,54 / 0,384 / 0,72 / 0,195 / 0,195 и ровно 1,00 св.г. до границы', () => {
  assert.equal(TARGET_EDGE_LY, 1);

  for (const spec of PLAN_VIEWPORTS) {
    const h = createRendererHarness(spec);
    try {
      const fit = h.renderer.fitScale();
      const min = h.renderer.minScale();
      const max = h.renderer.maxScale();

      // 1. Точное совпадение с §17.23: maxScale = min(w, h) / 2000 (0,54 / 0,384 / 0,72 / 0,195 / 0,195).
      assert.equal(max, spec.expectedMaxScale, `${spec.label}: maxScale`);
      assert.equal(
        max,
        maxScaleForTargetEdge({ w: spec.w, h: spec.h }, MAP_SIZE, CONFIG.view.fitInset),
        `${spec.label}: делегирование в maxScaleForTargetEdge`,
      );

      // 2. Расстояние от цели в центре кадра до ближайшей границы экрана ровно 1,00 св.г.
      const edgeAtMax = edgeDistance({ w: spec.w, h: spec.h }, max);
      assert.ok(
        Math.abs(edgeAtMax - 1) <= EPS,
        `${spec.label}: edgeDistance=${edgeAtMax}, ожидалось 1 ± ${EPS}`,
      );

      // 3. minScale оставлен как есть (вся карта * minFactor) и строго не выше нового максимума.
      assert.equal(fit, fitScaleFor({ w: spec.w, h: spec.h }, MAP_SIZE, CONFIG.view.fitInset));
      assert.equal(min, fit * CONFIG.view.minFactor, `${spec.label}: формула minScale`);
      assert.ok(min > 0, `${spec.label}: minScale > 0`);
      assert.ok(min < fit, `${spec.label}: minScale < fitScale`);
      assert.ok(min <= max, `${spec.label}: minScale (${min}) не должен превышать maxScale (${max})`);
    } finally {
      h.restoreGlobals();
    }
  }
});

test('clampView, zoomAt и centerOn упираются ровно в 1,00 св.г. ОТ ЦЕЛИ ДО БЛИЖАЙШЕЙ ГРАНИЦЫ на всех пяти viewport', () => {
  for (const spec of PLAN_VIEWPORTS) {
    for (const target of SAMPLE_TARGETS) {
      const h = createRendererHarness(spec);
      try {
        // А) centerOn с запросом масштаба выше потолка: цель встаёт в центр кадра,
        // а масштаб зажимается в expectedMaxScale.
        h.renderer.centerOn(target.x, target.y, spec.expectedMaxScale * 50);
        h.flushAnimationFrame(performance.now() + CONFIG.view.animate + 50);

        assert.equal(
          h.state.view.scale,
          spec.expectedMaxScale,
          `${spec.label} (${target.name}): centerOn зажимает scale в ${spec.expectedMaxScale}`,
        );

        const screenTarget = h.renderer.toScreen(target.x, target.y);
        assert.ok(
          Math.abs(screenTarget.x - spec.w / 2) <= EPS,
          `${spec.label} (${target.name}): цель по X в центре экрана`,
        );
        assert.ok(
          Math.abs(screenTarget.y - spec.h / 2) <= EPS,
          `${spec.label} (${target.name}): цель по Y в центре экрана`,
        );

        const afterCenter = targetToEdgeDistances(h.renderer, spec, target);
        assert.ok(
          Math.abs(afterCenter.nearest - 1) <= EPS,
          `${spec.label} (${target.name}): расстояние от цели до ближайшей границы = ${afterCenter.nearest}`,
        );
        // На неквадратных экранах проверяем, что измеряется именно ближайшая граница (1,00 св.г.),
        // а по длинной стороне расстояние строго больше 1,00 св.г.
        assert.ok(
          afterCenter.farthest > 1 + 0.5,
          `${spec.label} (${target.name}): по длинной оси до края > 1,5 св.г., но кламп держит ближайший край на 1,00 св.г.`,
        );

        // Б) zoomAt в точку цели при попытке приблизить ещё в 100 раз: масштаб и цель не сдвигаются.
        h.renderer.zoomAt(spec.w / 2, spec.h / 2, 100);
        assert.equal(
          h.state.view.scale,
          spec.expectedMaxScale,
          `${spec.label} (${target.name}): zoomAt не пускает выше maxScale`,
        );
        const afterZoomAt = targetToEdgeDistances(h.renderer, spec, target);
        assert.ok(
          Math.abs(afterZoomAt.nearest - 1) <= EPS,
          `${spec.label} (${target.name}): после zoomAt расстояние от цели до границы = ${afterZoomAt.nearest}`,
        );

        // В) Прямой перелёт масштаба и clampView(): масштаб возвращается ровно к maxScale.
        h.state.view.scale = spec.expectedMaxScale * 1000;
        h.state.view.tx = spec.w / 2 - target.x * spec.expectedMaxScale;
        h.state.view.ty = spec.h / 2 - target.y * spec.expectedMaxScale;
        h.renderer.clampView();
        assert.equal(
          h.state.view.scale,
          spec.expectedMaxScale,
          `${spec.label} (${target.name}): clampView зажимает scale в ${spec.expectedMaxScale}`,
        );
        const afterClamp = targetToEdgeDistances(h.renderer, spec, target);
        assert.ok(
          Math.abs(afterClamp.nearest - 1) <= EPS,
          `${spec.label} (${target.name}): после clampView расстояние от цели до границы = ${afterClamp.nearest}`,
        );
      } finally {
        h.restoreGlobals();
      }
    }
  }
});

test('нижний упор minScale и пересчёт потолка при смене размера/ориентации viewport', () => {
  const h = createRendererHarness({ w: 2560, h: 1440 });
  try {
    // 1. Отдаление до упора зажимается ровно в minScale (вся карта * minFactor).
    const expectedMin = h.renderer.minScale();
    h.renderer.zoomAt(1280, 720, 1e-6);
    assert.equal(h.state.view.scale, expectedMin);
    assert.ok(h.state.view.scale < h.renderer.maxScale());

    // 2. Выход на потолок 2560×1440 (maxScale = 0,72), затем ресайз в 1366×768 (maxScale = 0,384).
    const target = { x: 5000, y: 5000 };
    h.renderer.centerOn(target.x, target.y, 1e6);
    h.flushAnimationFrame(performance.now() + CONFIG.view.animate + 50);
    assert.equal(h.state.view.scale, 0.72);

    h.state.viewport = { w: 1366, h: 768 };
    h.state.view.tx = 1366 / 2 - target.x * 0.384;
    h.state.view.ty = 768 / 2 - target.y * 0.384;
    h.renderer.clampView();
    assert.equal(h.state.view.scale, 0.384);
    assert.ok(Math.abs(edgeDistance(h.state.viewport, h.state.view.scale) - 1) <= EPS);

    // 3. Поворот экрана 390×844 ↔ 844×390 сохраняет потолок 0,195 и 1,00 св.г. до ближайшего края.
    for (const rotated of [
      { w: 390, h: 844 },
      { w: 844, h: 390 },
    ]) {
      h.state.viewport = rotated;
      h.state.view.scale = 10;
      h.state.view.tx = rotated.w / 2 - target.x * 0.195;
      h.state.view.ty = rotated.h / 2 - target.y * 0.195;
      h.renderer.clampView();
      assert.equal(h.renderer.maxScale(), 0.195);
      assert.equal(h.state.view.scale, 0.195);

      const distances = targetToEdgeDistances(h.renderer, rotated, target);
      assert.ok(Math.abs(distances.nearest - 1) <= EPS);
      if (rotated.w < rotated.h) {
        // Портрет 390×844: ближайшие границы — левая и правая (ровно 1,00 св.г.).
        assert.ok(Math.abs(distances.left - 1) <= EPS);
        assert.ok(Math.abs(distances.right - 1) <= EPS);
        assert.ok(distances.top > 2 && distances.bottom > 2);
      } else {
        // Альбом 844×390: ближайшие границы — верхняя и нижняя (ровно 1,00 св.г.).
        assert.ok(Math.abs(distances.top - 1) <= EPS);
        assert.ok(Math.abs(distances.bottom - 1) <= EPS);
        assert.ok(distances.left > 2 && distances.right > 2);
      }
    }
  } finally {
    h.restoreGlobals();
  }
});
