/**
 * Query Rewriter - Expand and enhance queries for better retrieval
 *
 * Supports:
 * - Term expansion (code synonyms)
 * - File path extraction
 * - Language detection
 * - HyDE (Hypothetical Document Embeddings) - optional
 */

// ============================================================================
// Types
// ============================================================================

export interface RewrittenQuery {
	/** Original query text */
	original: string;
	/** Expanded query text (with synonyms) */
	expanded: string;
	/** Extracted file patterns */
	filePatterns: string[];
	/** Detected language filters */
	languages: string[];
	/** Query terms for highlighting */
	terms: string[];
	/** Additional search terms from expansion */
	expansions: string[];
}

export interface QueryRewriterConfig {
	/** Enable synonym expansion (default: true) */
	enableSynonyms?: boolean;
	/** Enable file path extraction (default: true) */
	enablePathExtraction?: boolean;
	/** Maximum expansions per term (default: 3) */
	maxExpansionsPerTerm?: number;
}

export interface QueryRewriter {
	/** Rewrite a query for better retrieval */
	rewrite(query: string): RewrittenQuery;
}

// ============================================================================
// Code Synonyms
// ============================================================================

const CODE_SYNONYMS: Record<string, string[]> = {
	// Actions
	create: ["add", "new", "insert", "make", "generate", "build"],
	delete: ["remove", "destroy", "drop", "erase", "clear"],
	update: ["modify", "change", "edit", "patch", "set"],
	get: ["fetch", "retrieve", "find", "query", "read", "load"],
	send: ["emit", "dispatch", "publish", "post", "transmit"],
	receive: ["handle", "process", "consume", "listen"],

	// Data structures
	list: ["array", "collection", "items", "entries"],
	map: ["object", "dict", "dictionary", "hash", "record"],
	function: ["method", "func", "fn", "handler", "callback"],
	class: ["type", "model", "entity", "component"],
	interface: ["type", "contract", "protocol"],

	// Patterns
	async: ["await", "promise", "concurrent"],
	error: ["exception", "throw", "catch", "fail"],
	test: ["spec", "describe", "it", "expect", "assert"],
	config: ["configuration", "settings", "options", "params"],
	auth: ["authentication", "authorization", "login", "session"],
	api: ["endpoint", "route", "handler", "controller"],

	// Common terms
	user: ["account", "profile", "member"],
	file: ["document", "path", "resource"],
	data: ["payload", "body", "content"],
	response: ["result", "output", "return"],
	request: ["input", "params", "args"],
};

// ============================================================================
// File Pattern Detection
// ============================================================================

const FILE_PATTERNS: Array<{ pattern: RegExp; glob: string }> = [
	{ pattern: /\b(test|spec|__tests__)\b/i, glob: "**/*test*" },
	{ pattern: /\bconfig\b/i, glob: "**/*config*" },
	{ pattern: /\butils?\b/i, glob: "**/util*" },
	{ pattern: /\bhelpers?\b/i, glob: "**/helper*" },
	{ pattern: /\bcomponents?\b/i, glob: "**/component*" },
	{ pattern: /\bhooks?\b/i, glob: "**/hook*" },
	{ pattern: /\bapi\b/i, glob: "**/api*" },
	{ pattern: /\broutes?\b/i, glob: "**/route*" },
	{ pattern: /\bcontrollers?\b/i, glob: "**/controller*" },
	{ pattern: /\bservices?\b/i, glob: "**/service*" },
	{ pattern: /\bmodels?\b/i, glob: "**/model*" },
	{ pattern: /\btypes?\b/i, glob: "**/type*" },
	{ pattern: /\bschema\b/i, glob: "**/schema*" },
	{ pattern: /\bmiddleware\b/i, glob: "**/middleware*" },
];

/**
 * Terms that match FILE_PATTERNS but are too common as search terms
 * to safely use as file path filters. When these appear in a query,
 * they should be treated as search terms, not file path hints.
 *
 * File patterns are only extracted when the query contains explicit
 * path-like syntax (slashes, file extensions) — see extractFilePatterns.
 */
const FILE_PATTERN_EXCLUSIONS = new Set([
	"service", "services",
	"model", "models",
	"type", "types",
	"route", "routes",
	"controller", "controllers",
	"component", "components",
	"hook", "hooks",
	"util", "utils",
	"helper", "helpers",
	"config",
	"test", "tests", "spec",
	"middleware",
	"schema",
	"api",
]);

// ============================================================================
// Language Detection
// ============================================================================

const LANGUAGE_PATTERNS: Array<{ pattern: RegExp; language: string }> = [
	{ pattern: /\b(typescript|ts|tsx)\b/i, language: "typescript" },
	{ pattern: /\b(javascript|js|jsx)\b/i, language: "typescript" }, // We treat JS as TS
	{ pattern: /\b(python|py)\b/i, language: "python" },
	{ pattern: /\b(react|vue|angular|svelte)\b/i, language: "typescript" },
	{ pattern: /\b(node|express|nestjs|fastify)\b/i, language: "typescript" },
	{ pattern: /\b(django|flask|fastapi)\b/i, language: "python" },
];

// ============================================================================
// Query Rewriter Implementation
// ============================================================================

export function createQueryRewriter(
	config: QueryRewriterConfig = {},
): QueryRewriter {
	const {
		enableSynonyms = true,
		enablePathExtraction = true,
		maxExpansionsPerTerm = 3,
	} = config;

	function extractTerms(query: string): string[] {
		return query
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2);
	}

	function expandTerms(terms: string[]): string[] {
		if (!enableSynonyms) return [];

		const expansions: string[] = [];

		for (const term of terms) {
			const synonyms = CODE_SYNONYMS[term];
			if (synonyms) {
				expansions.push(...synonyms.slice(0, maxExpansionsPerTerm));
			}
		}

		return [...new Set(expansions)];
	}

	function extractFilePatterns(query: string): string[] {
		if (!enablePathExtraction) return [];

		const patterns: string[] = [];
		const queryLower = query.toLowerCase();

		// Only extract glob patterns from FILE_PATTERNS when the query
		// contains explicit path-like syntax (slash, dot+extension, etc.)
		// General terms like "service" or "model" are too ambiguous —
		// they're common search terms and shouldn't restrict results to
		// files whose paths happen to contain the word.
		const hasExplicitPathSyntax = /[\/\\]|\.(?:ts|tsx|js|jsx|py)\b/.test(query);

		for (const { pattern, glob } of FILE_PATTERNS) {
			if (!pattern.test(query)) continue;

			// With explicit path syntax, trust all pattern matches
			if (hasExplicitPathSyntax) {
				patterns.push(glob);
				continue;
			}

			// Without path syntax, skip patterns triggered by excluded terms
			// (e.g. "service" in "payment service" is a search term, not a path hint)
			const matchedWord = queryLower.match(pattern)?.[0];
			if (matchedWord && FILE_PATTERN_EXCLUSIONS.has(matchedWord)) continue;

			patterns.push(glob);
		}

		// Always extract explicit file mentions (e.g., "user.service.ts")
		const fileMatch = query.match(/\b[\w-]+\.(ts|tsx|js|jsx|py)\b/gi);
		if (fileMatch) {
			patterns.push(...fileMatch.map((f) => `**/${f}`));
		}

		return [...new Set(patterns)];
	}

	function detectLanguages(query: string): string[] {
		const languages: string[] = [];

		for (const { pattern, language } of LANGUAGE_PATTERNS) {
			if (pattern.test(query)) {
				languages.push(language);
			}
		}

		return [...new Set(languages)];
	}

	return {
		rewrite(query: string): RewrittenQuery {
			const terms = extractTerms(query);
			const expansions = expandTerms(terms);
			const filePatterns = extractFilePatterns(query);
			const languages = detectLanguages(query);

			// Build expanded query: original terms kept as-is, synonyms added as OR alternatives
			// Format: "(term1 OR syn1 OR syn2) term2" — FTS5 ANDs the groups, ORs within them
			const expandedParts: string[] = [];
			for (const term of terms) {
				const synonyms = enableSynonyms
					? (CODE_SYNONYMS[term] ?? []).slice(0, maxExpansionsPerTerm)
					: [];
				if (synonyms.length > 0) {
					expandedParts.push(`(${[term, ...synonyms].join(" OR ")})`);
				} else {
					expandedParts.push(term);
				}
			}
			const expanded = expandedParts.length > 0
				? expandedParts.join(" ")
				: query;

			return {
				original: query,
				expanded,
				filePatterns,
				languages,
				terms,
				expansions,
			};
		},
	};
}

// ============================================================================
// HyDE Rewriter (Hypothetical Document Embeddings)
// ============================================================================

export interface HyDERewriter {
	/** Generate hypothetical answer for query */
	generateHypothetical(query: string): Promise<string>;
}

/**
 * Creates a HyDE rewriter that generates hypothetical code answers
 * This is a placeholder - actual implementation would use an LLM
 */
export function createHyDERewriter(): HyDERewriter {
	return {
		async generateHypothetical(query: string): Promise<string> {
			// Placeholder: In production, this would call an LLM
			// to generate a hypothetical code snippet that answers the query
			//
			// Example:
			// Query: "how to create a user"
			// Hypothetical: "function createUser(name: string, email: string): User { ... }"

			// For now, just return the query with code-like framing
			return `// Code that ${query.toLowerCase()}\nfunction ${query.replace(/\s+/g, "_").toLowerCase()}() {\n  // implementation\n}`;
		},
	};
}
