import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'test-fast-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  mkdirSync(path.join(dir, 'tests'));
  mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
  for (const file of ['check_fast.mjs', 'test_fast.mjs']) copyFileSync(path.join(root, 'tools', file), path.join(dir, 'tools', file));
  writeFileSync(path.join(dir, 'node_modules/.bin/tsc'), '#!/bin/sh\necho TYPECHECK-ONCE\n');
  chmodSync(path.join(dir, 'node_modules/.bin/tsc'), 0o755);
  writeFileSync(path.join(dir, 'tests/deleted.test.mjs'), '');
  git('add', 'tools', 'tests');
  git('commit', '-qm', 'base');
  git('branch', '-M', 'main');
  return { dir, git, run: (...args) => spawnSync(process.execPath, ['tools/test_fast.mjs', ...args], { cwd: dir, encoding: 'utf8' }) };
}

test('test:fast выбирает изменения из коммитов, индекса и рабочего дерева, исключая удалённые', () => {
  const { dir, git, run } = repo();
  try {
    writeFileSync(path.join(dir, 'tests/committed.test.mjs'), "console.log('COMMITTED-TEST');\n");
    git('add', 'tests/committed.test.mjs');
    git('commit', '-qm', 'test');
    writeFileSync(path.join(dir, 'tests/staged.test.js'), "console.log('STAGED-TEST');\n");
    git('add', 'tests/staged.test.js');
    writeFileSync(path.join(dir, 'tests/untracked space.test.mjs'), "console.log('UNTRACKED-TEST');\n");
    rmSync(path.join(dir, 'tests/deleted.test.mjs'));
    const result = run('--base', 'HEAD~1');
    assert.equal(result.status, 0, result.stderr);
    for (const marker of ['COMMITTED-TEST', 'STAGED-TEST', 'UNTRACKED-TEST']) assert.match(result.stdout, new RegExp(marker));
    assert.doesNotMatch(result.stdout, /deleted\.test/);
    assert.equal((result.stdout.match(/TYPECHECK-ONCE/g) ?? []).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('test:fast проверяет типы при отсутствии тестов и сообщает об ошибках', () => {
  const { dir, run } = repo();
  try {
    const empty = run();
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /Изменённых тестов нет/);
    assert.equal((empty.stdout.match(/TYPECHECK-ONCE/g) ?? []).length, 1);
    writeFileSync(path.join(dir, 'tests/fail.test.mjs'), "throw new Error('FAILED-TEST');\n");
    const failing = run();
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /FAILED-TEST/);
    assert.equal((failing.stdout.match(/TYPECHECK-ONCE/g) ?? []).length, 1);
    writeFileSync(path.join(dir, 'node_modules/.bin/tsc'), '#!/bin/sh\nexit 1\n');
    rmSync(path.join(dir, 'tests/fail.test.mjs'));
    assert.equal(run().status, 1);
    assert.equal(run('--base', 'missing-ref').status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
