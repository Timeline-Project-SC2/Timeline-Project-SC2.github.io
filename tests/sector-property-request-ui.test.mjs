// Публичный путь игрока: кнопка в досье, «Мои заявки», честные статусы.
// Браузерная приёмка владельцем остаётся отдельной; здесь проверяются проводка и текста.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { renderAtlasVariant } from '../tools/vite/atlas-shell.ts';

const require = createRequire(import.meta.url);
const { requestStatusLabel, changeLine } = require('../src/atlas/sector-property-request-ui.ts');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('статусы не обещают применение и не выдумывают решение владельца', () => {
  assert.equal(requestStatusLabel({ status: 'prepared', issueState: null }), 'Подготовлена, не отправлена');
  assert.equal(requestStatusLabel({ status: 'reserved', issueState: null }), 'Отправка не подтверждена; повторите ту же версию');
  assert.equal(requestStatusLabel({ status: 'created', issueState: 'open' }), 'Создана, ждёт чтения владельцем');
  assert.equal(requestStatusLabel({ status: 'created', issueState: 'closed' }), 'Нить закрыта; это не доказывает применение');
});

test('строка изменения читаема и не содержит HTML', () => {
  const line = changeLine({ dataset: 'systems', recordId: '1', field: 'description', before: '<старое>', after: 'Новое' });
  assert.equal(line, 'Система 1 · Описание: <старое> → Новое');
});

test('кнопка «Предложить правку» есть в досье системы и места', () => {
  const dossier = read('src/atlas/dossier-card.ts');
  assert.match(dossier, /data-action="propose">Предложить правку<\/button>/);
  assert.match(dossier, /kernel\.propertyRequest\?\.open\('places', state\.activePlanetId\)/);
  assert.match(dossier, /kernel\.propertyRequest\?\.open\('systems', state\.activeSystemId\)/);
});

test('«Мои заявки» стоят в панели редактора, а не в публичной шапке сектора и минимального скина', () => {
  const variants = read('src/atlas/atlas-variants.ts');
  const template = read('templates/atlas-shell.html');
  const shell = read('tools/vite/atlas-shell.ts');
  assert.match(template, /@@PROPERTY_REQUESTS@@/);
  assert.match(shell, /PROPERTY_REQUESTS: variant\.propertyRequests/);
  assert.match(variants, /sector:\s*\{[\s\S]*?propertyRequests: ''/);
  assert.match(variants, /minimal:\s*\{[\s\S]*?propertyRequests: ''/);
  const panel = /adminEditorPanel: \[([\s\S]*?)\]\.join\('\\n'\)/.exec(shell)?.[1] ?? '';
  assert.match(panel, /id="propertyRequestsOpen"[^>]*>Мои заявки<\/button>/);
  assert.ok(panel.indexOf('admin-editor-heading-tools') < panel.indexOf('id="propertyRequestsOpen"'));
  assert.ok(panel.indexOf('id="propertyRequestsOpen"') < panel.indexOf('id="adminEditorHelp"'));
  assert.doesNotMatch(template, /id="propertyRequestsOpen"/);
  const templatePath = fileURLToPath(new URL('../templates/atlas-shell.html', import.meta.url));
  for (const route of ['site/sector/index.html', 'site/minimal/minimal.html']) {
    assert.doesNotMatch(renderAtlasVariant(read(route), templatePath), /id="propertyRequestsOpen"/);
  }
  const admin = renderAtlasVariant(read('site/sector/admin-edit/index.html'), templatePath);
  assert.equal(admin.match(/id="propertyRequestsOpen"/g)?.length, 1);
  const renderedPanel = /<aside[^>]*id="adminEditorPanel"[^>]*>[\s\S]*?<\/aside>/.exec(admin)?.[0] ?? '';
  assert.match(renderedPanel, /admin-editor-heading-tools[\s\S]*?id="propertyRequestsOpen"[^>]*>Мои заявки<\/button>[\s\S]*?id="adminEditorHelp"/);
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /#adminEditorPanel \.admin-editor-requests-open\s*\{[^}]*min-height: 44px/);
});

test('возврат OAuth ?requests=1 открывает список, а форма отправляет только подтверждённый серверный текст', () => {
  const ui = read('src/atlas/sector-property-request-ui.ts');
  const app = read('src/atlas/app.ts');
  assert.match(app, /createSectorPropertyRequestUi\(kernel\)/);
  assert.match(ui, /getElementById\('propertyRequestsOpen'\)\?\.addEventListener\('click', openRequests\)/);
  assert.match(ui, /if \(new URLSearchParams\(location\.search\)\.get\('requests'\) === '1'\) openRequests\(\)/);
  assert.match(ui, /preparePropertySubmission/);
  assert.match(ui, /submitPropertyPacket/);
  assert.match(ui, /edit\.confirmed && !busy/);
  assert.match(ui, /Сервер добавил автора и время/);
  assert.match(ui, /target="_blank" rel="noopener"/);
});
