/**
 * Batch Embedding Processor
 *
 * Worker pool pattern for efficient batch embedding generation.
 * Designed for high throughput during indexing with backpressure control.
 *
 * Features:
 * - Configurable batch size and concurrency
 * - Rate limiting to respect provider quotas
 * - Retry with exponential backoff
 * - Progress callbacks for UI updates
 * - Per-batch failure isolation
 */

import type { Embedder } from "./embedder";
import type { Granularity } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingItem {
	/** Unique identifier for this item (chunk ID, symbol ID, or file path) */
	id: string;
	/** Text content to embed */
	text: string;
	/** Granularity level */
	granularity: Granularity;
}

export interface EmbeddingResult {
	id: string;
	embedding: number[];
	granularity: Granularity;
}

export interface BatchProcessorConfig {
	/** Maximum items per batch (default: 32) */
	batchSize?: number;
	/** Maximum concurrent batches (default: 2) */
	concurrency?: number;
	/** Retry attempts for failed batches (default: 3) */
	maxRetries?: number;
	/** Base delay for exponential backoff in ms (default: 1000) */
	retryDelayMs?: number;
	/** Rate limit: max batches per second (default: 10) */
	maxBatchesPerSecond?: number;
}

export interface BatchProgress {
	/** Total items to process */
	total: number;
	/** Items processed so far */
	processed: number;
	/** Items that failed */
	failed: number;
	/** Current status */
	status: "idle" | "processing" | "complete" | "error";
	/** Error message if status is "error" */
	error?: string;
}

export interface BatchProcessor {
	/** Process items and return embeddings */
	process(items: EmbeddingItem[]): Promise<EmbeddingResult[]>;

	/** Process items with progress callback */
	processWithProgress(
		items: EmbeddingItem[],
		onProgress: (progress: BatchProgress) => void,
	): Promise<EmbeddingResult[]>;

	/** Get current status */
	getStatus(): BatchProgress;

	/** Cancel ongoing processing */
	cancel(): void;
}

// ============================================================================
// Implementation
// ============================================================================

const DEFAULT_CONFIG: Required<BatchProcessorConfig> = {
	batchSize: 32,
	concurrency: 2,
	maxRetries: 3,
	retryDelayMs: 1000,
	maxBatchesPerSecond: 10,
};

/**
 * Create a batch embedding processor.
 *
 * @param embedder - The embedder to use for generating embeddings
 * @param config - Configuration options
 */
export function createBatchProcessor(
	embedder: Embedder,
	config: BatchProcessorConfig = {},
): BatchProcessor {
	const cfg = { ...DEFAULT_CONFIG, ...config };

	let progress: BatchProgress = {
		total: 0,
		processed: 0,
		failed: 0,
		status: "idle",
	};

	let cancelled = false;

	// Rate limiting state
	let lastBatchTime = 0;
	const minBatchInterval = 1000 / cfg.maxBatchesPerSecond;

	/**
	 * Wait for rate limit if needed
	 */
	async function waitForRateLimit(): Promise<void> {
		const now = Date.now();
		const elapsed = now - lastBatchTime;
		if (elapsed < minBatchInterval) {
			await sleep(minBatchInterval - elapsed);
		}
		lastBatchTime = Date.now();
	}

	/**
	 * Process a single batch with retries
	 */
	async function processBatch(
		batch: EmbeddingItem[],
	): Promise<EmbeddingResult[]> {
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
			if (cancelled) {
				throw new Error("Processing cancelled");
			}

			try {
				await waitForRateLimit();

				// Extract texts for embedding
				const texts = batch.map((item) => item.text);

				// Generate embeddings
				const embeddings = await embedder.embedBatch(texts);

				// Map back to results
				return batch.map((item, index) => ({
					id: item.id,
					embedding: embeddings[index],
					granularity: item.granularity,
				}));
			} catch (error) {
				lastError = error as Error;

				// Don't retry on cancellation
				if (cancelled) {
					throw error;
				}

				// Exponential backoff
				const delay = cfg.retryDelayMs * Math.pow(2, attempt);
				await sleep(delay);
			}
		}

		// All retries exhausted
		throw lastError || new Error("Batch processing failed after retries");
	}

	/**
	 * Process batches with bounded concurrency
	 */
	async function processWithConcurrency(
		batches: EmbeddingItem[][],
		onProgress?: (progress: BatchProgress) => void,
	): Promise<EmbeddingResult[]> {
		const results: EmbeddingResult[] = [];
		const pending: Promise<void>[] = [];
		let batchIndex = 0;

		const processNextBatch = async (): Promise<void> => {
			while (batchIndex < batches.length && !cancelled) {
				const currentIndex = batchIndex++;
				const batch = batches[currentIndex];

				try {
					const batchResults = await processBatch(batch);
					results.push(...batchResults);
					progress.processed += batch.length;
				} catch {
					// Isolate batch failure - mark items as failed but continue
					progress.failed += batch.length;
				}

				onProgress?.(progress);
			}
		};

		// Start concurrent workers
		for (let i = 0; i < cfg.concurrency; i++) {
			pending.push(processNextBatch());
		}

		await Promise.all(pending);

		return results;
	}

	return {
		async process(items: EmbeddingItem[]): Promise<EmbeddingResult[]> {
			return this.processWithProgress(items, () => {});
		},

		async processWithProgress(
			items: EmbeddingItem[],
			onProgress: (progress: BatchProgress) => void,
		): Promise<EmbeddingResult[]> {
			if (items.length === 0) {
				return [];
			}

			// Reset state
			cancelled = false;
			progress = {
				total: items.length,
				processed: 0,
				failed: 0,
				status: "processing",
			};
			onProgress(progress);

			try {
				// Split into batches
				const batches: EmbeddingItem[][] = [];
				for (let i = 0; i < items.length; i += cfg.batchSize) {
					batches.push(items.slice(i, i + cfg.batchSize));
				}

				// Process with concurrency
				const results = await processWithConcurrency(batches, onProgress);

				progress.status = progress.failed > 0 ? "error" : "complete";
				if (progress.failed > 0) {
					progress.error = `${progress.failed} items failed to embed`;
				}
				onProgress(progress);

				return results;
			} catch (error) {
				progress.status = "error";
				progress.error =
					error instanceof Error ? error.message : String(error);
				onProgress(progress);
				throw error;
			}
		},

		getStatus(): BatchProgress {
			return { ...progress };
		},

		cancel(): void {
			cancelled = true;
		},
	};
}

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create embedding items from chunks for batch processing
 */
export function chunksToEmbeddingItems(
	chunks: Array<{
		id: string;
		content: string;
		chunk_type: string;
		parent_symbol_id?: string | null;
	}>,
): EmbeddingItem[] {
	return chunks.map((chunk) => ({
		id: chunk.id,
		text: chunk.content,
		granularity: chunk.chunk_type === "file" ? "file" : "chunk",
	}));
}

/**
 * Create embedding items from symbols for batch processing
 */
export function symbolsToEmbeddingItems(
	symbols: Array<{
		id: string;
		name: string;
		content: string;
	}>,
): EmbeddingItem[] {
	return symbols.map((symbol) => ({
		id: symbol.id,
		// Include symbol name as prefix for better semantic matching
		text: `${symbol.name}\n${symbol.content}`,
		granularity: "symbol" as Granularity,
	}));
}
