# Сектор: закрывающая волна `F-1…F-6`

>
> Источник: [`docs/stages/stage-9-12-sector-deep-render-plan.md`](../../stage-9-12-sector-deep-render-plan.md) · строки 1091–1137.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

### 12.1. Закрывающая волна по сектору `F-1…F-6` (версия 4.0, 26.10.2026)

Волны `SW-1…SW-6` закрыли каркас сектора. Остаток — «последние правки»: привести рантайм
к решениям 26.10 (§16) и к фактической сетке (§17.3), снять видимые дефекты стрелок и долги
`SW-3F`/`SW-5`, затем закрыть сектор приёмкой. Карточки с матрицей файлов, контрактом до
буквы и порядком запуска — §18 оркестрационного документа; здесь состав, оценки и гейты.

| Волна | Содержание | `OWNED_FILES` | Оценка (агено-часы) | Гейты |
|---|---|---|---:|---|
| **F-1. `Z-5` — единица, предел, лестница** | `UNITS_PER_LY = 1`, `TARGET_LY_PER_PX = 0,002`, `DEEPEST_SECTOR_LEVEL = 12`, `LEVELS` на `L0…L12` шагом `1,9194`, `MARKER_EXPONENT = 0,3544`, `maxScale = 500` без аргумента кадра, слои территорий и сетей на `L2…L12`, апертура с `L12`, тексты предела в readout/досье/каталоге | `src/atlas/sector-units.ts`, `src/atlas/level-ladder.ts`, `src/atlas/sector-scene.ts`, `src/atlas/coords-readout.ts`, `src/atlas/dossier-card.ts`, `src/atlas/sector-arrows.ts`, `src/atlas/sector-flight.ts`, `src/atlas/catalog-panel.ts`, `tests/sector-units.test.mjs`, `tests/sector-ladder.test.mjs`, `tests/canvas-zoom-clamp.test.mjs`, `tests/coords-readout.test.mjs`, `tests/sector-arrows.test.mjs`, `tests/sector-field.test.mjs`, `tests/sector-flight.test.mjs`, `tests/sector-scene.test.mjs`, `tests/system-frame.test.mjs` | `12–16` | `G7.2`, `G7.14`, `G7.15` |
| **F-2. `Z-4e` — территории на глубине** | Заливка и контур сетей живут до `L12`, альфа по `layerFillAlpha` / `layerLineAlpha`, на `L8…L12` бабл не превращается в пятно под маркером | `src/atlas/canvas-renderer.ts`, `src/atlas/faction-net.ts`, `tests/faction-net.test.mjs` | `6–8` | `G7.4`, `G7.13` |
| **F-3. `Z-4f` — фактическая сетка** | Тиры `T6 = 0,64` и `T7 = 0,128`; `gridFor` строит старший тир `t` (ячейка `≤ 450 px`, вложенная `≥ 16 px`) и ровно один вложенный; одна толщина `1 px`, старший ярче; `.map-grid-overlay` и `GRID_TIER_BY_LEVEL` удаляются | `src/atlas/sector-address.ts`, `src/atlas/sector-scene.ts`, `src/atlas/canvas-renderer.ts`, `site/shared/styles.css`, `templates/atlas-shell.html`, `tests/sector-scene.test.mjs`, `tests/sector-address.test.mjs`, `tests/sector-grid.test.mjs` (новый), `tools/verify_sector_address.mjs`, `package.json` (строка `npm test`) | `10–14` | `G7.1`, `G7.13` |
| **F-4. `Z-2` — стрелки и единицы в подписях** | Пять дефектов §17.21.2 (направление у внешних стрелок, подпись в кадре, инсет с подписью, инкрементальный апдейт вместо `replaceChildren` каждые `250` мс, счётчик `+n` вне панели) плюс режим `'label'` у `formatDistanceLy` и единицы `св.г.` в подписи и счётчике | `src/atlas/sector-arrows.ts`, `site/shared/styles.css`, `src/atlas/dossier-card.ts`, `tests/sector-arrows.test.mjs`, `tests/sector-flight.test.mjs` | `8–12` | `G7.11` |
| **F-5. Монтаж системного кадра** | Слой `#systemFrame` в каркасе, стилях и `app.ts`; пустое состояние и «полка ожидания» по §9.2 п. 5; переход на `/planet-globe/` с `S2`. Тип места `unknown` уже в коде (`normalizedPlaceType`) — долг `C` закрыт | `src/atlas/app.ts`, `src/atlas/system-frame.ts`, `templates/atlas-shell.html`, `site/shared/styles.css`, `tests/system-frame.test.mjs`, `tests/place-types.test.mjs` | `6–10` | `G7.9`, `G7.8` |
| **F-6. Приёмка сектора и документация** | Прогон `G7.1…G7.15`, чек-лист Приложения C, `HANDOFF`, `CHANGELOG`, `ADMIN_GUIDE` §3.1 («сделано»), `stage_patches`, шапка `PREPARATION_PLAN`, закрытие §16.7 и решения из §16.8 | `docs/*`, `CHANGELOG.md`, `README.md` | `6–8` | все |

Итого `≈ 48–68` агено-часов; владелец — `≈ 6–10` часов (приёмка упора, сетки, маркера,
стрелок и системного кадра).

**Порядок и зависимости — строго последовательный.** Это не тройка `Tri-Agent Wave`:
`sector-scene.ts` (F-1, F-3), `canvas-renderer.ts` (F-2, F-3), `site/shared/styles.css`
(F-3, F-4, F-5) и `templates/atlas-shell.html` (F-3, F-5) — общие файлы, поэтому каждая
карточка стартует **после слияния предыдущей**:

1. `F-1` первым — он меняет `sector-scene.ts`, `sector-arrows.ts`, `sector-flight.ts` и всё,
   что зависит от числа уровней; любая работа до него получит старую лестницу.
2. `F-2` после `F-1` (`canvas-renderer.ts` берёт альфу слоя у лестницы).
3. `F-3` после `F-2`: сетка рисуется поверх заливки территории и делит `canvas-renderer.ts`
   с `F-2`, а `sector-scene.ts` — с `F-1`.
4. `F-4` после `F-3`: `site/shared/styles.css` нужен и сетке (подпись с контуром), и стрелкам
   (инсет с подписью); `sector-arrows.ts` уже правился в `F-1`.
5. `F-5` после `F-4`: `templates/atlas-shell.html` и `site/shared/styles.css` освобождаются
   только к этому моменту.
6. `F-6` — только после зелёных `F-1…F-5`; единственная волна, которой разрешено трогать
   `HANDOFF.md` и `CHANGELOG.md`.

Единственное, что можно вести параллельно, — `Z-3.1` (границы) и `Z-3.2` (блоки): их новые
файлы `sector-bounds.ts`, `sector-overlays.ts`, `data/*.json` и тесты ни с чем в `F` не
пересекаются. Монтаж этих слоёв (`Z-3.4`) — уже волна `G`.

**Вне волны `F` (следующая волна `G`):** карточки `Z-3.1…Z-3.3` (границы `sector-bounds`,
блоки `sector-overlays`, сети `faction-net` — последние пересекаются с `F-2`, поэтому идут
после неё), монтаж `Z-3.4` и фокусировка `Z-1`. Это новые слои и новая механика клика, а не
«последние правки»: их приёмка не должна держать закрытие сектора.

---
