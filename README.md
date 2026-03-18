# op1

OpenCode harness with batteries included. Minimal plugins, maximum capability via skills and commands.

## Installation

```bash
bunx @op1/install
```

The interactive installer will:
- Back up your existing config (if any)
- Install a lean set of agent/command/skill templates
- Configure workspace-first plugins (`@op1/workspace`, `@op1/delegation`, and optional `@op1/lsp` / `@op1/ast-grep`)
- Configure MCP servers (Context7 and Grep.app by default, with optional categories)
- Let you configure per-agent models or a global model

### OpenCode beta lean

`OpenCode beta lean` is an installer profile for current beta users: keep the op1 workflow layer, trim overlap with OpenCode beta, and add heavier plugins only when they still change the outcome. Choose it during install, then see `packages/install/docs/opencode-beta-lean.md` for the audit notes.

### RTK companion

If you want RTK to scaffold the same companion path, use:

```bash
rtk init -g --opencode
```

That path can set up the OpenCode companion config, but RTK does not intercept shell calls made inside subagents. Keep that limitation in mind if your workflow depends on delegated shell execution.

Quick readiness checks:

```bash
rtk init --show
opencode debug config
```

### Manual Installation

If you prefer manual setup:

```bash
# Install plugins in your project
bun add @op1/workspace @op1/delegation @op1/lsp @op1/ast-grep
```

Then add to your `opencode.json`:

```json
{
	"plugin": ["@op1/workspace", "@op1/delegation", "@op1/lsp", "@op1/ast-grep"]
}
```

## Packages

### Core

| Package | Description | Install |
|---------|-------------|---------|
| [`@op1/install`](https://www.npmjs.com/package/@op1/install) | Interactive CLI installer | `bunx @op1/install` |
| [`@op1/workspace`](https://www.npmjs.com/package/@op1/workspace) | Plan management, notepads, verification hooks | `bun add @op1/workspace` |
| [`@op1/delegation`](https://www.npmjs.com/package/@op1/delegation) | Async `task` override, background output, cancellation, task diagnostics | `bun add @op1/delegation` |

### Code Tools

| Package | Description | Install |
|---------|-------------|---------|
| [`@op1/ast-grep`](https://www.npmjs.com/package/@op1/ast-grep) | AST-aware code search and replace (25 languages) | `bun add @op1/ast-grep` |
| [`@op1/lsp`](https://www.npmjs.com/package/@op1/lsp) | Language server integration (navigation, refactoring) | `bun add @op1/lsp` |

## What's Included

op1 keeps the plugin layer lean and ships reusable templates for everything else.

- Agent templates: `packages/install/templates/agents/`
- Command templates: `packages/install/templates/commands/`
- Skill templates: `packages/install/templates/skills/`

These are copied to `~/.config/opencode/` by the installer and can be customized per machine.

## Adding New Skills

The simplest way to add a custom skill is to create a local skill folder:

```bash
mkdir -p ~/.config/opencode/skills/my-skill
$EDITOR ~/.config/opencode/skills/my-skill/SKILL.md
```

OpenCode will discover skills from that directory directly.

## Configuration

After installation, your `~/.config/opencode/opencode.json` will include:

```json
{
	"plugin": ["@op1/workspace", "@op1/delegation", "@op1/lsp", "@op1/ast-grep"],
	"model": "your-configured-model",
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "grep_app": { "type": "remote", "url": "https://mcp.grep.app" }
  }
}
```

## mcp0 (Warmplane Port)

`mcp0` is the local MCP control-plane path for token-efficient MCP usage in op1.

- Installer category: `mcp0 (Warmplane)`
- Installer default: recommended and preselected on macOS, or when `warmplane` is already available on `PATH`
- Expected command: `~/.local/share/opencode/bin/warmplane mcp-server --config ~/.config/opencode/mcp0/mcp_servers.json`
- Intended compact tool namespace: `mcp0_*`

When selected in the installer, op1 rewrites the local MCP topology to a single `mcp0` facade entry, scaffolds `~/.config/opencode/mcp0/mcp_servers.json` for the chosen downstream MCPs, and removes stale direct MCP tool grants so the client does not keep a mixed direct+facade configuration.

For the current macOS-first shipping path, `@op1/install` also manages the Warmplane binary under `~/.local/share/opencode/bin/warmplane` so `mcp0` does not depend on a separately managed Rust or Homebrew install.

Use `mcp0_health` for binary/config/readiness checks and `mcp_oauth_helper` for Warmplane-managed OAuth visibility behind the facade.

For OAuth-backed downstream MCPs behind `mcp0`, the normal operator flow is:

1. `~/.local/share/opencode/bin/warmplane auth discover --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`
2. `~/.local/share/opencode/bin/warmplane auth login --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`
3. `~/.local/share/opencode/bin/warmplane auth status --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`

If integrated login is not convenient, fall back to `~/.local/share/opencode/bin/warmplane auth start` followed by `~/.local/share/opencode/bin/warmplane auth exchange`.

Provider notes:

- Figma is the cleanest standards-first native path.
- Linear uses native Warmplane OAuth with explicit fallback metadata because its OAuth endpoints are documented but not discoverable through the MCP well-known chain.
- Notion should still be treated as a compatibility exception until PKCE + loopback redirect behavior is verified end to end.

When enabled, keep mcp0 available only to agents that need it (for example `researcher`, `coder`, `frontend`) to reduce unnecessary tool-surface exposure.

### Per-Agent Models

Configure different models for different agents:

```json
{
  "agent": {
    "build": { "model": "anthropic/claude-opus-4-20250514" },
    "explore": { "model": "anthropic/claude-haiku-3-5-20241022" },
    "oracle": { "model": "openai/gpt-4o" }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Typecheck
bun run typecheck

# Lint
bun run lint
```

## License

MIT
