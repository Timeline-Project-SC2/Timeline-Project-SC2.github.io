/* Только локальная подготовка текста; запросы, аутентификация и запись отсутствуют. */
import { preparePropertyDraft } from './sector-property-draft.ts';
import type { PropertySession } from './sector-property-session.ts';

export interface PropertyIssuePreview {
  readonly status: 'preview_only';
  readonly title: string;
  readonly body: string;
  readonly warnings: readonly string[];
  /** Снимок для обнаружения правки после просмотра, не подпись или защита. */
  readonly draftSnapshot: string;
}

/** Выбираем ограждение длиннее любого ряда обратных кавычек в данных. */
function codeFence(text: string): string {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    current = char === '`' ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

export function preparePropertyIssuePreview(session: PropertySession, factionNames: ReadonlySet<string>): PropertyIssuePreview | null {
  const { draft, problems } = preparePropertyDraft(session, factionNames);
  if (draft === null) return null;
  const draftSnapshot = JSON.stringify(draft);
  const json = JSON.stringify(draft, null, 2);
  const fence = codeFence(json);
  const warnings = [
    'Issue будет публичной: не включайте секреты или непубличные данные.',
    'Этот просмотр не является отправкой, авторизацией или разрешением на запись.',
    draft.baseRevision === null
      ? 'Отпечаток входов не подтверждён.'
      : 'Отпечаток входов не доказывает публикацию, авторство или права.',
    ...problems.filter((problem) => problem.severity === 'warning').map((problem) => problem.message),
  ];
  return {
    status: 'preview_only',
    title: `Предпросмотр: свойства точек (${draft.changes.length})`,
    body: [
      '### Локальный предварительный просмотр',
      '',
      'Формат не утверждён. Это не отправленная и не готовая к применению заявка.',
      '',
      `${fence}json`, json, fence,
    ].join('\n'),
    warnings,
    draftSnapshot,
  };
}
