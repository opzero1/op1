# op1

OpenCode harness with batteries included. Minimal plugins, maximum capability via skills and commands.

## Installation

```bash
bunx @op1/install
```

The interactive installer will:
- Back up your existing config (if any)
- Install a lean set of agent/command/skill templates
- Configure workspace-first plugins (`@op1/workspace` + optional `@op1/lsp` and `@op1/ast-grep`)
- Configure MCP servers (Context7 and Grep.app by default, with optional categories)
- Let you configure per-agent models or a global model

### Manual Installation

If you prefer manual setup:

```bash
# Install plugins in your project
bun add @op1/workspace @op1/lsp @op1/ast-grep
```

Then add to your `opencode.json`:

```json
{
  "plugin": ["@op1/workspace", "@op1/lsp", "@op1/ast-grep"]
}
```

## Packages

### Core

| Package | Description | Install |
|---------|-------------|---------|
| [`@op1/install`](https://www.npmjs.com/package/@op1/install) | Interactive CLI installer | `bunx @op1/install` |
| [`@op1/workspace`](https://www.npmjs.com/package/@op1/workspace) | Plan management, notepads, verification hooks | `bun add @op1/workspace` |

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

## SkillPointer

SkillPointer is enabled by default and keeps startup prompts lighter by loading category pointers first, then resolving full skill bodies on demand.

- Pointer index: `~/.config/opencode/skills/.skillpointer/index.json`
- Pointer files: `~/.config/opencode/skills/<category>-category-pointer/SKILL.md`
- Full skill bodies: `~/.config/opencode/skill-vault/<category>/<skill>/SKILL.md`

Runtime resolution order is fail-safe:

1. Pointer index + vault body
2. Legacy local skill path (`~/.config/opencode/skills/<skill>/SKILL.md`)
3. External compatible roots (when configured)

### Adding New Skills

The simplest way to add a custom skill is to create a legacy skill folder:

```bash
mkdir -p ~/.config/opencode/skills/my-skill
$EDITOR ~/.config/opencode/skills/my-skill/SKILL.md
```

This works even when SkillPointer is enabled because runtime falls back to legacy skill files.

## Configuration

After installation, your `~/.config/opencode/opencode.json` will include:

```json
{
  "plugin": ["@op1/workspace", "@op1/lsp", "@op1/ast-grep"],
  "model": "your-configured-model",
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "grep_app": { "type": "remote", "url": "https://mcp.grep.app" }
  }
}
```

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
