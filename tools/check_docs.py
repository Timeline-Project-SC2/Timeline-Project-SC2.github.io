#!/usr/bin/env python3
"""Проверка структуры документации.

Правила (docs/README.md):
1. Каждый файл контекста — не более 200 строк. Исключение по решению
   владельца — только ``docs/registers/errors-systemic.md``.
2. У каждого файла есть заголовок первого уровня.
3. Относительные Markdown-ссылки указывают на существующие файлы.

Запуск: ``python3 tools/check_docs.py`` (или ``npm run verify:docs``).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
MAX_LINES = 200
# Единственный документ без лимита размера: систематические ошибки копятся
# в одном месте и не дробятся искусственно (требование владельца).
UNBOUNDED = {DOCS / "registers" / "errors-systemic.md"}
# Append-only журнал репозитория; не является документом контекста.
SKIP_NAMES = {"CHANGELOG.md"}

LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
H1_RE = re.compile(r"^#\s+\S")


def markdown_files() -> list[Path]:
    files = sorted(DOCS.rglob("*.md"))
    for name in ("AGENTS.md", "README.md"):
        path = ROOT / name
        if path.exists():
            files.append(path)
    return files


def strip_code_fences(lines: list[str]) -> list[str]:
    """Убирает содержимое блоков кода, чтобы не ловить ссылки из примеров."""
    result: list[str] = []
    fence: str | None = None
    for line in lines:
        stripped = line.lstrip()
        if fence is None and (stripped.startswith("```") or stripped.startswith("~~~~")):
            fence = stripped[:3]
            result.append("")
            continue
        if fence is not None:
            if stripped.startswith(fence):
                fence = None
            result.append("")
            continue
        result.append(line)
    return result


def check_file(path: Path, max_lines: int) -> list[str]:
    errors: list[str] = []
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return [f"{path.relative_to(ROOT)}: не UTF-8"]
    lines = text.splitlines()
    rel = path.relative_to(ROOT).as_posix()
    if path not in UNBOUNDED and len(lines) > max_lines:
        errors.append(f"{rel}: {len(lines)} строк > {max_lines}")
    if not any(H1_RE.match(line) for line in lines[:12]):
        errors.append(f"{rel}: нет заголовка первого уровня в первых 12 строках")
    clean = strip_code_fences(lines)
    for number, line in enumerate(clean, 1):
        for raw in LINK_RE.findall(line):
            target = raw.split("#", 1)[0]
            if not target or "://" in target or target.startswith(("mailto:", "tel:", "data:")):
                continue
            target = target.replace("%20", " ")
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                errors.append(f"{rel}:{number}: битая ссылка -> {raw}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-lines", type=int, default=MAX_LINES)
    parser.add_argument("--list", action="store_true", help="напечатать все проверенные файлы")
    args = parser.parse_args()

    files = markdown_files()
    errors: list[str] = []
    for path in files:
        if path.name in SKIP_NAMES:
            continue
        errors.extend(check_file(path, args.max_lines))

    if args.list:
        for path in files:
            print(f"{len(path.read_text(encoding='utf-8').splitlines()):4d}  {path.relative_to(ROOT)}")
    if errors:
        print("Проверка документации: ошибки", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        print(f"Всего ошибок: {len(errors)}", file=sys.stderr)
        return 1
    print(f"Проверка документации: OK ({len(files)} файлов, лимит {args.max_lines} строк)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
