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
- Prompt: `/plan tune the reviewer prompt for less verbosity and stronger evidence requirements`
- Expected behavior:
  - Runs a bounded internal pattern-scout pass before drafting
  - Surfaces a concrete `follow existing pattern?` decision when a close repo match exists
  - Falls back to bounded research plus one recommended example only when repo precedent is weak
  - Uses `plan-protocol`
  - Produces a compact plan with goal, decisions, phases, blockers, testing, and an approved implementation reference

### 4. Plan Execution
- Prompt: `/work`
- Expected behavior:
  - Loads plan and notepad context
  - Creates todos
  - Continues automatically without asking `should I continue`
  - Treats hook reminders as enforcement, not output to repeat

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
