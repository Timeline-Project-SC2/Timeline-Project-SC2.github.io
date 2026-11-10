/* Группы областей (§5 ТЗ `SEC-AREAS-HIERARCHY`): команды над документом.
 *
 * Слой намеренно **без DOM и без рендера**: каждая функция принимает документ
 * и возвращает новый документ, ничего не мутируя. Журнал событий и история
 * отмен ведутся на уровне редактора (`sector-areas-hierarchy-commands.ts`).
 *
 * Модель по решению исполнителя (вопрос владельцу открыт): группа — отдельный
 * список с устойчивым ID и изменяемым именем; одна область может входить
 * в несколько групп. Это не каскад `parentId`: каскад остаётся как был, группы
 * — организации администратора поверх него.
 *
 * Удаление группы не трогает области, их контуры и парные сочетания: пары
 * ссылаются на области напрямую, а не на группы. Информацию об этом интерфейс
 * обязан показывать явно, а не терять настройки молча (§5 ТЗ).
 */

import type { AreaGroup, SectorAreasDoc } from './sector-areas-contract.ts';

/** Группы документа; отсутствующее поле читается пустым списком. */
export function groupsOf(doc: SectorAreasDoc): readonly AreaGroup[] {
  return doc.groups ?? [];
}

/** Области, входящие в группу (в порядке документа областей). */
export function groupMembers(doc: SectorAreasDoc, groupId: string): readonly string[] {
  const group = groupsOf(doc).find((entry) => entry.id === groupId);
  if (group === undefined) return [];
  const known = new Set(doc.areas.map((area) => area.id));
  return group.areaIds.filter((areaId) => known.has(areaId));
}

/** Группы, в которые входит область. */
export function groupsContaining(doc: SectorAreasDoc, areaId: string): readonly AreaGroup[] {
  return groupsOf(doc).filter((group) => group.areaIds.includes(areaId));
}

/** Свободный номер для `group-N` по уже существующим идентификаторам. */
export function nextGroupSequence(doc: SectorAreasDoc): number {
  let maximum = 0;
  for (const group of groupsOf(doc)) {
    const match = /-(\d+)$/.exec(group.id);
    const value = match === null ? NaN : Number(match[1]);
    if (Number.isFinite(value)) maximum = Math.max(maximum, value);
  }
  return maximum + 1;
}

function withGroups(doc: SectorAreasDoc, groups: readonly AreaGroup[]): SectorAreasDoc {
  return { ...doc, groups };
}

export interface CreateGroupInput {
  /** Явный ID; пусто — автоматически `group-N`. */
  readonly id?: string;
  readonly name: string;
  /** Начальный состав; ссылки на неизвестные области отбрасываются. */
  readonly areaIds?: readonly string[];
}

/** Создаёт группу. Дубликат ID или пустое имя — `RangeError`. */
export function createGroup(doc: SectorAreasDoc, input: CreateGroupInput): SectorAreasDoc {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new RangeError('Имя группы не может быть пустым.');
  }
  const id = (input.id ?? `group-${nextGroupSequence(doc)}`).trim();
  if (id.length === 0) {
    throw new RangeError('Идентификатор группы не может быть пустым.');
  }
  if (groupsOf(doc).some((group) => group.id === id)) {
    throw new RangeError(`Группа ${id}: идентификатор уже занят.`);
  }
  const known = new Set(doc.areas.map((area) => area.id));
  const areaIds = [...new Set(input.areaIds ?? [])].filter((areaId) => known.has(areaId));
  return withGroups(doc, [...groupsOf(doc), { id, name, areaIds }]);
}

/**
 * Переименовывает группу, не трогая её ID и состав (§5 ТЗ). Неизвестная
 * группа — `RangeError`; пустое имя — тоже.
 */
export function renameGroup(doc: SectorAreasDoc, groupId: string, name: string): SectorAreasDoc {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new RangeError('Имя группы не может быть пустым.');
  }
  const groups = groupsOf(doc);
  if (!groups.some((group) => group.id === groupId)) {
    throw new RangeError(`Группа ${groupId} не найдена.`);
  }
  return withGroups(doc, groups.map((group) => (group.id === groupId ? { ...group, name: trimmed } : group)));
}

/**
 * Удаляет группу. Области, их контуры и парные сочетания сохраняются:
 * возвращается пояснение, которое интерфейс обязан показать пользователю
 * (§5 ТЗ: «явно сообщай, что произойдёт с настройками сочетаний»).
 */
export function deleteGroup(doc: SectorAreasDoc, groupId: string): { doc: SectorAreasDoc; notice: string } {
  const group = groupsOf(doc).find((entry) => entry.id === groupId);
  if (group === undefined) {
    throw new RangeError(`Группа ${groupId} не найдена.`);
  }
  return {
    doc: withGroups(doc, groupsOf(doc).filter((entry) => entry.id !== groupId)),
    notice: `Группа «${group.name}» удалена. Области (${group.areaIds.length}), их контуры и парные сочетания сохранены: группы и сочетания — независимые списки.`,
  };
}

/** Заменяет состав группы целиком. Неизвестная группа — `RangeError`. */
export function setGroupAreas(doc: SectorAreasDoc, groupId: string, areaIds: readonly string[]): SectorAreasDoc {
  const groups = groupsOf(doc);
  if (!groups.some((group) => group.id === groupId)) {
    throw new RangeError(`Группа ${groupId} не найдена.`);
  }
  const known = new Set(doc.areas.map((area) => area.id));
  const unique = [...new Set(areaIds)].filter((areaId) => known.has(areaId));
  return withGroups(doc, groups.map((group) => (group.id === groupId ? { ...group, areaIds: unique } : group)));
}

/** Добавляет область в группу (идемпотентно). */
export function addAreaToGroup(doc: SectorAreasDoc, groupId: string, areaId: string): SectorAreasDoc {
  const group = groupsOf(doc).find((entry) => entry.id === groupId);
  if (group === undefined) {
    throw new RangeError(`Группа ${groupId} не найдена.`);
  }
  if (group.areaIds.includes(areaId)) return doc;
  return setGroupAreas(doc, groupId, [...group.areaIds, areaId]);
}

/** Убирает область из группы (идемпотентно). */
export function removeAreaFromGroup(doc: SectorAreasDoc, groupId: string, areaId: string): SectorAreasDoc {
  const group = groupsOf(doc).find((entry) => entry.id === groupId);
  if (group === undefined) {
    throw new RangeError(`Группа ${groupId} не найдена.`);
  }
  if (!group.areaIds.includes(areaId)) return doc;
  return setGroupAreas(doc, groupId, group.areaIds.filter((entry) => entry !== areaId));
}
