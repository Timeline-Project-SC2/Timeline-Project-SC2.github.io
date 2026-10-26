# История CR-01: PR 4, 5, 6

> Источник: `docs/HANDOFF.md`, строки 89–167 (редакция до разукрупнения).
> Назад: [конспект](../HANDOFF.md) · [этапы](../stages/README.md) · [документация](../README.md).

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
