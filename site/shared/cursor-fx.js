/* CursorFx — курсор сайта в духе брифингов StarCraft II: зелёная стрелка-шеврон, по краям
   которой раз в 2,25 с бегут синие соты, а при наведении на кликабельное — стопка из четырёх
   непрозрачных треугольников с «каскадом» и «волной» заливки.

   РИСУНОК
     • Стрелка: из острия выходят два потока сот — по верхней и по левой грани. Они огибают
       концы крыльев, по внутренним граням возвращаются к выемке и там сходятся во вспышке.
       Голова потока — светящиеся шестиугольники, хвост рассыпается на обломки-многоугольники,
       к выемке поток сужается. Маршрут и соты — CONFIG.arrow.route и CONFIG.arrow.cells.
     • Наведение: четыре треугольника задумки, каждый следующий меньше и лежит поверх заднего.
       Слои непрозрачные, как на образце пользователя: тёмная заливка с кромкой, а там, где
       слой лежит на заднем, — тёмный зазор и светлая линия. «Каскад» и «волна» по очереди
       заливают слои светлым градиентом.
     • Перетаскивание («холд-драг»): крестовина задумки пользователя — четыре пары шевронов
       остриями к центру. Точка клика — в центре креста. Включается сразу при нажатии на
       пустом месте карты, до движения (CONFIG.hold). Геометрия — CONFIG.cross.

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
      кадры склеиваются, поэтому пауза между пролётами сот — один кадр.
   2. Каждый кадр растеризуется в браузере (программный canvas) в PNG 32×32 и 64×64 для
      экранов 2×. Файлов-картинок нет, сборка не нужна. Сначала готовятся статичные кадры
      (курсор появляется сразу), анимация — следом, в фоне (≈0,4 с). Готовые PNG хранятся в
      localStorage (≈0,8 МБ), и на следующих страницах кадры берутся оттуда за миллисекунды.
   3. В <head> добавляется <style id="cursor-fx"> со статичными кадрами состояний (!important):
        обычный        — всё, в том числе поля ввода и поиск (решение: стрелка, не I-образный);
        наведение      — ссылки, кнопки, [role=button], классы сайта из CONFIG.hover и системы
                         на карте атласа (#mapCanvas.marker-hover);
        недоступно     — CONFIG.disabled (ОЗД после отказа, :disabled): приглушённая стрелка;
        перетаскивание — крестовина: пока зажата кнопка на пустом месте карты (CONFIG.hold),
                         а если нажали на кнопку, сектор или систему — когда мышь сдвинулась
                         и карта поехала; плюс классы карт из CONFIG.drag.
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
      // соты — голубые задумки (#00d9ff, #00ffff, #00aaff), белая кромка, глубокий синий
      cell: { light: '#ffffff', cyan: '#00d9ff', aqua: '#00ffff', blue: '#00aaff', deep: '#0a66ff',
        wall: '#1452e0', edge: '#7fefff' },
      // треугольники наведения: тёмная заливка слоя, его кромка (тёмная и залитая) и зазор
      shade: ['#0b3a1a', '#04170b'], rim: '#00cc55', rimLit: '#66ffa3', gap: '#020a05'
    },
    arrow: {
      cycle: 2250,               // мс — период: пролёт сот и пауза
      scale: 0.809,              // px на единицу задумки: тело ≈ 27,5 px из 32
      tip: 2.1,                  // px — вершина острия; с острым углом контура остриё ≈ 1 px
      // Маршрут сот в единицах задумки — контур стрелки, сдвинутый внутрь на 1,1 (середина
      // зелёной полосы у края): из острия по верхней и по левой грани к концам крыльев, затем
      // по внутренним граням обратно, к выемке, где оба потока сходятся.
      route: { tip: [7.91, 8.12], wings: [[37.05, 21.83], [18.21, 37.29]], notch: [24.24, 26.09] },
      // соты одного потока от головы к хвосту: [форма, радиус, стиль, задержка мс,
      // сдвиг поперёк маршрута наружу]. Голова светится, хвост рассыпается на обломки.
      cells: [
        ['hex', 3.6, 'lit', 0, 0],
        ['hex', 3.2, 'cyan', 40, 0.8],
        ['hex', 3, 'deep', 80, -0.6],
        ['hex', 3, 'line', 125, 0.9],
        ['pent', 2.6, 'shard', 170, -0.7],
        ['broken', 2.4, 'broken', 215, 0.4]
      ]
    },
    tri: {
      cycle: 3000,               // мс — каскад + волна
      scale: 0.8,
      tip: 2.1,
      // px — [кромка слоя, тёмный зазор вокруг слоя там, где он лежит на заднем, светлая линия
      // за зазором]. В картинке 1× тонкая светлая линия рябит: её нет, зазор и кромка толще.
      lines: { fine: [0.8, 0.55, 0.45], coarse: [0.9, 0.75, 0] },
      // [масштаб, сдвиг по диагонали в единицах задумки]: сегменты наложены, как в задумке;
      // рисуются от большого к малому, каждый следующий закрывает задние
      segments: [[1, 0], [1 / 1.7, 15], [1 / (1.7 * 1.7), 25], [1 / (1.7 * 1.7 * 1.7), 31]],
      hoverStart: 150,           // мс цикла, с которых начинается анимация при наведении
      still: 2700                // мс цикла — кадр для prefers-reduced-motion: задний слой
                                 // залит, передние тёмные, как на образце пользователя
    },
    // Крестовина перетаскивания по задумке пользователя (холст -50…50): базовый шеврон
    // повёрнут на 0/90/180/270° — сверху, справа, снизу, слева, — в каждом направлении пара:
    // внешний крупнее и дальше, внутренний меньше и ближе к центру. Точка клика — центр.
    cross: {
      scale: 0.34,               // px на единицу задумки: крест ≈ 27 px из 32, свечение влезает
      center: 15.5,              // px — центр креста в картинке: середина пикселя, чтобы острия
                                 // на осях были чёткими в 1×; точка клика — этот пиксель (15)
      chevron: [[-12, -4], [12, -4], [0, 6]],   // плоский верх, остриё вниз — к центру
      // [расстояние от центра, масштаб, слой]: как translate(0,-35) scale(1.2) и
      // translate(0,-18) scale(0.8) в задумке
      pairs: [[35, 1.2, 'outer'], [18, 0.8, 'inner']],
      // px — [кромка внешнего шеврона, тёмная обводка внутреннего]; в картинке 1× кромка
      // толще, а тонкая обводка рябит — её нет
      lines: { fine: [0.7, 0.45], coarse: [1, 0] }
    },
    // «Холд»: зажали кнопку мыши на пустом месте карты (CONFIG.dragWatch) — курсор
    // перетаскивания сразу, ещё до движения. Нажатие на кнопку, сектор, систему остаётся
    // щелчком; если мышь при этом сдвинулась дальше slop, карта поехала — тоже перетаскивание.
    hold: {
      slop: 4,                   // px, как порог перетаскивания на карте галактики
      // панели и кнопки внутри карт: нажатие на них карту не двигает (как isUi в galaxy.js)
      skip: '.sector-panel, .map-controls, .sectors-sidebar, .sectors-curtain, .sectors-backdrop, ' +
        '.map-hint, .odz-message'
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
  var easeOut = bezier(0.25, 1, 0.5, 1);     // соты (как у частиц задумки)
  var easeInOut = bezier(0.42, 0, 0.58, 1);  // блик грани

  // соты: [доля цикла, место на маршруте (0 — остриё, 1 — конец крыла, 2 — выемка), масштаб,
  // поворот°, непрозрачность]. До 58 % цикла сота скрыта в острие; у конца крыла и у выемки
  // поток притормаживает и сужается. Сглаживание — как у CSS-анимации, на каждом отрезке.
  var CELL_KEYS = [
    [0.58, 0, 0.25, 0, 0],
    [0.68, 0.3, 1.15, 25, 1],
    [0.82, 1, 1, 60, 1],
    [0.92, 1.62, 0.7, 95, 0.85],
    [0.98, 2, 0.2, 120, 0]
  ];
  function cellAt(p) {
    if (p < CELL_KEYS[0][0]) return null;
    for (var i = 1; i < CELL_KEYS.length; i++) {
      var a = CELL_KEYS[i - 1], b = CELL_KEYS[i];
      if (p <= b[0]) {
        var k = easeOut((p - a[0]) / (b[0] - a[0]));
        return { u: lerp(a[1], b[1], k), s: lerp(a[2], b[2], k), r: lerp(a[3], b[3], k), o: lerp(a[4], b[4], k) };
      }
    }
    return null;
  }
  // Блик грани и вспышка в выемке приходятся на схождение потоков и заходят в начало
  // следующего цикла, поэтому начало цикла считается его продолжением (p + 1).
  function wrap(p) { return p < 0.3 ? p + 1 : p; }
  // блик грани: 0 — покой, 1 — вспышка (80 % → 96 % → 106 %)
  function glintAt(p) {
    var q = wrap(p);
    if (q < 0.8 || q >= 1.06) return 0;
    if (q < 0.96) return easeInOut((q - 0.8) / 0.16);
    return easeInOut(1 - (q - 0.96) / 0.1);
  }
  // вспышка в выемке: фаза 0…1 (95,5 % → 105,5 %), вне вспышки −1
  function flashAt(p) {
    var q = wrap(p);
    return q >= 0.955 && q < 1.055 ? (q - 0.955) / 0.1 : -1;
  }
  function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
  // нормаль наружу от стрелки: верхний поток обходит контур по часовой стрелке — наружу
  // слева от хода, нижний — против, наружу справа
  function outward(a, b, stream) {
    var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.sqrt(dx * dx + dy * dy);
    return stream === 0 ? [dy / len, -dx / len] : [-dy / len, dx / len];
  }
  // точка маршрута: stream 0 — по верхней грани, 1 — по левой; u от 0 до 2.
  // Нормаль на конце крыла поворачивается плавно, чтобы сдвинутые соты не прыгали.
  function routePoint(stream, u) {
    var R = CONFIG.arrow.route, a = R.tip, b = R.wings[stream], c = R.notch;
    var x = u <= 1 ? lerp(a[0], b[0], u) : lerp(b[0], c[0], u - 1);
    var y = u <= 1 ? lerp(a[1], b[1], u) : lerp(b[1], c[1], u - 1);
    var n1 = outward(a, b, stream), n2 = outward(b, c, stream), k = smooth((u - 0.85) / 0.3);
    var nx = lerp(n1[0], n2[0], k), ny = lerp(n1[1], n2[1], k), len = Math.sqrt(nx * nx + ny * ny) || 1;
    return { x: x, y: y, nx: nx / len, ny: ny / len };
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

  // кадр стрелки: соты [поток, номер соты, место на маршруте, масштаб, поворот, непрозрачность],
  // g — блик грани, fx — фаза вспышки в выемке. opts.parts: false — стрелка без сот.
  function arrowFrame(t, opts) {
    var A = CONFIG.arrow;
    var cells = [];
    if (opts.parts) {
      for (var s = 0; s < 2; s++) {
        for (var i = 0; i < A.cells.length; i++) {
          var local = (((t - A.cells[i][3]) % A.cycle) + A.cycle) % A.cycle;
          var k = cellAt(local / A.cycle);
          if (k && k.o > 0.02) cells.push([s, i, num(k.u, 3), num(k.s, 2), num(k.r, 0), num(k.o, 2)]);
        }
      }
    }
    var p = t / A.cycle;
    return { kind: 'arrow', g: opts.parts ? num(glintAt(p), 2) : '0', fx: opts.parts ? num(flashAt(p), 2) : '-1',
      cells: cells, glow: opts.glow || 1, dim: !!opts.dim };
  }

  function triFrame(t) {
    var p = t / CONFIG.tri.cycle;
    return { kind: 'tri', fills: FILL_KEYS.map(function (keys) { return num(fillAt(keys, p), 2); }) };
  }

  // крестовина перетаскивания — статичный кадр
  function crossFrame() { return { kind: 'cross' }; }

  function svgOpen(px, origin, span) {
    var box = num(origin, 3) + ' ' + num(origin, 3) + ' ' + num(span, 3) + ' ' + num(span, 3);
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="' + box + '">';
  }

  // Область фильтров — весь холст в единицах задумки: у мелкой соты рамка по её размеру
  // обрезала бы свечение.
  var FILTER_AREA = ' filterUnits="userSpaceOnUse" x="0" y="0" width="50" height="50"';

  // ореол: силуэт рисунка, размытый на sd и залитый цветом color, под самим рисунком —
  // края остаются чёткими, светится только вокруг
  function haloFilter(id, sd, color, opacity, area) {
    return '<filter id="' + id + '"' + (area || FILTER_AREA) + '>' +
      '<feGaussianBlur in="SourceAlpha" stdDeviation="' + sd + '" result="a"/>' +
      '<feFlood flood-color="' + color + '" flood-opacity="' + opacity + '"/><feComposite in2="a" operator="in" result="g"/>' +
      '<feMerge><feMergeNode in="g"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
  }

  function ring(n) {
    var pts = [];
    for (var i = 0; i < n; i++) pts.push([Math.cos(i * 2 * Math.PI / n), Math.sin(i * 2 * Math.PI / n)]);
    return pts;
  }
  // формы сот, вершины в долях радиуса
  var SHAPES = {
    hex: ring(6),                                                                    // шестиугольник
    pent: [[-0.95, -0.35], [-0.2, -1], [0.85, -0.55], [0.75, 0.6], [-0.45, 0.9]],    // обломок
    broken: ring(6).slice(0, 5)                     // шестиугольник без двух граней — линия
  };
  // как закрашены соты: голова светится, к хвосту остаются контуры
  var CELL = CONFIG.colors.cell;
  // Тёмно-синяя граница у светлых сот — как стенки сот на образце: без неё на экране 1×
  // мелкая сота сливается в пятно.
  var PAINT = {
    lit: ' fill="url(#h)" stroke="' + CELL.wall + '" stroke-width="0.6"',
    cyan: ' fill="' + CELL.cyan + '" stroke="' + CELL.wall + '" stroke-width="0.6"',
    deep: ' fill="' + CELL.deep + '" fill-opacity="0.9" stroke="' + CELL.edge + '" stroke-width="0.6"',
    line: ' fill="' + CELL.deep + '" fill-opacity="0.35" stroke="' + CELL.aqua + '" stroke-width="0.7"',
    shard: ' fill="' + CELL.aqua + '" fill-opacity="0.2" stroke="' + CELL.aqua + '" stroke-width="0.65"',
    broken: ' fill="none" stroke="' + CELL.blue + '" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round"'
  };

  // вершины формы с центром (cx, cy), радиусом size и поворотом deg — в единицах задумки
  function shapePoints(shape, cx, cy, size, deg) {
    var a = deg * Math.PI / 180, cos = Math.cos(a) * size, sin = Math.sin(a) * size;
    return shape.map(function (v) {
      return num(cx + v[0] * cos - v[1] * sin, 2) + ',' + num(cy + v[0] * sin + v[1] * cos, 2);
    }).join(' ');
  }

  // смесь двух цветов #rrggbb: k = 0 — первый, 1 — второй
  function mix(a, b, k) {
    var out = '#';
    for (var i = 1; i < 7; i += 2) {
      var v = Math.round(lerp(parseInt(a.substr(i, 2), 16), parseInt(b.substr(i, 2), 16), k));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
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
    // соты: нижний поток — зеркало верхнего (поворот в другую сторону); номер соты сбивает
    // поворот, чтобы соты одного потока не крутились в такт
    var cells = '';
    f.cells.forEach(function (q) {
      var cell = A.cells[q[1]], k = +q[3], at = routePoint(q[0], +q[2]), off = cell[4] * k;
      cells += '<' + (cell[0] === 'broken' ? 'polyline' : 'polygon') + ' points="' +
        shapePoints(SHAPES[cell[0]], at.x + at.nx * off, at.y + at.ny * off, cell[1] * k, (q[0] ? -1 : 1) * (+q[4] + q[1] * 17)) +
        '"' + PAINT[cell[2]] + ' opacity="' + q[5] + '"/>';
    });
    // вспышка в выемке, где сошлись потоки: расходящийся контур соты и гаснущее ядро
    var phase = +f.fx;
    if (phase >= 0) {
      var N = A.route.notch;
      cells += '<polygon points="' + shapePoints(SHAPES.hex, N[0], N[1], lerp(1.4, 5.2, easeOut(phase)), 30) + '"' +
        ' fill="none" stroke="' + C.cell.aqua + '" stroke-width="0.8" opacity="' + num(1 - phase, 2) + '"/>' +
        '<polygon points="' + shapePoints(SHAPES.hex, N[0], N[1], lerp(3, 0.8, phase), 0) + '"' +
        ' fill="url(#h)" stroke="' + C.cell.wall + '" stroke-width="0.5" opacity="' + num(1 - phase * phase, 2) + '"/>';
    }
    var cellDefs = cells ? '<radialGradient id="h"><stop offset="0" stop-color="' + C.cell.light + '"/>' +
      '<stop offset="0.5" stop-color="#9ff8ff"/><stop offset="1" stop-color="#00b8ff"/></radialGradient>' +
      haloFilter('p', 0.9, C.cell.cyan, 0.7) : '';
    return svgOpen(px, 6 - A.tip / s, CONFIG.size / s) +
      '<defs>' + grad + edge + cellDefs + '</defs>' +
      (f.dim ? '<g opacity="0.45">' : '<g>') +
      '<path d="M6 6L40 22L25 27L18 40Z" fill="url(#b)" stroke="' + C.core + '" stroke-width="1.5" stroke-linejoin="miter" filter="url(#e)"/>' +
      '<path d="M10 10L32 21L23 24L18 33Z" fill="' + C.cut + '"/>' +
      (cells ? '<g filter="url(#p)">' + cells + '</g>' : '') +
      '</g></svg>';
  }

  // Треугольники наведения — непрозрачная стопка, как на образце пользователя. Каждый слой:
  // тёмная заливка, поверх неё светлый градиент по «каскаду» (fills), кромка. Там, где слой
  // лежит на заднем, вокруг него тёмный зазор и за ним светлая линия (обрезаны по задним слоям,
  // поэтому над фоном их нет). У заднего слоя кромка — яркая линия края всей стопки.
  function triSVG(f, px) {
    var T = CONFIG.tri, C = CONFIG.colors, s = T.scale;
    var w = px > CONFIG.size ? T.lines.fine : T.lines.coarse, rim = w[0], gap = w[1], line = w[2];
    var pts = '4,4 36,12 12,36';
    function place(seg) { return 'translate(' + seg[1] + ' ' + seg[1] + ') scale(' + num(seg[0], 5) + ')'; }
    var defs = '<linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + C.core + '"/>' +
      '<stop offset="0.6" stop-color="' + C.mid + '"/><stop offset="1" stop-color="' + C.dark + '"/></linearGradient>' +
      '<linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + C.shade[0] + '"/>' +
      '<stop offset="1" stop-color="' + C.shade[1] + '"/></linearGradient>' +
      // свечение вокруг всей стопки — 1 px
      haloFilter('t', num(1 / s, 2), C.core, 0.55);
    var body = '';
    T.segments.forEach(function (seg, i) {
      var unit = 1 / (s * seg[0]);   // px → единицы сегмента: толщины линий одинаковы у всех слоёв
      var lit = +f.fills[i];
      if (i > 0) {
        defs += '<clipPath id="c' + i + '">' + T.segments.slice(0, i).map(function (back) {
          return '<polygon points="' + pts + '" transform="' + place(back) + '"/>';
        }).join('') + '</clipPath>';
        body += '<g clip-path="url(#c' + i + ')"><g transform="' + place(seg) + '" fill="none" stroke-linejoin="round">' +
          (line ? '<polygon points="' + pts + '" stroke="' + C.core + '" stroke-width="' + num((rim + 2 * (gap + line)) * unit, 3) + '"/>' : '') +
          '<polygon points="' + pts + '" stroke="' + C.gap + '" stroke-width="' + num((rim + 2 * gap) * unit, 3) + '"/></g></g>';
      }
      body += '<g transform="' + place(seg) + '"><polygon points="' + pts + '" fill="url(#d)"/>' +
        (lit > 0 ? '<polygon points="' + pts + '" fill="url(#b)" fill-opacity="' + f.fills[i] + '"/>' : '') +
        '<polygon points="' + pts + '" fill="none" stroke="' + (i ? mix(C.rim, C.rimLit, lit) : C.core) + '"' +
        ' stroke-width="' + num(rim * unit, 3) + '" stroke-linejoin="miter"/></g>';
    });
    return svgOpen(px, 4 - T.tip / s, CONFIG.size / s) +
      '<defs>' + defs + '</defs><g filter="url(#t)">' + body + '</g></svg>';
  }

  // Крестовина перетаскивания. Внешние шевроны — тёмные с яркой кромкой, как слои наведения;
  // внутренние — залиты ярким градиентом стрелки. Вокруг креста — зелёный ореол 1 px (в задумке
  // feGaussianBlur 2). Точки считаются сразу в координатах холста: поворот на 90° по часовой —
  // (x, y) → (−y, x); <use> и transform не нужны.
  function crossSVG(f, px) {
    var X = CONFIG.cross, C = CONFIG.colors, s = X.scale, span = CONFIG.size / s, o = -X.center / s;
    var w = px > CONFIG.size ? X.lines.fine : X.lines.coarse, rim = w[0] / s, wall = w[1] / s;
    var area = ' filterUnits="userSpaceOnUse" x="' + num(o, 2) + '" y="' + num(o, 2) + '" width="' +
      num(span, 2) + '" height="' + num(span, 2) + '"';
    var defs =
      // у остриёв, ближе к центру, заливки светлее
      '<radialGradient id="d" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="40">' +
      '<stop offset="0.65" stop-color="' + C.shade[0] + '"/><stop offset="1" stop-color="' + C.shade[1] + '"/></radialGradient>' +
      '<radialGradient id="b" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="22">' +
      '<stop offset="0.6" stop-color="' + C.rimLit + '"/><stop offset="1" stop-color="' + C.core + '"/></radialGradient>' +
      haloFilter('k', num(1 / s, 2), C.core, 0.55, area);
    var body = '';
    X.pairs.forEach(function (pair) {
      for (var k = 0; k < 4; k++) {
        var pts = X.chevron.map(function (p) {
          var x = p[0] * pair[1], y = p[1] * pair[1] - pair[0];
          for (var r = 0; r < k; r++) { var t = x; x = -y; y = t; }
          return num(x, 2) + ',' + num(y, 2);
        }).join(' ');
        body += pair[2] === 'outer'
          ? '<polygon points="' + pts + '" fill="url(#d)" stroke="' + C.core + '" stroke-width="' + num(rim, 3) + '"/>'
          : '<polygon points="' + pts + '" fill="url(#b)"' +
            (wall ? ' stroke="' + C.gap + '" stroke-width="' + num(wall, 3) + '"' : '') + '/>';
      }
    });
    return svgOpen(px, o, span) + '<defs>' + defs + '</defs><g filter="url(#k)">' + body + '</g></svg>';
  }

  function frameSVG(f, px) {
    if (f.kind === 'tri') return triSVG(f, px);
    if (f.kind === 'cross') return crossSVG(f, px);
    return arrowSVG(f, px);
  }

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
  var hold = null;          // нажатие на карте: { id, x, y, click — нажали на кнопку/систему, moved }
  var outside = false;
  var timer = 0;

  var still = {
    idle: { f: arrowFrame(0, { parts: false }) },
    drag: { f: crossFrame(), hot: [Math.floor(CONFIG.cross.center), Math.floor(CONFIG.cross.center)] },
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
    var hot = frame.hot || CONFIG.hotspot;   // у крестовины точка клика — центр
    var at = ' ' + hot[0] + ' ' + hot[1];
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

  // Своё нажатие главнее классов карт: атлас ставит #mapCanvas.dragging уже при нажатии на
  // систему, а это щелчок. Классы карт — запасной путь, если нажатие прошло мимо модуля.
  function isDragging() {
    if (hold) return !hold.click || hold.moved;
    return !!doc.querySelector(CONFIG.drag);
  }

  function updateDrag() {
    var dragging = enabled && isDragging();
    if (dragging === root.classList.contains('cfx-drag')) return;
    root.classList.toggle('cfx-drag', dragging);
    classify();
  }

  function finePointer(event) {
    return !event.pointerType || event.pointerType === 'mouse' || event.pointerType === 'pen';
  }

  function onDown(event) {
    if (!enabled || event.button !== 0 || !finePointer(event)) return;
    var el = event.target && event.target.nodeType === 1 ? event.target : null;
    if (!el || !el.closest(CONFIG.dragWatch) || el.closest(CONFIG.hold.skip)) return;
    hold = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
      click: !!el.closest(CONFIG.hover + ', ' + CONFIG.disabled) };
    updateDrag();
  }

  function onUp(event) {
    if (!hold || (event && event.pointerId != null && event.pointerId !== hold.id)) return;
    hold = null;
    updateDrag();
  }

  function onMove(event) {
    if (!finePointer(event)) return;
    if (outside) { outside = false; schedule(); }
    if (hold && !event.buttons) {
      onUp();   // кнопку отпустили там, откуда pointerup не дошёл
    } else if (hold && !hold.moved &&
        Math.abs(event.clientX - hold.x) + Math.abs(event.clientY - hold.y) > CONFIG.hold.slop) {
      hold.moved = true;
      if (hold.click) updateDrag();
    }
    classify(event.target);
  }

  function bindEvents() {
    // слушатели на window в фазе всплытия: срабатывают после обработчиков страницы,
    // когда классы вроде marker-hover уже обновлены
    window.addEventListener('pointerover', onMove, { passive: true });
    window.addEventListener('pointermove', onMove, { passive: true });
    // нажатие — в фазе перехвата: курсор перетаскивания появляется сразу, даже если страница
    // остановит событие; отпускание — в любой форме, в том числе потеря окна
    window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) {
      window.addEventListener(type, onUp, { capture: true, passive: true });
    });
    window.addEventListener('blur', function () { onUp(); });
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
    hold = null;
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
        dpr: window.devicePixelRatio || 1, reducedMotion: media.reduced.matches, state: active, hold: !!hold,
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
