#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <url> [user-data-dir]"
    exit 1
fi

TARGET_URL="$1"
USER_DATA_DIR="${2:-}"

CHROME_DEVTOOLS=(chrome-devtools)

if [[ -n "$USER_DATA_DIR" ]]; then
    CHROME_DEVTOOLS+=(--user-data-dir "$USER_DATA_DIR")
fi

NAV_OUTPUT="$("${CHROME_DEVTOOLS[@]}" navigate "$TARGET_URL")"
printf '%s\n' "$NAV_OUTPUT"

if [[ "$NAV_OUTPUT" =~ \[target:([^]]+)\] ]]; then
    TARGET="${BASH_REMATCH[1]}"
else
    echo "Could not parse [target:name] from navigate output"
    exit 1
fi

cat <<EOF

Reused Chrome's existing session for target: $TARGET

Useful follow-up commands:
  chrome-devtools --target "$TARGET" snapshot
  chrome-devtools --target "$TARGET" evaluate "document.title"
  chrome-devtools --target "$TARGET" screenshot --output /tmp/session.png

If the page is not authenticated, sign in through the live Chrome tab and continue using the same target.
This CLI does not expose auth save/load helpers or isolated session files.

EOF
