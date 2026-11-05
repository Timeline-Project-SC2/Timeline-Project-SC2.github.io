/* Справка редактора границ: файл руководства → HTML окна (шаг 2, приёмка).
 *
 * Источник текста один — `docs/admins/sector-areas-editor.md`. Он подключается
 * в бандл как `?raw` и превращается в HTML этим модулем, поэтому справка на
 * сайте и файл в репозитории не расходятся.
 *
 * Рендер намеренно минимальный: руководство пишется людьми в простой разметке,
 * и её хватает — заголовки, абзацы, списки, таблицы, код и ссылки. Ничего
 * исполняемого в разметке нет, весь текст перед вставкой экранируется.
 */

export interface HelpRenderOptions {
  /** `true` — вырезать разделы с заголовка и до следующего того же уровня. */
  readonly dropSections?: readonly string[];
}

/** Экранирование: текст руководства вставляется как HTML, но не как разметка. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Инлайн-разметка внутри строки: жирный, код и ссылки.
 * Ссылки на файлы репозитория (`README.md`, `../stages/…`) остаются текстом:
 * внутри окна сайта им некуда вести.
 */
export function inlineMarkup(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer noopener" target="_blank">$1</a>')
    .replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]*\)/g, '$1');
}

/** Разделы, которые в окне сайта не показываются (навигация репозитория). */
const SKIPPED_SECTIONS = ['Назад:', '## 7. Проверки перед заявкой'];

function skipped(title: string): boolean {
  return SKIPPED_SECTIONS.some((prefix) => title.startsWith(prefix));
}

/**
 * Превращает руководство в HTML. Пустая строка даёт пустой результат — окно
 * тогда показывает предупреждение, а не пустоту.
 */
export function markdownToHtml(markdown: string): string {
  if (markdown.trim().length === 0) return '';
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let table: string[][] = [];
  let skip = false;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push('<p>' + inlineMarkup(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    out.push('<ul>' + list.map((item) => '<li>' + inlineMarkup(item) + '</li>').join('') + '</ul>');
    list = [];
  };
  const flushTable = (): void => {
    if (table.length === 0) return;
    const body = table.filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell.trim())));
    if (body.length > 0) {
      const head = body[0]!;
      const rest = body.slice(1);
      out.push(
        '<div class="admin-editor-help-table"><table><thead><tr>'
        + head.map((cell) => '<th>' + inlineMarkup(cell.trim()) + '</th>').join('')
        + '</tr></thead><tbody>'
        + rest.map((row) => '<tr>' + row.map((cell) => '<td>' + inlineMarkup(cell.trim()) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table></div>',
      );
    }
    table = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code === null) {
        flushAll();
        code = [];
      } else {
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      flushAll();
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      skip = skipped(line.trim());
      if (!skip) out.push('<h' + (level + 1) + '>' + inlineMarkup(title) + '</h' + (level + 1) + '>');
      continue;
    }
    if (skip) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushAll();
      continue;
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph();
      flushList();
      table.push(trimmed.slice(1, -1).split('|'));
      continue;
    }
    flushTable();
    if (trimmed.startsWith('- ')) {
      flushParagraph();
      list.push(trimmed.slice(2));
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }

  if (code !== null) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
  flushAll();
  return out.join('\n');
}

/** Заголовок окна справки: из первого `h1` файла или постоянный. */
export function helpTitle(markdown: string): string {
  const first = /^#\s+(.*)$/m.exec(markdown);
  return first === null ? 'Справка редактора' : first[1]!.trim();
}
