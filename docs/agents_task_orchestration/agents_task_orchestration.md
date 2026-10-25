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





---

## 15. Матрица волны Stage-8.7 (Бесшовный межъячеечный переход, голографические квик-стрелки и рендер колец 1–5)

Цель волны **Stage-8.7** — сделать переход между каноническими гексами локальной карты визуально непрерывным (камера не дёргается, ни одного кадра сброса), дать игроку квик-навигацию «время от времени возникающими» голографическими стрелками, перпендикулярными граням активного гекса, и разрешить рендер кольцевых областей вокруг активного участка — **до 5 колец включительно**.

### 15.1. Модель колец: гексагональная геометрия + экспоненциальный LOD

Кольцо `k` вокруг активного гекса содержит ровно `6k` ячеек; число колец — до `k = 5`. Экспонента заложена не в форму кольца, а в **разрешение высотного поля**: каждая следующая кольцевая область вдвое грубее предыдущей, поэтому площадь покрытия растёт квадратично, а стоимость ячейки падает экспоненциально.

| Кольцо | Ячеек (`6k`) | `hfRes` | Накопительно (`3k(k+1)+1`) |
|---|---:|---:|---:|
| 0 (центр, `Patch7`) | 1 | 256 | 1 |
| 1 | 6 | 64 | 7 |
| 2 | 12 | 32 | 19 |
| 3 | 18 | 16 | 37 |
| 4 | 24 | 8 | 61 |
| 5 | 30 | 4 | **91** |

Бюджет CPU-буферов при `neighborRings = 5`: высотные поля `43 488` значений `f32` (**≈ 170 КиБ**) и `waterMask` `43 488` байт (**≈ 42,5 КиБ**), итого **≈ 216 КиБ** на патч — вдвое ниже лимита гейта **G6.3** (`≤ 512 КБ`).

**Факт волны (после слияния PR #200–#202 и интеграционного фикса 8.7.1).**
`RING_HF_RES` в воркере и в рендерере обязан совпадать: рассинхрон `[256, 32, 16, 8, 4, 2]` против `[256, 64, 32, 16, 8, 4]` приводил к отбраковке ячеек
слотами и распаду batch-отрисовки — **92 terrain-draw вместо 7**. После
выравнивания контракта: `ringGenMs ≈ 7 мс`, CPU-буферы колец ≈ 216 КиБ,
GPU-буферы колец **2,4 МБ** (позиции, нормали, локальные XY, вода, индексы),
draw-вызовы: **2 + число колец** (batch на кольцо), порядок `5 → 4 → 3 → 2 → 1 → центр → юбка`.
Ячейка `ringCells[i].cell` — **синтетический индекс отрисовки**, а не
канонический адрес сетки: кольца 2–5 строятся как плоская гексагональная
решётка в касательной плоскости вокруг `Patch7`. Переход между гексами
разрешён только по `activePatchReady.patch.cells[1..6]` (канон, И-1/И-3).

### 15.2. Матрица распределения файлов (`Zero File Overlap`)

| Воркер | Поток работ | Эксклюзивные файлы (`OWNED_FILES`) | Запрещено трогать (`FORBIDDEN_FILES`) |
|---|---|---|---|
| **Воркер 1**<br>*(Кольцевые области 1–5 в воркере, LOD-таблица и тесты; слитый PR #202 `4e86363`, фикс PR #203 `282d726`)* | Обход колец `1..5` от канонического центра `Patch7` по `GeodesicGrid.neighbors`, разрешения `RING_HF_RES = [256, 64, 32, 16, 8, 4]`, `LocalMapRingCell` и необязательные поля `ringCells` / `ringCellCount` / `ringGenMs` / `neighborRings`; детерминизм, учёт колец в LRU-кэше участков и полная эквивалентность прежнему поведению при `neighborRings = 0`. | - `src/local-map/local-map-worker.ts`<br>- `tests/local-map-stage8.test.mjs` | Все остальные файлы, включая `src/local-map/local-map-shaders.ts`, `src/local-map/local-map-renderer.ts`, `site/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 2**<br>*(Рендер колец 1–5 и бесшовный стык с юбкой горизонта; слитый PR #200 `257bd89`)* | Меш кольцевой ячейки из `heightfield` её разрешения в предвыделенных буферах без пересоздания VAO; юниформы `u_ringLevel` / `u_ringFade`; упрощение гипсометрии и воды по уровню кольца; передача цвета, тумана и нормалей в `u_fogColor` / `u_horizonColor` на границе «кольцо 5 → сферическая юбка»; порядок отрисовки `5 → 1 → центральный патч → юбка` без z-fighting; публичный `getRingStats()`. | - `src/local-map/local-map-shaders.ts`<br>- `src/local-map/local-map-renderer.ts` | Все остальные файлы, включая `src/local-map/local-map-worker.ts`, `tests/*`, `site/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 3**<br>*(Бесшовный переход между гексами и интеграция квик-навигации; слитый PR #199 `a0c167e`, фикс PR #204 `a24bfe8`)* | Чистая функция `rebaseLocalCameraState(...)` (сохранение мировой точки прицела при сдвиге на шаг центров `d_hex = 1.15 · R_patch`), атомарная подмена патча в одном кадре без пустого кадра и сброса `LOCAL_REST_YAW`, сглаживание остаточного рассогласования `≤ 220 мс` (`easeOutCubic`), сохранение `latest-wins`; интеграция `createLocalMapQuickNav(host, onPick)` в `#localMapStage` с делегированием в `requestLocalNeighbor`; диагностика G6.1 (`max |Δeye|`, `max |Δyaw|`) за флагом `?debug=local`. | - `site/planet-globe/planet-globe.ts`<br>- `site/planet-globe/planet-globe.css`<br>- `site/planet-globe/index.html` | Все остальные файлы, включая `site/planet-globe/local-map-quick-nav.ts`, `site/shared/*`, `src/*`, `tests/*`, `package.json`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 4**<br>*(Модуль голографических квик-стрелок; слитый PR #198 `0f338a0`)* | Новый `site/planet-globe/local-map-quick-nav.ts` по контракту `QuickNavHintInput` / `LocalMapQuickNav` / `createLocalMapQuickNav` и чистая `layoutQuickNavArrows(...)`; цикл `7 200 мс`, окно `2 600 мс`, ступенчатая задержка `90 мс` по слотам `0..5`, `fade-in 180 мс` / `fade-out 260 мс`; голографический шеврон `#00ff66` с `mix-blend-mode: screen`, hit-area `≥ 44 × 44` CSS px, поддержка `prefers-reduced-motion`, запрет `eval`/`new Function` (CSP); тест `tests/local-map-quick-nav.test.mjs` и подключение его в `npm test`. | - `site/planet-globe/local-map-quick-nav.ts`<br>- `tests/local-map-quick-nav.test.mjs`<br>- `package.json` | Все остальные файлы, включая `site/planet-globe/planet-globe.ts`, `planet-globe.css`, `index.html`, `src/*`, `docs/HANDOFF.md`, `CHANGELOG.md` |
| **Воркер 5**<br>*(Документация волны; запускается последним, после слияния PR 1–4; PR #205)* | Сводные записи волны: `CHANGELOG.md`, `docs/HANDOFF.md` (§1 «Статус», §2, §5, §8), новый раздел 7 в `docs/stages/STAGE_8_PLANETARY_HORIZON.md`, проставление номеров слитых PR в §15 настоящего документа и строка статуса «Местность до ~1 км» в `docs/PREPARATION_PLAN.md`. Числа — только из отчётов воркеров и кода, без домыслов. | - `docs/HANDOFF.md`<br>- `CHANGELOG.md`<br>- `docs/stages/STAGE_8_PLANETARY_HORIZON.md`<br>- `docs/agents_task_orchestration/agents_task_orchestration.md`<br>- `docs/PREPARATION_PLAN.md` | Все остальные файлы, включая `site/*`, `src/*`, `tests/*`, `tools/*`, `package.json`, `.github/*`, `data/*` |

**Ссылка на внешний аудит.** Замечания стороннего агента по ядру генерации разобраны и занесены в backlog **A-1…A-10** в [`docs/stages/planet-core-audit-2026-10-23.md`](../stages/planet-core-audit-2026-10-23.md) (§5 — первый проход, §7 — политика радиуса, §8 — второй проход с проверкой по коду); к файлам этой волны они не относятся. Там же закрыт разрыв **Р-3**: битый скрипт `npm run verify:hashes` и отсутствующий полноценный FULL EQ-гейт — одна и та же проблема (пункт A-10).

**Стык `package.json`.** Единственный общий файл волны (подключение нового теста в `npm test`) отдан ровно **Воркеру 4** (правило О-1); остальным воркерам его правка запрещена.

**Стык `planet-globe.ts` ↔ `local-map-quick-nav.ts` (О-3, Interface-First).** Имя файла и сигнатуры `QuickNavHintInput`, `LocalMapQuickNav`, `createLocalMapQuickNav(host, onPick)` зафиксированы дословно до старта волны. Воркер 3 интегрирует модуль по контракту через временный локальный шим (5 строк, с комментарием «удалить после слияния PR Воркера 4») и не создаёт сам модуль; Воркер 4 не правит страницу.

### 15.3. Гейты волны (продолжение G5 → G6)

| Гейт | Критерий |
|---|---|
| **G6.1** | Переход между гексами непрерывен: `0` кадров со скачком `|Δyaw| > 0.002` рад или смещением точки прицела `> 1` CSS px; нет пустых кадров и сброса ракурса |
| **G6.2** | Квик-навигация: 6 стрелок, цикл `7 200 мс`, hit-area `≥ 44 × 44` CSS px, `prefers-reduced-motion` — без пульса и скан-линии, клики работают |
| **G6.3** | Кольца, две независимые части: **(а) CPU** — `ringGenMs ≤ 20 мс` и новые типизированные буферы `≤ 512 КБ` на патч при `neighborRings = 5`; **(б) GPU** — суммарные кольцевые буферы `≤ 4 МБ`, `0` видимых швов «кольцо 5 → юбка», steady-кадр `p95 ≤ 20 мс`. Формулировка 8.7 ошибочно смешивала CPU- и GPU-бюджет в одном лимите `512 КБ`; разделение введено по факту замера (`216 КиБ` CPU против `2,4 МБ` GPU) |
| **G6.4** | Матрица проверок зелёная: `tsc`, `eslint`, `npm run build`, `node --test`, `verify:publish`, `check.yml` 4/4 |

### 15.4. Порядок запуска

Воркеры 1–4 стартуют одновременно в отдельных ветках от `main`; Воркер 5 запускается после слияния PR 1–4 и проставляет фактические номера PR в таблицу §15.2. Каждый воркер останавливается перед merge — слияние выполняет Гайдлайнер после приёмки по гейтам G6.1–G6.4.

#### Урок волны

Временный шим по контракту **О-3 (`Interface-First`)** обязан быть заменён на импорт боевого модуля до закрытия приёмки волны: после независимого слияния PR #199 (`a0c167e`) и PR #198 (`0f338a0`) заглушка `createLocalMapQuickNavShim`, возвращавшая `null`, осталась активной в `site/planet-globe/planet-globe.ts`, из-за чего стрелки вообще не рисовались на сцене и гейт **G6.2** не достигался даже при полностью зелёном CI (устранено интеграционным фиксом Stage-8.7.2, PR #204 `a24bfe8`). Аналогично зеркальные константы межмодульного контракта (`RING_HF_RES` между воркером и рендерером, где рассинхрон давал `92` terrain-draw вместо `7` — фикс Stage-8.7.1, PR #203 `282d726`) должны проверяться сквозным интеграционным шагом Гайдлайнера сразу после слияния параллельных веток.

---

## 16. Матрица волны SW-1 (Ядро под-уровня Этапов 9–12: буквенный адрес, лестница глубины, единицы)

Дата постановки: **25 октября 2026 года**. Статус: **волна слита 25.10.2026** (Воркер 1 — PR #244 `c9c36b4`, Воркер 2 — PR #245 `86ded61`, сквозной гейт Гайдлайнера — PR #248 `dd1f2ea`, документация волны — PR #249; факт и требование к `SW-3` — §16.9).
Режим — параллельный (`Tri-Agent Wave`), контур — секториальный под-уровень Этапов 9–12.

Источник чисел — гайдлайнер [`../stages/stage-9-12-sector-deep-render-plan.md`](../stages/stage-9-12-sector-deep-render-plan.md)
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

### 16.4. Гейты волны

| Гейт | Критерий приёмки `SW-1` |
|---|---|
| **G7.1 Адрес** | `173/173` уникальных адреса; round-trip `≤ 1e-9`; `11/11` golden vectors (8 столиц + 3 контрольные точки); парсер принимает `KP·REQHC`, `kp-reqhc`, `REQHC`, `KP-R-E-Q-H-C` и отвергает мусор; `mapSize ≠ 10 000` → `verify:address` падает с кодом `1` |
| **G7.2 Лестница** | 13 записей без дыр и в порядке `L0…L9, S0…S2`; `levelForWidth(19,53125) = 9` и `levelForWidth(100) = 6`; гистерезис `±12 %`; `0` миганий на 1 000 прогонах монотонного зума в обе стороны; `markerDiameter(visibleWidthForLevel(n))` совпадает с `markerPx` таблицы `±0,06` (максимальное расхождение формулы и округлённой таблицы — `0,045` на `L1`) |
| **G7.3 Единицы (часть И-16)** | `formatDistanceLy` даёт ровно `8,4`/`88,4`/`90,79`/`108,07`/`1 302,9`/`5 776,3`/`≥ 10 000`; `0` вхождений `ly`, `св. лет`, `св.год` в выхлопе модуля |
| **G7.4 Матрица проверок** | `npm run typecheck`, `npm run lint`, `npm run build`, `npm run verify:publish`, `npm run verify:address`, `git diff --check` — зелёные **в нашей ветке**; `npm test` — три новых файла зелёные, и **ни одного нового падения** относительно прогона `main` на момент старта волны (снимается один раз перед стартом, см. §16.8); job «Сборка на ubuntu-24.04/26.04» зелёный. Красный job «Скрипты сайта» в зону приёмки `SW-1` **не входит** (решение владельца 25.10.2026) |

### 16.5. Порядок запуска и приёмка

1. Воркеры 1 и 2 стартуют одновременно в отдельных ветках от `main`; останавливаются
   **строго перед merge**.
2. Гайдлайнер принимает каждый PR по `git diff --name-only origin/main...HEAD` (только
   `OWNED_FILES`), `gh pr checks <N>` `4/4` и `gh pr merge <N> --squash --admin`.
3. **Сквозной интеграционный шаг (обязателен, урок Stage-8.7.1/8.7.2):** после слияния обоих
   PR на `main` Гайдлайнер одной командой проверяет, что `levelSpec(0…9).addressLetters`
   монотонно не убывает и не превышает `5`, а `markerDiameter(visibleWidthForLevel(n))`
   совпадает с `markerPx` из `LEVELS` (`±0,06`, фактический максимум `0,045`). Расхождение — блокер, а не «допишем в SW-3».
4. Воркер 3 запускается после слияния PR 1–2 и закрывает документацию волны.

### 16.6. Учтённые уроки прошлых волн

| Урок | Как учтён в `SW-1` |
|---|---|
| Stage-8.7.2: временный шим по О-3 дожил до прода | шимов нет: `level-ladder.ts` не зависит от `sector-address.ts`, зависимость снята архитектурно, а не заглушкой |
| Stage-8.7.1: зеркальные константы (`RING_HF_RES`) разъехались незаметно | единственная таблица чисел — §16.3; сверка `LEVELS ↔ markerDiameter` вынесена в сквозной шаг Гайдлайнера (§16.5 п. 3) |
| Stage-8.7: общий `package.json` мог уйти двум воркерам | `package.json` и `check.yml` — только Воркер 2 |
| CR-01 PR 4: незакоммиченная сессия потеряна | первый содержательный коммит — сразу в целевой файл, `git push -u origin HEAD` + сверка `HEAD == origin` |
| Гайдлайнер: не читать простыни | приёмка по `--name-only`, `gh pr checks` и 15-строчной сводке воркера |

### 16.7. Проверка расчётной базы перед стартом (Гайдлайнер, 25.10.2026)

Прогон по `data/systems.csv` и `data/meta.json` (не по документации):

| Проверка | Ожидалось | Факт |
|---|---|---|
| Систем в снимке | `173` | `173` ✔ |
| Golden vectors столиц | `8` адресов из §7.5 | `8/8` совпали ✔ |
| Контрольные точки `(0,0)`, `(9 999, 9 999)`, `(2 500, 2 500)` | `AAAAA`, `YYYYY`, `GGGGG` | `3/3` совпали ✔ |
| Уникальность адресов `T4` | `173/173` | `173/173` ✔ |
| Минимальная пара систем | Зеф ↔ Орна `50,0` св.г. | `50,01` ✔ |
| `mapSize` в `data/meta.json` | `10 000` | `10 000` ✔ |
| Файлов Node-тестов в `npm test` | `17` (план говорит «сейчас 17») | `17` ✔ |

Одно расхождение с текстом гайдлайнера зафиксировано осознанно и внесено в контракт §16.3:
пороги уровней — **точные** `10 000 / 2ⁿ` (`156,25 / 78,125 / 39,0625 / 19,53125`), потому что
округлённые значения (`156 / 78 / 39 / 19,5`) несовместимы с контрольным вектором
`levelForWidth(19,53) = 9` из §10.4. Округлённые числа остаются только в тексте гайдлайнера
как читаемые подписи.

### 16.8. Базовый прогон `main` красный (справочно, вне зоны `SW-1`)

> **Решение владельца 25.10.2026: планетарные тесты к задаче не относятся.** Волна `SW-1`
> принимается без зависимости от их состояния; микро-волна `SW-0` **снята с расписания**;
> голдены, пороги `m.11`/`m.14`/`plainSectorDeg` и файлы планетарного контура не трогаются
> никем из участников под-уровня Этапов 9–12. Раздел сохранён как справка (правило
> «дописывать, не перезаписывая») и как единственная защита от повторного разбора: числа
> ниже объясняют, почему job «Скрипты сайта» красный, и почему это не блокер нашей волны.
> Рабочая формулировка критерия — `G7.4` в §16.4.

При открытии волны `SW-1` выяснилось, что job «Скрипты сайта» (`check.yml`) красный на всех PR.
Это **не «всплывшая» регрессия и не следствие правок волны**: причина установлена и уже
задокументирована автором — **PR #235 (`fa18ef41`, 24.10.2026 18:45) «W28 field contrast
(stage-8.14)»** и его отчёт [`../stages/stage-8.14-field-contrast-2026-10-24.md`](../stages/stage-8.14-field-contrast-2026-10-24.md)
(§6: `npm test` — `180 тестов: 172 pass, 8 fail`; §6.1 — тот же список из восьми).

**Что изменил W28/W28b:** двухветвевой контраст поля высот (суша `+5·d²` от пивота `0,40`,
океан `−0,65·d` от `0,12`), `max 0,66 → 0,998`, углубление океана и бамп версии поля
`GEOGRAPHY_VERSION` `c100-soft-v1 → c100-soft-v3`. Одновременно сдвинулось всё, что закрепляло
старый рельеф: гребни юбки, стык воды/суши, голдены генерации, гипсометрия, метрика LOD и
константа версии. В отчёте прямо сказано, что тесты **не чинились по границе файлов**
(`tests/local-map-stage8.test.mjs`, `tests/local-map.test.mjs` были в `FORBIDDEN_FILES` волны) —
то есть долг был передан следующей волне, а не забыт.

| № | Тест | Что закреплено (данные) | Факт на `6d25789` | Класс |
|---:|---|---|---|---|
| 35 | Stage-8.5: юбка без кругового вала | `plainSectorDeg ≥ 30°` — широкий равнинный сектор на внешнем кольце | `25°` | **A** — пин под старый рельеф; нужна визуальная сверка владельцем |
| 47 | Stage-8.10b: golden-хэш `generateLocalMap + generateHorizonSkirt` | `51971e1187…` (стык A-17) | `3beaf8738a…` | **A** — голден пересчитать один раз, с записью причины |
| 48 | Stage-8.10b: ленивый чанк и golden-ответ | тот же хэш | тот же новый хэш, что и прямой путь (значит, дело не в загрузчике) | **A** — то же |
| 50 | A-17 diagnostic: числа стыка и берега `#43533…#43537` | `0` полностью водных ячеек из `5` | `5` из `5` полностью водные | **A/B** — триаж: либо стык реально ушёл под воду (пересмотреть контрольные ячейки), либо регрессия воды |
| 61 | стенд: речные метрики мира A-17 | хотя бы один створ `«N/M створа»` | ни одного | **A/B** — следствие №50 |
| 75 | W26b п.2: `m.14` (`measureLodConsistency`) | `≤ 2 м` на живой карте | `2,186 м` на `#37519` | **B** — реальный долг кода (разрешение грубых LOD, работа `W23`); §7.2 отчёта: «порог не менять, тест `75` не ослаблять» |
| 76 | W26b п.3: `m.11` (`measureHypsometry`) | `16 596` суши, `p90 0,4685`, `45,93 %` | `p90 0,492`; по отчёту `27,49 %` (и это `PASS` в полосе `20…35 %`) | **A** — перебазировать на числа §4.1 отчёта |
| 87 | Stage-8.10b: контракт не тащит ядро наверх | `GEOGRAPHY_VERSION === 'c100-soft-v1'` | `c100-soft-v3` | **A + C** — тест перебазировать (`v3` — намеренно, `W28b`), плюс док-дрифт: `src/AGENTS.md` §3/И-1 всё ещё описывает `c100-soft-v2` |

Классы: **A** — устаревший пин под новое поле (перебазировать с записанной причиной),
**B** — реальный долг кода (порог не ослаблять), **C** — дрейф документации/инварианта.

**Состав «восьмёрки» зависит от базы и порядка прогона.** `docs/HANDOFF.md` (раздел
«Эксплуатационные особенности», база `19bb9bf`) относит восьмое падение к
`tests/local-map-texture-812d.test.mjs` — «проходит отдельно, падает только в общем прогоне»;
на `6d25789` (полный прогон, Node `22.22.3`) восьмое — `tests/local-map.test.mjs:303` (`v1` против `v3`),
а texture-тест проходит. Поэтому базовую линию нельзя держать «по памяти»: снимать её нужно
дважды — полным `npm test` и пофайлово.

**Решение Гайдлайнера (не отменяет `И-11`):**

1. Воркеры `SW-1` **не правят** ни один из этих файлов и не «подгоняют» голдены: контур
   чужой, правка чужого файла — нарушение `Zero File Overlap`. Критерий `G7.4` — «`0` новых
   падений» относительно таблицы выше.
2. Ремонт базовой линии **не планируется** (решение владельца 25.10.2026): постановка §16.8.1
   оставлена как архив на случай возврата, `SW-0` не запускается. Диагностика `m.14`
   (разрешение кольца 1 `64 → 80 / 96 / 128` даёт `2,186 → 2,103 / 2,124 / 2,096` м при бюджете
   кольцевых буферов до `2,8 МБ`) — тоже вне задачи, к `SW-1` не относится.
3. Job «Скрипты сайта» красный по этим причинам **не влияет** на приёмку `SW-1`; блокером для
   нашей волны является только падение, вызванное её собственными файлами.

**Что уже проверено Гайдлайнером по `main` (25.10.2026):** `npm run typecheck` — зелёный;
`node tests/travel-planner.test.js` — `passed`; `npm run lint` — зелёный; `npm run build` —
`✓ built`; `npm run verify:publish` — `7 маршрутов, 36 hashed-ассетов`; падение локализовано
исключительно в восьми тестах таблицы выше.

### 16.8.1. Постановка `SW-0` — ремонт базовой линии планетарного контура (**снята с расписания 25.10.2026**)

> Статус: **не запускается**. Владелец 25.10.2026 вывел планетарные тесты из задачи
> (ремейк/редизайн карты сектора). Текст сохранён как архив постановки: если работа
> возобновится, матрица `OWNED_FILES`, запреты и гейты `G0.1…G0.5` готовы к запуску.

Цель: вернуть job «Скрипты сайта» в зелёный, **не ослабляя ни одного порога** и не пересчитывая
голдены вслепую. Каждая перебазировка обязана иметь записанную причину и ссылку на числа.

| Пункт | Работа | Файлы (`OWNED_FILES`) |
|---|---|---|
| `S0` | Снять базовый прогон дважды — `npm test` целиком и пофайлово — и приложить оба списка в отчёт. Без этого «0 новых падений» непроверяемо | `docs/stages/stage-8.14-field-contrast-2026-10-24.md` (новый раздел «Ремонт», дописывается в конец) |
| `S1` | Класс A: перебазировать пины на числа из §4.1 отчёта `W28` (`p10 = 0,2954`, `p50 = 0,3540`, `p90 = 0,493`, `max ≈ 0,998`, суша — новое значение, гипсометрия `27,49 %`), каждое — с комментарием «переснято под поле `c100-soft-v3`» | `tests/local-map-stand.test.mjs` |
| `S2` | Класс A: пересчитать золотой хэш локальной карты **один раз** (второй после бампа версии, первый — в `tools/planet_hash_fixtures.json`), записать старый и новый хэш в отчёт; пересмотреть контрольные ячейки `#43533…#43537`, если стык ушёл под воду по физике, а не по ошибке | `tests/local-map-stage8.test.mjs` |
| `S3` | Класс C: привести `src/AGENTS.md` §3/И-1 к фактической версии поля (`c100-soft-v3`; `v1`/`v2` остаются валидными для совместимости), добавить запись о `8.14`/`W28` в `CHANGELOG.md` — её там нет — и статус в `docs/HANDOFF.md` | `src/AGENTS.md`, `CHANGELOG.md`, `docs/HANDOFF.md`, `tests/local-map.test.mjs` (пин версии) |
| `S4` | Класс B: `m.14 = 2,186 м` при пороге `≤ 2 м` — решение владельца: либо работа `W23`-follow-up (разрешение грубых LOD, порог и тест не трогать), либо явная фиксация «принято» в отчёте. Ослаблять `≤ 2 м` запрещено | `src/local-map/*` — **только** при выборе «чинить код» |

**Запрещено в `SW-0`:** менять пороги под результат (`гипсометрия 20…35 %`, `m.14 ≤ 2 м`,
`plainSectorDeg ≥ 30°`), перегенерировать голдены без записанной причины, править
секторальный контур (`src/atlas/*`, `site/sector/*`, `templates/*` — зона `SW-1…SW-4`).

**Гейты `SW-0`:** `G0.1` — `npm test` `180/180` и в полном прогоне, и пофайлово;
`G0.2` — diff по порогам пуст (`гипсометрия`, `m.14`, `plainSectorDeg`);
`G0.3` — у каждой перебазировки есть строка «было → стало + причина + ссылка на §4.1 отчёта»;
`G0.4` — `CHANGELOG`/`HANDOFF`/`src/AGENTS.md` описывают `c100-soft-v3`; `check.yml` `4/4`;
`G0.5` — после зелёного прогона владелец решает, включать ли job «Скрипты сайта» в обязательные
статус-чеки (сейчас в ruleset `BotsOverwrite` обязательных чеков нет — см. `docs/HANDOFF.md`).

### 16.9. Факт волны `SW-1` и требование к `SW-3`

Волна слита **25.10.2026**: Воркер 1 — PR #244 `c9c36b4` (кодек адреса
`src/atlas/sector-address.ts`, верификатор `tools/verify_sector_address.mjs`,
тест `tests/sector-address.test.mjs`); Воркер 2 — PR #245 `86ded61` (лестница
`src/atlas/level-ladder.ts`, единицы `src/atlas/sector-units.ts`, тесты
`tests/sector-ladder.test.mjs` и `tests/sector-units.test.mjs`, `package.json`,
`.github/workflows/check.yml`); Гайдлайнер — PR #248 `dd1f2ea` (сквозной гейт
`tools/verify_sector_core.mjs` и перенос верификаторов выше `npm test`).
Документация волны — Воркер 3, PR #249 `36448ec` (слит 25.10.2026).

| Проверка (прогон на `main` после слияния) | Факт |
|---|---|
| `npm test` | **195 тестов, 187 pass, 8 fail** — все 8 падений — известная планетарная база Stage-8 (см. §16.8), вне задачи сектора; новых падений нет |
| `npm run verify:address` | **173 системы, 173 уникальных адреса, golden vectors 11/11, максимум round-trip 0 св.г.** |
| `npm run verify:sector-core` | **3 032 проверки, 0 провалов**; максимум расхождения `markerDiameter` с таблицей `LEVELS` — `0,0448 px` (L1); отклонение центра узла `≤ 2,263` св.г. |
| `npx tsc --noEmit`, `npx eslint site src`, `npm run build`, `npm run verify:publish`, `git diff --check` | зелёные |

Закреплённые числа ядра: пороги уровней — точная геометрия `10 000 / 2ⁿ`
(`10 000 / 5 000 / 2 500 / 1 250 / 625 / 312,5 / 156,25 / 78,125 / 39,0625 /
19,53125` св.г.); `addressLetters` по уровням `L0…L9` — `0,1,2,2,3,3,4,4,5,5`;
адреса различны уже на тире `16` св.г. (минимальная пара систем —
Зеф ↔ Орна `50,01` св.г.).

**Дефект приёмки 1 — верификатор не запускался ни разу (исправлен в PR #248).**
`npm run verify:address` стоял после `npm test` в одном shell-блоке `check.yml`;
красный `npm test` обрывал выполнение блока, и верификатор адресов не доходил до
запуска. Исправление: верификаторы подняты выше `npm test`, в workflow оставлен
объясняющий комментарий. Урок для следующих волн: гейт, чьё выполнение зависит от
красной базовой линии, ставится **выше** неё, а не ниже.

**Дефект приёмки 2 — `L9` недостижим при пределе зума `19,53125` св.г.** Гистерезис
`±12 %` в `levelForWidth` означает, что уровень с номинальной шириной `W(n)`
активируется при входе только на `W(n) · 0,88`, а удерживается при отходе до
`W(n) · 1,12`. Для `L9` (`W = 19,53125` св.г.) вход требует `17,1875` св.г., выход
допускает до `21,875` св.г. Если кламп зума в `SW-3` ограничить номиналом
`19,53125`, уровень `L9` не активируется никогда и апертура системы не показывается.
Это **не дефект `levelForWidth`**, а обязательное требование к постановке `SW-3`:
кламп зума обязан доходить до **`MIN_REACHABLE_WIDTH = 17,1875` св.г.** При этой
ширине `markerDiameter = 36,24 px`, что укладывается в кламп диаметра `40 px`,
поэтому таблица `LEVELS` и формула диаметра правок не требуют.

---

## 17. Матрица волны SW-2 (Процедурное поле и вывод растра из эксплуатации)

Дата постановки: **25 октября 2026 года**. Статус: **волна открыта**, кодовые PR не созданы.
Источник чисел — гайдлайнер [`../stages/stage-9-12-sector-deep-render-plan.md`](../stages/stage-9-12-sector-deep-render-plan.md)
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

### 17.7. Гейты волны

| Гейт | Критерий |
|---|---|
| **G7.3 Ноль растра** | исполняемая форма: `npm run verify:no-raster` возвращает `0` и проверяет — в `.publish` нет `assets/tiles*` и `assets/map-preview*`; в репозитории нет `assets/src/koprulu-sector.jpg`; в рантайме (`src/atlas/*.ts`, `site/shared/links.ts`) `0` вхождений `CONFIG.tiles`, `rasterMode`, `sectorMapPreview`, `TilePyramid`; в `check.yml` нет требования `assets/tiles.json`; в `pages.yml`/`assets.yml` нет шага и кэша тайлов. Плюс `verify:publish` — `7/7` |
| **G7.6 Детерминизм** | CPU-путь: SHA-256 `ImageData` совпадает на двух прогонах (обязательно, побитово). GPU-путь: два прогона в одном браузере — побитово; **между браузерами** — допуск `max |Δchannel| ≤ 2` и среднее `≤ 0,5` |
| **G7.4 Производительность** | `L0` — `p95 ≤ 16,7 мс` (десктоп) и `≤ 33,3 мс` (Redmi Note 10); при непрерывном зуме нет кадров `> 100 мс`; поле `≤ 32 МБ` GPU; CPU-фолбэк не блокирует главный поток дольше `50 мс` за кадр |
| **G7.5 Загрузка** | `0` запросов `/assets/tiles*` и `/assets/map-preview*` в Network при входе на `/sector/` и `/minimal/` |
| **G7.4 Матрица** | как в §16.4: собственные проверки зелёные, `0` новых падений относительно базы на момент старта, «Скрипты сайта» вне приёмки |

**Поправка Гайдлайнера к `G7.6` (обязательна к учёту).** Формулировка гайдлайнера «хэш
`ImageData` совпадает на двух браузерах» **недостижима** для GPU-пути: `float32` в шейдере
округляется по-разному на разных вендорах, и побитовое совпадение между драйверами не
гарантируется ни одним стандартом. Поэтому гейт разделён: побитовость требуется от CPU-пути
и от повторных прогонов в одном браузере, между браузерами — измеряемый допуск. Ослаблением
порога это не является: `R-1` защищает именно CPU-эталон, а он побитовый.

**Предпросмотр до необратимого удаления.** `npm run sector-field:preview` (Воркер 1) обязан
без браузера отрисовать оба пресета на ширинах `L0 / L4 / L9` через CPU-путь и записать шесть
PNG в `docs/stages/evidence/sw2-field/`. Владелец смотрит **пиксели поля** до слияния `SW-2B`,
а не после. Это заменяет протокол скриншотов «до/после» (§17.2 п. 2).

### 17.8. Ловушки, которых нет в плане гайдлайнера

| № | Ловушка | Что делать |
|---|---|---|
| 1 | `check.yml:57` требует `.publish/assets/tiles.json` | убрать строку из списка в том же PR `SW-2B`, иначе job «Сборка на ubuntu-24.04/26.04» падает с «нет файла» |
| 2 | `.github/workflows/assets.yml` собирает тайлы и публикует артефакт | убрать шаг артефакта и пути тайлов; workflow остаётся для галактики и макетов |
| 3 | `data/meta.json` → `assets.imageVersion` читает конвейер `tools/vite/asset-utils.ts:37` для кэш-бастинга `?v=` | удалять только `hasRaster`/`preview`/`tiles`/`version`; **`imageVersion` обязан остаться**, иначе слетает версионирование картинок галактики |
| 4 | `SECTOR_SOURCE` в `build_assets.py` используется дважды: `build_tiles` (127) и проверка свежести (318…325) | удалить обе точки и константу; `--check` не должен падать на `FileNotFoundError` |
| 5 | `site/AGENTS.md:61`, `tools/AGENTS.md:55` описывают тайлы как действующий контур (SSoT) | правка в `SW-2B`-док-шаге (Воркер 3), а не в `SW-2A` |
| 6 | `sectorMapPreview` читается только из `tile-pyramid.ts:84,87` | удалять вместе с модулем одним PR; других потребителей нет (проверено `grep` по `src/`, `site/`, `tools/`) |

### 17.9. Порядок запуска: почему волна идёт последовательно

> **Пересмотрено 25.10.2026.** Расписание ниже заменено параллельной схемой — см. `§17.13`.
> Правило «никаких шимов, потребитель импортирует боевой модуль» остаётся в силе; меняется
> только выдача карточек и порядок слияния, а не контракт.

**Решение Гайдлайнера: `SW-2A` → `SW-2B` → документация. Параллельной тройки в этой волне нет.**

Причина не в объёме, а в стыке. По правилу О-3 воркер-потребитель обязан опираться на
зафиксированную сигнатуру, не дожидаясь ветки соседа, — а единственный способ сделать это без
нового модуля — временный шим. Именно так в `Stage-8.7` заглушка `createLocalMapQuickNavShim`
дожила до прода и стрелки не рисовались вообще при полностью зелёном CI (PR #204). Здесь цена
такой ошибки выше: `SW-2B` **удаляет** растр, и если поле окажется не подключённым, откатиться
будет некуда — эталона нет по решению `D-11`.

Поэтому:

1. `SW-2A` — поле, предпросмотр и тесты. Ничего не удаляется, рантайм не меняется, `main`
   остаётся зелёным, владелец смотрит PNG.
2. `SW-2B` — интеграция и удаление. Ветка строится от `main`, **уже содержащего** боевой
   `sector-field.ts`, поэтому импорт настоящий, шимов нет.
3. Документация — после `SW-2B`, потому что доменные `AGENTS.md` описывают удалённый контур.

Оценка: `SW-2A` — `8–10` агено-часов, `SW-2B` — `10–14`, документация — `3–4`; итого
`21–28` против `14–20` в плане гайдлайнера. Разница — цена отказа от параллелизма и двух
пресетов; она принята осознанно, потому что это единственная необратимая волна.

### 17.10. Учтённые уроки

| Урок | Как учтён |
|---|---|
| Stage-8.7.2: шим по О-3 дожил до прода | волна последовательная, потребитель импортирует боевой модуль из `main` |
| SW-1: гейт, стоящий после красного шага, не выполняется | `verify:no-raster` ставится **выше** `npm test` в `check.yml` (как `verify:sector-core`) |
| SW-1: критерий «0 новых падений» проверяем только при зафиксированной базе | база снимается один раз перед стартом `SW-2A` и переносится в `§17` при первом коммите волны |
| `R-1`: эталона для сравнения нет | предпросмотр PNG на CPU до необратимого шага; исходник восстанавливается из истории Git |
| План гайдлайнера пропустил два файла CI и `imageVersion` | §17.3 и §17.8 фиксируют их до старта, а не после падения сборки |

### 17.11. База перед стартом `SW-2A` (зафиксирована 25.10.2026)

Правило `§17.10` («база снимается один раз перед стартом и переносится в `§17`») выполнено.
База снята на коммите `37afca0` (`main` после слияния `#251`), собственным прогоном, не по
логам CI:

| Проверка | Результат на базе | Комментарий |
|---|---|---|
| `npm test` | `195` проверок: `187` pass, `8` fail | все `8` — планетарная база Stage-8, **вне зоны приёмки** (решение владельца 25.10.2026) |
| `verify:address` | `173/173`, golden `11/11`, round-trip `0` | зелёный |
| `verify:sector-core` | `3032` проверки, `markerPx Δ ≤ 0,0448 px`, центр `≤ 2,263` св.г. | зелёный |
| `tsc` / `eslint site src` / `npm run build` / `verify:publish` / `git diff --check` | зелёные | `build_assets.py --check` не вызывается на этом шаге |

**Правило приёмки для `SW-2A` и `SW-2B`:** новые падения относительно этой таблицы — блокер.
Число `fail = 8` в `npm test` — норма, а не регрессия; «Скрипты сайта» в зону приёмки не входит.
Если база понадобится заново (например, `main` ушёл вперёд), она снимается **один раз** перед
стартом шага и дописывается сюда отдельной строкой с датой и коммитом — задним числом база
не переписывается.

### 17.12. Приёмка `SW-2A`: что принято и что отправлено на попытку 2

PR `#253` (ветка `arena/4c8425a7-…`, HEAD `0cba4f0`), проверял собственными прогонами на
распакованном дереве, не по отчёту воркера.

**Принято без замечаний.**

| Проверка | Мой результат |
|---|---|
| Границы О-1 | `10` файлов в PR ровно из `OWNED_FILES`: три новых исходника, шесть PNG, `package.json` (+3 строки: скрипт `sector-field:preview`, `tests/sector-field.test.mjs` в списке тестов) |
| `npm ci` / `typecheck` / `lint` / `build` | зелёные |
| `npm test` | `203` проверки, `195` pass, `8` fail — ровно база `§17.11`, новых падений нет |
| `verify:address` / `verify:sector-core` | `173/173`, golden `11/11`, round-trip `0`; `3032` проверки, маркер `≤ 0,0448 px` |
| Детерминизм превью | `sha256sum` шести PNG до и после второго прогона — совпал побайтово (проверил независимо) |
| Бюджет каталога | `3 527 439` байт (`3,36` МиБ) против `8` МиБ |
| Центр кадра | реализовано `(viewport.w / 2 − tx) / scale` — **верно**; контракт `§17.5` исправлен по факту |
| Формула `hashSeed`, палитры, `readonly`-сигнатуры | совпадают с контрактом до буквы |

**Отклонено: визуальное качество поля.** Шесть PNG (мой просмотр, не отчёт) показывают не
туманность, а «мыльные пузыри с ободком»: крупные гладкие пятна с бирюзовым ядром и сиреневым
кольцом, одинаковая макроструктура на всех уровнях, при зуме новой детали не появляется.
Причина найдена в коде, а не в вкусе:

1. `sampleRampInto` берёт `densityStops[0], [1], [3], [4]` — **`stops[2]` выброшен**, отрезков
   три вместо четырёх, поэтому рампа прыгает `dust → core` через весь диапазон и даёт кольцо.
2. Роли цветов перевёрнуты: `rim` (`[56,130,172]`, яркость ≈ `117`) ярче `core`
   (`[110,86,178]`, ≈ `98`), то есть «ободок» светлее ядра — отсюда бирюзовые блины.
3. Окно октав слишком узкое (`OCTAVE_WINDOW_WIDTH = 2`, окно `t²`): в кадре реально работают
   `1–2` октавы, самая мелкая на `L9` — `≈ 43 px` на ячейку. Мелкой структуры нет по построению.

**Объективные числа «до» (мой замер, CPU, кадр `512 × 512`):**

| Пресет | Уровень | meanL | `edge / meanL` | uniq |
|---|---|---|---|---|
| nebula | `L0` | `22,6` | `0,3189` | `4136` |
| nebula | `L4` | `28,4` | `0,2444` | `4507` |
| nebula | `L9` | `33,4` | `0,2034` | `4443` |
| tactical | `L0` | `21,8` | `0,2138` | `2505` |
| tactical | `L4` | `29,5` | `0,1460` | `3021` |
| tactical | `L9` | `27,2` | `0,1611` | `2746` |

`edge` — средний модуль лапласиана яркости; `edge / meanL` — количество детали на единицу
яркости. Видно главное: **деталь падает с зумом** (`0,203 / 0,319 = 0,64`), а яркость растёт
(`33,4 / 22,6 = 1,48`) — при приближении картинка становится светлее и глаже, хотя должна
наоборот обрастать волокнами.

**Критерии попытки 2 (проверяемые числом, не «нравится»).**

| № | Критерий |
|---|---|
| `V-1` | `sampleRampInto` использует все пять `densityStops` (четыре отрезка); тест: для обеих палитр яркость `core` > яркость `rim` ≥ яркость `dust` > яркость `background` |
| `V-2` | Деталь не гаснет при зуме: `edge / meanL` на `L9` и на `L4` ≥ `0,9 ×` значения на `L0`, для обоих пресетов |
| `V-3` | `meanL` на всех уровнях в полосе `12…40`; рост `L9 / L0` ≤ `1,25` |
| `V-4` | `uniq` на кадре `512²`: nebula ≥ `3000`, tactical ≥ `1800` (защита от «двухцветной каши») |
| `V-5` | Качество волокон: облака с филаментами, а не круглые пятна с ободком; у `tactical` — тонкие холодные волокна и градиенты, зелёных «островов» нет. Проверяю глазами по PNG, число здесь не работает |
| `V-6` | `npm run sector-field:preview` печатает для каждого кадра `meanL`, `edge / meanL`, `uniq` — приёмка должна воспроизводиться из лога скрипта, а не из моей памяти |
| `V-7` | Бюджет `renderField` на CPU: полный кадр `1920 × 1080`, `L0` — `≤ 50 мс`; повторный кадр с тем же состоянием (кэш) — `≤ 5 мс`. Замер в отчёте, в `npm test` таймингов не добавлять (прецедент флейка `local-map-stage8.test.mjs:1877`) |

Всё остальное из попытки 1 (границы, контракт, детерминизм, тесты, CI) переносится в попытку 2
без изменений и проверяется заново.

### 17.13. Диверсификация волны `SW-2` (пересмотр расписания, 25.10.2026)

**Решение владельца:** «всё чередом проходит слишком долго, нужна большая диверсификация работ».
Последовательная схема `§17.9` давала `21–28` агено-часов сквозного времени при полезной работе
примерно `6–8`: три четверти времени воркеры ждут слияния соседа. Расписание пересобрано.
Меняется **только выдача карточек и порядок слияния**; контракт `§17.5`, правило «никаких шимов»
и запрет на правку чужих файлов не меняются.

**Почему это безопасно.** В `SW-2A` контракт поля зафиксирован и уже в `main`-линии ветки
(`sector-field.ts` лежит в ветке Воркера 1, сигнатуры заморожены). Потребитель в `SW-2B`
импортирует **реальный** модуль из ветки Воркера 1, а не заглушку, — ровно этого не хватило
в `Stage-8.7.2`, где шим дожил до прода. Плюс `SW-2B` не сливается, пока `SW-2A` не слит.

**Глобальное владение файлами (на всю волну, а не на шаг).** Правило О-1 усилено: с этого
момента файл принадлежит одному воркеру целиком, независимо от того, в каком шаге он правится.

| Файл / группа | Владелец | Ветка |
|---|---|---|
| `src/atlas/sector-field.ts`, `tools/sector_field_preview.mjs`, `tests/sector-field.test.mjs`, `docs/stages/evidence/sw2-field/*` | Воркер 1 (`SW-2A`, попытка 2) | `arena/4c8425a7-…` |
| `src/atlas/canvas-renderer.ts`, `config.ts`, `data-loader.ts`, `app.ts`, `tile-pyramid.ts` *(удаление)*, `site/shared/links.ts`, `data/meta.json`, `tools/build_assets.py`, `.gitignore`, `.github/workflows/{pages,assets,check}.yml`, `assets/src/koprulu-sector.jpg` *(удаление)*, `package.json` | Воркер 2 (`SW-2B`) | ответвление от ветки Воркера 1 + `main` |
| `site/AGENTS.md`, `tools/AGENTS.md`, `CHANGELOG.md`, `docs/HANDOFF.md`, `docs/stages/stage_patches.md`, `docs/PREPARATION_PLAN.md` | Воркер 3 (документация) | от `main` |
| `src/atlas/level-ladder.ts`, `tests/sector-ladder.test.mjs` | Воркер 4 (`SW-3`, чистая часть лестницы) | от `main` |
| `tools/verify_no_raster.mjs` | Гайдлайнер (гейт `G7.3`) | отдельный PR, уже слит |

**Четыре параллельных потока.**

| Поток | Что | Зависимость | Слияние |
|---|---|---|---|
| `A` | `SW-2A` — поле, превью, тесты, критерии `V-1…V-7` (`§17.12`) | нет | первым |
| `B` | `SW-2B` — интеграция поля и удаление растра | импорт `sector-field.ts` из ветки `A` | сразу после `A`, с перебазированием |
| `C` | Документация доменных `AGENTS.md` | текст описывает **уже удалённый** контур | сразу после `B` |
| `D` | `SW-3`, чистая часть: достижимая ширина и границы зума в `level-ladder.ts` + тесты | нет | в любой момент, не зависит от `A`/`B` |

`D` выделен специально: `SW-3` целиком трогает `canvas-renderer.ts` (там живут `minScale`/
`maxScale`), то есть тот же файл, что и `B`. Чистая часть (`MIN_REACHABLE_WIDTH`,
`requiredMaxZoomFactor`, `reachableVisibleWidth`) живёт в `level-ladder.ts` и не пересекается
ни с одним другим потоком. Проводка в `canvas-renderer.ts` — отдельный маленький PR `SW-3-wire`
**после** слияния `B`.

**Протокол для `B` (обязателен, иначе получим конфликт на 13 файлах).**

1. Ветка создаётся не от `main`, а от головы ветки `A`, поверх которой влит `main`:
   `git fetch origin`, `git switch -c <ветка> origin/arena/4c8425a7-…`, `git merge origin/main`.
2. Пока `A` жива, Воркер 2 **не правит** ни один файл из владения `A`. Импортирует по контракту
   `§17.5`; если контракта не хватает — вопрос Гайдлайнеру, не «временный шим».
3. После слияния `A`: `git fetch origin`, `git rebase origin/main`, прогнать гейты заново,
   только потом запрос на слияние. Слияние `B` — `--squash`, как обычно.
4. `B` сливается одним PR: интеграция и удаление вместе (`R-1`: откат одним `git revert`).
   Дробить нельзя — иначе на `main` остаётся кадр без подложки.

**Протокол для `C`.** Ветка от `main`, правки только в документации. Сливается после `B`.
Если `B` поменяет формулировки в коде (например, имя поля в `data/meta.json`), Воркер 3
перечитывает дифф `B` перед слиянием и правит текст по факту, а не по карточке.

**Гейт `G7.3` написан первым.** `tools/verify_no_raster.mjs` лежит в `main` **до** `SW-2B` и на
сегодня красный (8 из 9 проверок: JPG на месте, маркеры в рантайме, ключи в `meta.json`,
`check.yml:57`, кэш `pages.yml`, артефакт `assets.yml`, правила `.gitignore`, `build_assets.py`).
Это red-first, а не поломка: Воркер 2 в своём PR добавляет скрипт `verify:no-raster` и ставит шаг
**выше** `npm test` в `check.yml` (`§17.10`), и гейт зеленеет ровно в момент удаления контура.

**Что остаётся запрещённым.** Правка чужих файлов; шимы и заглушки вместо реального модуля;
слияние `B` до `A`; слияние `C` до `B`; параллельная правка `canvas-renderer.ts` кем-либо кроме
Воркера 2 до слияния `B`; любые правки `main` напрямую.

**Ожидаемый эффект.** Сквозное время волны падает с `21–28` до `10–13` агено-часов: `B`
стартует не через сутки после `A`, а сразу; `D` идёт параллельно всем. Риск — конфликт ветки `B`
с `main` при перебазировании; снимается тем, что `B` трогает файлы, которые больше никто не
трогает, и перебазируется до запроса на слияние, а не после.

### 17.14. Приёмка `SW-2A` попытки 2 и снятие блокировки с `SW-2B`

PR `#253` слит **25.10.2026** коммитом `87045d6`. Проверял собственными прогонами на
распакованном дереве (`npm ci` с нуля), не по отчёту.

| Гейт | Мой прогон |
|---|---|
| Файлы PR | `10` ровно из `OWNED_FILES`: `sector-field.ts`, `sector_field_preview.mjs`, `tests/sector-field.test.mjs`, шесть PNG, `package.json` (`+2/−1`: скрипт и строка теста; зависимостей нет) |
| `typecheck` / `lint` / `build` / `git diff --check` | зелёные |
| `npm test` | `203` проверки: `195` pass, `8` fail — база `§17.11`, девятых падений нет |
| `verify:address` / `verify:sector-core` | `173/173`, golden `11/11`, round-trip `0`; `3032` проверки, маркер `≤ 0,0448 px` |
| Детерминизм превью | второй прогон `sector-field:preview` — все шесть `sha256` совпали |
| Бюджет каталога | `6 204 889` байт (`5,91` МиБ) против `8` МиБ |
| `И-10` | в модуле нет `fetch`, `new Image`, `Math.random`, `Date.now`, `performance.now` (только упоминания в комментарии-запрете) |

**Критерии `§17.12`, проверенные моим независимым скриптом (кадр `512²`):**

| Критерий | Норма | nebula | tactical | Итог |
|---|---|---|---|---|
| `V-1` рампа | 4 отрезка, яркость `core > rim ≥ dust > background` | `6,5 < 40 < 85 < 176` | `5,5 < 33 < 90 < 180` | принято |
| `V-2` деталь `L4/L0`, `L9/L0` | `≥ 0,90` | `1,06` / `1,14` | `1,17` / `1,35` | принято |
| `V-3` `meanL`, рост `L9/L0` | `12…40`, `≤ 1,25` | `27,5…27,6`, `1,00` | `26,0…26,9`, `0,97` | принято |
| `V-4` `uniq` | `≥ 3000` / `≥ 1800` | `4804…4995` | `2659…2834` | принято |
| `V-6` метрики в логе превью | есть | — | — | принято |
| `V-7` `renderField` `1920 × 1080` | `≤ 50 мс`, кэш `≤ 5 мс` | `33,4 мс` (браузерный путь), `44,6 мс` (JS-фолбэк); кэш `0,02…0,24 мс` | — | принято |

`V-5` (волокна вместо пузырей, отсутствие зелёных «островов») — принято по просмотру шести PNG:
круглых пятен с ярким ободком больше нет, у `tactical` холодные волокна на почти чёрном фоне.

**Принято с оговоркой — стилевой долг.** На `L4`/`L9` в обоих пресетах читается
«отпечаток пальца»: тонкие замкнутые изолинии внутри облаков. Причина найдена в коде, а не
во вкусе: `ridgeFine` — **одна** октава value-noise в высокой частоте (`thread`), а множества
уровня одиночной октавы value-noise и есть вложенные кольца вокруг узлов решётки. Это не
критерий приёмки `§17.12` (там стиль проверялся по «пузырям»), поэтому `SW-2A` не блокируется:
долг выносится в отдельную узкую задачу `SW-2A-style` — `ridgeFine` из 2–3 октав
(`1−|2n−1|` на `f`, `2f`, `4f` с весами `1 / 0,5 / 0,25`), амплитуда `thread` вдвое ниже,
`dust` тоже из двух октав. Попытка 3 из 3 остаётся **неизрасходованной** и тратится только
на эту задачу и только по решению владельца.

**Снятие блокировки с `SW-2B`.** Указание `§17.13` «ветка `B` создаётся от ветки `A`»
**устарело в момент слияния `#253`**: боевой `sector-field.ts` теперь в `main`. Воркер 2
строит ветку **от `main`** (`87045d6` и позже), импортирует модуль как обычный соседний файл,
шимы по-прежнему запрещены. Остальные пункты протокола `§17.13` (один PR на интеграцию и
удаление, слияние только после зелёного `verify:no-raster`, `imageVersion` в `meta.json`
остаётся) действуют без изменений.

### 17.15. Глубина приближения: «1 св.г. до границы» и бесшовность секторов

Дата: **25.10.2026**. Источник — требование владельца, а не план гайдлайнера; числа ниже
**посчитаны**, а не взяты из плана.

**Требование владельца (дословно по смыслу).**

1. Целевой объект отображается так, чтобы **расстояние от него до границы экрана
   составляло 1 световой год**. Это условие важнее названий уровней и важнее оценки
   множителя `600…1100×`.
2. Приближение не ограничивается `L8` только потому, что у него в таблице стоит
   `39,0625 св.г.`: сначала проверяется, какое расстояние до края экрана это даёт.
3. Множитель `600…1100×` **не считать спецификацией**: вывести из расчёта видимой области
   для целевого viewport и проверить на экране.
4. В реализации явно показывать и тестировать расстояние от цели до границы,
   а не подменять его общей шириной видимой области.
5. Дизайн: **бесшовность между секторами, без видимых границ**.

#### 17.15.1. Метрика: что именно меряем

Единственная метрика глубины — **`edgeDist`, расстояние от центра кадра (цели) до
ближайшей границы экрана**:

~~~~text
edgeDist = min(viewport.w, viewport.h) / 2 / scale      [св.г.]
~~~~

`visibleWidth` уровней (и `MIN_VISIBLE_WIDTH`) — производная величина: `visibleWidth`
трактуется как протяжённость мира по **короткой** оси кадра, поэтому
`edgeDist = visibleWidth / 2`. Это согласовано с `fitScale()` в `canvas-renderer.ts`
(`min(w, h) / mapSize * fitInset`), где `L0` = «карта 10 000 вписана по короткой оси».

**Дефект документации, найденный при расчёте.** В плане `§6` колонка `px/св.г.`
посчитана как `1920 / visibleWidth`, то есть по **длинной** оси; реальный `fitScale`
масштабирует по короткой. При `1920 × 1080` это даёт `0,192` вместо фактических
`0,108 px/св.г.` на `L0`. Числа порогов уровней при этом не меняются (они заданы
в св.г.), а колонка `px/св.г.` и производная `1 px =` в плане завышены в `1,78` раза.
Правку плана делает док-воркер (`SW-2C`), она не блокирует код.

#### 17.15.2. Ответ на вопрос «хватает ли `L8`»

| Уровень | `visibleWidth`, св.г. | `edgeDist`, св.г. | Требование `edgeDist = 1` |
|---|---:|---:|---|
| `L7` | `78,125` | `39,06` | не выполнено |
| `L8` | `39,0625` | **`19,53`** | не выполнено (в 19,5 раза дальше) |
| `L9` | `19,53125` | **`9,77`** | не выполнено (в 9,8 раза дальше) |
| `L10` *(новая)* | `9,765625` | `4,88` | не выполнено |
| `L11` *(новая)* | `4,8828125` | `2,44` | не выполнено |
| `L12` *(новая)* | `2,44140625` | `1,22` | **выполнено** при подходе к `2,00` |
| кадр «цель» | `2,0` | **`1,00`** | требование выполнено |

Вывод: **`L8` не выполняет требование, `L9` тоже не выполняет.** Апертура на `L9`
остаётся входом в систему, но глубина «1 св.г. до края» лежит ниже — нужны уровни
`L10…L12`, и тогда `edgeDist = 1,00` достигается внутри `L12`
(по гистерезису `L12` включается при `2,44140625 · 0,88 = 2,148`, то есть при
`edgeDist ≤ 1,074`).

#### 17.15.3. Множитель: выведен, а не взят из плана

Отношение требуемого масштаба к «вся карта» **не зависит от viewport** — обе величины
пропорциональны `min(w, h)`:

~~~~text
scale(edgeDist = 1) = min(w, h) / 2
scale_fit           = min(w, h) / 10 000 · 0,94
множитель к fit     = 10 000 / (2 · 0,94) = 5 319×
множитель к номиналу L0 (без inset 0,94) = 10 000 / 2 = 5 000×
~~~~

Проверено расчётом по пяти viewport:

| viewport | `min` | `fitScale` | `edgeDist` на fit, св.г. | множитель до `edgeDist = 1` |
|---|---:|---:|---:|---:|
| `1920 × 1080` | `1080` | `0,10152` | `5 319` | `5 319×` |
| `1366 × 768` | `768` | `0,07219` | `5 319` | `5 319×` |
| `2560 × 1440` | `1440` | `0,13536` | `5 319` | `5 319×` |
| `390 × 844` (портрет) | `390` | `0,03666` | `5 319` | `5 319×` |
| `844 × 390` (ландшафт) | `390` | `0,03666` | `5 319` | `5 319×` |

Оценка плана `600…1100×` **неверна примерно в 5–9 раз**: она, по-видимому, считалась как
`10 000 / 19,5 ≈ 513` (то есть до `L9`, а не до 1 св.г.). Правильное требование к клампу —
дойти до `scale = min(w, h) / 2` (множитель `5 319×` к `fit`, `5 000×` к номиналу `L0`),
и это **проверяется на экране**, а не принимается на слово.

Следствия по числам на кадре «цель» (`edgeDist = 1`): `540 px/св.г.` при `1920 × 1080`,
`195 px/св.г.` на телефоне `390 × 844`. `markerDiameter(2)` = `89,5` → кламп `40 px`,
поэтому диаметр маркера на `L10…L12` равен `40` и в таблицу идёт как `40`.

#### 17.15.4. Что требуется от лестницы (`SW-3`)

1. Три новых уровня `L10 = 9,765625`, `L11 = 4,8828125`, `L12 = 2,44140625` — та же
   геометрия `10 000 / 2ⁿ`, frame `S`, `markerPx = 40`, `addressLetters = 5`.
   Системный кадр `S0…S2` сдвигается на индексы `13…15`, лестница становится **16 записей**.
   `G7.2` («13 уровней») переформулируется: **13 секторных уровней `L0…L12`** плюс три
   системных; это записывается в критерии, а не исправляется задним числом.
2. `levelForWidth` расширяется до `0…12` (сейчас жёсткий кламп `9`), гистерезис `±12 %`
   сохраняется без изменений; вход в `L12` при `≤ 2,148`.
3. Новый экспорт — **явная метрика требования**, а не «ширина»:
   `export function edgeDistance(viewport, scale): number` (в св.г.) и
   `export function scaleForEdgeDistance(viewport, edgeDist): number`.
   UI (карточка точки `§7.8`, HUD `?debug=ladder`) показывает `edgeDist` в св.г.
   рядом с уровнем; при `edgeDist = 1,00` подпись «1 св.г. до границы».
4. **Кламп зума — ровно на требовании, без запаса вниз (решение 25.10.2026, `§17.17`).**
   `maxScaleForTargetEdge(viewport, mapSize, fitInset)` даёт `edgeDist = 1,00` **точно**
   (`scale = min(w, h) / 2`), а не `≤ 0,95`: требование ТЗ — «расстояние от цели до границы
   равно 1 св.г.», и упор зума обязан совпадать с ним, иначе на упоре условие нарушено.
   Предохранитель отдельный и только на ошибку: `maxScale` не глубже
   `scaleForEdgeDistance(viewport, 0,5)` — ниже начинается системный кадр, туда вход
   только действием (`§6.1` п. 4).
5. Тесты (числом, не глазами): для пяти viewport `scaleForEdgeDistance(v, 1)` даёт
   `edgeDistance = 1,000 ± 1e-9`; `edgeDistance(v, maxScaleForTargetEdge(...))` — ровно `1`
   (±`1e-9`); `levelForWidth` при ширине `2 · edgeDist` возвращает `12`;
   `edgeDist` на `L8` и `L9` остаётся `19,53` и `9,77` (регрессия «не подменили метрику»).
   Множитель проверяется **тождеством, а не коридором**:
   `maxScaleForTargetEdge / fitScaleFor === 10 000 / (2 · fitInset)` с точностью `1e-9`
   (при `fitInset = 0,94` это `5 319,1489…`); коридор `5 000…5 320` остаётся только
   как грубая страховка от подмены формулы.

#### 17.15.5. Что требуется от поля на глубине (`SW-2A-style`)

На `edgeDist = 1` в кадре нет ни туманности, ни пылевых полос — там одна звезда и её
окрестность. Поэтому:

1. Пресет поля получает параметр глубины: на `edgeDist ≤ 4` туманность и пыль гасятся
   до нуля, остаётся звёздная пыль и мягкий градиент фона (`field.local`).
2. Гашение **плавное и монотонное** по `edgeDist`, без ступеньки на границе уровня.
3. Тест: `edgeDist = 1` → в кадре нет ни одного пикселя с плотностью облака выше
   `0,02`; `edgeDist = 10` → облако присутствует.

#### 17.15.6. Бесшовность: стык секторов не виден

Требование «без видимых границ» разложено на три проверяемых пункта.

1. **Поле периодично по карте.** Соседний сектор — продолжение того же поля:
   `field(x, y) === field(x ± mapSize, y ± mapSize)` побайтово (CPU-путь). Достигается
   заворотом решётки шума по модулю числа ячеек карты; все частоты октав
   (`3 · 2ⁿ`), домен-варпа и пыли обязаны быть целыми числами ячеек на карту — сейчас
   это так, поэтому заворот возможен без смены композиции.
2. **На шве нет линии.** На кадре, центрированном на стыке, деталь в центральном
   столбце/строке не превышает `1,5` от среднего по кадру.
3. **Нет нарисованной рамки.** `strokeRect` по границе карты
   (`canvas-renderer.ts:283`, комментарий «рамка сектора и угловые метки») удаляется:
   это ровно «видимая граница». Координатные подписи по краю остаются — они не линия.

**Гейт написан и лежит в `main` как red-first:** `tools/verify_field_seamless.mjs`.
Текущий результат на `main` (`9b410bc`): `5` из `6` проверок красные —
периодичности нет (`26 329…27 300` несовпавших байт из `36 864`, `maxΔ` до `220`),
рамка сектора на месте. Зелёной проверка `2` (шов как линия) сейчас потому, что шва
в одном кадре и нет: поле непрерывно внутри карты, ломается именно стык с соседом.

#### 17.15.7. Порядок и владение

| Поток | Задача | Файлы | Зависимость |
|---|---|---|---|
| `F` | `SW-2A-style`: периодичность поля, глубокий пресет `field.local`, `ridgeFine` из 2–3 октав | `src/atlas/sector-field.ts`, `tests/sector-field.test.mjs` | нет, можно параллельно |
| `D` | `SW-3`: `L10…L12`, `edgeDistance`, расширение `levelForWidth`, тесты | `src/atlas/level-ladder.ts`, `tests/sector-ladder.test.mjs` | нет |
| `D′` | `SW-3-wire`: кламп зума и `edgeDist` в HUD/карточке | `src/atlas/canvas-renderer.ts`, `src/atlas/app.ts` | после `B` |
| `B` | `SW-2B`: интеграция поля, удаление растра, **снятие рамки сектора** | см. `§17.4` | идёт |

`F` и `D` идут параллельно и не пересекаются ни одним файлом. `D′` ждёт `B` (общий файл
`canvas-renderer.ts`).

### 17.16. Сводный план-список: кому что и что уже пройдено

Составлен **25.10.2026** по фактическому состоянию `main` = `b9a9995`. Это единственная
таблица, по которой выдаются карточки; при расхождении с более ранними разделами верен этот.

**Легенда:** ✅ сделано и слито · 🔄 в работе сейчас · ⏳ ждёт своей очереди · ⛔ заблокировано
· 🚧 делает Гайдлайнер.

#### 17.16.1. Пройденные этапы

| Волна | Кто | Что сделано | Итог |
|---|---|---|---|
| Подготовка | Гайдлайнер | матрица `SW-1`, согласования владельца (`two_plus_docs`, `docs_pr`, `nebula`) | `§16`, PR #243 |
| `SW-1` | **Воркер 1** | кодек адреса `sector-address.ts`, `tools/verify_sector_address.mjs`, `tests/sector-address.test.mjs` | ✅ `#244` `c9c36b4` |
| `SW-1` | **Воркер 2** | `level-ladder.ts` (13 уровней, гистерезис, `markerDiameter`), `sector-units.ts`, два теста, `package.json`, `check.yml` | ✅ `#245` `86ded61` |
| `SW-1` | **Воркер 3** | документация волны: `HANDOFF`, `CHANGELOG`, `stage_patches`, доменные `AGENTS.md` | ✅ `#249` `36448ec` |
| `SW-1` | Гайдлайнер | сквозной гейт `tools/verify_sector_core.mjs` (3032 проверки), верификаторы **выше** `npm test` | ✅ `#248` `dd1f2ea` |
| `SW-1` | Гайдлайнер | закрытие волны, фиксация чисел ядра, требование `MIN_REACHABLE_WIDTH` | ✅ `#250` `b3306cb` |
| `SW-2` план | Гайдлайнер | матрица `SW-2` (`§17`), инвентарь удаляемого, шесть ловушек, база приёмки | ✅ `#251` `37afca0`, `#252` `f473e0b` |
| `SW-2A` | **Воркер 1**, попытка 1 | поле, превью, тесты: гейты зелёные, но **визуально отклонено** (пузыри, выброшенный `stops[2]`, перевёрнутые роли `core`/`rim`) | ✗ отклонено, `§17.12` |
| `SW-2A` | Гайдлайнер | протокол отклонения и критерии `V-1…V-7`, поправка формулы центра кадра, разделение бюджета CPU-пути | ✅ `#254` `af4dcc8` |
| `SW-2A` | **Воркер 1**, попытка 2 | филаментное поле, бюджет экранного пути (кэш `0,02 мс`), метрики в логе превью | ✅ `#253` `87045d6` |
| `SW-2A` | Гайдлайнер | приёмка своими прогонами, `V-1…V-7` числами, стилевой долг, снятие блокировки с `B` | ✅ `#256` `9b410bc` |
| `SW-2` расписание | Гайдлайнер | параллельная схема `A/B/C/D`, глобальное владение файлами, гейт `verify_no_raster.mjs` red-first | ✅ `#255` `e4d77e9` |
| `SW-3` расчёт | Гайдлайнер | глубина «1 св.г. до границы», вывод множителя, гейт бесшовности `verify_field_seamless.mjs` red-first | ✅ `#257` `b9a9995` |

Планетарные тесты (`8` падений Stage-8) **вне зоны** всех волн — решение владельца 25.10.2026.

#### 17.16.2. Текущий фронт: четыре потока одновременно

| Поток | Воркер | Задача | Файлы (владение) | Статус | Приёмка |
|---|---|---|---|---|---|
| `B` | **Воркер 2** | `SW-2B`: поле в кадре, удаление растра, снятие рамки сектора | 14 файлов из `§17.4` + `package.json` | 🔄 работает | `verify:no-raster` = `0`, `verify_field_seamless` п. 3, `verify:publish` `7/7` |
| `F` | **Воркер 1** | `SW-2A-style`: периодичность поля по `mapSize`, пресет `field.local`, `ridgeFine` из 2–3 октав | `sector-field.ts`, `tests/sector-field.test.mjs`, `sector_field_preview.mjs`, `evidence/sw2-field/*` | 🔄 работает | `verify_field_seamless` п. 1a…1d и 2, `V-1…V-6` повторно |
| `D` | **Воркер 4** | `SW-3` (чистая часть): `L10…L12`, `edgeDistance`, расширение `levelForWidth` до `0…12` | `level-ladder.ts`, `tests/sector-ladder.test.mjs` | 🔄 работает | `edgeDistance = 1,000 ± 1e-9` на пяти viewport, множитель `5 319×`, `L8`/`L9` не сдвинуты |
| `C` | **Воркер 3** | документация: доменные `AGENTS.md`, `CHANGELOG`, `HANDOFF`, `stage_patches`, `PREPARATION_PLAN` | 6 док-файлов | ⛔ ждёт `B` (текст описывает уже удалённый контур) | `0` битых ссылок, сверка с диффом `B` |

#### 17.16.3. Очередь после текущего фронта

| Шаг | Кто | Зависит от | Что |
|---|---|---|---|
| `D′` `SW-3-wire` | **Воркер 2** (после `B`) | `B` — общий `canvas-renderer.ts` | кламп зума ровно на `edgeDist = 1,00` (`§17.17`), `edgeDist` в HUD `?debug=ladder` и в карточке точки |
| `SW-3` (сцена) | **Воркер 4** или новый | `B`, `D` | `sector-scene.ts`, `label-layout.ts`, территории, сетка адресов, маркеры по `§6.2` |
| `SW-3F` | новый воркер | `SW-3` | `sector-flight.ts`, `sector-arrows.ts`, два теста |
| `SW-4` | новый воркер | `SW-3F` | readout, карточка точки, поиск, `?at=`, `?coords=1` |
| `SW-5` | новый воркер | может идти параллельно `SW-3F`/`SW-4` | `system-frame.ts`, `S0…S2`, мост `S → O` |
| `SW-6` | Гайдлайнер + Воркер 3 | всё | приёмка `G7.1…G7.12`, замеры, документация, `Приложение C` |

#### 17.16.4. Что делаю я (Гайдлайнер) и что ещё не закрыто

| № | Действие | Когда |
|---|---|---|
| 1 | правка `tools/verify_sector_core.mjs` под `LEVELS.length = 16` и порядок `L0…L12, S0…S2` — **только по диффу от Воркера 4**, числа ядра не трогаются | по отчёту `D` |
| 2 | приёмка `B`: свои прогоны + `verify:no-raster` = `0` + `imageVersion` на месте + `drawSchematic` жив | по отчёту `B` |
| 3 | приёмка `F`: свои прогоны + четыре сдвига побайтово + метрики `§17.12` не просели | по отчёту `F` |
| 4 | пересборка базы `§17.11` после `B` (число тестов вырастет на `SW-3`) | после `B` |
| 5 | выдача карточек `C`, `D′`, затем `SW-3`-сцены | по мере слияний |
| 6 | правка плана: колонка `px/св.г.` по короткой оси (завышение `1,78×`), `L10…L12` в таблице `§6` | в `C` или отдельным док-PR |

#### 17.16.5. Правила, которые действуют без исключений

1. Файл принадлежит одному воркеру на всю волну (`§17.13`), пересечений нет по времени.
2. Шимов и заглушек нет: потребитель импортирует боевой модуль из `main`.
3. Воркер всегда останавливается **перед** merge; сливаю только я, `--squash --admin`.
4. Лимит — `3` попытки на задачу, затем эскалация владельцу.
5. Гейт ставится **выше** красного шага в CI (`§17.10`).
6. Числа берутся из `docs/stages/stage-9-12-sector-deep-render-plan.md` и `§17.15`;
   карточки их не дублируют и не пересчитывают.
7. Планетарные тесты не чинятся и в приёмку не входят.

### 17.17. Решение по противоречию «0,95 против 5 319,5» (25.10.2026)

**Противоречие было моё, в моей же карточке `SW-3`.** В `§17.15.4` п. 4 стояло «`maxScale`
даёт `edgeDist ≤ 0,95` (запас до `1,00`)», а в тестах карточки — «множитель
`maxScaleForTargetEdge / fitScaleFor ≤ 5319,5`». Оба требования одновременно невыполнимы:

~~~~text
edgeDist = 0,95  →  множитель = 10 000 / (2 · 0,95 · 0,94) = 5 599,10×  >  5 319,5
edgeDist = 1,00  →  множитель = 10 000 / (2 · 0,94)         = 5 319,15×  ≤  5 319,5
~~~~

**Решение: кламп ровно на `1,00`, формулировка «≤ 0,95» отменена.** Основание — не
удобство чисел, а ТЗ владельца: «расстояние от объекта до границы экрана 1 световой год».
Требование задаёт **точку**, а не полосу: упор зума обязан совпадать с ней. Кламп на
`0,95` нарушает условие ровно на упоре — то есть именно там, где пользователь и остановится.
Запас «вниз» здесь не осторожность, а дефект: он делает недостижимым единственное
состояние, ради которого уровень существует.

Что остаётся от «запаса»:

1. **Отдельный предохранитель на ошибку**, а не на продукт: `maxScale` не глубже
   `scaleForEdgeDistance(viewport, 0,5)`. Он ничего не ограничивает по требованию,
   но ловит случайное «уехали в системный кадр колесом».
2. **Проверка тождеством, а не коридором.** Тест на множитель больше не сравнивает
   с числом `5319,5` из карточки, а проверяет
   `ratio === 10 000 / (2 · fitInset)` с точностью `1e-9`. Коридор `5 000…5 320` оставлен
   как грубая страховка: он ловит подмену формулы, но не задаёт спецификацию.
3. Числа карточки (`≤ 5319,5`, `≥ 5000`) при таком клампе выполняются **буквально**,
   переписывать карточку Воркеру не нужно.

**Точность на упоре.** `edgeDistance(v, maxScale)` при `maxScale = min(w, h) / 2` даёт
ровно `1` в IEEE-754 (одно и то же деление), поэтому допуск `1e-9` — не поблажка,
а защита от переписывания формулы через `visibleWidth`.

**Следствие для `D′`.** Кламп зума в `canvas-renderer.ts` ставится на
`maxScaleForTargetEdge(...)`, а не на «`0,95` от него». Подпись в HUD при упоре —
`1,00 св.г. до границы`.

#### 17.17.1. Второй блокер снят: гейт ядра больше не требует правки

Правка `tools/verify_sector_core.mjs` под 16 записей лестницы **сделана мной и уже в `main`**
(`§17.17` этого PR). Гейт перестал быть «жёстко 13 записей» и разбирает лестницу по кадрам:

- секторные уровни (`frame === 'S'`) — не меньше `10`, порядок `L0…L{последний}`,
  порог каждого равен `10 000 / 2ⁿ` с точностью `1e-9`;
- системные уровни — ровно три, `S0,S1,S2`, в конце лестницы;
- адресные буквы: `L0…L9` по закреплённой таблице, глубже — `5`;
- стык «таблица ↔ формула маркера» и сквозной зум считаются до **последнего секторного**
  уровня, а не до `L9`;
- закреплённые числа ядра не тронуты: `levelForWidth(19,53125) = 9`, `17,1875` — порог
  достижимости `L9`, `3032 → 3034` проверки (две новые — структура лестницы).

**Проверено оба состояния:** на текущем `main` (`13` записей) гейт зелёный, `3 034` проверки;
на симуляции `16` записей (`L0…L12` + `S0…S2`, кламп `levelForWidth` расширен до `12`)
гейт тоже зелёный, `3 880` проверок. Значит Воркер 4 **не правит гейт и не ждёт меня**:
его PR пройдёт `verify:sector-core` как есть.
