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

function uniqueColors(data) {
  const seen = new Set();
  for (let index = 0; index < data.length; index += 4) {
    seen.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
  }
  return seen.size;
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

      console.log(
        `  L${level} ${style.padEnd(8)} ${image.width}×${image.height}  ` +
        `${elapsedMs.toFixed(0).padStart(5)} мс  ` +
        `${(image.width / visibleWidthForLevel(level)).toFixed(3)} px/ед.  ` +
        `цветов ${uniqueColors(image.data).toString().padStart(6)}  ` +
        `${(png.length / 1024).toFixed(0).padStart(4)} КБ`,
      );
    }
  }

  console.log(`Каталог: ${path.relative(REPO_ROOT, OUTPUT_DIR)}`);
  console.log(`Всего ${(totalBytes / 1024 / 1024).toFixed(2)} МиБ (бюджет 8 МиБ), самый долгий кадр ${slowest.toFixed(0)} мс (бюджет 8000 мс)`);
}

main();
