/**
 * Chunk Store - CRUD operations for chunks table
 * Supports multi-granularity indexing with symbol-aligned and block chunks
 */

import type { Database } from "bun:sqlite";
import type { ChunkNode, ChunkType } from "../types";

export interface ChunkStore {
	upsert(chunk: ChunkNode): void;
	upsertMany(chunks: ChunkNode[]): void;
	getById(id: string): ChunkNode | null;
	getByFilePath(filePath: string, branch: string): ChunkNode[];
	getByParentSymbol(parentSymbolId: string, branch: string): ChunkNode[];
	getByChunkType(chunkType: ChunkType, branch: string, limit?: number): ChunkNode[];
	deleteById(id: string): boolean;
	deleteByFilePath(filePath: string, branch: string): number;
	deleteByBranch(branch: string): number;
	deleteByParentSymbol(parentSymbolId: string, branch: string): number;
	count(branch?: string): number;
	countByFilePath(filePath: string, branch: string): number;
	getAll(branch: string, limit?: number): ChunkNode[];
}

export function createChunkStore(db: Database): ChunkStore {
	// Prepared statements for performance
	const upsertStmt = db.prepare(`
		INSERT OR REPLACE INTO chunks (
			id, file_path, start_line, end_line, content,
			chunk_type, parent_symbol_id, language, content_hash,
			branch, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	const getByIdStmt = db.prepare("SELECT * FROM chunks WHERE id = ?");

	const getByFilePathStmt = db.prepare(
		"SELECT * FROM chunks WHERE file_path = ? AND branch = ? ORDER BY start_line",
	);

	const getByParentSymbolStmt = db.prepare(
		"SELECT * FROM chunks WHERE parent_symbol_id = ? AND branch = ? ORDER BY start_line",
	);

	const getByChunkTypeStmt = db.prepare(
		"SELECT * FROM chunks WHERE chunk_type = ? AND branch = ? LIMIT ?",
	);

	const deleteByIdStmt = db.prepare("DELETE FROM chunks WHERE id = ?");

	const deleteByFilePathStmt = db.prepare(
		"DELETE FROM chunks WHERE file_path = ? AND branch = ?",
	);

	const deleteByBranchStmt = db.prepare("DELETE FROM chunks WHERE branch = ?");

	const deleteByParentSymbolStmt = db.prepare(
		"DELETE FROM chunks WHERE parent_symbol_id = ? AND branch = ?",
	);

	const countStmt = db.prepare("SELECT COUNT(*) as count FROM chunks");

	const countByBranchStmt = db.prepare(
		"SELECT COUNT(*) as count FROM chunks WHERE branch = ?",
	);

	const countByFilePathStmt = db.prepare(
		"SELECT COUNT(*) as count FROM chunks WHERE file_path = ? AND branch = ?",
	);

	const getAllStmt = db.prepare(
		"SELECT * FROM chunks WHERE branch = ? LIMIT ?",
	);

	function rowToChunk(row: Record<string, unknown>): ChunkNode {
		return {
			id: row.id as string,
			file_path: row.file_path as string,
			start_line: row.start_line as number,
			end_line: row.end_line as number,
			content: row.content as string,
			chunk_type: row.chunk_type as ChunkType,
			parent_symbol_id: (row.parent_symbol_id as string) || undefined,
			language: row.language as "typescript" | "python" | "unknown",
			content_hash: row.content_hash as string,
			branch: row.branch as string,
			updated_at: row.updated_at as number,
		};
	}

	return {
		upsert(chunk: ChunkNode): void {
			upsertStmt.run(
				chunk.id,
				chunk.file_path,
				chunk.start_line,
				chunk.end_line,
				chunk.content,
				chunk.chunk_type,
				chunk.parent_symbol_id ?? null,
				chunk.language,
				chunk.content_hash,
				chunk.branch,
				chunk.updated_at,
			);
		},

		upsertMany(chunks: ChunkNode[]): void {
			const transaction = db.transaction((items: ChunkNode[]) => {
				for (const chunk of items) {
					this.upsert(chunk);
				}
			});
			transaction(chunks);
		},

		getById(id: string): ChunkNode | null {
			const row = getByIdStmt.get(id) as Record<string, unknown> | null;
			return row ? rowToChunk(row) : null;
		},

		getByFilePath(filePath: string, branch: string): ChunkNode[] {
			const rows = getByFilePathStmt.all(filePath, branch) as Record<
				string,
				unknown
			>[];
			return rows.map(rowToChunk);
		},

		getByParentSymbol(parentSymbolId: string, branch: string): ChunkNode[] {
			const rows = getByParentSymbolStmt.all(parentSymbolId, branch) as Record<
				string,
				unknown
			>[];
			return rows.map(rowToChunk);
		},

		getByChunkType(chunkType: ChunkType, branch: string, limit = 1000): ChunkNode[] {
			const rows = getByChunkTypeStmt.all(chunkType, branch, limit) as Record<
				string,
				unknown
			>[];
			return rows.map(rowToChunk);
		},

		deleteById(id: string): boolean {
			const result = deleteByIdStmt.run(id);
			return result.changes > 0;
		},

		deleteByFilePath(filePath: string, branch: string): number {
			const result = deleteByFilePathStmt.run(filePath, branch);
			return result.changes;
		},

		deleteByBranch(branch: string): number {
			const result = deleteByBranchStmt.run(branch);
			return result.changes;
		},

		deleteByParentSymbol(parentSymbolId: string, branch: string): number {
			const result = deleteByParentSymbolStmt.run(parentSymbolId, branch);
			return result.changes;
		},

		count(branch?: string): number {
			if (branch) {
				const result = countByBranchStmt.get(branch) as { count: number };
				return result.count;
			}
			const result = countStmt.get() as { count: number };
			return result.count;
		},

		countByFilePath(filePath: string, branch: string): number {
			const result = countByFilePathStmt.get(filePath, branch) as { count: number };
			return result.count;
		},

		getAll(branch: string, limit = 1000): ChunkNode[] {
			const rows = getAllStmt.all(branch, limit) as Record<string, unknown>[];
			return rows.map(rowToChunk);
		},
	};
}
