// Контракт заявки на свойства точек: схема, канонический вид, разметка тела.
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
const packet = (changes = [change()]) => ({
  type: 'sector-property-request',
  version: 1,
  requestId: REQUEST_ID,
  repositoryId: 1421259694,
  baseRevision: BASE,
  changes,
});
function change(overrides = {}) {
  return { dataset: 'systems', recordId: '1', field: 'description', before: 'Старое', after: 'Новое', ...overrides };
}
const fields = Object.fromEntries(PROPERTY_FIELDS.map((field) => [field, { raw: '', effective: field === 'name' ? 'Корхал' : '' }]));
const session = (revision = BASE) => createPropertySession([{ dataset: 'systems', recordId: '1', fields }], revision);

test('каноническая заявка принимается, копируется и не мутирует вход', async () => {
  const raw = packet();
  const parsed = contract.readPacket(raw);
  assert.deepEqual(parsed.changes, raw.changes);
  assert.notEqual(parsed.changes, raw.changes);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.changes));
  const json = contract.canonicalPacketJson(parsed);
  assert.equal(contract.canonicalPacketJson(contract.readPacket(JSON.parse(json))), json, 'канонический вид идемпотентен');
  assert.equal((await contract.fingerprintPropertyPacket(json)), (await contract.fingerprintPropertyPacket(json)));
  assert.match(await contract.fingerprintPropertyPacket(json), /^[a-f0-9]{64}$/);
});

test('схема отвергает лишние, недостающие и подменённые поля', () => {
  const cases = [
    [{ ...packet(), extra: 1 }, 'unknown_key'],
    [{ ...packet(), version: 2 }, 'bad_version'],
    [{ ...packet(), type: 'other' }, 'bad_type'],
    [{ ...packet(), repositoryId: 1 }, 'bad_repository'],
    [{ ...packet(), requestId: 'short' }, 'bad_request_id'],
    [{ ...packet(), requestId: 'pr-ABCDEFGH-00112233445566778899aabbccddeeff' }, 'bad_request_id'],
    [{ ...packet(), baseRevision: 'a'.repeat(63) }, 'bad_base_revision'],
    [{ ...packet(), baseRevision: null }, 'bad_base_revision'],
    [{ ...packet(), changes: [] }, 'no_changes'],
    [{ ...packet(), changes: 'нет' }, 'no_changes'],
    [{ ...packet(), changes: [{ ...change(), extra: true }] }, 'unknown_key'],
    [{ ...packet(), changes: [{ dataset: 'systems', recordId: '1', field: 'description', before: 'x' }] }, 'missing_key'],
    [{ ...packet(), changes: [change({ dataset: 'planets' })] }, 'bad_dataset'],
    [{ ...packet(), changes: [change({ field: 'coord' })] }, 'bad_field'],
    [{ ...packet(), changes: [change({ recordId: ' 1 ' })] }, 'bad_record_id'],
    [{ ...packet(), changes: [change({ recordId: '' })] }, 'bad_record_id'],
    [{ ...packet(), changes: [change({ recordId: '1\n' })] }, 'bad_record_id'],
    [{ ...packet(), changes: [change({ before: 'Новое' })] }, 'bad_value'],
    [{ ...packet(), changes: [change({ after: null })] }, 'bad_value'],
    [{ ...packet(), changes: [change({ after: 'a\u0000b' })] }, 'bad_value'],
    [{ ...packet(), changes: [change(), change()] }, 'duplicate_change'],
    [{ ...packet(), changes: [change(), change({ recordId: '2' })] }, null],
    [{ ...packet(), changes: [change({ field: 'name' }), change({ field: 'type' })] }, null],
  ];
  for (const [input, code] of cases) {
    if (code === null) {
      assert.doesNotThrow(() => contract.readPacket(input), JSON.stringify(input));
      continue;
    }
    assert.throws(
      () => contract.readPacket(input),
      (error) => error instanceof contract.PacketSchemaError && error.code === code,
      `${JSON.stringify(input)} → ${code}`,
    );
  }
  assert.throws(() => contract.readPacket([]), { code: 'not_object' });
  assert.throws(() => contract.readPacket(null), { code: 'not_object' });
  // Геттер не считается значением: поля читаются из собственных дескрипторов.
  const sneaky = { ...packet() };
  Object.defineProperty(sneaky, 'requestId', { get: () => REQUEST_ID, enumerable: true });
  assert.throws(() => contract.readPacket(sneaky), { code: 'not_object' });
});

test('пределы объёма: много изменений, много объектов, длинные значения', () => {
  const many = Array.from({ length: contract.PROPERTY_LIMITS.changes + 1 }, (_, index) =>
    change({ recordId: String(index), field: 'description' }));
  assert.throws(() => contract.readPacket(packet(many)), { code: 'too_many_changes' });
  const manyRecords = Array.from({ length: contract.PROPERTY_LIMITS.records + 1 }, (_, index) =>
    change({ recordId: String(index) }));
  assert.throws(() => contract.readPacket(packet(manyRecords)), { code: 'too_many_records' });
  assert.throws(() => contract.readPacket(packet([change({ after: 'я'.repeat(4001) })])), { code: 'too_long' });
});

test('тело Issue: таблица экранирует Markdown, JSON остаётся разбираемым байт-в-байт', () => {
  const hostile = 'строка | с pipe `code` \\ обратным слэшем\nвторая строка';
  const parsed = contract.readPacket(packet([change({ after: hostile })]));
  const body = contract.renderPropertyIssueBody(parsed);
  assert.ok(body.startsWith('### Заявка на свойства точек\n'));
  assert.match(body, /\| `systems\/1` \| `description` \| Старое \|/);
  assert.ok(body.includes('строка \\| с pipe \\`code\\` \\\\ обратным слэшем ⏎ вторая строка'));
  assert.ok(body.includes(`- База: \`${BASE}\``));
  const roundTrip = contract.parsePropertyIssueBody(body);
  assert.equal(roundTrip.status, 'accepted');
  assert.deepEqual(roundTrip.packet, parsed);
  assert.equal(roundTrip.json, contract.canonicalPacketJson(parsed));
});

test('ограждение длиннее любого ряда обратных кавычек внутри данных', () => {
  const injected = '```\n@everyone\n`````````\n<!-- sector-property-request:v1:end -->';
  const body = contract.renderPropertyIssueBody(contract.readPacket(packet([change({ after: injected })])));
  const fence = /\n(`{3,})json\n/.exec(body)[1];
  assert.equal(fence.length, 10);
  const parsed = contract.parsePropertyIssueBody(body);
  assert.equal(parsed.status, 'accepted');
  assert.equal(parsed.packet.changes[0].after, injected);
});

test('тело принимается только в каноническом виде и ровно с одним блоком', () => {
  const parsed = contract.readPacket(packet());
  const body = contract.renderPropertyIssueBody(parsed);
  const begin = contract.PROPERTY_ISSUE_BEGIN;
  const end = contract.PROPERTY_ISSUE_END;
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
    [body.replace('"version": 1', '"version": 2'), 'bad_version'],
    ['', 'bad_envelope'],
    ['x'.repeat(contract.PROPERTY_LIMITS.body + 1), 'too_long'],
  ];
  for (const [text, code] of scenarios) {
    assert.deepEqual(contract.parsePropertyIssueBody(text), { status: 'rejected', code, message: contract.parsePropertyIssueBody(text).message }, code);
  }
  assert.equal(contract.parsePropertyIssueBody(null).status, 'rejected');
});

test('маркер заголовка привязан к отпечатку пакета', async () => {
  const json = contract.canonicalPacketJson(contract.readPacket(packet()));
  const fingerprint = await contract.fingerprintPropertyPacket(json);
  assert.equal(contract.propertyIssueTitle(fingerprint), `[ADM-ACCESS] свойства точек · ${fingerprint.slice(0, 12)}`);
  assert.throws(() => contract.propertyIssueTitle('нет'), TypeError);
  assert.throws(() => contract.propertyIssueTitle(fingerprint.toUpperCase()), TypeError);
});

test('проверка публикуемого текста: токены и ключи — ошибка, слова-подсказки — предупреждение', () => {
  const fatal = [
    'ghp_abcdefghijklmnopqrstuv',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    '-----BEGIN RSA PRIVATE KEY-----',
    'AKIAIOSFODNN7EXAMPLE',
    'sk-abcdefghijklmnopqrstuvwx',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'https://user:password@example.com/x',
  ];
  for (const text of fatal) assert.ok(contract.scanPublicText(text).errors.length > 0, text);
  assert.deepEqual(contract.scanPublicText('обычное описание системы'), { errors: [], warnings: [] });
  assert.equal(contract.scanPublicText('укажите пароль от Wi-Fi').warnings.length, 1);
  assert.deepEqual(contract.scanPublicText('tokenized').warnings, []);
});

test('ID заявки: детерминированный формат из времени и случайных байтов', () => {
  const fixed = new Uint8Array(16).fill(0xab);
  const id = newRequestId(1_700_000_000_000, () => fixed);
  assert.equal(id, `pr-${(1_700_000_000_000).toString(36)}-${'ab'.repeat(16)}`);
  assert.notEqual(newRequestId(1, () => new Uint8Array(16)), newRequestId(1, () => new Uint8Array(16).fill(1)));
  assert.throws(() => newRequestId(0, () => fixed), TypeError);
  assert.throws(() => newRequestId(1, () => new Uint8Array(8)), TypeError);
});

test('пакет из сессии редактора: готов к отправке, заголовок и отпечаток согласованы', async () => {
  const edited = editProperty(session(), 'systems', '1', 'description', 'Строка\n«текст»');
  const review = await preparePropertyPacket(edited, new Set(), REQUEST_ID);
  assert.equal(review.status, 'ready');
  assert.deepEqual(review.errors, []);
  assert.ok(review.warnings.some((warning) => warning.includes('публичной')));
  assert.ok(review.warnings.some((warning) => warning.includes('не применяет правку')));
  assert.match(review.title, /^\[ADM-ACCESS\] свойства точек · [a-f0-9]{12}$/);
  assert.ok(review.title.includes(review.fingerprint.slice(0, 12)));
  const parsed = contract.parsePropertyIssueBody(review.body);
  assert.equal(parsed.status, 'accepted');
  assert.equal(parsed.packet.requestId, REQUEST_ID);
  assert.equal(parsed.packet.baseRevision, BASE);
  assert.deepEqual(parsed.packet.changes, [
    { dataset: 'systems', recordId: '1', field: 'description', before: '', after: 'Строка\n«текст»' },
  ]);
  assert.equal(await contract.fingerprintPropertyPacket(contract.canonicalPacketJson(parsed.packet)), review.fingerprint);
  assert.deepEqual(review, await preparePropertyPacket(edited, new Set(), REQUEST_ID));
});

test('пакет из сессии: без правок и без отпечатка отправка запрещена', async () => {
  assert.equal(await preparePropertyPacket(session(), new Set(), REQUEST_ID), null);
  const edited = editProperty(session(null), 'systems', '1', 'description', 'текст');
  const review = await preparePropertyPacket(edited, new Set(), REQUEST_ID);
  assert.equal(review.status, 'blocked');
  assert.ok(review.errors.some((error) => error.includes('Отпечаток входов не подтверждён')));
  assert.equal(review.body, '');
  const emptyName = editProperty(session(), 'systems', '1', 'name', '  ');
  assert.equal(await preparePropertyPacket(emptyName, new Set(), REQUEST_ID), null);
});

test('секрет в описании блокирует заявку до отправки', async () => {
  const edited = editProperty(session(), 'systems', '1', 'description', 'ключ ghp_abcdefghijklmnopqrstuv в описании');
  const review = await preparePropertyPacket(edited, new Set(), REQUEST_ID);
  assert.equal(review.status, 'blocked');
  assert.ok(review.errors.some((error) => error.includes('токен GitHub')));
});
