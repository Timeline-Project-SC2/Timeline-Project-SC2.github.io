/* GalaxySpiral — «вращение» галактики без прокрутки: звёзды текут, узор рукавов стоит.
   =========================================================================
   ПРИНЦИП (плотностная волна, Lin–Shu)
   -------------------------------------------------------------------------
   Спиральные рукава НИЧЕГО не крутятся: они стоят на месте. Крутятся только
   звёзды — каждая по своей эллиптической орбите. Рукав — это не «верёвка из
   звёзд», а место, где орбиты складываются в загущение (огибающая семейства
   эллипсов). Звезда втекает в рукав, протекает через него и вытекает:
   картина статична, движение заметно. Отсюда и эффект — «спин» есть,
   прокрутки нет.

   Как это собрано в числах:
     1) Орбита звезды — эллипс с полуосями a (большая) и b (малая), центр в
        центре галактики. b = r — «радиус сборки», a = b / (1 - e).
     2) Ориентация орбиты psi зависит от радиуса: psi = psi0 + A * ln(r / rIn),
        A = 1 / tan(pitch). Логоспираль: поворот орбиты линеен по логарифму
        радиуса, огибающая апсид — логарифмическая спираль с заданным pitch.
        Угол psi от времени НЕ зависит => огибающая не вращается. Знак pitch —
        направление закрутки (экран, y вниз): «+» — по часовой наружу, «−» —
        против часовой.
     3) m-кратная симметрия: звёздам раздаются ориентации psi + 2πk/m.
     4) Звезда движется по орбите по Кеплеру: E = M + e·sin M. Скорость дуги
        минимальна у одного конца большой оси => там звёзды стоят плотнее.
        Знак speed — направление: «+» — по часовой на экране.
     5) Яркость звезды — поле в ПРОСТРАНСТВЕ УЗОРА: оно стоит, звёзды текут
        сквозь него. Два варианта поля:
        — аналитическое (демо): подсветка рукава (1 + armGain·gauss(p)) и пыль
          (1 - dustAmp·gauss(p - сдвиг)), p — смещение от ближайшего рукава;
        — картинка (pattern, карта галактики): яркость рисунка в точке, где
          звезда сейчас. На нарисованном рукаве звезда разгорается, в
          промежутке гаснет, над HUD её нет — узор совпадает с рисунком при
          любой асимметрии рукавов, а звёзды всё равно текут.
     6) Граница: яркость режется smoothstep по радиусу (fadeIn..rOut).

   ДВА РЕЖИМА
     mount(host)  — демо-сцена на весь контейнер: дымка, звёзды, зерно, ядро;
                    рукава — аналитическая спираль. Страница настройки:
                    /spiral-test/.
     overlay(o)   — слой поверх карты галактики: только звёзды, холст внутри
                    слоя карты (между картинкой и остальными эффектами), узор —
                    из самой картинки. Подробно — у функции.

   ПОТОК ДАННЫХ: SoA во Float32Array, без аллокаций в кадре, спрайты звёзд
   запечены в один атлас (1 drawImage на звезду), звёзды вне холста не
   рисуются, dt-clamp, пауза на document.hidden; при prefers-reduced-motion
   демо рисует один кадр, а слой на карте не создаётся.

   API
     var g = GalaxySpiral.create(opts);      // ядро без DOM в кадре
       g.resize(w, h, dpr)                   //   демо: галактика вписана в холст w×h
       g.view(ox, oy, scale, starPx, cw, ch) //   вид вручную: центр и радиус в px холста
       g.populate()                          //   (пере)создать звёзды (count из opts)
       g.frame(ctx, dt)                      //   кадр: только звёзды
       g.nebula(ctx), g.debug(ctx, mode)     //   статичная дымка и схема орбит (демо)
       g.set(patch)                          //   поменять настройки и пересоздать звёзды
     var h = GalaxySpiral.mount(host, opts); // демо-сцена: слои, rAF, resize, destroy()
     var l = GalaxySpiral.overlay(o);        // слой поверх карты
     GalaxySpiral.patternFromImage(img, cx, cy, r, size, gamma) // узор из рисунка
   В Node ядро можно гонять с opts.createCanvas (тесты, покадровый рендер). */
(function (root, factory) {
  /* global module */
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GalaxySpiral = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TAU = Math.PI * 2;
  var DEG = Math.PI / 180;
  var SPR = 48;               // размер спрайта звезды в атласе, px
  var FLR = 128;              // размер спрайта вспышки (дифракционные лучи)
  var NB_SCALE = 0.28;        // масштаб слоя дымки (он тянется CSS-ом вверх)

  var PALETTES = {
    // [r,g,b] — холодный диск + тёплый балдж, как у реальных S0/sc
    classic: [
      [255, 222, 168],  // 0 балдж: тёплое старое население
      [255, 241, 216],  // 1 внутренний диск
      [232, 240, 255],  // 2 белый
      [196, 220, 255],  // 3 сине-белый
      [162, 196, 255],  // 4 внешний диск
      [132, 166, 240],  // 5 дальний голубой
      [255, 146, 184],  // 6 HII-области (розовый)
      [150, 250, 232]   // 7 OB-ассоциации (циан)
    ],
    // под скин Timeline Project (#1ac9bc / #7fffd4)
    teal: [
      [226, 255, 246], [196, 246, 232], [168, 238, 224],
      [128, 220, 208], [ 96, 196, 190], [ 74, 166, 176],
      [255, 176, 190], [170, 255, 236]
    ],
    // под рисунок карты галактики (сепия): тёплые белые и золото; OB — бледная
    // бирюза HUD, HII — тёплый розово-оранжевый
    map: [
      [255, 226, 176], [255, 238, 205], [255, 246, 228], [246, 234, 208],
      [238, 216, 172], [226, 202, 152], [255, 198, 158], [196, 255, 228]
    ]
  };

  /* ---------- утилиты ---------- */
  function mulberry32(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // ~гауссиана через сумму равномерных: дёшево и без Math.sqrt/Math.log
  function gauss(r) { return (r() + r() + r() + r() - 2) * 0.5; }
  function smoothstep(e0, e1, x) {
    var t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function makeCanvas(w, h) {
    if (typeof document !== 'undefined' && document.createElement) {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    throw new Error('GalaxySpiral: no document; pass opts.createCanvas for headless use');
  }

  /* ---------- атлас спрайтов: мягкая звезда + лучи ---------- */
  function radialSprite(g, size, color, coreAlpha) {
    var half = size * 0.5;
    var grd = g.createRadialGradient(half, half, 0, half, half, half);
    // ядро почти белое, дальше цветное, к краю — 0. Профиль близок к r^-2,
    // поэтому звёзды выглядят «объёмно» даже при 2 px в диаметре.
    grd.addColorStop(0.00, 'rgba(255,255,255,' + coreAlpha + ')');
    grd.addColorStop(0.10, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + (coreAlpha * 0.9) + ')');
    grd.addColorStop(0.28, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + (coreAlpha * 0.34) + ')');
    grd.addColorStop(0.62, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',' + (coreAlpha * 0.07) + ')');
    grd.addColorStop(1.00, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, size, size);
  }
  function flareSprite(g, size, color) {
    var half = size * 0.5;
    g.save();
    g.translate(half, half);
    g.globalCompositeOperation = 'lighter';
    // 4 луча: два длинных (гориз/верт) + два коротких под 45°
    for (var i = 0; i < 4; i++) {
      var long = i < 2 ? size * 0.5 : size * 0.22;
      var wide = i < 2 ? size * 0.012 : size * 0.008;
      g.save();
      g.rotate(i * Math.PI / 2 + (i >= 2 ? Math.PI / 4 : 0));
      var lg = g.createLinearGradient(-long, 0, long, 0);
      var a = i < 2 ? 0.5 : 0.22;
      lg.addColorStop(0, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0)');
      lg.addColorStop(0.5, 'rgba(255,255,255,' + a + ')');
      lg.addColorStop(1, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0)');
      g.fillStyle = lg;
      g.fillRect(-long, -wide, long * 2, wide * 2);
      g.restore();
    }
    var core = g.createRadialGradient(0, 0, 0, 0, 0, size * 0.1);
    core.addColorStop(0, 'rgba(255,255,255,.9)');
    core.addColorStop(1, 'rgba(' + color[0] + ',' + color[1] + ',' + color[2] + ',0)');
    g.fillStyle = core;
    g.fillRect(-size * 0.1, -size * 0.1, size * 0.2, size * 0.2);
    g.restore();
  }
  function buildAtlas(colors, mk) {
    var n = colors.length;
    var cv = (mk || makeCanvas)(SPR * n, SPR);
    var g = cv.getContext('2d');
    for (var i = 0; i < n; i++) {
      g.save();
      g.setTransform(1, 0, 0, 1, i * SPR, 0);
      radialSprite(g, SPR, colors[i], 1);
      g.restore();
    }
    return cv;
  }
  function buildFlare(colors, mk) {
    var cv = (mk || makeCanvas)(FLR, FLR);
    flareSprite(cv.getContext('2d'), FLR, colors[3]);
    return cv;
  }

  /* ---------- настройки ---------- */
  function defaults() {
    return {
      seed: 20261017,
      arms: 2,            // кратность спирали
      pitch: 14,          // угол рукава, deg (10..22 — красиво, >25 — «вертушка»);
                          // знак — направление закрутки: «+» по часовой наружу, «−» против
      psi0: -55 * DEG,    // ориентация узла: куда «смотрит» внутренняя часть спирали
      flat: 0.46,         // сжатие диска (наклон: 1 = face-on, 0.35 = сильно наклонённая)
      pa: -18 * DEG,      // position angle: статичный наклон проекции (НЕ анимируется)
      rIn: 0.075,         // внутренний край диска (доля R)
      rOut: 1.0,          // внешний край диска: за ним звёзд не видно
      fadeIn: 0.60,       // доля rOut, с которой начинается фейд края (ближе к 1 — резче край)
      ecc: 0.30,          // размах эксцентриситета орбит (главный «рычаг» рукавов)
      misalign: 0.11,     // разброс ориентации орбит, рад. 0 = «нить бус» и каустика,
                          // 0.08..0.18 = рукав-коса. Реальные диски ~0.1
      diskK: 3.1,         // профиль диска exp(-k·r): больше — резче к краю
      bulge: 0.20,        // доля звёзд балджа
      bulgeR: 0.214,      // радиус балджа (доля R); с баром — половина длины бара
      bar: 0,             // бар: эксцентриситет орбит балджа вдоль barAngle (0 — круглый балдж,
                          // 0.6 — бар примерно втрое длиннее своей ширины)
      barAngle: 0,        // направление бара, рад (экранный угол, y вниз)
      halo: 0.22,         // доля «круглых» звёзд меж рукавия (сглаживает фон)
      diffuse: 0.42,      // доля звёзд диска вне узкой ленты рукава
      exposure: 0.42,     // общий знаменатель яркости (аддитивный слой любит сливаться)
      count: 0,           // 0 = авто по площади
      countDiv: 150,      // px² на одну звезду в авто-режиме (150 ≈ 13k на 1920×900)
      speed: 0.14,        // угловая скорость на r=rIn, рад/с (внутренние быстрее); знак —
                          // направление. 0.10 = спокойный дрейф, 0.25 = заметный поток
      shear: 1.12,        // dΩ/dr: Ω = speed · (rIn/r)^shear (1.5 = кеплерово)
      bright: 1.0,
      armGain: 0.62,      // подсветка рукава (аналитическое поле)
      dustAmp: 0.62,      // пыльные полосы (затемнение в том же поле)
      dustShift: 0.055,   // сдвиг пыли к внутреннему краю рукава (как у реальных галактик)
      dustW: 0.032,       // ширина полосы (в долях периода рукава)
      twinkle: 0.55,      // амплитуда мерцания
      trail: 0.16,        // 0 = шлейфа нет; 0.1..0.3 — потоки вдоль рукава (больше = «комета»)
      lane: 1.4,          // ширина ленты рукава, рад по фазе орбиты (0.6 узкие, 1.8 широкие)
      glow: 0.85,         // яркость слоя дымки (в канвасе; CSS домножит)
      flares: 0.0016,     // доля звёзд с дифракционными лучами (с шлейфом это дорогие точки)
      hii: 0.03,          // доля HII/OB-областей (розовые/циановые, крупные)
      patternSpeed: 0,    // >0: волна ЯРКОСТИ едет вдоль рукава (узор плотности при
                          //     этом стоит — звёзды не перекручиваются). 0 = дефолт.
      pattern: null,      // { data: Float32Array(size²), size } — яркость узора в проекции
                          // диска [-1..1]² (patternFromImage); заменяет аналитическое поле
      tint: null,         // [r,g,b] — подкраска палитры (для скина)
      tintAmt: 0,
      palette: 'classic',
      createCanvas: null
    };
  }

  /* ---------- ядро ---------- */
  function create(userOpts) {
    var o = defaults();
    if (userOpts) for (var k2 in userOpts) if (k2 in o) o[k2] = userOpts[k2];
    var mkCanvas = o.createCanvas || makeCanvas;

    var S = {
      o: o, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0,
      n: 0, t: 0,
      M: null, om: null, ax: null, b: null, cp: null, sp: null,
      sz: null, al: null, ci: null, twp: null, twr: null, fl: null,
      pal: null, atlas: null, flare: null,
      // проекция «плоскость диска -> узор» (наклон flat, position angle pa)
      pA: 1, pB: 0, pC: 0, pD: 1,
      // вид «узор -> холст»: центр и радиус диска в px холста, размер звезды, холст
      ox: 0, oy: 0, sc: 0, starPx: 0, cw: 0, ch: 0,
      fresh: true         // вид сменился: шлейф не тянем, холст чистим целиком
    };

    var A = 4, lnRin = 0;

    // производные от настроек: логоспираль, проекция, палитра
    function derive() {
      var p = o.pitch || 14;
      A = (p < 0 ? -1 : 1) / Math.tan(clamp(Math.abs(p), 4, 60) * DEG);
      lnRin = Math.log(o.rIn);
      var cPA = Math.cos(o.pa), sPA = Math.sin(o.pa);
      // узор = [ [cPA, -sPA*flat], [sPA, cPA*flat] ] * (X, Y)
      S.pA = cPA; S.pB = sPA; S.pC = -sPA * o.flat; S.pD = cPA * o.flat;
      var pal = (PALETTES[o.palette] || PALETTES.classic).map(function (c) {
        if (!o.tint || o.tintAmt <= 0) return c;
        var t = o.tintAmt;
        return [
          Math.round(c[0] * (1 - t) + o.tint[0] * t),
          Math.round(c[1] * (1 - t) + o.tint[1] * t),
          Math.round(c[2] * (1 - t) + o.tint[2] * t)
        ];
      });
      var key = JSON.stringify(pal);
      if (S.palKey !== key) {
        S.palKey = key;
        S.pal = pal;
        S.atlas = buildAtlas(pal, mkCanvas);
        S.flare = buildFlare(pal, mkCanvas);
      }
    }
    derive();

    /* --- генерация населения: сид фиксирован, вызывается на resize / populate / set --- */
    function populate(w, h) {
      var area = (w || 0) * (h || 0);
      var n = o.count > 0 ? Math.round(o.count) : clamp(Math.round(area / o.countDiv), 5000, 22000);
      var rand = mulberry32(o.seed);
      S.n = n;
      S.M = new Float32Array(n); S.om = new Float32Array(n);
      S.b = new Float32Array(n); S.ax = new Float32Array(n);
      S.cp = new Float32Array(n); S.sp = new Float32Array(n);
      S.sz = new Float32Array(n); S.al = new Float32Array(n);
      S.ci = new Uint8Array(n); S.twp = new Float32Array(n); S.twr = new Float32Array(n);
      S.fl = new Uint8Array(n);

      for (var i = 0; i < n; i++) {
        var p = rand();
        var r, e, ci, sz, al, tight, arm, psiFix = null;

        if (p < o.bulge) {
          /* --- балдж: плотно, кругло, тепло; с баром — вытянутые орбиты вдоль бара --- */
          if (o.bar > 0) {
            var aBar = o.bulgeR * (0.12 + 0.88 * Math.sqrt(rand()));   // большая полуось
            e = clamp(o.bar * (0.55 + 0.45 * rand()), 0, 0.92);
            r = aBar * (1 - e);
            // половина звёзд — с другого конца: сгущение у обоих концов бара
            psiFix = o.barAngle + (rand() < 0.5 ? 0 : Math.PI) + gauss(rand) * 0.07;
          } else {
            r = o.rIn * 0.25 + (o.bulgeR - o.rIn * 0.25) * Math.sqrt(rand());
            e = 0.04 + rand() * 0.16;
          }
          ci = rand() < 0.7 ? 0 : 1;
          sz = 0.9 + rand() * 1.7;
          al = 0.05 + rand() * 0.14;
          tight = 0;                       // фаза равномерна => балдж круглый
          arm = 0;
        } else if (p < o.bulge + o.halo) {
          /* --- «гало» диска: вне рукавов, тускло, заполняет межрукавие --- */
          r = o.rIn + (o.rOut - o.rIn) * Math.pow(rand(), 0.62);
          e = 0.02 + rand() * 0.06;
          ci = 2 + ((rand() * 4) | 0);
          sz = 0.7 + rand() * 1.5;
          al = 0.03 + rand() * 0.08;
          tight = 0;
          arm = 0;
        } else {
          /* --- диск: экспоненциальный профиль + узкая лента рукава --- */
          var u = rand();
          r = o.rIn + (o.rOut - o.rIn) *
            (-Math.log(1 - u * (1 - Math.exp(-o.diskK))) / o.diskK);
          r = clamp(r, o.rIn * 0.6, o.rOut * 1.06);
          var t = (r - o.rIn) / (o.rOut - o.rIn);
          // эксцентриситет: 0 на краях, максимум в середине диска,
          // иначе на границе получается «каша» из апсид и рвётся фейд.
          e = o.ecc * Math.pow(Math.sin(Math.PI * clamp(t, 0, 1)), 0.85);
          ci = t < 0.22 ? 1 : t < 0.5 ? 2 : t < 0.78 ? 3 : 4;
          if (rand() < o.hii) ci = rand() < 0.62 ? 6 : 7;   // HII / OB вдоль рукавов
          sz = (rand() < 0.05 ? 2.6 : 1.0) * (0.6 + rand() * 1.7);
          if (ci === 6 || ci === 7) sz *= 2.6;
          al = (ci === 6 || ci === 7 ? 0.11 : 0.055) + rand() * 0.13;
          arm = (rand() * o.arms) | 0;
          // часть звёзд — в узкой ленте рукава, часть размыта по всей орбите:
          // лента даёт структуру, размытые — фон и ощущение объёма.
          tight = rand() < (1 - o.diffuse) ? o.lane * (0.55 + rand() * 0.9) : 1;
        }

        // лента — там, где огибающая: фаза около 0
        var phi = tight >= 1 ? rand() * TAU : gauss(rand) * tight * 2.4;

        S.b[i] = r;                          // малая полуось = радиус «сборки»
        S.ax[i] = r / (1 - e);               // большая полуось
        // ориентация орбиты: закон + разброс. Без разброса огибающая даёт
        // слишком резкий гребень (каустику) и «бусы» вместо косы рукава.
        var psi;
        if (psiFix !== null) {
          psi = psiFix;
        } else {
          r *= 1 + gauss(rand) * 0.035;
          psi = o.psi0 + arm * (TAU / o.arms) + A * (Math.log(Math.max(r, o.rIn * 0.5)) - lnRin) +
            gauss(rand) * o.misalign;
        }
        S.cp[i] = Math.cos(psi); S.sp[i] = Math.sin(psi);
        S.om[i] = o.speed * Math.pow(Math.max(r, o.rIn) / o.rIn, -o.shear);
        S.M[i] = phi < 0 ? phi + TAU : phi;
        S.sz[i] = sz;
        S.al[i] = al;
        S.ci[i] = ci & 7;
        S.twp[i] = rand() * TAU;
        S.twr[i] = 0.35 + rand() * 2.6;
        S.fl[i] = (sz > 2.9 && rand() < o.flares * 60) ? 1 : 0;
      }
      S.fresh = true;
    }

    // вид: центр диска (ox, oy) и его радиус scale — в px холста; starPx — px холста на
    // единицу размера звезды (0 — от радиуса, как в демо); cw × ch — размер холста
    function view(ox, oy, scale, starPx, cw, ch) {
      if (ox !== S.ox || oy !== S.oy || scale !== S.sc || cw !== S.cw || ch !== S.ch) S.fresh = true;
      S.ox = ox; S.oy = oy; S.sc = scale; S.starPx = starPx || 0; S.cw = cw; S.ch = ch;
    }

    // демо: галактика вписана в холст w×h (CSS px), плотность dpr
    function resize(w, h, dpr) {
      dpr = Math.min(dpr || 1, 2);   // на 3x-телефонах 26k спрайтов x 3 = гарантированный дроп
      S.w = w; S.h = h; S.dpr = dpr;
      S.R = Math.min(w, h * 0.62) * 0.5 * 2.05;   // R: широкая спираль, влезает по высоте
      S.cx = w * 0.5; S.cy = h * 0.5;
      derive();
      view(S.cx * dpr, S.cy * dpr, S.R * dpr, 0, w * dpr, h * dpr);
      populate(w, h);
    }

    /* --- кадр: только звёзды. Никаких глобальных трансформаций! --- */
    function frame(ctx, dt) {
      var o2 = S.o;
      S.t += dt;
      var cw = S.cw, ch = S.ch;
      var t = S.t;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (o2.trail > 0 && !S.fresh) {
        // шлейф: старое гасим destination-out (а не полупрозрачным «чёрным», иначе
        // через 2 секунды диск поплывёт в грязно-серый). Доля — по времени кадра:
        // длина шлейфа одинакова при 30 и 60 кадрах в секунду.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0,0,0,' + (1 - Math.pow(1 - clamp(o2.trail, 0, 0.6), dt * 60)) + ')';
        ctx.fillRect(0, 0, cw, ch);
      } else {
        ctx.clearRect(0, 0, cw, ch);
      }
      S.fresh = false;

      ctx.globalCompositeOperation = 'lighter';   // аддитивная сборка: ядро само раздуется
      var pA = S.pA, pB = S.pB, pC = S.pC, pD = S.pD, ox = S.ox, oy = S.oy, sc = S.sc;
      var n = S.n, M = S.M, om = S.om, ax = S.ax, b = S.b, cp = S.cp, sp = S.sp;
      var sz = S.sz, ci = S.ci, twp = S.twp, twr = S.twr, fl = S.fl;
      var gain = o2.armGain, damp = o2.dustAmp, dw = o2.dustW, sh = o2.dustShift;
      var invArm = o2.arms / TAU, bright = o2.bright * o2.exposure;
      var twa = o2.twinkle, ps = o2.patternSpeed, tnow = t;
      var rEdge = o2.rOut, rFade = o2.rOut * o2.fadeIn;
      var k1 = 1 / (2 * 0.14 * 0.14), k2 = 1 / (2 * dw * dw);
      var atlas = S.atlas, flar = S.flare, SPRc = SPR, FLRc = FLR;
      var drift = ps * t;   // сдвиг поля яркости (pattern speed). 0 => поле стоит.
      var pat = o2.pattern, pd = pat ? pat.data : null, pn = pat ? pat.size : 0, ph = pn * 0.5;
      // размер звезды: px холста на единицу sz (демо — от радиуса диска, как было)
      var unit = S.starPx || sc * 0.0042;
      // звёзды за краем холста не рисуем (запас — под крупные звёзды и лучи)
      var cull = 48, cL = -cull, cT = -cull, cR = cw + cull, cB = ch + cull;

      for (var i = 0; i < n; i++) {
        var m = M[i] + om[i] * dt;
        if (m > TAU) m -= TAU;
        else if (m < 0) m += TAU;
        M[i] = m;

        var sM = Math.sin(m), cM = Math.cos(m);
        var e = 1 - b[i] / ax[i];
        // E = M + e sin M — одна итерация Кеплера: замедление у одного конца орбиты,
        // то есть естественное загущение именно там, где огибающая.
        var dd = e * sM;
        var cd = 1 - dd * dd * 0.5, sd = dd * (1 - dd * dd / 6);
        var ex = cM * cd - sM * sd;          // cos E
        var ey = sM * cd + cM * sd;          // sin E
        var x = ax[i] * ex, y = b[i] * ey;
        var X = x * cp[i] - y * sp[i];
        var Y = x * sp[i] + y * cp[i];

        var r2 = X * X + Y * Y;
        var rho = Math.sqrt(r2);
        var edge = smoothstep(rEdge, rFade, rho);
        if (edge <= 0.002) continue;
        edge *= 0.06 + 0.94 * smoothstep(0.0, rEdge * 0.16, rho);  // чуть глушим самый центр

        // проекция (наклон + position angle), затем вид
        var PX = pA * X + pC * Y, PY = pB * X + pD * Y;
        var px = ox + sc * PX, py = oy + sc * PY;
        if (px < cL || py < cT || px > cR || py > cB) continue;

        var arm, lum;
        if (pd) {
          // яркость рисунка в точке, где звезда сейчас
          if (PX <= -1 || PX >= 1 || PY <= -1 || PY >= 1) continue;
          arm = pd[((PY + 1) * ph | 0) * pn + ((PX + 1) * ph | 0)];
          if (arm <= 0.004) continue;
          lum = arm * bright * edge;
        } else {
          // поле шаблона: смещение от ближайшего рукава (стоит на месте)
          var th = Math.atan2(Y, X);
          var q = (th - A * (0.5 * Math.log(r2) - lnRin) - o2.psi0) * invArm - drift;
          var pph = q - Math.round(q);
          arm = Math.exp(-pph * pph * k1);
          var dp = pph - sh;
          // пыль живёт в диске (0.2R..1R): в балдже полос не бывает
          var dgate = smoothstep(0.14, 0.34, rho) * edge;
          var dust = Math.exp(-dp * dp * k2) * dgate;
          lum = (1 + gain * arm) * (1 - damp * dust) * bright * edge;
        }
        if (lum <= 0.004) continue;
        lum *= 1 + twa * Math.sin(tnow * twr[i] + twp[i]);
        if (lum <= 0.004) continue;

        var s = sz[i] * unit * (1 + 0.45 * arm);
        if (s < 0.6) s = 0.6;
        ctx.globalAlpha = lum < 1 ? lum : 1;
        ctx.drawImage(atlas, ci[i] * SPRc, 0, SPRc, SPRc, px - s * 0.5, py - s * 0.5, s, s);
        if (fl[i]) {
          var fs = s * 3.4;
          ctx.globalAlpha = clamp(lum * 0.16, 0, 1);
          ctx.drawImage(flar, 0, 0, FLRc, FLRc, px - fs * 0.5, py - fs * 0.5, fs, fs);
        }
      }
      ctx.restore();
      return n;
    }

    /* --- слой дымки (демо): рисуется ОДИН РАЗ. Статичен, как и положено шаблону. --- */
    function nebula(ctx) {
      var w = S.w * NB_SCALE, h = S.h * NB_SCALE;
      if (!w || !h) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      var k = NB_SCALE;
      var sc = S.R * k;                                     // S.R в CSS-px -> в px дымки
      var cx = S.cx * k, cy = S.cy * k;
      ctx.setTransform(sc * S.pA, sc * S.pB, sc * S.pC, sc * S.pD, cx, cy);

      var glow = o.glow;
      // 1) балдж: два вложенных градиента (узкое яркое + широкое жёлтое)
      var gb = ctx.createRadialGradient(0, 0, 0, 0, 0, o.rIn * 3.4);
      gb.addColorStop(0, 'rgba(255,246,225,' + (0.55 * glow) + ')');
      gb.addColorStop(0.35, 'rgba(255,220,160,' + (0.20 * glow) + ')');
      gb.addColorStop(1, 'rgba(255,190,120,0)');
      ctx.fillStyle = gb;
      ctx.fillRect(-o.rIn * 3.4, -o.rIn * 3.4, o.rIn * 6.8, o.rIn * 6.8);
      var gb2 = ctx.createRadialGradient(0, 0, 0, 0, 0, o.rIn * 9);
      gb2.addColorStop(0, 'rgba(255,232,196,' + (0.26 * glow) + ')');
      gb2.addColorStop(0.5, 'rgba(255,214,170,' + (0.08 * glow) + ')');
      gb2.addColorStop(1, 'rgba(120,110,150,0)');
      ctx.fillStyle = gb2;
      ctx.fillRect(-o.rIn * 9, -o.rIn * 9, o.rIn * 18, o.rIn * 18);

      // 2) диск: экспоненциальный блик по радиусу (без рук — просто фон)
      var gd = ctx.createRadialGradient(0, 0, o.rIn * 1.5, 0, 0, o.rOut * 1.08);
      gd.addColorStop(0, 'rgba(150,175,230,' + (0.10 * glow) + ')');
      gd.addColorStop(0.55, 'rgba(120,155,215,' + (0.055 * glow) + ')');
      gd.addColorStop(1, 'rgba(60,90,160,0)');
      ctx.fillStyle = gd;
      ctx.fillRect(-o.rOut * 1.1, -o.rOut * 1.1, o.rOut * 2.2, o.rOut * 2.2);

      // 3) сами рукава: идём по логоспирали и ставим мягкие пятна — тот же закон, что
      //    у орбит (A·ln r), поэтому дымка совпадает со скоплением звёзд при любом pitch.
      var step = 190;
      for (var a2 = 0; a2 < o.arms; a2++) {
        for (var s2 = 0; s2 <= step; s2++) {
          var tt = s2 / step;
          var rr = Math.exp(lnRin + (Math.log(o.rOut * 1.05) - lnRin) * tt);
          var ang = o.psi0 + a2 * TAU / o.arms + A * (Math.log(rr) - lnRin);
          var bx = rr * Math.cos(ang), by = rr * Math.sin(ang);
          var rad = (0.055 + 0.175 * (rr / o.rOut)) * o.rOut;
          var fade = smoothstep(0, 0.12, tt) * smoothstep(1, 0.72, tt);
          var col = a2 % 2 ? 'rgba(120,170,255,' : 'rgba(150,190,255,';
          var ga = ctx.createRadialGradient(bx, by, 0, bx, by, rad);
          ga.addColorStop(0, col + (0.075 * glow * fade) + ')');
          ga.addColorStop(0.5, col + (0.032 * glow * fade) + ')');
          ga.addColorStop(1, col + '0)');
          ctx.fillStyle = ga;
          ctx.fillRect(bx - rad, by - rad, rad * 2, rad * 2);
        }
      }

      // 4) пыль: выжигаем полосы у внутреннего края рукава (destination-out
      //    в аддитивном слое = «дымка кончилась», без чёрных мазков поверх)
      ctx.globalCompositeOperation = 'destination-out';
      for (var a3 = 0; a3 < o.arms; a3++) {
        for (var s3 = 0; s3 <= step; s3++) {
          var t3 = s3 / step;
          var r3 = Math.exp(lnRin + (Math.log(o.rOut) - lnRin) * t3);
          var an3 = o.psi0 + a3 * TAU / o.arms + A * (Math.log(r3) - lnRin) + o.dustShift * TAU / o.arms;
          var dx = r3 * Math.cos(an3), dy = r3 * Math.sin(an3);
          var rd = (0.03 + 0.075 * (r3 / o.rOut)) * o.rOut;
          var f3 = smoothstep(0.14, 0.34, t3) * smoothstep(1, 0.66, t3) * o.dustAmp;
          var gdx = ctx.createRadialGradient(dx, dy, 0, dx, dy, rd);
          gdx.addColorStop(0, 'rgba(0,0,0,' + (0.75 * f3) + ')');
          gdx.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = gdx;
          ctx.fillRect(dx - rd, dy - rd, rd * 2, rd * 2);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    /* --- диагностика: доказательство, что узор стоит ---
       Рисует (1) эллипсы-орбиты, повёрнутые по A·ln r, и (2) саму огибающую —
       логоспираль. Проекция вручную, чтобы линия осталась 1 px. */
    function debug(ctx, mode) {
      var w = S.w, h = S.h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var k = 1 / S.dpr;
      function pt(X, Y) {
        return [(S.ox + S.sc * (S.pA * X + S.pC * Y)) * k, (S.oy + S.sc * (S.pB * X + S.pD * Y)) * k];
      }
      var STEPS = 64;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(120,255,215,.26)';
      // орбиты: 40 эллипсов, повёрнутых по закону A·ln r
      for (var i = 0; i < 40; i++) {
        var idx = Math.floor(i / 40 * S.n) % S.n;
        var Aa = S.ax[idx], Bb = S.b[idx], c = S.cp[idx], d = S.sp[idx];
        ctx.beginPath();
        for (var s2 = 0; s2 <= STEPS; s2++) {
          var th = s2 / STEPS * TAU;
          var ex = Aa * Math.cos(th), ey = Bb * Math.sin(th);
          var q = pt(ex * c - ey * d, ex * d + ey * c);
          if (s2) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]);
        }
        ctx.stroke();
      }
      if (mode === 'orbits') return;
      // огибающая = спираль рукава: она НЕ двигается, в отличие от точек на эллипсах
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,120,150,.75)';
      for (var a = 0; a < o.arms; a++) {
        ctx.beginPath();
        for (var s3 = 0; s3 <= 240; s3++) {
          var t3 = s3 / 240;
          var rr = Math.exp(lnRin + (Math.log(o.rOut) - lnRin) * t3);
          var an = o.psi0 + a * TAU / o.arms + A * (Math.log(rr) - lnRin);
          var p3 = pt(rr * Math.cos(an), rr * Math.sin(an));
          if (s3) ctx.lineTo(p3[0], p3[1]); else ctx.moveTo(p3[0], p3[1]);
        }
        ctx.stroke();
      }
      // точки сборки — куда стекаются звёзды: та же кривая
      ctx.fillStyle = 'rgba(255,220,140,.85)';
      for (var j = 0; j < S.n; j += 7) {
        var c4 = S.cp[j], d4 = S.sp[j], b4 = S.b[j];
        var p4 = pt(b4 * c4, b4 * d4);
        ctx.fillRect(p4[0] - 1, p4[1] - 1, 2, 2);
      }
    }

    return {
      state: S, opts: o,
      resize: resize, view: view, frame: frame, nebula: nebula, debug: debug,
      populate: function () { derive(); populate(S.w, S.h); },
      set: function (patch) {
        for (var kk in patch) {
          if (!(kk in o)) continue;
          o[kk] = patch[kk];
        }
        derive();                       // pitch, проекция и палитра — сразу, без перезапуска
        if (S.n) populate(S.w, S.h);
      }
    };
  }

  /* ---------- узор из рисунка ----------
     Квадрат картинки [cx−r, cx+r] × [cy−r, cy+r] (доли сторон) уменьшается до size×size.
     1) Зелёный HUD (рамки, подписи, кадры CAM) — вне узора. Одиночные «зелёные» тексели
        (перекрестья сетки) HUD не считаются, иначе звёзды мигали бы на каждом узле;
        всё, что замкнуто рамкой HUD (картинки внутри кадров CAM), — тоже вне узора.
     2) Узор — контраст рукавов: яркость тексела, делённая на среднюю яркость своего
        кольца (без HUD). Рукав светлее кольца, промежуток темнее — поэтому рукава
        одинаково заметны у ядра и на краю, а яркое ядро не забирает себе все звёзды.
        Контраст 0.8…1.3 переводится в 0…1 и возводится в gamma (больше — уже рукава).
     3) Огибающая по радиусу: за краем диска, где кольца тёмные, узор гаснет.
     Картинка должна быть с того же домена (getImageData). */
  function patternFromImage(img, cx, cy, r, size, gamma) {
    var n = size || 256;
    var gm = gamma == null ? 1 : gamma;
    var LO = 0.8, HI = 1.3;               // контраст «промежуток … рукав»
    var iw = img && img.naturalWidth, ih = img && img.naturalHeight;
    if (!iw || !ih) return null;
    var cv = makeCanvas(n, n);
    var g = cv.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.drawImage(img, (cx - r) * iw, (cy - r) * ih, 2 * r * iw, 2 * r * ih, 0, 0, n, n);
    var px = g.getImageData(0, 0, n, n).data;
    var N2 = n * n, lum = new Float32Array(N2), hud = new Uint8Array(N2);
    var i, j, x, y, dx, dy, xx, yy;
    for (i = 0; i < N2; i++) {
      var R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      lum[i] = 0.3 * R + 0.59 * G + 0.11 * B;
      hud[i] = (G > R * 1.04 && G > 40) ? 1 : 0;
    }
    // HUD = зелёные тексели, у которых в окне 5×5 не меньше 6 таких же; плюс тексель запаса
    var mask = new Uint8Array(N2);
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        if (!hud[y * n + x]) continue;
        var cnt = 0;
        for (dy = -2; dy <= 2; dy++) {
          yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          for (dx = -2; dx <= 2; dx++) {
            xx = x + dx;
            if (xx >= 0 && xx < n && hud[yy * n + xx]) cnt++;
          }
        }
        if (cnt < 6) continue;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            xx = x + dx; yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < n && yy < n) mask[yy * n + xx] = 1;
          }
        }
      }
    }
    // замкнутое рамкой: заливка от края текстуры по свободным текселям; куда не дошла — внутри
    var seen = new Uint8Array(N2), queue = new Int32Array(N2), qh = 0, qt = 0;
    function push(k) { if (!mask[k] && !seen[k]) { seen[k] = 1; queue[qt++] = k; } }
    for (i = 0; i < n; i++) { push(i); push((n - 1) * n + i); push(i * n); push(i * n + n - 1); }
    while (qh < qt) {
      var k = queue[qh++], kx = k % n, ky = (k - kx) / n;
      if (kx > 0) push(k - 1);
      if (kx < n - 1) push(k + 1);
      if (ky > 0) push(k - n);
      if (ky < n - 1) push(k + n);
    }
    for (i = 0; i < N2; i++) if (!seen[i]) mask[i] = 1;
    // сглаживание 5×5 без HUD: гасит тонкую сетку карты, рукава (10–20 текселей) остаются
    var sm = new Float32Array(N2);
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        i = y * n + x;
        if (mask[i]) continue;
        var sum = 0, w = 0;
        for (dy = -2; dy <= 2; dy++) {
          yy = y + dy;
          if (yy < 0 || yy >= n) continue;
          for (dx = -2; dx <= 2; dx++) {
            xx = x + dx;
            if (xx < 0 || xx >= n) continue;
            j = yy * n + xx;
            if (mask[j]) continue;
            sum += lum[j]; w++;
          }
        }
        sm[i] = w ? sum / w : 0;
      }
    }
    // средняя яркость колец (48 колец на радиус r) без HUD, слегка сглаженная
    var NB = 48, NR = NB + 12, ringSum = new Float64Array(NR), ringCnt = new Float64Array(NR);
    var ring = new Uint8Array(N2), half = n / 2;
    for (y = 0; y < n; y++) {
      for (x = 0; x < n; x++) {
        i = y * n + x;
        var rr = Math.sqrt((x + 0.5 - half) * (x + 0.5 - half) + (y + 0.5 - half) * (y + 0.5 - half)) / half;
        var rb = Math.min(NR - 1, (rr * NB) | 0);
        ring[i] = rb;
        if (!mask[i]) { ringSum[rb] += sm[i]; ringCnt[rb]++; }
      }
    }
    var prof = new Float64Array(NR), maxDisk = 0;
    for (j = 0; j < NR; j++) prof[j] = ringCnt[j] ? ringSum[j] / ringCnt[j] : 0;
    var kern = [1, 2, 3, 2, 1], ps = new Float64Array(NR);
    for (j = 0; j < NR; j++) {
      var a = 0, ww = 0;
      for (var t = -2; t <= 2; t++) {
        var jj = j + t;
        if (jj < 0 || jj >= NR || !ringCnt[jj]) continue;
        a += prof[jj] * kern[t + 2]; ww += kern[t + 2];
      }
      ps[j] = ww ? a / ww : 0;
      if (j < NB && ps[j] > maxDisk) maxDisk = ps[j];
    }
    if (!maxDisk) return null;
    var out = new Float32Array(N2);
    for (i = 0; i < N2; i++) {
      if (mask[i]) continue;
      var mr = ps[ring[i]];
      if (mr <= 1) continue;
      var v = clamp((sm[i] / mr - LO) / (HI - LO), 0, 1);
      var env = clamp((mr / maxDisk - 0.08) / 0.5, 0, 1);
      out[i] = Math.pow(v, gm) * Math.pow(env, 0.6);
    }
    return { data: out, size: n };
  }

  /* ---------- DOM-обвязка демо ---------- */
  function mount(host, userOpts) {
    if (!host) return null;
    var g = create(userOpts);

    var rootEl = document.createElement('div');
    rootEl.className = 'gs-root';
    rootEl.setAttribute('aria-hidden', 'true');
    var neb = document.createElement('canvas'); neb.className = 'gs-nebula';
    var stars = document.createElement('canvas'); stars.className = 'gs-stars';
    var dbg = document.createElement('canvas'); dbg.className = 'gs-debug'; dbg.hidden = true;
    var grain = document.createElement('div'); grain.className = 'gs-grain';
    var core = document.createElement('div'); core.className = 'gs-core';
    rootEl.appendChild(neb); rootEl.appendChild(stars); rootEl.appendChild(dbg);
    rootEl.appendChild(grain); rootEl.appendChild(core);
    host.appendChild(rootEl);

    var nctx = neb.getContext('2d');
    var sctx = stars.getContext('2d');
    var dctx = dbg.getContext('2d');
    var raf = 0, last = 0, visible = true, debugOn = false;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function layout() {
      var w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return;
      var dpr = window.devicePixelRatio || 1;
      g.resize(w, h, dpr);
      stars.width = Math.round(w * Math.min(dpr, 2));
      stars.height = Math.round(h * Math.min(dpr, 2));
      stars.style.width = w + 'px'; stars.style.height = h + 'px';
      neb.width = Math.max(2, Math.round(w * NB_SCALE));
      neb.height = Math.max(2, Math.round(h * NB_SCALE));
      neb.style.width = w + 'px'; neb.style.height = h + 'px';
      dbg.width = w; dbg.height = h;
      g.nebula(nctx);                       // статичный слой: раз в resize
      if (debugOn) g.debug(dctx, 'both');
      if (reduce) g.frame(sctx, 0.016);   // один кадр вместо анимации
    }

    function loop(now) {
      raf = 0;
      if (!visible || document.hidden) return;
      if (!last) last = now;
      var dt = Math.min((now - last) / 1000, 1 / 20);   // clamp: после таба не телепортим
      last = now;
      g.frame(sctx, dt);
      if (debugOn) g.debug(dctx, 'both');
      raf = requestAnimationFrame(loop);
    }
    function play() { if (!raf && !reduce && visible) { last = 0; raf = requestAnimationFrame(loop); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function onVisibility() {
      visible = !document.hidden;
      if (visible) play(); else stop();
    }

    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(layout); ro.observe(host); }
    window.addEventListener('resize', layout);
    document.addEventListener('visibilitychange', onVisibility);

    layout();
    play();

    return {
      el: rootEl, engine: g,
      set: function (patch) { g.set(patch); g.nebula(nctx); if (debugOn) g.debug(dctx, 'both'); },
      debug: function (on) { debugOn = !!on; dbg.hidden = !debugOn; if (debugOn) g.debug(dctx, 'both'); else dctx.clearRect(0, 0, dbg.width, dbg.height); },
      play: play, stop: stop,
      destroy: function () {
        stop();
        window.removeEventListener('resize', layout);
        document.removeEventListener('visibilitychange', onVisibility);
        if (ro) ro.disconnect();
        rootEl.remove();
      }
    };
  }

  /* ---------- слой поверх карты ----------
     o.layer    — контейнер карты, который двигается и масштабируется (#mapLayer);
     o.image    — картинка карты: из неё строится узор, после неё встаёт холст;
     o.before   — перед каким элементом вставить холст (по умолчанию — сразу после
                  картинки). На галактике — перед слоем «лагов»: спираль над картой,
                  но под всеми остальными эффектами;
     o.center   — [x, y] центр галактики, доли стороны карты; o.radius — радиус диска;
     o.view()   — текущий вид { s, tx, ty, base, w, h }: масштаб, сдвиг слоя, сторона
                  карты при s = 1, размер сцены (CSS px);
     o.engine   — настройки ядра (count, speed, pitch, bar, …); pattern ставится сам;
     o.fps      — кадров в секунду в покое; пока карта двигается — каждый кадр;
     o.starSize, o.starZoom — размер звезды при 100 % на карте со стороной 1000 px (CSS px
                  на единицу sz) и его рост с зумом: starSize · s^starZoom · √(base/1000) —
                  на маленьком экране звёзды мельче, как и сама карта;
     o.patternSize, o.patternGamma — разрешение узора и его контраст;
     o.opacity  — прозрачность слоя; o.maxDpr — потолок плотности пикселей холста;
     o.margin   — запас холста за краем сцены (доля), чтобы при быстром сдвиге край
                  не оголялся.
     Холст стоит в % слоя: CSS двигает и масштабирует его вместе с картой в том же
     кадре, поэтому звёзды не отстают от рисунка. Каждый кадр холст заново накрывает
     видимую часть сцены и рисуется в её разрешении — чётко на любом зуме, а звёзды
     вне сцены не рисуются. При prefers-reduced-motion слой не создаётся (null). */
  function overlay(o) {
    if (!o || !o.layer || !o.image || typeof document === 'undefined') return null;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

    var cv = document.createElement('canvas');
    cv.className = o.className || 'galaxy-spiral';
    cv.setAttribute('aria-hidden', 'true');
    if (o.opacity != null) cv.style.opacity = String(o.opacity);
    var anchor = o.before && o.before.parentNode === o.layer ? o.before : o.image.nextSibling;
    o.layer.insertBefore(cv, anchor);
    var ctx = cv.getContext('2d');

    var cx = o.center[0], cy = o.center[1], rad = o.radius;
    var fps = o.fps > 0 ? o.fps : 30;
    var margin = o.margin == null ? 0.08 : o.margin;
    var maxDpr = o.maxDpr || 1.5;
    var starSize = o.starSize || 3;
    var starZoom = o.starZoom == null ? 0.4 : o.starZoom;
    var eng = null, raf = 0, last = 0, lastDraw = 0, key = '', alive = true;
    var patternSrc = '';

    function start() {
      if (!alive) return;
      var srcKey = o.image.currentSrc || o.image.src || '';
      if (eng && srcKey === patternSrc) return;
      var pattern = null;
      try {
        pattern = patternFromImage(o.image, cx, cy, rad, o.patternSize, o.patternGamma);
      } catch (err) {
        pattern = null;                 // рисунок не прочитать (чужой домен)
      }
      if (!pattern) {
        if (!eng) destroy();            // не теряем уже работающую анимацию при неудачной догрузке
        return;
      }
      patternSrc = srcKey;
      if (eng) {
        // srcset может переключить разрешение карты при изменении размера/зума.
        // Меняем только поле яркости: орбиты и текущие фазы звёзд продолжаются без сброса.
        eng.opts.pattern = pattern;
        return;
      }
      var opts = {};
      var src = o.engine || {};
      for (var k in src) opts[k] = src[k];
      opts.pattern = pattern;
      eng = create(opts);
      eng.populate();
      play();
    }

    // накрыть видимую часть сцены и передать ядру вид; true — вид сменился
    function place() {
      var v = o.view && o.view();
      if (!v || !v.base || !v.w || !v.h) return false;
      var side = v.s * v.base;
      var x0 = -v.tx - v.w * margin, y0 = -v.ty - v.h * margin;
      var cssW = v.w * (1 + 2 * margin), cssH = v.h * (1 + 2 * margin);
      var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      var bw = Math.max(1, Math.round(cssW * dpr)), bh = Math.max(1, Math.round(cssH * dpr));
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
      var prev = key;
      key = v.s + '|' + v.tx + '|' + v.ty + '|' + v.w + '|' + v.h + '|' + dpr;
      if (key !== prev) {
        cv.style.left = (x0 / side * 100) + '%';
        cv.style.top = (y0 / side * 100) + '%';
        cv.style.width = (cssW / side * 100) + '%';
        cv.style.height = (cssH / side * 100) + '%';
      }
      var kx = bw / cssW, ky = bh / cssH;          // px холста на CSS px (≈ dpr)
      var baseK = clamp(Math.sqrt(v.base / 1000), 0.55, 1.25);
      eng.view((cx * side - x0) * kx, (cy * side - y0) * ky, rad * side * kx,
        starSize * Math.pow(v.s, starZoom) * baseK * kx, bw, bh);
      return key !== prev;
    }

    function loop(now) {
      raf = 0;
      if (!alive || !eng || document.hidden) return;
      var moved = place();
      if (moved || now - lastDraw >= 1000 / fps - 2) {
        var dt = last ? Math.min((now - last) / 1000, 1 / 15) : 1 / fps;
        last = now;
        lastDraw = now;
        eng.frame(ctx, dt);
      }
      raf = requestAnimationFrame(loop);
    }
    function play() { if (!raf && eng && alive && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); } }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    function onVisibility() { if (document.hidden) stop(); else play(); }
    function destroy() {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      o.image.removeEventListener('load', start);
      if (cv.parentNode) cv.parentNode.removeChild(cv);
    }

    document.addEventListener('visibilitychange', onVisibility);
    if (o.image.complete && o.image.naturalWidth) start();
    else o.image.addEventListener('load', start);

    return {
      el: cv,
      engine: function () { return eng; },
      play: play, stop: stop, destroy: destroy
    };
  }

  return {
    VERSION: '1.1',
    create: create, mount: mount, overlay: overlay,
    patternFromImage: patternFromImage,
    defaults: defaults, PALETTES: PALETTES
  };
});
