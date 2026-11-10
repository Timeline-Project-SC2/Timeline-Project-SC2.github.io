<!-- AUTO-GENERATED. DO NOT EDIT. npm run context -->
# Контекст задачи
context_version: 1
head_sha: 3773780 (на момент генерации); branch: arena/d431e921-timeline-project-sc2-github-io
Снимок состояния (head_sha, base_sha): (37737808a3a39e653ef2e49bb41c23a57dba3d9f, 37737808a3a39e653ef2e49bb41c23a57dba3d9f)
Факты и полномочия действуют для указанной пары; при изменении пары нужна повторная оценка.

## Правила
1. Старт сессии = чтение CONTEXT.md. Архив не читается, если файл не указан в allowed_scope.
2. Внутри задачи CONTEXT.md заморожен; новые находки → parking[] в state.json.
3. Handoff = обновить state.json (и при необходимости decisions.json) → npm run context.
4. Parking применяется только между задачами при явном повышении context_version.
Статусы: FACT — подтверждено; INFERENCE — вывод; UNKNOWN — неизвестно; NOT_CHECKED — не проверено; CONFLICT — противоречие.

## Активная задача
- id: PR-2
- цель: Компактный контекст, реестр решений и передача состояния без нового мета-слоя.
- allowed_scope: data/state.json, data/decisions.json, tools/context.mjs, tests/context.test.mjs, package.json, CONTEXT.md, AGENTS.md, docs/handoff/, docs/archive/, docs/agents_task_orchestration/shift_handoff.md, docs/agents_task_orchestration/low_data_gpt_rule.md, tools/check_fast.mjs, docs/agents_task_orchestration/waves/protocol.md, docs/agents_task_orchestration/role_cards/rc-07-wave-orchestrator.md
- out_of_scope: Продуктовый код и данные атласа, Новые навыки, карточки и процессные проверки, Публикация и живой sync
- verify_cmd: npm run context && python3 tools/check_docs.py && npm run test:fast && npm test && npm run build

## Active decisions
- process-freeze (процесс): Мораторий на новый мета-слой: не создавать скиллы, карточки и процессные проверки.
- revision-limit (задача): Не более двух раундов правок на задачу.
- critic-objective (приёмка кода): Критик отклоняет код только при падении verify_cmd или нарушении active decision, не по вкусу.
- single-agent-topology (оркестрация): О-5 отменено: 1 задача = 1 агент с прямым доступом к репозиторию = 1 PR. Несколько воркеров — только для доказанно независимых каталогов без общих файлов.; supersedes: o5-zero-contact

## HOLD
- NOT_CHECKED: прежние HOLD редактора и живого применения описаны в истории; их снятие не проверялось.

## Parking
- пусто

## Последняя передача
- FACT: PR-1 #375 слит; исходная пара PR-2 — merge commit 3773780 / 3773780.
- FACT: восемь тестов пропущены с ссылкой на issue #374; CI PR-1 зелёный при последовательном запуске.
- NOT_CHECKED: визуальная и runtime-приёмка сайта в PR-2 не проводилась.
