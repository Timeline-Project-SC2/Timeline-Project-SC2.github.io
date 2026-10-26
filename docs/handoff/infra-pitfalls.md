# Инфраструктурные грабли

> Источник: `docs/HANDOFF.md`, строки 600–713 (редакция до разукрупнения).
> Назад: [конспект](../HANDOFF.md) · [этапы](../stages/README.md) · [документация](../README.md).

## 7. Инфраструктурные грабли

- **Снапшот теряет бинарники.** Между сессиями `assets/src/` (30 МБ) и собранные
  `assets/tiles/` исчезали, а указатель ветки откатывался на `main`. Лечится:
  `git fetch -q origin <ветка> && git reset --hard FETCH_HEAD`, затем Pillow в venv
  (`python3 -m venv /tmp/venv && /tmp/venv/bin/pip install -r tools/requirements.txt`; системный
  pip упирается в PEP 668) и `/tmp/venv/bin/python tools/build_assets.py`.
  Сборка картинок детерминирована — `imageVersion` в `meta.json` совпадает, исходный HTML/JS не переписывается.
- **jsdom не умеет canvas**, и `app.js` на этом останавливается — без подмены контекста
  прогон проверяет только загрузку, а не сам атлас. Стенд лежит в `/home/user/smoke2`
  (вне репозитория, не сохраняется): `mkdir -p /home/user/smoke2 && cd /home/user/smoke2 &&
  npm init -y && npm i jsdom`. Там `run.js` подменяет `getContext` прокси-заглушкой и
  подсовывает данные через `window.__MAP_DATA__`, собранные из `data/systems.csv` и
  `data/places.csv`. Плюс `matrix.js` — матрица «тип места → вкладка».
- **Сеть ограничена**: `github.com`, `codeload.github.com`, `api.github.com`,
  `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. До боевого сайта из bash не
  достучаться; `fetch_page` открывает HTML, но на `.csv`/`.json` отдаёт 500.
- **Права токена**: нельзя менять настройки Pages (403) и нельзя запускать
  `workflow_dispatch` (403). Деплой происходит только пушем в `main`, то есть мержем PR.
- **В Git — только исходники.** `assets/tiles/`, `assets/tiles.json`, `assets/map-preview.webp`
  и собранные `*.webp` в `.gitignore`; не коммитить их.
- **На `main` действует ruleset `BotsOverwrite`** (`id 25283890`, прежнее имя «ArenaOverwrite»,
  с 17.10; проверено 25.10.2026 через `GET /repos/…/rules/branches/main`). В нём четыре правила —
  `deletion`, `non_fast_forward`, `creation`, `update` (Restrict updates): обновлять ветку могут
  только те, кому разрешён обход. Bypass: `OrganizationAdmin`, роли `4`/`5`, Integration `4187077`.
  Требуемых статус-чеков в ruleset нет — их и не было, поэтому «красный» чек сам по себе мерж
  не блокирует.
- **`--admin` для мержа НЕ нужен — блокирует сам `gh`, а не GitHub.** Проверено 25.10.2026 на
  PR #240: обычный REST-мерж прошёл, пока чек «Скрипты сайта» ещё выполнялся, и без всякого обхода:
  `gh api -X PUT repos/{owner}/{repo}/pulls/<номер>/merge -f merge_method=merge`
  → `{"merged": true, "message": "Pull Request successfully merged"}`. При этом
  `mergeStateStatus` у PR остаётся `BLOCKED` (правило `update` из `BotsOverwrite` видит целевую
  ветку, а bypass-актор интеграции клиенту не раскрывается), и `gh pr merge <номер> --merge`
  отказывается **на своей стороне**, до запроса к API: печатает `base branch policy prohibits the
  merge`. Это ложный отказ, а не запрет.
  **Рабочие варианты:** `merge_method=merge` (обычный merge-коммит), `squash` или `rebase` —
  тем же запросом; либо `gh pr merge <номер> --squash --admin`, если нужен обход клиентской проверки.
  `BLOCKED` в `gh pr view --json mergeStateStatus` на этом репозитории — **ожидаемое состояние**,
  а не сигнал «мерж запрещён».
- **Классическая branch protection репозитория выключена** (баннер «Repository branch protection is
  disabled»), вся политика — в rulesets. Детали защиты интеграции Arena недоступны: `GET
  /branches/main/protection*` и `POST /rulesets` отдают `403 Resource not accessible by integration`,
  менять политику может только владелец в UI (`Settings → Rules`; `Settings → Branches` — создать заново).
- **Как узнать, что именно блокирует мерж (по порядку).**
  1. Открытый PR → правый нижний блок **«Merging is blocked»**: там дословная причина и ссылки
     «Details» / «Show all checks». У слитого PR этого блока уже нет — нужен свежий PR.
  2. `Settings → Branches` — классическая protection репозитория (живёт отдельно от rulesets).
  3. `Settings → Rules` — проверять **оба** уровня: строка «Repository» и «Organization»; правила
     организации интеграции недоступны (`GET /orgs/{org}/rulesets` → `403`), поэтому в UI их видно,
     а в API — нет.
  4. CLI: `gh pr view <номер> --json mergeable,mergeStateStatus`. Важно: здесь `BLOCKED` —
     **ещё не запрет** (см. пункт про `update` выше), поэтому решает не этот флаг, а сам REST-мерж:
     если он вернул `merged: true` — политика пропустила; если `405` — в тексте ответа причина.
  5. `gh api repos/{owner}/{repo}/branches/main/protection/required_status_checks` — список
     обязательных чеков классической protection (нужен админ-токен, у интеграции Arena `403`).
- **`Скрипты сайта` (job из `check.yml`) красный на всех PR — 8 из 180 тестов.** Картина на
  25.10.2026 (`npm test`, база `19bb9bf`):

  | Файл | В общем прогоне | Отдельно |
  |---|---|---|
  | `local-map-stage8.test.mjs` | 4 падения | 36/4: гребни Stage-8.5 (открытый равнинный сектор `25°` вместо `≥ 30°`), golden-хэш `A-17` (карта и ленивый чанк), диагностика стыка/берега `#43533…#43537` |
  | `local-map-stand.test.mjs` | 3 падения | 22/3: речные метрики на стенде A-17, W26b `m.14` (одинаковый span), W26b `m.11` (гипсометрия `45,93 %` против гейта `20…35 %`) |
  | `local-map-texture-812d.test.mjs` | 1 падение | 2/0 — **проходит отдельно**, падает только в общем прогоне (порядок/общее состояние) |
  | `planet-full-eq.test.mjs`, `planet-core-boundary.test.mjs` | 0 | 4/0 и 4/0 |

  На базовом `fa18ef4` в отдельном worktree — те же 172/180, то есть расхождение не от правок
  конкретного PR и не от документации. `typecheck`, `lint`, `check:planet-core`, `node --check`
  и `tests/travel-planner.test.js` проходят. Голдены трогать вслепую нельзя: пересчёт маскирует
  реальную регрессию, сначала нужно понять, чей это дрейф (код `local-map` против эталона).
  Поэтому чек **нельзя** добавлять в обязательные, пока тесты не починены.
- **Переезд `ubuntu-latest` на Ubuntu 26.04** — с 19.10 по 19.11.2026 (actions/runner-images#14748).
  Деплой к нему готов: Python 3.12 ставит `actions/setup-python` (в образе 26.04 он есть в кэше,
  системный там — 3.14), Pillow зафиксирован в `tools/requirements.txt` (`pillow>=13,<14`, колёса
  есть под 3.12–3.14). `check.yml` собирает сайт на `ubuntu-24.04` и `ubuntu-26.04` в каждом PR.
  Если деплой всё же упадёт на новом образе — в `pages.yml` поставить `runs-on: ubuntu-24.04`
  (одна строка, там же комментарий).
- **Экшены — на Node 24** (Node 20 на раннерах GitHub выводится из эксплуатации, старые мажоры
  давали предупреждения): `checkout@v7`, `setup-python@v7`, `setup-node@v7`, `configure-pages@v6`,
  `upload-pages-artifact@v5`, `deploy-pages@v5`, `upload-artifact@v7`. `upload-artifact@v5` и
  `configure-pages@v5` — ещё Node 20, ниже этих версий не опускаться.
- **Headless Chromium для скриншотов**: `npm i puppeteer-core @sparticuz/chromium` во временной
  папке, распаковать `node_modules/@sparticuz/chromium/bin/al2023.tar.br` (brotli + tar) в
  `libs/` и запускать с `LD_LIBRARY_PATH=<папка>/libs/lib:<папка>/libs`; модуль экспортирует
  `default`. В первые секунды над страницами висит прелоадер — кликать по карте только когда
  `document.elementFromPoint` в центре квадрата возвращает сам квадрат. Скриншот во время
  перехода на глубоком зуме идёт секундами: кадры снимать с остановленным временем
  (подмена `performance.now`, rAF и таймеров).
- `data/meta.json` пишут два скрипта: `sync.py` (источники, sha, размеры) и
  `build_assets.py` (`mapSize`, `assets.hasRaster`, версии). Ключи друг друга они не затирают.

- **Незакоммиченная работа гибнет с песочницей (казус CR-01 PR 4, октябрь 2026).**
  Старая сессия реализовала весь PR 4 и не закоммитила ничего; песочница
  умерла — потеряно всё, включая `/tmp`. Владелец приказал восстанавливать
  с нуля на новой ветке и прислал логи сессии (`commands.txt`,
  `dialog (6).txt`), из которых извлекли payload'ы модулей и эталоны.
  Протокол против повторения — `AGENTS.md`, раздел «Сохранность работы»:
  в начале задачи ветка и одна перепроверка совершения изменений
  (коммит → push → HEAD равен origin), дальше коммит после каждого этапа.
- **Гонка инструментов записи.** Запись файла и зависящая от него
  shell-команда (append, склейка частей) в одном блоке выполняются
  параллельно — команда читает пустой или частичный файл. При
  восстановлении так дважды терялась часть `planet-geography.ts`.
  Зависимые шаги слать строго разными сообщениями.
- **Индикаторы UI — не источник правды.** Счётчик изменённых строк Arena
  зависал («+712») и выглядел как потеря данных; по git потерь не было.
  Сохранность проверять только `git status` и сравнением HEAD с origin.
- **Логи старых сессий сплющены**: `//`-комментарии «съедают» следующий
  код, а имена в конспектах искажаются (при восстановлении surface
  всплыли несуществующие `plateTop1Id`/`biomeBlendWidth` вместо реальных
  `plateId`/`biomeSoftWidthCells`, а также выдуманные формулы дренажа и гор).
  Извлечённый код разрезать по смыслу, сверяться с эталонными файлами
  репозитория напрямую и валидировать tsc + побитовым FULL EQ; эталоны
  для сверки брать из репозитория, не из `/tmp` (относительные пути).
