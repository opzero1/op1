---
description: Start an opt-in resumable long-running workflow with durable local state
agent: build
skill:
  - ulw
  - long-running-workflows
---

Set up and run a resumable long-running workflow.

**Context:** $ARGUMENTS

1. Create or recover a scoped state directory under `.opencode/workspace/autoloop/<slug>/`.
2. Initialize or refresh `context.md`, `state.jsonl`, `worklog.md`, and `ideas.md`.
3. Define explicit stop conditions and a `.paused` sentinel contract before starting the loop.
4. Use `todowrite` for current execution steps and the autoloop files for durable recovery.
5. After each meaningful iteration, append to `state.jsonl`, update `worklog.md`, and leave the next step written down.
6. If `.paused` exists or a genuine blocker appears, stop cleanly after writing a checkpoint.
7. Verify changes as you go and do not commit unless the user explicitly asks.
