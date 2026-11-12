/* Локальная история свойств. Ничего не записывает и не отправляет в GitHub. */
import type { PropertyDataset, PropertyField } from './sector-property-overlay.ts';

export const PROPERTY_FIELDS: readonly PropertyField[] = ['name', 'type', 'faction', 'description', 'source_url'];
export interface PropertySnapshotField {
  /** Точная исходная ячейка, null — колонки нет. */
  readonly raw: string | null;
  /** Значение, отображавшееся в начале сессии, включая опубликованные поправки. */
  readonly effective: string;
}
export interface PropertySnapshot {
  readonly dataset: PropertyDataset;
  readonly recordId: string;
  readonly fields: Readonly<Record<PropertyField, PropertySnapshotField>>;
}
export interface PropertyChange {
  readonly dataset: PropertyDataset;
  readonly recordId: string;
  readonly field: PropertyField;
  readonly raw: string | null;
  readonly before: string;
  readonly after: string;
}
type Values = ReadonlyArray<Readonly<Record<PropertyField, string>>>;
export interface PropertySession {
  readonly snapshots: readonly PropertySnapshot[];
  /** Отпечаток входных байтов, не гарантия прав или публикации. */
  readonly contentRevision: string | null;
  readonly present: Values;
  readonly past: readonly Values[];
  readonly future: readonly Values[];
}

/** Создаёт независимую копию снимка, не используя имена в качестве ID. */
export function createPropertySession(snapshots: readonly PropertySnapshot[], contentRevision: string | null = null): PropertySession {
  if (contentRevision !== null && !/^[a-f0-9]{64}$/.test(contentRevision)) throw new TypeError('Некорректный отпечаток входов.');
  const seen = new Set<string>();
  const copies = snapshots.map((snapshot) => {
    if ((snapshot.dataset !== 'systems' && snapshot.dataset !== 'places') ||
        typeof snapshot.recordId !== 'string' || !snapshot.recordId.trim() || snapshot.recordId !== snapshot.recordId.trim()) {
      throw new TypeError('Некорректный идентификатор объекта.');
    }
    const key = JSON.stringify([snapshot.dataset, snapshot.recordId]);
    if (seen.has(key)) throw new TypeError('Повтор объекта в снимке.');
    seen.add(key);
    const fields = {} as Record<PropertyField, PropertySnapshotField>;
    for (const field of PROPERTY_FIELDS) {
      const value = snapshot.fields?.[field];
      if (!value || (value.raw !== null && typeof value.raw !== 'string') || typeof value.effective !== 'string') {
        throw new TypeError('Некорректный снимок свойства.');
      }
      fields[field] = { raw: value.raw, effective: value.effective };
    }
    return { dataset: snapshot.dataset, recordId: snapshot.recordId, fields };
  });
  const present = copies.map((snapshot) => Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, snapshot.fields[field].effective])) as Record<PropertyField, string>);
  return { snapshots: copies, contentRevision, present, past: [], future: [] };
}

/** Одна команда на поле; одинаковое значение не создаёт запись истории. */
export function editProperty(session: PropertySession, dataset: PropertyDataset, recordId: string, field: PropertyField, value: string): PropertySession {
  if (!PROPERTY_FIELDS.includes(field) || typeof value !== 'string') throw new TypeError('Некорректная правка.');
  const index = session.snapshots.findIndex((snapshot) => snapshot.dataset === dataset && snapshot.recordId === recordId);
  if (index < 0) throw new RangeError('Объект отсутствует в снимке.');
  const current = session.present[index]!;
  if (current[field] === value) return session;
  const present = session.present.map((item, i) => i === index ? { ...item, [field]: value } : item);
  return { ...session, present, past: [...session.past, session.present], future: [] };
}

export function undoProperty(session: PropertySession): PropertySession {
  const previous = session.past.at(-1);
  if (!previous) return session;
  return { ...session, present: previous, past: session.past.slice(0, -1), future: [session.present, ...session.future] };
}
export function redoProperty(session: PropertySession): PropertySession {
  const next = session.future[0];
  if (!next) return session;
  return { ...session, present: next, past: [...session.past, session.present], future: session.future.slice(1) };
}

/** Только отличия от начала сессии. Это ещё не авторизованная заявка. */
export function propertyChanges(session: PropertySession): PropertyChange[] {
  const changes: PropertyChange[] = [];
  session.snapshots.forEach((snapshot, index) => {
    for (const field of PROPERTY_FIELDS) {
      const initial = snapshot.fields[field];
      const after = session.present[index]![field];
      if (after !== initial.effective) changes.push({ dataset: snapshot.dataset, recordId: snapshot.recordId, field, raw: initial.raw, before: initial.effective, after });
    }
  });
  return changes;
}
