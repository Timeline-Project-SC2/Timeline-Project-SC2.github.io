/* Слой сочетания пары областей (§6 и §8 ТЗ SEC-AREAS-HIERARCHY): автолиния
 * равноудалённого раздела, стороны для рендера без светлого пятна, режимы
 * split/overlay с сохранением линии, запрет пересечения, пересмотр ручной
 * правки после изменения геометрии, независимость пар А+Б и А+В.
 *
 * Запуск: node --test tests/sector-areas-pairs.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArea,
  emptySectorAreasDoc,
  parseSectorAreas,
} from '../src/atlas/sector-areas-contract.ts';
import {
  PAIR_EQUAL_TOLERANCE,
  autoDivideLine,
  buildInitialPairLine,
  computeZoneGrid,
  createPair,
  crossingViolation,
  markPairNeedsReview,
  pairBetween,
  pairsOf,
  removePair,
  resetPairLineToAuto,
  setPairTransition,
  reviewPairsAfterGeometryChange,
  ringsIntersect,
  setPairForbidCrossing,
  setPairLine,
  setPairMode,
  setPairOrder,
  sideMasks,
  splitRegionsForPair,
  winPolygons,
} from '../src/atlas/sector-areas-pairs.ts';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

function docWithPair(forbid = false) {
  let doc = emptySectorAreasDoc();
  doc = {
    ...doc,
    areas: [
      createArea({ id: 'area-1', name: 'Альфа', rings: [square(1000, 1000, 4000, 4000)] }),
      createArea({ id: 'area-2', name: 'Бета', rings: [square(2500, 2500, 5500, 5500)] }),
      createArea({ id: 'area-3', name: 'Гамма', rings: [square(6000, 6000, 8000, 8000)] }),
    ],
  };
  const created = createPair(doc, 'area-1', 'area-2', { forbidCrossing: forbid });
  return { doc: created.doc, pair: created.pair };
}

test('§6.1: создание пары — устойчивые ID обеих областей, режим split по умолчанию', () => {
  const { doc, pair } = docWithPair();
  assert.equal(pair.areaA, 'area-1');
  assert.equal(pair.areaB, 'area-2');
  assert.equal(pair.mode, 'split');
  assert.equal(pair.order, 'a-over-b');
  assert.equal(pairsOf(doc).length, 1);
  assert.ok(pairBetween(doc, 'area-2', 'area-1') !== null, 'порядок А+Б и Б+А — одна пара');
  assert.equal(pairBetween(doc, 'area-1', 'area-3'), null, 'пара А+В независима и пока не создана');
});

test('§6.1: дубликат пары в любом порядке и пара с самой собой отклоняются', () => {
  const { doc } = docWithPair();
  assert.throws(() => createPair(doc, 'area-2', 'area-1'), RangeError);
  assert.throws(() => createPair(doc, 'area-1', 'area-1'), RangeError);
  assert.throws(() => createPair(doc, 'area-1', 'area-404'), RangeError);
});

test('§6.2: автолиния равноудалена от границ зоны пересечения', () => {
  const { pair } = docWithPair();
  assert.ok(pair.line !== null, 'для пересекающихся областей автолиния строится');
  const grid = computeZoneGrid(
    square(1000, 1000, 4000, 4000),
    square(2500, 2500, 5500, 5500),
  );
  assert.ok(grid !== null && grid.zoneCells >= 4);
  // Зона: x ∈ [2500, 4000]; равноудалённая линия — около x = 3250.
  for (const [x] of pair.line.points) {
    const i = Math.min(grid.w - 1, Math.max(0, Math.floor((x - grid.x0) / grid.cell)));
    const columnDiffs = [];
    for (let j = 0; j < grid.h; j += 1) {
      if (grid.zone[j * grid.w + i] === 1) {
        columnDiffs.push(Math.abs(grid.distA[j * grid.w + i] - grid.distB[j * grid.w + i]));
      }
    }
    if (columnDiffs.length === 0) continue;
    const nearest = Math.min(...columnDiffs);
    const scale = Math.max(grid.distA[0], 1);
    assert.ok(
      nearest <= Math.max(scale * PAIR_EQUAL_TOLERANCE, grid.cell),
      `точка линии (${Math.round(x)}) не равноудалена: минимальная разница ${Math.round(nearest)}`,
    );
  }
  // Линия вертикальна: средняя координата x около 3250.
  const meanX = pair.line.points.reduce((sum, [x]) => sum + x, 0) / pair.line.points.length;
  assert.ok(Math.abs(meanX - 3250) <= grid.cell * 1.5, `средняя x линии ${Math.round(meanX)}, ожидалось 3250`);
});

test('§6.2: у касающихся в одной точке областей зоны нет — автолиния null', () => {
  let doc = emptySectorAreasDoc();
  doc = {
    ...doc,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 3000, 3000)] }),
      createArea({ id: 'b', name: 'Б', rings: [square(3000, 3000, 5000, 5000)] }),
    ],
  };
  const { pair } = createPair(doc, 'a', 'b');
  assert.equal(pair.line, null, 'касание в точке не даёт зоны с площадью');
  assert.equal(pair.needsReview, false);
});

test('§6.2: стороны раздела покрывают зону без пересечений и годятся в вырезы', () => {
  const { pair } = docWithPair();
  const grid = computeZoneGrid(square(1000, 1000, 4000, 4000), square(2500, 2500, 5500, 5500));
  assert.ok(grid !== null);
  const masks = sideMasks(grid, pair.line?.points ?? []);
  let both = 0;
  let total = 0;
  for (let index = 0; index < grid.zone.length; index += 1) {
    if (grid.zone[index] !== 1) continue;
    total += 1;
    if (masks.aSide[index] === 1 && masks.bSide[index] === 1) both += 1;
  }
  assert.equal(both, 0, 'ячейка зоны не может принадлежать обеим сторонам');
  const polygons = winPolygons(grid, masks);
  assert.ok(polygons.aWin.length > 0, 'сторона А не трассируется');
  assert.ok(polygons.bWin.length > 0, 'сторона Б не трассируется');
  const split = splitRegionsForPair(
    { rings: [square(1000, 1000, 4000, 4000)] },
    { rings: [square(2500, 2500, 5500, 5500)] },
    pair,
  );
  assert.ok(split !== null);
  assert.ok(split.aHoles.length > 0 && split.bHoles.length > 0);
});

test('§6.3: режим overlay сохраняет линию раздела; возврат к split её восстанавливает', () => {
  let { doc, pair } = docWithPair();
  const originalPoints = pair.line?.points ?? [];
  assert.ok(originalPoints.length >= 2);
  doc = setPairMode(doc, pair.id, 'overlay');
  const asOverlay = pairsOf(doc).find((entry) => entry.id === pair.id);
  assert.equal(asOverlay.mode, 'overlay');
  assert.deepEqual(asOverlay.line?.points, originalPoints, 'наложение не уничтожает линию');
  // Явный порядок наложения — сохраняемый параметр пары.
  doc = setPairOrder(doc, pair.id, 'b-over-a');
  const asOverlayOrdered = pairsOf(doc).find((entry) => entry.id === pair.id);
  // Рендеру нечего вырезать в overlay: линии раздела в этом режиме нет.
  const overlayRegions = splitRegionsForPair(
    { rings: [square(1000, 1000, 4000, 4000)] },
    { rings: [square(2500, 2500, 5500, 5500)] },
    asOverlayOrdered,
  );
  assert.equal(overlayRegions, null);
  doc = setPairMode(doc, pair.id, 'split');
  const restored = pairsOf(doc).find((entry) => entry.id === pair.id);
  assert.equal(restored.mode, 'split');
  assert.equal(restored.order, 'b-over-a');
  assert.deepEqual(restored.line?.points, originalPoints, 'возврат к разделению восстанавливает правку');
});

test('§6.4: запрет пересечения отклоняет новое пересечение и объясняет отказ', () => {
  const { doc } = docWithPair(true);
  // Смещённое кольцо area-1 создаёт новое пересечение с area-2? Нет: они уже
  // пересекаются, правило не разрывает существующее. Берём непересекающуюся пару.
  let doc2 = emptySectorAreasDoc();
  doc2 = {
    ...doc2,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 3000, 3000)] }),
      createArea({ id: 'b', name: 'Б', rings: [square(5000, 1000, 7000, 3000)] }),
    ],
  };
  const created = createPair(doc2, 'a', 'b', { forbidCrossing: true });
  const doc3 = created.doc;
  assert.equal(crossingViolation(doc3, 'a', [square(1100, 1100, 3100, 3100)]), null,
    'непересекающаяся правка разрешена');
  const violation = crossingViolation(doc3, 'a', [square(4000, 1000, 6000, 3000)]);
  assert.ok(violation !== null, 'создание пересечения должно отклоняться');
  assert.ok(violation.includes('запрещено'), 'сообщение объясняет причину');
  assert.ok(violation.includes(created.pair.id), 'в сообщении названа пара');
  // Уже пересекающиеся области: правило не считает старое пересечение нарушением.
  const { doc: doc4 } = docWithPair(true);
  assert.equal(crossingViolation(doc4, 'area-1', [square(1050, 1050, 4050, 4050)]), null,
    'существующее пересечение не разрывается молча');
  // Выключенное правило не мешает.
  const { doc: doc5 } = docWithPair(false);
  assert.equal(crossingViolation(doc5, 'area-1', [square(4000, 1000, 6000, 3000)]), null);
});

test('§6.4: ringsIntersect видит рёбра, вложенность и раздельность', () => {
  assert.equal(ringsIntersect(square(0, 0, 100, 100), square(50, 50, 150, 150)), true);
  assert.equal(ringsIntersect(square(0, 0, 100, 100), square(10, 10, 20, 20)), true, 'вложенность');
  assert.equal(ringsIntersect(square(0, 0, 100, 100), square(200, 200, 300, 300)), false);
  assert.equal(ringsIntersect(square(0, 0, 100, 100), square(100, 0, 200, 100)), true, 'общее ребро');
});

test('§8: правка исходного контура не удаляет ручную линию молча', () => {
  let { doc, pair } = docWithPair();
  // Ручная линия строго внутри исходной зоны.
  const manualLine = {
    manual: true,
    points: [[3000, 2500], [3250, 3000], [3400, 3500]],
    anchors: [
      { s: 0, point: [3000, 2500] },
      { s: 0.5, point: [3250, 3000] },
      { s: 1, point: [3400, 3500] },
    ],
  };
  doc = setPairLine(doc, pair.id, manualLine, true);
  // Геометрия area-1 меняется так, что зона уезжает: якоря вне новой зоны.
  doc = {
    ...doc,
    areas: doc.areas.map((area) => (area.id === 'area-1'
      ? { ...area, rings: [square(1000, 5000, 4000, 8000)] }
      : area)),
  };
  const review = reviewPairsAfterGeometryChange(doc, 'area-1');
  const reviewed = pairsOf(review.doc).find((entry) => entry.id === pair.id);
  assert.equal(reviewed.needsReview, true, 'пара помечена «требует пересмотра»');
  assert.deepEqual(reviewed.line?.points, manualLine.points, 'ручная правка сохранена, а не стёрта');
  assert.ok((reviewed.note ?? '').length > 0, 'есть пояснение для пользователя');
});

test('§8: ручная линия, всё ещё в новой зоне, остаётся применённой', () => {
  let { doc, pair } = docWithPair();
  const manualLine = {
    manual: true,
    points: [[3200, 2600], [3250, 3200], [3200, 3800]],
    anchors: [
      { s: 0, point: [3200, 2600] },
      { s: 0.5, point: [3250, 3200] },
      { s: 1, point: [3200, 3800] },
    ],
  };
  doc = setPairLine(doc, pair.id, manualLine, true);
  // Небольшая правка area-2: зона почти не меняется, якоря остаются в ней.
  doc = {
    ...doc,
    areas: doc.areas.map((area) => (area.id === 'area-2'
      ? { ...area, rings: [square(2550, 2550, 5500, 5500)] }
      : area)),
  };
  const review = reviewPairsAfterGeometryChange(doc, 'area-2');
  const reviewed = pairsOf(review.doc).find((entry) => entry.id === pair.id);
  assert.equal(reviewed.needsReview, false, 'линия применима — пересмотр не нужен');
  assert.deepEqual(reviewed.line?.points, manualLine.points);
});

test('§8: автолиния перестраивается по новой геометрии без флага пересмотра', () => {
  let { doc, pair } = docWithPair();
  assert.ok(pair.line !== null && !pair.line.manual);
  const before = pair.line.points;
  doc = {
    ...doc,
    areas: doc.areas.map((area) => (area.id === 'area-2'
      ? { ...area, rings: [square(3000, 3000, 6000, 6000)] }
      : area)),
  };
  const review = reviewPairsAfterGeometryChange(doc, 'area-2');
  const reviewed = pairsOf(review.doc).find((entry) => entry.id === pair.id);
  assert.equal(reviewed.needsReview, false);
  assert.equal(reviewed.line?.manual, false);
  assert.ok(reviewed.line !== null, 'зона осталась — автолиния перестроена');
  assert.notDeepEqual(reviewed.line.points, before, 'автолиния изменилась вместе с геометрией');
});

test('§8: исчезновение зоны — автолиния обнулена, ручная сохранена, обе с пометкой', () => {
  let doc = emptySectorAreasDoc();
  doc = {
    ...doc,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 3000, 3000)] }),
      createArea({ id: 'b', name: 'Б', rings: [square(2000, 2000, 4000, 4000)] }),
    ],
  };
  let created = createPair(doc, 'a', 'b');
  const pairId = created.pair.id;
  const manual = { manual: true, points: [[2400, 2400], [2600, 2600]], anchors: [{ s: 0, point: [2400, 2400] }, { s: 1, point: [2600, 2600] }] };
  created = { doc: setPairLine(created.doc, pairId, manual, true), pair: created.pair };
  // Области разъезжаются: зоны пересечения больше нет.
  const moved = {
    ...created.doc,
    areas: created.doc.areas.map((area) => (area.id === 'b'
      ? { ...area, rings: [square(7000, 7000, 9000, 9000)] }
      : area)),
  };
  const review = reviewPairsAfterGeometryChange(moved, 'b');
  const reviewed = pairsOf(review.doc).find((entry) => entry.id === pairId);
  assert.equal(reviewed.needsReview, true);
  assert.deepEqual(reviewed.line?.points, manual.points, 'ручная линия не удалена');
  assert.ok(reviewed.note !== null);
  // Автолиния при исчезновении зоны обнуляется честно.
  let doc2 = emptySectorAreasDoc();
  doc2 = {
    ...doc2,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 3000, 3000)] }),
      createArea({ id: 'b', name: 'Б', rings: [square(2000, 2000, 4000, 4000)] }),
    ],
  };
  const autoPair = createPair(doc2, 'a', 'b');
  const moved2 = {
    ...autoPair.doc,
    areas: autoPair.doc.areas.map((area) => (area.id === 'b'
      ? { ...area, rings: [square(7000, 7000, 9000, 9000)] }
      : area)),
  };
  const review2 = reviewPairsAfterGeometryChange(moved2, 'b');
  const reviewed2 = pairsOf(review2.doc).find((entry) => entry.id === autoPair.pair.id);
  assert.equal(reviewed2.line, null, 'автолиния без зоны не выдумывается');
  assert.equal(reviewed2.needsReview, true);
});

test('§6.1: пары А+Б и А+В независимы: правка линии одной не трогает другую', () => {
  let doc = emptySectorAreasDoc();
  doc = {
    ...doc,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 4000, 4000)] }),
      createArea({ id: 'b', name: 'Б', rings: [square(2500, 2500, 5500, 5500)] }),
      createArea({ id: 'c', name: 'В', rings: [square(1000, 2500, 4000, 5500)] }),
    ],
  };
  const ab = createPair(doc, 'a', 'b');
  const ac = createPair(ab.doc, 'a', 'c');
  doc = ac.doc;
  assert.equal(pairsOf(doc).length, 2);
  const manualAB = { manual: true, points: [[3000, 3000], [3300, 3300]], anchors: [{ s: 0, point: [3000, 3000] }, { s: 1, point: [3300, 3300] }] };
  doc = setPairLine(doc, ab.pair.id, manualAB, true);
  doc = setPairMode(doc, ac.pair.id, 'overlay');
  const pairAB = pairsOf(doc).find((entry) => entry.id === ab.pair.id);
  const pairAC = pairsOf(doc).find((entry) => entry.id === ac.pair.id);
  assert.deepEqual(pairAB.line?.points, manualAB.points);
  assert.equal(pairAB.mode, 'split');
  assert.equal(pairAC.mode, 'overlay');
  assert.ok(pairAC.line !== null, 'у А+В своя автолиния');
  assert.notDeepEqual(pairAB.line?.points, pairAC.line?.points);
});

test('§9: документ с парами проходит экспорт → файл → импорт без потерь', () => {
  let { doc, pair } = docWithPair(true);
  doc = setPairTransition(doc, pair.id, 120);
  doc = markPairNeedsReview(doc, pair.id, false);
  const text = JSON.stringify(doc, null, 2);
  const parsed = parseSectorAreas(text);
  const restored = pairsOf(parsed).find((entry) => entry.id === pair.id);
  assert.ok(restored !== undefined);
  assert.equal(restored.forbidCrossing, true);
  assert.equal(restored.transitionWidth, 120);
  assert.deepEqual(restored.line?.points, pair.line?.points);
  assert.deepEqual(restored.line?.anchors, pair.line?.anchors);
  const again = parseSectorAreas(JSON.stringify(parsed));
  assert.deepEqual(again.pairs, parsed.pairs);
});

test('управление парами: удаление, сброс на автолинию, пометка пересмотра', () => {
  let { doc, pair } = docWithPair();
  doc = markPairNeedsReview(doc, pair.id, true, 'проверить вручную');
  let marked = pairsOf(doc).find((entry) => entry.id === pair.id);
  assert.equal(marked.needsReview, true);
  assert.equal(marked.note, 'проверить вручную');
  doc = resetPairLineToAuto(doc, pair.id);
  const reset = pairsOf(doc).find((entry) => entry.id === pair.id);
  assert.equal(reset.needsReview, false, 'сброс снимает пометку');
  assert.equal(reset.note, null);
  doc = removePair(doc, pair.id);
  assert.equal(pairsOf(doc).length, 0);
  assert.throws(() => removePair(doc, pair.id), RangeError);
  assert.throws(() => setPairMode(doc, pair.id, 'overlay'), RangeError);
});

test('§6.2: криволинейные несимметричные области — автолиния существует и внутри зоны', () => {
  const blob = (cx, cy, r, phase) => {
    const points = [];
    for (let index = 0; index < 14; index += 1) {
      const angle = (index / 14) * Math.PI * 2;
      const radius = r * (1 + 0.25 * Math.sin(angle * 3 + phase));
      points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
    }
    points.push(points[0]);
    return points;
  };
  const ringA = blob(3000, 3000, 1800, 0);
  const ringB = blob(4500, 3300, 1800, 1.2);
  let doc = emptySectorAreasDoc();
  doc = {
    ...doc,
    areas: [
      createArea({ id: 'a', name: 'А', rings: [ringA] }),
      createArea({ id: 'b', name: 'Б', rings: [ringB] }),
    ],
  };
  const { pair } = createPair(doc, 'a', 'b');
  const grid = computeZoneGrid(ringA, ringB);
  assert.ok(grid !== null && grid.zoneCells >= 4);
  assert.ok(pair.line !== null && pair.line.points.length >= 2, 'автолиния для кривых областей строится');
  const auto = autoDivideLine(grid);
  assert.ok(auto !== null);
  // Каждая точка автолинии — внутри зоны (с допуском в одну ячейку).
  for (const [x, y] of pair.line.points) {
    let near = false;
    for (let dj = -1; dj <= 1 && !near; dj += 1) {
      for (let di = -1; di <= 1 && !near; di += 1) {
        const i = Math.floor((x - grid.x0) / grid.cell) + di;
        const j = Math.floor((y - grid.y0) / grid.cell) + dj;
        if (i >= 0 && j >= 0 && i < grid.w && j < grid.h && grid.zone[j * grid.w + i] === 1) near = true;
      }
    }
    assert.ok(near, `точка автолинии (${Math.round(x)}, ${Math.round(y)}) вне зоны`);
  }
});

test('buildInitialPairLine: якоря автолинии стоят на линии и включают концы', () => {
  const areaA = createArea({ id: 'a', name: 'А', rings: [square(1000, 1000, 4000, 4000)] });
  const areaB = createArea({ id: 'b', name: 'Б', rings: [square(2500, 2500, 5500, 5500)] });
  const line = buildInitialPairLine(areaA, areaB);
  assert.ok(line !== null && !line.manual);
  assert.equal(line.anchors.length, 6, 'первый набор якорей открытой линии — шесть');
  assert.ok(line.anchors[0].s <= 0.01 && line.anchors[line.anchors.length - 1].s >= 0.99,
    'концы линии — крайние якоря');
});
