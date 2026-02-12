---
description: Create a strategic implementation plan for a complex task
agent: plan
---

Create a comprehensive implementation plan for the specified task.

**Task:** $ARGUMENTS

Before planning:
1. Fire parallel explore agents to understand existing codebase patterns
2. Fire researcher agents if external libraries/APIs are involved
3. Gather all context before drafting the plan

The plan must include:
- Clear goal statement (one sentence)
- Context & Decisions table with rationale
- Phased breakdown with atomic tasks
- Task dependencies and blockers
- Testing strategy considerations
- Complexity estimates per phase

After the plan is approved by the user:
1. Save the plan with `plan_save`
2. Inform the user: "Plan saved. Run `/work` to start implementation."
