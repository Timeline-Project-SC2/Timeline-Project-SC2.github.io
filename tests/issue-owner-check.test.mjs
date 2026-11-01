import test from 'node:test';
import assert from 'node:assert/strict';
import { assessIssueOwner } from '../tools/issue_owner_check.mjs';

const org = 'Timeline-Project-SC2';
const orgId = 343675816;
const authorId = 12345;

function event() {
  return {
    action: 'opened',
    repository: {
      full_name: `${org}/Timeline-Project-SC2.github.io`, id: 1421259694,
      owner: { login: org, id: orgId, type: 'Organization' },
    },
    organization: { login: org, id: orgId },
    issue: { id: 456, number: 12, state: 'open', user: { id: authorId, type: 'User', login: 'example-user' } },
    sender: { id: authorId, type: 'User' },
  };
}

function membership(state = 'active', role = 'admin') {
  return { user: { id: authorId }, organization: { id: orgId }, state, role };
}

async function checkWithoutLookup(name, value, expected = 'indeterminate') {
  let calls = 0;
  const result = await assessIssueOwner(name, value, async () => { calls++; return membership(); });
  assert.deepEqual(result, { status: expected });
  assert.equal(calls, 0);
}

test('активный Owner: один вызов с логином автора', async () => {
  let calls = 0;
  const e = event();
  e.repository.full_name = e.repository.full_name.toLowerCase();
  e.organization.login = e.organization.login.toLowerCase();
  const result = await assessIssueOwner('issues', e, async (...args) => {
    calls++;
    assert.deepEqual(args, [org, 'example-user']);
    return membership();
  });
  assert.deepEqual(result, { status: 'owner_role_evidence' });
  assert.equal(calls, 1);
});

test('распознанное членство без активной роли Owner', async () => {
  for (const [state, role] of [['active', 'member'], ['pending', 'admin'], ['pending', 'member']]) {
    assert.deepEqual(await assessIssueOwner('issues', event(), async () => membership(state, role)), { status: 'not_owner' });
  }
});

test('другие события и чужие репозитории игнорируются без вызова', async () => {
  await checkWithoutLookup('push', event(), 'ignored');
  const e = event(); e.action = 'edited';
  await checkWithoutLookup('issues', e, 'ignored');
  e.action = 'opened'; e.repository.full_name = 'Another-Org/other';
  await checkWithoutLookup('issues', e, 'ignored');
  e.repository.full_name = 'Timeline-Project-SC2/other';
  await checkWithoutLookup('issues', e, 'ignored');
});

test('другая организация, противоречивые идентификаторы или тип владельца', async () => {
  for (const mutate of [
    (e) => { e.organization.id++; },
    (e) => { e.organization.login = 'other'; },
    (e) => { e.repository.owner.id++; },
    (e) => { e.repository.owner.login = 'other'; },
    (e) => { e.repository.owner.type = 'User'; },
    (e) => { e.repository.id++; },
    (e) => { e.repository.full_name = '???'; },
  ]) {
    const e = event(); mutate(e); await checkWithoutLookup('issues', e);
  }
});

test('бот, другой инициатор и неподходящий логин не допускают запрос', async () => {
  for (const mutate of [
    (e) => { e.issue.user.type = 'Bot'; },
    (e) => { e.sender.type = 'Bot'; },
    (e) => { e.sender.id++; },
    ...['', '-abc', 'abc-', 'a--b', 'a/b', 'a'.repeat(40), 'a\n'].map(
      (login) => (e) => { e.issue.user.login = login; },
    ),
  ]) {
    const e = event(); mutate(e); await checkWithoutLookup('issues', e);
  }
});

test('отсутствующие, повреждённые или небезопасные поля отвергаются', async () => {
  await checkWithoutLookup('issues', null);
  for (const mutate of [
    (e) => { delete e.action; },
    (e) => { delete e.repository; },
    (e) => { delete e.organization; },
    (e) => { delete e.issue; },
    (e) => { delete e.sender; },
    (e) => { e.issue.state = 'closed'; },
    (e) => { e.issue.id = 0; },
    (e) => { e.issue.number = 1.2; },
    (e) => { e.issue.number = Number.MAX_SAFE_INTEGER + 1; },
    (e) => { e.issue.user.id = Number.MAX_SAFE_INTEGER + 1; },
    (e) => { e.sender.id = '12345'; },
    (e) => { e.repository.id = '1421259694'; },
  ]) {
    const e = event(); mutate(e); await checkWithoutLookup('issues', e);
  }
  assert.deepEqual(await assessIssueOwner('issues', event()), { status: 'indeterminate' });
});

test('противоречивое или неизвестное членство не является доказательством', async () => {
  for (const value of [
    null, {}, { ...membership(), user: { id: authorId + 1 } },
    { ...membership(), user: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...membership(), organization: { id: orgId + 1 } },
    { ...membership(), organization: { id: String(orgId) } },
    membership('unknown', 'admin'), membership('active', 'owner'),
    ...[403, 404, 429].map((status) => ({ ...membership(), status })),
  ]) {
    let calls = 0;
    const result = await assessIssueOwner('issues', event(), async () => { calls++; return value; });
    assert.deepEqual(result, { status: 'indeterminate' });
    assert.equal(calls, 1);
  }
});

test('ошибка, HTTP-ошибки и таймаут callback приводят к неопределённости', async () => {
  for (const error of [new Error('failure'), ...[403, 404, 429].map((status) => ({ status })), new Error('timeout')]) {
    let calls = 0;
    const result = await assessIssueOwner('issues', event(), async () => { calls++; throw error; });
    assert.deepEqual(result, { status: 'indeterminate' });
    assert.equal(calls, 1);
  }
});

test('враждебные заголовок и тело остаются обычными данными', async () => {
  const e = event();
  e.issue.title = '$(throw new Error("executed"))';
  e.issue.body = '<script>throw new Error("executed")</script>';
  assert.deepEqual(await assessIssueOwner('issues', e, async () => membership()), { status: 'owner_role_evidence' });
});
