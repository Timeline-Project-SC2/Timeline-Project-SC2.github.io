import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PROPERTY_INPUT_FILES, collectPropertyBuildInputs, propertyInputsRevision } = require('../tools/vite/sector-property-build-inputs.ts');
const { verifyPropertyBuildInputs } = require('../src/atlas/sector-property-input-contract.ts');

function tempData() {
  const root = mkdtempSync(join(tmpdir(), 'sector-inputs-'));
  writeFileSync(join(root, 'systems.csv'), 'system_id,name\n1,Корхал\n');
  writeFileSync(join(root, 'places.csv'), 'ID,name\n1,Место\n');
  writeFileSync(join(root, 'sector-property-overlay.json'), '{"version":1,"changes":[]}\n');
  return root;
}
const hash = (value) => createHash('sha256').update(value).digest('hex');

test('отпечаток детерминирован и считает именно байты данных, а не Git HEAD', () => {
  const root = tempData();
  try {
    const first = collectPropertyBuildInputs(root);
    assert.deepEqual(collectPropertyBuildInputs(root), first);
    assert.equal(first.files['systems.csv'], hash('system_id,name\n1,Корхал\n'));
    assert.equal(first.files['systems.json'], null);
    assert.equal(first.contentRevision, propertyInputsRevision(first.files));
    const canonical = PROPERTY_INPUT_FILES.map((name) => `${name}\0${first.files[name] ?? '-'}\n`).join('');
    assert.equal(first.contentRevision, hash(canonical));
    assert.match(first.contentRevision, /^[a-f0-9]{64}$/);
    writeFileSync(join(root, 'systems.csv'), 'system_id,name\n1,Переименована\n');
    const changed = collectPropertyBuildInputs(root);
    assert.notEqual(changed.contentRevision, first.contentRevision);
    assert.equal(changed.files['places.csv'], first.files['places.csv']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('появление legacy JSON или изменение слоя меняет отпечаток', () => {
  const root = tempData();
  try {
    const initial = collectPropertyBuildInputs(root);
    writeFileSync(join(root, 'system-overrides.json'), '{}');
    const legacy = collectPropertyBuildInputs(root);
    assert.notEqual(legacy.contentRevision, initial.contentRevision);
    writeFileSync(join(root, 'sector-property-overlay.json'), '{"version":1,"changes":[1]}');
    assert.notEqual(collectPropertyBuildInputs(root).contentRevision, legacy.contentRevision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('отсутствующий обязательный вход останавливает вычисление', () => {
  const root = tempData();
  try {
    rmSync(join(root, 'places.csv'));
    assert.throws(() => collectPropertyBuildInputs(root), { code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('браузерная проверка сверяет каждый байт и общий отпечаток', async () => {
  const root = tempData();
  try {
    const manifest = collectPropertyBuildInputs(root);
    const bytes = Object.fromEntries(PROPERTY_INPUT_FILES.map((name) => [name, existsSync(join(root, name)) ? new Uint8Array(readFileSync(join(root, name))) : null]));
    assert.deepEqual(await verifyPropertyBuildInputs(manifest, bytes, webcrypto.subtle), manifest);
    const changed = { ...bytes, 'systems.csv': new TextEncoder().encode('не тот файл') };
    await assert.rejects(verifyPropertyBuildInputs(manifest, changed, webcrypto.subtle), /Несовпадение входа/);
    await assert.rejects(verifyPropertyBuildInputs({ ...manifest, contentRevision: '0'.repeat(64) }, bytes, webcrypto.subtle), /общего отпечатка/);
    await assert.rejects(verifyPropertyBuildInputs(manifest, { ...bytes, 'planets.json': new Uint8Array() }, webcrypto.subtle), /отсутствующего входа/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('проверка манифеста отклоняет неизвестные поля и отсутствующие обязательные файлы', async () => {
  const root = tempData();
  try {
    const manifest = collectPropertyBuildInputs(root);
    const bytes = Object.fromEntries(PROPERTY_INPUT_FILES.map((name) => [name, existsSync(join(root, name)) ? new Uint8Array(readFileSync(join(root, name))) : null]));
    await assert.rejects(verifyPropertyBuildInputs({ ...manifest, extra: true }, bytes, webcrypto.subtle), /Некорректный манифест/);
    await assert.rejects(verifyPropertyBuildInputs({ ...manifest, files: { ...manifest.files, 'places.csv': null } }, bytes, webcrypto.subtle), /Некорректный хэш/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
