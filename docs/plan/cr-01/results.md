# CR-01: факт выполнения (PR #130–#139, 6.1, DX-1)

> Реестр PR и AssemblyScript вместо Rust.
> Источник: [`docs/CHANGE_REQUEST_PLAN.md`](../../CHANGE_REQUEST_PLAN.md) · строки 350–381.
> Назад: [карта документации](../../README.md) · [индекс документации](../../README.md).

## 11. Факт выполнения плана CR-01 (PR #130–#139, волна PR 6.1 и волна DX-1)

План **CR-01 полностью выполнен и закрыт в `main`**. Документ плана влит PR #129; шесть исполнительных PR базовой волны (#130, #131, #133, #137, #138, #139) реализовали Контуры А и Б, а волна `PR 6.1` (#145–#147 с добивками #152–#153) и волна `Wave-DX-1` (#148, #149, #151; WIP PR #150 закрыт без слияния и заменён #149) закрыли реставрацию FX Шакураса, тулинг, строгий синк и модульные инструкции `AGENTS.md`.

### 11.1. Реестр выполненных PR

| PR | Волна / роль | Что выполнено |
|---|---|---|
| [#130](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/130) | CR-01 PR 1 | Модульный фундамент: TypeScript + Vite, авто-хэширование ассетов вместо ручных `?v=`, дедупликация HTML-оболочек |
| [#131](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/131) | CR-01 PR 2 | Единый источник истины контракта `planet_generation` (37 колонок, 8 пресетов), ключ `PG1` и `verifyGenerationKey`, отказ от двойной бухгалтерии Python ↔ JS (И-4) |
| [#133](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/133) | CR-01 PR 3 | Распил монолита `site/shared/app.js` на строго типизированные модули `src/atlas/*`, эффекты — на чистые TS-модули |
| [#137](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/137) | CR-01 PR 4 | Единое вычислительное ядро `planet-core` (Wasm, SIMD128) и строгие TS-порты `geodesic-grid`/`planet-noise`/`planet-geography`/`planet-surface`/`planet-globe`; закрыта И-1, старые `.js`-дубли удалены |
| [#138](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/138) | CR-01 PR 5 | Консолидация двух глобусов на базе `/planet-globe/`, модули локальной карты `src/local-map/*` и контракт `local-map-patch-v1` (И-3, И-5, И-6) |
| [#139](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/139) | CR-01 PR 6 | Целевая оптимизация генерации `v=128` до гейта `≥3×` / `≤855 мс` при 100 % побитовой эквивалентности (FULL EQ) |
| [#145](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/145) | PR 6.1, Воркер 1 | TS-миграция `planet-geometry` (`computeShardLayout`), клеточный индекс осколков `fxShardIndex`, 3D-объём разломов и светящееся ядро Шакураса |
| [#147](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/147) | PR 6.1, Воркер 2 | Каскадная сборка `uBuild`, двухслойное центробежное замещение `uHide`/`uCenterGrow` и перевод стенда `/planet-test/` на боевое ядро |
| [#146](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/146) | PR 6.1, Воркер 3 | Синхронизация `PREPARATION_PLAN.md` с архитектурой CR-01 и сводка волны в `HANDOFF.md` / `CHANGELOG.md` |
| [#152](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/152) | Добивка PR 6.1 | Стык `onGeometryReady`, `PlanetGrid` и `vertexCellId` на `/planet-test/` |
| [#153](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/153) | Добивка PR 6.1 | Канонические `surfaceClass`/`presetId` и запрет отрисовки ядра до готовности геометрии |
| [#148](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/148) | Wave-DX-1, Воркер 1 | `.nvmrc` (Node 24) и `.python-version` (3.12), единый `package-lock.json` с `assemblyscript`/`eslint`, декомпозиция `vite.config.mts` на `tools/vite/*` с контекстом `PublishPipelineState` |
| [#149](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/149) | Wave-DX-1, Воркер 2 | Строгий режим `tools/sync.py --strict`, диагностика HTML-ответов Google Sheets, оба формата `approved_at` в кросс-верификаторе и `tests/test_sync.py` |
| #150 | Wave-DX-1 | WIP-дубль строгой валидации синка: **закрыт без слияния**, работа полностью перенесена в #149 |
| [#151](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/151) | Wave-DX-1, Воркер 3 | Иерархия `AGENTS.md` по принципу SSoT (корневой + доменные `site/`, `src/`, `tools/`) и сводка волны |

### 11.2. Ключевая техническая деталь: AssemblyScript вместо Rust

План раздела 5 изначально рассматривал ядро `planet-core` на **Rust → WebAssembly**. Фактическая реализация выбрала **AssemblyScript**, чтобы обеспечить 100 % автономность сборки внутри npm-тулчейна: в песочнице CI нет внешней зависимости от Rust/Cargo, а компиляция Wasm выполняется тем же `package-lock.json` и командами `npm run build:wasm` / `npm run check:planet-core` без системного тулчейна.

- Единое бинарное ядро `planet-core` — **SIMD128, однопоточный Wasm** (без `SharedArrayBuffer`, так как GitHub Pages не отдаёт COOP/COEP): исходники [`src/planet/assembly/kernels.ts`](../../../src/planet/assembly/kernels.ts), хост-обвязка [`src/planet/planet-core-host.ts`](../../../src/planet/planet-core-host.ts) и байтовый протокол [`src/planet/planet-core-bytes.ts`](../../../src/planet/planet-core-bytes.ts).
- На канонической Земле `v=128` (163 842 ячейки) достигнута медиана **`totalMedian ≈ 812–853 мс`** при пороге гейта **`<= 855 мс`** — ускорение **`> 3,0×`** против baseline **`2 564,7 мс`** (замер `bench_planet_stage5.mjs --seeds=5`: `3,01×–3,16×`).
- При этом зафиксировано **100 % побитовое совпадение (`FULL EQ`) всех 185 контрольных хэшей** (SHA-256 всех 45 массивов географии и поверхности + CRC32C сеток на `v=16, 24, 32, 64, 128`) между эталонным Python-каналом, Wasm-ядром и строгим TypeScript-рантаймом.
- Все инварианты **И-1 … И-6** соблюдаются и удерживаются регрессионными тестами (`npm test`, `npm run verify:contract`, `npm run verify:publish`); легаси-монолиты и `.js`-дубли планетарных модулей удалены по И-5.
