# Testing

op1 uses **Bun's built-in test runner** (`bun test`).

## Commands

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

# Run specific test file
bun test packages/install/src/__tests__/mergeConfig.test.ts

# Run with verbose output
bun test --verbose

# Run single test by name
bun test --test-name-pattern "merges MCPs"
```

## Test Structure

Tests follow a **hybrid colocated + integration** pattern with `__tests__/` directories inside each package's `src/`.

## Global Test Utilities

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

## Writing New Tests

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

## Configuration

Tests are configured in `bunfig.toml`:

```toml
[test]
preload = ["./test-setup.ts"]
timeout = 10000
coverage = true
```
