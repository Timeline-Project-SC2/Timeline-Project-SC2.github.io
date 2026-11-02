// Офлайн-просмотр черновика issue: только форматирование и проверка структуры.
// НЕ является отправкой, авторизацией или утверждённым форматом заявки.
// Формат draft-1, разрешённые поля и версия базы не утверждены.
export const DRAFT_SCHEMA_VERSION = 'draft-1';
export const PREVIEW_STATUS = 'preview_only';

const ALLOWED_DATASETS = new Set(['systems', 'places', 'factions']);
const ALLOWED_OPERATIONS = new Set(['update']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidFieldValue(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.before === 'string' &&
    typeof value.after === 'string'
  );
}

function isValidChange(change, index) {
  const errors = [];
  if (change === null || typeof change !== 'object' || Array.isArray(change)) {
    errors.push(`changes[${index}]: не объект`);
    return { valid: false, errors };
  }
  const { dataset, id, operation, fields } = change;
  if (!isNonEmptyString(dataset) || !ALLOWED_DATASETS.has(dataset)) {
    errors.push(`changes[${index}].dataset: недопустимый или отсутствующий набор`);
  }
  if (!isNonEmptyString(id)) {
    errors.push(`changes[${index}].id: отсутствует или не строка`);
  }
  if (!isNonEmptyString(operation) || !ALLOWED_OPERATIONS.has(operation)) {
    errors.push(`changes[${index}].operation: недопустимая или отсутствующая операция`);
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    errors.push(`changes[${index}].fields: не объект`);
  } else {
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (!isValidFieldValue(fieldValue)) {
        errors.push(`changes[${index}].fields.${fieldName}: before/after должны быть строками`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function escapeBackticks(text) {
  return text.replace(/`/g, '\\`');
}

export function prepareIssueDraftPreview(input) {
  const warnings = [];
  const errors = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'error', errors: ['вход должен быть объектом'] };
  }

  const { schemaVersion, baseVersion, changes } = input;

  if (schemaVersion !== DRAFT_SCHEMA_VERSION) {
    errors.push(`schemaVersion должен быть '${DRAFT_SCHEMA_VERSION}'`);
  }

  if (baseVersion !== null && baseVersion !== undefined && !isNonEmptyString(baseVersion)) {
    errors.push('baseVersion должен быть строкой или null');
  }

  if (baseVersion === null || baseVersion === undefined || baseVersion === '') {
    warnings.push('Версия базы не указана или неизвестна — опубликованная версия данных не доказана');
  } else {
    warnings.push('Указана версия базы, но она не является доказанной опубликованной версией данных');
  }

  if (!Array.isArray(changes) || changes.length === 0) {
    errors.push('changes должен быть непустым массивом');
  }

  const validatedChanges = [];
  if (Array.isArray(changes)) {
    for (let i = 0; i < changes.length; i += 1) {
      const result = isValidChange(changes[i], i);
      if (!result.valid) {
        errors.push(...result.errors);
        continue;
      }
      const { dataset, id, operation, fields } = changes[i];
      validatedChanges.push({ dataset, id, operation, fields });
    }
  }

  if (errors.length > 0) {
    return { status: 'error', errors };
  }

  const changeDescriptions = validatedChanges
    .map((c) => `• ${c.dataset}/${c.id}: ${Object.keys(c.fields).join(', ')}`)
    .join('\n');

  const jsonText = JSON.stringify(
    { schemaVersion, baseVersion, changes: validatedChanges },
    null,
    2
  );
  const safeJsonText = escapeBackticks(jsonText);

  const title = `[ADM-ACCESS] Черновик изменения ${validatedChanges.length} записей`;
  const body = `### Черновик issue (пример, не готово к отправке)

schemaVersion: \`${DRAFT_SCHEMA_VERSION}\`
baseVersion: \`${baseVersion ?? 'неизвестна'}\`

Изменения:
${changeDescriptions}

\`\`\`json
${safeJsonText}
\`\`\`

> Это иллюстративный пример черновика. Данные вымышленные. Формат не утверждён.
> preview_only: результат не отправлен, не авторизован и не применяется.`;

  return {
    status: PREVIEW_STATUS,
    title,
    body,
    warnings
  };
}
