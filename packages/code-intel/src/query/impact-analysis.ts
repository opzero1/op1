/**
 * Impact Analysis - Analyze transitive dependents and calculate risk scores
 */

import type { EdgeStore } from "../storage/edge-store";
import type { SymbolStore } from "../storage/symbol-store";
import type { ImpactAnalysis, RiskLevel, SymbolNode } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface ImpactAnalysisOptions {
	/** Current branch */
	branch: string;
	/** Minimum edge confidence to follow (default: 0.5) */
	confidenceThreshold?: number;
	/** Maximum traversal depth (default: 10) */
	maxDepth?: number;
}

interface AffectedSymbolEntry {
	symbol: SymbolNode;
	path: string[];
	depth: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;
const DEFAULT_MAX_DEPTH = 10;

// Risk thresholds
const RISK_LOW_MAX = 3;
const RISK_MEDIUM_MAX = 10;
const RISK_HIGH_MAX = 25;

// ============================================================================
// Risk Scoring
// ============================================================================

function calculateRiskLevel(dependentCount: number): RiskLevel {
	if (dependentCount <= RISK_LOW_MAX) return "low";
	if (dependentCount <= RISK_MEDIUM_MAX) return "medium";
	if (dependentCount <= RISK_HIGH_MAX) return "high";
	return "critical";
}

function determineConfidence(
	hasStaleData: boolean,
	hasPartialData: boolean,
): ImpactAnalysis["confidence"] {
	if (hasStaleData) return "degraded";
	if (hasPartialData) return "medium";
	return "high";
}

// ============================================================================
// Impact Analyzer
// ============================================================================

export interface ImpactAnalyzer {
	analyzeImpact(
		symbolId: string,
		options: ImpactAnalysisOptions,
	): ImpactAnalysis | null;
}

export function createImpactAnalyzer(
	symbolStore: SymbolStore,
	edgeStore: EdgeStore,
): ImpactAnalyzer {
	function parseOptions(options: ImpactAnalysisOptions): {
		branch: string;
		confidenceThreshold: number;
		maxDepth: number;
	} {
		return {
			branch: options.branch,
			confidenceThreshold:
				options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
			maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		};
	}

	function findTransitiveDependents(
		rootSymbol: SymbolNode,
		options: ReturnType<typeof parseOptions>,
	): {
		directDependents: number;
		affectedSymbols: AffectedSymbolEntry[];
		hasPartialData: boolean;
		hasStaleData: boolean;
	} {
		const visited = new Set<string>();
		const affectedSymbols: AffectedSymbolEntry[] = [];
		let directDependents = 0;
		let hasPartialData = false;
		let hasStaleData = false;

		// Track paths for each symbol
		const symbolPaths = new Map<string, string[]>();

		// BFS to find all transitive dependents (callers)
		const queue: Array<{ symbolId: string; depth: number; path: string[] }> = [
			{ symbolId: rootSymbol.id, depth: 0, path: [rootSymbol.qualified_name] },
		];
		visited.add(rootSymbol.id);

		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.depth >= options.maxDepth) {
				hasPartialData = true;
				continue;
			}

			// Get all callers of this symbol
			const callerEdges = edgeStore.getCallers(
				current.symbolId,
				options.branch,
			);

			// Filter by confidence
			const validEdges = callerEdges.filter(
				(edge) => edge.confidence >= options.confidenceThreshold,
			);

			for (const edge of validEdges) {
				if (visited.has(edge.source_id)) continue;
				visited.add(edge.source_id);

				const callerSymbol = symbolStore.getById(edge.source_id);
				if (!callerSymbol) {
					hasPartialData = true;
					continue;
				}

				// Check for stale data (symbol updated more recently than edge)
				if (callerSymbol.updated_at > edge.updated_at) {
					hasStaleData = true;
				}

				const nextDepth = current.depth + 1;
				const nextPath = [...current.path, callerSymbol.qualified_name];

				// Track direct dependents (depth 1)
				if (nextDepth === 1) {
					directDependents++;
				}

				affectedSymbols.push({
					symbol: callerSymbol,
					path: nextPath,
					depth: nextDepth,
				});

				symbolPaths.set(callerSymbol.id, nextPath);
				queue.push({
					symbolId: callerSymbol.id,
					depth: nextDepth,
					path: nextPath,
				});
			}
		}

		return {
			directDependents,
			affectedSymbols,
			hasPartialData,
			hasStaleData,
		};
	}

	return {
		analyzeImpact(
			symbolId: string,
			options: ImpactAnalysisOptions,
		): ImpactAnalysis | null {
			const rootSymbol = symbolStore.getById(symbolId);
			if (!rootSymbol) return null;

			const parsedOptions = parseOptions(options);
			const {
				directDependents,
				affectedSymbols,
				hasPartialData,
				hasStaleData,
			} = findTransitiveDependents(rootSymbol, parsedOptions);

			const transitiveDependents = affectedSymbols.length;
			const riskLevel = calculateRiskLevel(transitiveDependents);
			const confidence = determineConfidence(hasStaleData, hasPartialData);

			return {
				symbol: rootSymbol,
				risk: riskLevel,
				directDependents,
				transitiveDependents,
				affectedSymbols,
				confidence,
			};
		},
	};
}
