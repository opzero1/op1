---
name: grill-me
description: Interview the user relentlessly about a plan or design until branch-level decisions are resolved for execution.
---

# Grill-Me

Use this skill when a plan/design needs stress-testing or when the user asks to be grilled.

## Core Behavior

- Walk unresolved decision branches one-by-one until the plan is implementation-ready.
- Resolve branch dependencies explicitly instead of leaving hidden assumptions.
- Ask one focused question at a time.
- For each question, provide your recommended answer first, then ask the user to confirm or override it.
- Keep questions concrete, forward-facing, and specific to execution choices.

## Repo-First Rule

- If a question can be answered from the codebase, existing plans, or saved context, explore and resolve it directly.
- Ask the user only for decisions the repo cannot answer.

## Planning Handoff Rule (op1)

- Do not stop at discussion quality alone; continue until `/work` can execute without re-interviewing the same branches.
- Ensure confirmed answers are persisted through the normal planning path (`plan_save`, `plan_context_write` when available, otherwise saved plan + `notepad_write`).
