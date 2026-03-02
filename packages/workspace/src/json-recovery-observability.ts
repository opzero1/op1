export type JsonRecoveryMethod =
	| "trailing_comma_cleanup"
	| "object_boundary_extraction"
	| "array_boundary_extraction";

export interface JsonRecoveryObservabilitySnapshot {
	match_total: number;
	dedup_skip_total: number;
	parse_fail_total: number;
	per_method: Record<JsonRecoveryMethod, number>;
}

const DEDUP_WINDOW_MS = 30_000;

const perMethodInitial: Record<JsonRecoveryMethod, number> = {
	trailing_comma_cleanup: 0,
	object_boundary_extraction: 0,
	array_boundary_extraction: 0,
};

const counters: JsonRecoveryObservabilitySnapshot = {
	match_total: 0,
	dedup_skip_total: 0,
	parse_fail_total: 0,
	per_method: { ...perMethodInitial },
};

const dedupState = new Map<string, number>();

export function recordJsonRecoveryMatch(
	source: string,
	method: JsonRecoveryMethod,
	nowMs = Date.now(),
): { suppressed: boolean } {
	const key = `${source}:${method}`;
	const lastSeen = dedupState.get(key);

	if (typeof lastSeen === "number" && nowMs - lastSeen < DEDUP_WINDOW_MS) {
		counters.dedup_skip_total += 1;
		return { suppressed: true };
	}

	dedupState.set(key, nowMs);
	counters.match_total += 1;
	counters.per_method[method] += 1;
	return { suppressed: false };
}

export function recordJsonRecoveryFailure(): void {
	counters.parse_fail_total += 1;
}

export function getJsonRecoveryObservabilitySnapshot(): JsonRecoveryObservabilitySnapshot {
	return {
		match_total: counters.match_total,
		dedup_skip_total: counters.dedup_skip_total,
		parse_fail_total: counters.parse_fail_total,
		per_method: { ...counters.per_method },
	};
}

export function resetJsonRecoveryObservabilityState(): void {
	counters.match_total = 0;
	counters.dedup_skip_total = 0;
	counters.parse_fail_total = 0;
	counters.per_method = { ...perMethodInitial };
	dedupState.clear();
}
