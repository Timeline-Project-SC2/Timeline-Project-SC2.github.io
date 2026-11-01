import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFieldConflicts } from '../tools/issue_change_conflicts.mjs';

const field = (dataset, recordId, name, value) => ({ dataset, recordId, field: name, value });
const change = (dataset, recordId, name, before, after) => ({ dataset, recordId, field: name, before, after });
const result = (status) => ({ status });
const base = () => [field('пример', '1', 'название', 'А'), field('пример', '1', 'описание', 'Б')];

test('две заявки на одно поле: после первой вторая конфликтует', () => {
  const first = [change('пример', '1', 'название', 'А', 'В')];
  const second = [change('пример', '1', 'название', 'А', 'Г')];
  assert.deepEqual(assessFieldConflicts(base(), base(), first), result('candidate_needs_validation'));
  const current = [field('пример', '1', 'название', 'В'), base()[1]];
  assert.deepEqual(assessFieldConflicts(base(), current, second), result('conflict'));
});

test('разные поля дают только кандидата, даже если общее правило может нарушаться', () => {
  const current = [field('пример', '1', 'название', 'изменено'), base()[1]];
  const second = [change('пример', '1', 'описание', 'Б', 'изменено')];
  assert.deepEqual(assessFieldConflicts(base(), current, second), result('candidate_needs_validation'));
});

test('before обязан совпадать с базой, даже если другое поле конфликтует', () => {
  const current = [field('пример', '1', 'название', 'В'), base()[1]];
  const changes = [change('пример', '1', 'название', 'А', 'Г'), change('пример', '1', 'описание', 'не Б', 'Д')];
  assert.deepEqual(assessFieldConflicts(base(), current, changes), result('indeterminate'));
});

test('отсутствующие ключи, значение и дубли в любом массиве недопустимы', () => {
  const b = base();
  const c = [change('пример', '1', 'название', 'А', 'В')];
  for (const [a, now, edits] of [
    [[], b, c], [b, [], c], [[{ dataset: 'пример', recordId: '1', field: 'название' }], b, c],
    [[...b, b[0]], b, c], [b, [...b, b[0]], c], [b, b, [...c, c[0]]],
  ]) assert.deepEqual(assessFieldConflicts(a, now, edits), result('indeterminate'));
});

test('неверные типы, лишние поля, пустые ключи и изменения', () => {
  const b = base();
  const c = [change('пример', '1', 'название', 'А', 'В')];
  for (const [a, now, edits] of [
    [null, b, c], [b, {}, c], [b, b, []], [b, b, null],
    [[{ ...b[0], extra: true }], b, c], [b, b, [{ ...c[0], isVerified: true }]],
    [[{ ...b[0], value: undefined }], b, c], [[{ ...b[0], value: 0 }], b, c],
    [b, b, [{ ...c[0], after: false }]], [b, b, [{ ...c[0], before: undefined }]],
    [b, b, [{ ...c[0], dataset: '' }]], [b, b, [{ ...c[0], recordId: null }]],
    [b, b, [{ ...c[0], field: 42 }]], [b, b, [Object.create(c[0])]],
    [b, b, [{ ...c[0], [Symbol('extra')]: 1 }]],
  ]) assert.deepEqual(assessFieldConflicts(a, now, edits), result('indeterminate'));
  const getter = { ...b[0] };
  Object.defineProperty(getter, 'value', { get() { throw new Error('не вызывать'); } });
  assert.deepEqual(assessFieldConflicts([getter], b, c), result('indeterminate'));
});

test('null и пустая строка являются значениями и отличаются друг от друга', () => {
  const b = [field('x', 'y', 'z', null)];
  const c = [change('x', 'y', 'z', null, '')];
  assert.deepEqual(assessFieldConflicts(b, b, c), result('candidate_needs_validation'));
  assert.deepEqual(assessFieldConflicts(b, [field('x', 'y', 'z', '')], c), result('conflict'));
  assert.deepEqual(assessFieldConflicts([field('x', 'y', 'z', '')], b, c), result('indeterminate'));
});

test('current=after и повтор после сбоя не считаются успехом', () => {
  const b = base();
  const c = [change('пример', '1', 'название', 'А', 'В')];
  const current = [field('пример', '1', 'название', 'В'), b[1]];
  assert.deepEqual(assessFieldConflicts(b, current, c), result('conflict'));
  assert.deepEqual(assessFieldConflicts(b, current, c), result('conflict'));
});

test('неоднозначные при склеивании ключи остаются различными', () => {
  const b = [field('a/b', 'c', 'd', '1'), field('a', 'b/c', 'd', '2')];
  const now = [field('a/b', 'c', 'd', 'changed'), b[1]];
  assert.deepEqual(assessFieldConflicts(b, now, [change('a', 'b/c', 'd', '2', '3')]), result('candidate_needs_validation'));
});

test('ключи __proto__ и входы не изменяются', () => {
  const b = [field('__proto__', 'constructor', 'prototype', '')];
  const now = structuredClone(b);
  const edits = [change('__proto__', 'constructor', 'prototype', '', null)];
  const saved = structuredClone([b, now, edits]);
  Object.freeze(b[0]); Object.freeze(b); Object.freeze(now[0]); Object.freeze(now);
  Object.freeze(edits[0]); Object.freeze(edits);
  assert.deepEqual(assessFieldConflicts(b, now, edits), result('candidate_needs_validation'));
  assert.deepEqual([b, now, edits], saved);
});
