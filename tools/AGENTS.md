# Доменные правила `tools/` (Синхронизация, валидаторы, бенчмарки и сборка Vite)

Настоящий документ — источник истины (SSoT) для директории `tools/`.
Общие правила репозитория, команды запуска и протокол коммитов описаны
в корневом [`../AGENTS.md`](../AGENTS.md) и здесь не дублируются.

---

## 1. Скрипты синхронизации и валидации (`tools/sync.py`, `tools/planet_generation.py`)

- `tools/sync.py` управляет двухфазной синхронизацией таблиц `systems`, `places`, `planet_generation`
  из опубликованной книги Google Sheets (`data/sources.json`):
  - **Двухфазная атомарность:** все включённые CSV сначала скачиваются и проходят перекрёстную
    проверку в памяти (включая валидацию `planet_generation` против новой версии `places`),
    и только после успеха снимки `data/*.csv`, `data/meta.json` и манифест заменяются атомарно
    с полным откатом при сбое.
  - **Безопасность токена:** заголовок `Authorization` с `GITHUB_TOKEN` прикрепляется через
    `req.add_unredirected_header(...)` только к `api.github.com` и `raw.githubusercontent.com`
    и никогда не уходит в `url`-источники Google Sheets или при HTTP-редиректах.
  - **Строгий режим (`python3 tools/sync.py --strict`):** мягкий режим по умолчанию сохранён для
    обратной совместимости, а с флагом `--strict` скрипт завершается с ненулевым кодом при:
    1) нечисловых координатах `x, y` или выходе за пределы `0 <= x, y <= mapSize`;
    2) конфликте одновременного указания `system_id` и ручных координат `x, y` в таблице `places`;
    3) дубликатах непустых `id` в любой из таблиц (`systems`, `places`, `planet_generation`).
  - **Диагностика HTML вместо CSV (`looks_like_html`):** при получении HTML-страницы входа или
    предпросмотра Google Sheets вместо CSV синк прерывается и выводит чек-лист публикации листа
    (`Файл → Поделиться → Опубликовать в интернете → CSV`, проверка `gid` и `output=csv`,
    синхронизировано с `docs/ADMIN_GUIDE.md` и покрыто тестами в `tests/test_sync.py`).
- `tools/planet_generation.py` — эталонный валидатор и CLI (`validate`, `seed`, `draft-row`,
  `manifest`, `key`, `freeze-row`): читает `src/contracts/planet-generation-contract.json`,
  восстанавливает `Decimal` (`ROUND_HALF_UP`), строит канонический географический манифест
  и считает ключ `PG1-...` (Base32 от первых 128 бит SHA-256).

---

## 2. Верификаторы контракта и публикации (`tools/verify_*.mjs`)

- `tools/verify_planet_contract_cross.mjs` (`npm run verify:contract`):
  - Сверяет между Python (`tools/planet_generation.py`) и TypeScript
    (`site/shared/planet-generation-contract.ts`) 37 колонок схемы, 8 пресетов `planet-presets-v1`,
    правила округления `Decimal` (`ROUND_HALF_UP`), канонический JSON и ключи `PG1`.
  - В обязательном порядке проверяет **оба допустимых формата `approved_at`** для `frozen`-профилей:
    дату `YYYY-MM-DD` (например, `"2026-10-21"`) и полный ISO datetime с `Z`
    (например, `"2026-10-21T18:30:00Z"`), тестируя обе ветки парсинга и сериализации.
- `tools/verify_feature_parity.mjs` (`npm run verify:publish`):
  - Проверяет присутствие всех 7 маршрутов в `.publish/`, целостность `.publish/build-manifest.json`,
    существование всех hashed-бандлов в HTML, `new Worker(...)` и `importScripts(...)`, отсутствие
    сырых `.ts` и `assets/src/` в публикации, а также паритет экспортов публичных модулей (И-6).
- [`tools/verify_no_raster.mjs`](verify_no_raster.mjs) (`npm run verify:no-raster`) — гейт **G7.3** из 9 проверок:
  подтверждает, что секторный растр выведен, тайлы и превью удалены, а в `data/meta.json` сохранён
  `imageVersion`. В CI job `scripts` этот шаг стоит **выше `npm test`**, а job `build` запускает его
  **после `verify:publish`**; приёмка SW-2 — **9/9**. `imageVersion` сохраняет кэш-бастинг картинок
  галактики (`?v=`) через `tools/vite/asset-utils.ts`. Инвентарь и порядок — [§17.3 и §17.13 SW-2](../docs/agents_task_orchestration/agents_task_orchestration.md).
- **Секторная матрица проверок на базе `147a0e2`** (после `31ee897`): `npm test` запускает 25 файлов, в том числе `canvas-zoom-clamp.test.mjs`, `sector-scene.test.mjs`, `label-layout.test.mjs` и `coords-readout.test.mjs`; фактический итог — 261 тест, 253 pass и 8 известных планетарных fail (Stage-8/A-17/W26b, вне секторной задачи). Не выдавать эти 8 падений за регрессию сектора и не исправлять их в этой волне. `npm run verify:sector-core` (`tools/verify_sector_core.mjs`) — 3 880 проверок; `npm run verify:no-raster` — 9/9; `npm run verify:publish` — 7 маршрутов и 36 hashed-ассетов. `npm run build` на этой базе прошёл.
- **Секторная матрица проверок на базе `37d0ac7`** (после слияния ядра SW-5 `9fd1194` и SW-3F `fafc564`): `npm test` запускает 26 файлов (в `9fd1194` подключён `tests/system-frame.test.mjs`); фактический итог — **262** теста, **254** pass и те же **8** известных планетарных fail (Stage-8, A-17, W26b — вне секторного контура, не чиним в этой волне). Тестовые файлы `tests/sector-flight.test.mjs` и `tests/sector-arrows.test.mjs` добавлены в `fafc564`, но в строку `npm test` в `package.json` ещё не включены (очередь долгов [§17.21.4](../docs/agents_task_orchestration/agents_task_orchestration.md)). Гейты: `npm run verify:sector-core` — 3 880 проверок; `npm run verify:no-raster` — 9/9; `npm run verify:publish` — 7 маршрутов и 36 hashed-ассетов; `npm run build` прошёл.

---

## 3. Ассеты, Wasm, золотые фикстуры и модули сборки `tools/vite/*`

- `tools/build_assets.py` собирает ресайзы карты галактики (`1200/2000/3000 px`), логотип и макеты;
  пайплайн секторной пирамиды WebP-тайлов и превью подложки удалён. В `data/meta.json` наверху
  остаётся `mapSize = 10000`, а в `assets` — только `imageVersion`: Vite использует его для
  кэш-бастинга изображений галактики параметром `?v=`, не для растра сектора. См. [§17.3 и §17.13 SW-2](../docs/agents_task_orchestration/agents_task_orchestration.md).
- `tools/build_planet_core.mjs` (`--check`) — компилирует AssemblyScript-ядра и сверяет байт-слепок
  `src/planet/planet-core-bytes.ts`. Скрипты `tools/bench_planet_stage{3,4,5,6}.mjs`,
  `bench_planet_ci.mjs`, `bench_planet_baseline.mjs` и `check_planet_spike.mjs` проверяют золотые
  фикстуры (`FULL EQ` SHA-256/CRC32C) и гейты скорости (`v=128 <= 855 мс`).
- `tools/vite/{asset-utils,atlas-shell,timeline-publish-pipeline}.ts` — модули сборочного пайплайна,
  на которые декомпозирован `vite.config.mts` (~120 строк):
  - `asset-utils.ts` — контент-хэширование, инлайн относительных JSON-импортов и утилиты путей;
  - `atlas-shell.ts` — рендер вариантов `sector.html` и `minimal.html` из `templates/atlas-shell.html`;
  - `timeline-publish-pipeline.ts` — единый конвейер фаз публикации (`tokenizeLegacyAssets` →
    `ensureFinalizedAssets` → `restoreLegacyAssets` → `writePublishExtras`) с явным контекстом
    `PublishPipelineState` (`publishSources`, `finalizedAssets`, `tokenReferenceQueues`).
