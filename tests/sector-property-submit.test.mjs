// Клиент приватного шлюза: подмена fetch, без сети и DOM.
// «Неизвестно» не превращается в «создано»; шлюз — только абсолютный https другого сайта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preparePropertySubmission, submitPropertyPacket, readMyRequests, readGatewayUrl, SUBMIT_MESSAGES } = require('../src/atlas/sector-property-submit.ts');
const GATEWAY = 'https://gateway.test';
const ORIGIN = 'https://timeline-project-sc2.github.io';
const draft = { type: 'sector-property-request-draft', version: 2, requestId: 'pr-abc12345-00112233445566778899aabbccddeeff',
  threadId: 'pr-abc12345-00112233445566778899aabbccddeeff', baseRevision: 'a'.repeat(64),
  changes: [{ dataset: 'systems', recordId: '1', field: 'name', before: 'Старое', after: 'Новое' }] };
const prepared = { status: 'prepared', requestId: draft.requestId, threadId: draft.threadId, title: '[ADM-ACCESS] свойства точек · abcdefabcdef', body: 'тело', fingerprint: 'b'.repeat(64) };
function recorder(respond) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); };
  return { calls, fetch };
}
const env = (fetch) => ({ gatewayUrl: GATEWAY, origin: ORIGIN, fetch });

test('подготовка: один POST черновика с cookie, без токена и авторства от браузера', async () => {
  const { calls, fetch } = recorder(() => Response.json(prepared));
  assert.deepEqual(await preparePropertySubmission(draft, env(fetch)), prepared);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gateway.test/issues/prepare');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0].init.body), { draft });
});

test('отправка: только requestId и отпечаток просмотренного серверного текста', async () => {
  const { calls, fetch } = recorder(() => Response.json({ status: 'created', number: 42 }, { status: 201 }));
  assert.deepEqual(await submitPropertyPacket({ requestId: draft.requestId, fingerprint: prepared.fingerprint }, env(fetch)), { status: 'created', number: 42 });
  assert.equal(calls[0].url, 'https://gateway.test/issues/submit');
  assert.deepEqual(JSON.parse(calls[0].init.body), { requestId: draft.requestId, fingerprint: prepared.fingerprint });
});

test('повтор идемпотен: existing переносится как есть', async () => {
  const { fetch } = recorder(() => Response.json({ status: 'existing', number: 42 }));
  assert.deepEqual(await submitPropertyPacket({ requestId: draft.requestId, fingerprint: prepared.fingerprint }, env(fetch)), { status: 'existing', number: 42 });
});

test('неизвестный результат остаётся неизвестным: 5xx, 3xx, таймаут, мусор, рассинхрон кода и статуса', async () => {
  const responders = [
    () => new Response('', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://gateway.test/' } }),
    () => { throw new TypeError('offline'); },
    () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ status: 'created' }, { status: 201 }),
    () => Response.json({ status: 'created', number: 0 }, { status: 201 }),
    () => Response.json({ status: 'existing', number: 42 }, { status: 201 }),
    () => Response.json({ status: 'created', number: 42 }, { status: 200 }),
  ];
  for (const respond of responders) {
    const { fetch } = recorder(respond);
    assert.deepEqual(await submitPropertyPacket({ requestId: draft.requestId, fingerprint: prepared.fingerprint }, env(fetch)), { status: 'unavailable' });
  }
});

test('отказы различаются: 401 вход, 403 отказ, 400 формат, 429 лимит, 409 закрытая нить', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'rejected'], [400, 'invalid'], [429, 'limit'], [409, 'closed'], [404, 'unavailable'], [500, 'unavailable']]) {
    const { fetch } = recorder(() => new Response('', { status }));
    assert.deepEqual(await submitPropertyPacket({ requestId: draft.requestId, fingerprint: prepared.fingerprint }, env(fetch)), { status: expected }, String(status));
  }
  const { fetch } = recorder(() => Response.json({ error: 'disabled' }, { status: 503 }));
  assert.deepEqual(await submitPropertyPacket({ requestId: draft.requestId, fingerprint: prepared.fingerprint }, env(fetch)), { status: 'disabled' });
});

test('без настроенного шлюза сеть не вызывается', async () => {
  for (const gatewayUrl of [null, '', 'не url', 'http://gateway.test', 'https://gateway.test/auth', '/issues/submit']) {
    const { calls, fetch } = recorder(() => Response.json(prepared));
    assert.deepEqual(await preparePropertySubmission(draft, { gatewayUrl, origin: ORIGIN, fetch }), { status: 'disabled' });
    assert.equal(calls.length, 0);
  }
  const { calls, fetch } = recorder(() => Response.json(prepared));
  assert.equal((await preparePropertySubmission(draft, { gatewayUrl: 'https://gateway.test/', origin: ORIGIN, fetch })).status, 'prepared');
  assert.equal(calls.length, 1);
});

test('тег шлюза заполняется сборкой: только абсолютный https без пути', async () => {
  const { gatewayOrigin } = await import('../tools/vite/atlas-shell.ts');
  assert.equal(gatewayOrigin('https://gateway.test'), 'https://gateway.test');
  assert.equal(gatewayOrigin(' https://gateway.test/ '), 'https://gateway.test');
  for (const bad of ['', undefined, 'http://gateway.test', 'https://gateway.test/auth', 'https://user:pass@gateway.test', 'https://gateway.test/?x=1']) assert.equal(gatewayOrigin(bad), null);
  const meta = (content) => ({ getAttribute: () => content });
  assert.equal(readGatewayUrl(meta('https://gateway.test')), 'https://gateway.test');
  assert.equal(readGatewayUrl(meta('https://gateway.test/')), 'https://gateway.test');
  for (const bad of ['  ', 'http://gateway.test', '/issues/submit', 'javascript:alert(1)', 'https://gateway.test/auth']) assert.equal(readGatewayUrl(meta(bad)), null);
  assert.equal(readGatewayUrl(null), null);
});

test('шлюз на самом сайте не используется: иначе cookie ушла бы не туда', async () => {
  const { calls, fetch } = recorder(() => Response.json(prepared));
  assert.deepEqual(await preparePropertySubmission(draft, { gatewayUrl: ORIGIN, origin: ORIGIN, fetch }), { status: 'disabled' });
  assert.equal(calls.length, 0);
});

test('мои заявки: только свой список, курсор и лимит; чужие поля не принимаются', async () => {
  const list = { requests: [{ requestId: draft.requestId, threadId: draft.threadId, number: 42, createdAt: '2026-11-13T10:00:00.000Z', updatedAt: 10, status: 'created', issueState: 'open', changes: draft.changes }], hasMore: false, openLimit: 5 };
  const { calls, fetch } = recorder(() => Response.json(list));
  assert.deepEqual(await readMyRequests(env(fetch), 123), { status: 'ready', ...list });
  assert.equal(calls[0].url, 'https://gateway.test/issues/mine?before=123');
  assert.equal(calls[0].init.method, 'GET');
  const { fetch: bad } = recorder(() => Response.json({ ...list, requests: [{ ...list.requests[0], userId: 99 }] }));
  assert.deepEqual(await readMyRequests(env(bad)), { status: 'unavailable' });
});

test('сообщения не обещают применения и публикации', () => {
  assert.match(SUBMIT_MESSAGES.created, /не применение/);
  assert.match(SUBMIT_MESSAGES.unavailable, /Не отправляйте новую/);
  for (const message of Object.values(SUBMIT_MESSAGES)) assert.equal(/опубликован[оа]?\b(?!.*не)/.test(message), false, message);
});
