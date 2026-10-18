/* CursorFx — курсор сайта в духе брифингов StarCraft II: зелёная стрелка-шеврон, по грани
   которой раз в 2,25 с пробегает шлейф синих частиц, а при наведении на кликабельное —
   цепочка из четырёх треугольников с «каскадом» и «волной» заливки.

   ПОЧЕМУ СИСТЕМНЫЙ КУРСОР, А НЕ НАРИСОВАННЫЙ ЭЛЕМЕНТ
   Курсор рисует операционная система, поэтому он не отстаёт от мыши ни на кадр. Элемент
   страницы, который двигают вслед за мышью, отстаёт минимум на кадр, какими бы приёмами
   его ни двигали (rAF, translate3d, passive). У системного курсора два ограничения:
     • картинка не больше 32×32 CSS px: больше — у краёв окна браузер подменяет её
       стандартной стрелкой, больше 128×128 — не показывает вовсе;
     • анимированные GIF/PNG/SVG/ANI в курсоре не играют — виден только первый кадр.
   Поэтому модуль рисует кадры сам и листает их таймером, а состояния переключает браузер.

   КАК УСТРОЕНО
   1. Кадры строятся из геометрии задумки (SVG, единицы задумки → px через CONFIG.*.scale):
      стрелка — кадр каждые 50 мс цикла 2,25 с, треугольники — цикла 3 с. Одинаковые подряд
      кадры склеиваются, поэтому пауза между пролётами частиц — один кадр.
   2. Каждый кадр растеризуется в браузере (программный canvas) в PNG 32×32 и 64×64 для
      экранов 2×. Файлов-картинок нет, сборка не нужна. Сначала готовятся статичные кадры
      (курсор появляется сразу), анимация — следом, в фоне (≈0,4 с). Готовые PNG хранятся в
      localStorage (≈0,6 МБ), и на следующих страницах кадры берутся оттуда за миллисекунды.
   3. В <head> добавляется <style id="cursor-fx"> со статичными кадрами состояний (!important):
        обычный        — всё, в том числе поля ввода и поиск (решение: стрелка, не I-образный);
        наведение      — ссылки, кнопки, [role=button], классы сайта из CONFIG.hover и системы
                         на карте атласа (#mapCanvas.marker-hover);
        недоступно     — CONFIG.disabled (ОЗД после отказа, :disabled): приглушённая стрелка;
        перетаскивание — пока зажата карта (CONFIG.drag): стрелка без частиц.
      Какое состояние показать, решает браузер по элементу под мышью: координаты мыши модуль
      не отслеживает, поэтому задержки нет.
   4. Анимация: таймер ставит очередной кадр в style того элемента, что под мышью (с него
      браузер и берёт курсор), и только пока идёт анимация — 20 кадров в секунду, чаще Chrome
      курсор не перерисовывает. Общие правила при этом не меняются: смена правила пересчитала
      бы стили всей страницы на каждом кадре. Над элементом с сотнями детей
      (CONFIG.maxChildren) кадр стоит: смена cursor у родителя пересчитывает стили детей.

   ПОДКЛЮЧЕНИЕ
     <script src="/shared/cursor-fx.js?v=…" defer></script>
   Больше ничего не нужно. Старые правила cursor в CSS сайта не удаляйте: они работают, если
   модуль выключен или не загрузился.
   Новый кликабельный элемент делайте <button> или <a href>. Если это div или область на
   canvas, добавьте класс в CONFIG.hover либо атрибут data-cursor="hover"
   (data-cursor="disabled" — приглушённая стрелка).

   ВАРИАНТЫ ВЫВОДА — как картинка отдаётся браузеру
     set    — image-set(PNG 1x, PNG 2x): чётко на ретине в Chrome, Edge, Safari (по умолчанию);
     webkit — то же через -webkit-image-set (старые Chrome и Safari);
     svg    — SVG и запасной PNG: чётко на любом масштабе в Firefox (по умолчанию в Firefox);
     png    — один PNG 32×32: работает везде, на ретине мягче.
   Для проверки: ?cursor=set|webkit|svg|png|off|auto в адресе любой страницы (запоминается
   в localStorage для всего сайта, auto — сброс) и страница /cursor-test/.

   ЗАПАСНЫЕ ПУТИ
     • нет мыши (только касание) или режим высокой контрастности — модуль ничего не делает;
     • prefers-reduced-motion — статичные кадры;
     • вкладка скрыта или мышь вне окна — таймер стоит;
     • растеризация не удалась — вариант svg, иначе системные курсоры.

   API (window.CursorFx): info(), frames(), setVariant(name), enable(), disable().
*/
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  if (!window.matchMedia || !window.CSS || !CSS.supports || !doc.head) return;

  var CONFIG = {
    size: 32,                    // CSS px — сторона картинки курсора (надёжный предел)
    hotspot: [1, 1],             // точка клика от левого верхнего угла картинки, CSS px
    step: 50,                    // мс — шаг кадров анимации (20 к/с)
    maxChildren: 300,            // над элементом с большим числом детей кадр не меняется:
                                 // смена cursor у родителя пересчитывает стили всех детей
    colors: {
      core: '#00ff66', mid: '#008822', dark: '#003300', cut: '#0d0e12', glint: '#00ffff',
      particles: ['#00d9ff', '#00d9ff', '#00ffff', '#00aaff'], particleEdge: '#ffffff'
    },
    arrow: {
      cycle: 2250,               // мс — период пролёта частиц
      scale: 0.809,              // px на единицу задумки: тело ≈ 27,5 px из 32
      tip: 2.1,                  // px — вершина острия; с острым углом контура остриё ≈ 1 px
      delays: [0, 60, 120, 180], // мс — шлейф частиц
      sizes: [[4, 4], [5, 3], [3, 5], [4, 4]]
    },
    tri: {
      cycle: 3000,               // мс — каскад + волна
      scale: 0.8,
      tip: 2.1,
      stroke: 1.6,               // px — контур одинаковой толщины у всех сегментов
      // [масштаб, сдвиг по диагонали в единицах задумки]: сегменты наложены, как в задумке
      segments: [[1, 0], [1 / 1.7, 15], [1 / (1.7 * 1.7), 25], [1 / (1.7 * 1.7 * 1.7), 31]],
      hoverStart: 150,           // мс цикла, с которых начинается анимация при наведении
      still: 750                 // мс цикла — кадр для prefers-reduced-motion
    },
    hover: [
      'a[href]', 'button:not(:disabled)', '[role="button"]', 'select', 'summary', 'label[for]',
      'input[type="checkbox"]', 'input[type="radio"]', 'input[type="button"]',
      'input[type="submit"]', 'input[type="reset"]',
      // классы сайта: кнопки-не-кнопки и области с собственным hit-test
      '.sector-hotspot', '.sector-list-item', '.catalog-row', '.catalog-section', '.suggestion',
      '.world-card', '.filter-chip', '.map-control', '.icon-button', '.top-action',
      '.sort-button', '.search-clear', '#mapCanvas.marker-hover', '[data-cursor="hover"]'
    ].join(', '),
    disabled: '.is-odz-locked, button:disabled, [aria-disabled="true"], [data-cursor="disabled"]',
    drag: '.galaxy-stage.is-dragging, #mapCanvas.dragging',
    dragWatch: '.galaxy-stage, #mapCanvas'
  };

  var VARIANTS = ['set', 'webkit', 'svg', 'png'];
  var STORE_KEY = 'cursorFx.variant';

  // --- математика -------------------------------------------------------------------------

  function lerp(a, b, k) { return a + (b - a) * k; }
  function num(x, digits) { var v = +x.toFixed(digits); return String(v === 0 ? 0 : v); }

  // cubic-bezier, как в CSS: x(s) = t решается методом Ньютона с запасным делением пополам
  function bezier(x1, y1, x2, y2) {
    function curve(a, b, s) { return ((1 - 3 * b + 3 * a) * s + (3 * b - 6 * a)) * s * s + 3 * a * s; }
    function slope(a, b, s) { return 3 * (1 - 3 * b + 3 * a) * s * s + 2 * (3 * b - 6 * a) * s + 3 * a; }
    return function (t) {
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      var s = t;
      for (var i = 0; i < 8; i++) {
        var dx = curve(x1, x2, s) - t;
        if (Math.abs(dx) < 1e-6) return curve(y1, y2, s);
        var d = slope(x1, x2, s);
        if (Math.abs(d) < 1e-6) break;
        s -= dx / d;
      }
      var lo = 0, hi = 1;
      s = t;
      for (var j = 0; j < 30; j++) {
        if (curve(x1, x2, s) < t) lo = s; else hi = s;
        s = (lo + hi) / 2;
      }
      return curve(y1, y2, s);
    };
  }
  var easeOut = bezier(0.25, 1, 0.5, 1);     // частицы
  var easeInOut = bezier(0.42, 0, 0.58, 1);  // блик грани

  // частицы: [доля цикла, позиция на грани (0 — нос 6,6; 1 — хвост 40,22), масштаб, поворот°,
  // непрозрачность]. До 65 % частица скрыта у носа.
  var PARTICLE_KEYS = [
    [0.65, 0, 0.2, 0, 0],
    [0.75, 6 / 34, 1.2, 15, 1],
    [0.90, 24 / 34, 0.9, 45, 0.9],
    [1.00, 36 / 34, 0.1, 90, 0]
  ];
  function particleAt(p) {
    if (p < PARTICLE_KEYS[0][0]) return null;
    for (var i = 1; i < PARTICLE_KEYS.length; i++) {
      var a = PARTICLE_KEYS[i - 1], b = PARTICLE_KEYS[i];
      if (p <= b[0]) {
        var k = easeOut((p - a[0]) / (b[0] - a[0]));
        return { u: lerp(a[1], b[1], k), s: lerp(a[2], b[2], k), r: lerp(a[3], b[3], k), o: lerp(a[4], b[4], k) };
      }
    }
    return null;
  }
  // блик грани: 0 — покой, 1 — вспышка (70 % → 85 % → 100 %)
  function glintAt(p) {
    if (p < 0.7) return 0;
    if (p < 0.85) return easeInOut((p - 0.7) / 0.15);
    return easeInOut(1 - (p - 0.85) / 0.15);
  }
  // заливка сегментов треугольника, линейно: [доля цикла, заливка]; 1 — большой … 4 — малый
  var FILL_KEYS = [
    [[0, 0], [0.3, 0], [0.4, 1], [0.5, 0], [0.8, 0], [0.9, 1], [1, 0]],
    [[0, 0], [0.2, 0], [0.3, 1], [0.4, 1], [0.5, 0], [0.7, 0], [0.8, 1], [0.9, 0], [1, 0]],
    [[0, 0], [0.1, 0], [0.2, 1], [0.4, 1], [0.5, 0], [0.6, 0], [0.7, 1], [0.8, 0], [1, 0]],
    [[0, 0], [0.1, 1], [0.4, 1], [0.5, 0], [0.6, 1], [0.7, 0], [1, 0]]
  ];
  function fillAt(keys, p) {
    for (var i = 1; i < keys.length; i++) {
      if (p <= keys[i][0]) return lerp(keys[i - 1][1], keys[i][1], (p - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
    }
    return 0;
  }

  // --- кадры: описание → SVG ---------------------------------------------------------------

  function arrowFrame(t, opts) {
    var A = CONFIG.arrow;
    var parts = [];
    if (opts.parts) {
      for (var i = 0; i < A.delays.length; i++) {
        var local = (((t - A.delays[i]) % A.cycle) + A.cycle) % A.cycle;
        var k = particleAt(local / A.cycle);
        if (k && k.o > 0.02) parts.push([i, num(k.u, 3), num(k.s, 2), num(k.r, 0), num(k.o, 2)]);
      }
    }
    return { kind: 'arrow', g: opts.parts ? num(glintAt(t / A.cycle), 2) : '0', parts: parts, glow: opts.glow || 1, dim: !!opts.dim };
  }

  function triFrame(t) {
    var p = t / CONFIG.tri.cycle;
    return { kind: 'tri', fills: FILL_KEYS.map(function (keys) { return num(fillAt(keys, p), 2); }) };
  }

  function svgOpen(px, origin, span) {
    var box = num(origin, 3) + ' ' + num(origin, 3) + ' ' + num(span, 3) + ' ' + num(span, 3);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="' + box + '">';
  }

  function glowFilter(id, sd) {
    return '<filter id="' + id + '" x="-50%" y="-50%" width="200%" height="200%">' +
      '<feGaussianBlur stdDeviation="' + sd + '" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
  }

  function arrowSVG(f, px) {
    var A = CONFIG.arrow, C = CONFIG.colors, s = A.scale;
    var g = +f.g;
    // свечение контура: в покое — слабое зелёное; на вспышке — бирюзовое и зелёное.
    // Радиусы задумки (2 px; 10 px + 4 px) ужаты, чтобы ореол помещался в 32 px.
    var green = '<feGaussianBlur in="SourceAlpha" stdDeviation="' + num(lerp(0.95, 1.55, g), 2) + '" result="g1"/>' +
      '<feFlood flood-color="' + C.core + '" flood-opacity="' + num(Math.min(1, lerp(0.4, 1, g) * f.glow), 2) + '"/>' +
      '<feComposite in2="g1" operator="in" result="g2"/>';
    var cyan = g > 0 ? '<feGaussianBlur in="SourceAlpha" stdDeviation="' + num(lerp(0.2, 3.1, g), 2) + '" result="c1"/>' +
      '<feFlood flood-color="' + C.glint + '" flood-opacity="' + num(g, 2) + '"/>' +
      '<feComposite in2="c1" operator="in" result="c2"/>' : '';
    var edge = '<filter id="e" x="-40%" y="-40%" width="180%" height="180%">' + cyan + green +
      '<feMerge>' + (cyan ? '<feMergeNode in="c2"/>' : '') + '<feMergeNode in="g2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
    var grad = '<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + C.core + '"/>' +
      '<stop offset="0.6" stop-color="' + C.mid + '"/><stop offset="1" stop-color="' + C.dark + '"/></linearGradient>';
    var parts = '';
    f.parts.forEach(function (q) {
      var size = A.sizes[q[0]], u = +q[1];
      parts += '<rect x="' + (-size[0] / 2) + '" y="' + (-size[1] / 2) + '" width="' + size[0] + '" height="' + size[1] + '"' +
        ' fill="' + C.particles[q[0]] + '" stroke="' + C.particleEdge + '" stroke-width="0.5" opacity="' + q[4] + '"' +
        ' transform="translate(' + num(6 + 34 * u, 2) + ' ' + num(6 + 16 * u, 2) + ') rotate(' + q[3] + ') scale(' + q[2] + ')"/>';
    });
    return svgOpen(px, 6 - A.tip / s, CONFIG.size / s) +
      '<defs>' + grad + edge + (parts ? glowFilter('p', 1.1) : '') + '</defs>' +
      (f.dim ? '<g opacity="0.45">' : '<g>') +
      '<path d="M6 6L40 22L25 27L18 40Z" fill="url(#b)" stroke="' + C.core + '" stroke-width="1.5" stroke-linejoin="miter" filter="url(#e)"/>' +
      '<path d="M10 10L32 21L23 24L18 33Z" fill="' + C.cut + '"/>' +
      (parts ? '<g filter="url(#p)">' + parts + '</g>' : '') +
      '</g></svg>';
  }

  function triSVG(f, px) {
    var T = CONFIG.tri, C = CONFIG.colors, s = T.scale;
    var body = '';
    T.segments.forEach(function (seg, i) {
      // толщина в единицах сегмента: после масштаба сегмента и viewBox получается T.stroke px
      body += '<polygon points="4,4 36,12 12,36" transform="translate(' + seg[1] + ' ' + seg[1] + ') scale(' + num(seg[0], 5) + ')"' +
        ' fill="' + C.core + '" fill-opacity="' + f.fills[i] + '" stroke="' + C.core + '"' +
        ' stroke-width="' + num(T.stroke / (s * seg[0]), 3) + '" stroke-linejoin="miter"/>';
    });
    return svgOpen(px, 4 - T.tip / s, CONFIG.size / s) +
      '<defs>' + glowFilter('t', 1.1) + '</defs><g filter="url(#t)">' + body + '</g></svg>';
  }

  function frameSVG(f, px) { return f.kind === 'tri' ? triSVG(f, px) : arrowSVG(f, px); }

  // кадры цикла с шагом CONFIG.step; одинаковые подряд склеиваются в один длинный
  function sampleCycle(cycle, make) {
    var out = [];
    for (var t = 0; t < cycle; t += CONFIG.step) {
      var f = make(t), key = JSON.stringify(f), last = out[out.length - 1];
      if (last && last.key === key) last.ms += CONFIG.step;
      else out.push({ key: key, f: f, t: t, ms: CONFIG.step });
    }
    if (out.length > 1 && out[0].key === out[out.length - 1].key) {
      var tail = out.pop();
      out[0].ms += tail.ms;
      out[0].t = tail.t;
      out.push(out.shift());   // склеенный кадр встаёт в конец, чтобы порядок кадров не нарушился
    }
    return out;
  }

  // --- растеризация ------------------------------------------------------------------------

  function svgUrl(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }

  // Холсты программные (willReadFrequently) и общие для всех кадров: ускоренный холст
  // при первом drawImage запускает GPU (сотни мс), а toDataURL тянет кадр из видеопамяти.
  var canvases = {};

  function toPng(svg, px) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var canvas = canvases[px];
          if (!canvas) {
            canvas = canvases[px] = doc.createElement('canvas');
            canvas.width = canvas.height = px;
            canvas.ctx = canvas.getContext('2d', { willReadFrequently: true });
          }
          canvas.ctx.clearRect(0, 0, px, px);
          canvas.ctx.drawImage(img, 0, 0, px, px);
          resolve(canvas.toDataURL('image/png'));
        } catch (err) { reject(err); }
      };
      img.onerror = function () { reject(new Error('SVG кадра не загрузился')); };
      img.src = svgUrl(svg);
    });
  }

  function render(frame) {
    if (frame.png1 || rasterBroken) return Promise.resolve(frame);
    return Promise.all([toPng(frame.svg1, CONFIG.size), toPng(frameSVG(frame.f, CONFIG.size * 2), CONFIG.size * 2)])
      .then(function (png) { frame.png1 = png[0]; frame.png2 = png[1]; return frame; })
      .catch(function () { rasterBroken = true; return frame; });
  }

  function renderAll(frames) {
    return frames.reduce(function (chain, frame) {
      return chain.then(function () { return render(frame); });
    }, Promise.resolve());
  }

  // Готовые PNG хранятся в localStorage (≈0,5 МБ), чтобы при переходах между страницами
  // кадры не рисовались заново. Ключ — отпечаток SVG всех кадров: поменялась геометрия,
  // цвета или размер — кэш сам становится недействительным.
  var CACHE_KEY = 'cursorFx.frames';

  function fingerprint(frames) {
    var h = 2166136261;
    frames.forEach(function (frame) {
      for (var i = 0; i < frame.svg1.length; i++) { h ^= frame.svg1.charCodeAt(i); h = Math.imul(h, 16777619); }
    });
    return (h >>> 0).toString(36) + '-' + frames.length;
  }

  function loadCache(frames, key) {
    try {
      var data = JSON.parse(window.localStorage.getItem(CACHE_KEY) || 'null');
      if (!data || data.key !== key) return false;
      frames.forEach(function (frame, i) { frame.png1 = data.png1[i]; frame.png2 = data.png2[i]; });
      return frames.every(function (frame) { return frame.png1 && frame.png2; });
    } catch (err) { return false; }
  }

  function saveCache(frames, key) {
    if (rasterBroken) return;
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({
        key: key,
        png1: frames.map(function (frame) { return frame.png1; }),
        png2: frames.map(function (frame) { return frame.png2; })
      }));
    } catch (err) { /* нет места — в следующий раз кадры нарисуются заново */ }
  }

  // --- состояние ---------------------------------------------------------------------------

  var media = {
    fine: window.matchMedia('(any-pointer: fine)'),
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)'),
    contrast: window.matchMedia('(forced-colors: active)')
  };
  var autoVariant = detectVariant();
  var variant = null;
  var rasterBroken = false;
  var enabled = false;
  var staticsReady = false;   // статичные кадры готовы — курсор можно показывать
  var ready = false;          // анимационные кадры готовы
  var started = 0, buildMs = 0, cached = false;
  var rules = null;
  var active = 'default';
  var styled = null;          // элемент, у которого в style стоит кадр анимации
  var painted = '';           // какой кадр там стоит
  var hoverStartIndex = 0;
  var lastTarget = null;
  var outside = false;
  var timer = 0;

  var still = {
    idle: { f: arrowFrame(0, { parts: false }) },
    drag: { f: arrowFrame(0, { parts: false, glow: 1.6 }) },
    disabled: { f: arrowFrame(0, { parts: false, dim: true }) },
    hover: { f: triFrame(CONFIG.tri.still) }
  };
  var anim = {
    default: { fallback: 'default', index: 0,
      frames: sampleCycle(CONFIG.arrow.cycle, function (t) { return arrowFrame(t, { parts: true }); }) },
    hover: { fallback: 'pointer', index: 0, frames: sampleCycle(CONFIG.tri.cycle, triFrame) }
  };

  function detectVariant() {
    // Firefox чётко рисует SVG-курсоры на любом масштабе экрана; image-set в cursor
    // у него исторически работал ненадёжно
    if (CSS.supports('-moz-appearance', 'none')) return 'svg';
    if (CSS.supports('cursor', 'image-set(url("data:,") 1x) 1 1, auto')) return 'set';
    if (CSS.supports('cursor', '-webkit-image-set(url("data:,") 1x) 1 1, auto')) return 'webkit';
    return 'png';
  }

  function readOverride() {
    var match = /[?&]cursor=([a-z]+)/.exec(window.location.search);
    var value = match ? match[1] : null;
    try {
      if (value === 'auto') window.localStorage.removeItem(STORE_KEY);
      else if (value) window.localStorage.setItem(STORE_KEY, value);
      else value = window.localStorage.getItem(STORE_KEY);
    } catch (err) { /* хранилище недоступно — действует только адрес */ }
    return value === 'off' || VARIANTS.indexOf(value) >= 0 ? value : null;
  }

  function cursorValue(frame, fallback) {
    var at = ' ' + CONFIG.hotspot[0] + ' ' + CONFIG.hotspot[1];
    var mode = rasterBroken || !frame.png1 ? 'svg-only' : variant;
    if (mode === 'set') return 'image-set(url("' + frame.png1 + '") 1x, url("' + frame.png2 + '") 2x)' + at + ', ' + fallback;
    if (mode === 'webkit') return '-webkit-image-set(url("' + frame.png1 + '") 1x, url("' + frame.png2 + '") 2x)' + at + ', ' + fallback;
    if (mode === 'svg') return 'url("' + frame.svg + '")' + at + ', url("' + frame.png1 + '")' + at + ', ' + fallback;
    if (mode === 'svg-only') return 'url("' + frame.svg + '")' + at + ', ' + fallback;
    return 'url("' + frame.png1 + '")' + at + ', ' + fallback;
  }

  function installRules() {
    var style = doc.createElement('style');
    style.id = 'cursor-fx';
    var hover = CONFIG.hover + ', #cfx-z';
    var disabled = CONFIG.disabled + ', #cfx-z#cfx-z';
    // Специфичность растёт сверху вниз (фиктивные #cfx-z не совпадают ни с чем):
    // обычный < наведение < недоступно < перетаскивание.
    style.textContent =
      'html.cfx, html.cfx * { cursor: default !important; }\n' +
      'html.cfx :is(' + hover + '), html.cfx :is(' + hover + ') * { cursor: pointer !important; }\n' +
      'html.cfx :is(' + disabled + '), html.cfx :is(' + disabled + ') * { cursor: default !important; }\n' +
      'html.cfx.cfx-drag:is(.cfx-drag, #cfx-z#cfx-z#cfx-z), html.cfx.cfx-drag:is(.cfx-drag, #cfx-z#cfx-z#cfx-z) * { cursor: grabbing !important; }\n';
    doc.head.appendChild(style);
    var list = style.sheet && style.sheet.cssRules;
    if (!list || list.length !== 4) { style.remove(); return false; }
    rules = { default: list[0], hover: list[1], disabled: list[2], drag: list[3] };
    return true;
  }

  function setRule(name, value) { rules[name].style.setProperty('cursor', value, 'important'); }

  function valueOf(frame, fallback) {
    frame.values = frame.values || {};
    return frame.values[variant] || (frame.values[variant] = cursorValue(frame, fallback));
  }

  function animating() {
    return enabled && ready && !media.reduced.matches && !doc.hidden && !outside;
  }

  // Правила в <style> — статичные кадры состояний. Они меняются только при смене варианта
  // и видны сразу при входе на элемент, на паузе и при prefers-reduced-motion.
  function showAll() {
    if (!rules || !staticsReady) return;
    var moving = ready && !media.reduced.matches;
    setRule('default', valueOf(still.idle, 'default'));
    setRule('hover', valueOf(moving ? anim.hover.frames[hoverStartIndex] : still.hover, 'pointer'));
    setRule('disabled', valueOf(still.disabled, 'default'));
    setRule('drag', valueOf(still.drag, 'grabbing'));
    painted = '';
  }

  // Кадр анимации ставится в style одного элемента — того, что под мышью: курсор браузер
  // берёт с него. Менять общее правило нельзя — каждый кадр пересчитывал бы стили всей
  // страницы (на каталоге в 3000 строк это 70 % ядра, проверено).
  function paint(a) {
    var el = lastTarget && lastTarget.nodeType === 1 && lastTarget.style &&
      lastTarget.childElementCount <= CONFIG.maxChildren ? lastTarget : null;
    if (styled && styled !== el) unpaint();
    if (!el) return;
    var value = valueOf(a.frames[a.index], a.fallback);
    if (styled === el && painted === value) return;
    el.style.setProperty('cursor', value, 'important');
    styled = el;
    painted = value;
  }

  function unpaint() {
    if (styled) styled.style.removeProperty('cursor');
    styled = null;
    painted = '';
  }

  function schedule() {
    clearTimeout(timer);
    timer = 0;
    var a = anim[active];
    // перетаскивание и «недоступно» — статичные правила, кадр в style не нужен
    if (!a || !enabled || !ready || media.reduced.matches) { unpaint(); return; }
    if (!animating()) return;   // пауза: последний кадр остаётся на месте
    paint(a);
    timer = setTimeout(tick, a.frames[a.index].ms);
  }

  function tick() {
    timer = 0;
    var a = anim[active];
    if (!a || !animating()) return;
    a.index = (a.index + 1) % a.frames.length;
    paint(a);
    timer = setTimeout(tick, a.frames[a.index].ms);
  }

  function seek(a, t) {
    for (var i = a.frames.length - 1; i >= 0; i--) {
      if (a.frames[i].t <= t) return i;
    }
    return 0;
  }

  function classify(target) {
    if (target) lastTarget = target;
    var el = lastTarget && lastTarget.nodeType === 1 ? lastTarget : null;
    var state = 'default';
    if (root.classList.contains('cfx-drag')) state = 'drag';
    else if (el && el.closest(CONFIG.disabled)) state = 'disabled';
    else if (el && el.closest(CONFIG.hover)) state = 'hover';
    if (state !== active) {
      if (state === 'hover') anim.hover.index = hoverStartIndex;
      active = state;
      schedule();
    } else if (el !== styled && anim[active] && animating()) {
      paint(anim[active]);   // мышь перешла на другой элемент — кадр переезжает за ней
    }
  }

  function updateDrag() {
    var dragging = !!doc.querySelector(CONFIG.drag);
    if (dragging === root.classList.contains('cfx-drag')) return;
    root.classList.toggle('cfx-drag', dragging);
    classify();
  }

  function onMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    if (outside) { outside = false; schedule(); }
    classify(event.target);
  }

  function bindEvents() {
    // слушатели на window в фазе всплытия: срабатывают после обработчиков страницы,
    // когда классы вроде marker-hover уже обновлены
    window.addEventListener('pointerover', onMove, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    doc.addEventListener('mouseout', function (event) {
      if (!event.relatedTarget) { outside = true; schedule(); }
    });
    doc.addEventListener('visibilitychange', schedule);
    var watched = doc.querySelectorAll(CONFIG.dragWatch);
    if (watched.length && window.MutationObserver) {
      var observer = new MutationObserver(updateDrag);
      Array.prototype.forEach.call(watched, function (el) {
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
    }
    listen(media.reduced, function () { showAll(); schedule(); });
    listen(media.contrast, function () { if (media.contrast.matches) disable(); else enable(); });
  }

  function listen(query, fn) {
    if (query.addEventListener) query.addEventListener('change', fn);
    else if (query.addListener) query.addListener(fn);
  }

  // --- запуск ------------------------------------------------------------------------------

  var built = null;

  function build() {
    if (built) return built;
    started = window.performance ? performance.now() : Date.now();
    var statics = [still.idle, still.drag, still.disabled, still.hover];
    var all = statics.concat(anim.default.frames, anim.hover.frames);
    all.forEach(function (frame) {
      frame.svg1 = frameSVG(frame.f, CONFIG.size);
      frame.svg = svgUrl(frame.svg1);
    });
    var key = fingerprint(all);
    cached = loadCache(all, key);
    built = renderAll(statics).then(function () {
      staticsReady = true;
      if (enabled) { showAll(); root.classList.add('cfx'); }
      // анимационные кадры — в фоне; до готовности показываются статичные
      return renderAll(all);
    }).then(function () {
      ready = true;
      buildMs = Math.round((window.performance ? performance.now() : Date.now()) - started);
      hoverStartIndex = anim.hover.index = seek(anim.hover, CONFIG.tri.hoverStart);
      if (!cached) saveCache(all, key);
      if (enabled) { showAll(); schedule(); }
    });
    return built;
  }

  function enable() {
    if (enabled || media.contrast.matches || !media.fine.matches || variant === 'off') return;
    if (!rules && !installRules()) return;
    enabled = true;
    if (staticsReady) { showAll(); root.classList.add('cfx'); schedule(); }
    else build();   // если сборка уже идёт, она сама включит курсор
  }

  function disable() {
    enabled = false;
    clearTimeout(timer);
    timer = 0;
    unpaint();
    root.classList.remove('cfx', 'cfx-drag');
  }

  function setVariant(name) {
    try {
      if (!name || name === 'auto') window.localStorage.removeItem(STORE_KEY);
      else window.localStorage.setItem(STORE_KEY, name);
    } catch (err) { /* только на эту страницу */ }
    variant = name && name !== 'auto' ? name : autoVariant;
    unpaint();
    if (variant === 'off') { disable(); return; }
    if (VARIANTS.indexOf(variant) < 0) variant = autoVariant;
    if (enabled) { showAll(); schedule(); } else enable();
  }

  window.CursorFx = {
    info: function () {
      return {
        enabled: enabled, ready: ready, variant: variant, auto: autoVariant, rasterBroken: rasterBroken,
        dpr: window.devicePixelRatio || 1, reducedMotion: media.reduced.matches, state: active,
        frames: { default: anim.default.frames.length, hover: anim.hover.frames.length }, buildMs: buildMs, cached: cached
      };
    },
    frames: function () {
      function list(frames) { return frames.map(function (fr) { return { ms: fr.ms, png: fr.png2 || fr.svg, svg: fr.svg }; }); }
      return { default: list(anim.default.frames), hover: list(anim.hover.frames),
        still: { drag: list([still.drag])[0], disabled: list([still.disabled])[0] } };
    },
    setVariant: setVariant,
    enable: enable,
    disable: disable
  };

  variant = readOverride() || autoVariant;
  bindEvents();
  enable();
})();
