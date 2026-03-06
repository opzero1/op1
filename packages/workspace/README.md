# @op1/workspace

Operational continuity plugin for OpenCode: plans, notepads, worktree tooling, tmux orchestration, and runtime safety hooks.

## What It Provides

- Persistent plan workflow (`plan_*` + linked plan docs)
- Notepad memory across sessions (`learnings`, `issues`, `decisions`)
- Session continuity and diagnostics
- Pairs with `@op1/delegation` for async `task` orchestration
- Worktree and terminal orchestration (including tmux-aware behavior)
- Safety hooks (verification reminders, context scouting, compaction, non-interactive guard)

## Installation

```bash
bun add @op1/workspace
```

Add plugin to OpenCode config:

```json
{
  "plugin": ["@op1/workspace"]
}
```

## Runtime Requirements

- Bun runtime
- Git repository (required for worktree tools)
- Optional tmux support:
  - `tmux` installed and available on `PATH`
  - OpenCode session running inside tmux (`TMUX` env set)
- macOS terminal fallbacks use `osascript`/`open` for GUI terminals

## Configuration

Config files are merged in this order:

1. Global: `~/.config/opencode/workspace.json`
2. Project: `.opencode/workspace.json`

Project values override global values.

### Default Operational Profile

All operational improvements are on by default. Approval remains opt-in.

```json
{
  "safeHookCreation": false,
  "features": {
    "momentum": true,
    "completionPromise": true,
    "writePolicy": true,
    "taskReminder": true,
    "autonomyPolicy": true,
    "notifications": true,
    "verificationAutopilot": true,
    "hashAnchoredEdit": true,
    "contextScout": true,
    "externalScout": true,
    "skillPointer": true,
    "taskGraph": true,
    "continuationCommands": true,
    "tmuxOrchestration": true,
    "boundaryPolicyV2": true,
    "claudeCompatibility": true,
    "mcpOAuthHelper": true,
    "approvalGate": false
  },
  "thresholds": {
    "taskReminderThreshold": 20,
    "contextLimit": 200000,
    "compactionThreshold": 0.78,
    "verificationThrottleMs": 45000
  },
  "notifications": {
    "enabled": true,
    "desktop": true,
    "privacy": "strict"
  },
  "approval": {
    "mode": "off",
    "tools": ["plan_archive", "background_cancel", "worktree_delete"],
    "exemptTools": [],
    "ttlMs": 300000,
    "nonInteractive": "fail-closed"
  }
}
```

## tmux Orchestration

`features.tmuxOrchestration` controls tmux-aware terminal behavior for worktree flows.

When enabled and running inside tmux:

- Uses tmux as terminal target
- Reuses existing project-scoped windows when available
- Deduplicates stale duplicate windows
- Persists tmux metadata (`tmux_session_name`, `tmux_window_name`) for continuation/delegation traceability

Scoped window naming format:

- `op1-<project>-<window>`

Fallback behavior (when tmux is unavailable or not active):

- iTerm2 -> Ghostty -> Warp -> Terminal.app

To disable tmux orchestration:

```json
{
  "features": {
    "tmuxOrchestration": false
  }
}
```

## Important Notes

- `contextScout`/`externalScout` are hook-based context pipelines, not subagents.
- `boundaryPolicyV2` hardens policy behavior but does not require approval mode to be on.
- Approval remains disabled unless you explicitly set `features.approvalGate=true` and `approval.mode` to a stricter value.
- Hook creation is fail-fast by default (`safeHookCreation=false`) so missing/broken runtime dependencies fail visibly.

## Tooling Surface

Key tool groups exposed by this plugin:

- Plan: `plan_save`, `plan_read`, `plan_list`, `plan_set_active`, `plan_archive`, `plan_unarchive`
- Plan docs: `plan_doc_link`, `plan_doc_list`, `plan_doc_load`
- Notepads: `notepad_read`, `notepad_write`, `notepad_list`
- Sessions: `session_list`, `session_read`, `session_search`, `session_info`
- Worktree: `worktree_create`, `worktree_list`, `worktree_enter`, `worktree_leave`, `worktree_delete`

Async task orchestration lives in `@op1/delegation`:

- `task`
- `background_output`
- `background_cancel`
- `agent_status`
- `task_graph_status`

## Data Layout

Runtime state is stored under:

```text
<project>/.opencode/workspace/
```

Includes plans, notepads, session registries, and feature state files. `@op1/delegation` also stores its durable task records here.

## License

MIT
