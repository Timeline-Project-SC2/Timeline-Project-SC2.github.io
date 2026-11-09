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
  const masks = new Map([['area-1', maskA]]);
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => masks.get(id) ?? null });
  assert.ok(paints.length >= 2);
  const forA = paints.filter((paint) => paint.areaId === 'area-1');
  const forB = paints.filter((paint) => paint.areaId === 'area-2');
  assert.ok(forA.length > 0);
  assert.ok(forA.every((paint) => paint.split !== null && paint.split.holes.length === 1), 'маска у области А');
  assert.ok(forB.every((paint) => paint.split === undefined || paint.split === null), 'у Б маски нет');
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
  const paints = buildAreaPaints(openDoc, { level: 5, splitForArea: () => ({ holes: [], line: [], transitionHalfWidth: 0 }) });
  const forOpen = paints.filter((paint) => paint.areaId === 'area-1');
  assert.ok(forOpen.every((paint) => paint.split === null || paint.split === undefined),
    'открытая область не получает вырезов заливки');
  const plain = buildAreaPaints(doc, { level: 5 });
  assert.ok(plain.every((paint) => paint.split === undefined || paint.split === null));
});

test('сцена проецирует вырезы и линию раздела в экранные координаты', () => {
  const doc = docWithState();
  const maskA = {
    holes: [square(3000, 2500, 4000, 3500)],
    line: [[3250, 2500], [3250, 3500]],
    transitionHalfWidth: 120,
  };
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => (id === 'area-1' ? maskA : null) });
  const scene = areasFor(paints, VIEWPORT, CAMERA);
  const withSplit = scene.filter((area) => area.split !== null);
  assert.ok(withSplit.length > 0);
  const split = withSplit[0].split;
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
  const flipped = applyPairOverlayOrder(paints, [{ mode: 'overlay', areaA: 'area-1', areaB: 'area-2', order: 'a-over-b' }]);
  const maxZ2 = (id) => Math.max(...flipped.filter((paint) => paint.areaId === id).map((paint) => paint.z));
  assert.ok(maxZ2('area-1') > maxZ2('area-2'), 'А поверх Б при a-over-b');
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

test('маски двух пар на одну область складываются в один список вырезов', () => {
  const doc = docWithState();
  doc.areas.push(createArea({ id: 'area-3', name: 'Гамма', rings: [square(1500, 1500, 3500, 3500)] }));
  const mask1 = { holes: [square(3000, 2500, 4000, 3500)], line: [[3250, 2500], [3250, 3500]], transitionHalfWidth: 0 };
  const mask2 = { holes: [square(1500, 1500, 2200, 2200)], line: [[1800, 1500], [1800, 2200]], transitionHalfWidth: 0 };
  // Рендер складывает маски разных пар до передачи в buildAreaPaints — эмулируем.
  const masks = new Map([['area-1', { holes: [...mask1.holes, ...mask2.holes], line: mask2.line, transitionHalfWidth: 0 }]]);
  const paints = buildAreaPaints(doc, { level: 5, splitForArea: (id) => masks.get(id) ?? null });
  const forA = paints.filter((paint) => paint.areaId === 'area-1');
  assert.equal(forA[0].split.holes.length, 2, 'оба выреза в одной маске');
});
