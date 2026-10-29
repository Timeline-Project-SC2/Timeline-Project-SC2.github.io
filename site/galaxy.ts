import type {
  FocusFxCamera,
  FocusFxFrameRect,
  FocusFxTargetRect,
} from './shared/focus-fx.ts';
import type { SiteLinks } from './shared/links.ts';

interface GalaxyView { s: number; tx: number; ty: number; }
interface GalaxyPoint { x: number; y: number; }
interface GalaxyDrag {
  readonly id: number;
  readonly sx: number;
  readonly sy: number;
  readonly tx: number;
  readonly ty: number;
  moved: boolean;
}
interface GalaxyStar { readonly x: number; readonly y: number; readonly r: number; readonly a: number; }
interface GalaxyConfig {
  readonly minFactor: number;
  readonly maxFactor: number;
  readonly wheelStep: number;
  readonly animateMs: number;
  readonly fitInset: number;
  readonly panMargin: number;
  readonly focusMs: number;
  readonly focusZoomDelay: number;
  readonly focusZoomMs: number;
  readonly focusZoomOutMs: number;
  readonly focusAnchorX: number;
  readonly focusZoom: number;
  readonly framePad: number;
  readonly frameMinVisible: number;
  readonly diveCenterMs: number;
  readonly diveZoomDelay: number;
  readonly diveZoomMs: number;
  readonly diveZooms: readonly number[];
  readonly spiral: {
    readonly enabled: boolean;
    readonly cx: number; readonly cy: number; readonly r: number;
    readonly arms: number; readonly pitch: number; readonly psi0: number;
    readonly bar: number; readonly barAngle: number; readonly barLength: number;
    readonly ecc: number; readonly speed: number; readonly count: number;
    readonly countPhone: number; readonly bulge: number; readonly diskK: number;
    readonly exposure: number; readonly contrast: number; readonly starSize: number;
    readonly trail: number; readonly opacity: number; readonly fps: number;
  };
}

(function (): void {
  'use strict';

  var stage = document.getElementById('galaxyStage') as HTMLElement;
  var layer = document.getElementById('mapLayer') as HTMLElement;
  var map = document.getElementById('galaxyMap') as HTMLImageElement;
  var hotspot = document.getElementById('sectorHotspot') as HTMLElement;
  var panel = document.getElementById('sectorPanel') as HTMLElement;
  var panelTitle = document.getElementById('sectorPanelTitle') as HTMLElement;
  var closeBtn = document.getElementById('closeSectorPanel') as HTMLElement;
  var iconBtn = document.getElementById('sectorIconButton') as HTMLElement;
  var loader = document.getElementById('timelineLoader') as HTMLElement;
  var toggle = document.getElementById('sectorsToggle') as HTMLElement;
  var sectorsList = document.getElementById('sectorsList') as HTMLElement;
  var zoomInBtn = document.getElementById('zoomIn') as HTMLElement;
  var zoomOutBtn = document.getElementById('zoomOut') as HTMLElement;
  var resetBtn = document.getElementById('resetMap') as HTMLElement;
  var zoomPercent = document.getElementById('zoomPercent') as HTMLElement;
  var preview = document.getElementById('sectorPreview') as HTMLElement;

  /* ---------- возврат со страницы сектора ----------
     Кнопка «к галактике» ставит флаг в sessionStorage. При возврате консоль не
     проигрывается, а доступ к ОЗД (его блокировка) восстанавливается. Обычная
     загрузка галактики, как раньше, сбрасывает всё. */
  var returnedFromSector = false;
  try {
    returnedFromSector = sessionStorage.getItem('galaxyReturn') === '1';
    sessionStorage.removeItem('galaxyReturn');
    if (!returnedFromSector) sessionStorage.removeItem('odzLocked');
  } catch {}

  /* ---------- loader: полный логотип не меньше 1.6 с ---------- */
  function dismissLoader() {
    window.setTimeout(function () {
      if (loader) loader.style.display = 'none';
      if (!returnedFromSector) startBootConsole();
    }, 1600);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', dismissLoader);
  } else {
    dismissLoader();
  }

  /* ---------- консоль после загрузки ----------
     Печатает скрипт сверху вниз, синим, на чёрной полупрозрачной подложке.
     Висит 8 с, в конце «Welcome, Commander.». На мобильных в 4 раза быстрее (2 с).
     Скорость печати подстраивается под частоту кадров, а не под число тиков. */
  var BOOT_SCRIPT = [
    'system> init secure_link --atlas timeline',
    'system> auth commander_id=0x7F2A clearance=LEVEL-4 ... ok',
    'system> request access: space-data: xx:xx:2513',
    'system> request access: directorate_fleet/ued_space ... pending',
    'system> -redirect from=<Station_Terminal_№11.>',
    'system> route: Station_Terminal_№11 -> UED_SPACE ... ok',
    'system> scanning registry: 3182 nodes, 19245 links',
    'system> decrypt KopruluSectorData2513 ........ ok',
    'system> bypass firewall proxy=10.431.3182.19245',
    'system> handshake [##########------] 62%',
    'system> handshake [################] 100%',
    'system> session_token = 4f:9c:12:e0:aa:31:0b',
    'system> checksum 02931-8549-2022-301855 ... match',
    'system> mount /zerus/archive/cam#001 ... ok',
    'system> mount /zerus/archive/cam#002 ... ok',
    'system> if (clearance < 4) { deny(); } // skipped',
    'system> for node in registry: sync(node)',
    'system> sync 3182/3182 ... done',
    'system> access granted: space-data',
    '...',
    '...',
    '...',
    'Welcome, Commander.'
  ];
  var BOOT_TOTAL_MS = 9500;
  var BOOT_TOTAL_MOBILE_MS = 2500;
  var BOOT_FADE_MS = 400;
  var BOOT_LINE_PAUSE_MS = 90;
  var BOOT_TICK_MS = 16;
  var bootTimer: number | null = null;
  var bootHideTimer: number | null = null;
  var bootClosed = false;
  var bootWired = false;

  function closeBootConsole() {
    if (bootClosed) return;
    bootClosed = true;
    if (bootTimer) window.clearTimeout(bootTimer);
    if (bootHideTimer) window.clearTimeout(bootHideTimer);
    var box = document.getElementById('bootConsole');
    if (!box || box.hidden) return;
    box.classList.add('is-out');
    window.setTimeout(function () {
      box!.hidden = true;
      box!.classList.remove('is-out');
    }, BOOT_FADE_MS);
  }

  function startBootConsole() {
    var box = document.getElementById('bootConsole');
    var body = document.getElementById('bootConsoleBody');
    var closeBtn = document.getElementById('bootConsoleClose');
    if (!box || !body) return;
    if (!bootWired && closeBtn) {
      bootWired = true;
      closeBtn.addEventListener('click', closeBootConsole);
    }

    var mobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
    var total = mobile ? BOOT_TOTAL_MOBILE_MS : BOOT_TOTAL_MS;
    var pause = mobile ? 25 : BOOT_LINE_PAUSE_MS;
    var chars = 0;
    BOOT_SCRIPT.forEach(function (s) { chars += s.length; });
    // 85 % общего времени уходит на печать, остальное — дочитать последнюю строку
    var charMs = Math.max(0.5, (total * 0.85 - BOOT_SCRIPT.length * pause) / chars);

    box.hidden = false;
    body.innerHTML = '';
    var li = 0, ci = 0;
    var row: HTMLDivElement | null = null;
    var textNode: Text | null = null;
    var waitUntil = 0, acc = 0, last = performance.now(), done = false;

    function newRow() {
      row = document.createElement('div');
      row.className = 'boot-console-line';
      textNode = document.createTextNode('');
      var cursor = document.createElement('span');
      cursor.className = 'boot-console-cursor';
      cursor.textContent = '▌';
      row.appendChild(textNode);
      row.appendChild(cursor);
      body!.appendChild(row);
    }

    function schedule() {
      if (!done) bootTimer = window.setTimeout(tick, BOOT_TICK_MS);
    }

    function tick() {
      bootTimer = null;
      var now = performance.now();
      var dt = now - last;
      last = now;
      if (now < waitUntil) { schedule(); return; }
      acc += dt;
      while (acc >= charMs && !done) {
        acc -= charMs;
        if (li >= BOOT_SCRIPT.length) { done = true; break; }
        if (!row) newRow();
        var text = BOOT_SCRIPT[li]!;
        if (ci < text.length) {
          ci++;
          textNode!.nodeValue = text.slice(0, ci);
        } else {
          // строка готова: следующая начнётся после короткой паузы
          li++;
          ci = 0;
          row = null;
          waitUntil = now + pause;
          acc = 0;
          break;
        }
      }
      body!.scrollTop = body!.scrollHeight;
      schedule();
    }

    bootHideTimer = window.setTimeout(closeBootConsole, total);
    schedule();
  }

  if (!hotspot || !stage || !map || !layer) return;

  // Картинка карты из links.js (если задана) — запасной src; при srcset браузер берёт файл оттуда
  var links: Partial<SiteLinks> = window.SITE_LINKS || {};
  if (links.galaxyMapImage) map.setAttribute('src', links.galaxyMapImage);

  /* «Лаги» карты (/shared/lag-fx.js): полосы съезжают, волна, линии-преломления.
     Во время выбора, снятия выбора и перехода они выключены, чтобы не разрывать
     прорисовывающиеся границы. В покое эффект работает как обычно. */
  if (window.LagFx) {
    window.LagFx.attach(map, {
      busy: function () {
        var fx = window.FocusFx ? window.FocusFx.active() : null;
        return busy || fx === 'select' || fx === 'release' || fx === 'go' || fx === 'idle';
      }
    });
  }

  var sectorName = hotspot.getAttribute('data-name') || 'Сектор';
  var defaultHref = (window.SITE_LINKS && window.SITE_LINKS.sectorPage) || '/sector/';

  // Параметры — как на странице сектора (app.js → CONFIG.view)
  var CONFIG: GalaxyConfig = {
    minFactor: 0.62,     // отъехать от режима «вся карта»
    maxFactor: 8,        // предел приближения (исходник карты 3000px)
    wheelStep: 0.0016,
    animateMs: 340,
    fitInset: 1,
    panMargin: 0.26,     // небольшой запас для кадрирования data-frame у края карты

    /* Первый клик по области — тайминг, мс. После того как рамка сжалась до области:
       центрирование → пауза → приближение. Каждое значение влияет только на свой отрезок. */
    focusMs: 520,         // центрирование области
    focusZoomDelay: 1000, // пауза после центрирования перед приближением
    focusZoomMs: 650,     // ← приближение после центрирования (только первый клик)
    focusZoomOutMs: 650,  // отъезд, если зум уже выше целевого: сразу, до центрирования и паузы

    focusAnchorX: 0.4, // первый клик (телефон): где по горизонтали ставится квадрат в видимой области (0 — у левого края, 0.5 — по центру, 1 — у правого)
    focusZoom: 4.1,       // первый клик: зум до 410% (диапазон 400–420%)
    framePad: 0.06,       // первый клик: рамка выделения (data-frame) — по центру видимой области, с полями
                          // по 6 %; если на focusZoom она не помещается — зум меньше…
    frameMinVisible: 0.5, // видимая область уже половины сцены (телефон, панель на всю ширину) —
                          // рамку не вписываем, квадрат ставим по focusAnchorX

    /* Второй клик по Копрулу (переход) — тайминг, мс: рамка садится на контур квадрата →
       центрирование → пауза → приближение до diveZooms. Свои значения, от первого клика не
       зависят; сейчас такие же, как у него. */
    diveCenterMs: 520,    // центрирование квадрата
    diveZoomDelay: 1000,  // пауза перед приближением
    diveZoomMs: 650,      // приближение
    diveZooms: [20],      // до какого зума: 2000 %

    /* Спираль поверх карты (/shared/galaxy-spiral.js): звёзды текут по орбитам вокруг
       ядра, яркость каждой берётся из самой карты — на рукаве звезда разгорается, в
       промежутке гаснет, над HUD её нет. Поэтому узор совпадает с рисунком и стоит, а
       галактика «вращается». Слой — над картой, под «лагами», квадратами и прицелом. */
    spiral: {
      enabled: true,        // false — слоя нет
      // геометрия рисунка (измерена по карте): центр и радиус диска, % стороны карты
      cx: 49.5, cy: 50.9, r: 44,
      // орбиты: два рукава, закрутка против часовой наружу (pitch < 0), фаза psi0 и бар
      // подобраны разложением карты по логарифмическим спиралям; углы — в градусах
      arms: 2, pitch: -14, psi0: -144.5,
      bar: 0.62, barAngle: -48, barLength: 12, // бар: вытянутость, направление, полудлина (%)
      ecc: 0.2,             // вытянутость орбит диска: больше — звёзды гуще у рукавов
      speed: 0.14,          // скорость у ядра, рад/с (дальше от центра — медленнее);
                            // «+» — по часовой, как у Млечного Пути на рисунке
      count: 7000,          // звёзд на компьютере
      countPhone: 3000,     // звёзд на телефоне (меньшая сторона окна < 700 px)
      bulge: 0.12,          // доля звёзд в ядре и баре
      diskK: 2,             // профиль диска: меньше — больше звёзд на внешних рукавах
      exposure: 0.7,        // яркость звёзд
      contrast: 1,          // контраст рукавов: больше — уже рукава, темнее промежутки
      starSize: 2.8,        // размер звезды при 100 %, px (карта 1000 px; с зумом растёт как s^0.4)
      trail: 0,             // шлейф: 0 — нет, 0.3 — длинный
      opacity: 0.9,         // прозрачность слоя
      fps: 30               // кадров в секунду в покое; пока карта двигается — каждый кадр
    }
  };

  /* ---------- вид карты ----------
     Слой карты (#mapLayer) — квадрат со стороной base (= min сторона сцены).
     view.s — масштаб относительно «вся карта», (tx,ty) — левый верхний угол слоя.
     Хотспот живёт внутри слоя, его позиция и размер — в процентах карты,
     поэтому он совпадает с квадратом на карте при любом зуме и панораме. */
  var base = 0;
  var view: GalaxyView = { s: 1, tx: 0, ty: 0 };
  var anim: object | null = null;
  var focusTimer: number | null = null;
  var busy = false;

  function sceneSize(): { w: number; h: number } { return { w: stage.clientWidth, h: stage.clientHeight }; }
  function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

  // Края карты не упираются жёстко в экран: запас CONFIG.panMargin от размера сцены.
  function panRange(side: number, size: number): { min: number; max: number } {
    var margin = size * CONFIG.panMargin;
    if (side <= size) {
      var center = (size - side) / 2;
      return { min: center - margin, max: center + margin };
    }
    return { min: size - side - margin, max: margin };
  }

  function clampAxis(t: number, side: number, size: number): number {
    var range = panRange(side, size);
    return clamp(t, range.min, range.max);
  }

  function clampState(st: GalaxyView): GalaxyView {
    var sz = sceneSize();
    var out = { s: clamp(st.s, CONFIG.minFactor, CONFIG.maxFactor), tx: st.tx, ty: st.ty };
    var side = out.s * base;
    out.tx = clampAxis(out.tx, side, sz.w);
    out.ty = clampAxis(out.ty, side, sz.h);
    return out;
  }

  function clampView() {
    var c = clampState(view);
    view.s = c.s; view.tx = c.tx; view.ty = c.ty;
  }

  function fitView() {
    var sz = sceneSize();
    view = { s: 1, tx: (sz.w - base) / 2, ty: (sz.h - base) / 2 };
    clampView();
  }

  // Прямоугольник элемента с data-cx / data-cy / data-size (проценты карты) → координаты сцены
  function boxOf(el: Element): FocusFxTargetRect {
    var cx = parseFloat(el.getAttribute('data-cx') as string);
    var cy = parseFloat(el.getAttribute('data-cy') as string);
    var size = parseFloat(el.getAttribute('data-size') as string);
    var side = view.s * base;
    var w = side * size / 100;
    var x = view.tx + side * cx / 100;
    var y = view.ty + side * cy / 100;
    return { l: x - w / 2, t: y - w / 2, r: x + w / 2, b: y + w / 2, cx: x, cy: y, w: w };
  }

  // Рамка выделения области: data-frame="левый верх правый низ" в процентах карты (блок
  // области на карте — квадрат, картинки CAM, надписи). null — у элемента рамки нет.
  function frameData(el: Element): FocusFxFrameRect | null {
    var v = String(el.getAttribute('data-frame') || '').trim().split(/\s+/).map(parseFloat);
    if (v.length !== 4 || v.some(function (n) { return !isFinite(n); })) return null;
    // Координаты рамки ограничены реальной картой, а не могут выводить прицел за её край.
    v = v.map(function (n) { return clamp(n, 0, 100); });
    if (!(v[2]! > v[0]!) || !(v[3]! > v[1]!)) return null;
    return { l: v[0]!, t: v[1]!, r: v[2]!, b: v[3]! };
  }

  // Видимая часть карты: борд ограничен и камерой, и реальными краями карты.
  // Если камера смотрит в угол карты, две стороны проходят по viewport, две — по карте.
  function mapFrame(): FocusFxFrameRect {
    var sz = sceneSize();
    var side = view.s * base;
    return {
      l: Math.max(0, view.tx), t: Math.max(0, view.ty),
      r: Math.min(sz.w, view.tx + side), b: Math.min(sz.h, view.ty + side)
    };
  }

  function frameOf(el: Element): FocusFxFrameRect | null {
    var f = frameData(el);
    if (!f) return null;
    var side = view.s * base;
    return {
      l: view.tx + side * f.l / 100, t: view.ty + side * f.t / 100,
      r: view.tx + side * f.r / 100, b: view.ty + side * f.b / 100
    };
  }

  /* Чёткость картинки при приближении. Карта подключена через srcset (1200 / 2000 / 3000 px),
     sizes в разметке — сторона карты в покое (меньшая сторона окна): на первый кадр браузер
     берёт файл по размеру экрана. При приближении слой становится во много раз больше окна,
     поэтому sizes подтягивается под фактическую сторону слоя — браузер сам догружает файл
     крупнее и показывает прежний, пока новый не готов. Только вверх и с запасом ×3: первое же
     приближение сразу берёт самый крупный файл, без промежуточной загрузки, а на меньший файл
     карта обратно не переключается (лишняя загрузка и мерцание). */
  var mapSizes = Math.min(window.innerWidth, window.innerHeight) || 0;
  function sharpenMap(side: number): void {
    if (!(side > mapSizes)) return;
    mapSizes = Math.ceil(side * 3);
    map.sizes = mapSizes + 'px';
  }

  // Слой имеет реальный размер base·s (без CSS scale): картинка рисуется заново
  // в нужном разрешении и не растягивается растром, поэтому не «шакалится».
  // Двигаем только translate, округляя до целых px, чтобы край не мылился.
  function applyView() {
    var side = view.s * base;
    layer.style.width = side + 'px';
    layer.style.height = side + 'px';
    layer.style.transform = 'translate(' + Math.round(view.tx) + 'px,' + Math.round(view.ty) + 'px)';
    layer.style.setProperty('--s', String(view.s));
    zoomPercent.textContent = Math.round(view.s * 100) + '%';
    sharpenMap(side);
    positionPreview();
    if (window.FocusFx) window.FocusFx.refresh();
    parallaxRequest();
  }

  function layout() {
    var sz = sceneSize();
    var fresh = Math.min(sz.w, sz.h) * CONFIG.fitInset;
    if (!base) {
      base = fresh;
      fitView();
    } else {
      // при ресайзе сохраняем центр просмотра в координатах карты
      var cx = (sz.w / 2 - view.tx) / (view.s * base);
      var cy = (sz.h / 2 - view.ty) / (view.s * base);
      base = fresh;
      view.tx = sz.w / 2 - cx * view.s * base;
      view.ty = sz.h / 2 - cy * view.s * base;
      clampView();
    }
    applyView();
  }

  function zoomAt(x: number, y: number, factor: number): void {
    var next = clamp(view.s * factor, CONFIG.minFactor, CONFIG.maxFactor);
    if (next === view.s) return;
    var k = next / view.s;
    // точка под курсором остаётся на месте
    view.tx = x - (x - view.tx) * k;
    view.ty = y - (y - view.ty) * k;
    view.s = next;
    clampView();
    applyView();
  }

  function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }

  function animateTo(s: number, tx: number, ty: number, ms: number, done?: () => void): void {
    var from = { s: view.s, tx: view.tx, ty: view.ty };
    var to = clampState({ s: s, tx: tx, ty: ty });
    var token = {};
    var t0 = performance.now();
    anim = token;
    function step(now: number): void {
      if (anim !== token) return;               // отменено пользователем
      // ms ≤ 0 (тайминг в CONFIG выставили в 0) — сразу конечный вид, без деления на ноль
      var k = ms > 0 ? easeOutCubic(clamp((now - t0) / ms, 0, 1)) : 1;
      view.s = from.s + (to.s - from.s) * k;
      view.tx = from.tx + (to.tx - from.tx) * k;
      view.ty = from.ty + (to.ty - from.ty) * k;
      applyView();
      if (k < 1) { window.requestAnimationFrame(step); return; }
      anim = null;
      if (done) done();
    }
    window.requestAnimationFrame(step);
  }

  function cancelAnim() {
    anim = null;
    if (focusTimer) {
      window.clearTimeout(focusTimer);
      focusTimer = null;
    }
  }

  /* ---------- колесо, drag, pinch, двойной клик ---------- */
  function scenePoint(e: PointerEvent | MouseEvent): GalaxyPoint {
    var r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  stage.addEventListener('wheel', function (e) {
    if (busy) return;
    e.preventDefault();
    cancelAnim();
    var p = scenePoint(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * CONFIG.wheelStep));
  }, { passive: false });

  var pointers: Record<string, GalaxyPoint> = {};
  var drag: GalaxyDrag | null = null;
  var pinchDist = 0;
  var suppressClick = false;   // после реального drag click не считается выбором пустого места

  function isUi(target: EventTarget | null): boolean {
    var el = target as Element | null;
    return !!(el && typeof el.closest === 'function' &&
      el.closest('.sector-panel, .map-controls, .sectors-sidebar, .sectors-curtain, .sectors-backdrop, .map-hint'));
  }

  stage.addEventListener('pointerdown', function (e) {
    // Карту тащат левой кнопкой и колесом. Правая — контекстное меню, боковые — «назад» и
    // «вперёд» браузера: карту не двигают, и курсор перетаскивания на них не включается.
    if (e.button > 1) return;
    suppressClick = false;
    if (busy || isUi(e.target)) return;
    var p = scenePoint(e);
    pointers[e.pointerId] = p;
    cancelAnim();
    if (Object.keys(pointers).length === 1) {
      // Захват указателя ставим только при реальном drag, иначе click уйдёт на сцену
      drag = { id: e.pointerId, sx: p.x, sy: p.y, tx: view.tx, ty: view.ty, moved: false };
    } else {
      drag = null;
      pinchDist = 0;
    }
  });

  stage.addEventListener('pointermove', function (e) {
    if (!pointers[e.pointerId]) return;
    var p = scenePoint(e);
    pointers[e.pointerId] = p;
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]!]!, b = pointers[ids[1]!]!;
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
      pinchDist = d;
      return;
    }
    if (drag && drag.id === e.pointerId) {
      var dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true;
        try { stage.setPointerCapture(e.pointerId); } catch {}
        stage.classList.add('is-dragging');
      }
      if (drag.moved) {
        view.tx = drag.tx + dx;
        view.ty = drag.ty + dy;
        clampView();
        applyView();
      }
    }
  });

  function endPointer(e: PointerEvent): void {
    delete pointers[e.pointerId];
    if (drag && drag.id === e.pointerId) {
      if (drag.moved) suppressClick = true;
      drag = null;
      stage.classList.remove('is-dragging');
    }
    if (Object.keys(pointers).length < 2) pinchDist = 0;
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('dblclick', function (e) {
    if (busy || isUi(e.target)) return;
    var p = scenePoint(e);
    zoomAt(p.x, p.y, 1.8);
  });

  /* ---------- кнопки и клавиатура (как на странице сектора) ---------- */
  function center(): GalaxyPoint { return { x: sceneSize().w / 2, y: sceneSize().h / 2 }; }

  if (zoomInBtn) zoomInBtn.addEventListener('click', function () {
    if (busy) return; cancelAnim(); var c = center(); zoomAt(c.x, c.y, 1.45);
  });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', function () {
    if (busy) return; cancelAnim(); var c = center(); zoomAt(c.x, c.y, 1 / 1.45);
  });
  if (resetBtn) resetBtn.addEventListener('click', function () {
    if (busy) return;
    var sz = sceneSize();
    animateTo(1, (sz.w - base) / 2, (sz.h - base) / 2, CONFIG.animateMs);
  });

  document.addEventListener('keydown', function (e) {
    var tag = ((e.target as Element | null)?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || busy) return;
    if (e.key === 'Escape') { hidePanel(); return; }
    var c = center();
    if (e.key === '+' || e.key === '=') { cancelAnim(); zoomAt(c.x, c.y, 1.35); return; }
    if (e.key === '-' || e.key === '_') { cancelAnim(); zoomAt(c.x, c.y, 1 / 1.35); return; }
    if (e.key === '0') {
      var sz = sceneSize();
      animateTo(1, (sz.w - base) / 2, (sz.h - base) / 2, CONFIG.animateMs);
      return;
    }
    var pan = 60;
    var moved = true;
    cancelAnim();
    if (e.key === 'ArrowLeft') view.tx += pan;
    else if (e.key === 'ArrowRight') view.tx -= pan;
    else if (e.key === 'ArrowUp') view.ty += pan;
    else if (e.key === 'ArrowDown') view.ty -= pan;
    else moved = false;
    if (moved) { clampView(); applyView(); }
  });

  window.addEventListener('resize', layout);
  if (document.readyState === 'complete') layout();
  else window.addEventListener('load', layout);
  document.addEventListener('DOMContentLoaded', layout);

  /* ---------- звёздный фон как у сектора Копрулу ----------
     Повторяет drawSchematic из app.js: цвет #03060c, три цветных облака,
     900 звёзд с тем же генератором (зерно 100000), размер и прозрачность как там.
     Параллакс: фон перерисовывается со смещением от движения карты (view.tx/ty),
     а не от курсора. Смещение заворачивается по размеру холста, поэтому звёзды
     не упираются в край при любом перетаскивании. */
  var starfield = document.getElementById('galaxyStarfield') as HTMLCanvasElement | null;
  var PAR_PAN = 0.06;                 // звёзды едут в 6 % от сдвига карты
  var parReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var starState: { w: number; h: number; dpr: number; stars: GalaxyStar[] } = { w: 0, h: 0, dpr: 1, stars: [] };
  var paintedOff = { x: NaN, y: NaN };
  function starRandom(seed: number): () => number {
    var s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  function wrapMod(v: number, m: number): number { return ((v % m) + m) % m; }
  function parallaxOffset(): GalaxyPoint {
    if (parReduce) return { x: 0, y: 0 };
    // округляем до полпикселя, чтобы не перерисовывать на микро-сдвигах
    return { x: Math.round(view.tx * PAR_PAN * 2) / 2, y: Math.round(view.ty * PAR_PAN * 2) / 2 };
  }
  function paintStarfield(ox: number, oy: number): void {
    if (!starfield || !starfield.getContext || !starState.w) return;
    var w = starState.w, h = starState.h;
    var ctx = starfield.getContext('2d')!;
    ctx.setTransform(starState.dpr, 0, 0, starState.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#03060c';
    ctx.fillRect(0, 0, w, h);

    var size = Math.max(w, h);
    var clouds = [
      { x: 0.36, y: 0.30, r: 0.26, color: 'rgba(80,120,190,.16)' },
      { x: 0.62, y: 0.58, r: 0.30, color: 'rgba(180,120,60,.12)' },
      { x: 0.78, y: 0.30, r: 0.22, color: 'rgba(120,90,200,.10)' }
    ];
    clouds.forEach(function (cloud) {
      var radius = cloud.r * size;
      var bx = wrapMod(cloud.x * w + ox, w);
      var by = wrapMod(cloud.y * h + oy, h);
      for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
          var cx = bx + i * w, cy = by + j * h;
          if (cx + radius < 0 || cx - radius > w || cy + radius < 0 || cy - radius > h) continue;
          var gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          gradient.addColorStop(0, cloud.color);
          gradient.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        }
      }
    });

    ctx.fillStyle = '#cfe0f5';
    starState.stars.forEach(function (s) {
      var x = wrapMod(s.x + ox, w), y = wrapMod(s.y + oy, h);
      var rr = Math.max(0.5, s.r);
      // звезда у края рисуется и с противоположной стороны (шов не виден)
      var xs = [x];
      if (x < rr + 1) xs.push(x + w);
      if (x > w - rr - 1) xs.push(x - w);
      var ys = [y];
      if (y < rr + 1) ys.push(y + h);
      if (y > h - rr - 1) ys.push(y - h);
      ctx.globalAlpha = s.a;
      xs.forEach(function (px) {
        ys.forEach(function (py) {
          ctx.beginPath();
          ctx.arc(px, py, rr, 0, Math.PI * 2);
          ctx.fill();
        });
      });
    });
    ctx.globalAlpha = 1;
    paintedOff = { x: ox, y: oy };
  }
  function drawStarfield() {
    if (!starfield || !starfield.getContext) return;
    var host = starfield.parentNode as HTMLElement;
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return;
    var dpr = window.devicePixelRatio || 1;
    starfield.width = Math.round(w * dpr);
    starfield.height = Math.round(h * dpr);
    starfield.style.width = w + 'px';
    starfield.style.height = h + 'px';
    // та же последовательность случайных чисел, что и раньше: вид при нулевом смещении не меняется
    var random = starRandom(100000);
    var stars: GalaxyStar[] = [];
    for (var i = 0; i < 900; i++) {
      var x = random() * w;
      var y = random() * h;
      var r = 0.4 + random() * 1.5;
      var a = 0.12 + random() * 0.5;
      stars.push({ x: x, y: y, r: r, a: a });
    }
    starState = { w: w, h: h, dpr: dpr, stars: stars };
    var off = parallaxOffset();
    paintStarfield(off.x, off.y);
  }
  window.addEventListener('resize', drawStarfield);
  if (document.readyState === 'complete') drawStarfield();
  else window.addEventListener('load', drawStarfield);
  document.addEventListener('DOMContentLoaded', drawStarfield);

  /* ---------- спираль поверх карты (/shared/galaxy-spiral.js) ----------
     Холст встаёт в слой карты сразу после картинки и перед слоем «лагов»: над
     картой, но под «лагами», квадратами областей, прицелом и интерфейсом сцены.
     Положение и размер холста модуль ставит в % слоя и каждый кадр берёт вид
     отсюда, поэтому звёзды двигаются и масштабируются вместе с картой. Узор —
     яркость самой карты (без зелёного HUD). При «уменьшении движения» слоя нет. */
  (function () {
    var sp = CONFIG.spiral;
    if (!sp || !sp.enabled || !window.GalaxySpiral || !layer || !map) return;
    var phone = Math.min(window.innerWidth, window.innerHeight) < 700;
    window.GalaxySpiral.overlay({
      layer: layer,
      image: map,
      before: layer.querySelector('.lag-fx'),
      center: [sp.cx / 100, sp.cy / 100],
      radius: sp.r / 100,
      view: function () {
        var sz = sceneSize();
        return { s: view.s, tx: view.tx, ty: view.ty, base: base, w: sz.w, h: sz.h };
      },
      fps: sp.fps,
      opacity: sp.opacity,
      starSize: sp.starSize,
      patternGamma: sp.contrast,
      engine: {
        palette: 'map', flat: 1, pa: 0, fadeIn: 0.9,
        arms: sp.arms, pitch: sp.pitch, psi0: sp.psi0 * Math.PI / 180,
        bar: sp.bar, barAngle: sp.barAngle * Math.PI / 180, bulgeR: sp.barLength / sp.r,
        ecc: sp.ecc, speed: sp.speed, exposure: sp.exposure, trail: sp.trail, bulge: sp.bulge,
        diskK: sp.diskK,
        count: phone ? sp.countPhone : sp.count
      }
    });
  })();

  /* ---------- превью 300×300 при ховере на хотспот ---------- */
  // Ставим слева от квадрата, если места нет — справа; всегда внутри сцены.
  var previewAnchor = hotspot;

  function positionPreview() {
    if (!preview || !preview.classList.contains('is-on')) return;
    var W = preview.offsetWidth, H = preview.offsetHeight, gap = 18, edge = 8;
    var st = stage.getBoundingClientRect();
    var h = (previewAnchor || hotspot).getBoundingClientRect();
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var hl = h.left - st.left, hr = h.right - st.left;
    var hcy = (h.top + h.bottom) / 2 - st.top;
    var left = hl - gap - W;
    if (left < edge) left = hr + gap;
    if (left + W > sw - edge) left = clamp(hl + h.width / 2 - W / 2, edge, sw - W - edge);
    var top = clamp(hcy - H / 2, edge, sh - H - edge);
    preview.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  }

  function showPreview(anchor?: HTMLElement): void {
    anchor = anchor || hotspot;
    if (!preview || (panel && !panel.hidden) || busy) return;
    if (anchor.classList.contains('is-odz-locked')) return;
    previewAnchor = anchor;
    var img = preview.querySelector('img');
    var src = anchor.getAttribute('data-macket');
    if (img && src && img.getAttribute('src') !== src) img.setAttribute('src', src);
    preview.classList.add('is-on');
    positionPreview();
  }
  function hidePreview() {
    if (preview) preview.classList.remove('is-on');
  }

  hotspot.addEventListener('pointerenter', function (e) {
    if (e.pointerType === 'mouse') showPreview();
  });
  hotspot.addEventListener('pointerleave', hidePreview);
  hotspot.addEventListener('focus', function () {
    if (hotspot.matches(':focus-visible')) showPreview();
  });
  hotspot.addEventListener('blur', hidePreview);

  /* ---------- панель сектора: первый клик ---------- */
  // Панель общая для Копрулу и Зеруса. Для Зеруса: описание и картинка заменены на «no-data available».
  var panelInfo = document.getElementById('sectorPanelInfo') as HTMLElement | null;
  var noDataBox = document.getElementById('sectorNoData') as HTMLElement | null;
  var KOPRULU_INFO = panelInfo ? panelInfo.textContent : '';
  var ZERUS_NAME = 'Пространство Зеруса';
  var ZERUS_NODATA = 'no-data available';

  var ODZ_NAME = 'Пространство Директората';
  var iconImg = iconBtn ? iconBtn.querySelector('img') : null;
  var panelArea: HTMLElement | null = null;

  function showPanel(el?: HTMLElement): void {
    el = el || hotspot;
    var isZerus = el === zerus;
    var isOdz = el === odz;
    panelArea = el;
    hidePreview();
    if (panel) {
      if (panelTitle) panelTitle.textContent = isZerus ? ZERUS_NAME : (isOdz ? ODZ_NAME : sectorName);
      if (panelInfo) {
        panelInfo.textContent = isZerus ? ZERUS_NODATA : KOPRULU_INFO;
        panelInfo.classList.toggle('is-nodata', isZerus);
      }
      if (iconBtn) iconBtn.hidden = isZerus;
      if (iconImg) {
        var macket = el.getAttribute('data-macket');
        if (macket && iconImg.getAttribute('src') !== macket) iconImg.setAttribute('src', macket);
      }
      if (noDataBox) noDataBox.hidden = !isZerus;
      panel.hidden = false;
    }
    [hotspot, zerus, odz].forEach(function (x) {
      if (x && x !== el) x.classList.remove('is-selected', 'is-locked');
    });
    el.classList.add('is-selected');
  }

  // Только панель: при переходе она закрывается, а выбор и прицел остаются
  function closePanel() {
    if (panel) panel.hidden = true;
    panelArea = null;
  }

  // Квадраты — в обычное состояние, панель закрыта (без анимации прицела)
  function clearAreas() {
    closePanel();
    [hotspot, zerus, odz].forEach(function (x) {
      if (x) x.classList.remove('is-selected', 'is-locked');
    });
  }

  // Снять выбор (крестик панели, Esc, клик по пустому месту): прицел гаснет
  function hidePanel() {
    cancelAnim();
    clearAreas();
    window.FocusFx.release(function () {
      stage.classList.remove('is-red-target', 'is-odz-ping');
    });
  }

  /* Прицел при выборе (/shared/focus-fx.js): линии входят с границ viewport, рисуют
     борд карты и ведут его при сжатии до data-frame. Затем камера сначала центрирует
     область, а через паузу отдельно приближает её. Рамка остаётся привязана к карте.
     Цвет: Копрулу и ОЗД — зелёный, Зерус — красный. */
  function selectArea(el: HTMLElement, onContract?: (() => void) | null): void {
    cancelAnim();
    stage.classList.toggle('is-red-target', el === zerus);
    stage.classList.toggle('is-odz-ping', el === odz);
    window.FocusFx.select({
      stage: stage,
      target: function () { return boxOf(el); },
      frame: function () { return frameOf(el); },
      mapFrame: mapFrame,
      instant: true,
      onLock: function () { if (panelArea === el) el.classList.add('is-locked'); },
      onContract: onContract || null
    });
  }

  // Выбор Копрулу: первый вызов — панель + сдвиг; повторный по выбранному — переход.
  // Вызывается и кликом по квадрату на карте, и кликом по пункту в шторке.
  function activateKoprulu() {
    if (busy) return;
    if (hotspot.classList.contains('is-selected')) {
      runTransition(hotspot, defaultHref);
      return;
    }
    showPanel();
    selectArea(hotspot, function () { focusArea(hotspot); });
  }

  hotspot.addEventListener('click', function (e) {
    e.preventDefault();
    activateKoprulu();
  });
  if (closeBtn) closeBtn.addEventListener('click', hidePanel);

  // Клик по пустому месту карты снимает выделение: панель закрывается, квадраты
  // возвращаются в обычное состояние. Следующий клик по квадрату снова первый
  // (панель + приближение), а не переход, и ховер работает как прежде.
  // Масштаб и положение карты не меняются.
  function clearSelection() {
    if (busy) return;
    var active = [hotspot, zerus, odz].some(function (x) {
      return x && (x.classList.contains('is-selected') || x.classList.contains('is-locked'));
    });
    if (active) hidePanel();
  }
  stage.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var clickTarget = e.target as Element | null;
    if (clickTarget && typeof clickTarget.closest === 'function' &&
      clickTarget.closest('.sector-hotspot, .sector-preview, .sector-panel, .map-controls, .sectors-sidebar, .sectors-curtain, .sectors-backdrop, .map-hint')) return;
    clearSelection();
  });

  /* ---------- непрерывность блика хотспотов ----------
     Раньше на ховере менялась animation-duration, и браузер пересчитывал позицию
     полосы по тому же времени: полоса прыгала назад и выглядела как перезапуск.
     Теперь длительность не меняется, а скорость проигрывания плавно меняется через
     Web Animations (updatePlaybackRate): текущая позиция сохраняется. */
  var SHEEN_HOT_RATE = 3.6 / 1.4;   // 3.6 s → 1.4 s на ховере/фокусе/выбранном
  function applySheenRate(el: Element): void {
    var hot = el.matches(':hover') || el.matches(':focus-visible') || el.classList.contains('is-selected');
    var rate = hot ? SHEEN_HOT_RATE : 1;
    if (!document.getAnimations) return;
    document.getAnimations().forEach(function (a) {
      var cssAnimation = a as CSSAnimation;
      var effect = a.effect as KeyframeEffect | null;
      if (cssAnimation.animationName === 'sector-sheen' && effect && effect.target === el && a.playbackRate !== rate) {
        a.updatePlaybackRate(rate);
      }
    });
  }
  document.querySelectorAll('.sector-hotspot').forEach(function (el) {
    el.addEventListener('pointerenter', function () { applySheenRate(el); });
    el.addEventListener('pointerleave', function () { applySheenRate(el); });
    el.addEventListener('focus', function () { applySheenRate(el); });
    el.addEventListener('blur', function () { applySheenRate(el); });
    new MutationObserver(function () { applySheenRate(el); })
      .observe(el, { attributes: true, attributeFilter: ['class'] });
  });


  /* ---------- переход: прицел в духе брифингов StarCraft II ----------
     Вся анимация — в /shared/focus-fx.js. Копрулу — вторая ступень приближения выбора,
     точь-в-точь как первая: рамка области сжимается по контуру квадрата, квадрат едет в
     центр, пауза, приближение до 2000 % (длительности — CONFIG.dive*, сейчас как у первого
     клика; плавность как у focusArea); рамка держится за квадрат, в конце в ней
     проявляется превью, вокруг — темнота. Зерус и ОЗД — свой сценарий: рамка захвата,
     срыв или отказ. Камеру модуль ведёт сам через camera (get / set вида). Здесь —
     логика: что делать при захвате и чем всё кончается. Переход начинается с того зума
     и положения карты, какие есть в момент клика.                                  */
  var viewBeforeTransition: GalaxyView | null = null;

  // Камера для FocusFx: точка карты p (px при s = 1) видна на экране в t + p · s.
  // Ограничения вида на время перехода сняты (зум до 2000 % — дальше обычного предела).
  var camera: FocusFxCamera = {
    get: function () { return { s: view.s, tx: view.tx, ty: view.ty }; },
    set: function (v) {
      view.s = v.s;
      view.tx = v.tx;
      view.ty = v.ty;
      applyView();
    }
  };

  function beginTransition() {
    busy = true;
    cancelAnim();
    viewBeforeTransition = { s: view.s, tx: view.tx, ty: view.ty };
  }

  // Конец перехода без ухода со страницы (Зерус, ОЗД): прицел снят, выбор сброшен,
  // вид в рамках. Следующий клик по квадрату снова первый.
  function finishTransition() {
    busy = false;
    cancelAnim();
    window.FocusFx.stop();
    clearAreas();
    viewBeforeTransition = null;
    clampView();
    applyView();
  }

  function resetTransition() {
    busy = false;
    cancelAnim();
    window.FocusFx.stop();
    clearAreas();
    stage.classList.remove('is-red-target', 'is-odz-ping');
    if (viewBeforeTransition) {
      view.s = viewBeforeTransition.s;
      view.tx = viewBeforeTransition.tx;
      view.ty = viewBeforeTransition.ty;
      viewBeforeTransition = null;
    }
  }

  // Копрулу (второй клик): рамка сжимается по контуру квадрата → центрирование →
  // пауза → приближение до 2000 %, во время которого в рамке проявляется превью,
  // а карта вокруг темнеет → страница сектора.
  function runTransition(el: HTMLElement, href: string): void {
    if (busy) return;
    beginTransition();
    closePanel();
    hidePreview();
    stage.classList.remove('is-red-target', 'is-odz-ping');
    window.FocusFx.start({
      stage: stage,
      target: function () { return boxOf(el); },
      frame: function () { return frameOf(el); },
      mapFrame: mapFrame, // если выбора на экране нет — сначала борд карты, как при первом клике
      camera: camera,
      contour: true,      // рамка по контуру квадрата, растёт вместе с картой
      timing: { center: CONFIG.diveCenterMs, pause: CONFIG.diveZoomDelay, zoom: CONFIG.diveZoomMs },
      zooms: CONFIG.diveZooms,
      ending: 'reveal',
      preview: el.getAttribute('data-macket') || (iconImg ? iconImg.getAttribute('src') : null) || '',
      onLock: function () { el.classList.add('is-locked'); },
      onEnd: function () { window.location.href = href; }
    });
  }

  // Возврат назад (bfcache): сбрасываем переход, а не показываем залипший кадр
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { resetTransition(); layout(); }
  });

  if (iconBtn) {
    iconBtn.addEventListener('click', function (e) {
      e.preventDefault();
      if (odz && panelArea === odz) {
        commitOdz();
        return;
      }
      runTransition(hotspot, defaultHref);
    });
  }

  /* ---------- шторка списка областей ---------- */
  var backdrop = document.getElementById('sectorsBackdrop') as HTMLElement | null;
  var closeList = document.getElementById('sectorsClose') as HTMLElement | null;

  function setCurtain(open: boolean): void {
    if (!sectorsList) return;
    sectorsList.classList.toggle('is-open', open);
    if (backdrop) backdrop.classList.toggle('is-open', open);
    if (toggle) toggle.setAttribute('aria-expanded', String(open));
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      setCurtain(!sectorsList.classList.contains('is-open'));
    });
  }
  /* Макет Зеруса для миниатюры в списке. Пока пустая строка — остаётся красная заглушка.
     Чтобы вставить картинку, укажите путь, например '/assets/zerus-macket.jpg'. */
  var ZERUS_MACKET = '';
  var zerusThumb = document.querySelector('.sector-list-thumb--zerus');
  if (zerusThumb && ZERUS_MACKET) {
    var zerusImg = document.createElement('img');
    zerusImg.src = ZERUS_MACKET;
    zerusImg.alt = '';
    zerusImg.width = 48;
    zerusImg.height = 48;
    zerusThumb.insertBefore(zerusImg, zerusThumb.firstChild);
  }

  if (closeList) closeList.addEventListener('click', function () { setCurtain(false); });
  if (backdrop) backdrop.addEventListener('click', function () { setCurtain(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sectorsList && sectorsList.classList.contains('is-open')) setCurtain(false);
  });

  if (sectorsList) {
    sectorsList.addEventListener('click', function (e) {
      var btn = (e.target as Element | null)?.closest('.sector-list-item');
      if (!btn) return;
      e.preventDefault();
      setCurtain(false);
      if (btn.hasAttribute('data-zerus')) {
        activateZerus();
        return;
      }
      if (btn.hasAttribute('data-odz')) {
        activateOdz();
        return;
      }
      activateKoprulu();
    });
  }

  /* ---------- Зерус: красная область без страницы ----------
     Первый клик — как у Копрулу: панель («no-data available»), приближение
     и красный прицел, который держит квадрат.
     Второй клик — переход: квадрат в центр, захват, приближение, срыв захвата,
     затем сообщение «Ошибка. Нет данных»: печатается по буквам, точка в конце
     моргает. */
  var zerus = document.getElementById('zerusHotspot') as HTMLElement | null;
  var zerusMsg = document.getElementById('galaxyError') as HTMLElement | null;
  var zerusText = document.getElementById('galaxyErrorText') as HTMLElement | null;
  var ZERUS_MESSAGE = 'Ошибка. Нет данных';
  var zerusTimer: number | null = null;

  // Первый клик по области (Копрулу, Зерус, ОЗД): целевой масштаб — focusZoom,
  // ограниченный размером data-frame и полями framePad. Если текущий масштаб выше
  // целевого, после сжатия сразу отъезжаем до него (focusZoomOutMs) и центрируем (focusMs);
  // если ниже — центрируем (focusMs), выдерживаем focusZoomDelay и приближаем
  // (focusZoomMs), а при равном масштабе только центрируем.
  function focusArea(el: HTMLElement): void {
    // Сначала отменяем прежний фокус/отложенный зум, затем центрируем область
    // на текущем масштабе; отдельный зум начинается после паузы в 1 секунду.
    cancelAnim();
    var sz = sceneSize();
    var visibleW = sz.w - (panel && !panel.hidden ? panel.offsetWidth : 0);
    var f = frameData(el);
    var want = CONFIG.focusZoom;
    var nx = 0, ny = 0, ns = 0, needZoom = false;
    var centerMapX = 0, centerMapY = 0, anchorX = 0;
    if (f && visibleW >= sz.w * CONFIG.frameMinVisible) {
      var fw = (f.r - f.l) / 100 * base, fh = (f.b - f.t) / 100 * base;   // рамка при s = 1
      var fit = Math.min(visibleW * (1 - 2 * CONFIG.framePad) / fw, sz.h * (1 - 2 * CONFIG.framePad) / fh);
      // Учитываем не только размер рамки, но и допустимый пан карты: иначе clampState
      // после расчёта мог сдвинуть её за край сцены.
      ns = clamp(Math.min(want, fit), CONFIG.minFactor, CONFIG.maxFactor);
      centerMapX = (f.l + f.r) / 200;
      centerMapY = (f.t + f.b) / 200;
      anchorX = visibleW / 2;

      function placeFrame(scale: number): GalaxyPoint | null {
        var side = scale * base;
        var frameLeft = side * f!.l / 100;
        var frameRight = side * f!.r / 100;
        var frameTop = side * f!.t / 100;
        var frameBottom = side * f!.b / 100;
        var xPan = panRange(side, sz.w);
        var yPan = panRange(side, sz.h);
        var xMin = Math.max(xPan.min, visibleW * CONFIG.framePad - frameLeft);
        var xMax = Math.min(xPan.max, visibleW * (1 - CONFIG.framePad) - frameRight);
        var yMin = Math.max(yPan.min, sz.h * CONFIG.framePad - frameTop);
        var yMax = Math.min(yPan.max, sz.h * (1 - CONFIG.framePad) - frameBottom);
        if (xMin > xMax + 0.5 || yMin > yMax + 0.5) return null;
        if (xMin > xMax) xMin = xMax = (xMin + xMax) / 2;
        if (yMin > yMax) yMin = yMax = (yMin + yMax) / 2;
        return {
          x: clamp(visibleW / 2 - (f!.l + f!.r) / 200 * side, xMin, xMax),
          y: clamp(sz.h / 2 - (f!.t + f!.b) / 200 * side, yMin, yMax)
        };
      }

      var placement = placeFrame(ns);
      // Панорамирование может не позволить разместить рамку на рассчитанном масштабе.
      // Плавно уменьшаем зум до первого допустимого размера, не меняя границы карты.
      while (!placement && ns > CONFIG.minFactor) {
        ns = Math.max(CONFIG.minFactor, ns - 0.01);
        placement = placeFrame(ns);
      }
      if (placement) {
        nx = placement.x; ny = placement.y;
      } else {
        var fside = ns * base;
        nx = visibleW / 2 - (f.l + f.r) / 200 * fside;
        ny = sz.h / 2 - (f.t + f.b) / 200 * fside;
      }
      needZoom = Math.abs(ns - view.s) > 0.001;
    } else {
      // На узком экране или без data-frame держим выбранный квадрат на focusAnchorX,
      // но всё равно приводим и слишком малый, и слишком большой масштаб к focusZoom.
      ns = CONFIG.focusZoom;
      var side = ns * base;
      var cx = parseFloat(el.getAttribute('data-cx') as string) / 100;
      var cy = parseFloat(el.getAttribute('data-cy') as string) / 100;
      nx = visibleW * CONFIG.focusAnchorX - cx * side;
      ny = sz.h / 2 - cy * side;
      centerMapX = cx;
      centerMapY = cy;
      anchorX = visibleW * CONFIG.focusAnchorX;
      needZoom = Math.abs(ns - view.s) > 0.001;
    }

    var centerView;
    if (centerMapX != null && centerMapY != null) {
      var currentSide = view.s * base;
      centerView = clampState({
        s: view.s,
        tx: anchorX - centerMapX * currentSide,
        ty: sz.h / 2 - centerMapY * currentSide
      });
    } else {
      centerView = clampState({ s: view.s, tx: nx, ty: ny });
    }

    function finishImmediateZoomOut() {
      if (panelArea !== el || !el.classList.contains('is-selected')) return;
      var finalView = clampState({ s: ns, tx: nx, ty: ny });
      var centerMs = Math.hypot(finalView.tx - view.tx, finalView.ty - view.ty) > 1 ? CONFIG.focusMs : 0;
      if (centerMs) {
        animateTo(ns, finalView.tx, finalView.ty, centerMs);
      } else {
        view.tx = finalView.tx;
        view.ty = finalView.ty;
        applyView();
      }
    }

    // При масштабе выше целевого не ждём: сразу отъезжаем, удерживая область под
    // тем же экранным центром, затем спокойно центрируем её на новом масштабе.
    if (needZoom && view.s > ns + 0.001 && centerMapX != null && centerMapY != null) {
      var oldSide = view.s * base;
      var focusScreenX = view.tx + centerMapX * oldSide;
      var focusScreenY = view.ty + centerMapY * oldSide;
      var outView = clampState({
        s: ns,
        tx: focusScreenX - centerMapX * ns * base,
        ty: focusScreenY - centerMapY * ns * base
      });
      animateTo(ns, outView.tx, outView.ty, CONFIG.focusZoomOutMs, finishImmediateZoomOut);
      return;
    }

    function startZoom() {
      focusTimer = null;
      if (panelArea !== el || !el.classList.contains('is-selected')) return;
      if (needZoom) animateTo(ns, nx, ny, CONFIG.focusZoomMs);   // приближение после центрирования
    }

    function afterCenter() {
      if (needZoom) focusTimer = window.setTimeout(startZoom, CONFIG.focusZoomDelay);
    }

    var panMs = Math.hypot(centerView.tx - view.tx, centerView.ty - view.ty) > 1 ? CONFIG.focusMs : 0;
    if (panMs) {
      animateTo(view.s, centerView.tx, centerView.ty, panMs, afterCenter);
    } else {
      view.tx = centerView.tx;
      view.ty = centerView.ty;
      applyView();
      afterCenter();
    }
  }

  var ZERUS_SHOW_MS = 5000;   // сколько сообщение висит на экране
  var ZERUS_FADE_MS = 400;    // длительность затухания
  var zerusHide: number | null = null;
  var zerusFade: number | null = null;

  function hideZerusError() {
    if (!zerusMsg) return;
    zerusMsg.classList.add('is-out');
    zerusFade = window.setTimeout(function () {
      zerusMsg!.hidden = true;
      zerusFade = null;
    }, ZERUS_FADE_MS);
  }

  function showZerusError() {
    if (!zerusMsg || !zerusText) return;
    if (zerusHide) window.clearTimeout(zerusHide);
    if (zerusFade) window.clearTimeout(zerusFade);
    zerusHide = window.setTimeout(hideZerusError, ZERUS_SHOW_MS);
    zerusMsg.classList.remove('is-out');
    zerusMsg.hidden = false;
    zerusMsg.classList.remove('is-done');
    zerusText.textContent = '';
    if (zerusTimer) window.clearInterval(zerusTimer);
    var i = 0;
    zerusTimer = window.setInterval(function () {
      i += 1;
      zerusText!.textContent = ZERUS_MESSAGE.slice(0, i);
      if (i >= ZERUS_MESSAGE.length) {
        window.clearInterval(zerusTimer!);
        zerusTimer = null;
        zerusMsg!.classList.add('is-done');
      }
    }, 45);
  }

  // Зерус: красный прицел — квадрат в центр, захват, один «нырок» (в пределах
  // обычного зума), затем захват срывается и печатается сообщение об ошибке
  function runZerusTransition(el: HTMLElement): void {
    if (busy) return;
    beginTransition();
    closePanel();
    hidePreview();
    stage.classList.remove('is-odz-ping');
    stage.classList.add('is-red-target');
    window.FocusFx.start({
      stage: stage,
      target: function () { return boxOf(el); },
      frame: function () { return frameOf(el); },
      camera: camera,
      zooms: [CONFIG.maxFactor],
      ending: 'error',
      onLock: function () { el.classList.add('is-locked'); },
      onEnd: function () {
        // вместо перехода — сообщение об ошибке
        finishTransition();
        stage.classList.remove('is-red-target');
        showZerusError();
      }
    });
  }

  // Клик по области Зеруса (на карте или в списке): первый — приближение, второй — переход
  function activateZerus() {
    if (!zerus || busy) return;
    if (zerus.classList.contains('is-selected')) {
      runZerusTransition(zerus);
      return;
    }
    showPanel(zerus);
    selectArea(zerus, function () { focusArea(zerus!); });
  }

  if (zerus) {
    zerus.addEventListener('click', function (e) {
      e.preventDefault();
      activateZerus();
    });
  }

  /* ---------- Пространство Директората (ОЗД) ----------
     Как Копрулу: первый клик — панель, приближение и зелёный прицел, второй — переход.
     Переход: квадрат в центр, зелёный прицел снова захватывает его, затем отказ — прицел,
     квадрат и блик краснеют, камера отдаляется до 100 %, прицел гаснет, затем
     печатаются 12 строк «ОТКАЗ ДОСТУПА.» … «Файл заблокирован.».
     Строки гаснут через 5 с, после этого кнопка неактивна. Перезагрузка сбрасывает всё. */
  var odz = document.getElementById('odzHotspot') as HTMLElement | null;
  var odzMsg = document.getElementById('odzMessage') as HTMLElement | null;
  var odzListItem = document.querySelector('.sector-list-item[data-odz]');
  var odzDone = false;          // переход уже запущен: повторно не запускается
  var ODZ_LINES: string[] = [];
  for (var li = 0; li < 11; li++) ODZ_LINES.push('ОТКАЗ ДОСТУПА.');
  ODZ_LINES.push('Файл заблокирован.');
  var ODZ_LINE_STEP = 110;      // мс между началом строк (строки пишутся каскадом)
  var ODZ_CHAR_MS = 22;         // мс на символ
  var ODZ_SHOW_MS = 5000;       // строки висят 5 с от первой буквы
  var ODZ_FADE_MS = 400;
  var odzTimers: number[] = [];
  var odzHideTimer: number | null = null;
  var odzFadeTimer: number | null = null;

  function setOdzLocked() {
    if (odz) odz.classList.add('is-odz-locked');
    if (odzListItem) odzListItem.classList.add('is-odz-locked');
    try { sessionStorage.setItem('odzLocked', '1'); } catch (e) {}
  }

  // Возврат со страницы сектора: если ОЗД уже заблокирован, блокировка сохраняется
  if (returnedFromSector) {
    try {
      if (sessionStorage.getItem('odzLocked') === '1') { odzDone = true; setOdzLocked(); }
    } catch {}
  }

  function clearOdzTimers() {
    odzTimers.forEach(function (t) { window.clearTimeout(t); });
    odzTimers = [];
  }

  function hideOdzMessages() {
    clearOdzTimers();
    setOdzLocked();
    if (!odzMsg) return;
    odzMsg.classList.add('is-out');
    odzFadeTimer = window.setTimeout(function () {
      odzMsg!.hidden = true;
      odzMsg!.classList.remove('is-out');
    }, ODZ_FADE_MS);
  }

  function showOdzMessages() {
    if (!odzMsg) { setOdzLocked(); return; }
    clearOdzTimers();
    if (odzHideTimer) window.clearTimeout(odzHideTimer);
    if (odzFadeTimer) window.clearTimeout(odzFadeTimer);
    odzMsg.innerHTML = '';
    odzMsg.classList.remove('is-out');
    odzMsg.hidden = false;
    ODZ_LINES.forEach(function (text, i) {
      var line = document.createElement('div');
      line.className = 'odz-line';
      odzMsg!.appendChild(line);
      for (var k = 1; k <= text.length; k++) {
        (function (n) {
          var at = i * ODZ_LINE_STEP + n * ODZ_CHAR_MS;
          odzTimers.push(window.setTimeout(function () {
            line.textContent = text.slice(0, n);
          }, at));
        })(k);
      }
    });
    odzHideTimer = window.setTimeout(hideOdzMessages, ODZ_SHOW_MS);
  }

  // ОЗД: зелёный прицел — квадрат в центр, захват, затем отказ: прицел и квадрат
  // краснеют, камера отъезжает до 100 %, прицел гаснет, печатаются строки
  function runOdzTransition(el: HTMLElement): void {
    odzDone = true;
    beginTransition();
    closePanel();
    hidePreview();
    stage.classList.remove('is-red-target');
    stage.classList.add('is-odz-ping');
    window.FocusFx.start({
      stage: stage,
      target: function () { return boxOf(el); },
      frame: function () { return frameOf(el); },
      camera: camera,
      ending: 'deny',
      onLock: function () { el.classList.add('is-locked'); },
      onDeny: function () {
        el.classList.add('is-odz-red');      // квадрат плавно краснеет (CSS transition), прицел — следом
        stage.classList.remove('is-odz-ping');
        stage.classList.add('is-red-target');
        var sz = sceneSize();
        animateTo(1, (sz.w - base) / 2, (sz.h - base) / 2, CONFIG.animateMs);
      },
      onEnd: function () {
        finishTransition();
        stage.classList.remove('is-red-target', 'is-odz-ping');
        showOdzMessages();
      }
    });
  }

  function commitOdz() {
    if (!odz || odzDone || busy) return;
    runOdzTransition(odz);
  }

  function activateOdz() {
    if (!odz || odzDone || busy) return;
    if (odz.classList.contains('is-selected')) {
      commitOdz();
      return;
    }
    showPanel(odz);
    selectArea(odz, function () { focusArea(odz!); });
  }

  if (odz) {
    odz.addEventListener('click', function (e) {
      e.preventDefault();
      activateOdz();
    });
    odz.addEventListener('pointerenter', function (e) {
      if (e.pointerType === 'mouse') showPreview(odz!);
    });
    odz.addEventListener('pointerleave', hidePreview);
  }

  /* ---------- параллакс звёздного фона: от движения карты ----------
     Курсор не участвует. Перерисовка звёзд запрашивается из applyView, то есть при
     любом сдвиге вида: перетаскивании, зуме, переходе. */
  var parQueued = false;

  function parallaxRequest() {
    if (!starfield || parQueued) return;
    parQueued = true;
    window.requestAnimationFrame(parallaxTick);
  }

  function parallaxTick() {
    parQueued = false;
    if (!starfield) return;
    var off = parallaxOffset();
    if (off.x === paintedOff.x && off.y === paintedOff.y) return;
    paintStarfield(off.x, off.y);
  }
})();
