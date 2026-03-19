---
name: agent-browser
description: Browser automation with the agent-browser CLI. Use for screenshots, interaction testing, scraping, auth flows, and other browser tasks.
allowed-tools: [Bash(agent-browser:*)]
---

# agent-browser

## Quick start

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "text"
agent-browser close
```

## Core workflow

1. Open the page: `agent-browser open <url>`
2. Inspect the page: `agent-browser snapshot -i`
3. Interact with `@eN` refs from the snapshot
4. Re-run `snapshot -i` after navigation or large DOM changes

Prefer the snapshot/ref flow over raw selectors when possible. It is more stable and easier for agents to reason about.

## Common commands

### Navigation

```bash
agent-browser open <url>
agent-browser back
agent-browser forward
agent-browser reload
agent-browser close
```

### Snapshots

```bash
agent-browser snapshot
agent-browser snapshot -i
agent-browser snapshot -c
agent-browser snapshot -d 3
agent-browser snapshot -s "#main"
agent-browser snapshot -i -c -d 5
```

### Interactions

```bash
agent-browser click @e1
agent-browser dblclick @e1
agent-browser focus @e1
agent-browser fill @e2 "text"
agent-browser type @e2 "text"
agent-browser press Enter
agent-browser hover @e1
agent-browser check @e1
agent-browser uncheck @e1
agent-browser select @e1 "value"
agent-browser scroll down 500
agent-browser scrollintoview @e1
agent-browser drag @e1 @e2
agent-browser upload @e1 ./file.pdf
```

### Read data

```bash
agent-browser get text @e1
agent-browser get html @e1
agent-browser get value @e1
agent-browser get attr @e1 href
agent-browser get title
agent-browser get url
agent-browser get count ".item"
agent-browser get box @e1
```

### Screenshots and artifacts

```bash
agent-browser screenshot
agent-browser screenshot page.png
agent-browser screenshot --full
agent-browser screenshot --annotate
agent-browser pdf page.pdf
```

### Waiting and state checks

```bash
agent-browser wait @e1
agent-browser wait 2000
agent-browser wait --text "Success"
agent-browser wait --url "**/dashboard"
agent-browser wait --load networkidle
agent-browser is visible @e1
agent-browser is enabled @e1
agent-browser is checked @e1
```

### Semantic locators

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@example.com"
agent-browser find first ".item" click
agent-browser find nth 2 "a" text
```

## Sessions and auth

Use named sessions or saved state when the flow spans multiple commands or authenticated pages.

```bash
agent-browser --session demo open https://example.com
agent-browser --session demo snapshot -i

agent-browser state save auth.json
agent-browser state load auth.json
```

## JSON output

Use `--json` when the result needs to be parsed by another tool or agent step.

```bash
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

## Security and context hygiene

- Prefer focused snapshots: `-i`, `-c`, `-d`, and `-s` reduce context bloat.
- Use `--content-boundaries` when page output could be untrusted.
- Use `--max-output` to cap noisy pages.
- Use `--allowed-domains` for high-trust or production workflows.
- Prefer auth state, session names, or the auth vault over pasting credentials repeatedly.

## Debugging

```bash
agent-browser open https://example.com --headed
agent-browser console
agent-browser errors
agent-browser highlight @e1
agent-browser trace start
agent-browser trace stop trace.zip
```

## Best practices

- Re-snapshot after page transitions or form submissions.
- Prefer refs from snapshots before falling back to CSS selectors.
- Capture evidence with screenshots for UI verification.
- Use `wait --load networkidle` or targeted waits instead of arbitrary sleep loops.
- Close the browser or reuse a named session deliberately; do not leave stale state by accident.
