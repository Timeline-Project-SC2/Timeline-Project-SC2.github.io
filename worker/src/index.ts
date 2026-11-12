/* HTTP-слой issue-шлюза: вход в GitHub для будущих заявок.
 *
 * Здесь НЕТ создания Issue, применения правок и публикации — это следующие
 * этапы. GitHub code и access token не попадают в ответы, редиректы и логи:
 * callback возвращает чистый 302, ошибки — общие JSON-сообщения.
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
import { OAuthState } from './oauth-state-do.ts';
import type { OAuthStateStub, SessionRecord } from './oauth-state-do.ts';

export { OAuthState };

interface WorkerEnv {
  readonly OAUTH_STATE: DurableObjectNamespace;
  readonly GITHUB_CLIENT_ID: string;
  readonly GITHUB_CLIENT_SECRET: string;
  readonly GITHUB_CALLBACK_URL: string;
  readonly GITHUB_TOKEN_URL?: string;
  readonly GITHUB_USER_URL?: string;
  readonly GITHUB_SCOPES?: string;
  readonly SITE_ORIGIN?: string;
  readonly FAIL_STORAGE?: string;
}

const BINDING_COOKIE = 'issue_oauth_binding';
const SESSION_COOKIE = 'issue_oauth_session';
const BINDING_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 3600;
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

function cookieHeader(name: string, value: string, maxAgeSeconds: number, path: string): string {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
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

async function authStart(env: WorkerEnv): Promise<Response> {
  const stub = stubOf(env);
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
    scope: env.GITHUB_SCOPES ?? 'public_repo',
    code_challenge: start.codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': cookieHeader(BINDING_COOKIE, binding, BINDING_TTL_SECONDS, '/auth'),
    },
  });
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
  const ttlSeconds = Math.min(exchanged.expiresIn ?? SESSION_TTL_SECONDS, SESSION_TTL_SECONDS);
  let create: Response;
  try {
    create = await internalCall(stub, '/session-create', {
      method: 'POST',
      body: {
        sessionHash,
        accessToken: exchanged.accessToken,
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
  return new Response(null, {
    status: 302,
    headers: {
      Location: env.SITE_ORIGIN ?? '/',
      'Set-Cookie': cookieHeader(SESSION_COOKIE, sessionToken, ttlSeconds, '/'),
    },
  });
}

async function authStatus(request: Request, env: WorkerEnv): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return json({ authenticated: false });
  const sessionHash = await sha256Hex(token);
  let response: Response;
  try {
    response = await internalCall(stubOf(env), '/session-get', {
      method: 'GET',
      query: { hash: sessionHash, now: String(Date.now()) },
    });
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
  if (!response.ok) return internalError(response);
  const payload = (await response.json()) as { session: SessionRecord | null };
  if (!payload.session) return json({ authenticated: false });
  return json({ authenticated: true, login: payload.session.login, userId: payload.session.userId });
}

async function authLogout(request: Request, env: WorkerEnv): Promise<Response> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token !== null) {
    const sessionHash = await sha256Hex(token);
    try {
      await internalCall(stubOf(env), '/session-delete', { method: 'POST', body: { sessionHash } });
    } catch {
      // Сессия уже истекла или удалена: выход остаётся успешным.
    }
  }
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/auth/start' && request.method === 'GET') return await authStart(env);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return await authCallback(request, env, url);
      if (url.pathname === '/auth/status' && request.method === 'GET') return await authStatus(request, env);
      if (url.pathname === '/auth/logout' && request.method === 'POST') return await authLogout(request, env);
      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'unavailable' }, 503);
    }
  },
};
