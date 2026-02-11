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
import type { ConfidenceDiagnostics, Granularity, QueryOptions, QueryResult, RerankMode, SymbolEdge, SymbolNode, SymbolType } from "../types";
import type { Embedder } from "../embeddings";
import { createGraphExpander, type GraphExpander } from "./graph-expander";
import { createKeywordSearcher, type KeywordSearcher } from "./keyword-search";
import { fuseWithRrf, type FusedResult } from "./rrf-fusion";
import { createVectorSearcher, type VectorSearcher } from "./vector-search";
import { createBM25Reranker, type Reranker, type RerankItem } from "./reranker";
import type { ChunkStore } from "../storage/chunk-store";
import type { ContentFTSStore } from "../storage/content-fts-store";
import type { GranularVectorStore } from "../storage/pure-vector-store";
import { createEnhancedMultiGranularSearch, type EnhancedMultiGranularSearch, type EnhancedSearchResult } from "./multi-granular-search";

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
	/** Optional multi-granular search dependencies (enables enhanced pipeline) */
	multiGranular?: {
		chunkStore: ChunkStore;
		contentFTS: ContentFTSStore;
		granularVectors: GranularVectorStore;
	};
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

/** Base retrieval limit — overridden by adaptive sizing */
const BASE_RETRIEVAL_LIMIT = 20;
/** Minimum candidates to fetch per channel */
const MIN_RETRIEVAL_LIMIT = 10;
/** Maximum candidates to fetch per channel (latency guard) */
const MAX_RETRIEVAL_LIMIT = 50;

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

	// Create enhanced multi-granular search if deps available
	const enhancedSearch: EnhancedMultiGranularSearch | null =
		config?.multiGranular
			? createEnhancedMultiGranularSearch({
					contentFTS: config.multiGranular.contentFTS,
					granularVectors: config.multiGranular.granularVectors,
					chunkStore: config.multiGranular.chunkStore,
					symbolStore,
				})
			: null;

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
				return createEmptyResult(startTime, parsedOptions);
			}

			// Adaptive candidate sizing based on query complexity
			const retrievalLimit = computeAdaptiveLimit(parsedOptions);

			// Determine retrieval path: enhanced multi-granular vs simple
			let hydratedSymbols: SymbolNode[] = [];
			let vectorHitCount = 0;
			let keywordHitCount = 0;
			let fusedResults: FusedResult[] = [];

			let useSimplePath = !enhancedSearch || !parsedOptions.embedding || !parsedOptions.queryText;

			if (!useSimplePath) {
				try {
					// Enhanced path: multi-granular search with rewriting, reranking, caching
					const enhancedResult = enhancedSearch!.searchEnhanced(
						parsedOptions.queryText!,
						parsedOptions.embedding!,
						{
							branch: parsedOptions.branch,
							limit: retrievalLimit,
							granularity: parsedOptions.granularity ?? "auto",
							pathPrefix: parsedOptions.pathPrefix ?? undefined,
							filePatterns: parsedOptions.filePatterns ?? undefined,
							enableRewriting: true,
							enableReranking: parsedOptions.rerankMode !== null && parsedOptions.rerankMode !== "none",
							rerankerType: "bm25",
							enableCaching: true,
						},
					);

					// Bridge: extract symbols from enhanced result
					hydratedSymbols = enhancedResult.symbols;
					vectorHitCount = enhancedResult.metadata.vectorHits;
					keywordHitCount = enhancedResult.metadata.ftsHits;

					// If enhanced didn't produce symbols but has ranked items, hydrate from ranked
					if (hydratedSymbols.length === 0 && enhancedResult.ranked.length > 0) {
						for (const ranked of enhancedResult.ranked) {
							if (ranked.granularity === "symbol") {
								const sym = symbolStore.getById(ranked.id);
								if (sym) hydratedSymbols.push(sym);
							}
						}
					}
				} catch {
					// Enhanced search failed — fall back to simple path
					useSimplePath = true;
				}
			}

			if (useSimplePath) {
				// Simple path: parallel vector + keyword retrieval (original behavior)
				const [vectorResults, keywordResults] = await runParallelRetrieval(
					vectorSearcher,
					keywordSearcher,
					parsedOptions,
					retrievalLimit,
				);

				vectorHitCount = vectorResults.length;
				keywordHitCount = keywordResults.length;

				// RRF fusion
				fusedResults = fuseWithRrf(vectorResults, keywordResults);

				// Guard: no results from fusion
				if (fusedResults.length === 0) {
					return createEmptyResult(startTime, parsedOptions);
				}

				// Hydrate symbols
				hydratedSymbols = hydrateSymbols(fusedResults, symbolStore);

				// Apply reranking if enabled
				if (parsedOptions.rerankMode && parsedOptions.rerankMode !== "none" && parsedOptions.queryText) {
					hydratedSymbols = applyReranking(
						hydratedSymbols,
						fusedResults,
						parsedOptions.queryText,
						reranker,
					);
				}
			}

			// Guard: no symbols found from either path
			if (hydratedSymbols.length === 0) {
				return createEmptyResult(startTime, parsedOptions);
			}

			// Step 4: Graph expansion for top results (shared by both paths)
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

			// Multi-signal confidence scoring
			const confidenceResult = computeMultiSignalConfidence(
				vectorHitCount,
				keywordHitCount,
				hydratedSymbols,
				fusedResults,
			);

			return {
				symbols: contextResult.symbols,
				edges: expansionResult.edges,
				context: contextResult.context,
				tokenCount: contextResult.tokenCount,
				metadata: {
					queryTime: Date.now() - startTime,
					vectorHits: vectorHitCount,
					keywordHits: keywordHitCount,
					graphExpansions: expansionResult.expansionCount,
					confidence: confidenceResult.tier,
					confidenceDiagnostics: confidenceResult.diagnostics,
					candidateLimit: retrievalLimit,
					scope: {
						branch: parsedOptions.branch,
						pathPrefix: parsedOptions.pathPrefix ?? undefined,
						filePatterns: parsedOptions.filePatterns ?? undefined,
					},
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
	granularity: Granularity | "auto" | null;
	pathPrefix: string | null;
	filePatterns: string[] | null;
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
		granularity: options.granularity ?? null,
		pathPrefix: options.pathPrefix?.trim() || null,
		filePatterns: options.filePatterns ?? null,
	};
}

// ============================================================================
// Parallel Retrieval
// ============================================================================

async function runParallelRetrieval(
	vectorSearcher: VectorSearcher,
	keywordSearcher: KeywordSearcher,
	options: ParsedQueryOptions,
	retrievalLimit: number,
): Promise<[Array<{ symbolId: string }>, Array<{ symbolId: string }>]> {
	const vectorPromise = options.embedding
		? Promise.resolve(
				vectorSearcher.search(options.embedding, {
					limit: retrievalLimit,
					branch: options.branch,
					pathPrefix: options.pathPrefix ?? undefined,
					filePatterns: options.filePatterns ?? undefined,
				}),
			)
		: Promise.resolve([]);

	const keywordPromise = options.queryText
		? Promise.resolve(
				keywordSearcher.search(options.queryText, {
					limit: retrievalLimit,
					pathPrefix: options.pathPrefix ?? undefined,
					filePatterns: options.filePatterns ?? undefined,
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

function createEmptyResult(startTime: number, options?: ParsedQueryOptions): QueryResult {
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
			confidenceDiagnostics: {
				retrievalAgreement: 0,
				scoreSpread: 0,
				scopeConcentration: 0,
				uniqueFiles: 0,
				totalCandidates: 0,
				tierReason: "Empty result — no candidates found",
			},
			candidateLimit: options ? computeAdaptiveLimit(options) : BASE_RETRIEVAL_LIMIT,
			scope: options ? {
				branch: options.branch,
				pathPrefix: options.pathPrefix ?? undefined,
				filePatterns: options.filePatterns ?? undefined,
			} : undefined,
		},
	};
}

// ============================================================================
// Adaptive Candidate Sizing
// ============================================================================

/**
 * Compute retrieval limit based on query complexity heuristics.
 *
 * Sizing policy:
 * - Short queries (1-2 tokens): fewer candidates — likely navigational
 * - Medium queries (3-5 tokens): baseline candidates
 * - Long/complex queries (6+ tokens): more candidates — disambiguation needed
 * - Path-scoped queries: can afford more candidates (smaller search space)
 * - Higher maxTokens budget: allows more candidates to fill context
 */
function computeAdaptiveLimit(options: ParsedQueryOptions): number {
	const queryText = options.queryText ?? "";
	const wordCount = queryText.split(/\s+/).filter((w) => w.length > 0).length;

	let limit = BASE_RETRIEVAL_LIMIT;

	// Query complexity scaling
	if (wordCount <= 2) {
		// Short navigational queries — fewer candidates suffice
		limit = Math.round(BASE_RETRIEVAL_LIMIT * 0.75);
	} else if (wordCount >= 6) {
		// Complex queries — need more candidates for disambiguation
		limit = Math.round(BASE_RETRIEVAL_LIMIT * 1.5);
	}

	// Scoped queries can afford more candidates (smaller search space = faster)
	if (options.pathPrefix || (options.filePatterns && options.filePatterns.length > 0)) {
		limit = Math.round(limit * 1.25);
	}

	// Higher token budgets can benefit from more candidates
	if (options.maxTokens > DEFAULT_MAX_TOKENS) {
		const budgetMultiplier = Math.min(options.maxTokens / DEFAULT_MAX_TOKENS, 2);
		limit = Math.round(limit * Math.sqrt(budgetMultiplier));
	}

	// Clamp to bounds
	return Math.max(MIN_RETRIEVAL_LIMIT, Math.min(MAX_RETRIEVAL_LIMIT, limit));
}

// ============================================================================
// Multi-Signal Confidence Scoring
// ============================================================================

interface ConfidenceResult {
	tier: "high" | "medium" | "low" | "degraded";
	diagnostics: ConfidenceDiagnostics;
}

/**
 * Multi-signal confidence replaces the coarse hit-count-only heuristic.
 *
 * Signals:
 * 1. Retrieval agreement — do vector and keyword channels overlap?
 * 2. Score spread — is the top result decisively ahead of the rest?
 * 3. Scope concentration — are results focused in a few files/dirs?
 *
 * Each signal contributes to a weighted composite score [0-1].
 * Tier thresholds: high ≥ 0.7, medium ≥ 0.4, low ≥ 0.1, degraded < 0.1
 */
function computeMultiSignalConfidence(
	vectorHits: number,
	keywordHits: number,
	symbols: SymbolNode[],
	fusedResults: FusedResult[],
): ConfidenceResult {
	const totalHits = vectorHits + keywordHits;

	// Edge case: no results at all
	if (totalHits === 0 && symbols.length === 0) {
		return {
			tier: "degraded",
			diagnostics: {
				retrievalAgreement: 0,
				scoreSpread: 0,
				scopeConcentration: 0,
				uniqueFiles: 0,
				totalCandidates: 0,
				tierReason: "No results from any retrieval channel",
			},
		};
	}

	// Signal 1: Retrieval agreement (0-1)
	// How many fused results appear in BOTH vector and keyword channels?
	let agreementRatio = 0;
	if (fusedResults.length > 0) {
		const bothChannels = fusedResults.filter(
			(r) => r.sourceRanks.vector !== undefined && r.sourceRanks.keyword !== undefined,
		).length;
		agreementRatio = bothChannels / Math.max(fusedResults.length, 1);
	} else if (vectorHits > 0 && keywordHits > 0) {
		// Enhanced path — no fused results, but both channels contributed
		agreementRatio = 0.5;
	} else if (totalHits > 0) {
		// Single channel only
		agreementRatio = 0.1;
	}

	// Signal 2: Score spread (0-1)
	// Is the top result decisively ahead? Higher spread = more decisive ranking
	let scoreSpread = 0;
	if (fusedResults.length >= 2) {
		const topScore = fusedResults[0].rrfScore;
		const secondScore = fusedResults[1].rrfScore;
		const lastScore = fusedResults[fusedResults.length - 1].rrfScore;

		// Ratio of gap between top and second vs total range
		const totalRange = topScore - lastScore;
		if (totalRange > 0) {
			scoreSpread = Math.min((topScore - secondScore) / totalRange, 1);
		}
	} else if (symbols.length === 1) {
		// Single result — maximally decisive but uncertain
		scoreSpread = 0.5;
	}

	// Signal 3: Scope concentration (0-1)
	// Are results clustered in the same directory? Higher = more focused
	let scopeConcentration = 0;
	const uniqueFiles = new Set<string>();
	const dirCounts = new Map<string, number>();

	for (const sym of symbols) {
		uniqueFiles.add(sym.file_path);
		const dir = sym.file_path.split("/").slice(0, -1).join("/");
		dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
	}

	if (symbols.length > 0 && dirCounts.size > 0) {
		const maxDirCount = Math.max(...dirCounts.values());
		scopeConcentration = maxDirCount / symbols.length;
	}

	// Composite score: weighted combination
	const compositeScore =
		agreementRatio * 0.45 +
		scoreSpread * 0.25 +
		scopeConcentration * 0.30;

	// Determine tier from composite
	let tier: "high" | "medium" | "low" | "degraded";
	let tierReason: string;

	if (compositeScore >= 0.7) {
		tier = "high";
		tierReason = `Strong signals: agreement=${agreementRatio.toFixed(2)}, spread=${scoreSpread.toFixed(2)}, focus=${scopeConcentration.toFixed(2)}`;
	} else if (compositeScore >= 0.4) {
		tier = "medium";
		tierReason = `Moderate signals: agreement=${agreementRatio.toFixed(2)}, spread=${scoreSpread.toFixed(2)}, focus=${scopeConcentration.toFixed(2)}`;
	} else if (compositeScore >= 0.1) {
		tier = "low";
		tierReason = `Weak signals: agreement=${agreementRatio.toFixed(2)}, spread=${scoreSpread.toFixed(2)}, focus=${scopeConcentration.toFixed(2)}`;
	} else {
		tier = "degraded";
		tierReason = `Very weak signals: agreement=${agreementRatio.toFixed(2)}, spread=${scoreSpread.toFixed(2)}, focus=${scopeConcentration.toFixed(2)}`;
	}

	return {
		tier,
		diagnostics: {
			retrievalAgreement: agreementRatio,
			scoreSpread,
			scopeConcentration,
			uniqueFiles: uniqueFiles.size,
			totalCandidates: totalHits,
			tierReason,
		},
	};
}
