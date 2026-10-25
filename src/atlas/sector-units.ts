export const NBSP = '\u00A0';

export type DistanceMode = 'full' | 'short';

export function formatDistanceLy(ly: number, mode: DistanceMode = 'short'): string {
  if (Number.isNaN(ly) || ly < 0) {
    throw new RangeError('Расстояние не может быть отрицательным или неопределённым');
  }
  if (ly >= 10000) {
    return `≥ 10${NBSP}000${NBSP}св.г.`;
  }
  if (mode !== 'short' && mode !== 'full') {
    throw new RangeError(`Неизвестный режим форматирования расстояния: ${mode}`);
  }

  const decimals = mode === 'short' ? 1 : 2;
  const rounded = ly.toFixed(decimals);
  const decimalIndex = rounded.indexOf('.');
  const integerPart = rounded.slice(0, decimalIndex);
  const fractionalPart = rounded.slice(decimalIndex + 1);
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);

  return `${groupedInteger},${fractionalPart}${NBSP}св.г.`;
}

export function pluralYears(n: number): 'год' | 'года' | 'лет' {
  if (!Number.isInteger(n)) {
    return 'лет';
  }

  const absolute = Math.abs(n);
  const lastTwoDigits = absolute % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return 'лет';
  }

  const lastDigit = absolute % 10;
  if (lastDigit === 1) {
    return 'год';
  }
  if (lastDigit >= 2 && lastDigit <= 4) {
    return 'года';
  }
  return 'лет';
}

export function formatAngleDeg(rad: number): string {
  if (!Number.isFinite(rad)) {
    throw new RangeError('Угол должен быть конечным числом');
  }

  const fullTurn = 2 * Math.PI;
  let normalized = ((rad % fullTurn) + fullTurn) % fullTurn;
  if (normalized > Math.PI) {
    normalized -= fullTurn;
  }

  const roundedDegrees = Math.round((normalized * 180 / Math.PI) * 10) / 10;
  if (roundedDegrees === 0) {
    return '0°';
  }

  const absoluteDegrees = Math.abs(roundedDegrees);
  const degreeText = Number.isInteger(absoluteDegrees)
    ? String(absoluteDegrees)
    : absoluteDegrees.toFixed(1).replace('.', ',');
  const sign = roundedDegrees < 0 ? '−' : '';
  return `${sign}${degreeText}°`;
}
