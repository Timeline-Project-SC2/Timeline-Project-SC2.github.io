# Инвентарь: заметки этапов 00–07

> Назад: [шаг 0](README.md) · [паспорта](inventory-passports.md)

Оценки — сумма тел файлов кластера без повторяющихся шапок. Имена целей,
помеченные «по H2», даются при P1 по смысловым заголовкам разделов: шаг 0
тел заметок не читает, поэтому механических имён вида `-1/-2` карта не
назначает и не сохраняет. Индексы `notes/README.md` сохраняются, пока в
папке остаётся больше одного файла, и пересортируются по логике чтения.

## Этап 01 — спайк глобуса (25 заметок, 1 431 строка)

| Кластер (файлы → цель) | Строк сейчас | Оценка | Действие |
|---|---|---|---|
| `report-overview.md` 71 + `checks.md` 13 + `journal-spike-build.md` 54 + `journal-owner-feedback.md` 42 → `spike-overview-and-feedback.md` | 180 | ~165 | СКЛЕИТЬ |
| `journal-requests-1/2/3.md` 167+190+49 → два файла по H2 | 406 | ~200 + ~195 | ПЕРЕРАЗБИТЬ по смысловым заголовкам; имена — по доминирующей теме каждой половины |
| `mobile-lod-and-gpu-bundles.md` 82 + `mobile-lod-note.md` 30 + `gpu-bundles-note.md` 32 + `lod-planner-recheck.md` 35 + `lod-recheck-note.md` 23 → `mobile-lod-and-gpu-bundles.md` | 202 | ~182 | СКЛЕИТЬ, все четыре `-note`/дубля из `stage_patches.md` исчезают |
| `smooth-approach-prefetch.md` 57 + `smooth-approach-note.md` 39 + `density-and-loading.md` 54 → `approach-prefetch-and-density.md` | 150 | ~140 | СКЛЕИТЬ |
| `phone-tests.md` 169 + `phone-tests-note.md` 18 + `mini-spike-22-note.md` 16 → `phone-tests.md` | 203 | ~193 | СКЛЕИТЬ; замороженная история, запас роста не нужен |
| `appearance-themes.md` 29 + `post-stage-customization.md` 22 + `planet-lab.md` 44 + `journal-open-questions.md` 44 → `customization-and-planet-lab.md` | 139 | ~124 | СКЛЕИТЬ |
| `urbanism-rfc.md` 59 → этап 08 | 59 | — | ПЕРЕЕЗД в контексте задачи «локальная карта»: заголовок файла сам относит его к этапам 8/9, в этапе 01 он лежит только по дате; в этапе 08 уходит в кластер волн |
| `plan-source.md` 51 | 51 | 0 | УДАЛИТЬ-ДУБЛЬ при P2 после сверки с паспортом |

Итог этапа 01: 25 → **9 файлов** (включая индекс), главный выигрыш — минус
пять пар «файл + его же `-note` из параллельной нарезки `stage_patches.md`».

## Этап 02 — данные и синхронизация (13 заметок, 833 строки)

| Кластер | Строк | Оценка | Действие |
|---|---|---|---|
| `report-overview.md` 28 + `contract.md` 120 → `data-contract.md` | 148 | ~140 | СКЛЕИТЬ |
| `sync-gate.md` 110 + `live-sheet-note.md` 18 + `autosync-skeleton.md` 29 → `sync-gate-and-live-sheet.md` | 157 | ~147 | СКЛЕИТЬ; журнал этапа уходит в паспорт, поэтому сюда не входит |
| `sheet-layout-1.md` 112 + `sheet-layout-2.md` 169 + `sheet-layout-note.md` 38 → два файла по H2 | 319 | ~160 + ~150 | ПЕРЕРАЗБИТЬ по разделам макета листа; склейка в один файл (319) запрещена потолком 200 |
| `frontend-skeleton.md` 15 → секцией в `data-contract.md` | 15 | внутри ~140 | СКЛЕИТЬ; отдельный файл ради 15 строк не сохранять |
| `data-model.md` 73 | 73 | 73 | ОСТАВИТЬ, цельный точечный контекст модели данных |
| `journal-stage-2.md` 76, `plan-source.md` 16 | — | — | Журнал — секцией в паспорт; исходник — УДАЛИТЬ-ДУБЛЬ |

Итог этапа 02: 13 → **6 файлов**. Предложение аудита склеить отчёт в один
файл на ~244 строки картой отклонено: потолок 200 без «+50» важнее.

## Этапы 03–07 — заметки компактные, работы мало

| Этап | Кластер / файл | Строк | Действие |
|---|---|---|---|
| 03 | `binary-cache.md` 85 + `bench-and-compat.md` 86 → `cache-bench-and-compat.md` | 171 | СКЛЕИТЬ (~161) |
| 03 | `address-topology-chunk.md` 128, `core-and-density.md` 103 | 231 | ОСТАВИТЬ оба |
| 04 | `presets-and-calibration.md` 109 + `ensembles-gate-limits.md` 76 → `presets-calibration-and-g2.md` | 185 | СКЛЕИТЬ (~175) |
| 04 | `fields-and-seed.md` 129, `ocean-plates-c100.md` 144 | 273 | ОСТАВИТЬ оба |
| 05 | `hydrology-core.md` 138, `flow-lakes-catchments.md` 145, `biomes-validation-bench.md` 168 | 451 | ОСТАВИТЬ все три, цельные контексты гидрологии и биомов |
| 06 | `globe-implementation.md` 138 и `phone-acceptance-and-gaps.md` 81 | 219 | ОСТАВИТЬ оба: склейка аудита на ~210 запрещена потолком 200, а темы разные (реализация и приёмка) |
| 06 | Переезды из этапа 08: `planet-globe-modularization.md` 101, `planet-lod-cascade.md` 125 | 226 | ПЕРЕЕЗД сюда двумя отдельными файлами в контексте задачи «глобус — этап 06»; в этап 06 они не склеиваются ни друг с другом, ни с отчётом (иначе > 200) |
| 07 | `routing-and-data.md` 89 и `transition-prefetch-inspector.md` 131 | 220 | ОСТАВИТЬ оба по той же причине, что этап 06 |

Журналы этапов 03–07 (29–47 строк) уходят секциями в паспорта, исходники
`plan-source.md` — УДАЛИТЬ-ДУБЛЬ; детали в
[`inventory-passports.md`](inventory-passports.md). Итог этапов 03–07:
заметок 32 → **21 файл**, в основном за счёт журналов и одной склейки на этап.
