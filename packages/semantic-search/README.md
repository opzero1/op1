# @op1/semantic-search

Semantic code search plugin for OpenCode - natural language to code search with embeddings.

## Features

- **Natural Language Search** - Find code using plain English queries
- **Code Similarity** - Find code patterns similar to a given snippet
- **Auto-Refresh on Query** - Automatically detects and reindexes changed files
- **Local Embeddings** - Transformers.js support (no API key required)
- **Incremental Indexing** - Merkle tree cache for efficient change detection

## Installation

```bash
bun add @op1/semantic-search
```

## Configuration

```json
{
  "plugin": ["@op1/semantic-search"]
}
```

## Tools

| Tool | Description |
|------|-------------|
| `search_semantic` | Search code using natural language |
| `find_similar` | Find code similar to a snippet or location |
| `semantic_status` | Get index status |
| `semantic_reindex` | Rebuild or update the index |

## Auto-Refresh (v0.3.0+)

Index automatically checks for file changes before each query - no manual reindex needed after git pull.

| Option | Default | Description |
|--------|---------|-------------|
| `autoRefresh` | `true` | Enable on-query freshness check |
| `autoRefreshCooldownMs` | `30000` | 30s between checks |
| `autoRefreshMaxFiles` | `10000` | Skip for massive repos |

## Embedding Providers

| Provider | API Key | Notes |
|----------|---------|-------|
| Transformers.js | No | Local, preferred |
| OpenAI | Yes | Cloud fallback |

## License

MIT
