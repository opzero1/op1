---
description: Start an opt-in resumable long-running workflow with durable local state
agent: build
skill:
  - ulw
  - long-running-workflows
  - plan-protocol
---

Set up and run a resumable long-running workflow.

**Context:** $ARGUMENTS

1. Create or recover a scoped state directory under `.opencode/workspace/autoloop/<slug>/`.
2. Initialize or refresh `context.md`, `state.jsonl`, `worklog.md`, and `ideas.md`.
3. Best-effort: call `continuation_status` when continuation tools are available; if the session is `stopped` or `handoff`, call `continuation_continue` with a stable idempotency key before resuming work.
4. Optional: call `autoloop_status` with the recovered slug for a read-only snapshot that combines `.paused` and continuation signals, but keep the dedicated autoloop plan as the lifecycle source of truth.
5. Do not call `plan_list` just to adopt the currently active feature plan before the autoloop state is recovered.
6. Create or recover a dedicated workspace autoloop plan and set it active for the duration of the run.
7. Keep one evergreen unchecked task in that plan, such as `Continue verified iterations until explicitly stopped or .paused exists`, so momentum tracks the loop instead of trying to finish a feature plan.
8. Do not use a feature plan as the lifecycle source of truth for `/autoloop`; the dedicated autoloop plan and autoloop state files own loop continuation.
9. Set `max_iterations = 50` unless the user provides a stricter cap.
10. Define explicit stop conditions and a `.paused` sentinel contract before starting the loop.
11. Use `todowrite` for current execution steps and the autoloop files for durable recovery.
12. After each meaningful iteration, append to `state.jsonl` - prefer `autoloop_checkpoint` for locked monotonic appends when concurrent autoloops or parent/child sessions may both write - update `worklog.md`, and leave the next step written down.
13. If you launch or relaunch a background autoloop worker with `task`, set `command` to `autoloop:<slug>` (or `autoloop:<slug>@<latest_iteration>` when known) so delegation can keep re-prompting that worker until `.paused`, `max_iterations`, or another real stop condition fires.
14. Locked `state.jsonl` appends do not make the rest of the loop shared-state safe; when running concurrent loops, still prefer one slug and one git worktree per loop.
15. If concurrent loops are intentional and worktree tools are available, prefer `worktree_create` so each loop gets isolated code edits as well as isolated autoloop state.
16. If `.paused` exists, `max_iterations` is reached, or a genuine blocker appears, stop cleanly after writing a checkpoint, best-effort call `continuation_stop`, and only then mark the evergreen autoloop task complete.
17. Verify changes as you go and do not commit unless the user explicitly asks.
18. While the evergreen autoloop task is still open and no stop condition has fired, do not switch into a normal completion summary or "next steps" handoff after a single checkpoint; continue directly into the next verified iteration.
19. If you need to surface progress to the user while the loop is still active, report only a concise running-status update. Do not frame the turn as completion, do not offer numbered next steps, and do not imply the loop has stopped.
