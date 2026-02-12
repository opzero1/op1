/**
 * Vector Search - Semantic similarity search
 *
 * Provides semantic similarity search using either sqlite-vec (if available)
 * or pure JavaScript cosine similarity as fallback.
 */

import type { Database } from "bun:sqlite";
import { globToLike, LIKE_ESCAPE_CLAUSE, matchesPathFilters } from "./path-filter";

// ============================================================================
// Types
// ============================================================================

export interface VectorSearchMatch {
	symbolId: string;
	/** Distance (lower is more similar) */
	distance: number;
	/** Normalized similarity score 0-1 (higher is more similar) */
	similarity: number;
}

export interface VectorSearchOptions {
	/** Maximum results to return (default: 20) */
	limit?: number;
	/** Filter results to specific branch */
	branch?: string;
	/** Filter results to files under this path prefix (e.g. "packages/core/") */
	pathPrefix?: string;
	/** Filter results to files matching these glob patterns (e.g. ["*.ts", "src/**"]) */
	filePatterns?: string[];
}

export interface VectorSearcher {
	search(embedding: number[], options?: VectorSearchOptions): VectorSearchMatch[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 20;

/**
 * Minimum similarity threshold for vector results.
 *
 * Code embeddings have lower similarity ranges than natural-language embeddings.
 * Relevant code results typically score 0.3–0.5 cosine similarity. A threshold
 * of 0.25 filters garbage while keeping useful results.
 */
export const MIN_SIMILARITY = 0.25;

// ============================================================================
// Vector Math Utilities (for pure JS fallback)
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) return 0;

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

function deserializeEmbedding(base64: string): number[] {
	const bytes = Buffer.from(base64, "base64");
	const float32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
	return Array.from(float32);
}

// ============================================================================
// Implementation
// ============================================================================

export function createVectorSearcher(db: Database): VectorSearcher {
	// Check which vector table exists
	let useJsVectors = false;
	let useSqliteVec = false;

	try {
		const jsCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='js_vectors'").get();
		useJsVectors = !!jsCheck;
	} catch {
		// Table doesn't exist
	}

	try {
		const vecCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_symbols'").get();
		useSqliteVec = !!vecCheck;
	} catch {
		// Table doesn't exist
	}

	return {
		search(embedding: number[], options?: VectorSearchOptions): VectorSearchMatch[] {
			const limit = options?.limit ?? DEFAULT_LIMIT;
			const branch = options?.branch;
			const pathPrefix = options?.pathPrefix;
			const filePatterns = options?.filePatterns;

			// Guard: empty embedding returns empty results
			if (embedding.length === 0) return [];

			// Try sqlite-vec first
			if (useSqliteVec) {
				try {
					return searchWithSqliteVec(db, embedding, limit, branch, pathPrefix, filePatterns);
				} catch {
					// Fall through to JS search
				}
			}

			// Use pure JS vector search
			if (useJsVectors) {
				return searchWithPureJs(db, embedding, limit, branch, pathPrefix, filePatterns);
			}

			// No vector store available
			return [];
		},
	};
}

// ============================================================================
// sqlite-vec Search (if available)
// ============================================================================

function serializeEmbedding(embedding: number[]): Uint8Array {
	const buffer = new Float32Array(embedding);
	return new Uint8Array(buffer.buffer);
}

function searchWithSqliteVec(
	db: Database,
	embedding: number[],
	limit: number,
	branch?: string,
	pathPrefix?: string,
	filePatterns?: string[],
): VectorSearchMatch[] {
	const blob = serializeEmbedding(embedding);
	const needsJoin = !!(branch || pathPrefix || filePatterns?.length);
	// Over-fetch when path filters active since MATCH returns k rows before WHERE filters
	const fetchLimit = needsJoin ? limit * 3 : limit;

	let sql: string;
	const params: (Uint8Array | string | number)[] = [];

	if (needsJoin) {
		sql = `
			SELECT v.symbol_id, v.distance
			FROM vec_symbols v
			INNER JOIN symbols s ON s.id = v.symbol_id
			WHERE v.embedding MATCH ?
		`;
		params.push(blob);

		if (branch) {
			sql += ` AND s.branch = ?`;
			params.push(branch);
		}
		if (pathPrefix) {
			sql += ` AND s.file_path LIKE ? ${LIKE_ESCAPE_CLAUSE}`;
			const escapedPrefix = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
			params.push(`${escapedPrefix}%`);
		}
		if (filePatterns && filePatterns.length > 0) {
			const conditions = filePatterns.map(() => `s.file_path LIKE ? ${LIKE_ESCAPE_CLAUSE}`).join(" OR ");
			sql += ` AND (${conditions})`;
			for (const pattern of filePatterns) {
				params.push(globToLike(pattern));
			}
		}

		sql += ` ORDER BY v.distance LIMIT ?`;
		params.push(fetchLimit);
	} else {
		sql = `
			SELECT symbol_id, distance
			FROM vec_symbols
			WHERE embedding MATCH ?
			ORDER BY distance
			LIMIT ?
		`;
		params.push(blob, limit);
	}

	const stmt = db.prepare(sql);
	const rows = stmt.all(...params) as Array<{ symbol_id: string; distance: number }>;

	// Apply actual limit after filtering and drop low-similarity garbage
	return rows
		.slice(0, limit)
		.filter((row) => (1 - row.distance) >= MIN_SIMILARITY)
		.map((row) => ({
			symbolId: row.symbol_id,
			distance: row.distance,
			similarity: Math.max(0, 1 - row.distance),
		}));
}

// ============================================================================
// Pure JavaScript Search (fallback)
// ============================================================================

function searchWithPureJs(
	db: Database,
	queryEmbedding: number[],
	limit: number,
	branch?: string,
	pathPrefix?: string,
	filePatterns?: string[],
): VectorSearchMatch[] {
	// js_vectors contains embeddings for chunks and files, not symbols directly.
	// We need to:
	// 1. For chunk embeddings: map through chunks.parent_symbol_id to get symbols
	// 2. For file embeddings: map through file_path to get symbols
	// 3. For symbol embeddings (if any): use directly

	// Query all vectors with their granularity and linked data
	const query = `
		SELECT 
			jv.symbol_id as vector_id,
			jv.embedding,
			jv.granularity,
			c.parent_symbol_id as chunk_parent_symbol_id,
			c.file_path as chunk_file_path,
			c.content as chunk_content
		FROM js_vectors jv
		LEFT JOIN chunks c ON c.id = jv.symbol_id AND jv.granularity IN ('chunk', 'file')
		${branch ? "WHERE c.branch = ? OR jv.granularity NOT IN ('chunk', 'file')" : ""}
	`;

	const stmt = db.prepare(query);
	const rows = (branch ? stmt.all(branch) : stmt.all()) as Array<{
		vector_id: string;
		embedding: string;
		granularity: string;
		chunk_parent_symbol_id: string | null;
		chunk_file_path: string | null;
		chunk_content: string | null;
	}>;

	// Compute similarities and map to symbols
	const results: VectorSearchMatch[] = [];
	const seenSymbols = new Set<string>();
	const hasPathFilter = !!(pathPrefix || (filePatterns && filePatterns.length > 0));

	for (const row of rows) {
		try {
			// Skip chunks that don't match path filters early (before deserialization)
			if (hasPathFilter && row.granularity === "chunk" && row.chunk_file_path) {
				if (!matchesPathFilters(row.chunk_file_path, pathPrefix, filePatterns)) continue;
			}

			const storedEmbedding = deserializeEmbedding(row.embedding);
			const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

			// Skip results below minimum similarity threshold
			if (similarity < MIN_SIMILARITY) continue;

			const distance = 1 - similarity;

			let symbolId: string | null = null;

			if (row.granularity === "symbol") {
				// Direct symbol embedding — look up file_path for path filtering
				if (hasPathFilter) {
					const symRow = db.prepare("SELECT file_path FROM symbols WHERE id = ?").get(row.vector_id) as { file_path: string } | null;
					if (!matchesPathFilters(symRow?.file_path ?? null, pathPrefix, filePatterns)) continue;
				}
				symbolId = row.vector_id;
			} else if (row.granularity === "chunk" && row.chunk_parent_symbol_id) {
				// Chunk embedding - map to parent symbol
				symbolId = row.chunk_parent_symbol_id;
			} else if (row.granularity === "chunk" && row.chunk_file_path) {
				// Chunk without parent symbol - use file path to find related symbols
				// For now, return the chunk itself with file info for context
				symbolId = row.vector_id; // Will be resolved in hydration
			} else if (row.granularity === "file") {
				// File-level embedding — resolve to vector_id (chunk ID in chunks table)
				if (hasPathFilter && row.chunk_file_path) {
					if (!matchesPathFilters(row.chunk_file_path, pathPrefix, filePatterns)) continue;
				}
				symbolId = row.vector_id; // Will be resolved in hydration via chunkStore
			}

			if (symbolId && !seenSymbols.has(symbolId)) {
				seenSymbols.add(symbolId);
				results.push({
					symbolId,
					distance,
					similarity,
				});
			} else if (symbolId && seenSymbols.has(symbolId)) {
				// Update if this chunk has better similarity
				const existing = results.find((r) => r.symbolId === symbolId);
				if (existing && similarity > existing.similarity) {
					existing.similarity = similarity;
					existing.distance = distance;
				}
			}
		} catch {
			// Skip corrupted embeddings
		}
	}

	// Sort by similarity (descending) and return top K
	results.sort((a, b) => b.similarity - a.similarity);
	return results.slice(0, limit);
}
