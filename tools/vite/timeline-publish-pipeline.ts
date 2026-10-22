import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { build as esbuildBuild } from 'esbuild';
import type { Plugin } from 'vite';
import { renderAtlasVariant } from './atlas-shell.ts';
import {
  addImageVersion,
  browserGlobalName,
  hashedOutputRelative,
  isTypeScriptSource,
  logicalSourcePath,
  publishRelativeForSource,
  readImageVersion,
  relativePosix,
  stripQueryAndHash,
  walkFiles,
} from './asset-utils.ts';

const tokenOrigin = 'https://timeline-asset.invalid';

const generatedImageNames = new Set([
  'galaxy-map-1200.webp',
  'galaxy-map-2000.webp',
  'galaxy-map-3000.webp',
  'koprulu-macket.webp',
  'ozd-macket.webp',
  'timeline-project-logo.webp',
]);

export interface LegacyAsset {
  readonly content: Buffer;
  readonly outputRelative: string;
  readonly sourceRelative: string;
}

export interface PublishSource {
  readonly publishRelative: string;
  readonly sourcePath: string;
  readonly sourceRelative: string;
}

export interface TimelinePublishOptions {
  readonly repoRoot: string;
  readonly siteRoot: string;
  readonly srcRoot: string;
  readonly defaultPublishRoot: string;
  readonly atlasTemplatePath: string;
  readonly routes: readonly string[];
}

/** Все изменяемые данные конвейера: модульного глобального состояния нет. */
export interface PublishPipelineState {
  readonly publishSources: Map<string, PublishSource>;
  readonly publishLogicalSources: Map<string, string>;
  readonly legacySourceFiles: readonly string[];
  readonly finalizedAssets: Map<string, LegacyAsset>;
  readonly finalizingAssets: Set<string>;
  finalizedAssetsPromise: Promise<void> | null;
  readonly tokenReferenceQueues: Map<string, string[]>;
  readonly imageVersion: string;
  resolvedPublishRoot: string;
}

interface HtmlTransformContext {
  readonly filename?: string;
  readonly path: string;
}

function addPublishSource(
  publishSources: Map<string, PublishSource>,
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

function createPublishPipelineState(options: TimelinePublishOptions): PublishPipelineState {
  const publishSources = new Map<string, PublishSource>();
  for (const fullPath of walkFiles(options.siteRoot)) {
    if (['.css', '.js', '.ts', '.mts'].includes(extname(fullPath))) {
      addPublishSource(publishSources, relativePosix(options.siteRoot, fullPath), fullPath);
    }
  }

  // src/** публикуется только через явные entry-точки, а не как отдельные файлы.
  const srcPublishEntries = [
    {
      publishRelative: 'shared/app.js',
      sourceRelative: 'src/atlas/app.ts',
      sourcePath: resolve(options.srcRoot, 'atlas/app.ts'),
    },
  ] as const;
  for (const entry of srcPublishEntries) {
    if (existsSync(entry.sourcePath)) {
      addPublishSource(publishSources, entry.sourceRelative, entry.sourcePath, entry.publishRelative);
    }
  }

  return {
    publishSources,
    publishLogicalSources: new Map<string, string>(
      [...publishSources.values()].map((source) => [source.publishRelative, source.sourceRelative]),
    ),
    legacySourceFiles: [...publishSources.keys()].sort(),
    finalizedAssets: new Map<string, LegacyAsset>(),
    finalizingAssets: new Set<string>(),
    finalizedAssetsPromise: null,
    tokenReferenceQueues: new Map<string, string[]>(),
    imageVersion: readImageVersion(resolve(options.repoRoot, 'data/meta.json')),
    resolvedPublishRoot: options.defaultPublishRoot,
  };
}

/**
 * Единый конвейер публикации, а не четыре независимых плагина.
 *
 * Граф фаз: pre-html -> bundle-finalize -> post-html -> write-extras.
 * Все фазы разделяют один PublishPipelineState. Vite вызывает buildStart до
 * HTML-трансформаций, поэтому bundle-finalize выполняется там и гарантирует,
 * что pre-html уже видит finalizedAssets; стрелки фиксируют единый граф
 * конвейера, а не разрешают переставлять хуки или создавать копии состояния.
 */
class TimelinePublishPipeline {
  private readonly state: PublishPipelineState;

  constructor(private readonly options: TimelinePublishOptions) {
    this.state = createPublishPipelineState(options);
  }

  plugins(): Plugin[] {
    return [
      {
        name: 'timeline-atlas-and-legacy-assets-pre',
        buildStart: async () => {
          await this.ensureFinalizedAssets();
        },
        transformIndexHtml: {
          order: 'pre',
          handler: (html, ctx) => this.preHtml(html, ctx),
        },
      },
      {
        name: 'timeline-legacy-assets-post',
        configResolved: (config) => {
          this.state.resolvedPublishRoot = config.build.outDir;
        },
        transformIndexHtml: {
          order: 'post',
          handler: (html, ctx) => this.postHtml(html, ctx),
        },
        closeBundle: () => {
          this.writePublishExtras();
        },
      },
    ];
  }

  private preHtml(html: string, ctx: HtmlTransformContext): string {
    const filename = ctx.filename ?? resolve(this.options.siteRoot, ctx.path.replace(/^\//, ''));
    const sourceRelative = this.htmlSourceRelative(ctx.filename, ctx.path);
    return this.tokenizeLegacyAssets(
      renderAtlasVariant(html, this.options.atlasTemplatePath),
      filename,
      sourceRelative,
    );
  }

  private postHtml(html: string, ctx: HtmlTransformContext): string {
    const filename = ctx.filename ?? resolve(this.options.siteRoot, ctx.path.replace(/^\//, ''));
    const sourceRelative = this.htmlSourceRelative(ctx.filename, ctx.path);
    return this.restoreLegacyAssets(html, filename, sourceRelative);
  }

  private resolvePublishSource(logical: string | null): string | null {
    if (!logical) return null;
    const byPublishPath = this.state.publishLogicalSources.get(logical);
    if (byPublishPath) return byPublishPath;
    if (this.state.publishSources.has(logical)) return logical;
    if (logical.endsWith('.js')) {
      const stem = logical.slice(0, -'.js'.length);
      for (const candidate of [`${stem}.ts`, `${stem}.mts`]) {
        if (this.state.publishSources.has(candidate)) return candidate;
      }
    }
    if (logical.endsWith('.mjs')) {
      const candidate = `${logical.slice(0, -'.mjs'.length)}.mts`;
      if (this.state.publishSources.has(candidate)) return candidate;
    }
    return null;
  }

  private hashedReference(rawRef: string, fromSourceRelative: string): string {
    const logical = logicalSourcePath(rawRef, fromSourceRelative);
    const sourceRelative = this.resolvePublishSource(logical);
    if (!sourceRelative) return rawRef;
    const asset = this.state.finalizedAssets.get(sourceRelative);
    if (!asset) throw new Error(`Ассет ещё не финализирован при переписывании ссылки: ${sourceRelative}`);
    const cleanRef = stripQueryAndHash(rawRef);
    const slashIndex = cleanRef.lastIndexOf('/');
    const prefix = slashIndex >= 0 ? cleanRef.slice(0, slashIndex + 1) : '';
    return `${prefix}${basename(asset.outputRelative)}`;
  }

  private rewriteScriptReferences(source: string, sourceRelative: string): string {
    let output = source.replace(/importScripts\(([^)]*)\)/gs, (_match: string, args: string) => {
      const rewrittenArgs = args.replace(
        /(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g,
        (_refMatch: string, quote: string, ref: string) => {
          return `${quote}${this.hashedReference(ref, sourceRelative)}${quote}`;
        },
      );
      return `importScripts(${rewrittenArgs})`;
    });

    output = output.replace(
      /new\s+Worker\(\s*(['"])([^'"]+\.(?:js|mts|ts))(?:\?[^'"]*)?\1/g,
      (_match: string, quote: string, ref: string) =>
        `new Worker(${quote}${this.hashedReference(ref, sourceRelative)}${quote}`,
    );
    return output;
  }

  private collectScriptDependencies(source: string, sourceRelative: string): string[] {
    const dependencies = new Set<string>();
    const addReference = (ref: string): void => {
      const dependency = this.resolvePublishSource(logicalSourcePath(ref, sourceRelative));
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

  private async compileTypeScriptAsset(publishSource: PublishSource): Promise<string> {
    // esbuild собирает полный TS/JSON-граф в classic script без runtime ESM.
    const entrySource = readFileSync(publishSource.sourcePath, 'utf8');
    const hasRuntimeExports = /(^|\n)\s*export\s+(?!(?:interface|type)\b)(?:\{|const|let|var|function|class|default|\*)/.test(entrySource);
    const globalName = hasRuntimeExports ? browserGlobalName(publishSource.publishRelative) : '';
    const assignsOwnBrowserGlobal = !!globalName && new RegExp(
      String.raw`(?:window|globalThis|global|root|self)[^;\n]*\.\s*${globalName}\s*=`,
    ).test(entrySource);

    const buildOptions: Parameters<typeof esbuildBuild>[0] = {
      absWorkingDir: this.options.repoRoot,
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
    // Entry, который сам ставит window/globalThis API, нельзя перезаписывать namespace esbuild.
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

  private async finalizeLegacyAsset(sourceRelative: string): Promise<LegacyAsset> {
    const existing = this.state.finalizedAssets.get(sourceRelative);
    if (existing) return existing;
    if (this.state.finalizingAssets.has(sourceRelative)) {
      throw new Error(`Цикл ссылок legacy-ассетов: ${sourceRelative}`);
    }
    const publishSource = this.state.publishSources.get(sourceRelative);
    if (!publishSource) throw new Error(`Неизвестный публикуемый исходник: ${sourceRelative}`);

    this.state.finalizingAssets.add(sourceRelative);
    try {
      let text = isTypeScriptSource(sourceRelative)
        ? await this.compileTypeScriptAsset(publishSource)
        : readFileSync(publishSource.sourcePath, 'utf8');
      if (sourceRelative.endsWith('.js') || isTypeScriptSource(sourceRelative)) {
        for (const dependency of this.collectScriptDependencies(text, sourceRelative)) {
          await this.finalizeLegacyAsset(dependency);
        }
        text = this.rewriteScriptReferences(text, sourceRelative);
      }
      text = addImageVersion(text, this.state.imageVersion, generatedImageNames);
      const content = Buffer.from(text, 'utf8');
      const asset: LegacyAsset = {
        content,
        outputRelative: hashedOutputRelative(publishSource.publishRelative, content),
        sourceRelative,
      };
      this.state.finalizedAssets.set(sourceRelative, asset);
      return asset;
    } finally {
      this.state.finalizingAssets.delete(sourceRelative);
    }
  }

  private ensureFinalizedAssets(): Promise<void> {
    this.state.finalizedAssetsPromise ??= (async () => {
      for (const sourceRelative of this.state.legacySourceFiles) {
        await this.finalizeLegacyAsset(sourceRelative);
      }
    })();
    return this.state.finalizedAssetsPromise;
  }

  private htmlSourceRelative(filename: string | undefined, fallbackPath: string): string {
    if (filename) return relativePosix(this.options.siteRoot, filename);
    return fallbackPath.replace(/^\//, '');
  }

  private tokenQueueKey(filename: string, logical: string): string {
    return `${filename}|${logical}`;
  }

  private tokenizeAssetTag(
    tag: string,
    attrName: 'href' | 'src',
    filename: string,
    sourceRelative: string,
  ): string {
    const attrPattern = new RegExp(`\\b${attrName}\\s*=\\s*(['"])([^'"]+)\\1`, 'i');
    const match = attrPattern.exec(tag);
    if (!match) return tag;
    const quote = match[1];
    const rawRef = match[2];
    if (!quote || !rawRef) return tag;
    const logical = logicalSourcePath(rawRef, sourceRelative);
    const publishSource = this.resolvePublishSource(logical);
    if (!publishSource || !this.state.finalizedAssets.has(publishSource)) return tag;
    const key = this.tokenQueueKey(filename, publishSource);
    const queue = this.state.tokenReferenceQueues.get(key) ?? [];
    queue.push(rawRef);
    this.state.tokenReferenceQueues.set(key, queue);
    return tag.replace(attrPattern, `${attrName}=${quote}${tokenOrigin}/${publishSource}${quote}`);
  }

  private tokenizeLegacyAssets(html: string, filename: string, sourceRelative: string): string {
    let output = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/\brel\s*=\s*(['"])stylesheet\1/i.test(tag)) return tag;
      return this.tokenizeAssetTag(tag, 'href', filename, sourceRelative);
    });
    output = output.replace(/<script\b[^>]*>/gi, (tag) =>
      this.tokenizeAssetTag(tag, 'src', filename, sourceRelative),
    );
    return output;
  }

  private restoreLegacyAssets(html: string, filename: string, sourceRelative: string): string {
    const tokenPattern = new RegExp(`${tokenOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^"'\\s>]+)`, 'g');
    const restored = html.replace(tokenPattern, (_match: string, logical: string) => {
      const asset = this.state.finalizedAssets.get(logical);
      if (!asset) return _match;
      const key = this.tokenQueueKey(filename, logical);
      const rawRef = this.state.tokenReferenceQueues.get(key)?.shift();
      if (!rawRef) return `/${asset.outputRelative}`;
      return this.hashedReference(rawRef, sourceRelative);
    });
    return addImageVersion(restored, this.state.imageVersion, generatedImageNames);
  }

  private writePublishExtras(): void {
    for (const asset of this.state.finalizedAssets.values()) {
      const outputPath = resolve(this.state.resolvedPublishRoot, asset.outputRelative);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, asset.content);
    }

    for (const fullPath of walkFiles(this.options.siteRoot)) {
      const extension = extname(fullPath);
      if (['.css', '.html', '.js', '.mts', '.ts'].includes(extension)) continue;
      const relativePath = relativePosix(this.options.siteRoot, fullPath);
      const outputPath = resolve(this.state.resolvedPublishRoot, relativePath);
      mkdirSync(dirname(outputPath), { recursive: true });
      cpSync(fullPath, outputPath);
    }

    const dataRoot = resolve(this.options.repoRoot, 'data');
    if (existsSync(dataRoot)) cpSync(dataRoot, resolve(this.state.resolvedPublishRoot, 'data'), { recursive: true });

    const assetsRoot = resolve(this.options.repoRoot, 'assets');
    if (existsSync(assetsRoot)) {
      cpSync(assetsRoot, resolve(this.state.resolvedPublishRoot, 'assets'), {
        filter: (source) => !source.startsWith(resolve(assetsRoot, 'src')),
        recursive: true,
      });
    }

    const manifest = {
      assets: Object.fromEntries(
        [...this.state.finalizedAssets.values()].map((asset) => [asset.sourceRelative, asset.outputRelative]),
      ),
      imageVersion: this.state.imageVersion,
      routes: [...this.options.routes],
    };
    writeFileSync(
      resolve(this.state.resolvedPublishRoot, 'build-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }
}

export function createTimelinePublishPlugins(options: TimelinePublishOptions): Plugin[] {
  return new TimelinePublishPipeline(options).plugins();
}
