---
description: Explain codebase structure, architecture, and patterns using semantic and structural analysis
agent: explore
---

# /understand Command

Provide a comprehensive explanation of the specified codebase component, file, or concept.

**Topic:** $ARGUMENTS

## Workflow

1. **Scope Discovery** - Use `glob` and `grep` to identify relevant files quickly:
   ```
   glob(pattern="**/*keyword*")
   grep(pattern="$ARGUMENTS|related_term", include="*.{ts,tsx,js,jsx}")
   ```

2. **Symbol Mapping** - Use LSP to understand exports, definitions, and usage:
   ```
   lsp_symbols(filePath="[discovered file]", scope="document")
   lsp_goto_definition(filePath="[discovered file]", line=[key line], character=[col])
   lsp_find_references(filePath="[discovered file]", line=[key line], character=[col])
   ```

3. **Structural Confirmation** - Verify implementation patterns:
   ```
   ast_grep_search(pattern="[relevant structural pattern]", lang="typescript")
   ```

4. **History Context** - Check evolution of critical files when needed:
   ```
   git log -- [path/to/file]
   git blame [path/to/file]
   ```

## Output Format

Provide a structured explanation:

```markdown
## Understanding: [Topic]

### Overview
[1-2 sentence summary of what this component does]

### Key Files
| File | Purpose |
|------|---------|
| `path/to/file.ts` | [role in the system] |

### Architecture
[Explain how the pieces fit together]

### Dependencies
- **Depends On:** [what this component uses]
- **Used By:** [what uses this component]

### Key Patterns
[Notable patterns, conventions, or idioms used]

### Entry Points
[Main functions/exports to start from]

### Related Components
[Other parts of the codebase that are similar or related]
```

## Examples

- `/understand authentication` - Explain the auth system
- `/understand src/api/handlers` - Explain the API handler structure
- `/understand database models` - Explain the data layer
- `/understand error handling` - Explain error handling patterns
