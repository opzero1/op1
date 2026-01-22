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
2. **Load plan**: Call `plan_read` to load the active plan
3. **Load wisdom**: Call `notepad_read` to get accumulated learnings
4. **Find current task**: Locate the task marked `← CURRENT`
5. **Create todos**: Track all work with `todowrite`

## Execution Protocol

Follow ULW protocols:
- Fire parallel explore/researcher agents for context
- Track EVERY step with todos
- Verify with build/test after changes
- Update plan progress with `plan_save`
- Record learnings to notepads

## Context

$ARGUMENTS
