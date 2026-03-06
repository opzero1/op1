/**
 * Repo Map Injector - Query-aware repo map injection
 *
 * Detects orientation queries ("where should I add...", "what folder...")
 * and injects a compact repo map to help with navigation decisions.
 */

import type { RepoMapStore } from "../storage/repo-map-store";
import type { RepoMapEntry } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface RepoMapInjectorConfig {
	/** Default number of files to include */
	defaultLimit: number;
	/** Maximum number of files to include */
	maxLimit: number;
	/** Minimum importance score to include */
	minImportanceScore: number;
}

export interface InjectionResult {
	/** Whether injection was performed */
	injected: boolean;
	/** The formatted repo map (empty if not injected) */
	repoMap: string;
	/** Number of files included */
	fileCount: number;
	/** Reason for injection/non-injection */
	reason: string;
}

export interface RepoMapInjector {
	/** Check if query needs repo map injection */
	shouldInject(query: string): boolean;
	/** Get formatted repo map for injection */
	inject(branch: string, query: string, limit?: number): InjectionResult;
	/** Format repo map entries as compact list */
	format(entries: RepoMapEntry[]): string;
}

const DEFAULT_CONFIG: RepoMapInjectorConfig = {
	defaultLimit: 15,
	maxLimit: 25,
	minImportanceScore: 0,
};

// ============================================================================
// Orientation Query Detection
// ============================================================================

/**
 * Patterns that indicate orientation/navigation queries
 */
const ORIENTATION_PATTERNS: RegExp[] = [
	// Location questions
	/where\s+should\s+(?:i|we)\s+(?:add|put|place|create|implement)/i,
	/which\s+(?:file|folder|directory|module)\s+(?:should|to)/i,
	/what\s+(?:file|folder|directory)\s+(?:should|contains?|has)/i,
	/in\s+which\s+(?:file|folder|directory)/i,

	// Structure questions
	/how\s+is\s+(?:the\s+)?(?:code|project|codebase)\s+(?:structured|organized)/i,
	/(?:project|code|folder)\s+structure/i,
	/overview\s+of\s+(?:the\s+)?(?:code|project|codebase)/i,
	/architecture\s+(?:of|overview)/i,

	// Navigation questions
	/(?:find|locate|look\s+for)\s+(?:the\s+)?(?:file|module|component)/i,
	/where\s+(?:is|are|can\s+i\s+find)/i,
	/what\s+(?:files?|modules?)\s+(?:are\s+)?(?:related|connected)/i,

	// Discovery questions
	/(?:main|entry|core)\s+(?:file|module|component)/i,
	/most\s+(?:important|central|critical)\s+(?:files?|modules?)/i,
	/key\s+(?:files?|modules?|components?)/i,

	// New feature questions
	/(?:add|create|implement)\s+(?:a\s+)?new\s+(?:feature|component|module)/i,
	/best\s+(?:place|location)\s+(?:to|for)/i,
	/(?:where|how)\s+to\s+(?:start|begin)/i,
];

/**
 * Patterns that indicate NOT an orientation query (more specific)
 */
const NON_ORIENTATION_PATTERNS: RegExp[] = [
	// Specific implementation questions
	/(?:fix|debug|solve)\s+(?:this|the)\s+(?:bug|error|issue)/i,
	/why\s+(?:is|does|doesn't)/i,
	/how\s+(?:does|do)\s+(?:this|the)\s+(?:function|method|class)/i,

	// Code-specific questions
	/what\s+does\s+(?:this|the)\s+(?:function|method|code)/i,
	/explain\s+(?:this|the)\s+(?:code|function|method)/i,

	// Refactoring with context
	/refactor\s+(?:this|the)\s+(?:function|method|class)/i,
];

function detectOrientationQuery(query: string): {
	isOrientation: boolean;
	matchedPattern?: string;
} {
	// Check non-orientation patterns first (they take precedence)
	for (const pattern of NON_ORIENTATION_PATTERNS) {
		if (pattern.test(query)) {
			return { isOrientation: false };
		}
	}

	// Check orientation patterns
	for (const pattern of ORIENTATION_PATTERNS) {
		if (pattern.test(query)) {
			return {
				isOrientation: true,
				matchedPattern: pattern.source,
			};
		}
	}

	return { isOrientation: false };
}

// ============================================================================
// Formatting
// ============================================================================

function formatEntry(entry: RepoMapEntry): string {
	const imports = entry.in_degree;
	const exports = entry.out_degree;
	const symbols = entry.symbol_summary;

	let line = entry.file_path;
	line += ` (imports: ${imports}, exports: ${exports})`;

	if (symbols) {
		line += ` - ${symbols}`;
	}

	return line;
}

function formatRepoMap(entries: RepoMapEntry[]): string {
	if (entries.length === 0) {
		return "";
	}

	const lines = ["## Repo Map (most important files)", ""];

	for (const entry of entries) {
		lines.push(`- ${formatEntry(entry)}`);
	}

	return lines.join("\n");
}

// ============================================================================
// Implementation
// ============================================================================

export function createRepoMapInjector(
	repoMapStore: RepoMapStore,
	config: Partial<RepoMapInjectorConfig> = {},
): RepoMapInjector {
	const cfg: RepoMapInjectorConfig = { ...DEFAULT_CONFIG, ...config };

	return {
		shouldInject(query: string): boolean {
			if (!query || query.trim().length === 0) return false;

			const { isOrientation } = detectOrientationQuery(query);
			return isOrientation;
		},

		inject(branch: string, query: string, limit?: number): InjectionResult {
			const { isOrientation, matchedPattern } = detectOrientationQuery(query);

			if (!isOrientation) {
				return {
					injected: false,
					repoMap: "",
					fileCount: 0,
					reason: "Query is not an orientation query",
				};
			}

			const effectiveLimit = Math.min(limit ?? cfg.defaultLimit, cfg.maxLimit);
			const entries = repoMapStore.getByBranch(branch, effectiveLimit);

			// Filter by minimum importance score
			const filteredEntries = entries.filter(
				(e) => e.importance_score >= cfg.minImportanceScore,
			);

			if (filteredEntries.length === 0) {
				return {
					injected: false,
					repoMap: "",
					fileCount: 0,
					reason: "No files in repo map meet minimum importance threshold",
				};
			}

			const formattedMap = formatRepoMap(filteredEntries);

			return {
				injected: true,
				repoMap: formattedMap,
				fileCount: filteredEntries.length,
				reason: `Matched orientation pattern: ${matchedPattern}`,
			};
		},

		format(entries: RepoMapEntry[]): string {
			return formatRepoMap(entries);
		},
	};
}
