# `sector-areas-scope` — области действия

Плоскость: **пространственное влияние** · статус в панели: **только просмотр** ·
файл: `src/atlas/sector-areas-scope.ts`.

## Что берёт

Границы сектора ([`sector-bounds`](sector-bounds.md)) и геометрию области; правила
`ScopeRule` и наборы детализации.

## Что отдаёт

- построение областей действия: `createScope`, `scopesFromBounds`, `outsideScopeOf`;
- попадание и расстояние: `isInside`, `distanceToScope`;
- классификацию: `classifyArea`, `classifyLocation` (ядро, пояс, пограничье, вне полос);
- пересечения и старшинство: `scopeCrossings`, `dominanceFor`, `resolveDominance`, `scopeConflicts`;
- наборы детализации: `createDetailSet`, `addDetail`, `renameDetail`, `removeDetail`.

## Кто использует

[Команды](editor.md) — привязка области к области действия; панель — строку
«вне/внутри» в свойствах; общий рендерер карты — для подписей и подсветки.

## Что важно помнить

Классификация — производная: она пересчитывается из границ и геометрии и не хранится
в документе как отдельное поле решения.
