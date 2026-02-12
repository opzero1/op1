/**
 * Query module exports
 */

export {
	createGraphExpander,
	type GraphExpander,
	type GraphExpansionOptions,
	type GraphExpansionResult,
	type GraphNode,
} from "./graph-expander";

export {
	createImpactAnalyzer,
	type ImpactAnalyzer,
	type ImpactAnalysisOptions,
} from "./impact-analysis";

export {
	createBranchDiffer,
	type BranchDiffer,
	type BranchDiffResult,
	type BranchDiffOptions,
	type SymbolDiff,
	type EdgeDiff,
	type DiffStatus,
} from "./branch-diff";

export {
	createMultiGranularSearch,
	createEnhancedMultiGranularSearch,
	type MultiGranularSearch,
	type MultiGranularSearchDeps,
	type MultiGranularSearchOptions,
	type MultiGranularResult,
	type EnhancedMultiGranularSearch,
	type EnhancedMultiGranularSearchDeps,
	type EnhancedSearchOptions,
	type EnhancedSearchResult,
} from "./multi-granular-search";

export {
	createQueryRewriter,
	createHyDERewriter,
	type QueryRewriter,
	type QueryRewriterConfig,
	type RewrittenQuery,
	type HyDERewriter,
} from "./query-rewriter";

export {
	createSimpleReranker,
	createBM25Reranker,
	createCompositeReranker,
	type Reranker,
	type AsyncReranker,
	type RerankItem,
	type RerankResult,
	type RerankOptions,
} from "./reranker";

export {
	createVoyageReranker,
	isVoyageRerankerAvailable,
	type VoyageRerankerOptions,
} from "./voyage-reranker";

export {
	createContextCache,
	createEmbeddingCache,
	generateCacheKey,
	type ContextCache,
	type ContextCacheConfig,
	type ContextCacheStats,
	type EmbeddingCache,
} from "./context-cache";

export {
	createSmartQuery,
	type SmartQuery,
	type SmartQueryOptions,
} from "./smart-query";

export {
	createTemplateHyDEGenerator,
	createLLMHyDEGenerator,
	type HyDEGenerator,
	type HyDEOptions,
	type LLMProvider,
} from "./hyde";
