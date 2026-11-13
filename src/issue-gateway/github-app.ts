/* Короткоживущий токен установки GitHub App. Приватный ключ не покидает Worker.
 * RS256 через WebCrypto; токен сужен до одного репозитория и Issues: write.
 * Содержимое репозитория и права организации этот токен не получает.
 */
import type { PropertyRepositoryTarget } from './property-issue-contract.ts';
export interface GithubAppInstallationConfig {
  readonly clientId: string;
  readonly privateKey: string;
  readonly installationId: string;
  readonly target: PropertyRepositoryTarget;
  readonly apiBase?: string;
}
export type InstallationTokenResult =
  | { readonly status: 'ready'; readonly token: string; readonly botLogin: string; readonly expiresAt: number }
  | { readonly status: 'invalid' | 'rejected' | 'unavailable' };
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function derSequence(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const prefix = Uint8Array.of(0x30, ...derLength(length));
  const result = new Uint8Array(prefix.length + length); result.set(prefix);
  let offset = prefix.length; for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
/** GitHub выдаёт PKCS#1; WebCrypto принимает PKCS#8. Поддерживаем оба PEM. */
export function privateKeyPkcs8(pem: string): Uint8Array {
  const pkcs8 = /^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----\s*$/.exec(pem);
  const pkcs1 = /^-----BEGIN RSA PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END RSA PRIVATE KEY-----\s*$/.exec(pem);
  const match = pkcs8 ?? pkcs1;
  if (!match || pem.length > 16_000) throw new TypeError('invalid private key');
  const binary = atob(match[1]!.replace(/\s/g, ''));
  const der = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (der.length < 16 || der[0] !== 0x30) throw new TypeError('invalid DER');
  if (pkcs8) return der;
  // RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, dp, dq, qi }.
  // Проверяем версию и число INTEGER до обёртки, не пробуем случайный DER.
  let position = 0;
  const lengthAt = (): number => {
    const first = der[position++];
    if (first === undefined) throw new TypeError('invalid DER');
    if (first < 128) return first;
    const count = first & 127;
    if (count === 0 || count > 4 || position + count > der.length) throw new TypeError('invalid DER');
    let value = 0; for (let i = 0; i < count; i++) value = value * 256 + der[position++]!;
    return value;
  };
  if (der[position++] !== 0x30 || lengthAt() !== der.length - position || der[position++] !== 2) throw new TypeError('invalid DER');
  const versionLength = lengthAt();
  if (versionLength !== 1 || der[position++] !== 0) throw new TypeError('invalid DER');
  for (let i = 0; i < 8; i++) {
    if (der[position++] !== 2) throw new TypeError('invalid DER');
    const length = lengthAt();
    position += length;
    if (position > der.length) throw new TypeError('invalid DER');
  }
  if (position !== der.length) throw new TypeError('invalid DER');
  const algorithm = derSequence(Uint8Array.of(6, 9, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 1), Uint8Array.of(5, 0));
  const octets = Uint8Array.of(4, ...derLength(der.length), ...der);
  return derSequence(Uint8Array.of(2, 1, 0), algorithm, octets);
}
export async function appJwt(clientId: string, pem: string, now: number): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', new Uint8Array(privateKeyPkcs8(pem)).buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const seconds = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify({ iat: seconds - 60, exp: seconds + 300, iss: clientId })));
  const message = `${header}.${payload}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message));
  return `${message}.${base64url(new Uint8Array(signature))}`;
}
function apiBase(config: GithubAppInstallationConfig): string | null {
  const value = config.apiBase ?? 'https://api.github.com';
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return null;
    return url.origin;
  } catch { return null; }
}
export function installationConfigValid(config: GithubAppInstallationConfig): boolean {
  return typeof config.clientId === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(config.clientId) &&
    typeof config.installationId === 'string' && /^[1-9]\d{0,15}$/.test(config.installationId) &&
    Number.isSafeInteger(Number(config.installationId)) && Number.isSafeInteger(config.target?.id) && config.target.id > 0 &&
    /^[a-z\d-]+\/[a-z\d_.-]+$/i.test(config.target?.fullName ?? '') && apiBase(config) !== null;
}
async function post(url: string, token: string, body: unknown, transport: Transport): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    return await transport(url, { method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json', 'User-Agent': 'timeline-issue-gateway', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify(body) });
  } finally { clearTimeout(timer); }
}
const unknownStatus = (status: number): boolean => (status >= 300 && status < 400) || status >= 500 || status === 429;
/** Не кэшируем токен в браузере или DO. Срок и область проверяются по ответу GitHub. */
export async function createInstallationToken(config: GithubAppInstallationConfig, transport: Transport = fetch, now = Date.now()): Promise<InstallationTokenResult> {
  const root = apiBase(config);
  if (!installationConfigValid(config) || typeof transport !== 'function') return { status: 'invalid' };
  try {
    const jwt = await appJwt(config.clientId, config.privateKey, now);
    const appResponse = await transport(`${root}/app`, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${jwt}`,
        'User-Agent': 'timeline-issue-gateway', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (unknownStatus(appResponse.status)) return { status: 'unavailable' };
    if (!appResponse.ok) return { status: 'rejected' };
    const app: unknown = await appResponse.json();
    if (!object(app) || app.client_id !== config.clientId || typeof app.slug !== 'string' || !/^[a-z\d-]{1,100}$/i.test(app.slug)) return { status: 'rejected' };
    const repoName = config.target.fullName.split('/')[1]!;
    const response = await post(`${root}/app/installations/${config.installationId}/access_tokens`, jwt,
      { repositories: [repoName], repository_ids: [config.target.id], permissions: { issues: 'write' } }, transport);
    if (unknownStatus(response.status)) return { status: 'unavailable' };
    if (!response.ok) return { status: 'rejected' };
    const payload: unknown = await response.json();
    if (!object(payload) || typeof payload.token !== 'string' || payload.token.length < 1 || payload.token.length > 8192 ||
      /[\u0000-\u0020\u007f]/.test(payload.token) || payload.repository_selection !== 'selected' ||
      !Array.isArray(payload.repositories) || payload.repositories.length !== 1 || !object(payload.repositories[0]) ||
      payload.repositories[0].id !== config.target.id || payload.repositories[0].private !== true ||
      typeof payload.repositories[0].full_name !== 'string' || payload.repositories[0].full_name.toLowerCase() !== config.target.fullName.toLowerCase() ||
      !object(payload.permissions) || payload.permissions.issues !== 'write' ||
      Object.entries(payload.permissions).some(([key, value]) => key !== 'issues' && value !== 'read') ||
      typeof payload.expires_at !== 'string') return { status: 'rejected' };
    const expiresAt = Date.parse(payload.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= now + 30_000 || expiresAt > now + 3_900_000) return { status: 'rejected' };
    return { status: 'ready', token: payload.token, botLogin: `${app.slug}[bot]`, expiresAt };
  } catch { return { status: 'unavailable' }; }
}
