# Гидрология: версии и выходные данные

>
> Источник: [`docs/stages/stage-5-hydrology-biomes.md`](../../stage-5-hydrology-biomes.md) · строки 1–135.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

**Дата:** 21 октября 2026 года

**Статус:** реализовано в PR Этапа 5; до merge не считать опубликованным в `main`.

**Модуль:** `site/shared/planet-surface.js`

**Версии полного поверхностного рецепта:**

- `grid_version=goldberg-gp-v1`;
- `noise_version=planet-noise-simplex3d-v1`;
- `geography_version=c100-soft-v2`;
- внутри v2: база полей/C100 — `c100-soft-v1`;
- гидрология — `planet-hydrology-v1`;
- биомы — `planet-biomes-v1`;
- `preset_version=planet-presets-v1`.

## 1. Что закрывает этап

Этап 5 поверх замороженной базы Этапа 4 добавляет:

- priority-flood поверхность и глубину впадин;
- направленный сток к соседу с наибольшим понижением;
- климатически взвешенное накопление потока;
- строгие терминальные водосборы фактического дерева стока;
- отдельные дренажные регионы целевого масштаба `drainage_mean_cells`;
- переполняющиеся озёра, терминальные озёра и бессточные впадины;
- веса ручьёв/рек, речное влияние и дельты только у берега/шельфа;
- уклон, горный вес, тектонические горные швы и записи хребтов;
- 16 мягких биомов с top-2, энтропией перехода и готовым CPU-цветом;
- валидатор, sync/async API и Transferable-контракт;
- статистический bench ансамблей и CI-гейт G3 для CPU-части поверхности.

Этап **не** подключает результат к боевому глобусу, странице планеты или
worker-пути. Это Этапы 6–7. `/planet-test/` по-прежнему показывает старый
спайковый sampler. Конкретная подячеечная линия русла также не строится:
на глобальном уровне река — направленный граф ячеек и вес канала, а её
геометрия внутри ячейки появится на локальной карте.

## 2. Версии и миграция профиля

`geography_version` в контракте `planet_generation` означает полный рецепт
*поля + континенты + гидрология + биомы*. Поэтому Этап 5 не переопределил
`c100-soft-v1`, а ввёл `c100-soft-v2`:

```text
c100-soft-v2
  = c100-soft-v1              (поля, море, плиты, C100, океанические бассейны)
  + planet-hydrology-v1       (сток, впадины, озёра, водосборы, дельты, швы)
  + planet-biomes-v1          (мягкие биомные смеси и цвета)
```

`PlanetGeography` остался модулем только базы v1 и по-прежнему отвергает
`c100-soft-v2` как свой вход. `PlanetSurface` принимает опущенную версию
или явную `c100-soft-v2`, а внутри принудительно строит базу как v1. Явный
профиль `c100-soft-v1` поверхностный модуль отвергает: это рецепт без
гидрологии и биомов, и молча превращать его в v2 нельзя.

`PlanetSurface.augmentGeography(...)` — другое действие: он сознательно
берёт уже построенный результат базы v1 и достраивает поверхность v2. Все
22 базовых SoA при этом байт-в-байт те же, что у прямого вызова
`PlanetGeography.generateGeography(...)` с тем же профилем; это закреплено
тестом.

Python-контракт теперь по умолчанию выдаёт `c100-soft-v2`. Явная
`c100-soft-v1` остаётся допустимой валидатором как legacy-рецепт только
полей/C100 Этапа 4. Golden-ключ тестового замороженного профиля обновлён
на `PG1-5NKT36OZBP4QPXE32CKQ5V3ANI`. Живых профилей в
`planet_generation` по-прежнему нет, миграция существующих планет не нужна.

## 3. Выходные данные

Результат — плоский объект: все поля базы Этапа 4 доступны на верхнем
уровне, исходный результат базы дополнительно лежит в `baseGeography`.
`profile` результата уже является полным профилем v2 и содержит
`baseGeographyVersion`, `hydrologyVersion` и `biomeVersion`.

Модуль добавляет 23 типизированных массива (`PlanetSurface.ARRAY_FIELDS`):

| Группа | Поля |
|---|---|
| Заполненная поверхность | `filledElevation`, `depressionDepth`, `slope` |
| Сток | `flowReceiver`, `flowAccumulationKm2`, `flowAccumulationCells` |
| Водосборы | `catchmentId`, `drainageRegionId`, `terminalType` |
| Вода на суше | `lakeId`, `lakeWeight`, `streamWeight`, `riverInfluence`, `deltaWeight` |
| Горы | `mountainWeight`, `mountainSeamWeight`, `mountainRangeId` |
| Биомы | `biomeTop1Id`, `biomeTop1Weight`, `biomeTop2Id`, `biomeTop2Weight`, `biomeEntropy`, `biomeColor` |

`slope` — максимальный уклон **вниз** к соседней ячейке по сырой высоте,
делённый на хордовое расстояние между центрами на единичной сфере. Это
гидрологический уклон, а не полный модуль градиента рельефа.

`terminalType` имеет коды `0=none`, `1=ocean`, `2=terminal_lake`,
`3=endorheic`. Для применимой поверхности каждая hard-суша получает один
из кодов 1–3.

Записи:

- `catchments[]` — строгий терминальный водосбор: корневая/устьевая ячейка,
  downstream, тип терминала, число ячеек, физическая и эффективная площадь
  суши, максимальный поток, связанное озеро;
- `drainageRegions[]` — целевой дренажный регион: outlet, площадь, число
  ячеек, список входящих строгих водосборов, доминантный водосбор,
  физический массив суши и тип терминала outlet-ячейки;
- `lakes[]` — представитель, outlet/downstream, признак переполнения,
  число ячеек, эффективная площадь, глубина впадины, уровень перелива,
  водосбор и исходная впадина;
- `mountainRanges[]` — представитель с максимальной высотой, число ячеек,
  площадь, максимальная сырая высота и до двух доминантных плит;
- `biomeDefinitions[]` — стабильные `id`, `key`, русское имя и базовый
  линейный RGB-цвет каждого биома;
- `thresholds` — фактические уровни процентилей высоты, влажности,
  температуры, потока и квантили уклона P55/P70/P95.

API:

```js
PlanetSurface.normalizeSurfaceProfile(input)
PlanetSurface.generateSurface(grid, profileOrGeography, options?)
await PlanetSurface.generateSurfaceAsync(grid, profileOrGeography, options?)
PlanetSurface.augmentGeography(grid, geography, options?)
await PlanetSurface.augmentGeographyAsync(grid, geography, options?)
PlanetSurface.validateSurface(grid, surface)
PlanetSurface.typedBytesOf(surface)
PlanetSurface.listTransferableBuffers(surface)
PlanetSurface.packSurfaceForTransfer(surface)
```

Async-вариант дробит сэмплирование базовых полей и уступает управление
перед поверхностной фазой, но графовая гидрология и биомы пока считаются
одним синхронным проходом. Боевой путь Этапов 6–7 обязан запускать
генератор в Web Worker и передавать результат через
`packSurfaceForTransfer(...).transfer`.
