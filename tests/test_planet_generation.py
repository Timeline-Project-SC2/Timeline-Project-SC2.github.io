#!/usr/bin/env python3
"""Тесты контракта planet_generation, generation_key и гейта синхронизации."""

from __future__ import annotations

import copy
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import planet_generation as pg  # noqa: E402
import sync as sync_module  # noqa: E402


PLACE_FIELDS = ["ID", "name", "type"]
PLACES = [
    {"ID": "2", "name": "Корхал IV", "type": "planet"},
    {"ID": "5", "name": "Зефир", "type": "moon"},
    {"ID": "station-1", "name": "Станция", "type": "station"},
    {"ID": "rock-1", "name": "Астероид", "type": "asteroid"},
    {"ID": "odd-1", "name": "Особое тело", "type": "other"},
]

GOLDEN_KEY = "PG1-Y6MQHGY72BADEFMKSV5KRH5B44"


def draft_row(**overrides):
    row = pg.make_draft_row(
        "2",
        radius_km="6371",
        seed_hex="0123456789abcdef",
        include_seed=False,
    )
    row.update(overrides)
    return row


def validate(rows, places=None, profile_fields=None, place_fields=None):
    return pg.validate_profiles(
        rows,
        list(profile_fields or pg.FIELDS),
        list(places if places is not None else PLACES),
        list(place_fields or PLACE_FIELDS),
    )


def frozen_row(**overrides):
    row = draft_row(**overrides)
    return pg.prepare_freeze_row(
        row,
        approved_by="owner",
        approved_at="2026-10-19",
    )


def effective_for(row):
    result = validate([row])
    if result.errors:
        raise AssertionError("\n".join(result.errors))
    return result.profiles[0]


class SchemaAndPresetsTest(unittest.TestCase):
    def test_schema_has_37_unique_fields(self):
        self.assertEqual(37, len(pg.FIELDS))
        self.assertEqual(37, len(set(pg.FIELDS)))

    def test_every_preset_expands_to_valid_geography(self):
        surface_by_preset = {
            "earthlike_balanced": "terrestrial",
            "earthlike_archipelago": "terrestrial",
            "ocean_world": "ocean",
            "desert_dry": "desert",
            "ice_world": "ice",
            "volcanic_active": "volcanic",
            "barren_moon": "barren",
            "gas_giant_bands": "gas_giant",
        }
        self.assertEqual(set(surface_by_preset), set(pg.PRESETS))
        for preset_id, surface_class in surface_by_preset.items():
            with self.subTest(preset=preset_id):
                row = draft_row(preset_id=preset_id, surface_class=surface_class)
                result = validate([row])
                self.assertEqual([], result.errors)
                self.assertEqual([], result.warnings)
                profile = result.profiles[0]
                for name in pg.GEOGRAPHY_NUMBER_FIELDS:
                    self.assertIsNotNone(profile[name], name)

    def test_repository_snapshot_and_template_validate(self):
        for name in ("planet-generation.csv", "planet-generation-template.csv"):
            with self.subTest(file=name):
                result = pg.validate_csv_files(
                    ROOT / "data" / name,
                    ROOT / "data" / "places.csv",
                )
                self.assertEqual([], result.errors)
                self.assertEqual([], result.warnings)

    def test_missing_and_extra_headers_are_errors(self):
        result = validate([draft_row()], profile_fields=pg.FIELDS[:-1])
        self.assertTrue(any("отсутствуют колонки" in e for e in result.errors))

        result = validate([draft_row()], profile_fields=pg.FIELDS + ["surprise"])
        self.assertTrue(any("неизвестные колонки" in e for e in result.errors))

    def test_csv_parser_reports_wrong_field_count(self):
        table = pg.parse_csv_text("a,b\n1\n")
        self.assertTrue(any("ожидалось 2 полей" in e for e in table.errors))


class ValidationTest(unittest.TestCase):
    def assert_has_error(self, rows, needle):
        result = validate(rows)
        self.assertTrue(
            any(needle in error for error in result.errors),
            f"нет ошибки с «{needle}»: {result.errors}",
        )
        return result

    def test_valid_draft_can_omit_preset_numbers(self):
        result = validate([draft_row(radius_km="", master_seed_hex="")])
        self.assertEqual([], result.errors)

    def test_missing_place_and_duplicate_profile_are_errors(self):
        self.assert_has_error([draft_row(place_id="404")], "отсутствует в places")
        self.assert_has_error([draft_row(), draft_row()], "дублирующийся профиль")

    def test_station_and_asteroid_profiles_are_rejected(self):
        self.assert_has_error([draft_row(place_id="station-1")], "нельзя создавать")
        self.assert_has_error([draft_row(place_id="rock-1")], "астероидов не входят")

    def test_other_place_is_allowed_with_warning(self):
        result = validate([draft_row(place_id="odd-1")])
        self.assertEqual([], result.errors)
        self.assertTrue(any("type=other" in w for w in result.warnings))

    def test_unknown_enums_and_bad_seed_are_errors(self):
        self.assert_has_error([draft_row(profile_status="ready")], "profile_status")
        self.assert_has_error([draft_row(surface_class="lava")], "surface_class")
        self.assert_has_error([draft_row(preset_id="custom")], "неизвестный preset_id")
        self.assert_has_error(
            [draft_row(master_seed_hex="123")], "ровно 16 hex-цифр"
        )

    def test_numeric_ranges_and_percentile_order(self):
        self.assert_has_error([draft_row(radius_km="0")], "radius_km")
        self.assert_has_error([draft_row(radius_km="1e100")], "radius_km")
        self.assert_has_error([draft_row(continent_mean_cells="1e100")], "continent_mean_cells")
        self.assert_has_error([draft_row(ocean_pctl="101")], "ocean_pctl")
        self.assert_has_error([draft_row(ocean_pctl="50,5")], "числом с точкой")
        self.assert_has_error(
            [draft_row(shelf_below_pctl="80", ocean_pctl="70", shelf_above_pctl="90")],
            "shelf_below_pctl <= ocean_pctl <= shelf_above_pctl",
        )
        self.assert_has_error(
            [draft_row(highland_land_pctl="95", mountain_land_pctl="90")],
            "highland_land_pctl <= mountain_land_pctl",
        )

    def test_no_surface_is_only_an_explicit_disabled_opt_out(self):
        valid = draft_row(
            profile_status="disabled",
            surface_class="no_surface",
            radius_km="",
            master_seed_hex="",
        )
        self.assertEqual([], validate([valid]).errors)

        invalid = draft_row(surface_class="no_surface")
        self.assert_has_error([invalid], "только при profile_status=disabled")

    def test_gas_giant_requires_its_preset(self):
        self.assert_has_error(
            [draft_row(surface_class="gas_giant")],
            "нужен preset_id=gas_giant_bands",
        )
        valid = draft_row(
            preset_id="gas_giant_bands",
            surface_class="gas_giant",
        )
        result = validate([valid])
        self.assertEqual([], result.errors)
        self.assertEqual([], result.warnings)

    def test_frozen_requires_service_fields(self):
        row = draft_row(profile_status="frozen")
        result = validate([row])
        joined = "\n".join(result.errors)
        self.assertIn("явно указать grid_version", joined)
        self.assertIn("обязателен approved_by", joined)
        self.assertIn("обязателен approved_at", joined)
        self.assertIn("обязателен generation_key", joined)

    def test_unsupported_version_is_rejected(self):
        self.assert_has_error(
            [draft_row(noise_version="future-noise-v99")],
            "неподдерживаемая noise_version",
        )

    def test_grid_v1_is_default_and_legacy_v0_remains_supported(self):
        self.assertEqual("goldberg-gp-v1", effective_for(draft_row())["grid_version"])
        legacy = effective_for(draft_row(grid_version="goldberg-gp-v0"))
        self.assertEqual("goldberg-gp-v0", legacy["grid_version"])
        self.assert_has_error(
            [draft_row(grid_version="goldberg-gp-v99")],
            "неподдерживаемая grid_version",
        )

    def test_stale_key_in_draft_is_rejected(self):
        row = draft_row(generation_key="PG1-AAAAAAAAAAAAAAAAAAAAAAAAAA")
        self.assert_has_error([row], "не соответствует эффективному манифесту")


class GenerationKeyTest(unittest.TestCase):
    def test_golden_key_is_pinned(self):
        profile = effective_for(draft_row())
        self.assertEqual(GOLDEN_KEY, pg.compute_generation_key(profile))
        self.assertIsNotNone(re.fullmatch(r"PG1-[A-Z2-7]{26}", GOLDEN_KEY))

    def test_prepare_freeze_row_produces_valid_frozen_profile(self):
        row = frozen_row()
        result = validate([row])
        self.assertEqual([], result.errors)
        self.assertEqual(GOLDEN_KEY, row["generation_key"])
        self.assertEqual("frozen", row["profile_status"])

    def test_geography_changes_change_key(self):
        base = pg.compute_generation_key(effective_for(draft_row()))
        variants = [
            {"radius_km": "6372"},
            {"master_seed_hex": "0123456789abcdee"},
            {"ocean_pctl": "71"},
            {"profile_revision": "2"},
            {"preset_id": "earthlike_archipelago"},
        ]
        for overrides in variants:
            with self.subTest(overrides=overrides):
                changed = pg.compute_generation_key(effective_for(draft_row(**overrides)))
                self.assertNotEqual(base, changed)

    def test_render_and_editorial_changes_do_not_change_key(self):
        base = pg.compute_generation_key(effective_for(frozen_row()))
        changed_profile = copy.deepcopy(effective_for(frozen_row()))
        changed_profile["palette_id"] = "crimson"
        changed_profile["axial_tilt_deg"] = pg.D("45")
        changed_profile["rotation_period_hours"] = pg.D("10")
        changed_profile["approved_by"] = "someone-else"
        changed_profile["notes_admin"] = "редакционная заметка"
        self.assertEqual(base, pg.compute_generation_key(changed_profile))

    def test_seed_generator_format(self):
        for _ in range(20):
            self.assertIsNotNone(re.fullmatch(r"[0-9a-f]{16}", pg.generate_seed_hex()))

    def test_cli_main_validate_repository_files(self):
        self.assertEqual(0, pg.main(["validate"]))


class SyncGateTest(unittest.TestCase):
    def test_sync_cross_validation_rejects_bad_profile_before_writes(self):
        prepared = [
            {
                "id": "places-sheet",
                "role": "places",
                "fieldnames": PLACE_FIELDS,
                "rows": PLACES,
            },
            {
                "id": "planet-generation-sheet",
                "role": "planet_generation",
                "fieldnames": pg.FIELDS,
                "rows": [draft_row(place_id="404")],
            },
        ]
        with self.assertRaises(SystemExit):
            sync_module.validate_prepared_url_datasets(prepared)

    def test_sync_cross_validation_accepts_valid_profile(self):
        prepared = [
            {
                "id": "places-sheet",
                "role": "places",
                "fieldnames": PLACE_FIELDS,
                "rows": PLACES,
            },
            {
                "id": "planet-generation-sheet",
                "role": "planet_generation",
                "fieldnames": pg.FIELDS,
                "rows": [frozen_row()],
            },
        ]
        sync_module.validate_prepared_url_datasets(prepared)


class SyncIntegrationTest(unittest.TestCase):
    def run_fake_sync(self, profile_rows):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        data = root / "data"
        upstream = data / "upstream"
        upstream.mkdir(parents=True)

        sources = {
            "version": 1,
            "sources": [
                {
                    "id": "places-sheet",
                    "type": "url",
                    "url": "https://example.invalid/places.csv",
                    "kind": "sheet",
                    "role": "places",
                    "target": "data/places.csv",
                    "transform": {"flipY": False, "scale": 1, "offsetX": 0, "offsetY": 0},
                },
                {
                    "id": "planet-generation-sheet",
                    "type": "url",
                    "url": "https://example.invalid/planet-generation.csv",
                    "kind": "sheet",
                    "role": "planet_generation",
                    "target": "data/planet-generation.csv",
                    "transform": {"flipY": False, "scale": 1, "offsetX": 0, "offsetY": 0},
                },
            ],
        }
        sources_path = data / "sources.json"
        sources_path.write_text(json.dumps(sources), encoding="utf-8")

        old_places = "ID,name,type\nold,Старое место,planet\n"
        old_profiles = pg.serialize_profiles([])
        places_path = data / "places.csv"
        profiles_path = data / "planet-generation.csv"
        meta_path = data / "meta.json"
        manifest_path = upstream / "manifest.json"
        places_path.write_text(old_places, encoding="utf-8")
        profiles_path.write_text(old_profiles, encoding="utf-8")
        meta_path.write_text("{}\n", encoding="utf-8")
        manifest_path.write_text('{"sources": {}}\n', encoding="utf-8")

        new_places = pg.serialize_csv(PLACE_FIELDS, PLACES)
        new_profiles = pg.serialize_profiles(profile_rows)
        payloads = {
            "places.csv": new_places.encode("utf-8"),
            "planet-generation.csv": new_profiles.encode("utf-8"),
        }

        def fake_http_get(url, token=None):
            for suffix, payload in payloads.items():
                if url.endswith(suffix):
                    return payload, {"Content-Type": "text/csv; charset=utf-8"}
            raise AssertionError(f"Неожиданный URL: {url}")

        patches = [
            mock.patch.object(sync_module, "ROOT", root),
            mock.patch.object(sync_module, "DATA", data),
            mock.patch.object(sync_module, "UPSTREAM", upstream),
            mock.patch.object(sync_module, "SOURCES", sources_path),
            mock.patch.object(sync_module, "MANIFEST", manifest_path),
            mock.patch.object(sync_module, "META", meta_path),
            mock.patch.object(sync_module, "http_get", fake_http_get),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

        return {
            "old_places": old_places,
            "old_profiles": old_profiles,
            "places_path": places_path,
            "profiles_path": profiles_path,
            "manifest_path": manifest_path,
        }

    def test_invalid_profile_leaves_previous_snapshots_byte_for_byte(self):
        state = self.run_fake_sync([draft_row(place_id="404")])
        with self.assertRaises(SystemExit) as raised:
            sync_module.main()
        self.assertEqual(1, raised.exception.code)
        self.assertEqual(
            state["old_places"], state["places_path"].read_text(encoding="utf-8")
        )
        self.assertEqual(
            state["old_profiles"],
            state["profiles_path"].read_text(encoding="utf-8"),
        )

    def test_valid_profile_is_applied_with_manifest(self):
        state = self.run_fake_sync([frozen_row()])
        sync_module.main()
        updated = state["profiles_path"].read_text(encoding="utf-8")
        self.assertIn(GOLDEN_KEY, updated)
        self.assertIn("Корхал IV", state["places_path"].read_text(encoding="utf-8"))
        manifest = json.loads(state["manifest_path"].read_text(encoding="utf-8"))
        self.assertIn("planet-generation-sheet", manifest["sources"])


if __name__ == "__main__":
    unittest.main()
