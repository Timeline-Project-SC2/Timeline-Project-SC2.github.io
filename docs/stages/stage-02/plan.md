# Этап 2 — данные, синхронизация и каркас сайта · ПЛАН

> Статус: данные и синк завершены; живые профили и часть фронтенд-каркаса ждут
> Назад: [этапы](../README.md) · [документация](../../README.md) · [регистры](../../registers/README.md).

## Паспорт

| Поле | Значение |
|---|---|
| Период | 19–21.10.2026 |
| Ветка / PR | `arena/c6424c78-…`, PR #115 |
| Источник данных | Google Sheets: `systems`, `places`, `planet_generation` (`gid=1183479406`) |
| Компоненты | `tools/planet_generation.py`, `tools/sync.py`, `data/*.csv`, `data/sources.json` |

## Цель

Заложить контракт профилей планет, безопасную доставку данных из Google Sheets и минимальный каркас страницы, не ломая существующий рендер.

## Входит

* лист `planet_generation` из 37 колонок, 8 пресетов, валидатор, `PG1`, `generation_key`;
* двухфазный `sync.py`: скачать и проверить всё в памяти → атомарно заменить снимки;
* интеграционный тест гейта синка;
* модель данных `System`/`Place`/`PlanetGenerationProfile`;
* каркас фронтенда: `?fresh=1`, `#mapPlaceholder`, чтение версии;
* Этап A: автосинк по cron, Issue при падении, Discord-вебхук, `type: "url"`.

## Не входит

* чтение профилей боевыми страницами — Этапы 6–7;
* реальные `frozen`-профили — редакционная работа после Этапов 3–4;
* полный трёхуровневый загрузчик картинки — TODO фронтенда.

## Артефакты

* [`tools/planet_generation.py`](../../../tools/planet_generation.py);
* [`data/planet-generation.csv`](../../../data/planet-generation.csv), шаблон и `sources.json`;
* [`tools/sync.py`](../../../tools/sync.py);
* [`tests/test_planet_generation.py`](../../../tests/test_planet_generation.py), `test_sync.py`;
* [`docs/ADMIN_GUIDE.md`](../../ADMIN_GUIDE.md), [`stage-data-model.md`](../stage-data-model.md), [`planet-sheet-layout.md`](../planet-sheet-layout.md).

## Гейт и приёмка

**Гейт этапа:** валидатор снимка + 26 Python-тестов + интеграционный тест «профиль на несуществующее место → синк падает, прежние CSV байт-в-байт не изменены».
**Статус живого листа:** заголовок импортирован, профилей нет; первый живой снимок применится после мержа PR и запуска Sync.

## Регистры этапа

- [Ошибки](errors.md) · [Баги](bugs.md) · [Решения](decisions.md) · [TODO](todo.md)
- [Приложения](notes/README.md) · [Исходный план §12](notes/plan-source.md)
