# Оркестрация задач и карточки ролей

Папка описывает, **как мы делим работу между агентами** в этом репозитории. Слои, читать
сверху вниз:

| Файл | Отвечает на вопрос |
|---|---|
| [`agents_task_orchestration.md`](agents_task_orchestration.md) | Хаб: карта разделов `§1…§18` и правила `О-1…О-4` |
| [`waves/`](waves/protocol.md) | Сами разделы по волнам: `protocol`, `stage-6-dx`, `stage-8`, `sw-1`, `sw-2*`, `z-3`, `unit-*`, `f` |
| [`pull_request_template.md`](../pull_request_template.md) | Краткое описание PR: суть, проверки, границы и следующий шаг |
| [`worker_instruction_on_splitwork.md`](worker_instruction_on_splitwork.md) | Что делает **Воркер** в параллельной тройке: `OWNED_FILES`, самопроверка, формат отчёта |
| [`external_agency_agents_audit.md`](external_agency_agents_audit.md) | Откуда взяты карточки ролей: аудит внешнего набора `agency-agents`, что взято, что отброшено и почему |
| [`external_ci_gate_audit_2026-10-26.md`](external_ci_gate_audit_2026-10-26.md) | Внешний аудит CI-гейта: «привычно красный» `check.yml`, решения E1…E6, карточка [`CI-1`](wave_cards/CI-1.md) |
| [`role_cards/`](role_cards/) | **Что считать готовым** в конкретной зоне: восемь режимов работы одного агента |
| [`wave_cards/`](wave_cards/) | **Выданная карточка волны**: матрица файлов, контракт до буквы, шаги, гейты и журнал решений для конкретного воркера |
| [`shift_handoff.md`](shift_handoff.md) | **Передача смены Гайдлайнера**: где мы стоим, что читать, что делать первым, чего не повторять |

## Карточки ролей

| Карточка | Зона | Основные волны |
|---|---|---|
| [`rc-01-sector-render.md`](role_cards/rc-01-sector-render.md) | Сектор: процедурное поле, лестница глубины `L0…L12`, маркеры, полёт камеры, стрелки | `SW-1`…`SW-4` |
| [`rc-02-planetary-contour.md`](role_cards/rc-02-planetary-contour.md) | Планетарный контур: `src/local-map/*`, `src/planet/*`, Wasm-ядро, горизонт | вне волн 9–12 (`И-11`) |
| [`rc-03-cartography-ui.md`](role_cards/rc-03-cartography-ui.md) | Картография, подписи, цвет, состояния экрана, финиш-гейт интерфейса | `SW-3`…`SW-4` |
| [`rc-04-qa-evidence.md`](role_cards/rc-04-qa-evidence.md) | Проверки и доказательства: что проверено, чем и с каким результатом | все |
| [`rc-05-performance.md`](role_cards/rc-05-performance.md) | Бюджеты кадра, памяти и размера бандла; доступность | `SW-2`…`SW-5` |
| [`rc-06-docs-sync.md`](role_cards/rc-06-docs-sync.md) | `CHANGELOG`, `HANDOFF`, план, синхронизация данных | все, `SW-6` |
| [`rc-07-wave-orchestrator.md`](role_cards/rc-07-wave-orchestrator.md) | Постановка волны, лимит попыток, эскалация владельцу | перед каждой волной |
| [`rc-08-plan-critic.md`](role_cards/rc-08-plan-critic.md) | Red team плана: векторы отказа, манифест файлов, цена решения | перед каждой волной и на приёмке |

## Карточки волн

Отдельный файл на каждую выданную волну карточку ведёт Гайдлайнер (`rc-07`). Карточка — это
рабочий документ воркера: `OWNED_FILES`/`FORBIDDEN_FILES`, контракт символов, шаги с коммитами,
гейты, риски и журнал решений. Файлы карточек **не входят** в `OWNED_FILES` кодовых воркеров.

| Карточка | Волна | Статус |
|---|---|---|
| [`wave_cards/ADM-ACCESS.md`](wave_cards/ADM-ACCESS.md) | `ADM-ACCESS`: проверка GitHub и автоматизация изменений | Разведки и критика получены; реализация на `HOLD` до разрешения рисков |
| [`wave_cards/ADM-ACCESS-AUTO.md`](wave_cards/ADM-ACCESS-AUTO.md) | Сквозная автоматизация | Владелец выбрал автоматическое применение; проектирование вне планет разрешено |
| [`wave_cards/ADM-ACCESS-INTEGRATION.md`](wave_cards/ADM-ACCESS-INTEGRATION.md) | Подключение, права и Discord | Ручной тест App прошёл; автоматическая запись и Discord не включены |
| [`wave_cards/ADM-ACCESS-APP-PROBE.md`](wave_cards/ADM-ACCESS-APP-PROBE.md) | Воркер 2: ручная проверка App `A0-K3` | PR #343 слит; токен и проверка роли инициатора прошли на `main` |
| [`wave_cards/ADM-ACCESS-ISSUE-ROLE.md`](wave_cards/ADM-ACCESS-ISSUE-ROLE.md) | Воркер 2: автор заявки `A0-L` | PR #344 слит в `5c2acc8`; живые заявки и запись не подключены |
| [`wave_cards/ADM-ACCESS-ISSUE-QA.md`](wave_cards/ADM-ACCESS-ISSUE-QA.md) | Воркер 1: приёмка `A0-L-Q` | PASS изолированной логике; интеграция и API не проверены |
| [`wave_cards/ADM-ACCESS-KEY-REVIEW.md`](wave_cards/ADM-ACCESS-KEY-REVIEW.md) | Воркер 2: безопасность ключа `A0-K` | Read-only [отчёт получен](wave_cards/ADM-ACCESS-K-REPORT.md); настройки и секреты не менялись |
| [`wave_cards/ADM-ACCESS-TOKEN-AUDIT.md`](wave_cards/ADM-ACCESS-TOKEN-AUDIT.md) | Воркер 2: права Actions `A0-K2` | [Read-only отчёт получен](wave_cards/ADM-ACCESS-T-REPORT.md); изменение default на `HOLD` |
| [`wave_cards/ADM-ACCESS-T-REPORT.md`](wave_cards/ADM-ACCESS-T-REPORT.md) | Отчёт о правах workflow | Все четыре workflow, по воркеру 2, задают права явно; runtime не проверен |
| [`wave_cards/ADM-ACCESS-T-REVIEW.md`](wave_cards/ADM-ACCESS-T-REVIEW.md) | Воркер 1: независимая сверка `A0-K2-Q` | [Отчёт и уточнение получены](wave_cards/ADM-ACCESS-TQ-REPORT.md); runtime не проверен |
| [`wave_cards/ADM-ACCESS-TQ-REPORT.md`](wave_cards/ADM-ACCESS-TQ-REPORT.md) | Сверка прав Actions | Blob-хеши сверены по Git-метаданным; некоторые ссылки и fork-сценарии с оговорками |
| [`wave_cards/ADM-ACCESS-TQ-CLARIFY.md`](wave_cards/ADM-ACCESS-TQ-CLARIFY.md) | Воркер 1: уточнение `A0-K2-Q1` | Ответ получен; универсальное утверждение о fork не принято |
| [`wave_cards/ADM-ACCESS-TR-CRITIC.md`](wave_cards/ADM-ACCESS-TR-CRITIC.md) | Критик: план изолированных проверок `A0-K2-R` | [Вердикт получен](wave_cards/ADM-ACCESS-TR-REPORT.md): default — HOLD, план — условный PASS |
| [`wave_cards/ADM-ACCESS-TR-REPORT.md`](wave_cards/ADM-ACCESS-TR-REPORT.md) | Критика тестового плана | Исторический вердикт; позднее ручной тест App прошёл по решению владельца |
| [`wave_cards/ADM-ACCESS-K-REPORT.md`](wave_cards/ADM-ACCESS-K-REPORT.md) | Разбор разведки ключа `A0-K` | Отдельное окружение — кандидат; полные правила и права не доказаны |
| [`wave_cards/ADM-ACCESS-KEY-CRITIC.md`](wave_cards/ADM-ACCESS-KEY-CRITIC.md) | Задание независимому критику `A0-K-R` | [Исторический отчёт](wave_cards/ADM-ACCESS-KR-REPORT.md): три гейта — `HOLD` |
| [`wave_cards/ADM-ACCESS-KR-REPORT.md`](wave_cards/ADM-ACCESS-KR-REPORT.md) | Критика ключа и проверка владельцем | Ручной тест позже прошёл; живая запись остаётся на `HOLD` |
| [`wave_cards/ADM-ACCESS-REPO.md`](wave_cards/ADM-ACCESS-REPO.md) | Репозиторий как цель и очередь заявок | Предложен переход от Sheets; владелец выбрал приоритет первой отправки |
| [`wave_cards/ADM-ACCESS-PACKET.md`](wave_cards/ADM-ACCESS-PACKET.md) | Черновик пакета и Git-коммита | Критика `b030d20` — `HOLD`; порядок, права и публикация не доказаны |
| [`wave_cards/ADM-ACCESS-REVIEW.md`](wave_cards/ADM-ACCESS-REVIEW.md) | Задание независимому критику `rc-08` | Отчёт на `b030d20` получен; вердикт — `HOLD` |
| [`wave_cards/ADM-ACCESS-S-REPORT.md`](wave_cards/ADM-ACCESS-S-REPORT.md) | Воркер 1: источники `A0-S`/`A0-S2`/`A0-S3` | ID и настроенные триггеры уточнены; версия сайта не доказана |
| [`wave_cards/ADM-ACCESS-H-REPORT.md`](wave_cards/ADM-ACCESS-H-REPORT.md) | Воркер 2: GitHub `A0-H`/`A0-H2` | Строгий порядок Submit не доказан; кандидат коммита не снимает `HOLD` |
| [`wave_cards/ADM-ACCESS-F-REPORT.md`](wave_cards/ADM-ACCESS-F-REPORT.md) | Разбор разведки интерфейса `A0-F` | Сводка на `661165b`; точная версия снимка и часть предметных валидаторов не установлены |
| [`wave_cards/ADM-ACCESS-G-REPORT.md`](wave_cards/ADM-ACCESS-G-REPORT.md) | Разбор GitHub-разведки `A0-G` | Получена независимо; реальные настройки и права не проверены |
| [`wave_cards/ADM-ACCESS-R-REPORT.md`](wave_cards/ADM-ACCESS-R-REPORT.md) | Критика `rc-08` и решения владельца | Третий `HOLD`: снимок, порядок, роль и запись; реальные настройки не проверены |
| [`wave_cards/ADM-ACCESS-CONTRACT.md`](wave_cards/ADM-ACCESS-CONTRACT.md) | Черновик контракта проверки и матрицы | Правка до записи останавливает заявку; альтернативная модель сохранена, живая запись на `HOLD` |
| [`wave_cards/ADM-NOTICE.md`](wave_cards/ADM-NOTICE.md) | `ADM-NOTICE`: запуск уведомлений после снятия загрузочной шторки | #340 слит в `0bef478`; CI 4/4 и функциональный PASS, визуал не проверен |
| [`wave_cards/ADM-NOTICE-REPORT.md`](wave_cards/ADM-NOTICE-REPORT.md) | Разбор отчёта об исправлениях `ADM-NOTICE` | сводка воркера 2 разобрана; дополнительная перепроверка — только вне текущей итерации |
| [`wave_cards/ADM-UI.md`](wave_cards/ADM-UI.md) | `ADM-UI`: кнопка, условный код и оболочка редактора сектора | PR #340 слит в `0bef478`; Pages опубликован, визуальная приёмка открыта |
| [`wave_cards/F-1.md`](wave_cards/F-1.md) | `F-1` · `Z-5`: единица `1` ед = `1` св.г., предел `0,002` св.г./px, лестница `L0…L12`, маркер `0,3544` | принята 26.10.2026 (PR #300); исполнение — [`F-1-execution.md`](wave_cards/F-1-execution.md), вердикт — [`wave_cards/F-1-execution.md`](wave_cards/F-1-execution.md) |
| [`wave_cards/F-2.md`](wave_cards/F-2.md) | `F-2` · `Z-4e`: территории на глубине до `L12`, `faction-net` без `NET_LAYER_LEVELS`, диапазон от `layerFillAlpha` | принята 26.10.2026 (PR #308, PASS); исполнение и вердикт — [`F-2-execution.md`](wave_cards/F-2-execution.md) |
| [`wave_cards/F-3.md`](wave_cards/F-3.md) | `F-3` · `Z-4f`: фактическая сетка, тиры `T6/T7`, `gridTiersFor(scale)`, удаление `.map-grid-overlay` | принята 26.10.2026 (PR #313, PASS, squash `59f8f3a`); исполнение, журнал F3-1…F3-13 и вердикт — [`F-3-execution.md`](wave_cards/F-3-execution.md) |
| [`wave_cards/CI-1.md`](wave_cards/CI-1.md) | `CI-1` · инфраструктура: бинарный CI-гейт — страж базы 8 падений, линт `tools/tests`, planet-core отдельным шагом | принята 26.10.2026 (PR #316, PASS, squash `e798eff`, CI 4/4); журнал CI1-1…CI1-8 и вердикт — [`CI-1-execution.md`](wave_cards/CI-1-execution.md); аудит — [`external_ci_gate_audit_2026-10-26.md`](external_ci_gate_audit_2026-10-26.md) |
| [`wave_cards/CI-2.md`](wave_cards/CI-2.md) | `CI-2` · инфраструктура: намеренный карантин 8 планетарных падений на уровне раннера (`--test-skip` от реестра), двухпрогонный страж целостности, `test:raw` | принята 26.10.2026 (PR #320, PASS, squash `34d203a`, CI 4/4); журнал CI2-1…CI2-10 и вердикт — [`CI-2-execution.md`](wave_cards/CI-2-execution.md); пункт этапа [`S8-Q1`](../stages/stage-08/todo.md) |
| [`wave_cards/UP-1.md`](wave_cards/UP-1.md) | `UP-1`: один проход по подтверждённому перегрузу документации, тестов и кода | PR #325 закрыт без слияния; результат частичный и не принят |
| [`wave_cards/UP-1-review.md`](wave_cards/UP-1-review.md) | `UP-1`: замечания к PR #325 и критерии их устранения | подготовлена по просьбе владельца; доработка не запущена |

## Как пользоваться

Пункты ниже относятся к параллельным волнам. `UP-1` и карточка его проверки
выполняются в обычном одиночном режиме, а не как `Split-Work`. Базовая оболочка
`ADM-UI`, исправление входа и PR #340 слиты; по отчёту воркера 2 функциональный PASS
относится к `b47060e`, в `main` опубликовано идентичное дерево `0bef478`. Повторная
проверка его результата — только вне текущей итерации; реальный браузер и визуальная
приёмка не подтверждены. `ADM-ACCESS` содержит постановку и разведки только для чтения.
Четыре общих документа #338 и #340 объединены с актуальным `main` без конфликтов.

1. Перед волной оркестратор (`rc-07`) выбирает **2–3 роли** — больше не нужно: карточка задаёт
   режим, а не отдельного человека. Выданная карточка волны лежит в [`wave_cards/`](wave_cards/)
   и выдаётся воркеру вместе с промптом.
2. Промпт Воркера собирается по шаблону из [`waves/protocol.md`](waves/protocol.md) §5, а в блок
   «Что считается готовым» вставляется раздел 4 нужной карточки **дословно**.
3. Числа (тайминги, бюджеты, тиры адреса) берутся **только** из гайдлайнера
   [`../stages/stage-9-12-sector-deep-render-plan.md`](../stages/stage-9-12-sector-deep-render-plan.md), не из карточек.
4. Приёмка: `rc-04` закрывает доказательства, `rc-08` — последнее слово по рискам, `rc-06` —
   записи в `CHANGELOG`/`HANDOFF`. Только после этого PR идёт в `main`.

## Границы

- Карточки **не отменяют** корневой [`AGENTS.md`](../../AGENTS.md) и доменные `site/AGENTS.md`,
  `src/AGENTS.md`, `tools/AGENTS.md`: при конфликте приоритет у них и у указаний владельца.
- Карточки не описывают планетарную генерацию шире, чем разрешено инвариантом `И-11`.
