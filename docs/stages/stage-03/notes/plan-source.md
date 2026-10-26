# Этап 3 — исходный план ядра сетки

> Текст плана сохранён без изменений.
> Источник: `docs/PREPARATION_PLAN.md` (редакция до разукрупнения; `git show a7503e6:docs/PREPARATION_PLAN.md`) · строки 1398–1440.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

### Этап 3. Ядро геодезической сетки

- Топология типизированными массивами.
- Канонические адреса.
- Кэш по \(v\).
- Быстрый поиск ячейки.
- Версионированный бинарный кэш топологии. Каноническая сериализация —
  little-endian независимо от хоста. Заголовок v1 (32 байта):
  `0..3 magic="GEO\0"`, `4..5 uint16 formatVersion=1`,
  `6..7 uint16 flags=0`, `8..11 uint32 endiannessMarker=0x01020304`,
  `12..15 uint32 paramsHash` (первые 32 бита SHA-256 канонического JSON
  `{gridVersion, v, addressSchema, topologySchema}` с сортировкой ключей),
  `16..19 uint32 headerLength=32`, `20..23 uint32 payloadLength`,
  `24..27 uint32 payloadCRC32C`, `28..31 uint32 v`.
- При чтении кэша любое несовпадение magic, версии, endianness marker,
  paramsHash, длины или CRC32C, а также провал валидации топологии —
  не ошибка UI и не падение: кэш отбрасывается, сетка перестраивается,
  после успешной валидации кэш перезаписывается best-effort. Поддерживается
  только точная мажорная версия формата; миграции старых версий делаются
  явными конвертерами, а не «тихим» чтением.
- Chunk-контракт для рендера Этапа 6 формализуется уже в ядре Этапа 3:
  `GeodesicGrid.getChunks(grid)` возвращает
  `Array<{ id, faceIndex, startCell, cellCount, boundingSphere }>`, где
  `boundingSphere = { center: [x, y, z], radius, cosAngularRadius }` на
  единичной сфере. Каждый chunk целиком лежит внутри одной грани
  икосаэдра; ячейки диапазона
  `[startCell, startCell + cellCount)` непрерывны во всех SoA-массивах
  топологии и принадлежат ровно одному chunk. Объединение диапазонов
  покрывает все `10v²+2` ячеек без пересечений и пробелов.
  `GeodesicGrid.getChunkNeighbors(grid, chunkId)` возвращает соседние
  `chunkId[]` без дублей и симметрично; это вход для стыковки разных LOD
  на Этапе 6. Схема chunking версионируется вместе с `gridVersion`.
- Обязательный бенч/валидация chunk-схемы для v=128 выводит количество
  чанков, средний и максимальный размер чанка и проверяет: каждая ячейка
  принадлежит ровно одному chunk, диапазоны не пересекаются, соседи chunk
  симметричны, boundingSphere покрывает центры и углы своих ячеек.

**Факт Этапа 3 (актуализировано по `CR-01` PR #137, #139):** реализовано в строгом TypeScript-модуле `site/shared/geodesic-grid.ts`, `tools/bench_planet_stage3.mjs` и тестах `tests/geodesic-grid.test.mjs` / `tests/planet-grid-cache.test.mjs`. Для \(v=128\): 200 chunk-ов, в среднем 819,2 и максимум 1 024 ячейки, средний/максимальный угловой радиус 13,15°/16,02°; typed arrays 19,70 МиБ, быстрый pick 0,0207 мс mean против 0,4707 мс полного перебора без расхождений на 1 000 направлениях. После оптимизации PR #139 (пул `ensureRawScratch`, плоский индекс грани вместо `Map`, пропуск `.toFixed(9)` на внутренних вершинах, монотонный Diamond Angle и counting bucket sort в `reorderCells`) время сборки `GeodesicGrid.build(128)` снижено с 485 мс до `~100,1 мс` в `bench_planet_ci.mjs` (`meshMedian ~126–139 мс` в `bench_planet_stage5.mjs`) при 100 % совпадении CRC32C бинарного кэша. Полный контракт и миграция v0→v1 — в `docs/stages/stage-3-geodesic-core.md`.

**Гейт:** `validate()`/`validateChunks()` истинны, бинарный round-trip и
corrupt/old-version rebuild покрыты тестами, CI CPU-бенч не регрессирует
относительно baseline (+20% build / +30% typed memory).
