/* Редактор границ: интерфейс админской копии сектора (шаг 2 §11 части 2).
 *
 * Проверяются чистые утилиты панели (прореживание мазка, журнал, материал
 * заявки), жизненный цикл редактора на заглушках ядра и хранилища, а также
 * разметка панели: три якоря блоков и стили под них.
 * Запуск: node --test tests/sector-areas-editor-ui.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createArea, emptySectorAreasDoc, parseSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { helpTitle, markdownToHtml } from '../src/atlas/sector-areas-help.ts';
import {
  CLICK_POINTS,
  DRAFT_KEY,
  MIN_STEP_PX,
  PANEL_KEY,
  createDefaultState,
  createSectorAreasEditorUi,
  eventLine,
  isDrawButton,
  parseExported,
  requestMaterial,
  strokePoints,
} from '../src/atlas/sector-areas-editor-ui.ts';
import { addAreaFromStroke, createEditorSession, exportDoc } from '../src/atlas/sector-areas-editor.ts';

const root = new URL('..', import.meta.url);
const read = (relative) => readFileSync(new URL(relative, root), 'utf8');

const SQUARE = [[1000, 1000], [4000, 1000], [4000, 4000], [1000, 4000], [1000, 1000]];

/** Заглушка хранилища: черновик живёт в памяти теста. */
function fakeStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

/** Заглушка ядра: состояние карты и рендер без DOM. */
function fakeKernel(doc) {
  const state = { sectorAreas: doc };
  let renders = 0;
  return {
    state,
    renderer: {
      requestRender() { renders += 1; },
      toWorld(x, y) { return { x, y }; },
    },
    renders() { return renders; },
  };
}

const docWithArea = () => parseSectorAreas({
  ...emptySectorAreasDoc(),
  areas: [{ ...createArea({ id: 'area-1', name: 'Область 1', rings: [SQUARE] }) }],
});

test('прореживание мазка убирает точки ближе порога, но держит концы', () => {
  const raw = [[0, 0], [1, 0], [2, 0], [30, 0], [31, 0], [80, 0]];
  const kept = strokePoints(raw, 10);
  assert.deepEqual(kept, [[0, 0], [30, 0], [80, 0]]);
  // Порог взят из модуля: это пиксели экрана, а не мировые единицы.
  assert.equal(MIN_STEP_PX, 6);
});

test('рисовать разрешено только левой кнопкой: правая и средняя — карте', () => {
  assert.equal(isDrawButton(0), true);
  assert.equal(isDrawButton(1), false, 'средняя кнопка — панорама');
  assert.equal(isDrawButton(2), false, 'правая кнопка — контекст карты');
  // Щелчок без движения — выбор области, а не контур из одной точки.
  assert.equal(CLICK_POINTS, 3);
});

test('область, созданная кистью, сразу получает состояние и видна на карте', () => {
  const session = createEditorSession(emptySectorAreasDoc());
  const next = addAreaFromStroke(session, {
    id: 'area-1',
    name: 'Область 1',
    points: SQUARE,
    closed: true,
    state: createDefaultState('state-area-1', 'political'),
  });
  assert.equal(next.doc.areas.length, 1);
  const area = next.doc.areas[0];
  assert.equal(area.states.length, 1, 'без состояния область остаётся невидимой');
  assert.equal(area.states[0].mode, 'political');
  assert.equal(area.states[0].visibleFrom, 0);
  assert.equal(area.states[0].visibleTo, 12);
  // Создание и показ — одна запись журнала, то есть одна отмена.
  assert.equal(next.doc.events.length, 1);
});

test('прореживание не трогает пустой мазок и отключается нулевым порогом', () => {
  assert.deepEqual(strokePoints([], 10), []);
  const raw = [[0, 0], [1, 0], [2, 0]];
  assert.deepEqual(strokePoints(raw, 0), raw);
});

test('строка журнала собирается из вида, области и комментария', () => {
  assert.equal(
    eventLine({ id: 'ev-1', kind: 'override', areaId: 'area-1', mode: 'political', note: 'закрасил' }),
    'override · area-1 · закрасил',
  );
  assert.equal(
    eventLine({ id: 'ev-2', kind: 'create', areaId: null, mode: null, note: null }),
    'create · без комментария',
  );
});

test('материал заявки содержит журнал, состав и сам документ', () => {
  const doc = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{ ...createArea({ id: 'area-1', name: 'Область 1', rings: [SQUARE] }) }],
    events: [{ id: 'ev-1', kind: 'create', areaId: 'area-1', mode: 'political', note: 'первая область' }],
  });
  const text = requestMaterial(doc);
  assert.match(text, /^# Области сектора: изменения границ/);
  assert.match(text, /## Что изменилось/);
  assert.match(text, /create · area-1 · первая область/);
  assert.match(text, /## Состав документа/);
  assert.match(text, /- Областей: 1/);
  assert.match(text, /## Проверки/);
  assert.match(text, /npm test/);
  assert.match(text, /```json/);
  assert.match(text, /"id": "area-1"/);
});

test('материал заявки не падает на пустом журнале', () => {
  const text = requestMaterial(emptySectorAreasDoc(), { title: 'Пустая заявка' });
  assert.match(text, /^# Пустая заявка/);
  assert.match(text, /Журнал пуст/);
  assert.match(text, /- Областей: 0/);
});

test('выгруженный документ разбирается обратно тем же валидатором', () => {
  const doc = docWithArea();
  // `exportDoc` берёт сессию: документ выгружается вместе с журналом.
  const json = exportDoc(createEditorSession(doc));
  const back = parseExported(json);
  assert.deepEqual(back, doc);
});

test('редактор поднимается на заглушках и отдаёт документ наружу', () => {
  const kernel = fakeKernel(docWithArea());
  const api = createSectorAreasEditorUi({ kernel, panel: null, canvas: null, storage: fakeStorage() });
  assert.equal(api.enabled(), false);
  assert.equal(api.session().doc.areas.length, 1);

  api.setEnabled(true);
  assert.equal(api.enabled(), true);

  const json = api.exportJson();
  assert.equal(JSON.parse(json).areas.length, 1);

  api.destroy();
  api.setEnabled(false);
  assert.equal(api.enabled(), false);
});

test('черновик переживает пересоздание редактора', () => {
  const storage = fakeStorage();
  const first = createSectorAreasEditorUi({ kernel: fakeKernel(docWithArea()), panel: null, canvas: null, storage });
  assert.equal(first.draft.save(), true);
  assert.match(first.draft.info(), /Черновик сохранён/);
  assert.ok(storage.values.has(DRAFT_KEY));

  const kernel = fakeKernel(emptySectorAreasDoc());
  const second = createSectorAreasEditorUi({ kernel, panel: null, canvas: null, storage });
  assert.equal(second.doc().areas.length, 0);
  assert.equal(second.draft.load(), true);
  assert.equal(second.doc().areas.length, 1);
  // Документ ушёл в состояние карты — рендер читает его оттуда же, что и `/sector/`.
  assert.equal(kernel.state.sectorAreas.areas.length, 1);
  assert.ok(kernel.renders() > 0);

  second.draft.clear();
  assert.equal(storage.values.has(DRAFT_KEY), false);
  assert.match(second.draft.info(), /Черновик не сохранялся/);
});

test('без хранилища черновик недоступен, но редактор работает', () => {
  const kernel = fakeKernel(docWithArea());
  const api = createSectorAreasEditorUi({ kernel, panel: null, canvas: null, storage: null });
  assert.equal(api.draft.save(), false);
  assert.equal(api.draft.load(), false);
  assert.match(api.draft.info(), /нет локального хранилища/);
  assert.equal(api.doc().areas.length, 1);
  api.destroy();
});

test('справка превращает разметку файла в HTML без исполняемого кода', () => {
  const html = markdownToHtml([
    '# Заголовок',
    '',
    'Обычный абзац с `кодом` и **жирным**.',
    '',
    '- первый пункт',
    '- второй пункт',
    '',
    '| Колонка | Значение |',
    '|---|---|',
    '| режим | политический |',
    '',
    '```',
    'npm test',
    '```',
    '',
    'Ссылка: [индекс](README.md) и [сайт](https://example.org).',
  ].join('\n'));

  assert.match(html, /<h2>Заголовок<\/h2>/);
  assert.match(html, /<p>Обычный абзац с <code>кодом<\/code> и <strong>жирным<\/strong>\.<\/p>/);
  assert.match(html, /<ul><li>первый пункт<\/li><li>второй пункт<\/li><\/ul>/);
  assert.match(html, /<th>Колонка<\/th>/);
  assert.match(html, /<td>политический<\/td>/);
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
  // Ссылка на файл репозитория остаётся текстом, внешняя — настоящей ссылкой.
  assert.doesNotMatch(html, /href="README\.md"/);
  assert.match(html, /<a href="https:\/\/example\.org"/);
  // Ничего исполняемого: разметка экранируется.
  assert.equal(markdownToHtml('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('справка на сайте — тот же файл, что лежит в docs/admins', () => {
  const markdown = read('docs/admins/sector-areas-editor.md');
  const html = markdownToHtml(markdown);
  assert.equal(helpTitle(markdown), 'Редактор границ сектора — руководство администратора');
  // Весь объём доезжает до окна: разделы «как должно / как не должно».
  assert.match(html, /Как должно работать и как не должно/);
  assert.match(html, /<strong>Должно:<\/strong>/);
  assert.match(html, /<strong>Не должно:<\/strong>/);
  assert.match(html, /Порядок работы/);
  assert.match(html, /Чего в редакторе нет/);
  // Навигация репозитория в окно не попадает.
  assert.doesNotMatch(html, /Назад: <a/);
  // Файл подключён в сборку как текст: второй копии в исходниках нет.
  assert.match(read('src/atlas/app.ts'), /docs\/admins\/sector-areas-editor\.md\?raw/);
});

test('ключи хранилища разделяют черновик и состояние панели', () => {
  assert.notEqual(DRAFT_KEY, PANEL_KEY);
  assert.match(DRAFT_KEY, /^timeline\.sector-areas\./);
  assert.match(PANEL_KEY, /^timeline\.sector-areas\./);
});

test('панель администратора держит три якоря блоков редактора', () => {
  const variant = read('tools/vite/atlas-shell.ts');
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(variant, /data-editor-block="modules"/);
  assert.match(variant, /data-editor-block="properties"/);
  assert.match(variant, /data-editor-block="changes"/);
  // Заголовки разделов остались: на них опираются прежние проверки.
  assert.match(variant, /Модули/);
  assert.match(variant, /Свойства/);
  assert.match(variant, /Изменения/);
  assert.match(css, /\.admin-editor-log/);
  assert.match(css, /#mapCanvas\.editor-drawing/);
  // Кнопка «?» в шапке: справка открывается поверх карты.
  assert.match(variant, /class="admin-editor-help icon-button"/);
  assert.match(variant, /data-action="help"/);
  assert.match(css, /\.admin-editor-help-backdrop\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.admin-editor-help-dialog \{/);
  // Свёрнутая панелька: рейл, пять стрелочек и скрытое тело.
  assert.match(variant, /class="admin-editor-rail"/);
  assert.match(variant, /data-action="expand"/);
  assert.match(variant, /data-action="collapse"/);
  assert.match(variant, /id="adminEditorBody"/);
  assert.equal((variant.match(/<i><\/i>/g) ?? []).length, 5, 'ровно пять стрелочек');
  assert.match(css, /\.admin-editor-panel\.is-collapsed/);
  assert.match(css, /@keyframes admin-rail-arrow/);
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.admin-editor-rail-arrows i \{ animation: none/);
  // Левая панель каталога перекрашена в красноватую тему администратора.
  assert.match(css, /\.admin-editor-authorized \.left-panel \{/);
  assert.match(css, /--line-strong: rgba\(218, 128, 149, \.46\)/);
});

test('редактор подключается только там, где есть панель администратора', () => {
  const app = read('src/atlas/app.ts');
  const variant = read('tools/vite/atlas-shell.ts');
  // Перехват рисования вешается на стадию: она родитель канвы, поэтому её
  // фаза перехвата срабатывает раньше обработчиков панорамы на самой канве.
  assert.match(app, /stage: el\.mapStage/);
  assert.match(app, /canvas: el\.mapCanvas/);
  assert.match(app, /qs<HTMLElement>\('\[data-admin-editor\]'\)/);
  // Якорь есть только в варианте `admin-edit`: публичный `/sector/` не трогаем.
  assert.match(variant, /data-admin-editor/);
  const sectorVariant = /const sector[\s\S]*?adminEditorPanel: '([\s\S]*?)'/.exec(read('src/atlas/atlas-variants.ts'));
  assert.equal(sectorVariant === null || !/data-editor-block/.test(sectorVariant[1]), true);
});
