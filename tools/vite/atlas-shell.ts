import { readFileSync } from 'node:fs';
import { atlasVariants, type AtlasVariantName } from '../../src/atlas/atlas-variants.ts';

/** Заполняет общий шаблон только для HTML с явным маркером варианта. */
export function renderAtlasVariant(html: string, atlasTemplatePath: string): string {
  const match = /<!--\s*atlas-variant:\s*(sector|minimal|admin-edit)\s*-->/.exec(html);
  if (!match) return html;
  const variantName = match[1] as AtlasVariantName;
  const variant = variantName === 'admin-edit'
    ? {
      ...atlasVariants.sector,
      adminGate: '',
      adminEditorPanel: [
        '      <section class="admin-editor-gate panel" id="adminEditorGate" aria-labelledby="adminGateTitle">',
        '        <p class="eyebrow"><span class="eyebrow-line"></span> ПУБЛИЧНЫЙ ТЕСТОВЫЙ БАРЬЕР</p>',
        '        <h1 id="adminGateTitle">Доступ Администратора</h1>',
        '        <p>Демонстрационная проверка интерфейса. Это не вход, не защита данных и не средство контроля доступа.</p>',
        '        <form id="adminGateForm" novalidate>',
        '          <label for="adminGateCode">Тестовый код</label>',
        '          <input id="adminGateCode" name="code" type="password" autocomplete="off" aria-describedby="adminGateHelp adminGateError">',
        '          <p id="adminGateHelp">Публичное значение тестового кода указано в исходнике проекта.</p>',
        '          <p class="admin-gate-error" id="adminGateError" role="alert" hidden>Код не совпадает. Измените ввод, чтобы попробовать снова.</p>',
        '          <button class="admin-gate-submit" id="adminGateSubmit" type="submit">Проверить тестовый код</button>',
        '        </form>',
        '      </section>',
        '      <aside class="admin-editor-panel panel" id="adminEditorPanel" data-admin-editor aria-labelledby="adminEditorTitle" hidden>',
        '        <div class="admin-editor-heading"><div><p class="eyebrow">ЗАГОТОВКА ИНТЕРФЕЙСА</p><h1 id="adminEditorTitle">Редактор сектора</h1></div></div>',
        '        <p class="admin-editor-notice">Демо-панель: изменения не сохраняются и не отправляются.</p>',
        '        <section><h2>Модули</h2><p>Модули редактирования пока не подключены.</p></section>',
        '        <section><h2>Свойства</h2><p>Выберите объект карты — просмотр и изменение свойств пока не реализованы.</p></section>',
        '        <section><h2>Изменения</h2><p>Журнал изменений пока не ведётся.</p></section>',
        '      </aside>',
      ].join('\n'),
      headAfterStyles: '  <link rel="stylesheet" href="../sector.css">\n  <link rel="stylesheet" href="admin-edit.css">',
      title: 'Timeline Project — Заготовка администратора сектора',
    }
    : atlasVariants[variantName as 'minimal' | 'sector'];
  const replacements: Record<string, string> = {
    ADMIN_EDITOR_PANEL: variant.adminEditorPanel,
    ADMIN_GATE: variant.adminGate,
    BODY_ATTRS: variant.bodyAttrs,
    COORDINATE_CONTROLS: variant.coordinateControls,
    COORDINATE_READOUT: variant.coordinateReadout,
    GALAXY_RETURN: variant.galaxyReturn,
    HEAD_AFTER_READABILITY: variant.headAfterReadability,
    HEAD_AFTER_STYLES: variant.headAfterStyles,
    HEAD_NOTE: variant.headNote,
    HELP_LABEL: variant.helpLabel,
    INTRO: variant.intro,
    LEFT_TOGGLE: variant.leftToggle,
    LEGACY_TOGGLE: variant.legacyToggle,
    MODAL_FOOT: variant.modalFoot,
    MODAL_TITLE: variant.modalTitle,
    RETURN_SCRIPTS: variant.returnScripts,
    TITLE: variant.title,
  };

  let rendered = readFileSync(atlasTemplatePath, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`@@${key}@@`).join(value);
  }
  if (rendered.includes('@@')) throw new Error(`Не заполнен placeholder шаблона атласа: ${variantName}`);
  return rendered;
}
