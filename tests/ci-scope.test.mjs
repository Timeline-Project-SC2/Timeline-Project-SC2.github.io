import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCiPaths, scopeForEvent } from '../tools/ci_scope.mjs';

test('правки редактора и документации не требуют второй ОС и планетарного benchmark', () => {
  assert.deepEqual(classifyCiPaths(['site/sector/admin-edit/admin-edit.css', 'src/atlas/sector-areas-editor-ui.ts', 'tests/sector-areas-editor-ui.test.mjs', 'docs/admins/sector-areas-editor.md']), { compatibility: false, planet: false });
});
test('зависимости, CI, ресурсы и сборочные инструменты включают тяжёлые проверки', () => {
  for (const path of ['package-lock.json', '.github/workflows/check.yml', 'tools/ci_scope.mjs', 'assets/src/logo.png', 'vite.config.ts', 'tsconfig.json']) {
    assert.deepEqual(classifyCiPaths([path]), { compatibility: true, planet: true }, path);
  }
});
test('планеты и общие модули требуют benchmark, но не второй ОС', () => {
  for (const path of ['src/planet/noise.ts', 'src/local-map/mesh.ts', 'src/contracts/schema.json', 'site/planet-globe/index.html', 'tests/local-map.test.mjs', 'data/planet-generation.csv']) {
    assert.deepEqual(classifyCiPaths([path]), { compatibility: false, planet: true }, path);
  }
});
test('расписание, ручной полный прогон и недоступный diff не теряют проверки', () => {
  const full = { compatibility: true, planet: true };
  assert.deepEqual(scopeForEvent('schedule', {}, []), full);
  assert.deepEqual(scopeForEvent('workflow_dispatch', { inputs: { full: 'true' } }, []), full);
  assert.deepEqual(scopeForEvent('pull_request', {}, null), full);
  assert.deepEqual(scopeForEvent('workflow_dispatch', { inputs: { full: 'false' } }, null), { compatibility: false, planet: false });
});
