import type { RetryFailureClass, RetryTrigger } from "../types.js";

export type RetryClass =
	| "search-broadening"
	| "focused-grounding"
	| "patch-recovery"
	| "patch-safety"
	| "stale-context"
	| "manual";

export interface TriggerClassification {
	retryClass: RetryClass;
	failureClass: RetryFailureClass;
	includeRepoSnapshot: boolean;
	includeCodeMap: boolean;
	includeDiagnostics: boolean;
	includeRecentEdits: boolean;
	preferFailurePaths: boolean;
	maxGrepMatches: number;
}

function classifyType(type: string): RetryClass {
	if (type === "empty-search" || type === "suspicious-search") {
		return "search-broadening";
	}
	if (type === "malformed-edit-output" || type === "edit-mismatch") {
		return "patch-recovery";
	}
	if (type === "patch-validation-failure") {
		return "patch-safety";
	}
	if (type === "stale-bundle") {
		return "stale-context";
	}
	if (type === "manual-helper-request") {
		return "manual";
	}
	return "focused-grounding";
}

export function classifyRetryTrigger(
	trigger: RetryTrigger,
): TriggerClassification {
	const retryClass = classifyType(trigger.type);

	if (retryClass === "search-broadening") {
		return {
			retryClass,
			failureClass: trigger.failureClass,
			includeRepoSnapshot: true,
			includeCodeMap: true,
			includeDiagnostics: false,
			includeRecentEdits: true,
			preferFailurePaths: true,
			maxGrepMatches: 4,
		};
	}

	if (retryClass === "patch-recovery") {
		return {
			retryClass,
			failureClass: trigger.failureClass,
			includeRepoSnapshot: false,
			includeCodeMap: false,
			includeDiagnostics: true,
			includeRecentEdits: true,
			preferFailurePaths: true,
			maxGrepMatches: 2,
		};
	}

	if (retryClass === "patch-safety") {
		return {
			retryClass,
			failureClass: trigger.failureClass,
			includeRepoSnapshot: false,
			includeCodeMap: false,
			includeDiagnostics: true,
			includeRecentEdits: true,
			preferFailurePaths: true,
			maxGrepMatches: 1,
		};
	}

	if (retryClass === "stale-context") {
		return {
			retryClass,
			failureClass: trigger.failureClass,
			includeRepoSnapshot: true,
			includeCodeMap: true,
			includeDiagnostics: true,
			includeRecentEdits: true,
			preferFailurePaths: true,
			maxGrepMatches: 3,
		};
	}

	if (retryClass === "manual") {
		return {
			retryClass,
			failureClass: trigger.failureClass,
			includeRepoSnapshot: true,
			includeCodeMap: true,
			includeDiagnostics: true,
			includeRecentEdits: true,
			preferFailurePaths: true,
			maxGrepMatches: 4,
		};
	}

	return {
		retryClass,
		failureClass: trigger.failureClass,
		includeRepoSnapshot: true,
		includeCodeMap: true,
		includeDiagnostics: true,
		includeRecentEdits: true,
		preferFailurePaths: true,
		maxGrepMatches: 3,
	};
}
