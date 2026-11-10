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
      // Выход из демо-режима стоит там же, где на секторе — кнопка входа.
      adminGate: '        <button class="admin-gate-link admin-session-end" id="adminSessionEnd" type="button" data-admin-session-return="/sector/" hidden>Завершить сеанс</button>',
      adminGatePanel: '',
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
        '        <div class="admin-editor-heading">',
        '          <div>',
        '            <p class="eyebrow"><span class="eyebrow-line"></span> РЕДАКТОР ГРАНИЦ</p>',
        '            <h1 id="adminEditorTitle">Редактор сектора</h1>',
        '          </div>',
        '          <div class="admin-editor-heading-tools">',
        '            <button class="admin-editor-help icon-button" id="adminEditorHelp" type="button" data-action="help" title="Справка по редактору" aria-label="Справка по редактору"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"></circle><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .9-1 1.6v.4"></path><path d="M12 17.2h.01"></path></svg></button>',
        '            <button class="admin-editor-collapse icon-button" id="adminEditorCollapse" type="button" data-action="collapse" aria-expanded="true" aria-controls="adminEditorBody" title="Свернуть редактор" aria-label="Свернуть редактор"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg></button>',
        '          </div>',
        '        </div>',
        '        <p class="admin-editor-summary" data-editor-summary></p>',
        '        <div class="admin-editor-body" id="adminEditorBody">',
        '          <p class="admin-editor-notice">Редактор границ: изменения лежат черновиком в этом браузере и выгружаются файлом. На сайт и в общие данные ничего не уходит до заявки.</p>',
        '          <section><h2>Модули</h2><div class="admin-editor-block" data-editor-block="modules"></div></section>',
        '          <section><h2>Свойства</h2><div class="admin-editor-block" data-editor-block="properties"></div></section>',
        '          <section><h2>Изменения</h2><div class="admin-editor-block" data-editor-block="changes"></div></section>',
        '          <section><h2>Линии</h2><div class="admin-editor-block" data-editor-block="lines"></div></section>',
        '          <section><h2>Иерархия</h2><div class="admin-editor-block" data-editor-block="hierarchy"></div></section>',
        '        </div>',
        '        <button class="admin-editor-rail" id="adminEditorRail" type="button" data-action="expand" aria-expanded="false" aria-controls="adminEditorBody" title="Развернуть редактор" aria-label="Развернуть редактор">',
        '          <span class="admin-editor-rail-arrows" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>',
        '          <span class="admin-editor-rail-label">Редактор границ</span>',
        '        </button>',
        '      </aside>',
      ].join('\n'),
      headAfterStyles: '  <link rel="stylesheet" href="../sector.css">\n  <link rel="stylesheet" href="admin-edit.css">',
      title: 'Timeline Project — Заготовка администратора сектора',
    }
    : atlasVariants[variantName as 'minimal' | 'sector'];
  const replacements: Record<string, string> = {
    ADMIN_EDITOR_PANEL: variant.adminEditorPanel,
    ADMIN_GATE: variant.adminGate,
    ADMIN_GATE_PANEL: variant.adminGatePanel,
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
