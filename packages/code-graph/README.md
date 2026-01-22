# @op1/code-graph

Dependency graph plugin for OpenCode - import/export analysis and impact assessment.

## Features

- **Dependency Tracking** - Map imports and exports across your codebase
- **Impact Analysis** - Assess change risk with transitive dependency counts
- **Auto-Refresh on Query** - Automatically detects file changes
- **Incremental Updates** - Merkle tree cache for efficiency

## Installation

```bash
bun add @op1/code-graph
```

## Configuration

```json
{
  "plugin": ["@op1/code-graph"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `find_dependencies` | Find what a file imports |
| `find_dependents` | Find what imports a file |
| `impact_analysis` | Analyze change risk |
| `graph_status` | Get graph statistics |
| `graph_rebuild` | Rebuild the graph |

## Auto-Refresh (v0.3.0+)

Graph automatically checks for file changes before each query - no manual rebuild needed after git pull.

| Option | Default | Description |
|--------|---------|-------------|
| `autoRefresh` | `true` | Enable on-query freshness check |
| `autoRefreshCooldownMs` | `30000` | 30s between checks |
| `autoRefreshMaxFiles` | `10000` | Skip for massive repos |

## Risk Levels

| Level | Dependents | Meaning |
|-------|------------|---------|
| Low | 0-3 | Safe to modify |
| Medium | 4-10 | Test affected areas |
| High | 11-25 | Significant risk |
| Critical | 25+ | Core infrastructure |

## License

MIT
