/* Предварительная проверка и локальный пакет — не авторизация и не заявка. */
import { PLACE_TYPES } from './config.ts';
import { PROPERTY_FIELDS, editProperty, propertyChanges } from './sector-property-session.ts';
import type { PropertyDataset, PropertyField } from './sector-property-overlay.ts';
import type { PropertyChange, PropertySession } from './sector-property-session.ts';

export interface PropertyDraftProblem {
  readonly change: PropertyChange;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}
export interface PropertyDraft {
  readonly type: 'sector-property-local-draft';
  readonly version: 1;
  readonly status: 'local-only';
  /** Отпечаток входов или null, не доказательство публикации и прав. */
  readonly baseRevision: string | null;
  readonly changes: readonly PropertyChange[];
}

/** Проверяет только изменённые поля; окончательная серверная проверка обязательна. */
export function validatePropertyChanges(changes: readonly PropertyChange[], factionNames: ReadonlySet<string>): PropertyDraftProblem[] {
  const problems: PropertyDraftProblem[] = [];
  const add = (change: PropertyChange, severity: 'error' | 'warning', message: string): void => { problems.push({ change, severity, message }); };
  for (const change of changes) {
    const value = change.after;
    if (change.field === 'name' && !value.trim()) add(change, 'error', 'Название не может быть пустым.');
    if (change.field === 'source_url' && value !== '') {
      try {
        const url = new URL(value);
        if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value) ||
          !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('URL');
      } catch {
        add(change, 'error', 'Укажите полный http(s) URL без логина и пароля или очистите поле.');
      }
    }
    if (change.field === 'type') {
      const accepted = change.dataset === 'systems'
        ? ['standard', 'capital', 'unknown', 'unknow', '']
        : ['', ...Object.keys(PLACE_TYPES)];
      if (!accepted.includes(value)) add(change, 'warning', 'Неизвестный тип: потребуется согласование перед применением.');
    }
    if (change.field === 'faction' && value !== '' && !factionNames.has(value)) {
      add(change, 'warning', 'Фракция отсутствует в текущем справочнике: потребуется проверка.');
    }
  }
  return problems;
}

/** Пакет для локального просмотра: не доказывает базу, права, неизменность или допустимость. */
export function preparePropertyDraft(session: PropertySession, factionNames: ReadonlySet<string>): {
  readonly draft: PropertyDraft | null;
  readonly problems: readonly PropertyDraftProblem[];
} {
  const changes = propertyChanges(session);
  const problems = validatePropertyChanges(changes, factionNames);
  if (!changes.length || problems.some((problem) => problem.severity === 'error')) return { draft: null, problems };
  return { draft: { type: 'sector-property-local-draft', version: 1, status: 'local-only', baseRevision: session.contentRevision, changes }, problems };
}

/** Загружает только локальный черновик на совпадающую базу; конфликт отклоняет весь импорт. */
export function restorePropertyDraft(raw: unknown, session: PropertySession, factionNames: ReadonlySet<string>): {
  readonly session: PropertySession;
  readonly problems: readonly PropertyDraftProblem[];
} {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value: Record<string, unknown>, names: string[]): boolean => Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
  if (propertyChanges(session).length) throw new Error('Сначала отмените текущие локальные правки.');
  if (!object(raw) || !keys(raw, ['type', 'version', 'status', 'baseRevision', 'changes']) ||
      raw.type !== 'sector-property-local-draft' || raw.version !== 1 || raw.status !== 'local-only' ||
      (raw.baseRevision !== null && (typeof raw.baseRevision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.baseRevision))) ||
      !Array.isArray(raw.changes) || !raw.changes.length) throw new Error('Некорректный локальный черновик.');
  if (raw.baseRevision !== null && raw.baseRevision !== session.contentRevision) throw new Error('Отпечаток входов отличается; черновик не загружен.');
  const seen = new Set<string>();
  let next = session;
  for (const entry of raw.changes as unknown[]) {
    if (!object(entry) || !keys(entry, ['dataset', 'recordId', 'field', 'raw', 'before', 'after']) ||
      (entry.dataset !== 'systems' && entry.dataset !== 'places') || typeof entry.recordId !== 'string' || !entry.recordId ||
      typeof entry.field !== 'string' || !PROPERTY_FIELDS.includes(entry.field as PropertyField) ||
      (entry.raw !== null && typeof entry.raw !== 'string') || typeof entry.before !== 'string' ||
      typeof entry.after !== 'string' || entry.before === entry.after) throw new Error('Некорректное изменение в черновике.');
    const key = JSON.stringify([entry.dataset, entry.recordId, entry.field]);
    if (seen.has(key)) throw new Error('Повтор поля в черновике.');
    seen.add(key);
    const snapshot = session.snapshots.find((item) => item.dataset === entry.dataset && item.recordId === entry.recordId);
    const field = entry.field as PropertyField;
    if (!snapshot || snapshot.fields[field].raw !== entry.raw || snapshot.fields[field].effective !== entry.before) {
      throw new Error('Исходные данные изменились или объект отсутствует; черновик не загружен.');
    }
    next = editProperty(next, entry.dataset as PropertyDataset, entry.recordId, field, entry.after);
  }
  const problems = validatePropertyChanges(propertyChanges(next), factionNames);
  if (problems.some((problem) => problem.severity === 'error')) throw new Error('Черновик содержит недопустимые значения.');
  return { session: next, problems };
}
