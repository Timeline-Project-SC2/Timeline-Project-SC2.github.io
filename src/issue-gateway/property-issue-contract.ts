/* Контракт заявки на свойства точек: схема пакета, его каноническая форма и
 * разметка текста Issue.
 *
 * Модуль без зависимостей и без побочных эффектов: его используют и браузерный
 * сборщик пакета (`src/atlas/sector-property-packet.ts`), и Worker шлюза.
 * Поэтому «что считается заявкой» описано в одном месте: клиент не может
 * собрать то, что сервер не примет, а сервер не принимает ничего, кроме
 * канонического вида.
 *
 * Что здесь НЕ утверждается:
 * - пакет не доказывает автора, роль Owner, базу или право на запись;
 * - отпечаток (fingerprint) — метка содержимого, не подпись и не разрешение;
 * - создание Issue не означает применение правки или публикацию;
 * - предметная допустимость значений проверяется отдельно (см.
 *   `sector-property-draft.ts` и будущую серверную проверку).
 */

export const PROPERTY_ISSUE_TYPE = 'sector-property-request';
export const PROPERTY_ISSUE_VERSION = 1;
/** Маркер заголовка из ADM-ACCESS-CONTRACT; это не доказательство прав. */
export const PROPERTY_ISSUE_TITLE_PREFIX = '[ADM-ACCESS]';
export const PROPERTY_ISSUE_BEGIN = '<!-- sector-property-request:v1:begin -->';
export const PROPERTY_ISSUE_END = '<!-- sector-property-request:v1:end -->';
/** ID репозитория, тот же, что в `tools/issue_owner_check.mjs` и обмене кода. */
export const PROPERTY_REPOSITORY_ID = 1421259694;
/** Полное имя репозитория для API Issue; ID остаётся главным признаком. */
export const PROPERTY_REPOSITORY = 'Timeline-Project-SC2/Timeline-Project-SC2.github.io';
/** Ограничение выборки при восстановлении результата: без пагинации. */
export const PROPERTY_LIST_PER_PAGE = 100;

export const PROPERTY_DATASETS = ['systems', 'places'] as const;
export const PROPERTY_FIELDS = ['name', 'type', 'faction', 'description', 'source_url'] as const;
export type PropertyDatasetName = (typeof PROPERTY_DATASETS)[number];
export type PropertyFieldName = (typeof PROPERTY_FIELDS)[number];

/** Пределы: защищают Issue и тело запроса, а не предметную ценность правки. */
export const PROPERTY_LIMITS = {
  changes: 100,
  records: 50,
  requestId: 64,
  recordId: 128,
  value: 4000,
  sourceUrl: 2048,
  title: 200,
  body: 60_000,
} as const;

export interface PropertyRequestChange {
  readonly dataset: PropertyDatasetName;
  readonly recordId: string;
  readonly field: PropertyFieldName;
  /** Значение, которое было на базе; сервер обязан сверить его со своей базой. */
  readonly before: string;
  readonly after: string;
}

export interface PropertyIssuePacket {
  readonly type: typeof PROPERTY_ISSUE_TYPE;
  readonly version: typeof PROPERTY_ISSUE_VERSION;
  /** Идентификатор заявки: метка попытки, не автор и не разрешение. */
  readonly requestId: string;
  readonly repositoryId: number;
  /** Отпечаток входов сборки, на которой сделана правка. */
  readonly baseRevision: string;
  readonly changes: readonly PropertyRequestChange[];
}

export type PacketProblemCode =
  | 'not_object'
  | 'unknown_key'
  | 'missing_key'
  | 'bad_type'
  | 'bad_version'
  | 'bad_request_id'
  | 'bad_repository'
  | 'bad_base_revision'
  | 'no_changes'
  | 'too_many_changes'
  | 'too_many_records'
  | 'bad_dataset'
  | 'bad_field'
  | 'bad_record_id'
  | 'duplicate_change'
  | 'bad_before'
  | 'bad_after'
  | 'too_long'
  | 'bad_value';

export interface PacketProblem {
  readonly code: PacketProblemCode;
  readonly message: string;
}

/** Ошибка схемы: сообщение — короткая метка, детали в коде. */
export class PacketSchemaError extends TypeError {
  readonly code: PacketProblemCode;
  constructor(code: PacketProblemCode, message: string) {
    super(message);
    this.name = 'PacketSchemaError';
    this.code = code;
  }
}

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const BASE_REVISION_RE = /^[a-f0-9]{64}$/;

/** Только собственные данные без геттеров: значение читается из дескриптора. */
function readOwn(entry: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(entry, key);
  if (!descriptor || !hasOwn(descriptor, 'value')) {
    throw new PacketSchemaError('not_object', 'Ожидается собственное значение поля.');
  }
  return descriptor.value;
}

function fail(code: PacketProblemCode, message: string): never {
  throw new PacketSchemaError(code, message);
}

/**
 * Принимает ровно канонический документ: точный набор ключей, известные
 * значения и уникальные пары (dataset, recordId, field). Возвращает новую
 * копию в каноническом порядке ключей — её можно сравнивать по байтам.
 */
export function readPacket(raw: unknown): PropertyIssuePacket {
  if (!isObject(raw)) fail('not_object', 'Ожидается объект заявки.');
  const keys = ['type', 'version', 'requestId', 'repositoryId', 'baseRevision', 'changes'];
  const own = Object.keys(raw);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    fail(own.some((key) => !keys.includes(key)) ? 'unknown_key' : 'missing_key', 'Неверный набор полей заявки.');
  }
  const values = Object.fromEntries(keys.map((key) => [key, readOwn(raw, key)]));
  if (values.type !== PROPERTY_ISSUE_TYPE) fail('bad_type', 'Неизвестный тип заявки.');
  if (values.version !== PROPERTY_ISSUE_VERSION) fail('bad_version', 'Неизвестная версия заявки.');
  if (!isString(values.requestId) || !REQUEST_ID_RE.test(values.requestId)) fail('bad_request_id', 'Некорректный идентификатор заявки.');
  if (values.repositoryId !== PROPERTY_REPOSITORY_ID) fail('bad_repository', 'Чужой репозиторий.');
  if (!isString(values.baseRevision) || !BASE_REVISION_RE.test(values.baseRevision)) fail('bad_base_revision', 'Некорректный отпечаток базы.');
  if (!Array.isArray(values.changes) || values.changes.length === 0) fail('no_changes', 'В заявке нет изменений.');
  if (values.changes.length > PROPERTY_LIMITS.changes) fail('too_many_changes', 'Слишком много изменений в заявке.');
  const seenRecords = new Set<string>();
  const seenChanges = new Set<string>();
  const changes: PropertyRequestChange[] = values.changes.map((item: unknown) => {
    if (!isObject(item)) fail('not_object', 'Ожидается объект изменения.');
    const itemKeys = ['dataset', 'recordId', 'field', 'before', 'after'];
    const itemOwn = Object.keys(item);
    if (itemOwn.length !== itemKeys.length || !itemKeys.every((key) => itemOwn.includes(key))) {
      fail(itemOwn.some((key) => !itemKeys.includes(key)) ? 'unknown_key' : 'missing_key', 'Неверный набор полей изменения.');
    }
    const dataset = readOwn(item, 'dataset');
    const recordId = readOwn(item, 'recordId');
    const field = readOwn(item, 'field');
    const before = readOwn(item, 'before');
    const after = readOwn(item, 'after');
    if (!PROPERTY_DATASETS.includes(dataset as PropertyDatasetName)) fail('bad_dataset', 'Неизвестный набор данных.');
    if (!PROPERTY_FIELDS.includes(field as PropertyFieldName)) fail('bad_field', 'Неизвестное поле.');
    if (!isString(recordId) || !recordId.trim() || recordId !== recordId.trim() ||
      recordId.length > PROPERTY_LIMITS.recordId || /[\u0000-\u001f\u007f]/.test(recordId)) {
      fail('bad_record_id', 'Некорректный идентификатор объекта.');
    }
    if (!isString(before) || !isString(after)) fail('bad_value', 'Значение поля должно быть строкой.');
    if (before === after) fail('bad_value', 'Изменение без разницы значений.');
    const limit = field === 'source_url' ? PROPERTY_LIMITS.sourceUrl : PROPERTY_LIMITS.value;
    for (const value of [before, after]) {
      if (value.length > limit) fail('too_long', 'Значение поля слишком длинное.');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/.test(value)) fail('bad_value', 'Управляющие символы в значении.');
    }
    const changeKey = JSON.stringify([dataset, recordId, field]);
    if (!seenChanges.has(changeKey)) seenChanges.add(changeKey);
    else fail('duplicate_change', 'Повтор поля в заявке.');
    const recordKey = JSON.stringify([dataset, recordId]);
    seenRecords.add(recordKey);
    return Object.freeze({
      dataset: dataset as PropertyDatasetName,
      recordId,
      field: field as PropertyFieldName,
      before,
      after,
    });
  });
  if (seenRecords.size > PROPERTY_LIMITS.records) fail('too_many_records', 'Слишком много объектов в заявке.');
  return Object.freeze({
    type: PROPERTY_ISSUE_TYPE,
    version: PROPERTY_ISSUE_VERSION,
    requestId: values.requestId,
    repositoryId: PROPERTY_REPOSITORY_ID,
    baseRevision: values.baseRevision,
    changes: Object.freeze(changes),
  });
}

/** Канонический JSON: порядок ключей задан схемой, отступ 2, перевод строки `\n`. */
export function canonicalPacketJson(packet: PropertyIssuePacket): string {
  const canonical = readPacket(packet);
  return JSON.stringify({
    type: canonical.type,
    version: canonical.version,
    requestId: canonical.requestId,
    repositoryId: canonical.repositoryId,
    baseRevision: canonical.baseRevision,
    changes: canonical.changes.map((change) => ({
      dataset: change.dataset,
      recordId: change.recordId,
      field: change.field,
      before: change.before,
      after: change.after,
    })),
  }, null, 2);
}

/** Заголовок Issue привязан к отпечатку пакета: текст и содержимое не расходятся. */
export function propertyIssueTitle(fingerprint: string): string {
  if (!BASE_REVISION_RE.test(fingerprint)) throw new TypeError('Некорректный отпечаток заявки.');
  return `${PROPERTY_ISSUE_TITLE_PREFIX} свойства точек · ${fingerprint.slice(0, 12)}`;
}

/** Отпечаток канонического JSON: метка содержимого, не подпись автора. */
export async function fingerprintPropertyPacket(json: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* --- Проверка публикуемого текста ---------------------------------------- */

/** Что нельзя публиковать: ошибка останавливает заявку. */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/, 'Похоже на токен GitHub.'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'Похоже на fine-grained токен GitHub.'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Похоже на приватный ключ.'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'Похоже на ключ AWS.'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'Похоже на API-ключ.'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'Похоже на заголовок с токеном.'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i, 'Ссылка содержит логин и пароль.'],
];
/**
 * Что требует внимания человека, но не блокирует: ложные срабатывания часты.
 * Границы слова заданы явно: `\b` в JavaScript не видит кириллицу.
 */
const SENSITIVE_HINTS = /(?<![\p{L}])(парол[а-я]*|password|passwd|секрет[а-я]*|secret|токен[а-я]*|token)(?![\p{L}])/iu;

export function scanPublicText(value: string): { readonly errors: readonly string[]; readonly warnings: readonly string[] } {
  const errors: string[] = [];
  for (const [pattern, message] of SECRET_PATTERNS) {
    if (pattern.test(value)) errors.push(message);
  }
  const warnings = SENSITIVE_HINTS.test(value) ? ['Текст упоминает секреты или пароли: убедитесь, что в нём нет непубличного.'] : [];
  return { errors, warnings };
}

/* --- Разметка тела Issue -------------------------------------------------- */

/** Длина ограждения длиннее любого ряда обратных кавычек внутри JSON. */
function codeFence(text: string): string {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    current = char === '`' ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Одна строка таблицы: `\`, `` ` ``, `|` и переводы строк экранируются. */
function tableCell(value: string): string {
  const flat = value.replace(/\r/g, '').replace(/\n/g, ' ⏎ ');
  const escaped = flat.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\|/g, '\\|');
  return escaped.length === 0 ? '*(пусто)*' : escaped;
}

export function renderPropertyIssueBody(packet: PropertyIssuePacket): string {
  const canonical = readPacket(packet);
  const json = canonicalPacketJson(canonical);
  const fence = codeFence(json);
  const records = new Set(canonical.changes.map((change) => JSON.stringify([change.dataset, change.recordId])));
  const rows = canonical.changes.map((change) => [
    `\`${tableCell(change.dataset)}/${tableCell(change.recordId)}\``,
    `\`${tableCell(change.field)}\``,
    tableCell(change.before),
    tableCell(change.after),
  ]);
  const lines = [
    '### Заявка на свойства точек',
    '',
    `- Тип: \`${PROPERTY_ISSUE_TYPE}\` v${PROPERTY_ISSUE_VERSION}`,
    `- Идентификатор заявки: \`${canonical.requestId}\``,
    `- Объектов: ${records.size}; полей: ${canonical.changes.length}`,
    `- База: \`${canonical.baseRevision}\` — отпечаток входов сборки, не доказательство публикации или прав.`,
    '',
    'Заявка публична: не содержит секретов и непубличных сведений. Создание заявки',
    'не означает применения правки и не подтверждает обновление сайта.',
    '',
    '| Объект | Поле | Было | Стало |',
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.join(' | ')} |`),
    '',
    PROPERTY_ISSUE_BEGIN,
    `${fence}json`,
    json,
    fence,
    PROPERTY_ISSUE_END,
    '',
  ];
  return lines.join('\n');
}

export type BodyParseResult =
  | { readonly status: 'accepted'; readonly packet: PropertyIssuePacket; readonly json: string }
  | { readonly status: 'rejected'; readonly code: PacketProblemCode | 'bad_envelope' | 'not_canonical' | 'too_long'; readonly message: string };

/**
 * Принимает только канонический блок: ровно один BEGIN/END, ровно один
 * JSON-блок между ними и байт-в-байт канонический JSON. Всё остальное —
 * отказ, чтобы отпечаток нельзя было пересчитать по другому тексту.
 */
export function parsePropertyIssueBody(body: unknown): BodyParseResult {
  if (!isString(body) || body.length === 0) return { status: 'rejected', code: 'bad_envelope', message: 'Тело заявки отсутствует.' };
  if (new TextEncoder().encode(body).length > PROPERTY_LIMITS.body) {
    return { status: 'rejected', code: 'too_long', message: 'Тело заявки слишком длинное.' };
  }
  const beginIndex = body.indexOf(PROPERTY_ISSUE_BEGIN);
  if (beginIndex < 0) return { status: 'rejected', code: 'bad_envelope', message: 'Маркеры заявки не найдены.' };
  const afterBegin = body.slice(beginIndex + PROPERTY_ISSUE_BEGIN.length);
  const open = /^\n(`{3,})json\n/.exec(afterBegin);
  if (!open) return { status: 'rejected', code: 'bad_envelope', message: 'Внутри маркеров нет JSON-блока.' };
  const fence = open[1] as string;
  const rest = afterBegin.slice(open[0].length);
  // Ограждение заведомо длиннее любого ряда кавычек внутри JSON, поэтому
  // первое же закрытие однозначно; маркеры внутри данных не ломают разбор.
  const close = rest.indexOf(`\n${fence}\n`);
  if (close < 0) return { status: 'rejected', code: 'bad_envelope', message: 'JSON-блок не закрыт.' };
  const json = rest.slice(0, close);
  const tail = rest.slice(close + fence.length + 2);
  if (!tail.startsWith(PROPERTY_ISSUE_END)) return { status: 'rejected', code: 'bad_envelope', message: 'Маркер завершения не найден.' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { status: 'rejected', code: 'bad_envelope', message: 'JSON не разбирается.' };
  }
  let packet: PropertyIssuePacket;
  try {
    packet = readPacket(raw);
  } catch (error) {
    const code = error instanceof PacketSchemaError ? error.code : 'not_object';
    const message = error instanceof PacketSchemaError ? error.message : 'Некорректная заявка.';
    return { status: 'rejected', code, message };
  }
  // Сильнейшая проверка каноничности: тело должно быть ровно тем, что рендерит
  // контракт. Это исключает другой порядок ключей, лишние пробелы, CRLF и
  // посторонний текст вокруг блока.
  if (renderPropertyIssueBody(packet) !== body) {
    return { status: 'rejected', code: 'not_canonical', message: 'Заявка не в канонической форме.' };
  }
  return { status: 'accepted', packet, json };
}
