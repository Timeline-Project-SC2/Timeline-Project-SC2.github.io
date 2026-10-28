import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CONFIG } = require('../src/atlas/config.ts');
const { createCanvasRenderer } = require('../src/atlas/canvas-renderer.ts');
const {
  MAX_SCALE,
  edgeDistance,
  fitScaleFor,
  maxScaleForTargetWidth,
} = require('../src/atlas/level-ladder.ts');
const { unitsToLy } = require('../src/atlas/sector-units.ts');

const MAP_SIZE = 10000;
const EPS = 1e-9;

/** Пять viewport: фиксированный предел 500 px/св.г. и справочное edgeDistance. */
const PLAN_VIEWPORTS = [
  { label: '1920×1080', w: 1920, h: 1080, expectedMaxScale: 500, expectedEdge: 1.08 },
  { label: '1366×768', w: 1366, h: 768, expectedMaxScale: 500, expectedEdge: 0.768 },
  { label: '2560×1440', w: 2560, h: 1440, expectedMaxScale: 500, expectedEdge: 1.44 },
  { label: '390×844', w: 390, h: 844, expectedMaxScale: 500, expectedEdge: 0.39 },
  { label: '844×390', w: 844, h: 390, expectedMaxScale: 500, expectedEdge: 0.39 },
];

/** Целевые точки внутри сектора: геометрический центр и реальная столица (Тарсонис). */
const SAMPLE_TARGETS = [
  { name: 'центр сектора', x: 5000, y: 5000 },
  { name: 'Тарсонис', x: 4902, y: 5404 },
];

function createStubCanvasContext(calls = []) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        return (...args) => { calls.push([prop, ...args]); };
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

  const calls = [];
  const kernel = {
    doc: null,
    canvas: null,
    ctx: createStubCanvasContext(calls),
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

  return { state, renderer, flushAnimationFrame, restoreGlobals, calls };
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

test('maxScale = 500 px/св.г. и minScale на пяти плановых viewport', () => {
  assert.equal(MAX_SCALE, 500);

  for (const spec of PLAN_VIEWPORTS) {
    const h = createRendererHarness(spec);
    try {
      const fit = h.renderer.fitScale();
      const min = h.renderer.minScale();
      const max = h.renderer.maxScale();

      // 1. Предел — фиксированные 500 px/св.г. на любом viewport.
      assert.equal(max, spec.expectedMaxScale, `${spec.label}: maxScale`);
      assert.equal(
        max,
        maxScaleForTargetWidth({ w: spec.w, h: spec.h }, MAP_SIZE, CONFIG.view.fitInset),
        `${spec.label}: делегирование в maxScaleForTargetWidth`,
      );

      // 2. До ближайшей границы — половина короткой оси, переведённая в св.г.
      const edgeAtMax = edgeDistance({ w: spec.w, h: spec.h }, max);
      assert.ok(
        Math.abs(edgeAtMax - spec.expectedEdge) <= EPS,
        `${spec.label}: edgeDistance=${edgeAtMax}, ожидалось ${spec.expectedEdge} ± ${EPS}`,
      );

      // 3. minScale оставлен как есть (вся карта * minFactor) и строго не выше нового максимума.
      assert.equal(fit, fitScaleFor({ w: spec.w, h: spec.h }, MAP_SIZE, CONFIG.view.fitInset));
      assert.equal(min, fit * CONFIG.view.minFactor, `${spec.label}: формула minScale`);
      assert.ok(min > 0, `${spec.label}: minScale > 0`);
      assert.ok(min < fit, `${spec.label}: minScale < fitScale`);
      assert.ok(min < max, `${spec.label}: minScale (${min}) должен быть ниже maxScale (${max})`);
    } finally {
      h.restoreGlobals();
    }
  }
});

test('clampView, zoomAt и centerOn упираются в предел по полной ширине на всех пяти viewport', () => {
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
          Math.abs(afterCenter.nearest - spec.expectedEdge) <= EPS,
          `${spec.label} (${target.name}): расстояние от цели до ближайшей границы = ${afterCenter.nearest}`,
        );
        // По длинной оси расстояние также проверяется точно, без ослабления допуска.
        assert.ok(
          Math.abs(afterCenter.farthest - Math.max(spec.w, spec.h) / (2 * spec.expectedMaxScale)) <= EPS,
          `${spec.label} (${target.name}): расстояние по длинной оси соответствует масштабу`,
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
          Math.abs(afterZoomAt.nearest - spec.expectedEdge) <= EPS,
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
          Math.abs(afterClamp.nearest - spec.expectedEdge) <= EPS,
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

    // 2. Выход на потолок 2560×1440 (maxScale = 500), затем ресайз в 1366×768 (maxScale = 500).
    const target = { x: 5000, y: 5000 };
    h.renderer.centerOn(target.x, target.y, 1e6);
    h.flushAnimationFrame(performance.now() + CONFIG.view.animate + 50);
    assert.equal(h.state.view.scale, 500);

    h.state.viewport = { w: 1366, h: 768 };
    h.state.view.tx = 1366 / 2 - target.x * 500;
    h.state.view.ty = 768 / 2 - target.y * 500;
    h.renderer.clampView();
    assert.equal(h.state.view.scale, 500);
    assert.ok(Math.abs(edgeDistance(h.state.viewport, h.state.view.scale) - 0.768) <= EPS);

    // 3. Поворот экрана 390×844 ↔ 844×390 меняет потолок по полной ширине.
    for (const rotated of [
      { w: 390, h: 844 },
      { w: 844, h: 390 },
    ]) {
      h.state.viewport = rotated;
      h.state.view.scale = 1000;
      h.state.view.tx = rotated.w / 2 - target.x * 500;
      h.state.view.ty = rotated.h / 2 - target.y * (500);
      h.renderer.clampView();
      assert.equal(h.renderer.maxScale(), 500);
      assert.equal(h.state.view.scale, 500);

      const distances = targetToEdgeDistances(h.renderer, rotated, target);
      assert.ok(Math.abs(distances.nearest - Math.min(rotated.w, rotated.h) / 1000) <= EPS);
      if (rotated.w < rotated.h) {
        // Портрет 390×844: ближайшие границы — левая и правая (0,39 св.г.).
        assert.ok(Math.abs(distances.left - 0.39) <= EPS);
        assert.ok(Math.abs(distances.right - 0.39) <= EPS);
        assert.ok(Math.abs(distances.top - 0.844) <= EPS && Math.abs(distances.bottom - 0.844) <= EPS);
      } else {
        // Альбом 844×390: ближайшие границы — верхняя и нижняя (0,39 св.г.).
        assert.ok(Math.abs(distances.top - 0.39) <= EPS);
        assert.ok(Math.abs(distances.bottom - 0.39) <= EPS);
        assert.ok(distances.left > 0.39 && distances.right > 0.39);
      }
    }
  } finally {
    h.restoreGlobals();
  }
});

test('контур рисуется целой кривой с clip даже без видимых вершин', () => {
  const h = createRendererHarness({ w: 300, h: 200 });
  try {
    h.state.sectorBounds = {
      version: 1,
      mapSize: 10000,
      source: 'test',
      bounds: [{
        id: 'sector.outline', kind: 'sector', label: 'test',
        style: { color: 'tactical', strokeWidth: 2, dash: [] },
        points: [[0, 4000], [10000, 4000], [10000, 6000], [0, 6000], [0, 4000]],
      }],
    };
    // Кадр вокруг части границы: все четыре исходные вершины вне кадра.
    h.renderer.centerOn(5000, 4000, 1, false);
    h.flushAnimationFrame(performance.now() + 1000);
    const clipIndex = h.calls.findIndex(([name]) => name === 'clip');
    assert.ok(clipIndex >= 0, 'контур обрезается контекстом по кадру');
    const curveIndex = h.calls.findIndex(([name], index) => index > clipIndex && name === 'quadraticCurveTo');
    assert.ok(curveIndex > clipIndex, 'отрисована кривая, хотя вершины вне кадра');
    assert.ok(h.calls.some(([name], index) => index > curveIndex && name === 'closePath'));
    assert.equal(h.calls.filter(([name], index) => index >= curveIndex && name === 'quadraticCurveTo').length, 4);
  } finally {
    h.restoreGlobals();
  }
});
