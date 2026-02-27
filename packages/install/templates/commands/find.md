---
description: Find code patterns, files, or implementations in the codebase
agent: explore
---

Search the codebase for the specified pattern, file, or implementation.

**Search Query:** $ARGUMENTS

Use appropriate tools based on query type:
- Natural language → `grep` with focused terms, then refine with `ast_grep_search`
- Symbol names → `lsp_symbols`, then `lsp_goto_definition` / `lsp_find_references`
- File patterns → `glob`
- Text patterns → `grep`
- Structural patterns → `ast_grep_search`
- Symbol navigation → `lsp_goto_definition`, `lsp_find_references`
- Impact analysis → `lsp_find_references` + targeted `grep` to map dependents
- History/evolution → git commands

Return structured findings with:
- Absolute file paths with relevance explanation
- Direct answer to the query
- Suggested next steps
