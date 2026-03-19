---
description: Resume unfinished plan execution and drive it to completion
agent: build
skill: [ulw]
---

Continue unfinished work with momentum recovery.

**Context:** $ARGUMENTS

1. Recover execution context: `plan_list`, `plan_read`, `plan_context_read`, `notepad_read`; call `plan_doc_list` only if additional plan context is needed.
2. Rebuild/update todos from unfinished plan tasks.
3. Best-effort: call `continuation_status` only when continuation tools are available.
4. If continuation tools are disabled/unavailable, skip state transition and continue from plan/todos.
5. If mode is `stopped` or `handoff`, call `continuation_continue` with a stable idempotency key and optional reason from `$ARGUMENTS`.
6. Continue automatically until all work is complete or a genuine blocker requires user input.
7. Run project-standard verification before completion and provide evidence.
8. Do not commit unless the user explicitly asks.
