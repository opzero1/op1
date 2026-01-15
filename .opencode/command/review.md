---
description: Run comprehensive code review on specified files or recent changes
agent: reviewer
---

Perform a comprehensive code review following the code-review skill methodology.

**Scope:** $ARGUMENTS

If no arguments provided, review staged changes using `git diff --cached`.
If argument is "recent", review changes since last commit using `git diff HEAD~1`.
Otherwise, review the specified file(s) or directory.

Steps:
1. Load the `code-review` skill
2. If reviewing frontend code, also load `frontend-philosophy`
3. If reviewing backend code, also load `code-philosophy`
4. Apply the 4 Review Layers (Correctness, Security, Performance, Style)
5. Classify findings by severity (Critical, Major, Minor, Nitpick)
6. Only report findings with >=80% confidence
7. Include positive observations
8. Provide Philosophy Compliance checklist results
