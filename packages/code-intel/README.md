# @op1/code-intel

Semantic code graph engine for OpenCode. Builds an AST-aware symbol index with vector embeddings and graph relationships, then exposes hybrid retrieval tools to agents.

## Install

```bash
bun add @op1/code-intel
```

Add to your `opencode.json`:

```json
{
	"plugin": ["@op1/code-intel"]
}
```

## How it works

The plugin uses **lazy initialization** — no index is built until the first tool call. On first use it:

1. Parses the workspace with tree-sitter (TypeScript and Python by default)
2. Extracts symbols, edges (calls, imports, inheritance), and chunks
3. Generates 768-dim embeddings via UniXcoder (`@huggingface/transformers`)
4. Stores everything in a local SQLite database with `sqlite-vec` for vector search
5. Computes a PageRank-based repo map using `graphology`

Subsequent sessions reuse the index and refresh incrementally.

## Tools

| Tool | Description |
|------|-------------|
| `smart_query` | Natural language code search — hybrid vector + BM25 retrieval with RRF fusion and graph expansion. Token-budget aware. |
| `symbol_impact` | Change impact analysis. "What breaks if I modify X?" with risk levels and transitive dependents. |
| `call_graph` | Caller/callee visualization with depth-limited traversal. |
| `symbol_search` | BM25 keyword search for symbols by name or pattern. Filterable by type. |
| `repo_map` | File importance rankings based on PageRank over the import/call graph. |
| `code_intel_status` | Index statistics — file counts, symbol/edge totals, embedding model, schema version. |
| `code_intel_rebuild` | Force a full reindex from scratch. |
| `code_intel_refresh` | Incremental update — reindexes only changed files. |

## Storage

Default paths (relative to workspace root):

| File | Purpose |
|------|---------|
| `.opencode/code-intel/index.db` | SQLite database with symbols, edges, chunks, and vector embeddings |
| `.opencode/code-intel/cache.json` | Merkle hash cache for fast change detection |

Add `.opencode/code-intel/` to `.gitignore`.

## Configuration defaults

Defaults from source (`types.ts`):

| Setting | Default |
|---------|---------|
| Languages | `typescript`, `python` |
| Embedding model | `microsoft/unixcoder-base` (768-dim) |
| Max query tokens | 8000 |
| Graph depth | 2 (max 3) |
| Max fan-out | 10 |
| Rerank mode | `hybrid` |
| Index external deps | `true` |
| Ignored patterns | `node_modules`, `.git`, `dist`, `build`, `*.min.js`, `*.bundle.js` |

## Voyage AI reranking (optional)

The `smart_query` tool supports a `rerankMode` parameter:

- `none` — no reranking
- `heuristic` — BM25-based reranking
- `llm` — Voyage AI reranking (requires API key)
- `hybrid` — Voyage AI with BM25 fallback (default)

To enable Voyage AI reranking, set:

```bash
export VOYAGE_AI_API_KEY=your-key
```

Without the key, the plugin falls back to heuristic reranking automatically.

## Branch awareness

Indices are scoped per git branch. Switching branches uses a separate index partition so results stay accurate without a rebuild.

## License

MIT
