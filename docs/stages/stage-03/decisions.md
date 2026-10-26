# Этап 3 — боевое ядро геодезической сетки · РЕШЕНИЯ

> Статус: завершён
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Решения этапа

**D3-1 · Земля `v=128`:** `N = 163 842`, средняя площадь 3 113,15 км², ребро ≈34,6 км; формула `v = round(sqrt((163842·(R/6371)² − 2)/10))`.
**D3-2 · Единственный канонический адрес** `goldberg-gp-v1`; бинарный поиск по `(face, blockI, blockJ, i, j)`.
**D3-3 · Chunk-схема** `face-barycentric-blocks-v1`: блоки по 32 шага, потолок 1 088 ячеек, chunk принадлежит одной грани.
**D3-4 · Бинарный кэш v1** с `GEO\0`, endianness marker, SHA-256 метаданных, CRC32C payload.
**D3-5 · Смена `grid_version` меняет `generation_key`;** golden профиля обновлён на `PG1-Y6MQHGY72BADEFMKSV5KRH5B44`.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
