/**
 * Storage Layer exports
 */

export type { ChunkStore } from "./chunk-store";
export { createChunkStore } from "./chunk-store";
export type {
	ContentFTSStore,
	FTSEntry,
	FTSSearchOptions,
	FTSSearchResult,
} from "./content-fts-store";
export { createContentFTSStore } from "./content-fts-store";
export type { EdgeStore } from "./edge-store";
export { createEdgeStore } from "./edge-store";
export type { FileContentStore } from "./file-content-store";
export { createFileContentStore } from "./file-content-store";
export type { FileStore } from "./file-store";
export { createFileStore } from "./file-store";
export type { KeywordSearchResult, KeywordStore } from "./keyword-store";
export { createKeywordStore } from "./keyword-store";
export type {
	GranularVectorStore,
	HybridVectorStore,
	PureVectorStore,
} from "./pure-vector-store";
export {
	createGranularVectorStore,
	createHybridVectorStore,
	createPureVectorStore,
} from "./pure-vector-store";
export type { RepoMapStore } from "./repo-map-store";
export { createRepoMapStore } from "./repo-map-store";
export type { SchemaManager } from "./schema";
export {
	createSchemaManager,
	DEFAULT_EMBEDDING_MODEL_ID,
	MAX_EMBEDDING_DIMENSIONS,
	SCHEMA_VERSION,
} from "./schema";
export type { SymbolStore } from "./symbol-store";
export { createSymbolStore } from "./symbol-store";
export type { VectorSearchResult, VectorStore } from "./vector-store";
export { createVectorStore } from "./vector-store";
