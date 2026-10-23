/* PlanetGeographyConstants — константы версии географии и канонической
   частоты Земли (Stage-8.10b, A-12b).
   --------------------------------------------------------------------------
   Вынесены из site/shared/planet-geography.ts, чтобы модуль с полным
   Wasm-ядром (planet-noise / planet-core-host / planet-core-bytes) можно
   было динамически импортировать вне главного потока: эти константы не
   тащат за собой байты ядра. planet-geography.ts берёт их отсюда и
   по-прежнему отдаёт через объект PlanetGeography — внешние импорты
   не ломаются. */

/** Версия географии c100-soft-v1 (legacy-поля, И-1/И-2). */
export const GEOGRAPHY_VERSION = 'c100-soft-v1';

/** Каноническая частота сетки Земли (И-1): адресация только на canonicalV. */
export const EARTH_CANONICAL_V = 128;
