/* PlanetGeographyConstants — константы версии географии и канонической
   частоты Земли (Stage-8.10b, A-12b).
   --------------------------------------------------------------------------
   Вынесены из site/shared/planet-geography.ts, чтобы модуль с полным
   Wasm-ядром (planet-noise / planet-core-host / planet-core-bytes) можно
   было динамически импортировать вне главного потока: эти константы не
   тащат за собой байты ядра. planet-geography.ts берёт их отсюда и
   по-прежнему отдаёт через объект PlanetGeography — внешние импорты
   не ломаются. */

/** Версия географии c100-soft-v3 (W28: контраст поля +5*d^2 / -0.65*d; W28b: версия поля). */
export const GEOGRAPHY_VERSION = 'c100-soft-v3';

/** Каноническая частота сетки Земли (И-1): адресация только на canonicalV. */
export const EARTH_CANONICAL_V = 128;

// W28/W28b: единая формула контраста поля — суша квадратично, океан линейно.
// planet-geography.ts и planet-elevation-field.ts берут отсюда;
// src/planet/assembly/kernels.ts дублирует числами с комментарием синхронизации.
export const CONTRAST_LAND_PIVOT = 0.40;
export const CONTRAST_LAND_GAIN = 5.0;
export const CONTRAST_OCEAN_PIVOT = 0.12;
export const CONTRAST_OCEAN_SCALE = 0.65;
