/* Локальная подготовка черновика. Авторство и время добавит Worker из сессии.
 * Здесь нет сети и записи данных; создание заявки не означает применение.
 */
import { PROPERTY_ISSUE_VERSION, fingerprintPropertyPacket, isPropertyRequestId, readPropertyRequestDraft } from '../issue-gateway/property-issue-contract.ts';
import type { PropertyRequestDraft } from '../issue-gateway/property-issue-contract.ts';
import { preparePropertyDraft } from './sector-property-draft.ts';
import type { PropertySession } from './sector-property-session.ts';
export interface PropertyPacketReview {
  readonly status: 'ready' | 'blocked';
  readonly requestId: string;
  readonly threadId: string;
  readonly draft: PropertyRequestDraft | null;
  readonly fingerprint: string;
  readonly draftSnapshot: string;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}
/** ID версии/нити: время + случайные байты, не автор и не разрешение. */
export function newRequestId(now: number, random: () => Uint8Array): string {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('Некорректное время.');
  const bytes = random();
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) throw new TypeError('Недостаточно случайности.');
  return `pr-${now.toString(36)}-${[...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
export async function preparePropertyPacket(session: PropertySession, factionNames: ReadonlySet<string>,
  requestId: string, threadId = requestId): Promise<PropertyPacketReview | null> {
  const { draft, problems } = preparePropertyDraft(session, factionNames);
  if (draft === null) return null;
  const errors: string[] = [], warnings: string[] = [];
  if (draft.baseRevision === null) errors.push('Отпечаток входов не подтверждён: обновите страницу и повторите правку.');
  if (!isPropertyRequestId(threadId)) errors.push('Некорректная нить заявки.');
  const raw = { type: 'sector-property-request-draft', version: PROPERTY_ISSUE_VERSION, requestId, threadId,
    baseRevision: draft.baseRevision ?? '', changes: draft.changes.map((c) => ({ dataset: c.dataset, recordId: c.recordId,
      field: c.field, before: c.before, after: c.after })) };
  let validated: PropertyRequestDraft | null = null;
  try { validated = readPropertyRequestDraft(raw); } catch (error) { errors.push(error instanceof Error ? error.message : 'Неверный формат черновика.'); }
  const snapshot = JSON.stringify(draft);
  warnings.push('Заявка будет закрытой: её увидят автор на сайте и владелец организации.',
    'Создание заявки не применяет правку и не подтверждает обновление сайта.',
    'Исправление после отправки — новая версия в той же нити, не перезапись.',
    ...problems.filter((p) => p.severity === 'warning').map((p) => p.message));
  if (validated === null || errors.length) return { status: 'blocked', requestId, threadId, draft: null, fingerprint: '', draftSnapshot: snapshot, warnings, errors };
  return { status: 'ready', requestId, threadId, draft: validated,
    fingerprint: await fingerprintPropertyPacket(JSON.stringify(validated)), draftSnapshot: snapshot, warnings, errors };
}
