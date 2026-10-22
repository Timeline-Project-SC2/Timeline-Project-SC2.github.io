import { readFileSync } from 'node:fs';
import { atlasVariants, type AtlasVariantName } from '../../src/atlas/atlas-variants.ts';

/** Заполняет общий шаблон только для HTML с явным маркером варианта. */
export function renderAtlasVariant(html: string, atlasTemplatePath: string): string {
  const match = /<!--\s*atlas-variant:\s*(sector|minimal)\s*-->/.exec(html);
  if (!match) return html;
  const variantName = match[1] as AtlasVariantName;
  const variant = atlasVariants[variantName];
  const replacements: Record<string, string> = {
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
