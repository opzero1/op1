/**
 * Core types for @op1/code-intel
 */

// ============================================================================
// Symbol Types
// ============================================================================

export type SymbolType =
	| "FUNCTION"
	| "CLASS"
	| "METHOD"
	| "INTERFACE"
	| "MODULE"
	| "ENUM"
	| "VARIABLE"
	| "TYPE_ALIAS"
	| "PROPERTY";

export interface SymbolNode {
	/** Canonical ID: hash(qualified_name + signature + language) */
	id: string;
	/** Simple name: "calculateTax" */
	name: string;
	/** Qualified name: "src/utils/tax.calculateTax" */
	qualified_name: string;
	/** Symbol type */
	type: SymbolType;
	/** Language identifier */
	language: "typescript" | "python";
	/** File path relative to workspace */
	file_path: string;
	/** Start line (1-indexed) */
	start_line: number;
	/** End line (1-indexed) */
	end_line: number;
	/** Full source text (empty for external) */
	content: string;
	/** Type signature: "function(a: number, b: number): number" */
	signature?: string;
	/** Extracted documentation */
	docstring?: string;
	/** Content hash for change detection */
	content_hash: string;
	/** true for node_modules/site-packages */
	is_external: boolean;
	/** Git branch name */
	branch: string;
	/** 768-dim UniXcoder vector (null for external) */
	embedding?: number[];
	/** Model used for embedding */
	embedding_model_id?: string;
	/** Last update timestamp */
	updated_at: number;
	/** Monotonic revision for change tracking */
	revision_id: number;
}

// ============================================================================
// Edge Types
// ============================================================================

export type EdgeType = "CALLS" | "INHERITS" | "IMPLEMENTS" | "IMPORTS" | "USES";

export type EdgeOrigin = "lsp" | "scip" | "ast-inference";

export interface SymbolEdge {
	id: string;
	/** UUID of source symbol */
	source_id: string;
	/** UUID of target symbol */
	target_id: string;
	/** Relationship type */
	type: EdgeType;
	/** Confidence 0-1, from extraction method */
	confidence: number;
	/** How this edge was discovered */
	origin: EdgeOrigin;
	/** Git branch name */
	branch: string;
	/** [start_line, end_line] for precise linking */
	source_range?: [number, number];
	target_range?: [number, number];
	/** Last update timestamp */
	updated_at: number;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

// ============================================================================
// Chunk Types (Multi-Granularity Indexing)
// ============================================================================

export type ChunkType = "symbol" | "block" | "file";

export type Granularity = "symbol" | "chunk" | "file";

export interface ChunkNode {
	/** Canonical ID: hash(file_path + start_line + end_line + content_hash) */
	id: string;
	/** File path relative to workspace */
	file_path: string;
	/** Start line (1-indexed) */
	start_line: number;
	/** End line (1-indexed) */
	end_line: number;
	/** Chunk content */
	content: string;
	/** How this chunk was created */
	chunk_type: ChunkType;
	/** Parent symbol ID if chunk is symbol-aligned */
	parent_symbol_id?: string;
	/** Language identifier */
	language: "typescript" | "python" | "unknown";
	/** Content hash for change detection */
	content_hash: string;
	/** Git branch name */
	branch: string;
	/** Last update timestamp */
	updated_at: number;
}

export interface FileContent {
	/** File path (primary key with branch) */
	file_path: string;
	/** Git branch name */
	branch: string;
	/** Full file content (truncated for large files) */
	content: string;
	/** Content hash for change detection */
	content_hash: string;
	/** Language identifier */
	language: "typescript" | "python" | "unknown";
	/** Last update timestamp */
	updated_at: number;
}

// ============================================================================
// File Types
// ============================================================================

export type FileStatus =
	| "pending"
	| "indexing"
	| "indexed"
	| "error"
	| "stale";

export interface FileRecord {
	/** Primary key - relative file path */
	file_path: string;
	/** SHA256 content hash */
	file_hash: string;
	/** File modification time (fast check) */
	mtime: number;
	/** File size in bytes (fast check) */
	size: number;
	/** Timestamp of last indexing */
	last_indexed: number;
	/** Language identifier */
	language: "typescript" | "python" | "unknown";
	/** Git branch */
	branch: string;
	/** Indexing status */
	status: FileStatus;
	/** Number of symbols in file */
	symbol_count: number;
	/** PageRank score for repo map */
	importance_rank?: number;
	/** Error message if status === 'error' */
	error_message?: string;
}

// ============================================================================
// Repo Map Types
// ============================================================================

export interface RepoMapEntry {
	file_path: string;
	/** PageRank score */
	importance_score: number;
	/** Number of files importing this */
	in_degree: number;
	/** Number of files this imports */
	out_degree: number;
	/** Compact list of key symbols */
	symbol_summary: string;
	branch: string;
}

// ============================================================================
// Index Lifecycle
// ============================================================================

export type IndexLifecycleState =
	| "uninitialized"
	| "indexing"
	| "ready"
	| "partial"
	| "error";

export interface IndexStatus {
	state: IndexLifecycleState;
	total_files: number;
	indexed_files: number;
	pending_files: number;
	error_files: number;
	stale_files: number;
	total_symbols: number;
	total_edges: number;
	/** Total chunks across all granularities */
	total_chunks: number;
	/** Chunks by type */
	chunk_counts: {
		symbol: number;
		block: number;
		file: number;
	};
	/** Total embeddings stored */
	total_embeddings: number;
	/** Embeddings by granularity */
	embedding_counts: {
		symbol: number;
		chunk: number;
		file: number;
	};
	last_full_index: number | null;
	current_branch: string;
	embedding_model_id: string;
	schema_version: number;
	/** File watcher status */
	watcher?: {
		active: boolean;
		pending_changes: number;
		last_update: number | null;
	};
	/** Context cache stats */
	cache?: {
		size: number;
		max_size: number;
		hit_rate: number;
	};
}

// ============================================================================
// Query Types
// ============================================================================

export type RerankMode = "none" | "heuristic" | "llm" | "hybrid";

export interface QueryOptions {
	/** Maximum tokens in response context */
	maxTokens?: number;
	/** Graph traversal depth (default: 2, max: 3) */
	graphDepth?: number;
	/** Max edges per node (default: 10) */
	maxFanOut?: number;
	/** Minimum edge confidence (default: 0.5) */
	confidenceThreshold?: number;
	/** Re-ranking mode */
	rerank?: RerankMode;
	/** Include repo map for orientation */
	includeRepoMap?: boolean;
	/** Filter by symbol types */
	symbolTypes?: SymbolType[];
	/** Search granularity */
	granularity?: Granularity | "auto";
	/** Filter by file patterns (glob-style, e.g. ["*.ts", "src/**"]) */
	filePatterns?: string[];
	/** Path prefix for scoping to a project subdirectory (e.g. "packages/core/") */
	pathPrefix?: string;
	/** Current branch (auto-detected if not set) */
	branch?: string;
}

export interface QueryResult {
	/** Matched symbols with context */
	symbols: SymbolNode[];
	/** Related edges */
	edges: SymbolEdge[];
	/** Formatted context string */
	context: string;
	/** Total tokens in context */
	tokenCount: number;
	/** Repo map if included */
	repoMap?: RepoMapEntry[];
	/** Query metadata */
	metadata: {
		queryTime: number;
		vectorHits: number;
		keywordHits: number;
		graphExpansions: number;
		confidence: "high" | "medium" | "low" | "degraded";
		/** Whether the result was served from the enhanced search cache */
		fromCache?: boolean;
		/** Effective search scope for observability */
		scope?: {
			branch: string;
			pathPrefix?: string;
			filePatterns?: string[];
		};
		/** Confidence diagnostics — multi-signal breakdown for tuning */
		confidenceDiagnostics?: ConfidenceDiagnostics;
		/** Candidate sizing used for this query */
		candidateLimit?: number;
	};
}

/** Multi-signal confidence breakdown for observability and tuning */
export interface ConfidenceDiagnostics {
	/** Do both vector and keyword channels agree on top results? */
	retrievalAgreement: number;
	/** How spread out are the RRF scores? Higher = more decisive ranking */
	scoreSpread: number;
	/** What fraction of results come from the same directory? Higher = more focused */
	scopeConcentration: number;
	/** How many unique files are represented in the results? */
	uniqueFiles: number;
	/** Total candidate count before filtering */
	totalCandidates: number;
	/** Tier explanation for debugging */
	tierReason: string;
}

// ============================================================================
// Impact Analysis Types
// ============================================================================

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ImpactAnalysis {
	/** The symbol being analyzed */
	symbol: SymbolNode;
	/** Risk level based on dependent count */
	risk: RiskLevel;
	/** Number of direct dependents */
	directDependents: number;
	/** Number of transitive dependents */
	transitiveDependents: number;
	/** Affected symbols with paths */
	affectedSymbols: Array<{
		symbol: SymbolNode;
		path: string[];
		depth: number;
	}>;
	/** Confidence indicator */
	confidence: "high" | "medium" | "degraded";
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface CodeIntelConfig {
	/** Database path relative to workspace */
	dbPath: string;
	/** Cache path for merkle hashes */
	cachePath: string;
	/** Embedding model ID */
	embeddingModel: string;
	/** Embedding dimensions */
	embeddingDimensions: number;
	/** Languages to index */
	languages: Array<"typescript" | "python">;
	/** File patterns to ignore */
	ignorePatterns: string[];
	/** Index external dependencies */
	indexExternalDeps: boolean;
	/** Default query options */
	defaultQueryOptions: QueryOptions;
}

export const DEFAULT_CONFIG: CodeIntelConfig = {
	dbPath: ".opencode/code-intel/index.db",
	cachePath: ".opencode/code-intel/cache.json",
	embeddingModel: "microsoft/unixcoder-base",
	embeddingDimensions: 768,
	languages: ["typescript", "python"],
	ignorePatterns: [
		"**/node_modules/**",
		"**/.git/**",
		"**/dist/**",
		"**/build/**",
		"**/*.min.js",
		"**/*.bundle.js",
	],
	indexExternalDeps: true,
	defaultQueryOptions: {
		maxTokens: 8000,
		graphDepth: 2,
		maxFanOut: 10,
		confidenceThreshold: 0.5,
		rerank: "hybrid",
		includeRepoMap: false,
	},
};
