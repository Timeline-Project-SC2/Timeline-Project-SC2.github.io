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
const SESSIONS_TABLE = `CREATE TABLE IF NOT EXISTS identity_sessions (
  session_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`;
const CLEANUP_LIMIT = 100;
const REQUESTS_TABLE = `CREATE TABLE IF NOT EXISTS property_requests (
  repository_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  packet_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','reserved','created')),
  issue_number INTEGER,
  comment_id INTEGER,
  issue_state TEXT CHECK(issue_state IN ('open','closed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(repository_id, request_id)
)`;
const REQUEST_INDEX = 'CREATE INDEX IF NOT EXISTS property_requests_author ON property_requests(repository_id, user_id, updated_at DESC)';
export interface StoredPropertyRequest {
  readonly repositoryId: number; readonly requestId: string; readonly threadId: string;
  readonly userId: number; readonly login: string; readonly createdAt: string;
  readonly draftJson: string; readonly packetJson: string; readonly fingerprint: string;
  readonly status: 'prepared' | 'reserved' | 'created';
  readonly issueNumber: number | null; readonly commentId: number | null;
  readonly issueState: 'open' | 'closed' | null; readonly updatedAt: number;
}
function readRequest(row: Record<string, unknown>): StoredPropertyRequest {
  if (!Number.isSafeInteger(row.repository_id) || typeof row.request_id !== 'string' || typeof row.thread_id !== 'string' ||
    !Number.isSafeInteger(row.user_id) || typeof row.login !== 'string' || typeof row.created_at !== 'string' ||
    typeof row.draft_json !== 'string' || typeof row.packet_json !== 'string' || typeof row.fingerprint !== 'string' ||
    !['prepared','reserved','created'].includes(String(row.status)) ||
    !(row.issue_number === null || Number.isSafeInteger(row.issue_number)) ||
    !(row.comment_id === null || Number.isSafeInteger(row.comment_id)) ||
    !(row.issue_state === null || ['open','closed'].includes(String(row.issue_state))) || !Number.isSafeInteger(row.updated_at)) {
    throw new Error('invalid stored request');
  }
  return { repositoryId: row.repository_id as number, requestId: row.request_id, threadId: row.thread_id,
    userId: row.user_id as number, login: row.login, createdAt: row.created_at, draftJson: row.draft_json,
    packetJson: row.packet_json, fingerprint: row.fingerprint, status: row.status as StoredPropertyRequest['status'],
    issueNumber: row.issue_number as number | null, commentId: row.comment_id as number | null,
    issueState: row.issue_state as StoredPropertyRequest['issueState'], updatedAt: row.updated_at as number };
}

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
    // Старая таблица хранила токен пользователя. Удаляем её целиком: вход заново,
    // но секрет не остаётся в SQLite после перехода на identity-only сессии.
    this.sql.exec('DROP TABLE IF EXISTS oauth_sessions');
    this.sql.exec(REQUESTS_TABLE);
    this.sql.exec(REQUEST_INDEX);
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
        if (typeof body.sessionHash !== 'string' ||
            !Number.isSafeInteger(body.userId) || typeof body.login !== 'string' || !Number.isSafeInteger(body.expiresAt)) {
          return json({ error: 'bad_request' }, 400);
        }
        const cursor = this.sql.exec(
          'INSERT INTO identity_sessions (session_hash, user_id, login, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_hash) DO NOTHING RETURNING session_hash',
          body.sessionHash, body.userId, body.login, body.expiresAt,
        );
        return json({ created: rowsOf(cursor).length === 1 });
      }
      if (url.pathname === '/session-get' && request.method === 'GET') {
        this.assertStorage();
        const sessionHash = url.searchParams.get('hash');
        const nowParam = Number(url.searchParams.get('now'));
        if (!sessionHash || !Number.isSafeInteger(nowParam)) return json({ error: 'bad_request' }, 400);
        const rows = rowsOf(this.sql.exec(
          'SELECT user_id, login, expires_at FROM identity_sessions WHERE session_hash = ? AND expires_at > ?',
          sessionHash, nowParam,
        ));
        if (rows.length !== 1) return json({ session: null });
        const row = rows[0]!;
        if (typeof row.user_id !== 'number' ||
            !Number.isSafeInteger(row.user_id) || typeof row.login !== 'string' || typeof row.expires_at !== 'number') {
          throw new Error('invalid stored session');
        }
        const record: SessionRecord = {
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
          'DELETE FROM identity_sessions WHERE session_hash = ? RETURNING session_hash', body.sessionHash,
        ));
        return json({ deleted: rows.length === 1 });
      }
      if (url.pathname.startsWith('/request-') && request.method === 'POST') {
        this.assertStorage();
        let b: Record<string, unknown>;
        try { b = await this.readBody(request); } catch { return json({ error: 'bad_request' }, 400); }
        if (!Number.isSafeInteger(b.repositoryId) || !Number.isSafeInteger(b.userId)) return json({ error: 'bad_request' }, 400);
        const repo = b.repositoryId as number, user = b.userId as number;
        if (url.pathname === '/request-prepare') {
          if (typeof b.requestId !== 'string' || typeof b.threadId !== 'string' || typeof b.login !== 'string' ||
            typeof b.createdAt !== 'string' || typeof b.draftJson !== 'string' || typeof b.packetJson !== 'string' ||
            typeof b.fingerprint !== 'string' || !Number.isSafeInteger(b.now) || b.draftJson.length > 60000 || b.packetJson.length > 60000) return json({ error: 'bad_request' }, 400);
          const pending = rowsOf(this.sql.exec("SELECT COUNT(*) AS n FROM property_requests WHERE repository_id = ? AND user_id = ? AND status = 'prepared'", repo, user))[0]!.n as number;
          if (pending >= 100) return json({ error: 'limit' }, 429);
          rowsOf(this.sql.exec(`INSERT INTO property_requests
            (repository_id,request_id,thread_id,user_id,login,created_at,draft_json,packet_json,fingerprint,status,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,'prepared',?) ON CONFLICT(repository_id,request_id) DO NOTHING RETURNING request_id`,
            repo,b.requestId,b.threadId,user,b.login,b.createdAt,b.draftJson,b.packetJson,b.fingerprint,b.now as number));
          const rows = rowsOf(this.sql.exec('SELECT * FROM property_requests WHERE repository_id = ? AND request_id = ?', repo,b.requestId));
          const stored = rows.length ? readRequest(rows[0]!) : null;
          if (stored === null || stored.userId !== user || stored.draftJson !== b.draftJson) return json({ error: 'conflict' }, 409);
          return json({ request: stored });
        }
        if (url.pathname === '/request-get') {
          if (typeof b.requestId !== 'string') return json({ error: 'bad_request' }, 400);
          const rows = rowsOf(this.sql.exec('SELECT * FROM property_requests WHERE repository_id = ? AND request_id = ? AND user_id = ?', repo,b.requestId,user));
          return json({ request: rows.length ? readRequest(rows[0]!) : null });
        }
        if (url.pathname === '/request-root') {
          if (typeof b.threadId !== 'string') return json({ error: 'bad_request' }, 400);
          const rows = rowsOf(this.sql.exec("SELECT * FROM property_requests WHERE repository_id = ? AND request_id = ? AND user_id = ? AND status = 'created'", repo,b.threadId,user));
          return json({ request: rows.length ? readRequest(rows[0]!) : null });
        }
        if (url.pathname === '/request-reserve') {
          if (typeof b.requestId !== 'string' || !Number.isSafeInteger(b.limit) || (b.limit as number) < 1 || (b.limit as number) > 20 || !Number.isSafeInteger(b.now)) return json({ error: 'bad_request' }, 400);
          const now = b.now as number;
          const current = rowsOf(this.sql.exec('SELECT * FROM property_requests WHERE repository_id = ? AND request_id = ? AND user_id = ?', repo,b.requestId,user));
          const previous = current.length ? readRequest(current[0]!) : null;
          if (previous === null) return json({ error: 'missing' }, 404);
          if (previous.status === 'created') return json({ request: previous, firstAttempt: false });
          // Пока неизвестный POST мог ещё выполняться, второй запрос не идёт в GitHub.
          if (previous.status === 'reserved' && now - previous.updatedAt < 30_000) return json({ error: 'busy' }, 409);
          const firstAttempt = previous.status === 'prepared';
          // Один SQL-стейтмент: параллельные запросы не проходят проверку квоты вместе.
          const rows = rowsOf(this.sql.exec(`UPDATE property_requests SET status = 'reserved', updated_at = ?
            WHERE repository_id = ? AND request_id = ? AND user_id = ? AND status IN ('prepared','reserved')
            AND (EXISTS (SELECT 1 FROM property_requests AS active WHERE active.repository_id = ? AND active.user_id = ?
              AND active.thread_id = property_requests.thread_id AND active.status IN ('reserved','created') AND active.issue_state IS NOT 'closed')
            OR (SELECT COUNT(DISTINCT thread_id) FROM property_requests AS active WHERE active.repository_id = ? AND active.user_id = ?
              AND active.status IN ('reserved','created') AND active.issue_state IS NOT 'closed') < ?) RETURNING *`,
            now,repo,b.requestId,user,repo,user,repo,user,b.limit as number));
          if (rows.length) return json({ request: readRequest(rows[0]!), firstAttempt });
          return json({ error: 'limit' }, 429);
        }
        if (url.pathname === '/request-release') {
          if (typeof b.requestId !== 'string' || !Number.isSafeInteger(b.now)) return json({ error: 'bad_request' }, 400);
          // Только достоверный отказ GitHub освобождает место; unknown не освобождает.
          rowsOf(this.sql.exec("UPDATE property_requests SET status = 'prepared', updated_at = ? WHERE repository_id = ? AND request_id = ? AND user_id = ? AND status = 'reserved' RETURNING request_id", b.now as number,repo,b.requestId,user));
          return json({ ok: true });
        }
        if (url.pathname === '/request-created') {
          if (typeof b.requestId !== 'string' || !Number.isSafeInteger(b.issueNumber) ||
            !(b.commentId === null || Number.isSafeInteger(b.commentId)) || !['open','closed'].includes(String(b.issueState)) || !Number.isSafeInteger(b.now)) return json({ error: 'bad_request' }, 400);
          const rows = rowsOf(this.sql.exec("UPDATE property_requests SET status = 'created', issue_number = ?, comment_id = ?, issue_state = ?, updated_at = ? WHERE repository_id = ? AND request_id = ? AND user_id = ? RETURNING *",
            b.issueNumber as number,b.commentId as number | null,b.issueState as string,b.now as number,repo,b.requestId,user));
          return json({ request: rows.length ? readRequest(rows[0]!) : null });
        }
        if (url.pathname === '/request-state') {
          if (typeof b.threadId !== 'string' || !['open','closed'].includes(String(b.issueState)) || !Number.isSafeInteger(b.now)) return json({ error: 'bad_request' }, 400);
          rowsOf(this.sql.exec('UPDATE property_requests SET issue_state = ?, updated_at = ? WHERE repository_id = ? AND user_id = ? AND thread_id = ? AND issue_state IS NOT ? RETURNING request_id',
            b.issueState as string,b.now as number,repo,user,b.threadId,b.issueState as string));
          return json({ ok: true });
        }
        if (url.pathname === '/request-active') {
          // Для обновления состояния нужны корни активных нитей, а не все версии.
          const rows = rowsOf(this.sql.exec(`SELECT root.* FROM property_requests AS root
            WHERE root.repository_id = ? AND root.user_id = ? AND root.request_id = root.thread_id AND root.status = 'created'
            AND EXISTS (SELECT 1 FROM property_requests AS active WHERE active.repository_id = root.repository_id
              AND active.user_id = root.user_id AND active.thread_id = root.thread_id
              AND active.status IN ('reserved','created') AND active.issue_state IS NOT 'closed')
            ORDER BY root.updated_at DESC LIMIT 100`, repo,user));
          return json({ requests: rows.map(readRequest) });
        }
        if (url.pathname === '/request-list') {
          if (!Number.isSafeInteger(b.before) || !Number.isSafeInteger(b.limit) || (b.limit as number) < 1 || (b.limit as number) > 50) return json({ error: 'bad_request' }, 400);
          const rows = rowsOf(this.sql.exec('SELECT * FROM property_requests WHERE repository_id = ? AND user_id = ? AND updated_at < ? ORDER BY updated_at DESC, request_id DESC LIMIT ?', repo,user,b.before as number,(b.limit as number) + 1));
          return json({ requests: rows.slice(0,b.limit as number).map(readRequest), hasMore: rows.length > b.limit });
        }
        return json({ error: 'not_found' }, 404);
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

  private async runCleanup(now: number): Promise<{ pending: number; sessions: number; prepared: number }> {
    this.assertStorage();
    const pending = rowsOf(this.sql.exec(
      'DELETE FROM pending_oauth WHERE key IN (SELECT key FROM pending_oauth WHERE expires_at <= ? ORDER BY expires_at LIMIT ?) RETURNING key',
      now, CLEANUP_LIMIT,
    )).length;
    const sessions = rowsOf(this.sql.exec(
      'DELETE FROM identity_sessions WHERE session_hash IN (SELECT session_hash FROM identity_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?) RETURNING session_hash',
      now, CLEANUP_LIMIT,
    )).length;
    const prepared = rowsOf(this.sql.exec(
      "DELETE FROM property_requests WHERE status = 'prepared' AND updated_at <= ? AND rowid IN (SELECT rowid FROM property_requests WHERE status = 'prepared' AND updated_at <= ? ORDER BY updated_at LIMIT ?) RETURNING request_id",
      now - 86_400_000, now - 86_400_000, CLEANUP_LIMIT,
    )).length;
    // Не удаляем reserved/created: неизвестный результат и история автора сохраняются.
    return { pending, sessions, prepared };
  }
}
