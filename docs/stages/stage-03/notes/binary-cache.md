# Бинарный кэш топологии v1

>
> Источник: [`docs/stages/stage-3-geodesic-core.md`](../../stage-3-geodesic-core.md) · строки 224–303.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 7. Бинарный кэш топологии v1

### 7.1. Заголовок

Все числа little-endian независимо от хоста:

| Смещение | Тип | Значение |
|---:|---|---|
| 0..3 | bytes | `GEO\0` |
| 4..5 | `uint16` | format version = 1 |
| 6..7 | `uint16` | flags = 0 |
| 8..11 | `uint32` | endianness marker `0x01020304` |
| 12..15 | `uint32` | первые 32 бита SHA-256 канонического JSON метаданных |
| 16..19 | `uint32` | header length = 32 |
| 20..23 | `uint32` | payload length |
| 24..27 | `uint32` | CRC32C payload |
| 28..31 | `uint32` | `v` |

Канонический JSON имеет ровно отсортированные ключи
`{addressSchema, gridVersion, topologySchema, v}` без пробелов.

### 7.2. Payload

Первые 32 байта payload — layout v1, `v`, `cellCount`, `triangleCount`,
`cellCornersLength`, `bodyIndex`, `chunkBlockSteps`, резерв. Далее секции в
фиксированном порядке, каждая выровнена до 4 байт:

1. `centers` (`Float32`)
2. `corners` (`Float32`)
3. `triangles` (`Uint32`)
4. `cellCornerStart` (`Uint32`)
5. `cellCorners` (`Uint32`)
6. `neighbors` (`Int32`)
7. `neighborCount` (`Uint8`)
8. `areas` (`Float32`)
9. `addrFace` (`Uint8`)
10. `addrI` (`Uint16`)
11. `addrJ` (`Uint16`)

Chunk-метаданные в payload не дублируются: они детерминированно
восстанавливаются из канонических адресов и топологии при загрузке.

На little-endian хостах секции копируются байтовыми блоками; на big-endian
используется поэлементный `DataView` fallback. CRC32C считается
slicing-by-4 таблицами и сверен с контрольным вектором
`crc32c("123456789") = 0xe3069283`.

### 7.3. Поведение при ошибках

`deserializeGridCache(bytes, expectedMeta)` не бросает на битых данных. Он
возвращает `{ ok:false, reason }` при проблемах magic, версии, flags,
endianness marker, длины, `v`, `paramsHash`, CRC, границ секций или полной
валидации топологии.

`loadGridWithCache({ readCache, writeCache, rebuildGrid, expectedMeta })`:

- возвращает `{ grid, source:'cache' }` для валидного кэша;
- при miss/битом/старом кэше или ошибке чтения перестраивает сетку;
- после rebuild best-effort пишет новый бинарный кэш и не падает из-за квоты
  или ошибки записи;
- возвращает `{ grid, source:'rebuilt', reason }`.

Тестовый стенд и worker хранят этот формат в IndexedDB под новым префиксом
`gp-v1-bin:`. Старые structured-clone записи `gp-v0:` игнорируются.

## 8. Контракт данных Этапа 2

`tools/planet_generation.py`:

- новый дефолт `grid_version=goldberg-gp-v1`;
- явная историческая `goldberg-gp-v0` по-прежнему поддерживается валидатором;
- шум, география и пресеты пока остаются v0 до Этапа 4;
- golden `generation_key` для тестового профиля обновлён, потому что версия
  сетки входит в географический манифест:
  `PG1-Y6MQHGY72BADEFMKSV5KRH5B44`.

Живых профилей в `planet_generation` пока нет, поэтому миграция замороженных
ключей не требуется. Если позже появится профиль v0, смена его на v1 должна
идти новой ревизией, а не молчаливой заменой ключа.
