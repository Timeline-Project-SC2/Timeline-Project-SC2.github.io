import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = resolve(repoRoot, 'site');
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

function hashedOutputRelative(sourceRelative: string, content: Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const extension = extname(sourceRelative);
  const base = basename(sourceRelative, extension);
  const dir = dirname(sourceRelative).split('\\').join('/');
  const fileName = `${base}-${hash}${extension}`;
  return dir === '.' ? fileName : `${dir}/${fileName}`;
}

const legacySourceFiles = walkFiles(siteRoot)
  .filter((fullPath) => ['.css', '.js'].includes(extname(fullPath)))
  .map(siteRelative)
  .sort();
const legacySourceFileSet = new Set(legacySourceFiles);
const finalizedAssets = new Map<string, LegacyAsset>();
const finalizingAssets = new Set<string>();

function hashedReference(rawRef: string, fromSourceRelative: string): string {
  const logical = logicalSourcePath(rawRef, fromSourceRelative);
  if (!logical || !legacySourceFileSet.has(logical)) return rawRef;
  const asset = finalizeLegacyAsset(logical);
  const cleanRef = stripQueryAndHash(rawRef);
  const slashIndex = cleanRef.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? cleanRef.slice(0, slashIndex + 1) : '';
  return `${prefix}${basename(asset.outputRelative)}`;
}

function rewriteScriptReferences(source: string, sourceRelative: string): string {
  let output = source.replace(/importScripts\(([^)]*)\)/gs, (_match: string, args: string) => {
    const rewrittenArgs = args.replace(/(['"])([^'"]+\.js)(?:\?[^'"]*)?\1/g, (_refMatch: string, quote: string, ref: string) => {
      return `${quote}${hashedReference(ref, sourceRelative)}${quote}`;
    });
    return `importScripts(${rewrittenArgs})`;
  });

  output = output.replace(
    /new\s+Worker\(\s*(['"])([^'"]+\.js)(?:\?[^'"]*)?\1/g,
    (_match: string, quote: string, ref: string) => `new Worker(${quote}${hashedReference(ref, sourceRelative)}${quote}`,
  );

  return output;
}

function finalizeLegacyAsset(sourceRelative: string): LegacyAsset {
  const existing = finalizedAssets.get(sourceRelative);
  if (existing) return existing;
  if (finalizingAssets.has(sourceRelative)) {
    throw new Error(`Цикл ссылок legacy-ассетов: ${sourceRelative}`);
  }

  finalizingAssets.add(sourceRelative);
  try {
    const sourcePath = resolve(siteRoot, sourceRelative);
    let text = readFileSync(sourcePath, 'utf8');
    if (sourceRelative.endsWith('.js')) text = rewriteScriptReferences(text, sourceRelative);
    text = addImageVersion(text);
    const content = Buffer.from(text, 'utf8');
    const asset: LegacyAsset = {
      content,
      outputRelative: hashedOutputRelative(sourceRelative, content),
      sourceRelative,
    };
    finalizedAssets.set(sourceRelative, asset);
    return asset;
  } finally {
    finalizingAssets.delete(sourceRelative);
  }
}

for (const sourceRelative of legacySourceFiles) finalizeLegacyAsset(sourceRelative);

type AtlasVariantName = 'minimal' | 'sector';

interface AtlasVariant {
  readonly bodyAttrs: string;
  readonly coordinateControls: string;
  readonly coordinateReadout: string;
  readonly galaxyReturn: string;
  readonly headAfterReadability: string;
  readonly headAfterStyles: string;
  readonly headNote: string;
  readonly helpLabel: string;
  readonly intro: string;
  readonly leftToggle: string;
  readonly legacyToggle: string;
  readonly modalFoot: string;
  readonly modalTitle: string;
  readonly returnScripts: string;
  readonly title: string;
}

const atlasVariants: Record<AtlasVariantName, AtlasVariant> = {
  sector: {
    bodyAttrs: '',
    coordinateControls: [
      '        <div class="control-divider"></div>',
      '        <button class="map-control coordinate-toggle" id="coordinateToggle" type="button" title="Включить координаты наведения" aria-label="Включить координаты наведения" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></button>',
    ].join('\n'),
    coordinateReadout:
      '      <div class="map-coordinate-readout" id="mapCoordinateReadout" aria-hidden="true" hidden></div>',
    galaxyReturn: '        <a class="galaxy-return" id="galaxyReturn" href="/index.html">← К ГАЛАКТИКЕ</a>',
    headAfterReadability: '',
    headAfterStyles: '  <link rel="stylesheet" href="sector.css">',
    headNote:
      '  <!-- минимальный скин вынесен в minimal.html: он скрывает каталог, вики-навигацию и «О данных» -->',
    helpLabel: 'О КАРТЕ',
    intro: [
      '      <section class="map-page-intro" aria-label="Текущий раздел">',
      '        <div class="breadcrumb"><span>Лор</span><i>›</i><span>Вводная часть</span><i>›</i><b>Пространство сектора Копрулу</b></div>',
      '        <h2>Пространство сектора Копрулу</h2>',
      '        <p>И его ближайшие территории...</p>',
      '      </section>',
    ].join('\n'),
    leftToggle: [
      '        <!-- Бургер: скрыть/показать каталог — слева в шапке -->',
      '        <button class="icon-button collapse-button" id="toggleSidePanel" type="button" aria-label="Скрыть каталог" title="Скрыть каталог">',
      '          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h10M4 19h16"></path><path d="m17 9 3 3-3 3"></path></svg>',
      '        </button>',
    ].join('\n'),
    legacyToggle: '',
    modalFoot: '<span>КАСТОМНАЯ КАРТА</span><span>НЕОФИЦИАЛЬНЫЙ ПРОЕКТ</span>',
    modalTitle: 'О карте',
    returnScripts: [
      '  <script src="/shared/links.js"></script>',
      '  <script>',
      '    (function () {',
      "      var a = document.getElementById('galaxyReturn');",
      '      if (!a) return;',
      '      if (window.SITE_LINKS && SITE_LINKS.galaxyPage) a.href = SITE_LINKS.galaxyPage;',
      '      // при возврате галактика не проигрывает консоль и сохраняет доступ к ОЗД',
      "      a.addEventListener('click', function () {",
      "        try { sessionStorage.setItem('galaxyReturn', '1'); } catch (e) {}",
      '      });',
      '    })();',
      '  </script>',
    ].join('\n'),
    title: 'Timeline Project — Map Atlas',
  },
  minimal: {
    bodyAttrs: ' class="minimal-mode"',
    coordinateControls: '',
    coordinateReadout: '',
    galaxyReturn: '',
    headAfterReadability: '  <link rel="stylesheet" href="minimal-skin.css">',
    headAfterStyles: '',
    headNote: '',
    helpLabel: 'О ДАННЫХ',
    intro: [
      '      <section class="map-page-intro" aria-label="Текущий раздел">',
      '        <div class="breadcrumb"><span>Лор</span><i>›</i><span>Вводная часть</span><i>›</i><b>Карта сектора</b></div>',
      '        <h2>Карта сектора</h2>',
      '        <p>Авторская схема систем и мест Копрулу</p>',
      '      </section>',
    ].join('\n'),
    leftToggle: '',
    legacyToggle: [
      '          <button class="icon-button collapse-button" id="toggleSidePanel" type="button" aria-label="Скрыть каталог" title="Скрыть каталог">',
      '            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h10M4 19h16"></path><path d="m17 9 3 3-3 3"></path></svg>',
      '          </button>',
    ].join('\n'),
    modalFoot: '<span>ОБЗОРНАЯ СХЕМА</span><span>КАТАЛОГ СЕКТОРА КОПРУЛУ</span>',
    modalTitle: 'О карте и данных',
    returnScripts: '',
    title: 'Timeline Project — Map Atlas (минимальный скин)',
  },
};

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
  if (!logical || !finalizedAssets.has(logical)) return tag;
  const key = tokenQueueKey(filename, logical);
  const queue = tokenReferenceQueues.get(key) ?? [];
  queue.push(rawRef);
  tokenReferenceQueues.set(key, queue);
  return tag.replace(attrPattern, `${attrName}=${quote}${tokenOrigin}/${logical}${quote}`);
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
    if (['.css', '.html', '.js'].includes(extension)) continue;
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
