# Bun-Native Patterns

This is a **Bun-exclusive project**. Use Bun-native APIs exclusively.

## Import Mappings

| DO NOT USE | USE INSTEAD |
|------------|-------------|
| `import * as fs from "node:fs/promises"` | `Bun.file()`, `Bun.write()` |
| `import * as path from "node:path"` | `import { join, basename, relative } from "path"` |
| `import * as os from "node:os"` | `import { homedir } from "os"` |
| `import { execFile } from "node:child_process"` | `Bun.spawn()` |
| `import { promisify } from "node:util"` | Not needed with Bun.spawn |
| `import crypto from "node:crypto"` | `new Bun.CryptoHasher()` |

## Type Mappings

| DO NOT USE | USE INSTEAD |
|------------|-------------|
| `NodeJS.ErrnoException` | `Error & { code?: string }` |
| `NodeJS.Timeout` | `ReturnType<typeof setTimeout>` |
| `NodeJS.Process` | `typeof process` |

## File Operations

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

## Command Execution

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

## Hashing

```typescript
// ❌ DON'T: Node.js style
import crypto from "node:crypto";
const hash = crypto.createHash("sha256").update(data).digest("hex");

// ✅ DO: Bun-native style
const hasher = new Bun.CryptoHasher("sha256");
hasher.update(data);
const hash = hasher.digest("hex");
```

## Error Handling

```typescript
// Bun-compatible error type guard
function isSystemError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}

// Usage with Bun.file() - no try/catch needed for existence checks
const file = Bun.file(path);
if (!(await file.exists())) {
  return null;
}
const content = await file.text();
```
