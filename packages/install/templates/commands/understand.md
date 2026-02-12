---
description: Explain codebase structure, architecture, and patterns using code intelligence
agent: explore
---

# /understand Command

Provide a comprehensive explanation of the specified codebase component, file, or concept.

**Topic:** $ARGUMENTS

## Workflow

1. **Smart Query First** - Use `smart_query` to find relevant code:
   ```
   smart_query(query="$ARGUMENTS", maxTokens=8000)
   ```

2. **Dependency Analysis** - Map the component's relationships:
   ```
   call_graph(symbolName="[main function]", direction="both", depth=2)
   symbol_impact(symbolName="[main symbol]", maxDepth=5)
   ```

3. **Symbol Navigation** - Explore the structure:
   ```
   lsp_symbols(filePath="[discovered file]", scope="document")
   lsp_find_references(filePath="[discovered file]", line=[key line], character=[col])
   ```

4. **Repo Map** - Find the most important files in the area:
   ```
   repo_map(directory="[relevant directory]", limit=10)
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
