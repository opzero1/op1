---
description: Compact the current session into a resumable checkpoint
agent: build
skill:
  - context-engineering
---

Compact the current session now.

## Workflow

1. Call `session_compact` immediately.
   - If a session ID was provided, pass it through.
   - Otherwise compact the current session.
2. Do not start planning or unrelated implementation work.
3. Report the compaction result.
   - If compaction fails, include the returned message and the next best recovery step.

## Context

$ARGUMENTS
