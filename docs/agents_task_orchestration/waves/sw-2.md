# Волна SW-2: цели, решения, инвентарь и контракт поля

> Источник: `agents_task_orchestration.md`, строки 685–874 (редакция до разукрупнения).
> Назад: [оркестрация](../agents_task_orchestration.md) · [этапы](../../stages/README.md) · [документация](../../README.md).

## 17. Матрица волны SW-2 (Процедурное поле и вывод растра из эксплуатации)

Дата постановки: **25 октября 2026 года**. Статус: **волна открыта**, кодовые PR не созданы.
Источник чисел — гайдлайнер [`../stages/stage-9-12-sector-deep-render-plan.md`](../../stages/stage-9-12-sector-deep-render-plan.md)
(§8 поле, §10 контракты, §11 гейты, §12 `SW-2`, §14 целевое состояние).

### 17.1. Цель и границы

`SW-2` заменяет растровую подложку сектора процедурным полем и **в той же волне** выводит из
эксплуатации весь тайловый конвейер. Это единственная необратимая волна под-уровня: после
слияния `SW-2B` в репозитории не остаётся ни исходника растра, ни тайлов, ни кода, который их
читает (`D-07`, `D-11`, инвариант `И-10`).

**Входит:** `src/atlas/sector-field.ts`, интеграция поля в кадр `/sector/` и `/minimal/`,
удаление `tile-pyramid.ts`, `CONFIG.tiles`, `state.rasterMode`, `SITE_LINKS.sectorMapPreview`,
тайлового шага сборки, кэша тайлов в `pages.yml`, workflow `assets.yml`, требования
`.publish/assets/tiles.json` в `check.yml`, исходника `assets/src/koprulu-sector.jpg`.

**Не входит:** маркеры, подписи, территории, лестница уровней в рантайме (`SW-3`); полёт и
стрелки (`SW-3F`); адресный UI (`SW-4`); системный кадр (`SW-5`); планетарный контур (`И-11`);
растр галактики `assets/src/galaxy-map.jpg` и маршрут `/` (`D-12`); данные `data/*.csv`.

### 17.2. Решения перед стартом (приняты Гайдлайнером 25.10.2026)

1. **Два пресета поля.** `nebula` — по умолчанию (`D-08`); `tactical` («тактический тёмный») —
   за флагом `?style=tactical`. Причина: удаление растра необратимо, а второй пресет стоит
   ≈ 2 агено-часа и снимает риск `R-1` («поле визуально хуже карты») до приёмки, а не после.
   Переключение — одна константа в `CONFIG.field.style`; оба пресета рисуются одним кодом,
   различие только в таблице цвета и параметрах шума.
2. **Эталон «до» не снимается отдельным артефактом** (`D-11`), но и не теряется: исходник
   растра остаётся в истории Git и восстанавливается одной командой
   `git show b3306cb:assets/src/koprulu-sector.jpg > /tmp/koprulu-sector.jpg`, а тайлы из него
   пересобираются `python3 tools/build_assets.py --force` на любой ветке до `SW-2B`.
   Поэтому специальный протокол скриншотов не нужен; вместо него — **предпросмотр поля
   без браузера** (§17.7, пункт `G7.3`-подготовка).
3. **Волна идёт последовательно, а не тройкой.** Обоснование — §17.9.

### 17.3. Инвентарь: где растр живёт на `main` (`b3306cb`)

| Файл | Строки | Что держит |
|---|---|---|
| `src/atlas/tile-pyramid.ts` | весь файл (212 строк) | `createTilePyramid`, `drawRaster`, `hasPreviewImage`, `rasterExpected`, кэш `cacheLimit: 260` |
| `src/atlas/config.ts` | `32…37` (`tiles`), `50…55` (`markerLod`), `252`, `310`, `330` (`rasterMode`), `536` | `CONFIG.tiles`, состояние `tiles`/`rasterMode` |
| `src/atlas/canvas-renderer.ts` | `723…732` | ветка `rasterMode === 'tiles'/'preview'` → `kernel.tiles.drawRaster()` |
| `src/atlas/data-loader.ts` | `336…345` | `wantsRaster` → `fetchJSON(CONFIG.tiles.manifest)` |
| `src/atlas/app.ts` | `47`, `67`, `127`, `402…405` | инициализация `kernel.tiles`, `configureTiles` |
| `site/shared/links.ts` | `7…10`, `17`, `31` | `sectorMapPreview` (читается `tile-pyramid.ts:84,87`) |
| `tools/build_assets.py` | `53…58`, `125…190`, `306`, `318…325`, `194` | `SECTOR_SOURCE`, `TILE_*`, `PREVIEW_*`, `build_tiles`, проверка свежести |
| `data/meta.json` | блок `assets` | `hasRaster`, `preview`, `tiles`, `version`, **`imageVersion`** |
| `.gitignore` | `5…7` | `assets/tiles/`, `assets/tiles.json`, `assets/map-preview.webp` |
| `.github/workflows/pages.yml` | `37…39` | кэш тайлов и превью |
| `.github/workflows/check.yml` | `57` | требует `.publish/assets/tiles.json` — **в плане гайдлайнера не учтён** |
| `.github/workflows/assets.yml` | `24…30` | собирает `build_assets.py --force` и выгружает артефакт с тайлами — **в плане не учтён** |
| `site/AGENTS.md` | `61` | описывает тайлы как действующий контур (SSoT) |
| `tools/AGENTS.md` | `55` | описывает пирамиду WebP как действующий контур (SSoT) |

### 17.4. Матрица файлов (`Zero File Overlap`)

Волна разбита на два шага, чтобы каждая ветка собиралась зелёной (§17.9). Пересечений между
шагами нет по построению: `SW-2A` не трогает ни одного существующего файла рантайма, а
единственный существующий файл, который он меняет, — `package.json` (одна строка скрипта).

**Шаг `SW-2A` — поле (создаётся, ничего не удаляется).**

| Воркер | Поток | `OWNED_FILES` | Запрещено |
|---|---|---|---|
| **Воркер 1** | `src/atlas/sector-field.ts`: WebGL2-рендер процедурного поля + CPU-фолбэк, два пресета, дизеринг, детерминизм от `xxHash32`; `tools/sector_field_preview.mjs` — предпросмотр PNG без браузера; тест | `src/atlas/sector-field.ts`<br>`tools/sector_field_preview.mjs`<br>`tests/sector-field.test.mjs`<br>`package.json` *(только скрипт `sector-field:preview`)* | Все остальные файлы, включая `canvas-renderer.ts`, `config.ts`, `app.ts`, `tile-pyramid.ts`, `.github/*` |

**Шаг `SW-2B` — вывод растра и интеграция (после слияния `SW-2A`).**

| Воркер | Поток | `OWNED_FILES` |
|---|---|---|
| **Воркер 2** | Интеграция поля в кадр, удаление тайлового конвейера, правки сборки и CI | `src/atlas/canvas-renderer.ts`<br>`src/atlas/config.ts`<br>`src/atlas/data-loader.ts`<br>`src/atlas/app.ts`<br>`src/atlas/tile-pyramid.ts` *(удаление)*<br>`site/shared/links.ts`<br>`data/meta.json`<br>`tools/build_assets.py`<br>`.gitignore`<br>`.github/workflows/pages.yml`<br>`.github/workflows/assets.yml`<br>`.github/workflows/check.yml`<br>`assets/src/koprulu-sector.jpg` *(удаление)*<br>`package.json` |
| **Гейт Гайдлайнера** | `tools/verify_no_raster.mjs` — исполняемая форма `И-10` | `tools/verify_no_raster.mjs` |
| **Воркер 3** | Документация: доменные SSoT описывают **уже** удалённый контур | `site/AGENTS.md`<br>`tools/AGENTS.md`<br>`CHANGELOG.md`<br>`docs/HANDOFF.md`<br>`docs/stages/stage_patches.md`<br>`docs/PREPARATION_PLAN.md` (строка статуса) |

**Стык `package.json`.** Файл общий для волны, поэтому у него ровно один владелец на шаг и
шаги идут последовательно: `SW-2A` — Воркер 1 (единственная новая строка — скрипт
`sector-field:preview`), `SW-2B` — Воркер 2 (скрипт `verify:no-raster`). Ветка `SW-2B`
строится от `main` **после** слияния `SW-2A`, поэтому правка Воркера 1 уже в базе и повторно
её никто не вносит. Правило О-1 соблюдено: внутри шага у файла один владелец, между шагами
пересечения нет по времени.

### 17.5. Контракт до буквы (`Interface-First`)

**`src/atlas/sector-field.ts` (Воркер 1).**

~~~~text
export type FieldStyle = 'nebula' | 'tactical';

export interface FieldPalette {
  readonly id: FieldStyle;
  readonly background: readonly [number, number, number];
  readonly dust: readonly [number, number, number];
  readonly core: readonly [number, number, number];
  readonly rim: readonly [number, number, number];
  readonly densityStops: readonly number[];
}

export interface SectorFieldState {
  readonly view: { readonly scale: number; readonly tx: number; readonly ty: number };
  readonly viewport: { readonly w: number; readonly h: number };
  readonly dpr: number;
  readonly mapSize: number;
}

export interface SectorField {
  readonly style: FieldStyle;
  readonly backend: 'webgl2' | 'cpu';
  renderField(state: SectorFieldState): void;
  renderToImageData(state: SectorFieldState): ImageData;
  dispose(): void;
}

export const FIELD_SEED_TEXT = 'KP';
export const FIELD_PALETTES: readonly FieldPalette[];

export function hashSeed(text: string): number;
export function createSectorField(canvas: HTMLCanvasElement | null, opts?: { readonly style?: FieldStyle }): SectorField;
~~~~

Жёсткие требования:

1. **Камеро-относительная математика.** Центр кадра считается в `float64` в JS
   (`cx = (viewport.w / 2 - tx) / scale`, по `y` аналогично), в шейдер передаётся **только
   смещение** относительно центра, разложенное на старшую и младшую части
   (`u_offsetHi`/`u_offsetLo` как `vec2`).
   Прямая передача мировых координат в `uniform float` запрещена: на `L9` (`scale ≈ 512`)
   `float32` перестаёт различать соседние пиксели (`R-3`).
   **Поправка от 25.10.2026 (приёмка `SW-2A`).** В первой редакции стояло
   `(mapSize / 2 - tx) / scale`. Это неверно: `canvas-renderer.ts` (`toWorld`) связывает экран
   и мир как `screen = tx + world · scale`, поэтому мировая точка в центре кадра —
   `(viewport.w / 2 - tx) / scale`. Формы совпадают только при `viewport.w = mapSize`; при
   другом размере кадра поле уезжает. Воркер 1 реализовал верную форму и написал об этом;
   поправка внесена в контракт, `mapSize` остаётся размером мира и запасным значением кадра.
2. **Детерминизм.** Всё случайное — только от `hashSeed(FIELD_SEED_TEXT)`; `Math.random`,
   `Date.now`, `performance.now` в генерации запрещены. CPU-фолбэк обязан быть **побитово**
   воспроизводим между прогонами и машинами.
3. **CPU-фолбэк обязателен.** Нет WebGL2 или контекст потерян → `backend === 'cpu'`, картинка
   та же по композиции, без исключений и без пустого холста (`rc-01` п. 2).
4. **Никакой сети и никаких ассетов.** Модуль не делает ни одного `fetch`, не читает картинок,
   не создаёт `Image` — гейт `И-10` проверяет это по коду.
5. **Бюджеты.** Полный кадр `L0` (viewport `1920 × 1080`, `dpr = 1`) — `p95 ≤ 16,7 мс` на
   целевом десктопе; GPU-память поля `≤ 32 МБ`; предпросмотр `1024 × 1024` на CPU —
   `≤ 8 с` без оптимизаций.
   **Уточнение от 25.10.2026 (приёмка `SW-2A`).** Замер Воркера 1 и мой повторный замер дали
   `≈ 0,88 с` на кадр `1920 × 1080` в CPU-пути `L0` (и `1,5 с` на `L4`/`L9`) — это в 18–30 раз
   больше гейта `G7.4` («CPU-фолбэк не блокирует главный поток дольше `50 мс` за кадр»).
   Разделено по API:
   - `renderField` (экранный путь) обязан укладываться в `50 мс`: CPU-ветка считает поле в
     буфере пониженного разрешения (не выше `1/3` линейно от `viewport · dpr`, т. е.
     `≤ 640 × 360` для `1920 × 1080`) и растягивает в кадр билинейно, а готовый кадр кэширует
     по ключу `(style, scale, tx, ty, viewport, dpr, mapSize)` и переиспользует;
   - `renderToImageData` остаётся полноразрешающим и точным: это оффлайн-API предпросмотра и
     тестов, на нём бюджета `50 мс` нет.
   Понижение разрешения и кэш обязаны сохранить побитовый детерминизм CPU-пути
   (`G7.6`), а шейдер — ту же композицию, что CPU-ветка.
6. **Строгий TS без DOM там, где это возможно.** `renderToImageData` обязан работать без
   реального `<canvas>` (в Node, через CPU-путь) — это требование предпросмотра и тестов.

### 17.6. Точка интеграции в кадре (шаг `SW-2B`)

Было (`canvas-renderer.ts:723…732`):

~~~~text
if (state.rasterMode === 'tiles' || (state.rasterMode === 'preview' && kernel.tiles.hasPreviewImage())) {
  ctx.fillStyle = '#03060c';
  ctx.fillRect(0, 0, state.viewport.w, state.viewport.h);
  ctx.imageSmoothingEnabled = true;
  if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
  kernel.tiles.drawRaster();
} else {
  drawSchematic();
}
~~~~

Стало:

~~~~text
kernel.field.renderField({
  view: state.view,
  viewport: state.viewport,
  dpr: state.dpr,
  mapSize: kernel.data.mapSize(),
});
~~~~

`drawSchematic()` остаётся резервом на случаи «данные ещё грузятся» и «нет ни поля, ни WebGL2»;
удалять его в `SW-2` запрещено — это состояние загрузки (`rc-01` п. 2), а не растр.
