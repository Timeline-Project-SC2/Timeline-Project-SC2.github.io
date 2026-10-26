# Этап A: автосинк и открытые вопросы

>
> Источник: [`docs/stages/stage-a-sync.md`](../../stage-a-sync.md) · строки 1–25.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

Статус: скелет реализован. Требует реальных `owner/repo` и путей в `data/sources.json`.

## Реализовано
- `tools/sync.py` — синк: SHA через GitHub API, сравнение с `data/upstream/manifest.json`, скачивание через raw.githubusercontent.com, валидация размера/формата, чтение размеров PNG/JPEG, transform CSV (flipY/scale/offset), валидация координат и уникальности id, запись `meta.json`/`manifest.json`, сохранение оригиналов в `data/upstream/`.
- `.github/workflows/sync.yml` — cron каждые 6 ч + `workflow_dispatch`, запуск синка, создание Issue при падении, коммит/пуш при изменениях.

## Не реализовано (TODO)
- Автоконвертация PNG >15 МБ → JPG (нужен libvips/Pillow).
- Автоопределение разделителя/кодировки (частично: ; → , и utf-8/cp1251).
- Мерж лор-колонок по id (разделение ответственности).
- Discord-вебхук алерт.
- Негативный сценарий-тест (несуществующий путь → Issue, данные не затёрты).

## Открытые вопросы
- Заполнить `data/sources.json` реальными значениями (Этап 0).

## Обновление: алерты
- Discord-вебхук при падении и при успешном обновлении (через `secrets.DISCORD_WEBHOOK`).
- Триггер `repository_dispatch` (types: upstream-updated) для мгновенного синка.

## Обновление: источники типа url
- Поддержка прямых ссылок (в т.ч. Google Sheets published CSV) через `type: "url"`.
- Ссылка-шаблон в `data/sources.json` (`systems-sheet`).
