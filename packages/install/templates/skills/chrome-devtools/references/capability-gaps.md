# Capability Gaps and Workarounds

This skill is intentionally current-state only. Do not claim unsupported features.

## Not Supported Directly

| Requested capability | Direct support in `chrome-devtools` | Practical approach |
| --- | --- | --- |
| Auth/session save-load vault flows | No | Log in within the same target and continue in that session only |
| PDF export | No | Use screenshot and/or `evaluate` text extraction instead |
| Video recording | No | Capture periodic screenshots as evidence |
| File upload helper | No | Report unsupported unless target app can be driven by custom in-page JS |
| Select/check convenience commands | No | Use `evaluate` to set value/checked and dispatch events |
| Snapshot `@e*` refs | No | Use CSS selectors and fresh `snapshot` output |
| Network interception/HAR tools | No | Report unsupported |
| Profiling commands | No | Report unsupported |

## `evaluate` Workaround Examples

Checkbox:

```bash
chrome-devtools --target <name> evaluate "
  const el = document.querySelector('input[name=\"terms\"]');
  if (!el) throw new Error('checkbox not found');
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
"
```

Select:

```bash
chrome-devtools --target <name> evaluate "
  const el = document.querySelector('select[name=\"country\"]');
  if (!el) throw new Error('select not found');
  el.value = 'US';
  el.dispatchEvent(new Event('change', { bubbles: true }));
"
```

## Wait limitations

`wait-for` is text-based. It does not wait on selectors, network-idle, or file downloads.
