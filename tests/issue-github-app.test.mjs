// Токен установки GitHub App: RS256, сужение до одного приватного репозитория,
// отказ без утечки ключа. Сеть заменена транспортом; живой GitHub не вызывается.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, createVerify } from 'node:crypto';

const require = createRequire(import.meta.url);
const { appJwt, privateKeyPkcs8, installationConfigValid, createInstallationToken } = require('../src/issue-gateway/github-app.ts');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const { privateKey: pkcs1 } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const TARGET = { id: 987654321, fullName: 'Timeline-Project-SC2/property-requests' };
const CONFIG = { clientId: 'Iv1.testclient', installationId: '123456', privateKey, target: TARGET, apiBase: 'http://127.0.0.1:4180' };
const NOW = Date.parse('2026-11-13T10:00:00.000Z');
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (part) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('JWT подписан RS256, срок короткий, issuer — Client ID', async () => {
  const jwt = await appJwt(CONFIG.clientId, privateKey, NOW);
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
  const claims = decode(payload);
  assert.equal(claims.iss, CONFIG.clientId);
  assert.equal(claims.iat, Math.floor(NOW / 1000) - 60);
  assert.equal(claims.exp, Math.floor(NOW / 1000) + 300);
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')), true);
});

test('PKCS#1 и PKCS#8 принимаются, мусор отклоняется', async () => {
  assert.ok(privateKeyPkcs8(privateKey).length > 0);
  assert.ok(privateKeyPkcs8(pkcs1).length > 0);
  for (const bad of ['', '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----', 'not a key']) assert.throws(() => privateKeyPkcs8(bad), TypeError);
  await assert.rejects(() => appJwt(CONFIG.clientId, 'bad', NOW), TypeError);
});

test('конфигурация требует Client ID, installation ID, цель и допустимый API', () => {
  assert.equal(installationConfigValid(CONFIG), true);
  for (const patch of [{ clientId: '' }, { installationId: '0' }, { installationId: 'x' }, { target: { id: 0, fullName: TARGET.fullName } }, { apiBase: 'http://github.example' }, { apiBase: 'https://api.github.com/path' }]) {
    assert.equal(installationConfigValid({ ...CONFIG, ...patch }), false);
  }
});

function transportWith(payload, { appStatus = 200, tokenStatus = 201, app = { client_id: CONFIG.clientId, slug: 'timeline-requests' } } = {}) {
  const calls = [];
  const transport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/app')) return Response.json(app, { status: appStatus });
    if (url.endsWith('/access_tokens')) return Response.json(payload, { status: tokenStatus });
    return new Response('', { status: 404 });
  };
  return { calls, transport };
}
const readyPayload = () => ({ token: 'ghs_mock_installation_never_leak', expires_at: new Date(NOW + 3600_000).toISOString(), repository_selection: 'selected',
  repositories: [{ id: TARGET.id, full_name: TARGET.fullName, private: true }], permissions: { issues: 'write' } });

test('успех: токен сужен до репозитория и Issues write, бот определён по slug', async () => {
  const { calls, transport } = transportWith(readyPayload());
  const result = await createInstallationToken(CONFIG, transport, NOW);
  assert.equal(result.status, 'ready');
  assert.equal(result.botLogin, 'timeline-requests[bot]');
  assert.equal(result.token, 'ghs_mock_installation_never_leak');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:4180/app');
  assert.equal(calls[1].url, 'http://127.0.0.1:4180/app/installations/123456/access_tokens');
  assert.deepEqual(JSON.parse(calls[1].init.body), { repositories: ['property-requests'], repository_ids: [TARGET.id], permissions: { issues: 'write' } });
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(JSON.stringify(result).includes(privateKey), false);
});

test('лишние права, чужой или публичный репозиторий, долгий срок — отказ', async () => {
  const cases = [
    { ...readyPayload(), permissions: { issues: 'write', contents: 'write' } },
    { ...readyPayload(), repository_selection: 'all' },
    { ...readyPayload(), repositories: [{ id: 1, full_name: TARGET.fullName, private: true }] },
    { ...readyPayload(), repositories: [{ id: TARGET.id, full_name: TARGET.fullName, private: false }] },
    { ...readyPayload(), expires_at: new Date(NOW + 7200_000).toISOString() },
    { ...readyPayload(), expires_at: new Date(NOW + 10_000).toISOString() },
    { ...readyPayload(), token: 'bad token' },
  ];
  for (const payload of cases) {
    const { transport } = transportWith(payload);
    assert.deepEqual(await createInstallationToken(CONFIG, transport, NOW), { status: 'rejected' });
  }
});

test('неизвестный результат не считается отказом: 5xx, 3xx, 429, сеть, мусор', async () => {
  for (const status of [500, 302, 429]) {
    const { transport } = transportWith(readyPayload(), { tokenStatus: status });
    assert.deepEqual(await createInstallationToken(CONFIG, transport, NOW), { status: 'unavailable' });
  }
  const down = async () => { throw new TypeError('offline'); };
  assert.deepEqual(await createInstallationToken(CONFIG, down, NOW), { status: 'unavailable' });
  const garbage = async (url) => url.endsWith('/app') ? Response.json({ client_id: CONFIG.clientId, slug: 'timeline-requests' }) : new Response('not json', { status: 201 });
  assert.deepEqual(await createInstallationToken(CONFIG, garbage, NOW), { status: 'unavailable' });
});

test('неверный Client ID или отказ GitHub не раскрывают ключ', async () => {
  const { transport } = transportWith(readyPayload(), { app: { client_id: 'other', slug: 'timeline-requests' } });
  assert.deepEqual(await createInstallationToken(CONFIG, transport, NOW), { status: 'rejected' });
  const denied = transportWith(readyPayload(), { tokenStatus: 403 });
  const result = await createInstallationToken(CONFIG, denied.transport, NOW);
  assert.deepEqual(result, { status: 'rejected' });
  assert.equal(JSON.stringify(result).includes(privateKey), false);
});
