#!/usr/bin/env node
/**
 * Быстрый локальный гейт (`L0`): стык импортов, типы, линт и точечный прогон тестов.
 *
 * Зачем: в репозитории проверки распределены по скорости по-разному. `tsc --noEmit`
 * (`1.2 с`) и `eslint` (`8 с`) видят `src/` и `site/`, но **не видят** `tests/**`:
 * `tsconfig.json` их не включает, а ESLint проверяет там только `no-undef`. Поэтому
 * опечатка в имени экспорта (`import { applyPairOverlayOrder } from '…/pairs.ts'`) не
 * ловится ничем, кроме фактического запуска теста. А запуск — самый дорогой шаг:
 * одиночный прогон `tests/**` ≈ `70 с`, полный страж `tools/check_test_baseline.mjs`
 * (два прогона) ≈ `135 с`. Так дорогая команда становится единственным способом узнать
 * имя символа, и локальный цикл раздувается до минут на каждую правку.
 *
 * Этот гейт отвечает на вопрос «сходится ли стык» за секунды, ничего не подменяя:
 *   1. **стык импортов и синтаксис** — `esbuild` собирает каждый тест/инструмент в
 *      памяти (`bundle`, `write: false`). Отсутствующий экспорт и кривой импорт — это
 *      ошибка сборки, она видна за `~0.4 с` на все 49 файлов, без запуска кода;
 *   2. **типы** — `tsc --noEmit` по `tsconfig.json` (строгие настройки репозитория);
 *   3. **линт** — `eslint` (правило `no-undef`) только по затронутым файлам;
 *   4. **поведение** — `node --test` только по затронутым тест-файлам (`--run`).
 *
 * Список тест-файлов не дублируется: единственный источник — `scripts["test:raw"]`
 * в `package.json` (то же правило, что у стража карантина `CI-2`).
 *
 * Запуск:
 *   node tools/check_fast.mjs --probe tests/foo.test.mjs   # моя проба/тест целиком
 *   node tools/check_fast.mjs                              # изменённые файлы (git)
 *   node tools/check_fast.mjs --all                        # все тесты и инструменты
 *   node tools/check_fast.mjs --run                        # ещё и запустить тесты изменённых файлов
 *
 * Код возврата: `0` — чисто; `1` — найдены проблемы; `2` — ошибка окружения
 * (нет `package.json`, нет `esbuild`, не найден файл пробы).
 */

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: от него считаются пути в отчётах. */
export const ROOT = path.resolve(HERE, '..');
/** Скрипт-источник списка тестов (правило `CI-2`: свой список не ведём). */
export const RAW_SCRIPT = 'test:raw';
/** Файл теста или пробы: `.test.`/`.spec.` в имени. */
const PROBE_RE = /\.(?:test|spec)\.(?:[cm]?[jt]s)$/;

/**
 * Является ли путь тест-файлом (пробой).
 * @param {string} file путь относительно корня или абсолютный
 * @returns {boolean}
 */
export function isProbeFile(file) {
  return PROBE_RE.test(file);
}

/**
 * Достаёт список тест-файлов из `scripts["test:raw"]` — без собственного перечня.
 * @param {{scripts?: Record<string, string>}} packageJson
 * @returns {string[]} пути как записаны в скрипте
 */
export function probeFilesFromPackage(packageJson) {
  const script = packageJson?.scripts?.[RAW_SCRIPT];
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error(`в package.json нет scripts["${RAW_SCRIPT}"] — список тестов брать неоткуда`);
  }
  return script
    .trim()
    .split(/\s+/)
    .filter((arg) => PROBE_RE.test(arg));
}

/**
 * Разбирает `git status --porcelain` в список путей (включая неотслеживаемые).
 * @param {string} text вывод `git status --porcelain`
 * @returns {string[]}
 */
export function parsePorcelain(text) {
  const files = [];
  for (const line of String(text).split('\n')) {
    if (line.trim().length < 4) continue;
    const body = line.slice(3).trim();
    // Переименование: `R  старый -> новый` — нужен новый путь.
    const arrow = body.indexOf(' -> ');
    files.push(arrow === -1 ? body : body.slice(arrow + 4));
  }
  return files;
}

/**
 * Отбирает из списка изменённых файлов те, что этот гейт умеет проверять.
 * @param {string[]} files пути
 * @returns {{probes: string[], sources: string[]}}
 */
export function selectChanged(files) {
  const probes = [];
  const sources = [];
  for (const file of files) {
    if (!/^(?:tests|tools|src|site)\//.test(file)) continue;
    if (!/\.(?:[cm]?[jt]s)$/.test(file)) continue;
    (isProbeFile(file) ? probes : sources).push(file);
  }
  return { probes, sources };
}

/**
 * Проверяет стык импортов и синтаксис: собирает файл в памяти и не исполняет его.
 * @param {string[]} files пути относительно корня
 * @returns {Promise<{file: string, messages: string[]}[]>} проблемы по файлам
 */
export async function importProblems(files) {
  const problems = [];
  for (const file of files) {
    try {
      await build({
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
 * Запускает бинарь из `node_modules/.bin` (через `npm`-скрипт его знает только shell,
 * поэтому путь берётся явно, а не по разрешению модулей Node).
 * @param {string} bin имя бинаря в `node_modules/.bin`
 * @param {string[]} args аргументы
 */
function runBin(bin, args) {
  const result = spawnSync(path.join(ROOT, 'node_modules', '.bin', bin), args, { cwd: ROOT, encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Запускает команду из корня и отдаёт код возврата и объединённый вывод. */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

/** Изменённые файлы по Git: рабочее дерево плюс разница с `main`. */
function changedFiles() {
  const status = run('git', ['status', '--porcelain']);
  if (status.code !== 0) return null;
  const diff = run('git', ['diff', '--name-only', 'main...HEAD']);
  return [...new Set([...parsePorcelain(status.output), ...(diff.code === 0 ? diff.output.split('\n') : [])])]
    .filter((file) => file.length > 0);
}

/**
 * Главная процедура гейта.
 * @param {string[]} argv аргументы командной строки
 * @returns {Promise<number>} код возврата
 */
export async function main(argv) {
  const args = new Set(argv);
  const probeIndex = argv.indexOf('--probe');
  const single = probeIndex !== -1 ? argv[probeIndex + 1] : null;

  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    console.error('СТОП: не читается package.json — запускать из корня репозитория');
    return 2;
  }

  let probes;
  let extraSources = [];
  if (single) {
    if (!existsSync(path.join(ROOT, single))) {
      console.error(`СТОП: файл пробы не найден: ${single}`);
      return 2;
    }
    probes = [single];
  } else if (args.has('--all')) {
    probes = probeFilesFromPackage(packageJson);
    extraSources = ['tools/check_fast.mjs'];
  } else {
    const files = changedFiles();
    if (files === null) {
      console.error('СТОП: git недоступен — используйте --all или --probe <файл>');
      return 2;
    }
    const selected = selectChanged(files);
    probes = selected.probes;
    extraSources = selected.sources;
    if (probes.length === 0 && extraSources.length === 0) {
      console.log('БЫСТРЫЙ ГЕЙТ: изменений в проверяемых путях нет');
      return 0;
    }
  }

  const started = Date.now();
  let failed = false;

  const linkProblems = await importProblems([...probes, ...extraSources]);
  if (linkProblems.length > 0) {
    failed = true;
    console.log(`СТЫК ИМПОРТОВ: ${linkProblems.length} файл(ов) не собираются`);
    for (const problem of linkProblems) {
      for (const message of problem.messages) console.log(`  ✗ ${message}`);
    }
  } else {
    console.log(`стык импортов: ок (${probes.length + extraSources.length} файл(ов))`);
  }

  if (!single) {
    const types = runBin('tsc', ['--noEmit']);
    if (types.code !== 0) {
      failed = true;
      console.log(`ТИПЫ: ошибки tsc --noEmit\n${types.output}`);
    } else {
      console.log('типы: ок (tsc --noEmit)');
    }

    const targets = [...probes, ...extraSources];
    if (targets.length > 0) {
      const lint = runBin('eslint', targets);
      if (lint.code !== 0) {
        failed = true;
        console.log(`ЛИНТ: ошибки eslint\n${lint.output}`);
      } else {
        console.log(`линт: ок (${targets.length} файл(ов))`);
      }
    }
  }

  if (args.has('--run') && !failed && probes.length > 0) {
    const tests = run(process.execPath, ['--test', ...probes]);
    if (tests.code !== 0) {
      failed = true;
      console.log(`ТЕСТЫ: красный прогон\n${tests.output}`);
    } else {
      console.log(`тесты: ок (${probes.length} файл(ов))`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`БЫСТРЫЙ ГЕЙТ: ${failed ? 'КРАСНЫЙ' : 'зелёный'}, ${elapsed} с`);
  return failed ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
