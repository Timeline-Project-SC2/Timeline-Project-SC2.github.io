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
| Что сделано в последних волнах и чем это закончилось | [`handoff/status-and-state.md`](handoff/status-and-state.md) |
| Что вообще есть в репозитории и где что лежит | [`handoff/repo-zoom-and-rules.md`](handoff/repo-zoom-and-rules.md) |
| Что сделано по частям (тайлы, атлас, сектор) | [`handoff/status-and-state.md`](handoff/status-and-state.md) |
| Очередь и пробный порядок работы по сектору | [План следующей сессии](stages/stage-09-12-sector/todo.md) |
| Состояние данных, синка и живых листов | [`handoff/status-and-state.md`](handoff/status-and-state.md) |
| Концепция процедурной модели орбитальной станции | [`concepts/station-generator-plan.md`](concepts/station-generator-plan.md) |
| Что осталось проверить владельцу глазами | [`handoff/status-and-state.md`](handoff/status-and-state.md) |
| Как устроен прицел и переход по областям | [`handoff/repo-zoom-and-rules.md`](handoff/repo-zoom-and-rules.md) |
| Известные ловушки среды и снапшотов | [`handoff/infra-pitfalls.md`](handoff/infra-pitfalls.md) |
| Команды проверки перед PR | [`handoff/repo-zoom-and-rules.md`](handoff/repo-zoom-and-rules.md) |
| Правила пользователя (язык, ветки, merge) | [`handoff/rules.md`](handoff/rules.md) |
| Что означают рабочие сокращения и названия | [Краткий словарик](README.md#как-читать-рабочие-обозначения) |

## История по волнам

| Период | Файл |
|---|---|
| 22–23.10: Stage-8.x, Stage-7, DX-1, PR 6.1 | [`handoff/history-cr01-to-sector.md`](handoff/history-cr01-to-sector.md) |
| 21–22.10: CR-01, PR 4–6 | [`handoff/history-cr01-to-sector.md`](handoff/history-cr01-to-sector.md) |
| 19.10: Этапы 1–2 планет | [`handoff/history-early.md`](handoff/history-early.md) |
| 18.10: галактика, Копрула, системный курсор | [`handoff/history-early.md`](handoff/history-early.md) |
| 24.10: под-уровень Этапов 9–12 | [`handoff/history-cr01-to-sector.md`](handoff/history-cr01-to-sector.md) |
| 23.10: проектирование Этапа 9 | [`handoff/history-cr01-to-sector.md`](handoff/history-cr01-to-sector.md) |

## Где актуальный статус, а не история

- Работает / осталось / закрыто: [`docs/registers/todo.md`](registers/todo.md).
- Открытые решения владельца: [`docs/registers/decisions.md`](registers/decisions.md).
- Систематические ошибки: [`docs/registers/errors-systemic.md`](registers/errors-systemic.md).
- Баги среды и контрактов: [`docs/registers/README.md`](registers/README.md).
- Текущая волна: [`docs/agents_task_orchestration/agents_task_orchestration.md`](agents_task_orchestration/agents_task_orchestration.md).
- Упрощение документации, тестов и кода: [карточка `UP-1`](agents_task_orchestration/wave_cards/UP-1.md) и [замечания к работе](agents_task_orchestration/wave_cards/UP-1-review.md). PR #325 доработан, но остаётся открыт и не слит. По отдельному указанию владельца 29.10 выполнены только аудит генератора планет и документация [концепции станции](concepts/station-generator-plan.md); реализация модели и её визуальная приёмка не начаты.

## Главное правило

Полный текст прежних редакций доступен из Git-истории: `git show a7503e6:docs/HANDOFF.md`.
