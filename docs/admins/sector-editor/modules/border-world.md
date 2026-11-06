# `sector-areas-border-world` — пограничный мир

Плоскость: **пространственное влияние** · статус в панели: **только просмотр** ·
файл: `src/atlas/sector-areas-border-world.ts`.

## Что берёт

Центр Корхал (`CENTRAL_SYSTEM_KORHAL`), систему Коло (`BORDER_SYSTEM_KOLO`) и полосы
`DEFAULT_BANDS`; альтернативно — строки `systems.csv` (`parseSystemsCsv`,
`borderWorldFromSystems`).

## Что отдаёт

- модель `createBorderWorld` → `BorderWorld` (центр, полосы, границы);
- идентификаторы и выборку полос: `bandIds`, `bandAt`, `bandIdAt`;
- расстояние до центра `distanceToCentral`;
- проверку и правку полос: `validateBands`, `setBands`.

## Кто использует

Панель — строку полосы в свойствах области; [scope](scope.md) — как основу для
классификации «пограничье»; общий рендерер — для колец пограничья.

## Что важно помнить

Полосы — это про **пространство**, а не про цвет: окраска приходит из
[палитры](color.md). Центр отсчитывается от Корхала к Коло, а не наоборот.
