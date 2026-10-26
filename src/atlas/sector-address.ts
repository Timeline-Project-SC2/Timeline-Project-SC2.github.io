export type AddressLetters = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AddressTier {
  readonly id: string;
  readonly name: string;
  readonly cellSize: number;
}

export interface SectorAddress {
  readonly sector: string;
  readonly letters: string;
}

export const SECTOR_CODE = 'KP';
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const MAP_SIZE = 10000;

export const ADDRESS_TIERS: readonly AddressTier[] = Object.freeze([
  Object.freeze({ id: 'T0', name: 'Сектор', cellSize: 10000 }),
  Object.freeze({ id: 'T1', name: 'Квадрант', cellSize: 2000 }),
  Object.freeze({ id: 'T2', name: 'Регион', cellSize: 400 }),
  Object.freeze({ id: 'T3', name: 'Субсектор', cellSize: 80 }),
  Object.freeze({ id: 'T4', name: 'Ячейка', cellSize: 16 }),
  Object.freeze({ id: 'T5', name: 'Узел', cellSize: 3.2 }),
  // Версия 4.0 (§7.2): ряд `5×` продолжен без правки старших тиров — адреса
  // `T1…T5` и golden vectors остаются прежними. `T6`/`T7` живут только на
  // глубине: подпись ячейки фактической сетки на `L11…L12` и лупа.
  Object.freeze({ id: 'T6', name: 'Точка', cellSize: 0.64 }),
  Object.freeze({ id: 'T7', name: 'Пята', cellSize: 0.128 }),
]);

/** Вычисляет канонический адрес точки в поле Копрулу. */
export function addressOf(x: number, y: number): SectorAddress {
  return prefixOf(x, y, 5);
}

/** Возвращает адрес заданного уровня, перенося остаток координат между тирами. */
export function prefixOf(x: number, y: number, letters: AddressLetters): SectorAddress {
  if (!Number.isInteger(letters) || letters < 0 || letters > 7) {
    throw new TypeError('Уровень адреса должен быть целым числом от 0 до 7.');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) {
    throw new TypeError('Координаты должны находиться в пределах поля [0, 10000).');
  }

  let localX = x;
  let localY = y;
  let result = '';
  for (let tierIndex = 1; tierIndex <= letters; tierIndex += 1) {
    const tier = ADDRESS_TIERS[tierIndex];
    if (tier === undefined) {
      throw new TypeError('Неизвестный уровень адреса.');
    }
    const col = Math.floor(localX / tier.cellSize);
    const row = Math.floor(localY / tier.cellSize);
    const letter = ALPHABET[row * 5 + col];
    if (letter === undefined) {
      throw new TypeError('Координаты не соответствуют сетке адреса.');
    }
    result += letter;
    localX -= col * tier.cellSize;
    localY -= row * tier.cellSize;
  }

  return { sector: SECTOR_CODE, letters: result };
}

const RESERVED_SECTORS: readonly string[] = Object.freeze(['TS', 'UJ', 'CH', 'AY', 'SL', 'SH']);

/** Возвращает левый верхний угол ячейки адреса и её размер (`ADDRESS_TIERS[длина]`). */
export function rectOf(address: SectorAddress | string): { readonly x: number; readonly y: number; readonly size: number } {
  const parsed = typeof address === 'string' ? parseAddress(address) : address;
  if (parsed === null || !isValidFullAddress(parsed)) {
    throw new TypeError('Для прямоугольника требуется полный адрес сектора.');
  }

  let x = 0;
  let y = 0;
  for (let index = 0; index < parsed.letters.length; index += 1) {
    const letter = parsed.letters[index];
    const tier = ADDRESS_TIERS[index + 1];
    if (letter === undefined || tier === undefined) {
      throw new TypeError('Адрес содержит некорректный уровень.');
    }
    const letterIndex = ALPHABET.indexOf(letter);
    const col = letterIndex % 5;
    const row = Math.floor(letterIndex / 5);
    x += col * tier.cellSize;
    y += row * tier.cellSize;
  }

  const sizeTier = ADDRESS_TIERS[parsed.letters.length];
  if (sizeTier === undefined) {
    throw new TypeError('Адрес содержит некорректный уровень.');
  }

  return { x, y, size: sizeTier.cellSize };
}

/** Возвращает центр ячейки адреса: `T5` для пяти букв, `T6`/`T7` для шести и семи (§7.6). */
export function centerOf(address: SectorAddress | string): { readonly x: number; readonly y: number } {
  const rect = rectOf(address);
  return { x: rect.x + rect.size / 2, y: rect.y + rect.size / 2 };
}

/** Разбирает компактную и расширенную запись полного адреса. */
export function parseAddress(text: string): SectorAddress | null {
  const normalized = text.trim().toUpperCase();
  if (normalized.length === 0) {
    return null;
  }

  let sector = SECTOR_CODE;
  let lettersText = normalized;
  const sectorMatch = /^([A-Z]{2})[·\-\s]+(.+)$/.exec(normalized);
  const candidateSector = sectorMatch?.[1];
  const remainder = sectorMatch?.[2];
  if (candidateSector !== undefined && remainder !== undefined) {
    if (candidateSector !== SECTOR_CODE && !RESERVED_SECTORS.includes(candidateSector)) {
      return null;
    }
    sector = candidateSector;
    lettersText = remainder;
  }

  // Канон адреса остаётся пятибуквенным; 6–7 букв принимаем только как
  // глубинную запись сетки и лупы (§7.2, §7.3).
  const letters = lettersText.replace(/[·\-\s]/g, '');
  if (letters.length < 5 || letters.length > 7 || !/^[A-Y]{5,7}$/.test(letters)) {
    return null;
  }
  return { sector, letters };
}

/** Форматирует адрес компактно либо с разделителями между уровнями. */
export function formatAddress(address: SectorAddress, style: 'compact' | 'expanded' = 'compact'): string {
  if (style === 'expanded') {
    return address.letters.length === 0
      ? address.sector
      : `${address.sector}-${Array.from(address.letters).join('-')}`;
  }
  return address.letters.length === 0
    ? address.sector
    : `${address.sector}·${address.letters}`;
}

function isValidFullAddress(address: SectorAddress): boolean {
  return (address.sector === SECTOR_CODE || RESERVED_SECTORS.includes(address.sector))
    && address.letters.length >= 5
    && address.letters.length <= 7
    && /^[A-Y]{5,7}$/.test(address.letters);
}
