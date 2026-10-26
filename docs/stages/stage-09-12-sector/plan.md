# Этапы 9–12 (сектор) — глубинный секториальный рендер · ПЛАН

> Статус: активно: SW-1…SW-5 и F-1 закрыты, следующая карточка F-2
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Паспорт

| Поле | Значение |
|---|---|
| Статус | гайдлайнер **4.0** от 26.10.2026, волна `F` открыта |
| Волны | `SW-1…SW-6`, `SW-3F`, закрывающая `F-1…F-6` |
| Гейты | `G7.1…G7.15` |
| Гайдлайнер | [`stage-9-12-sector-deep-render-plan.md`](../stage-9-12-sector-deep-render-plan.md) (хаб) |
| Инвариант | `И-11`: планетарный контур вне зоны правок |

## Цель

Перевести атлас сектора на процедурный рендер без растровой подложки, с буквенным адресом и глубиной до `0,002` св.г. на CSS-пиксель, и закрыть сектор приёмкой.

## Входит

* `1` единица карты = `1` световой год; `UNITS_PER_LY = 1`;
* предел приближения `0,002` св.г./px (`500` px/св.г.);
* 13 секторных уровней `L0…L12` шагом `1,9194×`; системные `S0…S2` — номера `13…15`;
* буквенный адрес `KP·REQHC`, тиры `T0…T7` (`T6 = 0,64`, `T7 = 0,128` св.г.);
* фактическая сетка: старший тир + ровно один вложенный;
* процедурное поле WebGL2 + Canvas2D, растр удалён;
* полёт, стрелки, карточка точки, системный кадр `S0…S2`.

## Не входит

* планетарный контур (`src/planet/*`, `src/local-map/*`, `site/planet-globe/*`, `site/shared/planet-*`, `data/planet-generation.csv`);
* `data/*.csv` и `data/meta.json`;
* растр галактики и маршрут `/`;
* `Z-3.1`/`Z-3.2` — можно параллельно, монтаж в волне `G`;
* `Z-1` — волна `G`.

## Артефакты

* [`src/atlas/sector-units.ts`](../../../src/atlas/sector-units.ts), `level-ladder.ts`, `sector-address.ts`, `sector-scene.ts`, `sector-flight.ts`, `sector-arrows.ts`, `canvas-renderer.ts`, `system-frame.ts`;
* [`tools/verify_sector_core.mjs`](../../../tools/verify_sector_core.mjs), `verify_sector_address.mjs`, `verify_no_raster.mjs`;
* тесты `sector-*`, `system-frame`, `canvas-zoom-clamp`, `coords-readout`;
* гайдлайнер 4.0 и матрица волны `F` в [`agents_task_orchestration`](../../agents_task_orchestration/agents_task_orchestration.md) §18.

## Гейт и приёмка

**G7.1** адрес `173/173`, round-trip и golden vectors; **G7.2** 13 уровней, шаг, гистерезис; **G7.4** бюджет кадра `L8…L12`; **G7.5** точность `≤0,5 px`; **G7.8** hash-ссылки и `/minimal/`; **G7.9** системный кадр `173/173`; **G7.11** стрелки; **G7.13** сетка; **G7.14** единица и предел; **G7.15** маркер.
**Норма `npm test`:** те же 8 известных планетарных падений; девятое блокирует карточку.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
