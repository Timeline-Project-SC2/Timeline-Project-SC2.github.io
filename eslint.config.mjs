// Проверка скриптов сайта (запускает .github/workflows/check.yml в каждом PR).
// Включены только правила, нарушение которых ломает страницу: no-undef — обращение
// к необъявленной переменной. Так сломалось перетаскивание карты сектора: после
// чистки кода в обработчике осталась ссылка на удалённую переменную point.
//
// Локально:
//   npm install --no-save --no-package-lock eslint@10 globals@17
//   npx eslint site
import globals from 'globals';

export default [
  {
    files: ['site/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // общие объекты между файлами сайта
        CursorFx: 'readonly',     // shared/cursor-fx.js → страница /cursor-test/
        FocusFx: 'readonly',      // shared/focus-fx.js → galaxy.js
        GalaxySpiral: 'readonly', // shared/galaxy-spiral.js → galaxy.js, /spiral-test/
        LagFx: 'readonly',        // shared/lag-fx.js → galaxy.js
        SITE_LINKS: 'readonly'    // shared/links.js → остальные
      }
    },
    rules: {
      'no-undef': 'error'
    }
  },
  {
    // Временный агрегат будущих ESM/worker-модулей Этапов 8/9 из PR #119.
    // Он не подключён к страницам и позже должен быть разрезан на отдельные
    // модули; до этого ему нужен module-парсинг и оба набора глобалов.
    files: ['site/shared/temp_code_structures.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.worker
      }
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
