# Промпты тайлов: дерн, тундра и болота (T1–T4)

> Назад: [шаг 0 консолидации](../../consolidation/README.md) · [документация](../../README.md)

Архетипы тайлов растительности T1–T4: луговой и степной дерн, кустарники, тундра и водно-болотные кочки.

## T1a. `Grassland / Dense Meadow Turf` — густой луговой дерн

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

## T1b. `Grassland / Dry Steppe Turf with Soil Veins` — сухая злаковая степь

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

## T2. `Shrubland / Arid Scrub Clumps` — кустарниковые куртины и саванна

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

## T3. `Tundra Bryophyte & Dwarf Shrub Mat` — мохово-лишайниковый покров

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

## T4. `Wetland Sedge, Hummocks & Marsh Flora` — кочки, осока и ряска

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
