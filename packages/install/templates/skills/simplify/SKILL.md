---
name: simplify
description: Reusable simplification policy for preferring the current implementation, deleting compatibility glue, and collapsing legacy branches unless an explicit contract still requires them.
---

# Simplify

Apply this when simplifying code that has accumulated adapters, aliases, migration branches, or fallback glue.

## Default Stance

- Optimize for the system that exists now, not the one that used to exist.
- Prefer one current path over dual-path compatibility scaffolding.
- Change nearby callers to the current contract instead of adding another adapter layer.
- Prefer fail-fast diagnostics and explicit recovery steps over silent fallback behavior.

## Remove By Default

- compatibility wrappers that only translate old shapes into the new one
- legacy aliases, pass-through helpers, and one-line bridge functions
- fallback branches that preserve superseded behavior without an active contract
- compact adapters or second paths kept only because removal feels risky
- feature-flag splits that no longer represent a real rollout boundary
- migration-only comments, TODOs, or temporary files whose job is already done

## Keep Only When A Real Contract Requires It

Keep compatibility glue only when at least one is true:

1. A public API or CLI contract still promises the old shape or name.
2. A persisted schema, wire format, or stored data still depends on it.
3. An external integration outside this repository still requires it.
4. The user explicitly asks to preserve backwards compatibility.
5. Tests or docs show an intentional rollout window that is still active.

If none of those are true, simplify to the current-state path.

## If Temporary Compatibility Code Survives

Call it out in the same diff with:

1. why it still exists
2. why the canonical path is not yet sufficient
3. exact deletion criteria
4. the tracking task, ADR, or issue for removal

## Preferred Simplification Moves

- Inline trivial adapters into the single owning implementation.
- Rename callers to the current API instead of keeping permanent aliases.
- Delete dead branches immediately after the last supported path is removed.
- Collapse duplicate types/constants/helpers around one source of truth.
- Fail clearly at the boundary instead of silently translating obsolete inputs forever.
- Replace silent fallbacks with explicit operator or caller recovery steps when recovery is still needed.

## Review Questions

- Does this code exist to serve today's contract or yesterday's migration?
- Can one caller update remove an entire wrapper or fallback branch?
- Is the compatibility path proven necessary, or merely assumed?
- Would deleting the glue make the code easier to read without breaking a real consumer?

## Output Expectation

When you keep compatibility code, name the exact contract that still requires it. Otherwise, simplify to the current-state implementation and remove the glue.
