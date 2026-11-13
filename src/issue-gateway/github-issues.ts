/* Транспорт приватных заявок. Цель и автор-бот обязательны; публичного fallback нет.
 * Issue и комментарии только создаются и читаются, никогда не редактируются.
 * Неизвестный результат создания не считается отсутствием заявки.
 */
import { PROPERTY_LIST_PER_PAGE, PROPERTY_ISSUE_TITLE_PREFIX, canonicalPacketJson, isPropertyRequestId, parsePropertyIssueBody } from './property-issue-contract.ts';
import type { PropertyIssuePacket, PropertyRepositoryTarget } from './property-issue-contract.ts';
export const PROPERTY_SCAN_PAGES = 5;
export type Transport = (input: string, init: RequestInit) => Promise<Response>;
export interface IssuesApiConfig {
  readonly target: PropertyRepositoryTarget;
  readonly botLogin: string;
  readonly apiBase?: string;
}
export interface GithubIssue {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly htmlUrl: string;
  readonly state: 'open' | 'closed';
}
export type CreateResult =
  | { readonly status: 'created' | 'exists'; readonly issue: GithubIssue; readonly commentId?: number }
  | { readonly status: 'rejected' | 'unavailable' | 'invalid' | 'closed' };
export type LookupResult =
  | { readonly status: 'found'; readonly issue: GithubIssue }
  | { readonly status: 'absent' | 'unavailable' };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(value);
function apiRoot(config: IssuesApiConfig): string | null {
  const value = config.apiBase ?? 'https://api.github.com';
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
export function issuesConfigValid(token: unknown, config: IssuesApiConfig): boolean {
  return validToken(token) && Number.isSafeInteger(config.target?.id) && config.target.id > 0 &&
    /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(config.target?.fullName ?? '') &&
    typeof config.botLogin === 'string' && /^[a-z\d-]{1,100}\[bot\]$/i.test(config.botLogin) && apiRoot(config) !== null;
}
function repoPath(config: IssuesApiConfig): string { return `${apiRoot(config)}/repos/${config.target.fullName}`; }
const unknownStatus = (status: number): boolean => (status >= 300 && status < 400) || status >= 500 || status === 429;
async function request(transport: Transport, url: string, token: string,
  init: { readonly method: 'GET' | 'POST'; readonly body?: string }): Promise<Response | null> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await transport(url, { method: init.method, redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'timeline-issue-gateway',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(init.body === undefined ? {} : { body: init.body }) });
  } catch { return null; } finally { clearTimeout(timer); }
}
function botAuthor(value: unknown, config: IssuesApiConfig): boolean {
  return object(value) && value.type === 'Bot' && typeof value.login === 'string' && value.login.toLowerCase() === config.botLogin.toLowerCase();
}
function readIssue(value: unknown, config: IssuesApiConfig): GithubIssue | null {
  if (!object(value) || Object.hasOwn(value, 'pull_request') || !botAuthor(value.user, config)) return null;
  const { id, number, title, html_url: htmlUrl, state } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
    typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0 ||
    typeof title !== 'string' || title.length > 1024 || (state !== 'open' && state !== 'closed') ||
    typeof htmlUrl !== 'string' || !htmlUrl.startsWith('https://github.com/') || htmlUrl.length > 2048) return null;
  return { id, number, title, htmlUrl, state };
}
/** Проверяем ID, имя, организацию, приватность и включённые Issues до записи. */
export async function confirmRepository(transport: Transport, token: string, config: IssuesApiConfig): Promise<'ok' | 'rejected' | 'unavailable'> {
  const response = await request(transport, repoPath(config), token, { method: 'GET' });
  if (response === null || unknownStatus(response.status)) return 'unavailable';
  if ([401, 403, 404].includes(response.status)) return 'rejected';
  if (!response.ok) return 'unavailable';
  let p: unknown; try { p = await response.json(); } catch { return 'unavailable'; }
  if (!object(p) || p.id !== config.target.id || typeof p.full_name !== 'string' ||
    p.full_name.toLowerCase() !== config.target.fullName.toLowerCase() || p.private !== true ||
    p.visibility !== 'private' || p.has_issues !== true || p.archived === true || !object(p.owner) ||
    p.owner.type !== 'Organization' || typeof p.owner.login !== 'string' ||
    p.owner.login.toLowerCase() !== config.target.fullName.split('/')[0]!.toLowerCase()) return 'rejected';
  return 'ok';
}
async function jsonPage(transport: Transport, token: string, url: string): Promise<{ readonly data: unknown[]; readonly exhausted: boolean } | { readonly error: 'unavailable' | 'rejected' }> {
  const response = await request(transport, url, token, { method: 'GET' });
  if (response === null || unknownStatus(response.status)) return { error: 'unavailable' };
  if ([401, 403, 404].includes(response.status)) return { error: 'rejected' };
  if (!response.ok) return { error: 'unavailable' };
  let data: unknown; try { data = await response.json(); } catch { return { error: 'unavailable' }; }
  if (!Array.isArray(data)) return { error: 'unavailable' };
  return { data, exhausted: data.length < PROPERTY_LIST_PER_PAGE };
}
function matchesPacket(entry: unknown, packet: PropertyIssuePacket, config: IssuesApiConfig): boolean {
  if (!object(entry) || typeof entry.body !== 'string' || !botAuthor(entry.user, config)) return false;
  const parsed = parsePropertyIssueBody(entry.body, config.target);
  return parsed.status === 'accepted' && parsed.packet.requestId === packet.requestId &&
    parsed.packet.threadId === packet.threadId && parsed.packet.author.id === packet.author.id && parsed.json === canonicalPacketJson(packet);
}
/** Поиск восстанавливает неизвестный результат; предел просмотра не означает «нет». */
export async function resolveIssue(token: string, config: IssuesApiConfig, packet: PropertyIssuePacket,
  transport: Transport = fetch): Promise<CreateResult | { readonly status: 'absent' }> {
  if (!issuesConfigValid(token, config)) return { status: 'invalid' };
  for (let page = 1; page <= PROPERTY_SCAN_PAGES; page++) {
    const query = new URLSearchParams({ state: 'all', per_page: String(PROPERTY_LIST_PER_PAGE), sort: 'created', direction: 'desc', page: String(page) });
    const listed = await jsonPage(transport, token, `${repoPath(config)}/issues?${query}`);
    if ('error' in listed) return { status: listed.error };
    for (const entry of listed.data) {
      if (object(entry) && Object.hasOwn(entry, 'pull_request')) continue;
      if (!matchesPacket(entry, packet, config)) continue;
      const issue = readIssue(entry, config);
      return issue === null ? { status: 'unavailable' } : { status: 'exists', issue };
    }
    if (listed.exhausted) return { status: 'absent' };
  }
  return { status: 'unavailable' };
}
export async function findRequestIssue(token: string, config: IssuesApiConfig, packet: PropertyIssuePacket, transport: Transport = fetch): Promise<LookupResult> {
  const result = await resolveIssue(token, config, packet, transport);
  if (result.status === 'exists') return { status: 'found', issue: result.issue };
  return { status: result.status === 'absent' ? 'absent' : 'unavailable' };
}
export async function readRequestIssue(token: string, config: IssuesApiConfig, number: number, packet: PropertyIssuePacket, transport: Transport = fetch): Promise<LookupResult> {
  if (!issuesConfigValid(token, config) || !Number.isSafeInteger(number) || number <= 0) return { status: 'unavailable' };
  const response = await request(transport, `${repoPath(config)}/issues/${number}`, token, { method: 'GET' });
  if (response === null || unknownStatus(response.status)) return { status: 'unavailable' };
  if ([401, 403, 404].includes(response.status)) return { status: 'unavailable' };
  if (!response.ok) return { status: 'unavailable' };
  let payload: unknown; try { payload = await response.json(); } catch { return { status: 'unavailable' }; }
  const issue = readIssue(payload, config);
  if (issue === null || issue.number !== number || !matchesPacket(payload, packet, config)) return { status: 'unavailable' };
  return { status: 'found', issue };
}
export interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly packet: PropertyIssuePacket;
  /** Продолжение нити: номер ранее созданной корневой Issue. */
  readonly threadIssueNumber?: number;
  /** false — первый атомарно зарезервированный POST; true — восстановление неизвестного результата. */
  readonly recover?: boolean;
}
async function resolveComment(token: string, config: IssuesApiConfig, number: number, packet: PropertyIssuePacket,
  transport: Transport): Promise<{ readonly status: 'exists'; readonly commentId: number } | { readonly status: 'absent' | 'unavailable' | 'rejected' }> {
  for (let page = 1; page <= PROPERTY_SCAN_PAGES; page++) {
    const query = new URLSearchParams({ per_page: String(PROPERTY_LIST_PER_PAGE), page: String(page) });
    const listed = await jsonPage(transport, token, `${repoPath(config)}/issues/${number}/comments?${query}`);
    if ('error' in listed) return { status: listed.error };
    for (const entry of listed.data) {
      if (!matchesPacket(entry, packet, config)) continue;
      if (!object(entry) || !botAuthor(entry.user, config) || typeof entry.id !== 'number' || !Number.isSafeInteger(entry.id) || entry.id <= 0) return { status: 'unavailable' };
      return { status: 'exists', commentId: entry.id };
    }
    if (listed.exhausted) return { status: 'absent' };
  }
  return { status: 'unavailable' };
}
/** Корень — Issue; новая версия — новый комментарий. PATCH/PUT здесь нет. */
export async function createRequestIssue(token: string, config: IssuesApiConfig, input: CreateIssueInput, transport: Transport = fetch): Promise<CreateResult> {
  const p = input.packet;
  if (!issuesConfigValid(token, config) || typeof input.title !== 'string' || input.title.length > 256 ||
    !input.title.startsWith(`${PROPERTY_ISSUE_TITLE_PREFIX} `) || !isPropertyRequestId(p?.requestId) ||
    p.repositoryId !== config.target.id || !isPropertyRequestId(p.threadId)) return { status: 'invalid' };
  const parsed = parsePropertyIssueBody(input.body, config.target);
  if (parsed.status !== 'accepted' || parsed.json !== canonicalPacketJson(p)) return { status: 'invalid' };
  const continuation = input.threadIssueNumber !== undefined;
  if (continuation === (p.threadId === p.requestId) || (continuation && (!Number.isSafeInteger(input.threadIssueNumber) || input.threadIssueNumber! <= 0))) return { status: 'invalid' };
  const target = await confirmRepository(transport, token, config);
  if (target !== 'ok') return { status: target };
  let issue: GithubIssue | null = null;
  if (continuation) {
    // Корень проверяет вызывающий Worker по своему индексу автора; здесь проверяем GitHub.
    const response = await request(transport, `${repoPath(config)}/issues/${input.threadIssueNumber}`, token, { method: 'GET' });
    if (response === null || unknownStatus(response.status)) return { status: 'unavailable' };
    if ([401, 403, 404].includes(response.status)) return { status: 'rejected' };
    let payload: unknown; try { payload = await response.json(); } catch { return { status: 'unavailable' }; }
    issue = readIssue(payload, config);
    const root = object(payload) && typeof payload.body === 'string' ? parsePropertyIssueBody(payload.body, config.target) : null;
    if (issue === null || root === null || root.status !== 'accepted' || root.packet.threadId !== p.threadId ||
      root.packet.requestId !== p.threadId || root.packet.author.id !== p.author.id) return { status: 'invalid' };
    if (issue.state !== 'open') return { status: 'closed' };
    if (input.recover !== false) {
      const existing = await resolveComment(token, config, issue.number, p, transport);
      if (existing.status === 'exists') return { status: 'exists', issue, commentId: existing.commentId };
      if (existing.status === 'rejected') return { status: 'rejected' };
      if (existing.status !== 'absent') return { status: 'unavailable' };
    }
  } else if (input.recover !== false) {
    const existing = await resolveIssue(token, config, p, transport);
    if (existing.status === 'exists') return existing;
    if (existing.status === 'rejected') return { status: 'rejected' };
    if (existing.status !== 'absent') return { status: 'unavailable' };
  }
  const response = await request(transport, `${repoPath(config)}/issues${continuation ? `/${input.threadIssueNumber}/comments` : ''}`, token,
    { method: 'POST', body: JSON.stringify(continuation ? { body: input.body } : { title: input.title, body: input.body }) });
  if (response === null || unknownStatus(response.status)) return { status: 'unavailable' };
  if ([401, 403, 404, 410, 422].includes(response.status)) return { status: 'rejected' };
  if (response.status !== 201 && response.status !== 200) return { status: 'unavailable' };
  let payload: unknown; try { payload = await response.json(); } catch { return { status: 'unavailable' }; }
  if (!object(payload) || payload.body !== input.body || !botAuthor(payload.user, config)) return { status: 'unavailable' };
  if (continuation) {
    if (typeof payload.id !== 'number' || !Number.isSafeInteger(payload.id) || payload.id <= 0) return { status: 'unavailable' };
    return { status: 'created', issue: issue!, commentId: payload.id };
  }
  if (payload.title !== input.title) return { status: 'unavailable' };
  const created = readIssue(payload, config);
  return created === null ? { status: 'unavailable' } : { status: 'created', issue: created };
}
