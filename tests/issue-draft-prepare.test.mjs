import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIssueDraftPreview, DRAFT_SCHEMA_VERSION, PREVIEW_STATUS } from '../tools/issue_draft_prepare.mjs';

function makeChange(dataset, id, field, before, after) {
  return { dataset, id, operation: 'update', fields: { [field]: { before, after } } };
}

const baseInput = {
  schemaVersion: DRAFT_SCHEMA_VERSION,
  baseVersion: null,
  changes: [makeChange('systems', 'example-system', 'name', 'Прежнее', 'Новое')]
};

test('вымышленный пример с null версии: preview_only, предупреждение о базе', () => {
  const result = prepareIssueDraftPreview(baseInput);
  assert.equal(result.status, PREVIEW_STATUS);
  assert.equal(result.title, '[ADM-ACCESS] Черновик изменения 1 записей');
  assert.ok(result.body.includes('baseVersion: `неизвестна`'));
  assert.ok(result.warnings.some((w) => w.includes('не доказана')));
  assert.equal(result.warnings.length, 1);
});

test('несколько изменений сохраняют порядок', () => {
  const input = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    baseVersion: 'abc123',
    changes: [
      makeChange('systems', 'sys-1', 'name', 'A', 'B'),
      makeChange('places', 'place-1', 'type', 'station', 'platform'),
      makeChange('factions', 'faction-1', 'color', '#000000', '#ffffff')
    ]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, PREVIEW_STATUS);
  assert.ok(result.body.indexOf('sys-1') < result.body.indexOf('place-1'));
  assert.ok(result.body.indexOf('place-1') < result.body.indexOf('faction-1'));
  assert.ok(result.body.includes('faction-1'));
  assert.ok(result.warnings.some((w) => w.includes('не является доказанной')));
});

test('указана версия, но preview_only остаётся', () => {
  const input = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    baseVersion: 'v2026-10-25',
    changes: [makeChange('systems', 'sys-1', 'name', 'A', 'B')]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, PREVIEW_STATUS);
  assert.ok(result.body.includes('baseVersion: `v2026-10-25`'));
  assert.ok(result.warnings.some((w) => w.includes('не является доказанной')));
});

test('некорректная структура: не объект', () => {
  const result = prepareIssueDraftPreview(null);
  assert.equal(result.status, 'error');
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.some((e) => e.includes('объектом')));
});

test('некорректная структура: неверный schemaVersion', () => {
  const input = { ...baseInput, schemaVersion: 'draft-2' };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
});

test('некорректная структура: пустой changes', () => {
  const input = { ...baseInput, changes: [] };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((e) => e.includes('changes')));
});

test('некорректная структура: недопустимый dataset', () => {
  const input = {
    ...baseInput,
    changes: [{ ...baseInput.changes[0], dataset: 'planets' }]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((e) => e.includes('dataset')));
});

test('некорректная структура: before/after не строки', () => {
  const input = {
    ...baseInput,
    changes: [{ dataset: 'systems', id: 'sys-1', operation: 'update', fields: { name: { before: 1, after: 'B' } } }]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, 'error');
  assert.ok(result.errors.some((e) => e.includes('before/after')));
});

test('некорректная структура: fields не объект', () => {
  const input = {
    ...baseInput,
    changes: [{ dataset: 'systems', id: 'sys-1', operation: 'update', fields: 'не-объект' }]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, 'error');
});

test('Unicode, кавычки, переносы и Markdown-символы в значениях', () => {
  const input = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    baseVersion: null,
    changes: [
      makeChange('systems', 'система-1', 'description', 'текст с "кавычками" и «ёлочками»', 'новый текст\nсо строкой\tи табом'),
      makeChange('places', 'place-1', 'type', '```markdown```', 'закрывающая ``` последовательность')
    ]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, PREVIEW_STATUS);
  // Пользовательский текст с ``` не закрывает ограждение JSON в body
  const jsonFenceCount = (result.body.match(/```/g) || []).length;
  assert.equal(jsonFenceCount, 2, 'ровно два ограждения кода в body');
  assert.ok(result.body.includes('система-1'));
  assert.ok(result.body.includes('place-1'));
});

test('отсутствие мутации входа', () => {
  const input = JSON.parse(JSON.stringify(baseInput));
  const before = JSON.stringify(input);
  prepareIssueDraftPreview(input);
  assert.equal(JSON.stringify(input), before, 'вход не изменён');
});

test('предсказуемый вывод: одинаковый вход даёт одинаковый результат', () => {
  const r1 = prepareIssueDraftPreview(baseInput);
  const r2 = prepareIssueDraftPreview(baseInput);
  assert.deepEqual(r1, r2);
});

test('preview_only неизменен для любого валидного входа', () => {
  const inputs = [
    { ...baseInput, baseVersion: null },
    { ...baseInput, baseVersion: 'some-sha' },
    {
      ...baseInput,
      changes: [
        makeChange('systems', 'a', 'x', '1', '2'),
        makeChange('places', 'b', 'y', '3', '4')
      ]
    }
  ];
  for (const input of inputs) {
    assert.equal(prepareIssueDraftPreview(input).status, PREVIEW_STATUS);
  }
});

test('result не содержит недоверенных полей author/role/path из пакета', () => {
  const input = {
    ...baseInput,
    changes: [{ ...baseInput.changes[0], author: 'someone', role: 'owner', path: 'data/systems.csv' }]
  };
  const result = prepareIssueDraftPreview(input);
  assert.equal(result.status, PREVIEW_STATUS);
  assert.ok(!result.body.includes('author'));
  assert.ok(!result.body.includes('role'));
  assert.ok(!result.body.includes('path'));
});
