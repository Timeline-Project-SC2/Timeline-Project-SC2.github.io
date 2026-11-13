// Контракт v2: черновик браузера, серверное авторство, нить и каноническое тело.
// Проверяется офлайн: сеть, GitHub и браузер здесь не участвуют.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const contract = require('../src/issue-gateway/property-issue-contract.ts');
const { PROPERTY_FIELDS, createPropertySession, editProperty } = require('../src/atlas/sector-property-session.ts');
const { preparePropertyPacket, newRequestId } = require('../src/atlas/sector-property-packet.ts');

const BASE = 'a'.repeat(64);
const REQUEST_ID = 'pr-abc12345-00112233445566778899aabbccddeeff';
const THREAD_ID = 'pr-zzz99999-00112233445566778899aabbccddeeff';
const TARGET = { id: 987654321, fullName: 'Timeline-Project-SC2/property-requests' };
const AUTHOR = { id: 424242, login: 'Player-One' };
const CREATED_AT = '2026-11-13T10:20:30.400Z';
function change(overrides = {}) {
  return { dataset: 'systems', recordId: '1', field: 'description', before: 'Старое', after: 'Новое', ...overrides };
}
const draft = (changes = [change()]) => ({
  type: 'sector-property-request-draft', version: 2, requestId: REQUEST_ID, threadId: REQUEST_ID,
  baseRevision: BASE, changes,
});
const packet = (changes = [change()]) => contract.sealPropertyRequest(draft(changes), AUTHOR, CREATED_AT, TARGET);
const fields = Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, { raw: '', effective: field === 'name' ? 'Корхал' : '' }]));
const session = (revision = BASE) => createPropertySession([{ dataset: 'systems', recordId: '1', fields }], revision);

test('каноническая заявка принимается, копируется и не мутирует вход', async () => {
  const raw = packet();
  const parsed = contract.readPacket(raw, TARGET);
  assert.deepEqual(parsed.changes, raw.changes);
  assert.notEqual(parsed.changes, raw.changes);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.changes) && Object.isFrozen(parsed.author));
  const json = contract.canonicalPacketJson(parsed);
  assert.equal(contract.canonicalPacketJson(contract.readPacket(JSON.parse(json), TARGET)), json);
  assert.match(await contract.fingerprintPropertyPacket(json), /^[a-f0-9]{64}$/);
});

test('черновик не принимает авторство, время и цель; сервер запечатывает их сам', () => {
  assert.deepEqual(contract.readPropertyRequestDraft(draft()), draft());
  for (const extra of [{ author: AUTHOR }, { createdAt: CREATED_AT }, { repositoryId: TARGET.id }]) {
    assert.throws(() => contract.readPropertyRequestDraft({ ...draft(), ...extra }), { code: 'unknown_key' });
  }
  const sealed = contract.sealPropertyRequest(draft(), AUTHOR, CREATED_AT, TARGET);
  assert.deepEqual(sealed.author, AUTHOR);
  assert.equal(sealed.createdAt, CREATED_AT);
  assert.equal(sealed.repositoryId, TARGET.id);
  assert.equal(sealed.threadId, REQUEST_ID);
});

test('схема отвергает лишние, недостающие и подменённые поля', () => {
  const cases = [
    [{ ...packet(), extra: 1 }, 'unknown_key'],
    [{ ...packet(), version: 1 }, 'bad_version'],
    [{ ...packet(), type: 'other' }, 'bad_type'],
    [{ ...packet(), repositoryId: TARGET.id + 1 }, 'bad_repository'],
    [{ ...packet(), requestId: 'short' }, 'bad_request_id'],
    [{ ...packet(), threadId: 'short' }, 'bad_thread_id'],
    [{ ...packet(), author: { id: 0, login: 'x' } }, 'bad_author'],
    [{ ...packet(), author: { id: 1, login: 'bad_login' } }, 'bad_author'],
    [{ ...packet(), author: { id: 1, login: 'x'.repeat(40) } }, 'bad_author'],
    [{ ...packet(), createdAt: '2026-02-30T10:00:00.000Z' }, 'bad_created_at'],
    [{ ...packet(), createdAt: '2026-11-13T10:20:30Z' }, 'bad_created_at'],
    [{ ...packet(), baseRevision: 'a'.repeat(63) }, 'bad_base_revision'],
    [{ ...packet(), changes: [] }, 'no_changes'],
    [{ ...packet(), changes: [{ ...change(), extra: true }] }, 'unknown_key'],
    [{ ...packet(), changes: [change({ dataset: 'planets' })] }, 'bad_dataset'],
    [{ ...packet(), changes: [change({ field: 'coord' })] }, 'bad_field'],
    [{ ...packet(), changes: [change({ recordId: ' 1 ' })] }, 'bad_record_id'],
    [{ ...packet(), changes: [change({ before: 'Новое' })] }, 'bad_value'],
    [{ ...packet(), changes: [change({ after: 'a\u0000b' })] }, 'bad_value'],
    [{ ...packet(), changes: [change(), change()] }, 'duplicate_change'],
    [{ ...packet(), changes: [change(), change({ recordId: '2' })] }, null],
  ];
  for (const [input, code] of cases) {
    if (code === null) assert.doesNotThrow(() => contract.readPacket(input, TARGET));
    else assert.throws(() => contract.readPacket(input, TARGET), { code }, JSON.stringify(input));
  }
  assert.throws(() => contract.readPacket(null, TARGET), { code: 'not_object' });
  assert.throws(() => contract.readPacket(packet(), { id: 1, fullName: 'other/repo' }), { code: 'bad_repository' });
  const sneaky = { ...packet() };
  Object.defineProperty(sneaky, 'requestId', { get: () => REQUEST_ID, enumerable: true });
  assert.throws(() => contract.readPacket(sneaky, TARGET), { code: 'not_object' });
});

test('пределы объёма: много изменений, много объектов, длинные значения', () => {
  const many = Array.from({ length: contract.PROPERTY_LIMITS.changes + 1 }, (_, index) => change({ recordId: String(index) }));
  assert.throws(() => contract.readPacket(packet(many), TARGET), { code: 'too_many_changes' });
  const manyRecords = Array.from({ length: contract.PROPERTY_LIMITS.records + 1 }, (_, index) => change({ recordId: String(index) }));
  assert.throws(() => contract.readPacket(packet(manyRecords), TARGET), { code: 'too_many_records' });
  assert.throws(() => contract.readPacket(packet([change({ after: 'я'.repeat(4001) })]), TARGET), { code: 'too_long' });
});

test('тело Issue: шапка кто/когда/что и строки было → стало, JSON байт-в-байт', () => {
  const hostile = 'строка | с pipe `code` \\ обратным слэшем\nвторая строка <b>';
  const parsed = contract.readPacket(packet([change({ after: hostile })]), TARGET);
  const body = contract.renderPropertyIssueBody(parsed);
  assert.ok(body.startsWith('### Заявка на свойства точек\n'));
  assert.match(body, /- Кто: @Player-One · номер GitHub `424242`/);
  assert.match(body, /- Когда подготовлена: 2026-11-13T10:20:30\.400Z \(UTC\)/);
  assert.match(body, /- Что меняется: объектов 1, полей 1/);
  assert.match(body, /- Описание: Старое → строка \\\| с pipe \\`code\\` \\\\ обратным слэшем ⏎ вторая строка &lt;b&gt;/);
  assert.doesNotMatch(body, /\| `systems\/1` \|/);
  const roundTrip = contract.parsePropertyIssueBody(body, TARGET);
  assert.equal(roundTrip.status, 'accepted');
  assert.deepEqual(roundTrip.packet, parsed);
  assert.equal(roundTrip.json, contract.canonicalPacketJson(parsed));
});

test('ограждение длиннее любого ряда обратных кавычек внутри данных', () => {
  const injected = '```\n@everyone\n`````````\n<!-- sector-property-request:v2:end -->';
  const body = contract.renderPropertyIssueBody(packet([change({ after: injected })]));
  const fence = /\n(`{3,})json\n/.exec(body)[1];
  assert.equal(fence.length, 10);
  const parsed = contract.parsePropertyIssueBody(body, TARGET);
  assert.equal(parsed.status, 'accepted');
  assert.equal(parsed.packet.changes[0].after, injected);
});

test('тело принимается только в каноническом виде и ровно с одним блоком', () => {
  const parsed = packet();
  const body = contract.renderPropertyIssueBody(parsed);
  const begin = contract.PROPERTY_ISSUE_BEGIN, end = contract.PROPERTY_ISSUE_END;
  const json = contract.canonicalPacketJson(parsed);
  const scenarios = [
    [body.replace(end, `${end}\n${end}`), 'not_canonical'],
    [body.replace(begin, `${begin}\n${begin}`), 'bad_envelope'],
    [body.slice(0, body.indexOf(begin)), 'bad_envelope'],
    [`${body}${body}`, 'not_canonical'],
    [body.replace('"before": "Старое"', '"before":  "Старое"'), 'not_canonical'],
    [body.replace(json, json.replace(/\n/g, '\r\n')), 'not_canonical'],
    [`посторонний текст\n${body}`, 'not_canonical'],
    [`${body}посторонний текст`, 'not_canonical'],
    [body.replace(json, '{'), 'bad_envelope'],
    [body.replace('"version": 2', '"version": 1'), 'bad_version'],
    ['', 'bad_envelope'],
    ['x'.repeat(contract.PROPERTY_LIMITS.body + 1), 'too_long'],
  ];
  for (const [text, code] of scenarios) {
    const result = contract.parsePropertyIssueBody(text, TARGET);
    assert.equal(result.status, 'rejected', code);
    assert.equal(result.code, code);
  }
  assert.equal(contract.parsePropertyIssueBody(null, TARGET).status, 'rejected');
});

test('маркер заголовка привязан к отпечатку пакета', async () => {
  const fingerprint = await contract.fingerprintPropertyPacket(contract.canonicalPacketJson(packet()));
  assert.equal(contract.propertyIssueTitle(fingerprint), `[ADM-ACCESS] свойства точек · ${fingerprint.slice(0, 12)}`);
  assert.throws(() => contract.propertyIssueTitle('нет'), TypeError);
});

test('проверка текста: токены и ключи — ошибка, слова-подсказки — предупреждение', () => {
  for (const text of ['ghp_abcdefghijklmnopqrstuv', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----', 'AKIAIOSFODNN7EXAMPLE', 'sk-abcdefghijklmnopqrstuvwx',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'https://user:password@example.com/x']) {
    assert.ok(contract.scanPublicText(text).errors.length > 0, text);
  }
  assert.deepEqual(contract.scanPublicText('обычное описание системы'), { errors: [], warnings: [] });
  assert.equal(contract.scanPublicText('укажите пароль от Wi-Fi').warnings.length, 1);
  assert.deepEqual(contract.scanPublicText('tokenized').warnings, []);
});

test('ID заявки: детерминированный формат из времени и случайных байтов', () => {
  const fixed = new Uint8Array(16).fill(0xab);
  assert.equal(newRequestId(1_700_000_000_000, () => fixed), `pr-${(1_700_000_000_000).toString(36)}-${'ab'.repeat(16)}`);
  assert.throws(() => newRequestId(0, () => fixed), TypeError);
  assert.throws(() => newRequestId(1, () => new Uint8Array(8)), TypeError);
});

test('пакет из сессии редактора: черновик готов, но ещё не запечатан сервером', async () => {
  const edited = editProperty(session(), 'systems', '1', 'description', 'Строка\n«текст»');
  const review = await preparePropertyPacket(edited, new Set(), REQUEST_ID, THREAD_ID);
  assert.equal(review.status, 'ready');
  assert.deepEqual(review.errors, []);
  assert.ok(review.warnings.some((warning) => warning.includes('закрытой')));
  assert.ok(review.warnings.some((warning) => warning.includes('не применяет правку')));
  assert.equal(review.draft.author, undefined);
  assert.equal(review.draft.repositoryId, undefined);
  assert.equal(review.draft.threadId, THREAD_ID);
  assert.deepEqual(review.draft.changes, [{ dataset: 'systems', recordId: '1', field: 'description', before: '', after: 'Строка\n«текст»' }]);
  assert.deepEqual(review, await preparePropertyPacket(edited, new Set(), REQUEST_ID, THREAD_ID));
  const sealed = contract.sealPropertyRequest(review.draft, AUTHOR, CREATED_AT, TARGET);
  assert.equal(sealed.threadId, THREAD_ID);
  assert.equal(sealed.requestId, REQUEST_ID);
});

test('пакет из сессии: без правок и без отпечатка отправка запрещена', async () => {
  assert.equal(await preparePropertyPacket(session(), new Set(), REQUEST_ID), null);
  const edited = editProperty(session(null), 'systems', '1', 'description', 'текст');
  const review = await preparePropertyPacket(edited, new Set(), REQUEST_ID);
  assert.equal(review.status, 'blocked');
  assert.ok(review.errors.some((error) => error.includes('Отпечаток входов не подтверждён')));
  assert.equal(review.draft, null);
  assert.equal(await preparePropertyPacket(editProperty(session(), 'systems', '1', 'name', '  '), new Set(), REQUEST_ID), null);
});
