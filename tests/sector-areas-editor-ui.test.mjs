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

import { createArea, emptySectorAreasDoc, parseSectorAreas, validateSectorAreas } from '../src/atlas/sector-areas-contract.ts';
import { helpTitle, markdownToHtml } from '../src/atlas/sector-areas-help.ts';
import {
  CLICK_POINTS,
  DRAFT_KEY,
  MIN_STEP_PX,
  PANEL_KEY,
  createDefaultState,
  createSectorAreasEditorUi,
  editorHotkey,
  eventLine,
  historyNotice,
  isDrawButton,
  lastEventNote,
  moduleGraphHtml,
  parseExported,
  requestMaterial,
  strokePoints,
} from '../src/atlas/sector-areas-editor-ui.ts';
import { addAreaFromSectorCell, addAreaFromStroke, canFillArea, createEditorSession, exportDoc } from '../src/atlas/sector-areas-editor.ts';
import { TOOL_IDS } from '../src/atlas/sector-areas-tools.ts';
import {
  MODULE_RELATIONS,
  PLANE_TITLES,
  SECTOR_MODULES,
  STATUS_TITLES,
  documentReport,
  moduleById,
  moduleRows,
} from '../src/atlas/sector-areas-registry.ts';

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
  // Каталог наследует обычную палитру сектора.
  assert.doesNotMatch(css, /\.admin-editor-authorized \.left-panel \{/);
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


test('реестр модулей ссылается на существующие файлы и держит три плоскости', () => {
  assert.ok(SECTOR_MODULES.length >= 12, 'реестр не должен быть демонстрационным списком');
  const planes = new Set(SECTOR_MODULES.map((module) => module.plane));
  assert.deepEqual([...planes].sort(), ['data', 'order', 'spatial']);
  for (const module of SECTOR_MODULES) {
    assert.ok(STATUS_TITLES[module.status], `нет подписи статуса у ${module.id}`);
    assert.ok(PLANE_TITLES[module.plane], `нет подписи плоскости у ${module.id}`);
    assert.ok(module.note.length > 20, `модуль ${module.id} без пояснения`);
    // Файл модуля действительно есть в репозитории: реестр ссылается на код.
    assert.doesNotThrow(() => read(module.source), `нет файла ${module.source}`);
  }
  const ids = new Set(SECTOR_MODULES.map((module) => module.id));
  for (const id of ['sector-areas-journal', 'sector-areas-scope', 'sector-areas-border-world']) {
    assert.ok(ids.has(id), `в реестре нет модуля ${id}`);
  }
  assert.equal(moduleById('нет-такого-модуля'), null);
});

test('свойства модуля считаются по документу, а не берутся из литерала', () => {
  const journal = moduleById('sector-areas-journal');
  assert.ok(journal !== null);
  const context = { session: createEditorSession(emptySectorAreasDoc()), bounds: null, systems: [], scale: 1 };
  const empty = moduleRows(journal, context);
  const filled = moduleRows(journal, { ...context, session: createEditorSession(docWithArea()) });
  assert.notDeepEqual(empty, filled, 'свойства обязаны зависеть от документа');
  for (const item of filled) {
    assert.equal(typeof item.label, 'string');
    assert.equal(typeof item.value, 'string');
    assert.ok(item.value.length > 0, `пустое значение у «${item.label}»`);
  }
});

test('состояние по умолчанию нейтральное и проходит семантическую проверку', () => {
  const state = createDefaultState('state-1', 'political');
  assert.equal(state.factionMode, 'neutral');
  assert.deepEqual(state.factionIds, []);
  const doc = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{ ...createArea({ id: 'area-1', name: 'Область 1', rings: [SQUARE] }), states: [state] }],
  });
  const report = validateSectorAreas(doc);
  assert.equal(report.ok, true, report.errors.join(' '));
});

test('проверка документа возвращает замечания, но не блокирует документ', () => {
  const broken = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{
      ...createArea({ id: 'area-1', name: 'Область 1', rings: [SQUARE] }),
      states: [{ ...createDefaultState('state-1', 'political'), factionMode: 'single', factionIds: [] }],
    }],
  });
  const report = documentReport(broken);
  assert.equal(report.ok, false);
  assert.ok(report.errors.length > 0);
  // Документ при этом остаётся рабочим: проверка — предупреждение, а не запрет.
  assert.equal(broken.areas.length, 1);
  assert.equal(documentReport(parseSectorAreas(emptySectorAreasDoc())).errors.length, 0);
});

test('секторный снап делает площадью ячейку адреса и сразу даёт состояние', () => {
  const session = createEditorSession(emptySectorAreasDoc());
  const next = addAreaFromSectorCell(session, {
    id: 'area-1',
    name: 'Ячейка 1',
    x: 5720,
    y: 6257,
    letters: 5,
    state: createDefaultState('state-area-1', 'political'),
  });
  const area = next.doc.areas[0];
  assert.equal(area.source, 'sector');
  assert.equal(area.states.length, 1, 'область без состояния осталась бы невидимой');
  assert.match(area.address, /^KP/);
  const ring = area.rings[0];
  const width = Math.max(...ring.map((point) => point[0])) - Math.min(...ring.map((point) => point[0]));
  assert.ok(width > 0, 'площадь ячейки не должна быть точкой');
  assert.throws(() => addAreaFromSectorCell(session, { id: 'bad', name: 'Мелко', x: 5720, y: 6257, letters: 4 }), RangeError);
});

test('нумерация продолжается после загрузки документа, а не начинается заново', () => {
  const doc = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{ ...createArea({ id: 'area-7', name: 'Область 7', rings: [SQUARE] }) }],
  });
  const session = createEditorSession(doc);
  assert.equal(session.sequence, 8);
  const first = addAreaFromStroke(session, { id: 'area-' + session.sequence, name: 'Новая', points: SQUARE });
  const second = addAreaFromStroke(first, { id: 'area-' + first.sequence, name: 'Ещё', points: SQUARE });
  const ids = second.doc.areas.map((area) => area.id);
  assert.equal(new Set(ids).size, ids.length, 'идентификаторы не должны повторяться');
});

test('служебный раздел проверок не попадает в окно справки', () => {
  const html = markdownToHtml(read('docs/admins/sector-areas-editor.md'));
  assert.match(html, /Порядок работы/);
  assert.match(html, /Чего в редакторе нет/);
  assert.doesNotMatch(html, /Проверки перед заявкой/, 'служебный раздел скрыт от администратора');
});

test('материал заявки не выдаёт проверки за выполненные', () => {
  const text = requestMaterial(docWithArea());
  assert.match(text, /## Проверки/);
  assert.match(text, /не запускались/);
  assert.match(text, /демо, не отправлено/);
  assert.doesNotMatch(text, /типы без замечаний/);
  assert.doesNotMatch(text, /документация актуальна/);
});

test('стили панели описывают реестр, статус и проверку документа', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /\.admin-editor-module \{/);
  assert.match(css, /\.admin-editor-status\[data-status="working"\]/);
  assert.match(css, /\.admin-editor-table \{/);
  assert.match(css, /\.admin-editor-check\[data-state="error"\]/);
  assert.match(css, /\.admin-editor-demo \{/);
});

/* --------------------------------------------------- инструменты рисования (P2) */

/* Минимальная опора панели: тест идёт в Node без DOM, а разметку панели и
   реакцию на клики проверить надо. Опора лишь принимает разметку и клики —
   не более. */
class FakeElement {
  constructor(attrs = {}) {
    this.attrs = attrs;
    this.innerHTML = '';
    this.textContent = '';
    this.value = attrs.value ?? '';
    this.checked = false;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  setAttribute(name, value) { this.attrs[name] = value; }

  closest(selector) {
    return selector === '[data-action]' && Object.prototype.hasOwnProperty.call(this.attrs, 'data-action')
      ? this
      : null;
  }

  contains() { return false; }
  focus() {}
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
}

// `onPanelClick` проверяет `target instanceof Element`: в Node такого глобала нет.
globalThis.Element = FakeElement;

/** Панель-заглушка: запоминает разметку блоков и обработчик клика. */
function fakePanel() {
  const blocks = new Map();
  const handlers = new Map();
  const attrs = new Map();
  return {
    blocks,
    handlers,
    attrs,
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener() {},
    querySelector(selector) {
      if (!blocks.has(selector)) blocks.set(selector, new FakeElement());
      return blocks.get(selector);
    },
    // `insidePanel` спрашивает панель про цель события: в заглушке цель вне неё.
    contains() { return false; },
    classList: { toggle() {}, contains() { return false; } },
  };
}

/** Разметка блока панели: «Модули», «Свойства» или «Изменения». */
const blockHtml = (panel, name) => panel.blocks.get(`[data-editor-block="${name}"]`).innerHTML;

/** Клик по органу панели с нужным `data-action`. */
function clickPanel(panel, action, attrs = {}) {
  const handler = panel.handlers.get('click');
  handler({ target: new FakeElement({ 'data-action': action, ...attrs }) });
}

/** Ядро с источником цветов фракций: тот же, что читает карта. */
function fakeKernelWithFactions(doc) {
  const kernel = fakeKernel(doc);
  kernel.data = {
    factionsByName() {
      return new Map([
        // Служебная строка «—»: фракции нет, её цвет — нейтральный.
        ['\u2014', { color: '#dfe7f2', short: '', order: null }],
        ['Доминион Терран', { color: '#fe0000', short: 'Доминион', order: 1 }],
        ['Кел-Морийский Синдикат', { color: '#17b111', short: 'КМС', order: 2 }],
      ]);
    },
  };
  return kernel;
}

test('панель показывает все пять инструментов, выбранный помечен', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null,
  });
  // По умолчанию открыт экран выбранного модуля без одновременного списка всех команд.
  assert.match(blockHtml(panel, 'modules'), /admin-editor-toolbox/);
  clickPanel(panel, 'screen', { 'data-screen': 'draw' });
  const html = blockHtml(panel, 'modules');
  for (const tool of TOOL_IDS) {
    assert.match(html, new RegExp(`data-tool="${tool}"`), `нет кнопки инструмента ${tool}`);
  }
  assert.match(html, /admin-editor-tools/);
  // По умолчанию — свободная линия: именно она даёт открытый контур.
  assert.match(html, /data-tool="free-line" aria-pressed="true"/);
  assert.match(html, /data-tool="polygon" aria-pressed="false"/);
  api.destroy();
});

test('переключение инструмента и выбор фракции — состояние интерфейса, не документа', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  const before = api.doc();
  clickPanel(panel, 'screen', { 'data-screen': 'draw' });
  clickPanel(panel, 'tool', { 'data-tool': 'polygon' });
  assert.equal(api.doc(), before, 'смена инструмента не коммитит документ');
  assert.match(blockHtml(panel, 'modules'), /data-tool="polygon" aria-pressed="true"/);

  clickPanel(panel, 'faction', { value: 'Доминион Терран' });
  assert.equal(api.doc(), before, 'выбор фракции не коммитит документ');

  // В журнале и в истории — ничего: ни событий, ни шага отмены.
  assert.equal(api.doc().events.length, before.events.length);
  assert.equal(api.session().past.length, 0);
  assert.equal(api.session().future.length, 0);
  api.destroy();
});

test('две заливки в панели различимы и не подменяют друг друга', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  const html = blockHtml(panel, 'properties');
  assert.match(html, /data-action="force"/, 'заливка-override');
  assert.match(html, /data-action="fill-state"/, 'заливка фигуры как состояние');
  // Замкнутую область залить можно: кнопка доступна.
  assert.doesNotMatch(html, /data-action="fill-state" disabled/);
  api.destroy();
});

test('палитра фракций — из существующего источника, начало нейтральное', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  const html = blockHtml(panel, 'properties');
  // Первый и выбранный вариант — нейтральная: новая область начинает без фракции.
  assert.match(html, /<option value="" selected>Без фракции/);
  assert.match(html, /Доминион Терран/);
  assert.match(html, /Кел-Морийский Синдикат/);
  // Служебная строка «—» означает «фракции нет» и в списке не предлагается.
  assert.doesNotMatch(html, /<option value="\u2014"/);
  api.destroy();
});

test('заливка фигуры как состояние пишет область, а не мазок override', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  const areaId = api.doc().areas[0].id;
  clickPanel(panel, 'select', { value: areaId });
  clickPanel(panel, 'faction', { value: 'Доминион Терран' });
  clickPanel(panel, 'fill-state');

  const area = api.doc().areas[0];
  assert.equal(area.states.length, 1, 'состояние записано в саму область');
  assert.deepEqual(area.states[0].factionIds, ['Доминион Терран']);
  assert.equal(api.doc().overrides.length, 0, 'override не подменяет заливку состоянием');
  assert.equal(api.doc().events.at(-1).kind, 'state');
  api.destroy();
});

test('открытую линию залить нельзя: кнопка недоступна, команда отказывает', () => {
  const open = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [{
      ...createArea({
        id: 'area-1',
        name: 'Линия',
        rings: [[[1000, 1000], [2000, 2000], [3000, 1500]]],
        closed: false,
        location: 'unknown',
      }),
    }],
  });
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(open), panel, canvas: null, stage: null, storage: null,
  });
  const html = blockHtml(panel, 'properties');
  assert.match(html, /data-action="fill-state" disabled/, 'на открытой линии заливка недоступна');
  assert.match(html, /не заливается/, 'причина видна заранее');
  assert.equal(canFillArea(api.doc().areas[0]).ok, false);

  // Если вызов всё же дошёл, команда отказывает и документ не портит.
  clickPanel(panel, 'fill-state');
  assert.equal(api.doc().areas[0].states.length, 0, 'открытая линия не заливается');
  assert.equal(api.doc().events.length, 0);
  api.destroy();
});

test('хоткей отмены срабатывает на любой раскладке', () => {
  // Ловушка, из-за которой отмена казалась неработающей: на русской раскладке
  // `Ctrl+Z` приходит как `key` «я», и сравнение по `key` молча не срабатывало.
  assert.notEqual('я'.toLowerCase(), 'z');
  // Физический код клавиши от раскладки не зависит.
  assert.equal(editorHotkey({ code: 'KeyZ', key: 'z', ctrlKey: true }), 'undo');
  assert.equal(editorHotkey({ code: 'KeyZ', key: 'я', ctrlKey: true }), 'undo', 'русская раскладка');
  assert.equal(editorHotkey({ code: 'KeyZ', key: 'я', metaKey: true }), 'undo', 'Cmd на macOS');
  assert.equal(editorHotkey({ code: 'KeyZ', key: 'Z', ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(editorHotkey({ code: 'KeyZ', key: 'Я', ctrlKey: true, shiftKey: true }), 'redo');
  assert.equal(editorHotkey({ code: 'KeyF', key: 'f' }), 'force');
  assert.equal(editorHotkey({ code: 'KeyF', key: 'а' }), 'force', 'русская раскладка');
  assert.equal(editorHotkey({ code: 'Enter', key: 'Enter' }), 'finish');
  assert.equal(editorHotkey({ code: 'Escape', key: 'Escape' }), 'cancel');
  // Чужие сочетания редактору не принадлежат: `Ctrl+F` остаётся поиском браузера.
  assert.equal(editorHotkey({ code: 'KeyF', key: 'f', ctrlKey: true }), null);
  assert.equal(editorHotkey({ code: 'KeyY', key: 'y', ctrlKey: true }), null);
  assert.equal(editorHotkey({}), null);
});

test('руководство описывает инструменты и обе заливки', () => {
  const guide = read('docs/admins/sector-areas-editor.md');
  for (const tool of ['Свободная линия', 'Линия по точкам', 'Прямоугольник', 'Эллипс', 'Многоугольник']) {
    assert.ok(guide.includes(tool), `в руководстве нет инструмента «${tool}»`);
  }
  assert.ok(guide.includes('Залить фигуру'), 'в руководстве нет заливки фигуры');
  assert.ok(guide.includes('Закрасить'), 'в руководстве нет закраски-override');
  assert.ok(guide.includes('location'), 'в руководстве не сказано про положение области');
  // Отмена вне режима рисования — поведение, которого раньше не было.
  assert.ok(guide.includes('независимо от режима рисования'), 'в руководстве не сказано про отмену вне режима рисования');
});

test('стили панели описывают инструменты и образец цвета', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /\.admin-editor-tools \{/);
  assert.match(css, /\.admin-editor-tool\[aria-pressed="true"\]/);
  assert.match(css, /\.admin-editor-swatch \{/);
});

/* ------------------------------------------- хоткеи редактора: режим и поля ввода */

/* `onKeyDown` подписан на `window` в фазе перехвата. В Node `window` нет, поэтому
   без подмены обработчик не привязывается вовсе и проверить сочетания нечем. */
function fakeWindow() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(type, handler) { handlers.set(type, handler); },
    removeEventListener(type) { handlers.delete(type); },
    // Кадра нет: 0 означает «петля не запущена» — так же считает и сам модуль.
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
  };
}

/** Редактор с перехваченным обработчиком `keydown`. */
function editorWithKeys(doc = docWithArea()) {
  const win = fakeWindow();
  const panel = fakePanel();
  // Глобал нужен только на время привязки: сам обработчик к `window` не ходит.
  globalThis.window = win;
  let api;
  try {
    api = createSectorAreasEditorUi({ kernel: fakeKernelWithFactions(doc), panel, canvas: null, storage: fakeStorage() });
  } finally {
    delete globalThis.window;
  }
  return { api, panel, keydown: win.handlers.get('keydown') };
}

/** Нажатие: событие-заглушка с теми полями, что читает `editorHotkey`. */
function pressKey(keydown, init, target = null) {
  const event = {
    target,
    prevented: false,
    stopped: false,
    stopPropagation() { event.stopped = true; },
    preventDefault() { event.prevented = true; },
    ...init,
  };
  keydown(event);
  return event;
}

test('отмена и повтор работают при выключенном режиме рисования', () => {
  const { api, panel, keydown } = editorWithKeys();
  assert.equal(typeof keydown, 'function', 'обработчик keydown привязан');
  // Выделение и удаление идут через панель: им режим рисования не нужен.
  clickPanel(panel, 'select', { value: 'area-1' });
  clickPanel(panel, 'remove');
  assert.equal(api.doc().areas.length, 0, 'область удалена');

  api.setEnabled(false);
  assert.equal(api.enabled(), false, 'рисование выключено');

  // Клавиши намеренно кириллические: физический код от раскладки не зависит.
  const undoPress = pressKey(keydown, { code: 'KeyZ', key: 'я', ctrlKey: true });
  assert.equal(api.doc().areas.length, 1, 'Ctrl+Z вернул область и при выключенном рисовании');
  assert.equal(undoPress.prevented, true, 'сочетание перехвачено редактором');

  const redoPress = pressKey(keydown, { code: 'KeyZ', key: 'Я', ctrlKey: true, shiftKey: true });
  assert.equal(api.doc().areas.length, 0, 'Ctrl+Shift+Z повторил удаление');
  assert.equal(redoPress.prevented, true);

  api.destroy();
});

test('F и команды ввода фигуры молчат вне режима рисования', () => {
  const { api, panel, keydown } = editorWithKeys();
  clickPanel(panel, 'select', { value: 'area-1' });
  const events = api.doc().events.length;

  api.setEnabled(false);
  const off = pressKey(keydown, { code: 'KeyF', key: 'а' });
  assert.equal(api.doc().events.length, events, 'вне режима рисования F ничего не закрашивает');
  assert.equal(off.prevented, false, 'чужую клавишу редактор не перехватывает');

  api.setEnabled(true);
  assert.equal(api.enabled(), true);
  const on = pressKey(keydown, { code: 'KeyF', key: 'а' });
  assert.equal(api.doc().events.length, events + 1, 'в режиме рисования F закрашивает');
  assert.equal(on.prevented, true);

  api.destroy();
});

test('в полях ввода редактор не перехватывает клавиши', () => {
  const { api, panel, keydown } = editorWithKeys();
  clickPanel(panel, 'select', { value: 'area-1' });
  clickPanel(panel, 'remove');
  api.setEnabled(true);
  assert.equal(api.doc().areas.length, 0);

  // Конструкторы полей нужны самой проверке: без них охранник `instanceof`
  // не срабатывает, и тест проверял бы отсутствие конструктора, а не охранник.
  class InputField extends FakeElement {}
  globalThis.HTMLInputElement = InputField;
  globalThis.HTMLSelectElement = FakeElement;
  globalThis.HTMLTextAreaElement = FakeElement;
  try {
    const fields = [['инпуте', InputField], ['списке', FakeElement], ['многострочном поле', FakeElement]];
    for (const [where, Field] of fields) {
      const before = api.doc().areas.length;
      const press = pressKey(keydown, { code: 'KeyZ', key: 'я', ctrlKey: true }, new Field());
      assert.equal(api.doc().areas.length, before, `Ctrl+Z в ${where} не трогает документ`);
      assert.equal(press.prevented, false, `Ctrl+Z в ${where} не перехвачен`);
    }
    // `F` — тоже: иначе в имени области нельзя набрать слово с буквой «ф».
    const pressF = pressKey(keydown, { code: 'KeyF', key: 'а' }, new InputField());
    assert.equal(pressF.prevented, false, 'F в поле ввода не перехвачен');

    // И наоборот: вне поля то же сочетание редактор забирает себе.
    const outside = pressKey(keydown, { code: 'KeyZ', key: 'я', ctrlKey: true });
    assert.equal(outside.prevented, true, 'вне поля Ctrl+Z принадлежит редактору');
    assert.equal(api.doc().areas.length, 1, 'отмена вернула удалённую область');
  } finally {
    delete globalThis.HTMLInputElement;
    delete globalThis.HTMLSelectElement;
    delete globalThis.HTMLTextAreaElement;
  }

  api.destroy();
});

/* -------------------------------- граф модулей, снап к сетке и мульти-штрихи */

test('навигация модулей предшествует доку и показывает ровно один выбранный экран', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  assert.equal(panel.getAttribute('data-active-screen'), 'dependencies');
  const modules = blockHtml(panel, 'modules');
  const properties = blockHtml(panel, 'properties');
  const changes = blockHtml(panel, 'changes');

  const navAt = modules.indexOf('data-editor-nav');
  const stageAt = modules.indexOf('data-editor-stage');
  assert.ok(navAt > 0 && stageAt > navAt, 'постоянная навигация расположена слева от рабочей области');
  assert.match(modules, /class="admin-editor-shell"/);
  assert.match(modules, /data-editor-screen="dependencies"/);
  assert.match(modules, /data-editor-graph/, 'граф — начальный экран дока');
  assert.match(modules, /admin-editor-toolbox/, 'Toolbox доступен независимо от выбранного модуля');
  assert.match(properties, /data-action="select"/, 'свойства области формируются в опорном блоке properties');
  assert.match(changes, /data-action="download"/, 'журнал и выгрузка формируются в опорном блоке changes');

  // Переключение системы из левой навигации меняет активный модуль и не открывает граф.
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-snap' });
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  assert.match(blockHtml(panel, 'modules'), /Привязка к адресной сетке/);
  assert.doesNotMatch(blockHtml(panel, 'modules'), /data-editor-graph/);
  api.destroy();
});

test('граф модулей рисует только подтверждённые рёбра, фильтрует плоскости и выделяет изолированный узел', () => {
  const allGraph = moduleGraphHtml('sector-areas-editor', 'all');
  const allEdges = allGraph.match(/class="admin-editor-graph-edge"/g) ?? [];
  assert.equal(allEdges.length, MODULE_RELATIONS.length, 'число стрелок совпадает с подтверждёнными связями');
  assert.doesNotMatch(allGraph, /data-from="sector-areas-border-world"/);
  assert.doesNotMatch(allGraph, /data-to="sector-areas-border-world"/);
  assert.match(allGraph, /data-module="sector-areas-border-world"[^>]*data-isolated="true"/);

  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null,
  });
  const docBefore = api.doc();
  clickPanel(panel, 'screen', { 'data-screen': 'dependencies' });
  assert.equal(panel.getAttribute('data-active-screen'), 'dependencies');
  assert.match(blockHtml(panel, 'modules'), /data-editor-graph/);

  clickPanel(panel, 'relation-filter', { 'data-plane': 'spatial' });
  const spatialModules = blockHtml(panel, 'modules');
  const spatialCount = MODULE_RELATIONS.filter((rel) => rel.kind === 'spatial').length;
  assert.equal((spatialModules.match(/class="admin-editor-graph-edge"/g) ?? []).length, spatialCount);
  assert.doesNotMatch(spatialModules, /class="admin-editor-graph-edge" data-kind="data"/);
  assert.equal(api.doc(), docBefore, 'фильтр графа — чистое состояние интерфейса');
  assert.equal(api.session().past.length, 0);

  clickPanel(panel, 'module', { 'data-module': 'sector-areas-border-world' });
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  assert.match(blockHtml(panel, 'modules'), /Подтверждённых связей в коде нет/);
  api.destroy();
});

test('режим привязки «к рёбрам сетки» доступен в списке и работает через событие change в браузере', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null,
  });
  clickPanel(panel, 'screen', { 'data-screen': 'draw' });
  assert.match(blockHtml(panel, 'modules'), /<option value="grid">к рёбрам сетки<\/option>/);

  class SelectControl extends FakeElement {}
  globalThis.HTMLSelectElement = SelectControl;
  try {
    const select = new SelectControl({ 'data-action': 'snap', value: 'grid' });
    // В реальном браузере клик открывает список и не должен перерисовывать панель.
    panel.handlers.get('click')({ target: select });
    assert.equal(api.session().snapMode, 'free', 'клик по открытому списку не сбрасывает DOM');
    // А выбор пункта присылает событие change.
    panel.handlers.get('change')({ target: select });
    assert.equal(api.session().snapMode, 'grid');
    assert.match(blockHtml(panel, 'modules'), /admin-editor-tier-badge/);
    assert.equal(api.session().past.length, 0, 'переключение снапа не засоряет историю');
  } finally {
    delete globalThis.HTMLSelectElement;
  }

  api.destroy();
});

test('кнопка «Создать новую область» переключает активную область, а отмена возвращает прежний выбор', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  clickPanel(panel, 'select', { value: 'area-1' });
  assert.equal(api.session().selection, 'area-1');

  clickPanel(panel, 'create-area');
  assert.equal(api.doc().areas.length, 2);
  const created = api.doc().areas[1];
  assert.equal(api.session().selection, created.id);
  assert.deepEqual(created.rings, []);
  assert.deepEqual(created.strokes, []);

  clickPanel(panel, 'undo');
  assert.equal(api.doc().areas.length, 1, 'пустая область удалена отменой');
  assert.equal(api.session().selection, 'area-1', 'активный выбор возвращён к прежней области');
  api.destroy();
});

test('несколько штрихов подряд записываются в активную область и притягиваются к рёбрам сетки', () => {
  const stageHandlers = new Map();
  const canvas = {
    clientWidth: 1000,
    clientHeight: 1000,
    classList: { add() {}, remove() {} },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 1000 }; },
    contains(node) { return node === canvas; },
  };
  const stage = {
    clientWidth: 1000,
    clientHeight: 1000,
    addEventListener(type, handler) { stageHandlers.set(type, handler); },
    removeEventListener() {},
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
    appendChild() {},
  };
  const kernel = {
    state: {
      sectorAreas: emptySectorAreasDoc(),
      viewport: { w: 1000, h: 1000 },
      view: { scale: 1, tx: 0, ty: 0 },
    },
    renderer: {
      requestRender() {},
      toWorld(x, y) { return { x, y }; },
      toScreen(x, y) { return { x, y }; },
    },
  };
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel, panel, stage, canvas, storage: null });
  api.setEnabled(true);
  clickPanel(panel, 'snap', { value: 'grid' });
  clickPanel(panel, 'module-run', { 'data-run': 'create-area' });
  assert.equal(api.doc().areas.length, 1);
  const activeId = api.session().selection;

  const drawSegment = (pts) => {
    const mk = (x, y) => ({
      target: canvas,
      button: 0,
      buttons: 1,
      pointerId: 1,
      clientX: x,
      clientY: y,
      stopPropagation() {},
      preventDefault() {},
    });
    stageHandlers.get('pointerdown')(mk(pts[0][0], pts[0][1]));
    for (let i = 1; i < pts.length; i += 1) {
      stageHandlers.get('pointermove')(mk(pts[i][0], pts[i][1]));
    }
    stageHandlers.get('pointerup')(mk(pts.at(-1)[0], pts.at(-1)[1]));
  };

  // При viewport 1000x1000 и scale=1 мельчайший отображаемый ярус — T3 (шаг 80).
  drawSegment([[83, 162], [160, 161], [238, 162]]);
  drawSegment([[322, 82], [321, 160], [322, 239]]);

  assert.equal(api.doc().areas.length, 1, 'оба штриха попали в одну активную область');
  const area = api.doc().areas[0];
  assert.equal(area.id, activeId);
  assert.equal(area.strokes.length, 2, 'оба завершённых штриха сохранены по отдельности');
  for (const stroke of area.strokes) {
    for (const [x, y] of stroke.points) {
      const onVertical = Math.abs(x - Math.round(x / 80) * 80) < 1e-6;
      const onHorizontal = Math.abs(y - Math.round(y / 80) * 80) < 1e-6;
      assert.ok(onVertical || onHorizontal, `вершина [${x}, ${y}] должна лежать на ребре яруса 80`);
    }
  }

  // Поштучная отмена: сначала снимается второй штрих, затем первый, затем пустая область.
  clickPanel(panel, 'undo');
  assert.equal(api.doc().areas[0].strokes.length, 1);
  clickPanel(panel, 'undo');
  assert.equal(api.doc().areas[0].strokes.length, 0);
  clickPanel(panel, 'undo');
  assert.equal(api.doc().areas.length, 0);
  api.destroy();
});

test('постоянная навигация сохраняется на всех экранах и отмечает активный раздел без записи в историю', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });
  const initialDoc = api.doc();

  for (const screen of ['draw', 'properties', 'changes', 'dependencies', 'lines', 'hierarchy']) {
    clickPanel(panel, 'screen', { 'data-screen': screen });
    assert.equal(api.screen(), screen);
    assert.equal(panel.getAttribute('data-active-screen'), screen);
    const modules = blockHtml(panel, 'modules');
    assert.match(modules, /data-editor-nav/, `на экране ${screen} навигация остаётся видимой`);
    assert.match(modules, new RegExp(`data-screen="${screen}" aria-current="page"`));
    if (screen !== 'dependencies') {
      assert.doesNotMatch(modules, /data-editor-graph/, `на экране ${screen} граф не занимает место`);
    }
  }

  // Переход по зависимости внутри карточки модуля и клавиатурный выбор узла SVG ведут к модулю.
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-editor' });
  assert.equal(api.screen(), 'module');
  assert.match(blockHtml(panel, 'modules'), /data-module="sector-areas-editor" aria-current="page"/);

  clickPanel(panel, 'screen', { 'data-screen': 'dependencies' });
  const graphHtml = blockHtml(panel, 'modules');
  assert.match(graphHtml, /role="button" tabindex="0" aria-label="Привязка к адресной сетке — открыть модуль"/);
  assert.doesNotMatch(moduleGraphHtml('sector-areas-editor', 'all'), /admin-editor-planes/, 'список систем не дублируется под SVG-графом');

  // Мышь по-прежнему открывает модуль через обычное делегирование клика панели.
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-snap' });
  assert.equal(api.screen(), 'module');
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  assert.match(blockHtml(panel, 'modules'), /data-module="sector-areas-snap" aria-current="page"/);
  assert.doesNotMatch(blockHtml(panel, 'modules'), /data-editor-graph/);

  assert.equal(api.doc(), initialDoc, 'навигация по экранам и системам не трогает документ');
  assert.equal(api.session().past.length, 0);
  api.destroy();
});

test('Enter и Space на SVG-узле проходят window-capture, а родные кнопки и поля сохраняют поведение', () => {
  const { api, panel, keydown } = editorWithKeys();

  for (const key of ['Enter', ' ']) {
    clickPanel(panel, 'screen', { 'data-screen': 'dependencies' });
    const svgNode = new FakeElement({ 'data-action': 'module', 'data-module': 'sector-areas-snap' });
    svgNode.tagName = 'g';
    panel.contains = (target) => target === svgNode;

    // Полный путь события: именно window-capture, а не прямой вызов bubble-обработчика панели.
    const press = pressKey(keydown, { key }, svgNode);
    assert.equal(press.prevented, true, `${key}: браузер не прокручивает страницу`);
    assert.equal(press.stopped, true, `${key}: событие не доходит до карты`);
    assert.equal(api.screen(), 'module', `${key}: открыта карточка SVG-узла`);
    assert.equal(panel.getAttribute('data-active-screen'), 'module');
    assert.match(blockHtml(panel, 'modules'), /data-module="sector-areas-snap" aria-current="page"/);
    assert.doesNotMatch(blockHtml(panel, 'modules'), /data-editor-graph/);
  }

  // Capture по-прежнему изолирует карту, но не подменяет нативную активацию кнопки.
  clickPanel(panel, 'screen', { 'data-screen': 'dependencies' });
  const button = new FakeElement({ 'data-action': 'screen', 'data-screen': 'draw' });
  button.tagName = 'BUTTON';
  panel.contains = (target) => target === button;
  const buttonPress = pressKey(keydown, { key: 'Enter' }, button);
  assert.equal(buttonPress.prevented, false);
  assert.equal(buttonPress.stopped, true);
  assert.equal(api.screen(), 'dependencies', 'тест не имитирует нативный click кнопки');

  const input = new FakeElement({ value: '12' });
  input.tagName = 'INPUT';
  panel.contains = (target) => target === input;
  const inputPress = pressKey(keydown, { key: ' ' }, input);
  assert.equal(inputPress.prevented, false);
  assert.equal(inputPress.stopped, true);
  assert.equal(api.screen(), 'dependencies');

  // Обычный click не зависит от contains(), использованного выше для keyboard-цепочки.
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-snap' });
  assert.equal(api.screen(), 'module');
  api.destroy();
});

test('оболочка сохраняет каталог, отдельные свёртки и полноэкранный мобильный док', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /\.map-stage \.left-panel \{ z-index: 19;/);
  assert.doesNotMatch(css, /\.admin-editor-authorized \.left-panel/);
  assert.match(css, /#adminEditorPanel \{[\s\S]*?max-height: none;/);
  assert.match(css, /#adminEditorPanel\.is-navigation-collapsed/);
  assert.match(css, /#adminEditorPanel\.is-collapsed \.admin-editor-rail/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?--shell-dock: 100%/);
  assert.match(css, /#adminEditorPanel \.admin-editor-toolbox \{ top: auto; right: 0; bottom: 0;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  // Телефонный рейл: последнее правило свёртки обязано быть с идентификатором и
  // задавать все четыре ребра через inset. Рабочая оболочка
  // `#adminEditorPanel { inset: … }` идёт ниже и при равной специфичности
  // перебивала прежнее правило на классах: свёрнутая панель растягивалась на
  // весь экран, а подпись рейла ломалась по буквам.
  const mobileRail = /@media \(max-width: 700px\) \{\s*#adminEditorPanel\.is-collapsed \{([^}]*)\}/.exec(css);
  assert.ok(mobileRail !== null, 'есть телефонное правило свёрнутой панели с идентификатором');
  assert.match(mobileRail[1], /inset: auto 8px auto auto;/, 'ребра задаются целиком, inset оболочки не тянет панель');
  assert.match(mobileRail[1], /width: 42px;/);
  assert.match(mobileRail[1], /height: 180px;/);
  assert.match(mobileRail[1], /transform: translateY\(-50%\)/);
  assert.match(css, /#adminEditorPanel\.is-collapsed \.admin-editor-rail \{[\s\S]*?inset: 0;/);
  assert.match(css, /#adminEditorPanel\.is-collapsed \.admin-editor-rail-label \{[\s\S]*?white-space: nowrap/);
  // Правило стоит в конце файла: после общей оболочки и её телефоных правок.
  assert.ok(
    css.lastIndexOf('#adminEditorPanel.is-collapsed {') > css.lastIndexOf('#adminEditorPanel { --shell-top: 116px; }'),
    'правило рейла стоит после общей оболочки и побеждает её по порядку',
  );
  // Свёртка старше экранных правил: `[data-active-screen="dependencies"] …`
  // специфичнее общего списка и оставлял док поверх рейла.
  assert.match(
    css,
    /#adminEditorPanel\.is-collapsed \.admin-editor-stage,[\s\S]*?\n\s*#adminEditorPanel\.is-collapsed \.admin-editor-body > section:not\(:first-of-type\) \{\s*display: none;/,
  );
  // На десктопе полоса с пятью быстрыми иконками в свёртке остаётся:
  // владелец просил сохранить её как быстрые команды.
  const collapsedTail = css.slice(css.lastIndexOf('#adminEditorPanel.is-collapsed .admin-editor-rail { display: flex; }'));
  assert.doesNotMatch(collapsedTail.split('@media')[0], /admin-editor-toolbox\s*\{\s*display: none/);
  // На телефоне свёрнутая панель — только рейл, иначе навигация перехватывает клик.
  assert.match(
    css,
    /@media \(max-width: 700px\) \{\s*#adminEditorPanel\.is-collapsed \.admin-editor-nav,\s*#adminEditorPanel\.is-collapsed \.admin-editor-toolbox \{ display: none; \}/,
  );
  const guide = read('docs/admins/sector-areas-editor.md');
  assert.match(guide, /прежний каталог карты/);
  assert.match(guide, /Перестановка|перетаскивать/);
});

test('onSessionChange срабатывает при импорте и правках; window.__sectorEditorDebug удалён из app.ts', async () => {
  const appSource = read('src/atlas/app.ts');
  assert.doesNotMatch(appSource, /__sectorEditorDebug/, 'отладочный глобал не утекает на window');
  assert.match(appSource, /isEditorToolActive/, 'клик-полёт по системе заблокирован при активном инструменте редактора');

  const panel = fakePanel();
  const kernel = fakeKernel(emptySectorAreasDoc());
  let sessionChanges = 0;
  const ui = createSectorAreasEditorUi({
    kernel,
    panel,
    stage: new FakeElement(),
    canvas: null,
    onSessionChange: () => { sessionChanges += 1; },
  });
  ui.applySession(addAreaFromStroke(ui.session(), {
    id: 's-new',
    name: 'Тест штриха',
    points: [[1000, 1000], [2000, 1000], [2000, 2000], [1000, 2000]],
    closed: true,
  }));
  assert.ok(sessionChanges >= 1, 'изменение сессии уведомляет смежные панели');

  // Импорт JSON обновляет kernel.state.sectorAreas и вызывает onSessionChange.
  const importedDoc = parseSectorAreas({
    ...emptySectorAreasDoc(),
    areas: [createArea({ id: 'imp-1', name: 'Импортированная', rings: [[[500, 500], [1500, 500], [1500, 1500], [500, 1500], [500, 500]]] })],
  });
  const changesBefore = sessionChanges;
  const fileInput = new FakeElement({ 'data-action': 'areas-import' });
  fileInput.files = [{ text: async () => JSON.stringify(importedDoc) }];
  panel.handlers.get('change')({ target: fileInput });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(kernel.state.sectorAreas.areas.length, 1);
  assert.equal(kernel.state.sectorAreas.areas[0].id, 'imp-1');
  assert.ok(sessionChanges > changesBefore, 'areas-import синхронизирует рендер и смежные панели');
  ui.destroy();
});

test('Ctrl+Z: уведомление называет отменённую правку и не молчит при пустой истории', () => {
  assert.equal(historyNotice('undo', 'Линия раздела pair-1 отредактирована вручную'),
    'Отменено (Ctrl+Z): Линия раздела pair-1 отредактирована вручную.');
  assert.equal(historyNotice('redo', 'Линия раздела pair-1 отредактирована вручную'),
    'Повторено (Ctrl+Shift+Z): Линия раздела pair-1 отредактирована вручную.');
  // Без подписи клавиша всё равно отвечает: иначе откат выглядит как «не сработало».
  assert.equal(historyNotice('undo', null), 'Отменено (Ctrl+Z).');
  assert.equal(historyNotice('redo', null), 'Повторено (Ctrl+Shift+Z).');
  assert.equal(historyNotice('undo', null, false), 'Отменять нечего: история правок пуста.');
  assert.equal(historyNotice('redo', null, false), 'Повторять нечего: история повтора пуста.');
  // Пустой журнал: подписи нет, но строка остаётся.
  const emptyDoc = emptySectorAreasDoc();
  assert.equal(lastEventNote(emptyDoc), null);
});


test('прозрачный контейнер оболочки не размывает карту через наследуемый .panel', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  const shell = /#adminEditorPanel \{([^}]+)\}/.exec(css)?.[1];
  assert.ok(shell);
  assert.match(shell, /backdrop-filter: none;/);
  assert.match(shell, /-webkit-backdrop-filter: none;/);
  assert.match(shell, /text-shadow: none;/);
});


test('родитель области меняется командой, отменяется и не допускает цикл', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  clickPanel(panel, 'create-area');
  clickPanel(panel, 'create-area');
  const [a, b] = api.doc().areas;
  clickPanel(panel, 'parent', { value: a.id });
  assert.equal(api.doc().areas[1].parentId, a.id);
  clickPanel(panel, 'undo');
  assert.equal(api.doc().areas[1].parentId, null);
  clickPanel(panel, 'redo');
  assert.equal(api.doc().areas[1].parentId, a.id);
  clickPanel(panel, 'select', { value: a.id });
  const before = api.doc();
  clickPanel(panel, 'parent', { value: b.id });
  assert.equal(api.doc(), before, 'обратная связь создала бы цикл');
  clickPanel(panel, 'parent', { value: 'missing' });
  assert.equal(api.doc(), before);
  clickPanel(panel, 'select', { value: b.id });
  clickPanel(panel, 'parent', { value: '' });
  assert.equal(api.doc().areas[1].parentId, null);
  api.destroy();
});

test('каждый модуль имеет понятное описание, возврат к графу и технические подробности отдельно', async () => {
  const { MODULE_HELP } = await import('../src/atlas/sector-areas-module-help.ts');
  const { SECTOR_MODULES } = await import('../src/atlas/sector-areas-registry.ts');
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  const before = api.doc();
  for (const mod of SECTOR_MODULES) {
    assert.ok(MODULE_HELP[mod.id], mod.id);
    for (const key of ['what', 'where', 'how', 'limits']) assert.ok(MODULE_HELP[mod.id][key].length > 20);
    clickPanel(panel, 'module', { 'data-module': mod.id });
    const html = blockHtml(panel, 'modules');
    assert.match(html, /К графу модулей/);
    assert.match(html, /Где и на что влияет/);
    assert.match(html, /<details><summary>Технические подробности/);
    assert.doesNotMatch(html, /data-editor-graph/);
  }
  clickPanel(panel, 'screen', { 'data-screen': 'dependencies' });
  assert.equal(api.doc(), before);
  assert.match(blockHtml(panel, 'modules'), /data-editor-graph/);
  assert.match(blockHtml(panel, 'modules'), /admin-editor-category/);
  api.destroy();
});


test('отдельные флажки рисования и сравнения имеют иконки и не записывают документ', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  const before = api.doc();
  for (const action of ['toggle-enable', 'preview']) {
    const control = new FakeElement({ 'data-action': action });
    control.checked = true;
    panel.handlers.get('click')({ target: control });
    assert.match(blockHtml(panel, 'modules'), new RegExp('data-action="' + action + '" checked'));
    control.checked = false;
    panel.handlers.get('click')({ target: control });
    assert.doesNotMatch(blockHtml(panel, 'modules'), new RegExp('data-action="' + action + '" checked'));
  }
  const html = blockHtml(panel, 'modules');
  assert.match(html, /Рисование<\/span>/);
  assert.match(html, /Сравнить контуры<\/span>/);
  assert.equal((html.match(/admin-editor-mode-check/g) ?? []).length, 2);
  assert.match(html, /пунктир — исходный контур/);
  assert.equal(api.doc(), before);
  assert.equal(api.session().past.length, 0);
  api.destroy();
});


test('карта связей использует круглые узлы, а заголовок соответствует экрану', () => {
  const html = moduleGraphHtml('sector-areas-editor');
  assert.doesNotMatch(html, /<rect| · связей:/);
  assert.equal((html.match(/class="admin-editor-graph-hit"/g) ?? []).length, 16);
  assert.match(html, /r="22"/);
  assert.match(html, /Что от чего зависит и на что влияет/);
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  assert.equal(panel.querySelector('#adminEditorTitle').textContent, 'Карта связей модулей');
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-editor' });
  assert.equal(panel.querySelector('#adminEditorTitle').textContent, 'О модуле');
  clickPanel(panel, 'screen', { 'data-screen': 'properties' });
  assert.equal(panel.querySelector('#adminEditorTitle').textContent, 'Свойства области');
  api.destroy();
});

test('отступ оболочки следует фактической высоте навигации, а не фиксированным 116px', () => {
  const panel = fakePanel();
  const query = panel.querySelector.bind(panel);
  let height = 62;
  const values = new Map();
  panel.style = { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) };
  panel.querySelector = (selector) => selector === '.admin-editor-nav'
    ? { getBoundingClientRect: () => ({ height }) } : query(selector);
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  assert.equal(values.get('--shell-top'), '70px');
  height = 114;
  api.refresh();
  assert.equal(values.get('--shell-top'), '122px', 'перенос категорий увеличивает отступ');
  height = 62;
  clickPanel(panel, 'navigation-toggle');
  assert.equal(values.get('--shell-top'), '70px', 'сворачивание сразу пересчитывает отступ');
  api.destroy();
  assert.equal(values.has('--shell-top'), false);
});

test('локальные свойства точек используют снимок, показывают правку и отдельные undo/redo', () => {
  const panel = fakePanel();
  const kernel = fakeKernelWithFactions(emptySectorAreasDoc());
  kernel.state.activeSystemId = '1';
  kernel.state.activePlanetId = null;
  const field = (raw, effective) => ({ raw, effective });
  kernel.data.propertySnapshots = () => [{ dataset: 'systems', recordId: '1', fields: {
    name: field('Корхал', 'Корхал'), type: field('capital', 'capital'),
    faction: field('Доминион', 'Доминион'), description: field('старое', 'текущее'), source_url: field('', ''),
  } }];
  const api = createSectorAreasEditorUi({ kernel, panel, canvas: null, stage: null, storage: null });
  api.setScreen('point-properties');
  assert.match(blockHtml(panel, 'modules'), /Корхал/);
  assert.match(blockHtml(panel, 'modules'), /правки не отправлены и не опубликованы/);
  const control = new FakeElement({ 'data-action': 'point-field', 'data-point-field': 'description', value: '<новое>' });
  panel.handlers.get('change')({ target: control });
  assert.match(panel.blocks.get('[data-point-summary]').innerHTML, /&lt;новое&gt;/);
  assert.equal(api.session().past.length, 0, 'история областей не изменяется');
  clickPanel(panel, 'point-undo');
  assert.match(blockHtml(panel, 'modules'), /текущее/);
  assert.match(blockHtml(panel, 'modules'), /Изменений: 0/);
  clickPanel(panel, 'point-redo');
  assert.match(blockHtml(panel, 'modules'), /&lt;новое&gt;/);
  assert.match(blockHtml(panel, 'modules'), /Изменений: 1/);
  api.destroy();
});

test('проверка локальных свойств блокирует недопустимую ссылку и разрешает локальную выгрузку после исправления', () => {
  const panel = fakePanel();
  const kernel = fakeKernelWithFactions(emptySectorAreasDoc());
  const f = (value) => ({ raw: value, effective: value });
  kernel.data.propertySnapshots = () => [{ dataset: 'systems', recordId: '1', fields: {
    name: f('Корхал'), type: f('capital'), faction: f(''), description: f(''), source_url: f(''),
  } }];
  const api = createSectorAreasEditorUi({ kernel, panel, canvas: null, stage: null, storage: null });
  api.setScreen('point-properties');
  const change = (value) => panel.handlers.get('change')({ target: new FakeElement({ 'data-action': 'point-field', 'data-point-field': 'source_url', value }) });
  change('javascript:alert(1)');
  assert.equal(panel.blocks.get('[data-action="point-export"]').disabled, true);
  assert.match(panel.blocks.get('[data-point-summary]').innerHTML, /Ошибка/);
  change('https://example.org');
  assert.equal(panel.blocks.get('[data-action="point-export"]').disabled, false);
  assert.doesNotMatch(panel.blocks.get('[data-point-summary]').innerHTML, /Ошибка/);
  api.destroy();
});


test('подтверждение предпросмотра локально и сбрасывается при новой правке', () => {
  const panel = fakePanel();
  const kernel = fakeKernelWithFactions(emptySectorAreasDoc());
  const f = (value) => ({ raw: value, effective: value });
  kernel.data.propertySnapshots = () => [{ dataset: 'systems', recordId: '1', fields: {
    name: f('Корхал'), type: f('capital'), faction: f(''), description: f('старое'), source_url: f(''),
  } }];
  const api = createSectorAreasEditorUi({ kernel, panel, canvas: null, stage: null, storage: null });
  api.setScreen('point-properties');
  const change = (value) => panel.handlers.get('change')({ target: new FakeElement({ 'data-action': 'point-field', 'data-point-field': 'description', value }) });
  change('<описание>');
  clickPanel(panel, 'point-preview');
  const preview = panel.blocks.get('[data-point-review]');
  assert.match(preview.innerHTML, /Предпросмотр — не отправлено/);
  assert.match(preview.innerHTML, /&lt;описание&gt;/);
  clickPanel(panel, 'point-review-confirm');
  assert.doesNotMatch(preview.innerHTML, /Просмотр подтверждён локально/);
  const checkbox = new FakeElement({ 'data-action': 'point-review-ack' });
  checkbox.checked = true;
  panel.handlers.get('change')({ target: checkbox });
  clickPanel(panel, 'point-review-confirm');
  assert.match(preview.innerHTML, /Просмотр подтверждён локально/);
  assert.match(preview.innerHTML, /применяет правку и не обновляет сайт/);
  assert.match(preview.innerHTML, /data-action="point-submit"/);
  change('Другое');
  assert.equal(preview.innerHTML, '', 'старое подтверждение не переносится на другую правку');
  api.destroy();
});

test('«Мои заявки» стоят в runtime-тулбаре сразу после «Модулей по категориям», не в заголовке дока', () => {
  const panel = fakePanel();
  const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage: null, storage: null });
  const html = blockHtml(panel, 'modules');
  const menuAt = html.indexOf('admin-editor-module-menu');
  const requestsAt = html.indexOf('id="propertyRequestsOpen"');
  assert.ok(menuAt >= 0 && requestsAt > menuAt);
  assert.match(html, /id="propertyRequestsOpen"[^>]*>Мои заявки<\/button>/);
  const variant = read('tools/vite/atlas-shell.ts');
  const heading = /admin-editor-heading-tools[\s\S]*?admin-editor-collapse/.exec(variant)?.[0] ?? '';
  assert.doesNotMatch(heading, /propertyRequestsOpen/);
  api.destroy();
});

test('панели из меню открываются слева рядом с Toolbox, граф остаётся справа и помещается без прокрутки', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /#adminEditorPanel:not\(\[data-active-screen="dependencies"\]\) \.admin-editor-heading\s*\{[^}]*left: calc\(var\(--toolbox-width\) \+ var\(--shell-gap\)\)/);
  assert.match(css, /#adminEditorPanel:not\(\[data-active-screen="dependencies"\]\) \.admin-editor-stage/);
  assert.match(css, /#adminEditorPanel\[data-active-screen="dependencies"\] \.admin-editor-stage\s*\{[^}]*overflow: hidden/);
  assert.match(css, /#adminEditorPanel\[data-active-screen="dependencies"\] \.admin-editor-graph-svg\s*\{[^}]*height: 100%[^}]*min-height: 0/);
  assert.match(css, /--toolbox-width: 67px/);
});

test('декоративная надпись в админ-сеансе лежит ниже панелей, а публичный топбар не меняется', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  assert.match(css, /\.admin-editor-authorized \.topbar::before\s*\{\s*visibility: hidden/);
  assert.match(css, /\.admin-editor-authorized \.map-stage::before\s*\{[^}]*content: "TIMELINE \/\/ SECURE ARCHIVE"[^}]*z-index: 3/);
  const skin = read('site/shared/timeline-skin.css');
  assert.match(skin, /\.topbar::before\s*\{[^}]*content: "TIMELINE \/\/ SECURE ARCHIVE"/);
  // Оболочка тянет все четыре ребра из переменных замера: верх — отдельная
  // переменная, без неё док на телефоне уезжает под шапку.
  assert.match(css, /#adminEditorPanel\s*\{[^}]*inset: var\(--shell-inset-top, 8px\) var\(--shell-right, 8px\) 8px var\(--shell-left, 8px\)/);
});

test('рёбра оболочки измеряются по внешним границам .topbar, а не по вложенным кнопке каталога и лого', () => {
  const panel = fakePanel();
  const values = new Map();
  panel.style = { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) };
  // Реальная геометрия сектора: сцена шире и начинается выше шапки
  // (.map-stage inset 68px 0 0 0), шапка врезана в viewport (topbar top/left/right 14px,
  // высота 80px). Оболочка должна повторять внешние рёбра шапки, а не сцену.
  const stage = {
    getBoundingClientRect: () => ({ left: 0, top: 68, right: 1000, bottom: 800 }),
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
    removeEventListener() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  const previousDocument = globalThis.document;
  let asked = [];
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => {
      asked.push(selector);
      // Вложенные ориентиры прежнего замера нарочно отдают другие числа:
      // если код снова возьмёт их, равенства ниже развалятся.
      if (selector === '#toggleSidePanel') return { getBoundingClientRect: () => ({ left: 90, right: 190 }) };
      if (selector === '.topbar-right .brand-emblem') return { getBoundingClientRect: () => ({ left: 700, right: 900 }) };
      if (selector === '.topbar') {
        return { getBoundingClientRect: () => ({ left: 14, top: 14, right: 986, bottom: 94 }) };
      }
      return null;
    },
  };
  try {
    const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage, storage: null });
    assert.ok(asked.includes('.topbar'), 'замер спрашивает внешнюю шапку');
    assert.equal(values.get('--shell-left'), '14px', 'левый отступ шапки от сцены');
    assert.equal(values.get('--shell-right'), '14px', 'правый отступ шапки от сцены');
    // 94 - 68 + 8 = 34: зазор от низа шапки до верха сцены плюс общий зазор 8px.
    assert.equal(values.get('--shell-inset-top'), '34px', 'верхний inset считается от внешнего низа шапки');
    api.destroy();
    assert.equal(values.has('--shell-left'), false);
    assert.equal(values.has('--shell-right'), false);
    assert.equal(values.has('--shell-inset-top'), false, 'destroy снимает и новую переменную');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('рёбра оболочки держат минимум 8px и не уходят под шапку на телефоне', () => {
  const panel = fakePanel();
  const values = new Map();
  panel.style = { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) };
  const stage = {
    getBoundingClientRect: () => ({ left: 0, top: 68, right: 1000, bottom: 800 }),
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
    removeEventListener() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  const previousDocument = globalThis.document;
  try {
    // Шапка шире сцены и прижата к её верху: замер не должен дать отрицательный отступ.
    globalThis.document = {
      activeElement: null,
      querySelector: (selector) => selector === '.topbar'
        ? { getBoundingClientRect: () => ({ left: -5, top: -5, right: 1005, bottom: 3 }) }
        : null,
    };
    const api = createSectorAreasEditorUi({ kernel: fakeKernel(emptySectorAreasDoc()), panel, canvas: null, stage, storage: null });
    assert.equal(values.get('--shell-left'), '8px');
    assert.equal(values.get('--shell-right'), '8px');
    // 3 - 68 + 8 = -57: отрицательный зазор прижат к минимуму 8px.
    assert.equal(values.get('--shell-inset-top'), '8px', 'отрицательный зазор не допускается');
    api.destroy();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }

  // Телефон: шапка перенесена в поток внутри полосы 68px, её низ (60) выше верха
  // сцены (68). Док обязан встать ниже шапки, а не под ней.
  const valuesPhone = new Map();
  const panelPhone = fakePanel();
  panelPhone.style = {
    setProperty: (key, value) => valuesPhone.set(key, value),
    removeProperty: (key) => valuesPhone.delete(key),
  };
  const stagePhone = {
    getBoundingClientRect: () => ({ left: 0, top: 68, right: 390, bottom: 844 }),
    style: { setProperty() {}, removeProperty() {} },
    addEventListener() {},
    removeEventListener() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  const previousDocumentPhone = globalThis.document;
  globalThis.document = {
    activeElement: null,
    querySelector: (selector) => selector === '.topbar'
      ? { getBoundingClientRect: () => ({ left: 9, top: 4, right: 381, bottom: 64 }) }
      : null,
  };
  try {
    const api = createSectorAreasEditorUi({
      kernel: fakeKernel(emptySectorAreasDoc()), panel: panelPhone, canvas: null, stage: stagePhone, storage: null,
    });
    // 64 - 68 + 8 = 4 → минимум 8px: на телефоне док стоит у самой кромки сцены
    // и не залезает под шапку (она кончается на 64, сцена начинается на 68).
    assert.equal(valuesPhone.get('--shell-inset-top'), '8px', 'на телефоне зазор не уходит в минус');
    api.destroy();
  } finally {
    if (previousDocumentPhone === undefined) delete globalThis.document;
    else globalThis.document = previousDocumentPhone;
  }

  // Шапки в DOM нет (другой вариант оболочки) — переменные не пишутся вовсе.
  const valuesWithoutTopbar = new Map();
  const panelWithoutTopbar = fakePanel();
  panelWithoutTopbar.style = {
    setProperty: (key, value) => valuesWithoutTopbar.set(key, value),
    removeProperty: (key) => valuesWithoutTopbar.delete(key),
  };
  const previousDocument2 = globalThis.document;
  globalThis.document = { activeElement: null, querySelector: () => null };
  try {
    const api = createSectorAreasEditorUi({
      kernel: fakeKernel(emptySectorAreasDoc()), panel: panelWithoutTopbar, canvas: null, stage, storage: null,
    });
    assert.equal(valuesWithoutTopbar.has('--shell-left'), false, 'без .topbar левый inset остаётся значением CSS');
    assert.equal(valuesWithoutTopbar.has('--shell-inset-top'), false);
    api.destroy();
  } finally {
    if (previousDocument2 === undefined) delete globalThis.document;
    else globalThis.document = previousDocument2;
  }
});

test('правый рейл expand возвращает граф зависимостей, а не последнюю левую панель', () => {
  const panel = fakePanel();
  // Классы панели живые: свёртка проверяется по тому же classList, что и в браузере.
  const classes = new Set();
  panel.classList = {
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    contains(name) { return classes.has(name); },
    toggle(name, force) {
      const next = force === undefined ? !classes.has(name) : force;
      if (next) classes.add(name); else classes.delete(name);
      return next;
    },
  };
  panel.querySelector = (selector) => {
    if (!panel.blocks.has(selector)) panel.blocks.set(selector, new FakeElement());
    return panel.blocks.get(selector);
  };
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, canvas: null, stage: null, storage: null,
  });

  // Исходная жалоба: свойства области, затем сворачивание — рейл вместо дока.
  clickPanel(panel, 'screen', { 'data-screen': 'properties' });
  assert.equal(api.screen(), 'properties');
  clickPanel(panel, 'collapse');
  assert.equal(api.collapsed(), true, 'кнопка сворачивания скрывает тело панели');
  assert.equal(panel.querySelector('[data-action="expand"]').getAttribute('aria-expanded'), 'false');

  clickPanel(panel, 'expand');
  assert.equal(api.screen(), 'dependencies', 'рейл ведёт в граф связей модулей');
  assert.equal(api.collapsed(), false, 'свёртка снята');
  assert.equal(panel.querySelector('[data-action="expand"]').getAttribute('aria-expanded'), 'true');
  const html = blockHtml(panel, 'modules');
  assert.match(html, /data-editor-graph/, 'граф модулей отрисован');
  assert.match(html, /data-editor-screen="dependencies"/);
  // Документ и история при этом не трогаются: это навигация, а не правка.
  assert.equal(api.doc().events.length, 0);
  assert.equal(api.session().past.length, 0);
  api.destroy();
});
