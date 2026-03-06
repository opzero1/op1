/**
 * Embeddings Module
 *
 * Code embedding generation for semantic code search.
 * Supports Voyage AI (voyage-code-3), UniXcoder, and hash-based fallback.
 */

// Batch processing
export {
	type BatchProcessor,
	type BatchProcessorConfig,
	type BatchProgress,
	chunksToEmbeddingItems,
	createBatchProcessor,
	type EmbeddingItem,
	type EmbeddingResult,
	symbolsToEmbeddingItems,
} from "./batch-processor";
// Cache utilities
export {
	type CacheStats,
	createEmbeddingCache,
	EmbeddingCache,
	type EmbeddingCacheOptions,
} from "./cache";
// Core interface
export type {
	Embedder,
	EmbedOptions,
	ModelLoadProgress,
	ProgressCallback,
} from "./embedder";

// Simple fallback embedder
export {
	createAutoEmbedder,
	createSimpleEmbedder,
	SimpleEmbedder,
} from "./simple-embedder";
// UniXcoder implementation
export {
	createUniXcoderEmbedder,
	isTransformersAvailable,
	UniXcoderEmbedder,
	type UniXcoderOptions,
} from "./unixcoder";
// Voyage AI embedder
export {
	createVoyageEmbedder,
	isVoyageAvailable,
	VoyageEmbedder,
	type VoyageEmbedderOptions,
} from "./voyage-embedder";
