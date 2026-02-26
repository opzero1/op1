# OP7

OpenCode harness with batteries included. Keep plugins minimal and use commands/skills for capability.

## Core Packages

- `@op1/install` - interactive installer for agents, commands, and skills
- `@op1/workspace` - plan/notepad continuity, safety hooks, worktree tooling
- `@op1/ast-grep` - structural code search/replace
- `@op1/lsp` - language-server navigation and diagnostics

## Standard Commands

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun test
```

## Validation Guidance

- Use focused package tests for changed behavior first.
- Before completion, run the full gate: `bun run lint && bun run typecheck && bun run build && bun test`.

## Hard Rules

- **Bun only** - see `.agents/bun-patterns.md`
- **Plugin exports** - see `.agents/plugin-patterns.md`
- **Testing discipline** - see `.agents/testing.md`

## Debugging

```bash
rm -rf packages/*/dist && bun run build
bun run typecheck --filter @op1/workspace
DEBUG=* bun run packages/install/bin/cli.ts
```
