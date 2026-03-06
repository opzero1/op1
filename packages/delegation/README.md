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

## Task Identity

- `task_id`: durable record id used for `background_output`, `background_cancel`, and plan citations
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

Keep `~/.config/opencode/opencode.json` using package names like `@op1/workspace` and `@op1/delegation`, then smoke-test with `opencode run`.

## Tooling Surface

- `task`
- `background_output`
- `background_cancel`
- `agent_status`
- `task_graph_status`

## License

MIT
