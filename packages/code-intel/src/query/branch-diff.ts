/**
 * Branch Diff Queries - Compare symbols and edges between branches
 */

import type { Database } from "bun:sqlite";
import type { EdgeType, SymbolEdge, SymbolNode, SymbolType } from "../types";

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export interface SymbolDiff {
	status: DiffStatus;
	symbol: SymbolNode;
	/** Previous version if modified */
	previousSymbol?: SymbolNode;
	/** What changed if modified */
	changes?: {
		contentChanged: boolean;
		signatureChanged: boolean;
		locationChanged: boolean;
	};
}

export interface EdgeDiff {
	status: DiffStatus;
	edge: SymbolEdge;
	previousEdge?: SymbolEdge;
}

export interface BranchDiffResult {
	/** Source branch (typically feature branch) */
	sourceBranch: string;
	/** Target branch (typically main/master) */
	targetBranch: string;
	/** Symbol changes */
	symbols: {
		added: SymbolDiff[];
		removed: SymbolDiff[];
		modified: SymbolDiff[];
		/** Summary counts */
		summary: {
			added: number;
			removed: number;
			modified: number;
			unchanged: number;
		};
	};
	/** Edge changes */
	edges: {
		added: EdgeDiff[];
		removed: EdgeDiff[];
		/** Summary counts */
		summary: {
			added: number;
			removed: number;
		};
	};
	/** Files affected */
	affectedFiles: string[];
	/** Computation time in ms */
	computeTime: number;
}

export interface BranchDiffOptions {
	/** Filter by file patterns */
	filePatterns?: string[];
	/** Filter by symbol types */
	symbolTypes?: SymbolType[];
	/** Include edge diffs (can be expensive) */
	includeEdges?: boolean;
	/** Maximum symbols to return per category */
	limit?: number;
}

export interface BranchDiffer {
	/**
	 * Compare symbols between two branches
	 * @param sourceBranch The branch with changes (e.g., feature branch)
	 * @param targetBranch The base branch to compare against (e.g., main)
	 */
	diff(
		sourceBranch: string,
		targetBranch: string,
		options?: BranchDiffOptions,
	): BranchDiffResult;

	/**
	 * Get symbols that exist only in source branch
	 */
	getAddedSymbols(
		sourceBranch: string,
		targetBranch: string,
		limit?: number,
	): SymbolNode[];

	/**
	 * Get symbols that exist only in target branch (removed in source)
	 */
	getRemovedSymbols(
		sourceBranch: string,
		targetBranch: string,
		limit?: number,
	): SymbolNode[];

	/**
	 * Get symbols that changed between branches
	 */
	getModifiedSymbols(
		sourceBranch: string,
		targetBranch: string,
		limit?: number,
	): Array<{ source: SymbolNode; target: SymbolNode }>;

	/**
	 * Get files that differ between branches
	 */
	getAffectedFiles(sourceBranch: string, targetBranch: string): string[];
}

export function createBranchDiffer(db: Database): BranchDiffer {
	// Symbols in source but not in target (by qualified_name)
	const addedSymbolsStmt = db.prepare(`
		SELECT s.* FROM symbols s
		WHERE s.branch = ?
		AND NOT EXISTS (
			SELECT 1 FROM symbols t 
			WHERE t.branch = ? 
			AND t.qualified_name = s.qualified_name
		)
		LIMIT ?
	`);

	// Symbols in target but not in source (by qualified_name)
	const removedSymbolsStmt = db.prepare(`
		SELECT t.* FROM symbols t
		WHERE t.branch = ?
		AND NOT EXISTS (
			SELECT 1 FROM symbols s 
			WHERE s.branch = ? 
			AND s.qualified_name = t.qualified_name
		)
		LIMIT ?
	`);

	// Symbols that exist in both but have different content_hash
	const modifiedSymbolsStmt = db.prepare(`
		SELECT 
			s.id as source_id, s.name, s.qualified_name, s.type, s.language,
			s.file_path as source_file_path, s.start_line as source_start_line,
			s.end_line as source_end_line, s.content as source_content,
			s.signature as source_signature, s.docstring as source_docstring,
			s.content_hash as source_content_hash, s.is_external,
			s.branch as source_branch, s.updated_at as source_updated_at,
			s.revision_id as source_revision_id,
			t.id as target_id, t.file_path as target_file_path,
			t.start_line as target_start_line, t.end_line as target_end_line,
			t.content as target_content, t.signature as target_signature,
			t.docstring as target_docstring, t.content_hash as target_content_hash,
			t.branch as target_branch, t.updated_at as target_updated_at,
			t.revision_id as target_revision_id
		FROM symbols s
		INNER JOIN symbols t ON s.qualified_name = t.qualified_name
		WHERE s.branch = ? AND t.branch = ?
		AND s.content_hash != t.content_hash
		LIMIT ?
	`);

	// Count unchanged symbols
	const unchangedCountStmt = db.prepare(`
		SELECT COUNT(*) as count FROM symbols s
		INNER JOIN symbols t ON s.qualified_name = t.qualified_name
		WHERE s.branch = ? AND t.branch = ?
		AND s.content_hash = t.content_hash
	`);

	// Edges in source but not in target
	const addedEdgesStmt = db.prepare(`
		SELECT e.* FROM edges e
		WHERE e.branch = ?
		AND NOT EXISTS (
			SELECT 1 FROM edges t 
			WHERE t.branch = ? 
			AND t.source_id = e.source_id 
			AND t.target_id = e.target_id
			AND t.type = e.type
		)
		LIMIT ?
	`);

	// Edges in target but not in source
	const removedEdgesStmt = db.prepare(`
		SELECT t.* FROM edges t
		WHERE t.branch = ?
		AND NOT EXISTS (
			SELECT 1 FROM edges e 
			WHERE e.branch = ? 
			AND e.source_id = t.source_id 
			AND e.target_id = t.target_id
			AND e.type = t.type
		)
		LIMIT ?
	`);

	// Files that differ between branches
	const affectedFilesStmt = db.prepare(`
		SELECT DISTINCT file_path FROM (
			-- Files only in source
			SELECT s.file_path FROM symbols s
			WHERE s.branch = ?
			AND NOT EXISTS (
				SELECT 1 FROM symbols t WHERE t.branch = ? AND t.file_path = s.file_path
			)
			UNION
			-- Files only in target
			SELECT t.file_path FROM symbols t
			WHERE t.branch = ?
			AND NOT EXISTS (
				SELECT 1 FROM symbols s WHERE s.branch = ? AND s.file_path = t.file_path
			)
			UNION
			-- Files with modified symbols
			SELECT s.file_path FROM symbols s
			INNER JOIN symbols t ON s.qualified_name = t.qualified_name
			WHERE s.branch = ? AND t.branch = ?
			AND s.content_hash != t.content_hash
		)
		ORDER BY file_path
	`);

	function rowToSymbol(row: Record<string, unknown>, prefix = ""): SymbolNode {
		const p = prefix ? `${prefix}_` : "";
		return {
			id: row[`${p}id`] as string,
			name: row.name as string,
			qualified_name: row.qualified_name as string,
			type: row.type as SymbolType,
			language: row.language as "typescript" | "python",
			file_path: row[`${p}file_path`] as string,
			start_line: row[`${p}start_line`] as number,
			end_line: row[`${p}end_line`] as number,
			content: row[`${p}content`] as string,
			signature: (row[`${p}signature`] as string) || undefined,
			docstring: (row[`${p}docstring`] as string) || undefined,
			content_hash: row[`${p}content_hash`] as string,
			is_external: (row.is_external as number) === 1,
			branch: row[`${p}branch`] as string,
			updated_at: row[`${p}updated_at`] as number,
			revision_id: row[`${p}revision_id`] as number,
		};
	}

	function simpleRowToSymbol(row: Record<string, unknown>): SymbolNode {
		return {
			id: row.id as string,
			name: row.name as string,
			qualified_name: row.qualified_name as string,
			type: row.type as SymbolType,
			language: row.language as "typescript" | "python",
			file_path: row.file_path as string,
			start_line: row.start_line as number,
			end_line: row.end_line as number,
			content: row.content as string,
			signature: (row.signature as string) || undefined,
			docstring: (row.docstring as string) || undefined,
			content_hash: row.content_hash as string,
			is_external: (row.is_external as number) === 1,
			branch: row.branch as string,
			updated_at: row.updated_at as number,
			revision_id: row.revision_id as number,
		};
	}

	function rowToEdge(row: Record<string, unknown>): SymbolEdge {
		const edge: SymbolEdge = {
			id: row.id as string,
			source_id: row.source_id as string,
			target_id: row.target_id as string,
			type: row.type as EdgeType,
			confidence: row.confidence as number,
			origin: row.origin as "lsp" | "scip" | "ast-inference",
			branch: row.branch as string,
			updated_at: row.updated_at as number,
		};

		if (row.source_start_line !== null && row.source_end_line !== null) {
			edge.source_range = [
				row.source_start_line as number,
				row.source_end_line as number,
			];
		}

		if (row.target_start_line !== null && row.target_end_line !== null) {
			edge.target_range = [
				row.target_start_line as number,
				row.target_end_line as number,
			];
		}

		return edge;
	}

	return {
		diff(
			sourceBranch: string,
			targetBranch: string,
			options: BranchDiffOptions = {},
		): BranchDiffResult {
			const startTime = performance.now();
			const limit = options.limit ?? 1000;

			// Get added symbols
			const addedRows = addedSymbolsStmt.all(
				sourceBranch,
				targetBranch,
				limit,
			) as Record<string, unknown>[];
			const addedSymbols: SymbolDiff[] = addedRows.map((row) => ({
				status: "added" as const,
				symbol: simpleRowToSymbol(row),
			}));

			// Get removed symbols
			const removedRows = removedSymbolsStmt.all(
				targetBranch,
				sourceBranch,
				limit,
			) as Record<string, unknown>[];
			const removedSymbols: SymbolDiff[] = removedRows.map((row) => ({
				status: "removed" as const,
				symbol: simpleRowToSymbol(row),
			}));

			// Get modified symbols
			const modifiedRows = modifiedSymbolsStmt.all(
				sourceBranch,
				targetBranch,
				limit,
			) as Record<string, unknown>[];
			const modifiedSymbols: SymbolDiff[] = modifiedRows.map((row) => {
				const sourceSymbol = rowToSymbol(row, "source");
				const targetSymbol = rowToSymbol(row, "target");
				return {
					status: "modified" as const,
					symbol: sourceSymbol,
					previousSymbol: targetSymbol,
					changes: {
						contentChanged: sourceSymbol.content !== targetSymbol.content,
						signatureChanged: sourceSymbol.signature !== targetSymbol.signature,
						locationChanged:
							sourceSymbol.file_path !== targetSymbol.file_path ||
							sourceSymbol.start_line !== targetSymbol.start_line,
					},
				};
			});

			// Get unchanged count
			const unchangedResult = unchangedCountStmt.get(
				sourceBranch,
				targetBranch,
			) as { count: number };

			// Get edge diffs if requested
			let addedEdges: EdgeDiff[] = [];
			let removedEdges: EdgeDiff[] = [];

			if (options.includeEdges !== false) {
				const addedEdgeRows = addedEdgesStmt.all(
					sourceBranch,
					targetBranch,
					limit,
				) as Record<string, unknown>[];
				addedEdges = addedEdgeRows.map((row) => ({
					status: "added" as const,
					edge: rowToEdge(row),
				}));

				const removedEdgeRows = removedEdgesStmt.all(
					targetBranch,
					sourceBranch,
					limit,
				) as Record<string, unknown>[];
				removedEdges = removedEdgeRows.map((row) => ({
					status: "removed" as const,
					edge: rowToEdge(row),
				}));
			}

			// Get affected files
			const fileRows = affectedFilesStmt.all(
				sourceBranch,
				targetBranch,
				targetBranch,
				sourceBranch,
				sourceBranch,
				targetBranch,
			) as Array<{ file_path: string }>;
			const affectedFiles = fileRows.map((r) => r.file_path);

			const computeTime = performance.now() - startTime;

			return {
				sourceBranch,
				targetBranch,
				symbols: {
					added: addedSymbols,
					removed: removedSymbols,
					modified: modifiedSymbols,
					summary: {
						added: addedSymbols.length,
						removed: removedSymbols.length,
						modified: modifiedSymbols.length,
						unchanged: unchangedResult.count,
					},
				},
				edges: {
					added: addedEdges,
					removed: removedEdges,
					summary: {
						added: addedEdges.length,
						removed: removedEdges.length,
					},
				},
				affectedFiles,
				computeTime,
			};
		},

		getAddedSymbols(
			sourceBranch: string,
			targetBranch: string,
			limit = 100,
		): SymbolNode[] {
			const rows = addedSymbolsStmt.all(
				sourceBranch,
				targetBranch,
				limit,
			) as Record<string, unknown>[];
			return rows.map(simpleRowToSymbol);
		},

		getRemovedSymbols(
			sourceBranch: string,
			targetBranch: string,
			limit = 100,
		): SymbolNode[] {
			const rows = removedSymbolsStmt.all(
				targetBranch,
				sourceBranch,
				limit,
			) as Record<string, unknown>[];
			return rows.map(simpleRowToSymbol);
		},

		getModifiedSymbols(
			sourceBranch: string,
			targetBranch: string,
			limit = 100,
		): Array<{ source: SymbolNode; target: SymbolNode }> {
			const rows = modifiedSymbolsStmt.all(
				sourceBranch,
				targetBranch,
				limit,
			) as Record<string, unknown>[];
			return rows.map((row) => ({
				source: rowToSymbol(row, "source"),
				target: rowToSymbol(row, "target"),
			}));
		},

		getAffectedFiles(sourceBranch: string, targetBranch: string): string[] {
			const rows = affectedFilesStmt.all(
				sourceBranch,
				targetBranch,
				targetBranch,
				sourceBranch,
				sourceBranch,
				targetBranch,
			) as Array<{ file_path: string }>;
			return rows.map((r) => r.file_path);
		},
	};
}
