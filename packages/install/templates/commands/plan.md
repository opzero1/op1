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
4. Always deep-grill unresolved execution branches internally, then ask a prioritized batch of good/great forward-facing questions that helps the human think through scope, constraints, tradeoffs, and execution details
4.1. When several important ambiguities remain, ask a real multi-question round (usually 3-7 concrete questions) instead of collapsing the interview into one thin question
4.2. If there is only one material unresolved branch left, ask a single confirmation question through the `question` tool instead of silently inferring the answer
4.3. Route every user-facing clarification round through the native `question` tool by default; plain-text planning questions are not allowed unless the tool truly cannot represent the needed nuance
4.4. Do not ask generic meta-questions or ask what you should ask next
4.5. If any material unresolved branch remains, a `question` tool round is mandatory before any `plan_save`; use a single-question round when only one branch remains
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
7. If the scout finds a strong internal match, surface the candidate pattern with concrete file references and a minimal code example, then ask for explicit confirmation that the pattern is acceptable before locking it into the plan
8. If the scout does not find a strong internal match, do bounded best-practice research and present one recommended fallback pattern with a small code example, then ask for explicit confirmation that the fallback is acceptable before locking it into the plan
9. Use the native `question` tool as the default user-facing question round
9.1. Put the needed context directly in the question text when it helps the human decide: short paragraphs, bullet lists, file references, symbol names, and fenced code snippets are allowed
9.2. Ask multiple questions in one `question` round when several meaningful branches remain; do not split a good multi-question interview into multiple thin rounds
9.3. When asking the human to approve a pattern, include the relevant code example directly in the question text instead of relying on a separate tool or a second message
9.4. Do not print the actual planning questions as plain assistant prose when the `question` tool can carry them; put the questions inside the tool payload itself
9.5. Follow this shape when context-heavy questions are needed:
```ts
question({
  questions: [
    {
      header: "Pattern approval",
      question: "We found a strong repo match in `packages/install/templates/agents/plan.md`.\n\n```ts\nconst pattern = 'repo-first'\n```\n\nIs this pattern okay to use?",
      options: [
        { label: "Yes", description: "Follow the repo match" },
        { label: "No", description: "Try a fallback pattern" },
      ],
      multiple: false,
    },
    {
      header: "Scope",
      question: "Which files should this plan touch?",
      options: [
        { label: "Prompts only", description: "Keep the change in planner prompts and evals" },
        { label: "Prompts + runtime", description: "Also update workspace persistence/handoff" },
      ],
      multiple: false,
    },
  ],
})
```
10. Do not save any plan until the required interview branches are resolved enough that `/work` can execute without re-interviewing the user
10.1. A plain assistant message that merely asks questions does not count as the interview when the `question` tool could have represented those questions
11. Once the branches are resolved, save the approved plan with `plan_save(mode="new", set_active=true)` or update the active plan when refining an existing plan
12. Immediately persist the resolved interview answers with `plan_context_write` when available, including `primary_kind`, `overlays`, `non_goals`, `happy_path`, `expected_outcome`, `missing_context_behavior`, `approval_readiness_rules`, `state_ownership`, `dependencies`, `triggers`, `invariants`, `question_answers_json`, and approved `pattern_examples_json`; otherwise make the saved plan + `notepad_write` the durable fallback record
13. Store approved pattern guidance in `pattern_examples_json`, including `source_type` and `code_example` when available
13.1. Persist the concrete file-operation change map in `file_change_map_json`, including what will be added, edited, deleted, and why
14. Answered required branches count as approval for `/work` readiness, but every chosen pattern still needs explicit human confirmation; do not ask a redundant final approval pass once the branches and pattern approvals are resolved
15. If the task changes planning behavior itself, add or update a planning-question-quality evaluation artifact that compares before vs. after execution clarification needs

The saved plan must be implementation-ready. It must contain:
- Confirmed primary kind and active overlays
- Confirmed goal statement
- Confirmed non-goals and expected outcome
- Confirmed repo pattern or explicit best-practice fallback
- Explicit approval of each chosen pattern plus a minimal example or canonical implementation reference
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
