/* FocusFx — анимация выделения и приближения в духе брифингов StarCraft II
   (Wings of Liberty, брифинг «Maw of the Void»). Только анимация: что выбрано,
   какая панель открыта и куда вести после перехода — решает страница. На карте
   галактики модуль подключён из galaxy.js.

   КАК ВЫГЛЯДИТ
   Прицел — перекрестие на всю сцену и полая рамка; линии идут по осям цели
   и упираются в рамку снаружи, внутрь не заходят. Рисуется на одном canvas.

   Выбор — select():
     1. первый выбор — линии входят за границами viewport и рисуют борд карты;
     2. рамка непрерывно сжимается от карты к области фокуса (frame), линии остаются связаны;
     3. после сжатия страница центрирует область, затем после паузы отдельно приближает карту;
     4. рамка остаётся привязана к координатам карты и следует за ручным/программным видом.
   При выборе другой цели уже нарисованная рамка плавно переезжает, не сбрасываясь.
   Для вызовов без mapFrame остаётся режим select({ instant: true }) с коротким ping на месте.
   Снятие выбора — release(): контур выгружается обратно против часовой стрелки, импульсы уходят по каналам.

   Переход — start(); продолжает с удержания, без повторного появления. Два вида.

   «По контуру» (contour: true; переход в Копрулу) — вторая ступень того же
   приближения, что при выборе, и выглядит точно так же:
     1. рамка области сжимается до контура квадрата цели — как борд карты до области
        при выборе (T.contract, те же каналы от краёв сцены и блики) → onLock(0);
     2. камера везёт квадрат в центр, ждёт, приближает — длительности и плавность как
        у выбора (timing); рамка всё время держится за контур квадрата и растёт с картой;
     3. финал — 'reveal': во время приближения в квадрате, внутри рамки, проявляется
        превью (preview), карта вокруг уходит в темноту → onEnd(). Без превью — 'fade'.

   Обычный (Зерус, ОЗД):
     1. рамка сужается до рамки захвата вокруг цели, захват → onLock(0);
     2. камера везёт цель в центр, рамка следует за картой;
     3. после T.zoomDelay — приближение: рамка раскрывается до краёв сцены;
     4. между уровнями — сброс, наведение и захват;
     5. финал — 'fade' — уход в темноту; 'error' — срыв захвата; 'deny' — отказ
        (вспышки на цели) сразу после захвата, без приближения; 'reveal' — превью в
        квадрате цели во время последнего приближения.
   Если прицела на экране нет, переход начинается с появления («по контуру» — с борда
   карты, как первый выбор, если передан mapFrame).

   РАЗМЕРЫ
   Координаты mapFrame(), target() и frame() заданы в пикселях сцены, их выдаёт страница.
   Во время фокусирования, перехода и hold модуль перечитывает их; готовая рамка хранит
   положение и размер относительно карты и потому следует за её ручным/программным видом.
   В обычном переходе размер рамки захвата при программном зуме следует настройке
   lockScreen: при false она подстраивается под выросшую цель; при true остаётся
   экранного размера. В переходе «по контуру» рамка — сам квадрат target(): внешний край
   линии на контуре квадрата, рамка растёт вместе с картой. Толщина линий — доля меньшей
   стороны сцены (G).

   ПОДКЛЮЧЕНИЕ
   1. Сцена — любой элемент с position: relative / absolute и overflow: hidden,
      внутри которого лежит карта. Модуль сам добавит в него: затемнение
      (.focus-fx-dim, только на время обычного перехода), холст прицела (.focus-fx-canvas)
      и картинку превью (.focus-fx-preview, только в финале 'reveal'). Все три —
      с z-index из G.zIndex (3): над картой, но под интерфейсом сцены (панели,
      кнопки — делайте им z-index больше). Клики проходят насквозь.
   2. Скрипт — до кода страницы:
        <script src="/shared/focus-fx.js" defer></script>
   3. Камера — объект с двумя функциями; модуль двигает вид сам только на время
      перехода (центрирование и приближение):
        camera.get() → { s, tx, ty }  — текущий вид;
        camera.set({ s, tx, ty })     — применить вид (перерисовать карту).
      Договорённость: точка мира p видна на экране в t + p · s. Единица мира
      любая: на галактике — сторона карты при s = 1 (вид: слой карты стороной
      s · base, левый верхний угол в tx, ty), в атласе сектора — пиксель исходника.
      Уровни zooms задаются в тех же единицах s.
   4. Вызовы (координаты — пиксели относительно сцены):
        FocusFx.select({
          stage:  stageEl,
          target: function () { return { l, t, r, b, cx, cy, w }; },  // квадрат цели
          frame:  function () { return { l, t, r, b }; },             // область фокуса или null
          mapFrame: function () { return { l, t, r, b }; },            // видимое пересечение камеры и карты для борда
          onLock: function () { … },                                 // цель захвачена
          onContract: function () { … },                            // карта начинает центрирование после сжатия рамки
          instant: true                                                // борд карты → сжатие к frame → центрирование страницы
        });
        FocusFx.release(function () { … });                          // выбор снят, прицел погас
        FocusFx.start({
          stage: stageEl, target: …, frame: …,
          camera: camera,
          contour: true,                 // переход «по контуру» — как вторая ступень выбора (см. выше)
          mapFrame: function () { … },   // «по контуру» без выбора на экране: начать с борда карты
          timing: { center: 520, pause: 1000, zoom: 650 }, // «по контуру»: мс, как у выбора на странице
          lockScreen: false,             // обычный: false — размер захвата следует за зумом; иначе фиксируется на старте
          zooms: [20],                   // уровни приближения по шагам (пусто — без приближения)
          ending: 'reveal',              // 'reveal' | 'fade' | 'error' | 'deny' («по контуру» — 'reveal' или 'fade')
          preview: '/assets/…webp',      // для 'reveal'
          onLock: function (step) { … }, // захват на шаге step (0, 1, …)
          onZoom: function (step, ms, level) { … },  // начало приближения (без camera —
                                                     // двигать вид должна страница)
          onCenter: function (ms) { … }, // только без camera: центрирование делает страница
          onDeny: function (ms) { … },   // только 'deny': отказ, ms — до onEnd
          onEnd: function () { … }       // конец: переход или сообщение
        });
      При 'reveal' и 'fade' прицел, превью и темнота остаются на экране, пока
      страница не уйдёт (или до stop()) — без мигания перед переходом.
   5. Цвет — CSS-переменные на сцене (или выше), тройки «r, g, b»:
        --focus-core   линии и рамка          (по умолчанию 34, 150, 58 — зелёный брифинга)
        --focus-light  фаска, блики, вспышки  (176, 255, 186)
        --focus-shadow тёмная кромка          (0, 30, 6)
        --focus-glow   свечение               (56, 224, 96)
        --focus-dim    затемнение на время перехода, любой CSS-цвет (rgba(2, 10, 9, .38))
      Смена класса сцены (например, красный прицел при отказе) — цвет плавно
      перетекает за T.color.
   6. Пока идёт переход, ввод на странице лучше выключить (на галактике — busy):
      камера в это время принадлежит модулю.

   ОСТАЛЬНОЕ API
     active()  — что на экране: 'select' | 'go' | 'release' | 'idle' (кадр после
                 перехода) | null
     refresh() — сцена сменила размер (подогнать холст); положение цели модуль и так
                 читает каждый кадр
     stop()    — убрать всё сразу, без анимации
     T, G      — длительности и геометрия (ниже); можно менять до вызова

   prefers-reduced-motion: прицел сразу на цели, без мигания и раскрытий; камера при
   переходе не двигается (ни центрирования, ни приближения), финал 'reveal' — уход
   в темноту. */
(function (global) {
  'use strict';

  // Длительности этапов, мс
  var T = {
    appear: 190,      // появление: мигание рамки, линии к краям
    trackMin: 380,    // наведение: не короче…
    trackMax: 700,    // …и не длиннее
    trackPerPx: 0.5,  // + столько мс на пиксель пути
    lock: 320,        // первый захват: поджатие и две вспышки
    relock: 240,      // повторный захват (после сброса, после сужения, при смене цели) — короче
    relocate: 520,    // существующая рамка плавно переезжает к новой выбранной области
    mapOutline: 640,  // первый выбор: борд формируется по краям карты
    contract: 420,    // борд карты сужается до выбранной области
    expand: 420,      // выделение: рамка раскрывается от цели до области фокуса
    snap: 680,        // запасной режим: каналы сходятся от краёв и собирают рамку на месте
    narrow: 380,      // переход: область фокуса сужается до цели
    centerMin: 320,   // центрирование: не короче…
    centerMax: 640,   // …и не длиннее
    centerPerPx: 0.45, // + столько мс на пиксель пути цели до центра сцены
    zoom: 600,        // раскрытие рамки и приближение камеры
    zoomDelay: 1000,  // пауза после фокусирования перед началом зума
    focusCenter: 520, // переход «по контуру»: центрирование и приближение — как при выборе
    focusZoom: 650,   // (на галактике их передаёт galaxy.js из своего CONFIG: opts.timing)
    reset: 160,       // сброс: маленькая рамка в центре
    reveal: 520,      // 'reveal': окно параллельного проявления превью в последнем приближении
    still: 260,       // 'reveal': пауза на готовом кадре перед onEnd
    fade: 240,        // 'fade': уход в темноту после последнего приближения
    error: 560,       // 'error': срыв захвата
    deny: 440,        // 'deny': вспышки отказа
    collapse: 280,    // 'error' / 'deny': линии втягиваются, рамка гаснет
    release: 420,     // снятие выбора: непрерывная выгрузка контура против часовой стрелки
    color: 400        // перетекание цвета при смене класса сцены
  };

  // Геометрия — доли меньшей стороны сцены (в брифинге — доли высоты кадра)
  var G = {
    stroke: 0.0115,   // толщина линий и рамки (в брифинге ≈ 1.2 % высоты кадра)
    strokeMin: 3,     // px
    strokeMax: 11,    // px
    boxW: 0.135,      // рамка в покое (в брифинге ≈ 13 × 11 % высоты кадра)
    boxH: 0.115,
    fit: 1.75,        // рамка захвата: ширина = размер цели × fit…
    fitMin: 0.085,    // …но не уже…
    fitMax: 0.24,     // …и не шире этих долей
    loose: 1.14,      // до захвата рамка чуть свободнее, при захвате поджимается
    overshoot: 0.06,  // перелёт при наведении, доля пути…
    overshootPx: 14,  // …но не больше стольких px
    frameOver: 1.06,  // раскрытая при приближении рамка уходит чуть за края сцены
    lag: 0.12,        // промежуточное приближение: цель не доезжает до центра (доля смещения)…
    lagMin: 0.045,    // …и остаётся от центра хотя бы на этой доле (прицелу есть куда довестись)
    glintSpeed: 2.28, // скорость импульсов увеличена в 6 раз относительно базовых 0.38
    glintCount: 600,  // 6× больше одновременно движущихся энергетических импульсов на каналах
    veil: [1, 6, 5],  // цвет ухода в темноту (фон страниц)
    revealVeil: 0.86, // 'reveal': насколько темнеет всё вокруг превью
    lockScreen: true, // переход: рамка захвата весь переход того размера, какой была при клике
                      // (эффект привязан к экрану; после приближения цель больше рамки);
                      // false — на каждом захвате рамка подстраивается под выросшую цель
    zIndex: 3         // слой затемнения, прицела и превью внутри сцены
  };

  var DEFAULT_PALETTE = {
    core: [34, 150, 58],
    light: [176, 255, 186],
    shadow: [0, 30, 6],
    glow: [56, 224, 96]
  };

  var reduceMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var run = null;          // текущий сценарий: mode 'select' | 'go' | 'release'
  var stageEl = null;
  var dimEl = null;
  var canvas = null;
  var previewEl = null;
  var ctx = null;
  var cw = 0, ch = 0, dpr = 1;
  var palFrom = null, palTo = null, palT0 = 0, palClass = null;

  /* ---------- математика ---------- */
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function lerp(a, b, k) { return a + (b - a) * k; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInCubic(t) { return t * t * t; }
  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  function smoothstep(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function pulse(u, a, b) { return u > a && u < b ? Math.sin(Math.PI * (u - a) / (b - a)) : 0; }
  function mod(v, m) { return ((v % m) + m) % m; }
  // Псевдослучайное 0..1 от целого: одно и то же на каждом кадре (срыв, разброс бликов)
  function hash(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // Наведение «как сервопривод»: плавный разгон, перелёт на ov, мягкий возврат
  function servo(u, ov) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    if (u < 0.78) return (1 + ov) * easeInOutCubic(u / 0.78);
    return 1 + ov - ov * easeInOutSine((u - 0.78) / 0.22);
  }

  // Мигание при появлении: вспыхнула — пропала — горит
  function flicker(u) {
    if (reduceMotion) return 1;
    if (u < 0.2) return 0.85;
    if (u < 0.4) return 0;
    return 1;
  }

  /* ---------- цвета из CSS ---------- */
  function readTriplet(cs, name, fallback) {
    var v = String(cs.getPropertyValue(name) || '').split(',').map(parseFloat);
    if (v.length !== 3) return fallback;
    for (var i = 0; i < 3; i++) if (!isFinite(v[i])) return fallback;
    return v;
  }

  function readPalette() {
    var cs = global.getComputedStyle(canvas);
    return {
      core: readTriplet(cs, '--focus-core', DEFAULT_PALETTE.core),
      light: readTriplet(cs, '--focus-light', DEFAULT_PALETTE.light),
      shadow: readTriplet(cs, '--focus-shadow', DEFAULT_PALETTE.shadow),
      glow: readTriplet(cs, '--focus-glow', DEFAULT_PALETTE.glow)
    };
  }

  function mix(a, b, k) { return [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]; }
  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + clamp(a, 0, 1).toFixed(3) + ')';
  }

  function currentPalette(now) {
    var k = palFrom === palTo ? 1 : easeInOutSine(clamp((now - palT0) / T.color, 0, 1));
    if (k >= 1) return palTo;
    return {
      core: mix(palFrom.core, palTo.core, k),
      light: mix(palFrom.light, palTo.light, k),
      shadow: mix(palFrom.shadow, palTo.shadow, k),
      glow: mix(palFrom.glow, palTo.glow, k)
    };
  }

  // Класс сцены сменился (например, отказ — прицел краснеет): цвет перетекает
  function syncPalette(now) {
    if (stageEl.className === palClass) return;
    palClass = stageEl.className;
    palFrom = currentPalette(now);
    palTo = readPalette();
    palT0 = now;
  }

  /* ---------- слои в сцене ---------- */
  function layerStyle(el) {
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.zIndex = String(G.zIndex);
    el.style.pointerEvents = 'none';
  }

  function fitCanvas() {
    var w = stageEl.clientWidth, h = stageEl.clientHeight;
    var d = Math.min(2, global.devicePixelRatio || 1);
    if (w === cw && h === ch && d === dpr) return;
    cw = w; ch = h; dpr = d;
    canvas.width = Math.max(1, Math.round(w * d));
    canvas.height = Math.max(1, Math.round(h * d));
  }

  function attach(stage) {
    stageEl = stage;
    canvas = document.createElement('canvas');
    canvas.className = 'focus-fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    layerStyle(canvas);
    stage.appendChild(canvas);
    ctx = canvas.getContext ? canvas.getContext('2d') : null;
    cw = ch = 0;
    fitCanvas();
    palClass = stage.className;
    palFrom = palTo = readPalette();
    palT0 = 0;
  }

  // Затемнение — только на время перехода (при выборе карта не темнеет); под прицелом
  function dimOn() {
    if (dimEl || !stageEl) return;
    dimEl = document.createElement('div');
    dimEl.className = 'focus-fx-dim';
    dimEl.setAttribute('aria-hidden', 'true');
    layerStyle(dimEl);
    dimEl.style.background = 'var(--focus-dim, rgba(2, 10, 9, 0.38))';
    dimEl.style.opacity = '0';
    dimEl.style.transition = 'opacity 0.4s ease';
    stageEl.insertBefore(dimEl, canvas);
    global.requestAnimationFrame(function () { if (dimEl) dimEl.style.opacity = '1'; });
  }

  // Превью для финала 'reveal': над холстом (темнота его не накрывает).
  // framed — превью лежит внутри рамки прицела («по контуру»): своя обводка и свечение
  // не нужны, обводка — сама рамка.
  function previewOn(src, pal, framed) {
    if (previewEl || !stageEl || !src) return;
    previewEl = document.createElement('img');
    previewEl.className = 'focus-fx-preview';
    previewEl.alt = '';
    previewEl.setAttribute('aria-hidden', 'true');
    previewEl.decoding = 'async';
    previewEl.src = src;
    var s = previewEl.style;
    s.position = 'absolute';
    s.left = '0';
    s.top = '0';
    s.zIndex = String(G.zIndex);
    s.pointerEvents = 'none';
    s.objectFit = 'cover';
    s.opacity = '0';
    s.boxSizing = 'border-box';
    if (!framed) {
      s.border = '1px solid ' + rgba(pal.light, 0.55);
      s.boxShadow = '0 0 26px ' + rgba(pal.glow, 0.45);
    }
    s.transformOrigin = '0 0';
    stageEl.appendChild(previewEl);
  }

  function placePreview(box, k) {
    if (!previewEl) return;
    previewEl.style.width = Math.max(1, box.w) + 'px';
    previewEl.style.height = Math.max(1, box.w) + 'px';
    previewEl.style.transform = 'translate(' + box.l.toFixed(1) + 'px,' + box.t.toFixed(1) + 'px)';
    previewEl.style.opacity = clamp(k, 0, 1).toFixed(3);
  }

  function detach() {
    [dimEl, canvas, previewEl].forEach(function (el) { if (el && el.parentNode) el.parentNode.removeChild(el); });
    dimEl = null;
    canvas = null;
    previewEl = null;
    ctx = null;
    stageEl = null;
  }

  /* ---------- размеры ---------- */
  function metrics() {
    var m = Math.max(1, Math.min(cw, ch));
    return {
      m: m,
      sw: clamp(Math.round(G.stroke * m), G.strokeMin, G.strokeMax),
      rest: { w: G.boxW * m, h: G.boxH * m }
    };
  }

  // Рамка захвата вокруг цели: пропорции как у рамки в покое
  function fitBox(targetW, m) {
    var w = clamp(targetW * G.fit, G.fitMin * m, G.fitMax * m);
    return { w: w, h: w * G.boxH / G.boxW };
  }

  // На время перехода рамка захвата зафиксирована (привязана к экрану), при выборе —
  // следует за размером цели
  function lockBox(r, tg, mt) {
    return r.fixed || fitBox(tg.w, mt.m);
  }

  // Область фокуса: центр и размер; null — области нет
  function frameOf(r) {
    var f = r.o.frame ? r.o.frame() : null;
    if (!f || !(f.r > f.l) || !(f.b > f.t)) return null;
    return { x: (f.l + f.r) / 2, y: (f.t + f.b) / 2, w: f.r - f.l, h: f.b - f.t };
  }

  // Видимое пересечение карты и viewport в координатах текущего вида, для первого борда.
  function mapFrameOf(r) {
    var f = r.o.mapFrame ? r.o.mapFrame() : null;
    if (!f || !(f.r > f.l) || !(f.b > f.t)) return null;
    return { x: (f.l + f.r) / 2, y: (f.t + f.b) / 2, w: f.r - f.l, h: f.b - f.t };
  }

  /* ---------- сценарии ----------
     fresh — прицела на экране ещё нет: начинаем с появления. Иначе сценарий
     продолжает с того места, где прицел сейчас (смена цели, переход с удержания). */
  function planSelect(o, fresh) {
    var p = fresh ? [{ kind: 'appear', ms: T.appear }] : [];
    p.push({ kind: 'track' });
    p.push({ kind: 'lock', step: 0, ms: fresh ? T.lock : T.relock });
    if (o.frame) p.push({ kind: 'expand', ms: T.expand });
    p.push({ kind: 'hold', ms: Infinity });
    return p;
  }

  /* Переход «по контуру» — вторая ступень приближения, этапы и длительности как у выбора:
     сжатие (как борд → область) → центрирование → пауза → приближение. Рамка не
     раскрывается к краям, не сбрасывается и не захватывает цель заново: она садится на
     контур квадрата и держится за него, пока камера центрирует и приближает. */
  function planContour(o, fresh) {
    var p = [];
    if (fresh && o.mapFrame) p.push({ kind: 'outline', ms: reduceMotion ? 0 : T.mapOutline });
    p.push({ kind: 'shrink', ms: reduceMotion ? 0 : T.contract });
    p.push({ kind: 'lock', step: 0, ms: 0 });     // сел на контур → onLock
    p.push({ kind: 'center' });
    for (var i = 0; i < o.zooms.length; i++) {
      p.push({ kind: 'pause', ms: o.timing.pause });
      p.push({ kind: 'zoom', step: i, ms: o.timing.zoom, last: i === o.zooms.length - 1 });
    }
    // 'reveal': превью проявляется во время последнего приближения, затем короткая пауза
    p.push(o.ending === 'reveal' ? { kind: 'still', ms: T.still } : { kind: 'fade', ms: T.fade });
    return p;
  }

  function planGo(o, fresh) {
    if (o.contour) return planContour(o, fresh);
    var p = [];
    if (fresh) {
      p.push({ kind: 'appear', ms: T.appear });
      p.push({ kind: 'center', loosen: true });
      p.push({ kind: 'lock', step: 0, ms: T.lock });
    } else {
      p.push({ kind: 'narrow', ms: T.narrow });
      p.push({ kind: 'lock', step: 0, ms: T.relock });
      p.push({ kind: 'center' });
    }
    if (o.ending === 'deny') {
      p.push({ kind: 'deny', ms: T.deny });
      p.push({ kind: 'collapse', ms: T.collapse, follow: true });
      return p;
    }
    var n = o.zooms.length;
    if (n > 0) p.push({ kind: 'pause', ms: T.zoomDelay });
    for (var i = 0; i < n; i++) {
      p.push({ kind: 'zoom', step: i, ms: T.zoom, last: i === n - 1 });
      if (i < n - 1) {
        p.push({ kind: 'reset', ms: T.reset });
        p.push({ kind: 'track' });
        p.push({ kind: 'lock', step: i + 1, ms: T.relock });
      }
    }
    if (o.ending === 'error') {
      if (n > 0) p.push({ kind: 'reset', ms: T.reset });
      p.push({ kind: 'error', ms: T.error });
      p.push({ kind: 'collapse', ms: T.collapse });
    } else if (o.ending === 'reveal') {
      // Превью проявляется одновременно с последним, самым крупным приближением.
      p.push({ kind: 'still', ms: T.still });
    } else {
      p.push({ kind: 'fade', ms: T.fade });
    }
    return p;
  }

  function center() { return { x: cw / 2, y: ch / 2 }; }

  /* ---------- камера (только на время перехода) ----------
     Центрирование: сдвиг при том же масштабе. Приближение: точка цели идёт по прямой
     к точке назначения — карта и рамка движутся синхронно.
     Обычный переход: easeInOutCubic, масштаб растёт геометрически.
     «По контуру» (PAGE_CAMERA): как камера выбора на странице (galaxy.js → animateTo) —
     easeOutCubic, масштаб линейно; точка в центре сцены остаётся на месте. */
  var PAGE_CAMERA = { ease: easeOutCubic, linear: true };

  function cameraPan(cam, tg, to, style) {
    var c0 = cam.get();
    return { kind: 'pan', c0: c0, dx: to.x - tg.cx, dy: to.y - tg.cy, style: style || null };
  }

  function cameraZoom(cam, tg, level, to, style) {
    var c0 = cam.get();
    var s1 = Math.max(c0.s, level);
    return {
      kind: 'zoom', c0: c0, s1: s1, style: style || null,
      p0: { x: tg.cx, y: tg.cy }, to: to,
      wx: (tg.cx - c0.tx) / c0.s, wy: (tg.cy - c0.ty) / c0.s   // точка цели в единицах мира · 1
    };
  }

  function applyCamera(r, ph, u) {
    var k = ph.cam;
    if (!k || !r.o.camera) return;
    var e = (k.style ? k.style.ease : easeInOutCubic)(clamp(u, 0, 1));
    if (k.kind === 'pan') {
      r.o.camera.set({ s: k.c0.s, tx: k.c0.tx + k.dx * e, ty: k.c0.ty + k.dy * e });
      return;
    }
    var s = k.style && k.style.linear ? k.c0.s + (k.s1 - k.c0.s) * e : k.c0.s * Math.pow(k.s1 / k.c0.s, e);
    var px = k.p0.x + (k.to.x - k.p0.x) * e;
    var py = k.p0.y + (k.to.y - k.p0.y) * e;
    r.o.camera.set({ s: s, tx: px - k.wx * s, ty: py - k.wy * s });
  }

  // Куда приезжает цель после шага приближения: последний шаг — точно в центр,
  // промежуточный — чуть не доезжая (как в брифинге: прицелу есть куда довестись)
  function zoomDest(tg, mt, last) {
    var C = center();
    if (last) return C;
    var ox = (tg.cx - C.x) * G.lag, oy = (tg.cy - C.y) * G.lag;
    var len = Math.hypot(ox, oy), min = G.lagMin * mt.m;
    if (len < 0.5) { ox = 0.6; oy = 0.8; len = 1; }   // цель уже в центре — уводим вниз-вправо
    if (len < min) { ox *= min / len; oy *= min / len; }
    return { x: C.x + ox, y: C.y + oy };
  }

  // Начало этапа: снимок состояния и колбэки. false — сценарий остановлен из колбэка.
  function enter(r, ph) {
    var mt = metrics();
    var tg = r.o.target();
    var C = center();
    if (ph.kind === 'appear' || ph.kind === 'reset') {
      var fb = lockBox(r, tg, mt);
      // без анимации движения прицел появляется сразу на цели
      r.pos = reduceMotion ? { x: tg.cx, y: tg.cy } : C;
      r.aim = { x: r.pos.x, y: r.pos.y };
      r.box = reduceMotion ? { w: fb.w * G.loose, h: fb.h * G.loose } : { w: mt.rest.w, h: mt.rest.h };
      r.alpha = 1;
      r.reach = 0;
    }
    ph.from = {
      x: r.pos.x, y: r.pos.y, w: r.box.w, h: r.box.h, ax: r.aim.x, ay: r.aim.y,
      alpha: r.alpha, reach: r.reach, frameProgress: r.frameProgress, rayBuild: r.rayBuild,
      channelAlpha: r.channelAlpha, veil: r.veil, reveal: r.reveal
    };
    var contour = r.mode === 'go' && r.o.contour;
    var camStyle = contour ? PAGE_CAMERA : null;
    var cb = null;
    switch (ph.kind) {
      case 'track':
        var dist = Math.hypot(tg.cx - r.pos.x, tg.cy - r.pos.y);
        ph.ms = reduceMotion ? 0 : clamp(T.trackMin + dist * T.trackPerPx, T.trackMin, T.trackMax);
        ph.ov = dist > 1 ? Math.min(G.overshoot, G.overshootPx / dist) : 0;
        break;
      case 'expand':
        if (reduceMotion || !frameOf(r)) ph.ms = 0;
        break;
      case 'narrow':
        if (reduceMotion) ph.ms = 0;
        break;
      case 'center':
        var away = Math.hypot(C.x - tg.cx, C.y - tg.cy);
        // «по контуру» — как центрирование при выборе: фиксированное время, если ехать есть куда
        ph.ms = reduceMotion || away < 1 ? 0
          : (contour ? r.o.timing.center : clamp(T.centerMin + away * T.centerPerPx, T.centerMin, T.centerMax));
        // смещение прицела от цели сходит на нет, пока камера везёт цель в центр
        ph.off = { x: r.pos.x - tg.cx, y: r.pos.y - tg.cy };
        ph.offA = { x: r.aim.x - tg.cx, y: r.aim.y - tg.cy };
        if (ph.ms > 0) {
          if (r.o.camera) ph.cam = cameraPan(r.o.camera, tg, C, camStyle);
          else if (r.o.onCenter) cb = function () { r.o.onCenter(ph.ms); };
        }
        break;
      case 'lock':
        if (r.o.onLock) cb = function () { r.o.onLock(ph.step); };
        break;
      case 'hold':
        if (r.i > 0 && ['contract', 'relocate'].indexOf(r.phases[r.i - 1].kind) >= 0 && r.o.onContract) {
          cb = function () { r.o.onContract(); };
        }
        break;
      case 'zoom':
        var level = r.o.zooms[Math.min(ph.step, r.o.zooms.length - 1)];
        var to = zoomDest(tg, mt, ph.last);
        if (ph.last && r.o.ending === 'reveal') {
          previewOn(r.o.preview, currentPalette(global.performance.now()), contour);
        }
        if (r.o.camera) ph.cam = cameraZoom(r.o.camera, tg, level, to, camStyle);
        if (r.o.onZoom) cb = function () { r.o.onZoom(ph.step, ph.ms, level, to); };
        break;
      case 'deny':
        if (r.o.onDeny) cb = function () { r.o.onDeny(T.deny + T.collapse); };
        break;
      case 'reveal':
        previewOn(r.o.preview, currentPalette(global.performance.now()));
        break;
      case 'collapse':
        ph.off = { x: r.pos.x - tg.cx, y: r.pos.y - tg.cy };
        ph.offA = { x: r.aim.x - tg.cx, y: r.aim.y - tg.cy };
        break;
    }
    if (cb) cb();
    return run === r;
  }

  /* Переход «по контуру»: прицел выглядит как выбор в удержании — та же рамка, те же
     каналы от краёв сцены к серединам сторон (rayBuild 1) и блики. Рамка — квадрат
     target(): внешний край линии на его контуре; каждый кадр перечитывается, поэтому
     рамка держится за квадрат при центрировании и растёт вместе с картой при приближении. */
  function contourState(r, ph, u) {
    var tg = r.o.target();
    var f = ph.from;
    var w = tg.r - tg.l, h = tg.b - tg.t;
    var st = {
      x: tg.cx, y: tg.cy, w: w, h: h, ax: tg.cx, ay: tg.cy,
      frameProgress: 1, rayBuild: 1, channelAlpha: 1, reach: 0,
      alpha: 1, vis: 1, fill: 0, hot: 0
    };
    var e;
    switch (ph.kind) {
      case 'shrink':
        // Как сжатие борда до области при выборе: стороны рамки плавно идут от текущей
        // рамки к сторонам квадрата и встают на них — симметрично, без перелёта и
        // поджатия. Недорисованный контур (переход нажали посреди выбора) дорисовывается.
        e = reduceMotion ? 1 : easeInOutCubic(u);
        st.x = lerp(f.x, tg.cx, e);
        st.y = lerp(f.y, tg.cy, e);
        st.w = lerp(f.w, w, e);
        st.h = lerp(f.h, h, e);
        st.frameProgress = lerp(f.frameProgress == null ? 1 : f.frameProgress, 1, e);
        st.rayBuild = f.rayBuild == null ? 1 : lerp(f.rayBuild, 1, e);
        st.channelAlpha = lerp(f.channelAlpha == null ? 1 : f.channelAlpha, 1, e);
        st.alpha = lerp(f.alpha == null ? 1 : f.alpha, 1, e);
        st.hot = 0.35 * pulse(u, 0, 1);
        break;

      case 'zoom':
        if (ph.last && r.o.ending === 'reveal') {
          // превью и темнота вокруг — в последние T.reveal мс приближения
          var revealStart = Math.max(0, 1 - T.reveal / Math.max(1, ph.ms));
          var revealU = clamp((u - revealStart) / (1 - revealStart), 0, 1);
          r.reveal = lerp(f.reveal, 1, easeOutCubic(revealU));
          r.veil = lerp(f.veil, G.revealVeil, easeInOutSine(revealU));
        } else if (ph.last && r.o.ending === 'fade') {
          r.veil = Math.max(f.veil, 0.85 * smoothstep(0.45, 1, u));
        }
        break;

      case 'fade':
        st.alpha = f.alpha * (1 - u);
        r.veil = lerp(f.veil, 1, easeInOutSine(u));
        break;

      // 'lock', 'center', 'pause', 'still' — рамка просто на контуре квадрата
    }
    st.veil = r.veil;
    st.reveal = r.reveal;
    return st;
  }

  // Состояние прицела на этапе ph при прогрессе u (0..1)
  function stateAt(r, ph, u) {
    // «по контуру» борд карты (если прицела не было) рисуется как при выборе, дальше — своё
    if (r.mode === 'go' && r.o.contour && ph.kind !== 'outline') return contourState(r, ph, u);
    var mt = metrics();
    var tg = r.o.target();
    var f = ph.from;
    var C = center();
    var st = {
      x: f.x, y: f.y, w: f.w, h: f.h, ax: f.ax, ay: f.ay,
      frameProgress: f.frameProgress == null ? 1 : f.frameProgress,
      rayBuild: f.rayBuild,
      channelAlpha: f.channelAlpha == null ? 1 : f.channelAlpha,
      reach: f.reach == null ? 1 : f.reach,
      alpha: 1, vis: 1, fill: 0, hot: 0
    };
    var lb, fr, e, k;
    switch (ph.kind) {
      case 'appear':
      case 'reset':
        st.vis = flicker(u);
        st.reach = reduceMotion ? 1 : easeOutCubic(clamp((u - 0.25) / 0.75, 0, 1));
        break;

      case 'track':
        // оси идут чуть вразнобой: вертикаль догоняет горизонталь
        var kx = servo(clamp(u * 1.12, 0, 1), ph.ov);
        var ky = servo(clamp(u * 1.12 - 0.12, 0, 1), ph.ov);
        st.x = lerp(f.x, tg.cx, kx);
        st.y = lerp(f.y, tg.cy, ky);
        st.ax = lerp(f.ax, tg.cx, kx);
        st.ay = lerp(f.ay, tg.cy, ky);
        lb = lockBox(r, tg, mt);
        e = easeInOutCubic(u);
        st.w = lerp(f.w, lb.w * G.loose, e);
        st.h = lerp(f.h, lb.h * G.loose, e);
        // если цель сменили, пока прицел угасал, — линии снова вытягиваются
        st.reach = lerp(f.reach, 1, easeOutCubic(clamp(u * 2.5, 0, 1)));
        st.alpha = lerp(f.alpha, 1, clamp(u * 3, 0, 1));
        break;

      case 'lock':
        lb = lockBox(r, tg, mt);
        k = 1 + (G.loose - 1) * (1 - easeOutCubic(clamp(u / 0.45, 0, 1)));
        st.x = st.ax = tg.cx;
        st.y = st.ay = tg.cy;
        st.w = lb.w * k; st.h = lb.h * k;
        st.fill = pulse(u, 0, 0.42) + pulse(u, 0.5, 0.92);
        st.hot = st.fill;
        break;

      case 'outline':
        // Лучи из-за границ viewport непрерывно рисуют внешний борд карты.
        lb = lockBox(r, tg, mt);
        fr = mapFrameOf(r) || frameOf(r);
        e = reduceMotion ? 1 : clamp(u, 0, 1); // линейно — без смены скорости на стыке с рамкой
        st.x = fr ? fr.x : tg.cx; st.y = fr ? fr.y : tg.cy;
        st.ax = tg.cx; st.ay = tg.cy;
        st.w = fr ? fr.w : lb.w; st.h = fr ? fr.h : lb.h;
        st.frameProgress = e;
        st.rayBuild = 1;
        st.reach = 0;
        st.channelAlpha = 1;
        st.hot = 0.35 * pulse(u, 0, 1);
        break;

      case 'contract':
        // Полностью собранные лучи остаются непрерывными, пока рамка сжимается к data-frame.
        lb = lockBox(r, tg, mt);
        fr = frameOf(r);
        e = reduceMotion ? 1 : easeInOutCubic(u);
        st.x = lerp(f.x, fr ? fr.x : tg.cx, e);
        st.y = lerp(f.y, fr ? fr.y : tg.cy, e);
        st.ax = tg.cx; st.ay = tg.cy;
        st.w = lerp(f.w, fr ? fr.w : lb.w, e);
        st.h = lerp(f.h, fr ? fr.h : lb.h, e);
        st.frameProgress = 1;
        st.rayBuild = 1;
        st.reach = 0;
        st.channelAlpha = 1;
        st.hot = 0.35 * pulse(u, 0, 1);
        break;

      case 'snap':
        // Четыре луча входят из-за краёв сцены к серединам сторон; каждый сразу
        // продолжает свой непрерывный путь по часовой стрелке вдоль рамки.
        lb = lockBox(r, tg, mt);
        fr = frameOf(r);
        st.x = fr ? fr.x : tg.cx;
        st.y = fr ? fr.y : tg.cy;
        st.ax = tg.cx; st.ay = tg.cy;
        st.w = fr ? fr.w : lb.w;
        st.h = fr ? fr.h : lb.h;
        // Единый линейный прогресс по длине траектории: скорость не меняется
        // в точке, где входящий луч переходит в дугу рамки.
        var routeU = clamp(u, 0, 1);
        st.rayBuild = routeU;
        st.reach = 1 - routeU;
        st.frameProgress = routeU;
        st.hot = 0.72 * pulse(u, 0, 1);
        break;

      case 'expand':
        // При выделении рамка раскрывается от цели до области и следует за картой.
        lb = lockBox(r, tg, mt);
        fr = frameOf(r);
        e = easeInOutCubic(u);
        st.ax = tg.cx; st.ay = tg.cy;
        if (fr) {
          st.x = lerp(tg.cx, fr.x, e); st.y = lerp(tg.cy, fr.y, e);
          st.w = lerp(lb.w, fr.w, e); st.h = lerp(lb.h, fr.h, e);
        } else {
          st.x = tg.cx; st.y = tg.cy; st.w = lb.w; st.h = lb.h;
        }
        st.hot = 0.5 * pulse(u, 0.7, 1);
        break;

      case 'hold':
        // Готовая рамка хранит координаты карты и следует за ней при панорамировании/зуме.
        lb = lockBox(r, tg, mt);
        fr = frameOf(r);
        st.ax = tg.cx; st.ay = tg.cy;
        if (fr) {
          st.x = fr.x; st.y = fr.y; st.w = fr.w; st.h = fr.h;
        } else {
          st.x = tg.cx; st.y = tg.cy; st.w = lb.w; st.h = lb.h;
        }
        break;

      case 'relocate':
        // Переводим уже существующую рамку к другой цели без сброса/повторного появления.
        lb = lockBox(r, tg, mt);
        fr = frameOf(r);
        e = reduceMotion ? 1 : easeInOutCubic(u);
        st.x = lerp(f.x, fr ? fr.x : tg.cx, e);
        st.y = lerp(f.y, fr ? fr.y : tg.cy, e);
        st.ax = lerp(f.ax, tg.cx, e);
        st.ay = lerp(f.ay, tg.cy, e);
        st.w = lerp(f.w, fr ? fr.w : lb.w, e);
        st.h = lerp(f.h, fr ? fr.h : lb.h, e);
        st.reach = lerp(f.reach, 0, e);
        st.frameProgress = 1;
        st.hot = 0.45 * pulse(u, 0.82, 1);
        break;

      case 'narrow':
        // переход: область фокуса сужается до цели (рамка — чуть свободнее, захват следом)
        lb = lockBox(r, tg, mt);
        e = easeInOutCubic(u);
        st.x = lerp(f.x, tg.cx, e); st.y = lerp(f.y, tg.cy, e);
        st.ax = lerp(f.ax, tg.cx, e); st.ay = lerp(f.ay, tg.cy, e);
        st.w = lerp(f.w, lb.w * G.loose, e); st.h = lerp(f.h, lb.h * G.loose, e);
        st.reach = lerp(f.reach, 1, easeOutCubic(clamp(u * 2.5, 0, 1)));
        st.alpha = lerp(f.alpha, 1, clamp(u * 3, 0, 1));
        st.hot = 0.45 * pulse(u, 0, 0.3);   // отклик на нажатие
        break;

      case 'center':
        // камера везёт цель в центр; прицел держится на ней, а если был в стороне —
        // плавно садится на неё
        lb = lockBox(r, tg, mt);
        e = easeInOutCubic(u);
        st.x = tg.cx + ph.off.x * (1 - e);
        st.y = tg.cy + ph.off.y * (1 - e);
        st.ax = tg.cx + ph.offA.x * (1 - e);
        st.ay = tg.cy + ph.offA.y * (1 - e);
        k = ph.loosen ? G.loose : 1;
        st.w = lerp(f.w, lb.w * k, e);
        st.h = lerp(f.h, lb.h * k, e);
        st.reach = lerp(f.reach, 1, easeOutCubic(clamp(u * 2.5, 0, 1)));
        st.alpha = lerp(f.alpha, 1, clamp(u * 3, 0, 1));
        break;

      case 'pause':
        // Камера и рамка удерживают сфокусированную цель перед началом zoom.
        break;

      case 'zoom':
        // рамка раскрывается до краёв сцены и едет к центру — размер от экрана, не от цели
        e = easeInOutCubic(u);
        st.x = st.ax = lerp(f.x, C.x, e);
        st.y = st.ay = lerp(f.y, C.y, e);
        st.w = lerp(f.w, cw * G.frameOver, e);
        st.h = lerp(f.h, ch * G.frameOver, e);
        st.alpha = ph.last && r.o.ending === 'reveal' ? 1 : 1 - smoothstep(0.72, 1, u);
        st.hot = 0.45 * (1 - clamp(u / 0.3, 0, 1));
        if (ph.last && r.o.ending === 'fade') r.veil = Math.max(f.veil, 0.85 * smoothstep(0.45, 1, u));
        if (ph.last && r.o.ending === 'reveal') {
          var revealStart = Math.max(0, 1 - T.reveal / Math.max(1, ph.ms));
          var revealU = clamp((u - revealStart) / (1 - revealStart), 0, 1);
          r.reveal = lerp(f.reveal, 1, easeOutCubic(revealU));
          r.veil = lerp(f.veil, G.revealVeil, easeInOutSine(revealU));
        }
        break;

      case 'reveal':
        st.alpha = 0;
        r.veil = lerp(f.veil, G.revealVeil, easeInOutSine(u));
        r.reveal = lerp(f.reveal, 1, easeOutCubic(u));
        break;

      case 'still':
        st.alpha = 0;
        break;

      case 'fade':
        st.alpha = f.alpha * (1 - u);
        r.veil = lerp(f.veil, 1, easeInOutSine(u));
        break;

      case 'error':
        // захват срывается: рамка дёргается, мигает и прыгает в размере
        var slice = Math.floor(u * 16);
        var h1 = hash(slice + 1), h2 = hash(slice + 101), h3 = hash(slice + 211);
        var amp = reduceMotion ? 0 : 1;
        st.x = f.x + (h1 - 0.5) * 0.034 * mt.m * (1 - u * 0.5) * amp;
        st.y = f.y + (h2 - 0.5) * 0.012 * mt.m * amp;
        st.ax = st.x; st.ay = st.y;
        k = 1 + (h3 > 0.6 ? (h3 - 0.6) * 0.8 : 0) * amp;
        st.w = f.w * k; st.h = f.h * k;
        if (reduceMotion) {
          // без мигания: одна мягкая вспышка
          st.hot = 0.6 * pulse(u, 0, 1);
          break;
        }
        st.vis = h2 < 0.22 ? 0 : 1;
        st.hot = h1 > 0.72 ? 1 : 0;
        st.fill = h1 > 0.86 ? 0.6 : 0;
        break;

      case 'deny':
        lb = lockBox(r, tg, mt);
        st.x = st.ax = tg.cx;
        st.y = st.ay = tg.cy;
        st.w = lb.w; st.h = lb.h;
        st.fill = 0.85 * (pulse(u, 0.04, 0.42) + pulse(u, 0.52, 0.9));
        st.hot = st.fill;
        break;

      case 'collapse':
        // линии втягиваются в рамку, рамка сжимается и гаснет
        e = easeInCubic(clamp(u / 0.75, 0, 1));
        if (ph.follow) {
          st.x = tg.cx + ph.off.x; st.y = tg.cy + ph.off.y;
          st.ax = tg.cx + ph.offA.x; st.ay = tg.cy + ph.offA.y;
        }
        st.w = f.w * (1 - 0.25 * e);
        st.h = f.h * (1 - 0.25 * e);
        st.reach = f.reach * (1 - e);
        st.alpha = f.alpha * (1 - smoothstep(0.4, 1, u));
        break;

      case 'unload':
        // Снятие выбора — тот же маршрут в обратную сторону: контур уходит
        // против часовой стрелки, а энергия покидает область обратно к краям.
        e = easeInOutCubic(u);
        st.frameProgress = (f.frameProgress == null ? 1 : f.frameProgress) * (1 - e);
        st.rayBuild = lerp(f.rayBuild == null ? 1 : f.rayBuild, 0, e);
        st.reach = lerp(f.reach, 1, e);
        st.flowDirection = -1;
        st.hot = 0.35 * pulse(u, 0, 1);
        st.alpha = f.alpha * (1 - smoothstep(0.92, 1, u));
        break;
    }
    st.veil = r.veil;
    st.reveal = r.reveal;
    return st;
  }

  /* ---------- рисование ---------- */
  // Геометрия четырёх каналов. Каждый луч с края сцены входит в середину стороны,
  // проходит по часовой стрелке половину стороны, угол и половину следующей стороны.
  function shapes(st, sw) {
    var l = st.x - st.w / 2, r = st.x + st.w / 2, t = st.y - st.h / 2, b = st.y + st.h / 2;
    var hs = sw / 2;
    var bw = Math.max(sw, st.w), bh = Math.max(sw, st.h);
    var p = st.frameProgress == null ? 1 : clamp(st.frameProgress, 0, 1);
    var lines = [];
    var box = [];
    var tracks = [];
    var rayBuild = st.rayBuild;

    function addSegment(target, x, y, dx, dy, length, alpha) {
      if (length <= 0.01) return;
      var shape;
      if (dx > 0) shape = { x: x - hs, y: y - hs, w: length + sw, h: sw, v: false };
      else if (dx < 0) shape = { x: x - length - hs, y: y - hs, w: length + sw, h: sw, v: false };
      else if (dy > 0) shape = { x: x - hs, y: y - hs, w: sw, h: length + sw, v: true };
      else shape = { x: x - hs, y: y - length - hs, w: sw, h: length + sw, v: true };
      if (alpha != null) shape.alpha = alpha;
      if (target === lines) {
        shape.ex = x; shape.ey = y; shape.dx = dx; shape.dy = dy;
        shape.len = length; shape.flow = 1;
        lines.push(shape);
      } else {
        box.push(shape);
        tracks.push({ ex: x, ey: y, dx: dx, dy: dy, len: length, v: !!dy, flow: 1 });
      }
    }

    if (rayBuild != null) {
      // One distance clock per route: each ray enters from beyond the canvas,
      // reaches its side midpoint, and continues around the corner without pausing.
      var cx = st.x, cy = st.y;
      var lx = l + hs, rx = r - hs, ty = t + hs, by = b - hs;
      var halfW = Math.max(0, (bw - sw) / 2);
      var halfH = Math.max(0, (bh - sw) / 2);
      var alpha = Math.max(0.32, 1 - 0.68 * p) * (st.channelAlpha == null ? 1 : clamp(st.channelAlpha, 0, 1));

      function traceRoute(x, y, rayDx, rayDy, rayLen, dx1, dy1, len1, dx2, dy2, len2) {
        var distance = p * (rayLen + len1 + len2);
        var amount = Math.min(rayLen, distance);
        addSegment(lines, x, y, rayDx, rayDy, amount, alpha);
        distance -= amount;
        if (amount < rayLen) return;
        x += rayDx * rayLen; y += rayDy * rayLen;
        amount = Math.min(len1, distance);
        addSegment(box, x, y, dx1, dy1, amount);
        distance -= amount;
        x += dx1 * amount; y += dy1 * amount;
        if (amount < len1) return;
        amount = Math.min(len2, distance);
        addSegment(box, x, y, dx2, dy2, amount);
      }

      // Входящий луч и продолжение по периметру — одна непрерывная траектория.
      traceRoute(cx, -hs, 0, 1, ty + hs, 1, 0, halfW, 0, 1, halfH);       // верх → право
      traceRoute(cw + hs, cy, -1, 0, cw + hs - rx, 0, 1, halfH, -1, 0, halfW); // право → низ
      traceRoute(cx, ch + hs, 0, -1, ch + hs - by, -1, 0, halfW, 0, -1, halfH); // низ → лево
      traceRoute(-hs, cy, 1, 0, lx + hs, 0, -1, halfH, 1, 0, halfW);       // лево → верх
    } else {
      var ax = clamp(st.ax, l + hs, r - hs);
      var ay = clamp(st.ay, t + hs, b - hs);
      var x1 = l + hs * (1 - st.reach), x2 = r - hs + (cw - (r - hs)) * st.reach;
      var y1 = t + hs * (1 - st.reach), y2 = b - hs + (ch - (b - hs)) * st.reach;
      if (l + hs > 0 && l + hs - x1 > 0.5) lines.push({ x: x1, y: ay - hs, w: l + hs - x1, h: sw, v: false, ex: l + hs, ey: ay, dx: -1, dy: 0, len: l + hs - x1, flow: -1 });
      if (r - hs < cw && x2 - (r - hs) > 0.5) lines.push({ x: r - hs, y: ay - hs, w: x2 - (r - hs), h: sw, v: false, ex: r - hs, ey: ay, dx: 1, dy: 0, len: x2 - (r - hs), flow: -1 });
      if (t + hs > 0 && t + hs - y1 > 0.5) lines.push({ x: ax - hs, y: y1, w: sw, h: t + hs - y1, v: true, ex: ax, ey: t + hs, dx: 0, dy: -1, len: t + hs - y1, flow: -1 });
      if (b - hs < ch && y2 - (b - hs) > 0.5) lines.push({ x: ax - hs, y: b - hs, w: sw, h: y2 - (b - hs), v: true, ex: ax, ey: b - hs, dx: 0, dy: 1, len: y2 - (b - hs), flow: -1 });

      var perimeterHalfW = Math.max(0, (bw - sw) / 2);
      var perimeterHalfH = Math.max(0, (bh - sw) / 2);
      function addArc(x, y, dx1, dy1, len1, dx2, dy2, len2) {
        var remaining = p * (2 * (perimeterHalfW + perimeterHalfH));
        var first = Math.min(len1, remaining);
        addSegment(box, x, y, dx1, dy1, first);
        x += dx1 * first; y += dy1 * first;
        remaining -= first;
        var second = Math.min(len2, remaining);
        addSegment(box, x, y, dx2, dy2, second);
      }
      addArc(st.x, t + hs, 1, 0, perimeterHalfW, 0, 1, perimeterHalfH);
      addArc(r - hs, st.y, 0, 1, perimeterHalfH, -1, 0, perimeterHalfW);
      addArc(st.x, b - hs, -1, 0, perimeterHalfW, 0, -1, perimeterHalfH);
      addArc(l + hs, st.y, 0, -1, perimeterHalfH, 1, 0, perimeterHalfW);
    }

    return { lines: lines, box: box, tracks: tracks, l: l, t: t, w: bw, h: bh };
  }

  function fillRects(list, dx, dy) {
    var baseAlpha = ctx.globalAlpha;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      ctx.globalAlpha = baseAlpha * (s.alpha == null ? 1 : s.alpha);
      if (ctx.globalAlpha > 0.003) ctx.fillRect(s.x + dx, s.y + dy, s.w, s.h);
    }
    ctx.globalAlpha = baseAlpha;
  }

  // Энергетические импульсы непрерывно бегут по внешним каналам и периметру.
  // Слоты распределяются по длине дорожек: одновременно на экране около 600 импульсов.
  function drawGlints(paths, sw, a, pal, now, flowDirection) {
    var active = paths.filter(function (path) { return path.len > sw * 2 && (path.alpha == null || path.alpha > 0.003); });
    var total = active.reduce(function (sum, path) { return sum + path.len; }, 0);
    if (!total) return;

    var count = G.glintCount;
    var slots = active.map(function (path) { return Math.floor(count * path.len / total); });
    var used = slots.reduce(function (sum, value) { return sum + value; }, 0);
    var fractions = active.map(function (path, i) {
      return { index: i, remainder: count * path.len / total - slots[i] };
    }).sort(function (x, y) { return y.remainder - x.remainder; });
    for (var extra = 0; extra < count - used; extra++) slots[fractions[extra].index]++;

    var M = Math.max(cw, ch);
    for (var j = 0; j < active.length; j++) {
      var path = active[j];
      var n = slots[j];
      for (var k = 0; k < n; k++) {
        var seed = (j + 1) * 1009 + k * 37;
        var phase = hash(seed + 3) * path.len;
        var speed = G.glintSpeed * M * (0.58 + hash(seed + 7) * 1.28);
        var direction = (path.flow == null ? -1 : path.flow) * (flowDirection || 1);
        var d = mod(phase + (reduceMotion ? 0 : now * speed * direction / 1000), path.len);
        var fade = smoothstep(0, sw * 1.6, d) * smoothstep(0, sw * 1.6, path.len - d);
        if (fade <= 0.01) continue;

        var cx = path.ex + path.dx * d, cy = path.ey + path.dy * d;
        var length = sw * (1.8 + hash(seed + 11) * 2.4);
        var thickness = Math.max(1, sw * (0.38 + hash(seed + 13) * 0.24));
        var flicker = reduceMotion ? 1 : 0.46 + 0.54 * (0.5 + 0.5 * Math.sin(now * 0.0025 * (0.7 + hash(seed + 17)) + hash(seed + 19) * Math.PI * 2));
        var pathAlpha = path.alpha == null ? 1 : path.alpha;
        var intensity = (0.28 + 0.72 * hash(seed + 23)) * flicker * fade * pathAlpha;
        var gradient;
        if (path.v) gradient = ctx.createLinearGradient(0, cy - length / 2, 0, cy + length / 2);
        else gradient = ctx.createLinearGradient(cx - length / 2, 0, cx + length / 2, 0);
        gradient.addColorStop(0, rgba(pal.light, 0));
        gradient.addColorStop(0.5, rgba(pal.light, 0.88 * a * intensity));
        gradient.addColorStop(1, rgba(pal.light, 0));
        ctx.fillStyle = gradient;
        if (path.v) ctx.fillRect(cx - thickness / 2, cy - length / 2, thickness, length);
        else ctx.fillRect(cx - length / 2, cy - thickness / 2, length, thickness);
      }
    }
  }

  function draw(r, st, now) {
    if (!ctx) return;
    var mt = metrics();
    var sw = mt.sw;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // «По контуру» темнеет только карта: рамка вокруг превью остаётся яркой (темнота под ней)
    var contour = r.mode === 'go' && r.o.contour;
    if (contour) drawVeil(st);
    var a = st.alpha * st.vis;
    if (a > 0.003) {
      var pal = currentPalette(now);
      var core = mix(pal.core, pal.light, clamp(st.hot, 0, 1) * 0.72);
      var sh = shapes(st, sw);
      var all = sh.lines.concat(sh.box);
      var edge = Math.max(1, sw * 0.16);

      // 1. свечение
      ctx.save();
      ctx.shadowColor = rgba(pal.glow, 0.55 * a);
      ctx.shadowBlur = sw * 1.1 * dpr;
      ctx.fillStyle = rgba(core, a);
      fillRects(all, 0, 0);
      ctx.restore();
      // 2. Тёмную кромку оставляем только у внешнего контура, а не на торцах
      // незавершённых сегментов. Так активный конец луча не выглядит отдельной рамкой.
      var edgeShapes = st.frameProgress == null || st.frameProgress >= 0.999 ? sh.box : [];
      ctx.fillStyle = rgba(pal.shadow, 0.9 * a);
      fillRects(edgeShapes, edge, edge);
      // 3. основной цвет
      ctx.fillStyle = rgba(core, a);
      fillRects(all, 0, 0);
      // 4. светлая фаска по верхнему / левому краю; у рамки ярче, как в брифинге
      var hl = Math.max(1, sw * 0.2);
      for (var i = 0; i < all.length; i++) {
        var s = all[i];
        ctx.globalAlpha = s.alpha == null ? 1 : s.alpha;
        ctx.fillStyle = rgba(pal.light, (i < sh.lines.length ? 0.28 : 0.48) * a);
        if (s.v) ctx.fillRect(s.x, s.y, hl, s.h);
        else ctx.fillRect(s.x, s.y, s.w, hl);
      }
      ctx.globalAlpha = 1;
      // 5. непрерывные импульсы идут по лучам и уже собранным сторонам рамки
      drawGlints(sh.lines.concat(sh.tracks), sw, a, pal, now, st.flowDirection);
      // 6. вспышка захвата внутри рамки (только у рамки размером с захват:
      //    большую область фокуса заливка залила бы целиком)
      if (st.fill > 0.003) {
        var iw = sh.w - sw * 2, ih = sh.h - sw * 2;
        var big = Math.max(1, (sh.w * sh.h) / (G.fitMax * G.fitMax * mt.m * mt.m * G.boxH / G.boxW));
        var fa = st.fill / big;
        if (iw > 0 && ih > 0 && fa > 0.003) {
          ctx.save();
          ctx.shadowColor = rgba(pal.light, 0.8 * fa * a);
          ctx.shadowBlur = sw * 2.4 * dpr;
          ctx.fillStyle = rgba(pal.light, 0.5 * fa * a);
          ctx.fillRect(sh.l + sw, sh.t + sw, iw, ih);
          ctx.restore();
        }
      }
    }
    // уход в темноту — поверх прицела (превью лежит выше холста и не темнеет)
    if (!contour) drawVeil(st);
    if (previewEl) {
      var tg = r.o.target();
      // «по контуру» превью — внутри рамки: линия рамки лежит по контуру квадрата внутрь
      // на толщину sw, превью её не закрывает
      placePreview(contour ? { l: tg.l + sw, t: tg.t + sw, w: tg.r - tg.l - 2 * sw } : tg, st.reveal);
    }
  }

  function drawVeil(st) {
    if (!(st.veil > 0.003)) return;
    ctx.fillStyle = rgba(G.veil, st.veil);
    ctx.fillRect(0, 0, cw, ch);
  }

  /* ---------- цикл ---------- */
  function progress(r, ph, now) { return ph.ms > 0 ? (now - r.t0) / ph.ms : 1; }

  function remember(r, st) {
    r.pos = { x: st.x, y: st.y };
    r.box = { w: st.w, h: st.h };
    r.aim = { x: st.ax, y: st.ay };
    r.alpha = st.alpha;
    r.reach = st.reach;
    r.frameProgress = st.frameProgress;
    r.rayBuild = st.rayBuild;
    r.channelAlpha = st.channelAlpha;
  }

  function loop(now) {
    var r = run;
    if (!r) return;
    r.raf = 0;
    fitCanvas();
    syncPalette(now);
    var ph = r.phases[r.i];
    var u = progress(r, ph, now);
    // этап закончился — фиксируем его последнее состояние и входим в следующий
    while (u >= 1) {
      applyCamera(r, ph, 1);
      var last = stateAt(r, ph, 1);
      remember(r, last);
      if (r.i === r.phases.length - 1) {
        draw(r, last, now);
        run = null;                        // после перехода прицел остаётся на экране до stop()
        if (r.mode === 'release') detach(); // выбор снят — холст убираем
        if (r.o.onEnd) r.o.onEnd();
        return;
      }
      r.t0 += ph.ms;
      r.i += 1;
      ph = r.phases[r.i];
      if (!enter(r, ph)) return;           // остановлено из колбэка
      u = progress(r, ph, now);
    }
    applyCamera(r, ph, u);
    var st = stateAt(r, ph, clamp(u, 0, 1));
    remember(r, st);
    draw(r, st, now);
    r.raf = global.requestAnimationFrame(loop);
  }

  // Новый сценарий: первый кадр сразу, без пустого мига
  function begin(o, mode, phases, from) {
    var r = {
      o: o,
      mode: mode,
      phases: phases,
      i: 0,
      t0: global.performance.now(),
      pos: from.pos,
      box: from.box,
      aim: from.aim,
      alpha: from.alpha,
      reach: from.reach,
      frameProgress: from.frameProgress == null ? 1 : from.frameProgress,
      rayBuild: from.rayBuild,
      channelAlpha: from.channelAlpha,
      veil: 0,
      reveal: 0,
      fixed: null,
      raf: 0
    };
    var lockScreen = typeof o.lockScreen === 'boolean' ? o.lockScreen : G.lockScreen;
    if (mode === 'go' && lockScreen) r.fixed = fitBox(o.target().w, metrics().m);   // фиксируем размер только если этого просит сценарий
    run = r;
    if (!enter(r, r.phases[0])) return;
    applyCamera(r, r.phases[0], 0);
    draw(r, stateAt(r, r.phases[0], 0), r.t0);
    r.raf = global.requestAnimationFrame(loop);
  }

  // Прицел уже на экране (выбор или его угасание): забираем его текущее состояние,
  // чтобы новый сценарий продолжил с того же места, без скачка. null — прицела нет.
  function takeOver(stage) {
    var r = run;
    if (!r || r.mode === 'go' || !canvas || stageEl !== stage) return null;
    if (r.raf) global.cancelAnimationFrame(r.raf);
    run = null;
    return {
      pos: r.pos, box: r.box, aim: r.aim, alpha: r.alpha, reach: r.reach,
      frameProgress: r.frameProgress, rayBuild: r.rayBuild,
      channelAlpha: r.channelAlpha
    };
  }

  // Прицел с нуля: маленькая рамка в центре сцены
  function fresh(stage) {
    stop();
    attach(stage);
    var mt = metrics();
    var c = center();
    return { pos: c, box: { w: mt.rest.w, h: mt.rest.h }, aim: { x: c.x, y: c.y }, alpha: 1, reach: 0, frameProgress: 1 };
  }

  function valid(opts) { return !!(opts && opts.stage && typeof opts.target === 'function'); }

  function select(opts) {
    if (!valid(opts) || (run && run.mode === 'go')) return;   // переход не прерываем
    var from = takeOver(opts.stage);
    var isNew = !from;
    if (isNew) from = fresh(opts.stage);
    var o = {
      target: opts.target,
      frame: typeof opts.frame === 'function' ? opts.frame : null,
      mapFrame: typeof opts.mapFrame === 'function' ? opts.mapFrame : null,
      onLock: opts.onLock || null,
      onContract: opts.onContract || null,
      onEnd: null
    };
    if (opts.instant) {
      if (o.onLock) o.onLock(0);
      if (isNew && o.mapFrame && o.frame) {
        // Лучи рисуют борд карты и продолжаются при сжатии; затем страница ведёт камеру.
        begin(o, 'select', [
          { kind: 'outline', ms: reduceMotion ? 0 : T.mapOutline },
          { kind: 'contract', ms: reduceMotion ? 0 : T.contract },
          { kind: 'hold', ms: Infinity }
        ], from);
      } else if (isNew) {
        // Запасной режим: каналы сходятся к рамке на месте.
        begin(o, 'select', [{ kind: 'snap', ms: T.snap }, { kind: 'hold', ms: Infinity }], from);
      } else {
        // При смене цели рамка переезжает без сброса, после чего камера центрирует область.
        begin(o, 'select', [
          { kind: 'relocate', ms: reduceMotion ? 0 : T.relocate },
          { kind: 'hold', ms: Infinity }
        ], from);
      }
      return;
    }
    begin(o, 'select', planSelect(o, isNew), from);
  }

  function release(done) {
    var r = run;
    if (r && r.mode === 'go') return;                          // переход доиграет сам
    if (r && r.mode === 'release') { r.o.onEnd = done || null; return; }
    if (!r) { stop(); if (done) done(); return; }
    var from = takeOver(stageEl);
    var o = { target: r.o.target, frame: null, onEnd: done || null };
    begin(o, 'release', [{ kind: 'unload', ms: reduceMotion ? 0 : T.release }], from);
  }

  function start(opts) {
    if (!valid(opts)) return;
    var from = takeOver(opts.stage);
    var isNew = !from;
    if (isNew) from = fresh(opts.stage);
    var cam = opts.camera && typeof opts.camera.get === 'function' && typeof opts.camera.set === 'function' ? opts.camera : null;
    var zooms = Array.isArray(opts.zooms) ? opts.zooms.filter(function (z) { return z > 0; }) : [];
    var ending = ['reveal', 'fade', 'error', 'deny'].indexOf(opts.ending) >= 0 ? opts.ending : 'fade';
    // «по контуру» — только с финалом-переходом ('reveal' / 'fade'); срыв и отказ — обычный
    var contour = !!opts.contour && (ending === 'reveal' || ending === 'fade');
    if (reduceMotion) zooms = [];
    // превью проявляется в квадрате цели после приближения; без него — уход в темноту
    if (ending === 'reveal' && (!opts.preview || !zooms.length)) ending = 'fade';
    // «по контуру» карта, как при выборе, не темнеет до самого финала
    if (!contour) dimOn();
    var tm = opts.timing || {};
    function ms(v, fallback) { return typeof v === 'number' && v >= 0 ? v : fallback; }
    var o = {
      target: opts.target,
      frame: typeof opts.frame === 'function' ? opts.frame : null,
      mapFrame: typeof opts.mapFrame === 'function' ? opts.mapFrame : null,
      camera: cam,
      contour: contour,
      timing: {
        center: ms(tm.center, T.focusCenter),
        pause: ms(tm.pause, T.zoomDelay),
        zoom: ms(tm.zoom, T.focusZoom)
      },
      lockScreen: typeof opts.lockScreen === 'boolean' ? opts.lockScreen : null,
      zooms: zooms,
      ending: ending,
      preview: opts.preview || '',
      onCenter: opts.onCenter || null,
      onLock: opts.onLock || null,
      onZoom: opts.onZoom || null,
      onDeny: opts.onDeny || null,
      onEnd: opts.onEnd || null
    };
    begin(o, 'go', planGo(o, isNew), from);
  }

  function active() { return run ? run.mode : (canvas ? 'idle' : null); }

  function refresh() {
    // Подгоняем холст при изменении сцены; экранные координаты цели и рамки
    // перечитываются следующим кадром, в том числе в режиме hold.
    if (run && canvas) fitCanvas();
  }

  function stop() {
    if (run && run.raf) global.cancelAnimationFrame(run.raf);
    run = null;
    detach();
  }

  global.FocusFx = {
    select: select,
    release: release,
    start: start,
    active: active,
    refresh: refresh,
    stop: stop,
    T: T,
    G: G
  };
})(window);
