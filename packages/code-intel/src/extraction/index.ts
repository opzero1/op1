/**
 * Extraction Layer exports
 */

export type {
	AstInference,
	AstInferenceConfig,
	CallReference,
	ImportInfo,
	InferenceResult,
} from "./ast-inference";
export { createAstInference } from "./ast-inference";
export {
	generateCanonicalId,
	generateContentHash,
	generateEdgeId,
} from "./canonical-id";
export type { Chunker, ChunkerConfig } from "./chunker";
export {
	createChunker,
	DEFAULT_CHUNKER_CONFIG,
	generateChunkId,
	generateContentHash as generateChunkContentHash,
} from "./chunker";
export type { LanguageAdapter, RawSymbol } from "./language-adapter";
export { createQualifiedName } from "./language-adapter";
export type {
	ExtractionError,
	ExtractionResult,
	LspClient,
	LspExtractor,
	LspExtractorConfig,
	LspLocation,
} from "./lsp-extractor";
export { createLspExtractor } from "./lsp-extractor";
export { createPythonAdapter } from "./python-adapter";
export type { SymbolExtractor } from "./symbol-extractor";
export { createSymbolExtractor } from "./symbol-extractor";
export { createTypeScriptAdapter } from "./typescript-adapter";
