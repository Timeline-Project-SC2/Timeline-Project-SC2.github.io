# Stage-8.5: масштаб гекса и «видимая ширина»

>
> Источник: [`docs/stages/STAGE_8_PLANETARY_HORIZON.md`](../../STAGE_8_PLANETARY_HORIZON.md) · строки 238–378.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 6. Stage-8.5 · Фиксированный физический масштаб гекса и камера «видимой ширины»

Срез волны **Stage-8.5** исправляет семантику селектора «Видимая ширина»
(`els.localScale`): прежняя реализация растягивала ОДИН гекс и 383 домика на
`(scale · 1000)/2` метров (при `1250 км` домики становились ≈15 км шириной,
а юбка горизонта улетала на R ≈ 7187 км с Δz ≈ 1018 км). Начиная с 8.5
физический размер тактического участка жёстко зафиксирован, а селектор управляет
только дистанцией/наклоном камеры над этой местностью.

### 6.1. `LOCAL_PATCH_BASE_RADIUS_M = 2500 м` — стабильный физический радиус

- Константа `LOCAL_PATCH_BASE_RADIUS_M = 2500` фиксирует физический радиус
  генерируемого центрального участка (диаметр активного гекса ≈4.5 км).
- В `enterLocalMap()` и `renderLocalMapFromPatch()` в `mapRequest.radiusM` и
  `localMapRadiusM` передаётся стабильный `LOCAL_PATCH_BASE_RADIUS_M` — меш
  больше не растягивается при переключении селектора `localScale`, домики и
  рельеф всегда генерируются в физически корректном метрическом масштабе.
- 10 колец горизонта охватывают `R_outer ≈ 28.75 км` вокруг центра с плотной
  сеткой — это реальный планетарный радиус кривизны `planetRadiusM`, проседание
  Δz которого честно считается в `planetCurvatureDropM()` (километры, а не
  тысячи километров).

### 6.2. `cameraDistanceForWidthKm(widthKm)` — логарифмическая шкала всех 11 ступеней `1.2 … 1250 км`

Селектор «Видимая ширина» (`#localScaleSel`, 11 ступеней `1.2 … 1250 км`) задаёт
только **видимую ширину захвата камеры** (`localCameraDistance`) и её наклон над
фиксированной метрической местностью. В хотфиксе **Stage-8.5.2** (`PR #191`,
`4f5e335`) прежняя линейная формула с ранним насыщением выше `55 км` заменена в
`site/planet-globe/planet-globe.ts` на равномерную **логарифмическую прогрессию**
по всем 11 ступеням:

```ts
function cameraDistanceForWidthKm(widthKm: number): number {
  const rect = els.localMapCanvas.getBoundingClientRect();
  const aspect = rect.height > 0 ? rect.width / rect.height : 1;
  const fit = Math.max(0.45, Math.min(1, aspect || 1));
  const tanHalfFov = Math.tan(LOCAL_MAP_FOV / 2);
  const minKm = 1.2;
  const maxKm = 1250;
  const clampedKm = clampLocal(widthKm, minKm, maxKm);
  const t = Math.log(clampedKm / minKm) / Math.log(maxKm / minKm);
  const minDist = Math.max(
    localMinCameraDistance() * 1.6,
    (localMapRadiusM * 0.22) / (tanHalfFov * fit),
  );
  const maxDist = (localMapRadiusM * 14.5) / (tanHalfFov * fit);
  return minDist * Math.pow(maxDist / minDist, t);
}
```

- нормированный параметр `t = Math.log(clampedKm / minKm) / Math.log(maxKm / minKm)`
  на отрезке `minKm = 1.2 … maxKm = 1250` даёт строгую геометрическую прогрессию
  `minDist * Math.pow(maxDist / minDist, t)` без мёртвых ступеней и залипания на
  потолке после `55 км`;
- нижняя граница `minDist = Math.max(localMinCameraDistance() * 1.6, (localMapRadiusM * 0.22) / (tanHalfFov * fit))`
  удерживает камеру внутри долины у 3D-построек на `1.2 км`, а верхняя
  `maxDist = (localMapRadiusM * 14.5) / (tanHalfFov * fit)` раскрывает полный
  высотный обзор 10-кольцевого диска на `1250 км`;
- верхний предел ручного/анимационного отдаления расширен до
  `localMaxCameraDistance = localMapRadiusM * 18`, гарантируя запас над `maxDist`;
- целевой наклон `cameraPitchForWidthKm(widthKm)` монотонно растёт вдоль всей
  логарифмической шкалы от панорамного `LOCAL_REST_PITCH = 0.31` рад (~17.8°)
  на `1.2 км` до `0.78` рад (~44.7°) на `1250 км`, чтобы ни одна ступень не
  упиралась в промежуточный потолок.

### 6.3. Плавная анимация камеры при переключении селектора и возврат панорамы в долину

- Обработчик `#localScaleSel` (`els.localScale`, событие `change`) и вход через
  `enterLocalMap()` проверяют: если локальная карта уже открыта для **той же**
  канонической ячейки (`activePatchReady.hexCenterCell === patchReady.hexCenterCell`)
  и не идёт загрузка соседнего участка (`!localPatchLoading && !pendingNeighborFly`),
  то меш **не** перегенерируется;
- если перед сменой масштаба пользователь увёл камеру панорамированием далеко от
  центра участка (`Math.hypot(localCameraTarget[0], localCameraTarget[1]) > localMapRadiusM * 0.6`),
  переключение селектора `#localScaleSel` предварительно вызывает
  `resetLocalCamera()`, возвращая точку прицела к активному гексу и центральной
  долине вместо пустого тумана на краю меша (`PR #191`);
- затем запускается плавная анимация `localCameraAnim` длительностью **550 мс**
  по кривой `easeInOutCubic`:
  - `fromDist → toDist = cameraDistanceForWidthKm(scale)` (высота камеры);
  - `fromPitch → toPitch = cameraPitchForWidthKm(scale)` (наклон);
  - `localCameraYaw` сохраняется, а `toTarget` сходится к канонической точке
    прицела долины;
- после старта анимации синхронно обновляются URL (`updateLocalMapUrl`) и HUD
  (`updateLocalMapHud`), так что пользователь видит актуальную «видимую ширину»
  уже в процессе полёта, не дожидаясь CPU/GPU-перегенерации.

### 6.4. Честный HUD статуса горизонта (`updateLocalMapHud`)

- Строка `els.localFogStatus.textContent` теперь показывает реальные километры
  10-кольцевого горизонта **и** текущую видимую ширину камеры:
  ```ts
  const ringsLabel = Math.round(skirt.outerRadiusM / Math.max(1, skirt.hexSpacingM));
  els.localFogStatus.textContent =
    `${ringsLabel} колец · R ${fmtNum(skirt.outerRadiusM / 1000, 1)} км (обзор ${fmtNum(localMapWidthKm, 1)} км, Δz ${fmtNum(horizonDropM, 0)} м)`;
  ```
- Сферическое проседание `Δz` теперь выводится в **метрах** (а не километрах,
  как раньше), что при фиксированном физическом R ≈ 28.75 км даёт честные
  значения порядка десятков метров — горизонт действительно виден как
  планетарное скругление, а не как многосоткилометровая пропасть.

### 6.5. Хотфиксы Stage-8.5.1 (`PR #190`) и Stage-8.5.2 (`PR #191`)

1. **Stage-8.5.1 (`PR #190`, коммит `81c5b2a`):**
   - исправлены контур переключения и сопоставление азимутов при клике и переходе
     по соседним ячейкам (`mapNeighborCellsToSlots`, защита `activePatchReady` и
     `!localPatchLoading && !pendingNeighborFly` в `enterLocalMap`, режим
     `latest-wins` без зависания при повторном клике);
   - смягчена зубчатая кромка прибоя на переходных треугольниках полярной сетки
     юбки за счёт 2D-шума береговой полосы `effectiveShoreZ`;
   - устранён «плоский стол» на прибрежной суше морских патчей: амплитуда
     гребней учитывает размах положительных высот макро-решётки над `seaLevel`
     (`SKIRT_LATTICE_RELIEF_CAP_M = 240`), поднимая холмы и гряды за воротником
     по локальной доле суши `effectiveLand` при сохранении плоского водного
     зеркала `z === 0` в воротнике.
2. **Stage-8.5.2 (`PR #191`, коммит `4f5e335`):**
   - устранены мёртвые потолки дистанции и наклона после `39 / 55 км` и внедрена
     логарифмическая прогрессия всех 11 ступеней селектора `#localScaleSel`
     (`1.2 … 1250 км`) с возвратом далеко панорамированной камеры к активному
     гексу и центральной долине.

### 6.6. Проверки волны Stage-8.5

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint site src
npm test                 # node --test (87 тестов, включая local-map-stage8.test.mjs)
npm run build            # tsc --noEmit + Vite -> .publish/
npm run verify:publish   # 7 маршрутов, build-manifest.json, паритет экспортов
npm run verify:contract  # кросс-проверка Python ↔ TS контракта
git diff --check
```

На визуальную приёмку владельца остаются: плавность подъёма/наклона камеры при
переключении «Видимой ширины» от 1.2 км к 1250 км (домики не растягиваются,
сетка гексов остаётся стабильной, горизонт юбки остаётся на своём месте при
смене масштаба), корректность значений Δz в HUD и отсутствие перегенерации меша
при смене селектора внутри уже открытой локальной карты.

---
