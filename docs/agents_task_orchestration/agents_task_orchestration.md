# Оркестрация мультиагентной разработки (Tri-Agent Wave / Split-Work) — навигация

Исходный документ (2396 строк) разнесён по волнам 26.10.2026. Номера разделов
`§N` и `§N.M` **сохранены в заголовках** вынесенных файлов: ссылки из кода
(`§17.5`, `§17.7`, `§17.13`, `§17.22.2`, `§17.23`, `§17.25`) продолжают находить
свой текст по таблице ниже.

Назад: [декомпозиция](./README.md) · [этапы](../stages/README.md) · [документация](../README.md) · [регистры](../registers/README.md).

## Режимы и правила (читать первым)

| Что | Файл |
|---|---|
| Режимы работы, Role & Boundary Card, правила `О-1…О-4`, экономия контекста, шаблон промпта (§1–§5) | [`waves/protocol.md`](waves/protocol.md) |

## Хронология волн

| Разделы | Волна | Файл |
|---|---|---|
| §6–§9 | PR 6.1, DX-1 | [`waves/stage-6-dx.md`](waves/stage-6-dx.md) |
| §10–§15 | Stage-8.2…8.7 | [`waves/stage-8.md`](waves/stage-8.md) |
| §16.1–§16.3 | `SW-1`: цель, файлы, контракт адреса | [`waves/sw-1.md`](waves/sw-1.md) |
| §16.4–§16.9 | `SW-1`: гейты, запуск, факт, уроки | [`waves/sw-1-gates.md`](waves/sw-1-gates.md) |
| §17.1–§17.6 | `SW-2`: цель, решения, инвентарь, **контракт поля (§17.5)** | [`waves/sw-2.md`](waves/sw-2.md) |
| §17.7–§17.12 | `SW-2`: гейты, ловушки, запуск, приёмка `SW-2A` | [`waves/sw-2-gates.md`](waves/sw-2-gates.md) |
| §17.13–§17.15 | `SW-2`: диверсификация расписания, приёмка попытки 2, глубина | [`waves/sw-2-schedule.md`](waves/sw-2-schedule.md) |
| §17.15.1–§17.15.7 | Метрика глубины, множитель, бесшовность стыка | [`waves/sw-2-depth.md`](waves/sw-2-depth.md) |
| §17.16–§17.17 | Сводный план-список, «0,95 против 5 319,5» | [`waves/sw-2-plan.md`](waves/sw-2-plan.md) |
| §17.18–§17.19 | Закрытие `SW-2`, план по воркерам | [`waves/sw-2-close.md`](waves/sw-2-close.md) |
| §17.20–§17.21 | Приёмка `SW-3`, очередь задач владельца `Z-1`/`Z-2` | [`waves/sw-3-owner-queue.md`](waves/sw-3-owner-queue.md) |
| §17.22 | `Z-3`: границы сектора, фракционные сети, слой блоков | [`waves/z-3.md`](waves/z-3.md) |
| §17.23 | Единица `1000` единиц = `1` св.г. (**отменена §17.24**) | [`waves/unit-ly.md`](waves/unit-ly.md) |
| §17.24–§17.25 | Пересмотр единицы, `Z-4f`: фактическая сетка адресов | [`waves/unit-revision.md`](waves/unit-revision.md) |
| §18.1–§18.4 | Волна `F`: цель, инвентарь, файлы, контракт | [`waves/f.md`](waves/f.md) |
| §18.5–§18.9 | Волна `F`: гейты, запуск, отказ, карточка `F-1` | [`waves/f-gates.md`](waves/f-gates.md) |

## Карточки

| Карточка | Файл |
|---|---|
| Роли агентов `rc-01…rc-08` | [`role_cards/`](role_cards/) |
| Волна `F-1` (`Z-5`) — основная часть | [`wave_cards/F-1.md`](wave_cards/F-1.md) |
| Волна `F-1` — исполнение, гейты, приёмка | [`wave_cards/F-1-execution.md`](wave_cards/F-1-execution.md) |
| Волна `F-1` — вердикт приёмки | [`wave_cards/F-1-verdict.md`](wave_cards/F-1-execution.md) |

## Действующие правила (краткая выжимка)

- `О-1` — матрица эксклюзивного владения файлами, `Zero File Overlap`.
- `О-2` — `docs/HANDOFF.md` и `CHANGELOG.md` не правятся в кодовых ветках.
- `О-3` — стыковка по контракту до символа (`Interface-First`).
- `О-4` — монолитный формат выдачи промптов.
- Коммит и `git push` после каждого шага; финальный отчёт — стоп перед merge.

## Связи

- Декомпозиция папки: [`README.md`](./README.md).
- Аудит внешних агентов: [`external_agency_agents_audit.md`](./external_agency_agents_audit.md).
- Инструкция по сплит-волнам: [`worker_instruction_on_splitwork.md`](./worker_instruction_on_splitwork.md).
- Секторный гайдлайнер: [`stage-09-12-sector-deep-render-plan.md`](../stages/stage-9-12-sector-deep-render-plan.md).
- Решения по волнам: [`docs/registers/decisions.md`](../registers/decisions.md).
