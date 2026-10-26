# Сектор: модули, контракты и тесты

>
> Источник: [`docs/stages/stage-9-12-sector-deep-render-plan.md`](../../stage-9-12-sector-deep-render-plan.md) · строки 976–1038.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 10. Архитектура модулей и контракты

### 10.1. Новые модули (все — строгий TypeScript, без DOM там, где это возможно)

| Файл | Ответственность | Публичный API (эскиз) |
|---|---|---|
| `src/atlas/sector-address.ts` | кодек адресов, тиры, форматирование | `addressOf(x,y)`, `prefixOf(x,y,tier)`, `rectOf(addr)`, `centerOf(addr)`, `parseAddress(text)`, `formatAddress(addr, style)`, `ADDRESS_TIERS` |
| `src/atlas/sector-units.ts` | единицы и числа: световые годы, склонение, углы | `formatDistanceLy(ly, mode)`, `pluralYears(n)`, `formatAngleDeg(rad)`, `NBSP` |
| `src/atlas/level-ladder.ts` | 13 уровней, пороги, гистерезис, кадры | `LEVELS`, `levelForWidth(w, prev?)`, `levelSpec(n)`, `frameOf(n)`, `visibleWidthForLevel(n)` |
| `src/atlas/sector-field.ts` | процедурное поле (WebGL2) + CPU-фолбэк | `createSectorField(canvas, opts)`, `renderField(state)`, `dispose()` |
| `src/atlas/sector-scene.ts` | сборка кадра `S`: поле + территории + сетка + системы + подписи | `createSectorScene(kernel)` |
| `src/atlas/label-layout.ts` | антиколлизия подписей, приоритеты | `layoutLabels(items, viewport, budget)` |
| `src/atlas/sector-flight.ts` | полёт камеры: клик по маркеру и переход со стрелки; единственный владелец камеры во время анимации | `planClickFlight(from, to)`, `planArrowTrip(current, target)`, `createFlight(kernel)`, `flyTo(plan)`, `cancel()`, `FLIGHT_TIMING` |
| `src/atlas/sector-arrows.ts` | отбор ближайших систем, угол, раскладка шевронов, слияние по углу | `pickArrows(systems, camera, viewport, opts)`, `arrowPoint(theta, rect, inset)`, `mergeByAngle(items, minDeg)`, `ARROW_CONFIG` |
| `src/atlas/system-frame.ts` | кадр `O`: звезда, орбиты, тела, статусы | `createSystemFrame(kernel)`, `openSystem(systemId, level)`, `close()` |
| `tools/verify_sector_address.mjs` | golden vectors, уникальность, round-trip | CLI |

### 10.2. Изменяемые модули

- `src/atlas/app.ts` — регистрация новых сервисов в kernel.
- `src/atlas/config.ts` — удаление `CONFIG.tiles`, `state.rasterMode`; новые `CONFIG.ladder`,
  `CONFIG.address`, `CONFIG.field`.
- `src/atlas/canvas-renderer.ts` — удаление `drawRaster`-ветки, вынос подписей, поддержка
  `visibleWidth` как первичной величины.
- `src/atlas/coords-readout.ts` — адресный readout, админ-режим, копирование.
- `src/atlas/data-loader.ts` — без `tiles.json`; `address` в записях систем.
- `src/atlas/catalog-panel.ts` — поиск по адресу.
- `src/atlas/dossier-card.ts` — адрес + «Войти в систему».
- `src/atlas/atlas-variants.ts`, `templates/atlas-shell.html`, `site/shared/styles.css` — разметка HUD.
- `tools/build_assets.py`, `.gitignore`, `.github/workflows/pages.yml`, `data/meta.json`
  (удаление — в волне `SW-2`).

### 10.3. Инварианты под-уровня

| ID | Инвариант |
|---|---|
| **И-7** | Адрес — **производная биекция** координат. Ни одна запись данных не хранит адрес. Расстояния считаются только по `x`,`y` c `float64`. |
| **И-8** | Пороги уровней существуют **только** в `level-ladder.ts`. Ни один модуль не сравнивает `px/св.г.` со своими константами. |
| **И-9** | Секториальный кадр не рисует объекты мельче `0,25 px` (иначе — агрегат или скрытие); системный кадр не использует `св.г.` как единицу отрисовки. |
| **И-10** | После волны `SW-2` рантайм не запрашивает ни одного растрового ассета сектора; в `.publish` нет `tiles*` и `map-preview*`; в репозитории нет `assets/src/koprulu-sector.jpg`. |
| **И-11** | Планетарный контур не редактируется: файлы `site/planet-globe/*`, `site/shared/planet-*`, `src/planet/*`, `src/local-map/*`, `data/planet-generation.csv` вне `OWNED_FILES` под-уровня. |
| **И-12** | Положение систем — только `x`,`y` из `data/systems.csv`; никакой репроекции, «привязки к картинке» и ручной подгонки под фон. Размер маркера — только в пикселях по `markerDiameter(visibleWidth)`. |
| **И-13** | Во время полёта камерой владеет **только** `sector-flight.ts`: `animateTo`, колесо и пан не запускают параллельных циклов. Любой пользовательский ввод отменяет полёт за `≤ 1` кадр. |
| **И-14** | Полёт укладывается в `1 500 мс` при любых `Δ` уровня и любом устройстве; тайминги — только в `FLIGHT_TIMING`, ни одна фаза не задаёт длительность своей константой. |
| **И-15** | Стрелки — производная состояния камеры: отбор по расстоянию от центра свободной области и углу `θ = atan2(Δy, Δx)`. Никакого «случайного» или кэшированного выбора между кадрами при неизменной камере. |
| **И-16** | Расстояние в интерфейсе печатается **только** через `formatDistanceLy` из `sector-units.ts`: запятая вместо точки, неразрывный пробел перед `св.г.`, единица никогда не опускается. Ни один модуль не форматирует расстояние своей строкой. |

### 10.4. Тесты

| Файл | Что проверяет |
|---|---|
| `tests/sector-address.test.mjs` | golden vectors (8 столиц + 5 контрольных точек), уникальность 173 адресов, round-trip, границы ячеек, парсер (регистр, разделители, мусор), `mapSize ≠ 10 000` → ошибка |
| `tests/sector-ladder.test.mjs` | 13 секторных уровней `L0…L12`, монотонность, гистерезис `±12 %`, `levelForWidth(4) = 12`, `levelForWidth(200) = 6`, `levelForWidth(16 000) = 0`, отсутствие мигания на 1 000 случайных значениях; `levelSpec(10…12)` существует, `levelSpec(16)` бросает `RangeError` |
| `tests/sector-frame.test.mjs` | 13 записей без дыр, кадры `S/O`, бюджеты из таблицы §6, соответствие адресного префикса уровню |
| `tests/sector-flight.test.mjs` | `T ≤ 1 500` для `Δ = 0…12` и для всех стартовых уровней (`Δ ≥ 10` → ровно `1 500`); монотонность и непрерывность лог-интерполяции (нет скачков центра и ширины); `planArrowTrip`: откат `×25`, кламп `16 000`, `2,2·d` для дальних целей, схлопывание фазы `B`; отмена на любой фазе без откатов; `reduced-motion` → `120 мс` |
| `tests/sector-units.test.mjs` | `formatDistanceLy`: `8,4`, `88,4`, `90,79`, `108,07`, `1 302,9`, `5 776,3`, `≥ 10 000`; запятая, неразрывный пробел, отсутствие `ly`/`св. лет`; `pluralYears(1/2/5/21/90,8)`; `formatAngleDeg` для `±180°` и `−0` |
| `tests/sector-arrows.test.mjs` | отбор `k = 5` строго по расстоянию от центра камеры; видимая цель **не** исключается (кейс «в кадре, но не в центре»); слияние при `Δθ < 24°` и при превышении лимита, счётчик `+n` равен числу отсечённых; позиция в пределах `±8°` от `atan2`; мобильный сдвиг `±24 px` не ломает попадание в хит-зону; `±0` при центре на системе; подпись доступна без `hover` и содержит единицу (`св.г.`); счётчик `+n` содержит предел отсечённых; `aria-label` со склонением и порядок `Tab` |

Плюс `tools/verify_sector_address.mjs` в `check.yml` и `npm run verify:address`;
`npm test` расширяется тремя файлами (сейчас 17 Node-файлов).

---
