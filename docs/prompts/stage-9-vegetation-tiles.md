# Пакет промптов: бесшовные тайлы растительности (Этап 9)

Дата: 23 октября 2026 года.
Назначение: готовый к использованию набор технических инвариантов и промптов
для генерации исходников в `assets/src/terrain/`, из которых
`tools/build_assets.py` собирает каналы `Albedo`, `FoliageMask`, `Height`,
`Roughness` и `OpticalDepth` для `TERRAIN_FRAGMENT_SHADER` и
`StructureRenderer` (`src/local-map/local-map-renderer.ts`).

Архитектурное обоснование, матрица биомов и бюджеты — в
[`../stages/stage-9-vegetation-atlas.md`](../stages/stage-9-vegetation-atlas.md).
Все промпты записаны по-английски (это язык большинства генераторов),
пояснения и приёмка — по-русски.

---

## 1. Строгие технические инварианты генерации

Промпт любого архетипа обязан содержать **все восемь** инвариантов. Они не
«пожелания по стилю», а требования конвейера: нарушение любого из них
ломает либо бесшовность, либо извлечение масок в `build_assets.py`.

### 1.1. Инвариант вида: `nadir orthographic top-down`

```text
strictly nadir orthographic top-down view, camera looking straight down (90 degrees
to the ground plane), parallel projection, no perspective convergence, no horizon,
no visible sky, no slanted camera, no first-person angle
```

*Почему:* кадр наклонённой камеры даёт неравномерную плотность текселей и
«съезжающие» силуэты крон; `heightBlend` и UV-лестница предполагают план по
нормали.

### 1.2. Инвариант освещения: `delit / albedo`

```text
flat diffuse overcast lighting, albedo-like colours, no directional sun, no cast
shadows, no long shadows, no specular highlights, no glare, no lens flare,
no vignette, no large-scale brightness gradient across the frame
```

*Почему:* направленный свет запекается в тайл и при климатическом тинте и
повторах превращается в полосы; кроме того, `Height` извлекается из
яркости — направленный свет искажает её.

*Допустимо:* локальное контактное самозатенение внутри кроны/кочки
(`soft ambient occlusion inside clusters, short contact shadows under leaves`),
но **не более** `15 %` перепада яркости между центром и краем кадра.

### 1.3. Инвариант бесшовности: `4-way seamless`

```text
seamless tileable texture, wrapping in both axes, continuous edges, no border,
no frame, no vignette at edges
```

*Обязательно*: флаг генератора `--tile` (Stable Diffusion / ComfyUI),
а для моделей без тайлинга — генерация `1024²` с последующей проверкой шва
(§3.1). **Не** использовать постфактум «зеркальный» ремонт шва.

### 1.4. Инвариант разрешения: читаемость на `512 × 512`

```text
readable at 512x512, cluster features spanning at least 1/24 and at most 1/6 of
the image width, no single-pixel detail, no hairline structures thinner than 3 px
at 1024 resolution
```

*Почему:* мип-пирамида обязательна (UV-лестница работает на `mip 1,7…5,8`),
и структура тоньше `3 px` в `1024²` исчезает уже на `mip 2`.

### 1.5. Инвариант разделения силуэтов: `substrate separation`

```text
high contrast between foliage and substrate, clearly defined leaf and grass
silhouettes against the underlying ground, visible ground gaps between clusters,
no blur, no depth of field, no bokeh, no motion blur
```

*Почему:* `FoliageMask` извлекается цветовым Excess-Green + HSV-фильтром;
размытые края дают «полутон» маски, который на `heightBlend` превращается в
мыльную кайму.

### 1.6. Инвариант нейтральной нормализации альбедо

```text
neutral colour balance, mid-grey average brightness, no colour cast, no colour
grading, no saturation boost, no HDR look
```

*Почему:* климатический колорит накладывается в шейдере (§2.3.2 отчёта);
тайл должен быть «серым по цвету» и «плотным по структуре».
Исключение — `T7 (Xeno)`.

### 1.7. Инвариант отсутствия артефактов-объектов

```text
no text, no watermark, no logo, no signature, no UI, no animals, no insects,
no birds, no footprints, no gravel paths, no sticks or logs as repeating
signature objects, no uniform grid pattern
```

*Почему:* узнаваемый объект при повторе `8…50 раз` мгновенно выдаёт тайлинг.

### 1.8. Инвариант масштабной интерпретации

```text
scale is abstract and homogeneous: the same texture reads correctly both as a
close-up ground cover and as a distant patch of the same biome
```

*Почему:* один и тот же тайл используется на четырёх уровнях периода
(`25 км / 6,25 км / 1,25 км / 312 м`).

### 1.9. Общий негативный промпт

```text
perspective, aerial perspective, horizon, sky, sun, sunbeams, hard shadows,
long shadows, specular highlight, wet reflection, lens flare, bokeh, depth of
field, blur, motion blur, vignette, border, frame, watermark, text, signature,
grid, checkerboard, tiling artifact, visible repeat, colour cast, HDR, oversaturated,
illustration, cartoon, painting, 3d render, low poly, low resolution, jpeg artifacts,
animals, people, vehicles, buildings, snow patches (для тёплых архетипов),
autumn leaves (для вечнозелёных архетипов)
```

---

## 2. Готовые промпты по морфологическим архетипам

Формат каждого пункта: **EN-промпт** (копируется как есть, вместе с общими
инвариантами §1.1–1.8 в начале) → **RU-пояснение** → **параметры** →
**негативный акцент**.

Общий префикс, который подставляется перед каждым промптом ниже:

```text
[PREFIX] strictly nadir orthographic top-down view of the ground plane, 90 degrees
to the surface, parallel projection, flat diffuse overcast lighting, albedo-like
colours, no directional sun, no cast shadows, seamless tileable texture wrapping
in both axes, readable at 512x512, high contrast between foliage and substrate,
no blur, no depth of field, neutral colour balance, mid-grey average brightness,
no text, no watermark, no logo
```

---

### T1a. `Grassland / Dense Meadow Turf` — густой луговой дерн

**Биом:** 9 `grassland` (влажная половина `midMoistScore > 0,55`).
**Амплитуда `Height`:** `0,45 м`. **Период:** `312 м` (крупный план) /
`1,25 км` (средний).
**Целевая сомкнутость (`FoliageMask`):** `0,90…0,97`.

**EN-промпт:**

```text
[PREFIX], dense lush meadow turf seen directly from above, fine-bladed grasses and
low broadleaf herbs interlocked into a continuous carpet, occasional tiny white and
yellow flower heads scattered sparsely (less than 2 percent of area), short clover
and plantain leaves flat against the ground, subtle layering of blades crossing at
different angles, very small gaps between blades exposing dark humus, uniform
species mix across the whole frame, homogeneous density, no large bare patches,
no clumps larger than one twentieth of the image, natural green with neutral
desaturation
```

**RU-пояснение.** Это «ковёр»: полное перекрытие, ни одного крупного пустого
пятна, максимум `3 %` площади — цветы (они дают приятную стохастику при
повторе, но не должны быть маркерами). Плотность однородна, потому что
`dryScore` этого архетипа низкий: сухость отдаётся `T1b`. Тёмный гумус в
щелях даёт `FoliageMask` естественные «поры» `3…10 %`, что на крупном плане
читается как дерн, а не как зелёная плёнка.

**Параметры:** `1024 × 1024`, `--tile`, 4 seed, `cfg 5,5…7`, шаг `30…35`,
модель — фотореалистичная наземная (не «арт»).

**Негатив-акцент:** `dry straw, yellow grass, large soil patches, wildflowers
dominating, lawn stripes`.

---

### T1b. `Grassland / Dry Steppe Turf with Soil Veins` — сухая злаковая степь

**Биом:** 9 `grassland` (сухая половина, `midMoistScore < 0,45`).
**Амплитуда `Height`:** `0,35 м`. **Период:** `312 м` / `1,25 км`.
**Целевая сомкнутость:** `0,55…0,75` (открытые прожилки грунта `25…45 %`).

**EN-промпт:**

```text
[PREFIX], dry steppe turf seen directly from above, clumps of thin pale straw-coloured
bunch grasses lying semi-flat, feather grass awns, interspersed with irregular narrow
veins of exposed dry loam and fine gravel, soil veins never wider than one fifteenth
of the image and never forming closed loops, patchy tussocks two to five percent of
the image each, muted olive-straw palette, no live green dominance, matted dead
litter between tussocks, homogeneous distribution of tussocks across the frame
```

**RU-пояснение.** Прожилки грунта — не «пятна», а **связная сеть** шириной
`≤ 1/15` кадра: именно она даёт `FoliageMask` среднее `0,55…0,75` и создаёт
читаемую степь на крупном плане. Важно: прожилки не должны образовывать
замкнутых колец — при тайлинге они превращаются в «глаза».

**Параметры:** те же; дополнительно следить за `hue` — тон должен быть
`#85943D ± 12°`, а не серо-коричневый.

**Негатив-акцент:** `green lawn, dense carpet, dark wet soil, flowers`.

---

### T2. `Shrubland / Arid Scrub Clumps` — кустарниковые куртины и саванна

**Биом:** 10 `shrubland`. **Амплитуда `Height`:** `1,8 м`.
**Период:** `312 м` / `1,25 км`.
**Целевая сомкнутость:** `0,30…0,45` (открытый грунт `55…70 %` между куртинами).

**EN-промпт:**

```text
[PREFIX], arid scrubland seen directly from above, cellular mosaic of compact woody
shrub clumps two to five percent of the image in size, hard olive-green and grey-green
foliage, visible dark branch structure inside each clump, wide open gaps of bare
reddish-brown gravelly soil between clumps, irregular voronoi-like spacing with no
aligned rows, a few dry twigs and small stones on the exposed ground, low contrast
between adjacent clumps, evenly distributed clump sizes, no continuous canopy
```

**RU-пояснение.** Куртины — «ячейки»: `Height` внутри куртины поднимается до
`1,8 м`, между ними остаётся **плоский субстрат** (это и есть `Height ≈ 0`
в общей шкале). Открытый грунт обязан быть того же hues-семейства, что
`barren`/`hot_desert`, чтобы шейдерный колон от `biomeTop2` не спорил с
рисунком. Ветви внутри кроны важны: они дают `OpticalDepth` и не позволяют
кроне стать «зелёным блином».

**Параметры:** `1024 × 1024`, `--tile`, 4 seed.

**Негатив-акцент:** `dense forest, continuous grass cover, lawn, tropical leaves`.

---

### T3. `Tundra Bryophyte & Dwarf Shrub Mat` — мохово-лишайниковый покров

**Биом:** 5 `tundra`. **Амплитуда `Height`:** `0,5 м`.
**Период:** `312 м` / `1,25 км`.
**Целевая сомкнутость:** `0,45…0,65` (каменная крошка `35…55 %`).

**EN-промпт:**

```text
[PREFIX], arctic tundra cover seen directly from above, soft rounded cushions of
reindeer lichen and pale grey-green moss, low sprawling dwarf shrub runners with tiny
leathery leaves, irregular flat patches of grey stone rubble and frost-shattered
gravel between cushions, cushion diameters three to eight percent of the image,
lichen rosettes with fine branching edges, muted desaturated palette of moss green,
sage, bone grey and pale ochre, no tall vegetation, no trees, no leaves larger than
a few pixels
```

**RU-пояснение.** Подушки ягеля — низкие (`0,5 м`), но с **жёстким краем**:
именно край даёт `FoliageMask` и позволяет отделить мох от каменной крошки.
Холодная десатурация заложена в тайл как нейтральная зелень, а «полярная
седина» добавляется шейдером через `iceScore` (см. §3.2 отчёта).

**Параметры:** `1024 × 1024`, `--tile`, 4 seed; проверять `sat ≤ 0,35`.

**Негатив-акцент:** `trees, shrubs taller than grass, lush green, tropical plants,
snow, ice`.

---

### T4. `Wetland Sedge, Hummocks & Marsh Flora` — кочки, осока и ряска

**Биом:** 15 `wetland` (+ дельты `deltaWeight`).
**Амплитуда `Height`:** `0,8 м`. **Период:** `312 м` / `1,25 км`.
**Целевая сомкнутость:** `0,55…0,80` плюс отдельные «окна» открытой воды/ила
(`puddle`, §3.8 отчёта).

**EN-промпт:**

```text
[PREFIX], freshwater marsh seen directly from above, tussocks of sedge and cattail
rising from wet dark mud, dense tufts of arching narrow blades, circular windows of
dark wet silt and shallow black water between tussocks, patches of green duckweed
film and oily iridescent biofilm on the water surface, tussock diameters four to
ten percent of the image, partially submerged dead grass stems, deep saturated
green and near-black mud palette, no dry ground, no sand
```

**RU-пояснение.** Ключ — **два материала в одном тайле**: биомасса (осока) и
ил/вода. `FoliageMask` должен уверенно разделять их (`ExG` осоки высокий,
ил — низкий/отрицательный). Окна воды нужны ровно там, где шейдер потом
добавит `puddle` и блик от `roughness`; без них болото выглядит как луг.
Биоплёнка — тонкие радужные разводы, **не** яркие пятна.

**Параметры:** `1024 × 1024`, `--tile`, 4 seed; `hue` осоки `100…140°`.

**Негатив-акцент:** `dry grass, desert, sandy beach, clear blue water, waves`.

---

### T5. `Boreal Conifer Canopy & Needle Litter` — хвойный полог тайги

**Биом:** 6 `boreal_forest`. **Амплитуда `Height`:** `22 м`.
**Период:** `1,25 км` (крупный план — на этой ступени полог уже читается) /
`6,25 км`.
**Целевая сомкнутость:** `0,75…0,95` (зрелый массив), `0,40…0,60` (опушка,
реализуется отдельным seed-ом).

**EN-промпт:**

```text
[PREFIX], mature boreal conifer forest canopy seen directly from above, star-shaped
spruce and fir crowns with radial branch whorls, dense needle texture, crowns four to
twelve percent of the image, tightly interlocking with narrow dark gaps between them,
nearly closed canopy with only a few glimpses of dark forest floor, sparse dry needle
litter and thin dead lower branches visible in the gaps, deep cold green and almost
black shadow pockets, uniform crown size distribution, no deciduous broadleaf crowns,
no large open clearings
```

**RU-пояснение.** Звёздчатая форма кроны (радиальные мутовки) — главный
морфологический маркер тайги и отличается от куполов `T6` even на `mip 3`.
Тёмные «карманы» между кронами важны: они дают `OpticalDepth ≈ 1` и позволяют
`heightBlend` строить границу по опушке, а не по цвету.

**Параметры:** `1024 × 1024`, `--tile`, 4 seed; отдельные 2 seed с
`30…40 %` открытых прогалин для опушки (сохраняются как `t5_open` — в атласе
это та же карта, но с иным `coverageBase`).

**Негатив-акцент:** `round deciduous crowns, palm trees, tropical, autumn colours,
snow on trees`.

---

### T6. `Temperate & Rainforest Multi-Layer Canopy` — сомкнутый лиственный полог

**Биомы:** 7 `temperate_forest` и 8 `rainforest` (один архетип, разные
`cov`/тинт).
**Амплитуда `Height`:** `28 м` (умеренный) / `35 м` (тропический).
**Период:** `1,25 км` / `6,25 км`.
**Целевая сомкнутость:** temperate `0,75…0,90`, rainforest `0,92…0,99`.

**EN-промпт:**

```text
[PREFIX], closed multi-storey broadleaf forest canopy seen directly from above,
dome-shaped crowns in three distinct size classes, glossy and matte leaves mixed,
fern fronds and large simple leaves in the lowest layer filling the gaps between
crowns, thin crowns of emergent trees, small dark canopy gaps less than two percent
of the image, crown diameters from five to twenty percent of the image, deep layered
green with cool shadows and occasional pale under-leaf highlights, no tree trunks
visible, no ground visible except in the smallest gaps
```

**RU-пояснение.** Два биома различаются **не текстурой, а профилем покрытия и
тинтом** (см. §3.4–3.5 отчёта): `temperate` получает `cov 0,75…0,90` и
`#297533`, `rainforest` — `cov 0,92…0,99` и `#08521F` с бирюзовыми тенями.
Три класса размера крон — обязательное требование: один класс при повторе
даёт «обои».

**Параметры:** `1024 × 1024`, `--tile`, 4 seed; для тропической половины
дополнительно 2 seed с крупными листьями нижнего яруса.

**Негатив-акцент:** `conifers, needles, sparse canopy, bare ground, savanna`.

---

### T7. `Xeno-Flora / Jungle & Mycelial Mat` — чужеродная биомасса Копрулу

**Назначение:** опциональный спец-тайл для миров Бель'Шир, Зерус, Шакурас;
используется как оверлей к базовому архетипу (обычно `T6` или `T4`) с весом
`xenoWeight` от `palette_id`; **совместим с перекраской гаммы**.
**Амплитуда `Height`:** `12 м`.

**EN-промпт:**

```text
[PREFIX], alien xenobiology ground cover seen directly from above, overlapping
broad membranous fronds with translucent veined edges, clusters of bioluminescent
mycelial mats and puffball fungal bodies, coiled tendril structures, some surfaces
smooth and waxy and others porous, biologically plausible but clearly non-terrestrial
morphology, colour base kept desaturated and mid-value so it can be recoloured later,
structure readable without colour, small glowing sacs fewer than one percent of area,
no terrestrial leaves, no grass blades, no trees
```

**RU-пояснение.** Критично: тайл должен **читаться без цвета** — форма, а не
неон. Палитра задаётся пресетом (`palette_id`) позже; в исходнике допустим
лишь слабый биолюминесцентный акцент (`< 1 %` площади, `value ≤ 0,8`), иначе
тинт «не перекрасит» пятна. `ExG` не работает на фиолетовом/бирюзовом —
в `veg-config.json` для `T7` задаётся `hueCenterDeg` двумя дугами и порог
по `saturation` + `value`.

**Параметры:** `1024 × 1024`, `--tile`, 6 seed (морфология вариативнее).

**Негатив-акцент:** `earth plants, grass, oak leaves, recognizable moss, neon
oversaturated, glowing outlines, cosmic, space, stars`.

---

## 3. Приёмка и постобработка

### 3.1. Геометрический контроль бесшовности (обязателен для всех)

После генерации `build_vegetation()` считает:

```text
seam_x = RMS( столбец[0] − столбец[-1] )
seam_y = RMS( строка[0]  − строка[-1]  )
seam   = max(seam_x, seam_y)            // шкала 0…255
```

| `seam` | Действие |
|---|---|
| `≤ 2,5` | принять автоматически |
| `2,5 … 5` | принять с предупреждением в логе, пометить для визуальной приёмки |
| `> 5` | отклонить, перегенерировать (`--check` → `exit 1`) |

Дополнительно (дешёвая эвристика): сравнить `RMS` краевых полос с `RMS`
центральной полосы. Если краевые полосы **гладко-усреднённые** (типичный
артефакт `--tile`-фильтров), отношение `< 0,6` — предупреждение: такой тайл
даёт видимую рамку при повторе.

### 3.2. Контроль нейтральности альбедо

| Метрика | Допуск | Как считается |
|---|---|---|
| Средняя яркость `L*` | `62…68` | после resize до `512²` |
| Разброс яркости после `GaussianBlur(r=64)` | `< 8 %` | отсутствие крупного градиента |
| Средний цветовой сдвиг | `|Δ(R−B)| ≤ 0,03`, `|Δ(G−mean(R,B))| ≤ 0,05` | кроме `T7` |
| Доля пикселей «насыщенно-зелёных» (`S > 0,75`) | `≤ 6 %` | иначе тинт не сработает |

### 3.3. Контроль `FoliageMask`

| Архетип | Ожидаемое среднее `m` | Допуск |
|---|---:|---|
| `T1a` | `0,93` | `0,88…0,97` |
| `T1b` | `0,65` | `0,55…0,75` |
| `T2` | `0,38` | `0,30…0,45` |
| `T3` | `0,55` | `0,45…0,65` |
| `T4` | `0,68` | `0,55…0,80` |
| `T5` | `0,85` | `0,75…0,95` |
| `T6` | `0,90` | `0,75…0,99` |
| `T7` | `0,60` | `0,45…0,75` |

Отклонение — сигнал, что `hueCenter/hueWidth/satMin` в `veg-config.json`
не соответствует материалу, а не повод «подкрутить» картинку.

### 3.4. Команды конвейера (после внедрения)

```bash
python3 tools/build_assets.py            # собрать устаревшее (включая растительность)
python3 tools/build_assets.py --force    # пересобрать всё
python3 tools/build_assets.py --check    # CI-гейт G5.5: свежесть + швы + маски
python3 tools/build_assets.py --sync-only
```

Ожидаемое время: `20…40 с` на 12 архетипов (Pillow-only, без numpy),
размер публикации `≈ 15,9 МБ`, кэш CI — по `hashFiles('assets/src/**',
'tools/build_assets.py', 'tools/requirements.txt')`.

### 3.5. Чек-лист визуальной приёмки владельца

1. На `W = 1,2 км` кочки `T4` и подушки `T3` **различимы по силуэту**, не
   только по цвету.
2. Граница `grassland ↔ shrubland` проходит по краю куртин (видны открытые
   промежутки), а не «размазана» на `10…15 %` ширины кадра.
3. На `W = 156 км` не видно регулярной сетки повторов при движении камеры.
4. Лес у реки темнее и с прогалинами; у дельты появляются окна ила.
5. Вокруг базы (`terraformMap`) растительность вытоптана, без резкой
   «зелёной кляксы».
6. Красная/бирюзовая палитра `T7` перекрашивается пресетом без «сопротивления»
   исходника.
