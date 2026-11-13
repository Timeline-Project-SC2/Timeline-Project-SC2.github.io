/* HTTP-слой issue-шлюза: вход в GitHub и отправка заявки на свойства точек.
 *
 * Здесь НЕТ применения правок и публикации — это следующий этап. GitHub code
 * и access token не попадают ни в ответы, ни в редиректы, ни в логи:
 * callback возвращает чистый 302, ошибки — общие JSON-сообщения.
 *
 * Отправка (`POST /issues/submit`) принимает ровно каноническую заявку
 * (`src/issue-gateway/property-issue-contract.ts`) и передаёт её в
 * `createRequestIssue`: тот сверяет репозиторий по ID и не создаёт дубль.
 * Успешный ответ означает только «Issue создана» — не применение правки,
 * не проверку роли Owner и не обновление сайта.
 *
 * Cookie сессии `SameSite=None; Secure`: сайт (github.io) и Worker — разные
 * сайты, иначе браузер не отправит cookie при cross-site запросе. Поэтому
 * каждая изменяющая операция дополнительно требует точный `Origin` сайта
 * (`SITE_ORIGIN`) и JSON-тело: такой запрос браузер выполняет только после
 * preflight, а сторонний сайт preflight не получит.
 *
 * Обмен с Durable Object идёт по внутренней HTTP-шине (stub.fetch), а не
 * RPC-методами — см. oauth-state-do.ts, почему.
 */
import { DurableObjectNamespace } from 'cloudflare:workers';
import { exchangeGithubCode, identifyGithubUser } from '../../src/issue-gateway/github-oauth.ts';
import type { GitHubAppConfig } from '../../src/issue-gateway/github-oauth.ts';
import {
  beginOAuthFlow,
  consumeOAuthState,
} from '../../src/issue-gateway/oauth-state.ts';
import type {
  OAuthConsumeResult,
  OAuthCrypto,
  OAuthStartResult,
  OAuthStateStore,
  PendingOAuth,
} from '../../src/issue-gateway/oauth-state.ts';
import { PROPERTY_LIMITS, PROPERTY_ISSUE_VERSION, canonicalPacketJson, fingerprintPropertyPacket,
  propertyIssueTitle, readPacket, readPropertyRequestDraft, renderPropertyIssueBody, sealPropertyRequest, scanPublicText,
  isPropertyRequestId, isPropertyRepositoryId } from '../../src/issue-gateway/property-issue-contract.ts';
import type { PropertyIssuePacket, PropertyRepositoryTarget } from '../../src/issue-gateway/property-issue-contract.ts';
import { createInstallationToken } from '../../src/issue-gateway/github-app.ts';
import { createRequestIssue, readRequestIssue, confirmRepository } from '../../src/issue-gateway/github-issues.ts';
import type { IssuesApiConfig } from '../../src/issue-gateway/github-issues.ts';
import { OAuthState } from './oauth-state-do.ts';
import type { OAuthStateStub, SessionRecord, StoredPropertyRequest } from './oauth-state-do.ts';

export { OAuthState };

interface WorkerEnv {
  readonly OAUTH_STATE: DurableObjectNamespace;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly GITHUB_CALLBACK_URL: string;
  readonly GITHUB_TOKEN_URL?: string;
  readonly GITHUB_USER_URL?: string;
  /** Origin сайта: источник всплывающей навигации и разрешённый CORS-источник. */
  readonly SITE_ORIGIN: string;
  /** Заменяемый базовый адрес GitHub API (mock в тестах); в проде не задаётся. */
  readonly GITHUB_API_BASE?: string;
  readonly FAIL_STORAGE?: string;
  readonly PROPERTY_REPOSITORY_ID?: string;
  readonly PROPERTY_REPOSITORY?: string;
  readonly GITHUB_APP_CLIENT_ID?: string;
  readonly GITHUB_APP_INSTALLATION_ID?: string;
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  /** Решение владельца о числе открытых нитей; безопасного значения по умолчанию нет. */
  readonly PROPERTY_OPEN_LIMIT?: string;
}

const BINDING_COOKIE = 'issue_oauth_binding';
const RETURN_COOKIE = 'issue_oauth_return';
const SESSION_COOKIE = 'issue_oauth_session';
const BINDING_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 7 * 24 * 3600;
const MAX_SUBMIT_BYTES = PROPERTY_LIMITS.body + 8192;
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders };
  return new Response(JSON.stringify(body), { status, headers });
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readCookie(request: Request, name: string): string | null {
  if (name === RETURN_COOKIE) {
    const part = (request.headers.get('cookie') ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
    const value = part?.slice(name.length + 1);
    return value === 'admin' || value === 'requests' ? value : null;
  }
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * `sameSite`:
 * - `Lax` — для cookie привязки: она нужна только при переходе с github.com
 *   на `/auth/callback` верхним уровнем;
 * - `None` — для cookie сессии: сайт и Worker находятся на разных сайтах,
 *   иначе браузер не приложит cookie к cross-site запросу отправки.
 *   Компенсация — строгая проверка Origin и JSON-тело (см. `checkOrigin`).
 */
function cookieHeader(name: string, value: string, maxAgeSeconds: number, path: string, sameSite: 'Lax' | 'None'): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=${sameSite}`;
}

/** Нормализованный Origin сайта; сравнение точное, без подстановок. */
function siteOrigin(env: WorkerEnv): string | null {
  if (typeof env.SITE_ORIGIN !== 'string' || env.SITE_ORIGIN.length === 0) return null;
  try {
    const url = new URL(env.SITE_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Проверка источника изменяющего запроса. Заголовок `Origin` присылает сам
 * браузер; сторонний сайт не сможет выдать себя за наш, а без preflight
 * JSON-запрос с `Origin` другого сайта не пройдёт. Отсутствие `Origin`
 * отклоняется: браузерный cross-site запрос его всегда содержит.
 */
function checkOrigin(request: Request, env: WorkerEnv): boolean {
  const expected = siteOrigin(env);
  const origin = request.headers.get('origin');
  if (expected === null || origin === null) return false;
  return origin === expected;
}

/** Ответ на preflight: только точный Origin сайта, без wildcard. */
function preflight(request: Request, env: WorkerEnv): Response {
  if (!checkOrigin(request, env)) return json({ error: 'forbidden_origin' }, 403);
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': siteOrigin(env) ?? '',
      'Access-Control-Allow-Methods': ALLOWED_METHODS,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    },
  });
}

/** Заголовки CORS для фактического ответа: только для разрешённого Origin. */
function corsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const expected = siteOrigin(env);
  if (expected === null || request.headers.get('origin') !== expected) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': expected,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

const fetchTransport: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init);

function stubOf(env: WorkerEnv): OAuthStateStub {
  return env.OAUTH_STATE.getByName('main') as unknown as OAuthStateStub;
}

interface InternalCall {
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}

/** Внутренний запрос к DO по HTTP-шине. Ответ 503 — отказ хранилища. */
async function internalCall(stub: OAuthStateStub, path: string, call: InternalCall): Promise<Response> {
  const query = call.query ? '?' + new URLSearchParams(call.query).toString() : '';
  return stub.fetch(new Request('http://oauth-state.internal' + path + query, {
    method: call.method,
    headers: call.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
  }));
}

/** Нормализует внутренний сбой шины: детали не раскрывать. */
function internalError(response: Response): Response {
  if (response.status === 400) return json({ error: 'invalid_request' }, 400);
  return json({ error: 'unavailable' }, 503);
}

/**
 * Хранилище одноразового state поверх внутренней HTTP-шины. Атомарность
 * операций обеспечивает DO (одна SQLite, один писатель); вся криптография
 * выполняется в контексте Worker'а (см. oauth-state-do.ts, почему).
 */
function stateStore(stub: OAuthStateStub): OAuthStateStore {
  return {
    async putIfAbsent(key: string, value: PendingOAuth): Promise<boolean> {
      const response = await internalCall(stub, '/store-put', {
        method: 'POST',
        body: { key, verifier: value.verifier, bindingHash: value.bindingHash, expiresAt: value.expiresAt },
      });
      if (!response.ok) throw new Error('store unavailable');
      const payload = (await response.json()) as { added?: unknown };
      if (payload.added !== true && payload.added !== false) throw new Error('store unavailable');
      return payload.added;
    },
    async take(key: string) {
      const response = await internalCall(stub, '/store-take', { method: 'POST', body: { key } });
      if (!response.ok) throw new Error('store unavailable');
      const payload = (await response.json()) as {
        pending: { verifier?: unknown; bindingHash?: unknown; expiresAt?: unknown } | null;
      };
      if (payload.pending === null) return null;
      if (typeof payload.pending.verifier !== 'string' ||
          typeof payload.pending.bindingHash !== 'string' ||
          typeof payload.pending.expiresAt !== 'number') throw new Error('store unavailable');
      return {
        verifier: payload.pending.verifier,
        bindingHash: payload.pending.bindingHash,
        expiresAt: payload.pending.expiresAt,
      };
    },
  };
}

const workerCrypto: OAuthCrypto = globalThis.crypto as OAuthCrypto;

async function authStart(env: WorkerEnv, url: URL): Promise<Response> {
  const stub = stubOf(env);
  const returnTo = url.searchParams.get('return') === 'admin' ? 'admin' : 'requests';
  const binding = randomToken();
  let start: OAuthStartResult;
  try {
    start = await beginOAuthFlow(stateStore(stub), workerCrypto, binding, Date.now());
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (start.status !== 'started') {
    return json({ error: start.status === 'invalid' ? 'invalid_request' : 'unavailable' }, start.status === 'invalid' ? 400 : 503);
  }
  const authorize = new URL('https://github.com/login/oauth/authorize');
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    state: start.state,
    scope: '', // только личность; права на репозитории пользователю не нужны
    code_challenge: start.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  const headers = new Headers({ Location: authorize.toString() });
  headers.append('Set-Cookie', cookieHeader(BINDING_COOKIE, binding, BINDING_TTL_SECONDS, '/auth', 'Lax'));
  headers.append('Set-Cookie', cookieHeader(RETURN_COOKIE, returnTo, BINDING_TTL_SECONDS, '/auth', 'Lax'));
  return new Response(null, { status: 302, headers });
}

async function authCallback(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Код и state принимаем только в строгом виде; всё остальное — 400.
  if (!code || code.length > 500 || /[\u0000-\u0020\u007f]/.test(code) || !state || !TOKEN_RE.test(state)) {
    return json({ error: 'invalid_request' }, 400);
  }
  const binding = readCookie(request, BINDING_COOKIE);
  if (binding === null) return json({ error: 'no_active_flow' }, 401);

  const stub = stubOf(env);
  let consumed: OAuthConsumeResult;
  try {
    consumed = await consumeOAuthState(stateStore(stub), workerCrypto, state, binding, Date.now());
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (consumed.status === 'unavailable') return json({ error: 'unavailable' }, 503);
  if (consumed.status !== 'accepted') return json({ error: 'invalid_state' }, 401);

  const config: GitHubAppConfig = {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    callbackUrl: env.GITHUB_CALLBACK_URL,
    ...(env.GITHUB_TOKEN_URL === undefined ? {} : { tokenUrl: env.GITHUB_TOKEN_URL }),
  };
  const exchanged = await exchangeGithubCode(config, consumed, code, fetchTransport);
  if (exchanged.status !== 'accepted') {
    return json({ error: exchanged.status === 'rejected' ? 'provider_rejected' : 'unavailable' }, exchanged.status === 'rejected' ? 401 : 503);
  }
  const identified = await identifyGithubUser(exchanged.accessToken, fetchTransport, env.GITHUB_USER_URL);
  if (identified.status !== 'identified') {
    return json({ error: identified.status === 'rejected' ? 'provider_rejected' : 'unavailable' }, identified.status === 'rejected' ? 401 : 503);
  }

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  // Токен пользователя использован только для /user и дальше не хранится.
  const ttlSeconds = SESSION_TTL_SECONDS;
  let create: Response;
  try {
    create = await internalCall(stub, '/session-create', {
      method: 'POST',
      body: {
        sessionHash,
        userId: identified.user.id,
        login: identified.user.login,
        expiresAt: Date.now() + ttlSeconds * 1000,
      },
    });
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (!create.ok) return internalError(create);
  // Чистый редирект: code и токен нигде не повторяются.
  // Возврат в браузер только через настроенный Origin сайта.
  const headers = new Headers({ Location: `${siteOrigin(env) ?? 'https://timeline-project-sc2.github.io'}${readCookie(request, RETURN_COOKIE) === 'admin' ? '/sector/admin-edit/' : '/sector/?requests=1'}` });
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, sessionToken, ttlSeconds, '/', 'None'));
  headers.append('Set-Cookie', cookieHeader(BINDING_COOKIE, '', 0, '/auth', 'Lax'));
  headers.append('Set-Cookie', cookieHeader(RETURN_COOKIE, '', 0, '/auth', 'Lax'));
  return new Response(null, { status: 302, headers });
}

/** Действующая сессия по cookie: только хеш уходит в хранилище, токен не меняется. */
async function readSession(request: Request, env: WorkerEnv): Promise<SessionRecord | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return null;
  const sessionHash = await sha256Hex(token);
  let response: Response;
  try {
    response = await internalCall(stubOf(env), '/session-get', {
      method: 'GET',
      query: { hash: sessionHash, now: String(Date.now()) },
    });
  } catch {
    throw new Error('session unavailable');
  }
  if (!response.ok) throw new Error('session unavailable');
  const payload = (await response.json()) as { session: SessionRecord | null };
  return payload.session ?? null;
}

async function authStatus(request: Request, env: WorkerEnv): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return json({ authenticated: false }, 200, { ...corsHeaders(request, env), 'Cache-Control': 'no-store' });
  let session: SessionRecord | null;
  try {
    session = await readSession(request, env);
  } catch {
    return json({ error: 'unavailable' }, 503, { ...corsHeaders(request, env), 'Cache-Control': 'no-store' });
  }
  if (session === null) return json({ authenticated: false }, 200, { ...corsHeaders(request, env), 'Cache-Control': 'no-store' });
  return json({ authenticated: true, login: session.login, userId: session.userId }, 200, { ...corsHeaders(request, env), 'Cache-Control': 'no-store' });
}

/**
 * Тело запроса только как JSON-объект и только в пределах лимита: тип
 * `application/json` обязателен, иначе это простая cross-site форма.
 */
async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) return null;
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SUBMIT_BYTES)) return null;
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_SUBMIT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Приватная цель обязательна: без настройки нет ни чтения, ни записи. */
function propertyTarget(env: WorkerEnv): PropertyRepositoryTarget | null {
  const id = Number(env.PROPERTY_REPOSITORY_ID);
  const fullName = env.PROPERTY_REPOSITORY ?? '';
  if (!isPropertyRepositoryId(id) || !/^Timeline-Project-SC2\/[a-z\d_.-]+$/i.test(fullName) ||
    fullName.toLowerCase() === 'timeline-project-sc2/timeline-project-sc2.github.io') return null;
  return { id, fullName };
}
function openLimit(env: WorkerEnv): number | null {
  const value = Number(env.PROPERTY_OPEN_LIMIT);
  return Number.isSafeInteger(value) && value >= 1 && value <= 20 ? value : null;
}
async function requestCall<T>(env: WorkerEnv, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await internalCall(stubOf(env), path, { method: 'POST', body });
  if (!response.ok) {
    if (response.status === 409) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(payload?.error === 'busy' ? 'request_busy' : 'request_conflict');
    }
    throw new Error(response.status === 429 ? 'request_limit' : 'unavailable');
  }
  return await response.json() as T;
}
async function appConfig(env: WorkerEnv): Promise<PrivateConfig | null> {
  const target = propertyTarget(env);
  if (target === null || openLimit(env) === null || !env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) return null;
  const issued = await createInstallationToken({ clientId: env.GITHUB_APP_CLIENT_ID, installationId: env.GITHUB_APP_INSTALLATION_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY, target, ...(env.GITHUB_API_BASE === undefined ? {} : { apiBase: env.GITHUB_API_BASE }) }, fetchTransport);
  if (issued.status !== 'ready') throw new Error(issued.status === 'rejected' ? 'provider_rejected' : 'unavailable');
  const config = { target, botLogin: issued.botLogin, ...(env.GITHUB_API_BASE === undefined ? {} : { apiBase: env.GITHUB_API_BASE }) };
  if (await confirmRepository(fetchTransport, issued.token, config) !== 'ok') throw new Error('provider_rejected');
  return { ...config, token: issued.token };
}
interface PrivateConfig extends IssuesApiConfig { readonly token: string }
async function storedPacket(record: StoredPropertyRequest, env: WorkerEnv): Promise<PropertyIssuePacket> {
  const target = propertyTarget(env);
  if (target === null || record.repositoryId !== target.id) throw new Error('unavailable');
  const packet = readPacket(JSON.parse(record.packetJson), target);
  if (packet.requestId !== record.requestId || packet.threadId !== record.threadId || packet.author.id !== record.userId ||
    canonicalPacketJson(packet) !== record.packetJson || await fingerprintPropertyPacket(record.packetJson) !== record.fingerprint) throw new Error('unavailable');
  return packet;
}
/** Серверная подготовка: автор и время неизменяемы для данного requestId. */
async function issuesPrepare(request: Request, env: WorkerEnv): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!checkOrigin(request, env)) return json({ error: 'forbidden_origin' }, 403, cors);
  const session = await readSession(request, env);
  if (session === null) return json({ error: 'unauthorized' }, 401, cors);
  const target = propertyTarget(env);
  if (target === null || openLimit(env) === null) return json({ error: 'disabled' }, 503, cors);
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'draft')) return json({ error: 'invalid_request' }, 400, cors);
  let draft;
  try { draft = readPropertyRequestDraft(body.draft); } catch { return json({ error: 'invalid_request' }, 400, cors); }
  const draftJson = JSON.stringify(draft);
  if (new TextEncoder().encode(draftJson).length > PROPERTY_LIMITS.body) return json({ error: 'invalid_request' }, 400, cors);
  if (draft.threadId !== draft.requestId) {
    const { request: root } = await requestCall<{ request: StoredPropertyRequest | null }>(env, '/request-root',
      { repositoryId: target.id, userId: session.userId, threadId: draft.threadId });
    if (root === null || root.issueNumber === null || root.issueState === 'closed') return json({ error: 'invalid_thread' }, 409, cors);
    await storedPacket(root, env);
  }
  const key = { repositoryId: target.id, userId: session.userId, requestId: draft.requestId };
  const existing = await requestCall<{ request: StoredPropertyRequest | null }>(env, '/request-get', key);
  const createdAt = existing.request?.createdAt ?? new Date().toISOString();
  const packet = sealPropertyRequest(draft, { id: session.userId, login: session.login }, createdAt, target);
  const packetJson = canonicalPacketJson(packet), text = renderPropertyIssueBody(packet);
  if (new TextEncoder().encode(text).length > PROPERTY_LIMITS.body || scanPublicText(text).errors.length) return json({ error: 'invalid_request' }, 400, cors);
  const fingerprint = await fingerprintPropertyPacket(packetJson);
  let stored: { request: StoredPropertyRequest };
  try {
    stored = await requestCall<{ request: StoredPropertyRequest }>(env, '/request-prepare', {
      ...key, threadId: draft.threadId, login: session.login, createdAt, draftJson, packetJson, fingerprint, now: Date.now() });
  } catch (error) {
    if (error instanceof Error && error.message === 'request_conflict') return json({ error: 'invalid_request' }, 400, cors);
    if (error instanceof Error && error.message === 'request_limit') return json({ error: 'request_limit' }, 429, cors);
    throw error;
  }
  const result = await storedPacket(stored.request, env);
  const bodyText = renderPropertyIssueBody(result);
  return json({ status: 'prepared', requestId: result.requestId, threadId: result.threadId,
    title: propertyIssueTitle(stored.request.fingerprint), body: bodyText, fingerprint: stored.request.fingerprint }, 200, cors);
}
/** Обновляем только свои нити; закрытие Issue не доказывает применение. */
async function refreshOwnIssues(env: WorkerEnv, session: SessionRecord, config: PrivateConfig): Promise<void> {
  const { requests } = await requestCall<{ requests: StoredPropertyRequest[] }>(env, '/request-active', { repositoryId: config.target.id, userId: session.userId });
  const numbers = new Set(requests.map((r) => r.issueNumber).filter((n): n is number => n !== null));
  for (const number of numbers) {
    const root = requests.find((r) => r.issueNumber === number && r.requestId === r.threadId);
    if (!root) throw new Error('unavailable');
    const result = await readRequestIssue(config.token, config, number, await storedPacket(root, env), fetchTransport);
    if (result.status !== 'found') throw new Error('unavailable');
    await requestCall(env, '/request-state', { repositoryId: config.target.id, userId: session.userId,
      threadId: root.threadId, issueState: result.issue.state, now: Date.now() });
  }
}
async function issuesMine(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!checkOrigin(request, env)) return json({ error: 'forbidden_origin' }, 403, cors);
  const session = await readSession(request, env);
  if (session === null) return json({ error: 'unauthorized' }, 401, cors);
  const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Date.now() + 1;
  if (!Number.isSafeInteger(before) || before < 0 || url.searchParams.size > 1) return json({ error: 'invalid_request' }, 400, cors);
  const config = await appConfig(env);
  if (config === null) return json({ error: 'disabled' }, 503, cors);
  await refreshOwnIssues(env, session, config);
  const listed = await requestCall<{ requests: StoredPropertyRequest[]; hasMore: boolean }>(env, '/request-list',
    { repositoryId: config.target.id, userId: session.userId, before, limit: 20 });
  const requests = [];
  for (const record of listed.requests) {
    const packet = await storedPacket(record, env);
    requests.push({ requestId: packet.requestId, threadId: packet.threadId, number: record.issueNumber,
      createdAt: packet.createdAt, updatedAt: record.updatedAt, status: record.status, issueState: record.issueState,
      changes: packet.changes });
  }
  return json({ requests, hasMore: listed.hasMore, openLimit: openLimit(env) }, 200, { ...cors, 'Cache-Control': 'no-store' });
}
/**
 * Отправка заявки. Порядок важен: источник → сессия → формат → GitHub.
 * Ответ содержит только статус и номер Issue; токен, code и тело запроса в
 * ответ не попадают. `created` здесь — факт создания Issue, не применение.
 */
async function issuesSubmit(request: Request, env: WorkerEnv): Promise<Response> {
  const cors = corsHeaders(request, env);
  if (!checkOrigin(request, env)) return json({ error: 'forbidden_origin' }, 403, cors);
  const session = await readSession(request, env);
  if (session === null) return json({ error: 'unauthorized' }, 401, cors);
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'requestId') || !Object.hasOwn(body, 'fingerprint') ||
    !isPropertyRequestId(body.requestId) || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) return json({ error: 'invalid_request' }, 400, cors);
  const config = await appConfig(env);
  if (config === null) return json({ error: 'disabled' }, 503, cors);
  const key = { repositoryId: config.target.id, userId: session.userId, requestId: body.requestId };
  const { request: initial } = await requestCall<{ request: StoredPropertyRequest | null }>(env, '/request-get', key);
  if (initial === null || initial.fingerprint !== body.fingerprint) return json({ error: 'invalid_request' }, 400, cors);
  const packet = await storedPacket(initial, env);
  if (initial.status === 'created' && initial.issueNumber !== null) {
    return json({ status: 'existing', number: initial.issueNumber, requestId: packet.requestId, threadId: packet.threadId }, 200, cors);
  }
  await refreshOwnIssues(env, session, config);
  let reserved: StoredPropertyRequest;
  let firstAttempt: boolean;
  try {
    const reservation = await requestCall<{ request: StoredPropertyRequest; firstAttempt: boolean }>(env, '/request-reserve', { ...key, limit: openLimit(env), now: Date.now() });
    reserved = reservation.request; firstAttempt = reservation.firstAttempt;
  } catch (error) {
    if (error instanceof Error && error.message === 'request_limit') return json({ error: 'request_limit', openLimit: openLimit(env) }, 429, cors);
    if (error instanceof Error && error.message === 'request_busy') return json({ error: 'unavailable' }, 503, cors);
    throw error;
  }
  if (reserved.status === 'created' && reserved.issueNumber !== null) return json({ status: 'existing', number: reserved.issueNumber,
    requestId: packet.requestId, threadId: packet.threadId }, 200, cors);
  let root: StoredPropertyRequest | null = null;
  if (packet.threadId !== packet.requestId) {
    root = (await requestCall<{ request: StoredPropertyRequest | null }>(env, '/request-root', { ...key, threadId: packet.threadId })).request;
    if (root === null || root.issueNumber === null || root.userId !== session.userId) {
      await requestCall(env, '/request-release', { ...key, now: Date.now() });
      return json({ error: 'invalid_thread' }, 409, cors);
    }
    if (root.issueState === 'closed') {
      await requestCall(env, '/request-release', { ...key, now: Date.now() });
      return json({ error: 'thread_closed' }, 409, cors);
    }
    await storedPacket(root, env);
  }
  const result = await createRequestIssue(config.token, config, { packet,
    title: propertyIssueTitle(reserved.fingerprint), body: renderPropertyIssueBody(packet),
    ...(root?.issueNumber !== undefined && root?.issueNumber !== null ? { threadIssueNumber: root.issueNumber } : {}),
    recover: !firstAttempt }, fetchTransport);
  if (result.status === 'created' || result.status === 'exists') {
    await requestCall(env, '/request-created', { ...key, issueNumber: result.issue.number, commentId: result.commentId ?? null,
      issueState: result.issue.state, now: Date.now() });
    return json({ status: result.status === 'created' ? 'created' : 'existing', number: result.issue.number,
      requestId: packet.requestId, threadId: packet.threadId }, result.status === 'created' ? 201 : 200, cors);
  }
  if (result.status === 'rejected') {
    await requestCall(env, '/request-release', { ...key, now: Date.now() });
    return json({ error: 'provider_rejected' }, 502, cors);
  }
  if (result.status === 'closed') {
    await requestCall(env, '/request-release', { ...key, now: Date.now() });
    return json({ error: 'thread_closed' }, 409, cors);
  }
  if (result.status === 'invalid') return json({ error: 'invalid_request' }, 400, cors);
  // Резерв остаётся: неизвестный результат занимает место до достоверного разрешения.
  return json({ error: 'unavailable' }, 503, cors);
}

async function authLogout(request: Request, env: WorkerEnv): Promise<Response> {
  if (!checkOrigin(request, env)) return json({ error: 'forbidden_origin' }, 403, corsHeaders(request, env));
  const token = readCookie(request, SESSION_COOKIE);
  if (token !== null) {
    const sessionHash = await sha256Hex(token);
    try {
      await internalCall(stubOf(env), '/session-delete', { method: 'POST', body: { sessionHash } });
    } catch {
      // Сессия уже истекла или удалена: выход остаётся успешным.
    }
  }
  return json({ ok: true }, 200, { ...corsHeaders(request, env),
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=None`,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/auth/start' && request.method === 'GET') return await authStart(env, url);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return await authCallback(request, env, url);
      if (url.pathname === '/auth/status' && request.method === 'GET') return await authStatus(request, env);
      if (url.pathname === '/auth/logout' && request.method === 'POST') return await authLogout(request, env);
      if (['/issues/submit', '/issues/prepare', '/issues/mine', '/auth/logout'].includes(url.pathname) && request.method === 'OPTIONS') return preflight(request, env);
      if (url.pathname === '/issues/prepare' && request.method === 'POST') return await issuesPrepare(request, env);
      if (url.pathname === '/issues/mine' && request.method === 'GET') return await issuesMine(request, env, url);
      if (url.pathname === '/issues/submit' && request.method === 'POST') return await issuesSubmit(request, env);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const code = error instanceof Error && error.message === 'provider_rejected' ? 'provider_rejected' : 'unavailable';
      return json({ error: code }, 503, { ...corsHeaders(request, env), 'Cache-Control': 'no-store' });
    }
  },
  /** Cron (triggers.crons): плановая очистка — пробуждаем DO по внутренней шине. */
  async scheduled(_event: unknown, env: WorkerEnv, _ctx: unknown): Promise<void> {
    try {
      await internalCall(stubOf(env), '/cleanup', { method: 'POST', body: { now: Date.now() } });
    } catch {
      // Сбой очистки откладывается до следующего cron; вход не зависит от неё.
    }
  },
};
