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
  'непрерывность русла через грань': 16,
  'фактура рельефа (RMS колец)': 100,
  'перепад вершин на суше': 1000,
  'перепад waterDepthM патч/юбка': 1000,
};

const report = await stand.runStand({ world: 'a29', radiusM: 2500 });

test('стенд: конфигурация измерений зафиксирована владельцем', () => {
  assert.deepEqual(
    stand.CONTROL_CELLS,
    [37488, 37518, 37548, 37519, 137363, 137390, 137436],
    'список контрольных ячеек не меняется',
  );
  assert.equal(stand.THRESHOLDS.bankStepM, 2, 'ступень кромки русла ≤ 2 м');
  assert.equal(stand.THRESHOLDS.riverDepthM, 3, 'глубина воды в центре русла ≥ 3 м');
  assert.equal(stand.THRESHOLDS.continuityAzimuths, 16, 'непрерывность 16/16 азимутов');
  assert.equal(stand.THRESHOLDS.textureRatioMin, 0.7, 'коридор фактуры: 0,7…');
  assert.equal(stand.THRESHOLDS.textureRatioMax, 1.3, 'коридор фактуры: …1,3');
  assert.equal(stand.THRESHOLDS.landStepM, 6, 'перепад вершин на суше ≤ 6 м');
  assert.equal(stand.THRESHOLDS.waterDepthDeltaM, 0.5, 'перепад waterDepthM ≤ 0,5 м');
});

test('стенд: таблица покрывает все 7 контрольных ячеек и все 6 метрик', () => {
  assert.equal(report.rows.length, stand.CONTROL_CELLS.length * 6);
  const metrics = new Set();
  for (const cell of stand.CONTROL_CELLS) {
    const rows = report.rows.filter((row) => row.cell === cell);
    assert.equal(rows.length, 6, `у ячейки ${cell} ровно 6 метрик`);
    assert.equal(new Set(rows.map((row) => row.metric)).size, 6, `метрики ячейки ${cell} не повторяются`);
    for (const row of rows) metrics.add(row.metric);
  }
  assert.equal(metrics.size, 6, 'в таблице шесть разных метрик');
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

test('стенд: непрерывность через грань измеряется целым числом азимутов', () => {
  const rows = report.rows.filter((row) => row.metric === 'непрерывность русла через грань');
  assert.equal(rows.length, stand.CONTROL_CELLS.length);
  for (const row of rows) {
    assert.ok(Number.isInteger(row.value), 'число азимутов — целое');
    assert.ok(row.value >= 0 && row.value <= stand.THRESHOLDS.continuityAzimuths);
  }
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
  assert.equal(parsed.rows.length, stand.CONTROL_CELLS.length * 6);
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
