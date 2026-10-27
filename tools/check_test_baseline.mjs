#!/usr/bin/env node
/**
 * Страж карантина планетарных падений — карточки `CI-1` (решение `E2`) и `CI-2` (редакция `CI2-7`).
 *
 * Зачем: полный `npm test` содержит известные падения планетарного контура
 * (`И-11`, контур `rc-02`). Решением владельца от 26.10.2026 (`S8-Q1`) они переведены
 * в намеренный временный карантин **на уровне раннера**: тесты не удалены и не помечены
 * в исходниках, а отфильтровываются skip-флагами, построенными из
 * `tools/known-test-failures.json`. Страж держит карантин точечным: маскировка нового
 * падения и «мёртвая» запись реестра одинаково краснят шаг.
 *
 * Факт шага 0 (эскалация воркера → редакция `CI2-7`): в Node 22/24 `--test-skip*`
 * отфильтровывает тест **до исполнения** — TAP-строк `# SKIP` не возникает, счётчик
 * `skipped` остаётся нулевым, совпавшие тесты просто исчезают из вывода. Поэтому
 * семантика «пропущено» проверяется не по TAP-директиве, а двумя прогонами одной и той
 * же команды:
 *
 *   Прогон 1 — без skip-флагов (целостность реестра). Код выхода процесса сигналом не
 *   служит: реестровые падения ожидаемы. Сравниваются множества имён `not ok` и реестра.
 *   Падение вне реестра → «НОВЫЕ ПАДЕНИЯ:»; имя реестра не падает (починка, переименование,
 *   удаление) → «КАРАНТИН НЕ ПРИМЕНЁН: устаревшие имена …». Запоминается число тестов `N1`.
 *
 *   Прогон 2 — та же команда плюс по одному якорному флагу на каждое имя реестра. Требования:
 *   код выхода `0`, ноль строк `not ok`, число тестов `N2 = N1 − N` (N — число записей реестра).
 *   Арифметика доказывает,
 *   что отфильтрованы ровно реестровые тесты и ни один другой; невыполнение → секция
 *   «КАРАНТИН НЕ ПРИМЕНЁН:» с несошедшейся арифметикой или именами.
 *
 *   Зелёный `0` — только при согласии обоих прогонов. Крэш любого процесса без TAP-итогов
 *   краснит отдельным сообщением: под реестр такое состояние не маскируется.
 *
 * Имя skip-флага не хардкодится: оно определяется в рантайме по `node --help`
 * (предпочтение `--test-skip`, откат `--test-skip-pattern`; сегодняшние Node 22/24 знают
 * только второе). Нет ни одного — ошибка окружения с понятным сообщением.
 *
 * Имена сравниваются в раскодированном виде: TAP экранирует `#` (`\#43533`), а в исходнике
 * теста и в реестре имя записано как `#43533`. Экранирование — транспортная деталь формата.
 *
 * Ограничения: без сети, без `Math.random` и обращений к часам — прогон детерминирован.
 *
 * Запуск: `node tools/check_test_baseline.mjs` (в CI — шаг «Тесты node:test с карантином
 * этапа 8 (страж целостности)»). UP-1 (27.10.2026): семь записей из восьми починены, в реестре
 * осталась одна (m.14, нужно решение владельца), поэтому двойной прогон пока сохраняется.
 * Код возврата: `0` — карантин применён точечно, новых
 * падений нет; `1` — новое падение, устаревшее имя реестра, `not ok`/сломанная арифметика
 * во втором прогоне или крэш; `2` — ошибка окружения (нет package.json/реестра/флага).
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Путь к `package.json`: единственный источник списка тестов. */
export const PACKAGE_PATH = path.join(ROOT, 'package.json');
/** Путь к реестру карантина. */
export const BASELINE_PATH = path.join(HERE, 'known-test-failures.json');

/** Скрипт, чью команду страж разбирает: свой список файлов вести запрещено. */
export const RAW_SCRIPT = 'test:raw';
/** Флаги skip-паттерна в порядке предпочтения (какой знает рантайм — определяется по `node --help`). */
export const SKIP_FLAGS = ['--test-skip', '--test-skip-pattern'];

const TAP_REPORTER = '--test-reporter=tap';
/** Файл теста в списке аргументов: нужен только для человеческих сообщений. */
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
/** Служебная обёртка файла в TAP: имя вида `tests/foo.test.mjs` не часть имени подтеста. */
const FILE_NAME = /\.(?:[cm]?[jt]s)$/;

/**
 * Экранирует имя теста в regex-литерал полного совпадения: `^…$`.
 * Экранируются все метасимволы JS-regex, включая `(`, `)`, `#`, `·`, `≤`, `%`;
 * кириллица в `u`-безопасном виде остаётся как есть (regex-метасимволами она не является).
 *
 * @param {string} name полное TAP-имя теста
 * @returns {string} паттерн вида `^escaped-name$`
 */
export function escapeTapPattern(name) {
  return `^${String(name).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`;
}

/**
 * Определяет имя skip-флага по выводу `node --help` (автодетект, без хардкода версии).
 *
 * @param {string} helpText
 * @returns {{flag: string|null, known: string[]}}
 */
export function detectSkipFlag(helpText) {
  const text = String(helpText);
  const flag = SKIP_FLAGS.find((candidate) => new RegExp(`(?:^|\\s)${candidate}=`, 'm').test(text)) ?? null;
  return { flag, known: SKIP_FLAGS };
}

/**
 * Разбирает команду из `scripts["test:raw"]` и добавляет TAP-репортёр.
 * Список файлов при этом не дублируется: аргументы берутся из скрипта как есть.
 *
 * @param {{scripts?: Record<string, string>}} packageJson
 * @returns {{command: string, args: string[]}}
 */
export function buildTestCommand(packageJson) {
  const script = packageJson?.scripts?.[RAW_SCRIPT];
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(
      `в package.json нет строки scripts["${RAW_SCRIPT}"] — список тестов брать неоткуда ` +
      '(единственный источник списка файлов, карточка CI-2 §4.1)'
    );
  }
  const [command, ...args] = script.trim().split(/\s+/);
  const testIndex = args.indexOf('--test');
  if (testIndex === -1) {
    throw new Error(`scripts["${RAW_SCRIPT}"] не запускает \`node --test\`: TAP-отчёт получить не из чего`);
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
 * Новые тестовые файлы, которых нет в списке `test:raw`.
 *
 * UP-1 §3.2: молча потерянный тест — это тот же скрытый пропуск, что и
 * `skip`. Раннер запускает только перечисленные файлы, поэтому новый
 * `tests/*.test.mjs` без строки в списке не выполняется и «зелёный» прогон
 * врёт. Функция сравнивает файлы на диске со списком и возвращает
 * неучтённые — страж краснеет, пока файл не добавлен осознанно.
 *
 * @param {string[]} onDisk имена файлов из `tests/`
 * @param {string[]} listed файлы из аргументов `scripts["test:raw"]`
 * @returns {string[]} имена файлов на диске, которых нет в списке
 */
export function findUnlistedTestFiles(onDisk, listed) {
  const listedSet = new Set(listed.map((file) => path.normalize(file)));
  return onDisk
    .filter((name) => TEST_FILE.test(name))
    .map((name) => path.normalize(path.join('tests', name)))
    .filter((relative) => !listedSet.has(relative))
    .sort();
}

/**
 * Аргументы карантинного прогона: та же команда плюс по одному якорному skip-флагу на имя.
 *
 * Флаги вставляются **до первого позиционного аргумента**: всё, что стоит после списка
 * файлов, раннер считает аргументами тестового процесса, и skip-паттерн молча не работает
 * (проверено на шаге 2: флаги в хвосте дали тот же TAP, что и полный прогон).
 *
 * @param {string[]} args
 * @param {string[]} names
 * @param {string} flag
 * @returns {string[]}
 */
export function buildSkipArgs(args, names, flag) {
  const firstPositional = args.findIndex((arg) => !arg.startsWith('-'));
  const at = firstPositional === -1 ? args.length : firstPositional;
  return [
    ...args.slice(0, at),
    ...names.map((name) => `${flag}=${escapeTapPattern(name)}`),
    ...args.slice(at)
  ];
}

/**
 * Раскодирует TAP-экранирование: `\#` → `#`, `\\` → `\`.
 * Нужно, чтобы имя совпадало с реестром независимо от того, экранировал его раннер или нет.
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
 *   skipped: string[],
 *   totals: {tests: number|null, pass: number|null, fail: number|null, skipped: number|null, todo: number|null},
 *   plan: number|null,
 *   complete: boolean
 * }}
 */
export function parseTap(text) {
  const failures = [];
  const passed = [];
  const skipped = [];
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
      } else if (isSkip) {
        skipped.push(name);
      } else {
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
  return { failures, passed, skipped, totals, plan, complete };
}

/**
 * Число тестов прогона: TAP-итог `# tests N`, иначе план `1..N`.
 *
 * @param {{totals: {tests: number|null}, plan: number|null}} parsed
 * @returns {number|null}
 */
export function testCount(parsed) {
  return parsed?.totals?.tests ?? parsed?.plan ?? null;
}

/**
 * Сверяет падения прогона 1 с реестром.
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
 * Вердикт стража по двум TAP-потокам: чистая функция, покрыта
 * `tests/check-test-baseline.test.mjs` на синтетических фикстурах.
 *
 * @param {{
 *   baseline: {name: string, file?: string, knownSince?: string}[],
 *   run1: {exitCode: number|null, tapText: string, signal?: string|null},
 *   run2: {exitCode: number|null, tapText: string, signal?: string|null},
 *   commands?: {run1?: string, run2?: string}
 * }} input
 * @returns {{code: number, text: string, failures: string[], newFailures: string[], staleBaseline: string[], n1: number|null, n2: number|null}}
 */
export function evaluateGuard({ baseline, run1, run2, commands = {} }) {
  const expected = baseline.map((entry) => decodeTapName(entry.name));
  const parsed1 = parseTap(run1?.tapText ?? '');
  const parsed2 = parseTap(run2?.tapText ?? '');
  const header = [
    ...(commands.run1 ? [`прогон 1 (целостность, без skip-флагов): ${commands.run1}`] : []),
    ...(commands.run2 ? [`прогон 2 (карантин, ${expected.length} skip-флагов): ${commands.run2}`] : [])
  ];
  const totalsLine = (tag, parsed) => `${tag}: тестов ${testCount(parsed) ?? '?'}, pass ${parsed.totals.pass ?? '?'}, ` +
    `fail ${parsed.totals.fail ?? '?'}, skipped ${parsed.totals.skipped ?? '?'}, todo ${parsed.totals.todo ?? '?'}`;

  /** @type {string[]} */
  const sections = [];
  const crash = (tag, run, parsed) => {
    sections.push(
      `КРЭШ ПРОГОНА ТЕСТОВ (${tag}): процесс умер, не дойдя до TAP-итогов.`,
      `  код возврата: ${run?.exitCode === null || run?.exitCode === undefined ? 'нет (процесс убит)' : run.exitCode}` +
        (run?.signal ? `, сигнал: ${run.signal}` : ''),
      `  TAP-итогов нет: не найдено ни строки «# tests N», ни плана «1..N»; распознано падений: ${parsed.failures.length}`,
      '  Под реестр карантина это состояние не маскируется: чините причину, а не реестр.'
    );
    if (parsed.failures.length) {
      sections.push('  Успели упасть до обрыва:', ...parsed.failures.map((name) => `    - ${name}`));
    }
  };

  // 1. Крэш любого прогона — первым и отдельным сообщением.
  const crashes = [];
  if (run1?.signal || !parsed1.complete) crashes.push(['прогон 1 из 2', run1, parsed1]);
  if (run2?.signal || !parsed2.complete) crashes.push(['прогон 2 из 2', run2, parsed2]);
  if (crashes.length) {
    for (const [tag, run, parsed] of crashes) crash(tag, run, parsed);
    return {
      code: 1,
      text: [...header, 'СТРАЖ: КРАСНЫЙ — прогон тестов не дошёл до TAP-итогов', ...sections].join('\n'),
      failures: parsed1.failures,
      newFailures: parsed1.failures,
      staleBaseline: [],
      n1: testCount(parsed1),
      n2: testCount(parsed2)
    };
  }

  const comparison = compareWithBaseline(parsed1.failures, baseline);
  const n1 = testCount(parsed1);
  const n2 = testCount(parsed2);
  const run2Failures = [...new Set(parsed2.failures)];
  const totals = [totalsLine('прогон 1', parsed1), totalsLine('прогон 2', parsed2)];

  const red = (blocks) => {
    const lines = blocks.flatMap((block) => [block.title, ...block.body]);
    return {
      code: 1,
      text: [...header, ...totals, 'СТРАЖ: КРАСНЫЙ — карантин не держит', ...lines].join('\n'),
      failures: parsed1.failures,
      ...comparison,
      run2Failures,
      n1,
      n2
    };
  };

  // 2. Расхождение множества падений прогона 1 с реестром. Обе секции печатаются вместе:
  //    переименование теста даёт одновременно «новое» имя и «мёртвую» запись реестра,
  //    и увидеть надо обе половины картины, а не только первую.
  const mismatch = [];
  if (comparison.newFailures.length) {
    mismatch.push({
      title: 'НОВЫЕ ПАДЕНИЯ:',
      body: [
        ...comparison.newFailures.map((name) => `  · ${name}`),
        'Этих имён нет в tools/known-test-failures.json: карантин не расширяется, падение чинится.',
        'Расширять реестр без отдельного решения владельца запрещено (карточка CI-2 §2).'
      ]
    });
  }
  if (comparison.staleBaseline.length) {
    mismatch.push({
      title: 'КАРАНТИН НЕ ПРИМЕНЁН: устаревшие имена реестра',
      body: [
        ...comparison.staleBaseline.map((name) => `  · ${name}`),
        'Эти имена есть в реестре, но в полном прогоне не падают (починка, переименование, удаление).',
        'Обновите tools/known-test-failures.json в этом же PR: мёртвая запись сделала бы карантин фиктивным.'
      ]
    });
  }
  if (mismatch.length) return red(mismatch);

  // 3. Падений в TAP нет, а процесс полного прогона упал: это поломка прогона, не «зелёный».
  if (!parsed1.failures.length && run1?.exitCode !== 0) {
    return red([{
      title: 'КАРАНТИН НЕ ПРИМЕНЁН: полный прогон завершился с ошибкой без падений в TAP',
      body: [`  код возврата прогона 1: ${run1?.exitCode}; такой прогон под реестр не подводится.`]
    }]);
  }

  // 4. Карантинный прогон обязан быть чистым и короче полного ровно на реестр.
  const problems = [];
  if (run2Failures.length) {
    problems.push(
      '  not ok в карантинном прогоне (skip-паттерн не сматчился или слишком узкий):',
      ...run2Failures.map((name) => `    · ${name}`)
    );
  }
  if (n1 !== null && n2 !== null && n2 !== n1 - expected.length) {
    problems.push(
      `  арифметика не сошлась: N1 = ${n1}, N2 = ${n2}, ожидалось N2 = N1 − ${expected.length} = ${n1 - expected.length}.`,
      '    Лишняя фильтрация или сломавшийся паттерн: проверьте экранирование и якоря ^…$.'
    );
  }
  if (run2?.exitCode !== 0) {
    problems.push(`  код возврата прогона 2: ${run2?.exitCode}, ожидался 0.`);
  }
  if (problems.length) {
    return red([{ title: 'КАРАНТИН НЕ ПРИМЕНЁН: карантинный прогон не сошёлся', body: problems }]);
  }

  // 6. Оба прогона согласны: карантин применён точечно, новых падений нет.
  const filtered = n1 !== null && n2 !== null ? n1 - n2 : expected.length;
  const lines = [
    `карантин этапа 8: прогон 1 — ${comparison.matched}/${expected.length} реестровых падений; ` +
      `прогон 2 — отфильтровано ${filtered}, not ok 0; новых падений нет`,
    ...baseline.map((entry) => `  ✓ ${entry.name} [${entry.file}, ${entry.knownSince}]`),
    'СТРАЖ: ОК — карантин применён к реестру точечно, регрессий нет'
  ];
  return {
    code: 0,
    text: [...header, ...totals, ...lines].join('\n'),
    failures: parsed1.failures,
    ...comparison,
    run2Failures,
    n1,
    n2
  };
}

/**
 * Читает и валидирует реестр карантина: объект `{meta, tests[]}`.
 * Форма `meta` обязательна (намеренность, дата, ссылки, условие снятия) — иначе карантин
 * без срока и владельца.
 *
 * @param {string} [baselinePath]
 * @returns {{meta: Record<string, unknown>, tests: {name: string, file: string, contour: string, knownSince: string, reason: string}[]}}
 */
export function loadRegistry(baselinePath = BASELINE_PATH) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${baselinePath}: ожидался объект с полями meta и tests (схема карточки CI-2 §4.3)`);
  }
  const meta = parsed.meta;
  if (typeof meta !== 'object' || meta === null) throw new Error(`${baselinePath}: нет блока meta`);
  for (const field of ['purpose', 'date', 'removal']) {
    if (typeof meta[field] !== 'string' || !meta[field].trim()) {
      throw new Error(`${baselinePath}: meta без поля ${field}`);
    }
  }
  if (!Array.isArray(meta.references) || !meta.references.length) {
    throw new Error(`${baselinePath}: meta.references должен ссылаться на S8-Q1 и карточку CI-2`);
  }
  if (!Array.isArray(parsed.tests)) throw new Error(`${baselinePath}: tests должен быть массивом`);
  parsed.tests.forEach((entry, index) => {
    for (const field of ['name', 'file', 'contour', 'knownSince', 'reason']) {
      if (typeof entry?.[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`${baselinePath}: запись ${index} без поля ${field}`);
      }
    }
  });
  return { meta, tests: parsed.tests };
}

/**
 * Список записей реестра — то, что нужно сверке и построению флагов.
 *
 * @param {string} [baselinePath]
 * @returns {{name: string, file: string, contour: string, knownSince: string, reason: string}[]}
 */
export function loadBaseline(baselinePath = BASELINE_PATH) {
  return loadRegistry(baselinePath).tests;
}

/**
 * Запускает команду тестов и возвращает TAP и код выхода.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{exitCode: number|null, signal: string|null, tapText: string, error: Error|null}}
 */
function runTests(command, args) {
  const result = spawnSync(command === 'node' ? process.execPath : command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' }
  });
  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    tapText: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    error: result.error ?? null
  };
}

function main() {
  let baseline;
  let command;
  let skipFlag;
  try {
    baseline = loadBaseline();
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
    command = buildTestCommand(pkg);
    const help = runTests('node', ['--help']);
    skipFlag = detectSkipFlag(help.tapText).flag;
  } catch (error) {
    process.stderr.write(`ОШИБКА ОКРУЖЕНИЯ: ${error.message}\n`);
    process.exit(2);
  }
  if (!skipFlag) {
    process.stderr.write(
      'ОШИБКА ОКРУЖЕНИЯ: рантайм не знает ни одного skip-флага для node:test ' +
      `(проверены ${SKIP_FLAGS.join(', ')} по выводу node --help).\n` +
      '  Карантин на уровне раннера невозможен; маскировать отсутствие флага запрещено (карточка CI-2 §4.2).\n'
    );
    process.exit(2);
  }

  const files = testFiles(command.args);
  // UP-1 §3.2: файл в tests/, которого нет в списке, не выполняется молча.
  // Проверка стоит до прогонов: потерянный тест хуже красного падения.
  let unlisted = [];
  try {
    unlisted = findUnlistedTestFiles(readdirSync(path.join(ROOT, 'tests')), files);
  } catch (error) {
    process.stderr.write(`ОШИБКА ОКРУЖЕНИЯ: не удалось прочитать tests/: ${error.message}\n`);
    process.exit(2);
  }
  if (unlisted.length) {
    const lines = [
      `Страж карантина этапа 8 (два прогона): ${path.relative(ROOT, BASELINE_PATH)}`,
      `  список файлов взят из package.json scripts["${RAW_SCRIPT}"]: ${files.length} шт.`,
      '',
      'СТРАЖ: КРАСНЫЙ — НОВЫЕ ТЕСТОВЫЕ ФАЙЛЫ ВНЕ СПИСКА',
      ...unlisted.map((file) => `  · ${file} — нет в scripts["${RAW_SCRIPT}"]`),
      '  Раннер выполняет только перечисленные файлы: такой тест не запускается и молча теряется.',
      `  Добавьте файл в scripts["${RAW_SCRIPT}"] (package.json) в этом же PR.`
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exit(1);
  }
  const run1Args = command.args;
  const run2Args = buildSkipArgs(command.args, baseline.map((entry) => entry.name), skipFlag);
  const printable1 = `${command.command} ${run1Args.join(' ')}`;
  const printable2 = `${command.command} ${run2Args.join(' ')}`;

  process.stdout.write(
    `Страж карантина этапа 8 (два прогона): ${path.relative(ROOT, BASELINE_PATH)}\n` +
    `  список файлов взят из package.json scripts["${RAW_SCRIPT}"]: ${files.length} шт.\n` +
    `  skip-флаг определён по node --help: ${skipFlag}; записей в реестре: ${baseline.length}\n`
  );

  const first = runTests(command.command, run1Args);
  if (first.error) {
    process.stdout.write(`СТРАЖ: КРАСНЫЙ — прогон 1 не запустился\nКРЭШ ПРОГОНА ТЕСТОВ (прогон 1 из 2): ${first.error.message}\n`);
    process.exit(1);
  }
  const second = runTests(command.command, run2Args);
  if (second.error) {
    process.stdout.write(`СТРАЖ: КРАСНЫЙ — прогон 2 не запустился\nКРЭШ ПРОГОНА ТЕСТОВ (прогон 2 из 2): ${second.error.message}\n`);
    process.exit(1);
  }

  const verdict = evaluateGuard({
    baseline,
    run1: first,
    run2: second,
    commands: { run1: printable1, run2: printable2 }
  });

  if (verdict.code !== 0) {
    // Диагностика провала: полные логи обоих прогонов, иначе по именам не починить.
    process.stdout.write('\n--- полный лог прогона 1 (без skip-флагов) ---\n');
    process.stdout.write(first.tapText.trimEnd() + '\n--- конец лога прогона 1 ---\n');
    process.stdout.write('\n--- полный лог прогона 2 (карантин) ---\n');
    process.stdout.write(second.tapText.trimEnd() + '\n--- конец лога прогона 2 ---\n\n');
  }
  process.stdout.write(verdict.text + '\n');
  process.exit(verdict.code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
