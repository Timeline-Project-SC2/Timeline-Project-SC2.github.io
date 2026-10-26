# Море, плиты, C100-soft и океанические бассейны

>
> Источник: [`docs/stages/stage-4-fields-c100-soft.md`](../../stage-4-fields-c100-soft.md) · строки 127–265.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 3. Море, шельф и плиты

### 3.1. Уровень моря

`seaLevel`, `shelfBelowLevel` и `shelfAboveLevel` считаются из
**площадно-взвешенных** квантилей `ocean_pctl`, `shelf_below_pctl` и
`shelf_above_pctl` по фактическим `grid.areas`, а не по числу ячеек.

Подписанное расстояние до берега не целочисленное: для граничной ячейки
по соседям противоположного класса линейно оценивается положение
пересечения уровня моря между центрами, затем дробное расстояние
распространяется по графу Дейкстрой с ребром 1. Поэтому пороги мягкой
суши 0.35, 0.5 и 0.65 дают действительно разные физические массивы.

### 3.2. Мягкие суша/шельф/океан

Для каждой ячейки хранятся `muLand`, `muShelf`, `muOcean`, в сумме 1.
`muLand` — smoothstep от подписанного расстояния и
`coast_soft_width_cells`; шельфовый потенциал дополнительно зависит от
положения высоты между шельфовыми процентилями и близости к берегу.

Support для идентичностей:

```text
continentSupport = clamp01(muLand + 0.30·muShelf)
oceanSupport     = clamp01(muOcean + 0.55·muShelf)
```

Для `surface_class=gas_giant` и `no_surface` генератор не изображает
фиктивную поверхность: результат имеет `surfaceApplicable=false`, пустые
списки континентов/бассейнов/плит и нулевую поверхностную статистику.

### 3.3. Плиты

Всегда строится семь плит. Их центры выбираются детерминированным
farthest-point из случайных направлений домена `plate-seeds`, ячейка
относится к ближайшему центру сферической диаграммы Вороного.
`plateBoundary` растёт при малом разрыве между лучшей и второй плитой;
граница усиливает вулканизм и стоимость перехода C100.

## 4. C100-soft и океанические бассейны

### 4.1. Семена и желаемые массы

Число семян начинается с

```text
K = round(totalSupport / targetMeanCells)
```

Желаемые массы — логнормальный набор с суммой `totalSupport`.
`continent_variation` задаёт целевой разброс **эффективных** масс;
внутренний набор континентов строится с усилением sigma ×1.25, потому
что барьеры и графовая балансировка частично регрессируют распределение
к среднему. Для океанических бассейнов внутренняя sigma v1 равна 0.45.

Семена выбираются не равномерно вслепую. Кандидаты должны иметь
support не ниже 0.45 и принадлежать достаточно крупной support-компоненте.
Далее работает desired-aware farthest-point: самые крупные желаемые
домены расставляются первыми и требуют большей свободной окружности,
мелкие заполняют оставшиеся географические карманы. Score семени тянет
континенты внутрь суши/к высокой местности, а океанические бассейны —
вглубь океана и к низкой батиметрии.

### 4.2. Графовый рост и top-2

Стоимость ребра зависит от:

- базовой длины ребра;
- перепада высоты;
- климатического перепада температуры/влажности;
- смены плиты и близости к границе плит;
- барьера низкого support: для континента — воды, для океанического
  бассейна — суши.

Сначала выполняются top-1 прогоны Дейкстры и bias семян корректируется
по отношению желаемой массы к фактической support-массе. Финальный
прогон хранит две лучшие идентичности на ячейку. Вес top-1 — логистическая
функция разности дистанций с температурой `continent_soft_width_cells`;
энтропия нормирована в `0..1`.

Эффективная масса и площадь:

```text
M[k] = Σ support[i] · weight[i,k]
A[k] = Σ support[i] · weight[i,k] · area[i] · R²
```

Идентичности без единой top-1 ячейки в публичный список не попадают:
они отрезаются, ID перенумеровываются, а их top-2 масса возвращается
фактическому top-1. Поэтому у каждой записи `continents[]` и
`oceanBasins[]` есть `hardCellCount > 0`.

Для океанических бассейнов наружу отдаются top-1 `oceanBasinId` и
`oceanBasinWeight`; полная top-2 пара хранится только для континентов,
как требует модель C100.

## 5. Выходные SoA и API

`PlanetGeography.ARRAY_FIELDS` фиксирует 22 типизированных массива:

- поля: `elevation`, `moisture`, `temperature`, `plateAffinity`,
  `volcanism`, `detail`;
- море/берег: `muLand`, `muShelf`, `muOcean`,
  `signedCoastDistanceCells`;
- плиты: `plateId`, `plateBoundary`;
- континенты: `continentSupport`, `continentTop1Id`,
  `continentTop1Weight`, `continentTop2Id`, `continentTop2Weight`,
  `continentEntropy`;
- океан и физические массивы: `oceanSupport`, `oceanBasinId`,
  `oceanBasinWeight`, `physicalLandmassId`.

`physicalLandmassId` соответствует связным компонентам при
`muLand >= 0.5`; статистика дополнительно содержит пороги 0.35 и 0.65.

Основные API:

```js
PlanetGeography.normalizeProfile(input)
PlanetGeography.createFieldSampler(profile)
PlanetGeography.generateGeography(grid, profile, options?)
await PlanetGeography.generateGeographyAsync(grid, profile, options?)
PlanetGeography.validateGeography(grid, geography)
PlanetGeography.typedBytesOf(geography)
PlanetGeography.listTransferableBuffers(geography)
PlanetGeography.packGeographyForTransfer(geography)
```

Профиль принимает camelCase и snake_case колонки `planet_generation`.
Чужие `grid_version`, `noise_version`, `geography_version` и
`surface_class` отвергаются явно.

`generateGeographyAsync` сэмплирует поля чанками и вызывает
`onProgress`/`yieldControl`, но финальные графовые фазы пока синхронны.
Боевой путь Этапов 6–7 поэтому должен запускать генератор в Web Worker
и передавать крупные буферы через `packGeographyForTransfer(...).transfer`,
а не рассчитывать, что async-обёртка сама сделает главный поток
неблокирующим.
