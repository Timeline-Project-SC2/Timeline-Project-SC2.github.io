# Карта репозитория, логика зума и проверки

> Назад: [документация](../README.md) · [шаг 0 консолидации](../consolidation/README.md)

Карта репозитория, логика прицела и зума и команды проверки изменений.

## Карта репозитория

### 2. Как устроен репозиторий

```
site/                  ← вход Vite-сборки; публикуется собранная .publish/
├── index.html         карта галактики, открывается по /
├── galaxy.ts  galaxy.css
├── sector/index.html    вариант-вход атласа (общая разметка — templates/atlas-shell.html)
├── minimal/minimal.html вариант-вход атласа + minimal-skin.css
├── cursor-test/       страница проверки курсора (/cursor-test/, ссылок с сайта нет)
├── spiral-test/       демо и настройка ядра спирали (/spiral-test/, ссылок с сайта нет)
├── planet-globe/      боевой стенд WebGL2-глобуса (planet-globe.ts, planet-globe-worker.ts, local-map-quick-nav.ts)
├── planet-test/       FX-стенд Шакураса тонкой обёрткой над боевым ядром (planet-test.ts)
└── shared/            links.ts, timeline-loader.ts, travel-planner.ts, focus-fx.ts, lag-fx.ts,
                       cursor-fx.ts, galaxy-spiral.ts, geodesic-grid.ts, planet-noise.ts,
                       planet-geography.ts, planet-surface.ts, planet-globe.ts,
                       planet-generation-contract.ts + все общие CSS
templates/atlas-shell.html общая разметка sector/minimal (варианты — src/atlas/atlas-variants.ts)
src/atlas/             модульный TypeScript атласа; app.ts публикуется как shared/app-<hash>.js
src/planet/            Wasm-ядра planet-core (assembly/kernels.ts, planet-core-host.ts) и planet-globe-fx.ts
src/local-map/         контракт сшивки 7 ячеек (local-map-contract.ts) и 4 модуля 3D-структур локальной карты
tools/vite/            модули сборки Vite (asset-utils.ts, atlas-shell.ts, timeline-publish-pipeline.ts с PublishPipelineState)
vite.config.mts, tsconfig.json, .nvmrc (24), .python-version (3.12) строгая TS-конфигурация и сборщик публикации .publish/
src/contracts/planet-generation-contract.json единый контракт planet_generation для Python и TS
AGENTS.md, site/AGENTS.md, src/AGENTS.md, tools/AGENTS.md иерархия инструкций агентов (Single Source of Truth)

data/                  CSV и JSON; пишут tools/sync.py и tools/build_assets.py;
                       planet-generation.csv — пока пустой снимок профилей Этапа 2
assets/src/            ИСХОДНИКИ картинок (в Git, в веб не публикуются)
assets/                собранные тайлы и WebP (Git-ignored, собираются при деплое)
docs/, tools/, .github/ — служебное
```

- Все внутренние ссылки от корня сайта: `/shared/…`, `/sector/`, `/data/…`, `/assets/…`.
- Деплой: `pages.yml` → `setup-python` (3.12) → Pillow из `tools/requirements.txt` → `tools/build_assets.py` →
  `setup-node` → `npm ci` → `npm run build` (Vite собирает маршруты, hashed JS/CSS/worker, `data/` и
  `assets/` минус `assets/src` в `.publish`, пишет `build-manifest.json`) → `npm run verify:publish`
  → `npm run verify:contract` → `upload-pages-artifact`.
- Проверка PR: `check.yml` — те же шаги сборки на `ubuntu-24.04` и `ubuntu-26.04` плюс
  `node --check` и ESLint (`no-undef`), без публикации.
- **Pages настроен как GitHub Actions** (пользователь переключил в Settings). Если вернуть
  «Deploy from a branch», публиковаться будет корень репозитория через Jekyll и всё сломается.
- Данные: `tools/sync.py` каждые 6 ч тянет включённые листы одной опубликованной книги Google Sheets из `data/sources.json` (`systems`, `places`, `planet_generation`; вкладка выбирается `gid`). Workflow чекаутит `main`, поэтому источник из PR начнёт применяться после merge. URL-листы проверяются все вместе до атомарной замены снимков.

## Логика зума и прицела

### 6. Прицел: выбор и переход (актуальная логика)

Прицел в духе брифингов StarCraft II: полая рамка, каналы и текущие энергетические
импульсы. Анимация — в `site/shared/focus-fx.js` (`window.FocusFx`), логика карты — в
`galaxy.js`.

- **Первый клик по области**: четыре линии входят из-за границ viewport и строят борд по
  пересечению камеры с картой (`mapFrame`): границы камеры там, где карта продолжается за кадр,
  реальные края карты — где они видны. Борд сжимается до `data-frame`, камера во время этого
  не двигается. Если текущий зум строго выше целевого для области, сразу начинается отъезд до
  целевого масштаба, затем камера центрирует область; если зум ниже цели, она сначала
  центрируется на прежнем масштабе, ждёт 1 с и отдельно приближает, а при равном масштабе
  только центрирует. Рамка следует координатам карты при ручном и
  программном панорамировании/зуме.
  Цвета: Копрулу и ОЗД зелёные, Зерус красный; до отказа ОЗД тоже зелёный.
- **Смена области** — уже нарисованная рамка плавно переезжает к новому `data-frame`, без
  сброса/повторного появления; камера затем центрирует область, ждёт 1 с и отдельно приближает.
- **Снятие выбора** (крестик, Esc, клик по пустому месту) — линии втягиваются, рамка гаснет.
- **Переход в Копрулу** (второй клик или «ОТКРЫТЬ КАРТУ») — вторая ступень того же
  приближения, что при первом клике, и выглядит так же (`FocusFx.start({ contour: true, … })`):
  рамка области за `T.contract` сжимается по контуру квадрата — как борд до области при выборе,
  с теми же каналами от краёв сцены и бликами; внешний край линии ложится на контур квадрата.
  Затем камера центрирует квадрат (`CONFIG.diveCenterMs`), ждёт `diveZoomDelay` и одним шагом
  приближает до 2000 % (`diveZooms: [20]`, `diveZoomMs`; `easeOutCubic`, масштаб линейно —
  как `animateTo` у выбора). Длительности перехода свои, от первого клика не зависят; сейчас
  такие же (520 / 1000 / 650). Рамка всё время держится за квадрат и растёт вместе с картой. В
  последние `T.reveal` мс приближения внутри рамки проявляется превью, карта вокруг темнеет;
  после `T.still` — страница сектора. Всего ≈2,9 с (раньше было ≈4,4 с: 1200 % и 2000 %).
  Диагональных лучей к цели и раскрытия рамки к краям здесь больше нет.
- **Переход Зеруса и ОЗД** (прежний сценарий): рамка сужается до рамки захвата и захватывает
  квадрат, камера переводит цель в центр. Зерус после паузы 1 с приближается до 800 % и срывает
  захват; ОЗД отказывает, отъезжает до 100 % и печатает строки отказа. После них выбор сброшен —
  следующий клик снова первый.
- **Размеры.** `mapFrame`, квадрат (`boxOf`) и область (`frameOf`) передаются в экранных
  координатах и пересчитываются по карте; рамка остаётся привязана к карте. В переходе Копрулу
  рамка — сам квадрат `boxOf` каждый кадр, поэтому она синхронна с программным зумом камеры.

| Файл | Что там |
|---|---|
| `site/shared/focus-fx.ts` | анимация: в начале файла — этапы, подключение и договорённость о камере; `T` — длительности, `G` — геометрия. API: `select({stage, target, frame, mapFrame, onLock, onContract})`, `release(done)`, `start({stage, target, frame, camera, contour, mapFrame, timing, zooms, ending, preview, onLock, onZoom, onCenter, onDeny, onEnd})`, `active()`, `refresh()`, `stop()`. Слои (затемнение, холст, превью) ставит сам |
| `site/shared/lag-fx.ts` | «лаги» картинки: `LagFx.attach(img, {busy, …})` → `burst()`, `sweep()`, `pause()`, `resume()`, `destroy()`; настройки — `LagFx.defaults` |
| `site/shared/galaxy-spiral.ts` | спираль: `create` (ядро: `resize`/`view`/`populate`/`frame`/`set`), `mount` (демо `/spiral-test/`), `overlay` (слой на карте: холст в % слоя, узор `patternFromImage`, 30 кадров в покое, без слоя при «уменьшении движения») |
| `site/galaxy.ts` | `CONFIG`: тайминг первого клика (`focusMs`, `focusZoomDelay`, `focusZoomMs` — приближение после центрирования, `focusZoomOutMs`), `focusZoom`, `framePad`, `frameMinVisible`, переход (`diveCenterMs`, `diveZoomDelay`, `diveZoomMs`, `diveZooms: [20]`), спираль поверх карты (`CONFIG.spiral` → `GalaxySpiral.overlay`), `camera` (get / set вида для модуля), `boxOf` / `frameData` / `frameOf`, `selectArea`, `hidePanel` / `closePanel` / `clearAreas`, `focusArea`, `runTransition` / `runZerusTransition` / `runOdzTransition`, сброс при возврате «Назад» (bfcache); `LagFx.attach` молчит на время перехода; `sharpenMap` — чёткость карты при приближении |
| `src/atlas/coords-readout.ts` и вариант `sector` в `templates/atlas-shell.html` | отключаемый readout координат курсора только на карте сектора; использует `toWorld()` и `mapSize()`, по умолчанию выключен и скрывается вне карты. Shift+клик копирует X и Y через табуляцию для вставки в два столбца; в minimal-скине кнопки readout нет, обработчик копирования работает условно на секторной карте |
| `site/sector/sector.css` | оформление секторного readout координат, подключается только на карте сектора |
| `site/index.html` | у квадратов `data-frame="л в п н"` — блок области в % карты (с полем ≈ 0.9 %); когда картинки и надписи станут отдельными элементами сайта, рамку можно считать от них |
| `site/galaxy.css` | цвета прицела CSS-переменными `--focus-core/-light/-shadow/-glow` и `--focus-dim` на `.galaxy-stage`, `.is-red-target`, `.is-odz-ping` |

После правок ручных `?v=` не поднимать и не добавлять: Vite-сборка сама даёт каждому
JS/CSS/worker файлу публикации имя с контент-хэшем и переписывает подключения страниц и
`importScripts`/`new Worker(...)`. Соответствие исходников и файлов публикации проверяется по
`.publish/build-manifest.json` и `tools/verify_feature_parity.mjs`.

## Как проверять изменения

### 8. Как проверять изменения

То же самое в каждом PR делает `.github/workflows/check.yml` (`actions/setup-node@v6` с `.nvmrc=24` и
`actions/setup-python@v6` с `.python-version=3.12`, сборка на Ubuntu 24.04 и 26.04, `npm run typecheck`, `npm run lint`, тесты). Локально:

```bash
npm ci                                          # единый package-lock.json (Vite, TS 7, ESLint, AssemblyScript)
npm run typecheck                               # tsc --noEmit
npm run lint                                    # eslint site src
npm run build                                   # tsc --noEmit + Vite (tools/vite/*) -> .publish/
npm run verify:publish                          # маршруты, manifest, hashed-ассеты и паритет экспортов
npm run verify:contract                         # Python ↔ TypeScript: пресеты, манифест, PG1 и оба формата approved_at
npm test                                        # текущий main: все 11 тестовых файлов Node (--test, 105 тестов)
npm run test:py                                 # Python unittest (test_planet_generation.py, test_sync.py)
python3 tools/sync.py --strict                  # строгая валидация CSV, координат 0..mapSize, places и дублей ID
python3 tools/build_assets.py --check           # свежесть собранных картинок
python3 tools/planet_generation.py validate     # снимок профилей против places
node tools/bench_local_map_stage8.mjs           # CPU-гейт G4 локальной карты (v=64 и --v=128)

# предпросмотр: .publish уже собрана как при деплое
python3 -m http.server 8080 --bind 0.0.0.0 --directory .publish

cd /home/user/smoke2 && node run.js             # прогон трёх страниц на данных из CSV
```

Курсор (`cursor-fx.ts`) в headless-браузере не виден, а `matchMedia('(any-pointer: fine)')`
там ложно — модуль не включается. Для проверок подменяйте `matchMedia` до загрузки страницы
(`page.evaluateOnNewDocument`) и сверяйте вычисленный `getComputedStyle(el).cursor` по
состояниям, смены `style` у элемента под мышью (MutationObserver) и `CursorFx.info()` /
`CursorFx.frames()`. Стоимость — CDP `Performance.getMetrics` (`TaskDuration`,
`RecalcStyleDuration`) с курсором и с `?cursor=off`. Учтите, что `?cursor=off` запоминается:
следующую страницу открывайте с `?cursor=auto`.
