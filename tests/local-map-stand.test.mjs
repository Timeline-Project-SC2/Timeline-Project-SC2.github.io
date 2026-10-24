/* Тест измерительного стенда локальной карты (Stage-8.12d, шаг 1).
   ---------------------------------------------------------------------------
   Стенд — инструмент измерения, а не тест дефектов. Тест проверяет
   ВЫЧИСЛИМОСТЬ метрик (числа конечные, в разумных пределах) и структуру
   отчёта, а НЕ прохождение порогов: пока пороги красные, CI не должен
   краснеть из-за текущего состояния карты.

   Когда починка закроет дефекты и пороги станут зелёными, тест останется
   зелёным: он не завязан на значения метрик, а только на их конечность,
   диапазон и согласованность отчёта с режимами CLI.

   Запуск: node --test tests/local-map-stand.test.mjs
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(new URL('../tools/stand_local_map.mjs', import.meta.url));

/** Публичный API стенда: тест меряет тем же кодом, что и CLI. */
const stand = await import(TOOL_PATH);

/** Разумные пределы значений метрик (на порядки больше ожидаемых величин). */
const VALUE_LIMITS = {
  'ступень кромки русла': 1000,
  'глубина воды в центре русла': 20000,
  // Створов не больше, чем граней у гекса.
  'непрерывность русла через грань': 6,
  'фактура рельефа (RMS колец)': 100,
  'перепад вершин на суше': 1000,
  'перепад waterDepthM патч/юбка': 1000,
  'доля площади гекса под врезом': 100,
};

const report = await stand.runStand({ world: 'a29', radiusM: 2500 });

test('стенд: конфигурация измерений зафиксирована владельцем', () => {
  assert.deepEqual(
    stand.CONTROL_CELLS,
    [37488, 37518, 37548, 37519, 137363, 137390, 137436],
    'список контрольных ячеек не меняется',
  );
  assert.equal(stand.THRESHOLDS.bankStepM, 2, 'ступень кромки русла ≤ 2 м (только область вреза)');
  assert.equal(stand.THRESHOLDS.riverDepthM, 3, 'глубина воды в центре русла: минимум диапазона 3 м');
  assert.equal(stand.THRESHOLDS.riverDepthMaxM, 12, 'глубина воды в центре русла: потолок диапазона 12 м');
  assert.equal(stand.THRESHOLDS.continuityFraction, 1, 'непрерывность: 100 % фактических створов');
  assert.equal(stand.THRESHOLDS.textureRatioMin, 0.7, 'коридор фактуры: 0,7…');
  assert.equal(stand.THRESHOLDS.textureRatioMax, 1.3, 'коридор фактуры: …1,3');
  assert.equal(stand.THRESHOLDS.landStepM, 6, 'перепад вершин на суше ≤ 6 м');
  assert.equal(stand.THRESHOLDS.waterDepthDeltaM, 0.5, 'перепад waterDepthM ≤ 0,5 м');
  assert.equal(stand.THRESHOLDS.carveAreaMaxPct, 12, 'доля площади гекса под врезом ≤ 12 %');
  assert.equal(stand.CARVE_AREA_GRID, 44, 'метрика 7: сетка 44×44');
  assert.equal(stand.CARVE_AREA_RADIUS_RATIO, 0.95, 'метрика 7: радиус 0,95·R');
});

test('стенд: таблица покрывает все 7 контрольных ячеек и все 7 метрик', () => {
  assert.equal(report.rows.length, stand.CONTROL_CELLS.length * 7);
  const metrics = new Set();
  for (const cell of stand.CONTROL_CELLS) {
    const rows = report.rows.filter((row) => row.cell === cell);
    assert.equal(rows.length, 7, `у ячейки ${cell} ровно 7 метрик`);
    assert.equal(new Set(rows.map((row) => row.metric)).size, 7, `метрики ячейки ${cell} не повторяются`);
    for (const row of rows) metrics.add(row.metric);
  }
  assert.equal(metrics.size, 7, 'в таблице семь разных метрик');
  assert.deepEqual(
    [...metrics].sort(),
    Object.keys(VALUE_LIMITS).sort(),
    'набор метрик соответствует заданным владельцем',
  );
});

test('стенд: каждая строка таблицы заполнена и имеет валидный статус', () => {
  for (const row of report.rows) {
    assert.equal(typeof row.cell, 'number');
    assert.ok(row.zone.length > 0, `у ячейки ${row.cell} есть зона`);
    assert.ok(row.metric.length > 0);
    assert.ok(row.threshold.length > 0, `у метрики ${row.metric} есть порог`);
    assert.ok(row.valueText.length > 0);
    assert.ok(['PASS', 'FAIL', 'N/A'].includes(row.status), `статус ${row.status} допустим`);
    if (row.status === 'N/A') {
      assert.equal(row.value, null, 'неприменимая метрика не имеет значения');
    } else {
      assert.equal(typeof row.value, 'number');
    }
  }
});

test('стенд: значения метрик конечны и лежат в разумных пределах', () => {
  for (const row of report.rows) {
    if (row.value === null) continue;
    assert.ok(Number.isFinite(row.value), `${row.metric}: значение конечно (${row.value})`);
    assert.ok(row.value >= 0, `${row.metric}: значение неотрицательно (${row.value})`);
    const limit = VALUE_LIMITS[row.metric];
    assert.ok(limit !== undefined, `у метрики ${row.metric} есть предел проверки`);
    assert.ok(row.value <= limit, `${row.metric}: значение ${row.value} в пределах ${limit}`);
  }
});

test('стенд: непрерывность через грань измеряется целым числом фактических створов', () => {
  const rows = report.rows.filter((row) => row.metric === 'непрерывность русла через грань');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    if (row.status === 'N/A') {
      assert.equal(row.value, null, 'нет створов — нет значения, а не 0/0');
      continue;
    }
    assert.ok(Number.isInteger(row.value), 'число непрерывных створов — целое');
    const match = /^(\d+)\/(\d+) створ/.exec(row.valueText);
    assert.ok(match, `значение имеет формат «2/2 створа» (получено: ${row.valueText})`);
    assert.equal(Number(match[1]), row.value, 'числитель равен числу непрерывных створов');
    const total = Number(match[2]);
    assert.ok(total >= 1 && total <= 6, 'знаменатель — число створов, не больше граней гекса');
    assert.ok(row.value <= total, 'непрерывных створов не больше всех створов');
  }
});

test('стенд: доля площади под врезом измерима на каждой ячейке и выражена в процентах', () => {
  const rows = report.rows.filter((row) => row.metric === 'доля площади гекса под врезом');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    assert.notEqual(row.status, 'N/A', 'метрика 7 применима всегда: нет вреза — честные 0 %');
    assert.ok(row.value >= 0 && row.value <= 100, `доля в пределах 0…100 % (${row.value})`);
    assert.match(row.valueText, /%/, 'значение выражено в процентах');
    assert.match(row.detail, /точек с carve > 0: \d+ из 1936/, 'в detail — счётчик точек сетки 44×44');
  }
});

test('стенд: ступень кромки сообщает число вершин в области вреза', () => {
  const rows = report.rows.filter((row) => row.metric === 'ступень кромки русла');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    if (row.status === 'N/A') {
      assert.match(
        row.detail,
        /нет русла|carve = 0/,
        'N/A объясняется отсутствием русла или нулевым врезом, а не молча',
      );
    } else {
      assert.match(row.detail, /вершин в области вреза: [1-9]\d* из \d+/, 'в detail — число вершин области вреза');
    }
  }
});

test('стенд: в мире A-17 речные метрики реально измеряются хотя бы на одной ячейке', async () => {
  // Кросс-проверка измеримости (не порогов): в A-29 врезанного русла на
  // контрольных ячейках может не быть, и тогда все речные строки — честные
  // N/A. В A-17 топология Patch7 несёт входы русла, поэтому хотя бы один
  // створ и хотя бы один профиль с carve > 0 обязаны измериться числом.
  const a17 = await stand.runStand({ world: 'a17', radiusM: 2500 });
  const continuity = a17.rows.filter((row) => row.metric === 'непрерывность русла через грань');
  assert.ok(
    continuity.some((row) => row.status !== 'N/A' && /^\d+\/\d+ створ/.test(row.valueText)),
    'хотя бы один створ измерен в формате «N/M створа»',
  );
  const bank = a17.rows.filter((row) => row.metric === 'ступень кромки русла');
  assert.ok(
    bank.some((row) => row.status !== 'N/A' && /вершин в области вреза: [1-9]/.test(row.detail)),
    'хотя бы один профиль пересекает область вреза',
  );
  const carveArea = a17.rows.filter((row) => row.metric === 'доля площади гекса под врезом');
  assert.ok(
    carveArea.some((row) => row.value > 0),
    'хотя бы на одной ячейке поле вреза ненулевое',
  );
});

test('стенд: сводка таблицы согласована с её строками', () => {
  const summary = report.summary;
  assert.equal(summary.total, report.rows.length);
  assert.equal(summary.pass + summary.fail + summary.na, report.rows.length);
  assert.equal(summary.failCount, summary.fail);
  assert.equal(summary.failedMetrics.length, new Set(summary.failedMetrics).size);
  for (const metric of summary.failedMetrics) {
    assert.ok(report.rows.some((row) => row.metric === metric && row.status === 'FAIL'));
  }
});

test('стенд: гейт возвращает 1 при красной метрике и 0 при полном PASS', () => {
  assert.equal(stand.gateExitCode({ fail: 1, pass: 10, na: 0 }), 1);
  assert.equal(stand.gateExitCode({ fail: 3, pass: 0, na: 0 }), 1);
  assert.equal(stand.gateExitCode({ fail: 0, pass: 42, na: 0 }), 0);
  assert.equal(stand.gateExitCode({ fail: 0, pass: 0, na: 42 }), 0, 'один N/A — не FAIL');
});

test('стенд: CLI печатает таблицу и без --gate всегда выходит с кодом 0', () => {
  const result = spawnSync('node', [TOOL_PATH], { encoding: 'utf8' });
  assert.equal(result.status, 0, `код возврата: ${result.status} ${result.stderr ?? ''}`);
  const out = result.stdout;
  assert.match(out, /ячейка\s+зона\s+метрика\s+значение\s+порог\s+статус/);
  assert.match(out, /SUMMARY/);
  assert.match(out, /FAIL: \d+/);
  for (const cell of stand.CONTROL_CELLS) {
    assert.ok(out.includes(String(cell)), `в таблице есть ячейка ${cell}`);
  }
});

test('стенд: --json отдаёт те же поля, что и таблица', () => {
  const result = spawnSync('node', [TOOL_PATH, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `код возврата: ${result.status} ${result.stderr ?? ''}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.rows.length, stand.CONTROL_CELLS.length * 7);
  for (const row of parsed.rows) {
    for (const field of ['cell', 'zone', 'metric', 'value', 'valueText', 'threshold', 'status', 'detail']) {
      assert.ok(field in row, `в JSON-строке есть поле ${field}`);
    }
  }
  assert.equal(parsed.summary.fail + parsed.summary.pass + parsed.summary.na, parsed.rows.length);
  assert.deepEqual(parsed.controlCells, stand.CONTROL_CELLS);
});

test('стенд: код возврата --gate согласован с числом красных строк', () => {
  const result = spawnSync('node', [TOOL_PATH, '--gate'], { encoding: 'utf8' });
  assert.equal(result.status, stand.gateExitCode(report.summary), 'гейт считает те же строки, что и таблица');
  assert.ok(result.status === 0 || result.status === 1);
});

test('стенд: неизвестный профиль и неизвестный аргумент отвергаются', () => {
  assert.throws(() => stand.parseArgs(['--profile=unknown']), /Неизвестный профиль/);
  assert.throws(() => stand.parseArgs(['--nope']), /Неизвестный аргумент/);
  const options = stand.parseArgs(['--gate', '--json', '--profile=a17', '--radius-m=1200']);
  assert.deepEqual(
    { gate: options.gate, json: options.json, world: options.world, radiusM: options.radiusM },
    { gate: true, json: true, world: 'a17', radiusM: 1200 },
  );
});
