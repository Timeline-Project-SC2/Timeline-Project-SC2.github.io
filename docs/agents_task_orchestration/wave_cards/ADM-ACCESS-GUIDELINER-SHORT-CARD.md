# ADM-ACCESS-GUIDELINER-SHORT-CARD: краткая передача rc-07

> **Кому:** Гайдлайнер (`rc-07`) в новом чате, не воркер 1/2. Старые задания A0-* исторические, кроме явно реактивированного A0-P.
> **Ветка:** `arena/8a554f34-timeline-project-sc2-github-io`, статус `active`, дерево чистое; `HEAD = faa8b2ec127aa404c69a373387000fb482cf916e` = `origin/main`.
> **Прямая ссылка на ветку:** [карточка на `arena/8a554f34-…`](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/8a554f34-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-GUIDELINER-SHORT-CARD.md).
> **Правило владельца:** поздние прямые решения выше старых примеров; отделять выбранное / предложение / наблюдение / доказанную реализацию. Правки и доп. руководства выдавать ссылкой сразу на ветку, где они сделаны, или заносить в `main`; «иной вид» — карточка в карточке с редиректом на ветку для автопарсинга.
> **О-5:** только документация, Git-метаданные, официальные документы и сводки PR/CI. Код, тесты, данные и конфиги не читать и не исполнять; факты реализации — от воркера и CI.

## Состояние на 02.11.2026

- `main = faa8b2e…`; [PR #349](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/349) и [PR #350](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/350) слиты squash без `--admin`, CI 4/4. Открыт только [PR #348](https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/pull/348): `draft`, `dirty`, без CI, не мёржить и не закрывать.
- **Выбрано владельцем:** узкий Cloudflare Worker OAuth-посредник + доступ через zapret только для логина GitHub и автоматического создания/отправки issue; не прокси сайта, не живая запись. «Что добавлять в zapret» — позже, админы настраивают сами.
- **Лимит доказан:** Workers Free — **100 000 запросов в день**, сброс 00:00 UTC; `Observability events` — отдельный счётчик **200 000 log events/день** ([Limits](https://developers.cloudflare.com/workers/platform/limits/), [Pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)). Скриншот панели владельца — наблюдение, не «в месяц».
- **Целевой UX:** правки → подтверждение в панели → вход/разрешение GitHub → автосоздание issue → проверки → автоприменение и публикация без второй ручной модерации. Ручная предзаполненная форма не замена; код issue не авторизация; проверять реального отправителя и активного Owner организации.
- **Активные карточки в `main`:** [карточка-редирект](ADM-ACCESS-CARDS-REDIRECT.md), [CF Worker](ADM-ACCESS-CF-WORKER-AUTH.md), [реактивированный A0-P](ADM-ACCESS-A0-P-REACTIVATION.md). Исторические `AUTH-PLAN`, `ORCHESTRATOR-HANDOFF`, `AUTH-TASK`, `DRAFT-PREVIEW-TASK`, `status-and-state.md` и `README.md` имеют блоки преемственности; старые тексты не переписывать.
- **HOLD:** живое применение, данные, Sheets/sync, планеты, OAuth-настройки, App, секреты, workflow, сервер, тестовые данные, новая тестовая issue, сигнал Submit, связь черновика с авто-issue, общая запись, `baseVersion`, очередь, `edit→restore`, атомарность, публикация, вторая модерация, независимый критик и тест до готовности редактора.

## Границы

Работать только в своей активной ветке; не переключать и не создавать ветки, не делать `reset`/force-push, не менять настройки ради доступа. Не запускать агентов/автоматизацию без отдельного решения владельца; при выдаче задачи указывать конкретного воркера, прежний чат и прямую карточку. Не создавать issue, App, секреты, workflow, PR, сервер, тестовые данные и новую задачу без явного указания; `--admin` разрешается отдельно для каждого PR. Не запрашивать пароли, токены и ключи; не публиковать секреты и непубличные данные.

## Следующий шаг

Владелец копирует промпт из активной карточки **воркеру 1**; Гайдлайнер принимает отчёт до 30 строк и сверяет факты по сводкам CI/PR. Слияние PR #348, настройки, реализация и тест — только отдельными командами владельца.

## Блок для автопарсинга

~~~~text
ADM-ACCESS_GUIDELINER_SHORT_CARD_V1
role=rc-07
branch=arena/8a554f34-timeline-project-sc2-github-io
branch_status=active
head=faa8b2ec127aa404c69a373387000fb482cf916e
main=faa8b2ec127aa404c69a373387000fb482cf916e
card_url=https://github.com/Timeline-Project-SC2/Timeline-Project-SC2.github.io/blob/arena/8a554f34-timeline-project-sc2-github-io/docs/agents_task_orchestration/wave_cards/ADM-ACCESS-GUIDELINER-SHORT-CARD.md
canonical_active_cards=main
redirect_card=docs/agents_task_orchestration/wave_cards/ADM-ACCESS-CARDS-REDIRECT.md
rule=правки ссылкой на ветку активной сессии или сразу в main
parse_order=сначала main, затем card_url для незалитых правок
do_not_launch_agents_without_owner_decision=true
do_not_merge_pr348=true
do_not_create_pr_without_instruction=true
next=владелец копирует промпт воркеру 1; rc-07 принимает отчёт <=30 строк
~~~~

## Ссылки

- [Индекс оркестрации](../README.md)
- [Карточка-редирект активных задач](ADM-ACCESS-CARDS-REDIRECT.md)
- [Передача оркестратору](ADM-ACCESS-ORCHESTRATOR-HANDOFF.md)
- [Статус и состояние](../../handoff/status-and-state.md)
- [CHANGELOG](../../../CHANGELOG.md)
