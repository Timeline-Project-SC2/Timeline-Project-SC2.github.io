/* Durable Object одноразового состояния issue-шлюза.
 *
 * Единый экземпляр (имя 'main') для всех потоков входа: каждая операция
 * проходит через одну SQLite с одним писателем. Именно это гарантирует,
 * что одноразовый state выдан ровно одному запросу даже при параллельных
 * вызовах. Обычный KV (eventual consistency) для этого не подходит.
 *
 * Разделение ролей: DO — чистый атомарный хранилищный слой (только SQL),
 * вся gateway-логика (beginOAuthFlow/consumeOAuthState, генерация
 * state/PKCE, SHA-256) выполняется HTTP-слоем Worker'а и ходит к DO по
 * внутренней HTTP-шине (stub.fetch). Шина проверена параллельной нагрузкой;
 * внешняя поверхность DO сводится к fetch() — в этой связке
 * (workerd 1.20260730 / miniflare 4.20260730) внешний RPC к методу DO,
 * названному scheduled(), даёт внутреннюю ошибку рантайма, поэтому таких
 * методов у объекта нет (cron дёргает scheduled() самого Worker'а).
 *
 * Правило SQLite: курсор RETURNING всегда полностью потребляется
 * (rowsOf), иначе транзакция не коммитится (SQLITE_BUSY).
 */
import { DurableObject } from 'cloudflare:workers';
import type { PendingOAuth } from '../../src/issue-gateway/oauth-state.ts';

import type { DurableObjectCtx, DurableObjectSql } from 'cloudflare:workers';

export interface SessionRecord {
  readonly accessToken: string;
  readonly userId: number;
  readonly login: string;
  readonly expiresAt: number;
}

/** Форма стаба для HTTP-слоя и тестов: только внутренняя HTTP-шина. */
export interface OAuthStateStub {
  fetch(request: Request): Promise<Response>;
}

interface RuntimeSqlCursor { [Symbol.iterator](): Iterator<Record<string, unknown>>; }

const PENDING_TABLE = `CREATE TABLE IF NOT EXISTS pending_oauth (
  key TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const SESSIONS_TABLE = `CREATE TABLE IF NOT EXISTS oauth_sessions (
  session_hash TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const CLEANUP_LIMIT = 100;

function rowsOf(cursor: RuntimeSqlCursor | undefined): Record<string, unknown>[] {
  if (!cursor) return [];
  const rows: Record<string, unknown>[] = [];
  for (const row of cursor) rows.push(row);
  return rows;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* Модульные (не методы класса): вне любой внешней поверхности. */

/** Атомарное создание: RETURNING отдаёт строку только при реальной вставке. */
function insertPending(sql: DurableObjectSql, key: string, value: PendingOAuth): boolean {
  const cursor = sql.exec(
    'INSERT INTO pending_oauth (key, verifier, binding_hash, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING RETURNING key',
    key, value.verifier, value.bindingHash, value.expiresAt,
  );
  return rowsOf(cursor).length === 1;
}

/** Атомарное извлечение: чтение и удаление одной SQL-командой. */
function takePending(sql: DurableObjectSql, key: string): PendingOAuth | null {
  const rows = rowsOf(sql.exec(
    'DELETE FROM pending_oauth WHERE key = ? RETURNING verifier, binding_hash, expires_at', key,
  ));
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (typeof row.verifier !== 'string' || typeof row.binding_hash !== 'string' || typeof row.expires_at !== 'number') {
    throw new Error('invalid stored state');
  }
  return { verifier: row.verifier, bindingHash: row.binding_hash, expiresAt: row.expires_at };
}

export class OAuthState extends DurableObject {
  private readonly sql: DurableObjectSql;
  private readonly env: unknown;

  constructor(ctx: DurableObjectCtx, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.env = env;
    this.sql.exec(PENDING_TABLE);
    this.sql.exec(SESSIONS_TABLE);
  }

  /** Тестовая имитация отказа хранилища; в развёртывании не задаётся. */
  private assertStorage(): void {
    const env = this.env as { FAIL_STORAGE?: unknown } | null;
    if (env && env.FAIL_STORAGE === '1') throw new Error('storage unavailable');
  }

  private readBody(request: Request): Promise<Record<string, unknown>> {
    return request.json().then(
      (value: unknown) => (value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : Promise.reject(new Error('bad body'))),
      () => Promise.reject(new Error('bad body')),
    );
  }

  /** Внутренняя HTTP-шина: только для HTTP-слоя Worker'а (stub.fetch). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/store-put' && request.method === 'POST') {
        this.assertStorage();
        let body: Record<string, unknown>;
        try { body = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (typeof body.key !== 'string' || typeof body.verifier !== 'string' ||
            typeof body.bindingHash !== 'string' || !Number.isSafeInteger(body.expiresAt)) {
          return json({ error: 'bad_request' }, 400);
        }
        const added = insertPending(this.sql, body.key, {
          verifier: body.verifier,
          bindingHash: body.bindingHash,
          expiresAt: body.expiresAt,
        });
        return json({ added });
      }
      if (url.pathname === '/store-take' && request.method === 'POST') {
        this.assertStorage();
        let body: Record<string, unknown>;
        try { body = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (typeof body.key !== 'string') return json({ error: 'bad_request' }, 400);
        const pending = takePending(this.sql, body.key);
        return json({ pending });
      }
      if (url.pathname === '/session-create' && request.method === 'POST') {
        this.assertStorage();
        let body: Record<string, unknown>;
        try { body = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (typeof body.sessionHash !== 'string' || typeof body.accessToken !== 'string' ||
            !Number.isSafeInteger(body.userId) || typeof body.login !== 'string' || !Number.isSafeInteger(body.expiresAt)) {
          return json({ error: 'bad_request' }, 400);
        }
        const cursor = this.sql.exec(
          'INSERT INTO oauth_sessions (session_hash, access_token, user_id, login, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_hash) DO NOTHING RETURNING session_hash',
          body.sessionHash, body.accessToken, body.userId, body.login, body.expiresAt,
        );
        return json({ created: rowsOf(cursor).length === 1 });
      }
      if (url.pathname === '/session-get' && request.method === 'GET') {
        this.assertStorage();
        const sessionHash = url.searchParams.get('hash');
        const nowParam = Number(url.searchParams.get('now'));
        if (!sessionHash || !Number.isSafeInteger(nowParam)) return json({ error: 'bad_request' }, 400);
        const rows = rowsOf(this.sql.exec(
          'SELECT access_token, user_id, login, expires_at FROM oauth_sessions WHERE session_hash = ? AND expires_at > ?',
          sessionHash, nowParam,
        ));
        if (rows.length !== 1) return json({ session: null });
        const row = rows[0]!;
        if (typeof row.access_token !== 'string' || typeof row.user_id !== 'number' ||
            !Number.isSafeInteger(row.user_id) || typeof row.login !== 'string' || typeof row.expires_at !== 'number') {
          throw new Error('invalid stored session');
        }
        const record: SessionRecord = {
          accessToken: row.access_token,
          userId: row.user_id,
          login: row.login,
          expiresAt: row.expires_at,
        };
        return json({ session: record });
      }
      if (url.pathname === '/session-delete' && request.method === 'POST') {
        this.assertStorage();
        let body: Record<string, unknown>;
        try { body = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (typeof body.sessionHash !== 'string') return json({ error: 'bad_request' }, 400);
        const rows = rowsOf(this.sql.exec(
          'DELETE FROM oauth_sessions WHERE session_hash = ? RETURNING session_hash', body.sessionHash,
        ));
        return json({ deleted: rows.length === 1 });
      }
      if (url.pathname === '/cleanup' && request.method === 'POST') {
        this.assertStorage();
        let body: Record<string, unknown>;
        try { body = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (!Number.isSafeInteger(body.now)) return json({ error: 'bad_request' }, 400);
        return json(await this.runCleanup(body.now as number));
      }
      return json({ error: 'not_found' }, 404);
    } catch {
      return json({ error: 'unavailable' }, 503);
    }
  }

  private async runCleanup(now: number): Promise<{ pending: number; sessions: number }> {
    this.assertStorage();
    const pending = rowsOf(this.sql.exec(
      'DELETE FROM pending_oauth WHERE key IN (SELECT key FROM pending_oauth WHERE expires_at <= ? ORDER BY expires_at LIMIT ?) RETURNING key',
      now, CLEANUP_LIMIT,
    )).length;
    const sessions = rowsOf(this.sql.exec(
      'DELETE FROM oauth_sessions WHERE session_hash IN (SELECT session_hash FROM oauth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?) RETURNING session_hash',
      now, CLEANUP_LIMIT,
    )).length;
    return { pending, sessions };
  }
}
