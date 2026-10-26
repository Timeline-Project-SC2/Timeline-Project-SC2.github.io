# Волна F: цели, инвентарь, матрица файлов и контракт

> Источник: `agents_task_orchestration.md`, строки 2098–2291 (редакция до разукрупнения).
> Назад: [оркестрация](../agents_task_orchestration.md) · [этапы](../../stages/README.md) · [документация](../../README.md).

## 18. Матрица волны `F` — последние правки по сектору (версия 4.0 гайдлайнера, 26.10.2026)

Дата постановки: **26 октября 2026 года**. Статус: **волна открыта**, кодовых PR нет.
Источник чисел — гайдлайнер [`../stages/stage-9-12-sector-deep-render-plan.md`](../../stages/stage-9-12-sector-deep-render-plan.md)
**версии 4.0**: §6 (лестница `L0…L12`, маркер, полёт), §7.2 (тиры `T0…T7`), §11 (гейты
`G7.1…G7.15`), §12.1 (состав и оценки волны), §16 (единица, предел, лестница), §17 (решения
редакции, фактическая сетка). Этот раздел фиксирует **только матрицу файлов, контракт до буквы
и порядок**, числа не дублирует.

### 18.1. Цель и границы

Сектор закрывается: рантайм приводится к решениям владельца от 26.10.2026 (`1` единица = `1` св.г.,
предел `0,002` св.г./px, 13 секторных уровней `L0…L12`, фактическая сетка «старший тир + один
вложенный»), снимаются видимые дефекты стрелок и незакрытые долги `SW-3F`/`SW-5`.

**Входит:** `Z-5` (единица, предел, лестница), `Z-4e` (территории на глубине), `Z-4f` (сетка и
тиры `T6/T7`), `Z-2` (пять дефектов стрелок + единицы в подписях), монтаж `#systemFrame`,
приёмка и документация.

**Не входит:** планетарный контур (`И-11`: `src/planet/*`, `src/local-map/*`, `site/planet-globe/*`,
`site/shared/planet-*`, `data/planet-generation.csv`); `data/*.csv` и `data/meta.json`; растр
галактики и маршрут `/`; новые слои `Z-3.1`/`Z-3.2` (их файлы свободны, но монтаж — волна `G`);
переписывание зума и клика (`Z-1`) — волна `G`.

### 18.2. Инвентарь: что именно правится (проверено по `main = 6e47701`)

| Файл | Строки | Что держит сейчас | Что станет |
|---|---|---|---|
| `src/atlas/sector-units.ts` | `4` | `UNITS_PER_LY = 1000` | `1`; новый `TARGET_LY_PER_PX = 0,002` |
| `src/atlas/level-ladder.ts` | `22` | `DEEPEST_SECTOR_LEVEL = 9` | `12` |
| | `26…34` | `TARGET_WIDTH_LY = 1`, `sectorWidth(n) = 10000 / 10^(n/9)` | `LEVEL_STEP = 1,9194`, `sectorWidth(n) = 10 000 / 1,9194^n`; `TARGET_WIDTH_LY` удаляется |
| | `37…165` | `LEVELS`: 10 секторных + `S0…S2` (`13…15`) | 13 секторных `L0…L12` + те же `S0…S2` |
| | `242` | `MARKER_EXPONENT = 1,1374` | `0,3544` |
| | `373…390` | `maxScaleForTargetWidth(viewport, mapSize, fitInset) = viewport.w / lyToUnits(1)` | `MAX_SCALE = 1 / TARGET_LY_PER_PX = 500`; функция сохраняет сигнатуру и возвращает `MAX_SCALE` |
| | `276…292` | `DEEP_LAYER_FIRST_LEVEL = 2`, альфа до `DEEPEST_SECTOR_LEVEL` | те же формулы, диапазон `L2…L12` получается сам |
| `src/atlas/sector-scene.ts` | `193` | `APERTURE_FIRST_LEVEL = 9` | `12` |
| | `196…197` | `GRID_FIRST_LEVEL = 1`, `GRID_LAST_LEVEL = 9` | `0` и `12` |
| | `211…213` | `GRID_TIER_BY_LEVEL = [null,1,1,2,2,2,2,3,3,3]` | **удаляется**, тир считает `gridTiersFor(scale)` |
| | `507…594` | `gridFor` — один тир, подпись из `spec.addressLetters` | два тира (`t`, `t+1`), подпись глубиной `t` |
| | `780…810` | `loupeGridFor` берёт базу из `GRID_TIER_BY_LEVEL` | база — из `gridTiersFor(scale)` |
| `src/atlas/canvas-renderer.ts` | `611…620` | `drawGridLine`: `1 px`, `rgba(150,180,215,.10)` | альфа из примитива: `0,16` старший / `0,07` вложенный |
| | `623…632` | `drawGridLabel`: `9 px`, заливка `rgba(160,186,216,.42)`, `+3/+3` | контур `strokeText` `2 px` + заливка; позиция та же |
| | `1485…1486` | диспетчер примитивов `grid.line` / `grid.label` | без изменений по видам |
| `src/atlas/faction-net.ts` | `57…70` | `NET_LAYER_LEVELS = [2…9]` | `isNetLayerLevel(level) = layerFillAlpha(level) > 0` (единственный источник — лестница) |
| `site/shared/styles.css` | `35`, `329` | `.map-grid-overlay`: шаг `80 px` / `56 px`, `opacity .12` | **удаляется** |
| `site/shared/timeline-skin.css`, `site/shared/wiki-skin.css` | `242`, `86` | переопределения `.map-grid-overlay` | **удаляются** |
| `templates/atlas-shell.html` | `60` | `<div class="map-grid-overlay" aria-hidden="true"></div>` | **удаляется** |
| `src/atlas/sector-address.ts` | `1`, `18…25` | `AddressLetters = 0…5`, `ADDRESS_TIERS = T0…T5` | `0…7`, `+ T6 = 0,64`, `T7 = 0,128` |
| | `96…120` | `parseAddress` — ровно `5` букв (`/^[A-Y]{5}$/`) | `5…7` букв; канон остаётся `5` |
| `src/atlas/sector-arrows.ts` | `114` | `--arrow-angle = angle + π` для **всех** стрелок | `+π` только для `item.visible` |
| | `132`, `140` | `host.replaceChildren(fragment)` каждые `250` мс | инкрементальный апдейт, полная пересборка — только при смене набора |
| `site/shared/styles.css` | `340…352` | подпись `.sector-arrow-copy` c `min-width: max-content` | подпись выравнивается по квадранту и не выходит за инсет |
| `src/atlas/coords-readout.ts` | `115`, `281` | тексты «`0,28 св.г. до границы`» | тексты предела версии 4.0 (`0,002 св.г./px`, `500 px/св.г.`) |
| `tools/verify_sector_core.mjs` | `10`, `102…111`, `235` | проверяет 10 уровней и `addressLetters ≤ 5` | проверяет 13 уровней и допустимые `addressLetters` без изменения поля |

### 18.3. Матрица файлов (`Zero File Overlap`)

Волна **последовательная** (§12.1 гайдлайнера): `sector-scene.ts`, `canvas-renderer.ts`,
`site/shared/styles.css` и `templates/atlas-shell.html` — общие файлы, поэтому тройка
`Tri-Agent Wave` здесь запрещена, а не «нежелательна».

| Карточка | Роль | `OWNED_FILES` | Запрещено |
|---|---|---|---|
| **F-1 `Z-5`**<br>единица, предел, лестница | `rc-01` + `rc-04` | `src/atlas/sector-units.ts`<br>`src/atlas/level-ladder.ts`<br>`src/atlas/sector-scene.ts`<br>`src/atlas/coords-readout.ts`<br>`src/atlas/dossier-card.ts`<br>`src/atlas/sector-arrows.ts`<br>`src/atlas/sector-flight.ts`<br>`src/atlas/catalog-panel.ts`<br>`tools/verify_sector_core.mjs`<br>`tests/sector-units.test.mjs`<br>`tests/sector-ladder.test.mjs`<br>`tests/canvas-zoom-clamp.test.mjs`<br>`tests/coords-readout.test.mjs`<br>`tests/sector-arrows.test.mjs`<br>`tests/sector-field.test.mjs`<br>`tests/sector-flight.test.mjs`<br>`tests/sector-scene.test.mjs`<br>`tests/system-frame.test.mjs` | `canvas-renderer.ts`, `faction-net.ts`, `sector-address.ts`, `app.ts`, `site/*`, `templates/*`, `docs/*`, `CHANGELOG.md` |
| **F-2 `Z-4e`**<br>территории на глубине | `rc-01` + `rc-03` | `src/atlas/canvas-renderer.ts`<br>`src/atlas/faction-net.ts`<br>`tests/faction-net.test.mjs` | всё остальное, включая `sector-scene.ts` и `site/*` |
| **F-3 `Z-4f`**<br>фактическая сетка | `rc-01` + `rc-03` | `src/atlas/sector-address.ts`<br>`src/atlas/sector-scene.ts`<br>`src/atlas/canvas-renderer.ts`<br>`site/shared/styles.css`<br>`templates/atlas-shell.html`<br>`tests/sector-address.test.mjs`<br>`tests/sector-scene.test.mjs`<br>`tests/sector-grid.test.mjs` *(новый)*<br>`tools/verify_sector_address.mjs`<br>`package.json` *(только строка `npm test`)* | `level-ladder.ts`, `app.ts`, `docs/*` |
| **F-4 `Z-2`**<br>стрелки и единицы | `rc-03` + `rc-04` | `src/atlas/sector-arrows.ts`<br>`src/atlas/dossier-card.ts`<br>`site/shared/styles.css`<br>`tests/sector-arrows.test.mjs`<br>`tests/sector-flight.test.mjs` | `sector-scene.ts`, `canvas-renderer.ts`, `templates/*`, `docs/*` |
| **F-5**<br>монтаж `#systemFrame` | `rc-01` + `rc-03` | `src/atlas/app.ts`<br>`src/atlas/system-frame.ts`<br>`templates/atlas-shell.html`<br>`site/shared/styles.css`<br>`tests/system-frame.test.mjs`<br>`tests/place-types.test.mjs` | `canvas-renderer.ts`, `sector-scene.ts`, `sector-arrows.ts`, `docs/*` |
| **F-6**<br>приёмка и документация | `rc-04` + `rc-06` + `rc-07` | `CHANGELOG.md`<br>`docs/HANDOFF.md`<br>`docs/stages/stage_patches.md`<br>`docs/ADMIN_GUIDE.md`<br>`docs/PREPARATION_PLAN.md` *(только шапка и строка статуса)*<br>`docs/stages/stage-9-12-sector-deep-render-plan.md` *(только §16.7/§16.8 и Приложение C)*<br>`README.md` | код `src/atlas/*`, `site/*`, `templates/*` |

**Правило первого коммита.** Каждая карточка начинается с коммита в **свой целевой файл**
(`F-1` → `src/atlas/sector-units.ts`, `F-2` → `src/atlas/faction-net.ts`, `F-3` →
`src/atlas/sector-address.ts`, `F-4` → `src/atlas/sector-arrows.ts`, `F-5` →
`src/atlas/system-frame.ts`, `F-6` → `CHANGELOG.md`) и сразу пушится (`git push -u origin HEAD`).

### 18.4. Контракт до буквы (`Interface-First`)

**F-1 · `src/atlas/sector-units.ts`**

~~~~text
export const NBSP: string;                       // ' ', без изменений
export const UNITS_PER_LY = 1;                   // 1 единица карты = 1 св.г.
export const TARGET_LY_PER_PX = 0.002;           // предел: св.г. на CSS-пиксель
export function unitsToLy(u: number): number;    // u / UNITS_PER_LY
export function lyToUnits(ly: number): number;   // ly * UNITS_PER_LY
export type DistanceMode = 'full' | 'short' | 'label';
export function formatDistanceLy(ly: number, mode?: DistanceMode): string;
export function pluralYears(n: number): 'год' | 'года' | 'лет';
export function formatAngleDeg(rad: number): string;
~~~~

**F-1 · `src/atlas/level-ladder.ts`**

~~~~text
export const MAX_VISIBLE_WIDTH = 10000;
export const MIN_VISIBLE_WIDTH = 16000;
export const HYSTERESIS = 0.12;
export const LEVEL_STEP = 1.9194;                // новое
export const DEEPEST_SECTOR_LEVEL = 12;
export const MAX_SCALE = 1 / TARGET_LY_PER_PX;   // 500 px/св.г., новое
export const MARKER_EXPONENT = 0.3544;
export const LAYER_FADE_STEP = 0.75;
export const LAYER_FILL_ALPHA_MIN = 0.25;
export const LAYER_LINE_ALPHA_MIN = 0.45;
export const DEEP_LAYER_FIRST_LEVEL = 2;
export interface LevelSpec {
  readonly level: number;      // 0…12, 13…15 для S0…S2
  readonly id: string;         // 'L0'…'L12' | 'S0'…'S2'
  readonly frame: 'S' | 'O';
  readonly visibleWidth: number;   // в св.г. для S, в а.е. для O
  readonly addressLetters: 0 | 1 | 2 | 3 | 4 | 5;   // без изменений: сетка его больше не использует
  readonly markerPx: number;
  readonly frameBudgetMs: number;
}
export function levelSpec(level: number): LevelSpec;
export function frameOf(level: number): 'S' | 'O';
export function visibleWidthForLevel(level: number): number;
export function visibleWidthLyForLevel(level: number): number;   // псевдоним, без деления на 1000
export function levelForWidth(visibleWidth: number, prev?: number): number;  // 0…12
export function markerDiameter(visibleWidth: number): number;
export function maxScaleForTargetWidth(
  viewport: FrameViewport, mapSize: number, fitInset: number,
): number;                                        // возвращает MAX_SCALE, сигнатура сохранена
export function minScale(): number;
export function edgeDistance(viewport: FrameViewport, scale: number): number; // справочная
export function layerFillAlpha(level: number): number;
export function layerLineAlpha(level: number): number;
// УДАЛЯЕТСЯ: export const TARGET_WIDTH_LY
~~~~

**F-1 · `src/atlas/sector-scene.ts`** — `export const APERTURE_FIRST_LEVEL = 12;` и
`export const GRID_LAST_LEVEL = 12;` (оба уже экспортированы, меняется только значение);
`aperturesFor` возвращает кольца **только** на `L12`.

**F-2 · `src/atlas/faction-net.ts`** — `NET_LAYER_LEVELS` **удаляется**; вместо него:

~~~~text
export function isNetLayerLevel(level: number): boolean;   // layerFillAlpha(level) > 0
export function netsAtLevel(nets: readonly FactionNet[], level: number): readonly FactionNet[];
~~~~

Поведение: `true` на `L2…L12`, `false` на `L0…L1` и на `S0…S2`. Своей таблицы уровней в
`faction-net.ts` больше нет (инвариант `И-8`: пороги уровней живут только в `level-ladder.ts`).

**F-3 · `src/atlas/sector-address.ts`**

~~~~text
export type AddressLetters = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;     // было 0…5
export interface AddressTier { readonly id: string; readonly name: string; readonly cellSize: number; }
export const ADDRESS_TIERS: readonly AddressTier[];   // T0…T7: 10000/2000/400/80/16/3.2/0.64/0.128
export function addressOf(x: number, y: number): SectorAddress;          // по-прежнему 5 букв
export function prefixOf(x: number, y: number, letters: AddressLetters): SectorAddress;
export function rectOf(address: SectorAddress | string): { x: number; y: number; size: number };
export function centerOf(address: SectorAddress | string): { x: number; y: number };  // центр ячейки длины адреса
export function parseAddress(text: string): SectorAddress | null;        // принимает 5, 6 и 7 букв
export function formatAddress(addr: SectorAddress | string, style?: 'compact' | 'expanded'): string;
~~~~

**F-3 · `src/atlas/sector-scene.ts`**

~~~~text
export interface GridTiers { readonly primary: number; readonly nested: number; }  // индексы в ADDRESS_TIERS
export function gridTiersFor(scale: number): GridTiers;   // новый, чистая функция
// правило: старший тир t — минимальный индекс i ≥ 1, у которого
//          ADDRESS_TIERS[i].cellSize * scale <= GRID_CELL_MAX_PX  (450)
//          и ADDRESS_TIERS[i + 1].cellSize * scale >= GRID_CELL_MIN_PX (16)
export const GRID_CELL_MAX_PX = 450;
export const GRID_CELL_MIN_PX = 16;
export interface SceneGridLine {
  readonly kind: 'grid.line';
  readonly tier: string;            // 'T1'…'T7'
  readonly cellSize: number;
  readonly alpha: number;           // новое: 0.16 старший / 0.07 вложенный
  readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number;
}
// УДАЛЯЕТСЯ: export const GRID_TIER_BY_LEVEL
~~~~

**F-3 · `src/atlas/canvas-renderer.ts`** — `drawGridLine` берёт `line.alpha`, толщина всегда
`1 px`; `drawGridLabel` рисует `strokeText` (`2 px`, `rgba(6,10,18,.85)`) и затем `fillText`
(`rgba(160,186,216,.42)`), позиция `+3/+3` не меняется.

**F-4 · `src/atlas/sector-arrows.ts`** — `--arrow-angle` = `angle` для внешних целей и
`angle + Math.PI` для `item.visible`; инсет `ARROW_INSET_DESKTOP = 66` и
`ARROW_INSET_MOBILE = 54` (шеврон `44` + подпись `≈ 22` + `safe-area`); обновление — по
`data-system-id` без пересоздания узлов, полная пересборка только при смене набора;
`.sector-arrow-count` уезжает в безопасную зону `layoutMapControls`. Подпись и счётчик
печатаются только через `formatDistanceLy(..., 'label')`.

**F-5 · `src/atlas/system-frame.ts`** — контракт не меняется; монтаж:
`createSystemFrame(kernel)` вызывается из `app.ts` после `buildSectorScene`, слой
`#systemFrame` объявлен в `templates/atlas-shell.html` и `site/shared/styles.css`
(`z-index` выше `#mapCanvas`, `pointer-events: none` на контейнере, `auto` на карточке).
