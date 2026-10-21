// Проверка скриптов сайта (запускает .github/workflows/check.yml в каждом PR).
// Включены только правила, нарушение которых ломает страницу: no-undef — обращение
// к необъявленной переменной. Так сломалось перетаскивание карты сектора: после
// чистки кода в обработчике осталась ссылка на удалённую переменную point.
//
// Локально (typescript@6 нужен только парсеру: typescript-eslint пока не
// поддерживает TypeScript 7 из package.json; после lint npm ci вернёт TS 7):
//   npm install --no-save --no-package-lock --legacy-peer-deps eslint@10 globals@17 @typescript-eslint/parser@8 typescript@6
//   npx eslint site src/atlas
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
  }
];
