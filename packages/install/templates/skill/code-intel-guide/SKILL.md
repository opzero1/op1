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
smart_query(query="React hooks", filePatterns=["*.tsx", "*.ts"], rerankMode="heuristic")
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
| `rerankMode` | enum | none | `"none"` \| `"heuristic"` (BM25) \| `"llm"` (Voyage AI) \| `"hybrid"` (Voyage + BM25 fallback) |
| `rerank` | boolean | _(deprecated)_ | Legacy alias: `true` → `"heuristic"`, `false` → `"none"`. Prefer `rerankMode` |
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

### Embedding & Reranking

Code intelligence uses embeddings to understand code semantics. The embedding model is auto-selected:

| Condition | Model | Dimensions | Quality |
|-----------|-------|------------|---------|
| `VOYAGE_AI_API_KEY` set | Voyage `voyage-code-3` | 1024 | Best (purpose-built for code) |
| No API key | Local UniXcoder | 384 | Good (offline, no API cost) |

- **Auto-migration**: When the embedding model changes (e.g., API key added/removed), the index is automatically wiped and rebuilt on next use. No manual intervention needed.
- **Asymmetric embeddings**: Voyage uses `input_type: 'query'` for searches and `input_type: 'document'` for indexing, improving retrieval quality.

**Rerank modes** (`rerankMode` parameter):

| Mode | Engine | Latency | When to Use |
|------|--------|---------|-------------|
| `none` | _(disabled)_ | 0ms | Exploratory browsing, speed-critical |
| `heuristic` | BM25 | ~50-100ms | Default precision boost, always available |
| `llm` | Voyage `rerank-2.5` | ~200-500ms | Maximum precision, requires `VOYAGE_AI_API_KEY` |
| `hybrid` | Voyage + BM25 fallback | ~200-500ms | Best of both — uses Voyage when available, falls back to BM25 |

**Recommendation**: Use `rerankMode="heuristic"` for precision-critical searches. Use `"hybrid"` when Voyage API is available and you want the best results with graceful degradation.

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
1. smart_query(query="error handling in payment flow", rerankMode="heuristic") → Precision search
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
7. **Using `rerankMode` on every query** — Reranking adds latency (50ms for `heuristic`, 200-500ms for `llm`/`hybrid`). Use it for precision-critical searches, skip it for exploratory browsing.
8. **Ignoring confidence tiers** — When confidence is `low` or `degraded`, don't trust results blindly. Try narrower scope, different terms, or switch to `symbol_search` / `grep`.
9. **Over-specifying `granularity`** — Leave it as `auto` unless you specifically need symbol-only or file-only results. Auto adapts to query complexity.

## Migration Notes

If upgrading from a prior version of `smart_query`:

- **`rerankMode` replaces boolean `rerank`**: The boolean `rerank` parameter still works (`true` → `"heuristic"`, `false` → `"none"`) but prefer the enum `rerankMode` for finer control. `rerankMode` takes priority when both are specified.
- **Voyage AI embeddings**: Set `VOYAGE_AI_API_KEY` env var to auto-upgrade from local UniXcoder to Voyage `voyage-code-3`. The index auto-migrates (schema v3) — vectors are wiped and re-embedded on first use.
- **New parameters**: `pathPrefix`, `filePatterns`, `granularity` are optional additions. No breaking changes.
- **Confidence is now multi-signal**: Previously based on hit-count only. Now uses retrieval agreement, score spread, and scope concentration. Confidence tiers (`high`/`medium`/`low`/`degraded`) are more nuanced.
- **Result metadata** now includes `confidenceDiagnostics` (signal breakdown) and `candidateLimit` (adaptive sizing). These are informational — no action needed.
- **Adaptive candidate sizing**: The number of candidates evaluated scales with query complexity, scope, and token budget. Short queries fetch fewer candidates; long, scoped queries with high budgets fetch more.
