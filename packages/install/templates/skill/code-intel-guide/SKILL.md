---
name: code-intel-guide
description: Decision matrix for choosing between code-intel, LSP, and AST-grep tools when exploring or refactoring code.
---

# Code Intelligence Guide

> When to use which search tool. Load this skill when exploring an unfamiliar codebase or planning a complex refactor.
>
> **Packages:** Code intelligence is split across `@op1/code-intel` (indexed analysis), `@op1/lsp` (real-time navigation), and `@op1/ast-grep` (structural search/replace). These are complementary — use all three.

## Tool Decision Matrix

| Need | Tool | Why This One |
|------|------|-------------|
| "Find code that does X" | `smart_query` | Hybrid vector + BM25 + graph. Best recall for natural language |
| "Find symbol named X" | `symbol_search` | BM25 keyword match on symbol names. Fast, precise |
| "Who calls X?" / "What does X call?" | `call_graph` | Symbol-level caller/callee graph with depth control |
| "What breaks if I change X?" | `symbol_impact` | Transitive dependency analysis with risk scoring |
| "What are the most important files?" | `repo_map` | PageRank over import graph. Shows structural hubs |
| "Jump to where X is defined" | `lsp_goto_definition` | Real-time, single-symbol precision |
| "Find all usages of X" | `lsp_find_references` | Real-time, exhaustive within open project |
| "Rename X everywhere" | `lsp_rename` | Semantic rename across workspace |
| "Find structural pattern" | `ast_grep_search` | AST-aware pattern matching (e.g., all async functions) |
| "Replace structural pattern" | `ast_grep_replace` | AST-aware find-and-replace |
| "Check for type errors" | `lsp_diagnostics` | Real-time type checking before build |
| "Text/regex search" | `grep` | Fast regex over file contents |
| "Find files by name" | `glob` | Fast file path pattern matching |

## When to Use What

### Code Intelligence (`@op1/code-intel`)

**Best for:** Understanding codebases, exploring unfamiliar code, planning refactors, impact analysis.

- **Indexed** — searches pre-built index, not real-time
- **Semantic** — understands code meaning, not just text
- **Graph-aware** — follows call chains and dependencies
- **Token-budget aware** — `smart_query` respects context window limits

```
smart_query(query="authentication middleware that validates JWT tokens")
symbol_search(query="validateToken", symbolType="FUNCTION")
call_graph(symbolName="handleLogin", direction="callees", depth=2)
symbol_impact(symbolName="UserService", maxDepth=5)
repo_map(directory="src/", limit=10)
```

### LSP Tools (`@op1/lsp`)

**Best for:** Precise navigation, real-time type info, rename refactors, error checking.

- **Real-time** — always reflects current file state
- **Single-symbol** — operates on exact cursor positions
- **Language-aware** — understands TypeScript, Python, Go, etc.

```
lsp_goto_definition(filePath="src/auth.ts", line=42, character=10)
lsp_find_references(filePath="src/auth.ts", line=42, character=10)
lsp_diagnostics(filePath="src/auth.ts")
lsp_symbols(filePath="src/auth.ts", scope="document")
```

### AST-Grep (`@op1/ast-grep`)

**Best for:** Structural search/replace, finding code patterns regardless of naming.

- **Structural** — matches AST nodes, not text
- **Language-aware** — TypeScript, Python, Go, etc.
- **Replace capable** — can rewrite matched patterns

```
ast_grep_search(pattern="async function $NAME($$$) { $$$ }", lang="typescript")
ast_grep_replace(pattern="console.log($MSG)", rewrite="logger.info($MSG)", lang="typescript")
```

### Basic Tools (`grep`, `glob`)

**Best for:** Quick text searches, finding files by name, when you know exactly what string to look for.

```
grep(pattern="TODO|FIXME|HACK", include="*.ts")
glob(pattern="**/middleware/*.ts")
```

## Recommended Workflows

### Exploring New Codebase

```
1. repo_map(limit=15)                          → Find important files
2. smart_query(query="main entry point")       → Find where it starts
3. call_graph(symbolName="main", direction="callees") → Understand flow
```

### Planning a Refactor

```
1. symbol_search(query="OldService")           → Find the symbol
2. symbol_impact(symbolName="OldService")      → Assess blast radius
3. lsp_find_references(...)                    → All exact usages
4. call_graph(symbolName="OldService")         → Dependency chain
```

### Investigating a Bug

```
1. smart_query(query="error handling in payment flow") → Find relevant code
2. call_graph(symbolName="processPayment")     → Trace the call chain
3. lsp_goto_definition(...)                    → Navigate to specifics
4. lsp_diagnostics(...)                        → Check for type errors
```

### After Making Changes

```
1. code_intel_refresh()                        → Update index with changes
2. lsp_diagnostics(filePath="changed-file.ts") → Check for errors
```

## Index Management

| Tool | When |
|------|------|
| `code_intel_status` | Check if index is built and current |
| `code_intel_refresh` | After editing files — fast incremental update |
| `code_intel_rebuild` | First time, or after major changes (branch switch, large merge) |

## Common Mistakes

1. **Using `grep` for semantic queries** — `grep("auth")` misses `authentication`, `login`, `session`. Use `smart_query` instead.
2. **Using `smart_query` for exact symbol lookup** — `symbol_search` is faster and more precise for known names.
3. **Forgetting to refresh after edits** — Run `code_intel_refresh` after significant changes.
4. **Using `call_graph` with depth > 3** — Exponential growth. Keep depth at 2-3.
5. **Skipping `repo_map` on new codebases** — Always start here to find structural entry points.
