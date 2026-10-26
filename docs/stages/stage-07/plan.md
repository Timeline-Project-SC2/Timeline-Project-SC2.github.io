# Этап 7 — страница планеты и бесшовный зум · ПЛАН

> Статус: завершён; визуальная приёмка за владельцем
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Паспорт

| Поле | Значение |
|---|---|
| Дата | 22.10.2026 |
| Волна | Stage-7, Tri-Agent Wave, PR #154–#158 |
| Маршрут | `/planet-globe/?place=&system=&cell=` |
| Контракт | `local-map-patch-v1`, `PG1`, `И-1…И-5` |

## Цель

Сделать страницу планеты частью атласа: переход из сектора, глубокие ссылки, проверка ключа, бесшовный зум и срез `Patch7`.

## Входит

* маршрутизация и хлебные крошки;
* склейка `places` + `systems` + `planet-generation.csv` и проверка `PG1`;
* двухслойное центробежное замещение и подлёт камеры;
* intent-based prefetch;
* инспектор ячейки, регион C100 и `Patch7`;
* переходы из атласа сектора и обратные ссылки;
* тесты воркера и проверки волны.

## Не входит

* локальная 3D-сцена и постройки — Этап 8;
* живые `frozen`-профили — редакционная работа;
* финальная визуальная приёмка — владелец.

## Артефакты

* [`site/shared/planet-globe.ts`](../../../site/shared/planet-globe.ts);
* [`site/planet-globe/planet-globe.ts`](../../../site/planet-globe/planet-globe.ts);
* [`src/local-map/local-map-contract.ts`](../../../src/local-map/local-map-contract.ts);
* [`src/atlas/dossier-card.ts`](../../../src/atlas/dossier-card.ts);
* [`tests/planet-stage7-worker.test.mjs`](../../../tests/planet-stage7-worker.test.mjs).

## Гейт и приёмка

**Проверки волны:** typecheck, lint, `npm test` (+ worker test), build, `verify:publish` (7 маршрутов), `verify:contract`, `git diff --check`.
**Визуальная приёмка владельцем:** замещение прокси → финал, prefetch, прямые и обратные ссылки, отсутствие сброса ракурса.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
