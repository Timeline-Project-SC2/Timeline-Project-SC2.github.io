# Конспект для следующего агента — навигация

Раньше это был один файл на 758 строк: статус, история волн, карта репозитория,
состояние данных, что проверить глазами, логика прицела, инфраструктурные грабли,
команды проверки и правила пользователя. 26.10.2026 он разнесён по контексту;
путь `docs/HANDOFF.md` сохранён, потому что на него ссылаются `AGENTS.md`,
доменные `AGENTS.md` и прошлые отчёты.

Назад: [документация](README.md) · [этапы](stages/README.md) · [регистры](registers/README.md) · [план](PREPARATION_PLAN.md).

## С чего начинать

| Вопрос | Файл |
|---|---|
| Что сделано в последних волнах и чем это закончилось | [`handoff/status.md`](handoff/status.md) |
| Что вообще есть в репозитории и где что лежит | [`handoff/repo-map.md`](handoff/repo-map.md) |
| Что сделано по частям (тайлы, атлас, сектор) | [`handoff/done-parts.md`](handoff/done-parts.md) |
| Состояние данных, синка и живых листов | [`handoff/data-state.md`](handoff/data-state.md) |
| Что осталось проверить владельцу глазами | [`handoff/visual-checks.md`](handoff/visual-checks.md) |
| Как устроен прицел и переход по областям | [`handoff/zoom-logic.md`](handoff/zoom-logic.md) |
| Известные ловушки среды и снапшотов | [`handoff/infra-pitfalls.md`](handoff/infra-pitfalls.md) |
| Команды проверки перед PR | [`handoff/checks.md`](handoff/checks.md) |
| Правила пользователя (язык, ветки, merge) | [`handoff/rules.md`](handoff/rules.md) |

## История по волнам

| Период | Файл |
|---|---|
| 22–23.10: Stage-8.x, Stage-7, DX-1, PR 6.1 | [`handoff/history-waves-2026-10-22-23.md`](handoff/history-waves-2026-10-22-23.md) |
| 21–22.10: CR-01, PR 4–6 | [`handoff/history-cr-01.md`](handoff/history-cr-01.md) |
| 19.10: Этапы 1–2 планет | [`handoff/history-planets-1-2.md`](handoff/history-planets-1-2.md) |
| 18.10: галактика, Копрула, системный курсор | [`handoff/history-galaxy-and-cursor.md`](handoff/history-galaxy-and-cursor.md) |
| 24.10: под-уровень Этапов 9–12 | [`handoff/history-sector-sublevel.md`](handoff/history-sector-sublevel.md) |
| 23.10: проектирование Этапа 9 | [`handoff/history-stage-9.md`](handoff/history-stage-9.md) |

## Где актуальный статус, а не история

- Работает / осталось / закрыто: [`docs/registers/todo.md`](registers/todo.md).
- Открытые решения владельца: [`docs/registers/decisions.md`](registers/decisions.md).
- Систематические ошибки: [`docs/registers/errors-systemic.md`](registers/errors-systemic.md).
- Баги среды и контрактов: [`docs/registers/README.md`](registers/README.md).
- Текущая волна: [`docs/agents_task_orchestration/agents_task_orchestration.md`](agents_task_orchestration/agents_task_orchestration.md).

## Главное правило

Полный текст прежних редакций доступен из Git-истории: `git show a7503e6:docs/HANDOFF.md`.
