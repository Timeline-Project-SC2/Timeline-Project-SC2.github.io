# Приложения: CSV, derived-адреса, глоссарий

> Справочные примеры и глоссарий.
> Источник: [`docs/PREPARATION_PLAN.md`](../PREPARATION_PLAN.md) · строки 1754–1800.
> Назад: [карта документации](../README.md) · [индекс документации](../README.md).

## 16. Приложения

### 16.1. Пример заголовка будущего CSV

```csv
place_id,profile_status,profile_revision,preset_id,surface_class,radius_km,axial_tilt_deg,rotation_period_hours,palette_id,master_seed_hex,grid_version,noise_version,geography_version,preset_version,generation_key,approved_by,approved_at,continent_mean_cells,continent_variation,ocean_basin_mean_cells,drainage_mean_cells,ocean_pctl,shelf_below_pctl,shelf_above_pctl,highland_land_pctl,mountain_land_pctl,arid_land_pctl,wet_land_pctl,cold_pctl,hot_pctl,stream_flow_pctl,major_river_flow_pctl,coast_soft_width_cells,continent_soft_width_cells,biome_soft_width_cells,transition_entropy_pctl,notes_admin
```

Этот заголовок реализован на Этапе 2 в `tools/planet_generation.py`, снимке `data/planet-generation.csv` и шаблоне вкладки. Живая вкладка `planet_generation` (`gid=1183479406`) уже подключена в `data/sources.json` и синхронизируется двухфазным `tools/sync.py` (строгий режим `--strict`); актуальная административная процедура — в `ADMIN_GUIDE.md` и отчёте Этапа 2.

### 16.2. Пример derived-адресов

```text
Планета:  place_id=2, generation_key=PG1-...
Ячейка:   goldberg-gp-v1/w0/v128/f07/a18/b31
Область:  region seed = та же ячейка + geography_version
Участок:  center cell + projection v1 + zoom 8 + tile 131/87
```

### 16.3. Глоссарий

- **Ячейка** — одна грань сетки Голдберга; обычно шестиугольная, 12 ячеек планеты пятиугольные.
- **Физический массив суши** — связная область, где суша преобладает над океаном при выбранном пороге.
- **Континентальная идентичность** — мягкий регион влияния C100, не обязанный совпадать с физическим массивом.
- **Эффективная масса** — сумма весов принадлежности, выраженная в эквиваленте ячеек.
- **Процентиль** — порог, ниже которого находится заданная доля площади распределения.
- **Пресет** — версионированный набор значений по умолчанию.
- **Эффективный манифест** — профиль после раскрытия всех пресетов и пустых значений.
- **`generation_key`** — хэш эффективного манифеста и версий генератора.
- **Статификация / freeze** — запрет молчаливого изменения принятой географии; уровень гарантии зависит от L1, L2 или L3.
- **Агенто-час** — час активной работы кодирующего агента без ожидания человека.

### 16.4. Связанные документы текущего репозитория

- [`README.md`](../../README.md) — текущее описание сайта.
- [`ADMIN_GUIDE.md`](../ADMIN_GUIDE.md) — действующие правила Google Sheets.
- [`stages/stage-data-model.md`](../stages/stage-data-model.md) — текущая модель систем и мест.
- [`stages/stage_patches.md`](../stages/stage_patches.md) — живой журнал фактических решений, открытых вопросов и истории этапов.
- [`stages/stage-1-spike-report.md`](../stages/stage-1-spike-report.md) — отчёт спайка глобуса.
- [`stages/stage-2-data-and-sync.md`](../stages/stage-2-data-and-sync.md) — отчёт по данным `planet_generation`, валидатору и синку.
- [`stages/stage-7-planet-page.md`](../stages/stage-7-planet-page.md) — отчёт Этапа 7 (страница планеты, бесшовный зум и переход из атласа сектора).
- [`stages/stage-8-local-map.md`](../stages/stage-8-local-map.md) — отчёт Этапа 8 (локальная 3D-карта, порционная GPU-догрузка и гейт G4).
- [`stages/STAGE_8_PLANETARY_HORIZON.md`](../stages/STAGE_8_PLANETARY_HORIZON.md) — отчёт итераций Stage-8.1 … Stage-8.7 (купол неба, 10 колец горизонта 145×85, фиксированный физический масштаб гекса, межъячеечная синхронизация, батиметрия, сквозные реки, ориентация камеры по Северу, кольцевые LOD-области 1–5, ре-бейзинг камеры и квик-стрелки).
- [`stages/stage-9-vegetation-atlas.md`](../stages/stage-9-vegetation-atlas.md) — отчёт проектирования Этапа 9 (сравнение методов смены местности и растительности, матрица растительных биомов, каналы тайла, `heightBlend` и UV-лестница).
- [`prompts/stage-9-vegetation-tiles.md`](../prompts/stage-9-vegetation-tiles.md) — пакет промптов генерации бесшовных тайлов растительности (T1a, T1b, T2…T7) с техническими инвариантами и критериями приёмки.
- [`HANDOFF.md`](../HANDOFF.md) — рабочий конспект проекта.
- [`AGENTS.md`](../../AGENTS.md) — обязательные технические правила для будущих изменений.
