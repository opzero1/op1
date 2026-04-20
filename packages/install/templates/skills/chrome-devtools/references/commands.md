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

`navigate` prints `[target:word-pair]`. Reuse that target with `--target`.

## Capture & Inspection

```bash
chrome-devtools --target <name> snapshot
chrome-devtools --target <name> screenshot --output /tmp/page.png
chrome-devtools --target <name> screenshot --full-page --output /tmp/page-full.png
chrome-devtools --target <name> evaluate "document.title"
chrome-devtools --target <name> evaluate "document.body.innerText"
```

## Interaction

Use CSS selectors; there is no `@e1`-style ref model.

```bash
chrome-devtools --target <name> click "button[type='submit']"
chrome-devtools --target <name> fill "input[name='email']" "user@example.com"
chrome-devtools --target <name> type-text "extra text"
chrome-devtools --target <name> press-key Enter
chrome-devtools --target <name> hover ".menu-item"
```

## Viewport & Waiting

```bash
chrome-devtools --target <name> resize 1280 800
chrome-devtools --target <name> wait-for "Dashboard" --timeout 10000
```
