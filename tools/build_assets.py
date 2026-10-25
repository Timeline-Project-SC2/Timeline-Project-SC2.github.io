#!/usr/bin/env python3
"""Сборка картинок сайта из исходников.

Исходники лежат в assets/src/ и в репозиторий публикации не попадают (pages.yml
их исключает). Из них этот скрипт делает то, что реально отдаётся в веб:

  1. Карта галактики → assets/galaxy-map-<ширина>.webp под srcset.
  2. Логотип прелоадера → assets/timeline-project-logo.webp.
  3. Макеты секторов → assets/<имя>.webp.
  4. data/meta.json получает imageVersion — общий SHA-256 исходников картинок.
     Исходный HTML/JS этот скрипт больше не переписывает: версию к ссылкам на
     собранные картинки подставляет Vite-сборка публикации в .publish.

Запуск:

    pip install pillow
    python3 tools/build_assets.py            # собрать только устаревшее
    python3 tools/build_assets.py --force    # пересобрать всё
    python3 tools/build_assets.py --check    # только проверить наличие собранных картинок
"""
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Не установлен Pillow. Поставьте: pip install pillow")

# крупные исходники могут превышать стандартный лимит Pillow
Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "src"
ASSETS = ROOT / "assets"
META = ROOT / "data" / "meta.json"
CANONICAL_MAP_SIZE = 10000

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

    method — степень сжатия: 6 даёт минимум размера для единичных картинок.
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
    """meta.json: размер карты и imageVersion для кэш-бастинга собранных картинок."""
    meta = {}
    if META.exists():
        meta = json.loads(META.read_text(encoding="utf-8"))
    map_size = meta.get("mapSize") or CANONICAL_MAP_SIZE
    version = image_version()
    wanted_assets = {
        "imageVersion": version,
    }
    if (
        not force
        and meta.get("mapSize") == map_size
        and meta.get("assets") == wanted_assets
    ):
        print("  = meta.json актуален")
        return 0

    meta["mapSize"] = map_size
    meta["assets"] = wanted_assets
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  + meta.json: mapSize={map_size}, imageVersion={version}")
    return 0


STEPS = [
    ("Карта галактики", build_galaxy),
    ("Логотип прелоадера", build_logo),
    ("Макеты секторов", build_mackets),
    ("meta.json", update_meta),
]


def check_fresh():
    """Проверяет, что собранные картинки на месте. Ничего не пишет."""
    problems = []
    required = [
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
