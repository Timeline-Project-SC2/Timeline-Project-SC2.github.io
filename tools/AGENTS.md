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

---

## 3. Ассеты, Wasm, золотые фикстуры и модули сборки `tools/vite/*`

- `tools/build_assets.py` (`--force`, `--check`, `--sync-only`) — строит из `assets/src/`
  пирамиду WebP-тайлов `512×512` (`assets/tiles/`, `assets/tiles.json`, `assets/map-preview.webp`),
  ресайзы карты галактики (`1200/2000/3000 px`) и записывает `imageVersion` в `data/meta.json`.
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
