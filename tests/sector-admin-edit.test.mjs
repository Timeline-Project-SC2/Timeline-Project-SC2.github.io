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
  assert.match(variants, /sector:\s*\{[\s\S]*?adminGate: ['"]\s*<a class="admin-gate-link"/);
  assert.match(variants, /minimal:\s*\{\s*adminEditorPanel: '',\s*adminGate: ''/);
  assert.match(variants, /adminGate: ''/);
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

test('успешная отправка включает красную тему и показывает подпись в стиле ошибки галактики', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(gateSource, /const ADMIN_SUCCESS_MESSAGE = 'Доступ Администратора получен\. Права расширены\.'/);
  assert.match(gateSource, /showAdminAccessNotice\(doc\)/);
  assert.match(gateSource, /doc\.documentElement\.classList\.add\('admin-editor-authorized'\)/);
  assert.match(gateSource, /onAuthorized\(\)/);
  assert.match(css, /:root\.admin-editor-authorized\s*\{[\s\S]*?--accent: #d9889a/);
  assert.match(css, /\.toast\.admin-access-notice\s*\{[\s\S]*?top: 33\.33vh[\s\S]*?rgba\(255, 70, 70, \.7\)/);
  assert.match(css, /\.admin-editor-authorized \.toast\.admin-access-notice\.is-done \.galaxy-error-dot/);
});
