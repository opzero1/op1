# op1

OpenCode harness with batteries included - minimal plugins, maximum capability via skills and commands.

## Packages

### Core

| Package | Description |
|---------|-------------|
| `@op1/install` | Interactive CLI installer |
| `@op1/notify` | Desktop notifications, focus detection |
| `@op1/workspace` | Plan management, notepads, safety hooks, worktree isolation |

### Code Intelligence

| Package | Description |
|---------|-------------|
| `@op1/code-intel` | Hybrid semantic search, symbol graphs, call analysis (recommended) |
| `@op1/ast-grep` | AST-aware code search and replace |
| `@op1/lsp` | Language server integration |
| ~~`@op1/semantic-search`~~ | _(deprecated → use `@op1/code-intel`)_ |
| ~~`@op1/code-graph`~~ | _(deprecated → use `@op1/code-intel`)_ |

### Workspace Features (`@op1/workspace`)

| Feature | Description |
|---------|-------------|
| Dynamic Output Truncation | Token-aware truncation of chatty tool output |
| Non-Interactive Guard | Blocks vim/nano/less/interactive git in headless sessions |
| Preemptive Compaction | Triggers summarization at 78% token usage |
| Plan Context Recovery | Re-injects plan during compaction so agent never forgets |
| Momentum | Auto-continuation prompts when plan tasks remain unfinished |
| Completion Promise | Iteration tracking with `<done>COMPLETE</done>` signal |
| Write Policy | Warns orchestrator to delegate edits to subagents |
| Task Reminder | Nudges agent after 10 tool calls without plan usage |
| Worktree Isolation | Git worktree tools for parallel task branches |

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build all packages
bun run typecheck    # Typecheck all packages
bun run lint         # Lint
bun run format       # Format
```

## Hard Rules

- **Bun only** - use Bun commands/package manager across this monorepo.
- **Plugin exports** - keep package exports clean and explicit from each package entry.
- **Testing discipline** - ship with passing typecheck/build and run targeted tests when behavior changes.

## Debugging

```bash
# Clean and rebuild
rm -rf packages/*/dist && bun run build

# Check specific package
bun --filter @op1/workspace run typecheck

# Run with debug output
DEBUG=* bun run packages/install/bin/cli.ts
```
