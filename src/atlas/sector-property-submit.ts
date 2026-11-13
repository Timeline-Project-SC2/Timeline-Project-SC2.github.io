/* Клиент приватного шлюза: черновик → подтверждение просмотра → отправка.
 * Сервер подписывает автором сессии; браузер не посылает токен или логин.
 * Неизвестный результат нельзя превращать в повторную новую заявку.
 */
import type { PropertyRequestDraft } from '../issue-gateway/property-issue-contract.ts';
export type SubmitStatus = 'created' | 'existing' | 'unauthorized' | 'rejected' | 'unavailable' | 'invalid' | 'disabled' | 'limit' | 'closed';
export interface SubmitOutcome { readonly status: SubmitStatus; readonly number?: number }
export interface PreparedSubmission {
  readonly status: 'prepared';
  readonly requestId: string;
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly fingerprint: string;
}
export type PrepareOutcome =
  | { readonly status: 'unavailable' | 'unauthorized' | 'invalid' | 'disabled' | 'closed' | 'limit' }
  | PreparedSubmission;
export interface SubmitEnv {
  readonly gatewayUrl: string | null;
  readonly origin: string;
  readonly fetch?: typeof globalThis.fetch;
}
export const SUBMIT_MESSAGES: Readonly<Record<SubmitStatus, string>> = {
  created: 'Заявка создана — это не применение и не подтверждение обновления сайта.',
  existing: 'Эта версия уже зарегистрирована. Новая Issue не создана.',
  unauthorized: 'Нужен вход через GitHub. Черновик остался в этом браузере.',
  rejected: 'Шлюз отказал в создании. Черновик сохранён; обратитесь к владельцу.',
  unavailable: 'Результат неизвестен. Не отправляйте новую заявку: повторите ту же версию.',
  invalid: 'Формат заявки отклонён; правки не отправлены.',
  disabled: 'Приём заявок не настроен или временно выключен. Черновик сохранён.',
  limit: 'Достигнут согласованный лимит открытых заявок. Черновик сохранён; дождитесь решения владельца.',
  closed: 'Нить закрыта. Изменение не добавлено; создание новой нити требует отдельного действия.',
};
export function readGatewayUrl(meta: { getAttribute(name: string): string | null } | null): string | null {
  const raw = meta?.getAttribute('content')?.trim();
  if (!raw) return null;
  try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    (url.pathname === '/' || url.pathname === '') ? url.origin : null; }
  catch { return null; }
}
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key));
const validIssueNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
function gateway(env: SubmitEnv): string | null {
  const raw = env.gatewayUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '') || url.origin === new URL(env.origin).origin) return null;
    return url.origin;
  } catch { return null; }
}
async function call(path: string, body: unknown, env: SubmitEnv, method: 'GET' | 'POST'): Promise<Response | null> {
  const root = gateway(env);
  if (root === null) return null;
  try {
    return await (env.fetch ?? globalThis.fetch)(`${root}${path}`, {
      method, credentials: 'include', mode: 'cors', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45_000),
    });
  } catch { return null; }
}
export async function preparePropertySubmission(draft: PropertyRequestDraft, env: SubmitEnv): Promise<PrepareOutcome> {
  if (gateway(env) === null) return { status: 'disabled' };
  const response = await call('/issues/prepare', { draft }, env, 'POST');
  if (response === null) return { status: 'unavailable' };
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 429) return { status: 'limit' };
  if (response.status === 503) {
    try { const p: unknown = await response.json(); if (isObject(p) && p.error === 'disabled') return { status: 'disabled' }; } catch { /* unknown */ }
    return { status: 'unavailable' };
  }
  if (response.status === 409) return { status: 'closed' };
  if (response.status >= 500) return { status: 'unavailable' };
  if (response.status !== 200) return { status: 'invalid' };
  let p: unknown; try { p = await response.json(); } catch { return { status: 'unavailable' }; }
  if (!isObject(p) || p.status !== 'prepared' || p.requestId !== draft.requestId || p.threadId !== draft.threadId ||
    typeof p.title !== 'string' || p.title.length > 200 || typeof p.body !== 'string' || p.body.length > 60_000 ||
    typeof p.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(p.fingerprint)) return { status: 'unavailable' };
  return { status: 'prepared', requestId: draft.requestId, threadId: draft.threadId, title: p.title, body: p.body, fingerprint: p.fingerprint };
}
/** Отправляем ID уже просмотренного серверного пакета, не произвольное тело. */
export async function submitPropertyPacket(packet: { readonly requestId: string; readonly fingerprint: string }, env: SubmitEnv): Promise<SubmitOutcome> {
  if (gateway(env) === null) return { status: 'disabled' };
  const response = await call('/issues/submit', { requestId: packet.requestId, fingerprint: packet.fingerprint }, env, 'POST');
  if (response === null) return { status: 'unavailable' };
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 429) return { status: 'limit' };
  if (response.status === 409) return { status: 'closed' };
  if (response.status === 503) {
    try { const p: unknown = await response.json(); if (isObject(p) && p.error === 'disabled') return { status: 'disabled' }; } catch { /* unknown */ }
    return { status: 'unavailable' };
  }
  if (response.status === 403 || response.status === 502) return { status: 'rejected' };
  if (response.status === 400) return { status: 'invalid' };
  let p: unknown; try { p = await response.json(); } catch { return { status: 'unavailable' }; }
  if (!isObject(p) || !validIssueNumber(p.number)) return { status: 'unavailable' };
  if (response.status === 201 && p.status === 'created') return { status: 'created', number: p.number };
  if (response.status === 200 && p.status === 'existing') return { status: 'existing', number: p.number };
  return { status: 'unavailable' };
}
export interface OwnRequestView {
  readonly requestId: string;
  readonly threadId: string;
  readonly number: number | null;
  readonly createdAt: string;
  readonly updatedAt: number;
  readonly status: 'prepared' | 'reserved' | 'created';
  readonly issueState: 'open' | 'closed' | null;
  readonly changes: PropertyRequestDraft['changes'];
}
export type MineOutcome = { readonly status: 'ready'; readonly requests: readonly OwnRequestView[]; readonly hasMore: boolean; readonly openLimit: number } |
  { readonly status: 'unavailable' | 'unauthorized' | 'disabled' };
export async function readMyRequests(env: SubmitEnv, before?: number): Promise<MineOutcome> {
  if (gateway(env) === null) return { status: 'disabled' };
  const response = await call(`/issues/mine${before === undefined ? '' : `?before=${before}`}`, null, env, 'GET');
  if (response === null) return { status: 'unavailable' };
  if (response.status === 401) return { status: 'unauthorized' };
  if (response.status === 503) return { status: 'disabled' };
  if (response.status !== 200) return { status: 'unavailable' };
  try {
    const p: unknown = await response.json();
    if (!isObject(p) || !exactKeys(p, ['requests','hasMore','openLimit']) || !Array.isArray(p.requests) || p.requests.length > 20 || typeof p.hasMore !== 'boolean' ||
      typeof p.openLimit !== 'number' || !Number.isInteger(p.openLimit) || p.openLimit < 1 || p.openLimit > 20) return { status: 'unavailable' };
    for (const r of p.requests) {
      if (!isObject(r) || !exactKeys(r, ['requestId','threadId','number','createdAt','updatedAt','status','issueState','changes']) ||
        typeof r.requestId !== 'string' || !/^pr-[a-z0-9-]{8,64}$/.test(r.requestId) || typeof r.threadId !== 'string' || !/^pr-[a-z0-9-]{8,64}$/.test(r.threadId) ||
        !(r.number === null || validIssueNumber(r.number)) || typeof r.createdAt !== 'string' || !Number.isSafeInteger(r.updatedAt) || (r.updatedAt as number) < 0 ||
        !['prepared','reserved','created'].includes(String(r.status)) || !(r.issueState === null || r.issueState === 'open' || r.issueState === 'closed') ||
        !Array.isArray(r.changes) || r.changes.length === 0 || r.changes.length > 100) return { status: 'unavailable' };
      for (const c of r.changes) if (!isObject(c) || !exactKeys(c, ['dataset','recordId','field','before','after']) ||
        !['systems','places'].includes(String(c.dataset)) || typeof c.recordId !== 'string' || c.recordId.length === 0 || c.recordId.length > 128 ||
        !['name','type','faction','description','source_url'].includes(String(c.field)) || typeof c.before !== 'string' || c.before.length > 4000 ||
        typeof c.after !== 'string' || c.after.length > 4000 || c.before === c.after) return { status: 'unavailable' };
    }
    return { status: 'ready', requests: p.requests as unknown as OwnRequestView[], hasMore: p.hasMore, openLimit: p.openLimit };
  } catch { return { status: 'unavailable' }; }
}

/** Выход из шлюза: серверная сессия отзывается, cookie очищается. */
export async function logoutPropertySession(env: SubmitEnv): Promise<boolean> {
  if (gateway(env) === null) return false;
  const response = await call('/auth/logout', {}, env, 'POST');
  return response !== null && response.ok;
}
