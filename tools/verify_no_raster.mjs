#!/usr/bin/env node
/**
 * Гейт `G7.3` волны `SW-2`: в проекте не осталось растрового контура сектора.
 *
 * `§17.7` в `docs/agents_task_orchestration/agents_task_orchestration.md`: проверка `И-10`
 * в исполняемой форме. Скрипт написан **до** удаления контура (red-first) и обязан падать
 * на ветке `SW-2A` и на `main` до слияния `SW-2B`; зелёным он становится только после того,
 * как Воркер 2 удалит пирамиду тайлов, превью и исходный JPG.
 *
 * Проверки:
 *   1. в репозитории нет `assets/src/koprulu-sector.jpg`;
 *   2. в рантайме (`src/atlas/*.ts`, `site/shared/links.ts`) нет вхождений
 *      `CONFIG.tiles`, `rasterMode`, `sectorMapPreview`, `TilePyramid`;
 *   3. в `data/meta.json` блок `assets` не содержит `hasRaster`/`preview`/`tiles`/`version`,
 *      но **обязан** сохранить `imageVersion` (ловушка §17.8 п. 3: им живёт кэш-бастинг
 *      картинок галактики через `tools/vite/asset-utils.ts`);
 *   4. `.github/workflows/check.yml` не требует `.publish/assets/tiles.json`;
 *   5. `.github/workflows/pages.yml` не кэширует тайлы и `map-preview`;
 *   6. `.github/workflows/assets.yml` не собирает и не выгружает тайлы;
 *   7. `.gitignore` не содержит правил под тайлы и превью;
 *   8. `tools/build_assets.py` не знает про `koprulu-sector`, `build_tiles`, `SECTOR_SOURCE`,
 *      `tiles.json` и `map-preview`;
 *   9. если `.publish` уже собран — в нём нет `assets/tiles*` и `assets/map-preview*`.
 *
 * Запуск: `node tools/verify_no_raster.mjs` (после `SW-2B` — `npm run verify:no-raster`).
 * Код возврата: `0` — контур удалён, `1` — остатки найдены, `2` — ошибка окружения.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Маркеры растрового контура в рантайме: имя → человеческое описание. */
const RUNTIME_MARKERS = [
  ['CONFIG.tiles', 'доступ к пирамиде через конфиг'],
  ['rasterMode', 'переключатель режима подложки'],
  ['sectorMapPreview', 'ссылка на превью подложки'],
  ['TilePyramid', 'модуль пирамиды тайлов'],
];

/** Файлы, в которых маркеров быть не должно. */
const RUNTIME_FILES = [
  ...readdirSync(path.join(ROOT, 'src', 'atlas'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join('src', 'atlas', name)),
  path.join('site', 'shared', 'links.ts'),
];

/** Маркеры растрового контура в сборщике ассетов. */
const ASSET_MARKERS = ['koprulu-sector', 'build_tiles', 'SECTOR_SOURCE', 'tiles.json', 'map-preview'];

/** Строки, которых не должно быть в `.gitignore`. */
const GITIGNORE_MARKERS = ['assets/tiles', 'map-preview'];

const results = [];

function fail(id, title, details) {
  results.push({ id, title, ok: false, details });
}

function pass(id, title, details) {
  results.push({ id, title, ok: true, details: details ?? '' });
}

function readText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** Строки файла с номерами — для отчёта «где именно осталось». */
function findLines(text, marker) {
  const hits = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line !== undefined && line.includes(marker)) hits.push(index + 1);
  }
  return hits;
}

function checkSourceFile() {
  const source = path.join('assets', 'src', 'koprulu-sector.jpg');
  if (existsSync(path.join(ROOT, source))) {
    const size = statSync(path.join(ROOT, source)).size;
    fail('1', `исходник растра ${source}`, `файл на месте, ${(size / 1024 / 1024).toFixed(1)} МиБ`);
  } else {
    pass('1', `исходник растра ${source}`, 'удалён');
  }
}

function checkRuntime() {
  const found = [];
  for (const file of RUNTIME_FILES) {
    if (!existsSync(path.join(ROOT, file))) continue;
    const text = readText(file);
    for (const [marker, note] of RUNTIME_MARKERS) {
      const lines = findLines(text, marker);
      if (lines.length > 0) found.push(`${file}:${lines.join(',')} — ${marker} (${note})`);
    }
  }
  if (found.length > 0) {
    fail('2', 'рантайм без растрового контура', found.join('\n   '));
  } else {
    pass('2', 'рантайм без растрового контура', `${RUNTIME_FILES.length} файлов чисты`);
  }
}

function checkMeta() {
  const raw = readText(path.join('data', 'meta.json'));
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (error) {
    fail('3', 'data/meta.json — блок assets', `не разбирается как JSON: ${error.message}`);
    return;
  }

  const assets = meta.assets;
  if (assets === undefined) {
    fail('3', 'data/meta.json — блок assets', 'блока assets нет: imageVersion потерян');
    return;
  }

  const forbidden = ['hasRaster', 'preview', 'tiles', 'version'].filter((key) => key in assets);
  const problems = [];
  if (forbidden.length > 0) problems.push(`остались ключи: ${forbidden.join(', ')}`);
  if (!('imageVersion' in assets)) {
    problems.push('потерян imageVersion — сломается кэш-бастинг картинок галактики (§17.8 п. 3)');
  }

  if (problems.length > 0) {
    fail('3', 'data/meta.json — блок assets', problems.join('; '));
  } else {
    pass('3', 'data/meta.json — блок assets', 'растровых ключей нет, imageVersion на месте');
  }
}

function checkWorkflowFile(id, title, relativePath, markers) {
  if (!existsSync(path.join(ROOT, relativePath))) {
    fail(id, title, `нет файла ${relativePath}`);
    return;
  }

  const text = readText(relativePath);
  const found = [];
  for (const marker of markers) {
    const lines = findLines(text, marker);
    if (lines.length > 0) found.push(`строка ${lines.join(',')}: ${marker}`);
  }

  if (found.length > 0) {
    fail(id, title, found.join('\n   '));
  } else {
    pass(id, title, 'чисто');
  }
}

function checkGitignore() {
  const relativePath = '.gitignore';
  if (!existsSync(path.join(ROOT, relativePath))) {
    pass('7', '.gitignore без правил под растр', 'файла нет');
    return;
  }

  const found = [];
  for (const marker of GITIGNORE_MARKERS) {
    const lines = findLines(readText(relativePath), marker);
    if (lines.length > 0) found.push(`строка ${lines.join(',')}: ${marker}`);
  }

  if (found.length > 0) {
    fail('7', '.gitignore без правил под растр', found.join('\n   '));
  } else {
    pass('7', '.gitignore без правил под растр', 'чисто');
  }
}

function checkBuildAssets() {
  const relativePath = path.join('tools', 'build_assets.py');
  if (!existsSync(path.join(ROOT, relativePath))) {
    fail('8', 'tools/build_assets.py без растра', `нет файла ${relativePath}`);
    return;
  }

  const text = readText(relativePath);
  const found = [];
  for (const marker of ASSET_MARKERS) {
    const lines = findLines(text, marker);
    if (lines.length > 0) found.push(`строка ${lines.join(',')}: ${marker}`);
  }

  if (found.length > 0) {
    fail('8', 'tools/build_assets.py без растра', found.join('\n   '));
  } else {
    pass('8', 'tools/build_assets.py без растра', 'чисто');
  }
}

function checkPublish() {
  const publish = path.join(ROOT, '.publish');
  if (!existsSync(publish)) {
    pass('9', '.publish без тайлов и превью', 'каталог не собран — проверка пропущена');
    return;
  }

  const leftovers = [];
  const assetsDir = path.join(publish, 'assets');
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      if (name.startsWith('tiles') || name.startsWith('map-preview')) leftovers.push(`assets/${name}`);
    }
  }

  if (leftovers.length > 0) {
    fail('9', '.publish без тайлов и превью', leftovers.join(', '));
  } else {
    pass('9', '.publish без тайлов и превью', 'чисто');
  }
}

try {
  checkSourceFile();
  checkRuntime();
  checkMeta();
  checkWorkflowFile('4', 'check.yml не требует assets/tiles.json', path.join('.github', 'workflows', 'check.yml'), [
    'assets/tiles.json',
  ]);
  checkWorkflowFile('5', 'pages.yml не кэширует тайлы', path.join('.github', 'workflows', 'pages.yml'), [
    'assets/tiles',
    'map-preview',
  ]);
  checkWorkflowFile('6', 'assets.yml не выгружает тайлы', path.join('.github', 'workflows', 'assets.yml'), [
    'assets/tiles',
    'map-preview',
  ]);
  checkGitignore();
  checkBuildAssets();
  checkPublish();
} catch (error) {
  console.error(`Проверка не смогла выполниться: ${error.message}`);
  process.exit(2);
}

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  const mark = item.ok ? 'ок  ' : 'НЕТ ';
  console.log(`${mark} ${item.id}. ${item.title}`);
  if (item.details.length > 0) {
    console.log(`     ${item.details.split('\n').join('\n     ')}`);
  }
}

if (failed.length > 0) {
  console.error(
    `\nРастровый контур на месте: ${failed.length} из ${results.length} проверок красные. ` +
      'До слияния SW-2B это ожидаемо (§17.7, §17.9).',
  );
  process.exit(1);
}

console.log(`\nРастрового контура нет: ${results.length} из ${results.length} проверок зелёные.`);
