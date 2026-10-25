import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const systemFrame = require('../src/atlas/system-frame.ts');
const ladder = require('../src/atlas/level-ladder.ts');

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function readCsv(path) {
  const lines = readFileSync(new URL(path, import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function makeKernel(systems, planets) {
  const systemsById = Object.fromEntries(systems.map((system) => [String(system.id), system]));
  return {
    state: {
      systems,
      systemsById,
      planets,
    },
  };
}

const systemsCsv = readCsv('../data/systems.csv');
const placesCsv = readCsv('../data/places.csv');
const dataSystems = systemsCsv.map((row) => ({ id: row.system_id, name: row.name }));
const dataPlaces = placesCsv.map((row) => ({
  id: row.ID,
  name: row.name,
  type: row.type,
  systemId: row.system_id || null,
}));
const dataKernel = makeKernel(dataSystems, dataPlaces);

const near = (actual, expected, tolerance = 1e-12) => Math.abs(actual - expected) <= tolerance;

function checkSystemFramePart1() {
  // уровни системного кадра берутся как S0…S2 на позициях 13…15 в LEVELS
  assert.equal(ladder.LEVELS.length, 16);
  assert.deepEqual(
    [13, 14, 15].map((level) => ladder.LEVELS[level].id),
    ['S0', 'S1', 'S2'],
  );
  const api = systemFrame.createSystemFrame(dataKernel);
  assert.deepEqual(
    [13, 14, 15].map((level) => api.openSystem('1', level).levelId),
    ['S0', 'S1', 'S2'],
  );
  assert.throws(() => api.openSystem('1', 12), RangeError);
}

function checkSystemFramePart2() {
  // лог-шкала строго монотонна, а внешняя заявленная орбита занимает 0,42 ширины
  const outerAu = 4;
  const widthAu = 100;
  const A = systemFrame.calibrateOrbitScale(outerAu, widthAu);
  const radiiAu = [0.01, 0.1, 0.4, 1, outerAu];
  const screenRadii = radiiAu.map((radius) => systemFrame.orbitScreenRadius(radius, A));

  for (let index = 1; index < screenRadii.length; index += 1) {
    assert.ok(screenRadii[index - 1] < screenRadii[index]);
  }
  assert.ok(near(screenRadii.at(-1) / widthAu, 0.42));

  const fixtureKernel = makeKernel(
    [{ id: 'orbit-system', name: 'Тестовая система' }],
    [
      { id: 'inner', name: 'Внутреннее тело', type: 'planet', systemId: 'orbit-system', orbit_au: 0.4 },
      { id: 'outer', name: 'Внешнее тело', type: 'planet', systemId: 'orbit-system', orbit_au: outerAu },
    ],
  );
  const frame = systemFrame.createSystemFrame(fixtureKernel).openSystem('orbit-system', 13);
  const outerOrbit = frame.orbits.find((orbit) => orbit.bodyId === 'outer');

  assert.equal(frame.orbitScale.A, A);
  assert.equal(frame.orbitScale.mode, 'declared-au');
  assert.ok(outerOrbit);
  assert.ok(near(outerOrbit.rScreenAu, A * Math.log1p(outerAu / 0.4)));
  assert.ok(near(outerOrbit.rScreenFraction, 0.42));
}

function checkSystemFramePart3() {
  // реальные places.csv дают 4 планеты, 1 луну и 2 места без типа
  assert.equal(placesCsv.length, 7);
  const api = systemFrame.createSystemFrame(dataKernel);
  const allBodies = dataSystems.flatMap((system) => api.openSystem(system.id, 13).bodies);
  const counts = allBodies.reduce((result, body) => {
    result[body.kind] = (result[body.kind] || 0) + 1;
    return result;
  }, {});

  assert.equal(counts.planet, 4);
  assert.equal(counts.moon, 1);
  assert.equal(counts.unknown, 2);
  assert.equal(allBodies.length, 7);
}

function checkSystemFramePart4() {
  // Korhal строится по объявленной строке, а для Mistaff пустое состояние честное
  const api = systemFrame.createSystemFrame(dataKernel);
  const korhalSystem = dataSystems.find((system) => system.name === 'Корхал');
  const mistaffSystem = dataSystems.find((system) => system.name === 'Мистафф');
  assert.ok(korhalSystem);
  assert.ok(mistaffSystem);

  const korhal = api.openSystem(korhalSystem.id, 13);
  assert.equal(korhal.systemName, 'Корхал');
  assert.equal(korhal.levelId, 'S0');
  assert.equal(korhal.isEmpty, false);
  assert.deepEqual(korhal.bodies.map((body) => body.name), ['Корхал IV']);
  assert.equal(korhal.orbitScale.mode, 'uniform-log-slots');
  assert.equal(korhal.orbitScale.A, null);
  assert.equal(korhal.orbits[0].orbitAu, null);
  assert.ok(near(korhal.orbits[0].rScreenFraction, 0.42));

  const mistaff = api.openSystem(mistaffSystem.id, 13);
  assert.equal(mistaff.isEmpty, true);
  assert.equal(mistaff.flags.isEmpty, true);
  assert.equal(mistaff.flags.hasDeclaredBodies, false);
  assert.equal(mistaff.statuses.contents, 'empty');
  assert.equal(mistaff.emptyState.visible, true);
  assert.equal(mistaff.emptyState.message, 'Тела не занесены. Данные добавляются в таблице places');
  assert.equal(mistaff.emptyState.action.label, 'Открыть таблицу');
  assert.match(mistaff.emptyState.action.href, /pubhtml\?gid=1415856610/);
  assert.equal(mistaff.bodies.length, 0);
  assert.equal(mistaff.orbits.length, 0);
  assert.ok(mistaff.waitingShelf.slots.length >= 2);
  assert.ok(mistaff.waitingShelf.slots.every((slot) => slot.status === 'empty' && slot.placeId === null));
  assert.doesNotThrow(() => api.close());
}

function checkSystemFramePart5() {
  // размеры тел зажаты в S0 и S2, звезда и условные статусы присутствуют
  const api = systemFrame.createSystemFrame(dataKernel);
  const korhalSystem = dataSystems.find((system) => system.name === 'Корхал');
  assert.ok(korhalSystem);

  const s0 = api.openSystem(korhalSystem.id, 13);
  assert.ok(s0.bodies.every((body) => body.diameterPx >= 18 && body.diameterPx <= 28));
  assert.ok(s0.bodies.every((body) => body.rawDiameterPx < 1));
  assert.equal(s0.bodies[0].rawDiameterPx, 0.04);

  const s2 = api.openSystem(korhalSystem.id, 15);
  assert.ok(s2.bodies.every((body) => body.diameterPx >= 200));
  assert.equal(s2.bodies[0].diameterPx, 260);
  assert.equal(s2.bodies[0].planetAction.label, 'К планете');
  assert.equal(s2.bodies[0].planetAction.href, '/planet-globe/?place=2&system=1');
  assert.equal(s2.bodies[0].planetAction.target, '_self');

  assert.equal(s0.star.slot, 'S');
  assert.equal(s0.star.spectralClass, null);
  assert.equal(s0.star.spectralClassLabel, 'класс не заявлен');
  assert.ok(s0.star.fractionalRim.coverageFraction > 0 && s0.star.fractionalRim.coverageFraction < 1);
  assert.ok(s0.star.coronaLayers.length <= 3);
  assert.equal(s0.notices.diagram, 'схема условна, порядок тел не зафиксирован');
  assert.equal(s0.statuses.diagram, 'conditional');
  assert.equal(s0.statuses.stellarClass, 'unclaimed');
}

function checkSystemFramePart6() {
  // порядок тел: orbital_index, затем строка places.csv, затем алфавит
  const fixtureKernel = makeKernel(
    [{ id: 'ordered', name: 'Система порядка' }],
    [
      { id: 'row-1', name: 'Янтарь', type: 'planet', systemId: 'ordered', orbital_index: '2', csvRowIndex: 8 },
      { id: 'row-2', name: 'Вега', type: 'planet', systemId: 'ordered', orbital_index: '1', csvRowIndex: 9 },
      { id: 'row-3', name: 'Зета', type: 'planet', systemId: 'ordered', csvRowIndex: 4 },
      { id: 'row-4', name: 'Альфа', type: 'planet', systemId: 'ordered', csvRowIndex: 5 },
    ],
  );
  const ordered = systemFrame.createSystemFrame(fixtureKernel).openSystem('ordered', 13);
  assert.deepEqual(ordered.bodies.map((body) => body.name), ['Вега', 'Янтарь', 'Зета', 'Альфа']);
  assert.deepEqual(ordered.bodies.map((body) => body.orbitalIndex), [1, 2, null, null]);

  const tieKernel = makeKernel(
    [{ id: 'tie', name: 'Система равных ключей' }],
    [
      { id: 'z', name: 'Зета', type: 'planet', systemId: 'tie', orbital_index: 1, csvRowIndex: 3 },
      { id: 'a', name: 'Альфа', type: 'planet', systemId: 'tie', orbital_index: 1, csvRowIndex: 3 },
    ],
  );
  const tied = systemFrame.createSystemFrame(tieKernel).openSystem('tie', 13);
  assert.deepEqual(tied.bodies.map((body) => body.name), ['Альфа', 'Зета']);
}

function checkSystemFramePart7() {
  // модуль остаётся вычислительным: в исходнике нет DOM, случайности или часов
  const source = readFileSync(new URL('../src/atlas/system-frame.ts', import.meta.url), 'utf8');
  for (const forbidden of [
    /\b(?:document|window|HTMLElement|HTMLCanvasElement|CanvasRenderingContext2D|requestAnimationFrame)\b/,
    /\bMath\s*\.\s*random\s*\(/,
    /\bDate\s*\.\s*now\s*\(/,
    /\bperformance\s*\.\s*now\s*\(/,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
}

test('ядро SW-5 системного кадра: уровни, орбиты, тела, пустое состояние и чистая модель', () => {
  checkSystemFramePart1();
  checkSystemFramePart2();
  checkSystemFramePart3();
  checkSystemFramePart4();
  checkSystemFramePart5();
  checkSystemFramePart6();
  checkSystemFramePart7();
});
