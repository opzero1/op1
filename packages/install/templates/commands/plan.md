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
2. Start with repo-first exploration; use researcher only when local precedent is weak or absent
3. Ask structured confirmation questions before finalizing the plan:
   - confirm the goal, chosen pattern, and blast radius
   - confirm success criteria, failure criteria, and test plan
4. Prefer the `question` tool with constrained options whenever the answer can be structured cleanly
5. Persist confirmed planning context with `plan_context_write`
6. Save the refined draft with `plan_save(mode="draft")` before final approval
7. When the user approves the final draft, promote it with `plan_promote`

The refined plan must be implementation-ready before promotion. It must contain:
- Confirmed goal statement
- Confirmed repo pattern or explicit best-practice fallback
- Affected areas and blast radius
- Success criteria and failure criteria
- Test additions and verification plan
- Open risks or blockers

After final approval:
1. Save or update the latest draft plan if needed
2. Persist the latest confirmations with `plan_context_write(stage="confirmed", confirmed_by_user=true, ...)`
3. Call `plan_promote`
4. Inform the user: "Plan saved. Run `/work` to start implementation."
