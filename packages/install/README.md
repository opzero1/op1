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

Dry run (preview changes without writing files):

```bash
bunx @op1/install --dry-run
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

### Commands (11)

| Command | Description |
|---------|-------------|
| `/init` | Bootstrap project context and conventions |
| `/plan` | Create implementation plan |
| `/continue` | Resume unfinished work (uses continuation tools when enabled) |
| `/work` | Start working on active plan (with ULW mode) |
| `/review` | Run code review |
| `/review-loop` | Iterate reviewer/oracle review and fixes until clean |
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

### Plugins (3)

| Plugin | Description |
|--------|-------------|
| `@op1/workspace` | Plan management, notepads (always included) |
| `@op1/ast-grep` | Structural code search |
| `@op1/lsp` | Language server tools |

## Installation Flow

1. **Detect existing config** - Offers merge or replace
2. **Select components** - Agents, commands, skills, plugins
3. **Configure plugins** - Choose which plugins to enable
4. **Select MCPs** - Optional MCP integrations (Linear, Notion, etc.)
5. **Choose models** - Dropdown picker backed by `https://models.dev/api.json` (manual override supported)
6. **Install** - Copies files to `~/.config/opencode/`

## Template Layout

The installer uses plural template directories under `packages/install/templates/`:

- `agents/`
- `commands/`
- `skills/`
- `themes/`

These are copied to matching target folders:

- `~/.config/opencode/agents/`
- `~/.config/opencode/commands/`
- `~/.config/opencode/skills/`
- `~/.config/opencode/themes/`

Bundled themes are installed automatically into `~/.config/opencode/themes/`.

## SkillPointer Behavior

With default settings, installer keeps `features.skillPointer: true` and writes:

- Pointer index: `~/.config/opencode/skills/.skillpointer/index.json`
- Category pointers: `~/.config/opencode/skills/<category>-category-pointer/SKILL.md`
- Full skill bodies: `~/.config/opencode/skill-vault/<category>/<skill>/SKILL.md`

At runtime, OP7 resolves skill content from pointer+vault first, then falls back to legacy skill folders.

### Adding Custom Skills

For custom local skills, use the legacy path:

```bash
mkdir -p ~/.config/opencode/skills/my-skill
$EDITOR ~/.config/opencode/skills/my-skill/SKILL.md
```

This is immediately compatible with SkillPointer-enabled runtime through fallback resolution.

## Config Preservation

The installer intelligently preserves your settings:

- ✅ Provider credentials (API keys)
- ✅ Existing plugins (merged, not replaced)
- ✅ Custom agent models
- ✅ Permission settings
- ✅ MCP configurations

## Workspace Defaults

Installer writes workspace defaults to:

- `~/.config/opencode/workspace.json`

Key defaults for runtime safeguards:

- `safeHookCreation: false`
- `features.hashAnchoredEdit: true`
- `features.contextScout: true`
- `features.externalScout: true`
- `features.skillPointer: true`
- `features.taskGraph: true`
- `features.continuationCommands: true`
- `features.tmuxOrchestration: true`
- `features.boundaryPolicyV2: true`
- `features.claudeCompatibility: true`
- `features.mcpOAuthHelper: true`
- `features.notifications: true`
- `notifications.enabled: true`
- `features.approvalGate: false`
- `approval.mode: "off"`

Operational improvements are enabled by default; approval gating remains opt-in.

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
