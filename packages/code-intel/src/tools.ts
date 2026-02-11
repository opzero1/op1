/**
 * Code Intelligence Tools
 *
 * OpenCode tool definitions for code intelligence features:
 * - smart_query: Hybrid vector + BM25 + graph retrieval
 * - symbol_impact: Change impact analysis
 * - call_graph: Caller/callee visualization
 * - symbol_search: BM25 symbol search
 * - repo_map: File importance rankings
 * - code_intel_status: Index statistics
 * - code_intel_rebuild: Force full reindex
 * - code_intel_refresh: Incremental update
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import type { IndexManager } from "./indexing/index-manager";
import type { SmartQuery } from "./query/smart-query";
import type { ImpactAnalyzer } from "./query/impact-analysis";
import type { GraphExpander, GraphExpansionResult } from "./query/graph-expander";
import type { SymbolNode, SymbolType, RiskLevel, RepoMapEntry } from "./types";
import type { Embedder } from "./embeddings";

// ============================================================================
// Singleton State (initialized by plugin)
// ============================================================================

let indexManager: IndexManager | null = null;
let smartQuery: SmartQuery | null = null;
let impactAnalyzer: ImpactAnalyzer | null = null;
let graphExpander: GraphExpander | null = null;
let ensureIndexFn: (() => Promise<void>) | null = null;
let embedder: Embedder | null = null;

export function setIndexManager(manager: IndexManager | null): void {
	indexManager = manager;
}

export function setSmartQuery(query: SmartQuery | null): void {
	smartQuery = query;
}

export function setImpactAnalyzer(analyzer: ImpactAnalyzer | null): void {
	impactAnalyzer = analyzer;
}

export function setGraphExpander(expander: GraphExpander | null): void {
	graphExpander = expander;
}

export function setEnsureIndex(fn: () => Promise<void>): void {
	ensureIndexFn = fn;
}

export function setEmbedder(embedderInstance: Embedder | null): void {
	embedder = embedderInstance;
}

async function ensureInitialized(): Promise<void> {
	if (indexManager) return;
	if (!ensureIndexFn) {
		throw new Error("Code intelligence not initialized. Ensure @op1/code-intel plugin is configured.");
	}
	await ensureIndexFn();
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatSymbol(symbol: SymbolNode): string {
	const location = `${symbol.file_path}:${symbol.start_line}-${symbol.end_line}`;
	const signature = symbol.signature ? ` \`${symbol.signature}\`` : "";
	const preview = symbol.content.split("\n").slice(0, 8).join("\n");
	const truncated = symbol.content.split("\n").length > 8 ? "\n  ..." : "";

	return `**${symbol.type}: ${symbol.qualified_name}**${signature}\nFile: ${location}\n\`\`\`${symbol.language}\n${preview}${truncated}\n\`\`\``;
}

function formatRiskBadge(risk: RiskLevel): string {
	const badges: Record<RiskLevel, string> = {
		low: "🟢 LOW",
		medium: "🟡 MEDIUM",
		high: "🟠 HIGH",
		critical: "🔴 CRITICAL",
	};
	return badges[risk];
}

function formatGraphResult(result: GraphExpansionResult, direction: "callers" | "callees"): string {
	const lines: string[] = [];
	const { root, nodes, stats } = result;

	lines.push(`## ${direction === "callers" ? "Callers of" : "Callees from"} \`${root.qualified_name}\``);
	lines.push("");
	lines.push(`**Root:** ${root.type} in ${root.file_path}:${root.start_line}`);
	lines.push(`**Found:** ${stats.totalNodes - 1} ${direction}, ${stats.totalEdges} edges`);
	lines.push(`**Max depth reached:** ${stats.maxDepthReached}`);

	if (stats.truncatedNodes > 0) {
		lines.push(`**Note:** ${stats.truncatedNodes} nodes had edges truncated due to fan-out limit`);
	}

	lines.push("");

	// Group by depth
	const byDepth = new Map<number, SymbolNode[]>();
	for (const [id, node] of nodes) {
		if (id === root.id) continue;
		const existing = byDepth.get(node.depth) ?? [];
		existing.push(node.symbol);
		byDepth.set(node.depth, existing);
	}

	for (const [depth, symbols] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
		lines.push(`### Depth ${depth}`);
		for (const symbol of symbols.slice(0, 20)) {
			lines.push(`- \`${symbol.qualified_name}\` (${symbol.type}) - ${symbol.file_path}:${symbol.start_line}`);
		}
		if (symbols.length > 20) {
			lines.push(`- ... and ${symbols.length - 20} more`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Tool Argument Types
// ============================================================================

interface SmartQueryArgs {
	query: string;
	maxTokens?: number;
	graphDepth?: number;
	symbolTypes?: string[];
	/** Search granularity: 'auto' | 'symbol' | 'chunk' | 'file' */
	granularity?: "auto" | "symbol" | "chunk" | "file";
	/** Enable reranking for improved precision */
	rerank?: boolean;
	/** Path prefix for scoping to a project subdirectory (e.g. "packages/core/") */
	pathPrefix?: string;
	/** File patterns to filter results (glob-style, e.g. ["*.ts", "src/**"]) */
	filePatterns?: string[];
}

interface SymbolImpactArgs {
	symbolName: string;
	maxDepth?: number;
}

interface CallGraphArgs {
	symbolName: string;
	direction?: "callers" | "callees" | "both";
	depth?: number;
	maxFanOut?: number;
}

interface SymbolSearchArgs {
	query: string;
	limit?: number;
	symbolType?: SymbolType;
}

interface RepoMapArgs {
	limit?: number;
	directory?: string;
}

// ============================================================================
// Tools
// ============================================================================

/**
 * Smart Query - Hybrid vector + BM25 + graph retrieval
 */
export const smart_query: ToolDefinition = tool({
	description:
		"Natural language code search with hybrid vector + BM25 retrieval and graph expansion. Token-budget aware context building.",
	args: {
		query: tool.schema.string().describe("Natural language query (e.g., 'function that validates email addresses')"),
		maxTokens: tool.schema.number().optional().describe("Max tokens in response context (default: 8000)"),
		graphDepth: tool.schema.number().optional().describe("Graph traversal depth for callers/callees (default: 2, max: 3)"),
		symbolTypes: tool.schema
			.array(tool.schema.string())
			.optional()
			.describe("Filter by symbol types: FUNCTION, CLASS, METHOD, INTERFACE, etc."),
		granularity: tool.schema
			.enum(["auto", "symbol", "chunk", "file"])
			.optional()
			.describe("Search granularity: 'auto' searches all levels, 'symbol' for functions/classes, 'chunk' for code blocks, 'file' for full files"),
		rerank: tool.schema
			.boolean()
			.optional()
			.describe("Enable reranking for improved precision (adds ~50-100ms latency)"),
		pathPrefix: tool.schema
			.string()
			.optional()
			.describe("Path prefix for scoping search to a subdirectory (e.g. 'packages/core/' or 'src/')"),
		filePatterns: tool.schema
			.array(tool.schema.string())
			.optional()
			.describe("File patterns to filter results (glob-style, e.g. ['*.ts', 'src/**/*.tsx'])"),
	},
	execute: async (args: SmartQueryArgs) => {
		try {
			await ensureInitialized();
			if (!smartQuery || !indexManager) {
				return "Error: Code intelligence not fully initialized.";
			}

			const branch = indexManager.getCurrentBranch();
			
			// Generate embedding for vector search (if embedder available)
			const queryEmbedding = embedder ? await embedder.embed(args.query) : undefined;
			
			const result = await smartQuery.search({
				queryText: args.query,
				embedding: queryEmbedding,
				branch,
				maxTokens: args.maxTokens ?? 8000,
				graphDepth: args.graphDepth ?? 2,
				symbolTypes: args.symbolTypes as SymbolType[] | undefined,
				granularity: args.granularity,
				rerank: args.rerank === true ? "heuristic" : args.rerank === false ? "none" : undefined,
				pathPrefix: args.pathPrefix,
				filePatterns: args.filePatterns,
			});

			if (result.symbols.length === 0) {
				return "No matching code found. Try:\n- Different keywords\n- More general terms\n- Check if index is built: use `code_intel_status` tool";
			}

			const lines: string[] = [];
			lines.push(`## Search Results for: "${args.query}"`);
			lines.push("");
			lines.push(
				`**Found:** ${result.symbols.length} symbols | **Tokens:** ${result.tokenCount} | **Time:** ${result.metadata.queryTime}ms`,
			);
			lines.push(
				`**Retrieval:** ${result.metadata.vectorHits} vector hits, ${result.metadata.keywordHits} keyword hits`,
			);
			lines.push(`**Graph expansions:** ${result.metadata.graphExpansions} | **Confidence:** ${result.metadata.confidence}`);
			lines.push("");
			lines.push("---");
			lines.push("");
			lines.push(result.context);

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Symbol Impact - "What happens if I change X?"
 */
export const symbol_impact: ToolDefinition = tool({
	description:
		"Analyze the impact of changing a symbol. Shows risk assessment, affected symbols list, and confidence indicators.",
	args: {
		symbolName: tool.schema.string().describe("Symbol name or qualified name to analyze"),
		maxDepth: tool.schema.number().optional().describe("Max traversal depth for dependents (default: 10)"),
	},
	execute: async (args: SymbolImpactArgs) => {
		try {
			await ensureInitialized();
			if (!impactAnalyzer || !indexManager) {
				return "Error: Code intelligence not fully initialized.";
			}

			const stores = indexManager.getStores();
			const branch = indexManager.getCurrentBranch();

			// Find symbol by name
			const matches = stores.keywords.search(args.symbolName, 5);
			if (matches.length === 0) {
				return `No symbol found matching "${args.symbolName}". Try a different name or use symbol_search first.`;
			}

			const symbolId = matches[0].symbol_id;
			const impact = impactAnalyzer.analyzeImpact(symbolId, {
				branch,
				maxDepth: args.maxDepth ?? 10,
			});

			if (!impact) {
				return `Symbol "${args.symbolName}" not found in the index.`;
			}

			const lines: string[] = [];
			lines.push(`## Impact Analysis: \`${impact.symbol.qualified_name}\``);
			lines.push("");
			lines.push(`**Risk Level:** ${formatRiskBadge(impact.risk)}`);
			lines.push(`**Direct Dependents:** ${impact.directDependents}`);
			lines.push(`**Transitive Dependents:** ${impact.transitiveDependents}`);
			lines.push(`**Confidence:** ${impact.confidence}`);
			lines.push("");

			if (impact.affectedSymbols.length > 0) {
				lines.push("### Affected Symbols");
				lines.push("");

				// Group by depth
				const byDepth = new Map<number, typeof impact.affectedSymbols>();
				for (const entry of impact.affectedSymbols) {
					const existing = byDepth.get(entry.depth) ?? [];
					existing.push(entry);
					byDepth.set(entry.depth, existing);
				}

				for (const [depth, entries] of Array.from(byDepth.entries()).sort((a, b) => a[0] - b[0])) {
					lines.push(`#### Depth ${depth} (${entries.length} symbols)`);
					for (const entry of entries.slice(0, 15)) {
						const pathStr = entry.path.slice(-2).join(" -> ");
						lines.push(`- \`${entry.symbol.qualified_name}\` - ${entry.symbol.file_path}:${entry.symbol.start_line}`);
						if (entry.path.length > 2) {
							lines.push(`  Path: ...${pathStr}`);
						}
					}
					if (entries.length > 15) {
						lines.push(`- ... and ${entries.length - 15} more at this depth`);
					}
					lines.push("");
				}
			} else {
				lines.push("No dependents found. This symbol appears to be a leaf node.");
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Call Graph - Visualize callers/callees
 */
export const call_graph: ToolDefinition = tool({
	description: "Visualize caller/callee relationships for a symbol. Depth-limited traversal with filtering.",
	args: {
		symbolName: tool.schema.string().describe("Symbol name or qualified name"),
		direction: tool.schema
			.enum(["callers", "callees", "both"])
			.optional()
			.describe("Direction to traverse (default: both)"),
		depth: tool.schema.number().optional().describe("Traversal depth (default: 2, max: 3)"),
		maxFanOut: tool.schema.number().optional().describe("Max edges per node (default: 10)"),
	},
	execute: async (args: CallGraphArgs) => {
		try {
			await ensureInitialized();
			if (!graphExpander || !indexManager) {
				return "Error: Code intelligence not fully initialized.";
			}

			const stores = indexManager.getStores();
			const branch = indexManager.getCurrentBranch();

			// Find symbol by name
			const matches = stores.keywords.search(args.symbolName, 5);
			if (matches.length === 0) {
				return `No symbol found matching "${args.symbolName}". Try symbol_search first.`;
			}

			const symbolId = matches[0].symbol_id;
			const direction = args.direction ?? "both";
			const depth = Math.min(args.depth ?? 2, 3);
			const maxFanOut = args.maxFanOut ?? 10;

			const options = {
				branch,
				maxDepth: depth,
				maxFanOut,
				confidenceThreshold: 0.5,
			};

			const lines: string[] = [];

			if (direction === "callers" || direction === "both") {
				const callers = graphExpander.findCallers(symbolId, options);
				if (callers) {
					lines.push(formatGraphResult(callers, "callers"));
					lines.push("");
				}
			}

			if (direction === "callees" || direction === "both") {
				const callees = graphExpander.findCallees(symbolId, options);
				if (callees) {
					lines.push(formatGraphResult(callees, "callees"));
				}
			}

			if (lines.length === 0) {
				return `No call graph found for "${args.symbolName}".`;
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Symbol Search - Find symbols by name pattern using BM25
 */
export const symbol_search: ToolDefinition = tool({
	description: "Find symbols by name pattern using BM25 keyword matching. Filter by symbol type.",
	args: {
		query: tool.schema.string().describe("Symbol name or pattern to search for"),
		limit: tool.schema.number().optional().describe("Max results (default: 20)"),
		symbolType: tool.schema
			.enum(["FUNCTION", "CLASS", "METHOD", "INTERFACE", "MODULE", "ENUM", "VARIABLE", "TYPE_ALIAS", "PROPERTY"])
			.optional()
			.describe("Filter by symbol type"),
	},
	execute: async (args: SymbolSearchArgs) => {
		try {
			await ensureInitialized();
			if (!indexManager) {
				return "Error: Code intelligence not initialized.";
			}

			const stores = indexManager.getStores();
			const limit = args.limit ?? 20;

			const matches = stores.keywords.search(args.query, limit * 2);

			if (matches.length === 0) {
				return `No symbols found matching "${args.query}".`;
			}

			// Hydrate symbols
			const symbols: SymbolNode[] = [];
			for (const match of matches) {
				const symbol = stores.symbols.getById(match.symbol_id);
				if (symbol) {
					if (args.symbolType && symbol.type !== args.symbolType) continue;
					symbols.push(symbol);
					if (symbols.length >= limit) break;
				}
			}

			if (symbols.length === 0) {
				return `No symbols found matching "${args.query}"${args.symbolType ? ` with type ${args.symbolType}` : ""}.`;
			}

			const lines: string[] = [];
			lines.push(`## Symbol Search: "${args.query}"`);
			lines.push(`Found ${symbols.length} symbol(s):`);
			lines.push("");

			for (const symbol of symbols) {
				lines.push(formatSymbol(symbol));
				lines.push("");
				lines.push("---");
				lines.push("");
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Repo Map - Show file importance rankings
 */
export const repo_map: ToolDefinition = tool({
	description: "Show file importance rankings based on PageRank. Top N files by connectivity and centrality.",
	args: {
		limit: tool.schema.number().optional().describe("Number of files to show (default: 20)"),
		directory: tool.schema.string().optional().describe("Filter to specific directory"),
	},
	execute: async (args: RepoMapArgs) => {
		try {
			await ensureInitialized();
			if (!indexManager) {
				return "Error: Code intelligence not initialized.";
			}

			const stores = indexManager.getStores();
			const branch = indexManager.getCurrentBranch();
			const limit = args.limit ?? 20;

			let entries = stores.repoMap.getByBranch(branch, limit * 2);

			// Filter by directory if specified
			if (args.directory) {
				const dir = args.directory.endsWith("/") ? args.directory : `${args.directory}/`;
				entries = entries.filter((e: RepoMapEntry) => e.file_path.startsWith(dir));
			}

			entries = entries.slice(0, limit);

			if (entries.length === 0) {
				return args.directory
					? `No files found in directory "${args.directory}". Try running code_intel_rebuild first.`
					: "No repo map data found. Run code_intel_rebuild to generate.";
			}

			const lines: string[] = [];
			lines.push("## Repository Map - Most Important Files");
			lines.push("");
			lines.push("| Rank | File | Score | In/Out Degree | Key Symbols |");
			lines.push("|------|------|-------|---------------|-------------|");

			entries.forEach((entry: RepoMapEntry, idx: number) => {
				const score = entry.importance_score.toFixed(4);
				const degree = `${entry.in_degree}/${entry.out_degree}`;
				const symbols = entry.symbol_summary.slice(0, 50) + (entry.symbol_summary.length > 50 ? "..." : "");
				lines.push(`| ${idx + 1} | \`${entry.file_path}\` | ${score} | ${degree} | ${symbols} |`);
			});

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Code Intel Status - Index statistics
 */
export const code_intel_status: ToolDefinition = tool({
	description: "Get code intelligence index statistics and status.",
	args: {},
	execute: async () => {
		try {
			await ensureInitialized();
			if (!indexManager) {
				return "Error: Code intelligence not initialized.";
			}

			const status = await indexManager.getStatus();

			const lines: string[] = [];
			lines.push("## Code Intelligence Index Status");
			lines.push("");
			lines.push(`- **State:** ${status.state}`);
			lines.push(`- **Branch:** ${status.current_branch}`);
			lines.push("");
			lines.push("### Files");
			lines.push(`- Total: ${status.total_files}`);
			lines.push(`- Indexed: ${status.indexed_files}`);
			lines.push(`- Pending: ${status.pending_files}`);
			lines.push(`- Errors: ${status.error_files}`);
			lines.push(`- Stale: ${status.stale_files}`);
			lines.push("");
			lines.push("### Symbols & Edges");
			lines.push(`- Symbols: ${status.total_symbols}`);
			lines.push(`- Edges: ${status.total_edges}`);
			lines.push("");
			lines.push("### Chunks & Embeddings");
			lines.push(`- Total chunks: ${status.total_chunks ?? 0}`);
			lines.push(`- Total embeddings: ${status.total_embeddings ?? 0}`);
			if (status.embedding_counts) {
				lines.push(`- Symbol embeddings: ${status.embedding_counts.symbol ?? 0}`);
				lines.push(`- Chunk embeddings: ${status.embedding_counts.chunk ?? 0}`);
				lines.push(`- File embeddings: ${status.embedding_counts.file ?? 0}`);
			}
			lines.push("");
			lines.push("### Configuration");
			lines.push(`- Embedding model: ${status.embedding_model_id}`);
			lines.push(`- Schema version: ${status.schema_version}`);
			if (status.last_full_index) {
				lines.push(`- Last full index: ${new Date(status.last_full_index).toISOString()}`);
			}

			return lines.join("\n");
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Code Intel Rebuild - Force full reindex
 */
export const code_intel_rebuild: ToolDefinition = tool({
	description: "Force a full reindex of the codebase. Clears existing data and rebuilds from scratch.",
	args: {},
	execute: async () => {
		try {
			await ensureInitialized();
			if (!indexManager) {
				return "Error: Code intelligence not initialized.";
			}

			const startTime = Date.now();
			await indexManager.rebuild();
			const elapsed = Date.now() - startTime;

			const status = await indexManager.getStatus();

			return `Full reindex complete in ${elapsed}ms.\n\nIndexed ${status.indexed_files} files with ${status.total_symbols} symbols and ${status.total_edges} edges.`;
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});

/**
 * Code Intel Refresh - Incremental update
 */
export const code_intel_refresh: ToolDefinition = tool({
	description: "Incrementally update the index with changed files. Faster than full rebuild.",
	args: {},
	execute: async () => {
		try {
			await ensureInitialized();
			if (!indexManager) {
				return "Error: Code intelligence not initialized.";
			}

			const startTime = Date.now();
			const changes = await indexManager.refresh();
			const elapsed = Date.now() - startTime;

			const total = changes.added + changes.modified + changes.removed;

			if (total === 0) {
				return "Index is up to date. No changes detected.";
			}

			return `Incremental update complete in ${elapsed}ms.\n\n- Added: ${changes.added} files\n- Modified: ${changes.modified} files\n- Removed: ${changes.removed} files`;
		} catch (e) {
			return `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	},
});
