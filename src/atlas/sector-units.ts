export const NBSP = '\u00A0';
export const UNITS_PER_LY = 1000;

export type DistanceMode = 'full' | 'short' | 'label';

export function formatDistanceLy(ly: number, mode: DistanceMode = 'short'): string {
  if (Number.isNaN(ly) || ly < 0) {
    throw new RangeError('Расстояние не может быть отрицательным или неопределённым');
  }
  if (ly >= 10000) {
    return `≥ 10${NBSP}000${NBSP}св.г.`;
  }
  if (mode !== 'short' && mode !== 'full' && mode !== 'label') {
    throw new RangeError(`Неизвестный режим форматирования расстояния: ${mode}`);
  }

  if (mode === 'label') {
    if (ly < 1) {
      const rounded = ly.toFixed(3);
      return formatLabelValue(rounded);
    }
    if (ly < 100) {
      const rounded = ly.toFixed(1);
      return formatLabelValue(rounded);
    }
    const rounded = Math.round(ly).toString();
    const groupedInteger = rounded.replace(/\B(?=(\d{3})+(?!\\d))/g, NBSP);
    return `${groupedInteger}${NBSP}св.г.`;
  }

<<<<<<< HEAD
  const decimals = mode === 'full' ? 2 : 1;
=======
  const decimals = mode === 'short' ? 1 : 2;
>>>>>>> 20716f2 (wip(Z-4): единицы 1000 ед = 1 св.г.)
  const rounded = ly.toFixed(decimals);
  const decimalIndex = rounded.indexOf('.');
  const integerPart = rounded.slice(0, decimalIndex);
  const fractionalPart = rounded.slice(decimalIndex + 1);
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\\d))/g, NBSP);

  return `${groupedInteger},${fractionalPart}${NBSP}св.г.`;
}

function formatLabelValue(rounded: string): string {
  const decimalIndex = rounded.indexOf('.');
  const integerPart = rounded.slice(0, decimalIndex);
  const fractionalPart = rounded.slice(decimalIndex + 1);
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\\d))/g, NBSP);
  return `${groupedInteger},${fractionalPart}${NBSP}св.г.`;
}

export function unitsToLy(units: number): number {
  if (Number.isNaN(units) || units < 0) {
    throw new RangeError('Расстояние не может быть отрицательным или неопределённым');
  }
  return units / UNITS_PER_LY;
}

export function lyToUnits(ly: number): number {
  if (Number.isNaN(ly) || ly < 0) {
    throw new RangeError('Расстояние не может быть отрицательным или неопределённым');
  }
  return ly * UNITS_PER_LY;
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

  const degrees = normalized * 180 / Math.PI;
  const nearestInteger = Math.round(degrees);
  if (Math.abs(degrees - nearestInteger) <= 1e-10) {
    if (nearestInteger === 0) {
      return '0°';
    }

    const sign = nearestInteger < 0 ? '−' : '';
    return `${sign}${Math.abs(nearestInteger)}°`;
  }

  const degreeText = Math.abs(degrees).toFixed(1).replace('.', ',');
  const sign = degrees < 0 ? '−' : '';
  return `${sign}${degreeText}°`;
}
