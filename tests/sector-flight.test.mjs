import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const flight = require('../src/atlas/sector-flight.ts');

test('длительность полёта следует матрице §6.4 с жёстким верхним пределом', () => {
  const expected = [760, 840, 920, 1000, 1080, 1160, 1240, 1320, 1400, 1480];
  for (let delta = 0; delta <= 9; delta++) assert.equal(flight.flightDuration(delta), expected[delta]);
  assert.equal(flight.flightDuration(10), 1500);
  assert.throws(() => flight.flightDuration(-1), RangeError);
});

test('планы клика и стрелки достигают L9 и используют абсолютную разницу уровней', () => {
  const start = { x: 500, y: 600, level: 4 };
  const target = { x: 700, y: 800, level: 9, id: 'goal' };
  const click = flight.planClickFlight(start, target);
  const arrow = flight.planArrowTrip({ x: 0, y: 0, level: 2 }, target);
  assert.deepEqual([click.delta, click.duration, click.targetScaleLevel], [5, 1160, 9]);
  assert.deepEqual([arrow.delta, arrow.duration], [7, 1320]);
  assert.equal(click.to.id, 'goal');
});

test('фазовые интервалы покрывают anticipation, рамку и settle без выхода за пределы', () => {
  assert.equal(flight.FLIGHT_TIMING.anticipation, 140);
  assert.equal(flight.FLIGHT_TIMING.frameEnd, 380);
  assert.equal(flight.FLIGHT_TIMING.settle, 120);
  assert.equal(flight.FLIGHT_TIMING.max, 1500);
});

/* ---------------------------------------------------------------- долг SW-3F: фазы и приглушение */

const { createCanvasRenderer } = require('../src/atlas/canvas-renderer.ts');
const { markerDiameter } = require('../src/atlas/level-ladder.ts');

test('фаза полёта меняется ровно по границам §6.4 для Δ=0 и Δ=9', () => {
  const short = flight.flightDuration(0);
  const long = flight.flightDuration(9);
  assert.deepEqual([short, long], [760, 1480]);

  // Общие границы: 0 мс — anticipation, 140 — frame, 380 — stages.
  const shared = [
    [0, 'anticipation'],
    [139, 'anticipation'],
    [140, 'frame'],
    [379, 'frame'],
    [380, 'stages'],
  ];
  for (const [elapsed, phase] of shared) {
    assert.equal(flight.flightPhaseAt(elapsed, short), phase, `Δ=0, ${elapsed} мс`);
    assert.equal(flight.flightPhaseAt(elapsed, long), phase, `Δ=9, ${elapsed} мс`);
  }
  // settle — последние 120 мс: T−120 … T, после T — idle.
  assert.equal(flight.flightPhaseAt(639, short), 'stages');
  assert.equal(flight.flightPhaseAt(640, short), 'settle');
  assert.equal(flight.flightPhaseAt(759, short), 'settle');
  assert.equal(flight.flightPhaseAt(760, short), 'idle');
  assert.equal(flight.flightPhaseAt(1359, long), 'stages');
  assert.equal(flight.flightPhaseAt(1360, long), 'settle');
  assert.equal(flight.flightPhaseAt(1479, long), 'settle');
  assert.equal(flight.flightPhaseAt(1480, long), 'idle');
  assert.equal(flight.flightPhaseAt(1481, long), 'idle');
  // Мусор и отрицательное время не дают «вечной» фазы.
  assert.equal(flight.flightPhaseAt(-1, short), 'idle');
  assert.equal(flight.flightPhaseAt(Number.NaN, short), 'idle');
  assert.equal(flight.flightPhaseAt(10, 0), 'idle');
  // Числа FLIGHT_TIMING остаются неприкосновенными.
  assert.deepEqual(
    { ...flight.FLIGHT_TIMING },
    { anticipation: 140, frameEnd: 380, settle: 120, base: 760, perLevel: 80, min: 760, max: 1500 },
  );
  assert.equal(flight.FLIGHT_MARKER_DIM, 0.35);
});

/** Управляемые `window`/`performance`: полёт идёт по нашим кадрам, а не по реальным часам. */
function createFlightHarness() {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const timers = [];
  let clock = 1000;
  let pendingFrame = null;
  let frameId = 0;

  const overlay = {
    className: '',
    style: { opacity: '', setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    remove() {},
  };
  const mapCanvas = { style: { opacity: '' }, classList: { add() {}, remove() {} } };

  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) { pendingFrame = callback; frameId += 1; return frameId; },
    cancelAnimationFrame() { pendingFrame = null; },
    setTimeout(callback) { timers.push(callback); return timers.length; },
  };
  globalThis.performance = { now: () => clock };

  const kernel = {
    el: {
      mapCanvas,
      mapStage: {
        querySelector: () => null,
        append() {},
        ownerDocument: { createElement: () => overlay },
      },
    },
    state: { view: { scale: 1, tx: 0, ty: 0 }, viewport: { w: 1920, h: 1080 } },
    renderer: {
      centerOn(x, y, scale) { kernel.state.view.scale = scale; },
      cancelAnimation() {},
      requestRender() {},
      minScale: () => 0.1,
      maxScale: () => 1000,
      clampView() {},
      toWorld: () => ({ x: 0, y: 0 }),
    },
  };

  const harness = {
    flight: flight.createFlight(kernel),
    kernel,
    overlay,
    timers,
    /** Один кадр полёта: время отсчитывается от `started`, снятого в `flyTo`. */
    advance(ms) {
      clock = 1000 + ms;
      const callback = pendingFrame;
      pendingFrame = null;
      if (callback) callback(clock);
    },
    hasPendingFrame: () => pendingFrame !== null,
    restore() {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete globalThis.window;
      if (savedPerformance) Object.defineProperty(globalThis, 'performance', savedPerformance);
      else delete globalThis.performance;
    },
  };
  return harness;
}

test('onPhaseChange ведёт anticipation → frame → stages → settle → idle с id цели', () => {
  const harness = createFlightHarness();
  try {
    const events = [];
    const off = harness.flight.onPhaseChange((phase, targetId) => events.push([phase, targetId]));
    const plan = harness.flight.planClickFlight({ x: 0, y: 0, level: 9 }, { x: 10, y: 10, level: 9, id: 'goal' });
    assert.equal(plan.duration, 760);

    harness.flight.flyTo(plan);
    assert.equal(harness.flight.phase, 'anticipation');
    assert.equal(harness.flight.active, true);
    assert.deepEqual(events, [['anticipation', 'goal']]);

    harness.advance(0);
    harness.advance(140);
    harness.advance(380);
    harness.advance(640);
    assert.equal(harness.flight.phase, 'settle');
    harness.advance(760);

    assert.equal(harness.flight.phase, 'idle');
    assert.equal(harness.flight.active, false);
    assert.deepEqual(events, [
      ['anticipation', 'goal'],
      ['frame', 'goal'],
      ['stages', 'goal'],
      ['settle', 'goal'],
      ['idle', null],
    ]);

    // Отписка прекращает доставку: возвращённая функция — именно unsubscribe.
    off();
    const before = events.length;
    harness.flight.flyTo(plan);
    harness.flight.cancel();
    assert.equal(events.length, before);
  } finally {
    harness.restore();
  }
});

test('cancel() снимает приглушение тем же выходом в idle; время Δ растягивает stages', () => {
  const harness = createFlightHarness();
  try {
    const events = [];
    harness.flight.onPhaseChange((phase, targetId) => events.push([phase, targetId]));
    const plan = harness.flight.planClickFlight({ x: 0, y: 0, level: 0 }, { x: 10, y: 10, level: 9, id: 'far' });
    assert.equal(plan.duration, 1480);

    harness.flight.flyTo(plan);
    harness.advance(0);
    assert.deepEqual(events.at(-1), ['anticipation', 'far']);
    harness.flight.cancel();
    assert.equal(harness.flight.phase, 'idle');
    assert.equal(harness.flight.active, false);
    assert.deepEqual(events.at(-1), ['idle', null]);
    assert.equal(harness.hasPendingFrame(), false);

    // Повторная отмена уже в idle не плодит событий и не оставляет приглушения.
    const count = events.length;
    harness.flight.cancel();
    assert.equal(events.length, count);

    // Δ=9: stages тянутся до T−120 = 1360 мс, settle — последние 120 мс.
    harness.flight.flyTo(plan);
    harness.advance(0);
    harness.advance(1359);
    assert.equal(harness.flight.phase, 'stages');
    harness.advance(1360);
    assert.equal(harness.flight.phase, 'settle');
    harness.advance(1479);
    assert.equal(harness.flight.phase, 'settle');
  } finally {
    harness.restore();
  }
});

/** Контекст-заглушка, запоминающий `globalAlpha` на каждом `arc(...)`. */
function createRecordingContext() {
  const arcs = [];
  const stack = [];
  const target = {
    globalAlpha: 1,
    save() { stack.push(target.globalAlpha); },
    restore() { target.globalAlpha = stack.length ? stack.pop() : 1; },
    arc(x, y, r) { arcs.push({ alpha: target.globalAlpha, x, y, r }); },
    createRadialGradient() { return { addColorStop() {} }; },
    measureText() { return { width: 0 }; },
  };
  const ctx = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      return () => {};
    },
    set(object, property, value) { object[property] = value; return true; },
  });
  return { ctx, arcs };
}

/** Рендерер с двумя системами в кадре: `map`-координата и табличная (0,66). */
function createDimHarness() {
  const previousRaf = globalThis.requestAnimationFrame;
  let pendingFrame = null;
  globalThis.requestAnimationFrame = (callback) => { pendingFrame = callback; return 1; };

  const viewport = { w: 1280, h: 720 };
  const scale = 40;
  const recorded = createRecordingContext();
  const systems = [
    {
      id: 'corhal', name: 'Корхал', coord: [5000, 5000], coordSource: 'map',
      factions: ['terran'], worlds: [], systemType: 'capital',
    },
    {
      id: 'raidin', name: 'Райдин', coord: [5004, 5000], coordSource: 'table',
      factions: ['terran'], worlds: [], systemType: 'colony',
    },
  ];
  const state = {
    meta: null,
    systems,
    systemsById: { corhal: systems[0], raidin: systems[1] },
    planets: [],
    planetsById: {},
    labels: [],
    labelsOn: false,
    mapFaction: 'all',
    hoverId: null,
    hoverPoiId: null,
    activeSystemId: null,
    activePlanetId: null,
    pinned: false,
    viewport,
    dpr: 1,
    view: { scale, tx: viewport.w / 2 - 5000 * scale, ty: viewport.h / 2 - 5000 * scale },
    travel: { enabled: false, freePointMode: false, calculation: null },
  };
  const kernel = {
    doc: null,
    canvas: null,
    ctx: recorded.ctx,
    fieldCanvas: null,
    field: null,
    state,
    theme: {
      bg: '#03060c', accent: '#24eadb', accent2: '#80a9da', text: '#e6f1ff',
      muted: '#8da2bd', warn: '#e8a35c', mono: 'monospace',
    },
    el: { mapStage: null },
    skin: null,
    runtime: {
      renderQueued: false,
      fieldContextLost: false,
      coordinatePointer: null,
      coordinateReadoutEnabled: false,
      travelCore: null,
    },
    data: {
      mapSize: () => 10000,
      coordinateOnMap: (point) => Boolean(point && point.x >= 0 && point.x <= 10000 && point.y >= 0 && point.y <= 10000),
      factionsOf: () => [],
      systemFactions: () => [],
    },
    renderer: null,
    catalog: null,
    dossier: { renderDetail() {}, selectPlanet() {}, selectSystem() {}, clearDetail() {} },
    coords: {
      cancelPendingTravelTap() {},
      updateZoomReadout() {},
      updateCoordinateReadout() {},
      isTravelAnimationActive: () => false,
      travelStops: () => [],
    },
    app: { toast() {} },
  };

  const renderer = createCanvasRenderer(kernel);
  kernel.renderer = renderer;

  /** Первый `arc` в точке маркера — его кольцо; апертура рисуется позже и другим радиусом. */
  function markerAssetAlpha(systemId) {
    const system = state.systemsById[systemId];
    const point = renderer.toScreen(system.coord[0], system.coord[1]);
    const hit = recorded.arcs.find(
      (arc) => Math.abs(arc.x - point.x) < 1e-9 && Math.abs(arc.y - point.y) < 1e-9,
    );
    assert.ok(hit, `маркер ${systemId} не нарисован`);
    return hit.alpha;
  }

  function frame() {
    recorded.arcs.length = 0;
    renderer.requestRender();
    const callback = pendingFrame;
    pendingFrame = null;
    assert.equal(typeof callback, 'function', 'кадр не запланирован');
    callback(0);
  }

  return {
    state,
    renderer,
    frame,
    markerAlpha: markerAssetAlpha,
    markerRadius: () => Math.min(20, markerDiameter(Math.min(viewport.w, viewport.h) / scale) / 2),
    restore() {
      if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = previousRaf;
    },
  };
}

test('в anticipation цель полёта = 1, остальные маркеры = 0,35; вне его — прежние 1 / 0,66', () => {
  const harness = createDimHarness();
  try {
    // До полёта: подтверждённая координата — 1, табличная — 0,66.
    harness.frame();
    assert.equal(harness.markerAlpha('corhal'), 1);
    assert.equal(harness.markerAlpha('raidin'), 0.66);

    // anticipation: цель 1, остальные 0,35 — независимо от verified и подсветки.
    harness.state.activeSystemId = 'raidin';
    harness.renderer.setFlightDim('corhal', flight.FLIGHT_MARKER_DIM);
    harness.frame();
    assert.equal(harness.markerAlpha('corhal'), 1);
    assert.equal(harness.markerAlpha('raidin'), 0.35);
    harness.state.activeSystemId = null;

    // Цель может быть и табличной системой — яркой становится именно она.
    harness.renderer.setFlightDim('raidin', flight.FLIGHT_MARKER_DIM);
    harness.frame();
    assert.equal(harness.markerAlpha('raidin'), 1);
    assert.equal(harness.markerAlpha('corhal'), 0.35);

    // Сброс возвращает штатные 1 / 0,66 (так делает app.ts на любой фазе, кроме anticipation).
    harness.renderer.setFlightDim(null, 1);
    harness.frame();
    assert.equal(harness.markerAlpha('corhal'), 1);
    assert.equal(harness.markerAlpha('raidin'), 0.66);

    // Некорректная цель не оставляет «полуприглушённого» состояния.
    harness.renderer.setFlightDim(null, 0.35);
    harness.frame();
    assert.equal(harness.markerAlpha('corhal'), 1);
    assert.equal(harness.markerAlpha('raidin'), 0.66);
  } finally {
    harness.restore();
  }
});

test('app.ts подписан на фазы и снимает приглушение при выходе из anticipation', () => {
  const source = readFileSync(new URL('../src/atlas/app.ts', import.meta.url), 'utf8');
  assert.match(source, /flight\.onPhaseChange\(/);
  assert.match(source, /setFlightDim\(targetId, FLIGHT_MARKER_DIM\)/);
  assert.match(source, /setFlightDim\(null, 1\)/);
});
