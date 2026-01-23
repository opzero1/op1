# op1

OpenCode harness with batteries included. Minimal plugins, maximum capability via skills and commands.

## Installation

```bash
bunx @op1/install
```

The interactive installer will:
- Back up your existing config (if any)
- Install 11 agents, 8 commands, and 35 skills
- Configure MCP servers (Z.AI, Linear, Notion, New Relic, Figma, Context7, Grep.app)
- Set up plugins for notifications and workspace management
- Let you configure per-agent models or a global model

### Manual Installation

If you prefer manual setup:

```bash
# Install plugins in your project
bun add @op1/notify @op1/workspace
```

Then add to your `opencode.json`:

```json
{
  "plugin": ["@op1/notify", "@op1/workspace"]
}
```

## Packages

### Core

| Package | Description | Install |
|---------|-------------|---------|
| [`@op1/install`](https://www.npmjs.com/package/@op1/install) | Interactive CLI installer | `bunx @op1/install` |
| [`@op1/notify`](https://www.npmjs.com/package/@op1/notify) | Desktop notifications, focus detection, quiet hours | `bun add @op1/notify` |
| [`@op1/workspace`](https://www.npmjs.com/package/@op1/workspace) | Plan management, notepads, verification hooks | `bun add @op1/workspace` |

### Code Intelligence

| Package | Description | Install |
|---------|-------------|---------|
| [`@op1/ast-grep`](https://www.npmjs.com/package/@op1/ast-grep) | AST-aware code search and replace (25 languages) | `bun add @op1/ast-grep` |
| [`@op1/code-graph`](https://www.npmjs.com/package/@op1/code-graph) | Dependency graph and impact analysis | `bun add @op1/code-graph` |
| [`@op1/lsp`](https://www.npmjs.com/package/@op1/lsp) | Language server integration (navigation, refactoring) | `bun add @op1/lsp` |
| [`@op1/semantic-search`](https://www.npmjs.com/package/@op1/semantic-search) | Semantic code search with embeddings | `bun add @op1/semantic-search` |

## What's Included

### Agents (11)

| Agent | Description |
|-------|-------------|
| `backend` | NestJS/Express specialist - APIs, services, databases, queues |
| `build` | Default build agent - writes code, runs tests, ships features |
| `coder` | Implementation specialist - atomic coding tasks |
| `explore` | Codebase explorer - find files, patterns, implementations |
| `frontend` | UI/UX specialist - visual excellence |
| `infra` | Terraform/Infrastructure specialist - IaC, AWS, modules |
| `oracle` | Architecture consultant - debugging, strategic decisions |
| `plan` | Planning agent - creates detailed work breakdowns |
| `researcher` | External research - docs, GitHub, web search |
| `reviewer` | Code review - security, performance, philosophy compliance |
| `scribe` | Documentation specialist - human-facing content |

### Commands (8)

| Command | Description |
|---------|-------------|
| `/find` | Find in codebase |
| `/oracle` | Consult oracle for architecture decisions |
| `/plan` | Create implementation plans |
| `/research` | Research topics |
| `/review` | Code review |
| `/ulw` | ULTRAWORK mode - maximum capability |
| `/understand` | Deep-dive analysis of code or concepts |
| `/work` | Start focused work session |

### Skills (35)

Including: `ulw`, `code-philosophy`, `frontend-philosophy`, `nestjs-master`, `terraform-master`, `react-performance`, `playwright`, `linear`, `notion-research-documentation`, `newrelic`, `figma-design`, `git-master`, `databases`, `backend-development`, `code-review`, `analyze-mode`, `search-mode`, and more.

## Configuration

After installation, your `~/.config/opencode/opencode.json` will include:

```json
{
  "plugin": ["@op1/notify", "@op1/workspace"],
  "model": "your-configured-model",
  "mcp": {
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
    "grep_app": { "type": "remote", "url": "https://mcp.grep.app" }
  },
  "agent": {
    "backend": { "model": "anthropic/claude-sonnet-4-20250514" },
    "build": { "model": "anthropic/claude-sonnet-4-20250514" },
    "coder": { "model": "anthropic/claude-sonnet-4-20250514" },
    "explore": { "model": "anthropic/claude-sonnet-4-20250514" },
    "frontend": { "model": "anthropic/claude-sonnet-4-20250514" },
    "infra": { "model": "anthropic/claude-sonnet-4-20250514" },
    "oracle": { "model": "anthropic/claude-sonnet-4-20250514" },
    "plan": { "model": "anthropic/claude-sonnet-4-20250514" },
    "researcher": { "model": "anthropic/claude-sonnet-4-20250514" },
    "reviewer": { "model": "anthropic/claude-sonnet-4-20250514" },
    "scribe": { "model": "anthropic/claude-sonnet-4-20250514" }
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

## Acknowledgments

op1 was inspired by and builds upon ideas from these excellent projects:

- **[oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)** by [@code-yeongyu](https://github.com/code-yeongyu) - "oh-my-zsh" for OpenCode with multi-model orchestration, LSP tools, and lifecycle hooks
- **[opencode-workspace](https://github.com/kdcokenny/opencode-workspace)** by [@kdcokenny](https://github.com/kdcokenny) - Bundled multi-agent orchestration harness with strict orchestrator/implementer hierarchy

Thank you for the inspiration and contributions to the OpenCode ecosystem!

## License

MIT
