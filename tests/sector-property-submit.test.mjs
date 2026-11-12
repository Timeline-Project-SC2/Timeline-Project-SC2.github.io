// Клиент отправки заявки: подмена fetch, без сети, без DOM.
// Проверяется, что «неизвестно» не превращается в «создано», а шлюз
// настраивается только абсолютным https-адресом другого сайта.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { submitPropertyPacket, readGatewayUrl, SUBMIT_MESSAGES } = require('../src/atlas/sector-property-submit.ts');

const GATEWAY = 'https://gateway.test';
const ORIGIN = 'https://timeline-project-sc2.github.io';
const packet = { title: '[ADM-ACCESS] свойства точек · abcdefabcdef', body: 'тело', requestId: 'pr-abc12345-00112233445566778899aabbccddeeff' };

function recorder(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { calls, fetch };
}
const env = (fetch) => ({ gatewayUrl: GATEWAY, origin: ORIGIN, fetch });

test('создание: один POST с cookie, JSON и без токена', async () => {
  const { calls, fetch } = recorder(() => Response.json({ status: 'created', number: 42, url: 'https://github.com/o/r/issues/42' }, { status: 201 }));
  const outcome = await submitPropertyPacket(packet, env(fetch));
  assert.deepEqual(outcome, { status: 'created', number: 42, url: 'https://github.com/o/r/issues/42' });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, 'https://gateway.test/issues/submit');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.equal(init.mode, 'cors');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(init.body), packet);
});

test('повтор идемпотентен: existing переносится как есть', async () => {
  const { fetch } = recorder(() => Response.json({ status: 'existing', number: 42, url: 'https://github.com/o/r/issues/42' }, { status: 200 }));
  assert.deepEqual(await submitPropertyPacket(packet, env(fetch)), { status: 'existing', number: 42, url: 'https://github.com/o/r/issues/42' });
});

test('неизвестный результат остаётся неизвестным: 5xx, 3xx, таймаут, мусор, рассинхрон кода и статуса', async () => {
  const responders = [
    () => new Response('', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://gateway.test/' } }),
    () => { throw new TypeError('offline'); },
    () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => Response.json({ status: 'created' }, { status: 201 }),
    () => Response.json({ status: 'created', number: 0, url: 'https://github.com/o/r/issues/0' }, { status: 201 }),
    () => Response.json({ status: 'created', number: 42, url: 'http://evil.example/42' }, { status: 201 }),
    () => Response.json({ status: 'existing', number: 42, url: 'https://github.com/o/r/issues/42' }, { status: 201 }),
    () => Response.json({ status: 'created', number: 42, url: 'https://github.com/o/r/issues/42' }, { status: 200 }),
  ];
  for (const respond of responders) {
    const { fetch } = recorder(respond);
    assert.deepEqual(await submitPropertyPacket(packet, env(fetch)), { status: 'unavailable' });
  }
});

test('отказы различаются: 401 вход, 403 отказ, 400 формат', async () => {
  const cases = [[401, 'unauthorized'], [403, 'rejected'], [400, 'invalid'], [404, 'unavailable'], [500, 'unavailable']];
  for (const [status, expected] of cases) {
    const { fetch } = recorder(() => new Response('', { status }));
    assert.deepEqual(await submitPropertyPacket(packet, env(fetch)), { status: expected }, String(status));
  }
});

test('без настроенного шлюза отправка не выполняется и сеть не вызывается', async () => {
  for (const gatewayUrl of [null, '', 'не url', 'http://gateway.test', 'https://gateway.test/', '/issues/submit']) {
    const { calls, fetch } = recorder(() => Response.json({ status: 'created', number: 1, url: 'https://github.com/o/r/issues/1' }, { status: 201 }));
    const outcome = await submitPropertyPacket(packet, { gatewayUrl, origin: ORIGIN, fetch });
    if (gatewayUrl === 'https://gateway.test/') assert.equal(outcome.status, 'created');
    else assert.deepEqual(outcome, { status: 'disabled' }, String(gatewayUrl));
    assert.equal(calls.length, gatewayUrl === 'https://gateway.test/' ? 1 : 0);
  }
});

test('тег шлюза заполняется сборкой: только абсолютный https, иначе «выключено»', async () => {
  const { gatewayOrigin } = await import('../tools/vite/atlas-shell.ts');
  assert.equal(gatewayOrigin('https://gateway.test'), 'https://gateway.test');
  assert.equal(gatewayOrigin(' https://gateway.test/ '), 'https://gateway.test');
  assert.equal(gatewayOrigin(''), null);
  assert.equal(gatewayOrigin(undefined), null);
  for (const bad of ['http://gateway.test', 'https://gateway.test/auth', 'https://user:pass@gateway.test',
    'https://gateway.test/?x=1', 'https://gateway.test/#x', 'название']) {
    assert.equal(gatewayOrigin(bad), null, bad);
  }
});

test('шлюз на самом сайте не используется: иначе cookie ушла бы не туда', async () => {
  const { calls, fetch } = recorder(() => Response.json({ status: 'created' }, { status: 201 }));
  assert.deepEqual(await submitPropertyPacket(packet, { gatewayUrl: ORIGIN, origin: ORIGIN, fetch }), { status: 'disabled' });
  assert.equal(calls.length, 0);
});

test('адрес шлюза из шаблона: только абсолютный https', () => {
  const meta = (content) => ({ getAttribute: () => content });
  assert.equal(readGatewayUrl(meta('https://gateway.test')), 'https://gateway.test');
  assert.equal(readGatewayUrl(meta('https://gateway.test/')), 'https://gateway.test');
  assert.equal(readGatewayUrl(meta('  ')), null);
  assert.equal(readGatewayUrl(meta('http://gateway.test')), null);
  assert.equal(readGatewayUrl(meta('/issues/submit')), null);
  assert.equal(readGatewayUrl(meta('javascript:alert(1)')), null);
  assert.equal(readGatewayUrl(null), null);
});

test('сообщения не обещают применения и публикации', () => {
  assert.match(SUBMIT_MESSAGES.created, /не применение/);
  assert.match(SUBMIT_MESSAGES.unavailable, /Не отправляйте новую/);
  for (const message of Object.values(SUBMIT_MESSAGES)) assert.equal(/опубликован[оа]?\b(?!.*не)/.test(message), false, message);
});
