---
description: Create an interview-driven implementation-ready workspace plan
agent: plan
skill:
  - plan-protocol
---

Create an interview-driven, implementation-ready workspace plan for the specified task.

**Task:** $ARGUMENTS

If no arguments were provided, infer the task from the surrounding conversation. If no meaningful planning target exists, ask one focused clarification question.

Workflow requirements:
1. Treat `/plan` as an interview-driven planner, not a one-shot draft writer
2. Start with repo-first exploration; for coding tasks, run a bounded internal pattern-scout pass before asking the user for decisions the repo can answer
3. Detect one primary planning kind (`implementation`, `prd`, `refactor`, `interface`, or `tdd`) plus any additive overlays (`deep-grill`, `interface-review`, `refactor-sequencing`, `tdd`, `user-story-mapping`, `dependency-modeling`, `vertical-slices`) instead of forcing a single mode
4. Always deep-grill unresolved execution branches internally, but keep one user-visible question at a time; this still enforces one question at a time, so if multiple gaps exist, ask the single highest-leverage unanswered question first
4.1. Ask that question in a forward-facing way that helps the human make the next decision; do not ask generic meta-questions or ask what you should ask next
5. Before saving, resolve these required branches:
   - primary kind and active overlays
   - goal and non-goals
   - happy path / expected outcome
   - chosen pattern and blast radius
   - missing-context behavior for `/work`
   - approval/readiness rule for execution
   - state ownership and durable context
   - dependencies, triggers, and invariants
   - tests and verification
6. Overlay activation is additive: keep the primary kind stable, then add only the overlays justified by the task and repo evidence
7. If the scout finds a strong internal match, surface a concise `follow existing pattern?` decision with concrete file references and a minimal code example
8. If the scout does not find a strong internal match, do bounded best-practice research and present one recommended fallback pattern with a small code example for approval
9. Prefer the `question` tool with constrained options whenever the answer can be structured cleanly; use freeform only when nuance matters
10. Do not save any plan until the required interview branches are resolved enough that `/work` can execute without re-interviewing the user
11. Once the branches are resolved, save the approved plan with `plan_save(mode="new", set_active=true)` or update the active plan when refining an existing plan
12. Immediately persist the resolved interview answers with `plan_context_write` when available, including `primary_kind`, `overlays`, `non_goals`, `happy_path`, `expected_outcome`, `missing_context_behavior`, `approval_readiness_rules`, `state_ownership`, `dependencies`, `triggers`, `invariants`, `question_answers_json`, and approved `pattern_examples_json`; otherwise make the saved plan + `notepad_write` the durable fallback record
13. Store approved pattern guidance in `pattern_examples_json`, including `source_type` and `code_example` when available
13.1. Persist the concrete file-operation change map in `file_change_map_json`, including what will be added, edited, deleted, and why
14. Answered required branches count as approval for `/work` readiness; do not ask for a redundant final approval pass unless the user explicitly wants draft-only review
15. If the task changes planning behavior itself, add or update a planning-question-quality evaluation artifact that compares before vs. after execution clarification needs

The saved plan must be implementation-ready. It must contain:
- Confirmed primary kind and active overlays
- Confirmed goal statement
- Confirmed non-goals and expected outcome
- Confirmed repo pattern or explicit best-practice fallback
- Explicit approval of the chosen pattern plus a minimal example or canonical implementation reference
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
