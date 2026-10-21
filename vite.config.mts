import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';
import { defineConfig, type Plugin } from 'vite';
import { atlasVariants, type AtlasVariantName } from './src/atlas/atlas-variants.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = resolve(repoRoot, 'site');
const srcRoot = resolve(repoRoot, 'src');
const defaultPublishRoot = resolve(repoRoot, '.publish');
const atlasTemplatePath = resolve(repoRoot, 'templates/atlas-shell.html');
const tokenOrigin = 'https://timeline-asset.invalid';

const routes = [
  'index.html',
  'sector/sector.html',
  'minimal/minimal.html',
  'cursor-test/index.html',
  'spiral-test/index.html',
  'planet-test/index.html',
  'planet-globe/index.html',
] as const;

const generatedImageNames = new Set([
  'galaxy-map-1200.webp',
  'galaxy-map-2000.webp',
  'galaxy-map-3000.webp',
  'koprulu-macket.webp',
  'ozd-macket.webp',
  'timeline-project-logo.webp',
]);

interface LegacyAsset {
  readonly content: Buffer;
  readonly outputRelative: string;
  readonly sourceRelative: string;
}

interface PublishSource {
  readonly publishRelative: string;
  readonly sourcePath: string;
  readonly sourceRelative: string;
}

interface MetaAssets {
  readonly imageVersion?: unknown;
}

interface MetaFile {
  readonly assets?: MetaAssets;
}

function walkFiles(dir: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    if (statSync(fullPath).isDirectory()) output.push(...walkFiles(fullPath));
    else output.push(fullPath);
  }
  return output;
}

function siteRelative(fullPath: string): string {
  return relative(siteRoot, fullPath).split('\\').join('/');
}

function isTypeScriptSource(path: string): boolean {
  return path.endsWith('.ts') || path.endsWith('.mts');
}

function readImageVersion(): string {
  const metaPath = resolve(repoRoot, 'data/meta.json');
  if (!existsSync(metaPath)) return '';
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as MetaFile;
    return typeof meta.assets?.imageVersion === 'string' ? meta.assets.imageVersion : '';
  } catch {
    return '';
  }
}

const imageVersion = readImageVersion();

function addImageVersion(text: string): string {
  if (!imageVersion) return text;
  let output = text;
  for (const name of generatedImageNames) {
    output = output.split(`/assets/${name}`).join(`/assets/${name}?v=${imageVersion}`);
  }
  return output;
}

function stripQueryAndHash(ref: string): string {
  return ref.split(/[?#]/, 1)[0] ?? ref;
}

function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function logicalSourcePath(rawRef: string, fromSourceRelative: string): string | null {
  const ref = stripQueryAndHash(rawRef.trim());
  if (!ref || ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return null;
  if (ref.startsWith('/')) return normalizePosix(ref.slice(1));
  const baseDir = dirname(fromSourceRelative).split('\\').join('/');
  return normalizePosix(baseDir === '.' ? ref : `${baseDir}/${ref}`);
}

function publishRelativeForSource(sourceRelative: string): string {
  if (!isTypeScriptSource(sourceRelative)) return sourceRelative;
  return `${sourceRelative.slice(0, -extname(sourceRelative).length)}.js`;
}

function hashedOutputRelative(publishRelative: string, content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const extension = extname(publishRelative);
  const base = basename(publishRelative, extension);
  const dir = dirname(publishRelative).split('\\').join('/');
  const fileName = `${base}-${hash}${extension}`;
  return dir === '.' ? fileName : `${dir}/${fileName}`;
}

const publishSources = new Map<string, PublishSource>();

function addPublishSource(
  sourceRelative: string,
  sourcePath: string,
  publishRelative = publishRelativeForSource(sourceRelative),
): void {
  const existing = publishSources.get(sourceRelative);
  if (existing && existing.sourcePath !== sourcePath) {
    throw new Error(`Дублирующийся логический путь публикации: ${sourceRelative}`);
  }
  for (const source of publishSources.values()) {
    if (source.publishRelative === publishRelative && source.sourcePath !== sourcePath) {
      throw new Error(`Дублирующийся выход публикации: ${publishRelative}`);
    }
  }
  publishSources.set(sourceRelative, { publishRelative, sourcePath, sourceRelative });
}

for (const fullPath of walkFiles(siteRoot)) {
  if (['.css', '.js', '.ts', '.mts'].includes(extname(fullPath))) {
    addPublishSource(siteRelative(fullPath), fullPath);
  }
}
// Модули src/** сами по себе не публикуются: esbuild встраивает их граф в
// явные entry-точки. Единственная такая точка из src — атлас сектора: её
// исходник живёт в src/atlas/app.ts, а URL/имя публикации остаются прежними
// shared/app-<hash>.js, как у удалённого site/shared/app.js.
const srcPublishEntries = [
  { publishRelative: 'shared/app.js', sourceRelative: 'src/atlas/app.ts', sourcePath: resolve(srcRoot, 'atlas/app.ts') },
] as const;
for (const entry of srcPublishEntries) {
  if (existsSync(entry.sourcePath)) {
    addPublishSource(entry.sourceRelative, entry.sourcePath, entry.publishRelative);
  }
}

const publishLogicalSources = new Map<string, string>(
  [...publishSources.values()].map((source) => [source.publishRelative, source.sourceRelative]),
);

const legacySourceFiles = [...publishSources.keys()].sort();
const finalizedAssets = new Map<string, LegacyAsset>();
const finalizingAssets = new Set<string>();
let finalizedAssetsPromise: Promise<void> | null = null;

function resolvePublishSource(logical: string | null): string | null {
  if (!logical) return null;
  const byPublishPath = publishLogicalSources.get(logical);
  if (byPublishPath) return byPublishPath;
  if (publishSources.has(logical)) return logical;
  if (logical.endsWith('.js')) {
    const stem = logical.slice(0, -'.js'.length);
    for (const candidate of [`${stem}.ts`, `${stem}.mts`]) {
      if (publishSources.has(candidate)) return candidate;
    }
  }
  if (logical.endsWith('.mjs')) {
    const candidate = `${logical.slice(0, -'.mjs'.length)}.mts`;
    if (publishSources.has(candidate)) return candidate;
  }
  return null;
}

function hashedReference(rawRef: string, fromSourceRelative: string): string {
  const logical = logicalSourcePath(rawRef, fromSourceRelative);
  const sourceRelative = resolvePublishSource(logical);
  if (!sourceRelative) return rawRef;
  const asset = finalizedAssets.get(sourceRelative);
  if (!asset) throw new Error(`Ассет ещё не финализирован при переписывании ссылки: ${sourceRelative}`);
  const cleanRef = stripQueryAndHash(rawRef);
  const slashIndex = cleanRef.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? cleanRef.slice(0, slashIndex + 1) : '';
  return `${prefix}${basename(asset.outputRelative)}`;
}

function rewriteScriptReferences(source: string, sourceRelative: string): string {
  let output = source.replace(/importScripts\(([^)]*)\)/gs, (_match: string, args: string) => {
    const rewrittenArgs = args.replace(/(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g, (_refMatch: string, quote: string, ref: string) => {
      return `${quote}${hashedReference(ref, sourceRelative)}${quote}`;
    });
    return `importScripts(${rewrittenArgs})`;
  });

  output = output.replace(
    /new\s+Worker\(\s*(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g,
    (_match: string, quote: string, ref: string) => `new Worker(${quote}${hashedReference(ref, sourceRelative)}${quote}`,
  );

  return output;
}

function collectScriptDependencies(source: string, sourceRelative: string): string[] {
  const dependencies = new Set<string>();
  const addReference = (ref: string): void => {
    const dependency = resolvePublishSource(logicalSourcePath(ref, sourceRelative));
    if (dependency && dependency !== sourceRelative) dependencies.add(dependency);
  };

  for (const match of source.matchAll(/importScripts\(([^)]*)\)/gs)) {
    const args = match[1] ?? '';
    for (const refMatch of args.matchAll(/(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g)) {
      if (refMatch[2]) addReference(refMatch[2]);
    }
  }
  for (const match of source.matchAll(/new\s+Worker\(\s*(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g)) {
    if (match[2]) addReference(match[2]);
  }
  return [...dependencies];
}

function browserGlobalName(sourceRelative: string): string {
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

async function compileTypeScriptAsset(publishSource: PublishSource): Promise<string> {
  // CR-01 PR 3: полноценная сборка графа импортов, а не одиночная
  // транспиляция файла. esbuild сам разрешает TS/JSON-импорты из src/** и
  // site/**, поэтому многофайловые модули атласа публикуются одним classic
  // script без runtime ESM-загрузчика и без Vite deprecation warning.
  const entrySource = readFileSync(publishSource.sourcePath, 'utf8');
  const hasRuntimeExports = /(^|\n)\s*export\s+(?!(?:interface|type)\b)(?:\{|const|let|var|function|class|default|\*)/.test(entrySource);
  const globalName = hasRuntimeExports ? browserGlobalName(publishSource.publishRelative) : '';
  const assignsOwnBrowserGlobal = !!globalName && new RegExp(
    String.raw`(?:window|globalThis|global|root|self)[^;\n]*\.\s*${globalName}\s*=`,
  ).test(entrySource);

  const buildOptions: Parameters<typeof esbuildBuild>[0] = {
    absWorkingDir: repoRoot,
    bundle: true,
    charset: 'utf8',
    entryPoints: [publishSource.sourcePath],
    format: 'iife',
    legalComments: 'none',
    logLevel: 'silent',
    platform: 'browser',
    sourcemap: false,
    target: 'es2022',
    write: false,
  };
  // globalName нужен только entry, чей ESM-namespace сам и есть browser API
  // (контракт PG1). Модули, которые внутри ставят честный window/globalThis
  // API (TravelPlanner, GalaxySpiral и эффекты), с globalName сломались бы:
  // esbuild присвоил бы var уже после IIFE и перезаписал API namespace-объектом.
  if (globalName && !assignsOwnBrowserGlobal) buildOptions.globalName = globalName;

  let result: Awaited<ReturnType<typeof esbuildBuild>>;
  try {
    result = await esbuildBuild(buildOptions);
  } catch (error) {
    throw new Error(
      `esbuild не собрал ${publishSource.sourceRelative}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const output = result.outputFiles?.[0];
  if (!output) throw new Error(`esbuild не вернул JS для ${publishSource.sourceRelative}`);
  return output.text;
}

async function finalizeLegacyAsset(sourceRelative: string): Promise<LegacyAsset> {
  const existing = finalizedAssets.get(sourceRelative);
  if (existing) return existing;
  if (finalizingAssets.has(sourceRelative)) {
    throw new Error(`Цикл ссылок legacy-ассетов: ${sourceRelative}`);
  }
  const publishSource = publishSources.get(sourceRelative);
  if (!publishSource) throw new Error(`Неизвестный публикуемый исходник: ${sourceRelative}`);

  finalizingAssets.add(sourceRelative);
  try {
    let text = isTypeScriptSource(sourceRelative)
      ? await compileTypeScriptAsset(publishSource)
      : readFileSync(publishSource.sourcePath, 'utf8');
    if (sourceRelative.endsWith('.js') || isTypeScriptSource(sourceRelative)) {
      for (const dependency of collectScriptDependencies(text, sourceRelative)) {
        await finalizeLegacyAsset(dependency);
      }
      text = rewriteScriptReferences(text, sourceRelative);
    }
    text = addImageVersion(text);
    const content = Buffer.from(text, 'utf8');
    const asset: LegacyAsset = {
      content,
      outputRelative: hashedOutputRelative(publishSource.publishRelative, content),
      sourceRelative,
    };
    finalizedAssets.set(sourceRelative, asset);
    return asset;
  } finally {
    finalizingAssets.delete(sourceRelative);
  }
}

function ensureFinalizedAssets(): Promise<void> {
  finalizedAssetsPromise ??= (async () => {
    for (const sourceRelative of legacySourceFiles) await finalizeLegacyAsset(sourceRelative);
  })();
  return finalizedAssetsPromise;
}

function renderAtlasVariant(html: string): string {
  const match = /<!--\s*atlas-variant:\s*(sector|minimal)\s*-->/.exec(html);
  if (!match) return html;
  const variantName = match[1] as AtlasVariantName;
  const variant = atlasVariants[variantName];
  const replacements: Record<string, string> = {
    BODY_ATTRS: variant.bodyAttrs,
    COORDINATE_CONTROLS: variant.coordinateControls,
    COORDINATE_READOUT: variant.coordinateReadout,
    GALAXY_RETURN: variant.galaxyReturn,
    HEAD_AFTER_READABILITY: variant.headAfterReadability,
    HEAD_AFTER_STYLES: variant.headAfterStyles,
    HEAD_NOTE: variant.headNote,
    HELP_LABEL: variant.helpLabel,
    INTRO: variant.intro,
    LEFT_TOGGLE: variant.leftToggle,
    LEGACY_TOGGLE: variant.legacyToggle,
    MODAL_FOOT: variant.modalFoot,
    MODAL_TITLE: variant.modalTitle,
    RETURN_SCRIPTS: variant.returnScripts,
    TITLE: variant.title,
  };

  let rendered = readFileSync(atlasTemplatePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`@@${key}@@`).join(value);
  }
  if (rendered.includes('@@')) throw new Error(`Не заполнен placeholder шаблона атласа: ${variantName}`);
  return rendered;
}

function htmlSourceRelative(filename: string | undefined, fallbackPath: string): string {
  if (filename) return siteRelative(filename);
  return fallbackPath.replace(/^\//, '');
}

const tokenReferenceQueues = new Map<string, string[]>();

function tokenQueueKey(filename: string, logical: string): string {
  return `${filename}|${logical}`;
}

function tokenizeAssetTag(tag: string, attrName: 'href' | 'src', filename: string, sourceRelative: string): string {
  const attrPattern = new RegExp(`\\b${attrName}\\s*=\\s*(['\"])([^'\"]+)\\1`, 'i');
  const match = attrPattern.exec(tag);
  if (!match) return tag;
  const quote = match[1];
  const rawRef = match[2];
  if (!quote || !rawRef) return tag;
  const logical = logicalSourcePath(rawRef, sourceRelative);
  const publishSource = resolvePublishSource(logical);
  if (!publishSource || !finalizedAssets.has(publishSource)) return tag;
  const key = tokenQueueKey(filename, publishSource);
  const queue = tokenReferenceQueues.get(key) ?? [];
  queue.push(rawRef);
  tokenReferenceQueues.set(key, queue);
  return tag.replace(attrPattern, `${attrName}=${quote}${tokenOrigin}/${publishSource}${quote}`);
}

function tokenizeLegacyAssets(html: string, filename: string, sourceRelative: string): string {
  let output = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*(['"])stylesheet\1/i.test(tag)) return tag;
    return tokenizeAssetTag(tag, 'href', filename, sourceRelative);
  });
  output = output.replace(/<script\b[^>]*>/gi, (tag) => tokenizeAssetTag(tag, 'src', filename, sourceRelative));
  return output;
}

function restoreLegacyAssets(html: string, filename: string, sourceRelative: string): string {
  const tokenPattern = new RegExp(`${tokenOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^"'\\s>]+)`, 'g');
  const restored = html.replace(tokenPattern, (_match: string, logical: string) => {
    const asset = finalizedAssets.get(logical);
    if (!asset) return _match;
    const key = tokenQueueKey(filename, logical);
    const rawRef = tokenReferenceQueues.get(key)?.shift();
    if (!rawRef) return `/${asset.outputRelative}`;
    return hashedReference(rawRef, sourceRelative);
  });
  return addImageVersion(restored);
}

let resolvedPublishRoot = defaultPublishRoot;

function writePublishExtras(): void {
  for (const asset of finalizedAssets.values()) {
    const outputPath = resolve(resolvedPublishRoot, asset.outputRelative);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, asset.content);
  }

  for (const fullPath of walkFiles(siteRoot)) {
    const extension = extname(fullPath);
    if (['.css', '.html', '.js', '.mts', '.ts'].includes(extension)) continue;
    const relativePath = siteRelative(fullPath);
    const outputPath = resolve(resolvedPublishRoot, relativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    cpSync(fullPath, outputPath);
  }

  const dataRoot = resolve(repoRoot, 'data');
  if (existsSync(dataRoot)) cpSync(dataRoot, resolve(resolvedPublishRoot, 'data'), { recursive: true });

  const assetsRoot = resolve(repoRoot, 'assets');
  if (existsSync(assetsRoot)) {
    cpSync(assetsRoot, resolve(resolvedPublishRoot, 'assets'), {
      filter: (source) => !source.startsWith(resolve(assetsRoot, 'src')),
      recursive: true,
    });
  }

  const manifest = {
    assets: Object.fromEntries(
      [...finalizedAssets.values()].map((asset) => [asset.sourceRelative, asset.outputRelative]),
    ),
    imageVersion,
    routes: [...routes],
  };
  writeFileSync(resolve(resolvedPublishRoot, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function timelinePublishPlugins(): Plugin[] {
  return [
    {
      name: 'timeline-atlas-and-legacy-assets-pre',
      async buildStart() {
        await ensureFinalizedAssets();
      },
      transformIndexHtml: {
        order: 'pre',
        handler(html, ctx) {
          const filename = ctx.filename ?? resolve(siteRoot, ctx.path.replace(/^\//, ''));
          const sourceRelative = htmlSourceRelative(ctx.filename, ctx.path);
          return tokenizeLegacyAssets(renderAtlasVariant(html), filename, sourceRelative);
        },
      },
    },
    {
      name: 'timeline-legacy-assets-post',
      configResolved(config) {
        resolvedPublishRoot = config.build.outDir;
      },
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          const filename = ctx.filename ?? resolve(siteRoot, ctx.path.replace(/^\//, ''));
          const sourceRelative = htmlSourceRelative(ctx.filename, ctx.path);
          return restoreLegacyAssets(html, filename, sourceRelative);
        },
      },
      closeBundle() {
        writePublishExtras();
      },
    },
  ];
}

export default defineConfig({
  root: siteRoot,
  publicDir: false,
  plugins: timelinePublishPlugins(),
  build: {
    assetsDir: '_vite',
    copyPublicDir: false,
    cssMinify: false,
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    outDir: defaultPublishRoot,
    reportCompressedSize: false,
    rollupOptions: {
      input: Object.fromEntries(routes.map((route) => [route.replace(/[^a-z0-9]+/gi, '-'), resolve(siteRoot, route)])),
    },
    sourcemap: false,
  },
});
