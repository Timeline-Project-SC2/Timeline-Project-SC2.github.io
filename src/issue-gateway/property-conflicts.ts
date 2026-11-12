/* Офлайн-проверка совпадения значений; не проверяет происхождение данных и права. */
import { restorePropertyDraft } from '../atlas/sector-property-draft.ts';
import { createPropertySession, propertyChanges } from '../atlas/sector-property-session.ts';
import type { PropertySnapshot } from '../atlas/sector-property-session.ts';

export interface PropertyInputSnapshot {
  /** Отпечаток должен быть проверен вызывающим кодом по доверенным данным. */
  readonly contentRevision: string;
  readonly snapshots: readonly PropertySnapshot[];
}
export type PropertyConflictResult =
  | { readonly status: 'candidate_needs_validation' }
  | { readonly status: 'conflict' }
  | { readonly status: 'indeterminate' };

/**
 * Проверяет черновик на исходной базе и сравнивает каждое изменённое поле с
 * текущим состоянием. Возврат candidate не является разрешением на запись:
 * доверенность баз, неизменность заявки, права и доменная валидация отдельно.
 */
export function assessPropertyConflicts(
  draft: unknown,
  trustedBase: PropertyInputSnapshot,
  trustedCurrent: PropertyInputSnapshot,
  baseFactionNames: ReadonlySet<string>,
): PropertyConflictResult {
  try {
    if (!/^[a-f0-9]{64}$/.test(trustedBase.contentRevision) || !/^[a-f0-9]{64}$/.test(trustedCurrent.contentRevision) ||
      draft === null || typeof draft !== 'object' || Array.isArray(draft) ||
      !Object.hasOwn(draft, 'baseRevision') || (draft as { baseRevision?: unknown }).baseRevision !== trustedBase.contentRevision) {
      return { status: 'indeterminate' };
    }
    const base = createPropertySession(trustedBase.snapshots, trustedBase.contentRevision);
    const current = createPropertySession(trustedCurrent.snapshots, trustedCurrent.contentRevision);
    const restored = restorePropertyDraft(draft, base, baseFactionNames);
    const changes = propertyChanges(restored.session);
    if (!changes.length) return { status: 'indeterminate' };
    const index = new Map(current.snapshots.map((snapshot) => [JSON.stringify([snapshot.dataset, snapshot.recordId]), snapshot]));
    let conflict = false;
    for (const change of changes) {
      const snapshot = index.get(JSON.stringify([change.dataset, change.recordId]));
      if (!snapshot) return { status: 'indeterminate' };
      const field = snapshot.fields[change.field];
      if (field.raw !== change.raw || field.effective !== change.before) conflict = true;
    }
    return { status: conflict ? 'conflict' : 'candidate_needs_validation' };
  } catch {
    return { status: 'indeterminate' };
  }
}
