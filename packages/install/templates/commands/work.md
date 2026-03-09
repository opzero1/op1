---
description: Start working on the current implementation plan (switches to build agent)
agent: build
skill:
  - ulw
---

# ULTRAWORK MODE ENABLED!

You are now the **build agent** executing the implementation plan.

## Immediate Actions

1. **Acknowledge mode**: Say "ULTRAWORK MODE ENABLED! Switching to implementation mode."
2. **Check plan set**: Call `plan_list` to view all plans and active plan
3. **Recover target plan if archived**: Call `plan_unarchive` when needed, then `plan_set_active`
4. **Load active plan**: Call `plan_read`
5. **Load wisdom**: Call `notepad_read`
6. **Load linked docs (if any)**: Call `plan_doc_list` then `plan_doc_load` (summary mode)
7. **Create todos**: Track all work with `todowrite`

## Execution Protocol

Follow ULW protocols:
- Fire parallel explore/researcher agents for context
- Track EVERY step with todos
- Verify with build/test after changes
- Update plan progress with `plan_save`
- Archive completed/superseded plans with `plan_archive` to keep active rotation clean
- Record learnings to notepads

Critical behavior requirements:
- Continue automatically through all unchecked plan tasks (no permission prompts)
- Treat runtime `<system-reminder>` blocks as authoritative enforcement for autonomy, verification, momentum, and write safety
- If extra context is needed for a phase/task, progressively load linked docs via `plan_doc_load`

## Context

$ARGUMENTS
