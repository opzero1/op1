# op1

OpenCode harness with batteries included - minimal plugins, maximum capability via skills and commands.

## Packages

### Core

| Package | Description |
|---------|-------------|
| `@op1/install` | Interactive CLI installer |
| `@op1/notify` | Desktop notifications, focus detection |
| `@op1/workspace` | Plan management, notepads, hooks |

### Code Intelligence

| Package | Description |
|---------|-------------|
| `@op1/ast-grep` | AST-aware code search and replace |
| `@op1/code-graph` | Dependency graph and impact analysis |
| `@op1/lsp` | Language server integration |
| `@op1/semantic-search` | Semantic code search with embeddings |

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build all packages
bun run typecheck    # Typecheck all packages
bun run lint         # Lint
bun run format       # Format
```

## Hard Rules

- **Bun only** - See [.agents/bun-patterns.md](.agents/bun-patterns.md)
- **Plugin exports** - See [.agents/plugin-patterns.md](.agents/plugin-patterns.md)
- **Testing** - See [.agents/testing.md](.agents/testing.md)

## Debugging

```bash
# Clean and rebuild
rm -rf packages/*/dist && bun run build

# Check specific package
bun run typecheck --filter @op1/workspace

# Run with debug output
DEBUG=* bun run packages/install/bin/cli.ts
```
