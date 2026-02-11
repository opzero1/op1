/**
 * Vector Store - sqlite-vec operations for embedding search
 */

import type { Database } from "bun:sqlite";

export interface VectorSearchResult {
	symbol_id: string;
	distance: number;
}

export interface VectorStore {
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
}

export function createVectorStore(db: Database): VectorStore {
	// For sqlite-vec, we need to serialize the embedding as a blob
	function serializeEmbedding(embedding: number[]): Uint8Array {
		const buffer = new Float32Array(embedding);
		return new Uint8Array(buffer.buffer);
	}

	const upsertStmt = db.prepare(`
		INSERT OR REPLACE INTO vec_symbols (symbol_id, embedding)
		VALUES (?, ?)
	`);

	const deleteStmt = db.prepare("DELETE FROM vec_symbols WHERE symbol_id = ?");

	const countStmt = db.prepare(
		"SELECT COUNT(*) as count FROM vec_symbols",
	);

	return {
		upsert(symbolId: string, embedding: number[]): void {
			const blob = serializeEmbedding(embedding);
			upsertStmt.run(symbolId, blob);
		},

		upsertMany(items: Array<{ symbolId: string; embedding: number[] }>): void {
			const transaction = db.transaction(
				(batch: Array<{ symbolId: string; embedding: number[] }>) => {
					for (const item of batch) {
						const blob = serializeEmbedding(item.embedding);
						upsertStmt.run(item.symbolId, blob);
					}
				},
			);
			transaction(items);
		},

		search(embedding: number[], limit = 20): VectorSearchResult[] {
			const blob = serializeEmbedding(embedding);

			// sqlite-vec KNN search
			const searchStmt = db.prepare(`
				SELECT 
					symbol_id,
					distance
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
				}));
			} catch {
				return [];
			}
		},

		delete(symbolId: string): void {
			deleteStmt.run(symbolId);
		},

		deleteMany(symbolIds: string[]): void {
			if (symbolIds.length === 0) return;

			const transaction = db.transaction((ids: string[]) => {
				for (const id of ids) {
					deleteStmt.run(id);
				}
			});
			transaction(symbolIds);
		},

		count(): number {
			const result = countStmt.get() as { count: number };
			return result.count;
		},
	};
}
