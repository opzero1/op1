/**
 * Query module exports
 */

export {
	type BranchDiffer,
	type BranchDiffOptions,
	type BranchDiffResult,
	createBranchDiffer,
	type DiffStatus,
	type EdgeDiff,
	type SymbolDiff,
} from "./branch-diff";
export {
	type ContextCache,
	type ContextCacheConfig,
	type ContextCacheStats,
	createContextCache,
	createEmbeddingCache,
	type EmbeddingCache,
	generateCacheKey,
} from "./context-cache";
export {
	createGraphExpander,
	type GraphExpander,
	type GraphExpansionOptions,
	type GraphExpansionResult,
	type GraphNode,
} from "./graph-expander";
export {
	createLLMHyDEGenerator,
	createTemplateHyDEGenerator,
	type HyDEGenerator,
	type HyDEOptions,
	type LLMProvider,
} from "./hyde";
export {
	createImpactAnalyzer,
	type ImpactAnalysisOptions,
	type ImpactAnalyzer,
} from "./impact-analysis";
export {
	createEnhancedMultiGranularSearch,
	createMultiGranularSearch,
	type EnhancedMultiGranularSearch,
	type EnhancedMultiGranularSearchDeps,
	type EnhancedSearchOptions,
	type EnhancedSearchResult,
	type MultiGranularResult,
	type MultiGranularSearch,
	type MultiGranularSearchDeps,
	type MultiGranularSearchOptions,
} from "./multi-granular-search";
export {
	createHyDERewriter,
	createQueryRewriter,
	type HyDERewriter,
	type QueryRewriter,
	type QueryRewriterConfig,
	type RewrittenQuery,
} from "./query-rewriter";
export {
	type AsyncReranker,
	createBM25Reranker,
	createCompositeReranker,
	createSimpleReranker,
	type Reranker,
	type RerankItem,
	type RerankOptions,
	type RerankResult,
} from "./reranker";

export {
	createSmartQuery,
	type SmartQuery,
	type SmartQueryOptions,
} from "./smart-query";
export {
	createVoyageReranker,
	isVoyageRerankerAvailable,
	type VoyageRerankerOptions,
} from "./voyage-reranker";
