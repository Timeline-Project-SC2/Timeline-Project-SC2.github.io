# Промпты тайлов: леса и ксено-флора (T5–T7)

> Назад: [шаг 0 консолидации](../../consolidation/README.md) · [документация](../../README.md)

Архетипы тайлов растительности T5–T7: хвойный и лиственный пологи, чужеродная биомасса Копрулу.

## T5. `Boreal Conifer Canopy & Needle Litter` — хвойный полог тайги

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

## T6. `Temperate & Rainforest Multi-Layer Canopy` — сомкнутый лиственный полог
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

## T7. `Xeno-Flora / Jungle & Mycelial Mat` — чужеродная биомасса Копрулу

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
