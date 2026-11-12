import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const { OAUTH_STATE_TTL_MS, beginOAuthFlow, consumeOAuthState } = createRequire(import.meta.url)('../src/issue-gateway/oauth-state.ts');

const token = (byte) => Buffer.alloc(32, byte).toString('base64url');
const hash = (text) => createHash('sha256').update(text).digest('base64url');
function store() {
  const values = new Map();
  return {
    values,
    async putIfAbsent(key, value) { if (values.has(key)) return false; values.set(key, value); return true; },
    async take(key) { const result = values.get(key) ?? null; values.delete(key); return result; },
  };
}

test('state и PKCE случайны, state хранится как хэш, verifier не выдаётся браузеру', async () => {
  const storage = store();
  const first = await beginOAuthFlow(storage, webcrypto, token(1), 1000);
  const second = await beginOAuthFlow(storage, webcrypto, token(1), 1000);
  assert.equal(first.status, 'started');
  assert.equal(second.status, 'started');
  assert.notEqual(first.state, second.state);
  assert.equal(first.state.length, 43);
  assert.equal(first.codeChallenge.length, 43);
  assert.equal(Object.hasOwn(first, 'verifier'), false);
  assert.equal(storage.values.has(first.state), false);
  const stored = storage.values.get(hash(first.state));
  assert.equal(stored.bindingHash, hash(token(1)));
  assert.equal(stored.expiresAt, 1000 + OAUTH_STATE_TTL_MS);
  assert.equal(first.codeChallenge, hash(stored.verifier));
});

test('state связан с браузером и может быть использован только один раз', async () => {
  const storage = store();
  const started = await beginOAuthFlow(storage, webcrypto, token(1), 10);
  const results = await Promise.all([
    consumeOAuthState(storage, webcrypto, started.state, token(1), 11),
    consumeOAuthState(storage, webcrypto, started.state, token(1), 11),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), ['accepted', 'invalid']);
  const accepted = results.find((item) => item.status === 'accepted');
  assert.equal(hash(accepted.verifier), started.codeChallenge);
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, started.state, token(1), 11), { status: 'invalid' });
});

test('другой браузер, истекший и неверный state отвергаются', async () => {
  const storage = store();
  const wrongBrowser = await beginOAuthFlow(storage, webcrypto, token(1), 10);
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, wrongBrowser.state, token(2), 11), { status: 'invalid' });
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, wrongBrowser.state, token(1), 11), { status: 'invalid' });
  const expired = await beginOAuthFlow(storage, webcrypto, token(1), 10);
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, expired.state, token(1), 10 + OAUTH_STATE_TTL_MS), { status: 'invalid' });
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, 'невалидно', token(1), 11), { status: 'invalid' });
  assert.deepEqual(await beginOAuthFlow(storage, webcrypto, 'невалидно', 10), { status: 'invalid' });
});

test('ошибки хранилища останавливают операцию без утечки исключения', async () => {
  const faulty = { async putIfAbsent() { throw Error('секретная деталь'); }, async take() { throw Error('секретная деталь'); } };
  assert.deepEqual(await beginOAuthFlow(faulty, webcrypto, token(1), 10), { status: 'unavailable' });
  assert.deepEqual(await consumeOAuthState(faulty, webcrypto, token(3), token(1), 10), { status: 'unavailable' });
});

test('невалидные часы и повреждённое состояние не разрешают вход', async () => {
  const storage = store();
  assert.deepEqual(await beginOAuthFlow(storage, webcrypto, token(1), -1), { status: 'invalid' });
  const started = await beginOAuthFlow(storage, webcrypto, token(1), 10);
  storage.values.set(hash(started.state), { verifier: token(2), bindingHash: hash(token(1)), expiresAt: 10 + OAUTH_STATE_TTL_MS + 1 });
  assert.deepEqual(await consumeOAuthState(storage, webcrypto, started.state, token(1), 10), { status: 'invalid' });
});

test('коллизия идентификатора не перезаписывает ожидающую сессию', async () => {
  const storage = store();
  const fixedCrypto = { subtle: webcrypto.subtle, getRandomValues(array) { array.fill(4); return array; } };
  const first = await beginOAuthFlow(storage, fixedCrypto, token(1), 10);
  assert.equal(first.status, 'started');
  const before = storage.values.get(hash(first.state));
  assert.deepEqual(await beginOAuthFlow(storage, fixedCrypto, token(2), 10), { status: 'unavailable' });
  assert.equal(storage.values.get(hash(first.state)), before);
});
