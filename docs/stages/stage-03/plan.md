# Этап 3 — боевое ядро геодезической сетки · ПЛАН

> Статус: завершён
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Паспорт

| Поле | Значение |
|---|---|
| Дата / PR | 21.10.2026, ветка Этапа 3 |
| Версии | `gridVersion=goldberg-gp-v1`, `addressSchema=goldberg-gp-v1`, `topologySchema=goldberg-gp-v1-soa` |
| Ядро | [`site/shared/geodesic-grid.ts`](../../../site/shared/geodesic-grid.ts) |

## Цель

Перевести сетку спайка в версионированное ядро, на которое могут опираться география, chunk-рендер и кэш.

## Входит

* SoA-топология вместо JS-массивов объектов и `Set` на ячейку;
* каноническийアドрес `goldberg-gp-v1`, парсер и `cellAtAddress`;
* chunk-контракт `face-barycentric-blocks-v1`, bounding spheres, быстрый `pick`;
* little-endian бинарный кэш с SHA-256 `paramsHash`, CRC32C и rebuild;
* каноническая плотность Земли `v=128`;
* `grid_version=goldberg-gp-v1` в контракте `planet_generation`.

## Не входит

* C100 и гидрология — Этапы 4–5;
* GPU chunk-LOD и отсечение — Этап 6;
* публичные ссылки на ячейки — до стабилизации адреса.

## Артефакты

* [`site/shared/geodesic-grid.ts`](../../../site/shared/geodesic-grid.ts);
* [`tests/geodesic-grid.test.mjs`](../../../tests/geodesic-grid.test.mjs), [`tests/planet-grid-cache.test.mjs`](../../../tests/planet-grid-cache.test.mjs);
* [`tools/bench_planet_stage3.mjs`](../../../tools/bench_planet_stage3.mjs);
* `goldberg-gp-v1` в [`src/contracts/planet-generation-contract.json`](../../../src/contracts/planet-generation-contract.json).

## Гейт и приёмка

**Topology:** `validate().ok = true`, `validateChunks().ok = true`.
**Pick:** fast vs brute на 1 000 направлений — 0 расхождений.
**Perf `v=128`:** build 484,7 мс, typed arrays 19,70 МиБ; CI build ускорился ≈2,1×; рост памяти +2,5 % при пороге +30 %.
**Cache:** 19 988 652 байта, serialize/deserialize 305,3/366,6 мс, CRC и SHA проверяются.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
