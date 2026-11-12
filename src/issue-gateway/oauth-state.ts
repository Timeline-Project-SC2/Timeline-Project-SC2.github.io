/* Изолированное ядро state/PKCE. Не является Worker, HTTP-обработчиком или авторизацией. */
export const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface PendingOAuth {
  /** PKCE verifier хранится только в доверенном контуре. */
  readonly verifier: string;
  readonly bindingHash: string;
  readonly expiresAt: number;
}
export interface OAuthStateStore {
  /** Атомарно создаёт только отсутствующий ключ; false — ключ уже существует. */
  putIfAbsent(key: string, value: PendingOAuth): Promise<boolean>;
  /** Атомарно извлекает и удаляет ключ; при повторе или гонке отдаёт null. */
  take(key: string): Promise<PendingOAuth | null>;
}
export interface OAuthCrypto {
  readonly subtle: SubtleCrypto;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}
export type OAuthStartResult =
  | { readonly status: 'started'; readonly state: string; readonly codeChallenge: string }
  | { readonly status: 'invalid' | 'unavailable' };
export type OAuthConsumeResult =
  | { readonly status: 'accepted'; readonly verifier: string }
  | { readonly status: 'invalid' | 'unavailable' };

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomToken(crypto: OAuthCrypto): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function sha256(crypto: OAuthCrypto, value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64url(new Uint8Array(hash));
}
function equalTokens(a: string, b: string): boolean {
  if (!TOKEN_RE.test(a) || !TOKEN_RE.test(b)) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function isClock(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

/**
 * browserBinding — случайное значение, связанное с браузером доверенным слоем;
 * его нельзя передавать через URL или записывать в логи. Хранилище обязано
 * обеспечивать атомарные операции; обычный eventually consistent KV не подходит.
 */
export async function beginOAuthFlow(store: OAuthStateStore, crypto: OAuthCrypto, browserBinding: string, now: number): Promise<OAuthStartResult> {
  if (!TOKEN_RE.test(browserBinding) || !isClock(now) || now > Number.MAX_SAFE_INTEGER - OAUTH_STATE_TTL_MS) return { status: 'invalid' };
  try {
    const bindingHash = await sha256(crypto, browserBinding);
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = randomToken(crypto);
      const verifier = randomToken(crypto);
      const [key, codeChallenge] = await Promise.all([sha256(crypto, state), sha256(crypto, verifier)]);
      const added = await store.putIfAbsent(key, { verifier, bindingHash, expiresAt: now + OAUTH_STATE_TTL_MS });
      if (added === true) return { status: 'started', state, codeChallenge };
      if (added !== false) return { status: 'unavailable' };
    }
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Одноразовая проверка state и привязки перед обменом OAuth-кода на токен. */
export async function consumeOAuthState(store: OAuthStateStore, crypto: OAuthCrypto, state: string, browserBinding: string, now: number): Promise<OAuthConsumeResult> {
  if (!TOKEN_RE.test(state) || !TOKEN_RE.test(browserBinding) || !isClock(now)) return { status: 'invalid' };
  try {
    const [key, bindingHash] = await Promise.all([sha256(crypto, state), sha256(crypto, browserBinding)]);
    const pending = await store.take(key);
    if (pending === null || !TOKEN_RE.test(pending.verifier) || !TOKEN_RE.test(pending.bindingHash) ||
      !isClock(pending.expiresAt) || pending.expiresAt <= now || pending.expiresAt - now > OAUTH_STATE_TTL_MS ||
      !equalTokens(pending.bindingHash, bindingHash)) return { status: 'invalid' };
    return { status: 'accepted', verifier: pending.verifier };
  } catch {
    return { status: 'unavailable' };
  }
}
