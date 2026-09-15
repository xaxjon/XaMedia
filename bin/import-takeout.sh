#!/usr/bin/env bash
# Import photos from Google Takeout export zip(s) into the slideshow folder.
#
# Usage: bin/import-takeout.sh takeout-*.zip [more.zip ...]
#
# Images land in data/photos/, preserving the album folder structure from
# "Takeout/Google Photos/". JSON sidecar files and videos are skipped.
# Existing files are left alone (idempotent re-runs).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/data/photos"
CACHE="$ROOT/data/cache/photos.json"

if [ $# -lt 1 ]; then
    echo "usage: $0 <takeout.zip> [more.zip ...]" >&2
    exit 1
fi

mkdir -p "$DEST"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for zip in "$@"; do
    if [ ! -f "$zip" ]; then
        echo "warning: '$zip' not found, skipping" >&2
        continue
    fi
    echo "extracting $zip ..."
    unzip -q -n "$zip" -d "$TMP"
done

SRC="$TMP/Takeout/Google Photos"
if [ ! -d "$SRC" ]; then
    echo "error: no 'Takeout/Google Photos' folder found in the archive(s)" >&2
    exit 1
fi

count=0
while IFS= read -r -d '' f; do
    rel="${f#"$SRC"/}"
    target="$DEST/$rel"
    if [ -f "$target" ]; then
        continue
    fi
    mkdir -p "$(dirname "$target")"
    cp "$f" "$target"
    count=$((count + 1))
done < <(find "$SRC" -type f \
    \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \) \
    -print0)

# Force the photo-list cache to rebuild on next request.
rm -f "$CACHE"

echo "imported $count new photo(s) into $DEST"
