// Проверка скриптов сайта (запускает .github/workflows/check.yml в каждом PR).
// Включены только правила, нарушение которых ломает страницу: no-undef — обращение
// к необъявленной переменной. Так сломалось перетаскивание карты сектора: после
// чистки кода в обработчике осталась ссылка на удалённую переменную point.
//
// Карточка CI-1 (решение E3): тем же единственным правилом покрыты `tools/**` и
// `tests/**` — там 21 верификатор и 36 тестов, которые до этого проверялись только
// исполнением в нужной ветке. Новые стилевые правила не вводятся, ослаблять
// no-undef (off/warn) запрещено: находку чинят точечно.
//
// Локально ничего доустанавливать не нужно: `npm ci` кладёт `typescript` 6.х из
// алиаса `npm:@typescript/typescript6` — именно его подхватывает парсер
// typescript-eslint, хотя `npx tsc` в репозитории — нативный TypeScript 7.
//   npx eslint site src tools tests
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';

const siteGlobals = {
  ...globals.browser,
  // общие объекты между файлами сайта
  CursorFx: 'readonly',     // shared/cursor-fx.ts → страница /cursor-test/
  FocusFx: 'readonly',      // shared/focus-fx.ts → galaxy.ts
  GalaxySpiral: 'readonly', // shared/galaxy-spiral.ts → galaxy.ts, /spiral-test/
  LagFx: 'readonly',        // shared/lag-fx.ts → galaxy.ts
  SITE_LINKS: 'readonly'    // shared/links.ts → остальные
};

export default [
  {
    // AssemblyScript-исходники ядра planet-core: компилируются своим
    // компилятором (tools/build_planet_core.mjs), декораторы @inline/@fastMath
    // не парсятся TS-парсером ESLint — их проверяет tsc и --check сборки ядра.
    ignores: ['src/planet/assembly/**']
  },
  {
    files: ['site/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: siteGlobals
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    files: ['site/**/*.ts', 'src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...siteGlobals,
        // Имена только из TS DOM-типов: runtime-глобалов с такими именами нет,
        // а no-undef у парсера видит их как обычные идентификаторы.
        BufferSource: 'readonly',
        CanvasImageSource: 'readonly',
        CanvasRenderingContext2DSettings: 'readonly',
        ParentNode: 'readonly',
        Transferable: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // Инструменты и тесты — Node ESM: `test`/`assert` в них всегда импортированы
    // явно (проверено на шаге 0 карточки CI-1), поэтому globals.nodeTest не нужен.
    files: ['tools/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // tools/bench_planet_baseline.mjs — единственный файл, чьи колбэки уходят в
    // страницу через puppeteer `page.evaluate`: window/document/navigator и
    // requestAnimationFrame исполняются в браузере, а не в Node. Глобалы
    // объявлены по фактическому контексту исполнения; правило no-undef для
    // Node-части файла остаётся в силе (опечатка в теле самого скрипта ловится).
    files: ['tools/bench_planet_baseline.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // tests/travel-planner.test.js — CommonJS-скрипт (require + IIFE, без import/export),
    // поэтому sourceType здесь 'script', а не 'module'.
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.node
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
