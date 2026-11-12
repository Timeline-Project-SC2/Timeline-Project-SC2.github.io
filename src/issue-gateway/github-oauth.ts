/* Серверные функции с внедрённым транспортом; не подключены к Worker или браузеру. */
import type { OAuthConsumeResult } from './oauth-state.ts';

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const REPOSITORY_ID = '1421259694';
const TIMEOUT_MS = 10_000;
const verifierPattern = /^[A-Za-z0-9_-]{43}$/;

type Transport = (input: string, init: Parameters<typeof fetch>[1]) => Promise<Response>;
export interface GitHubAppConfig {
  readonly clientId: string;
  /** Только доверенный серверный секрет; не логировать и не возвращать браузеру. */
  readonly clientSecret: string;
  readonly callbackUrl: string;
  /**
   * Заменяемый endpoint обмена кода (тестовый/mock-сервер). По умолчанию
   * официальный endpoint GitHub. http разрешён только для loopback.
   */
  readonly tokenUrl?: string;
}
export type ExchangeResult =
  | { readonly status: 'accepted'; readonly accessToken: string; readonly expiresIn: number | null }
  | { readonly status: 'invalid' | 'rejected' | 'unavailable' };
export type GithubUserResult =
  | { readonly status: 'identified'; readonly user: { readonly id: number; readonly login: string } }
  | { readonly status: 'invalid' | 'rejected' | 'unavailable' };

function validCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash && value === url.href;
  } catch { return false; }
}

// Эндпоинт обмена/идентификации: https для любого хоста или http только loopback.
// Не несёт query/hash/credentials; canonical-форма обязательна.
function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || !url.hostname) return false;
    if (url.protocol === 'https:') return value === url.href;
    if (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')) return value === url.href;
    return false;
  } catch { return false; }
}
function validCredential(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Только после одноразовой проверки state; accessToken остаётся на сервере. */
export async function exchangeGithubCode(
  config: GitHubAppConfig,
  accepted: OAuthConsumeResult,
  code: string,
  transport: Transport,
): Promise<ExchangeResult> {
  if (accepted.status !== 'accepted' || !verifierPattern.test(accepted.verifier) ||
    !validCredential(config.clientId, 200) || !validCredential(config.clientSecret, 500) ||
    !validCredential(code, 500) || !validCallback(config.callbackUrl) ||
    (config.tokenUrl !== undefined && !validEndpoint(config.tokenUrl)) ||
    typeof transport !== 'function') return { status: 'invalid' };
  const tokenUrl = config.tokenUrl ?? TOKEN_URL;
  const params = new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, code,
    redirect_uri: config.callbackUrl, code_verifier: accepted.verifier, repository_id: REPOSITORY_ID,
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await transport(tokenUrl, {
      // workerd не поддерживает redirect: 'error'; 'manual' возвращает 3xx
      // как есть — редирект эндпоинта токена неожидан и означает unavailable.
      method: 'POST', redirect: 'manual', signal: abort.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if ((response.status >= 300 && response.status < 400) || response.status >= 500 || response.status === 429) return { status: 'unavailable' };
    if (!response.ok) return { status: 'rejected' };
    const payload: unknown = await response.json();
    if (!object(payload) || !validCredential(payload.access_token, 2048) ||
      typeof payload.token_type !== 'string' || payload.token_type.toLowerCase() !== 'bearer' ||
      (payload.expires_in !== undefined && (typeof payload.expires_in !== 'number' || !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 0))) return { status: 'rejected' };
    return { status: 'accepted', accessToken: payload.access_token, expiresIn: payload.expires_in === undefined ? null : payload.expires_in as number };
  } catch {
    // Код одноразовый: при неопределённом ответе не повторять обмен автоматически.
    return { status: 'unavailable' };
  } finally { clearTimeout(timer); }
}

/** Идентификация только через GitHub; возвращает ID и login, но никогда токен. */
export async function identifyGithubUser(accessToken: string, transport: Transport, userUrl?: string): Promise<GithubUserResult> {
  if (!validCredential(accessToken, 2048) || (userUrl !== undefined && !validEndpoint(userUrl)) || typeof transport !== 'function') return { status: 'invalid' };
  const userEndpoint = userUrl ?? USER_URL;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await transport(userEndpoint, {
      // redirect: 'manual': workerd не знает 'error'; 3xx обрабатываем явно.
      method: 'GET', redirect: 'manual', signal: abort.signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if ((response.status >= 300 && response.status < 400) || response.status >= 500 || response.status === 429) return { status: 'unavailable' };
    if (!response.ok) return { status: 'rejected' };
    const payload: unknown = await response.json();
    if (!object(payload) || payload.type !== 'User' || typeof payload.id !== 'number' || !Number.isSafeInteger(payload.id) || payload.id <= 0 ||
      typeof payload.login !== 'string' || payload.login.length > 39 || !/^[a-z\d]+(?:-[a-z\d]+)*$/i.test(payload.login)) return { status: 'rejected' };
    return { status: 'identified', user: { id: payload.id, login: payload.login } };
  } catch { return { status: 'unavailable' }; }
  finally { clearTimeout(timer); }
}
