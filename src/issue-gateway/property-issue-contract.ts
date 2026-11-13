/* Единый контракт браузера и Worker. Черновик не содержит авторства:
 * номер, логин, время и приватную цель проставляет только сервер.
 * Отпечаток — метка содержимого, не подпись и не разрешение на применение.
 */
export const PROPERTY_ISSUE_TYPE = 'sector-property-request';
export const PROPERTY_ISSUE_VERSION = 2;
export const PROPERTY_ISSUE_TITLE_PREFIX = '[ADM-ACCESS]';
export const PROPERTY_ISSUE_BEGIN = '<!-- sector-property-request:v2:begin -->';
export const PROPERTY_ISSUE_END = '<!-- sector-property-request:v2:end -->';
export const PROPERTY_LIST_PER_PAGE = 100;
export const PROPERTY_DATASETS = ['systems', 'places'] as const;
export const PROPERTY_FIELDS = ['name', 'type', 'faction', 'description', 'source_url'] as const;
export type PropertyDatasetName = (typeof PROPERTY_DATASETS)[number];
export type PropertyFieldName = (typeof PROPERTY_FIELDS)[number];
export const PROPERTY_LIMITS = {
  changes: 100, records: 50, requestId: 64, recordId: 128,
  value: 4000, sourceUrl: 2048, title: 200, body: 60_000, login: 39,
} as const;
export interface PropertyRepositoryTarget {
  readonly id: number;
  readonly fullName: string;
}
export interface PropertyRequestAuthor {
  readonly id: number;
  readonly login: string;
}
export interface PropertyRequestChange {
  readonly dataset: PropertyDatasetName;
  readonly recordId: string;
  readonly field: PropertyFieldName;
  readonly before: string;
  readonly after: string;
}
/** Незаверенный черновик. Сервер заменяет тип и добавляет свои поля. */
export interface PropertyRequestDraft {
  readonly type: 'sector-property-request-draft';
  readonly version: typeof PROPERTY_ISSUE_VERSION;
  readonly requestId: string;
  /** Первая версия: threadId = requestId; продолжение — комментарий той же Issue. */
  readonly threadId: string;
  readonly baseRevision: string;
  readonly changes: readonly PropertyRequestChange[];
}
export interface PropertyIssuePacket {
  readonly type: typeof PROPERTY_ISSUE_TYPE;
  readonly version: typeof PROPERTY_ISSUE_VERSION;
  readonly requestId: string;
  readonly threadId: string;
  readonly repositoryId: number;
  readonly author: PropertyRequestAuthor;
  /** Время первой подготовки на сервере; повтор запроса его не меняет. */
  readonly createdAt: string;
  readonly baseRevision: string;
  readonly changes: readonly PropertyRequestChange[];
}
export type PacketProblemCode =
  | 'not_object' | 'unknown_key' | 'missing_key' | 'bad_type' | 'bad_version'
  | 'bad_request_id' | 'bad_thread_id' | 'bad_repository' | 'bad_author'
  | 'bad_created_at' | 'bad_base_revision' | 'no_changes' | 'too_many_changes'
  | 'too_many_records' | 'bad_dataset' | 'bad_field' | 'bad_record_id'
  | 'duplicate_change' | 'bad_before' | 'bad_after' | 'too_long' | 'bad_value';
export interface PacketProblem { readonly code: PacketProblemCode; readonly message: string }
export class PacketSchemaError extends TypeError {
  readonly code: PacketProblemCode;
  constructor(code: PacketProblemCode, message: string) {
    super(message); this.name = 'PacketSchemaError'; this.code = code;
  }
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const BASE_REVISION_RE = /^[a-f0-9]{64}$/;
const LOGIN_RE = /^[a-z\d]+(?:-[a-z\d]+)*$/i;
const CREATED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const isPropertyRequestId = (value: unknown): value is string => isString(value) && REQUEST_ID_RE.test(value);
export const isPropertyRepositoryId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isCreatedAt = (value: unknown): value is string => isString(value) && CREATED_AT_RE.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fail(code: PacketProblemCode, message: string): never { throw new PacketSchemaError(code, message); }
function readOwn(entry: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(entry, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('not_object', 'Ожидается собственное значение поля.');
  return descriptor.value;
}
function exactKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  const own = Object.keys(raw);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    fail(own.some((key) => !keys.includes(key)) ? 'unknown_key' : 'missing_key', 'Неверный набор полей заявки.');
  }
}
function readChanges(raw: unknown): readonly PropertyRequestChange[] {
  if (!Array.isArray(raw) || raw.length === 0) fail('no_changes', 'В заявке нет изменений.');
  if (raw.length > PROPERTY_LIMITS.changes) fail('too_many_changes', 'Слишком много изменений в заявке.');
  const records = new Set<string>();
  const seen = new Set<string>();
  const changes = raw.map((item: unknown) => {
    if (!isObject(item)) fail('not_object', 'Ожидается объект изменения.');
    const keys = ['dataset', 'recordId', 'field', 'before', 'after'];
    exactKeys(item, keys);
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
    const key = JSON.stringify([dataset, recordId, field]);
    if (seen.has(key)) fail('duplicate_change', 'Повтор поля в заявке.');
    seen.add(key); records.add(JSON.stringify([dataset, recordId]));
    return Object.freeze({ dataset: dataset as PropertyDatasetName, recordId, field: field as PropertyFieldName, before, after });
  });
  if (records.size > PROPERTY_LIMITS.records) fail('too_many_records', 'Слишком много объектов в заявке.');
  return Object.freeze(changes);
}
/** Браузер не выбирает автора, время и приватный репозиторий. */
export function readPropertyRequestDraft(raw: unknown): PropertyRequestDraft {
  if (!isObject(raw)) fail('not_object', 'Ожидается объект черновика.');
  const keys = ['type', 'version', 'requestId', 'threadId', 'baseRevision', 'changes'];
  exactKeys(raw, keys);
  const v = Object.fromEntries(keys.map((key) => [key, readOwn(raw, key)]));
  if (v.type !== 'sector-property-request-draft') fail('bad_type', 'Неизвестный тип черновика.');
  if (v.version !== PROPERTY_ISSUE_VERSION) fail('bad_version', 'Неизвестная версия заявки.');
  if (!isPropertyRequestId(v.requestId)) fail('bad_request_id', 'Некорректный идентификатор версии.');
  if (!isPropertyRequestId(v.threadId)) fail('bad_thread_id', 'Некорректный идентификатор нити.');
  if (!isString(v.baseRevision) || !BASE_REVISION_RE.test(v.baseRevision)) fail('bad_base_revision', 'Некорректный отпечаток базы.');
  return Object.freeze({ type: 'sector-property-request-draft', version: PROPERTY_ISSUE_VERSION,
    requestId: v.requestId, threadId: v.threadId, baseRevision: v.baseRevision, changes: readChanges(v.changes) });
}
/** Цель обязательна: публичный сайт не является резервной целью записи. */
export function readPacket(raw: unknown, target: PropertyRepositoryTarget): PropertyIssuePacket {
  if (!isPropertyRepositoryId(target?.id) || !/^[a-z\d-]+\/[a-z\d_.-]+$/i.test(target?.fullName ?? '')) {
    fail('bad_repository', 'Цель заявок не настроена.');
  }
  if (!isObject(raw)) fail('not_object', 'Ожидается объект заявки.');
  const keys = ['type', 'version', 'requestId', 'threadId', 'repositoryId', 'author', 'createdAt', 'baseRevision', 'changes'];
  exactKeys(raw, keys);
  const v = Object.fromEntries(keys.map((key) => [key, readOwn(raw, key)]));
  if (v.type !== PROPERTY_ISSUE_TYPE) fail('bad_type', 'Неизвестный тип заявки.');
  if (v.version !== PROPERTY_ISSUE_VERSION) fail('bad_version', 'Неизвестная версия заявки.');
  if (!isPropertyRequestId(v.requestId)) fail('bad_request_id', 'Некорректный идентификатор версии.');
  if (!isPropertyRequestId(v.threadId)) fail('bad_thread_id', 'Некорректный идентификатор нити.');
  if (v.repositoryId !== target.id) fail('bad_repository', 'Чужой репозиторий.');
  if (!isObject(v.author)) fail('bad_author', 'Автор заявки не указан.');
  exactKeys(v.author, ['id', 'login']);
  const id = readOwn(v.author, 'id');
  const login = readOwn(v.author, 'login');
  if (!isPropertyRepositoryId(id) || !isString(login) || login.length > PROPERTY_LIMITS.login || !LOGIN_RE.test(login)) {
    fail('bad_author', 'Некорректный номер или логин автора.');
  }
  if (!isCreatedAt(v.createdAt)) fail('bad_created_at', 'Некорректное время подготовки заявки.');
  if (!isString(v.baseRevision) || !BASE_REVISION_RE.test(v.baseRevision)) fail('bad_base_revision', 'Некорректный отпечаток базы.');
  return Object.freeze({ type: PROPERTY_ISSUE_TYPE, version: PROPERTY_ISSUE_VERSION,
    requestId: v.requestId, threadId: v.threadId, repositoryId: target.id,
    author: Object.freeze({ id, login }), createdAt: v.createdAt, baseRevision: v.baseRevision, changes: readChanges(v.changes) });
}
export function sealPropertyRequest(rawDraft: unknown, author: PropertyRequestAuthor, createdAt: string, target: PropertyRepositoryTarget): PropertyIssuePacket {
  const draft = readPropertyRequestDraft(rawDraft);
  return readPacket({ type: PROPERTY_ISSUE_TYPE, version: PROPERTY_ISSUE_VERSION,
    requestId: draft.requestId, threadId: draft.threadId, repositoryId: target.id,
    author, createdAt, baseRevision: draft.baseRevision, changes: draft.changes }, target);
}
export function canonicalPacketJson(packet: PropertyIssuePacket): string {
  const p = readPacket(packet, { id: packet.repositoryId, fullName: 'private/requests' });
  return JSON.stringify({ type: p.type, version: p.version, requestId: p.requestId, threadId: p.threadId,
    repositoryId: p.repositoryId, author: { id: p.author.id, login: p.author.login }, createdAt: p.createdAt,
    baseRevision: p.baseRevision, changes: p.changes.map((c) => ({ dataset: c.dataset, recordId: c.recordId,
      field: c.field, before: c.before, after: c.after })) }, null, 2);
}
export function propertyIssueTitle(fingerprint: string): string {
  if (!BASE_REVISION_RE.test(fingerprint)) throw new TypeError('Некорректный отпечаток заявки.');
  return `${PROPERTY_ISSUE_TITLE_PREFIX} свойства точек · ${fingerprint.slice(0, 12)}`;
}
export async function fingerprintPropertyPacket(json: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/, 'Похоже на токен GitHub.'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, 'Похоже на fine-grained токен GitHub.'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'Похоже на приватный ключ.'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'Похоже на ключ AWS.'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'Похоже на API-ключ.'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'Похоже на заголовок с токеном.'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i, 'Ссылка содержит логин и пароль.'],
];
const SENSITIVE_HINTS = /(?<![\p{L}])(парол[а-я]*|password|passwd|секрет[а-я]*|secret|токен[а-я]*|token)(?![\p{L}])/iu;
export function scanPublicText(value: string): { readonly errors: readonly string[]; readonly warnings: readonly string[] } {
  return { errors: SECRET_PATTERNS.filter(([pattern]) => pattern.test(value)).map(([, message]) => message),
    warnings: SENSITIVE_HINTS.test(value) ? ['Текст упоминает секреты: убедитесь, что их нет в заявке.'] : [] };
}
function codeFence(text: string): string {
  let longest = 0, current = 0;
  for (const char of text) { current = char === '`' ? current + 1 : 0; longest = Math.max(longest, current); }
  return '`'.repeat(Math.max(3, longest + 1));
}
/** Экранируем разметку, а не разрешаем HTML в пользовательских значениях. */
function humanValue(value: string): string {
  const flat = value.replace(/\n/g, ' ⏎ ');
  const escaped = flat.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]{}()#+!|~]/g, '\\$&');
  return escaped.length === 0 ? '(пусто)' : escaped;
}
const FIELD_LABELS: Readonly<Record<PropertyFieldName, string>> = {
  name: 'Название', type: 'Тип', faction: 'Фракция', description: 'Описание', source_url: 'Ссылка на источник',
};
export function renderPropertyIssueBody(packet: PropertyIssuePacket): string {
  const p = readPacket(packet, { id: packet.repositoryId, fullName: 'private/requests' });
  const json = canonicalPacketJson(p), fence = codeFence(json);
  const records = new Set(p.changes.map((c) => JSON.stringify([c.dataset, c.recordId])));
  const lines = ['### Заявка на свойства точек', '',
    `- Кто: @${p.author.login} · номер GitHub \`${p.author.id}\``,
    `- Когда подготовлена: ${p.createdAt} (UTC)`,
    `- Что меняется: объектов ${records.size}, полей ${p.changes.length}`,
    `- Нить: \`${p.threadId}\`; версия: \`${p.requestId}\``,
    `- База: \`${p.baseRevision}\``, '',
    'Заявка хранится в закрытом репозитории. Создание заявки не применяет',
    'правку и не обновляет сайт. Новая версия — отдельная запись в той же нити;',
    'прежние записи не редактируются.', ''];
  for (const c of p.changes) lines.push(`#### ${c.dataset === 'systems' ? 'Система' : 'Место'} · ID ${humanValue(c.recordId)}`,
    `- ${FIELD_LABELS[c.field]}: ${humanValue(c.before)} → ${humanValue(c.after)}`, '');
  lines.push(PROPERTY_ISSUE_BEGIN, `${fence}json`, json, fence, PROPERTY_ISSUE_END, '');
  return lines.join('\n');
}
export type BodyParseResult =
  | { readonly status: 'accepted'; readonly packet: PropertyIssuePacket; readonly json: string }
  | { readonly status: 'rejected'; readonly code: PacketProblemCode | 'bad_envelope' | 'not_canonical' | 'too_long'; readonly message: string };
/** Принимаем ровно один канонический блок, включая человекочитаемую шапку. */
export function parsePropertyIssueBody(body: unknown, target: PropertyRepositoryTarget): BodyParseResult {
  const reject = (code: PacketProblemCode | 'bad_envelope' | 'not_canonical' | 'too_long', message: string): BodyParseResult => ({ status: 'rejected', code, message });
  if (!isString(body) || body.length === 0) return reject('bad_envelope', 'Тело заявки отсутствует.');
  if (new TextEncoder().encode(body).length > PROPERTY_LIMITS.body) return reject('too_long', 'Тело заявки слишком длинное.');
  const begin = body.indexOf(PROPERTY_ISSUE_BEGIN);
  if (begin < 0) return reject('bad_envelope', 'Маркеры заявки не найдены.');
  const after = body.slice(begin + PROPERTY_ISSUE_BEGIN.length);
  const open = /^\n(`{3,})json\n/.exec(after);
  if (!open) return reject('bad_envelope', 'Внутри маркеров нет JSON-блока.');
  const fence = open[1]!, rest = after.slice(open[0].length);
  const close = rest.indexOf(`\n${fence}\n`);
  if (close < 0) return reject('bad_envelope', 'JSON-блок не закрыт.');
  const json = rest.slice(0, close);
  if (!rest.slice(close + fence.length + 2).startsWith(PROPERTY_ISSUE_END)) return reject('bad_envelope', 'Маркер завершения не найден.');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return reject('bad_envelope', 'JSON не разбирается.'); }
  let packet: PropertyIssuePacket;
  try { packet = readPacket(raw, target); } catch (error) {
    return reject(error instanceof PacketSchemaError ? error.code : 'not_object', error instanceof Error ? error.message : 'Некорректная заявка.');
  }
  if (renderPropertyIssueBody(packet) !== body) return reject('not_canonical', 'Заявка не в канонической форме.');
  return { status: 'accepted', packet, json };
}
