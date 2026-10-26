# Промпты тайлов по морфологическим архетипам — часть 2

> Часть 2/2.
> Источник: [`docs/prompts/stage-9-vegetation-tiles.md`](../stage-9-vegetation-tiles.md) · строки 149–402.
> Назад: [карта документации](../../README.md) · [индекс документации](../../README.md).

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
