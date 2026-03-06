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

## Plugin Testing

### Quick Path

Use this flow when verifying local plugin changes against the real OpenCode CLI:

```bash
# Build the local plugin packages
bun run build

# Register local packages globally
bun link --cwd packages/workspace
bun link --cwd packages/delegation
bun link --cwd packages/ast-grep
bun link --cwd packages/lsp

# Link them into the global OpenCode config directory
bun link @op1/workspace @op1/delegation @op1/ast-grep @op1/lsp --cwd ~/.config/opencode

# Keep plugin entries as package names in ~/.config/opencode/opencode.json
opencode debug config | jq '.plugin'
```

Then run a real smoke check with `opencode run`.

### Detailed Workflow

The reliable local-dev path is **package-name plugins + `bun link`**, not direct `file://.../dist/*.js` plugin entries.

1. Build the packages you changed.
2. Run `bun link` inside each local package you want OpenCode to load.
3. Run `bun link <package...> --cwd ~/.config/opencode` so the global config resolves those package names to the local repo.
4. Keep `~/.config/opencode/opencode.json` using package names like `@op1/workspace` and `@op1/delegation`.
5. Use `opencode debug config` to verify the resolved plugin list before smoke testing.
6. Use `opencode run` for deterministic smoke checks of tool behavior.

### Notes

- Official docs do not fully spell out this local plugin workflow; treat `opencode debug config` plus the live CLI behavior as the contract.
- `opencode debug config` may resolve linked package names to `file://` URLs internally. That is expected after linking; the config should still *declare* package names.
- If a plugin reads workspace config, also verify `~/.config/opencode/workspace.json` is updated for renamed tools like `background_cancel`.
