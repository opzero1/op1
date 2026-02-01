/**
 * Transformers.js Embedder
 *
 * Text embeddings using @huggingface/transformers.
 * Uses all-MiniLM-L6-v2 which produces 384-dim embeddings.
 *
 * Features:
 * - Lazy model loading (no startup cost)
 * - Singleton pattern for model instance
 * - Batch processing for efficiency
 * - Integrated LRU caching
 * - No native dependencies (works with Bun)
 */

import type { Embedder, ProgressCallback } from "./embedder";
import { EmbeddingCache } from "./cache";

// Singleton state for lazy loading
let extractorInstance: any = null;
let extractorPromise: Promise<any> | null = null;

export interface UniXcoderOptions {
	/**
	 * Model ID to use.
	 * @default "Xenova/unixcoder-base"
	 */
	model?: string;

	/**
	 * Use quantized model for faster inference.
	 * @default true
	 */
	quantized?: boolean;

	/**
	 * Cache size for embeddings.
	 * @default 5000
	 */
	cacheSize?: number;

	/**
	 * Progress callback for model download/loading.
	 */
	onProgress?: ProgressCallback;
}

// Xenova/unixcoder-base is now private/gated, using all-MiniLM-L6-v2 as fallback
const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const UNIXCODER_DIMENSION = 384;

/**
 * UniXcoder-based embedder for code intelligence.
 *
 * Uses microsoft/unixcoder-base (via Xenova conversion) which is specifically
 * trained on programming languages and produces semantically meaningful
 * embeddings for code search and similarity.
 */
export class UniXcoderEmbedder implements Embedder {
	readonly dimension = UNIXCODER_DIMENSION;
	readonly modelId: string;

	private readonly quantized: boolean;
	private readonly cache: EmbeddingCache;
	private readonly onProgress?: ProgressCallback;
	private extractor: any = null;

	constructor(options: UniXcoderOptions = {}) {
		this.modelId = options.model ?? DEFAULT_MODEL;
		this.quantized = options.quantized ?? true;
		this.cache = new EmbeddingCache({ maxSize: options.cacheSize ?? 5000 });
		this.onProgress = options.onProgress;
	}

	/**
	 * Get or initialize the feature extraction pipeline.
	 * Uses singleton pattern to share model across instances.
	 */
	private async getExtractor(): Promise<any> {
		// Fast path: instance already loaded
		if (this.extractor) {
			return this.extractor;
		}

		// Check singleton
		if (extractorInstance && extractorPromise === null) {
			this.extractor = extractorInstance;
			return this.extractor;
		}

		// Wait for in-progress load
		if (extractorPromise) {
			this.extractor = await extractorPromise;
			return this.extractor;
		}

		// Start loading
		extractorPromise = this.loadPipeline();
		this.extractor = await extractorPromise;
		extractorInstance = this.extractor;
		extractorPromise = null;

		return this.extractor;
	}

	private async loadPipeline(): Promise<any> {
		this.onProgress?.({ status: "loading", message: "Loading transformers..." });

		try {
			// Using @huggingface/transformers (with sharp stubbed out for Bun compatibility)
		const { pipeline } = await import("@huggingface/transformers");

			this.onProgress?.({
				status: "downloading",
				message: `Loading ${this.modelId}...`,
			});

			// Note: quantized and progress_callback are runtime options not in type defs
			const extractor = await pipeline("feature-extraction", this.modelId, {
				progress_callback: (data: any) => {
					if (data.status === "progress" && data.progress !== undefined) {
						this.onProgress?.({
							status: "downloading",
							progress: data.progress,
							file: data.file,
						});
					}
				},
				dtype: this.quantized ? "q8" : "fp32",
			} as any);

			this.onProgress?.({ status: "ready", message: "Model loaded" });

			return extractor;
		} catch (error) {
			const err = error as Error;

			this.onProgress?.({
				status: "error",
				message: err.message,
			});

			if (err.message?.includes("Cannot find package")) {
				throw new Error(
					"@huggingface/transformers is not installed. Run: bun add @huggingface/transformers",
				);
			}

			throw error;
		}
	}

	/**
	 * Generate embedding for a single text.
	 */
	async embed(text: string): Promise<number[]> {
		// Guard: empty text
		if (!text.trim()) {
			return new Array(this.dimension).fill(0);
		}

		// Check cache
		const cached = this.cache.get(text);
		if (cached) {
			return cached;
		}

		const extractor = await this.getExtractor();

		const output = await extractor(text, {
			pooling: "mean",
			normalize: true,
		});

		// Convert tensor to array
		const embedding = Array.from(output.data as Float32Array).slice(
			0,
			this.dimension,
		);

		// Cache result
		this.cache.set(text, embedding);

		return embedding;
	}

	/**
	 * Generate embeddings for multiple texts.
	 * Optimizes by batching uncached texts.
	 */
	async embedBatch(texts: string[]): Promise<number[][]> {
		// Guard: empty input
		if (texts.length === 0) {
			return [];
		}

		// Separate cached from uncached
		const results: (number[] | null)[] = new Array(texts.length).fill(null);
		const uncachedIndices: number[] = [];
		const uncachedTexts: string[] = [];

		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];

			// Handle empty texts
			if (!text.trim()) {
				results[i] = new Array(this.dimension).fill(0);
				continue;
			}

			const cached = this.cache.get(text);
			if (cached) {
				results[i] = cached;
			} else {
				uncachedIndices.push(i);
				uncachedTexts.push(text);
			}
		}

		// All cached - fast return
		if (uncachedTexts.length === 0) {
			return results as number[][];
		}

		const extractor = await this.getExtractor();

		// Process in batches to manage memory
		const BATCH_SIZE = 32;

		for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
			const batchTexts = uncachedTexts.slice(i, i + BATCH_SIZE);
			const batchIndices = uncachedIndices.slice(i, i + BATCH_SIZE);

			const output = await extractor(batchTexts, {
				pooling: "mean",
				normalize: true,
			});

			// Extract embeddings from tensor
			const data = output.data as Float32Array;
			const embeddingDim = output.dims[1];

			for (let j = 0; j < batchTexts.length; j++) {
				const start = j * embeddingDim;
				const end = start + this.dimension;
				const embedding = Array.from(data.slice(start, end));

				const originalIndex = batchIndices[j];
				results[originalIndex] = embedding;

				// Cache the embedding
				this.cache.set(texts[originalIndex], embedding);
			}
		}

		return results as number[][];
	}

	/**
	 * Check if model is loaded.
	 */
	isLoaded(): boolean {
		return this.extractor !== null;
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
			dimension: this.dimension,
			quantized: this.quantized,
			loaded: this.isLoaded(),
		};
	}
}

/**
 * Check if @huggingface/transformers is available.
 */
export async function isTransformersAvailable(): Promise<boolean> {
	try {
		await import("@huggingface/transformers");
		return true;
	} catch {
		return false;
	}
}

/**
 * Create a UniXcoder embedder with default options.
 */
export function createUniXcoderEmbedder(
	options?: UniXcoderOptions,
): UniXcoderEmbedder {
	return new UniXcoderEmbedder(options);
}
