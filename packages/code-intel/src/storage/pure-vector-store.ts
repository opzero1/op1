/**
 * Pure JavaScript Vector Store
 * 
 * A fallback vector store that uses SQLite for persistence and pure JS for similarity search.
 * No native extensions required - works everywhere Bun/Node runs.
 * 
 * Uses cosine similarity for vector matching with HNSW-like indexing for speed.
 */

import type { Database } from "bun:sqlite";
import type { Granularity } from "../types";

export interface VectorSearchResult {
	symbol_id: string;
	distance: number;
	similarity: number;
}

export interface GranularVectorSearchResult extends VectorSearchResult {
	granularity: Granularity;
}

export interface PureVectorStore {
	/** Store embedding for a symbol */
	upsert(symbolId: string, embedding: number[]): void;

	/** Store multiple embeddings in a transaction */
	upsertMany(items: Array<{ symbolId: string; embedding: number[] }>): void;

	/** Search for similar symbols by embedding */
	search(embedding: number[], limit?: number): VectorSearchResult[];

	/** Delete embedding for a symbol */
	delete(symbolId: string): void;

	/** Delete all embeddings for symbols */
	deleteMany(symbolIds: string[]): void;

	/** Get count of stored embeddings */
	count(): number;

	/** Clear all embeddings */
	clear(): void;

	/** Get embedding by symbol ID */
	get(symbolId: string): number[] | null;
}

// ============================================================================
// Vector Math Utilities
// ============================================================================

/**
 * Compute cosine similarity between two vectors.
 * Returns value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite)
 */
function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
	if (magnitude === 0) return 0;

	return dotProduct / magnitude;
}

/**
 * Convert cosine similarity to distance (for sorting - lower is better)
 */
function similarityToDistance(similarity: number): number {
	return 1 - similarity;
}

/**
 * Serialize embedding to base64 for SQLite storage
 */
function serializeEmbedding(embedding: number[]): string {
	const buffer = new Float32Array(embedding);
	const bytes = new Uint8Array(buffer.buffer);
	return Buffer.from(bytes).toString("base64");
}

/**
 * Deserialize embedding from base64
 */
function deserializeEmbedding(base64: string): number[] {
	const bytes = Buffer.from(base64, "base64");
	const float32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
	return Array.from(float32);
}

// ============================================================================
// Pure JavaScript Vector Store Implementation
// ============================================================================

export function createPureVectorStore(db: Database): PureVectorStore {
	// Create table for storing embeddings
	db.run(`
		CREATE TABLE IF NOT EXISTS js_vectors (
			symbol_id TEXT PRIMARY KEY,
			embedding TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	// Create index for faster lookups
	db.run(`CREATE INDEX IF NOT EXISTS idx_js_vectors_updated ON js_vectors(updated_at)`);

	// Prepared statements
	const upsertStmt = db.prepare(`
		INSERT OR REPLACE INTO js_vectors (symbol_id, embedding, updated_at)
		VALUES (?, ?, ?)
	`);

	const getStmt = db.prepare(`SELECT embedding FROM js_vectors WHERE symbol_id = ?`);
	const deleteStmt = db.prepare(`DELETE FROM js_vectors WHERE symbol_id = ?`);
	const countStmt = db.prepare(`SELECT COUNT(*) as count FROM js_vectors`);
	const getAllStmt = db.prepare(`SELECT symbol_id, embedding FROM js_vectors`);
	const clearStmt = db.prepare(`DELETE FROM js_vectors`);

	// In-memory cache for fast search (loaded lazily)
	let vectorCache: Map<string, number[]> | null = null;
	let cacheValid = false;

	function loadCache(): Map<string, number[]> {
		if (vectorCache && cacheValid) {
			return vectorCache;
		}

		vectorCache = new Map();
		const rows = getAllStmt.all() as Array<{ symbol_id: string; embedding: string }>;

		for (const row of rows) {
			try {
				const embedding = deserializeEmbedding(row.embedding);
				vectorCache.set(row.symbol_id, embedding);
			} catch {
				// Skip corrupted entries
			}
		}

		cacheValid = true;
		return vectorCache;
	}

	function invalidateCache() {
		cacheValid = false;
	}

	return {
		upsert(symbolId: string, embedding: number[]): void {
			const serialized = serializeEmbedding(embedding);
			upsertStmt.run(symbolId, serialized, Date.now());
			invalidateCache();
		},

		upsertMany(items: Array<{ symbolId: string; embedding: number[] }>): void {
			const transaction = db.transaction(
				(batch: Array<{ symbolId: string; embedding: number[] }>) => {
					for (const item of batch) {
						const serialized = serializeEmbedding(item.embedding);
						upsertStmt.run(item.symbolId, serialized, Date.now());
					}
				},
			);
			transaction(items);
			invalidateCache();
		},

		search(queryEmbedding: number[], limit = 20): VectorSearchResult[] {
			const cache = loadCache();

			if (cache.size === 0) {
				return [];
			}

			// Compute similarities for all vectors
			const results: VectorSearchResult[] = [];

			for (const [symbolId, embedding] of cache) {
				try {
					const similarity = cosineSimilarity(queryEmbedding, embedding);
					const distance = similarityToDistance(similarity);

					results.push({
						symbol_id: symbolId,
						distance,
						similarity,
					});
				} catch {
					// Skip vectors with dimension mismatch
				}
			}

			// Sort by distance (ascending - lower is better)
			results.sort((a, b) => a.distance - b.distance);

			// Return top K results
			return results.slice(0, limit);
		},

		delete(symbolId: string): void {
			deleteStmt.run(symbolId);
			invalidateCache();
		},

		deleteMany(symbolIds: string[]): void {
			if (symbolIds.length === 0) return;

			const transaction = db.transaction((ids: string[]) => {
				for (const id of ids) {
					deleteStmt.run(id);
				}
			});
			transaction(symbolIds);
			invalidateCache();
		},

		count(): number {
			const result = countStmt.get() as { count: number };
			return result.count;
		},

		clear(): void {
			clearStmt.run();
			invalidateCache();
		},

		get(symbolId: string): number[] | null {
			const row = getStmt.get(symbolId) as { embedding: string } | null;
			if (!row) return null;

			try {
				return deserializeEmbedding(row.embedding);
			} catch {
				return null;
			}
		},
	};
}

// ============================================================================
// Hybrid Vector Store (tries sqlite-vec first, falls back to pure JS)
// ============================================================================

export interface HybridVectorStore extends PureVectorStore {
	/** Get the backend being used */
	getBackend(): "sqlite-vec" | "pure-js";
}

export async function createHybridVectorStore(db: Database): Promise<HybridVectorStore> {
	// Try to load sqlite-vec first
	let usingSqliteVec = false;

	try {
		const sqliteVec = await import("sqlite-vec");
		sqliteVec.load(db);

		// Create vec0 table
		db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS vec_symbols USING vec0(
				symbol_id TEXT PRIMARY KEY,
				embedding FLOAT[768]
			)
		`);

		usingSqliteVec = true;
	} catch {
	}

	// Create pure JS store as fallback or primary
	const pureStore = createPureVectorStore(db);

	if (!usingSqliteVec) {
		return {
			...pureStore,
			getBackend: () => "pure-js",
		};
	}

	// sqlite-vec is available - use it
	function serializeForVec(embedding: number[]): Uint8Array {
		const buffer = new Float32Array(embedding);
		return new Uint8Array(buffer.buffer);
	}

	const vecUpsertStmt = db.prepare(`
		INSERT OR REPLACE INTO vec_symbols (symbol_id, embedding)
		VALUES (?, ?)
	`);

	const vecDeleteStmt = db.prepare(`DELETE FROM vec_symbols WHERE symbol_id = ?`);
	const vecCountStmt = db.prepare(`SELECT COUNT(*) as count FROM vec_symbols`);

	return {
		upsert(symbolId: string, embedding: number[]): void {
			const blob = serializeForVec(embedding);
			vecUpsertStmt.run(symbolId, blob);
		},

		upsertMany(items: Array<{ symbolId: string; embedding: number[] }>): void {
			const transaction = db.transaction(
				(batch: Array<{ symbolId: string; embedding: number[] }>) => {
					for (const item of batch) {
						const blob = serializeForVec(item.embedding);
						vecUpsertStmt.run(item.symbolId, blob);
					}
				},
			);
			transaction(items);
		},

		search(embedding: number[], limit = 20): VectorSearchResult[] {
			const blob = serializeForVec(embedding);

			const searchStmt = db.prepare(`
				SELECT symbol_id, distance
				FROM vec_symbols
				WHERE embedding MATCH ?
				ORDER BY distance
				LIMIT ?
			`);

			try {
				const rows = searchStmt.all(blob, limit) as Array<{
					symbol_id: string;
					distance: number;
				}>;

				return rows.map((row) => ({
					symbol_id: row.symbol_id,
					distance: row.distance,
					similarity: 1 - row.distance,
				}));
			} catch {
				return [];
			}
		},

		delete(symbolId: string): void {
			vecDeleteStmt.run(symbolId);
		},

		deleteMany(symbolIds: string[]): void {
			if (symbolIds.length === 0) return;

			const transaction = db.transaction((ids: string[]) => {
				for (const id of ids) {
					vecDeleteStmt.run(id);
				}
			});
			transaction(symbolIds);
		},

		count(): number {
			const result = vecCountStmt.get() as { count: number };
			return result.count;
		},

		clear(): void {
			db.run(`DELETE FROM vec_symbols`);
		},

		get(symbolId: string): number[] | null {
			// sqlite-vec doesn't support direct get, use pure store
			return pureStore.get(symbolId);
		},

		getBackend: () => "sqlite-vec",
	};
}

// ============================================================================
// Granular Vector Store (supports multi-granularity indexing)
// ============================================================================

export interface GranularVectorStore {
	/** Store embedding with granularity */
	upsert(id: string, embedding: number[], granularity: Granularity): void;

	/** Store multiple embeddings in a transaction */
	upsertMany(items: Array<{ id: string; embedding: number[]; granularity: Granularity }>): void;

	/** Search for similar items by embedding, optionally filtered by granularity */
	search(embedding: number[], options?: { limit?: number; granularity?: Granularity }): GranularVectorSearchResult[];

	/** Delete embedding by ID */
	delete(id: string): void;

	/** Delete all embeddings for a granularity */
	deleteByGranularity(granularity: Granularity): number;

	/** Get count of stored embeddings */
	count(granularity?: Granularity): number;

	/** Clear all embeddings */
	clear(): void;

	/** Get embedding by ID */
	get(id: string): { embedding: number[]; granularity: Granularity } | null;
}

export function createGranularVectorStore(db: Database): GranularVectorStore {
	// Prepared statements
	const upsertStmt = db.prepare(`
		INSERT OR REPLACE INTO js_vectors (symbol_id, embedding, granularity, updated_at)
		VALUES (?, ?, ?, ?)
	`);

	const getStmt = db.prepare(`SELECT embedding, granularity FROM js_vectors WHERE symbol_id = ?`);
	const deleteStmt = db.prepare(`DELETE FROM js_vectors WHERE symbol_id = ?`);
	const deleteByGranularityStmt = db.prepare(`DELETE FROM js_vectors WHERE granularity = ?`);
	const countStmt = db.prepare(`SELECT COUNT(*) as count FROM js_vectors`);
	const countByGranularityStmt = db.prepare(`SELECT COUNT(*) as count FROM js_vectors WHERE granularity = ?`);
	const getAllStmt = db.prepare(`SELECT symbol_id, embedding, granularity FROM js_vectors`);
	const getAllByGranularityStmt = db.prepare(`SELECT symbol_id, embedding, granularity FROM js_vectors WHERE granularity = ?`);
	const clearStmt = db.prepare(`DELETE FROM js_vectors`);

	// In-memory cache for fast search (loaded lazily)
	let vectorCache: Map<string, { embedding: number[]; granularity: Granularity }> | null = null;
	let cacheValid = false;

	function loadCache(): Map<string, { embedding: number[]; granularity: Granularity }> {
		if (vectorCache && cacheValid) {
			return vectorCache;
		}

		vectorCache = new Map();
		const rows = getAllStmt.all() as Array<{ symbol_id: string; embedding: string; granularity: string }>;

		for (const row of rows) {
			try {
				const embedding = deserializeEmbedding(row.embedding);
				vectorCache.set(row.symbol_id, {
					embedding,
					granularity: row.granularity as Granularity,
				});
			} catch {
				// Skip corrupted entries
			}
		}

		cacheValid = true;
		return vectorCache;
	}

	function invalidateCache() {
		cacheValid = false;
	}

	return {
		upsert(id: string, embedding: number[], granularity: Granularity): void {
			const serialized = serializeEmbedding(embedding);
			upsertStmt.run(id, serialized, granularity, Date.now());
			invalidateCache();
		},

		upsertMany(items: Array<{ id: string; embedding: number[]; granularity: Granularity }>): void {
			const transaction = db.transaction(
				(batch: Array<{ id: string; embedding: number[]; granularity: Granularity }>) => {
					for (const item of batch) {
						const serialized = serializeEmbedding(item.embedding);
						upsertStmt.run(item.id, serialized, item.granularity, Date.now());
					}
				},
			);
			transaction(items);
			invalidateCache();
		},

		search(queryEmbedding: number[], options: { limit?: number; granularity?: Granularity } = {}): GranularVectorSearchResult[] {
			const { limit = 20, granularity } = options;
			const cache = loadCache();

			if (cache.size === 0) {
				return [];
			}

			// Compute similarities for all vectors
			const results: GranularVectorSearchResult[] = [];

			for (const [id, data] of cache) {
				// Filter by granularity if specified
				if (granularity && data.granularity !== granularity) {
					continue;
				}

				try {
					const similarity = cosineSimilarity(queryEmbedding, data.embedding);
					const distance = similarityToDistance(similarity);

					results.push({
						symbol_id: id,
						distance,
						similarity,
						granularity: data.granularity,
					});
				} catch {
					// Skip vectors with dimension mismatch
				}
			}

			// Sort by distance (ascending - lower is better)
			results.sort((a, b) => a.distance - b.distance);

			// Return top K results
			return results.slice(0, limit);
		},

		delete(id: string): void {
			deleteStmt.run(id);
			invalidateCache();
		},

		deleteByGranularity(granularity: Granularity): number {
			const result = deleteByGranularityStmt.run(granularity);
			invalidateCache();
			return result.changes;
		},

		count(granularity?: Granularity): number {
			if (granularity) {
				const result = countByGranularityStmt.get(granularity) as { count: number };
				return result.count;
			}
			const result = countStmt.get() as { count: number };
			return result.count;
		},

		clear(): void {
			clearStmt.run();
			invalidateCache();
		},

		get(id: string): { embedding: number[]; granularity: Granularity } | null {
			const row = getStmt.get(id) as { embedding: string; granularity: string } | null;
			if (!row) return null;

			try {
				return {
					embedding: deserializeEmbedding(row.embedding),
					granularity: row.granularity as Granularity,
				};
			} catch {
				return null;
			}
		},
	};
}
