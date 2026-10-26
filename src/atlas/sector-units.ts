export const NBSP = '\u00A0';

/** Единица длины карты: `1` единица = `1` световой год. */
export const UNITS_PER_LY = 1;

/** Предел приближения: световых лет на CSS-пиксель. */
export const TARGET_LY_PER_PX = 0.002;

export type DistanceMode = 'full' | 'short' | 'label';

function validateDistance(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('Расстояние не может быть отрицательным или неопределённым');
  }
}

/** Переводит единицы карты в световые годы (`u / UNITS_PER_LY`). */
export function unitsToLy(u: number): number {
  validateDistance(u);
  return u / UNITS_PER_LY;
}

/** Переводит световые годы в единицы карты (`ly * UNITS_PER_LY`). */
export function lyToUnits(ly: number): number {
  validateDistance(ly);
  return ly * UNITS_PER_LY;
}

export function formatDistanceLy(ly: number, mode: DistanceMode = 'short'): string {
  validateDistance(ly);
  if (mode !== 'short' && mode !== 'full' && mode !== 'label') {
    throw new RangeError(`Неизвестный режим форматирования расстояния: ${mode}`);
  }
  if (ly >= 10000) {
    return `≥ 10${NBSP}000${NBSP}св.г.`;
  }
  if (mode === 'label' && ly >= 100) {
    const groupedInteger = Math.round(ly).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    return `${groupedInteger}${NBSP}св.г.`;
  }

  const decimals = mode === 'full' ? 2 : (mode === 'label' && ly < 1 ? 3 : 1);
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
