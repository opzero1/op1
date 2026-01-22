---
description: Explain codebase structure, architecture, and patterns using semantic search
agent: explore
---

# /understand Command

Provide a comprehensive explanation of the specified codebase component, file, or concept.

**Topic:** $ARGUMENTS

## Workflow

1. **Semantic Search First** - Use `search_semantic` to find relevant code:
   ```
   search_semantic(query="$ARGUMENTS", limit=20)
   ```

2. **Dependency Analysis** - Map the component's relationships:
   ```
   find_dependencies(filePath="[discovered file]", direction="both")
   call_graph(filePath="[discovered file]", symbolName="[main function]", direction="both")
   ```

3. **Symbol Navigation** - Explore the structure:
   ```
   lsp_symbols(filePath="[discovered file]", scope="document")
   lsp_find_references(filePath="[discovered file]", line=[key line], character=[col])
   ```

4. **Similar Patterns** - Find related implementations:
   ```
   find_similar(code="[key code snippet]", limit=5)
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
