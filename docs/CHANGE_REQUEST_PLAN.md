# CHANGE_REQUEST_PLAN (CR-01) — навигация

План модернизации языкового стека, модульной архитектуры и вычислительного
ядра. С 26.10.2026 разделён по контексту в [`plan/cr-01/`](plan/cr-01/overview.md);
старый путь сохранён для ссылок.

Назад: [документация](README.md) · [паспорт проекта](plan/passport.md).

## Разделы

| Тема | Документ |
|---|---|
| Зачем нужен CR-01, краткое резюме | [`plan/cr-01/overview.md`](plan/cr-01/overview.md) |
| Аудит кода и семь инцидентов Этапов 4–6 | [`plan/cr-01/audit.md`](plan/cr-01/audit.md) |
| Выбор стека и инварианты `И-1…И-6` | [`plan/cr-01/stack-selection.md`](plan/cr-01/stack-selection.md) |
| Примеры на узлах проекта и референсы | [`plan/cr-01/examples.md`](plan/cr-01/examples.md) |
| План из пяти PR | [`plan/cr-01/implementation.md`](plan/cr-01/implementation.md) |
| Подводные камни и развилки | [`plan/cr-01/pitfalls.md`](plan/cr-01/pitfalls.md) |
| Факт выполнения: PR #130–#139, 6.1, DX-1 | [`plan/cr-01/results.md`](plan/cr-01/results.md) |

## Соответствие старым разделам

§1 → `overview.md`; §2 → `audit.md`; §3–§5 → `stack-selection.md`;
§6–§7 → `examples.md`; §8 → `implementation.md`; §9–§10 → `pitfalls.md`;
§11 → `results.md`.

## Итог в одну строку

Стек переведён на строгий TypeScript + Vite, Wasm-ядро `planet-core` на
AssemblyScript, единый контракт `planet_generation`/`PG1` и модульную
архитектуру; все шесть инвариантов закреплены тестами и CI.
