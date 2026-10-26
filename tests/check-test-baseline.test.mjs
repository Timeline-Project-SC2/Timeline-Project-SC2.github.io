/* Self-test стража базы известных падений (карточка `CI-1` §4.5).
   -------------------------------------------------------------------------
   Проверяется сам страж `tools/check_test_baseline.mjs`, а не реальный набор
   тестов: настоящий `npm test` здесь НЕ запускается (иначе страж звал бы сам
   себя и краснел от собственных 8 базовых падений). Все TAP-потоки — фикстуры
   в этом файле.

   Что доказывается:
   1. Разбор `scripts.test` из `package.json`: команда `node --test`,
      `--test-reporter=tap` добавляется один раз, список файлов не дублируется
      и совпадает с файлами самого скрипта (единственный источник — package.json).
   2. Зелёный случай «ровно база»: выход 0 и строка
      «известные падения: 2/2 по базе, новых нет».
   3. Красный «новое имя»: выход 1 и секция «НОВЫЕ ПАДЕНИЯ:».
   4. Красный «устаревшая база»: выход 1 и секция «БАЗА УСТАРЕЛА:».
   5. Красный «крэш процесса»: выход 1, отдельное сообщение, под базу не маскируется.
   6. Форматы TAP: плоский (Node 22 и Node 24 на этом наборе) и вложенный —
      имена подтестов извлекаются одинаково, полное имя склеивается через « > ».
   7. Раскодирование TAP-экранирования (`\#43533` → `#43533`): имя в базе
      записано как в исходнике теста, а не как в транспортном формате.
   8. Гигиена самой базы `tools/known-test-failures.json`: 8 записей, контур
      планетарный, файлы существуют, имён сектора и атласа нет.

   Запуск: node --test tests/check-test-baseline.test.mjs
*/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_PATH,
  PACKAGE_PATH,
  buildTestCommand,
  compareWithBaseline,
  decodeTapName,
  evaluateRun,
  loadBaseline,
  parseTap,
  testFiles
} from '../tools/check_test_baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
const baseline = loadBaseline(BASELINE_PATH);

const BASELINE_FIXTURE = [
  { name: 'Первый известный провал', file: 'tests/example.test.mjs', contour: 'планетарный', knownSince: 'Stage-8.5' },
  { name: 'Второй известный провал', file: 'tests/example.test.mjs', contour: 'планетарный', knownSince: 'W26b ×2' }
];

/** Плоский TAP, как печатают Node 22 и Node 24 на текущем наборе. */
const FLAT_FAIL = [
  'TAP version 13',
  '# Subtest: Проходит',
  'ok 1 - Проходит',
  '  ---',
  '  duration_ms: 1.1',
  '  type: \'test\'',
  '  ...',
  '# Subtest: Первый известный провал',
  'not ok 2 - Первый известный провал',
  '  ---',
  '  duration_ms: 2.2',
  '  failureType: \'testCodeFailure\'',
  '  error: \'нет совпадения\'',
  '  ...',
  '1..2',
  '# tests 2',
  '# suites 0',
  '# pass 1',
  '# fail 1',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 12.3'
].join('\n');

test('scripts.test разбирается как есть: TAP-репортёр добавляется, список файлов не дублируется', () => {
  const command = buildTestCommand(pkg);
  assert.equal(command.command, 'node');
  assert.equal(command.args[0], '--test');
  assert.equal(command.args.filter((arg) => arg === '--test-reporter=tap').length, 1, 'ровно один TAP-репортёр');

  // Список файлов — ровно тот, что в строке `test` (плюс этот self-test не дублируется).
  const fromScript = pkg.scripts.test.split(/\s+/).filter((arg) => /\.(?:test|spec)\.(?:[cm]?[jt]s)$/.test(arg));
  assert.deepEqual(testFiles(command.args), fromScript);
  assert.ok(fromScript.includes('tests/check-test-baseline.test.mjs'), 'self-test входит в общий прогон');
  assert.equal(fromScript.length, 37, 'в строке test — 37 файлов (36 прежних + self-test стража)');

  // Флаг concurrency и порядок аргументов не потерялись.
  assert.ok(command.args.includes('--test-concurrency=1'));
  assert.equal(command.args.indexOf('--test-reporter=tap'), command.args.indexOf('--test') + 1);
});

test('существующий --test-reporter заменяется, а не дублируется', () => {
  const cases = [
    'node --test --test-reporter=spec tests/a.test.mjs',
    'node --test --test-reporter spec tests/a.test.mjs'
  ];
  for (const script of cases) {
    const command = buildTestCommand({ scripts: { test: script } });
    assert.deepEqual(
      command.args.filter((arg) => arg.startsWith('--test-reporter')),
      ['--test-reporter=tap'],
      script
    );
    assert.deepEqual(testFiles(command.args), ['tests/a.test.mjs']);
  }
});

test('сломанный scripts.test — ошибка, а не тихий зелёный', () => {
  assert.throws(() => buildTestCommand({ scripts: {} }), /нет строки scripts\.test/);
  assert.throws(() => buildTestCommand({ scripts: { test: 'node tests/a.test.mjs' } }), /не запускает/);
});

test('зелёный случай: падения ровно по базе — выход 0 и строка 8/8-формата', () => {
  const verdict = evaluateRun({ exitCode: 1, tapText: FLAT_FAIL, baseline: BASELINE_FIXTURE.slice(0, 1) });
  assert.equal(verdict.code, 0, verdict.text);
  assert.match(verdict.text, /известные падения: 1\/1 по базе, новых нет/);
  assert.match(verdict.text, /СТРАЖ: ОК/);
  assert.deepEqual(verdict.newFailures, []);
  assert.deepEqual(verdict.staleBaseline, []);
});

test('зелёный случай на текущей базе: 8/8 по базе, новых нет', () => {
  const tap = [
    'TAP version 13',
    ...baseline.flatMap((entry, index) => [
      `# Subtest: ${entry.name.replace(/#/g, '\\#')}`,
      `not ok ${index + 1} - ${entry.name.replace(/#/g, '\\#')}`
    ]),
    '1..8',
    '# tests 8',
    '# pass 0',
    '# fail 8',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0'
  ].join('\n');
  const verdict = evaluateRun({ exitCode: 1, tapText: tap, baseline });
  assert.equal(verdict.code, 0, verdict.text);
  assert.match(verdict.text, new RegExp(`известные падения: ${baseline.length}/${baseline.length} по базе, новых нет`));
  for (const entry of baseline) {
    assert.ok(verdict.text.includes(entry.name), `в логе стража есть имя из базы: ${entry.name}`);
  }
});

test('красный случай «новое падение»: выход 1 и секция НОВЫЕ ПАДЕНИЯ', () => {
  const tap = FLAT_FAIL.replace('not ok 2 - Первый известный провал', 'not ok 2 - Первый известный провал\nnot ok 3 - Неизвестный провал');
  const verdict = evaluateRun({ exitCode: 1, tapText: tap, baseline: BASELINE_FIXTURE });
  assert.equal(verdict.code, 1);
  assert.deepEqual(verdict.newFailures, ['Неизвестный провал']);
  assert.deepEqual(verdict.staleBaseline, ['Второй известный провал']);
  assert.match(verdict.text, /НОВЫЕ ПАДЕНИЯ:/);
  assert.match(verdict.text, /✗ Неизвестный провал/);
});

test('красный случай «база устарела»: починили базовое падение — обнови базу в этом же PR', () => {
  const tap = FLAT_FAIL.replace('not ok 2 - Первый известный провал', 'ok 2 - Первый известный провал')
    .replace('# fail 1', '# fail 0');
  const verdict = evaluateRun({ exitCode: 0, tapText: tap, baseline: BASELINE_FIXTURE.slice(0, 1) });
  assert.equal(verdict.code, 1);
  assert.deepEqual(verdict.staleBaseline, ['Первый известный провал']);
  assert.match(verdict.text, /БАЗА УСТАРЕЛА:/);
  assert.match(verdict.text, /Обновите tools\/known-test-failures\.json/);
});

test('красный случай «крэш процесса»: TAP-итогов нет — отдельное сообщение, база не маскирует', () => {
  const tap = ['TAP version 13', '# Subtest: Первый известный провал', 'not ok 1 - Первый известный провал'].join('\n');
  const verdict = evaluateRun({ exitCode: 134, tapText: tap, baseline: BASELINE_FIXTURE });
  assert.equal(verdict.code, 1);
  assert.match(verdict.text, /КРЭШ ПРОГОНА ТЕСТОВ/);
  assert.match(verdict.text, /код возврата: 134/);
  assert.doesNotMatch(verdict.text, /СТРАЖ: ОК/);
});

test('крэш по сигналу и пустой вывод — тоже красный', () => {
  const bySignal = evaluateRun({ exitCode: null, signal: 'SIGKILL', tapText: '', baseline: [] });
  assert.equal(bySignal.code, 1);
  assert.match(bySignal.text, /сигнал: SIGKILL/);
  const empty = evaluateRun({ exitCode: 1, tapText: 'ошибка загрузки теста\n', baseline: [] });
  assert.equal(empty.code, 1);
  assert.match(empty.text, /КРЭШ ПРОГОНА ТЕСТОВ/);
});

test('пустая база и зелёный прогон — выход 0; зелёный прогон с пустой базой не требует записей', () => {
  const tap = FLAT_FAIL.replace('not ok 2 - Первый известный провал', 'ok 2 - Первый известный провал').replace('# fail 1', '# fail 0');
  const verdict = evaluateRun({ exitCode: 0, tapText: tap, baseline: [] });
  assert.equal(verdict.code, 0, verdict.text);
  assert.match(verdict.text, /известные падения: 0\/0 по базе, новых нет/);
});

test('вложенный TAP: полное имя подтеста склеивается через « > »', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: suite планетарного контура',
    '    # Subtest: вложенный провал',
    '    not ok 1 - вложенный провал',
    '      ---',
    '      duration_ms: 1',
    '      ...',
    '    1..1',
    'not ok 1 - suite планетарного контура',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0'
  ].join('\n');
  const parsed = parseTap(tap);
  assert.deepEqual(parsed.failures, [
    'suite планетарного контура > вложенный провал',
    'suite планетарного контура'
  ]);
});

test('обёртка файла в TAP отбрасывается: имя подтеста не зависит от версии раннера', () => {
  const wrapped = [
    'TAP version 13',
    '# Subtest: tests/local-map.test.mjs',
    '    # Subtest: Stage-8.10b: контракт не тащит ядро',
    '    not ok 1 - Stage-8.10b: контракт не тащит ядро',
    '    1..1',
    'not ok 1 - tests/local-map.test.mjs',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0'
  ].join('\n');
  const parsed = parseTap(wrapped);
  assert.ok(parsed.failures.includes('Stage-8.10b: контракт не тащит ядро'));
  assert.ok(parsed.failures.includes('tests/local-map.test.mjs'));
  const verdict = evaluateRun({
    exitCode: 1,
    tapText: wrapped,
    baseline: [{ name: 'Stage-8.10b: контракт не тащит ядро', file: 'tests/local-map.test.mjs', contour: 'планетарный', knownSince: 'контракт ядра' }]
  });
  assert.equal(verdict.code, 1, 'обёртка файла — отдельное падение вне базы, маскировать нельзя');
  assert.deepEqual(verdict.newFailures, ['tests/local-map.test.mjs']);
});

test('директива SKIP/TODO в TAP: пропущенный тест не считается ни падением, ни успехом', () => {
  const tap = [
    'TAP version 13',
    'ok 1 - проходит',
    'ok 2 - пропущен # SKIP',
    '1..2',
    '# tests 2',
    '# pass 2',
    '# fail 0',
    '# cancelled 0',
    '# skipped 1',
    '# todo 0'
  ].join('\n');
  const parsed = parseTap(tap);
  assert.deepEqual(parsed.failures, []);
  assert.deepEqual(parsed.passed, ['проходит']);
  assert.equal(parsed.totals.skipped, 1);
});

test('экранирование TAP раскодируется: `\\#` — это `#` из исходника теста', () => {
  assert.equal(decodeTapName('A-17 diagnostic: числа стыка и берега для \\#43533…\\#43537'),
    'A-17 diagnostic: числа стыка и берега для #43533…#43537');
  assert.equal(decodeTapName('без экранирования #43533'), 'без экранирования #43533');

  const escaped = evaluateRun({
    exitCode: 1,
    tapText: ['TAP version 13', 'not ok 1 - A-17 для \\#43533', '1..1', '# tests 1', '# fail 1'].join('\n'),
    baseline: [{ name: 'A-17 для #43533', file: 'tests/x.test.mjs', contour: 'планетарный', knownSince: 'A-17 ×2' }]
  });
  assert.equal(escaped.code, 0, escaped.text);
});

test('сравнение с базой: matched, новые и устаревшие имена считаются раздельно', () => {
  const comparison = compareWithBaseline(
    ['первый', 'третий'],
    [
      { name: 'первый' },
      { name: 'второй' },
      { name: 'первый' }
    ]
  );
  assert.deepEqual(comparison.newFailures, ['третий']);
  assert.deepEqual(comparison.staleBaseline, ['второй']);
  assert.equal(comparison.matched, 1);
});

test('гигиена базы tools/known-test-failures.json: 8 записей планетарного контура, файлы на месте', () => {
  // Число записей НЕ фиксируется: починка базового падения — легальный повод
  // сократить базу (страж в этом же прогоне потребует её обновить), и такой PR
  // не должен упираться в правку этого self-test.
  assert.ok(baseline.length > 0, 'база не пуста');
  for (const entry of baseline) {
    assert.equal(entry.contour, 'планетарный', `${entry.name}: контур планетарный`);
    assert.ok(existsSync(path.join(ROOT, entry.file)), `${entry.name}: файл ${entry.file} существует`);
    assert.ok(entry.file.startsWith('tests/'), `${entry.name}: база ссылается на тест`);
    assert.doesNotMatch(entry.name, /сектор|атлас|sector|atlas/i, `${entry.name}: имена сектора и атласа в базу не входят`);
    assert.ok(entry.knownSince.trim().length > 0, `${entry.name}: указан этап появления долга`);
  }
  assert.equal(new Set(baseline.map((entry) => entry.name)).size, baseline.length, 'имена в базе не повторяются');
});
