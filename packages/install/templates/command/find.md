---
description: Find code patterns, files, or implementations in the codebase
agent: explore
---

Search the codebase for the specified pattern, file, or implementation.

**Search Query:** $ARGUMENTS

Use appropriate tools based on query type:
- Natural language → `smart_query` (hybrid vector + BM25 + graph)
- Symbol names → `symbol_search`
- File patterns → `glob`
- Text patterns → `grep`
- Structural patterns → `ast_grep_search`
- Symbol navigation → `lsp_goto_definition`, `lsp_find_references`
- Impact analysis → `symbol_impact`, `call_graph`
- History/evolution → git commands

Return structured findings with:
- Absolute file paths with relevance explanation
- Direct answer to the query
- Suggested next steps
