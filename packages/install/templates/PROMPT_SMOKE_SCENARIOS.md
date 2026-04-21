# Prompt Smoke Scenarios

Use these scenarios after installing the tuned templates into a real OpenCode config target.

## Goal

Validate that the GPT-5.4 prompt harness stays concise, grounded, and completion-oriented in realistic CLI flows.

## Scenarios

### 1. Repo Search
- Prompt: `Find where prompt templates are installed and how they are loaded`
- Expected behavior:
  - Routes to `explore`
  - Uses scope-first search before deep reads
  - Returns concise answer plus supporting file paths

### 2. Research + Code Example
- Prompt: `Research the best way to prompt GPT-5.4 for tool persistence in coding agents`
- Expected behavior:
  - Routes to `researcher`
  - Uses official docs first, then real-world examples
  - Cites sources and avoids stale tool references

### 3. Planning
- Prompt: `/plan make the reviewer prompt better`
- Expected behavior:
  - Runs a bounded internal pattern-scout pass before drafting
  - Detects a primary kind plus any relevant overlays instead of treating planning as single-mode
  - Deep-grills unresolved execution branches internally before surfacing the next visible question
  - First visible question proposes the repo-grounded default path and concrete likely files in scope before asking the next unresolved child branch
  - First visible question targets the next unresolved child branch, not an umbrella "should I lock this plan?" approval gate or a generic quality-target picker
  - If multiple child branches remain, asks the minimum tightly-coupled set needed for the active branch frontier and keeps the rest queued by dependency
  - Uses `grill-me` style branch-by-branch questioning and the native `question` tool only for the unresolved user decisions the repo cannot answer
  - Separates repo-owned branches (structure/precedent/files) from human-owned branches (priority pain/trade-offs/anti-goals/success bar) for broad qualitative asks
  - Continues grilling broad prompts until execution-critical branches (scope, blast radius, ownership, interfaces, sequencing, verification) are resolved before saving
  - Does not save after only scope + one optimization axis while human-owned trade-off or success branches still affect execution
  - Defers pattern approval questions until the interview has actually reached that fallback/risky/ambiguous pattern branch
  - Includes short fenced code examples directly in the question text when code context helps
  - Falls back to bounded research plus one recommended example only when repo precedent is weak
  - Uses `plan-protocol`
  - Produces a compact plan with primary kind, overlays, goal, decisions, phases, blockers, testing, approved implementation reference, and explicit execution-contract branches

### 4. Plan Execution
- Prompt: `/work`
- Expected behavior:
  - Loads plan and notepad context
  - Reuses the saved primary kind + overlay contract instead of re-interviewing the user
  - Creates todos
  - Continues automatically without asking `should I continue`
  - Treats hook reminders as enforcement, not output to repeat
  - Fails closed when there is no active plan and no small actionable task

### 5. Review
- Prompt: `/review`
- Expected behavior:
  - Reviews only changed files
  - Uses `code-review` rubric
  - Reports concise, file-grounded findings with confidence and recommendation

### 6. Long-Horizon Execution
- Prompt: `Update the build agent, add tests, and verify everything`
- Expected behavior:
  - Uses concise commentary updates only at major phase changes
  - Keeps plan/todo state current
  - Finishes with verification evidence instead of speculative completion

## Compare Before vs After

For each scenario, capture:

- elapsed time
- input tokens
- output tokens
- tool count
- repeated reminder text or duplicated policy
- whether the task finished without unnecessary permission prompts
- how many follow-up clarification questions `/work` needed before coding started
