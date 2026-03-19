# @op1/reprompt

Optional OpenCode plugin for incoming prompt compilation, bounded evidence packing, and explicit retry orchestration.

## What It Does

- pre-compiles terse incoming prompts before agent execution when `runtime.mode` is `hook-and-helper`
- leaves already-structured prompts unchanged
- exposes `reprompt` for manual bounded retries and child-session escalation
- fails closed by passing the original prompt through when compilation is suppressed or unsafe

Incoming chat prompts can opt in with either a leading marker (`opx fix auth flow`) or a trailing marker (`fix auth flow opx`). Slash commands support the trailing form on command arguments as well.

## Config

Create either `~/.config/opencode/reprompt.json` or `.opencode/reprompt.json`.

```json
{
  "enabled": true,
  "runtime": {
    "mode": "hook-and-helper",
    "promptMode": "auto",
  }
}
```

Key options:

- `enabled`: turns the plugin on or off
- `runtime.mode`: `hook-and-helper` enables from-the-start prompt compilation; `helper-only` disables the incoming-message hook and keeps only `reprompt`

## Telemetry

When telemetry persistence is enabled, events are written to:

- `.opencode/reprompt/events.jsonl`

Useful outcomes to watch for:

- `incoming-processed` with `outcome=compiled`
- `incoming-processed` with `outcome=pass-through`
- `incoming-processed` with `outcome=suppressed`

## Operator Notes

- Start with the plugin enabled only in repos where terse prompts are common
- Use `helper-only` if automatic prompt compilation is too aggressive for a workflow
- Flip `enabled` to `false` or switch `runtime.mode` to `helper-only` for immediate rollback without uninstalling the plugin
- If prompts are unexpectedly rewritten, inspect `.opencode/reprompt/events.jsonl` before changing heuristics
