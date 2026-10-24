/* Тест измерительного стенда локальной карты (Stage-8.12d + Stage-8.14, шаг 1).
   ---------------------------------------------------------------------------
   Стенд — инструмент измерения, а не тест дефектов. Тест проверяет
   ВЫЧИСЛИМОСТЬ метрик (числа конечные, в разумных пределах), структуру
   отчёта и негативный контроль на плоской синтетической фикстуре, а НЕ
   прохождение порогов живой картой: пока пороги красные, CI не должен
   краснеть из-за текущего состояния карты.

   Когда починка закроет дефекты и пороги станут зелёными, тест останется
   зелёным: он не завязан на текущие значения живой карты, а только на их
   конечность, диапазон, негативный контроль и согласованность отчёта с CLI.

   Запуск: node --test tests/local-map-stand.test.mjs
*/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(new URL('../tools/stand_local_map.mjs', import.meta.url));

/** Публичный API стенда: тест меряет тем же кодом, что и CLI. */
const stand = await import(TOOL_PATH);

/** Число метрик стенда: 7 исходных (Stage-8.12d) + 7 новых (Stage-8.14, шаг 1). */
const METRIC_COUNT = 14;

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
  'размах суши / ширина кадра': 500,
  'размах океанского дна': 500,
  'средний уклон': 1000,
  'гипсометрия p90−p10': 100,
  'гладкость контура воды': 100,
  'непрерывность A↔B': 20000,
  'согласованность LOD': 20000,
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
  // Stage-8.14 (шаг 1, Воркер 26): пороги метрик m.8…m.14 менять нельзя.
  assert.equal(stand.THRESHOLDS.landReliefMinPct, 10, 'm.8 размах суши: минимум 10 %');
  assert.equal(stand.THRESHOLDS.landReliefMaxPct, 25, 'm.8 размах суши: максимум 25 %');
  assert.equal(stand.THRESHOLDS.oceanReliefMinPct, 5, 'm.9 размах океанского дна ≥ 5 %');
  assert.equal(stand.THRESHOLDS.meanSlopeMinPct, 4, 'm.10 средний уклон ≥ 4 %');
  assert.equal(stand.THRESHOLDS.hypsometryMinPct, 40, 'm.11 гипсометрия p90−p10 ≥ 40 % размаха');
  assert.equal(stand.THRESHOLDS.waterContourSmoothMinPct, 40, 'm.12 гладкость контура воды ≥ 40 %');
  assert.equal(stand.THRESHOLDS.hexContinuityMaxM, 1, 'm.13 непрерывность A↔B ≤ 1 м');
  assert.equal(stand.THRESHOLDS.lodConsistencyMaxM, 2, 'm.14 согласованность LOD ≤ 2 м');
  assert.equal(stand.HEX_EDGE_SAMPLES, 16, 'm.13: ровно 16 точек вдоль грани гекса');
  assert.equal(stand.LOD_FINE_RES, 256, 'm.14: детальный LOD 256');
  assert.equal(stand.LOD_COARSE_RES, 64, 'm.14: грубый LOD 64');
});

test('стенд: таблица покрывает все 7 контрольных ячеек и все 14 метрик', () => {
  assert.equal(report.rows.length, stand.CONTROL_CELLS.length * METRIC_COUNT);
  const metrics = new Set();
  for (const cell of stand.CONTROL_CELLS) {
    const rows = report.rows.filter((row) => row.cell === cell);
    assert.equal(rows.length, METRIC_COUNT, `у ячейки ${cell} ровно ${METRIC_COUNT} метрик`);
    assert.equal(new Set(rows.map((row) => row.metric)).size, METRIC_COUNT, `метрики ячейки ${cell} не повторяются`);
    for (const row of rows) metrics.add(row.metric);
  }
  assert.equal(metrics.size, METRIC_COUNT, 'в таблице четырнадцать разных метрик');
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

  // m.2 по ветвям (карточка 18c): порог в таблице, подпись ветви в detail и
  // статус обязаны быть согласованы со значением в КАЖДОЙ измеренной строке —
  // морская ветвь не имеет потолка, речная имеет диапазон 3…12 м.
  const depths = a17.rows.filter((row) => row.metric === 'глубина воды в центре русла');
  for (const row of depths) {
    if (row.status === 'N/A') continue;
    if (row.threshold === '≥ 3 м') {
      assert.match(row.detail, /морская ветвь/, `ячейка ${row.cell}: морская ветвь подписана в detail`);
      assert.equal(
        row.status,
        row.value >= stand.THRESHOLDS.riverDepthM ? 'PASS' : 'FAIL',
        `ячейка ${row.cell}: у морской ветви нет потолка (значение ${row.value} м)`,
      );
    } else {
      assert.equal(row.threshold, '3…12 м', `ячейка ${row.cell}: порог — одна из двух ветвей`);
      assert.match(row.detail, /речная ветвь/, `ячейка ${row.cell}: речная ветвь подписана в detail`);
      assert.equal(
        row.status,
        row.value >= stand.THRESHOLDS.riverDepthM && row.value <= stand.THRESHOLDS.riverDepthMaxM ? 'PASS' : 'FAIL',
        `ячейка ${row.cell}: речная ветвь держит диапазон 3…12 м (значение ${row.value} м)`,
      );
    }
  }
  // Известный ответ карточки 18c: четыре океанские ячейки A-17 с входом
  // русла измеряются морской ветвью (глубина моря, а не каньон вреза).
  for (const cell of [37488, 37518, 137363, 137436]) {
    const row = depths.find((entry) => entry.cell === cell);
    assert.ok(row, `у ячейки ${cell} есть строка глубины`);
    assert.equal(row.threshold, '≥ 3 м', `ячейка ${cell}: порог морской ветви`);
    assert.match(row.detail, /морская ветвь/, `ячейка ${cell}: подпись «морская ветвь»`);
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

test('стенд: метрики формы и сквозной непрерывности (m.8…m.14) вычислимы на живой карте', () => {
  const newMetrics = [
    stand.METRIC_TITLES.landRelief,
    stand.METRIC_TITLES.oceanRelief,
    stand.METRIC_TITLES.meanSlope,
    stand.METRIC_TITLES.hypsometry,
    stand.METRIC_TITLES.waterContour,
    stand.METRIC_TITLES.hexContinuity,
    stand.METRIC_TITLES.lodConsistency,
  ];
  for (const metric of newMetrics) {
    const rows = report.rows.filter((row) => row.metric === metric);
    assert.equal(rows.length, stand.CONTROL_CELLS.length, `у метрики «${metric}» по строке на каждую контрольную ячейку`);
    const measured = rows.filter((row) => row.status !== 'N/A');
    assert.ok(measured.length > 0, `метрика «${metric}» реально измеряется хотя бы на одной ячейке`);
    for (const row of measured) {
      assert.ok(Number.isFinite(row.value) && row.value >= 0, `${metric}: конечное неотрицательное число (${row.value})`);
    }
  }

  for (const row of report.rows.filter((r) => r.metric === stand.METRIC_TITLES.hexContinuity)) {
    assert.notEqual(row.status, 'N/A', `ячейка ${row.cell}: у каждого контрольного гекса есть 6 соседей A↔B`);
    assert.match(row.valueText, /м$/, 'непрерывность A↔B выражена в метрах');
    assert.match(row.detail, /16 точек грани/, 'в detail указано 16 точек грани');
    assert.equal(
      row.status,
      row.value <= stand.THRESHOLDS.hexContinuityMaxM ? 'PASS' : 'FAIL',
      'статус m.13 строго соответствует порогу ≤ 1 м',
    );
  }

  for (const row of report.rows.filter((r) => r.metric === stand.METRIC_TITLES.lodConsistency)) {
    assert.notEqual(row.status, 'N/A', `ячейка ${row.cell}: гекс представлен и на 256, и на 64`);
    assert.match(row.valueText, /м$/, 'согласованность LOD выражена в метрах');
    assert.match(row.detail, /LOD 256 против 64/, 'в detail указано сравнение 256 против 64');
    assert.equal(
      row.status,
      row.value <= stand.THRESHOLDS.lodConsistencyMaxM ? 'PASS' : 'FAIL',
      'статус m.14 строго соответствует порогу ≤ 2 м',
    );
  }
});

test('негативный контроль (правило 2): плоская фикстура с постоянной высотой', () => {
  for (const constantHeightM of [0, 42.5, -31.5]) {
    const flat = stand.runFlatFixtureControl({ constantHeightM, radiusM: 2500 });
    assert.equal(flat.rows.length, 7, 'в негативном контроле ровно семь новых метрик m.8…m.14');
    for (const row of flat.rows) {
      assert.notEqual(row.status, 'N/A', `${row.metric}: на береговой плоской фикстуре не уходит в N/A`);
      assert.equal(row.value, 0, `${row.metric}: на постоянной высоте h=${constantHeightM} м измерено 0`);
    }

    // Все пять метрик формы и гладкости контура (m.8…m.12) обязаны возвращать FAIL на плоскости.
    for (const title of [
      stand.METRIC_TITLES.landRelief,
      stand.METRIC_TITLES.oceanRelief,
      stand.METRIC_TITLES.meanSlope,
      stand.METRIC_TITLES.hypsometry,
      stand.METRIC_TITLES.waterContour,
    ]) {
      const row = flat.rows.find((entry) => entry.metric === title);
      assert.equal(row?.status, 'FAIL', `${title} на плоской плите h=${constantHeightM} м обязана давать FAIL`);
    }

    // m.13 и m.14 — полунормы расхождения |h₁ − h₂| ≤ ε: при h_A ≡ h_B ≡ h_64 ≡ const
    // честное расхождение тождественно равно 0 м (PASS); подгонять их под FAIL нельзя.
    for (const title of [stand.METRIC_TITLES.hexContinuity, stand.METRIC_TITLES.lodConsistency]) {
      const row = flat.rows.find((entry) => entry.metric === title);
      assert.equal(row?.status, 'PASS', `${title}: на совпадающей константе |C − C| = 0 м (PASS)`);
    }
    assert.equal(stand.gateExitCode(flat.summary), 1, 'плоская фикстура валит гейт стенда');
  }
});

test('синтетические пробы m.8…m.14: метрики чувствительны в обе стороны (не захардкожены в FAIL)', () => {
  const res = 256;
  const radiusM = 2500;
  // Наклонный рельеф: суша x >= 128 поднимается на 750 м (15 % от 2R = 5000 м),
  // океан x < 128 опускается на 350 м (7 % от 2R), плавная полоса маски воды.
  const heightfield = new Float32Array(res * res);
  const terraformMap = new Uint8Array(res * res);
  const waterMask = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      const idx = y * res + x;
      const u = x / (res - 1);
      const v = y / (res - 1);
      if (x < res / 2) {
        terraformMap[idx] = 0;
        heightfield[idx] = -350 * (1 - x / (res / 2 - 1)) - 10 * v;
      } else {
        terraformMap[idx] = 2;
        heightfield[idx] = 740 * ((x - res / 2) / (res / 2 - 1)) + 10 * v;
      }
      // Плавная переходная полоса шириной 6 текселей вокруг x = 128 (все промежуточные 0 < mask < 1).
      waterMask[idx] = Math.min(1, Math.max(0, 0.5 - (x - 127.5) / 6));
    }
  }
  const local = { heightfield, terraformMap, waterMask, meta: { radiusM, hfRes: res, tfRes: res } };

  const m8 = stand.measureLandRelief(local, radiusM);
  assert.ok(m8.value >= 10 && m8.value <= 25, `m.8 в целевом коридоре 10…25 % (${m8.value})`);
  const m9 = stand.measureOceanRelief(local, null, radiusM);
  assert.ok(m9.value >= 5, `m.9 ≥ 5 % (${m9.value})`);
  const m10 = stand.measureMeanSlope(local, radiusM);
  assert.ok(m10.value >= 4, `m.10 ≥ 4 % (${m10.value})`);
  const m11 = stand.measureHypsometry(local);
  assert.ok(m11.value >= 40, `m.11 ≥ 40 % (${m11.value})`);
  const m12 = stand.measureWaterContourSmoothness(local, null, radiusM);
  assert.ok(m12.value >= 40, `m.12 ≥ 40 % на гладкой маске (${m12.value})`);

  // Наоборот, m.13 и m.14 обязаны ловить ступеньки A↔B (> 1 м) и LOD (> 2 м).
  const mismatchProbe = stand.runFlatFixtureControl({
    constantHeightM: 10,
    neighborHeightOffsetM: 2.5,
    lodHeightOffsetM: 3.5,
  });
  const m13Row = mismatchProbe.rows.find((r) => r.metric === stand.METRIC_TITLES.hexContinuity);
  const m14Row = mismatchProbe.rows.find((r) => r.metric === stand.METRIC_TITLES.lodConsistency);
  assert.equal(m13Row?.status, 'FAIL', 'm.13 ловит ступеньку A↔B 2,5 м > 1 м');
  assert.ok(Math.abs(m13Row.value - 2.5) < 1e-3, `m.13 измеряет 2,5 м (${m13Row.value})`);
  assert.equal(m14Row?.status, 'FAIL', 'm.14 ловит ступеньку LOD 3,5 м > 2 м');
  assert.ok(Math.abs(m14Row.value - 3.5) < 1e-3, `m.14 измеряет 3,5 м (${m14Row.value})`);
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
  assert.equal(parsed.rows.length, stand.CONTROL_CELLS.length * METRIC_COUNT);
  for (const row of parsed.rows) {
    for (const field of ['cell', 'zone', 'metric', 'value', 'valueText', 'threshold', 'status', 'detail']) {
      assert.ok(field in row, `в JSON-строке есть поле ${field}`);
    }
  }
  assert.equal(parsed.summary.fail + parsed.summary.pass + parsed.summary.na, parsed.rows.length);
  assert.deepEqual(parsed.controlCells, stand.CONTROL_CELLS);
});

test('стенд: --flat-fixture работает из CLI и с --gate возвращает 1', () => {
  const plain = spawnSync('node', [TOOL_PATH, '--flat-fixture', '--json'], { encoding: 'utf8' });
  assert.equal(plain.status, 0, `без --gate код 0: ${plain.stderr ?? ''}`);
  const parsed = JSON.parse(plain.stdout);
  assert.equal(parsed.mode, 'flat-fixture');
  assert.equal(parsed.rows.length, 7);
  assert.equal(parsed.summary.fail, 5);
  assert.equal(parsed.summary.pass, 2);

  const gated = spawnSync('node', [TOOL_PATH, '--flat-fixture', '--gate'], { encoding: 'utf8' });
  assert.equal(gated.status, 1, 'плоская фикстура с --gate обязана возвращать exit code 1');
});

test('стенд: код возврата --gate согласован с числом красных строк', () => {
  const result = spawnSync('node', [TOOL_PATH, '--gate'], { encoding: 'utf8' });
  assert.equal(result.status, stand.gateExitCode(report.summary), 'гейт считает те же строки, что и таблица');
  assert.ok(result.status === 0 || result.status === 1);
});

test('стенд: неизвестный профиль и неизвестный аргумент отвергаются', () => {
  assert.throws(() => stand.parseArgs(['--profile=unknown']), /Неизвестный профиль/);
  assert.throws(() => stand.parseArgs(['--nope']), /Неизвестный аргумент/);
  const options = stand.parseArgs(['--gate', '--json', '--flat-fixture', '--flat-height-m=12', '--profile=a17', '--radius-m=1200']);
  assert.deepEqual(
    {
      gate: options.gate,
      json: options.json,
      flatFixture: options.flatFixture,
      flatHeightM: options.flatHeightM,
      world: options.world,
      radiusM: options.radiusM,
    },
    { gate: true, json: true, flatFixture: true, flatHeightM: 12, world: 'a17', radiusM: 1200 },
  );
});
