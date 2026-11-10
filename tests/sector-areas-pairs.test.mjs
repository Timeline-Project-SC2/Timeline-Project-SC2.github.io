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
  autoDivideLines,
  buildInitialPairLine,
  computeAreaZoneGrid,
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
  zoneBoundaryPolygons,
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

/* ------------------------------------------------------- регрессии B4/S3/S4 */

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test('B4.1: полоса двойного наложения вдоль шва исчезает — все ячейки зоны разделены', () => {
  const grid = computeZoneGrid(rect(1000, 1000, 4000, 6000), rect(2500, 3000, 9000, 5000));
  assert.ok(grid !== null);
  const line = [[3250, 2900], [3250, 5100]];
  const masks = sideMasks(grid, line);
  let unassigned = 0;
  for (let index = 0; index < grid.zone.length; index += 1) {
    if (grid.zone[index] === 1 && masks.aSide[index] !== 1 && masks.bSide[index] !== 1) unassigned += 1;
  }
  assert.equal(unassigned, 0, 'каждая ячейка зоны относится к стороне А или Б');
});

test('B4.2: конец ручной линии внутри зоны не даёт утечки BFS — обе стороны существуют', () => {
  const grid = computeZoneGrid(rect(1000, 1000, 4000, 6000), rect(2500, 3000, 9000, 5000));
  assert.ok(grid !== null);
  // Верхний конец линии намеренно внесён внутрь линзы (500 единиц от края).
  const line = [[3250, 3500], [3250, 5100]];
  const masks = sideMasks(grid, line);
  let aCells = 0;
  let bCells = 0;
  for (let index = 0; index < grid.zone.length; index += 1) {
    if (grid.zone[index] !== 1) continue;
    if (masks.aSide[index] === 1) aCells += 1;
    if (masks.bSide[index] === 1) bCells += 1;
  }
  assert.ok(aCells > 0, 'сторона А существует');
  assert.ok(bCells > 0, 'сторона Б не съедена утечкой вокруг конца линии');
});

test('B4.3: вторая раздельная часть зоны делится автоматически, а не отдаётся одной стороне', () => {
  // U-область (одинокое кольцо с выемкой) и прямоугольник поверх обеих ног:
  // две раздельные линзы — левая и правая ноги U.
  const uShape = [
    [3000, 2000], [7000, 2000], [7000, 8000], [5500, 8000], [5500, 4000],
    [4500, 4000], [4500, 8000], [3000, 8000], [3000, 2000],
  ];
  const bar = rect(2000, 4500, 8000, 7000);
  const grid = computeZoneGrid(uShape, bar);
  assert.ok(grid !== null, 'зона U-области с прямоугольником строится');
  // Ручная линия только в левой ноге.
  const line = [[3750, 4400], [3750, 7100]];
  const masks = sideMasks(grid, line);
  let leftA = 0;
  let leftB = 0;
  let rightA = 0;
  let rightB = 0;
  for (let j = 0; j < grid.h; j += 1) {
    for (let i = 0; i < grid.w; i += 1) {
      const index = j * grid.w + i;
      if (grid.zone[index] !== 1) continue;
      const x = grid.x0 + (i + 0.5) * grid.cell;
      const isLeft = x >= 3000 && x <= 4500;
      const isRight = x >= 5500 && x <= 7000;
      if (!isLeft && !isRight) continue;
      if (masks.aSide[index] === 1) { if (isLeft) leftA += 1; else rightA += 1; }
      if (masks.bSide[index] === 1) { if (isLeft) leftB += 1; else rightB += 1; }
    }
  }
  assert.ok(leftA > 0 && leftB > 0, 'левая нога разделена линией на обе стороны');
  assert.ok(rightA > 0 && rightB > 0, 'правая нога без линии поделена автоправилом на обе стороны');
});

test('S3: перестановка А/Б даёт зеркальные маски (плато коллинеарных границ не перевешивает)', () => {
  const ringA = rect(1000, 3000, 9000, 5000);
  const ringB = rect(3000, 1000, 7000, 9000);
  const gridAB = computeZoneGrid(ringA, ringB);
  const gridBA = computeZoneGrid(ringB, ringA);
  assert.ok(gridAB !== null && gridBA !== null);
  const line = [[4970, 900], [5030, 9100]];
  const ab = sideMasks(gridAB, line);
  const ba = sideMasks(gridBA, line);
  let mismatch = 0;
  let total = 0;
  for (let index = 0; index < gridAB.zone.length; index += 1) {
    if (gridAB.zone[index] !== 1) continue;
    total += 1;
    const aOfAB = ab.aSide[index] === 1;
    const bOfBA = ba.bSide[index] === 1;
    if (aOfAB !== bOfBA) mismatch += 1;
  }
  assert.ok(total > 100, 'зона достаточно велика для сравнения');
  assert.ok(mismatch / total <= 0.02,
    `перестановка пары перевешивает разделение: ${mismatch} из ${total}`);
});

test('B1: сочетание областей со штрихами вместо колец строит автолинию и вырезы', () => {
  const strokeArea = (id, name, x0) => createArea({
    id,
    name,
    rings: [],
    strokes: [{ id: `stroke-${id}`, points: rect(x0, 1000, x0 + 3000, 4000), closed: true }],
    closed: true,
    source: 'brush',
  });
  const doc = {
    ...emptySectorAreasDoc(),
    areas: [strokeArea('area-1', 'Альфа', 1000), strokeArea('area-2', 'Бета', 2500)],
  };
  const { pair } = createPair(doc, 'area-1', 'area-2');
  assert.ok(pair.line !== null, 'автолиния для штриховых областей строится');
  const areaA = doc.areas[0];
  const areaB = doc.areas[1];
  const regions = splitRegionsForPair(areaA, areaB, pair);
  assert.ok(regions !== null, 'вырезы разделения для штриховых областей строятся');
  assert.ok(regions.aHoles.length > 0 && regions.bHoles.length > 0);
});

test('S4: needsReview снимается, когда ручная линия снова в зоне; снятие чистит заметку', () => {
  const base = docWithPair(false);
  const doc = base.doc;
  const pairId = base.pair.id;
  const flagged = markPairNeedsReview(doc, pairId, true, 'Контур изменился: линия вне зоны.');
  const afterFlag = pairsOf(flagged).find((entry) => entry.id === pairId);
  assert.equal(afterFlag.needsReview, true);
  const lineAfter = afterFlag.line;
  const cleared = markPairNeedsReview(flagged, pairId, false);
  const afterClear = pairsOf(cleared).find((entry) => entry.id === pairId);
  assert.equal(afterClear.needsReview, false);
  assert.equal(afterClear.note, null, 'снятие пометки убирает устаревшую заметку');
  // Геометрия не менялась: пересмотр возвращает линию в зону и чистит флаг.
  const reviewed = reviewPairsAfterGeometryChange(flagged, 'area-1');
  const afterReview = pairsOf(reviewed.doc).find((entry) => entry.id === pairId);
  assert.equal(afterReview.needsReview, false, 'линия в зоне — пометка снята');
  assert.equal(afterReview.note, null);
  assert.equal(lineAfter !== null, true);
});

test('многосвязная зона (остров + extraLines): раздельное деление компонент, редактирование по индексу и кламп', () => {
  const areaA = createArea({
    id: 'area-a',
    name: 'Два острова А',
    rings: [square(1000, 1000, 3000, 3000)],
    strokes: [{ id: 'a-island', points: [[6000, 1000], [8000, 1000], [8000, 3000], [6000, 3000]], closed: true }],
  });
  const areaB = createArea({
    id: 'area-b',
    name: 'Два острова Б',
    rings: [square(2000, 1500, 4000, 3500)],
    strokes: [{ id: 'b-island', points: [[7000, 1500], [9000, 1500], [9000, 3500], [7000, 3500]], closed: true }],
  });
  let doc = { ...emptySectorAreasDoc(), areas: [areaA, areaB] };
  const created = createPair(doc, 'area-a', 'area-b');
  doc = created.doc;
  const pair = created.pair;
  assert.ok(pair.line !== null, 'основная линия первой компоненты построена');
  assert.ok(pair.extraLines !== undefined && pair.extraLines.length === 1, 'дополнительная линия второй компоненты в extraLines');
  assert.match(String(pair.note ?? ''), /2 частей/);

  const grid = computeAreaZoneGrid(areaA, areaB);
  assert.ok(grid !== null);
  const divided = autoDivideLines(grid);
  assert.ok(divided !== null && divided.components === 2 && divided.lines.length === 2);
  const polyBounds = zoneBoundaryPolygons(grid);
  assert.ok(polyBounds.length >= 2, 'кламп-регион покрывает оба острова зоны');

  // Ручная правка второй компоненты (lineIndex = 1) не перетирает основную линию.
  const line0Before = pair.line.points;
  const second = pair.extraLines[0];
  doc = setPairLine(doc, pair.id, {
    manual: true,
    points: [[7450, 1550], [7550, 2950]],
    anchors: [{ s: 0, point: [7450, 1550] }, { s: 1, point: [7550, 2950] }],
  }, true, 1);
  const edited = pairsOf(doc).find((entry) => entry.id === pair.id);
  assert.deepEqual(edited.line.points, line0Before, 'основная линия компоненты 0 сохранена');
  assert.equal(edited.extraLines[0].manual, true);

  const regions = splitRegionsForPair(areaA, areaB, edited);
  assert.ok(regions !== null && regions.aHoles.length >= 2 && regions.bHoles.length >= 2);

  // Запрет пересечения проверяет и замкнутые штрихи (не только outer rings[0]).
  doc = setPairForbidCrossing(doc, pair.id, true);
  const separated = createArea({
    id: 'area-sep',
    name: 'Отделённая',
    rings: [square(100, 100, 500, 500)],
  });
  const docNoOverlap = {
    ...emptySectorAreasDoc(),
    areas: [separated, areaB],
    pairs: [{ ...edited, id: 'pair-sep', areaA: 'area-sep', areaB: 'area-b', forbidCrossing: true }],
  };
  assert.notEqual(
    crossingViolation(docNoOverlap, 'area-sep', [square(7200, 1800, 7800, 2400)]),
    null,
    'запрет пересечения учитывает попадание в замкнутый штрих-остров партнёра',
  );
  assert.ok(second.points.length >= 2);
});
