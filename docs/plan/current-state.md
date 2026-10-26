# Текущее состояние репозитория

> Срез на 22.10.2026.
> Источник: [`docs/PREPARATION_PLAN.md`](../PREPARATION_PLAN.md) · строки 117–169.
> Назад: [карта документации](../README.md) · [индекс документации](../README.md).

## 2. Текущее состояние репозитория

### 2.1. Что уже работает

| Запрошенный уровень | Состояние | Текущая реализация |
|---|---|---|
| Галактика | Готово | `site/index.html`, `site/galaxy.ts`, `site/galaxy.css`, `site/shared/{focus-fx,cursor-fx,galaxy-spiral,lag-fx}.ts` |
| Сектор | Базовый процедурный атлас, подключённые части SW-3/SW-4 (`147a0e2`) и навигация SW-3F (`fafc564`: полёт и внекадровые стрелки) находятся в `main` на базе `e1cd1e0`; растровый контур удалён. Приглушение в `anticipation` готово в PR #277 (`e1cd1e0`): `FlightPhase`, `onPhaseChange`, `FLIGHT_MARKER_DIM = 0.35`, `setFlightDim`; цель остаётся яркой, остальные маркеры — `0,35`, при выходе из фазы, прибытии и `cancel()` выполняется сброс. В очереди — режим `'label'` и перевод единиц `Z-4` по §17.23 (`492ab64`); очередь владельца `Z-1`/`Z-2` зафиксирована в [§17.21 матрицы](../agents_task_orchestration/agents_task_orchestration.md) и ещё не начата. | `templates/atlas-shell.html`, тонкие входы `site/sector/sector.html` и `site/minimal/minimal.html`, `src/atlas/{app.ts,config.ts,data-loader.ts,sector-field.ts,sector-address.ts,sector-units.ts,level-ladder.ts,sector-scene.ts,label-layout.ts,sector-flight.ts,sector-arrows.ts,canvas-renderer.ts,catalog-panel.ts,dossier-card.ts,coords-readout.ts,atlas-variants.ts}` (`tile-pyramid.ts` удалён) |
| Система | Нет страницы в UI; в `main` слито только без-DOM-ядро кадра `S0…S2` (`9fd1194`: монтаж `#systemFrame` в `atlas-shell.html`/`styles.css`/`app.ts` ещё не сделан; ошибка типа `type=none` в `data-loader.ts` исправляется PR #276 (`8d3eaae`, ещё не слит): `normalizedPlaceType`: `none`/пустая строка → `unknown`, `PLACE_TYPES.unknown` — «Без типа», глиф `?`; места без типа относятся к «полке ожидания» по §9.2 п.5) | Есть каталог систем и связи мест с системами (`data/systems.csv`, `data/places.csv`) и чистая вычислительная модель `src/atlas/system-frame.ts` (`calibrateOrbitScale`, `orbitScreenRadius`, клампы `18…28` / `≥ 200 px`, пустое состояние, переход `/planet-globe/?place=<id>&system=<id>` на `S2`) |
| Планета (ядро и страница в цепочке) | Готово (Этапы 6–7) | Единое ядро `site/shared/{geodesic-grid,planet-noise,planet-geography,planet-surface,planet-globe,planet-generation-contract}.ts` + Wasm `src/planet/{assembly/kernels.ts,planet-core-host.ts,planet-core-bytes.ts}`; боевая страница `/planet-globe/` (`site/planet-globe/{index.html,planet-globe.css,planet-globe.ts,planet-globe-worker.ts}`) с переходом из `src/atlas/dossier-card.ts` и FX-стенд `/planet-test/` (`site/planet-test/planet-test.ts` + `src/planet/planet-globe-fx.ts`) |
| Континент/область | Готово (Этап 7) | C100-идентичности (`c100-soft-v1`), гидрология/дренажные регионы/биомы (`c100-soft-v2`), инспектор канонической ячейки/региона C100/`Patch7` и ключи §8.8 на `/planet-globe/` |
| Местность до ~1 км | Готово (Этап 8 и итерации Stage-8.1 … Stage-8.7; визуальная приёмка G6.1/G6.2 — за владельцем; атлас текстур — Этап 9) | Контракт сшивки 7 ячеек `src/local-map/local-map-contract.ts` (`local-map-patch-v1`, И-3), модули `src/local-map/{local-map-mesh,local-map-worker,local-map-renderer,local-map-shaders}.ts` с порционной GPU-догрузкой (Патч 8), кольцевыми LOD-областями `1–5` (`6/12/18/24/30` ячеек, `[256, 64, 32, 16, 8, 4]`, `5 → 4 → 3 → 2 → 1 → центр → юбка`) и Dive-in экраном на `/planet-globe/` (`1250 … 1.2 км`); сферическая юбка горизонта с дневным куполом неба (`stages/STAGE_8_PLANETARY_HORIZON.md`), знаковая батиметрия, сквозные реки, 5 высотных поясов суши (`Stage-8.6`), атомарный ре-бейзинг камеры `rebaseLocalCameraState` и голографические квик-стрелки `site/planet-globe/local-map-quick-nav.ts` (`Stage-8.7`) |

**Единицы секторной навигации (актуально на `e1cd1e0`):** По §17.23 (`492ab64`, PR #280) `1000` единиц карты = `1` св.г., поле сектора — `10` св.г., медиана шага систем — `0,99` св.г.; предел на упоре остаётся `1,00 св.г. до границы`. Исходные голдены `88,4 / 90,8 / 108,07 / 116,32 / 116,76` — **единицы карты**, не световые годы; после `Z-4` подписи станут `0,088 / 0,091 / 0,108 / 0,116 / 0,117 св.г.` соответственно (Райдин / Мистафф / Джонтур / Норрис / Дориан). Числа исходных голденов и тестов не заменяются пересчитанными.

По правилу вытеснения легаси (Инвариант И-5, план `CR-01` PR #130–#139 и волна `PR 6.1`) все прежние нетипизированные монолиты и дубликаты (`site/shared/app.js`, `site/shared/temp_code_structures.js`, `site/planet-test/planet-test.js`, `site/planet-test/planet-worker.js`, `site/shared/planet-geometry.js` и старые `.js`-копии планетных модулей) удалены из репозитория.

Текущий атлас сектора (`src/atlas/*.ts`) уже содержит важную инфраструктуру:

- Canvas-рендер;
- тайловую пирамиду 10 000 × 10 000;
- 534 WebP-тайла по 512 px при сборке;
- уровни детализации;
- LRU-кэш тайлов;
- поиск, каталог, фильтры и досье;
- управление мышью и сенсорным вводом по правилам проекта;
- общий системный курсор и анимацию выбора.

### 2.2. Текущие данные

В снимках репозитория:

- `data/systems.csv` — каталог систем (актуальные снимки синхронизируются из Google Sheets);
- `data/places.csv` — каталог мест (`planet`, `moon` и др.);
- `data/planet-generation.csv` — снимок профилей генерации планет (живая вкладка `planet_generation`, `gid=1183479406`, подключена в `data/sources.json`), шаблон — `data/planet-generation-template.csv`;
- единый источник истины схемы из 37 колонок, 8 пресетов (`planet-presets-v1`) и версий — `src/contracts/planet-generation-contract.json`, используемый и Python-валидатором (`tools/planet_generation.py`), и TS-рантаймом (`site/shared/planet-generation-contract.ts`, И-4);
- двухфазная атомарная синхронизация всех трёх листов выполняется `tools/sync.py` раз в 6 часов;
- картинки собираются `tools/build_assets.py` при деплое (`imageVersion` пишется в `data/meta.json`), исходники лежат в `assets/src/`, производные в Git не коммитятся.

Следовательно, «500 планет» — это целевой масштаб архитектуры и будущего каталога, а не текущий объём заполненных профилей. Основной редакционный объём впереди.

### 2.3. Архитектурные ограничения текущего проекта

- Zero-Backend статика на GitHub Pages: серверной части и внешней СУБД нет; сборщик Vite (`vite.config.mts` + строгий `tsconfig.json`) компилирует TypeScript из `site/` и `src/` в статическую папку публикации `.publish/` с контент-хэшами в именах JS/CSS/worker (ручные `?v=` запрещены).
- Двухконтурный стек без «эффекта Франкенштейна» (`CR-01`, Инварианты И-1…И-6): весь UI, атлас, WebGL2-рендереры, воркеры и контракты данных написаны на строгом TypeScript (`tsc --noEmit`), а горячая математика планет ускорена единым AssemblyScript/Wasm-ядром `planet-core` (`src/planet/assembly/kernels.ts` + `src/planet/planet-core-host.ts`, SIMD128, однопоточный Wasm без `SharedArrayBuffer`, так как на GitHub Pages нет COOP/COEP).
- Все внутренние адреса задаются от корня сайта; полнота маршрутов и хэшированных ассетов в `.publish/` контролируется `tools/verify_feature_parity.mjs` (И-6).
- Производные растровые файлы строятся в CI и не должны попадать в Git.
- Google Sheets — источник сведений; CSV в `data/` являются снимками, а не местом ручного редактирования.
- Существующие правила курсора, кнопок мыши, доступности и `prefers-reduced-motion` из `AGENTS.md` обязательны и для новых карт.
- Проект канонический: сгенерированная поверхность планеты должна быть явно обозначена как схематичная визуализация, если для неё нет канонической карты.

---
