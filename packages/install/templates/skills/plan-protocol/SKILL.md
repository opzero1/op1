---
name: plan-protocol
description: Guidelines for creating and managing implementation plans with citations
---

# Plan Protocol

> **Load this skill** when creating or updating implementation plans.

## TL;DR Checklist

When creating or updating a plan, ensure:

- [ ] YAML frontmatter with `status`, `phase`, `updated`
- [ ] `## Goal` section (one sentence)
- [ ] `## Context & Decisions` table with citations (`ref:delegation-id`)
- [ ] `## Execution Contract` section with the chosen pattern, approved implementation reference, and handoff rules
- [ ] `## File Change Map` section with explicit add/edit/delete intent (or `none`)
- [ ] Phases with status markers: `[COMPLETE]`, `[IN PROGRESS]`, `[PENDING]`
- [ ] Tasks with hierarchical numbering (1.1, 1.2, 2.1)
- [ ] Only ONE task marked `← CURRENT`
- [ ] Citations for all research-based decisions

---

## When to Use

1. Starting a multi-step implementation
2. After receiving a complex user request
3. When tracking progress across phases
4. After research that informs architectural decisions

## When NOT to Use

1. Simple one-off tasks → use built-in todos instead
2. Pure research/exploration → use delegations only
3. Quick fixes that don't need tracking
4. Single-file changes with no dependencies

---

## Plan Format

Use `plan_save` with this exact markdown format:

```markdown
---
status: STATUS
phase: PHASE_NUMBER
updated: YYYY-MM-DD
---

# Implementation Plan

## Goal
ONE_SENTENCE_DESCRIBING_OUTCOME

## Context & Decisions
| Decision | Rationale | Source |
|----------|-----------|--------|
| CHOICE | WHY | `ref:DELEGATION_ID` |

## Execution Contract
- **Primary kind:** KIND
- **Active overlays:** OVERLAYS_OR_NONE
- **Chosen pattern:** PATTERN_SUMMARY
- **Approved implementation reference:** FILES_OR_SYMBOLS
- **Missing-context behavior:** WHAT_/WORK_DOES_IF_BLOCKED

## File Change Map
- **EDIT** `path/to/file.ts` — WHY_THIS_FILE_CHANGES
- **ADD** `path/to/new-file.ts` — WHY_IT_IS_NEW
- **DELETE** `path/to/old-file.ts` — WHY_IT_CAN_BE_REMOVED
- **NONE** — use this when no file additions, edits, or deletions are planned yet

## Phase 1: NAME [STATUS_MARKER]
- [x] 1.1 Completed task
- [x] 1.2 Another completed task → `ref:DELEGATION_ID`

## Phase 2: NAME [IN PROGRESS]
- [x] 2.1 Completed task
- [ ] **2.2 Current task** ← CURRENT
- [ ] 2.3 Pending task

## Phase 3: NAME [PENDING]
- [ ] 3.1 Future task
- [ ] 3.2 Another future task

## Notes
- YYYY-MM-DD: Observation or decision `ref:DELEGATION_ID`
```

### Frontmatter Fields

| Field | Values | Description |
|-------|--------|-------------|
| `status` | `not-started`, `in-progress`, `complete`, `blocked` | Overall plan status |
| `phase` | Number (1, 2, 3...) | Current phase number |
| `updated` | `YYYY-MM-DD` | Last update date |

### Phase Status Markers

| Marker | Meaning |
|--------|---------|
| `[PENDING]` | Not yet started |
| `[IN PROGRESS]` | Currently being worked on |
| `[COMPLETE]` | Finished successfully |
| `[BLOCKED]` | Waiting on dependencies |

---

## State Machine

### Plan Lifecycle
```
not-started → in-progress → complete
                         ↘ blocked
```

### Phase Lifecycle
```
[PENDING] → [IN PROGRESS] → [COMPLETE]
                         ↘ [BLOCKED]
```

### Task Lifecycle
```
[ ] unchecked → [x] checked
```

### Critical Rules

1. **Only ONE phase** may be `[IN PROGRESS]` at any time
2. **Only ONE task** may have `← CURRENT` marker at any time
3. **Move `← CURRENT`** immediately when starting a new task
4. **Mark tasks `[x]`** immediately after completing them

---

## Citations & Delegations

### Where Citations Come From

Citations reference delegation research. The flow is:

1. You delegate research: `delegate` to `researcher` or `explore`
2. Delegation completes with a readable ID (e.g., `swift-amber-falcon`)
3. You cite that research in the plan: `ref:swift-amber-falcon`

### When to Cite

| Situation | Action |
|-----------|--------|
| Architectural decision based on research | Add to Context & Decisions table |
| Task informed by research | Append `→ ref:id` to task line |
| Implementation detail from research | Inline citation in Notes |

### How to Find Delegation IDs

- Use `delegation_list()` to see all delegations
- Use `delegation_read("id")` to verify content before citing

### ❌ NEVER

- Make up delegation IDs
- Cite without actually reading the delegation
- Skip citations for research-based decisions

---

## Examples

### ✅ CORRECT: Well-formed plan

```markdown
---
status: in-progress
phase: 2
updated: 2026-01-02
---

# Implementation Plan

## Goal
Add JWT authentication with refresh token support

## Context & Decisions
| Decision | Rationale | Source |
|----------|-----------|--------|
| Use bcrypt (12 rounds) | Industry standard, balance of security/speed | `ref:swift-amber-falcon` |
| JWT with refresh tokens | Stateless auth, mobile-friendly | `ref:calm-jade-owl` |

## Execution Contract
- **Primary kind:** implementation
- **Active overlays:** deep-grill
- **Chosen pattern:** Follow the existing auth module layout and extend token persistence in-place
- **Approved implementation reference:** `src/auth/module.ts`, `src/auth/service.ts`, `issueRefreshToken`
- **Missing-context behavior:** Stop and ask one targeted question before saving the plan

## File Change Map
- **EDIT** `src/auth/service.ts` — add refresh-token issuance to the existing login flow
- **EDIT** `src/auth/module.ts` — wire the refresh-token dependency through the current auth module
- **ADD** `src/auth/refresh-token.repository.ts` — isolate refresh-token persistence behind the existing auth package boundary

## Phase 1: Research [COMPLETE]
- [x] 1.1 Research auth patterns → `ref:swift-amber-falcon`
- [x] 1.2 Evaluate token strategies → `ref:calm-jade-owl`

## Phase 2: Implementation [IN PROGRESS]
- [x] 2.1 Set up project structure
- [ ] **2.2 Add password hashing** ← CURRENT
- [ ] 2.3 Implement JWT generation

## Phase 3: Testing [PENDING]
- [ ] 3.1 Write unit tests
- [ ] 3.2 Integration tests

## Notes
- 2026-01-02: Chose bcrypt over argon2 for broader library support `ref:swift-amber-falcon`
```

### ❌ WRONG: Missing frontmatter

```markdown
# Implementation Plan

## Goal
Add authentication
```

**Error:** Plan must have YAML frontmatter with status, phase, updated.

### ❌ WRONG: Multiple CURRENT markers

```markdown
## Phase 2: Implementation [IN PROGRESS]
- [ ] **2.1 Task one** ← CURRENT
- [ ] **2.2 Task two** ← CURRENT
```

**Error:** Only one task may be marked CURRENT.

### ❌ WRONG: Decision without citation

```markdown
## Context & Decisions
| Decision | Rationale | Source |
|----------|-----------|--------|
| Use Redis | It's fast | - |
```

**Error:** Decisions must cite research with `ref:delegation-id`.

### ❌ WRONG: Invalid phase status

```markdown
## Phase 1: Research [DONE]
```

**Error:** Use `[COMPLETE]`, not `[DONE]`. Valid markers: `[PENDING]`, `[IN PROGRESS]`, `[COMPLETE]`, `[BLOCKED]`.

---

## Troubleshooting

| Error Message | Fix |
|---------------|-----|
| "Missing frontmatter" | Add `---\nstatus: in-progress\nphase: 1\nupdated: 2026-01-02\n---` at top |
| "Multiple CURRENT markers" | Remove `← CURRENT` from all but the active task |
| "Invalid citation format" | Use `ref:delegation-id` format (e.g., `ref:swift-amber-falcon`) |
| "Missing goal" | Add `## Goal` section with one-sentence description |
| "Empty phase" | Add at least one task to each phase |
| "Invalid phase status" | Use `[PENDING]`, `[IN PROGRESS]`, `[COMPLETE]`, or `[BLOCKED]` |

---

## Before Saving Checklist

Before calling `plan_save`, verify:

- [ ] **Frontmatter:** Has status, phase, and updated date?
- [ ] **Goal:** Is there a clear, one-sentence goal?
- [ ] **Citations:** Are all research-based decisions cited with `ref:id`?
- [ ] **Execution Contract:** Does the plan name the chosen pattern, approved reference, and missing-context behavior?
- [ ] **File Change Map:** Does it say what is added, edited, deleted, or explicitly `none`?
- [ ] **Single CURRENT:** Is exactly one task marked `← CURRENT`?
- [ ] **Valid markers:** Do all phases use valid status markers?
- [ ] **Hierarchical IDs:** Are tasks numbered correctly (1.1, 1.2, 2.1)?
