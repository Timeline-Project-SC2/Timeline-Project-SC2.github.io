/* Разделение цветов пары в отрисовке (§6 ТЗ SEC-AREAS-HIERARCHY): маски
 * вырезов попадают в слои отрисовки нужной области, проекция сцены переводит
 * вырезы и линию в экран, явный порядок наложения overlay поднимает «верхнюю»
 * область пары. Контурные обводки маской не трогаются.
 *
 * Запуск: node --test tests/sector-areas-split-render.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createArea, emptySectorAreasDoc } from '../src/atlas/sector-areas-contract.ts';
import { buildAreaPaints } from '../src/atlas/sector-areas-render.ts';
import { applyPairOverlayOrder, areasFor } from '../src/atlas/sector-scene.ts';
import { createCanvasRenderer } from '../src/atlas/canvas-renderer.ts';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

function docWithState() {
  const doc = emptySectorAreasDoc();
  return {
    ...doc,
    areas: [
      createArea({ id: 'area-1', name: 'Альфа', rings: [square(1000, 1000, 4000, 4000)] }),
      createArea({ id: 'area-2', name: 'Бета', rings: [square(2500, 2500, 5500, 5500)] }),
    ].map((area) => ({
      ...area,
      states: [{
        id: `state-${area.id}`,
        mode: 'political',
        factionMode: 'neutral',
        factionIds: [],
        task: 'none',
        visibleFrom: 0,
        visibleTo: 12,
        z: 0,
        priority: 0,
        lodBias: 0,
        rounding: 0,
        gradient: { mode: 'auto', blend: 'linear', stops: [], overrides: [], splitAt: null, direction: 'along', seamVertex: null, version: 1 },
        override: false,
        label: null,
      }],
    })),
  };
}

const VIEWPORT = { w: 1000, h: 1000 };
const CAMERA = { centerX: 5000, centerY: 5000, visibleWidth: 10000 };

test('маска раздела прикрепляется к заливке своей области, вырезы — сторона другой', () => {
  const doc = docWithState();
  const maskA = {
    holes: [square(3200, 2500, 4000, 4000)],
    line: [[3250, 2500], [3250, 4000]],
    transitionHalfWidth: 0,
  };
  const masks = new Map([['area-1', [maskA]]]);
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => masks.get(id) ?? [] });
  assert.ok(paints.length >= 2);
  const forA = paints.filter((paint) => paint.areaId === 'area-1');
  const forB = paints.filter((paint) => paint.areaId === 'area-2');
  assert.ok(forA.length > 0);
  assert.ok(forA.every((paint) => paint.splits.length === 1 && paint.splits[0].holes.length === 1), 'маска у области А');
  assert.ok(forB.every((paint) => paint.splits.length === 0), 'у Б маски нет');
  // Обводка не прячется: check — у слоев есть stroke с теми же кольцами.
  assert.ok(forA[0].rings.length > 0);
});

test('маска не прикрепляется к открытой области и отсутствует без lookup', () => {
  const doc = docWithState();
  const openDoc = {
    ...doc,
    areas: doc.areas.map((area, index) => (index === 0
      ? { ...area, closed: false, rings: [[[1000, 1000], [4000, 1000], [4000, 4000]]] }
      : area)),
  };
  const paints = buildAreaPaints(openDoc, { level: 5, splitForArea: () => [{ holes: [], line: [], transitionHalfWidth: 0 }] });
  const forOpen = paints.filter((paint) => paint.areaId === 'area-1');
  assert.ok(forOpen.every((paint) => paint.splits.length === 0),
    'открытая область не получает вырезов заливки');
  const plain = buildAreaPaints(doc, { level: 5 });
  assert.ok(plain.every((paint) => paint.splits.length === 0));
});

test('сцена проецирует вырезы и линию раздела в экранные координаты', () => {
  const doc = docWithState();
  const maskA = {
    holes: [square(3000, 2500, 4000, 3500)],
    line: [[3250, 2500], [3250, 3500]],
    transitionHalfWidth: 120,
  };
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => (id === 'area-1' ? [maskA] : []) });
  const scene = areasFor(paints, VIEWPORT, CAMERA);
  const withSplit = scene.filter((area) => area.splits.length > 0);
  assert.ok(withSplit.length > 0);
  const split = withSplit[0].splits[0];
  assert.equal(split.holes.length, 1);
  // Мир 3000..4000 при видимой ширине 10000 и кадре 1000 px (0,1 px/ед.,
  // центр 5000): экран 300..400.
  const xs = split.holes[0].points.map((point) => point.x);
  assert.ok(Math.abs(Math.min(...xs) - 300) < 1.5, `левый край выреза ${Math.min(...xs).toFixed(1)}`);
  assert.ok(Math.abs(Math.max(...xs) - 400) < 1.5, `правый край выреза ${Math.max(...xs).toFixed(1)}`);
  assert.equal(split.line.length, 2);
  assert.ok(Math.abs(split.line[0].x - 325) < 1.5, 'линия раздела в экране');
  assert.equal(split.transitionHalfWidth, 120, 'полуширина остаётся в мировых единицах');
});

test('порядок наложения overlay: b-over-a поднимает Б поверх А, split не трогается', () => {
  const doc = docWithState();
  const paints = buildAreaPaints(doc, { level: 5 });
  const pairs = [{ mode: 'overlay', areaA: 'area-1', areaB: 'area-2', order: 'b-over-a' }];
  const ordered = applyPairOverlayOrder(paints, pairs);
  const maxZ = (id) => Math.max(...ordered.filter((paint) => paint.areaId === id).map((paint) => paint.z));
  assert.ok(maxZ('area-2') > maxZ('area-1'), 'Б поверх А при b-over-a');
  // B2: фактический порядок отрисовки тоже меняется — отрисовка идёт по
  // порядку массива, а не по полю z.
  const firstIndex = (list, id) => list.findIndex((paint) => paint.areaId === id);
  assert.ok(firstIndex(ordered, 'area-2') > firstIndex(ordered, 'area-1'), 'Б рисуется после А');
  const flipped = applyPairOverlayOrder(paints, [{ mode: 'overlay', areaA: 'area-1', areaB: 'area-2', order: 'a-over-b' }]);
  const maxZ2 = (id) => Math.max(...flipped.filter((paint) => paint.areaId === id).map((paint) => paint.z));
  assert.ok(maxZ2('area-1') > maxZ2('area-2'), 'А поверх Б при a-over-b');
  assert.ok(firstIndex(flipped, 'area-1') > firstIndex(flipped, 'area-2'), 'А рисуется после Б');
  // Split-пары порядок отрисовки не меняют.
  const untouched = applyPairOverlayOrder(paints, [{ mode: 'split', areaA: 'area-1', areaB: 'area-2', order: 'b-over-a' }]);
  assert.deepEqual(untouched.map((paint) => paint.z), paints.map((paint) => paint.z));
  // Обратимый: возврат к a-over-b после b-over-a снова поднимает А.
  const back = applyPairOverlayOrder(ordered, [{ mode: 'overlay', areaA: 'area-1', areaB: 'area-2', order: 'a-over-b' }]);
  const maxZ3 = (id) => Math.max(...back.filter((paint) => paint.areaId === id).map((paint) => paint.z));
  assert.ok(maxZ3('area-1') > maxZ3('area-2'));
  // Вход не мутируется.
  assert.deepEqual(paints.map((paint) => paint.z), buildAreaPaints(doc, { level: 5 }).map((paint) => paint.z));
});

test('маски двух пар на одну область приходят отдельными масками со своими линиями', () => {
  const doc = docWithState();
  doc.areas.push(createArea({ id: 'area-3', name: 'Гамма', rings: [square(1500, 1500, 3500, 3500)] }));
  const mask1 = { holes: [square(3000, 2500, 4000, 3500)], line: [[3250, 2500], [3250, 3500]], transitionHalfWidth: 0 };
  const mask2 = { holes: [square(1500, 1500, 2200, 2200)], line: [[1800, 1500], [1800, 2200]], transitionHalfWidth: 0 };
  // Каждая пара даёт свою маску: у области список масок, а не одна слитая —
  // линии раздела и полосы перехода остаются раздельными (B4.4).
  const masks = new Map([['area-1', [mask1, mask2]]]);
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => masks.get(id) ?? [] });
  const forA = paints.filter((paint) => paint.areaId === 'area-1');
  assert.equal(forA[0].splits.length, 2, 'обе маски в списке');
  assert.equal(forA[0].splits[0].holes.length, 1, 'первая маска со своим вырезом');
  assert.equal(forA[0].splits[1].holes.length, 1, 'вторая маска со своим вырезом');
  assert.deepEqual(forA[0].splits[1].line, mask2.line, 'у каждой маски своя линия раздела');
});

test('applyPairOverlayOrder сходится на многоступенчатых цепочках overlay и соблюдает порядок режимов MODES', () => {
  const basePaint = (areaId, mode, z) => ({
    areaId,
    stateId: `st-${areaId}-${mode}`,
    mode,
    label: null,
    z,
    fill: '#ffffff',
    stroke: '#ffffff',
    strokeWidth: 2,
    dash: [],
    alpha: 0.5,
    override: false,
    rings: [],
  });
  const paints = [
    basePaint('c', 'tension', 0),
    basePaint('a', 'military', 0),
    basePaint('a', 'political', 0),
    basePaint('b', 'political', 0),
  ];
  // Цепочка: b поверх a, c поверх b => порядок должен быть a < b < c, а внутри a: political < military.
  const ordered = applyPairOverlayOrder(paints, [
    { mode: 'overlay', areaA: 'b', areaB: 'c', order: 'b-over-a' },
    { mode: 'overlay', areaA: 'a', areaB: 'b', order: 'b-over-a' },
  ]);
  const indexOf = (id) => ordered.findIndex((p) => p.areaId === id);
  const lastIndexOf = (id) => ordered.map((p) => p.areaId).lastIndexOf(id);
  assert.ok(lastIndexOf('a') < indexOf('b'));
  assert.ok(lastIndexOf('b') < indexOf('c'));
  const modesOfA = ordered.filter((p) => p.areaId === 'a').map((p) => p.mode);
  assert.deepEqual(modesOfA, ['political', 'military']);
});

test('drawArea: DPR-слой с обводкой до destination-out, изоляция мягких переходов и evenodd-clip без DOM', () => {
  const mkCtx = (log) => ({
    save() { log.push({ fn: 'save' }); },
    restore() { log.push({ fn: 'restore' }); },
    beginPath() { log.push({ fn: 'beginPath' }); },
    rect(x, y, w, h) { log.push({ fn: 'rect', x, y, w, h }); },
    moveTo(x, y) { log.push({ fn: 'moveTo', x, y }); },
    lineTo(x, y) { log.push({ fn: 'lineTo', x, y }); },
    closePath() { log.push({ fn: 'closePath' }); },
    clip(rule) { log.push({ fn: 'clip', rule }); },
    fill(rule) { log.push({ fn: 'fill', rule }); },
    stroke() { log.push({ fn: 'stroke' }); },
    fillRect() {},
    clearRect(x, y, w, h) { log.push({ fn: 'clearRect', x, y, w, h }); },
    setTransform(...args) { log.push({ fn: 'setTransform', args }); },
    setLineDash(dash) { log.push({ fn: 'setLineDash', dash: [...dash] }); },
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
    arc() {},
    drawImage(src, x, y, w, h) { log.push({ fn: 'drawImage', srcW: src.width, srcH: src.height, x, y, w, h }); },
    measureText() { return { width: 10 }; },
    fillText() {},
    strokeText() {},
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
  });
  const doc = {
    ...docWithState(),
    areas: [
      ...docWithState().areas,
      createArea({ id: 'area-3', name: 'Гамма', rings: [square(1000, 1000, 2200, 2200)] }),
    ],
    pairs: [
      {
        id: 'pair-1',
        areaA: 'area-1',
        areaB: 'area-2',
        mode: 'split',
        order: 'a-over-b',
        forbidCrossing: false,
        transitionWidth: 120,
        line: { manual: true, points: [[3200, 2500], [3200, 4000]], anchors: [{ s: 0, point: [3200, 2500] }, { s: 1, point: [3200, 4000] }] },
        needsReview: false,
        note: null,
      },
      {
        id: 'pair-2',
        areaA: 'area-1',
        areaB: 'area-3',
        mode: 'split',
        order: 'a-over-b',
        forbidCrossing: false,
        transitionWidth: 120,
        line: { manual: true, points: [[1500, 1000], [1500, 2200]], anchors: [{ s: 0, point: [1500, 1000] }, { s: 1, point: [1500, 2200] }] },
        needsReview: false,
        note: null,
      },
    ],
  };

  const makeKernel = (mainCalls) => ({
    doc: null,
    canvas: null,
    ctx: mkCtx(mainCalls),
    fieldCanvas: null,
    field: null,
    state: {
      mapSize: 10000,
      dpr: 2,
      viewport: { w: 500, h: 400 },
      view: { tx: 0, ty: 0, scale: 0.05 },
      systems: [],
      systemsById: {},
      planets: [],
      planetsById: {},
      standalonePlaces: [],
      labels: [],
      labelsOn: false,
      searchIndex: [],
      factions: [],
      sectorBounds: null,
      sectorAreas: doc,
      focusMode: null,
      hoverId: null,
      selectedId: null,
      nebulaMode: 'none',
      frame: null,
      travel: { active: false, origin: null, target: null, path: [], roundTrip: false, activeStopIndex: -1, calculation: null },
    },
    theme: { bg: '#03060c', accent: '#24eadb', accent2: '#80a9da', text: '#e6f1ff', muted: '#8da2bd', warn: '#e8a35c', mono: 'monospace' },
    el: { mapStage: null },
    skin: null,
    links: null,
    runtime: { renderQueued: false, coordinateReadoutEnabled: false, coordinatePointer: null, travelCore: null, fieldContextLost: false },
    data: { mapSize: () => 10000, coordinateOnMap: () => true, factionsOf: () => [], systemFactions: () => [] },
    renderer: null,
    catalog: null,
    dossier: { renderDetail() {}, selectPlanet() {}, selectSystem() {}, clearDetail() {} },
    coords: { cancelPendingTravelTap() {}, updateZoomReadout() {}, updateCoordinateReadout() {}, isTravelAnimationActive: () => false, travelStops: () => [] },
    app: { toast() {} },
  });

  const renderOnce = (kernel) => {
    let pending = null;
    const prevRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => { pending = cb; return 1; };
    try {
      const renderer = createCanvasRenderer(kernel);
      kernel.renderer = renderer;
      renderer.requestRender();
      if (pending !== null) pending(16);
    } finally {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
    }
  };

  // 1. В браузерной среде (document есть): DPR=2 offscreen canvas (1000×800),
  // обводка на слое ДО destination-out и изоляция cross-holes мягкого перехода.
  const prevDoc = globalThis.document;
  const createdCanvases = [];
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const calls = [];
      const canvas = { width: 0, height: 0, calls, getContext: () => mkCtx(calls) };
      createdCanvases.push(canvas);
      return canvas;
    },
  };
  try {
    const mainCalls = [];
    renderOnce(makeKernel(mainCalls));
    assert.ok(createdCanvases.length >= 2, 'используются отдельные слои areaLayerCanvas и softLayerCanvas');
    const areaLayer = createdCanvases[0];
    assert.equal(areaLayer.width, 1000, 'ширина offscreen-слоя масштабирована на DPR=2');
    assert.equal(areaLayer.height, 800, 'высота offscreen-слоя масштабирована на DPR=2');
    const firstStroke = areaLayer.calls.findIndex((c) => c.fn === 'stroke');
    const firstDrawImage = areaLayer.calls.findIndex((c) => c.fn === 'drawImage');
    assert.ok(firstStroke >= 0 && firstDrawImage > firstStroke, 'обводка и вырезы на слое перед композицией');
    assert.ok(mainCalls.some((c) => c.fn === 'drawImage' && c.srcW === 1000 && c.w === 500), 'слой свёрстан 1:1 в CSS-координаты');
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }

  // 2. Без document (fallback-путь): обводка отсекается клипом [viewportRect, ...holes] с правилом evenodd.
  const fallbackMain = [];
  const savedDoc = globalThis.document;
  delete globalThis.document;
  try {
    renderOnce(makeKernel(fallbackMain));
    const evenOddClips = fallbackMain.filter((c) => c.fn === 'clip' && c.rule === 'evenodd');
    assert.ok(evenOddClips.length > 0, 'fallback использует evenodd-clip вокруг viewportRect и дырок');
    assert.ok(fallbackMain.some((c) => c.fn === 'rect' && c.w === 500 && c.h === 400));
  } finally {
    if (savedDoc !== undefined) globalThis.document = savedDoc;
  }
});
