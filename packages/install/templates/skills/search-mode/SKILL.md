---
name: search-mode
description: Exhaustive search mode. Use when you need broad codebase or documentation coverage, multiple parallel searches, and a synthesized inventory of findings.
---

# Search Mode

> **ACTIVATION**: When loaded, immediately maximize search effort across all available tools.

## Protocol

**MAXIMIZE SEARCH EFFORT**

Launch multiple background agents in parallel only when the extra coverage is worth the context and wall-clock cost.

### Agent Deployment

```
// Codebase patterns (INTERNAL)
task(subagent_type="explore", description="Find pattern one", prompt="Find [pattern 1]...", run_in_background=true)
task(subagent_type="explore", description="Find pattern two", prompt="Find [pattern 2]...", run_in_background=true)
task(subagent_type="explore", description="Find pattern three", prompt="Find [pattern 3]...", run_in_background=true)

// External resources (EXTERNAL)
task(subagent_type="researcher", description="Find docs", prompt="Find docs for...", run_in_background=true)
task(subagent_type="researcher", description="Find examples", prompt="Find GitHub examples...", run_in_background=true)
```

### Direct Tools

Use the `explore` agent's scope-first tool hierarchy for local search, then add external research only when the task crosses into documentation or OSS examples.

### Search Strategy

1. **Fire 3-5 parallel agents** for broad coverage
2. **Use direct tools** for specific patterns simultaneously
3. **NEVER stop at first result** - be exhaustive
4. **Cross-reference findings** between internal and external sources

## Example Workflow

For: "Find all authentication implementations"

```
// Parallel agents
task(subagent_type="explore", description="Find auth middleware", prompt="Find auth middleware implementations", run_in_background=true)
task(subagent_type="explore", description="Find auth flows", prompt="Find login/logout functions", run_in_background=true)
task(subagent_type="explore", description="Find session handling", prompt="Find JWT/session handling", run_in_background=true)
task(subagent_type="researcher", description="Research NextAuth", prompt="Find NextAuth.js best practices", run_in_background=true)

// Direct tools (in parallel)
glob(pattern="**/*auth*")
grep(pattern="authenticate|authorization|jwt|session", include="*.ts")
ast_grep_search(pattern="async function $NAME($$$) { $$$ }", lang="typescript")
lsp_symbols(query="authenticate", scope="workspace")
```

## Output Requirements

Synthesize ALL findings into:

1. **File inventory** with absolute paths
2. **Pattern summary** - what patterns exist
3. **Key findings** - most relevant discoveries
4. **Gaps identified** - what wasn't found
