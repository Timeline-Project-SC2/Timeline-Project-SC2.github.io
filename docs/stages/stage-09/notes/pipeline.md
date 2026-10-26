# Пайплайн `build_vegetation` и контракт воркера

>
> Источник: [`docs/stages/stage-9-vegetation-atlas.md`](../../stage-9-vegetation-atlas.md) · строки 809–915.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 4. Часть 3.3. Пайплайн постобработки в `tools/build_assets.py` (Pillow)

### 4.1. Раскладка исходников

```text
assets/src/terrain/
  veg-config.json          # пороги сегментации, амплитуды Height, cov-параметры
  t1a_meadow.png           # 1024×1024 (или 2048² для кропа/даунскейла)
  t1b_steppe.png
  t2_scrub.png
  t3_tundra.png
  t4_wetland.png
  t5_boreal.png
  t6_canopy.png
  t7_xeno.png
  ground_barren.png, ground_alpine.png, ground_desert.png, ground_volcanic.png
assets/veg/                # ПРОИЗВОДНОЕ (в .gitignore, в кэш CI)
  t1a-1024_albedo.webp, t1a-1024_masks.webp
  t1a-512_albedo.webp,  t1a-512_masks.webp
  ...
  veg-atlas.json           # манифест: слой, размеры, sha256, параметры архетипа
```

`veg-config.json` на каждый архетип задаёт: `hueCenterDeg`, `hueWidthDeg`,
`satMin`, `valueMin`, `heightAmplitudeM`, `coverageBase`, `coverageBias`,
`roughnessBase`, `seed`. Пороги **не хардкодятся в Python** — иначе
`T7 (Xeno)` с фиолетовой/бирюзовой биомассой потребует правки кода.

### 4.2. Шаги `build_vegetation(force)`

1. **Чтение и нормализация.** `Image.open(src).convert("RGB")`, resize до
   `1024²` (`LANCZOS`) — «master»; LOD-вариант `512²` строится из master
   (не из исходника), чтобы мипы совпадали.
2. **Delight (снятие направленного света).** `flat = A / blur(A, r) · mean(A)`,
   где `blur` — `GaussianBlur(radius = edge/24)` по каждому каналу.
   Деление выполняется в целочисленном режиме `I;16` с предвычисленным LUT
   (`Image.point`), чтобы не получить бандинг в 8 битах. Ограничение
   усиления: `clamp(ratio, 0.55, 1.8)` — иначе тени превращаются в «дыры».
   Результат: равномерное альбедо, пригодное для климатического тинта.
3. **Контроль бесшовности.** `seam = max(RMS(левый−правый), RMS(верх−низ))`
   по модулю `255`; порог `≤ 2,5` → принять; `2,5…5` → лог-предупреждение;
   `> 5` → `sys.exit(1)` в режиме `--check` (арт-приёмка не пропускается
   молча). Автоматический «ремонт» шва (`offset` + зеркальный кросс-фейд)
   **не выполняется**: он ломает статистику текстуры и создаёт видимую полосу.
4. **`FoliageMask` (канал `G`).** Excess Green
   `ExG = (2G − R − B) / 255`, плюс HSV-фильтр по `hueCenter ± hueWidth`
   и `sat > satMin`. Итог:
   `m = smoothstep(t0, t1, ExG)·hueWindow·valueWindow`, затем
   `MinFilter(3)`/`MaxFilter(3)` для схлопывания одиночных пикселей и
   `GaussianBlur(0.6)` для антиалиасинга краёв. Для `T7` окно задаётся
   «двумя дугами» (`hueCenterDeg` + `hueWidthDeg` по модулю 360).
5. **`Height` (канал `R`).** `h = 0,60·m + 0,25·(1 − blur(m, edge/128)) +
   0,15·highpass(luma)`, нормировка в `[0,1]`, затем `sqrt`-компрессия и
   квантование в `8 бит` — купола крон получают объём, грунт остаётся плоским.
6. **`Roughness` (канал `B`).** `r = clamp(roughnessBase + 0.35·(1 − m), 0, 1)`.
7. **`OpticalDepth`/`AO` (канал `A`).** `ao = 1 − 0.5·(m − blur(m, edge/64))`
   (отрицательная часть = самозатенение внутри кроны).
8. **Сборка карты `masks`** `Image.merge("RGBA", (h, m, r, ao))` и сохранение
   `save_webp(..., quality=82, method=6)`; альбедо — `quality=80` (sRGB),
   `masks` — `quality=82`, `exact=True` для `A` (альфа кодируется без потерь).
9. **Манифест `assets/veg/veg-atlas.json`** (аналог `assets/tiles.json`):
   `version` (`sha256[:8]` от всех исходников + конфига), `localAtlasVersion`
   (входит в `patch_key` по §8.8 `PREPARATION_PLAN.md`), список слоёв
   `[{ "id": "t5", "biomeId": 6, "layer": 0, "albedo1024": "...", ... }]`,
   `heightAmplitudeM`, `coverageBase/Bias`, размеры и `sha256` каждого файла.
10. **Кэш.** Для каждого архетипа — сравнение `sourceSha256` и
    `configSha256` с манифестом; совпало — пропуск (тот же принцип, что у
    `build_tiles`). `--check` дополняется проверкой существования всех
    файлов и совпадения `version`; `--sync-only` — только `update_meta()`.

### 4.3. Обязательные правки инфраструктуры (иначе пайплайн сломает CI)

| Файл | Изменение | Причина |
|---|---|---|
| `tools/build_assets.py` | `image_version()`: `SRC.rglob('*')` вместо `SRC.iterdir()` | сейчас поддиректория `assets/src/terrain/` **не попадает** в `imageVersion` |
| `tools/build_assets.py` | новый шаг `("Растительный атлас", build_vegetation)` в `STEPS` | интеграция в существующий конвейер (§10.5 плана) |
| `tools/build_assets.py` | `check_fresh()`: проверка `assets/veg/veg-atlas.json` и всех файлов слоёв | `npm run verify` / `pages.yml` должны падать на неполном кэше |
| `.gitignore` | `assets/veg/`, `assets/veg-atlas.json` | §4.3 корневого `AGENTS.md`: производные пиксели в Git не коммитятся |
| `.github/workflows/pages.yml` | в `path:` обоих шагов кэша добавить `assets/veg` и `assets/veg-atlas.json` | кэш по `key` совпадёт, а файлов не будет → `--sync-only` упадёт |
| `tools/requirements.txt` | без изменений (Pillow достаточно) | деление/LUT реализуются на `I;16` + `point` |
| `tools/verify_feature_parity.mjs` | при необходимости — проверка наличия `assets/veg-atlas.json` в `.publish` | ссылки из рантайма |

Оценка времени CI: 12 источников × (resize + delight + сегментация + 4 кодирования
WebP) ≈ `20…40 с`; укладывается в лимит деплоя `10 мин` (§4.3 плана) с
многократным запасом. Кэш-промах случается только при изменении исходников,
`tools/build_assets.py` или `tools/requirements.txt` — как и сейчас.

### 4.4. Что должен отдавать воркер для растительности (`local-map-wire-v2`)

Минимальное расширение протокола (климат меняется медленно → низкое разрешение):

| Поле | Тип | Размер | Комментарий |
|---|---|---:|---|
| `biomeIdMap` | `Uint8Array`, `RG` (`RG8UI`, `NEAREST`) | `128² × 2` = 32 КБ | `R` = `biomeTop1Id`, `G` = `biomeTop2Id` |
| `biomeWeightMap` | `Uint8Array`, `RG` (`RG8`, `LINEAR`) | `128² × 2` = 32 КБ | `R` = `w1`, `G` = `w2` (перенормированные) |
| `climateMap` | `Uint8Array`, `RGBA` (`RGBA8`, `LINEAR`) | `128² × 4` = 64 КБ | `R` = `effMoisture`, `G` = `temperatureBase`, `B` = `slopeScore`, `A` = `riverInfluence` |
| `meta.biomeTopKeys` | `string[]` | — | для манифеста/HUD |

Итого `+128 КБ` на участок против нынешних `~320 КБ` (`heightfield` `256²`)
— это `+40 %` к передаче, но `0,4 мс` на `128²` точек при опросе 3D-сэмплера
на решётке (по аналогии с `DETAIL_LATTICE_STEPS = 64`, где `65 × 65` опросов
укладываются в текущий бюджет `27 мс`). Климат можно сэмплировать на той же
решётке `65 × 65`, что и `detail`, и апскейлить билинейно — тогда `genMs`
не меняется вовсе.

---
