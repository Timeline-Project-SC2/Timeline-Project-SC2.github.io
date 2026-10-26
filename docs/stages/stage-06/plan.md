# Этап 6 — боевой WebGL2-глобус · ПЛАН

> Статус: завершён; steady-приёмка телефонов открыта
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Паспорт

| Поле | Значение |
|---|---|
| Дата | 21.10.2026 |
| Модули | `site/shared/planet-globe.ts`, `site/planet-globe/planet-globe-worker.ts`, `site/planet-globe/*` |
| Версия | `planet-globe-v1` |

## Цель

Показать боевой генератор Этапов 4–5 на реальной странице `/planet-globe/` с воркером, прокси-планетой, LOD и адаптивным качеством.

## Входит

* боевой WebGL2-глобус с рельефом, реками, озёрами, континентами C100 и биомами;
* Web Worker: генерация, прогресс, Transferable, кэш сетки и поверхности;
* прокси → финал, двухслойное замещение;
* адаптивное качество и render scale;
* мобильная приёмка и исправления по скриншотам;
* CPU-гейт и тесты.

## Не входит

* страница планеты и маршруты атласа — Этап 7;
* локальная карта — Этап 8;
* chunk-culling как отдельная оптимизация — остаётся долгом.

## Артефакты

* [`site/shared/planet-globe.ts`](../../../site/shared/planet-globe.ts);
* [`site/planet-globe/planet-globe-worker.ts`](../../../site/planet-globe/planet-globe-worker.ts);
* [`site/planet-globe/`](../../../site/planet-globe/index.html);
* [`tests/planet-globe.test.mjs`](../../../tests/planet-globe.test.mjs), `planet-stage7-worker.test.mjs`;
* [`tools/bench_planet_stage6.mjs`](../../../tools/bench_planet_stage6.mjs).

## Гейт и приёмка

**CPU-гейт:** геометрия, цветовые слои и `pick` на `v=128` в бюджете.
**Телефонная приёмка:** страница и рендер работают; HUD-замеры первого прогона относились к окну загрузки, честный steady-p95 после исправлений остался за владельцем.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
