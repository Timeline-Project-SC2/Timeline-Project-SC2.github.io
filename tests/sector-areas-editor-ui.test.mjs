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
  moduleGraphHtml,
  parseExported,
  requestMaterial,
  snappedStrokePreviewPoints,
  strokePoints,
} from '../src/atlas/sector-areas-editor-ui.ts';
import { addAreaFromSectorCell, addAreaFromStroke, canFillArea, createEditorSession, exportDoc, setSnapMode, snapAndRecordStroke } from '../src/atlas/sector-areas-editor.ts';
import { buildAreaPaints } from '../src/atlas/sector-areas-render.ts';
import { levelForWidth } from '../src/atlas/level-ladder.ts';
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
  // Красная и серая «сигнатуры» удалены: прежняя бирюзовая тема, крупный текст.
  assert.match(css, /\.admin-editor-authorized \.left-panel \{/);
  assert.doesNotMatch(css, /rgba\(212, 112, 133|rgba\(25, 11, 16|rgba\(20, 10, 14|#b63f59|#e4a3b0|#f0a3b1/i);
  assert.match(css, /\.admin-editor-panel\s*\{[\s\S]*?font-size: 22px;/);
  assert.match(css, /html\.admin-editor-authorized body\.admin-editor-authorized \.toast\.admin-access-notice\s*\{[\s\S]*?border-color: rgba\(46, 245, 230, \.72\);/);
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
  const attrs = new Map();
  const classes = new Set();
  return {
    blocks,
    handlers,
    attrs,
    classes,
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
    classList: {
      toggle(name, value) {
        if (value) classes.add(name);
        else classes.delete(name);
        return value;
      },
      contains(name) { return classes.has(name); },
    },
  };
}

/** Разметка блока панели: «Модули», «Свойства» или «Изменения». */
const blockHtml = (panel, name) => panel.blocks.get(`[data-editor-block="${name}"]`).innerHTML;
/** Разметка независимого левого host навигации. */
const navigationHtml = (navigation) => navigation.blocks.get('[data-editor-navigation-content]').innerHTML;

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
  assert.doesNotMatch(blockHtml(panel, 'modules'), /admin-editor-tools/);
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
  const navigation = fakePanel();
  // Глобал нужен только на время привязки: сам обработчик к `window` не ходит.
  globalThis.window = win;
  let api;
  try {
    api = createSectorAreasEditorUi({ kernel: fakeKernelWithFactions(doc), panel, navigation, canvas: null, storage: fakeStorage() });
  } finally {
    delete globalThis.window;
  }
  return { api, panel, navigation, keydown: win.handlers.get('keydown') };
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

test('системная шторка показывает все плоскости, а правый редактор делит модуль на блоки', () => {
  const panel = fakePanel();
  const navigation = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, navigation, canvas: null, stage: null, storage: null,
  });
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  const modules = blockHtml(panel, 'modules');
  const properties = blockHtml(panel, 'properties');
  const changes = blockHtml(panel, 'changes');
  const nav = navigationHtml(navigation);

  assert.match(nav, /data-editor-nav/);
  assert.match(nav, /Контекст карты/);
  assert.match(nav, /Системы/);
  assert.match(nav, /Связи данных/);
  assert.match(nav, /Пространственное влияние/);
  assert.match(nav, /Порядок отрисовки/);
  assert.equal((nav.match(/class="admin-editor-plane"/g) ?? []).length, 3, 'все три плоскости видимы одновременно');
  assert.equal((nav.match(/data-action="module"/g) ?? []).length, SECTOR_MODULES.length);
  assert.match(nav, /data-action="toggle-enable"/);
  assert.doesNotMatch(nav, /admin-editor-options-bar|admin-editor-modules-bar|data-action="plane"/);
  assert.doesNotMatch(modules, /data-editor-nav/, 'системной шторки нет внутри правого редактора');
  assert.match(modules, /class="admin-editor-shell"/);
  assert.match(modules, /data-editor-screen="module"/);
  assert.match(modules, /admin-editor-module-overview/);
  assert.match(modules, /Выбранный модуль · демо, не отправлено/);
  assert.match(modules, /Живые значения/);
  assert.match(modules, /admin-editor-dependency-block" data-direction="in"/);
  assert.match(modules, /admin-editor-dependency-block" data-direction="out"/);
  assert.match(modules, /Действия модуля/);
  const blockOrder = [
    'admin-editor-module-description',
    'data-direction="in"',
    'data-direction="out"',
    'admin-editor-context-block',
    'admin-editor-values-block',
    'admin-editor-actions-block',
  ].map((marker) => modules.indexOf(marker));
  assert.ok(blockOrder.every((index) => index >= 0));
  assert.ok(blockOrder.every((index, i) => i === 0 || index > blockOrder[i - 1]), 'описание → связи → контекст → значения → действия');
  assert.doesNotMatch(modules, /data-editor-graph/, 'граф не открыт одновременно с карточкой модуля');
  assert.doesNotMatch(modules, /admin-editor-tools/, 'инструменты рисования не открыты одновременно с карточкой модуля');
  assert.match(properties, /data-action="select"/, 'свойства области формируются в опорном блоке properties');
  assert.match(changes, /data-action="download"/, 'журнал и выгрузка формируются в опорном блоке changes');

  // Выбор модуля в системной шторке меняет только содержимое правого редактора.
  const before = api.doc();
  clickPanel(navigation, 'module', { 'data-module': 'sector-areas-snap' });
  assert.equal(api.doc(), before, 'смена модуля не меняет документ');
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  assert.match(blockHtml(panel, 'modules'), /Привязка к адресной сетке/);
  assert.match(navigationHtml(navigation), /data-module="sector-areas-snap" aria-current="page"/);
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

test('зелёный grid preview координатно совпадает с Chaikin-контуром итогового рендера', () => {
  const viewport = { w: 1000, h: 1000 };
  const camera = { centerX: 500, centerY: 500, visibleWidth: 1000 };
  const input = [[83, 352], [483, 102], [963, 77], [884, 238], [643, 454]];

  for (const closed of [false, true]) {
    const suffix = closed ? 'closed' : 'open';
    const preview = snappedStrokePreviewPoints(input, viewport, camera, { closed });
    let session = createEditorSession(emptySectorAreasDoc());
    session = setSnapMode(session, 'grid');
    session = snapAndRecordStroke(session, {
      stroke: { id: `stroke-preview-${suffix}`, points: input, closed },
      areaIdIfNew: `area-preview-${suffix}`,
      areaNameIfNew: 'Предпросмотр',
      state: createDefaultState(`state-preview-${suffix}`, 'political'),
    }, viewport, camera);
    const saved = session.doc.areas[0].strokes[0];
    const paints = buildAreaPaints(session.doc, { level: levelForWidth(camera.visibleWidth) });
    const painted = paints.find((paint) => paint.strokeIds?.includes(`stroke-preview-${suffix}`));

    assert.ok(painted, `${suffix}: сохранённый штрих реально попадает в итоговый слой отрисовки`);
    assert.deepEqual(preview, painted.rings[0].points, `${suffix}: preview = RDP + Chaikin итогового состояния`);
    assert.notDeepEqual(preview, saved.points, `${suffix}: диагональные срезы видны до завершения ввода`);
    assert.ok(preview.length > saved.points.length, `${suffix}: один проход Chaikin добавляет вершины срезов`);
    for (const [x, y] of saved.points) {
      const onVertical = Math.abs(x - Math.round(x / 80) * 80) < 1e-6;
      const onHorizontal = Math.abs(y - Math.round(y / 80) * 80) < 1e-6;
      assert.ok(onVertical || onHorizontal, `${suffix}: сглаженные preview-точки не сохраняются вместо привязки к сетке`);
    }
  }
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
  const navigation = fakePanel();
  const api = createSectorAreasEditorUi({
    kernel: fakeKernelWithFactions(docWithArea()), panel, navigation, canvas: null, stage: null, storage: null,
  });
  const initialDoc = api.doc();

  for (const screen of ['draw', 'properties', 'changes', 'dependencies']) {
    clickPanel(navigation, 'screen', { 'data-screen': screen });
    assert.equal(api.screen(), screen);
    assert.equal(panel.getAttribute('data-active-screen'), screen);
    const modules = blockHtml(panel, 'modules');
    const nav = navigationHtml(navigation);
    assert.match(nav, /data-editor-nav/, `на экране ${screen} глобальная навигация остаётся видимой`);
    assert.match(nav, new RegExp(`data-screen="${screen}" aria-current="page"`));
    assert.doesNotMatch(modules, /data-editor-nav/, 'рабочая панель не содержит второй навигации');
    if (screen !== 'dependencies') {
      assert.doesNotMatch(modules, /data-editor-graph/, `на экране ${screen} граф не занимает место`);
    }
  }

  // Переход по зависимости внутри карточки модуля и клавиатурный выбор узла SVG ведут к модулю.
  clickPanel(navigation, 'module', { 'data-module': 'sector-areas-editor' });
  assert.equal(api.screen(), 'module');
  assert.match(navigationHtml(navigation), /data-module="sector-areas-editor" aria-current="page"/);

  clickPanel(navigation, 'screen', { 'data-screen': 'dependencies' });
  const graphHtml = blockHtml(panel, 'modules');
  assert.match(graphHtml, /role="button" tabindex="0" aria-label="Привязка к адресной сетке — открыть модуль"/);
  assert.doesNotMatch(moduleGraphHtml('sector-areas-editor', 'all'), /admin-editor-planes/, 'список систем не дублируется под SVG-графом');

  // Мышь по-прежнему открывает модуль через обычное делегирование клика панели.
  clickPanel(panel, 'module', { 'data-module': 'sector-areas-snap' });
  assert.equal(api.screen(), 'module');
  assert.equal(panel.getAttribute('data-active-screen'), 'module');
  assert.match(navigationHtml(navigation), /data-module="sector-areas-snap" aria-current="page"/);
  assert.doesNotMatch(blockHtml(panel, 'modules'), /data-editor-graph/);

  assert.equal(api.doc(), initialDoc, 'навигация по экранам и системам не трогает документ');
  assert.equal(api.session().past.length, 0);
  api.destroy();
});

test('независимая навигация сворачивается, а на компактном экране закрывается после выбора экрана', () => {
  const panel = fakePanel();
  const navigation = fakePanel();
  const win = fakeWindow();
  let compact = true;
  win.matchMedia = () => ({ matches: compact });
  globalThis.window = win;
  let api;
  try {
    api = createSectorAreasEditorUi({
      kernel: fakeKernelWithFactions(docWithArea()), panel, navigation, canvas: null, stage: null, storage: null,
    });

    clickPanel(navigation, 'navigation-collapse');
    assert.equal(navigation.classList.contains('is-collapsed'), true);
    assert.equal(navigation.blocks.get('[data-action="navigation-expand"]').getAttribute('aria-expanded'), 'false');

    clickPanel(navigation, 'navigation-expand');
    assert.equal(navigation.classList.contains('is-collapsed'), false);
    assert.equal(navigation.blocks.get('[data-action="navigation-expand"]').getAttribute('aria-expanded'), 'true');
    clickPanel(navigation, 'screen', { 'data-screen': 'draw' });
    assert.equal(api.screen(), 'draw');
    assert.equal(navigation.classList.contains('is-collapsed'), true, 'на compact выбор оставляет один рабочий экран');

    clickPanel(navigation, 'navigation-expand');
    compact = false;
    clickPanel(navigation, 'module', { 'data-module': 'sector-areas-snap' });
    assert.equal(api.screen(), 'module');
    assert.equal(navigation.classList.contains('is-collapsed'), false, 'на desktop навигация остаётся рядом с картой');
  } finally {
    delete globalThis.window;
    api?.destroy();
  }
});

test('Enter и Space на SVG-узле проходят window-capture, а родные кнопки и поля сохраняют поведение', () => {
  const { api, panel, navigation, keydown } = editorWithKeys();

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
    assert.match(navigationHtml(navigation), /data-module="sector-areas-snap" aria-current="page"/);
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

test('системная шторка, прежняя компоновка и читаемый правый редактор закреплены в CSS и руководстве', () => {
  const css = read('site/sector/admin-edit/admin-edit.css');
  const source = read('src/atlas/sector-areas-editor-ui.ts');

  const navigationZ = Number(/\.map-stage \.admin-editor-navigation\s*\{\s*z-index:\s*(\d+)/.exec(css)?.[1]);
  const editorPanelZ = Number(/\.admin-editor-panel\s*\{[\s\S]*?z-index:\s*(\d+)/.exec(css)?.[1]);
  const detailPanelZ = Number(/\.map-stage \.detail-panel,\s*\.map-stage \.travel-panel\s*\{\s*z-index:\s*(\d+)/.exec(css)?.[1]);
  assert.ok(Number.isFinite(navigationZ) && Number.isFinite(editorPanelZ) && Number.isFinite(detailPanelZ));
  assert.ok(navigationZ > editorPanelZ, `системная шторка (${navigationZ}) выше рабочей панели (${editorPanelZ})`);
  assert.ok(navigationZ > detailPanelZ, `системная шторка (${navigationZ}) выше инспектора (${detailPanelZ})`);
  assert.match(source, /stage\.appendChild\(host\)/, 'host монтируется непосредственно в сцену карты');
  assert.match(source, /host\.setAttribute\('data-editor-navigation', ''\)/);
  assert.doesNotMatch(source, /data-editor-tool-rail|toolRail|navigationPlane/);
  assert.match(css, /\.admin-editor-authorized \.admin-editor-navigation\s*\{\s*display:\s*flex;\s*\}/);
  assert.match(css, /\.admin-editor-authorized \.left-panel,\s*\.admin-editor-authorized #toggleSidePanel,\s*\.admin-editor-authorized \.map-page-intro\s*\{\s*display:\s*none;\s*\}/);

  assert.match(css, /\.admin-editor-navigation\s*\{[\s\S]*?top: 86px;[\s\S]*?left: 14px;[\s\S]*?bottom: 14px;[\s\S]*?width: 288px;/);
  assert.match(css, /\.admin-editor-nav-group\s*>\s*\*,[\s\S]*?\.admin-editor-modules\s*>\s*li\s*\{[\s\S]*?min-width:\s*0;/);
  assert.match(css, /\.admin-editor-module-name\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.doesNotMatch(css, /\.admin-editor-options-bar|\.admin-editor-modules-bar|\.admin-editor-tool-rail/);
  assert.match(css, /\.admin-editor-panel\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?overflow-x:\s*hidden;/);
  assert.match(css, /\.admin-editor-panel\s*\{[\s\S]*?width: min\(420px, 38vw, calc\(100vw - 340px\)\);/);
  assert.match(css, /\.admin-editor-panel\s*\{[\s\S]*?font-size: 22px;/);
  assert.match(css, /\.admin-editor-detail-block/);
  assert.match(css, /\.admin-editor-panel\[data-active-screen="module"\] \.admin-editor-body > \.admin-editor-notice \{ display: none; \}/);
  assert.match(css, /\.admin-editor-panel\[data-active-screen="module"\] \.admin-editor-heading > div:first-child \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?:has\(\.admin-editor-navigation:not\(\.is-collapsed\)\) \.admin-editor-panel\s*\{[\s\S]*?visibility:\s*hidden;/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*?width:\s*min\(420px, calc\(100vw - 72px\)\)/);

  const guide = read('docs/admins/sector-areas-editor.md');
  assert.match(guide, /Панель и навигация «Системы»/);
  assert.match(guide, /снаружи правой рабочей панели/);
  assert.match(guide, /Obsidian/);
  assert.match(guide, /Photoshop/);
  assert.match(guide, /GIMP/);
  assert.match(guide, /Экран «Зависимости»/);
  assert.match(guide, /вдвое/);
});
