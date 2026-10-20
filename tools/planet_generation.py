#!/usr/bin/env python3
"""Контракт данных генерации планет: профили, пресеты, ключ и валидатор.

Модуль является единственным источником истины для листа Google Sheets
``planet_generation`` и его снимка ``data/planet-generation.csv``:

* канонический заголовок из 37 колонок;
* стартовые пресеты и их раскрытые эффективные значения;
* проверка ссылок на ``places``, enum, чисел, процентилей и seed;
* эффективный географический манифест и ключ ``PG1-...``;
* CLI-прототип для seed, черновой строки, манифеста, ключа и freeze-строки.

Ключ считается только по географическому манифесту. Палитра, наклон оси и
период вращения относятся к отдельному render-манифесту и не меняют
``generation_key``. Редакционные поля (статус, кто и когда утвердил, заметка)
в географический манифест также не входят.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import re
import secrets
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from pathlib import Path
from typing import Any, Mapping


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILES = ROOT / "data" / "planet-generation.csv"
DEFAULT_PLACES = ROOT / "data" / "places.csv"

MANIFEST_FORMAT = "PG1"
SCHEMA_VERSION = "planet-generation-schema-v1"

# Текущие прототипные версии генератора. Они честно отражают состояние после
# спайка Этапа 1: адреса ячеек ещё v0, шум — planet-noise-spike-1, а контракт
# C100 пока v0. Боевые v1 появятся на Этапах 3–4; старые ключи при этом не
# пересчитываются молча, а потребуют новой ревизии профиля.
DEFAULT_VERSIONS = {
    "grid_version": "goldberg-gp-v0",
    "noise_version": "planet-noise-spike-1",
    "geography_version": "c100-soft-v0",
    "preset_version": "planet-presets-v0",
}
SUPPORTED_VERSIONS = {
    "grid_version": {DEFAULT_VERSIONS["grid_version"]},
    "noise_version": {DEFAULT_VERSIONS["noise_version"]},
    "geography_version": {DEFAULT_VERSIONS["geography_version"]},
    "preset_version": {DEFAULT_VERSIONS["preset_version"]},
}
VERSION_FIELDS = tuple(DEFAULT_VERSIONS)

FIELDS = [
    "place_id",
    "profile_status",
    "profile_revision",
    "preset_id",
    "surface_class",
    "radius_km",
    "axial_tilt_deg",
    "rotation_period_hours",
    "palette_id",
    "master_seed_hex",
    "grid_version",
    "noise_version",
    "geography_version",
    "preset_version",
    "generation_key",
    "approved_by",
    "approved_at",
    "continent_mean_cells",
    "continent_variation",
    "ocean_basin_mean_cells",
    "drainage_mean_cells",
    "ocean_pctl",
    "shelf_below_pctl",
    "shelf_above_pctl",
    "highland_land_pctl",
    "mountain_land_pctl",
    "arid_land_pctl",
    "wet_land_pctl",
    "cold_pctl",
    "hot_pctl",
    "stream_flow_pctl",
    "major_river_flow_pctl",
    "coast_soft_width_cells",
    "continent_soft_width_cells",
    "biome_soft_width_cells",
    "transition_entropy_pctl",
    "notes_admin",
]

PROFILE_STATUSES = {"draft", "review", "frozen", "disabled"}
SURFACE_CLASSES = {
    "terrestrial",
    "ocean",
    "desert",
    "ice",
    "volcanic",
    "barren",
    "gas_giant",
    "no_surface",
}
KNOWN_PLACE_TYPES = {"planet", "moon", "asteroid", "station", "platform", "other"}

TARGET_SCALE_FIELDS = [
    "continent_mean_cells",
    "continent_variation",
    "ocean_basin_mean_cells",
    "drainage_mean_cells",
]
PERCENTILE_FIELDS = [
    "ocean_pctl",
    "shelf_below_pctl",
    "shelf_above_pctl",
    "highland_land_pctl",
    "mountain_land_pctl",
    "arid_land_pctl",
    "wet_land_pctl",
    "cold_pctl",
    "hot_pctl",
    "stream_flow_pctl",
    "major_river_flow_pctl",
]
SOFT_WIDTH_FIELDS = [
    "coast_soft_width_cells",
    "continent_soft_width_cells",
    "biome_soft_width_cells",
]
GEOGRAPHY_NUMBER_FIELDS = (
    TARGET_SCALE_FIELDS + PERCENTILE_FIELDS + SOFT_WIDTH_FIELDS + ["transition_entropy_pctl"]
)

NUMBER_PRECISION = {
    "radius_km": 3,
    "axial_tilt_deg": 6,
    "rotation_period_hours": 6,
    "continent_mean_cells": 3,
    "continent_variation": 6,
    "ocean_basin_mean_cells": 3,
    "drainage_mean_cells": 3,
    **{name: 3 for name in PERCENTILE_FIELDS},
    **{name: 6 for name in SOFT_WIDTH_FIELDS},
    "transition_entropy_pctl": 3,
}

MAX_RADIUS_KM = Decimal("1000000000")
MAX_ROTATION_PERIOD_HOURS = Decimal("1000000000")
MAX_CELL_TARGET = Decimal("1000000000")
MAX_CONTINENT_VARIATION = Decimal("1000000")
MAX_SOFT_WIDTH_CELLS = Decimal("1000000")

NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
SEED_RE = re.compile(r"^[0-9a-fA-F]{16}$")
GENERATION_KEY_RE = re.compile(r"^PG1-[A-Z2-7]{26}$")
PALETTE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
VERSION_RE = re.compile(r"^\S+$")


def D(value: str) -> Decimal:
    return Decimal(value)


BASE_GEOGRAPHY: dict[str, Decimal] = {
    "continent_mean_cells": D("100"),
    "continent_variation": D("0.8"),
    "ocean_basin_mean_cells": D("1500"),
    "drainage_mean_cells": D("18"),
    "ocean_pctl": D("70"),
    "shelf_below_pctl": D("67"),
    "shelf_above_pctl": D("73"),
    "highland_land_pctl": D("75"),
    "mountain_land_pctl": D("92"),
    "arid_land_pctl": D("25"),
    "wet_land_pctl": D("75"),
    "cold_pctl": D("20"),
    "hot_pctl": D("80"),
    "stream_flow_pctl": D("90"),
    "major_river_flow_pctl": D("99"),
    "coast_soft_width_cells": D("1.5"),
    "continent_soft_width_cells": D("2.0"),
    "biome_soft_width_cells": D("1.0"),
    "transition_entropy_pctl": D("90"),
}


def _preset(
    description: str,
    palette_id: str,
    expected_surface_classes: set[str],
    **overrides: Decimal,
) -> dict[str, Any]:
    values = dict(BASE_GEOGRAPHY)
    values.update(overrides)
    return {
        "description": description,
        "palette_id": palette_id,
        "expected_surface_classes": set(expected_surface_classes),
        "values": values,
    }


PRESETS: dict[str, dict[str, Any]] = {
    "earthlike_balanced": _preset(
        "Сбалансированный землеподобный мир",
        "earthlike",
        {"terrestrial"},
    ),
    "earthlike_archipelago": _preset(
        "Землеподобный мир с фрагментированной сушей и архипелагами",
        "archipelago",
        {"terrestrial", "ocean"},
        continent_mean_cells=D("45"),
        continent_variation=D("1.0"),
        ocean_basin_mean_cells=D("1100"),
        drainage_mean_cells=D("12"),
        ocean_pctl=D("76"),
        shelf_below_pctl=D("72"),
        shelf_above_pctl=D("80"),
        highland_land_pctl=D("78"),
        mountain_land_pctl=D("94"),
        arid_land_pctl=D("22"),
        wet_land_pctl=D("72"),
        hot_pctl=D("78"),
        stream_flow_pctl=D("88"),
        major_river_flow_pctl=D("98.5"),
        coast_soft_width_cells=D("1.2"),
        continent_soft_width_cells=D("1.4"),
        biome_soft_width_cells=D("0.8"),
        transition_entropy_pctl=D("88"),
    ),
    "ocean_world": _preset(
        "Мир с преобладанием океана",
        "ocean",
        {"ocean", "terrestrial"},
        continent_mean_cells=D("25"),
        continent_variation=D("1.1"),
        ocean_basin_mean_cells=D("2500"),
        drainage_mean_cells=D("8"),
        ocean_pctl=D("90"),
        shelf_below_pctl=D("87"),
        shelf_above_pctl=D("93"),
        highland_land_pctl=D("80"),
        mountain_land_pctl=D("96"),
        arid_land_pctl=D("10"),
        wet_land_pctl=D("55"),
        cold_pctl=D("25"),
        hot_pctl=D("75"),
        stream_flow_pctl=D("92"),
        coast_soft_width_cells=D("2.0"),
        continent_soft_width_cells=D("1.0"),
        biome_soft_width_cells=D("1.2"),
    ),
    "desert_dry": _preset(
        "Сухой пустынный мир",
        "desert",
        {"desert", "barren"},
        continent_mean_cells=D("140"),
        continent_variation=D("0.7"),
        ocean_basin_mean_cells=D("500"),
        drainage_mean_cells=D("30"),
        ocean_pctl=D("25"),
        shelf_below_pctl=D("22"),
        shelf_above_pctl=D("28"),
        highland_land_pctl=D("70"),
        mountain_land_pctl=D("90"),
        arid_land_pctl=D("70"),
        wet_land_pctl=D("92"),
        cold_pctl=D("15"),
        hot_pctl=D("55"),
        stream_flow_pctl=D("97"),
        major_river_flow_pctl=D("99.5"),
        coast_soft_width_cells=D("0.8"),
        continent_soft_width_cells=D("2.5"),
        biome_soft_width_cells=D("0.7"),
        transition_entropy_pctl=D("85"),
    ),
    "ice_world": _preset(
        "Холодный ледяной мир",
        "ice",
        {"ice", "barren"},
        continent_mean_cells=D("120"),
        continent_variation=D("0.7"),
        ocean_basin_mean_cells=D("1200"),
        drainage_mean_cells=D("20"),
        ocean_pctl=D("55"),
        shelf_below_pctl=D("51"),
        shelf_above_pctl=D("59"),
        highland_land_pctl=D("70"),
        mountain_land_pctl=D("90"),
        arid_land_pctl=D("35"),
        wet_land_pctl=D("80"),
        cold_pctl=D("70"),
        hot_pctl=D("95"),
        stream_flow_pctl=D("94"),
        coast_soft_width_cells=D("1.2"),
        biome_soft_width_cells=D("0.8"),
        transition_entropy_pctl=D("88"),
    ),
    "volcanic_active": _preset(
        "Активный вулканический мир",
        "volcanic",
        {"volcanic", "barren"},
        continent_mean_cells=D("70"),
        continent_variation=D("1.2"),
        ocean_basin_mean_cells=D("900"),
        drainage_mean_cells=D("14"),
        ocean_pctl=D("45"),
        shelf_below_pctl=D("41"),
        shelf_above_pctl=D("49"),
        highland_land_pctl=D("60"),
        mountain_land_pctl=D("82"),
        arid_land_pctl=D("35"),
        wet_land_pctl=D("80"),
        cold_pctl=D("10"),
        hot_pctl=D("55"),
        stream_flow_pctl=D("94"),
        coast_soft_width_cells=D("0.7"),
        continent_soft_width_cells=D("1.2"),
        biome_soft_width_cells=D("0.7"),
        transition_entropy_pctl=D("92"),
    ),
    "barren_moon": _preset(
        "Безводная луна или мёртвый мир",
        "barren",
        {"barren"},
        continent_mean_cells=D("180"),
        continent_variation=D("0.6"),
        drainage_mean_cells=D("50"),
        ocean_pctl=D("0"),
        shelf_below_pctl=D("0"),
        shelf_above_pctl=D("0"),
        highland_land_pctl=D("65"),
        mountain_land_pctl=D("88"),
        arid_land_pctl=D("90"),
        wet_land_pctl=D("99"),
        cold_pctl=D("50"),
        hot_pctl=D("50"),
        stream_flow_pctl=D("100"),
        major_river_flow_pctl=D("100"),
        coast_soft_width_cells=D("0"),
        continent_soft_width_cells=D("1.0"),
        biome_soft_width_cells=D("0.5"),
        transition_entropy_pctl=D("80"),
    ),
    "gas_giant_bands": _preset(
        "Газовый гигант: только внешний облачный слой, без поверхности",
        "gas_giant",
        {"gas_giant"},
        continent_mean_cells=D("1"),
        continent_variation=D("0"),
        ocean_basin_mean_cells=D("1"),
        drainage_mean_cells=D("1"),
        ocean_pctl=D("0"),
        shelf_below_pctl=D("0"),
        shelf_above_pctl=D("0"),
        highland_land_pctl=D("100"),
        mountain_land_pctl=D("100"),
        arid_land_pctl=D("0"),
        wet_land_pctl=D("100"),
        cold_pctl=D("0"),
        hot_pctl=D("100"),
        stream_flow_pctl=D("100"),
        major_river_flow_pctl=D("100"),
        coast_soft_width_cells=D("0"),
        continent_soft_width_cells=D("0"),
        biome_soft_width_cells=D("0"),
        transition_entropy_pctl=D("0"),
    ),
}

DEFAULT_AXIAL_TILT_DEG = D("23.44")
DEFAULT_ROTATION_PERIOD_HOURS = D("24")


def _assert_contract() -> None:
    if len(FIELDS) != 37 or len(set(FIELDS)) != 37:
        raise RuntimeError("Схема planet_generation должна содержать ровно 37 уникальных колонок")
    expected = set(GEOGRAPHY_NUMBER_FIELDS)
    if set(BASE_GEOGRAPHY) != expected:
        raise RuntimeError("Базовый пресет не покрывает все географические числа")
    for preset_id, preset in PRESETS.items():
        if set(preset["values"]) != expected:
            raise RuntimeError(f"Пресет {preset_id} не покрывает все географические числа")


_assert_contract()


@dataclass
class CsvRow:
    line: int
    values: dict[str, str]


@dataclass
class CsvTable:
    fieldnames: list[str]
    rows: list[CsvRow]
    errors: list[str] = field(default_factory=list)


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    profiles: list[dict[str, Any]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def parse_csv_text(text: str) -> CsvTable:
    """Разобрать CSV, сохранив номера строк и структурные ошибки."""

    errors: list[str] = []
    rows: list[CsvRow] = []
    fieldnames: list[str] = []
    reader = csv.reader(io.StringIO(text.lstrip("\ufeff"), newline=""))
    try:
        header: list[str] | None = None
        for raw in reader:
            if not raw or all(str(cell).strip() == "" for cell in raw):
                continue
            header = [str(cell).strip() for cell in raw]
            break
        if header is None:
            return CsvTable([], [], ["CSV пустой: нет строки заголовков"])
        fieldnames = header
        seen: set[str] = set()
        duplicates: list[str] = []
        for name in fieldnames:
            if name in seen and name not in duplicates:
                duplicates.append(name)
            seen.add(name)
        if duplicates:
            errors.append("Дублирующиеся заголовки CSV: " + ", ".join(sorted(duplicates)))
        if any(name == "" for name in fieldnames):
            errors.append("В заголовке CSV есть пустая колонка")

        for raw in reader:
            line = reader.line_num
            if not raw or all(str(cell).strip() == "" for cell in raw):
                continue
            if len(raw) != len(fieldnames):
                errors.append(
                    f"Строка {line}: ожидалось {len(fieldnames)} полей, получено {len(raw)}"
                )
            padded = list(raw[: len(fieldnames)])
            if len(padded) < len(fieldnames):
                padded.extend([""] * (len(fieldnames) - len(padded)))
            values = {
                name: str(padded[index]).strip() for index, name in enumerate(fieldnames)
            }
            rows.append(CsvRow(line=line, values=values))
    except csv.Error as exc:
        errors.append(f"Ошибка разбора CSV: {exc}")
    return CsvTable(fieldnames=fieldnames, rows=rows, errors=errors)


def _row_values(row: CsvRow | Mapping[str, Any]) -> dict[str, str]:
    if isinstance(row, CsvRow):
        return dict(row.values)
    return {str(k): "" if v is None else str(v) for k, v in row.items()}


def _row_line(row: CsvRow | Mapping[str, Any], fallback: int) -> int:
    if isinstance(row, CsvRow):
        return row.line
    raw_line = row.get("_line")
    try:
        return int(raw_line) if raw_line is not None else fallback
    except (TypeError, ValueError):
        return fallback


def serialize_csv(
    fieldnames: list[str], rows: list[CsvRow | Mapping[str, Any]]
) -> str:
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        values = _row_values(row)
        writer.writerow({name: str(values.get(name, "") or "") for name in fieldnames})
    return out.getvalue()


def serialize_profiles(rows: list[CsvRow | Mapping[str, Any]]) -> str:
    return serialize_csv(FIELDS, rows)


def _quantize_number(field_name: str, value: Decimal) -> Decimal:
    precision = NUMBER_PRECISION[field_name]
    quantum = Decimal(1).scaleb(-precision)
    needed_precision = 50
    if value != 0:
        needed_precision = max(needed_precision, abs(value.adjusted()) + precision + 5)
    with localcontext() as context:
        context.prec = needed_precision
        result = value.quantize(quantum, rounding=ROUND_HALF_UP)
    if result == 0:
        result = abs(result)
    return result


def _display_value(raw: str) -> str:
    return raw if len(raw) <= 80 else raw[:77] + "..."


def _parse_decimal(
    raw: str,
    field_name: str,
    label: str,
    errors: list[str],
    *,
    minimum: Decimal | None = None,
    maximum: Decimal | None = None,
    exclusive_minimum: bool = False,
) -> Decimal | None:
    if raw == "":
        return None
    if not NUMBER_RE.fullmatch(raw):
        errors.append(
            f"{label}: поле {field_name} должно быть числом с точкой, получено «{_display_value(raw)}»"
        )
        return None
    try:
        value = Decimal(raw)
    except InvalidOperation:
        errors.append(
            f"{label}: поле {field_name} не удалось прочитать как число: «{_display_value(raw)}»"
        )
        return None
    if not value.is_finite():
        errors.append(f"{label}: поле {field_name} должно быть конечным числом")
        return None
    if minimum is not None:
        if exclusive_minimum and value <= minimum:
            errors.append(f"{label}: поле {field_name} должно быть > {minimum}")
            return None
        if not exclusive_minimum and value < minimum:
            errors.append(f"{label}: поле {field_name} должно быть >= {minimum}")
            return None
    if maximum is not None and value > maximum:
        errors.append(f"{label}: поле {field_name} должно быть <= {maximum}")
        return None
    return _quantize_number(field_name, value)


def _canonical_json_text(value: Any) -> str:
    if isinstance(value, Mapping):
        parts = []
        for key in sorted(str(k) for k in value.keys()):
            parts.append(
                json.dumps(key, ensure_ascii=False, separators=(",", ":"))
                + ":"
                + _canonical_json_text(value[key])
            )
        return "{" + ",".join(parts) + "}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical_json_text(v) for v in value) + "]"
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("Канонический JSON не допускает NaN/Infinity")
        return format(Decimal(str(value)), "f")
    if value is None:
        return "null"
    return json.dumps(str(value), ensure_ascii=False, separators=(",", ":"))


def canonical_json_bytes(value: Any) -> bytes:
    """Канонический JSON PG1: UTF-8, сортировка ключей, фиксированная точность Decimal."""

    return _canonical_json_text(value).encode("utf-8")


def _json_ready(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _json_ready(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_ready(v) for v in value]
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return value


def generate_seed_hex() -> str:
    """Сгенерировать публичный, но непредсказуемый unsigned 64-bit seed."""

    return secrets.token_bytes(8).hex()


def build_geography_manifest(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Собрать географический манифест из эффективного профиля."""

    if profile.get("radius_km") is None:
        raise ValueError("Для манифеста нужен radius_km")
    if not profile.get("master_seed_hex"):
        raise ValueError("Для манифеста нужен master_seed_hex")
    manifest: dict[str, Any] = {
        "manifest_format": MANIFEST_FORMAT,
        "schema_version": SCHEMA_VERSION,
        "place_id": str(profile["place_id"]),
        "profile_revision": int(profile["profile_revision"]),
        "preset_id": str(profile["preset_id"]),
        "surface_class": str(profile["surface_class"]),
        "radius_km": profile["radius_km"],
        "master_seed_hex": str(profile["master_seed_hex"]).lower(),
    }
    for name in VERSION_FIELDS:
        manifest[name] = str(profile.get(name) or DEFAULT_VERSIONS[name])
    for name in GEOGRAPHY_NUMBER_FIELDS:
        value = profile.get(name)
        if value is None:
            raise ValueError(f"В эффективном профиле не раскрыто поле {name}")
        manifest[name] = value
    return manifest


def build_render_manifest(profile: Mapping[str, Any]) -> dict[str, Any]:
    """Отдельный render-манифест: смена этих полей не меняет местность."""

    return {
        "place_id": str(profile["place_id"]),
        "palette_id": str(profile.get("palette_id") or ""),
        "axial_tilt_deg": profile.get("axial_tilt_deg"),
        "rotation_period_hours": profile.get("rotation_period_hours"),
    }


def compute_generation_key(profile: Mapping[str, Any]) -> str:
    """PG1 + Base32 без padding от первых 128 бит SHA-256 манифеста."""

    digest = hashlib.sha256(canonical_json_bytes(build_geography_manifest(profile))).digest()
    token = base64.b32encode(digest[:16]).decode("ascii").rstrip("=")
    return f"{MANIFEST_FORMAT}-{token}"


def _places_by_id(
    rows: list[CsvRow | Mapping[str, Any]],
    fieldnames: list[str],
    errors: list[str],
    warnings: list[str],
) -> dict[str, str]:
    header_by_lower = {name.strip().lower(): name for name in fieldnames}
    id_field = header_by_lower.get("id") or header_by_lower.get("place_id")
    if not id_field:
        errors.append("places: не найдена ID-колонка (ID/id/place_id)")
        return {}
    type_field = header_by_lower.get("type")
    if not type_field:
        warnings.append("places: колонки type нет; все места трактуются как planet")

    result: dict[str, str] = {}
    for index, row in enumerate(rows):
        line = _row_line(row, index + 2)
        values = _row_values(row)
        place_id = str(values.get(id_field, "") or "").strip()
        if not place_id:
            if any(str(v).strip() for v in values.values()):
                errors.append(f"places, строка {line}: пустой ID")
            continue
        if place_id in result:
            errors.append(f"places, строка {line}: дублирующийся ID «{place_id}»")
            continue
        raw_type = str(values.get(type_field, "") or "").strip().lower() if type_field else ""
        place_type = "planet" if raw_type in ("", "none") else raw_type
        result[place_id] = place_type
    return result


def _parse_profile(
    row: CsvRow | Mapping[str, Any],
    fallback_line: int,
    places_by_id: dict[str, str],
    seen_place_ids: set[str],
    errors: list[str],
    warnings: list[str],
) -> dict[str, Any]:
    line = _row_line(row, fallback_line)
    source = _row_values(row)
    raw = {name: str(source.get(name, "") or "").strip() for name in FIELDS}
    place_id = raw["place_id"]
    label = f"Строка {line}" + (f" (place_id={place_id})" if place_id else "")

    effective: dict[str, Any] = {"_line": line, "_raw": dict(raw)}
    effective.update(raw)

    for name in ("place_id", "profile_status", "profile_revision", "preset_id", "surface_class"):
        if raw[name] == "":
            errors.append(f"{label}: обязательно поле {name}")

    if place_id:
        if place_id in seen_place_ids:
            errors.append(f"{label}: дублирующийся профиль для place_id")
        seen_place_ids.add(place_id)

    status = raw["profile_status"]
    if status and status not in PROFILE_STATUSES:
        errors.append(
            f"{label}: profile_status должен быть одним из {sorted(PROFILE_STATUSES)}, получено «{status}»"
        )

    surface_class = raw["surface_class"]
    if surface_class and surface_class not in SURFACE_CLASSES:
        errors.append(
            f"{label}: surface_class должен быть одним из {sorted(SURFACE_CLASSES)}, получено «{surface_class}»"
        )

    revision: int | None = None
    if raw["profile_revision"]:
        if not re.fullmatch(r"\d{1,9}", raw["profile_revision"]):
            errors.append(
                f"{label}: profile_revision должен быть целым числом от 1 до 999999999"
            )
        else:
            revision = int(raw["profile_revision"])
            if revision < 1:
                errors.append(f"{label}: profile_revision должен быть >= 1")
                revision = None
    effective["profile_revision"] = revision if revision is not None else 0

    place_type: str | None = None
    if place_id:
        if place_id not in places_by_id:
            errors.append(f"{label}: place_id отсутствует в places")
        else:
            place_type = places_by_id[place_id]
            effective["_place_type"] = place_type
            if place_type not in KNOWN_PLACE_TYPES:
                errors.append(f"{label}: неподдерживаемый places.type «{place_type}»")
            elif place_type in {"station", "platform"}:
                errors.append(f"{label}: профиль поверхности нельзя создавать для типа {place_type}")
            elif place_type == "asteroid":
                errors.append(
                    f"{label}: профили астероидов не входят в MVP Этапа 2; нужен отдельный упрощённый контракт"
                )
            elif place_type == "other":
                warnings.append(
                    f"{label}: профиль для places.type=other принят как ручное указание тела с поверхностью"
                )

    preset_id = raw["preset_id"]
    preset = PRESETS.get(preset_id)
    if preset_id and preset is None:
        errors.append(
            f"{label}: неизвестный preset_id «{preset_id}»; допустимы: {', '.join(sorted(PRESETS))}"
        )

    if surface_class == "no_surface" and status != "disabled":
        errors.append(
            f"{label}: surface_class=no_surface допустим только при profile_status=disabled"
        )
    if surface_class == "gas_giant" and preset_id and preset_id != "gas_giant_bands":
        errors.append(f"{label}: для gas_giant нужен preset_id=gas_giant_bands")
    if (
        preset_id == "gas_giant_bands"
        and surface_class not in {"gas_giant", "no_surface"}
        and surface_class
    ):
        errors.append(
            f"{label}: preset_id=gas_giant_bands допустим только для surface_class=gas_giant"
        )
    if preset is not None and surface_class in SURFACE_CLASSES and surface_class != "no_surface":
        expected = set(preset["expected_surface_classes"])
        if surface_class not in expected:
            warnings.append(
                f"{label}: preset_id={preset_id} обычно используют для {sorted(expected)}, "
                f"а указан surface_class={surface_class}"
            )

    # Физические и render-поля.
    radius = _parse_decimal(
        raw["radius_km"],
        "radius_km",
        label,
        errors,
        minimum=D("0"),
        maximum=MAX_RADIUS_KM,
        exclusive_minimum=True,
    )
    effective["radius_km"] = radius

    axial = _parse_decimal(
        raw["axial_tilt_deg"],
        "axial_tilt_deg",
        label,
        errors,
        minimum=D("0"),
        maximum=D("180"),
    )
    effective["axial_tilt_deg"] = (
        axial if axial is not None else _quantize_number("axial_tilt_deg", DEFAULT_AXIAL_TILT_DEG)
    )

    rotation = _parse_decimal(
        raw["rotation_period_hours"],
        "rotation_period_hours",
        label,
        errors,
        minimum=D("0"),
        maximum=MAX_ROTATION_PERIOD_HOURS,
        exclusive_minimum=True,
    )
    effective["rotation_period_hours"] = (
        rotation
        if rotation is not None
        else _quantize_number("rotation_period_hours", DEFAULT_ROTATION_PERIOD_HOURS)
    )

    if raw["palette_id"] and not PALETTE_RE.fullmatch(raw["palette_id"]):
        errors.append(
            f"{label}: palette_id должен быть кодом без пробелов, получено «{raw['palette_id']}»"
        )
    effective["palette_id"] = raw["palette_id"] or (preset["palette_id"] if preset else "")

    seed = raw["master_seed_hex"]
    seed_valid = False
    if seed:
        if SEED_RE.fullmatch(seed):
            seed_valid = True
            effective["master_seed_hex"] = seed.lower()
        else:
            errors.append(
                f"{label}: master_seed_hex должен содержать ровно 16 hex-цифр, получено «{seed}»"
            )
            effective["master_seed_hex"] = ""
    else:
        effective["master_seed_hex"] = ""

    for name in VERSION_FIELDS:
        version = raw[name]
        if version:
            if not VERSION_RE.fullmatch(version):
                errors.append(f"{label}: {name} не должен содержать пробелы")
            elif version not in SUPPORTED_VERSIONS[name]:
                errors.append(
                    f"{label}: неподдерживаемая {name}=«{version}»; поддерживаются: "
                    + ", ".join(sorted(SUPPORTED_VERSIONS[name]))
                )
        effective[name] = version or DEFAULT_VERSIONS[name]

    if "\n" in raw["notes_admin"] or "\r" in raw["notes_admin"]:
        errors.append(f"{label}: notes_admin не должен содержать переносы строк")

    # Географические числа: пустая ячейка раскрывается из пресета.
    if preset is not None:
        for name in GEOGRAPHY_NUMBER_FIELDS:
            if name in PERCENTILE_FIELDS or name == "transition_entropy_pctl":
                parsed = _parse_decimal(
                    raw[name], name, label, errors, minimum=D("0"), maximum=D("100")
                )
            elif name in SOFT_WIDTH_FIELDS:
                parsed = _parse_decimal(
                    raw[name],
                    name,
                    label,
                    errors,
                    minimum=D("0"),
                    maximum=MAX_SOFT_WIDTH_CELLS,
                )
            elif name == "continent_variation":
                parsed = _parse_decimal(
                    raw[name],
                    name,
                    label,
                    errors,
                    minimum=D("0"),
                    maximum=MAX_CONTINENT_VARIATION,
                )
            else:
                parsed = _parse_decimal(
                    raw[name],
                    name,
                    label,
                    errors,
                    minimum=D("0"),
                    maximum=MAX_CELL_TARGET,
                    exclusive_minimum=True,
                )
            effective[name] = (
                parsed
                if parsed is not None
                else _quantize_number(name, Decimal(preset["values"][name]))
            )

        def check_order(left: str, middle_or_right: str, right: str | None = None) -> None:
            if right is None:
                if effective[left] > effective[middle_or_right]:
                    errors.append(
                        f"{label}: требуется {left} <= {middle_or_right} "
                        f"({effective[left]} > {effective[middle_or_right]})"
                    )
            else:
                if not (effective[left] <= effective[middle_or_right] <= effective[right]):
                    errors.append(
                        f"{label}: требуется {left} <= {middle_or_right} <= {right} "
                        f"({effective[left]} <= {effective[middle_or_right]} <= {effective[right]} не выполнено)"
                    )

        check_order("shelf_below_pctl", "ocean_pctl", "shelf_above_pctl")
        check_order("highland_land_pctl", "mountain_land_pctl")
        check_order("arid_land_pctl", "wet_land_pctl")
        check_order("cold_pctl", "hot_pctl")
        check_order("stream_flow_pctl", "major_river_flow_pctl")

        if effective["continent_variation"] > D("3"):
            warnings.append(f"{label}: continent_variation > 3 — необычно большой разброс")
        for name in SOFT_WIDTH_FIELDS:
            if effective[name] > D("20"):
                warnings.append(f"{label}: {name} > 20 ячеек — очень широкий переход")
    else:
        for name in GEOGRAPHY_NUMBER_FIELDS:
            effective[name] = None

    approved_at = raw["approved_at"]
    if approved_at:
        try:
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", approved_at):
                date.fromisoformat(approved_at)
            else:
                datetime.fromisoformat(approved_at.replace("Z", "+00:00"))
        except ValueError:
            errors.append(
                f"{label}: approved_at должен быть ISO-датой/временем, получено «{approved_at}»"
            )

    if status == "review":
        if radius is None:
            warnings.append(f"{label}: review без radius_km ещё нельзя заморозить")
        if not seed:
            warnings.append(f"{label}: review без master_seed_hex ещё нельзя заморозить")

    if status == "frozen":
        if surface_class == "no_surface":
            errors.append(f"{label}: no_surface нельзя замораживать как сгенерированную поверхность")
        if radius is None:
            errors.append(f"{label}: для frozen обязателен radius_km")
        if not seed:
            errors.append(f"{label}: для frozen обязателен master_seed_hex")
        for name in VERSION_FIELDS:
            if not raw[name]:
                errors.append(f"{label}: для frozen обязательно явно указать {name}")
        if not raw["approved_by"]:
            errors.append(f"{label}: для frozen обязателен approved_by")
        if not raw["approved_at"]:
            errors.append(f"{label}: для frozen обязателен approved_at")
        if not raw["generation_key"]:
            errors.append(f"{label}: для frozen обязателен generation_key")

    generation_key = raw["generation_key"]
    can_compute_key = bool(
        place_id
        and revision is not None
        and preset is not None
        and surface_class in SURFACE_CLASSES
        and radius is not None
        and seed_valid
    )
    if generation_key:
        if not GENERATION_KEY_RE.fullmatch(generation_key):
            errors.append(
                f"{label}: generation_key должен иметь вид PG1-<26 символов Base32>, получено «{generation_key}»"
            )
        elif surface_class == "no_surface":
            errors.append(
                f"{label}: у no_surface не должно быть generation_key; очистите служебное поле"
            )
        elif not can_compute_key:
            errors.append(
                f"{label}: generation_key задан, но его нельзя проверить без корректных "
                "place_id/profile_revision/preset_id/surface_class/radius_km/master_seed_hex"
            )
        else:
            expected_key = compute_generation_key(effective)
            if generation_key != expected_key:
                errors.append(
                    f"{label}: generation_key не соответствует эффективному манифесту; "
                    f"ожидается {expected_key}"
                )

    return effective


def validate_profiles(
    profile_rows: list[CsvRow | Mapping[str, Any]],
    profile_fieldnames: list[str],
    places_rows: list[CsvRow | Mapping[str, Any]],
    places_fieldnames: list[str],
) -> ValidationResult:
    """Проверить профили против снимка places и вернуть эффективные профили."""

    errors: list[str] = []
    warnings: list[str] = []

    duplicates = sorted(
        {name for name in profile_fieldnames if profile_fieldnames.count(name) > 1}
    )
    if duplicates:
        errors.append("planet_generation: дублирующиеся заголовки: " + ", ".join(duplicates))
    missing = [name for name in FIELDS if name not in profile_fieldnames]
    extra = [name for name in profile_fieldnames if name not in FIELDS]
    if missing:
        errors.append("planet_generation: отсутствуют колонки: " + ", ".join(missing))
    if extra:
        errors.append("planet_generation: неизвестные колонки: " + ", ".join(extra))

    places_by_id = _places_by_id(places_rows, places_fieldnames, errors, warnings)
    seen: set[str] = set()
    profiles: list[dict[str, Any]] = []
    for index, row in enumerate(profile_rows):
        profiles.append(
            _parse_profile(row, index + 2, places_by_id, seen, errors, warnings)
        )
    return ValidationResult(errors=errors, warnings=warnings, profiles=profiles)


def validate_csv_texts(profile_text: str, places_text: str) -> ValidationResult:
    profiles = parse_csv_text(profile_text)
    places = parse_csv_text(places_text)
    result = validate_profiles(
        profiles.rows,
        profiles.fieldnames,
        places.rows,
        places.fieldnames,
    )
    result.errors = (
        [f"planet_generation: {e}" for e in profiles.errors]
        + [f"places: {e}" for e in places.errors]
        + result.errors
    )
    return result


def read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def validate_csv_files(profiles_path: Path, places_path: Path) -> ValidationResult:
    return validate_csv_texts(read_text_file(profiles_path), read_text_file(places_path))


def make_draft_row(
    place_id: str,
    preset_id: str = "earthlike_balanced",
    surface_class: str = "terrestrial",
    radius_km: str | None = None,
    seed_hex: str | None = None,
    *,
    include_seed: bool = True,
) -> dict[str, str]:
    row = {name: "" for name in FIELDS}
    row.update(
        {
            "place_id": str(place_id),
            "profile_status": "draft",
            "profile_revision": "1",
            "preset_id": preset_id,
            "surface_class": surface_class,
        }
    )
    if radius_km not in (None, ""):
        row["radius_km"] = str(radius_km)
    if seed_hex:
        row["master_seed_hex"] = seed_hex.lower()
    elif include_seed:
        row["master_seed_hex"] = generate_seed_hex()
    return row


def prepare_freeze_row(
    source_row: Mapping[str, Any],
    approved_by: str,
    approved_at: str | None = None,
    seed_hex: str | None = None,
) -> dict[str, str]:
    """Подготовить полную frozen-строку, не изменяя исходный CSV."""

    source = _row_values(source_row)
    row = {name: str(source.get(name, "") or "").strip() for name in FIELDS}
    row["profile_status"] = "frozen"
    if seed_hex:
        row["master_seed_hex"] = seed_hex.lower()
    elif not row["master_seed_hex"]:
        row["master_seed_hex"] = generate_seed_hex()
    for name in VERSION_FIELDS:
        if not row[name]:
            row[name] = DEFAULT_VERSIONS[name]
    row["approved_by"] = approved_by
    row["approved_at"] = approved_at or datetime.now(timezone.utc).date().isoformat()

    # Для самого ключа тип места не нужен; полная проверка против places
    # выполняется вызывающим кодом до выдачи строки администратору.
    errors: list[str] = []
    warnings: list[str] = []
    effective = _parse_profile(
        row,
        2,
        {row["place_id"]: "planet"} if row["place_id"] else {},
        set(),
        errors,
        warnings,
    )
    # generation_key в исходнике может быть пустым/устаревшим: это не мешает
    # вычислить новый, остальные ошибки входной строки блокируют freeze.
    blocking = [e for e in errors if "generation_key" not in e]
    if blocking:
        raise ValueError("\n".join(blocking))
    row["generation_key"] = compute_generation_key(effective)
    return row


def _load_tables(
    profiles_path: Path, places_path: Path
) -> tuple[CsvTable, CsvTable, ValidationResult]:
    profiles = parse_csv_text(read_text_file(profiles_path))
    places = parse_csv_text(read_text_file(places_path))
    result = validate_profiles(
        profiles.rows,
        profiles.fieldnames,
        places.rows,
        places.fieldnames,
    )
    result.errors = (
        [f"planet_generation: {e}" for e in profiles.errors]
        + [f"places: {e}" for e in places.errors]
        + result.errors
    )
    return profiles, places, result


def _print_result(result: ValidationResult) -> None:
    for warning in result.warnings:
        print(f"WARNING: {warning}", file=sys.stderr)
    for error in result.errors:
        print(f"ERROR: {error}", file=sys.stderr)


def _find_profile(result: ValidationResult, place_id: str) -> dict[str, Any]:
    for profile in result.profiles:
        if str(profile.get("place_id")) == str(place_id):
            return profile
    raise ValueError(f"Профиль place_id={place_id} не найден")


def _cmd_validate(args: argparse.Namespace) -> int:
    try:
        result = validate_csv_files(args.profiles, args.places)
    except OSError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    _print_result(result)
    if result.errors or (args.warnings_as_errors and result.warnings):
        return 1
    print(
        f"OK: профилей проверено: {len(result.profiles)}; "
        f"предупреждений: {len(result.warnings)}"
    )
    return 0


def _cmd_seed(_args: argparse.Namespace) -> int:
    print(generate_seed_hex())
    return 0


def _cmd_header(_args: argparse.Namespace) -> int:
    print(",".join(FIELDS))
    return 0


def _cmd_presets(args: argparse.Namespace) -> int:
    if args.json:
        payload = {
            preset_id: {
                "description": preset["description"],
                "palette_id": preset["palette_id"],
                "expected_surface_classes": sorted(preset["expected_surface_classes"]),
                "values": preset["values"],
            }
            for preset_id, preset in PRESETS.items()
        }
        print(json.dumps(_json_ready(payload), ensure_ascii=False, indent=2, sort_keys=True))
    else:
        for preset_id, preset in PRESETS.items():
            print(f"{preset_id}\t{preset['description']}")
    return 0


def _cmd_draft_row(args: argparse.Namespace) -> int:
    row = make_draft_row(
        args.place_id,
        preset_id=args.preset,
        surface_class=args.surface_class,
        radius_km=args.radius_km,
        seed_hex=args.seed,
        include_seed=not args.no_seed,
    )
    try:
        places = parse_csv_text(read_text_file(args.places))
    except OSError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    result = validate_profiles([row], FIELDS, places.rows, places.fieldnames)
    result.errors = [f"places: {e}" for e in places.errors] + result.errors
    _print_result(result)
    if result.errors:
        return 1
    rows = [row]
    if args.header:
        sys.stdout.write(serialize_profiles(rows))
    else:
        out = io.StringIO(newline="")
        writer = csv.DictWriter(out, fieldnames=FIELDS, lineterminator="\n")
        writer.writerow(row)
        sys.stdout.write(out.getvalue())
    return 0


def _load_valid_profile(args: argparse.Namespace) -> dict[str, Any]:
    _profiles, _places, result = _load_tables(args.profiles, args.places)
    _print_result(result)
    if result.errors:
        raise ValueError("Входные CSV не проходят валидацию")
    return _find_profile(result, args.place_id)


def _cmd_manifest(args: argparse.Namespace) -> int:
    try:
        profile = _load_valid_profile(args)
        payload = {
            "geography_manifest": build_geography_manifest(profile),
            "render_manifest": build_render_manifest(profile),
            "generation_key": compute_generation_key(profile),
        }
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(_json_ready(payload), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def _cmd_key(args: argparse.Namespace) -> int:
    try:
        profile = _load_valid_profile(args)
        key = compute_generation_key(profile)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    if args.format == "key":
        print(key)
    elif args.format == "tsv":
        values = [profile["master_seed_hex"]] + [profile[name] for name in VERSION_FIELDS] + [key]
        print("\t".join(str(v) for v in values))
    else:
        payload = {
            "place_id": profile["place_id"],
            "master_seed_hex": profile["master_seed_hex"],
            **{name: profile[name] for name in VERSION_FIELDS},
            "generation_key": key,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def _cmd_freeze_row(args: argparse.Namespace) -> int:
    try:
        profiles, places, _result = _load_tables(args.profiles, args.places)
        if profiles.errors or places.errors:
            for error in profiles.errors:
                print(f"ERROR: planet_generation: {error}", file=sys.stderr)
            for error in places.errors:
                print(f"ERROR: places: {error}", file=sys.stderr)
            return 2
        matches = [
            row for row in profiles.rows if row.values.get("place_id") == str(args.place_id)
        ]
        if not matches:
            raise ValueError(f"Профиль place_id={args.place_id} не найден")
        if len(matches) > 1:
            raise ValueError(f"Для place_id={args.place_id} найдено несколько профилей")
        frozen = prepare_freeze_row(
            matches[0],
            approved_by=args.approved_by,
            approved_at=args.approved_at,
            seed_hex=args.seed,
        )
        updated_rows: list[CsvRow | Mapping[str, Any]] = []
        for row in profiles.rows:
            updated_rows.append(frozen if row is matches[0] else row)
        result = validate_profiles(
            updated_rows,
            FIELDS,
            places.rows,
            places.fieldnames,
        )
        _print_result(result)
        if result.errors:
            return 1
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.output:
        args.output.write_text(serialize_profiles(updated_rows), encoding="utf-8")
        print(f"OK: обновлённый CSV записан в {args.output}", file=sys.stderr)
    if args.header:
        sys.stdout.write(serialize_profiles([frozen]))
    else:
        out = io.StringIO(newline="")
        writer = csv.DictWriter(out, fieldnames=FIELDS, lineterminator="\n")
        writer.writerow(frozen)
        sys.stdout.write(out.getvalue())
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Профили генерации планет: валидация, seed, манифест и generation_key"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate", help="проверить planet_generation против places")
    p_validate.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    p_validate.add_argument("--places", type=Path, default=DEFAULT_PLACES)
    p_validate.add_argument("--warnings-as-errors", action="store_true")
    p_validate.set_defaults(func=_cmd_validate)

    p_seed = sub.add_parser("seed", help="сгенерировать master_seed_hex")
    p_seed.set_defaults(func=_cmd_seed)

    p_header = sub.add_parser("header", help="напечатать канонический заголовок")
    p_header.set_defaults(func=_cmd_header)

    p_presets = sub.add_parser("presets", help="показать пресеты и их значения")
    p_presets.add_argument("--json", action="store_true")
    p_presets.set_defaults(func=_cmd_presets)

    p_draft = sub.add_parser("draft-row", help="сформировать черновую CSV-строку")
    p_draft.add_argument("--places", type=Path, default=DEFAULT_PLACES)
    p_draft.add_argument("--place-id", required=True)
    p_draft.add_argument("--preset", choices=sorted(PRESETS), default="earthlike_balanced")
    p_draft.add_argument("--surface-class", choices=sorted(SURFACE_CLASSES), default="terrestrial")
    p_draft.add_argument("--radius-km")
    p_draft.add_argument("--seed")
    p_draft.add_argument("--no-seed", action="store_true")
    p_draft.add_argument("--header", action="store_true")
    p_draft.set_defaults(func=_cmd_draft_row)

    for command, func, help_text in (
        ("manifest", _cmd_manifest, "показать эффективный манифест профиля"),
        ("key", _cmd_key, "вычислить generation_key профиля"),
    ):
        p = sub.add_parser(command, help=help_text)
        p.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
        p.add_argument("--places", type=Path, default=DEFAULT_PLACES)
        p.add_argument("--place-id", required=True)
        if command == "key":
            p.add_argument("--format", choices=("json", "key", "tsv"), default="json")
        p.set_defaults(func=func)

    p_freeze = sub.add_parser(
        "freeze-row",
        help="подготовить полную frozen-строку для вставки в Google Sheets",
    )
    p_freeze.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    p_freeze.add_argument("--places", type=Path, default=DEFAULT_PLACES)
    p_freeze.add_argument("--place-id", required=True)
    p_freeze.add_argument("--approved-by", required=True)
    p_freeze.add_argument("--approved-at")
    p_freeze.add_argument("--seed")
    p_freeze.add_argument("--header", action="store_true")
    p_freeze.add_argument("--output", type=Path, help="опционально записать весь обновлённый CSV")
    p_freeze.set_defaults(func=_cmd_freeze_row)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
