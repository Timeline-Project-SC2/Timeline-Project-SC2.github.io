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
  coveredByLint,
  coveredByProjectTypes,
  isAssemblyScript,
  normalizePath,
  importProblems,
  isProbeFile,
  parseArgs,
  parseNameStatusZ,
  parsePorcelainZ,
  planTargets,
  discoverTests,
  resolveBase,
  resolveProbePath,
  selectChanged,
} from '../tools/check_fast.mjs';

const run = promisify(execFile);
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

test('автопоиск тестов включает этот файл и оба расширения', () => {
  const probes = discoverTests();
  assert.ok(probes.includes('tests/check-fast.test.mjs'));
  assert.ok(probes.includes('tests/travel-planner.test.js'));
  assert.ok(probes.includes('tests/sector-admin-edit.test.mjs'));
  assert.ok(probes.every((file) => isProbeFile(file)));
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

test('покрытие типами проекта: только .ts из src/site/tools, allowJs:false отсекает JS', () => {
  assert.equal(coveredByProjectTypes('src/atlas/x.ts'), true);
  assert.equal(coveredByProjectTypes('site/shared/x.ts'), true);
  assert.equal(coveredByProjectTypes('tools/x.ts'), true);
  assert.equal(coveredByProjectTypes('tools/vite/x.ts'), false, 'include tsconfig — только tools/*.ts');
  assert.equal(coveredByProjectTypes('tools/check_fast.mjs'), false);
  assert.equal(coveredByProjectTypes('tests/x.test.mjs'), false);
  assert.equal(coveredByProjectTypes('src/review-probe.js'), false, 'allowJs:false — JS не типизируется');
  assert.equal(coveredByProjectTypes('site/x.js'), false);
});

test('покрытие линтом повторяет блоки eslint.config.mjs, а не каталог целиком', () => {
  assert.equal(coveredByLint('src/a.ts').covered, true);
  assert.equal(coveredByLint('site/a.js').covered, true);
  assert.equal(coveredByLint('site/a.ts').covered, true);
  assert.equal(coveredByLint('tests/a.test.mjs').covered, true);
  assert.equal(coveredByLint('tests/a.test.js').covered, true);
  assert.equal(coveredByLint('tools/x.mjs').covered, true);
  assert.equal(coveredByLint('src/a.js').covered, false, 'правил для src/**/*.js нет');
  assert.equal(coveredByLint('tools/x.ts').covered, false, 'правил для tools/**/*.ts нет');
  assert.equal(coveredByLint('x.cjs').covered, false);
});

test('канонизация пути: ./ .. // и обратные слэши обрабатываются одинаково', () => {
  const expected = 'src/planet/assembly/kernels.ts';
  for (const raw of [
    'src/planet/assembly/kernels.ts',
    './src/planet/assembly/kernels.ts',
    '././src/planet/assembly/kernels.ts',
    'src//planet//assembly/kernels.ts',
    'src/./planet/assembly/kernels.ts',
    'tests/../src/planet/assembly/kernels.ts',
    '.\\src\\planet\\assembly\\kernels.ts',
  ]) {
    assert.equal(normalizePath(raw), expected, raw);
    assert.equal(isAssemblyScript(normalizePath(raw)), true, raw);
  }
});

test('путь пробы вне репозитория отклоняется, а не превращается в «файл не найден»', () => {
  assert.equal(resolveProbePath('../outside.ts').ok, false);
  assert.equal(resolveProbePath('../../x.ts').ok, false);
  assert.equal(resolveProbePath('/etc/passwd').ok, false);
  assert.deepEqual(resolveProbePath('./src/a.ts'), { ok: true, path: 'src/a.ts' });
  assert.equal(resolveProbePath('tests/../src/a.ts').ok, true);
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
    assert.match(result.text, /типы: ок \(tsc --noEmit, покрыто файлов: 1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --all перечисляет фактическую область и не выдаётся за полный npm test', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--all']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /tests\/: 1 тест-файлов \+ tools\/check_fast\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: зелёный отчёт перечисляет, что именно проверено', async () => {
  const dir = await makeRepo();
  try {
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(6);\n');
    const result = await gateIn(dir, []);
    // Файл в наборе — `tests/*.mjs`: типы для него не проверяются (вне include tsconfig),
    // и гейт обязан сказать это, а не выдать «Проверено: типы».
    assert.match(result.text, /типы: НЕ ПРОВЕРЯЛОСЬ/);
    assert.match(result.text, /Проверено: стык импортов, линт \(eslint, no-undef\)\./);
    assert.doesNotMatch(result.text, /Проверено: [^.]*типы/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: JS в src/ не выдаётся за проверенный типами и линтом', async () => {
  const dir = await makeRepo({ 'src/review-probe.js': 'export const x = undeclaredVar;\n' });
  try {
    const result = await gateIn(dir, ['--probe', 'src/review-probe.js']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /типы: НЕ ПРОВЕРЯЛОСЬ/);
    assert.match(result.text, /линт: без правил/);
    assert.doesNotMatch(result.text, /типы: ок/);
    assert.match(result.text, /Проверено: стык импортов\./, 'в списке проверенного нет типов и линта');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: ./ перед путём AssemblyScript не обходит отказ', async () => {
  const dir = await makeRepo({ 'src/planet/assembly/kernels.ts': 'export function f(): i32 { return 1; }\n' });
  try {
    const plain = await gateIn(dir, ['--probe', 'src/planet/assembly/kernels.ts']);
    const dotted = await gateIn(dir, ['--probe', './src/planet/assembly/kernels.ts']);
    assert.equal(plain.code, 2, plain.text);
    assert.equal(dotted.code, 2, dotted.text);
    assert.match(dotted.text, /AssemblyScript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('CLI: смешанный набор — непокрытый тест не отменяет tsc для src/*.ts', async () => {
  const dir = await makeRepo({
    'src/bad.ts': 'export const bad: number = "строка";\n',
    'tests/a.test.mjs': 'console.log(1);\n',
  });
  try {
    const result = await gateIn(dir, ['--probe', 'src/bad.ts']);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /ТИПЫ: ошибки tsc/);
    assert.match(result.text, /TS2322/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: в наборе только tests/** — tsc честно НЕ ПРОВЕРЯЛОСЬ, ошибок нет', async () => {
  const dir = await makeRepo();
  try {
    const result = await gateIn(dir, ['--probe', 'tests/a.test.mjs']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /типы: НЕ ПРОВЕРЯЛОСЬ — в наборе нет файлов, попадающих в include/);
    assert.match(result.text, /не покрыты проверкой типов/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: изменённые src/*.ts и tests/*.mjs вместе — tsc выполняется', async () => {
  const dir = await makeRepo({
    'src/bad.ts': 'export const ok: number = 1;\n',
    'tests/a.test.mjs': 'console.log(1);\n',
  });
  try {
    writeFileSync(path.join(dir, 'src/bad.ts'), 'export const bad: number = "строка";\n');
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(2);\n');
    const result = await gateIn(dir, []);
    assert.equal(result.code, 1, result.text);
    assert.match(result.text, /ТИПЫ: ошибки tsc/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: регресс прежних ложных пропусков на новом HEAD', async () => {
  const dir = await makeRepo({
    'tests/a.test.mjs': 'console.log(1);\n',
    'src/one.ts': 'export const one = 1;\n',
  });
  try {
    // 1) первая строка git status
    writeFileSync(path.join(dir, 'tests/a.test.mjs'), 'console.log(2);\n');
    const first = await gateIn(dir, []);
    assert.match(first.text, /Область: изменённые файлы/);

    // 2) staged + untracked + кириллица + пробел
    writeFileSync(path.join(dir, 'src/one.ts'), 'export const one = 2;\n');
    await run('git', ['add', 'src/one.ts'], { cwd: dir });
    mkdirSync(path.join(dir, 'tests', 'кириллица'), { recursive: true });
    writeFileSync(path.join(dir, 'tests', 'кириллица', 'проба.test.mjs'), 'console.log(3);\n');
    writeFileSync(path.join(dir, 'tests', 'with space.test.mjs'), 'console.log(4);\n');
    const mixed = await gateIn(dir, []);
    assert.equal(mixed.code, 0, mixed.text);
    assert.match(mixed.text, /стык импортов: ок/);
    assert.doesNotMatch(mixed.text, /изменений нет/);

    // 3) --probe без аргумента
    const noValue = await gateIn(dir, ['--probe']);
    assert.equal(noValue.code, 2, noValue.text);

    // 4) ошибка git: PATH без git. Без git база не разрешается, и это exit 2 с причиной,
    //    а не «изменений нет» (проверка именно на отсутствие ложного зелёного).
    const env = { ...process.env, PATH: '/nonexistent' };
    let code = null;
    let text = '';
    try {
      const out = await run(process.execPath, [path.join(dir, 'tools', 'check_fast.mjs')], { cwd: dir, env });
      text = `${out.stdout}${out.stderr}`;
    } catch (error) {
      code = error.code;
      text = `${error.stdout}${error.stderr}`;
    }
    assert.equal(code, 2, `ожидался exit 2, получено ${code}; вывод: ${text}`);
    assert.match(text, /СТОП/);
    assert.doesNotMatch(text, /изменений нет/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
