---
name: ulw
description: ULTRAWORK MODE for high-stakes execution. Use for plan-driven work that needs parallel delegation, strict verification, and automatic follow-through. Prefer `/work` or an explicit ultrawork request.
---

# ULTRAWORK MODE (ULW)

> **ACTIVATION**: Say "ULTRAWORK MODE ENABLED!" when this skill is loaded.

## [CODE RED] Maximum Precision Required

YOU MUST LEVERAGE ALL AVAILABLE AGENTS TO THEIR FULLEST POTENTIAL.
TELL THE USER WHAT AGENTS YOU WILL LEVERAGE TO SATISFY THEIR REQUEST.

---

## Agent Utilization Principles

| Capability | Agent | Execution |
|------------|-------|-----------|
| Codebase Exploration | `explore` | BACKGROUND TASKS, parallel |
| Documentation & References | `researcher` | BACKGROUND TASKS, parallel |
| Planning & Strategy | `plan` agent | Dedicated work breakdown |
| High-IQ Reasoning | `oracle` | Architecture, debugging |
| Frontend/UI | `frontend` | Frontend-owned visual work |
| Code Implementation | `coder` | Atomic coding tasks |
| Code Review | `reviewer` | Before completion |

Use `frontend` for UI polish, layout, styling, components, screens/pages, responsive or accessibility polish, and design-system/shadcn work. Use `coder` for FE-adjacent logic or data wiring when the task is not frontend-owned. If a request explicitly names the wrong subagent for clearly frontend-owned implementation work, reroute to `frontend` instead of executing directly in `build`/`coder`.

---

## Execution Rules

### TODO Tracking (MANDATORY)
- Track EVERY step with `todowrite`
- Mark complete IMMEDIATELY after each step
- Never batch completions

### Parallelism

- Parallelize independent reads, lookups, and delegations.
- Keep dependent steps sequential when one result determines the next action.
- Prefer compact batches over long serial search chains.
- Use `explore` for local breadth, `researcher` for external breadth, and `oracle` only when a real decision remains.

### Momentum & Completion Promise

The `@op1/workspace` plugin provides automatic momentum:
- **Momentum**: If plan tasks remain unfinished, continuation prompts fire automatically — keep working
- **Completion tracking**: Work is tracked with iteration counts. Output `<done>COMPLETE</done>` when truly finished
- **Don't fight it**: The system expects you to keep going until all plan tasks are `[x]` checked

### Verification Loop
- Re-read original request after completion
- Check ALL requirements met before reporting done
- Load `verification-before-completion` or run an equivalent evidence-backed verification pass before final completion

### Long-Running Work

- If work is expected to span many iterations, restarts, or hours, load `long-running-workflows`.
- Use durable local state instead of relying on live chat memory alone.
- Keep long-running autonomy opt-in; do not force normal tasks into endless loops.

---

## Zero Tolerance Failures

| Violation | Consequence |
|-----------|-------------|
| **Scope Reduction** | NEVER make "demo", "skeleton", "basic" versions |
| **MockUp Work** | NEVER mock data when real implementation asked |
| **Partial Completion** | NEVER stop at 60-80% |
| **Assumed Shortcuts** | NEVER skip "optional" requirements |
| **Premature Stopping** | NEVER declare done until ALL TODOs completed |
| **Test Deletion** | NEVER delete failing tests to pass build |

**THE USER ASKED FOR X. DELIVER EXACTLY X. NOT A SUBSET. NOT A DEMO.**

---

## Workflow Summary

1. **Analyze** the request, identify required capabilities
2. **Spawn** `explore` and `researcher` work in parallel when it will materially improve correctness
3. **Plan** with gathered context when the work is complex
4. **Execute** with continuous verification against original requirements
5. **Review** with `reviewer` before completion for non-trivial changes
6. **Verify** with evidence, not assumptions
7. **Complete** only when ALL requirements proven to work

---

## Quick Reference: Agent Routing

```
// Fresh launches must never invent durable task ids.
// Omit task_id when the harness allows it; if a wrapper still requires the field, pass task_id="".

// Codebase search
task(subagent_type="explore", description="Search code", prompt="...", task_id="", run_in_background=true)

// External docs/GitHub
task(subagent_type="researcher", description="Research docs", prompt="...", task_id="", run_in_background=true)

// Strategic planning
task(subagent_type="plan", description="Plan work", prompt="...", task_id="")

// Architecture consultation
task(subagent_type="oracle", description="Review architecture", prompt="...", task_id="")

// Frontend-owned implementation
task(subagent_type="frontend", description="Implement UI change", prompt="...", task_id="")

// Non-frontend implementation
task(subagent_type="coder", description="Implement change", prompt="...", task_id="")

// Code review
task(subagent_type="reviewer", description="Review changes", prompt="Review changes in [files]", task_id="")
```
