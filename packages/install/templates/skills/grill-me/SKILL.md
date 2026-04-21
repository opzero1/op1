---
name: grill-me
description: Interview the user relentlessly about a plan or design until branch-level decisions are resolved for execution.
---

# Grill-Me

Use this skill when a plan/design needs stress-testing or when the user asks to be grilled.

Ask questions until execution-critical branches are actually resolved, not just discussed.
Drive one unresolved branch frontier at a time, and ask a small tightly-coupled set when one question cannot resolve that frontier.
Stay repo-first: if the codebase or saved context answers a branch, resolve it directly and only ask the user for decisions the repo cannot answer.
Keep a clear split between repo-owned branches (structure, precedent, affected files) and human-owned branches (priority pain, trade-offs, anti-goals, success bar).
For broad qualitative asks (improve, simplify, clean up, make nicer), do not stop after scope + one quality axis; keep pressure-testing unresolved human-owned branches that can still change execution.
If a human-owned branch is intentionally defaulted, state the default and rationale, then get explicit user acceptance before treating the interview as complete.
When useful, offer a recommended path to speed decisions, but do not treat one broad answer as `/work` readiness.
When the interview is complete, persist the resolved contract through the normal planning path (`plan_save`, `plan_context_write` when available, otherwise saved plan + `notepad_write`).
