---
description: Create and refine an implementation-ready workspace plan
agent: plan
skill:
  - plan-protocol
---

Create a refinement-first implementation plan for the specified task.

**Task:** $ARGUMENTS

If `$ARGUMENTS` is empty, infer the task from the surrounding conversation. If no meaningful planning target exists, ask one focused clarification question.

Workflow requirements:
1. Treat `/plan` as a staged refinement flow, not a one-shot draft
2. Start with repo-first exploration; for coding tasks, do a bounded internal pattern-scout pass before proposing implementation work
3. If the scout finds a strong internal match, surface a concise `follow existing pattern?` decision with concrete file references and a minimal code example
4. If the scout does not find a strong internal match, do bounded best-practice research and present one recommended fallback pattern with a small code example for approval
5. Ask structured confirmation questions before finalizing the plan:
   - confirm the goal, chosen pattern, and blast radius
   - confirm success criteria, failure criteria, and test plan
6. Prefer the `question` tool with constrained options whenever the answer can be structured cleanly
7. Persist confirmed planning context with `plan_context_write`
8. Store approved pattern guidance in `pattern_examples_json`, including `source_type` and `code_example` when available
9. Save the refined draft with `plan_save(mode="draft")` before final approval
10. When the user approves the final draft, promote it with `plan_promote`
11. If the task changes planning behavior itself, add or update a planning-question-quality evaluation artifact that compares before vs. after execution clarification needs

The refined plan must be implementation-ready before promotion. It must contain:
- Confirmed goal statement
- Confirmed repo pattern or explicit best-practice fallback
- Explicit approval of the chosen pattern plus a minimal example or canonical implementation reference
- Affected areas and blast radius
- Success criteria and failure criteria
- Test additions and verification plan
- Open risks or blockers

After final approval:
1. Save or update the latest draft plan if needed
2. Persist the latest confirmations with `plan_context_write(stage="confirmed", confirmed_by_user=true, ...)`
3. Call `plan_promote`
4. Inform the user: "Plan saved. Run `/work` to start implementation."
