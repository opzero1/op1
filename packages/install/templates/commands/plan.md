---
description: Create an interview-driven implementation-ready workspace plan
agent: plan
skill:
  - plan-protocol
  - grill-me
---

Create an interview-driven, implementation-ready workspace plan for the specified task.

**Task:** $ARGUMENTS

If no arguments were provided, infer the task from the surrounding conversation. If no meaningful planning target exists, ask one focused clarification question.

Workflow requirements:
1. Treat `/plan` as an interview-driven planner, not a one-shot draft writer
2. Start with repo-first exploration; for coding tasks, run a bounded internal pattern-scout pass before asking the user for decisions the repo can answer
3. Detect one primary planning kind (`implementation`, `prd`, `refactor`, `interface`, or `tdd`) plus any additive overlays (`deep-grill`, `interface-review`, `refactor-sequencing`, `tdd`, `user-story-mapping`, `dependency-modeling`, `vertical-slices`) instead of forcing a single mode
4. Use `grill-me` to resolve unresolved execution branches one-by-one:
   - If a branch can be answered from repo evidence, resolve it directly instead of asking the user
   - When user input is still needed, ask a focused forward-facing question and include your recommended answer
   - Keep the interview concrete and decision-shaping; avoid generic meta-questions
   - Prefer the native `question` tool when it helps the user decide quickly, but do not force a rigid payload shape
5. Before saving, resolve the branches required by the chosen kind and overlays, especially:
   - primary kind and active overlays
   - goal and non-goals
   - happy path / expected outcome
   - chosen pattern and blast radius
   - missing-context behavior for `/work`, approval/readiness rule, state ownership, and durable context when they materially affect execution
   - dependencies, triggers, and invariants when the plan crosses boundaries or sequences work
   - tests and verification
6. Overlay activation is additive: keep the primary kind stable, then add only the overlays justified by the task and repo evidence
7. If the scout finds a strong internal match, surface the candidate pattern with concrete file references and a minimal code example. Ask for explicit confirmation only when the pattern is a risky deviation, there are multiple viable matches, or the blast radius is non-obvious; otherwise record the repo-default path clearly in the plan
8. If the scout does not find a strong internal match, do bounded best-practice research and present one recommended fallback pattern with a small code example, then ask for explicit confirmation that the fallback is acceptable before locking it into the plan
9. Do not save any plan until required branches are resolved enough that `/work` can execute without re-interviewing the user
10. Once the branches are resolved, save the approved plan with `plan_save(mode="new", set_active=true)` or update the active plan when refining an existing plan
11. Immediately persist the resolved interview answers with `plan_context_write` when available, including `primary_kind`, `overlays`, `non_goals`, `happy_path`, `expected_outcome`, `missing_context_behavior`, `approval_readiness_rules`, `state_ownership`, `dependencies`, `triggers`, `invariants`, `question_answers_json`, and approved `pattern_examples_json`; otherwise make the saved plan + `notepad_write` the durable fallback record
12. Store approved pattern guidance in `pattern_examples_json`, including `source_type` and `code_example` when available
13. Persist the concrete file-operation change map in `file_change_map_json`, including what will be added, edited, deleted, and why
14. Answered required branches count as approval for `/work` readiness. Ask for explicit confirmation when the plan depends on a fallback, a risky deviation, or a genuinely ambiguous pattern choice
15. If the task changes planning behavior itself, add or update a planning-question-quality evaluation artifact that compares before vs. after execution clarification needs

The saved plan must be implementation-ready. It must contain:
- Confirmed primary kind and active overlays
- Confirmed goal statement
- Confirmed non-goals and expected outcome
- Confirmed repo pattern or explicit best-practice fallback
- A clear implementation reference, plus explicit approval for fallback or non-obvious pattern choices
- Affected areas and blast radius
- A concrete file change map that says what is being added, edited, deleted, or explicitly says `none`
- Missing-context behavior, readiness rules, state ownership, dependencies, triggers, and invariants
- Success criteria and failure criteria
- Test additions and verification plan
- Open risks or blockers

After the required interview branches are resolved:
1. Save or update the active-ready plan
2. Persist the latest confirmations with `plan_context_write(stage="confirmed", confirmed_by_user=true, ...)` when available, including the primary kind, overlays, and execution-branch fields; otherwise mirror the same confirmations into the saved plan and `notepad_write`
3. Inform the user: "Plan saved. Run `/work` to start implementation."
