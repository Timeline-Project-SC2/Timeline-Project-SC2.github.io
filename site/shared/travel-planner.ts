/* Чистые расчёты планировщика маршрутов без DOM, canvas и хранилища.
   CR-01 PR 3: строгий TypeScript/ESM вместо UMD; формулы и форматирование
   сохранены 1-в-1, браузерный глобал по-прежнему window.TravelPlanner. */

export interface TravelStop {
  readonly id?: string;
  readonly name: string;
  readonly coord: readonly number[];
}

export interface TravelLeg {
  readonly from: TravelStop;
  readonly to: TravelStop;
  readonly distanceLy: number;
  readonly hours: number;
}

export interface TravelCalculation {
  readonly forwardLegs: TravelLeg[];
  readonly returnLegs: TravelLeg[];
  readonly legs: TravelLeg[];
  readonly outboundDistance: number;
  readonly outboundHours: number;
  readonly returnDistance: number;
  readonly returnHours: number;
  readonly totalDistance: number;
  readonly totalHours: number;
  readonly roundTripDistance: number;
  readonly roundTripHours: number;
}

export interface ParsedMapCoordinateQuery {
  readonly x: number;
  readonly y: number;
  readonly xText: string;
  readonly yText: string;
}

// User-agreed project convention, not an independent astronomical calibration.
// One world-coordinate map unit equals one light-year; calculations remain strictly 2D.
export const LIGHT_YEARS_PER_MAP_UNIT = 1;
export const HOURS_PER_DAY = 24;

export function parseSpeed(value: unknown): number | null {
  let text = value == null ? '' : String(value);
  text = text.replace(/\s+/g, '').replace(/,/g, '.');
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function parseMapCoordinateQuery(
  value: unknown,
  mapLimit?: unknown,
): ParsedMapCoordinateQuery | null {
  const text = value == null ? '' : String(value).trim();
  let match = text.match(/^(\d{4})(\d{4})$/);
  if (!match) match = text.match(/^(\d{1,5})\s+(\d{1,5})$/);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  const limit = mapLimit == null ? 10000 : Number(mapLimit);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(limit) || limit < 0 || x > limit || y > limit) return null;
  return { x, y, xText: match[1] ?? '', yText: match[2] ?? '' };
}

export function formatNumber(value: number, significantDigits?: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const digits = significantDigits || 3;
  return String(Number(Number(value).toPrecision(digits)));
}

export function formatExactNumber(value: unknown): string {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '—';
}

export function roundMapCoordinates(point: readonly unknown[]): [number, number] {
  return [Math.round(Number(point[0])), Math.round(Number(point[1]))];
}

export function formatTimestamp(date: unknown): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  function pad(value: number): string { return value < 10 ? '0' + value : String(value); }
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offset);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
    ' UTC' + sign + pad(Math.floor(absoluteOffset / 60)) + ':' + pad(absoluteOffset % 60);
}

function legBetween(from: TravelStop, to: TravelStop, speedLyPerDay: number): TravelLeg {
  const dx = Number(to.coord[0]) - Number(from.coord[0]);
  const dy = Number(to.coord[1]) - Number(from.coord[1]);
  const distance = Math.sqrt(dx * dx + dy * dy) * LIGHT_YEARS_PER_MAP_UNIT;
  return {
    from,
    to,
    distanceLy: distance,
    hours: distance * HOURS_PER_DAY / speedLyPerDay,
  };
}

export function calculate(
  stops: readonly TravelStop[],
  speedLyPerDay: number,
  includeReturn: boolean,
): TravelCalculation {
  const forwardLegs: TravelLeg[] = [];
  for (let i = 1; i < stops.length; i++) {
    forwardLegs.push(legBetween(stops[i - 1]!, stops[i]!, speedLyPerDay));
  }
  const returnLegs: TravelLeg[] = [];
  if (stops.length > 1) {
    for (let j = stops.length - 1; j > 0; j--) {
      returnLegs.push(legBetween(stops[j]!, stops[j - 1]!, speedLyPerDay));
    }
  }
  const routeLegs = forwardLegs.concat(includeReturn ? returnLegs : []);
  const outboundDistance = forwardLegs.reduce((sum, leg) => sum + leg.distanceLy, 0);
  const outboundHours = forwardLegs.reduce((sum, leg) => sum + leg.hours, 0);
  const returnDistance = returnLegs.reduce((sum, leg) => sum + leg.distanceLy, 0);
  const returnHours = returnLegs.reduce((sum, leg) => sum + leg.hours, 0);
  return {
    forwardLegs,
    returnLegs,
    legs: routeLegs,
    outboundDistance,
    outboundHours,
    returnDistance,
    returnHours,
    totalDistance: outboundDistance + (includeReturn ? returnDistance : 0),
    totalHours: outboundHours + (includeReturn ? returnHours : 0),
    roundTripDistance: outboundDistance + returnDistance,
    roundTripHours: outboundHours + returnHours,
  };
}

export function buildLog(
  stops: readonly TravelStop[],
  calculation: TravelCalculation,
  speedLyPerDay: number,
  includeReturn: boolean,
  departureValue: unknown,
): string {
  const path = stops.map((stop) => stop.name);
  if (includeReturn && stops.length > 1) {
    for (let i = stops.length - 2; i >= 0; i--) path.push(stops[i]!.name);
  }
  const lines = [
    'МАРШРУТ: ' + path.join(' → '),
    'Скорость: ' + formatExactNumber(speedLyPerDay) + ' св.л./сутки',
  ];
  let departMs = departureValue ? new Date(departureValue as string).getTime() : NaN;
  const hasDeparture = Number.isFinite(departMs);

  calculation.legs.forEach((leg, index) => {
    lines.push('');
    lines.push((index + 1) + '. ' + leg.from.name + ' → ' + leg.to.name);
    lines.push('   Координаты: (' + formatExactNumber(leg.from.coord[0]) + ', ' +
      formatExactNumber(leg.from.coord[1]) + ') → (' + formatExactNumber(leg.to.coord[0]) + ', ' +
      formatExactNumber(leg.to.coord[1]) + ')');
    lines.push('   Расстояние: ' + formatNumber(leg.distanceLy) + ' св.л.');
    lines.push('   Время: ' + formatNumber(leg.hours) + ' ч');
    if (hasDeparture) {
      const legStart = new Date(departMs);
      departMs += leg.hours * 60 * 60 * 1000;
      const legEnd = new Date(departMs);
      lines.push('   Отправление: ' + formatTimestamp(legStart));
      lines.push('   Прибытие: ' + formatTimestamp(legEnd));
    }
  });

  lines.push('');
  lines.push('Итого: ' + formatNumber(calculation.outboundDistance) + ' св.л. | ' +
    formatNumber(calculation.outboundHours) + ' ч');
  lines.push('С возвратом: ' + formatNumber(calculation.roundTripDistance) + ' св.л. | ' +
    formatNumber(calculation.roundTripHours) + ' ч' +
    (includeReturn ? '' : ' (если включить возврат по тому же пути)'));
  return lines.join('\n');
}

export const TravelPlanner = {
  LIGHT_YEARS_PER_MAP_UNIT,
  HOURS_PER_DAY,
  parseSpeed,
  parseMapCoordinateQuery,
  formatNumber,
  formatExactNumber,
  roundMapCoordinates,
  formatTimestamp,
  calculate,
  buildLog,
};

export type TravelPlannerApi = typeof TravelPlanner;

declare global {
  interface Window {
    TravelPlanner: TravelPlannerApi;
  }
}

(globalThis as typeof globalThis & { TravelPlanner: TravelPlannerApi }).TravelPlanner = TravelPlanner;

export default TravelPlanner;
