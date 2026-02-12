/**
 * Voyage AI Reranker
 *
 * Async reranker using Voyage AI's rerank-2.5 model for semantic relevance scoring.
 * Sends candidate items to the Voyage rerank API and maps relevance scores back
 * to the existing RerankResult structure.
 *
 * Features:
 * - Configurable model (default: rerank-2.5)
 * - Candidate limit to control API cost (default: 40)
 * - Availability check based on VOYAGE_AI_API_KEY
 * - Preserves id/content/file_path/granularity from input items
 */

import { VoyageAIClient } from "voyageai";
import type { AsyncReranker, RerankItem, RerankOptions, RerankResult } from "./reranker";

// ============================================================================
// Types
// ============================================================================

export interface VoyageRerankerOptions {
	/**
	 * Voyage AI API key.
	 * Falls back to VOYAGE_AI_API_KEY environment variable.
	 */
	apiKey?: string;

	/**
	 * Rerank model to use.
	 * @default "rerank-2.5"
	 */
	model?: string;

	/**
	 * Maximum candidates to send to the API per request.
	 * Higher values improve recall but cost more and add latency.
	 * @default 40
	 */
	maxCandidates?: number;

	/**
	 * Request timeout in seconds.
	 * @default 15
	 */
	timeoutSeconds?: number;
}

const DEFAULT_MODEL = "rerank-2.5";
const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_TIMEOUT_SECONDS = 15;

// ============================================================================
// Availability Check
// ============================================================================

/**
 * Check if Voyage AI reranker is available (API key present).
 */
export function isVoyageRerankerAvailable(apiKey?: string): boolean {
	return !!(apiKey ?? process.env.VOYAGE_AI_API_KEY);
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Creates an async reranker that uses Voyage AI's rerank API.
 *
 * Sends query + document pairs to the rerank endpoint and maps the returned
 * relevance_score to finalScore on each result. Items are capped at maxCandidates
 * before sending to the API; overflow items receive a finalScore of 0.
 */
export function createVoyageReranker(options: VoyageRerankerOptions = {}): AsyncReranker {
	const apiKey = options.apiKey ?? process.env.VOYAGE_AI_API_KEY;
	if (!apiKey) {
		throw new Error(
			"Voyage AI API key is required for reranking. Set VOYAGE_AI_API_KEY environment variable or pass apiKey option.",
		);
	}

	const model = options.model ?? DEFAULT_MODEL;
	const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
	const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const client = new VoyageAIClient({ apiKey });

	return {
		async rerank(items: RerankItem[], rerankOptions: RerankOptions): Promise<RerankResult[]> {
			if (items.length === 0) {
				return [];
			}

			const limit = rerankOptions.limit ?? 50;

			// Cap candidates sent to the API
			const candidateCount = Math.min(items.length, maxCandidates, limit);
			const candidates = items.slice(0, candidateCount);
			const overflow = items.slice(candidateCount);

			// Build documents for the rerank API
			const documents = candidates.map((item) => item.content);

			const response = await client.rerank(
				{
					model,
					query: rerankOptions.query,
					documents,
					topK: candidateCount,
					returnDocuments: false,
				},
				{ timeoutInSeconds: timeoutSeconds },
			);

			if (!response.data || response.data.length === 0) {
				throw new Error(
					`Voyage AI rerank returned empty response for model ${model}. Query: "${rerankOptions.query.slice(0, 80)}"`,
				);
			}

			// Map API results back to RerankResult, preserving all metadata from input items.
			// response.data contains { index, relevance_score } sorted by relevance.
			const results: RerankResult[] = [];

			for (const entry of response.data) {
				const sourceIndex = entry.index;
				if (sourceIndex === undefined || sourceIndex < 0 || sourceIndex >= candidates.length) {
					continue;
				}

				const sourceItem = candidates[sourceIndex];
				results.push({
					id: sourceItem.id,
					content: sourceItem.content,
					file_path: sourceItem.file_path,
					finalScore: entry.relevanceScore ?? 0,
					granularity: sourceItem.granularity,
				});
			}

			// Append overflow items with zero score (preserves them for downstream if needed)
			for (const item of overflow) {
				results.push({
					id: item.id,
					content: item.content,
					file_path: item.file_path,
					finalScore: 0,
					granularity: item.granularity,
				});
			}

			// Sort by finalScore descending, then trim to limit
			results.sort((a, b) => b.finalScore - a.finalScore);
			return results.slice(0, limit);
		},
	};
}
