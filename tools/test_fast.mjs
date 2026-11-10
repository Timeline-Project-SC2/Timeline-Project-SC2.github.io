#!/usr/bin/env node
// Изменённые тесты относительно базы и рабочего дерева; tsc запускается один раз.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, collectChanged, resolveBase } from './check_fast.mjs';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base' || !args[1])) {
  console.error('Использование: npm run test:fast -- [--base <ref>]');
  process.exit(2);
}
const io = {
  run(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8' });
    return { code: result.status ?? 2, output: result.stdout ?? '', error: result.error?.message ?? result.stderr };
  },
};
const base = resolveBase(io, args[1] ?? null);
if (!base.ok) {
  console.error(`СТОП: ${base.reason}`);
  process.exit(2);
}
const changed = collectChanged(io, base.base);
if (!changed.ok) {
  console.error(`СТОП: ${changed.reason}`);
  process.exit(2);
}
const files = [...new Set(changed.entries.map((entry) => entry.path))]
  .filter((file) => /^tests\/.*\.test\.(?:mjs|js)$/.test(file) && existsSync(path.join(ROOT, file)))
  .sort();
let failed = false;
if (files.length) {
  console.log(`Изменённые тесты (${base.base}): ${files.join(', ')}`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit', env });
  failed = result.status !== 0;
} else {
  console.log(`Изменённых тестов нет (${base.base}).`);
}
const tsc = spawnSync(path.join(ROOT, 'node_modules/.bin/tsc'), ['--noEmit'], {
  cwd: ROOT, stdio: 'inherit',
});
if (tsc.status !== 0) failed = true;
process.exit(failed ? 1 : 0);
