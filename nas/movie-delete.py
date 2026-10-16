#!/usr/bin/env python3
"""Permanently remove one validated movie title directory from the library."""

import json
import os
from pathlib import Path
import shutil
import sys
import time

ROOT = Path("/mnt/sdb1/library/Movies")
LOG = Path("/home/nas/cleanup/deletions.log")


def reply(ok, **extra):
    print(json.dumps({"ok": ok, **extra}, ensure_ascii=False))


def fail(message, code=2):
    reply(False, error=message)
    sys.exit(code)


if len(sys.argv) != 2:
    fail("usage: xamedia-movie-delete <movie-directory>")

name = sys.argv[1]
if (not name or name in {".", ".."} or "/" in name or "\\" in name
        or "\0" in name):
    fail("bad directory name")

try:
    root = ROOT.resolve(strict=True)
except OSError as exc:
    fail(f"movies root unavailable: {exc}", 1)
if not root.is_dir():
    fail("movies root is not a directory", 1)

candidate = root / name
if candidate.is_symlink():
    fail("refusing symlink", 3)
if not candidate.exists():
    reply(True, dir=name, already_missing=True)
    sys.exit(0)

try:
    target = candidate.resolve(strict=True)
except OSError as exc:
    fail(f"cannot resolve target: {exc}", 1)
if target.parent != root or not target.is_dir():
    fail("target is outside the movies library", 3)
if os.path.ismount(target):
    fail("refusing mount point", 3)

try:
    shutil.rmtree(target)
except OSError as exc:
    fail(f"delete failed: {exc}", 1)

try:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} purged {name}\n")
    reply(True, dir=name, deleted=True)
except OSError as exc:
    reply(True, dir=name, deleted=True, log_error=str(exc))
