# Маршрутизация, хлебные крошки и склейка данных

>
> Источник: [`docs/stages/stage-7-planet-page.md`](../../stage-7-planet-page.md) · строки 1–86.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

Дата: 22 октября 2026 года. Волна **Stage-7** (`Tri-Agent Wave`,
`docs/agents_task_orchestration/agents_task_orchestration.md` §8).

## Результат

Страница планеты перестаёт быть изолированным стендом Этапа 6 и становится
частью атласа:

```text
Галактика (/) → Сектор Копрулу (/sector/, /minimal/)
  → система (?place=&system=) → планета (/planet-globe/?place=&system=&cell=)
  → ячейка canonicalV, континентальная область C100, участок Patch7
```

Три потока волны разведены по файлам без пересечения (`Zero File Overlap`),
сводную документацию и переход из атласа закрывает Воркер 3:

| Воркер | Поток | Файлы |
|---|---|---|
| 1 | Ядро бесшовного зума: `transitionGeometry`, `flyToDirection`, `getCameraState`, `onCameraIntent`; команды `prefetch` / `extract-patch` воркера | `site/shared/planet-globe.ts`, `site/planet-globe/planet-globe-worker.ts`, `tests/planet-stage7-worker.test.mjs`, `package.json` |
| 2 | Страница `/planet-globe/`: каталог мест, хлебные крошки, URL, инспектор ячейки/региона/`Patch7`, prefetch по намерению камеры | `site/planet-globe/index.html`, `site/planet-globe/planet-globe.css`, `site/planet-globe/planet-globe.ts` |
| 3 | Переход из атласа сектора, связка `planet-generation.csv` с досье, отчёт и сводная документация | `src/atlas/config.ts`, `src/atlas/data-loader.ts`, `src/atlas/dossier-card.ts`, `site/shared/timeline-skin.css`, `docs/stages/stage-7-planet-page.md`, `docs/HANDOFF.md`, `CHANGELOG.md` |

## 1. Маршрутизация, хлебные крошки и глубокие ссылки

Страница планеты адресуется только стабильными параметрами запроса:

```text
/planet-globe/?place=<place_id>[&system=<system_id>][&cell=<address|cell_index>]
```

- `place` — `places.ID` из снимка; по нему из `places.csv` + `systems.csv`
  восстанавливаются имя, тип (планета/луна), система и профиль генерации
  из `planet-generation.csv`;
- `system` — `systems.system_id`; нужен для хлебных крошек и обратной ссылки,
  когда у места система известна только из профиля;
- `cell` — канонический адрес (`v:face:i:j`) либо индекс ячейки на
  `canonicalV`; ссылка на ячейку воспроизводима и не зависит от сессии.

Навигационная цепочка `Галактика → Сектор Копрулу → Система → Планета`
строится из этих же данных, а обратные ссылки ведут по уже поддержанным
хэшам атласа: `/sector/#system=<id>` и `/sector/#planet=<id>`
(`applyHash()` в `src/atlas/dossier-card.ts` понимает и прежний вид
`#/s/<id>` / `#/p/<id>`, и именованный `#system=<id>` / `#planet=<id>`).

Со стороны атласа переход даёт одна функция — `planetGlobeUrl(place)`:
`/planet-globe/?place=<encodeURIComponent(id)>[&system=<encodeURIComponent(systemId)>]`.
Её и только её используют кнопка досье и быстрая ссылка списка миров, поэтому
формат ссылки не может разъехаться между двумя точками входа.

## 2. Склейка данных и проверка ключа (И-4)

Источник истины — три снимка Google Sheets, синхронизированные
`python3 tools/sync.py --strict`:

| Снимок | Роль в досье планеты |
|---|---|
| `data/places.csv` | `ID` (это и есть `place_id` профиля), `name`, `type` (`planet`/`moon`), `system_id` |
| `data/systems.csv` | имя системы, фракция, координаты карты |
| `data/planet-generation.csv` | `profile_status`, `preset_id`, `radius_km`, `generation_key` (PG1) |

В атласе `loadDataset()` запрашивает третий снимок в обеих ветках загрузки
(`window.__MAP_DATA__` и обычные JSON+CSV) и передаёт его в
`mergePlanetGenerationRows(places, rows)`: строки сопоставляются по
`place_id === String(place.id)`, статус валидируется по
`draft | review | frozen`, радиус принимается только положительным числом.
Отсутствие строки — законное состояние: глобус собирается процедурно из
контракта `c100-soft-v2` без статуса и без ключа фиксации.

Страница планеты разворачивает профиль через
`expandPlanetGenerationProfile(profile)` и проверяет его
`verifyGenerationKey(profile)`:

- `ok: true, applicable: false` — черновик без ключа: разрешена только
  черновая генерация, бейдж `3D-профиль: черновик`;
- `ok: true, applicable: true` — замороженный L1-профиль: `generation_key`
  пересчитан из канонического манифеста и совпал, бейдж `L1 Frozen`;
- `ok: false` — ключ не совпал с манифестом: профиль не применяется,
  показывается расхождение вместо подмены географии.

То же состояние видно в атласе: досье места показывает бейдж
`3D-профиль: L1 Frozen` / `на проверке` / `черновик` / `3D-глобус Голдберга`,
а подпись под кнопкой перехода берёт `preset_id` и `radius_km` из снимка.
