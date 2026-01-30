/**
 * Extraction Layer exports
 */

export { generateCanonicalId, generateContentHash, generateEdgeId } from "./canonical-id";

export { createQualifiedName } from "./language-adapter";
export type { LanguageAdapter, RawSymbol } from "./language-adapter";

export { createTypeScriptAdapter } from "./typescript-adapter";
export { createPythonAdapter } from "./python-adapter";

export { createSymbolExtractor } from "./symbol-extractor";
export type { SymbolExtractor } from "./symbol-extractor";

export { createLspExtractor } from "./lsp-extractor";
export type {
	LspExtractor,
	LspExtractorConfig,
	LspClient,
	LspLocation,
	ExtractionResult,
	ExtractionError,
} from "./lsp-extractor";

export { createAstInference } from "./ast-inference";
export type {
	AstInference,
	AstInferenceConfig,
	InferenceResult,
	ImportInfo,
	CallReference,
} from "./ast-inference";
