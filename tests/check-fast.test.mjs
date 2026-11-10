/* Быстрый локальный гейт `L0` — `tools/check_fast.mjs` (карточка «локальный цикл»).
 * -------------------------------------------------------------------------
 * Проверяется сам гейт, а не проект: настоящие `tsc`/`eslint`/`node --test`
 * здесь не запускаются (иначе тест звал бы сам себя), поэтому каждая проверка —
 * это чистая функция над фикстурой или сборка одного временного файла.

   Что доказывается:
   1. Список тестов берётся из `scripts["test:raw"]` — своего перечня гейт не ведёт
      (то же правило, что у стража карантина `CI-2`), иначе списки разъедутся.
   2. Разбор `git status --porcelain`, включая переименования `старый -> новый`.
   3. Отбор изменённых: только `tests|tools|src|site` и только код/тесты
      (`docs/**`, `.md`, `data/**` гейт не трогает — там ему нечего проверять).
   4. Стык импортов ловится ДО запуска кода: несуществующий символ в импорте —
      красный гейт за десятые доли секунды, а не красный прогон тестов за минуту.
   5. Чистый файл ошибок не даёт (гейт не «краснит на всякий случай»).

   Запуск: `node --test tests/check-fast.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ROOT,
  importProblems,
  isProbeFile,
  parsePorcelain,
  probeFilesFromPackage,
  selectChanged,
} from '../tools/check_fast.mjs';

// Читаем так, как читает сам гейт: из корня репозитория.
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('список тестов берётся из scripts["test:raw"], а не из своего перечня', () => {
  const probes = probeFilesFromPackage(pkg);
  assert.ok(probes.length > 0, 'в test:raw есть тест-файлы');
  assert.ok(probes.includes('tests/check-fast.test.mjs'), 'этот файл тоже в списке test:raw');
  assert.ok(probes.every((file) => isProbeFile(file)), 'в список попадают только .test./.spec. файлы');
  assert.ok(!probes.some((file) => file.includes('node_modules')), 'флаги и служебные аргументы не попадают');
});

test('без scripts["test:raw"] гейт не выдумывает список', () => {
  assert.throws(() => probeFilesFromPackage({ scripts: {} }), /test:raw/);
  assert.throws(() => probeFilesFromPackage({}), /test:raw/);
});

test('isProbeFile различает пробу, тест и обычный модуль', () => {
  assert.equal(isProbeFile('tests/foo.test.mjs'), true);
  assert.equal(isProbeFile('tests/bar.spec.ts'), true);
  assert.equal(isProbeFile('tools/check_fast.mjs'), false);
  assert.equal(isProbeFile('src/atlas/sector-score.ts'), false);
});

test('git status --porcelain разбирается с переименованием и без', () => {
  const text = [
    ' M src/atlas/sector-areas-pairs.ts',
    '?? tests/probe-new.test.mjs',
    'R  tests/old-name.test.mjs -> tests/new-name.test.mjs',
    'A  docs/concepts/new.md',
    '',
  ].join('\n');
  assert.deepEqual(parsePorcelain(text), [
    'src/atlas/sector-areas-pairs.ts',
    'tests/probe-new.test.mjs',
    'tests/new-name.test.mjs',
    'docs/concepts/new.md',
  ]);
});

test('отбор изменённых: только код и тесты в проверяемых каталогах', () => {
  const { probes, sources } = selectChanged([
    'src/atlas/sector-areas-pairs.ts',
    'site/shared/app.ts',
    'tools/check_fast.mjs',
    'tests/sector-areas.test.mjs',
    'docs/README.md',
    'data/systems.csv',
    'src/planet/assembly/kernels.ts.map',
  ]);
  assert.deepEqual(probes, ['tests/sector-areas.test.mjs']);
  assert.deepEqual(sources, ['src/atlas/sector-areas-pairs.ts', 'site/shared/app.ts', 'tools/check_fast.mjs']);
});

test('стык импортов: несуществующий экспорт — красный гейт без запуска кода', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-fast-'));
  try {
    const modulePath = path.join(dir, 'module.mjs');
    const probePath = path.join(dir, 'probe.test.mjs');
    writeFileSync(modulePath, 'export const exists = 1;\n');
    writeFileSync(probePath, [
      "import { exists } from './module.mjs';",
      "import { missingExport } from './module.mjs';",
      'console.log(exists, missingExport);',
      '',
    ].join('\n'));
    const problems = await importProblems([probePath]);
    assert.equal(problems.length, 1, 'ровно одна проблема на файл');
    assert.match(problems[0].messages.join('\n'), /No matching export/);
    assert.match(problems[0].messages.join('\n'), /missingExport/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('стык импортов: корректный файл ошибок не даёт', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-fast-'));
  try {
    const modulePath = path.join(dir, 'module.mjs');
    const probePath = path.join(dir, 'probe.test.mjs');
    writeFileSync(modulePath, 'export const exists = 1;\n');
    writeFileSync(probePath, "import { exists } from './module.mjs';\nconsole.log(exists);\n");
    assert.deepEqual(await importProblems([probePath]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
