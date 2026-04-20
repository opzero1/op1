#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <url> [output-dir]"
    exit 1
fi

TARGET_URL="$1"
OUTPUT_DIR="${2:-./chrome-devtools-capture}"

mkdir -p "$OUTPUT_DIR"

NAV_OUTPUT="$(chrome-devtools navigate "$TARGET_URL")"
printf '%s\n' "$NAV_OUTPUT"

if [[ "$NAV_OUTPUT" =~ \[target:([^]]+)\] ]]; then
    TARGET="${BASH_REMATCH[1]}"
else
    echo "Could not parse [target:name] from navigate output"
    exit 1
fi

chrome-devtools --target "$TARGET" snapshot > "$OUTPUT_DIR/page-structure.txt"
chrome-devtools --target "$TARGET" screenshot --full-page --output "$OUTPUT_DIR/page-full.png"
chrome-devtools --target "$TARGET" evaluate "document.title" > "$OUTPUT_DIR/page-title.txt"
chrome-devtools --target "$TARGET" evaluate "window.location.href" > "$OUTPUT_DIR/page-url.txt"
chrome-devtools --target "$TARGET" evaluate "document.body.innerText" > "$OUTPUT_DIR/page-text.txt"

cat <<EOF
Saved artifacts to $OUTPUT_DIR
- page-structure.txt
- page-full.png
- page-title.txt
- page-url.txt
- page-text.txt
EOF
