# `nebula-model` — модель туманностей

Плоскость: **пространственное влияние** · статус в панели: **только просмотр** ·
файл: `src/atlas/nebula-model.ts`.

## Что берёт

Контур из границ сектора ([`sector-bounds`](sector-bounds.md)) и параметры пятна:
узор, мерцание, цвет, штрихи.

## Что отдаёт

- модель `createNebula` → `NebulaModel`;
- правку контура: `setNebulaOutline`, `moveNebulaVertex`, `insertNebulaVertex`,
  `removeNebulaVertex`, `deformNebula`;
- оформление: `setNebulaPattern`, `setNebulaBlink`, `setNebulaColor`, `addNebulaStroke`;
- выборку значений: `nebulaBlinkIntensity`, `nebulaPatternPoint`, `nebulaColorAt`, `validBlink`.

## Кто использует

Рендерер карты, сэмплер (`nebula-sampler.ts`) и сцена сектора; панель — только
показывает параметры.

## Что важно помнить

Туманность — модель для отрисовки. В документ областей она не попадает и на
сохранение не влияет.
