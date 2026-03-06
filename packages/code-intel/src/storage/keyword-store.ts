/**
 * Keyword Store - FTS5 keyword search operations
 */

import type { Database } from "bun:sqlite";

export interface KeywordSearchResult {
	symbol_id: string;
	name: string;
	qualified_name: string;
	file_path: string;
	rank: number;
}

export interface KeywordStore {
	/** Index a symbol for keyword search */
	index(
		symbolId: string,
		name: string,
		qualifiedName: string,
		content: string,
		filePath: string,
	): void;

	/** Index multiple symbols in a transaction */
	indexMany(
		items: Array<{
			symbolId: string;
			name: string;
			qualifiedName: string;
			content: string;
			filePath: string;
		}>,
	): void;

	/** Search for symbols by keyword */
	search(query: string, limit?: number): KeywordSearchResult[];

	/** Delete symbol from FTS index */
	delete(symbolId: string): void;

	/** Delete all symbols for a file */
	deleteByFilePath(filePath: string): void;

	/** Rebuild the FTS index */
	rebuild(): void;
}

export function createKeywordStore(db: Database): KeywordStore {
	const indexStmt = db.prepare(`
		INSERT OR REPLACE INTO fts_symbols (symbol_id, name, qualified_name, content, file_path)
		VALUES (?, ?, ?, ?, ?)
	`);

	const deleteStmt = db.prepare("DELETE FROM fts_symbols WHERE symbol_id = ?");

	const deleteByFilePathStmt = db.prepare(
		"DELETE FROM fts_symbols WHERE file_path = ?",
	);

	return {
		index(
			symbolId: string,
			name: string,
			qualifiedName: string,
			content: string,
			filePath: string,
		): void {
			indexStmt.run(symbolId, name, qualifiedName, content, filePath);
		},

		indexMany(
			items: Array<{
				symbolId: string;
				name: string;
				qualifiedName: string;
				content: string;
				filePath: string;
			}>,
		): void {
			const transaction = db.transaction(
				(
					batch: Array<{
						symbolId: string;
						name: string;
						qualifiedName: string;
						content: string;
						filePath: string;
					}>,
				) => {
					for (const item of batch) {
						indexStmt.run(
							item.symbolId,
							item.name,
							item.qualifiedName,
							item.content,
							item.filePath,
						);
					}
				},
			);
			transaction(items);
		},

		search(query: string, limit = 20): KeywordSearchResult[] {
			// Escape special FTS5 characters
			const escapedQuery = query.replace(/[*"()]/g, " ").trim();
			if (!escapedQuery) return [];

			// Use trigram matching with BM25 ranking
			const searchStmt = db.prepare(`
				SELECT 
					symbol_id,
					name,
					qualified_name,
					file_path,
					bm25(fts_symbols) as rank
				FROM fts_symbols
				WHERE fts_symbols MATCH ?
				ORDER BY rank
				LIMIT ?
			`);

			try {
				const rows = searchStmt.all(escapedQuery, limit) as Array<{
					symbol_id: string;
					name: string;
					qualified_name: string;
					file_path: string;
					rank: number;
				}>;
				return rows.map((row) => ({
					symbol_id: row.symbol_id,
					name: row.name,
					qualified_name: row.qualified_name,
					file_path: row.file_path,
					rank: row.rank,
				}));
			} catch {
				// FTS5 query syntax error - return empty
				return [];
			}
		},

		delete(symbolId: string): void {
			deleteStmt.run(symbolId);
		},

		deleteByFilePath(filePath: string): void {
			deleteByFilePathStmt.run(filePath);
		},

		rebuild(): void {
			db.exec("INSERT INTO fts_symbols(fts_symbols) VALUES('rebuild')");
		},
	};
}
