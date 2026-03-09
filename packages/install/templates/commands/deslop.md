---
description: Run a strict de-slop review/fix loop on the current worktree
agent: build
skill:
  - ulw
  - analyze-mode
  - simplify
  - code-philosophy
---

Run a strict de-slop review and fix loop on the current worktree.

**Scope:** $ARGUMENTS

If `$ARGUMENTS` is empty, default to the current branch diff against the resolved base branch.
If that diff is unavailable or empty, fall back to the current uncommitted worktree scope and state which scope you used.

## Scope Resolution

1. Resolve the review scope before making changes.
2. If `$ARGUMENTS` names files, directories, commits, or a branch, use that exact scope first.
3. Otherwise resolve the base branch in this order: explicit user mention, PR/base-branch context, remote default branch, upstream tracking metadata only when it clearly points to the target branch rather than the current feature branch, then a clearly stated last-resort repo heuristic.
4. Prefer `git diff --name-only <resolved-base>...HEAD` for branch-owned work.
5. Ignore unrelated dirty files outside scope unless the user explicitly includes them.
6. If a file is ambiguous, keep it in scope only when it materially affects the current work.

## Review Contract

```xml
<output_contract>
- Keep the work exhaustive and the final report concise.
- Apply safe fixes directly; report risky or low-confidence issues instead of forcing them.
- Return exactly: scope reviewed, resolved base branch or fallback basis, issues found, fixes applied, items kept for now, verification evidence, recommended next step.
</output_contract>

<tool_persistence_rules>
- Use parallel exploration first to map changed files and likely hygiene issues.
- Do not stop at the first issue category; cover the full scoped diff.
- If certainty is low, keep the code and report the concern explicitly.
</tool_persistence_rules>

<verification_loop>
- Run diagnostics on touched files.
- Run package-appropriate lint, typecheck, and focused tests.
- Do not claim a cleanup is complete without evidence.
</verification_loop>
```

## What To Review

Audit the scoped files for these hygiene issues:

1. **Unrelated branch noise**
   - Flag changes that do not belong to the current work scope.
   - Revert them only when they are clearly branch-owned and safe to remove.

2. **Dead or redundant code**
   - Remove provably unused exports, helpers, constants, styles, tests, and duplicate barrel exports.
   - Keep lower-confidence candidates unless they become clearly safe.

3. **Current-state simplification**
    - Prefer today's implementation path over compatibility adapters, aliases, fallback branches, and migration glue.
    - Keep compatibility code only when an active external or documented contract still requires it.
    - If temporary compatibility code survives, require explicit deletion criteria and a tracking task or rationale in the same diff.

4. **Hook overuse**
   - Review `useMemo`, `useCallback`, and similar memoization.
   - Keep them only when they protect real cost or identity requirements.

5. **Helper, type, and constant placement**
   - Keep implementation details local unless they are genuinely shared.
   - Prefer feature-local modules or conventional local files like `utils.ts`, `types.ts`, and `constants.ts`.

6. **Styled wrapper justification**
   - Remove wrappers that only restate base component or design-system defaults.
   - Keep wrappers that encode meaningful layout, semantics, or behavior.

7. **Import hygiene**
   - Consolidate duplicate imports and clean obvious ordering or grouping issues.

8. **Boolean default noise**
   - Remove needless boolean defaults only when behavior stays unchanged and fail-closed.

9. **Type inference noise**
   - Prefer inference for obvious local implementation details.
   - Keep explicit types for public contracts, widening control, and non-obvious boundaries.

10. **Extraction opportunities**
   - Extract pure helpers, schemas, or form types when a file mixes concerns or grows too noisy.
   - Do not create tiny abstractions unless they remove real duplication or clutter.

11. **Asset placement**
     - Keep assets in the right local module structure and preserve the required import mode.

12. **Temporary artifacts**
     - Remove parity matrices, audit notes, or implementation-only artifacts that are no longer needed by runtime code or tests.

## Execution Protocol

1. Launch parallel `explore` work to:
   - map the changed scope
   - find dead-code, hook, import, and wrapper candidates
   - read nearby conventions and module patterns
2. Use `oracle` to classify ambiguous candidates into:
   - do now
   - keep for now
   - risky / insufficient confidence
3. Apply only the safe fixes.
4. Run `reviewer` on the final changed scope.

## Safety Rules

1. Do not remove or move anything unless confidence is high.
2. Do not commit automatically.
3. Do not revert unrelated user work outside the scoped diff.
4. If an item does not clear the certainty bar, keep it and report it.

## Verification Requirements

After changes:

1. Run diagnostics on all touched files.
2. Run project-appropriate verification for the touched package(s):
   - lint
   - typecheck
   - focused tests
3. Report:
   - what was removed or simplified
   - what was moved and why
   - what was intentionally kept and why
   - exact verification evidence
