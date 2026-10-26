# Сектор: гейты, целевой чек-лист и волна F

> Назад: [паспорт этапа](../plan.md) · [шаг 0 консолидации](../../../consolidation/README.md) · [документация](../../../README.md)

Гейты глубокой проработки сектора, целевой чек-лист и закрывающая волна F.

## Гейты

### 11. Гейты качества

| Гейт | Критерий |
|---|---|
| **G7.1 Адрес** | `173/173` уникальных адреса; round-trip `≤ 1e-9`; 13 golden vectors совпадают; парсер принимает `KP·REQHC`, `kp-reqhc`, `REQHC` и отвергает мусор |
| **G7.2 Лестница** | 13 секторных уровней `L0…L12` + `S0…S2` с номерами `13…15`; шаг `1,9194×`; пороги в видимой ширине; гистерезис `±12 %`; `?debug=ladder` показывает `visibleWidth / level / frame`; нет мигания при 60-секундном зуме от `16 000` до `4,00 св.г.` |
| **G7.3 Ноль растра** | в рантайме `0` запросов `/assets/tiles*` и `/assets/map-preview*`; в `.publish` нет этих файлов; `assets/src/koprulu-sector.jpg` отсутствует в репозитории; `pages.yml` не содержит шага тайлов; `verify:publish` `7/7`; замер экономии объёма — в отчёте `SW-2` |
| **G7.4 Производительность** | `L0`: p95 `≤ 16,7 мс` (desktop) и `≤ 33,3 мс` (Redmi Note 10); при непрерывном зуме нет кадров `> 100 мс`; поле `≤ 32 МБ` GPU |
| **G7.5 Точность** | смещение выбранной системы `≤ 0,5 px` на `L12` при пан/зум; отсутствие «прыжка» при смене кадра `S → O` |
| **G7.6 Детерминизм** | хэш трёх кадров (SHA-256 `ImageData`) совпадает на двух прогонах и двух браузерах при одинаковом seed |
| **G7.7 Доступность** | адрес читается скринридером (`aria-live` при смене уровня), клавиатурная навигация `L0→L12→S0`, контраст текста `≥ 4,5:1`, `prefers-reduced-motion` без параллакса |
| **G7.8 Совместимость** | работают `#system=`, `#planet=`, поиск, каталог, досье, маршрут, `/minimal/`; админ-режим `?coords=1` копирует `x<TAB>y` |
| **G7.10 Полёт к системе** | клик по маркеру с любого уровня: суммарно `≤ 1 500 мс` (матрица `Δ = 0…12`; при `Δ ≥ 10` — ровно `1 500`), не более `3` вложенных кадров, нет кадров `> 50 мс`, отмена мгновенная, `reduced-motion` → `120 мс` |
| **G7.11 Стрелки** | до `5` шевронов, ближайший — первым; у каждой подписи есть единица `св.г.` в формате `formatDistanceLy` (проверяется `0` вхождений `ly` и `св. лет`); отбор **не зависит** от видимости в кадре (проверяется кейс «цель в кадре, но не в центре»); угол позиции в пределах `±8°` от `atan2`; разнос `≥ 24°`; счётчик `+n` равен числу отсечённых; подпись «имя · расстояние» видна **без** наведения; `hover` только меняет акцент; хит-зона `≥ 44 × 44 px`; переход со стрелки `≤ 1 500 мс` и проходит все четыре фазы (`recede → refocus → offset → approach`); `Tab`/`Enter` работают, `aria-label` заполнен |
| **G7.12 Кадры полёта** | промежуточных кадров **не больше `3`** (жёсткий предел, `D-16`); целевой ориентир — `≤ 2` на целевом десктопе, замер фиксируется в отчёте волны, но не является блокирующим на мобильных |
| **G7.13 Фактическая сетка** | сетка есть на `L0…L12`; в кадре ровно два тира — старший `t` и один вложенный `t+1`, одна толщина `1 px`, старший ярче (`alpha ≈ 0,16` против `≈ 0,07`); ячейка `t` на экране `≤ 450 px`, вложенная `≥ 16 px`; линии совпадают с миром при панорамировании; подпись в углу ячейки без наложений (`loupeLabelFits`); декоративной сетки `80 px` в разметке нет; `MAX_GRID_LINES = 512` не поднят (фактический максимум `171` линия на `L3`) |
| **G7.14 Единица и предел** | `UNITS_PER_LY = 1`; `TARGET_LY_PER_PX = 0,002`; `maxScale = 500 px/св.г.` не зависит от viewport (проверка на пяти viewport); стрелки и досье печатают расстояния в `св.г.` через `formatDistanceLy` без множителя `1 000`; `edgeDistance` — справочная строка, пределом не является |
| **G7.15 Маркер** | `MARKER_EXPONENT = 0,3544`; диаметр `2,5 px` на `L0` и `40 px` на `L12`, значения §6.2 совпадают с кодом на `0,1 px`; клампы `2,5`/`40` не превышены ни на одном уровне; хит-зона `≥ 44 px` на сенсоре |
| **G7.9 Системный кадр** | `S0` для всех 173 систем не падает; `6` систем с телами показывают их; `167` показывают честное пустое состояние; `S2 → /planet-globe/` передаёт корректные `place` и `system` |

Performance-контекст берётся из существующего протокола (`G1`, `G4`): p95 по реальным
rAF-интервалам, кадры `> 50 мс` и `> 100 мс` считаются отдельно, замеры на целевом
десктопе владельца и Redmi Note 10.

---

### 12. Дорожная карта волн (`SW-1…SW-6` + `SW-3F`)

Режим — параллельный: волны не пересекаются по файлам с планетарным контуром (`И-11`).
Каждая волна завершается коммитом, пушем, зелёными `typecheck`, `lint`, `npm test`,
`npm run build`, `verify:publish` и отдельным PR.

| Волна | Содержание | `OWNED_FILES` | Оценка (агено-часы) |
|---|---|---|---:|
| **SW-1. Ядро** | `sector-address.ts`, `level-ladder.ts` (включая `markerDiameter(visibleWidth)` и `minVisibleWidth`), **`sector-units.ts` (`formatDistanceLy`)**, golden vectors, 4 теста, верификатор, `check.yml`, `package.json` (script) | `src/atlas/sector-address.ts`, `src/atlas/level-ladder.ts`, `src/atlas/sector-units.ts`, `tests/sector-address.test.mjs`, `tests/sector-ladder.test.mjs`, `tests/sector-units.test.mjs`, `tools/verify_sector_address.mjs`, `.github/workflows/check.yml`, `package.json` | `10–14` |
| **SW-2. Поле + удаление растра** | `sector-field.ts` (WebGL2 + CPU-фолбэк), палитра из CSS, дизеринг, детерминизм; **в том же PR** удаляются тайлы, превью, `tile-pyramid.ts`, `rasterMode`, `CONFIG.tiles`, `sectorMapPreview`, `build_tiles`, `assets.*` в `meta.json`, шаг тайлов в `pages.yml`, исходник `koprulu-sector.jpg` | `src/atlas/sector-field.ts`, `src/atlas/tile-pyramid.ts` (удаление), `src/atlas/canvas-renderer.ts`, `src/atlas/config.ts`, `src/atlas/data-loader.ts`, `site/shared/links.ts`, `site/shared/styles.css`, `templates/atlas-shell.html`, `tools/build_assets.py`, `.gitignore`, `.github/workflows/pages.yml`, `data/meta.json`, `assets/src/koprulu-sector.jpg` (удаление) | `14–20` |
| **SW-3. Сцена** | `sector-scene.ts`, `label-layout.ts`, территории, сетка адресов, маркеры с размером по глубине (§6.2), бюджеты `L0…L9` | `src/atlas/sector-scene.ts`, `src/atlas/label-layout.ts`, `src/atlas/canvas-renderer.ts`, `src/atlas/app.ts`, `src/atlas/config.ts` | `16–24` |
| **SW-3F. Полёт и стрелки** | `sector-flight.ts` (клик-полёт §6.4 и переход со стрелки §6.6, `FLIGHT_TIMING`), `sector-arrows.ts` (§6.5, отбор по расстоянию и углу, слияние, шевроны, подпись `имя · N св.г.` и счётчик `+n · до N св.г.` через `formatDistanceLy`), интеграция с маркерами и клавиатурой, два теста | `src/atlas/sector-flight.ts`, `src/atlas/sector-arrows.ts`, `src/atlas/sector-scene.ts`, `src/atlas/app.ts`, `templates/atlas-shell.html`, `site/shared/styles.css`, `tests/sector-flight.test.mjs`, `tests/sector-arrows.test.mjs` | `14–20` |
| **SW-4. Адресный UI** | readout, **карточка точки вместо `Shift+клик`** (§7.8), поиск, `?at=`, `#system=…&frame=`, админ-режим `?coords=1`, `atlas-variants.ts`, `catalog-panel.ts`, `dossier-card.ts`, `docs/ADMIN_GUIDE.md` | `src/atlas/coords-readout.ts`, `src/atlas/catalog-panel.ts`, `src/atlas/dossier-card.ts`, `src/atlas/atlas-variants.ts`, `docs/ADMIN_GUIDE.md` | `12–18` |
| **SW-5. Системный кадр** | `system-frame.ts`, `S0…S2`, лог-орбиты, кламп размеров, пустое состояние, мост `S → O`, переход в `/planet-globe/` | `src/atlas/system-frame.ts`, `site/shared/styles.css` (слой `#systemFrame`), `templates/atlas-shell.html` | `16–24` |
| **SW-6. Приёмка и документация** | прогон гейтов `G7.1…G7.12`, замеры бюджета и точности, `HANDOFF`/`CHANGELOG`/`ADMIN_GUIDE`, чек-лист §Приложение C | `docs/*` | `6–10` |

Итого `≈ 88–130` агено-часов; человеко-часы разработчика — `≈ 165–245`; часы владельца
(приёмка поля, адресов, лестницы, полёта, стрелок, системного кадра) — `≈ 12–18`.

**Порядок и зависимости:** `SW-1 → SW-2 → SW-3 → SW-3F → SW-4 → SW-5 → SW-6`.
`SW-3F` идёт сразу после `SW-3` (нужны маркеры и камера) и до `SW-4`, потому что карточка
точки и досье используют уже готовый полёт.
`SW-2` — критическая: после неё растр в проекте отсутствует, и любая визуальная
регрессия видна сразу. `SW-5` может идти параллельно `SW-3F`/`SW-4` при условии, что
`system-frame.ts` не трогает `canvas-renderer.ts` и `sector-flight.ts`.

## Целевой чек-лист

### 14. Целевое состояние (чек-лист конечного вида)

**Не существует после волны `SW-2`:**

- `src/atlas/tile-pyramid.ts`, `state.rasterMode`, `CONFIG.tiles`, `CONFIG.markerLod`;
- `assets/tiles/**`, `assets/tiles.json`, `assets/map-preview.webp` в публикации;
- `assets/src/koprulu-sector.jpg` (исходник удалён, архивного эталона нет);
- `assets.hasRaster / preview / tiles / version` в `data/meta.json`;
- `SITE_LINKS.sectorMapPreview`;
- `build_tiles`, `PREVIEW_*`, `TILE_*` в `tools/build_assets.py`; соответствующие строки
  `.gitignore` и шаг кэша тайлов в `pages.yml`.

**Существует:**

- 13 секторных уровней `L0…L12` + `S0…S2` (номера `13…15`) с единым источником порогов;
- единица `1` ед = `1` св.г. и предел `0,002` св.г./px (`500` px/св.г., независимо от экрана);
- фактическая сетка адресов: два тира в кадре, одна толщина, без декоративного фона `80 px`;
- буквенный адрес `KP·REQHC[/c]` в readout, копировании, поиске, URL и досье;
- процедурное поле сектора (WebGL2 + Canvas2D-фолбэк) с детерминированным seed;
- `tools/verify_sector_address.mjs` в `check.yml`;
- маркер с непрерывным размером по глубине (`2,5 … 40 px`, показатель `0,3544`) и антислипанием;
- «карточка точки» по `Shift+клик`/долгому нажатию (адрес, `x`,`y`, ближайшая система, расстояние);
- админ-режим `?coords=1` с прежним `x<TAB>y`;
- отъезд до `minVisibleWidth = 16 000 св.г.` и «вся карта по ширине» на телефоне;
- честный системный кадр с пустыми состояниями и переходом в `/planet-globe/`;
- `verify:publish` `7/7`, `npm test` зелёный, `tsc --noEmit` и `eslint` чистые.

---

## Волна F

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
