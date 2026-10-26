# Проверки при сдаче спайка

>
> Источник: [`docs/stages/stage-1-spike-report.md`](../../stage-1-spike-report.md) · строки 465–471.
> Назад: [паспорт этапа](../plan.md) · [индекс документации](../../../README.md).

## Проверки, выполненные при сдаче спайка

```bash
node tools/check_planet_spike.mjs        # все проверки OK
for f in site/*.js site/shared/*.js site/planet-test/*.js; do node --check "$f"; done
npx eslint site                          # чисто
```
