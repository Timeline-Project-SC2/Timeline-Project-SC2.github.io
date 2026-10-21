/* LagFx — эффект «лага» для любой картинки: помехи в духе старого монитора.
   Отдельный модуль без привязки к странице: работает с одной <img>, остальное
   задаётся настройками. На карте галактики подключён из galaxy.js.

   ЧТО ДЕЛАЕТ
   1. «Лаги» (tear): горизонтальные полосы картинки рывками съезжают влево-вправо
      короткими всплесками.
   2. Волна (wave): быстрый проход деформации сверху вниз, как у ретро-телевизора.
      Всплеск — это «лаги», волна или оба сразу (выбирается случайно).
   3. Линии-преломления (sweep): две тонкие полосы идут сверху вниз одна за другой;
      строки внутри полосы сдвинуты вправо на несколько пикселей, края резкие.
   Всплески и линии сами повторяются через случайные паузы.

   КАК УСТРОЕНО
   Сразу после картинки вставляется слой .lag-fx из N полос. Каждая полоса — блок
   с той же картинкой фоном (background-image), показывающий свою горизонтальную
   полоску; эффект — это сдвиг полос через transform. Пиксели картинки не читаются,
   поэтому файл может лежать на другом домене. В покое слой скрыт (display: none)
   и ничего не стоит; картинка полос берётся в момент запуска (img.currentSrc —
   тот файл, что сейчас выбран из srcset), поэтому полосы не мутнее самой картинки.

   ПОДКЛЮЧЕНИЕ
   1. Разметка: картинка должна занимать весь свой позиционированный контейнер
      (position: relative / absolute) и быть растянута на него целиком — как
      #galaxyMap внутри #mapLayer. Слой эффекта ложится на контейнер (inset: 0).
      Для отдельной картинки достаточно обёртки:
        <div style="position: relative; display: inline-block">
          <img id="pic" src="…" style="display: block; width: 100%; height: 100%">
        </div>
   2. Скрипт — до того кода, который вызывает LagFx:
        <script src="/shared/lag-fx.js" defer></script>
   3. Запуск:
        var lag = LagFx.attach(document.getElementById('pic'), {
          busy: function () { return document.body.classList.contains('is-busy'); }
        });
      Всё. Эффекты пойдут сами, первый — через 4–9 с.
   4. Стили не нужны: всё необходимое модуль ставит инлайном. Слой — класс .lag-fx,
      полосы — .lag-fx-band (на случай, если захочется что-то донастроить из CSS).

   НАСТРОЙКИ (второй аргумент attach, все необязательны; значения по умолчанию — в DEFAULTS)
     busy       () → bool — «сейчас нельзя»: пока true, новые эффекты не стартуют,
                а идущий гаснет (переходы, анимации камеры). Проверяется на каждом
                кадре и перед каждым запуском. Скрытая вкладка — busy всегда.
     src        () → адрес картинки для полос; по умолчанию img.currentSrc || src
     autoplay   false — ничего не планировать самому, только burst() / sweep() вручную
     bands      число полос (240: тонкая линия ≈ 0.4 % высоты картинки на полосу)
     zIndex     z-index слоя (по умолчанию не задан — слой просто идёт после картинки)
     gap        [мин, макс] — пауза между всплесками, мс
     tear       { group, step, chance, min, max, ms: [мин, макс] } —
                полос в группе, мс между перетасовками, доля съехавших групп,
                сдвиг в % ширины, длительность всплеска
     wave       { ms, half, amp } — проход волны, ширина фронта (доля высоты), амплитуда (% ширины)
     sweep      { gap: [мин, макс], ms, lag, edge, half, amp } — пауза между парами линий,
                проход одной линии, отставание второй, вылет за края, полутолщина
                (доля высоты), сдвиг строк (% ширины)
     mix        доли всплесков: { tear: 0.4, wave: 0.3 } — остальное «оба сразу»

   УПРАВЛЕНИЕ (attach возвращает объект)
     burst(kind)  запустить всплеск сейчас: 'tear' | 'wave' | 'both' (без аргумента — случайно)
     sweep()      запустить пару линий сейчас
     pause()      остановить всё и не планировать новое; resume() — продолжить
     destroy()    убрать слой и таймеры
     active()     true, пока что-то идёт

   prefers-reduced-motion: эффекты не запускаются, attach возвращает заглушку с теми
   же методами — вызывающему коду проверять ничего не нужно. */

export type LagFxBurstKind = 'tear' | 'wave' | 'both';
export type LagFxRange = readonly [number, number];

export interface LagFxConfig {
  readonly bands: number;
  readonly gap: LagFxRange;
  readonly mix: { readonly tear: number; readonly wave: number };
  readonly tear: {
    readonly group: number;
    readonly step: number;
    readonly chance: number;
    readonly min: number;
    readonly max: number;
    readonly ms: LagFxRange;
  };
  readonly wave: { readonly ms: number; readonly half: number; readonly amp: number };
  readonly sweep: {
    readonly gap: LagFxRange;
    readonly ms: number;
    readonly lag: number;
    readonly edge: number;
    readonly half: number;
    readonly amp: number;
  };
}

export interface LagFxOptions {
  readonly busy?: () => boolean;
  readonly src?: () => string;
  readonly autoplay?: boolean;
  readonly zIndex?: number | string;
  readonly bands?: number;
  readonly gap?: LagFxRange;
  readonly mix?: Partial<LagFxConfig['mix']>;
  readonly tear?: Partial<LagFxConfig['tear']>;
  readonly wave?: Partial<LagFxConfig['wave']>;
  readonly sweep?: Partial<LagFxConfig['sweep']>;
}

export interface LagFxController {
  burst(kind?: LagFxBurstKind): void;
  sweep(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  active(): boolean;
}

export interface LagFxApi {
  attach(img: HTMLImageElement | null | undefined, options?: LagFxOptions): LagFxController;
  readonly defaults: LagFxConfig;
}

declare global {
  interface Window {
    LagFx: LagFxApi;
  }
}

(function (global: Window) {
  'use strict';

  var DEFAULTS: LagFxConfig = {
    bands: 240,
    gap: [4000, 9000],
    mix: { tear: 0.4, wave: 0.3 },
    tear: { group: 2, step: 80, chance: 0.3, min: 1, max: 2.5, ms: [380, 620] },
    wave: { ms: 1400, half: 0.2, amp: 1.6 },
    sweep: { gap: [9000, 14000], ms: 10000, lag: 1600, edge: 0.05, half: 0.004, amp: 0.45 }
  };

  function mergeValues(
    base: Readonly<Record<string, unknown>>,
    over: Readonly<Record<string, unknown>> | undefined,
  ): Record<string, unknown> {
    var out: Record<string, unknown> = {};
    Object.keys(base).forEach(function (k) {
      var b = base[k], o = over ? over[k] : undefined;
      if (b && typeof b === 'object' && !Array.isArray(b)) {
        out[k] = mergeValues(
          b as Readonly<Record<string, unknown>>,
          o as Readonly<Record<string, unknown>> | undefined,
        );
      } else out[k] = o === undefined ? b : o;
    });
    return out;
  }

  function merge(base: LagFxConfig, over: LagFxOptions): LagFxConfig {
    return mergeValues(
      base as unknown as Readonly<Record<string, unknown>>,
      over as Readonly<Record<string, unknown>>,
    ) as unknown as LagFxConfig;
  }

  function rand(a: number, b: number): number { return a + Math.random() * (b - a); }

  var NOOP: LagFxController = {
    burst: function () {}, sweep: function () {}, pause: function () {}, resume: function () {},
    destroy: function () {}, active: function () { return false; }
  };

  function attach(img: HTMLImageElement | null | undefined, options?: LagFxOptions): LagFxController {
    if (!img || !img.parentNode) return NOOP;
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) return NOOP;

    var opt = options || {};
    var cfg: LagFxConfig = merge(DEFAULTS, opt);
    var N = Math.max(8, cfg.bands | 0);
    var G = Math.max(1, cfg.tear.group | 0);
    var userBusy = typeof opt.busy === 'function' ? opt.busy : function () { return false; };
    var getSrc = typeof opt.src === 'function' ? opt.src : function () { return img.currentSrc || img.getAttribute('src') || ''; };
    var autoplay = opt.autoplay !== false;

    // Слой полос: каждая полоса показывает свой кусок картинки на весь размер контейнера
    var layer = document.createElement('div');
    layer.className = 'lag-fx';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;display:none;';
    if (opt.zIndex != null) layer.style.zIndex = String(opt.zIndex);
    var bands: HTMLDivElement[] = [];
    var tearDx: number[] = [];
    for (var i = 0; i < N; i++) {
      var band = document.createElement('div');
      band.className = 'lag-fx-band';
      band.style.cssText = 'position:absolute;left:0;width:100%;background-repeat:no-repeat;pointer-events:none;will-change:transform;';
      band.style.top = (i * 100 / N) + '%';
      band.style.height = (100 / N) + '%';
      band.style.backgroundSize = '100% ' + (N * 100) + '%';
      band.style.backgroundPosition = '0 ' + (i * 100 / (N - 1)) + '%';
      layer.appendChild(band);
      bands.push(band);
      tearDx.push(0);
    }
    img.insertAdjacentElement('afterend', layer);

    var bandSrc = '';
    function syncSrc() {
      var cur = getSrc();
      if (!cur || cur === bandSrc) return;
      bandSrc = cur;
      var css = 'url("' + String(cur).replace(/"/g, '%22') + '")';
      for (var k = 0; k < N; k++) bands[k]!.style.backgroundImage = css;
    }

    var burst: { kind: LagFxBurstKind; start: number; dur: number } | null = null;
    var sweeps: Array<{ start: number }> = [];
    var raf = 0;
    var timerBurst = 0;
    var timerSweep = 0;
    var lastTear = 0;
    var paused = false;
    var dead = false;

    function busy() { return document.hidden || paused || dead || !!userBusy(); }

    function clearBands() {
      for (var k = 0; k < N; k++) bands[k]!.style.transform = '';
    }

    function stopAll() {
      if (raf) global.cancelAnimationFrame(raf);
      raf = 0;
      burst = null;
      sweeps = [];
      layer.style.display = 'none';
      clearBands();
    }

    function run() {
      syncSrc();
      layer.style.display = 'block';
      if (!raf) raf = global.requestAnimationFrame(tick);
    }

    function pickKind() {
      var r = Math.random();
      if (r < cfg.mix.tear) return 'tear';
      if (r < cfg.mix.tear + cfg.mix.wave) return 'wave';
      return 'both';
    }

    function startBurst(kind?: string): void {
      if (burst || busy()) return;
      var burstKind: LagFxBurstKind = kind === 'tear' || kind === 'wave' || kind === 'both'
        ? kind
        : pickKind();
      burst = {
        kind: burstKind,
        start: global.performance.now(),
        dur: burstKind === 'tear' ? rand(cfg.tear.ms[0], cfg.tear.ms[1]) : cfg.wave.ms
      };
      lastTear = 0;
      run();
    }

    // Пара линий: первая стартует сейчас, вторая — с отставанием sweep.lag
    function startSweeps() {
      if (sweeps.length || busy()) return;
      var now = global.performance.now();
      sweeps.push({ start: now });
      sweeps.push({ start: now + cfg.sweep.lag });
      run();
    }

    function scheduleBurst() {
      global.clearTimeout(timerBurst);
      if (!autoplay || dead) return;
      timerBurst = global.setTimeout(function () {
        if (busy() || burst) { scheduleBurst(); return; }
        startBurst();
      }, rand(cfg.gap[0], cfg.gap[1]));
    }

    function scheduleSweep() {
      global.clearTimeout(timerSweep);
      if (!autoplay || dead) return;
      timerSweep = global.setTimeout(function () {
        if (busy() || sweeps.length) { scheduleSweep(); return; }
        startSweeps();
      }, rand(cfg.sweep.gap[0], cfg.sweep.gap[1]));
    }

    function tick(now: number): void {
      raf = 0;
      if (busy()) {
        // переход или пауза: гасим сразу, следующий запуск — по расписанию
        stopAll();
        scheduleBurst();
        scheduleSweep();
        return;
      }

      var tear = false;
      var wave = false;
      var waveFront = 0;
      var W = cfg.wave;
      if (burst) {
        var t = now - burst.start;
        if (t >= burst.dur) {
          burst = null;
          scheduleBurst();
        } else {
          tear = burst.kind !== 'wave';
          wave = burst.kind !== 'tear';
          waveFront = -W.half + (1 + 2 * W.half) * Math.min(t / W.ms, 1);
          if (tear && now - lastTear >= cfg.tear.step) {
            lastTear = now;
            // группы по G полос съезжают вместе: зернистость «лагов»
            for (var k = 0; k < N; k += G) {
              var v = Math.random() < cfg.tear.chance
                ? (Math.random() < 0.5 ? -1 : 1) * rand(cfg.tear.min, cfg.tear.max)
                : 0;
              for (var g = 0; g < G && k + g < N; g++) tearDx[k + g] = v;
            }
          }
        }
      }

      // Линии: фронты активных (уже стартовавших) линий
      var S = cfg.sweep;
      var fronts: number[] = [];
      var sweepEnded = false;
      for (var q = sweeps.length - 1; q >= 0; q--) {
        var s = (now - sweeps[q]!.start) / S.ms;
        if (s >= 1) {
          sweeps.splice(q, 1);
          sweepEnded = true;
        } else if (s >= 0) {
          fronts.push(-S.edge + (1 + 2 * S.edge) * s);
        }
      }
      // пауза до следующей пары — от окончания предыдущей
      if (sweepEnded && !sweeps.length) scheduleSweep();

      if (!burst && !sweeps.length) { stopAll(); return; }

      for (var j = 0; j < N; j++) {
        var c = (j + 0.5) / N;
        var dx = tear ? tearDx[j]! : 0;
        if (wave) {
          var d = (c - waveFront) / W.half;
          if (Math.abs(d) < 1.6) dx += W.amp * Math.exp(-d * d) * Math.sin(d * Math.PI * 2);
        }
        for (var f = 0; f < fronts.length; f++) {
          if (Math.abs(c - fronts[f]!) < S.half) { dx += S.amp; break; }
        }
        bands[j]!.style.transform = dx ? 'translate3d(' + dx.toFixed(2) + '%,0,0)' : '';
      }
      raf = global.requestAnimationFrame(tick);
    }

    scheduleBurst();
    scheduleSweep();

    return {
      burst: function (kind?: LagFxBurstKind) { startBurst(kind); },
      sweep: function () { startSweeps(); },
      pause: function () { paused = true; stopAll(); },
      resume: function () {
        if (!paused) return;
        paused = false;
        scheduleBurst();
        scheduleSweep();
      },
      destroy: function () {
        dead = true;
        stopAll();
        global.clearTimeout(timerBurst);
        global.clearTimeout(timerSweep);
        if (layer.parentNode) layer.parentNode.removeChild(layer);
      },
      active: function () { return !!(burst || sweeps.length); }
    };
  }

  global.LagFx = { attach: attach, defaults: DEFAULTS };
})(window);
