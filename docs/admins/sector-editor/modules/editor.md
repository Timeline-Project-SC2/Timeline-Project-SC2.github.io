# `sector-areas-editor` — команды редактирования

Плоскость: **связи данных** · статус в панели: **рабочий** ·
файл: `src/atlas/sector-areas-editor.ts`.

## Что берёт

Документ и сессию правки: `createEditorSession(doc, mode)`. На вход команд приходят
точки штриха, адрес ячейки, идентификатор области и новые значения полей.

## Что отдаёт

- `EditorSession` с историей: `undo`, `redo`, `canUndo`, `canRedo`;
- геометрию штриха: `brushWidthInWorld`, `thickenStroke`, `addressForRing`;
- создание области: `addAreaFromStroke` (свободная кисть) и `addAreaFromSectorCell`
  (ячейка адреса нужной глубины);
- правку: `moveVertex`, `insertVertex`, `removeVertex`, `renameArea`, `setParent`,
  `removeArea`, `setState`, `setGradient`, `setLod`, `setVisibility`, `assignScope`,
  `setDetail`, `addForceFill`;
- `nextSequence` — следующий свободный номер области (без коллизий после загрузки черновика);
- `exportDoc` / `importDoc` — **сериализация и разбор файла**, не отправка на сервер.

## Кто использует

[Панель редактора](panel.md) вызывает команды; [реестр](panel.md#реестр) показывает их
в строке действий. Дальше документ уходит в [проверку](contract.md) и в
[журнал](journal.md).

## Что важно помнить

Модуль не держит DOM и не знает про карту: его можно проверить в node.
Открытая линия (`closed: false`) поддерживается командами, но панель пока всегда
замыкает контур — см. [`ED-5`](../../../registers/decisions.md#редактор-сектора-сегменты-сохранение-и-логи-ed-).
