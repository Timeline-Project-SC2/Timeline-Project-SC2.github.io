# `sector-areas-contract` — документ, схема и проверка

Плоскость: **связи данных** · статус в панели: **рабочий** ·
файл: `src/atlas/sector-areas-contract.ts`.

## Что берёт

Ничего не читает: это корень типов. Принимает сырой JSON (`parseSectorAreas`) и
документ, который собирает редактор.

## Что отдаёт

- версию схемы `v1`, размер карты `10 000`, глубины `MIN_LEVEL`…`MAX_LEVEL`;
- типы `SectorAreasDoc`, `Area`, `Ring`, `AreaState`, `AreaOverride`, `AreaEvent`,
  `GradientSpec`, `AreaLocation`;
- иерархию (ТЗ `SEC-AREAS-HIERARCHY`): `AreaGroup` (именованные группы,
  устойчивый ID), `AreaPair` (слой сочетания пары: режим, порядок наложения,
  запрет пересечения, ширина перехода, линия раздела, `needsReview`),
  `PairLine`/`CurveAnchor` (якоря на видимой кривой: доля дуги + точная точка),
  `ContourAnchors` (якоря кольца области); поля `groups`, `pairs`,
  `contourAnchors` — необязательные расширения схемы v1 (обратно совместимы);
- фабрики `emptySectorAreasDoc`, `createArea`;
- проверку `validateSectorAreas` → `ValidationReport` и поиск петель `findParentCycles`.

## Кто использует

Почти все модули: [команды](editor.md), [каскад](cascade.md), [цвет](color.md),
[форс](force.md), [геометрия](geometry.md), [градиент](gradient.md),
[журнал](journal.md), [LOD](lod.md), [отрисовка](render.md), [scope](scope.md),
[панель](panel.md), а также загрузчик данных сайта.

## Что важно помнить

Проверка даёт **видимое предупреждение, но не блокирует** выгрузку — решение владельца.
Документ плоский: области, перекрытия и события лежат в одном объекте, без деления
на сегменты (см. [`ED-2`](../../../registers/decisions.md#редактор-сектора-сегменты-сохранение-и-логи-ed-)).
