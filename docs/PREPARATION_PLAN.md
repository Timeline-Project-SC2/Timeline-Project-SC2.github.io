# PREPARATION_PLAN — навигация

Историческая точка входа в технический план. С 26.10.2026 сам план разделён
по контексту в [`plan/`](plan/passport.md); этот файл сохранён, чтобы старые
ссылки продолжали работать.

Назад: [документация](README.md) · [паспорт проекта](plan/passport.md).

## Быстрый маршрут

| Вопрос | Документ |
|---|---|
| Что за проект, статус, вердикт | [`plan/passport.md`](plan/passport.md) |
| Что уже работает в репозитории | [`plan/current-state.md`](plan/product-and-roadmap.md) |
| Продукт и границы | [`plan/product.md`](plan/product-and-roadmap.md) |
| Почему выбраны сетка, C100, PG1 | [`plan/decisions-rationale.md`](plan/decisions-rationale.md) |
| Как устроена сетка Голдберга | [`plan/geodesic-grid.md`](plan/geodesic-grid.md) |
| Мягкие континенты C100 | [`plan/c100-soft.md`](plan/c100-soft.md) |
| Шум, seed, версии | [`plan/noise-contract.md`](plan/noise-contract.md) |
| Лист `planet_generation` и пресеты | [`plan/data-profiles.md`](plan/data-profiles.md) |
| `generation_key` и derived-ключи | [`plan/generation-key.md`](plan/generation-key.md) |
| Глобус, LOD, локальная карта | [`plan/display-architecture.md`](plan/display-architecture.md) |
| Память, CPU, сеть, Actions | [`plan/budgets.md`](plan/budgets-and-gates.md) |
| Гейты качества | [`plan/quality-gates.md`](plan/budgets-and-gates.md) |
| Этапы и статусы | [`plan/roadmap.md`](plan/product-and-roadmap.md), [`stages/README.md`](stages/README.md) |
| Оценки времени и MVP | [`plan/estimates.md`](plan/estimates-risks-decisions.md) |
| Риски | [`plan/risks.md`](plan/estimates-risks-decisions.md) |
| Открытые решения | [`plan/open-decisions.md`](plan/estimates-risks-decisions.md) |
| CSV, адреса, глоссарий | [`plan/appendices.md`](plan/appendices.md) |
| Модернизация стека CR-01 | [`plan/cr-01/overview.md`](plan/cr-01/overview-and-audit.md) |

## Соответствие старым разделам

| Старый § | Новый файл |
|---|---|
| §1–§2 | `plan/passport.md`, `plan/current-state.md` |
| §3 | `plan/product.md` |
| §4 | `plan/decisions-rationale.md` |
| §5 | `plan/geodesic-grid.md` |
| §6 | `plan/c100-soft.md` |
| §7 | `plan/noise-contract.md` |
| §8.1–§8.5 | `plan/data-profiles.md` |
| §8.6–§8.10 | `plan/generation-key.md` |
| §9 | `plan/display-architecture.md` |
| §10 | `plan/budgets.md` |
| §11 | `plan/quality-gates.md` |
| §12 | `plan/roadmap.md` + `stages/stage-NN/plan.md` (исходный текст §12 — в приложении этапа) |
| §13 | `plan/estimates.md` |
| §14 | `plan/risks.md` |
| §15 | `plan/open-decisions.md` |
| §16 | `plan/appendices.md` |

## Важное о числах

План писался 19–26.10.2026 и местами содержит исторические числа
(`L0…L9`, «`1 000` единиц = `1` св.г.»). Актуальные числа — в
[`stages/stage-09-12-sector/plan.md`](stages/stage-09-12-sector/plan.md) и
гайдлайнере 4.0; при расхождении приоритет у кода `main` и решения владельца.
