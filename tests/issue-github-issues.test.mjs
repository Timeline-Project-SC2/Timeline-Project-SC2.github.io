// Приватные Issues против фиктивного API: бот-автор, корень/комментарий,
// восстановление неизвестного результата и отказ на публичной/чужой цели.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../src/issue-gateway/property-issue-contract.ts');
const { createRequestIssue, findRequestIssue, readRequestIssue, issuesConfigValid, confirmRepository } = require('../src/issue-gateway/github-issues.ts');

const TOKEN = 'ghs_mock_installation_token_never_leak';
const API = 'http://127.0.0.1:4180';
const TARGET = { id: 987654321, fullName: 'Timeline-Project-SC2/property-requests' };
const CONFIG = { target: TARGET, botLogin: 'timeline-requests[bot]', apiBase: API };
const BOT = { type: 'Bot', login: 'timeline-requests[bot]' };
const REQUEST_ID = 'pr-abc12345-00112233445566778899aabbccddeeff';
const VERSION_ID = 'pr-def12345-00112233445566778899aabbccddeeff';
const packet = contract.sealPropertyRequest({
  type: 'sector-property-request-draft', version: 2, requestId: REQUEST_ID, threadId: REQUEST_ID,
  baseRevision: 'b'.repeat(64), changes: [{ dataset: 'places', recordId: '42', field: 'name', before: 'Старое', after: 'Новое' }],
}, { id: 42, login: 'player-one' }, '2026-11-13T10:00:00.000Z', TARGET);
const body = contract.renderPropertyIssueBody(packet);
const title = contract.propertyIssueTitle('c'.repeat(64));
const input = { title, body, packet };
const repoPayload = { id: TARGET.id, full_name: TARGET.fullName, private: true, visibility: 'private', has_issues: true, archived: false, owner: { type: 'Organization', login: 'Timeline-Project-SC2' } };
const issuePayload = (overrides = {}) => ({ id: 9001, number: 501, title, body, state: 'open', user: BOT, html_url: `https://github.com/${TARGET.fullName}/issues/501`, ...overrides });
const REPO = `/repos/${TARGET.fullName}`;
function makeApi(handlers) {
  const calls = [];
  const transport = async (url, init) => {
    const method = init?.method ?? 'GET', parsed = new URL(url);
    calls.push({ method, path: parsed.pathname, query: parsed.search, headers: init?.headers ?? {}, body: init?.body ?? null, redirect: init?.redirect });
    const handler = handlers[`${method} ${parsed.pathname}`] ?? handlers.defaultEndpoint;
    return handler ? handler({ url: parsed, init, calls }) : new Response('not found', { status: 404 });
  };
  return { calls, transport };
}
const okRepo = () => Response.json(repoPayload);

test('успешное создание: приватная цель по ID, поиск, один POST от бота', async () => {
  const { calls, transport } = makeApi({
    [`GET ${REPO}`]: okRepo,
    [`GET ${REPO}/issues`]: () => Response.json([{ ...issuePayload(), number: 500, body: 'обычная Issue' }]),
    [`POST ${REPO}/issues`]: ({ init }) => { assert.deepEqual(JSON.parse(init.body), { title, body }); return Response.json(issuePayload(), { status: 201 }); },
  });
  const result = await createRequestIssue(TOKEN, CONFIG, input, transport);
  assert.equal(result.status, 'created');
  assert.equal(result.issue.number, 501);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'POST']);
  for (const call of calls) { assert.equal(call.redirect, 'manual'); assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`); }
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('первый атомарный POST не делает поиск; восстановление неизвестного результата ищет', async () => {
  let lists = 0, posts = 0;
  const { transport } = makeApi({
    [`GET ${REPO}`]: okRepo,
    [`GET ${REPO}/issues`]: () => { lists++; return Response.json([]); },
    [`POST ${REPO}/issues`]: () => { posts++; return Response.json(issuePayload(), { status: 201 }); },
  });
  assert.equal((await createRequestIssue(TOKEN, CONFIG, { ...input, recover: false }, transport)).status, 'created');
  assert.equal(lists, 0); assert.equal(posts, 1);
  assert.equal((await createRequestIssue(TOKEN, CONFIG, { ...input, recover: true }, transport)).status, 'created');
  assert.equal(lists, 1); assert.equal(posts, 2);
});

test('повторная попытка не создаёт второй Issue: найденная заявка возвращается как exists', async () => {
  let posts = 0;
  const { transport } = makeApi({ [`GET ${REPO}`]: okRepo, [`GET ${REPO}/issues`]: () => Response.json([issuePayload()]), [`POST ${REPO}/issues`]: () => { posts++; return Response.json(issuePayload(), { status: 201 }); } });
  const result = await createRequestIssue(TOKEN, CONFIG, input, transport);
  assert.equal(result.status, 'exists'); assert.equal(result.issue.number, 501); assert.equal(posts, 0);
});

test('поиск: точный канонический пакет, pull request и чужой автор не считаются заявкой', async () => {
  const listed = [
    issuePayload({ number: 1, body: body.replace(REQUEST_ID, 'pr-ffffffff-00112233445566778899aabbccddeeff') }),
    { ...issuePayload({ number: 2 }), pull_request: { url: 'x' } },
    issuePayload({ number: 3, user: { type: 'User', login: 'player-one' } }),
    issuePayload({ number: 4 }),
  ];
  const { transport } = makeApi({ [`GET ${REPO}/issues`]: () => Response.json(listed) });
  const found = await findRequestIssue(TOKEN, CONFIG, packet, transport);
  assert.equal(found.status, 'found'); assert.equal(found.issue.number, 4);
  for (const status of [401, 403, 404, 500]) {
    const { transport: denied } = makeApi({ [`GET ${REPO}/issues`]: () => new Response('', { status }) });
    assert.deepEqual(await findRequestIssue(TOKEN, CONFIG, packet, denied), { status: 'unavailable' });
  }
});

test('неизвестный результат не превращается в «нет»: 5xx, 3xx, 429, мусор, сеть', async () => {
  const failures = [() => new Response('', { status: 502 }), () => new Response(null, { status: 302 }), () => new Response('', { status: 429 }),
    () => new Response('не json', { status: 200 }), () => Response.json({ message: 'rate limit' }), () => { throw new TypeError('network down'); }];
  for (const fail of failures) {
    const { transport, calls } = makeApi({ [`GET ${REPO}`]: okRepo, [`GET ${REPO}/issues`]: fail });
    const result = await createRequestIssue(TOKEN, CONFIG, input, transport);
    assert.equal(result.status, 'unavailable');
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  }
});

test('публичная, чужая или отключённая цель отклоняется до POST', async () => {
  for (const repo of [{ ...repoPayload, private: false, visibility: 'public' }, { ...repoPayload, id: 1 }, { ...repoPayload, has_issues: false }, { ...repoPayload, owner: { type: 'User', login: 'x' } }]) {
    let posts = 0;
    const { transport } = makeApi({ [`GET ${REPO}`]: () => Response.json(repo), [`POST ${REPO}/issues`]: () => { posts++; return Response.json(issuePayload(), { status: 201 }); } });
    assert.equal((await createRequestIssue(TOKEN, CONFIG, input, transport)).status, 'rejected'); assert.equal(posts, 0);
  }
  assert.equal(await confirmRepository(makeApi({ [`GET ${REPO}`]: okRepo }).transport, TOKEN, CONFIG), 'ok');
});

test('новая версия идёт комментарием в ту же нить и не редактирует Issue', async () => {
  const version = contract.sealPropertyRequest({ type: 'sector-property-request-draft', version: 2, requestId: VERSION_ID, threadId: REQUEST_ID,
    baseRevision: 'b'.repeat(64), changes: [{ dataset: 'places', recordId: '42', field: 'name', before: 'Новое', after: 'Третье' }] }, packet.author, '2026-11-13T11:00:00.000Z', TARGET);
  const versionBody = contract.renderPropertyIssueBody(version);
  let comments = 0, patches = 0;
  const { calls, transport } = makeApi({
    [`GET ${REPO}`]: okRepo,
    [`GET ${REPO}/issues/501`]: () => Response.json(issuePayload()),
    [`GET ${REPO}/issues/501/comments`]: () => Response.json([]),
    [`POST ${REPO}/issues/501/comments`]: ({ init }) => { comments++; assert.deepEqual(JSON.parse(init.body), { body: versionBody }); return Response.json({ id: 77, body: versionBody, user: BOT }, { status: 201 }); },
    [`PATCH ${REPO}/issues/501`]: () => { patches++; return Response.json(issuePayload()); },
  });
  const result = await createRequestIssue(TOKEN, CONFIG, { title, body: versionBody, packet: version, threadIssueNumber: 501 }, transport);
  assert.equal(result.status, 'created'); assert.equal(result.issue.number, 501); assert.equal(result.commentId, 77);
  assert.equal(comments, 1); assert.equal(patches, 0); assert.equal(calls.some((c) => c.method === 'PATCH' || c.method === 'PUT'), false);
});

test('закрытая нить не принимает комментарий; чужой автор корня отклоняется', async () => {
  const version = contract.sealPropertyRequest({ type: 'sector-property-request-draft', version: 2, requestId: VERSION_ID, threadId: REQUEST_ID,
    baseRevision: 'b'.repeat(64), changes: [{ dataset: 'places', recordId: '42', field: 'name', before: 'Новое', after: 'Третье' }] }, packet.author, '2026-11-13T11:00:00.000Z', TARGET);
  const versionBody = contract.renderPropertyIssueBody(version);
  const { transport } = makeApi({ [`GET ${REPO}`]: okRepo, [`GET ${REPO}/issues/501`]: () => Response.json(issuePayload({ state: 'closed' })) });
  assert.equal((await createRequestIssue(TOKEN, CONFIG, { title, body: versionBody, packet: version, threadIssueNumber: 501 }, transport)).status, 'closed');
  const foreignRoot = contract.renderPropertyIssueBody({ ...packet, author: { id: 99, login: 'other' } });
  const { transport: foreign } = makeApi({ [`GET ${REPO}`]: okRepo, [`GET ${REPO}/issues/501`]: () => Response.json(issuePayload({ body: foreignRoot })) });
  assert.equal((await createRequestIssue(TOKEN, CONFIG, { title, body: versionBody, packet: version, threadIssueNumber: 501 }, foreign)).status, 'invalid');
});

test('некорректный вход отклоняется до сети', async () => {
  let requests = 0;
  const transport = async () => { requests++; return Response.json(issuePayload(), { status: 201 }); };
  const invalid = [
    ['', CONFIG, input], ['bad\n', CONFIG, input], [TOKEN, { ...CONFIG, apiBase: 'http://github.example' }, input],
    [TOKEN, CONFIG, { ...input, title: 'без маркера' }], [TOKEN, CONFIG, { ...input, body: body.replace('"before": "Старое"', '"before":  "Старое"') }],
    [TOKEN, CONFIG, { ...input, packet: { ...packet, repositoryId: 1 } }],
    [TOKEN, CONFIG, { ...input, threadIssueNumber: 501 }],
  ];
  for (const [token, config, value] of invalid) assert.deepEqual(await createRequestIssue(token, config, value, transport), { status: 'invalid' });
  assert.equal(requests, 0);
  assert.equal(issuesConfigValid(TOKEN, CONFIG), true);
  assert.equal(issuesConfigValid(TOKEN, { ...CONFIG, botLogin: 'player-one' }), false);
});

test('чтение своей Issue сверяет номер, бота и каноническое тело', async () => {
  const { transport } = makeApi({ [`GET ${REPO}/issues/501`]: () => Response.json(issuePayload()) });
  assert.equal((await readRequestIssue(TOKEN, CONFIG, 501, packet, transport)).status, 'found');
  const { transport: bad } = makeApi({ [`GET ${REPO}/issues/501`]: () => Response.json(issuePayload({ number: 502 })) });
  assert.equal((await readRequestIssue(TOKEN, CONFIG, 501, packet, bad)).status, 'unavailable');
});

test('пагинация ограничена: неполная страница — «нет», пятая полная — неизвестно', async () => {
  const { calls, transport } = makeApi({ [`GET ${REPO}/issues`]: () => Response.json([]) });
  assert.deepEqual(await findRequestIssue(TOKEN, CONFIG, packet, transport), { status: 'absent' });
  assert.equal(calls.length, 1);
  const full = Array.from({ length: contract.PROPERTY_LIST_PER_PAGE }, (_, i) => issuePayload({ id: i + 1, number: i + 1, body: 'чужая' }));
  const { calls: many, transport: pages } = makeApi({ [`GET ${REPO}/issues`]: () => Response.json(full) });
  assert.deepEqual(await findRequestIssue(TOKEN, CONFIG, packet, pages), { status: 'unavailable' });
  assert.equal(many.length, 5);
  assert.equal(new URLSearchParams(many[0].query).get('state'), 'all');
});
