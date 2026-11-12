import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const { OAuthSqlStore } = createRequire(import.meta.url)('../src/issue-gateway/oauth-sql-store.ts');
const { beginOAuthFlow, consumeOAuthState, OAUTH_STATE_TTL_MS } = createRequire(import.meta.url)('../src/issue-gateway/oauth-state.ts');

// Реальный SQLite, но не Cloudflare runtime: адаптация интерфейса курсора.
function open() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...bindings) {
    const statement = db.prepare(query);
    if (/RETURNING/i.test(query)) {
      const rows = statement.all(...bindings);
      const { changes } = db.prepare('SELECT changes() AS changes').get();
      return Object.assign(rows, { rowsWritten: changes });
    }
    const { changes } = statement.run(...bindings);
    return Object.assign([], { rowsWritten: changes });
  } };
  return { db, store: new OAuthSqlStore(sql) };
}
const token = Buffer.alloc(32, 1).toString('base64url');

test('SQLite сохраняет PKCE и атомарно допускает только одного потребителя', async () => {
  const { db, store } = open();
  try {
    const started = await beginOAuthFlow(store, webcrypto, token, 100);
    assert.equal(started.status, 'started');
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeOAuthState(store, webcrypto, started.state, token, 101)));
    assert.equal(results.filter((item) => item.status === 'accepted').length, 1);
    assert.equal(results.filter((item) => item.status === 'invalid').length, 19);
  } finally { db.close(); }
});

test('коллизия не перезаписывает состояние, очищаются только истёкшие и не более лимита', async () => {
  const { db, store } = open();
  try {
    const value = { verifier: token, bindingHash: token, expiresAt: 100 };
    assert.equal(await store.putIfAbsent('a', value), true);
    assert.equal(await store.putIfAbsent('a', { ...value, expiresAt: 200 }), false);
    assert.equal(await store.putIfAbsent('b', value), true);
    assert.equal(await store.putIfAbsent('c', { ...value, expiresAt: 101 }), true);
    assert.equal(await store.deleteExpired(100, 1), 1);
    assert.equal(await store.deleteExpired(100, 10), 1);
    assert.equal(await store.deleteExpired(100, 10), 0);
    assert.deepEqual(await store.take('c'), { ...value, expiresAt: 101 });
    await assert.rejects(store.deleteExpired(100, 1001));
  } finally { db.close(); }
});

test('истёкший state не принимается даже до фоновой очистки', async () => {
  const { db, store } = open();
  try {
    const started = await beginOAuthFlow(store, webcrypto, token, 1);
    assert.deepEqual(await consumeOAuthState(store, webcrypto, started.state, token, 1 + OAUTH_STATE_TTL_MS), { status: 'invalid' });
    assert.equal(await store.deleteExpired(1 + OAUTH_STATE_TTL_MS, 10), 0);
  } finally { db.close(); }
});
