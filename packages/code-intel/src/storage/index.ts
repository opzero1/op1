/**
 * Storage Layer exports
 */

export { createSchemaManager, SCHEMA_VERSION, EMBEDDING_MODEL_ID, EMBEDDING_DIMENSIONS } from "./schema";
export type { SchemaManager } from "./schema";

export { createSymbolStore } from "./symbol-store";
export type { SymbolStore } from "./symbol-store";

export { createEdgeStore } from "./edge-store";
export type { EdgeStore } from "./edge-store";

export { createFileStore } from "./file-store";
export type { FileStore } from "./file-store";

export { createKeywordStore } from "./keyword-store";
export type { KeywordStore, KeywordSearchResult } from "./keyword-store";

export { createVectorStore } from "./vector-store";
export type { VectorStore, VectorSearchResult } from "./vector-store";

export { createPureVectorStore, createHybridVectorStore, createGranularVectorStore } from "./pure-vector-store";
export type { PureVectorStore, HybridVectorStore, GranularVectorStore } from "./pure-vector-store";

export { createRepoMapStore } from "./repo-map-store";
export type { RepoMapStore } from "./repo-map-store";

export { createChunkStore } from "./chunk-store";
export type { ChunkStore } from "./chunk-store";

export { createFileContentStore } from "./file-content-store";
export type { FileContentStore } from "./file-content-store";

export { createContentFTSStore } from "./content-fts-store";
export type { ContentFTSStore, FTSEntry, FTSSearchResult, FTSSearchOptions } from "./content-fts-store";

