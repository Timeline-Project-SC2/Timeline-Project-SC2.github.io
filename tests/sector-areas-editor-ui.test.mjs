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
  isDrawButton,
  parseExported,
  requestMaterial,
  strokePoints,
} from '../src/atlas/sector-areas-editor-ui.ts';
import { addAreaFromSectorCell, addAreaFromStroke, canFillArea, createEditorSession, exportDoc } from '../src/atlas/sector-areas-editor.ts';
import { TOOL_IDS } from '../src/atlas/sector-areas-tools.ts';
import {
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
  return {
    blocks,
    handlers,
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
    stopPropagation() {},
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
