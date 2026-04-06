---
description: Find code patterns, files, or implementations in the codebase
agent: explore
---

Search the codebase for the specified pattern, file, or implementation.

**Search Query:** $ARGUMENTS

If no arguments were provided, infer the most recent concrete search target from context. If no search target exists, ask one focused clarification question.

Use the `explore` agent's tool hierarchy:
- Natural language queries: scope first, then text, structural, and symbol-aware tools
- Symbol queries: `lsp_symbols` first, then definition and references
- File queries: `glob`
- Impact or history queries: combine symbol tools with targeted search and git context when needed

Return structured findings with:
- Absolute file paths with relevance explanation
- Direct answer to the query
- Suggested next steps
