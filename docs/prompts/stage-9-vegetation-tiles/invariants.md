# Промпты тайлов: строгие технические инварианты

>
> Источник: [`docs/prompts/stage-9-vegetation-tiles.md`](../stage-9-vegetation-tiles.md) · строки 1–148.
> Назад: [карта документации](../../README.md) · [индекс документации](../../README.md).

Дата: 23 октября 2026 года.
Назначение: готовый к использованию набор технических инвариантов и промптов
для генерации исходников в `assets/src/terrain/`, из которых
`tools/build_assets.py` собирает каналы `Albedo`, `FoliageMask`, `Height`,
`Roughness` и `OpticalDepth` для `TERRAIN_FRAGMENT_SHADER` и
`StructureRenderer` (`src/local-map/local-map-renderer.ts`).

Архитектурное обоснование, матрица биомов и бюджеты — в
[`../stages/stage-9-vegetation-atlas.md`](../../stages/stage-9-vegetation-atlas.md).
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
