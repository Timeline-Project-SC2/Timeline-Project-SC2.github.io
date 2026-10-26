# Пометка: mini-spike-22 baseline

>
> Источник: [`docs/stages/stage_patches.md`](../../stage_patches.md) · строки 865–875.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## 2026-10-20 — mini-spike-22: baseline и кадровая гигиена

Зафиксирован baseline до оптимизаций (`tools/bench_planet_baseline.mjs`,
`baseline-2026-10-20.json`), добавлен честный 10-секундный HUD
p50/p95/p99/worst5/>50/>100 мс и GPU timer query, adaptive scale переведён
на p95 anti-hunting, а взрыв оставлен только на GPU `uSep` с одной скрытой
worker/staged подготовкой целевой рваности/толщины. В план Этапов 3/4/6 и
гейтов G0–G5 внесены бинарный кэш, chunk-контракт, Transferable-правило,
low-poly атмосфера и числовые performance-критерии; в CI добавлен CPU-only
regression bench без frame-time.
