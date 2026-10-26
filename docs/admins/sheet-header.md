# Заголовок таблицы профилей и правила заполнения

> Колонки после заморозки схемы.
> Источник: [`docs/PREPARATION_PLAN_ADMINS.md`](../PREPARATION_PLAN_ADMINS.md) · строки 635–655.
> Назад: [карта документации](../README.md) · [индекс документации](../README.md).

## 15. Заголовок таблицы профилей

> **Статус:** этот заголовок реализован в коде Этапа 2, лежит в шаблоне вкладки и действует на живом листе `planet_generation` (`gid=1183479406`), подключённом в `data/sources.json`. Боевые версии генератора `v1` и `c100-soft-v2` уже в строю, пресеты откалиброваны, поэтому заполнять профили и ставить `frozen` можно по обычному рабочему процессу (массовое наполнение каталога до 500 планет остаётся планом Этапа 11).

```csv
place_id,profile_status,profile_revision,preset_id,surface_class,radius_km,axial_tilt_deg,rotation_period_hours,palette_id,master_seed_hex,grid_version,noise_version,geography_version,preset_version,generation_key,approved_by,approved_at,continent_mean_cells,continent_variation,ocean_basin_mean_cells,drainage_mean_cells,ocean_pctl,shelf_below_pctl,shelf_above_pctl,highland_land_pctl,mountain_land_pctl,arid_land_pctl,wet_land_pctl,cold_pctl,hot_pctl,stream_flow_pctl,major_river_flow_pctl,coast_soft_width_cells,continent_soft_width_cells,biome_soft_width_cells,transition_entropy_pctl,notes_admin
```

### Правила заполнения после заморозки схемы

- Первая строка — только заголовки.
- Не добавлять поясняющие строки внутрь опубликованного диапазона.
- Типы и статусы писать латиницей строчными буквами.
- Дробные числа — с точкой: `1.5`, а не `1,5`.
- В `notes_admin` не использовать переносы строк.
- Пустая необязательная ячейка означает значение пресета.
- `place_id`, seed и ключ форматировать как текст.
- Не редактировать `data/planet-generation.csv` вручную.

---
