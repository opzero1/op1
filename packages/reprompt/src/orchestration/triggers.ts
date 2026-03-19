import type {
	RetryFailureClass,
	RetryTrigger,
	RetryTriggerSource,
} from "../types.js";

const FAILURE_CLASS_BY_TYPE: Record<string, RetryFailureClass> = {
	"empty-search": "grounding",
	"suspicious-search": "selection",
	"edit-mismatch": "patch-recovery",
	"malformed-edit-output": "patch-recovery",
	"patch-validation-failure": "patch-safety",
	"stale-bundle": "serialization",
	"narrow-context-miss": "grounding",
	"manual-helper-request": "runtime",
};

export function failureClassForTrigger(type: string): RetryFailureClass {
	return FAILURE_CLASS_BY_TYPE[type] ?? "runtime";
}

export function createRetryTrigger(input: {
	source: RetryTriggerSource;
	type: string;
	failureMessage: string;
	attempt: number;
	maxAttempts: number;
	dedupeKey: string;
	path?: string;
	symbol?: string;
}): RetryTrigger {
	return {
		source: input.source,
		type: input.type,
		failureClass: failureClassForTrigger(input.type),
		failureMessage: input.failureMessage,
		attempt: input.attempt,
		maxAttempts: input.maxAttempts,
		dedupeKey: input.dedupeKey,
		path: input.path,
		symbol: input.symbol,
	};
}
