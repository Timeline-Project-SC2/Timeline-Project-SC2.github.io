import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';

interface MetaAssets {
  readonly imageVersion?: unknown;
}

interface MetaFile {
  readonly assets?: MetaAssets;
}

/** Рекурсивно возвращает файлы в детерминированном порядке readdirSync. */
export function walkFiles(dir: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    if (statSync(fullPath).isDirectory()) output.push(...walkFiles(fullPath));
    else output.push(fullPath);
  }
  return output;
}

export function relativePosix(root: string, fullPath: string): string {
  return relative(root, fullPath).split('\\').join('/');
}

export function isTypeScriptSource(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.mts');
}

/** Невалидная или отсутствующая meta не должна останавливать сборку. */
export function readImageVersion(metaPath: string): string {
  if (!existsSync(metaPath)) return '';
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MetaFile;
    return typeof meta.assets?.imageVersion === 'string' ? meta.assets.imageVersion : '';
  } catch {
    return '';
  }
}

export function addImageVersion(
  text: string,
  imageVersion: string,
  generatedImageNames: ReadonlySet<string>,
): string {
  if (!imageVersion) return text;
  let output = text;
  for (const name of generatedImageNames) {
    output = output.split(`/assets/${name}`).join(`/assets/${name}?v=${imageVersion}`);
  }
  return output;
}

export function stripQueryAndHash(ref: string): string {
  return ref.split(/[?#]/, 1)[0] ?? ref;
}

export function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function logicalSourcePath(rawRef: string, fromSourceRelative: string): string | null {
  const ref = stripQueryAndHash(rawRef.trim());
  if (!ref || ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return null;
  if (ref.startsWith('/')) return normalizePosix(ref.slice(1));
  const baseDir = dirname(fromSourceRelative).split('\\').join('/');
  return normalizePosix(baseDir === '.' ? ref : `${baseDir}/${ref}`);
}

export function publishRelativeForSource(sourceRelative: string): string {
  if (!isTypeScriptSource(sourceRelative)) return sourceRelative;
  return `${sourceRelative.slice(0, -extname(sourceRelative).length)}.js`;
}

export function hashedOutputRelative(publishRelative: string, content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const extension = extname(publishRelative);
  const base = basename(publishRelative, extension);
  const dir = dirname(publishRelative).split('\\').join('/');
  const fileName = `${base}-${hash}${extension}`;
  return dir === '.' ? fileName : `${dir}/${fileName}`;
}

export function browserGlobalName(sourceRelative: string): string {
  const stem = basename(sourceRelative, extname(sourceRelative));
  const name = stem
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
  if (!name || /^[0-9]/.test(name)) {
    throw new Error(`Нельзя вывести browser-global имя для TypeScript-модуля: ${sourceRelative}`);
  }
  return name;
}
