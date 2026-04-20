# Workflow Notes

## 1) Keep a Stable Target

Always start by navigating and capturing target output:

```bash
NAV_OUTPUT="$(chrome-devtools navigate https://example.com)"
```

Extract `[target:word-pair]`, then pass `--target <name>` to all later commands.

If you skip `--target`, your command may hit a different selected page.

## 2) Re-snapshot After State Changes

After click/submit/navigation, run a new snapshot before choosing the next selector.

```bash
chrome-devtools --target "$TARGET" snapshot
chrome-devtools --target "$TARGET" click "a[href='/next']"
chrome-devtools --target "$TARGET" wait-for "Next page"
chrome-devtools --target "$TARGET" snapshot
```

## 3) Multi-Tab Flow

Use these commands when multiple tabs are involved:

1. `list-pages` to inspect open tabs
2. `select-page <index>` to switch active page
3. Keep passing `--target` anyway for explicitness and safety

## 4) Selector-First Interaction

This CLI does not provide semantic refs like `@e1`; use CSS selectors.

When selectors are unstable, use `evaluate` to inspect and derive safer selectors.
