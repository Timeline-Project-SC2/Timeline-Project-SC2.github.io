# Волны Stage-8.2…8.7: матрицы файлов и гейты

> Источник: `agents_task_orchestration.md`, строки 161–305 (редакция до разукрупнения).
> Назад: [оркестрация](../agents_task_orchestration.md) · [этапы](../../stages/README.md) · [документация](../../README.md).

## 10. Матрица волны Stage-8.2 (Выделен только активный гекс + бесшовный планетарный горизонт с отдалёнными текстурами и плавным спуском до уровня)

Цель волны **Stage-8.2** — вернуть естественную непрерывную сферическую модель горизонта (как в `334b4c1`) без «пластилиновой ромашки» из 7 отдельных подушек и без просвечивающего сзади несоразмерного глобуса, но с тремя целевыми улучшениями:
1. **Выделен только активный центральный гекс** (`hexApothem = 0.8054 * focusRadiusM`, `centerHexDist = hexMetric2D(v_worldPos.yx)`): детальный меш $257 \times 257$ обрезается строго по контуру правильного шестиугольника активной ячейки и обрамляется тонкой аккуратной тактической границей без физических провалов (`bevelDropM`) и без сетки 6 колец по всему горизонту.
2. **Бесшовный простирающийся горизонт с рельефом, отдалёнными текстурами и постепенным ухудшением видимости**: вокруг выделенного центрального гекса расстилается единая непрерывная сферическая юбка (`97 × 57 = 5 529` вершин, `outerRadiusM = 6.5 * hexSpacingM = 7.475 * radiusPatchM`, `planetRadiusM = 3.6 * outerRadiusM`), сшитая по гексагональной метрике `clusterHexMetric` на границе `hexApothem` без единой ступеньки высоты, с процедурными разномасштабными текстурами породы/биомов и плавным нарастанием оптического блюра и атмосферной дымки от границы гекса к сферическому горизонту.
3. **Плавный двухфазный спуск вниз до уровня участка**: при погружении с глобуса (по кнопке или зумом колёсика мыши до упора на выбранной ячейке) камера сначала сближается с ячейкой на глобусе (`MIN_DISTANCE = 1.15`), а затем плавно спускается по дуге с суборбитальной высоты до тактического уровня над активным гексом (`1150 мс`) с возможностью свободного приближения до самого уровня земли/построек (`0.05 * R_patch`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Непрерывная сферическая юбка горизонта с гексагональной сшивкой высот и тесты `local-map-stage8.test.mjs`; слитый PR #178)* | 1. В `src/local-map/local-map-worker.ts` вернуть непрерывную полярную сетку горизонта `generateHorizonSkirt` (`SKIRT_ANGULAR_SEGMENTS = 96`, `SKIRT_RADIAL_RINGS = 56`, `SKIRT_COLLAR_RINGS = 14`, `5 529` вершин, `32 256` индексов, `innerRadiusM = 0.72 * radiusPatchM`, `hexSpacingM = 1.15 * radiusPatchM`, `outerRadiusM = 6.5 * hexSpacingM`, `planetRadiusM = 3.6 * outerRadiusM`) без 6 отдельных плит-лепестков и без провалов `bevelDropM`.<br>2. Сохранить экспортируемые `hexMetric2D`, `clusterHexMetric(x, y) = hexMetric2D(y, x)` и `mapNeighborCellsToSlots`, а сшивку воротника с `innerHeightfield` выполнить строго по гексагональной метрике `hexDist = clusterHexMetric(x, y)` относительно `hexApothem = 0.8054 * radiusPatchM` (`blend = 0` внутри `hexDist <= hexApothem`, плавный `smooth01` на интервале `[hexApothem, 1.18 * hexApothem]`), чтобы на шестиугольном срезе центра высоты совпадали 1-в-1.<br>3. Обновить `tests/local-map-stage8.test.mjs` под непрерывную юбку (`5 529` вершин / `32 256` индексов) и гексагональную непрерывность воротника. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Выделение только активного гекса, процедурные отдалённые текстуры и постепенная деградация видимости к горизонту; слитый PR #179)* | 1. В `src/local-map/local-map-shaders.ts` (`TERRAIN_FRAGMENT_SHADER`): обрезать квадратный центральный меш (`u_isSkirt < 0.5`) строго по контуру одного центрального гекса (`centerHexDist = hexMetric2D(v_worldPos.yx) > hexApothem`, где `hexApothem = u_focusRadiusM * 0.8054`).<br>2. Убрать закраску `FACET_BASE_COLOR`, фаски 6 соседей и 6-кольцевую гекс-сетку на юбке; вместо этого выделить **только активный центральный гекс** аккуратной тонкой тактической кромкой вдоль `centerHexDist ≈ hexApothem` прямо по рельефу.<br>3. Реализовать многомасштабную процедурную текстуру рельефа (мелкое зерно породы/грунта вблизи + среднемасштабная слоистость и пятнистость биомов/ложбин на средней дистанции) и плавное ухудшение видимости (`blur = smoothstep(hexApothem, u_fogEnd * 0.90, centerHexDist)`): внутри активного гекса `blur == 0`, а за его пределами мелкие детали, затем средние текстуры и нормали постепенно сглаживаются и уходят в воздушную дымку `u_horizonColor` / `u_fogColor` при непрозрачном куполе неба (`u_skyAlpha = 1.0` по умолчанию в `src/local-map/local-map-renderer.ts`). | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Непрозрачный экран горизонта и плавный двухфазный спуск камеры от глобуса до уровня земли; слитый PR #177)* | 1. В `site/planet-globe/planet-globe.css` и `site/planet-globe/planet-globe.ts` вернуть непрозрачный фон `.local-map-stage` и `#localMapCanvas` (`alpha: false`, `clearColor(0.015, 0.045, 0.075, 1)`), убрать постоянный `syncGlobeWithLocalCamera` в каждом кадре (чтобы сзади не просвечивал мелкий глобус).<br>2. В `site/shared/planet-globe.ts` уменьшить `MIN_DISTANCE` с `1.35` до `1.15` и добавить опциональный коллбэк `onZoomDive?: () => void` при прокрутке колеса мыши на приближение (`e.deltaY < 0`) у нижней границы дистанции (`targetDistance <= MIN_DISTANCE * 1.02`), чтобы зум колёсиком в выбранную ячейку на глобусе плавно переводил камеру на локальный уровень.<br>3. В `site/planet-globe/planet-globe.ts` реализовать **плавный двухфазный спуск до уровня участка**: сначала подлёт глобуса к ячейке (`globe.flyToDirection(centerCell.center, 1.18, 420)`) с параллельной подготовкой буферов локальной карты, затем плавный `fade-in` локальной сцены и мягкое пикирование камеры (`startLocalDiveInAnim`: `1150 мс`, `fromDist = targetDist * 4.8 → targetDist`, `fromPitch = 1.30 → LOCAL_REST_PITCH = 0.44`, `easeInOutCubic`), а также свободный зум колёсиком вплоть до уровня поверхности/построек (`minDist = Math.max(2, localMapRadiusM * 0.05)`) и обновление `docs/HANDOFF.md` + `CHANGELOG.md`. | - `site/planet-globe/planet-globe.ts`<br>- `site/planet-globe/planet-globe.css`<br>- `site/shared/planet-globe.ts`<br>- `docs/HANDOFF.md`<br>- `CHANGELOG.md` | Все остальные файлы, включая `src/local-map/*`, `tests/local-map-stage8.test.mjs` |

**Хотфикс Stage-8.2.1 (слитый PR #180)** — «зеркало континентальных озёр на юбке горизонта и запрет спавна на воде»: точечная правка трёх файлов кодового контура волны (объединённый хотфикс поверх веток Воркеров 1–2):

- `src/local-map/local-map-worker.ts`
- `src/local-map/local-map-shaders.ts`
- `tests/local-map-stage8.test.mjs`

---

## 11. Матрица волны Stage-8.3 (Планетарный масштаб юбки, гребневые хребты, дневной купол неба и панорамный ракурс долины — PR #183, #182, #181)

Цель волны **Stage-8.3** — превратить локальную сцену из «тактического стола» в живую планетарную долину: расширить планетарный масштаб сферической юбки горизонта с гребневыми хребтами и природной долиной, ввести дневной облачный купол неба в кадровом цикле рендера и зафиксировать панорамный ракурс камеры «изнутри долины на горный горизонт» (`LOCAL_REST_PITCH = 0.31`, светлый дневной тон очистки `gl.clearColor(0.52, 0.62, 0.74, 1)`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Планетарный масштаб юбки, гребневые хребты и природная долина; слитый PR #183)* | Планетарное масштабирование непрерывной сферической юбки в `src/local-map/local-map-worker.ts`: гребневые ridged-FBM хребты, природная долина активного гекса и согласованное сферическое проседание `planetCurvatureDropM`; обновление тестов `tests/local-map-stage8.test.mjs` под новую геометрию и параметры юбки. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Живая долина, скальные хребты и дневное облачное небо в шейдерах; слитый PR #182)* | Процедурные шейдеры долины и скальных хребтов в `src/local-map/local-map-shaders.ts`, подключение дневного облачного купола неба (`SKY_DOME_*`, `opaqueSkyDome`, `skyAlpha = 1.0`) и светлой атмосферной палитры в `src/local-map/local-map-renderer.ts`. | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Купол неба в кадровом цикле и панорамный ракурс долины; слитый PR #181)* | Передача камеры в `renderFrame` (купол неба на каждом кадре), панорамный ракурс «изнутри долины» в `site/planet-globe/planet-globe.ts` (`LOCAL_REST_PITCH = 0.31`, сдвиг точки прицела вперёд по взгляду, кривая двухфазного Dive-in `1150 мс`) и первый срез отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

---

## 12. Матрица волны Stage-8.4 (10 колец прогрузки горизонта 145×85, чёткие ближние 3–4 круга и плавное скольжение камеры между гексами — PR #184, #185, #186)

Цель волны **Stage-8.4** — расширить прогрузку местности вокруг активного гекса с 6 до **10 колец** (полярная сетка юбки **145 × 85 = 12 325 вершин**, `32 256` индексов), сохранить бесшовную детализацию первых 3–4 кругов гексов (старт тумана поднят до `0.64 · outerRadiusM`) и заменить мгновенный сброс камеры при переходе между ячейками на непрерывное 820-мс скольжение с сохранением пользовательского азимута.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Плотный горизонт 10 колец (145×85) и плавный рельеф; слитый PR #184)* | Уплотнение полярной сетки `generateHorizonSkirt` до `SKIRT_ANGULAR_SEGMENTS = 144` / `SKIRT_RADIAL_RINGS = 84` (**145 × 85 = 12 325 вершин**) в `src/local-map/local-map-worker.ts`, плавный рельеф 10 колец и обновление тестов `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Цельный переход активного гекса и чёткие ближние 3–4 кольца; слитый PR #185)* | Настройка шейдерной дымки и тактической кромки в `src/local-map/local-map-shaders.ts`: первые 3–4 круга гексов остаются полностью прозрачными и детальными, без шва на границе `Patch7` и без размытия ближней долины. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Плавное скольжение камеры между гексами и 10 колец в HUD; слитый PR #186)* | Бесшовный перелёт `startLocalNeighborFlyAnim` (`820 мс`, `easeInOutCubic`, сохранение пользовательского yaw), расширение панорамирования/клика/зума под 10 колец и честный HUD числа колец в `site/planet-globe/planet-globe.ts`; дополнение отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md` разделом 5. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

---

## 13. Матрица волны Stage-8.5 и хотфиксов 8.5.1 / 8.5.2 (Фиксированный физический масштаб гекса, 11-ступенчатая логарифмическая шкала видимой ширины и маркер воды — PR #189, #187, #188, #190, #191)

Цель волны **Stage-8.5** — зафиксировать физический радиус тактического гекса (`LOCAL_PATCH_BASE_RADIUS_M = 2500 м`, диаметр ≈4,5 км; 10 колец охватывают `R_outer ≈ 28,75 км`), чтобы селектор «Видимая ширина» управлял только дистанцией/наклоном камеры (`cameraDistanceForWidthKm`, 11 логарифмических ступеней `1250 … 1.2 км`) без растяжения меша и построек, а также ввести явный маркер воды в `terraformMap` и устранить ложную воду на суше.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Явный маркер воды в `terraformMap`, гладкая интерполяция `Patch7` и направленный рельеф без вала; слитый PR #189)* | Маркер воды `terraformMap = 0` в `src/local-map/local-map-worker.ts`, гладкая интерполяция полей `Patch7`, направленный рельеф без периметрального вала и расширение `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Устранение ложной воды, билинейное сглаживание зон и тактический контур гекса; слитый PR #187)* | Шейдерные правки `src/local-map/local-map-shaders.ts`: устранение ложной воды, билинейное сглаживание зон и аккуратный тактический контур активного гекса. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Фиксированный физический масштаб гекса и камера «видимой ширины»; слитый PR #188)* | Константа `LOCAL_PATCH_BASE_RADIUS_M = 2500`, `cameraDistanceForWidthKm` / `cameraPitchForWidthKm`, 550-мс анимация камеры без перегенерации меша и честный HUD Δz в метрах в `site/planet-globe/planet-globe.ts`; раздел 6 отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

**Хотфиксы волны (Zero File Overlap сохранён, правки только в файлах кодового контура Stage-8.5):**

| Хотфикс | Суть | Слитый PR и затронутые файлы |
|---|---|---|
| **Stage-8.5.1** | Переход по соседним ячейкам без рывка, мягкая кромка прибоя и прибрежный рельеф юбки | **PR #190:** `site/planet-globe/planet-globe.ts`, `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs` |
| **Stage-8.5.2** | Логарифмическая шкала всех 11 ступеней видимой ширины и возврат камеры в долину | **PR #191:** `site/planet-globe/planet-globe.ts` |

---

## 14. Матрица волны Stage-8.6 (Межъячеечная синхронизация горизонта, знаковая батиметрия, сквозные реки, 5 высотных поясов и ориентация камеры по Северу — PR #192, #194, #193)

Цель волны **Stage-8.6** — связать три уровня сцены в непрерывное целое: межъячеечную синхронизацию процедурного поля высот соседних канонических ячеек (общий `planetSeed`, отмена положительной `elevCalibration` на океанском патче, знаковая батиметрия `z < 0`), сквозные реки на любой высоте (`terraformMap = 0` + `isRiverStream`), 5 метрических высотных поясов суши и строгую ориентацию камеры локальной карты по Северу (`LOCAL_REST_YAW = -π/2`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Синхронизация берега и русел: `planetSeed`, знаковая батиметрия и отмена `elevCalibration` на океане; слитый PR #192)* | В `src/local-map/local-map-worker.ts`: единый `planetSeed` для соседних ячеек, знаковая батиметрия (`depth = elevation - seaLevel < 0`), принудительный `elevCalibration = 0` на водном центральном гексе и синхронизация берега/русел с непрерывным полем юбки; обновление `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Объёмная глубина воды, реки на любой высоте и 5 высотных поясов суши; слитый PR #194)* | В `src/local-map/local-map-shaders.ts`: объёмная глубина воды и подводный склон шельфа, сквозные ленты русел (`isRiverStream`) с семплированием общей высотной функции на любой высоте и 5 высотных поясов рельефа (батиметрия, низменность, равнины, предгорья, горы/снег) со `smoothstep`-переходами. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Ориентация камеры строго по Северу и переход к соседу без кадра сброса; слитый PR #193)* | В `site/planet-globe/planet-globe.ts`: `LOCAL_REST_YAW = -Math.PI / 2` (камера смотрит строго на Север, совпадение подписей «СОСЕДИ PATCH7» со стороной света) и переход к соседней ячейке без кадра сброса; раздел 7 отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |





---

## 15. Матрица волны Stage-8.7 (Бесшовный межъячеечный переход, голографические квик-стрелки и рендер колец 1–5)

Цель волны **Stage-8.7** — сделать переход между каноническими гексами локальной карты визуально непрерывным (камера не дёргается, ни одного кадра сброса), дать игроку квик-навигацию «время от времени возникающими» голографическими стрелками, перпендикулярными граням активного гекса, и разрешить рендер кольцевых областей вокруг активного участка — **до 5 колец включительно**.

### 15.1. Модель колец: гексагональная геометрия + экспоненциальный LOD

Кольцо `k` вокруг активного гекса содержит ровно `6k` ячеек; число колец — до `k = 5`. Экспонента заложена не в форму кольца, а в **разрешение высотного поля**: каждая следующая кольцевая область вдвое грубее предыдущей, поэтому площадь покрытия растёт квадратично, а стоимость ячейки падает экспоненциально.

| Кольцо | Ячеек (`6k`) | `hfRes` | Накопительно (`3k(k+1)+1`) |
|---|---:|---:|---:|
| 0 (центр, `Patch7`) | 1 | 256 | 1 |
| 1 | 6 | 64 | 7 |
| 2 | 12 | 32 | 19 |
| 3 | 18 | 16 | 37 |
| 4 | 24 | 8 | 61 |
| 5 | 30 | 4 | **91** |

Бюджет CPU-буферов при `neighborRings = 5`: высотные поля `43 488` значений `f32` (**≈ 170 КиБ**) и `waterMask` `43 488` байт (**≈ 42,5 КиБ**), итого **≈ 216 КиБ** на патч — вдвое ниже лимита гейта **G6.3** (`≤ 512 КБ`).

**Факт волны (после слияния PR #200–#202 и интеграционного фикса 8.7.1).**
`RING_HF_RES` в воркере и в рендерере обязан совпадать: рассинхрон `[256, 32, 16, 8, 4, 2]` против `[256, 64, 32, 16, 8, 4]` приводил к отбраковке ячеек
слотами и распаду batch-отрисовки — **92 terrain-draw вместо 7**. После
выравнивания контракта: `ringGenMs ≈ 7 мс`, CPU-буферы колец ≈ 216 КиБ,
GPU-буферы колец **2,4 МБ** (позиции, нормали, локальные XY, вода, индексы),
draw-вызовы: **2 + число колец** (batch на кольцо), порядок `5 → 4 → 3 → 2 → 1 → центр → юбка`.
Ячейка `ringCells[i].cell` — **синтетический индекс отрисовки**, а не
канонический адрес сетки: кольца 2–5 строятся как плоская гексагональная
решётка в касательной плоскости вокруг `Patch7`. Переход между гексами
разрешён только по `activePatchReady.patch.cells[1..6]` (канон, И-1/И-3).

### 15.2. Матрица распределения файлов (`Zero File Overlap`)

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Кольцевые области 1–5 в воркере, LOD-таблица и тесты; слитый PR #202 `4e86363`, фикс PR #203 `282d726`)* | Обход колец `1..5` от канонического центра `Patch7` по `GeodesicGrid.neighbors`, разрешения `RING_HF_RES = [256, 64, 32, 16, 8, 4]`, `LocalMapRingCell` и необязательные поля `ringCells` / `ringCellCount` / `ringGenMs` / `neighborRings`; детерминизм, учёт колец в LRU-кэше участков и полная эквивалентность прежнему поведению при `neighborRings = 0`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Рендер колец 1–5 и бесшовный стык с юбкой горизонта; слитый PR #200 `257bd89`)* | Меш кольцевой ячейки из `heightfield` её разрешения в предвыделенных буферах без пересоздания VAO; юниформы `u_ringLevel` / `u_ringFade`; упрощение гипсометрии и воды по уровню кольца; передача цвета, тумана и нормалей в `u_fogColor` / `u_horizonColor` на границе «кольцо 5 → сферическая юбка»; порядок отрисовки `5 → 1 → центральный патч → юбка` без z-fighting; публичный `getRingStats()`. | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/*`, `site/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Бесшовный переход между гексами и интеграция квик-навигации; слитый PR #199 `a0c167e`, фикс PR #204 `a24bfe8`)* | Чистая функция `rebaseLocalCameraState(...)` (сохранение мировой точки прицела при сдвиге на шаг центров `d_hex = 1.15 · R_patch`), атомарная подмена патча в одном кадре без пустого кадра и сброса `LOCAL_REST_YAW`, сглаживание остаточного рассогласования `≤ 220 мс` (`easeOutCubic`), сохранение `latest-wins`; интеграция `createLocalMapQuickNav(host, onPick)` в `#localMapStage` с делегированием в `requestLocalNeighbor`; диагностика G6.1 (`max |Δeye|`, `max |Δyaw|`) за флагом `?debug=local`. | - `site/planet-globe/planet-globe.ts`<br>- `site/planet-globe/planet-globe.css`<br>- `site/planet-globe/index.html` | Все остальные файлы, включая `site/planet-globe/local-map-quick-nav.ts`, `site/shared/*`, `src/*`, `tests/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 4**<br>*(Модуль голографических квик-стрелок; слитый PR #198 `0f338a0`)* | Новый `site/planet-globe/local-map-quick-nav.ts` по контракту `QuickNavHintInput` / `LocalMapQuickNav` / `createLocalMapQuickNav` и чистая `layoutQuickNavArrows(...)`; цикл `7 200 мс`, окно `2 600 мс`, ступенчатая задержка `90 мс` по слотам `0..5`, `fade-in 180 мс` / `fade-out 260 мс`; голографический шеврон `#00ff66` с `mix-blend-mode: screen`, hit-area `≥ 44 × 44` CSS px, поддержка `prefers-reduced-motion`, запрет `eval`/`new Function` (CSP); тест `tests/local-map-quick-nav.test.mjs` и подключение его в `npm test`. | - `site/planet-globe/local-map-quick-nav.ts`<br>- `tests/local-map-quick-nav.test.mjs`<br>- `package.json` | Все остальные файлы, включая `site/planet-globe/planet-globe.ts`, `planet-globe.css`, `index.html`, `src/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 5**<br>*(Документация волны; запускается последним, после слияния PR 1–4; PR #205)* | Сводные записи волны: `CHANGELOG.md`, `docs/HANDOFF.md` (§1 «Статус», §2, §5, §8), новый раздел 7 в `docs/stages/STAGE_8_PLANETARY_HORIZON.md`, проставление номеров слитых PR в §15 настоящего документа и строка статуса «Местность до ~1 км» в `docs/PREPARATION_PLAN.md`. Числа — только из отчётов воркеров и кода, без домыслов. | - `docs/HANDOFF.md`<br>- `CHANGELOG.md`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md`<br>- `docs/agents_task_orchestration/agents_task_orchestration.md`<br>- `docs/PREPARATION_PLAN.md` | Все остальные файлы, включая `site/*`, `src/*`, `tests/*`, `tools/*`, `package.json`, `.github/*`, `data/*` |

**Ссылка на внешний аудит.** Замечания стороннего агента по ядру генерации разобраны и занесены в backlog **A-1…A-10** в [`docs/stages/planet-core-audit-2026-10-23.md`](../../stages/planet-core-audit-2026-10-23.md) (§5 — первый проход, §7 — политика радиуса, §8 — второй проход с проверкой по коду); к файлам этой волны они не относятся. Там же закрыт разрыв **Р-3**: битый скрипт `npm run verify:hashes` и отсутствующий полноценный FULL EQ-гейт — одна и та же проблема (пункт A-10).

**Стык `package.json`.** Единственный общий файл волны (подключение нового теста в `npm test`) отдан ровно **Воркеру 4** (правило О-1); остальным воркерам его правка запрещена.

**Стык `planet-globe.ts` ↔ `local-map-quick-nav.ts` (О-3, Interface-First).** Имя файла и сигнатуры `QuickNavHintInput`, `LocalMapQuickNav`, `createLocalMapQuickNav(host, onPick)` зафиксированы дословно до старта волны. Воркер 3 интегрирует модуль по контракту через временный локальный шим (5 строк, с комментарием «удалить после слияния PR Воркера 4») и не создаёт сам модуль; Воркер 4 не правит страницу.

### 15.3. Гейты волны (продолжение G5 → G6)

| Гейт | Критерий |
|---|---|
| **G6.1** | Переход между гексами непрерывен: `0` кадров со скачком `|Δyaw| > 0.002` рад или смещением точки прицела `> 1` CSS px; нет пустых кадров и сброса ракурса |
| **G6.2** | Квик-навигация: 6 стрелок, цикл `7 200 мс`, hit-area `≥ 44 × 44` CSS px, `prefers-reduced-motion` — без пульса и скан-линии, клики работают |
| **G6.3** | Кольца, две независимые части: **(а) CPU** — `ringGenMs ≤ 20 мс` и новые типизированные буферы `≤ 512 КБ` на патч при `neighborRings = 5`; **(б) GPU** — суммарные кольцевые буферы `≤ 4 МБ`, `0` видимых швов «кольцо 5 → юбка», steady-кадр `p95 ≤ 20 мс`. Формулировка 8.7 ошибочно смешивала CPU- и GPU-бюджет в одном лимите `512 КБ`; разделение введено по факту замера (`216 КиБ` CPU против `2,4 МБ` GPU) |
| **G6.4** | Матрица проверок зелёная: `tsc`, `eslint`, `npm run build`, `node --test`, `verify:publish`, `check.yml` 4/4 |

### 15.4. Порядок запуска

Воркеры 1–4 стартуют одновременно в отдельных ветках от `main`; Воркер 5 запускается после слияния PR 1–4 и проставляет фактические номера PR в таблицу §15.2. Каждый воркер останавливается перед merge — слияние выполняет Гайдлайнер после приёмки по гейтам G6.1–G6.4.

#### Урок волны

Временный шим по контракту **О-3 (`Interface-First`)** обязан быть заменён на импорт боевого модуля до закрытия приёмки волны: после независимого слияния PR #199 (`a0c167e`) и PR #198 (`0f338a0`) заглушка `createLocalMapQuickNavShim`, возвращавшая `null`, осталась активной в `site/planet-globe/planet-globe.ts`, из-за чего стрелки вообще не рисовались на сцене и гейт **G6.2** не достигался даже при полностью зелёном CI (устранено интеграционным фиксом Stage-8.7.2, PR #204 `a24bfe8`). Аналогично зеркальные константы межмодульного контракта (`RING_HF_RES` между воркером и рендерером, где рассинхрон давал `92` terrain-draw вместо `7` — фикс Stage-8.7.1, PR #203 `282d726`) должны проверяться сквозным интеграционным шагом Гайдлайнера сразу после слияния параллельных веток.

---
