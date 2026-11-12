/* Сборка заявки на свойства точек из локальной сессии редактора.
 *
 * Здесь нет отправки: функция возвращает готовые заголовок и тело Issue,
 * отпечаток содержимого и предупреждения для человека. Отправку выполняет
 * шлюз после входа администратора; создание Issue не равно применению
 * правки и не подтверждает публикацию карты.
 *
 * Модуль намеренно не зависит от UI: его проверяют тестами без DOM, и он же
 * служит проверкой того, что клиент и сервер понимают формат одинаково
 * (разбор тела — `parsePropertyIssueBody` в `src/issue-gateway/`).
 */
import {
  PROPERTY_ISSUE_TYPE,
  PROPERTY_ISSUE_VERSION,
  PROPERTY_REPOSITORY_ID,
  canonicalPacketJson,
  fingerprintPropertyPacket,
  propertyIssueTitle,
  readPacket,
  renderPropertyIssueBody,
  scanPublicText,
} from '../issue-gateway/property-issue-contract.ts';
import type { PropertyIssuePacket } from '../issue-gateway/property-issue-contract.ts';
import { preparePropertyDraft } from './sector-property-draft.ts';
import type { PropertySession } from './sector-property-session.ts';

export interface PropertyPacketReview {
  /** `ready` — можно показать человеку кнопку отправки; `blocked` — нельзя. */
  readonly status: 'ready' | 'blocked';
  readonly requestId: string;
  readonly title: string;
  readonly body: string;
  /** Отпечаток тела: метка содержимого для сверки перед отправкой. */
  readonly fingerprint: string;
  /** Снимок для обнаружения правки после просмотра, не подпись и не защита. */
  readonly draftSnapshot: string;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/** ID попытки: время + случайные байты; не автор и не разрешение записи. */
export function newRequestId(now: number, random: () => Uint8Array): string {
  if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError('Некорректное время.');
  const bytes = random();
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) throw new TypeError('Недостаточно случайности.');
  const suffix = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `pr-${now.toString(36)}-${suffix}`;
}

/**
 * Готовит заявку из сессии редактора. Возвращает `null`, если правок нет или
 * локальная проверка нашла ошибку: такая заявка не должна доехать до GitHub.
 */
export async function preparePropertyPacket(
  session: PropertySession,
  factionNames: ReadonlySet<string>,
  requestId: string,
): Promise<PropertyPacketReview | null> {
  const { draft, problems } = preparePropertyDraft(session, factionNames);
  if (draft === null) return null;
  const packet: PropertyIssuePacket = {
    type: PROPERTY_ISSUE_TYPE,
    version: PROPERTY_ISSUE_VERSION,
    requestId,
    repositoryId: PROPERTY_REPOSITORY_ID,
    baseRevision: draft.baseRevision ?? '',
    changes: draft.changes.map((change) => ({
      dataset: change.dataset,
      recordId: change.recordId,
      field: change.field,
      before: change.before,
      after: change.after,
    })),
  };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (packet.baseRevision === '') errors.push('Отпечаток входов не подтверждён: обновите страницу и повторите правку.');
  let validated: PropertyIssuePacket | null = null;
  try {
    validated = readPacket(packet);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Заявка не прошла проверку формата.');
  }
  const body = validated === null ? '' : renderPropertyIssueBody(validated);
  const scanned = scanPublicText(body);
  errors.push(...scanned.errors);
  warnings.push(...scanned.warnings);
  warnings.push(
    'Issue будет публичной: автор и содержание видны всем, включая роль в организации.',
    'Создание заявки не применяет правку и не подтверждает обновление сайта.',
    draft.baseRevision === null
      ? 'Отпечаток входов не подтверждён.'
      : 'Отпечаток входов не доказывает публикацию, авторство или права.',
  );
  warnings.push(...problems.filter((problem) => problem.severity === 'warning').map((problem) => problem.message));
  if (validated === null || errors.length > 0) {
    return { status: 'blocked', requestId, title: '', body: '', fingerprint: '', draftSnapshot: JSON.stringify(draft), warnings, errors };
  }
  const fingerprint = await fingerprintPropertyPacket(canonicalPacketJson(validated));
  return {
    status: 'ready',
    requestId,
    title: propertyIssueTitle(fingerprint),
    body,
    fingerprint,
    draftSnapshot: JSON.stringify(draft),
    warnings,
    errors,
  };
}
