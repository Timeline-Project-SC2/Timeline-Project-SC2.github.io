#!/usr/bin/env node
/**
 * Быстрый локальный гейт (`L0`): стык импортов, линт и (где применимо) типы.
 *
 * Зачем: `tsconfig.json` не включает `tests/`, а ESLint проверяет там только `no-undef`.
 * Поэтому выдуманное имя экспорта проходит `npm run typecheck` и `npm run lint` зелёным
 * и падает только запуском теста — самой дорогой командой репозитория (`node --test` по
 * списку `test:raw` ≈ 71 с, страж карантина ≈ 135 с). Дешёвый ответ на вопрос
 * «сходится ли стык» даёт сборка `esbuild` без исполнения кода.
 *
 * Принцип: гейт **либо проверяет заявленный набор, либо явно говорит, что не смог**.
 * Ложный «зелёный» недопустим, поэтому:
 *   - ошибка Git, отсутствие базы, падение инструмента или недоступная зависимость —
 *     `exit 2` с причиной, а не «изменений нет»;
 *   - пустой отбор печатается как `ПРОПУСК` с перечнем отфильтрованных путей;
 *   - итоговая строка всегда перечисляет, что именно было проверено.
 *
 * Режимы:
 *   node tools/check_fast.mjs [--base <ref>]        изменённые файлы: рабочее дерево + diff базы
 *   node tools/check_fast.mjs --probe <файл>        одна проба/тест/исходник
 *   node tools/check_fast.mjs --all                 N тест-файлов из scripts["test:raw"] + сам гейт
 *   node tools/check_fast.mjs ... --run             дополнительно запустить выбранные тесты
 *
 * Область `--all` (точная): список `test:raw` из `package.json` плюс `tools/check_fast.mjs`.
 * Это **не** все тесты репозитория: файлы `tests/*.test.*`, которых нет в `test:raw`
 * (например `tests/sector-admin-edit.test.mjs`, он же `npm run test:sector-admin-edit`),
 * в `--all` не входят — гейт не ведёт свой список тестов (правило карточки `CI-2`).
 *
 * `--run` запускает выбранные файлы напрямую, **без карантинного стража**
 * (`tools/check_test_baseline.mjs`): восемь известных падений этапа 8 остаются падениями,
 * прогон идёт с `--test-concurrency=1` для детерминизма. Зелёный `--run` не равен
 * зелёному `npm test` и не заменяет проверку поведения для всего набора.
 *
 * Пределы проверки стыка (важно): `esbuild` резолвит только статические импорты
 * выбранных entry points при сборке под Node.
 *   - имена экспортов `node:*` **не** проверяются (`external: ['node:*']`): импорт
 *     несуществующего имени из `node:fs` пройдёт гейт зелёным и упадёт в рантайме;
 *   - динамические `import()` с вычисляемым путём, `require` в CJS, условные экспорты
 *     и различия Node/browser не проверяются;
 *   - AssemblyScript-исходники `src/planet/assembly/**` (декораторы `@inline`,
 *     `@fastMath`) собираются своим компилятором и здесь пропускаются явным сообщением;
 *   - гейт не проверяет поведение: зелёный `check:fast` не означает, что логика верна.
 *
 * Адресат: исполнитель (воркер) и QA-роль `rc-04`. Для Гайдлайнера `rc-07` действует
 * правило О-5 (`docs/agents_task_orchestration/waves/protocol.md`): код он не читает и не
 * запускает, `check:fast` его исключением не становится.
 *
 * Код возврата: `0` — проверено и чисто либо нечего проверять (явно помечено `ПРОПУСК`);
 * `1` — найдены проблемы; `2` — проверить невозможно (среда, Git, база, инструменты).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: от него считаются пути в отчётах. */
export const ROOT = path.resolve(HERE, '..');
/** Скрипт-источник списка тестов (правило `CI-2`: свой список не ведём). */
export const RAW_SCRIPT = 'test:raw';
/** Коды возврата: различие «не чисто» и «не смог проверить» обязательно. */
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, ENV: 2 });
/** Порядок поиска базы для diff, если не задан `--base`. */
export const BASE_CANDIDATES = ['main', 'origin/main'];
/** Каталоги, файлы которых гейт умеет проверять. */
export const ZONE = /^(?:tests|tools|src|site)\//;
/** Расширения проверяемых файлов. */
const CODE_EXT = /\.(?:[cm]?[jt]s)$/;
/** Файл теста или пробы. */
const PROBE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;
/** AssemblyScript: свой компилятор, декораторы — вне esbuild. */
const ASSEMBLY_DIR = 'src/planet/assembly/';

/**
 * Является ли путь тест-файлом (пробой).
 * @param {string} file путь
 * @returns {boolean}
 */
export function isProbeFile(file) {
  return PROBE_RE.test(file);
}

/**
 * Достаёт список тест-файлов из `scripts["test:raw"]` — без собственного перечня.
 * @param {{scripts?: Record<string, string>}} packageJson
 * @returns {string[]}
 */
export function probeFilesFromPackage(packageJson) {
  const script = packageJson?.scripts?.[RAW_SCRIPT];
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(`в package.json нет scripts["${RAW_SCRIPT}"] — список тестов брать неоткуда`);
  }
  return script.trim().split(/\s+/).filter((arg) => PROBE_RE.test(arg));
}

/**
 * Разбирает `git status --porcelain=v1 -z --untracked-files=all`.
 *
 * В NUL-режиме имена не экранируются и не берутся в кавычки, поэтому пробелы,
 * не-ASCII (`core.quotePath` не действует), переводы строк и первый байт статуса
 * сохраняются как есть. Переименование/копия — две записи: `<XY new>` и `<old>`.
 *
 * @param {string} text вывод с `-z` (разделитель `\0`)
 * @returns {{status: string, path: string, from: string | null}[]}
 */
export function parsePorcelainZ(text) {
  const tokens = String(text).split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const head = tokens[i];
    if (!head || head.length < 4) continue;
    const status = head.slice(0, 2);
    const file = head.slice(3);
    if (!file) continue;
    let from = null;
    if (status[0] === 'R' || status[0] === 'C') {
      from = tokens[i + 1] ?? null;
      i += 1;
    }
    entries.push({ status, path: file, from });
  }
  return entries;
}

/**
 * Разбирает `git diff --name-status -z <base>...HEAD`.
 * Запись статуса (`M`, `D`, `R100`, …) — отдельный токен; у `R`/`C` далее два пути.
 * @param {string} text вывод с `-z`
 * @returns {{status: string, path: string, from: string | null}[]}
 */
export function parseNameStatusZ(text) {
  const tokens = String(text).split('\0').filter((token) => token.length > 0);
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!/^[A-Z][0-9]*$/.test(status)) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      const from = tokens[i + 1] ?? null;
      const to = tokens[i + 2] ?? null;
      i += 2;
      if (from && to) entries.push({ status, path: to, from });
      continue;
    }
    const file = tokens[i + 1] ?? null;
    i += 1;
    if (file) entries.push({ status, path: file, from: null });
  }
  return entries;
}

/**
 * Отбирает из списка изменённых путей те, что гейт умеет проверять.
 * @param {string[]} files пути
 * @returns {{probes: string[], sources: string[], outside: string[]}}
 */
export function selectChanged(files) {
  const probes = [];
  const sources = [];
  const outside = [];
  for (const file of files) {
    if (!ZONE.test(file) || !CODE_EXT.test(file)) {
      outside.push(file);
      continue;
    }
    (isProbeFile(file) ? probes : sources).push(file);
  }
  return { probes, sources, outside };
}

/**
 * Раскладывает записи Git на проверяемые, удалённые и вне зоны.
 * Удалённый файл проверять нечем: он больше не существует, и запуск по нему давал
 * ложный красный (esbuild «Could not resolve», eslint «No files matching»).
 *
 * @param {{status: string, path: string, from: string | null}[]} entries
 * @param {(p: string) => boolean} exists проверка существования (для тестов подменяемая)
 * @returns {{targets: string[], deleted: string[], outside: string[]}}
 */
export function planTargets(entries, exists) {
  const targets = [];
  const deleted = [];
  const outside = [];
  const seen = new Set();
  for (const entry of entries) {
    const file = entry.path;
    if (seen.has(file)) continue;
    seen.add(file);
    const inZone = ZONE.test(file) && CODE_EXT.test(file);
    if (!inZone) {
      outside.push(file);
      continue;
    }
    if (!exists(file)) {
      deleted.push(file);
      continue;
    }
    targets.push(file);
  }
  return { targets, deleted, outside };
}

/**
 * Собирает изменённые пути из Git. Любая ошибка — не «пусто», а причина.
 * @param {{run: (cmd: string, args: string[]) => {code: number, output: string, error?: string}}} io
 * @param {string} base разрешённая база для diff
 * @returns {{ok: true, entries: unknown[]} | {ok: false, reason: string}}
 */
export function collectChanged(io, base) {
  const status = io.run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.code !== 0) {
    return { ok: false, reason: `git status: ${status.error ?? status.output ?? 'код ' + status.code}` };
  }
  const diff = io.run('git', ['diff', '--name-status', '-z', `${base}...HEAD`]);
  if (diff.code !== 0) {
    return { ok: false, reason: `git diff ${base}...HEAD: ${diff.error ?? diff.output ?? 'код ' + diff.code}` };
  }
  return { ok: true, entries: [...parsePorcelainZ(status.output), ...parseNameStatusZ(diff.output)] };
}

/**
 * Определяет базу для diff: явный `--base`, иначе первый существующий кандидат.
 * @param {{run: Function}} io
 * @param {string | null} explicit
 * @returns {{ok: true, base: string} | {ok: false, reason: string}}
 */
export function resolveBase(io, explicit) {
  if (explicit) {
    const check = io.run('git', ['rev-parse', '--verify', '--quiet', `${explicit}^{commit}`]);
    if (check.code !== 0) return { ok: false, reason: `база «${explicit}» не найдена в этом клоне` };
    return { ok: true, base: explicit };
  }
  for (const candidate of BASE_CANDIDATES) {
    const check = io.run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
    if (check.code === 0) return { ok: true, base: candidate };
  }
  return {
    ok: false,
    reason: `не найдена база для diff (искал ${BASE_CANDIDATES.join(', ')}): укажите --base <ref>, `
      + 'например --base origin/main; без базы гейт не может отличить свои изменения от чужих',
  };
}

/**
 * Проверяет стык импортов и синтаксис: собирает файл в памяти и не исполняет его.
 * @param {string[]} files пути относительно корня
 * @param {Function} buildFn `esbuild.build`
 * @returns {Promise<{file: string, messages: string[]}[]>}
 */
export async function importProblems(files, buildFn) {
  const problems = [];
  for (const file of files) {
    try {
      await buildFn({
        entryPoints: [path.resolve(ROOT, file)],
        bundle: true,
        platform: 'node',
        format: 'esm',
        write: false,
        logLevel: 'silent',
        external: ['node:*'],
      });
    } catch (error) {
      const messages = (error?.errors ?? []).map((item) => {
        const where = item.location ? `:${item.location.line}:${item.location.column}` : '';
        return `${path.relative(ROOT, item.location?.file ?? file)}${where} ${item.text}`;
      });
      problems.push({ file, messages: messages.length > 0 ? messages : [String(error?.message ?? error)] });
    }
  }
  return problems;
}

/**
 * Нормализует путь пробы: `./src/x.ts`, `src//x.ts` → `src/x.ts`.
 * Без этого проверки контура (AssemblyScript, зона, покрытие правилами) обходились
 * приставкой `./` в аргументе.
 * @param {string} file путь как ввёл пользователь
 * @returns {string}
 */
export function normalizePath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/**
 * Покрыт ли файл проверкой типов по корневому `tsconfig.json` (правило, а не догадка):
 * `include` — `src/**\/*.ts`, `site/**\/*.ts`, `tools/*.ts`, `vite.config.mts`;
 * `allowJs: false` — значит `.js`, `.mjs`, `.cjs` не типизируются вообще.
 * @param {string} file нормализованный путь
 * @returns {boolean}
 */
export function coveredByProjectTypes(file) {
  if (file === 'vite.config.mts') return true;
  if (!/\.ts$/.test(file) || /\.d\.ts$/.test(file)) return false;
  if (file.startsWith('src/') || file.startsWith('site/')) return true;
  return /^tools\/[^/]+\.ts$/.test(file);
}

/**
 * Покрыт ли файл правилом ESLint с реальной конфигурацией.
 * В корневом `eslint.config.mjs` правила заданы для: `site/**\/*.js`, `site/**\/*.ts`,
 * `src/**\/*.ts`, `tools/**\/*.mjs`, `tests/**\/*.mjs`, `tools/bench_planet_baseline.mjs`,
 * `tests/**\/*.js`, `tools/bench_planet_baseline.mjs`. Прочие файлы ESLint молча
 * пропускает: `eslint` на файле без подходящего блока возвращает `0` и ничего не проверяет.
 * @param {string} file нормализованный путь
 * @returns {{covered: boolean, note: string}}
 */
export function coveredByLint(file) {
  // Точное соответствие блокам `eslint.config.mjs`: site — js и ts, src — только ts,
  // tools и tests — mjs, tests — ещё js. Всё остальное (.cjs, .mts, src/**/*.js) не покрыто.
  const covered = /^site\/.*\.(?:js|ts)$/.test(file)
    || /^src\/.*\.ts$/.test(file)
    || /^tools\/.*\.mjs$/.test(file)
    || /^tests\/.*\.(?:mjs|js)$/.test(file);
  if (covered) return { covered: true, note: '' };
  return {
    covered: false,
    note: 'нет блока eslint.config.mjs с правилами для этого пути (.cjs/.mts и src|site/**/*.js не покрыты)',
  };
}

/** Файл AssemblyScript: свой компилятор, декораторы `@inline`/`@fastMath`. */
export function isAssemblyScript(file) {
  return file.startsWith(ASSEMBLY_DIR);
}

/** Запуск бинаря из `node_modules/.bin` с отличением «нет бинаря» от «упал». */
function runBin(bin, args) {
  const full = path.join(ROOT, 'node_modules', '.bin', bin);
  if (!existsSync(full)) {
    return { code: EXIT.ENV, output: `не найден ${path.relative(ROOT, full)} — выполните npm ci`, missing: true };
  }
  const result = spawnSync(full, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) {
    return { code: EXIT.ENV, output: `не удалось запустить ${bin}: ${result.error.message}`, missing: true };
  }
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Запуск команды без обрезки вывода: `-z`-формат нельзя trim-ить. */
function runRaw(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) {
    return { code: EXIT.ENV, output: '', error: result.error.message };
  }
  return { code: result.status ?? 1, output: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Разбирает аргументы CLI. Неизвестный флаг и `--probe` без значения — ошибка,
 * а не молчаливый переход в другой режим.
 * @param {string[]} argv
 * @returns {{ok: true, mode: string, probe: string | null, run: boolean, base: string | null}
 *   | {ok: false, reason: string}}
 */
export function parseArgs(argv) {
  const options = { mode: 'git', probe: null, run: false, base: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--run') {
      options.run = true;
      continue;
    }
    if (arg === '--all') {
      if (options.mode === 'probe') return { ok: false, reason: '--all и --probe взаимоисключающие' };
      options.mode = 'all';
      continue;
    }
    if (arg === '--probe') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        return { ok: false, reason: 'у --probe нет значения: укажите путь, например --probe tests/x.test.mjs' };
      }
      if (options.mode === 'all') return { ok: false, reason: '--all и --probe взаимоисключающие' };
      options.mode = 'probe';
      options.probe = value;
      i += 1;
      continue;
    }
    if (arg === '--base') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { ok: false, reason: 'у --base нет значения: укажите ref' };
      options.base = value;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') return { ok: false, reason: '__help__' };
    return { ok: false, reason: `неизвестный аргумент «${arg}» (см. --help)` };
  }
  return { ok: true, ...options };
}

/** Короткий перечень путей: длинные наборы не печатаем целиком. */
export function brief(files, limit = 3) {
  if (files.length <= limit) return files.join(', ');
  return `${files.slice(0, limit).join(', ')}, … ещё ${files.length - limit}`;
}

/** Печатает справку. */
function usage() {
  console.log([
    'node tools/check_fast.mjs [--base <ref>] [--run]',
    'node tools/check_fast.mjs --probe <файл> [--run]',
    'node tools/check_fast.mjs --all [--run]',
    '',
    'Коды: 0 — проверено и чисто (или явный ПРОПУСК); 1 — проблемы; 2 — проверить невозможно.',
  ].join('\n'));
}

/**
 * Главная процедура гейта.
 * @param {string[]} argv аргументы командной строки
 * @param {{buildFn?: Function, io?: object}} [deps] подмена зависимостей (для тестов)
 * @returns {Promise<number>} код возврата
 */
export async function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.reason === '__help__') {
      usage();
      return EXIT.OK;
    }
    console.error(`СТОП: ${parsed.reason}`);
    return EXIT.ENV;
  }
  const io = deps.io ?? { run: runRaw };
  const t0 = Date.now();
  const log = (line) => console.log(line);
  const fail = (line) => {
    console.error(line);
    return EXIT.ENV;
  };

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (error) {
    return fail(`СТОП: не читается package.json (${error.message}) — запускать из корня репозитория`);
  }

  // --- выбор набора -------------------------------------------------------------
  let targets = [];
  let deleted = [];
  let outside = [];
  let scope = '';
  if (parsed.mode === 'probe') {
    const file = normalizePath(parsed.probe);
    if (!existsSync(path.join(ROOT, file))) return fail(`СТОП: файл пробы не найден: ${file}`);
    if (isAssemblyScript(file)) {
      return fail(`СТОП: ${file} — AssemblyScript (декораторы @inline/@fastMath); esbuild его не парсит. `
        + 'Гейт для этого контура не применим (его проверяет npm run check:planet-core)');
    }
    targets = [file];
    scope = 'одна проба';
  } else if (parsed.mode === 'all') {
    targets = probeFilesFromPackage(packageJson);
    const missing = targets.filter((file) => !existsSync(path.join(ROOT, file)));
    if (missing.length > 0) {
      return fail(`СТОП: scripts["${RAW_SCRIPT}"] ссылается на отсутствующие файлы: ${missing.join(', ')}`);
    }
    const known = new Set(targets);
    const adminEdit = 'tests/sector-admin-edit.test.mjs';
    const notInRaw = existsSync(path.join(ROOT, adminEdit)) && !known.has(adminEdit) ? [adminEdit] : [];
    targets = [...targets, 'tools/check_fast.mjs'];
    outside = notInRaw;
    scope = `scripts["${RAW_SCRIPT}"]: ${known.size} тест-файлов + tools/check_fast.mjs`;
    log(`область: ${scope}`);
    log('  это не «все тесты репозитория»: известный файл вне test:raw — '
      + `${notInRaw.length > 0 ? notInRaw.join(', ') : 'нет'}; полный перечень вне списка гейт не сканирует`);
  } else {
    const base = resolveBase(io, parsed.base);
    if (!base.ok) return fail(`СТОП: ${base.reason}`);
    const changed = collectChanged(io, base.base);
    if (!changed.ok) return fail(`СТОП: не удалось получить изменения — ${changed.reason}`);
    const planned = planTargets(changed.entries, (file) => existsSync(path.join(ROOT, file)));
    targets = planned.targets;
    deleted = planned.deleted;
    outside = planned.outside;
    scope = `изменённые файлы, база ${base.base} (${changed.entries.length} записей Git)`;
    const listed = targets.length + deleted.length;
    if (listed === 0 && outside.length === 0) {
      log('БЫСТРЫЙ ГЕЙТ: изменений нет (git status и diff базы пусты)');
      return EXIT.OK;
    }
    if (targets.length === 0) {
      log(`БЫСТРЫЙ ГЕЙТ: ПРОПУСК — проверять нечего. Область: ${scope}.`);
      if (deleted.length > 0) log(`  удалено (проверять нечего): ${deleted.join(', ')}`);
      if (outside.length > 0) log(`  вне зоны гейта: ${outside.join(', ')}`);
      return EXIT.OK;
    }
  }

  // --- проверки -----------------------------------------------------------------
  let failed = false;
  const assembly = targets.filter(isAssemblyScript);
  if (assembly.length > 0) {
    return fail(`СТОП: в наборе есть AssemblyScript (${assembly.join(', ')}): декораторы @inline/@fastMath `
      + 'esbuild не парсит. Уберите эти файлы из набора или проверьте контур через npm run check:planet-core');
  }
  if (deleted.length > 0) log(`удалено (не проверяется): ${deleted.length} — ${deleted.join(', ')}`);
  if (outside.length > 0) log(`вне зоны гейта: ${outside.length} — ${outside.join(', ')}`);

  const buildFn = deps.buildFn ?? (await loadEsbuild());
  if (typeof buildFn !== 'function') return fail(`СТОП: ${buildFn.error}`);

  const linkProblems = await importProblems(targets, buildFn);
  if (linkProblems.length > 0) {
    failed = true;
    log(`СТЫК ИМПОРТОВ: ${linkProblems.length} файл(ов) не собираются`);
    for (const problem of linkProblems) for (const message of problem.messages) log(`  ✗ ${message}`);
  } else {
    log(`стык импортов: ок (${targets.length} файл(ов)); node:* и динамические импорты не проверяются`);
  }

  const uncoveredTypes = targets.filter((file) => !coveredByProjectTypes(file));
  const uncoveredLint = targets
    .map((file) => ({ file, ...coveredByLint(file) }))
    .filter((item) => !item.covered);
  const checks = ['стык импортов'];
  if (uncoveredTypes.length === 0) {
    const types = runBin('tsc', ['--noEmit']);
    if (types.missing) return fail(`СТОП: ${types.output}`);
    if (types.code !== 0) {
      failed = true;
      log(`ТИПЫ: ошибки tsc --noEmit\n${types.output}`);
    } else {
      checks.push('типы проекта (tsc --noEmit)');
      log('типы: ок (tsc --noEmit)');
    }
  } else {
    log(`типы: НЕ ПРОВЕРЯЛОСЬ для ${uncoveredTypes.length} файл(ов) — вне include tsconfig.json `
      + `(tests/**, *.mjs, src|site/**/*.js при allowJs:false): ${brief(uncoveredTypes)}`);
  }

  const lint = runBin('eslint', targets);
  if (lint.missing) return fail(`СТОП: ${lint.output}`);
  if (lint.code !== 0) {
    failed = true;
    log(`ЛИНТ: ошибки eslint\n${lint.output}`);
  } else if (uncoveredLint.length > 0) {
    log(`линт: без правил для ${uncoveredLint.length} файл(ов) — eslint их молча пропускает: `
      + brief(uncoveredLint.map((item) => item.file)));
  } else {
    checks.push('линт (eslint, no-undef)');
    log(`линт: ок (${targets.length} файл(ов))`);
  }

  if (parsed.run) {
    if (failed) {
      log('тесты: не запускались — предыдущие проверки красные');
    } else {
      const probes = targets.filter(isProbeFile);
      if (probes.length === 0) {
        log('тесты: нечего запускать — среди выбранных файлов нет тестов');
      } else {
        log(`тесты: прогон ${probes.length} файл(ов) БЕЗ карантинного стража `
          + '(8 известных падений этапа 8 ожидаемы; это не npm test)');
        const tests = runRaw(process.execPath, ['--test', '--test-concurrency=1', ...probes]);
        if (tests.code !== 0) {
          failed = true;
          log(`ТЕСТЫ: красный прогон\n${tests.output}`);
        } else {
          checks.push('прогон тестов (без стража)');
          log(`тесты: ок (${probes.length} файл(ов))`);
        }
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (failed) {
    log(`БЫСТРЫЙ ГЕЙТ: КРАСНЫЙ, ${elapsed} с. Область: ${scope}`);
    return EXIT.FAIL;
  }
  log(`БЫСТРЫЙ ГЕЙТ: зелёный, ${elapsed} с. Проверено: ${checks.join(', ')}. Область: ${scope}`);
  return EXIT.OK;
}

/** Загружает `esbuild`; отсутствие зависимости — `exit 2`, а не трейсбек. */
async function loadEsbuild() {
  try {
    const mod = await import('esbuild');
    return mod.build;
  } catch (error) {
    return { error: `недоступен esbuild (${error?.message ?? error}) — выполните npm ci` };
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
