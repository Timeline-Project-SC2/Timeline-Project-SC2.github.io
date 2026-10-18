# Модель данных и иерархия адаптации

## Источники
1. **GitHub-репо разработчика карты** (`type: github`) — картинка-подложка + CSV с координатами.
2. **Google Sheets** (`type: url`) — опубликованный CSV (системы/места/описания).

## Иерархия адаптации
```
Google Sheet / upstream repo (сырые данные)
        ↓ sync.py (скачивание, валидация, transform)
data/upstream/<id>.*   (оригинал, для отладки)
        ↓ transform (flipY/scale/offset, мерж по id)
data/sectors.csv, data/objects.csv, data/system-overrides.csv  (рабочие)
        ↓ фронт (site/shared/app.js)
Каталог / досье / карта
```
Правило: при провале валидации рабочие файлы не затираются.

## Сущности

### System (система / картографическая группа)
| колонка | тип | описание |
|---|---|---|
| id | string (PK) | уникальный id, напр. `aiur-system` |
| name | string | название |
| type | enum | тег системы: `none` (без выделения), `capital` (столица), `unknow` (неизвестно; неизвестный тип); пустое/отсутствующее значение в старых данных трактуется как `none` |
| x, y | number | координаты узла на карте (могут быть условными) |
| faction | string | фракция |
| description | string | описание |
| source_url | string | ссылка на источник/Wiki |

### Place (место)
| колонка | тип | описание |
|---|---|---|
| id | string (PK) | уникальный id |
| name | string | название |
| type | enum | planet / moon / asteroid / station / platform / other |
| system_id | string (FK→System, nullable) | система-владелец |
| x, y | number (nullable) | При пустом `system_id` пара координат в пределах карты создаёт самостоятельную точку интереса. При заполненном `system_id` координаты места не создают отдельный маркер; карта использует позицию системы. |
| description | string | описание |
| faction | string | фракция |
| source_url | string | ссылка |

### Места без привязки к системе
- Место с `system_id` и координатами относится к системе; отдельный маркер места не создаётся.
- Если `system_id` пуст, а `x` и `y` заданы в пределах карты, место отображается отдельной точкой интереса (например, станция в открытом космосе).
- Без `system_id` и без координат запись остаётся только в каталоге; она не появится на карте.

## Категории каталога (UI)
- SYS — системы (System)
- PLN — планеты (type=planet)
- STN — станции (type=station)
- PLT — платформы (type=platform)
- ETC — иные (moon, asteroid, other)

## Публикация Google Sheet
Таблица должна быть опубликована: File → Share → Publish to web → CSV. Иначе sync получит 403/HTML.


## Рекомендация по структуре Google Sheet

Текущий лист содержит **две таблицы рядом в одном CSV** (блоки «Системы:» и «Места:»). Такой формат не парсится автоматически: заголовки дублируются, колонки сдвигаются, валидация невозможна.

**Рекомендуется:** разделить на два листа (вкладки) в одной книге:
- Вкладка `systems` (gid=0) — заголовок: `id,name,type,x,y,faction,description,source_url`; в уже существующей таблице можно сохранить `system_id` вместо `id` (фронтенд поддерживает оба заголовка). Для `type`: `none`, `capital` или `unknow`.
- Вкладка `places` (gid=1) — заголовок: `id,name,type,system_id,x,y,faction,description,source_url`

Каждая вкладка публикуется отдельно (File → Share → Publish to web → CSV для каждого gid). В `data/sources.json` тогда два источника типа `url` с разными `gid` и разными `target`.

Альтернатива — один нормализованный лист с колонкой `type` (system/place/...) и `system_id` (FK), но системы тогда тоже строки с type=system и пустым system_id. Менее удобно для ручного ввода.

Шаблоны: `data/systems-template.csv`, `data/places-template.csv`.
