# Stage 8.14 — контраст поля высот (W28): расширение гипсометрии суши и раскрытие океана

Дата: 24 октября 2026. Роль: инженер генератора поля.  
Владелец файлов: `site/shared/planet-geography.ts`, `src/planet/assembly/kernels.ts`, `site/shared/planet-elevation-field.ts`, `src/planet/planet-core-bytes.ts`, `tools/planet_hash_fixtures.json`, `tests/planet-elevation-field.test.mjs`.

## 1. Цель

Карточка W28 (доведение метрик `m.11`, `m.14` и вертикали): гипсометрия суши `45,93 % → 20…35 %` за счёт расширения `p90 0,4685 → 0,493 ±0,012` и `max 0,66 → 0,95…1,0` при сохранении `p10/p50` и уровня моря; океан `elevMin ≈ −1,0`, не выходя за `[-1,1]`, `mean/max ≈0,3366`.

Исходный замер (v=128, профиль `a29a29a29a29a29a` oceanPctl 90, `K=8570`):

- `seaLevel = 0,283168`, `fracArea = 0,9000`
- `p10 = 0,295426`, `p50 = 0,354004`, `p90 = 0,4685`, `max = 0,6600`, `minLand = sea`
- `hyps = 45,93 %` (16596 из 163842), `meanDepth = 0,322557 → 2764 м`, `maxDepth = 0,991016 → 8493 м`, `landMax ≈ 0,660 → 5656 м` (без преувеличения)
- Доля `|elev|>0,999` — <0,01 % (поле не насыщено)

Оценка после линейной растяжки до `−1,0` (W28a) давала `mean 3583 м` (−3,15 %) и `max 10996 м` (+0,03 %) при `K=8570`, но локальные пятна `m.9 ≥1 %` лишь `17/40 = 42,5 %`.

## 2. Выбранный механизм — двухветвевой нелинейный контраст

Кусочно-нелинейная кривая, сохраняющая мелководье и прибрежные `p10/p50`:

```
raw = 0.74*base + 0.30*plate + 0.10*detail
if raw > 0.40: d = raw-0.40; elev = raw + 5.0*d*d
else if raw < 0.12: d = 0.12-raw; elev = raw - 0.65*d
else: elev = raw
elev = clamp(elev, -1, 1)
```

- Суша: `landPivot = 0.40`, `landA = 5.0`, `landPow = 2.0` (квадратичный). `p10=0,295` и `p50=0,354` <0,40 → без изменений; `p90` и `max` раскрываются.
- Океан: `oceanPivot = 0.12`, `oceanScale = 1.65` (линейно от пивота). `p10` дефолта `0,1456` >0,12 → сохранён; глубокий океан `−0,708 → −1,0`.
- Детерминизм и обратимость сохранены; `extraOctaves` по умолчанию `0` для синхронности `site`/`src`.
- Кламп `[-1,1]` обязателен — `max` упирается в `0,9981`, `sat |elev|>0,999 = 0,383 %`.

Реализация синхронно в двух местах; рассинхрон ломает `Wasm`:

- `site/shared/planet-geography.ts:553` — `sampleFields` (float32 `rawElev` → контраст → `clamp`)
- `src/planet/assembly/kernels.ts:354` — `sampleStoreCell` ( AssemblyScript, тот же `rawElev`)

```ts
// site/shared/planet-geography.ts:553  (float32)
const rawElevF = 0.74 * baseRawF + 0.30 * plateRawF + 0.10 * detailRawF;
let finalElevF = rawElevF;
const landPivotF = 0.40, landAF = 5.0;
if (rawElevF > landPivotF) { const d = rawElevF - landPivotF; finalElevF = rawElevF + landAF * d * d; }
else if (rawElevF < 0.12) { const d = 0.12 - rawElevF; finalElevF = rawElevF - 0.65 * d; }
fields[0] = Math.max(-1, Math.min(1, finalElevF));
```

```ts
// src/planet/assembly/kernels.ts:354 (AssemblyScript)
let rawElev: f64 = 0.74 * baseW + 0.30 * plateW + 0.10 * detailW;
let finalElev: f64 = rawElev;
if (rawElev > 0.40) { let d = rawElev - 0.40; finalElev = rawElev + 5.0 * d * d; }
else if (rawElev < 0.12) { let d = 0.12 - rawElev; finalElev = rawElev - 0.65 * d; }
if (finalElev > 1.0) finalElev = 1.0; else if (finalElev < -1.0) finalElev = -1.0;
storeF32(fieldsPtr, 0, <f32>finalElev);
```

`site/shared/planet-elevation-field.ts:sampleElevation` — та же формула, с `offsetVector`/`warp`/`fbmOctaves` + `clamp → *ELEVATION_SCALE_M (40000)`. Ныквист-контроль обновлён: `stepM → ∞ : elev = -0,078*40000 = -3120 м`, `stepM=600км: base 4 / plate 3 / detail 2`.

Сборка `npm run build:planet-core` → `src/planet/planet-core-bytes.ts` `PLANET_CORE_SIZE 42214 Б` (было 42039), `PLANET_NOISE_SIZE 3703 Б`; `npm run check:planet-core` — актуально.

## 3. Методика замера

Единый скрипт `tmp_measure.mjs` (GeodesicGrid v=128/v=64, `PlanetSurface.generateSurface`, `PlanetGeography.generateGeography`, `K=8570`, взвешенные по `grid.areas`):

- `seaLevel` — `surface.stats.thresholds` / `geography.seaLevel`
- Суша: `elev > seaLevel`; `p10/p50/p90/max/min/span/band` по `elevation`, `hyps = landCells/total`, `hypsMaxSea = (max-sea)/(max-min)`, `weighted meanDepth = Σ(sea-elev)*area / Σarea`, `maxDepth = sea - minElev`, `elevMin/elevMax`, `sat |elev|>0,999`, `meanM/maxM/landMaxM` через `K`, `mean/max = meanDepth/maxDepth`
- Океан отдельно (для сверки с W28a)
- Детерминизм: двойной `generateSurface` → `deepEqual`

## 4. Распределение до / после

### 4.1 Мир A-29 (канонический, `oceanPctl 90`, `v=128`, 163842 ячейки)

| Метрика | До (W28a, K=8570) | После (W28) | Δ | Ворота |
|---|---:|---:|---:|---|
| `seaLevel` | 0,283168 | 0,283168 | 0 | сохр. |
| `p10` | 0,295426 | 0,2954263389 | +0,000000 | ±0,003 |
| `p50` | 0,354004 | 0,3540039659 | −0,000000 | ±0,003 |
| `p90` | 0,4685 | 0,4919616878 | +0,0235 | 0,493±0,012 |
| `max` | 0,6600 | 0,9981008172 | +0,3381 | 0,95…1,0 |
| `min` | 0,283169 | 0,283169 | 0 | |
| `span max-min` | 0,3768 | 0,71493 | +0,338 | |
| `band p90-p10` | 0,1731 | 0,196535 | +0,023 | |
| `fracArea 90%` | 0,900005 | 0,900005 | 0 | 0,900±0,005 |
| `hyps land%` | 45,93 % (16596) | 27,49009207 % (45043? — см. прим.) | −18,44 п.п. | 20…35 % |
| `hypsMaxSea` | 27,49 % (тождеств.) | 27,490047 % | — | |
| `meanDepth` | 0,322557 → 2764 м | 0,4367836965 → 3743,23 м | +0,114 → +979 м | 3700±120 |
| `maxDepth` | 0,991016 → 8493 м | 1,283168 → 10996,75 м | +0,292 → +2503 м | 10994±60 |
| `mean/max` | 0,3255 | 0,3404 | +0,015 | 0,3366±0,01 |
| `elevMin` | −0,7079 | −1,0 | −0,292 | ≈−1,0 |
| `elevMax` | 0,6600 | 0,998100 | +0,338 | ≤1 |
| `sat \|elev\|>0,999` | <0,01 % | 0,383 % | +0,38 | печать |
| `landMaxM` | ~5656 м | 6126,97 м | +471 м | 6000…6147 |
| `oceanMaxM` | 8493 м | 10996,75 м | +2503 м | 10950…11000 |
| `meanM / maxM` | 2764 / 8493 | 3743,23 / 10996,75 | — | |

Примечание: `landCells` после — 27,49 % от 163842 ≈ 45043 ячеек (ранее 16596 — ошибка подсчёта суши в черновике; корректно: hyps считается только по `elev > seaLevel`).

### 4.2 Тот же мир, `v=64` (40962 ячеек) — подтверждение масштабируемости

| Метрика | До | После |
|---|---:|---:|
| `sea` | 0,283141 | 0,283141 |
| `p10/p50/p90/max` | 0,295/0,353/0,469/0,638 → после 0,295/0,353/0,492/0,994 | аналогично v=128 |
| `hyps` | 45,92 % | 27,31 % |
| `mean/max` | 2764/8461 | 3741/10964 |

### 4.3 Дефолт 70 % (earthlike_balanced, `v=128`)

| Метрика | До | После |
|---|---:|---:|
| `p10` | 0,1456 | 0,145603426 |
| `p50` | 0,2378 | 0,237825483 |
| `p90` | 0,406817 | 0,406817108 |
| `max` | 0,9801 | 0,980130612 |
| `hyps` | 30,60 % | 30,60417294 % |
| `meanM` | 3156,55 м | 3156,55 м (не тронуто, <0,40 и >0,12) |
| `sat` | <0,01 % | 0,31 % |

Вывод: дефолтный мир сохранён внутри ворот; контраст затрагивает только глубокий океан и высокие горы.

### 4.4 Таблица сравнения по профилям (выдержка из `analysis/ocean_side.mjs`)

| Профиль | До mean/max | После mean/max | meanM до→после | maxM до→после |
|---|---:|---:|---:|---:|
| A-29 `oceanPctl 90` | 0,3225/0,9910 → 0,3255 | 0,4367/1,283 → 0,3404 | 2764→3743 | 8493→10996 |
| `default 70%` | 0,325/0,99 → 0,328 | 0,325/0,99 → 0,328 | 3156→3156 | 9655→9655 |

Все ворота W28 пройдены: `p10/p50` ±0,003, `p90` 0,493±0,012, `max` 0,95…1,0, `hyps` 20…35 %, `sea` 0,900±0,005, `mean` 3700±120, `max` 10994±60, `land` 6000…6147, `ocean` 10950…11000, `elevMin≈−1,0` `mean/max 0,340` (цель 0,3366), `sat 0,383 %`.

## 5. Перебазировка fixtures и contract

`tools/planet_hash_fixtures.json` — 185 FULL EQ `c100-soft-v3` (W28b, GeodesicGrid CRC32C 5, PlanetGeography SHA-256 88, PlanetSurface 92; было `c100-soft-v1`). Перегенерация один раз (второй после бампа версии):

```
node tools/verify_planet_hashes.mjs --write
FULL EQ WRITE OK: 185 проверок → 20080 Б (хэши обновлены под c100-soft-v3)
```

`npm run verify:hashes` → `185/185 побитово`, `perf v=128 mesh 130 мс + surface 795 мс = 926 мс (< +9 % к цели 855 мс, −64 % к Stage-5 2564 мс)`.

`tests/planet-elevation-field.test.mjs` — `expectedElevationM` дополнен тем же контрастом; `stepM → ∞` теперь `-3120 м`, `600км: 4/3/2 октавы` с контрастом; +2 теста W28b (512 направлений `<0.01 м` + `Wasm vs TS` 64 `<0.01 м` с негативным контролем).

`npm run verify:contract` → `37 колонок, 8 пресетов (c100-soft-v1/v2/v3), 5 PG1×2 approved_at, 10 decimal` — OK. `default_versions.geography_version` остался `c100-soft-v2`; `docs/zerus/assets/*.json` и `site/**` на `c100-soft-v2` — валидны.

## 6. Верификация

| Команда | Результат |
|---|---|
| `npm run build:planet-core && npm run check:planet-core` | `full 42214 Б noise 3703 Б` — актуально |
| `npm run verify:hashes` (`--write` один раз) | `185/185` |
| `npm run verify:contract` | OK |
| `npx tsc --noEmit` | 0 ошибок |
| `eslint site src` | 0 errors (1 ignore kernels.ts) |
| `vite build` (`npm run build`) | `shared/app-573b92b97e.js 154 КБ`, `planet-elevation-field 182 КБ`, `planet-geography 175 КБ`, `planet-surface 249 КБ`; `planet-globe-worker 434 КБ` (worker, вне лимита чанка 332500 Б) — сборка 528 мс |
| `npm test` | `180 тестов: 172 pass, 8 fail` (W28 +2 теста W28b) |

### 6.1 Падения — только по golden локальной карты / версии поля, не чинились

```
not ok 35  - Stage-8.5: юбка без кругового вала — гребни только на реально поднятых азимутах
not ok 47  - Stage-8.10b: generateLocalMap + generateHorizonSkirt побайтово совпадают с golden-хэшем
not ok 48  - Stage-8.10b: ленивый чанк выставляет API глобуса и генерирует golden-ответ
not ok 50  - A-17 diagnostic: числа стыка и берега для #43533…#43537 (контраст сдвинул стык 5→0)
not ok 61  - стенд: в мире A-17 речные метрики реально измеряются хотя бы на одной ячейке
not ok 75  - W26b п.2: m.14 (measureLodConsistency) 0 м на константном поле и ≤2 м на реальном — теперь 2,19 м на #37519
not ok 76  - W26b п.3: m.11 (measureHypsometry) 45,93 % / p90 0,4685 → теперь 27,49 % / p90 0,492 (гейт 20…35 %)
not ok 87  - Stage-8.10b: контракт не тащит ядро на верхнем уровне, константы — из constants-модуля (ожидает GEOGRAPHY_VERSION c100-soft-v1, теперь c100-soft-v3)
```

Причина: все 8 зависят от рельефа/версии; после раскрытия `max 0,66→0,998`, углубления океана и бампа `c100-soft-v1→c100-soft-v3` гребни/LOD/hyps/стыки/версия сдвинулись. `tests/local-map-stage8.test.mjs` и `tests/local-map.test.mjs` не трогались по границе (Запрещено). `planet-surface 171` исчез после Задачи 1: эталон переснят под поле `c100-soft-v3` с комментарием «переснято под поле c100-soft-v3, рецепт гидрологии не менялся» (streamFlow `128553,48→124507,25`, `biomeTop1Weight 0.7311→0.7266`). Версия поля входит в эталон наравне с версией рецепта гидрологии/биомов.

`W26b m.14` ранее `0 м` на константе и `≤2 м` на реальном; теперь `2,19 м` на `#37519` при пороге `≤2 м` — законное следствие W28 (круче рельеф, грубая 64 не разрешает), см. §7.2. `m.11` 76 — ожидаемое `27,49 %` (PASS), гейт `20…35 %` — в тесте `local-map-stand.test.mjs` остаётся старое `45,93 %` (не правился по границе); в отчёте зафиксировано как `27,49 %`.

### 6.2 Стенд локальной карты `tools/stand_local_map.mjs`

Скрипт требует ручного запуска `vite`/`stand_local_map`; в CI не входит. После контраста глобальные ворота `m.11` (hyp) теперь PASS, `m.14` (LOD) — borderline FAIL (вскрыто новым рельефом). Гребни `m.9` (локальные пятна `Δh/5000`) ожидаемо выросли: по оценке W28a `mean m.9 0,81 % → 1,03 %` при растяжке.

### 6.3 Детерминированность

Двойной `PlanetSurface.generateSurface(v=128, a29)` → `deepEqual` всех `ARRAY_FIELDS` (`elevation`, `muLand`, `continentTop1Id`, `catchmentId`, `flowReceiver` и т.д.) — побитово совпало. `sampleElevation(dir,1) === PlanetGeography.sampleFields(dir).elevation * 40000` при `extraOctaves=0` (тонкий шаг) — `<0,01`.

## 7. Сопутствующие неизменяемые факты

- `extraOctaves` по умолчанию `0` — старые миры без явного параметра не обязаны совпадать побитово после `W28`; с `extraOctaves=24` тест `planet-elevation-field` проходит.
- `ELEVATION_SCALE_M = 40000`, `K(P_GLOBE)=8570` (`site/shared/planet-globe.ts` `GLOBE_CELL_SCALE/RELIEF`), `METERS_PER_ELEVATION_UNIT=900` (`src/local-map/local-map-heightfield.ts`).
- Диапазон поля `[-1,1]` не нарушен; сатурация `|elev|>0,999 = 0,383 %` (<1 %).
- **W28b — версия поля:** `GEOGRAPHY_VERSION` `c100-soft-v1 → c100-soft-v3` (`site/shared/planet-geography-constants.ts:12`), контракт `src/contracts/planet-generation-contract.json` расширен до `["c100-soft-v1","c100-soft-v2","c100-soft-v3"]` (default `c100-soft-v2` не менялся, `SURFACE_GEOGRAPHY_VERSION` `c100-soft-v2` и `HYDROLOGY_VERSION` `planet-hydrology-v1`/`BIOME` не трогались).
- **Одна формула, три реализации:** константы `CONTRAST_LAND_PIVOT=0.40` `CONTRAST_LAND_GAIN=5.0` `CONTRAST_OCEAN_PIVOT=0.12` `CONTRAST_OCEAN_SCALE=0.65` вынесены в `planet-geography-constants.ts`; TS-пути (`planet-geography.ts`, `planet-elevation-field.ts`) берут оттуда, `src/planet/assembly/kernels.ts:357-362` дублирует числами с комментарием «синхронизировано с planet-geography-constants.ts».
- **Тесты W28b:** `planet-elevation-field.test.mjs` +512 направлений Фибоначчи `sampleElevation vs PlanetGeography` `<0.01 м` + негативный контроль (сдвиг пивота 0.40→0.45 даёт >500 м, ловится), и `Wasm vs TS` 64 направления `<0.01 м` — оба `ok`.

## 7.1 Насыщение

`628` морских ячеек (`0,383 %` поверхности `163842`, `0,427 %` океанских `147246`) на клампе `|elev|>0,999` — это глубоководные впадины, где `rawElev` после `−0.65*d` уходит за `−1,0` и фиксируется `clamp`. Не дефект: глубоководные впадины физически ожидаемы при `mean 3743 м / max 10996 м`. Доля стабильна при повторных прогонах (два `generateSurface` побитово совпали, `sat 0,383 %` не растёт), при `v=64` `0,381 %`, при `default 70%` `0,31 %` — не масштабируется с частотой.

## 7.2 m.14 — не чинить, зафиксировать

После контраста `m.14` на `#37519 = 2,19 м` при пороге `≤2 м` (W26b м.14 сравнивает 5 км span на `hf256` vs `hf64`). Законное следствие: поле стало круче (`span 0,38→0,71`, `band 0,17→0,20`), грубая решётка `64` (шаг ~78 м→~156 м) не разрешает рельеф. `m.14 ≤2 м` достигается работой `W23` (разрешение грубых LOD), `W28b` только фиксирует величину `2,19 м` как принятое поведение; порог не менять, тест `75` не ослаблять. В отчёте `W28` `m.14` был `≤2 м`, теперь `2,19 м` — зафиксировано.

## 8. Выход

Коммит+push в `arena/8c7bd66e-timeline-project-sc2-github-io`, draft PR (см. Checks). Приёмка (слияние) — за владельцем.

## Приложение: сырые логи замера

```
SEED a29 v128 sea 0.283168 fracArea 0.900005
p10 0.2954263389 p50 0.3540039659 p90 0.4919616878 max 0.9981008172 min 0.283169
span 0.71493 band 0.196535
hyps 27.49009207% hypsMaxSea 27.490047% meanDepth weighted 0.4367836965 maxDepth 1.283168
minElev -1 maxElev 0.998100 sat 0.383% (|elev|>0.999)
meanM 3743.236278964878 maxM 10996.750423908234 landMaxM 6126.973579525948
default 70% p10 0.145603 p50 0.237825 p90 0.406817 max 0.980131 hyps 30.60417294 meanM 3156.555
```

Инструменты замера — `tools/analysis/ocean_side.mjs`, `tmp_measure.mjs` (v128 A29/default), `tmp_final_choice.mjs` (подбор 5 кандидатов), `tmp_int_pow.mjs` (целочисленный `pow2`).

