import { join } from "node:path";
import type { RepoSnapshot } from "./repo-snapshot.js";
import { readTextFile, splitLines, truncateText } from "./shared.js";

export interface CodeIntelSummary {
	path: string;
	importanceScore: number;
	symbolSummary: string[];
}

export interface CodeIntelAdapter {
	getSummaries(input: {
		branch: string | null;
		paths: string[];
		limit: number;
	}): Promise<CodeIntelSummary[]>;
}

export interface CodeMapFileSummary {
	path: string;
	imports: string[];
	exports: string[];
	symbols: string[];
	importanceScore: number;
	provenance: "local" | "code-intel";
}

export interface CodeMapLite {
	branch: string | null;
	files: CodeMapFileSummary[];
	usedCodeIntel: boolean;
	generatedAt: string;
}

export interface BuildCodeMapOptions {
	maxFiles?: number;
	maxImports?: number;
	maxSymbols?: number;
	adapter?: CodeIntelAdapter;
}

const IMPORT_PATTERNS = [
	/^\s*import\s+.+?from\s+["']([^"']+)["']/,
	/^\s*import\s+["']([^"']+)["']/,
	/^\s*from\s+([^\s]+)\s+import\s+/,
	/^\s*require\(["']([^"']+)["']\)/,
];

const EXPORT_PATTERNS = [
	/^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
	/^\s*export\s+class\s+([A-Za-z0-9_$]+)/,
	/^\s*export\s+const\s+([A-Za-z0-9_$]+)/,
	/^\s*export\s+type\s+([A-Za-z0-9_$]+)/,
	/^\s*export\s+interface\s+([A-Za-z0-9_$]+)/,
	/^\s*export\s+enum\s+([A-Za-z0-9_$]+)/,
];

const SYMBOL_PATTERNS = [
	/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
	/^\s*class\s+([A-Za-z0-9_$]+)/,
	/^\s*const\s+([A-Za-z0-9_$]+)\s*=/,
	/^\s*let\s+([A-Za-z0-9_$]+)\s*=/,
	/^\s*var\s+([A-Za-z0-9_$]+)\s*=/,
	/^\s*def\s+([A-Za-z0-9_]+)/,
	/^\s*type\s+([A-Za-z0-9_$]+)/,
	/^\s*interface\s+([A-Za-z0-9_$]+)/,
	/^\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/,
];

function extractMatches(
	lines: string[],
	patterns: RegExp[],
	limit: number,
): string[] {
	const matches = new Set<string>();
	for (const line of lines) {
		for (const pattern of patterns) {
			const match = line.match(pattern);
			const value = match?.[1]?.trim();
			if (!value) continue;
			matches.add(truncateText(value, 80));
			if (matches.size >= limit) {
				return [...matches];
			}
		}
	}
	return [...matches];
}

async function summarizeFile(input: {
	workspaceRoot: string;
	path: string;
	maxImports: number;
	maxSymbols: number;
}): Promise<CodeMapFileSummary | null> {
	const content = await readTextFile(join(input.workspaceRoot, input.path));
	if (!content) return null;

	const lines = splitLines(content).slice(0, 400);
	const imports = extractMatches(lines, IMPORT_PATTERNS, input.maxImports);
	const exports = extractMatches(lines, EXPORT_PATTERNS, input.maxSymbols);
	const symbols = extractMatches(lines, SYMBOL_PATTERNS, input.maxSymbols);

	return {
		path: input.path,
		imports,
		exports,
		symbols,
		importanceScore: exports.length * 2 + imports.length + symbols.length,
		provenance: "local",
	};
}

export async function buildCodeMapLite(
	workspaceRoot: string,
	snapshot: RepoSnapshot,
	options: BuildCodeMapOptions = {},
): Promise<CodeMapLite> {
	const maxFiles = options.maxFiles ?? 12;
	const maxImports = options.maxImports ?? 8;
	const maxSymbols = options.maxSymbols ?? 8;

	const candidatePaths = [
		...snapshot.diff.map((entry) => entry.path),
		...snapshot.tree.flatMap((entry) => entry.samples),
		...snapshot.trackedFiles,
	];

	const uniquePaths = [...new Set(candidatePaths)].slice(0, maxFiles * 2);
	const localSummaries = (
		await Promise.all(
			uniquePaths.map((path) =>
				summarizeFile({
					workspaceRoot,
					path,
					maxImports,
					maxSymbols,
				}),
			),
		)
	).filter((summary): summary is CodeMapFileSummary => summary !== null);

	const byPath = new Map(
		localSummaries.map((summary) => [summary.path, summary]),
	);
	let usedCodeIntel = false;

	if (options.adapter) {
		const enriched = await options.adapter.getSummaries({
			branch: snapshot.branch,
			paths: uniquePaths,
			limit: maxFiles,
		});
		for (const entry of enriched) {
			usedCodeIntel = true;
			const existing = byPath.get(entry.path);
			const merged: CodeMapFileSummary = {
				path: entry.path,
				imports: existing?.imports ?? [],
				exports: existing?.exports ?? entry.symbolSummary.slice(0, maxSymbols),
				symbols: existing?.symbols.length
					? existing.symbols
					: entry.symbolSummary.slice(0, maxSymbols),
				importanceScore: Math.max(
					existing?.importanceScore ?? 0,
					entry.importanceScore,
				),
				provenance: "code-intel",
			};
			byPath.set(entry.path, merged);
		}
	}

	const files = [...byPath.values()]
		.sort((left, right) => {
			if (right.importanceScore !== left.importanceScore) {
				return right.importanceScore - left.importanceScore;
			}
			return left.path.localeCompare(right.path);
		})
		.slice(0, maxFiles);

	return {
		branch: snapshot.branch,
		files,
		usedCodeIntel,
		generatedAt: new Date().toISOString(),
	};
}
