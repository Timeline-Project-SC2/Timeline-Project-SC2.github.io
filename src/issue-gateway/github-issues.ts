/* GitHub Issues с внедрённым транспортом: офлайн-проверяемая логика отправки.
 *
 * Модуль не знает ни про Worker, ни про браузер: транспорт и токен передаёт
 * вызывающий код. Он отвечает за две вещи, которые дороже всего стоят при
 * ошибке:
 *
 * 1. Не создавать дубль. Если предыдущая попытка завершилась неизвестным
 *    результатом (таймаут, 5xx, 3xx, нечитаемый ответ), сначала ищется заявка
 *    с тем же ID в маркере; повтор создания — только при достоверном «нет» и
 *    только из вызывающего кода.
 * 2. Не выдавать успех за то, чего нет: `created` означает лишь факт создания
 *    Issue, но не проверку роли, не применение и не публикацию.
 *
 * Токен не попадает ни в результат, ни в сообщения об ошибке, ни в URL
 * (только заголовок Authorization, который вызывающий код не логирует).
 */
import {
  PROPERTY_LIST_PER_PAGE,
  PROPERTY_REPOSITORY,
  PROPERTY_REPOSITORY_ID,
  PROPERTY_ISSUE_TITLE_PREFIX,
  parsePropertyIssueBody,
} from './property-issue-contract.ts';

const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const USER_AGENT = 'timeline-issue-gateway';
const TOKEN_LIMIT = 2048;
const REQUEST_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
/** Сколько страниц по 100 Issue просматривается перед выводом «заявки нет». */
export const PROPERTY_SCAN_PAGES = 5;

export type Transport = (input: string, init: RequestInit) => Promise<Response>;

export interface IssuesApiConfig {
  /** Заменяемый базовый адрес API (mock-сервер). Только https или loopback. */
  readonly apiBase?: string;
}

export interface GithubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
}

/** `exists` — заявка уже есть (повтор после неизвестного результата). */
export type CreateResult =
  | { readonly status: 'created'; readonly issue: GithubIssue }
  | { readonly status: 'exists'; readonly issue: GithubIssue }
  | { readonly status: 'rejected' | 'unavailable' | 'invalid' };

export type LookupResult =
  | { readonly status: 'found'; readonly issue: GithubIssue }
  | { readonly status: 'absent' }
  | { readonly status: 'unavailable' };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= TOKEN_LIMIT && !/[\u0000-\u0020\u007f]/.test(value);
}
/** Базовый URL API: https любого хоста или http только loopback (тесты). */
function validApiBase(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !url.hostname) return false;
    const normalized = value.replace(/\/+$/, '');
    if (url.protocol === 'https:') return normalized === `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) {
      return normalized === `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    }
    return false;
  } catch { return false; }
}
/** Проверка токена и цели до любого сетевого запроса. */
export function issuesConfigValid(token: unknown, config: IssuesApiConfig): boolean {
  if (!validToken(token)) return false;
  if (config.apiBase === undefined) return true;
  return validApiBase(config.apiBase);
}
function apiRoot(config: IssuesApiConfig): string {
  return config.apiBase === undefined ? DEFAULT_API : config.apiBase.replace(/\/+$/, '');
}
function repoPath(config: IssuesApiConfig): string {
  return `${apiRoot(config)}/repos/${PROPERTY_REPOSITORY}`;
}
/** 3xx, 5xx и сетевой сбой не означают «не создано»: результат неизвестен. */
function unknownStatus(status: number): boolean {
  return (status >= 300 && status < 400) || status >= 500 || status === 429;
}
function readIssue(value: unknown): GithubIssue | null {
  if (!isObject(value)) return null;
  const { id, number, title, html_url: htmlUrl } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof title !== 'string' || title.length > 1024) return null;
  if (typeof htmlUrl !== 'string' || !htmlUrl.startsWith('https://github.com/') || htmlUrl.length > 2048) return null;
  return { id, number, title, htmlUrl };
}

/** Один запрос с таймаутом и `redirect: 'manual'` (3xx — неожиданный ответ). */
async function request(
  transport: Transport,
  url: string,
  token: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: string },
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await transport(url, {
      method: init.method,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверка цели: ответ репозитория должен назвать ожидаемый ID. Совпадение
 * имени в ответе не заменяет ID; чужой репозиторий — `rejected`.
 */
async function confirmRepository(
  transport: Transport,
  token: string,
  config: IssuesApiConfig,
): Promise<'ok' | 'rejected' | 'unavailable'> {
  const response = await request(transport, repoPath(config), token, { method: 'GET' });
  if (response === null) return 'unavailable';
  if (unknownStatus(response.status)) return 'unavailable';
  if (response.status === 404 || response.status === 403 || response.status === 401) return 'rejected';
  if (!response.ok) return 'unavailable';
  let payload: unknown;
  try { payload = await response.json(); } catch { return 'unavailable'; }
  if (!isObject(payload) || payload.id !== PROPERTY_REPOSITORY_ID) return 'rejected';
  return 'ok';
}

/**
 * Одна страница Issue. `exhausted` — страница короче лимита: других страниц
 * нет, значит отсутствие заявки достоверно.
 */
async function listIssuesPage(
  transport: Transport,
  token: string,
  config: IssuesApiConfig,
  page: number,
): Promise<{ readonly data: unknown; readonly exhausted: boolean } | { readonly error: 'unavailable' | 'rejected' }> {
  const query = new URLSearchParams({
    state: 'all',
    per_page: String(PROPERTY_LIST_PER_PAGE),
    sort: 'created',
    direction: 'desc',
    page: String(page),
  });
  const response = await request(transport, `${repoPath(config)}/issues?${query.toString()}`, token, { method: 'GET' });
  if (response === null) return { error: 'unavailable' };
  if (unknownStatus(response.status)) return { error: 'unavailable' };
  if (response.status === 401 || response.status === 403 || response.status === 404) return { error: 'rejected' };
  if (!response.ok) return { error: 'unavailable' };
  let data: unknown;
  try { data = await response.json(); } catch { return { error: 'unavailable' }; }
  if (!Array.isArray(data)) return { error: 'unavailable' };
  return { data, exhausted: data.length < PROPERTY_LIST_PER_PAGE };
}

/**
 * Достоверное «заявка есть» — только при маркере в заголовке и точном ID
 * заявки в разобранном теле. «Нет» — только после полного перебора страниц
 * (до предела `PROPERTY_SCAN_PAGES`); иначе `unavailable`, а не «нет»:
 * иначе повтор создания даст дубль.
 * `rejected` — API ответил отказом (401/403/404): цель недоступна.
 */
export async function resolveIssue(
  token: string,
  config: IssuesApiConfig,
  requestId: string,
  transport: Transport = fetch,
): Promise<CreateResult | { readonly status: 'absent' }> {
  if (!issuesConfigValid(token, config) || !REQUEST_ID_RE.test(requestId) || typeof transport !== 'function') {
    return { status: 'invalid' };
  }
  for (let page = 1; page <= PROPERTY_SCAN_PAGES; page += 1) {
    const listed = await listIssuesPage(transport, token, config, page);
    if ('error' in listed) return { status: listed.error === 'rejected' ? 'rejected' : 'unavailable' };
    for (const entry of listed.data as unknown[]) {
      if (!isObject(entry)) return { status: 'unavailable' };
      // Issues API отдаёт и pull request'ы: у них то же тело, но другой объект.
      if (Object.hasOwn(entry, 'pull_request')) continue;
      const issue = readIssue(entry);
      if (issue === null) return { status: 'unavailable' };
      if (issue.title !== PROPERTY_ISSUE_TITLE_PREFIX && !issue.title.startsWith(`${PROPERTY_ISSUE_TITLE_PREFIX} `)) continue;
      if (typeof entry.body !== 'string') continue;
      const parsed = parsePropertyIssueBody(entry.body);
      if (parsed.status === 'accepted' && parsed.packet.requestId === requestId) {
        return { status: 'exists', issue };
      }
    }
    if (listed.exhausted) return { status: 'absent' };
  }
  // Предел просмотра: могло быть больше заявок, чем проверено.
  return { status: 'unavailable' };
}

export async function findRequestIssue(
  token: string,
  config: IssuesApiConfig,
  requestId: string,
  transport: Transport = fetch,
): Promise<LookupResult> {
  const resolved = await resolveIssue(token, config, requestId, transport);
  if (resolved.status === 'exists') return { status: 'found', issue: resolved.issue };
  if (resolved.status === 'absent') return { status: 'absent' };
  return { status: 'unavailable' };
}

export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  /** ID заявки внутри тела; сверяется с разобранным пакетом. */
  readonly requestId: string;
}

/**
 * Создание заявки: сначала проверка цели и поиск уже созданной, затем один
 * POST. Между поиском и созданием остаётся окно гонки — GitHub не даёт
 * атомарной «создай, если нет»; это ограничение, а не гарантия.
 * Повтор после `unavailable` разрешает только вызывающий код, после
 * `findRequestIssue` → `absent`.
 */
export async function createRequestIssue(
  token: string,
  config: IssuesApiConfig,
  input: CreateIssueInput,
  transport: Transport = fetch,
): Promise<CreateResult> {
  if (!issuesConfigValid(token, config) || typeof transport !== 'function' ||
    !REQUEST_ID_RE.test(input.requestId) ||
    typeof input.title !== 'string' || input.title.length === 0 || input.title.length > 256 ||
    !input.title.startsWith(`${PROPERTY_ISSUE_TITLE_PREFIX} `) ||
    typeof input.body !== 'string' || input.body.length === 0 || input.body.length > 60_000) {
    return { status: 'invalid' };
  }
  const parsed = parsePropertyIssueBody(input.body);
  if (parsed.status !== 'accepted' || parsed.packet.requestId !== input.requestId) return { status: 'invalid' };

  const target = await confirmRepository(transport, token, config);
  if (target === 'rejected') return { status: 'rejected' };
  if (target === 'unavailable') return { status: 'unavailable' };

  const existing = await resolveIssue(token, config, input.requestId, transport);
  if (existing.status === 'exists') return { status: 'exists', issue: existing.issue };
  if (existing.status !== 'absent') return { status: existing.status === 'rejected' ? 'rejected' : 'unavailable' };

  const response = await request(transport, `${repoPath(config)}/issues`, token, {
    method: 'POST',
    body: JSON.stringify({ title: input.title, body: input.body }),
  });
  if (response === null) return { status: 'unavailable' };
  if (unknownStatus(response.status)) return { status: 'unavailable' };
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422) {
    return { status: 'rejected' };
  }
  if (response.status !== 201 && response.status !== 200) return { status: 'unavailable' };
  let payload: unknown;
  try { payload = await response.json(); } catch { return { status: 'unavailable' }; }
  if (!isObject(payload) || payload.title !== input.title || payload.body !== input.body) {
    // Ответ не подтверждает отправленное: проверять придётся повторным поиском.
    return { status: 'unavailable' };
  }
  const issue = readIssue(payload);
  if (issue === null) return { status: 'unavailable' };
  return { status: 'created', issue };
}
