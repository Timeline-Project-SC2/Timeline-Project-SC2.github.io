# Как устроен репозиторий

> Источник: `docs/HANDOFF.md`, строки 382–424 (редакция до разукрупнения).
> Назад: [конспект](../HANDOFF.md) · [этапы](../stages/README.md) · [документация](../README.md).

## 2. Как устроен репозиторий

```
site/                  ← вход Vite-сборки; публикуется собранная .publish/
├── index.html         карта галактики, открывается по /
├── galaxy.ts  galaxy.css
├── sector/sector.html   вариант-вход атласа (общая разметка — templates/atlas-shell.html)
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

- Все внутренние ссылки от корня сайта: `/shared/…`, `/sector/sector.html`, `/data/…`, `/assets/…`.
- Деплой: `pages.yml` → `setup-python` (3.12) → Pillow из `tools/requirements.txt` → `tools/build_assets.py` →
  `setup-node` → `npm ci` → `npm run build` (Vite собирает маршруты, hashed JS/CSS/worker, `data/` и
  `assets/` минус `assets/src` в `.publish`, пишет `build-manifest.json`) → `npm run verify:publish`
  → `npm run verify:contract` → `upload-pages-artifact`.
- Проверка PR: `check.yml` — те же шаги сборки на `ubuntu-24.04` и `ubuntu-26.04` плюс
  `node --check` и ESLint (`no-undef`), без публикации.
- **Pages настроен как GitHub Actions** (пользователь переключил в Settings). Если вернуть
  «Deploy from a branch», публиковаться будет корень репозитория через Jekyll и всё сломается.
- Данные: `tools/sync.py` каждые 6 ч тянет включённые листы одной опубликованной книги Google Sheets из `data/sources.json` (`systems`, `places`, `planet_generation`; вкладка выбирается `gid`). Workflow чекаутит `main`, поэтому источник из PR начнёт применяться после merge. URL-листы проверяются все вместе до атомарной замены снимков.
