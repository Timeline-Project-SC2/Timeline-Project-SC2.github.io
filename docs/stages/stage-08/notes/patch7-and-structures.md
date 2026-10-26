# `Patch7`, 3D-рельеф и модули построек

>
> Источник: [`docs/stages/stage-8-local-map.md`](../../stage-8-local-map.md) · строки 1–146.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

Дата: 22 октября 2026 года. Волна **Stage-8** (`Tri-Agent Wave`,
`docs/agents_task_orchestration/agents_task_orchestration.md` §9).

## Результат

Навигационная цепочка атласа доведена от галактики и сектора до интерактивной
3D-сцены локального участка поверхности с процедурной урбанистикой на масштабе
до `1.2 км`:

```text
Галактика (/) → Сектор Копрулу (/sector/, /minimal/)
  → Планета (/planet-globe/?place=&system=&cell=)
  → Срез Patch7 (local-map-patch-v1, canonicalV)
  → 3D локальная карта (/planet-globe/?place=&system=&cell=&view=local, 1250 … 1.2 км)
```

Три потока волны разведены по файлам без пересечения (`Zero File Overlap`),
CLI-бенчмарк гейта **G4** и сводную документацию закрывает Воркер 3:

| Воркер | Поток | Файлы |
|---|---|---|
| 1 | Непрерывность рельефа и рек по И-3 в `local-map-worker.ts` (привязка к `Patch7`, LRU-кэш 8 участков, расширенный `LocalMapMeta`), порционная GPU-догрузка `StructureRenderer` по Патчу 8 без пересоздания VAO, тесты Этапа 8 | `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `src/local-map/local-map-shaders.ts`, `tests/local-map-stage8.test.mjs`, `package.json` |
| 2 | Интерактивный 3D-экран локальной карты и Dive-in переход в `/planet-globe/`, лестница масштабов `1250 … 1.2 км`, навигация по 6 соседям кольца и HUD | `site/planet-globe/index.html`, `site/planet-globe/planet-globe.css`, `site/planet-globe/planet-globe.ts` |
| 3 | CLI-бенчмарк гейта **G4** `tools/bench_local_map_stage8.mjs`, отчёт Этапа 8, актуализация `docs/PREPARATION_PLAN.md` и сводка волны в `docs/HANDOFF.md` + `CHANGELOG.md` | `tools/bench_local_map_stage8.mjs`, `docs/stages/stage-8-local-map.md`, `docs/PREPARATION_PLAN.md`, `docs/HANDOFF.md`, `CHANGELOG.md` |

---

## 1. Сшивка глобуса и локальной карты по 7 каноническим ячейкам `Patch7` (И-3)

Переход от сферической сетки Голдберга `goldberg-gp-v1` к касательной плоскости
участка опирается на чистый контракт `src/local-map/local-map-contract.ts`
(`LOCAL_MAP_PATCH_VERSION = 'local-map-patch-v1'`, Инварианты И-1 и И-3):

1. **Канонический срез 7 ячеек (`buildPatch7`):**
   - собирается строго на канонической сетке `canonicalV` (`EARTH_CANONICAL_V = 128`
     для Земли по И-1; пятиугольные полюсные ячейки автоматически привязываются
     к ближайшему шестиугольному соседу на стороне воркера глобуса);
   - содержит ровно 7 уникальных ячеек `[центр, соседи 0…5]` в порядке слотов
     `grid.neighbors`, их 3D-центры на единичной сфере и все гидрологические поля
     `c100-soft-v2` (`elevation`, `filledElevation`, `depressionDepth`, `muLand`,
     `slope`, `lakeId`, `lakeWeight`, `streamWeight`, `riverAccumulation`,
     `flowReceiver`).
2. **Координатное тождество (И-3.1):**
   - вокруг центральной ячейки строится ортонормированный касательный базис
     `TangentFrame` (`origin`, `east`, `north`, `radiusM`), где локальный север
     направлен к полюсу планеты (с защитой от вырождения на полюсах);
   - каждая точка `(u, v)` локального участка через обратную экспоненциальную
     карту `localPointToDirection(patch, u, v)` отображается в единичный 3D-вектор
     сферы `d = (x, y, z)` и опрашивает **тот же** 3D-сэмплер базовых полей
     `createPatchFieldSampler` / `samplePatchFields` (`planet-core` /
     `planet-geography.ts`), что исключает 2D-швы между глобусом и локальной картой.
3. **Тождество берега и уровня озёр (И-3.2):**
   - базовая высота участка привязана к `filledElevation` и `seaLevel`
     канонических ячеек (`patchBaseElevation`, `waterLevelOf`);
   - впадины priority-flood и озёра (`lakeWeight > 0`, включая переполняющиеся и
     терминальные озёра Этапа 5) удерживают уровень воды `filledElevation >= elevation`
     и не превращаются в сухие котловины на локальной карте.
4. **Топологическое тождество речного графа кольца (И-3.3):**
   - входы русел (`patch.river.inlets`) открываются строго со стороны граней
     соседей-источников, для которых `flowReceiver[nb] === centerCell`;
   - выход русла (`patch.river.outlet`) проходит строго через грань соседа
     `flowReceiver[centerCell]` (или равен `null` в терминальном озере/бессточной
     впадине), а мощность потока масштабируется по `riverAccumulation`
     (`flowAccumulationKm2`) и `streamWeight`;
   - в `src/local-map/local-map-worker.ts` рельеф `heightfield` ($256 \times 256$)
     привязан к каноническим высотам `Patch7`, вырезает русло вдоль цепочки
     `inlets → центр → outlet`, подмешивает 3D-деталь через `samplePatchFields`
     (при переданном `profile`), кэширует последние локальные участки в LRU-кэше
     (до 8 записей) и возвращает расширенные метрики `LocalMapMeta`
     (`totalInstances`, `buildableFraction`, `waterFraction`, `genMs`).
5. **Маска запрета застройки `buildingSpawnMask` (И-3.4):**
   - `buildBuildingSpawnMask(patch, resolution, rule)` по правилу
     `DEFAULT_BUILDING_SPAWN_RULE = { minLand: 0.5, maxSlope: 0.5 }` формирует
     жёсткий растр отбраковки `256 × 256`;
   - спавн 3D-построек строго запрещён (`spawnMask === 0`) в океане
     (`elevation < seaLevel`), на озёрах (`lakeWeight > 0`), в руслах рек
     (`streamWeight > 0`), на крутых горных склонах (`slope >= 0.5`) и на мокрой
     береговой кромке (`muLand < 0.5`);
   - самопроверка `verifyPatchInvariants(patch)` контролирует все 5 инвариантов
     (`patch7-shape`, `tangent-identity`, `flood-hold`, `river-topology`, `spawn-ban`)
     перед генерацией каждого участка.

---

## 2. Гибридный рендер 3D-рельефа и 12 low-poly модулей построек

Для масштаба вплоть до `~1.2 км` в пакете `src/local-map/*` реализован контракт
гибридного WebGL2-рендера (§9.5.1 `PREPARATION_PLAN.md` и RFC в `stage_patches.md`):

- **Непрерывная сетка рельефа ($256 \times 256$, `gl.UNSIGNED_INT`):**
  - прямой heightfield-дисплейсмент зданий отклонён — ландшафт рисуется гладкой
    регулярной сеткой `HEIGHTFIELD_RES = 256` ($65\,536$ вершин, $130\,050$
    треугольников, $390\,150$ индексов);
  - индексный буфер использует 32-битный тип `Uint32Array` (`gl.UNSIGNED_INT`),
    защищая сетку от переполнения 16-битного порога `65 536` вершин;
  - нормали вершин вычисляются центральными конечными разностями по полю высот;
  - чтобы исключить артефакт «висящего плоского плато» под базой, естественный
    рельеф сглаживается двухпроходным сепарабельным фильтром `boxBlurSeparable` и
    смешивается по гауссовой маске терраформинга:
    $h_{\text{final}} = \operatorname{mix}(h_{\text{natural}}, h_{\text{smoothed}}, \alpha_{\text{terraform}})$,
    после чего постройки ставятся основанием точно на $h_{\text{final}}$.
- **Библиотека из 12 нормализованных low-poly модулей (`src/local-map/local-map-mesh.ts`):**
  - `buildMeshLibrary()` конструирует 12 базовых мешей (`413` вершин, `412`
    треугольников, `12 384` байта суммарно; локальные индексы `Uint16Array`,
    `gl.UNSIGNED_SHORT`), распределённых по 4 функциональным зонам `ZONE_MODULES`:
    - **Зона 1 (жилая / лёгкая застройка):** `hab_box`, `container`, `comm_mast`;
    - **Зона 2 (промышленный сектор):** `factory`, `silo_tank`, `pipe_stack`, `cargo_bay`;
    - **Зона 3 (оборонный периметр):** `guard_tower`, `barrier`, `radar_dish`;
    - **Зона 4 (командное ядро):** `hq_center`, `dome_vault`.
- **Компактный инстансинг (`gl.drawElementsInstanced`, 32 байта на инстанс):**
  - расстановка `scatterInstances` работает по детерминированной jittered-сетке
    с проверкой границ зон (inset), маски `buildingSpawnMask` и жёстким бюджетом
    `MAX_INSTANCES = 4096`;
  - каждый инстанс упакован в 8 чисел `float32` (`32 байта`, `stride = 32`,
    `vertexAttribDivisor = 1`):
    - `location 2` (`a_inst_pos_yaw`): `vec4(x, y, z, yaw)`;
    - `location 3` (`a_inst_scale_tint`): `vec4(sx, sy, sz, packed_tint)`, где
      RGBA-оттенок упакован `packTint` в биты `uint32` и распаковывается в
      `STRUCTURE_VERTEX_SHADER` через `floatBitsToUint`;
  - матрица модели `T * R_z * S` и матрица нормалей собираются на лету в вершинном
    шейдере; буферы передаются из воркера через `Transferable` (`localMapTransferables`).
- **Данные текстур и круговой туман (`src/local-map/local-map-shaders.ts`):**
  - `t_zoning` (`ZONE_RES = 64`): целочисленная текстура `gl.RG8UI` (`usampler2D`)
    со строгой фильтрацией `GL_NEAREST` (канал `R` — код зоны `0..4`, канал `G` —
    плотность `0..255`, без размытия enum-границ);
  - `t_terraform` (`TERRAFORM_RES = 256`): одноканальная текстура `gl.R8`
    (`sampler2D`) с линейной фильтрацией `GL_LINEAR` для плавного смешивания грунта
    базы с природной поверхностью;
  - края расчётного квадрата скрываются круговым туманом (**Circular Distance Fog**,
    `u_fogStart = 0.75 * R_gen`, `u_fogEnd = R_gen`) и в шейдере террейна, и в
    шейдере 3D-структур (с мягким контактным затенением AO у основания зданий).

> **Примечание (эволюция в Stage-8.1 … Stage-8.6):** в последующих волнах
> (`PR #169`, `#171`, `#176–#194`) квадратный меш $257 \times 257$ обрезается во
> фрагментном шейдере по контуру одного центрального гекса
> (`centerHexDist <= 0.8054 * R_patch`), а круговой туман на границе квадрата
> заменён непрерывной 10-кольцевой сферической юбкой горизонта (`145 × 85 = 12 325`
> вершин) и непрозрачным дневным куполом неба; в `TERRAIN_FRAGMENT_SHADER`
> добавлены явный водный маркер сквозных рек (`terraformMap = 0`), 5 метрических
> гипсометрических поясов суши и объёмная батиметрия воды — см. раздел 7 ниже и
> подробный отчёт [`STAGE_8_PLANETARY_HORIZON.md`](../../STAGE_8_PLANETARY_HORIZON.md).

---
