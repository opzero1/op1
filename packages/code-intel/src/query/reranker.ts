/**
 * Reranker - Rerank search results for improved precision
 *
 * Supports multiple strategies:
 * - Simple: BM25 + vector score weighted combination
 * - Cross-encoder: Uses LLM for pairwise relevance scoring (future)
 */

// ============================================================================
// Types
// ============================================================================

export interface RerankItem {
	id: string;
	content: string;
	file_path: string;
	initialScore: number;
	granularity: "symbol" | "chunk" | "file";
}

export interface RerankResult {
	id: string;
	content: string;
	file_path: string;
	finalScore: number;
	granularity: "symbol" | "chunk" | "file";
}

export interface RerankOptions {
	/** Maximum items to rerank (default: 50) */
	limit?: number;
	/** Query for relevance scoring */
	query: string;
	/** Boost factor for exact matches (default: 1.5) */
	exactMatchBoost?: number;
	/** Boost factor for file path matches (default: 1.2) */
	pathMatchBoost?: number;
}

export interface Reranker {
	/** Rerank a list of items */
	rerank(items: RerankItem[], options: RerankOptions): RerankResult[];
}

export interface AsyncReranker {
	/** Rerank a list of items asynchronously (e.g. via external API) */
	rerank(items: RerankItem[], options: RerankOptions): Promise<RerankResult[]>;
}

// ============================================================================
// Simple Reranker Implementation
// ============================================================================

/**
 * Creates a simple reranker that uses heuristics for reranking
 * - Boosts exact query matches
 * - Boosts file path matches
 * - Considers content length (shorter = more focused)
 */
export function createSimpleReranker(): Reranker {
	return {
		rerank(items: RerankItem[], options: RerankOptions): RerankResult[] {
			const {
				limit = 50,
				query,
				exactMatchBoost = 1.5,
				pathMatchBoost = 1.2,
			} = options;

			const queryLower = query.toLowerCase();
			const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);

			const results = items.slice(0, limit).map((item) => {
				let finalScore = item.initialScore;
				const contentLower = item.content.toLowerCase();
				const pathLower = item.file_path.toLowerCase();

				// Boost for exact query match in content
				if (contentLower.includes(queryLower)) {
					finalScore *= exactMatchBoost;
				}

				// Boost for query terms in file path
				for (const term of queryTerms) {
					if (pathLower.includes(term)) {
						finalScore *= pathMatchBoost;
						break; // Only apply once
					}
				}

				// Boost for term density (more query terms = higher score)
				let termMatches = 0;
				for (const term of queryTerms) {
					if (contentLower.includes(term)) {
						termMatches++;
					}
				}
				if (queryTerms.length > 0) {
					const termDensity = termMatches / queryTerms.length;
					finalScore *= 1 + termDensity * 0.5; // Up to 50% boost
				}

				// Slight penalty for very long content (less focused)
				const lengthPenalty = Math.max(0.7, 1 - item.content.length / 10000);
				finalScore *= lengthPenalty;

				// Boost symbols over chunks over files
				if (item.granularity === "symbol") {
					finalScore *= 1.1;
				} else if (item.granularity === "file") {
					finalScore *= 0.9;
				}

				return {
					id: item.id,
					content: item.content,
					file_path: item.file_path,
					finalScore,
					granularity: item.granularity,
				};
			});

			// Sort by final score
			return results.sort((a, b) => b.finalScore - a.finalScore);
		},
	};
}

// ============================================================================
// BM25 Reranker Implementation
// ============================================================================

/**
 * Creates a BM25-based reranker for more accurate text matching
 */
export function createBM25Reranker(): Reranker {
	// BM25 parameters
	const k1 = 1.2;
	const b = 0.75;

	function tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 1);
	}

	function computeBM25(
		query: string[],
		document: string[],
		avgDocLength: number,
	): number {
		const docLength = document.length;
		const termFreq = new Map<string, number>();

		for (const term of document) {
			termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
		}

		let score = 0;
		for (const term of query) {
			const tf = termFreq.get(term) ?? 0;
			if (tf === 0) continue;

			// Simplified BM25 (without IDF since we don't have corpus stats)
			const numerator = tf * (k1 + 1);
			const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
			score += numerator / denominator;
		}

		return score;
	}

	return {
		rerank(items: RerankItem[], options: RerankOptions): RerankResult[] {
			const { limit = 50, query } = options;

			const queryTokens = tokenize(query);
			if (queryTokens.length === 0) {
				return items.slice(0, limit).map((item) => ({
					id: item.id,
					content: item.content,
					file_path: item.file_path,
					finalScore: item.initialScore,
					granularity: item.granularity,
				}));
			}

			// Compute average document length
			const avgDocLength =
				items.reduce((sum, item) => sum + tokenize(item.content).length, 0) /
				items.length;

			const results = items.slice(0, limit).map((item) => {
				const docTokens = tokenize(item.content);
				const bm25Score = computeBM25(queryTokens, docTokens, avgDocLength);

				// Combine initial score with BM25
				const finalScore = item.initialScore * 0.4 + bm25Score * 0.6;

				return {
					id: item.id,
					content: item.content,
					file_path: item.file_path,
					finalScore,
					granularity: item.granularity,
				};
			});

			return results.sort((a, b) => b.finalScore - a.finalScore);
		},
	};
}

// ============================================================================
// Composite Reranker
// ============================================================================

/**
 * Creates a composite reranker that combines multiple strategies
 */
export function createCompositeReranker(
	rerankers: Reranker[],
	weights?: number[],
): Reranker {
	const normalizedWeights =
		weights ??
		rerankers.map(() => 1 / rerankers.length);

	return {
		rerank(items: RerankItem[], options: RerankOptions): RerankResult[] {
			// Get results from each reranker
			const allResults = rerankers.map((r) => r.rerank(items, options));

			// Combine scores
			const combinedScores = new Map<string, { item: RerankResult; score: number }>();

			for (let i = 0; i < allResults.length; i++) {
				const results = allResults[i];
				const weight = normalizedWeights[i];

				for (const result of results) {
					const existing = combinedScores.get(result.id);
					if (existing) {
						existing.score += result.finalScore * weight;
					} else {
						combinedScores.set(result.id, {
							item: result,
							score: result.finalScore * weight,
						});
					}
				}
			}

			// Sort by combined score
			return Array.from(combinedScores.values())
				.sort((a, b) => b.score - a.score)
				.map(({ item, score }) => ({ ...item, finalScore: score }));
		},
	};
}
