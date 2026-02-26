#!/usr/bin/env bash
set -euo pipefail

if ! command -v lokalise2 >/dev/null 2>&1; then
  echo "lokalise2 not found. Install via: brew tap lokalise/cli-2 && brew install lokalise2" >&2
  exit 1
fi

if [[ -z "${LOKALISE_TOKEN:-}" ]]; then
  echo "Missing LOKALISE_TOKEN env var" >&2
  exit 1
fi

PROJECT_ID="${LOKALISE_PROJECT_ID:-239259646152dc99c392f9.43337571}"

lokalise2 --token "$LOKALISE_TOKEN" --project-id "$PROJECT_ID" "$@"
