<!-- AUTO-GENERATED. DO NOT EDIT. npm run context -->
# Контекст задачи
context_version: 2
head_sha: 756cba0 (на момент генерации); branch: arena/218e76ae-timeline-project-sc2-github-io
Снимок состояния (head_sha, base_sha): (756cba0604e7dc6789edf80bcf435a017c58fc67, 0b3cd9b261b783348d698baaa48461edb39fcc06)
Факты и полномочия действуют для указанной пары; при изменении пары нужна повторная оценка.

## Правила
1. Старт сессии = чтение CONTEXT.md. Архив не читается, если файл не указан в allowed_scope.
2. Внутри задачи CONTEXT.md заморожен; новые находки → parking[] в state.json.
3. Handoff = обновить state.json (и при необходимости decisions.json) → npm run context.
4. Parking применяется только между задачами при явном повышении context_version.
Статусы: FACT — подтверждено; INFERENCE — вывод; UNKNOWN — неизвестно; NOT_CHECKED — не проверено; CONFLICT — противоречие.

## Активная задача
- id: EDITOR-ACCEPT
- цель: Редактор сектора: иерархия областей (#372) на текущем main — доказанная браузерным прогоном приёмка владельца и оформление PR.
- allowed_scope: src/atlas/sector-areas-anchors.ts, src/atlas/sector-areas-pairs.ts, src/atlas/sector-areas-groups.ts, src/atlas/sector-areas-hierarchy.ts, src/atlas/sector-areas-hierarchy-ui.ts, src/atlas/sector-bounds-edit.ts, src/atlas/sector-bounds-edit-ui.ts, src/atlas/sector-areas-contract.ts, src/atlas/sector-areas-render.ts, src/atlas/sector-areas-editor.ts, src/atlas/sector-areas-editor-ui.ts, tests/sector-areas-*, tests/sector-bounds-edit-*, data/sector-areas.json, data/state.json, data/decisions.json, CONTEXT.md, CHANGELOG.md, docs/admins/sector-areas-editor.md, docs/admins/sector-editor/, tools/audit_bounds_edit.mjs, package.json
- out_of_scope: Восемь пропущенных тестов (issue #374), Слияние и закрытие #365/#369/#370/#371/#372 без решения владельца, Ручной Pages deploy и живой sync, Новый мета-слой: скиллы, карточки, процессные проверки
- verify_cmd: npm run context && python3 tools/check_docs.py && npm run check:fast -- --all && npm test && npm run build

## Active decisions
- process-freeze (процесс): Мораторий на новый мета-слой: не создавать скиллы, карточки и процессные проверки.
- revision-limit (задача): Не более двух раундов правок на задачу.
- critic-objective (приёмка кода): Критик отклоняет код только при падении verify_cmd или нарушении active decision, не по вкусу.
- single-agent-topology (оркестрация): О-5 отменено: 1 задача = 1 агент с прямым доступом к репозиторию = 1 PR. Несколько воркеров — только для доказанно независимых каталогов без общих файлов.; supersedes: o5-zero-contact
- acceptance-combo (приёмка редактора): Приёмка редактора = браузерный прогон с доказательствами (скриншоты и числа из документа) + финальное решение владельца; CI и автотесты визуальную проверку не заменяют.

## HOLD
- NOT_CHECKED: визуальное соответствие карты оригиналу (границы, гало, туманности) — полноразмерного оригинала нет, данные атласа в песочнице недоступны.
- NOT_CHECKED: запрет пересечения — продуктовое решение о поведении при попытке пересечения не принято.
- NOT_CHECKED: отрисовка групп на карте — проверены панель и документ, не рендер.

## Parking
- FACT: compact context ускоряет цикл (npm test 63 с, один файл вместо handoff), но не исправляет восемь пропущенных тестов #374.
- INFERENCE: при создании пары карта меняет масштаб (кадр отъезжает); дефектом не подтверждено.
- FACT: в CHANGELOG.md из #372 в конец файла попал блок с литеральными \n вместо переводов строк — косметика, не блокер.

## Последняя передача
- FACT: содержимое #372 слито на main 0b3cd9b в ветке arena/218e76ae (756cba0); build, lint, verify:docs и npm test (810: 802 pass / 8 skip) зелёные.
- FACT: браузерный прогон подтвердил 6 якорей через L/6, уточнение 2+4 с неподвижной точкой клика и неизменность контура (смещение 0.000).
- FACT: пара split убирает мутное пятно наложения; ручная линия (manual=true, 113 точек) сохраняется после изменения контура; группы держат ID при переименовании.
- NOT_CHECKED: визуальная приёмка владельцем не проводилась; PR по интеграции не открыт.
- FACT: восемь пропущенных тестов остаются, issue #374 открыт.
