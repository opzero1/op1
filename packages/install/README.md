# @op1/install

Interactive CLI installer for op1 - OpenCode harness with batteries included.

## Quick Start

```bash
bunx @op1/install
```

Or with npm:

```bash
npx @op1/install
```

## What It Installs

### Agents (11)

| Agent | Description |
|-------|-------------|
| `backend` | NestJS/Express specialist - APIs, services, databases |
| `build` | Implementation agent - writes code, runs tests, ships |
| `coder` | Focused implementation specialist |
| `explore` | Codebase explorer - finds files and patterns |
| `frontend` | UI/UX specialist |
| `infra` | Terraform/Infrastructure specialist - IaC, AWS |
| `oracle` | High-IQ consultation for architecture |
| `plan` | Strategic planner - creates work breakdowns |
| `researcher` | External docs and API research |
| `reviewer` | Code review specialist |
| `scribe` | Documentation writer |

### Commands (8)

| Command | Description |
|---------|-------------|
| `/plan` | Create implementation plan |
| `/work` | Start working on active plan (with ULW mode) |
| `/review` | Run code review |
| `/find` | Find code patterns |
| `/understand` | Explain codebase components |
| `/oracle` | Consult oracle agent |
| `/research` | Research external topics |
| `/ulw` | Activate ULTRAWORK mode |

### Skills (35)

- `ulw` - ULTRAWORK maximum capability mode
- `code-philosophy` - The 5 Laws of Elegant Defense
- `frontend-philosophy` - UI/UX excellence
- `nestjs-master` - Comprehensive NestJS patterns
- `terraform-master` - Infrastructure as Code mastery
- `react-performance` - React/Next.js optimization
- `analyze-mode` - Deep analysis protocols
- `search-mode` - Maximum search effort
- `plan-protocol` - Plan format guidelines
- `code-review` - Review methodology
- `git-master` - Git operations mastery
- `databases` - PostgreSQL/MongoDB patterns
- `backend-development` - API design, security, testing
- `playwright` - Browser automation
- `linear` - Linear issue tracking
- `figma-design` - Figma integration
- `newrelic` - Observability
- And more...

### Plugins (7)

| Plugin | Description |
|--------|-------------|
| `@op1/workspace` | Plan management, notepads (always included) |
| `@op1/notify` | Desktop notifications |
| `@op1/code-intel` | **Code intelligence — hybrid search, symbol graphs, impact analysis** |
| `@op1/ast-grep` | Structural code search |
| `@op1/lsp` | Language server tools |
| ~~`@op1/semantic-search`~~ | *Deprecated — use `@op1/code-intel`* |
| ~~`@op1/code-graph`~~ | *Deprecated — use `@op1/code-intel`* |

## Installation Flow

1. **Detect existing config** - Offers merge or replace
2. **Select components** - Agents, commands, skills, plugins
3. **Configure plugins** - Choose which plugins to enable
4. **Select MCPs** - Optional MCP integrations (Linear, Notion, etc.)
5. **Install** - Copies files to `~/.config/opencode/`

## Config Preservation

The installer intelligently preserves your settings:

- ✅ Provider credentials (API keys)
- ✅ Existing plugins (merged, not replaced)
- ✅ Custom agent models
- ✅ Permission settings
- ✅ MCP configurations

## Manual Installation

If you prefer manual setup:

```bash
# Clone the repo
git clone https://github.com/anthropics/op1.git

# Copy templates to your config
cp -r op1/packages/install/templates/* ~/.config/opencode/
```

## License

MIT
