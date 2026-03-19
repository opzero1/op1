import type { EvidenceSlice } from "../types.js";

export interface CompressionBudget {
	maxTokens: number;
	maxBytes: number;
	maxSlices: number;
}

export interface PackEvidenceInput {
	taskSummary: string;
	failureSummary: string;
	slices: EvidenceSlice[];
	budget: CompressionBudget;
	recentPaths?: string[];
	failurePaths?: string[];
}

export interface PackedEvidenceResult {
	evidenceSlices: EvidenceSlice[];
	includedTokens: number;
	omittedReasons: string[];
}

function scoreSlice(slice: EvidenceSlice, input: PackEvidenceInput): number {
	let score = 0;
	const task = input.taskSummary.toLowerCase();
	const failure = input.failureSummary.toLowerCase();

	if (slice.path && task.includes(slice.path.toLowerCase())) score += 6;
	if (slice.path && failure.includes(slice.path.toLowerCase())) score += 6;
	if (slice.symbol && task.includes(slice.symbol.toLowerCase())) score += 5;
	if (slice.symbol && failure.includes(slice.symbol.toLowerCase())) score += 5;
	if (input.failurePaths?.includes(slice.path ?? "")) score += 5;
	if (input.recentPaths?.includes(slice.path ?? "")) score += 3;
	if (slice.kind === "diagnostic") score += 4;
	if (slice.kind === "diff") score += 3;
	if (slice.kind === "grep-hit") score += 2;
	if (slice.redacted) score -= 1;

	return score;
}

export function packEvidenceSlices(
	input: PackEvidenceInput,
): PackedEvidenceResult {
	const deduped = new Map<string, EvidenceSlice>();
	for (const slice of input.slices) {
		const key = `${slice.path ?? ""}:${slice.startLine ?? 0}:${slice.endLine ?? 0}:${slice.excerpt}`;
		if (!deduped.has(key)) {
			deduped.set(key, slice);
		}
	}

	const ranked = [...deduped.values()].sort((left, right) => {
		const leftScore = scoreSlice(left, input);
		const rightScore = scoreSlice(right, input);
		if (rightScore !== leftScore) return rightScore - leftScore;
		if (left.tokenCount !== right.tokenCount)
			return left.tokenCount - right.tokenCount;
		return (left.path ?? "").localeCompare(right.path ?? "");
	});

	const evidenceSlices: EvidenceSlice[] = [];
	const omittedReasons: string[] = [];
	let includedTokens = 0;
	let includedBytes = 0;

	for (const slice of ranked) {
		if (evidenceSlices.length >= input.budget.maxSlices) {
			omittedReasons.push("slice-count-budget");
			break;
		}

		const nextTokens = includedTokens + slice.tokenCount;
		const nextBytes = includedBytes + slice.excerpt.length;
		if (
			nextTokens > input.budget.maxTokens ||
			nextBytes > input.budget.maxBytes
		) {
			omittedReasons.push(`budget:${slice.path ?? slice.id}`);
			continue;
		}

		evidenceSlices.push(slice);
		includedTokens = nextTokens;
		includedBytes = nextBytes;
	}

	return {
		evidenceSlices,
		includedTokens,
		omittedReasons: [...new Set(omittedReasons)],
	};
}
