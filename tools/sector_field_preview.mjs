#!/usr/bin/env node
/**
 * Предпросмотр процедурного поля сектора без браузера (шаг `SW-2A`, §17.7 «G7.3-подготовка»).
 *
 * Рисует оба пресета поля на ширинах `L0 / L4 / L9` через CPU-путь и пишет
 * шесть PNG в `docs/stages/evidence/sw2-field/`:
 *
 *     l0-nebula.png      l0-tactical.png
 *     l4-nebula.png      l4-tactical.png
 *     l9-nebula.png      l9-tactical.png
 *
 * Ни браузера, ни новых зависимостей: только `node:fs`, `node:zlib`, `node:path`
 * и собственный PNG-энкодер. Ширины кадра берутся из `visibleWidthForLevel()`
 * (`src/atlas/level-ladder.ts`), а не литералами.
 *
 * Скрипт детерминирован: второй прогон даёт побайтово те же файлы.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { createSectorField, FIELD_SEED_TEXT, hashSeed } from '../src/atlas/sector-field.ts';
import { visibleWidthForLevel } from '../src/atlas/level-ladder.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'stages', 'evidence', 'sw2-field');

const MAP_SIZE = 10000;
const DEFAULT_SIZE = 1024;
const LEVELS = [0, 4, 9];
const STYLES = ['nebula', 'tactical'];

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    crc = (CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

/** RGB8 PNG без альфы: у поля альфа всегда 255. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // бит на канал
  header[9] = 2; // цветовой тип: truecolor RGB
  header[10] = 0; // deflate
  header[11] = 0; // фильтрация по умолчанию
  header[12] = 0; // без чересстрочности

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const target = y * (stride + 1);
    raw[target] = 0; // фильтр None: детерминированно и без потерь
    const source = y * width * 4;
    for (let x = 0; x < width; x++) {
      raw[target + 1 + x * 3] = rgba[source + x * 4];
      raw[target + 2 + x * 3] = rgba[source + x * 4 + 1];
      raw[target + 3 + x * 3] = rgba[source + x * 4 + 2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ кадр */

/**
 * Состояние кадра ровно на ширине уровня: масштаб такой, что в кадр попадает
 * `visibleWidthForLevel(level)` мировых единиц, центр — центр карты.
 */
function stateForLevel(level, size) {
  const visibleWidth = visibleWidthForLevel(level);
  const scale = size / visibleWidth;
  return {
    view: { scale, tx: size / 2 - (MAP_SIZE / 2) * scale, ty: size / 2 - (MAP_SIZE / 2) * scale },
    viewport: { w: size, h: size },
    dpr: 1,
    mapSize: MAP_SIZE,
  };
}

/**
 * Метрики кадра ровно по определениям §17.12:
 *  - `meanL` — средняя яркость `0.2126R + 0.7152G + 0.0722B` по всем пикселям;
 *  - `edge` — средний модуль лапласиана яркости по внутренним пикселям
 *    (`|L(x−1) + L(x+1) + L(y−1) + L(y+1) − 4L|`), `edge / meanL` — деталь
 *    на единицу яркости;
 *  - `uniq` — число различных RGB-троек.
 */
function frameMetrics(data, width, height) {
  const luminance = new Float64Array(width * height);
  const seen = new Set();
  let sum = 0;
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel++) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[pixel] = value;
    sum += value;
    seen.add((r << 16) | (g << 8) | b);
  }

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const pixel = y * width + x;
      edgeSum += Math.abs(
        luminance[pixel - 1] + luminance[pixel + 1]
        + luminance[pixel - width] + luminance[pixel + width]
        - 4 * luminance[pixel],
      );
      edgeCount++;
    }
  }

  const meanL = sum / (width * height);
  const edge = edgeCount > 0 ? edgeSum / edgeCount : 0;
  return { meanL, edge, ratio: meanL > 0 ? edge / meanL : 0, uniq: seen.size };
}

function main() {
  const sizeArg = process.argv.find((arg) => arg.startsWith('--size='));
  const size = sizeArg ? Number.parseInt(sizeArg.slice('--size='.length), 10) : DEFAULT_SIZE;
  if (!Number.isInteger(size) || size < 64 || size > 4096) {
    console.error(`Некорректный --size=${sizeArg?.slice(7) ?? ''}: нужно целое 64…4096`);
    process.exit(2);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`Поле сектора: seed "${FIELD_SEED_TEXT}" = 0x${hashSeed(FIELD_SEED_TEXT).toString(16)}, кадр ${size}×${size}`);

  let totalBytes = 0;
  let slowest = 0;
  const report = [];
  for (const level of LEVELS) {
    for (const style of STYLES) {
      const field = createSectorField(null, { style });
      const state = stateForLevel(level, size);
      const started = process.hrtime.bigint();
      const image = field.renderToImageData(state);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      slowest = Math.max(slowest, elapsedMs);

      const file = path.join(OUTPUT_DIR, `l${level}-${style}.png`);
      const png = encodePng(image.width, image.height, image.data);
      writeFileSync(file, png);
      totalBytes += png.length;
      field.dispose();

      const metrics = frameMetrics(image.data, image.width, image.height);
      console.log(
        `  L${level} ${style.padEnd(8)} ${image.width}×${image.height}  ` +
        `meanL ${metrics.meanL.toFixed(1).padStart(5)}  ` +
        `edge/meanL ${metrics.ratio.toFixed(4)}  ` +
        `uniq ${metrics.uniq.toString().padStart(6)}  ` +
        `${(image.width / visibleWidthForLevel(level)).toFixed(3)} px/ед.  ` +
        `${elapsedMs.toFixed(0).padStart(5)} мс  ` +
        `${(png.length / 1024).toFixed(0).padStart(4)} КБ`,
      );
      report.push({ level, style, metrics, elapsedMs, bytes: png.length });
    }
  }

  console.log(`Каталог: ${path.relative(REPO_ROOT, OUTPUT_DIR)}`);
  console.log(`Всего ${(totalBytes / 1024 / 1024).toFixed(2)} МиБ (бюджет 8 МиБ), самый долгий кадр ${slowest.toFixed(0)} мс (бюджет 8000 мс)`);

  // Сводка критериев §17.12 `V-2`, `V-3`, `V-4` — приёмка воспроизводится из лога.
  console.log('Сводка критериев V-2…V-4 (кадр 1024², те же определения метрик):');
  for (const style of STYLES) {
    const rows = report.filter((row) => row.style === style);
    const [l0, l4, l9] = rows;
    const baseRatio = l0.metrics.ratio;
    console.log(
      `  ${style.padEnd(8)} meanL L0/L4/L9 = ${l0.metrics.meanL.toFixed(1)}/${l4.metrics.meanL.toFixed(1)}/` +
      `${l9.metrics.meanL.toFixed(1)} (полоса 12…40), рост L9/L0 = ${(l9.metrics.meanL / l0.metrics.meanL).toFixed(2)} (норма ≤ 1,25); ` +
      `деталь L4/L0 = ${(l4.metrics.ratio / baseRatio).toFixed(2)}, L9/L0 = ${(l9.metrics.ratio / baseRatio).toFixed(2)} (норма ≥ 0,90); ` +
      `uniq = ${rows.map((row) => row.metrics.uniq).join('/')}`,
    );
  }

  measureScreenPath();
}

/**
 * Замер экранного пути `renderField` (§17.5 п. 5, критерий `V-7`) на кадре
 * `1920 × 1080`, `L0`. Три числа, потому что путей растяжения два:
 *  - «браузерный» — холст сам растягивает буфер (`drawImage` на GPU). Так
 *    `renderField` работает на странице; в песочнице холст заменён заглушкой
 *    с той же сигнатурой, поэтому число показывает цену шума, но не блита
 *    (реальный блит — единицы миллисекунд и меряется только в браузере);
 *  - «Node-фолбэк» — растяжение в JS-коде (как в окружении без `<canvas>`),
 *    холодный первый кадр и установившийся режим;
 *  - «кэш» — повторный кадр с тем же состоянием.
 */
function measureScreenPath() {
  const width = 1920;
  const height = 1080;
  const state = {
    view: { scale: width / MAP_SIZE, tx: 0, ty: 0 },
    viewport: { w: width, h: height },
    dpr: 1,
    mapSize: MAP_SIZE,
  };

  function makeCanvas() {
    let draws = 0;
    const ctx = {
      drawImage: () => { draws += 1; },
      clearRect: () => {},
      putImageData: () => { draws += 1; },
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: (kind) => (kind === '2d' ? ctx : null),
    };
    return { canvas, draws: () => draws };
  }

  // «Браузерный» путь: холст умеет drawImage, document.createElement — заглушка.
  const scope = globalThis;
  const hadDocument = Object.prototype.hasOwnProperty.call(scope, 'document');
  const previousDocument = scope.document;
  scope.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ putImageData: () => {} }),
    }),
  };

  const browser = makeCanvas();
  const browserField = createSectorField(browser.canvas, { style: 'nebula' });
  let started = process.hrtime.bigint();
  browserField.renderField(state);
  const browserFirst = Number(process.hrtime.bigint() - started) / 1e6;
  started = process.hrtime.bigint();
  browserField.renderField(state);
  const browserCached = Number(process.hrtime.bigint() - started) / 1e6;
  browserField.dispose();

  // Node-фолбэк: без `document` холст растягивает картинку сам код.
  if (hadDocument) scope.document = previousDocument;
  else delete scope.document;

  const fallback = makeCanvas();
  const fallbackField = createSectorField(fallback.canvas, { style: 'nebula' });
  started = process.hrtime.bigint();
  fallbackField.renderField(state);
  const fallbackFirst = Number(process.hrtime.bigint() - started) / 1e6;
  let cachedTotal = 0;
  const repeats = 20;
  started = process.hrtime.bigint();
  for (let index = 0; index < repeats; index++) fallbackField.renderField(state);
  cachedTotal = Number(process.hrtime.bigint() - started) / 1e6 / repeats;
  // Промах кэша: сдвиг камеры на единицу — это новый кадр.
  started = process.hrtime.bigint();
  fallbackField.renderField({
    ...state,
    view: { scale: state.view.scale, tx: state.view.tx + 1, ty: state.view.ty },
  });
  const fallbackMoved = Number(process.hrtime.bigint() - started) / 1e6;
  fallbackField.dispose();

  console.log('Экранный путь renderField (CPU, кадр 1920×1080, L0, критерий V-7):');
  console.log(`  браузерный путь (холст растягивает сам), первый кадр — ${browserFirst.toFixed(1)} мс (норма ≤ 50 мс)`);
  console.log(`  браузерный путь, повторный кадр из кэша — ${browserCached.toFixed(2)} мс (норма ≤ 5 мс), нативных блитов ${browser.draws()}`);
  console.log(`  Node-фолбэк (растяжение в JS), первый кадр — ${fallbackFirst.toFixed(1)} мс`);
  console.log(`  Node-фолбэк, промах кэша (сдвиг камеры) — ${fallbackMoved.toFixed(1)} мс`);
  console.log(`  Node-фолбэк, повторный кадр из кэша (${repeats} повторов) — ${cachedTotal.toFixed(2)} мс, блитов ${fallback.draws()}`);
}

main();
