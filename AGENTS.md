# Инструкции для ИИ-агентов (Root Single Source of Truth)

Этот файл — **корневой источник истины (SSoT)** по общим правилам репозитория
`Timeline-Project-SC2.github.io`. Перед началом работы прочитайте этот документ,
актуальный срез состояния в [`docs/HANDOFF.md`](docs/HANDOFF.md) и доменный `AGENTS.md`
той директории, в которой вы вносите изменения. Если исторические заметки противоречат
текущему коду в `main`, приоритет у кода в `main` и явных указаний пользователя;
после завершения работы обновите документацию согласно регламенту режима.

---

## 1. Назначение проекта и общая архитектура публикации

Репозиторий содержит интерактивный веб-атлас и 3D-планетарий вселенной StarCraft II:
- Карта галактики (`/`), интерактивный атлас сектора Копрулу (`/sector/`, `/minimal/`)
  и процедурный WebGL2-глобус планет на геодезической сетке Голдберга
  (`/planet-globe/`, `/planet-test/`), а также изолированные стенды (`/spiral-test/`, `/cursor-test/`).
- Сайт собирается через **TypeScript + Vite** (`vite.config.mts` и модули `tools/vite/*`)
  в статическую директорию `.publish/` и публикуется на **GitHub Pages** через
  `.github/workflows/pages.yml` (источник публикации в настройках репозитория — GitHub Actions).
- Все JS, CSS и WebWorker-бандлы в `.publish/` получают автоматические контент-хэши
  в именах файлов и фиксируются в `.publish/build-manifest.json`. Добавлять или обновлять
  ручные `?v=` в исходных HTML/TS-файлах категорически запрещено.
- Табличные данные (`data/*.csv`, `data/meta.json`) синхронизируются из опубликованной книги
  Google Sheets скриптом `tools/sync.py` (включая строгий режим `--strict`), а растровые
  WebP-тайлы и ресайзы карт строятся из исходников `assets/src/` скриптом `tools/build_assets.py`.
- Контракт профилей планет (`src/contracts/planet-generation-contract.json`) проверяется
  кросс-верификатором `tools/verify_planet_contract_cross.mjs` между Python и TypeScript,
  а полнота статической сборки `.publish/` — верификатором `tools/verify_feature_parity.mjs`.
- Полная матрица тестовых и сборочных проверок выполняется в `.github/workflows/check.yml`
  на каждый Pull Request и должна оставаться зелёной перед слиянием в `main`.

---

## 2. Карта маршрутов, директорий и доменных `AGENTS.md` (SSoT)

Чтобы исключить дублирование и рассинхронизацию правил (принцип **Single Source of Truth**),
узкоспециализированные детали рантайма страниц, шейдеров/WASM и сборочных/синхронизирующих
скриптов вынесены во вложенные файлы. В корневом `AGENTS.md` хранятся только общие правила
репозитория и ссылки на доменные документы:

| Директория / контур | Маршруты и зона ответственности | Доменный SSoT-документ |
|---|---|---|
| `site/` | Браузерный рантайм маршрутов `/`, `/sector/`, `/minimal/`, `/planet-globe/`, `/planet-test/`, `/spiral-test/`, `/cursor-test/`, модули `site/shared/*`, WebGL2, WebWorker, CSP и запрет правки `site/assets/vendor/*` | [`site/AGENTS.md`](site/AGENTS.md) |
| `src/` | Канонические TS-модули (`src/atlas/*`, `src/planet/*`, `src/local-map/*`, `src/contracts/*`, `src/spiral/*`, `src/cursor/*`), AssemblyScript/Wasm, побитовая идентичность `c100-soft-v2` (И-1…И-6) и `src/planet/planet-globe-fx.ts` | [`src/AGENTS.md`](src/AGENTS.md) |
| `tools/` | Скрипты синхронизации и валидации (`tools/sync.py --strict`, `tools/planet_generation.py`), верификаторы (`verify_planet_contract_cross.mjs`, `verify_feature_parity.mjs`), генераторы золотых фикстур и модули `tools/vite/*` | [`tools/AGENTS.md`](tools/AGENTS.md) |
| `docs/agents_task_orchestration/` | Регламент мультиагентной сплит-разработки (`Split-Work` / `Tri-Agent Wave`), матрица `Zero File Overlap` и инструкция для воркеров 1–3 | [`docs/agents_task_orchestration/agents_task_orchestration.md`](docs/agents_task_orchestration/agents_task_orchestration.md)<br>[`docs/agents_task_orchestration/worker_instruction_on_splitwork.md`](docs/agents_task_orchestration/worker_instruction_on_splitwork.md) |
| `templates/` | Единый HTML-каркас `templates/atlas-shell.html` для вариантов `/sector/` и `/minimal/` | См. [`site/AGENTS.md`](site/AGENTS.md) и [`tools/AGENTS.md`](tools/AGENTS.md) |
| `data/` и `assets/src/` | Канонические CSV-снимки (`systems.csv`, `places.csv`, `planet-generation.csv`), `sources.json`, `meta.json` и исходные растровые изображения | См. [`tools/AGENTS.md`](tools/AGENTS.md) и [`docs/ADMIN_GUIDE.md`](docs/ADMIN_GUIDE.md) |

**Правило SSoT:** при изменении доменных правил рантайма, Wasm/шейдеров или тулинга редактируйте
**только** соответствующий вложенный `AGENTS.md`, не копируя его детали в корневой файл.

---

## 3. Среда разработки и команды запуска / проверки

Версии среды разработки зафиксированы в `.nvmrc` (**Node.js 24**) и `.python-version` (**Python 3.12**)
и проверяются в `.github/workflows/check.yml` (`actions/setup-node@v6`, `actions/setup-python@v6`).
Стек `typescript@^7.0.2` (с алиасами `@typescript/native` и `@typescript/typescript6`), `eslint`,
`assemblyscript` и `vite` зафиксирован в едином `package-lock.json`:

```bash
# Установка зависимостей из lock-файла
npm ci

# Локальный запуск и сборка статической публикации (.publish/)
npm run dev                                     # локальный dev-сервер Vite
npm run build                                   # проверка типов (tsc --noEmit) + сборка Vite в .publish/

# Статический анализ типов, линтер и компиляция Wasm
npm run typecheck                               # строгая проверка типов TypeScript (tsc --noEmit)
npm run lint                                    # проверка ESLint по директориям site/ и src/
npm run build:wasm                              # сборка Wasm-ядер planet-core (проверка: node tools/build_planet_core.mjs --check)

# Модульные и интеграционные тесты (Node.js и Python)
npm test                                        # явный прогон всех 13 тестовых файлов Node (--test, последовательно: --test-concurrency=1)
npm run test:py                                 # прогон Python-тестов (unittest discover -s tests -p 'test_*.py')

# Верификация публикации, контракта планет и синхронизации данных
npm run verify:publish                          # проверка 7 маршрутов, build-manifest.json и паритета экспортов
npm run verify:contract                         # кросс-проверка Python ↔ TS контракта planet_generation и PG1
python3 tools/sync.py --strict                  # строгая проверка CSV, координат 0..mapSize, привязок places и дублей ID
python3 tools/planet_generation.py validate     # валидация снимка профилей планет против data/places.csv
python3 tools/build_assets.py --check           # проверка свежести WebP и тайлов (на cache hit в CI: --sync-only)
git diff --check                                # проверка отсутствия конфликтных маркеров и пробельных ошибок
```

---

## 4. Общие архитектурные инварианты репозитория

1. **Строгий TypeScript и вытеснение легаси (Инвариант И-5):**
   - Весь новый и мигрированный код в `src/` и `site/` пишется на строгом TypeScript
     (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
   - Держать параллельные `.js`-монолиты или дублирующие реализации рендереров и воркеров запрещено.
2. **Единые контракты и шаблоны:**
   - Контракт профилей планет (`src/contracts/planet-generation-contract.json`), каноническая
     сетка `c100-soft-v2` (И-1, И-2), сшивка локальной карты 7 ячеек (И-3) и FX-сокет глобуса (И-5, И-6)
     подробно регламентированы в [`src/AGENTS.md`](src/AGENTS.md) и [`docs/CHANGE_REQUEST_PLAN.md`](docs/CHANGE_REQUEST_PLAN.md).
   - Общая разметка `/sector/` и `/minimal/` правится только в `templates/atlas-shell.html`,
     а сборочный конвейер `.publish/` — в модулях `tools/vite/*` с контекстом `PublishPipelineState`
     (см. [`tools/AGENTS.md`](tools/AGENTS.md)).
3. **Запрет на коммит производных артефактов:**
   - Папка `.publish/`, нарезанные тайлы `assets/tiles/`, `assets/tiles.json`, `assets/map-preview.webp`
     и производные `assets/*.webp` исключены через `.gitignore`.
   - В Git хранятся только исходные изображения в `assets/src/`. Кэш изображений в `pages.yml`
     обязан зависеть от всех исходников `assets/src/`, `tools/build_assets.py` и `tools/requirements.txt`.

---

## 5. Правила языка, оформления и рабочего процесса

- **Русский язык:** все тексты пользовательского интерфейса, комментарии в коде, документация,
  заголовки/описания PR и сообщения коммитов пишутся **по-русски**.
- **Работа через ветку и PR:** прямые коммиты и пуши в `main` запрещены. На ветке `main`
  действует ruleset с требованием линейной истории (слияние выполняется через
  `gh pr merge <N> --squash --admin` или `--rebase --admin` по правилам текущего режима).
- **Визуальная проверка:** агент обязан проверять изменения тестами, сборкой и при необходимости
  headless-браузером, но финальная визуальная приёмка интерфейса и эффектов остаётся за владельцем.

---

## 6. Протокол сохранности работы (ветка, коммиты и изоляция)

- **Шаг 0 (проверка контура сохранения):** в начале задачи проверьте текущую рабочую ветку
  и выполните первый содержательный коммит с немедленным `git push -u origin HEAD`. Убедитесь,
  что `git rev-parse HEAD` совпадает с `origin/<ветка>`, а `git status --short` чист.
- **Коммит и пуш после каждого завершённого шага:** песочница и `/tmp` эфемерны и не сохраняются
  между сессиями (см. казус CR-01 PR 4 в `docs/HANDOFF.md` §7). Коммитьте и пушьте после каждого
  логического шага, не откладывая сохранение на конец задачи.
- **Запрет параллельной записи и чтения одного файла:** не отправляйте в одном блоке вызовов
  запись файла (`write_file`/`edit_file`) и зависящую от него команду `bash` — инструменты одного
  блока выполняются параллельно, и команда прочитает пустой или частичный файл.
- **Источник правды — только Git:** проверяйте сохранность работы только через `git status --short`,
  `git log` и `git diff --name-only origin/main...HEAD`, не ориентируясь на индикаторы UI.

---

## 7. Порядок ведения документации (`Single-Agent` vs `Split-Work`)

- **`docs/HANDOFF.md` и `CHANGELOG.md`:** фиксируют итоги этапов, архитектурные решения,
  замеры производительности и инфраструктурные особенности репозитория.
- **Стандартный одиночный режим (`Single-Agent`):** агент обновляет `docs/HANDOFF.md` и `CHANGELOG.md`
  в том же PR и после прохождения всех проверок `check.yml` доводит PR до слияния по указанию владельца.
- **Параллельный сплит-режим (`Split-Work` / `Tri-Agent Wave`):**
  1. При наличии карточки `Role & Boundary Card` строго следуйте
     [`docs/agents_task_orchestration/worker_instruction_on_splitwork.md`](docs/agents_task_orchestration/worker_instruction_on_splitwork.md)
     и разделу 7 [`docs/agents_task_orchestration/agents_task_orchestration.md`](docs/agents_task_orchestration/agents_task_orchestration.md).
  2. Разрешено создавать и изменять **только** файлы из своего списка `OWNED_FILES`
     (обязательна самопроверка `git status --short` и `git diff --name-only origin/main...HEAD`).
  3. Воркерам 1 и 2 категорически запрещено трогать `docs/HANDOFF.md` и `CHANGELOG.md` —
     сводку всей волны централизованно оформляет **Worker-3**.
  4. Каждый воркер открывает PR в `main` и останавливается перед слиянием (`Стоп перед merge`).
