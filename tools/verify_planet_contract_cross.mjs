#!/usr/bin/env node
/* Кросс-проверка Python ↔ TypeScript контракта planet_generation (CR-01 PR 2).
 *
 * Python и TypeScript читают один src/contracts/planet-generation-contract.json.
 * Этот verifier дополнительно доказывает, что независимые реализации
 * раскрытия профиля, Decimal ROUND_HALF_UP, канонического JSON и PG1 дают
 * байт-в-байт одинаковый результат. Python вызывается только здесь как
 * эталон второй реализации; bench-скрипты пресеты из Python больше не тянут.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT,
  FIELDS,
  DEFAULT_VERSIONS,
  SUPPORTED_VERSIONS,
  VERSION_FIELDS,
  GEOGRAPHY_NUMBER_FIELDS,
  NUMBER_PRECISION,
  PRESETS,
  computeGenerationKey,
  geographyManifestCanonicalText,
  getPresetGeographyValues,
  quantizeDecimal,
} from '../site/shared/planet-generation-contract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const profiles = [
  {
    _place_type: 'planet',
    place_id: '2',
    profile_status: 'draft',
    profile_revision: '1',
    preset_id: 'earthlike_balanced',
    surface_class: 'terrestrial',
    radius_km: '6371',
    master_seed_hex: '0123456789abcdef',
  },
  {
    _place_type: 'planet',
    place_id: '2',
    profile_status: 'review',
    profile_revision: '7',
    preset_id: 'desert_dry',
    surface_class: 'desert',
    radius_km: '3390.5005',
    master_seed_hex: 'ABCDEF0123456789',
    grid_version: 'goldberg-gp-v0',
    noise_version: 'planet-noise-simplex3d-v1',
    geography_version: 'c100-soft-v1',
    preset_version: 'planet-presets-v1',
    continent_mean_cells: '560.0005',
    continent_variation: '0.5000005',
    ocean_pctl: '25.0005',
    coast_soft_width_cells: '1.6000005',
  },
  {
    _place_type: 'planet',
    place_id: '2',
    profile_status: 'draft',
    profile_revision: '3',
    preset_id: 'gas_giant_bands',
    surface_class: 'gas_giant',
    radius_km: '69911',
    master_seed_hex: 'ffffffffffffffff',
  },
  {
    _place_type: 'moon',
    place_id: '5',
    profile_status: 'draft',
    profile_revision: '2',
    preset_id: 'barren_moon',
    surface_class: 'barren',
    radius_km: '1737.4',
    master_seed_hex: '0000000000000001',
    transition_entropy_pctl: '80.0005',
  },
  {
    _place_type: 'planet',
    place_id: '2',
    profile_status: 'draft',
    profile_revision: '11',
    preset_id: 'earthlike_archipelago',
    surface_class: 'ocean',
    radius_km: '6.371e3',
    master_seed_hex: '0123456789abcdee',
    major_river_flow_pctl: '98.5005',
    biome_soft_width_cells: '1.6000004',
  },
];

const decimalCases = [
  ['radius_km', '6371.0005'],
  ['radius_km', '6371.0004'],
  ['radius_km', '1e3'],
  ['continent_variation', '0.0000005'],
  ['continent_variation', '0.0000004'],
  ['continent_variation', '1.2345675'],
  ['axial_tilt_deg', '-1.2345675'],
  ['axial_tilt_deg', '-0.0000004'],
  ['ocean_pctl', '99.9995'],
  ['ocean_basin_mean_cells', '6000.0005'],
];

// Фиксированные значения покрывают обе ветки ISO-парсера и не зависят от часов.
const approvedAtCases = ['2026-10-21', '2026-10-21T18:30:00Z'];

const pythonCode = String.raw`
import json
import sys
from decimal import Decimal
sys.path.insert(0, "tools")
import planet_generation as pg

request = json.load(sys.stdin)
profiles_out = []
for raw in request["profiles"]:
    place_type = raw.get("_place_type", "planet")
    variants = []
    for approved_at in request["approved_at_cases"]:
        frozen = pg.prepare_freeze_row(
            raw,
            approved_by="cross-verifier",
            approved_at=approved_at,
            seed_hex=raw.get("master_seed_hex") or "0123456789abcdef",
        )
        result = pg.validate_profiles(
            [frozen],
            list(pg.FIELDS),
            [{"ID": raw["place_id"], "name": "cross", "type": place_type}],
            ["ID", "name", "type"],
        )
        if result.errors:
            raise AssertionError(f"{approved_at}: " + "\n".join(result.errors))
        profile = result.profiles[0]
        variants.append({
            "approved_at": profile["approved_at"],
            "canonical": pg.canonical_json_bytes(
                pg.build_geography_manifest(profile)
            ).decode("utf-8"),
            "generation_key": pg.compute_generation_key(profile),
        })
    profiles_out.append({"approved_at_variants": variants})

decimal_out = []
for field, text in request["decimal_cases"]:
    decimal_out.append(format(pg._quantize_number(field, Decimal(text)), "f"))

payload = {
    "fields": pg.FIELDS,
    "profile_statuses": sorted(pg.PROFILE_STATUSES),
    "surface_classes": sorted(pg.SURFACE_CLASSES),
    "default_versions": pg.DEFAULT_VERSIONS,
    "supported_versions": {
        name: sorted(values) for name, values in pg.SUPPORTED_VERSIONS.items()
    },
    "version_fields": list(pg.VERSION_FIELDS),
    "geography_number_fields": list(pg.GEOGRAPHY_NUMBER_FIELDS),
    "geography_number_field_groups": {
        "target_scale": pg.TARGET_SCALE_FIELDS,
        "percentile": pg.PERCENTILE_FIELDS,
        "soft_width": pg.SOFT_WIDTH_FIELDS,
        "transition_entropy": ["transition_entropy_pctl"],
    },
    "number_precision": pg.NUMBER_PRECISION,
    "presets": pg._json_ready(pg.PRESETS),
    "profiles": profiles_out,
    "decimal_cases": decimal_out,
}
json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))
`;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkEqual(name, actual, expected) {
  if (stable(actual) !== stable(expected)) {
    failures.push(`${name}: TypeScript=${stable(actual)} Python=${stable(expected)}`);
  }
}

const python = process.env.PYTHON || 'python3';
const child = spawnSync(python, ['-c', pythonCode], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  input: JSON.stringify({
    profiles,
    decimal_cases: decimalCases,
    approved_at_cases: approvedAtCases,
  }),
  maxBuffer: 16 * 1024 * 1024,
});
if (child.status !== 0) {
  console.error(child.stdout || '');
  console.error(child.stderr || '');
  process.exit(1);
}
const pythonResult = JSON.parse(child.stdout);

checkEqual('fields', FIELDS, pythonResult.fields);
checkEqual('profile_statuses', [...CONTRACT.profile_statuses].sort(), pythonResult.profile_statuses);
checkEqual('surface_classes', [...CONTRACT.surface_classes].sort(), pythonResult.surface_classes);
checkEqual('default_versions', DEFAULT_VERSIONS, pythonResult.default_versions);
checkEqual(
  'supported_versions',
  Object.fromEntries(Object.entries(SUPPORTED_VERSIONS).map(([name, values]) => [name, [...values].sort()])),
  pythonResult.supported_versions,
);
checkEqual('version_fields', VERSION_FIELDS, pythonResult.version_fields);
checkEqual('geography_number_fields', GEOGRAPHY_NUMBER_FIELDS, pythonResult.geography_number_fields);
checkEqual(
  'geography_number_field_groups',
  CONTRACT.geography_number_field_groups,
  pythonResult.geography_number_field_groups,
);
checkEqual('number_precision', NUMBER_PRECISION, pythonResult.number_precision);

const tsPresets = Object.fromEntries(Object.entries(PRESETS).map(([presetId, preset]) => [
  presetId,
  {
    description: preset.description,
    palette_id: preset.palette_id,
    expected_surface_classes: [...preset.expected_surface_classes].sort(),
    values: getPresetGeographyValues(presetId),
  },
]));
const pythonPresets = Object.fromEntries(Object.entries(pythonResult.presets).map(([presetId, preset]) => [
  presetId,
  {
    ...preset,
    expected_surface_classes: [...preset.expected_surface_classes].sort(),
  },
]));
checkEqual('presets', tsPresets, pythonPresets);

profiles.forEach((profile, index) => {
  const variants = pythonResult.profiles[index].approved_at_variants;
  checkEqual(
    `profile[${index}].approved_at branches`,
    variants.map((variant) => variant.approved_at),
    approvedAtCases,
  );

  const generationKey = computeGenerationKey(profile);
  for (const approvedAt of approvedAtCases) {
    const variant = variants.find((item) => item.approved_at === approvedAt);
    if (!variant) {
      failures.push(`profile[${index}]: Python validator skipped approved_at=${approvedAt}`);
      continue;
    }
    checkEqual(
      `profile[${index}].canonical approved_at=${approvedAt}`,
      geographyManifestCanonicalText(profile),
      variant.canonical,
    );
    checkEqual(
      `profile[${index}].generation_key approved_at=${approvedAt}`,
      generationKey,
      variant.generation_key,
    );
    if (!variant.generation_key.startsWith('PG1-')) {
      failures.push(`profile[${index}]: invalid PG1 generation_key for ${approvedAt}`);
    }
  }
  checkEqual(
    `profile[${index}].generation_key independent of approved_at`,
    variants.map((variant) => variant.generation_key),
    approvedAtCases.map(() => generationKey),
  );
});

decimalCases.forEach(([field, text], index) => {
  checkEqual(`decimal ${field}=${text}`, String(quantizeDecimal(field, text)), pythonResult.decimal_cases[index]);
});

if (failures.length) {
  console.error('Planet contract cross-check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `Planet contract cross-check OK: ${FIELDS.length} колонок, ${Object.keys(PRESETS).length} пресетов, ` +
  `${profiles.length} профилей × ${approvedAtCases.length} approved_at-формата, ` +
  `${decimalCases.length} decimal-кейсов.`,
);
