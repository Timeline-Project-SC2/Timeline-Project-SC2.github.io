/* Отпечаток фактических входов сборки, не подпись и не доказательство публикации. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROPERTY_INPUT_FILES, canonicalPropertyInputList } from '../../src/atlas/sector-property-input-contract.ts';
import type { PropertyBuildInputs, PropertyInputFile, PropertyInputHashes } from '../../src/atlas/sector-property-input-contract.ts';
export { PROPERTY_INPUT_FILES };
const required = new Set<PropertyInputFile>(['systems.csv', 'places.csv', 'sector-property-overlay.json']);
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** Хэшируется однозначная последовательность фиксированных имён и хэшей. */
export function propertyInputsRevision(files: PropertyInputHashes): string {
  return sha256(canonicalPropertyInputList(files));
}

/** Данные читаются из уже скопированной публикации, не из HEAD или метаданных sync. */
export function collectPropertyBuildInputs(dataRoot: string): PropertyBuildInputs {
  const files = {} as Record<PropertyInputFile, string | null>;
  for (const name of PROPERTY_INPUT_FILES) {
    try {
      files[name] = sha256(readFileSync(resolve(dataRoot, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || required.has(name)) throw error;
      files[name] = null;
    }
  }
  return { version: 1, algorithm: 'sha256', files, contentRevision: propertyInputsRevision(files) };
}
