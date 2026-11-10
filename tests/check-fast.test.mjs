/* Быстрый локальный гейт `L0` — `tools/check_fast.mjs` (карточка «локальный цикл»).
 * -------------------------------------------------------------------------
 * Две группы проверок:
 *
 *   А. Чистые функции — разбор имён Git (NUL-формат, переименования, не-ASCII),
 *      отбор целей по существованию файла, разбор аргументов, покрытие типами.
 *      Это дешёвые регрессии на форматы, которые нельзя воспроизвести без Git.
 *
 *   Б. Настоящий CLI во временном git-репозитории — сценарии, которые независимое
 *      ревью нашло ложными: единственное изменённое в первой строке `git status`,
 *      staged-правка, удаление единственного файла, путь с пробелом, не-ASCII имя,
 *      файл в новой неотслеживаемой директории, переименование, отсутствие базы,
 *      падение git, `--probe` без значения, неизвестный флаг, включая коды возврата.
 *      Проверяется реальный вывод процесса, а не только функции.
 *
 *   Запуск: `node --test tests/check-fast.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  ROOT,
  collectChanged,
  coveredByProjectTypes,
  importProblems,
  isProbeFile,
  parseArgs,
  parseNameStatusZ,
  parsePorcelainZ,
  planTargets,
  probeFilesFromPackage,
  resolveBase,
  selectChanged,
} from '../tools/check_fast.mjs';

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const GATE = path.join(ROOT, 'tools', 'check_fast.mjs');

/** Запускает гейт в указанной папке и отдаёт код возврата и текст вывода. */
async function gate(cwd, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [GATE, ...args], { cwd, encoding: 'utf8' });
    return { code: 0, text: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, text: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * Временный git-репозиторий с файлами вида `tests/a.test.mjs`, `src/x.ts` и
 * симлинком на `node_modules` реального проекта (нужен `esbuild`, `tsc`, `eslint`).
 */
async function makeRepo(files = { 'tests/a.test.mjs': 'console.log(1);\n', 'src/one.ts': 'export const one = 1;\n' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-fast-cli-'));
  await run('git', ['init', '-q'], { cwd: dir });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await run('git', ['config', 'user.name', 'test'], { cwd: dir });
  await run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  // Гейт и package.json — часть базы: diff `main...HEAD` на старте пуст, и любое
  // дальнейшее изменение можно смело приписывать тесту.
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  writeFileSync(path.join(dir, 'tools', 'check_fast.mjs'), readFileSync(GATE, 'utf8'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:raw': 'node --test tests/a.test.mjs' } }));
  // Минимальные конфиги: гейт вызывает настоящие tsc и eslint, им нужны настройки.
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      allowImportingTsExtensions: true,
      noEmit: true,
      strict: true,
      isolatedModules: true,
      module: 'ESNext',
      moduleResolution: 'Bundler',
      target: 'ES2022',
      types: ['node'],
      skipLibCheck: true,
    },
    include: ['src/**/*.ts', 'tools/*.ts'],
  }));
  writeFileSync(path.join(dir, 'eslint.config.mjs'), readFileSync(path.join(ROOT, 'eslint.config.mjs'), 'utf8'));
  await run('git', ['add', '-A'], { cwd: dir });
  await run('git', ['commit', '-qm', 'base'], { cwd: dir });
  await run('git', ['branch', '-M', 'main'], { cwd: dir });
  await run('git', ['checkout', '-qb', 'work'], { cwd: dir });
  await run('ln', ['-s', path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules')]);
  return dir;
}

/** Гейт внутри копии репозитория: путь берём из копии, а не из исходного проекта. */
async function gateIn(dir, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(dir, 'tools', 'check_fast.mjs'), ...args], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { code: 0, text: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, text: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/* ------------------------------------------- А. чистые функции */

test('список тестов берётся из scripts["test:raw"], а не из своего перечня', () => {
  const probes = probeFilesFromPackage(pkg);
  assert.ok(probes.length > 0);
  assert.ok(probes.includes('tests/check-fast.test.mjs'), 'этот файл тоже в списке test:raw');
  assert.ok(probes.every((file) => isProbeFile(file)));
});

test('без scripts["test:raw"] гейт не выдумывает список', () => {
  assert.throws(() => probeFilesFromPackage({ scripts: {} }), /test:raw/);
});

test('NUL-разбор porcelain: первая строка, пробелы, не-ASCII, переименование', () => {
  const entries = parsePorcelainZ([
    ' M tests/first.test.mjs',
    'A  "tests/with space.test.mjs"',
    '?? tests/новая директория/тест.test.mjs',
    'R  tests/new-name.test.mjs',
    'tests/old-name.test.mjs',
    '',
  ].join('\0'));
  assert.deepEqual(entries.map((entry) => entry.path), [
    'tests/first.test.mjs',
    '"tests/with space.test.mjs"',
    'tests/новая директория/тест.test.mjs',
    'tests/new-name.test.mjs',
  ]);
  assert.equal(entries[0].status, ' M', 'ведущий байт статуса не теряется');
  assert.deepEqual(entries[3], { status: 'R ', path: 'tests/new-name.test.mjs', from: 'tests/old-name.test.mjs' });
});

test('NUL-разбор diff: M/D/R с отдельным токеном статуса', () => {
  const entries = parseNameStatusZ(['M', 'src/a.ts', 'D', 'tests/gone.test.mjs', 'R100', 'src/old.ts', 'src/new.ts', ''].join('\0'));
  assert.deepEqual(entries, [
    { status: 'M', path: 'src/a.ts', from: null },
    { status: 'D', path: 'tests/gone.test.mjs', from: null },
    { status: 'R100', path: 'src/new.ts', from: 'src/old.ts' },
  ]);
});

test('отбор целей: удалённое не проверяется, отсутствующее считается удалённым', () => {
  const existing = new Set(['tests/live.test.mjs']);
  const plan = planTargets([
    { status: 'M', path: 'tests/live.test.mjs', from: null },
    { status: 'D', path: 'tests/gone.test.mjs', from: null },
    { status: 'M', path: 'docs/readme.md', from: null },
  ], (file) => existing.has(file));
  assert.deepEqual(plan.targets, ['tests/live.test.mjs']);
  assert.deepEqual(plan.deleted, ['tests/gone.test.mjs']);
  assert.deepEqual(plan.outside, ['docs/readme.md']);
});

test('selectChanged различает пробы, исходники и пути вне зоны', () => {
  const selected = selectChanged(['src/atlas/x.ts', 'tests/y.test.mjs', 'docs/z.md', 'data/systems.csv']);
  assert.deepEqual(selected.probes, ['tests/y.test.mjs']);
  assert.deepEqual(selected.sources, ['src/atlas/x.ts']);
  assert.deepEqual(selected.outside, ['docs/z.md', 'data/systems.csv']);
});

test('аргументы: --probe без значения и неизвестный флаг — ошибка, а не другой режим', () => {
  assert.equal(parseArgs(['--probe']).ok, false);
  assert.equal(parseArgs(['--probe', '--run']).ok, false);
  assert.equal(parseArgs(['--unknown']).ok, false);
  assert.equal(parseArgs(['--all', '--probe', 'x']).ok, false);
  assert.equal(parseArgs(['--base']).ok, false);
  assert.deepEqual(parseArgs(['--probe', 'tests/x.test.mjs', '--run']), {
    ok: true, mode: 'probe', probe: 'tests/x.test.mjs', run: true, base: null,
  });
  assert.deepEqual(parseArgs([]), { ok: true, mode: 'git', probe: null, run: false, base: null });
});

test('покрытие типами проекта: src/site/tools .ts — да, tests/** и .mjs — нет', () => {
  assert.equal(coveredByProjectTypes('src/atlas/x.ts'), true);
  assert.equal(coveredByProjectTypes('tools/vite/x.ts'), false, 'include tsconfig — только tools/*.ts');
  assert.equal(coveredByProjectTypes('tools/check_fast.mjs'), false);
  assert.equal(coveredByProjectTypes('tests/x.test.mjs'), false);
  assert.equal(coveredByProjectTypes('site/shared/x.ts'), true);
});

test('стык импортов: несуществующий экспорт — проблема без запуска кода', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-fast-lib-'));
  try {
    writeFileSync(path.join(dir, 'module.mjs'), 'export const exists = 1;\n');
    writeFileSync(path.join(dir, 'probe.test.mjs'), "import { missingExport } from './module.mjs';\nconsole.log(missingExport);\n");
    const problems = await importProblems([path.relative(ROOT, path.join(dir, 'probe.test.mjs'))], (await import('esbuild')).build);
    assert.equal(problems.length, 1);
    assert.match(problems[0].messages.join('\n'), /No matching export/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------- Б. настоящий CLI во временном репозитории */

test('CLI: единственное изменение в первой строке git status не пропускается', async () => {
  const dir = await makeRepo();
  try {
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(2);\n');
    const result = await gateIn(dir, []);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /Область: изменённые файлы/, 'режим именно git, а не «изменений нет»');
    assert.match(result.text, /стык импортов: ок \(1 файл/);
    assert.doesNotMatch(result.text, /изменений нет/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: staged-правка без unstaged обнаружена', async () => {
  const dir = await makeRepo();
  try {
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(3);\n');
    await run('git', ['add', 'tests/a.test.mjs'], { cwd: dir });
    const result = await gateIn(dir, []);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /стык импортов: ок \(1 файл/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: удаление единственного файла — явный ПРОПУСК, а не ложный красный', async () => {
  const dir = await makeRepo();
  try {
    rmSync(path.join(dir, 'tests/a.test.mjs'));
    const result = await gateIn(dir, []);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /ПРОПУСК/);
    assert.match(result.text, /удалено \(проверять нечего\): tests\/a\.test\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: путь с пробелом и не-ASCII имя в новой директории', async () => {
  const dir = await makeRepo();
  try {
    mkdirSync(path.join(dir, 'tests', 'новая папка'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'with space.test.mjs'), 'console.log(4);\n');
    writeFileSync(path.join(dir, 'tests', 'новая папка', 'проба.test.mjs'), 'console.log(5);\n');
    await run('git', ['add', 'tests/with space.test.mjs'], { cwd: dir });
    const staged = await gateIn(dir, []);
    assert.equal(staged.code, 0, staged.text);
    assert.match(staged.text, /стык импортов: ок \(2 файл/, 'оба файла в наборе');
    assert.doesNotMatch(staged.text, /изменений нет/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: переименование теста проверяется по новому пути', async () => {
  const dir = await makeRepo();
  try {
    renameSync(path.join(dir, 'tests/a.test.mjs'), path.join(dir, 'tests/b.test.mjs'));
    await run('git', ['add', '-A'], { cwd: dir });
    const result = await gateIn(dir, []);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /стык импортов: ок \(1 файл/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: нет базы для diff — exit 2 с подсказкой, а не «изменений нет»', async () => {
  const dir = await makeRepo();
  try {
    await run('git', ['branch', '-m', 'main', 'other'], { cwd: dir });
    const result = await gateIn(dir, []);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /не найдена база для diff/);
    assert.match(result.text, /--base/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --base с несуществующим ref — exit 2', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--base', 'no-such-ref']);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /не найдена в этом клоне/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --probe без значения и неизвестный флаг — exit 2', async () => {
  const dir = await makeRepo();
  try {
    const noValue = await gateIn(dir, ['--probe']);
    assert.equal(noValue.code, 2, noValue.text);
    assert.match(noValue.text, /у --probe нет значения/);

    const unknown = await gateIn(dir, ['--probe-everything']);
    assert.equal(unknown.code, 2, unknown.text);
    assert.match(unknown.text, /неизвестный аргумент/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --probe не обещает типы для tests/** и прямо об этом сообщает', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--probe', 'tests/a.test.mjs']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /типы: НЕ ПРОВЕРЯЛОСЬ/);
    assert.match(result.text, /стык импортов/);
    assert.match(result.text, /линт: ок/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --probe для src/*.ts выполняет tsc и линт', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--probe', 'src/one.ts']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /типы: ок \(tsc --noEmit\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --all перечисляет фактическую область и не выдаётся за полный npm test', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--all']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /scripts\["test:raw"\]: 1 тест-файлов \+ tools\/check_fast\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: зелёный отчёт перечисляет, что именно проверено', async () => {
  const dir = await makeRepo();
  try {
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(6);\n');
    const result = await gateIn(dir, []);
    assert.match(result.text, /Проверено: стык импортов, типы проекта \(tsc --noEmit\), линт \(eslint, no-undef\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
