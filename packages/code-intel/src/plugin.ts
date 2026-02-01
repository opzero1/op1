/**
 * Code Intelligence Plugin
 *
 * OpenCode plugin for semantic code intelligence.
 * Initialization is lazy - only happens when tools are first used.
 */

import type { Plugin } from "@opencode-ai/plugin";
import { createIndexManager, type IndexManager } from "./indexing/index-manager";
import { createSmartQuery, type SmartQuery } from "./query/smart-query";
import { createImpactAnalyzer, type ImpactAnalyzer } from "./query/impact-analysis";
import { createGraphExpander, type GraphExpander } from "./query/graph-expander";
import {
	smart_query,
	symbol_impact,
	call_graph,
	symbol_search,
	repo_map,
	code_intel_status,
	code_intel_rebuild,
	code_intel_refresh,
	setIndexManager,
	setSmartQuery,
	setImpactAnalyzer,
	setGraphExpander,
	setEnsureIndex,
	setEmbedder,
} from "./tools";
import { createAutoEmbedder, type Embedder } from "./embeddings";

/**
 * Code Intelligence Plugin for OpenCode
 *
 * Provides semantic code intelligence features:
 * - smart_query: Hybrid vector + BM25 + graph retrieval
 * - symbol_impact: Change impact analysis
 * - call_graph: Caller/callee visualization
 * - symbol_search: BM25 symbol search
 * - repo_map: File importance rankings
 * - code_intel_status: Index statistics
 * - code_intel_rebuild: Force full reindex
 * - code_intel_refresh: Incremental update
 *
 * Note: Initialization is lazy to avoid startup delays.
 * Index is built on first tool use.
 */
export const CodeIntelPlugin: Plugin = async (ctx) => {
	const { directory } = ctx;

	// Lazy initialization - only initialize when first tool is used
	let indexManager: IndexManager | null = null;
	let smartQuery: SmartQuery | null = null;
	let impactAnalyzer: ImpactAnalyzer | null = null;
	let graphExpander: GraphExpander | null = null;
	let queryEmbedder: Embedder | null = null;
	let initError: Error | null = null;

	const ensureIndex = async (): Promise<void> => {
		if (initError) {
			throw initError;
		}
		if (indexManager) {
			return;
		}

		try {
			// Create and initialize index manager
			indexManager = await createIndexManager({
				workspaceRoot: directory,
			});
			await indexManager.initialize();

			// Create query components
			const stores = indexManager.getStores();
			const db = indexManager.getDatabase();

			// Create embedder for query-time embedding generation
			queryEmbedder = await createAutoEmbedder();

			// SmartQuery needs the database, symbol store, edge store, AND embedder
			smartQuery = createSmartQuery(
				db,
				stores.symbols,
				stores.edges,
				{ embedder: queryEmbedder },
			);

			impactAnalyzer = createImpactAnalyzer(stores.symbols, stores.edges);
			graphExpander = createGraphExpander(stores.symbols, stores.edges);

			// Wire up tools
			setIndexManager(indexManager);
			setSmartQuery(smartQuery);
			setImpactAnalyzer(impactAnalyzer);
			setGraphExpander(graphExpander);
			setEmbedder(queryEmbedder);

			// Note: We intentionally don't register an exit handler.
			// Calling close() during process exit can cause issues with native modules.
			// The OS will clean up resources.
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			initError = new Error(
				`Code intelligence initialization failed: ${message}\n\n` +
					`Troubleshooting:\n` +
					`1. Ensure dependencies are installed: bun install\n` +
					`2. Check that tree-sitter parsers are available\n` +
					`3. Verify sqlite-vec is properly installed`,
			);
			throw initError;
		}
	};

	// Clear any previous state and wire up lazy initialization
	setIndexManager(null);
	setSmartQuery(null);
	setImpactAnalyzer(null);
	setGraphExpander(null);
	setEmbedder(null);
	setEnsureIndex(ensureIndex);

	return {
		name: "@op1/code-intel",
		tool: {
			smart_query,
			symbol_impact,
			call_graph,
			symbol_search,
			repo_map,
			code_intel_status,
			code_intel_rebuild,
			code_intel_refresh,
		},
		// Expose lazy initializer via context for testing
		_ensureIndex: ensureIndex,
	};
};

export default CodeIntelPlugin;
