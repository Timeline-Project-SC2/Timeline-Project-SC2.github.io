# ADM-SECTOR-RECON-CHAIN: цепочка разведки сектора (короткая карточка)

> **Назначение:** «карточка в карточке». Здесь только порядок и ссылки на полные версии; полные версии выдаются воркеру по одной, по мере готовности отчётов.
> **База:** `origin/main = 3554e92` ([PR #359](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/359)); активная ветка `arena/19b09273-timeline-project-sc2-github-io`. Язык — русский.
> **Правило изоляции:** между этапами передаются **только отчёты**. Детали карточки Р2 (её задание, файлы, критерии) не раскрываются Р1, Р3, Р4 и не выносятся в эту карточку — «без деталей второго».

## Порядок

1. **Р1 — разведка кода**, read-only. Инвентаризация модулей редактора границ и карты в `main`. Пишет отчёт ≤30 строк и передаёт его **Р2**. [Полная версия](ADM-SECTOR-R1-CODE.md).
2. **Р2 — разведка функционала.** Работает **только по отчёту Р1**; проверяет, что реально работает на `/sector/` и `/sector/admin-edit/`. Пишет отчёт ≤30 строк и передаёт его **Р3**. [Полная версия](ADM-SECTOR-R2-FUNCTION.md) — детали здесь не приводятся.
3. **Р3 — разведка документации.** Работает **только по отчёту Р2**; сверяет документы с фактом, правок не вносит. Пишет отчёт ≤30 строк и передаёт **Р4** свой отчёт **плюс дословно отчёт Р2**. [Полная версия](ADM-SECTOR-R3-DOCS.md).
4. **Р4 — занесение изменений, отдельно.** Выдаётся **только после** отчётов Р2 и Р3, работает **только по этим двум отчётам**: отчёт Р1 и детали чужих карточек не получает. Вносит минимальные подтверждённые правки в документы, готовит PR; слияние — по отдельному решению владельца. [Полная версия](ADM-SECTOR-R4-APPLY.md).

Цепочка: `Р1 → отчёт → Р2 → отчёт → Р3 → (отчёт Р3 + отчёт Р2) → Р4`. Р4 к цепочке 1-2-3 не присоединяется и запускается отдельной выдачей.

## Текст для копирования владельцем

~~~~text
Цепочка разведки сектора, база main = 3554e92. Выдавать последовательно 1-2-3, четвёртую — отдельно.
1) Р1: разведка кода, read-only, отчёт ≤30 строк передать Р2. Карточка: <ссылка на ADM-SECTOR-R1-CODE.md>
2) Р2: разведка функционала только по отчёту Р1, отчёт ≤30 строк передать Р3. Карточка: <ссылка на ADM-SECTOR-R2-FUNCTION.md>
3) Р3: разведка документации только по отчёту Р2, правок не вносить; передать Р4 свой отчёт и дословно отчёт Р2. Карточка: <ссылка на ADM-SECTOR-R3-DOCS.md>
4) Р4: отдельная выдача после отчётов Р2 и Р3, только по ним, без отчёта Р1. Карточка: <ссылка на ADM-SECTOR-R4-APPLY.md>
Между этапами передаются только отчёты; детали карточки Р2 не раскрываются. Агента запускает владелец; Гайдлайнер агентов не запускает.
~~~~

## Блок для автопарсинга

~~~~text
ADM_SECTOR_RECON_CHAIN_V1
role=rc-07_card_in_card_redirect
base=3554e926869ae7b510225dd8452725978f8871fa
branch=arena/19b09273-timeline-project-sc2-github-io
order=1,2,3_sequential;4_separate
card_1_id=ADM_SECTOR_R1_CODE
card_1_path=docs/agents_task_orchestration/wave_cards/ADM-SECTOR-R1-CODE.md
card_2_id=ADM_SECTOR_R2_FUNCTION
card_2_path=docs/agents_task_orchestration/wave_cards/ADM-SECTOR-R2-FUNCTION.md
card_3_id=ADM_SECTOR_R3_DOCS
card_3_path=docs/agents_task_orchestration/wave_cards/ADM-SECTOR-R3-DOCS.md
card_4_id=ADM_SECTOR_R4_APPLY
card_4_path=docs/agents_task_orchestration/wave_cards/ADM-SECTOR-R4-APPLY.md
report_1_to=2
report_2_to=3_and_4
report_3_to=4
report_1_to_4=false
report_lines_max=30
report_labels=vybrano,predlozhenie,nablyudenie,dokazano
isolate_card_2_details=true
pass_only_reports=true
issue_4_after=reports_2_and_3
agent_launch=owner_only
parse_order=main_then_this_card_then_full_cards
~~~~

## Границы

Актуальный [план закрытия сектора](../../stages/stage-09-12-sector/plan-to-close-sector.md), [статус](../../handoff/status-and-state.md), [руководство администратора](../../admins/sector-areas-editor.md). Проверки — только критический минимум, остальное `TODO (конец сессии)`. Живое применение, публикация, данные, Sheets/sync, планеты, OAuth/App/секреты/workflow/сервер, вторая модерация и PR #348 — `HOLD`. Исторические карточки не переписываются.

## Ссылки

- [Индекс оркестрации](../README.md) · [ED-1](ADM-EDITOR-BUBBLE-CUT.md) · [ED-2](ADM-EDITOR-MODULES-WORKING-VIEW.md) · [карточка-редирект ADM-ACCESS](ADM-ACCESS-CARDS-REDIRECT.md)
