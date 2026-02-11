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
- **Scope-aware** — filter by path prefix or file patterns to isolate projects/directories
- **Multi-granular** — search at symbol, chunk, or file level (or let `auto` decide)
- **Confidence-scored** — multi-signal confidence with diagnostics for trust calibration

```
smart_query(query="authentication middleware that validates JWT tokens")
smart_query(query="database connection pooling", pathPrefix="packages/core/")
smart_query(query="React hooks", filePatterns=["*.tsx", "*.ts"], rerank=true)
smart_query(query="error handling", granularity="symbol", maxTokens=4000)
symbol_search(query="validateToken", symbolType="FUNCTION")
call_graph(symbolName="handleLogin", direction="callees", depth=2)
symbol_impact(symbolName="UserService", maxDepth=5)
repo_map(directory="src/", limit=10)
```

### `smart_query` Parameters

| Parameter | Type | Default | Purpose |
|-----------|------|---------|---------|
| `query` | string | _(required)_ | Natural language search query |
| `maxTokens` | number | 8000 | Token budget for response context |
| `graphDepth` | number | 2 | Graph traversal depth (max 3) |
| `symbolTypes` | string[] | all | Filter: FUNCTION, CLASS, METHOD, INTERFACE, etc. |
| `granularity` | enum | auto | `"auto"` \| `"symbol"` \| `"chunk"` \| `"file"` |
| `rerank` | boolean | false | Enable BM25 reranking (~50-100ms extra latency) |
| `pathPrefix` | string | none | Scope to subdirectory (e.g. `"packages/core/"`) |
| `filePatterns` | string[] | none | Glob filter (e.g. `["*.ts", "src/**/*.tsx"]`) |

### `smart_query` Confidence Tiers

Results include a `confidence` field with multi-signal scoring:

| Tier | Score | Meaning |
|------|-------|---------|
| `high` | ≥ 0.7 | Strong retrieval agreement + focused results |
| `medium` | ≥ 0.4 | Reasonable match, may need refinement |
| `low` | ≥ 0.1 | Weak match — try narrower scope or different terms |
| `degraded` | < 0.1 | Very poor match — likely wrong search strategy |

**Confidence signals:** retrieval agreement (vector ∩ keyword overlap), score spread (top result decisiveness), scope concentration (results from same directory).

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

### Exploring a Multi-Project Workspace

```
1. repo_map(limit=15)                          → Find important files across all projects
2. smart_query(query="auth middleware", pathPrefix="packages/api/") → Scope to one project
3. smart_query(query="auth middleware", pathPrefix="packages/web/") → Compare with another
4. smart_query(query="shared utils", filePatterns=["**/utils/*.ts"]) → Find cross-cutting code
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
1. smart_query(query="error handling in payment flow", rerank=true) → Precision search
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
6. **Not scoping in multi-project workspaces** — Use `pathPrefix` to avoid cross-project noise. Without it, results from unrelated packages pollute your search.
7. **Using `rerank=true` on every query** — Reranking adds 50-100ms latency. Use it for precision-critical searches, skip it for exploratory browsing.
8. **Ignoring confidence tiers** — When confidence is `low` or `degraded`, don't trust results blindly. Try narrower scope, different terms, or switch to `symbol_search` / `grep`.
9. **Over-specifying `granularity`** — Leave it as `auto` unless you specifically need symbol-only or file-only results. Auto adapts to query complexity.

## Migration Notes

If upgrading from a prior version of `smart_query`:

- **New parameters**: `pathPrefix`, `filePatterns`, `granularity`, `rerank` are all optional additions. No breaking changes.
- **Confidence is now multi-signal**: Previously based on hit-count only. Now uses retrieval agreement, score spread, and scope concentration. Confidence tiers (`high`/`medium`/`low`/`degraded`) are more nuanced.
- **Result metadata** now includes `confidenceDiagnostics` (signal breakdown) and `candidateLimit` (adaptive sizing). These are informational — no action needed.
- **Adaptive candidate sizing**: The number of candidates evaluated scales with query complexity, scope, and token budget. Short queries fetch fewer candidates; long, scoped queries with high budgets fetch more.
