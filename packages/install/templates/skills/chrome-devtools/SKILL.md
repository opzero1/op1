---
name: chrome-devtools
description: Use this when the user needs to control Chrome, navigate to a page, inspect a tab, click or fill elements, take screenshots, or automate a browser flow with aeroxy/chrome-devtools-cli.
allowed-tools: [Bash(chrome-devtools:*)]
---

# Chrome DevTools CLI (aeroxy/chrome-devtools-cli)

Use this skill for browser automation tasks that can be solved with the `chrome-devtools` binary.

## Install & Prerequisites

Install with one of:

```bash
brew tap aeroxy/chrome-devtools-cli && brew install chrome-devtools
cargo install chrome-devtools-cli
```

The binary name is `chrome-devtools`.

Chrome remote debugging must be enabled first at `chrome://inspect/#remote-debugging`.

See [references/prerequisites.md](references/prerequisites.md).

## Core Workflow (Target-Aware)

`navigate` prints a target handle in the form `[target:word-pair]`.

Capture that target once, then pass `--target <name>` to every follow-up command so you keep operating on the same tab.

```bash
NAV_OUTPUT="$(chrome-devtools navigate https://example.com)"

if [[ "$NAV_OUTPUT" =~ \[target:([^]]+)\] ]]; then
  TARGET="${BASH_REMATCH[1]}"
else
  echo "Failed to capture target from navigate output"
  exit 1
fi

chrome-devtools --target "$TARGET" snapshot
chrome-devtools --target "$TARGET" screenshot --output ./example.png
```

## Supported Commands

This skill is grounded on the currently supported command set:

- `navigate`
- `new-page`
- `close-page`
- `select-page`
- `list-pages`
- `screenshot`
- `snapshot`
- `evaluate`
- `click`
- `fill`
- `type-text`
- `press-key`
- `hover`
- `resize`
- `wait-for`

See [references/commands.md](references/commands.md) and [references/workflow.md](references/workflow.md) for usage patterns.

## Capability Boundaries (Do Not Fake)

`chrome-devtools` does **not** directly provide prior `agent-browser` features such as:

- auth/session save-load commands
- credential vaults
- PDF export
- video recording
- upload/select/check helpers
- snapshot element refs like `@e1`
- network interception tooling
- profiling tools

When these are requested, be explicit about the gap and either:

1. Use supported CSS-selector + `evaluate` workarounds, or
2. Return a clear blocked/unsupported outcome.

See [references/capability-gaps.md](references/capability-gaps.md).

## Templates

- [templates/capture-workflow.sh](templates/capture-workflow.sh)
- [templates/form-automation.sh](templates/form-automation.sh)
- [templates/authenticated-session.sh](templates/authenticated-session.sh)
