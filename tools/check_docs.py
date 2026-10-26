#!/usr/bin/env python3
"""Проверка структуры документации.

Правила (docs/README.md):
1. Каждый файл контекста — не более 200 строк. Исключение по решению
   владельца — только ``docs/registers/errors-systemic.md``.
2. У каждого файла ровно один заголовок первого уровня (в первых
   12 строках), а уровни заголовков не прыгают через ступень.
3. Относительные Markdown-ссылки указывают на существующие файлы,
   якоря ``#фрагмент`` — на существующие заголовки цели.
4. У каждого файла есть входящая ссылка из другого документа
   (кроме корневых точек входа).

Запуск: ``python3 tools/check_docs.py`` (или ``npm run verify:docs``).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
MAX_LINES = 200
# Единственный документ без лимита размера: систематические ошибки копятся
# в одном месте и не дробятся искусственно (требование владельца).
UNBOUNDED = {DOCS / "registers" / "errors-systemic.md"}
# Append-only журнал репозитория; не является документом контекста.
SKIP_NAMES = {"CHANGELOG.md"}
# Корневые точки входа: входящая ссылка не требуется по определению.
ENTRY_POINTS = {ROOT / "AGENTS.md", ROOT / "README.md", DOCS / "README.md"}

LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")


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


def github_slug(text: str) -> str:
    """Якорь заголовка по правилам GitHub: строчные, знаки препинания
    убраны, каждый пробел — отдельный дефис."""
    text = text.strip().lower()
    text = re.sub(r"[^\w\s\-]", "", text, flags=re.UNICODE)
    return text.replace(" ", "-")


def parse_file(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    clean = strip_code_fences(lines)
    headings: list[tuple[int, int, str]] = []  # (номер строки, уровень, якорь)
    seen: dict[str, int] = {}
    for number, line in enumerate(clean, 1):
        match = HEADING_RE.match(line)
        if not match:
            continue
        level = len(match.group(1))
        base = github_slug(match.group(2))
        dup = seen.get(base, 0)
        seen[base] = dup + 1
        headings.append((number, level, base if dup == 0 else f"{base}-{dup}"))
    links: list[tuple[int, str]] = []
    for number, line in enumerate(clean, 1):
        for raw in LINK_RE.findall(line):
            links.append((number, raw))
    return {"lines": lines, "headings": headings, "links": links}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-lines", type=int, default=MAX_LINES)
    parser.add_argument("--list", action="store_true", help="напечатать все проверенные файлы")
    args = parser.parse_args()

    files = [p for p in markdown_files() if p.name not in SKIP_NAMES]
    parsed: dict[Path, dict] = {}
    errors: list[str] = []
    for path in files:
        try:
            parsed[path.resolve()] = parse_file(path)
        except UnicodeDecodeError:
            errors.append(f"{path.relative_to(ROOT)}: не UTF-8")

    inbound: dict[Path, set[Path]] = {path: set() for path in parsed}

    for path in files:
        resolved_path = path.resolve()
        data = parsed.get(resolved_path)
        if data is None:
            continue
        rel = path.relative_to(ROOT).as_posix()
        lines, headings, links = data["lines"], data["headings"], data["links"]

        if path not in UNBOUNDED and len(lines) > args.max_lines:
            errors.append(
                f"{rel}: {len(lines)} строк > {args.max_lines} "
                "(делите по смысловому шву на файлы-части, не ужимайте текст)"
            )

        h1 = [h for h in headings if h[1] == 1]
        if not h1:
            errors.append(f"{rel}: нет заголовка первого уровня")
        elif len(h1) > 1:
            errors.append(f"{rel}: заголовков первого уровня {len(h1)} (нужен ровно один)")
        elif h1[0][0] > 12:
            errors.append(f"{rel}: заголовок первого уровня ниже 12-й строки")

        prev_level = 0
        for number, level, _anchor in headings:
            if prev_level and level > prev_level + 1:
                errors.append(f"{rel}:{number}: прыжок заголовков H{prev_level} -> H{level}")
            prev_level = level

        for number, raw in links:
            target, _, fragment = raw.partition("#")
            if "://" in raw or raw.startswith(("mailto:", "tel:", "data:")):
                continue
            if not target:
                resolved = resolved_path
            else:
                resolved = (path.parent / unquote(target).replace("%20", " ")).resolve()
                if not resolved.exists():
                    errors.append(f"{rel}:{number}: битая ссылка -> {raw}")
                    continue
            if resolved in inbound and resolved != resolved_path:
                inbound[resolved].add(resolved_path)
            if fragment and resolved in parsed:
                anchors = {anchor for _n, _lvl, anchor in parsed[resolved]["headings"]}
                if unquote(fragment).lower() not in anchors:
                    errors.append(f"{rel}:{number}: битый якорь -> {raw}")

    for path in files:
        resolved = path.resolve()
        if path in ENTRY_POINTS or resolved not in inbound:
            continue
        if not inbound[resolved]:
            errors.append(
                f"{path.relative_to(ROOT).as_posix()}: нет входящих ссылок (сирота)"
            )

    if args.list:
        for path in files:
            print(f"{len(parsed[path.resolve()]['lines']):4d}  {path.relative_to(ROOT)}")
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
