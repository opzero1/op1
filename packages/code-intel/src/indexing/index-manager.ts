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
	EMBEDDING_MODEL_ID,
	SCHEMA_VERSION,
	type SchemaManager,
	type SymbolStore,
	type EdgeStore,
	type FileStore,
	type KeywordStore,
	type PureVectorStore,
	type RepoMapStore,
} from "../storage";
import {
	createSymbolExtractor,
	createAstInference,
	type SymbolExtractor,
	type AstInference,
} from "../extraction";
import { createFastSyncCache, type FastSyncCache } from "./fast-sync-cache";
import { createBranchManager, type BranchManager } from "./branch-manager";

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
	};

	/** Get current branch */
	getCurrentBranch(): string;

	/** Get underlying database (for SmartQuery) */
	getDatabase(): import("bun:sqlite").Database;
}

export interface IndexManagerConfig {
	workspaceRoot: string;
	config?: Partial<CodeIntelConfig>;
}

export async function createIndexManager(
	options: IndexManagerConfig,
): Promise<IndexManager> {
	const { workspaceRoot } = options;
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
	let syncCache: FastSyncCache | null = null;
	let branchManager: BranchManager | null = null;
	let symbolExtractor: SymbolExtractor | null = null;
	let astInference: AstInference | null = null;
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
		if (!symbolExtractor || !symbolStore || !fileStore || !keywordStore || !edgeStore) {
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

			// Delete old symbols and edges for this file
			symbolStore.deleteByFilePath(filePath, currentBranch);
			keywordStore.deleteByFilePath(filePath);
			
			// Clean up edges where these symbols were source or target
			if (oldSymbolIds.length > 0) {
				edgeStore.deleteStaleEdges(oldSymbolIds, currentBranch);
			}

			// Store symbols
			if (symbols.length > 0) {
				symbolStore.upsertMany(symbols);

				// Index in FTS
				keywordStore.indexMany(
					symbols.map((s) => ({
						symbolId: s.id,
						name: s.name,
						qualifiedName: s.qualified_name,
						content: s.content,
						filePath: s.file_path,
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

			// Update file record
			const fileRecord: FileRecord = {
				file_path: filePath,
				file_hash: "", // Will be updated by sync cache
				mtime: stat.mtimeMs,
				size: stat.size,
				last_indexed: Date.now(),
				language: symbolExtractor.getLanguage(filePath) ?? "unknown",
				branch: currentBranch,
				status: "indexed",
				symbol_count: symbols.length,
			};
			fileStore.upsert(fileRecord);

			// Update sync cache
			await syncCache?.updateEntry(filePath);

			return symbols;
		} catch (error) {
			console.error(`[code-intel] Error indexing ${filePath}:`, error);

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

			for (const filePath of files) {
				await indexFileInternal(filePath);
				indexed++;

				// Log progress every 100 files
				if (indexed % 100 === 0) {
					console.log(`[code-intel] Indexed ${indexed}/${files.length} files`);
				}
			}

			// Save sync cache
			await syncCache?.save();

			state = "ready";
			console.log(`[code-intel] Indexing complete: ${indexed} files`);
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

			return {
				state,
				total_files: totalFiles,
				indexed_files: indexedFiles,
				pending_files: pendingFiles,
				error_files: errorFiles,
				stale_files: staleFiles,
				total_symbols: totalSymbols,
				total_edges: totalEdges,
				last_full_index: null, // TODO: Track this
				current_branch: currentBranch,
				embedding_model_id: EMBEDDING_MODEL_ID,
				schema_version: SCHEMA_VERSION,
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

			// Process added files
			for (const filePath of changes.added) {
				await indexFileInternal(filePath);
			}

			// Process modified files
			for (const filePath of changes.modified) {
				await indexFileInternal(filePath);
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
