---
name: code-review
description: Comprehensive code review methodology. 4 layers, severity classification, merge recommendation, 80% confidence threshold. Scope restricted to changed files.
---

# Code Review Skill

## TL;DR

Systematic code review across 4 layers with severity classification. Scope restricted to changed files only. Report findings with ≥80% confidence, file:line references, and actionable suggestions. End with a merge recommendation.

---

## Scope Rules

1. Review **only files changed** in the diff, branch, or PR.
2. Do not comment on untouched files unless required for direct impact analysis.
3. No speculative issues — every finding must map to concrete code in changed files.
4. Prefer correctness and architectural issues over style nits.
5. Provide an actionable fix suggestion for every finding.

---

## The 4 Review Layers

Apply in priority order:

### Layer 1: Correctness & Safety
- Logic errors, off-by-one, incorrect conditionals
- Edge cases: null/empty/undefined inputs, error conditions, race conditions
- Error handling completeness — silent failure paths, swallowed catches, hidden fallbacks
- Incorrect error semantics (auth vs config vs runtime errors)
- Type safety and null checks
- **Behavioral changes** — flag if a change alters existing behavior, intentionally or not

### Layer 2: Security
- No hardcoded secrets or API keys
- Input validation and sanitization
- Injection vulnerability prevention (SQL, XSS, command)
- Authentication and authorization checks
- Sensitive data not logged
- OWASP Top 10 awareness

### Layer 3: Performance
- N+1 query patterns, O(n²) on unbounded data
- Blocking I/O on hot paths
- Unnecessary re-renders (React/frontend)
- Memory leak prevention, missing cleanup
- Only flag if obviously problematic — don't invent hypotheticals

### Layer 4: Style & Maintainability
- Adherence to project conventions (check AGENTS.md, .editorconfig)
- Code duplication (DRY violations)
- Excessive nesting (>3 levels) — suggest early returns or extraction
- Test coverage for changed behavior and key unhappy paths
- Assertions validate intent, not implementation accidents

---

## Severity Classification

| Severity | Icon | Criteria | Blocks Merge? |
|----------|------|----------|---------------|
| Critical | 🔴 | Security vulnerabilities, crashes, data loss, corruption, production outage risk | **Yes** |
| Major | 🟠 | Bugs, reliability risk, missing error handling, significant architectural violation | **Yes** |
| Minor | 🟡 | Code smells, maintainability issues, moderate improvements, test gaps | No |
| Nit | 🟢 | Style preferences, naming suggestions, readability consistency | No |

### Blocking vs Non-Blocking

- **Blocking** = Critical + Major → triggers "Needs changes" recommendation
- **Non-blocking** = Minor + Nit → can merge, fix later or optionally in this PR

---

## Confidence Threshold

**Only report findings with ≥80% confidence.**

If uncertain about an issue:
- State the uncertainty: "Potential issue (70% confidence): ..."
- Suggest investigation rather than assert a problem
- Prefer false negatives over false positives (reduce noise)
- If you can't verify, say "I'm not sure about X" rather than flag it

---

## Review Process

1. **Identify Scope** — List all changed files from the diff
2. **Read Full Files** — Diffs alone aren't enough. Read complete files to understand control flow, surrounding patterns, and existing error handling
3. **Check Conventions** — Look for AGENTS.md, CONVENTIONS.md, .editorconfig for project-specific rules
4. **Deep Analysis** — Apply all 4 layers systematically to each changed file
5. **Detect Behavioral Changes** — Any change to observable behavior should be explicitly noted
6. **Philosophy Check** — Verify against code-philosophy (5 Laws) if applicable
7. **Synthesize Findings** — Group by severity, deduplicate, count blocking issues
8. **Merge Recommendation** — Ready if 0 blocking; Needs changes if ≥1 blocking

---

## Output Format

### Per-Finding Format

```markdown
#### [SEVERITY: critical|major|minor|nit] File: <path> Line: <line-or-range>
**Issue:** <clear problem statement>
**Suggestion:** <specific fix or approach>
```

### Full Review Structure

```markdown
**Files Reviewed:** [list all files]

**Overall Assessment:** APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION

**Summary:** [2-3 sentences — what the change does, overall quality]

### Findings

(findings listed with severity, each with file:line, issue, suggestion)

### 🟢 Positive Observations
[What's done well — always include at least one]

### Philosophy Compliance
- Early Exit: [PASS|FAIL|N/A]
- Parse Don't Validate: [PASS|FAIL|N/A]
- Atomic Predictability: [PASS|FAIL|N/A]
- Fail Fast: [PASS|FAIL|N/A]
- Intentional Naming: [PASS|FAIL|N/A]

### Review Summary
- Blocking: <n> (critical + major)
- Non-blocking: <n> (minor + nit)
- Recommendation: <Ready to merge | Needs changes>
```

---

## Exclusions

- Do NOT propose broad refactors outside the changed scope
- Do NOT request cosmetic rewrites unless they hide real risk
- Do NOT include praise/fluff — keep comments direct and useful
- Do NOT be a zealot about style — some "violations" are acceptable when they're the simplest option
- Do NOT flag something as a bug if you're unsure — investigate first

---

## Adherence Checklist

Before completing a review, verify:
- [ ] Scope restricted to changed files only
- [ ] All 4 layers analyzed (Correctness, Security, Performance, Style)
- [ ] Severity assigned to each finding
- [ ] Confidence ≥80% for all reported issues (or uncertainty stated)
- [ ] File:line references included for all findings
- [ ] Actionable suggestion provided for every finding
- [ ] Behavioral changes flagged explicitly
- [ ] Positive observations noted
- [ ] Blocking/non-blocking counts tallied
- [ ] Merge recommendation included
