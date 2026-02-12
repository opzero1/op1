/**
 * Voyage AI Embedder
 *
 * Code embeddings using Voyage AI's voyage-code-3 model.
 * Produces 1024-dim embeddings optimized for code retrieval.
 *
 * Features:
 * - Asymmetric embeddings (query vs document input types)
 * - Configurable output dimensions (256, 512, 1024, 2048)
 * - Up to 32K token context window
 * - Integrated LRU caching
 * - Batch processing (up to 128 items per request)
 */

import { VoyageAIClient, VoyageAIError, VoyageAITimeoutError } from "voyageai";
import type { VoyageAI } from "voyageai";
import type { Embedder, EmbedOptions } from "./embedder";
import { EmbeddingCache } from "./cache";

// ============================================================================
// Types
// ============================================================================

export interface VoyageEmbedderOptions {
	/**
	 * Voyage AI API key.
	 * Falls back to VOYAGE_AI_API_KEY environment variable.
	 */
	apiKey?: string;

	/**
	 * Model to use.
	 * @default "voyage-code-3"
	 */
	model?: string;

	/**
	 * Output embedding dimension.
	 * @default 1024
	 */
	dimensions?: number;

	/**
	 * Cache size for embeddings.
	 * @default 5000
	 */
	cacheSize?: number;

	/**
	 * Request timeout in seconds.
	 * @default 30
	 */
	timeoutSeconds?: number;
}

const DEFAULT_MODEL = "voyage-code-3";
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_TIMEOUT_SECONDS = 30;

// Voyage supports up to 128 items per request (we cap at 128 for safety)
const MAX_BATCH_SIZE = 128;

// ============================================================================
// Implementation
// ============================================================================

/**
 * Voyage AI embedder for code intelligence.
 *
 * Uses voyage-code-3 which is specifically optimized for code retrieval
 * and supports asymmetric embeddings (different modes for queries vs documents).
 */
export class VoyageEmbedder implements Embedder {
	readonly dimension: number;
	readonly modelId: string;

	private readonly client: VoyageAIClient;
	private readonly model: string;
	private readonly cache: EmbeddingCache;
	private readonly timeoutSeconds: number;

	constructor(options: VoyageEmbedderOptions = {}) {
		const apiKey = options.apiKey ?? process.env.VOYAGE_AI_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Voyage AI API key is required. Set VOYAGE_AI_API_KEY environment variable or pass apiKey option.",
			);
		}

		this.model = options.model ?? DEFAULT_MODEL;
		this.dimension = options.dimensions ?? DEFAULT_DIMENSIONS;
		this.modelId = `voyageai/${this.model}`;
		this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		this.cache = new EmbeddingCache({ maxSize: options.cacheSize ?? 5000 });

		this.client = new VoyageAIClient({ apiKey });
	}

	/**
	 * Map EmbedOptions inputType to Voyage API input_type.
	 */
	private mapInputType(
		options?: EmbedOptions,
	): VoyageAI.EmbedRequestInputType | undefined {
		if (!options?.inputType) return undefined;
		return options.inputType; // 'query' | 'document' maps directly
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embed(text: string, options?: EmbedOptions): Promise<number[]> {
		if (!text.trim()) {
			return new Array(this.dimension).fill(0);
		}

		// Check cache (include inputType in key for asymmetric embeddings)
		const cached = this.cache.get(text, options?.inputType);
		if (cached) {
			return cached;
		}

		const response = await this.client.embed(
			{
				model: this.model,
				input: text,
				inputType: this.mapInputType(options),
				outputDimension: this.dimension,
				truncation: true,
			},
			{ timeoutInSeconds: this.timeoutSeconds },
		);

		const embedding = response.data?.[0]?.embedding;
		if (!embedding || embedding.length === 0) {
			throw new Error(
				`Voyage AI returned empty embedding for model ${this.model}`,
			);
		}

		// Cache result
		this.cache.set(text, embedding, options?.inputType);

		return embedding;
	}

	/**
	 * Generate embeddings for multiple texts.
	 * Splits into sub-batches of MAX_BATCH_SIZE if needed.
	 */
	async embedBatch(
		texts: string[],
		options?: EmbedOptions,
	): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		// Separate empty, cached, and uncached
		const results: (number[] | null)[] = new Array(texts.length).fill(null);
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];

		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];

			if (!text.trim()) {
				results[i] = new Array(this.dimension).fill(0);
				continue;
			}

			const cached = this.cache.get(text, options?.inputType);
			if (cached) {
				results[i] = cached;
			} else {
				uncachedIndices.push(i);
				uncachedTexts.push(text);
			}
		}

		// All cached — fast return
		if (uncachedTexts.length === 0) {
			return results as number[][];
		}

		// Process uncached in sub-batches (Voyage max 128 per request)
		for (let i = 0; i < uncachedTexts.length; i += MAX_BATCH_SIZE) {
			const batchTexts = uncachedTexts.slice(i, i + MAX_BATCH_SIZE);
			const batchIndices = uncachedIndices.slice(i, i + MAX_BATCH_SIZE);

			const response = await this.client.embed(
				{
					model: this.model,
					input: batchTexts,
					inputType: this.mapInputType(options),
					outputDimension: this.dimension,
					truncation: true,
				},
				{ timeoutInSeconds: this.timeoutSeconds },
			);

			if (!response.data || response.data.length === 0) {
				throw new Error(
					`Voyage AI returned empty batch response for model ${this.model}`,
				);
			}

			// Map response back to results (response maintains input order)
			for (const item of response.data) {
				if (
					item.index === undefined ||
					!item.embedding ||
					item.embedding.length === 0
				) {
					continue;
				}

				const originalIndex = batchIndices[item.index];
				results[originalIndex] = item.embedding;

				// Cache each embedding
				this.cache.set(
					texts[originalIndex],
					item.embedding,
					options?.inputType,
				);
			}
		}

		// Verify all slots are filled
		for (let i = 0; i < results.length; i++) {
			if (results[i] === null) {
				throw new Error(
					`Voyage AI did not return embedding for item at index ${i}`,
				);
			}
		}

		return results as number[][];
	}

	/**
	 * Test connectivity with a small embedding request.
	 * Used by auto-selector to verify the API key works.
	 */
	async testConnectivity(): Promise<boolean> {
		try {
			await this.embed("test", { inputType: "query" });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get cache statistics.
	 */
	getCacheStats() {
		return this.cache.getStats();
	}

	/**
	 * Clear the embedding cache.
	 */
	clearCache(): void {
		this.cache.clear();
	}

	/**
	 * Get model information.
	 */
	getModelInfo() {
		return {
			modelId: this.modelId,
			model: this.model,
			dimension: this.dimension,
			provider: "voyageai" as const,
		};
	}
}

/**
 * Check if Voyage AI API key is available.
 */
export function isVoyageAvailable(): boolean {
	return !!process.env.VOYAGE_AI_API_KEY;
}

/**
 * Create a Voyage AI embedder with default options.
 */
export function createVoyageEmbedder(
	options?: VoyageEmbedderOptions,
): VoyageEmbedder {
	return new VoyageEmbedder(options);
}
