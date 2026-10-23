# Оркестрация мультиагентной разработки (Tri-Agent Wave / Split-Work)

Настоящий документ задаёт регламент работы для **Гайдлайнера (Оркестратора)** при параллельном выполнении задач звеном **«1 Гайдлайнер (`main`) + 3 Воркера (изолированные ветки)»**.

Для исполнения задач в этом режиме воркеры перенаправляются по методу в парную инструкцию:
- [`docs/agents_task_orchestration/worker_instruction_on_splitwork.md`](./worker_instruction_on_splitwork.md)

---

## 1. Разделение режимов работы репозитория

В репозитории действуют два строго разделённых контура работы:

| Режим | Когда применяется | Какой документ управляет процессом | Кто обновляет `docs/HANDOFF.md` и `CHANGELOG.md` |
|---|---|---|---|
| **Стандартный (Single-Agent)** | Одиночный агент выполняет весь PR целиком в одной ветке | Базовый [`AGENTS.md`](../../AGENTS.md) | Сам агент в первом (WIP) и финальном коммите своего PR |
| **Сплит-режим (Tri-Agent Wave)** | Задача разбита Гайдлайнером на 3 параллельных потока в разных ветках от `main` | Настоящий документ (для Гайдлайнера) + [`worker_instruction_on_splitwork.md`](./worker_instruction_on_splitwork.md) (для Воркеров 1–3) | **Только Воркер 3** (или сам Гайдлайнер после слияния волны); Воркерам 1 и 2 трогать общие доки **запрещено** |

---

## 2. Позиционная осведомлённость агентов (Role & Boundary Card)

Исследования мультиагентных LLM-систем генерации кода (*MetaGPT*, *ChatDev*, таксономия сбоев *MAST*, работы по *Irrelevant Context Distraction*) показывают:

1. **Работа «вслепую» (без знания о соседних воркерах)** даёт **35–60 %** конфликтов слияния: агент следует общему правилу из `AGENTS.md`, правит `docs/HANDOFF.md`, `CHANGELOG.md` и смежные файлы, сталкиваясь с коммитами соседей.
2. **Полный дамп чужих ТЗ в один промпт** вызывает эффект *Task Bleed* (размытие фокуса): точность падает на **10–20 %**, расход контекстного окна растёт на **~30 %**, а агент пытается искать в своей ветке ещё не влитый код соседа.
3. **Позиционная карточка и матрица границ (`Role & Boundary Card`, ~120 токенов)** снижает частоту выхода за границы до **< 3–5 %** при **0 %** потерь контекста: агент знает свою позицию в тройке, однострочную роль соседей и причину запрета на правку чужих файлов.

---

## 3. Четыре железных правила оркестрации волны (Zero-Conflict Protocol)

### Правило О-1. Матрица эксклюзивного владения файлами (`Zero File Overlap`)
Перед запуском волны Гайдлайнер строит таблицу распределения файлов между Воркерами 1, 2 и 3:
- Множества файлов `РАЗРЕШЕНО ПРАВИТЬ (OWNED_FILES)` у трёх воркеров **не пересекаются ни по одному пути** (`Owned_1 ∩ Owned_2 = ∅`, `Owned_1 ∩ Owned_3 = ∅`, `Owned_2 ∩ Owned_3 = ∅`).
- Если общий конфигурационный файл (`package.json`, `eslint.config.mjs`, `.github/workflows/check.yml`, `tools/build_assets.py`) должен быть изменён более чем для одного потока, его правка целиком отдаётся **ровно одному** назначенному воркеру волны (либо выносится Гайдлайнером в подготовительный микро-коммит до старта тройки).

### Правило О-2. Вынос `docs/HANDOFF.md` и `CHANGELOG.md` из кодовых веток
- Воркеры 1 и 2 занимаются исключительно кодом и своими модульными тестами; им **прямо запрещено** менять `docs/HANDOFF.md`, `CHANGELOG.md` и общие дорожные карты (`docs/PREPARATION_PLAN.md`, `docs/CHANGE_REQUEST_PLAN.md`).
- Чтобы выполнить требование раздела «Сохранность работы» из `AGENTS.md` на Шаге 0 без `docs/HANDOFF.md`, Воркеры 1 и 2 делают первый содержательный коммит **сразу в свой целевой файл из `OWNED_FILES`** (например, каркас типов/интерфейсов Шага 1).
- Сводное обновление `docs/HANDOFF.md`, `CHANGELOG.md` и планов за всю волну выполняет **Воркер 3** (или Гайдлайнер закрывающим коммитом волны).

### Правило О-3. Стыковка по контракту до символа (`Interface-First`)
Если код Воркера 1 и код Воркера 2 взаимодействуют через импорт или протокол сообщений:
- Гайдлайнер заранее выписывает в промпты обоих воркеров **дословно идентичную сигнатуру** (`export interface`, `export function`, структуру payload).
- Воркер-потребитель опирается на зафиксированную сигнатуру (при необходимости — через локальное структурное расширение типа до слияния волн), не дожидаясь слияния ветки соседа.

### Правило О-4. Монолитный формат выдачи промптов
- Каждый промпт для копирования пользователем оформляется **единым блоком `~~~~text ... ~~~~`** без вложенных тройных обратных кавычек (`` ``` ``) внутри тела промпта.
- Внутренние команды и фрагменты кода внутри промпта отделяются отступом в 4 пробела — это гарантирует, что кнопка копирования заберёт весь промпт одним куском без разрыва Markdown-разметки.

---

## 4. Регламент экономии контекстного окна Гайдлайнера

Гайдлайнер удерживает контекстное окно свободным на протяжении всей серии волн за счёт следующих ограничений:

1. **Запрет на чтение простыней:** Гайдлайнер не запускает полный `git diff` по крупным PR и не читает файлы целиком; используются только:
   - `git fetch origin <branch> && git diff --stat origin/main...FETCH_HEAD` (мгновенная проверка `Zero File Overlap`);
   - `git log --oneline origin/main..FETCH_HEAD`;
   - точечные срезы `sed -n 'X,Yp'` или `grep -n` (не более 40–60 строк за вызов).
2. **Приёмка штатно завершившегося воркера за 1 шаг:**
   - Пользователь присылает номер PR (или финальную 15-строчную сводку воркера) — мысли и полные логи команд штатно завершившегося воркера присылать не нужно.
   - Гайдлайнер одной командой проверяет `git diff --name-only`, статус `gh pr checks <N>` (`4/4 pass`) и выполняет `gh pr merge <N> --squash --admin`.
3. **Разбор логов при обрыве контекста воркера (Half-Split Protocol):**
   - Если воркер исчерпал контекстное окно до пуша финального шага и пользователь приложил `commands.txt` / `dialog.txt`, Гайдлайнер **не читает лог целиком**.
   - Сначала определяется размер и точка последнего пуша: `wc -l` + `grep -n "git push\|# --- Команда"`.
   - Далее методом половинного деления (half-split) по номерам команд и таймстампам (`awk` по заголовкам `# --- Команда`) находятся последние незакоммиченные диффы и замеры, которые включаются в короткий промпт продолжения.

---

## 5. Стандартный шаблон промпта для Воркера в сплит-волне

При формировании пачки из 3 промптов на волну Гайдлайнер использует следующий каркас:

~~~~text
Ты работаешь в режиме параллельного сплита (Tri-Agent Wave). Перед началом обязательно прочитай регламент сплит-режима:
docs/agents_task_orchestration/worker_instruction_on_splitwork.md

## Позиция в системе (Role & Boundary Card)
- Твоя роль: ВОРКЕР [N] из 3 в параллельной волне [Код волны], координируемой Гайдлайнером от ветки main.
- Соседние агенты (работают ОДНОВРЕМЕННО с тобой в отдельных ветках):
  * Воркер 1: [1 короткая фраза — зона ответственности и файлы]
  * Воркер 2: [1 короткая фраза — зона ответственности и файлы]
  * Воркер 3: [1 короткая фраза — документация волны: PREPARATION_PLAN.md, HANDOFF.md, CHANGELOG.md]
- Правила изоляции твоей ветки:
  1. Изменений соседних воркеров в твоей ветке сейчас НЕТ — не ищи их новые файлы/функции и не пиши их часть работы.
  2. РАЗРЕШЕНО создавать/править/удалять ТОЛЬКО (OWNED_FILES):
     - [точный список путей]
  3. ЗАПРЕЩЕНО изменять любые другие файлы (FORBIDDEN_FILES), включая docs/HANDOFF.md и CHANGELOG.md (эту обязанность из AGENTS.md за всю волну закрывает Воркер 3).
  4. Для выполнения правила «Сохранность работы» на Шаге 0 сделай первый содержательный коммит сразу в свой целевой файл из списка РАЗРЕШЕНО ПРАВИТЬ, запушь ветку, проверь HEAD == origin и открой WIP PR.

---

## Контракт на стыках (Interface-First)
[Точные сигнатуры экспортируемых функций/интерфейсов, если есть стык с соседним воркером]

---

## Пошаговый план (коммит + git push после каждого шага)
### Шаг 1 — ...
### Шаг 2 — ...
### Шаг 3 — Проверка и финальный отчёт Гайдлайнеру (стоп перед merge)
~~~~

---

## 6. Матрица волны PR 6.1 (готова к запуску сразу после слияния PR 6)

Цель волны **PR 6.1** — устранить расхождения между мастер-планом `docs/PREPARATION_PLAN.md` (+ `docs/stages/stage_patches.md`) и состоянием `main` после завершения базовых PR 1–6 плана CR-01.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(FX-геометрия, объём осколков и ядро Шакураса)* | 1. Миграция логики раскладки осколков из `site/shared/planet-geometry.js` в строгий TS (`computeShardLayout`: режимы `equal` / `power` / `lognormal`, `shardThick`, `shardJag`, `shardLoss`) и удаление `site/shared/planet-geometry.js` по Инварианту И-5 (с обновлением `tools/check_planet_spike.mjs` и `vite.config.mts`, если там есть ссылка на `planet-geometry.js`).<br>2. Исправление бага `fxShardIndex(aPos)` в `src/planet/planet-globe-fx.ts` (назначение ID осколка строго по центру ячейки `vertexCellId` / `computeShardLayout`, а не по вершине треугольника).<br>3. Восстановление 3D-объёма осколков (`VS_VOLUME` / `FS_VOLUME`: закрытая нижняя оболочка + боковые стенки разломов с затенением) и светящегося ядра (`VS_CORE` / `FS_CORE`, `coreScale`, дефолт `0.55`) из `3728d4e:site/planet-test/planet-test.js` через хуки `PlanetGlobeFxHooks` (`onGeometryUploaded`, `onAfterSurfaceDraw`, `onDispose`). | - `src/planet/planet-globe-fx.ts`<br>- `site/shared/planet-geometry.js` *(удаление)*<br>- `tools/check_planet_spike.mjs`<br>- `tests/planet-globe-fx.test.mjs` | Все остальные файлы, включая `site/shared/planet-globe.ts`, `site/planet-test/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Каскадная сборка, центробежное замещение и UI `/planet-test/`)* | 1. Восстановление каскадной сборки глобуса `uBuild` (появление от полюса к полюсу с подъёмом по нормали и золотым свечением кромки) и двухслойного центробежного замещения прокси-шара детализированным патчем (`uHide`, `uCenterGrow`), а также вызов расширенных FX-хуков (`onGeometryUploaded`, `onAfterSurfaceDraw`, `onDispose`) в `site/shared/planet-globe.ts`.<br>2. Восстановление в `/planet-test/` контролов `#panelToggle`, `#spinBtn` + клавиши `Space`, `#bordersBtn`, слайдеров `buildSec` / `buildBtn` / `buildAnimBtn` / `coreScale` / `shardDist` / `shardThick` / `shardJag` / `shardLoss` и 10-сек окна телеметрии кадра (`p50/p95/p99`, `>50ms`, `>100ms`, `worst5`, адрес ячейки по клику). | - `site/shared/planet-globe.ts`<br>- `site/planet-test/index.html`<br>- `site/planet-test/planet-test.ts`<br>- `site/planet-test/planet-test.css` *(при необходимости)* | Все остальные файлы, включая `src/planet/planet-globe-fx.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Актуализация `PREPARATION_PLAN.md` + сводка `HANDOFF.md` и `CHANGELOG.md`)* | 1. Приведение `docs/PREPARATION_PLAN.md` (Раздел 1 и Этапы 3–8) в точное соответствие с выполненной архитектурой CR-01 (`.ts`-модули, `src/planet/*`, `src/local-map/*`, инварианты И-1…И-6, каскадная сборка + intent-based prefetch воркера на Этапе 7, порционная GPU-догрузка `StructureRenderer` на Этапе 8).<br>2. Сводная фиксация итогов в `docs/HANDOFF.md` и `CHANGELOG.md`. | - `docs/PREPARATION_PLAN.md`<br>- `docs/HANDOFF.md`<br>- `CHANGELOG.md` | Любые файлы кода и тестов (`site/*`, `src/*`, `tools/*`, `tests/*`) |

---

## 7. Матрица волны DX-1 (Инфраструктура, Strict Sync и модульные AGENTS/HANDOFF — запускается сразу после волны PR 6.1)

Цель волны **DX-1** — закрыть точки трения разработки, воспроизводимости окружения, строгой валидации синка и модульного разделения инструкций агентов (`AGENTS.md` / `HANDOFF.md` / `CONTRIBUTING.md`) по итогам код-ревью репозитория:

- **Не трогаем (по решению владельца):**
  - Деплой остаётся под GitHub Pages (без пересборки под серверный хостинг).
  - Планетарный движок и побитовые каналы (`geodesic-grid.ts`, `planet-geography.ts`, `planet-surface.ts`, `planet-core`) в рамках DX-1 не затрагиваются; `pillow>=13,<14` относится только к нарезке WebP-тайлов в `tools/build_assets.py`.
  - Защита GitHub-токена от утечки при HTTP-редиректах в `tools/sync.py` (`req.add_unredirected_header("Authorization", ...)`) уже реализована штатно средствами `urllib.request` и доработки не требует.

| Воркер | Поток работ (принятые пункты ревью с архитектурными поправками) | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Тулинг, фиксация версий, lockfile и рефакторинг `vite.config.mts` — п. 2, 3, 4, 5)* | 1. **Версии окружения (п. 3):** создать корневые `.nvmrc` (`24`) и `.python-version` (`3.12`) в соответствии с `.github/workflows/check.yml`.<br>2. **Полные команды в `package.json` (п. 2):** прописать явные пути тестовых наборов из CI, чтобы `npm test` не зависел от дефолтного дискавери Node: `"test": "node --test tests/geodesic-grid.test.mjs tests/planet-grid-cache.test.mjs tests/planet-generation-contract.test.mjs tests/planet-geography.test.mjs tests/planet-surface.test.mjs tests/planet-globe.test.mjs tests/local-map.test.mjs"`, `"test:py": "python3 -m unittest discover -s tests -p 'test_*.py'"`, `"test:all": "npm test && npm run test:py"`, а также `"lint": "eslint site src"`, `"build:planet-core"`, `"check:planet-core"`, `"verify:hashes"`, `"assets:build"`, `"assets:check"`, `"assets:sync-only"`.<br>3. **Единый `package-lock.json` без конфликта `typescript@7` vs `@typescript-eslint/parser@8` (п. 5):** в `check.yml` сейчас ставится `typescript@6` поверх `typescript@7` ради peer-зависимости `@typescript-eslint/parser@8`. При включении `assemblyscript@0.28.20`, `eslint@10`, `globals@17`, `@typescript-eslint/parser@8` в `devDependencies` сохранить `"typescript": "^7.0.2"`, прописать `overrides` в `package.json` (или `legacy-peer-deps=true` в `.npmrc`) и **одним отдельным коммитом** обновить `package-lock.json` + `.github/workflows/check.yml`, проверив чистый прогон `npm ci && npm run typecheck && npm run lint && npm run check:planet-core`.<br>4. **Рефакторинг `vite.config.mts` с учётом графа состояния (п. 4):** 4 фазы в `vite.config.mts` (`renderAtlasVariant` + `tokenizeLegacyAssets` → `ensureFinalizedAssets` → `restoreLegacyAssets` → `writePublishExtras`) разделяют общее состояние (`publishSources`, `finalizedAssets`, `tokenReferenceQueues`). Поэтому **не рвать** их на 4 псевдо-независимых плагина со скрытым глобальным стейтом: сначала зафиксировать граф фаз, вынести чистые несвязанные помощники (`tools/vite/atlas-shell.ts`, `tools/vite/asset-hash.ts`) и единый конвейерный модуль `tools/vite/timeline-publish-pipeline.ts` с явным объектом контекста `PublishPipelineState`, оставив в `vite.config.mts` декларацию маршрутов и подключение конвейера. | - `.nvmrc`<br>- `.python-version`<br>- `.npmrc` *(при необходимости)*<br>- `package.json`<br>- `package-lock.json`<br>- `.github/workflows/check.yml`<br>- `vite.config.mts`<br>- `tools/vite/*` | Все остальные файлы, включая `tools/sync.py`, `docs/*`, `AGENTS.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Строгий режим `sync.py --strict`, диагностика CSV/HTML и мульти-формат `approved_at` — п. 7, 8, 10)* | 1. **Режим `--strict` в `tools/sync.py` (п. 7):** добавить CLI-флаг `--strict` (мягкий режим по умолчанию сохраняется 1:1), который завершает синк с ненулевым кодом при: нечисловых `x`/`y`, выходе `x`/`y` за пределы `0..mapSize`, одновременном заполнении `system_id` и ручных координат (если нарушен инвариант привязки), а также дубликатах `id`/ссылок.<br>2. **Диагностика HTML вместо CSV (п. 8):** расширить сообщение об ошибке в `reject_html_response()` (`tools/sync.py`) и соответствующий блок в `docs/ADMIN_GUIDE.md` коротким чек-листом проверки публикации листа Google Sheets (`Файл → Поделиться → Опубликовать в интернете → CSV`).<br>3. **Детерминированная проверка обеих веток валидации `approved_at` в `tools/verify_planet_contract_cross.mjs` (п. 10):** в `tools/planet_generation.py` (строки 726–729) `approved_at` парсится по двум веткам: `YYYY-MM-DD` (`date.fromisoformat`) и полный ISO datetime (`datetime.fromisoformat` с `Z`/`+00:00`). Прогонять в `verify_planet_contract_cross.mjs` оба допустимых детерминированных формата (`"2026-10-21"` и `"2026-10-21T18:30:00Z"`), проверяя обе ветки валидатора и сериализацию.<br>4. Покрыть `--strict` и HTML-ошибку юнит-тестами в `tests/test_sync.py`. | - `tools/sync.py`<br>- `tests/test_sync.py`<br>- `tools/verify_planet_contract_cross.mjs`<br>- `docs/ADMIN_GUIDE.md` | Все остальные файлы, включая `package.json`, `vite.config.mts`, `AGENTS.md`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Онбординг `CONTRIBUTING.md`, иерархия `AGENTS.md` без дублирования и архивация `HANDOFF.md` — п. 1, 11, 12)* | 1. **Корневой `CONTRIBUTING.md` (п. 1, 12):** создать `CONTRIBUTING.md` с dev-онбордингом (Node 24 / Python 3.12, порядок команд `assets → build → test → verify`, артефакты `.publish/`, протокол частых коммитов после каждого логического шага).<br>2. **Иерархическое разделение `AGENTS.md` по принципу Single Source of Truth (п. 11):** корневой `AGENTS.md` содержит **только** общие правила всего репозитория (язык, сохранность работы, запрет легаси в `src/`, чек-лист проверок) и таблицу маршрутизации по папкам. Вложенные `site/AGENTS.md`, `src/atlas/AGENTS.md`, `src/planet/AGENTS.md`, `tools/AGENTS.md` **не дублируют** общие правила (чтобы они не разошлись со временем), а содержат только специфические инварианты своего модуля с обратной ссылкой на корневой `AGENTS.md`.<br>3. **Разгрузка `docs/HANDOFF.md` (п. 11):** вынести исторические записи завершённых этапов из 66-килобайтного `docs/HANDOFF.md` в `docs/HANDOFF_ARCHIVE.md`, оставив в `docs/HANDOFF.md` только актуальный срез состояния, действующие инварианты и итоги волны DX-1 + запись в `CHANGELOG.md`. | - `CONTRIBUTING.md`<br>- `AGENTS.md`<br>- `site/AGENTS.md`<br>- `src/atlas/AGENTS.md`<br>- `src/planet/AGENTS.md`<br>- `tools/AGENTS.md`<br>- `docs/HANDOFF.md`<br>- `docs/HANDOFF_ARCHIVE.md`<br>- `CHANGELOG.md` | Любые файлы кода и тестов (`site/**/*.ts`, `site/**/*.js`, `src/**/*.ts`, `tools/*.py`, `tools/*.mjs`, `tests/*`) |

---

## 8. Матрица волны Stage-7 (Этап 7: Страница планеты и бесшовный зум Голдберга)

Цель волны **Stage-7** — реализовать требования Этапа 7 мастер-плана `docs/PREPARATION_PLAN.md` (§12 «Этап 7. Страница планеты и бесшовный зум Голдберга», §8.8 «Ключи ячейки, области и локального участка»): двухслойное центробежное замещение геометрии (`uHide` / `uCenterGrow`), упреждающий `intent-based worker prefetch`, экспорт канонического среза 7 ячеек `Patch7` (`local-map-patch-v1`, Инварианты И-1 и И-3), досье планеты из `places.csv` + `systems.csv` + `planet-generation.csv` с проверкой `verifyGenerationKey` (И-4), хлебные крошки, выбор ячейки/континентальной области C100 по стабильному URL и прямой переход из Атласа сектора (`/sector/`, `/minimal/`) на 3D-глобус планеты.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Ядро бесшовного зума, `intent-based worker prefetch` и экспорт `Patch7` по И-1/И-3)* | 1. **Двухслойное центробежное замещение и подлёт камеры в `site/shared/planet-globe.ts`:** добавить методы `transitionGeometry(nextGeometry, durationSec?)` (отрисовка уходящего `prevVao` с `uHide = progress` и нового `vao` с `uCenterGrow = progress` без перезапуска с полюса и с немедленным освобождением буферов `prevVao` по завершении волны), `flyToDirection(direction, targetDistance?, durationMs?)`, `getCameraState()` и коллбэк `onCameraIntent` (debounce `180 мс`).<br>2. **Команды `prefetch` и `extract-patch` в `site/planet-globe/planet-globe-worker.ts`:** поддержка `prefetch` (`latest-wins` по `token`/`requestId`, прогрев `targetV` в `GridCache`, `GeodesicGrid.getChunkNeighbors`, упреждающая сборка `Patch7`) и `extract-patch` (`buildPatch7` + `verifyPatchInvariants` + `patchSpanMeters` + `buildBuildingSpawnMask` из `src/local-map/local-map-contract.ts` строго на `canonicalV`, с авто-привязкой 5-угольных полюсных ячеек к ближайшему 6-угольному соседу и расчётом ключей `planetKey`, `cellKey`, `regionKey`, `patchKey` по §8.8).<br>3. **Тесты Этапа 7:** покрыть новые методы глобуса и команды воркера в `tests/planet-stage7-worker.test.mjs` и подключить этот файл в скрипт `"test"` в `package.json`. | - `site/shared/planet-globe.ts`<br>- `site/planet-globe/planet-globe-worker.ts`<br>- `tests/planet-stage7-worker.test.mjs`<br>- `package.json` | Все остальные файлы, включая `site/planet-globe/index.html`, `site/planet-globe/planet-globe.ts`, `site/planet-globe/planet-globe.css`, `src/atlas/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Страница планеты `/planet-globe/`: каталог `places.csv` + `planet-generation.csv`, хлебные крошки, регион C100 и инспектор `Patch7`)* | 1. **Хлебные крошки, каталог мест и URL (`?place=&system=&cell=`):** загрузка `/data/places.csv`, `/data/systems.csv`, `/data/planet-generation.csv`; селектор канонических планет/лун сектора Копрулу; навигационная цепочка `Галактика → Сектор Копрулу → Система → Планета`; карточка досье планеты с бейджем `verifyGenerationKey(profile)` (И-4: `L1 Frozen` vs `L0 Draft`).<br>2. **Бесшовный переход `прокси → финал` и `intent-based prefetch`:** вызов `globe.transitionGeometry(geometry, 0.45)` при апгрейде прокси-шара в финал без сброса ракурса; отправка `prefetch` в воркер по `onCameraIntent`.<br>3. **Инспектор канонической ячейки, региона C100 и среза `Patch7`:** выбор ячейки кликом или через `?cell=<cell|address>`, плавный подлёт `flyToDirection`, запрос `extract-patch`, вывод параметров континентальной области C100, водосбора, речных граней и инвариантов `Patch7` (`local-map-patch-v1`), ключей `planet_key` / `region_key` / `cell_key` / `patch_key` и кнопки копирования прямой ссылки на ячейку. | - `site/planet-globe/index.html`<br>- `site/planet-globe/planet-globe.css`<br>- `site/planet-globe/planet-globe.ts` | Все остальные файлы, включая `site/shared/planet-globe.ts`, `site/planet-globe/planet-globe-worker.ts`, `src/atlas/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Переход из Атласа сектора `/sector/` на глобус планеты + отчёт `stage-7-planet-page.md`, `HANDOFF.md`, `CHANGELOG.md`)* | 1. **Связка данных в `src/atlas/config.ts` и `src/atlas/data-loader.ts`:** загрузка `/data/planet-generation.csv` в `loadDataset()` и обогащение `PlaceRecord` метаданными профиля (`planetProfileStatus`, `presetId`, `radiusKm`, `generationKey`).<br>2. **Переход на 3D-глобус из карточек систем и мест (`src/atlas/dossier-card.ts`, `site/shared/timeline-skin.css`):** кнопка `Открыть 3D-глобус планеты →` (`/planet-globe/?place=<id>&system=<systemId>`) в досье планеты/луны, быстрая ссылка `🌐 Глобус` в списке миров системы (`world-card`) и бейдж статуса 3D-профиля.<br>3. **Документация Этапа 7:** создать `docs/stages/stage-7-planet-page.md` и обновить `docs/HANDOFF.md` + `CHANGELOG.md` по итогам всей волны Stage-7. | - `src/atlas/config.ts`<br>- `src/atlas/data-loader.ts`<br>- `src/atlas/dossier-card.ts`<br>- `site/shared/timeline-skin.css`<br>- `docs/stages/stage-7-planet-page.md`<br>- `docs/HANDOFF.md`<br>- `CHANGELOG.md` | Все остальные файлы, включая `site/planet-globe/*`, `site/shared/planet-globe.ts`, `package.json`, `tests/*` |

---

## 9. Матрица волны Stage-8 (Этап 8: Локальная карта и процедурный 3D-конструктор построек)

Цель волны **Stage-8** — реализовать требования Этапа 8 мастер-плана `docs/PREPARATION_PLAN.md` (§9.4 «Локальная карта», §9.5 «Непрерывность глобуса и локальной карты», §9.5.1 «Архитектура 3D-структур и урбанистики», §12 «Этап 8. Локальная карта и процедурный 3D-конструктор построек» и Патч 8 из `docs/stages/stage_patches.md`): привязка рельефа и гидрологии локального участка к каноническому 7-ячеечному срезу `Patch7` (`filledElevation`, `seaLevel`, русла `inlets`/`outlet`, 3D-сэмплер `createPatchFieldSampler`), порционная (staged) GPU-догрузка `StructureRenderer` без фризов и без пересоздания VAO (`gl.bufferSubData` по кадровому бюджету), интерактивный Dive-in переход со страницы планеты `/planet-globe/` в 3D локальную карту участка с лестницей масштабов `1250 … 1.2 км` и круговым туманом, а также проверка гейта **G4** (`genMs <= 150 мс`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Ядро локальной карты И-3, порционная GPU-догрузка `StructureRenderer` по Патчу 8 и тесты `local-map-stage8.test.mjs`)* | 1. **Непрерывность рельефа и рек по И-3 в `src/local-map/local-map-worker.ts`:** привязать базовую высоту `heightfield` ($256 \times 256$) к каноническим полям `Patch7` (`patchBaseElevation` / `filledElevation - seaLevel`, `waterLevelOf`, выемка русла вдоль `patch.river.inlets` → центр → `patch.river.outlet` и 3D-шум через `samplePatchFields` при переданном `profile`), добавить LRU-кэш локальных участков (до 8 записей) и расширить `LocalMapMeta` (`totalInstances`, `buildableFraction`, `waterFraction`, `genMs`).<br>2. **Порционная (staged) GPU-догрузка без пересоздания VAO в `src/local-map/local-map-renderer.ts` и `src/local-map/local-map-shaders.ts`:** предвыделять `terrainVAO` (со статическим `Uint32Array`-буфером индексов и динамическими `posBuf`/`normBuf`) и `instanceVBOs` один раз при инициализации; добавить `enqueueWorkerData(data, budgetMs?)`, `processPendingUpload(budgetMs?)`, `isUploading()`, `getUploadProgress()`, `compilePrograms()`, `renderFrame(viewProj, lightDir, options?)` и `dispose()`, заливая вершины/нормали/инстансы порциями через `gl.bufferSubData` по бюджету `<= 3 мс` без пересоздания VAO (сохранив синхронный `onWorkerData(data)` для обратной совместимости).<br>3. **Тесты Этапа 8:** создать `tests/local-map-stage8.test.mjs` и подключить его в скрипт `"test"` в `package.json`. | - `src/local-map/local-map-worker.ts`<br>- `src/local-map/local-map-renderer.ts`<br>- `src/local-map/local-map-shaders.ts`<br>- `tests/local-map-stage8.test.mjs`<br>- `package.json` | Все остальные файлы, включая `src/local-map/local-map-contract.ts`, `src/local-map/local-map-mesh.ts`, `site/planet-globe/*`, `tools/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Интерактивный 3D-экран локальной карты и Dive-in переход в `/planet-globe/`)* | 1. **UI и разметка локальной карты в `site/planet-globe/index.html` и `site/planet-globe/planet-globe.css`:** добавить холст/оверлей локальной карты `#localMapStage` (`#localMapCanvas`), кнопку погружения `#diveLocalMapBtn` («Погрузиться на локальную карту участка →») в `#patchInspector`, кнопку возврата `#exitLocalMapBtn` («← На глобус планеты»), селектор видимой ширины участка `#localScaleSel` (`1250 → 625 → 312 → 156 → 78 → 39 → 20 → 10 → 5 → 2.5 → 1.2 км` по §9.4), кольцо перехода к 6 соседним ячейкам `#localNeighborNav` (слоты `0..5`) и HUD локальной карты `#localMapHud`.<br>2. **Dive-in Flow и 3D-камера локальной карты в `site/planet-globe/planet-globe.ts`:** при клике `#diveLocalMapBtn` (или URL `?place=&cell=&view=local`) на первом кадре подлёта запускать генерацию локального участка (`generateLocalMap`) по активному `Patch7`, загружать данные в `StructureRenderer` через порционный `enqueueWorkerData`/`processPendingUpload` (с fallback на `onWorkerData`), плавно проявлять (`fade-in`) 3D-сцену локальной карты с управлением камерой (орбита, наклон, панорамирование, зум), перецентровкой на соседнюю ячейку кольца (`0..5`) и возвратом на глобус без потери ракурса. | - `site/planet-globe/index.html`<br>- `site/planet-globe/planet-globe.css`<br>- `site/planet-globe/planet-globe.ts` | Все остальные файлы, включая `src/local-map/*`, `site/shared/planet-globe.ts`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Бенчмарк гейта G4 `bench_local_map_stage8.mjs` и документация Этапа 8)* | 1. **CLI-бенчмарк гейта G4 `tools/bench_local_map_stage8.mjs`:** замерять время `buildPatch7` + `generateLocalMap` + `buildMeshLibrary` на ансамбле участков (суша, побережье, речной узел, озёрная впадина) и разных масштабах (`1250 км … 1.2 км`), проверяя критерий гейта **G4** (`worker-генерация <= 150 мс`, `verifyPatchInvariants(patch).ok === true`, 0 зданий в воде по `buildingSpawnMask`).<br>2. **Документация Этапа 8:** создать отчёт `docs/stages/stage-8-local-map.md`, актуализировать разделы Этапов 7 и 8 в `docs/PREPARATION_PLAN.md` и внести сводку волны Stage-8 в `docs/HANDOFF.md` и `CHANGELOG.md`. | - `tools/bench_local_map_stage8.mjs`<br>- `docs/stages/stage-8-local-map.md`<br>- `docs/PREPARATION_PLAN.md`<br>- `docs/HANDOFF.md`<br>- `CHANGELOG.md` | Все остальные файлы, включая `src/local-map/*`, `site/planet-globe/*`, `package.json`, `tests/*` |

---

## 10. Матрица волны Stage-8.2 (Выделен только активный гекс + бесшовный планетарный горизонт с отдалёнными текстурами и плавным спуском до уровня)

Цель волны **Stage-8.2** — вернуть естественную непрерывную сферическую модель горизонта (как в `334b4c1`) без «пластилиновой ромашки» из 7 отдельных подушек и без просвечивающего сзади несоразмерного глобуса, но с тремя целевыми улучшениями:
1. **Выделен только активный центральный гекс** (`hexApothem = 0.8054 * focusRadiusM`, `centerHexDist = hexMetric2D(v_worldPos.yx)`): детальный меш $257 \times 257$ обрезается строго по контуру правильного шестиугольника активной ячейки и обрамляется тонкой аккуратной тактической границей без физических провалов (`bevelDropM`) и без сетки 6 колец по всему горизонту.
2. **Бесшовный простирающийся горизонт с рельефом, отдалёнными текстурами и постепенным ухудшением видимости**: вокруг выделенного центрального гекса расстилается единая непрерывная сферическая юбка (`97 × 57 = 5 529` вершин, `outerRadiusM = 6.5 * hexSpacingM = 7.475 * radiusPatchM`, `planetRadiusM = 3.6 * outerRadiusM`), сшитая по гексагональной метрике `clusterHexMetric` на границе `hexApothem` без единой ступеньки высоты, с процедурными разномасштабными текстурами породы/биомов и плавным нарастанием оптического блюра и атмосферной дымки от границы гекса к сферическому горизонту.
3. **Плавный двухфазный спуск вниз до уровня участка**: при погружении с глобуса (по кнопке или зумом колёсика мыши до упора на выбранной ячейке) камера сначала сближается с ячейкой на глобусе (`MIN_DISTANCE = 1.15`), а затем плавно спускается по дуге с суборбитальной высоты до тактического уровня над активным гексом (`1150 мс`) с возможностью свободного приближения до самого уровня земли/построек (`0.05 * R_patch`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Непрерывная сферическая юбка горизонта с гексагональной сшивкой высот и тесты `local-map-stage8.test.mjs`; слитый PR #178)* | 1. В `src/local-map/local-map-worker.ts` вернуть непрерывную полярную сетку горизонта `generateHorizonSkirt` (`SKIRT_ANGULAR_SEGMENTS = 96`, `SKIRT_RADIAL_RINGS = 56`, `SKIRT_COLLAR_RINGS = 14`, `5 529` вершин, `32 256` индексов, `innerRadiusM = 0.72 * radiusPatchM`, `hexSpacingM = 1.15 * radiusPatchM`, `outerRadiusM = 6.5 * hexSpacingM`, `planetRadiusM = 3.6 * outerRadiusM`) без 6 отдельных плит-лепестков и без провалов `bevelDropM`.<br>2. Сохранить экспортируемые `hexMetric2D`, `clusterHexMetric(x, y) = hexMetric2D(y, x)` и `mapNeighborCellsToSlots`, а сшивку воротника с `innerHeightfield` выполнить строго по гексагональной метрике `hexDist = clusterHexMetric(x, y)` относительно `hexApothem = 0.8054 * radiusPatchM` (`blend = 0` внутри `hexDist <= hexApothem`, плавный `smooth01` на интервале `[hexApothem, 1.18 * hexApothem]`), чтобы на шестиугольном срезе центра высоты совпадали 1-в-1.<br>3. Обновить `tests/local-map-stage8.test.mjs` под непрерывную юбку (`5 529` вершин / `32 256` индексов) и гексагональную непрерывность воротника. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Выделение только активного гекса, процедурные отдалённые текстуры и постепенная деградация видимости к горизонту; слитый PR #179)* | 1. В `src/local-map/local-map-shaders.ts` (`TERRAIN_FRAGMENT_SHADER`): обрезать квадратный центральный меш (`u_isSkirt < 0.5`) строго по контуру одного центрального гекса (`centerHexDist = hexMetric2D(v_worldPos.yx) > hexApothem`, где `hexApothem = u_focusRadiusM * 0.8054`).<br>2. Убрать закраску `FACET_BASE_COLOR`, фаски 6 соседей и 6-кольцевую гекс-сетку на юбке; вместо этого выделить **только активный центральный гекс** аккуратной тонкой тактической кромкой вдоль `centerHexDist ≈ hexApothem` прямо по рельефу.<br>3. Реализовать многомасштабную процедурную текстуру рельефа (мелкое зерно породы/грунта вблизи + среднемасштабная слоистость и пятнистость биомов/ложбин на средней дистанции) и плавное ухудшение видимости (`blur = smoothstep(hexApothem, u_fogEnd * 0.90, centerHexDist)`): внутри активного гекса `blur == 0`, а за его пределами мелкие детали, затем средние текстуры и нормали постепенно сглаживаются и уходят в воздушную дымку `u_horizonColor` / `u_fogColor` при непрозрачном куполе неба (`u_skyAlpha = 1.0` по умолчанию в `src/local-map/local-map-renderer.ts`). | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Непрозрачный экран горизонта и плавный двухфазный спуск камеры от глобуса до уровня земли; слитый PR #177)* | 1. В `site/planet-globe/planet-globe.css` и `site/planet-globe/planet-globe.ts` вернуть непрозрачный фон `.local-map-stage` и `#localMapCanvas` (`alpha: false`, `clearColor(0.015, 0.045, 0.075, 1)`), убрать постоянный `syncGlobeWithLocalCamera` в каждом кадре (чтобы сзади не просвечивал мелкий глобус).<br>2. В `site/shared/planet-globe.ts` уменьшить `MIN_DISTANCE` с `1.35` до `1.15` и добавить опциональный коллбэк `onZoomDive?: () => void` при прокрутке колеса мыши на приближение (`e.deltaY < 0`) у нижней границы дистанции (`targetDistance <= MIN_DISTANCE * 1.02`), чтобы зум колёсиком в выбранную ячейку на глобусе плавно переводил камеру на локальный уровень.<br>3. В `site/planet-globe/planet-globe.ts` реализовать **плавный двухфазный спуск до уровня участка**: сначала подлёт глобуса к ячейке (`globe.flyToDirection(centerCell.center, 1.18, 420)`) с параллельной подготовкой буферов локальной карты, затем плавный `fade-in` локальной сцены и мягкое пикирование камеры (`startLocalDiveInAnim`: `1150 мс`, `fromDist = targetDist * 4.8 → targetDist`, `fromPitch = 1.30 → LOCAL_REST_PITCH = 0.44`, `easeInOutCubic`), а также свободный зум колёсиком вплоть до уровня поверхности/построек (`minDist = Math.max(2, localMapRadiusM * 0.05)`) и обновление `docs/HANDOFF.md` + `CHANGELOG.md`. | - `site/planet-globe/planet-globe.ts`<br>- `site/planet-globe/planet-globe.css`<br>- `site/shared/planet-globe.ts`<br>- `docs/HANDOFF.md`<br>- `CHANGELOG.md` | Все остальные файлы, включая `src/local-map/*`, `tests/local-map-stage8.test.mjs` |

**Хотфикс Stage-8.2.1 (слитый PR #180)** — «зеркало континентальных озёр на юбке горизонта и запрет спавна на воде»: точечная правка трёх файлов кодового контура волны (объединённый хотфикс поверх веток Воркеров 1–2):

- `src/local-map/local-map-worker.ts`
- `src/local-map/local-map-shaders.ts`
- `tests/local-map-stage8.test.mjs`

---

## 11. Матрица волны Stage-8.3 (Планетарный масштаб юбки, гребневые хребты, дневной купол неба и панорамный ракурс долины — PR #183, #182, #181)

Цель волны **Stage-8.3** — превратить локальную сцену из «тактического стола» в живую планетарную долину: расширить планетарный масштаб сферической юбки горизонта с гребневыми хребтами и природной долиной, ввести дневной облачный купол неба в кадровом цикле рендера и зафиксировать панорамный ракурс камеры «изнутри долины на горный горизонт» (`LOCAL_REST_PITCH = 0.31`, светлый дневной тон очистки `gl.clearColor(0.52, 0.62, 0.74, 1)`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Планетарный масштаб юбки, гребневые хребты и природная долина; слитый PR #183)* | Планетарное масштабирование непрерывной сферической юбки в `src/local-map/local-map-worker.ts`: гребневые ridged-FBM хребты, природная долина активного гекса и согласованное сферическое проседание `planetCurvatureDropM`; обновление тестов `tests/local-map-stage8.test.mjs` под новую геометрию и параметры юбки. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Живая долина, скальные хребты и дневное облачное небо в шейдерах; слитый PR #182)* | Процедурные шейдеры долины и скальных хребтов в `src/local-map/local-map-shaders.ts`, подключение дневного облачного купола неба (`SKY_DOME_*`, `opaqueSkyDome`, `skyAlpha = 1.0`) и светлой атмосферной палитры в `src/local-map/local-map-renderer.ts`. | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Купол неба в кадровом цикле и панорамный ракурс долины; слитый PR #181)* | Передача камеры в `renderFrame` (купол неба на каждом кадре), панорамный ракурс «изнутри долины» в `site/planet-globe/planet-globe.ts` (`LOCAL_REST_PITCH = 0.31`, сдвиг точки прицела вперёд по взгляду, кривая двухфазного Dive-in `1150 мс`) и первый срез отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

---

## 12. Матрица волны Stage-8.4 (10 колец прогрузки горизонта 145×85, чёткие ближние 3–4 круга и плавное скольжение камеры между гексами — PR #184, #185, #186)

Цель волны **Stage-8.4** — расширить прогрузку местности вокруг активного гекса с 6 до **10 колец** (полярная сетка юбки **145 × 85 = 12 325 вершин**, `32 256` индексов), сохранить бесшовную детализацию первых 3–4 кругов гексов (старт тумана поднят до `0.64 · outerRadiusM`) и заменить мгновенный сброс камеры при переходе между ячейками на непрерывное 820-мс скольжение с сохранением пользовательского азимута.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Плотный горизонт 10 колец (145×85) и плавный рельеф; слитый PR #184)* | Уплотнение полярной сетки `generateHorizonSkirt` до `SKIRT_ANGULAR_SEGMENTS = 144` / `SKIRT_RADIAL_RINGS = 84` (**145 × 85 = 12 325 вершин**) в `src/local-map/local-map-worker.ts`, плавный рельеф 10 колец и обновление тестов `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Цельный переход активного гекса и чёткие ближние 3–4 кольца; слитый PR #185)* | Настройка шейдерной дымки и тактической кромки в `src/local-map/local-map-shaders.ts`: первые 3–4 круга гексов остаются полностью прозрачными и детальными, без шва на границе `Patch7` и без размытия ближней долины. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Плавное скольжение камеры между гексами и 10 колец в HUD; слитый PR #186)* | Бесшовный перелёт `startLocalNeighborFlyAnim` (`820 мс`, `easeInOutCubic`, сохранение пользовательского yaw), расширение панорамирования/клика/зума под 10 колец и честный HUD числа колец в `site/planet-globe/planet-globe.ts`; дополнение отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md` разделом 5. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

---

## 13. Матрица волны Stage-8.5 и хотфиксов 8.5.1 / 8.5.2 (Фиксированный физический масштаб гекса, 11-ступенчатая логарифмическая шкала видимой ширины и маркер воды — PR #189, #187, #188, #190, #191)

Цель волны **Stage-8.5** — зафиксировать физический радиус тактического гекса (`LOCAL_PATCH_BASE_RADIUS_M = 2500 м`, диаметр ≈4,5 км; 10 колец охватывают `R_outer ≈ 28,75 км`), чтобы селектор «Видимая ширина» управлял только дистанцией/наклоном камеры (`cameraDistanceForWidthKm`, 11 логарифмических ступеней `1250 … 1.2 км`) без растяжения меша и построек, а также ввести явный маркер воды в `terraformMap` и устранить ложную воду на суше.

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Явный маркер воды в `terraformMap`, гладкая интерполяция `Patch7` и направленный рельеф без вала; слитый PR #189)* | Маркер воды `terraformMap = 0` в `src/local-map/local-map-worker.ts`, гладкая интерполяция полей `Patch7`, направленный рельеф без периметрального вала и расширение `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Устранение ложной воды, билинейное сглаживание зон и тактический контур гекса; слитый PR #187)* | Шейдерные правки `src/local-map/local-map-shaders.ts`: устранение ложной воды, билинейное сглаживание зон и аккуратный тактический контур активного гекса. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Фиксированный физический масштаб гекса и камера «видимой ширины»; слитый PR #188)* | Константа `LOCAL_PATCH_BASE_RADIUS_M = 2500`, `cameraDistanceForWidthKm` / `cameraPitchForWidthKm`, 550-мс анимация камеры без перегенерации меша и честный HUD Δz в метрах в `site/planet-globe/planet-globe.ts`; раздел 6 отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |

**Хотфиксы волны (Zero File Overlap сохранён, правки только в файлах кодового контура Stage-8.5):**

| Хотфикс | Суть | Слитый PR и затронутые файлы |
|---|---|---|
| **Stage-8.5.1** | Переход по соседним ячейкам без рывка, мягкая кромка прибоя и прибрежный рельеф юбки | **PR #190:** `site/planet-globe/planet-globe.ts`, `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-worker.ts`, `tests/local-map-stage8.test.mjs` |
| **Stage-8.5.2** | Логарифмическая шкала всех 11 ступеней видимой ширины и возврат камеры в долину | **PR #191:** `site/planet-globe/planet-globe.ts` |

---

## 14. Матрица волны Stage-8.6 (Межъячеечная синхронизация горизонта, знаковая батиметрия, сквозные реки, 5 высотных поясов и ориентация камеры по Северу — PR #192, #194, #193)

Цель волны **Stage-8.6** — связать три уровня сцены в непрерывное целое: межъячеечную синхронизацию процедурного поля высот соседних канонических ячеек (общий `planetSeed`, отмена положительной `elevCalibration` на океанском патче, знаковая батиметрия `z < 0`), сквозные реки на любой высоте (`terraformMap = 0` + `isRiverStream`), 5 метрических высотных поясов суши и строгую ориентацию камеры локальной карты по Северу (`LOCAL_REST_YAW = -π/2`).

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Синхронизация берега и русел: `planetSeed`, знаковая батиметрия и отмена `elevCalibration` на океане; слитый PR #192)* | В `src/local-map/local-map-worker.ts`: единый `planetSeed` для соседних ячеек, знаковая батиметрия (`depth = elevation - seaLevel < 0`), принудительный `elevCalibration = 0` на водном центральном гексе и синхронизация берега/русел с непрерывным полем юбки; обновление `tests/local-map-stage8.test.mjs`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Объёмная глубина воды, реки на любой высоте и 5 высотных поясов суши; слитый PR #194)* | В `src/local-map/local-map-shaders.ts`: объёмная глубина воды и подводный склон шельфа, сквозные ленты русел (`isRiverStream`) с семплированием общей высотной функции на любой высоте и 5 высотных поясов рельефа (батиметрия, низменность, равнины, предгорья, горы/снег) со `smoothstep`-переходами. | - `src/local-map/local-map-shaders.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `src/local-map/local-map-renderer.ts`, `tests/local-map-stage8.test.mjs`, `site/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Ориентация камеры строго по Северу и переход к соседу без кадра сброса; слитый PR #193)* | В `site/planet-globe/planet-globe.ts`: `LOCAL_REST_YAW = -Math.PI / 2` (камера смотрит строго на Север, совпадение подписей «СОСЕДИ PATCH7» со стороной света) и переход к соседней ячейке без кадра сброса; раздел 7 отчёта `docs/stages/STAGE_8_PLANETARY_HORIZON.md`. | - `site/planet-globe/planet-globe.ts`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md` | Все остальные файлы, включая `src/local-map/*`, `tests/*`, `site/shared/planet-globe.ts`, `docs/HANDOFF.md`, `CHANGELOG.md` |




