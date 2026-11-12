/* Изолированный адаптер SQLite, не является Durable Object или HTTP endpoint. */
import type { OAuthStateStore, PendingOAuth } from './oauth-state.ts';

type SqlValue = string | number;
export interface OAuthSqlCursor extends Iterable<Record<string, unknown>> {
  readonly rowsWritten: number;
}
export interface OAuthSqlStorage {
  exec(query: string, ...bindings: SqlValue[]): OAuthSqlCursor;
}

/**
 * Адаптер требует один и тот же надёжный SQLite для всех операций конкретного
 * ключа. Каждый вызов exec должен быть атомарным и результат должен отражать
 * зафиксированную операцию. Не предоставлять прямой доступ из недоверенного HTTP.
 */
export class OAuthSqlStore implements OAuthStateStore {
  private readonly sql: OAuthSqlStorage;

  constructor(sql: OAuthSqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pending_oauth (
      key TEXT PRIMARY KEY, verifier TEXT NOT NULL, binding_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    sql.exec('CREATE INDEX IF NOT EXISTS pending_oauth_expiry ON pending_oauth (expires_at)');
  }

  async putIfAbsent(key: string, value: PendingOAuth): Promise<boolean> {
    const result = this.sql.exec(
      'INSERT INTO pending_oauth (key, verifier, binding_hash, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING',
      key, value.verifier, value.bindingHash, value.expiresAt,
    );
    if (result.rowsWritten !== 0 && result.rowsWritten !== 1) throw new Error('unexpected insert result');
    return result.rowsWritten === 1;
  }

  async take(key: string): Promise<PendingOAuth | null> {
    // Один SQL statement: чтение и удаление нельзя разделять между запросами.
    const cursor = this.sql.exec('DELETE FROM pending_oauth WHERE key = ? RETURNING verifier, binding_hash, expires_at', key);
    const rows = [...cursor];
    if (rows.length === 0 && cursor.rowsWritten === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || cursor.rowsWritten !== 1 || !row || typeof row.verifier !== 'string' ||
      typeof row.binding_hash !== 'string' || typeof row.expires_at !== 'number') throw new Error('invalid stored state');
    return { verifier: row.verifier, bindingHash: row.binding_hash, expiresAt: row.expires_at };
  }

  /** Ограниченная очистка истёкших записей; расписание задаёт будущий runtime. */
  async deleteExpired(now: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid cleanup parameters');
    const result = this.sql.exec(
      'DELETE FROM pending_oauth WHERE key IN (SELECT key FROM pending_oauth WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)',
      now, limit,
    );
    if (!Number.isSafeInteger(result.rowsWritten) || result.rowsWritten < 0 || result.rowsWritten > limit) throw new Error('unexpected cleanup result');
    return result.rowsWritten;
  }
}
