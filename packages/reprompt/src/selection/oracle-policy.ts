import type { OracleMode } from "../config.js";
import type { RetryTrigger } from "../types.js";

export interface OraclePolicyInput {
	mode: OracleMode;
	maxBundleTokens: number;
	maxCallsPerSession: number;
	sessionOracleCalls: number;
	oracleAvailable: boolean;
	confidence: number;
	includedTokens: number;
	trigger: RetryTrigger;
}

export interface OracleDecision {
	allowed: boolean;
	mode: OracleMode;
	reason: string;
	maxBundleTokens: number;
	fallbackAction: "retry-helper" | "suppress";
}

export function resolveOraclePolicy(input: OraclePolicyInput): OracleDecision {
	if (input.mode === "disabled") {
		return {
			allowed: false,
			mode: input.mode,
			reason: "oracle-disabled",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "retry-helper",
		};
	}

	if (!input.oracleAvailable) {
		return {
			allowed: false,
			mode: input.mode,
			reason: "oracle-unavailable",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "retry-helper",
		};
	}

	if (input.sessionOracleCalls >= input.maxCallsPerSession) {
		return {
			allowed: false,
			mode: input.mode,
			reason: "oracle-call-cap",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "retry-helper",
		};
	}

	if (input.includedTokens > input.maxBundleTokens) {
		return {
			allowed: false,
			mode: input.mode,
			reason: "oracle-bundle-cap",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "retry-helper",
		};
	}

	if (input.trigger.failureClass === "patch-safety") {
		return {
			allowed: false,
			mode: input.mode,
			reason: "unsafe-patch-failure",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "suppress",
		};
	}

	if (input.mode === "suggest" && input.confidence >= 0.45) {
		return {
			allowed: false,
			mode: input.mode,
			reason: "local-confidence-sufficient",
			maxBundleTokens: input.maxBundleTokens,
			fallbackAction: "retry-helper",
		};
	}

	return {
		allowed: true,
		mode: input.mode,
		reason: "oracle-allowed",
		maxBundleTokens: input.maxBundleTokens,
		fallbackAction: "retry-helper",
	};
}
