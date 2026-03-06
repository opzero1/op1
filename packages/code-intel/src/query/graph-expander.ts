/**
 * Graph Expander - Depth-limited traversal for caller/callee relationships
 */

import type { EdgeStore } from "../storage/edge-store";
import type { SymbolStore } from "../storage/symbol-store";
import type {
	QueryOptions,
	SymbolEdge,
	SymbolNode,
	SymbolType,
} from "../types";

// ============================================================================
// Types
// ============================================================================

export interface GraphExpansionOptions {
	/** Graph traversal depth (default: 2, max: 3) */
	maxDepth?: number;
	/** Max edges per node (default: 10) */
	maxFanOut?: number;
	/** Minimum edge confidence (default: 0.5) */
	confidenceThreshold?: number;
	/** Filter by symbol types */
	symbolTypes?: SymbolType[];
	/** Current branch */
	branch: string;
}

export interface GraphNode {
	symbol: SymbolNode;
	depth: number;
	edges: SymbolEdge[];
}

export interface GraphExpansionResult {
	/** Root symbol */
	root: SymbolNode;
	/** All discovered nodes keyed by symbol ID */
	nodes: Map<string, GraphNode>;
	/** All traversed edges */
	edges: SymbolEdge[];
	/** Statistics */
	stats: {
		totalNodes: number;
		totalEdges: number;
		maxDepthReached: number;
		truncatedNodes: number;
	};
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_DEPTH = 2;
const MAX_ALLOWED_DEPTH = 3;
const DEFAULT_MAX_FAN_OUT = 10;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

// ============================================================================
// Graph Expander
// ============================================================================

export interface GraphExpander {
	findCallers(
		symbolId: string,
		options: GraphExpansionOptions,
	): GraphExpansionResult | null;
	findCallees(
		symbolId: string,
		options: GraphExpansionOptions,
	): GraphExpansionResult | null;
}

export function createGraphExpander(
	symbolStore: SymbolStore,
	edgeStore: EdgeStore,
): GraphExpander {
	function parseOptions(options: GraphExpansionOptions): {
		maxDepth: number;
		maxFanOut: number;
		confidenceThreshold: number;
		symbolTypes: SymbolType[] | null;
		branch: string;
	} {
		const maxDepth = Math.min(
			options.maxDepth ?? DEFAULT_MAX_DEPTH,
			MAX_ALLOWED_DEPTH,
		);
		const maxFanOut = options.maxFanOut ?? DEFAULT_MAX_FAN_OUT;
		const confidenceThreshold =
			options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
		const symbolTypes = options.symbolTypes ?? null;

		return {
			maxDepth,
			maxFanOut,
			confidenceThreshold,
			symbolTypes,
			branch: options.branch,
		};
	}

	function matchesTypeFilter(
		symbol: SymbolNode,
		symbolTypes: SymbolType[] | null,
	): boolean {
		if (!symbolTypes) return true;
		return symbolTypes.includes(symbol.type);
	}

	function filterEdgesByConfidence(
		edges: SymbolEdge[],
		threshold: number,
	): SymbolEdge[] {
		return edges.filter((edge) => edge.confidence >= threshold);
	}

	function limitEdges(
		edges: SymbolEdge[],
		maxFanOut: number,
	): { edges: SymbolEdge[]; truncated: boolean } {
		if (edges.length <= maxFanOut) {
			return { edges, truncated: false };
		}
		// Sort by confidence descending, take top N
		const sorted = [...edges].sort((a, b) => b.confidence - a.confidence);
		return { edges: sorted.slice(0, maxFanOut), truncated: true };
	}

	function traverseCallers(
		rootSymbol: SymbolNode,
		options: ReturnType<typeof parseOptions>,
	): GraphExpansionResult {
		const nodes = new Map<string, GraphNode>();
		const allEdges: SymbolEdge[] = [];
		const visited = new Set<string>();
		let maxDepthReached = 0;
		let truncatedNodes = 0;

		// Initialize with root
		nodes.set(rootSymbol.id, { symbol: rootSymbol, depth: 0, edges: [] });
		visited.add(rootSymbol.id);

		// BFS traversal
		const queue: Array<{ symbolId: string; depth: number }> = [
			{ symbolId: rootSymbol.id, depth: 0 },
		];

		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.depth >= options.maxDepth) continue;

			// Get callers (edges where target_id is current symbol)
			const callerEdges = edgeStore.getCallers(
				current.symbolId,
				options.branch,
			);
			const filteredEdges = filterEdgesByConfidence(
				callerEdges,
				options.confidenceThreshold,
			);
			const { edges: limitedEdges, truncated } = limitEdges(
				filteredEdges,
				options.maxFanOut,
			);

			if (truncated) truncatedNodes++;

			for (const edge of limitedEdges) {
				allEdges.push(edge);

				if (visited.has(edge.source_id)) continue;
				visited.add(edge.source_id);

				const callerSymbol = symbolStore.getById(edge.source_id);
				if (!callerSymbol) continue;

				if (!matchesTypeFilter(callerSymbol, options.symbolTypes)) continue;

				const nextDepth = current.depth + 1;
				maxDepthReached = Math.max(maxDepthReached, nextDepth);

				nodes.set(callerSymbol.id, {
					symbol: callerSymbol,
					depth: nextDepth,
					edges: [edge],
				});

				queue.push({ symbolId: callerSymbol.id, depth: nextDepth });
			}
		}

		return {
			root: rootSymbol,
			nodes,
			edges: allEdges,
			stats: {
				totalNodes: nodes.size,
				totalEdges: allEdges.length,
				maxDepthReached,
				truncatedNodes,
			},
		};
	}

	function traverseCallees(
		rootSymbol: SymbolNode,
		options: ReturnType<typeof parseOptions>,
	): GraphExpansionResult {
		const nodes = new Map<string, GraphNode>();
		const allEdges: SymbolEdge[] = [];
		const visited = new Set<string>();
		let maxDepthReached = 0;
		let truncatedNodes = 0;

		// Initialize with root
		nodes.set(rootSymbol.id, { symbol: rootSymbol, depth: 0, edges: [] });
		visited.add(rootSymbol.id);

		// BFS traversal
		const queue: Array<{ symbolId: string; depth: number }> = [
			{ symbolId: rootSymbol.id, depth: 0 },
		];

		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.depth >= options.maxDepth) continue;

			// Get callees (edges where source_id is current symbol)
			const calleeEdges = edgeStore.getCallees(
				current.symbolId,
				options.branch,
			);
			const filteredEdges = filterEdgesByConfidence(
				calleeEdges,
				options.confidenceThreshold,
			);
			const { edges: limitedEdges, truncated } = limitEdges(
				filteredEdges,
				options.maxFanOut,
			);

			if (truncated) truncatedNodes++;

			for (const edge of limitedEdges) {
				allEdges.push(edge);

				if (visited.has(edge.target_id)) continue;
				visited.add(edge.target_id);

				const calleeSymbol = symbolStore.getById(edge.target_id);
				if (!calleeSymbol) continue;

				if (!matchesTypeFilter(calleeSymbol, options.symbolTypes)) continue;

				const nextDepth = current.depth + 1;
				maxDepthReached = Math.max(maxDepthReached, nextDepth);

				nodes.set(calleeSymbol.id, {
					symbol: calleeSymbol,
					depth: nextDepth,
					edges: [edge],
				});

				queue.push({ symbolId: calleeSymbol.id, depth: nextDepth });
			}
		}

		return {
			root: rootSymbol,
			nodes,
			edges: allEdges,
			stats: {
				totalNodes: nodes.size,
				totalEdges: allEdges.length,
				maxDepthReached,
				truncatedNodes,
			},
		};
	}

	return {
		findCallers(
			symbolId: string,
			options: GraphExpansionOptions,
		): GraphExpansionResult | null {
			const rootSymbol = symbolStore.getById(symbolId);
			if (!rootSymbol) return null;

			const parsedOptions = parseOptions(options);
			return traverseCallers(rootSymbol, parsedOptions);
		},

		findCallees(
			symbolId: string,
			options: GraphExpansionOptions,
		): GraphExpansionResult | null {
			const rootSymbol = symbolStore.getById(symbolId);
			if (!rootSymbol) return null;

			const parsedOptions = parseOptions(options);
			return traverseCallees(rootSymbol, parsedOptions);
		},
	};
}
