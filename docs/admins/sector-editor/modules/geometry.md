# `sector-areas-geometry` — геометрия и площади

Плоскость: **связи данных** · статус в панели: **только просмотр** ·
файл: `src/atlas/sector-areas-geometry.ts`.

## Что берёт

Кольца и точки областей: `Ring`, `AreaPoint` из [контракта](contract.md).

## Что отдаёт

- площадь и центр: `ringArea`, `ringCentroid`;
- границы: `bboxOf` (`BBox`);
- попадание точки: `pointInRing`, `pointInArea`, `ringContainsRing`;
- расстояния и пересечения: `distanceToRing`, `selfIntersections`, `totalVertices`;
- подготовку контура: `parametrize`, `simplify`, `smooth`, `ringLength`, `pointAt`.

## Кто использует

[Каскад](cascade.md) — вложенность и глубина; [форс](force.md) — попадание штриха;
[градиент](gradient.md) — вершины; [журнал](journal.md) — вес набора;
[LOD](lod.md) — упрощение; [отрисовка](render.md) — площадь и подписи;
[scope](scope.md) — классификация; [команды](editor.md) — правка вершин.

## Что важно помнить

Модуль считает по правилам карты (`10 000`), а не по экранным пикселям: масштаб
приходит снаружи и на результат не влияет.
