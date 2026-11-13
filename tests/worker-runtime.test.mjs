// Runtime-проверки issue-шлюза: Worker + Durable Object + SQLite на miniflare
// (официальный локальный эмулятор Cloudflare; внутри — workerd).
// Доказывает: одноразовость state под параллельными запросами, отказ
// хранилища, очистку, cookie и отсутствие утечек. НЕ заменяет продакшен-проверку.
//
// Все обращения к DO идут по внутренней HTTP-шине (stub.fetch); криптография
// выполняется в Worker'е, а не в DO (см. worker/README.md, почему).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_TIMEOUT_MS = 20_000;

// Один бандл на все тесты: esbuild собирает TS Worker'а, cloudflare:workers — внешний.
const bundle = buildSync({
  entryPoints: [path.join(root, 'worker/src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['cloudflare:workers'],
  write: false,
  logLevel: 'silent',
});
const workerScript = bundle.outputFiles[0].text;

const SECRET = 'test-client-secret-must-not-leak';
const ACCESS_TOKEN = 'gho_mocktoken_never_leak';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const b64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// oauth-state.ts хранит SHA-256 в base64url, не в hex.
const sha256Url = (value) => b64url(createHash('sha256').update(value).digest());

// Mock-GitHub на loopback: token-эндпоинт и /user.
const mock = { tokenCalls: 0, userCalls: 0, lastTokenBody: null, lastUserAuth: null };
const mockServer = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/login/oauth/access_token') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      mock.tokenCalls++;
      mock.lastTokenBody = body;
      const params = new URLSearchParams(body);
      if (params.get('code') === 'bad-code') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"bad_verification_code"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 28800 }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/user') {
    mock.userCalls++;
    mock.lastUserAuth = req.headers.authorization ?? null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'User', id: 424242, login: 'admin-a' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
const mockPort = mockServer.address().port;

// Реестр всех рантаймов: при любой ошибке все диспозятся, процесс не висит.
const runtimes = [];
function makeRuntime({ failStorage = false, persistDir } = {}) {
  const runtime = new Miniflare({
    modules: true,
    script: workerScript,
    compatibilityDate: '2025-06-01',
    durableObjects: { OAUTH_STATE: { className: 'OAuthState', useSQLite: true } },
    durableObjectsPersist: persistDir ?? mkdtempSync(path.join(os.tmpdir(), 'worker-do-')),
    bindings: {
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: SECRET,
      GITHUB_CALLBACK_URL: 'https://gateway.test/auth/callback',
      GITHUB_TOKEN_URL: `http://127.0.0.1:${mockPort}/login/oauth/access_token`,
      GITHUB_USER_URL: `http://127.0.0.1:${mockPort}/user`,
      SITE_ORIGIN: 'https://site.test/',
      FAIL_STORAGE: failStorage ? '1' : '0',
    },
  });
  runtimes.push(runtime);
  return runtime;
}

// fetch с гарантированным таймаутом и redirect: 'manual': 302 Worker'а
// (редирект на GitHub) не должен уводить undici во внешний интернет —
// и в песочнице (MITM TLS), и в CI.
function workerFetch(runtime, url, init = {}) {
  return runtime.dispatchFetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function parseCookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

async function doInternal(runtime, pathname, { method = 'GET', body, query } = {}) {
  const stub = (await runtime.getDurableObjectNamespace('OAUTH_STATE')).getByName('main');
  const queryText = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await stub.fetch('http://oauth-state.internal' + pathname + queryText, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, json: () => res.json(), text: () => res.text() };
}

// Посев состояния напрямую в хранилище (сценарии «истекло»/«очистка»).
async function seedFlow(runtime, { browserBinding, expiresAt }) {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const result = await doInternal(runtime, '/store-put', {
    method: 'POST',
    body: { key: sha256Url(state), verifier, bindingHash: sha256Url(browserBinding), expiresAt },
  });
  assert.equal(result.status, 200);
  const payload = await result.json();
  assert.equal(payload.added, true);
  return { state };
}

async function startFlow(runtime) {
  const res = await workerFetch(runtime, 'http://localhost/auth/start');
  const location = res.headers.get('location');
  assert.ok(location, 'start должен вернуть Location');
  const target = new URL(location);
  const params = new URLSearchParams(target.search);
  return {
    res,
    location,
    state: params.get('state'),
    challenge: params.get('code_challenge'),
    cookie: parseCookieValue(res.headers.get('set-cookie'), 'issue_oauth_binding'),
  };
}

async function fullFlow(runtime) {
  const { state, cookie } = await startFlow(runtime);
  const code = `ff-${state.slice(0, 8)}`;
  const res = await workerFetch(runtime, `http://localhost/auth/callback?code=${code}&state=${state}`, {
    headers: { cookie: `issue_oauth_binding=${cookie}` },
  });
  assert.equal(res.status, 302, 'callback должен завершиться редиректом');
  const sessionCookie = parseCookieValue(res.headers.get('set-cookie'), 'issue_oauth_session');
  assert.ok(sessionCookie && TOKEN_RE.test(sessionCookie), 'сессия должна стать cookie');
  return { state, cookie, code, sessionCookie, res };
}

let runtime;
before(async () => {
  try {
    runtime = makeRuntime();
  } catch (error) {
    for (const item of runtimes) await item.dispose().catch(() => {});
    mockServer.close();
    throw error;
  }
});
after(async () => {
  for (const item of runtimes) await item.dispose().catch(() => {});
  await new Promise((resolve) => mockServer.close(resolve));
});

test('healthz отвечает, неизвестные маршруты — 404', async () => {
  assert.deepEqual(await (await workerFetch(runtime, 'http://localhost/healthz')).json(), { ok: true });
  const unknown = await workerFetch(runtime, 'http://localhost/nope');
  assert.equal(unknown.status, 404);
});

test('start: редирект на GitHub, PKCE и cookie привязки с безопасными флагами', async () => {
  const { res, location, state, challenge, cookie } = await startFlow(runtime);
  assert.equal(res.status, 302);
  const target = new URL(location);
  assert.equal(target.origin, 'https://github.com');
  assert.equal(target.pathname, '/login/oauth/authorize');
  const params = new URLSearchParams(target.search);
  assert.equal(params.get('client_id'), 'test-client-id');
  assert.equal(params.get('redirect_uri'), 'https://gateway.test/auth/callback');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('scope'), '', 'приватная цепочка не просит права на репозитории у пользователя');
  assert.match(state, TOKEN_RE);
  assert.match(challenge, TOKEN_RE);
  assert.match(cookie, TOKEN_RE);
  assert.match(res.headers.get('set-cookie'), /Path=\/auth; Max-Age=300; Secure; HttpOnly; SameSite=Lax/);
  assert.equal(location.includes(SECRET), false);
});

test('callback с неполными или некорректными параметрами — 400', async () => {
  const missingCode = await workerFetch(runtime, `http://localhost/auth/callback?state=${'a'.repeat(43)}`);
  assert.equal(missingCode.status, 400);
  const missingState = await workerFetch(runtime, 'http://localhost/auth/callback?code=x');
  assert.equal(missingState.status, 400);
  const badState = await workerFetch(runtime, 'http://localhost/auth/callback?code=x&state=short');
  assert.equal(badState.status, 400);
});

test('callback с неизвестным state — 401, токен-эндпоинт не вызывается', async () => {
  const beforeTokens = mock.tokenCalls;
  const res = await workerFetch(runtime,
    `http://localhost/auth/callback?code=${'k'.repeat(10)}&state=${'a'.repeat(43)}`,
    { headers: { cookie: `issue_oauth_binding=${'b'.repeat(43)}` } },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_state' });
  assert.equal(mock.tokenCalls, beforeTokens);
});

test('callback без cookie привязки — 401 даже с реальным state (анти-CSRF)', async () => {
  const beforeTokens = mock.tokenCalls;
  const { state } = await startFlow(runtime);
  const res = await workerFetch(runtime, `http://localhost/auth/callback?code=${'k'.repeat(10)}&state=${state}`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'no_active_flow' });
  assert.equal(mock.tokenCalls, beforeTokens);
});

test('полный вход: обмен кода, идентификация, сессия; PKCE-верификатор ушёл в тело POST', async () => {
  const beforeTokens = mock.tokenCalls;
  const { sessionCookie } = await fullFlow(runtime);
  assert.equal(mock.tokenCalls, beforeTokens + 1);
  assert.ok(mock.userCalls >= 1);
  const body = new URLSearchParams(mock.lastTokenBody);
  assert.equal(body.get('client_id'), 'test-client-id');
  assert.equal(body.get('client_secret'), SECRET);
  assert.match(body.get('code_verifier'), TOKEN_RE);
  assert.equal(body.get('redirect_uri'), 'https://gateway.test/auth/callback');
  assert.equal(mock.lastUserAuth, `Bearer ${ACCESS_TOKEN}`);
  const status = await (await workerFetch(runtime, 'http://localhost/auth/status', {
    headers: { cookie: `issue_oauth_session=${sessionCookie}` },
  })).json();
  assert.deepEqual(status, { authenticated: true, login: 'admin-a', userId: 424242 });
});

test('гонка: 12 параллельных callback на один state — ровно один успех, токен взят один раз', async () => {
  const beforeTokens = mock.tokenCalls;
  const { state, cookie } = await startFlow(runtime);
  const url = `http://localhost/auth/callback?code=race-code&state=${state}`;
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    workerFetch(runtime, url, { headers: { cookie: `issue_oauth_binding=${cookie}` } })));
  assert.equal(results.filter((res) => res.status === 302).length, 1);
  assert.equal(results.filter((res) => res.status === 401).length, 11);
  assert.equal(mock.tokenCalls, beforeTokens + 1);
});

test('истёкший state отклоняется до обмена кодом', async () => {
  const binding = 'x'.repeat(43);
  const { state } = await seedFlow(runtime, { browserBinding: binding, expiresAt: Date.now() - 1000 });
  const beforeTokens = mock.tokenCalls;
  const res = await workerFetch(runtime,
    `http://localhost/auth/callback?code=expired&state=${state}`,
    { headers: { cookie: `issue_oauth_binding=${binding}` } },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_state' });
  assert.equal(mock.tokenCalls, beforeTokens);
});

test('плановая очистка: истёкшие state удаляются, живые продолжаются', async () => {
  const deadBinding = 'c'.repeat(43);
  const aliveBinding = 'd'.repeat(43);
  const dead = await seedFlow(runtime, { browserBinding: deadBinding, expiresAt: Date.now() - 1000 });
  const alive = await seedFlow(runtime, { browserBinding: aliveBinding, expiresAt: Date.now() + 300_000 });
  const cleaned = await doInternal(runtime, '/cleanup', { method: 'POST', body: { now: Date.now() } });
  assert.equal(cleaned.status, 200);
  const cleanedBody = await cleaned.json();
  assert.equal(cleanedBody.pending, 1);
  const deadResult = await workerFetch(runtime,
    `http://localhost/auth/callback?code=dead&state=${dead.state}`,
    { headers: { cookie: `issue_oauth_binding=${deadBinding}` } },
  );
  assert.equal(deadResult.status, 401);
  const aliveResult = await workerFetch(runtime,
    `http://localhost/auth/callback?code=alive&state=${alive.state}`,
    { headers: { cookie: `issue_oauth_binding=${aliveBinding}` } },
  );
  assert.equal(aliveResult.status, 302);
});

test('отказ хранилища — 503 без раскрытия деталей', async () => {
  const broken = makeRuntime({ failStorage: true });
  try {
    const start = await workerFetch(broken, 'http://localhost/auth/start');
    assert.equal(start.status, 503);
    const startBody = await start.text();
    assert.deepEqual(JSON.parse(startBody), { error: 'unavailable' });
    const callback = await workerFetch(broken,
      `http://localhost/auth/callback?code=broken&state=${'a'.repeat(43)}`,
      { headers: { cookie: `issue_oauth_binding=${'b'.repeat(43)}` } },
    );
    assert.equal(callback.status, 503);
    const callbackBody = await callback.text();
    assert.equal(callbackBody.includes(SECRET), false);
    assert.equal(callbackBody.includes('broken'), false);
  } finally {
    await broken.dispose();
  }
});

test('отказ провайдера в обмене кода — 401 без повторного обмена', async () => {
  const beforeTokens = mock.tokenCalls;
  const { state, cookie } = await startFlow(runtime);
  const res = await workerFetch(runtime,
    `http://localhost/auth/callback?code=bad-code&state=${state}`,
    { headers: { cookie: `issue_oauth_binding=${cookie}` } },
  );
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'provider_rejected' });
  assert.equal(mock.tokenCalls, beforeTokens + 1);
});

test('поток и сессия переживают перезапуск рантайма', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'worker-restart-'));
  const restarted = makeRuntime({ persistDir: dir });
  try {
    const { state } = await seedFlow(restarted, { browserBinding: 'r'.repeat(43), expiresAt: Date.now() + 300_000 });
    await restarted.dispose();
    const revived = makeRuntime({ persistDir: dir });
    try {
      const beforeTokens = mock.tokenCalls;
      const res = await workerFetch(revived,
        `http://localhost/auth/callback?code=respawn&state=${state}`,
        { headers: { cookie: `issue_oauth_binding=${'r'.repeat(43)}` } },
      );
      assert.equal(res.status, 302);
      assert.equal(mock.tokenCalls, beforeTokens + 1);
    } finally {
      await revived.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logout отзывает сессию', async () => {
  const { sessionCookie } = await fullFlow(runtime);
  const logout = await workerFetch(runtime, 'http://localhost/auth/logout', {
    method: 'POST',
    headers: { cookie: `issue_oauth_session=${sessionCookie}`, origin: 'https://site.test' },
  });
  assert.deepEqual(await logout.json(), { ok: true });
  const status = await (await workerFetch(runtime, 'http://localhost/auth/status', {
    headers: { cookie: `issue_oauth_session=${sessionCookie}` },
  })).json();
  assert.deepEqual(status, { authenticated: false });
});

test('ни один ответ не несёт секрет, code или access token', async () => {
  const start = await workerFetch(runtime, 'http://localhost/auth/start');
  const { state, cookie } = await startFlow(runtime);
  const callback = await workerFetch(runtime,
    `http://localhost/auth/callback?code=leak-check-code&state=${state}`,
    { headers: { cookie: `issue_oauth_binding=${cookie}` } },
  );
  const blob = [
    start.headers.get('location') ?? '',
    start.headers.get('set-cookie') ?? '',
    callback.headers.get('location') ?? '',
    callback.headers.get('set-cookie') ?? '',
    await callback.text(),
  ].join('|');
  assert.equal(blob.includes(SECRET), false);
  assert.equal(blob.includes(ACCESS_TOKEN), false);
  assert.equal(blob.includes('leak-check-code'), false);
});
