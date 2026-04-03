import { classifyRetryTrigger } from "../selection/trigger-classifier.js";
import type { CodeMapLite } from "../serializer/codemap-lite.js";
import type { RepoSnapshot } from "../serializer/repo-snapshot.js";
import {
	estimateTokens,
	hashText,
	truncateText,
} from "../serializer/shared.js";
import type { SliceRequest } from "../serializer/slices.js";
import type {
	EvidenceSlice,
	RepromptTaskClass,
	RetryTrigger,
} from "../types.js";
import { extractPromptHints } from "./task-classifier.js";

function createSessionNoteSlice(input: {
	reason: string;
	excerpt: string;
	provenance: string;
}): EvidenceSlice {
	return {
		id: hashText(`${input.provenance}:${input.excerpt}`),
		kind: "session-note",
		reason: input.reason,
		excerpt: input.excerpt,
		tokenCount: estimateTokens(input.excerpt),
		provenance: input.provenance,
		redacted: false,
	};
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maybeGrepPattern(value: string): string | null {
	const escaped = escapeRegex(value.trim());
	if (!escaped) return null;
	if (/^[A-Za-z0-9_]+$/.test(value)) {
		return `\\b${escaped}\\b`;
	}
	return escaped;
}

function existingWorkspacePath(
	candidate: string,
	availablePaths: Set<string>,
): string | null {
	if (availablePaths.has(candidate)) return candidate;
	for (const path of availablePaths) {
		if (path.endsWith(candidate)) {
			return path;
		}
	}
	return null;
}

function scoreHintPath(input: {
	path: string;
	searchTerms: string[];
	symbols: string[];
}): number {
	const lower = input.path.toLowerCase();
	const segments = lower.split("/");
	const base = segments[segments.length - 1] ?? lower;
	let score = 0;

	for (const term of input.searchTerms) {
		if (!lower.includes(term)) continue;
		score += Math.min(8, Math.max(3, term.length));
		if (
			segments.includes(term) ||
			base === term ||
			base.startsWith(`${term}.`)
		) {
			score += 6;
		}
	}

	for (const symbol of input.symbols) {
		const needle = symbol.toLowerCase();
		if (!lower.includes(needle)) continue;
		score += 4;
		if (base.includes(needle)) {
			score += 2;
		}
	}

	return score;
}

function matchHintPaths(input: {
	availablePaths: Set<string>;
	searchTerms: string[];
	symbols: string[];
	limit?: number;
}): string[] {
	const ranked = [...input.availablePaths]
		.map((path) => ({
			path,
			score: scoreHintPath({
				path,
				searchTerms: input.searchTerms,
				symbols: input.symbols,
			}),
		}))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			const leftDepth = left.path.split("/").length;
			const rightDepth = right.path.split("/").length;
			if (leftDepth !== rightDepth) {
				return leftDepth - rightDepth;
			}
			return left.path.localeCompare(right.path);
		})
		.slice(0, input.limit ?? 6);

	return ranked.map((entry) => entry.path);
}

export interface CompilerContextPlan {
	requests: SliceRequest[];
	contextSlices: EvidenceSlice[];
	omissionReasons: string[];
	candidatePaths: string[];
	classification: ReturnType<typeof classifyRetryTrigger>;
	promptHints: ReturnType<typeof extractPromptHints>;
}

export function buildCompilerContextPlan(input: {
	trigger: RetryTrigger;
	taskClass: RepromptTaskClass;
	promptText: string;
	failureSummary: string;
	evidencePaths?: string[];
	failurePaths?: string[];
	snapshot: RepoSnapshot;
	codeMap: CodeMapLite;
}): CompilerContextPlan {
	const classification = classifyRetryTrigger(input.trigger);
	const promptHints = extractPromptHints({ promptText: input.promptText });
	const availablePaths = new Set<string>([
		...input.snapshot.trackedFiles,
		...input.snapshot.diff.map((entry) => entry.path),
		...input.codeMap.files.map((file) => file.path),
	]);
	const referencedPromptPaths: string[] = [];
	const missingPromptPaths: string[] = [];
	for (const path of promptHints.paths) {
		const resolvedPath = existingWorkspacePath(path, availablePaths);
		if (resolvedPath) {
			referencedPromptPaths.push(resolvedPath);
		} else {
			missingPromptPaths.push(path);
		}
	}
	const requestedEvidencePaths = [
		...(input.evidencePaths ?? []),
		...referencedPromptPaths,
	];
	const matchedHintPaths = matchHintPaths({
		availablePaths,
		searchTerms: promptHints.searchTerms,
		symbols: promptHints.symbols,
	});
	const recentPaths = classification.includeRecentEdits
		? input.snapshot.diff.slice(0, 4).map((entry) => entry.path)
		: [];
	const codePaths = classification.includeCodeMap
		? input.codeMap.files.slice(0, 4).map((file) => file.path)
		: [];
	const candidatePaths = [
		...new Set([
			...(input.failurePaths ?? []),
			...requestedEvidencePaths,
			...matchedHintPaths,
			...recentPaths,
			...codePaths,
		]),
	].filter((path) => availablePaths.has(path));

	const omissionReasons: string[] = [];
	const requests: SliceRequest[] = [];

	for (const path of requestedEvidencePaths) {
		if (!availablePaths.has(path)) {
			omissionReasons.push(`missing-evidence-path:${path}`);
			continue;
		}
		requests.push({
			kind: "file",
			path,
			reason: "explicit evidence path",
			contextBefore: 10,
			contextAfter: 10,
		});
	}

	for (const path of matchedHintPaths) {
		if (requestedEvidencePaths.includes(path)) continue;
		requests.push({
			kind: "file",
			path,
			reason: "path matched prompt hint",
			contextBefore: 10,
			contextAfter: 10,
		});
	}

	for (const path of input.failurePaths ?? []) {
		if (!availablePaths.has(path)) {
			omissionReasons.push(`missing-failure-path:${path}`);
			continue;
		}
		requests.push({
			kind: "failure",
			path,
			reason: "failure path",
			message: input.failureSummary,
			contextBefore: 12,
			contextAfter: 12,
		});
	}

	for (const path of recentPaths) {
		if ((input.failurePaths ?? []).includes(path)) continue;
		requests.push({
			kind: "recent-edit",
			path,
			reason: "recent workspace edit",
			message: "recent diff context",
			contextBefore: 8,
			contextAfter: 8,
		});
	}

	for (const symbol of promptHints.symbols.slice(0, 2)) {
		for (const path of candidatePaths.slice(0, 3)) {
			requests.push({
				kind: "symbol",
				path,
				symbol,
				reason: "prompt symbol hint",
				contextBefore: 8,
				contextAfter: 8,
			});
		}
	}

	for (const searchTerm of promptHints.searchTerms.slice(0, 2)) {
		const pattern = maybeGrepPattern(searchTerm);
		if (!pattern) continue;
		for (const path of candidatePaths.slice(0, classification.maxGrepMatches)) {
			requests.push({
				kind: "grep",
				path,
				pattern,
				reason: `prompt search term: ${searchTerm}`,
				maxMatches: 1,
				contextBefore: 6,
				contextAfter: 6,
			});
		}
	}

	if (classification.includeDiagnostics) {
		omissionReasons.push(
			"diagnostics-unavailable:no-line-aware-diagnostics-adapter",
		);
	}
	for (const path of missingPromptPaths) {
		omissionReasons.push(`missing-prompt-path:${path}`);
	}

	if (candidatePaths.length === 0) {
		omissionReasons.push("no-candidate-paths");
	}
	if (promptHints.symbols.length === 0) {
		omissionReasons.push("no-symbol-hints");
	}
	if (promptHints.searchTerms.length === 0) {
		omissionReasons.push("no-search-terms");
	}

	const contextSlices: EvidenceSlice[] = [];
	if (classification.includeRepoSnapshot) {
		const snapshotSummary = [
			`Task class: ${input.taskClass}`,
			`Branch: ${input.snapshot.branch ?? "detached-or-none"}`,
			`Changed files: ${
				input.snapshot.diff.length > 0
					? input.snapshot.diff
							.slice(0, 6)
							.map((entry) => `${entry.path}(${entry.status})`)
							.join(", ")
					: "none"
			}`,
			`Top workspace areas: ${input.snapshot.tree
				.slice(0, 4)
				.map((entry) => `${entry.path}:${entry.fileCount}`)
				.join(", ")}`,
		].join("\n");
		contextSlices.push(
			createSessionNoteSlice({
				reason: "repo snapshot summary",
				excerpt: truncateText(snapshotSummary, 500),
				provenance: "repo-snapshot",
			}),
		);
	}

	if (classification.includeCodeMap && input.codeMap.files.length > 0) {
		const codeSummary = input.codeMap.files
			.slice(0, 5)
			.map((file) => {
				const symbols = file.symbols.slice(0, 4).join(", ") || "none";
				return `${file.path} :: symbols=${symbols}`;
			})
			.join("\n");
		contextSlices.push(
			createSessionNoteSlice({
				reason: "code map summary",
				excerpt: truncateText(codeSummary, 500),
				provenance: "code-map",
			}),
		);
	}

	return {
		requests,
		contextSlices,
		omissionReasons: [...new Set(omissionReasons)],
		candidatePaths,
		classification,
		promptHints,
	};
}
