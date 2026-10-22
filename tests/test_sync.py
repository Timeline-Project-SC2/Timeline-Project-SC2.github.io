#!/usr/bin/env python3
"""Тесты строгой проверки синхронизации и защиты HTTP-запросов."""

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import sync


class SyncStrictModeTests(unittest.TestCase):
    """Проверяют CLI-режимы на CSV во временной директории."""

    def _run_sync(self, csv_text, *, strict=False, role="systems", disabled=False):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            data_dir = root / "data"
            upstream_dir = data_dir / "upstream"
            data_dir.mkdir(parents=True)
            target = data_dir / f"{role}.csv"
            target_relative = f"data/{role}.csv"
            source = {
                "id": f"{role}-sheet",
                "type": "url",
                "url": "https://example.test/export.csv",
                "role": role,
                "target": target_relative,
            }
            if disabled:
                source["enabled"] = False
                target.write_text(csv_text, encoding="utf-8")
            (data_dir / "sources.json").write_text(
                json.dumps({"sources": [source]}), encoding="utf-8"
            )
            (data_dir / "meta.json").write_text(
                json.dumps({"mapSize": 10}), encoding="utf-8"
            )

            stdout = io.StringIO()
            stderr = io.StringIO()
            code = 0
            with mock.patch.multiple(
                sync,
                ROOT=root,
                DATA=data_dir,
                UPSTREAM=upstream_dir,
                SOURCES=data_dir / "sources.json",
                MANIFEST=upstream_dir / "manifest.json",
                META=data_dir / "meta.json",
            ):
                with mock.patch.object(
                    sync,
                    "http_get",
                    return_value=(
                        csv_text.encode("utf-8"),
                        {"Content-Type": "text/csv; charset=utf-8"},
                    ),
                ):
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(
                        stderr
                    ):
                        try:
                            sync.main(["--strict"] if strict else [])
                        except SystemExit as error:
                            code = error.code if isinstance(error.code, int) else 1

            return {
                "code": code,
                "stdout": stdout.getvalue(),
                "stderr": stderr.getvalue(),
                "target_exists": target.exists(),
                "target_text": target.read_text(encoding="utf-8") if target.exists() else None,
            }

    def assert_soft_passes_and_strict_fails(self, csv_text, role, expected_errors):
        soft = self._run_sync(csv_text, role=role)
        self.assertEqual(soft["code"], 0, soft["stderr"])

        strict = self._run_sync(csv_text, role=role, strict=True)
        self.assertEqual(strict["code"], 1, strict["stderr"])
        self.assertIn("строгая проверка не пройдена", strict["stderr"])
        for expected in expected_errors:
            self.assertIn(expected, strict["stderr"])
        self.assertFalse(strict["target_exists"], "ошибочный CSV не должен записываться")

    def test_non_numeric_x_and_y_are_allowed_by_default_but_reported_in_strict_mode(self):
        self.assert_soft_passes_and_strict_fails(
            "system_id,x,y\n1,восток,север\n",
            "systems",
            ["x=«восток»", "y=«север»", "ожидается число"],
        )

    def test_coordinates_outside_map_size_are_allowed_by_default_but_rejected_in_strict_mode(self):
        self.assert_soft_passes_and_strict_fails(
            "system_id,x,y\n1,-1,11\n",
            "systems",
            ["x=-1 выходит за диапазон 0..10", "y=11 выходит за диапазон 0..10"],
        )

    def test_places_system_binding_and_manual_coordinates_conflict_in_strict_mode(self):
        self.assert_soft_passes_and_strict_fails(
            "ID,system_id,x,y\n1,2,3,4\n",
            "places",
            ["одновременно заполнены system_id и ручные координаты x/y"],
        )

    def test_duplicate_nonempty_local_ids_are_rejected_only_in_strict_mode(self):
        csv_text = "system_id,x,y\n7,1,2\n7,3,4\n"
        soft = self._run_sync(csv_text, role="systems", disabled=True)
        self.assertEqual(soft["code"], 0, soft["stderr"])
        self.assertEqual(soft["target_text"], csv_text)

        strict = self._run_sync(csv_text, role="systems", disabled=True, strict=True)
        self.assertEqual(strict["code"], 1, strict["stderr"])
        self.assertIn("дублирующийся id «7»", strict["stderr"])
        self.assertEqual(strict["target_text"], csv_text)


class SyncHttpSafetyTests(unittest.TestCase):
    def test_html_response_explains_public_csv_and_incognito_checks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            html_response = (
                b"<!doctype html><html><body>Sign in to continue</body></html>",
                {"Content-Type": "text/html; charset=utf-8"},
            )
            stderr = io.StringIO()
            with mock.patch.object(sync, "ROOT", Path(temp_dir)):
                with mock.patch.object(sync, "http_get", return_value=html_response):
                    with contextlib.redirect_stderr(stderr):
                        with self.assertRaises(SystemExit) as raised:
                            sync.prepare_url_source(
                                {
                                    "id": "private-sheet",
                                    "type": "url",
                                    "url": "https://example.test/export.csv",
                                    "target": "data/systems.csv",
                                },
                                {"sources": {}},
                            )

        self.assertEqual(raised.exception.code, 1)
        message = stderr.getvalue()
        self.assertIn("Файл → Поделиться → Опубликовать в интернете", message)
        self.assertIn("вкладку и формат CSV", message)
        self.assertIn("окне инкогнито", message)

    def test_authorization_is_unredirected_and_only_sent_to_token_hosts(self):
        class FakeResponse:
            headers = {"Content-Type": "text/plain"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b"ok"

        urls = [
            ("https://api.github.com/repos/example/project", True),
            ("https://raw.githubusercontent.com/example/project/main/file.csv", True),
            ("https://docs.google.com/spreadsheets/export", False),
            ("https://api.github.com.example.test/resource", False),
            ("http://api.github.com/repos/example/project", False),
        ]
        for url, should_send_token in urls:
            with self.subTest(url=url):
                with mock.patch.object(
                    sync.urllib.request, "urlopen", return_value=FakeResponse()
                ) as urlopen:
                    data, _headers = sync.http_get(url, token="test-token")

                self.assertEqual(data, b"ok")
                request = urlopen.call_args.args[0]
                unredirected = {
                    key.casefold(): value
                    for key, value in request.unredirected_hdrs.items()
                }
                regular = {
                    key.casefold(): value for key, value in request.headers.items()
                }
                if should_send_token:
                    self.assertEqual(unredirected.get("authorization"), "Bearer test-token")
                    self.assertNotIn("authorization", regular)
                else:
                    self.assertNotIn("authorization", unredirected)
                    self.assertNotIn("authorization", regular)


if __name__ == "__main__":
    unittest.main()
