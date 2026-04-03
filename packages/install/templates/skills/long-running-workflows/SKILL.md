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
- Do not pause just to present a menu of safe recovery options; choose the safest reversible path and continue.

## Durable State Layout

Use existing workspace durability primitives instead of a dedicated loop directory:

- active plan (`plan_read`, `plan_save`) for checklist state and execution scope
- structured plan context (`plan_context_read`, when available) for confirmed patterns and blast radius
- notepads (`notepad_read`, `notepad_write`) for durable learnings, issues, and decisions
- continuation tools (`continuation_status`, `continuation_continue`, `continuation_stop`, `continuation_handoff`) for run-state control
- optional linked docs (`plan_doc_list`, `plan_doc_load`) for larger supporting context

## Setup Checklist

1. Create or recover an active plan that defines the goal, scope, constraints, success metric, and stop conditions.
2. Read plan context when available and notepads before resuming execution.
3. Keep one explicit unchecked task in the plan when the workflow is intentionally ongoing.
4. Record each verified checkpoint in notepads and update the plan as strategy changes.
5. Use continuation tools to mark running, stopped, or handoff state explicitly.

## Resume Protocol

When resuming long-running work:

1. Read the active plan, structured plan context when available, and relevant notepads first.
2. Check `continuation_status`; if the workflow is stopped or handed off, do not resume blindly.
3. If appropriate, move the session back to `running` with `continuation_continue` before resuming.
4. Rebuild the next-step queue from the plan, linked docs, and unfinished work.
5. Continue from the last verified checkpoint instead of replaying the full history.

## Autonomous Recovery

When the workflow is intended to run autonomously and a recoverable problem appears:

1. Prefer automatic recovery over user choice menus.
2. Restore from the safest recent checkpoint if one exists.
3. If no checkpoint exists, record the gap, start a new safe segment, and continue.
4. For autoresearch-style loops, keep going until the user explicitly stops the workflow or continuation is deliberately stopped or handed off.
5. Only stop early when the choice is destructive, irreversible, or credential-bound.

## Logging Rules

Record durable checkpoints in notepads and plan updates. Each checkpoint should capture:

- timestamp
- action summary
- verification evidence
- outcome (`keep`, `discard`, `blocked`, `done`)
- explicit next step

Keep the history append-only in notepads. If direction changes, add a new entry; do not rewrite prior decisions.

## Safety Rails

- Stop on explicit user instruction.
- Stop when continuation is explicitly stopped or handed off.
- Stop when a destructive or irreversible decision requires user approval.
- Stop when a required credential or external dependency is missing.
- Stop when verification fails repeatedly and the issue is no longer localized.
- Best-effort: when stopping cleanly, reflect that state with `continuation_stop` if continuation tools are available.

## Best Practices

- Use `todowrite` for active execution steps and plan/notepad state for durable recovery.
- Update `notepad_write` with durable learnings and decisions when working against a plan.
- Prefer one active execution plan over parallel shadow plans.
- Prefer small verified checkpoints over giant batches.
- If a run can be resumed later, leave the next step written down explicitly.

## Anti-Patterns

- Do not say "loop forever" by default.
- Do not store all state only in the conversation.
- Do not auto-commit as a checkpoint mechanism.
- Do not continue through repeated verification failures without recording the blocker.
