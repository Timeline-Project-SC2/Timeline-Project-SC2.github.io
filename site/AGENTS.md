# Доменные правила `site/` (Браузерный рантайм, маршруты и эффекты)

Настоящий документ — источник истины (SSoT) для директории `site/`.
Общие правила репозитория, команды сборки/проверки и протокол коммитов описаны
в корневом [`../AGENTS.md`](../AGENTS.md) и здесь не дублируются.

---

## 1. Браузерный рантайм маршрутов (`site/`)

- `/` (`site/index.html`, `site/galaxy.ts`, `site/galaxy.css`) — карта галактики:
  - Координаты маркеров и прямоугольников `data-frame` задаются в **процентах исходной карты**;
    перевод в экранные координаты выполняется только через `boxOf`, `frameData`, `frameOf`
    в `site/galaxy.ts` (не смешивать проценты карты, CSS-пиксели и экранные пиксели).
  - Тайминги в `CONFIG` (`site/galaxy.ts`) разделены на независимые переменные:
    первый клик — `focusMs` (центрирование), `focusZoomDelay` (пауза 1 с), `focusZoomMs`
    (приближение после центрирования), `focusZoomOutMs` (немедленный отъезд, если зум выше цели);
    второй клик (переход в Копрулу) — `diveCenterMs`, `diveZoomDelay`, `diveZoomMs`, `diveZooms: [20]`.
- `/sector/` (`site/sector/sector.html`, `sector.css`) и `/minimal/` (`site/minimal/minimal.html`, `minimal-skin.css`):
  - Тонкие входы вариантов атласа поверх `templates/atlas-shell.html`; индикатор координат X/Y (`0..mapSize`) в `.map-controls` и `Shift+клик` существуют **только** в `/sector/`.
  - Карточка наведения `#detailPanel.is-preview` обязана иметь `pointer-events: none` (`syncDetailPreview`), чтобы система у правого края не мигала; в `places` маркер POI строится только при пустом `system_id` и валидных `x, y`.
- `/planet-globe/` (`site/planet-globe/index.html`, `planet-globe.ts`, `planet-globe-worker.ts`) — боевой WebGL2-глобус `planet-globe-v1` (`proxy -> final` через `uHide`/`uCenterGrow`, каскад `uBuild`, карточка `GlobePickInfo`, 2D-fallback).
- `/planet-test/` (`site/planet-test/index.html`, `planet-test.ts`, `planet-test.css`) — стенд FX-режимов Шакураса и 10-сек телеметрии (`p50/p95/p99`, `>50ms`, `>100ms`, `worst5`) тонкой обёрткой над `site/shared/planet-globe.ts`, `planet-globe-worker.ts` и `src/planet/planet-globe-fx.ts` (И-5).
- `/spiral-test/` (`site/spiral-test/`) и `/cursor-test/` (`site/cursor-test/`) — изолированные стенды отладки спирали галактики и системного курсора (ссылок из основного UI нет).

---

## 2. Общие модули `site/shared/*`

- `focus-fx.ts` (`window.FocusFx`) — canvas-эффект выбора и перехода:
  - На первом клике линии из-за краёв viewport строят борд по пересечению камеры и карты
    (`mapFrame`) и сжимают его до `data-frame`; рамка привязана к карте и плавно переезжает
    при смене области; слабые каналы и движущиеся блики остаются видимыми.
  - Переход в Копрулу (`start({ contour: true, ... })`) сжимает рамку точно по контуру квадрата
    (внешний край линии на контуре, без диагональных лучей) и проявляет превью внутри рамки.
    Цвет ОЗД до отказа — зелёный, как у Копрулу; при снятии выбора контур уходит против часовой стрелки.
- `lag-fx.ts` (`window.LagFx`) — полосы «лагов» из `map.currentSrc`; выключать во время `FocusFx`.
- `galaxy-spiral.ts` (`window.GalaxySpiral`) — спираль поверх карты (`GalaxySpiral.overlay`):
  - Холст располагается в `#mapLayer` строго после `#galaxyMap` и перед `.lag-fx` без `z-index`
    и без CSS-трансформаций; узор (`patternFromImage`) вычисляется по контрасту колец самой карты
    с вырезанием зелёного HUD и рамок CAM; при `prefers-reduced-motion` слой не создаётся.
- `cursor-fx.ts` (`window.CursorFx`) — системный курсор `cursor: url(...)` размером `<= 32×32` CSS px:
  - Точка клика стрелки и треугольников `(1, 1)`, крестовины `(15, 15)` со сдвигом в пределах `0..31`;
    покадровая смена `style` ставится **только** элементу под мышью (не на `html`/`body`).
  - Карты тащатся левой кнопкой и колесом, а щелчок — только левой (`button === 0`); правая и
    боковые кнопки (`event.button > 1`) отсекаются в `galaxy.ts`, `canvas-renderer.ts` и `cursor-fx.ts`.
- `geodesic-grid.ts`, `planet-noise.ts`, `planet-geography.ts`, `planet-surface.ts`, `planet-globe.ts`,
  `planet-generation-contract.ts`, `timeline-loader.ts`, `links.ts`, `travel-planner.ts` — общие модули
  планетарного рантайма, загрузчика и маршрутизации (инварианты И-1…И-6 — в [`../src/AGENTS.md`](../src/AGENTS.md)).

---

## 3. WebGL2, WebWorker, CSP и запрет на правку `site/assets/vendor/*`

- **WebWorker и GPU-стриминг:** расчёт сетки/поверхности и упаковка вершин (24 Б/вершину) идут в
  `planet-globe-worker.ts` (`WorkerMessage`/`WorkerResponse`, `Transferable`), а главный поток заливает
  GPU-бандлы порциями и обрабатывает `webglcontextlost`/`webglcontextrestored`.
- **CSP и бандлинг:** не использовать `eval`/`new Function` и ручные `?v=`; пути `new Worker(...)`
  и `importScripts(...)` автоматически переписываются сборщиком на контент-хэши из `build-manifest.json`.
- **Вендорные и сгенерированные ассеты:** категорически запрещено вручную редактировать файлы
  в `site/assets/vendor/*`, скомпилированные `.wasm` и сгенерированные тайлы `assets/tiles/*`.
