#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name}: ожидается непустая строка`);
  return value.replace(/\s+/g, ' ').trim();
}

function list(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name}: ожидается массив`);
  return value.map((item) => text(item, name));
}

/** Собирает снимок, не изменяя источники; лимит проверяется до записи. */
export function renderContext({ state, decisions, head, branch }) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state: ожидается объект');
  if (!(typeof state.context_version === 'string' && state.context_version.trim())
      && !(Number.isInteger(state.context_version) && state.context_version >= 0)) {
    throw new Error('context_version: ожидается число или хэш');
  }
  if (!state.active_task || typeof state.active_task !== 'object' || Array.isArray(state.active_task)) {
    throw new Error('active_task: ожидается объект');
  }
  if (!Array.isArray(decisions)) throw new Error('decisions: ожидается массив');
  const task = state.active_task;
  const summary = list(state.last_handoff_summary, 'last_handoff_summary');
  if (summary.length > 5) throw new Error('last_handoff_summary: не более 5 пунктов');
  const holds = list(state.hold_list, 'hold_list');
  const parking = list(state.parking, 'parking');
  const ids = new Set();
  for (const item of decisions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('decision: ожидается объект');
    const id = text(item.id, 'decision.id');
    if (ids.has(id)) throw new Error(`decision.id повторяется: ${id}`);
    ids.add(id);
    for (const key of ['date', 'scope', 'decision', 'sha']) text(item[key], `decision.${key}`);
    if (!['active', 'superseded'].includes(item.status)) throw new Error(`decision.status: ${id}`);
    if (item.supersedes !== null) text(item.supersedes, 'decision.supersedes');
  }
  for (const item of decisions) {
    if (item.supersedes !== null && !ids.has(item.supersedes)) throw new Error(`не найдено supersedes: ${item.supersedes}`);
  }
  const active = decisions.filter((item) => item.status === 'active');
  const lines = [
    '<!-- AUTO-GENERATED. DO NOT EDIT. npm run context -->',
    '# Контекст задачи',
    `context_version: ${text(String(state.context_version), 'context_version')}`,
    `head_sha: ${text(head, 'git HEAD')} (на момент генерации); branch: ${text(branch, 'git branch')}`,
    `Снимок состояния (head_sha, base_sha): (${text(state.head_sha, 'state.head_sha')}, ${text(state.base_sha, 'state.base_sha')})`,
    'Факты и полномочия действуют для указанной пары; при изменении пары нужна повторная оценка.',
    '',
    '## Правила',
    '1. Старт сессии = чтение CONTEXT.md. Архив не читается, если файл не указан в allowed_scope.',
    '2. Внутри задачи CONTEXT.md заморожен; новые находки → parking[] в state.json.',
    '3. Handoff = обновить state.json (и при необходимости decisions.json) → npm run context.',
    '4. Parking применяется только между задачами при явном повышении context_version.',
    'Статусы: FACT — подтверждено; INFERENCE — вывод; UNKNOWN — неизвестно; NOT_CHECKED — не проверено; CONFLICT — противоречие.',
    '',
    '## Активная задача',
    `- id: ${text(task.id, 'active_task.id')}`,
    `- цель: ${text(task.goal_visible_to_user, 'active_task.goal_visible_to_user')}`,
    `- allowed_scope: ${list(task.allowed_scope, 'active_task.allowed_scope').join(', ') || 'нет'}`,
    `- out_of_scope: ${list(task.out_of_scope, 'active_task.out_of_scope').join(', ') || 'нет'}`,
    `- verify_cmd: ${text(task.verify_cmd, 'active_task.verify_cmd')}`,
    '',
    '## Active decisions',
    ...active.map((item) => `- ${text(item.id, 'decision.id')} (${text(item.scope, 'decision.scope')}): ${text(item.decision, 'decision.decision')}${item.supersedes ? `; supersedes: ${text(item.supersedes, 'decision.supersedes')}` : ''}`),
    '',
    '## HOLD',
    ...(holds.length ? holds.map((item) => `- ${item}`) : ['- нет']),
    '',
    '## Parking',
    ...(parking.length ? parking.map((item) => `- ${item}`) : ['- пусто']),
    '',
    '## Последняя передача',
    ...(summary.length ? summary.map((item) => `- ${item}`) : ['- нет']),
  ];
  if (lines.length > 80) throw new Error(`CONTEXT.md: ${lines.length} строк, лимит 80`);
  return `${lines.join('\n')}\n`;
}

function main() {
  const state = JSON.parse(readFileSync(path.join(ROOT, 'data/state.json'), 'utf8'));
  const decisions = JSON.parse(readFileSync(path.join(ROOT, 'data/decisions.json'), 'utf8'));
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const result = renderContext({ state, decisions, head: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') });
  writeFileSync(path.join(ROOT, 'CONTEXT.md'), result);
  console.log(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Ошибка контекста: ${error.message}`); process.exitCode = 1; }
}
