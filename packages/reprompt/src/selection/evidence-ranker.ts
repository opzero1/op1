import type { RepromptConfig } from "../config.js";
import { redactText } from "../redaction.js";
import {
	type CompressionBudget,
	type PackedEvidenceResult,
	packEvidenceSlices,
} from "../serializer/compress.js";
import type { EvidenceSlice } from "../types.js";

export interface RankEvidenceInput {
	taskSummary: string;
	failureSummary: string;
	slices: EvidenceSlice[];
	budget: CompressionBudget;
	privacy: RepromptConfig["privacy"];
	recentPaths?: string[];
	failurePaths?: string[];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
	const escaped = escapeRegex(pattern)
		.replace(/\\\*\\\*/g, ".*")
		.replace(/\\\*/g, "[^/]*");
	return new RegExp(`^${escaped}$`, "i");
}

function matchesPrivacyBlock(
	slice: EvidenceSlice,
	privacy: RepromptConfig["privacy"],
): boolean {
	const haystack = `${slice.path ?? ""}\n${slice.reason}\n${slice.excerpt}`;
	if (
		privacy.blockedGlobs.some((pattern) =>
			slice.path ? globToRegex(pattern).test(slice.path) : false,
		)
	) {
		return true;
	}

	for (const pattern of privacy.blockedPatterns) {
		try {
			if (new RegExp(pattern, "i").test(haystack)) {
				return true;
			}
		} catch {}
	}

	return false;
}

function applyRedactions(
	slice: EvidenceSlice,
	privacy: RepromptConfig["privacy"],
): EvidenceSlice {
	let excerpt = redactText(slice.excerpt);
	let reason = redactText(slice.reason);

	for (const pattern of privacy.redactPatterns) {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern, "gi");
		} catch {
			continue;
		}
		excerpt = excerpt.replace(regex, "[REDACTED]");
		reason = reason.replace(regex, "[REDACTED]");
	}

	return {
		...slice,
		excerpt,
		reason,
		tokenCount: Math.max(1, Math.ceil(excerpt.length / 4)),
		redacted:
			slice.redacted || excerpt !== slice.excerpt || reason !== slice.reason,
	};
}

export interface RankedEvidenceResult extends PackedEvidenceResult {
	filteredSlices: number;
}

export function rankEvidenceSlices(
	input: RankEvidenceInput,
): RankedEvidenceResult {
	const filtered: EvidenceSlice[] = [];
	const omittedReasons: string[] = [];

	for (const slice of input.slices) {
		if (matchesPrivacyBlock(slice, input.privacy)) {
			omittedReasons.push(`privacy-blocked:${slice.path ?? slice.id}`);
			continue;
		}
		filtered.push(applyRedactions(slice, input.privacy));
	}

	const packed = packEvidenceSlices({
		taskSummary: input.taskSummary,
		failureSummary: input.failureSummary,
		slices: filtered,
		budget: input.budget,
		recentPaths: input.recentPaths,
		failurePaths: input.failurePaths,
	});

	return {
		...packed,
		omittedReasons: [...new Set([...omittedReasons, ...packed.omittedReasons])],
		filteredSlices: input.slices.length - filtered.length,
	};
}
