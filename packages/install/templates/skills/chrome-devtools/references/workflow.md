# Workflow Notes

## 1) Pick a Stable Page Selector

Start by listing pages, then choose either `--page` or `--target`:

```bash
chrome-devtools list-pages
chrome-devtools --page 3 snapshot
```

Use `--page <PAGE>` as the safe/simple fallback for quick flows.

If command output emits a useful target value, capture it and pin with `--target <TARGET>`.
Do not assume a single output format; runtime output may include `(target: F5D1...)` or `[target:...]`.

## 2) Re-snapshot After State Changes

After click/submit/navigation, run a new snapshot before choosing the next selector.

```bash
chrome-devtools --page 3 snapshot
chrome-devtools --page 3 click "a[href='/next']"
chrome-devtools --page 3 wait-for "Next page"
chrome-devtools --page 3 snapshot
```

## 3) Multi-Tab Flow

Use these commands when multiple tabs are involved:

1. `list-pages` to inspect open tabs
2. `select-page <index>` to switch active page
3. Keep passing an explicit selector (`--page` or `--target`) for safety

## 4) Selector-First Interaction

This CLI does not provide semantic refs like `@e1`; use CSS selectors.

When selectors are unstable, use `evaluate` to inspect and derive safer selectors.
