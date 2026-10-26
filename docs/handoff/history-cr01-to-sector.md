# История: от CR-01 и волн к сектору

> Назад: [документация](../README.md) · [шаг 0 консолидации](../consolidation/README.md)

## CR-01

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

## Волны 22–23.10

Что изменено (подробно — в `CHANGELOG.md`, правила — в `AGENTS.md`, `site/AGENTS.md`, `src/AGENTS.md`, `tools/AGENTS.md`):

- **Stage-8.7 и интеграционные фиксы 8.7.1 / 8.7.2** (PR #202 `4e86363`, #200 `257bd89`, #199 `a0c167e`, #198 `0f338a0`, #203 `282d726`, #204 `a24bfe8`; **слиты в `main` 23.10**). Воркер генерирует кольцевые области `1–5` (`6/12/18/24/30` ячеек, накопительно `1 → 7 → 19 → 37 → 61 → 91`, LOD `[256, 64, 32, 16, 8, 4]`, `ringGenMs ≈ 7 мс`, CPU-буферы `≈ 216 КиБ`; кольца 2–5 — плоская гексагональная решётка в касательной плоскости, `ringCells[i].cell` — синтетический индекс отрисовки, навигация разрешена только по каноническим `patch.cells[1..6]`). Рендерер держит GPU-буферы колец `2,4 МБ` и рисует `2 + число колец` terrain-батчей в порядке `5 → 4 → 3 → 2 → 1 → центр → юбка`. Камера локальной карты переведена с перелётов на атомарный ре-бейзинг `rebaseLocalCameraState` с шагом `d_hex = 1.15 · R_patch`, сглаживанием остатка `≤ 220 мс` и диагностикой G6.1 за `?debug=local`. Модуль `site/planet-globe/local-map-quick-nav.ts` рисует голографические квик-стрелки на гранях активного гекса (`7 200 мс` цикл, `2 600 мс` окно, `90 мс` задержка по слотам `0..5`, `fade-in 180 / fade-out 260 мс`, hit-area `≥ 44 × 44 px`, `prefers-reduced-motion` без пульса). Фикс PR #203 выровнял `RING_HF_RES` (`92` draw → `7`), разделил гейт **G6.3** на CPU (`≤ 512 КБ`, `ringGenMs ≤ 20 мс`) и GPU (`≤ 4 МБ`, шов, steady `p95`) и оформил разбор внешнего аудита ядра в [`stages/planet-core-audit-2026-10-23.md`](../stages/planet-core-audit-2026-10-23.md) (`A-1…A-7`); фикс PR #204 заменил временный шим квик-навигации на боевой модуль; `npm test` — **122/122** в 13 файлах.
- **Stage-8.6** (PR #192 `03b5f47`, #194 `6d483a7`, #193 `8eae2ab`; **слита в `main` 23.10**). Общий `planetSeed = hashSeed(patch.seed, 0x534b5254)` синхронизирует юбку соседних ячеек; озёрная калибровка положительной высоты разрешена только при `centerCell.lakeWeight > 0 && centerCanonElev > patch.seaLevel`. `neighborBlend` сохраняет отрицательную батиметрию `z < 0`. Русла проходят на любой высоте: `terraformMap = 0` в стрежне, продолжение на юбку, `isRiverStream` и галечно-песчаная пойма `riverBankMask`. Суша разделена на 5 метрических поясов `0–7 / 7–85 / 85–175 / 175–290 / >290 м` с `beltJitter`; вода получила `waterDepthM`, двухоктавную `waveRipple`, Fresnel, солнечный `waterSpec` и `foamLine`. `LOCAL_REST_YAW = -Math.PI / 2` ориентирует верх кадра на Север (`С`), переход к соседу не вставляет кадр сброса камеры; 91/91 тестов Node.
- **Stage-8.5 и хотфиксы 8.5.1 / 8.5.2** (PR #189 `55fde09`, #187 `3041eb0`, #188 `7b7b0b6`, #190 `81c5b2a`, #191 `4f5e335`; **слиты в `main` 23.10**). `LOCAL_PATCH_BASE_RADIUS_M = 2500 м` и `patchPhysicalHalfSpanM` фиксируют физический размер участка отдельно от видимой ширины `#localScaleSel`; все 11 значений `1250 … 1.2 км` управляют логарифмической дистанцией и наклоном камеры при `localMaxCameraDistance = 18 * R_patch`. В `terraformMap` появился явный маркер воды, гладкая интерполяция `Patch7`, билинейное сглаживание зон и тактическая кромка гекса; хотфиксы восстановили переход к соседям, мягкую линию прибоя и возврат камеры в долину после панорамирования.
- **Stage-8.4** (PR #184 `bf9351c`, #185 `eaa6a44`, #186 `1378759`; **слита в `main` 23.10**). Юбка расширена до 10 колец (`145 × 85 = 12 325` вершин, `72 960` индексов), рельеф непрерывен на границе активного гекса; первые 3–4 круга чёткие без шва/блюра (`fogStart = 0.64 * outerRadiusM`), камера скользит между соседними гексами за `820 мс`.
- **Stage-8.3** (PR #183 `950bf76`, #182 `fe7d0af`, #181 `653d2eb`; **слита в `main` 23.10**). Планетарная кривизна юбки `58 * R_patch`, хребты `ridgedMF`, природная долина, дневной купол и облака; `LOCAL_REST_PITCH = 0.31` даёт панорамный взгляд из долины вместо отвесного ракурса.
- **Stage-8.2.1** (PR #180 `ace0c74`; **слит в `main` 23.10**). Зеркало континентальных озёр сохраняется на юбке горизонта; постройки не спавнятся на воде.
- **Этап 9 и Этап 10** (PR #170 `c621176`, #168 `9c38a19`; **слиты в `main` 23.10**). Проект гибридного атласа растительности, бюджетов и генерации тайлов в `docs/stages/stage-9-vegetation-atlas.md` и `docs/prompts/stage-9-vegetation-tiles.md` (проект, не внедрение рантайма); планово-типовой оценочный вариант страницы системы Этапа 10 в `docs/PREPARATION_PLAN.md` §12.
- **Stage-8.1 и промежуточный эксперимент** (PR #169 `5d0e0ce`, #171 `334b4c1`, затем #172–#175; **слиты в `main` 23.10**). Сферическая юбка шести колец и сшивка высот дали основу горизонта; экспериментальная семигексная «ромашка» с фасками и прозрачным кластером заменена непрерывной юбкой Stage-8.2.
- **Стабилизация Stage-8** (PR #163 `d6fca78`, #164 `2bffeca`, #165 `ad19722`, #166 `d18f63f`, #167 `fe72ada`; **слита в `main` 22–23.10**). Исправлены компиляция WebGL2-шейдеров и Dive-in, полноэкранный слой и спавн построек на `v=128`, поддержка `c100-soft-v2` в `createPatchFieldSampler`, чистота URL, кликабельные хлебные крошки и ссылка на сектор.
- Волна **Stage-8.2** (`Tri-Agent Wave`, 23.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §10; Воркер 1 — PR #178 `9c0beb6` (`generateHorizonSkirt` и тесты), Воркер 2 — PR #179 `7179486` (шейдеры выделенного гекса и деградация видимости), Воркер 3 — PR #177 `fc555e3`; **слита в `main` 23.10**).
  Возврат естественной непрерывной сферической модели горизонта без «пластилиновой ромашки» из 7 подушек и без просвечивающего сзади несоразмерного глобуса (`Zero File Overlap`):
  1. **Воркер 1 (непрерывная юбка горизонта):** возвращена полярная сетка `generateHorizonSkirt` (`SKIRT_ANGULAR_SEGMENTS = 96`, `SKIRT_RADIAL_RINGS = 56`, `SKIRT_COLLAR_RINGS = 14`, `5 529` вершин, `32 256` индексов, `outerRadiusM = 6.5 * hexSpacingM`, `planetRadiusM = 3.6 * outerRadiusM`) без 6 отдельных плит-лепестков и без провалов `bevelDropM`; воротник сшит с `innerHeightfield` по гексагональной метрике `clusterHexMetric(x, y) = hexMetric2D(y, x)` на границе `hexApothem = 0.8054 * radiusPatchM`; `tests/local-map-stage8.test.mjs` обновлён под непрерывную юбку.
  2. **Воркер 2 (только активный гекс и дымка горизонта):** в `TERRAIN_FRAGMENT_SHADER` квадратный центральный меш обрезается по контуру одного гекса (`centerHexDist > u_focusRadiusM * 0.8054`), убраны закраска `FACET_BASE_COLOR`, фаски 6 соседей и 6-кольцевая сетка; добавлены многомасштабная процедурная текстура рельефа и плавное затухание деталей/нормалей в `u_horizonColor`/`u_fogColor` при непрозрачном куполе неба (`u_skyAlpha = 1.0`).
  3. **Воркер 3 (непрозрачный горизонт и плавный двухфазный спуск):** в `site/planet-globe/planet-globe.css` `.local-map-stage` получил непрозрачный фон `radial-gradient(circle at 50% 36%, rgba(8, 28, 39, 0.94), rgba(3, 10, 16, 0.99))` и переход `opacity 0.42s cubic-bezier(0.22, 1, 0.36, 1)`; в `site/shared/planet-globe.ts` `MIN_DISTANCE` снижен с `1.35` до `1.15`, добавлен коллбэк `onZoomDive?: () => void` (колесо вглубь при `targetDistance <= MIN_DISTANCE * 1.03`, не чаще одного раза в 500 мс); в `site/planet-globe/planet-globe.ts` убран ежекадровый `syncGlobeWithLocalCamera` (вместе с `localGlobeDirection`), рендер очищается непрозрачным `clearColor(0.015, 0.045, 0.075, 1)` (канвас — `alpha: false`), реализован двухфазный спуск: фаза 1 — `globe.flyToDirection(center, 1.16, 420)` параллельно с `generateLocalMap` + `generateHorizonSkirt`; фаза 2 — через `320 мс` (сверка `requestId === localMapEntrySeq`) проявление `#localMapStage` и `startLocalDiveInAnim` (`1150 мс`, `fromDist = targetDist * 4.8`, `fromPitch = 1.30` рад → `LOCAL_REST_PITCH = 0.44`, `fromYaw = LOCAL_REST_YAW - 0.24`, `fromTarget = [0, 0, target[2] + 0.18 * R_patch]`, `easeInOutCubic`); переход к соседнему гексу внутри открытой карты выполняется сразу через `startLocalNeighborFlyAnim(azimuth)`; зум колесом и pinch расширены до `Math.max(2, 0.045 * R_patch)` вглубь и `5.8 * R_patch` при отдалении с возвратом на глобус (`exitLocalMap`) на верхнем пределе; при выходе глобус один раз доворачивается к центру активной ячейки и плавно отводит дистанцию `flyToDirection(centerDir, 2.85, 680)`.
- Волна **Stage-8** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §9; Воркер 1 — [PR #161](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/161), Воркер 2 — [PR #160](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/160), Воркер 3 — PR #162 `af30a6e`; **слита в `main` 22.10**).
  Этап 8 мастер-плана (`docs/PREPARATION_PLAN.md` §9.4, §9.5, §9.5.1, §12 и Патч 8): локальная 3D-карта участка `Patch7`, порционная GPU-догрузка `StructureRenderer`, интерактивный Dive-in экран и проверка гейта **G4** (`Zero File Overlap`):
  1. **Воркер 1 (непрерывность рельефа и рек по И-3, порционная GPU-догрузка и тесты — PR #161):** в `src/local-map/local-map-worker.ts` базовая высота `heightfield` ($256 \times 256$) привязана к каноническим полям `Patch7` (`patchBaseElevation` / `filledElevation - seaLevel`, `waterLevelOf`, выемка русла вдоль `patch.river.inlets` → центр → `patch.river.outlet` и 3D-шум через `samplePatchFields` при переданном `profile`), добавлен LRU-кэш локальных участков (до 8 записей) и расширен `LocalMapMeta` (`totalInstances`, `buildableFraction`, `waterFraction`, `genMs`); в `src/local-map/local-map-renderer.ts` и `src/local-map/local-map-shaders.ts` внедрено предвыделение `terrainVAO` (`gl.UNSIGNED_INT`) и `instanceVBOs` один раз при инициализации и методы порционной GPU-догрузки `enqueueWorkerData(data, budgetMs?)`, `processPendingUpload(budgetMs?)`, `isUploading()`, `getUploadProgress()`, `compilePrograms()`, `renderFrame(viewProj, lightDir, options?)` и `dispose()` через `gl.bufferSubData` по кадровому бюджету `<= 3 мс` без пересоздания VAO (с сохранением синхронного `onWorkerData`); добавлен тест `tests/local-map-stage8.test.mjs` и подключён в `npm test`.
  2. **Воркер 2 (интерактивный 3D-экран локальной карты и Dive-in переход в `/planet-globe/` — PR #160):** в `site/planet-globe/{index.html,planet-globe.css,planet-globe.ts}` добавлены оверлей `#localMapStage` (`#localMapCanvas`), кнопка погружения `#diveLocalMapBtn` в `#patchInspector`, глубокая ссылка `?place=&system=&cell=&view=local`, запуск `generateLocalMap` по активному `Patch7` на первом кадре подлёта без остановки камеры глобуса, порционная загрузка данных в `StructureRenderer` (`enqueueWorkerData`/`processPendingUpload` с fallback на `onWorkerData`), плавное проявление (`fade-in`) 3D-сцены с управлением камерой (орбита, наклон, панорамирование, зум), селектор видимой ширины `#localScaleSel` (`1250 → 625 → 312 → 156 → 78 → 39 → 20 → 10 → 5 → 2.5 → 1.2 км`), кольцо перецентровки по 6 соседним ячейкам `#localNeighborNav` (`0..5`), `#localMapHud` и возврат `#exitLocalMapBtn` без сброса ракурса.
  3. **Воркер 3 (CLI-бенчмарк гейта G4 и сводная документация — PR #162):** создан `tools/bench_local_map_stage8.mjs` (`v=64` по умолчанию и `--v=128` для полной Земли; 3 seed `earthlike_balanced`, 4 шестиугольных архетипа — `dry_plain`, `river_junction`, `lake_basin`, `coastline`, 4 ступени `1250 / 78 / 10 / 1.2 км`, 144 прогона на частоту): `buildMeshLibrary` (12 модулей, 413 вершин, 12 384 Б) — median `0,114 мс` (`v=64`) / `0,109 мс` (`v=128`); `buildPatch7 + verifyPatchInvariants` (`ok === true` на `12/12`) — median `0,0811 мс` (`v=64`) / `0,0690 мс` (`v=128`); `generateLocalMap` — **median `27,435 мс`, p95 `34,854 мс`, max `45,426 мс` на `v=64`** и **median `26,482 мс`, p95 `30,999 мс`, max `50,304 мс` на `v=128`** при критерии гейта **G4** `<= 150 мс` (запас `~5,5–5,7×` по медиане); **`0` нарушений `buildingSpawnMask`** во всех `288` генерациях. Оформлен отчёт `docs/stages/stage-8-local-map.md` и блоки «Факт Этапа 7» / «Факт Этапа 8» в `docs/PREPARATION_PLAN.md`.
- Волна **Stage-7** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §8; [PR #155](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/155), [PR #156](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/156), [PR #157](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/157), [PR #158](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/158) — **слиты в `main` 22.10**).
  Этап 7 мастер-плана (`docs/PREPARATION_PLAN.md` §12 и §8.8): страница планеты, бесшовный зум Голдберга и прямой переход из атласа сектора (`Zero File Overlap`):
  1. **Воркер 1 (бесшовный зум и `Patch7`):** в `site/shared/planet-globe.ts` добавлены `transitionGeometry(nextGeometry, durationSec?)` (уходящий `prevVao` с `uHide = progress`, новый `vao` с `uCenterGrow = progress`, буферы `prevVao` освобождаются сразу по завершении волны), `flyToDirection(direction, targetDistance?, durationMs?)`, `getCameraState()` и `onCameraIntent` (debounce 180 мс); в `site/planet-globe/planet-globe-worker.ts` — команды `prefetch` (latest-wins по `token`/`requestId`, прогрев `GridCache`, `GeodesicGrid.getChunkNeighbors`, упреждающая сборка `Patch7`) и `extract-patch` (`buildPatch7` + `verifyPatchInvariants` + `patchSpanMeters` + `buildBuildingSpawnMask` строго на `canonicalV`, авто-привязка 5-угольных полюсных ячеек к ближайшему 6-угольному соседу, ключи §8.8); тесты `tests/planet-stage7-worker.test.mjs` и подключение файла в `npm test`.
  2. **Воркер 2 (страница планеты):** `/planet-globe/` читает `places.csv` + `systems.csv` + `planet-generation.csv`, строит хлебные крошки `Галактика → Сектор Копрулу → Система → Планета`, держит стабильные URL `?place=&system=&cell=`, показывает `verifyGenerationKey(profile)` (И-4: `L1 Frozen` vs `L0 Draft`), вызывает `transitionGeometry(geometry, 0.45)` на апгрейде прокси-шара и отправляет `prefetch` по `onCameraIntent`, а также выводит инспектор канонической ячейки, континентальной области C100 и среза `Patch7` (`local-map-patch-v1`, И-1 и И-3) с ключами `planet_key` / `region_key` / `cell_key` / `patch_key` и копированием прямой ссылки на ячейку.
  3. **Воркер 3 (переход из атласа и сводная документация):** `PlaceRecord` получил `planetProfileStatus` / `planetPresetId` / `planetRadiusKm` / `planetGenerationKey` (`PlanetProfileStatus = 'draft' | 'review' | 'frozen'`), константу `PLANET_GLOBE` и `CONFIG.data.generation`; `loadDataset()` грузит `/data/planet-generation.csv` в обеих ветках и обогащает записи через `mergePlanetGenerationRows` (сопоставление по `place_id`, валидация статуса и радиуса); в досье появились `isGlobeCapablePlace` (`planet`/`moon` или заполненный профиль), `planetGlobeUrl` (`/planet-globe/?place=<id>&system=<systemId>`), бейдж статуса 3D-профиля, кнопка `.detail-globe-button` в блоке `.detail-globe-cta` и компактная ссылка `.world-globe-link` в списке миров; `applyHash()` понимает обратные ссылки `/sector/#system=<id>` и `/sector/#planet=<id>`; стили — в `site/shared/timeline-skin.css`; инвариант `#detailPanel.is-preview { pointer-events: none }` сохранён. Отчёт — `docs/stages/stage-7-planet-page.md`.
- Волна **Wave-DX-1** (`Tri-Agent Wave`, 22.10; координируется Гайдлайнером по `docs/agents_task_orchestration/agents_task_orchestration.md` §7; Воркер 1 — [PR #148](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/148), Воркер 2 — [PR #149](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/149), Воркер 3 — PR #151 `eaa4b76`; **слита в `main` 22.10**).
  Улучшение Developer Experience, воспроизводимости CI, строгой валидации синхронизации и иерархии документации агентов в трёх непересекающихся потоках (`Zero File Overlap`):
  1. **Воркер 1 (Среда, зависимости, CI и конвейер Vite — PR #148):** добавлены `.nvmrc` (`24`) и `.python-version` (`3.12`); `.github/workflows/check.yml` переведён на `actions/setup-node@v6` и `actions/setup-python@v6` с явными проверками `npm run typecheck` и `npm run lint`; `assemblyscript` и стек `eslint` включены в `devDependencies` и атомарно зафиксированы в `package-lock.json` (при сохранении `typescript@^7.0.2` через `@typescript/native` и `@typescript/typescript6` для совместимости с `@typescript-eslint/*`); в `npm test` явно перечислены все 8 тестовых файлов, добавлен `npm run test:py`; `vite.config.mts` декомпозирован (до ~120 строк) на модули `tools/vite/{asset-utils,atlas-shell,timeline-publish-pipeline}.ts` с единым объектом состояния `PublishPipelineState`.
  2. **Воркер 2 (Строгий синк `--strict`, диагностика HTML и проверка `approved_at` — PR #149):** в `tools/sync.py` добавлен режим `python3 tools/sync.py --strict` (проверка числовых координат `0 <= x, y <= mapSize`, конфликта одновременного указания `system_id` и ручных `x, y` в `places`, дублей непустых `id` во всех таблицах); расширена диагностика `looks_like_html(...)` с чек-листом публикации CSV в Google Sheets и обновлено руководство `docs/ADMIN_GUIDE.md`; добавлены модульные тесты в `tests/test_sync.py`; `tools/verify_planet_contract_cross.mjs` расширен на детерминированную проверку обоих форматов `approved_at` (`YYYY-MM-DD` и ISO datetime с `Z`).
  3. **Воркер 3 (Иерархия `AGENTS.md` по принципу SSoT и сводка волны — PR #151):** корневой `AGENTS.md` (~154 строки) разгружен до общих правил репозитория, карты маршрутов/директорий и команд проверки; созданы доменные инструкции `site/AGENTS.md`, `src/AGENTS.md` и `tools/AGENTS.md` (~60–70 строк каждая) без дублирования правил корня; результаты волны `DX-1` зафиксированы в `docs/HANDOFF.md` и `CHANGELOG.md`.
- Волна **PR 6.1** (`Tri-Agent Wave`, 22.10; [PR #145](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/145), [PR #146](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/146), [PR #147](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/147) — **слиты в `main` 22.10**).
  Устранение регрессий стенда `/planet-test/` после консолидации PR 5 и синхронизация мастер-плана `docs/PREPARATION_PLAN.md` с выполненной архитектурой `CR-01` в трёх непересекающихся потоках (`Zero File Overlap`):
  1. **Воркер 1 (FX-геометрия, объём осколков и ядро Шакураса):** перенос клеточной раскладки осколков в строгий TypeScript (`computeShardLayout` с режимами `equal`/`power`/`lognormal`, параметрами `shardThick`, `shardJag`, `shardLoss` и назначением осколка строго по ячейке `vertexCellId` вместо вершинного `fxShardIndex`), удаление последнего легаси-модуля `site/shared/planet-geometry.js` по Инварианту И-5, возврат 3D-объёма осколков (`VS_VOLUME/FS_VOLUME`: боковые стенки разломов и закрытая нижняя оболочка) и светящегося ядра Шакураса (`VS_CORE/FS_CORE` с дефолтным `coreScale=0.55`) в `src/planet/planet-globe-fx.ts` через хуки `PlanetGlobeFxHooks` (`onGeometryUploaded`, `onAfterSurfaceDraw`, `onDispose`), а также тесты `tests/planet-globe-fx.test.mjs`.
  2. **Воркер 2 (Каскадная сборка, центробежное замещение и UI `/planet-test/`):** восстановление в `site/shared/planet-globe.ts` каскадной сборки глобуса от полюса к полюсу (`uBuild`) и двухслойного центробежного замещения прокси-шара детальным слоем (`uHide`, `uCenterGrow`), подключение расширенных FX-хуков жизненного цикла геометрии и восстановление полного набора контролов (`#panelToggle`, `#spinBtn` + `Space`, `#bordersBtn`, `buildSec`/`buildBtn`/`buildAnimBtn`, `coreScale`, `shardDist`, `shardThick`, `shardJag`, `shardLoss`) и скользящего 10-сек окна телеметрии кадра (`p50/p95/p99`, `>50ms`, `>100ms`, `worst5`, адрес выбранной ячейки) в `site/planet-test/*`.
  3. **Воркер 3 (Мастер-план и сводная документация волны):** актуализация `docs/PREPARATION_PLAN.md` (Раздел 1–2 и Этапы 3–6 под стек `.ts` + гибридный Wasm `planet-core` с фактическими таймингами PR 6 `> 3,0×` при 100 % FULL EQ и единым ядром глобуса + `planet-globe-fx.ts`; Этап 7 дополнен требованиями `uBuild`, двухслойного `uHide`/`uCenterGrow`, `intent-based worker prefetch` и контрактом сшивки 7 ячеек `local-map-patch-v1` по И-3; Этап 8 дополнен 4 модулями `src/local-map/*`, `buildingSpawnMask` по И-3.4 и требованием порционной staged GPU-догрузки `StructureRenderer` без фризов и без пересоздания VAO) + сводная запись волны в `docs/HANDOFF.md` и `CHANGELOG.md`.

## Этап 9

### Этап 9 — проектирование атласа растительности (23.10.2026)

Стадия проектирования (read-only аудит, код рантайма не менялся). Созданы:

- [`stages/stage-9-vegetation-atlas.md`](../stages/stage-9-vegetation-atlas.md) —
  аудит фактического состояния (`TERRAIN_FRAGMENT_SHADER` без текстур, воркер без
  климата/биомов, `build_assets.py` без растительного пайплайна), инженерное
  сравнение трёх методов смены местности и растительности (палитра / уникальный
  тайл на биом / гибрид), матрица растительных биомов `tundra`, `boreal_forest`,
  `temperate_forest`, `rainforest`, `grassland`, `shrubland`, `wetland` с точными
  коэффициентами скоринга из `biomeWeights`, состав каналов тайла
  (Albedo + `Height/FoliageMask/Roughness/AO`), формулы `heightBlend` и подавления
  тайлинга, UV-лестница `25 км / 6,25 км / 1,25 км / 312 м` и бюджеты
  (`≈ 15,9 МБ` публикации, `32…64 МиБ` видеопамяти).
- [`prompts/stage-9-vegetation-tiles.md`](../prompts/stage-9-vegetation-tiles.md) —
  пакет из 8 промптов (T1a, T1b, T2…T7) с техническими инвариантами
  (`nadir orthographic`, `delit`, `--tile`, читаемость `512²`, отделение
  `FoliageMask`), негативным промптом и критериями приёмки швов и масок.

Найдено для будущих правок: `image_version()` в `tools/build_assets.py` обходит
только верхний уровень `assets/src/` (`SRC.iterdir()`), поэтому поддиректория
`assets/src/terrain/` не попадёт в `imageVersion` — требуется `rglob`; кэш
`pages.yml` и `.gitignore` должны получить `assets/veg/` и `assets/veg-atlas.json`.

## Под-уровень сектора

### Под-уровень Этапов 9–12 — глубинный секториальный рендер (24.10.2026)

Стадия проектирования в параллельном режиме: планетарный контур отложен и не менялся,
код рантайма сектора тоже не менялся. Создан
[`stages/stage-9-12-sector-deep-render-plan.md`](../stages/stage-9-12-sector-deep-render-plan.md)
(≈ 50 КБ) и обновлены `PREPARATION_PLAN.md` §12, `PREPARATION_PLAN_ADMINS.md` и `CHANGELOG.md`.

- **Проверка расчётной базы владельца.** Матрица расстояний между восемью столицами
  подтверждена `28/28` (макс. расхождение `0,78` св.г.). Пересчитаны: `173` системы вместо
  `186`; минимальная пара — `Орна ↔ Зеф` `50,0` (не Мория ↔ Веридия `65,3`); медиана
  ближайшего соседа `101` св.г. (не ~`350`); соседи Корхала (`Райдин 88,4`), Айура
  (пропущены Самику и Мехлус), Чара (`Игнус 132,6`, `Эрик 230,8`); радиус Умоджи `553`
  (Джарбан), Тал-даримов `5 776` (Атриас); «`R = 1 200`» заменён на `R_core / R_sector /
  периферию` (вне `2 500` — `7` систем).
- **Корректировки `C-01…C-13`.** 13 уровней = `L0…L9` + `S0…S2`; `1 000 px/св.г.` не
  достигается и не нужен; пороги — в видимой ширине кадра (не в `px/св.г.`), чтобы
  мобильный и десктоп видели одинаковую лестницу; адрес не заменяет `x`,`y` в данных,
  а заменяет их в интерфейсе. По уточнению владельца 24.10: **растр удаляется сразу,
  без растрового ориентира и переходных стадий** (эталон кратно размыт на глубине,
  а его пирамида — миллионы файлов), `Shift+клик` становится «карточкой точки»,
  маркер получает размер в пикселях по глубине, на телефоне разрешён отъезд до `16 000` св.г.
- **Адресация.** `KP·REQHC` — сектор `KP` + пять тиров `5 × 5` с алфавитом `A…Y`
  (`2 000 / 400 / 80 / 16 / 3,2` св.г.), суффикс тела `/c`, сокет планетарного контура
  `/cell=…`. Уникальность на тире `16` св.г. доказана (диагональ ячейки `22,6` <
  минимальной пары `50,0`). Golden vectors восьми столиц и контрольных точек — в §7.5.
- **Рендер.** Двухслойная сцена: WebGL2-поле (туманность, пыль, звёздная пыль,
  `≤ 40 000` инстансов) + Canvas2D (территории, адресная сетка, системы, подписи,
  апертура, прицел полёта, стрелки). Детерминизм `xxHash32("KP")`, дизеринг,
  `prefers-reduced-motion` (полёт → кроссфейд `120 мс`).
- **Навигация (новое, 24.10).** `sector-flight.ts` — единственный владелец камеры во время
  анимации (`И-13`), фазы `anticipation / frame / stages / settle`, не более `3` вложенных
  кадров, лог-интерполяция видимой ширины, отмена любым вводом за `≤ 1` кадра.
  `sector-arrows.ts` — отбор до `5` систем строго по расстоянию от центра свободной области
  (видимость в кадре не влияет: цель в кадре получает «внутреннюю» стрелку `0,6`),
  угол `θ = atan2(Δy, Δx)`, слияние при угле `< 24°` и по лимиту в счётчик `+n`,
  хит-зона `≥ 44 px`, `Tab`/`Enter`, `aria-label`, подпись «имя · расстояние» без `hover`.
  Полёт со стрелки: `240 + 160 + 300 + 800` мс. Решения владельца 24.10: кадров `≤ 3`
  (цель `≤ 2`), подписи всегда видимы, отъезд `×25` основной (`×4` — режим `?recede=levels`).
- **Системный кадр.** `S0…S2` — каркас с честным пустым состоянием: в снимке
  `data/places.csv` всего `7` записей, тела заявлены у `6` систем из `173`; наполнение —
  отдельная редакционная задача, процедурный лор не выдумывается.
- **Гейты и волны.** `G7.1…G7.9` (адрес, лестница, «ноль растра», производительность,
  точность `≤ 0,5 px`, детерминизм кадра, доступность, совместимость URL, системный кадр);
  волны `SW-1…SW-6` с матрицей `OWNED_FILES` и инвариантом `И-11` (планетарный контур
  вне зоны правок).
