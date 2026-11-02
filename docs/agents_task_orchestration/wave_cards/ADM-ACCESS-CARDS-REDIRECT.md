# ADM-ACCESS-CARDS-REDIRECT: редирект активных карточек для автопарсинга

> **Назначение:** «карточка в карточке». Живёт в `main`, чтобы агент, который автоматически разбирает задачи, нашёл актуальные карточки и перешёл на ветку, где они правятся. Правило владельца от 02.11.2026: правки и доп. руководства выдавать **ссылкой сразу на ветку**, в которой они делаются, **или заносить в `main`**. Этот файл — второй вариант плюс редирект на первый.
> **Ветка правки:** `arena/911dc5ef-timeline-project-sc2-github-io` (`active`). После [PR #349](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/349) каноническая копия — в `main`; ссылки на ветку сохраняются для незалитых правок.
> **Не путать:** PR #348 (`arena/72ebd293-...`) — отдельный draft A0-P, не источник этих карточек.

## Активные карточки

| Задача | Воркер / прежний чат | Файл в `main` | Прямая ссылка на ветку | Статус |
|---|---|---|---|---|
| Узкий CF Worker OAuth-посредник | Воркер 1, `A0-F → A0-S → A0-S2 → A0-S3 → A0-N → A0-O` | [`ADM-ACCESS-CF-WORKER-AUTH.md`](ADM-ACCESS-CF-WORKER-AUTH.md) | [blob на ветке](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/911dc5ef-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-CF-WORKER-AUTH.md) | выдана 02.11.2026; read-only разведка, агент не запущен |
| Реактивированный `A0-P` | Воркер 1, `A0-F → A0-S → A0-S2 → A0-S3 → A0-N → A0-O → A0-P` | [`ADM-ACCESS-A0-P-REACTIVATION.md`](ADM-ACCESS-A0-P-REACTIVATION.md) | [blob на ветке](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/911dc5ef-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-A0-P-REACTIVATION.md) | выдана 02.11.2026; новая сверка PR #348, агент не запущен |

## Блок для автопарсинга

~~~~text
ADM-ACCESS_CARDS_REDIRECT_V1
rule=правки выдавать ссылкой на ветку или заносить в main
branch=arena/911dc5ef-timeline-project-sc2-github-io
branch_status=active
canonical_after_pr349=main
parse_order=сначала main, затем blob_url, если в main файл отсутствует или устарел
do_not_reissue=ADM-ACCESS-AUTH-TASK.md, ADM-ACCESS-DRAFT-PREVIEW-TASK.md, ADM-ACCESS-AUTO.md, ADM-ACCESS-CONTRACT.md
card_1_id=ADM-ACCESS-CF-WORKER-AUTH
card_1_path=docs/agents_task_orchestration/wave_cards/ADM-ACCESS-CF-WORKER-AUTH.md
card_1_blob_url=https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/911dc5ef-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-CF-WORKER-AUTH.md
card_1_worker=1
card_1_prev_chat=A0-F → A0-S → A0-S2 → A0-S3 → A0-N → A0-O
card_1_status=issued_read_only_no_agent
card_2_id=ADM-ACCESS-A0-P-REACTIVATION
card_2_path=docs/agents_task_orchestration/wave_cards/ADM-ACCESS-A0-P-REACTIVATION.md
card_2_blob_url=https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/911dc5ef-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-A0-P-REACTIVATION.md
card_2_worker=1
card_2_prev_chat=A0-F → A0-S → A0-S2 → A0-S3 → A0-N → A0-O → A0-P
card_2_status=issued_reactivation_no_agent
external_pr_348=draft_do_not_merge
workers_free_limit=100000_requests_per_day_reset_0000UTC
workers_free_limit_source=https://developers.cloudflare.com/workers/platform/limits/
~~~~

## Границы

- Лимит Workers Free: **100 000 запросов в день**, сброс 00:00 UTC; `Observability events` — отдельный счётчик 200 000/день. Подтверждено [Limits](https://developers.cloudflare.com/workers/platform/limits/) и [Pricing](https://developers.cloudflare.com/workers/platform/pricing/); скриншот владельца — наблюдение.
- CF Worker + zapret выбраны владельцем только для логина GitHub и автосоздания issue; это не прокси сайта и не живая запись.
- Живое применение, данные, Sheets/sync, планеты, OAuth-настройки, секреты, workflow, вторая модерация, слияние PR #348 — `HOLD` / отдельные решения.
- Исторические карточки не переписываются; преемственность фиксируется блоками и этим редиректом.

## Ссылки

- [Индекс оркестрации](../README.md)
- [План входа](ADM-ACCESS-AUTH-PLAN.md)
- [Передача оркестратору](ADM-ACCESS-ORCHESTRATOR-HANDOFF.md)
- [Статус и состояние](../../handoff/status-and-state.md)
- [PR #349](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/349)
