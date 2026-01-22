---
description: Find code patterns, files, or implementations in the codebase
agent: explore
---

Search the codebase for the specified pattern, file, or implementation.

**Search Query:** $ARGUMENTS

Use appropriate tools based on query type:
- File patterns → `glob`
- Text patterns → `grep`
- Semantic search → LSP tools (`lsp_goto_definition`, `lsp_find_references`)
- Structural patterns → `ast_grep_search`
- History/evolution → git commands

Return structured findings with:
- Absolute file paths with relevance explanation
- Direct answer to the query
- Suggested next steps
