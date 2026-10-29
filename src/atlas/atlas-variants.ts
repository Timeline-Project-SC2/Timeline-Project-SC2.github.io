/* Варианты общей разметки атласа sector/minimal.
   Словарь вынесен из vite.config.mts (CR-01 PR 3): сборщик только подставляет
   эти строго типизированные фрагменты в templates/atlas-shell.html. */

export type AtlasVariantName = 'admin-edit' | 'minimal' | 'sector';

export interface AtlasVariant {
  readonly adminEditorPanel: string;
  readonly adminGate: string;
  readonly adminGatePanel: string;
  readonly bodyAttrs: string;
  readonly coordinateControls: string;
  readonly coordinateReadout: string;
  readonly galaxyReturn: string;
  readonly headAfterReadability: string;
  readonly headAfterStyles: string;
  readonly headNote: string;
  readonly helpLabel: string;
  readonly intro: string;
  readonly leftToggle: string;
  readonly legacyToggle: string;
  readonly modalFoot: string;
  readonly modalTitle: string;
  readonly returnScripts: string;
  readonly title: string;
}

export const atlasVariants: Record<'minimal' | 'sector', AtlasVariant> = {
  sector: {
    adminEditorPanel: '',
    adminGate: '        <button class="admin-gate-link" id="adminGateOpen" type="button" aria-haspopup="dialog" aria-controls="adminEditorGate">Доступ Администратора</button>',
    adminGatePanel: [
      '    <div class="admin-gate-modal" id="adminEditorGate" role="dialog" aria-modal="true" aria-labelledby="adminGateTitle" data-admin-gate-modal hidden>',
      '      <button class="admin-gate-backdrop" type="button" data-admin-gate-close aria-label="Закрыть окно доступа"></button>',
      '      <section class="admin-editor-gate panel">',
      '        <button class="admin-gate-close" id="adminGateClose" type="button" aria-label="Закрыть окно доступа">×</button>',
      '        <p class="eyebrow"><span class="eyebrow-line"></span> ПУБЛИЧНЫЙ ТЕСТОВЫЙ БАРЬЕР</p>',
      '        <h1 id="adminGateTitle">Доступ Администратора</h1>',
      '        <p>Демонстрационная проверка интерфейса. Это не вход, не защита данных и не средство контроля доступа.</p>',
      '        <form id="adminGateForm" data-admin-gate-destination="/sector/admin-edit/" novalidate>',
      '          <label for="adminGateCode">Тестовый код</label>',
      '          <input id="adminGateCode" name="code" type="password" autocomplete="off" aria-describedby="adminGateHelp adminGateError">',
      '          <p id="adminGateHelp">Публичное значение тестового кода указано в исходнике проекта.</p>',
      '          <p class="admin-gate-error" id="adminGateError" role="alert" hidden>Код не совпадает. Измените ввод, чтобы попробовать снова.</p>',
      '          <button class="admin-gate-submit" id="adminGateSubmit" type="submit">Проверить тестовый код</button>',
      '        </form>',
      '      </section>',
      '    </div>',
    ].join('\n'),
    bodyAttrs: '',
    coordinateControls: [
      '        <div class="control-divider"></div>',
      '        <button class="map-control coordinate-toggle" id="coordinateToggle" type="button" title="Включить координаты наведения" aria-label="Включить координаты наведения" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg></button>',
    ].join('\n'),
    coordinateReadout:
      '      <div class="map-coordinate-readout" id="mapCoordinateReadout" aria-hidden="true" hidden></div>',
    galaxyReturn: '        <a class="galaxy-return" id="galaxyReturn" href="/index.html">← К ГАЛАКТИКЕ</a>',
    headAfterReadability: '',
    headAfterStyles: '  <link rel="stylesheet" href="sector.css">',
    headNote:
      '  <!-- минимальный скин вынесен в minimal.html: он скрывает каталог, вики-навигацию и «О данных» -->',
    helpLabel: 'О КАРТЕ',
    intro: [
      '      <section class="map-page-intro" aria-label="Текущий раздел">',
      '        <div class="breadcrumb"><span>Лор</span><i>›</i><span>Вводная часть</span><i>›</i><b>Пространство сектора Копрулу</b></div>',
      '        <h2>Пространство сектора Копрулу</h2>',
      '        <p>И его ближайшие территории...</p>',
      '      </section>',
    ].join('\n'),
    leftToggle: [
      '        <!-- Бургер: скрыть/показать каталог — слева в шапке -->',
      '        <button class="icon-button collapse-button" id="toggleSidePanel" type="button" aria-label="Скрыть каталог" title="Скрыть каталог">',
      '          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h10M4 19h16"></path><path d="m17 9 3 3-3 3"></path></svg>',
      '        </button>',
    ].join('\n'),
    legacyToggle: '',
    modalFoot: '<span>КАСТОМНАЯ КАРТА</span><span>НЕОФИЦИАЛЬНЫЙ ПРОЕКТ</span>',
    modalTitle: 'О карте',
    returnScripts: [
      '  <script src="/shared/links.js"></script>',
      '  <script>',
      '    (function () {',
      "      var a = document.getElementById('galaxyReturn');",
      '      if (!a) return;',
      '      if (window.SITE_LINKS && SITE_LINKS.galaxyPage) a.href = SITE_LINKS.galaxyPage;',
      '      // при возврате галактика не проигрывает консоль и сохраняет доступ к ОЗД',
      "      a.addEventListener('click', function () {",
      "        try { sessionStorage.setItem('galaxyReturn', '1'); } catch (e) {}",
      '      });',
      '    })();',
      '  </script>',
    ].join('\n'),
    title: 'Timeline Project — Map Atlas',
  },
  minimal: {
    adminEditorPanel: '',
    adminGate: '',
    adminGatePanel: '',
    bodyAttrs: ' class="minimal-mode"',
    coordinateControls: '',
    coordinateReadout: '',
    galaxyReturn: '',
    headAfterReadability: '  <link rel="stylesheet" href="minimal-skin.css">',
    headAfterStyles: '',
    headNote: '',
    helpLabel: 'О ДАННЫХ',
    intro: [
      '      <section class="map-page-intro" aria-label="Текущий раздел">',
      '        <div class="breadcrumb"><span>Лор</span><i>›</i><span>Вводная часть</span><i>›</i><b>Карта сектора</b></div>',
      '        <h2>Карта сектора</h2>',
      '        <p>Авторская схема систем и мест Копрулу</p>',
      '      </section>',
    ].join('\n'),
    leftToggle: '',
    legacyToggle: [
      '          <button class="icon-button collapse-button" id="toggleSidePanel" type="button" aria-label="Скрыть каталог" title="Скрыть каталог">',
      '            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h10M4 19h16"></path><path d="m17 9 3 3-3 3"></path></svg>',
      '          </button>',
    ].join('\n'),
    modalFoot: '<span>ОБЗОРНАЯ СХЕМА</span><span>КАТАЛОГ СЕКТОРА КОПРУЛУ</span>',
    modalTitle: 'О карте и данных',
    returnScripts: '',
    title: 'Timeline Project — Map Atlas (минимальный скин)',
  },
};
