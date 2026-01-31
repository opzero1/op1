/**
 * File Content Store - CRUD operations for file_contents table
 * Stores full file content for file-level search
 */

import type { Database } from "bun:sqlite";
import type { FileContent } from "../types";

export interface FileContentStore {
	upsert(fileContent: FileContent): void;
	upsertMany(fileContents: FileContent[]): void;
	getByFilePath(filePath: string, branch: string): FileContent | null;
	getByBranch(branch: string, limit?: number): FileContent[];
	deleteByFilePath(filePath: string, branch: string): boolean;
	deleteByBranch(branch: string): number;
	count(branch?: string): number;
	exists(filePath: string, branch: string): boolean;
}

export function createFileContentStore(db: Database): FileContentStore {
	// Prepared statements for performance
	const upsertStmt = db.prepare(`
		INSERT OR REPLACE INTO file_contents (
			file_path, branch, content, content_hash, language, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`);

	const getByFilePathStmt = db.prepare(
		"SELECT * FROM file_contents WHERE file_path = ? AND branch = ?",
	);

	const getByBranchStmt = db.prepare(
		"SELECT * FROM file_contents WHERE branch = ? LIMIT ?",
	);

	const deleteByFilePathStmt = db.prepare(
		"DELETE FROM file_contents WHERE file_path = ? AND branch = ?",
	);

	const deleteByBranchStmt = db.prepare(
		"DELETE FROM file_contents WHERE branch = ?",
	);

	const countStmt = db.prepare("SELECT COUNT(*) as count FROM file_contents");

	const countByBranchStmt = db.prepare(
		"SELECT COUNT(*) as count FROM file_contents WHERE branch = ?",
	);

	const existsStmt = db.prepare(
		"SELECT 1 FROM file_contents WHERE file_path = ? AND branch = ? LIMIT 1",
	);

	function rowToFileContent(row: Record<string, unknown>): FileContent {
		return {
			file_path: row.file_path as string,
			branch: row.branch as string,
			content: row.content as string,
			content_hash: row.content_hash as string,
			language: row.language as "typescript" | "python" | "unknown",
			updated_at: row.updated_at as number,
		};
	}

	return {
		upsert(fileContent: FileContent): void {
			upsertStmt.run(
				fileContent.file_path,
				fileContent.branch,
				fileContent.content,
				fileContent.content_hash,
				fileContent.language,
				fileContent.updated_at,
			);
		},

		upsertMany(fileContents: FileContent[]): void {
			const transaction = db.transaction((items: FileContent[]) => {
				for (const fileContent of items) {
					this.upsert(fileContent);
				}
			});
			transaction(fileContents);
		},

		getByFilePath(filePath: string, branch: string): FileContent | null {
			const row = getByFilePathStmt.get(filePath, branch) as Record<
				string,
				unknown
			> | null;
			return row ? rowToFileContent(row) : null;
		},

		getByBranch(branch: string, limit = 1000): FileContent[] {
			const rows = getByBranchStmt.all(branch, limit) as Record<
				string,
				unknown
			>[];
			return rows.map(rowToFileContent);
		},

		deleteByFilePath(filePath: string, branch: string): boolean {
			const result = deleteByFilePathStmt.run(filePath, branch);
			return result.changes > 0;
		},

		deleteByBranch(branch: string): number {
			const result = deleteByBranchStmt.run(branch);
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

		exists(filePath: string, branch: string): boolean {
			const result = existsStmt.get(filePath, branch);
			return result !== null;
		},
	};
}
