# ADR-0001: v1 Learning Scope Boundary

- Status: Accepted
- Date: 2026-02-23
- Owner: @op1/workspace

## Context

`@op1/workspace` currently persists plan and notepad state in project-local storage under `.opencode/workspace/`.
The active implementation plan for SQLite + Drizzle migration requires a hard scope boundary for v1 so behavior is deterministic during migration design.

## Decision

v1 learning memory is **project-scoped only**.

- All v1 plan and notepad data is scoped to the current project.
- Cross-project learning aggregation is out of scope for v1.
- This scope is an explicit compatibility contract, not a soft preference.

## Immutability Contract

The v1 scope boundary is immutable until a v2 migration is implemented.

- Do not introduce cross-project read/write behavior in v1 paths.
- Any expansion beyond project scope requires a versioned schema migration in v2.
- v2 must define migration rules for identity, deduplication, and compatibility before changing scope.

## Consequences

- v1 behavior remains predictable and isolated per project.
- Future scope expansion is possible, but only behind explicit migration semantics.
- Documentation and schema comments must continue to reflect this boundary to avoid accidental scope drift.
