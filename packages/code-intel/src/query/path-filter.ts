/**
 * Path Filtering Utilities
 *
 * Shared path-matching logic used by both keyword search (SQL LIKE)
 * and vector search (SQL LIKE + pure-JS fallback).
 */

// ============================================================================
// SQL LIKE Conversion
// ============================================================================

/**
 * Convert a simple glob pattern to a SQL LIKE pattern.
 * - `**` → `%` (any path segments)
 * - `*`  → `%` (any characters)
 * - `?`  → `_` (single character)
 * Existing `%` and `_` are escaped with backslash.
 *
 * IMPORTANT: All SQL LIKE clauses using this output MUST include `ESCAPE '\'`
 * because SQLite does not recognise backslash as an escape character by default.
 */
export function globToLike(pattern: string): string {
	// First escape existing LIKE special chars with backslash
	let result = pattern.replace(/%/g, "\\%").replace(/_/g, "\\_");
	// Replace ** before * to avoid double conversion
	result = result.replace(/\*\*/g, "%");
	result = result.replace(/\*/g, "%");
	result = result.replace(/\?/g, "_");
	return result;
}

/**
 * SQL fragment for a LIKE clause with proper escaping.
 * Always appends ESCAPE '\' so backslash-escaped `%` and `_` are treated literally.
 */
export const LIKE_ESCAPE_CLAUSE = `ESCAPE '\\'`;

// ============================================================================
// Pure-JS Glob Matching (for fallback search paths)
// ============================================================================

/**
 * Test whether a file path matches a glob pattern.
 * Works directly from glob syntax — does NOT go through the intermediate LIKE
 * representation, avoiding double-conversion bugs.
 *
 * Supported glob syntax:
 * - `**`  → any path segments (including separators)
 * - `*`   → any characters except `/`
 * - `?`   → single character except `/`
 * - All other characters are literal-matched (regex-special chars escaped).
 */
export function globMatchesPath(pattern: string, filePath: string): boolean {
	const regexStr = globToRegex(pattern);
	try {
		const regex = new RegExp(`^${regexStr}$`);
		return regex.test(filePath);
	} catch {
		// If pattern produces invalid regex, fall back to simple includes
		return filePath.includes(pattern);
	}
}

/**
 * Check if a file path passes all active path filters.
 * Returns `false` for null/undefined paths when filters are active
 * (conservative: exclude unknowns rather than leaking unfiltered results).
 */
export function matchesPathFilters(
	filePath: string | null | undefined,
	pathPrefix?: string,
	filePatterns?: string[],
): boolean {
	const hasFilters = !!(pathPrefix || (filePatterns && filePatterns.length > 0));
	if (!hasFilters) return true;

	// If we can't determine the path and filters are active, exclude the row
	if (!filePath) return false;

	if (pathPrefix && !filePath.startsWith(pathPrefix)) return false;

	if (filePatterns && filePatterns.length > 0) {
		const anyMatch = filePatterns.some((p) => globMatchesPath(p, filePath));
		if (!anyMatch) return false;
	}

	return true;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Convert a glob pattern directly to a regex string.
 * Escapes all regex-special characters first, then substitutes glob wildcards.
 */
function globToRegex(pattern: string): string {
	// Split on glob tokens, escape everything else
	let result = "";
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] === "*" && pattern[i + 1] === "*") {
			result += ".*"; // ** matches anything including /
			i += 2;
			// Skip trailing / after ** (e.g. "src/**/foo" → "src/.*foo")
			if (pattern[i] === "/") i++;
		} else if (pattern[i] === "*") {
			result += "[^/]*"; // * matches anything except /
			i++;
		} else if (pattern[i] === "?") {
			result += "[^/]"; // ? matches single char except /
			i++;
		} else {
			result += escapeRegexChar(pattern[i]);
			i++;
		}
	}
	return result;
}

/** Escape a single character if it's regex-special. */
function escapeRegexChar(char: string): string {
	if ("\\^$.|+()[]{}".includes(char)) {
		return `\\${char}`;
	}
	return char;
}
