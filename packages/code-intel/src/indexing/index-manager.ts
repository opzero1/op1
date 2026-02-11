/**
 * Index Manager - Orchestrates the indexing pipeline
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import type {
	CodeIntelConfig,
	DEFAULT_CONFIG,
	FileRecord,
	IndexLifecycleState,
	IndexStatus,
	SymbolNode,
} from "../types";
import {
	createSchemaManager,
	createSymbolStore,
	createEdgeStore,
	createFileStore,
	createKeywordStore,
	createPureVectorStore,
	createRepoMapStore,
	createChunkStore,
	createFileContentStore,
	createContentFTSStore,
	createGranularVectorStore,
	EMBEDDING_MODEL_ID,
	SCHEMA_VERSION,
	type SchemaManager,
	type SymbolStore,
	type EdgeStore,
	type FileStore,
	type KeywordStore,
	type PureVectorStore,
	type RepoMapStore,
	type ChunkStore,
	type FileContentStore,
	type ContentFTSStore,
	type GranularVectorStore,
} from "../storage";
import {
	createSymbolExtractor,
	createAstInference,
	createChunker,
	type SymbolExtractor,
	type AstInference,
	type Chunker,
} from "../extraction";
import { createFastSyncCache, type FastSyncCache } from "./fast-sync-cache";
import { createBranchManager, type BranchManager } from "./branch-manager";
import {
	createBatchProcessor,
	chunksToEmbeddingItems,
	symbolsToEmbeddingItems,
	createAutoEmbedder,
	type BatchProcessor,
	type Embedder,
} from "../embeddings";
import { createFileWatcher, type FileWatcher } from "./file-watcher";

export interface IndexManager {
	/** Initialize the index manager */
	initialize(): Promise<void>;

	/** Get current index status */
	getStatus(): Promise<IndexStatus>;

	/** Index a single file */
	indexFile(filePath: string): Promise<SymbolNode[]>;

	/** Index all files in the workspace */
	indexAll(): Promise<void>;

	/** Refresh index (incremental update) */
	refresh(): Promise<{ added: number; modified: number; removed: number }>;

	/** Get symbols for a file */
	getSymbols(filePath: string): SymbolNode[];

	/** Get all symbols */
	getAllSymbols(limit?: number): SymbolNode[];

	/** Force rebuild the entire index */
	rebuild(): Promise<void>;

	/** Close and cleanup */
	close(): Promise<void>;

	/** Get stores for direct access */
	getStores(): {
		symbols: SymbolStore;
		edges: EdgeStore;
		files: FileStore;
		keywords: KeywordStore;
		vectors: PureVectorStore;
		repoMap: RepoMapStore;
		chunks: ChunkStore;
		fileContents: FileContentStore;
		contentFTS: ContentFTSStore;
		granularVectors: GranularVectorStore;
	};

	/** Get current branch */
	getCurrentBranch(): string;

	/** Get underlying database (for SmartQuery) */
	getDatabase(): import("bun:sqlite").Database;
}

export interface IndexManagerConfig {
	workspaceRoot: string;
	config?: Partial<CodeIntelConfig>;
	/** Optional progress callback for indexing operations */
	onProgress?: (current: number, total: number, phase: string) => void;
}

export async function createIndexManager(
	options: IndexManagerConfig,
): Promise<IndexManager> {
	const { workspaceRoot, onProgress } = options;
	const config: CodeIntelConfig = {
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
		...options.config,
	};

	let state: IndexLifecycleState = "uninitialized";
	let schemaManager: SchemaManager | null = null;
	let symbolStore: SymbolStore | null = null;
	let edgeStore: EdgeStore | null = null;
	let fileStore: FileStore | null = null;
	let keywordStore: KeywordStore | null = null;
	let vectorStore: PureVectorStore | null = null;
	let repoMapStore: RepoMapStore | null = null;
	let chunkStore: ChunkStore | null = null;
	let fileContentStore: FileContentStore | null = null;
	let contentFTSStore: ContentFTSStore | null = null;
	let granularVectorStore: GranularVectorStore | null = null;
	let syncCache: FastSyncCache | null = null;
	let branchManager: BranchManager | null = null;
	let symbolExtractor: SymbolExtractor | null = null;
	let astInference: AstInference | null = null;
	let chunker: Chunker | null = null;
	let embedder: Embedder | null = null;
	let batchProcessor: BatchProcessor | null = null;
	let fileWatcher: FileWatcher | null = null;
	let currentBranch = "main";

	function ensureInitialized(): void {
		if (state === "uninitialized") {
			throw new Error("IndexManager not initialized. Call initialize() first.");
		}
	}

	async function collectFiles(): Promise<string[]> {
		const files: string[] = [];
		const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mts,cts,py,pyw}");

		for await (const path of glob.scan({
			cwd: workspaceRoot,
			dot: false,
			absolute: false,
		})) {
			// Check ignore patterns
			let ignored = false;
			for (const pattern of config.ignorePatterns) {
				if (new Bun.Glob(pattern).match(path)) {
					ignored = true;
					break;
				}
			}
			if (!ignored) {
				files.push(path);
			}
		}

		return files;
	}

	async function indexFileInternal(filePath: string): Promise<SymbolNode[]> {
		if (!symbolExtractor || !symbolStore || !fileStore || !keywordStore || !edgeStore || !chunkStore || !contentFTSStore || !chunker) {
			return [];
		}

		const fullPath = join(workspaceRoot, filePath);

		try {
			// Read file content
			const file = Bun.file(fullPath);
			const content = await file.text();
			const stat = await file.stat();

			// Check if external
			const isExternal =
				filePath.includes("node_modules") ||
				filePath.includes("site-packages");

			// Extract symbols
			const symbols = await symbolExtractor.extractFromFile(
				filePath,
				content,
				currentBranch,
				isExternal,
			);

			// Get old symbol IDs for edge cleanup
			const oldSymbols = symbolStore.getByFilePath(filePath, currentBranch);
			const oldSymbolIds = oldSymbols.map((s) => s.id);

			// Delete old symbols, edges, and chunks for this file
			symbolStore.deleteByFilePath(filePath, currentBranch);
			keywordStore.deleteByFilePath(filePath);
			chunkStore.deleteByFilePath(filePath, currentBranch);
			contentFTSStore.deleteByFilePath(filePath);
			
			// Clean up edges where these symbols were source or target
			if (oldSymbolIds.length > 0) {
				edgeStore.deleteStaleEdges(oldSymbolIds, currentBranch);
			}

			// Determine language
			const language = symbolExtractor.getLanguage(filePath) ?? "unknown";

			// Store symbols
			if (symbols.length > 0) {
				symbolStore.upsertMany(symbols);

				// Index symbols in FTS (legacy)
				keywordStore.indexMany(
					symbols.map((s) => ({
						symbolId: s.id,
						name: s.name,
						qualifiedName: s.qualified_name,
						content: s.content,
						filePath: s.file_path,
					})),
				);

				// Index symbols in unified FTS
				contentFTSStore.indexMany(
					symbols.map((s) => ({
						content_id: s.id,
						content_type: "symbol" as const,
						file_path: s.file_path,
						name: s.name,
						content: s.content,
					})),
				);

				// Extract edges using AST inference (no external deps required)
				if (astInference && !isExternal) {
					// Build symbol map for edge resolution
					const allSymbols = new Map<string, SymbolNode>();
					for (const sym of symbolStore.getAll(currentBranch, 50000)) {
						allSymbols.set(sym.id, sym);
					}

					// Extract import edges from file content
					const importResult = astInference.inferImportEdges(
						filePath,
						content,
						allSymbols,
						currentBranch,
					);
					if (importResult.edges.length > 0) {
						edgeStore.upsertMany(importResult.edges);
					}

					// Extract call edges for each symbol
					for (const symbol of symbols) {
						const callResult = await astInference.inferEdgesForSymbol(
							symbol,
							allSymbols,
							currentBranch,
						);
						if (callResult.edges.length > 0) {
							edgeStore.upsertMany(callResult.edges);
						}
					}
				}
			}

			// Extract and store chunks (multi-granularity indexing)
			const chunks = chunker.chunk(filePath, content, symbols, language, currentBranch);
			if (chunks.length > 0) {
				chunkStore.upsertMany(chunks);

				// Index chunks in unified FTS
				contentFTSStore.indexMany(
					chunks.map((c) => ({
						content_id: c.id,
						content_type: c.chunk_type === "file" ? "file" as const : "chunk" as const,
						file_path: c.file_path,
						name: c.parent_symbol_id ? `chunk:${c.start_line}-${c.end_line}` : filePath,
						content: c.content,
					})),
				);

				// Generate embeddings for chunks (batch processing)
				if (batchProcessor && granularVectorStore) {
					const embeddingItems = chunksToEmbeddingItems(chunks);
					try {
						const embeddingResults = await batchProcessor.process(embeddingItems);
						// Store embeddings in granular vector store
						granularVectorStore.upsertMany(
							embeddingResults.map((r) => ({
								id: r.id,
								embedding: r.embedding,
								granularity: r.granularity,
							})),
						);
				} catch {
					// Continue without embeddings - they can be generated later
				}
				}
			}

			// Store file content for file-level search
			if (fileContentStore && content.length > 0) {
				const contentHash = new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 16);
				fileContentStore.upsert({
					file_path: filePath,
					branch: currentBranch,
					content: content.slice(0, 8000), // Truncate large files
					content_hash: contentHash,
					language,
					updated_at: Date.now(),
				});
			}

			// Update file record
			const fileRecord: FileRecord = {
				file_path: filePath,
				file_hash: "", // Will be updated by sync cache
				mtime: stat.mtimeMs,
				size: stat.size,
				last_indexed: Date.now(),
				language,
				branch: currentBranch,
				status: "indexed",
				symbol_count: symbols.length,
			};
			fileStore.upsert(fileRecord);

			// Update sync cache
			await syncCache?.updateEntry(filePath);

			return symbols;
		} catch (error) {
			// Mark file as error
			fileStore.updateStatus(
				filePath,
				currentBranch,
				"error",
				error instanceof Error ? error.message : String(error),
			);

			return [];
		}
	}

	async function indexAllInternal(): Promise<void> {
		state = "indexing";

		try {
			const files = await collectFiles();
			let indexed = 0;
			const total = files.length;

			onProgress?.(0, total, "indexing");

			for (const filePath of files) {
				await indexFileInternal(filePath);
				indexed++;
				onProgress?.(indexed, total, "indexing");
			}

			// Save sync cache
			await syncCache?.save();

			state = "ready";
		} catch (error) {
			state = "error";
			throw error;
		}
	}

	return {
		async initialize(): Promise<void> {
			if (state !== "uninitialized") return;

			state = "indexing";

			try {
				// Ensure directory exists
				const dbDir = join(workspaceRoot, ".opencode", "code-intel");
				await mkdir(dbDir, { recursive: true });

				// Initialize schema
				const dbPath = join(workspaceRoot, config.dbPath);
				schemaManager = await createSchemaManager(dbPath);
				await schemaManager.initialize();

				// Create stores
				symbolStore = createSymbolStore(schemaManager.db);
				edgeStore = createEdgeStore(schemaManager.db);
				fileStore = createFileStore(schemaManager.db);
				keywordStore = createKeywordStore(schemaManager.db);
				vectorStore = createPureVectorStore(schemaManager.db);
				repoMapStore = createRepoMapStore(schemaManager.db);
				chunkStore = createChunkStore(schemaManager.db);
				fileContentStore = createFileContentStore(schemaManager.db);
				contentFTSStore = createContentFTSStore(schemaManager.db);
				granularVectorStore = createGranularVectorStore(schemaManager.db);

				// Create sync cache
				syncCache = await createFastSyncCache({
					workspaceRoot,
					cachePath: config.cachePath,
				});

				// Create branch manager
				branchManager = createBranchManager(workspaceRoot);
				currentBranch = await branchManager.getCurrentBranch();

				// Watch for branch changes
				branchManager.onBranchChange((newBranch) => {
					currentBranch = newBranch;
				});

				// Create symbol extractor
				symbolExtractor = createSymbolExtractor();

				// Create AST inference for edge extraction
				astInference = createAstInference({ minConfidence: 0.3 });

				// Create chunker for multi-granularity indexing
				chunker = createChunker();

				// Create embedder and batch processor for vector generation
				embedder = await createAutoEmbedder();
				batchProcessor = createBatchProcessor(embedder, {
					batchSize: 32,
					concurrency: 2,
					maxRetries: 3,
				});

				// Create file watcher for real-time indexing
				fileWatcher = createFileWatcher({
					workspaceRoot,
					ignorePatterns: config.ignorePatterns,
					debounceMs: 300,
				});

				// Wire file watcher to incremental indexing
				fileWatcher.onChanges(async (batch) => {
					for (const change of batch.changes) {
						if (change.type === "unlink") {
							// Handle file deletion
							const oldSymbols = symbolStore!.getByFilePath(change.path, currentBranch);
							const oldSymbolIds = oldSymbols.map((s) => s.id);
							symbolStore!.deleteByFilePath(change.path, currentBranch);
							keywordStore!.deleteByFilePath(change.path);
							chunkStore!.deleteByFilePath(change.path, currentBranch);
							contentFTSStore!.deleteByFilePath(change.path);
							fileStore!.deleteByPath(change.path, currentBranch);
							if (oldSymbolIds.length > 0) {
								edgeStore!.deleteStaleEdges(oldSymbolIds, currentBranch);
							}
						} else {
							// Handle add/change - re-index the file
							await indexFileInternal(change.path);
						}
					}
				});

				state = "ready";
			} catch (error) {
				state = "error";
				throw error;
			}
		},

		async getStatus(): Promise<IndexStatus> {
			ensureInitialized();

			const totalFiles = fileStore!.count(currentBranch);
			const indexedFiles = fileStore!.countByStatus("indexed", currentBranch);
			const pendingFiles = fileStore!.countByStatus("pending", currentBranch);
			const errorFiles = fileStore!.countByStatus("error", currentBranch);
			const staleFiles = fileStore!.countByStatus("stale", currentBranch);
			const totalSymbols = symbolStore!.count(currentBranch);
			const totalEdges = edgeStore!.count(currentBranch);

			// Chunk counts
			const totalChunks = chunkStore!.count(currentBranch);
			const symbolChunks = chunkStore!.getByChunkType("symbol", currentBranch, 1).length > 0 
				? chunkStore!.count(currentBranch) : 0; // Simplified - count all for now
			
			// Embedding counts by granularity
			const symbolEmbeddings = granularVectorStore!.count("symbol");
			const chunkEmbeddings = granularVectorStore!.count("chunk");
			const fileEmbeddings = granularVectorStore!.count("file");
			const totalEmbeddings = granularVectorStore!.count();

			// Watcher status
			let watcherStatus: { active: boolean; pending_changes: number; last_update: number | null } | undefined;
			if (fileWatcher !== null) {
				watcherStatus = {
					active: fileWatcher.isActive(),
					pending_changes: fileWatcher.getPendingChanges().length,
					last_update: null,
				};
			}

			return {
				state,
				total_files: totalFiles,
				indexed_files: indexedFiles,
				pending_files: pendingFiles,
				error_files: errorFiles,
				stale_files: staleFiles,
				total_symbols: totalSymbols,
				total_edges: totalEdges,
				total_chunks: totalChunks,
				chunk_counts: {
					symbol: symbolChunks,
					block: 0, // TODO: count by type
					file: 0,
				},
				total_embeddings: totalEmbeddings,
				embedding_counts: {
					symbol: symbolEmbeddings,
					chunk: chunkEmbeddings,
					file: fileEmbeddings,
				},
				last_full_index: null, // TODO: Track this
				current_branch: currentBranch,
				embedding_model_id: EMBEDDING_MODEL_ID,
				schema_version: SCHEMA_VERSION,
				watcher: watcherStatus,
			};
		},

		async indexFile(filePath: string): Promise<SymbolNode[]> {
			ensureInitialized();
			return indexFileInternal(filePath);
		},

		async indexAll(): Promise<void> {
			ensureInitialized();
			await indexAllInternal();
		},

		async refresh(): Promise<{ added: number; modified: number; removed: number }> {
			ensureInitialized();

			const files = await collectFiles();
			const changes = await syncCache!.findChangedFiles(files);
			
			const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
			let processed = 0;

			onProgress?.(0, totalChanges, "refreshing");

			// Process added files
			for (const filePath of changes.added) {
				await indexFileInternal(filePath);
				processed++;
				onProgress?.(processed, totalChanges, "refreshing");
			}

			// Process modified files
			for (const filePath of changes.modified) {
				await indexFileInternal(filePath);
				processed++;
				onProgress?.(processed, totalChanges, "refreshing");
			}

			// Process removed files
			for (const filePath of changes.removed) {
				// Get symbol IDs before deleting for edge cleanup
				const oldSymbols = symbolStore!.getByFilePath(filePath, currentBranch);
				const oldSymbolIds = oldSymbols.map((s) => s.id);
				
				symbolStore!.deleteByFilePath(filePath, currentBranch);
				keywordStore!.deleteByFilePath(filePath);
				fileStore!.deleteByPath(filePath, currentBranch);
				syncCache!.clearFile(filePath);
				
				// Clean up edges where these symbols were source or target
				if (oldSymbolIds.length > 0) {
					edgeStore!.deleteStaleEdges(oldSymbolIds, currentBranch);
				}
			}

			// Save cache
			await syncCache!.save();

			return {
				added: changes.added.length,
				modified: changes.modified.length,
				removed: changes.removed.length,
			};
		},

		getSymbols(filePath: string): SymbolNode[] {
			ensureInitialized();
			return symbolStore!.getByFilePath(filePath, currentBranch);
		},

		getAllSymbols(limit = 1000): SymbolNode[] {
			ensureInitialized();
			return symbolStore!.getAll(currentBranch, limit);
		},

		async rebuild(): Promise<void> {
			ensureInitialized();

			// Clear all data for current branch
			symbolStore!.deleteByBranch(currentBranch);
			edgeStore!.deleteByBranch(currentBranch);
			fileStore!.deleteByBranch(currentBranch);
			repoMapStore!.deleteByBranch(currentBranch);
			syncCache!.clear();

			// Re-index everything
			await indexAllInternal();
		},

		async close(): Promise<void> {
			await syncCache?.save();
			schemaManager?.close();
			state = "uninitialized";
		},

		getStores() {
			ensureInitialized();
			return {
				symbols: symbolStore!,
				edges: edgeStore!,
				files: fileStore!,
				keywords: keywordStore!,
				vectors: vectorStore!,
				repoMap: repoMapStore!,
				chunks: chunkStore!,
				fileContents: fileContentStore!,
				contentFTS: contentFTSStore!,
				granularVectors: granularVectorStore!,
			};
		},

		getCurrentBranch(): string {
			return currentBranch;
		},

		getDatabase() {
			ensureInitialized();
			return schemaManager!.db;
		},
	};
}
