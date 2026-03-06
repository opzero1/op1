/**
 * RRF Fusion - Reciprocal Rank Fusion for hybrid search
 *
 * Merges results from multiple retrieval methods (vector + keyword)
 * using the RRF algorithm: score = 1 / (k + rank)
 */

// ============================================================================
// Types
// ============================================================================

export interface RankedItem {
	symbolId: string;
	/** Original rank in the source list (1-indexed) */
	rank: number;
	/** Source identifier for debugging */
	source: "vector" | "keyword";
}

export interface FusedResult {
	symbolId: string;
	/** Combined RRF score (higher is better) */
	rrfScore: number;
	/** Ranks from each source that contributed */
	sourceRanks: {
		vector?: number;
		keyword?: number;
	};
}

export interface RrfFusionOptions {
	/** RRF constant k (default: 60, standard in literature) */
	k?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_K = 60;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Fuse vector and keyword search results using Reciprocal Rank Fusion.
 *
 * RRF formula: score(d) = sum over all lists r: 1 / (k + rank_r(d))
 *
 * This algorithm is rank-based, not score-based, making it robust
 * to different scoring scales between retrieval methods.
 */
export function fuseWithRrf(
	vectorResults: Array<{ symbolId: string }>,
	keywordResults: Array<{ symbolId: string }>,
	options?: RrfFusionOptions,
): FusedResult[] {
	const k = options?.k ?? DEFAULT_K;

	// Guard: if both lists empty, return empty
	if (vectorResults.length === 0 && keywordResults.length === 0) {
		return [];
	}

	const vectorRanked = assignRanks(vectorResults, "vector");
	const keywordRanked = assignRanks(keywordResults, "keyword");

	const scoreMap = computeRrfScores(vectorRanked, keywordRanked, k);
	const fusedResults = buildFusedResults(scoreMap, vectorRanked, keywordRanked);

	return sortByRrfScoreDescending(fusedResults);
}

// ============================================================================
// Pure Functions
// ============================================================================

function assignRanks(
	results: Array<{ symbolId: string }>,
	source: "vector" | "keyword",
): RankedItem[] {
	return results.map((result, index) => ({
		symbolId: result.symbolId,
		rank: index + 1, // 1-indexed rank
		source,
	}));
}

function computeRrfScores(
	vectorRanked: RankedItem[],
	keywordRanked: RankedItem[],
	k: number,
): Map<string, number> {
	const scoreMap = new Map<string, number>();

	// Add vector contribution
	for (const item of vectorRanked) {
		const rrfContribution = 1 / (k + item.rank);
		const currentScore = scoreMap.get(item.symbolId) ?? 0;
		scoreMap.set(item.symbolId, currentScore + rrfContribution);
	}

	// Add keyword contribution
	for (const item of keywordRanked) {
		const rrfContribution = 1 / (k + item.rank);
		const currentScore = scoreMap.get(item.symbolId) ?? 0;
		scoreMap.set(item.symbolId, currentScore + rrfContribution);
	}

	return scoreMap;
}

function buildFusedResults(
	scoreMap: Map<string, number>,
	vectorRanked: RankedItem[],
	keywordRanked: RankedItem[],
): FusedResult[] {
	// Build lookup maps for source ranks
	const vectorRankLookup = new Map(
		vectorRanked.map((item) => [item.symbolId, item.rank]),
	);
	const keywordRankLookup = new Map(
		keywordRanked.map((item) => [item.symbolId, item.rank]),
	);

	const results: FusedResult[] = [];

	for (const [symbolId, rrfScore] of scoreMap) {
		results.push({
			symbolId,
			rrfScore,
			sourceRanks: {
				vector: vectorRankLookup.get(symbolId),
				keyword: keywordRankLookup.get(symbolId),
			},
		});
	}

	return results;
}

function sortByRrfScoreDescending(results: FusedResult[]): FusedResult[] {
	return [...results].sort((a, b) => b.rrfScore - a.rrfScore);
}

// ============================================================================
// Utility Exports
// ============================================================================

/**
 * Deduplicate fused results by symbol ID, keeping highest scoring entry.
 * (Already deduplicated by RRF, but useful if merging multiple RRF passes)
 */
export function deduplicateBySymbolId(results: FusedResult[]): FusedResult[] {
	const seen = new Map<string, FusedResult>();

	for (const result of results) {
		const existing = seen.get(result.symbolId);
		if (!existing || result.rrfScore > existing.rrfScore) {
			seen.set(result.symbolId, result);
		}
	}

	return Array.from(seen.values());
}
