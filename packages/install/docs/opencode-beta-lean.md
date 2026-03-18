# OpenCode beta lean

Short audit notes for keeping op1 useful while OpenCode beta absorbs more baseline capability.

## Goal

Ship the smallest op1 profile that still preserves the parts beta does not replace yet.

## Validated beta signals

- Live beta on this workspace: `0.0.0-beta-202603171737`
- Native skill discovery is active in the beta CLI (`opencode debug skill`)
- Native session APIs are live: `/session`, `/session/:id/todo`, `/session/:id/children`
- Experimental worktree endpoint is live: `/experimental/worktree`

These checks justify a leaner install path, but not a full removal of op1 workflow layers yet.

## Keep / thin-wrap / watch

| Area | Posture | Why |
|------|---------|-----|
| `@op1/workspace` plans, notepads, continuation, worktrees, verification hooks | Keep | Still the clearest workflow value above raw beta features |
| `@op1/delegation` background output, task graph, agent health | Keep | Beta has native subagents, but op1 still adds stronger orchestration visibility |
| `@op1/ast-grep`, `@op1/lsp` | Optional by default | Useful, but the easiest overlap to trim first |
| Skill loading posture | Thin-wrap | Beta already discovers skills well; op1 should avoid extra weight where native loading is enough |
| Session and todo surfaces | Watch | Beta APIs are strong enough that op1 should avoid duplicating them unless the workflow clearly needs more |
| RTK integration | Companion only | Valuable alongside beta, but not something op1 should reimplement |

## RTK readiness checks

When using the RTK companion path, validate it with:

```bash
rtk init --show
opencode debug config
```

Treat RTK as main-agent shell compression only. Subagent shell calls are still outside its interception path today.

## Conservative deprecation shortlist

- Default fewer code-intel plugins in beta-lean installs.
- Avoid adding new wrapper behavior around native beta skills, todos, or session APIs unless op1 adds real workflow value.
- Keep plan/notepad/continuation/worktree/task-graph features until beta closes the full workflow gap, not just the naming gap.

## What stays

- Curated agents, commands, and skills that encode the op1 workflow.
- `@op1/workspace` for plans, notepads, continuity, worktrees, and verification hooks.
- `@op1/delegation` when async task orchestration and background task tooling are still needed.
- Optional code plugins such as `@op1/lsp` and `@op1/ast-grep` only when the install target wants them.
- An opt-in long-running workflow that uses durable local state instead of making every agent behave like a forever loop.

## What gets trimmed first

- Defaults that duplicate stable OpenCode beta behavior.
- Extra plugins when templates or built-in tools already cover the job.
- Broad capability bundles that increase prompt or config weight without changing outcomes.

## Removal bar

Do not remove an op1 layer just because beta has a similar feature name. Trim it when beta covers the real workflow, is stable enough for daily use, and does not regress the team path for plans, delegation, or verification.

## Migration rule of thumb

Start with the lean profile. Add op1 pieces back only when they protect a real workflow or unlock something beta still misses. Re-audit after each beta jump so op1 keeps its edge without carrying old scaffolding.

## Long-running work

For multi-hour or resumable work, prefer an explicit workflow with local state files, append-only progress logs, and a pause sentinel. Do not turn every normal op1 run into a runaway loop. The right model is opt-in durability, not default endless autonomy.
