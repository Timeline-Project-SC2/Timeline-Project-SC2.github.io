#!/usr/bin/env python3
"""Сборка картинок сайта из исходников.

Исходники лежат в assets/src/ и в репозиторий публикации не попадают (pages.yml
их исключает). Из них этот скрипт делает то, что реально отдаётся в веб:

  1. Карта сектора → пирамида тайлов WebP 512×512 (уровни 1250 → 10 000)
     + assets/tiles.json (манифест) + assets/map-preview.webp (подложка на
     первый кадр и запасной вариант, если манифеста нет).
  2. Карта галактики → assets/galaxy-map-<ширина>.webp под srcset.
  3. Логотип прелоадера → assets/timeline-project-logo.webp.
  4. Макеты секторов → assets/<имя>.webp.
  5. data/meta.json получает mapSize и assets.hasRaster — по этому флагу
     app.js решает, запрашивать ли манифест тайлов.
  6. data/meta.json получает imageVersion — общий SHA-256 исходников картинок.
     Исходный HTML/JS этот скрипт больше не переписывает: версию к ссылкам на
     собранные картинки подставляет Vite-сборка публикации в .publish.

Запуск:

    pip install pillow
    python3 tools/build_assets.py            # собрать только устаревшее
    python3 tools/build_assets.py --force    # пересобрать всё
    python3 tools/build_assets.py --check    # только проверить актуальность

Свежесть определяется по SHA-256 исходника: хэш записан в манифест тайлов и в
.meta.json, поэтому после подмены исходника сборка сама понимает, что устарела.
"""
import argparse
import hashlib
import io
import json
import shutil
import sys
import time
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Не установлен Pillow. Поставьте: pip install pillow")

# исходник карты сектора 10 000×10 000 — больше стандартного лимита Pillow
Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "src"
ASSETS = ROOT / "assets"
TILES_DIR = ASSETS / "tiles"
META = ROOT / "data" / "meta.json"

# --- карта сектора -----------------------------------------------------------
SECTOR_SOURCE = "koprulu-sector.jpg"   # исходник, 10 000×10 000
TILE_SIZE = 512
TILE_LEVELS = [1250, 2500, 5000, 10000]
TILE_QUALITY = 82
PREVIEW_EDGE = 2500                    # подложка на первый кадр
PREVIEW_QUALITY = 82

# --- карта галактики ---------------------------------------------------------
GALAXY_SOURCE = "galaxy-map.jpg"
GALAXY_WIDTHS = [1200, 2000, 3000]     # под srcset; 3000 — исходник без ресайза, грузится при приближении
GALAXY_QUALITY = 82

# --- логотип и макеты --------------------------------------------------------
LOGO_SOURCE = "timeline-project-logo.png"
LOGO_EDGE = 600                        # показывается 278 px, запас на 2×
LOGO_QUALITY = 88                      # у логотипа прозрачность, качество выше

MACKETS = {
    "koprulu-macket": ("koprulu-macket.jpg", 300, 84),
    "ozd-macket": ("ozd-macket.png", 300, 84),
}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def save_webp(image, path, quality, method=6):
    """Сохраняет WebP и возвращает размер файла в байтах.

    method — степень сжатия: 6 даёт минимум размера, но заметно медленнее.
    Для сотен тайлов берём 4, для единичных картинок — 6.
    """
    buf = io.BytesIO()
    image.save(buf, "WEBP", quality=quality, method=method)
    data = buf.getvalue()
    path.write_bytes(data)
    return len(data)


def open_rgba(path):
    image = Image.open(path)
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA")
    return image


def resize_square(image, edge):
    if image.width == edge and image.height == edge:
        return image
    return image.resize((edge, edge), Image.LANCZOS)


def resize_by_width(image, width):
    if image.width == width:
        return image
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), Image.LANCZOS)


def human(num_bytes):
    if num_bytes >= 1 << 20:
        return f"{num_bytes / (1 << 20):.2f} МБ"
    return f"{num_bytes / 1024:.0f} КБ"


# -----------------------------------------------------------------------------

def build_tiles(force):
    """Пирамида тайлов карты сектора + манифест."""
    source = SRC / SECTOR_SOURCE
    if not source.exists():
        print(f"  ! нет исходника {source.relative_to(ROOT)} — пропуск")
        return 0

    manifest_path = ASSETS / "tiles.json"
    source_sha = sha256(source)
    if not force and manifest_path.exists():
        try:
            current = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
        if current.get("sourceSha256") == source_sha and TILES_DIR.exists():
            print(f"  = тайлы актуальны ({current.get('tiles', '?')} шт.)")
            return 0

    started = time.time()
    if TILES_DIR.exists():
        shutil.rmtree(TILES_DIR)

    image = Image.open(source)
    image = image.convert("RGB")
    print(f"  исходник {image.width}×{image.height}, {human(source.stat().st_size)}")

    levels = []
    total = 0
    count = 0
    # уровни считаем от маленького к большому: дешёвый ресайз от предыдущего
    for index, edge in enumerate(TILE_LEVELS):
        level_dir = TILES_DIR / str(index)
        level_dir.mkdir(parents=True, exist_ok=True)
        level = image.resize((edge, edge), Image.LANCZOS)
        cols = (edge + TILE_SIZE - 1) // TILE_SIZE
        rows = cols
        for col in range(cols):
            for row in range(rows):
                box = (
                    col * TILE_SIZE,
                    row * TILE_SIZE,
                    min((col + 1) * TILE_SIZE, edge),
                    min((row + 1) * TILE_SIZE, edge),
                )
                tile = level.crop(box)
                total += save_webp(tile, level_dir / f"{col}_{row}.webp", TILE_QUALITY, method=4)
                count += 1
        levels.append({
            "index": index,
            "width": edge,
            "height": edge,
            "cols": cols,
            "rows": rows,
        })
        print(f"    уровень {index}: {edge}×{edge}, {cols}×{rows} тайлов")

    # подложка пересобирается вместе с тайлами: исходник тот же
    preview_size = save_webp(
        resize_square(image, PREVIEW_EDGE), ASSETS / "map-preview.webp", PREVIEW_QUALITY
    )

    manifest = {
        "mapSize": image.width,
        "tileSize": TILE_SIZE,
        "dir": "/assets/tiles",
        "levels": levels,
        "tiles": count,
        "preview": "/assets/map-preview.webp",
        "version": source_sha[:8],
        "source": {"file": SECTOR_SOURCE, "sha256": source_sha},
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  + {count} тайлов, {human(total)} · подложка {human(preview_size)} · {time.time() - started:.0f} с")
    return total + preview_size


def build_galaxy(force):
    """Карта галактики в нескольких ширинах под srcset."""
    source = SRC / GALAXY_SOURCE
    if not source.exists():
        print(f"  ! нет исходника {source.relative_to(ROOT)} — пропуск")
        return 0

    outputs = [ASSETS / f"galaxy-map-{w}.webp" for w in GALAXY_WIDTHS]
    if not force and all(p.exists() for p in outputs):
        newest = max(p.stat().st_mtime for p in outputs)
        if newest >= source.stat().st_mtime:
            print("  = карта галактики актуальна")
            return 0

    image = Image.open(source).convert("RGB")
    total = 0
    for width, path in zip(GALAXY_WIDTHS, outputs):
        total += save_webp(resize_by_width(image, width), path, GALAXY_QUALITY)
    print(f"  + карта галактики {', '.join(str(w) for w in GALAXY_WIDTHS)} px, {human(total)}")
    return total


def build_logo(force):
    """Логотип прелоадера: показывается 278 px, держим запас на 2×."""
    source = SRC / LOGO_SOURCE
    if not source.exists():
        print(f"  ! нет исходника {source.relative_to(ROOT)} — пропуск")
        return 0

    out = ASSETS / "timeline-project-logo.webp"
    if not force and out.exists() and out.stat().st_mtime >= source.stat().st_mtime:
        print("  = логотип актуален")
        return 0

    image = open_rgba(source)
    size = save_webp(resize_square(image, LOGO_EDGE), out, LOGO_QUALITY)
    print(f"  + логотип {LOGO_EDGE}×{LOGO_EDGE}, {human(size)}")
    return size


def build_mackets(force):
    """Макеты секторов: иконки 48 px в шапке и 300 px в панелях."""
    total = 0
    for name, (src_name, edge, quality) in MACKETS.items():
        source = SRC / src_name
        if not source.exists():
            print(f"  ! нет исходника {source.relative_to(ROOT)} — пропуск")
            continue
        out = ASSETS / f"{name}.webp"
        if not force and out.exists() and out.stat().st_mtime >= source.stat().st_mtime:
            print(f"  = {name} актуален")
            continue
        image = open_rgba(source)
        if image.width > edge:
            height = max(1, round(image.height * edge / image.width))
            image = image.resize((edge, height), Image.LANCZOS)
        total += save_webp(image, out, quality)
        print(f"  + {name}.webp {image.width}×{image.height}")
    return total


def image_version():
    """Общая версия всех собранных картинок: меняется при замене любого исходника."""
    digest = hashlib.sha256()
    for path in sorted(p for p in SRC.iterdir() if p.is_file()):
        digest.update(path.name.encode("utf-8"))
        digest.update(sha256(path).encode("ascii"))
    return digest.hexdigest()[:8]


def update_meta(force):
    """meta.json: размер карты и флаг растра — по нему app.js берёт тайлы."""
    manifest_path = ASSETS / "tiles.json"
    if not manifest_path.exists():
        print("  ! нет манифеста тайлов — meta.json не тронут")
        return 0
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    meta = {}
    if META.exists():
        meta = json.loads(META.read_text(encoding="utf-8"))
    assets = dict(meta.get("assets") or {})
    wanted = {
        "hasRaster": True,
        "preview": manifest.get("preview"),
        "tiles": "/assets/tiles.json",
        "version": manifest.get("version"),
        "imageVersion": image_version(),
    }
    if not force and meta.get("mapSize") == manifest["mapSize"] and all(
        assets.get(k) == v for k, v in wanted.items()
    ):
        print("  = meta.json актуален")
        return 0

    meta["mapSize"] = manifest["mapSize"]
    assets.update(wanted)
    meta["assets"] = assets
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  + meta.json: mapSize={manifest['mapSize']}, hasRaster=true")
    return 0


STEPS = [
    ("Тайлы карты сектора", build_tiles),
    ("Карта галактики", build_galaxy),
    ("Логотип прелоадера", build_logo),
    ("Макеты секторов", build_mackets),
    ("meta.json", update_meta),
]


def check_fresh():
    """Проверяет, что собранные файлы не старше исходников. Ничего не пишет."""
    problems = []
    manifest_path = ASSETS / "tiles.json"
    sector = SRC / SECTOR_SOURCE
    if sector.exists():
        if not manifest_path.exists():
            problems.append("нет assets/tiles.json")
        else:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest.get("source", {}).get("sha256") != sha256(sector):
                problems.append(f"тайлы собраны из другого {SECTOR_SOURCE}")
            missing = sum(
                1 for level in manifest.get("levels", [])
                for col in range(level["cols"]) for row in range(level["rows"])
                if not (TILES_DIR / str(level["index"]) / f"{col}_{row}.webp").exists()
            )
            if missing:
                problems.append(f"не хватает {missing} тайлов")
    required = [
        ASSETS / "map-preview.webp",
        *(ASSETS / f"galaxy-map-{width}.webp" for width in GALAXY_WIDTHS),
        ASSETS / "timeline-project-logo.webp",
        *(ASSETS / f"{name}.webp" for name in MACKETS),
    ]
    for path in required:
        if not path.exists():
            problems.append(f"нет {path.relative_to(ROOT)}")
    return problems


def main():
    parser = argparse.ArgumentParser(description="Сборка картинок сайта из assets/src/")
    parser.add_argument("--force", action="store_true", help="пересобрать всё, игнорируя свежесть")
    parser.add_argument("--check", action="store_true", help="проверить свежесть, ничего не собирая")
    parser.add_argument("--sync-only", action="store_true", help="обновить meta.json по уже собранным картинкам")
    args = parser.parse_args()

    if not SRC.exists():
        sys.exit(f"Нет папки с исходниками: {SRC}")

    if args.sync_only:
        problems = check_fresh()
        if problems:
            print("Кэш изображений неполный:")
            for item in problems:
                print(f"  - {item}")
            sys.exit(1)
        print("Синхронизация meta.json по кэшированным изображениям")
        update_meta(False)
        print("Готово.")
        return

    if args.check:
        problems = check_fresh()
        if problems:
            print("Устарело:")
            for item in problems:
                print(f"  - {item}")
            sys.exit(1)
        print("Собранные картинки актуальны.")
        return

    print(f"Сборка картинок ({'принудительно' if args.force else 'по свежести'})")
    for title, step in STEPS:
        print(f"\n{title}")
        step(args.force)
    print("\nГотово.")


if __name__ == "__main__":
    main()
