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

## OpenCode beta lean

`OpenCode beta lean` is an installer profile for current beta users: keep the op1 workflow layer, trim overlap with OpenCode beta, and add extra plugins only when they still provide distinct value. Choose it during install. Audit notes live in `docs/opencode-beta-lean.md`.

At a high level, that means:

- keep curated agents, commands, and skills
- keep `@op1/workspace` and `@op1/delegation` where they still change the workflow
- treat `@op1/lsp` and `@op1/ast-grep` as optional add-ons instead of mandatory weight

## RTK companion

If you want the RTK setup path for the same companion config, run:

```bash
rtk init -g --opencode
```

RTK can lay down the companion config, but it does not intercept shell calls made by subagents. If your workflow depends on delegated shell execution, use the native op1/OpenCode path for that behavior.

Recommended readiness checks:

```bash
rtk init --show
opencode debug config
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

### Commands

| Command | Description |
|---------|-------------|
| `/init` | Bootstrap project context and conventions |
| `/plan` | Interview for an implementation-ready plan |
| `/work` | Execute the active plan (with ULW mode) |
| `/deslop` | Run a strict simplifier review/fix loop on current work |
| `/review` | Run code review |
| `/review-loop` | Iterate reviewer/oracle review and fixes until clean |
| `/find` | Find code patterns |
| `/understand` | Explain codebase components |
| `/oracle` | Consult oracle agent |
| `/research` | Research external topics |

### Skills

- `ulw` - ULTRAWORK maximum capability mode
- `long-running-workflows` - Resumable multi-hour execution workflow
- `code-philosophy` - The 5 Laws of Elegant Defense
- `frontend-philosophy` - UI/UX excellence
- `nestjs-master` - Comprehensive NestJS patterns
- `terraform-master` - Infrastructure as Code mastery
- `react-performance` - React/Next.js optimization
- `analyze-mode` - Deep analysis protocols
- `simplify` - Prefer current-state code over compatibility glue
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
- `mcp0-navigation` - Warmplane `mcp0` facade routing
- And more...

### Plugins

| Plugin | Description |
|--------|-------------|
| `@op1/workspace` | Plan management, notepads (always included) |
| `@op1/delegation` | Async task orchestration, background output, task graph, and TUI task browser wiring |
| `@op1/ast-grep` | Structural code search |
| `@op1/lsp` | Language server tools |

## Installation Flow

1. **Detect existing config** - Offers merge or replace
2. **Select components** - Agents, commands, skills, plugins
3. **Choose profile** - Standard or `OpenCode beta lean`
4. **Configure plugins** - Choose which plugins to enable
5. **Select MCPs** - Optional MCP integrations (Linear, Notion, etc.)
6. **Choose models** - Dropdown picker backed by `https://models.dev/api.json` (manual override supported)
7. **Install** - Copies files to `~/.config/opencode/` and writes `opencode.json`, `workspace.json`, and `tui.json` as needed

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

## Adding Custom Skills

For custom local skills, use the standard OpenCode path:

```bash
mkdir -p ~/.config/opencode/skills/my-skill
$EDITOR ~/.config/opencode/skills/my-skill/SKILL.md
```

The installer now keeps skill installation simple and lets OpenCode load that directory directly.

## Config Preservation

The installer intelligently preserves your settings:

- ✅ Provider credentials (API keys)
- ✅ Existing plugins (merged, not replaced)
- ✅ Existing TUI plugins in `tui.json` (merged, not replaced)
- ✅ Custom agent models
- ✅ Permission settings
- ✅ MCP configurations

## TUI Plugin Setup

When delegation is enabled, the installer also writes `~/.config/opencode/tui.json` with the published package root:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@op1/delegation"]
}
```

That is the correct published setup. OpenCode resolves the package's `./tui` export from the package root, so you should not use `@op1/delegation/tui` in `tui.json`.

## mcp0-Only Migration

`mcp0 (Warmplane)` is now the recommended default MCP category in the installer. When selected, the installer converts OpenCode to a strict facade topology instead of keeping a mixed direct-MCP setup.

On macOS, the installer now also manages a deterministic Warmplane binary path for this topology:

- target binary path: `~/.local/share/opencode/bin/warmplane`
- generated `mcp0` command uses that absolute path instead of relying on `warmplane` on `PATH`
- local verification/development can override the source binary with `OP1_WARMPLANE_BIN_PATH`
- release downloads default to the forked GitHub repo `opzero1/warmplane` and can be redirected with `OP1_WARMPLANE_GITHUB_REPO`

What the installer does deterministically:

- Keeps only `mcp.mcp0` in `~/.config/opencode/opencode.json`
- Writes the facade command as `[`"~/.local/share/opencode/bin/warmplane"`, `"mcp-server"`, `"--config"`, `"~/.config/opencode/mcp0/mcp_servers.json"`]`
- Scaffolds `~/.config/opencode/mcp0/mcp_servers.json` from the downstream MCPs you selected during install
- Removes stale direct MCP entries and matching global or per-agent tool grants so old direct tool rules do not linger
- Points Warmplane-managed OAuth state at the shared auth store (`~/.local/share/opencode/mcp-auth.json` by default)

After migration, use these runtime checks:

- `mcp0_health` to confirm the Warmplane binary, config path, auth-store visibility, and downstream readiness
- `mcp_oauth_helper` to inspect Warmplane-managed OAuth-capable downstream servers behind `mcp0`

Recommended post-install OAuth bootstrap for any downstream server that reports `not_authenticated` or `expired`:

1. `~/.local/share/opencode/bin/warmplane auth discover --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`
2. `~/.local/share/opencode/bin/warmplane auth login --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`
3. `~/.local/share/opencode/bin/warmplane auth status --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>`

If integrated login is not possible in your environment, use `~/.local/share/opencode/bin/warmplane auth start` and `~/.local/share/opencode/bin/warmplane auth exchange` instead, then re-run `mcp0_health` and `mcp_oauth_helper`.

Current provider notes:

- Figma follows the native Warmplane discovery/login flow directly.
- Linear uses native Warmplane OAuth with explicit fallback metadata in the generated config because its OAuth endpoints are documented but not exposed through MCP well-known discovery.
- Notion remains an explicit compatibility exception until PKCE + loopback behavior is validated for the MCP path, so treat any generated wrapper-based path as intentional rather than architectural success.

Troubleshooting and rollback:

- `mcp0_health` to confirm binary/config/auth-store readiness
- `mcp_oauth_helper` to inspect downstream OAuth state behind `mcp0`
- `~/.local/share/opencode/bin/warmplane auth status --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>` for provider-specific auth diagnostics
- `~/.local/share/opencode/bin/warmplane auth logout --config ~/.config/opencode/mcp0/mcp_servers.json --server <server>` to clear bad tokens before retrying login
- Restore the installer-created `opencode.json.*.bak` and `workspace.json.*.bak` files if you need to roll back from strict `mcp0` mode to the previous local config state

## Workspace Defaults

Installer writes workspace defaults to:

- `~/.config/opencode/workspace.json`

Key defaults for runtime safeguards:

- `safeHookCreation: false`
- `features.hashAnchoredEdit: true`
- `features.contextScout: true`
- `features.externalScout: true`
- `features.taskGraph: true`
- `features.continuationCommands: true`
- `features.tmuxOrchestration: true`
- `features.boundaryPolicyV2: true`
- `features.mcpOAuthHelper: true`
- `features.notifications: true`
- `notifications.enabled: true`

Operational improvements are enabled by default and rely on native OpenCode permissions.

## Manual Installation

If you prefer manual setup:

```bash
# Clone the repo
git clone https://github.com/op1/op1.git

# Copy templates to your config
cp -r op1/packages/install/templates/* ~/.config/opencode/
```

## License

MIT
