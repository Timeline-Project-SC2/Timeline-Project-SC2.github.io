// Приватная цепочка v2 на miniflare: вход только для личности, GitHub App,
// prepare → submit, нити/версии, квота, «Мои заявки», неизвестный результат.
// НЕ доказывает: роль Owner, применение правки, публикацию и реальный Cloudflare.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../src/issue-gateway/property-issue-contract.ts');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://site.test';
const SECRET = 'test-client-secret-must-not-leak';
const USER_TOKEN = 'gho_mocktoken_never_leak';
const APP_TOKEN = 'ghs_mock_installation_never_leak';
const TARGET = { id: 987654321, fullName: 'Timeline-Project-SC2/property-requests' };
const REPO_PATH = `/repos/${TARGET.fullName}`;
const BOT = { type: 'Bot', login: 'timeline-requests[bot]' };
const USER = { type: 'User', id: 424242, login: 'player-one' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

const bundle = buildSync({ entryPoints: [path.join(root, 'worker/src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers'], write: false, logLevel: 'silent' });
const workerScript = bundle.outputFiles[0].text;

const gh = { issues: [], comments: new Map(), posts: 0, commentPosts: 0, appTokens: 0, failPostWith: null, listStatus: 200, repoPrivate: true };
function send(res, status, payload) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(payload === undefined ? '' : JSON.stringify(payload)); }
const repoPayload = () => ({ id: TARGET.id, full_name: TARGET.fullName, private: gh.repoPrivate, visibility: gh.repoPrivate ? 'private' : 'public', has_issues: true, archived: false, owner: { type: 'Organization', login: 'Timeline-Project-SC2' } });
const github = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') { send(res, 200, { access_token: USER_TOKEN, token_type: 'bearer' }); return; }
    if (req.method === 'GET' && url.pathname === '/user') { send(res, 200, USER); return; }
    if (req.method === 'GET' && url.pathname === '/app') { send(res, 200, { client_id: 'test-app-client', slug: 'timeline-requests' }); return; }
    if (req.method === 'POST' && url.pathname === '/app/installations/123/access_tokens') {
      gh.appTokens++;
      const body = JSON.parse(raw);
      assert.deepEqual(body.repositories, [TARGET.fullName.split('/')[1]]);
      assert.deepEqual(body.repository_ids, [TARGET.id]);
      assert.deepEqual(body.permissions, { issues: 'write' });
      send(res, 201, { token: APP_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), repository_selection: 'selected', repositories: [repoPayload()], permissions: { issues: 'write' } });
      return;
    }
    if (req.headers.authorization !== `Bearer ${APP_TOKEN}`) { send(res, 401, { message: 'unauthorized' }); return; }
    if (req.method === 'GET' && url.pathname === REPO_PATH) { send(res, 200, repoPayload()); return; }
    if (url.pathname === `${REPO_PATH}/issues` && req.method === 'GET') { send(res, gh.listStatus, gh.listStatus === 200 ? gh.issues : { message: 'error' }); return; }
    if (url.pathname === `${REPO_PATH}/issues` && req.method === 'POST') {
      gh.posts++;
      if (gh.failPostWith !== null) { send(res, gh.failPostWith, { message: 'error' }); return; }
      const input = JSON.parse(raw);
      const issue = { id: 9000 + gh.issues.length, number: 500 + gh.issues.length, title: input.title, body: input.body, state: 'open', user: BOT, html_url: `https://github.com/${TARGET.fullName}/issues/${500 + gh.issues.length}` };
      gh.issues.push(issue); send(res, 201, issue); return;
    }
    const issueMatch = new RegExp(`^${REPO_PATH}/issues/(\\d+)$`).exec(url.pathname);
    if (issueMatch && req.method === 'GET') { const issue = gh.issues.find((i) => i.number === Number(issueMatch[1])); send(res, issue ? 200 : 404, issue); return; }
    const commentsMatch = new RegExp(`^${REPO_PATH}/issues/(\\d+)/comments$`).exec(url.pathname);
    if (commentsMatch) {
      const number = Number(commentsMatch[1]);
      if (req.method === 'GET') { send(res, 200, gh.comments.get(number) ?? []); return; }
      if (req.method === 'POST') {
        gh.commentPosts++;
        if (gh.failPostWith !== null) { send(res, gh.failPostWith, { message: 'error' }); return; }
        const input = JSON.parse(raw);
        const comment = { id: 7000 + gh.commentPosts, body: input.body, user: BOT };
        gh.comments.set(number, [...(gh.comments.get(number) ?? []), comment]);
        send(res, 201, comment); return;
      }
    }
    send(res, 404, { message: 'not found' });
  });
});
await new Promise((resolve) => github.listen(0, '127.0.0.1', resolve));
const githubPort = github.address().port;

const runtimes = [];
function makeRuntime(bindings = {}) {
  const runtime = new Miniflare({
    modules: true, script: workerScript, compatibilityDate: '2025-06-01',
    durableObjects: { OAUTH_STATE: { className: 'OAuthState', useSQLite: true } },
    durableObjectsPersist: mkdtempSync(path.join(os.tmpdir(), 'worker-submit-')),
    bindings: {
      GITHUB_CLIENT_ID: 'test-oauth-client', GITHUB_CLIENT_SECRET: SECRET, GITHUB_CALLBACK_URL: 'https://gateway.test/auth/callback',
      GITHUB_TOKEN_URL: `http://127.0.0.1:${githubPort}/login/oauth/access_token`, GITHUB_USER_URL: `http://127.0.0.1:${githubPort}/user`,
      GITHUB_API_BASE: `http://127.0.0.1:${githubPort}`, SITE_ORIGIN: SITE,
      PROPERTY_REPOSITORY_ID: String(TARGET.id), PROPERTY_REPOSITORY: TARGET.fullName,
      GITHUB_APP_CLIENT_ID: 'test-app-client', GITHUB_APP_INSTALLATION_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey,
      PROPERTY_OPEN_LIMIT: '20', ...bindings,
    },
  });
  runtimes.push(runtime); return runtime;
}
const call = (runtime, url, init = {}) => runtime.dispatchFetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
function cookieValue(header, name) { for (const part of (header ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return null; }
async function login(runtime) {
  const start = await call(runtime, 'http://localhost/auth/start?return=requests');
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const binding = cookieValue(start.headers.get('set-cookie'), 'issue_oauth_binding');
  const callback = await call(runtime, `http://localhost/auth/callback?code=good-code&state=${state}`, { headers: { cookie: `issue_oauth_binding=${binding}` } });
  assert.equal(callback.status, 302);
  return { session: cookieValue(callback.headers.get('set-cookie'), 'issue_oauth_session'), callback };
}
let counter = 0;
const requestId = () => `pr-test${(++counter).toString(36).padStart(5, '0')}-00112233445566778899aabbccddeeff`;
function draft(overrides = {}) {
  const id = requestId();
  return { type: 'sector-property-request-draft', version: 2, requestId: id, threadId: id, baseRevision: 'd'.repeat(64),
    changes: [{ dataset: 'systems', recordId: '1', field: 'description', before: 'Старое', after: 'Новое' }], ...overrides };
}
function post(runtime, session, path, payload, headers = {}) {
  return call(runtime, `http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE, cookie: `issue_oauth_session=${session}`, ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
}
async function prepare(runtime, session, value = draft()) {
  const response = await post(runtime, session, '/issues/prepare', { draft: value });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function submit(runtime, session, prepared) { return post(runtime, session, '/issues/submit', { requestId: prepared.requestId, fingerprint: prepared.fingerprint }); }
let runtime;
before(() => { runtime = makeRuntime(); });
after(async () => { for (const item of runtimes) await item.dispose().catch(() => {}); await new Promise((resolve) => github.close(resolve)); });

test('вход не просит репозиторий, сессия на 7 суток, возврат в «Мои заявки»', async () => {
  const start = await call(runtime, 'http://localhost/auth/start?return=requests');
  assert.equal(new URL(start.headers.get('location')).searchParams.get('scope'), '');
  const { session, callback } = await login(runtime);
  assert.ok(session);
  assert.equal(callback.headers.get('location'), `${SITE}/sector/?requests=1`);
  assert.match(callback.headers.get('set-cookie'), /Max-Age=604800; Secure; HttpOnly; SameSite=None/);
});

test('без сессии prepare/submit/mine закрыты, GitHub App не вызывается', async () => {
  const before = gh.appTokens;
  assert.equal((await call(runtime, 'http://localhost/issues/prepare', { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify({ draft: draft() }) })).status, 401);
  assert.equal((await call(runtime, 'http://localhost/issues/submit', { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: '{}' })).status, 401);
  assert.equal((await call(runtime, 'http://localhost/issues/mine', { headers: { origin: SITE } })).status, 401);
  assert.equal(gh.appTokens, before);
});

test('чужой Origin и простая форма отклоняются', async () => {
  const { session } = await login(runtime);
  const value = { draft: draft() };
  assert.equal((await post(runtime, session, '/issues/prepare', value, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(runtime, 'http://localhost/issues/prepare', { method: 'POST', headers: { 'content-type': 'text/plain', origin: SITE, cookie: `issue_oauth_session=${session}` }, body: JSON.stringify(value) })).status, 400);
  const preflight = await call(runtime, 'http://localhost/issues/prepare', { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), SITE);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
});

test('prepare запечатывает автора из сессии; submit создаёт Issue ботом с автором внутри', async () => {
  const { session } = await login(runtime);
  const value = draft();
  const prepared = await prepare(runtime, session, value);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.requestId, value.requestId);
  assert.match(prepared.body, /- Кто: @player-one · номер GitHub `424242`/);
  assert.match(prepared.body, /- Описание: Старое → Новое/);
  const before = gh.posts;
  const response = await submit(runtime, session, prepared);
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.status, 'created'); assert.equal(payload.number, 500);
  assert.equal(gh.posts, before + 1);
  assert.equal(gh.issues.at(-1).user.login, BOT.login);
  assert.equal(JSON.stringify(payload).includes(APP_TOKEN), false);
  assert.equal(JSON.stringify(payload).includes(prepared.body), false);
});

test('повтор того же prepare/submit идемпотентен и не создаёт дубль', async () => {
  const { session } = await login(runtime);
  const value = draft();
  const first = await prepare(runtime, session, value);
  const second = await prepare(runtime, session, value);
  assert.equal(first.fingerprint, second.fingerprint);
  const before = gh.posts;
  assert.equal((await submit(runtime, session, first)).status, 201);
  const again = await submit(runtime, session, second);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, 'existing');
  assert.equal(gh.posts, before + 1);
});

test('изменение того же черновика после подготовки отклоняется, а не перезаписывается', async () => {
  const { session } = await login(runtime);
  const value = draft();
  await prepare(runtime, session, value);
  const changed = { ...value, changes: [{ ...value.changes[0], after: 'Другое' }] };
  const response = await post(runtime, session, '/issues/prepare', { draft: changed });
  assert.equal(response.status, 400);
});

test('новая версия идёт комментарием в ту же нить; лимит считает нити, не версии', async () => {
  const { session } = await login(runtime);
  const root = await prepare(runtime, session, draft());
  const rootCreated = await submit(runtime, session, root);
  assert.equal(rootCreated.status, 201);
  const rootNumber = (await rootCreated.json()).number;
  const version = await prepare(runtime, session, draft({ threadId: root.threadId, changes: [{ dataset: 'systems', recordId: '1', field: 'description', before: 'Новое', after: 'Третье' }] }));
  const before = gh.commentPosts;
  const response = await submit(runtime, session, version);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).number, rootNumber);
  assert.equal(gh.commentPosts, before + 1);
});

test('лимит открытых нитей блокирует новую нить, но не версию существующей', async () => {
  const limited = makeRuntime({ PROPERTY_OPEN_LIMIT: '1' });
  const { session } = await login(limited);
  const first = await prepare(limited, session, draft());
  assert.equal((await submit(limited, session, first)).status, 201);
  const second = await prepare(limited, session, draft());
  const blocked = await submit(limited, session, second);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'request_limit', openLimit: 1 });
});

test('закрытая нить не принимает новую версию', async () => {
  const { session } = await login(runtime);
  const root = await prepare(runtime, session, draft());
  const rootCreated = await submit(runtime, session, root);
  assert.equal(rootCreated.status, 201);
  const rootNumber = (await rootCreated.json()).number;
  const version = await prepare(runtime, session, draft({ threadId: root.threadId }));
  gh.issues.find((issue) => issue.number === rootNumber).state = 'closed';
  const response = await submit(runtime, session, version);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'thread_closed' });
  gh.issues.find((issue) => issue.number === rootNumber).state = 'open';
});

test('неизвестный результат создания не создаёт второй POST сразу и держит резерв', async () => {
  const { session } = await login(runtime);
  const prepared = await prepare(runtime, session, draft());
  gh.failPostWith = 500;
  const before = gh.posts;
  const first = await submit(runtime, session, prepared);
  assert.equal(first.status, 503);
  assert.equal(gh.posts, before + 1);
  gh.failPostWith = null;
  const immediate = await submit(runtime, session, prepared);
  assert.equal(immediate.status, 503);
  assert.equal(gh.posts, before + 1, 'пока резерв свежий, повтор в GitHub не идёт');
});

test('мои заявки возвращают только свои версии и лимит, без токенов', async () => {
  const { session } = await login(runtime);
  const response = await call(runtime, 'http://localhost/issues/mine', { headers: { origin: SITE, cookie: `issue_oauth_session=${session}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.json();
  assert.equal(payload.openLimit, 20);
  assert.ok(Array.isArray(payload.requests));
  assert.ok(payload.requests.length > 0);
  for (const request of payload.requests) {
    assert.equal(Object.hasOwn(request, 'userId'), false);
    assert.equal(Object.hasOwn(request, 'packetJson'), false);
    assert.ok(request.changes.length > 0);
  }
  assert.equal(JSON.stringify(payload).includes(APP_TOKEN), false);
});

test('без лимита или App приём выключен; публичная цель отклоняется', async () => {
  const { session } = await login(runtime);
  const disabled = makeRuntime({ PROPERTY_OPEN_LIMIT: '' });
  const loginDisabled = await login(disabled);
  assert.equal((await post(disabled, loginDisabled.session, '/issues/prepare', { draft: draft() })).status, 503);
  gh.repoPrivate = false;
  const prepared = await prepare(runtime, session, draft());
  const response = await submit(runtime, session, prepared);
  assert.equal(response.status, 503);
  gh.repoPrivate = true;
});

test('подменённое тело и чужой requestId не принимаются', async () => {
  const { session } = await login(runtime);
  const prepared = await prepare(runtime, session, draft());
  assert.equal((await post(runtime, session, '/issues/submit', { requestId: prepared.requestId, fingerprint: 'f'.repeat(64) })).status, 400);
  assert.equal((await post(runtime, session, '/issues/submit', { requestId: requestId(), fingerprint: prepared.fingerprint })).status, 400);
  assert.equal((await post(runtime, session, '/issues/submit', { title: 'x', body: 'y', requestId: prepared.requestId })).status, 400);
});

test('выход отзывает сессию: prepare после logout невозможен', async () => {
  const { session } = await login(runtime);
  const logout = await call(runtime, 'http://localhost/auth/logout', { method: 'POST', headers: { origin: SITE, cookie: `issue_oauth_session=${session}` } });
  assert.deepEqual(await logout.json(), { ok: true });
  assert.equal((await post(runtime, session, '/issues/prepare', { draft: draft() })).status, 401);
});
