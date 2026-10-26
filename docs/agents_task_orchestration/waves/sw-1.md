# Волна SW-1: цели, матрица файлов и контракт адреса

> Источник: `agents_task_orchestration.md`, строки 306–499 (редакция до разукрупнения).
> Назад: [оркестрация](../agents_task_orchestration.md) · [этапы](../../stages/README.md) · [документация](../../README.md).

## 16. Матрица волны SW-1 (Ядро под-уровня Этапов 9–12: буквенный адрес, лестница глубины, единицы)

Дата постановки: **25 октября 2026 года**. Статус: **волна слита 25.10.2026** (Воркер 1 — PR #244 `c9c36b4`, Воркер 2 — PR #245 `86ded61`, сквозной гейт Гайдлайнера — PR #248 `dd1f2ea`, документация волны — PR #249; факт и требование к `SW-3` — §16.9).
Режим — параллельный (`Tri-Agent Wave`), контур — секториальный под-уровень Этапов 9–12.

Источник чисел — гайдлайнер [`../stages/stage-9-12-sector-deep-render-plan.md`](../../stages/stage-9-12-sector-deep-render-plan.md)
(§6 лестница, §7 адресация, §10 контракты, §11 гейты, §12 `SW-1`). Здесь только распределение
работ, контракты на стыках и порядок приёмки; числа не дублируются, кроме тех, что воркер
обязан вписать в код буквально (таблицы §16.3).

### 16.1. Цель и границы волны

`SW-1` создаёт фундамент, на котором стоят все следующие волны: кодек буквенного адреса
`KP·REQHC`, лестницу 13 уровней с гистерезисом и единственный форматтер расстояний.
**Рантайм `/sector/` в этой волне не меняется:** `canvas-renderer.ts`, `config.ts`,
`data-loader.ts`, `app.ts`, `tile-pyramid.ts`, `templates/*`, `site/*` не трогаются —
это `SW-2`/`SW-3`. Растровая подложка на месте, поведение страницы прежнее.

Инварианты, действующие в волне: **И-7** (адрес — производная биекция, в данных не хранится),
**И-8** (пороги уровней живут только в `level-ladder.ts`), **И-11** (планетарный контур вне
правок), **И-16** (`formatDistanceLy` — единственный форматтер расстояний).

### 16.2. Матрица распределения файлов (`Zero File Overlap`)

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Кодек адресов, golden vectors, верификатор; слитый PR #244)* | `src/atlas/sector-address.ts`: тиры `T0…T5` (`10 000 / 2 000 / 400 / 80 / 16 / 3,2`), алфавит `A…Y` построчно, ось `y` вниз (`flipY = false`), `addressOf`, `prefixOf`, `rectOf`, `centerOf`, `parseAddress`, `formatAddress`; `tools/verify_sector_address.mjs` (CLI без зависимостей: `mapSize`, `173` уникальных адреса, round-trip `≤ 1e-9`, golden vectors, `--regen`); `tests/sector-address.test.mjs`. | - `src/atlas/sector-address.ts`<br>- `tools/verify_sector_address.mjs`<br>- `tests/sector-address.test.mjs` | Все остальные файлы, включая `src/atlas/level-ladder.ts`, `src/atlas/sector-units.ts`, `tests/sector-ladder.test.mjs`, `tests/sector-units.test.mjs`, `package.json`, `.github/workflows/check.yml`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Лестница 13 уровней, единицы и подключение проверок в CI; слитый PR #245)* | `src/atlas/level-ladder.ts`: `LEVELS` (13 записей), `levelForWidth` с гистерезисом `±12 %`, `levelSpec`, `frameOf`, `visibleWidthForLevel`, `markerDiameter`, `MIN_VISIBLE_WIDTH`/`MAX_VISIBLE_WIDTH`; `src/atlas/sector-units.ts`: `formatDistanceLy`, `pluralYears`, `formatAngleDeg`, `NBSP`; `tests/sector-ladder.test.mjs`, `tests/sector-units.test.mjs`; подключение трёх новых тестов в `npm test` и шага `npm run verify:address` в job `scripts` файла `.github/workflows/check.yml`. | - `src/atlas/level-ladder.ts`<br>- `src/atlas/sector-units.ts`<br>- `tests/sector-ladder.test.mjs`<br>- `tests/sector-units.test.mjs`<br>- `package.json`<br>- `.github/workflows/check.yml` | Все остальные файлы, включая `src/atlas/sector-address.ts`, `tools/verify_sector_address.mjs`, `tests/sector-address.test.mjs`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Документация волны; запускается последним, после слияния PR 1–2; слитый PR #249 `36448ec`)* | Сводные записи: `CHANGELOG.md` (новая запись сверху), `docs/HANDOFF.md` (§1 «Статус»: новая строка «Последняя работа», прежняя — в «Предыдущую», по §15.3 гайдлайнера), `docs/stages/stage_patches.md` (запись `2026-10-2X` в конец журнала), простановка фактических номеров PR в §16.2 и снятие статуса «волна открыта» в шапке §16; в `docs/PREPARATION_PLAN.md` — только строка статуса под-уровня, без перезаписи прежних абзацев. | - `CHANGELOG.md`<br>- `docs/HANDOFF.md`<br>- `docs/stages/stage_patches.md`<br>- `docs/agents_task_orchestration/agents_task_orchestration.md`<br>- `docs/PREPARATION_PLAN.md` | Любые файлы кода и тестов (`site/*`, `src/*`, `tools/*`, `tests/*`), `package.json`, `.github/*`, `data/*` |

**Стык `package.json` и `check.yml` (правило О-1).** Оба общих файла отданы ровно **Воркеру 2**.
Воркер 1 не добавляет себя в `npm test` и не правит CI: его тест подключается Воркером 2 по
зафиксированному ниже имени файла.

**Стык `verify_sector_address.mjs` ↔ CI (О-3).** Имя скрипта, имя npm-скрипта
(`"verify:address": "node tools/verify_sector_address.mjs"`) и код выхода (`0` — успех,
`1` — любое расхождение) зафиксированы до старта. Воркер 1 создаёт скрипт, Воркер 2 добавляет
шаг `npm run verify:address` в job `scripts` (после `npm test`, до `npm run lint`).

**Зависимость модулей (О-3).** `level-ladder.ts` **не импортирует** `sector-address.ts`:
поле `addressLetters` — обычное число `0…5`, значения заданы таблицей §16.3. Это осознанное
решение против урока `RING_HF_RES`: зеркальных констант нет, потому что истина одна — таблица,
а сверку выполняет Гайдлайнер сквозным интеграционным шагом после слияния (см. §16.5).

**Порядок первого коммита.** Воркеры 1 и 2 делают первый содержательный коммит сразу в свой
целевой файл из `OWNED_FILES` (не в `HANDOFF.md`), затем `git push -u origin HEAD`,
сверка `HEAD == origin/<ветка>` и WIP PR.

### 16.3. Контракт до буквы (`Interface-First`)

**`src/atlas/sector-address.ts` (Воркер 1).**

~~~~text
export type AddressLetters = 0 | 1 | 2 | 3 | 4 | 5;

export interface AddressTier {
  readonly id: string;          // 'T0' … 'T5'
  readonly name: string;        // 'Сектор', 'Квадрант', 'Регион', 'Субсектор', 'Ячейка', 'Узел'
  readonly cellSize: number;    // 10000, 2000, 400, 80, 16, 3.2
}

export interface SectorAddress {
  readonly sector: string;      // 'KP'
  readonly letters: string;     // 'REQHC' (длина 1…5, буквы A…Y)
}

export const SECTOR_CODE = 'KP';
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const MAP_SIZE = 10000;
export const ADDRESS_TIERS: readonly AddressTier[];

export function addressOf(x: number, y: number): SectorAddress;
export function prefixOf(x: number, y: number, letters: AddressLetters): SectorAddress;
export function rectOf(address: SectorAddress | string): { readonly x: number; readonly y: number; readonly size: number };
export function centerOf(address: SectorAddress | string): { readonly x: number; readonly y: number };
export function parseAddress(text: string): SectorAddress | null;
export function formatAddress(address: SectorAddress, style?: 'compact' | 'expanded'): string;
~~~~

Жёсткие требования к поведению:

1. `addressOf(x, y)` — чистая функция; координаты вне `[0, 10 000)` → `TypeError` (поле не
   расширяется, отрицательные и `10 000` тоже отказ).
2. Обход построчный: `letter = ALPHABET[row · 5 + col]`, `row = ⌊y_t / size_t⌋`,
   `col = ⌊x_t / size_t⌋`, остаток переносится на следующий тир (§7.6 гайдлайнера).
3. `rectOf` возвращает **левый верхний угол** ячейки `T5` и её `size = 3.2`;
   `centerOf` — центр той же ячейки (`точность 1,6 св.г.`).
4. `parseAddress` принимает `KP·REQHC`, `kp-reqhc`, `REQHC`, `KP-R-E-Q-H-C`, `KP REQHC`
   (разделители `·`, `-`, пробел; регистр любой) и возвращает `null` на мусор, пустую строку,
   длину ≠ 5 и на чужой код сектора (кроме зарезервированных `TS`, `UJ`, `CH`, `AY`, `SL`, `SH` —
   они парсятся, но не являются адресом Копрулу).
5. `formatAddress` — `compact` → `KP·REQHC` (разделитель `·` U+00B7), `expanded` →
   `KP-R-E-Q-H-C`; стиль по умолчанию `compact`; для адреса с `letters.length < 5`
   компактная форма даёт уровневую запись (`KP·RE`).

Golden vectors, которые обязаны совпасть (проверены Гайдлайнером 25.10.2026 прогоном по
`data/systems.csv`, см. §16.7):

| Вход | Адрес | | Вход | Адрес |
|---|---|---|---|---|
| `5720, 6257` (Корхал) | `KP·REQHC` | | `6683, 5076` (Айур) | `KP·NLSMI` |
| `5749, 5984` (Тарсонис) | `KP·MYVYB` | | `9233, 4539` (Слейн) | `KP·OIFRP` |
| `5568, 5994` (Мория) | `KP·MXYXP` | | `8396, 3061` (Шакурас) | `KP·JKTJI` |
| `5683, 5855` (Умоджа) | `KP·MYQAU` | | `0, 0` | `KP·AAAAA` |
| `5086, 5896` (Чар) | `KP·MWSRO` | | `9 999, 9 999` | `KP·YYYYY` |
| `2 500, 2 500` | `KP·GGGGG` | | | |

**`src/atlas/level-ladder.ts` (Воркер 2).**

~~~~text
export type LadderFrame = 'S' | 'O';

export interface LevelSpec {
  readonly level: number;            // 0 … 12
  readonly id: string;               // 'L0' … 'L9', 'S0' … 'S2'
  readonly frame: LadderFrame;       // 'S' — сектор, 'O' — система
  readonly visibleWidth: number;     // св.г. для 'S', а.е. для 'O'
  readonly addressLetters: 0 | 1 | 2 | 3 | 4 | 5;
  readonly markerPx: number;         // диаметр маркера, px
  readonly frameBudgetMs: number;    // бюджет кадра
}

export const LEVELS: readonly LevelSpec[];
export const MAX_VISIBLE_WIDTH = 10000;
export const MIN_VISIBLE_WIDTH = 16000;
export const HYSTERESIS = 0.12;

export function levelForWidth(visibleWidth: number, prev?: number): number;
export function levelSpec(level: number): LevelSpec;
export function frameOf(level: number): LadderFrame;
export function visibleWidthForLevel(level: number): number;
export function markerDiameter(visibleWidth: number): number;
~~~~

Таблица, которую воркер вписывает буквально (пороги — **точная геометрия** `10 000 / 2ⁿ`,
в гайдлайнере они округлены до `19,5 / 39 / 78 / 156 / 312,5`; округлённые значения как
пороги запрещены — они ломают контрольный вектор `levelForWidth(19,53) = 9`):

| Ур. | Кадр | `visibleWidth` | `addressLetters` | `markerPx` | `frameBudgetMs` |
|---|---|---|---:|---:|---:|
| `L0` | `S` | `10 000` | 0 | 2,5 | 8 |
| `L1` | `S` | `5 000` | 1 | 3,3 | 8 |
| `L2` | `S` | `2 500` | 2 | 4,5 | 10 |
| `L3` | `S` | `1 250` | 2 | 6,0 | 10 |
| `L4` | `S` | `625` | 3 | 8,0 | 12 |
| `L5` | `S` | `312,5` | 3 | 10,7 | 12 |
| `L6` | `S` | `156,25` | 4 | 14,3 | 14 |
| `L7` | `S` | `78,125` | 4 | 19,2 | 14 |
| `L8` | `S` | `39,0625` | 5 | 25,7 | 16 |
| `L9` | `S` | `19,53125` | 5 | 34,3 | 16 |
| `S0` | `O` | `100` | 5 | — | 16 |
| `S1` | `O` | `16` | 5 | — | 16 |
| `S2` | `O` | `2` | 5 | — | 16 |

Жёсткие требования к поведению:

1. `levelForWidth(w, prev?)` возвращает **только секториальные** уровни `0…9`:
   `n = clamp(⌊log₂(10 000 / w) + 1e-9⌋, 0, 9)`; `w ≥ 10 000` → `0`; `w ≤ 19,53125` → `9`.
   Допуск `1e-9` перед округлением вниз обязателен: без него граничное значение
   `w = 19,53125` (отношение ровно `512`) на float даёт `8,999…` и тест `G7.2` падает.
   Уровни `S0…S2` выбирает системный кадр в `SW-5`, а не эта функция (не расширять).
2. Гистерезис `±12 %` применяется только при переданном `prev`: погружение на `n+1`
   при `w ≤ W[n+1] · 0,88`; всплытие на `n−1` при `w ≥ W[n] · 1,12`; шаг — ровно один уровень
   за вызов (никаких перескоков через два).
3. `markerDiameter(w) = clamp(2,5 · (10 000 / w)^0,42, 2,5, 40)` — непрерывная функция,
   не ступенька; на `w = 19,53125` даёт `34,3 ± 0,05`, на `10 000` — ровно `2,5`.
4. `MIN_VISIBLE_WIDTH = 16 000` (отъезд шире поля), `MAX_VISIBLE_WIDTH = 10 000`
   (дефолт при входе) — из §6.3 гайдлайнера.
5. `visibleWidthForLevel(n)` — обратная к таблице (`10 000 / 2ⁿ` для `n = 0…9`;
   для `S0…S2` — значения столбца `visibleWidth`).

**`src/atlas/sector-units.ts` (Воркер 2).**

~~~~text
export const NBSP = '\u00A0';
export type DistanceMode = 'full' | 'short';

export function formatDistanceLy(ly: number, mode?: DistanceMode): string;
export function pluralYears(n: number): 'год' | 'года' | 'лет';
export function formatAngleDeg(rad: number): string;
~~~~

Жёсткие требования к поведению (по §6.5.1 и §10.4 гайдлайнера):

1. `formatDistanceLy(ly, 'short')` — один знак после запятой, `'full'` — два; запятая как
   десятичный разделитель, `NBSP` между разрядами тысяч, `NBSP` перед единицей, единица
   **никогда** не опускается: `8,4 св.г.`, `88,4 св.г.`, `1 302,9 св.г.`, `90,79 св.г.`,
   `108,07 св.г.`. `ly ≥ 10 000` → `≥ 10 000 св.г.`; отрицательный вход → `RangeError`.
2. Запрещены в любом выводе: `ly`, `св. лет`, `св.год`, точка как десятичный разделитель.
3. `pluralYears`: `1` → `год`, `2` → `года`, `5` → `лет`, `21` → `год`, `90,8` → `лет`
   (дробное склоняется как `5`).
4. `formatAngleDeg`: нормализация в `(−180°, 180°]`, минус — U+2212, `−0` → `0°`,
   целые значения без десятых, дробные — с одним знаком.
