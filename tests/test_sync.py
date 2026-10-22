#!/usr/bin/env python3
"""Unit-тесты строгой проверки и HTTP-защиты tools/sync.py."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import sync as sync_module  # noqa: E402


COORDINATE_ERRORS_CSV = (
    "id,name,x,y\n"
    "s1,Первый,не-число,2\n"
    "s2,Второй,1,тоже-ошибка\n"
    "s3,Третий,-1,3\n"
    "s4,Четвёртый,4,101\n"
)


@contextlib.contextmanager
def sync_sandbox(sources, payloads=None, snapshots=None, map_size=100):
    """Подменить пути синка временной директорией и не трогать data/ репозитория."""
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        data = root / "data"
        upstream = data / "upstream"
        upstream.mkdir(parents=True)

        sources_path = data / "sources.json"
        sources_path.write_text(
            json.dumps({"version": 1, "sources": sources}, ensure_ascii=False),
            encoding="utf-8",
        )
        meta_path = data / "meta.json"
        meta_path.write_text(
            json.dumps({"mapSize": map_size}, ensure_ascii=False), encoding="utf-8"
        )
        manifest_path = upstream / "manifest.json"
        manifest_path.write_text('{"sources": {}}\n', encoding="utf-8")

        for relative_path, text in (snapshots or {}).items():
            target = root / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")

        with ExitStack() as patches:
            patches.enter_context(mock.patch.object(sync_module, "ROOT", root))
            patches.enter_context(mock.patch.object(sync_module, "DATA", data))
            patches.enter_context(mock.patch.object(sync_module, "UPSTREAM", upstream))
            patches.enter_context(mock.patch.object(sync_module, "SOURCES", sources_path))
            patches.enter_context(mock.patch.object(sync_module, "META", meta_path))
            patches.enter_context(mock.patch.object(sync_module, "MANIFEST", manifest_path))

            if payloads is not None:
                def fake_http_get(url, token=None):
                    if url not in payloads:
                        raise AssertionError(f"Неожиданный URL: {url}")
                    return payloads[url], {"Content-Type": "text/csv; charset=utf-8"}

                patches.enter_context(
                    mock.patch.object(sync_module, "http_get", fake_http_get)
                )

            yield root, data


def sheet_source(role, source_id=None, enabled=True):
    source_id = source_id or f"{role}-sheet"
    return {
        "id": source_id,
        "type": "url",
        "enabled": enabled,
        "url": f"https://example.invalid/{source_id}.csv",
        "role": role,
        "target": f"data/{role}.csv",
        "transform": {"flipY": False, "scale": 1, "offsetX": 0, "offsetY": 0},
    }


class StrictSyncModeTest(unittest.TestCase):
    def test_cli_defaults_to_soft_mode_and_accepts_strict_flag(self):
        self.assertFalse(sync_module.parse_args().strict)
        self.assertTrue(sync_module.parse_args(["--strict"]).strict)

    def test_default_mode_keeps_soft_coordinate_behavior(self):
        source = sheet_source("systems")
        payloads = {source["url"]: COORDINATE_ERRORS_CSV.encode("utf-8")}
        with sync_sandbox([source], payloads=payloads):
            with contextlib.redirect_stdout(io.StringIO()):
                sync_module.main()

    def test_strict_mode_lists_nonnumeric_and_out_of_range_x_and_y(self):
        source = sheet_source("systems")
        payloads = {source["url"]: COORDINATE_ERRORS_CSV.encode("utf-8")}
        with sync_sandbox([source], payloads=payloads):
            error_output = io.StringIO()
            with contextlib.redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as raised:
                    sync_module.main(["--strict"])

        self.assertEqual(1, raised.exception.code)
        message = error_output.getvalue()
        self.assertIn("строгая проверка таблиц завершилась ошибками", message)
        self.assertIn("поле x", message)
        self.assertIn("поле y", message)
        self.assertIn("не является числом", message)
        self.assertIn("вне диапазона 0..100", message)

    def test_default_mode_allows_places_binding_with_manual_coordinates(self):
        source = sheet_source("places")
        payload = "ID,name,system_id,x,y\np1,Планета,s1,25,\n".encode("utf-8")
        with sync_sandbox([source], payloads={source["url"]: payload}):
            with contextlib.redirect_stdout(io.StringIO()):
                sync_module.main()

    def test_strict_mode_rejects_places_binding_with_manual_coordinates(self):
        source = sheet_source("places")
        payload = "ID,name,system_id,x,y\np1,Планета,s1,25,\n".encode("utf-8")
        with sync_sandbox([source], payloads={source["url"]: payload}):
            error_output = io.StringIO()
            with contextlib.redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as raised:
                    sync_module.main(["--strict"])

        self.assertEqual(1, raised.exception.code)
        self.assertIn("system_id «s1» указан вместе с ручными координатами", error_output.getvalue())

    def test_strict_infers_places_role_from_target_when_role_is_missing(self):
        source = sheet_source("places")
        source.pop("role")
        payload = "ID,name,system_id,x,y\np1,Планета,s1,25,\n".encode("utf-8")
        with sync_sandbox([source], payloads={source["url"]: payload}):
            error_output = io.StringIO()
            with contextlib.redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as raised:
                    sync_module.main(["--strict"])

        self.assertEqual(1, raised.exception.code)
        self.assertIn("(places)", error_output.getvalue())
        self.assertIn("указан вместе с ручными координатами", error_output.getvalue())

    def test_default_and_strict_modes_for_duplicate_nonempty_local_id(self):
        source = sheet_source("systems", enabled=False)
        snapshot = (
            "system_id,name,x,y\n"
            "same,Первая система,,\n"
            "same,Повторная система,,\n"
        )
        with sync_sandbox(
            [source], snapshots={"data/systems.csv": snapshot}
        ):
            with contextlib.redirect_stdout(io.StringIO()):
                sync_module.main()

        with sync_sandbox(
            [source], snapshots={"data/systems.csv": snapshot}
        ):
            error_output = io.StringIO()
            with contextlib.redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as raised:
                    sync_module.main(["--strict"])

        self.assertEqual(1, raised.exception.code)
        self.assertIn("дублирующийся непустой id «same»", error_output.getvalue())

    def test_empty_ids_are_not_reported_as_duplicates(self):
        errors = sync_module.validate_strict_table(
            "fixture",
            "systems",
            [{"id": "", "x": "", "y": ""}, {"id": "  ", "x": "", "y": ""}],
            ["id", "x", "y"],
            100,
        )
        self.assertFalse(any("дублирующийся непустой id" in error for error in errors))


class SyncTransportProtectionTest(unittest.TestCase):
    def test_html_instead_of_csv_has_three_actionable_publication_steps(self):
        source = sheet_source("systems")
        html_response = b"<!doctype html><html><title>Sign in</title></html>"

        with sync_sandbox([source], payloads={source["url"]: html_response}):
            error_output = io.StringIO()
            with contextlib.redirect_stderr(error_output):
                with self.assertRaises(SystemExit) as raised:
                    sync_module.main()

        self.assertEqual(1, raised.exception.code)
        message = error_output.getvalue()
        self.assertIn("Файл → Поделиться → Опубликовать в интернете", message)
        self.assertIn("нужную вкладку и формат CSV", message)
        self.assertIn("окне инкогнито", message)
        for number in (1, 2, 3):
            self.assertRegex(message, rf"(?m)^{number}\.")

    def test_authorization_is_unredirected_only_for_token_hosts(self):
        class FakeResponse:
            headers = {"Content-Type": "text/plain"}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self):
                return b"ok"

        test_hosts = sorted(sync_module.TOKEN_HOSTS | {"docs.google.com", "example.invalid"})
        for host in test_hosts:
            with self.subTest(host=host):
                with mock.patch.object(
                    sync_module.urllib.request,
                    "urlopen",
                    return_value=FakeResponse(),
                ) as urlopen:
                    self.assertEqual(
                        (b"ok", {"Content-Type": "text/plain"}),
                        sync_module.http_get(f"https://{host}/fixture", token="secret"),
                    )

                request = urlopen.call_args.args[0]
                expected = host in sync_module.TOKEN_HOSTS
                self.assertEqual(
                    "Bearer secret" if expected else None,
                    request.unredirected_hdrs.get("Authorization"),
                )
                self.assertFalse(
                    any(name.lower() == "authorization" for name in request.headers)
                )

        with mock.patch.object(
            sync_module.urllib.request, "urlopen", return_value=FakeResponse()
        ) as urlopen:
            sync_module.http_get("http://api.github.com/fixture", token="secret")
        request = urlopen.call_args.args[0]
        self.assertNotIn("Authorization", request.unredirected_hdrs)


if __name__ == "__main__":
    unittest.main()
