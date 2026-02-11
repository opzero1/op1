---
description: Run comprehensive code review on specified files or recent changes
agent: reviewer
---

Perform a comprehensive code review following the code-review skill methodology.

**Input:** $ARGUMENTS

## Determining What to Review

Based on the input, determine which type of review to perform:

1. **No arguments (default)**: Review all uncommitted changes
   - Run: `git diff` for unstaged changes
   - Run: `git diff --cached` for staged changes
   - Run: `git status --short` to identify untracked (net new) files — read their full contents

2. **"recent"**: Review changes since last commit
   - Run: `git diff HEAD~1`

3. **Commit hash** (40-char SHA or short hash like `abc1234`): Review that specific commit
   - Run: `git show $ARGUMENTS`

4. **Branch name**: Compare current branch against that branch
   - Run: `git diff $ARGUMENTS...HEAD`

5. **PR URL or number** (contains `github.com/pull/` or looks like `#123` or just a number): Review the pull request
   - Run: `gh pr view $ARGUMENTS` to get PR metadata
   - Run: `gh pr diff $ARGUMENTS` to get the diff

6. **File or directory path**: Review the specified path(s)
   - Read the file(s) directly

Use best judgement when the input is ambiguous.

## Gathering Context

**Diffs alone are not enough.** After getting the diff:

1. Identify which files changed from the diff output
2. **Read the full file** for each changed file — code that looks wrong in isolation may be correct given surrounding logic
3. Check for project conventions (AGENTS.md, CONVENTIONS.md, .editorconfig)
4. Use `git status --short` to find untracked files and read those too

## Steps

1. Load the `code-review` skill
2. If reviewing frontend code, also load `frontend-philosophy`
3. If reviewing backend code, also load `code-philosophy`
4. Apply the 4 Review Layers (Correctness, Security, Performance, Style)
5. Classify findings by severity (Critical → Major → Minor → Nit)
6. Only report findings with ≥80% confidence
7. Include a Merge Recommendation (Ready / Needs Changes)
8. Provide Philosophy Compliance checklist results
