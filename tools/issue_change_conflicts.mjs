const SNAPSHOT_FIELDS = ['dataset', 'recordId', 'field', 'value'];
const CHANGE_FIELDS = ['dataset', 'recordId', 'field', 'before', 'after'];

const isValue = (value) => value === null || typeof value === 'string';

// Проверяем именно собственные поля данных, не вызывая геттеры объектов.
function readEntry(entry, expected) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const keys = Reflect.ownKeys(entry);
  if (keys.length !== expected.length || !keys.every((key) => expected.includes(key))) return null;
  const values = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    values[key] = descriptor.value;
  }
  for (const key of ['dataset', 'recordId', 'field']) {
    if (typeof values[key] !== 'string' || values[key].length === 0) return null;
  }
  if (expected === SNAPSHOT_FIELDS ? !isValue(values.value) :
    !isValue(values.before) || !isValue(values.after)) return null;
  return values;
}

// Вложенные Map сохраняют точные границы трёх идентификаторов.
function addKey(index, entry) {
  if (!index.has(entry.dataset)) index.set(entry.dataset, new Map());
  const records = index.get(entry.dataset);
  if (!records.has(entry.recordId)) records.set(entry.recordId, new Map());
  const fields = records.get(entry.recordId);
  if (fields.has(entry.field)) return false;
  fields.set(entry.field, entry);
  return true;
}

function getKey(index, entry) {
  return index.get(entry.dataset)?.get(entry.recordId)?.get(entry.field);
}

function indexEntries(entries, fields) {
  if (!Array.isArray(entries)) return null;
  const index = new Map();
  for (const item of entries) {
    const entry = readEntry(item, fields);
    if (!entry || !addKey(index, entry)) return null;
  }
  return index;
}

// Только проверка переданных значений: не авторизация и не готовность к записи.
export function assessFieldConflicts(baseFields, currentFields, changes) {
  try {
    if (!Array.isArray(changes) || changes.length === 0) return { status: 'indeterminate' };
    const base = indexEntries(baseFields, SNAPSHOT_FIELDS);
    const current = indexEntries(currentFields, SNAPSHOT_FIELDS);
    const requested = indexEntries(changes, CHANGE_FIELDS);
    if (!base || !current || !requested) return { status: 'indeterminate' };

    let conflict = false;
    for (const records of requested.values()) {
      for (const fields of records.values()) {
        for (const change of fields.values()) {
          const original = getKey(base, change);
          const latest = getKey(current, change);
          if (!original || !latest || change.before !== original.value) {
            return { status: 'indeterminate' };
          }
          if (latest.value !== original.value) conflict = true;
        }
      }
    }
    return { status: conflict ? 'conflict' : 'candidate_needs_validation' };
  } catch {
    return { status: 'indeterminate' };
  }
}
