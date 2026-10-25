import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addressOf,
  centerOf,
  formatAddress,
  rectOf,
} from '../src/atlas/sector-address.ts';

const metaPath = fileURLToPath(new URL('../data/meta.json', import.meta.url));
const systemsPath = fileURLToPath(new URL('../data/systems.csv', import.meta.url));
const GOLDEN_VECTORS = [
  { x: 5720, y: 6257, address: 'KP·REQHC' },
  { x: 5749, y: 5984, address: 'KP·MYVYB' },
  { x: 5568, y: 5994, address: 'KP·MXYXP' },
  { x: 5683, y: 5855, address: 'KP·MYQAU' },
  { x: 5086, y: 5896, address: 'KP·MWSRO' },
  { x: 6683, y: 5076, address: 'KP·NLSMI' },
  { x: 9233, y: 4539, address: 'KP·OIFRP' },
  { x: 8396, y: 3061, address: 'KP·JKTJI' },
  { x: 0, y: 0, address: 'KP·AAAAA' },
  { x: 9999, y: 9999, address: 'KP·YYYYY' },
  { x: 2500, y: 2500, address: 'KP·GGGGG' },
];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
    } else {
      field += character;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function loadSystems() {
  const rows = parseCsv(readFileSync(systemsPath, 'utf8'));
  const headers = rows[0] ?? [];
  const nameIndex = headers.indexOf('name');
  const xIndex = headers.indexOf('x');
  const yIndex = headers.indexOf('y');
  if (nameIndex < 0 || xIndex < 0 || yIndex < 0) {
    throw new Error('В systems.csv отсутствует одна из колонок name, x, y.');
  }

  return rows.slice(1)
    .filter((record) => record.some((value) => value.trim().length > 0))
    .map((record) => ({
      name: record[nameIndex] ?? '',
      x: Number(record[xIndex]),
      y: Number(record[yIndex]),
    }));
}

function printGoldenVectors() {
  console.log('Актуальные golden vectors (x, y → адрес):');
  for (const vector of GOLDEN_VECTORS) {
    console.log(`  ${vector.x}, ${vector.y} → ${formatAddress(addressOf(vector.x, vector.y))}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const regen = args.includes('--regen');
  if (args.some((argument) => argument !== '--regen')) {
    console.error('Использование: node tools/verify_sector_address.mjs [--regen]');
    process.exitCode = 1;
    return;
  }

  const errors = [];
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  if (meta.mapSize !== 10000) {
    errors.push(`mapSize должен быть 10000, получено ${String(meta.mapSize)}.`);
  }

  const systems = loadSystems();
  if (systems.length !== 173) {
    errors.push(`Ожидалось 173 системы, найдено ${systems.length}.`);
  }

  const addresses = new Set();
  let maxRoundTrip = 0;
  for (const system of systems) {
    if (!Number.isFinite(system.x) || !Number.isFinite(system.y)) {
      errors.push(`У системы «${system.name}» некорректные координаты.`);
      continue;
    }
    const address = addressOf(system.x, system.y);
    const compact = formatAddress(address);
    addresses.add(compact);

    const rect = rectOf(address);
    const center = centerOf(address);
    const centerAddress = addressOf(center.x, center.y);
    const repeatedCenter = centerOf(centerAddress);
    const roundTrip = Math.max(
      Math.abs(center.x - repeatedCenter.x),
      Math.abs(center.y - repeatedCenter.y),
    );
    maxRoundTrip = Math.max(maxRoundTrip, roundTrip);
    if (roundTrip > 1e-9 || formatAddress(centerAddress) !== compact) {
      errors.push(`Round-trip адреса системы «${system.name}» превысил допуск.`);
    }
    if (center.x < rect.x || center.x >= rect.x + rect.size
      || center.y < rect.y || center.y >= rect.y + rect.size) {
      errors.push(`Центр узла системы «${system.name}» вне её прямоугольника.`);
    }
  }

  if (addresses.size !== systems.length) {
    errors.push(`Адреса не уникальны: ${addresses.size} уникальных для ${systems.length} систем.`);
  }

  let matchingGoldens = 0;
  for (const vector of GOLDEN_VECTORS) {
    if (formatAddress(addressOf(vector.x, vector.y)) === vector.address) {
      matchingGoldens += 1;
    } else if (!regen) {
      errors.push(`Golden vector ${vector.x}, ${vector.y} не совпал (ожидался ${vector.address}).`);
    }
  }

  if (regen) {
    printGoldenVectors();
  }
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`ОШИБКА: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Проверка адресов пройдена: ${systems.length} систем, ${addresses.size} уникальных адресов; `
    + `максимум round-trip ${maxRoundTrip} св.г.; golden vectors ${matchingGoldens}/${GOLDEN_VECTORS.length}.`);
}

main();
