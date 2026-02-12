/**
 * Content FTS Store - Unified FTS5 operations for multi-granularity search
 * Supports symbols, chunks, and file-level content in a single index
 */

import type { Database } from "bun:sqlite";
import type { Granularity } from "../types";

export interface FTSEntry {
	content_id: string;
	content_type: Granularity;
	file_path: string;
	name: string;
	content: string;
}

export interface FTSSearchResult {
	content_id: string;
	content_type: Granularity;
	file_path: string;
	name: string;
	content: string;
	rank: number;
}

export interface ContentFTSStore {
	index(entry: FTSEntry): void;
	indexMany(entries: FTSEntry[]): void;
	search(query: string, options?: FTSSearchOptions): FTSSearchResult[];
	deleteById(contentId: string): boolean;
	deleteByContentType(contentType: Granularity): number;
	deleteByFilePath(filePath: string): number;
	rebuild(): void;
	count(): number;
	countByContentType(contentType: Granularity): number;
}

export interface FTSSearchOptions {
	limit?: number;
	contentType?: Granularity;
	filePatterns?: string[];
}

/**
 * FTS5 reserved words that must not appear as bare terms in a MATCH expression.
 * These are case-insensitive in FTS5.
 */
const FTS5_OPERATORS = new Set(["and", "or", "not", "near"]);

/**
 * Tokenize and sanitize a user query for FTS5 MATCH.
 *
 * Strategy:
 * - Split into individual tokens
 * - Remove FTS5 operator words (AND/OR/NOT/NEAR) to prevent syntax errors
 * - Remove special FTS5 characters (* : ^ ( ) ")
 * - Filter out tokens that are too short (< 2 chars) or empty
 * - Add prefix matching with trailing * for tokens >= 4 chars (partial matching)
 * - Return tokens joined by space (FTS5 implicit AND for unquoted space-separated terms)
 *
 * Returns empty string if no valid tokens remain.
 */
function buildFTS5Query(query: string): string {
	const tokens = query
		.replace(/[":^()]/g, " ") // Remove FTS5 special chars (keep * for now)
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2)
		.filter((t) => !FTS5_OPERATORS.has(t.toLowerCase()));

	if (tokens.length === 0) return "";

	// For each token, add prefix matching if token is >= 4 chars
	// This helps with partial matches: "recipien" -> "recipien*"
	return tokens
		.map((t) => {
			// If token already ends with *, keep as-is
			if (t.endsWith("*")) return `"${t.replace(/\*/g, "")}"*`;
			// For longer tokens, add prefix match
			if (t.length >= 4) return `"${t}" OR "${t}"*`;
			// Short tokens: exact match only (quoted to avoid FTS5 interpretation)
			return `"${t}"`;
		})
		.join(" AND ");
}

export function createContentFTSStore(db: Database): ContentFTSStore {
	// Prepared statements
	const indexStmt = db.prepare(`
		INSERT OR REPLACE INTO fts_content (
			content_id, content_type, file_path, name, content
		) VALUES (?, ?, ?, ?, ?)
	`);

	const deleteByIdStmt = db.prepare(
		"DELETE FROM fts_content WHERE content_id = ?",
	);

	const deleteByContentTypeStmt = db.prepare(
		"DELETE FROM fts_content WHERE content_type = ?",
	);

	const deleteByFilePathStmt = db.prepare(
		"DELETE FROM fts_content WHERE file_path = ?",
	);

	const countStmt = db.prepare(
		"SELECT COUNT(*) as count FROM fts_content",
	);

	const countByContentTypeStmt = db.prepare(
		"SELECT COUNT(*) as count FROM fts_content WHERE content_type = ?",
	);

	return {
		index(entry: FTSEntry): void {
			indexStmt.run(
				entry.content_id,
				entry.content_type,
				entry.file_path,
				entry.name,
				entry.content,
			);
		},

		indexMany(entries: FTSEntry[]): void {
			const transaction = db.transaction((items: FTSEntry[]) => {
				for (const entry of items) {
					this.index(entry);
				}
			});
			transaction(entries);
		},

		search(query: string, options: FTSSearchOptions = {}): FTSSearchResult[] {
			const { limit = 50, contentType, filePatterns } = options;
			const fts5Query = buildFTS5Query(query);

			if (!fts5Query) {
				return [];
			}

			// Build query with optional filters
			let sql = `
				SELECT 
					content_id, content_type, file_path, name, content,
					bm25(fts_content) as rank
				FROM fts_content
				WHERE fts_content MATCH ?
			`;

			const params: (string | number)[] = [fts5Query];

			if (contentType) {
				sql += " AND content_type = ?";
				params.push(contentType);
			}

			if (filePatterns && filePatterns.length > 0) {
				const patterns = filePatterns
					.map((p) => `file_path GLOB ?`)
					.join(" OR ");
				sql += ` AND (${patterns})`;
				params.push(...filePatterns);
			}

			sql += " ORDER BY rank LIMIT ?";
			params.push(limit);

			const stmt = db.prepare(sql);
			const rows = stmt.all(...params) as Record<string, unknown>[];

			return rows.map((row) => ({
				content_id: row.content_id as string,
				content_type: row.content_type as Granularity,
				file_path: row.file_path as string,
				name: row.name as string,
				content: row.content as string,
				rank: row.rank as number,
			}));
		},

		deleteById(contentId: string): boolean {
			const result = deleteByIdStmt.run(contentId);
			return result.changes > 0;
		},

		deleteByContentType(contentType: Granularity): number {
			const result = deleteByContentTypeStmt.run(contentType);
			return result.changes;
		},

		deleteByFilePath(filePath: string): number {
			const result = deleteByFilePathStmt.run(filePath);
			return result.changes;
		},

		rebuild(): void {
			db.exec("INSERT INTO fts_content(fts_content) VALUES('rebuild')");
		},

		count(): number {
			const result = countStmt.get() as { count: number };
			return result.count;
		},

		countByContentType(contentType: Granularity): number {
			const result = countByContentTypeStmt.get(contentType) as { count: number };
			return result.count;
		},
	};
}
