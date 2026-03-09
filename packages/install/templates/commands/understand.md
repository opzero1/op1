---
description: Explain codebase structure, architecture, and patterns using semantic and structural analysis
agent: explore
---

# /understand Command

Provide a comprehensive explanation of the specified codebase component, file, or concept.

**Topic:** $ARGUMENTS

If `$ARGUMENTS` is empty, infer the most recent concrete component or concept from context. If no target exists, ask one focused clarification question.

## Workflow

1. **Scope Discovery** - Start with the `explore` agent's scope-first search pattern.
2. **Symbol Mapping** - Use LSP to understand exports, definitions, and usage.
3. **Structural Confirmation** - Verify implementation patterns with AST search when needed.
4. **History Context** - Add git context only when evolution matters to the explanation.

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
