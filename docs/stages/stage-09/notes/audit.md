# Аудит рендера, воркера, контракта и сборки

>
> Источник: [`docs/stages/stage-9-vegetation-atlas.md`](../../stage-9-vegetation-atlas.md) · строки 55–228.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 1. Аудит фактического состояния (что реально есть в коде)

### 1.1. Рендер-конвейер локальной карты

`src/local-map/local-map-shaders.ts` содержит ровно четыре программы:
`STRUCTURE_VERTEX_SHADER` / `STRUCTURE_FRAGMENT_SHADER` и
`TERRAIN_VERTEX_SHADER` / `TERRAIN_FRAGMENT_SHADER`.

Фактическое состояние `TERRAIN_FRAGMENT_SHADER`:

- сэмплируются **две** текстуры — `u_zoning_map` (`usampler2D`, `RG8UI`) и
  `u_terraform_map` (`sampler2D`, `R8`);
- цвет поверхности считается **процедурно**: палитра пяти зон
  `ZONE_COLORS[5]`, гипсометрия `hNorm = clamp((z − 15) / 140, 0, 1)` с
  переходом `lowlandColor → ZONE_COLORS[0] → highlandColor`, изолинии рельефа
  каждые `16 м` (`contourPhase = abs(fract(z / 16.0) − 0.5)`), сетка площадок
  `fract(v_uv * 64.0)`, вода ниже `z ≤ 0` с `SHALLOW_WATER_COLOR` /
  `DEEP_WATER_COLOR`;
- освещение — `baseColor * (u_ambientColor + vec3(max(dot(N, L), 0.0) * 0.8))`
  и круговой туман по `v_fog`.

**Вывод:** ни альбедо-текстур, ни нормалей поверхности, ни биомов, ни
растительности в шейдере нет вообще. Биомная информация в GPU **не попадает**:
`biomeTop1Id / biomeTop1Weight / biomeTop2Id / biomeTop2Weight / biomeEntropy`
живут только в массивах `SurfaceArrays` (`site/shared/planet-surface.ts`,
`ARRAY_FIELDS`) и используются страницей `/planet-globe/` для текстовых панелей.

`TERRAIN_VERTEX_SHADER` отдаёт `v_worldPos`, `v_normal`, `v_uv`
(`a_position.xy / u_terrainSize + 0.5`) и `v_fog`; тангенциальных базисов,
`slope` и мировых производных в шейдер нет — их придётся добавить для
slope-aware растительности.

### 1.2. Воркер (`src/local-map/local-map-worker.ts`)

Константы контракта:

| Константа | Значение | Смысл |
|---|---:|---|
| `HEIGHTFIELD_RES` | `256` | сетка рельефа `256 × 256` (65 536 вершин) |
| `ZONE_RES` | `64` | `zoneMap` `RG8UI` (код зоны + плотность) |
| `TERRAFORM_RES` | `256` | `terraformMap` `R8`, гауссова маска терраформинга |
| `MAX_INSTANCES` | `4096` | бюджет инстансов 3D-структур |
| `METERS_PER_ELEVATION_UNIT` | `900` | метры рельефа на единицу высоты `c100-soft-v2` |
| `LAND_FBM_AMPLITUDE_M` | `80` | амплитуда локального fBm на суше |
| `PROFILE_DETAIL_AMPLITUDE_M` | `40` | амплитуда канала `detail` единого сэмплера |
| `DETAIL_LATTICE_STEPS` | `64` | решётка `65 × 65` кэширования канала `detail` |
| `RIVER_HALF_WIDTH_RATIO` | `0.03` | полуширина русла в долях радиуса |
| `RIVER_DEPTH_RATIO` | `0.0025` | глубина вреза русла |
| `LOCAL_MAP_CACHE_LIMIT` | `8` | LRU-кэш участков |

Ответ воркера (`LocalMapWorkerResponse`) — `heightfield: Float32Array`,
`zoneMap: Uint8Array` (`64² × 2`), `terraformMap: Uint8Array` (`256²`),
`instanceBuffers`, `meta`. **Полей климата и биомов в ответе нет.** Канал
`detail` единого 3D-сэмплера опрашивается только на решётке `65 × 65`
(`sampleDetailLattice`, `fields[5]`), а `moisture`, `temperatureBase`,
`plateAffinity`, `volcanism` воркер вообще не запрашивает.

`slope` используется только в `buildBuildingSpawnMask` (`local-map-contract.ts`,
`DEFAULT_BUILDING_SPAWN_RULE = { minLand: 0.5, maxSlope: 0.5 }`), в шейдер не
передаётся.

### 1.3. Контракт сшивки (`src/local-map/local-map-contract.ts`)

- `createPatchFieldSampler(input)` приводит `geographyVersion = 'c100-soft-v2'`
  к базовой `c100-soft-v1` и возвращает `PlanetGeography.createFieldSampler`
  (Wasm-батч `planet-core`), то есть **единый источник полей И-3.1** уже есть.
- `samplePatchFields(patch, sampler, u, v)` → `localPointToDirection` (exp-карта
  касательного кадра) → `sampler.sampleFields(x, y, z, out)`; порядок каналов
  в `out` — контракт `planet-geography` (`elevation`, `moisture`,
  `temperatureBase`, `plateAffinity`, `volcanism`, `detail`, …). Значит
  растительный слой может опираться на **тот же** сэмплер без нового источника
  истины — это ключевое преимущество перед любым «отдельным климатом для
  текстур».
- `patchBaseElevation`, `waterLevelOf`, `isWaterCell` — тождества берега и
  уровня воды (И-3.2), уже используются воркером.

### 1.4. Сборка растра (`tools/build_assets.py`, `.github/workflows/pages.yml`)

- Скрипт собирает: пирамиду тайлов сектора (`512×512`, уровни
  `1250/2500/5000/10000`, `534` тайла), `assets/galaxy-map-*.webp`, логотип,
  макеты, `data/meta.json`. Кэширование — по `sourceSha256` в
  `assets/tiles.json`.
- **Растительного пайплайна нет.** Точки расширения — список `STEPS`
  (`build_tiles`, `build_galaxy`, `build_logo`, `build_mackets`, `update_meta`),
  функции `sha256`, `save_webp(image, path, quality, method=6)`,
  `check_fresh()` и `image_version()`.
- **Найденный дефект для будущего расширения:** `image_version()` обходит
  только файлы верхнего уровня (`sorted(p for p in SRC.iterdir() if p.is_file())`).
  Если исходники растительности положить в поддиректорию
  `assets/src/terrain/`, они **не попадут** в `imageVersion`, и кэш браузера
  не инвалидируется при подмене тайла. Требуется `SRC.rglob('*')` (шаг
  обязателен, см. §5.3).
- `.github/workflows/pages.yml` кэширует изображения
  (`actions/cache/restore|save@v6.1.0`) по путям `assets/tiles`,
  `assets/tiles.json`, `assets/map-preview.webp`, `assets/galaxy-map-*.webp`,
  `assets/timeline-project-logo.webp`, `assets/koprulu-macket.webp`,
  `assets/ozd-macket.webp`; ключ — `hashFiles('assets/src/**',
  'tools/build_assets.py', 'tools/requirements.txt')`. Новые выходы
  (`assets/veg/*`, `assets/veg-atlas.json`) **обязаны** быть добавлены и в
  `path:`, иначе кэш их потеряет, а key при этом останется «попадающим».
- `.gitignore` перечисляет производные ассеты поимённо — новый каталог
  `assets/veg/` нужно добавить явно (иначе 15 МБ производных пикселей попадут
  в Git, что прямо запрещено §4.3 корневого `AGENTS.md`).
- `tools/verify_feature_parity.mjs` обходит всю `.publish/` и падает на сырых
  `.ts`; добавление `.webp` в `assets/` его не ломает, но новые ссылки в HTML
  попадут под проверку битых ссылок (`checkPublishedScriptReference`,
  `publishPathForRef`) — манифест `veg-atlas.json` должен существовать в
  публикации.

### 1.5. Биомная модель (`site/shared/planet-surface.ts` + `src/planet/assembly/kernels.ts`)

`BIOME_DEFINITIONS` (16 биомов, `planet-biomes-v1`, строки 214–231) задаёт
ключи, русские названия и базовые цвета:

| id | key | nameRu | color | hex |
|---:|---|---|---|---|
| 5 | `tundra` | Тундра | `0.480, 0.560, 0.480` | `#7A8F7A` |
| 6 | `boreal_forest` | Тайга | `0.120, 0.340, 0.220` | `#1F5738` |
| 7 | `temperate_forest` | Умеренный лес | `0.160, 0.460, 0.200` | `#297533` |
| 8 | `rainforest` | Дождевой лес | `0.030, 0.320, 0.120` | `#08521F` |
| 9 | `grassland` | Степь и равнины | `0.520, 0.580, 0.240` | `#85943D` |
| 10 | `shrubland` | Кустарники и саванна | `0.580, 0.480, 0.220` | `#947A38` |
| 15 | `wetland` | Водно-болотные угодья | `0.180, 0.420, 0.300` | `#2E6B4C` |
| 11 | `hot_desert` | Жаркая пустыня | `0.780, 0.600, 0.280` | `#C79947` |
| 12 | `barren` | Пустошь | `0.450, 0.400, 0.340` | `#736657` |
| 13 | `alpine` | Высокогорье | `0.480, 0.460, 0.440` | `#7A7570` |
| 14 | `volcanic` | Вулканическая местность | `0.320, 0.130, 0.080` | `#522114` |

Гидрологические веса (`ARRAY_FIELDS`): `lakeWeight`, `streamWeight`,
`riverInfluence`, `deltaWeight`, `mountainWeight`, `mountainSeamWeight`.
Скоринг биомов выполняется в Wasm-ядре `biomeWeights` (`kernels.ts`, секция
`biome weights`) и сглаживается `biomeWeightsAndSmooth` по
`biome_soft_width_cells`; наружу сохраняются перенормированные top-2, их
энтропия и CPU-смешанный `biomeColor`.

Точные формулы-драйверы (цитата коэффициентов из `kernels.ts`, они и есть
источник «климатического колорита»):

```text
effMoisture = clamp01(moisture + riverInfluence*0.22 + lakeWeight*0.25
                      + deltaWeight*0.10 - 0.10*desertFlag)
dryScore       = 1 - smoothstep(aridLevel, wetLevel, effMoisture)
wetScore       =     smoothstep(aridLevel, wetLevel, effMoisture)
veryWetScore   =     smoothstep(wetLevel, wetLevel + 0.55*moistSpan, effMoisture)
midMoistScore  = band(aridLevel - 0.25*moistSpan, aridLevel + 0.25*moistSpan,
                      wetLevel - 0.05*moistSpan,  wetLevel + 0.45*moistSpan, effMoisture)
slopeScore     = smoothstep(slopeP55, slopeP95, slope)

s5  tundra     = land * coldScore * (1 - iceScore*0.75) * (1 - mountain*0.45) * max(vegFactor, 0.25)
s6  boreal     = land * coolScore * (0.35 + 0.65*wetScore) * (1 - mountain*0.65) * vegFactor
s7  temperate  = land * mildScore * wetScore * (1 - hotScore*0.45) * (1 - mountain*0.60) * vegFactor
s8  rainforest = land * hotScore * veryWetScore * (1 - mountain*0.50) * vegFactor
s9  grassland  = land * (mildScore*0.70 + hotScore*0.35) * midMoistScore
                      * (1 - slopeScore*0.35) * (1 - mountain*0.55) * vegFactor
s10 shrubland  = land * (hotScore*0.72 + mildScore*0.28) * bandMoist
                      * (1 - mountain*0.45) * max(vegFactor, 0.20)
s15 wetland    = land * wetScore * (1 - slopeScore) * (1 - landHeight*0.75)
                      * wetlandDriver * vegFactor
wetlandDriver  = clamp01(0.20 + river*0.55 + lake*0.45 + delta*0.65 + coastExp*0.18)
```

Именно эти коэффициенты объясняют, почему запечённый RGB обречён: **вес
каждого биома в конкретной точке зависит от `river`, `lake`, `delta`,
`slope`, `mountain`, `volcanism`** — шейдер обязан получать их отдельно.

Векторный предел масштаба: на канонической частоте `v=128` (163 842 ячейки)
средняя ячейка Земли имеет размер порядка сотни километров (ср. §6.6
`PREPARATION_PLAN.md`: при ширине ячейки около `120 км` река — подячеечная
линия). Это значит: **внутри одной канонической ячейки климат почти постоянен**,
поэтому климатическую карту для шейдера можно держать в очень низком
разрешении (`128 × 128` на участок) без потери полей и без затрат гейта **G4**.

---
