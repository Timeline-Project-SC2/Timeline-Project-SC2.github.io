# Доменные правила `src/` (Канонические TS-модули, Wasm и инварианты И-1…И-6)

Настоящий документ — источник истины (SSoT) для директории `src/`.
Общие правила репозитория, команды сборки/проверки и протокол коммитов описаны
в корневом [`../AGENTS.md`](../AGENTS.md) и здесь не дублируются.

---

## 1. Канонические TypeScript-модули (`src/`)

Весь код в `src/` пишется на строгом TypeScript (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) без параллельных `.js`-файлов:
- `src/atlas/*` (`app.ts`, `atlas-variants.ts`, `canvas-renderer.ts`, `catalog-panel.ts`,
  `config.ts`, `coords-readout.ts`, `data-loader.ts`, `dossier-card.ts`, `tile-pyramid.ts`) —
  модульное ядро атласа сектора Копрулу, собираемое в `shared/app-<hash>.js`. Различия между
  `/sector/` и `/minimal/` задаются только конфигурацией в `src/atlas/atlas-variants.ts`.
- `src/planet/*` — Wasm-ядра AssemblyScript (`assembly/kernels.ts`, `assembly/planet-core.ts`,
  `assembly/planet-noise-core.ts`), замороженные байты (`planet-core-bytes.ts`), хост-арена
  (`planet-core-host.ts`) и опциональный FX-плагин глобуса (`planet-globe-fx.ts`).
- `src/local-map/*` — 4 модуля 3D-структур локальной карты (`local-map-mesh.ts`,
  `local-map-worker.ts`, `local-map-renderer.ts`, `local-map-shaders.ts`) и контракт бесшовной
  сшивки патча из 7 канонических ячеек `local-map-contract.ts` (`local-map-patch-v1`).
- `src/contracts/planet-generation-contract.json` — единственный источник истины схемы 37 колонок
  `planet_generation`, 8 пресетов `planet-presets-v1`, точности `Decimal` и версий генератора.
- `src/spiral/*`, `src/cursor/*` — канонические доменные пространства для выделения типизированных
  ядер спирали и курсора при декомпозиции `site/shared/galaxy-spiral.ts` и `site/shared/cursor-fx.ts`.

---

## 2. AssemblyScript и Wasm-ускоритель (`planet-core`)

- Вычислительные ядра AssemblyScript (`src/planet/assembly/kernels.ts`, входные модули
  `src/planet/assembly/planet-core.ts` и `planet-noise-core.ts`; целевой контур
  `src/wasm/planet-core.ts` -> `site/assets/planet-core.wasm` и байт-контейнер
  `src/planet/planet-core-bytes.ts`) собираются `tools/build_planet_core.mjs` (`-O3 --enable simd --runtime stub`).
- Поддерживаются два Wasm-артефакта:
  1. **Полное ядро `planet-core`** (~42 КиБ, для WebWorker и Node.js): 2-канальный `f64x2` SIMD
     шума (`sampleFieldsBatch`), Dial PQ (`dialGatherSort`), `coastDistance` (куча + монотонная
     FIFO-очередь), `chooseSeedsKernel`, `balanceRegionsTopTwo`, `biomeWeightsAndSmooth`,
     гидрология, `globePack` (вершина 24 Б с наклонными нормалями `i16x4`) и `radixOrderF32`/`radixOrderF64`.
  2. **Компактное ядро `planet-noise-core`** (`< 4 КиБ`) — компилируется синхронно на главном потоке.
- Хост `src/planet/planet-core-host.ts` предоставляет синглтон `getSharedPlanetCore()` с ареной 24 МиБ
  и удержанием сетки (`putGrid`) между стадиями. При изменениях в `assembly/*` обязательно запускайте
  `npm run build:wasm` и сверяйте байты через `node tools/build_planet_core.mjs --check`.

---

## 3. Побитовая идентичность `c100-soft-v2` и инварианты И-1…И-6

- **Инвариант И-1 (Побитовая идентичность `c100-soft-v2` и мобильного LOD):**
  - Поля географии (`GEOGRAPHY_VERSION = c100-soft-v3` с W28b; контракт принимает `c100-soft-v1/v2/v3`,
    профили по умолчанию остаются на `c100-soft-v2`) и гидрологии/биомов (`c100-soft-v2`) всегда считаются на
    канонической частоте `canonicalV` (для Земли `v=128`, 163 842 ячейки) без пересчёта ячеечных
    норм профиля под `renderV`. Пониженный мобильный `renderV` служит только прокси-мешем отрисовки
    с проекцией полей через `GeodesicGrid.pick`; адреса `goldberg-gp-v1/w0/v<canonicalV>/<cell>`,
    `continentTop1Id` и `drainageRegionId` совпадают на ПК и телефоне на 100 %.
- **Инвариант И-2 (Детерминизм Wasm ↔ JS и FULL EQ):**
  - В Wasm и TS сохраняются порядок операций `f64`/`f32` и строгий tie-break `(a - b)` по возрастанию
    `cellIndex` при равных ключах в очередях и `radixOrderF32`/`radixOrderF64`. Все 185 побитовых
    хэшей SHA-256/CRC32C (`FULL EQ`) и гейт скорости Земли `v=128` (`<= 855 мс`) обязаны проходить.
- **Инвариант И-3 (Контракт локальной карты `local-map-patch-v1`):**
  - `Patch7` (центр + 6 соседей по `grid.neighbors`) строится на общем 3D-сэмплере `(x, y, z)`,
    высотах `filledElevation` (`c100-soft-v2`), непрерывных реках (`flowReceiver` + `streamWeight`)
    и маске запрета спавна зданий на воде и крутых склонах `buildingSpawnMask` (`minLand: 0.5, maxSlope: 0.5`).
- **Инварианты И-5 и И-6 (Единый рендерер и FX-плагин `src/planet/planet-globe-fx.ts`):**
  - Все экспериментальные режимы `/planet-test/` (клеточная раскладка осколков `computeShardLayout`
    по `vertexCellId`, 3D-объём стенок и нижней оболочки `VS_VOLUME/FS_VOLUME`, ядро Шакураса
    `VS_CORE/FS_CORE` с `coreScale = 0.55`, палитры `uPalette`/`uTexMode`) изолированы в
    `src/planet/planet-globe-fx.ts` и подключаются к базовому `site/shared/planet-globe.ts`
    только через хуки `PlanetGlobeFxHooks` (`onGeometryUploaded`, `onAfterSurfaceDraw`, `onDispose`).
  - Паритет публичных экспортов и полей контракта контролируется `tools/verify_feature_parity.mjs` (И-6).
