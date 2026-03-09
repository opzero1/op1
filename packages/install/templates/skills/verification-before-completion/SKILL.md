---
name: verification-before-completion
description: Forces agents to run verification commands and show evidence before claiming completion. Prevents "it should work" without proof.
---

# Verification Before Completion

> **Load this skill** when you need to ensure work is actually verified, not just claimed complete.

## Core Principle

**NOTHING is "done" without PROOF it works.**

Claims without evidence are worthless. Every completion claim must be backed by diagnostics, command output, or a direct manual observation.

---

## Verification Checklist

Before marking ANY task complete, verify the changed area with the smallest set of checks that can still prove correctness:

1. **Changed-file diagnostics** - Run `lsp_diagnostics` on changed files when supported.
2. **Relevant automation** - Run targeted tests first, then broader test/build/typecheck commands as needed.
3. **Manual confirmation** - Confirm the behavior and key edge cases in words when automation does not fully prove it.
4. **Regression check** - Note any pre-existing failures instead of hiding them.

---

## Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they pass? Show output. |
| "Fixed the bug" | How do you know? What did you test? |
| "Implementation complete" | Did you verify against success criteria? |
| Skipping test execution | Tests exist to be RUN |
| "The code looks correct" | Looking isn't testing. Execute it. |

---

## Evidence Format

When reporting completion, include:

```
## Verification Evidence

### Build
✅ `bun run build` - Exit code 0
Output: [paste relevant output]

### Tests
✅ `bun test` - 42 tests passed
Output: [relevant summary only]

### Type Check
✅ `lsp_diagnostics` - No errors in changed files

### Manual Check
✅ Verified [specific behavior] works as expected
```

---

## When to Load This Skill

- Before completing any implementation task
- When delegating to coder/frontend agents
- Before reporting task completion to user
- When reviewing subagent work

---

## Quick Reference

| Phase | Command | Evidence Needed |
|-------|---------|-----------------|
| Build | `bun run build` | Exit code 0 |
| Test | `bun test` | All pass |
| Types | `lsp_diagnostics` | No errors |
| Lint | `bun run lint` | No warnings |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**
