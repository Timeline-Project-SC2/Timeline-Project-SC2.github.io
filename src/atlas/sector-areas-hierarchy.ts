/* Команды иерархии над сессией редактора (§4–§8 ТЗ `SEC-AREAS-HIERARCHY`):
 * правка якорями на контуре области, именованные группы и слои сочетания пар.
 *
 * Слой над `sector-areas-editor.ts` (сессия, история, журнал) и чистыми
 * модулями `sector-areas-anchors.ts`, `sector-areas-groups.ts`,
 * `sector-areas-pairs.ts`. Правило слоёв прежнее: без DOM и без рендера.
 *
 * Правка якорями живёт в `session.contourEdit` (см. `ContourEditRef`) как
 * состояние интерфейса: открытие, перетаскивание и уточнение **не создают**
 * записей истории сами по себе; запись в документ происходит в `commit-`
 * командах, и каждая такая запись отменяется обычным `undo`.
 *
 * Порядок правки контура (§4):
 *  1. `openContourEdit` — первый набор из шести якорей по двойному клику
 *     (§4.1) или перепривязка сохранённых якорей после загрузки;
 *  2. `subdivideContourSegment` — уточнение сегмента 2+4 (§4.2);
 *  3. `dragContourAnchor` — предпросмотр тяги (§4.3), без записи;
 *  4. `commitContourDrag` — запись деформации в кольцо области, якорей,
 *     пересмотр сочетаний и запрет пересечения — одна запись истории;
 *  5. `closeContourEdit` — завершить правку контура.
 */

import type { CurveAnchor, Ring, SectorAreasDoc } from './sector-areas-contract.ts';
import {
  ANCHOR_RESNAP_TOLERANCE,
  beginContourEdit,
  commitDrag,
  dragAnchor,
  reopenContourEdit,
  subdivideSegment,
} from './sector-areas-anchors.ts';
import type { ContourEditState } from './sector-areas-anchors.ts';
import {
  addAreaToGroup,
  createGroup,
  deleteGroup,
  removeAreaFromGroup,
  renameGroup,
  setGroupAreas,
} from './sector-areas-groups.ts';
import {
  crossingViolation,
  createPair,
  markPairNeedsReview,
  removePair,
  resetPairLineToAuto,
  reviewPairsAfterGeometryChange,
  setPairForbidCrossing,
  setPairLine,
  setPairMode,
  setPairOrder,
  setPairTransition,
} from './sector-areas-pairs.ts';
import type { PairLine } from './sector-areas-contract.ts';
import { commitDocChange } from './sector-areas-editor.ts';
import type { EditorSession } from './sector-areas-editor.ts';

/** Активная правка якорями одного кольца области. */
export interface ContourEditRef {
  readonly areaId: string;
  readonly ringIndex: number;
  readonly state: ContourEditState;
  /** Последняя тяга была ограничена (край карты, петля, слипание, граница зоны). */
  readonly limited: boolean;
}

export interface HierarchyResult {
  readonly session: EditorSession;
  /** Понятное сообщение для интерфейса: отказ, ограничение или подтверждение. */
  readonly message: string | null;
}

/** Кольца области; `null` — область не найдена. */
function ringsOf(session: EditorSession, areaId: string): readonly Ring[] | null {
  return session.doc.areas.find((area) => area.id === areaId)?.rings ?? null;
}

/** Записывает якоря кольца в документ области (одна запись истории). */
function saveAnchors(
  session: EditorSession,
  areaId: string,
  ringIndex: number,
  anchors: readonly CurveAnchor[],
  note: string,
): EditorSession {
  return commitDocChange(
    session,
    {
      ...session.doc,
      areas: session.doc.areas.map((area) => {
        if (area.id !== areaId) return area;
        const others = (area.contourAnchors ?? []).filter((contour) => contour.ringIndex !== ringIndex);
        return { ...area, contourAnchors: [...others, { ringIndex, anchors }] };
      }),
    },
    { kind: 'anchors', areaId, mode: session.mode, note },
  );
}

/**
 * Открывает (или продолжает) иерархическую правку контура области (§4).
 * Первый двойной клик по видимой линии ставит шесть якорей (§4.1); если якоря
 * уже сохранены в документе, они перепривязываются к линии, а дрейф сверх
 * допуска честно сообщается (признак «проверить» для пользователя).
 */
export function openContourEdit(
  session: EditorSession,
  areaId: string,
  click: readonly [number, number],
  ringIndex = 0,
  tolerance?: number,
): HierarchyResult {
  const rings = ringsOf(session, areaId);
  const ring = rings?.[ringIndex];
  if (ring === undefined) {
    return { session, message: `Область ${areaId}: кольцо ${ringIndex} не найдено.` };
  }
  const saved = session.doc.areas
    .find((area) => area.id === areaId)
    ?.contourAnchors?.find((contour) => contour.ringIndex === ringIndex)?.anchors;
  if (saved !== undefined && saved.length >= 2) {
    const reopened = reopenContourEdit(ring, saved);
    if (!reopened.ok) return { session, message: reopened.reason };
    const driftNote = reopened.maxDrift > ANCHOR_RESNAP_TOLERANCE
      ? ` Якоря перепривязаны к линии; максимальный дрейф ${reopened.maxDrift.toFixed(1)} — проверьте форму.`
      : '';
    return {
      session: { ...session, contourEdit: { areaId, ringIndex, state: reopened.state, limited: false } },
      message: `Правка контура продолжена по сохранённым якорям (${saved.length} шт.).${driftNote}`,
    };
  }
  const opened = beginContourEdit(ring, [click[0], click[1]], tolerance);
  if (!opened.ok) return { session, message: opened.reason };
  const nextSession = saveAnchors(
    session,
    areaId,
    ringIndex,
    opened.state.anchors,
    `Первый набор якорей: 6 на контуре кольца ${ringIndex}`,
  );
  return {
    session: { ...nextSession, contourEdit: { areaId, ringIndex, state: opened.state, limited: false } },
    message: 'Контур поделен на 6 сегментов якорями. Двойной клик по сегменту — уточнить.',
  };
}

/**
 * Уточнение сегмента (§4.2): два крайних якоря остаются, внутри появляются
 * четыре, один — точно в точке клика. Остальные сегменты не меняются.
 */
export function subdivideContourSegment(
  session: EditorSession,
  click: readonly [number, number],
  tolerance?: number,
): HierarchyResult {
  const ref = session.contourEdit;
  if (ref === undefined || ref === null) {
    return { session, message: 'Сначала откройте правку контура двойным кликом по линии.' };
  }
  const result = subdivideSegment(ref.state, [click[0], click[1]], tolerance);
  if (!result.ok) return { session, message: result.reason };
  const nextSession = saveAnchors(
    session,
    ref.areaId,
    ref.ringIndex,
    result.state.anchors,
    `Сегмент уточнён: 2 якоря сохранены, добавлены 4 (кольцо ${ref.ringIndex})`,
  );
  return {
    session: { ...nextSession, contourEdit: { ...ref, state: result.state, limited: false } },
    message: 'Сегмент уточнён: шесть якорей и пять кривых на участке.',
  };
}

/**
 * Предпросмотр перетаскивания якоря (§4.3): локальная деформация без записи
 * в документ. `clampRegion` — зона взаимодействия пары для концов открытой
 * линии сочетания (§7); для замкнутых контуров областей не передаётся.
 */
export function dragContourAnchor(
  session: EditorSession,
  anchorIndex: number,
  target: readonly [number, number],
  clampRegion?: readonly (readonly [number, number])[],
): HierarchyResult {
  const ref = session.contourEdit;
  if (ref === undefined || ref === null) {
    return { session, message: 'Правка контура не открыта.' };
  }
  const dragged = dragAnchor(ref.state, anchorIndex, [target[0], target[1]], clampRegion);
  if (!dragged.ok) return { session: { ...session, contourEdit: ref }, message: dragged.reason };
  return {
    session: { ...session, contourEdit: { ...ref, state: dragged.state, limited: dragged.limited } },
    message: dragged.limited ? 'Тяга ограничена: край карты, защита от петли или граница зоны.' : null,
  };
}

/**
 * Коммит перетаскивания (§4.3): кольцо области следует деформации, якоря
 * перепривязываются; проверяются запрет пересечения (§6.4) и ручные линии
 * сочетаний (§8). Одна запись истории, обычный `undo` отменяет.
 */
export function commitContourDrag(session: EditorSession): HierarchyResult {
  const ref = session.contourEdit;
  if (ref === undefined || ref === null) return { session, message: null };
  if (ref.state.preview === null) {
    return { session: { ...session, contourEdit: { ...ref, limited: false } }, message: null };
  }
  const baked = commitDrag(ref.state);
  const ringPoints: readonly [number, number][] = baked.closed
    ? [...baked.ring.map((point) => [point[0], point[1]] as [number, number]), [baked.ring[0]![0], baked.ring[0]![1]] as [number, number]]
    : baked.ring.map((point) => [point[0], point[1]] as [number, number]);
  const target = session.doc.areas.find((area) => area.id === ref.areaId);
  if (target === undefined) {
    return { session: { ...session, contourEdit: null }, message: 'Область правки удалена — правка закрыта.' };
  }
  const violation = crossingViolation(session.doc, ref.areaId, [ringPoints as unknown as Ring]);
  if (violation !== null) {
    // Отклонённая тяга не записывается: состояние отбрасывается к последнему
    // закоммиченному, правка остаётся открытой, пользователь видит причину.
    return {
      session: { ...session, contourEdit: { ...ref, state: previewDropped(ref.state).state, limited: false } },
      message: violation,
    };
  }
  const withGeometry: SectorAreasDoc = {
    ...session.doc,
    areas: session.doc.areas.map((area) => (area.id === ref.areaId
      ? {
        ...area,
        rings: area.rings.map((ring, index) => (index === ref.ringIndex ? ringPoints : ring)),
        contourAnchors: [
          ...(area.contourAnchors ?? []).filter((contour) => contour.ringIndex !== ref.ringIndex),
          { ringIndex: ref.ringIndex, anchors: baked.anchors },
        ],
      }
      : area)),
  };
  const review = reviewPairsAfterGeometryChange(withGeometry, ref.areaId);
  const nextSession = commitDocChange(
    session,
    review.doc,
    { kind: 'anchors', areaId: ref.areaId, mode: session.mode, note: `Якорь перемещён (кольцо ${ref.ringIndex}); сочетания пересмотрены` },
  );
  return {
    session: { ...nextSession, contourEdit: { areaId: ref.areaId, ringIndex: ref.ringIndex, state: baked, limited: false } },
    message: review.changed.length > 0
      ? `Сочетания пересмотрены: ${review.changed.join(', ')}.`
      : null,
  };
}

function previewDropped(state: ContourEditState): { state: ContourEditState } {
  return { state: { ...state, preview: null, activeCurve: state.curve, draggedIndex: null } };
}

/** Завершает правку контура: состояние интерфейса сбрасывается, документ цел. */
export function closeContourEdit(session: EditorSession): EditorSession {
  return { ...session, contourEdit: null };
}

/* --------------------------------------------------- группы: команды сессии */

export function createGroupCmd(
  session: EditorSession,
  name: string,
  areaIds: readonly string[] = [],
  id?: string,
): HierarchyResult {
  const doc = createGroup(session.doc, id === undefined ? { name, areaIds } : { name, areaIds, id });
  const created = (doc.groups ?? []).at(-1);
  return {
    session: commitDocChange(session, doc, { kind: 'group', areaId: null, mode: null, note: `Создана группа «${name}» (${created?.id ?? ''})` }),
    message: `Группа «${name}» создана.`,
  };
}

export function renameGroupCmd(session: EditorSession, groupId: string, name: string): HierarchyResult {
  const doc = renameGroup(session.doc, groupId, name);
  return {
    session: commitDocChange(session, doc, { kind: 'group', areaId: null, mode: null, note: `Группа ${groupId} переименована в «${name}», ID сохранён` }),
    message: 'Имя группы изменено, идентификатор и состав сохранены.',
  };
}

export function deleteGroupCmd(session: EditorSession, groupId: string): HierarchyResult {
  const result = deleteGroup(session.doc, groupId);
  return {
    session: commitDocChange(session, result.doc, { kind: 'group', areaId: null, mode: null, note: result.notice }),
    message: result.notice,
  };
}

export function setGroupAreasCmd(session: EditorSession, groupId: string, areaIds: readonly string[]): HierarchyResult {
  const doc = setGroupAreas(session.doc, groupId, areaIds);
  return {
    session: commitDocChange(session, doc, { kind: 'group', areaId: null, mode: null, note: `Состав группы ${groupId} обновлён: ${areaIds.length} обл.` }),
    message: 'Состав группы обновлён.',
  };
}

export function addAreaToGroupCmd(session: EditorSession, groupId: string, areaId: string): HierarchyResult {
  const doc = addAreaToGroup(session.doc, groupId, areaId);
  if (doc === session.doc) return { session, message: 'Область уже в группе.' };
  return {
    session: commitDocChange(session, doc, { kind: 'group', areaId, mode: null, note: `Область ${areaId} добавлена в группу ${groupId}` }),
    message: 'Область добавлена в группу.',
  };
}

export function removeAreaFromGroupCmd(session: EditorSession, groupId: string, areaId: string): HierarchyResult {
  const doc = removeAreaFromGroup(session.doc, groupId, areaId);
  if (doc === session.doc) return { session, message: 'Области в группе не было.' };
  return {
    session: commitDocChange(session, doc, { kind: 'group', areaId, mode: null, note: `Область ${areaId} убрана из группы ${groupId}` }),
    message: 'Область убрана из группы.',
  };
}

/* ------------------------------------------------- сочетания: команды сессии */

export function createPairCmd(
  session: EditorSession,
  areaA: string,
  areaB: string,
  options: { readonly id?: string; readonly forbidCrossing?: boolean } = {},
): HierarchyResult {
  const result = createPair(session.doc, areaA, areaB, options);
  return {
    session: commitDocChange(session, result.doc, { kind: 'pair', areaId: null, mode: null, note: `Создано сочетание ${areaA}+${areaB} (${result.pair.id})` }),
    message: result.pair.line !== null
      ? 'Сочетание создано: линия раздела построена автоматически.'
      : 'Сочетание создано: области не пересекаются, автолинии нет.',
  };
}

export function removePairCmd(session: EditorSession, pairId: string): HierarchyResult {
  const doc = removePair(session.doc, pairId);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Сочетание ${pairId} удалено; контуры областей не тронуты` }),
    message: 'Сочетание удалено, контуры и стили областей сохранены.',
  };
}

export function setPairModeCmd(session: EditorSession, pairId: string, mode: 'split' | 'overlay'): HierarchyResult {
  const doc = setPairMode(session.doc, pairId, mode);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Режим сочетания ${pairId}: ${mode}` }),
    message: mode === 'overlay'
      ? 'Режим наложения: линия раздела сохранена и вернётся при переключении обратно.'
      : 'Режим разделения цветов.',
  };
}

export function setPairOrderCmd(session: EditorSession, pairId: string, order: 'a-over-b' | 'b-over-a'): HierarchyResult {
  const doc = setPairOrder(session.doc, pairId, order);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Порядок наложения ${pairId}: ${order}` }),
    message: 'Порядок наложения сохранён.',
  };
}

export function setPairForbidCrossingCmd(session: EditorSession, pairId: string, value: boolean): HierarchyResult {
  const doc = setPairForbidCrossing(session.doc, pairId, value);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Запрет пересечения ${pairId}: ${value ? 'включён' : 'выключен'}` }),
    message: value
      ? 'Пересечение запрещено: новые пересечения контуров пары будут отклоняться.'
      : 'Запрет пересечения выключен.',
  };
}

export function setPairTransitionCmd(session: EditorSession, pairId: string, width: number | null): HierarchyResult {
  const doc = setPairTransition(session.doc, pairId, width);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Переход сочетания ${pairId}: ${width ?? 'резкий'}` }),
    message: width !== null && width > 0
      ? `Мягкий переход включён: полоса ${Math.round(width)} единиц вокруг линии.`
      : 'Разделение резкое, без градиентной полосы.',
  };
}

/** Сохраняет ручную линию раздела (§7): контуры областей не трогаются. */
export function setPairLineCmd(session: EditorSession, pairId: string, line: PairLine): HierarchyResult {
  const doc = setPairLine(session.doc, pairId, line, true);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Линия раздела ${pairId} отредактирована вручную` }),
    message: 'Линия раздела сохранена; исходные контуры областей не менялись.',
  };
}

export function resetPairLineCmd(session: EditorSession, pairId: string): HierarchyResult {
  const doc = resetPairLineToAuto(session.doc, pairId);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Линия раздела ${pairId} сброшена на автолинию` }),
    message: 'Линия раздела пересчитана автоматически; ручная правка заменена.',
  };
}

export function markPairNeedsReviewCmd(session: EditorSession, pairId: string, value: boolean, note?: string): HierarchyResult {
  const doc = markPairNeedsReview(session.doc, pairId, value, note);
  return {
    session: commitDocChange(session, doc, { kind: 'pair', areaId: null, mode: null, note: `Пересмотр ${pairId}: ${value ? 'требуется' : 'снят'}` }),
    message: value ? 'Сочетание помечено «требует пересмотра».' : 'Пометка пересмотра снята.',
  };
}
