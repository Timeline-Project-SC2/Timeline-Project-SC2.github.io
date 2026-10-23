# Конспект для следующего агента

Дата: 22 октября 2026. Обновлено в параллельной сплит-волне **Stage-8** («Этап 8: локальная карта и процедурный 3D-конструктор построек»; `Tri-Agent Wave` по `docs/agents_task_orchestration/agents_task_orchestration.md` §9: Воркер 1 — [PR #161](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/161), Воркер 2 — [PR #160](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/160), сводная запись Воркера 3 в ветке `arena/1e317f1c-timeline-project-sc2-github-io` — [PR #162](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/162); **готово к приёмке Гайдлайнером, стоп перед merge**): сшивка 3D-рельефа и рек `local-map-worker.ts` с каноническим срезом `Patch7` по И-3 (с LRU-кэшем на 8 участков), порционная GPU-догрузка `StructureRenderer` без пересоздания VAO по Патчу 8 (`gl.bufferSubData` `<= 3 мс`), интерактивный Dive-in экран локальной карты на `/planet-globe/` (`1250 … 1.2 км`, кольцо соседей `0..5`), CLI-бенчмарк гейта **G4** `tools/bench_local_map_stage8.mjs` (`generateLocalMap` median `27,4 мс` на `v=64` и `26,5 мс` на `v=128` при пороге `<= 150 мс`, `0` нарушений `buildingSpawnMask`) и отчёт `docs/stages/stage-8-local-map.md`.
До этого — волна **Stage-7** (`Tri-Agent Wave`: [PR #155](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/155), [PR #156](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/156), [PR #157](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/157), [PR #158](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/158); **слита в `main` 22.10**): переход из атласа сектора на 3D-глобус планеты (`/planet-globe/?place=<id>&system=<systemId>`, обратные ссылки `/sector/#system=<id>` и `/sector/#planet=<id>`), `transitionGeometry`/`flyToDirection`, команды `prefetch`/`extract-patch` воркера на `canonicalV`, загрузка `data/planet-generation.csv` в досье с бейджем `L1 Frozen` / `черновик` (И-4), отчёт `docs/stages/stage-7-planet-page.md`.
До этого — волна **Wave-DX-1** (`Tri-Agent Wave`: Воркер 1 — [PR #148](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/148), Воркер 2 — [PR #149](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/149), Воркер 3 — [PR #151](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/151); **слита в `main` 22.10**): воспроизводимость окружения и CI (`.nvmrc`, `.python-version`, единый `package-lock.json` с `assemblyscript` и `eslint`), декомпозиция `vite.config.mts` на `tools/vite/*` с контекстом `PublishPipelineState`, строгий режим `python3 tools/sync.py --strict` + диагностика HTML-ответов Google Sheets, проверка обоих форматов `approved_at` в `verify_planet_contract_cross.mjs` и иерархия `AGENTS.md` (`site/AGENTS.md`, `src/AGENTS.md`, `tools/AGENTS.md`) по принципу Single Source of Truth (SSoT).
До этого — волна **PR 6.1** ([PR #145](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/145), [PR #146](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/146), [PR #147](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/147); **слита в `main` 22.10**): устранение визуальных и UI-регрессий `/planet-test/` после консолидации PR 5 и синхронизация мастер-плана `docs/PREPARATION_PLAN.md` с архитектурой `CR-01`.
До этого — [PR #139](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/139) (CR-01 PR 6: целевая оптимизация скорости генерации планеты v=128 до гейта ≥3× / ≤855 мс от baseline 2 564,7 мс при 100 % побитовой эквивалентности; **слит в `main` 22.10**).
До этого — PR #138 (CR-01 PR 5 — консолидация глобусов и модули локальной карты И-3, И-5, И-6; **слит в `main` 22.10**).
До этого — PR #137 (CR-01 PR 4 — Wasm-ядро planet-core, строгие TS-порты планетных модулей
и И-1; **слит в `main` 21.10**; работа восстановлена после утраты незакоммиченной сессии,
см. §1 и §7). До этого — PR #115 ( спайк Этапа 1 планет и кодовая часть Этапа 2 — профили
`planet_generation`, валидатор/ключ и двухфазный синк; отчёты —
`docs/stages/stage-1-spike-report.md` и
`docs/stages/stage-2-data-and-sync.md`). До этого — PR #111: спираль поверх карты
галактики — ревизия демо `galaxy-spiral` и внедрение.
PR #110 (каталог и поиск атласа), #109 (тайминг первого клика), #108 (переход в Копрулу),
#106 (атлас), #103 (карта сектора), #105 (инструкции к таблице) и #107 (явные координаты
систем) слиты в `main`. Основные актуальные правила репозитория — в корневом [`AGENTS.md`](../AGENTS.md) и доменных [`site/AGENTS.md`](../site/AGENTS.md), [`src/AGENTS.md`](../src/AGENTS.md), [`tools/AGENTS.md`](../tools/AGENTS.md). Этот файл служит
вводной для агента; после завершения задачи обновляйте статус и проверки.

## 1. Статус

| | |
|---|---|
| Последняя работа | Волна **Stage-8** (`Tri-Agent Wave`, 22.10; Воркер 1 — [PR #161](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/161): непрерывность рельефа и речного стока по И-3 в `src/local-map/local-map-worker.ts` (привязка `heightfield` $256 \times 256$ к `Patch7`, `filledElevation - seaLevel`, `waterLevelOf`, выемка русла `inlets → центр → outlet`, 3D-шум `samplePatchFields`, LRU-кэш на 8 участков и поля `LocalMapMeta`: `totalInstances`, `buildableFraction`, `waterFraction`, `genMs`), порционная GPU-догрузка `StructureRenderer` без пересоздания VAO в `src/local-map/local-map-renderer.ts` и `local-map-shaders.ts` (Патч 8: `enqueueWorkerData`, `processPendingUpload` по бюджету `<= 3 мс` через `gl.bufferSubData`, `isUploading`, `getUploadProgress`, `compilePrograms`, `renderFrame`, `dispose`) + `tests/local-map-stage8.test.mjs`; Воркер 2 — [PR #160](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/160): интерактивный 3D-экран локальной карты и Dive-in переход в `/planet-globe/` (`#localMapStage`, `#diveLocalMapBtn`, URL `?place=&system=&cell=&view=local`, лестница масштабов `#localScaleSel` `1250 … 1.2 км`, навигация по 6 соседям кольца `#localNeighborNav` `0..5`, `#localMapHud` и возврат `#exitLocalMapBtn`); Воркер 3 — [PR #162](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/162), ветка `arena/1e317f1c-…`: CLI-бенчмарк гейта **G4** `tools/bench_local_map_stage8.mjs` (`generateLocalMap` median `27,435 мс` / p95 `34,854 мс` на `v=64` и median `26,482 мс` / p95 `30,999 мс` на `v=128` при пороге `<= 150 мс`, `0` нарушений `buildingSpawnMask`), отчёт `docs/stages/stage-8-local-map.md`, блоки «Факт Этапа 7» и «Факт Этапа 8» в `docs/PREPARATION_PLAN.md` и сводная документация волны; **стоп перед merge — приёмка Гайдлайнером** |
| Предыдущая работа | Волна **Stage-7** (`Tri-Agent Wave`, 22.10; [PR #155](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/155), [PR #156](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/156), [PR #157](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/157), [PR #158](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/158) — **слиты в `main` 22.10**): Воркер 1 — ядро бесшовного зума `site/shared/planet-globe.ts` (`transitionGeometry(nextGeometry, durationSec?)` с двухслойным центробежным замещением `uHide`/`uCenterGrow` и освобождением `prevVao`, `flyToDirection`, `getCameraState`, `onCameraIntent` с debounce 180 мс) и команды `prefetch`/`extract-patch` в `site/planet-globe/planet-globe-worker.ts` (`latest-wins` по токену, `GeodesicGrid.getChunkNeighbors`, `buildPatch7` на `canonicalV`, `verifyPatchInvariants`, `patchSpanMeters`, `buildBuildingSpawnMask`, ключи §8.8) + `tests/planet-stage7-worker.test.mjs`; Воркер 2 — страница `/planet-globe/` (`site/planet-globe/index.html`, `planet-globe.css`, `planet-globe.ts`): каталог `places.csv`+`systems.csv`+`planet-generation.csv`, хлебные крошки `Галактика → Сектор Копрулу → Система → Планета`, глубокие ссылки `?place=&system=&cell=`, бейдж `verifyGenerationKey(profile)` (И-4), инспектор канонической ячейки/региона C100/участка `Patch7` и prefetch по намерению камеры; Воркер 3 — `planetProfileStatus`/`planetPresetId`/`planetRadiusKm`/`planetGenerationKey` в `PlaceRecord` и `CONFIG.data.generation` (`src/atlas/config.ts`), `mergePlanetGenerationRows` и загрузка `/data/planet-generation.csv` в `loadDataset()` (`src/atlas/data-loader.ts`), `isGlobeCapablePlace`/`planetGlobeUrl`, бейдж статуса 3D-профиля, `.detail-globe-cta`/`.detail-globe-button` и `.world-globe-link`, поддержка `#system=` / `#planet=` в `applyHash()` (`src/atlas/dossier-card.ts`, `site/shared/timeline-skin.css`), отчёт `docs/stages/stage-7-planet-page.md` |
| До этого (волна DX-1) | Волна **Wave-DX-1** (`Tri-Agent Wave`, 22.10; Воркер 1 — [PR #148](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/148), Воркер 2 — [PR #149](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/149), Воркер 3 — [PR #151](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/151) — **слиты в `main` 22.10**): Воркер 1 — пиннинг `.nvmrc` (`24`) и `.python-version` (`3.12`), перевод `.github/workflows/check.yml` на `actions/setup-node@v6` и `actions/setup-python@v6` с `npm run typecheck` и `npm run lint`, включение `assemblyscript` и стека `eslint` в `devDependencies`/`package-lock.json` (при сохранении `typescript@^7.0.2` через `@typescript/native` и `@typescript/typescript6`), явный список всех 8 тестовых файлов в `npm test`, скрипт `npm run test:py` и декомпозиция `vite.config.mts` (~120 строк) на `tools/vite/{asset-utils,atlas-shell,timeline-publish-pipeline}.ts` с единым контекстом `PublishPipelineState`; Воркер 2 — строгий режим `python3 tools/sync.py --strict` (`0 <= x, y <= mapSize`, запрет одновременного `system_id` + `x, y` в `places`, дубли ID), диагностика `looks_like_html(...)` с чек-листом публикации CSV в Google Sheets, `tests/test_sync.py`, оба формата `approved_at` (`YYYY-MM-DD` и ISO с `Z`) в `tools/verify_planet_contract_cross.mjs` и обновление `docs/ADMIN_GUIDE.md`; Воркер 3 — декомпозиция `AGENTS.md` (SSoT) на корневой `AGENTS.md` и доменные `site/AGENTS.md`, `src/AGENTS.md`, `tools/AGENTS.md` + сводка волны в `docs/HANDOFF.md` и `CHANGELOG.md` |
| До этого (волна PR 6.1) | Волна **PR 6.1** (`Tri-Agent Wave`, 22.10; [PR #145](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/145), [PR #146](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/146), [PR #147](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/147) — **слиты в `main` 22.10**): устранение регрессий `/planet-test/` после PR 5 и синхронизация `docs/PREPARATION_PLAN.md` с выполненной архитектурой `CR-01`. Воркер 1 — миграция клеточной раскладки осколков `computeShardLayout` (`equal`/`power`/`lognormal`, `shardThick`, `shardJag`, `shardLoss`), удаление легаси `site/shared/planet-geometry.js` (И-5), возврат 3D-объёма осколков (`VS_VOLUME/FS_VOLUME`) и светящегося ядра Шакураса (`VS_CORE/FS_CORE`, `coreScale=0.55`) в `src/planet/planet-globe-fx.ts`; Воркер 2 — каскадная сборка глобуса `uBuild`, двухслойное центробежное замещение прокси (`uHide`, `uCenterGrow`) в `site/shared/planet-globe.ts`, расширенные вызовы FX-хуков и восстановление полного набора контролов и 10-сек телеметрии кадра (`p50/p95/p99`, `>50ms`, `>100ms`, `worst5`, адрес ячейки) в `/planet-test/`; Воркер 3 — актуализация `docs/PREPARATION_PLAN.md` (Раздел 1–2 и Этапы 3–8 по `CR-01`, `stage_patches.md` и инвариантам И-1…И-6) |
| До этого | CR-01 PR 6 ([PR #139](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/139), ветка `arena/4e8296a0-…`, **слит в `main` 22.10**): добивка скорости генерации планеты v=128 до гейта ≥3× / ≤855 мс от baseline 2 564,7 мс при 100 % побитовой эквивалентности (FULL EQ `185/185`). Итог `bench_planet_stage5.mjs --seeds=5`: `meshMedian = 125,8–139,1 мс`, `surfaceMedian = 691,3–724,5 мс` (`min = 601,0–617,3 мс`), `totalMedian = 812,1–852,7 мс <= 855,0 мс` (**ускорение `3,01×–3,16×` от baseline `2 564,7 мс`**); `bench_planet_ci.mjs`: `v=128 build 922,7 → 100,1 мс (−89,2 %)`; `bench_planet_stage6.mjs`: `geometry median = 123,2 мс`, `surfacePlusGeometry median = 964,6 мс`. Все 6 PR плана **CR-01** (`docs/CHANGE_REQUEST_PLAN.md`) полностью закрыты |
| До этого | CR-01 PR 5 ([PR #138](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/138), ветка `arena/37e6e1a9-…`, **слит в `main` 22.10**): финальный PR миграции по `docs/CHANGE_REQUEST_PLAN.md` (И-3, И-5, И-6 и раздел 6.2). Распил `temp_code_structures.js` на 4 модуля `src/local-map/*`, контракт сшивки патча 7 ячеек + `tests/local-map.test.mjs`, строгий `planet-globe.ts` + опциональный `src/planet/planet-globe-fx.ts`, перевод `/planet-test/` на боевое ядро с удалением `planet-test.js` и `planet-worker.js` |
| До этого | CR-01 PR 4 ([PR #137](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/137), ветка `arena/07852140-…`, **слит в `main` 21.10**): Wasm-ядро planet-core (AssemblyScript, 24 613/2 690 Б), строгие TS-порты `geodesic-grid`/`planet-noise`/`planet-geography`/`planet-surface`/`planet-globe` и воркера глобуса с побитовой эквивалентностью JS (FULL EQ), закрыта И-1, честные нормали рельефа (вершина 24 Б), старые `.js` удалены. Генерация v=128: 2 564,7 → 1 630,8 мс (1,57×); гейт плана 3–4× добивается в PR 6. Восстановлено после утраты незакоммиченной сессии (§7). После merge — телефонная проверка глобуса владельцем (скрины Redmi Note 10 от 21.10: генерация и финал v=64 проходят) |
| До этого | Этап 2 планет (PR #115): контракт `planet_generation` из 37 колонок, пресеты/валидатор/ключ `PG1` в `tools/planet_generation.py`, начальный снимок и шаблон CSV, источник в `data/sources.json` включён для вкладки `planet_generation` (`gid=1183479406`; живой Sync применит его после merge PR), двухфазный атомарный синк и 26 Python-тестов. Отчёт — `docs/stages/stage-2-data-and-sync.md`; сайт новый CSV пока не читает |
| Ещё раньше | Спайк Этапа 1 планет (та же ветка): сетка Голдберга GP(v,0) (`site/shared/geodesic-grid.js`), детерминированные поля (`site/shared/planet-noise.js`: simplex vs value), WebGL2-глобус на тестовой странице `/planet-test/`, проверка `tools/check_planet_spike.mjs`. Отчёт и замеры — `docs/stages/stage-1-spike-report.md`; визуальная часть гейта G1 — за пользователем |
| Ранее | [PR #111](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/111): спираль поверх карты галактики: демо `galaxy-spiral` (ветка `arena/42c599c5-…`, без PR) пересобрано под карту — звёзды текут по орбитам, яркость берут из самой карты; слой над картой, под остальными анимациями |
| Ранее | [PR #109](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/109): тайминг первого клика на галактике: приближение после центрирования — отдельная `CONFIG.focusZoomMs`, у перехода свои `dive*`; пользователь подбирает тайминг сам |
| Ранее | [PR #108](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/108): переход в Копрулу на галактике — рамка по контуру квадрата, одно приближение до 2000 % как у выбора, ≈2,9 с вместо ≈4,4 с; пользователь: «Найс! Отличная работа» |
| Атлас | [PR #106](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/106): карточка-предпросмотр в атласе (`is-preview`), щелчок только левой, колесом крестовина сразу и над сектором или системой |
| PR сектора | [PR #103](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/103) слит в `main`; публикация Pages прошла успешно |
| Инструкции к таблице | [PR #105](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/105) слит в `main` |
| История курсора | [PR #99](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/99) и [#104](https://github.com/TimelineProjectSC2/TimelineProjectSC2.github.io/pull/104) слиты в `main` 18.10; пользователь проверяет курсор на сайте и пишет замечания |
| Как показать | сам сайт; страница проверки курсора — `/cursor-test/`; демо и настройка ядра спирали — `/spiral-test/`; стенд FX-режимов Шакураса на боевом ядре — `/planet-test/`; боевой глобус — `/planet-globe/` |

Что изменено (подробно — в `CHANGELOG.md`, правила — в `AGENTS.md`, `site/AGENTS.md`, `src/AGENTS.md`, `tools/AGENTS.md`):

- Волна **Stage-8** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §9; Воркер 1 — [PR #161](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/161), Воркер 2 — [PR #160](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/160), Воркер 3 — ветка `arena/1e317f1c-…`, [PR #162](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/162); **стоп перед merge — приёмка Гайдлайнером**).
  Этап 8 мастер-плана (`docs/PREPARATION_PLAN.md` §9.4, §9.5, §9.5.1, §12 и Патч 8): локальная 3D-карта участка `Patch7`, порционная GPU-догрузка `StructureRenderer`, интерактивный Dive-in экран и проверка гейта **G4** (`Zero File Overlap`):
  1. **Воркер 1 (непрерывность рельефа и рек по И-3, порционная GPU-догрузка и тесты — PR #161):** в `src/local-map/local-map-worker.ts` базовая высота `heightfield` ($256 \times 256$) привязана к каноническим полям `Patch7` (`patchBaseElevation` / `filledElevation - seaLevel`, `waterLevelOf`, выемка русла вдоль `patch.river.inlets` → центр → `patch.river.outlet` и 3D-шум через `samplePatchFields` при переданном `profile`), добавлен LRU-кэш локальных участков (до 8 записей) и расширен `LocalMapMeta` (`totalInstances`, `buildableFraction`, `waterFraction`, `genMs`); в `src/local-map/local-map-renderer.ts` и `src/local-map/local-map-shaders.ts` внедрено предвыделение `terrainVAO` (`gl.UNSIGNED_INT`) и `instanceVBOs` один раз при инициализации и методы порционной GPU-догрузки `enqueueWorkerData(data, budgetMs?)`, `processPendingUpload(budgetMs?)`, `isUploading()`, `getUploadProgress()`, `compilePrograms()`, `renderFrame(viewProj, lightDir, options?)` и `dispose()` через `gl.bufferSubData` по кадровому бюджету `<= 3 мс` без пересоздания VAO (с сохранением синхронного `onWorkerData`); добавлен тест `tests/local-map-stage8.test.mjs` и подключён в `npm test`.
  2. **Воркер 2 (интерактивный 3D-экран локальной карты и Dive-in переход в `/planet-globe/` — PR #160):** в `site/planet-globe/{index.html,planet-globe.css,planet-globe.ts}` добавлены оверлей `#localMapStage` (`#localMapCanvas`), кнопка погружения `#diveLocalMapBtn` в `#patchInspector`, глубокая ссылка `?place=&system=&cell=&view=local`, запуск `generateLocalMap` по активному `Patch7` на первом кадре подлёта без остановки камеры глобуса, порционная загрузка данных в `StructureRenderer` (`enqueueWorkerData`/`processPendingUpload` с fallback на `onWorkerData`), плавное проявление (`fade-in`) 3D-сцены с управлением камерой (орбита, наклон, панорамирование, зум), селектор видимой ширины `#localScaleSel` (`1250 → 625 → 312 → 156 → 78 → 39 → 20 → 10 → 5 → 2.5 → 1.2 км`), кольцо перецентровки по 6 соседним ячейкам `#localNeighborNav` (`0..5`), `#localMapHud` и возврат `#exitLocalMapBtn` без сброса ракурса.
  3. **Воркер 3 (CLI-бенчмарк гейта G4 и сводная документация — PR #162):** создан `tools/bench_local_map_stage8.mjs` (`v=64` по умолчанию и `--v=128` для полной Земли; 3 seed `earthlike_balanced`, 4 шестиугольных архетипа — `dry_plain`, `river_junction`, `lake_basin`, `coastline`, 4 ступени `1250 / 78 / 10 / 1.2 км`, 144 прогона на частоту): `buildMeshLibrary` (12 модулей, 413 вершин, 12 384 Б) — median `0,114 мс` (`v=64`) / `0,109 мс` (`v=128`); `buildPatch7 + verifyPatchInvariants` (`ok === true` на `12/12`) — median `0,0811 мс` (`v=64`) / `0,0690 мс` (`v=128`); `generateLocalMap` — **median `27,435 мс`, p95 `34,854 мс`, max `45,426 мс` на `v=64`** и **median `26,482 мс`, p95 `30,999 мс`, max `50,304 мс` на `v=128`** при критерии гейта **G4** `<= 150 мс` (запас `~5,5–5,7×` по медиане); **`0` нарушений `buildingSpawnMask`** во всех `288` генерациях. Оформлен отчёт `docs/stages/stage-8-local-map.md` и блоки «Факт Этапа 7» / «Факт Этапа 8» в `docs/PREPARATION_PLAN.md`.
- Волна **Stage-7** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §8; [PR #155](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/155), [PR #156](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/156), [PR #157](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/157), [PR #158](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/158) — **слиты в `main` 22.10**).
  Этап 7 мастер-плана (`docs/PREPARATION_PLAN.md` §12 и §8.8): страница планеты, бесшовный зум Голдберга и прямой переход из атласа сектора (`Zero File Overlap`):
  1. **Воркер 1 (бесшовный зум и `Patch7`):** в `site/shared/planet-globe.ts` добавлены `transitionGeometry(nextGeometry, durationSec?)` (уходящий `prevVao` с `uHide = progress`, новый `vao` с `uCenterGrow = progress`, буферы `prevVao` освобождаются сразу по завершении волны), `flyToDirection(direction, targetDistance?, durationMs?)`, `getCameraState()` и `onCameraIntent` (debounce 180 мс); в `site/planet-globe/planet-globe-worker.ts` — команды `prefetch` (latest-wins по `token`/`requestId`, прогрев `GridCache`, `GeodesicGrid.getChunkNeighbors`, упреждающая сборка `Patch7`) и `extract-patch` (`buildPatch7` + `verifyPatchInvariants` + `patchSpanMeters` + `buildBuildingSpawnMask` строго на `canonicalV`, авто-привязка 5-угольных полюсных ячеек к ближайшему 6-угольному соседу, ключи §8.8); тесты `tests/planet-stage7-worker.test.mjs` и подключение файла в `npm test`.
  2. **Воркер 2 (страница планеты):** `/planet-globe/` читает `places.csv` + `systems.csv` + `planet-generation.csv`, строит хлебные крошки `Галактика → Сектор Копрулу → Система → Планета`, держит стабильные URL `?place=&system=&cell=`, показывает `verifyGenerationKey(profile)` (И-4: `L1 Frozen` vs `L0 Draft`), вызывает `transitionGeometry(geometry, 0.45)` на апгрейде прокси-шара и отправляет `prefetch` по `onCameraIntent`, а также выводит инспектор канонической ячейки, континентальной области C100 и среза `Patch7` (`local-map-patch-v1`, И-1 и И-3) с ключами `planet_key` / `region_key` / `cell_key` / `patch_key` и копированием прямой ссылки на ячейку.
  3. **Воркер 3 (переход из атласа и сводная документация):** `PlaceRecord` получил `planetProfileStatus` / `planetPresetId` / `planetRadiusKm` / `planetGenerationKey` (`PlanetProfileStatus = 'draft' | 'review' | 'frozen'`), константу `PLANET_GLOBE` и `CONFIG.data.generation`; `loadDataset()` грузит `/data/planet-generation.csv` в обеих ветках и обогащает записи через `mergePlanetGenerationRows` (сопоставление по `place_id`, валидация статуса и радиуса); в досье появились `isGlobeCapablePlace` (`planet`/`moon` или заполненный профиль), `planetGlobeUrl` (`/planet-globe/?place=<id>&system=<systemId>`), бейдж статуса 3D-профиля, кнопка `.detail-globe-button` в блоке `.detail-globe-cta` и компактная ссылка `.world-globe-link` в списке миров; `applyHash()` понимает обратные ссылки `/sector/#system=<id>` и `/sector/#planet=<id>`; стили — в `site/shared/timeline-skin.css`; инвариант `#detailPanel.is-preview { pointer-events: none }` сохранён. Отчёт — `docs/stages/stage-7-planet-page.md`.
- Волна **Wave-DX-1** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §7; Воркер 1 — [PR #148](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/148), Воркер 2 — [PR #149](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/149), Воркер 3 — ветка `arena/93088d3c-…`, [PR #151](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/151); **стоп перед merge — приёмка Гайдлайнером**).
  Улучшение Developer Experience, воспроизводимости CI, строгой валидации синхронизации и иерархии документации агентов в трёх непересекающихся потоках (`Zero File Overlap`):
  1. **Воркер 1 (Среда, зависимости, CI и конвейер Vite — PR #148):** добавлены `.nvmrc` (`24`) и `.python-version` (`3.12`); `.github/workflows/check.yml` переведён на `actions/setup-node@v6` и `actions/setup-python@v6` с явными проверками `npm run typecheck` и `npm run lint`; `assemblyscript` и стек `eslint` включены в `devDependencies` и атомарно зафиксированы в `package-lock.json` (при сохранении `typescript@^7.0.2` через `@typescript/native` и `@typescript/typescript6` для совместимости с `@typescript-eslint/*`); в `npm test` явно перечислены все 8 тестовых файлов, добавлен `npm run test:py`; `vite.config.mts` декомпозирован (до ~120 строк) на модули `tools/vite/{asset-utils,atlas-shell,timeline-publish-pipeline}.ts` с единым объектом состояния `PublishPipelineState`.
  2. **Воркер 2 (Строгий синк `--strict`, диагностика HTML и проверка `approved_at` — PR #149):** в `tools/sync.py` добавлен режим `python3 tools/sync.py --strict` (проверка числовых координат `0 <= x, y <= mapSize`, конфликта одновременного указания `system_id` и ручных `x, y` в `places`, дублей непустых `id` во всех таблицах); расширена диагностика `looks_like_html(...)` с чек-листом публикации CSV в Google Sheets и обновлено руководство `docs/ADMIN_GUIDE.md`; добавлены модульные тесты в `tests/test_sync.py`; `tools/verify_planet_contract_cross.mjs` расширен на детерминированную проверку обоих форматов `approved_at` (`YYYY-MM-DD` и ISO datetime с `Z`).
  3. **Воркер 3 (Иерархия `AGENTS.md` по принципу SSoT и сводка волны — PR #151):** корневой `AGENTS.md` (~154 строки) разгружен до общих правил репозитория, карты маршрутов/директорий и команд проверки; созданы доменные инструкции `site/AGENTS.md`, `src/AGENTS.md` и `tools/AGENTS.md` (~60–70 строк каждая) без дублирования правил корня; результаты волны `DX-1` зафиксированы в `docs/HANDOFF.md` и `CHANGELOG.md`.
- Волна **PR 6.1** (`Tri-Agent Wave`, 22.10; [PR #145](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/145), [PR #146](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/146), [PR #147](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/147) — **слиты в `main` 22.10**).
  Устранение регрессий стенда `/planet-test/` после консолидации PR 5 и синхронизация мастер-плана `docs/PREPARATION_PLAN.md` с выполненной архитектурой `CR-01` в трёх непересекающихся потоках (`Zero File Overlap`):
  1. **Воркер 1 (FX-геометрия, объём осколков и ядро Шакураса):** перенос клеточной раскладки осколков в строгий TypeScript (`computeShardLayout` с режимами `equal`/`power`/`lognormal`, параметрами `shardThick`, `shardJag`, `shardLoss` и назначением осколка строго по ячейке `vertexCellId` вместо вершинного `fxShardIndex`), удаление последнего легаси-модуля `site/shared/planet-geometry.js` по Инварианту И-5, возврат 3D-объёма осколков (`VS_VOLUME/FS_VOLUME`: боковые стенки разломов и закрытая нижняя оболочка) и светящегося ядра Шакураса (`VS_CORE/FS_CORE` с дефолтным `coreScale=0.55`) в `src/planet/planet-globe-fx.ts` через хуки `PlanetGlobeFxHooks` (`onGeometryUploaded`, `onAfterSurfaceDraw`, `onDispose`), а также тесты `tests/planet-globe-fx.test.mjs`.
  2. **Воркер 2 (Каскадная сборка, центробежное замещение и UI `/planet-test/`):** восстановление в `site/shared/planet-globe.ts` каскадной сборки глобуса от полюса к полюсу (`uBuild`) и двухслойного центробежного замещения прокси-шара детальным слоем (`uHide`, `uCenterGrow`), подключение расширенных FX-хуков жизненного цикла геометрии и восстановление полного набора контролов (`#panelToggle`, `#spinBtn` + `Space`, `#bordersBtn`, `buildSec`/`buildBtn`/`buildAnimBtn`, `coreScale`, `shardDist`, `shardThick`, `shardJag`, `shardLoss`) и скользящего 10-сек окна телеметрии кадра (`p50/p95/p99`, `>50ms`, `>100ms`, `worst5`, адрес выбранной ячейки) в `site/planet-test/*`.
  3. **Воркер 3 (Мастер-план и сводная документация волны):** актуализация `docs/PREPARATION_PLAN.md` (Раздел 1–2 и Этапы 3–6 под стек `.ts` + гибридный Wasm `planet-core` с фактическими таймингами PR 6 `> 3,0×` при 100 % FULL EQ и единым ядром глобуса + `planet-globe-fx.ts`; Этап 7 дополнен требованиями `uBuild`, двухслойного `uHide`/`uCenterGrow`, `intent-based worker prefetch` и контрактом сшивки 7 ячеек `local-map-patch-v1` по И-3; Этап 8 дополнен 4 модулями `src/local-map/*`, `buildingSpawnMask` по И-3.4 и требованием порционной staged GPU-догрузки `StructureRenderer` без фризов и без пересоздания VAO) + сводная запись волны в `docs/HANDOFF.md` и `CHANGELOG.md`.
- CR-01 PR 6 (22.10, ветка `arena/4e8296a0-…`, [PR #139](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/139);
  **слит в `main` 22.10**).
  Финальный оптимизационный PR плана `docs/CHANGE_REQUEST_PLAN.md` (добивка скорости
  генерации планеты v=128 до гейта ≥3× / ≤855 мс от baseline 2 564,7 мс при 100 %
  побитовой эквивалентности FULL EQ), 5 шагов с коммитом и пушем после каждого
  (`1fbaeaf`, `384eef2`, `9b86b35`, `d7dc179`, `c4ab968`):
  1. Подключены Wasm `getCore().radixOrderF32` / `radixOrderF64` в `makeWeightedQuantiles`
     и `chooseSeeds` (`site/shared/planet-geography.ts`), а также в `makeWeightedQuantiles`
     и `orderAsc` (`site/shared/planet-surface.ts`) с сохранением строгого tie-break
     `(a - b)` (И-2).
  2. Ускорено построение геодезической сетки `GeodesicGrid.build(v)` в ~3,7–4,1×
     (`442,9 мс → 100,1–125,8 мс` на `v=128`): модульный пул буферов `ensureRawScratch(163842)`,
     плоский `Int32Array` вместо `Map` на грань, пропуск `.toFixed(9)`/`byKey` на внутренних
     вершинах грани (`i > 0 && j > 0 && i + j < v`), монотонный Diamond Angle вместо `Math.atan2`,
     counting bucket sort с `sortKeys` в `reorderCells` и однопроходный `attachChunks`.
  3. Расширены и ускорены ядра `src/planet/assembly/kernels.ts` и хост
     `src/planet/planet-core-host.ts` (полное ядро 42 039 Б, noise 3 703 Б): 2-канальный
     `f64x2` SIMD (`simplex3x2`, `sampleCellPair`) в `sampleFieldsBatch`, ленивые JS-шумы
     в `createFieldSampler`, синглтон `getSharedPlanetCore()` с ареной 24 МиБ, удержание
     `putGrid` и `balArenaEnd` между `buildContinents` и `buildOceanBasins`, пакетные
     `balanceRegionsTopTwo` и `biomeWeightsAndSmooth`, сквозная арена гидрологии,
     непрерывные `candX/candY/candZ/candScoreNorm` в `chooseSeedsKernel`, гибрид кучи + FIFO
     в `coastDistance`, insertion+merge sort упакованных `u64(cell, label)` в `dialGatherSort`,
     интрузивный список `Int32Array(n)` в `buildDrainageRegions`, обход только `landCells`
     в `computeSurface`/`connectedComponents`/`computeMountains` и фиксированные V8 Map
     у `GeographyResult` и `SurfaceResult`.
  4. Пройдены все проверки: `185/185` побитовых хэшей FULL EQ (SHA-256 всех 45 массивов
     географии и поверхности + CRC32C сетки на `v=16, 24, 32, 64, 128`), `tsc --noEmit`,
     `npx eslint site src`, `npm run build`, `verify:publish`, `verify:contract`,
     `node --test` (44/44), `python3 -m unittest` (28/28).
  5. Итоговые метрики `bench_planet_stage5.mjs --seeds=5` (v=128):
     `meshMedian = 125,8–139,1 мс`, `surfaceMedian = 691,3–724,5 мс` (`min = 601,0–617,3 мс`),
     **`totalMedian = 812,1–852,7 мс <= 855,0 мс` (`3,01×–3,16×` к baseline `2 564,7 мс`)**.
     Все 6 PR плана **CR-01** завершены.
- CR-01 PR 5 (21.10, ветка `arena/37e6e1a9-…`, PR #138; **слит в `main` 22.10**). Финальный PR миграции по
  `docs/CHANGE_REQUEST_PLAN.md` (И-3, И-5, И-6, раздел 6.2), 5 шагов, коммит
  после каждого (`a9dc170`, `cf20f9c`, `c1cd5dc`, `63c9990` + документация):
  1. `site/shared/temp_code_structures.js` (1 176 строк) распилен на 4 строго
     типизированных модуля `src/local-map/` (М1 mesh-библиотека 12 инстансных
     модулей и ролей, М2 генерация+wire-протокол, М3 StructureRenderer с
     подсветкой опорных точек, М4 GLSL-шейдеры); свалка удалена (И-5).
  2. Контракт сшивки патча из 7 канонических ячеек глобуса (И-3):
     `src/local-map/local-map-contract.ts` (`local-map-patch-v1`), единый
     3D-сэмплер полей, filledElevation c100-soft-v2, реки через общие рёбра
     (flowReceiver + streamWeight/flowAccumulationKm2), buildingSpawnMask;
     `tests/local-map.test.mjs` (6 тестов) подключён в `check.yml`.
  3. `site/planet-globe/planet-globe.js` (778 строк) → строгий
     `site/planet-globe/planet-globe.ts` (пресеты CSV, прокси→финал, 2D
     fallback, сводка/выбор ячейки — поведение сохранено); уникальные
     экспериментальные режимы стенда вынесены в опциональный модуль
     `src/planet/planet-globe-fx.ts` (взрыв осколков Шакураса uSep —
     shardTransform по текстуре 64×4 RGBA32F с «потерянными» a=1.35/b=0.75,
     анимация только юниформом 2400/1500 мс; диагностические палитры
     uPalette 0…6, декоративные фактуры uTexMode 1…5, hueRotate,
     randomFxTheme). В `planet-globe.ts` — необязательный сокет
     `PlanetGlobeFxHooks` (поле `fx`): без плагина рендер не меняется.
     Протокол воркера типизирован (`WorkerMessage`/`WorkerResponse`).
  4. `/planet-test/` переведён на общее боевое ядро тонкой обёрткой
     `site/planet-test/planet-test.ts` (planet-globe + planet-globe-fx +
     общий `planet-globe-worker`); удалены дубли `planet-test.js`
     (2 929 строк) и `planet-worker.js` (И-5). Маршрут `/planet-test/`
     жив и публикуется (`verify:publish` OK). Всего за PR удалено ≈5,2 тыс.
     строк легаси-JS, параллельных реализаций не осталось (И-5), экспорт
     и контрактные поля сверены (И-6).
  5. Документация (AGENTS.md, HANDOFF.md, CHANGELOG.md) и полный прогон:
     tsc strict, ESLint site+src, `node --test` (42/42, включая
     `tests/local-map.test.mjs`), `npm run build`, `verify:publish`,
     `verify:contract`, `build_planet_core.mjs --check`, `check.yml` 4/4.
- CR-01 PR 4 (21.10, [PR #137](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/137);
  **слит в `main` 21.10**; владелец перед этим держал merge запрещённым до
  отдельной команды — исключение из общего «создайте PR и слейте сразу» в
  AGENTS.md). Реализация старой сессии погибла
  незакоммиченной вместе с песочницей (казус и протокол — §7 и AGENTS.md
  «Сохранность работы»); восстановлена на ветке `arena/07852140-…` по логам
  владельца (`commands.txt`, `dialog (6).txt`) цепочкой коммитов с FULL EQ
  после каждого модуля. Итоги и цифры — в `CHANGELOG.md` (запись CR-01 PR 4)
  и в комментарии PR #137. После merge — телефонная проверка глобуса
  владельцем пройдена (скрины Redmi Note 10 от 21.10: генерация и финал
  v=64 проходят). Открытый хвост: решение владельца по гейту 3×.
- Этап 2 планет: данные и синхронизация (19.10, та же ветка/PR #115; владелец
  направил работу на Этап 2 до закрытия Этапа 1.5 и визуальной части G1).
  `tools/planet_generation.py` задаёт схему будущего листа `planet_generation`
  (37 колонок), восемь пресетов, раскрытие эффективных значений, строгую
  проверку против `places` и ключ `PG1` по каноническому географическому
  манифесту; CLI выдаёт seed, draft-строку, манифест, ключ и полную
  freeze-строку. Добавлены пустой снимок `data/planet-generation.csv`,
  шаблон с draft-примерами и третий источник в `data/sources.json`.
  20.10 владелец создал живую вкладку `planet_generation`
  (`gid=1183479406`, пока только заголовок); источник включён по CSV-URL
  общей опубликованной книги, первый живой Sync — после merge PR.
  URL-синк переписан на две фазы: все CSV проверяются в памяти, профили —
  против новой версии `places`, и только затем снимки/`meta.json`/манифест
  заменяются атомарно одной группой с откатом при сбое. Интеграционный тест
  доказывает, что ошибочный профиль оставляет прежние CSV байт-в-байт.
  Поддерживаемые версии пока прототипные (`goldberg-gp-v0`,
  `planet-noise-spike-1`, `c100-soft-v0`, `planet-presets-v0`); боевой
  массовый freeze — после версий v1 Этапов 3–4. Сайт новый CSV ещё не читает.
  Отчёт — `docs/stages/stage-2-data-and-sync.md`.
- Спайк Этапа 1 планет (19.10, ветка `arena/c6424c78-timelineprojectsc2-github-io`). Пользователь
  после плановых документов (`PREPARATION_PLAN`, в эту ветку не входят): «Газуй». Сделано:
  `site/shared/geodesic-grid.js` — Goldberg GP(v,0) для произвольного v (ячейки, соседи, площади,
  черновые адреса `goldberg-gp-v0/...`, `validate()`); `site/shared/planet-noise.js` — simplex vs
  value noise, fBm, касательный warp, сэмплер полей по направлению; `/planet-test/` — WebGL2-глобус
  (веер из центра ячейки, граница по весу центра, атмосфера, вращение/зум/pinch, клик выбирает
  ячейку). Node-замеры: v=64 строится ~250 мс, поля ~50 мс; value noise даёт суперконтинент
  84–85% суши, simplex ~17% — стартовый кандидат simplex f=2.2. Проверка:
  `node tools/check_planet_spike.mjs` (все OK), eslint чисто. Отчёт —
  `docs/stages/stage-1-spike-report.md`. Визуальная часть гейта G1 (вид планет, FPS на устройствах
  пользователя) не закрыта — следующий шаг после его оценки: Этап 1.5 (глобус → плоскость).
  Дополнения по просьбам пользователя: пробел ставит автоповорот на паузу; каскадная анимация
  сборки планеты (19.10) — атрибуты `aCenter`/`aBirth`, юниформ `uBuild` в вершинном шейдере:
  ячейки прилетают волной от северного полюса к южному, атмосфера включается в конце; кнопки
  «собрать заново»/«анимация сборки» и ползунок длительности на той же странице. Пользователь
  одобрил каскад как паттерн поэтапной «загрузки» планеты вместо мгновенного появления —
  переносить в боевую страницу планеты на соответствующих этапах.
  Продолжение 19.10: владелец дал стабильные 50 FPS при v=64 (i5-8400 + GTX 1050 Ti) и запросил
  модель плотности ×8: `tools/bench_planet_density.mjs` — v=192 (368 642 ячеек): сетка 2,3 с,
  поля 341 мс, буферы GPU 146 МБ (оптимизированная раскладка — 89 МБ); на страницу добавлены
  v=128/160/192 и строка стоимости геометрии. Следствие: калиброванный континент при v=192 —
  ~900 ячеек, а не 100; каноничную плотность фиксировать после FPS-тестов владельца (вкл. телефон).
  Генерация вынесена в воркер `site/planet-test/planet-worker.js`: при v>64 главный поток сразу
  показывает прокси v=32 (поля не зависят от v — та же планета), каскад идёт во время фактической
  загрузки, готовая геометрия подменяет прокси; без воркера — синхронный fallback.
  Сводка всего обсуждённого по этапам — живой журнал `docs/stages/stage_patches.md`
  (заведён 19.10 по просьбе пользователя; дописывать по мере этапов).
- Спираль на галактике (18.10, ветка `arena/711432bb-timelineprojectsc2-github-io`, PR #111). Пользователь
  про демо `galaxy-spiral`: «Сделай по нему ревизию для имплементации. Пусть анимация лежит под
  всеми иными анимациями но поверх карты». Исходный коммит перенесён с авторством
  (IntenceResearching), модуль — `site/shared/galaxy-spiral.js`, демо — `/spiral-test/`. На карте —
  `GalaxySpiral.overlay` из `galaxy.js` (`CONFIG.spiral`): холст в `#mapLayer` между картинкой и
  `.lag-fx`. Узор — контраст яркости самой карты (HUD и кадры CAM вырезаны), орбиты подобраны
  разложением карты по лог-спиралям (2 рукава, pitch −14°, бар −48°). Подробно — `AGENTS.md`,
  раздел «Спираль на карте галактики».
  Пользователь: «скоро будет голая карта галактики, будем всё на свежую накидывать по деталям».
  Как перемерить геометрию по новой картинке (Python, numpy + scipy; скрипты были во временной
  папке песочницы):
  1. Яркость рисунка `0.3R+0.59G+0.11B`. Пиксели HUD (`G > 1.04·R`, `G > 40`) исключить и
     заполнить размытием соседей.
  2. Центр `cx, cy` — центроид ярчайших 0,3 % гладкой карты (σ≈6 px на 750 px).
  3. Радиус `r` — по радиальному профилю, где яркость кольца падает до ≈ 25–40 % от диска.
  4. Рукава: перевести кольцо 9–38 % в координаты (θ, u = ln(ρ/r)) и поделить на среднее по
     кольцу. Затем A(m, p) = Σ w·C·e^(−i(mθ+pu)) с весом ρ² и без HUD. Максимум даёт `arms` = m,
     `pitch` = atan(−m/p) (знак — закрутка, «−» против часовой) и φ0 = −arg A. Отсюда
     `psi0` = φ0/m + ln(0.075)/tan(pitch) (0.075 — `rIn` ядра).
  5. Бар — фаза m = 2 по кольцам 7–12 %: угол почти не меняется с радиусом; `barLength` — где
     угол начинает закручиваться.
  Проверка — нарисовать гребни θ = psi0 + kπ + (u − ln 0.075)/tan(pitch) поверх карты.
- Тайминг первого клика (18.10, ветка `arena/f8158b22-timelineprojectsc2-github-io`, PR #109). Пользователь:
  «вычлени для меня переменную с временем приближения после центрирования при первом нажатии,
  я поправлю тайминг». Раньше `focusZoomMs` задавал сразу три движения: приближение после
  центрирования, отъезд при зуме выше цели и приближение перехода. Теперь в `CONFIG` в
  `galaxy.js` у каждого своя переменная: `focusZoomMs` — только приближение после
  центрирования на первом клике; `focusZoomOutMs` — отъезд; у перехода — `diveCenterMs`,
  `diveZoomDelay`, `diveZoomMs`. Значения прежние (520 / 1000 / 650), поведение не изменилось.
  `animateTo` при длительности 0 сразу ставит конечный вид, без деления на ноль.
- Переход в Копрулу (18.10, ветка `arena/ceadf432-timelineprojectsc2-github-io`, PR #108). Пользователь:
  «чтобы было точь в точь как сейчас базовое приближение»; убрать «несуразные линии в центр»
  (диагональные лучи от углов рамки к квадрату — были только референсом движения на картинке);
  рамка вставала криво — несимметрично и не по контуру кнопки. Уточнил: при запуске перехода
  рамка — по контуру квадрата, до этого — как сейчас; две ступени (первый клик — первая, второй —
  вторая), время сократить соразмерно. Теперь второй клик (или «ОТКРЫТЬ КАРТУ»): рамка области
  сжимается по контуру квадрата (`T.contract`, как борд → область при выборе; каналы и блики
  остаются) → центрирование 520 мс → пауза 1 с → приближение до 2000 % за 650 мс (`easeOutCubic`,
  масштаб линейно — как `animateTo` у выбора) → превью внутри рамки → страница сектора.
  Рамка всё время держится за квадрат. В `focus-fx.js` — режим `start({ contour: true, … })`;
  диагональные лучи (`tetherPaths` / `drawTethers`) удалены. Зерус и ОЗД не менялись.
- Продолжение курсора (18.10, ветка `arena/cb421774-timelineprojectsc2-github-io`, PR #104).
  Пользователь согласился с предложенным («делай как знаешь»):
  - колесо — крестовина сразу при нажатии и на галактике;
  - правой кнопкой карты не тащатся, систему атласа не выбирают, крестовины нет;
  - крестовина проявляется за 0,2 с: три кадра `anim.drag.intro` (14/65/90 %), исчезает сразу.

  Смещение креста, как и было, возвращается в центр, когда мышь стоит; замирать, как в коде
  задумки, его не стали. Правило кнопок (`event.button > 1` → выход) общее для `galaxy.js`,
  `app.js` и `cursor-fx.js`, описано в `AGENTS.md`.
- Исправлено 18.10 (ветка `arena/b0883497-timelineprojectsc2-github-io`, PR #106; пользователь:
  «поправь что нужно»). Карточка системы в атласе, которую показывает наведение, теперь
  предпросмотр: мышь проходит сквозь неё (`is-preview`, `syncDetailPreview`). Раньше система
  под панелью справа (на экране 1280 px — правее x≈938) мигала и не выбиралась щелчком: панель
  появлялась поверх системы, холст получал `pointerleave`, панель пряталась. Щелчок в атласе —
  только левой кнопкой, как на галактике; колесо карту только тащит, и колесом крестовина
  сразу и над сектором или системой. Правила — в `AGENTS.md`.
- `site/shared/cursor-fx.js` — системный курсор по задумке пользователя: стрелка с сотами
  (цикл 2,25 с), треугольники «каскад + волна» при наведении (3 с), крестовина при
  перетаскивании (сразу при нажатии на пустом месте карты), приглушённая у недоступного;
  в поле поиска — тоже стрелка.
- Решения пользователя: системный курсор 32 px с покадровой анимацией (не DOM и не гибрид);
  все три страницы; зелёный, как в задумке; наведение на всё кликабельное, включая системы на
  canvas атласа; треугольники наложены, как в задумке.
- Правки после первой проверки пользователя (его образцы — кадры с сотами из ролика SC2 и
  слоёные треугольники): вместо квадратных частиц — соты и обломки-многоугольники; два потока
  из острия по обоим краям, вокруг концов крыльев и по внутренним граням к выемке, где они
  сходятся во вспышке (маршрут подтверждён пользователем). Треугольники — те же 4 слоя и
  каскад, но непрозрачные: каждый закрывает задние, тёмный зазор и кромка, как на образце.
  У пользователя экран 1× — смотреть прежде всего картинку 32 px (на 1× без тонкой светлой
  линии у слоёв, она там рябит).
- Правки после второй проверки: «холд-драг» — крестовина по задумке пользователя (HTML, CSS и
  JS он прислал целиком): четыре пары контурных шевронов #00ff66 остриями к центру, заливка
  «снаружи → внутрь» (@keyframes pulseOuter/pulseInner, цикл 2 с, переходы плавные), свечение;
  крест смещается в сторону движения («физика» dragWrapper: lerp 0,2, предел 15 px задумки →
  до 6 px у нас) и возвращается в центр, когда мышь стоит (в задумке смещение оставалось бы
  до следующего движения). Смещение — сдвиг точки клика в значении `cursor`, кадры те же.
  Включается сразу при нажатии на пустом месте карты (решение пользователя); нажатие на сектор
  или систему — щелчок, пока мышь не сдвинулась (`CONFIG.hold`). Плавное появление креста
  (opacity .2s в задумке) добавлено в продолжении (пункт выше); исчезает он мгновенно.
- «Курсор не работает на странице сектора» (18.10): пользователь развернул ветку в 02:36 UTC,
  а в 02:39 слияние #100 в `main` развернуло `main` поверх. Код сектора проверен — работает.
  Любое слияние в `main` перезаписывает ручной деплой ветки; признак ветки на сайте —
  открывается `/cursor-test/`.
- Кадры меняются в `style` только у элемента под мышью; первая версия меняла общее правило, и
  на 3000 строк каталога это стоило 72 % ядра — теперь 0,6 %.
- Страница `/cursor-test/`, подсказка координат атласа сдвинута правее курсора.
- Что попросить у пользователя после проверки: браузер, ОС, масштаб экрана (кнопка «Скопировать
  отчёт» на `/cursor-test/`), чёткость, анимация при неподвижной мыши, точка клика, размер в
  Safari (известная ошибка — 2× картинка вдвое крупнее), края окна.

Из предыдущих итераций (#91–#98), уже в `main`:

- Первый выбор: рамка строится по пересечению viewport и карты — её стороны следуют камере, а видимые края карты задают реальные границы; входящие линии формируют борд и сжимают его до `data-frame`.
- Если текущий зум выше масштаба, нужного для области, камера сразу отъезжает до него и затем центрирует. Если он ниже — камера центрирует на текущем масштабе, ждёт 1 с и приближает; при равном масштабе только центрирует.
- При смене области существующая рамка плавно перемещается; при панорамировании и зуме она остаётся привязана к карте.
- Опциональный readout координат курсора расположен только на карте сектора: X/Y в системе `mapSize` (обычно 10 000), выключен по умолчанию, включается/отключается кнопкой в панели управления. Shift+клик копирует X/Y через табуляцию. Записи `places` с пустым `system_id` и двумя координатами отображаются как отдельные POI; при указанном `system_id` отдельного маркера нет.

### Этап 9 — проектирование атласа растительности (23.10.2026)

Стадия проектирования (read-only аудит, код рантайма не менялся). Созданы:

- [`stages/stage-9-vegetation-atlas.md`](stages/stage-9-vegetation-atlas.md) —
  аудит фактического состояния (`TERRAIN_FRAGMENT_SHADER` без текстур, воркер без
  климата/биомов, `build_assets.py` без растительного пайплайна), инженерное
  сравнение трёх методов смены местности и растительности (палитра / уникальный
  тайл на биом / гибрид), матрица растительных биомов `tundra`, `boreal_forest`,
  `temperate_forest`, `rainforest`, `grassland`, `shrubland`, `wetland` с точными
  коэффициентами скоринга из `biomeWeights`, состав каналов тайла
  (Albedo + `Height/FoliageMask/Roughness/AO`), формулы `heightBlend` и подавления
  тайлинга, UV-лестница `25 км / 6,25 км / 1,25 км / 312 м` и бюджеты
  (`≈ 15,9 МБ` публикации, `32…64 МиБ` видеопамяти).
- [`prompts/stage-9-vegetation-tiles.md`](prompts/stage-9-vegetation-tiles.md) —
  пакет из 8 промптов (T1a, T1b, T2…T7) с техническими инвариантами
  (`nadir orthographic`, `delit`, `--tile`, читаемость `512²`, отделение
  `FoliageMask`), негативным промптом и критериями приёмки швов и масок.

Найдено для будущих правок: `image_version()` в `tools/build_assets.py` обходит
только верхний уровень `assets/src/` (`SRC.iterdir()`), поэтому поддиректория
`assets/src/terrain/` не попадёт в `imageVersion` — требуется `rglob`; кэш
`pages.yml` и `.gitignore` должны получить `assets/veg/` и `assets/veg-atlas.json`.

## 2. Как устроен репозиторий

```
site/                  ← вход Vite-сборки; публикуется собранная .publish/
├── index.html         карта галактики, открывается по /
├── galaxy.ts  galaxy.css
├── sector/sector.html   вариант-вход атласа (общая разметка — templates/atlas-shell.html)
├── minimal/minimal.html вариант-вход атласа + minimal-skin.css
├── cursor-test/       страница проверки курсора (/cursor-test/, ссылок с сайта нет)
├── spiral-test/       демо и настройка ядра спирали (/spiral-test/, ссылок с сайта нет)
├── planet-globe/      боевой стенд WebGL2-глобуса (planet-globe.ts, planet-globe-worker.ts)
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

## 3. Что сделано по частям

**Картинки и тайлы (главное).** Исходник карты сектора 10 000×10 000 → пирамида WebP 512×512:

| Уровень | Размер | Тайлов | Вес |
|---|---|---|---|
| 0 | 1250² | 9 | 120 КБ |
| 1 | 2500² | 25 | 312 КБ |
| 2 | 5000² | 100 | 852 КБ |
| 3 | 10 000² | 400 | 2.5 МБ |

Грузится только видимое: на стартовый вид 9 тайлов ≈ 120 КБ. Манифест `assets/tiles.json`
(`dir`, `levels`, `version`, `preview`), подложка `map-preview.webp` 2500².
Логотип 2.08 МБ → 32 КБ, карта галактики 6.85 МБ JPEG → WebP 1200 / 2000 / 3000 px
под `srcset` (119 / 250 / 443 КБ), макеты → по 5 КБ. Вес первой загрузки: главная 9.22 МБ → ~0.45 МБ, сектор 2.29 МБ → ~0.35 МБ.
Подложка больше не тянется с Google Drive (`links.js` → `sectorMapPreview: ''`).

**Версии.** Манифест тайлов несёт `version` = первые 8 символов SHA-256 исходника карты
(сейчас `17b60184`); `app.js` добавляет её к адресам тайлов и подложки в рантайме.
`build_assets.py` пишет общий `imageVersion` исходников картинок в `data/meta.json`, а Vite-сборка
при формировании `.publish` подставляет его к ссылкам на собранные `galaxy-map-*`, логотип и макеты.
Исходные HTML/JS ручных `?v=` не содержат; JS/CSS/worker получают контент-хэш прямо в имени файла
публикации. Pages кэширует файлы на 10 минут, без версий после пересборки часть посетителей видела бы старое.

**Чёткость карты галактики.** `sizes="min(100vw, 100vh)"` — сторона карты в покое, поэтому
на первый кадр браузер берёт файл по экрану: 1200 px на обычных мониторах и телефонах,
2000 px на ретине и больших экранах. Слой карты рисуется в реальном размере `base·s`, и при
приближении `sharpenMap()` в `galaxy.js` (вызов из `applyView`) поднимает `sizes` под сторону
слоя с запасом ×3 — первое приближение сразу догружает 3000 px, только вверх. Полосы
«лагов» (`shared/lag-fx.js`) берут `map.currentSrc` в момент запуска эффекта — тот же файл,
что у карты.

**Каталог.** Код поддерживает места без колонки `type` и показывает их как планеты;
`platform` и `other` также сопоставляются с разделами, а фильтры строятся по типам из данных.
В текущих синхронизированных снимках `type` есть в обоих CSV: 11 систем и 5 мест.
Системы из CSV сохраняются в каталоге; маркер получают только при наличии полной
корректной пары явных координат `x`,`y` (в CSV либо явной карте override), без fallback.
В интерфейсе убрано повторение чисел: счётчики остались
в разделах каталога и один динамический счётчик показывает число результатов. Общий текст
«О карте» не называет StarCraft Wiki источником каталога и не описывает внутренние правила
создания POI; канон и ссылки на источники остаются в деталях записей.

**Прелоадер.** Искусственная пауза 1.9 с убрана, экран уходит после первой отрисовки canvas.
Логотип загрузки — с `rel="preload"` и `fetchpriority="high"`, то есть первым в стеке.

**Синк.** Если вместо CSV приходит HTML (таблицу перестали публиковать в интернете),
`sync.py` падает с понятной ошибкой, а не записывает страницу входа в `data/*.csv`.
`GITHUB_TOKEN` используется для чтения через GitHub API и создания issue при ошибке;
источники типа `url` скачиваются без токена. Для отправки обновлённых данных workflow
использует repository secret `SYNC_BOT_TOKEN`.

## 4. Состояние данных и настройки

1. **Доступ синка.** `SYNC_BOT_TOKEN` настроен: запуск #39099888382 от 18.10.2026 завершился успешно; опубликованные листы не отличались от текущих CSV-снимков, поэтому новый коммит не появился. Pages после PR #103 тоже задеплоился успешно. Issues #66, #67 и #69 остаются открытыми, но относятся к прежним сбоям; закрывать их — отдельная уборка.
2. **Текущий формат листов.** Синхронизированные CSV имеют `type` в обоих листах.
   Заголовки и рекомендуемые шаблоны сверять с `docs/ADMIN_GUIDE.md`; при изменении Google
   Sheets ориентироваться на текущую опубликованную строку заголовков, не на старые заметки.
3. **Положение систем на карте.** Снимок содержит 11 систем и 5 мест. Системный CSV
   содержит `x`,`y` (например, Корхал `5720/6257` и Авернус `6524/5788`). Обе явные
   координаты в пределах карты дают маркер; пустые, нечисловые и вне диапазона не дают.
4. **Снимок `data/planet-generation.csv` пока пуст.** В репозитории лежит только строка заголовков
   (37 колонок контракта `planet-generation-contract-v1`), поэтому на сайте ни у одной планеты
   нет статуса `frozen`: досье честно показывает «3D-глобус Голдберга» и «процедурный глобус
   c100-soft-v2», а бейдж `L1 Frozen` появится после первого живого Sync вкладки
   `planet_generation` (`gid=1183479406`). Читается снимок через `mergePlanetGenerationRows`
   (`place_id === String(place.id)`), отсутствие строки — законное состояние, а не ошибка.
5. **Исходник карты заливается вручную** в `assets/src/koprulu-sector.jpg` (решено пользователем).
   После замены файла и пуша тайлы пересоберутся сами — по SHA исходника.

## 5. Что нужно проверить глазами

Агент смотрел скриншоты headless-браузера (кадры перехода, сравнение чёткости на 410 %,
страницы сектора на десктопе и телефоне), но по правилам пользователя финальная
визуальная проверка — его. Перед мержем:

- первый выбор: линии строят борд по пересечению viewport и карты и сжимают его до `data-frame`;
  при текущем зуме выше целевого камера сразу отъезжает, иначе сначала центрируется, ждёт 1 с и приближает;
- рамка следует координатам карты при ручном панорамировании и зуме; смена области плавно
  перемещает существующую рамку. Цвета: Копрулу и ОЗД зелёные, Зерус красный;
- на галактике координатной кнопки и readout больше нет; на карте сектора кнопка в панели
  масштаба включает/полностью отключает X/Y рядом с курсором (изначально выключено), значения
  берутся из мировой системы карты 0…`mapSize` (обычно 10 000) и скрываются вне карты;
- переход в Копрулу (второй клик или «ОТКРЫТЬ КАРТУ»): рамка сжимается ровно по контуру
  квадрата (симметрично, внешний край линии на контуре), каналы от краёв и блики на месте,
  диагоналей нет → квадрат в центр → 1 с → одно приближение до 2000 %, рамка всё время на
  квадрате → превью внутри рамки → страница сектора, всего ≈2,9 с; Зерус и ОЗД — прежние
  финалы; на компьютере и телефоне;
- перетаскивание карты сектора мышью и пальцем, клик по системе с явной привязкой и самостоятельной POI; строки `places` с `system_id` не должны создавать дублирующий маркер;
- системы без явной привязки не получают маркеры, но остаются доступны через каталог;
- проверить каталог: разделы и динамический счётчик не дублируются, мелкий текст читаем, заголовок имеет отступ; обзорный текст не упоминает StarCraft Wiki как источник каталога;
- смена карты галактики на 3000 px при первом приближении — без мигания;
- совпадает ли подложка сектора с точками систем, которым задана явная привязка.
- переход на 3D-глобус (Этап 7): кнопка «Открыть 3D-глобус планеты →» в закреплённом досье места
  и ссылка «🌐 Глобус →» в списке миров системы открывают `/planet-globe/?place=<id>&system=<systemId>`;
  в карточке-предпросмотре ссылок нет (она `pointer-events: none`); обратные ссылки
  `/sector/#planet=<id>` и `/sector/#system=<id>` возвращают в атлас с выбранной записью;
- бесшовный зум: апгрейд прокси → финал без «попа» и без перезапуска с полюса, prefetch не
  заставляет камеру ждать, инспектор ячейки/региона C100/участка `Patch7` считает ключи §8.8;
- локальная 3D-карта и Dive-in (Этап 8, гейт **G4**): кнопка «Погрузиться на локальную карту участка →»
  и ссылка `?place=&system=&cell=&view=local` запускают генерацию на первом кадре подлёта без остановки
  камеры, порционная GPU-догрузка `StructureRenderer` не даёт кадров `> 50 мс`, работают лестница
  масштабов `1250 … 1.2 км`, круговой туман, перецентровка по 6 соседям кольца (`0..5`) и возврат
  на глобус без потери ракурса, а 3D-постройки не спавнятся в воде, озёрах и руслах рек;
- курсор (`/cursor-test/` и три страницы сайта): анимация стрелки и треугольников, в том числе
  при неподвижной мыши; чёткость на 100/125/150 % и ретине; точка клика; у краёв окна курсор
  не подменяется стандартным; Chrome/Edge, Firefox, Safari. Headless курсор не показывает.

## 6. Прицел: выбор и переход (актуальная логика)

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

## 7. Инфраструктурные грабли

- **Снапшот теряет бинарники.** Между сессиями `assets/src/` (30 МБ) и собранные
  `assets/tiles/` исчезали, а указатель ветки откатывался на `main`. Лечится:
  `git fetch -q origin <ветка> && git reset --hard FETCH_HEAD`, затем Pillow в venv
  (`python3 -m venv /tmp/venv && /tmp/venv/bin/pip install -r tools/requirements.txt`; системный
  pip упирается в PEP 668) и `/tmp/venv/bin/python tools/build_assets.py`.
  Сборка картинок детерминирована — `imageVersion` в `meta.json` совпадает, исходный HTML/JS не переписывается.
- **jsdom не умеет canvas**, и `app.js` на этом останавливается — без подмены контекста
  прогон проверяет только загрузку, а не сам атлас. Стенд лежит в `/home/user/smoke2`
  (вне репозитория, не сохраняется): `mkdir -p /home/user/smoke2 && cd /home/user/smoke2 &&
  npm init -y && npm i jsdom`. Там `run.js` подменяет `getContext` прокси-заглушкой и
  подсовывает данные через `window.__MAP_DATA__`, собранные из `data/systems.csv` и
  `data/places.csv`. Плюс `matrix.js` — матрица «тип места → вкладка».
- **Сеть ограничена**: `github.com`, `codeload.github.com`, `api.github.com`,
  `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. До боевого сайта из bash не
  достучаться; `fetch_page` открывает HTML, но на `.csv`/`.json` отдаёт 500.
- **Права токена**: нельзя менять настройки Pages (403) и нельзя запускать
  `workflow_dispatch` (403). Деплой происходит только пушем в `main`, то есть мержем PR.
- **В Git — только исходники.** `assets/tiles/`, `assets/tiles.json`, `assets/map-preview.webp`
  и собранные `*.webp` в `.gitignore`; не коммитить их.
- **На `main` действует ruleset «ArenaOverwrite»** (с 17.10): обновлять ветку могут только те,
  кому разрешён обход (админ, интеграция Arena), и история должна быть линейной — merge-коммит
  запрещён. `mergeStateStatus` у PR из-за этого `BLOCKED`; мерж — `gh pr merge <номер> --squash --admin`
  (или `--rebase --admin`, если коммиты ветки нужно сохранить по отдельности).
- **Переезд `ubuntu-latest` на Ubuntu 26.04** — с 19.10 по 19.11.2026 (actions/runner-images#14748).
  Деплой к нему готов: Python 3.12 ставит `actions/setup-python` (в образе 26.04 он есть в кэше,
  системный там — 3.14), Pillow зафиксирован в `tools/requirements.txt` (`pillow>=13,<14`, колёса
  есть под 3.12–3.14). `check.yml` собирает сайт на `ubuntu-24.04` и `ubuntu-26.04` в каждом PR.
  Если деплой всё же упадёт на новом образе — в `pages.yml` поставить `runs-on: ubuntu-24.04`
  (одна строка, там же комментарий).
- **Экшены — на Node 24** (Node 20 на раннерах GitHub выводится из эксплуатации, старые мажоры
  давали предупреждения): `checkout@v7`, `setup-python@v7`, `setup-node@v7`, `configure-pages@v6`,
  `upload-pages-artifact@v5`, `deploy-pages@v5`, `upload-artifact@v7`. `upload-artifact@v5` и
  `configure-pages@v5` — ещё Node 20, ниже этих версий не опускаться.
- **Headless Chromium для скриншотов**: `npm i puppeteer-core @sparticuz/chromium` во временной
  папке, распаковать `node_modules/@sparticuz/chromium/bin/al2023.tar.br` (brotli + tar) в
  `libs/` и запускать с `LD_LIBRARY_PATH=<папка>/libs/lib:<папка>/libs`; модуль экспортирует
  `default`. В первые секунды над страницами висит прелоадер — кликать по карте только когда
  `document.elementFromPoint` в центре квадрата возвращает сам квадрат. Скриншот во время
  перехода на глубоком зуме идёт секундами: кадры снимать с остановленным временем
  (подмена `performance.now`, rAF и таймеров).
- `data/meta.json` пишут два скрипта: `sync.py` (источники, sha, размеры) и
  `build_assets.py` (`mapSize`, `assets.hasRaster`, версии). Ключи друг друга они не затирают.

- **Незакоммиченная работа гибнет с песочницей (казус CR-01 PR 4, октябрь 2026).**
  Старая сессия реализовала весь PR 4 и не закоммитила ничего; песочница
  умерла — потеряно всё, включая `/tmp`. Владелец приказал восстанавливать
  с нуля на новой ветке и прислал логи сессии (`commands.txt`,
  `dialog (6).txt`), из которых извлекли payload'ы модулей и эталоны.
  Протокол против повторения — `AGENTS.md`, раздел «Сохранность работы»:
  в начале задачи ветка и одна перепроверка совершения изменений
  (коммит → push → HEAD равен origin), дальше коммит после каждого этапа.
- **Гонка инструментов записи.** Запись файла и зависящая от него
  shell-команда (append, склейка частей) в одном блоке выполняются
  параллельно — команда читает пустой или частичный файл. При
  восстановлении так дважды терялась часть `planet-geography.ts`.
  Зависимые шаги слать строго разными сообщениями.
- **Индикаторы UI — не источник правды.** Счётчик изменённых строк Arena
  зависал («+712») и выглядел как потеря данных; по git потерь не было.
  Сохранность проверять только `git status` и сравнением HEAD с origin.
- **Логи старых сессий сплющены**: `//`-комментарии «съедают» следующий
  код, а имена в конспектах искажаются (при восстановлении surface
  всплыли несуществующие `plateTop1Id`/`biomeBlendWidth` вместо реальных
  `plateId`/`biomeSoftWidthCells`, а также выдуманные формулы дренажа и гор).
  Извлечённый код разрезать по смыслу, сверяться с эталонными файлами
  репозитория напрямую и валидировать tsc + побитовым FULL EQ; эталоны
  для сверки брать из репозитория, не из `/tmp` (относительные пути).

## 8. Как проверять изменения

То же самое в каждом PR делает `.github/workflows/check.yml` (`actions/setup-node@v6` с `.nvmrc=24` и
`actions/setup-python@v6` с `.python-version=3.12`, сборка на Ubuntu 24.04 и 26.04, `npm run typecheck`, `npm run lint`, тесты). Локально:

```bash
npm ci                                          # единый package-lock.json (Vite, TS 7, ESLint, AssemblyScript)
npm run typecheck                               # tsc --noEmit
npm run lint                                    # eslint site src
npm run build                                   # tsc --noEmit + Vite (tools/vite/*) -> .publish/
npm run verify:publish                          # маршруты, manifest, hashed-ассеты и паритет экспортов
npm run verify:contract                         # Python ↔ TypeScript: пресеты, манифест, PG1 и оба формата approved_at
npm test                                        # все 8 тестовых файлов Node (--test)
npm run test:py                                 # Python unittest (test_planet_generation.py, test_sync.py)
python3 tools/sync.py --strict                  # строгая валидация CSV, координат 0..mapSize, places и дублей ID
python3 tools/build_assets.py --check           # свежесть собранных картинок
python3 tools/planet_generation.py validate     # снимок профилей против places
node tools/bench_local_map_stage8.mjs           # CPU-гейт G4 локальной карты (v=64 и --v=128)

# предпросмотр: .publish уже собрана как при деплое
python3 -m http.server 8080 --bind 0.0.0.0 --directory .publish

cd /home/user/smoke2 && node run.js             # прогон трёх страниц на данных из CSV
```

Курсор (`cursor-fx.js`) в headless-браузере не виден, а `matchMedia('(any-pointer: fine)')`
там ложно — модуль не включается. Для проверок подменяйте `matchMedia` до загрузки страницы
(`page.evaluateOnNewDocument`) и сверяйте вычисленный `getComputedStyle(el).cursor` по
состояниям, смены `style` у элемента под мышью (MutationObserver) и `CursorFx.info()` /
`CursorFx.frames()`. Стоимость — CDP `Performance.getMetrics` (`TaskDuration`,
`RecalcStyleDuration`) с курсором и с `?cursor=off`. Учтите, что `?cursor=off` запоминается:
следующую страницу открывайте с `?cursor=auto`.

## 9. Правила пользователя

- Комментарии, тексты интерфейса и сообщения коммитов — **по-русски**.
- Общую разметку `sector.html` и `minimal.html` править один раз в `templates/atlas-shell.html`;
  различия вариантов — только в `atlasVariants` внутри `vite.config.mts`. Сами
  `site/sector/sector.html` и `site/minimal/minimal.html` — тонкие входы вариантов, не копии разметки.
- Работаем только в своей ветке; в `main` не пушим. Путь: правки → коммит → PR →
  пользователь смотрит → `gh pr merge <номер> --merge` (с 17.10 ruleset на `main`
  требует линейную историю — мержить `--squash --admin` или `--rebase --admin`, см. §7).
- Крупные правки показывать до мерджа: агент не видит результат глазами, визуальную
  проверку делает пользователь.
- Коммитить исходники картинок, а не производные файлы.
