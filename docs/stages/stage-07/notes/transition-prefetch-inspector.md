# Замещение, prefetch, инспектор и проверки

>
> Источник: [`docs/stages/stage-7-planet-page.md`](../../stage-7-planet-page.md) · строки 87–211.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 3. Двухслойное центробежное замещение и подлёт камеры

Геометрия прокси и финала больше не подменяется «прыжком»:

- `setGeometry()` по-прежнему заливает готовый бандл, но переход
  `прокси → финал` выполняется двухслойным центробежным замещением:
  уходящий `prevVao` рисуется с `uHide = progress`, новый `vao` — с
  `uCenterGrow = progress`; волна идёт от центра видимого полушария к лимбу,
  поэтому детальный слой «прорастает» из центра и занимает место
  сжимающихся ячеек прокси без визуального «попа»;
- `transitionGeometry(nextGeometry, durationSec?)` инкапсулирует этот волновой
  переход и освобождает буферы `prevVao` сразу по его завершении — две полные
  сферы не живут в памяти постоянно;
- `flyToDirection(direction, targetDistance?, durationMs?)` доводит камеру до
  выбранного направления/дистанции без перезапуска сборки с полюса;
  `getCameraState()` отдаёт текущее состояние для ссылок и инспектора;
- `onCameraIntent` (debounce 180 мс) сообщает намерение камеры наружу —
  страница превращает его в `prefetch` для воркера.

Каскад `uBuild` (широтная волна посадки ячеек от полюса к полюсу) остаётся
ответственным за первичную сборку планеты; замещение `uHide`/`uCenterGrow`
его не перезапускает.

## 4. Упреждающий `intent-based worker prefetch`

Воркер получает команду `prefetch` с `token`/`requestId`
(политика latest-wins: устаревшие задачи отменяются по токену) и заранее:

- прогревает целевой уровень `v` в `GridCache`;
- резервирует соседние чанки через `GeodesicGrid.getChunkNeighbors`;
- собирает будущий `Patch7` для камеры, которая ещё только приближается.

Бандлы передаются скрытыми `Transferable`, главный поток не блокируется, а
камера не ждёт готовности воркера: если намерение сменилось, устаревший
результат отбрасывается по токену, а не дорисовывается поверх нового.

## 5. Инспектор ячейки, регион C100 и участок `Patch7`

Клик по глобусу или `?cell=` даёт каноническую ячейку на частоте
`canonicalV` (`EARTH_CANONICAL_V`, И-1). Панель инспектора показывает:

- канонический адрес (`v:face:i:j`), площадь, континент/бассейн C100,
  дренажный регион, сток, озёра и биомы top-2 из `PlanetSurface`;
- континентальную область C100 (seed-ячейка, границы, `region_seed_address`,
  `geography_version`) и водосбор рек по общим граням;
- срез `Patch7` из `src/local-map/local-map-contract.ts`
  (`LOCAL_MAP_PATCH_VERSION = 'local-map-patch-v1'`, И-3): центральная ячейка
  и её 6 соседей по `grid.neighbors`, единый 3D-сэмплер полей, уровень берега и
  зеркал по `filledElevation`/`seaLevel`/`lakeWeight`, непрерывность русел по
  `flowReceiver`/`streamWeight`/`flowAccumulationKm2`.

Команда воркера `extract-patch` собирает его строго на `canonicalV`
(`buildPatch7`), проверяет `verifyPatchInvariants` и `patchSpanMeters`,
считает маску застройки `buildBuildingSpawnMask`; 5-угольные полюсные ячейки
автоматически привязываются к ближайшему 6-угольному соседу, поэтому срез
всегда состоит из семи ячеек.

### Производные ключи (§8.8)

| Ключ | Формула |
|---|---|
| `planet_key` | `generation_key` (PG1 из `planet-generation.csv`) |
| `cell_key` | `H(planet_key + canonical_cell_address)` |
| `region_key` | `H(planet_key + region_seed_address + geography_version)` |
| `patch_key` | `H(planet_key + projection_version + center_cell + zoom/x/y + local_atlas_version)` |

`H` — хэш-функция контракта; в таблицу эти ключи не пишутся, они выводятся
на месте и попадают в ссылку «скопировать прямую ссылку на ячейку». Смена
`generation_key` (новая ревизия профиля) автоматически инвалидирует старые
derived-ключи — это и есть смысл И-4.

## 6. Изменения потока Воркера 3 (атлас сектора)

- `src/atlas/config.ts` — `PlaceRecord.planetProfileStatus`
  (`PlanetProfileStatus = 'draft' | 'review' | 'frozen'`), `planetPresetId`,
  `planetRadiusKm`, `planetGenerationKey`; константа `PLANET_GLOBE`
  (маршрут и подпись пресета по умолчанию) и имя снимка
  `CONFIG.data.generation = 'planet-generation.csv'`.
- `src/atlas/data-loader.ts` — загрузка `/data/planet-generation.csv`
  (обе ветки `loadDataset()`) и `mergePlanetGenerationRows`.
- `src/atlas/dossier-card.ts` — `isGlobeCapablePlace`
  (`planet`/`moon` в `placeTypesOf` или заполненный `planetProfileStatus`),
  `planetGlobeUrl`, бейдж статуса 3D-профиля, блок `.detail-globe-cta`
  с кнопкой `.detail-globe-button` в досье места и компактная ссылка
  `.world-globe-link` в `.world-list` карточки системы; `applyHash()` понимает
  обратные ссылки `/sector/#system=<id>` и `/sector/#planet=<id>`.
- `site/shared/timeline-skin.css` — стили `.detail-globe-cta`,
  `.detail-globe-button`, `.detail-globe-caption`, `.globe-profile*` и
  `.world-globe-link` в палитре досье.

Инвариант `site/AGENTS.md` сохранён: карточка наведения
`#detailPanel.is-preview` остаётся `pointer-events: none` (`syncDetailPreview`),
поэтому кнопка глобуса доступна только в закреплённой карточке, а клик по
системе под предпросмотром по-прежнему закрепляет досье.

## 7. Проверки волны

Выполняются в каждой ветке волны одинаково:

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint site src
npm test                 # 8 существующих Node-тестов + tests/planet-stage7-worker.test.mjs (Воркер 1)
npm run build            # tsc --noEmit + Vite -> .publish/
npm run verify:publish   # 7 маршрутов, build-manifest.json, паритет экспортов
npm run verify:contract  # Python ↔ TypeScript: пресеты, манифест, PG1, approved_at
git diff --check
```

`npm run verify:publish` проверяет маршрут `/planet-globe/` вместе с остальными
шестью, поэтому новый URL страницы не может «потеряться» при сборке.

## 8. Что остаётся за владельцем

- Визуальная приёмка бесшовного замещения `прокси → финал` на десктопе и
  телефоне: нет «попа», нет двойной сферы, нет перезапуска с полюса; при
  смене планеты из атласа ракурс не сбрасывается.
- Проверка prefetch: перетаскивание камеры по планете не должно давать
  рывков и ожидания воркера; устаревшие задачи не должны «догонять» камеру.
- Прямые ссылки: `/planet-globe/?place=<id>`, `?place=&system=`,
  `?place=&system=&cell=` и обратные `/sector/#planet=<id>`,
  `/sector/#system=<id>`.
- Профиль: живая вкладка `planet_generation` ещё пуста в снимке, поэтому на
  сайте пока честно показывается «процедурный глобус c100-soft-v2», а
  `L1 Frozen` появится после первого синка реальной строки.
