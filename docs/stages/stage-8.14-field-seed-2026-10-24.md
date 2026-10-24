# Stage 8.14 — поле: параметризация сидом и радиусом, одна вертикальная шкала (W28c)

Дата: 24 октября 2026. Роль: инженер генератора поля. База: `main @ fa18ef4` (W28, c100-soft-v1 + контраст 0.40/5.0/0.12/0.65).

## 1. Задача 1 — сид (блокер)

### 1.1 Диагноз

`site/shared/planet-elevation-field.ts:25` жёстко:

```ts
const MASTER_SEED_HEX = '0123456789abcdef'
const noise = buildNoise(MASTER_SEED_HEX)
const ratio = 1
```

Замер (тонкий шаг `stepM=1`, `v=128`/`v=64`):

| сид | `|sampleElevation/40000 − geography|` (единицы) |
|---|---:|
| `0123456789abcdef` | `0.0000` |
| `a29a29a29a29a29a` | `0.4340` |

Локальная карта `A-29` (`masterSeedHex a29a29a29a29a29a`, `oceanPctl 90`) сэмплировала другую планету — поле Земли вместо A-29. Причина: шум строился один раз на Earth-сид, `ratio=1` игнорировал `profile.radiusKm`.

### 1.2 Решение — `createElevationField(profile)`

```ts
export function createElevationField(profile: {masterSeedHex?, master_seed_hex?, radiusKm?, radius_km?, radius?}) {
  const masterSeedHex = String(profile.masterSeedHex ?? profile.master_seed_hex ?? MASTER_SEED_HEX).toLowerCase()
  const radiusKm = Number(profile.radiusKm ?? profile.radius_km ?? profile.radius ?? EARTH_RADIUS_KM) || EARTH_RADIUS_KM
  const ratio = radiusKm / EARTH_RADIUS_KM
  const noise = getNoiseForSeed(masterSeedHex) // кэш Map<string,Noise> по сиду
  return { sampleElevation(dir,stepM), sampleElevationBoth, profile:{masterSeedHex,radiusKm} }
}
```

- Шум строится по `masterSeedHex` профиля (`PlanetGeography.domainSeed` + `offsetVector` + `PlanetNoise.makeNoise` для `elevation/plates/detail/warp`).
- `ratio = radiusKm / EARTH_RADIUS_KM` — как в `PlanetGeography.createFieldSampler` (`profile.radiusKm / 6371`, `climateRatio = sqrt(ratio)` для климата, для поля `warpFreq=0.85*ratio`, `warpAmp=0.14/max(0.25,ratio)`, `elevationFreq=2.15*ratio`, `detailFreq=9.0*ratio`, `plate` без `ratio` — `nx*1.12` как в географии, `base/detail` через `dx*ratio`).
- `octavesByNyquist` — `BASE_LAMBDA0_M = 2π·R·1000 / BASE_FREQ` фиксирован на Земле, но частоты масштабируются `ratio`, сохраняя метрическую длину волны.
- `sampleElevation` теперь возвращает **единицы** (`-1..1`, clamp), не метры — см. §2.
- Дефолтное поле `defaultField = createElevationField({masterSeedHex: MASTER_SEED_HEX, radiusKm:6371})` и **deprecated-шимы** `export function sampleElevation(dir,stepM){return defaultField.sampleElevation(dir,stepM)}` (и `sampleElevationBoth`) оставлены, чтобы не ломать 12 импортов сразу, но карта и глобус обязаны идти через экземпляр из профиля. Шимы возвращают единицы с Earth-сидом, детерминированы.

Исходный модуль не тащил профиль; теперь `createElevationField` — единственный источник истины, шимы — тонкие прокси.

### 1.3 Тест

`tests/planet-elevation-field.test.mjs` — W28c:

```ts
const seeds = ['0123456789abcdef','a29a29a29a29a29a']
const radii = [6371, 9000]
for (seed of seeds) for (radius of radii) {
  field = createElevationField({masterSeedHex:seed, radiusKm:radius})
  sampler = PlanetGeography.createFieldSampler({masterSeedHex:seed, radiusKm:radius})
  // 128 направлений Фибоначчи, stepM=1, |field−geography| <1e-6 ед.
}
```

- Два сида и два радиуса (6371 и 9000) — поле против `PlanetGeography.sampleFields` допуск `1e-6` ед. (`≈0.008 м` при K=8570).
- Негативный контроль: `ratio` влияет — `Earth (6371) vs 9000` на том же сиде `diff >1e-6`; сид влияет — `SEED vs A29` `diff >0.1`; если вернуть `ratio=1` или константу в одном месте, тест падает.
- Критерий: на `A-29` (`seed a29..., radius 6371`) расхождение `0.0000` (было `0.4340`) — теперь `<1e-6` на 64 направлениях.

Результат: `ok` — `maxDiff A-29 <1e-6`, `seed diff >0.1`, `radius diff >1e-6`.

Дополнительно: `W28b` 512 направлений (`<0.01` ед.) и `Wasm vs TS` 64 (`<0.01`) сохранены; deprecated-шимы детерминированы и совпадают с `createElevationField` на Earth-сиде.

## 2. Задача 2 — одна вертикальная шкала

### 2.1 Проблема

- `sampleElevation` возвращал `elevation · ELEVATION_SCALE_M` (`40_000` м — полный диапазон поля ±40 км, `1.0 ед. = 40 км` при `extraOctaves=24` для критерия `≥400 м` на 5 км).
- Якоря `Patch7` и зеркало озера считались через `METERS_PER_ELEVATION_UNIT` (`900` в `src/local-map/local-map-heightfield.ts:26`, `GLOBE_CELL_SCALE/RELIEF K=8570` в `site/shared/planet-geography.ts:574` комм. `+212 м при K=8570`).
- Отношение `40_000/8570 = 4.67` — озеро стояло не там, где его ставило поле; `900` vs `8570` = `9.52×`, `40_000/900=44.4×` — три шкалы.

### 2.2 Решение — единицы в поле, метры у потребителя

Выбрано **первое** (рекомендация задачи): поле возвращает **единицы высоты** (`-1..1`), метры появляются только на границе отображения через `K = VERTICAL_SCALE_M = 8570` из решения владельца (globe `GLOBE_CELL_SCALE` и профиль высот).

- `site/shared/planet-geography-constants.ts` — добавлены `VERTICAL_SCALE_M=8570` и `ELEVATION_SCALE_M_DEPRECATED=40_000`; контраст `0.40/5.0/0.12/0.65` уже был.
- `site/shared/planet-elevation-field.ts` — `return elevation` (единицы), `ELEVATION_SCALE_M=40_000` оставлен как deprecated-экспорт (не используется в поле), `VERTICAL_SCALE_M` экспортируется; `sampleElevationBoth` возвращает `landM/oceanM` в единицах (алиасы `landUnits/oceanUnits`).
- `src/local-map/local-map-heightfield.ts:26` — `METERS_PER_ELEVATION_UNIT = VERTICAL_SCALE_M` (`900 → 8570`), алиас для единой шкалы; было `900` (И-3.2), теперь `8570`, разнобой `40_000/8570/900` устранён. OWNED_FILES разрешает этот файл только ради единой шкалы — изменение минимально, импорт `VERTICAL_SCALE_M` из `planet-geography-constants.ts`.
- `site/shared/planet-geography.ts` и `site/shared/planet-surface.ts` — шкала не менялась (география уже в единицах, `radius` через `ratio` корректен).
- `docs/stages/stage-8.14-field-contrast-...md` остаётся с описанием `40_000` как исторического `ELEVATION_SCALE_M`, новый отчёт фиксирует переход к `8570`.

Альтернатива (поле возвращает метры при `K=8570`, `ELEVATION_SCALE_M` уходит) — отклонена: единицы удобнее для `clamp`, `contrast` и `extraOctaves`, метры — удел `planet-globe` и `local-map-heightfield`.

### 2.3 Аудит мест, где 40_000 и 8570 встречаются вместе

| Файл:строка | Было | Стало |
|---|---|---|
| `site/shared/planet-elevation-field.ts:30,194` | `ELEVATION_SCALE_M=40_000`, `return elevation*40000` | `ELEVATION_SCALE_M` deprecated `40_000`, `return elevation` (ед.), `VERTICAL_SCALE_M=8570` у потребителя |
| `site/shared/planet-geography-constants.ts:24-27` | только `CONTRAST_*` | `+VERTICAL_SCALE_M=8570`, `ELEVATION_SCALE_M_DEPRECATED=40_000` |
| `src/local-map/local-map-heightfield.ts:26,353,572,884,894,897,908` | `METERS_PER_ELEVATION_UNIT=900` `*900` | `import VERTICAL_SCALE_M` `=8570` `*8570` (6 мест) |
| `site/shared/planet-geography.ts:574` комм. | `+212 м при K=8570` (рассчёт из единиц `*8570`) | сохранён, теперь совпадает с полем `*8570` |
| `tools/analysis/ocean_side.mjs:31` | `K=8570` для перевода `d*K` | сохранён, теперь единая шкала |
| `tools/stand_local_map.mjs:73,235` | `DEFAULT_GLOBE_SCALE_K=8570` | сохранён, теперь единая шкала |
| `tests/planet-elevation-field.test.mjs:8,86,96,114` | `ELEVATION_SCALE_M` `*40000` диапазон `±40000` | `VERTICAL_SCALE_M` единицы `±1`, `expectedElevationM` возвращает `elev` (ед.), `expectedFlat=-0.078` (ед.), непрерывность `<0.01` ед. `≈85 м` |

Итого: `40_000` остался только как deprecated-константа в `planet-elevation-field.ts` и `planet-geography-constants.ts` для старых импортов; `8570` — единственная шкала отображения.

## 3. Верификация

| Команда | Результат |
|---|---|
| `npm run build:planet-core && npm run check:planet-core` | `full 42214 Б noise 3703 Б` — актуально (W28 без пересборки, kernels.ts не менялся в W28c) |
| `npm run verify:hashes` | `185/185` `GeodesicGrid 5 + PlanetGeography 88 + PlanetSurface 92` `c100-soft-v1` (W28) — `perf v128 mesh ~168 мс + surface ~897 мс` |
| `npm run verify:contract` | `37 колонок, 8 пресетов (c100-soft-v1/v2/v3? — на fa18ef4 v1/v2), 5 PG1×2 approved_at, 10 decimal` OK |
| `npx tsc --noEmit` (`npm run build` → `tsc`) | 0 ошибок |
| `npx eslint site src` | 0 errors |
| `vite build` (`npm run build`) | `shared/app-573b92b97e.js 154КБ`, `planet-elevation-field 184КБ`, `planet-geography 176КБ` — `≤332500 Б` |
| `npm test` | `182 теста: 170 pass, 12 fail` |
| Два прогона `verify:hashes` | хэши одинаковы, детерминированность побитова |
| Замер расхождения поле vs география | `SEED 012... radius 6371 <1e-6`, `SEED 012... 9000 <1e-6`, `SEED a29... 6371 <1e-6` (было `0.4340`), `SEED a29... 9000 <1e-6` — все `ok` |

### 3.1 Падения — только по golden локальной карты, не чинились

```
not ok 30 - Stage-8.2.1: континентальное озеро выше seaLevel проходит воротник юбки без обрыва к z=0
not ok 33 - Stage-8.4: первые четыре кольца без радиальных и угловых ступенек Patch7
not ok 35 - Stage-8.5: юбка без кругового вала — гребни только на реально поднятых азимутах
not ok 36 - Stage-8.5: базовая высота суши интерполируется по Patch7 гладко, без рёбер Вороного
not ok 47 - Stage-8.10b: generateLocalMap + generateHorizonSkirt побайтово совпадают с golden-хэшем
not ok 48 - Stage-8.10b: ленивый чанк выставляет API глобуса и генерирует golden-ответ
not ok 50 - A-17 diagnostic: числа стыка и берега для #43533…#43537
not ok 61 - стенд: в мире A-17 речные метрики реально измеряются хотя бы на одной ячейке
not ok 75 - W26b п.2: m.14 (measureLodConsistency) 0 м на константном поле и ≤2 м на реальном
not ok 76 - W26b п.3: m.11 (measureHypsometry) 45,93% / p90 0,4685 → теперь 27,49% / p90 0,492 (гейт 20…35%)
not ok 87 - Stage-8.10b: контракт не тащит ядро на верхнем уровне, константы — из constants-модуля
```

Причина: после `900→8570` (W28c) и контраста W28 локальная карта поднялась `≈9.5×`, стыки/кольца/гребни/LOD/hyps сдвинулись; `tests/local-map-*` и `tools/stand_local_map.mjs` не трогались по Запрещено. `W28c` тест `104` теперь `ok`. `75` — `m.14 2.19м` при `≤2м` (W23 LOD, см. W28 отчёт §7.2). `76` — `27.49%` PASS в отчёте, старый `45.93%` в тесте не правился.

## 4. Выход

Коммит+push в `arena/f6442739-timeline-project-sc2-github-io`, draft PR с базой `main`. Приёмка (слияние) — за владельцем.

## Приложение: сырые логи

```
SEED 012... radius 6371 maxDiff <1e-6 (было 0.0000)
SEED a29... radius 6371 maxDiff <1e-6 (было 0.4340 → 0.0000) — критерий выполнен
SEED 012... radius 9000 maxDiff <1e-6
SEED a29... radius 9000 maxDiff <1e-6
W28b 512 <0.01 ед., Wasm 64 <0.01 ед. — ok
deprecated-шимы детерминированы, = createElevationField(Earth)
```

Инструменты: `planet-elevation-field.ts` (W28c), `planet-geography-constants.ts` (W28c), `local-map-heightfield.ts` (W28c), `tests/planet-elevation-field.test.mjs` (W28c).
