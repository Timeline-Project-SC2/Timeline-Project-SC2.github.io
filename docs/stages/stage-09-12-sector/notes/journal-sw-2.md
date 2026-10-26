# Журнал: волна SW-2

>
> Источник: [`docs/stages/stage_patches.md`](../../stage_patches.md) · строки 1244–1273.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 2026-10-25 — Волна SW-2 слита: процедурное поле и вывод растра (PR #260–#261)

Слиты в `main` `SW-2A-style` (PR #260 `9a5986c`) и `SW-2B` (PR #261 `5d7c69b`). Факты ниже
сверены с диффом интеграции и закрывающей приёмкой волны.

- **Поле сектора:** `/sector/` использует процедурное поле (`src/atlas/sector-field.ts`), WebGL2
  с CPU-фолбэком; `nebula` — по умолчанию, `tactical` включается через `?style=tactical`
  (`CONFIG.field.style`, `resolveFieldStyle`), seed детерминизма — `KP`. Модуль поддерживает
  гашение туманности и пыли при переданном `edgeDist ≤ 1` св.г. (остаются звёздная пыль и мягкий
  фон); текущий вызов `renderField()` из `canvas-renderer.ts` `edgeDist` не передаёт, поэтому
  этот глубокий режим пока не подключён к живому кадру.
- **Интеграция:** `app.ts` создаёт отдельный offscreen `fieldCanvas` в `boot()`, а
  `canvas-renderer.ts` переносит его в основной canvas через `ctx.drawImage`. `drawSchematic()`
  сохранён как резерв при загрузке данных, недоступности поля и потере WebGL-контекста.
- **Растр выведен, тайлы удалены:** удалены `tile-pyramid.ts`, `CONFIG.tiles`, `rasterMode`,
  `state.tiles`, `sectorMapPreview` и исходный `assets/src/koprulu-sector.jpg` (`21,7` МиБ).
  Пайплайн тайлов и `map-preview` удалён из `tools/build_assets.py`; также удалены правила
  `.gitignore`, кэш тайлов из `pages.yml`, артефакт из `assets.yml` и требование
  `.publish/assets/tiles.json` из `check.yml`.
- **Метаданные:** `mapSize = 10000` сохранён; в `data/meta.json` блок `assets` содержит только
  `imageVersion = "05a76b26"`. Он нужен для кэш-бастинга изображений галактики параметром `?v=`.
- **Бесшовность:** `strokeRect` рамки сектора удалён по требованию владельца (§17.15.6);
  координатные отметки и сетка сохранены, alpha сетки — `0.08`.
- **CI и база приёмки:** `verify:no-raster` — гейт G7.3 из 9 проверок; в `scripts` он стоит
  выше `npm test`, в `build` — после `verify:publish`; результат — `9/9`. На `main` база
  `npm test` — `207` (199 pass, 8 известных планетарных fail вне зоны), `verify:sector-core` —
  `3034`, `verify:publish` — 7 маршрутов.
- Инвентарь, порядок и приёмка — [§17.3, §17.13 и §17.18 SW-2](../../../agents_task_orchestration/agents_task_orchestration.md);
  исполняемый гейт — [`tools/verify_no_raster.mjs`](../../../../tools/verify_no_raster.mjs).
