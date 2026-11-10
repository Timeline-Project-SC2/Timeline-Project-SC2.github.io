import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContext } from '../tools/context.mjs';

const state = {
  context_version: 1, head_sha: 'head', base_sha: 'base',
  active_task: { id: 'T', goal_visible_to_user: 'цель', allowed_scope: ['src/'], out_of_scope: [], verify_cmd: 'npm test' },
  hold_list: [], parking: [], last_handoff_summary: ['FACT: проверено'],
};
const decisions = [
  { id: 'old', date: '2026-01-01', scope: 's', decision: 'устарело', status: 'superseded', supersedes: null, sha: 'sha' },
  { id: 'new', date: '2026-01-02', scope: 's', decision: 'действует', status: 'active', supersedes: 'old', sha: 'sha' },
];
const render = (overrides = {}) => renderContext({ state, decisions, head: 'abc123', branch: 'work', ...overrides });

test('контекст содержит пару, ветку, активные решения и статусы, но не устаревшие решения', () => {
  const result = render();
  assert.match(result, /head_sha: abc123/);
  assert.match(result, /branch: work/);
  assert.match(result, /\(head, base\)/);
  assert.match(result, /действует; supersedes: old/);
  assert.doesNotMatch(result, /устарело/);
  for (const label of ['FACT', 'INFERENCE', 'UNKNOWN', 'NOT_CHECKED', 'CONFLICT']) assert.ok(result.includes(label));
  assert.ok(result.trimEnd().split('\n').length <= 80);
  assert.equal(result, render());
});

test('переполнение, неполные данные, лишние пункты и неверные решения не создают ложный контекст', () => {
  assert.throws(() => render({ state: { ...state, parking: Array.from({ length: 80 }, (_, i) => `p${i}`) } }), /лимит 80/);
  assert.throws(() => render({ state: { ...state, last_handoff_summary: Array(6).fill('x') } }), /не более 5/);
  assert.throws(() => render({ state: { ...state, base_sha: null } }), /state.base_sha/);
  assert.throws(() => render({ decisions: [{ ...decisions[1], supersedes: 'missing' }] }), /не найдено supersedes/);
  assert.throws(() => render({ decisions: [{ ...decisions[1], status: 'unknown' }] }), /decision.status/);
});
