// Отправка заявки через Worker на miniflare (workerd): вход, cookie сессии,
// Origin/CORS, фиктивный GitHub API. Доказывает сквозной путь «сессия →
// каноническая заявка → Issue» и отсутствие дублей после неизвестного ответа.
// НЕ доказывает: проверку роли Owner, применение правки, публикацию сайта и
// поведение в реальной сети Cloudflare.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../src/issue-gateway/property-issue-contract.ts');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_TIMEOUT_MS = 20_000;
const SITE = 'https://site.test';
const SECRET = 'test-client-secret-must-not-leak';
const ACCESS_TOKEN = 'gho_mocktoken_never_leak';

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

/* --- Фиктивный GitHub: токен, пользователь, репозиторий, Issue ------------- */

const gh = {
  issues: [],
  tokenCalls: 0,
  posts: 0,
  failPostWith: null,
  listStatus: 200,
  createStatus: 201,
};
const REPO_PATH = `/repos/${contract.PROPERTY_REPOSITORY}`;

function send(res, status, payload) {
  if (payload === undefined) { res.writeHead(status); res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const github = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      gh.tokenCalls += 1;
      send(res, 200, { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 28800 });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/user') {
      send(res, 200, { type: 'User', id: 424242, login: 'admin-a' });
      return;
    }
    if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) { send(res, 401, { message: 'unauthorized' }); return; }
    if (url.pathname === REPO_PATH) {
      send(res, 200, { id: contract.PROPERTY_REPOSITORY_ID, full_name: contract.PROPERTY_REPOSITORY });
      return;
    }
    if (url.pathname === `${REPO_PATH}/issues` && req.method === 'GET') {
      if (gh.listStatus !== 200) { send(res, gh.listStatus, { message: 'error' }); return; }
      send(res, 200, gh.issues.map((issue) => ({ ...issue, pull_request: undefined })));
      return;
    }
    if (url.pathname === `${REPO_PATH}/issues` && req.method === 'POST') {
      gh.posts += 1;
      if (gh.failPostWith !== null) { send(res, gh.failPostWith, { message: 'error' }); return; }
      const input = JSON.parse(raw);
      const issue = {
        id: 9000 + gh.issues.length,
        number: 500 + gh.issues.length,
        title: input.title,
        body: input.body,
        html_url: `https://github.com/${contract.PROPERTY_REPOSITORY}/issues/${500 + gh.issues.length}`,
      };
      gh.issues.push(issue);
      send(res, 201, issue);
      return;
    }
    send(res, 404, { message: 'not found' });
  });
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));
const githubPort = github.address().port;

/* --- Worker на miniflare -------------------------------------------------- */

const runtimes = [];
function makeRuntime(bindings = {}) {
  const runtime = new Miniflare({
    modules: true,
    script: workerScript,
    compatibilityDate: '2025-06-01',
    durableObjects: { OAUTH_STATE: { className: 'OAuthState', useSQLite: true } },
    durableObjectsPersist: mkdtempSync(path.join(os.tmpdir(), 'worker-submit-')),
    bindings: {
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: SECRET,
      GITHUB_CALLBACK_URL: 'https://gateway.test/auth/callback',
      GITHUB_TOKEN_URL: `http://127.0.0.1:${githubPort}/login/oauth/access_token`,
      GITHUB_USER_URL: `http://127.0.0.1:${githubPort}/user`,
      GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`,
      SITE_ORIGIN: SITE,
      ...bindings,
    },
  });
  runtimes.push(runtime);
  return runtime;
}

const call = (runtime, url, init = {}) => runtime.dispatchFetch(url, {
  ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
});

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** Настоящий вход: start → callback → cookie сессии. */
async function login(runtime) {
  const start = await call(runtime, 'http://localhost/auth/start');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const binding = cookieValue(start.headers.get('set-cookie'), 'issue_oauth_binding');
  const callback = await call(runtime, `http://localhost/auth/callback?code=good-code&state=${state}`, {
    headers: { cookie: `issue_oauth_binding=${binding}` },
  });
  assert.equal(callback.status, 302);
  const session = cookieValue(callback.headers.get('set-cookie'), 'issue_oauth_session');
  assert.ok(session);
  return { session, callback };
}

const REQUEST_ID = 'pr-abc12345-00112233445566778899aabbccddeeff';
function issueBody(overrides = {}) {
  const packet = {
    type: 'sector-property-request',
    version: 1,
    requestId: REQUEST_ID,
    repositoryId: contract.PROPERTY_REPOSITORY_ID,
    baseRevision: 'd'.repeat(64),
    changes: [{ dataset: 'systems', recordId: '1', field: 'description', before: 'Старое', after: 'Новое' }],
    ...overrides,
  };
  return contract.renderPropertyIssueBody(contract.readPacket(packet));
}
const TITLE = contract.propertyIssueTitle('e'.repeat(64));
const submitBody = () => ({ title: TITLE, body: issueBody(), requestId: REQUEST_ID });

function submit(runtime, session, payload, headers = {}) {
  return call(runtime, 'http://localhost/issues/submit', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: SITE,
      cookie: `issue_oauth_session=${session}`,
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

let runtime;
before(() => { runtime = makeRuntime(); });
after(async () => {
  for (const item of runtimes) await item.dispose().catch(() => {});
  await new Promise((resolve) => github.close(resolve));
});

test('сессия ставится как SameSite=None: сайт и Worker — разные сайты', async () => {
  const { callback } = await login(runtime);
  const header = callback.headers.get('set-cookie');
  assert.match(header, /Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=None/);
  assert.equal(header.includes(SECRET), false);
});

test('без сессии отправка невозможна, Issue не создаётся', async () => {
  const before = gh.posts;
  const response = await call(runtime, 'http://localhost/issues/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE },
    body: JSON.stringify(submitBody()),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
  assert.equal(gh.posts, before);
});

test('чужой или отсутствующий Origin отклоняется до обращения к GitHub', async () => {
  const { session } = await login(runtime);
  const before = gh.posts;
  for (const origin of [undefined, 'https://evil.test', 'http://site.test', `${SITE}.evil.test`, 'null']) {
    const headers = { 'content-type': 'application/json', cookie: `issue_oauth_session=${session}` };
    if (origin !== undefined) headers.origin = origin;
    const response = await call(runtime, 'http://localhost/issues/submit', {
      method: 'POST', headers, body: JSON.stringify(submitBody()),
    });
    assert.equal(response.status, 403, String(origin));
    assert.deepEqual(await response.json(), { error: 'forbidden_origin' });
  }
  assert.equal(gh.posts, before);
});

test('preflight отвечает только своему Origin и без wildcard', async () => {
  const good = await call(runtime, 'http://localhost/issues/submit', {
    method: 'OPTIONS',
    headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get('access-control-allow-origin'), SITE);
  assert.equal(good.headers.get('access-control-allow-credentials'), 'true');
  assert.match(good.headers.get('access-control-allow-methods'), /POST/);
  assert.equal(`${good.headers.get('access-control-allow-origin')}`.includes('*'), false);
  const bad = await call(runtime, 'http://localhost/issues/submit', {
    method: 'OPTIONS', headers: { origin: 'https://evil.test' },
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('успешная отправка: одна Issue, ответ без токена и тела, cookie в CORS-ответе', async () => {
  const { session } = await login(runtime);
  const before = gh.posts;
  gh.issues.length = 0;
  const response = await submit(runtime, session, submitBody());
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload).sort(), ['number', 'status', 'url']);
  assert.equal(payload.status, 'created');
  assert.equal(payload.number, 500);
  assert.equal(gh.posts, before + 1);
  assert.equal(gh.issues[0].title, TITLE);
  assert.equal(gh.issues[0].body, issueBody());
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes(ACCESS_TOKEN), false);
  assert.equal(raw.includes(SECRET), false);
  assert.equal(raw.includes('Старое'), false);
});

test('повтор того же запроса не создаёт вторую Issue', async () => {
  const { session } = await login(runtime);
  gh.issues.length = 0;
  const first = await submit(runtime, session, submitBody());
  assert.equal(first.status, 201);
  const postsAfterFirst = gh.posts;
  const second = await submit(runtime, session, submitBody());
  assert.equal(second.status, 200);
  const payload = await second.json();
  assert.equal(payload.status, 'existing');
  assert.equal(payload.number, (await first.json()).number);
  assert.equal(gh.posts, postsAfterFirst);
});

test('неизвестный ответ создания не превращается в успех и не повторяется слепо', async () => {
  const { session } = await login(runtime);
  gh.issues.length = 0;
  gh.failPostWith = 502;
  try {
    const failed = await submit(runtime, session, submitBody());
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'unavailable' });
  } finally {
    gh.failPostWith = null;
  }
  const postsAfterFailure = gh.posts;
  const retried = await submit(runtime, session, submitBody());
  assert.equal(retried.status, 201, 'после достоверного «нет» повтор разрешён');
  assert.equal(gh.posts, postsAfterFailure + 1);
});

test('сбой поиска перед созданием: unavailable, POST не выполняется', async () => {
  const { session } = await login(runtime);
  gh.listStatus = 500;
  const postsBefore = gh.posts;
  try {
    const response = await submit(runtime, session, submitBody());
    assert.equal(response.status, 503);
    assert.equal(gh.posts, postsBefore);
  } finally {
    gh.listStatus = 200;
  }
});

test('некорректные тела: не JSON, лишние поля, неканонический блок, чужой requestId', async () => {
  const { session } = await login(runtime);
  const postsBefore = gh.posts;
  const canonical = submitBody();
  const cases = [
    ['текст', { 'content-type': 'application/json' }],
    [JSON.stringify(canonical), { 'content-type': 'text/plain' }],
    [JSON.stringify({ ...canonical, extra: 1 }), {}],
    [JSON.stringify({ ...canonical, requestId: 'pr-abc12345-ffffffffffffffffffffffffffff' }), {}],
    [JSON.stringify({ ...canonical, body: canonical.body.replace('"before": "Старое"', '"before":  "Старое"') }), {}],
    [JSON.stringify({ ...canonical, body: `${canonical.body}\nлишнее` }), {}],
    [JSON.stringify([canonical]), {}],
    ['', {}],
  ];
  for (const [body, headers] of cases) {
    const response = await submit(runtime, session, body, { 'content-type': 'application/json', ...headers });
    assert.equal(response.status, 400, `${body.slice(0, 40)} → ${response.status}`);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });
  }
  assert.equal(gh.posts, postsBefore);
});

test('отказ GitHub (403) — provider_rejected, без деталей и токена', async () => {
  const { session } = await login(runtime);
  gh.issues.length = 0;
  gh.failPostWith = 403;
  try {
    const response = await submit(runtime, session, submitBody());
    assert.equal(response.status, 401);
    const payload = await response.json();
    assert.deepEqual(payload, { error: 'provider_rejected' });
    assert.equal(JSON.stringify(payload).includes(ACCESS_TOKEN), false);
  } finally {
    gh.failPostWith = null;
  }
});

test('выход отзывает сессию: отправка после logout отклоняется', async () => {
  const { session } = await login(runtime);
  const logout = await call(runtime, 'http://localhost/auth/logout', {
    method: 'POST', headers: { cookie: `issue_oauth_session=${session}` },
  });
  assert.deepEqual(await logout.json(), { ok: true });
  const response = await submit(runtime, session, submitBody());
  assert.equal(response.status, 401);
});

test('без SITE_ORIGIN отправка закрыта: неопределённый источник не разрешает', async () => {
  const unset = makeRuntime({ SITE_ORIGIN: '' });
  try {
    const response = await call(unset, 'http://localhost/issues/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: SITE, cookie: 'issue_oauth_session=' },
      body: JSON.stringify(submitBody()),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'forbidden_origin' });
  } finally {
    await unset.dispose();
  }
});

test('ответы об ошибках не содержат секретов, токена и текста заявки', async () => {
  const { session } = await login(runtime);
  const blob = [];
  for (const payload of [{}, null, { ...submitBody(), body: issueBody().replace('Новое', 'секрет-в-тексте') }]) {
    const response = await submit(runtime, session, payload ?? '');
    blob.push(await response.text());
  }
  const all = blob.join('|');
  for (const secret of [SECRET, ACCESS_TOKEN, 'секрет-в-тексте', 'client_secret']) {
    assert.equal(all.includes(secret), false, secret);
  }
});
