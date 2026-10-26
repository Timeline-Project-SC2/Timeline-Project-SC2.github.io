# Оркестрация задач и карточки ролей

Папка описывает, **как мы делим работу между агентами** в этом репозитории. Слои, читать
сверху вниз:

| Файл | Отвечает на вопрос |
|---|---|
| [`agents_task_orchestration.md`](agents_task_orchestration.md) | Хаб: карта разделов `§1…§18` и правила `О-1…О-4` |
| [`waves/`](waves/protocol.md) | Сами разделы по волнам: `protocol`, `stage-6-dx`, `stage-8`, `sw-1`, `sw-2*`, `z-3`, `unit-*`, `f` |
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
| [`wave_cards/F-1.md`](wave_cards/F-1.md) | `F-1` · `Z-5`: единица `1` ед = `1` св.г., предел `0,002` св.г./px, лестница `L0…L12`, маркер `0,3544` | принята 26.10.2026 (PR #300); исполнение — [`F-1-execution.md`](wave_cards/F-1-execution.md), вердикт — [`wave_cards/F-1-execution.md`](wave_cards/F-1-execution.md) |
| [`wave_cards/F-2.md`](wave_cards/F-2.md) | `F-2` · `Z-4e`: территории на глубине до `L12`, `faction-net` без `NET_LAYER_LEVELS`, диапазон от `layerFillAlpha` | принята 26.10.2026 (PR #308, PASS); исполнение и вердикт — [`F-2-execution.md`](wave_cards/F-2-execution.md) |
| [`wave_cards/F-3.md`](wave_cards/F-3.md) | `F-3` · `Z-4f`: фактическая сетка, тиры `T6/T7`, `gridTiersFor(scale)`, удаление `.map-grid-overlay` | принята 26.10.2026 (PR #313, PASS, squash `59f8f3a`); исполнение, журнал F3-1…F3-13 и вердикт — [`F-3-execution.md`](wave_cards/F-3-execution.md) |
| [`wave_cards/CI-1.md`](wave_cards/CI-1.md) | `CI-1` · инфраструктура: бинарный CI-гейт — страж базы 8 падений, линт `tools/tests`, planet-core отдельным шагом | принята 26.10.2026 (PR #316, PASS, squash `e798eff`, CI 4/4); журнал CI1-1…CI1-8 и вердикт — [`CI-1-execution.md`](wave_cards/CI-1-execution.md); аудит — [`external_ci_gate_audit_2026-10-26.md`](external_ci_gate_audit_2026-10-26.md) |
| [`wave_cards/CI-2.md`](wave_cards/CI-2.md) | `CI-2` · инфраструктура: намеренный карантин 8 планетарных падений на уровне раннера (`--test-skip` от реестра), двухпрогонный страж целостности, `test:raw` | принята 26.10.2026 (PR #320, PASS, squash `34d203a`, CI 4/4); журнал CI2-1…CI2-10 и вердикт — [`CI-2-execution.md`](wave_cards/CI-2-execution.md); пункт этапа [`S8-Q1`](../stages/stage-08/todo.md) |

## Как пользоваться

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
