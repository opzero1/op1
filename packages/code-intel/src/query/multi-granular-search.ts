/**
 * Multi-Granularity Search - Orchestrates search across symbols, chunks, and files
 *
 * Combines results using Reciprocal Rank Fusion (RRF) with configurable weights.
 * Integrates:
 * - Query rewriting (term expansion, file pattern extraction)
 * - Reranking (BM25/simple heuristics)
 * - Context caching (LRU with TTL)
 */

import type { ChunkNode, Granularity, SymbolNode } from "../types";
import type { ContentFTSStore, FTSSearchResult } from "../storage/content-fts-store";
import type { GranularVectorStore, GranularVectorSearchResult } from "../storage/pure-vector-store";
import type { ChunkStore } from "../storage/chunk-store";
import type { SymbolStore } from "../storage/symbol-store";
import { createQueryRewriter, type QueryRewriter, type RewrittenQuery } from "./query-rewriter";
import { createBM25Reranker, createSimpleReranker, type Reranker, type RerankItem } from "./reranker";
import { createVoyageReranker, isVoyageRerankerAvailable } from "./voyage-reranker";
import { createContextCache, generateCacheKey, type ContextCache, type ContextCacheStats } from "./context-cache";
import { matchesPathFilters } from "./path-filter";

// ============================================================================
// Constants
// ============================================================================

/**
 * Minimum similarity threshold for vector results.
 * Matches the threshold in vector-search.ts — code embeddings score lower than NL.
 */
const MIN_SIMILARITY = 0.25;

// ============================================================================
// Types
// ============================================================================

export interface MultiGranularResult {
	/** Symbol-level results */
	symbols: SymbolNode[];
	/** Chunk-level results */
	chunks: ChunkNode[];
	/** File paths with relevance scores */
	files: Array<{ file_path: string; score: number }>;
	/** Combined and ranked results */
	ranked: Array<{
		id: string;
		granularity: Granularity;
		score: number;
		file_path: string;
		content: string;
		start_line?: number;
		end_line?: number;
	}>;
	/** Search metadata */
	metadata: {
		queryTime: number;
		symbolHits: number;
		chunkHits: number;
		fileHits: number;
		ftsHits: number;
		vectorHits: number;
	};
}

export interface MultiGranularSearchOptions {
	/** Maximum results per granularity */
	limit?: number;
	/** Filter by granularity (default: all) */
	granularity?: Granularity | "auto";
	/** Weight for symbol results (default: 1.0) */
	symbolWeight?: number;
	/** Weight for chunk results (default: 0.7) */
	chunkWeight?: number;
	/** Weight for file results (default: 0.3) */
	fileWeight?: number;
	/** RRF k parameter (default: 60) */
	rrfK?: number;
	/** Current branch */
	branch: string;
	/** Path prefix for scoping to a project subdirectory (e.g. "packages/core/") */
	pathPrefix?: string;
	/** File patterns to filter */
	filePatterns?: string[];
}

export interface MultiGranularSearch {
	/** Search across all granularities */
	search(query: string, embedding: number[], options: MultiGranularSearchOptions): MultiGranularResult;
	
	/** Search only with keywords (FTS) */
	searchKeywords(query: string, options: MultiGranularSearchOptions): MultiGranularResult;
	
	/** Search only with vectors */
	searchVectors(embedding: number[], options: MultiGranularSearchOptions): MultiGranularResult;
}

// ============================================================================
// RRF Fusion
// ============================================================================

export interface RankedItem {
	id: string;
	granularity: Granularity;
	score: number;
	file_path: string;
	content: string;
	start_line?: number;
	end_line?: number;
}

/** Escape regex special chars for use in RegExp constructor */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Boost score for items where short query tokens appear as whole words */
export function applyWordBoundaryBoost(ranked: RankedItem[], query: string): RankedItem[] {
	const tokens = query.split(/\s+/).filter(t => t.length > 0 && t.length < 4);
	if (tokens.length === 0) return ranked; // No short tokens to boost

	const patterns = tokens.map(t => new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i'));

	return ranked.map(item => {
		const hasWordBoundaryMatch = patterns.some(p => p.test(item.content));
		return hasWordBoundaryMatch
			? { ...item, score: item.score * 1.5 }
			: item;
	}).sort((a, b) => b.score - a.score);
}

/**
 * Reciprocal Rank Fusion - combines multiple ranked lists
 * Score = sum(1 / (k + rank)) across all lists where item appears
 */
function rrfFusion(
	lists: Array<{ items: RankedItem[]; weight: number }>,
	k: number = 60,
	limit: number = 50,
): RankedItem[] {
	const scores = new Map<string, { item: RankedItem; score: number }>();

	for (const { items, weight } of lists) {
		for (let rank = 0; rank < items.length; rank++) {
			const item = items[rank];
			const rrfScore = weight / (k + rank + 1);

			const existing = scores.get(item.id);
			if (existing) {
				existing.score += rrfScore;
				// Merge metadata from later occurrences (e.g., vector results carry start_line/end_line but FTS doesn't)
				if (item.start_line !== undefined && existing.item.start_line === undefined) {
					existing.item = { ...existing.item, start_line: item.start_line, end_line: item.end_line };
				}
			} else {
				scores.set(item.id, { item, score: rrfScore });
			}
		}
	}

	// Sort by combined score
	const results = Array.from(scores.values())
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ item, score }) => ({ ...item, score }));

	return results;
}

// ============================================================================
// Multi-Granular Search Implementation
// ============================================================================

export interface MultiGranularSearchDeps {
	contentFTS: ContentFTSStore;
	granularVectors: GranularVectorStore;
	chunkStore: ChunkStore;
	symbolStore: SymbolStore;
}

// ============================================================================
// Enhanced Multi-Granular Search with Reranking, Rewriting, and Caching
// ============================================================================

export interface EnhancedSearchOptions extends MultiGranularSearchOptions {
	/** Enable query rewriting (term expansion, file patterns) */
	enableRewriting?: boolean;
	/** Enable result reranking */
	enableReranking?: boolean;
	/** Reranker type: 'bm25' | 'simple' | 'voyage' */
	rerankerType?: "bm25" | "simple" | "voyage";
	/** Enable result caching */
	enableCaching?: boolean;
	/** Skip cache for this query (force fresh results) */
	skipCache?: boolean;
}

export interface EnhancedSearchResult extends MultiGranularResult {
	/** Rewritten query info */
	rewrittenQuery?: RewrittenQuery;
	/** Whether result came from cache */
	fromCache: boolean;
	/** Extended metadata */
	metadata: MultiGranularResult["metadata"] & {
		rewriteTime?: number;
		rerankTime?: number;
		cacheHit?: boolean;
	};
}

export interface EnhancedMultiGranularSearch extends MultiGranularSearch {
	/** Enhanced search with rewriting, reranking, and caching */
	searchEnhanced(
		query: string,
		embedding: number[],
		options: EnhancedSearchOptions,
	): Promise<EnhancedSearchResult>;

	/** Get cache statistics */
	getCacheStats(): ContextCacheStats;

	/** Clear the cache */
	clearCache(): void;

	/** Invalidate cache entries for a file */
	invalidateCacheForFile(filePath: string): number;
}

export interface EnhancedMultiGranularSearchDeps extends MultiGranularSearchDeps {
	/** Optional query rewriter (created if not provided) */
	queryRewriter?: QueryRewriter;
	/** Optional reranker (created if not provided) */
	reranker?: Reranker;
	/** Optional cache (created if not provided) */
	cache?: ContextCache<MultiGranularResult>;
}

export function createEnhancedMultiGranularSearch(
	deps: EnhancedMultiGranularSearchDeps,
): EnhancedMultiGranularSearch {
	// Create or use provided components
	const queryRewriter = deps.queryRewriter ?? createQueryRewriter();
	const bm25Reranker = createBM25Reranker();
	const simpleReranker = createSimpleReranker();
	const cache = deps.cache ?? createContextCache<MultiGranularResult>({
		maxEntries: 100,
		ttlMs: 5 * 60 * 1000, // 5 minutes
	});

	// Create base search
	const baseSearch = createMultiGranularSearch(deps);

	// Re-derive symbols/chunks/files from ranked items (shared between base and enhanced)
	function extractResults(
		ranked: RankedItem[],
	): { symbols: SymbolNode[]; chunks: ChunkNode[]; files: Array<{ file_path: string; score: number }> } {
		const symbols: SymbolNode[] = [];
		const chunks: ChunkNode[] = [];
		const fileScores = new Map<string, number>();

		for (const item of ranked) {
			const existing = fileScores.get(item.file_path) ?? 0;
			fileScores.set(item.file_path, existing + item.score);

			if (item.granularity === "symbol") {
				const symbol = deps.symbolStore.getById(item.id);
				if (symbol) symbols.push(symbol);
			} else if (item.granularity === "chunk" || item.granularity === "file") {
				const chunk = deps.chunkStore.getById(item.id);
				if (chunk) chunks.push(chunk);
			}
		}

		const files = Array.from(fileScores.entries())
			.map(([file_path, score]) => ({ file_path, score }))
			.sort((a, b) => b.score - a.score);

		return { symbols, chunks, files };
	}

	function applyReranking(
		ranked: RankedItem[],
		query: string,
		rerankerType: "bm25" | "simple",
	): RankedItem[] {
		const reranker = rerankerType === "bm25" ? bm25Reranker : simpleReranker;

		// Build metadata map to preserve start_line/end_line through reranking
		const metadataMap = new Map<string, { start_line?: number; end_line?: number }>();
		for (const r of ranked) {
			metadataMap.set(r.id, { start_line: r.start_line, end_line: r.end_line });
		}

		const rerankItems: RerankItem[] = ranked.map((r) => ({
			id: r.id,
			content: r.content,
			file_path: r.file_path,
			initialScore: r.score,
			granularity: r.granularity,
		}));

		const reranked = reranker.rerank(rerankItems, { query, limit: ranked.length });

		return reranked.map((r) => ({
			id: r.id,
			granularity: r.granularity,
			score: r.finalScore,
			file_path: r.file_path,
			content: r.content,
			...metadataMap.get(r.id),
		}));
	}

	async function applyVoyageReranking(
		ranked: RankedItem[],
		query: string,
	): Promise<RankedItem[]> {
		if (!isVoyageRerankerAvailable()) {
			console.warn("[code-intel] Voyage AI reranker unavailable (VOYAGE_AI_API_KEY not set), falling back to BM25 reranking");
			return applyReranking(ranked, query, "bm25");
		}

		try {
			const voyageReranker = createVoyageReranker();

			// Build metadata map to preserve start_line/end_line through reranking
			const metadataMap = new Map<string, { start_line?: number; end_line?: number }>();
			for (const r of ranked) {
				metadataMap.set(r.id, { start_line: r.start_line, end_line: r.end_line });
			}

			const rerankItems: RerankItem[] = ranked.map((r) => ({
				id: r.id,
				content: r.content,
				file_path: r.file_path,
				initialScore: r.score,
				granularity: r.granularity,
			}));

			const reranked = await voyageReranker.rerank(rerankItems, { query, limit: ranked.length });

			return reranked.map((r) => ({
				id: r.id,
				granularity: r.granularity,
				score: r.finalScore,
				file_path: r.file_path,
				content: r.content,
				...metadataMap.get(r.id),
			}));
		} catch (err) {
			console.warn("[code-intel] Voyage AI reranker failed, falling back to BM25 reranking:", err instanceof Error ? err.message : String(err));
			return applyReranking(ranked, query, "bm25");
		}
	}

	return {
		// Inherit base methods
		search: baseSearch.search,
		searchKeywords: baseSearch.searchKeywords,
		searchVectors: baseSearch.searchVectors,

		async searchEnhanced(
			query: string,
			embedding: number[],
			options: EnhancedSearchOptions,
		): Promise<EnhancedSearchResult> {
			const startTime = Date.now();
			const {
				enableRewriting = true,
				enableReranking = true,
				rerankerType = "bm25",
				enableCaching = true,
				skipCache = false,
				branch,
				granularity,
				limit,
				filePatterns,
				pathPrefix,
			} = options;

			// Generate cache key
			const cacheKey = generateCacheKey({
				query,
				branch,
				granularity: granularity ?? "auto",
				limit,
				filePatterns,
				pathPrefix,
				rerankerType,
				enableReranking,
			});

			// Check cache first (if enabled and not skipped)
			if (enableCaching && !skipCache) {
				const cached = cache.get(cacheKey);
				if (cached) {
					return {
						...cached,
						fromCache: true,
						metadata: {
							...cached.metadata,
							cacheHit: true,
						},
					};
				}
			}

			// Step 1: Rewrite query (if enabled)
			let rewrittenQuery: RewrittenQuery | undefined;
			let rewriteTime = 0;
			let effectiveQuery = query;
			let effectiveFilePatterns = filePatterns;

			if (enableRewriting) {
				const rewriteStart = Date.now();
				rewrittenQuery = queryRewriter.rewrite(query);
				effectiveQuery = rewrittenQuery.expanded;
				// Merge extracted file patterns with provided ones
				if (rewrittenQuery.filePatterns.length > 0) {
					effectiveFilePatterns = [
						...(filePatterns ?? []),
						...rewrittenQuery.filePatterns,
					];
				}
				rewriteTime = Date.now() - rewriteStart;
			}

			// Step 2: Perform base search
			const baseResult = baseSearch.search(effectiveQuery, embedding, {
				...options,
				filePatterns: effectiveFilePatterns,
			});

			// Step 3: Rerank results (if enabled)
			let rerankTime = 0;
			let finalRanked = baseResult.ranked;

			if (enableReranking && baseResult.ranked.length > 0) {
				const rerankStart = Date.now();
				finalRanked = rerankerType === "voyage"
					? await applyVoyageReranking(baseResult.ranked, query)
					: applyReranking(baseResult.ranked, query, rerankerType);
				rerankTime = Date.now() - rerankStart;
			}

			// Re-derive symbols/chunks/files from finalRanked to preserve reranked order
			const { symbols: finalSymbols, chunks: finalChunks, files: finalFiles } = extractResults(finalRanked);

			// Build final result
			const result: EnhancedSearchResult = {
				symbols: finalSymbols,
				chunks: finalChunks,
				files: finalFiles,
				ranked: finalRanked,
				rewrittenQuery,
				fromCache: false,
				metadata: {
					queryTime: Date.now() - startTime,
					symbolHits: baseResult.metadata.symbolHits,
					chunkHits: baseResult.metadata.chunkHits,
					fileHits: baseResult.metadata.fileHits,
					ftsHits: baseResult.metadata.ftsHits,
					vectorHits: baseResult.metadata.vectorHits,
					rewriteTime,
					rerankTime,
					cacheHit: false,
				},
			};

			// Store in cache (if enabled)
			if (enableCaching) {
				cache.set(cacheKey, {
					symbols: result.symbols,
					chunks: result.chunks,
					files: result.files,
					ranked: result.ranked,
					metadata: result.metadata,
				});
			}

			return result;
		},

		getCacheStats(): ContextCacheStats {
			return cache.getStats();
		},

		clearCache(): void {
			cache.clear();
		},

		invalidateCacheForFile(filePath: string): number {
			return cache.invalidateByFile(filePath);
		},
	};
}

export function createMultiGranularSearch(deps: MultiGranularSearchDeps): MultiGranularSearch {
	const { contentFTS, granularVectors, chunkStore, symbolStore } = deps;

	function ftsResultsToRanked(results: FTSSearchResult[]): RankedItem[] {
		return results.map((r) => ({
			id: r.content_id,
			granularity: r.content_type,
			score: Math.abs(r.rank), // BM25 returns negative scores
			file_path: r.file_path,
			content: r.content,
		}));
	}

	function vectorResultsToRanked(
		results: GranularVectorSearchResult[],
		getContent: (id: string, granularity: Granularity) => { content: string; file_path: string; start_line?: number; end_line?: number } | null,
	): RankedItem[] {
		const ranked: RankedItem[] = [];
		for (const r of results) {
			// Skip results below minimum similarity threshold
			if (r.similarity < MIN_SIMILARITY) continue;

			const data = getContent(r.symbol_id, r.granularity);
			if (!data) continue;
			ranked.push({
				id: r.symbol_id,
				granularity: r.granularity,
				score: r.similarity,
				file_path: data.file_path,
				content: data.content,
				start_line: data.start_line,
				end_line: data.end_line,
			});
		}
		return ranked;
	}

	function getContentById(
		id: string,
		granularity: Granularity,
	): { content: string; file_path: string; start_line?: number; end_line?: number } | null {
		if (granularity === "symbol") {
			const symbol = symbolStore.getById(id);
			if (symbol) {
				return {
					content: symbol.content,
					file_path: symbol.file_path,
					start_line: symbol.start_line,
					end_line: symbol.end_line,
				};
			}
		} else if (granularity === "chunk") {
			const chunk = chunkStore.getById(id);
			if (chunk) {
				return {
					content: chunk.content,
					file_path: chunk.file_path,
					start_line: chunk.start_line,
					end_line: chunk.end_line,
				};
			}
		} else if (granularity === "file") {
			// File-granularity vectors use chunk IDs where chunk_type = "file"
			// These are stored in the chunks table alongside symbol and block chunks
			const chunk = chunkStore.getById(id);
			if (chunk) {
				return {
					content: chunk.content,
					file_path: chunk.file_path,
					start_line: chunk.start_line,
					end_line: chunk.end_line,
				};
			}
		}
		return null;
	}

	function extractResults(
		ranked: RankedItem[],
	): { symbols: SymbolNode[]; chunks: ChunkNode[]; files: Array<{ file_path: string; score: number }> } {
		const symbols: SymbolNode[] = [];
		const chunks: ChunkNode[] = [];
		const fileScores = new Map<string, number>();

		for (const item of ranked) {
			// Track file scores
			const existing = fileScores.get(item.file_path) ?? 0;
			fileScores.set(item.file_path, existing + item.score);

			if (item.granularity === "symbol") {
				const symbol = symbolStore.getById(item.id);
				if (symbol) symbols.push(symbol);
			} else if (item.granularity === "chunk") {
				const chunk = chunkStore.getById(item.id);
				if (chunk) chunks.push(chunk);
			} else if (item.granularity === "file") {
				// File-granularity results are stored as chunks with chunk_type = "file"
				const chunk = chunkStore.getById(item.id);
				if (chunk) chunks.push(chunk);
			}
		}

		const files = Array.from(fileScores.entries())
			.map(([file_path, score]) => ({ file_path, score }))
			.sort((a, b) => b.score - a.score);

		return { symbols, chunks, files };
	}

	return {
		search(
			query: string,
			embedding: number[],
			options: MultiGranularSearchOptions,
		): MultiGranularResult {
			const startTime = Date.now();
			const {
				limit = 50,
				granularity = "auto",
				symbolWeight = 1.0,
				chunkWeight = 0.7,
				fileWeight = 0.3,
				rrfK = 60,
				branch,
				filePatterns,
				pathPrefix,
			} = options;

			// Convert pathPrefix to file pattern for FTS filtering
			const effectiveFilePatterns = pathPrefix
				? [...(filePatterns ?? []), `${pathPrefix}**`]
				: filePatterns;

			// FTS search
			const ftsResults = contentFTS.search(query, {
				limit: limit * 2,
				contentType: granularity === "auto" ? undefined : granularity,
				filePatterns: effectiveFilePatterns,
			});

			// Vector search — over-fetch when path filters active, post-filter below
			const hasPathFilters = !!(pathPrefix || (filePatterns && filePatterns.length > 0));
			const vectorFetchLimit = hasPathFilters ? limit * 3 : limit * 2;
			const vectorResults = granularVectors.search(embedding, {
				limit: vectorFetchLimit,
				granularity: granularity === "auto" ? undefined : granularity,
			});

			// Convert to ranked items
			const ftsRanked = ftsResultsToRanked(ftsResults);
			let vectorRanked = vectorResultsToRanked(
				vectorResults,
				(id, g) => getContentById(id, g),
			);

			// Post-filter vector results by path (FTS is already filtered via filePatterns)
			if (hasPathFilters) {
				vectorRanked = vectorRanked.filter((r) =>
					matchesPathFilters(r.file_path, pathPrefix, filePatterns),
				);
			}

			// Separate by granularity for weighted fusion
			const symbolFTS = ftsRanked.filter((r) => r.granularity === "symbol");
			const chunkFTS = ftsRanked.filter((r) => r.granularity === "chunk");
			const fileFTS = ftsRanked.filter((r) => r.granularity === "file");

			const symbolVector = vectorRanked.filter((r) => r.granularity === "symbol");
			const chunkVector = vectorRanked.filter((r) => r.granularity === "chunk");
			const fileVector = vectorRanked.filter((r) => r.granularity === "file");

			// RRF fusion with granularity weights
			const ranked = rrfFusion(
				[
					{ items: symbolFTS, weight: symbolWeight },
					{ items: symbolVector, weight: symbolWeight },
					{ items: chunkFTS, weight: chunkWeight },
					{ items: chunkVector, weight: chunkWeight },
					{ items: fileFTS, weight: fileWeight },
					{ items: fileVector, weight: fileWeight },
				],
				rrfK,
				limit,
			);

			// Boost whole-word matches for short query tokens
			const boostedRanked = applyWordBoundaryBoost(ranked, query);

			const { symbols, chunks, files } = extractResults(boostedRanked);

			return {
				symbols,
				chunks,
				files,
				ranked: boostedRanked,
				metadata: {
					queryTime: Date.now() - startTime,
					symbolHits: symbols.length,
					chunkHits: chunks.length,
					fileHits: files.length,
					ftsHits: ftsResults.length,
					vectorHits: vectorResults.length,
				},
			};
		},

		searchKeywords(query: string, options: MultiGranularSearchOptions): MultiGranularResult {
			const startTime = Date.now();
			const {
				limit = 50,
				granularity = "auto",
				symbolWeight = 1.0,
				chunkWeight = 0.7,
				fileWeight = 0.3,
				rrfK = 60,
				branch,
				filePatterns,
				pathPrefix,
			} = options;

			// Convert pathPrefix to file pattern for FTS filtering
			const effectiveFilePatterns = pathPrefix
				? [...(filePatterns ?? []), `${pathPrefix}**`]
				: filePatterns;

			const ftsResults = contentFTS.search(query, {
				limit: limit * 2,
				contentType: granularity === "auto" ? undefined : granularity,
				filePatterns: effectiveFilePatterns,
			});

			const ftsRanked = ftsResultsToRanked(ftsResults);

			// Separate by granularity
			const symbolFTS = ftsRanked.filter((r) => r.granularity === "symbol");
			const chunkFTS = ftsRanked.filter((r) => r.granularity === "chunk");
			const fileFTS = ftsRanked.filter((r) => r.granularity === "file");

			const ranked = rrfFusion(
				[
					{ items: symbolFTS, weight: symbolWeight },
					{ items: chunkFTS, weight: chunkWeight },
					{ items: fileFTS, weight: fileWeight },
				],
				rrfK,
				limit,
			);

			// Boost whole-word matches for short query tokens
			const boostedRanked = applyWordBoundaryBoost(ranked, query);

			const { symbols, chunks, files } = extractResults(boostedRanked);

			return {
				symbols,
				chunks,
				files,
				ranked: boostedRanked,
				metadata: {
					queryTime: Date.now() - startTime,
					symbolHits: symbols.length,
					chunkHits: chunks.length,
					fileHits: files.length,
					ftsHits: ftsResults.length,
					vectorHits: 0,
				},
			};
		},

		searchVectors(embedding: number[], options: MultiGranularSearchOptions): MultiGranularResult {
			const startTime = Date.now();
			const {
				limit = 50,
				granularity = "auto",
				symbolWeight = 1.0,
				chunkWeight = 0.7,
				fileWeight = 0.3,
				rrfK = 60,
				filePatterns,
				pathPrefix,
			} = options;


			// GranularVectorStore.search() only accepts limit + granularity,
			// so we over-fetch and post-filter by path after resolving content.
			const hasPathFilters = !!(pathPrefix || (filePatterns && filePatterns.length > 0));
			const fetchLimit = hasPathFilters ? limit * 3 : limit * 2;

			const vectorResults = granularVectors.search(embedding, {
				limit: fetchLimit,
				granularity: granularity === "auto" ? undefined : granularity,
			});

			let vectorRanked = vectorResultsToRanked(
				vectorResults,
				(id, g) => getContentById(id, g),
			);

			// Post-filter by path when pathPrefix or filePatterns are active
			if (hasPathFilters) {
				vectorRanked = vectorRanked.filter((r) =>
					matchesPathFilters(r.file_path, pathPrefix, filePatterns),
				);
			}

			// Separate by granularity
			const symbolVector = vectorRanked.filter((r) => r.granularity === "symbol");
			const chunkVector = vectorRanked.filter((r) => r.granularity === "chunk");
			const fileVector = vectorRanked.filter((r) => r.granularity === "file");

			const ranked = rrfFusion(
				[
					{ items: symbolVector, weight: symbolWeight },
					{ items: chunkVector, weight: chunkWeight },
					{ items: fileVector, weight: fileWeight },
				],
				rrfK,
				limit,
			);

			const { symbols, chunks, files } = extractResults(ranked);

			return {
				symbols,
				chunks,
				files,
				ranked,
				metadata: {
					queryTime: Date.now() - startTime,
					symbolHits: symbols.length,
					chunkHits: chunks.length,
					fileHits: files.length,
					ftsHits: 0,
					vectorHits: vectorResults.length,
				},
			};
		},
	};
}
