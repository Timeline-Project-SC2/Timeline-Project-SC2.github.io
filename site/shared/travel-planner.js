/* global module */
/* Pure travel-planner calculations. No DOM, map canvas, or storage dependencies. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TravelPlanner = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // User-agreed project convention, not an independent astronomical calibration.
  // One world-coordinate map unit equals one light-year; calculations remain strictly 2D.
  var LIGHT_YEARS_PER_MAP_UNIT = 1;
  var HOURS_PER_DAY = 24;

  function parseSpeed(value) {
    var text = value == null ? '' : String(value);
    text = text.replace(/\s+/g, '').replace(/,/g, '.');
    if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    var number = Number(text);
    return isFinite(number) && number > 0 ? number : null;
  }

  function formatNumber(value, significantDigits) {
    if (!isFinite(value)) return '—';
    if (value === 0) return '0';
    var digits = significantDigits || 3;
    return String(Number(Number(value).toPrecision(digits)));
  }

  function formatExactNumber(value) {
    return isFinite(value) ? String(Number(value)) : '—';
  }

  function roundMapCoordinates(point) {
    return [Math.round(Number(point[0])), Math.round(Number(point[1]))];
  }

  function formatTimestamp(date) {
    if (!(date instanceof Date) || !isFinite(date.getTime())) return '';
    function pad(value) { return value < 10 ? '0' + value : String(value); }
    var offset = -date.getTimezoneOffset();
    var sign = offset >= 0 ? '+' : '-';
    var absoluteOffset = Math.abs(offset);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
      ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
      ' UTC' + sign + pad(Math.floor(absoluteOffset / 60)) + ':' + pad(absoluteOffset % 60);
  }

  function legBetween(from, to, speedLyPerDay) {
    var dx = Number(to.coord[0]) - Number(from.coord[0]);
    var dy = Number(to.coord[1]) - Number(from.coord[1]);
    var distance = Math.sqrt(dx * dx + dy * dy) * LIGHT_YEARS_PER_MAP_UNIT;
    return {
      from: from,
      to: to,
      distanceLy: distance,
      hours: distance * HOURS_PER_DAY / speedLyPerDay
    };
  }

  function calculate(stops, speedLyPerDay, includeReturn) {
    var forwardLegs = [];
    for (var i = 1; i < stops.length; i++) {
      forwardLegs.push(legBetween(stops[i - 1], stops[i], speedLyPerDay));
    }
    var returnLegs = [];
    if (stops.length > 1) {
      for (var j = stops.length - 1; j > 0; j--) {
        returnLegs.push(legBetween(stops[j], stops[j - 1], speedLyPerDay));
      }
    }
    var routeLegs = forwardLegs.concat(includeReturn ? returnLegs : []);
    var outboundDistance = forwardLegs.reduce(function (sum, leg) { return sum + leg.distanceLy; }, 0);
    var outboundHours = forwardLegs.reduce(function (sum, leg) { return sum + leg.hours; }, 0);
    var returnDistance = returnLegs.reduce(function (sum, leg) { return sum + leg.distanceLy; }, 0);
    var returnHours = returnLegs.reduce(function (sum, leg) { return sum + leg.hours; }, 0);
    return {
      forwardLegs: forwardLegs,
      returnLegs: returnLegs,
      legs: routeLegs,
      outboundDistance: outboundDistance,
      outboundHours: outboundHours,
      returnDistance: returnDistance,
      returnHours: returnHours,
      totalDistance: outboundDistance + (includeReturn ? returnDistance : 0),
      totalHours: outboundHours + (includeReturn ? returnHours : 0),
      roundTripDistance: outboundDistance + returnDistance,
      roundTripHours: outboundHours + returnHours
    };
  }

  function buildLog(stops, calculation, speedLyPerDay, includeReturn, departureValue) {
    var path = stops.map(function (stop) { return stop.name; });
    if (includeReturn && stops.length > 1) {
      for (var i = stops.length - 2; i >= 0; i--) path.push(stops[i].name);
    }
    var lines = [
      'МАРШРУТ: ' + path.join(' → '),
      'Скорость: ' + formatExactNumber(speedLyPerDay) + ' св.л./сутки'
    ];
    var departMs = departureValue ? new Date(departureValue).getTime() : NaN;
    var hasDeparture = isFinite(departMs);

    calculation.legs.forEach(function (leg, index) {
      lines.push('');
      lines.push((index + 1) + '. ' + leg.from.name + ' → ' + leg.to.name);
      lines.push('   Координаты: (' + formatExactNumber(leg.from.coord[0]) + ', ' +
        formatExactNumber(leg.from.coord[1]) + ') → (' + formatExactNumber(leg.to.coord[0]) + ', ' +
        formatExactNumber(leg.to.coord[1]) + ')');
      lines.push('   Расстояние: ' + formatNumber(leg.distanceLy) + ' св.л.');
      lines.push('   Время: ' + formatNumber(leg.hours) + ' ч');
      if (hasDeparture) {
        var legStart = new Date(departMs);
        departMs += leg.hours * 60 * 60 * 1000;
        var legEnd = new Date(departMs);
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

  return {
    LIGHT_YEARS_PER_MAP_UNIT: LIGHT_YEARS_PER_MAP_UNIT,
    HOURS_PER_DAY: HOURS_PER_DAY,
    parseSpeed: parseSpeed,
    formatNumber: formatNumber,
    formatExactNumber: formatExactNumber,
    roundMapCoordinates: roundMapCoordinates,
    formatTimestamp: formatTimestamp,
    calculate: calculate,
    buildLog: buildLog
  };
}));
