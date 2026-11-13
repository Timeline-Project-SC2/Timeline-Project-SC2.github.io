// GitHub Issues против фиктивного API: отправка заявки, отсутствие дублей
// после неизвестного результата, отказ на чужой репозиторий и утечки.
// Реальные запросы к github.com не выполняются: транспорт подменён.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../src/issue-gateway/property-issue-contract.ts');
const { createRequestIssue, findRequestIssue, issuesConfigValid } = require('../src/issue-gateway/github-issues.ts');

const TOKEN = 'gho_фиктивный_токен_никогда_не_утекает';
const API = 'http://127.0.0.1:4180';
const BASE = 'b'.repeat(64);
const REQUEST_ID = 'pr-abc12345-00112233445566778899aabbccddeeff';
const packet = {
  type: 'sector-property-request',
  version: 1,
  requestId: REQUEST_ID,
  repositoryId: 1421259694,
  baseRevision: BASE,
  changes: [{ dataset: 'places', recordId: '42', field: 'name', before: 'Старое', after: 'Новое' }],
};
const body = contract.renderPropertyIssueBody(contract.readPacket(packet));
const fingerprint = 'c'.repeat(64);
const title = contract.propertyIssueTitle(fingerprint);
const input = { title, body, requestId: REQUEST_ID };

const repoPayload = { id: 1421259694, full_name: contract.PROPERTY_REPOSITORY, private: false };
const issuePayload = (overrides = {}) => ({
  id: 9001,
  number: 501,
  title,
  body,
  html_url: `https://github.com/${contract.PROPERTY_REPOSITORY}/issues/501`,
  ...overrides,
});

/** Фиктивный API: журнал запросов + настраиваемые ответы по маршруту. */
function makeApi(handlers) {
  const calls = [];
  const transport = async (url, init) => {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    calls.push({
      method,
      path: parsed.pathname,
      query: parsed.search,
      headers: init?.headers ?? {},
      body: init?.body ?? null,
      redirect: init?.redirect,
    });
    const handler = handlers[`${method} ${parsed.pathname}`] ?? handlers.defaultEndoint;
    if (!handler) return new Response('not found', { status: 404 });
    return handler({ url: parsed, init, calls });
  };
  return { calls, transport };
}
const okRepo = ({ url }) => url.pathname.endsWith('/repos/' + contract.PROPERTY_REPOSITORY)
  ? Response.json(repoPayload)
  : null;

test('успешная отправка: проверка репозитория по ID, поиск, один POST', async () => {
  const created = [];
  const { calls, transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([
      { ...issuePayload(), number: 500, body: 'обычная заявка без маркера', title: 'Что-то ещё' },
    ]),
    'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': ({ init }) => {
      created.push(JSON.parse(init.body));
      return Response.json(issuePayload(), { status: 201 });
    },
  });
  const result = await createRequestIssue(TOKEN, { apiBase: API }, input, transport);
  assert.deepEqual(result, {
    status: 'created',
    issue: { id: 9001, number: 501, title, htmlUrl: issuePayload().html_url },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].title, title);
  assert.equal(created[0].body, body);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'POST']);
  for (const call of calls) {
    assert.equal(call.redirect, 'manual');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.stringify(call).includes('?access_token'), false);
  }
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test('повторная попытка не создаёт второй Issue: найденная заявка возвращается как exists', async () => {
  let posts = 0;
  const { transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([issuePayload()]),
    'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => { posts++; return Response.json(issuePayload({ number: 777 }), { status: 201 }); },
  });
  const result = await createRequestIssue(TOKEN, { apiBase: API }, input, transport);
  assert.equal(result.status, 'exists');
  assert.equal(result.issue.number, 501);
  assert.equal(posts, 0);
});

test('поиск: маркер в заголовке, точный ID в теле, pull request не считается заявкой', async () => {
  const listed = [
    issuePayload({ number: 1, body: body.replace(REQUEST_ID, 'pr-другой-000000000000000000000000') }),
    { ...issuePayload({ number: 2 }), pull_request: { url: 'x' } },
    issuePayload({ number: 3 }),
    issuePayload({ number: 4 }),
  ];
  const { transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json(listed),
  });
  const found = await findRequestIssue(TOKEN, { apiBase: API }, REQUEST_ID, transport);
  assert.deepEqual(found, { status: 'found', issue: { id: 9001, number: 3, title, htmlUrl: issuePayload().html_url } });
  for (const status of [401, 403, 404]) {
    const { transport: denied } = makeApi({
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => new Response('', { status }),
    });
    assert.deepEqual(await findRequestIssue(TOKEN, { apiBase: API }, REQUEST_ID, denied), { status: 'unavailable' }, `поиск ${status}`);
  }
});

test('неизвестный результат не превращается в «нет»: 5xx, 3xx, таймаут, мусор — unavailable', async () => {
  const failures = [
    () => new Response('', { status: 502 }),
    () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }),
    () => new Response('', { status: 429 }),
    () => new Response('не json', { status: 200 }),
    () => Response.json({ message: 'rate limit' }),
    () => { throw new TypeError('network down'); },
  ];
  for (const fail of failures) {
    const { transport, calls } = makeApi({
      defaultEndoint: fail,
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': fail,
    });
    const result = await createRequestIssue(TOKEN, { apiBase: API }, input, transport);
    assert.equal(result.status, 'unavailable', result.status);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0, 'без поиска создания быть не должно');
  }
});

test('создание с неизвестным исходом: 5xx не считается отказом, но и не успехом', async () => {
  for (const status of [500, 502, 429, 302]) {
    const { transport } = makeApi({
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([]),
      'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => status === 302
        ? new Response(null, { status, headers: { location: 'https://example.com' } })
        : new Response('', { status }),
    });
    assert.deepEqual(await createRequestIssue(TOKEN, { apiBase: API }, input, transport), { status: 'unavailable' }, String(status));
  }
});

test('созданная заявка с другим телом или заголовком не подтверждается', async () => {
  for (const tampered of [{ body: `${body}\nлишнее` }, { title: `${title} (изменено)` }, { number: 0 }, { html_url: 'http://evil.example/1' }]) {
    const { transport } = makeApi({
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([]),
      'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json(issuePayload(tampered), { status: 201 }),
    });
    assert.deepEqual(await createRequestIssue(TOKEN, { apiBase: API }, input, transport), { status: 'unavailable' }, JSON.stringify(tampered));
  }
});

test('чужой репозиторий и отказ API — rejected без создания', async () => {
  const { calls, transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json({ ...repoPayload, id: 1 }),
    defaultEndoint: () => Response.json(issuePayload(), { status: 201 }),
  });
  assert.deepEqual(await createRequestIssue(TOKEN, { apiBase: API }, input, transport), { status: 'rejected' });
  assert.equal(calls.some((call) => call.method === 'POST'), false);

  for (const status of [401, 403, 404, 422]) {
    const { transport: t } = makeApi({
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
      'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([]),
      'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => new Response('', { status }),
    });
    assert.deepEqual(await createRequestIssue(TOKEN, { apiBase: API }, input, t), { status: 'rejected' }, String(status));
  }
});

test('некорректный вход отклоняется до сети: токен, запрос, заголовок, тело', async () => {
  let requests = 0;
  const transport = async () => { requests++; return Response.json(issuePayload(), { status: 201 }); };
  const invalid = [
    ['', {}, input],
    ['плохой токен\n', {}, input],
    [TOKEN, { apiBase: 'http://github.example' }, input],
    [TOKEN, { apiBase: 'https://github.com/?x=1' }, input],
    [TOKEN, {}, { ...input, title: 'без маркера' }],
    [TOKEN, {}, { ...input, title: `${title}`.slice(0, 3) }],
    [TOKEN, {}, { ...input, requestId: 'short' }],
    [TOKEN, {}, { ...input, body: body.replace('"before": "Старое"', '"before":  "Старое"') }],
    [TOKEN, {}, { ...input, body: body.replace(REQUEST_ID, 'pr-abc12345-ffffffffffffffffffffffffffff') }],
    [TOKEN, {}, { ...input, body: '' }],
  ];
  for (const [token, config, value] of invalid) {
    assert.deepEqual(await createRequestIssue(token, config, value, transport), { status: 'invalid' }, JSON.stringify({ token, config }));
  }
  assert.equal(requests, 0);
  assert.equal(issuesConfigValid(TOKEN, { apiBase: 'http://127.0.0.1:4180' }), true);
  assert.equal(issuesConfigValid(TOKEN, { apiBase: 'https://api.github.com' }), true);
  assert.equal(issuesConfigValid(TOKEN, { apiBase: 'http://[::1]' }), false);
});

test('пустой список Issue — достоверное «нет»; сбой списка — unavailable, POST не выполняется', async () => {
  let posts = 0;
  const { transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => new Response('', { status: 500 }),
    'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => { posts++; return Response.json(issuePayload(), { status: 201 }); },
  });
  assert.deepEqual(await createRequestIssue(TOKEN, { apiBase: API }, input, transport), { status: 'unavailable' });
  assert.equal(posts, 0);
  const { transport: ok } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io': () => Response.json(repoPayload),
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([]),
    'POST /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json(issuePayload(), { status: 201 }),
  });
  assert.equal((await createRequestIssue(TOKEN, { apiBase: API }, input, ok)).status, 'created');
});

test('запрос поиска ограничен первой страницей и сортировкой по созданию', async () => {
  const { calls, transport } = makeApi({
    'GET /repos/Timeline-Project-SC2/Timeline-Project-SC2.github.io/issues': () => Response.json([]),
  });
  await findRequestIssue(TOKEN, { apiBase: API }, REQUEST_ID, transport);
  const query = new URLSearchParams(calls[0].query);
  assert.equal(query.get('state'), 'all');
  assert.equal(query.get('per_page'), String(contract.PROPERTY_LIST_PER_PAGE));
  assert.equal(query.get('sort'), 'created');
  assert.equal(query.get('direction'), 'desc');
  assert.equal(calls.length, 1, 'пагинации нет: отсутствие в первой странице — не «нет»? проверено отдельно');
});
