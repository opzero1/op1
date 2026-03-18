---
name: long-running-workflows
description: Opt-in workflow for resumable multi-hour or multi-day execution using durable local state, append-only logs, and explicit pause/resume controls.
---

# Long-Running Workflows

Use this skill when the user wants autonomous work that may span many iterations, long sessions, restarts, or even multiple days.

## Goal

Keep progress durable and recoverable without turning every task into a runaway loop.

## Core Rules

- Long-running autonomy is opt-in.
- Prefer explicit stop conditions over "never stop" language.
- Persist state to disk so another agent can resume safely.
- Do not rely on chat history alone for long-running work.
- Do not create git commits unless the user explicitly asks for them.

## Durable State Layout

Create a scoped state directory under:

```text
.opencode/workspace/autoloop/<slug>/
```

Use these files:

- `context.md` - cold-start brief for any future agent
- `state.jsonl` - append-only machine log of iterations and outcomes
- `worklog.md` - human-readable progress log
- `ideas.md` - queued follow-up ideas or next experiments
- `.paused` - sentinel file; if present, stop after the current safe checkpoint

## Setup Checklist

1. Create the state directory and initialize the files.
2. Write `context.md` with the goal, scope, constraints, success metric, files in scope, and stop conditions.
3. Start `state.jsonl` with a config/header entry describing the objective.
4. Record each iteration in both `state.jsonl` and `worklog.md`.
5. Refresh `context.md` whenever the strategy changes meaningfully.

## Resume Protocol

When resuming long-running work:

1. Read `context.md` first.
2. Read the latest entries from `state.jsonl` and `worklog.md`.
3. Check for `.paused`; if present, do not continue the loop.
4. Rebuild the next-step queue from `ideas.md` and unfinished work.
5. Continue from the last verified checkpoint instead of replaying the full history.

## Logging Rules

Each `state.jsonl` entry should capture:

- iteration number
- timestamp
- action summary
- files changed
- verification status
- outcome (`keep`, `discard`, `blocked`, `done`)
- next step

Keep the log append-only. If direction changes, start a new entry or segment; do not rewrite history.

## Safety Rails

- Stop on explicit user instruction.
- Stop when `.paused` exists.
- Stop when a destructive or irreversible decision requires user approval.
- Stop when a required credential or external dependency is missing.
- Stop when verification fails repeatedly and the issue is no longer localized.

## Best Practices

- Use `todowrite` for active execution steps and the state directory for durable recovery.
- Update `notepad_write` with durable learnings and decisions when working against a plan.
- Prefer small verified checkpoints over giant batches.
- If a run can be resumed later, leave the next step written down explicitly.

## Anti-Patterns

- Do not say "loop forever" by default.
- Do not store all state only in the conversation.
- Do not auto-commit as a checkpoint mechanism.
- Do not continue through repeated verification failures without recording the blocker.
