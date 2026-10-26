# Сектор: целевое состояние

>
> Источник: [`docs/stages/stage-9-12-sector-deep-render-plan.md`](../../stage-9-12-sector-deep-render-plan.md) · строки 1199–1227.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 14. Целевое состояние (чек-лист конечного вида)

**Не существует после волны `SW-2`:**

- `src/atlas/tile-pyramid.ts`, `state.rasterMode`, `CONFIG.tiles`, `CONFIG.markerLod`;
- `assets/tiles/**`, `assets/tiles.json`, `assets/map-preview.webp` в публикации;
- `assets/src/koprulu-sector.jpg` (исходник удалён, архивного эталона нет);
- `assets.hasRaster / preview / tiles / version` в `data/meta.json`;
- `SITE_LINKS.sectorMapPreview`;
- `build_tiles`, `PREVIEW_*`, `TILE_*` в `tools/build_assets.py`; соответствующие строки
  `.gitignore` и шаг кэша тайлов в `pages.yml`.

**Существует:**

- 13 секторных уровней `L0…L12` + `S0…S2` (номера `13…15`) с единым источником порогов;
- единица `1` ед = `1` св.г. и предел `0,002` св.г./px (`500` px/св.г., независимо от экрана);
- фактическая сетка адресов: два тира в кадре, одна толщина, без декоративного фона `80 px`;
- буквенный адрес `KP·REQHC[/c]` в readout, копировании, поиске, URL и досье;
- процедурное поле сектора (WebGL2 + Canvas2D-фолбэк) с детерминированным seed;
- `tools/verify_sector_address.mjs` в `check.yml`;
- маркер с непрерывным размером по глубине (`2,5 … 40 px`, показатель `0,3544`) и антислипанием;
- «карточка точки» по `Shift+клик`/долгому нажатию (адрес, `x`,`y`, ближайшая система, расстояние);
- админ-режим `?coords=1` с прежним `x<TAB>y`;
- отъезд до `minVisibleWidth = 16 000 св.г.` и «вся карта по ширине» на телефоне;
- честный системный кадр с пустыми состояниями и переходом в `/planet-globe/`;
- `verify:publish` `7/7`, `npm test` зелёный, `tsc --noEmit` и `eslint` чистые.

---
