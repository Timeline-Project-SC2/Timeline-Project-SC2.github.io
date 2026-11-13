// Публичный путь игрока: кнопка в досье, «Мои заявки», честные статусы.
// Браузерная приёмка владельцем остаётся отдельной; здесь проверяются проводка и текста.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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

test('«Мои заявки» доступны на секторе и в админской копии, но не в минимальном скине', () => {
  const variants = read('src/atlas/atlas-variants.ts');
  const template = read('templates/atlas-shell.html');
  const shell = read('tools/vite/atlas-shell.ts');
  assert.match(template, /@@PROPERTY_REQUESTS@@/);
  assert.match(shell, /PROPERTY_REQUESTS: variant\.propertyRequests/);
  assert.match(variants, /id="propertyRequestsOpen"[^>]*>Мои заявки<\/button>/);
  assert.match(variants, /minimal:\s*\{[\s\S]*?propertyRequests: ''/);
});

test('возврат OAuth ?requests=1 открывает список, а форма отправляет только подтверждённый серверный текст', () => {
  const ui = read('src/atlas/sector-property-request-ui.ts');
  const app = read('src/atlas/app.ts');
  assert.match(app, /createSectorPropertyRequestUi\(kernel\)/);
  assert.match(ui, /get\('requests'\) === '1'/);
  assert.match(ui, /preparePropertySubmission/);
  assert.match(ui, /submitPropertyPacket/);
  assert.match(ui, /edit\.confirmed && !busy/);
  assert.match(ui, /Сервер добавил автора и время/);
  assert.match(ui, /target="_blank" rel="noopener"/);
});
