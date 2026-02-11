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

	// Toast helper — throttled to prevent spam
	const client = ctx.client as unknown as {
		tui?: { showToast?: (opts: { body: { title?: string; message: string; variant: string; duration?: number } }) => Promise<unknown> };
	};
	let lastToastTime = 0;
	const TOAST_THROTTLE_MS = 2500;

	function showToast(title: string, message: string, variant: "info" | "success" | "warning" | "error" = "info", duration?: number) {
		try {
			client.tui?.showToast?.({ body: { title, message, variant, duration } })?.catch(() => {});
		} catch {
			// TUI not available — ignore
		}
	}

	function showThrottledToast(title: string, message: string, variant: "info" | "success" | "warning" | "error" = "info") {
		const now = Date.now();
		if (now - lastToastTime < TOAST_THROTTLE_MS) return;
		lastToastTime = now;
		showToast(title, message, variant);
	}

	// Progress callback for index manager
	const onProgress = (current: number, total: number, phase: string) => {
		if (total === 0) return;
		if (current === 0) {
			// Always show start
			lastToastTime = 0;
			const label = phase === "refreshing" ? "Refreshing index" : "Building index";
			showToast("Code Intel", `${label}... (${total} files)`, "info");
			return;
		}
		if (current >= total) {
			// Always show completion
			const label = phase === "refreshing" ? "Index refreshed" : "Index built";
			showToast("Code Intel", `${label} — ${total} files`, "success", 3000);
			return;
		}
		// Throttled progress updates
		const pct = Math.round((current / total) * 100);
		showThrottledToast("Code Intel", `${phase === "refreshing" ? "Refreshing" : "Indexing"}... ${pct}% (${current}/${total})`, "info");
	};

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
				onProgress,
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
