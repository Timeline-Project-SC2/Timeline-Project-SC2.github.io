import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { transform } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const gateSource = read('src/atlas/sector-admin-gate.ts');
const gateModule = await transform(gateSource, { loader: 'ts', format: 'esm' });
const gateApi = await import(`data:text/javascript;base64,${Buffer.from(gateModule.code).toString('base64')}`);
const publicTestCode = gateApi.PUBLIC_TEST_CODE;

test('форма принимает только публичное демонстрационное значение', () => {
  assert.equal(typeof publicTestCode, 'string');
  assert.equal(gateApi.isCorrectPublicTestCode(publicTestCode), true);
  assert.equal(gateApi.isCorrectPublicTestCode(`  ${publicTestCode}  `), true);
  assert.equal(gateApi.isCorrectPublicTestCode('неверно'), false);
  assert.match(read('tools/vite/atlas-shell.ts'), /type="password" autocomplete="off"/);
});

test('неверный ввод блокирует подтверждение до изменения и разрешает новую попытку', () => {
  const attempt = gateApi.createGateAttemptController();
  assert.equal(attempt.submit('неверно'), 'invalid');
  assert.equal(attempt.submit(publicTestCode), 'locked');
  attempt.inputChanged();
  assert.equal(attempt.submit(publicTestCode), 'granted');
  assert.match(gateSource, /submit\.disabled = true/);
  assert.match(gateSource, /attempt\.inputChanged\(\)/);
  assert.match(gateSource, /error\.hidden = false/);
});

test('во вкладке хранится только несекретная отметка; сбой хранилища не ломает страницу', () => {
  const key = gateApi.ADMIN_SESSION_MARKER_KEY;
  const values = new Map([[key, 'granted']]);
  assert.equal(gateApi.hasAdminSessionMarker({ getItem: (candidate) => values.get(candidate) ?? null }), true);
  assert.equal(gateApi.hasAdminSessionMarker({ getItem: () => 'wrong-value' }), false);
  assert.equal(gateApi.hasAdminSessionMarker(null), false);
  assert.equal(gateApi.hasAdminSessionMarker({ getItem() { throw new Error('blocked'); } }), false);
  assert.match(gateSource, /setItem\(ADMIN_SESSION_MARKER_KEY, ADMIN_SESSION_MARKER_VALUE\)/);
  assert.doesNotMatch(gateSource, /setItem\([^\n]*(?:input\.value|PUBLIC_TEST_CODE)/);
});

test('прямой маршрут рендерит ту же карту с закрытыми панелью и формой барьера', () => {
  const route = read('site/sector/admin-edit/index.html');
  const template = read('templates/atlas-shell.html');
  const variant = read('tools/vite/atlas-shell.ts');
  const config = read('vite.config.mts');
  const verifier = read('tools/verify_feature_parity.mjs');
  assert.match(route, /atlas-variant: admin-edit/);
  assert.match(config, /sector\/admin-edit\/index\.html/);
  assert.match(verifier, /sector\/admin-edit\/index\.html/);
  assert.match(template, /id="mapCanvas"/);
  assert.match(template, /@@ADMIN_EDITOR_PANEL@@/);
  assert.match(variant, /id="adminGateForm"/);
  assert.match(variant, /id="adminEditorPanel"[^\n]* hidden/);
  assert.match(variant, /Модули/);
  assert.match(variant, /Свойства/);
  assert.match(variant, /Изменения/);
  assert.match(variant, /не сохраняются и не отправляются/);
});

test('админ-кнопка стоит между «О карте» и возвратом, а минимальный вариант её не получает', () => {
  const template = read('templates/atlas-shell.html');
  const variants = read('src/atlas/atlas-variants.ts');
  const helpAt = template.indexOf('id="helpButton"');
  const adminAt = template.indexOf('@@ADMIN_GATE@@');
  const galaxyAt = template.indexOf('@@GALAXY_RETURN@@');
  assert.ok(helpAt >= 0 && helpAt < adminAt && adminAt < galaxyAt);
  assert.match(variants, /sector:\s*\{[\s\S]*?adminGate: ['"]\s*<button class="admin-gate-link" id="adminGateOpen" type="button"/);
  assert.match(variants, /minimal:\s*\{\s*adminEditorPanel: '',\s*adminGate: '',\s*adminGatePanel: ''/);
  assert.match(variants, /adminGate: ''/);
  assert.match(variants, /data-admin-gate-destination="\/sector\/admin-edit\/"/);
  assert.match(variants, /id="adminEditorGate" role="dialog"[\s\S]*?data-admin-gate-modal hidden/);
});

test('ссылка доступна в мобильной горизонтальной шапке и отключает мигание при reduced motion', () => {
  const css = read('site/shared/timeline-skin.css');
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.topbar\s*\{[\s\S]*?overflow-x: auto/);
  assert.match(css, /\.admin-gate-link\s*\{[\s\S]*?min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.admin-gate-link\s*\{ animation: none; \}/);
});

test('ввод и Escape внутри демо-панели изолированы от клавиш карты', () => {
  const app = read('src/atlas/app.ts');
  assert.match(app, /isAdminUiTarget\(event\.target\) \|\| tag === 'input'/);
  assert.match(gateSource, /target\.closest\('#adminEditorGate, \[data-admin-editor\]'\)/);
});

test('кнопка только открывает модалку; переход на редактор происходит после совпадения кода и подтверждения', () => {
  const variants = read('src/atlas/atlas-variants.ts');
  const gate = read('src/atlas/sector-admin-gate.ts');
  const template = read('templates/atlas-shell.html');
  assert.match(variants, /id="adminGateOpen" type="button"/);
  assert.ok(variants.includes('id="adminEditorGate" role="dialog" aria-modal="true" aria-labelledby="adminGateTitle" data-admin-gate-modal hidden'));
  assert.ok(variants.includes('data-admin-gate-destination="/sector/admin-edit/"'));
  assert.match(template, /@@ADMIN_GATE_PANEL@@/);
  assert.match(gate, /if \(result === 'invalid'\)[\s\S]*?return;/);
  assert.match(gate, /if \(destination\)[\s\S]*?target\.searchParams\.set\(ADMIN_ACCESS_QUERY_PARAM, 'confirmed'\)[\s\S]*?view\.location\.assign\(target\.href\)/);
  assert.match(gate, /if \(modalGate\)[\s\S]*?openButton\.addEventListener\('click'[\s\S]*?gate\.hidden = false/);
});

test('успешная отправка включает красную тему и показывает подпись в стиле ошибки галактики', () => {
  const css = read('site/shared/timeline-skin.css');
  const theme = read('site/sector/admin-edit/admin-edit.css');
  assert.match(gateSource, /const ADMIN_SUCCESS_MESSAGE = 'Доступ Администратора получен\. Права расширены\.'/);
  assert.match(gateSource, /showAdminNotice\(doc, ADMIN_SUCCESS_MESSAGE, ADMIN_ACCESS_NOTICE_CLASS\)/);
  assert.match(gateSource, /doc\.documentElement\.classList\.add\('admin-editor-authorized'\)/);
  assert.match(gateSource, /onAuthorized\(\)/);
  assert.match(theme, /:root\.admin-editor-authorized\s*\{[\s\S]*?--white: #fff1f3/);
  assert.match(css, /\.toast\.admin-access-notice\s*\{[\s\S]*?top: 33\.33vh[\s\S]*?rgba\(255, 70, 70, \.7\)/);
  assert.match(css, /\.admin-editor-authorized \.toast\.admin-access-notice\.is-done \.galaxy-error-dot/);
});

test('крестик окна доступа закрывает его наравне с подложкой и Escape', () => {
  const variants = read('src/atlas/atlas-variants.ts');
  const gate = read('src/atlas/sector-admin-gate.ts');
  assert.match(variants, /id="adminGateClose"[^>]*data-admin-gate-close/);
  assert.match(gate, /closest\('\[data-admin-gate-close\]'\)/);
  assert.match(gate, /closeModal\(true\)/);
});

test('«Завершить сеанс» стоит там же, где кнопка входа, и появляется только в сеансе', () => {
  const variant = read('tools/vite/atlas-shell.ts');
  const template = read('templates/atlas-shell.html');
  const gate = read('src/atlas/sector-admin-gate.ts');
  assert.match(variant, /class="admin-gate-link admin-session-end" id="adminSessionEnd" type="button" data-admin-session-return="\/sector\/" hidden>Завершить сеанс<\/button>/);
  assert.match(template, /@@ADMIN_GATE@@/);
  assert.match(gate, /const ADMIN_SESSION_END_MESSAGE = 'Сеанс завершён\. Администрирование окончено\.'/);
  assert.match(gate, /endButton\.hidden = true/);
  assert.match(gate, /storage\.removeItem\(ADMIN_SESSION_MARKER_KEY\)/);
  assert.match(gate, /classList\.remove\('admin-editor-authorized'\)/);
  assert.match(gate, /showAdminNotice\(doc, ADMIN_SESSION_END_MESSAGE, ADMIN_SESSION_END_NOTICE_CLASS\)/);
  assert.match(gate, /ADMIN_SESSION_END_NOTICE_CLASS = 'admin-session-end-notice'/);
});

test('красная тема разделена: шрифты, топ-панель и визуальный слой, без перекраса модулей', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  const block = /:root\.admin-editor-authorized\s*\{([\s\S]*?)\n\}/.exec(css)[1];
  // Переопределены только текстовые токены: окантовка, линии и панели не тронуты.
  for (const token of ['--accent', '--line-strong', '--panel', '--timeline-cyan', '--bg-2']) {
    assert.doesNotMatch(block, new RegExp(`\\${token}:`), `${token} не должен переопределяться`);
  }
  assert.match(block, /--text: #ead7dc/);
  assert.match(block, /--topbar-line: rgba\(212, 112, 133/);
  assert.match(block, /--topbar-bg: rgba\(17, 9, 13/);
  assert.match(block, /--admin-topbar-ink:/);
  assert.match(block, /--admin-stage-core:/);
  assert.match(block, /--admin-grid-major:/);
  // Модули и органы управления картой остаются в обычной стилистике.
  assert.doesNotMatch(css, /\.admin-editor-authorized \.map-control/);
  assert.doesNotMatch(css, /\.admin-editor-authorized \.panel,/);
  assert.doesNotMatch(css, /\.admin-editor-authorized \.admin-editor-panel \{ border-color/);
  // Три слоя описаны явно и по отдельности.
  assert.match(css, /\/\* 3\. Визуальный слой/);
  assert.match(css, /\/\* 2\. Топ-панель/);
  assert.match(css, /\/\* 1\. Шрифты/);
});

test('уведомление о завершении сеанса — цветом интерфейса и без привязки к красной теме', () => {
  const css = read('site/shared/timeline-skin.css');
  const notice = /\.toast\.admin-session-end-notice \{([\s\S]*?)\n\}/.exec(css)[1];
  assert.doesNotMatch(notice, /#ff5a5a|rgba\(255, 70, 70/);
  assert.match(notice, /color: #cffffb/);
  assert.match(notice, /rgba\(46, 245, 230, \.7\)/);
  assert.match(css, /\.toast\.admin-session-end-notice\.is-done \.galaxy-error-dot/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?admin-session-end-notice/);
});

test('выход из сеанса возвращает на карту сектора и печатает уведомление там', () => {
  const variant = read('tools/vite/atlas-shell.ts');
  const gate = read('src/atlas/sector-admin-gate.ts');
  assert.match(variant, /id="adminSessionEnd" type="button" data-admin-session-return="\/sector\/"/);
  assert.match(gate, /ADMIN_SESSION_END_QUERY_PARAM = 'adminSession'/);
  assert.match(gate, /ADMIN_SESSION_END_QUERY_VALUE = 'ended'/);
  assert.match(gate, /target\.searchParams\.set\(ADMIN_SESSION_END_QUERY_PARAM, ADMIN_SESSION_END_QUERY_VALUE\)/);
  assert.match(gate, /if \(takeAdminSessionEndQuery\(doc\)\)[\s\S]*?ADMIN_SESSION_END_NOTICE_CLASS/);
  assert.match(gate, /url\.searchParams\.delete\(ADMIN_SESSION_END_QUERY_PARAM\)/);
});

test('общий скин разделяет окантовку, цвет текста и границы топ-панели', () => {
  const skin = read('site/shared/styles.css');
  const root = /:root \{([\s\S]*?)\n\}/.exec(skin)[1];
  assert.match(root, /--accent: #b5d3fa/);
  assert.match(root, /--accent-outline: #b5d3fa/);
  assert.match(root, /--topbar-line: rgba\(172, 194, 221, \.28\)/);
  assert.match(root, /--topbar-bg: rgba\(5, 10, 17, \.92\)/);
  // Топ-панель не зависит от линий панелей.
  assert.match(skin, /\.topbar \{[^}]*background: var\(--topbar-bg\)[^}]*border: 1px solid var\(--topbar-line\)/);
  assert.doesNotMatch(skin, /\.topbar \{[^}]*var\(--line-strong\)/);
  // Окантовка (обводки и штрихи) отделена от цвета текста.
  assert.match(skin, /button:focus-visible, input:focus-visible, a:focus-visible \{ outline: 1px solid var\(--accent-outline\)/);
  assert.match(skin, /\.brand-emblem svg \{[^}]*stroke: var\(--accent-outline\)/);
  assert.match(skin, /\.confidence-dot \{[^}]*background: var\(--accent-outline\)/);
});
