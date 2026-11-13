/* Применение заявки к слою поправок: чистое решение, без записи.
 *
 * Модуль отвечает на один вопрос: «можно ли превратить эту заявку в новую
 * версию слоя?» — и никогда не отвечает «да» вместо проверок. На вход идут
 * уже проверенные вызывающим кодом данные: заявка, доверенная база (снимок,
 * на котором её делали) и текущее состояние источников. Ни один из них этот
 * модуль не загружает сам — происхождение данных остаётся снаружи.
 *
 * Что он делает:
 *  - сопоставляет заявку с текущими записями по точному ID и только внутри
 *    своего набора данных. Имя, похожесть и порядок строк не участвуют;
 *  - сверяет базу: запись и исходное значение поля должны совпадать с тем,
 *    что было в заявке. Иначе — конфликт, а не перезапись;
 *  - различает «уже применено» (значение в слое уже равно новому) от
 *    «конфликт» (значение изменилось на что-то третье);
 *  - отдаёт новый слой и ключ идемпотентности; саму запись выполняет
 *    отдельный, не реализованный здесь шаг с проверкой роли и HEAD.
 *
 * Что он НЕ делает: не проверяет роль Owner и права, не доказывает свежесть
 * снимков, не пишет файлы, не создаёт коммитов, не публикует сайт, не
 * решает спор двух авторов по времени отправки. Всё это — отдельные этапы.
 */
import {
  PROPERTY_DATASETS,
  PROPERTY_FIELDS,
  PROPERTY_REPOSITORY_ID,
  readPacket,
} from './property-issue-contract.ts';
import type { PropertyDatasetName, PropertyFieldName, PropertyRequestChange } from './property-issue-contract.ts';
import { parsePropertyOverlay } from '../atlas/sector-property-overlay.ts';
import type { PropertyOverlay, PropertyOverride, PropertyRow } from '../atlas/sector-property-overlay.ts';

/** Текущее состояние источников: те же строки, что читает загрузчик карты. */
export interface PropertyUpstream {
  readonly systems: readonly PropertyRow[];
  readonly places: readonly PropertyRow[];
}

/** Доверенная база: отпечаток входов и значения полей на момент правки. */
export interface TrustedPropertyBase {
  readonly contentRevision: string;
  /** Ключ записи: `${dataset}\u0000${recordId}` → поле → исходное значение. */
  readonly fields: ReadonlyMap<string, Readonly<Record<PropertyFieldName, string>>>;
}

export type ApplyRefusal =
  /** Заявка не прошла схему или её нельзя применять по форме. */
  | 'invalid_request'
  /** База заявки не совпадает с переданной доверенной базой. */
  | 'base_mismatch'
  /** Запись в текущих данных пропала или неоднозначна. */
  | 'record_missing'
  /** Значение поля изменилось на что-то третье: нужна новая заявка. */
  | 'conflict'
  /** Текущие значения не удалось прочитать согласованно. */
  | 'indeterminate';

export interface ApplyPlan {
  /** Новый документ слоя; существующие поправки сохраняются. */
  readonly overlay: PropertyOverlay;
  /** Ключ идемпотентности: репозиторий + номер Issue + requestId. */
  readonly idempotencyKey: string;
  /** Что именно изменится в слое — для отчёта и коммита. */
  readonly additions: readonly PropertyOverride[];
  /** Поля, для которых в слое уже стояло нужное значение. */
  readonly unchanged: number;
  readonly warnings: readonly string[];
}

export type ApplyResult =
  /** Заявка уже применена полностью: новых записей в слой не требуется. */
  | { readonly status: 'already_applied'; readonly idempotencyKey: string }
  | { readonly status: 'apply'; readonly plan: ApplyPlan }
  | { readonly status: 'refused'; readonly reason: ApplyRefusal; readonly details: readonly string[] };

const SEP = '\u0000';

export function propertyKey(dataset: PropertyDatasetName, recordId: string): string {
  return `${dataset}${SEP}${recordId}`;
}

/** ID записи в источнике: `system_id` для систем, `ID` для мест. */
function idField(dataset: PropertyDatasetName): string {
  return dataset === 'systems' ? 'system_id' : 'ID';
}

function indexRows(rows: readonly PropertyRow[], field: string): Map<string, number[]> {
  const index = new Map<string, number[]>();
  rows.forEach((row, position) => {
    const id = row[field];
    if (typeof id !== 'string' || id === '') return;
    const positions = index.get(id) ?? [];
    positions.push(position);
    index.set(id, positions);
  });
  return index;
}

/** Текущее значение поля: `null` означает отсутствие колонки, `''` — явно пусто. */
function currentValue(row: PropertyRow, field: string): string | null {
  return Object.hasOwn(row, field) && typeof row[field] === 'string' ? row[field]! : null;
}

/** Значение, которое лежит в слое для этого поля, или `null`, если записи нет. */
function overlayValue(overlay: PropertyOverlay, change: PropertyRequestChange): PropertyOverride | null {
  return overlay.changes.find((item) => item.dataset === change.dataset &&
    item.recordId === change.recordId && item.field === change.field) ?? null;
}

/**
 * Ключ идемпотентности. Он привязан к репозиторию, номеру Issue и
 * requestId — не к тексту заявки: правка текста Issue не должна выглядеть
 * как новая работа, а номер Issue назначает GitHub и подделать его в тексте
 * нельзя. Формат стабилен, чтобы его можно было хранить в журнале.
 */
export function propertyIdempotencyKey(issuesNumber: number, requestId: string): string {
  if (!Number.isSafeInteger(issuesNumber) || issuesNumber <= 0) {
    throw new TypeError('Некорректный номер Issue.');
  }
  if (typeof requestId !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(requestId)) {
    throw new TypeError('Некорректный идентификатор заявки.');
  }
  return `issue:${PROPERTY_REPOSITORY_ID}:${issuesNumber}:${requestId}`;
}

/**
 * Строит новую версию слоя или отказывает. Порядок проверок важен: сначала
 * форма и база, потом записи, потом значения — чтобы отказ называл первопричину.
 */
export function planPropertyApply(
  request: unknown,
  trustedBase: TrustedPropertyBase,
  upstream: PropertyUpstream,
  overlay: unknown,
  issuesNumber: number,
): ApplyResult {
  let packet;
  try {
    packet = readPacket(request);
  } catch {
    return { status: 'refused', reason: 'invalid_request', details: ['Заявка не соответствует схеме.'] };
  }
  let key: string;
  try {
    key = propertyIdempotencyKey(issuesNumber, packet.requestId);
  } catch {
    return { status: 'refused', reason: 'invalid_request', details: ['Некорректный номер Issue или идентификатор заявки.'] };
  }
  if (typeof trustedBase?.contentRevision !== 'string' || !/^[a-f0-9]{64}$/.test(trustedBase.contentRevision) ||
    !(trustedBase.fields instanceof Map)) {
    return { status: 'refused', reason: 'indeterminate', details: ['Доверенная база не передана в пригодном виде.'] };
  }
  if (packet.baseRevision !== trustedBase.contentRevision) {
    return { status: 'refused', reason: 'base_mismatch', details: ['Отпечаток базы заявки не совпадает с доверенной базой.'] };
  }
  let parsedOverlay: PropertyOverlay;
  try {
    parsedOverlay = parsePropertyOverlay(overlay);
  } catch {
    return { status: 'refused', reason: 'indeterminate', details: ['Текущий слой поправок не читается; запись запрещена.'] };
  }

  const indices = {
    systems: indexRows(upstream?.systems ?? [], idField('systems')),
    places: indexRows(upstream?.places ?? [], idField('places')),
  };
  const rows = { systems: upstream?.systems ?? [], places: upstream?.places ?? [] };
  const details: string[] = [];
  const additions: PropertyOverride[] = [];
  const seen = new Set<string>();
  let unchanged = 0;

  for (const change of packet.changes) {
    if (!PROPERTY_DATASETS.includes(change.dataset) || !PROPERTY_FIELDS.includes(change.field)) {
      return { status: 'refused', reason: 'invalid_request', details: ['Неизвестный набор данных или поле.'] };
    }
    const changeKey = JSON.stringify([change.dataset, change.recordId, change.field]);
    if (seen.has(changeKey)) {
      return { status: 'refused', reason: 'invalid_request', details: ['Повтор поля в заявке.'] };
    }
    seen.add(changeKey);

    const baseFields = trustedBase.fields.get(propertyKey(change.dataset, change.recordId));
    if (!baseFields || !Object.hasOwn(baseFields, change.field)) {
      return { status: 'refused', reason: 'base_mismatch', details: [`Нет доверенного значения для ${change.dataset}/${change.recordId}/${change.field}.`] };
    }
    if (baseFields[change.field] !== change.before) {
      return { status: 'refused', reason: 'base_mismatch', details: [`Значение «до» не совпадает с доверенной базой для ${change.dataset}/${change.recordId}/${change.field}.`] };
    }

    const positions = indices[change.dataset].get(change.recordId);
    if (!positions || positions.length === 0) {
      return { status: 'refused', reason: 'record_missing', details: [`Запись ${change.dataset}/${change.recordId} отсутствует в текущих данных.`] };
    }
    if (positions.length > 1) {
      return { status: 'refused', reason: 'record_missing', details: [`Запись ${change.dataset}/${change.recordId} неоднозначна: совпадений ${positions.length}.`] };
    }
    const row = rows[change.dataset][positions[0]!]!;

    const already = overlayValue(parsedOverlay, change);
    const effective = already === null ? currentValue(row, change.field) : already.value;
    if (effective === change.after) { unchanged += 1; continue; }
    // В слое уже стоит другое утверждённое значение: это спор двух правок.
    if (already !== null && already.value !== change.before && already.value !== change.after) {
      details.push(`В слое уже утверждено другое значение для ${change.dataset}/${change.recordId}/${change.field}.`);
      continue;
    }
    // Значение источника изменилось после базы: правка устарела.
    if (currentValue(row, change.field) !== change.before) {
      details.push(`Значение ${change.dataset}/${change.recordId}/${change.field} изменилось в источнике после базы.`);
      continue;
    }
    additions.push({
      dataset: change.dataset,
      recordId: change.recordId,
      field: change.field,
      base: change.before,
      value: change.after,
    });
  }

  if (details.length > 0) return { status: 'refused', reason: 'conflict', details };
  if (additions.length === 0) return { status: 'already_applied', idempotencyKey: key };

  // Порядок записей стабилен: по набору, ID и полю. Это делает диффы читаемыми.
  const order = (a: PropertyOverride, b: PropertyOverride): number => {
    const byDataset = PROPERTY_DATASETS.indexOf(a.dataset) - PROPERTY_DATASETS.indexOf(b.dataset);
    if (byDataset !== 0) return byDataset;
    if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1;
    return PROPERTY_FIELDS.indexOf(a.field) - PROPERTY_FIELDS.indexOf(b.field);
  };
  const next: PropertyOverlay = parsePropertyOverlay({
    version: 1,
    changes: [...parsedOverlay.changes.map((item) => ({ ...item })), ...additions].sort(order),
  });
  const warnings = [
    'Применение правки не означает публикацию: обновление сайта проверяется отдельно.',
    'Проверка роли Owner и защита ветки этим модулем не выполняются.',
  ];
  return {
    status: 'apply',
    plan: { overlay: next, idempotencyKey: key, additions: additions.slice().sort(order), unchanged, warnings },
  };
}

/** Ключи уже обработанных заявок из журнала; журнал ведёт применитель, не этот модуль. */
export function isAlreadyProcessed(journal: readonly string[], key: string): boolean {
  return journal.includes(key);
}

/** Дополняет журнал ключом без повторов; порядок сохраняется. */
export function recordProcessed(journal: readonly string[], key: string): string[] {
  if (typeof key !== 'string' || key === '') throw new TypeError('Некорректный ключ идемпотентности.');
  return journal.includes(key) ? [...journal] : [...journal, key];
}
