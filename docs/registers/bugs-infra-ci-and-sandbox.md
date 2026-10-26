# Баги инфраструктуры: мерж, CI, песочница и инструменты

> Назад: [документация](../README.md) · [шаг 0 консолидации](../consolidation/README.md)

Сквозные баги среды исполнения: слияния и CI, песочница и инструментарий агентов.

## Мерж и CI

Среда выполнения: GitHub, rulesets `main`, Actions, проверки PR. Этапные
проявления — в `stages/stage-NN/bugs.md`.

Назад: [регистры](README.md) · [документация](../README.md).

### B-M01 · `gh pr merge` отказывает, хотя REST-мерж проходит

**Симптом.** `gh pr merge <N> --merge` печатает `base branch policy prohibits
the merge`, `mergeStateStatus = BLOCKED`, но обычный REST-запрос сливает PR.
**Причина.** `gh` отклоняет мерж на своей стороне из-за правила `update`
(`BotsOverwrite`); bypass-актор интеграции клиенту не раскрывается.
**Проверено.** 25.10.2026, PR #240: REST-мерж прошёл при ещё выполнявшемся
чеке «Скрипты сайта».
**Обход.** `gh api -X PUT repos/{owner}/{repo}/pulls/<N>/merge -f
merge_method=merge` (или `squash`/`rebase`); либо `gh pr merge <N> --squash
--admin`.
**Вывод.** `BLOCKED` в `gh pr view` — ожидаемое состояние, не доказательство
запрета. Решает ответ REST.
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md) (историческая редакция).

### B-M02 · Классическая branch protection выключена

**Симптом.** API `GET /branches/main/protection*` и `POST /rulesets` отдают
`403 Resource not accessible by integration`.
**Причина.** Политика живёт в rulesets; у интеграции Arena нет прав на чтение
правил организации.
**Что делать.** Причины блокировки смотреть в UI: PR → «Merging is blocked» →
Details; `Settings → Branches`; `Settings → Rules` (Repository и Organization).
Не пытаться менять политику из агента.
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-C01 · Чек «Скрипты сайта» красный на всех PR

**Симптом.** В общем прогоне `npm test` падают 8 тестов: `local-map-stage8`
(4), `local-map-stand` (3), `local-map-texture-812d` (1; отдельно проходит).
**Причина.** Известный дрейф планетарного контура Stage-8: гребни 8.5,
golden-хэш A-17, W26b `m.11`/`m.14`, диагностика стыка/берега. На базовом
`fa18ef4` — те же 172/180.
**Что делать.** Не добавлять чек в обязательные, пока тесты не починены.
Не пересчитывать golden вслепую.
**Источник.** [`stages/stage-08/bugs.md`](../stages/stage-08/bugs.md),
[`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-C02 · Переезд `ubuntu-latest` на 26.04

**Симптом.** С 19.10 по 19.11.2026 GitHub переводит `ubuntu-latest` на
Ubuntu 26.04 (actions/runner-images#14748); системный Python там 3.14.
**Что сделано.** `check.yml` собирает на `ubuntu-24.04` и `ubuntu-26.04`;
Pillow зафиксирован `pillow>=13,<14` (колёса под 3.12–3.14).
**План Б.** В `pages.yml` поставить `runs-on: ubuntu-24.04`.
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-C03 · Версии GitHub Actions на Node 24

**Симптом.** Старые мажоры экшенов дают предупреждения Node 20.
**Рабочие версии.** `checkout@v7`, `setup-python@v7`, `setup-node@v7`,
`configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`,
`upload-artifact@v7`. Ниже `upload-artifact@v5` и `configure-pages@v5` не
опускаться.
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-C04 · Красный `npm test` обрывает последующие шаги CI

**Симптом.** `check:planet-core` и `lint` в job «Скрипты сайта» не выполнялись,
потому что стояли после `npm test`.
**Причина.** В одном `run`-блоке шаги последовательные; красный тест
останавливает блок.
**Что сделано.** Верификаторы сектора перенесены **до** `npm test`; решение
№14 F-1 — отдельная микрозадача по `check.yml`.
**Источник.** [`stages/stage-09-12-sector/decisions.md`](../stages/stage-09-12-sector/decisions.md),
F-1 §11.

### B-C05 · Тест проходит отдельно и падает в общем прогоне

**Симптом.** `local-map-texture-812d.test.mjs` — 2/0 отдельно и 1 падение в
общем прогоне.
**Причина.** Порядок/общее состояние тестов (`--test-concurrency=1` не
изолирует модульный кэш).
**Что делать.** Считать известным дефектом, не «прятать» перестановкой;
чинить изоляцию в отдельной задаче.
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-C06 · `npm run build` как единственная проверка документации

**Симптом.** Битая ссылка или файл на 2 000 строк проходят CI: сборка не
читает Markdown.
**Что сделано.** `npm run verify:docs` (`tools/check_docs.py`) проверяет лимит
строк, H1 и ссылки; добавлен в job «Сборка».
**Источник.** [`README.md`](../README.md) §5.

## Песочница и инструменты

Среда: эфемерная песочница, агентские инструменты записи, headless-браузер,
локальные проверки.

Назад: [регистры](README.md) · [документация](../README.md).

### B-S01 · Песочница и `/tmp` не переживают сессию

**Симптом.** После паузы исчезают незакоммиченные файлы и временные логи.
**Причина.** Песочница эфемерна; `/tmp` не входит в снапшот.
**Правило.** Коммит + push после каждого шага. Крупные данные и эталоны —
в Git, не в `/tmp`.
**Источник.** [`errors-systemic.md`](errors-systemic.md) E-01, [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-S02 · Параллельная запись и чтение файла

**Симптом.** `bash` читает пустой/частичный файл сразу после `write_file`.
**Причина.** Инструменты одного блока выполняются параллельно.
**Правило.** Зависимые вызовы — в разных сообщениях.
**Источник.** [`errors-systemic.md`](errors-systemic.md) E-02.

### B-S03 · Headless Chromium для скриншотов

**Симптом.** Страница не запускается, библиотеки не находятся.
**Рабочая схема.** `npm i puppeteer-core @sparticuz/chromium` во временной
папке; распаковать `node_modules/@sparticuz/chromium/bin/al2023.tar.br`
(brotli + tar) в `libs/`; запуск с `LD_LIBRARY_PATH=<папка>/libs/lib:<папка>/libs`;
модуль экспортирует `default`.
**Нюансы.** Первые секунды висит прелоадер — кликать, когда
`document.elementFromPoint` в центре возвращает сам элемент. Скриншот на
глубоком зуме снимать с остановленным временем (подмена `performance.now`,
`rAF`, таймеров).
**Источник.** [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-S04 · Курсор не виден в headless-браузере

**Симптом.** `cursor-fx.ts` не включается: `matchMedia('(any-pointer: fine)')`
в headless ложно.
**Что делать.** Подменять `matchMedia` через `page.evaluateOnNewDocument`,
сверять `getComputedStyle(el).cursor`, `CursorFx.info()`, `frames()`.
Стоимость — CDP `Performance.getMetrics`.
**Нюанс.** `?cursor=off` запоминается; следующую страницу открывать с
`?cursor=auto`.
**Источник.** [`handoff/checks.md`](../handoff/repo-zoom-and-rules.md).

### B-S05 · UI-счётчик изменённых строк врёт

**Симптом.** Счётчик Arena зависает («+712») или показывает несуществующие
изменения.
**Причина.** Индикатор UI не транзакционен.
**Правило.** Источник правды — Git.
**Источник.** [`errors-systemic.md`](errors-systemic.md) E-03.

### B-S06 · Сплющенные логи и «съеденный» код

**Симптом.** При восстановлении из логов появляются несуществующие имена и
формулы.
**Причина.** `//`-комментарии съедают следующую строку; конспекты искажают
идентификаторы.
**Правило.** Сверяться с эталонными файлами репозитория; extracted-код
проверять `tsc` и FULL EQ.
**Источник.** [`errors-systemic.md`](errors-systemic.md) E-04.

### B-S07 · `umask`/права на файлы после распаковки

**Симптом.** Исполняемые файлы Chromium не запускаются из распакованного
архива.
**Что делать.** Проверить `chmod +x` на `chrome`/`headless_shell`; путь к
`libs` задавать абсолютным.
**Источник.** локальная практика проверок, [`handoff/infra-pitfalls.md`](../handoff/infra-pitfalls.md).

### B-S08 · Долгий первый кадр и ложный HUD

**Симптом.** HUD показывает p95 76–116 мс и кадры >100 мс, хотя окно
захватывает генерацию и GPU-заливку.
**Причина.** Статистика не сбрасывалась в момент финальной подмены VAO;
адаптер качества падал до пола из-за загрузки, а не steady-рендера.
**Что сделано.** Сброс статистики ровно при подмене; удержание адаптера во
время генерации/заливки; страница объявляет готовность после фактической
подмены.
**Источник.** [`stages/stage-06/bugs.md`](../stages/stage-06/bugs.md).

### B-S09 · Скрытые GPU-бандлы конкурируют с LOD

**Симптом.** После скрытой подготовки бандлов LOD-переходы дёргаются,
появляются «попа» и лишние пересборки.
**Причина.** Несколько цепочек подготовки геометрии работают одновременно.
**Что сделано.** Речек LOD-планировщика, мгновенный LOD-commit, отсечение
устаревших ответов токеном генерации.
**Источник.** [`stages/stage-01/notes/lod-planner-recheck.md`](../stages/stage-01/notes/mobile-lod-and-gpu-bundles.md).
