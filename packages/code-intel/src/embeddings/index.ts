/**
 * Embeddings Module
 *
 * Code embedding generation using UniXcoder for semantic code search.
 */

// Core interface
export type { Embedder, ModelLoadProgress, ProgressCallback } from "./embedder";

// UniXcoder implementation
export {
	UniXcoderEmbedder,
	createUniXcoderEmbedder,
	isTransformersAvailable,
	type UniXcoderOptions,
} from "./unixcoder";

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
