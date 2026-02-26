---
name: chrome-devtools
description: Browser automation, screenshots, and performance analysis using Puppeteer. Use for visual verification, E2E testing, web scraping.
---

# Chrome DevTools

> **Load this skill** when needing browser automation, screenshots, or performance testing.

## TL;DR

Puppeteer scripts for browser automation. All output JSON. Auto-compress screenshots >5MB.

## When to Use

- Taking screenshots for visual verification
- E2E testing automation
- Performance measurement (Core Web Vitals)
- Web scraping
- Form automation
- Console/network monitoring

## When NOT to Use

- Backend-only testing
- API testing (use HTTP clients)

## Quick Start

```bash
# Install
npm install puppeteer

# Basic navigation
node navigate.js --url https://example.com
# Output: {"success": true, "url": "...", "title": "Example Domain"}
```

## Available Scripts

| Script | Purpose |
|--------|---------|
| `navigate.js` | Navigate to URLs |
| `screenshot.js` | Capture screenshots (auto-compress) |
| `click.js` | Click elements |
| `fill.js` | Fill form fields |
| `evaluate.js` | Execute JavaScript |
| `snapshot.js` | Extract interactive elements |
| `console.js` | Monitor console messages |
| `network.js` | Track HTTP requests |
| `performance.js` | Measure Core Web Vitals |

## Common Patterns

### Screenshot
```bash
node screenshot.js --url https://example.com --output page.png
# Auto-compresses if >5MB for AI compatibility
```

### Form Automation
```bash
node fill.js --url https://example.com --selector "#email" --value "test@test.com" --close false
node fill.js --selector "#password" --value "secret" --close false
node click.js --selector "button[type=submit]"
```

### Performance Testing
```bash
node performance.js --url https://example.com
# Returns: {"vitals": {"LCP": 1234, "FID": 12, "CLS": 0.1}}
```

### Web Scraping
```bash
node evaluate.js --url https://example.com --script "
  Array.from(document.querySelectorAll('.item')).map(el => ({
    title: el.querySelector('h2')?.textContent,
    link: el.querySelector('a')?.href
  }))
"
```

## Selector Discovery

Use snapshot.js to find correct selectors:
```bash
node snapshot.js --url https://example.com | jq '.elements[] | select(.tagName=="BUTTON")'
```

Supports CSS and XPath:
```bash
# CSS
node click.js --selector ".btn-submit"

# XPath
node click.js --selector "//button[contains(text(),'Submit')]"
```

## Script Options

All scripts support:
- `--headless false` - Show browser window
- `--close false` - Keep browser open for chaining
- `--timeout 30000` - Set timeout (ms)
- `--wait-until networkidle2` - Wait strategy

## Performance Thresholds

| Metric | Good | Needs Work | Poor |
|--------|------|------------|------|
| LCP | <2.5s | 2.5-4s | >4s |
| FID | <100ms | 100-300ms | >300ms |
| CLS | <0.1 | 0.1-0.25 | >0.25 |

## Adherence Checklist

When using browser automation:
- [ ] Verified pwd before running scripts?
- [ ] Used snapshot.js to discover selectors?
- [ ] Screenshots saved to appropriate location?
- [ ] Validated output file exists after capture?
- [ ] Headless mode appropriate for task?
