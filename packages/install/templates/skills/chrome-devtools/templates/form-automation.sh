#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <form-url>"
    exit 1
fi

FORM_URL="$1"
NAV_OUTPUT="$(chrome-devtools navigate "$FORM_URL")"
printf '%s\n' "$NAV_OUTPUT"

if [[ "$NAV_OUTPUT" =~ \[target:([^]]+)\] ]]; then
    TARGET="${BASH_REMATCH[1]}"
else
    echo "Could not parse [target:name] from navigate output"
    exit 1
fi

chrome-devtools --target "$TARGET" snapshot

cat <<EOF

Use CSS selectors for direct interactions, for example:

  chrome-devtools --target "$TARGET" fill "#name" "Jane Doe"
  chrome-devtools --target "$TARGET" fill "#email" "jane@example.com"
  chrome-devtools --target "$TARGET" click "button[type=submit]"
  chrome-devtools --target "$TARGET" wait-for "Thanks" --timeout 10000

For unsupported helpers like select/check, use evaluate explicitly:

  chrome-devtools --target "$TARGET" evaluate "const el = document.querySelector('select'); el.value = 'desired'; el.dispatchEvent(new Event('change', { bubbles: true })); 'ok'"
  chrome-devtools --target "$TARGET" click "input[type=checkbox]"

Capture the result with:

  chrome-devtools --target "$TARGET" screenshot --output /tmp/form-result.png

EOF
