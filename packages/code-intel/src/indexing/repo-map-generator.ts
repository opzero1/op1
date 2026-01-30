/**
 * Repo Map Generator - PageRank-based file importance scoring
 *
 * Builds an import graph from IMPORTS edges and computes importance scores
 * using the PageRank algorithm. Supports incremental updates to avoid
 * recomputing the entire graph on every change.
 */

import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import type { Database } from "bun:sqlite";
import type { EdgeStore } from "../storage/edge-store";
import type { RepoMapStore } from "../storage/repo-map-store";
import type { SymbolStore } from "../storage/symbol-store";
import type { RepoMapEntry, SymbolNode } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface RepoMapGeneratorConfig {
	/** Boost factor for files with mentioned identifiers */
	mentionedIdentifierBoost: number;
	/** Boost factor for recently edited files */
	recentEditBoost: number;
	/** Time window for "recent" edits in milliseconds (default: 7 days) */
	recentEditWindow: number;
	/** Maximum symbols to include in summary */
	maxSymbolsInSummary: number;
}

export interface GenerateOptions {
	/** Files that were recently mentioned in context */
	mentionedFiles?: Set<string>;
	/** Files that were recently edited */
	recentlyEditedFiles?: Set<string>;
	/** Only update specific files (incremental mode) */
	incrementalFiles?: string[];
}

export interface RepoMapGenerator {
	/** Generate/regenerate the full repo map */
	generate(branch: string, options?: GenerateOptions): RepoMapEntry[];
	/** Incrementally update scores for affected files */
	updateIncremental(
		branch: string,
		changedFiles: string[],
		options?: GenerateOptions,
	): RepoMapEntry[];
	/** Get current configuration */
	getConfig(): RepoMapGeneratorConfig;
}

const DEFAULT_CONFIG: RepoMapGeneratorConfig = {
	mentionedIdentifierBoost: 10,
	recentEditBoost: 5,
	recentEditWindow: 7 * 24 * 60 * 60 * 1000, // 7 days
	maxSymbolsInSummary: 5,
};

// ============================================================================
// Implementation
// ============================================================================

export function createRepoMapGenerator(
	db: Database,
	edgeStore: EdgeStore,
	symbolStore: SymbolStore,
	repoMapStore: RepoMapStore,
	config: Partial<RepoMapGeneratorConfig> = {},
): RepoMapGenerator {
	const cfg: RepoMapGeneratorConfig = { ...DEFAULT_CONFIG, ...config };

	// Prepared statement for getting file symbols for summary
	const getFileSymbolsStmt = db.prepare(`
		SELECT name, type FROM symbols 
		WHERE file_path = ? AND branch = ? AND is_external = 0
		ORDER BY 
			CASE type 
				WHEN 'CLASS' THEN 1 
				WHEN 'INTERFACE' THEN 2 
				WHEN 'FUNCTION' THEN 3 
				WHEN 'TYPE_ALIAS' THEN 4
				ELSE 5 
			END,
			start_line
		LIMIT ?
	`);

	function buildImportGraph(branch: string): Graph {
		const graph = new Graph({ type: "directed", allowSelfLoops: false });
		const edges = edgeStore.getByType("IMPORTS", branch);

		// Build file-level graph from symbol-level edges
		// source_id imports target_id → source file depends on target file
		const fileEdges = new Map<string, Set<string>>();
		const allFiles = new Set<string>();

		for (const edge of edges) {
			const sourceSymbol = symbolStore.getById(edge.source_id);
			const targetSymbol = symbolStore.getById(edge.target_id);

			if (!sourceSymbol || !targetSymbol) continue;
			if (sourceSymbol.is_external || targetSymbol.is_external) continue;

			const sourceFile = sourceSymbol.file_path;
			const targetFile = targetSymbol.file_path;

			if (sourceFile === targetFile) continue;

			allFiles.add(sourceFile);
			allFiles.add(targetFile);

			const key = sourceFile;
			if (!fileEdges.has(key)) {
				fileEdges.set(key, new Set());
			}
			fileEdges.get(key)!.add(targetFile);
		}

		// Add nodes
		for (const file of allFiles) {
			if (!graph.hasNode(file)) {
				graph.addNode(file);
			}
		}

		// Add edges (importer → imported)
		for (const [source, targets] of fileEdges) {
			for (const target of targets) {
				if (!graph.hasEdge(source, target)) {
					graph.addEdge(source, target);
				}
			}
		}

		return graph;
	}

	function computePageRank(graph: Graph): Map<string, number> {
		if (graph.order === 0) {
			return new Map();
		}

		const scores = pagerank(graph, {
			alpha: 0.85,
			maxIterations: 100,
			tolerance: 1e-6,
			getEdgeWeight: () => 1,
		});

		return new Map(Object.entries(scores));
	}

	function computeDegrees(graph: Graph): Map<string, { in: number; out: number }> {
		const degrees = new Map<string, { in: number; out: number }>();

		for (const node of graph.nodes()) {
			degrees.set(node, {
				in: graph.inDegree(node),
				out: graph.outDegree(node),
			});
		}

		return degrees;
	}

	function generateSymbolSummary(filePath: string, branch: string): string {
		const rows = getFileSymbolsStmt.all(
			filePath,
			branch,
			cfg.maxSymbolsInSummary,
		) as Array<{ name: string; type: string }>;

		if (rows.length === 0) return "";

		return rows.map((r) => r.name).join(", ");
	}

	function applyBoosts(
		baseScore: number,
		filePath: string,
		options: GenerateOptions,
	): number {
		let score = baseScore;

		if (options.mentionedFiles?.has(filePath)) {
			score *= cfg.mentionedIdentifierBoost;
		}

		if (options.recentlyEditedFiles?.has(filePath)) {
			score *= cfg.recentEditBoost;
		}

		return score;
	}

	function generateEntries(
		graph: Graph,
		pageRankScores: Map<string, number>,
		degrees: Map<string, { in: number; out: number }>,
		branch: string,
		options: GenerateOptions,
		filterFiles?: Set<string>,
	): RepoMapEntry[] {
		const entries: RepoMapEntry[] = [];

		for (const filePath of graph.nodes()) {
			if (filterFiles && !filterFiles.has(filePath)) continue;

			const baseScore = pageRankScores.get(filePath) ?? 0;
			const boostedScore = applyBoosts(baseScore, filePath, options);
			const degree = degrees.get(filePath) ?? { in: 0, out: 0 };
			const symbolSummary = generateSymbolSummary(filePath, branch);

			entries.push({
				file_path: filePath,
				importance_score: boostedScore,
				in_degree: degree.in,
				out_degree: degree.out,
				symbol_summary: symbolSummary,
				branch,
			});
		}

		return entries;
	}

	return {
		generate(branch: string, options: GenerateOptions = {}): RepoMapEntry[] {
			const graph = buildImportGraph(branch);
			const pageRankScores = computePageRank(graph);
			const degrees = computeDegrees(graph);

			const entries = generateEntries(
				graph,
				pageRankScores,
				degrees,
				branch,
				options,
			);

			// Persist all entries
			repoMapStore.deleteByBranch(branch);
			repoMapStore.upsertMany(entries);

			return entries;
		},

		updateIncremental(
			branch: string,
			changedFiles: string[],
			options: GenerateOptions = {},
		): RepoMapEntry[] {
			if (changedFiles.length === 0) return [];

			// For incremental updates, we still need to rebuild the graph
			// because PageRank is a global algorithm. However, we only
			// update the entries for affected files (changed + their neighbors)
			const graph = buildImportGraph(branch);
			const pageRankScores = computePageRank(graph);
			const degrees = computeDegrees(graph);

			// Find affected files: changed files + direct neighbors
			const affectedFiles = new Set<string>(changedFiles);
			for (const file of changedFiles) {
				if (!graph.hasNode(file)) continue;

				// Add files that import this file (inbound neighbors)
				for (const neighbor of graph.inNeighbors(file)) {
					affectedFiles.add(neighbor);
				}
				// Add files that this file imports (outbound neighbors)
				for (const neighbor of graph.outNeighbors(file)) {
					affectedFiles.add(neighbor);
				}
			}

			const entries = generateEntries(
				graph,
				pageRankScores,
				degrees,
				branch,
				options,
				affectedFiles,
			);

			// Update only affected entries
			repoMapStore.upsertMany(entries);

			return entries;
		},

		getConfig(): RepoMapGeneratorConfig {
			return { ...cfg };
		},
	};
}
