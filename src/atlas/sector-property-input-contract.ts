/* Контентный отпечаток входных данных сборки: не подпись и не разрешение на запись. */
export const PROPERTY_INPUT_FILES = [
  'systems.csv', 'places.csv', 'sector-property-overlay.json',
  'systems.json', 'planets.json', 'system-overrides.json', 'factions.csv', 'meta.json',
] as const;
export type PropertyInputFile = typeof PROPERTY_INPUT_FILES[number];
export type PropertyInputHashes = Readonly<Record<PropertyInputFile, string | null>>;
export interface PropertyBuildInputs {
  readonly version: 1;
  readonly algorithm: 'sha256';
  readonly files: PropertyInputHashes;
  readonly contentRevision: string;
}
export type PropertyInputBytes = Readonly<Record<PropertyInputFile, Uint8Array | null>>;
const required = new Set<PropertyInputFile>(['systems.csv', 'places.csv', 'sector-property-overlay.json']);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every((name) => Object.hasOwn(value, name));

export function parsePropertyBuildInputs(raw: unknown): PropertyBuildInputs {
  if (!object(raw) || !keys(raw, ['version', 'algorithm', 'files', 'contentRevision']) ||
    raw.version !== 1 || raw.algorithm !== 'sha256' || !object(raw.files) ||
    !keys(raw.files, PROPERTY_INPUT_FILES) || !isHash(raw.contentRevision)) throw new TypeError('Некорректный манифест входов.');
  const files = {} as Record<PropertyInputFile, string | null>;
  for (const name of PROPERTY_INPUT_FILES) {
    const value = raw.files[name];
    if (!isHash(value) && !(value === null && !required.has(name))) throw new TypeError('Некорректный хэш входа.');
    files[name] = value;
  }
  return { version: 1, algorithm: 'sha256', files, contentRevision: raw.contentRevision };
}

/** Порядок имён фиксирован; нулевой байт и перевод строки разделяют поля. */
export function canonicalPropertyInputList(files: PropertyInputHashes): string {
  return PROPERTY_INPUT_FILES.map((name) => `${name}\0${files[name] ?? '-'}\n`).join('');
}

async function digest(subtle: SubtleCrypto, bytes: Uint8Array): Promise<string> {
  const hash = await subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Сверяет переданные точные байты с манифестом. Совпадение не доказывает,
 * кто подал манифест, факт публикации, авторство или полномочия.
 */
export async function verifyPropertyBuildInputs(raw: unknown, bytes: PropertyInputBytes, subtle: SubtleCrypto): Promise<PropertyBuildInputs> {
  const manifest = parsePropertyBuildInputs(raw);
  for (const name of PROPERTY_INPUT_FILES) {
    const input = bytes[name];
    const expected = manifest.files[name];
    if (expected === null) {
      if (input !== null) throw new Error('Несовпадение отсутствующего входа: ' + name);
    } else {
      if (!(input instanceof Uint8Array) || await digest(subtle, input) !== expected) throw new Error('Несовпадение входа: ' + name);
    }
  }
  const canonical = new TextEncoder().encode(canonicalPropertyInputList(manifest.files));
  if (await digest(subtle, canonical) !== manifest.contentRevision) throw new Error('Несовпадение общего отпечатка.');
  return manifest;
}
