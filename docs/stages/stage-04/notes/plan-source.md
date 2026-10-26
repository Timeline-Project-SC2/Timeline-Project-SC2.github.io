# Этап 4 — исходный план полей и C100

> Текст плана сохранён без изменений.
> Источник: `docs/PREPARATION_PLAN.md` (редакция до разукрупнения; `git show a7503e6:docs/PREPARATION_PLAN.md`) · строки 1441–1467.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

### Этап 4. Поля и C100-soft

- Высота, влажность, температура, плиты.
- Мягкие суша/шельф/океан.
- Континентальные идентичности и океанические бассейны.
- Статистическая калибровка с буфером.
- Worker-контракт: все крупные буферы (>1 КБ) между worker и main thread
  передаются только как Transferable через
  `postMessage(data, [buffer, ...])`, а не structured clone. Если обе
  стороны должны владеть данными, владение явно разделяется версиями или
  буфер пересоздаётся из детерминированного рецепта; молчаливое
  клонирование больших типизированных массивов считается дефектом review.
  SharedArrayBuffer не является базовым путём: GitHub Pages не позволяет
  выставлять нужные `Cross-Origin-Opener-Policy: same-origin` и
  `Cross-Origin-Embedder-Policy: require-corp`, поэтому боевой транспорт —
  только Transferable.

**Гейт G2:** ансамбль seed проходит географические метрики.
Performance-критерии G2 в CI-окружении baseline: median
`mesh build + field calculation + C100-soft` для v=128 <=2000 мс
(текущий baseline без C100: 923+174=1097 мс), детерминированная память
ядра `grid + field SoA` для v=128 <=64 МиБ без GPU-геометрии, а главный
поток не блокируется кусками дольше 50 мс, потому что поля считаются
worker-чанками.

**Факт Этапа 4 (актуализировано по `CR-01` PR #131, #137, #139):** реализовано в строгих TS-модулях `site/shared/planet-noise.ts` и `site/shared/planet-geography.ts` поверх гибридного Wasm-ускорителя `src/planet/assembly/kernels.ts` + `src/planet/planet-core-host.ts` (два скомпилированных модуля в `src/planet/planet-core-bytes.ts`: полное SIMD128-ядро `PlanetCore` для воркера/Node с общей ареной 24 МиБ и компактное `PlanetNoiseCore` `< 4 КиБ`, доступное синхронно на главном потоке без нарушения лимита Chrome; каноническая частота `canonicalV` строго удерживается по Инварианту И-1), едином контракте пресетов `src/contracts/planet-generation-contract.json` (`planet-presets-v1`, И-4), `tools/bench_planet_stage4.mjs` и тестах `tests/planet-geography.test.mjs`. В `makeWeightedQuantiles`, `chooseSeeds` и приоритетных очередях действует Wasm radix-сортировка и строгий целочисленный tie-break `a - b` по каноническому индексу ячейки (Инвариант И-2). Ансамбль 30 seed `earthlike_balanced`: mean эффективной массы 400,4 при цели 400, sigma по P10/P90 0.805, hard ocean 0.700000 при max abs error 0.000007, пустых публичных идентичностей нет; typed arrays сетки+географии — 33,45 МиБ при 100 % побитовой эквивалентности FULL EQ. Полный контракт — в `docs/stages/stage-4-fields-c100-soft.md`.
