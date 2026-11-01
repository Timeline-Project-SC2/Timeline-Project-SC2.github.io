/* Self-test стража карантина (карточки `CI-1` §4.5, `CI-2` §4.2/§4.5, редакция CI2-7).
   -------------------------------------------------------------------------
   Проверяется сам страж `tools/check_test_baseline.mjs`, а не реальный набор
   тестов: настоящий `npm test` здесь НЕ запускается (иначе страж звал бы сам
   себя). Оба TAP-потока — синтетические фикстуры в этом файле.

   Что доказывается:
   1. Разбор `scripts["test:raw"]` из `package.json`: команда `node --test`,
      `--test-reporter=tap` добавляется один раз, список файлов не дублируется
      и совпадает с файлами самого скрипта (единственный источник — package.json).
   2. Зелёная пара прогонов: прогон 1 — ровно реестровые `not ok`; прогон 2 —
      0 `not ok`, `N2 = N1 − 8`; выход 0 и итоговая строка карантина.
   3. Красный «новое имя» в прогоне 1: выход 1 и секция «НОВЫЕ ПАДЕНИЯ:».
   4. Красный «устаревшее имя реестра»: выход 1 и секция «КАРАНТИН НЕ ПРИМЕНЁН».
   5. Красный «`not ok` в карантинном прогоне»: выход 1, та же секция.
   6. Красный «арифметика `N2 ≠ N1 − 8`» (широкий/сломанный паттерн): выход 1.
   7. Красный «крэш» любого из двух прогонов: выход 1, сообщение с номером прогона.
   8. Экранирование спецсимволов TAP-имён (`()#·≤%`, кириллица) и якоря `^…$`:
      паттерн строится из полного имени и не матчит частичное.
   9. Автодетект skip-флага по выводу `node --help` (`--test-skip` →
      `--test-skip-pattern`), отсутствие обоих — `null`, а не молчаливый пропуск.
  10. Форматы TAP: плоский и вложенный; раскодирование `\#43533` → `#43533`.
  11. Гигиена реестра `tools/known-test-failures.json`: блок `meta` (намеренность,
      дата 2026-10-26, ссылки `S8-Q1`/`CI-2`, условие снятия), 8 записей
      планетарного контура с `reason`, файлы существуют, имён сектора и атласа нет.

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
  RAW_SCRIPT,
  SKIP_FLAGS,
  buildSkipArgs,
  buildTestCommand,
  compareWithBaseline,
  decodeTapName,
  detectSkipFlag,
  escapeTapPattern,
  evaluateGuard,
  loadBaseline,
  loadRegistry,
  parseTap,
  testCount,
  testFiles
} from '../tools/check_test_baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
const registry = loadRegistry(BASELINE_PATH);
const baseline = loadBaseline(BASELINE_PATH);

/** Синтетический список из двух записей: в реальный набор не входит. */
const BASELINE_FIXTURE = [
  { name: 'Первый известный провал', file: 'tests/example.test.mjs', contour: 'планетарный', knownSince: 'Stage-8.5', reason: 'фикстура' },
  { name: 'Второй известный провал', file: 'tests/example.test.mjs', contour: 'планетарный', knownSince: 'W26b ×2', reason: 'фикстура' }
];

/** Полный прогон: 2 падения из реестра, 3 проходящих теста → N1 = 5. */
const RUN1_OK = [
  'TAP version 13',
  '# Subtest: Проходит раз',
  'ok 1 - Проходит раз',
  '# Subtest: Первый известный провал',
  'not ok 2 - Первый известный провал',
  '  ---',
  '  duration_ms: 2.2',
  '  failureType: \'testCodeFailure\'',
  '  error: \'нет совпадения\'',
  '  ...',
  '# Subtest: Проходит два',
  'ok 3 - Проходит два',
  '# Subtest: Второй известный провал',
  'not ok 4 - Второй известный провал',
  '# Subtest: Проходит три',
  'ok 5 - Проходит три',
  '1..5',
  '# tests 5',
  '# suites 0',
  '# pass 3',
  '# fail 2',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0'
].join('\n');

/** Карантинный прогон: два реестровых теста отфильтрованы → N2 = 3, падений нет. */
const RUN2_OK = [
  'TAP version 13',
  '# Subtest: Проходит раз',
  'ok 1 - Проходит раз',
  '# Subtest: Проходит два',
  'ok 2 - Проходит два',
  '# Subtest: Проходит три',
  'ok 3 - Проходит три',
  '1..3',
  '# tests 3',
  '# suites 0',
  '# pass 3',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0'
].join('\n');

const greenPair = (overrides = {}) => ({
  baseline: BASELINE_FIXTURE,
  run1: { exitCode: 1, tapText: RUN1_OK, signal: null },
  run2: { exitCode: 0, tapText: RUN2_OK, signal: null },
  ...overrides
});

test('scripts["test:raw"] разбирается как есть: TAP-репортёр добавляется, список файлов не дублируется', () => {
  const { command, args } = buildTestCommand(pkg);
  assert.equal(command, 'node');
  assert.ok(args.includes('--test'), 'команда запускает node --test');
  assert.equal(args.filter((arg) => arg.startsWith('--test-reporter=')).length, 1, 'ровно один TAP-репортёр');
  assert.ok(args.includes('--test-reporter=tap'));
  assert.equal(args.filter((arg) => arg === '--test-reporter').length, 0, 'отдельного --test-reporter нет');

  const scriptFiles = pkg.scripts[RAW_SCRIPT].trim().split(/\s+/).filter((arg) => /\.test\./.test(arg));
  assert.deepEqual(testFiles(args), scriptFiles, 'список файлов — ровно из test:raw');
  assert.equal(scriptFiles.length, 40, 'в списке 40 тест-файлов, включая модель туманности');
  assert.ok(scriptFiles.includes('tests/nebula-model.test.mjs'), 'модель туманности входит в полный прогон');
  assert.ok(scriptFiles.includes('tests/check-test-baseline.test.mjs'), 'self-test входит в полный прогон');
});

test('scripts["test:raw"] обязателен: без него страж не выдумывает список файлов', () => {
  assert.throws(() => buildTestCommand({ scripts: { test: 'node tools/check_test_baseline.mjs' } }),
    /test:raw/);
  assert.throws(() => buildTestCommand({ scripts: { 'test:raw': 'node tools/other.mjs' } }),
    /node --test/);
});

test('scripts.test вызывает стража, а не сам набор: единственный источник файлов — test:raw', () => {
  assert.equal(pkg.scripts.test, 'node tools/check_test_baseline.mjs');
  assert.ok(pkg.scripts[RAW_SCRIPT].startsWith('node --test '));
});

test('зелёная пара прогонов: 2/2 реестровых падения, N2 = N1 − 2, not ok 0 → exit 0', () => {
  const verdict = evaluateGuard(greenPair());
  assert.equal(verdict.code, 0, verdict.text);
  assert.equal(verdict.n1, 5);
  assert.equal(verdict.n2, 3);
  assert.match(verdict.text, /карантин этапа 8: прогон 1 — 2\/2 реестровых падений/);
  assert.match(verdict.text, /прогон 2 — отфильтровано 2, not ok 0; новых падений нет/);
  assert.match(verdict.text, /СТРАЖ: ОК/);
});

test('новое падение в прогоне 1: exit 1 и секция «НОВЫЕ ПАДЕНИЯ:» с именем', () => {
  const withNewFailure = RUN1_OK
    .replace('# Subtest: Проходит три', '# Subtest: Девятое падение вне реестра\nnot ok 5 - Девятое падение вне реестра')
    .replace('# tests 5', '# tests 5')
    .replace('# pass 3', '# pass 2')
    .replace('# fail 2', '# fail 3');
  const verdict = evaluateGuard(greenPair({ run1: { exitCode: 1, tapText: withNewFailure, signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /НОВЫЕ ПАДЕНИЯ:/);
  assert.match(verdict.text, /Девятое падение вне реестра/);
  assert.doesNotMatch(verdict.text, /СТРАЖ: ОК/);
});

test('устаревшее имя реестра (тест починен или переименован): exit 1, «КАРАНТИН НЕ ПРИМЕНЁН»', () => {
  const fixedOne = RUN1_OK
    .replace('not ok 2 - Первый известный провал', 'ok 2 - Первый известный провал')
    .replace('# pass 3', '# pass 4')
    .replace('# fail 2', '# fail 1');
  const verdict = evaluateGuard(greenPair({ run1: { exitCode: 1, tapText: fixedOne, signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КАРАНТИН НЕ ПРИМЕНЁН: устаревшие имена реестра/);
  assert.match(verdict.text, /Первый известный провал/);
  assert.deepEqual(verdict.staleBaseline, ['Первый известный провал']);
});

test('переименование теста: печатаются обе секции — новое имя и мёртвая запись реестра', () => {
  const renamed = RUN1_OK
    .replace('not ok 2 - Первый известный провал', 'not ok 2 - Первый известный провал (переименован)');
  const verdict = evaluateGuard(greenPair({ run1: { exitCode: 1, tapText: renamed, signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /НОВЫЕ ПАДЕНИЯ:/);
  assert.match(verdict.text, /КАРАНТИН НЕ ПРИМЕНЁН: устаревшие имена реестра/);
  assert.deepEqual(verdict.newFailures, ['Первый известный провал (переименован)']);
  assert.deepEqual(verdict.staleBaseline, ['Первый известный провал']);
});

test('not ok в карантинном прогоне (паттерн не сматчился): exit 1, «КАРАНТИН НЕ ПРИМЕНЁН»', () => {
  const dirtySecond = RUN2_OK
    .replace('ok 2 - Проходит два', 'not ok 2 - Второй известный провал')
    .replace('# pass 3', '# pass 2')
    .replace('# fail 0', '# fail 1');
  const verdict = evaluateGuard(greenPair({ run2: { exitCode: 1, tapText: dirtySecond, signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КАРАНТИН НЕ ПРИМЕНЁН: карантинный прогон не сошёлся/);
  assert.match(verdict.text, /not ok в карантинном прогоне/);
  assert.match(verdict.text, /Второй известный провал/);
});

test('арифметика N2 ≠ N1 − 2 (широкий или сломанный паттерн): exit 1 с числами', () => {
  // Отфильтровано три теста вместо двух: N1 = 5, N2 = 2.
  const tooNarrow = RUN2_OK
    .replace('# Subtest: Проходит три\n', '')
    .replace('ok 3 - Проходит три\n', '')
    .replace('1..3', '1..2')
    .replace('# tests 3', '# tests 2')
    .replace('# pass 3', '# pass 2');
  const verdict = evaluateGuard(greenPair({ run2: { exitCode: 0, tapText: tooNarrow, signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КАРАНТИН НЕ ПРИМЕНЁН/);
  assert.match(verdict.text, /N1 = 5, N2 = 2, ожидалось N2 = N1 − 2 = 3/);
});

test('крэш прогона 1: exit 1, сообщение о крэше, под реестр не маскируется', () => {
  const verdict = evaluateGuard(greenPair({ run1: { exitCode: null, tapText: 'TAP version 13\n', signal: 'SIGKILL' } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КРЭШ ПРОГОНА ТЕСТОВ \(прогон 1 из 2\)/);
  assert.match(verdict.text, /сигнал: SIGKILL/);
  assert.doesNotMatch(verdict.text, /СТРАЖ: ОК/);
});

test('крэш прогона 2: exit 1 и номер прогона в сообщении', () => {
  const verdict = evaluateGuard(greenPair({ run2: { exitCode: null, tapText: 'TAP version 13\n', signal: null } }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КРЭШ ПРОГОНА ТЕСТОВ \(прогон 2 из 2\)/);
});

test('полный прогон упал без TAP-падений — тоже красный: под реестр не подводится', () => {
  const verdict = evaluateGuard(greenPair({
    run1: { exitCode: 1, tapText: '# tests 0\n# fail 0\n# pass 0\n', signal: null }
  }));
  assert.equal(verdict.code, 1, verdict.text);
  assert.match(verdict.text, /КАРАНТИН НЕ ПРИМЕНЁН/);
});

test('экранирование спецсимволов: якоря ^…$ и полное совпадение', () => {
  assert.equal(escapeTapPattern('простое имя'), '^простое имя$');
  const pattern = escapeTapPattern('W26b п.3: m.11 (measureHypsometry) — ≤ 2 м, 45,93 %, #43533…·');
  assert.equal(pattern, '^W26b п\\.3: m\\.11 \\(measureHypsometry\\) — ≤ 2 м, 45,93 %, #43533…·$');
  // Паттерн — валидный regex и матчит только полное имя.
  const re = new RegExp(pattern);
  assert.ok(re.test('W26b п.3: m.11 (measureHypsometry) — ≤ 2 м, 45,93 %, #43533…·'));
  assert.ok(!re.test('W26b п.3: m.11 (measureHypsometry) — ≤ 2 м, 45,93 %, #43533…· и ещё хвост'),
    'частичное совпадение запрещено якорями');
  assert.ok(!re.test('префикс W26b п.3: m.11 (measureHypsometry) — ≤ 2 м, 45,93 %, #43533…·'));
});

test('экранирование реальных имён реестра: каждый паттерн матчит своё имя и не матчит соседнее', () => {
  for (const entry of baseline) {
    const re = new RegExp(escapeTapPattern(entry.name));
    assert.ok(re.test(entry.name), `${entry.name}: паттерн матчит полное имя`);
    assert.ok(!re.test(`${entry.name} (хвост)`), `${entry.name}: хвост не матчится`);
    assert.ok(!re.test(entry.name.slice(0, -1)), `${entry.name}: усечённое имя не матчится`);
  }
  const patterns = baseline.map((entry) => escapeTapPattern(entry.name));
  assert.equal(new Set(patterns).size, patterns.length, 'паттерны имён не совпадают между собой');
});

test('аргументы карантина: по одному флагу на имя реестра, флаги стоят ДО списка файлов', () => {
  const args = buildSkipArgs(['--test', 'tests/a.test.mjs', 'tests/b.test.mjs'], ['Имя (1)', 'Имя #2'], '--test-skip-pattern');
  assert.deepEqual(args, [
    '--test',
    '--test-skip-pattern=^Имя \\(1\\)$',
    '--test-skip-pattern=^Имя #2$',
    'tests/a.test.mjs',
    'tests/b.test.mjs'
  ], 'флаги после файлов раннер считает аргументами тестового процесса и молча игнорирует');
});

test('skip-флаг определяется по выводу node --help: предпочтение --test-skip, откат на -pattern', () => {
  const modern = '  --test-skip=...              skip tests whose name matches\n  --test-name-pattern=...\n';
  assert.equal(detectSkipFlag(modern).flag, '--test-skip');

  const node22 = '  --test-name-pattern=...     run tests whose name matches this\n' +
    '                              regular expression\n' +
    '  --test-skip-pattern=...     run tests whose name do not match this\n';
  assert.equal(detectSkipFlag(node22).flag, '--test-skip-pattern');

  const both = `${node22}  --test-skip=...              skip tests\n`;
  assert.equal(detectSkipFlag(both).flag, '--test-skip', 'предпочтение старшего флага');

  const none = '  --test-name-pattern=...  run tests whose name matches this\n';
  assert.equal(detectSkipFlag(none).flag, null, 'нет флага — ошибка окружения, а не молчаливый пропуск');
  assert.deepEqual(SKIP_FLAGS, ['--test-skip', '--test-skip-pattern']);
});

test('форматы TAP: плоский и вложенный дают одинаковые имена; обёртка файла отбрасывается', () => {
  const nested = [
    'TAP version 13',
    '# Subtest: tests/local-map.test.mjs',
    '    # Subtest: Stage-8.10b: контракт не тащит ядро',
    '    not ok 1 - Stage-8.10b: контракт не тащит ядро',
    '    1..1',
    'not ok 1 - tests/local-map.test.mjs',
    '1..1',
    '# tests 1',
    '# pass 0',
    '# fail 1'
  ].join('\n');
  const parsed = parseTap(nested);
  assert.ok(parsed.failures.includes('Stage-8.10b: контракт не тащит ядро'));
  assert.ok(parsed.failures.includes('tests/local-map.test.mjs'), 'обёртка файла — отдельное падение');
});

test('TAP-директива SKIP: пропущенный тест не считается ни падением, ни успехом', () => {
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
  assert.deepEqual(parsed.skipped, ['пропущен']);
  assert.equal(parsed.totals.skipped, 1);
  assert.equal(testCount(parsed), 2, 'число тестов берётся из # tests, иначе из плана');
});

test('раскодирование TAP-экранирования: `\\#` — это `#` из исходника теста', () => {
  assert.equal(decodeTapName('A-17 diagnostic: числа стыка и берега для \\#43533…\\#43537'),
    'A-17 diagnostic: числа стыка и берега для #43533…#43537');
  assert.equal(decodeTapName('без экранирования #43533'), 'без экранирования #43533');
});

test('сравнение с реестром: matched, новые и устаревшие имена считаются раздельно', () => {
  const comparison = compareWithBaseline(
    ['первый', 'третий'],
    [{ name: 'первый' }, { name: 'второй' }, { name: 'первый' }]
  );
  assert.deepEqual(comparison.newFailures, ['третий']);
  assert.deepEqual(comparison.staleBaseline, ['второй']);
  assert.equal(comparison.matched, 1);
});

test('гигиена реестра: блок meta намеренного карантина, 8 записей с reason, файлы на месте', () => {
  assert.match(registry.meta.purpose, /намеренный временный карантин/);
  assert.equal(registry.meta.date, '2026-10-26', 'дата решения владельца');
  assert.ok(registry.meta.references.some((ref) => ref.includes('S8-Q1')), 'ссылка на пункт S8-Q1');
  assert.ok(registry.meta.references.some((ref) => ref.includes('CI-2')), 'ссылка на карточку CI-2');
  assert.match(registry.meta.removal, /починить/);
  assert.match(registry.meta.removal, /S8-Q1/);

  assert.equal(baseline.length, 8, 'в карантине ровно 8 записей');
  for (const entry of baseline) {
    assert.equal(entry.contour, 'планетарный', `${entry.name}: контур планетарный`);
    assert.ok(existsSync(path.join(ROOT, entry.file)), `${entry.name}: файл ${entry.file} существует`);
    assert.ok(entry.file.startsWith('tests/'), `${entry.name}: реестр ссылается на тест`);
    assert.doesNotMatch(entry.name, /сектор|атлас|sector|atlas/i, `${entry.name}: имена сектора и атласа в реестр не входят`);
    assert.ok(entry.knownSince.trim().length > 0, `${entry.name}: указан этап появления долга`);
    assert.ok(entry.reason.trim().length > 10, `${entry.name}: поле reason объясняет долг`);
  }
  assert.equal(new Set(baseline.map((entry) => entry.name)).size, baseline.length, 'имена в реестре не повторяются');
});
