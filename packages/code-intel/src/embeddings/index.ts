/**
 * Embeddings Module
 *
 * Code embedding generation for semantic code search.
 * Supports Voyage AI (voyage-code-3), UniXcoder, and hash-based fallback.
 */

// Core interface
export type { Embedder, EmbedOptions, ModelLoadProgress, ProgressCallback } from "./embedder";

// UniXcoder implementation
export {
	UniXcoderEmbedder,
	createUniXcoderEmbedder,
	isTransformersAvailable,
	type UniXcoderOptions,
} from "./unixcoder";

// Voyage AI embedder
export {
	VoyageEmbedder,
	createVoyageEmbedder,
	isVoyageAvailable,
	type VoyageEmbedderOptions,
} from "./voyage-embedder";

// Simple fallback embedder
export {
	SimpleEmbedder,
	createSimpleEmbedder,
	createAutoEmbedder,
} from "./simple-embedder";

// Cache utilities
export {
	EmbeddingCache,
	createEmbeddingCache,
	type EmbeddingCacheOptions,
	type CacheStats,
} from "./cache";

// Batch processing
export {
	createBatchProcessor,
	chunksToEmbeddingItems,
	symbolsToEmbeddingItems,
	type BatchProcessor,
	type BatchProcessorConfig,
	type BatchProgress,
	type EmbeddingItem,
	type EmbeddingResult,
} from "./batch-processor";
