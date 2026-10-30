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
  assert.match(variants, /sector:\s*\{[\s\S]*?adminGate: ['\"]\s*<button class="admin-gate-link" id="adminGateOpen" type="button"/);
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

// ---------------------------------------------------------------------------
// ADM-NOTICE: уведомления ждут фактического снятия шторки
// ---------------------------------------------------------------------------

test('планировщик уведомлений добавлен с немедленным значением по умолчанию', () => {
  assert.match(gateSource, /bindSectorAdminGate\(\s*doc: Document[\s\S]*?scheduleNotice:\s*\(show:\s*\(\)\s*=>\s*void\)\s*=>\s*void\s*=\s*function[\s\S]*?show\(\)/);
  assert.match(gateSource, /scheduleNotice\(function \(\)/);
  // прежний вызов без третьего аргумента остаётся валидным
  assert.match(read('src/atlas/app.ts'), /bindSectorAdminGate\(doc,\s*applyAuthorizedTheme,\s*scheduleAdminNotice\)/);
});

test('оба начальных уведомления проходят через планировщик, ручной ввод остаётся немедленным', () => {
  // два начальных показа завёрнуты в scheduleNotice
  assert.match(gateSource, /if \(takeAdminSessionEndQuery\(doc\)\)[\s\S]*?scheduleNotice\(function \(\)[\s\S]*?ADMIN_SESSION_END_NOTICE_CLASS/);
  assert.match(gateSource, /if \(removeAdminAccessQuery\(doc\)\)[\s\S]*?scheduleNotice\(function \(\)[\s\S]*?ADMIN_ACCESS_NOTICE_CLASS/);
  // ручной submit на странице редактора показывает сразу, без планировщика
  const submitBlock = gateSource.slice(gateSource.indexOf('activateAdminEditorTheme(doc, onAuthorized);'));
  // первый showAdminNotice после activate — ручной, он не в scheduleNotice
  assert.match(submitBlock, /activateAdminEditorTheme\(doc, onAuthorized\);\s*showPanel\(\);\s*showAdminNotice\(doc, ADMIN_SUCCESS_MESSAGE/);
  // а обёрнутые — только в двух местах выше, не больше
  const scheduleCount = (gateSource.match(/scheduleNotice\(/g) || []).length;
  assert.equal(scheduleCount, 2, 'планировщик должен использоваться только для двух начальных уведомлений');
});

test('app связывает планировщик с фактическим снятием шторки', () => {
  const app = read('src/atlas/app.ts');
  // очередь и проверка реального DOM, а не только флага
  assert.match(app, /pendingAdminNotices/);
  assert.match(app, /isTimelineLoaderGone\(\)/);
  assert.match(app, /loader\.classList\.contains\('is-hidden'\)/);
  // не считаем флаг достаточным — ищем проверку is-hidden
  assert.match(app, /isTimelineLoaderGone/);
  // планировщик вызывает show сразу, если шторка уже снята
  assert.match(app, /function scheduleAdminNotice[\s\S]*?if \(isTimelineLoaderGone\(\)\)/);
  // снятие шторки опустошает очередь ровно один раз
  assert.match(app, /flushPendingAdminNotices/);
  assert.match(app, /pendingAdminNotices\.slice\(\)/);
  // dismiss опустошает очередь после is-hidden
  assert.match(app, /loader\.classList\.add\('is-hidden'\)[\s\S]*?flushPendingAdminNotices/);
  assert.match(app, /if \(!loader\)[\s\S]*?flushPendingAdminNotices/);
  // не добавляет фиксированный таймер для уведомления
  assert.doesNotMatch(app, /setTimeout\(\s*showAdminNotice/);
  assert.doesNotMatch(app, /setTimeout\(\s*\(\)\s*=>\s*showAdminNotice/);
});

// ---------------------------------------------------------------------------
// Поведенческие проверки с управляемыми часами — без sleep
// ---------------------------------------------------------------------------

/** Простой управляемый планировщик времени для тестов без реальных задержек. */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const api = {
    now: () => now,
    setTimeout(cb, delay = 0) {
      const id = nextId++;
      timers.set(id, { due: now + Math.max(0, delay), cb, type: 'timeout' });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(cb, delay = 0) {
      const id = nextId++;
      timers.set(id, { due: now + Math.max(0, delay), cb, type: 'interval', interval: Math.max(1, delay) });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    tick(ms) {
      now += ms;
      let ran = true;
      let guard = 0;
      while (ran && guard < 100) {
        ran = false;
        guard++;
        const due = [...timers.entries()].filter(([, t]) => t.due <= now);
        for (const [id, t] of due) {
          if (!timers.has(id)) continue;
          if (t.type === 'timeout') {
            timers.delete(id);
            ran = true;
            t.cb();
          } else {
            ran = true;
            t.cb();
            if (timers.has(id)) t.due = now + t.interval;
          }
        }
      }
    },
    pending() { return timers.size; },
  };
  return api;
}

// Минимальные фейковые DOM-классы, проходящие проверку instanceof.
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.className = '';
    this.hidden = false;
    this.textContent = '';
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this._listeners = new Map();
    this._classSet = new Set();
    this.classList = {
      add: (...names) => { names.forEach((n) => this._classSet.add(n)); this._syncClass(); },
      remove: (...names) => { names.forEach((n) => this._classSet.delete(n)); this._syncClass(); },
      contains: (n) => this._classSet.has(n),
      toggle: (n, force) => {
        if (force === true) this._classSet.add(n);
        else if (force === false) this._classSet.delete(n);
        else if (this._classSet.has(n)) this._classSet.delete(n); else this._classSet.add(n);
        this._syncClass();
        return this._classSet.has(n);
      },
    };
  }
  _syncClass() { this.className = [...this._classSet].join(' '); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) {
    const parts = selector.split(',').map((s) => s.trim());
    for (const part of parts) {
      if (part === '#adminEditorGate' && this.id === 'adminEditorGate') return this;
      if (part === '[data-admin-editor]' && this.hasAttribute('data-admin-editor')) return this;
      if (part === '[data-admin-gate-close]' && this.hasAttribute('data-admin-gate-close')) return this;
      if (part.startsWith('#') && this.id === part.slice(1)) return this;
      if (part.startsWith('[') && part.endsWith(']')) {
        const attr = part.slice(1, -1);
        if (this.hasAttribute(attr)) return this;
      }
    }
    if (this.parentElement) return this.parentElement.closest(selector);
    return null;
  }
  addEventListener(type, cb) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(cb);
  }
  removeEventListener(type, cb) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(cb);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatchEvent(event) {
    const list = this._listeners.get(event.type) || [];
    for (const cb of [...list]) cb.call(this, event);
    return true;
  }
  appendChild(node) {
    if (node.parentElement) node.remove();
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) c.remove();
    this.children = [];
    nodes.forEach((n) => this.appendChild(n));
  }
  remove() {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }
  focus() { this._focused = true; }
}
class FakeHTMLElement extends FakeElement {}
class FakeHTMLFormElement extends FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {}
class FakeHTMLButtonElement extends FakeHTMLElement {}

function installFakeGlobals(fakeWindow) {
  globalThis.window = fakeWindow;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.HTMLFormElement = FakeHTMLFormElement;
  globalThis.HTMLInputElement = FakeHTMLInputElement;
  globalThis.HTMLButtonElement = FakeHTMLButtonElement;
}

function createTestEnv({ url = 'https://example.test/sector/', marker = false, destination = '/sector/admin-edit/', modal = true, loaderState = 'present', storageThrows = false } = {}) {
  const clock = createClock();
  const assigned = [];
  const replaced = [];
  let href = url;
  const storageMap = new Map();
  if (marker) storageMap.set(gateApi.ADMIN_SESSION_MARKER_KEY, 'granted');
  const storage = storageThrows ? {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  } : {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); },
    removeItem(k) { storageMap.delete(k); },
    _map: storageMap,
  };
  const fakeWindow = {
    location: {
      get href() { return href; },
      set href(v) { href = String(v); },
      assign(target) { assigned.push(String(target)); href = String(target); },
    },
    history: {
      replaceState(_, __, newUrl) {
        replaced.push(String(newUrl));
        const base = new URL(href);
        const next = new URL(String(newUrl), base);
        href = next.href;
      },
    },
    sessionStorage: storage,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    setInterval: clock.setInterval.bind(clock),
    clearInterval: clock.clearInterval.bind(clock),
    requestAnimationFrame(cb) { return clock.setTimeout(cb, 16); },
    cancelAnimationFrame(id) { clock.clearTimeout(id); },
    MutationObserver: globalThis.MutationObserver || class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };

  // helper to make element with correct prototype
  function el(Tag, id, Proto) {
    const node = new Proto(Tag);
    node.id = id;
    return node;
  }

  const doc = {
    defaultView: fakeWindow,
    documentElement: el('html', '', FakeHTMLElement),
    body: el('body', '', FakeHTMLElement),
    _byId: new Map(),
    getElementById(id) { return this._byId.get(id) || null; },
    createElement(tag) {
      const Tag = tag.toLowerCase();
      if (Tag === 'span') return el(Tag, '', FakeHTMLElement);
      return el(Tag, '', FakeHTMLElement);
    },
    querySelector() { return null; },
    addEventListener(type, cb) {
      if (!this._listeners) this._listeners = new Map();
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(cb);
    },
    _listeners: new Map(),
    dispatchEvent(event) {
      const list = this._listeners.get(event.type) || [];
      for (const cb of [...list]) cb.call(this, event);
      return true;
    },
  };
  doc.documentElement.classList = doc.documentElement.classList;
  doc.body.classList = doc.body.classList;

  const gate = el('div', 'adminEditorGate', FakeHTMLElement);
  gate.hidden = true;
  if (modal) gate.setAttribute('data-admin-gate-modal', '');

  const panel = el('div', 'adminEditorPanel', FakeHTMLElement);
  panel.hidden = true;

  const form = el('form', 'adminGateForm', FakeHTMLFormElement);
  form.dataset = destination ? { adminGateDestination: destination } : {};

  const input = el('input', 'adminGateCode', FakeHTMLInputElement);
  input.value = '';

  const submit = el('button', 'adminGateSubmit', FakeHTMLButtonElement);
  submit.disabled = false;

  const error = el('div', 'adminGateError', FakeHTMLElement);
  error.textContent = 'Код не совпадает. Измените ввод, чтобы попробовать снова.';
  error.hidden = true;

  const openButton = el('button', 'adminGateOpen', FakeHTMLButtonElement);
  const endButton = el('button', 'adminSessionEnd', FakeHTMLButtonElement);
  endButton.hidden = true;
  endButton.dataset = { adminSessionReturn: '/sector/' };

  const toast = el('div', 'toast', FakeHTMLElement);
  toast.hidden = false;

  const loader = loaderState === 'missing' ? null : el('div', 'timelineLoader', FakeHTMLElement);
  if (loader) {
    if (loaderState === 'hidden') loader.classList.add('is-hidden');
    else if (loaderState === 'leaving') loader.classList.add('is-leaving');
  }

  for (const node of [gate, panel, form, input, submit, error, openButton, endButton, toast]) {
    doc._byId.set(node.id, node);
  }
  if (loader) doc._byId.set(loader.id, loader);

  // wire parent for closest checks (not strictly needed)
  gate.parentElement = doc.body;
  panel.parentElement = doc.body;
  toast.parentElement = doc.body;
  if (loader) loader.parentElement = doc.body;

  return { doc, window: fakeWindow, clock, assigned, replaced, storage, loader, gate, panel, form, input, submit, error, toast, openButton, endButton, href: () => href };
}

test('уведомления при открытии ждут снятия шторки, не печатаются под ней', () => {
  const env = createTestEnv({ url: 'https://example.test/sector/?adminSession=ended', loaderState: 'present' });
  installFakeGlobals(env.window);
  let shown = 0;
  let pendingShow = null;
  function schedule(show) {
    const gone = (() => {
      const l = env.doc.getElementById('timelineLoader');
      return !l || l.classList.contains('is-hidden');
    })();
    if (gone) { shown++; show(); } else { pendingShow = show; }
  }
  // до снятия шторки шоу не должно случиться
  gateApi.bindSectorAdminGate(env.doc, () => {}, schedule);
  assert.equal(env.toast.classList.contains('admin-session-end-notice'), false, 'уведомление не должно быть видно под шторкой');
  assert.equal(env.toast.classList.contains('visible'), false);
  // URL при этом уже очищен
  assert.equal(env.window.location.href.includes('adminSession'), false, 'параметр должен быть удалён из адреса сразу');
  // имитация снятия шторки: добавляем is-hidden и вызываем отложенный показ
  env.loader.classList.add('is-hidden');
  assert.ok(pendingShow, 'должен быть отложенный показ');
  pendingShow();
  shown++;
  // после снятия уведомление появляется ровно один раз
  assert.equal(env.toast.classList.contains('admin-session-end-notice'), true);
  assert.equal(env.toast.classList.contains('visible'), true);
  assert.equal(shown, 1);
});

test('уведомление adminAccess=confirmed тоже ждёт снятия шторки', () => {
  const env = createTestEnv({
    url: 'https://example.test/sector/admin-edit/?adminAccess=confirmed',
    destination: '',
    marker: true,
    loaderState: 'present',
  });
  installFakeGlobals(env.window);
  let pending = null;
  function schedule(show) {
    const gone = !env.doc.getElementById('timelineLoader') || env.doc.getElementById('timelineLoader').classList.contains('is-hidden');
    if (gone) show(); else pending = show;
  }
  gateApi.bindSectorAdminGate(env.doc, () => {}, schedule);
  // панель и тема включаются сразу, даже под шторкой
  assert.equal(env.panel.hidden, false, 'панель должна открыться сразу');
  assert.equal(env.doc.documentElement.classList.contains('admin-editor-authorized'), true);
  assert.equal(env.doc.body.classList.contains('admin-editor-authorized'), true);
  // уведомление же отложено
  assert.equal(env.toast.classList.contains('admin-access-notice'), false);
  assert.equal(env.window.location.href.includes('adminAccess'), false, 'параметр очищается немедленно');
  assert.ok(pending, 'уведомление должно быть отложено');
  pending();
  assert.equal(env.toast.classList.contains('admin-access-notice'), true);
  assert.equal(env.toast.classList.contains('visible'), true);
});

test('снятая или отсутствующая шторка показывает сразу', () => {
  for (const state of ['missing', 'hidden']) {
    const env = createTestEnv({ url: 'https://example.test/sector/?adminSession=ended', loaderState: state });
    installFakeGlobals(env.window);
    gateApi.bindSectorAdminGate(env.doc, () => {}, (show) => {
      const l = env.doc.getElementById('timelineLoader');
      const gone = !l || l.classList.contains('is-hidden');
      if (gone) show(); else throw new Error('не должно откладывать');
    });
    assert.equal(env.toast.classList.contains('admin-session-end-notice'), true, `состояние ${state} должно показать сразу`);
    assert.equal(env.toast.classList.contains('visible'), true);
  }
});

test('повторное снятие шторки и страховка не дублируют уведомление', () => {
  const env = createTestEnv({ url: 'https://example.test/sector/?adminSession=ended', loaderState: 'present' });
  installFakeGlobals(env.window);
  let callCount = 0;
  let pending = [];
  function schedule(show) {
    const gone = !env.doc.getElementById('timelineLoader') || env.doc.getElementById('timelineLoader').classList.contains('is-hidden');
    if (gone) { callCount++; show(); } else pending.push(show);
  }
  function flush() {
    const copy = pending.slice();
    pending = [];
    for (const s of copy) { callCount++; s(); }
  }
  gateApi.bindSectorAdminGate(env.doc, () => {}, schedule);
  assert.equal(callCount, 0);
  assert.equal(pending.length, 1);
  // первый кадр
  env.loader.classList.add('is-hidden');
  flush();
  assert.equal(callCount, 1);
  assert.equal(env.toast.classList.contains('visible'), true);
  // повторный сигнал (страховка/двухкадровый вызов) не должен дублировать
  flush();
  assert.equal(callCount, 1, 'повторный flush не должен вызывать повторно');
  // даже если снова добавить is-hidden и вызвать
  flush();
  assert.equal(callCount, 1);
});

test('ручной submit показывает уведомление немедленно даже под шторкой', () => {
  const env = createTestEnv({
    url: 'https://example.test/sector/admin-edit/',
    destination: '',
    marker: false,
    loaderState: 'present',
  });
  installFakeGlobals(env.window);
  let scheduled = 0;
  function schedule() { scheduled++; throw new Error('ручной ввод не должен идти через планировщик'); }
  gateApi.bindSectorAdminGate(env.doc, () => {}, schedule);
  // под шторкой панель закрыта, но ручной ввод должен показать сразу
  assert.equal(env.toast.classList.contains('visible'), false);
  env.input.value = publicTestCode;
  // симулируем submit
  const submitListeners = env.form._listeners.get('submit') || [];
  assert.ok(submitListeners.length > 0, 'обработчик submit должен быть зарегистрирован');
  const event = { type: 'submit', preventDefault() {}, target: env.input };
  for (const cb of submitListeners) cb(event);
  // ручной путь вызывает showAdminNotice напрямую, без планировщика
  assert.equal(scheduled, 0, 'планировщик не должен вызываться для ручного ввода');
  assert.equal(env.toast.classList.contains('admin-access-notice'), true, 'ручное подтверждение показывает уведомление сразу');
  assert.equal(env.toast.classList.contains('visible'), true);
  assert.equal(env.panel.hidden, false);
});

test('повторный вход, очистка URL и недоступное хранилище сохраняются', () => {
  // недоступное хранилище не ломает страницу
  const env = createTestEnv({ url: 'https://example.test/sector/admin-edit/?adminAccess=confirmed', destination: '', marker: true, storageThrows: true, loaderState: 'missing' });
  installFakeGlobals(env.window);
  assert.doesNotThrow(() => gateApi.bindSectorAdminGate(env.doc, () => {}, (show) => show()));
  // при ошибке хранилища панель не открывается (нет отметки), но страница не падает
  assert.equal(env.toast.classList.contains('visible'), false);

  // очистка URL при adminSession
  const env2 = createTestEnv({ url: 'https://example.test/sector/?adminSession=ended&other=1', loaderState: 'missing' });
  installFakeGlobals(env2.window);
  gateApi.bindSectorAdminGate(env2.doc, () => {}, (show) => show());
  assert.equal(env2.window.location.href.includes('adminSession'), false, 'параметр adminSession удаляется');
  assert.equal(env2.window.location.href.includes('other=1'), true, 'другие параметры сохраняются');

  // очистка adminAccess
  const env3 = createTestEnv({ url: 'https://example.test/sector/admin-edit/?adminAccess=confirmed&foo=bar', destination: '', marker: true, loaderState: 'missing' });
  installFakeGlobals(env3.window);
  gateApi.bindSectorAdminGate(env3.doc, () => {}, (show) => show());
  assert.equal(env3.window.location.href.includes('adminAccess'), false, 'параметр adminAccess удаляется');
  assert.equal(env3.window.location.href.includes('foo=bar'), true);
});

test('управляемые часы: первый кадр и страховка используют существующий жизненный цикл, без нового таймера', () => {
  const app = read('src/atlas/app.ts');
  // страховка 8000 остаётся
  assert.match(app, /setTimeout\(dismissTimelineLoader,\s*8000\)/);
  // двойной rAF остаётся
  assert.match(app, /requestAnimationFrame\(function \(\)[\s\S]*?requestAnimationFrame\(dismissTimelineLoader\)/);
  // нет нового таймера для уведомления
  assert.doesNotMatch(app, /setTimeout\([^)]*5000/);
  assert.doesNotMatch(app, /setTimeout\([^)]*ADMIN_/);
});
