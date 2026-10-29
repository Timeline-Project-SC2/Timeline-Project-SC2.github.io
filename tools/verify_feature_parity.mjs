#!/usr/bin/env node
/* Манифест полноты публикации для CR-01 (И-6).
 *
 * Проверяет уже собранную папку .publish:
 *   - все маршруты на месте и непустые;
 *   - build-manifest.json согласован с файлами;
 *   - HTML ссылается только на существующие локальные JS/CSS;
 *   - все new Worker()/importScripts() внутри опубликованных JS ведут на
 *     существующие hashed JS-файлы публикации;
 *   - в публикации не осталось build-token/placeholder;
 *   - в исходных HTML и worker-подключениях нет ручных статических ?v=.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publishRoot = resolve(root, process.argv[2] || '.publish');
const siteRoot = resolve(root, 'site');
const routes = [
  'index.html',
  'sector/sector.html',
  'sector/admin-edit/index.html',
  'minimal/minimal.html',
  'cursor-test/index.html',
  'spiral-test/index.html',
  'planet-test/index.html',
  'planet-globe/index.html',
];

const failures = [];

function fail(message) {
  failures.push(message);
}

function walk(dir) {
  const output = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}

function stripQuery(ref) {
  return ref.split(/[?#]/, 1)[0];
}

function isExternal(ref) {
  return !ref || ref.startsWith('#') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

function publishPathForRef(ref, fromRoute) {
  const clean = stripQuery(ref);
  if (clean.startsWith('/')) return normalize(clean.slice(1));
  return normalize(join(dirname(fromRoute), clean));
}

for (const route of routes) {
  const path = resolve(publishRoot, route);
  if (!existsSync(path) || statSync(path).size === 0) fail(`нет маршрута: ${route}`);
}

const manifestPath = resolve(publishRoot, 'build-manifest.json');
let manifest = null;
if (!existsSync(manifestPath)) {
  fail('нет build-manifest.json');
} else {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const route of routes) {
    if (!manifest.routes?.includes(route)) fail(`в манифесте нет маршрута: ${route}`);
  }
  for (const [source, output] of Object.entries(manifest.assets || {})) {
    const outputPath = resolve(publishRoot, output);
    if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
      fail(`в манифесте нет файла на диске: ${source} -> ${output}`);
    }
    if (!/-[0-9a-f]{10}\.(?:css|js)$/.test(output)) {
      fail(`ассет без контент-хэша в имени: ${source} -> ${output}`);
    }
  }
  // Модули с собственным window/globalThis API нельзя публиковать через
  // esbuild globalName: внешний var выполнится после IIFE и перезапишет API
  // ESM-namespace (так у GalaxySpiral терялся .overlay()). Контракт PG1,
  // наоборот, именно namespace и публикует под своим глобалом.
  const publishedAssetText = (source) => {
    const output = manifest.assets?.[source];
    const path = output ? resolve(publishRoot, output) : '';
    return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
  };
  for (const [source, globalName] of Object.entries({
    'shared/galaxy-spiral.ts': 'GalaxySpiral',
    'shared/travel-planner.ts': 'TravelPlanner',
    'shared/geodesic-grid.ts': 'GeodesicGrid',
    'shared/planet-noise.ts': 'PlanetNoise',
    'shared/planet-geography.ts': 'PlanetGeography',
    'shared/planet-surface.ts': 'PlanetSurface',
    'shared/planet-globe.ts': 'PlanetGlobe',
  })) {
    const text = publishedAssetText(source);
    if (!text.includes(`globalThis.${globalName} =`)) {
      fail(`опубликованный модуль потерял собственный глобал ${globalName}: ${source}`);
    }
    if (new RegExp(`^var ${globalName} =`, 'm').test(text)) {
      fail(`esbuild globalName перезаписывает собственный глобал ${globalName}: ${source}`);
    }
  }
  if (!/^var PlanetGenerationContract =/m.test(publishedAssetText('shared/planet-generation-contract.ts'))) {
    fail('контракт PG1 опубликован без глобала PlanetGenerationContract');
  }
}

const assetTagPattern = /<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*(['"])([^'"]+)\1/gi;
const publishedHtml = new Map();
for (const route of routes) {
  const path = resolve(publishRoot, route);
  if (!existsSync(path)) continue;
  const html = readFileSync(path, 'utf8');
  publishedHtml.set(route, html);
  if (html.includes('timeline-asset.invalid')) fail(`не заменён build-token: ${route}`);
  if (html.includes('@@')) fail(`не заменён placeholder шаблона: ${route}`);
  if (html.includes('atlas-variant:')) fail(`в публикацию попал исходный atlas-entry: ${route}`);

  for (const match of html.matchAll(assetTagPattern)) {
    const ref = match[2];
    if (isExternal(ref)) continue;
    const clean = stripQuery(ref);
    if (!/\.(?:css|js)$/.test(clean)) continue;
    const target = publishPathForRef(ref, route);
    if (!existsSync(resolve(publishRoot, target))) fail(`битая ссылка ${ref} в ${route}`);
    if (!/-[0-9a-f]{10}\.(?:css|js)$/.test(clean)) fail(`ссылка без контент-хэша ${ref} в ${route}`);
  }
}

for (const route of routes) {
  const html = publishedHtml.get(route) || '';
  let hasHiddenRule = /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(html);
  if (!hasHiddenRule) {
    for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*(['"])([^'"]+\.css)\1/gi)) {
      const target = resolve(publishRoot, publishPathForRef(match[2], route));
      if (existsSync(target) && /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(readFileSync(target, 'utf8'))) {
        hasHiddenRule = true;
        break;
      }
    }
  }
  if (!hasHiddenRule) fail(`нет глобального [hidden] правила: ${route}`);
}

const sectorHtml = publishedHtml.get('sector/sector.html') || '';
const minimalHtml = publishedHtml.get('minimal/minimal.html') || '';
for (const marker of ['id="mapCanvas"', 'id="searchInput"', 'id="catalogList"', 'id="detailPanel"']) {
  if (!sectorHtml.includes(marker)) fail(`sector потерял общий узел атласа: ${marker}`);
  if (!minimalHtml.includes(marker)) fail(`minimal потерял общий узел атласа: ${marker}`);
}
if (!sectorHtml.includes('id="coordinateToggle"') || !sectorHtml.includes('id="galaxyReturn"')) {
  fail('sector потерял секторные элементы варианта');
}
if (minimalHtml.includes('id="coordinateToggle"') || minimalHtml.includes('id="galaxyReturn"')) {
  fail('minimal получил секторные элементы варианта');
}
if (!minimalHtml.includes('<body class="minimal-mode">')) fail('minimal потерял body class варианта');
const aboutButtonAt = sectorHtml.indexOf('id="helpButton"');
const adminButtonAt = sectorHtml.indexOf('class="admin-gate-link"');
const galaxyButtonAt = sectorHtml.indexOf('id="galaxyReturn"');
if (!(aboutButtonAt >= 0 && aboutButtonAt < adminButtonAt && adminButtonAt < galaxyButtonAt)) {
  fail('секторная кнопка администратора должна стоять между «О карте» и «К Галактике»');
}
if (minimalHtml.includes('admin-gate-link')) fail('minimal получил кнопку доступа администратора');
const adminHtml = publishedHtml.get('sector/admin-edit/index.html') || '';
for (const marker of ['id="mapCanvas"', 'id="adminGateForm"', 'id="adminEditorPanel"', 'Модули', 'Свойства', 'Изменения']) {
  if (!adminHtml.includes(marker)) fail(`admin-edit потерял узел: ${marker}`);
}
if (!adminHtml.includes('id="adminEditorPanel" data-admin-editor aria-labelledby="adminEditorTitle" hidden')) {
  fail('панель admin-edit должна быть скрыта до тестовой проверки');
}
if (!adminHtml.includes('id="adminGateError" role="alert" hidden')) fail('admin-edit потерял начальное скрытие ошибки формы');
if (adminHtml.includes('atlas-variant:') || adminHtml.includes('@@')) fail('admin-edit не прошёл рендер общего шаблона');

function publishRelative(fullPath) {
  return relative(publishRoot, fullPath).split('\\').join('/');
}

function checkPublishedScriptReference(ref, fromPublishPath, kind) {
  const label = `${kind} ${ref} в ${fromPublishPath}`;
  if (isExternal(ref)) {
    fail(`не локальная worker-ссылка: ${label}`);
    return;
  }
  const clean = stripQuery(ref);
  if (!clean.endsWith('.js')) {
    fail(`worker-ссылка не на JS: ${label}`);
    return;
  }
  if (!/-[0-9a-f]{10}\.js$/.test(clean)) fail(`worker-ссылка без контент-хэша: ${label}`);
  const target = publishPathForRef(ref, fromPublishPath).split('\\').join('/');
  if (target === '..' || target.startsWith('../')) {
    fail(`worker-ссылка выходит за пределы публикации: ${label}`);
    return;
  }
  if (!existsSync(resolve(publishRoot, target))) {
    fail(`битая worker-ссылка: ${label} -> ${target}`);
  }
}

for (const fullPath of walk(publishRoot)) {
  if (/\.(?:mts|ts)$/.test(fullPath)) {
    fail(`сырой TypeScript в публикации вместо собранного JS: ${publishRelative(fullPath)}`);
    continue;
  }
  if (!fullPath.endsWith('.js')) continue;
  const publishPath = publishRelative(fullPath);
  const text = readFileSync(fullPath, 'utf8');

  for (const match of text.matchAll(/\bnew\s+Worker\s*\(\s*(['"])([^'"]+)\1/g)) {
    checkPublishedScriptReference(match[2], publishPath, 'new Worker()');
  }
  for (const match of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/gs)) {
    for (const argMatch of (match[1] || '').matchAll(/(['"])([^'"]+)\1/g)) {
      checkPublishedScriptReference(argMatch[2], publishPath, 'importScripts()');
    }
  }
  // Stage-8.10b (A-12b): динамические import() на статические записи —
  // ленивые чанки (например local-map-worker-lazy) обязаны вести на
  // существующие hashed JS-файлы публикации.
  for (const match of text.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    checkPublishedScriptReference(match[2], publishPath, 'dynamic import()');
  }
}

for (const fullPath of walk(publishRoot)) {
  if (!/\.(?:css|html|js|json)$/.test(fullPath)) continue;
  const text = readFileSync(fullPath, 'utf8');
  if (text.includes('timeline-asset.invalid')) {
    fail(`не заменён build-token: ${relative(publishRoot, fullPath)}`);
  }
}

for (const fullPath of walk(siteRoot)) {
  const extension = extname(fullPath);
  if (extension === '.html') {
    const text = readFileSync(fullPath, 'utf8');
    if (text.includes('?v=')) fail(`ручной ?v= в HTML: ${relative(root, fullPath)}`);
  }
  if (extension === '.js' || extension === '.ts' || extension === '.mts') {
    const text = readFileSync(fullPath, 'utf8');
    if (/\.(?:js|mts|ts)\?v=/.test(text) || /new\s+Worker\([^)]*\?v=/.test(text) || /importScripts\([^)]*\?v=/s.test(text)) {
      fail(`ручной ?v= в JS/TS worker-подключении: ${relative(root, fullPath)}`);
    }
  }
}

const templatePath = resolve(root, 'templates/atlas-shell.html');
if (!existsSync(templatePath)) fail('нет templates/atlas-shell.html');
else if (readFileSync(templatePath, 'utf8').includes('?v=')) fail('ручной ?v= в templates/atlas-shell.html');

if (failures.length) {
  console.error('Feature parity FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Feature parity OK: ${routes.length} маршрутов, ${Object.keys(manifest.assets || {}).length} hashed-ассетов.`);
