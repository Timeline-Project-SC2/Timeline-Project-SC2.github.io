# Stage-8.4: 10 колец и скольжение камеры

>
> Источник: [`docs/stages/STAGE_8_PLANETARY_HORIZON.md`](../../STAGE_8_PLANETARY_HORIZON.md) · строки 147–237.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 5. Stage-8.4 · 10 колец прогрузки и плавное скольжение камеры

Срез волны **Stage-8.4**: прогрузка местности вокруг активного гекса расширена
до **10 колец гексов** (полярная сетка юбки **145 × 85** вместо 97 × 57 —
зона кодовых потоков волны в `src/local-map/*`), а рантайм `/planet-globe/`
(`site/planet-globe/planet-globe.ts`) согласовывает с ней туман, HUD,
клик/панорамирование и бесшовный перелёт камеры между каноническими гексами.

### 5.1. Отсутствие шва и размытия на первых 3–4 кругах гексов

- Старт тумана поднят в `renderLocalMapFrame()` и `drawLocalMapFallback()`:
  `fogStart = skirt ? skirt.outerRadiusM * 0.64 : localMapRadiusM * 0.85`
  (вместо `0.58`); `fogEnd = skirt.outerRadiusM * 0.98` без изменений.
  При расширенной прогрузке первые **3–4 круга гексов** вокруг активного
  остаются полностью прозрачными и детальными: дымка начинается только за ними,
  поэтому граница Patch7 не читается швом, а ближняя долина не размывается.
- HUD показывает реальное число колец горизонта: `updateLocalMapHud()`
  вычисляет его из фактических данных юбки вместо хардкода «6 колец» —
  `const ringsLabel = Math.round(skirt.outerRadiusM / Math.max(1, skirt.hexSpacingM));`,
  формат строки статуса:
  `` `${ringsLabel} колец · R ${fmtNum(skirt.outerRadiusM / 1000, 1)} км (Δz ${fmtNum(horizonDropM / 1000, 2)} км)` ``.

### 5.2. Плавное скольжение камеры от гекса к гексу

Прежний `requestLocalNeighbor()` мгновенно обнулял `localCameraTarget[0..1]`,
из-за чего кадр дёргался **до** прихода нового патча, а перелёт принудительно
возвращал взгляд к `LOCAL_REST_YAW`. Начиная со Stage-8.4:

- `pendingNeighborFly` расширен полями
  `prevTargetOffset?: [number, number, number]`, `prevYaw?: number`,
  `prevPitch?: number`, `prevDist?: number`;
- `requestLocalNeighbor(neighbor, azimuth)` **не** сбрасывает точку прицела:
  текущие `localCameraTarget`, `localCameraYaw`, `localCameraPitch` и
  `localCameraDistance` запоминаются в `pendingNeighborFly`, а старый патч
  продолжает рисоваться прежним кадром — без рывка;
- `finishLocalMapEntry()` при совпадении `pendingNeighborFly.cell` с центром
  прибывшего патча восстанавливает сохранённое состояние камеры после
  `resetLocalCamera()` и запускает `startLocalNeighborFlyAnim(azimuth)`;
- `startLocalNeighborFlyAnim(azimuth)` — перелёт **820 мс** (вместо 650 мс)
  по симметричной плавной кривой `easeInOutCubic` (`easeInOut: true`):
  - `toTarget` — новая высота центра `centerZ` из `localMapData?.heightfield`
    плюс сдвиг вперёд `forwardOffset = localMapRadiusM * 0.14` вдоль текущего
    `localCameraYaw` (та же формула, что и в `resetLocalCamera()`);
  - `fromTarget` — со стороны предыдущего гекса:
    `offset = localMapRadiusM * 1.05` строго против направления перехода
    `azimuth` (`[-sin(azimuth) · offset, -cos(azimuth) · offset, targetZ]`);
  - `fromYaw = toYaw = localCameraYaw`: пользовательский азимут взгляда
    сохраняется — камера **не** принуждается крутиться обратно к
    `LOCAL_REST_YAW`, если пользователь сам повернул взгляд;
  - наклон плавно возвращается к панорамному покою
    (`fromPitch = localCameraPitch → toPitch = LOCAL_REST_PITCH`),
    дистанция камеры на время перелёта неизменна.

Итог: смена патча и движение точки прицела сливаются в одно непрерывное
скольжение — камера «уезжает» со стороны предыдущего гекса к новому центру,
не теряя ни высоту взгляда, ни пользовательский поворот, ни зум.

### 5.3. Панорамирование, клик и зум под расширенную долину

| Параметр | Было (Stage-8.3) | Стало (Stage-8.4) |
|---|---|---|
| `applyLocalPan`: радиус свободного панорамирования без сброса (`maxPan`) | `1.35 · R` | `2.4 · R` |
| `applyLocalPan`: порог автоперехода на соседний гекс | `0.88 · R` | `1.15 · R` |
| `pickLocalNeighborAt`: внешний радиус клика по соседним гексам | `2.6 · R` | `4.2 · R` |
| `localMaxCameraDistance()`: верхний предел отдаления камеры | `5.8 · R` | `7.5 · R` |

Порог автоперехода `1.15 · R` согласован с шагом центров гексов
`d_hex = 1.15 · R_patch`: панорамирование до кромки соседнего гекса запускает
бесшовный переход, и пользователь может плавно двигаться по всей долине и за её
пределы. Радиус клика `4.2 · R` покрывает 3–4 видимых круга гексов вокруг
активного, а отдаление до `7.5 · R` позволяет окинуть взглядом и ближние круги,
и дальний 10-кольцевой горизонт.

### 5.4. Проверки волны Stage-8.4

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint site src
npm test                 # node --test (включая local-map-stage8.test.mjs)
npm run build            # tsc --noEmit + Vite -> .publish/
npm run verify:publish   # 7 маршрутов, build-manifest.json, паритет экспортов
git diff --check
```

На визуальную приёмку владельца остаются: непрерывность перелёта при переходе
от гекса к гексу (нет рывка кадра до прихода патча, пользовательский yaw не
сбрасывается), прозрачность и детализация первых 3–4 кругов гексов при
10-кольцевой прогрузке и честное число колец в статусе `localFogStatus`.

---
