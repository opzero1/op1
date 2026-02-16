---
description: Initialize or refactor AGENTS.md with progressive disclosure
agent: scribe
---

Analyze this repository and create or refactor `AGENTS.md` using progressive disclosure.

Goal: keep the root `AGENTS.md` minimal, high-signal, and easy to maintain.

## Workflow

1. Audit existing instruction sources
   - Read `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CODEX.md` if present.
   - Read `.cursor/rules/*`, `.cursorrules`, and `.github/copilot-instructions.md` if present.

2. Find contradictions
   - Identify conflicting instructions.
   - If a conflict materially changes behavior and cannot be resolved from repository context, ask one focused clarification question.

3. Write a minimal root `AGENTS.md`
   - Include only what is relevant to every task:
     - One-sentence project description
     - Package manager (if not npm)
     - Non-standard build/typecheck/test commands
     - Truly global constraints
   - Keep it short (typically 10-40 lines unless the repo clearly needs more).

4. Apply progressive disclosure
   - Move domain-specific guidance to focused docs (for example: TypeScript conventions, testing patterns, API design, release process).
   - Add markdown links from root `AGENTS.md` to those docs.
   - Prefer stable capability guidance over brittle file-path maps.

5. Flag stale/low-value instructions
   - Add a short "Flagged for deletion" section (or separate markdown file) listing instructions that are:
     - redundant
     - vague or non-actionable
     - obvious boilerplate

## Output requirements

- If `AGENTS.md` already exists, update it in place.
- If `AGENTS.md` does not exist, create it.
- Keep output specific to this repository.
- Do not auto-generate long, generic documentation.
