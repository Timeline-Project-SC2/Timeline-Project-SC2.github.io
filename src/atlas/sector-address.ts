export type AddressLetters = 0 | 1 | 2 | 3 | 4 | 5;

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
]);

/** Вычисляет канонический адрес точки в поле Копрулу. */
export function addressOf(x: number, y: number): SectorAddress {
  return prefixOf(x, y, 5);
}

/** Возвращает адрес заданного уровня, перенося остаток координат между тирами. */
export function prefixOf(x: number, y: number, letters: AddressLetters): SectorAddress {
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
