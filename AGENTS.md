# AGENTS.md - op1

**Last Updated:** 2026-01-16
**Purpose:** AI coding assistant guidelines for op1 monorepo

## Overview

op1 is an OpenCode harness with batteries included - minimal plugins, maximum capability via skills and commands.

| Package | Description | Entry |
|---------|-------------|-------|
| `@op1/install` | Interactive CLI installer | `bunx @op1/install` |
| `@op1/notify` | Desktop notifications, focus detection | `bun add @op1/notify` |
| `@op1/workspace` | Plan management, notepads, hooks | `bun add @op1/workspace` |

## Hard Rules

### Bun Only (CRITICAL)

This is a **Bun-exclusive project**. Use Bun-native APIs exclusively.

#### Import Mappings

| DO NOT USE | USE INSTEAD |
|------------|-------------|
| `import * as fs from "node:fs/promises"` | `import { mkdir, readdir, stat } from "fs/promises"` + `Bun.file()` |
| `import * as path from "node:path"` | `import { join, basename, relative } from "path"` |
| `import * as os from "node:os"` | `import { homedir } from "os"` |
| `import { execFile } from "node:child_process"` | `Bun.spawn()` |
| `import { promisify } from "node:util"` | Not needed with Bun.spawn |
| `import crypto from "node:crypto"` | `new Bun.CryptoHasher()` |

#### Type Mappings

| DO NOT USE | USE INSTEAD |
|------------|-------------|
| `NodeJS.ErrnoException` | `Error & { code?: string }` |
| `NodeJS.Timeout` | `ReturnType<typeof setTimeout>` |
| `NodeJS.Process` | `typeof process` |

#### File Operations

```typescript
// ❌ DON'T: Node.js style
import * as fs from "node:fs/promises";
const content = await fs.readFile(path, "utf8");
await fs.writeFile(path, content);
await fs.copyFile(src, dest);

// ✅ DO: Bun-native style
const file = Bun.file(path);
const content = await file.text();
await Bun.write(path, content);
await Bun.write(dest, Bun.file(src));  // Copy file
```

#### Command Execution

```typescript
// ❌ DON'T: Node.js style
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync("git", ["status"], { cwd: dir });

// ✅ DO: Bun-native style
const proc = Bun.spawn(["git", "status"], { cwd: dir, stdout: "pipe" });
const stdout = await new Response(proc.stdout).text();
await proc.exited;
```

#### Hashing

```typescript
// ❌ DON'T: Node.js style
import crypto from "node:crypto";
const hash = crypto.createHash("sha256").update(data).digest("hex");

// ✅ DO: Bun-native style
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(data);
const hash = hasher.digest("hex");
```

### Type Safety

- Strict TypeScript everywhere
- No `as any` or `@ts-ignore`
- Prefer `unknown` over `any` for catch blocks

### Plugin Export Pattern (CRITICAL)

OpenCode's plugin loader iterates all exports and tries to call them. **Exporting classes at the top level causes runtime errors.**

```typescript
// ❌ DON'T: Export classes at plugin entry point
export { SemanticSearchPlugin } from "./plugin";
export { default } from "./plugin";
export { OpenAIEmbedder, MockEmbedder } from "./embedder";  // WRONG - classes exported!
// Error: "Cannot call a class constructor without |new|"

// ✅ DO: Only export plugin function and types
export { SemanticSearchPlugin } from "./plugin";
export { default } from "./plugin";
export type { Embedder, SearchResult } from "./types";  // Types only!
```

**Rule:** Plugin `index.ts` should ONLY export:
1. The plugin function (named + default)
2. Type definitions (`export type { ... }`)

If consumers need access to classes (e.g., `MockEmbedder` for testing), export them from a separate subpath:
```typescript
// package.json exports
"exports": {
  ".": "./dist/index.js",           // Plugin entry - no classes
  "./embedders": "./dist/embedder.js"  // Classes available separately
}
```

### Error Handling Pattern

```typescript
// Bun-compatible error type guard
function isSystemError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}

// Usage with Bun.file()
const file = Bun.file(path);
if (!(await file.exists())) {
  return null; // File not found - no try/catch needed!
}
const content = await file.text();
```

## Quick Reference

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Typecheck all packages
bun run typecheck

# Test all packages
bun test

# Test with coverage
bun test --coverage

# Test specific package
bun test packages/install

# Lint
bun run lint

# Format
bun run format

# Build single package
bun run build --filter @op1/install
```

## Structure

```
op1/
├── packages/
│   ├── install/        # @op1/install - CLI installer
│   │   ├── src/index.ts
│   │   └── templates/  # Config templates (copied by installer)
│   │       ├── agent/          # 9 agent definitions
│   │       ├── command/        # 6 slash commands
│   │       └── skill/          # 17 loadable skills
│   ├── notify/         # @op1/notify - Notifications
│   │   └── src/index.ts
│   └── workspace/      # @op1/workspace - Workspace tools
│       └── src/index.ts
├── package.json        # Bun workspaces root
├── tsconfig.json       # Shared TypeScript config
└── biome.json          # Biome linting/formatting
```

## Package-Specific Notes

### @op1/install

Interactive installer that:
1. Installs to `~/.config/opencode/` (global config)
2. Backs up existing config before changes
3. Interactive MCP selection by category
4. Merges config preserving user settings

### @op1/notify

Desktop notifications plugin with:
- Focus detection (pause notifications when OpenCode focused)
- Quiet hours support
- Sound notifications
- macOS native integration

### @op1/workspace

Workspace management plugin with:
- Plan management (create, read, update)
- Notepads for learnings/issues/decisions
- Verification hooks
- Session state persistence

## Templates

Templates are copied to user's `~/.config/opencode/` by the installer.

**Location:** `packages/install/templates/` (agents, commands, skills).

## Dependencies

| Dependency | Purpose | Package |
|------------|---------|---------|
| `@clack/prompts` | CLI prompts | create |
| `picocolors` | Terminal colors | create |
| `@opencode-ai/sdk` | OpenCode SDK | notify, workspace |
| `@opencode-ai/plugin` | Plugin interface | notify, workspace |

## Testing

### Overview

op1 uses **Bun's built-in test runner** (`bun test`) for all testing. The test suite covers critical functionality to prevent regressions after the v0.1.0 release.

**Current Coverage (v0.1.0+):**
- 58 tests across 4 test files
- ~27% overall code coverage
- Focus on high-risk areas: config merging, markdown parsing, quiet hours logic

### Test Commands

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage report
bun test --coverage

# Test specific package
bun test packages/install
bun test packages/notify
bun test packages/workspace
```

### Test Structure

Tests follow a **hybrid colocated + integration** pattern:

```
packages/
├── install/
│   └── src/
│       ├── __tests__/
│       │   ├── mergeConfig.test.ts    # Unit tests for config merging
│       │   └── fileUtils.test.ts      # Unit tests for file operations
│       └── index.ts
├── notify/
│   └── src/
│       ├── __tests__/
│       │   └── quietHours.test.ts     # Unit tests for quiet hours logic
│       └── index.ts
└── workspace/
    └── src/
        ├── __tests__/
        │   └── parsing.test.ts         # Unit tests for markdown parsing
        └── index.ts
```

### Global Test Utilities

`test-setup.ts` at the root provides shared helpers:

```typescript
import { createTempDir, initGitRepo, runGit } from "./test-setup";

// Create temp directory for filesystem tests
const { path: tempDir, cleanup } = await createTempDir();
try {
  // ... test logic
} finally {
  await cleanup();
}
```

### Writing New Tests

**1. Export functions for testing:**

```typescript
// At the end of your source file
export { functionToTest, helperFunction };
```

**2. Create test file:**

```typescript
import { describe, test, expect } from "bun:test";
import { functionToTest } from "../index";

describe("functionToTest", () => {
  test("handles basic case", () => {
    const result = functionToTest("input");
    expect(result).toBe("expected");
  });
});
```

**3. Use Bun-native APIs in tests:**

```typescript
// ✅ DO: Use Bun.file for file operations
const file = Bun.file(path);
await Bun.write(path, "content");

// ✅ DO: Use temp directories for isolation
const { path, cleanup } = await createTempDir();

// ✅ DO: Use Bun.spawn for command execution
const proc = Bun.spawn(["git", "status"], { cwd: dir, stdout: "pipe" });
```

### Test Coverage Priorities

**High Priority (Already Tested):**
- ✅ `mergeConfig` - Config merging preserves user settings
- ✅ `parsePlanMarkdown` - Plan validation and parsing
- ✅ `extractMarkdownParts` - Regex parsing logic
- ✅ `isQuietHours` - Time-based notification suppression
- ✅ File utilities - Bun-native file operations

**Medium Priority (Future Work):**
- Plan tools integration tests
- Notify plugin event handlers
- CLI interactive flows

**Low Priority:**
- Full plugin lifecycle tests
- Platform-specific notification tests

### Configuration

Tests are configured in `bunfig.toml`:

```toml
[test]
preload = ["./test-setup.ts"]
timeout = 10000
coverage = true
```

## Debugging

### Build Issues

```bash
# Clean and rebuild
rm -rf packages/*/dist
bun run build
```

### Type Errors

```bash
# Check specific package
bun run typecheck --filter @op1/workspace
```

### Test Failures

```bash
# Run specific test file
bun test packages/install/src/__tests__/mergeConfig.test.ts

# Run with verbose output
bun test --verbose

# Run single test by name
bun test --test-name-pattern "merges MCPs"
```

### Runtime Issues

```bash
# Run with debug output
DEBUG=* bun run packages/create/bin/cli.ts
```
