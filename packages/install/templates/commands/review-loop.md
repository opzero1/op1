---
description: Run iterative reviewer/oracle review and fix loops until clean
agent: build
skill:
  - ulw
---

Run an iterative review-and-fix loop using reviewer as primary gate and oracle for strategic tie-breaks.

**Input:** $ARGUMENTS

## Review Scope

1. Determine the review scope from `$ARGUMENTS`.
2. If no arguments are provided, default to all uncommitted changes:
   - `git diff`
   - `git diff --cached`
   - `git status --short` (include untracked files in scope)
   - Read full contents of changed tracked files and untracked files before review
3. If arguments are provided, resolve them using best judgement (path, commit, branch, PR reference, or explicit scope text).

## Review Loop

1. Set `max_iterations = 5`.
2. For each iteration up to `max_iterations`, run `reviewer` first (same severity/rubric as `/review`) and collect actionable findings.
3. Use `oracle` for architecture-risk/tie-break guidance when findings need strategic adjudication.
4. If no actionable issues remain, exit the loop.
5. If issues exist:
   - Apply fixes using the right implementation agent:
     - `coder` for core/runtime logic changes
     - `backend` for API/service/data issues
     - `infra` for IaC/deployment/runtime infra issues
     - `frontend` for UI/UX changes
   - Run targeted verification for the changed area (tests/lint/typecheck relevant to the fix).
6. If `max_iterations` is reached and actionable issues remain, stop and report unresolved findings with rationale.

## Completion Requirements

1. Run full verification before final output (full lint, typecheck, and tests or project-standard equivalent).
2. Summarize:
   - Scope reviewed
   - Issues found and fixed across iterations
   - Verification evidence
3. Do not commit automatically. Commit only if the user explicitly requests it.
