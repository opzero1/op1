/**
 * Smart Query - Hybrid search with parallel retrieval, RRF fusion, and graph expansion
 *
 * Orchestrates the full semantic search pipeline:
 * 1. Parallel vector + BM25 keyword search
 * 2. RRF fusion for rank combination
 * 3. Graph expansion for caller/callee context
 * 4. Token-budget aware context building
 */

import type { Database } from "bun:sqlite";
import type { EdgeStore } from "../storage/edge-store";
import type { SymbolStore } from "../storage/symbol-store";
import type { QueryOptions, QueryResult, RerankMode, SymbolEdge, SymbolNode, SymbolType } from "../types";
import type { Embedder } from "../embeddings";
import { createGraphExpander, type GraphExpander } from "./graph-expander";
import { createKeywordSearcher, type KeywordSearcher } from "./keyword-search";
import { fuseWithRrf, type FusedResult } from "./rrf-fusion";
import { createVectorSearcher, type VectorSearcher } from "./vector-search";
import { createBM25Reranker, type Reranker, type RerankItem } from "./reranker";

// ============================================================================
// Types
// ============================================================================

export interface SmartQueryOptions extends QueryOptions {
	/** Query embedding (required for vector search) */
	embedding?: number[];
	/** Raw query text (required for keyword search) */
	queryText?: string;
}

export interface SmartQueryConfig {
	/** Optional embedder for query-time embedding generation */
	embedder?: Embedder;
}

export interface SmartQuery {
	search(options: SmartQueryOptions): Promise<QueryResult>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_GRAPH_DEPTH = 2;
const DEFAULT_MAX_FAN_OUT = 10;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const RETRIEVAL_LIMIT = 20;

// Rough token estimation: ~4 chars per token
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Implementation
// ============================================================================

export function createSmartQuery(
	db: Database,
	symbolStore: SymbolStore,
	edgeStore: EdgeStore,
	config?: SmartQueryConfig,
): SmartQuery {
	const vectorSearcher = createVectorSearcher(db);
	const keywordSearcher = createKeywordSearcher(db);
	const graphExpander = createGraphExpander(symbolStore, edgeStore);
	const reranker = createBM25Reranker();
	const embedder = config?.embedder;

	return {
		async search(options: SmartQueryOptions): Promise<QueryResult> {
			const startTime = Date.now();

			const parsedOptions = parseQueryOptions(options);

			// Generate embedding if not provided but embedder available
			if (!parsedOptions.embedding && parsedOptions.queryText && embedder) {
				parsedOptions.embedding = await embedder.embed(parsedOptions.queryText);
			}

			// Guard: need at least one search method
			if (!parsedOptions.embedding && !parsedOptions.queryText) {
				return createEmptyResult(startTime);
			}

			// Step 1: Parallel retrieval
			const [vectorResults, keywordResults] = await runParallelRetrieval(
				vectorSearcher,
				keywordSearcher,
				parsedOptions,
			);

			// Step 2: RRF fusion
			let fusedResults = fuseWithRrf(vectorResults, keywordResults);

			// Guard: no results from fusion
			if (fusedResults.length === 0) {
				return createEmptyResult(startTime);
			}

			// Step 3: Hydrate symbols from fused results
			let hydratedSymbols = hydrateSymbols(fusedResults, symbolStore);

			// Step 3.5: Apply reranking if enabled
			if (parsedOptions.rerankMode && parsedOptions.rerankMode !== "none" && parsedOptions.queryText) {
				hydratedSymbols = applyReranking(
					hydratedSymbols,
					fusedResults,
					parsedOptions.queryText,
					reranker,
				);
			}

			// Step 4: Graph expansion for top results
			const expansionResult = expandGraphForTopSymbols(
				hydratedSymbols,
				graphExpander,
				parsedOptions,
			);

			// Step 5: Token-budget aware context building
			const contextResult = buildContextWithinBudget(
				expansionResult.symbols,
				expansionResult.edges,
				parsedOptions.maxTokens,
			);

			return {
				symbols: contextResult.symbols,
				edges: expansionResult.edges,
				context: contextResult.context,
				tokenCount: contextResult.tokenCount,
				metadata: {
					queryTime: Date.now() - startTime,
					vectorHits: vectorResults.length,
					keywordHits: keywordResults.length,
					graphExpansions: expansionResult.expansionCount,
					confidence: determineConfidence(vectorResults.length, keywordResults.length),
				},
			};
		},
	};
}

// ============================================================================
// Parsing & Validation
// ============================================================================

interface ParsedQueryOptions {
	embedding: number[] | null;
	queryText: string | null;
	branch: string;
	maxTokens: number;
	graphDepth: number;
	maxFanOut: number;
	confidenceThreshold: number;
	symbolTypes: SymbolType[] | null;
	rerankMode: RerankMode | null;
}

function parseQueryOptions(options: SmartQueryOptions): ParsedQueryOptions {
	return {
		embedding: options.embedding && options.embedding.length > 0 ? options.embedding : null,
		queryText: options.queryText?.trim() || null,
		branch: options.branch ?? "main",
		maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
		graphDepth: Math.min(options.graphDepth ?? DEFAULT_GRAPH_DEPTH, 3),
		maxFanOut: options.maxFanOut ?? DEFAULT_MAX_FAN_OUT,
		confidenceThreshold: options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
		symbolTypes: options.symbolTypes ?? null,
		rerankMode: options.rerank ?? null,
	};
}

// ============================================================================
// Parallel Retrieval
// ============================================================================

async function runParallelRetrieval(
	vectorSearcher: VectorSearcher,
	keywordSearcher: KeywordSearcher,
	options: ParsedQueryOptions,
): Promise<[Array<{ symbolId: string }>, Array<{ symbolId: string }>]> {
	const vectorPromise = options.embedding
		? Promise.resolve(
				vectorSearcher.search(options.embedding, {
					limit: RETRIEVAL_LIMIT,
					branch: options.branch,
				}),
			)
		: Promise.resolve([]);

	const keywordPromise = options.queryText
		? Promise.resolve(
				keywordSearcher.search(options.queryText, {
					limit: RETRIEVAL_LIMIT,
				}),
			)
		: Promise.resolve([]);

	const [vectorResults, keywordResults] = await Promise.all([vectorPromise, keywordPromise]);

	return [vectorResults, keywordResults];
}

// ============================================================================
// Symbol Hydration
// ============================================================================

function hydrateSymbols(
	fusedResults: FusedResult[],
	symbolStore: SymbolStore,
): SymbolNode[] {
	const symbols: SymbolNode[] = [];

	for (const result of fusedResults) {
		const symbol = symbolStore.getById(result.symbolId);
		if (symbol) {
			symbols.push(symbol);
		}
	}

	return symbols;
}

// ============================================================================
// Reranking
// ============================================================================

function applyReranking(
	symbols: SymbolNode[],
	fusedResults: FusedResult[],
	queryText: string,
	reranker: Reranker,
): SymbolNode[] {
	if (symbols.length === 0) return symbols;

	// Build score map from fused results
	const scoreMap = new Map<string, number>();
	for (const result of fusedResults) {
		scoreMap.set(result.symbolId, result.rrfScore);
	}

	// Convert symbols to rerank items
	const rerankItems: RerankItem[] = symbols.map((symbol) => ({
		id: symbol.id,
		content: symbol.content,
		file_path: symbol.file_path,
		initialScore: scoreMap.get(symbol.id) ?? 0,
		granularity: "symbol" as const,
	}));

	// Apply reranking
	const reranked = reranker.rerank(rerankItems, {
		query: queryText,
		limit: symbols.length,
	});

	// Reorder symbols based on reranked order
	const symbolMap = new Map<string, SymbolNode>();
	for (const symbol of symbols) {
		symbolMap.set(symbol.id, symbol);
	}

	return reranked
		.map((result) => symbolMap.get(result.id))
		.filter((s): s is SymbolNode => s !== undefined);
}

// ============================================================================
// Graph Expansion
// ============================================================================

interface ExpansionResult {
	symbols: SymbolNode[];
	edges: SymbolEdge[];
	expansionCount: number;
}

function expandGraphForTopSymbols(
	symbols: SymbolNode[],
	graphExpander: GraphExpander,
	options: ParsedQueryOptions,
): ExpansionResult {
	// Only expand top 5 symbols to limit scope
	const topSymbols = symbols.slice(0, 5);
	const allSymbols = new Map<string, SymbolNode>();
	const allEdges: SymbolEdge[] = [];
	let expansionCount = 0;

	// Add original symbols
	for (const symbol of symbols) {
		allSymbols.set(symbol.id, symbol);
	}

	// Expand each top symbol
	for (const symbol of topSymbols) {
		const callersResult = graphExpander.findCallers(symbol.id, {
			branch: options.branch,
			maxDepth: options.graphDepth,
			maxFanOut: options.maxFanOut,
			confidenceThreshold: options.confidenceThreshold,
			symbolTypes: options.symbolTypes ?? undefined,
		});

		if (callersResult) {
			expansionCount++;
			for (const [id, node] of callersResult.nodes) {
				if (!allSymbols.has(id)) {
					allSymbols.set(id, node.symbol);
				}
			}
			allEdges.push(...callersResult.edges);
		}

		const calleesResult = graphExpander.findCallees(symbol.id, {
			branch: options.branch,
			maxDepth: options.graphDepth,
			maxFanOut: options.maxFanOut,
			confidenceThreshold: options.confidenceThreshold,
			symbolTypes: options.symbolTypes ?? undefined,
		});

		if (calleesResult) {
			expansionCount++;
			for (const [id, node] of calleesResult.nodes) {
				if (!allSymbols.has(id)) {
					allSymbols.set(id, node.symbol);
				}
			}
			allEdges.push(...calleesResult.edges);
		}
	}

	// Deduplicate edges by id
	const uniqueEdges = deduplicateEdges(allEdges);

	return {
		symbols: Array.from(allSymbols.values()),
		edges: uniqueEdges,
		expansionCount,
	};
}

function deduplicateEdges(edges: SymbolEdge[]): SymbolEdge[] {
	const seen = new Map<string, SymbolEdge>();
	for (const edge of edges) {
		if (!seen.has(edge.id)) {
			seen.set(edge.id, edge);
		}
	}
	return Array.from(seen.values());
}

// ============================================================================
// Context Building
// ============================================================================

interface ContextResult {
	symbols: SymbolNode[];
	context: string;
	tokenCount: number;
}

function buildContextWithinBudget(
	symbols: SymbolNode[],
	edges: SymbolEdge[],
	maxTokens: number,
): ContextResult {
	const includedSymbols: SymbolNode[] = [];
	const contextParts: string[] = [];
	let currentTokens = 0;

	// Sort symbols by importance (original search order is already ranked)
	for (const symbol of symbols) {
		const symbolContext = formatSymbolContext(symbol);
		const symbolTokens = estimateTokens(symbolContext);

		// Check if adding this symbol would exceed budget
		if (currentTokens + symbolTokens > maxTokens) {
			// Try to add truncated version if we have room
			const remainingTokens = maxTokens - currentTokens;
			if (remainingTokens > 100) {
				const truncatedContext = truncateToTokens(symbolContext, remainingTokens);
				contextParts.push(truncatedContext);
				currentTokens += estimateTokens(truncatedContext);
				includedSymbols.push(symbol);
			}
			break;
		}

		contextParts.push(symbolContext);
		currentTokens += symbolTokens;
		includedSymbols.push(symbol);
	}

	return {
		symbols: includedSymbols,
		context: contextParts.join("\n\n---\n\n"),
		tokenCount: currentTokens,
	};
}

function formatSymbolContext(symbol: SymbolNode): string {
	const parts: string[] = [];

	// Header with metadata
	parts.push(`## ${symbol.type}: ${symbol.qualified_name}`);
	parts.push(`File: ${symbol.file_path}:${symbol.start_line}-${symbol.end_line}`);

	if (symbol.signature) {
		parts.push(`Signature: ${symbol.signature}`);
	}

	if (symbol.docstring) {
		parts.push(`\nDocumentation:\n${symbol.docstring}`);
	}

	parts.push(`\nSource:\n\`\`\`${symbol.language}\n${symbol.content}\n\`\`\``);

	return parts.join("\n");
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateToTokens(text: string, maxTokens: number): string {
	const maxChars = maxTokens * CHARS_PER_TOKEN;
	if (text.length <= maxChars) return text;

	// Truncate and add ellipsis
	return text.slice(0, maxChars - 3) + "...";
}

// ============================================================================
// Result Helpers
// ============================================================================

function createEmptyResult(startTime: number): QueryResult {
	return {
		symbols: [],
		edges: [],
		context: "",
		tokenCount: 0,
		metadata: {
			queryTime: Date.now() - startTime,
			vectorHits: 0,
			keywordHits: 0,
			graphExpansions: 0,
			confidence: "low",
		},
	};
}

function determineConfidence(
	vectorHits: number,
	keywordHits: number,
): "high" | "medium" | "low" | "degraded" {
	const totalHits = vectorHits + keywordHits;

	if (totalHits === 0) return "low";
	if (vectorHits > 0 && keywordHits > 0) return "high";
	if (totalHits >= 5) return "medium";
	return "low";
}
