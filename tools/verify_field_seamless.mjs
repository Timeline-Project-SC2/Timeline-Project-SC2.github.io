#!/usr/bin/env node
/**
 * Гейт бесшовности сектора: стык с соседним сектором не виден.
 *
 * Требование владельца (25.10.2026): «главное — бесшовность между секторами, в дизайне
 * и без видимых границ». Поле сектора обязано быть **периодичным по карте**: соседний
 * сектор — продолжение того же поля, а не другая картинка, приставленная вплотную.
 * Плюс в рантайме не должно быть нарисованной рамки сектора: `strokeRect` по границе
 * карты читается как «край мира» и прямо противоречит требованию.
 *
 * Проверки:
 *   1. `field(x, y) === field(x + mapSize, y)` и по `y` — четыре угловых сдвига,
 *      пиксельное равенство через CPU-путь (детерминизм `G7.6` уже гарантирует
 *      повторяемость, здесь проверяется именно периодичность);
 *   2. на кадре, центрированном на шве карты, нет всплеска детали в центральном
 *      столбце/строке: отношение к среднему по кадру ≤ `1,5` — иначе шов виден как линия;
 *   3. в `src/atlas/canvas-renderer.ts` нет `strokeRect` и нет комментария «рамка сектора».
 *
 * Запуск: `node tools/verify_field_seamless.mjs`. Код возврата: `0` — бесшовно,
 * `1` — найдено нарушение, `2` — ошибка окружения.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MAP_SIZE = 10000;
const FRAME = 96;
const SCALE = 20;
const CORNER_PROBE = 200;

const results = [];

function record(id, title, ok, details) {
  results.push({ id, title, ok, details: details ?? '' });
}

function frameState(centreX, centreY) {
  return {
    view: { scale: SCALE, tx: FRAME / 2 - centreX * SCALE, ty: FRAME / 2 - centreY * SCALE },
    viewport: { w: FRAME, h: FRAME },
    dpr: 1,
    mapSize: MAP_SIZE,
  };
}

function luminance(data) {
  const out = new Float64Array(FRAME * FRAME);
  for (let index = 0; index < out.length; index++) {
    out[index] =
      0.2126 * (data[index * 4] ?? 0) + 0.7152 * (data[index * 4 + 1] ?? 0) + 0.0722 * (data[index * 4 + 2] ?? 0);
  }
  return out;
}

async function main() {
  let createSectorField;
  try {
    ({ createSectorField } = await import(path.join(ROOT, 'src', 'atlas', 'sector-field.ts')));
  } catch (error) {
    console.error(`Не удалось загрузить поле сектора: ${error.message}`);
    process.exit(2);
  }

  const field = createSectorField(null, { style: 'nebula' });
  const shot = (centreX, centreY) => Buffer.from(field.renderToImageData(frameState(centreX, centreY)).data.buffer);

  const base = shot(CORNER_PROBE, CORNER_PROBE);
  const shifts = [
    { id: '1a', title: 'сдвиг по x на mapSize', x: CORNER_PROBE + MAP_SIZE, y: CORNER_PROBE },
    { id: '1b', title: 'сдвиг по y на mapSize', x: CORNER_PROBE, y: CORNER_PROBE + MAP_SIZE },
    { id: '1c', title: 'сдвиг по x и y на mapSize', x: CORNER_PROBE + MAP_SIZE, y: CORNER_PROBE + MAP_SIZE },
    { id: '1d', title: 'сдвиг в отрицательную сторону', x: CORNER_PROBE - MAP_SIZE, y: CORNER_PROBE },
  ];

  for (const shift of shifts) {
    const probe = shot(shift.x, shift.y);
    let differing = 0;
    let maxDelta = 0;
    for (let index = 0; index < base.length; index++) {
      const delta = Math.abs((base[index] ?? 0) - (probe[index] ?? 0));
      if (delta !== 0) differing++;
      if (delta > maxDelta) maxDelta = delta;
    }
    record(
      shift.id,
      `периодичность поля: ${shift.title}`,
      differing === 0,
      differing === 0 ? 'совпало побайтово' : `несовпавших байт ${differing} из ${base.length}, maxΔ=${maxDelta}`,
    );
  }

  // 2. Шов не читается как линия: деталь в центральном столбце и строке.
  const seamFrame = shot(0, 0);
  const lum = luminance(seamFrame);
  const columnEnergy = (column) => {
    let sum = 0;
    for (let y = 1; y < FRAME - 1; y++) {
      const index = y * FRAME + column;
      sum += Math.abs(2 * (lum[index] ?? 0) - (lum[index - 1] ?? 0) - (lum[index + 1] ?? 0));
    }
    return sum / (FRAME - 2);
  };
  const rowEnergy = (row) => {
    let sum = 0;
    for (let x = 1; x < FRAME - 1; x++) {
      const index = row * FRAME + x;
      sum += Math.abs(2 * (lum[index] ?? 0) - (lum[index - FRAME] ?? 0) - (lum[index + FRAME] ?? 0));
    }
    return sum / (FRAME - 2);
  };

  let total = 0;
  for (let column = 1; column < FRAME - 1; column++) total += columnEnergy(column);
  const meanColumn = total / (FRAME - 2);
  const centreColumn = Math.max(columnEnergy(FRAME / 2 - 1), columnEnergy(FRAME / 2));
  const centreRow = Math.max(rowEnergy(FRAME / 2 - 1), rowEnergy(FRAME / 2));
  const ratio = meanColumn > 0 ? Math.max(centreColumn, centreRow) / meanColumn : Number.POSITIVE_INFINITY;
  record(
    '2',
    'шов не читается как линия (деталь по центру кадра)',
    Number.isFinite(ratio) && ratio <= 1.5,
    `отношение ${ratio.toFixed(2)} (норма ≤ 1,50)`,
  );

  field.dispose();

  // 3. Рамка сектора в рантайме.
  const rendererPath = path.join(ROOT, 'src', 'atlas', 'canvas-renderer.ts');
  const renderer = readFileSync(rendererPath, 'utf8');
  const markers = ['strokeRect', 'рамка сектора'];
  const found = markers.filter((marker) => renderer.includes(marker));
  record(
    '3',
    'в рантайме нет нарисованной рамки сектора',
    found.length === 0,
    found.length === 0 ? 'чисто' : `найдено: ${found.join(', ')}`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`Проверка не смогла выполниться: ${error.message}`);
  process.exit(2);
}

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'ок  ' : 'НЕТ '} ${item.id}. ${item.title}`);
  if (item.details.length > 0) console.log(`     ${item.details}`);
}

if (failed.length > 0) {
  console.error(
    `\nБесшовность не выполнена: ${failed.length} из ${results.length} проверок красные. ` +
      'Поле не периодично по карте, соседний сектор даст видимый стык.',
  );
  process.exit(1);
}

console.log(`\nБесшовность выполнена: ${results.length} из ${results.length} проверок зелёные.`);
