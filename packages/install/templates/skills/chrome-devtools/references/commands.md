# Command Reference

Grounded command surface for `chrome-devtools`.

## Page Management

```bash
chrome-devtools navigate https://example.com
chrome-devtools navigate --back
chrome-devtools navigate --forward
chrome-devtools navigate --reload
chrome-devtools new-page https://example.com
chrome-devtools list-pages
chrome-devtools select-page 1
chrome-devtools close-page 1
```

For quick one-off flows, `--page <index>` is often simpler:

```bash
chrome-devtools list-pages
chrome-devtools --page 3 snapshot
chrome-devtools --page 3 evaluate "document.title"
chrome-devtools --page 3 screenshot --output /tmp/page.png
```

When a command emits a target marker, capture it and reuse `--target` for a longer flow. Depending on the installed build, the marker may appear as a raw target ID or a friendly target label.

## Capture & Inspection

```bash
chrome-devtools --page <index> snapshot
chrome-devtools --page <index> screenshot --output /tmp/page.png
chrome-devtools --page <index> screenshot --full-page --output /tmp/page-full.png
chrome-devtools --page <index> evaluate "document.title"
chrome-devtools --page <index> evaluate "document.body.innerText"

chrome-devtools --target <target-id> snapshot
chrome-devtools --target <target-id> evaluate "document.title"
```

## Interaction

Use CSS selectors; there is no `@e1`-style ref model.

```bash
chrome-devtools --page <index> click "button[type='submit']"
chrome-devtools --page <index> fill "input[name='email']" "user@example.com"
chrome-devtools --page <index> type-text "extra text"
chrome-devtools --page <index> press-key Enter
chrome-devtools --page <index> hover ".menu-item"

chrome-devtools --target <target-id> click "button[type='submit']"
```

## Viewport & Waiting

```bash
chrome-devtools --page <index> resize 1280 800
chrome-devtools --page <index> wait-for "Dashboard" --timeout 10000

chrome-devtools --target <target-id> wait-for "Dashboard" --timeout 10000
```
