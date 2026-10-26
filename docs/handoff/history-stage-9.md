# История проектирования Этапа 9 (23.10)

> Источник: `docs/HANDOFF.md`, строки 358–381 (редакция до разукрупнения).
> Назад: [конспект](../HANDOFF.md) · [этапы](../stages/README.md) · [документация](../README.md).

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
