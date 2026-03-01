import type { PatternSeverity } from "./state.js";

export interface ToolExtractionInput {
	tool: string;
	output: string;
}

export interface ExtractedPatternCandidate {
	pattern: string;
	severity: PatternSeverity;
	source_tool: string;
	file_path?: string;
	symbol?: string;
	confidence: number;
	tags: string[];
}

const MAX_PATTERN_LENGTH = 300;

function isWindowsDriveAbsolutePath(pathValue: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(pathValue);
}

function isWindowsUncPath(pathValue: string): boolean {
	return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(pathValue);
}

function normalizePathSegments(pathValue: string): string {
	const absolute = pathValue.startsWith("/");
	const segments = pathValue.split("/");
	const normalized: string[] = [];

	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (normalized.length > 0 && normalized[normalized.length - 1] !== "..") {
				normalized.pop();
				continue;
			}

			if (!absolute) {
				normalized.push("..");
			}
			continue;
		}

		normalized.push(segment);
	}

	if (absolute) {
		return `/${normalized.join("/")}`;
	}

	return normalized.join("/");
}

function normalizeExtractedFilePath(
	rawPath: string | undefined,
): string | undefined {
	if (!rawPath) return undefined;
	const trimmed = rawPath.trim();
	if (!trimmed || trimmed.includes("\0")) return undefined;

	if (isWindowsUncPath(trimmed)) {
		const slashNormalized = trimmed.replace(/\\/g, "/");
		const withoutPrefix = slashNormalized.replace(/^\/\/+/, "");
		const [host, share, ...rest] = withoutPrefix.split("/").filter(Boolean);
		if (!host || !share) return undefined;
		const tail = normalizePathSegments(`/${rest.join("/")}`).replace(/^\//, "");
		return tail.length > 0
			? `//${host.toLowerCase()}/${share.toLowerCase()}/${tail}`
			: `//${host.toLowerCase()}/${share.toLowerCase()}`;
	}

	if (isWindowsDriveAbsolutePath(trimmed)) {
		const drive = trimmed[0]?.toUpperCase();
		if (!drive) return undefined;
		const slashNormalized = trimmed.slice(2).replace(/\\/g, "/");
		const normalized = normalizePathSegments(
			`/${slashNormalized.replace(/^\/+/, "")}`,
		);
		return `${drive}:${normalized}`;
	}

	if (trimmed.startsWith("/")) {
		return normalizePathSegments(trimmed.replace(/\\/g, "/"));
	}

	const relative = trimmed.replace(/\\/g, "/");
	const normalized = normalizePathSegments(relative);
	return normalized.length > 0 ? normalized : undefined;
}

function parseGrepPathHeader(line: string): string | undefined {
	const trimmed = line.trim();
	if (!trimmed.endsWith(":")) return undefined;

	const candidatePath = trimmed.slice(0, -1).trim();
	if (!candidatePath) return undefined;
	if (/^Line\s+\d+$/i.test(candidatePath)) return undefined;

	if (
		candidatePath.startsWith("/") ||
		candidatePath.includes("/") ||
		candidatePath.includes("\\") ||
		isWindowsDriveAbsolutePath(candidatePath) ||
		isWindowsUncPath(candidatePath)
	) {
		return normalizeExtractedFilePath(candidatePath);
	}

	return undefined;
}

function clampConfidence(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function normalizePattern(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, MAX_PATTERN_LENGTH);
}

function tryParseJson(raw: string): unknown | null {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function extractGrepCandidates(output: string): ExtractedPatternCandidate[] {
	const candidates: ExtractedPatternCandidate[] = [];
	const lines = output.split("\n");
	let currentPath: string | undefined;

	for (const line of lines) {
		if (!line.trim()) continue;

		const pathHeader = parseGrepPathHeader(line);
		if (pathHeader) {
			currentPath = pathHeader;
			continue;
		}

		const lineMatch = line.match(/\bLine\s+\d+:\s*(.+)$/i);
		if (!lineMatch) {
			currentPath = undefined;
			continue;
		}
		if (!currentPath) continue;

		const pattern = normalizePattern(lineMatch[1] || "");
		if (!pattern) continue;

		candidates.push({
			pattern,
			severity: "high",
			source_tool: "grep",
			file_path: currentPath,
			confidence: 0.78,
			tags: ["content-match", "line-extract"],
		});
	}

	return candidates;
}

function extractGlobCandidates(output: string): ExtractedPatternCandidate[] {
	const candidates: ExtractedPatternCandidate[] = [];
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("(") && line.endsWith(")")) continue;
		if (!line.includes("/") && !line.includes("\\")) continue;

		const filePath = normalizeExtractedFilePath(line);
		if (!filePath) continue;

		candidates.push({
			pattern: normalizePattern(filePath),
			severity: "medium",
			source_tool: "glob",
			file_path: filePath,
			confidence: 0.5,
			tags: ["path-discovery"],
		});
	}

	return candidates;
}

function extractAstGrepCandidates(output: string): ExtractedPatternCandidate[] {
	const candidates: ExtractedPatternCandidate[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^(.+):(\d+)(?::\d+)?:\s*(.+)$/);
		if (!match) continue;

		const filePath = normalizeExtractedFilePath(match[1]?.trim());
		if (!filePath) continue;
		const snippet = normalizePattern(match[3] || "");
		if (!snippet) continue;

		candidates.push({
			pattern: snippet,
			severity: "high",
			source_tool: "ast_grep",
			file_path: filePath,
			confidence: 0.9,
			tags: ["ast-match"],
		});
	}

	return candidates;
}

function collectJsonSymbolCandidates(
	value: unknown,
	collector: ExtractedPatternCandidate[],
): void {
	if (!value) return;

	if (Array.isArray(value)) {
		for (const item of value) collectJsonSymbolCandidates(item, collector);
		return;
	}

	if (typeof value !== "object") return;

	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : undefined;
	const filePath =
		typeof record.filePath === "string"
			? normalizeExtractedFilePath(record.filePath)
			: typeof record.path === "string"
				? normalizeExtractedFilePath(record.path)
				: undefined;

	if (name) {
		collector.push({
			pattern: normalizePattern(name),
			severity: "medium",
			source_tool: "lsp",
			file_path: filePath,
			symbol: name,
			confidence: 0.62,
			tags: ["symbol"],
		});
	}

	for (const nested of Object.values(record)) {
		collectJsonSymbolCandidates(nested, collector);
	}
}

function extractLspCandidates(output: string): ExtractedPatternCandidate[] {
	const parsed = tryParseJson(output.trim());
	if (!parsed) return [];
	const collected: ExtractedPatternCandidate[] = [];
	collectJsonSymbolCandidates(parsed, collected);
	return collected;
}

function dedupeCandidates(
	input: ExtractedPatternCandidate[],
): ExtractedPatternCandidate[] {
	const byIdentity = new Map<string, ExtractedPatternCandidate>();

	for (const candidate of input) {
		const identity = JSON.stringify({
			pattern: candidate.pattern,
			file_path: candidate.file_path ?? "",
			source_tool: candidate.source_tool,
			symbol: candidate.symbol ?? "",
		});

		const existing = byIdentity.get(identity);
		if (!existing) {
			byIdentity.set(identity, candidate);
			continue;
		}

		byIdentity.set(identity, {
			...existing,
			severity:
				existing.severity === "critical" || candidate.severity === "critical"
					? "critical"
					: existing.severity === "high" || candidate.severity === "high"
						? "high"
						: "medium",
			confidence: clampConfidence(
				Math.max(existing.confidence, candidate.confidence),
			),
			tags: [...new Set([...existing.tags, ...candidate.tags])],
		});
	}

	return [...byIdentity.values()];
}

export function extractPatternCandidates(
	entries: ToolExtractionInput[],
): ExtractedPatternCandidate[] {
	const extracted: ExtractedPatternCandidate[] = [];

	for (const entry of entries) {
		const tool = entry.tool.trim().toLowerCase();
		if (!tool || !entry.output.trim()) continue;

		if (tool === "grep") {
			extracted.push(...extractGrepCandidates(entry.output));
			continue;
		}

		if (tool === "glob") {
			extracted.push(...extractGlobCandidates(entry.output));
			continue;
		}

		if (tool === "ast_grep_search" || tool === "ast_grep_replace") {
			extracted.push(...extractAstGrepCandidates(entry.output));
			continue;
		}

		if (
			tool === "lsp_symbols" ||
			tool === "lsp_find_references" ||
			tool === "lsp_goto_definition"
		) {
			extracted.push(...extractLspCandidates(entry.output));
		}
	}

	return dedupeCandidates(
		extracted.filter((candidate) => candidate.pattern.length > 0),
	);
}
