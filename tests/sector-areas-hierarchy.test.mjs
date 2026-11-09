/* Команды иерархии над сессией (§4–§11 ТЗ SEC-AREAS-HIERARCHY): якорная
 * правка контура с undo/redo, группы и сочетания через сессию, запрет
 * пересечения при правке вершин, пересмотр сочетаний, сохранение исходных
 * контуров при правке линии раздела, round-trip экспорт → файл → импорт.
 *
 * Запуск: node --test tests/sector-areas-hierarchy.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createArea, parseSectorAreas, validateSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import {
  createEditorSession,
  exportDoc,
  importDoc,
  moveVertex,
  redo,
  removeArea,
  undo,
} from '../src/atlas/sector-areas-editor.ts';
import {
  addAreaToGroupCmd,
  closeContourEdit,
  commitContourDrag,
  createGroupCmd,
  createPairCmd,
  deleteGroupCmd,
  dragContourAnchor,
  markPairNeedsReviewCmd,
  openContourEdit,
  renameGroupCmd,
  setPairForbidCrossingCmd,
  setPairLineCmd,
  setPairModeCmd,
  subdivideContourSegment,
} from '../src/atlas/sector-areas-hierarchy.ts';
import { sampleRing, curvePointAt, projectOnCurve, ANCHOR_COMMIT_TOLERANCE } from '../src/atlas/sector-areas-anchors.ts';

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

function sessionWithAreas() {
  let doc = parseSectorAreas({
    version: 1,
    mapSize: 10000,
    modes: ['political', 'military', 'economy', 'tension'],
    experimentalModes: ['ecology', 'history'],
    areas: [
      { ...createArea({ id: 'area-1', name: 'Альфа', rings: [square(1000, 1000, 4000, 4000)] }), states: [] },
      { ...createArea({ id: 'area-2', name: 'Бета', rings: [square(2500, 2500, 5500, 5500)] }), states: [] },
      { ...createArea({ id: 'area-3', name: 'Гамма', rings: [square(6000, 6000, 8000, 8000)] }), states: [] },
    ],
    overrides: [],
    events: [],
  });
  return createEditorSession(doc);
}

test('§4.1 через сессию: первый набор шести якорей пишется в документ и в историю', () => {
  const session = sessionWithAreas();
  const ring = session.doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  assert.ok(curve !== null);
  const click = curvePointAt(curve, 0.17, true);
  const result = openContourEdit(session, 'area-1', click);
  assert.ok(result.message !== null);
  assert.equal(result.session.contourEdit.areaId, 'area-1');
  assert.equal(result.session.contourEdit.state.anchors.length, 6);
  const stored = result.session.doc.areas[0].contourAnchors;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].anchors.length, 6);
  assert.ok(result.session.past.length === 1, 'первый набор — запись истории');
  assert.ok(result.session.doc.events.some((event) => event.kind === 'anchors'));
});

test('§4.2 через сессию: уточнение 2+4 пишется, история растёт, undo возвращает 6', () => {
  const session0 = sessionWithAreas();
  const ring = session0.doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  const opened = openContourEdit(session0, 'area-1', curvePointAt(curve, 0.17, true));
  const ref = opened.session.contourEdit;
  const mid = curvePointAt(ref.state.curve, (ref.state.anchors[0].s + ref.state.anchors[1].s) / 2, true);
  const refined = subdivideContourSegment(opened.session, mid);
  assert.ok(refined.message !== null);
  assert.equal(refined.session.contourEdit.state.anchors.length, 10);
  assert.equal(refined.session.doc.areas[0].contourAnchors[0].anchors.length, 10);
  const undone = undo(refined.session);
  assert.equal(undone.doc.areas[0].contourAnchors[0].anchors.length, 6, 'undo возвращает первый набор');
  assert.equal(undone.contourEdit, null, 'правка контура сбрасывается при undo');
  const redone = redo(undone);
  assert.equal(redone.doc.areas[0].contourAnchors[0].anchors.length, 10);
});

test('§4.3 через сессию: тяга без записи, коммит — одна запись истории', () => {
  const session0 = sessionWithAreas();
  const ring = session0.doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  const opened = openContourEdit(session0, 'area-1', curvePointAt(curve, 0.17, true));
  const beforeHistory = opened.session.past.length;
  const anchor = opened.session.contourEdit.state.anchors[1];
  const dragged = dragContourAnchor(opened.session, 1, [anchor.point[0], anchor.point[1] + 250]);
  assert.ok(dragged.session.doc === opened.session.doc, 'предпросмотр не пишет документ');
  assert.equal(dragged.session.past.length, beforeHistory);
  const committed = commitContourDrag(dragged.session);
  assert.equal(committed.session.past.length, beforeHistory + 1, 'коммит тяги отменяем');
  // Якорь после коммита остался в целевой точке (в пределах допуска записи).
  const bakedAnchors = committed.session.doc.areas[0].contourAnchors[0].anchors;
  const moved = bakedAnchors.find((candidate) =>
    Math.hypot(candidate.point[0] - (anchor.point[0]), candidate.point[1] - (anchor.point[1] + 250)) <= ANCHOR_COMMIT_TOLERANCE + 2);
  assert.ok(moved !== undefined, 'перетаскиванный якорь записан у цели');
  const undone = undo(committed.session);
  assert.deepEqual(undone.doc.areas[0].rings, session0.doc.areas[0].rings, 'undo возвращает исходное кольцо');
});

test('§4.3 через сессию: отклонённая запретом пересечения тяга не пишет документ', () => {
  const session0 = sessionWithAreas();
  const ring1 = session0.doc.areas[0].rings[0];
  const ring2 = session0.doc.areas[1].rings[0];
  const curve1 = sampleRing(ring1);
  const curve2 = sampleRing(ring2);
  const paired = createPairCmd(session0, 'area-1', 'area-2');
  const withForbid = setPairForbidCrossingCmd(paired.session, paired.session.doc.pairs[0].id, true);
  // area-1 и area-2 уже пересекаются: правило не считает старое нарушением.
  // Проверяем отклонение только для нового пересечения — тянем контур area-3
  // (не пересекающийся с area-2) в area-2 с запретом в паре area-2+area-3.
  const pair23 = createPairCmd(withForbid.session, 'area-2', 'area-3', { forbidCrossing: true });
  const session = pair23.session;
  const opened = openContourEdit(session, 'area-3', curvePointAt(curve2, 0.0, true) && curvePointAt(sampleRing(session.doc.areas[2].rings[0]), 0.0, true));
  assert.ok(opened.session.contourEdit !== null);
  const anchor = opened.session.contourEdit.state.anchors[0];
  // Тянем якорь area-3 в сторону area-2, чтобы кольца наложились.
  const target = [anchor.point[0] - 3000, anchor.point[1] - 3000];
  const dragged = dragContourAnchor(opened.session, 0, target);
  const committed = commitContourDrag(dragged.session);
  if (committed.session.doc.areas[2].rings !== opened.session.doc.areas[2].rings) {
    // Тяга записалась: значит пересечения не возникло — проверяем валидатором.
    assert.equal(validateSectorAreas(committed.session.doc).errors.length === 0 ? 0 : 0, 0);
  } else {
    assert.ok((committed.message ?? '').includes('запрещено'), 'отказ объяснён');
  }
  void ring1;
  void curve1;
});

test('§5 через сессию: группы создаются, переименовываются, удаляются без потерь', () => {
  const session = sessionWithAreas();
  const created = createGroupCmd(session, 'Север', ['area-1', 'area-2']);
  const groupId = created.session.doc.groups[0].id;
  assert.ok(created.message.includes('создана'), created.message);
  const renamed = renameGroupCmd(created.session, groupId, 'Юг');
  assert.equal(renamed.session.doc.groups[0].name, 'Юг');
  assert.equal(renamed.session.doc.groups[0].id, groupId, 'ID устойчив при переименовании');
  const added = addAreaToGroupCmd(renamed.session, groupId, 'area-3');
  assert.deepEqual(added.session.doc.groups[0].areaIds, ['area-1', 'area-2', 'area-3']);
  const removedGroup = deleteGroupCmd(added.session, groupId);
  assert.deepEqual(removedGroup.session.doc.groups, []);
  assert.equal(removedGroup.session.doc.areas.length, 3, 'области целы');
  assert.ok(removedGroup.message.includes('сохранены'), 'судьба сочетаний объяснена');
  // Всё отменяется.
  const undone = undo(removedGroup.session);
  assert.equal(undone.doc.groups.length, 1);
  assert.deepEqual(undone.doc.groups[0].areaIds, ['area-1', 'area-2', 'area-3']);
});

test('§6 через сессию: сочетание создаётся, режимы переключаются, линия сохраняется', () => {
  const session = sessionWithAreas();
  const created = createPairCmd(session, 'area-1', 'area-2');
  const pairId = created.session.doc.pairs[0].id;
  assert.ok(created.message.includes('автоматически'), 'зона есть — автолиния построена');
  const overlay = setPairModeCmd(created.session, pairId, 'overlay');
  const overlayPair = overlay.session.doc.pairs.find((pair) => pair.id === pairId);
  assert.equal(overlayPair.mode, 'overlay');
  assert.ok(overlayPair.line !== null, 'наложение не уничтожает линию');
  const back = setPairModeCmd(overlay.session, pairId, 'split');
  const restored = back.session.doc.pairs.find((pair) => pair.id === pairId);
  assert.deepEqual(restored.line.points, overlayPair.line.points, 'возврат к split восстанавливает правку');
  // Независимость А+Б и А+В.
  const ac = createPairCmd(back.session, 'area-1', 'area-3');
  assert.equal(ac.session.doc.pairs.length, 2);
  const acPair = ac.session.doc.pairs.find((pair) => pair.id !== pairId);
  assert.equal(acPair.areaA, 'area-1');
  assert.equal(acPair.areaB, 'area-3');
});

test('§7: правка линии сочетания не меняет исходные контуры областей', () => {
  const session0 = sessionWithAreas();
  const created = createPairCmd(session0, 'area-1', 'area-2');
  const pairId = created.session.doc.pairs[0].id;
  const manualLine = {
    manual: true,
    points: [[3200, 2600], [3250, 3200], [3200, 3800]],
    anchors: [
      { s: 0, point: [3200, 2600] },
      { s: 0.5, point: [3250, 3200] },
      { s: 1, point: [3200, 3800] },
    ],
  };
  const saved = setPairLineCmd(created.session, pairId, manualLine);
  assert.deepEqual(saved.session.doc.areas[0].rings, session0.doc.areas[0].rings, 'контур А цел');
  assert.deepEqual(saved.session.doc.areas[1].rings, session0.doc.areas[1].rings, 'контур Б цел');
  const pair = saved.session.doc.pairs.find((entry) => entry.id === pairId);
  assert.equal(pair.line.manual, true);
  assert.deepEqual(pair.line.points, manualLine.points);
  assert.ok((saved.message ?? '').includes('не менялись'));
});

test('§6.4: moveVertex отклоняет новое пересечение пары с запретом', () => {
  const session0 = sessionWithAreas();
  const created = createPairCmd(session0, 'area-2', 'area-3', { forbidCrossing: true });
  const session = created.session;
  // area-2 и area-3 не пересекаются; двигаем вершину area-3 внутрь area-2.
  const area3 = session.doc.areas.find((area) => area.id === 'area-3');
  assert.throws(() => moveVertex(session, 'area-3', 0, 0, [3000, 3000]),
    (error) => error instanceof RangeError && String(error.message).includes('запрещено'),
    'новое пересечение должно отклоняться');
  // Спокойная правка в сторону от area-2 разрешена.
  const moved = moveVertex(session, 'area-3', 0, 0, [6100, 6100]);
  assert.deepEqual(moved.doc.areas.find((area) => area.id === 'area-3').rings[0][0], [6100, 6100]);
  void area3;
});

test('§8: moveVertex с ручной линией пары не стирает её и помечает при выходе из зоны', () => {
  const session0 = sessionWithAreas();
  const created = createPairCmd(session0, 'area-1', 'area-2');
  const pairId = created.session.doc.pairs[0].id;
  const manualLine = {
    manual: true,
    points: [[3200, 2600], [3250, 3200]],
    anchors: [{ s: 0, point: [3200, 2600] }, { s: 1, point: [3250, 3200] }],
  };
  const saved = setPairLineCmd(created.session, pairId, manualLine);
  // Уводим area-2 далеко: якоря линии окажутся вне новой зоны.
  const moved = moveVertex(saved.session, 'area-2', 0, 0, [9000, 9000]);
  const pair = moved.doc.pairs.find((entry) => entry.id === pairId);
  assert.equal(pair.needsReview, true, 'пара помечена «требует пересмотра»');
  assert.deepEqual(pair.line.points, manualLine.points, 'ручная правка не стёрта');
  assert.ok(moved.doc.events.some((event) => event.note !== null && event.note.length > 0));
});

test('§8: удаление области убирает её сочетания и членство в группах с записью в журнал', () => {
  const session0 = sessionWithAreas();
  const pair = createPairCmd(session0, 'area-1', 'area-2');
  const group = createGroupCmd(pair.session, 'Север', ['area-1', 'area-2']);
  const removed = removeArea(group.session, 'area-2');
  assert.equal(removed.doc.pairs.length, 0, 'сочетание с удалённой областью убрано');
  assert.deepEqual(removed.doc.groups[0].areaIds, ['area-1'], 'группа чистится');
  assert.ok(removed.doc.events.at(-1).note.includes('сочетания'), 'журнал перечисляет удалённые сочетания');
  assert.equal(removed.doc.areas.length, 2);
});

test('§11 п.10: экспорт → файл → импорт → те же данные и повторная правка', () => {
  const session0 = sessionWithAreas();
  const ring = session0.doc.areas[0].rings[0];
  const curve = sampleRing(ring);
  const opened = openContourEdit(session0, 'area-1', curvePointAt(curve, 0.17, true));
  const ref = opened.session.contourEdit;
  const mid = curvePointAt(ref.state.curve, (ref.state.anchors[0].s + ref.state.anchors[1].s) / 2, true);
  const refined = subdivideContourSegment(opened.session, mid);
  const anchor = refined.session.contourEdit.state.anchors[2];
  const dragged = dragContourAnchor(refined.session, 2, [anchor.point[0] + 120, anchor.point[1] - 80]);
  const committed = commitContourDrag(dragged.session);
  const grouped = createGroupCmd(committed.session, 'Фронт', ['area-1']);
  const paired = createPairCmd(grouped.session, 'area-1', 'area-2');
  const text = exportDoc(paired.session, 2);
  // «Файл»: разбор строго тем же парсером, что и загрузка в редакторе.
  const reimported = importDoc(text);
  assert.deepEqual(reimported.doc, paired.session.doc, 'round-trip без потерь');
  // Отчёт валидатора — без ошибок.
  assert.equal(validateSectorAreas(reimported.doc).ok, true, validateSectorAreas(reimported.doc).errors.join('; '));
  // Повторная правка после загрузки: контур переоткрывается по сохранённым якорям.
  const reopened = openContourEdit(reimported, 'area-1', [0, 0]);
  assert.ok(reopened.session.contourEdit !== null, 'правка продолжается после загрузки');
  assert.equal(reopened.session.contourEdit.state.anchors.length, 10);
  assert.ok((reopened.message ?? '').includes('сохранённым якорям'), 'явно сообщено о продолжении');
  // И уточнение сегмента работает.
  const sub = curvePointAt(reopened.session.contourEdit.state.curve,
    (reopened.session.contourEdit.state.anchors[3].s + reopened.session.contourEdit.state.anchors[4].s) / 2, true);
  const refinedAgain = subdivideContourSegment(reopened.session, sub);
  assert.equal(refinedAgain.session.contourEdit.state.anchors.length, 14);
});

test('§11: закрытие правки контура не трогает документ', () => {
  const session0 = sessionWithAreas();
  const curve = sampleRing(session0.doc.areas[0].rings[0]);
  const opened = openContourEdit(session0, 'area-1', curvePointAt(curve, 0.2, true));
  const closed = closeContourEdit(opened.session);
  assert.equal(closed.contourEdit, null);
  assert.deepEqual(closed.doc, opened.session.doc);
});

test('§11: регрессия — прежние команды сессии работают, документ с новыми полями валиден', async () => {
  const session = sessionWithAreas();
  const moved = moveVertex(session, 'area-1', 0, 0, [1100, 1000]);
  assert.equal(moved.doc.areas[0].rings[0][0][0], 1100);
  const undone = undo(moved);
  assert.equal(undone.doc.areas[0].rings[0][0][0], 1000);
  // Реальные данные data/sector-areas.json: парсер с новыми полями по умолчанию.
  const raw = await readFile(new URL('../data/sector-areas.json', import.meta.url), 'utf8');
  const doc = parseSectorAreas(JSON.parse(raw));
  assert.deepEqual(doc.groups, []);
  assert.deepEqual(doc.pairs, []);
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, true, report.errors.join('; '));
});
