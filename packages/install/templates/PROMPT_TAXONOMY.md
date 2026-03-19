# Prompt Taxonomy

This file defines where prompt rules belong in the `op1` harness.

## Goal

Keep GPT-5.4 prompts compact, explicit, and layered so behavior is reliable without repeating the same policy in agents, commands, skills, and runtime hooks.

## Layer Ownership

| Layer | Owns | Avoid |
|------|------|-------|
| `AGENTS` | Durable role, workflow defaults, tool boundaries, completion standards | Long schemas copied from skills, command-specific dispatch logic |
| `COMMANDS` | Task framing, scope resolution, one-turn overrides, command-specific output contract | Repeating the full agent workflow or hook policy |
| `SKILLS` | Specialized reusable playbooks and domain rules | Repeating generic build/review/autonomy rules already covered elsewhere |
| Runtime hooks | Reactive enforcement, reminders, recovery, progress nudges | Broad role definitions or task-specific instructions |

## Shared GPT-5.4 Defaults

Use these defaults in high-leverage prompts:

- `output_contract`: exact sections only, concise and information-dense, no request restatement
- `default_follow_through_policy`: proceed on clear, reversible, low-risk work without asking
- `tool_persistence_rules`: keep searching or verifying when another tool call would materially improve correctness
- `dependency_checks`: resolve prerequisites first, parallelize only independent work
- `completeness_contract`: task is incomplete until requested items are done or explicitly blocked
- `verification_loop`: check correctness, grounding, format, and evidence before completion
- `terminal_tool_hygiene`: prefer dedicated tools over shell, use `workdir`, do not blur tool boundaries
- `user_updates_spec`: short commentary only at major phase changes or plan changes

## Hook Responsibilities

Treat these runtime reminders as the authoritative backstops:

- `momentum`: continue through unfinished plan tasks automatically
- `verification`: verify after implementer subagent work
- `autonomy-policy`: suppress "should I continue" and enforce internal decision rounds
- `rules-injector-lite`: read-before-write and edit safety reminders
- `task-reminder`: nudge plan/notepad/todo hygiene after long tool streaks
- `context-scout`: inject mined workspace patterns into `plan_read` and `plan_doc_load`
- optional retry plugins: package bounded evidence and expose explicit helper tools, while prompts stay thin
- `compaction` and `preemptive-compaction`: preserve active-plan context in long sessions

Prompts should orient behavior. Hooks should correct drift.

## Specialization Rules

- `build`: owns orchestration defaults, delegation, plan execution, and final verification posture
- `build`: may reference `reprompt` for bounded grounding retries, but runtime plugins own the retry packaging logic
- `plan`: owns planning-only behavior and must defer schema details to `plan-protocol`
- `reviewer`: owns review scope and must defer rubric details to `code-review`
- `coder`: owns focused implementation and must defer quality laws to the relevant philosophy skill
- `frontend`: owns visual craft and must defer design principles to frontend skills
- `researcher`: owns external evidence gathering and must stay aligned with actual available research tools
- `explore`: owns internal codebase discovery and should stay strict about tool routing

## Prompt Editing Checklist

- Prefer shortening duplicated instructions before adding new ones
- Put reusable domain rules in skills, not every agent
- Put one-turn task framing in commands, not every skill
- Keep hook-enforced text out of commands unless a short orientation sentence helps
- Use explicit output contracts when the format matters
- Add or update tests when prompt behavior depends on required sections or reminder text
