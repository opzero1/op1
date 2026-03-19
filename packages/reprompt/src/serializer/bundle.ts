import { redactText } from "../redaction.js";
import type { EvidenceSlice, GroundingBundle } from "../types.js";
import { type CompressionBudget, packEvidenceSlices } from "./compress.js";
import { estimateTokens, hashText } from "./shared.js";

export interface BuildGroundingBundleInput {
	taskSummary: string;
	failureSummary: string;
	slices: EvidenceSlice[];
	budget: CompressionBudget;
	baseOmittedReasons?: string[];
	recentPaths?: string[];
	failurePaths?: string[];
	provenance?: string[];
}

function createFallbackSlice(input: {
	taskSummary: string;
	failureSummary: string;
}): EvidenceSlice {
	const excerpt = `Task: ${redactText(input.taskSummary)}\nFailure: ${redactText(input.failureSummary)}`;
	return {
		id: hashText(excerpt),
		kind: "session-note",
		reason: "fallback-summary",
		excerpt,
		tokenCount: estimateTokens(excerpt),
		provenance: "fallback-summary",
		redacted: excerpt.includes("[REDACTED"),
	};
}

export function buildGroundingBundle(
	input: BuildGroundingBundleInput,
): GroundingBundle {
	const taskSummary = redactText(input.taskSummary).trim();
	const failureSummary = redactText(input.failureSummary).trim();
	const packed = packEvidenceSlices({
		taskSummary,
		failureSummary,
		slices: input.slices,
		budget: input.budget,
		recentPaths: input.recentPaths,
		failurePaths: input.failurePaths,
	});

	const evidenceSlices =
		packed.evidenceSlices.length > 0
			? packed.evidenceSlices
			: [createFallbackSlice({ taskSummary, failureSummary })];
	const includedTokens = evidenceSlices.reduce(
		(total, slice) => total + slice.tokenCount,
		0,
	);
	const provenance = [
		...(input.provenance ?? []),
		...evidenceSlices.map((slice) => slice.provenance),
	];

	return {
		bundleId: hashText(
			JSON.stringify({
				taskSummary,
				failureSummary,
				evidenceSlices: evidenceSlices.map((slice) => slice.id),
			}),
		),
		createdAt: new Date().toISOString(),
		taskSummary,
		failureSummary,
		evidenceSlices,
		tokenBudget: input.budget.maxTokens,
		includedTokens,
		omittedReasons: [
			...new Set([
				...(input.baseOmittedReasons ?? []),
				...packed.omittedReasons,
				...(evidenceSlices.length === 1 &&
				evidenceSlices[0].reason === "fallback-summary"
					? ["no-eligible-local-evidence"]
					: []),
			]),
		],
		provenance: [...new Set(provenance)],
	};
}
