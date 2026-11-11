/* Иерархическая правка якорями (§4 и §7 ТЗ SEC-AREAS-HIERARCHY):
 * первые шесть якорей замкнутого контура равны по дуге и лежат на видимой
 * линии; уточнение сегмента даёт 2 старых + 4 новых якоря и не трогает другие
 * сегменты; перетаскивание локально, с защитой от петель и края карты;
 * открытая линия сочетания получает концы как крайние якоря и держит их
 * в области взаимодействия.
 *
 * Запуск: node --test tests/sector-areas-anchors.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANCHOR_COMMIT_TOLERANCE,
  ANCHOR_EQUAL_TOLERANCE,
  ANCHOR_MIN_GAP,
  anchorAtPoint,
  beginContourEdit,
  beginLineEdit,
  chainIntersections,
  commitDrag,
  commitLineDrag,
  curvePointAt,
  dragAnchor,
  projectOnCurve,
  reopenContourEdit,
  sampleLine,
  sampleRing,
  subdivideSegment,
} from '../src/atlas/sector-areas-anchors.ts';

/** Кольцо-«капля»: замкнутая несимметричная кривая из 12 вершин. */
function blobRing() {
  const points = [];
  const radius = (angle) => 2000 + 600 * Math.sin(angle * 2) + 300 * Math.cos(angle * 3);
  for (let index = 0; index < 12; index += 1) {
    const angle = (index / 12) * Math.PI * 2;
    points.push([5000 + radius(angle) * Math.cos(angle), 5000 + radius(angle) * Math.sin(angle) * 0.8]);
  }
  points.push(points[0]);
  return points;
}

/** Квадрат со скруглёнными углами — простой замкнутый контур. */
function squareRing(offset = 0) {
  return [
    [1000 + offset, 1000], [5000 + offset, 1000], [5000 + offset, 5000], [1000 + offset, 5000],
    [1000 + offset, 1000],
  ];
}

function openedRing(ring = blobRing()) {
  // Первый клик — точка на видимой линии (доля дуги 0,17 от старта кривой).
  const curve = sampleRing(ring);
  assert.ok(curve !== null, 'кривая кольца не построилась');
  const click = curvePointAt(curve, 0.17, true);
  const result = beginContourEdit(ring, click);
  assert.ok(result.ok, `первое деление не открылось: ${result.ok ? '' : result.reason}`);
  return result.ok ? result.state : null;
}

test('§4.1: первое деление даёт шесть якорей, равноудалённых по длине дуги', () => {
  const state = openedRing();
  assert.equal(state.anchors.length, 6);
  const curve = state.curve;
  const steps = [];
  for (let index = 0; index < 6; index += 1) {
    const current = state.anchors[index];
    const next = state.anchors[(index + 1) % 6];
    let step = (next.s - current.s) * curve.length;
    if (step < 0) step += curve.length;
    steps.push(step);
  }
  const expected = curve.length / 6;
  for (const step of steps) {
    assert.ok(Math.abs(step - expected) <= expected * ANCHOR_EQUAL_TOLERANCE,
      `шаг ${step} не равен ${expected} в пределах допуска`);
  }
});

test('§4.1: первый якорь стоит в точке клика на видимой линии, а не на хорде', () => {
  const ring = blobRing();
  const curve = sampleRing(ring);
  assert.ok(curve !== null);
  const click = curvePointAt(curve, 0.41, true);
  const result = beginContourEdit(ring, click);
  assert.ok(result.ok);
  const state = result.ok ? result.state : null;
  const projection = projectOnCurve(state.curve, click, true);
  const atClick = state.anchors.find((anchor) =>
    Math.hypot(anchor.point[0] - projection.point[0], anchor.point[1] - projection.point[1]) < 1e-6);
  assert.ok(atClick !== undefined, 'якорь должен стоять в ближайшей точке видимой линии');
  assert.ok(projection.distance < 24);
  for (const anchor of state.anchors) {
    const hit = projectOnCurve(state.curve, anchor.point, true);
    assert.ok(hit.distance < 1e-6, 'каждый якорь лежит на видимой линии');
  }
});

test('§4.2: уточнение сегмента — 2 старых якоря остаются, 4 новых, один в клике', () => {
  const state = openedRing();
  const before = state.anchors.map((anchor) => ({ s: anchor.s, point: anchor.point }));
  // Клик точно на видимую линию, в середину первого сегмента.
  const shifted = curvePointAt(state.curve, (state.anchors[0].s + state.anchors[1].s) / 2, true);
  const result = subdivideSegment(state, shifted);
  assert.ok(result.ok, `уточнение отклонено: ${result.ok ? '' : result.reason}`);
  const next = result.ok ? result.state : null;
  assert.equal(next.anchors.length, 10, '6 было + 4 новых');
  // Оба крайних якоря сегмента переиспользуются: их точки не двигались и не задвоились.
  const oldPoints = next.anchors.map((anchor) => anchor.point.map((v) => Math.round(v * 100) / 100).join(','));
  assert.equal(new Set(oldPoints).size, next.anchors.length, 'дубликатов якорей нет');
  for (const anchor of before) {
    assert.ok(next.anchors.some((candidate) =>
      Math.hypot(candidate.point[0] - anchor.point[0], candidate.point[1] - anchor.point[1]) < 1e-6),
      'старый якорь потерян');
  }
  // Один новый якорь — точно в точке клика (ближайшей точке линии).
  const hit = projectOnCurve(next.curve, shifted, true);
  assert.ok(next.anchors.some((candidate) =>
    Math.hypot(candidate.point[0] - hit.point[0], candidate.point[1] - hit.point[1]) < 1e-6),
    'якорь в точке клика отсутствует');
});

test('§4.2: деление между новыми якорями делит только свой сегмент', () => {
  const state = openedRing();
  const mid = curvePointAt(state.curve, (state.anchors[2].s + state.anchors[3].s) / 2, true);
  const once = subdivideSegment(state, [mid[0], mid[1]]);
  assert.ok(once.ok);
  const first = once.ok ? once.state : null;
  const sub = curvePointAt(first.curve, (first.anchors[4].s + first.anchors[5].s) / 2, true);
  const twice = subdivideSegment(first, [sub[0], sub[1]]);
  assert.ok(twice.ok, 'повторное уточнение разрешено');
  const second = twice.ok ? twice.state : null;
  assert.equal(second.anchors.length, 14, '10 + 4 после второго уточнения');
  // Якоря, не принадлежавшие сегменту, не сдвинулись.
  for (const anchor of first.anchors) {
    const still = second.anchors.find((candidate) =>
      Math.hypot(candidate.point[0] - anchor.point[0], candidate.point[1] - anchor.point[1]) < 1e-6);
    assert.ok(still !== undefined, 'чужой якорь изменился при уточнении');
  }
});

test('§4.2: клик слишком близко к существующему якорю отклоняется с сообщением', () => {
  const state = openedRing();
  const anchor = state.anchors[1];
  const nearClick = projectOnCurve(state.curve, [anchor.point[0] + 3, anchor.point[1]], true);
  const result = subdivideSegment(state, nearClick.point);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reason.includes('близк'), `сообщение должно объяснять отказ, а было: ${result.reason}`);
  }
});

test('§4.3: перетаскивание локально — якоря и вершины вне окна не двигаются', () => {
  const state = openedRing();
  const farAnchor = state.anchors[3];
  const target = [farAnchor.point[0] + 300, farAnchor.point[1] + 200];
  const drag = dragAnchor(state, 3, target);
  assert.ok(drag.ok, `тяга отклонена: ${drag.ok ? '' : drag.reason}`);
  const dragged = drag.ok ? drag.state : null;
  // Противоположный якорь (вне окна) не сдвинулся ни на единицу.
  const opposite = dragged.anchors[0];
  assert.ok(Math.hypot(opposite.point[0] - state.anchors[0].point[0], opposite.point[1] - state.anchors[0].point[1]) < 1e-9);
  // Точки кривой вне окна совпадают с базой.
  let movedOutside = 0;
  for (let index = 0; index < dragged.curve.points.length; index += 1) {
    const a = dragged.curve.points[index];
    const b = state.curve.points[index];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) movedOutside += 1;
  }
  const total = dragged.curve.points.length;
  assert.ok(movedOutside < total / 3, `сдвинулось слишком много точек: ${movedOutside} из ${total}`);
});

test('§4.3: после коммита кольцо следует деформации, якоря перепривязаны', () => {
  const state = openedRing(squareRing());
  assert.ok(state !== null);
  const anchor = state.anchors[0];
  const target = [anchor.point[0], anchor.point[1] - 400];
  const drag = dragAnchor(state, 0, target);
  assert.ok(drag.ok);
  const baked = commitDrag(drag.ok ? drag.state : null);
  // Окно дочищается точками кривой: вершин не меньше исходных.
  assert.ok(baked.ring.length >= state.ring.length, 'дочистка окна не должна терять вершины');
  assert.equal(baked.preview, null);
  // Каждый якорь остаётся на новой видимой кривой.
  for (const anchorPoint of baked.anchors) {
    const hit = projectOnCurve(baked.curve, anchorPoint.point, true);
    assert.ok(hit.distance <= ANCHOR_COMMIT_TOLERANCE,
      `якорь отошёл от записанной кривой на ${hit.distance}`);
  }
  // Якорь, который тянули, остался в целевой точке.
  const draggedAnchor = baked.anchors.find((candidate) =>
    Math.hypot(candidate.point[0] - target[0], candidate.point[1] - target[1]) <= ANCHOR_COMMIT_TOLERANCE);
  assert.ok(draggedAnchor !== undefined, 'перетаскиванный якорь не остался в целевой точке');
});

test('§4.3: тяга, разворачивающая петлю, отклоняется с сообщением, данные целы', () => {
  // Тонкий прямоугольник: тяга через всю фигуру гарантированно складывает линию.
  const ring = [
    [3000, 4800], [7000, 4800], [7000, 5200], [3000, 5200], [3000, 4800],
  ];
  const curve = sampleRing(ring);
  assert.ok(curve !== null);
  const opened = beginContourEdit(ring, curvePointAt(curve, 0.0, true));
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  const baseLoops = chainIntersections(state.curve.points, true);
  const anchor = state.anchors[0];
  const drag = dragAnchor(state, 0, [anchor.point[0] + 3500, anchor.point[1]]);
  if (drag.ok) {
    const baked = commitDrag(drag.state);
    assert.ok(chainIntersections(baked.curve.points, true) <= baseLoops, 'коммит создал петлю');
  } else {
    assert.ok(drag.reason.length > 0, 'отказ объяснён');
  }
  // Кольцо хранится без повторной конечной точки: 5 записей с швом → 4 вершины.
  assert.equal(state.ring.length, ring.length - 1);
});

test('§4.3: тяга за край карты сжимается или отклоняется — точки в поле', () => {
  const ring = squareRing();
  const curve = sampleRing(ring);
  assert.ok(curve !== null);
  const opened = beginContourEdit(ring, curvePointAt(curve, 0.375, true));
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  const anchor = state.anchors[0];
  const drag = dragAnchor(state, 0, [anchor.point[0] - 5000, anchor.point[1]]);
  if (drag.ok) {
    for (const [x, y] of drag.state.curve.points) {
      assert.ok(x >= 0 && x <= 10000 && y >= 0 && y <= 10000, 'точка кривой вышла за поле карты');
    }
  }
});

test('§4.3: короткие сегменты не уточняются — совпадающие якоря не создаются', () => {
  const ring = [
    [4000, 4000], [4200, 4000], [4400, 4010], [4400, 4200], [4000, 4200], [4000, 4000],
  ];
  const curve = sampleRing(ring);
  assert.ok(curve !== null);
  const opened = beginContourEdit(ring, curvePointAt(curve, 0.25, true));
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  // Клик рядом с существующим якорем (5 единиц) — отказ по минимальному зазору.
  const anchor = state.anchors[2];
  const near = subdivideSegment(state, [anchor.point[0] + 5, anchor.point[1]]);
  assert.equal(near.ok, false);
});

test('§4.3: повторное открытие по сохранённым якорям восстанавливает правку', () => {
  const state = openedRing();
  const baked = commitDrag(dragAnchor(state, 2, [
    state.anchors[2].point[0] + 150,
    state.anchors[2].point[1] - 100,
  ]).ok ? dragAnchor(state, 2, [
    state.anchors[2].point[0] + 150,
    state.anchors[2].point[1] - 100,
  ]).state : null);
  const saved = baked.anchors.map((anchor) => ({ s: anchor.s, point: anchor.point }));
  const reopened = reopenContourEdit(baked.ring, saved);
  assert.ok(reopened.ok);
  const restored = reopened.ok ? reopened.state : null;
  assert.equal(restored.anchors.length, 6);
  assert.ok(reopened.maxDrift <= ANCHOR_COMMIT_TOLERANCE + 1e-6, 'якоря не должны терять линию после загрузки');
  for (const anchor of saved) {
    const found = restored.anchors.find((candidate) =>
      Math.hypot(candidate.point[0] - anchor.point[0], candidate.point[1] - anchor.point[1]) < 1e-6);
    assert.ok(found !== undefined, 'якорь потерян при повторном открытии');
  }
});

test('§7: первое деление открытой линии — концы крайние, клик в точке клика', () => {
  const line = [[1000, 5000], [3000, 4800], [5000, 5200], [7000, 5000], [9000, 5000]];
  const curve = sampleLine(line);
  assert.ok(curve !== null);
  const click = curvePointAt(curve, 0.42, false);
  const result = beginLineEdit(line, click);
  assert.ok(result.ok, `линия не открылась: ${result.ok ? '' : result.reason}`);
  const state = result.ok ? result.state : null;
  assert.equal(state.anchors.length, 6);
  assert.ok(Math.hypot(state.anchors[0].point[0] - 1000, state.anchors[0].point[1] - 5000) < 1e-6,
    'начало линии не стало якорем');
  const last = state.anchors[state.anchors.length - 1];
  assert.ok(Math.hypot(last.point[0] - 9000, last.point[1] - 5000) < 1e-6, 'конец линии не стал якорем');
  const hit = projectOnCurve(state.curve, click, false);
  assert.ok(state.anchors.some((anchor) =>
    Math.hypot(anchor.point[0] - hit.point[0], anchor.point[1] - hit.point[1]) < 1e-6),
    'якорь в точке клика отсутствует');
  // Якорь клика лежит между концами и центром: доля дуги в рабочем диапазоне.
  const clickAnchor = state.anchors.find((anchor) => anchor.s > 0.2 && anchor.s < 0.45);
  assert.ok(clickAnchor !== undefined);
});

test('§7: конец открытой линии не выходит за область взаимодействия', () => {
  const line = [[4000, 4000], [6000, 4000], [6000, 6000], [4000, 6000]];
  const curve = sampleLine(line);
  assert.ok(curve !== null);
  const result = beginLineEdit(line, curvePointAt(curve, 0.2, false));
  assert.ok(result.ok);
  const state = result.ok ? result.state : null;
  const zone = [[3800, 3800], [6200, 3800], [6200, 6200], [3800, 6200]];
  const drag = dragAnchor(state, 0, [1000, 1000], zone);
  assert.ok(drag.ok);
  const dragged = drag.ok ? drag.state : null;
  assert.equal(drag.limited, true, 'ограничение конца должно быть помечено');
  const end = dragged.anchors[0];
  assert.ok(end.point[0] >= 3800 && end.point[0] <= 6200 && end.point[1] >= 3800 && end.point[1] <= 6200,
    `конец вышел из зоны: ${end.point}`);
  // Внутренний якорь свободен от ограничения зоны: тяга применима без clamp.
  const inner = dragAnchor(dragged, 2, [5200, 4600]);
  assert.ok(inner.ok, 'внутренний якорь должен тянуться без ограничения зоны');
});

test('§7: коммит линии пересэмплируется и сохраняет якоря на линии', () => {
  const line = [[1000, 5000], [3000, 4800], [5000, 5200], [7000, 5000], [9000, 5000]];
  const curve = sampleLine(line);
  assert.ok(curve !== null);
  const result = beginLineEdit(line, curvePointAt(curve, 0.5, false));
  assert.ok(result.ok);
  const state = result.ok ? result.state : null;
  const drag = dragAnchor(state, 3, [state.anchors[3].point[0], state.anchors[3].point[1] + 500]);
  assert.ok(drag.ok);
  const baked = commitLineDrag(drag.state);
  assert.ok(baked.points.length >= 8, 'записанная линия слишком грубая');
  const storedCurve = sampleLine(baked.points);
  assert.ok(storedCurve !== null);
  for (const anchor of baked.anchors) {
    const hit = projectOnCurve(storedCurve, anchor.point, false);
    assert.ok(hit.distance <= ANCHOR_COMMIT_TOLERANCE, 'якорь линии отошёл от записанной линии');
  }
});

test('выбор якоря: ближайший в допуске, мимо допуска — null', () => {
  const state = openedRing();
  const anchor = state.anchors[4];
  assert.equal(anchorAtPoint(state, [anchor.point[0] + 1, anchor.point[1] + 1], 16)?.index, 4);
  assert.equal(anchorAtPoint(state, [9999, 9999], 16), null);
});

test('минимальный зазор между якорями соблюдён при любой тяге', () => {
  const state = openedRing(squareRing());
  const anchor = state.anchors[0];
  // Тянем якорь в сторону соседа — сжатие ограничивается зазором.
  const neighbour = state.anchors[1];
  const direction = [neighbour.point[0] - anchor.point[0], neighbour.point[1] - anchor.point[1]];
  const drag = dragAnchor(state, 0, [anchor.point[0] + direction[0] * 0.98, anchor.point[1] + direction[1] * 0.98]);
  assert.ok(drag.ok, `тяга к соседу отклонена целиком: ${drag.ok ? '' : drag.reason}`);
  const dragged = drag.ok ? drag.state : null;
  const first = dragged.anchors[0];
  const second = dragged.anchors[1];
  const distance = Math.hypot(first.point[0] - second.point[0], first.point[1] - second.point[1]);
  assert.ok(distance >= ANCHOR_MIN_GAP - 1e-6, `якоря слиплись: ${distance}`);
});

/* ---------------------------------------------------------- регрессии B3/S2 */

function octagon() {
  // Восьмиугольник с центром (5000, 5000), первая вершина — шов замыкания.
  const points = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    points.push([5000 + 2500 * Math.cos(angle), 5000 + 2500 * Math.sin(angle)]);
  }
  return [...points, points[0]];
}

test('B3: коммит тяги якоря через шов замыкания сохраняет перенос, а не откатывает', () => {
  const ring = octagon();
  const opened = beginContourEdit(ring, [7500, 5000]);
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  // Якорь 0 стоит на шве: его окно тянется назад через s = 1 в начало списка.
  const before = state.anchors[0].point;
  const target = [before[0] - 150, before[1] + 350];
  const dragged = dragAnchor(state, 0, target);
  assert.ok(dragged.ok, dragged.ok ? '' : dragged.reason);
  const baked = commitDrag(dragged.state);
  // Перенос не теряется: ближайшая точка записанного кольца — у цели.
  const bakedCurve = sampleRing(baked.ring);
  assert.ok(bakedCurve !== null);
  const hit = projectOnCurve(bakedCurve, target, true);
  const moved = Math.hypot(before[0] - target[0], before[1] - target[1]);
  assert.ok(hit.distance <= moved * 0.15 + 2,
    `перенос потерян при коммите: ${hit.distance.toFixed(1)} из ${moved.toFixed(1)}`);
  // Якоря не задвоены и остались на кривой.
  assert.equal(baked.anchors.length, state.anchors.length);
  for (const anchor of baked.anchors) {
    const back = projectOnCurve(bakedCurve, anchor.point, true);
    assert.ok(back.distance <= ANCHOR_COMMIT_TOLERANCE, 'якорь отошёл от записанной кривой');
  }
});

test('B3: тяга с самопересечением зажимается бинарным поиском, а не отклоняется', () => {
  const ring = [[200, 1000], [1500, 1000], [1500, 2500], [200, 2500], [200, 1000]];
  const opened = beginContourEdit(ring, [200, 1750]);
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  const before = state.anchors[0].point;
  const drag = dragAnchor(state, 0, [2000, 1750]);
  assert.ok(drag.ok, `плавный зажим обязан работать: ${drag.ok ? '' : drag.reason}`);
  if (!drag.ok) return;
  assert.equal(drag.limited, true, 'ограниченная тяга помечается limited');
  const dragged = drag.state.anchors[0].point;
  const full = Math.hypot(2000 - before[0], 1750 - before[1]);
  const achieved = Math.hypot(dragged[0] - before[0], dragged[1] - before[1]);
  assert.ok(achieved > full * 0.1, `зажим слишком сильный: ${achieved.toFixed(1)} из ${full.toFixed(1)}`);
  assert.ok(achieved < full * 0.98, 'зажим должен остановить тягу до полной петли');
  assert.equal(chainIntersections(drag.state.preview ?? [], true), 0, 'предпросмотр без самопересечений');
});

test('S2: minGap из опций масштабирует запрет слишком близкого клика', () => {
  const ring = octagon();
  const opened = beginContourEdit(ring, [7500, 5000]);
  assert.ok(opened.ok);
  const state = opened.ok ? opened.state : null;
  const curve = state.activeCurve;
  // Точка на расстоянии трёх единиц дуги от якоря 1.
  const near = curvePointAt(curve, state.anchors[1].s + 3 / curve.length, true);
  const rejected = subdivideSegment(state, near, Number.POSITIVE_INFINITY);
  assert.equal(rejected.ok, false, 'без опций клик у якоря отклоняется');
  const allowed = subdivideSegment(state, near, Number.POSITIVE_INFINITY, { minGap: 1 });
  assert.equal(allowed.ok, true, 'с уменьшенным minGap уточнение проходит');
});
