# Баги: мерж, rulesets и CI

Среда выполнения: GitHub, rulesets `main`, Actions, проверки PR. Этапные
проявления — в `stages/stage-NN/bugs.md`.

Назад: [регистры](README.md) · [документация](../README.md).

## B-M01 · `gh pr merge` отказывает, хотя REST-мерж проходит

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
**Источник.** HANDOFF §7 (историческая редакция).

## B-M02 · Классическая branch protection выключена

**Симптом.** API `GET /branches/main/protection*` и `POST /rulesets` отдают
`403 Resource not accessible by integration`.
**Причина.** Политика живёт в rulesets; у интеграции Arena нет прав на чтение
правил организации.
**Что делать.** Причины блокировки смотреть в UI: PR → «Merging is blocked» →
Details; `Settings → Branches`; `Settings → Rules` (Repository и Organization).
Не пытаться менять политику из агента.
**Источник.** HANDOFF §7.

## B-C01 · Чек «Скрипты сайта» красный на всех PR

**Симптом.** В общем прогоне `npm test` падают 8 тестов: `local-map-stage8`
(4), `local-map-stand` (3), `local-map-texture-812d` (1; отдельно проходит).
**Причина.** Известный дрейф планетарного контура Stage-8: гребни 8.5,
golden-хэш A-17, W26b `m.11`/`m.14`, диагностика стыка/берега. На базовом
`fa18ef4` — те же 172/180.
**Что делать.** Не добавлять чек в обязательные, пока тесты не починены.
Не пересчитывать golden вслепую.
**Источник.** [`stages/stage-08/bugs.md`](../stages/stage-08/bugs.md),
HANDOFF §7.

## B-C02 · Переезд `ubuntu-latest` на 26.04

**Симптом.** С 19.10 по 19.11.2026 GitHub переводит `ubuntu-latest` на
Ubuntu 26.04 (actions/runner-images#14748); системный Python там 3.14.
**Что сделано.** `check.yml` собирает на `ubuntu-24.04` и `ubuntu-26.04`;
Pillow зафиксирован `pillow>=13,<14` (колёса под 3.12–3.14).
**План Б.** В `pages.yml` поставить `runs-on: ubuntu-24.04`.
**Источник.** HANDOFF §7.

## B-C03 · Версии GitHub Actions на Node 24

**Симптом.** Старые мажоры экшенов дают предупреждения Node 20.
**Рабочие версии.** `checkout@v7`, `setup-python@v7`, `setup-node@v7`,
`configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`,
`upload-artifact@v7`. Ниже `upload-artifact@v5` и `configure-pages@v5` не
опускаться.
**Источник.** HANDOFF §7.

## B-C04 · Красный `npm test` обрывает последующие шаги CI

**Симптом.** `check:planet-core` и `lint` в job «Скрипты сайта» не выполнялись,
потому что стояли после `npm test`.
**Причина.** В одном `run`-блоке шаги последовательные; красный тест
останавливает блок.
**Что сделано.** Верификаторы сектора перенесены **до** `npm test`; решение
№14 F-1 — отдельная микрозадача по `check.yml`.
**Источник.** [`stages/stage-09-12-sector/decisions.md`](../stages/stage-09-12-sector/decisions.md),
F-1 §11.

## B-C05 · Тест проходит отдельно и падает в общем прогоне

**Симптом.** `local-map-texture-812d.test.mjs` — 2/0 отдельно и 1 падение в
общем прогоне.
**Причина.** Порядок/общее состояние тестов (`--test-concurrency=1` не
изолирует модульный кэш).
**Что делать.** Считать известным дефектом, не «прятать» перестановкой;
чинить изоляцию в отдельной задаче.
**Источник.** HANDOFF §7.

## B-C06 · `npm run build` как единственная проверка документации

**Симптом.** Битая ссылка или файл на 2 000 строк проходят CI: сборка не
читает Markdown.
**Что сделано.** `npm run verify:docs` (`tools/check_docs.py`) проверяет лимит
строк, H1 и ссылки; добавлен в job «Сборка».
**Источник.** [`README.md`](../README.md) §5.
