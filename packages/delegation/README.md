# @op1/delegation

Async task orchestration plugin for OpenCode.

## What It Provides

- `task` override with TUI/web-compatible `metadata.sessionId`
- background task launch via `run_in_background`
- `background_output` for status and transcript retrieval
- `background_cancel` for safe cancellation
- persistent task records with citation-friendly ids (`ref:word-word-word`)
- plugin-side metadata restoration so completed `task` tool parts stay clickable in OpenCode
- `agent_status` and `task_graph_status` read models
- `@op1/delegation/tui` for an embedded read-only delegation browser inside the OpenCode TUI (route + command entrypoints)

## Installation

```bash
bun add @op1/delegation
```

Add plugin to OpenCode config:

```json
{
	"plugin": ["@op1/workspace", "@op1/delegation"]
}
```

For the TUI task browser, also add `~/.config/opencode/tui.json`:

```json
{
	"$schema": "https://opencode.ai/tui.json",
	"plugin": ["@op1/delegation"]
}
```

Use the package root in `tui.json`. OpenCode resolves the package's `./tui` export automatically.

## Task Identity

- `task_id`: durable record id returned from `task`, used for `background_output`, `background_cancel`, and plan citations. Fresh launches should usually omit it and let the tool generate one. If an older wrapper still requires the field, pass an empty string rather than inventing a new id.
- `continue_task_id`: explicit durable record id to resume/restart an existing task record
- `session_id`: child OpenCode session id used for renderer navigation and session-level resume

## Data Layout

Runtime state is stored under:

```text
<project>/.opencode/workspace/
```

- `task-records.json` - durable task lifecycle records owned by `@op1/delegation`
- in-memory pending metadata store - temporary `(sessionID, callID)` metadata used to restore final `task` title/session linkage in `tool.execute.after`

Legacy version-3 task data in `delegations.json` is read as a fallback during migration, but new writes go to `task-records.json`.

## Local Plugin Debugging

For local verification, prefer package-name plugins plus `bun link`:

```bash
bun run build
bun link --cwd packages/workspace
bun link --cwd packages/delegation
bun link @op1/workspace @op1/delegation --cwd ~/.config/opencode
opencode debug config | jq '.plugin'
```

Keep `~/.config/opencode/opencode.json` using package names like `@op1/workspace` and `@op1/delegation`, keep `~/.config/opencode/tui.json` using `@op1/delegation`, then smoke-test with `opencode run`.

If your OpenCode build supports TUI plugins, the same installed package can also expose a read-only delegation browser through the TUI route and command palette. When launched from a session route, the browser scopes to that session context and closes back to the launching session.

For a frontend-routing smoke test under the linked local setup, launch a routed task and confirm the returned task metadata shows `Agent: frontend`:

```bash
opencode run "Use task(description=\"UI smoke\", prompt=\"Polish the React settings page responsive behavior and accessibility states.\", auto_route=true, run_in_background=true) and report the task metadata."
```

## Tooling Surface

- `task`
- `background_output`
- `background_cancel`
- `agent_status`
- `task_graph_status`

## Routing Note

Fresh launches should default to generated task ids; use `continue_task_id` for explicit resume/restart flows. If a compatibility wrapper still requires `task_id`, pass `""` for fresh launches rather than inventing one. If frontend auto-routing becomes too broad, narrow the `FRONTEND_*` routing keywords in `packages/delegation/src/router.ts` and `packages/workspace/src/delegation/router.ts` together.

## License

MIT
