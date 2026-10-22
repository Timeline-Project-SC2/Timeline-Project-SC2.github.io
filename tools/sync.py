#!/usr/bin/env python3
"""Автосинк данных из Google Sheets и legacy GitHub-источников.

URL-источники обрабатываются в две фазы: сначала все опубликованные CSV
скачиваются, нормализуются и проверяются в памяти, включая перекрёстную
валидацию planet_generation против places. Только после успешной проверки
снимки в data/ атомарно заменяются. Поэтому ошибочная строка нового листа
не попадает на сайт и не ломает предыдущий снимок.

При любой ошибке — ненулевой код выхода (workflow создаёт Issue).
При отсутствии изменений — выход 0 без записи (нет пустых коммитов).
"""
import argparse
import copy
import csv
import datetime
import hashlib
import io
import json
import math
import os
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UPSTREAM = DATA / "upstream"
SOURCES = DATA / "sources.json"
MANIFEST = UPSTREAM / "manifest.json"
META = DATA / "meta.json"

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))
import planet_generation

GITHUB_API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def load_json(path, default=None):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default if default is not None else {}


def write_text_atomically(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=path.name + ".", suffix=".tmp"
    )
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def write_bytes_atomically(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=path.parent, prefix=path.name + ".", suffix=".tmp"
    )
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _backup_file(path):
    return path.read_bytes() if path.exists() else None


def _restore_file(path, data):
    if data is None:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    else:
        write_bytes_atomically(path, data)


def save_json(path, obj):
    write_text_atomically(
        path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n"
    )


# Токен GitHub уходит только на хосты GitHub. Источники типа url (Google Sheets и др.)
# получают запрос без него: раньше токен добавлялся ко всем запросам, а при редиректе
# (например, на страницу входа Google) urllib переносил его и дальше.
TOKEN_HOSTS = {"api.github.com", "raw.githubusercontent.com"}


def http_get(url, token=None):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "koprulu-sync/1.0")
    parts = urllib.parse.urlsplit(url)
    if token and parts.scheme == "https" and parts.hostname in TOKEN_HOSTS:
        # unredirected: urllib не копирует такой заголовок в запрос после редиректа
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers


def latest_sha(repo, ref, token=None):
    url = f"{GITHUB_API}/repos/{repo}/commits/{ref}"
    data, _ = http_get(url, token)
    obj = json.loads(data)
    return obj["sha"]


def image_dimensions(data):
    # PNG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        import struct
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    # JPEG
    if data[:2] == b"\xff\xd8":
        i = 2
        n = len(data)
        while i < n:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h = int.from_bytes(data[i + 5:i + 7], "big")
                w = int.from_bytes(data[i + 7:i + 9], "big")
                return w, h
            if marker == 0xD9:
                break
            if i + 3 >= n:
                break
            seglen = int.from_bytes(data[i + 2:i + 4], "big")
            i += 2 + seglen
        fail("could not read JPEG dimensions")
    fail("unknown image format")


def looks_like_html(data, headers):
    """Отличает CSV от HTML-страницы.

    Если таблицу перестали публиковать в интернете, Google вместо CSV отдаёт
    страницу входа. Раньше она спокойно записывалась в data/*.csv и ломала сайт —
    теперь синк падает, а не портит данные.
    """
    ctype = ""
    try:
        ctype = (headers.get("Content-Type") or "").lower()
    except Exception:
        pass
    head = data[:512].lstrip().lower()
    if "text/html" in ctype or "application/xhtml" in ctype:
        return True
    return head.startswith(b"<!doctype") or head.startswith(b"<html")


def transform_csv(text, transform, img_w, img_h):
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    fieldnames = [ (fn or "").strip() for fn in (reader.fieldnames or []) ]
    # normalize row keys
    norm_rows = []
    for r in rows:
        nr = {}
        for k, v in r.items():
            nr[(k or "").strip()] = (v or "").strip() if isinstance(v, str) else v
        # skip completely empty rows
        if all((str(v).strip() == "" for v in nr.values())):
            continue
        # skip rows without id if an id column exists
        id_cols = [c for c in nr.keys() if c.lower() in ("id", "system_id", "place_id")]
        if id_cols and str(nr.get(id_cols[0], "")).strip() == "":
            continue
        norm_rows.append(nr)
    rows = norm_rows
    t = transform or {}
    flip_y = t.get("flipY", False)
    scale = t.get("scale", 1)
    ox = t.get("offsetX", 0)
    oy = t.get("offsetY", 0)
    for r in rows:
        for key in ("x", "X", "coord_x", "lon"):
            if key in r and r[key] not in (None, ""):
                try:
                    r[key] = str((float(r[key]) + ox) * scale)
                except ValueError:
                    pass
        for key in ("y", "Y", "coord_y", "lat"):
            if key in r and r[key] not in (None, ""):
                try:
                    v = (float(r[key]) + oy) * scale
                    if flip_y and img_h is not None:
                        v = img_h - v
                    r[key] = str(v)
                except ValueError:
                    pass
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=fieldnames)
    w.writeheader()
    w.writerows(rows)
    return out.getvalue(), rows, fieldnames


def validate_csv(rows, fieldnames, img_w, img_h):
    if not fieldnames:
        fail("CSV has no header")
    id_cols = [c for c in fieldnames if c.lower() in ("id", "system_id", "place_id")]
    if not id_cols:
        fail("CSV missing id column")
    id_col = id_cols[0]
    ids = [r[id_col] for r in rows]
    if len(set(ids)) != len(ids):
        fail("duplicate id in CSV")
    x_cols = [c for c in fieldnames if c.lower() in ("x", "coord_x", "lon")]
    y_cols = [c for c in fieldnames if c.lower() in ("y", "coord_y", "lat")]
    if x_cols and y_cols and img_w and img_h:
        xc, yc = x_cols[0], y_cols[0]
        for r in rows:
            try:
                x = float(r[xc]); y = float(r[yc])
            except (ValueError, TypeError):
                continue
            if not (0 <= x <= img_w and 0 <= y <= img_h):
                fail(f"coordinate out of bounds: id={r.get(id_col)} x={x} y={y}")
    return True


def read_local_csv_dataset(path):
    if not path.exists():
        return [], []
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError as e:
        fail(f"cannot read local snapshot {path}: {e}")
    table = planet_generation.parse_csv_text(text)
    if table.errors:
        fail(f"local snapshot {path}: " + "; ".join(table.errors))
    return table.fieldnames, [row.values for row in table.rows]


def check_unique_ids(sid, rows, fieldnames):
    id_cols = [
        c for c in (fieldnames or []) if c.lower() in ("id", "system_id", "place_id")
    ]
    if id_cols:
        ids = [r[id_cols[0]] for r in rows]
        if len(set(ids)) != len(ids):
            fail(f"source {sid}: duplicate id")


def configured_map_size(sources_cfg, overall_meta):
    """Получить размер координатной сетки из sources.json или meta.json."""
    containers = [sources_cfg, overall_meta]
    for container in containers:
        if not isinstance(container, dict):
            continue
        candidates = [container.get("mapSize"), container.get("map_size")]
        map_config = container.get("map")
        if isinstance(map_config, dict):
            candidates.extend(
                [map_config.get("mapSize"), map_config.get("size")]
            )
        if container is sources_cfg:
            for source in container.get("sources", []):
                if isinstance(source, dict):
                    candidates.extend(
                        [source.get("mapSize"), source.get("map_size")]
                    )
        for candidate in candidates:
            try:
                size = float(candidate)
            except (TypeError, ValueError):
                continue
            if math.isfinite(size) and size > 0:
                return size
    return None


def _nonempty_cell(value):
    return value is not None and str(value).strip() != ""


def _row_cell(row, column):
    if column is None:
        return None
    if column in row:
        return row[column]
    wanted = str(column).strip().lower()
    for key, value in row.items():
        if str(key).strip().lower() == wanted:
            return value
    return None


def _strict_id_column(role, fieldnames):
    columns = {}
    for field in fieldnames or []:
        normalized = str(field).strip().lower()
        if normalized:
            columns.setdefault(normalized, field)

    role = (role or "").lower()
    if role == "places":
        preferred = ("id",)
    elif role == "systems":
        preferred = ("id", "system_id")
    elif role == "planet_generation":
        preferred = ("place_id", "id")
    else:
        preferred = ("id", "system_id", "place_id")
    return next((columns[name] for name in preferred if name in columns), None)


def validate_strict_table(source_id, role, rows, fieldnames, map_size):
    """Вернуть все ошибки строгой проверки одной синхронизируемой таблицы."""
    try:
        map_size = float(map_size) if map_size is not None else None
    except (TypeError, ValueError):
        map_size = None
    if map_size is not None and not math.isfinite(map_size):
        map_size = None

    label = f"source {source_id}" + (f" ({role})" if role else "")
    errors = []
    id_column = _strict_id_column(role, fieldnames)
    seen_ids = {}
    x_column = next(
        (field for field in (fieldnames or []) if str(field).strip().lower() == "x"),
        None,
    )
    y_column = next(
        (field for field in (fieldnames or []) if str(field).strip().lower() == "y"),
        None,
    )
    system_id_column = next(
        (
            field
            for field in (fieldnames or [])
            if str(field).strip().lower() == "system_id"
        ),
        None,
    )

    has_coordinates = any(
        _nonempty_cell(_row_cell(row, column))
        for row in rows
        for column in (x_column, y_column)
    )
    if has_coordinates and map_size is None:
        errors.append(
            f"{label}: mapSize не задан или некорректен в data/sources.json "
            "и data/meta.json; нельзя проверить диапазон координат"
        )
    map_size_text = (
        str(int(map_size)) if map_size is not None and float(map_size).is_integer()
        else str(map_size)
    )

    for index, row in enumerate(rows, start=2):
        row_label = f"строка {index}"
        row_id = _row_cell(row, id_column)
        if _nonempty_cell(row_id):
            normalized_id = str(row_id).strip()
            if normalized_id in seen_ids:
                errors.append(
                    f"{label}: строки {seen_ids[normalized_id]} и {index}: "
                    f"дублирующийся непустой id «{normalized_id}»"
                )
            else:
                seen_ids[normalized_id] = index

        coordinates = {
            "x": _row_cell(row, x_column),
            "y": _row_cell(row, y_column),
        }
        for axis, raw_value in coordinates.items():
            if not _nonempty_cell(raw_value):
                continue
            text_value = str(raw_value).strip()
            try:
                number = float(text_value)
            except (TypeError, ValueError):
                errors.append(
                    f"{label}: {row_label}, поле {axis}: значение "
                    f"«{text_value}» не является числом"
                )
                continue
            if map_size is not None and (
                not math.isfinite(number) or number < 0 or number > map_size
            ):
                errors.append(
                    f"{label}: {row_label}, поле {axis}={text_value}: "
                    f"координата вне диапазона 0..{map_size_text}"
                )

        if (role or "").lower() == "places":
            system_id = _row_cell(row, system_id_column)
            if _nonempty_cell(system_id) and any(
                _nonempty_cell(value) for value in coordinates.values()
            ):
                x_value = (
                    "" if coordinates["x"] is None else str(coordinates["x"]).strip()
                )
                y_value = (
                    "" if coordinates["y"] is None else str(coordinates["y"]).strip()
                )
                errors.append(
                    f"{label}: {row_label}: system_id «{str(system_id).strip()}» "
                    "указан вместе с ручными координатами "
                    f"(x=«{x_value}», y=«{y_value}»); очистите system_id "
                    "или обе координаты"
                )

    return errors


def prepare_url_source(src, manifest, strict=False, map_size=None):
    """Скачать и нормализовать URL-источник, ничего не записывая в data/."""

    sid = src["id"]
    role = src.get("role")
    target = src.get("target", f"data/{sid}.csv")
    target_path = ROOT / target
    enabled = src.get("enabled", True) is not False

    if not enabled:
        print(f"== source {sid} (url, disabled)")
        fieldnames, rows = read_local_csv_dataset(target_path)
        strict_errors = (
            validate_strict_table(sid, role, rows, fieldnames, map_size)
            if strict
            else []
        )
        return {
            "id": sid,
            "role": role,
            "target": target,
            "target_path": target_path,
            "enabled": False,
            "sha": None,
            "text": None,
            "fieldnames": fieldnames,
            "rows": rows,
            "strict_errors": strict_errors,
        }

    url = src.get("url")
    if not url or "SPREADSHEET_ID" in url:
        fail(f"source {sid}: url not configured (still placeholder)")

    print(f"== source {sid} (url)")
    try:
        data, headers = http_get(url)  # сторонний адрес — без токена
    except Exception as e:
        fail(f"source {sid}: download failed: {e}")
    if len(data) == 0:
        fail(f"source {sid}: empty response")
    if looks_like_html(data, headers):
        fail(
            f"source {sid}: вместо CSV пришёл HTML — возможно, таблица не опубликована "
            "или ссылка требует доступа. Проверьте публикацию:\n"
            "1. Откройте таблицу и выберите Файл → Поделиться → Опубликовать в интернете.\n"
            "2. Выберите нужную вкладку и формат CSV, затем нажмите «Опубликовать».\n"
            "3. Откройте URL источника в окне инкогнито: должна загружаться CSV-выгрузка, "
            "а не страница входа или запроса доступа."
        )

    sha = hashlib.sha256(data).hexdigest()
    stored = manifest.get("sources", {}).get(sid, {}).get("sha")
    changed = stored != sha or not target_path.exists()
    if changed:
        print(f"   new content {sha[:7]}")
    else:
        print(f"   up to date ({sha[:7]})")

    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1251")
    first_line = next((ln for ln in text.splitlines() if ln.strip()), "")
    if "," not in first_line and ";" not in first_line and "\t" not in first_line:
        fail(f"source {sid}: ответ не похож на CSV — первая строка «{first_line[:60]}»")

    if role == "planet_generation":
        table = planet_generation.parse_csv_text(text)
        if table.errors:
            fail(
                f"source {sid}: структурные ошибки planet_generation:\n- "
                + "\n- ".join(table.errors)
            )
        fieldnames = table.fieldnames
        rows = [row.values for row in table.rows]
        transformed_text = planet_generation.serialize_profiles(rows)
    else:
        transformed_text, rows, fieldnames = transform_csv(
            text, src.get("transform", {}), None, None
        )

    if strict:
        strict_errors = validate_strict_table(
            sid, role, rows, fieldnames, map_size
        )
    else:
        strict_errors = []
        if role != "planet_generation":
            # Сохраняем прежнюю проверку дублей URL-источников в мягком режиме.
            check_unique_ids(sid, rows, fieldnames)

    return {
        "id": sid,
        "role": role,
        "target": target,
        "target_path": target_path,
        "enabled": True,
        "sha": sha,
        "text": transformed_text if changed else None,
        "fieldnames": fieldnames,
        "rows": rows,
        "strict_errors": strict_errors,
    }


def validate_prepared_url_datasets(prepared):
    """Проверить связи между подготовленными, но ещё не записанными CSV."""

    by_role = {}
    for item in prepared:
        role = item.get("role")
        if not role:
            continue
        if role in by_role:
            fail(f"data/sources.json: несколько URL-источников с role={role}")
        by_role[role] = item

    if "planet_generation" not in by_role:
        return None
    if "places" not in by_role:
        fail("data/sources.json: для planet_generation нужен URL-источник с role=places")

    result = planet_generation.validate_profiles(
        by_role["planet_generation"]["rows"],
        by_role["planet_generation"]["fieldnames"],
        by_role["places"]["rows"],
        by_role["places"]["fieldnames"],
    )
    for warning in result.warnings:
        print(f"WARNING: planet_generation: {warning}", file=sys.stderr)
    if result.errors:
        fail(
            "planet_generation validation failed; предыдущие снимки не изменены:\n- "
            + "\n- ".join(result.errors)
        )
    print(f"   planet_generation: OK ({len(result.profiles)} профилей)")
    return result


def apply_prepared_url_sources(prepared, manifest, overall_meta, enabled_source_ids):
    """Применить подготовленные URL-снимки одной группой с откатом при сбое."""

    changed = [item for item in prepared if item.get("text") is not None]
    if not changed:
        return manifest, overall_meta

    paths = [item["target_path"] for item in changed] + [META, MANIFEST]
    backups = {path: _backup_file(path) for path in paths}
    updated_manifest = copy.deepcopy(manifest)
    updated_meta = copy.deepcopy(overall_meta)
    generated_at = (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

    try:
        for item in changed:
            write_text_atomically(item["target_path"], item["text"])
            print(f"   wrote {item['target']} ({len(item['rows'])} rows)")
            updated_manifest.setdefault("sources", {})[item["id"]] = {
                "sha": item["sha"],
                "updatedAt": generated_at,
            }

        last = changed[-1]
        updated_meta.update(
            {
                "source": last["id"],
                "sha": last["sha"],
                "generatedAt": generated_at,
                "sources": enabled_source_ids,
            }
        )
        save_json(META, updated_meta)
        save_json(MANIFEST, updated_manifest)
    except Exception as e:
        for path in reversed(paths):
            _restore_file(path, backups[path])
        fail(f"failed to apply synced CSV snapshots; previous files restored: {e}")

    return updated_manifest, updated_meta


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Синхронизация данных карты")
    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "проверить числовые координаты и их диапазон, конфликты привязки "
            "places.system_id с координатами и дубли непустых ID"
        ),
    )
    return parser.parse_args([] if argv is None else argv)


def main(argv=None):
    args = parse_args(argv)
    strict = args.strict
    token = os.environ.get("GITHUB_TOKEN")
    sources_cfg = load_json(SOURCES)
    sources = sources_cfg.get("sources", [])
    if not sources:
        fail("no sources configured in data/sources.json")

    UPSTREAM.mkdir(parents=True, exist_ok=True)
    manifest = load_json(MANIFEST, {"sources": {}})

    overall_meta = load_json(META, {})
    map_size = configured_map_size(sources_cfg, overall_meta) if strict else None

    url_sources = [
        src for src in sources if src.get("type", "github") == "url"
    ]
    prepared_url_sources = [
        prepare_url_source(src, manifest, strict=strict, map_size=map_size)
        for src in url_sources
    ]
    if strict:
        strict_errors = [
            error
            for item in prepared_url_sources
            for error in item.get("strict_errors", [])
        ]
        if strict_errors:
            fail(
                "строгая проверка таблиц завершилась ошибками; снимки не изменены:\n- "
                + "\n- ".join(strict_errors)
            )
    validate_prepared_url_datasets(prepared_url_sources)
    enabled_source_ids = [
        src["id"] for src in sources if src.get("enabled", True) is not False
    ]
    manifest, overall_meta = apply_prepared_url_sources(
        prepared_url_sources, manifest, overall_meta, enabled_source_ids
    )

    for src in sources:
        sid = src["id"]
        src_type = src.get("type", "github")

        if src_type == "url":
            continue

        # github type
        repo = src["repo"]
        ref = src.get("ref", "main")
        if repo == "OWNER/REPO" or "/" not in repo:
            fail(f"source {sid}: repo not configured (still placeholder)")

        print(f"== source {sid} ({repo}@{ref})")
        try:
            sha = latest_sha(repo, ref, token)
        except Exception as e:
            fail(f"source {sid}: cannot get SHA: {e}")

        stored = manifest.get("sources", {}).get(sid, {}).get("sha")
        if stored == sha:
            print(f"   up to date ({sha[:7]})")
            continue

        print(f"   new sha {sha[:7]} (was { (stored or '-')[:7] })")

        # download files
        downloaded = {}
        for f in src.get("files", []):
            path = f["path"]
            role = f.get("role")
            url = f"{RAW}/{repo}/{ref}/{path}"
            try:
                data, headers = http_get(url, token)
            except Exception as e:
                fail(f"source {sid}: download failed {path}: {e}")
            max_bytes = src.get("image", {}).get("maxBytes", 100 * 1024 * 1024)
            if len(data) > max_bytes:
                fail(f"source {sid}: file too large {path}: {len(data)} > {max_bytes}")
            if len(data) == 0:
                fail(f"source {sid}: empty file {path}")
            downloaded[(path, role)] = data
            print(f"   downloaded {path} ({len(data)} bytes)")

        # find background image
        bg_entry = None
        for f in src.get("files", []):
            if f.get("role") == "background":
                bg_entry = f
        img_w = img_h = None
        bg_data = None
        if bg_entry:
            bg_data = downloaded[(bg_entry["path"], "background")]
            # ensure image
            try:
                img_w, img_h = image_dimensions(bg_data)
            except SystemExit:
                raise
            except Exception as e:
                fail(f"source {sid}: cannot read image dimensions: {e}")
            print(f"   image dimensions: {img_w}x{img_h}")

        # auto-convert placeholder: if PNG huge, note only (conversion not implemented in skeleton)
        img_cfg = src.get("image", {})
        if img_cfg.get("autoConvert") and bg_data and bg_data[:8] == b"\x89PNG\r\n\x1a\n":
            if img_w and img_w > img_cfg.get("maxEdge", 6000):
                print(f"   NOTE: PNG edge {img_w} > maxEdge; conversion to JPG not implemented in skeleton")

        # save original background to upstream
        if bg_entry and bg_data:
            ext = Path(bg_entry["path"]).suffix or ".bin"
            (UPSTREAM / f"{sid}{ext}").write_bytes(bg_data)

        # process CSV files
        for f in src.get("files", []):
            if f.get("role") not in ("sectors", "objects"):
                continue
            path = f["path"]
            data = downloaded[(path, f.get("role"))]
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                try:
                    text = data.decode("cp1251")
                except Exception:
                    fail(f"source {sid}: cannot decode CSV {path}")
            # detect separator
            first_line = text.splitlines()[0] if text.splitlines() else ""
            sep = ";" if first_line.count(";") > first_line.count(",") else ","
            if sep == ";":
                text = text.replace(";", ",")
            transformed_text, rows, fieldnames = transform_csv(text, src.get("transform", {}), img_w, img_h)
            validate_csv(rows, fieldnames, img_w, img_h)
            role = f.get("role")
            out_name = "sectors.csv" if role == "sectors" else "objects.csv"
            # save original
            (UPSTREAM / f"{sid}.csv").write_bytes(data)
            # save working (do not overwrite if validation failed — already validated)
            (DATA / out_name).write_text(transformed_text, encoding="utf-8")
            print(f"   wrote {out_name} ({len(rows)} rows)")

        # update meta.json for this source (single-source skeleton: overwrite)
        overall_meta.update({
            "source": sid,
            "sha": sha,
            "bounds": ([0, 0], [img_h, img_w]) if (img_w and img_h) else None,
            "image": {"width": img_w, "height": img_h},
            "generatedAt": None,
        })
        overall_meta["generatedAt"] = datetime.datetime.utcnow().isoformat() + "Z"
        save_json(META, overall_meta)

        # update manifest
        manifest.setdefault("sources", {})[sid] = {"sha": sha, "updatedAt": overall_meta["generatedAt"]}
        save_json(MANIFEST, manifest)
        print(f"   manifest updated")

    print("SYNC OK")


if __name__ == "__main__":
    main(sys.argv[1:])
