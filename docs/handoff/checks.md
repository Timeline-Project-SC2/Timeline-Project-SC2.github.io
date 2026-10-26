# Как проверять изменения

> Источник: `docs/HANDOFF.md`, строки 714–746 (редакция до разукрупнения).
> Назад: [конспект](../HANDOFF.md) · [этапы](../stages/README.md) · [документация](../README.md).

## 8. Как проверять изменения

То же самое в каждом PR делает `.github/workflows/check.yml` (`actions/setup-node@v6` с `.nvmrc=24` и
`actions/setup-python@v6` с `.python-version=3.12`, сборка на Ubuntu 24.04 и 26.04, `npm run typecheck`, `npm run lint`, тесты). Локально:

```bash
npm ci                                          # единый package-lock.json (Vite, TS 7, ESLint, AssemblyScript)
npm run typecheck                               # tsc --noEmit
npm run lint                                    # eslint site src
npm run build                                   # tsc --noEmit + Vite (tools/vite/*) -> .publish/
npm run verify:publish                          # маршруты, manifest, hashed-ассеты и паритет экспортов
npm run verify:contract                         # Python ↔ TypeScript: пресеты, манифест, PG1 и оба формата approved_at
npm test                                        # текущий main: все 11 тестовых файлов Node (--test, 105 тестов)
npm run test:py                                 # Python unittest (test_planet_generation.py, test_sync.py)
python3 tools/sync.py --strict                  # строгая валидация CSV, координат 0..mapSize, places и дублей ID
python3 tools/build_assets.py --check           # свежесть собранных картинок
python3 tools/planet_generation.py validate     # снимок профилей против places
node tools/bench_local_map_stage8.mjs           # CPU-гейт G4 локальной карты (v=64 и --v=128)

# предпросмотр: .publish уже собрана как при деплое
python3 -m http.server 8080 --bind 0.0.0.0 --directory .publish

cd /home/user/smoke2 && node run.js             # прогон трёх страниц на данных из CSV
```

Курсор (`cursor-fx.ts`) в headless-браузере не виден, а `matchMedia('(any-pointer: fine)')`
там ложно — модуль не включается. Для проверок подменяйте `matchMedia` до загрузки страницы
(`page.evaluateOnNewDocument`) и сверяйте вычисленный `getComputedStyle(el).cursor` по
состояниям, смены `style` у элемента под мышью (MutationObserver) и `CursorFx.info()` /
`CursorFx.frames()`. Стоимость — CDP `Performance.getMetrics` (`TaskDuration`,
`RecalcStyleDuration`) с курсором и с `?cursor=off`. Учтите, что `?cursor=off` запоминается:
следующую страницу открывайте с `?cursor=auto`.
