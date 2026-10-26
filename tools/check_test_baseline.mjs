#!/usr/bin/env node
/**
 * Страж базы известных падений — карточка `CI-1`, решение `E2`.
 *
 * Зачем: полный `npm test` содержит 8 известных падений планетарного контура
 * (`И-11`, контур `rc-02`), поэтому джоба `scripts` исторически была «привычно красной»:
 * девятое падение выглядело точно так же, как восемь базовых, и норму «девятое
 * блокирует» держала только дисциплина приёмки. Страж делает гейт бинарным:
 * тесты **не** скипаются и **не** маркируются `todo`, исполняется тот же самый
 * список файлов, а в `tools/known-test-failures.json` явно назван долг.
 *
 * Правила (карточка `CI-1` §4.2):
 *   1. Список тестов не дублируется: берём `scripts.test` из `package.json`
 *      и добавляем `--test-reporter=tap`. Единственный источник — `package.json`.
 *   2. Падения читаются из строк `not ok N - …` с учётом вложенности подтестов.
 *   3. Совпало с базой — выход `0` и строка «известные падения: N/N по базе, новых нет».
 *   4. Падение вне базы — выход `1`, секция «НОВЫЕ ПАДЕНИЯ:» с именами.
 *   5. Имя из базы больше не падает (починка или переименование) — выход `1`,
 *      секция «БАЗА УСТАРЕЛА:» с требованием обновить JSON в этом же PR:
 *      «молчаливое» позеленение скрыло бы и починку, и переименование, и регрессию
 *      внутри самого теста.
 *   6. Крэш прогона (нет TAP-итогов или процесс убит) — выход `1`, отдельное
 *      сообщение: под базу такое состояние не маскируется.
 *
 * Имена сравниваются в раскодированном виде: TAP экранирует `#` (`\#43533`),
 * а в исходнике теста и в базе имя записано как `#43533`. Экранирование —
 * транспортная деталь формата, а не часть имени подтеста.
 *
 * Ограничения: без сети, без `Math.random` и времени — прогон детерминирован.
 *
 * Запуск: `node tools/check_test_baseline.mjs` (в CI — шаг «Тесты node:test со стражем базы»).
 * Код возврата: `0` — набор падений совпал с базой, `1` — новое падение,
 * устаревшая база или крэш прогона, `2` — ошибка окружения (нет package.json/базы).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Путь к `package.json`: единственный источник списка тестов. */
export const PACKAGE_PATH = path.join(ROOT, 'package.json');
/** Путь к базе известных падений. */
export const BASELINE_PATH = path.join(HERE, 'known-test-failures.json');

const TAP_REPORTER = '--test-reporter=tap';
/** Файл теста в списке аргументов: нужен только для человеческих сообщений. */
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
/** Служебная обёртка файла в TAP: имя вида `tests/foo.test.mjs` не часть имени подтеста. */
const FILE_NAME = /\.(?:[cm]?[jt]s)$/;

/**
 * Разбирает `scripts.test` из `package.json` и добавляет TAP-репортёр.
 * Список файлов при этом не дублируется: аргументы берутся из скрипта как есть.
 *
 * @param {{scripts?: Record<string, string>}} packageJson
 * @returns {{command: string, args: string[]}}
 */
export function buildTestCommand(packageJson) {
  const script = packageJson?.scripts?.test;
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error('в package.json нет строки scripts.test — список тестов брать неоткуда');
  }
  const [command, ...args] = script.trim().split(/\s+/);
  const testIndex = args.indexOf('--test');
  if (testIndex === -1) {
    throw new Error('scripts.test не запускает `node --test`: TAP-отчёт получить не из чего');
  }
  // `--test-reporter=<вид>` и `--test-reporter <вид>` одинаково перекрываются своим TAP-видом.
  const inline = args.findIndex((arg) => arg.startsWith('--test-reporter='));
  if (inline !== -1) {
    args[inline] = TAP_REPORTER;
  } else {
    const separate = args.indexOf('--test-reporter');
    if (separate !== -1) {
      args.splice(separate, 2, TAP_REPORTER);
    } else {
      args.splice(testIndex + 1, 0, TAP_REPORTER);
    }
  }
  return { command, args };
}

/** Файлы тестов из аргументов команды — для сообщений и счётчика. */
export function testFiles(args) {
  return args.filter((arg) => TEST_FILE.test(arg));
}

/**
 * Раскодирует TAP-экранирование: `\#` → `#`, `\\` → `\`.
 * Нужно, чтобы имя совпадало с базой независимо от того, экранировал его раннер или нет.
 *
 * @param {string} raw
 * @returns {string}
 */
export function decodeTapName(raw) {
  return String(raw).replace(/\\([\\#])/g, '$1');
}

/**
 * Собирает полное имя подтеста из стека родителей, отбрасывая служебную
 * обёртку файла (`tests/foo.test.mjs`), если раннер её печатает.
 *
 * @param {string[]} parts
 * @returns {string}
 */
function fullName(parts) {
  const cleaned = parts.filter(Boolean);
  while (cleaned.length > 1 && FILE_NAME.test(cleaned[0])) cleaned.shift();
  return cleaned.join(' > ');
}

/**
 * Разбирает TAP-поток `node --test --test-reporter=tap`.
 *
 * Вложенность определяется по отступам: строка `# Subtest: <имя>` открывает
 * уровень, строка результата `ok/not ok N - <имя>` этот уровень закрывает.
 * Так парсер понимает и плоский формат (Node 22 и Node 24 на этом наборе
 * печатают его одинаково), и вложенный, где подтесты лежат внутри родителя.
 *
 * @param {string} text
 * @returns {{
 *   failures: string[],
 *   passed: string[],
 *   totals: {tests: number|null, pass: number|null, fail: number|null, skipped: number|null, todo: number|null},
 *   plan: number|null,
 *   complete: boolean
 * }}
 */
export function parseTap(text) {
  const failures = [];
  const passed = [];
  const totals = { tests: null, pass: null, fail: null, skipped: null, todo: null };
  let plan = null;
  /** @type {{indent: number, name: string}[]} */
  const parents = [];

  for (const line of String(text).split(/\r?\n/)) {
    const subtest = /^(\s*)#\s+Subtest:\s?(.*)$/.exec(line);
    if (subtest) {
      const indent = subtest[1].length;
      while (parents.length && parents[parents.length - 1].indent >= indent) parents.pop();
      parents.push({ indent, name: decodeTapName(subtest[2].trim()) });
      continue;
    }

    const result = /^(\s*)(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*)$/.exec(line);
    if (result) {
      const indent = result[1].length;
      // Имя из строки результата — это имя самого подтеста; `# Subtest:` того же
      // уровня дублирует его и нужно только для склейки полного имени предков.
      const own = decodeTapName(result[4].replace(/\s+#\s+(?:SKIP|TODO)\b.*$/i, '').trim());
      const sameLevel = parents.length && parents[parents.length - 1].indent === indent
        ? parents[parents.length - 1].name
        : '';
      const enclosing = parents.filter((entry) => entry.indent < indent).map((entry) => entry.name);
      const name = fullName([...enclosing, own || sameLevel]);
      const isSkip = /#\s+(?:SKIP|TODO)\b/i.test(result[4]);
      if (result[2] === 'not ok') {
        failures.push(name);
      } else if (!isSkip) {
        passed.push(name);
      }
      continue;
    }

    const counter = /^#\s+(tests|pass|fail|skipped|todo)\s+(\d+)$/.exec(line);
    if (counter) {
      totals[counter[1]] = Number(counter[2]);
      continue;
    }

    const planLine = /^1\.\.(\d+)$/.exec(line);
    if (planLine) plan = Number(planLine[1]);
  }

  const complete = (totals.tests !== null && totals.fail !== null) || plan !== null;
  return { failures, passed, totals, plan, complete };
}

/**
 * Сверяет фактические падения с базой.
 *
 * @param {string[]} failures
 * @param {{name: string}[]} baseline
 * @returns {{newFailures: string[], staleBaseline: string[], matched: number}}
 */
export function compareWithBaseline(failures, baseline) {
  const actual = [...new Set(failures)];
  const actualSet = new Set(actual);
  const knownSet = new Set(baseline.map((entry) => decodeTapName(entry.name)));
  return {
    newFailures: actual.filter((name) => !knownSet.has(name)),
    staleBaseline: baseline
      .map((entry) => decodeTapName(entry.name))
      .filter((name, index, all) => all.indexOf(name) === index && !actualSet.has(name)),
    matched: actual.filter((name) => knownSet.has(name)).length
  };
}

/**
 * Полный вердикт стража по результату прогона: чистая функция, покрыта
 * `tests/check-test-baseline.test.mjs` на синтетическом TAP.
 *
 * @param {{exitCode: number|null, tapText: string, baseline: {name: string, file?: string, knownSince?: string}[], command?: string, signal?: string|null}} input
 * @returns {{code: number, text: string, failures: string[], newFailures: string[], staleBaseline: string[]}}
 */
export function evaluateRun({ exitCode, tapText, baseline, command = '', signal = null }) {
  const parsed = parseTap(tapText);
  const header = command ? [`команда: ${command}`] : [];
  const lines = [];

  // 1. Крэш прогона: итогов TAP нет или процесс убит сигналом.
  if (signal || !parsed.complete) {
    lines.push(
      'СТРАЖ: КРАСНЫЙ — прогон тестов не дошёл до TAP-итогов',
      'КРЭШ ПРОГОНА ТЕСТОВ: тесты упали не падением теста, а падением процесса.',
      `  код возврата: ${exitCode === null ? 'нет (процесс убит)' : exitCode}` +
        (signal ? `, сигнал: ${signal}` : ''),
      `  TAP-итогов нет: не найдено ни строки «# tests N», ни плана «1..N»; распознано падений: ${parsed.failures.length}`,
      '  Под базу это состояние не маскируется: чините причину, а не базу.'
    );
    if (parsed.failures.length) {
      lines.push('  Успели упасть до обрыва:', ...parsed.failures.map((name) => `    - ${name}`));
    }
    return { code: 1, text: [...header, ...lines].join('\n'), failures: parsed.failures, newFailures: parsed.failures, staleBaseline: [] };
  }

  const comparison = compareWithBaseline(parsed.failures, baseline);
  const { totals } = parsed;
  const total = `TAP-итоги: тестов ${totals.tests ?? '?'}, pass ${totals.pass ?? '?'}, ` +
    `fail ${totals.fail ?? '?'}, skipped ${totals.skipped ?? '?'}, todo ${totals.todo ?? '?'}`;

  // 2. Новое падение вне базы.
  if (comparison.newFailures.length) {
    lines.push(
      'СТРАЖ: КРАСНЫЙ — есть падения вне базы',
      'НОВЫЕ ПАДЕНИЯ:',
      ...comparison.newFailures.map((name) => `  ✗ ${name}`),
      `известные падения базы: ${comparison.matched}/${baseline.length} на месте`
    );
    return { code: 1, text: [...header, total, ...lines].join('\n'), failures: parsed.failures, ...comparison };
  }

  // 3. База устарела: базовое имя больше не падает.
  if (comparison.staleBaseline.length) {
    lines.push(
      'СТРАЖ: КРАСНЫЙ — база устарела',
      'БАЗА УСТАРЕЛА:',
      ...comparison.staleBaseline.map((name) => `  · ${name}`),
      'Эти имена больше не падают (починка или переименование теста).',
      'Обновите tools/known-test-failures.json в этом же PR: устаревшая база скрыла бы регрессию.'
    );
    return { code: 1, text: [...header, total, ...lines].join('\n'), failures: parsed.failures, ...comparison };
  }

  // 4. Падений в TAP нет, а процесс всё равно упал: это не «зелёный», а поломка прогона.
  if (!parsed.failures.length && exitCode !== 0) {
    return {
      code: 1,
      text: [...header, total, 'СТРАЖ: КРАСНЫЙ — прогон завершился с ошибкой, но падений в TAP нет',
        `  код возврата: ${exitCode}; такой прогон под базу не подводится.`].join('\n'),
      failures: parsed.failures,
      ...comparison
    };
  }

  // 5. Тот же набор падений, что в базе (процесс завершается не нулём — это ожидаемо).
  lines.push(
    `известные падения: ${baseline.length}/${baseline.length} по базе, новых нет`,
    ...baseline.map((entry) => `  ✓ ${entry.name} [${entry.file}, ${entry.knownSince}]`),
    'СТРАЖ: ОК — набор падений совпал с базой, регрессий нет'
  );

  return { code: 0, text: [...header, total, ...lines].join('\n'), failures: parsed.failures, ...comparison };
}

/**
 * Читает базу и валидирует её форму: массив объектов с `name`/`file`/`contour`/`knownSince`.
 *
 * @param {string} [baselinePath]
 * @returns {{name: string, file: string, contour: string, knownSince: string}[]}
 */
export function loadBaseline(baselinePath = BASELINE_PATH) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${baselinePath}: ожидался массив объектов`);
  parsed.forEach((entry, index) => {
    for (const field of ['name', 'file', 'contour', 'knownSince']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`${baselinePath}: запись ${index} без поля ${field}`);
      }
    }
  });
  return parsed;
}

function main() {
  let baseline;
  let command;
  try {
    baseline = loadBaseline();
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    command = buildTestCommand(pkg);
  } catch (error) {
    process.stderr.write(`ОШИБКА ОКРУЖЕНИЯ: ${error.message}\n`);
    process.exit(2);
  }

  const printable = `${command.command} ${command.args.join(' ')}`;
  const files = testFiles(command.args);
  process.stdout.write(
    `Страж базы известных падений: ${path.relative(ROOT, BASELINE_PATH)}\n` +
    `  список файлов взят из package.json: ${files.length} шт., --test-reporter=tap\n`
  );

  const result = spawnSync(command.command === 'node' ? process.execPath : command.command, command.args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' }
  });
  if (result.error) {
    process.stdout.write(
      `СТРАЖ: КРАСНЫЙ — прогон тестов не запустился\n` +
      `КРЭШ ПРОГОНА ТЕСТОВ: ${result.error.message}\n`
    );
    process.exit(1);
  }

  const tapText = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const verdict = evaluateRun({
    exitCode: result.status,
    signal: result.signal,
    tapText,
    baseline,
    command: printable
  });

  if (verdict.code !== 0) {
    // Диагностика провала: полный лог прогона, иначе по именам не починить.
    process.stdout.write('\n--- полный лог прогона ---\n');
    process.stdout.write(tapText.trimEnd() + '\n--- конец лога ---\n\n');
  }
  process.stdout.write(verdict.text + '\n');
  process.exit(verdict.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
