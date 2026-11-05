/* Пограничный мир — уровень систем, а не область действия (часть 3 §6 плана).
 *
 * Это формальное именование при достижении определённого расстояния от
 * «центральных» систем. Полосы — интервалы расстояния, их число, пороги и
 * названия — глобальная настройка редактора: изменение не требует кода.
 * Кисть может использовать полосу как детализацию области, но сам пограничный
 * мир не является scope и не ограничивает геометрию.
 *
 * Первый тест: центральная — Корхал (`system_id: 1`, `5720, 6257`),
 * пограничная — Коло (`system_id: 9`, `6180, 6739`); расстояние между ними
 * `≈ 666,3` мировых единиц (св.г.).
 */

export interface CentralSystem {
  readonly key: string;
  readonly systemId: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface BorderBand {
  readonly id: string;
  readonly label: string;
  /** Начало интервала расстояния, включительно. */
  readonly from: number;
  /** Конец интервала, исключая; `Infinity` — последняя полоса. */
  readonly to: number;
}

export interface BorderWorld {
  readonly id: string;
  readonly centralSystems: readonly CentralSystem[];
  readonly bands: readonly BorderBand[];
}

export interface BorderWorldInput {
  readonly id?: string;
  readonly centralSystems: readonly CentralSystem[];
  readonly bands?: readonly BorderBand[];
}

/** Четыре полосы первого теста: Коло (`≈ 666`) попадает в `border`. */
export const DEFAULT_BANDS: readonly BorderBand[] = Object.freeze([
  Object.freeze({ id: 'core', label: 'Ядро', from: 0, to: 200 }),
  Object.freeze({ id: 'inner', label: 'Внутренний пояс', from: 200, to: 450 }),
  Object.freeze({ id: 'border', label: 'Пограничье', from: 450, to: 700 }),
  Object.freeze({ id: 'outside', label: 'Вне полос', from: 700, to: Infinity }),
]);

export const CENTRAL_SYSTEM_KORHAL: CentralSystem = Object.freeze({
  key: '1',
  systemId: 1,
  name: 'Корхал',
  x: 5720,
  y: 6257,
});

export const BORDER_SYSTEM_KOLO: CentralSystem = Object.freeze({
  key: '9',
  systemId: 9,
  name: 'Коло',
  x: 6180,
  y: 6739,
});

export function createBorderWorld(input: BorderWorldInput): BorderWorld {
  const bands = input.bands ?? DEFAULT_BANDS;
  const errors = validateBands(bands);
  if (errors.length > 0) throw new RangeError(`Некорректные полосы пограничного мира: ${errors.join(' ')}`);
  if (input.centralSystems.length === 0) {
    throw new RangeError('Пограничный мир требует хотя бы одну центральную систему.');
  }
  return { id: input.id ?? 'border-world', centralSystems: input.centralSystems, bands };
}

/** Полосы должны быть упорядочены и не пересекаться; разрывы допустимы. */
export function validateBands(bands: readonly BorderBand[]): readonly string[] {
  const errors: string[] = [];
  if (bands.length === 0) errors.push('Нужна хотя бы одна полоса.');
  let previousTo = -Infinity;
  bands.forEach((band, index) => {
    if (!Number.isFinite(band.from) || band.from < 0) errors.push(`Полоса ${band.id}: начало должно быть неотрицательным числом.`);
    if (band.to <= band.from) errors.push(`Полоса ${band.id}: конец должен быть больше начала.`);
    if (band.from < previousTo - 1e-9) errors.push(`Полоса ${band.id} (индекс ${index}) пересекается с предыдущей.`);
    previousTo = band.to;
  });
  return errors;
}

export function setBands(world: BorderWorld, bands: readonly BorderBand[]): BorderWorld {
  return createBorderWorld({ id: world.id, centralSystems: world.centralSystems, bands });
}

export function bandIds(world: BorderWorld): readonly string[] {
  return world.bands.map((band) => band.id);
}

/** Расстояние до ближайшей центральной системы: `min_i dist(p, c_i)`. */
export function distanceToCentral(world: BorderWorld, x: number, y: number): number {
  let min = Infinity;
  for (const system of world.centralSystems) {
    min = Math.min(min, Math.hypot(x - system.x, y - system.y));
  }
  return min;
}

/** Полоса точки; `null` — точка попала в разрыв между полосами. */
export function bandAt(world: BorderWorld, x: number, y: number): BorderBand | null {
  const distance = distanceToCentral(world, x, y);
  for (const band of world.bands) {
    if (distance >= band.from && distance < band.to) return band;
  }
  return null;
}

export function bandIdAt(world: BorderWorld, x: number, y: number): string | null {
  return bandAt(world, x, y)?.id ?? null;
}

export interface SystemRow {
  readonly systemId: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** Минимальный разбор `data/systems.csv` (колонки `name,system_id,type,x,y`). */
export function parseSystemsCsv(csv: string): readonly SystemRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];
  const header = lines[0]!.split(',').map((cell) => cell.trim());
  const nameIndex = header.indexOf('name');
  const idIndex = header.indexOf('system_id');
  const xIndex = header.indexOf('x');
  const yIndex = header.indexOf('y');
  if (idIndex < 0 || xIndex < 0 || yIndex < 0) return [];

  const rows: SystemRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const systemId = Number(cells[idIndex] ?? '');
    const x = Number(cells[xIndex] ?? '');
    const y = Number(cells[yIndex] ?? '');
    if (!Number.isFinite(systemId) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    rows.push({ systemId, name: (cells[nameIndex] ?? '').trim(), x, y });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

/** Собирает пограничный мир из строк систем по идентификаторам центральных. */
export function borderWorldFromSystems(
  rows: readonly SystemRow[],
  centralSystemIds: readonly number[],
  bands: readonly BorderBand[] = DEFAULT_BANDS,
  id = 'border-world',
): BorderWorld {
  const central = rows
    .filter((row) => centralSystemIds.includes(row.systemId))
    .map((row) => ({
      key: String(row.systemId),
      systemId: row.systemId,
      name: row.name,
      x: row.x,
      y: row.y,
    }));
  return createBorderWorld({ id, centralSystems: central, bands });
}
