# @op1/fast-mode

Fast-mode plugin for OpenCode that toggles request priority on demand and applies
it only when your runtime conditions match (provider, model, agent, and enabled model target).

## What the plugin does

- Exposes a TUI fast-mode controller for direct ON/OFF toggling.
- Exposes `fast_mode` tool actions: `status`, `on`, and `off` as a low-level fallback.
- Writes/reads runtime toggles from `.opencode/fast-mode-state.json`.
- Reads guard configuration from:
  - `~/.config/opencode/fast-mode.json` (global)
  - `.opencode/fast-mode.json` (project, overrides global)
- Applies `options.serviceTier = "priority"` only when a request passes provider,
  model, and agent allowlists and the matching provider/model toggle is ON.

## Install

```bash
bun add @op1/fast-mode
```

If you install from source workspace, run the local build first:

```bash
bun run build --cwd packages/fast-mode
```

## Configure

Add plugin access in `~/.config/opencode/opencode.json`:

```json
{
	"plugin": ["@op1/fast-mode"]
}
```

If your `opencode.json` already has a plugin list, merge `@op1/fast-mode` into it.

To enable the TUI controller, also add `@op1/fast-mode` to
`~/.config/opencode/tui.json`:

```json
{
	"$schema": "https://opencode.ai/tui.json",
	"plugin": ["@op1/fast-mode"]
}
```

OpenCode resolves the package `./tui` export automatically from the package root.

### Fast-mode config file shape

Create or edit `~/.config/opencode/fast-mode.json`:

```json
{
	"enabled": true,
	"providers": {
		"openai": {
			"enabled": true,
			"agents": ["build", "coder"],
			"models": ["gpt-5.3-codex", "gpt-5.3-codex-mini"]
		}
	}
}
```

Supported fields:

- `enabled` (boolean): global feature gate for fast-mode.
- `providers` (record): provider-level config, keyed by provider ID.
- `providers.<provider>.enabled` (optional boolean): per-provider gate.
- `providers.<provider>.agents` (optional string[]): agent allowlist.
- `providers.<provider>.models` (optional string[]): model allowlist.

Project-level `/.opencode/fast-mode.json` config is merged over the global file.

You can also add a `.opencode/fast-mode.json` in a repo to tune behavior per project.

## TUI usage

Open the command palette in the OpenCode TUI and run **Fast Mode**.

The dialog shows the current ON/OFF state for:

- `openai / gpt-5.4`
- `openai / gpt-5.3-codex`

Selecting a configured provider/model pair flips its state immediately and persists it to
`.opencode/fast-mode-state.json`.

## Notes on behavior

- This plugin is **provider-first**: it matches provider ID first, then model and
  agent allowlists.
- It is currently **OpenAI-focused** because it writes `serviceTier` in the
  request options contract used by OpenAI-style providers.
- It is **model-guarded**: if model/agent/provider checks fail, no request
  mutation occurs.
- TUI toggles only control runtime provider/model state; config gates in
  `fast-mode.json` still decide whether fast mode can actually apply.

## Publishing readiness

Build now emits declarations for npm publishing:

```bash
bun run build --cwd packages/fast-mode
```

That script writes:

- `dist/fast-mode.js`
- declaration files under `dist/` (for example `dist/index.d.ts`)

Keep `dist/` committed for package publishing.

## License

MIT
