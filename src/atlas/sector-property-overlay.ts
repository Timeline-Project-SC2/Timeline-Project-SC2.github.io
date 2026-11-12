/* Офлайн-ядро кандидата слоя поправок. Не выполняет запись и не подключено к загрузчику. */

export type PropertyDataset = 'systems' | 'places';
export type PropertyField = 'name' | 'type' | 'faction' | 'description' | 'source_url';
export interface PropertyOverride {
  readonly dataset: PropertyDataset;
  readonly recordId: string;
  readonly field: PropertyField;
  /** Исходное значение на момент утверждения; null означает отсутствие колонки. */
  readonly base: string | null;
  /** Пустая строка — явная очистка, а не отсутствие поправки. */
  readonly value: string;
}
export interface PropertyOverlay { readonly version: 1; readonly changes: readonly PropertyOverride[]; }
export type PropertyRow = Readonly<Record<string, string>>;
export interface OverlayProblem {
  readonly change: PropertyOverride;
  readonly reason: 'missing_record' | 'duplicate_record' | 'upstream_changed';
}
export interface OverlayResult {
  readonly systems: PropertyRow[];
  readonly places: PropertyRow[];
  readonly problems: OverlayProblem[];
}

const fields: readonly string[] = ['name', 'type', 'faction', 'description', 'source_url'];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Принимает только документ целиком: частично некорректный файл не применяется. */
export function parsePropertyOverlay(raw: unknown): PropertyOverlay {
  if (!object(raw) || !exactKeys(raw, ['version', 'changes']) || raw.version !== 1 || !Array.isArray(raw.changes)) {
    throw new TypeError('Некорректный документ поправок.');
  }
  const seen = new Set<string>();
  const changes: PropertyOverride[] = raw.changes.map((item: unknown) => {
    if (!object(item) || !exactKeys(item, ['dataset', 'recordId', 'field', 'base', 'value']) ||
      (item.dataset !== 'systems' && item.dataset !== 'places') ||
      typeof item.recordId !== 'string' || !item.recordId.trim() || item.recordId !== item.recordId.trim() ||
      typeof item.field !== 'string' || !fields.includes(item.field) ||
      (item.base !== null && typeof item.base !== 'string') || typeof item.value !== 'string') {
      throw new TypeError('Некорректная поправка свойства.');
    }
    const key = JSON.stringify([item.dataset, item.recordId, item.field]);
    if (seen.has(key)) throw new TypeError('Повтор поправки свойства.');
    seen.add(key);
    return { dataset: item.dataset, recordId: item.recordId, field: item.field as PropertyField, base: item.base, value: item.value };
  });
  return { version: 1, changes };
}

/**
 * Применяет уже утверждённый слой к сырым строкам. Расхождение upstream
 * сообщается, но не отменяет утверждённое значение. Не создаёт записи и не
 * угадывает ID по имени; неоднозначные ID не изменяются.
 */
export function applyPropertyOverlay(
  overlay: PropertyOverlay,
  input: { readonly systems: readonly PropertyRow[]; readonly places: readonly PropertyRow[] },
): OverlayResult {
  // Не доверяем даже типизированному вызову: граница схемы обязательна.
  const parsed = parsePropertyOverlay(overlay);
  const systems = input.systems.map((row) => ({ ...row }));
  const places = input.places.map((row) => ({ ...row }));
  const indices = { systems: new Map<string, number[]>(), places: new Map<string, number[]>() };
  for (const dataset of ['systems', 'places'] as const) {
    const rows = dataset === 'systems' ? systems : places;
    const idField = dataset === 'systems' ? 'system_id' : 'ID';
    rows.forEach((row, index) => {
      const id = row[idField];
      if (!id) return;
      const positions = indices[dataset].get(id) ?? [];
      positions.push(index);
      indices[dataset].set(id, positions);
    });
  }
  const problems: OverlayProblem[] = [];
  for (const change of parsed.changes) {
    const positions = indices[change.dataset].get(change.recordId);
    if (!positions?.length) { problems.push({ change, reason: 'missing_record' }); continue; }
    if (positions.length !== 1) { problems.push({ change, reason: 'duplicate_record' }); continue; }
    const rows = change.dataset === 'systems' ? systems : places;
    const row = rows[positions[0]!]!;
    const current = Object.hasOwn(row, change.field) ? row[change.field]! : null;
    if (current !== change.base) problems.push({ change, reason: 'upstream_changed' });
    row[change.field] = change.value;
  }
  return { systems, places, problems };
}
