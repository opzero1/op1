import type {
	GroundingBundle,
	RepromptDecision,
	RetryTrigger,
} from "../types.js";
import type { OracleDecision } from "./oracle-policy.js";

export interface ConfidenceInput {
	trigger: RetryTrigger;
	bundle?: GroundingBundle;
	oracleDecision: OracleDecision;
}

export interface ConfidenceScores {
	directRetry: number;
	oracleRetry: number;
	failClosed: number;
	reasons: string[];
}

export function scoreRetryConfidence(input: ConfidenceInput): ConfidenceScores {
	const reasons: string[] = [];
	const evidenceCount = input.bundle?.evidenceSlices.length ?? 0;
	const tokenBudget = input.bundle?.tokenBudget ?? 1;
	const includedTokens = input.bundle?.includedTokens ?? 0;
	const coverage = Math.min(1, evidenceCount / 4);
	const utilization = Math.min(1, includedTokens / tokenBudget);

	let directRetry = coverage * 0.6 + utilization * 0.2;
	let oracleRetry = coverage * 0.35 + (input.oracleDecision.allowed ? 0.35 : 0);
	let failClosed = 0.1;

	if (input.trigger.failureClass === "patch-safety") {
		failClosed = 0.95;
		directRetry = 0.05;
		oracleRetry = 0;
		reasons.push("patch-safety-failure");
	}

	if (evidenceCount === 0) {
		directRetry = 0.05;
		oracleRetry = input.oracleDecision.allowed ? 0.2 : 0;
		failClosed = Math.max(failClosed, 0.5);
		reasons.push("empty-evidence");
	}

	if (evidenceCount > 0) {
		directRetry += 0.2;
		reasons.push("grounded-evidence-present");
	}

	if (input.trigger.failureClass === "grounding") {
		directRetry += 0.15;
		oracleRetry += 0.15;
		reasons.push("grounding-retry-friendly");
	}

	if (input.oracleDecision.allowed) {
		reasons.push("oracle-available");
	} else {
		reasons.push(input.oracleDecision.reason);
	}

	return {
		directRetry: Math.min(1, directRetry),
		oracleRetry: Math.min(1, oracleRetry),
		failClosed: Math.min(1, failClosed),
		reasons,
	};
}

export function decideRepromptAction(input: ConfidenceInput): RepromptDecision {
	const scores = scoreRetryConfidence(input);

	if (scores.failClosed >= 0.8) {
		return {
			action: "fail-closed",
			reason: scores.reasons.join(", "),
			trigger: input.trigger,
			bundle: input.bundle,
			oracleRequired: false,
		};
	}

	if (
		input.trigger.type === "manual-helper-request" &&
		(input.bundle?.evidenceSlices.length ?? 0) > 0
	) {
		return {
			action: "retry-helper",
			reason: scores.reasons.join(", "),
			trigger: input.trigger,
			bundle: input.bundle,
			oracleRequired: false,
		};
	}

	if (scores.directRetry >= 0.4) {
		return {
			action: "retry-helper",
			reason: scores.reasons.join(", "),
			trigger: input.trigger,
			bundle: input.bundle,
			oracleRequired: false,
		};
	}

	if (input.oracleDecision.allowed && scores.oracleRetry >= 0.45) {
		return {
			action: "retry-helper-with-oracle",
			reason: scores.reasons.join(", "),
			trigger: input.trigger,
			bundle: input.bundle,
			oracleRequired: true,
		};
	}

	return {
		action: "suppress",
		reason: scores.reasons.join(", "),
		suppressionReason: input.oracleDecision.reason,
		trigger: input.trigger,
		bundle: input.bundle,
		oracleRequired: false,
	};
}
