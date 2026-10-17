/* Спираль галактики: «вращение» без вращения.
   =========================================================================
   ПРИНЦИП (плотностная волна, Lin–Shu)
   -------------------------------------------------------------------------
   Спиральные рукава НИЧЕГО не крутятся: они стоят на месте. Крутятся только
   звёзды — каждая по своей эллиптической орбите. Рукав — это не «верёвка из
   звёзд», а место, где орбиты складываются в загущение (огибающая family of
   ellipses). Звезда втекает в рукав, протекает через него и вытекает:
   картина статична, движение заметно. Отсюда и требуемый эффект — «спин»
   есть, прокрутки нет.

   Как это собрано в числах:
     1) Орбита звезды — эллипс с полуосями a (большая) и b (малая), центр в
        центре галактики. b = r — «радиус сборки», a = b / (1 - e).
     2) Ориентация орбиты psi зависит от радиуса: psi = PSI0 + A * ln(r / rin),
        A = 1 / tan(pitch). Именно ln (логоспираль): поворот орбиты линейен по
        логарифму радиуса => огибающая апсид есть логарифмическая спираль с
        заданным pitch. Угол psi от времени НЕ зависит => огибающая не
        вращается. Никогда. Никаких rotate() в CSS и никаких глобальных
        трансформаций в кадре.
     3) m-кратная симметрия: звёздам раздачи ориентации psi + 2πk/m, поэтому
        рукавов ровно m и они одинаковые.
     4) Звезда движется по орбите по Кеплеру: E = M + e·sin M (эксцентрическая
        аномалия из средней). В окрестности apo/peri скорость дуги минимальна,
        значит там звёзды стоят плотнее => рукав сам подсвечивается, без
        явного «рисования спирали».
     5) Пыль и подсветка рукава — аналитическое поле в ПРОСТРАНСТВЕ ШАБЛОНА:
        p = дробное смещение точки от ближайшего рукава. Светимость
        умножается на (1 + armGain·gauss(p)) и на (1 - dustAmp·gauss(p-сдвиг)).
        Поле стоит на месте, звёзды через него текут — видно и то, и другое.
     6) Граница: яркость каждой звезды режется smoothstep по ρ (faded edge) +
        CSS mask-image radial-gradient на слое. Двойной фейд, поэтому край
        мягкий на любом зуме и без «обрезанного круга».

   СЛОИ (CSS решает всё, что не требует перерисовки)
     .gs-nebula  — дымка, балдж, пыль, ядро. Рисуется ОДИН РАЗ на resize,
                   дальше живёт только CSS: масштаб (canvas 0.28 от размера,
                   растянется браузером => бесплатное размытие), opacity,
                   mix-blend-mode: screen, «дыхание» ядра keyframes.
     .gs-stars   — additive-канвас со звёздами и лёгким шлейфом (trail).
     .gs-grain   — SVG feTurbulence в background-image + steps()-анимация.
   Никаких CSS-анимаций трансформации у канвасов: трансформация канваса
   заставляет браузер пере-растеризовывать его и мы получим мыло вместо
   звёзд.

   ПОТОК ДАННЫХ: SoA во Float32Array, без аллокаций в кадре, спрайты
   звёзд запечены в один атлас (1 ctx.drawImage на звезду), dt-clamp,
   пауза на document.hidden и prefers-reduced-motion.

   API:
     var g = GalaxySpiral.create(opts);      // чистое ядро: resize(w,h,dpr), frame(ctx,t,dt)
     var h = GalaxySpiral.mount(host, opts); // DOM-обвязка: слои, rAF, resize, destroy()
   Модуль не использует DOM в ядре — его можно гонять в Node (тесты,
   предпросчёт, покадровый рендер). */
(function (root, factory) {
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
      [255, 222, 168],  // 0 балдж: тёплый старый населён
      [255, 241, 216],  // 1 внутренний диск
      [232, 240, 255],  // 2 белый
      [196, 220, 255],  // 3 сине-белый (hand Dominant)
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
      pitch: 14,          // угол рукава, deg (10..22 — красиво, >25 — «вертушка»)
      psi0: -55 * DEG,    // ориентация узла: куда «смотрит» внутренняя часть спирали
      flat: 0.46,         // сжатие диска (наклон: 1 = face-on, 0.35 = сильно наклонённая)
      pa: -18 * DEG,      // position angle: статичный наклон проекции (НЕ анимируется)
      rIn: 0.075,         // внутренний край диска (доля R)
      rOut: 1.0,          // внешний край диска: за ним фейд
      ecc: 0.30,          // размах эксцентриситета орбит (главный «рычаг» рукавов)
      misalign: 0.11,     // разброс ориентации орбит, рад. 0 = «нить бус» и каустика,
                          // 0.08..0.18 = рукав-коса. Реальные диски ~0.1
      diskK: 3.1,         // профиль диска exp(-k·r): больше — резче к краю
      bulge: 0.20,        // доля звёзд балджа
      halo: 0.22,         // доля «круглых» звёзд меж рукавия (сглаживает фон)
      diffuse: 0.42,      // доля звёзд диска вне узкой ленты рукава
      exposure: 0.42,     // общий знаменатель яркости (аддитивный слой любит сливаться)
      count: 0,           // 0 = авто по площади
      countDiv: 150,      // px² на одну звезду в авто-режиме (150 ≈ 13k на 1920×900)
      speed: 0.14,        // угловая скорость на r=rIn, рад/с (внутренние быстрее).
                          // 0.10 = спокойный дрейф, 0.25 = заметный поток, 0 = застыло
      shear: 1.12,        // dΩ/dr: Ω = speed · (rIn/r)^shear (1.5 = кеплерово)
      bright: 1.0,
      armGain: 0.62,      // подсветка рукава (поле в пространстве шаблона)
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
      tint: null,         // [r,g,b] — подкраска палитры (для скина)
      tintAmt: 0,
      palette: 'classic',
      createCanvas: null
    };
  }

  /* ---------- ядро ---------- */
  function create(userOpts) {
    var o = {};
    for (var k in defaults()) o[k] = defaults()[k];
    if (userOpts) for (var k2 in userOpts) if (k2 in o) o[k2] = userOpts[k2];
    var mkCanvas = o.createCanvas || makeCanvas;

    var pal = (PALETTES[o.palette] || PALETTES.classic).map(function (c) {
      if (!o.tint || o.tintAmt <= 0) return c;
      var t = o.tintAmt;
      return [
        Math.round(c[0] * (1 - t) + o.tint[0] * t),
        Math.round(c[1] * (1 - t) + o.tint[1] * t),
        Math.round(c[2] * (1 - t) + o.tint[2] * t)
      ];
    });
    var atlas = buildAtlas(pal, mkCanvas);
    var flare = buildFlare(pal, mkCanvas);

    var S = {
      o: o, w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 0,
      n: 0, t: 0,
      M: null, om: null, ax: null, b: null, cp: null, sp: null,
      sz: null, al: null, ci: null, twp: null, twr: null, fl: null,
      pal: pal, atlas: atlas, flare: flare,
      // матрица проекции «плоскость диска -> экран»
      mA: 1, mB: 0, mC: 0, mD: 1
    };

    var A = 1 / Math.tan(Math.max(4, Math.min(60, o.pitch)) * DEG); // логоспираль
    var lnRin = Math.log(o.rIn);

    /* --- генерация населения: вызывается на resize, сид фиксирован --- */
    function populate(w, h, dpr) {
      var area = w * h;
      var n = o.count > 0 ? o.count : clamp(Math.round(area / o.countDiv), 5000, 22000);
      var rand = mulberry32(o.seed);
      S.n = n;
      S.M = new Float32Array(n); S.om = new Float32Array(n);
      S.b = new Float32Array(n); S.ax = new Float32Array(n);
      if (!S.ax) S.ax = new Float32Array(n);
      S.cp = new Float32Array(n); S.sp = new Float32Array(n);
      S.sz = new Float32Array(n); S.al = new Float32Array(n);
      S.ci = new Uint8Array(n); S.twp = new Float32Array(n); S.twr = new Float32Array(n);
      S.fl = new Uint8Array(n);

      for (var i = 0; i < n; i++) {
        var p = rand();
        var r, e, ci, sz, al, tight, arm;

        if (p < o.bulge) {
          /* --- балдж: плотно, кругло, тепло --- */
          r = o.rIn * 0.25 + o.rIn * 2.6 * Math.sqrt(rand());
          e = 0.04 + rand() * 0.16;
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
          // эксцентриситет: 0 на краях, максимум в середине диска.
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

        // лента обязана быть там, где огибающая: фаза около 0 => сборка у радиуса b
        var phi = tight >= 1 ? rand() * TAU : gauss(rand) * tight * 2.4;

        S.b[i] = r;                          // малая полуось = радиус «сборки»
        S.ax[i] = r / (1 - e);               // большая полуось
        // ориентация орбиты: закон + разброс. Без разброса огибающая даёт
        // слишком резкий гребень (каустику) и «бусы» вместо косы рукава.
        r *= 1 + gauss(rand) * 0.035;
        var psi = o.psi0 + arm * (TAU / o.arms) + A * (Math.log(Math.max(r, o.rIn * 0.5)) - lnRin) +
          gauss(rand) * o.misalign;
        S.cp[i] = Math.cos(psi); S.sp[i] = Math.sin(psi);
        S.om[i] = o.speed * Math.pow(Math.max(r, o.rIn) / o.rIn, -o.shear);
        S.M[i] = phi;
        S.sz[i] = sz;
        S.al[i] = al;
        S.ci[i] = ci & 7;
        S.twp[i] = rand() * TAU;
        S.twr[i] = 0.35 + rand() * 2.6;
        S.fl[i] = (sz > 2.9 && rand() < o.flares * 60) ? 1 : 0;
      }
    }

    function resize(w, h, dpr) {
      dpr = dpr || 1;
      // dpr ограничиваем: на 3x-телефонах 26k спрайтов x 3 = гарантированный дроп
      dpr = Math.min(dpr, 2);
      S.w = w; S.h = h; S.dpr = dpr;
      S.R = Math.min(w, h * 0.62) * 0.5 * 2.05;   // R: широкая спираль, влезает по высоте
      S.cx = w * 0.5; S.cy = h * 0.5;
      var sc = S.R * dpr;
      var cPA = Math.cos(o.pa), sPA = Math.sin(o.pa);
      // screen = c + sc * [ [cPA, -sPA*flat], [sPA, cPA*flat] ] * (X, Y)
      S.mA = sc * cPA; S.mB = sc * sPA;
      S.mC = -sc * sPA * o.flat; S.mD = sc * cPA * o.flat;
      S.ox = S.cx * dpr; S.oy = S.cy * dpr;
      populate(w, h, dpr);
    }

    /* --- кадр: только звёзды. Никаких глобальных трансформаций! --- */
    function frame(ctx, dt) {
      var o2 = S.o;
      S.t += dt;
      var w = S.w * S.dpr, h = S.h * S.dpr;
      var t = S.t;

      if (o2.trail > 0) {
        // шлейф: старое гасим destination-out (а не полупрозрачным «чёрным»,
        // иначе через 2 секунды диск поплывёт в грязно-серый)
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = 1;
        ctx.fillStyle = 'rgba(0,0,0,' + (1 - Math.pow(1 - clamp(o2.trail, 0, 0.6), 1)) + ')';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalCompositeOperation = 'copy';
        ctx.clearRect(0, 0, w, h);
        ctx.restore();
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';   // аддитивная сборка: ядро само раздуется
      var mA = S.mA, mB = S.mB, mC = S.mC, mD = S.mD, ox = S.ox, oy = S.oy;
      var n = S.n, M = S.M, om = S.om, ax = S.ax, b = S.b, cp = S.cp, sp = S.sp;
      var sz = S.sz, al = S.al, ci = S.ci, twp = S.twp, twr = S.twr, fl = S.fl;
      var gain = o2.armGain, damp = o2.dustAmp, dw = o2.dustW, sh = o2.dustShift;
      var invArm = o2.arms / TAU, bright = o2.bright * o2.exposure;
      var twa = o2.twinkle, ps = o2.patternSpeed, tnow = t;
      var rEdge = o2.rOut, k1 = 1 / (2 * 0.14 * 0.14), k2 = 1 / (2 * dw * dw);
      var atlas = S.atlas, flar = S.flare, SPRc = SPR, FLRc = FLR;
      var drift = ps * t;   // сдвиг поля яркости (pattern speed). 0 => поле стоит.

      for (var i = 0; i < n; i++) {
        var m = M[i] + om[i] * dt;
        if (m > TAU) m -= TAU;
        M[i] = m;

        var sM = Math.sin(m), cM = Math.cos(m);
        var e = 1 - b[i] / ax[i];
        // Э = M + e sin M — одна итерация Кеплера. Даёт замедление у apsides,
        // то есть естественное загущение именно там, где огибающая.
        var dd = e * sM;
        var cd = 1 - dd * dd * 0.5, sd = dd * (1 - dd * dd / 6);
        var ex = cM * cd - sM * sd;          // cos E
        var ey = sM * cd + cM * sd;          // sin E
        var x = ax[i] * ex, y = b[i] * ey;
        var X = x * cp[i] - y * sp[i];
        var Y = x * sp[i] + y * cp[i];

        var r2 = X * X + Y * Y;
        // ФЕЙД НА ГРАНИЦЕ (перый из двух): радиус в единицах диска
        var rho = Math.sqrt(r2);
        var edge = smoothstep(rEdge * 1.0, rEdge * 0.60, rho);
        if (edge <= 0.002) continue;
        edge *= 0.06 + 0.94 * smoothstep(0.0, rEdge * 0.16, rho);  // чуть глушим самый центр

        // поле шаблона: смещение от ближайшего рукава (стоит на месте)
        var th = Math.atan2(Y, X);
        var q = (th - A * (0.5 * Math.log(r2) - lnRin) - o2.psi0) * invArm - drift;
        var pph = q - Math.round(q);
        var arm = Math.exp(-pph * pph * k1);
        var dp = pph - sh;
        // пыль живёт в диске (0.2R..1R): в балдже полос не бывает
        var dgate = smoothstep(0.14, 0.34, rho) * edge;
        var dust = Math.exp(-dp * dp * k2) * dgate;

        var lum = (1 + gain * arm) * (1 - damp * dust) * bright;
        lum *= edge;
        if (lum <= 0.004) continue;
        lum *= 1 + twa * Math.sin(tnow * twr[i] + twp[i]);
        if (lum <= 0.004) continue;

        // проекция: наклон (flat) + position angle. Только для координат.
        var px = ox + mA * X + mC * Y;
        var py = oy + mB * X + mD * Y;
        var s = sz[i] * S.R * 0.0042 * (1 + 0.45 * arm);
        if (s < 0.6) s = 0.6;
        ctx.globalAlpha = clamp(lum, 0, 1);
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

    /* --- слой дымки: рисуется ОДИН РАЗ. Статичен, как и положено шаблону. --- */
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
      var cPA = Math.cos(o.pa), sPA = Math.sin(o.pa);
      ctx.setTransform(sc * cPA, sc * sPA, -sc * sPA * o.flat, sc * cPA * o.flat, cx, cy);

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

      // 3) сами рукава: идём по логоспирали и ставим мягкие пятна.
      //    Это тот же закон, что у орбит (A·ln r), поэтому дымка совпадает со
      //    скоплением звёзд «в руку» — при любой кратности и pitch.
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
       логоспираль. проекция вручную, чтобы линия осталась 1 px (иначе матрица
       масштабирования раздувает штрих до сотен пикселей). */
    function debug(ctx, mode) {
      var w = S.w, h = S.h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);
      var k = 1 / S.dpr;
      function pt(X, Y) {
        return [ (S.ox + S.mA * X + S.mC * Y) * k, (S.oy + S.mB * X + S.mD * Y) * k ];
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
      // точки сборки (periapsis) — куда стекаются звёзды: та же кривая
      ctx.fillStyle = 'rgba(255,220,140,.85)';
      for (var j = 0; j < S.n; j += 7) {
        var c4 = S.cp[j], d4 = S.sp[j], b4 = S.b[j];
        var p4 = pt(b4 * c4, b4 * d4);
        ctx.fillRect(p4[0] - 1, p4[1] - 1, 2, 2);
      }
    }

    return {
      state: S, opts: o,
      resize: resize, frame: frame, nebula: nebula, debug: debug,
      set: function (patch) {
        for (var kk in patch) {
          if (!(kk in o)) continue;
          o[kk] = patch[kk];
        }
        if (S.w) resize(S.w, S.h, S.dpr);
      }
    };
  }

  /* ---------- DOM-обвязка ---------- */
  function mount(host, userOpts) {
    if (!host) return null;
    var g = create(userOpts);
    var o = g.opts;

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

    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(layout); ro.observe(host); }
    window.addEventListener('resize', layout);
    document.addEventListener('visibilitychange', function () {
      visible = !document.hidden;
      if (visible) play(); else stop();
    });

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
        if (ro) ro.disconnect();
        rootEl.remove();
      }
    };
  }

  return {
    VERSION: '1.0',
    create: create, mount: mount,
    defaults: defaults, PALETTES: PALETTES
  };
});
